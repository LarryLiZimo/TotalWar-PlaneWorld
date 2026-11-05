import { PLACE_RADIUS, assignFormation, fileCount, fitOnMap, reformAt, reformMoving, travelFacing } from './formation'
import { clamp } from './math'
import type { Battle, Regiment } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { unitDef } from './units'

function controllable(reg: Regiment | undefined): reg is Regiment {
  return !!reg && reg.aliveCount > 0 && !reg.routing
}

/** A fresh order runs by default and replaces the previous automatic movement. */
function resetMovement(reg: Regiment): void {
  reg.run=true
  reg.wantCharge=false
  reg.engaged=false
  reg.contactLock=0
  reg.retargeting=false
  reg.attackCommitted=false
  reg.plow=0
  for (const s of reg.soldiers) {
    s.chargeArmed=false
    s.swing=null
    s.plowLeft=0
    s.avoidSide=0;s.blockedTime=0
    s.bypass=null
    s.cartPath=null
  }
}

export function regimentById(battle: Battle, id: number): Regiment | undefined {
  return battle.regiments.find((reg) => reg.id === id)
}

export function commandBehavior(battle: Battle, ids: number[], patch: Partial<Pick<Regiment, 'run' | 'fireAtWill' | 'skirmish'>>): void {
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
      if (patch.skirmish !== undefined) reg.skirmish=patch.skirmish
    }
  }
}

function place(value: number, max: number): number {
  return clamp(value, 3, max - 3)
}

export function commandHold(battle: Battle, ids: number[], facing?: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'hold',ids,facing});return}
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg)) continue
    resetMovement(reg)
    reg.order = 'hold'
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.facingLocked = true
    reg.destFacing = facing ?? reg.facing
    reg.targetId = null
    reg.wantCharge = false
    reg.engaged = false
    reg.contactLock = 0
    for (const s of reg.soldiers) s.chargeArmed = false
  }
}

export function commandMove(
  battle: Battle,
  ids: number[],
  x: number,
  y: number,
  facing: number | null,
): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'move',ids,x,y,facing});return}
  const regs = ids.map((id) => regimentById(battle, id)).filter(controllable)
  if (regs.length === 0) return
  const cx = regs.reduce((sum, reg) => sum + reg.anchorX, 0) / regs.length
  const cy = regs.reduce((sum, reg) => sum + reg.anchorY, 0) / regs.length
  for (const reg of regs) {
    resetMovement(reg)
    reg.order = 'move'
    reg.destX = place(x + (reg.anchorX - cx), MAP_WIDTH)
    reg.destY = place(y + (reg.anchorY - cy), MAP_HEIGHT)
    reg.targetId = null
    reg.wantCharge = false
    reg.engaged = false
    reg.contactLock = 0
    for (const s of reg.soldiers) s.chargeArmed = false
    if (facing === null) {
      reg.facingLocked = false
      const dx = reg.destX - reg.anchorX
      const dy = reg.destY - reg.anchorY
      reg.destFacing = Math.hypot(dx, dy) > PLACE_RADIUS ? Math.atan2(dy, dx) : reg.facing
    } else {
      reg.facingLocked = true
      reg.destFacing = facing
    }
  }
}

export function commandAttack(battle: Battle, ids: number[], targetId: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'attack',ids,targetId});return}
  const target = regimentById(battle, targetId)
  if (!target || target.aliveCount <= 0) return
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg) || reg.side === target.side) continue
    reg.run=true
    if (reg.order!=='attack' || reg.targetId!==targetId) {
      const inMelee=reg.engaged || reg.inContact || reg.retargeting
      resetMovement(reg)
      reg.retargeting=inMelee && !unitDef(reg.type).missile && reg.type!=='chariot'
    }
    reg.order = 'attack'
    reg.targetId = targetId
    reg.facingLocked = true
  }
}

export function commandFront(
  battle: Battle,
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'front',id,x1,y1,x2,y2});return}
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const planned = planFront(reg, x1, y1, x2, y2)
  if (!planned) {
    commandMove(battle, [id], x2, y2, null)
    return
  }
  resetMovement(reg)
  reg.destFacing = planned.facing
  reg.order = 'move'
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
  reg.facingLocked = true
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
  const def = unitDef(reg.type)
  return fileCount(def, def.maxFiles, reg.aliveCount)
}

/** The fewest files this regiment can stand in right now without its column running deeper than its type allows. */
export function narrowestFiles(reg: Regiment): number {
  return fileCount(unitDef(reg.type), 1, reg.aliveCount)
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

export function commandGroupFront(battle: Battle, ids: number[], x1: number, y1: number, x2: number, y2: number): void {
  if(battle.sendCommand) {battle.sendCommand({kind:'groupFront',ids,x1,y1,x2,y2});return}
  const plans = previewGroupFront(battle, ids, x1, y1, x2, y2)
  if (ids.length === 1) { commandFront(battle, ids[0], x1, y1, x2, y2); return }
  for (const p of plans) {
    const reg = regimentById(battle, p.id)!
    resetMovement(reg)
    const far = Math.hypot(p.x - reg.anchorX, p.y - reg.anchorY) > PLACE_RADIUS
    if (far) reformMoving(reg, p.files, travelFacing(unitDef(reg.type), p.facing, Math.atan2(p.y - reg.anchorY, p.x - reg.anchorX)))
    else reformAt(reg, p.files, p.facing)
    Object.assign(reg, { order: 'move', destX: p.x, destY: p.y, destFacing: p.facing, destFiles: p.files, facingLocked: true, targetId: null, wantCharge: false, engaged: false })
  }
}
