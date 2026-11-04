export const DEG = Math.PI / 180

export interface Vec {
  x: number
  y: number
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Shortest signed turn from `from` to `to`, in radians. */
export function angDiff(from: number, to: number): number {
  const d = to - from
  return ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
}

export function forward(facing: number): Vec {
  return { x: Math.cos(facing), y: Math.sin(facing) }
}

export function right(facing: number): Vec {
  return { x: Math.sin(facing), y: -Math.cos(facing) }
}

export function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax
  const aby = by - ay
  const ab2 = abx * abx + aby * aby
  let t = ab2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / ab2 : 0
  t = clamp(t, 0, 1)
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

/** Earliest t in [0, 1] where the segment enters the circle, if any. */
export function rayCircleT(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  const dx = x1 - x0
  const dy = y1 - y0
  const fx = x0 - cx
  const fy = y0 - cy
  const a = dx * dx + dy * dy
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - r * r
  if (a <= 1e-8) return c <= 0 ? 0 : null
  let disc = b * b - 4 * a * c
  if (disc < 0) return null
  disc = Math.sqrt(disc)
  const t1 = (-b - disc) / (2 * a)
  const t2 = (-b + disc) / (2 * a)
  if (t1 >= 0 && t1 <= 1) return t1
  if (t2 >= 0 && t2 <= 1) return t2
  return null
}

export type Arc = 'front' | 'flank' | 'rear'

/** Where `other` sits relative to a body at (x, y) looking along `facing`. */
export function facingArc(
  facing: number,
  x: number,
  y: number,
  ox: number,
  oy: number,
): Arc {
  const to = Math.atan2(oy - y, ox - x)
  const d = Math.abs(angDiff(facing, to))
  if (d <= 60 * DEG) return 'front'
  if (d >= 120 * DEG) return 'rear'
  return 'flank'
}
