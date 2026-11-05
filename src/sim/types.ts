import type { BattleCommand } from './commands'

export const MAP_WIDTH = 300
export const MAP_HEIGHT = 230
export const SIM_DT = 0.05

export type Side = 0 | 1
export type UnitType =
  | 'spear'
  | 'sword'
  | 'greatsword'
  | 'heavyCavalry'
  | 'lightCavalry'
  | 'archer'
  | 'musket'
  | 'chariot'
  | 'general'
  | 'inquisitor'
  | 'shieldCavalry'
  | 'halberd'
  | 'crossbow'
  | 'horseArcher'
  | 'ogre'
  | 'armoredOgre'
  | 'monster'
  | 'behemoth'
  | 'militia'
  | 'shieldSpear'
  | 'flagellant'
  | 'huntsmen'
  | 'freeCompany'
  | 'ironsides'
  | 'longRifle'
  | 'reiksguard'
  | 'blackRose'
  | 'pistolier'
  | 'outrider'
  | 'demigryph'
  | 'demigryphHalberd'
  | 'warWagon'
  | 'heavyChariot'
  | 'ogreGreatWeapon'
  | 'ogreHalberd'
  | 'giant'
  | 'stoneBeast'
  | 'captain'
  | 'warriorPriest'
export type OrderKind = 'hold' | 'move' | 'attack'
export type Fatigue = 'fresh' | 'active' | 'winded' | 'tired' | 'veryTired' | 'exhausted'
export type MoraleState = 'steady' | 'wavering' | 'routing' | 'shattered'
export type PhysicalSize = 0 | 1 | 2 | 3 | 4
export interface AttackProfile {
  /** Start of a swing to the hit attempt; included within meleeInterval. */
  windup: number
  /** Minimum wait after completion, including a miss. Overlaps meleeInterval. */
  recovery: number
  arc: number
  splashMaxSize: PhysicalSize
}
export interface CollisionAttackDef { interval: number; targets: number; damage: number }
export interface WoundsDef { threshold: number; damage: number; speed: number }
export interface Resistances { physical: number; missile: number; fire: number; spell: number; ward: number }
export interface DamageTraits { magical?: boolean; flaming?: boolean; spell?: boolean }
export interface Terrain { kind: 'flat' | 'slope'; rise: number; axis: 'x' | 'y' }

export interface MissileDef {
  base: number
  ap: number
  /** Extra missile damage against large targets, split in the projectile's base/AP ratio. */
  bonusVsLarge?: number
  /** Projectiles fired by one model per reload; ammunition counts volleys. */
  shotsPerVolley?: number
  reload: number
  range: number
  speed: number
  spread: number
  /** Curved arrows and flatter bullets both collide with bodies throughout flight. */
  arc: boolean
  /** Full firing arc in degrees, centered on the regiment's facing. */
  cone: number
  /** Shots each soldier carries. */
  ammo: number
  calibrationDistance: number
  calibrationRadius: number
  /** Penetration budget; one point is consumed by an ordinary infantry body. */
  penetration: number
  penetrationDamage: number
  fireWhileMoving: boolean
}

export interface UnitDef {
  /** Design budget per regiment at standard scale; does not restrict preset selection. */
  cost: number
  role: string
  /** Override the category's model count at standard 4x army scale. */
  standardModels?: number
  category: 'infantry' | 'ranged' | 'cavalry' | 'chariot' | 'monstrousInfantry' | 'monster'
  weapon: 'spear' | 'sword' | 'greatsword' | 'bow' | 'musket' | 'halberd' | 'claws'
  /** A single swing shares its weapon damage between at most this many victims. */
  splash: number
  physicalSize: PhysicalSize
  bodyHeight: number
  penetrationResistance: number
  chargeDefense: 'none' | 'large' | 'all'
  chargeReflection: boolean
  collisionAttack: CollisionAttackDef | null
  attack: AttackProfile
  wounds: WoundsDef | null
  encourage: number
  commander: boolean
  causesFear: boolean
  causesTerror: boolean
  immunePsychology: boolean
  unbreakable: boolean
  resistances: Resistances
  type: UnitType
  name: string
  models: number
  files: number
  /** Widest the unit can stand, in files. */
  maxFiles: number
  /** Deepest the unit can stand, in ranks. */
  maxRanks: number
  hp: number
  meleeAttack: number
  meleeDefense: number
  armor: number
  weaponBase: number
  weaponAp: number
  /** Start-to-start cooldown. Recovery can lengthen it if windup + recovery is greater. */
  meleeInterval: number
  reach: number
  speed: number
  chargeSpeed: number
  /** How fast turning can build up or ease off, rad/s². */
  turnAccel: number
  /** Fastest turn, rad/s. */
  turnCap: number
  /** Tightest circle while rolling, m. 0 for men on foot. */
  turnRadius: number
  /** Fastest turn while standing still, rad/s. Only matters when `turnRadius` > 0. */
  pivotRate: number
  mass: number
  chargeBonus: number
  impactPower: number
  antiLargeMa: number
  antiLargeWs: number
  /** Melee attack added against every small target, including ranged infantry. */
  antiInfantryMa: number
  /** Weapon damage added against every small target. */
  antiInfantryWs: number
  shieldBlock: number
  canBrace: boolean
  leadership: number
  /** Visible/weapon/projectile geometry. Movement uses the slimmer collision scale. */
  radius: number
  length: number
  spacing: number
  rankSpacing: number
  cleave: number
  large: boolean
  shape: 'circle' | 'capsule'
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
  /** Current turning speed, rad/s. Builds up and eases off; it never jumps. */
  omega: number
  /** Standing in its slot. Small shoves are ignored until the soldier drifts clearly out. */
  idle: boolean
  facing: number
  file: number
  rank: number
  /** Index within a short rear rank that stands centered. -1 uses the file column. */
  centerIndex: number
  alive: boolean
  /** Left the battlefield while routing; inactive, but not killed. */
  escaped: boolean
  deathTime: number
  meleeCd: number
  reload: number
  /** Shots left. Melee soldiers stay at 0. */
  ammo: number
  disengage: number
  leaving: boolean
  fleeX: number
  fleeY: number
  latched: number[]
  cleave: number
  flash: number
  /** Seconds left on the ground. Zero means standing. */
  down: number
  /** Velocity of the throw, in m/s. It dies away while the soldier is down. */
  knockVx: number
  knockVy: number
  chargeLeft: number
  chargeArmed: boolean
  reactTo: number | null
  reactTime: number
  prevX: number
  prevY: number
  prevFacing: number
  chargeContactAt: number
  swing: { left: number; facing: number; targetId: number } | null
  collisionCd: number
  braceTime: number
  wounded: boolean
  /** Each chariot finishes its own straight run before turning for another pass. */
  plowLeft: number
  plowX: number
  plowY: number
  /** External velocity is independent of walking and dissipates through ground friction. */
  pushVx: number
  pushVy: number
  blockedTime: number
  avoidSide: number
  bypass: { regId:number; side:number; direction:number; passing:boolean } | null
  cartPath: { goalX:number; goalY:number; side:number; radius:number; arcLeft:number; straight:number } | null
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
  run: boolean
  fireAtWill: boolean
  skirmish: boolean
  skirmishing: boolean
  wantCharge: boolean
  anchorSpeed: number
  turnRate: number
  /** Velocity of the formation frame this step. Zero when the frame was re-laid rather than moved. */
  frameVx: number
  frameVy: number
  /** Mean distance between soldiers and their slots last step. */
  lag: number
  /** Mean distance soldiers are behind their slots along the facing; men beside or ahead of their slot count zero. */
  trail: number
  /** Mean speed of the soldiers themselves last step. */
  bodySpeed: number
  stationaryTime: number
  braceSlow: number
  /** Seconds a chariot keeps driving after running over men who were not braced. */
  plow: number
  bogTime: number
  bogged: boolean
  routing: boolean
  rallyTime: number
  aliveCount: number
  initial: number
  /** Maximum health of one model in this battle, including single-entity scale. */
  modelHp: number
  leadership: number
  dealt: DamageEvent[]
  taken: DamageEvent[]
  inContact: boolean
  touchFlank: boolean
  touchRear: boolean
  shot: boolean
  engaged: boolean
  /** Briefly hold the melee frame after a cavalry impact knocks its target down. */
  contactLock: number
  /** Ignore old melee reactions while carrying out a changed attack target. */
  retargeting: boolean
  /** Reserves join a battle already reached by any member, even outside release range. */
  attackCommitted: boolean
  nearEnemy: boolean
  /** Legacy regiment-level damage marker; individual reaction controls facing. */
  meleeReact: boolean
  /** Last regiment to land a rear melee blow, retained for diagnostics. */
  rearFoe: number | null
  moraleState: MoraleState
  shattered: boolean
  negativeTime: number
  routeTime: number
  routCount: number
  /** Cooldown owned by this terror-causing regiment, never its victims. */
  terrorCooldown: number
  /** Sources that actually damaged this regiment during the current step. */
  terrorHits: number[]
  moraleFactors: Record<string, number>
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
  z: number
  vz: number
  gravity: number
  sourceGround: number
  penetrationLeft: number
  hitIds: number[]
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
  /** Present only on a main-thread view; commands are executed by the worker. */
  sendCommand?: (command:BattleCommand)=>void
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
  terrain: Terrain
}
