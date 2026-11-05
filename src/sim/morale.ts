import { MECHANICS } from './mechanics'
import type { Battle, Regiment } from './types'
import { unitDef } from './units'

/** A transparent local strength estimator; the original game's hidden evaluator
 * is not available. HP, combat quality and ammunition all contribute. */
export function armyPressure(battle: Battle): [boolean, boolean] {
  const initial=[0,0], current=[0,0]
  for (const r of battle.regiments) {
    const d=unitDef(r.type)
    const quality=(d.meleeAttack+d.meleeDefense+d.armor*0.3+(d.weaponBase+d.weaponAp)*4/d.meleeInterval)/100
    const max=r.initial*r.modelHp*quality
    initial[r.side]+=max*(d.missile ? 1.5 : 1)
    const hp=r.soldiers.reduce((sum,s)=>sum+(s.alive?s.hp:0),0)
    const ammo=d.missile ? r.soldiers.reduce((sum,s)=>sum+(s.alive?s.ammo:0),0)/Math.max(1,r.aliveCount*d.missile.ammo) : 0
    current[r.side]+=hp*quality*(d.missile ? 1+0.5*ammo : 1)*(r.routing?0.5:1)
  }
  return [0,1].map(side=>initial[side]>0 && current[side]<initial[side]*MECHANICS.armyLossesFraction && current[1-side]>current[side]*MECHANICS.armyLossesRatio) as [boolean,boolean]
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
    if (leadership<=MECHANICS.shatterLeadership || reg.negativeTime>=MECHANICS.routDelay || scared) {
      reg.routCount++; reg.routing=true; reg.routeTime=0; reg.rallyTime=0; reg.negativeTime=0
      reg.shattered=leadership<=MECHANICS.shatterLeadership || reg.routCount>=MECHANICS.shatterRouts
      reg.moraleState=reg.shattered?'shattered':'routing'
      return reg.shattered?'shattered':'routed'
    }
  } else {
    reg.routeTime+=dt
    if (leadership<=MECHANICS.shatterLeadership) { reg.shattered=true; reg.moraleState='shattered'; return 'shattered' }
    reg.moraleState='routing'
    const safe=leadership>=0 && !enemyNear && !terrorHit && reg.routeTime>=MECHANICS.minimumRout
    reg.rallyTime=safe?reg.rallyTime+dt:0
    if (reg.rallyTime>=MECHANICS.rallyDelay) {
      reg.routing=false; reg.moraleState='steady'; reg.rallyTime=0; reg.routeTime=0
      return 'rallied'
    }
  }
  return null
}
