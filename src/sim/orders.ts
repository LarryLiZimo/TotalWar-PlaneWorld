import { PLACE_RADIUS, assignFormation, fileCount, fitOnMap, reformAt, reformMoving, regimentLimits, travelFacing } from './formation'
import { clamp } from './math'
import type { Battle, QueuedOrder, Regiment } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { firesMissiles, outOfAmmo, unitDef } from './units'

function controllable(reg: Regiment | undefined): reg is Regiment {
  return !!reg && reg.aliveCount > 0 && !reg.routing
}

/**
 * Still fighting when the order arrives. `inContact` covers missile troops and regiments already marching, whose
 * `engaged` is always false; `engaged` covers a ram's contact lock over enemies lying on the ground; `retargeting`
 * a regiment still pulling out of its old melee; `bogged` a chariot stuck among enemies.
 */
function inMelee(reg: Regiment): boolean {
  return reg.engaged || reg.inContact || reg.retargeting || reg.bogged
}

/** A fresh order runs by default and replaces the previous automatic movement. */
function resetMovement(reg: Regiment): void {
  reg.orderSerial++
  reg.run=true
  reg.wantCharge=false
  reg.engaged=false
  for (const s of reg.soldiers) s.impactHold=0
  reg.retargeting=false
  reg.disengaging=false
  reg.stall=0
  reg.stallGap=-1
  reg.plow=0
  for (const s of reg.soldiers) {
    s.chargeArmed=false
    s.swing=null
    s.plowLeft=0
    s.chargeSpent=false
    s.avoidSide=0
    s.cartPath=null
  }
}

export function regimentById(battle: Battle, id: number): Regiment | undefined {
  return battle.regiments.find((reg) => reg.id === id)
}

/** One regiment's spot: where translate / rotate drags send it. */
export interface Placement { id: number; x: number; y: number; facing: number }
type March = Omit<Extract<QueuedOrder, { kind: 'move' }>, 'kind'>

/** March to one spot, keeping the width unless `files` asks for another. Every move-type order comes down to this. */
function startMarch(reg: Regiment, march: March): void {
  const disengaging = inMelee(reg)
  resetMovement(reg)
  reg.order = 'move'
  reg.disengaging = disengaging
  reg.destX = march.x
  reg.destY = march.y
  reg.destFacing = march.facing
  reg.targetId = null
  if (march.files !== undefined && clamp(march.files, 1, reg.aliveCount) !== clamp(reg.files, 1, reg.aliveCount)) {
    const far = Math.hypot(march.x - reg.anchorX, march.y - reg.anchorY) > PLACE_RADIUS
    if (far) reformMoving(reg, march.files, travelFacing(unitDef(reg.type), march.facing, Math.atan2(march.y - reg.anchorY, march.x - reg.anchorX)))
    else reformAt(reg, march.files, march.facing)
  }
  if (march.files !== undefined) reg.destFiles = reg.files
}

function startAttack(reg: Regiment, targetId: number): void {
  reg.run=true
  if (reg.order!=='attack' || reg.targetId!==targetId) {
    const fighting=inMelee(reg)
    resetMovement(reg)
    reg.retargeting=fighting && !firesMissiles(reg) && unitDef(reg.type).category!=='chariot'
  }
  reg.order = 'attack'
  reg.targetId = targetId
}

/**
 * Where the regiment's plan currently ends: its last queued march, else the destination of its current march,
 * else where it stands. Queued orders and translate / rotate drags are laid out from here.
 */
export function planEnd(battle: Battle, reg: Regiment): { x: number; y: number; facing: number; files: number } {
  for (let i = reg.queue.length - 1; i >= 0; i--) {
    const item = reg.queue[i]
    if (item.kind === 'move') return { x: item.x, y: item.y, facing: item.facing, files: item.files ?? reg.files }
    const target = regimentById(battle, item.targetId)
    if (target) return { x: target.anchorX, y: target.anchorY, facing: Math.atan2(target.anchorY - reg.anchorY, target.anchorX - reg.anchorX), files: reg.files }
  }
  if (reg.order === 'move') return { x: reg.destX, y: reg.destY, facing: reg.destFacing, files: reg.destFiles }
  return { x: reg.anchorX, y: reg.anchorY, facing: reg.facing, files: reg.files }
}

/** Add a step to the regiment's chain; an idle regiment starts it at once. */
function enqueue(battle: Battle, reg: Regiment, item: QueuedOrder): void {
  reg.queue.push(item)
  if (reg.order === 'hold' && reg.queue.length === 1) advanceQueue(battle, reg)
}

/**
 * Start the next queued step, skipping attacks whose target is gone or routing. The simulation calls this when the
 * current march reaches its spot or the current attack target is destroyed or routs. Returns whether a step started.
 */
export function advanceQueue(battle: Battle, reg: Regiment): boolean {
  while (reg.queue.length) {
    const item = reg.queue.shift()!
    if (item.kind === 'move') { const { kind: _, ...march } = item; startMarch(reg, march); return true }
    const target = regimentById(battle, item.targetId)
    if (target && target.aliveCount > 0 && !target.routing) { startAttack(reg, item.targetId); return true }
  }
  return false
}

export function commandBehavior(battle: Battle, ids: number[], patch: Partial<Pick<Regiment, 'run' | 'fireAtWill' | 'meleeMode'>>): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'behavior',ids,patch});return}
  for (const id of ids) {
    const reg=regimentById(battle,id)
    if (!controllable(reg)) continue
    if (patch.run !== undefined) {
      reg.run=patch.run
      if (!patch.run) {
        reg.wantCharge=false
        for (const s of reg.soldiers) s.chargeArmed=false
      }
    }
    if (unitDef(reg.type).missile) {
      if (patch.fireAtWill !== undefined) reg.fireAtWill=patch.fireAtWill
      // With no ammunition left the unit stays in melee mode: going back to shooting is ignored.
      if (patch.meleeMode !== undefined && (patch.meleeMode || !outOfAmmo(reg))) setMeleeMode(reg,patch.meleeMode)
    }
  }
}

/** Melee mode on or off, as the F key sets it and as running out of ammunition forces it. Switching re-plans the
 * current order: a melee charge or a stand-off at range. */
export function setMeleeMode(reg: Regiment, on: boolean): void {
  if (reg.meleeMode === on) return
  reg.meleeMode=on
  reg.wantCharge=false;reg.engaged=false
  for (const s of reg.soldiers) s.chargeArmed=false
}

function place(value: number, max: number): number {
  return clamp(value, 3, max - 3)
}

export function commandHold(battle: Battle, ids: number[], facing?: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'hold',ids,facing});return}
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg)) continue
    reg.queue = []
    resetMovement(reg)
    reg.order = 'hold'
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.destFacing = facing ?? reg.facing
    reg.targetId = null
    reg.wantCharge = false
    reg.engaged = false
    for (const s of reg.soldiers) { s.chargeArmed = false; s.impactHold = 0 }
  }
}

/**
 * Move a selection to (x, y), keeping the regiments' relative positions. `queue` (Shift) appends the move to each
 * regiment's chain, laid out from where its plan ends instead of where it stands.
 */
export function commandMove(
  battle: Battle,
  ids: number[],
  x: number,
  y: number,
  facing: number | null,
  queue = false,
): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'move',ids,x,y,facing,queue});return}
  const regs = ids.map((id) => regimentById(battle, id)).filter(controllable)
  if (regs.length === 0) return
  const from = regs.map((reg) => queue ? planEnd(battle, reg) : { x: reg.anchorX, y: reg.anchorY, facing: reg.facing })
  const cx = from.reduce((sum, p) => sum + p.x, 0) / regs.length
  const cy = from.reduce((sum, p) => sum + p.y, 0) / regs.length
  regs.forEach((reg, i) => {
    const destX = place(x + (from[i].x - cx), MAP_WIDTH)
    const destY = place(y + (from[i].y - cy), MAP_HEIGHT)
    const dx = destX - from[i].x, dy = destY - from[i].y
    const march = { x: destX, y: destY, facing: facing ?? (Math.hypot(dx, dy) > PLACE_RADIUS ? Math.atan2(dy, dx) : from[i].facing) }
    if (queue) enqueue(battle, reg, { kind: 'move', ...march })
    else { reg.queue = []; startMarch(reg, march) }
  })
}

/** Translate / rotate drags: each regiment marches to its own spot and facing, keeping its width. */
export function commandPlace(battle: Battle, places: Placement[], queue = false): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'place',places,queue});return}
  for (const p of places) {
    const reg = regimentById(battle, p.id)
    if (!controllable(reg)) continue
    const march = { x: place(p.x, MAP_WIDTH), y: place(p.y, MAP_HEIGHT), facing: p.facing }
    if (queue) enqueue(battle, reg, { kind: 'move', ...march })
    else { reg.queue = []; startMarch(reg, march) }
  }
}

export function commandAttack(battle: Battle, ids: number[], targetId: number, queue = false): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'attack',ids,targetId,queue});return}
  const target = regimentById(battle, targetId)
  if (!target || target.aliveCount <= 0) return
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg) || reg.side === target.side) continue
    if (queue) enqueue(battle, reg, { kind: 'attack', targetId })
    else { reg.queue = []; startAttack(reg, targetId) }
  }
}

export function commandFront(
  battle: Battle,
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  queue = false,
): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'front',id,x1,y1,x2,y2,queue});return}
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const planned = planFront(reg, x1, y1, x2, y2)
  if (!planned) {
    commandMove(battle, [id], x2, y2, null, queue)
    return
  }
  if (queue) { enqueue(battle, reg, { kind: 'move', x: planned.x, y: planned.y, facing: planned.facing, files: planned.files }); return }
  reg.queue = []
  const disengaging = inMelee(reg)
  resetMovement(reg)
  reg.destFacing = planned.facing
  reg.order = 'move'
  reg.disengaging = disengaging
  reg.destX = planned.x
  reg.destY = planned.y
  const dx = reg.destX - reg.anchorX
  const dy = reg.destY - reg.anchorY
  const far = Math.hypot(dx, dy) > PLACE_RADIUS
  if (clamp(planned.files, 1, reg.aliveCount) !== clamp(reg.files, 1, reg.aliveCount)) {
    if (far) reformMoving(reg, planned.files, travelFacing(unitDef(reg.type), planned.facing, Math.atan2(dy, dx)))
    else reformAt(reg, planned.files, planned.facing)
  }
  reg.destFiles = reg.files
  reg.targetId = null
  reg.wantCharge = false
  reg.engaged = false
}

export function beginWidth(battle: Battle, id: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'beginWidth',id});return}
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const rightX = Math.sin(reg.facing)
  const rightY = -Math.cos(reg.facing)
  const alive = reg.soldiers.filter((soldier) => soldier.alive)
  alive.sort((a, b) => a.x * rightX + a.y * rightY - (b.x * rightX + b.y * rightY))
  battle.widthOrder.set(id, alive.map((soldier) => soldier.id))
}

export function commandWidth(battle: Battle, id: number, files: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'width',id,files});return}
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const ids = battle.widthOrder.get(id)
  const ordered = ids
    ?.map((soldierId) => battle.soldierById.get(soldierId))
    .filter((soldier): soldier is NonNullable<typeof soldier> => !!soldier && soldier.alive)
  assignFormation(reg, files, ordered)
  reg.destFiles = reg.files
}

export function endWidth(battle: Battle, id: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'endWidth',id});return}
  battle.widthOrder.delete(id)
}

export function filesForLateral(spacing: number, lateral: number, widest: number, narrowest = 1): number {
  return clamp(Math.round((2 * Math.abs(lateral)) / spacing) + 1, Math.min(narrowest, widest), Math.max(1, widest))
}

/** The most files this regiment can stand in right now. */
export function widestFiles(reg: Regiment): number {
  const limits = regimentLimits(reg)
  return fileCount(limits, limits.maxFiles, reg.aliveCount)
}

/** The fewest files this regiment can stand in right now without its column running deeper than its type allows. */
export function narrowestFiles(reg: Regiment): number {
  return fileCount(regimentLimits(reg), 1, reg.aliveCount)
}

export interface FrontPreview {
  x: number
  y: number
  facing: number
  files: number
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The drag starts at the formation's left. The line stops at the widest rank the unit can stand in. */
export function clampFrontLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  spacing: number,
  widest: number,
): { x1: number; y1: number; x2: number; y2: number; length: number } {
  const len = Math.hypot(x2 - x1, y2 - y1)
  const maxLen = Math.max(0, widest - 1) * spacing
  if (len < 1e-4) return { x1, y1, x2: x1, y2: y1, length: 0 }
  const use = Math.min(len, maxLen)
  return {
    x1,
    y1,
    x2: x1 + ((x2 - x1) / len) * use,
    y2: y1 + ((y2 - y1) / len) * use,
    length: use,
  }
}

function planFront(reg: Regiment, x1: number, y1: number, x2: number, y2: number): FrontPreview | null {
  const def = unitDef(reg.type)
  if (reg.aliveCount === 1 && Math.hypot(x2-x1,y2-y1) >= 0.8) {
    const facing = Math.atan2(x2-x1, -(y2-y1))
    const fitted = fitOnMap(reg,x1,y1,facing,1)
    return { ...fitted, files:1, facing, x1:fitted.x, y1:fitted.y, x2:fitted.x, y2:fitted.y }
  }
  const widest = widestFiles(reg)
  const line = clampFrontLine(x1, y1, x2, y2, def.spacing, widest)
  if (line.length < 0.8) return null
  const files = clamp(Math.floor(line.length / def.spacing + 1e-4) + 1, narrowestFiles(reg), widest)
  const width = (files - 1) * def.spacing
  const alongX = (line.x2 - line.x1) / line.length
  const alongY = (line.y2 - line.y1) / line.length
  const anchorX = line.x1 + alongX * (width / 2)
  const anchorY = line.y1 + alongY * (width / 2)
  const dragX = x2 - x1
  const dragY = y2 - y1
  const shown = Math.max(line.length, width)
  const facing = Math.atan2(dragX, -dragY)
  const fitted = fitOnMap(reg, anchorX, anchorY, facing, files)
  return {
    x: fitted.x,
    y: fitted.y,
    facing,
    files,
    x1: fitted.x - alongX * width / 2,
    y1: fitted.y - alongY * width / 2,
    x2: fitted.x + alongX * (shown - width / 2),
    y2: fitted.y + alongY * (shown - width / 2),
  }
}

export function previewFront(
  battle: Battle,
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): FrontPreview | null {
  const reg = regimentById(battle, id)
  if (!reg) return null
  return planFront(reg, x1, y1, x2, y2)
}

/** Preview and execution share the same allocator; units retain their left-to-right order. */
export function previewGroupFront(battle: Battle, ids: number[], x1: number, y1: number, x2: number, y2: number): (FrontPreview & { id: number })[] {
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length < 0.8) return []
  const regs = [...new Set(ids)].map(id => regimentById(battle, id)).filter(controllable)
  if (regs.length === 1) {
    const plan = planFront(regs[0], x1, y1, x2, y2)
    return plan ? [{ ...plan, id: regs[0].id }] : []
  }
  const ax = (x2 - x1) / length, ay = (y2 - y1) / length
  const facing = Math.atan2(ax, -ay)
  regs.sort((a, b) => (a.anchorX - b.anchorX) * ax + (a.anchorY - b.anchorY) * ay || a.id - b.id)
  const gap = 2
  const files = regs.map(narrowestFiles)
  const used = () => regs.reduce((sum, reg, i) => sum + (files[i] - 1) * unitDef(reg.type).spacing + 2 * unitDef(reg.type).radius, gap * Math.max(0, regs.length - 1))
  // Fill the requested width in small increments, balancing relative expansion.
  while (true) {
    const candidates = regs.map((reg, i) => ({ reg, i })).filter(({ reg, i }) => files[i] < widestFiles(reg) && used() + unitDef(reg.type).spacing <= length)
    candidates.sort((a, b) => (files[a.i] - narrowestFiles(a.reg)) / Math.max(1, widestFiles(a.reg) - narrowestFiles(a.reg)) - (files[b.i] - narrowestFiles(b.reg)) / Math.max(1, widestFiles(b.reg) - narrowestFiles(b.reg)))
    if (!candidates.length) break
    files[candidates[0].i]++
  }
  const plans = () => {
    let cursor = 0
    return regs.map((reg, i) => {
      const def = unitDef(reg.type), width = (files[i] - 1) * def.spacing
      const center = cursor + def.radius + width / 2
      cursor += width + 2 * def.radius + gap
      return { id: reg.id, x: x1 + ax * center, y: y1 + ay * center, facing, files: files[i], x1: x1 + ax * (center - width / 2), y1: y1 + ay * (center - width / 2), x2: x1 + ax * (center + width / 2), y2: y1 + ay * (center + width / 2) }
    })
  }
  let result = plans()
  let bounds: { minX: number; minY: number; maxX: number; maxY: number }
  while (true) {
    const points = result.flatMap((p, i) => {
      const def = unitDef(regs[i].type)
      const half = (p.files - 1) * def.spacing / 2 + def.radius + 0.7
      const depth = (Math.ceil(regs[i].aliveCount / p.files) - 1) * def.rankSpacing + def.radius + 0.7
      return [-half, half].flatMap(lateral => [def.radius + 0.7, -depth].map(ahead => ({ x: p.x + ax * lateral - ay * ahead, y: p.y + ay * lateral + ax * ahead })))
    })
    bounds = { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) }
    if (bounds.maxX - bounds.minX <= MAP_WIDTH - 6 && bounds.maxY - bounds.minY <= MAP_HEIGHT - 6) break
    const i = regs.findIndex((reg, i) => files[i] > narrowestFiles(reg))
    if (i < 0) return []
    files[i]--
    result = plans()
  }
  const dx = Math.max(3 - bounds.minX, Math.min(0, MAP_WIDTH - 3 - bounds.maxX))
  const dy = Math.max(3 - bounds.minY, Math.min(0, MAP_HEIGHT - 3 - bounds.maxY))
  return result.map(p => ({ ...p, x: p.x + dx, y: p.y + dy, x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy }))
}

export function commandGroupFront(battle: Battle, ids: number[], x1: number, y1: number, x2: number, y2: number, queue = false): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'groupFront',ids,x1,y1,x2,y2,queue});return}
  const plans = previewGroupFront(battle, ids, x1, y1, x2, y2)
  if (ids.length === 1) { commandFront(battle, ids[0], x1, y1, x2, y2, queue); return }
  for (const p of plans) {
    const reg = regimentById(battle, p.id)!
    if (queue) { enqueue(battle, reg, { kind: 'move', x: p.x, y: p.y, facing: p.facing, files: p.files }); continue }
    reg.queue = []
    const disengaging = inMelee(reg)
    resetMovement(reg)
    const far = Math.hypot(p.x - reg.anchorX, p.y - reg.anchorY) > PLACE_RADIUS
    if (far) reformMoving(reg, p.files, travelFacing(unitDef(reg.type), p.facing, Math.atan2(p.y - reg.anchorY, p.x - reg.anchorX)))
    else reformAt(reg, p.files, p.facing)
    Object.assign(reg, { order: 'move', disengaging, destX: p.x, destY: p.y, destFacing: p.facing, destFiles: p.files, targetId: null, wantCharge: false, engaged: false })
  }
}
