export const MAP_WIDTH = 130
export const MAP_HEIGHT = 200
export const SIM_DT = 0.05

export type Side = 0 | 1
export type UnitType = 'infantry' | 'cavalry' | 'archer' | 'musket' | 'chariot'
export type OrderKind = 'hold' | 'move' | 'attack'
export type Fatigue = 'fresh' | 'winded' | 'exhausted'

export interface MissileDef {
  base: number
  ap: number
  reload: number
  range: number
  speed: number
  spread: number
  accNear: number
  accFar: number
  near: number
  far: number
  /** Arrows drop on the landing point. Bullets strike the first body on the path. */
  arc: boolean
}

export interface UnitDef {
  type: UnitType
  name: string
  models: number
  files: number
  hp: number
  meleeAttack: number
  meleeDefense: number
  armor: number
  weaponBase: number
  weaponAp: number
  meleeInterval: number
  reach: number
  speed: number
  chargeSpeed: number
  mass: number
  chargeBonus: number
  impactPower: number
  antiLargeMa: number
  antiLargeWs: number
  shieldBlock: number
  canBrace: boolean
  leadership: number
  radius: number
  length: number
  spacing: number
  rankSpacing: number
  cleave: number
  large: boolean
  shape: 'circle' | 'capsule'
  /** How many enemies can land a melee blow on this body at the same time. */
  meleeSlots: number
  missile: MissileDef | null
}

export interface Soldier {
  id: number
  regId: number
  hp: number
  x: number
  y: number
  vx: number
  vy: number
  /** Walking speed along `facing`. Soldiers accelerate and brake; they never step sideways. */
  speed: number
  /** Standing in its slot. Small shoves are ignored until the soldier drifts clearly out. */
  idle: boolean
  facing: number
  file: number
  rank: number
  /** Index within a short rear rank that stands centered. -1 uses the file column. */
  centerIndex: number
  alive: boolean
  deathTime: number
  meleeCd: number
  reload: number
  disengage: number
  leaving: boolean
  fleeX: number
  fleeY: number
  latched: number[]
  cleave: number
  flash: number
}

export interface DamageEvent {
  t: number
  v: number
}

export interface Regiment {
  id: number
  side: Side
  type: UnitType
  name: string
  soldiers: Soldier[]
  anchorX: number
  anchorY: number
  facing: number
  files: number
  order: OrderKind
  destX: number
  destY: number
  destFacing: number
  /** Width the regiment forms up in once it reaches its destination. */
  destFiles: number
  facingLocked: boolean
  targetId: number | null
  exertion: number
  fatigue: Fatigue
  restTime: number
  chargeTimer: number
  wantCharge: boolean
  anchorSpeed: number
  turnRate: number
  /** Velocity of the formation frame this step. Zero when the frame was re-laid rather than moved. */
  frameVx: number
  frameVy: number
  /** Mean distance between soldiers and their slots last step. */
  lag: number
  /** Mean speed of the soldiers themselves last step. */
  bodySpeed: number
  stationaryTime: number
  braceSlow: number
  bogTime: number
  bogged: boolean
  routing: boolean
  rallyTime: number
  aliveCount: number
  initial: number
  leadership: number
  dealt: DamageEvent[]
  taken: DamageEvent[]
  inContact: boolean
  touchFlank: boolean
  touchRear: boolean
  shot: boolean
  engaged: boolean
  nearEnemy: boolean
}

export interface Projectile {
  x: number
  y: number
  vx: number
  vy: number
  base: number
  ap: number
  side: Side
  sourceReg: number
  shooterId: number
  traveled: number
  maxRange: number
  alive: boolean
  arc: boolean
  originX: number
  originY: number
  landX: number
  landY: number
  age: number
  duration: number
  apex: number
}

export interface Floater {
  x: number
  y: number
  text: string
  life: number
}

export interface Notice {
  text: string
  life: number
}

export interface PendingOrder {
  regId: number
  left: number
  sig: string
  kind: OrderKind
  x: number
  y: number
  facing: number
  targetId: number | null
}

export interface Battle {
  seed: number
  time: number
  rng: () => number
  regiments: Regiment[]
  projectiles: Projectile[]
  fx: Floater[]
  notices: Notice[]
  winner: Side | -1 | null
  nextId: number
  pending: PendingOrder[]
  appliedSig: Map<number, string>
  widthOrder: Map<number, number[]>
  soldierById: Map<number, Soldier>
  aiEnabled: boolean
}
