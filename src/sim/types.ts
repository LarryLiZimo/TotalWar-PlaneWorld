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
/** 0 tiny, 1 on foot, 2 mounted, 3 monstrous infantry / chariot, 4 monster. Only bodies of size 1 or less can be
 * knocked down, and only by a bigger body ramming them (RULES 四.7). */
export type PhysicalSize = 0 | 1 | 2 | 3 | 4
export interface AttackProfile {
  /** Start of a swing to the hit attempt; included within meleeInterval. */
  windup: number
  /** Minimum wait after completion, including a miss. Overlaps meleeInterval. */
  recovery: number
  arc: number
  splashMaxSize: PhysicalSize
}
/**
 * Collision attack (RULES 四.7): the alternate melee attack a chariot or big monster makes on the enemies it runs into
 * while charging or attacking. `interval` is its own cooldown in seconds, `targets` the most bodies one attack hits,
 * and `damage` the multiple of the unit's weapon strength each of them takes.
 */
export interface CollisionAttackDef { interval: number; targets: number; damage: number }
export interface WoundsDef { threshold: number; damage: number; speed: number }
export interface Resistances { physical: number; missile: number; fire: number; spell: number; ward: number }
export interface DamageTraits { magical?: boolean; flaming?: boolean; spell?: boolean }

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
  /** Enemy bodies this one has rammed; each must open a 2 m gap before it can be rammed again. */
  latched: number[]
  flash: number
  /** Seconds left on the ground. Zero means standing. */
  down: number
  /** Velocity of the throw, in m/s. It dies away while the soldier is down. */
  knockVx: number
  knockVy: number
  /** Seconds left of the charge in progress, from CHARGE_DURATION at contact down to zero; no new charge meanwhile. */
  chargeLeft: number
  /** Strength of that charge's bonus, min(1, closing speed / charge speed) at contact; 0 when charge defence negated it. */
  chargePower: number
  /** Charge intent only: alive, standing, running on an attack order, not routing, no charge in progress. Whether a
   * charge happens, and how strong, is decided at contact against the enemy met. */
  chargeArmed: boolean
  /** Seconds left for which the man he just rammed or threw down still counts as holding him in the line (RULES 三.3). */
  impactHold: number
  /** Seconds this model has been continuously within weapon reach of an enemy, and continuously out of reach. */
  contactTime: number
  freeTime: number
  /** The regiment's orderSerial when this model was last within weapon reach of an enemy; -1 if never. */
  contactOrder: number
  /**
   * Whether the contact this model is in may still deliver a charge (RULES 四.3). Decided when contact begins: open on
   * a model's first contact, or when its regiment has had a new order since its last contact and it has been out of
   * reach for MECHANICS.rechargeGap (cycle charging, even while comrades are still fighting). Closed once the contact
   * lasts longer than MECHANICS.chargeEntryWindow. Drifting out of a melee and back in under the same order never
   * charges again.
   */
  chargeOpen: boolean
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
  /** Ploughing after a ram (RULES 四.7): time left to throw the next man; a chariot also drives on toward plowX/plowY. */
  plowLeft: number
  plowX: number
  plowY: number
  /** A chariot whose plough ran out of momentum among enemies is stuck there: it pushes nobody over until it is clear. */
  chargeSpent: boolean
  /** External velocity is independent of walking and dissipates through ground friction. */
  pushVx: number
  pushVy: number
  /** Which side this man passes allied files on while weaving through them; 0 until he first has to choose. */
  avoidSide: number
  cartPath: { goalX:number; goalY:number; side:number; radius:number; arcLeft:number; straight:number } | null
}

export interface DamageEvent {
  t: number
  v: number
  /** Dealt in melee (collision attacks included) rather than by a missile. */
  melee: boolean
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
  targetId: number | null
  exertion: number
  fatigue: Fatigue
  run: boolean
  fireAtWill: boolean
  /** A missile unit switched to fight as melee (F): it holds fire, closes in and charges like melee troops. */
  meleeMode: boolean
  /**
   * Shift-queued orders, started one after another when the current march reaches its spot or the current attack
   * target is destroyed or routs. Any unqueued order, a march halted by an attack, and a rout clear it.
   */
  queue: QueuedOrder[]
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
  /**
   * Seconds left of each passing leadership effect (RULES 七.1): an enemy regiment fighting this one from beside it or
   * from behind it, enemy missiles hitting it, and cavalry or chariots having charged into it on foot.
   */
  flankHold: number
  rearHold: number
  fireHold: number
  chargedHold: number
  /** Men of this regiment with an enemy at weapon's reach beside its block, and behind it, in this step's contact pass. */
  flankTouch: number
  rearTouch: number
  /** Men on foot of this regiment whom cavalry or chariots charged home into in this step, and whose charge defence stopped one. */
  shockHits: number
  stoppedHits: number
  shot: boolean
  engaged: boolean
  /** Ignore old melee reactions while carrying out a changed attack target. */
  retargeting: boolean
  /** Ids of the enemy regiments some model of this one had within weapon reach in the last step's contact pass. */
  meleeFoes: number[]
  /** Some man found an enemy body within his reach + 0.5 m in this step's movement contact search (diagnostic probe of that search). */
  nearEnemy: boolean
  /**
   * This move was ordered while the regiment was in melee, so it is a disengagement: enemy attacks do not cancel it
   * at all until it arrives (being blocked can still end it).
   */
  disengaging: boolean
  /** Counts the orders this regiment has received; a new one lets its models charge again after pulling out. */
  orderSerial: number
  /** On a melee attack and within charging distance of the target (RULES 四.3): set each step with the attack destination. */
  inChargeRange: boolean
  /** 0..1: how far the files of a charging line have run out of line with each other (RULES 三.2). */
  ragged: number
  /**
   * Seconds this move has spent in enemy contact without getting closer to its destination, and the closest it
   * has come meanwhile (mean metres from the destination slots; -1 until the march first meets an enemy).
   */
  stall: number
  stallGap: number
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

/** One step of a Shift-queued order chain: a march to a spot (with a width for queued fronts) or an attack. */
export type QueuedOrder =
  | { kind: 'move'; x: number; y: number; facing: number; files?: number }
  | { kind: 'attack'; targetId: number }

/** Battlefield value (实力) of each army, index = side; see power.ts. */
export interface ArmyPower {
  /** Sum of regiment value over units still on the field and not shattered (routing units count: they can rally). */
  value: [number, number]
  /** The same sum at full health and ammunition: what the army deployed. */
  max: [number, number]
  /** The army is past its mark on the power bar: it has lost the battle (battle.ts decideBattle). */
  losing: [boolean, boolean]
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
  /** Refreshed at the end of every step, where the battle is decided on it; all zeros until the first step. */
  power: ArmyPower
  nextId: number
  pending: PendingOrder[]
  appliedSig: Map<number, string>
  widthOrder: Map<number, number[]>
  soldierById: Map<number, Soldier>
  aiEnabled: boolean
}
