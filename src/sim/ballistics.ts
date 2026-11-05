/** Continuous segment/cylinder intersection, including vertical ballistic motion.
 * Returns the first fraction of the step inside the body's horizontal radius and height. */
export function sweptCylinderT(
  x0: number, y0: number, x1: number, y1: number,
  z0: number, vz: number, gravity: number, dt: number,
  cx: number, cy: number, radius: number, ground: number, height: number,
): number | null {
  const dx=x1-x0, dy=y1-y0, fx=x0-cx, fy=y0-cy
  const a=dx*dx+dy*dy, b=2*(fx*dx+fy*dy), c=fx*fx+fy*fy-radius*radius
  let enter=0, leave=1
  if (a<1e-12) { if (c>0) return null }
  else {
    const disc=b*b-4*a*c
    if (disc<0) return null
    enter=Math.max(0,(-b-Math.sqrt(disc))/(2*a))
    leave=Math.min(1,(-b+Math.sqrt(disc))/(2*a))
    if (enter>leave) return null
  }
  const candidates=[enter,leave]
  const qa=-0.5*gravity*dt*dt, qb=vz*dt
  for (const level of [ground,ground+height]) {
    const qc=z0-level
    if (Math.abs(qa)<1e-12) {
      if (Math.abs(qb)>1e-12) candidates.push(-qc/qb)
    } else {
      const disc=qb*qb-4*qa*qc
      if (disc>=0) candidates.push((-qb-Math.sqrt(disc))/(2*qa),(-qb+Math.sqrt(disc))/(2*qa))
    }
  }
  candidates.sort((a,b)=>a-b)
  for (const t of candidates) {
    if (t<enter-1e-8 || t>leave+1e-8) continue
    const z=z0+qb*t+qa*t*t
    if (z>=ground-1e-7 && z<=ground+height+1e-7) return Math.max(enter,t)
  }
  return null
}
