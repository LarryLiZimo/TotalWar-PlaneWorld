import { planEnemyIntents } from './ai'
import {
  calibrationRadius,
  armorRoll,
  chargeDecay,
  CHARGE_DURATION,
  defenseMultiplier,
  leadershipFactors,
  fatigueMods,
  hitChance,
  KNOCK_TIME,
  impactRaw,
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
  reformAt,
  reformMoving,
  slotOf,
  travelFacing,
} from './formation'
import { DEG, angDiff, clamp, facingArc, forward, mulberry32, rayCircleT } from './math'
import { commandAttack, commandHold, commandMove, regimentById } from './orders'
import { shapePoints } from './formation'
import { Spatial } from './spatial'
import type { Battle, DamageTraits, Projectile, Regiment, Side, Soldier, UnitDef, UnitType } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { isCavalry, unitDef } from './units'
import { FATIGUE, MECHANICS, fatigueAt } from './mechanics'
import { elevationAt, elevationDamage, slopeFatigue, slopeSpeed } from './terrain'
import { advanceMorale, armyPressure } from './morale'
import { sweptCylinderT } from './ballistics'
import { bodyContact, collisionExtent, collisionRadius, contactPush, contactSoftDepth, groundDrag, moveGroundDrift, normalImpulse } from './physics'

const NORTH = Math.PI / 2
const SOUTH = -Math.PI / 2

interface Scratch {
  spatial: Spatial
  buf: number[]
  live: Live[]
  indexOf: Map<number, number>
}

const scratches = new WeakMap<Battle, Scratch>()
const compactedCounts = new WeakMap<Regiment, number>()
const attackPicks = new WeakMap<Soldier,{target:Soldier;index:number}>()

function scratchOf(battle: Battle): Scratch {
  let found = scratches.get(battle)
  if (!found) {
    found = { spatial: new Spatial(2, 2048), buf: [], live: [], indexOf: new Map() }
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
    nextId: 1,
    pending: [],
    appliedSig: new Map(),
    widthOrder: new Map(),
    soldierById: new Map(),
    aiEnabled: false,
    terrain: { kind: 'flat', rise: 0, axis: 'y' },
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
    facingLocked: true,
    targetId: null,
    exertion: 0,
    fatigue: 'fresh',
    restTime: 0,
    run: true,
    fireAtWill: true,
    skirmish: !!def.missile?.arc,
    skirmishing: false,
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
    touchFlank: false,
    touchRear: false,
    shot: false,
    engaged: false,
    contactLock: 0,
    retargeting: false,
    attackCommitted: false,
    nearEnemy: false,
    meleeReact: false,
    rearFoe: null,
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
      fleeX: 0,
      fleeY: 0,
      latched: [],
      cleave: 0,
      flash: 0,
      down: 0,
      knockVx: 0,
      knockVy: 0,
      chargeLeft: 0,
      chargeArmed: false,
      reactTo: null,
      reactTime: 0,
      prevX: 0,
      prevY: 0,
      prevFacing: facing,
      chargeContactAt: -1, swing: null, collisionCd: 0, braceTime: 0, wounded: false,
      plowLeft: 0, plowX: x, plowY: y,
      pushVx: 0, pushVy: 0, blockedTime: 0, avoidSide: 0,
      bypass: null,
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
  if (battle.winner !== null) return
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
  }
  for (const reg of battle.regiments) {
    reg.contactLock = Math.max(0, reg.contactLock - dt)
    reg.terrorCooldown = Math.max(0, reg.terrorCooldown - dt)
    reg.terrorHits.length=0
  }
  battle.time += dt
  ageTransient(battle, dt)
  applyAi(battle, dt)
  for (const reg of battle.regiments) {
    if (!updateSkirmish(battle,reg) && reg.order === 'attack') updateAttackDest(battle, reg)
    faceMelee(reg)
    armCharge(battle, reg)
  }
  moveRegiments(battle, dt)
  const pad = scratchOf(battle)
  const live = buildLive(battle, pad)
  moveSoldiers(battle, live, pad, dt)
  for (const reg of battle.regiments) {
    reg.inContact = false
    reg.touchFlank = false
    reg.touchRear = false
    reg.shot = false
  }
  const grid = fillGrid(pad, live)
  resolveMelee(battle, live, grid, pad.buf, dt)
  resolveCollisionAttacks(battle, live, grid, pad.buf)
  resolveShooting(battle, live, grid, pad, dt)
  flyProjectiles(battle, live, grid, pad.buf, dt)
  resolveImpact(battle, live, grid, pad.buf)
  separate(live, pad,dt)
  absorbBumps(live)
  clampBodies(battle)
  finishChargeFatigueBog(battle, live, pad, dt)
  updateMorale(battle, dt)
  for (const reg of battle.regiments) {
    if (!reg.routing && compactedCounts.get(reg) !== reg.aliveCount) {
      compactRanks(reg)
      compactedCounts.set(reg, reg.aliveCount)
    }
  }
  refreshCounts(battle)
  checkVictory(battle)
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

function updateSkirmish(battle: Battle, reg: Regiment): boolean {
  const wasRetreating=reg.skirmishing
  reg.skirmishing=false
  if (wasRetreating && reg.order==='hold') { reg.destX=reg.anchorX; reg.destY=reg.anchorY }
  if (!reg.skirmish || !unitDef(reg.type).missile || reg.routing || reg.aliveCount<=0 || reg.order==='move') return false
  let threat: Regiment | null=null, distance=wasRetreating?30:22
  for (const other of battle.regiments) {
    if (other.side===reg.side || other.aliveCount<=0 || other.routing) continue
    const d=Math.hypot(other.anchorX-reg.anchorX,other.anchorY-reg.anchorY)
    if (d<distance) { threat=other; distance=d }
  }
  if (!threat) return false
  const dx=threat.anchorX-reg.anchorX, dy=threat.anchorY-reg.anchorY
  const angle=distance>0.01?Math.atan2(dy,dx):reg.facing
  reg.destX=clamp(threat.anchorX-Math.cos(angle)*30,3,MAP_WIDTH-3)
  reg.destY=clamp(threat.anchorY-Math.sin(angle)*30,3,MAP_HEIGHT-3)
  reg.destFacing=angle; reg.facingLocked=true; reg.skirmishing=true
  return true
}

function updateAttackDest(battle: Battle, reg: Regiment): void {
  if (reg.targetId === null) return
  const target = regimentById(battle, reg.targetId)
  if (!target || target.aliveCount <= 0) {
    commandHold(battle, [reg.id])
    return
  }
  const dx = target.anchorX - reg.anchorX
  const dy = target.anchorY - reg.anchorY
  const distance = Math.hypot(dx, dy) || 1
  const def = unitDef(reg.type)
  if (!def.missile) {
    reg.destFacing = Math.atan2(dy, dx)
    reg.facingLocked = true
  }
  if (!def.missile && def.type!=='chariot' && reg.engaged && !reg.retargeting) {
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.wantCharge = false
    return
  }
  if (def.missile) {
    const toEnemy = Math.atan2(dy, dx)
    const offCenter = Math.abs(angDiff(reg.facing, toEnemy))
    const turningOnto = Math.abs(angDiff(reg.facing, reg.destFacing)) > 8 * DEG && Math.abs(angDiff(reg.destFacing, toEnemy)) < 15 * DEG
    if (offCenter > fireHalf(def) || turningOnto) {
      reg.destFacing = toEnemy
      reg.facingLocked = true
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
  reg.destX = clamp(target.anchorX, 3, MAP_WIDTH - 3)
  reg.destY = clamp(target.anchorY, 3, MAP_HEIGHT - 3)
}

/** Melee contact is remembered only while it lasts. It does not turn the whole block. */
function faceMelee(reg: Regiment): void {
  if (reg.routing || reg.aliveCount <= 0 || reg.plow > 0) return
  if (!reg.engaged && !reg.inContact) {
    reg.meleeReact = false
    reg.rearFoe = null
  }
}

function chargeSpeedReached(battle: Battle, reg: Regiment, def: UnitDef, s: Soldier, speed: number): boolean {
  if (!s.alive || s.down > 0 || s.chargeLeft > 0 || !reg.run || reg.routing || reg.order !== 'attack') return false
  const required = def.chargeSpeed * fatigueMods(reg.fatigue).speed * slopeSpeed(battle, s.facing)
  // Numerical tolerance only; there is no extra minimum speed, approach angle,
  // distance, formation-cohesion or unit-category requirement.
  return required > 0 && speed + 1e-6 >= required
}

function armCharge(battle: Battle, reg: Regiment): void {
  const def = unitDef(reg.type)
  const approaching = reg.run && reg.order === 'attack' && !reg.routing
  reg.wantCharge = approaching && (!reg.engaged || def.type === 'chariot')
  // Speed from the preceding movement step also counts when contact stops the
  // model at the start of this step. A slower subsequent step clears readiness.
  for (const s of reg.soldiers) s.chargeArmed = chargeSpeedReached(battle, reg, def, s, s.speed)
}

function moveSpeedOf(reg: Regiment, soldier?: Soldier): number {
  const def = unitDef(reg.type)
  const mods = fatigueMods(reg.fatigue)
  // The formation can be engaged while individual reserves are still running
  // into the fight. Their approach pace must not inherit the frame's slow gait.
  const charging = (reg.wantCharge || (soldier !== undefined && reg.order === 'attack') || (def.type === 'chariot' && (soldier?.plowLeft ?? 0) > 0)) && reg.run && !reg.routing
  const body = soldier ?? (def.models === 1 ? reg.soldiers[0] : undefined)
  let speed = (charging ? def.chargeSpeed : def.speed * woundMods(def, body).speed) * mods.speed
  if (!reg.run && !charging && !reg.routing) speed *= 0.5
  if (reg.routing) speed *= 1.1
  if (reg.braceSlow > 0) speed = Math.min(speed, 1.5)
  if (reg.bogged && reg.inContact && reg.order !== 'move') speed = Math.min(speed, 1.8)
  if (soldier && soldier.disengage > 0) speed *= 0.55
  return speed
}

function accelRate(def: UnitDef, speedingUp: boolean): number {
  const base = def.type === 'chariot' ? 2.2 : isCavalry(def.type) ? 2.8 : 1.7
  return speedingUp ? base : base * 1.7
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
    } else if (def.type==='chariot' && (reg.order==='attack'||reg.order==='move')) {
      // The attack frame follows actual carts. It never sends them back to empty slots.
      const center=aliveCenter(reg)!
      reg.facing=reg.order==='move'&&Math.hypot(reg.destX-center.x,reg.destY-center.y)>PLACE_RADIUS?Math.atan2(reg.destY-center.y,reg.destX-center.x):reg.destFacing
      const depth=(Math.ceil(reg.aliveCount/Math.max(1,reg.files))-1)*def.rankSpacing/2
      reg.anchorX=center.x+Math.cos(reg.facing)*depth
      reg.anchorY=center.y+Math.sin(reg.facing)*depth
      reg.anchorSpeed=reg.bodySpeed
      reg.stationaryTime=reg.bodySpeed<0.28?reg.stationaryTime+dt:0
    } else if (reg.engaged && !def.missile && reg.plow <= 0) {
      reg.anchorSpeed = approach(reg.anchorSpeed, 0, accelRate(def, false) * 2.4, dt)
      reg.stationaryTime += dt
    } else {
      const dx = reg.destX - reg.anchorX
      const dy = reg.destY - reg.anchorY
      const distance = Math.hypot(dx, dy)
      const meleeAttack = reg.order === 'attack' && !def.missile
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
  const closing = reg.order === 'attack' && !def.missile && distance < releaseRange(def) * 2
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
  const top = moveSpeedOf(reg) * keepUp * settling * slopeSpeed(battle, heading)
  const lever = halfWidth(reg)
  if (footed) {
    const maxOmega = Math.min(def.turnCap, ((catchUpOf(reg, def) - 1) * moveSpeedOf(reg)) / lever)
    const wantOmega = Math.abs(err) < 0.01 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
    reg.facing += approach(reg.turnRate, wantOmega, maxOmega * 2, dt) * dt
    reg.anchorSpeed = approach(reg.anchorSpeed, top, accelRate(def, top > reg.anchorSpeed), dt)
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
  reg.anchorSpeed = approach(reg.anchorSpeed, target, accelRate(def, target > reg.anchorSpeed), dt)
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
    if (item.def.shape === 'capsule') {
      for (const point of shapePoints(item.s, item.def)) grid.insert(point.x, point.y, i,withSides?item.reg.side:undefined)
    } else {
      grid.insert(item.s.x, item.s.y, i,withSides?item.reg.side:undefined)
    }
  }
  return grid
}

function moveSoldiers(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  const grid = fillGrid(pad, live)
  const buf = pad.buf
  const lagSum = new Map<Regiment, SlotTally>()
  const speedSum = new Map<Regiment, number>()
  const press: Press = { live, grid, buf, near: new Map(), claims: new Map(), warmed:new Set(),bounds:new Map(),lanes:new Map() }
  for (const reg of battle.regiments) {
    reg.nearEnemy = false
    lagSum.set(reg, { total: 0, trail: 0, count: 0 })
  }
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    const { s, reg, def } = item
    // A target's bodies can have moved since another regiment examined them.
    press.bounds.delete(reg)
    press.lanes.delete(reg)
    const nearby = reg.routing?null:nearestEnemy(live, grid, buf, i, def.reach + 0.5, reg.order === 'hold')
    const foe = reg.retargeting ? nearestEnemy(live,grid,buf,i,def.reach+0.5,false,reg.targetId) : nearby
    const gapToFoe = foe ? gapBetween(s, def, foe.s, foe.def) : Infinity
    if (foe && gapToFoe < 14) reg.nearEnemy = true
    const enemyNear = !!nearby && gapBetween(s,def,nearby.s,nearby.def)<=def.reach && (!reg.retargeting || nearby.reg.id!==reg.targetId)
    const touching = gapToFoe <= 0.15
    if ((reg.order !== 'move' && !reg.retargeting) || reg.routing) {
      s.leaving = false
      s.disengage = 0
    } else if (enemyNear) {
      if (!s.leaving) {
        s.leaving = true
        s.disengage = def.missile ? 0.5 : 2
      }
    } else {
      s.leaving = false
      s.disengage = 0
    }
    if (s.disengage > 0) s.disengage = Math.max(0, s.disengage - dt)

    const localMelee = !!foe && gapToFoe <= def.reach
    const groundPace = moveSpeedOf(reg, s) * slopeSpeed(battle, s.facing)
    // Only bodies already in weapon reach use melee approach speed. A front
    // rank's contact must not slow distant ranks or detached individual models.
    let gait = localMelee && reg.engaged && !reg.retargeting && def.type !== 'chariot' && reg.order !== 'move' && !reg.routing ? Math.min(2, groundPace) : groundPace
    if(def.type==='chariot' && nearby && nearby.def.physicalSize<=1 && gapBetween(s,def,nearby.s,nearby.def)<0.3 && s.speed<5 && s.plowLeft<=0) gait=Math.min(gait,MECHANICS.cartShoveSpeed)
    const lever = turnLever(def)
    const ox = s.x
    const oy = s.y
    const fighting = localMelee && reg.engaged && reg.plow <= 0 && !def.missile && !reg.routing && s.down <= 0
    const frontRank = s.rank === 0 && s.centerIndex < 0
    const runningIn = reg.order === 'attack' && !def.missile && !reg.engaged
    const inFight = !!foe && reg.order !== 'move' && reg.plow <= 0 && !reg.routing && gapToFoe <= (runningIn ? 0.15 : def.reach)
    if (s.down > 0) {
      lieDown(s, dt)
    } else if(reg.routing) {
      fleeSoldier(battle,reg,def,s,gait,lever,dt)
    } else if (def.type==='chariot' && (reg.order==='attack'||reg.order==='move') && !reg.routing) {
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
    } else if (inFight && foe) {
      rotate(def, s, angDiff(s.facing, Math.atan2(foe.s.y - s.y, foe.s.x - s.x)), gait, lever, dt)
      s.speed = 0
      s.idle = false
    } else {
      const attacking = reg.order === 'attack' && !def.missile && !reg.routing && reg.plow <= 0
      if (!attacking || !chargeAt(battle, reg, def, s, gait, lever, dt, press)) {
        followSlot(reg, def, s, gait, lever, dt, fighting, lagSum.get(reg)!,press)
      }
    }
    // Sample powered movement before external drift, so being shoved cannot
    // create a charge. Reaching charge speed in this very step also counts.
    if (chargeSpeedReached(battle, reg, def, s, Math.hypot(s.x - ox, s.y - oy) / dt)) s.chargeArmed = true
    if(s.down<=0) moveGroundDrift(s,dt)
    s.vx = (s.x - ox) / dt
    s.vy = (s.y - oy) / dt
    s.braceTime = Math.hypot(s.vx,s.vy) < 0.25 && Math.abs(s.omega) < MECHANICS.braceTurnRate && s.down <= 0 ? s.braceTime + dt : 0
    const moved = speedSum.get(reg) ?? 0
    speedSum.set(reg, moved + Math.hypot(s.vx, s.vy))
  }
  for (const reg of battle.regiments) {
    const sum = lagSum.get(reg)!
    reg.lag = sum.count > 0 ? sum.total / sum.count : 0
    reg.trail = sum.count > 0 ? sum.trail / sum.count : 0
    reg.bodySpeed = reg.aliveCount > 0 ? (speedSum.get(reg) ?? 0) / reg.aliveCount : 0
    if(reg.routing&&reg.aliveCount>0) {
      const center=aliveCenter(reg)!
      reg.anchorX=reg.destX=center.x;reg.anchorY=reg.destY=center.y
    }
  }
}

/** Individuals stream in one direction, with smooth differences instead of ranks.
 * Identity-derived variation is repeatable and does not consume combat RNG. */
function fleeSoldier(battle:Battle,reg:Regiment,def:UnitDef,s:Soldier,gait:number,lever:number,dt:number):void {
  let hash=Math.imul(s.id^battle.seed^Math.imul(reg.routCount,0x9e3779b9),0x45d9f3b)
  hash=(hash^(hash>>>16))>>>0
  const phase=(hash&0xffff)/0xffff*Math.PI*2
  const pace=(hash>>>16)/0xffff
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

/** Attack with each cart's actual body, without formation or cohesion steering. */
function driveChariot(battle: Battle, reg: Regiment, def: UnitDef, s: Soldier, gait: number, lever: number, dt: number): void {
  s.idle=false
  if (s.plowLeft>0) {
    const dx=s.plowX-s.x, dy=s.plowY-s.y
    if (Math.hypot(dx,dy)>0.4 && dx*Math.cos(s.facing)+dy*Math.sin(s.facing)>0) {
      const distance=Math.hypot(dx,dy)
      steer(def,s,Math.atan2(dy,dx),Math.min(gait,Math.sqrt(2*accelRate(def,false)*distance)),gait,lever,dt,distance,distance)
      return
    }
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

/** How many of the attacker's men are already about each enemy soldier this step, so the rest spread out. */
interface Press {
  live: Live[]
  grid: Spatial
  buf: number[]
  near: Map<Soldier, number>
  claims: Map<Soldier, number>
  warmed: Set<Regiment>
  bounds: Map<Regiment,{minX:number;maxX:number;minY:number;maxY:number}>
  lanes: Map<Regiment,{minR:number;maxR:number;minL:number;maxL:number}>
}

/** Men already this close round an enemy soldier count as crowding him. */
const CROWD_RADIUS = 2.5
/** Metres further a man will run to reach an enemy soldier with one fewer man on him. */
const CROWD_COST = 3

function crowdOn(press: Press, foe: Soldier, side: Regiment['side']): number {
  const cached = press.near.get(foe)
  if (cached !== undefined) return cached
  press.grid.query(foe.x, foe.y, CROWD_RADIUS, press.buf,side)
  let count = 0
  for (const index of press.buf) {
    const other = press.live[index]
    if (other.reg.side !== side || !other.s.alive) continue
    if ((other.s.x - foe.x) ** 2 + (other.s.y - foe.y) ** 2 <= CROWD_RADIUS ** 2) count += 1
  }
  press.near.set(foe, count)
  return count
}

/**
 * On an attack order the block keeps its ranks on the way in. A man who has come within release range of
 * the target leaves his place and runs in. Once the block is locked in melee, every man with no one to fight
 * goes for the target, so the wings wrap round its flanks. Each picks an enemy soldier near him who is not
 * already mobbed. Returns false while he should keep his place.
 */
function chargeAt(
  battle: Battle,
  reg: Regiment,
  def: UnitDef,
  s: Soldier,
  gait: number,
  lever: number,
  dt: number,
  press: Press,
): boolean {
  if (def.type === 'chariot') return false
  const target = reg.targetId !== null ? regimentById(battle, reg.targetId) : undefined
  if (!target || target.aliveCount <= 0) return false
  if(!press.warmed.has(target)) {
    // Preserve the original first-attacker crowd snapshot before pruning any
    // candidates. Later soldiers must not sample a different moving crowd.
    for(const foe of target.soldiers) if(foe.alive) crowdOn(press,foe,reg.side)
    press.warmed.add(target)
  }
  const release=releaseRange(def),needsRelease=!reg.engaged&&!reg.attackCommitted
  if(needsRelease) {
    let box=press.bounds.get(target)
    if(!box) {
      box={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity}
      for(const foe of target.soldiers) if(foe.alive) {
        box.minX=Math.min(box.minX,foe.x);box.maxX=Math.max(box.maxX,foe.x)
        box.minY=Math.min(box.minY,foe.y);box.maxY=Math.max(box.maxY,foe.y)
      }
      press.bounds.set(target,box)
    }
    const dx=Math.max(box.minX-s.x,0,s.x-box.maxX),dy=Math.max(box.minY-s.y,0,s.y-box.maxY)
    if(dx*dx+dy*dy>(release+1e-9)**2) return false
  }
  let nearestSq = Infinity
  let nearest:Soldier|null=null
  let bestCost = Infinity
  let bestIndex = Infinity
  let pick: Soldier | null = null
  const previous=attackPicks.get(s)
  if(previous?.target.alive&&target.soldiers[previous.index]===previous.target) {
    const foe=previous.target,d=Math.hypot(foe.x-s.x,foe.y-s.y)
    const crowd=crowdOn(press,foe,reg.side)-(d<=CROWD_RADIUS?1:0)+(press.claims.get(foe)??0)
    pick=foe;bestIndex=previous.index;bestCost=d+CROWD_COST*Math.max(0,crowd)
  }
  for (let index=0;index<target.soldiers.length;index++) {
    const foe=target.soldiers[index]
    if (!foe.alive) continue
    const dx=foe.x-s.x,dy=foe.y-s.y,d2=dx*dx+dy*dy
    if(d2<nearestSq) {nearestSq=d2;nearest=foe}
    // Cost is distance plus a nonnegative crowd penalty. A more distant body
    // cannot beat the current winner; retain native distance for contenders.
    if(d2>(bestCost+1e-9)**2) continue
    const d = Math.hypot(foe.x - s.x, foe.y - s.y)
    const self = d <= CROWD_RADIUS ? 1 : 0
    const crowd = crowdOn(press, foe, reg.side) - self + (press.claims.get(foe) ?? 0)
    const cost = d + CROWD_COST * Math.max(0, crowd)
    if (cost < bestCost || (cost===bestCost&&index<bestIndex)) {
      bestCost = cost
      bestIndex = index
      pick = foe
    }
  }
  if (!pick || (needsRelease && nearest && Math.hypot(nearest.x-s.x,nearest.y-s.y)>release)) return false
  if(previous) {previous.target=pick;previous.index=bestIndex}
  else attackPicks.set(s,{target:pick,index:bestIndex})
  press.claims.set(pick, (press.claims.get(pick) ?? 0) + 1)
  const distance = Math.hypot(pick.x - s.x, pick.y - s.y)
  s.idle = false
  const heading=attackLane(battle,s,def,pick,reg,press)
  steer(def, s, heading, gait, gait, lever, dt, distance, distance)
  return true
}

/** A reserve walks around a blocked friendly lane instead of pushing the whole line. */
function attackLane(battle:Battle,s:Soldier,def:UnitDef,target:Soldier,reg:Regiment,press:Press):number {
  let heading=Math.atan2(target.y-s.y,target.x-s.x)
  if(s.blockedTime<0.25&&!s.bypass) return heading
  const reach=Math.max(2.2,def.radius*3)
  const nearby:number[]=[]
  press.grid.query(s.x,s.y,reach+def.radius+1,nearby,reg.side)
  const friends=nearby.map(i=>press.live[i]).filter(other=>other.s.id!==s.id&&other.reg.side===reg.side&&other.s.alive&&other.s.down<=0)
  if(!s.bypass&&s.blockedTime>0.4) {
    const obstacle=friends.find(other=>other.reg!==reg && other.reg.bodySpeed<0.5 && other.reg.aliveCount>1 && (other.s.x-s.x)*Math.cos(heading)+(other.s.y-s.y)*Math.sin(heading)>0)
    if(obstacle) {
      const r=obstacle.reg,fx=Math.cos(r.facing),fy=Math.sin(r.facing)
      const lateral=(s.x-r.anchorX)*fy-(s.y-r.anchorY)*fx
      const direction=Math.sign((target.x-s.x)*fx+(target.y-s.y)*fy)||1
      s.bypass={regId:r.id,side:lateral!==0?Math.sign(lateral):(s.id%2?1:-1),direction,passing:false}
    }
  }
  if(s.bypass) {
    const obstacle=regimentById(battle,s.bypass.regId)
    if(!obstacle || obstacle.aliveCount<=0 || obstacle.bodySpeed>0.8) s.bypass=null
    else {
      const od=unitDef(obstacle.type),fx=Math.cos(obstacle.facing),fy=Math.sin(obstacle.facing)
      let bounds=press.lanes.get(obstacle)
      if(!bounds) {
        bounds={minR:Infinity,maxR:-Infinity,minL:Infinity,maxL:-Infinity}
        for(const body of obstacle.soldiers) {
          if(!body.alive) continue
          const dx=body.x-obstacle.anchorX,dy=body.y-obstacle.anchorY
          const right=dx*fy-dy*fx,along=dx*fx+dy*fy
          bounds.minR=Math.min(bounds.minR,right-od.radius);bounds.maxR=Math.max(bounds.maxR,right+od.radius)
          bounds.minL=Math.min(bounds.minL,along-od.radius);bounds.maxL=Math.max(bounds.maxL,along+od.radius)
        }
        press.lanes.set(obstacle,bounds)
      }
      const {minR,maxR,minL,maxL}=bounds
      // Several parallel lanes keep a whole regiment from queueing at one corner.
      const pad=def.radius+0.55+(s.file%4)*(def.radius*2+0.2),route=s.bypass
      const selfR=(s.x-obstacle.anchorX)*fy-(s.y-obstacle.anchorY)*fx
      const selfL=(s.x-obstacle.anchorX)*fx+(s.y-obstacle.anchorY)*fy
      const edgeR=route.side>0?maxR+pad:minR-pad
      const entry=route.direction>0?minL-pad:maxL+pad
      const exit=route.direction>0?maxL+pad:minL-pad
      if(route.side*(selfR-edgeR)>-0.2) route.passing=true
      if(route.direction*(selfL-exit)>0) s.bypass=null
      else {
        const along=route.passing?exit:entry
        const x=obstacle.anchorX+fy*edgeR+fx*along,y=obstacle.anchorY-fx*edgeR+fy*along
        heading=Math.atan2(y-s.y,x-s.x)
      }
    }
  }
  if(!friends.length) return heading
  if(!s.avoidSide) {
    const flank=(s.x-target.x)*Math.sin(reg.facing)-(s.y-target.y)*Math.cos(reg.facing)
    s.avoidSide=flank!==0?-Math.sign(flank):(s.id%2?1:-1)
  }
  let best=heading,cost=Infinity
  for(const degrees of [0,25,-25,50,-50,75,-75,90,-90,100,-100]) {
    const angle=heading+degrees*DEG,dx=Math.cos(angle),dy=Math.sin(angle)
    let score=(1-Math.cos(degrees*DEG))*1.2+(degrees===0||Math.sign(degrees)===s.avoidSide?0:0.3)
    for(const other of friends) {
      const x=other.s.x-s.x,y=other.s.y-s.y
      const ahead=x*dx+y*dy,side=Math.abs(x*dy-y*dx)
      const width=def.radius+other.def.radius+0.12
      if(ahead>0&&ahead<reach&&side<width) score+=4*(1-side/width)*(1-ahead/(reach*1.5))
    }
    if(score<cost) {cost=score;best=angle}
  }
  return best
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

  if (still && (distance < 0.08 || (s.idle && distance < 0.16))) {
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
  if(reg.order==='move'&&!reg.routing&&def.physicalSize<=1&&distance>.25) heading=friendlyHeading(reg,def,s,heading,distance,press)
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
  if(def.type==='chariot') {
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
  s.speed = approach(s.speed, target, accelRate(def, target > s.speed), dt)
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
  s.speed=approach(s.speed,desired,accelRate(def,desired>s.speed),dt)
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
): Live | null {
  const self = live[index]
  grid.query(self.s.x, self.s.y, radius + 2, buf,self.reg.side===0?1:0)
  let best: Live | null = null
  let bestD = radius
  for (const otherIndex of buf) {
    const other = live[otherIndex]
    if (other.reg.side === self.reg.side || !other.s.alive || other.s.down > 0) continue
    if (targetId!==null && other.reg.id!==targetId) continue
    if(self.def.shape==='circle'&&other.def.shape==='circle') {
      const dx=other.s.x-self.s.x,dy=other.s.y-self.s.y,limit=bestD+self.def.radius+other.def.radius+1e-9
      if(limit<0||dx*dx+dy*dy>limit*limit) continue
    }
    if (passive && self.s.reactTo !== other.s.id && Math.abs(angDiff(self.reg.facing, Math.atan2(other.s.y - self.s.y, other.s.x - self.s.x))) > 70 * DEG) continue
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

function chargeContact(battle: Battle, item: Live, target: Live): void {
  if (!item.s.chargeArmed) return
  const defended=chargeDefended(target.reg,target.def,target.s,item.def,item.s.x,item.s.y)
  item.s.chargeLeft=defended ? 0 : CHARGE_DURATION
  item.s.chargeContactAt=battle.time
  item.s.chargeArmed=false
}

function resolveMelee(battle: Battle, live: Live[], grid: Spatial, buf: number[], dt: number): void {
  const due: { item: Live; swing: NonNullable<Soldier['swing']> }[] = []
  for (const item of live) {
    const {s,reg,def}=item
    if (!s.alive || reg.routing || s.down>0) { s.swing=null; continue }
    s.meleeCd=Math.max(0,s.meleeCd-dt)
    const needsTarget=s.chargeArmed||(!s.swing&&s.meleeCd<=0&&reg.order!=='move')
    grid.query(s.x,s.y,def.reach+3,buf,reg.side===0?1:0)
    let target: Live | null=null, nearest=Infinity
    for (const index of buf) {
      const other=live[index]
      if (other.reg.side===reg.side || !other.s.alive || other.s.down>0) continue
      if(def.shape==='circle'&&other.def.shape==='circle') {
        const dx=other.s.x-s.x,dy=other.s.y-s.y,limit=def.reach+def.radius+other.def.radius+1e-9
        if(dx*dx+dy*dy>limit*limit) continue
      }
      const gap=gapBetween(s,def,other.s,other.def)
      if (gap>def.reach) continue
      reg.inContact=true; other.reg.inContact=true
      if(reg.order==='attack' && reg.targetId===other.reg.id) reg.attackCommitted=true
      if(other.reg.order==='attack' && other.reg.targetId===reg.id) other.reg.attackCommitted=true
      const arc=facingArc(reg.facing,s.x,s.y,other.s.x,other.s.y)
      if (arc==='rear') reg.touchRear=true
      else if (arc==='flank') reg.touchFlank=true
      if (reg.retargeting && other.reg.id!==reg.targetId) continue
      if (!needsTarget || !inAttackZone(item,other,s.facing,gap) || runningDown(item,other) || meleeScreened(item,other,live,grid)) continue
      if (gap<nearest) { nearest=gap; target=other }
    }
    if (target) chargeContact(battle,item,target)
    if (s.swing) {
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
    grid.query(item.s.x,item.s.y,item.def.reach+4,buf,item.reg.side===0?1:0)
    const candidates=buf.map(i=>live[i]).filter(other=>other.reg.side!==item.reg.side && (!item.reg.retargeting || other.reg.id===item.reg.targetId) && inAttackZone(item,other,swing.facing) && !meleeScreened(item,other,live,grid))
    const primary=candidates.find(other=>other.s.id===swing.targetId)
    let victims: Live[]
    if (item.def.splash===1 || (primary && primary.def.physicalSize>item.def.attack.splashMaxSize)) victims=primary ? [primary] : []
    else {
      victims=candidates.filter(other=>other.def.physicalSize<=item.def.attack.splashMaxSize)
      victims.sort((a,b)=>gapBetween(item.s,item.def,a.s,a.def)-gapBetween(item.s,item.def,b.s,b.def) || a.s.id-b.s.id)
      victims=victims.slice(0,item.def.splash)
    }
    for (const target of victims) landMelee(battle,item,target,victims.length)
  }
}

/** Independent contact attacks: their timer and target limit never consume the
 * kinetic-impact latch or the animated weapon's cooldown, and do not require ram speed. */
function resolveCollisionAttacks(battle: Battle, live: Live[], grid: Spatial, buf: number[]): void {
  for (const item of live) {
    const attack=item.def.collisionAttack
    if (!attack || !item.s.alive || item.s.down>0 || item.reg.routing || item.reg.order!=='attack' || item.s.collisionCd>0) continue
    grid.query(item.s.x,item.s.y,item.def.length/2+2,buf,item.reg.side===0?1:0)
    const targets=buf.map(i=>live[i]).filter(other=>other.reg.side!==item.reg.side && other.s.alive && other.s.down<=0 && gapBetween(item.s,item.def,other.s,other.def)<=0.15)
    targets.sort((a,b)=>gapBetween(item.s,item.def,a.s,a.def)-gapBetween(item.s,item.def,b.s,b.def) || a.s.id-b.s.id)
    if (!targets.length) continue
    item.s.collisionCd=attack.interval
    for (const target of targets.slice(0,attack.targets)) {
      item.reg.inContact=true; target.reg.inContact=true
      chargeContact(battle,item,target)
      landMelee(battle,item,target,1/Math.max(0.01,attack.damage))
    }
  }
}

/** A nearer enemy body screens a hero behind it. Friendly spear ranks may
 * support one another; this test only blocks attacks through the defending side. */
function meleeScreened(attacker: Live, target: Live, live: Live[], grid: Spatial): boolean {
  const distance = Math.hypot(target.s.x - attacker.s.x, target.s.y - attacker.s.y)
  const candidates: number[] = []
  grid.query((attacker.s.x + target.s.x) / 2, (attacker.s.y + target.s.y) / 2, distance / 2 + 2, candidates,target.reg.side)
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
 * anti-large spearman standing braced for the charge. Only what drives into him at ramming speed counts;
 * a rider going past at his side can be cut.
 */
function runningDown(item: Live, other: Live): boolean {
  if (item.def.large || !other.def.large) return false
  const dx = item.s.x - other.s.x
  const dy = item.s.y - other.s.y
  const apart = Math.hypot(dx, dy) || 1
  const closing = ((other.s.vx - item.s.vx) * dx + (other.s.vy - item.s.vy) * dy) / apart
  if (closing <= 5) return false
  return !chargeDefended(item.reg,item.def,item.s,other.def,other.s.x,other.s.y)
}

/** A stopped model keeps the unexpired part of a successful charge. */
function landMelee(battle: Battle, item: Live, target: Live, share = 1): void {
  const mods = fatigueMods(item.reg.fatigue)
  const dx = target.s.x - item.s.x
  const dy = target.s.y - item.s.y
  const negated = chargeDefended(target.reg,target.def,target.s,item.def,item.s.x,item.s.y)
  const charge = negated ? 0 : item.def.chargeBonus * mods.charge * chargeDecay(item.s.chargeLeft)
  let attack = item.def.meleeAttack * mods.attack + charge
  if (target.def.large) attack += item.def.antiLargeMa
  else attack += item.def.antiInfantryMa
  let defense = target.def.meleeDefense * fatigueMods(target.reg.fatigue).defense
  const arc = facingArc(target.reg.facing, target.s.x, target.s.y, item.s.x, item.s.y)
  defense *= defenseMultiplier(angDiff(target.s.facing, Math.atan2(-dy, -dx)))
  if (target.s.disengage > 0) defense -= 12
  if (target.reg.bogged) defense -= 8
  defense = Math.max(0, defense)
  target.s.reactTo = item.s.id
  target.s.reactTime = Math.max(4, item.def.meleeInterval + 0.5)
  if (battle.rng() * 100 > hitChance(attack, defense)) return
  target.reg.meleeReact = true
  if (arc === 'rear') target.reg.rearFoe = item.reg.id
  const reflection = item.def.chargeReflection && isBracing(item.reg,item.def,target.s.x,target.s.y,item.s)
    && target.s.chargeContactAt>=0 && battle.time-target.s.chargeContactAt<=MECHANICS.chargeReflectWindow ? MECHANICS.chargeReflectDamage : 1
  const wound = woundMods(item.def,item.s).damage
  const height = elevationDamage(elevationAt(battle,item.s.x,item.s.y)-elevationAt(battle,target.s.x,target.s.y),false)
  const multiplier = wound*reflection*height/share
  const fromCharge = splitBonus(item.def.weaponBase, item.def.weaponAp, charge)
  const antiWs = target.def.large ? item.def.antiLargeWs : item.def.antiInfantryWs
  const fromAnti = splitBonus(item.def.weaponBase, item.def.weaponAp, antiWs)
  hurt(
    battle,
    target,
    item.reg,
    (item.def.weaponBase + fromCharge.base + fromAnti.base) * multiplier,
    (item.def.weaponAp + fromCharge.ap + fromAnti.ap) * mods.ap * multiplier,
    false,
  )
}

function resolveShooting(battle: Battle, live: Live[], grid: Spatial, pad: Scratch, dt: number): void {
  const buf=pad.buf
  for (const reg of battle.regiments) {
    const def=unitDef(reg.type), missile=def.missile
    if (!missile || reg.routing || reg.aliveCount<=0) continue
    const target=shootingTarget(battle,reg,missile.range)
    for (const soldier of reg.soldiers) {
      if (!soldier.alive || soldier.down>0) continue
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
      spawnArrow(battle,reg,soldier,prey,def)
      soldier.ammo--; soldier.reload=missile.reload*fatigueMods(reg.fatigue).reload; reg.shot=true
    }
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
    z: elevationAt(battle,originX,originY)+def.bodyHeight*0.75,
    vz: 0, gravity: 0, sourceGround: elevationAt(battle,shooter.x,shooter.y),
    penetrationLeft: missile.penetration, hitIds: [],
  }
  const targetDef=unitDef(regimentById(battle,target.regId)!.type)
  const targetZ=elevationAt(battle,landX,landY)+targetDef.bodyHeight*0.55
  projectile.gravity=missile.arc ? 8*projectile.apex/(projectile.duration*projectile.duration) : 9.81
  projectile.vz=(targetZ-projectile.z+0.5*projectile.gravity*projectile.duration*projectile.duration)/projectile.duration
  battle.projectiles.push(projectile)
}

/** Withhold blocked shots without spending ammo. Nearby friends are inside the
 * muzzle safety zone; friends entering the terminal flight can still be hit. */
function clearShot(battle: Battle, live: Live[], grid: Spatial, buf: number[], reg: Regiment, shooter: Soldier, target: Soldier): boolean {
  const distance = Math.hypot(target.x - shooter.x, target.y - shooter.y)
  const z0=elevationAt(battle,shooter.x,shooter.y)+unitDef(reg.type).bodyHeight*0.75
  const targetDef=unitDef(regimentById(battle,target.regId)!.type)
  const z1=elevationAt(battle,target.x,target.y)+targetDef.bodyHeight*0.55
  for (let d=2;d<distance;d+=2) {
    const t=d/distance, x=shooter.x+(target.x-shooter.x)*t, y=shooter.y+(target.y-shooter.y)*t
    if (elevationAt(battle,x,y)>z0+(z1-z0)*t) return false
  }
  const safe = Math.min(MECHANICS.muzzleSafeDistance, distance * MECHANICS.muzzleSafeFraction)
  grid.query((shooter.x + target.x) / 2, (shooter.y + target.y) / 2, distance / 2 + 2, buf,reg.side)
  for (const index of buf) {
    const item = live[index]
    if (!item.s.alive || item.s.down > 0 || item.reg.side !== reg.side || item.reg.id === reg.id) continue
    for (const p of shapePoints(item.s, item.def)) {
      const t = sweptCylinderT(shooter.x,shooter.y,target.x,target.y,z0,z1-z0,0,1,p.x,p.y,item.def.radius+0.15,elevationAt(battle,p.x,p.y),item.def.bodyHeight)
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
    grid.query((x0+x1)/2,(y0+y1)/2,stepDistance/2+3,buf)
    const hits: {item:Live;t:number}[]=[]
    for (const index of buf) {
      const item=live[index]
      if (!item.s.alive || item.s.id===p.shooterId || item.reg.id===p.sourceReg || p.hitIds.includes(item.s.id)) continue
      let first:number|null=null
      for (const point of shapePoints(item.s,item.def)) {
        const t=sweptCylinderT(x0,y0,x1,y1,z0,vz0,p.gravity,dt,point.x,point.y,item.def.radius+0.05,elevationAt(battle,point.x,point.y),item.s.down>0?0.3:item.def.bodyHeight)
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
        const height=elevationDamage(p.sourceGround-elevationAt(battle,item.s.x,item.s.y),true)
        hurt(battle,item,regimentById(battle,p.sourceReg)??null,p.base*height,p.ap*height,false,'missile')
      }
      p.penetrationLeft-=item.def.penetrationResistance
      if (blocked || p.penetrationLeft<=0) { p.alive=false; break }
      const retained=unitDef(regimentById(battle,p.sourceReg)!.type).missile?.penetrationDamage ?? 0.7
      p.base*=retained; p.ap*=retained
    }
    if (!p.alive) continue
    p.x=x1; p.y=y1; p.z=z0+vz0*dt-0.5*p.gravity*dt*dt; p.vz=vz0-p.gravity*dt
    p.age+=dt; p.traveled+=stepDistance
    if (p.z<=elevationAt(battle,p.x,p.y) || p.traveled>p.maxRange+6 || p.x< -8 || p.y< -8 || p.x>MAP_WIDTH+8 || p.y>MAP_HEIGHT+8) p.alive=false
  }
  battle.projectiles=battle.projectiles.filter(p=>p.alive)
}

/** Share of a charger's speed each braced man he strikes takes off him. */
const BRACE_BLEED = 0.08

/**
 * A braced front blunts a charge but does not stop it flat: the men are still bowled over, but each one struck
 * costs the charger some of his speed. Once past the front rank he meets no brace.
 */
function braceAgainst(item: Live): void {
  item.s.vx *= 1 - BRACE_BLEED
  item.s.vy *= 1 - BRACE_BLEED
  item.s.speed *= 1 - BRACE_BLEED
}

function resolveImpact(battle: Battle, live: Live[], grid: Spatial, buf: number[]): void {
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    if (item.def.impactPower <= 0 || !item.s.alive || item.reg.bogged) continue
    const speed = Math.hypot(item.s.vx, item.s.vy)
    if (speed < 5) {
      item.s.cleave = 0
      item.s.latched = []
      continue
    }
    item.s.latched = item.s.latched.filter((id) => {
      const other = battle.soldierById.get(id)
      return !!other && other.alive && Math.hypot(other.x - item.s.x, other.y - item.s.y) < 2
    })
    grid.query(item.s.x, item.s.y, item.def.reach + 3, buf)
    const hits: { item: Live; gap: number }[] = []
    for (const otherIndex of buf) {
      const other = live[otherIndex]
      if (other.reg.side === item.reg.side || !other.s.alive) continue
      if (item.def.physicalSize <= other.def.physicalSize) continue
      if (item.s.latched.includes(other.s.id)) continue
      const gap = gapBetween(item.s, item.def, other.s, other.def)
      if (gap > 0.35) continue
      hits.push({ item: other, gap })
    }
    hits.sort((a, b) => a.gap - b.gap)
    const chargeVx = item.s.vx
    const chargeVy = item.s.vy
    for (const hit of hits) {
      const dx = hit.item.s.x - item.s.x
      const dy = hit.item.s.y - item.s.y
      const distance = Math.hypot(dx, dy) || 1
      const nx = dx / distance
      const ny = dy / distance
      const closing = (item.s.vx - hit.item.s.vx) * nx + (item.s.vy - hit.item.s.vy) * ny
      if (closing <= 5 || hit.item.s.down > 0) continue
      const braced = isBracing(hit.item.reg, hit.item.def, item.s.x, item.s.y, hit.item.s)
      const arc = facingArc(hit.item.reg.facing, hit.item.s.x, hit.item.s.y, item.s.x, item.s.y)
      const foot = !hit.item.def.large
      const sprawl = hit.item.def.physicalSize <= 1 || (item.def.physicalSize >= 4 && hit.item.def.physicalSize <= 2)
      if (braced) braceAgainst(item)
      if (item.def.type === 'chariot' && foot) {
        item.s.plowLeft=PLOW_TIME
        const speed=Math.hypot(chargeVx,chargeVy)||1
        const fx=chargeVx/speed, fy=chargeVy/speed
        let far=0
        for (const foe of hit.item.reg.soldiers) {
          if (foe.alive) far=Math.max(far,(foe.x-item.s.x)*fx+(foe.y-item.s.y)*fy)
        }
        const overrun=far+PLOW_OVERRUN
        item.s.plowX=clamp(item.s.x+fx*overrun,3,MAP_WIDTH-3)
        item.s.plowY=clamp(item.s.y+fy*overrun,3,MAP_HEIGHT-3)
        item.reg.plow=Math.max(item.reg.plow,PLOW_TIME)
      }
      else if (isCavalry(item.def.type) && (!item.reg.retargeting || hit.item.reg.id===item.reg.targetId)) item.reg.contactLock = MECHANICS.cavalryContactHold
      if (hit.item.s.down > 0) continue
      const room = item.s.cleave < item.def.cleave
      if (room) {
        const raw = impactRaw(item.def.impactPower, closing, item.def.mass, collisionMass(hit.item,item.s.x,item.s.y))
        hurt(battle, hit.item, item.reg, raw * 0.3, raw * 0.7, true)
        item.s.latched.push(hit.item.s.id)
        item.s.cleave += 1
        hit.item.s.reactTo = item.s.id
        hit.item.s.reactTime = 4
      }
      if (sprawl) knockDown(hit.item.s, nx, ny, closing, item.def.mass, chargeVx, chargeVy)
      if (!room && !sprawl) continue
      item.reg.inContact = true
      hit.item.reg.inContact = true
      if (arc === 'rear') hit.item.reg.touchRear = true
      else if (arc === 'flank') hit.item.reg.touchFlank = true
      if (braced) continue
      const defendMass = hit.item.s.down > 0 ? hit.item.def.mass * 0.3 : hit.item.def.mass
      const slow = closing * (defendMass / (item.def.mass + defendMass)) * 0.35
      item.s.vx -= nx * slow
      item.s.vy -= ny * slow
    }
  }
}

function separate(live: Live[], pad: Scratch,dt:number): void {
  const buf = pad.buf
  const contactScratch={gap:0,nx:0,ny:0}
  const shellRecovery=1-Math.exp(-MECHANICS.contactStiffness*dt/4)
  let largestRadius=0,largestAxisShift=0
  for(const item of live) {
    largestRadius=Math.max(largestRadius,collisionRadius(item.def,true))
    if(item.def.shape==='capsule') largestAxisShift=Math.max(largestAxisShift,(item.def.length/2-item.def.radius)*(1-MECHANICS.collisionRadiusScale))
  }
  const traction=new Set<Soldier>()
  const tractionKicks:{foot:Soldier;x:number;y:number}[]=[]
  let tractionGridReady=false
  for(const cart of live) {
    if(cart.def.type!=='chariot'||cart.reg.routing||cart.s.down>0||cart.s.speed<0.02||cart.s.speed>=5||cart.s.plowLeft>0) continue
    if(!tractionGridReady) {fillGrid(pad,live,false);tractionGridReady=true}
    let resistance=0
    const contacts:{item:Live;nx:number;ny:number}[]=[]
    pad.spatial.query(cart.s.x,cart.s.y,cart.def.length/2+2,buf)
    for(const index of buf) {
      const other=live[index]
      if(!other.s.alive||other.s.down>0||other.def.physicalSize>1||other.s.id===cart.s.id) continue
      const friendly=other.reg.side===cart.reg.side
      // Cart traction uses its calibrated rolling collider and force budget.
      const contact=bodyContact(cart.s,cart.def,other.s,other.def)
      if(contact.gap>0.3||contact.nx*Math.cos(cart.s.facing)+contact.ny*Math.sin(cart.s.facing)<0.1) continue
      const grip=friendly?0.4:isBracing(other.reg,other.def,cart.s.x,cart.s.y,other.s)?MECHANICS.braceGroundGrip:1
      const forwardLoad=contact.nx*Math.cos(cart.s.facing)+contact.ny*Math.sin(cart.s.facing)
      // Side contacts need to clear the lane, but do not present their entire
      // ground resistance along the vehicle's forward axis.
      resistance+=(friendly?other.def.mass:collisionMass(other,cart.s.x,cart.s.y))*MECHANICS.groundFriction*grip*Math.max(0.2,forwardLoad)
      contacts.push({item:other,nx:contact.nx,ny:contact.ny})
    }
    const force=cart.def.mass*accelRate(cart.def,true)
    if(resistance>0&&resistance<force) {
      traction.add(cart.s)
      // Traction must exert a sustained force, not merely permit overlap repair.
      // Deflect the contact bodies to either side of the vehicle's lane; ground
      // friction then arrests the displaced feet as soon as contact ends.
      const sideX=-Math.sin(cart.s.facing),sideY=Math.cos(cart.s.facing)
      for(const hit of contacts) {
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
    for (let i = 0; i < live.length; i++) {
      const a = live[i]
      if (!a.s.alive) continue
      // Query for full-size hostile bodies as well as slim friendly bodies.
      // Capsules insert all three visual circle centres into the shared grid.
      const extent=collisionExtent(a.def,true)
      // The shared combat grid inserts visual capsule points; include the
      // largest radius generously enough to cover the shorter physical axis.
      grid.query(a.s.x, a.s.y, extent+largestRadius+MECHANICS.contactPadding+largestAxisShift, buf)
      for (const j of buf) {
        if (j <= i) continue
        const b = live[j]
        if (!b.s.alive) continue
        const enemy = a.reg.side !== b.reg.side
        // Ordinary enemies do not grant the same pass-through room as allies.
        // Carts retain the calibrated collider used by their explicit traction
        // and ploughing rules; their force budget decides whether a lane opens.
        const solidEnemy=enemy&&a.def.type!=='chariot'&&b.def.type!=='chariot'
        const bound=collisionExtent(a.def,solidEnemy)+collisionExtent(b.def,solidEnemy)+MECHANICS.contactPadding
        const dx=b.s.x-a.s.x,dy=b.s.y-a.s.y
        if(dx*dx+dy*dy>=bound*bound) continue
        const contact=bodyContact(a.s,a.def,b.s,b.def,contactScratch,solidEnemy)
        const gap = contact.gap
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
        const plowA = enemy && a.def.type === 'chariot' && a.s.plowLeft > 0
        const plowB = enemy && b.def.type === 'chariot' && b.s.plowLeft > 0
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
        soldier.bypass = soldier.cartPath = null
        reg.aliveCount = Math.max(0, reg.aliveCount - 1)
        continue
      }
      soldier.x = clamp(soldier.x, 0.8, MAP_WIDTH - 0.8)
      soldier.y = clamp(soldier.y, 0.8, MAP_HEIGHT - 0.8)
    }
    if(leaving) {
      reg.anchorSpeed=reg.bodySpeed=reg.frameVx=reg.frameVy=reg.turnRate=0
      reg.engaged=reg.inContact=reg.wantCharge=reg.retargeting=reg.attackCommitted=false
      reg.contactLock=0;reg.order='hold';reg.targetId=null
    }
  }
}

function linePressed(reg: Regiment, def: UnitDef, live: Live[], pad: Scratch): boolean {
  const front = reg.soldiers.filter((soldier) => soldier.alive && soldier.rank === 0 && soldier.centerIndex < 0)
  if (front.length === 0) return false
  const pressedGap = reg.engaged ? def.reach : 0.35
  let pressed = 0
  for (const soldier of front) {
    const index = pad.indexOf.get(soldier.id)
    if (index === undefined) continue
    if (nearestEnemy(live, pad.spatial, pad.buf, index, pressedGap + 1e-6,false,reg.retargeting?reg.targetId:null)) pressed += 1
  }
  const needed = reg.engaged ? Math.max(1, Math.ceil(front.length * 0.2)) : Math.max(1, Math.ceil(front.length * 0.45))
  return pressed >= needed
}

function finishChargeFatigueBog(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  fillGrid(pad, live)
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    if (def.type==='chariot') reg.plow=Math.max(0,...reg.soldiers.filter(s=>s.alive).map(s=>s.plowLeft))
    const target=reg.order==='attack' && reg.targetId!==null?regimentById(battle,reg.targetId):null
    for(const s of reg.soldiers) {
      if(!s.alive||s.down>0||reg.routing||!target||!reg.attackCommitted) {s.blockedTime=0;continue}
      const index=pad.indexOf.get(s.id)
      const foe=index===undefined?null:nearestEnemy(live,pad.spatial,pad.buf,index,def.reach+0.1,false,target.id)
      if(foe) {s.blockedTime=0;continue}
      const dx=target.anchorX-s.x,dy=target.anchorY-s.y,d=Math.hypot(dx,dy)||1
      const progress=((s.x-s.prevX)*dx+(s.y-s.prevY)*dy)/d
      s.blockedTime=progress<0.3*dt?Math.min(2,s.blockedTime+dt):Math.max(0,s.blockedTime-dt*0.25)
    }
    if (reg.retargeting) {
      const oldContact=reg.soldiers.some(s=> {
        if (!s.alive) return false
        pad.spatial.query(s.x,s.y,def.reach+3,pad.buf)
        return pad.buf.some(i=> {
          const other=live[i]
          return other.reg.side!==reg.side && other.reg.id!==reg.targetId && other.s.alive && other.s.down<=0 && gapBetween(s,def,other.s,other.def)<=def.reach+0.5
        })
      })
      if (!oldContact) reg.retargeting=false
    }
    const charging = reg.wantCharge
    if (reg.inContact && reg.plow <= 0) reg.wantCharge = false
    if (def.missile || reg.order === 'move' || reg.routing) reg.engaged = false
    else if (reg.order === 'attack' || reg.order === 'hold') reg.engaged = reg.contactLock > 0 || linePressed(reg, def, live, pad)

    if (def.type === 'chariot') {
      const slow = reg.anchorSpeed < 3.5 || reg.braceSlow > 0 || reg.bogged
      if (reg.inContact && slow && reg.plow <= 0) reg.bogTime += dt
      else if (!reg.inContact) reg.bogTime = Math.max(0, reg.bogTime - dt)
      if (reg.bogTime >= 2) reg.bogged = true
      if (reg.bogged && !reg.inContact && (reg.anchorSpeed > 8 || reg.order === 'move')) {
        reg.bogged = false
        reg.bogTime = 0
      }
    }

    const moving=reg.bodySpeed>0.3
    const rates=MECHANICS.fatigueRates
    const rate=reg.inContact?rates.melee:reg.shot?rates.shooting:charging?rates.charge:moving?(reg.run?rates.run:rates.walk):rates.rest
    reg.exertion=clamp(reg.exertion+rate*dt*(rate>0?slopeFatigue(battle,reg.facing):1),0,FATIGUE.exhausted.threshold)
    reg.fatigue=fatigueAt(reg.exertion)
    reg.restTime=rate<0?reg.restTime+dt:0
  }
}

function updateMorale(battle: Battle, dt: number): void {
  const pressure=armyPressure(battle)
  const deadCommanders=[0,1].map(side=>battle.regiments.some(r=>r.side===side && unitDef(r.type).commander && r.aliveCount<=0 && r.soldiers.some(s=>!s.escaped)))
  for (const reg of battle.regiments) {
    if (reg.aliveCount<=0) continue
    const def=unitDef(reg.type)
    prune(reg.dealt,battle.time,10); prune(reg.taken,battle.time,10)
    let friends=0, encourage=0, fear=false
    for (const other of battle.regiments) {
      if (other.id===reg.id || other.aliveCount<=0) continue
      const distance=Math.hypot(other.anchorX-reg.anchorX,other.anchorY-reg.anchorY)
      const od=unitDef(other.type)
      if (other.side===reg.side) {
        if (other.routing && distance<=40) friends++
        if (!other.routing && distance<=MECHANICS.encourageRadius) encourage=Math.max(encourage,od.encourage)
      } else if (!other.routing && distance<=MECHANICS.fearRadius && !def.immunePsychology && !def.causesTerror) {
        if (od.causesFear && !def.causesFear) fear=true
      }
    }
    const dealt=reg.dealt.reduce((sum,e)=>sum+e.v,0), taken=reg.taken.reduce((sum,e)=>sum+e.v,0)
    // Escaping removes field strength, but is not damage to the soldiers left behind.
    const remainingInitial=reg.initial-reg.soldiers.filter(s=>s.escaped).length
    reg.moraleFactors=leadershipFactors({
      base:def.leadership, initial:reg.initial, alive:reg.aliveCount,
      healthFraction:reg.soldiers.reduce((sum,s)=>sum+(s.alive?s.hp:0),0)/(Math.max(1,remainingInitial)*reg.modelHp),
      recentLossFraction:taken/(reg.initial*reg.modelHp), flank:reg.touchFlank, rear:reg.touchRear,
      recentDamage:reg.taken.some(e=>battle.time-e.t<=8), winning:dealt>taken && dealt>0,
      routingFriends:friends, encourage, commanderDead:deadCommanders[reg.side],
      armyLosses:pressure[reg.side], fear, fatigue:fatigueMods(reg.fatigue).leadership,
    })
    reg.leadership=Object.values(reg.moraleFactors).reduce((sum,v)=>sum+v,0)
    // Only this step's actual damage can request terror. Ordinary morale breaks
    // take precedence and never spend a source's terror cooldown.
    const breaking=reg.leadership<=MECHANICS.shatterLeadership || (reg.leadership<0 && reg.negativeTime+dt>=MECHANICS.routDelay)
    const vulnerable=!reg.routing && !def.unbreakable && !def.immunePsychology && !def.causesTerror && !breaking && reg.leadership<MECHANICS.terrorLeadership
    const terrorSource=vulnerable ? reg.terrorHits.map(id=>regimentById(battle,id)).find(source=>
      source && source.side!==reg.side && unitDef(source.type).causesTerror && source.terrorCooldown<=0) : undefined
    const transition=advanceMorale(reg,reg.leadership,enemyWithin(battle,reg,MECHANICS.rallyEnemyDistance),!!terrorSource,dt)
    if (transition==='routed' || transition==='shattered') {
      if (terrorSource) terrorSource.terrorCooldown=MECHANICS.terrorCooldown
      pushNotice(battle,terrorSource?`${reg.name}被${terrorSource.name}惊骇${reg.shattered?'，彻底溃散':''}`:`${reg.name}${transition==='shattered'?'彻底溃散':'溃逃'}`)
      reg.order='hold'; reg.targetId=null; reg.wantCharge=false; reg.engaged=false; reg.retargeting=false; reg.attackCommitted=false
      reg.destX=reg.anchorX; reg.destY=reg.anchorY; reg.facingLocked=true
      for (const s of reg.soldiers) { s.swing=null; s.chargeArmed=false; s.plowLeft=0; s.bypass=null; s.cartPath=null }
    } else if (transition==='rallied') {
      const center=aliveCenter(reg)
      if (!center) continue
      reg.destX=reg.anchorX; reg.destY=reg.anchorY; reg.order='hold'; reg.facingLocked=true; reg.targetId=null
      const enemy=nearestEnemyRegiment(battle,reg)
      reg.destFacing=enemy?Math.atan2(enemy.anchorY-center.y,enemy.anchorX-center.x):reg.facing
      // Assign new places around the scattered survivors, without moving bodies.
      reformAt(reg,reg.files,reg.destFacing)
      reg.destX=reg.anchorX;reg.destY=reg.anchorY
      pushNotice(battle,`${reg.name}重整`)
    }
  }
}

function checkVictory(battle: Battle): void {
  const south = battle.regiments.some((reg) => reg.side === 0 && reg.aliveCount > 0 && !reg.routing)
  const north = battle.regiments.some((reg) => reg.side === 1 && reg.aliveCount > 0 && !reg.routing)
  if (south && north) return
  battle.winner = !south && !north ? -1 : south ? 0 : 1
  const text = battle.winner === 0 ? '南军胜利' : battle.winner === 1 ? '北军胜利' : '两军同溃'
  pushNotice(battle, text)
}

function collisionMass(item: Live, otherX: number, otherY: number): number {
  if (item.s.down > 0) return item.def.mass * 0.3
  if (isBracing(item.reg, item.def, otherX, otherY, item.s)) return item.def.mass * bracingMassMultiplier(item.reg)
  return item.def.mass
}

/** How long a chariot keeps its charge after it last ran over men who were not braced. */
const PLOW_TIME = 1.8

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

function hurt(battle: Battle, target: Live, source: Regiment | null, base: number, ap: number, impact: boolean, kind: 'melee' | 'missile' | 'impact' = impact ? 'impact' : 'melee', traits: DamageTraits = {}): void {
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
  target.reg.taken.push({ t: now, v: actual })
  if (source && source.side !== target.reg.side) {
    source.dealt.push({ t: now, v: actual })
    if (unitDef(source.type).causesTerror && !target.reg.terrorHits.includes(source.id)) target.reg.terrorHits.push(source.id)
  }
  if (impact && damage >= 8) {
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
