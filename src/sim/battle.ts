import { planEnemyIntents } from './ai'
import {
  accuracyAt,
  armorRoll,
  chargeScale,
  effectiveLeadership,
  fatigueMods,
  hitChance,
  impactRaw,
  mitigate,
  splitBonus,
} from './combat'
import { PLACE_RADIUS, compactRanks, gapBetween, isBracing, reformAt, slotOf } from './formation'
import { DEG, angDiff, clamp, facingArc, forward, mulberry32, rayCircleT } from './math'
import { commandAttack, commandHold, commandMove, regimentById } from './orders'
import { shapePoints } from './formation'
import { Spatial } from './spatial'
import type { Battle, Projectile, Regiment, Side, Soldier, UnitDef, UnitType } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { unitDef } from './units'

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
    found = { spatial: new Spatial(6, 2048), buf: [], live: [], indexOf: new Map() }
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
  spawn(battle, 0, 'infantry', '南军左步', 52, 58, NORTH)
  spawn(battle, 0, 'infantry', '南军右步', 74, 58, NORTH)
  spawn(battle, 0, 'archer', '南军弓箭', 63, 40, NORTH)
  spawn(battle, 0, 'musket', '南军火枪', 24, 46, NORTH)
  spawn(battle, 0, 'cavalry', '南军骑兵', 104, 60, NORTH)
  spawn(battle, 0, 'chariot', '南军战车', 112, 40, NORTH)
  spawn(battle, 1, 'infantry', '北军一步', 16, 128, SOUTH)
  spawn(battle, 1, 'infantry', '北军二步', 40, 128, SOUTH)
  spawn(battle, 1, 'infantry', '北军三步', 65, 128, SOUTH)
  spawn(battle, 1, 'infantry', '北军四步', 90, 128, SOUTH)
  spawn(battle, 1, 'infantry', '北军五步', 114, 128, SOUTH)
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
    chargeTimer: -1,
    wantCharge: false,
    anchorSpeed: 0,
    turnRate: 0,
    frameVx: 0,
    frameVy: 0,
    lag: 0,
    bodySpeed: 0,
    stationaryTime: 0,
    braceSlow: 0,
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
      idle: true,
      facing,
      file,
      rank,
      centerIndex: -1,
      alive: true,
      deathTime: -1,
      meleeCd: battle.rng() * def.meleeInterval,
      reload: def.missile ? battle.rng() * def.missile.reload : 0,
      disengage: 0,
      leaving: false,
      fleeX: 0,
      fleeY: 0,
      latched: [],
      cleave: 0,
      flash: 0,
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
  finishChargeFatigueBog(battle, dt)
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
  reg.destFacing = Math.atan2(dy, dx)
  reg.facingLocked = true
  const def = unitDef(reg.type)
  if (!def.missile && reg.engaged) {
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.wantCharge = false
    return
  }
  if (def.missile) {
    const desired = def.missile.range * 0.8
    if (distance < 22) {
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

function armCharge(reg: Regiment): void {
  const def = unitDef(reg.type)
  if (reg.order !== 'attack' || reg.routing || def.missile || def.chargeSpeed <= def.speed + 0.05) {
    if (reg.order !== 'attack' || reg.routing) reg.wantCharge = false
    return
  }
  const dx = reg.destX - reg.anchorX
  const dy = reg.destY - reg.anchorY
  const distance = Math.hypot(dx, dy)
  const aligned = Math.abs(angDiff(reg.facing, reg.destFacing)) < 25 * DEG
  if (distance > 18 && aligned) reg.wantCharge = true
}

function moveSpeedOf(reg: Regiment, soldier?: Soldier): number {
  const def = unitDef(reg.type)
  const mods = fatigueMods(reg.fatigue)
  let speed = (reg.wantCharge && !reg.routing ? def.chargeSpeed : def.speed) * mods.stat
  if (reg.routing) speed *= 1.1
  if (reg.braceSlow > 0) speed = Math.min(speed, 1.5)
  if (reg.bogged && reg.inContact) speed = Math.min(speed, 1.8)
  if (soldier && soldier.disengage > 0) speed *= 0.55
  return speed
}

function accelRate(def: UnitDef, speedingUp: boolean): number {
  const base = def.type === 'chariot' ? 2.2 : def.type === 'cavalry' ? 2.8 : 1.7
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
  if (def.type === 'cavalry') return 0.9
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

/** Past this, the block does not wheel. Every soldier turns on the spot and the ranks re-form facing the new way. */
const REFORM_TURN = 45 * DEG

/**
 * The regiment itself is only a plan: where the block should stand and which way it faces.
 * Soldiers are the bodies that obey the walking rules and try to keep up with it.
 */
function moveRegiments(battle: Battle, dt: number): void {
  for (const reg of battle.regiments) {
    if (reg.braceSlow > 0) reg.braceSlow = Math.max(0, reg.braceSlow - dt)
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
      const threat = nearestEnemyRegiment(battle, reg)
      let dx = 0
      let dy = reg.side === 0 ? -1 : 1
      if (threat) {
        dx = reg.anchorX - threat.anchorX
        dy = reg.anchorY - threat.anchorY
      }
      relaid = march(reg, def, Math.atan2(dy, dx), Infinity, dt, 0.5)
      reg.destX = reg.anchorX
      reg.destY = reg.anchorY
      reg.destFacing = reg.facing
      reg.stationaryTime = 0
    } else if (reg.engaged && !def.missile) {
      const motion = drive(reg.facing, reg.destFacing, moveSpeedOf(reg), halfWidth(reg), dt, false)
      reg.facing = motion.facing
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
 * March the block toward a heading. Small corrections wheel the block; the wheel never makes the inner
 * flank walk backward. A large turn re-forms the block on the spot instead of swinging it like a door.
 * The frame slows down while its soldiers are strung out behind it. Returns true when the block was re-laid.
 */
function march(reg: Regiment, def: UnitDef, heading: number, distance: number, dt: number, minCohesion: number): boolean {
  const err = angDiff(reg.facing, heading)
  if (Math.abs(err) > REFORM_TURN) {
    reformAt(reg, reg.files, heading)
    reg.anchorSpeed = 0
    return true
  }
  const cohesion = clamp(1 - (reg.lag - 0.8) / 1.6, minCohesion, 1)
  const top = moveSpeedOf(reg) * cohesion
  const lever = halfWidth(reg)
  const maxOmega = Math.min(top / (2 * lever), (reg.anchorSpeed + 0.3) / lever)
  const omega = Math.abs(err) < 0.02 ? 0 : clamp(err * 2.5, -maxOmega, maxOmega)
  const target = Math.max(0, top - Math.abs(omega) * lever)
  reg.anchorSpeed = approach(reg.anchorSpeed, target, accelRate(def, target > reg.anchorSpeed), dt)
  reg.facing += omega * dt
  const fwd = forward(reg.facing)
  const stepDist = Math.min(reg.anchorSpeed * dt, distance)
  reg.anchorX = clamp(reg.anchorX + fwd.x * stepDist, 3, MAP_WIDTH - 3)
  reg.anchorY = clamp(reg.anchorY + fwd.y * stepDist, 3, MAP_HEIGHT - 3)
  return false
}

/** Close to the destination the frame is laid down at its final place; soldiers walk there one by one. */
function settleAtDest(reg: Regiment): boolean {
  const alive = Math.max(1, reg.aliveCount)
  const want = clamp(reg.destFiles, 1, alive)
  const have = clamp(reg.files, 1, alive)
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
  const lagSum = new Map<Regiment, { total: number; count: number }>()
  const speedSum = new Map<Regiment, number>()
  for (const reg of battle.regiments) reg.nearEnemy = false
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
    if (reg.engaged && !def.missile && !reg.routing) {
      const face = foe && gapToFoe <= def.reach + 0.3 ? Math.atan2(foe.s.y - s.y, foe.s.x - s.x) : reg.facing
      s.facing = drive(s.facing, face, gait, lever, dt, false).facing
      s.speed = 0
      s.idle = false
    } else if (touching && foe && reg.order !== 'move') {
      s.facing = drive(s.facing, Math.atan2(foe.s.y - s.y, foe.s.x - s.x), gait, lever, dt, false).facing
      s.speed = 0
      s.idle = false
    } else {
      const lag = followSlot(reg, def, s, gait, lever, dt)
      const sum = lagSum.get(reg)
      if (sum) {
        sum.total += lag
        sum.count += 1
      } else {
        lagSum.set(reg, { total: lag, count: 1 })
      }
    }
    s.vx = (s.x - ox) / dt
    s.vy = (s.y - oy) / dt
    const moved = speedSum.get(reg) ?? 0
    speedSum.set(reg, moved + Math.hypot(s.vx, s.vy))
  }
  for (const reg of battle.regiments) {
    const sum = lagSum.get(reg)
    reg.lag = sum ? sum.total / sum.count : 0
    reg.bodySpeed = reg.aliveCount > 0 ? (speedSum.get(reg) ?? 0) / reg.aliveCount : 0
  }
}

/**
 * Walk toward a slot that may itself be moving. The soldier aims at where the slot is going, not just where
 * it is, so a man already in step simply keeps pace. Men who have fallen behind their mates jog to catch up.
 * A slot that is only a pace behind is waited for rather than turned around for. Returns the distance left.
 */
function followSlot(reg: Regiment, def: UnitDef, s: Soldier, gait: number, lever: number, dt: number): number {
  const slot = slotOf(reg, def, s.file, s.rank, s.centerIndex)
  const ex = slot.x - s.x
  const ey = slot.y - s.y
  const distance = Math.hypot(ex, ey)
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
    return distance
  }
  s.idle = false

  const jog = reg.wantCharge || reg.braceSlow > 0 || reg.bogged ? 1 : Math.max(1.25, def.chargeSpeed / def.speed)
  const straggling = clamp((distance - reg.lag + 0.15) / 1.2, 0, 1)
  const behind = still ? straggling : Math.max(straggling, clamp((distance - 0.3) / 1.5, 0, 1))
  const top = gait * (1 + (jog - 1) * behind)
  const pull = distance > 1e-6 ? Math.min(top, Math.sqrt(2 * brake * distance), distance * 4) / distance : 0
  let vx = slotVx + ex * pull
  let vy = slotVy + ey * pull
  const want = Math.hypot(vx, vy)
  if (want > top) {
    vx *= top / want
    vy *= top / want
  }
  const heading = Math.atan2(vy, vx)
  if (Math.abs(angDiff(s.facing, heading)) > 100 * DEG && distance < (still ? 0.3 : 0.9)) {
    standBy(reg, def, s, gait, lever, dt, brake)
    return distance
  }
  steer(def, s, heading, Math.min(want, top), top, lever, dt, distance + slotSpeed * dt + 0.02)
  return distance
}

/** Face the regiment's front and coast to a stop. */
function standBy(reg: Regiment, def: UnitDef, s: Soldier, gait: number, lever: number, dt: number, brake: number): void {
  s.facing = drive(s.facing, reg.facing, gait, lever, dt, false).facing
  s.speed = approach(s.speed, 0, brake, dt)
  if (s.speed <= 0) return
  const fwd = forward(s.facing)
  s.x += fwd.x * s.speed * dt
  s.y += fwd.y * s.speed * dt
}

/**
 * Turn toward a heading and walk forward only. Walking speed and the sweep of the turn share the top speed,
 * so a man at full stride has to slow down before he can turn hard.
 */
function steer(def: UnitDef, s: Soldier, heading: number, want: number, top: number, lever: number, dt: number, maxStep: number): void {
  const safeLever = Math.max(0.25, lever)
  const err = angDiff(s.facing, heading)
  const wantOmega = Math.abs(err) < 0.02 ? 0 : err * 6
  const target = Math.abs(err) >= Math.PI / 2 ? 0 : Math.max(0, Math.min(want, top - Math.abs(wantOmega) * safeLever)) * Math.cos(err)
  s.speed = approach(s.speed, target, accelRate(def, target > s.speed), dt)
  const room = Math.max(0, top - s.speed) / safeLever
  s.facing += clamp(wantOmega, -room, room) * dt
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
    if (!item.s.alive || item.reg.routing) continue
    item.s.meleeCd -= dt
    grid.query(item.s.x, item.s.y, item.def.reach + 3, buf)
    let target: Live | null = null
    let targetGap = Infinity
    for (const otherIndex of buf) {
      const other = live[otherIndex]
      if (other.reg.side === item.reg.side || !other.s.alive) continue
      const gap = gapBetween(item.s, item.def, other.s, other.def)
      if (gap > item.def.reach) continue
      item.reg.inContact = true
      other.reg.inContact = true
      const arc = facingArc(item.reg.facing, item.s.x, item.s.y, other.s.x, other.s.y)
      if (arc === 'rear') item.reg.touchRear = true
      else if (arc === 'flank') item.reg.touchFlank = true
      const to = Math.atan2(other.s.y - item.s.y, other.s.x - item.s.x)
      if (Math.abs(angDiff(item.s.facing, to)) > 70 * DEG) continue
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

function landMelee(battle: Battle, item: Live, target: Live): void {
  item.s.meleeCd = item.def.meleeInterval
  const mods = fatigueMods(item.reg.fatigue)
  const scale = chargeScale(item.reg.chargeTimer)
  const charge = item.def.chargeBonus * mods.stat * scale
  let attack = item.def.meleeAttack * mods.stat + charge
  if (target.def.large) attack += item.def.antiLargeMa
  let defense = target.def.meleeDefense * fatigueMods(target.reg.fatigue).stat
  const arc = facingArc(target.reg.facing, target.s.x, target.s.y, item.s.x, item.s.y)
  if (arc === 'flank') defense *= 0.45
  else if (arc === 'rear') defense *= 0.2
  if (target.s.disengage > 0) defense -= 12
  if (target.reg.bogged) defense -= 8
  defense = Math.max(0, defense)
  if (battle.rng() * 100 > hitChance(attack, defense)) return
  const fromCharge = splitBonus(item.def.weaponBase, item.def.weaponAp, charge)
  const fromAnti = splitBonus(item.def.weaponBase, item.def.weaponAp, target.def.large ? item.def.antiLargeWs : 0)
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
    reg.shot = true
    const reload = def.missile.reload * fatigueMods(reg.fatigue).reload
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      const selfIndex = pad.indexOf.get(soldier.id) ?? -1
      const foe = selfIndex >= 0 ? nearestEnemy(live, grid, buf, selfIndex, def.reach) : null
      if (foe && gapBetween(soldier, def, foe.s, foe.def) <= def.reach) continue
      if (soldier.reload > 0) {
        soldier.reload -= dt
        continue
      }
      const prey = randomAlive(battle, target)
      if (!prey) continue
      spawnArrow(battle, reg, soldier, prey, def)
      soldier.reload = reload
    }
  }
}

function shootingTarget(battle: Battle, reg: Regiment, range: number): Regiment | null {
  if (reg.order === 'attack' && reg.targetId !== null) {
    const target = regimentById(battle, reg.targetId)
    if (!target || target.aliveCount <= 0) return null
    const distance = Math.hypot(target.anchorX - reg.anchorX, target.anchorY - reg.anchorY)
    return distance <= range ? target : null
  }
  if (reg.order !== 'hold') return null
  let best: Regiment | null = null
  let bestD = range
  for (const other of battle.regiments) {
    if (other.side === reg.side || other.aliveCount <= 0) continue
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
    if (item.s.cleave >= item.def.cleave) continue
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
    for (const hit of hits) {
      if (item.s.cleave >= item.def.cleave) break
      const dx = hit.item.s.x - item.s.x
      const dy = hit.item.s.y - item.s.y
      const distance = Math.hypot(dx, dy) || 1
      const nx = dx / distance
      const ny = dy / distance
      const closing = (item.s.vx - hit.item.s.vx) * nx + (item.s.vy - hit.item.s.vy) * ny
      if (closing <= 5) continue
      const braced = isBracing(hit.item.reg, hit.item.def, item.s.x, item.s.y)
      const raw = impactRaw(item.def.impactPower, closing, item.def.mass, hit.item.def.mass, braced)
      hurt(battle, hit.item, item.reg, raw * 0.3, raw * 0.7, true)
      item.reg.inContact = true
      hit.item.reg.inContact = true
      const arc = facingArc(hit.item.reg.facing, hit.item.s.x, hit.item.s.y, item.s.x, item.s.y)
      if (arc === 'rear') hit.item.reg.touchRear = true
      else if (arc === 'flank') hit.item.reg.touchFlank = true
      item.s.latched.push(hit.item.s.id)
      item.s.cleave += 1
      const slow = closing * (hit.item.def.mass / (item.def.mass + hit.item.def.mass)) * 0.85
      item.s.vx -= nx * slow
      item.s.vy -= ny * slow
      if (braced) {
        const current = Math.hypot(item.s.vx, item.s.vy) || 1
        item.s.vx = (item.s.vx / current) * 2
        item.s.vy = (item.s.vy / current) * 2
        item.reg.braceSlow = Math.max(item.reg.braceSlow, 1.6)
      }
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
        let massA = a.def.mass
        let massB = b.def.mass
        if (isBracing(a.reg, a.def, b.s.x, b.s.y)) massA *= 6
        if (isBracing(b.reg, b.def, a.s.x, a.s.y)) massB *= 6
        const total = massA + massB
        const push = 0.05 - gap
        a.s.x -= nx * push * (massB / total)
        a.s.y -= ny * push * (massB / total)
        b.s.x += nx * push * (massA / total)
        b.s.y += ny * push * (massA / total)
        const relVn = (b.s.vx - a.s.vx) * nx + (b.s.vy - a.s.vy) * ny
        if (relVn < 0) {
          const impulse = -relVn / (1 / massA + 1 / massB)
          a.s.vx -= nx * impulse / massA
          a.s.vy -= ny * impulse / massA
          b.s.vx += nx * impulse / massB
          b.s.vy += ny * impulse / massB
        }
      }
    }
  }
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

function linePressed(battle: Battle, reg: Regiment, def: UnitDef): boolean {
  const front = reg.soldiers.filter((soldier) => soldier.alive && soldier.rank === 0 && soldier.centerIndex < 0)
  if (front.length === 0) return false
  const pressedGap = reg.engaged ? def.reach : 0.35
  let pressed = 0
  for (const soldier of front) {
    let best = Infinity
    for (const other of battle.regiments) {
      if (other.side === reg.side || other.aliveCount <= 0) continue
      const otherDef = unitDef(other.type)
      for (const enemy of other.soldiers) {
        if (!enemy.alive) continue
        const gap = Math.hypot(enemy.x - soldier.x, enemy.y - soldier.y) - def.radius - otherDef.radius
        if (gap < best) best = gap
      }
    }
    if (best <= pressedGap) pressed += 1
  }
  const needed = reg.engaged ? Math.max(1, Math.ceil(front.length * 0.2)) : Math.max(1, Math.ceil(front.length * 0.45))
  return pressed >= needed
}

function finishChargeFatigueBog(battle: Battle, dt: number): void {
  for (const reg of battle.regiments) {
    const def = unitDef(reg.type)
    const trigger = Math.max(5, def.chargeSpeed * 0.75)
    const charging = reg.wantCharge
    if (reg.inContact && reg.anchorSpeed >= trigger && reg.chargeTimer < 0) reg.chargeTimer = 0
    else if (reg.chargeTimer >= 0) {
      reg.chargeTimer += dt
      if (reg.chargeTimer >= 12) reg.chargeTimer = reg.inContact ? 12 : -1
    }
    if (reg.inContact) reg.wantCharge = false
    if (def.missile || reg.order === 'move' || reg.routing) reg.engaged = false
    else if (reg.order === 'attack' || reg.order === 'hold') reg.engaged = linePressed(battle, reg, def)

    if (def.type === 'chariot') {
      const slow = reg.anchorSpeed < 3.5 || reg.braceSlow > 0 || reg.bogged
      if (reg.inContact && slow) reg.bogTime += dt
      else if (!reg.inContact) reg.bogTime = Math.max(0, reg.bogTime - dt)
      if (reg.bogTime >= 2) reg.bogged = true
      if (reg.bogged && !reg.inContact && reg.anchorSpeed > 8) {
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

function hurt(battle: Battle, target: Live, source: Regiment | null, base: number, ap: number, impact: boolean): void {
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
