/**
 * Procedural battle sound. Everything is synthesized with the Web Audio API from a few pre-generated noise buffers,
 * biquad filters, oscillators and short gain envelopes: no audio files, no dependencies.
 *
 * Graph:
 *   one-shot voices -> shotBus ─┐
 *   ambience (wind, feet, din,  │
 *   hooves, clatter) -> ambBus ─┴-> zoomFilter (lowpass, duller when zoomed out) -> camGain -> master
 *   stingers / UI ticks -------------------------------------------------------------------> master
 *   master (volume, mute) -> DynamicsCompressor -> destination
 *
 * One-shots are not played as they arrive. emit() folds each event into a per-kind, per-stereo-third accumulator
 * (O(1), no allocation); update() flushes the accumulators every ~50 ms, so 60 archers loosing in one step become one
 * layered volley whose density and loudness follow the count. Simultaneous voices and voices started per frame are
 * capped; the quietest candidates are dropped and a much louder newcomer may steal the quietest playing voice.
 */
import type { Camera } from './camera'
import type { Battle } from './sim/types'
import { unitDef } from './sim/units'

export type SoundKind =
  | 'meleeHit'      // a weapon lands; power 0..1 (light blade .. monster blow)
  | 'death'
  | 'chargeImpact'  // a charging body slams into the enemy; power: infantry ~.2, cavalry ~.7, chariot/monster 1
  | 'knockdown'     // a man is thrown to the ground
  | 'bowShot' | 'gunShot'
  | 'arrowLand'
  | 'rout' | 'rally'          // a regiment breaks / recovers
  | 'victory' | 'defeat'      // non-positional stingers
  | 'uiSelect' | 'uiOrder'    // non-positional, very quiet UI ticks

export interface AudioView {
  battle: Battle
  camera: Camera
  width: number
  height: number
  time: number
  paused: boolean
  speed: number
}

/** Diagnostics for tests and tuning. */
export interface BattleAudioStats {
  /** Whether an AudioContext exists (unlock() succeeded). */
  active: boolean
  /** One-shot voices currently sounding (<= MAX_VOICES). */
  voices: number
  /** One-shot voices started by the most recent update(). */
  startedLastFrame: number
  /** Clustered one-shots dropped by the caps since creation. */
  dropped: number
  /** Events folded into the accumulators and not yet flushed. */
  pending: number
  /** Master gain target: 0 when muted. */
  outputGain: number
  /** Latest ambience targets (0..1-ish), for tuning. */
  feet: number
  hooves: number
  din: number
}

export interface BattleAudio {
  update(view: AudioView): void
  emit(kind: SoundKind, x?: number, y?: number, power?: number): void
  unlock(): void
  setMuted(muted: boolean): void
  readonly muted: boolean
  setVolume(volume: number): void
  readonly volume: number
  dispose(): void
  /** Extra: read-only diagnostics. */
  stats(): BattleAudioStats
}

export const MAX_VOICES = 24
export const MAX_STARTS_PER_FRAME = 6
/** Ambient detail ticks (melee clatter, grunts) have their own small pool so they never starve one-shots. */
export const MAX_AMBIENT_TICKS = 8
const FLUSH_WINDOW = 0.05
const SCAN_INTERVAL = 0.1
/** Stride phase of each hoof beat: gallop = heavy pair then a lighter fall; walk/trot = an even pair. */
const GALLOP_BEATS = [0, 0.16, 0.34]
const TROT_BEATS = [0, 0.5]
const MASTER_LEVEL = 0.55
const STORAGE_MUTED = 'tw2d.audio.muted'
const STORAGE_VOLUME = 'tw2d.audio.volume'

const KINDS: readonly SoundKind[] = [
  'meleeHit', 'death', 'chargeImpact', 'knockdown', 'bowShot', 'gunShot', 'arrowLand',
  'rout', 'rally', 'victory', 'defeat', 'uiSelect', 'uiOrder',
]
const KIND_INDEX: Record<string, number> = {}
KINDS.forEach((k, i) => { KIND_INDEX[k] = i })
const K = KIND_INDEX
const POSITIONAL = KINDS.map(k => !(k === 'victory' || k === 'defeat' || k === 'uiSelect' || k === 'uiOrder'))
/** Output level of each kind's voice before distance attenuation. */
const KIND_GAIN = [0.28, 0.24, 0.95, 0.32, 0.22, 0.42, 0.16, 0.34, 0.28, 0.32, 0.32, 0.05, 0.05]
/** Scheduling priority multiplier: stingers and UI must never be dropped; impacts beat chatter. */
const KIND_PRIORITY = [1, 0.9, 3, 1.2, 1, 1.3, 0.7, 2.5, 2, 100, 100, 50, 50]
const DEFAULT_POWER = [0.4, 0.5, 0.6, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 0.5, 0.5]
const BUCKETS = 3
const SLOTS = KINDS.length * BUCKETS

/** Small deterministic PRNG (mulberry32) so tests and repeated runs are stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const log2n = (n: number) => Math.log2(Math.max(1, n))

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null
    return localStorage.getItem(key)
  } catch { return null }
}
function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    localStorage.setItem(key, value)
  } catch { /* storage unavailable or full */ }
}

function audioContextCtor(): (new () => AudioContext) | null {
  try {
    const g = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
    return g.AudioContext ?? g.webkitAudioContext ?? null
  } catch { return null }
}

interface VoiceSlot { end: number; priority: number; out: GainNode | null }

/** Everything that exists only after unlock(). */
interface Engine {
  ctx: AudioContext
  master: GainNode
  compressor: DynamicsCompressorNode
  zoomFilter: BiquadFilterNode
  camGain: GainNode
  shotBus: GainNode
  ambBus: GainNode
  white: AudioBuffer
  pink: AudioBuffer
  brown: AudioBuffer
  loops: AudioScheduledSourceNode[]
  windGain: GainNode
  feetGain: GainNode
  feetPan: StereoPannerNode | null
  feetFilter: BiquadFilterNode
  dinGain: GainNode
  dinPan: StereoPannerNode | null
  hoofBus: GainNode
  hoofPan: StereoPannerNode | null
}

export function createBattleAudio(): BattleAudio {
  const rnd = mulberry32(0x5eed2d)
  let engine: Engine | null = null
  let disposed = false
  let muted = storageGet(STORAGE_MUTED) === '1'
  let volume = (() => {
    const v = Number(storageGet(STORAGE_VOLUME))
    return storageGet(STORAGE_VOLUME) !== null && Number.isFinite(v) ? clamp(v, 0, 1) : 0.7
  })()

  // Listener, copied from the latest view so emit() can attenuate immediately.
  let camX = 150, camY = 115, halfW = 150, hasView = false
  let paused = false
  let speed = 1

  // Per (kind, stereo third) accumulators.
  const accN = new Float64Array(SLOTS)
  const accAtt = new Float64Array(SLOTS)
  const accLoud = new Float64Array(SLOTS)
  const accPan = new Float64Array(SLOTS)
  const accPow = new Float64Array(SLOTS)
  let pending = 0
  const order: number[] = []
  const priorities = new Float64Array(SLOTS)

  const voices: VoiceSlot[] = Array.from({ length: MAX_VOICES }, () => ({ end: 0, priority: 0, out: null }))
  const tickEnds = new Float64Array(MAX_AMBIENT_TICKS)
  let dropped = 0
  let startedLastFrame = 0
  let lastFlush = -Infinity
  let lastScan = -Infinity
  let lastUpdate = -1

  // Ambience state from the 10 Hz scan.
  let feetLevel = 0, hoofLevel = 0, hoofRatio = 0, hoofHerd = 0, dinLevel = 0
  let hoofPanV = 0, dinPanV = 0, meleeSpread = 0.3, meleeLoad = 0
  let nextStride = 0
  let clatterAcc = 0

  // Per-voice bookkeeping used by the recipe helpers.
  let curEnd = 0
  let curSrc: AudioScheduledSourceNode | null = null

  const visibility = () => {
    const e = engine
    if (!e || typeof document === 'undefined') return
    try {
      if (document.hidden) void e.ctx.suspend().catch(() => {})
      else void e.ctx.resume().catch(() => {})
    } catch { /* ignore */ }
  }

  function outputTarget(): number { return muted ? 0 : volume * MASTER_LEVEL }

  function setParam(p: AudioParam, value: number, now: number, tc: number): void {
    try { p.cancelScheduledValues(now); p.setTargetAtTime(value, now, tc) } catch { p.value = value }
  }

  function makeNoise(ctx: AudioContext, color: 'white' | 'pink' | 'brown'): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0
    for (let i = 0; i < length; i++) {
      const w = rnd() * 2 - 1
      if (color === 'white') data[i] = w * 0.5
      else if (color === 'pink') {
        // Paul Kellet's refined pink filter.
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
        b6 = w * 0.115926
      } else {
        last = (last + 0.02 * w) / 1.02
        data[i] = last * 3.5
      }
    }
    return buffer
  }

  function panner(ctx: AudioContext): StereoPannerNode | null {
    return typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null
  }

  function loop(e: Engine, buffer: AudioBuffer, dest: AudioNode, rate = 1): AudioBufferSourceNode {
    const src = e.ctx.createBufferSource()
    src.buffer = buffer; src.loop = true; src.playbackRate.value = rate
    src.connect(dest); src.start(0, rnd() * 1.5)
    e.loops.push(src)
    return src
  }

  function build(ctx: AudioContext): Engine {
    const master = ctx.createGain()
    master.gain.value = outputTarget()
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 4
    compressor.attack.value = 0.004; compressor.release.value = 0.25
    master.connect(compressor); compressor.connect(ctx.destination)
    const zoomFilter = ctx.createBiquadFilter()
    zoomFilter.type = 'lowpass'; zoomFilter.frequency.value = 9000; zoomFilter.Q.value = 0.5
    const camGain = ctx.createGain(); camGain.gain.value = 0.8
    zoomFilter.connect(camGain); camGain.connect(master)
    const shotBus = ctx.createGain(); shotBus.connect(zoomFilter)
    const ambBus = ctx.createGain(); ambBus.gain.value = 0; ambBus.connect(zoomFilter)
    const white = makeNoise(ctx, 'white'), pink = makeNoise(ctx, 'pink'), brown = makeNoise(ctx, 'brown')

    const windGain = ctx.createGain(); windGain.gain.value = 0.018
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 420; windFilter.Q.value = 0.6
    windFilter.connect(windGain); windGain.connect(ambBus)
    const feetFilter = ctx.createBiquadFilter(); feetFilter.type = 'lowpass'; feetFilter.frequency.value = 170; feetFilter.Q.value = 0.6
    const feetGain = ctx.createGain(); feetGain.gain.value = 0
    const feetPan = panner(ctx)
    feetFilter.connect(feetGain)
    if (feetPan) { feetGain.connect(feetPan); feetPan.connect(ambBus) } else feetGain.connect(ambBus)
    const dinFilter = ctx.createBiquadFilter(); dinFilter.type = 'bandpass'; dinFilter.frequency.value = 1500; dinFilter.Q.value = 0.7
    const dinGain = ctx.createGain(); dinGain.gain.value = 0
    const dinPan = panner(ctx)
    dinFilter.connect(dinGain)
    if (dinPan) { dinGain.connect(dinPan); dinPan.connect(ambBus) } else dinGain.connect(ambBus)
    const hoofBus = ctx.createGain(); hoofBus.gain.value = 0
    const hoofPan = panner(ctx)
    if (hoofPan) { hoofBus.connect(hoofPan); hoofPan.connect(ambBus) } else hoofBus.connect(ambBus)

    const e: Engine = {
      ctx, master, compressor, zoomFilter, camGain, shotBus, ambBus, white, pink, brown, loops: [],
      windGain, feetGain, feetPan, feetFilter, dinGain, dinPan, hoofBus, hoofPan,
    }
    loop(e, brown, windFilter, 0.6)
    loop(e, brown, feetFilter, 1)
    loop(e, pink, dinFilter, 1)
    // Slow gusts: LFOs on the wind band and level.
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 180
    lfo.connect(lfoDepth); lfoDepth.connect(windFilter.frequency); lfo.start()
    const gust = ctx.createOscillator(); gust.frequency.value = 0.11
    const gustDepth = ctx.createGain(); gustDepth.gain.value = 0.008
    gust.connect(gustDepth); gustDepth.connect(windGain.gain); gust.start()
    e.loops.push(lfo, gust)
    return e
  }

  // ---------------------------------------------------------------- listener

  /** 1 at the camera centre, ~0.4 at the screen edge, a faint floor far off screen. */
  function attenuation(x: number, y: number): number {
    const dx = (x - camX) / halfW, dy = (y - camY) / halfW
    return Math.max(0.025, 1 / (1 + 1.5 * (dx * dx + dy * dy)))
  }
  function panOf(x: number): number { return clamp((x - camX) / halfW, -1, 1) * 0.75 }

  // ---------------------------------------------------------------- synthesis helpers

  function track(src: AudioScheduledSourceNode, end: number): void {
    if (end >= curEnd) { curEnd = end; curSrc = src }
  }

  function envelope(g: GainNode, t: number, peak: number, attack: number, dur: number): void {
    const p = g.gain
    p.setValueAtTime(0.0001, t)
    p.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack)
    p.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.005, dur))
  }

  /** Filtered noise burst. `f1` sweeps the filter frequency over the burst when given. */
  function noise(dest: AudioNode, buffer: AudioBuffer, t: number, dur: number, type: BiquadFilterType, f0: number,
    q: number, peak: number, attack = 0.002, rate = 1, f1 = 0): void {
    const e = engine!
    const src = e.ctx.createBufferSource()
    src.buffer = buffer; src.playbackRate.value = rate
    const filter = e.ctx.createBiquadFilter()
    filter.type = type; filter.Q.value = q
    filter.frequency.setValueAtTime(f0, t)
    if (f1 > 0) filter.frequency.exponentialRampToValueAtTime(f1, t + dur)
    const g = e.ctx.createGain()
    envelope(g, t, peak, attack, dur)
    src.connect(filter); filter.connect(g); g.connect(dest)
    const end = t + dur + 0.03
    src.start(t, rnd() * Math.max(0, buffer.duration - dur * rate - 0.1)); src.stop(end)
    track(src, end)
  }

  /** Oscillator with an exponential pitch glide, optionally through a lowpass. */
  function tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number,
    attack = 0.003, lowpass = 0): void {
    const e = engine!
    const osc = e.ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    const g = e.ctx.createGain()
    envelope(g, t, peak, attack, dur)
    if (lowpass > 0) {
      const filter = e.ctx.createBiquadFilter()
      filter.type = 'lowpass'; filter.frequency.value = lowpass; filter.Q.value = 0.7
      osc.connect(filter); filter.connect(g)
    } else osc.connect(g)
    g.connect(dest)
    const end = t + dur + 0.03
    osc.start(t); osc.stop(end)
    track(osc, end)
  }

  /** Metallic ping: inharmonic partials with a fast decay. */
  function ping(dest: AudioNode, f: number, t: number, dur: number, peak: number, partials = 2): void {
    tone(dest, 'sine', f, f * 0.995, t, dur, peak, 0.001)
    if (partials > 1) tone(dest, 'sine', f * 2.76, f * 2.74, t, dur * 0.6, peak * 0.45, 0.001)
  }

  /** Brass-like note: two detuned saws and a sub triangle through a lowpass. */
  function horn(dest: AudioNode, f0: number, f1: number, t: number, dur: number, peak: number, bright: number): void {
    tone(dest, 'sawtooth', f0 * 1.003, f1 * 1.003, t, dur, peak, 0.05, bright)
    tone(dest, 'sawtooth', f0 * 0.997, f1 * 0.997, t + 0.006, dur, peak, 0.06, bright)
    tone(dest, 'triangle', f0 / 2, f1 / 2, t, dur, peak * 0.7, 0.05)
  }

  // ---------------------------------------------------------------- recipes

  function recipe(kind: number, d: AudioNode, t: number, n: number, p: number): void {
    const e = engine!
    const lg = log2n(n)
    switch (kind) {
      case K.meleeHit: {
        const layers = Math.min(3, 1 + Math.floor(lg))
        for (let i = 0; i < layers; i++) {
          const tt = t + (i ? rnd() * 0.045 : 0)
          noise(d, e.white, tt, 0.035 + 0.05 * p, 'bandpass', 1600 + rnd() * 1900, 1.3, 0.7, 0.002, 0.9 + rnd() * 0.25)
          if (i === 0 || rnd() < 0.7) ping(d, 2000 + rnd() * 3000, tt + 0.002, 0.09 + rnd() * 0.15, 0.16 * (1 - 0.4 * p))
        }
        if (p > 0.55) {
          tone(d, 'sine', 140 + rnd() * 30, 55, t, 0.13, 0.55 * p)
          noise(d, e.brown, t, 0.12, 'lowpass', 320, 0.7, 0.6 * p)
        }
        break
      }
      case K.death: {
        const k = Math.min(3, 1 + Math.floor(lg))
        for (let i = 0; i < k; i++) {
          const tt = t + (i ? rnd() * 0.08 : 0), dur = 0.22 + rnd() * 0.18
          noise(d, e.pink, tt, dur, 'bandpass', 360 + rnd() * 240, 3, 0.9, 0.025, 0.9 + rnd() * 0.2, 260 + rnd() * 80)
          tone(d, 'sawtooth', 115 + rnd() * 40, 75 + rnd() * 15, tt, dur, 0.09, 0.03, 520)
        }
        noise(d, e.brown, t + 0.08, 0.14, 'lowpass', 220, 0.7, 0.45)
        break
      }
      case K.knockdown: {
        const k = Math.min(3, 1 + Math.floor(lg))
        for (let i = 0; i < k; i++) {
          const tt = t + (i ? rnd() * 0.07 : 0)
          noise(d, e.brown, tt, 0.16 + rnd() * 0.05, 'lowpass', 200 + rnd() * 80, 0.8, 0.9)
          tone(d, 'sine', 70 + rnd() * 15, 42, tt, 0.14, 0.5)
          if (rnd() < 0.6) noise(d, e.white, tt + 0.01, 0.05, 'bandpass', 2500 + rnd() * 1500, 2, 0.12)
        }
        break
      }
      case K.chargeImpact: {
        // Low thump scaled hard by power, a wide crash, then a scatter of metal.
        const thump = 0.3 + 0.35 * p
        tone(d, 'sine', 85 + rnd() * 20, 38, t, thump, 0.6 + 0.4 * p, 0.002)
        if (p > 0.5) tone(d, 'sine', 55, 28, t + 0.01, 0.45 + 0.4 * p, 0.6 * p, 0.004)
        noise(d, e.pink, t, 0.35 + 0.6 * p, 'lowpass', 2500 + 4000 * p, 0.6, 0.55 + 0.45 * p, 0.004, 0.9 + rnd() * 0.2, 350)
        if (p > 0.3) noise(d, e.brown, t + 0.02, 0.5 + 0.7 * p + 0.08 * lg, 'lowpass', 300, 0.7, 0.7 * p, 0.03)
        if (p >= 0.9) noise(d, e.white, t + 0.005, 0.08, 'bandpass', 800 + rnd() * 300, 2, 0.5)
        const pings = Math.min(6, 1 + Math.round(p * 3) + Math.floor(lg))
        for (let i = 0; i < pings; i++) {
          ping(d, 1800 + rnd() * 3500, t + 0.02 + rnd() * (0.12 + 0.1 * p), 0.1 + rnd() * 0.2, 0.12 + rnd() * 0.08, 1)
        }
        break
      }
      case K.bowShot: {
        if (n < 4) {
          for (let i = 0; i < n; i++) {
            const tt = t + (i ? rnd() * 0.05 : 0)
            const f = 190 + rnd() * 120
            tone(d, 'triangle', f, f * 0.96, tt, 0.13, 0.35, 0.001, 1400)
            noise(d, e.white, tt + 0.01, 0.22, 'bandpass', 2600, 1.2, 0.35, 0.03, 1, 1100)
          }
        } else {
          // A volley: a few twangs over a rising hiss whose length and level grow with the count.
          const dur = Math.min(1.3, 0.5 + 0.12 * lg)
          noise(d, e.white, t + 0.03, dur, 'bandpass', 1200, 0.9, 0.5 + 0.08 * lg, dur * 0.35, 1, 3300)
          const twangs = Math.min(5, 1 + Math.floor(lg))
          for (let i = 0; i < twangs; i++) {
            const f = 180 + rnd() * 140
            tone(d, 'triangle', f, f * 0.96, t + rnd() * 0.14, 0.12, 0.22, 0.001, 1400)
          }
        }
        break
      }
      case K.gunShot: {
        const subs = n <= 1 ? 1 : Math.min(7, 1 + Math.ceil(lg * 1.5))
        for (let i = 0; i < subs; i++) {
          const tt = t + (i ? rnd() * 0.12 : 0)
          noise(d, e.white, tt, 0.035 + rnd() * 0.02, 'highpass', 1500 + rnd() * 1200, 0.7, 1, 0.001)
          noise(d, e.pink, tt, 0.1 + rnd() * 0.05, 'bandpass', 600 + rnd() * 300, 0.8, 0.55, 0.002)
        }
        const tail = 0.45 + 0.12 * lg
        noise(d, e.brown, t + 0.005, tail, 'lowpass', 220, 0.7, 0.8 + 0.05 * lg, 0.004)
        tone(d, 'sine', 70 + rnd() * 10, 36, t, 0.3, 0.45)
        break
      }
      case K.arrowLand: {
        const ticks = Math.min(7, 1 + Math.round(lg * 1.6))
        for (let i = 0; i < ticks; i++) {
          noise(d, e.white, t + rnd() * 0.09, 0.012 + rnd() * 0.01, 'highpass', 3500 + rnd() * 3000, 0.8, 0.6, 0.001)
        }
        if (n > 3) noise(d, e.pink, t + 0.02, 0.06, 'lowpass', 500, 0.7, 0.4)
        break
      }
      case K.rout: {
        noise(d, e.pink, t, 1.8, 'bandpass', 480, 0.7, 0.9, 0.5, 1, 300)
        horn(d, 233, 165, t + 0.1, 1.3, 0.12, 1000)
        break
      }
      case K.rally: {
        noise(d, e.pink, t, 1.0, 'bandpass', 700, 0.8, 0.6, 0.25, 1, 900)
        horn(d, 175, 233, t + 0.05, 0.9, 0.12, 1300)
        break
      }
      case K.victory: {
        horn(d, 196, 196, t, 0.24, 0.2, 1800)
        horn(d, 262, 262, t + 0.27, 0.24, 0.2, 1800)
        horn(d, 330, 330, t + 0.54, 1.0, 0.2, 2000)
        tone(d, 'sawtooth', 262, 262, t + 0.54, 1.0, 0.1, 0.06, 1500)
        break
      }
      case K.defeat: {
        horn(d, 220, 218, t, 0.5, 0.18, 800)
        horn(d, 175, 173, t + 0.5, 0.5, 0.18, 750)
        horn(d, 147, 140, t + 1.0, 1.4, 0.18, 650)
        break
      }
      case K.uiSelect:
        tone(d, 'sine', 1500, 1450, t, 0.035, 1, 0.002)
        break
      case K.uiOrder:
        tone(d, 'sine', 900, 890, t, 0.04, 1, 0.002)
        tone(d, 'sine', 1250, 1240, t + 0.045, 0.045, 1, 0.002)
        break
    }
  }

  /** Builds voice chain (lowpass by distance -> gain -> pan) and runs the recipe into it. */
  function startVoice(kind: number, n: number, power: number, att: number, loud: number, pan: number, t: number,
    bus: AudioNode): { out: GainNode; end: number } {
    const e = engine!
    const ctx = e.ctx
    const out = ctx.createGain()
    out.gain.value = KIND_GAIN[kind] * loud
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.Q.value = 0.5
    lp.frequency.value = POSITIONAL[kind] ? 1800 + 16000 * Math.pow(att, 0.8) : 20000
    const pn = panner(ctx)
    if (pn) pn.pan.value = pan
    lp.connect(out)
    if (pn) { out.connect(pn); pn.connect(bus) } else out.connect(bus)
    curEnd = t; curSrc = null
    recipe(kind, lp, t, n, power)
    const last = curSrc as AudioScheduledSourceNode | null
    if (last) last.onended = () => { try { out.disconnect(); lp.disconnect(); pn?.disconnect() } catch { /* gone */ } }
    return { out, end: curEnd }
  }

  // ---------------------------------------------------------------- clustering and voices

  function clearAccumulators(): void {
    if (!pending) return
    accN.fill(0); accAtt.fill(0); accLoud.fill(0); accPan.fill(0); accPow.fill(0)
    pending = 0
  }

  function flush(now: number): void {
    order.length = 0
    for (let i = 0; i < SLOTS; i++) {
      if (!accN[i]) continue
      const kind = (i / BUCKETS) | 0
      const loud = Math.min(1.8, accLoud[i] * (1 + 0.3 * log2n(accN[i])))
      priorities[i] = loud * KIND_PRIORITY[kind]
      order.push(i)
    }
    order.sort((a, b) => priorities[b] - priorities[a])
    let active = 0
    for (const v of voices) if (v.end > now) active++
    for (const i of order) {
      if (startedLastFrame >= MAX_STARTS_PER_FRAME) { dropped++; continue }
      const kind = (i / BUCKETS) | 0
      let slot: VoiceSlot | null = null
      if (active < MAX_VOICES) {
        for (const v of voices) if (v.end <= now) { slot = v; break }
        active++
      } else {
        // Full: steal the quietest voice only for something clearly more important.
        let quietest: VoiceSlot | null = null
        for (const v of voices) if (v.end > now && (!quietest || v.priority < quietest.priority)) quietest = v
        if (quietest && priorities[i] > quietest.priority * 1.5) {
          if (quietest.out) setParam(quietest.out.gain, 0, now, 0.02)
          slot = quietest
        }
      }
      if (!slot) { dropped++; continue }
      const n = accN[i]
      const att = accAtt[i] / n
      const pan = accAtt[i] > 0 ? accPan[i] / accAtt[i] : 0
      const loud = Math.min(1.8, accLoud[i] * (1 + 0.3 * log2n(n)))
      const bus = POSITIONAL[kind] ? engine!.shotBus : engine!.master
      const t = now + 0.01 + rnd() * 0.015
      const v = startVoice(kind, n, accPow[i], att, loud, pan, t, bus)
      slot.end = v.end; slot.out = v.out; slot.priority = priorities[i]
      startedLastFrame++
    }
    clearAccumulators()
  }

  // ---------------------------------------------------------------- ambience

  function scan(battle: Battle, now: number): void {
    const e = engine!
    let feet = 0, feetPanSum = 0
    let hoof = 0, hoofPanSum = 0, hoofRatioSum = 0
    let melee = 0, meleePanSum = 0, meleePanSq = 0
    for (const reg of battle.regiments) {
      if (!reg.aliveCount) continue
      const def = unitDef(reg.type)
      const cat = def.category
      const mounted = cat === 'cavalry' || cat === 'chariot'
      const footWeight = cat === 'monster' ? 5 : cat === 'monstrousInfantry' ? 2.5 : cat === 'chariot' ? 2 : mounted ? 0.4 : 1
      const charge = def.chargeSpeed > 0 ? def.chargeSpeed : 8
      const soldiers = reg.soldiers
      for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i]
        if (!s.alive || s.escaped) continue
        const w = attenuation(s.x, s.y)
        const pan = clamp((s.x - camX) / halfW, -1, 1)
        const v = s.speed < 0 ? -s.speed : s.speed
        if (s.swing) { melee += w; meleePanSum += w * pan; meleePanSq += w * pan * pan }
        if (v < 0.4 || s.down > 0) continue
        const f = w * footWeight * Math.min(1.5, v / 3)
        feet += f; feetPanSum += f * pan
        if (mounted) {
          hoof += w; hoofPanSum += w * pan
          hoofRatioSum += w * Math.min(1.2, v / charge)
        }
      }
    }
    // Saturating curves: a lone file is audible, a whole army does not blow up the mix.
    feetLevel = 0.24 * (1 - Math.exp(-feet / 90))
    hoofHerd = hoof
    hoofLevel = 0.5 * (1 - Math.exp(-hoof / 6))
    hoofRatio = hoof > 0 ? hoofRatioSum / hoof : 0
    hoofPanV = hoof > 0 ? (hoofPanSum / hoof) * 0.75 : 0
    meleeLoad = melee
    dinLevel = 0.15 * (1 - Math.exp(-melee / 18))
    dinPanV = melee > 0 ? (meleePanSum / melee) * 0.75 : 0
    meleeSpread = melee > 0 ? Math.sqrt(Math.max(0, meleePanSq / melee - (meleePanSum / melee) ** 2)) : 0.2
    const tc = 0.25
    setParam(e.feetGain.gain, feetLevel, now, tc)
    setParam(e.feetFilter.frequency, 140 + 120 * Math.min(1, feet / 300), now, tc)
    if (e.feetPan) setParam(e.feetPan.pan, clamp(feet > 0 ? (feetPanSum / feet) * 0.6 : 0, -1, 1), now, tc)
    setParam(e.dinGain.gain, dinLevel, now, tc)
    if (e.dinPan) setParam(e.dinPan.pan, clamp(dinPanV, -1, 1), now, tc)
    setParam(e.hoofBus.gain, hoofLevel, now, 0.15)
    if (e.hoofPan) setParam(e.hoofPan.pan, clamp(hoofPanV, -1, 1), now, tc)
    // Zoomed out: duller, a little quieter, as if heard from a hill. Zoomed in: full detail.
    setParam(e.zoomFilter.frequency, clamp(18000 * Math.pow(22 / halfW, 0.9), 2200, 18000), now, 0.2)
    setParam(e.camGain.gain, clamp(Math.pow(35 / halfW, 0.35), 0.5, 1), now, 0.2)
  }

  /** Schedules hoof strides ahead of the audio clock; tempo and brightness follow how close the herd is to charging. */
  function scheduleHooves(now: number): void {
    if (hoofLevel < 0.004) { nextStride = now; return }
    const e = engine!
    if (nextStride < now) nextStride = now
    const r = clamp(hoofRatio, 0, 1.2)
    const period = clamp(0.78 - 0.45 * r, 0.28, 0.78)
    const cutoff = 180 + 1000 * r * r
    const thumps = Math.min(3, 1 + Math.floor(log2n(1 + hoofHerd / 3)))
    let guard = 0
    while (nextStride < now + 0.12 && guard++ < 4) {
      const t = nextStride
      // Galloping: a heavy pair then a lighter footfall; walking/trotting: an even, softer pair.
      const beats = r > 0.6 ? 3 : 2
      for (let b = 0; b < beats; b++) {
        const bt = t + (r > 0.6 ? GALLOP_BEATS[b] : TROT_BEATS[b]) * period
        const accent = b === 0 ? 1 : b === 1 ? 0.8 : 0.55
        for (let h = 0; h < thumps; h++) {
          const ht = bt + (h ? rnd() * 0.04 : 0)
          noise(e.hoofBus, e.brown, ht, 0.07 + rnd() * 0.03, 'lowpass', cutoff * (0.85 + rnd() * 0.3), 1.1, accent * (0.6 + rnd() * 0.4))
          if (h === 0 && b === 0) tone(e.hoofBus, 'sine', 110 + rnd() * 20, 55, ht, 0.07, 0.35 * accent)
        }
      }
      nextStride += period * (0.94 + rnd() * 0.12)
    }
  }

  /** Steel clatter and grunts riding on the melee din, at a rate set by the number of swings near the listener. */
  function scheduleClatter(now: number, dt: number): void {
    if (meleeLoad < 0.05) { clatterAcc = 0; return }
    const e = engine!
    const rate = Math.min(28, meleeLoad * 1.4) * Math.sqrt(clamp(speed, 0.5, 5))
    clatterAcc = Math.min(4, clatterAcc + rate * dt)
    while (clatterAcc >= 1) {
      clatterAcc -= 1
      let free = -1
      for (let i = 0; i < MAX_AMBIENT_TICKS; i++) if (tickEnds[i] <= now) { free = i; break }
      if (free < 0) { clatterAcc = 0; break }
      const ctx = e.ctx
      const g = ctx.createGain()
      g.gain.value = (0.35 + 0.65 * Math.min(1, meleeLoad / 20)) * 0.22
      const pn = panner(ctx)
      if (pn) { pn.pan.value = clamp(dinPanV + (rnd() * 2 - 1) * (meleeSpread + 0.1), -1, 1); g.connect(pn); pn.connect(e.ambBus) } else g.connect(e.ambBus)
      const t = now + 0.01 + rnd() * 0.05
      curEnd = t; curSrc = null
      const roll = rnd()
      if (roll < 0.65) {
        noise(g, e.white, t, 0.03, 'bandpass', 1800 + rnd() * 2200, 1.4, 0.5)
        ping(g, 1800 + rnd() * 3400, t + 0.002, 0.08 + rnd() * 0.14, 0.18, rnd() < 0.5 ? 2 : 1)
      } else if (roll < 0.85) {
        noise(g, e.pink, t, 0.2 + rnd() * 0.15, 'bandpass', 330 + rnd() * 260, 3, 0.8, 0.03, 0.9 + rnd() * 0.2)
      } else {
        noise(g, e.white, t, 0.05, 'bandpass', 900 + rnd() * 600, 1.5, 0.6)
        noise(g, e.brown, t, 0.09, 'lowpass', 260, 0.7, 0.6)
      }
      tickEnds[free] = curEnd
      const last = curSrc as AudioScheduledSourceNode | null
      if (last) last.onended = () => { try { g.disconnect(); pn?.disconnect() } catch { /* gone */ } }
    }
  }

  // ---------------------------------------------------------------- public API

  const api: BattleAudio = {
    get muted() { return muted },
    get volume() { return volume },

    unlock() {
      if (disposed) return
      try {
        if (!engine) {
          const Ctor = audioContextCtor()
          if (!Ctor) return
          engine = build(new Ctor())
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', visibility)
          }
        }
        if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {})
      } catch {
        engine = null
      }
    },

    setMuted(value) {
      muted = !!value
      storageSet(STORAGE_MUTED, muted ? '1' : '0')
      if (engine) {
        try { setParam(engine.master.gain, outputTarget(), engine.ctx.currentTime, 0.03) } catch { /* ignore */ }
        if (muted) clearAccumulators()
      }
    },

    setVolume(value) {
      if (!Number.isFinite(value)) return
      volume = clamp(value, 0, 1)
      storageSet(STORAGE_VOLUME, String(volume))
      if (engine) try { setParam(engine.master.gain, outputTarget(), engine.ctx.currentTime, 0.03) } catch { /* ignore */ }
    },

    emit(kind, x, y, power) {
      if (!engine || disposed || paused || muted) return
      const k = KIND_INDEX[kind]
      if (k === undefined) return
      const p = power !== undefined && Number.isFinite(power) ? clamp(power, 0, 1) : DEFAULT_POWER[k]
      let att = 1, pan = 0
      if (POSITIONAL[k]) {
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          att = hasView ? 0.3 : 0.5
        } else {
          att = attenuation(x, y)
          pan = panOf(x)
        }
      }
      const slot = k * BUCKETS + (pan < -0.25 ? 0 : pan > 0.25 ? 2 : 1)
      accN[slot]++
      accAtt[slot] += att
      accPan[slot] += att * pan
      const loud = att * (0.35 + 0.65 * p)
      if (loud > accLoud[slot]) accLoud[slot] = loud
      if (p > accPow[slot]) accPow[slot] = p
      pending++
    },

    update(view) {
      const e = engine
      if (!e || disposed) return
      try {
        const now = e.ctx.currentTime
        const dt = lastUpdate < 0 ? 0 : clamp(now - lastUpdate, 0, 0.25)
        lastUpdate = now
        startedLastFrame = 0
        const zoom = view.camera.zoom > 0 ? view.camera.zoom : 1
        camX = view.camera.x; camY = view.camera.y
        halfW = Math.max(5, (view.width > 0 ? view.width : 800) / zoom / 2)
        hasView = true
        speed = Number.isFinite(view.speed) ? view.speed : 1
        if (view.paused) {
          if (!paused) setParam(e.ambBus.gain, 0, now, 0.08)
          paused = true
          clearAccumulators()
          nextStride = now; clatterAcc = 0
          return
        }
        if (paused || lastScan === -Infinity) setParam(e.ambBus.gain, 1, now, 0.15)
        paused = false
        if (e.ctx.state !== 'running') { clearAccumulators(); return }
        if (now - lastScan >= SCAN_INTERVAL) { lastScan = now; scan(view.battle, now) }
        if (muted) { clearAccumulators(); return }
        if (pending && now - lastFlush >= FLUSH_WINDOW) { lastFlush = now; flush(now) }
        scheduleHooves(now)
        scheduleClatter(now, dt)
      } catch { /* never let sound break a frame */ }
    },

    dispose() {
      if (disposed) return
      disposed = true
      const e = engine
      engine = null
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        try { document.removeEventListener('visibilitychange', visibility) } catch { /* ignore */ }
      }
      if (!e) return
      try { for (const s of e.loops) { try { s.stop() } catch { /* already stopped */ } } } catch { /* ignore */ }
      try { void e.ctx.close().catch(() => {}) } catch { /* ignore */ }
    },

    stats() {
      const now = engine ? engine.ctx.currentTime : 0
      let active = 0
      if (engine) for (const v of voices) if (v.end > now) active++
      return {
        active: !!engine, voices: active, startedLastFrame, dropped, pending,
        outputGain: outputTarget(), feet: feetLevel, hooves: hoofLevel, din: dinLevel,
      }
    },
  }
  return api
}
