import { angDiff, clamp, forward, right } from './math'
import type { Battle, Regiment, Soldier, UnitDef } from './types'
import { unitDef } from './units'

export interface Vec2 {
  x: number
  y: number
}

export function slotOf(reg: Regiment, def: UnitDef, file: number, rank: number, centerIndex = -1): Vec2 {
  let lx = (file - (reg.files - 1) / 2) * def.spacing
  if (centerIndex >= 0) {
    let count = 0
    for (const soldier of reg.soldiers) {
      if (soldier.alive && soldier.centerIndex >= 0 && soldier.rank === rank) count += 1
    }
    const mates = Math.max(1, count)
    lx = (centerIndex - (mates - 1) / 2) * def.spacing
  }
  const back = rank * def.rankSpacing
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  return {
    x: reg.anchorX + rgt.x * lx - fwd.x * back,
    y: reg.anchorY + rgt.y * lx - fwd.y * back,
  }
}

export function shapePoints(s: Pick<Soldier, 'x' | 'y' | 'facing'>, def: UnitDef): Vec2[] {
  if (def.shape !== 'capsule') return [{ x: s.x, y: s.y }]
  const fwd = forward(s.facing)
  const half = Math.max(0, (def.length - def.radius * 2) / 2)
  return [
    { x: s.x - fwd.x * half, y: s.y - fwd.y * half },
    { x: s.x, y: s.y },
    { x: s.x + fwd.x * half, y: s.y + fwd.y * half },
  ]
}

/** Positive when separated, negative when overlapping. */
export function gapBetween(a: Soldier, aDef: UnitDef, b: Soldier, bDef: UnitDef): number {
  if (aDef.shape === 'circle' && bDef.shape === 'circle') {
    return Math.hypot(a.x - b.x, a.y - b.y) - aDef.radius - bDef.radius
  }
  const as = shapePoints(a, aDef)
  const bs = shapePoints(b, bDef)
  let best = Infinity
  for (const p of as) {
    for (const q of bs) {
      const d = Math.hypot(p.x - q.x, p.y - q.y) - aDef.radius - bDef.radius
      if (d < best) best = d
    }
  }
  return best
}

export function isBracing(reg: Regiment, def: UnitDef, towardX: number, towardY: number): boolean {
  if (!def.canBrace || reg.routing) return false
  if (reg.aliveCount <= reg.initial * 0.5) return false
  if (reg.stationaryTime < 1.5) return false
  const to = Math.atan2(towardY - reg.anchorY, towardX - reg.anchorX)
  return Math.abs(angDiff(reg.facing, to)) <= (35 * Math.PI) / 180
}

export function maxRankOf(reg: Regiment): number {
  let maxRank = 0
  for (const soldier of reg.soldiers) {
    if (soldier.alive) maxRank = Math.max(maxRank, soldier.rank)
  }
  return maxRank
}

interface BodyFrame {
  minRight: number
  maxRight: number
  minForward: number
  maxForward: number
}

function bodyFrame(reg: Regiment, def: UnitDef): BodyFrame | null {
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  let minRight = Infinity
  let maxRight = -Infinity
  let minForward = Infinity
  let maxForward = -Infinity
  let count = 0
  for (const soldier of reg.soldiers) {
    if (!soldier.alive) continue
    const localRight = soldier.x * rgt.x + soldier.y * rgt.y
    const localForward = soldier.x * fwd.x + soldier.y * fwd.y
    minRight = Math.min(minRight, localRight)
    maxRight = Math.max(maxRight, localRight)
    minForward = Math.min(minForward, localForward)
    maxForward = Math.max(maxForward, localForward)
    count += 1
  }
  if (count === 0) return null
  const pad = def.radius + 0.45
  return {
    minRight: minRight - pad,
    maxRight: maxRight + pad,
    minForward: minForward - pad,
    maxForward: maxForward + pad,
  }
}

function frameCorner(reg: Regiment, localRight: number, localForward: number): Vec2 {
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  return {
    x: rgt.x * localRight + fwd.x * localForward,
    y: rgt.y * localRight + fwd.y * localForward,
  }
}

export function formationCorners(reg: Regiment, def: UnitDef): Vec2[] {
  const frame = bodyFrame(reg, def)
  if (!frame) {
    const halfW = ((Math.max(1, reg.files) - 1) * def.spacing) / 2 + def.radius
    const depth = maxRankOf(reg) * def.rankSpacing + def.radius
    const fwd = forward(reg.facing)
    const rgt = right(reg.facing)
    const corner = (lx: number, ly: number): Vec2 => ({
      x: reg.anchorX + rgt.x * lx + fwd.x * ly,
      y: reg.anchorY + rgt.y * lx + fwd.y * ly,
    })
    return [
      corner(-halfW, def.radius + 0.3),
      corner(halfW, def.radius + 0.3),
      corner(halfW, -depth),
      corner(-halfW, -depth),
    ]
  }
  return [
    frameCorner(reg, frame.minRight, frame.maxForward),
    frameCorner(reg, frame.maxRight, frame.maxForward),
    frameCorner(reg, frame.maxRight, frame.minForward),
    frameCorner(reg, frame.minRight, frame.minForward),
  ]
}

export function flankHandles(reg: Regiment, def: UnitDef): [Vec2, Vec2] {
  const frame = bodyFrame(reg, def)
  if (!frame) {
    const rgt = right(reg.facing)
    const half = ((Math.max(1, reg.files) - 1) * def.spacing) / 2
    return [
      { x: reg.anchorX - rgt.x * half, y: reg.anchorY - rgt.y * half },
      { x: reg.anchorX + rgt.x * half, y: reg.anchorY + rgt.y * half },
    ]
  }
  return [
    frameCorner(reg, frame.minRight, frame.maxForward),
    frameCorner(reg, frame.maxRight, frame.maxForward),
  ]
}

export function pointInFormation(reg: Regiment, x: number, y: number): boolean {
  const def = unitDef(reg.type)
  const frame = bodyFrame(reg, def)
  if (!frame) return false
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  const localRight = x * rgt.x + y * rgt.y
  const localForward = x * fwd.x + y * fwd.y
  return (
    localRight >= frame.minRight &&
    localRight <= frame.maxRight &&
    localForward >= frame.minForward &&
    localForward <= frame.maxForward
  )
}

export function regimentAt(battle: Battle, x: number, y: number): Regiment | null {
  let best: Regiment | null = null
  let bestD = Infinity
  for (const reg of battle.regiments) {
    if (reg.aliveCount <= 0) continue
    if (!pointInFormation(reg, x, y)) continue
    const d = Math.hypot(reg.anchorX - x, reg.anchorY - y)
    if (d < bestD) {
      best = reg
      bestD = d
    }
  }
  if (best) return best
  for (const reg of battle.regiments) {
    if (reg.aliveCount <= 0) continue
    const def = unitDef(reg.type)
    for (const soldier of reg.soldiers) {
      if (!soldier.alive) continue
      const d = Math.hypot(soldier.x - x, soldier.y - y)
      if (d < def.radius + 0.8 && d < bestD) {
        best = reg
        bestD = d
      }
    }
  }
  return best
}

function formationSlots(
  reg: Regiment,
  def: UnitDef,
  files: number,
  count: number,
): { file: number; rank: number; centerIndex: number; x: number; y: number }[] {
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  const place = (lx: number, back: number) => ({
    x: reg.anchorX + rgt.x * lx - fwd.x * back,
    y: reg.anchorY + rgt.y * lx - fwd.y * back,
  })
  const remainder = count % files
  const fullCount = remainder === 0 ? count : count - remainder
  const fullRanks = fullCount / files
  const slots: { file: number; rank: number; centerIndex: number; x: number; y: number }[] = []
  for (let index = 0; index < fullCount; index++) {
    const file = index % files
    const rank = Math.floor(index / files)
    const at = place((file - (files - 1) / 2) * def.spacing, rank * def.rankSpacing)
    slots.push({ file, rank, centerIndex: -1, ...at })
  }
  for (let index = 0; index < remainder; index++) {
    const at = place((index - (remainder - 1) / 2) * def.spacing, fullRanks * def.rankSpacing)
    slots.push({ file: index, rank: fullRanks, centerIndex: index, ...at })
  }
  return slots
}

export function assignFormation(reg: Regiment, files: number, ordered?: Soldier[]): void {
  const alive = (ordered ?? reg.soldiers.filter((soldier) => soldier.alive)).filter((soldier) => soldier.alive)
  if (alive.length === 0) {
    reg.files = 1
    return
  }
  files = clamp(Math.round(files), 1, alive.length)
  reg.files = files
  const def = unitDef(reg.type)
  const slots = formationSlots(reg, def, files, alive.length)
  const cost = alive.map((soldier) => slots.map((slot) => (soldier.x - slot.x) ** 2 + (soldier.y - slot.y) ** 2))
  const pick = cheapestAssignment(cost)
  alive.forEach((soldier, index) => {
    const slot = slots[pick[index]]
    soldier.file = slot.file
    soldier.rank = slot.rank
    soldier.centerIndex = slot.centerIndex
  })
}

/**
 * Hungarian method on a square cost matrix. With squared distances as the cost, no two straight paths
 * from soldiers to their chosen slots cross each other.
 */
function cheapestAssignment(cost: number[][]): number[] {
  const n = cost.length
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const owner = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let row = 1; row <= n; row++) {
    owner[0] = row
    let col0 = 0
    const minv = new Float64Array(n + 1).fill(Infinity)
    const used = new Uint8Array(n + 1)
    do {
      used[col0] = 1
      const row0 = owner[col0]
      let delta = Infinity
      let col1 = 0
      for (let col = 1; col <= n; col++) {
        if (used[col]) continue
        const reduced = cost[row0 - 1][col - 1] - u[row0] - v[col]
        if (reduced < minv[col]) {
          minv[col] = reduced
          way[col] = col0
        }
        if (minv[col] < delta) {
          delta = minv[col]
          col1 = col
        }
      }
      for (let col = 0; col <= n; col++) {
        if (used[col]) {
          u[owner[col]] += delta
          v[col] -= delta
        } else {
          minv[col] -= delta
        }
      }
      col0 = col1
    } while (owner[col0] !== 0)
    do {
      const col1 = way[col0]
      owner[col0] = owner[col1]
      col0 = col1
    } while (col0 !== 0)
  }
  const pick = new Array<number>(n)
  for (let col = 1; col <= n; col++) pick[owner[col] - 1] = col - 1
  return pick
}

/** Within this distance the regiment stops marching as a block and every soldier walks to his final spot. */
export const PLACE_RADIUS = 8

/**
 * Lay the regiment out with a new facing and width. Soldiers are matched to slots as if the new shape
 * stood on top of where they are now, so nobody crosses the block; the frame then moves to (x, y).
 * Without (x, y) the block turns about its own center.
 */
export function reformAt(reg: Regiment, files: number, facing: number, x?: number, y?: number): void {
  const alive = reg.soldiers.filter((soldier) => soldier.alive)
  if (alive.length === 0) return
  const def = unitDef(reg.type)
  let cx = 0
  let cy = 0
  for (const soldier of alive) {
    cx += soldier.x
    cy += soldier.y
  }
  cx /= alive.length
  cy /= alive.length
  const width = clamp(Math.round(files), 1, alive.length)
  const depth = (Math.ceil(alive.length / width) - 1) * def.rankSpacing
  const fwd = forward(facing)
  reg.facing = facing
  reg.anchorX = cx + (fwd.x * depth) / 2
  reg.anchorY = cy + (fwd.y * depth) / 2
  assignFormation(reg, width)
  if (x !== undefined && y !== undefined) {
    reg.anchorX = x
    reg.anchorY = y
  }
}

export function compactRanks(reg: Regiment): void {
  const byFile = new Map<number, Soldier[]>()
  const centered: Soldier[] = []
  for (const soldier of reg.soldiers) {
    if (!soldier.alive) continue
    if (soldier.centerIndex >= 0) {
      centered.push(soldier)
      continue
    }
    const list = byFile.get(soldier.file)
    if (list) list.push(soldier)
    else byFile.set(soldier.file, [soldier])
  }
  let deepest = 0
  for (const list of byFile.values()) {
    list.sort((a, b) => a.rank - b.rank)
    list.forEach((soldier, rank) => {
      soldier.rank = rank
    })
    deepest = Math.max(deepest, list.length)
  }
  centered.sort((a, b) => a.centerIndex - b.centerIndex)
  centered.forEach((soldier, index) => {
    soldier.centerIndex = index
    soldier.rank = deepest
  })
}

export function centroid(regs: Regiment[]): Vec2 {
  let x = 0
  let y = 0
  let n = 0
  for (const reg of regs) {
    if (reg.aliveCount <= 0) continue
    x += reg.anchorX
    y += reg.anchorY
    n++
  }
  if (n === 0) return { x: 0, y: 0 }
  return { x: x / n, y: y / n }
}

export function enemyCentroid(battle: Battle, side: Regiment['side']): Vec2 {
  return centroid(battle.regiments.filter((reg) => reg.side !== side && reg.aliveCount > 0))
}
