import {describe,expect,it} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {scaledFormation} from '../src/sim/armies'
import {battleErrors} from '../src/sim/diagnostics'
import {MECHANICS} from '../src/sim/mechanics'
import {commandAttack} from '../src/sim/orders'
import type {Battle,Regiment,UnitType} from '../src/sim/types'

/**
 * Where leadership comes from in a battle (RULES 七.1). The sums themselves are in combat.test.ts; these check that the
 * battle feeds each effect from what actually happens: who is hit from where, by what, and who stands near.
 */
const N=Math.PI/2,S=-Math.PI/2,W=Math.PI,M=MECHANICS.morale
const tick=(b:Battle,seconds:number,each?:()=>void)=>{for(let i=0;i<Math.round(seconds/0.05);i++) {step(b,0.05);each?.()}}
const block=(b:Battle,side:0|1,type:UnitType,x:number,y:number,facing:number)=>spawn(b,side,type,type,x,y,facing,scaledFormation(type,4))
/** A battle with far-off reserves on both sides, so that one regiment's losses do not push the army past its losing mark. */
function field(seed:number) {
  const b=createEmptyBattle(seed);b.aiEnabled=false
  for(const side of [0,1] as const) for(let i=0;i<4;i++) block(b,side,'sword',20+i*12,side?206:8,side?S:N)
  return b
}
/** The lowest and highest each factor went while the battle ran. */
function watch(b:Battle,reg:Regiment,seconds:number,keys:string[]) {
  const low:Record<string,number>=Object.fromEntries(keys.map(key=>[key,0])),high:Record<string,number>={...low}
  tick(b,seconds,()=>{for(const key of keys) {low[key]=Math.min(low[key],reg.moraleFactors[key]??0);high[key]=Math.max(high[key],reg.moraleFactors[key]??0)}})
  return {low,high}
}

describe('leadership in battle',()=> {
  it('a level frontal fight between two lines leaves both steady, with no flank, rear or charge effects once joined',()=> {
    const b=field(21),ours=block(b,0,'sword',150,90,N),foe=block(b,1,'sword',150,112,S)
    commandAttack(b,[ours.id],foe.id);commandAttack(b,[foe.id],ours.id)
    // Running in to charge lifts both; the lift fades with the charge.
    const run=watch(b,ours,6,['charging'])
    expect(run.high.charging).toBe(M.charging)
    const fight=watch(b,ours,60,['flank','rear','charged','underFire'])
    expect(ours.inContact).toBe(true)
    expect(fight.low).toEqual({flank:0,rear:0,charged:0,underFire:0})
    expect(ours.moraleFactors.charging).toBe(0)
    expect(ours.moraleFactors.enemies).toBeCloseTo(M.enemyNear*foe.aliveCount/foe.initial)
    for(const reg of [ours,foe]) {expect(reg.moraleState,reg.name).toBe('steady');expect(reg.leadership).toBeGreaterThan(40)}
    expect(battleErrors(b)).toEqual([])
  },30000)

  it('a longer line overlapping both ends of a shorter one in front is not at its flank',()=> {
    const b=field(22),ours=spawn(b,0,'sword','ours',150,90,N,{...scaledFormation('sword',4),files:12})
    const foe=spawn(b,1,'sword','foe',150,112,S,{...scaledFormation('sword',4),files:30})
    commandAttack(b,[foe.id],ours.id)
    const seen=watch(b,ours,40,['flank','rear'])
    expect(ours.inContact).toBe(true)
    expect(seen.low).toEqual({flank:0,rear:0})
  },30000)

  it('a regiment fought from beside its block takes the flank penalty, and from behind it the larger rear penalty',()=> {
    const b=field(23),ours=block(b,0,'sword',150,90,N),victim=block(b,1,'sword',150,112,S)
    commandAttack(b,[ours.id],victim.id);commandAttack(b,[victim.id],ours.id)
    tick(b,12)
    expect(victim.moraleFactors.flank).toBe(0)
    // A second line comes in at right angles onto one end of the victim.
    const side=block(b,0,'sword',185,109,W)
    commandAttack(b,[side.id],victim.id)
    const flanked=watch(b,victim,25,['flank'])
    expect(flanked.low.flank).toBe(M.flank)
    // And a third from straight behind.
    const back=block(b,0,'sword',150,135,S)
    commandAttack(b,[back.id],victim.id)
    const reared=watch(b,victim,25,['rear'])
    expect(reared.low.rear).toBe(M.rear)
    expect(M.rear).toBeLessThan(M.flank)
    // The attackers themselves are fighting to their front.
    expect(back.moraleFactors.rear).toBe(0);expect(side.moraleFactors.flank).toBe(0)
    expect(battleErrors(b)).toEqual([])
  },30000)

  it('cavalry charging home shakes men on foot; braced spears that stop the charge are not shaken',()=> {
    const run=(type:UnitType)=> {
      const b=field(24),riders=block(b,0,'heavyCavalry',150,60,N),foot=block(b,1,type,150,125,S)
      commandAttack(b,[riders.id],foot.id)
      const seen=watch(b,foot,22,['charged'])
      expect(riders.inContact||foot.taken.length>0,type).toBe(true)
      return {seen,foot,riders}
    }
    const swords=run('sword')
    // Fresh, the shock is at its full value; it fades over the next seconds.
    expect(swords.seen.low.charged).toBeLessThan(M.chargedByMounted*0.8)
    expect(swords.seen.low.charged).toBeGreaterThanOrEqual(M.chargedByMounted)
    expect(swords.riders.moraleFactors.charged).toBe(0)
    expect(run('spear').seen.low.charged).toBe(0)
  },30000)

  it('enemy missiles landing put a regiment under fire for a few seconds after the last hit, and no longer',()=> {
    const b=field(25),archers=block(b,0,'archer',150,60,N),target=block(b,1,'sword',150,140,S)
    commandAttack(b,[archers.id],target.id)
    const shot=watch(b,target,15,['underFire'])
    expect(target.taken.length).toBeGreaterThan(0)
    expect(shot.low.underFire).toBe(M.underFire)
    expect(archers.moraleFactors.underFire).toBe(0)
    for(const s of archers.soldiers) s.ammo=0
    tick(b,M.underFireTime+6)
    expect(target.moraleFactors.underFire).toBe(0)
  },30000)

  it('friends in good order nearby steady a regiment and enemies nearby unsettle it, each by the share of its men it has left',()=> {
    const b=field(26),ours=block(b,0,'sword',150,90,N)
    step(b,0.05)
    expect(ours.moraleFactors.friends).toBe(0);expect(ours.moraleFactors.enemies).toBe(0)
    const friend=block(b,0,'sword',180,90,N),foe=block(b,1,'sword',150,140,S)
    step(b,0.05)
    expect(ours.moraleFactors.friends).toBe(M.friendNear);expect(ours.moraleFactors.enemies).toBe(M.enemyNear)
    // Half a regiment is half the company.
    for(const s of friend.soldiers.slice(0,friend.soldiers.length/2)) {s.alive=false;s.hp=0;s.deathTime=-20}
    for(const s of foe.soldiers.slice(0,foe.soldiers.length/2)) {s.alive=false;s.hp=0;s.deathTime=-20}
    tick(b,0.1)
    expect(ours.moraleFactors.friends).toBeCloseTo(M.friendNear/2);expect(ours.moraleFactors.enemies).toBeCloseTo(M.enemyNear/2)
    // Beyond the radius they count for nothing.
    const far=block(b,0,'sword',150+M.supportRadius+40,90,N)
    step(b,0.05)
    expect(far.moraleFactors.friends).toBe(0)
  })

  it('an ordinary line beaten in front holds until most of it is gone; hit in the back by cavalry as well, it breaks far sooner',()=> {
    const run=(rear:boolean)=> {
      const b=field(27),ours=block(b,0,'greatsword',150,90,N),victim=block(b,1,'sword',150,112,S)
      commandAttack(b,[ours.id],victim.id);commandAttack(b,[victim.id],ours.id)
      const riders=rear?block(b,0,'heavyCavalry',150,170,S):null
      if(riders) commandAttack(b,[riders.id],victim.id)
      let left=1
      for(let i=0;i<20*240&&!victim.routing;i++) {
        step(b,0.05)
        left=victim.soldiers.reduce((sum,s)=>sum+(s.alive?s.hp:0),0)/(victim.initial*victim.modelHp)
      }
      expect(victim.routing,rear?'rear':'front').toBe(true)
      return {left,time:b.time}
    }
    const front=run(false),both=run(true)
    // Beaten in front alone, it has lost half its strength or more before it runs.
    expect(front.left).toBeLessThan(0.5)
    expect(front.left).toBeGreaterThan(0.15)
    expect(both.time).toBeLessThan(front.time*0.75)
    expect(both.left).toBeGreaterThan(front.left)
  },60000)
})
