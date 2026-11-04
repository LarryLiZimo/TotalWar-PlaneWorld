import { PLACE_RADIUS, assignFormation, fileCount, reformAt, reformMoving, travelFacing } from './formation'
import { clamp } from './math'
import type { Battle, Regiment } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { unitDef } from './units'

function controllable(reg: Regiment | undefined): reg is Regiment {
  return !!reg && reg.aliveCount > 0 && !reg.routing
}

export function regimentById(battle: Battle, id: number): Regiment | undefined {
  return battle.regiments.find((reg) => reg.id === id)
}

function place(value: number, max: number): number {
  return clamp(value, 3, max - 3)
}

export function commandHold(battle: Battle, ids: number[], facing?: number): void {
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg)) continue
    reg.order = 'hold'
    reg.destX = reg.anchorX
    reg.destY = reg.anchorY
    reg.facingLocked = true
    reg.destFacing = facing ?? reg.facing
    reg.targetId = null
    reg.wantCharge = false
  }
}

export function commandMove(
  battle: Battle,
  ids: number[],
  x: number,
  y: number,
  facing: number | null,
): void {
  const regs = ids.map((id) => regimentById(battle, id)).filter(controllable)
  if (regs.length === 0) return
  const cx = regs.reduce((sum, reg) => sum + reg.anchorX, 0) / regs.length
  const cy = regs.reduce((sum, reg) => sum + reg.anchorY, 0) / regs.length
  for (const reg of regs) {
    reg.order = 'move'
    reg.destX = place(x + (reg.anchorX - cx), MAP_WIDTH)
    reg.destY = place(y + (reg.anchorY - cy), MAP_HEIGHT)
    reg.targetId = null
    reg.wantCharge = false
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
  const target = regimentById(battle, targetId)
  if (!target || target.aliveCount <= 0) return
  for (const id of ids) {
    const reg = regimentById(battle, id)
    if (!controllable(reg) || reg.side === target.side) continue
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
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const planned = planFront(reg, x1, y1, x2, y2)
  if (!planned) {
    commandMove(battle, [id], x2, y2, null)
    return
  }
  reg.destFacing = planned.facing
  reg.order = 'move'
  reg.destX = place(planned.x, MAP_WIDTH)
  reg.destY = place(planned.y, MAP_HEIGHT)
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
  const reg = regimentById(battle, id)
  if (!controllable(reg)) return
  const rightX = Math.sin(reg.facing)
  const rightY = -Math.cos(reg.facing)
  const alive = reg.soldiers.filter((soldier) => soldier.alive)
  alive.sort((a, b) => a.x * rightX + a.y * rightY - (b.x * rightX + b.y * rightY))
  battle.widthOrder.set(id, alive.map((soldier) => soldier.id))
}

export function commandWidth(battle: Battle, id: number, files: number): void {
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
  battle.widthOrder.delete(id)
}

export function filesForLateral(spacing: number, lateral: number, widest: number): number {
  return clamp(Math.round((2 * Math.abs(lateral)) / spacing) + 1, 1, Math.max(1, widest))
}

/** The most files this regiment can stand in right now. */
export function widestFiles(reg: Regiment): number {
  const def = unitDef(reg.type)
  return fileCount(def, def.maxFiles, reg.aliveCount)
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
  const widest = widestFiles(reg)
  const line = clampFrontLine(x1, y1, x2, y2, def.spacing, widest)
  if (line.length < 0.8) return null
  const files = clamp(Math.floor(line.length / def.spacing + 1e-4) + 1, 1, widest)
  const width = (files - 1) * def.spacing
  const alongX = (line.x2 - line.x1) / line.length
  const alongY = (line.y2 - line.y1) / line.length
  const anchorX = line.x1 + alongX * (width / 2)
  const anchorY = line.y1 + alongY * (width / 2)
  const dragX = x2 - x1
  const dragY = y2 - y1
  return {
    x: anchorX,
    y: anchorY,
    facing: Math.atan2(dragX, -dragY),
    files,
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
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
