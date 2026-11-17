import { angDiff, clamp, forward, right } from './math'
import type { Battle, Regiment, Soldier, UnitDef } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'
import { designModels, unitDef } from './units'
import { MECHANICS } from './mechanics'

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

/** Weapon/visible-body gap, independent of the slimmer movement collider. */
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

export function isBracing(reg: Regiment, def: UnitDef, towardX: number, towardY: number, soldier?: Soldier): boolean {
  if (!def.canBrace || reg.routing) return false
  if (soldier) {
    if (!soldier.alive || soldier.down > 0 || soldier.braceTime < MECHANICS.braceTime || soldier.speed > 0.25) return false
    return beforeFront(reg,def,towardX,towardY) && Math.abs(angDiff(soldier.facing, Math.atan2(towardY-soldier.y,towardX-soldier.x))) <= Math.PI / 3
  }
  if (reg.stationaryTime < MECHANICS.braceTime) return false
  const standing = reg.soldiers.filter(s => s.alive && s.down <= 0 && s.speed < 0.25).length
  return standing >= reg.aliveCount * MECHANICS.braceStillFraction && beforeFront(reg, def, towardX, towardY)
}

/**
 * Whether a man holds his ground as a braced body against something at (towardX, towardY) (RULES 四.4, 四.7): his block
 * has stood still for braceTime, he is not walking, and he faces it within 60°. Unlike isBracing this asks neither where
 * the block's front is nor whether he himself was jostled: the men inside a standing block brace against a body that
 * has broken in from the front even while comrades are thrown against them, but not against one that comes at their
 * flank or back. It sets their collision and impact mass; charge defence and reflection still need isBracing.
 */
export function bracedAgainst(reg: Regiment, def: UnitDef, soldier: Soldier, towardX: number, towardY: number): boolean {
  if (!def.canBrace || reg.routing || !soldier.alive || soldier.down > 0 || reg.stationaryTime < MECHANICS.braceTime || soldier.speed > 0.25) return false
  return Math.abs(angDiff(soldier.facing, Math.atan2(towardY - soldier.y, towardX - soldier.x))) <= Math.PI / 3
}

export function chargeDefended(reg: Regiment, def: UnitDef, soldier: Soldier, attacker: UnitDef, x: number, y: number): boolean {
  return (def.chargeDefense === 'all' || (def.chargeDefense === 'large' && attacker.large)) && isBracing(reg,def,x,y,soldier)
}

/** Impact mass factor of a braced man (RULES 四.7): ×1 for a single rank, rising linearly to impactBraceMax at eight ranks. */
export function impactBraceMultiplier(reg: Regiment): number {
  const depth = Math.ceil(reg.aliveCount / Math.max(1, reg.files))
  return 1 + (MECHANICS.impactBraceMax - 1) * clamp((depth - 1) / 7, 0, 1)
}

/** Local interpolation between one-rank and eight-rank support; coefficients are tunable. */
export function bracingMassMultiplier(reg: Regiment): number {
  const depth = Math.ceil(reg.aliveCount / Math.max(1, reg.files))
  return 1 + 3 * clamp((depth - 1) / 7, 0, 1)
}

/**
 * Whether a point is out ahead of the block's front rank: across its width, widening 35° to each side.
 * Something that has already broken past the front rank is in among the men and meets no brace.
 */
function beforeFront(reg: Regiment, def: UnitDef, x: number, y: number): boolean {
  const fwd = forward(reg.facing)
  const dx = x - reg.anchorX
  const dy = y - reg.anchorY
  const ahead = dx * fwd.x + dy * fwd.y
  if (ahead < 0) return false
  const side = Math.abs(dx * fwd.y - dy * fwd.x)
  const half = ((reg.files - 1) * def.spacing) / 2 + def.radius
  return side <= half + ahead * Math.tan((35 * Math.PI) / 180)
}

export function maxRankOf(reg: Regiment): number {
  let maxRank = 0
  for (const soldier of reg.soldiers) {
    if (soldier.alive) maxRank = Math.max(maxRank, soldier.rank)
  }
  return maxRank
}

export function massCenter(reg: Regiment): Vec2 {
  let x = 0
  let y = 0
  let count = 0
  for (const soldier of reg.soldiers) {
    if (!soldier.alive) continue
    x += soldier.x
    y += soldier.y
    count += 1
  }
  if (count === 0) return { x: reg.anchorX, y: reg.anchorY }
  return { x: x / count, y: y / count }
}

function nominalHalf(reg: Regiment, def: UnitDef): { halfW: number; halfD: number } {
  const halfW = ((Math.max(1, reg.files) - 1) * def.spacing) / 2 + def.radius + 0.7
  const halfD = (maxRankOf(reg) * def.rankSpacing) / 2 + def.radius + 0.7
  return { halfW, halfD: Math.max(halfD, def.radius + 0.7) }
}

export function formationCorners(reg: Regiment, def: UnitDef): Vec2[] {
  const center = massCenter(reg)
  const { halfW, halfD } = nominalHalf(reg, def)
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  const corner = (lx: number, ly: number): Vec2 => ({
    x: center.x + rgt.x * lx + fwd.x * ly,
    y: center.y + rgt.y * lx + fwd.y * ly,
  })
  return [corner(-halfW, halfD), corner(halfW, halfD), corner(halfW, -halfD), corner(-halfW, -halfD)]
}

export function flankHandles(reg: Regiment, def: UnitDef): [Vec2, Vec2] {
  const center = massCenter(reg)
  const { halfW, halfD } = nominalHalf(reg, def)
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  const at = (lx: number): Vec2 => ({
    x: center.x + rgt.x * lx + fwd.x * halfD,
    y: center.y + rgt.y * lx + fwd.y * halfD,
  })
  return [at(-halfW), at(halfW)]
}

export function pointInFormation(reg: Regiment, x: number, y: number): boolean {
  const def = unitDef(reg.type)
  const center = massCenter(reg)
  const { halfW, halfD } = nominalHalf(reg, def)
  const fwd = forward(reg.facing)
  const rgt = right(reg.facing)
  const dx = x - center.x
  const dy = y - center.y
  const localRight = dx * rgt.x + dy * rgt.y
  const localForward = dx * fwd.x + dy * fwd.y
  return Math.abs(localRight) <= halfW && Math.abs(localForward) <= halfD
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

/**
 * Files a unit of `alive` men can actually stand in: no wider than its type allows or than it has men,
 * and no narrower than its type's deepest column allows.
 */
/** Widest (files) and deepest (ranks) a regiment may stand. */
export interface FormationLimits { maxFiles: number; maxRanks: number }

/**
 * The unit values are tuned for the 4x army scale. A larger regiment scales both by √(models / 4x models), so the
 * same range of width-to-depth ratios stays open (an 8x infantry block is not forced six ranks deep); smaller ones
 * keep the 4x values.
 */
export function formationLimits(def: UnitDef, deployed: number): FormationLimits {
  const k = Math.sqrt(Math.max(1, deployed / designModels(def)))
  return { maxFiles: Math.max(1, Math.round(def.maxFiles * k)), maxRanks: Math.max(1, Math.round(def.maxRanks * k)) }
}

export function regimentLimits(reg: Regiment): FormationLimits {
  return formationLimits(unitDef(reg.type), reg.initial)
}

export function fileCount(limits: FormationLimits, files: number, alive: number): number {
  const widest = Math.max(1, Math.min(alive, limits.maxFiles))
  const narrowest = Math.min(widest, Math.max(1, Math.ceil(alive / limits.maxRanks)))
  return clamp(Math.round(files), narrowest, widest)
}

export function assignFormation(reg: Regiment, files: number, ordered?: Soldier[]): void {
  const alive = (ordered ?? reg.soldiers.filter((soldier) => soldier.alive)).filter((soldier) => soldier.alive)
  if (alive.length === 0) {
    reg.files = 1
    return
  }
  const def = unitDef(reg.type)
  files = fileCount(regimentLimits(reg), files, alive.length)
  reg.files = files
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
 * Foot keep the facing they were given while marching up to this far off it, each man turned toward the
 * road, so a line sent sideways flank-marches instead of wheeling there and back. Horses always face the road.
 */
const OBLIQUE_MARCH = (100 * Math.PI) / 180

/** Which way the block faces while it marches along `heading` to a spot where it must face `destFacing`. */
export function travelFacing(def: UnitDef, destFacing: number, heading: number): number {
  if (def.turnRadius > 0) return heading
  return Math.abs(angDiff(destFacing, heading)) <= OBLIQUE_MARCH ? destFacing : heading
}

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
  const width = fileCount(regimentLimits(reg), files, alive.length)
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

/**
 * Lay out a new shape for a block that is about to march off along `facing`, centered on the men as they
 * stand. A line folding into a column sends its center forward to lead and its flanks fall in behind; a
 * column opening into a line spreads out around its middle. Nobody waits for the shape to form.
 */
export function reformMoving(reg: Regiment, files: number, facing: number): void {
  const alive = reg.soldiers.filter((soldier) => soldier.alive)
  if (alive.length === 0) return
  const def = unitDef(reg.type)
  const fwd = forward(facing)
  let cx = 0
  let cy = 0
  for (const soldier of alive) {
    cx += soldier.x
    cy += soldier.y
  }
  cx /= alive.length
  cy /= alive.length
  const width = fileCount(regimentLimits(reg), files, alive.length)
  const depth = (Math.ceil(alive.length / width) - 1) * def.rankSpacing
  reg.facing = facing
  reg.anchorX = cx + (fwd.x * depth) / 2
  reg.anchorY = cy + (fwd.y * depth) / 2
  assignFormation(reg, width)
}

/** Shift a front-center point so the whole block it anchors stands inside the map. */
export function fitOnMap(reg: Regiment, x: number, y: number, facing: number, files: number): Vec2 {
  const def = unitDef(reg.type)
  const alive = Math.max(1, reg.aliveCount)
  const width = fileCount(regimentLimits(reg), files, alive)
  const halfW = ((width - 1) * def.spacing) / 2 + def.radius + 0.5
  const depth = (Math.ceil(alive / width) - 1) * def.rankSpacing + def.radius + 0.5
  const fwd = forward(facing)
  const rgt = right(facing)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [side, back] of [[-halfW, -def.radius - 0.5], [halfW, -def.radius - 0.5], [-halfW, depth], [halfW, depth]]) {
    const cx = x + rgt.x * side - fwd.x * back
    const cy = y + rgt.y * side - fwd.y * back
    minX = Math.min(minX, cx)
    maxX = Math.max(maxX, cx)
    minY = Math.min(minY, cy)
    maxY = Math.max(maxY, cy)
  }
  const shiftX = minX < 0 ? -minX : maxX > MAP_WIDTH ? MAP_WIDTH - maxX : 0
  const shiftY = minY < 0 ? -minY : maxY > MAP_HEIGHT ? MAP_HEIGHT - maxY : 0
  return { x: x + shiftX, y: y + shiftY }
}

export function compactRanks(reg: Regiment): void {
  const alive=reg.soldiers.filter(s=>s.alive)
  if (!alive.length) return
  const def=unitDef(reg.type)
  // Where each man's place is now, before the block is laid out again for the men left.
  const held=alive.map(s=>slotOf(reg,def,s.file,s.rank,s.centerIndex))
  reg.files=fileCount(regimentLimits(reg),reg.files,alive.length)
  reg.destFiles=fileCount(regimentLimits(reg),reg.destFiles,alive.length)
  const slots=formationSlots(reg,def,reg.files,alive.length)
  const key=(s:{file:number;rank:number;centerIndex:number})=>`${s.rank}:${s.centerIndex<0?'f':'c'}:${s.centerIndex<0?s.file:s.centerIndex}`
  const occupied=new Map(alive.map(s=>[key(s),s]))
  const kept=new Set<Soldier>(),holes:typeof slots=[]
  for (const slot of slots) {
    const soldier=occupied.get(key(slot))
    if (soldier && !kept.has(soldier)) kept.add(soldier)
    else holes.push(slot)
  }
  // Fill from the front with the man whose place is nearest: the man behind a gap steps up into it, and so on down
  // the file, instead of a rear model being sent through a stationary column. Places are compared, not bodies: in a
  // fight the front rank stands where it met the enemy, ragged and a step off its places, and matching bodies to
  // places there hands a front-rank place to whoever happens to stand nearest the line on paper, leaving the man
  // actually fighting in it with a place at the back he can never walk to. Quadratic matching avoids a cubic
  // assignment each time one of 240 models dies; explicit formation changes keep exact assignment.
  if(holes.length) {
    const used=new Uint8Array(alive.length)
    const take=(i:number,slot:(typeof slots)[number])=> {
      const s=alive[i];used[i]=1
      s.file=slot.file;s.rank=slot.rank;s.centerIndex=slot.centerIndex;s.idle=false
    }
    // The full ranks, file by file from the front.
    const full=slots.filter(slot=>slot.centerIndex<0),last=slots.filter(slot=>slot.centerIndex>=0)
    for(const slot of full) {
      let best=-1,cost=Infinity
      for(let i=0;i<alive.length;i++) {
        if(used[i]) continue
        const d=(held[i].x-slot.x)**2+(held[i].y-slot.y)**2
        if(d<cost) {best=i;cost=d}
      }
      take(best,slot)
    }
    // The short last rank stands centred, so its places shift sideways whenever its length changes. The men left for
    // it keep their order from flank to flank: taking the nearest place one by one would hand every man his
    // neighbour's and send the last of them the whole length of the rank.
    const rgt=right(reg.facing)
    const rest=alive.map((_,i)=>i).filter(i=>!used[i]).sort((a,b)=>(held[a].x-held[b].x)*rgt.x+(held[a].y-held[b].y)*rgt.y||alive[a].id-alive[b].id)
    last.sort((a,b)=>a.centerIndex-b.centerIndex)
    rest.forEach((i,k)=>take(i,last[k]))
  }
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
