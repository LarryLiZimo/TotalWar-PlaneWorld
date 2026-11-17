import { MECHANICS } from './mechanics'
import type { Regiment } from './types'
import { unitDef } from './units'

/** Whether a timer summed from fixed steps has run its delay. Repeated float addition falls just short
 * (50 × 0.05 = 2.4999999999999990), which would otherwise cost a whole extra step. */
export function reached(timer: number, delay: number): boolean {
  return timer >= delay - 1e-6
}

export function advanceMorale(reg: Regiment, leadership: number, enemyNear: boolean, terrorHit: boolean, dt: number): 'routed' | 'shattered' | 'rallied' | null {
  if (unitDef(reg.type).unbreakable) {
    const wasRouting=reg.routing
    reg.routing=false; reg.shattered=false; reg.moraleState='steady'; reg.negativeTime=0; reg.rallyTime=0
    return wasRouting?'rallied':null
  }
  if (reg.shattered) { reg.routing=true; reg.moraleState='shattered'; return null }
  reg.negativeTime=leadership<0?reg.negativeTime+dt:0
  if (!reg.routing) {
    reg.moraleState=leadership<10?'wavering':'steady'
    const def=unitDef(reg.type)
    const scared=terrorHit && !def.immunePsychology && !def.causesTerror && leadership<MECHANICS.terrorLeadership
    if (leadership<=MECHANICS.instantRoutLeadership || reached(reg.negativeTime,MECHANICS.routDelay) || scared) {
      reg.routCount++; reg.routing=true; reg.routeTime=0; reg.rallyTime=0; reg.negativeTime=0
      // Routing and shattering differ: a routed unit can rally and still counts on the field; the third rout shatters it.
      reg.shattered=reg.routCount>=MECHANICS.shatterRouts
      reg.moraleState=reg.shattered?'shattered':'routing'
      return reg.shattered?'shattered':'routed'
    }
  } else {
    // Safe time counts only in steps that start after the minimum rout is over, so 10 s + 8 s is 360 steps, not 359.
    const minimumDone=reached(reg.routeTime,MECHANICS.minimumRout)
    reg.routeTime+=dt
    reg.moraleState='routing'
    const safe=leadership>=0 && !enemyNear && !terrorHit && minimumDone
    reg.rallyTime=safe?reg.rallyTime+dt:0
    if (reached(reg.rallyTime,MECHANICS.rallyDelay)) {
      reg.routing=false; reg.moraleState='steady'; reg.rallyTime=0; reg.routeTime=0
      return 'rallied'
    }
  }
  return null
}

/** Break a regiment for good, whatever its leadership: it routs now and never rallies. Its army has lost the battle. */
export function shatter(reg: Regiment): void {
  if (!reg.routing) { reg.routCount++; reg.routeTime=0 }
  reg.routing=true; reg.shattered=true; reg.moraleState='shattered'; reg.rallyTime=0; reg.negativeTime=0
}
