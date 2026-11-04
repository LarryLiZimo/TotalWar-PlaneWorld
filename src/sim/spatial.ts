import { MAP_HEIGHT, MAP_WIDTH } from './types'

const MARGIN = 16

/** Uniform grid of entity indices over the map. Points off the map share the border cells. */
export class Spatial {
  private readonly cols: number
  private readonly rows: number
  private readonly buckets: number[][]
  private readonly touched: number[] = []
  private seen: Uint32Array
  private token = 1

  constructor(
    private cell = 2,
    capacity = 2048,
  ) {
    this.cols = Math.ceil((MAP_WIDTH + MARGIN * 2) / cell)
    this.rows = Math.ceil((MAP_HEIGHT + MARGIN * 2) / cell)
    this.buckets = Array.from({ length: this.cols * this.rows }, () => [])
    this.seen = new Uint32Array(capacity)
  }

  clear(): void {
    for (const index of this.touched) this.buckets[index].length = 0
    this.touched.length = 0
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x + MARGIN) / this.cell)))
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y + MARGIN) / this.cell)))
  }

  insert(x: number, y: number, index: number): void {
    const cell = this.row(y) * this.cols + this.col(x)
    const bucket = this.buckets[cell]
    if (bucket.length === 0) this.touched.push(cell)
    bucket.push(index)
  }

  query(x: number, y: number, radius: number, out: number[]): void {
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
    for (let iy = minY; iy <= maxY; iy++) {
      const rowStart = iy * this.cols
      for (let ix = minX; ix <= maxX; ix++) {
        const bucket = this.buckets[rowStart + ix]
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
}
