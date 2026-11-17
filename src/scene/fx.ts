import type { SoundKind } from '../audio'
import type { Battle, Regiment, Side, Soldier, UnitDef } from '../sim/types'
import { unitDef } from '../sim/units'
import { layer, mulberry, stampArrow, stampBlood, stampMud, type Ground, type Layer } from './ground'

/**
 * Everything the battle leaves behind for the eye: the fallen, dust, smoke, sparks and the jolt of a charge going in.
 * It only watches the state the simulation already publishes, step by step, so nothing here can change an outcome.
 */

export type SoundSink = (kind: SoundKind, x?: number, y?: number, power?: number) => void

/** One model as the renderer follows it: what the last step showed, and the motion added for the eye alone. */
export interface Body {
  soldier: Soldier
  reg: Regiment
  def: UnitDef
  alive: boolean
  flash: number
  down: number
  charge: number
  /** Stride cycle 0..1, advanced by the distance actually covered. */
  gait: number
  /** Presentation offset along the facing, metres: the lunge of a blow, eased every frame. */
  lunge: number
  /** Metres still to give back after being struck. */
  recoil: number
  /** Visual time of the last throw to the ground, and which way and how hard it spun the body. */
  thrownAt: number
  spin: number
  /** How visible this body's passing is: dust puffs per second at full pace, puff size in metres, shake of its charge. */
  puffs: number
  size: number
  jolt: number
}
export interface Corpse { x: number; y: number; heading: number; def: UnitDef; side: Side; variant: number }

const DUST = 0, SMOKE = 1, MUZZLE = 2, SPARK = 3, BLOOD = 4, CLOD = 5
interface Particle { kind: number; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; grow: number; alpha: number }
interface Landing { at: number; x: number; y: number; angle: number }

export interface Scene {
  battle: Battle
  entries: Body[]
  /** Bodies to draw this step, far side of the field first. */
  live: Body[]
  corpses: Corpse[]
  particles: Particle[]
  landings: Landing[]
  /** Last battle step watched, and the last instant drawn. */
  time: number
  visual: number
  /** Seconds since the previous frame, in battle time, and this frame's easing shares for a blow's lunge and a hit's recoil. */
  frame: number
  lungeEase: number
  recoilKeep: number
  primed: boolean
  /** 0..1, decays in real time; the camera shakes by its square. */
  trauma: number
  shots: Map<number, number>
  routing: Set<number>
  decided: boolean
}

const MAX_PARTICLES = 1100, MAX_CORPSES = 4500
const scenes = new WeakMap<Battle, Scene>()
const random = mulberry(90210)
const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function sceneOf(battle: Battle): Scene {
  let scene = scenes.get(battle)
  if (!scene) {
    const entries = battle.regiments.flatMap(reg => {
      const def = unitDef(reg.type), [puffs, size, jolt] = weight(def)
      return reg.soldiers.map((soldier): Body => ({
        soldier, reg, def, alive: soldier.alive, flash: 0, down: 0, charge: 0,
        gait: (soldier.id * 0.618) % 1, lunge: 0, recoil: 0, thrownAt: -10, spin: 0, puffs, size, jolt,
      }))
    })
    scene = { battle, entries, live: [], corpses: [], particles: [], landings: [], time: -1, visual: -1, frame: 0, lungeEase: 0, recoilKeep: 1, primed: false, trauma: 0, shots: new Map(), routing: new Set(), decided: false }
    scenes.set(battle, scene)
  }
  return scene
}

function spawn(scene: Scene, kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, grow: number, alpha: number): void {
  const list = scene.particles
  // Over budget, the oldest haze gives way to what is happening now.
  if (list.length >= MAX_PARTICLES) list.splice(0, 32)
  list.push({ kind, x, y, vx, vy, age: 0, life, size, grow, alpha })
}

function dust(scene: Scene, x: number, y: number, vx: number, vy: number, size: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2, speed = random() * 0.9
    spawn(scene, DUST, x + Math.cos(a) * size * 0.4, y + Math.sin(a) * size * 0.4, vx * 0.25 + Math.cos(a) * speed, vy * 0.25 + Math.sin(a) * speed, 0.9 + random() * 0.9, size * (0.7 + random() * 0.5), size * 1.3, 0.42)
  }
}

/** [dust puffs per second at full pace, puff size in metres, shake of its charge] for a unit type. */
function weight(def: UnitDef): [number, number, number] {
  switch (def.category) {
    case 'chariot': return [4.5, 1.2, 0.34]
    case 'monster': return [4, 1.5, 0.42]
    case 'monstrousInfantry': return [2.2, 1, 0.16]
    case 'cavalry': return [3, 0.85, 0.085]
    default: return [0.3, 0.5, 0.012]
  }
}

/**
 * Bring the scene up to the battle's current step: note who fell, who was struck or thrown, which charges landed and
 * which shots were loosed, and leave their marks. `detail` is false when the view is too far out for blood and sparks;
 * `haze` (0..1) thins the dust from far out, where fewer and broader puffs read the same.
 */
export function watch(scene: Scene, ground: Ground | null, detail: boolean, haze: number, shown: (x: number, y: number) => number, sound?: SoundSink): void {
  const battle = scene.battle
  if (battle.time === scene.time) return
  const dt = Math.min(0.25, Math.max(0, battle.time - scene.time)), first = !scene.primed
  scene.time = battle.time; scene.primed = true
  scene.live.length = 0
  for (const body of scene.entries) {
    const s = body.soldier
    if (!s.alive) {
      if (body.alive) {
        body.alive = false
        if (!first && s.deathTime >= 0 && !s.escaped) fall(scene, ground, body, detail, sound)
      }
      continue
    }
    body.alive = true
    scene.live.push(body)
    if (first) { body.flash = s.flash; body.down = s.down; body.charge = s.chargeLeft; continue }
    const puffs = body.puffs * haze, size = body.size * (1.7 - 0.7 * haze), jolt = body.jolt
    if (s.flash > body.flash + 1e-6) {
      body.recoil = Math.min(0.5, 0.16 + body.def.radius * 0.2)
      sound?.('meleeHit', s.x, s.y, body.def.large ? 0.6 : 0.3)
      if (detail) {
        const back = s.facing + Math.PI
        for (let i = 0, n = body.def.large ? 4 : 2; i < n; i++) {
          const a = back + (random() - 0.5) * 2.4, speed = 1.5 + random() * 3
          spawn(scene, BLOOD, s.x, s.y, Math.cos(a) * speed, Math.sin(a) * speed, 0.22 + random() * 0.2, 0.07 + random() * 0.07, 0, 0.9)
        }
        if (body.def.armor >= 60) for (let i = 0; i < 2; i++) {
          const a = random() * Math.PI * 2, speed = 3 + random() * 5
          spawn(scene, SPARK, s.x + Math.cos(s.facing) * body.def.radius, s.y + Math.sin(s.facing) * body.def.radius, Math.cos(a) * speed, Math.sin(a) * speed, 0.1 + random() * 0.1, 0.05, 0, 1)
        }
      }
      if (ground && random() < 0.4) stampBlood(ground, s.x + (random() - 0.5) * 0.6, s.y + (random() - 0.5) * 0.6, 0.14 + random() * 0.16, 0.3, random() * 6)
      if (ground && random() < 0.5) stampMud(ground, s.x, s.y, 0.45 + random() * 0.4, 0.05)
    }
    body.flash = s.flash
    if (s.down > 0 && body.down <= 0) {
      body.thrownAt = scene.visual
      body.spin = (random() < 0.5 ? -1 : 1) * (2 + random() * 5)
      dust(scene, s.x, s.y, 0, 0, 0.5, 2)
      sound?.('knockdown', s.x, s.y, 0.5)
    }
    body.down = s.down
    if (s.chargeLeft > body.charge + 2 && s.chargePower > 0) {
      // The charge went home this step.
      const fx = Math.cos(s.facing), fy = Math.sin(s.facing), px = s.x + fx * body.def.radius, py = s.y + fy * body.def.radius
      dust(scene, px, py, fx * s.speed, fy * s.speed, size * 1.2, Math.ceil(2 + puffs * 0.7))
      if (detail) for (let i = 0, n = Math.ceil(puffs * 2); i < n; i++) {
        const a = s.facing + (random() - 0.5) * 2.2, speed = 2 + random() * 5
        spawn(scene, CLOD, px, py, Math.cos(a) * speed, Math.sin(a) * speed, 0.3 + random() * 0.3, 0.06 + random() * 0.08, 0, 1)
      }
      if (ground) stampMud(ground, px, py, size * 1.2, 0.16)
      scene.trauma = Math.min(1, scene.trauma + jolt * s.chargePower * shown(s.x, s.y))
      sound?.('chargeImpact', s.x, s.y, Math.min(1, jolt * 2.6 + 0.12) * s.chargePower)
    }
    body.charge = s.chargeLeft
    // Running feet and hooves raise dust in proportion to how hard they are driven.
    if (s.speed > 2.4 && s.down <= 0 && random() < puffs * dt * Math.min(1.6, s.speed / 6)) {
      const fx = Math.cos(s.facing), fy = Math.sin(s.facing)
      dust(scene, s.x - fx * body.def.radius, s.y - fy * body.def.radius, -fx * s.speed * 0.4, -fy * s.speed * 0.4, size, 1)
      if (ground && body.def.large && random() < 0.3) stampMud(ground, s.x, s.y, size * 0.7, 0.05)
    }
  }
  scene.live.sort((a, b) => b.soldier.y - a.soldier.y)
  for (const reg of battle.regiments) {
    const was = scene.routing.has(reg.id)
    if (reg.routing === was) continue
    if (reg.routing) scene.routing.add(reg.id); else scene.routing.delete(reg.id)
    if (!first && reg.aliveCount > 0) sound?.(reg.routing ? 'rout' : 'rally', reg.anchorX, reg.anchorY, 0.7)
  }
  if (battle.winner !== null && !scene.decided && !first) sound?.(battle.winner === 0 ? 'victory' : 'defeat')
  scene.decided = battle.winner !== null
  volleys(scene, first, sound)
  while (scene.landings.length && scene.landings[0].at <= battle.time) {
    const hit = scene.landings.shift()!
    if (ground) stampArrow(ground, hit.x, hit.y, hit.angle)
    if (random() < 0.3) sound?.('arrowLand', hit.x, hit.y, 0.3)
  }
}

function fall(scene: Scene, ground: Ground | null, body: Body, detail: boolean, sound?: SoundSink): void {
  const s = body.soldier, big = body.def.large
  scene.corpses.push({ x: s.x, y: s.y, heading: s.facing + (random() - 0.5) * 2.4, def: body.def, side: body.reg.side, variant: s.id })
  if (scene.corpses.length > MAX_CORPSES) scene.corpses.splice(0, 256)
  if (ground) {
    stampBlood(ground, s.x, s.y, (big ? 0.9 : 0.42) + random() * 0.3, 0.5, random() * 6)
    stampMud(ground, s.x, s.y, big ? 1.6 : 0.8, 0.12)
  }
  if (detail) for (let i = 0, n = big ? 9 : 5; i < n; i++) {
    const a = random() * Math.PI * 2, speed = 1 + random() * 3.5
    spawn(scene, BLOOD, s.x, s.y, Math.cos(a) * speed, Math.sin(a) * speed, 0.25 + random() * 0.25, 0.07 + random() * 0.09, 0, 0.9)
  }
  if (big) dust(scene, s.x, s.y, 0, 0, 1, 4)
  sound?.('death', s.x, s.y, big ? 0.8 : 0.4)
}

/** A shooter whose missile was not in the air a moment ago has just loosed: flash and smoke for guns, a mark where arrows will land. */
function volleys(scene: Scene, first: boolean, sound?: SoundSink): void {
  const now = scene.battle.time
  for (const p of scene.battle.projectiles) {
    const last = scene.shots.get(p.shooterId)
    scene.shots.set(p.shooterId, now)
    if (first || (last !== undefined && now - last < 0.5)) continue
    const heading = Math.atan2(p.vy, p.vx), fx = Math.cos(heading), fy = Math.sin(heading)
    if (p.arc) {
      sound?.('bowShot', p.originX, p.originY, 0.4)
      if (random() < 0.55 && scene.landings.length < 600) {
        const at = now - p.age + p.duration, landing = { at, x: p.landX, y: p.landY, angle: Math.atan2(p.landY - p.originY, p.landX - p.originX) }
        let i = scene.landings.length
        while (i > 0 && scene.landings[i - 1].at > at) i--
        scene.landings.splice(i, 0, landing)
      }
    } else {
      sound?.('gunShot', p.originX, p.originY, 0.6)
      const mx = p.originX + fx * 1.1, my = p.originY + fy * 1.1
      spawn(scene, MUZZLE, mx, my, fx * 2, fy * 2, 0.07, 0.7, 2, 1)
      for (let i = 0; i < 2; i++) spawn(scene, SMOKE, mx + fx * i * 0.5, my + fy * i * 0.5, fx * (1.6 - i * 0.6) + (random() - 0.5) * 0.5, fy * (1.6 - i * 0.6) + (random() - 0.5) * 0.5, 2.4 + random() * 1.8, 0.5 + random() * 0.3, 0.75, 0.42)
    }
  }
  if (scene.shots.size > 4000) for (const [id, at] of scene.shots) if (now - at > 20) scene.shots.delete(id)
}

/** Move the scene's own clock to the instant being drawn. Returns the battle seconds since the last frame. */
export function advance(scene: Scene, visual: number, wallSeconds: number): number {
  const dt = scene.visual < 0 || visual < scene.visual || visual - scene.visual > 1 ? 0 : visual - scene.visual
  scene.visual = visual; scene.frame = dt
  scene.lungeEase = 1 - Math.exp(-24 * dt); scene.recoilKeep = Math.exp(-9 * dt)
  scene.trauma = Math.max(0, scene.trauma - wallSeconds * 1.7)
  if (dt > 0) {
    const list = scene.particles
    let kept = 0
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      p.age += dt
      if (p.age >= p.life) continue
      const drag = p.kind === DUST || p.kind === SMOKE ? Math.exp(-1.6 * dt) : p.kind === MUZZLE ? 1 : Math.exp(-5 * dt)
      p.vx *= drag; p.vy *= drag
      // Haze drifts downwind as it thins.
      if (p.kind === SMOKE || p.kind === DUST) { p.vx += 0.5 * dt; p.vy -= 0.18 * dt }
      p.x += p.vx * dt; p.y += p.vy * dt
      list[kept++] = p
    }
    list.length = kept
  }
  return dt
}

/** Screen offset for the camera this frame, in pixels. */
export function shake(scene: Scene, wallSeconds: number, strength: number): [number, number] {
  if (still || scene.trauma <= 0.001) return [0, 0]
  const power = scene.trauma * scene.trauma * strength
  return [Math.sin(wallSeconds * 61) * power, Math.cos(wallSeconds * 47 + 1.3) * power]
}

interface Brushes { dust: Layer; smoke: Layer; muzzle: Layer }
let brushes: Brushes | null | undefined
function puff(inner: string, outer: string): Layer | null {
  const made = layer(64, 64)
  if (!made) return null
  const fill = made.pen.createRadialGradient(32, 32, 0, 32, 32, 32)
  fill.addColorStop(0, inner); fill.addColorStop(0.45, outer); fill.addColorStop(1, outer.replace(/[\d.]+\)$/, '0)'))
  made.pen.fillStyle = fill
  made.pen.fillRect(0, 0, 64, 64)
  return made
}
function brushesOf(): Brushes | null {
  if (brushes !== undefined) return brushes
  const a = puff('rgba(214,196,158,0.95)', 'rgba(196,178,140,0.5)'), b = puff('rgba(240,238,230,0.95)', 'rgba(214,212,204,0.5)'), c = puff('rgba(255,250,224,1)', 'rgba(255,196,96,0.7)')
  return brushes = a && b && c ? { dust: a, smoke: b, muzzle: c } : null
}

type Ctx = CanvasRenderingContext2D
/** Paint the air: haze as soft sprites, blood and sparks as specks. `toScreen` writes a world point's pixels into `out`. */
export function drawParticles(ctx: Ctx, scene: Scene, zoom: number, width: number, height: number, toScreenX: (x: number) => number, toScreenY: (y: number) => number): void {
  const soft = brushesOf()
  for (const p of scene.particles) {
    const x = toScreenX(p.x), y = toScreenY(p.y), t = p.age / p.life
    if (x < -80 || y < -80 || x > width + 80 || y > height + 80) continue
    if (p.kind <= MUZZLE) {
      if (!soft) continue
      const size = Math.max(2, (p.size + p.grow * p.age) * zoom)
      ctx.globalAlpha = p.kind === MUZZLE ? 1 - t : p.alpha * Math.min(1, t * 7) * (1 - t)
      ctx.drawImage((p.kind === DUST ? soft.dust : p.kind === SMOKE ? soft.smoke : soft.muzzle).canvas, x - size, y - size, size * 2, size * 2)
    } else {
      const size = Math.max(1, p.size * zoom)
      ctx.globalAlpha = p.alpha * (1 - t * t)
      ctx.fillStyle = p.kind === BLOOD ? '#8e1a12' : p.kind === SPARK ? '#ffe9a8' : '#4c3b25'
      if (p.kind === SPARK) ctx.fillRect(x - size, y - size * 0.5, size * 2.4, size)
      else ctx.fillRect(x - size * 0.5, y - size * 0.5, size, size)
    }
  }
  ctx.globalAlpha = 1
}
