import type { Side, UnitDef, UnitType } from '../sim/types'

/**
 * Every body on the field, painted from above in its own frame: +x is the way it faces, +y its right hand.
 * The caller has already moved the pen to the body and turned it to `pose.heading`; nothing here translates,
 * so shadows and highlights are worked out against that heading and stay fixed to the screen's light.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
export type FigureState = 'up' | 'down' | 'dead'
export interface Pose {
  /** World heading the pen is turned to, radians. */
  heading: number
  /** Stride frame 0..STEPS-1 while moving, -1 standing. */
  step: number
  /** -1 at rest, otherwise 0..1 through the windup of a blow. */
  swing: number
  state: FigureState
  flash: boolean
  selected: boolean
  wounded: boolean
  /** Which of the kit's coats, cloths or skins this body wears. */
  variant: number
  /** Paint a standing figure without the weapon it holds, or that weapon alone; the whole figure when unset. */
  part?: 'body' | 'weapon'
}
export const STEPS = 8

const INK = '#14160f', STEEL = '#dfe5e9', WOOD = '#a5855a', LEATHER = '#6e4c2e', BOOT = '#2a231b', IRON = '#3d4043'
const SKIN = ['#d9a780', '#c79171', '#e3b992', '#b9805e']
const DRAB = ['#8a7a58', '#766a4e', '#95835c', '#6d6248']
const COATS = ['#6a4526', '#8b5530', '#2f2a26', '#b9b3a6', '#a6885b', '#4a3220']
const HIDES = ['#a98a69', '#8d906f', '#b47b5c', '#96806a']

interface Colours { far: string; cloth: string; clothDark: string; clothLight: string; trim: string; metal: string; metalDark: string; metalLight: string; plume: string; hat: string }
/** South: azure and cream under bright steel. North: crimson and gold under blackened iron. */
const FACTION: Colours[] = [
  { far: '#4f88dc', cloth: '#3a69b0', clothDark: '#264a82', clothLight: '#7ea8de', trim: '#f0e6c6', metal: '#c2c9cf', metalDark: '#7c8790', metalLight: '#f6f9fa', plume: '#f4f0e0', hat: '#5c4731' },
  { far: '#dc4e3c', cloth: '#c23f30', clothDark: '#8a2a22', clothLight: '#e8826c', trim: '#e9c96f', metal: '#9b9d99', metalDark: '#555756', metalLight: '#dcdfdc', plume: '#e2533a', hat: '#231f1d' },
]

const rgbOf = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
const blends = new Map<string, string>()
function blend(hex: string, toward: string, amount: number, gain = 1): string {
  const key = `${hex}${toward}${amount}${gain}`
  let made = blends.get(key)
  if (!made) {
    const a = rgbOf(hex), b = rgbOf(toward)
    made = '#' + a.map((v, i) => Math.round(Math.min(255, (v + (b[i] - v) * amount) * gain)).toString(16).padStart(2, '0')).join('')
    blends.set(key, made)
  }
  return made
}
type Tone = (hex: string) => string
/** Standing, struck (blown out toward white) and fallen (sunk toward the soil). */
const TONES: Tone[] = [hex => hex, hex => blend(hex, '#ffffff', 0.72), hex => blend(hex, '#3b3324', 0.4, 0.84)]
const lighter = (hex: string, amount = 0.25) => blend(hex, '#ffffff', amount)
const darker = (hex: string, amount = 0.25) => blend(hex, '#000000', amount)

type Frame = 'foot' | 'horse' | 'cart' | 'brute' | 'beast'
type Head = 'bare' | 'bald' | 'hood' | 'cap' | 'hat' | 'helm' | 'great'
type Arm = UnitDef['weapon'] | 'lance' | 'crossbow' | 'pistol' | 'rifle' | 'hammer' | 'club'
interface Kit {
  frame: Frame
  /** 0 cloth, 1 padded, 2 half armour, 3 full plate. */
  armour: number
  head: Head
  arm: Arm
  plume?: boolean
  cape?: boolean
  torso?: 'skin' | 'drab' | 'dark'
  mount?: 'horse' | 'barded' | 'gryph'
  beast?: 'wild' | 'iron' | 'stone' | 'giant'
  cart?: 'light' | 'heavy' | 'wagon'
  variants: number
}
const SPECIAL: Partial<Record<UnitType, Partial<Kit>>> = {
  greatsword: { plume: true },
  halberd: { armour: 3 },
  crossbow: { arm: 'crossbow', head: 'cap' },
  militia: { torso: 'drab', head: 'cap' },
  flagellant: { torso: 'skin', head: 'bald', arm: 'club' },
  huntsmen: { torso: 'drab', head: 'hood', cape: true },
  freeCompany: { arm: 'pistol', head: 'hat' },
  musket: { head: 'hat' },
  longRifle: { arm: 'rifle', head: 'hat', cape: true },
  inquisitor: { torso: 'dark', head: 'hat', cape: true },
  captain: { head: 'great', plume: true, cape: true },
  warriorPriest: { head: 'bald', cape: true, arm: 'hammer' },
  general: { mount: 'barded', head: 'great', plume: true, cape: true },
  heavyCavalry: { mount: 'barded', arm: 'lance' },
  lightCavalry: { arm: 'lance', head: 'cap' },
  reiksguard: { mount: 'barded', arm: 'lance', head: 'great', plume: true },
  shieldCavalry: { mount: 'barded' },
  blackRose: { mount: 'barded', head: 'great', torso: 'dark', plume: true },
  horseArcher: { head: 'hood' },
  pistolier: { arm: 'pistol', head: 'hat' },
  outrider: { arm: 'rifle', head: 'hat' },
  demigryph: { mount: 'gryph', arm: 'lance', head: 'great', plume: true },
  demigryphHalberd: { mount: 'gryph', head: 'great', plume: true },
  chariot: { cart: 'light' },
  heavyChariot: { cart: 'heavy' },
  warWagon: { cart: 'wagon' },
  ogre: { arm: 'club' },
  monster: { beast: 'wild' },
  behemoth: { beast: 'iron' },
  stoneBeast: { beast: 'stone' },
  giant: { beast: 'giant', arm: 'club' },
}
const kits = new Map<UnitDef, Kit>()
function kitOf(def: UnitDef): Kit {
  let kit = kits.get(def)
  if (!kit) {
    const frame: Frame = def.category === 'chariot' ? 'cart' : def.category === 'monster' ? 'beast' : def.category === 'monstrousInfantry' ? 'brute' : def.category === 'cavalry' ? 'horse' : 'foot'
    const armour = def.armor >= 90 ? 3 : def.armor >= 45 ? 2 : def.armor >= 20 ? 1 : 0
    kit = {
      frame, armour, arm: def.weapon,
      head: armour >= 3 ? 'great' : armour === 2 ? 'helm' : armour === 1 ? 'cap' : def.weapon === 'bow' ? 'hood' : 'bare',
      variants: frame === 'horse' || frame === 'cart' ? 4 : 2,
      ...SPECIAL[def.type],
    }
    kits.set(def, kit)
  }
  return kit
}
/** How many looks a unit type has; bodies pick one by id. */
export function figureVariants(def: UnitDef): number { return kitOf(def).variants }

const bodyRadius = (def: UnitDef, zoom: number) => Math.max(2.5, def.radius * zoom)
/** How far ahead of its centre a body's weapon ends at rest, in pixels. */
function tipOf(def: UnitDef, kit: Kit, r: number, zoom: number): number {
  const reach = Math.max(3, def.reach * zoom)
  if (kit.frame === 'cart') return def.length * zoom / 2 + reach
  if (kit.frame === 'horse') return (kit.arm === 'lance' ? 2.3 : 1.5) * r + reach
  if (kit.frame === 'beast' || kit.frame === 'brute') return 1.25 * r + reach
  return (kit.arm === 'musket' || kit.arm === 'rifle' ? 1.9 : kit.arm === 'bow' || kit.arm === 'crossbow' ? 1.35 : 1) * r + reach
}
/** Half the side of the square that holds the figure at any heading, weapon swung and shadow cast; `bare` leaves the weapon out. */
export function figureExtent(def: UnitDef, zoom: number, bare = false): number {
  const kit = kitOf(def), r = bodyRadius(def, zoom)
  const body = kit.frame === 'cart' ? Math.hypot(def.length * zoom / 2 * 1.08, r * 1.1) : kit.frame === 'horse' ? 2.05 * r : kit.frame === 'foot' ? 1.4 * r : 1.8 * r
  return Math.ceil(Math.max(body + 0.55 * r, bare ? 0 : tipOf(def, kit, r, zoom) + 0.75 * r) + 3)
}
/**
 * Whether a figure can be painted as a body and a weapon apart (Pose.part). A long weapon is a thin line that makes
 * the figure's square several times the size of the man holding it; up close the body alone still fits a cached
 * glyph, and the weapon is cheap to draw over it.
 */
export function splitsWeapon(def: UnitDef): boolean {
  const frame = kitOf(def).frame
  return frame === 'foot' || frame === 'horse'
}

/** Shared drawing state for one figure. */
interface G {
  pen: Ctx; def: UnitDef; kit: Kit; col: Colours; tone: Tone; pose: Pose
  r: number; zoom: number
  /** Outline width. */
  lw: number
  /** Large enough on screen for trim, straps and faces. */
  fine: boolean
  ink: string
  /** Unit vector toward the light, in the figure's frame. */
  lx: number; ly: number
  /** The weapon is left out: it is painted apart (Pose.part). */
  bare: boolean
}

function oval(pen: Ctx, x: number, y: number, rx: number, ry: number, fill: string | null, stroke?: string | null, lw = 1, turn = 0): void {
  pen.beginPath()
  pen.ellipse(x, y, Math.max(0.3, rx), Math.max(0.3, ry), turn, 0, Math.PI * 2)
  if (fill) { pen.fillStyle = fill; pen.fill() }
  if (stroke) { pen.strokeStyle = stroke; pen.lineWidth = lw; pen.stroke() }
}
function stroke(pen: Ctx, colour: string, width: number, ...points: number[]): void {
  pen.strokeStyle = colour; pen.lineWidth = Math.max(0.5, width)
  pen.beginPath(); pen.moveTo(points[0], points[1])
  for (let i = 2; i < points.length; i += 2) pen.lineTo(points[i], points[i + 1])
  pen.stroke()
}
function shape(pen: Ctx, fill: string | null, outline: string | null, lw: number, ...points: number[]): void {
  pen.beginPath(); pen.moveTo(points[0], points[1])
  for (let i = 2; i < points.length; i += 2) pen.lineTo(points[i], points[i + 1])
  pen.closePath()
  if (fill) { pen.fillStyle = fill; pen.fill() }
  if (outline) { pen.strokeStyle = outline; pen.lineWidth = lw; pen.stroke() }
}
/** Points given along (u) and across (v) a weapon held at (hx, hy) and turned by `angle`. */
function held(hx: number, hy: number, angle: number, ...uv: number[]): number[] {
  const c = Math.cos(angle), s = Math.sin(angle), out: number[] = []
  for (let i = 0; i < uv.length; i += 2) out.push(hx + uv[i] * c - uv[i + 1] * s, hy + uv[i] * s + uv[i + 1] * c)
  return out
}
/** A vector fixed on screen, expressed in the frame of a pen turned to `heading`. */
function onScreen(heading: number, x: number, y: number): [number, number] {
  const c = Math.cos(heading), s = Math.sin(heading)
  return [x * c - y * s, x * s + y * c]
}

export function paintFigure(pen: Ctx, def: UnitDef, side: Side, zoom: number, pose: Pose): void {
  const kit = kitOf(def), r = bodyRadius(def, zoom)
  const tone = TONES[pose.flash ? 1 : pose.state === 'dead' ? 2 : 0]
  const [lx, ly] = onScreen(pose.heading, -0.55, -0.83)
  const g: G = { pen, def, kit, col: FACTION[side], tone, pose, r, zoom, lw: Math.max(0.6, Math.min(1.8, r * 0.1)), fine: r >= 4.2, ink: tone(INK), lx, ly, bare: pose.part === 'body' }
  pen.lineJoin = 'round'; pen.lineCap = 'round'
  if (pose.part === 'weapon') {
    // The same weapon, at the same place, that the whole figure would have had.
    if (pose.state !== 'up') return
    if (kit.frame === 'foot') weapon(g, 1, 0, 0, tipOf(def, kit, r, zoom))
    else if (kit.frame === 'horse') weapon(g, 0.66, -0.14 * r, 0, tipOf(def, kit, r, zoom) + 0.14 * r)
    return
  }
  if (pose.state !== 'up') { fallen(g); return }
  const long = kit.frame === 'cart' ? def.length * zoom / 2 : kit.frame === 'horse' ? 1.5 * r : kit.frame === 'beast' ? 1.2 * r : 0.66 * r
  const wide = kit.frame === 'horse' ? 0.68 * r : kit.frame === 'beast' ? 0.85 * r : r
  // Cast shadow: every body's falls the same way on screen, longer for taller bodies.
  const [sx, sy] = onScreen(pose.heading, 0.22 * r, 0.44 * r)
  oval(pen, sx, sy, long * 1.02, wide * 0.98, 'rgba(8,12,6,0.3)')
  if (pose.selected) oval(pen, 0, 0, long + 0.34 * r, wide + 0.3 * r, 'rgba(255,224,130,0.2)', '#ffe08a', Math.max(1.1, r * 0.15))
  if (kit.frame === 'foot') foot(g, 1, 0, 0, tipOf(def, kit, r, zoom))
  else if (kit.frame === 'horse') mounted(g)
  else if (kit.frame === 'cart') cart(g)
  else if (kit.frame === 'brute') brute(g)
  else beast(g)
  if (pose.wounded) oval(pen, 0, 0, long + 0.2 * r, wide + 0.16 * r, null, 'rgba(226,84,60,0.85)', Math.max(1, r * 0.08))
}

/** A man seen from above, scaled by `k` and standing at (ox, oy): used for infantry, riders and cart crews. */
function foot(g: G, k: number, ox: number, oy: number, tip: number): void {
  const { pen, kit, col, tone, pose, ink, lw, def } = g, r = g.r * k, fine = g.fine && r >= 3.2
  const rider = k !== 1
  if (!g.fine && !rider) {
    // From far off a man is a dab of his army's colour with a glint for a head; outlines would only muddy him.
    const dab = tone(pose.variant % 2 ? col.far : lighter(col.far, 0.1))
    const base = kit.torso === 'skin' ? tone(SKIN[pose.variant % 4]) : kit.torso === 'drab' ? tone(DRAB[pose.variant % 4]) : kit.torso === 'dark' ? tone('#2c2826') : dab
    oval(pen, ox, oy, 0.74 * r, r, base, tone(col.clothDark), 0.5)
    if (kit.torso) oval(pen, ox - 0.12 * r, oy, 0.34 * r, 0.92 * r, dab)
    if (def.shieldBlock > 0) oval(pen, ox + 0.5 * r, oy - 0.5 * r, 0.3 * r, 0.42 * r, tone(col.trim))
    if (tip > 0 && !g.bare) weapon(g, k, ox, oy, tip)
    oval(pen, ox + 0.1 * r, oy, 0.4 * r, 0.4 * r, kit.head === 'helm' || kit.head === 'great' ? tone(col.metal) : kit.head === 'hat' ? tone(col.hat) : kit.head === 'hood' ? tone(col.clothDark) : kit.head === 'cap' ? tone(LEATHER) : tone(SKIN[pose.variant % 4]))
    return
  }
  const cloth = tone([col.cloth, lighter(col.cloth, 0.1), darker(col.cloth, 0.12), col.clothDark][pose.variant % 4])
  // Whatever a man wears, enough of his army's colour shows from above to tell the sides apart at a glance.
  const torso = kit.torso === 'skin' ? tone(SKIN[pose.variant % 4]) : kit.torso === 'drab' ? tone(DRAB[pose.variant % 4]) : kit.torso === 'dark' ? tone('#2c2826') : cloth
  if (!rider && pose.step >= 0) {
    const stride = Math.sin(pose.step / STEPS * Math.PI * 2) * r * 0.5
    oval(pen, ox + stride + 0.08 * r, oy - 0.36 * r, 0.36 * r, 0.22 * r, tone(BOOT))
    oval(pen, ox - stride + 0.08 * r, oy + 0.36 * r, 0.36 * r, 0.22 * r, tone(BOOT))
  }
  if (kit.cape) {
    const sway = pose.step >= 0 ? Math.sin(pose.step / STEPS * Math.PI * 2) * 0.12 * r : 0
    const cape = kit.torso === 'drab' ? tone('#4d5a34') : kit.torso === 'dark' ? cloth : tone(col.clothDark)
    shape(pen, cape, ink, lw, ox - 0.1 * r, oy - 0.84 * r, ox - 1.0 * r, oy - 0.66 * r + sway, ox - 1.3 * r, oy + sway, ox - 1.0 * r, oy + 0.66 * r + sway, ox - 0.1 * r, oy + 0.84 * r)
  }
  if (!rider && (def.weapon === 'bow') && fine) {
    // Quiver across the back.
    stroke(pen, tone(LEATHER), 0.3 * r, ox - 0.7 * r, oy + 0.5 * r, ox - 0.25 * r, oy + 0.15 * r)
    stroke(pen, tone('#efe8d4'), 0.1 * r, ox - 0.78 * r, oy + 0.6 * r, ox - 0.7 * r, oy + 0.5 * r)
  }
  oval(pen, ox, oy, 0.6 * r, 0.98 * r, torso, ink, lw)
  if (!fine && kit.torso) oval(pen, ox - 0.1 * r, oy, 0.3 * r, 0.9 * r, cloth)
  if (fine) {
    // Light catches the shoulder that faces it.
    oval(pen, ox + g.lx * 0.18 * r, oy + g.ly * 0.34 * r, 0.34 * r, 0.56 * r, lighter(torso, 0.16))
    if (kit.torso) stroke(pen, cloth, 0.34 * r, ox - 0.36 * r, oy - 0.66 * r, ox + 0.36 * r, oy + 0.66 * r)
    else stroke(pen, tone(col.trim), (kit.armour >= 3 ? 0.24 : 0.16) * r, ox - 0.5 * r, oy, ox + 0.5 * r, oy)
    const pad = kit.armour >= 3 ? tone(col.metal) : kit.torso ? cloth : tone(col.clothDark)
    oval(pen, ox + 0.02 * r, oy - 0.76 * r, 0.29 * r, 0.26 * r, pad, ink, lw * 0.8)
    oval(pen, ox + 0.02 * r, oy + 0.76 * r, 0.29 * r, 0.26 * r, pad, ink, lw * 0.8)
  }
  if (def.shieldBlock > 0) {
    // Shield on the left arm, swung across the front: seen from above it is a thick curved bar of the army's colour.
    const sxx = ox + 0.56 * r, syy = oy - 0.5 * r
    oval(pen, sxx, syy, 0.24 * r, 0.6 * r, tone(col.cloth), ink, lw, 0.5)
    if (fine) { oval(pen, sxx, syy, 0.1 * r, 0.44 * r, null, tone(col.trim), Math.max(0.6, 0.08 * r), 0.5); oval(pen, sxx + 0.03 * r, syy, 0.1 * r, 0.1 * r, tone(col.metalLight)) }
  }
  if (tip > 0 && !g.bare) weapon(g, k, ox, oy, tip)
  head(g, r, ox + 0.08 * r, oy, fine)
}

function head(g: G, r: number, x: number, y: number, fine: boolean): void {
  const { pen, kit, col, tone, pose, ink, lw } = g
  const hx = x + g.lx * 0.13 * r, hy = y + g.ly * 0.13 * r
  if (kit.plume && fine) shape(pen, tone(col.plume), ink, lw * 0.7, x - 0.1 * r, y - 0.16 * r, x - 0.95 * r, y - 0.08 * r, x - 1.08 * r, y + 0.04 * r, x - 0.1 * r, y + 0.16 * r)
  switch (kit.head) {
    case 'great':
      oval(pen, x, y, 0.44 * r, 0.42 * r, tone(col.metal), ink, lw)
      if (fine) { oval(pen, hx, hy, 0.17 * r, 0.15 * r, tone(col.metalLight)); stroke(pen, tone(col.metalDark), 0.08 * r, x + 0.22 * r, y - 0.26 * r, x + 0.22 * r, y + 0.26 * r) }
      break
    case 'helm':
      oval(pen, x, y, 0.42 * r, 0.4 * r, tone(col.metal), ink, lw)
      if (fine) { oval(pen, x, y, 0.42 * r, 0.4 * r, null, tone(col.metalDark), 0.1 * r); oval(pen, hx, hy, 0.16 * r, 0.14 * r, tone(col.metalLight)) }
      break
    case 'hat':
      oval(pen, x, y, 0.52 * r, 0.5 * r, tone(col.hat), ink, lw)
      if (fine) { oval(pen, x - 0.03 * r, y, 0.26 * r, 0.25 * r, lighter(tone(col.hat), 0.18)); stroke(pen, tone(col.clothLight), 0.16 * r, x - 0.06 * r, y + 0.26 * r, x - 0.56 * r, y + 0.5 * r, x - 0.86 * r, y + 0.3 * r) }
      break
    case 'cap':
      oval(pen, x, y, 0.4 * r, 0.38 * r, tone(LEATHER), ink, lw)
      if (fine) oval(pen, hx, hy, 0.15 * r, 0.13 * r, tone(lighter(LEATHER, 0.3)))
      break
    case 'hood':
      shape(pen, tone(kit.torso === 'drab' ? col.cloth : col.clothDark), ink, lw, x + 0.4 * r, y, x + 0.1 * r, y - 0.4 * r, x - 0.4 * r, y - 0.3 * r, x - 0.66 * r, y, x - 0.4 * r, y + 0.3 * r, x + 0.1 * r, y + 0.4 * r)
      if (fine) oval(pen, x + 0.2 * r, y, 0.14 * r, 0.2 * r, tone(SKIN[pose.variant % 4]))
      break
    default:
      oval(pen, x, y, 0.37 * r, 0.36 * r, tone(SKIN[pose.variant % 4]), ink, lw)
      if (kit.head === 'bare') oval(pen, x - 0.1 * r, y, 0.3 * r, 0.33 * r, tone(['#3a2a1e', '#5a3d22', '#221c18', '#7a6240'][pose.variant % 4]))
      else oval(pen, x, y, 0.37 * r, 0.36 * r, null, tone(col.cloth), Math.max(0.8, 0.14 * r))
  }
}

/** The windup carries a weapon back, then through: 0 at rest, +1 fully drawn, about -0.9 at the end of the blow. */
function drawn(swing: number): number {
  return swing < 0 ? 0 : swing < 0.6 ? swing / 0.6 : 1 - (swing - 0.6) / 0.4 * 1.9
}

/** `tip` is how far ahead of (ox, oy) the weapon ends at rest. */
function weapon(g: G, k: number, ox: number, oy: number, tip: number): void {
  const { pen, kit, col, tone, pose, ink } = g, r = g.r * k, fine = g.fine && r >= 3.2
  const wind = drawn(pose.swing), steel = tone(g.fine ? STEEL : '#aeb6bc'), wood = tone(WOOD), thin = g.fine ? 1 : 0.7
  const edge = fine ? g.lw * 1.6 : 0
  const blade = (hx: number, hy: number, angle: number, from: number, to: number, width: number) => {
    if (edge) stroke(pen, ink, width + edge, ...held(hx, hy, angle, from, 0, to, 0))
    stroke(pen, steel, width, ...held(hx, hy, angle, from, 0, to, 0))
  }
  switch (kit.arm) {
    case 'spear': case 'lance': case 'halberd': {
      const lance = kit.arm === 'lance', hx = ox + 0.25 * r, hy = oy + 0.66 * r
      const angle = kit.arm === 'halberd' ? -0.07 + wind * 0.85 : -0.06, push = kit.arm === 'halberd' ? 0 : -wind * 0.55 * r
      const length = tip - 0.25 * r + push, butt = (lance ? -0.7 : -0.95) * r + push
      const shaft = Math.max(thin, (lance ? 0.2 : 0.15) * r)
      if (edge) stroke(pen, ink, shaft + edge, ...held(hx, hy, angle, butt, 0, length, 0))
      stroke(pen, lance ? tone('#e6d9b8') : wood, shaft, ...held(hx, hy, angle, butt, 0, length - 0.3 * r, 0))
      if (kit.arm === 'halberd') shape(pen, steel, fine ? ink : null, g.lw * 0.8, ...held(hx, hy, angle, length - 1.0 * r, -0.04 * r, length - 0.82 * r, -0.55 * r, length - 0.34 * r, -0.46 * r, length - 0.22 * r, -0.04 * r))
      shape(pen, steel, fine ? ink : null, g.lw * 0.8, ...held(hx, hy, angle, length - 0.6 * r, -0.17 * r, length + 0.1 * r, 0, length - 0.6 * r, 0.17 * r))
      if (lance && fine) shape(pen, tone(col.clothLight), ink, g.lw * 0.7, ...held(hx, hy, angle, length - 0.75 * r, 0.1 * r, length - 1.6 * r, 0.42 * r, length - 1.45 * r, 0.1 * r))
      break
    }
    case 'sword': {
      const hx = ox + 0.5 * r, hy = oy + 0.7 * r, angle = -0.2 + wind * 1.05, length = Math.max(0.95 * r, tip - 0.5 * r)
      blade(hx, hy, angle, 0.14 * r, length, Math.max(thin, 0.13 * r))
      if (fine) stroke(pen, tone(col.trim), 0.13 * r, ...held(hx, hy, angle, 0.14 * r, -0.28 * r, 0.14 * r, 0.28 * r))
      break
    }
    case 'greatsword': case 'hammer': case 'club': {
      const hx = ox + 0.52 * r, hy = oy + 0.32 * r, angle = -0.42 + wind * 1.25, length = Math.max(1.5 * r, tip - 0.3 * r)
      if (kit.arm === 'greatsword') {
        blade(hx, hy, angle, 0.2 * r, length, Math.max(thin * 1.2, 0.19 * r))
        if (fine) stroke(pen, tone(col.trim), 0.15 * r, ...held(hx, hy, angle, 0.2 * r, -0.4 * r, 0.2 * r, 0.4 * r))
      } else {
        if (edge) stroke(pen, ink, 0.18 * r + edge, ...held(hx, hy, angle, 0, 0, length, 0))
        stroke(pen, wood, Math.max(thin, 0.18 * r), ...held(hx, hy, angle, 0, 0, length, 0))
        if (kit.arm === 'hammer') shape(pen, tone(col.metal), ink, g.lw, ...held(hx, hy, angle, length - 0.5 * r, -0.42 * r, length + 0.1 * r, -0.42 * r, length + 0.1 * r, 0.42 * r, length - 0.5 * r, 0.42 * r))
        else stroke(pen, tone(darker(WOOD, 0.3)), Math.max(1.6, 0.42 * r), ...held(hx, hy, angle, length * 0.55, 0, length, 0))
      }
      break
    }
    case 'bow': {
      // Held out in the left hand; the stave bows toward the enemy.
      const cx = ox + 1.08 * r, cy = oy - 0.2 * r, rho = 1.2 * r, half = 0.92
      if (edge) { pen.strokeStyle = ink; pen.lineWidth = Math.max(1, 0.17 * r) + edge; pen.beginPath(); pen.arc(cx - rho, cy, rho, -half, half); pen.stroke() }
      pen.strokeStyle = tone('#d2ad72'); pen.lineWidth = Math.max(thin, 0.17 * r)
      pen.beginPath(); pen.arc(cx - rho, cy, rho, -half, half); pen.stroke()
      if (fine) stroke(pen, tone('#f2ecd9'), Math.max(0.6, 0.06 * r), cx - rho + Math.cos(half) * rho, cy - Math.sin(half) * rho, cx - rho + Math.cos(half) * rho, cy + Math.sin(half) * rho)
      break
    }
    case 'crossbow': {
      const stock = Math.max(thin, 0.2 * r)
      if (edge) stroke(pen, ink, stock + edge, ox + 0.1 * r, oy + 0.25 * r, ox + 1.25 * r, oy + 0.12 * r)
      stroke(pen, wood, stock, ox + 0.1 * r, oy + 0.25 * r, ox + 1.25 * r, oy + 0.12 * r)
      pen.strokeStyle = tone(IRON); pen.lineWidth = Math.max(1, 0.13 * r)
      pen.beginPath(); pen.moveTo(ox + 0.92 * r, oy - 0.5 * r); pen.quadraticCurveTo(ox + 1.36 * r, oy + 0.13 * r, ox + 0.92 * r, oy + 0.76 * r); pen.stroke()
      break
    }
    case 'musket': case 'rifle': case 'pistol': {
      const from = kit.arm === 'pistol' ? 0.45 : -0.3, to = kit.arm === 'pistol' ? 1.3 * r : Math.max(1.6 * r, tip + (kit.arm === 'rifle' ? 0.4 * r : 0))
      const y0 = oy + 0.56 * r, y1 = oy + 0.36 * r, mid = from * r + (to - from * r) * 0.45, width = Math.max(thin, 0.2 * r)
      if (edge) stroke(pen, ink, width + edge, ox + from * r, y0, ox + to, y1)
      stroke(pen, tone('#7b5733'), width, ox + from * r, y0, ox + mid, y0 + (y1 - y0) * 0.45)
      stroke(pen, tone(IRON), width * 0.72, ox + mid, y0 + (y1 - y0) * 0.45, ox + to, y1)
      break
    }
  }
}

function mounted(g: G): void {
  const { pen, r, kit, col, tone, pose, ink, lw, fine, def } = g
  const gryph = kit.mount === 'gryph', barded = kit.mount === 'barded'
  const coat = tone(gryph ? ['#b8904e', '#a47c40', '#c49c5c', '#9a7238'][pose.variant % 4] : COATS[(pose.variant * 2 + (def.type.length % 3)) % COATS.length])
  const phase = pose.step < 0 ? 0 : pose.step / STEPS * Math.PI * 2, moving = pose.step >= 0
  if (!fine) {
    // Far view: horse, a broad patch of the army's colour over its back, and the rider's head.
    const bob = moving ? Math.sin(phase) * 0.1 * r : 0
    oval(pen, -0.12 * r, 0, 1.28 * r, 0.6 * r, coat, darker(coat, 0.35), 0.5)
    oval(pen, 1.42 * r + bob, 0, 0.5 * r, 0.26 * r, gryph ? tone('#f1ecdf') : coat)
    oval(pen, -0.2 * r, 0, barded ? 0.95 * r : 0.62 * r, 0.6 * r, tone(kit.torso === 'dark' ? '#2c2826' : col.far))
    if (kit.torso === 'dark') oval(pen, -0.2 * r, 0, 0.3 * r, 0.56 * r, tone(col.far))
    if (!g.bare) weapon(g, 0.66, -0.14 * r, 0, tipOf(def, kit, r, g.zoom) + 0.14 * r)
    oval(pen, -0.08 * r, 0, 0.3 * r, 0.3 * r, kit.head === 'hat' ? tone(col.hat) : kit.head === 'hood' ? tone(col.clothDark) : tone(col.metal))
    return
  }
  // Legs gather under the body and reach out again; from above only the hooves show past the barrel.
  if (moving) {
    const reach = Math.sin(phase) * 0.42 * r, gather = Math.cos(phase) * 0.42 * r
    for (const [x, y, d] of [[0.82, -0.36, reach], [0.82, 0.36, gather], [-0.95, -0.36, -gather], [-0.95, 0.36, -reach]] as const)
      oval(pen, x * r + d, y * r, 0.26 * r, 0.15 * r, gryph ? tone('#d9b04a') : darker(coat, 0.4))
  }
  const sway = moving ? Math.sin(phase * 2) * 0.16 * r : 0
  stroke(pen, tone(gryph ? '#8a6a34' : '#2a221c'), Math.max(1, 0.2 * r), -1.2 * r, 0, -1.62 * r, sway, -1.86 * r, sway * 1.6)
  oval(pen, -0.12 * r, 0, 1.28 * r, 0.6 * r, coat, ink, lw)
  // Neck and head.
  const nod = moving ? Math.sin(phase) * 0.07 * r : 0
  shape(pen, coat, ink, lw, 0.86 * r, -0.3 * r, 1.5 * r + nod, -0.17 * r, 1.5 * r + nod, 0.17 * r, 0.86 * r, 0.3 * r)
  if (gryph) {
    oval(pen, 1.08 * r, 0, 0.5 * r, 0.52 * r, tone('#ece6d6'), ink, lw)
    oval(pen, 1.62 * r + nod, 0, 0.36 * r, 0.27 * r, tone('#f4efe2'), ink, lw)
    shape(pen, tone('#e2aa30'), ink, lw * 0.8, 1.86 * r + nod, -0.15 * r, 2.2 * r + nod, 0, 1.86 * r + nod, 0.15 * r)
  } else {
    oval(pen, 1.66 * r + nod, 0, 0.36 * r, 0.21 * r, coat, ink, lw)
    if (fine) stroke(pen, tone('#231d18'), 0.13 * r, 0.9 * r, 0, 1.46 * r + nod, 0)
  }
  if (fine) oval(pen, -0.12 * r + g.lx * 0.3 * r, g.ly * 0.2 * r, 0.8 * r, 0.3 * r, lighter(coat, 0.14))
  if (barded) {
    // Caparison over quarters and chest, trimmed in the army's second colour.
    const cloth = tone(kit.torso === 'dark' ? '#2c2826' : col.cloth)
    shape(pen, cloth, ink, lw, -1.3 * r, -0.5 * r, -0.5 * r, -0.64 * r, -0.5 * r, 0.64 * r, -1.3 * r, 0.5 * r)
    shape(pen, cloth, ink, lw, 0.36 * r, -0.64 * r, 0.98 * r, -0.5 * r, 0.98 * r, 0.5 * r, 0.36 * r, 0.64 * r)
    if (fine) {
      stroke(pen, tone(col.trim), 0.11 * r, -1.22 * r, -0.44 * r, -1.22 * r, 0.44 * r)
      stroke(pen, tone(col.trim), 0.11 * r, 0.92 * r, -0.44 * r, 0.92 * r, 0.44 * r)
      if (!gryph) oval(pen, 1.6 * r + nod, 0, 0.22 * r, 0.15 * r, tone(col.metal))
    }
  } else if (fine) {
    // A broad saddle cloth carries the army's colour on an unarmoured horse.
    shape(pen, tone(col.cloth), ink, lw * 0.8, -0.86 * r, -0.58 * r, 0.42 * r, -0.58 * r, 0.42 * r, 0.58 * r, -0.86 * r, 0.58 * r)
    stroke(pen, tone(col.trim), 0.09 * r, -0.78 * r, -0.5 * r, -0.78 * r, 0.5 * r)
  }
  else oval(pen, -0.2 * r, 0, 0.62 * r, 0.56 * r, tone(col.cloth))
  // The rider's weapon reaches as far as the mount lets it, not as far as a man on foot.
  foot(g, 0.66, -0.14 * r, 0, tipOf(def, kit, r, g.zoom) + 0.14 * r)
}

function cart(g: G): void {
  const { pen, r, kit, col, tone, pose, ink, lw, fine, def, zoom } = g
  const h = def.length * zoom / 2, heavy = kit.cart === 'heavy', wagon = kit.cart === 'wagon'
  const phase = pose.step < 0 ? 0 : pose.step / STEPS * Math.PI * 2, moving = pose.step >= 0
  // Team of two.
  for (const s of [-1, 1]) {
    const coat = tone(COATS[(pose.variant + (s > 0 ? 3 : 0)) % COATS.length]), y = s * 0.4 * r, nod = moving ? Math.sin(phase + s) * 0.04 * h : 0
    if (moving) for (const [x, d] of [[0.82, Math.sin(phase + s)], [0.2, -Math.sin(phase + s)]] as const) oval(pen, x * h + d * 0.1 * h, y + s * 0.2 * r, 0.09 * h, 0.07 * r, tone('#2a211a'))
    oval(pen, 0.52 * h, y, 0.36 * h, 0.23 * r, coat, ink, lw)
    shape(pen, coat, ink, lw, 0.78 * h, y - 0.12 * r, 0.98 * h + nod, y - 0.07 * r, 0.98 * h + nod, y + 0.07 * r, 0.78 * h, y + 0.12 * r)
    oval(pen, 1.02 * h + nod, y, 0.1 * h, 0.09 * r, coat, ink, lw)
    if (heavy) shape(pen, tone(col.cloth), ink, lw, 0.24 * h, y - 0.25 * r, 0.7 * h, y - 0.25 * r, 0.7 * h, y + 0.25 * r, 0.24 * h, y + 0.25 * r)
    else if (fine) stroke(pen, tone(col.cloth), 0.12 * r, 0.5 * h, y - 0.22 * r, 0.5 * h, y + 0.22 * r)
  }
  stroke(pen, tone('#5a4128'), Math.max(1, 0.08 * r), -0.1 * h, 0, 0.86 * h, 0)
  stroke(pen, tone('#5a4128'), Math.max(1, 0.07 * r), 0.8 * h, -0.5 * r, 0.8 * h, 0.5 * r)
  // Wheels turn under the bed.
  const wheelX = wagon ? [-0.72, -0.28] : [-0.5]
  for (const wx of wheelX) for (const s of [-1, 1]) {
    shape(pen, tone('#33281d'), ink, lw, (wx - 0.2) * h, s * 0.74 * r, (wx + 0.2) * h, s * 0.74 * r, (wx + 0.2) * h, s * 0.96 * r, (wx - 0.2) * h, s * 0.96 * r)
    if (fine) { const spoke = wx * h + (moving ? Math.cos(phase) : 0.4) * 0.14 * h; stroke(pen, tone('#8a6c46'), 0.05 * r, spoke, s * 0.76 * r, spoke, s * 0.94 * r) }
    if (heavy) shape(pen, tone(STEEL), ink, lw * 0.7, wx * h - 0.07 * h, s * 0.96 * r, wx * h + 0.3 * h, s * 1.06 * r, wx * h + 0.07 * h, s * 0.96 * r)
  }
  const back = -0.98 * h, front = wagon ? 0.02 * h : -0.12 * h, half = (wagon ? 0.72 : 0.6) * r
  shape(pen, tone(heavy ? '#5d4a36' : '#8a6b45'), ink, lw, back, -half, front, -half, front, half, back, half)
  if (wagon) {
    // A roofed gun wagon: canvas in the army's colour, loopholes down both sides.
    shape(pen, tone(col.cloth), ink, lw, back + 0.06 * h, -half * 0.82, front - 0.06 * h, -half * 0.82, front - 0.06 * h, half * 0.82, back + 0.06 * h, half * 0.82)
    stroke(pen, tone(col.trim), 0.07 * r, back + 0.06 * h, 0, front - 0.06 * h, 0)
    for (const s of [-1, 1]) for (const x of [-0.8, -0.5, -0.2]) stroke(pen, tone(IRON), Math.max(1, 0.09 * r), x * h, s * half * 0.9, x * h + 0.04 * h, s * (half + 0.3 * r))
  } else {
    if (fine) for (const x of [-0.75, -0.5, -0.28]) stroke(pen, tone(darker('#8a6b45', 0.3)), 0.04 * r, x * h, -half, x * h, half)
    stroke(pen, tone(heavy ? col.metal : col.cloth), Math.max(1, 0.12 * r), back, -half, back, half, front, half)
    stroke(pen, tone(heavy ? col.metal : col.cloth), Math.max(1, 0.12 * r), back, -half, front, -half)
    // Driver forward, fighting man behind him.
    const crew = 0.32 / def.radius
    foot({ ...g, pose: { ...pose, step: -1, swing: -1 } }, crew * 0.92, -0.3 * h, -0.22 * r, 0)
    foot(g, crew, -0.68 * h, 0.2 * r, r * crew * 2.6)
  }
  // A pennon at the tail marks the side from far off.
  const fly = moving ? Math.sin(phase) * 0.12 * r : 0
  stroke(pen, tone('#3a2c1e'), Math.max(0.8, 0.05 * r), back, 0, back - 0.02 * h, 0)
  shape(pen, tone(col.cloth), ink, lw * 0.8, back, -0.1 * r, back - 0.34 * h, -0.2 * r + fly, back - 0.24 * h, fly, back - 0.34 * h, 0.2 * r + fly, back, 0.1 * r)
}

/** Monstrous infantry: a hulking two-legged brute, twice a man's breadth. */
function brute(g: G): void {
  const { pen, r, kit, col, tone, pose, ink, lw, fine } = g
  const hide = tone(HIDES[pose.variant % 4]), plated = kit.armour >= 2
  if (pose.step >= 0) {
    const stride = Math.sin(pose.step / STEPS * Math.PI * 2) * r * 0.42
    oval(pen, stride + 0.1 * r, -0.4 * r, 0.4 * r, 0.26 * r, tone('#3a2f24'))
    oval(pen, -stride + 0.1 * r, 0.4 * r, 0.4 * r, 0.26 * r, tone('#3a2f24'))
  }
  // Sash down the back, in the army's colour.
  shape(pen, tone(col.cloth), ink, lw, -0.5 * r, -0.36 * r, -1.02 * r, -0.26 * r, -1.12 * r, 0, -1.02 * r, 0.26 * r, -0.5 * r, 0.36 * r)
  oval(pen, 0, 0, 0.72 * r, 1.0 * r, plated ? tone(col.metal) : hide, ink, lw)
  if (fine) oval(pen, g.lx * 0.2 * r, g.ly * 0.34 * r, 0.42 * r, 0.6 * r, lighter(plated ? tone(col.metal) : hide, 0.14))
  stroke(pen, tone(col.cloth), 0.2 * r, -0.4 * r, -0.72 * r, 0.4 * r, 0.72 * r)
  const wind = drawn(pose.swing)
  // Arms: the left one braces forward, the right one carries the blow.
  stroke(pen, ink, 0.44 * r + lw * 1.6, 0.1 * r, -0.86 * r, 0.82 * r, -0.62 * r)
  stroke(pen, hide, 0.44 * r, 0.1 * r, -0.86 * r, 0.82 * r, -0.62 * r)
  const fx = 0.86 * r * Math.cos(0.5 + wind * 0.9), fy = 0.2 * r + 0.86 * r * Math.sin(0.5 + wind * 0.9)
  stroke(pen, ink, 0.44 * r + lw * 1.6, 0.1 * r, 0.86 * r, fx, fy)
  stroke(pen, hide, 0.44 * r, 0.1 * r, 0.86 * r, fx, fy)
  for (const s of [-1, 1]) oval(pen, 0.04 * r, s * 0.8 * r, 0.4 * r, 0.36 * r, plated ? tone(col.metal) : darker(hide, 0.14), ink, lw)
  if (plated && fine) for (const s of [-1, 1]) oval(pen, 0.04 * r + g.lx * 0.1 * r, s * 0.8 * r + g.ly * 0.1 * r, 0.16 * r, 0.14 * r, tone(col.metalLight))
  weapon(g, 1, 0.24 * r, 0.29 * r, tipOf(g.def, kit, r, g.zoom) - 0.24 * r)
  oval(pen, 0.26 * r, 0, 0.32 * r, 0.3 * r, plated ? tone(col.metal) : hide, ink, lw)
  if (fine && !plated) oval(pen, 0.2 * r, 0, 0.22 * r, 0.26 * r, tone('#2c241d'))
}

function beast(g: G): void {
  const { pen, r, kit, col, tone, pose, ink, lw, fine } = g
  const phase = pose.step < 0 ? 0 : pose.step / STEPS * Math.PI * 2, moving = pose.step >= 0
  const wind = drawn(pose.swing)
  if (kit.beast === 'giant') {
    // A giant is a man at ogre scale and half again: bare shoulders, a rag of the army's cloth, a tree for a club.
    const skin = tone(SKIN[(pose.variant + 1) % 4])
    if (moving) { const s = Math.sin(phase) * 0.36 * r; oval(pen, s, -0.34 * r, 0.36 * r, 0.24 * r, skin, ink, lw); oval(pen, -s, 0.34 * r, 0.36 * r, 0.24 * r, skin, ink, lw) }
    shape(pen, tone(col.cloth), ink, lw, -0.3 * r, -0.5 * r, -0.86 * r, -0.4 * r, -1.0 * r, 0.1 * r, -0.8 * r, 0.46 * r, -0.3 * r, 0.5 * r)
    oval(pen, 0, 0, 0.6 * r, 0.9 * r, skin, ink, lw)
    oval(pen, g.lx * 0.16 * r, g.ly * 0.3 * r, 0.36 * r, 0.54 * r, lighter(skin, 0.12))
    stroke(pen, tone(col.cloth), 0.16 * r, -0.36 * r, -0.62 * r, 0.36 * r, 0.62 * r)
    stroke(pen, ink, 0.36 * r + lw * 1.6, 0.08 * r, -0.76 * r, 0.74 * r, -0.6 * r); stroke(pen, skin, 0.36 * r, 0.08 * r, -0.76 * r, 0.74 * r, -0.6 * r)
    const a = 0.35 + wind * 1.1, hx = 0.08 * r + Math.cos(a) * 0.7 * r, hy = 0.76 * r + Math.sin(a) * 0.3 * r
    stroke(pen, ink, 0.36 * r + lw * 1.6, 0.08 * r, 0.76 * r, hx, hy); stroke(pen, skin, 0.36 * r, 0.08 * r, 0.76 * r, hx, hy)
    const club = held(hx, hy, -0.35 + wind * 1.3, 0, 0, 1.25 * r, 0)
    stroke(pen, ink, 0.3 * r + lw * 1.6, ...club); stroke(pen, tone('#6b4d2e'), 0.3 * r, ...club)
    stroke(pen, tone('#4f3820'), 0.44 * r, ...held(hx, hy, -0.35 + wind * 1.3, 0.75 * r, 0, 1.25 * r, 0))
    oval(pen, 0.2 * r, 0, 0.3 * r, 0.29 * r, skin, ink, lw)
    oval(pen, 0.1 * r, 0, 0.24 * r, 0.27 * r, tone('#3a2a1e'))
    return
  }
  const stone = kit.beast === 'stone', iron = kit.beast === 'iron'
  const hide = tone(stone ? ['#8c8d86', '#7e8078'][pose.variant % 2] : iron ? ['#6f6a62', '#7b746a'][pose.variant % 2] : ['#5d4631', '#6b5038'][pose.variant % 2])
  const rawHide = stone ? '#8c8d86' : iron ? '#6f6a62' : '#5d4631'
  // Four legs splay from the barrel; the clawed feet reach and gather in pairs.
  const reach = moving ? Math.sin(phase) * 0.2 * r : 0
  for (const [x, y, d] of [[0.62, -0.74, reach], [0.62, 0.74, -reach], [-0.6, -0.72, -reach], [-0.6, 0.72, reach]] as const) {
    stroke(pen, ink, 0.3 * r + lw * 1.6, x * r * 0.7, y * r * 0.6, x * r + d, y * r)
    stroke(pen, hide, 0.3 * r, x * r * 0.7, y * r * 0.6, x * r + d, y * r)
    if (fine && !stone) for (const c of [-0.12, 0, 0.12]) stroke(pen, tone('#e8dfc6'), 0.05 * r, x * r + d + 0.06 * r, y * r + c * r, x * r + d + 0.26 * r, y * r + c * r * 1.6)
  }
  const sway = moving ? Math.sin(phase) * 0.2 * r : 0.08 * r
  stroke(pen, ink, 0.24 * r + lw * 1.6, -0.9 * r, 0, -1.35 * r, sway, -1.66 * r, sway * 1.8)
  stroke(pen, hide, 0.24 * r, -0.9 * r, 0, -1.35 * r, sway, -1.66 * r, sway * 1.8)
  oval(pen, -0.08 * r, 0, 1.02 * r, 0.66 * r, hide, ink, lw)
  oval(pen, -0.08 * r + g.lx * 0.26 * r, g.ly * 0.2 * r, 0.66 * r, 0.36 * r, lighter(hide, 0.12))
  if (stone) {
    // Slabs of rock, mossed in the seams.
    for (const [x, y, w] of [[-0.6, -0.2, 0.34], [-0.2, 0.22, 0.4], [0.2, -0.24, 0.36], [-0.3, -0.36, 0.26], [0.36, 0.2, 0.3]] as const)
      shape(pen, tone(lighter(rawHide, 0.1 + (x + 1) * 0.08)), ink, lw * 0.7, (x - w * 0.5) * r, (y - w * 0.3) * r, (x + w * 0.4) * r, (y - w * 0.4) * r, (x + w * 0.5) * r, (y + w * 0.3) * r, (x - w * 0.3) * r, (y + w * 0.42) * r)
    if (fine) for (const [x, y] of [[-0.5, 0.2], [0.1, 0], [-0.1, -0.42], [0.5, -0.05]] as const) oval(pen, x * r, y * r, 0.12 * r, 0.07 * r, tone('#5f7a3c'))
  } else if (iron) {
    // Riveted plates along the spine.
    for (const x of [-0.72, -0.36, 0, 0.36]) {
      shape(pen, tone(col.metal), ink, lw * 0.8, x * r, -0.4 * r, (x + 0.3) * r, -0.34 * r, (x + 0.3) * r, 0.34 * r, x * r, 0.4 * r)
      if (fine) for (const s of [-1, 1]) oval(pen, (x + 0.15) * r, s * 0.26 * r, 0.04 * r, 0.04 * r, tone(col.metalDark))
    }
  } else {
    // A shaggy ridge of darker hair.
    for (let i = 0; i < 9; i++) stroke(pen, tone('#3a2b1d'), 0.1 * r, (-0.8 + i * 0.18) * r, 0, (-0.94 + i * 0.18) * r, (i % 2 ? 0.22 : -0.22) * r)
  }
  // Harness in the army's colour, so it reads from across the field.
  stroke(pen, tone(col.cloth), 0.2 * r, 0.2 * r, -0.6 * r, 0.2 * r, 0.6 * r)
  stroke(pen, tone(col.trim), 0.06 * r, 0.2 * r, -0.6 * r, 0.2 * r, 0.6 * r)
  shape(pen, tone(col.cloth), ink, lw, -0.5 * r, -0.14 * r, -0.98 * r, -0.3 * r + sway * 0.4, -0.86 * r, sway * 0.4, -0.98 * r, 0.3 * r + sway * 0.4, -0.5 * r, 0.14 * r)
  // Head swings into the blow.
  const turn = -wind * 0.5, hx = 0.86 * r, c = Math.cos(turn), s = Math.sin(turn)
  const at = (u: number, v: number): [number, number] => [hx + u * c - v * s, u * s + v * c]
  oval(pen, ...at(0.26 * r, 0), 0.46 * r, 0.4 * r, hide, ink, lw, turn)
  shape(pen, hide, ink, lw, ...at(0.5 * r, -0.26 * r), ...at(0.96 * r, -0.14 * r), ...at(0.96 * r, 0.14 * r), ...at(0.5 * r, 0.26 * r))
  const horn = tone('#e9dfc2')
  if (iron) shape(pen, horn, ink, lw * 0.8, ...at(0.8 * r, -0.1 * r), ...at(1.34 * r, 0), ...at(0.8 * r, 0.1 * r))
  else if (!stone) for (const v of [-1, 1]) shape(pen, horn, ink, lw * 0.8, ...at(0.2 * r, v * 0.3 * r), ...at(0.5 * r, v * 0.72 * r), ...at(1.0 * r, v * 0.62 * r), ...at(0.52 * r, v * 0.5 * r))
  if (fine) for (const v of [-1, 1]) oval(pen, ...at(0.56 * r, v * 0.17 * r), 0.05 * r, 0.05 * r, tone(stone ? '#9fe0d0' : '#f2c14a'))
}

/** Thrown down or dead: the body lies along its heading. The dead are drawn in soil tones over their own blood. */
function fallen(g: G): void {
  const { pen, r, kit, col, tone, pose, ink, lw, fine, def, zoom } = g
  const dead = pose.state === 'dead', outline = dead ? null : ink
  if (dead) {
    oval(pen, -0.1 * r, 0.1 * r, (kit.frame === 'foot' ? 1.1 : 1.5) * r, (kit.frame === 'foot' ? 0.8 : 1.0) * r, 'rgba(92,16,12,0.5)', null, 1, 0.5)
    oval(pen, 0.3 * r, -0.2 * r, 0.6 * r, 0.42 * r, 'rgba(110,20,14,0.45)')
  }
  if (kit.frame === 'cart') {
    const h = def.length * zoom / 2
    // A wreck: the bed slewed round, a wheel thrown clear, the team down in the traces.
    for (const s of [-1, 1]) oval(pen, 0.5 * h, s * 0.42 * r, 0.36 * h, 0.26 * r, tone(COATS[(pose.variant + (s > 0 ? 3 : 0)) % COATS.length]), outline, lw, s * 0.3)
    shape(pen, tone('#7a5f3e'), outline, lw, ...held(-0.5 * h, 0, 0.3, -0.45 * h, -0.6 * r, 0.4 * h, -0.6 * r, 0.4 * h, 0.6 * r, -0.45 * h, 0.6 * r))
    oval(pen, -0.3 * h, 1.0 * r, 0.24 * h, 0.24 * h, null, tone('#33281d'), Math.max(1.2, 0.12 * r))
    stroke(pen, tone(col.cloth), Math.max(1, 0.12 * r), ...held(-0.5 * h, 0, 0.3, -0.45 * h, -0.6 * r, -0.45 * h, 0.6 * r))
    return
  }
  if (kit.frame === 'horse' || (kit.frame === 'beast' && kit.beast !== 'giant')) {
    const big = kit.frame === 'beast', gryph = kit.mount === 'gryph'
    const coat = tone(big ? (kit.beast === 'stone' ? '#8c8d86' : kit.beast === 'iron' ? '#6f6a62' : kit.beast === 'giant' ? SKIN[1] : '#5d4631') : gryph ? '#b8904e' : COATS[(pose.variant * 2 + (def.type.length % 3)) % COATS.length])
    const L = big ? 1.0 * r : 1.25 * r, W = big ? 0.7 * r : 0.62 * r
    // On its side, legs out one way.
    for (const x of [-0.7, -0.4, 0.4, 0.7]) stroke(pen, coat, Math.max(1, 0.2 * r), x * L, 0.2 * W, x * L + 0.14 * r, W + 0.5 * r)
    oval(pen, 0, 0, L, W, coat, outline, lw)
    shape(pen, coat, outline, lw, 0.8 * L, -0.3 * W, 1.5 * L, -0.9 * W, 1.62 * L, -0.5 * W, 0.9 * L, 0.3 * W)
    if (!big) {
      shape(pen, tone(col.cloth), outline, lw * 0.8, -0.5 * L, -0.8 * W, 0.2 * L, -0.8 * W, 0.2 * L, 0.5 * W, -0.5 * L, 0.5 * W)
      prone(g, 0.66, -0.3 * r, -1.2 * r, 0.7)
    } else stroke(pen, tone(col.cloth), 0.2 * r, 0.1 * r, -W, 0.1 * r, W)
    return
  }
  prone(g, 1, 0, 0, 0)
  if (fine && kit.frame === 'foot' && def.shieldBlock > 0) oval(pen, -0.3 * r, -1.0 * r, 0.5 * r, 0.42 * r, tone(col.cloth), outline, lw)
}

/** A man (or brute) flat on the ground at (ox, oy), turned by `turn`, arms thrown out, his weapon beside him. */
function prone(g: G, k: number, ox: number, oy: number, turn: number): void {
  const { pen, kit, col, tone, pose, ink, lw, def } = g, r = g.r * k, dead = pose.state === 'dead', outline = dead ? null : ink
  const brute = kit.frame === 'brute'
  const torso = brute ? tone(kit.armour >= 2 ? col.metal : HIDES[pose.variant % 4]) : kit.torso === 'skin' ? tone(SKIN[pose.variant % 4]) : kit.torso === 'drab' ? tone(DRAB[pose.variant % 4]) : kit.torso === 'dark' ? tone('#2c2826')
    : kit.armour >= 3 ? tone(col.metal) : tone([col.cloth, lighter(col.cloth, 0.1)][pose.variant % 2])
  const limb = brute ? torso : kit.armour >= 2 ? tone(col.metalDark) : tone(col.clothDark)
  const at = (u: number, v: number) => held(ox, oy, turn, u * r, v * r)
  const width = Math.max(1, (brute ? 0.4 : 0.28) * r)
  stroke(pen, tone(BOOT), width, ...at(-0.5, -0.3), ...at(-1.25, -0.5))
  stroke(pen, tone(BOOT), width, ...at(-0.5, 0.3), ...at(-1.3, 0.24))
  stroke(pen, limb, width, ...at(0.3, -0.5), ...at(0.7, -1.1))
  stroke(pen, limb, width, ...at(0.3, 0.5), ...at(0.9, 0.95))
  const [cx, cy] = at(-0.05, 0)
  oval(pen, cx, cy, 0.86 * r, 0.56 * r, torso, outline, lw, turn)
  if (!brute && !kit.torso && kit.armour < 3) stroke(pen, tone(col.trim), 0.14 * r, ...at(-0.6, 0), ...at(0.5, 0))
  const [hx, hy] = at(0.92, 0.06)
  const helm = kit.head === 'helm' || kit.head === 'great'
  oval(pen, hx, hy, 0.36 * r, 0.34 * r, helm ? tone(col.metal) : kit.head === 'hat' ? tone(col.hat) : kit.head === 'hood' ? tone(col.clothDark) : kit.head === 'cap' ? tone(LEATHER) : tone(SKIN[pose.variant % 4]), outline, lw)
  // The weapon lies where it dropped. (A body-only glyph keeps it: the cell's edge cuts a long haft short.)
  if (def.weapon !== 'claws' && def.weapon !== 'bow') {
    const long = def.weapon === 'spear' || def.weapon === 'halberd' ? 2.6 : def.weapon === 'musket' ? 1.7 : 1.2
    stroke(pen, tone(def.weapon === 'sword' || def.weapon === 'greatsword' ? STEEL : WOOD), Math.max(1, 0.14 * r), ...at(0.4, 1.0), ...at(0.4 + long * 0.9, 1.0 + long * 0.42))
  }
}
