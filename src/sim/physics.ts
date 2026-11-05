import { MECHANICS } from './mechanics'
import type { Soldier, UnitDef } from './types'

/** Allies make room with a slim collider; enemies retain their full body size. */
export function collisionRadius(def:UnitDef,enemy=false):number {return def.radius*(enemy?1:MECHANICS.collisionRadiusScale)}
export function collisionExtent(def:UnitDef,enemy=false):number {
  return (def.shape==='capsule'?def.length/2:def.radius)*(enemy?1:MECHANICS.collisionRadiusScale)
}
export function contactSoftDepth(radiusSum:number,friendly:boolean):number {
  return radiusSum*(friendly?MECHANICS.friendlySoftFraction:MECHANICS.enemySoftFraction)
}
/** A compressible shell recovers gradually; the inner core prevents tunnelling. */
export function contactPush(penetration:number,softDepth:number,dt:number,shellRecovery=1-Math.exp(-MECHANICS.contactStiffness*dt/4)):number {
  const shell=Math.min(penetration,softDepth)
  return Math.min(MECHANICS.maxContactCorrection,Math.max(0,penetration-softDepth)+shell*shellRecovery)
}

/** Coulomb-style ground drag acts on external motion, never the walking motor. */
export function groundDrag(vx:number,vy:number,deceleration:number,dt:number):{x:number;y:number} {
  const speed=Math.hypot(vx,vy)
  const scale=speed>0?Math.max(0,1-deceleration*dt/speed):0
  return {x:vx*scale,y:vy*scale}
}

export function moveGroundDrift(s:Soldier,dt:number):void {
  if(s.pushVx===0&&s.pushVy===0) return
  const drag=groundDrag(s.pushVx,s.pushVy,s.speed>0.3?MECHANICS.movingFriction:MECHANICS.groundFriction,dt)
  s.pushVx=drag.x;s.pushVy=drag.y
  s.x+=drag.x*dt;s.y+=drag.y*dt
}

/** Braking cancels a motor's incoming velocity; only excess impulse becomes drift.
 * Existing external motion is cancelled first instead of being resurrected next step. */
export function normalImpulse(s:Soldier,nx:number,ny:number,delta:number):void {
  const external=s.pushVx*nx+s.pushVy*ny
  let remaining=delta
  if (external*remaining<0) {
    const cancel=Math.sign(remaining)*Math.min(Math.abs(external),Math.abs(remaining))
    s.pushVx+=nx*cancel;s.pushVy+=ny*cancel;remaining-=cancel
  }
  const motor=s.vx*nx+s.vy*ny-external
  const transmitted=motor*remaining<0?Math.sign(remaining)*Math.max(0,Math.abs(remaining)-Math.abs(motor)):remaining
  s.pushVx+=nx*transmitted;s.pushVy+=ny*transmitted
  s.vx+=nx*delta;s.vy+=ny*delta
}

/** Match the separation normal to the closest capsule circles, not body centres. */
export function bodyContact(a:Soldier,ad:UnitDef,b:Soldier,bd:UnitDef,out={gap:0,nx:0,ny:0},enemy=false):{gap:number;nx:number;ny:number} {
  const scale=enemy?1:MECHANICS.collisionRadiusScale,radiusSum=collisionRadius(ad,enemy)+collisionRadius(bd,enemy)
  if(ad.shape==='circle'&&bd.shape==='circle') {
    const dx=b.x-a.x,dy=b.y-a.y,distance=Math.sqrt(dx*dx+dy*dy)
    if(distance<1e-6) {
      const length=Math.hypot(dx,dy)
      out.gap=-radiusSum;out.nx=length>1e-6?dx/length:a.id<b.id?1:-1;out.ny=length>1e-6?dy/length:0
    } else {out.gap=distance-radiusSum;out.nx=dx/distance;out.ny=dy/distance}
    return out
  }
  const ax=ad.shape==='capsule'?Math.cos(a.facing)*Math.max(0,(ad.length-ad.radius*2)/2)*scale:0
  const ay=ad.shape==='capsule'?Math.sin(a.facing)*Math.max(0,(ad.length-ad.radius*2)/2)*scale:0
  const bx=bd.shape==='capsule'?Math.cos(b.facing)*Math.max(0,(bd.length-bd.radius*2)/2)*scale:0
  const by=bd.shape==='capsule'?Math.sin(b.facing)*Math.max(0,(bd.length-bd.radius*2)/2)*scale:0
  const startA=ad.shape==='capsule'?-1:0,startB=bd.shape==='capsule'?-1:0
  const endA=-startA,endB=-startB
  const cx=b.x-a.x,cy=b.y-a.y
  let dx=cx,dy=cy,nearest=cx*cx+cy*cy
  for(let i=startA;i<=endA;i++) for(let j=startB;j<=endB;j++) {
    const qx=cx+bx*j-ax*i,qy=cy+by*j-ay*i,d=qx*qx+qy*qy
    if(d<nearest) {nearest=d;dx=qx;dy=qy}
  }
  const distance=Math.sqrt(nearest)
  if(distance<1e-6) {
    dx=b.x-a.x;dy=b.y-a.y
    const length=Math.hypot(dx,dy)
    out.gap=-radiusSum;out.nx=length>1e-6?dx/length:a.id<b.id?1:-1;out.ny=length>1e-6?dy/length:0
    return out
  }
  out.gap=distance-radiusSum;out.nx=dx/distance;out.ny=dy/distance
  return out
}
