/** Uniform grid of entity indices. Reused across queries with a stamp buffer. */
export class Spatial {
  private buckets = new Map<string, number[]>()
  private seen: Uint32Array
  private token = 1

  constructor(
    private cell = 6,
    capacity = 2048,
  ) {
    this.seen = new Uint32Array(capacity)
  }

  clear(): void {
    this.buckets.clear()
  }

  insert(x: number, y: number, index: number): void {
    const k = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`
    const bucket = this.buckets.get(k)
    if (bucket) bucket.push(index)
    else this.buckets.set(k, [index])
  }

  query(x: number, y: number, radius: number, out: number[]): void {
    out.length = 0
    this.token++
    if (this.token === 0xffffffff) {
      this.seen.fill(0)
      this.token = 1
    }
    const minX = Math.floor((x - radius) / this.cell)
    const maxX = Math.floor((x + radius) / this.cell)
    const minY = Math.floor((y - radius) / this.cell)
    const maxY = Math.floor((y + radius) / this.cell)
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iy = minY; iy <= maxY; iy++) {
        const bucket = this.buckets.get(`${ix},${iy}`)
        if (!bucket) continue
        for (const index of bucket) {
          if (index >= this.seen.length) continue
          if (this.seen[index] === this.token) continue
          this.seen[index] = this.token
          out.push(index)
        }
      }
    }
  }
}
