import { planEnemyIntents } from './ai'
import {
  calibrationRadius,
  armorRoll,
  CHARGE_DURATION,
  chargeStrength,
  effectiveChargeSpeed,
  speedPower,
  defenseMultiplier,
  leadershipFactors,
  fatigueMods,
  hitChance,
  KNOCK_TIME,
  mitigate,
  splitBonus,
  woundMods,
  resistanceMultiplier,
} from './combat'
import {
  PLACE_RADIUS,
  compactRanks,
  fitOnMap,
  gapBetween,
  isBracing,
  chargeDefended,
  bracingMassMultiplier,
  impactBraceMultiplier,
  bracedAgainst,
  reformAt,
  reformMoving,
  slotOf,
  travelFacing,
} from './formation'
import { DEG, angDiff, clamp, facingArc, forward, mulberry32, rayCircleT } from './math'
import { advanceQueue, commandAttack, commandHold, commandMove, regimentById, setMeleeMode } from './orders'
import { shapePoints } from './formation'
import { Spatial } from './spatial'
import type { Battle, DamageTraits, Projectile, Regiment, Side, Soldier, UnitDef, UnitType } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { firesMissiles, isCavalry, unitDef } from './units'
import { FATIGUE, MECHANICS, fatigueAt } from './mechanics'
import { advanceMorale, reached, shatter } from './morale'
import { refreshPower } from './power'
import { sweptCylinderT } from './ballistics'
import { bodyContact, collisionExtent, collisionRadius, contactPush, contactSoftDepth, groundDrag, moveGroundDrift, normalImpulse } from './physics'

const NORTH = Math.PI / 2
const SOUTH = -Math.PI / 2

interface Scratch {
  spatial: Spatial
  buf: number[]
  live: Live[]
  indexOf: Map<number, number>
  /** Regiments that lost HP to an enemy melee hit (collision attacks included) during this step. */
  struck: Set<Regiment>
  /** Carts that out-pushed the foot in front of them this step (cart traction): pushing on, not stuck. */
  pushing: Set<Soldier>
  /** Per live index, for separate(): hostile and friendly collision extents, wide flag and pass-start position. */
  extent: Float64Array
  slim: Float64Array
  wide: Uint8Array
  startX: Float64Array
  startY: Float64Array
}

const scratches = new WeakMap<Battle, Scratch>()
const compactedCounts = new WeakMap<Regiment, number>()
/** Mean distance, along the facing, by which each regiment's fighting front-rank men stood behind their slots last step. */
const frontLag = new WeakMap<Regiment, number>()

function scratchOf(battle: Battle): Scratch {
  let found = scratches.get(battle)
  if (!found) {
    found = { spatial: new Spatial(2, 2048), buf: [], live: [], indexOf: new Map(), struck: new Set(), pushing: new Set(), extent: new Float64Array(0), slim: new Float64Array(0), wide: new Uint8Array(0), startX: new Float64Array(0), startY: new Float64Array(0) }
    scratches.set(battle, found)
  }
  return found
}

interface Live {
  s: Soldier
  reg: Regiment
  def: UnitDef
}

export function createBattle(seed = 20261103): Battle {
  const battle = createEmptyBattle(seed)
  deployDemo(battle)
  return battle
}

export function createEmptyBattle(seed = 20261104): Battle {
  return {
    seed,
    time: 0,
    rng: mulberry32(seed),
    regiments: [],
    projectiles: [],
    fx: [],
    notices: [],
    winner: null,
    power: { value: [0, 0], max: [0, 0], losing: [false, false] },
    nextId: 1,
    pending: [],
    appliedSig: new Map(),
    widthOrder: new Map(),
    soldierById: new Map(),
    aiEnabled: false,
  }
}

function deployDemo(battle: Battle): void {
  spawn(battle, 0, 'sword', '南军盾兵', 110, 74, NORTH)
  spawn(battle, 0, 'sword', '南军盾兵二', 130, 74, NORTH)
  spawn(battle, 0, 'sword', '南军盾兵三', 150, 74, NORTH)
  spawn(battle, 0, 'sword', '南军盾兵四', 170, 74, NORTH)
  spawn(battle, 0, 'sword', '南军盾兵五', 190, 74, NORTH)
  spawn(battle, 0, 'greatsword', '南军巨剑', 130, 58, NORTH)
  spawn(battle, 0, 'greatsword', '南军巨剑二', 150, 58, NORTH)
  spawn(battle, 0, 'greatsword', '南军巨剑三', 170, 58, NORTH)
  spawn(battle, 0, 'archer', '南军弓箭', 88, 42, NORTH)
  spawn(battle, 0, 'archer', '南军弓箭二', 212, 42, NORTH)
  spawn(battle, 0, 'musket', '南军火枪', 150, 40, NORTH)
  spawn(battle, 0, 'lightCavalry', '南军轻骑', 48, 80, NORTH)
  spawn(battle, 0, 'lightCavalry', '南军轻骑二', 70, 80, NORTH)
  spawn(battle, 0, 'lightCavalry', '南军轻骑三', 230, 80, NORTH)
  spawn(battle, 0, 'lightCavalry', '南军轻骑四', 252, 80, NORTH)
  spawn(battle, 0, 'heavyCavalry', '南军重骑', 52, 56, NORTH)
  spawn(battle, 0, 'chariot', '南军战车', 248, 56, NORTH)
  spawn(battle, 0, 'inquisitor', '南军审判官', 160, 66, NORTH)
  spawn(battle, 0, 'general', '南军将军', 214, 64, NORTH)
  spawn(battle, 1, 'spear', '北军矛兵', 95, 148, SOUTH)
  spawn(battle, 1, 'spear', '北军矛兵二', 117, 148, SOUTH)
  spawn(battle, 1, 'spear', '北军矛兵三', 139, 148, SOUTH)
  spawn(battle, 1, 'spear', '北军矛兵四', 161, 148, SOUTH)
  spawn(battle, 1, 'spear', '北军矛兵五', 183, 148, SOUTH)
  spawn(battle, 1, 'spear', '北军矛兵六', 205, 148, SOUTH)
  spawn(battle, 1, 'greatsword', '北军巨剑', 106, 164, SOUTH)
  spawn(battle, 1, 'greatsword', '北军巨剑二', 128, 164, SOUTH)
  spawn(battle, 1, 'greatsword', '北军巨剑三', 150, 164, SOUTH)
  spawn(battle, 1, 'greatsword', '北军巨剑四', 172, 164, SOUTH)
  spawn(battle, 1, 'greatsword', '北军巨剑五', 194, 164, SOUTH)
  spawn(battle, 1, 'heavyCavalry', '北军重骑', 114, 186, SOUTH)
  spawn(battle, 1, 'heavyCavalry', '北军重骑二', 150, 186, SOUTH)
  spawn(battle, 1, 'heavyCavalry', '北军重骑三', 186, 186, SOUTH)
}

export function setAiEnabled(battle: Battle, enabled: boolean): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'ai',enabled});return}
  battle.aiEnabled = enabled
  if (enabled) return
  battle.pending = []
  battle.appliedSig.clear()
  for (const reg of battle.regiments) {
    if (reg.side !== 1 || reg.aliveCount <= 0 || reg.routing) continue
    commandHold(battle, [reg.id])
  }
}

export function spawn(
  battle: Battle,
  side: Side,
  type: UnitType,
  name: string,
  x: number,
  y: number,
  facing: number,
  formation?: {models:number;files:number;hp?:number},
): Regiment {
  const def = unitDef(type)
  const models=formation?.models??def.models,files=formation?.files??def.files,modelHp=formation?.hp??def.hp
  const reg: Regiment = {
    id: battle.nextId++,
    side,
    type,
    name,
    soldiers: [],
    anchorX: x,
    anchorY: y,
    facing,
    files,
    order: 'hold',
    destX: x,
    destY: y,
    destFacing: facing,
    destFiles: files,
    targetId: null,
    exertion: 0,
    fatigue: 'fresh',
    run: true,
    fireAtWill: true,
    meleeMode: false,
    queue: [],
    wantCharge: false,
    anchorSpeed: 0,
    turnRate: 0,
    frameVx: 0,
    frameVy: 0,
    lag: 0,
    trail: 0,
    bodySpeed: 0,
    stationaryTime: 0,
    braceSlow: 0,
    plow: 0,
    bogTime: 0,
    bogged: false,
    routing: false,
    rallyTime: 0,
    aliveCount: models,
    initial: models,
    modelHp,
    leadership: def.leadership,
    dealt: [],
    taken: [],
    inContact: false,
    flankHold: 0,
    rearHold: 0,
    fireHold: 0,
    chargedHold: 0,
    flankTouch: 0,
    rearTouch: 0,
    shockHits: 0,
    stoppedHits: 0,
    shot: false,
    engaged: false,
    retargeting: false,
    meleeFoes: [],
    nearEnemy: false,
    disengaging: false,
    orderSerial: 0,
    inChargeRange: false,
    ragged: 0,
    stall: 0,
    stallGap: -1,
    moraleState: 'steady', shattered: false, negativeTime: 0, routeTime: 0,
    routCount: 0, terrorCooldown: 0, terrorHits: [], moraleFactors: {},
  }
  for (let i = 0; i < models; i++) {
    const file = i % files
    const rank = Math.floor(i / files)
    const soldier: Soldier = {
      id: battle.nextId++,
      regId: reg.id,
      hp: modelHp,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: 0,
      omega: 0,
      idle: true,
      facing,
      file,
      rank,
      centerIndex: -1,
      alive: true,
      escaped: false,
      deathTime: -1,
      meleeCd: battle.rng() * def.meleeInterval,
      reload: def.missile ? battle.rng() * def.missile.reload : 0,
      ammo: def.missile ? def.missile.ammo : 0,
      disengage: 0,
      leaving: false,
      latched: [],
      flash: 0,
      down: 0,
      knockVx: 0,
      knockVy: 0,
      chargeLeft: 0,
      chargePower: 0,
      chargeArmed: false,
      impactHold: 0,
      contactTime: 0,
      freeTime: Infinity,
      contactOrder: -1,
      chargeOpen: true,
      reactTo: null,
      reactTime: 0,
      prevX: 0,
      prevY: 0,
      prevFacing: facing,
      chargeContactAt: -1, swing: null, collisionCd: 0, braceTime: 0, wounded: false,
      plowLeft: 0, plowX: x, plowY: y, chargeSpent: false,
      pushVx: 0, pushVy: 0, avoidSide: 0,
      cartPath: null,
    }
    reg.soldiers.push(soldier)
    battle.soldierById.set(soldier.id, soldier)
  }
  for (const soldier of reg.soldiers) {
    const slot = slotOf(reg, def, soldier.file, soldier.rank, soldier.centerIndex)
    soldier.x = slot.x
    soldier.y = slot.y
    soldier.prevX = slot.x
    soldier.prevY = slot.y
  }
  battle.regiments.push(reg)
  return reg
}

export function step(battle: Battle, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 0.1) throw new Error('模拟步长必须在 (0, 0.1] 秒内')
  for (const reg of battle.regiments) for (const s of reg.soldiers) {
    if (s.escaped) continue
    s.prevX = s.x
    s.prevY = s.y
    s.prevFacing = s.facing
    s.chargeLeft = Math.max(0, s.chargeLeft - dt)
    s.collisionCd = Math.max(0, s.collisionCd - dt)
    s.plowLeft = Math.max(0, s.plowLeft - dt)
    const def = unitDef(reg.type)
    if (def.wounds && s.hp <= reg.modelHp * def.wounds.threshold) s.wounded = true
    if (reg.order === 'move' || reg.routing || s.down > 0 || !s.alive) s.swing = null
    s.reactTime = Math.max(0, s.reactTime - dt)
    if (s.reactTime === 0) s.reactTo = null
    s.impactHold = Math.max(0, s.impactHold - dt)
  }
  for (const reg of battle.regiments) {
    reg.terrorCooldown = Math.max(0, reg.terrorCooldown - dt)
    reg.terrorHits.length=0
  }
  battle.time += dt
  ageTransient(battle, dt)
  applyAi(battle, dt)
  for (const reg of battle.regiments) {
    reg.inChargeRange = false
    if (reg.order === 'attack') updateAttackDest(battle, reg)
    armCharge(battle, reg)
    // The charging line strings out as it runs in, and closes up again once it has struck or stopped.
    const stringing = reg.wantCharge && !reg.inContact && !reg.routing && unitDef(reg.type).category !== 'chariot'
    reg.ragged = clamp(reg.ragged + dt / (stringing ? MECHANICS.staggerRise : -MECHANICS.staggerFall), 0, 1)
  }
  moveRegiments(battle, dt)
  const pad = scratchOf(battle)
  const live = buildLive(battle, pad)
  moveSoldiers(battle, live, pad, dt)
  for (const reg of battle.regiments) {
    reg.inContact = false
    reg.meleeFoes.length = 0
    reg.flankTouch = 0
    reg.rearTouch = 0
    reg.shockHits = 0
    reg.stoppedHits = 0
    reg.shot = false
  }
  pad.struck.clear()
  const grid = fillGrid(pad, live)
  resolveMelee(battle, live, grid, pad.buf, dt)
  resolveCollisionAttacks(battle, live, grid, pad.buf)
  resolveShooting(battle, live, grid, pad, dt)
  flyProjectiles(battle, live, grid, pad.buf, dt)
  resolveImpact(battle, live, grid, pad)
  separate(live, pad,dt)
  absorbBumps(live)
  clampBodies(battle)
  settleMoveOrders(battle, pad.struck, dt)
  finishChargeFatigueBog(battle, live, pad, dt)
  updateMorale(battle, dt)
  for (const reg of battle.regiments) {
    if (!reg.routing && compactedCounts.get(reg) !== reg.aliveCount) {
      compactRanks(reg)
      compactedCounts.set(reg, reg.aliveCount)
    }
  }
  refreshCounts(battle)
  // The bar shows the field after this step's routs and deaths, and the battle is decided on it.
  decideBattle(battle)
}

function ageTransient(battle: Battle, dt: number): void {
  for (const reg of battle.regiments) {
    for (const soldier of reg.soldiers) {
      if (soldier.flash > 0) soldier.flash = Math.max(0, soldier.flash - dt)
    }
  }
  for (const floater of battle.fx) floater.life -= dt
  battle.fx = battle.fx.filter((floater) => floater.life > 0)
  for (const notice of battle.notices) notice.life -= dt
  battle.notices = battle.notices.filter((notice) => notice.life > 0)
}

function applyAi(battle: Battle, dt: number): void {
  if (!battle.aiEnabled) return
  for (const intent of planEnemyIntents(battle)) {
    if (battle.appliedSig.get(intent.regId) === intent.sig) {
      battle.pending = battle.pending.filter((item) => item.regId !== intent.regId)
      continue
    }
    const existing = battle.pending.find((item) => item.regId === intent.regId)
    if (existing) {
      existing.sig = intent.sig
      existing.kind = intent.kind
      existing.x = intent.x
      existing.y = intent.y
      existing.facing = intent.facing
      existing.targetId = intent.targetId
    } else {
      battle.pending.push({ ...intent, left: 1.5 })
    }
  }
  for (const pending of battle.pending) pending.left -= dt
  const due = battle.pending.filter((item) => item.left <= 0)
  battle.pending = battle.pending.filter((item) => item.left > 0)
  for (const pending of due) {
    if (pending.kind === 'hold') commandHold(battle, [pending.regId], pending.facing)
    else if (pending.kind === 'move') commandMove(battle, [pending.regId], pending.x, pending.y, pending.facing)
    else if (pending.targetId !== null) commandAttack(battle, [pending.regId], pending.targetId)
    battle.appliedSig.set(pending.regId, pending.sig)
  }
}

/**
 * How far a chariot that has driven through a unit runs on past the far side of its ranks, or of the men it
 * threw who still lie on the ground, before it pulls up. So it does not stop among them as they get up; men
 * already back on their feet do not lead it on.
 */
const PLOW_OVERRUN = 6

function updateAttackDest(battle: Battle, reg: Regiment): void {
  if (reg.targetId === null) return
  const target = regimentById(battle, reg.targetId)
  // A queued chain moves on once the target is destroyed or breaks; without one, routing targets are chased.
  if (reg.queue.length && (!target || target.aliveCount <= 0 || target.routing) && advanceQueue(battle, reg)) return
  if (!target || target.aliveCount <= 0) {
    commandHold(battle, [reg.id])
    return
  }
  const dx = target.anchorX - reg.anchorX
  const dy = target.anchorY - reg.anchorY
  const distance = Math.hypot(dx, dy) || 1
  const def = unitDef(reg.type)
  // A melee attack goes for the middle of the target's bodies, from whichever side it comes.
  const middle = firesMissiles(reg) ? null : aliveCenter(target)
  if (middle) {
    reg.destFacing = Math.atan2(middle.y - reg.anchorY, middle.x - reg.anchorX)
    // Men on foot run up at their running pace and break into the charge only this close to the target's block.
    // Horses and great beasts are sent in at the charge from the start: their run-up is the charge (RULES 四.3).
    const targetDef = unitDef(target.type), ranks = Math.ceil(target.aliveCount / Math.max(1, target.files))
    const reach = Math.hypot((Math.min(target.files, target.aliveCount) - 1) * targetDef.spacing / 2, (ranks - 1) * targetDef.rankSpacing / 2) + targetDef.radius
    reg.inChargeRange = def.turnRadius > 0 || Math.hypot(middle.x - reg.anchorX, middle.y - reg.anchorY) - reach <= def.chargeSpeed * MECHANICS.chargeRun
  }
  if (!firesMissiles(reg) && def.category!=='chariot' && reg.engaged && !reg.retargeting) {
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.wantCharge = false
    return
  }
  if (def.missile && firesMissiles(reg)) {
    // Which way the enemy lies is read between the middles of the two bodies of men. Between the frames' anchors
    // (their front ranks) it turns right round the moment an enemy line pushes past this one's front rank.
    const own = aliveCenter(reg), theirs = aliveCenter(target)
    const toEnemy = own && theirs ? Math.atan2(theirs.y - own.y, theirs.x - own.x) : Math.atan2(dy, dx)
    const offCenter = Math.abs(angDiff(reg.facing, toEnemy))
    const turningOnto = Math.abs(angDiff(reg.facing, reg.destFacing)) > 8 * DEG && Math.abs(angDiff(reg.destFacing, toEnemy)) < 15 * DEG
    if (offCenter > fireHalf(def) || turningOnto) {
      reg.destFacing = toEnemy
    } else {
      reg.destFacing = reg.facing
    }
    const desired = Math.max(8, def.missile.range - firingDepth(reg, def))
    if (distance > desired) {
      reg.destX = clamp(target.anchorX - (dx / distance) * desired, 3, MAP_WIDTH - 3)
      reg.destY = clamp(target.anchorY - (dy / distance) * desired, 3, MAP_HEIGHT - 3)
    } else {
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
    }
    return
  }
  reg.destX = clamp(middle?.x ?? target.anchorX, 3, MAP_WIDTH - 3)
  reg.destY = clamp(middle?.y ?? target.anchorY, 3, MAP_HEIGHT - 3)
}

/**
 * Charge intent (RULES 四.3): every standing model of a regiment running on an attack order, not routing, with no
 * charge in progress. Intent alone grants nothing: whether a charge happens, and its strength, is decided at contact
 * against the enemy met (contactPower), with no further distance, angle, cohesion or unit-category requirement.
 */
function armCharge(battle: Battle, reg: Regiment): void {
  const def = unitDef(reg.type)
  const approaching = reg.run && reg.order === 'attack' && !reg.routing
  // The charge itself: within charging distance and not yet held. Carts drive themselves and are always at it.
  reg.wantCharge = approaching && (def.category === 'chariot' || (!reg.engaged && reg.inChargeRange))
  for (const s of reg.soldiers) s.chargeArmed = approaching && s.alive && s.down <= 0 && s.chargeLeft <= 0
}

function moveSpeedOf(reg: Regiment, soldier?: Soldier): number {
  const def = unitDef(reg.type)
  const mods = fatigueMods(reg.fatigue)
  // The formation can be engaged while individual reserves are still running
  // into the fight. Their approach pace must not inherit the frame's slow gait.
  const charging = (reg.wantCharge || (soldier !== undefined && reg.order === 'attack') || (def.category === 'chariot' && (soldier?.plowLeft ?? 0) > 0)) && reg.run && !reg.routing
  const body = soldier ?? (def.models === 1 ? reg.soldiers[0] : undefined)
  let speed = (charging ? def.chargeSpeed : def.speed * woundMods(def, body).speed) * mods.speed
  if (!reg.run && !charging && !reg.routing) speed *= 0.5
  if (reg.routing) speed *= 1.1
  if (reg.braceSlow > 0) speed = Math.min(speed, 1.5)
  // Bogged carts crawl only where they touch the enemy; one already clear of the crowd drives on at its own pace.
  if (reg.bogged && (soldier ? soldier.contactTime > 0 : reg.inContact) && reg.order !== 'move') speed = Math.min(speed, 1.8)
  if (soldier && soldier.disengage > 0) speed *= 0.55
  return speed
}

function accelRate(def: UnitDef, speedingUp: boolean): number {
  const base = def.category === 'chariot' ? 2.2 : isCavalry(def.type) ? 4 : 1.7
  return speedingUp ? base : base * 1.7
}

/**
 * How hard a body speeds up at `speed` toward a top pace of `top` (RULES 三.2). Horses and carts gather themselves and
 * then surge: slow off the mark, hardest as they reach their pace, the same time to get there. A man on foot breaking
 * from his running pace into a charge puts on a short burst.
 */
function surgeRate(def: UnitDef, speed: number, top: number): number {
  const base = accelRate(def, true)
  if (def.turnRadius === 0) return top > def.speed * 1.05 && speed >= def.speed * 0.5 ? base * MECHANICS.footBurst : base
  const share = top > 0 ? clamp(speed / top, 0, 1) : 1
  return base * (MECHANICS.surgeStart + (MECHANICS.surgeEnd - MECHANICS.surgeStart) * share)
}

function approach(current: number, target: number, rate: number, dt: number): number {
  const diff = target - current
  const step = rate * dt
  if (Math.abs(diff) <= step) return target
  return current + Math.sign(diff) * step
}

function halfWidth(reg: Regiment): number {
  const def = unitDef(reg.type)
  return Math.max(def.spacing * 0.5, ((reg.files - 1) * def.spacing) / 2)
}

function turnLever(def: UnitDef): number {
  if (def.shape === 'capsule') return Math.max(0.8, def.length * 0.5)
  if (isCavalry(def.type)) return 0.9
  return Math.max(0.45, def.spacing * 0.5)
}

/** Forward speed plus the outer arc of a turn share one speed budget. No sideways movement. */
function drive(
  facing: number,
  desired: number,
  maxSpeed: number,
  lever: number,
  dt: number,
  wantMove: boolean,
): { facing: number; omega: number; forward: number } {
  const safeLever = Math.max(0.25, lever)
  const err = angDiff(facing, desired)
  const maxOmega = maxSpeed / safeLever
  let omega = Math.abs(err) < 0.04 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
  let forwardSpeed = 0
  if (wantMove && Math.abs(err) <= Math.PI * 0.5) {
    forwardSpeed = Math.max(0, maxSpeed - Math.abs(omega) * safeLever) * Math.max(0, Math.cos(err))
  }
  const used = forwardSpeed + Math.abs(omega) * safeLever
  if (used > maxSpeed && used > 0) {
    const scale = maxSpeed / used
    forwardSpeed *= scale
    omega *= scale
  }
  return { facing: facing + omega * dt, omega, forward: forwardSpeed }
}

/** Enemies further than this do not steer a rout. */
const FLEE_AWARE = 80

/**
 * A routing unit runs for its own side of the field and away from every enemy near it, the closer the harder.
 * Summing them keeps a unit caught between enemies from flipping its heading as the nearest one changes.
 */
function fleeHeading(battle: Battle, reg: Regiment): number {
  let fx = 0
  let fy = reg.side === 0 ? -1 : 1
  for (const other of battle.regiments) {
    if (other.side === reg.side || other.aliveCount <= 0 || other.routing) continue
    const dx = reg.anchorX - other.anchorX
    const dy = reg.anchorY - other.anchorY
    const d = Math.hypot(dx, dy)
    if (d > FLEE_AWARE || d < 1e-3) continue
    const push = 30 / Math.max(d, 8)
    fx += (dx / d) * push
    fy += (dy / d) * push
  }
  return Math.atan2(fy, fx)
}

/** An engaged attacker's frame closes on its fighting front rank at up to this pace, m/s, once they are this far apart. */
const FRAME_SETTLE_PACE = 2
const FRAME_SETTLE_SLACK = 0.03

/** Past this, the block does not wheel. Every soldier turns on the spot and the ranks re-form facing the new way. */
const REFORM_TURN = 45 * DEG

/**
 * The regiment itself is only a plan: where the block should stand and which way it faces.
 * Soldiers are the bodies that obey the walking rules and try to keep up with it.
 */
function moveRegiments(battle: Battle, dt: number): void {
  for (const reg of battle.regiments) {
    if (reg.braceSlow > 0) reg.braceSlow = Math.max(0, reg.braceSlow - dt)
    if (reg.plow > 0) reg.plow = Math.max(0, reg.plow - dt)
    const ox = reg.anchorX
    const oy = reg.anchorY
    const oFacing = reg.facing
    let relaid = false
    if (reg.aliveCount <= 0) {
      reg.anchorSpeed = 0
      reg.frameVx = 0
      reg.frameVy = 0
      reg.turnRate = 0
      continue
    }
    const def = unitDef(reg.type)
    if (reg.routing) {
      // This is the crowd's shared escape direction, not a marching formation.
      // Its marker follows actual bodies, so stragglers never chase old slots.
      const center=aliveCenter(reg)!
      reg.anchorX=center.x;reg.anchorY=center.y
      reg.facing=fleeHeading(battle,reg)
      reg.anchorSpeed=reg.bodySpeed
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
      reg.destFacing = reg.facing
      reg.stationaryTime = 0
    } else if (def.category==='chariot' && (reg.order==='move'||(reg.order==='attack'&&!firesMissiles(reg)))) {
      if(reg.order==='move') {
        // Carts drive straight to their final slots and never pass through settleAtDest, so the line they
        // will stand in is fitted inside the map here, as it is for every other unit.
        const fitted=fitOnMap(reg,reg.destX,reg.destY,reg.destFacing,clamp(reg.files,1,Math.max(1,reg.aliveCount)))
        reg.destX=fitted.x;reg.destY=fitted.y
      }
      // The attack frame follows actual carts. It never sends them back to empty slots.
      const center=aliveCenter(reg)!
      if(reg.order==='move') reg.facing=Math.hypot(reg.destX-center.x,reg.destY-center.y)>PLACE_RADIUS?Math.atan2(reg.destY-center.y,reg.destX-center.x):reg.destFacing
      else {
        // On the attack it is only a marker over the carts, and it is read from the carts alone: it looks from their
        // middle to the middle of the target while the two are apart, keeps its facing while the carts are in among
        // the target (where that direction means nothing), and comes round at a cart's own turning rate.
        const target=reg.targetId===null?null:regimentById(battle,reg.targetId), middle=target?aliveCenter(target):null
        const apart=middle?Math.hypot(middle.x-center.x,middle.y-center.y):0
        const turn=middle&&apart>CART_FRAME_APART?angDiff(reg.facing,Math.atan2(middle.y-center.y,middle.x-center.x)):0
        reg.facing+=clamp(turn,-def.turnCap*dt,def.turnCap*dt)
      }
      const depth=(Math.ceil(reg.aliveCount/Math.max(1,reg.files))-1)*def.rankSpacing/2
      reg.anchorX=center.x+Math.cos(reg.facing)*depth
      reg.anchorY=center.y+Math.sin(reg.facing)*depth
      reg.anchorSpeed=reg.bodySpeed
      reg.stationaryTime=reg.bodySpeed<0.28?reg.stationaryTime+dt:0
    } else if (reg.engaged && !firesMissiles(reg) && reg.plow <= 0) {
      reg.anchorSpeed = approach(reg.anchorSpeed, 0, accelRate(def, false) * 2.4, dt)
      reg.stationaryTime += dt
      // An attacking line stands where its front rank stands (RULES 三.3): the frame comes back to the men the enemy
      // stopped, and follows them when they step up, so the ranks behind neither press into them nor are left behind.
      const lag = reg.order === 'attack' ? frontLag.get(reg) ?? 0 : 0
      if (Math.abs(lag) > FRAME_SETTLE_SLACK) {
        const shift = clamp(lag, -FRAME_SETTLE_PACE * dt, FRAME_SETTLE_PACE * dt), fwd = forward(reg.facing)
        reg.anchorX = clamp(reg.anchorX - fwd.x * shift, 3, MAP_WIDTH - 3)
        reg.anchorY = clamp(reg.anchorY - fwd.y * shift, 3, MAP_HEIGHT - 3)
      }
    } else {
      const dx = reg.destX - reg.anchorX
      const dy = reg.destY - reg.anchorY
      const distance = Math.hypot(dx, dy)
      const meleeAttack = reg.order === 'attack' && !firesMissiles(reg)
      if (!meleeAttack && distance <= PLACE_RADIUS) {
        relaid = settleAtDest(reg)
        reg.anchorSpeed = reg.bodySpeed
      } else if (distance > 0.25) {
        relaid = march(battle, reg, def, Math.atan2(dy, dx), distance, dt, 0.2)
      } else {
        reg.anchorSpeed = approach(reg.anchorSpeed, 0, accelRate(def, false), dt)
      }
      if (reg.anchorSpeed < 0.28) reg.stationaryTime += dt
      else reg.stationaryTime = 0
    }
    if (relaid) {
      reg.frameVx = 0
      reg.frameVy = 0
      reg.turnRate = 0
    } else {
      reg.frameVx = (reg.anchorX - ox) / dt
      reg.frameVy = (reg.anchorY - oy) / dt
      reg.turnRate = angDiff(oFacing, reg.facing) / dt
    }
  }
}

/**
 * March the block toward a heading. The frame does not wait for the ranks to form before it sets off: it
 * slows down while soldiers are strung out behind it, and goes a little easier while the block is still
 * re-forming. Returns true when the block was re-laid.
 *
 * Foot walk straight at the destination and turn the block as they go, as fast as the outer flank can keep
 * up by jogging; they may march obliquely to keep the facing they were given. Horses wheel the block, and the
 * wheel never makes the inner flank walk backward. Past REFORM_TURN nobody wheels: the block re-forms facing
 * the new way, and foot do it without stopping.
 */
function march(battle: Battle, reg: Regiment, def: UnitDef, heading: number, distance: number, dt: number, minCohesion: number): boolean {
  const mapInset=3
  const footed = def.turnRadius === 0
  const aim = travelFacing(def, reg.destFacing, heading)
  const err = angDiff(reg.facing, aim)
  const closing = reg.order === 'attack' && !firesMissiles(reg) && distance < releaseRange(def) * 2
  if (!closing && Math.abs(err) > REFORM_TURN) {
    if (footed) {
      reformMoving(reg, reg.files, aim)
    } else {
      reformAt(reg, reg.files, heading)
      reg.anchorSpeed = 0
    }
    return true
  }
  const wait = reg.plow > 0 ? 30 : 4
  const keepUp = closing ? 1 : reg.trail > wait ? 0 : clamp(1 - (reg.trail - 1.5) / 3, minCohesion, 1)
  const settling = closing ? 1 : clamp(1.1 - reg.lag / 16, 0.75, 1)
  const top = moveSpeedOf(reg) * keepUp * settling
  const lever = halfWidth(reg)
  if (footed) {
    const maxOmega = Math.min(def.turnCap, ((catchUpOf(reg, def) - 1) * moveSpeedOf(reg)) / lever)
    const wantOmega = Math.abs(err) < 0.01 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
    reg.facing += approach(reg.turnRate, wantOmega, maxOmega * 2, dt) * dt
    reg.anchorSpeed = approach(reg.anchorSpeed, top, top > reg.anchorSpeed ? surgeRate(def, reg.anchorSpeed, moveSpeedOf(reg)) : accelRate(def, false), dt)
    const stepDist = Math.min(reg.anchorSpeed * dt, distance)
    reg.anchorX = clamp(reg.anchorX + Math.cos(heading) * stepDist, mapInset, MAP_WIDTH - mapInset)
    reg.anchorY = clamp(reg.anchorY + Math.sin(heading) * stepDist, mapInset, MAP_HEIGHT - mapInset)
    return false
  }
  const maxOmega = Math.min(top / (2 * lever), (reg.anchorSpeed + 0.3) / lever)
  const wantOmega = Math.abs(err) < 0.02 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
  const omega = clamp(approach(reg.turnRate, wantOmega, Math.max(0.05, maxOmega * 1.5), dt), -maxOmega, maxOmega)
  let target = Math.max(0, top - Math.abs(omega) * lever)
  if (reg.plow > 0) target = Math.min(target, Math.sqrt(2 * accelRate(def, false) * distance))
  reg.anchorSpeed = approach(reg.anchorSpeed, target, target > reg.anchorSpeed ? surgeRate(def, reg.anchorSpeed, moveSpeedOf(reg)) : accelRate(def, false), dt)
  reg.facing += omega * dt
  const fwd = forward(reg.facing)
  const stepDist = reg.plow > 0 ? reg.anchorSpeed * dt : Math.min(reg.anchorSpeed * dt, distance)
  reg.anchorX = clamp(reg.anchorX + fwd.x * stepDist, mapInset, MAP_WIDTH - mapInset)
  reg.anchorY = clamp(reg.anchorY + fwd.y * stepDist, mapInset, MAP_HEIGHT - mapInset)
  return false
}

/** Close to the destination the frame is laid down at its final place; soldiers walk there one by one. */
function settleAtDest(reg: Regiment): boolean {
  const alive = Math.max(1, reg.aliveCount)
  const want = clamp(reg.destFiles, 1, alive)
  const have = clamp(reg.files, 1, alive)
  const fitted = fitOnMap(reg, reg.destX, reg.destY, reg.destFacing, want)
  reg.destX = fitted.x
  reg.destY = fitted.y
  const offset = Math.hypot(reg.destX - reg.anchorX, reg.destY - reg.anchorY)
  const turn = Math.abs(angDiff(reg.facing, reg.destFacing))
  if (offset < 1e-3 && turn < 1e-3 && want === have) return false
  if (turn >= REFORM_TURN || want !== have) {
    if (offset < 0.5) {
      reformAt(reg, want, reg.destFacing)
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
    } else {
      reformAt(reg, want, reg.destFacing, reg.destX, reg.destY)
    }
  } else {
    reg.anchorX = reg.destX
    reg.anchorY = reg.destY
    reg.facing = reg.destFacing
  }
  reg.destFiles = reg.files
  return true
}

function buildLive(battle: Battle, pad: Scratch): Live[] {
  const live = pad.live
  pad.indexOf.clear()
  let count = 0
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      const item = live[count]
      if (item) {
        item.s = soldier
        item.reg = reg
        item.def = def
      } else {
        live[count] = { s: soldier, reg, def }
      }
      pad.indexOf.set(soldier.id, count)
      count += 1
    }
  }
  live.length = count
  return live
}

function fillGrid(pad: Scratch, live: Live[], withSides=true): Spatial {
  const grid = pad.spatial
  grid.clear()
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    if (!item.s.alive) continue
    const side=withSides?item.reg.side:undefined,wide=wideBody(item.def)
    if (item.def.shape === 'capsule') {
      for (const point of shapePoints(item.s, item.def)) grid.insert(point.x, point.y, i,side,item.def.radius,wide)
    } else {
      grid.insert(item.s.x, item.s.y, i,side,item.def.radius,wide)
    }
  }
  return grid
}

/** Bodies bigger than a man on foot are filed as wide, so a few of them do not widen every man's searches. */
function wideBody(def: UnitDef): boolean {
  return def.shape === 'capsule' || def.physicalSize > 1
}

/** From a body's centre to the far side of its farthest shape circle. */
function bodyExtent(def: UnitDef): number {
  return def.shape === 'capsule' ? def.radius + Math.max(0, (def.length - def.radius * 2) / 2) : def.radius
}

/** Every enemy body whose shape circles may lie within `gap` of this body's shape circles. The radius comes
 * from the bodies actually on the field (and how far they have moved since the grid was filled), so large
 * and capsule bodies are never missed and small ones search no further than they can touch. */
function queryContacts(grid: Spatial, x: number, y: number, def: UnitDef, side: Side, gap: number, out: number[]): void {
  const foe = side === 0 ? 1 : 0, reach = grid.reach[foe], own = gap + bodyExtent(def) + 1e-6
  grid.queryWide(x, y, own + reach.narrow + reach.narrowDrift, own + reach.wide + reach.wideDrift, out, foe)
}

/** Record how far a body has moved since the grid was filled, so later contact searches still find it. */
function noteDrift(grid: Spatial, item: Live, x: number, y: number, facing: number): void {
  const {s,def}=item
  const dx=s.x-x,dy=s.y-y
  let moved=Math.sqrt(dx*dx+dy*dy)
  if(def.shape==='capsule'&&s.facing!==facing) moved+=Math.max(0,(def.length-def.radius*2)/2)*Math.hypot(Math.cos(s.facing)-Math.cos(facing),Math.sin(s.facing)-Math.sin(facing))
  const reach=grid.reach[item.reg.side]
  if(wideBody(def)) { if(moved>reach.wideDrift) reach.wideDrift=moved }
  else if(moved>reach.narrowDrift) reach.narrowDrift=moved
}

function moveSoldiers(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  const grid = fillGrid(pad, live)
  const buf = pad.buf
  const lagSum = new Map<Regiment, SlotTally>()
  const speedSum = new Map<Regiment, number>()
  const press: Press = { live, grid, buf, files: new Map() }
  for (const reg of battle.regiments) {
    reg.nearEnemy = false
    lagSum.set(reg, { total: 0, trail: 0, count: 0, front: 0, frontCount: 0 })
  }
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    const { s, reg, def } = item
    const nearby = reg.routing?null:nearestEnemy(live, grid, buf, i, def.reach + 0.5, reg.order === 'hold')
    const foe = reg.retargeting ? nearestEnemy(live,grid,buf,i,def.reach+0.5,false,reg.targetId) : nearby
    const gapToFoe = foe ? gapBetween(s, def, foe.s, foe.def) : Infinity
    if (foe) reg.nearEnemy = true
    const enemyNear = !!nearby && gapBetween(s,def,nearby.s,nearby.def)<=def.reach && (!reg.retargeting || nearby.reg.id!==reg.targetId)
    const touching = gapToFoe <= 0.15
    if ((reg.order !== 'move' && !reg.retargeting) || reg.routing) {
      s.leaving = false
      s.disengage = 0
    } else if (enemyNear) {
      if (!s.leaving) {
        s.leaving = true
        s.disengage = firesMissiles(reg) ? 0.5 : 2
      }
    } else {
      s.leaving = false
      s.disengage = 0
    }
    if (s.disengage > 0) s.disengage = Math.max(0, s.disengage - dt)

    const localMelee = !!foe && gapToFoe <= def.reach
    const groundPace = moveSpeedOf(reg, s)
    // Only bodies already in weapon reach use melee approach speed. A front
    // rank's contact must not slow distant ranks or detached individual models.
    let gait = localMelee && reg.engaged && !reg.retargeting && def.category !== 'chariot' && reg.order !== 'move' && !reg.routing ? Math.min(2, groundPace) : groundPace
    if(def.category==='chariot' && nearby && nearby.def.physicalSize<=1 && gapBetween(s,def,nearby.s,nearby.def)<0.3 && s.speed<5 && s.plowLeft<=0) gait=Math.min(gait,MECHANICS.cartShoveSpeed)
    const lever = turnLever(def)
    const ox = s.x
    const oy = s.y
    const of = s.facing
    const fighting = localMelee && reg.engaged && reg.plow <= 0 && !firesMissiles(reg) && !reg.routing && s.down <= 0
    const frontRank = s.rank === 0
    const runningIn = reg.order === 'attack' && !firesMissiles(reg) && !reg.engaged
    const inFight = !!foe && reg.order !== 'move' && reg.plow <= 0 && !reg.routing && gapToFoe <= (runningIn ? 0.15 : def.reach)
    const attackRun = frontRank && reg.order === 'attack' && !firesMissiles(reg) && reg.plow <= 0 && !reg.routing && s.down <= 0
    if (frontRank && inFight && s.down <= 0) {
      // Where the enemy holds the front rank is where the line stands: see the engaged frame in moveRegiments.
      const slot = slotOf(reg, def, s.file, s.rank), tally = lagSum.get(reg)!
      tally.front += (slot.x - s.x) * Math.cos(reg.facing) + (slot.y - s.y) * Math.sin(reg.facing)
      tally.frontCount += 1
    }
    // Turning on the spot to face an enemy already at weapon's length is standing one's ground, not moving off it.
    let facingFoe = false
    if (s.down > 0) {
      lieDown(s, dt)
    } else if(reg.routing) {
      fleeSoldier(battle,reg,def,s,gait,lever,dt)
    } else if (s.plowLeft > 0 && def.category !== 'chariot') {
      coast(s, dt)
    } else if (def.category==='chariot' && (reg.order==='move'||(reg.order==='attack'&&!firesMissiles(reg))) && !reg.routing) {
      if(reg.order==='attack') driveChariot(battle,reg,def,s,gait,lever,dt)
      else {
        const frame={...reg,anchorX:reg.destX,anchorY:reg.destY,facing:reg.destFacing}
        const goal=slotOf(frame,def,s.file,s.rank,s.centerIndex)
        const distance=Math.hypot(goal.x-s.x,goal.y-s.y)
        if(distance<0.22) standBy(frame,def,s,gait,lever,dt,accelRate(def,false))
        else steer(def,s,Math.atan2(goal.y-s.y,goal.x-s.x),gait,gait,lever,dt,distance,distance)
      }
    } else if (s.swing && !reg.wantCharge && reg.plow<=0 && !(def.physicalSize>=2 && s.speed>5) && reg.order !== 'move' && !reg.routing) {
      s.speed = 0
      s.omega = 0
      s.idle = false
    } else if (fighting && foe && frontRank) {
      closeIn(def, s, foe, gapToFoe, gait, lever, dt)
      facingFoe = true
    } else if (inFight && foe) {
      rotate(def, s, angDiff(s.facing, Math.atan2(foe.s.y - s.y, foe.s.x - s.x)), gait, lever, dt)
      s.speed = 0
      s.idle = false
      facingFoe = true
    } else if (attackRun && runIn(live, grid, buf, i, gait, lever, dt)) {
      // The front rank closed the last strides on the enemy ahead of it.
    } else {
      // Everyone else has one place to be: his slot. Nobody leaves the ranks to look for an enemy of his own.
      followSlot(reg, def, s, gait, lever, dt, fighting, lagSum.get(reg)!,press)
    }
    if(s.down<=0) moveGroundDrift(s,dt)
    noteDrift(grid, item, ox, oy, of)
    s.vx = (s.x - ox) / dt
    s.vy = (s.y - oy) / dt
    s.braceTime = Math.hypot(s.vx,s.vy) < 0.25 && (facingFoe || Math.abs(s.omega) < MECHANICS.braceTurnRate) && s.down <= 0 ? s.braceTime + dt : 0
    const moved = speedSum.get(reg) ?? 0
    speedSum.set(reg, moved + Math.hypot(s.vx, s.vy))
  }
  for (const reg of battle.regiments) {
    const sum = lagSum.get(reg)!
    reg.lag = sum.count > 0 ? sum.total / sum.count : 0
    reg.trail = sum.count > 0 ? sum.trail / sum.count : 0
    reg.bodySpeed = reg.aliveCount > 0 ? (speedSum.get(reg) ?? 0) / reg.aliveCount : 0
    frontLag.set(reg, sum.frontCount > 0 ? sum.front / sum.frontCount : 0)
    if(reg.routing&&reg.aliveCount>0) {
      const center=aliveCenter(reg)!
      reg.anchorX=reg.destX=center.x;reg.anchorY=reg.destY=center.y
    }
  }
}

/**
 * One routing soldier's own sway phase (radians) and pace (0..1), fixed for this rout. Identity-derived, so it is
 * repeatable and does not consume combat RNG. A full-avalanche finaliser (murmur3 fmix32) keeps neighbouring
 * soldier ids, which follow file order, from running at almost the same speed and angle.
 */
export function routJitter(seed:number,soldierId:number,routCount:number):{phase:number;pace:number} {
  let hash=(soldierId^seed^Math.imul(routCount,0x9e3779b9))>>>0
  hash^=hash>>>16;hash=Math.imul(hash,0x85ebca6b)
  hash^=hash>>>13;hash=Math.imul(hash,0xc2b2ae35)
  hash=(hash^(hash>>>16))>>>0
  return {phase:(hash&0xffff)/0xffff*Math.PI*2,pace:(hash>>>16)/0xffff}
}

/** Individuals stream in one direction, with smooth differences instead of ranks. */
function fleeSoldier(battle:Battle,reg:Regiment,def:UnitDef,s:Soldier,gait:number,lever:number,dt:number):void {
  const {phase,pace}=routJitter(battle.seed,s.id,reg.routCount)
  const heading=reg.facing+(pace-.5)*.3+Math.sin(battle.time*.85+phase)*.1
  const speed=gait*(.84+pace*.32+Math.sin(battle.time*.6+phase)*.035)
  s.idle=false
  steer(def,s,heading,speed,speed,lever,dt,Infinity,30,false)
}

/**
 * How close infantry and cavalry get before leaving their formation to close in.
 * Attacking chariots use their independent body steering instead.
 */
function releaseRange(def: UnitDef): number {
  return Math.max(5, def.chargeSpeed * 1.3)
}

/** An attacking chariot regiment's marker turns toward its target only while their middles are this far apart. */
const CART_FRAME_APART = 12

/** Attack with each cart's actual body, without formation or cohesion steering. */
function driveChariot(battle: Battle, reg: Regiment, def: UnitDef, s: Soldier, gait: number, lever: number, dt: number): void {
  s.idle=false
  if (s.plowLeft>0) {
    const dx=s.plowX-s.x, dy=s.plowY-s.y
    // Ploughing runs on the momentum left after each ram: the cart rolls on toward its overrun point, never faster.
    if (s.speed>=PLOUGH_END && Math.hypot(dx,dy)>0.4 && dx*Math.cos(s.facing)+dy*Math.sin(s.facing)>0) {
      const distance=Math.hypot(dx,dy)
      steer(def,s,Math.atan2(dy,dx),Math.min(s.speed,gait,Math.sqrt(2*accelRate(def,false)*distance)),gait,lever,dt,distance,distance)
      return
    }
    // Out of momentum while still among the men it was throwing: the charge is spent here.
    if (s.speed<PLOUGH_END && s.contactTime>0) s.chargeSpent=true
    s.plowLeft=0
  }
  const target=reg.targetId===null?null:regimentById(battle,reg.targetId)
  let pick: Soldier | null=null, distance=Infinity
  for (const foe of target?.soldiers ?? []) {
    if (!foe.alive) continue
    const d=Math.hypot(foe.x-s.x,foe.y-s.y)
    if (d<distance) { pick=foe; distance=d }
  }
  if (!pick) { standBy(reg,def,s,gait,lever,dt,accelRate(def,false)); return }
  steer(def,s,Math.atan2(pick.y-s.y,pick.x-s.x),gait,gait,lever,dt,distance,distance,false)
}

/**
 * A front-rank man on the attack takes his eyes off his place for an enemy this far beyond his weapon's reach: a few
 * strides, or as far as he would need to pull up from the pace he is going at. Whoever could not stop short of the
 * enemy anyway carries his charge home, wherever the rest of his line has been stopped...
 */
function engageRange(def: UnitDef, s: Soldier): number {
  return Math.max(1.5 + def.chargeSpeed * 0.2, s.speed * s.speed / (2 * accelRate(def, false)))
}
/** ...and within this angle of the way he faces: the man in front of him, not one off to a side. */
const ENGAGE_CONE = 35 * DEG

/**
 * The last strides of an attack (RULES 三.3). A front-rank man with a standing enemy just ahead of him runs straight at
 * that enemy at his attacking pace, so the two front ranks meet man to man along the whole line and a charge arrives
 * at speed. This is the only time anyone leaves his place for an enemy, and only the front rank does: whoever stands
 * in the way takes the attack, whatever regiment he belongs to. Returns false when there is nobody to run at.
 */
function runIn(live: Live[], grid: Spatial, buf: number[], index: number, gait: number, lever: number, dt: number): boolean {
  const { s, reg, def } = live[index]
  const foe = nearestEnemy(live, grid, buf, index, def.reach + engageRange(def, s), false, reg.retargeting ? reg.targetId : null, ENGAGE_CONE)
  if (!foe) return false
  const distance = Math.hypot(foe.s.x - s.x, foe.s.y - s.y)
  s.idle = false
  steer(def, s, Math.atan2(foe.s.y - s.y, foe.s.x - s.x), gait, gait, lever, dt, distance, distance)
  return true
}

/** What a man's movement looks up this step: the bodies about him and who stands where in each regiment's files. */
interface Press {
  live: Live[]
  grid: Spatial
  buf: number[]
  files: Map<Regiment, Map<number, Soldier>>
}

/** How much of its file's stagger each rank takes in a charge: the front rank all of it, the fourth and deeper next to none. */
const STAGGER_BY_RANK = [1, 0.6, 0.3, 0.1]

/** -1..1: how far ahead of (or behind) its place a file runs in this regiment's present charge. Fixed for the order, so no file wavers. */
function fileStagger(reg: Regiment, file: number): number {
  let hash = (Math.imul(file + 1, 0x9e3779b1) ^ Math.imul(reg.id + 1, 0x85ebca6b) ^ Math.imul(reg.orderSerial + 1, 0xc2b2ae35)) >>> 0
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x2c1b3c6d); hash ^= hash >>> 12
  return ((hash >>> 0) & 0xffff) / 0x7fff - 1
}

/** A man keeps this share of his rank spacing behind the comrade ahead of him in his file. */
const FILE_KEEP = 0.9
const FILE_KEY = 4096

/** The living man one rank ahead in the same file, if there is one. The centred short last rank has no file to follow. */
function fileLeader(press: Press, reg: Regiment, s: Soldier): Soldier | undefined {
  let files = press.files.get(reg)
  if (!files) {
    files = new Map()
    for (const mate of reg.soldiers) if (mate.alive && mate.centerIndex < 0) files.set(mate.rank * FILE_KEY + mate.file, mate)
    press.files.set(reg, files)
  }
  return files.get((s.rank - 1) * FILE_KEY + s.file)
}

/**
 * Walk toward a slot that may itself be moving. The soldier aims at where the slot is going, not just where
 * it is, so a man already in step simply keeps pace. Men who have fallen behind their mates jog to catch up.
 * A slot that is only a pace behind is waited for rather than turned around for; in a melee a man never
 * turns his back to walk to a slot behind him. On the march a man whose slot is behind him keeps moving
 * forward, only slower, and lets the block come up to him, so a re-forming block flows into shape as it goes.
 */
function followSlot(
  reg: Regiment,
  def: UnitDef,
  s: Soldier,
  gait: number,
  lever: number,
  dt: number,
  holdGround: boolean,
  tally: SlotTally,
  press: Press,
): void {
  const slot = slotOf(reg, def, s.file, s.rank, s.centerIndex)
  if (reg.ragged > 0 && s.centerIndex < 0 && reg.files > 1) {
    // A charging line is not dressed (RULES 三.2): each file runs a little ahead of its place or a little behind it,
    // the same for the whole charge, and the men behind the first rank follow their file leader by less and less.
    // A single file, or a single body, has no line to be out of.
    const lead = fileStagger(reg, s.file) * MECHANICS.chargeStagger * Math.min(def.rankSpacing, MECHANICS.staggerSpacing) * reg.ragged * STAGGER_BY_RANK[Math.min(s.rank, STAGGER_BY_RANK.length - 1)]
    slot.x += Math.cos(reg.facing) * lead; slot.y += Math.sin(reg.facing) * lead
  }
  if (s.rank > 0 && s.centerIndex < 0 && (reg.inContact || reg.engaged) && reg.order !== 'move' && !reg.routing) {
    // In a fight a man stands behind the comrade ahead of him in his file (RULES 三.3). While that man is held up
    // short of his own place, the place behind him is as far forward as anyone in the file goes: the rear ranks
    // wait their turn instead of pressing into his back or slipping past him into the fight. The file is his own
    // regiment's only: men of another regiment sent at the same enemy come through and stack in among them.
    const leader = fileLeader(press, reg, s)
    if (leader && leader.down <= 0) {
      const fx = Math.cos(reg.facing), fy = Math.sin(reg.facing)
      const room = (leader.x - slot.x) * fx + (leader.y - slot.y) * fy - def.rankSpacing * FILE_KEEP
      if (room < 0) { slot.x += fx * room; slot.y += fy * room }
    }
  }
  const ex = slot.x - s.x
  const ey = slot.y - s.y
  const distance = Math.hypot(ex, ey)
  const frameSpeed = Math.hypot(reg.frameVx, reg.frameVy)
  const marching = frameSpeed > 0.3 ? frameSpeed : 0
  const fwd = marching > 0 ? { x: reg.frameVx / frameSpeed, y: reg.frameVy / frameSpeed } : forward(reg.facing)
  const ahead = ex * fwd.x + ey * fwd.y
  tally.total += distance
  tally.trail += Math.max(0, ahead)
  tally.count += 1
  const rx = slot.x - reg.anchorX
  const ry = slot.y - reg.anchorY
  const slotVx = reg.frameVx - reg.turnRate * ry
  const slotVy = reg.frameVy + reg.turnRate * rx
  const slotSpeed = Math.hypot(slotVx, slotVy)
  const still = slotSpeed < 0.05
  const brake = accelRate(def, false)
  // A cart cannot shuffle sideways; closing a near miss would take a full loop on its turning circle.
  const parked = def.category === 'chariot' && distance < CART_PARK

  if (still && (distance < 0.08 || (s.idle && distance < 0.16) || parked)) {
    s.idle = true
    standBy(reg, def, s, gait, lever, dt, brake)
    return
  }
  s.idle = false

  const jog = catchUpOf(reg, def)
  const straggling = clamp((distance - reg.lag + 0.15) / 1.2, 0, 1)
  const behind = still ? straggling : Math.max(straggling, clamp((distance - 0.3) / 1.5, 0, 1))
  const top = gait * (1 + (jog - 1) * behind)
  const pull = distance > 1e-6 ? Math.min(top, Math.sqrt(2 * brake * distance), distance * 4) / distance : 0
  let vx = slotVx + ex * pull
  let vy = slotVy + ey * pull
  if (marching > 0 && !holdGround) {
    const along = vx * fwd.x + vy * fwd.y
    const across = Math.abs(vx * fwd.y - vy * fwd.x)
    const least = Math.max(ahead < -0.5 ? marching * 0.7 : -Infinity, across * FALL_IN_SLOPE) - along
    if (least > 0) {
      vx += fwd.x * least
      vy += fwd.y * least
    }
  }
  const want = Math.hypot(vx, vy)
  if (want > top) {
    vx *= top / want
    vy *= top / want
  }
  let heading = Math.atan2(vy, vx)
  // Friends in the way are walked through, on a march or an attack alike, whether they stand idle or are fighting:
  // nobody goes round them, and two regiments sent at one enemy end up stacked on the same ground.
  if((reg.order==='move'||reg.order==='attack')&&!reg.routing&&def.physicalSize<=1&&distance>.25) heading=friendlyHeading(reg,def,s,heading,distance,press)
  const behindMe = Math.abs(angDiff(s.facing, heading)) > 100 * DEG
  if (behindMe && (distance < (still ? 0.05 : 0.9) || (holdGround && distance < 3))) {
    standBy(reg, def, s, gait, lever, dt, brake)
    return
  }
  if (still && def.turnRadius === 0 && distance < BACK_STEP_RANGE && Math.abs(angDiff(reg.facing, heading)) > 100 * DEG) {
    backStep(reg, def, s, heading, Math.min(want, gait * BACK_STEP_PACE), gait, lever, dt, distance)
    return
  }
  steer(def, s, heading, Math.min(want, top), top, lever, dt, distance + slotSpeed * dt + 0.02, distance)
}

/** Short-range cooperative weaving through allied files, using physical widths.
 * A common passing side prevents adjacent files from picking the same gap. */
function friendlyHeading(reg:Regiment,def:UnitDef,s:Soldier,heading:number,distance:number,press:Press):number {
  const look=Math.min(distance,Math.max(.8,Math.min(1.5,s.speed*.4+.7)))
  press.grid.query(s.x,s.y,look+1.2,press.buf,reg.side)
  const friends=press.buf.filter(index=> {
    const other=press.live[index]
    return other.reg!==reg&&other.reg.side===reg.side&&other.s.alive&&other.s.down<=0
  })
  if(!friends.length) return heading
  if(!s.avoidSide) s.avoidSide=1
  let best=heading,bestCost=Infinity
  for(const degrees of [0,20,-20,40,-40,60,-60,80,-80]) {
    const angle=heading+degrees*DEG,fx=Math.cos(angle),fy=Math.sin(angle)
    let cost=(1-Math.cos(degrees*DEG))*.6+(degrees===0||Math.sign(degrees)===s.avoidSide?0:.08)
    for(const index of friends) {
      const other=press.live[index]
      const dx=other.s.x-s.x,dy=other.s.y-s.y,ahead=dx*fx+dy*fy
      if(ahead<-.05) continue
      if(other.s.vx*fx+other.s.vy*fy>s.speed+.3) continue
      const along=clamp(ahead,0,look)
      const gap=Math.hypot(dx-fx*along,dy-fy*along)
      const width=collisionRadius(def)+collisionExtent(other.def)+MECHANICS.contactPadding
      if(gap<width) cost+=4*(1-gap/width)
    }
    if(cost<bestCost) {bestCost=cost;best=angle}
  }
  return best
}

/** A standing cart this close to its slot stays put. Wider than the arrival tolerance, so an arrived line never loops. */
const CART_PARK = 0.35

/** A man on foot this close to a slot behind a standing block backs into it rather than turning his back. */
const BACK_STEP_RANGE = 12
/** Backing up goes at this share of the walking pace. */
const BACK_STEP_PACE = 0.7

/** Shuffle back toward a slot while turning to face the block's front, so a block never stands facing out. */
function backStep(
  reg: Regiment,
  def: UnitDef,
  s: Soldier,
  heading: number,
  pace: number,
  gait: number,
  lever: number,
  dt: number,
  distance: number,
): void {
  rotate(def, s, angDiff(s.facing, reg.facing), gait, lever, dt)
  s.speed = approach(s.speed, 0, accelRate(def, false), dt)
  const stride = Math.min(pace * dt, distance)
  s.x += Math.cos(heading) * stride
  s.y += Math.sin(heading) * stride
}

/** How much faster than the marching pace a man out of place may go to reach his slot. */
function catchUpOf(reg: Regiment, def: UnitDef): number {
  if (reg.braceSlow > 0 || (reg.bogged && reg.order !== 'move')) return 1
  if (reg.wantCharge) return 1.15
  return Math.max(1.5, def.chargeSpeed / def.speed)
}

/** On the march men close in on their slots at most 60° off the line of march: they ease over, never sidestep. */
const FALL_IN_SLOPE = 1 / Math.tan(60 * DEG)

interface SlotTally {
  total: number
  trail: number
  count: number
  /** Sum and count, over the front-rank men in a fight, of how far behind their slots they stand along the facing. */
  front: number
  frontCount: number
}

function atSlot(reg: Regiment, def: UnitDef, s: Soldier): boolean {
  const slot = slotOf(reg, def, s.file, s.rank, s.centerIndex)
  return Math.hypot(slot.x - s.x, slot.y - s.y) < 0.35
}

/** Slide along the throw, then come to rest. Getting up is the icon fading back in. */
function lieDown(s: Soldier, dt: number): void {
  s.down = Math.max(0, s.down - dt)
  s.speed = 0
  s.omega = 0
  s.idle = false
  s.x += s.knockVx * dt
  s.y += s.knockVy * dt
  const drag = Math.exp(-1.8 * dt)
  const grounded=groundDrag(s.knockVx*drag,s.knockVy*drag,MECHANICS.downFriction,dt)
  s.knockVx=grounded.x;s.knockVy=grounded.y
  s.pushVx=0;s.pushVy=0
  if (s.down === 0) {
    s.knockVx = 0
    s.knockVy = 0
  }
}

/** Melee gap a man steps in to. Close enough to look like a fight, not so close that lines push each other. */
const CLOSE_GAP = 0.2

/** In a melee: step up to the nearest enemy within reach, then stand and face him. Never shoves past. */
function closeIn(def: UnitDef, s: Soldier, foe: Live, gap: number, gait: number, lever: number, dt: number): void {
  s.idle = false
  const to = Math.atan2(foe.s.y - s.y, foe.s.x - s.x)
  if (gap <= CLOSE_GAP) {
    rotate(def, s, angDiff(s.facing, to), gait, lever, dt)
    s.speed = 0
    return
  }
  const room = gap - CLOSE_GAP
  const want = Math.min(gait * 0.5, Math.sqrt(2 * accelRate(def, false) * room))
  steer(def, s, to, want, gait, lever, dt, room, room)
}

/** Face the regiment's front and coast to a stop. */
function standBy(reg: Regiment, def: UnitDef, s: Soldier, gait: number, lever: number, dt: number, brake: number): void {
  rotate(def, s, angDiff(s.facing, reg.facing), gait, lever, dt)
  s.speed = approach(s.speed, 0, brake, dt)
  if (s.speed <= 0) return
  const fwd = forward(s.facing)
  s.x += fwd.x * s.speed * dt
  s.y += fwd.y * s.speed * dt
}

/**
 * The fastest a body can turn right now. Walking speed and the sweep of the turn share the top speed.
 * Horses and chariots also need to be rolling to turn well: standing, they only shuffle round slowly.
 */
function turnCapOf(def: UnitDef, speed: number, top: number, lever: number): number {
  const budget = Math.max(0, top - speed) / Math.max(0.25, lever)
  const rolling = def.turnRadius > 0 ? def.pivotRate + speed / def.turnRadius : def.turnCap
  return Math.min(def.turnCap, budget, rolling)
}

/**
 * Turn by `err` with angular inertia: the turn builds up, then eases off so it stops on target.
 * Returns the turn speed this body wanted, before inertia held it back.
 */
function rotate(def: UnitDef, s: Soldier, err: number, top: number, lever: number, dt: number): number {
  const cap = turnCapOf(def, s.speed, top, lever)
  const easing = Math.sqrt(2 * def.turnAccel * Math.abs(err))
  const want = Math.abs(err) < 0.01 ? 0 : Math.sign(err) * Math.min(cap, easing)
  s.omega = approach(s.omega, want, def.turnAccel, dt)
  s.facing += s.omega * dt
  return want
}

/**
 * Fastest forward speed at which the arc onto a point `distance` away and `err` off the nose can still be
 * turned. Without this a horse or chariot circles a nearby spot forever instead of slowing down to turn in.
 */
function arcSpeed(def: UnitDef, err: number, distance: number): number {
  const curvature = (2 * Math.sin(Math.min(Math.abs(err), Math.PI / 2))) / Math.max(0.05, distance)
  if (curvature < 1e-4) return Infinity
  let limit = (def.turnCap * 0.8) / curvature
  if (def.turnRadius > 0) {
    const excess = curvature - 1 / def.turnRadius
    if (excess > 0) limit = Math.min(limit, (def.pivotRate * 0.8) / excess)
  }
  return limit
}

/**
 * Turn toward a heading and walk forward only. A man at full stride has to slow down before he can turn hard.
 * Mounted bodies far from where they are going keep rolling through a wide turn instead of stopping to pivot.
 */
function steer(
  def: UnitDef,
  s: Soldier,
  heading: number,
  want: number,
  top: number,
  lever: number,
  dt: number,
  maxStep: number,
  distance: number,
  stopAtGoal = true,
): void {
  if(def.category==='chariot') {
    steerCart(def,s,heading,want,top,dt,maxStep,distance,stopAtGoal)
    return
  }
  const safeLever = Math.max(0.25, lever)
  const err = angDiff(s.facing, heading)
  const wantOmega = rotate(def, s, err, top, lever, dt)
  // Finish the existing 0.01-radian steering dead zone once angular inertia
  // can stop this step. Otherwise its leftover error permanently reduces the
  // forward target by cos(error), so a straight approach never reaches cruise.
  const aligned = Math.abs(angDiff(s.facing, heading)) < 0.01 && Math.abs(s.omega) <= def.turnAccel * dt
  if (aligned) { s.facing += angDiff(s.facing, heading); s.omega = 0 }
  let target = Math.abs(err) >= Math.PI / 2 ? 0 : Math.max(0, Math.min(want, top - Math.abs(wantOmega) * safeLever)) * (aligned ? 1 : Math.cos(err))
  if (def.turnRadius > 0 && Math.abs(err) > 30 * DEG && distance > def.turnRadius * 1.5) {
    const cruise = ((top * def.turnRadius) / (def.turnRadius + safeLever)) * 0.75
    target = Math.max(target, Math.min(cruise, want))
  }
  target = Math.min(target, arcSpeed(def, err, distance))
  s.speed = approach(s.speed, target, target > s.speed ? surgeRate(def, s.speed, top) : accelRate(def, false), dt)
  if (s.speed <= 0) return
  const fwd = forward(s.facing)
  const stepDist = Math.min(s.speed * dt, maxStep)
  s.x += fwd.x * stepDist
  s.y += fwd.y * stepDist
}

/** A wheeled vehicle steers through forward travel; angular speed is bounded by
 * speed / turning radius. Nearby goals never turn a large heading error into a pivot. */
function steerCart(def:UnitDef,s:Soldier,heading:number,want:number,top:number,dt:number,maxStep:number,distance:number,stopAtGoal:boolean):void {
  const err=angDiff(s.facing,heading),angle=Math.abs(err),radius=Math.max(0.5,def.turnRadius)
  const goalX=s.x+Math.cos(heading)*distance,goalY=s.y+Math.sin(heading)*distance
  if(s.cartPath&&Math.hypot(goalX-s.cartPath.goalX,goalY-s.cartPath.goalY)>1.2) s.cartPath=null
  // While slowing to a tight-turn speed, the actual radius is still larger.
  // Keep the short arc rooted at the current rolling pose during this braking
  // phase instead of finishing a stale circle and taking a second full loop.
  if(s.cartPath&&s.speed>def.turnCap*radius+.05) s.cartPath=null
  // Braking from a fast approach can carry the vehicle outside its planned
  // circle. Replan after the arc if its tangent no longer faces the goal.
  if(s.cartPath&&s.cartPath.arcLeft<=.015&&angle>45*DEG) s.cartPath=null
  if(!s.cartPath&&angle>45*DEG&&distance>0.2) {
    // For each turning direction, find the forward tangent from a circle to the
    // goal. At least one circle contains no nonzero goal point in its interior.
    let best:Soldier['cartPath']=null,bestLength=Infinity
    for(const side of [1,-1]) {
      const cx=s.x-Math.sin(s.facing)*radius*side,cy=s.y+Math.cos(s.facing)*radius*side
      const dx=goalX-cx,dy=goalY-cy,d=Math.hypot(dx,dy)
      if(d<radius+1e-6) continue
      const tangent=Math.atan2(dy,dx)-side*Math.acos(radius/d)
      const start=s.facing-side*Math.PI/2
      const arc=((side*(tangent-start))%(Math.PI*2)+Math.PI*2)%(Math.PI*2)
      const length=arc*radius+Math.sqrt(Math.max(0,d*d-radius*radius))
      if(length<bestLength) {bestLength=length;best={goalX,goalY,side,radius,arcLeft:arc,straight:Math.sqrt(Math.max(0,d*d-radius*radius))}}
    }
    s.cartPath=best
  }
  const path=s.cartPath
  const turning=!!path&&path.arcLeft>0.015
  let desired=want
  if(turning) desired=Math.min(desired,def.turnCap*radius)
  const remaining=turning?path.arcLeft*radius+path.straight:distance
  if(stopAtGoal) desired=Math.min(desired,Math.sqrt(2*accelRate(def,false)*Math.max(0,remaining)))
  s.speed=approach(s.speed,desired,desired>s.speed?surgeRate(def,s.speed,top):accelRate(def,false),dt)
  const cap=Math.min(def.turnCap,s.speed/radius)
  let omega:number
  if(turning) omega=path.side*Math.min(cap,Math.sqrt(2*def.turnAccel*path.arcLeft))
  else omega=clamp(s.speed*2*Math.sin(err)/Math.max(distance,0.2),-cap,cap)
  const previous=s.facing
  s.omega=clamp(approach(s.omega,omega,def.turnAccel,dt),-cap,cap)
  s.facing+=s.omega*dt
  if(turning) path.arcLeft=Math.max(0,path.arcLeft-Math.max(0,path.side*angDiff(previous,s.facing)))
  const mid=previous+s.omega*dt/2
  const stride=turning?s.speed*dt:Math.min(s.speed*dt,Math.min(distance,maxStep))
  s.x+=Math.cos(mid)*stride;s.y+=Math.sin(mid)*stride
  if(!turning&&distance<0.2) {s.cartPath=null;s.speed=0}
}

function nearestEnemy(
  live: Live[],
  grid: Spatial,
  buf: number[],
  index: number,
  radius: number,
  passive = false,
  targetId: number | null = null,
  ahead = Math.PI,
): Live | null {
  const self = live[index]
  queryContacts(grid, self.s.x, self.s.y, self.def, self.reg.side, radius, buf)
  let best: Live | null = null
  let bestD = radius
  for (const otherIndex of buf) {
    const other = live[otherIndex]
    if (other.reg.side === self.reg.side || !other.s.alive || other.s.down > 0) continue
    if (targetId!==null && other.reg.id!==targetId) continue
    // Men running away hold nobody (RULES 三.3): they are cut at in passing, but nobody stops, turns or closes in for
    // them, unless their regiment is the one this regiment was sent after.
    if (other.reg.routing && other.reg.id !== self.reg.targetId) continue
    if(self.def.shape==='circle'&&other.def.shape==='circle') {
      const dx=other.s.x-self.s.x,dy=other.s.y-self.s.y,limit=bestD+self.def.radius+other.def.radius+1e-9
      if(limit<0||dx*dx+dy*dy>limit*limit) continue
    }
    if (passive && self.s.reactTo !== other.s.id && Math.abs(angDiff(self.reg.facing, Math.atan2(other.s.y - self.s.y, other.s.x - self.s.x))) > 70 * DEG) continue
    if (ahead < Math.PI && Math.abs(angDiff(self.s.facing, Math.atan2(other.s.y - self.s.y, other.s.x - self.s.x))) > ahead) continue
    const gap = gapBetween(self.s, self.def, other.s, other.def)
    if (gap < bestD) {
      best = other
      bestD = gap
    }
  }
  return best
}

function inAttackZone(attacker: Live, target: Live, facing: number, gap?:number): boolean {
  return target.s.alive && target.s.down <= 0 && (gap??gapBetween(attacker.s,attacker.def,target.s,target.def)) <= attacker.def.reach
    && Math.abs(angDiff(facing,Math.atan2(target.s.y-attacker.s.y,target.s.x-attacker.s.x))) <= attacker.def.attack.arc * DEG / 2
}

/** Own speed toward the other body, m/s, below which a body is the one run into rather than the one acting. */
const OWN_APPROACH = 1

/**
 * The one speed check of every speed-dependent contact (RULES 四.3): charge, collision attack, ram knockdown and being
 * run down. The closing speed of `actor` on `other` (both velocities projected on the line between them, approaching
 * positive) over the actor's effective charge speed, through speedPower: 0 means no effect, otherwise the effect's
 * strength, at most 1. Role guard, not a strength check: the actor must itself be moving toward the other at
 * OWN_APPROACH or more under its own power (external drift does not count), so a body that is run into never charges
 * or rams back, while two bodies running into each other both act.
 */
function contactPower(actor: Live, other: Live): number {
  const dx=other.s.x-actor.s.x, dy=other.s.y-actor.s.y, distance=Math.hypot(dx,dy)
  if (distance<=0) return 0
  const own=((actor.s.vx-actor.s.pushVx)*dx+(actor.s.vy-actor.s.pushVy)*dy)/distance
  if (own<OWN_APPROACH) return 0
  // The other body's own movement too: a man sliding back from a shove or a heavy blow has not run away from anything.
  return speedPower(own-((other.s.vx-other.s.pushVx)*dx+(other.s.vy-other.s.pushVy)*dy)/distance,effectiveChargeSpeed(actor.def,actor.reg.fatigue))
}

/**
 * Cavalry or a chariot has charged into a man on foot (RULES 七.1): counted for his regiment as a charge that went
 * home, or as one his charge defence stopped. updateMorale weighs the two.
 */
function mountedShock(attacker: Live, target: Live, stopped: boolean): void {
  const by=attacker.def.category, hit=target.def.category
  if (!(by==='cavalry'||by==='chariot') || !(hit==='infantry'||hit==='ranged') || target.def.physicalSize>1) return
  if (stopped) target.reg.stoppedHits++
  else target.reg.shockHits++
}

/** Squared speed of a body's own (powered) movement this step, without external drift. */
function ownSpeedSq(s: Soldier): number {
  const vx=s.vx-s.pushVx, vy=s.vy-s.pushVy
  return vx*vx+vy*vy
}

/** Two regiments touched in this step's contact pass: both are in contact, and each records the other as a melee foe. */
function meetInMelee(a: Regiment, b: Regiment): void {
  a.inContact=true; b.inContact=true
  if (!a.meleeFoes.includes(b.id)) a.meleeFoes.push(b.id)
  if (!b.meleeFoes.includes(a.id)) b.meleeFoes.push(a.id)
}

/**
 * Per-model charge eligibility (RULES 四.3), decided when a contact begins: a first contact may charge; a later one only
 * after a new order for the regiment and rechargeGap out of reach (cycle charging). The first chargeEntryWindow of a
 * contact can still deliver it; after that the model is fighting and cannot charge until it pulls out and is re-ordered.
 */
function trackContact(s: Soldier, reg: Regiment, touching: boolean, dt: number): void {
  if (!touching) { s.freeTime+=dt; s.contactTime=0; return }
  if (s.contactTime===0) s.chargeOpen=s.contactOrder<0 || (s.contactOrder!==reg.orderSerial && s.freeTime>=MECHANICS.rechargeGap-1e-9)
  s.contactTime+=dt; s.freeTime=0; s.contactOrder=reg.orderSerial
  if (s.contactTime>MECHANICS.chargeEntryWindow+1e-9) s.chargeOpen=false
}

/**
 * A charge qualified against the enemy met (contactPower > 0): its CHARGE_DURATION window starts and no new charge can
 * start in it. Its bonus has the contact's strength, or none if the target's charge defence negates it.
 */
function chargeContact(battle: Battle, item: Live, target: Live, power: number): void {
  const defended=chargeDefended(target.reg,target.def,target.s,item.def,item.s.x,item.s.y)
  item.s.chargeLeft=CHARGE_DURATION
  item.s.chargePower=defended ? 0 : power
  mountedShock(item,target,defended)
  item.s.chargeContactAt=battle.time
  item.s.chargeArmed=false
}

/**
 * Ordinary melee for every unit type alike: find a reachable target in the attack zone, wind up, re-check the zone when
 * the windup ends, roll to hit and deal damage. A charge has no windup (RULES 四.3): a model with charge intent that
 * comes within weapon reach of an enemy in its attack zone, closing on it fast enough relative to its own charge speed
 * (contactPower), strikes that same step with the charge bonus at that strength, as one ordinary attack (hit roll,
 * splash, brace and charge defence all apply); its swing timing then runs on from there.
 */
function resolveMelee(battle: Battle, live: Live[], grid: Spatial, buf: number[], dt: number): void {
  const due: { item: Live; swing: NonNullable<Soldier['swing']> }[] = []
  for (const item of live) {
    const {s,reg,def}=item
    if (!s.alive || reg.routing || s.down>0) { s.swing=null; continue }
    s.meleeCd=Math.max(0,s.meleeCd-dt)
    // Only a model itself moving at OWN_APPROACH or more can charge, so a standing one needs no charge target search.
    const chargeReady=s.chargeArmed && ownSpeedSq(s)>=OWN_APPROACH*OWN_APPROACH
    const needsTarget=chargeReady||(!s.swing&&s.meleeCd<=0&&reg.order!=='move')
    queryContacts(grid,s.x,s.y,def,reg.side,def.reach,buf)
    let target: Live | null=null, nearest=Infinity, touching=false, side=0
    for (const index of buf) {
      const other=live[index]
      if (other.reg.side===reg.side || !other.s.alive || other.s.down>0) continue
      if(def.shape==='circle'&&other.def.shape==='circle') {
        const dx=other.s.x-s.x,dy=other.s.y-s.y,limit=def.reach+def.radius+other.def.radius+1e-9
        if(dx*dx+dy*dy>limit*limit) continue
      }
      const gap=gapBetween(s,def,other.s,other.def)
      if (gap>def.reach) continue
      touching=true
      meetInMelee(reg,other.reg)
      side=Math.max(side,blockSide(reg,def,other.s.x,other.s.y))
      if (reg.retargeting && other.reg.id!==reg.targetId) continue
      if (!needsTarget || !inAttackZone(item,other,s.facing,gap) || runningDown(item,other) || meleeScreened(item,other,live,grid)) continue
      if (gap<nearest) { nearest=gap; target=other }
    }
    trackContact(s,reg,touching,dt)
    if (side===2) reg.rearTouch++
    else if (side===1) reg.flankTouch++
    const power=target && chargeReady && s.chargeOpen ? contactPower(item,target) : 0
    if (target && power>0) {
      chargeContact(battle,item,target,power)
      // The charge's first blow lands on contact and takes the place of any swing being wound up.
      due.push({item,swing:{ left:0, facing:s.facing, targetId:target.s.id }})
      s.swing=null
      s.meleeCd=Math.max(s.meleeCd,def.meleeInterval)
    } else if (s.swing) {
      s.swing.left-=dt
      if (s.swing.left<=1e-9) {
        due.push({item,swing:s.swing})
        s.swing=null
        s.meleeCd=Math.max(s.meleeCd,def.attack.recovery)
      }
    } else if (target && s.meleeCd<=0 && reg.order!=='move') {
      s.swing={ left:def.attack.windup, facing:s.facing, targetId:target.s.id }
      s.meleeCd=def.meleeInterval
    }
  }
  for (const {item,swing} of due) {
    if (!item.s.alive || item.s.down>0 || item.reg.routing || item.reg.order==='move') continue
    queryContacts(grid,item.s.x,item.s.y,item.def,item.reg.side,item.def.reach,buf)
    const candidates=buf.map(i=>live[i]).filter(other=>other.reg.side!==item.reg.side && (!item.reg.retargeting || other.reg.id===item.reg.targetId) && inAttackZone(item,other,swing.facing) && !meleeScreened(item,other,live,grid))
    const primary=candidates.find(other=>other.s.id===swing.targetId)
    // A primary knocked down during the windup lies immune (RULES 四.7), so the blow goes to the nearest standing
    // foe still in the zone. A primary that walked out of reach or out of the arc still makes the swing miss.
    const lying=primary ? undefined : battle.soldierById.get(swing.targetId)
    const fallback=lying?.alive && lying.down>0 ? nearestVictim(item,candidates) : null
    let victims: Live[]
    if (item.def.splash===1 || (primary && primary.def.physicalSize>item.def.attack.splashMaxSize)) victims=primary ? [primary] : fallback ? [fallback] : []
    else {
      victims=candidates.filter(other=>other.def.physicalSize<=item.def.attack.splashMaxSize)
      victims.sort((a,b)=>gapBetween(item.s,item.def,a.s,a.def)-gapBetween(item.s,item.def,b.s,b.def) || a.s.id-b.s.id)
      victims=victims.slice(0,item.def.splash)
    }
    for (const target of victims) landMelee(battle,item,target,victims.length)
  }
}

/**
 * A heavy blow that has just hurt a man on foot (RULES 四.8). A monster's throws him off his feet, as a ram would; a
 * brute's or a great weapon's drives him back a step. Collision attacks are rams and have their own rule.
 */
function heavyBlow(item: Live, target: Live): void {
  const s = target.s
  if (!s.alive || s.down > 0 || target.def.physicalSize > 1) return
  const dx = s.x - item.s.x, dy = s.y - item.s.y, distance = Math.hypot(dx, dy) || 1
  if (item.def.category === 'monster') {
    knockDown(s, dx / distance, dy / distance, 0, item.def.mass, 0, 0)
    // Like any body that throws its man down, it is held in the melee by him and does not walk on past him.
    if (!item.reg.routing) item.s.impactHold = MECHANICS.impactContactHold
  }
  else if (item.def.category === 'monstrousInfantry') driveBack(s, dx / distance, dy / distance, MECHANICS.blowShoveBrute)
  else if (item.def.weapon === 'greatsword') driveBack(s, dx / distance, dy / distance, MECHANICS.blowShoveGreat)
}

function nearestVictim(item: Live, candidates: Live[]): Live | null {
  let best: Live | null=null, bestGap=Infinity
  for (const other of candidates) {
    const gap=gapBetween(item.s,item.def,other.s,other.def)
    if (gap<bestGap || (gap===bestGap && best!==null && other.s.id<best.s.id)) { best=other; bestGap=gap }
  }
  return best
}

/**
 * Collision attacks (RULES 四.7), as CA describes them: an alternate form of melee attack made when the entity collides
 * with enemies while charging or attacking, with its own cooldown and most targets per attack, and damage from its
 * weapon strength. Only the hitting side strikes: the attacker must be on an attack order and pass contactPower against
 * the body (running into it itself, closing at speedThreshold of its own charge speed or more), so a body that is run
 * into never strikes back at the rammer, while two bodies ramming each other both strike. Each target, of any size, is
 * an ordinary melee hit roll with `damage` times the weapon strength times that contact's strength; the swing cooldown
 * is not touched.
 */
function resolveCollisionAttacks(battle: Battle, live: Live[], grid: Spatial, buf: number[]): void {
  const targets: { item: Live; gap: number; power: number }[] = []
  for (const item of live) {
    const attack=item.def.collisionAttack, s=item.s
    if (!attack || !s.alive || s.down>0 || item.reg.routing || item.reg.order!=='attack' || s.collisionCd>0) continue
    if (ownSpeedSq(s)<OWN_APPROACH*OWN_APPROACH) continue
    queryContacts(grid,s.x,s.y,item.def,item.reg.side,RAM_GAP,buf)
    targets.length=0
    for (const index of buf) {
      const other=live[index]
      if (other.reg.side===item.reg.side || !other.s.alive || other.s.down>0) continue
      const gap=gapBetween(s,item.def,other.s,other.def)
      if (gap>RAM_GAP) continue
      const power=contactPower(item,other)
      if (power>0) targets.push({ item:other, gap, power })
    }
    if (!targets.length) continue
    targets.sort((a,b)=>a.gap-b.gap || a.item.s.id-b.item.s.id)
    s.collisionCd=attack.interval
    for (const target of targets.slice(0,attack.targets)) {
      meetInMelee(item.reg,target.item.reg)
      landMelee(battle,item,target.item,1/Math.max(0.01,attack.damage*target.power),true)
    }
  }
}

const screenBuf: number[] = []

/** A nearer enemy body screens a hero behind it. Friendly spear ranks may
 * support one another; this test only blocks attacks through the defending side. */
function meleeScreened(attacker: Live, target: Live, live: Live[], grid: Spatial): boolean {
  const distance = Math.hypot(target.s.x - attacker.s.x, target.s.y - attacker.s.y)
  const candidates = screenBuf
  // Only a shape circle within 0.8 radius of the attacker-target segment can screen.
  const reach = grid.reach[target.reg.side], half = distance / 2 + 1e-6
  grid.queryWide((attacker.s.x + target.s.x) / 2, (attacker.s.y + target.s.y) / 2, half + reach.narrow * 0.8 + reach.narrowDrift, half + reach.wide * 0.8 + reach.wideDrift, candidates,target.reg.side)
  const targetT = rayCircleT(attacker.s.x, attacker.s.y, target.s.x, target.s.y, target.s.x, target.s.y, target.def.radius * 0.8) ?? 1
  for (const index of candidates) {
    const body = live[index]
    if (body === target || body.reg.side !== target.reg.side || !body.s.alive || body.s.down > 0) continue
    for (const p of shapePoints(body.s, body.def)) {
      const t = rayCircleT(attacker.s.x, attacker.s.y, target.s.x, target.s.y, p.x, p.y, body.def.radius * 0.8)
      if (t !== null && t < targetT) return true
    }
  }
  return false
}

/**
 * A man on foot about to be run down by a horse or chariot has no time to strike at it, unless he is an
 * anti-large spearman standing braced for the charge. Only what drives into him at ramming speed counts (the large
 * body passes contactPower against him, the same check as its ram); a rider going past at his side, or one he runs
 * into himself, can be cut.
 */
function runningDown(item: Live, other: Live): boolean {
  if (item.def.large || !other.def.large) return false
  if (contactPower(other,item)<=0) return false
  return !chargeDefended(item.reg,item.def,item.s,other.def,other.s.x,other.s.y)
}

/**
 * One melee hit roll and its damage: a swing's share of its budget, a charge's first blow, or a collision attack
 * (`share` below 1 multiplies the weapon). A stopped model keeps the unexpired part of a successful charge. Only HP
 * actually lost stops the target's march (hurt); a miss does not. A collision hit shows its damage as a floater.
 */
function landMelee(battle: Battle, item: Live, target: Live, share = 1, collision = false): void {
  const mods = fatigueMods(item.reg.fatigue)
  const dx = target.s.x - item.s.x
  const dy = target.s.y - item.s.y
  const negated = chargeDefended(target.reg,target.def,target.s,item.def,item.s.x,item.s.y)
  const charge = negated ? 0 : item.def.chargeBonus * mods.charge * chargeStrength(item.s)
  let attack = item.def.meleeAttack * mods.attack + charge
  if (target.def.large) attack += item.def.antiLargeMa
  else attack += item.def.antiInfantryMa
  let defense = target.def.meleeDefense * fatigueMods(target.reg.fatigue).defense
  defense *= defenseMultiplier(angDiff(target.s.facing, Math.atan2(-dy, -dx)))
  if (target.s.disengage > 0) defense -= 12
  if (target.reg.bogged) defense -= 8
  defense = Math.max(0, defense)
  target.s.reactTo = item.s.id
  target.s.reactTime = Math.max(4, item.def.meleeInterval + 0.5)
  if (battle.rng() * 100 > hitChance(attack, defense)) return
  const reflection = item.def.chargeReflection && isBracing(item.reg,item.def,target.s.x,target.s.y,item.s)
    && target.s.chargeContactAt>=0 && battle.time-target.s.chargeContactAt<=MECHANICS.chargeReflectWindow ? MECHANICS.chargeReflectDamage : 1
  const wound = woundMods(item.def,item.s).damage
  const multiplier = wound*reflection/share
  const fromCharge = splitBonus(item.def.weaponBase, item.def.weaponAp, charge)
  const antiWs = target.def.large ? item.def.antiLargeWs : item.def.antiInfantryWs
  const fromAnti = splitBonus(item.def.weaponBase, item.def.weaponAp, antiWs)
  const before = target.s.hp
  hurt(
    battle,
    target,
    item.reg,
    (item.def.weaponBase + fromCharge.base + fromAnti.base) * multiplier,
    (item.def.weaponAp + fromCharge.ap + fromAnti.ap) * mods.ap * multiplier,
    'melee',
    {},
    collision,
  )
  if (!collision && target.s.hp < before) heavyBlow(item, target)
}

function resolveShooting(battle: Battle, live: Live[], grid: Spatial, pad: Scratch, dt: number): void {
  const buf=pad.buf
  for (const reg of battle.regiments) {
    const def=unitDef(reg.type), missile=def.missile
    if (!missile || reg.meleeMode || reg.routing || reg.aliveCount<=0) continue
    const target=shootingTarget(battle,reg,missile.range)
    let stocked=false
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      if (soldier.ammo>0) stocked=true
      if (soldier.down>0) continue
      const wasReloading=soldier.reload>0
      soldier.reload=Math.max(0,soldier.reload-dt)
      if (wasReloading && soldier.ammo>0) reg.shot=true
      if (!target || soldier.ammo<=0) continue
      if (!missile.fireWhileMoving && soldier.speed>0.5) continue
      const selfIndex=pad.indexOf.get(soldier.id) ?? -1
      if (selfIndex>=0 && nearestEnemy(live,grid,buf,selfIndex,def.reach)) continue
      if (wasReloading) continue
      const prey=randomAlive(battle,target)
      if (!prey || !inFireArc(reg,prey.x,prey.y) || Math.hypot(prey.x-soldier.x,prey.y-soldier.y)>missile.range) continue
      if (!missile.arc && !clearShot(battle,live,grid,buf,reg,soldier,prey)) continue
      for(let shot=0;shot<(missile.shotsPerVolley??1);shot++) spawnArrow(battle,reg,soldier,prey,def)
      soldier.ammo--; soldier.reload=missile.reload*fatigueMods(reg.fatigue).reload; reg.shot=true
    }
    // Decided once a step for the regiment: with no round left anywhere in it, it closes in and fights as melee.
    if (!stocked) setMeleeMode(reg,true)
  }
}

/** How far the rear rank stands behind the front anchor. The standoff leaves this much inside the weapon range. */
function firingDepth(reg: Regiment, def: UnitDef): number {
  const files = Math.max(1, reg.files)
  const ranks = Math.max(1, Math.ceil(reg.aliveCount / files))
  return (ranks - 1) * def.rankSpacing + 0.8
}

function fireHalf(def: UnitDef): number {
  return ((def.missile?.cone ?? 120) / 2) * DEG
}

function inFireArc(reg: Regiment, x: number, y: number): boolean {
  const to = Math.atan2(y - reg.anchorY, x - reg.anchorX)
  return Math.abs(angDiff(reg.facing, to)) <= fireHalf(unitDef(reg.type))
}

function shootingTarget(battle: Battle, reg: Regiment, range: number): Regiment | null {
  const canShoot = (target: Regiment) => {
    const distance = Math.hypot(target.anchorX - reg.anchorX, target.anchorY - reg.anchorY)
    return distance <= range && inFireArc(reg, target.anchorX, target.anchorY)
  }
  if (reg.order === 'attack' && reg.targetId !== null) {
    const target = regimentById(battle, reg.targetId)
    if (!target || target.aliveCount <= 0) return null
    return canShoot(target) ? target : null
  }
  if (!reg.fireAtWill) return null
  if (reg.order === 'move' && !unitDef(reg.type).missile?.fireWhileMoving && (reg.bodySpeed > 0.5 || Math.hypot(reg.destX - reg.anchorX, reg.destY - reg.anchorY) > 0.5)) return null
  let best: Regiment | null = null
  let bestD = range
  for (const other of battle.regiments) {
    if (other.side === reg.side || other.aliveCount <= 0 || !canShoot(other)) continue
    const distance = Math.hypot(other.anchorX - reg.anchorX, other.anchorY - reg.anchorY)
    if (distance <= bestD) {
      best = other
      bestD = distance
    }
  }
  return best
}

function randomAlive(battle: Battle, reg: Regiment): Soldier | null {
  const alive = reg.soldiers.filter((soldier) => soldier.alive)
  if (alive.length === 0) return null
  return alive[Math.floor(battle.rng() * alive.length)]
}

function spawnArrow(battle: Battle, reg: Regiment, shooter: Soldier, target: Soldier, def: UnitDef): void {
  const missile = def.missile
  if (!missile) return
  const dx = target.x - shooter.x
  const dy = target.y - shooter.y
  const distance = Math.hypot(dx, dy) || 1
  const flight = distance / missile.speed
  let aimX = target.x + target.vx * flight * 0.5
  let aimY = target.y + target.vy * flight * 0.5
  const scatter=calibrationRadius(distance,missile.calibrationDistance,missile.calibrationRadius)
  const radial=Math.sqrt(battle.rng())*scatter, direction=battle.rng()*Math.PI*2
  aimX+=Math.cos(direction)*radial
  aimY+=Math.sin(direction)*radial
  const angle = Math.atan2(aimY - shooter.y, aimX - shooter.x) + (battle.rng() * 2 - 1) * missile.spread * DEG
  const originX = shooter.x + Math.cos(angle) * 0.4
  const originY = shooter.y + Math.sin(angle) * 0.4
  const aimDist = Math.hypot(aimX - originX, aimY - originY) || 1
  const landX = originX + Math.cos(angle) * aimDist
  const landY = originY + Math.sin(angle) * aimDist
  const travel = aimDist
  const projectile: Projectile = {
    x: originX,
    y: originY,
    vx: Math.cos(angle) * missile.speed,
    vy: Math.sin(angle) * missile.speed,
    base: missile.base * woundMods(def,shooter).damage,
    ap: missile.ap * woundMods(def,shooter).damage,
    side: reg.side,
    sourceReg: reg.id,
    shooterId: shooter.id,
    traveled: 0.4,
    maxRange: missile.range,
    alive: true,
    arc: missile.arc,
    originX,
    originY,
    landX,
    landY,
    age: 0,
    duration: Math.max(0.15, travel / missile.speed),
    apex: missile.arc ? Math.min(16, travel * 0.16) : 0,
    z: def.bodyHeight*0.75,
    vz: 0, gravity: 0,
    penetrationLeft: missile.penetration, hitIds: [],
  }
  const targetDef=unitDef(regimentById(battle,target.regId)!.type)
  const targetZ=targetDef.bodyHeight*0.55
  projectile.gravity=missile.arc ? 8*projectile.apex/(projectile.duration*projectile.duration) : 9.81
  projectile.vz=(targetZ-projectile.z+0.5*projectile.gravity*projectile.duration*projectile.duration)/projectile.duration
  battle.projectiles.push(projectile)
}

/** Withhold blocked shots without spending ammo. Nearby friends are inside the
 * muzzle safety zone; friends entering the terminal flight can still be hit. */
function clearShot(battle: Battle, live: Live[], grid: Spatial, buf: number[], reg: Regiment, shooter: Soldier, target: Soldier): boolean {
  const distance = Math.hypot(target.x - shooter.x, target.y - shooter.y)
  const z0=unitDef(reg.type).bodyHeight*0.75
  const targetDef=unitDef(regimentById(battle,target.regId)!.type)
  const z1=targetDef.bodyHeight*0.55
  const safe = Math.min(MECHANICS.muzzleSafeDistance, distance * MECHANICS.muzzleSafeFraction)
  // Only a friend whose widened circle crosses the line of fire can block it: search a corridor along the line.
  const reach = grid.reach[reg.side], widen = 0.15 + 1e-6
  grid.querySegment(shooter.x, shooter.y, target.x, target.y, reach.narrow + reach.narrowDrift + widen, reach.wide + reach.wideDrift + widen, buf, reg.side)
  for (const index of buf) {
    const item = live[index]
    if (!item.s.alive || item.s.down > 0 || item.reg.side !== reg.side || item.reg.id === reg.id) continue
    for (const p of shapePoints(item.s, item.def)) {
      const t = sweptCylinderT(shooter.x,shooter.y,target.x,target.y,z0,z1-z0,0,1,p.x,p.y,item.def.radius+0.15,0,item.def.bodyHeight)
      if (t !== null && t * distance > safe) return false
    }
  }
  return true
}

function flyProjectiles(battle: Battle, live: Live[], grid: Spatial, buf: number[], dt: number): void {
  for (const p of battle.projectiles) {
    if (!p.alive) continue
    const x0=p.x,y0=p.y,z0=p.z,vz0=p.vz
    const x1=x0+p.vx*dt, y1=y0+p.vy*dt
    const stepDistance=Math.hypot(x1-x0,y1-y0)
    // A body is hit only where its shape circle, widened by 0.05 m, meets this step's flight segment.
    const [south,north]=grid.reach,half=stepDistance/2+0.05+1e-6
    grid.queryWide((x0+x1)/2,(y0+y1)/2,half+Math.max(south.narrow+south.narrowDrift,north.narrow+north.narrowDrift),half+Math.max(south.wide+south.wideDrift,north.wide+north.wideDrift),buf)
    const hits: {item:Live;t:number}[]=[]
    for (const index of buf) {
      const item=live[index]
      if (!item.s.alive || item.s.id===p.shooterId || item.reg.id===p.sourceReg || p.hitIds.includes(item.s.id)) continue
      let first:number|null=null
      for (const point of shapePoints(item.s,item.def)) {
        const t=sweptCylinderT(x0,y0,x1,y1,z0,vz0,p.gravity,dt,point.x,point.y,item.def.radius+0.05,0,item.s.down>0?0.3:item.def.bodyHeight)
        if (t===null) continue
        if (item.reg.side===p.side) {
          const aim=Math.hypot(p.landX-p.originX,p.landY-p.originY)
          const traveled=Math.hypot(x0+(x1-x0)*t-p.originX,y0+(y1-y0)*t-p.originY)
          const safe=Math.min(MECHANICS.muzzleSafeDistance,aim*MECHANICS.muzzleSafeFraction)
          if (traveled<Math.max(safe,aim-MECHANICS.terminalFriendlyDistance) || traveled>aim+2) continue
        }
        if (first===null || t<first) first=t
      }
      if (first!==null) hits.push({item,t:first})
    }
    hits.sort((a,b)=>a.t-b.t || a.item.s.id-b.item.s.id)
    for (const hit of hits) {
      const item=hit.item
      if (!item.s.alive) continue
      p.hitIds.push(item.s.id)
      p.x=x0+(x1-x0)*hit.t; p.y=y0+(y1-y0)*hit.t
      p.z=z0+vz0*dt*hit.t-0.5*p.gravity*dt*dt*hit.t*hit.t
      const blocked=item.def.shieldBlock>0 && facingArc(item.s.facing,item.s.x,item.s.y,p.originX,p.originY)==='front' && battle.rng()<item.def.shieldBlock
      if (!blocked) {
        const source=regimentById(battle,p.sourceReg)??null
        const missile=source?unitDef(source.type).missile:null
        const bonus=item.def.large&&missile?(missile.bonusVsLarge??0)/Math.max(1e-9,missile.base+missile.ap):0
        hurt(battle,item,source,p.base*(1+bonus),p.ap*(1+bonus),'missile')
      }
      p.penetrationLeft-=item.def.penetrationResistance
      if (blocked || p.penetrationLeft<=0) { p.alive=false; break }
      const retained=unitDef(regimentById(battle,p.sourceReg)!.type).missile?.penetrationDamage ?? 0.7
      p.base*=retained; p.ap*=retained
    }
    if (!p.alive) continue
    p.x=x1; p.y=y1; p.z=z0+vz0*dt-0.5*p.gravity*dt*dt; p.vz=vz0-p.gravity*dt
    p.age+=dt; p.traveled+=stepDistance
    if (p.z<=0 || p.traveled>p.maxRange+6 || p.x< -8 || p.y< -8 || p.x>MAP_WIDTH+8 || p.y>MAP_HEIGHT+8) p.alive=false
  }
  battle.projectiles=battle.projectiles.filter(p=>p.alive)
}

/** Body gap within which a ram or a collision attack counts as contact. */
const RAM_GAP = 0.35
/** Gap two bodies must open before the same pair can ram again. */
const RAM_RELATCH = 2
/** A ploughing body slower than this has spent its momentum: the plough ends and it fights where it stands. */
const PLOUGH_END = 1
/** A body that stands ends the plough only if it is this far ahead of the rammer (cosine off its heading, about 45°). */
const PLOUGH_BLOCK = 0.7

/**
 * Ramming physics (RULES 四.7), by momentum. It deals no damage: hurting enemies on collision is the collision attack's
 * job. A body rams a smaller enemy body it runs into: the first ram of a charge needs contactPower (closing at
 * speedThreshold of its own effective charge speed), every later one while it ploughs on only needs to be closing.
 * Each ram is a perfectly inelastic exchange along the contact normal between the rammer's mass and the struck body's
 * impact mass (mass × impactMass, × impactBraceMultiplier by depth when braced against it): the rammer loses
 * closing × impact / (rammer + impact) and the struck body gains closing × rammer / (rammer + impact). A man on foot or
 * smaller (physical size 1) whose gain reaches knockdownSpeedChange is knocked down and the rammer ploughs on into the
 * next; a body that stands (a bigger one, or a man hit too softly) ends the plough. A braced man with charge defence
 * against the rammer is never knocked down and stops the charge dead. Each pair rams once until the two bodies are
 * RAM_RELATCH apart. A non-chariot rammer holds the melee it rammed into; a routing rammer still knocks men down but
 * neither ploughs nor holds a melee (RULES 七.3). Rams do not stop a march.
 */
function resolveImpact(battle: Battle, live: Live[], grid: Spatial, pad: Scratch): void {
  const buf = pad.buf
  // Closing speed never exceeds the body's own speed plus the fastest enemy body's, so a body for which even that sum
  // stays under the threshold cannot start a ram this step; nor can one no bigger than the smallest enemy body, or one
  // not moving under its own power at OWN_APPROACH. All skip the contact search unless they are already ploughing.
  const fastest = [0, 0], smallest = [Infinity, Infinity]
  for (const item of live) {
    const side = item.reg.side, v = item.s.vx * item.s.vx + item.s.vy * item.s.vy
    if (v > fastest[side]) fastest[side] = v
    if (item.def.physicalSize < smallest[side]) smallest[side] = item.def.physicalSize
  }
  fastest[0] = Math.sqrt(fastest[0]); fastest[1] = Math.sqrt(fastest[1])
  for (let i = 0; i < live.length; i++) {
    const item = live[i], foe = item.reg.side === 0 ? 1 : 0
    if (!item.s.alive || item.s.down > 0 || item.reg.bogged || item.def.physicalSize <= smallest[foe]) continue
    const routing = item.reg.routing
    const own = Math.sqrt(ownSpeedSq(item.s))
    const ploughing = item.s.plowLeft > 0 && !routing
    if (ploughing ? own < PLOUGH_END : own < OWN_APPROACH || speedPower(own + fastest[foe], effectiveChargeSpeed(item.def, item.reg.fatigue)) <= 0) continue
    item.s.latched = item.s.latched.filter((id) => {
      const index = pad.indexOf.get(id)
      if (index === undefined) return false
      const other = live[index]
      return other.s.alive && gapBetween(item.s, item.def, other.s, other.def) < RAM_RELATCH
    })
    queryContacts(grid, item.s.x, item.s.y, item.def, item.reg.side, RAM_GAP, buf)
    const hits: { item: Live; gap: number }[] = []
    for (const otherIndex of buf) {
      const other = live[otherIndex]
      if (other.reg.side === item.reg.side || !other.s.alive) continue
      if (item.def.physicalSize <= other.def.physicalSize) continue
      if (item.s.latched.includes(other.s.id)) continue
      const gap = gapBetween(item.s, item.def, other.s, other.def)
      if (gap > RAM_GAP) continue
      hits.push({ item: other, gap })
    }
    hits.sort((a, b) => a.gap - b.gap)
    for (const hit of hits) {
      const dx = hit.item.s.x - item.s.x
      const dy = hit.item.s.y - item.s.y
      const distance = Math.hypot(dx, dy) || 1
      const nx = dx / distance
      const ny = dy / distance
      if (hit.item.s.down > 0) continue
      // Judged on the rammer's own forward pace: sideways shoves from earlier rams in this step are not momentum.
      // Likewise the man's own pace, not the drift of a shove passed back to him from the rank in front.
      const closing = (item.s.speed * Math.cos(item.s.facing) - hit.item.s.vx + hit.item.s.pushVx) * nx + (item.s.speed * Math.sin(item.s.facing) - hit.item.s.vy + hit.item.s.pushVy) * ny
      if (closing <= 0) continue
      // The ram that starts a charge must be a real one; once ploughing, every man met is rammed in turn.
      if (!(item.s.plowLeft > 0 && !routing) && contactPower(item, hit.item) <= 0) continue
      item.s.latched.push(hit.item.s.id)
      hit.item.s.reactTo = item.s.id
      hit.item.s.reactTime = 4
      meetInMelee(item.reg, hit.item.reg)
      const from = blockSide(hit.item.reg, hit.item.def, item.s.x, item.s.y)
      if (from === 2) hit.item.reg.rearTouch++
      else if (from === 1) hit.item.reg.flankTouch++
      // Every rammer but a chariot is held by the man it rammed, thrown down or not, as by an enemy standing in its
      // way: a line that has struck home stays in that melee and does not walk on past the men it threw (linePressed).
      if (!routing && item.def.category !== 'chariot' && (!item.reg.retargeting || hit.item.reg.id===item.reg.targetId)) item.s.impactHold = MECHANICS.impactContactHold
      if (chargeDefended(hit.item.reg, hit.item.def, hit.item.s, item.def, item.s.x, item.s.y)) {
        // Braced at the front against this kind of charge: he stands, and the charge stops dead on him.
        mountedShock(item, hit.item, true)
        bleedSpeed(item.s, nx, ny, closing)
        if (item.def.category === 'chariot' && item.reg.order === 'attack') item.s.chargeSpent = true
        item.s.plowLeft = 0
        continue
      }
      mountedShock(item, hit.item, false)
      const braced = bracedAgainst(hit.item.reg, hit.item.def, hit.item.s, item.s.x, item.s.y)
      const impact = hit.item.def.mass * MECHANICS.impactMass * (braced ? impactBraceMultiplier(hit.item.reg) : 1)
      const mass = item.def.mass
      bleedSpeed(item.s, nx, ny, closing * impact / (mass + impact))
      const struck = closing * mass / (mass + impact)
      const stands = hit.item.def.physicalSize > 1 || struck < MECHANICS.knockdownSpeedChange
      shoveBack(live, grid, hit.item, item, nx, ny, closing, stands)
      if (stands) {
        // He stands. One standing in the rammer's path ends the plough; one only brushed at the side does not.
        if (nx * Math.cos(item.s.facing) + ny * Math.sin(item.s.facing) >= PLOUGH_BLOCK) endPlough(item)
        continue
      }
      knockDown(hit.item.s, nx, ny, struck, mass, item.s.vx, item.s.vy)
      if (routing) continue
      item.s.plowLeft = PLOW_TIME
      if (item.def.category === 'chariot') {
        const speed=Math.hypot(item.s.vx,item.s.vy)||1
        const fx=item.s.vx/speed, fy=item.s.vy/speed
        let far=0
        for (const foe of hit.item.reg.soldiers) {
          if (foe.alive) far=Math.max(far,(foe.x-item.s.x)*fx+(foe.y-item.s.y)*fy)
        }
        const overrun=far+PLOW_OVERRUN
        item.s.plowX=clamp(item.s.x+fx*overrun,3,MAP_WIDTH-3)
        item.s.plowY=clamp(item.s.y+fy*overrun,3,MAP_HEIGHT-3)
        item.reg.plow=Math.max(item.reg.plow,PLOW_TIME)
      }
    }
  }
}

const shoveBuf: number[] = []

/** Drive a standing man back along (nx, ny) at `speed` m/s of drift, on top of any he has, to at most shoveMax. */
function driveBack(s: Soldier, nx: number, ny: number, speed: number): void {
  let vx = s.pushVx + nx * speed, vy = s.pushVy + ny * speed
  const total = Math.hypot(vx, vy)
  if (total > MECHANICS.shoveMax) { vx *= MECHANICS.shoveMax / total; vy *= MECHANICS.shoveMax / total }
  s.vx += vx - s.pushVx; s.vy += vy - s.pushVy
  s.pushVx = vx; s.pushVy = vy
  s.idle = false
}

/**
 * A ram goes through the man it hits (RULES 四.7). If he keeps his feet he is driven back, and so are the friends
 * standing behind him along the blow, each less than the one in front: the line gives where it is struck and comes
 * back up to its places afterwards. It moves men, not the fight: the rammer loses exactly what it lost before.
 */
function shoveBack(live: Live[], grid: Spatial, struck: Live, rammer: Live, nx: number, ny: number, closing: number, stands: boolean): void {
  if (struck.def.physicalSize > 1) return
  const base = closing * MECHANICS.shoveShare
  const eased = (item: Live) => bracedAgainst(item.reg, item.def, item.s, rammer.s.x, rammer.s.y) ? 0.5 : 1
  if (stands) driveBack(struck.s, nx, ny, base * eased(struck))
  grid.query(struck.s.x, struck.s.y, MECHANICS.shoveDepth + 0.5, shoveBuf, struck.reg.side)
  for (const index of shoveBuf) {
    const mate = live[index]
    if (mate === struck || mate.reg.side !== struck.reg.side || !mate.s.alive || mate.s.down > 0 || mate.def.physicalSize > 1) continue
    const dx = mate.s.x - struck.s.x, dy = mate.s.y - struck.s.y, behind = dx * nx + dy * ny
    if (behind <= 0.2 || behind > MECHANICS.shoveDepth || Math.abs(dx * ny - dy * nx) > MECHANICS.shoveWidth) continue
    driveBack(mate.s, nx, ny, base * (1 - behind / MECHANICS.shoveDepth) * eased(mate))
  }
}

/** A plough stopped among the enemy: an attacking chariot's charge is spent there (chargeSpent) until it gets clear. */
function endPlough(item: Live): void {
  if (item.s.plowLeft > 0 && item.def.category === 'chariot' && item.reg.order === 'attack') item.s.chargeSpent = true
  item.s.plowLeft = 0
}

/** A ram takes `dv` of the rammer's speed along the contact normal; only its forward share slows the rammer's pace. */
function bleedSpeed(s: Soldier, nx: number, ny: number, dv: number): void {
  const fx = Math.cos(s.facing), fy = Math.sin(s.facing)
  s.speed = Math.max(0, s.speed - dv * Math.max(0, nx * fx + ny * fy))
  s.vx = fx * s.speed + s.pushVx
  s.vy = fy * s.speed + s.pushVy
}

/**
 * A body that rammed a man down coasts on through the next ones on what is left of its momentum, neither speeding up
 * nor turning, and does not stop to fight until the plough ends (a man who stands, PLOUGH_END, or PLOW_TIME without
 * throwing anyone). Chariots plough toward their overrun point instead (driveChariot).
 */
function coast(s: Soldier, dt: number): void {
  s.idle = false
  s.omega = 0
  if (s.speed < PLOUGH_END) { s.plowLeft = 0; return }
  s.x += Math.cos(s.facing) * s.speed * dt
  s.y += Math.sin(s.facing) * s.speed * dt
}

function separate(live: Live[], pad: Scratch,dt:number): void {
  const buf = pad.buf
  const contactScratch={gap:0,nx:0,ny:0}
  const shellRecovery=1-Math.exp(-MECHANICS.contactStiffness*dt/4)
  const count=live.length
  if(pad.extent.length<count) {
    const size=Math.max(count,pad.extent.length*2)
    pad.extent=new Float64Array(size);pad.slim=new Float64Array(size);pad.wide=new Uint8Array(size)
    pad.startX=new Float64Array(size);pad.startY=new Float64Array(size)
  }
  const {extent,slim,wide,startX,startY}=pad
  // Extents depend only on the body, so each is worked out once per call rather than per candidate pair.
  let largestRadius=0,largestAxisShift=0,narrowExtent=0
  for(let i=0;i<count;i++) {
    const def=live[i].def
    largestRadius=Math.max(largestRadius,collisionRadius(def,true))
    if(def.shape==='capsule') largestAxisShift=Math.max(largestAxisShift,(def.length/2-def.radius)*(1-MECHANICS.collisionRadiusScale))
    extent[i]=collisionExtent(def,true);slim[i]=collisionExtent(def,false)
    wide[i]=wideBody(def)?1:0
    if(!wide[i]) narrowExtent=Math.max(narrowExtent,extent[i])
  }
  const traction=new Set<Soldier>()
  pad.pushing.clear()
  const tractionKicks:{foot:Soldier;x:number;y:number}[]=[]
  let tractionGridReady=false
  for(const cart of live) {
    // Ploughing carts too: a man a ram did not throw stays latched in front of the cart and must still be pushed.
    if(cart.s.chargeSpent&&cart.s.contactTime===0) cart.s.chargeSpent=false
    if(cart.def.category!=='chariot'||cart.reg.routing||cart.s.down>0||cart.s.plowLeft>0||cart.s.speed<0.02||cart.s.speed>=5) continue
    if(!tractionGridReady) {fillGrid(pad,live,false);tractionGridReady=true}
    let resistance=0
    const contacts:{item:Live;nx:number;ny:number;forwardLoad:number}[]=[]
    const fwdX=Math.cos(cart.s.facing),fwdY=Math.sin(cart.s.facing)
    // Wide enough to see the men standing behind the ones the cart touches.
    pad.spatial.query(cart.s.x,cart.s.y,cart.def.length/2+2+TRACTION_SUPPORT_DEPTH,buf)
    const near=buf.map(index=>live[index])
    for(const other of near) {
      if(!other.s.alive||other.s.down>0||other.def.physicalSize>1||other.s.id===cart.s.id) continue
      const friendly=other.reg.side===cart.reg.side
      // Cart traction uses its calibrated rolling collider and force budget.
      const contact=bodyContact(cart.s,cart.def,other.s,other.def)
      if(contact.gap>0.3||contact.nx*fwdX+contact.ny*fwdY<0.1) continue
      const braced=!friendly&&bracedAgainst(other.reg,other.def,other.s,cart.s.x,cart.s.y)
      // Charge defence braced at the front against the cart, or a cart whose charge is spent among them: it pushes nobody over.
      if(!friendly&&(cart.s.chargeSpent||chargeDefended(other.reg,other.def,other.s,cart.def,cart.s.x,cart.s.y))) {resistance=Infinity;break}
      const grip=friendly?0.4:braced?MECHANICS.braceGroundGrip:1
      const forwardLoad=contact.nx*fwdX+contact.ny*fwdY
      // Side contacts need to clear the lane, but do not present their entire
      // ground resistance along the vehicle's forward axis.
      const load=(friendly?other.def.mass:collisionMass(other,cart.s.x,cart.s.y))*MECHANICS.groundFriction*grip*Math.max(0.2,forwardLoad)
      // A dense block holds: every standing comrade packed in right behind a man the cart pushes adds to what it pushes.
      // A braced man's depth already counts through his collision mass (bracingMassMultiplier).
      let support=0
      if(!friendly&&!braced) for(const mate of near) {
        if(mate===other||mate.reg.side!==other.reg.side||!mate.s.alive||mate.s.down>0||mate.def.physicalSize>1) continue
        const ax=mate.s.x-other.s.x,ay=mate.s.y-other.s.y,ahead=ax*fwdX+ay*fwdY
        if(ahead>0.2&&ahead<=TRACTION_SUPPORT_DEPTH&&Math.abs(ax*fwdY-ay*fwdX)<=TRACTION_SUPPORT_WIDTH&&++support>=TRACTION_SUPPORT_MAX) break
      }
      resistance+=load*(1+MECHANICS.tractionSupport*support)
      contacts.push({item:other,nx:contact.nx,ny:contact.ny,forwardLoad})
    }
    const force=cart.def.mass*accelRate(cart.def,true)
    if(resistance>0&&resistance<force) {
      traction.add(cart.s)
      pad.pushing.add(cart.s)
      // Traction must exert a sustained force, not merely permit overlap repair.
      // Deflect the contact bodies to either side of the vehicle's lane; ground
      // friction then arrests the displaced feet as soon as contact ends. Enemy foot
      // straight ahead of a cart that out-pushes them go down instead, even from a
      // standstill (RULES 四.7): heavy carts push over light, sparse infantry.
      const sideX=-Math.sin(cart.s.facing),sideY=Math.cos(cart.s.facing)
      for(const hit of contacts) {
        if(hit.item.reg.side!==cart.reg.side&&!hit.item.reg.routing&&hit.forwardLoad>=TRACTION_PUSHOVER_LOAD) {
          pushOver(hit.item.s,fwdX,fwdY,cart.s.speed)
          continue
        }
        const foot=hit.item.s
        const side=Math.sign((foot.x-cart.s.x)*sideX+(foot.y-cart.s.y)*sideY)||(foot.id%2?1:-1)
        let dx=hit.nx*0.35+sideX*side,dy=hit.ny*0.35+sideY*side
        const length=Math.hypot(dx,dy)||1;dx/=length;dy/=length
        const kick=force*dt/(contacts.length*hit.item.def.mass)
        tractionKicks.push({foot,x:dx*kick,y:dy*kick})
      }
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    let overlaps = 0
    const grid = fillGrid(pad, live,false)
    for (let i = 0; i < count; i++) {startX[i]=live[i].s.x;startY[i]=live[i].s.y}
    // Furthest this pass has pushed a narrow body from where the grid filed it.
    let drift=0,drift2=0
    for (let i = 0; i < live.length; i++) {
      const a = live[i]
      if (!a.s.alive) continue
      // Query for full-size hostile bodies as well as slim friendly bodies.
      // Capsules insert all three visual circle centres into the shared grid.
      // The shared combat grid inserts visual capsule points; include the
      // largest radius generously enough to cover the shorter physical axis.
      const full=extent[i]+largestRadius+MECHANICS.contactPadding+largestAxisShift
      // A narrow body can only be in contact within its own bound plus how far it has been pushed this pass,
      // so only wide bodies are searched out to the full radius. Candidates keep the full search's order.
      // Should `a` itself be pushed so far that the cells searched no longer hold that bound around it, the
      // rest of its loop walks the full search instead, so the pairs met are exactly the full search's.
      const qx=a.s.x,qy=a.s.y
      let narrow=Math.min(full,extent[i]+narrowExtent+MECHANICS.contactPadding+drift+1e-6),room=-1
      grid.queryWide(qx, qy, narrow, full, buf)
      for (let k = 0; k < buf.length; k++) {
        const j = buf[k]
        if (j <= i) continue
        const b = live[j]
        if (!b.s.alive) continue
        const enemy = a.reg.side !== b.reg.side
        // Ordinary enemies do not grant the same pass-through room as allies.
        // Carts retain the calibrated collider used by their explicit traction
        // and ploughing rules; their force budget decides whether a lane opens.
        const solidEnemy=enemy&&a.def.category!=='chariot'&&b.def.category!=='chariot'
        const bound=(solidEnemy?extent[i]+extent[j]:slim[i]+slim[j])+MECHANICS.contactPadding
        const dx=b.s.x-a.s.x,dy=b.s.y-a.s.y
        if(dx*dx+dy*dy>=bound*bound) continue
        const contact=bodyContact(a.s,a.def,b.s,b.def,contactScratch,solidEnemy)
        // Large and small friends mix (RULES 三.4): a horse or an ogre fits between the files of friendly foot.
        const mixed=!enemy&&a.def.category!=='chariot'&&b.def.category!=='chariot'&&(a.def.physicalSize>1)!==(b.def.physicalSize>1)
        const gap = mixed ? contact.gap+MECHANICS.mixedPassShare*collisionRadius(a.def.physicalSize>1?a.def:b.def) : contact.gap
        if (gap >= MECHANICS.contactPadding) continue
        overlaps++
        if (pass === 0 && a.reg === b.reg && !a.reg.routing) swapIfCrossing(a, b)
        const nx = contact.nx
        const ny = contact.ny
        let massA = enemy?collisionMass(a, b.s.x, b.s.y):a.def.mass
        let massB = enemy?collisionMass(b, a.s.x, a.s.y):b.def.mass
        const total = massA + massB
        const penetration=MECHANICS.contactPadding-gap
        const softDepth=contactSoftDepth(collisionRadius(a.def,solidEnemy)+collisionRadius(b.def,solidEnemy),!enemy)
        const push=contactPush(penetration,softDepth,dt,shellRecovery)
        const firmness=clamp((penetration-softDepth*0.5)/Math.max(1e-6,softDepth*0.5),0,1)
        const plowA = enemy && a.s.plowLeft > 0
        const plowB = enemy && b.s.plowLeft > 0
        const shoveA=traction.has(a.s)&&b.def.physicalSize<=1&&nx*Math.cos(a.s.facing)+ny*Math.sin(a.s.facing)>0.1
        const shoveB=traction.has(b.s)&&a.def.physicalSize<=1&&-nx*Math.cos(b.s.facing)-ny*Math.sin(b.s.facing)>0.1
        // Mass only pushes through an enemy during a fast impact. Melee cavalry and
        // monsters meet the same immovable enemy line as infantry once they slow down.
        const onFoot = a.reg!==b.reg && (enemy||(!a.def.large&&!b.def.large)) && !plowA && !plowB && !shoveA && !shoveB && a.s.down <= 0 && b.s.down <= 0 && ((!a.def.large && !b.def.large) || Math.max(Math.hypot(a.s.vx, a.s.vy), Math.hypot(b.s.vx, b.s.vy)) < 5)
        const yieldA = onFoot ? footYield(a, b, nx, ny) : 0
        if (plowA && !plowB) {
          b.s.x += nx * push
          b.s.y += ny * push
        } else if (plowB && !plowA) {
          a.s.x -= nx * push
          a.s.y -= ny * push
        } else if (onFoot) {
          a.s.x -= nx * push * yieldA
          a.s.y -= ny * push * yieldA
          b.s.x += nx * push * (1 - yieldA)
          b.s.y += ny * push * (1 - yieldA)
        } else {
          a.s.x -= nx * push * (massB / total)
          a.s.y -= ny * push * (massB / total)
          b.s.x += nx * push * (massA / total)
          b.s.y += ny * push * (massA / total)
        }
        if (!wide[i]) { const dx=a.s.x-startX[i],dy=a.s.y-startY[i],d2=dx*dx+dy*dy; if(d2>drift2) {drift2=d2;drift=Math.sqrt(d2)} }
        if (!wide[j]) { const dx=b.s.x-startX[j],dy=b.s.y-startY[j],d2=dx*dx+dy*dy; if(d2>drift2) {drift2=d2;drift=Math.sqrt(d2)} }
        const relVn = ((b.s.vx - a.s.vx) * nx + (b.s.vy - a.s.vy) * ny)*firmness
        if (relVn < 0 && onFoot) {
          normalImpulse(a.s,nx,ny,relVn*yieldA)
          normalImpulse(b.s,nx,ny,-relVn*(1-yieldA))
        } else if (relVn < 0) {
          const impulse = -relVn / (1 / massA + 1 / massB)
          const keepA = plowA ? 0.05 : 1
          const keepB = plowB ? 0.05 : 1
          normalImpulse(a.s,nx,ny,-impulse*keepA/massA)
          normalImpulse(b.s,nx,ny,impulse*keepB/massB)
        }
        if (narrow<full) {
          if (room<0) room=grid.room(qx,qy,narrow)
          if (!(Math.abs(a.s.x-qx)<room&&Math.abs(a.s.y-qy)<room)) { grid.query(qx,qy,full,buf); k=buf.indexOf(j); narrow=full }
        }
      }
    }
    if (overlaps === 0) break
  }
  // Apply sustained motor forces after resolving this step's collision impulses;
  // otherwise the overlap solver cancels the force before it can move a body.
  for(const {foot,x,y} of tractionKicks) {
    let vx=foot.pushVx+x,vy=foot.pushVy+y
    const speed=Math.hypot(vx,vy),scale=speed>MECHANICS.cartShoveSpeed?MECHANICS.cartShoveSpeed/speed:1
    vx*=scale;vy*=scale
    foot.vx+=vx-foot.pushVx;foot.vy+=vy-foot.pushVy
    foot.pushVx=vx;foot.pushVy=vy
  }
}

/**
 * Share of the overlap between two enemy foot soldiers that `a` gives way by. A man on foot cannot shove an
 * enemy man on foot: whoever walks into the other is stopped and slides off him; the one standing does not
 * budge. When neither is moving, the side on the attack gives way, so a ring of attackers never crushes a block.
 */
function footYield(a: Live, b: Live, nx: number, ny: number): number {
  const into = (item: Live, sign: number) =>
    Math.max(0, sign * (item.s.vx * nx + item.s.vy * ny)) + 0.0001
  const wa = into(a, 1)
  const wb = into(b, -1)
  return wa / (wa + wb)
}

/** Two comrades who walk into each other on the way to each other's side trade places instead of jamming. */
function swapIfCrossing(a: Live, b: Live): void {
  if (a.reg.engaged || a.reg.aliveCount <= 1) return
  const slotA = slotOf(a.reg, a.def, a.s.file, a.s.rank, a.s.centerIndex)
  const slotB = slotOf(b.reg, b.def, b.s.file, b.s.rank, b.s.centerIndex)
  const kept = Math.hypot(slotA.x - a.s.x, slotA.y - a.s.y) + Math.hypot(slotB.x - b.s.x, slotB.y - b.s.y)
  const swapped = Math.hypot(slotB.x - a.s.x, slotB.y - a.s.y) + Math.hypot(slotA.x - b.s.x, slotA.y - b.s.y)
  if (swapped + 0.1 >= kept) return
  const { file, rank, centerIndex } = a.s
  a.s.file = b.s.file
  a.s.rank = b.s.rank
  a.s.centerIndex = b.s.centerIndex
  b.s.file = file
  b.s.rank = rank
  b.s.centerIndex = centerIndex
}

/** A man who runs into a body or through a charge loses the stride he had; he picks it up again by accelerating. */
function absorbBumps(live: Live[]): void {
  for (const item of live) {
    const s = item.s
    if (!s.alive || s.speed <= 0) continue
    const fwd = forward(s.facing)
    s.speed = clamp(s.vx * fwd.x + s.vy * fwd.y, 0, s.speed)
  }
}

function clampBodies(battle: Battle): void {
  for (const reg of battle.regiments) {
    const leaving=reg.routing&&reg.soldiers.some(s=>s.alive&&(s.x<=0.8||s.y<=0.8||s.x>=MAP_WIDTH-0.8||s.y>=MAP_HEIGHT-0.8))
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      if (leaving) {
        soldier.alive = false
        soldier.escaped = true
        soldier.deathTime = -1
        soldier.swing = null
        soldier.flash = 0
        soldier.chargeArmed = false
        soldier.chargeLeft = soldier.plowLeft = 0
        soldier.speed = soldier.vx = soldier.vy = soldier.pushVx = soldier.pushVy = 0
        soldier.cartPath = null
        reg.aliveCount = Math.max(0, reg.aliveCount - 1)
        continue
      }
      soldier.x = clamp(soldier.x, 0.8, MAP_WIDTH - 0.8)
      soldier.y = clamp(soldier.y, 0.8, MAP_HEIGHT - 0.8)
    }
    if(leaving) {
      reg.anchorSpeed=reg.bodySpeed=reg.frameVx=reg.frameVy=reg.turnRate=0
      reg.engaged=reg.inContact=reg.wantCharge=reg.retargeting=false
      reg.order='hold';reg.targetId=null;reg.queue=[]
      for(const s of reg.soldiers) s.impactHold=0
    }
  }
}

/** Every standing body within this much of its slot, and moving slower than ARRIVE_SPEED, ends a move. */
const ARRIVE_SLOT = 0.3
const ARRIVE_SPEED = 0.1
/** A march in enemy contact must cut its mean distance to the destination slots by this much to count as getting on. */
const STALL_GAIN = 0.25
/** Pressed against the enemy within this mean distance of its destination slots, a march has nowhere further to go... */
const STALL_NEAR = 1
/** ...and counts as arrived after this many seconds without getting closer. */
const STALL_AT_DEST = 1
/** Farther out, this long without getting closer means the enemy blocks the way, and it stops where it stands. Each
 * outlasts the slowest measured turn-about out of a melee: men who turn on the spot (ogres about 1.5 s), and
 * horses, carts and monsters that wheel round (cavalry about 2.5 s, war wagons about 4.3 s). */
const STALL_BLOCKED_FOOT = 2.5
const STALL_BLOCKED_WHEEL = 5

/**
 * Move orders end as in Warhammer III. A marching regiment that takes melee damage (HP lost to an enemy melee hit,
 * collision attacks included) gives up the move and holds where it stands, so its men fight back; misses, rams,
 * knockdowns, pushes and missiles do not stop it. A move ordered while already in melee is a disengagement: enemy
 * attacks never cancel it, however often it is caught again, until it arrives. A regiment that has arrived holds its
 * destination: idle, not passive. A march pressed against the enemy that can get no closer to its destination ends
 * too, so neither a disengagement that cannot shake off its pursuers nor two blocks marching into each other stays
 * passive.
 */
function settleMoveOrders(battle: Battle, struck: Set<Regiment>, dt: number): void {
  for (const reg of battle.regiments) {
    if (reg.order !== 'move' || reg.routing || reg.aliveCount <= 0) continue
    if (struck.has(reg) && !reg.disengaging) { haltMarch(reg); continue }
    // A queued chain moves on as soon as the frame reaches the waypoint; the men keep following it.
    if (reg.queue.length && waypointReached(reg) && advanceQueue(battle, reg)) continue
    if (arrived(reg)) { reg.order = 'hold'; reg.disengaging = false; continue }
    if (!reg.inContact) continue
    const gap = destinationGap(reg)
    if (reg.stallGap < 0 || gap < reg.stallGap - STALL_GAIN) { reg.stallGap = gap; reg.stall = 0 }
    else reg.stall += dt
    if (gap <= STALL_NEAR && reg.stall >= STALL_AT_DEST) { if (!advanceQueue(battle, reg)) { reg.order = 'hold'; reg.disengaging = false } }
    else if (reg.stall >= (unitDef(reg.type).turnRadius === 0 ? STALL_BLOCKED_FOOT : STALL_BLOCKED_WHEEL)) haltMarch(reg)
  }
}

/** Mean distance of the living men from their slots in the destination frame. */
function destinationGap(reg: Regiment): number {
  const def = unitDef(reg.type), frame = { ...reg, anchorX: reg.destX, anchorY: reg.destY, facing: reg.destFacing }
  let total = 0, n = 0
  for (const s of reg.soldiers) {
    if (!s.alive) continue
    const slot = slotOf(frame, def, s.file, s.rank, s.centerIndex)
    total += Math.hypot(slot.x - s.x, slot.y - s.y); n++
  }
  return n > 0 ? total / n : 0
}

/** Stop on the spot: the frame is laid over the bodies as they stand, keeping its facing and width. */
function haltMarch(reg: Regiment): void {
  const def = unitDef(reg.type)
  let dx = 0, dy = 0, n = 0
  for (const s of reg.soldiers) {
    if (!s.alive) continue
    const slot = slotOf(reg, def, s.file, s.rank, s.centerIndex)
    dx += s.x - slot.x; dy += s.y - slot.y; n++
  }
  if (n > 0) {
    reg.anchorX = clamp(reg.anchorX + dx / n, 3, MAP_WIDTH - 3)
    reg.anchorY = clamp(reg.anchorY + dy / n, 3, MAP_HEIGHT - 3)
  }
  // Being stopped by the enemy also drops any queued orders (WH3: an attacked unit loses its move order).
  reg.order = 'hold'; reg.disengaging = false; reg.queue = []
  reg.destX = reg.anchorX; reg.destY = reg.anchorY; reg.destFacing = reg.facing; reg.destFiles = reg.files
  for (const s of reg.soldiers) s.cartPath = null
}

/** The frame (not yet the men) stands at the destination: enough to start the next queued step. Carts need arrival. */
function waypointReached(reg: Regiment): boolean {
  if (unitDef(reg.type).category === 'chariot') return arrived(reg)
  const alive = Math.max(1, reg.aliveCount)
  return Math.hypot(reg.destX - reg.anchorX, reg.destY - reg.anchorY) <= 0.05 && Math.abs(angDiff(reg.facing, reg.destFacing)) <= 0.02
    && clamp(reg.destFiles, 1, alive) === clamp(reg.files, 1, alive)
}

/**
 * The frame has been laid at the destination and every standing man has walked into his slot and stopped.
 * Carts drive to the slots of the destination frame itself. Men still weaving through allies are far from
 * their slots, and carts still on a turning arc are moving, so neither counts as arrived.
 */
function arrived(reg: Regiment): boolean {
  const def = unitDef(reg.type), cart = def.category === 'chariot', alive = Math.max(1, reg.aliveCount)
  if (!cart && (Math.hypot(reg.destX - reg.anchorX, reg.destY - reg.anchorY) > 0.05 || Math.abs(angDiff(reg.facing, reg.destFacing)) > 0.02
    || clamp(reg.destFiles, 1, alive) !== clamp(reg.files, 1, alive))) return false
  const frame = cart ? { ...reg, anchorX: reg.destX, anchorY: reg.destY, facing: reg.destFacing } : reg
  for (const s of reg.soldiers) {
    if (!s.alive) continue
    if (s.down > 0 || s.vx * s.vx + s.vy * s.vy > ARRIVE_SPEED ** 2) return false
    const slot = slotOf(frame, def, s.file, s.rank, s.centerIndex)
    if ((slot.x - s.x) ** 2 + (slot.y - s.y) ** 2 > ARRIVE_SLOT ** 2) return false
  }
  return true
}

function linePressed(reg: Regiment, def: UnitDef, live: Live[], pad: Scratch): boolean {
  const front = reg.soldiers.filter((soldier) => soldier.alive && soldier.rank === 0)
  if (front.length === 0) return false
  const pressedGap = reg.engaged ? def.reach : 0.35
  let pressed = 0
  for (const soldier of front) {
    const index = pad.indexOf.get(soldier.id)
    if (index === undefined) continue
    // The man he has just rammed or thrown holds him as well as one still standing in his way.
    if (soldier.impactHold > 0) { pressed += 1; continue }
    // A man is held by an enemy within the gap who stands his ground: men running away bar nobody's way, unless they
    // are the ones the regiment was sent after.
    queryContacts(pad.spatial, soldier.x, soldier.y, def, reg.side, pressedGap + 1e-6, pad.buf)
    for (const other of pad.buf) {
      const foe = live[other]
      if (foe.reg.side === reg.side || !foe.s.alive || foe.s.down > 0 || (foe.reg.routing && foe.reg.id !== reg.targetId)) continue
      if (reg.retargeting && foe.reg.id !== reg.targetId) continue
      if (gapBetween(soldier, def, foe.s, foe.def) > pressedGap + 1e-6) continue
      pressed += 1
      break
    }
  }
  // The line as a whole stops for the enemy once nearly half its front rank is held, and stays stopped while two
  // fifths of it is. With less than that barred, the held files fight where they are and the rest of the line goes on.
  const needed = reg.engaged ? Math.max(1, Math.ceil(front.length * 0.4)) : Math.max(1, Math.ceil(front.length * 0.45))
  return pressed >= needed
}

function finishChargeFatigueBog(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  fillGrid(pad, live)
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    if (def.category==='chariot') reg.plow=Math.max(0,...reg.soldiers.filter(s=>s.alive).map(s=>s.plowLeft))
    if (reg.retargeting) {
      const oldContact=reg.soldiers.some(s=> {
        if (!s.alive) return false
        queryContacts(pad.spatial,s.x,s.y,def,reg.side,def.reach+0.5,pad.buf)
        return pad.buf.some(i=> {
          const other=live[i]
          return other.reg.side!==reg.side && other.reg.id!==reg.targetId && other.s.alive && other.s.down<=0 && gapBetween(s,def,other.s,other.def)<=def.reach+0.5
        })
      })
      if (!oldContact) reg.retargeting=false
    }
    if (firesMissiles(reg) || reg.order === 'move' || reg.routing) reg.engaged = false
    else if (reg.order === 'attack' || reg.order === 'hold') reg.engaged = linePressed(reg, def, live, pad)
    // The charge is the whole line's (RULES 四.3): it is over when the line is held, not when its first man touches an
    // enemy. Carts have no line; theirs is over when they are in among the enemy and no longer ploughing.
    if (def.category === 'chariot' ? reg.inContact && reg.plow <= 0 : reg.engaged) reg.wantCharge = false

    if (def.category === 'chariot') {
      // Bogged only when most carts are stuck: touching the enemy, slow, no charge to plough on with and unable to push
      // the men in front aside. One cart caught in a crowd does not hold back the others, and carts pushing their way
      // through at shove pace are not stuck. Once most carts are free or pushing again, the bog time runs back down
      // and the regiment comes unstuck (after as long as it took to bog), or at once when it is out of contact.
      const carts = reg.soldiers.filter(s => s.alive)
      const stuck = carts.filter(s => s.contactTime > 0 && (s.speed < 3.5 || reg.braceSlow > 0) && s.plowLeft <= 0 && !pad.pushing.has(s)).length
      const held = stuck > 0 && stuck * 2 >= carts.length
      if (reg.inContact && held && reg.plow <= 0) reg.bogTime += dt
      else reg.bogTime = Math.max(0, reg.bogTime - dt)
      if (reg.bogTime >= 2) reg.bogged = true
      if (reg.bogged && ((!reg.inContact && (reg.anchorSpeed > 8 || reg.order === 'move')) || (!held && reg.bogTime <= 0))) {
        reg.bogged = false
        reg.bogTime = 0
      }
    }

    reg.exertion=clamp(reg.exertion+fatigueRate(reg,def)*dt,0,FATIGUE.exhausted.threshold)
    reg.fatigue=fatigueAt(reg.exertion)
  }
}

/** Mean body speed above which a regiment is moving at all, m/s. */
const MOVING_SPEED = 0.3
/** Running means a mean body speed past this share of the running pace: halfway between walking (half of it) and running. */
const RUN_PACE = 0.75

/**
 * This step's exertion rate (RULES 六.1): one activity, chosen from what the bodies actually did rather than from
 * order or gait flags. Melee contact, then shooting or reloading, then charging (some model with charge intent whose
 * own speed reaches speedThreshold of its effective charge speed, the same relative rule as the charge itself), then
 * running (a mean body speed above walking pace; a routing regiment that moves always runs, whatever its gait toggle),
 * then walking, then standing.
 */
function fatigueRate(reg: Regiment, def: UnitDef): number {
  const rates = MECHANICS.fatigueRates
  if (reg.inContact) return rates.melee
  if (reg.shot) return rates.shooting
  const pace = fatigueMods(reg.fatigue).speed, charge = effectiveChargeSpeed(def, reg.fatigue)
  if (reg.wantCharge && reg.soldiers.some(s => s.alive && s.chargeArmed && speedPower(Math.sqrt(ownSpeedSq(s)), charge) > 0)) return rates.charge
  if (reg.bodySpeed <= MOVING_SPEED) return rates.rest
  return reg.routing || reg.bodySpeed > def.speed * pace * RUN_PACE ? rates.run : rates.walk
}

/**
 * Which face of a regiment's block an enemy body at (x, y) stands against (RULES 七.1): 0 its front (or in among its
 * ranks), 1 beside it, 2 behind it. The block is the frame's own rectangle. Anything level with the front rank or ahead
 * of it is in front, however far out to the side, so a longer enemy line overlapping the ends of this one is not at
 * its flank. Carts on the attack keep no formation and have no flank.
 */
function blockSide(reg: Regiment, def: UnitDef, x: number, y: number): 0 | 1 | 2 {
  if (reg.routing || (def.category==='chariot' && reg.order==='attack')) return 0
  const fx=Math.cos(reg.facing), fy=Math.sin(reg.facing), dx=x-reg.anchorX, dy=y-reg.anchorY
  const ahead=dx*fx+dy*fy
  if (ahead>=-def.radius) return 0
  const depth=(Math.ceil(reg.aliveCount/Math.max(1,reg.files))-1)*def.rankSpacing
  if (ahead<-depth-def.radius) return 2
  return Math.abs(dx*fy-dy*fx)>(Math.min(reg.files,reg.aliveCount)-1)*def.spacing/2+def.radius*0.5 ? 1 : 0
}

function updateMorale(battle: Battle, dt: number): void {
  const M=MECHANICS.morale
  const deadCommanders=[0,1].map(side=>battle.regiments.some(r=>r.side===side && unitDef(r.type).commander && r.aliveCount<=0 && r.soldiers.some(s=>!s.escaped)))
  for (const reg of battle.regiments) {
    if (reg.aliveCount<=0) continue
    const def=unitDef(reg.type)
    prune(reg.dealt,battle.time,M.combatWindow); prune(reg.taken,battle.time,Math.max(M.combatWindow,M.recentWindow))
    let routing=0, encourage=0, fear=false, friends=0, enemies=0
    for (const other of battle.regiments) {
      if (other.id===reg.id || other.aliveCount<=0) continue
      const distance=Math.hypot(other.anchorX-reg.anchorX,other.anchorY-reg.anchorY)
      const od=unitDef(other.type), strength=Math.min(1,other.aliveCount/Math.max(1,other.initial))
      if (other.side===reg.side) {
        if (other.routing && distance<=M.routingFriendRadius) routing++
        if (!other.routing && distance<=MECHANICS.encourageRadius) encourage=Math.max(encourage,od.encourage)
        if (!other.routing && distance<=M.supportRadius) friends+=strength
      } else if (!other.routing) {
        if (distance<=M.supportRadius) enemies+=strength
        if (distance<=MECHANICS.fearRadius && !def.immunePsychology && !def.causesTerror && od.causesFear && !def.causesFear) fear=true
      }
    }
    // Escaping removes field strength, but is not damage to the soldiers left behind.
    const deployed=Math.max(1,reg.initial-reg.soldiers.filter(s=>s.escaped).length)*reg.modelHp
    const health=reg.soldiers.reduce((sum,s)=>sum+(s.alive?s.hp:0),0)
    let recent=0, dealt=0, taken=0
    for (const e of reg.taken) {
      if (battle.time-e.t<=M.recentWindow) recent+=e.v
      if (e.melee && battle.time-e.t<=M.combatWindow) taken+=e.v
    }
    for (const e of reg.dealt) if (e.melee) dealt+=e.v
    // A flank or rear attack is several men fought from that side at once (blockSide), not one enemy who got round.
    if (reg.flankTouch>=M.flankMen) reg.flankHold=M.flankHold
    if (reg.rearTouch>=M.flankMen) reg.rearHold=M.flankHold
    // A mounted charge shakes the regiment when it goes home: not a stray rider, and not one that mostly broke on braced spears.
    if (reg.shockHits>=M.chargedMen && reg.shockHits>reg.stoppedHits) reg.chargedHold=M.chargedTime
    // Charging (RULES 四.3): the regiment is running in to charge and a model of it has reached charging speed, or
    // the charge it delivered has not yet faded. Men jogging up behind a line already fighting are not a charge.
    let charging=0
    if (!firesMissiles(reg) && !reg.routing) {
      const top=effectiveChargeSpeed(def,reg.fatigue)
      for (const s of reg.soldiers) {
        if (!s.alive) continue
        const share=s.chargeLeft>0 ? chargeStrength(s) : reg.wantCharge && s.chargeArmed && speedPower(Math.sqrt(ownSpeedSq(s)),top)>0 ? 1 : 0
        if (share>charging) charging=share
      }
    }
    reg.moraleFactors=leadershipFactors({
      base:def.leadership, lost:1-health/deployed, recentLoss:recent/Math.max(1,health+recent),
      dealt:dealt/deployed, taken:taken/deployed, friends, enemies,
      flank:reg.flankHold>0, rear:reg.rearHold>0, charged:reg.chargedHold/M.chargedTime, underFire:reg.fireHold>0, charging,
      routingFriends:routing, encourage, commanderDead:deadCommanders[reg.side],
      fear, fatigue:fatigueMods(reg.fatigue).leadership,
    })
    reg.flankHold=Math.max(0,reg.flankHold-dt); reg.rearHold=Math.max(0,reg.rearHold-dt)
    reg.fireHold=Math.max(0,reg.fireHold-dt); reg.chargedHold=Math.max(0,reg.chargedHold-dt)
    reg.leadership=Object.values(reg.moraleFactors).reduce((sum,v)=>sum+v,0)
    // Only this step's actual damage can request terror. Ordinary morale breaks
    // take precedence and never spend a source's terror cooldown.
    const breaking=reg.leadership<=MECHANICS.instantRoutLeadership || (reg.leadership<0 && reached(reg.negativeTime+dt,MECHANICS.routDelay))
    const vulnerable=!reg.routing && !def.unbreakable && !def.immunePsychology && !def.causesTerror && !breaking && reg.leadership<MECHANICS.terrorLeadership
    const terrorSource=vulnerable ? reg.terrorHits.map(id=>regimentById(battle,id)).find(source=>
      source && source.side!==reg.side && unitDef(source.type).causesTerror && source.terrorCooldown<=0) : undefined
    // advanceMorale only reads enemy proximity for a routing unit that could start to rally; skip the scan otherwise.
    const enemyNear=reg.routing && !reg.shattered && !def.unbreakable && reg.leadership>=0 && enemyWithin(battle,reg,MECHANICS.rallyEnemyDistance)
    const transition=advanceMorale(reg,reg.leadership,enemyNear,!!terrorSource,dt)
    if (transition==='routed' || transition==='shattered') {
      if (terrorSource) terrorSource.terrorCooldown=MECHANICS.terrorCooldown
      pushNotice(battle,terrorSource?`${reg.name}被${terrorSource.name}惊骇${reg.shattered?'，彻底溃散':''}`:`${reg.name}${transition==='shattered'?'彻底溃散':'溃逃'}`)
      dropOrders(reg)
    } else if (transition==='rallied') {
      const center=aliveCenter(reg)
      if (!center) continue
      reg.destX=reg.anchorX; reg.destY=reg.anchorY; reg.order='hold'; reg.targetId=null
      const enemy=nearestEnemyRegiment(battle,reg)
      reg.destFacing=enemy?Math.atan2(enemy.anchorY-center.y,enemy.anchorX-center.x):reg.facing
      // Assign new places around the scattered survivors, without moving bodies.
      reformAt(reg,reg.files,reg.destFacing)
      reg.destX=reg.anchorX;reg.destY=reg.anchorY
      pushNotice(battle,`${reg.name}重整`)
    }
  }
}

/** A regiment that breaks drops what it was doing: its order, its target, its queued orders and every blow under way. */
function dropOrders(reg: Regiment): void {
  reg.order='hold'; reg.targetId=null; reg.wantCharge=false; reg.engaged=false; reg.retargeting=false; reg.queue=[]
  reg.destX=reg.anchorX; reg.destY=reg.anchorY
  for (const s of reg.soldiers) { s.swing=null; s.chargeArmed=false; s.plowLeft=0; s.cartPath=null }
}

/**
 * The battle is decided on the power bar (RULES 八.2), and nowhere else: an army pushed past its mark
 * (ArmyPower.losing) has lost. Every regiment of it still on the field breaks at once and for good; unbreakable ones
 * fight on. Nothing stops: the beaten run for the map edge, the victors may ride them down, and the player ends the
 * battle when he likes. A regiment that merely routs keeps its value on the bar and decides nothing.
 */
function decideBattle(battle: Battle): void {
  const power = refreshPower(battle)
  if (battle.winner !== null) return
  const [south, north] = power.losing
  if (!south && !north) return
  battle.winner = south && north ? -1 : south ? 1 : 0
  for (const reg of battle.regiments) {
    if (!power.losing[reg.side] || reg.aliveCount <= 0 || reg.shattered || unitDef(reg.type).unbreakable) continue
    shatter(reg)
    dropOrders(reg)
  }
  for (const side of [0, 1] as const) if (power.losing[side]) pushNotice(battle, `${side === 0 ? '南军' : '北军'}全军溃散`)
  refreshPower(battle)
}

function collisionMass(item: Live, otherX: number, otherY: number): number {
  if (item.s.down > 0) return item.def.mass * 0.3
  if (bracedAgainst(item.reg, item.def, item.s, otherX, otherY)) return item.def.mass * bracingMassMultiplier(item.reg)
  return item.def.mass
}

/** How long a chariot keeps its charge after it last ran over men who were not braced. */
const PLOW_TIME = 1.8

/** Men standing behind a man the cart pushes support him if they are within this depth and half-width of his line. */
const TRACTION_SUPPORT_DEPTH = 2.5
const TRACTION_SUPPORT_WIDTH = 0.6
const TRACTION_SUPPORT_MAX = 3
/** A man the cart pushes counts as straight ahead of it, and is pushed over rather than aside, at this forward share. */
const TRACTION_PUSHOVER_LOAD = 0.5

/** A cart shoving into a man slowly pushes him over where he stands: down as from a ram, but barely thrown. */
function pushOver(soldier: Soldier, fx: number, fy: number, speed: number): void {
  const drift = Math.min(2, Math.max(0.5, speed))
  soldier.down = KNOCK_TIME
  soldier.knockVx = fx * drift
  soldier.knockVy = fy * drift
  soldier.speed = 0
  soldier.idle = false
}

/** Toss a foot soldier along the charge. Heavier mounts throw him farther. Immune until he gets up. */
function knockDown(
  soldier: Soldier,
  nx: number,
  ny: number,
  closing: number,
  attackerMass: number,
  vx: number,
  vy: number,
): void {
  const heft = Math.min(2.1, Math.sqrt(attackerMass / 480))
  const launch = Math.min(12, Math.max(8, closing * 0.8 * heft))
  const speed = Math.hypot(vx, vy)
  let fx = nx
  let fy = ny
  if (speed > 1) {
    fx = (vx / speed) * 0.8 + nx * 0.2
    fy = (vy / speed) * 0.8 + ny * 0.2
  }
  const flen = Math.hypot(fx, fy) || 1
  soldier.down = KNOCK_TIME
  soldier.knockVx = (fx / flen) * launch
  soldier.knockVy = (fy / flen) * launch
  soldier.speed = 0
  soldier.idle = false
}

/**
 * Damage after armour and resistances. HP lost to an enemy melee hit (collision attacks included, which WH3 defines as
 * melee) is what stops the target's march (settleMoveOrders); missiles, misses and zero-damage hits do not.
 */
function hurt(battle: Battle, target: Live, source: Regiment | null, base: number, ap: number, kind: 'melee' | 'missile', traits: DamageTraits = {}, floater = false): void {
  if (target.s.down > 0) return
  const armor = target.def.armor * fatigueMods(target.reg.fatigue).armor
  const resistance = resistanceMultiplier(target.def.resistances,kind,traits)
  const damage = Math.round(mitigate(base,0,armor,armorRoll(battle.rng))*resistance) + Math.round(ap*resistance)
  if (damage <= 0 || !target.s.alive) return
  target.s.hp -= damage
  if (target.def.wounds && target.s.hp <= target.reg.modelHp*target.def.wounds.threshold) target.s.wounded=true
  target.s.flash = 0.12
  const now = battle.time
  const actual = Math.min(damage, Math.max(0,target.s.hp+damage))
  target.reg.taken.push({ t: now, v: actual, melee: kind === 'melee' })
  if (source && source.side !== target.reg.side) {
    source.dealt.push({ t: now, v: actual, melee: kind === 'melee' })
    if (kind === 'missile') target.reg.fireHold = MECHANICS.morale.underFireTime
    if (unitDef(source.type).causesTerror && !target.reg.terrorHits.includes(source.id)) target.reg.terrorHits.push(source.id)
    if (kind === 'melee') scratchOf(battle).struck.add(target.reg)
  }
  if (floater && damage >= 8) {
    battle.fx.push({
      x: target.s.x,
      y: target.s.y,
      text: String(Math.round(damage)),
      life: 0.75,
    })
    if (battle.fx.length > 40) battle.fx.splice(0, battle.fx.length - 40)
  }
  if (target.s.hp <= 0) kill(battle, target.reg, target.s)
}

function kill(battle: Battle, reg: Regiment, soldier: Soldier): void {
  if (!soldier.alive) return
  soldier.alive = false
  soldier.hp = 0
  soldier.deathTime = battle.time
  reg.aliveCount = Math.max(0, reg.aliveCount - 1)
}

function refreshCounts(battle: Battle): void {
  for (const reg of battle.regiments) {
    reg.aliveCount = reg.soldiers.reduce((sum, soldier) => sum + (soldier.alive ? 1 : 0), 0)
  }
}

function prune(events: { t: number }[], now: number, horizon: number): void {
  while (events.length > 0 && now - events[0].t > horizon) events.shift()
}

function aliveCenter(reg: Regiment): { x: number; y: number } | null {
  let x = 0
  let y = 0
  let n = 0
  for (const soldier of reg.soldiers) {
    if (!soldier.alive) continue
    x += soldier.x
    y += soldier.y
    n++
  }
  if (n === 0) return null
  return { x: x / n, y: y / n }
}

function enemyWithin(battle: Battle, reg: Regiment, range:number): boolean {
  const center = aliveCenter(reg)
  if (!center) return false
  const bound=(range+1e-9)**2
  for (const other of battle.regiments) {
    if (other.side === reg.side) continue
    for (const soldier of other.soldiers) {
      if (!soldier.alive) continue
      const dx=soldier.x-center.x,dy=soldier.y-center.y
      if(dx*dx+dy*dy<=bound&&Math.hypot(dx,dy)<range) return true
    }
  }
  return false
}

function nearestEnemyRegiment(battle: Battle, reg: Regiment): Regiment | null {
  let best: Regiment | null = null
  let bestD = Infinity
  for (const other of battle.regiments) {
    if (other.side === reg.side || other.aliveCount <= 0) continue
    const distance = Math.hypot(other.anchorX - reg.anchorX, other.anchorY - reg.anchorY)
    if (distance < bestD) {
      best = other
      bestD = distance
    }
  }
  return best
}

function pushNotice(battle: Battle, text: string): void {
  battle.notices.unshift({ text, life: 5.5 })
  if (battle.notices.length > 5) battle.notices.pop()
}
