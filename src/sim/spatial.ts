import { MAP_HEIGHT, MAP_WIDTH } from './types'

const MARGIN = 16

/** What one army's bodies inserted since the last clear can reach: the largest radius of a narrow and
 * of a wide body, and the furthest a body of either kind has moved since it was inserted (raised by
 * whoever moves bodies before the grid is filled again). Contact queries pad their radius by these. */
export interface ArmyReach { narrow: number; wide: number; narrowDrift: number; wideDrift: number }

type Buckets = Array<number[]|undefined>

/** Uniform grid of entity indices over the map. Points off the map share the border cells. */
export class Spatial {
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: number[][]
  private readonly sideBuckets: [Buckets,Buckets]
  /** Entries inserted as wide, per army and (index 2) for both armies together. */
  private readonly wideBuckets: [Buckets,Buckets,Buckets]
  private readonly touched: number[] = []
  private seen: Uint32Array
  private token = 1
  readonly reach: [ArmyReach,ArmyReach] = [{narrow:0,wide:0,narrowDrift:0,wideDrift:0},{narrow:0,wide:0,narrowDrift:0,wideDrift:0}]

  constructor(
    private cell = 2,
    capacity = 2048,
  ) {
    this.cols = Math.ceil((MAP_WIDTH + MARGIN * 2) / cell)
    this.rows = Math.ceil((MAP_HEIGHT + MARGIN * 2) / cell)
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [])
    this.sideBuckets=[new Array(this.buckets.length),new Array(this.buckets.length)]
    this.wideBuckets=[new Array(this.buckets.length),new Array(this.buckets.length),new Array(this.buckets.length)]
    this.seen = new Uint32Array(capacity)
  }

  clear(): void {
    for (const index of this.touched) {
      this.buckets[index].length = 0
      const south=this.sideBuckets[0][index],north=this.sideBuckets[1][index]
      if(south) south.length=0
      if(north) north.length=0
      // Per-army wide buckets only exist where the shared wide bucket does.
      const wide=this.wideBuckets[2][index]
      if(wide) {
        wide.length=0
        const wideSouth=this.wideBuckets[0][index],wideNorth=this.wideBuckets[1][index]
        if(wideSouth) wideSouth.length=0
        if(wideNorth) wideNorth.length=0
      }
    }
    this.touched.length = 0
    for(const reach of this.reach) reach.narrow=reach.wide=reach.narrowDrift=reach.wideDrift=0
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x + MARGIN) / this.cell)))
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y + MARGIN) / this.cell)))
  }

  /** `radius` is recorded in the army's reach when a side is given; wide entries can also be found by queryWide's outer radius. */
  insert(x: number, y: number, index: number, side?:0|1, radius=0, wide=false): void {
    if (index >= this.seen.length) {
      const grown = new Uint32Array(Math.max(index + 1, this.seen.length * 2))
      grown.set(this.seen)
      this.seen = grown
    }
    const cell = this.row(y) * this.cols + this.col(x)
    const bucket = this.buckets[cell]
    if (bucket.length === 0) this.touched.push(cell)
    bucket.push(index)
    if(side!==undefined) {
      const bySide=this.sideBuckets[side]
      const armyBucket=bySide[cell]??(bySide[cell]=[])
      armyBucket.push(index)
      const reach=this.reach[side]
      if(wide) { if(radius>reach.wide) reach.wide=radius }
      else if(radius>reach.narrow) reach.narrow=radius
    }
    if(wide) {
      const all=this.wideBuckets[2]
      ;(all[cell]??(all[cell]=[])).push(index)
      if(side!==undefined) { const bySide=this.wideBuckets[side]; (bySide[cell]??(bySide[cell]=[])).push(index) }
    }
  }

  query(x: number, y: number, radius: number, out: number[], side?:0|1): void {
    out.length = 0
    this.token++
    if (this.token === 0xffffffff) {
      this.seen.fill(0)
      this.token = 1
    }
    const minX = this.col(x - radius)
    const maxX = this.col(x + radius)
    const minY = this.row(y - radius)
    const maxY = this.row(y + radius)
    const buckets=side===undefined?this.buckets:this.sideBuckets[side]
    for (let iy = minY; iy <= maxY; iy++) {
      const rowStart = iy * this.cols
      for (let ix = minX; ix <= maxX; ix++) {
        const bucket = buckets[rowStart + ix]
        if(!bucket) continue
        for (let k = 0; k < bucket.length; k++) {
          const index = bucket[k]
          if (index >= this.seen.length) continue
          if (this.seen[index] === this.token) continue
          this.seen[index] = this.token
          out.push(index)
        }
      }
    }
  }

  /** Every entry within `radius`, plus wide entries out to `wideRadius`, so a few big bodies do not widen
   * the search for everyone. The order is query(x, y, wideRadius)'s with the narrow entries beyond `radius` left out. */
  queryWide(x: number, y: number, radius: number, wideRadius: number, out: number[], side?:0|1): void {
    if (wideRadius <= radius) { this.query(x, y, radius, out, side); return }
    this.begin(out)
    const inMinX = this.col(x - radius), inMaxX = this.col(x + radius)
    const inMinY = this.row(y - radius), inMaxY = this.row(y + radius)
    const minX = this.col(x - wideRadius), maxX = this.col(x + wideRadius)
    const minY = this.row(y - wideRadius), maxY = this.row(y + wideRadius)
    const all: Buckets = side===undefined?this.buckets:this.sideBuckets[side], wide=this.wideBuckets[side??2]
    for (let iy = minY; iy <= maxY; iy++) {
      const rowStart = iy * this.cols, innerRow = iy >= inMinY && iy <= inMaxY
      for (let ix = minX; ix <= maxX; ix++) {
        this.collect((innerRow && ix >= inMinX && ix <= inMaxX ? all : wide)[rowStart + ix], out)
      }
    }
  }

  /** Entries in the cells within `radius` (wide entries: `wideRadius`) of the segment, in no useful order. */
  querySegment(x0: number, y0: number, x1: number, y1: number, radius: number, wideRadius: number, out: number[], side?:0|1): void {
    this.begin(out)
    const reach = Math.max(radius, wideRadius)
    const minY = this.row(Math.min(y0, y1) - reach), maxY = this.row(Math.max(y0, y1) + reach)
    const all: Buckets = side===undefined?this.buckets:this.sideBuckets[side], wide=this.wideBuckets[side??2]
    for (let iy = minY; iy <= maxY; iy++) {
      // Border rows also hold every point beyond the map edge.
      const lo = iy === 0 ? -Infinity : iy * this.cell - MARGIN
      const hi = iy === this.rows - 1 ? Infinity : (iy + 1) * this.cell - MARGIN
      if (!this.span(x0, y0, x1, y1, lo, hi, reach)) continue
      const minX = this.spanMin, maxX = this.spanMax
      const inner = radius >= wideRadius || this.span(x0, y0, x1, y1, lo, hi, radius)
      const inMinX = this.spanMin, inMaxX = this.spanMax
      const rowStart = iy * this.cols
      for (let ix = minX; ix <= maxX; ix++) {
        const narrow = radius >= wideRadius || (inner && ix >= inMinX && ix <= inMaxX)
        this.collect((narrow ? all : wide)[rowStart + ix], out)
      }
    }
  }

  /** How far a point may move from (x0, y0), along x and along y, while the cells that a search of `radius`
   * around (x0, y0) visits still hold every point within `radius` of it. */
  room(x0: number, y0: number, radius: number): number {
    const minX = this.col(x0 - radius), maxX = this.col(x0 + radius), minY = this.row(y0 - radius), maxY = this.row(y0 + radius)
    // Border cells also hold every point beyond the map edge.
    const left = minX === 0 ? Infinity : x0 - radius - (minX * this.cell - MARGIN)
    const right = maxX === this.cols - 1 ? Infinity : (maxX + 1) * this.cell - MARGIN - (x0 + radius)
    const below = minY === 0 ? Infinity : y0 - radius - (minY * this.cell - MARGIN)
    const above = maxY === this.rows - 1 ? Infinity : (maxY + 1) * this.cell - MARGIN - (y0 + radius)
    return Math.min(left, right, below, above)
  }

  private spanMin = 0
  private spanMax = 0

  /** Columns of the cells within `r` (per axis) of the part of the segment that can reach the y band [lo, hi]. */
  private span(x0: number, y0: number, x1: number, y1: number, lo: number, hi: number, r: number): boolean {
    let t0 = 0, t1 = 1
    const dy = y1 - y0
    if (Math.abs(dy) < 1e-9) {
      if (Math.max(y0, y1) < lo - r || Math.min(y0, y1) > hi + r) return false
    } else {
      let a = (lo - r - y0) / dy, b = (hi + r - y0) / dy
      if (a > b) { const swap = a; a = b; b = swap }
      t0 = Math.max(0, a); t1 = Math.min(1, b)
      if (t0 > t1) return false
    }
    const xa = x0 + (x1 - x0) * t0, xb = x0 + (x1 - x0) * t1
    this.spanMin = this.col(Math.min(xa, xb) - r)
    this.spanMax = this.col(Math.max(xa, xb) + r)
    return true
  }

  private begin(out: number[]): void {
    out.length = 0
    this.token++
    if (this.token === 0xffffffff) {
      this.seen.fill(0)
      this.token = 1
    }
  }

  private collect(bucket: number[]|undefined, out: number[]): void {
    if (!bucket) return
    for (let k = 0; k < bucket.length; k++) {
      const index = bucket[k]
      if (index >= this.seen.length) continue
      if (this.seen[index] === this.token) continue
      this.seen[index] = this.token
      out.push(index)
    }
  }
}
