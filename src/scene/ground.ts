import { MAP_HEIGHT, MAP_WIDTH } from '../sim/types'

/**
 * The painted battlefield: one texture of the map and the scenery around it, generated from the battle seed.
 * Blood, churned mud and spent arrows are stamped into the same texture, so a long fight costs nothing per frame.
 * Everything here is presentation only; the simulation's field stays flat and featureless.
 */

/** Metres of scenery beyond the map edge. */
export const GROUND_MARGIN = 48
/** Texture pixels per metre. */
export const GROUND_PPM = 6
export const VOID_COLOR = '#11140e'

export type Pen = OffscreenCanvasRenderingContext2D
export interface Layer { canvas: OffscreenCanvas; pen: Pen }

/** Scene layers need OffscreenCanvas; without it (old browsers, unit tests) the renderer falls back to flat fills. */
export function layer(width: number, height: number): Layer | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  try {
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
    const pen = canvas.getContext('2d')
    return pen ? { canvas, pen } : null
  } catch { return null }
}

export function mulberry(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = state + 0x6D2B79F5 | 0
    let t = Math.imul(state ^ state >>> 15, 1 | state)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/** Smooth lattice noise in [0, 1). A period makes it tile. */
export function valueNoise(seed: number, period = 0): (x: number, y: number) => number {
  const wrap = (v: number) => period ? ((v % period) + period) % period : v
  const hash = (x: number, y: number) => {
    let h = Math.imul(wrap(x), 374761393) + Math.imul(wrap(y), 668265263) + seed | 0
    h = Math.imul(h ^ h >>> 13, 1274126177)
    return ((h ^ h >>> 16) >>> 0) / 4294967296
  }
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0
  for (let i = 0; i < octaves; i++) { sum += noise(x, y) * amp; norm += amp; amp *= 0.5; x *= 2.03; y *= 2.03 }
  return sum / norm
}

const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t) }
const mix = (a: number, b: number, t: number) => a + (b - a) * t

type Rgb = [number, number, number]
const LUSH: Rgb = [72, 108, 52], MEADOW: Rgb = [112, 138, 64], DRY: Rgb = [164, 158, 90], EARTH: Rgb = [134, 110, 74]

export interface Ground {
  canvas: OffscreenCanvas
  pen: Pen
  seed: number
  /** Something has been stamped since the field was painted. */
  dirty: boolean
  /** Soft round brush, white on transparent: tinted through globalAlpha and a colour pass. */
  blood: Layer
  mud: Layer
}

const WIDTH = (MAP_WIDTH + GROUND_MARGIN * 2) * GROUND_PPM, HEIGHT = (MAP_HEIGHT + GROUND_MARGIN * 2) * GROUND_PPM
const gx = (x: number) => (x + GROUND_MARGIN) * GROUND_PPM
const gy = (y: number) => (MAP_HEIGHT + GROUND_MARGIN - y) * GROUND_PPM

let current: Ground | null = null

/** The field for this seed. `fresh` (a new battle) repaints it if the last battle left marks on it. */
export function groundFor(seed: number, fresh: boolean): Ground | null {
  if (current && current.seed === seed && !(fresh && current.dirty)) return current
  const made = current && current.seed === seed ? current : build(seed)
  if (!made) return null
  if (made === current) { paintField(made.pen, seed); made.dirty = false }
  return current = made
}

function softDot(color: string): Layer | null {
  const dot = layer(32, 32)
  if (!dot) return null
  const fill = dot.pen.createRadialGradient(16, 16, 0, 16, 16, 16)
  fill.addColorStop(0, color); fill.addColorStop(0.55, color); fill.addColorStop(1, 'rgba(0,0,0,0)')
  dot.pen.fillStyle = fill
  dot.pen.fillRect(0, 0, 32, 32)
  return dot
}

function build(seed: number): Ground | null {
  const base = layer(WIDTH, HEIGHT), blood = softDot('rgb(92,18,14)'), mud = softDot('rgb(70,56,36)')
  if (!base || !blood || !mud) return null
  paintField(base.pen, seed)
  return { canvas: base.canvas, pen: base.pen, seed, dirty: false, blood, mud }
}

function paintField(pen: Pen, seed: number): void {
  const rnd = mulberry(seed ^ 0x51ed270b)
  const moist = valueNoise(seed + 11), detail = valueNoise(seed + 23), bare = valueNoise(seed + 37)
  // Colour field at 2 px per metre, stretched smoothly over the texture.
  const cw = Math.round(WIDTH / GROUND_PPM * 2), ch = Math.round(HEIGHT / GROUND_PPM * 2)
  const field = layer(cw, ch)
  const colour = new Float32Array(cw * ch * 3)
  const earthAt = new Uint8Array(cw * ch)
  if (field) {
    const image = field.pen.createImageData(cw, ch), data = image.data
    for (let y = 0, i = 0, k = 0; y < ch; y++) for (let x = 0; x < cw; x++, i += 4, k += 3) {
      const wx = x / 2, wy = y / 2
      const m = fbm(moist, wx / 52, wy / 52, 4), d = fbm(detail, wx / 13 + 40, wy / 13, 3), e = fbm(bare, wx / 74 + 9, wy / 74 + 5, 4)
      const dry = smooth(0.42, 0.66, m), lush = 1 - smooth(0.3, 0.5, m)
      const earth = smooth(0.63, 0.73, e) * 0.72
      const shade = 0.86 + d * 0.3
      for (let c = 0; c < 3; c++) {
        let v = mix(mix(MEADOW[c], DRY[c], dry), LUSH[c], lush)
        v = mix(v, EARTH[c], earth) * shade
        colour[k + c] = v; data[i + c] = v
      }
      data[i + 3] = 255
      earthAt[y * cw + x] = earth > 0.35 ? 1 : 0
    }
    field.pen.putImageData(image, 0, 0)
    pen.imageSmoothingEnabled = true
    pen.imageSmoothingQuality = 'high'
    pen.drawImage(field.canvas, 0, 0, WIDTH, HEIGHT)
  } else {
    pen.fillStyle = `rgb(${MEADOW})`
    pen.fillRect(0, 0, WIDTH, HEIGHT)
  }
  const sample = (px: number, py: number): Rgb => {
    const x = Math.max(0, Math.min(cw - 1, Math.floor(px / WIDTH * cw))), y = Math.max(0, Math.min(ch - 1, Math.floor(py / HEIGHT * ch)))
    const k = (y * cw + x) * 3
    return [colour[k], colour[k + 1], colour[k + 2]]
  }
  const onEarth = (px: number, py: number) => earthAt[Math.max(0, Math.min(ch - 1, Math.floor(py / HEIGHT * ch))) * cw + Math.max(0, Math.min(cw - 1, Math.floor(px / WIDTH * cw)))] === 1

  // Brushwork: broad translucent dabs in the local colour, a little lighter or darker, mostly lying flat.
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * WIDTH, y = rnd() * HEIGHT, [r, g, b] = sample(x, y), tone = 0.84 + rnd() * 0.34
    pen.fillStyle = `rgba(${r * tone | 0},${g * tone | 0},${b * (tone * 0.96) | 0},${0.16 + rnd() * 0.2})`
    pen.beginPath()
    pen.ellipse(x, y, 7 + rnd() * 19, 2 + rnd() * 5, (rnd() - 0.5) * 0.9, 0, Math.PI * 2)
    pen.fill()
  }
  // Grass: short strokes leaning with the wind, light on top of dark.
  pen.lineCap = 'round'
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * WIDTH, y = rnd() * HEIGHT
    if (onEarth(x, y) && rnd() < 0.8) continue
    const [r, g, b] = sample(x, y), light = rnd() < 0.45, tone = light ? 1.22 + rnd() * 0.2 : 0.62 + rnd() * 0.2
    const length = 2.2 + rnd() * 3.6, lean = 0.5 + (rnd() - 0.5) * 0.7
    pen.strokeStyle = `rgba(${Math.min(255, r * tone) | 0},${Math.min(255, g * tone) | 0},${b * tone * 0.9 | 0},${0.3 + rnd() * 0.35})`
    pen.lineWidth = 0.8 + rnd() * 0.7
    pen.beginPath(); pen.moveTo(x, y); pen.lineTo(x + Math.sin(lean) * length, y - Math.cos(lean) * length); pen.stroke()
  }
  // Bare earth: pebbles and cracks of darker soil.
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * WIDTH, y = rnd() * HEIGHT
    if (!onEarth(x, y)) continue
    const dark = rnd() < 0.6
    pen.fillStyle = dark ? `rgba(70,54,36,${0.22 + rnd() * 0.25})` : `rgba(196,176,134,${0.2 + rnd() * 0.25})`
    pen.beginPath(); pen.ellipse(x, y, 0.8 + rnd() * 2.2, 0.6 + rnd() * 1.2, rnd() * 3, 0, Math.PI * 2); pen.fill()
  }
  // Wildflowers gather in drifts on the green.
  const petals = ['rgba(244,238,214,', 'rgba(236,206,96,', 'rgba(214,170,206,', 'rgba(232,120,96,']
  for (let i = 0; i < 150; i++) {
    const cx = rnd() * WIDTH, cy = rnd() * HEIGHT
    if (onEarth(cx, cy)) continue
    const tint = petals[i % petals.length], spread = 10 + rnd() * 34
    for (let n = 4 + rnd() * 16 | 0; n > 0; n--) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * spread
      pen.fillStyle = `${tint}${0.5 + rnd() * 0.4})`
      pen.beginPath(); pen.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, 0.6 + rnd() * 0.7, 0, Math.PI * 2); pen.fill()
    }
  }
  // Field stones, lit from the upper left.
  for (let i = 0; i < 110; i++) {
    const x = rnd() * WIDTH, y = rnd() * HEIGHT, r = 1.6 + rnd() * 3.4, turn = rnd() * 3
    pen.fillStyle = 'rgba(24,28,18,0.42)'
    pen.beginPath(); pen.ellipse(x + r * 0.5, y + r * 0.55, r * 1.05, r * 0.7, turn, 0, Math.PI * 2); pen.fill()
    pen.fillStyle = `rgb(${128 + rnd() * 30 | 0},${126 + rnd() * 26 | 0},${112 + rnd() * 20 | 0})`
    pen.beginPath(); pen.ellipse(x, y, r, r * 0.68, turn, 0, Math.PI * 2); pen.fill()
    pen.fillStyle = 'rgba(232,226,204,0.5)'
    pen.beginPath(); pen.ellipse(x - r * 0.25, y - r * 0.2, r * 0.5, r * 0.3, turn, 0, Math.PI * 2); pen.fill()
  }
  // Copses frame the field from outside the map; nothing stands where troops can go.
  const inMap = (px: number, py: number, pad: number) => px > gx(-pad) && px < gx(MAP_WIDTH + pad) && py > gy(MAP_HEIGHT + pad) && py < gy(-pad)
  const copse = valueNoise(seed + 91)
  for (let i = 0; i < 520; i++) {
    const x = rnd() * WIDTH, y = rnd() * HEIGHT
    if (inMap(x, y, 7) || copse(x / 260, y / 260) < 0.47) continue
    tree(pen, rnd, x, y, (2.2 + rnd() * 2.6) * GROUND_PPM)
  }
  // Low sun from the upper left: warm where it lands, cool where the field falls away.
  const light = pen.createLinearGradient(0, 0, WIDTH, HEIGHT)
  light.addColorStop(0, 'rgba(255,232,178,0.13)'); light.addColorStop(0.5, 'rgba(255,232,178,0)'); light.addColorStop(1, 'rgba(18,28,48,0.16)')
  pen.fillStyle = light
  pen.fillRect(0, 0, WIDTH, HEIGHT)
  // Outside the map the scenery sinks into shade and fades out.
  pen.fillStyle = 'rgba(12,16,10,0.34)'
  pen.beginPath(); pen.rect(0, 0, WIDTH, HEIGHT); pen.rect(gx(0), gy(MAP_HEIGHT), MAP_WIDTH * GROUND_PPM, MAP_HEIGHT * GROUND_PPM); pen.fill('evenodd')
  const fade = GROUND_MARGIN * 0.7 * GROUND_PPM
  const edges: [number, number, number, number, number, number, number, number][] = [
    [0, 0, fade, 0, 0, 0, fade, HEIGHT], [WIDTH, 0, WIDTH - fade, 0, WIDTH - fade, 0, fade, HEIGHT],
    [0, 0, 0, fade, 0, 0, WIDTH, fade], [0, HEIGHT, 0, HEIGHT - fade, 0, HEIGHT - fade, WIDTH, fade],
  ]
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
    const veil = pen.createLinearGradient(x0, y0, x1, y1)
    veil.addColorStop(0, VOID_COLOR); veil.addColorStop(1, 'rgba(17,20,14,0)')
    pen.fillStyle = veil
    pen.fillRect(rx, ry, rw, rh)
  }
}

function tree(pen: Pen, rnd: () => number, x: number, y: number, r: number): void {
  pen.fillStyle = 'rgba(14,20,12,0.36)'
  pen.beginPath(); pen.ellipse(x + r * 0.55, y + r * 0.7, r * 1.05, r * 0.82, 0.5, 0, Math.PI * 2); pen.fill()
  const greens = ['#2c4024', '#35502b', '#3f5c31']
  for (let i = 0; i < 5; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * r * 0.45
    pen.fillStyle = greens[i % 3]
    pen.beginPath(); pen.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.55 + rnd() * 0.3), 0, Math.PI * 2); pen.fill()
  }
  for (let i = 0; i < 6; i++) {
    const a = -2.4 + (rnd() - 0.5) * 1.6, d = rnd() * r * 0.6
    pen.fillStyle = `rgba(${96 + rnd() * 30 | 0},${128 + rnd() * 26 | 0},${62 + rnd() * 16 | 0},${0.35 + rnd() * 0.3})`
    pen.beginPath(); pen.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.3, r * 0.2, rnd() * 3, 0, Math.PI * 2); pen.fill()
  }
}

/** A stain where a man was struck or fell. Radius in metres. */
export function stampBlood(ground: Ground, x: number, y: number, radius: number, alpha: number, turn: number): void {
  const pen = ground.pen, r = radius * GROUND_PPM
  ground.dirty = true
  pen.globalAlpha = alpha
  pen.drawImage(ground.blood.canvas, gx(x) - r, gy(y) - r * 0.8, r * 2, r * 1.6)
  // A second, smaller lobe keeps pools from reading as perfect discs.
  pen.drawImage(ground.blood.canvas, gx(x) - r * 0.6 + Math.cos(turn) * r * 0.7, gy(y) - r * 0.5 + Math.sin(turn) * r * 0.7, r * 1.2, r)
  pen.globalAlpha = 1
}

/** Grass worn to soil under a fight or a charge. */
export function stampMud(ground: Ground, x: number, y: number, radius: number, alpha: number): void {
  const pen = ground.pen, r = radius * GROUND_PPM
  ground.dirty = true
  pen.globalAlpha = alpha
  pen.drawImage(ground.mud.canvas, gx(x) - r, gy(y) - r, r * 2, r * 2)
  pen.globalAlpha = 1
}

/** A spent arrow standing in the turf, with its short shadow. `angle` is the flight heading in world radians. */
export function stampArrow(ground: Ground, x: number, y: number, angle: number): void {
  const pen = ground.pen, px = gx(x), py = gy(y), dx = Math.cos(angle) * 4.2, dy = -Math.sin(angle) * 4.2
  ground.dirty = true
  pen.lineCap = 'round'
  pen.strokeStyle = 'rgba(18,22,14,0.4)'; pen.lineWidth = 1
  pen.beginPath(); pen.moveTo(px, py); pen.lineTo(px + 2.6, py + 2.2); pen.stroke()
  pen.strokeStyle = 'rgba(96,74,46,0.85)'; pen.lineWidth = 0.9
  pen.beginPath(); pen.moveTo(px, py); pen.lineTo(px - dx, py - dy); pen.stroke()
  pen.strokeStyle = 'rgba(226,218,196,0.7)'; pen.lineWidth = 1.2
  pen.beginPath(); pen.moveTo(px - dx * 0.74, py - dy * 0.74); pen.lineTo(px - dx, py - dy); pen.stroke()
}

/** Screen rectangle of the whole texture for a camera. */
export function groundRect(originX: number, originY: number, zoom: number): [number, number, number, number] {
  return [originX - GROUND_MARGIN * zoom, originY - (MAP_HEIGHT + GROUND_MARGIN) * zoom, WIDTH / GROUND_PPM * zoom, HEIGHT / GROUND_PPM * zoom]
}

// --- Close-up detail and weather -----------------------------------------------------------------------------------

export interface Sky { blades: Layer; clouds: Layer; vignette: Layer }
let sky: Sky | null | undefined

/** Seed-independent layers: grass blades for close views, drifting cloud shadow and the lens vignette. */
export function skyLayers(): Sky | null {
  if (sky !== undefined) return sky
  const blades = layer(256, 256), clouds = layer(256, 256), vignette = layer(256, 256)
  if (!blades || !clouds || !vignette) return sky = null
  const rnd = mulberry(7717)
  blades.pen.lineCap = 'round'
  for (let i = 0; i < 520; i++) {
    const x = rnd() * 256, y = rnd() * 256, length = 5 + rnd() * 9, lean = 0.5 + (rnd() - 0.5) * 0.8, light = rnd() < 0.5
    blades.pen.strokeStyle = light ? `rgba(196,206,128,${0.2 + rnd() * 0.25})` : `rgba(30,44,22,${0.2 + rnd() * 0.25})`
    blades.pen.lineWidth = 1 + rnd() * 1.2
    // Drawn three times around the edges so the tile repeats without a seam.
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
      blades.pen.beginPath(); blades.pen.moveTo(x + ox, y + oy)
      blades.pen.quadraticCurveTo(x + ox + Math.sin(lean) * length * 0.4, y + oy - Math.cos(lean) * length * 0.7, x + ox + Math.sin(lean) * length, y + oy - Math.cos(lean) * length)
      blades.pen.stroke()
    }
  }
  const noise = valueNoise(4409, 4), image = clouds.pen.createImageData(256, 256)
  for (let y = 0, i = 0; y < 256; y++) for (let x = 0; x < 256; x++, i += 4) {
    // Three octaves of a period-4 lattice: 4, 8 and 16 cells across, all of which tile.
    const n = noise(x / 64, y / 64) * 0.55 + noise(x / 32 + 2, y / 32 + 1) * 0.3 + noise(x / 16 + 1, y / 16 + 3) * 0.15
    image.data[i] = 10; image.data[i + 1] = 16; image.data[i + 2] = 30
    image.data[i + 3] = smooth(0.5, 0.72, n) * 50
  }
  clouds.pen.putImageData(image, 0, 0)
  const shade = vignette.pen.createRadialGradient(118, 112, 60, 128, 128, 190)
  shade.addColorStop(0, 'rgba(8,10,6,0)'); shade.addColorStop(0.6, 'rgba(8,10,6,0.06)'); shade.addColorStop(1, 'rgba(8,10,6,0.5)')
  vignette.pen.fillStyle = shade
  vignette.pen.fillRect(0, 0, 256, 256)
  return sky = { blades, clouds, vignette }
}
