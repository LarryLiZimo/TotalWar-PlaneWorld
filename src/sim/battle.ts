import { planEnemyIntents } from './ai'
import {
  accuracyAt,
  armorRoll,
  chargeShare,
  effectiveLeadership,
  fatigueMods,
  hitChance,
  KNOCK_TIME,
  impactRaw,
  mitigate,
  splitBonus,
} from './combat'
import {
  PLACE_RADIUS,
  compactRanks,
  fitOnMap,
  gapBetween,
  isBracing,
  reformAt,
  reformMoving,
  slotOf,
  travelFacing,
} from './formation'
import { DEG, angDiff, clamp, facingArc, forward, mulberry32, rayCircleT } from './math'
import { commandAttack, commandHold, commandMove, regimentById } from './orders'
import { shapePoints } from './formation'
import { Spatial } from './spatial'
import type { Battle, Projectile, Regiment, Side, Soldier, UnitDef, UnitType } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { isCavalry, isInfantry, unitDef } from './units'

const NORTH = Math.PI / 2
const SOUTH = -Math.PI / 2

interface Scratch {
  spatial: Spatial
  buf: number[]
  live: Live[]
  indexOf: Map<number, number>
}

const scratches = new WeakMap<Battle, Scratch>()

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
  const battle: Battle = {
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
  }
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
  return battle
}

export function setAiEnabled(battle: Battle, enabled: boolean): void {
  battle.aiEnabled = enabled
  if (enabled) return
  battle.pending = []
  battle.appliedSig.clear()
  for (const reg of battle.regiments) {
    if (reg.side !== 1 || reg.aliveCount <= 0 || reg.routing) continue
    commandHold(battle, [reg.id])
  }
}

function spawn(
  battle: Battle,
  side: Side,
  type: UnitType,
  name: string,
  x: number,
  y: number,
  facing: number,
): void {
  const def = unitDef(type)
  const reg: Regiment = {
    id: battle.nextId++,
    side,
    type,
    name,
    soldiers: [],
    anchorX: x,
    anchorY: y,
    facing,
    files: def.files,
    order: 'hold',
    destX: x,
    destY: y,
    destFacing: facing,
    destFiles: def.files,
    facingLocked: true,
    targetId: null,
    exertion: 0,
    fatigue: 'fresh',
    restTime: 0,
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
    aliveCount: def.models,
    initial: def.models,
    leadership: def.leadership,
    dealt: [],
    taken: [],
    inContact: false,
    touchFlank: false,
    touchRear: false,
    shot: false,
    engaged: false,
    nearEnemy: false,
    meleeReact: false,
    rearFoe: null,
  }
  for (let i = 0; i < def.models; i++) {
    const file = i % def.files
    const rank = Math.floor(i / def.files)
    const soldier: Soldier = {
      id: battle.nextId++,
      regId: reg.id,
      hp: def.hp,
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
    }
    reg.soldiers.push(soldier)
    battle.soldierById.set(soldier.id, soldier)
  }
  for (const soldier of reg.soldiers) {
    const slot = slotOf(reg, def, soldier.file, soldier.rank, soldier.centerIndex)
    soldier.x = slot.x
    soldier.y = slot.y
  }
  battle.regiments.push(reg)
}

export function step(battle: Battle, dt: number): void {
  if (battle.winner !== null) return
  battle.time += dt
  ageTransient(battle, dt)
  applyAi(battle, dt)
  for (const reg of battle.regiments) {
    if (reg.order === 'attack') updateAttackDest(battle, reg)
    faceMelee(reg)
    armCharge(reg)
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
  resolveShooting(battle, live, grid, pad, dt)
  flyProjectiles(battle, live, grid, pad.buf, dt)
  resolveImpact(battle, live, grid, pad.buf)
  separate(live, pad)
  absorbBumps(live)
  clampBodies(battle)
  finishChargeFatigueBog(battle, live, pad, dt)
  updateMorale(battle, dt)
  for (const reg of battle.regiments) compactRanks(reg)
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
  if (reg.plow > 0) {
    const fwd = forward(reg.facing)
    const targetDef = unitDef(target.type)
    let far = -Infinity
    for (const foe of target.soldiers) {
      if (!foe.alive) continue
      const at = foe.down > 0 ? foe : slotOf(target, targetDef, foe.file, foe.rank, foe.centerIndex)
      far = Math.max(far, (at.x - reg.anchorX) * fwd.x + (at.y - reg.anchorY) * fwd.y)
    }
    const run = Math.max(far + PLOW_OVERRUN, 0.5)
    reg.destX = clamp(reg.anchorX + fwd.x * run, 3, MAP_WIDTH - 3)
    reg.destY = clamp(reg.anchorY + fwd.y * run, 3, MAP_HEIGHT - 3)
    reg.destFacing = reg.facing
    reg.facingLocked = true
    return
  }
  if (!def.missile) {
    reg.destFacing = Math.atan2(dy, dx)
    reg.facingLocked = true
  }
  if (!def.missile && reg.engaged) {
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
    if (distance < 22 && def.type !== 'musket') {
      reg.destX = clamp(target.anchorX - (dx / distance) * 30, 3, MAP_WIDTH - 3)
      reg.destY = clamp(target.anchorY - (dy / distance) * 30, 3, MAP_HEIGHT - 3)
    } else if (distance > desired) {
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

function armCharge(reg: Regiment): void {
  const def = unitDef(reg.type)
  if (reg.plow > 0) {
    reg.wantCharge = true
    return
  }
  if (reg.order !== 'attack' || reg.routing || def.missile || def.chargeSpeed <= def.speed + 0.05) {
    if (reg.order !== 'attack' || reg.routing) reg.wantCharge = false
    return
  }
  const dx = reg.destX - reg.anchorX
  const dy = reg.destY - reg.anchorY
  const distance = Math.hypot(dx, dy)
  const aligned = Math.abs(angDiff(reg.facing, reg.destFacing)) < 25 * DEG
  const inStep = reg.lag < 0.8 && reg.anchorSpeed > def.speed * 0.8
  if (distance > 18 && aligned && inStep) reg.wantCharge = true
}

function moveSpeedOf(reg: Regiment, soldier?: Soldier): number {
  const def = unitDef(reg.type)
  const mods = fatigueMods(reg.fatigue)
  let speed = (reg.wantCharge && !reg.routing ? def.chargeSpeed : def.speed) * mods.stat
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
      relaid = march(reg, def, fleeHeading(battle, reg), Infinity, dt, 0.5)
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
      reg.destFacing = reg.facing
      reg.stationaryTime = 0
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
        relaid = march(reg, def, Math.atan2(dy, dx), distance, dt, 0.2)
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
function march(reg: Regiment, def: UnitDef, heading: number, distance: number, dt: number, minCohesion: number): boolean {
  const footed = def.turnRadius === 0
  const aim = reg.routing ? heading : travelFacing(def, reg.destFacing, heading)
  const err = angDiff(reg.facing, aim)
  const closing = reg.order === 'attack' && !def.missile && distance < releaseRange(def) * 2
  if (!closing && !reg.routing && Math.abs(err) > REFORM_TURN) {
    if (footed) {
      reformMoving(reg, reg.files, aim)
    } else {
      reformAt(reg, reg.files, heading)
      reg.anchorSpeed = 0
    }
    return true
  }
  const wait = reg.plow > 0 ? 30 : reg.routing ? 6 : 4
  const keepUp = closing ? 1 : reg.trail > wait ? 0 : clamp(1 - (reg.trail - 1.5) / 3, minCohesion, 1)
  const settling = closing ? 1 : clamp(1.1 - reg.lag / 16, 0.75, 1)
  const top = moveSpeedOf(reg) * keepUp * settling
  const lever = halfWidth(reg)
  if (footed) {
    const maxOmega = Math.min(def.turnCap, ((catchUpOf(reg, def) - 1) * moveSpeedOf(reg)) / lever)
    const wantOmega = Math.abs(err) < 0.01 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
    reg.facing += approach(reg.turnRate, wantOmega, maxOmega * 2, dt) * dt
    reg.anchorSpeed = approach(reg.anchorSpeed, top, accelRate(def, top > reg.anchorSpeed), dt)
    const stepDist = Math.min(reg.anchorSpeed * dt, distance)
    reg.anchorX = clamp(reg.anchorX + Math.cos(heading) * stepDist, 3, MAP_WIDTH - 3)
    reg.anchorY = clamp(reg.anchorY + Math.sin(heading) * stepDist, 3, MAP_HEIGHT - 3)
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
  reg.anchorX = clamp(reg.anchorX + fwd.x * stepDist, 3, MAP_WIDTH - 3)
  reg.anchorY = clamp(reg.anchorY + fwd.y * stepDist, 3, MAP_HEIGHT - 3)
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

function fillGrid(pad: Scratch, live: Live[]): Spatial {
  const grid = pad.spatial
  grid.clear()
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    if (!item.s.alive) continue
    if (item.def.shape === 'capsule') {
      for (const point of shapePoints(item.s, item.def)) grid.insert(point.x, point.y, i)
    } else {
      grid.insert(item.s.x, item.s.y, i)
    }
  }
  return grid
}

function moveSoldiers(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  const grid = fillGrid(pad, live)
  const buf = pad.buf
  const lagSum = new Map<Regiment, SlotTally>()
  const speedSum = new Map<Regiment, number>()
  const press: Press = { live, grid, buf, near: new Map(), claims: new Map() }
  for (const reg of battle.regiments) {
    reg.nearEnemy = false
    lagSum.set(reg, { total: 0, trail: 0, count: 0 })
  }
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    const { s, reg, def } = item
    const foe = nearestEnemy(live, grid, buf, i, def.reach + 0.5)
    const gapToFoe = foe ? gapBetween(s, def, foe.s, foe.def) : Infinity
    if (foe && gapToFoe < 14) reg.nearEnemy = true
    const enemyNear = gapToFoe <= def.reach
    const touching = gapToFoe <= 0.15
    if (reg.order !== 'move' || reg.routing) {
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

    const gait = moveSpeedOf(reg, s)
    const lever = turnLever(def)
    const ox = s.x
    const oy = s.y
    const fighting = reg.engaged && reg.plow <= 0 && !def.missile && !reg.routing && s.down <= 0
    const frontRank = s.rank === 0 && s.centerIndex < 0
    const runningIn = reg.order === 'attack' && !def.missile && !reg.engaged
    const inFight = !!foe && reg.order !== 'move' && reg.plow <= 0 && !reg.routing && gapToFoe <= (runningIn ? 0.15 : def.reach)
    if (s.down > 0) {
      lieDown(s, dt)
    } else if (fighting && foe && frontRank) {
      closeIn(def, s, foe, gapToFoe, gait, lever, dt)
    } else if (inFight && foe) {
      rotate(def, s, angDiff(s.facing, Math.atan2(foe.s.y - s.y, foe.s.x - s.x)), gait, lever, dt)
      s.speed = 0
      s.idle = false
    } else {
      const attacking = reg.order === 'attack' && !def.missile && !reg.routing && reg.plow <= 0
      if (!attacking || !chargeAt(battle, reg, def, s, gait, lever, dt, press)) {
        followSlot(reg, def, s, gait, lever, dt, fighting, lagSum.get(reg)!)
      }
    }
    s.vx = (s.x - ox) / dt
    s.vy = (s.y - oy) / dt
    const moved = speedSum.get(reg) ?? 0
    speedSum.set(reg, moved + Math.hypot(s.vx, s.vy))
  }
  for (const reg of battle.regiments) {
    const sum = lagSum.get(reg)!
    reg.lag = sum.count > 0 ? sum.total / sum.count : 0
    reg.trail = sum.count > 0 ? sum.trail / sum.count : 0
    reg.bodySpeed = reg.aliveCount > 0 ? (speedSum.get(reg) ?? 0) / reg.aliveCount : 0
  }
}

/**
 * How close a man on an attack order gets to the target before he leaves his place and runs in. Chariots
 * never leave the line: they ram as a block and drive on through, rather than each picking a man to run down.
 */
function releaseRange(def: UnitDef): number {
  return def.type === 'chariot' ? 0 : Math.max(5, def.chargeSpeed * 1.3)
}

/** How many of the attacker's men are already about each enemy soldier this step, so the rest spread out. */
interface Press {
  live: Live[]
  grid: Spatial
  buf: number[]
  near: Map<Soldier, number>
  claims: Map<Soldier, number>
}

/** Men already this close round an enemy soldier count as crowding him. */
const CROWD_RADIUS = 2.5
/** Metres further a man will run to reach an enemy soldier with one fewer man on him. */
const CROWD_COST = 3

function crowdOn(press: Press, foe: Soldier, side: Regiment['side']): number {
  const cached = press.near.get(foe)
  if (cached !== undefined) return cached
  press.grid.query(foe.x, foe.y, CROWD_RADIUS, press.buf)
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
  let nearest = Infinity
  let bestCost = Infinity
  let pick: Soldier | null = null
  for (const foe of target.soldiers) {
    if (!foe.alive) continue
    const d = Math.hypot(foe.x - s.x, foe.y - s.y)
    nearest = Math.min(nearest, d)
    const self = d <= CROWD_RADIUS ? 1 : 0
    const crowd = crowdOn(press, foe, reg.side) - self + (press.claims.get(foe) ?? 0)
    const cost = d + CROWD_COST * Math.max(0, crowd)
    if (cost < bestCost) {
      bestCost = cost
      pick = foe
    }
  }
  if (!pick || (!reg.engaged && nearest > releaseRange(def))) return false
  press.claims.set(pick, (press.claims.get(pick) ?? 0) + 1)
  const distance = Math.hypot(pick.x - s.x, pick.y - s.y)
  s.idle = false
  steer(def, s, Math.atan2(pick.y - s.y, pick.x - s.x), gait, gait, lever, dt, distance, distance)
  return true
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

  if (still && (distance < 0.2 || (s.idle && distance < 0.6))) {
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
  const heading = Math.atan2(vy, vx)
  const behindMe = Math.abs(angDiff(s.facing, heading)) > 100 * DEG
  if (behindMe && (distance < (still ? 0.3 : 0.9) || (holdGround && distance < 3))) {
    standBy(reg, def, s, gait, lever, dt, brake)
    return
  }
  if (still && def.turnRadius === 0 && distance < BACK_STEP_RANGE && Math.abs(angDiff(reg.facing, heading)) > 100 * DEG) {
    backStep(reg, def, s, heading, Math.min(want, gait * BACK_STEP_PACE), gait, lever, dt, distance)
    return
  }
  steer(def, s, heading, Math.min(want, top), top, lever, dt, distance + slotSpeed * dt + 0.02, distance)
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
  s.knockVx *= drag
  s.knockVy *= drag
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
): void {
  const safeLever = Math.max(0.25, lever)
  const err = angDiff(s.facing, heading)
  const wantOmega = rotate(def, s, err, top, lever, dt)
  let target = Math.abs(err) >= Math.PI / 2 ? 0 : Math.max(0, Math.min(want, top - Math.abs(wantOmega) * safeLever)) * Math.cos(err)
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

function nearestEnemy(
  live: Live[],
  grid: Spatial,
  buf: number[],
  index: number,
  radius: number,
): Live | null {
  const self = live[index]
  grid.query(self.s.x, self.s.y, radius + 2, buf)
  let best: Live | null = null
  let bestD = radius
  for (const otherIndex of buf) {
    const other = live[otherIndex]
    if (other.reg.side === self.reg.side || !other.s.alive) continue
    const gap = gapBetween(self.s, self.def, other.s, other.def)
    if (gap < bestD) {
      best = other
      bestD = gap
    }
  }
  return best
}

function resolveMelee(battle: Battle, live: Live[], grid: Spatial, buf: number[], dt: number): void {
  const ready: { attacker: Live; target: Live; gap: number }[] = []
  for (let i = 0; i < live.length; i++) {
    const item = live[i]
    if (!item.s.alive || item.reg.routing || item.s.down > 0) continue
    item.s.meleeCd -= dt
    grid.query(item.s.x, item.s.y, item.def.reach + 3, buf)
    let target: Live | null = null
    let targetGap = Infinity
    for (const otherIndex of buf) {
      const other = live[otherIndex]
      if (other.reg.side === item.reg.side || !other.s.alive || other.s.down > 0) continue
      const gap = gapBetween(item.s, item.def, other.s, other.def)
      if (gap > item.def.reach) continue
      item.reg.inContact = true
      other.reg.inContact = true
      const arc = facingArc(item.reg.facing, item.s.x, item.s.y, other.s.x, other.s.y)
      if (arc === 'rear') item.reg.touchRear = true
      else if (arc === 'flank') item.reg.touchFlank = true
      const to = Math.atan2(other.s.y - item.s.y, other.s.x - item.s.x)
      if (Math.abs(angDiff(item.s.facing, to)) > 70 * DEG) continue
      if (runningDown(item, other)) continue
      if (gap < targetGap) {
        target = other
        targetGap = gap
      }
    }
    if (!target || item.s.meleeCd > 0) continue
    ready.push({ attacker: item, target, gap: targetGap })
  }
  const byTarget = new Map<number, { attacker: Live; target: Live; gap: number }[]>()
  for (const swing of ready) {
    const list = byTarget.get(swing.target.s.id)
    if (list) list.push(swing)
    else byTarget.set(swing.target.s.id, [swing])
  }
  for (const swings of byTarget.values()) {
    swings.sort((a, b) => a.gap - b.gap)
    const slots = swings[0].target.def.meleeSlots
    for (let i = 0; i < swings.length && i < slots; i++) landMelee(battle, swings[i].attacker, swings[i].target)
  }
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
  return item.def.antiLargeMa <= 0 || !isBracing(item.reg, item.def, other.s.x, other.s.y)
}

/** A man must himself be going at his man at least this fast to strike with a charge; standing, he has none. */
const CHARGING_PACE = 1

function landMelee(battle: Battle, item: Live, target: Live): void {
  item.s.meleeCd = item.def.meleeInterval
  const mods = fatigueMods(item.reg.fatigue)
  const dx = target.s.x - item.s.x
  const dy = target.s.y - item.s.y
  const apart = Math.hypot(dx, dy) || 1
  const rushing = (item.s.vx * dx + item.s.vy * dy) / apart > CHARGING_PACE
  const closing = ((item.s.vx - target.s.vx) * dx + (item.s.vy - target.s.vy) * dy) / apart
  const charge = rushing ? item.def.chargeBonus * mods.stat * chargeShare(closing, item.def.chargeSpeed * mods.stat) : 0
  let attack = item.def.meleeAttack * mods.stat + charge
  if (target.def.large) attack += item.def.antiLargeMa
  else if (isInfantry(target.def.type)) attack += item.def.antiInfantryMa
  let defense = target.def.meleeDefense * fatigueMods(target.reg.fatigue).stat
  const arc = facingArc(target.reg.facing, target.s.x, target.s.y, item.s.x, item.s.y)
  if (arc === 'flank') defense *= 0.45
  else if (arc === 'rear') defense *= 0.2
  if (target.s.disengage > 0) defense -= 12
  if (target.reg.bogged) defense -= 8
  defense = Math.max(0, defense)
  if (battle.rng() * 100 > hitChance(attack, defense)) return
  target.reg.meleeReact = true
  if (arc === 'rear') target.reg.rearFoe = item.reg.id
  const fromCharge = splitBonus(item.def.weaponBase, item.def.weaponAp, charge)
  const antiWs = target.def.large ? item.def.antiLargeWs : isInfantry(target.def.type) ? item.def.antiInfantryWs : 0
  const fromAnti = splitBonus(item.def.weaponBase, item.def.weaponAp, antiWs)
  hurt(
    battle,
    target,
    item.reg,
    item.def.weaponBase + fromCharge.base + fromAnti.base,
    item.def.weaponAp + fromCharge.ap + fromAnti.ap,
    false,
  )
}

function resolveShooting(battle: Battle, live: Live[], grid: Spatial, pad: Scratch, dt: number): void {
  const buf = pad.buf
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    if (!def.missile || reg.routing || reg.aliveCount <= 0) continue
    const target = shootingTarget(battle, reg, def.missile.range)
    if (!target) continue
    const reload = def.missile.reload * fatigueMods(reg.fatigue).reload
    let fired = false
    for (const soldier of reg.soldiers) {
      if (!soldier.alive || soldier.down > 0) continue
      const selfIndex = pad.indexOf.get(soldier.id) ?? -1
      const foe = selfIndex >= 0 ? nearestEnemy(live, grid, buf, selfIndex, def.reach) : null
      if (foe && gapBetween(soldier, def, foe.s, foe.def) <= def.reach) continue
      if (soldier.reload > 0) {
        soldier.reload -= dt
        continue
      }
      const prey = randomAlive(battle, target)
      if (!prey || soldier.ammo <= 0 || !inFireArc(reg, prey.x, prey.y)) continue
      if (Math.hypot(prey.x - soldier.x, prey.y - soldier.y) > def.missile.range) continue
      spawnArrow(battle, reg, soldier, prey, def)
      soldier.ammo -= 1
      soldier.reload = reload
      fired = true
    }
    if (fired) reg.shot = true
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
  if (reg.order !== 'hold') return null
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
  const accuracy = accuracyAt(distance, missile.near, missile.far, missile.accNear, missile.accFar)
  if (battle.rng() > accuracy) {
    const side = battle.rng() < 0.5 ? -1 : 1
    const miss = 2 + battle.rng() * 4
    aimX += (-dy / distance) * side * miss
    aimY += (dx / distance) * side * miss
  }
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
    base: missile.base,
    ap: missile.ap,
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
    apex: Math.min(16, travel * 0.16),
  }
  battle.projectiles.push(projectile)
}

function flyProjectiles(battle: Battle, live: Live[], grid: Spatial, buf: number[], dt: number): void {
  for (const projectile of battle.projectiles) {
    if (!projectile.alive) continue
    if (projectile.arc) {
      flyArc(battle, projectile, live, dt)
      continue
    }
    const x0 = projectile.x
    const y0 = projectile.y
    const x1 = projectile.x + projectile.vx * dt
    const y1 = projectile.y + projectile.vy * dt
    const stepDist = Math.hypot(x1 - x0, y1 - y0)
    grid.query((x0 + x1) / 2, (y0 + y1) / 2, stepDist / 2 + 3, buf)
    let bestT = 1.01
    let best: Live | null = null
    for (const index of buf) {
      const item = live[index]
      if (!item.s.alive || item.s.id === projectile.shooterId || item.reg.id === projectile.sourceReg) continue
      for (const point of shapePoints(item.s, item.def)) {
        const t = rayCircleT(x0, y0, x1, y1, point.x, point.y, item.def.radius + 0.05)
        if (t !== null && t < bestT) {
          bestT = t
          best = item
        }
      }
    }
    if (best) {
      projectile.x = x0 + (x1 - x0) * bestT
      projectile.y = y0 + (y1 - y0) * bestT
      projectile.alive = false
      const blocked =
        best.def.shieldBlock > 0 &&
        facingArc(best.reg.facing, best.s.x, best.s.y, x0, y0) === 'front' &&
        battle.rng() < best.def.shieldBlock
      if (!blocked) {
        const source = regimentById(battle, projectile.sourceReg) ?? null
        hurt(battle, best, source, projectile.base, projectile.ap, false)
      }
      continue
    }
    projectile.x = x1
    projectile.y = y1
    projectile.traveled += stepDist
    if (
      projectile.traveled > projectile.maxRange + 6 ||
      projectile.x < -8 ||
      projectile.y < -8 ||
      projectile.x > MAP_WIDTH + 8 ||
      projectile.y > MAP_HEIGHT + 8
    ) {
      projectile.alive = false
    }
  }
  battle.projectiles = battle.projectiles.filter((projectile) => projectile.alive)
}

function flyArc(battle: Battle, projectile: Projectile, live: Live[], dt: number): void {
  projectile.age += dt
  const t = Math.min(1, projectile.age / projectile.duration)
  projectile.x = projectile.originX + (projectile.landX - projectile.originX) * t
  projectile.y = projectile.originY + (projectile.landY - projectile.originY) * t
  projectile.traveled = Math.hypot(projectile.x - projectile.originX, projectile.y - projectile.originY)
  if (t < 1) return
  projectile.alive = false
  let best: Live | null = null
  let bestD = 0.45
  for (const item of live) {
    if (!item.s.alive || item.s.id === projectile.shooterId) continue
    let nearest = Infinity
    for (const point of shapePoints(item.s, item.def)) {
      nearest = Math.min(nearest, Math.hypot(point.x - projectile.landX, point.y - projectile.landY) - item.def.radius)
    }
    if (nearest < bestD) {
      best = item
      bestD = nearest
    }
  }
  if (!best) return
  const blocked =
    best.def.shieldBlock > 0 &&
    facingArc(best.reg.facing, best.s.x, best.s.y, projectile.originX, projectile.originY) === 'front' &&
    battle.rng() < best.def.shieldBlock
  if (blocked) return
  const source = regimentById(battle, projectile.sourceReg) ?? null
  hurt(battle, best, source, projectile.base, projectile.ap, false)
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
      const braced = isBracing(hit.item.reg, hit.item.def, item.s.x, item.s.y)
      const arc = facingArc(hit.item.reg.facing, hit.item.s.x, hit.item.s.y, item.s.x, item.s.y)
      const foot = !hit.item.def.large
      const sprawl = foot
      if (braced) braceAgainst(item)
      if (item.def.type === 'chariot' && foot) item.reg.plow = Math.max(item.reg.plow, PLOW_TIME)
      if (hit.item.s.down > 0) continue
      const room = item.s.cleave < item.def.cleave
      if (room) {
        const raw = impactRaw(item.def.impactPower, closing, item.def.mass, hit.item.def.mass, braced)
        hurt(battle, hit.item, item.reg, raw * 0.3, raw * 0.7, true)
        item.s.latched.push(hit.item.s.id)
        item.s.cleave += 1
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

function separate(live: Live[], pad: Scratch): void {
  const buf = pad.buf
  for (let pass = 0; pass < 4; pass++) {
    const grid = fillGrid(pad, live)
    for (let i = 0; i < live.length; i++) {
      const a = live[i]
      if (!a.s.alive) continue
      grid.query(a.s.x, a.s.y, a.def.radius + 2.4, buf)
      for (const j of buf) {
        if (j <= i) continue
        const b = live[j]
        if (!b.s.alive) continue
        const gap = gapBetween(a.s, a.def, b.s, b.def)
        if (gap >= 0.05) continue
        if (pass === 0 && a.reg === b.reg) swapIfCrossing(a, b)
        let dx = b.s.x - a.s.x
        let dy = b.s.y - a.s.y
        let distance = Math.hypot(dx, dy)
        if (distance < 1e-4) {
          dx = (a.s.id + pass) % 2 === 0 ? 1 : 0
          dy = dx === 0 ? 1 : 0
          distance = 1
        }
        const nx = dx / distance
        const ny = dy / distance
        let massA = collisionMass(a, b.s.x, b.s.y)
        let massB = collisionMass(b, a.s.x, a.s.y)
        const total = massA + massB
        const push = 0.05 - gap
        const enemy = a.reg.side !== b.reg.side
        const plowA = enemy && a.def.type === 'chariot' && a.reg.plow > 0
        const plowB = enemy && b.def.type === 'chariot' && b.reg.plow > 0
        const onFoot = enemy && !a.def.large && !b.def.large
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
        const relVn = (b.s.vx - a.s.vx) * nx + (b.s.vy - a.s.vy) * ny
        if (relVn < 0 && onFoot) {
          a.s.vx += nx * relVn * yieldA
          a.s.vy += ny * relVn * yieldA
          b.s.vx -= nx * relVn * (1 - yieldA)
          b.s.vy -= ny * relVn * (1 - yieldA)
        } else if (relVn < 0 && enemy) {
          const impulse = -relVn / (1 / massA + 1 / massB)
          const keepA = plowA ? 0.05 : 1
          const keepB = plowB ? 0.05 : 1
          a.s.vx -= (nx * impulse * keepA) / massA
          a.s.vy -= (ny * impulse * keepA) / massA
          b.s.vx += (nx * impulse * keepB) / massB
          b.s.vy += (ny * impulse * keepB) / massB
        }
      }
    }
  }
}

/**
 * Share of the overlap between two enemy foot soldiers that `a` gives way by. A man on foot cannot shove an
 * enemy man on foot: whoever walks into the other is stopped and slides off him; the one standing does not
 * budge. When neither is moving, the side on the attack gives way, so a ring of attackers never crushes a block.
 */
function footYield(a: Live, b: Live, nx: number, ny: number): number {
  const into = (item: Live, sign: number) =>
    Math.max(0, sign * (item.s.vx * nx + item.s.vy * ny)) + (item.reg.order === 'attack' ? 0.05 : 0) + 0.01
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
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      const outside =
        soldier.x < 0 || soldier.y < 0 || soldier.x > MAP_WIDTH || soldier.y > MAP_HEIGHT
      if (reg.routing && outside) {
        kill(battle, reg, soldier)
        continue
      }
      soldier.x = clamp(soldier.x, 0.8, MAP_WIDTH - 0.8)
      soldier.y = clamp(soldier.y, 0.8, MAP_HEIGHT - 0.8)
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
    if (nearestEnemy(live, pad.spatial, pad.buf, index, pressedGap + 1e-6)) pressed += 1
  }
  const needed = reg.engaged ? Math.max(1, Math.ceil(front.length * 0.2)) : Math.max(1, Math.ceil(front.length * 0.45))
  return pressed >= needed
}

function finishChargeFatigueBog(battle: Battle, live: Live[], pad: Scratch, dt: number): void {
  fillGrid(pad, live)
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    const charging = reg.wantCharge
    if (reg.inContact && reg.plow <= 0) reg.wantCharge = false
    if (def.missile || reg.order === 'move' || reg.routing) reg.engaged = false
    else if (reg.order === 'attack' || reg.order === 'hold') reg.engaged = linePressed(reg, def, live, pad)

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

    const active = charging || reg.inContact || reg.shot
    if (active) {
      reg.exertion = Math.min(80, reg.exertion + dt)
      reg.restTime = 0
      if (reg.exertion >= 80) reg.fatigue = 'exhausted'
      else if (reg.exertion >= 40) reg.fatigue = 'winded'
    } else {
      reg.restTime += dt
      if (reg.restTime >= 15 && reg.fatigue !== 'fresh') {
        reg.restTime = 0
        if (reg.fatigue === 'exhausted') {
          reg.fatigue = 'winded'
          reg.exertion = 40
        } else {
          reg.fatigue = 'fresh'
          reg.exertion = 0
        }
      }
    }
  }
}

function updateMorale(battle: Battle, dt: number): void {
  for (const reg of battle.regiments) {
    if (reg.aliveCount <= 0) continue
    prune(reg.dealt, battle.time, 10)
    prune(reg.taken, battle.time, 10)
    let friends = 0
    for (const other of battle.regiments) {
      if (other.id === reg.id || other.side !== reg.side || !other.routing || other.aliveCount <= 0) continue
      if (Math.hypot(other.anchorX - reg.anchorX, other.anchorY - reg.anchorY) <= 40) friends++
    }
    const dealt = reg.dealt.reduce((sum, event) => sum + event.v, 0)
    const taken = reg.taken.reduce((sum, event) => sum + event.v, 0)
    const leadership = effectiveLeadership({
      base: unitDef(reg.type).leadership,
      initial: reg.initial,
      alive: reg.aliveCount,
      flank: reg.touchFlank,
      rear: reg.touchRear,
      recentDamage: reg.taken.some((event) => battle.time - event.t <= 8),
      winning: dealt > taken && dealt > 0,
      routingFriends: friends,
    })
    reg.leadership = leadership
    if (leadership < 0) {
      if (!reg.routing) pushNotice(battle, `${reg.name}溃逃`)
      reg.routing = true
      reg.rallyTime = 0
      reg.order = 'hold'
      reg.targetId = null
      reg.wantCharge = false
      reg.engaged = false
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
      reg.facingLocked = true
      continue
    }
    if (!reg.routing) continue
    const near = nearestEnemyDistance(battle, reg) < 30
    if (near) reg.rallyTime = 0
    else reg.rallyTime += dt
    if (reg.rallyTime < 8) continue
    const center = aliveCenter(reg)
    if (!center) continue
    reg.routing = false
    reg.rallyTime = 0
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.order = 'hold'
    reg.facingLocked = true
    reg.targetId = null
    const enemy = nearestEnemyRegiment(battle, reg)
    reg.destFacing = enemy ? Math.atan2(enemy.anchorY - center.y, enemy.anchorX - center.x) : reg.facing
    pushNotice(battle, `${reg.name}重整`)
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
  if (isBracing(item.reg, item.def, otherX, otherY)) return item.def.mass * 3
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

function hurt(battle: Battle, target: Live, source: Regiment | null, base: number, ap: number, impact: boolean): void {
  if (target.s.down > 0) return
  const damage = mitigate(base, ap, target.def.armor, armorRoll(battle.rng))
  if (damage <= 0 || !target.s.alive) return
  target.s.hp -= damage
  target.s.flash = 0.12
  const now = battle.time
  target.reg.taken.push({ t: now, v: damage })
  if (source) source.dealt.push({ t: now, v: damage })
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

function nearestEnemyDistance(battle: Battle, reg: Regiment): number {
  const center = aliveCenter(reg)
  if (!center) return Infinity
  let best = Infinity
  for (const other of battle.regiments) {
    if (other.side === reg.side) continue
    for (const soldier of other.soldiers) {
      if (!soldier.alive) continue
      best = Math.min(best, Math.hypot(soldier.x - center.x, soldier.y - center.y))
    }
  }
  return best
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
