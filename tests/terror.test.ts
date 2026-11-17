import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { MECHANICS } from '../src/sim/mechanics'
import type { Battle, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

const original={sword:UNITS.sword,monster:UNITS.monster,general:UNITS.general}
beforeEach(()=> {
  // One point of actual damage leaves low leadership positive: only terror can
  // rout these targets immediately, not ordinary sustained negative leadership.
  UNITS.sword={...original.sword,hp:1000,leadership:20,canBrace:false,weaponBase:0,weaponAp:0}
  UNITS.monster={...original.monster,weaponBase:0,weaponAp:1,meleeAttack:100,collisionAttack:null,
    meleeInterval:0.2,attack:{...original.monster.attack,windup:0.05,recovery:0.05}}
  UNITS.general={...original.general,weaponBase:0,weaponAp:1,meleeAttack:100}
})
afterEach(()=>Object.assign(UNITS,original))

function one(b:Battle,side:0|1,type:UnitType,x:number,y:number,facing=side?Math.PI/2:-Math.PI/2):Regiment {
  const r=spawn(b,side,type,type,x,y,facing)
  for (const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1);r.initial=r.aliveCount=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,meleeCd:type==='sword'?100:0})
  return r
}
function park(r:Regiment,x:number,y:number) {
  Object.assign(r,{anchorX:x,anchorY:y,destX:x,destY:y,anchorSpeed:0})
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,speed:0,vx:0,vy:0})
}
function tick(b:Battle,seconds:number) {for(let i=0;i<Math.round(seconds/0.05);i++) step(b,0.05)}
function pair(distance=2) {
  const b=createEmptyBattle(61);b.rng=()=>0
  const source=one(b,1,'monster',100,100)
  const victim=one(b,0,'sword',100,100+distance)
  const reserve=one(b,0,'sword',200,50)
  return {b,source,victim,reserve}
}

describe('fear aura versus damage-triggered terror',()=> {
  it('proximity lowers leadership but cannot terror-rout an undamaged unit',()=> {
    const {b,source,victim}=pair(12);tick(b,0.25)
    // Base 20, the fear aura, and one enemy regiment close by.
    expect(victim.leadership).toBe(20+MECHANICS.fearPenalty+MECHANICS.morale.enemyNear)
    expect(victim.moraleFactors.fear).toBe(MECHANICS.fearPenalty)
    expect(victim.taken).toHaveLength(0);expect(victim.routing).toBe(false)
    expect(source.terrorCooldown).toBe(0);expect(victim.terrorCooldown).toBe(0)
  })

  it('a damaging terror hit routes low leadership and puts the source on cooldown',()=> {
    const {b,source,victim}=pair();tick(b,0.15)
    expect(victim.taken.length).toBeGreaterThan(0);expect(victim.routing).toBe(true)
    expect(source.terrorCooldown).toBeGreaterThan(MECHANICS.terrorCooldown-0.2)
    expect(victim.terrorCooldown).toBe(0)
  })

  it.each(['miss','zero damage'] as const)('%s cannot trigger terror or spend its cooldown',mode=> {
    const {b,source,victim}=pair()
    if(mode==='miss') b.rng=()=>0.99
    else UNITS.monster={...UNITS.monster,weaponAp:0}
    tick(b,0.15)
    expect(victim.taken).toHaveLength(0);expect(victim.routing).toBe(false)
    expect(source.terrorCooldown).toBe(0)
  })

  it('damage from an ordinary unit does not borrow terror from a nearby monster',()=> {
    const {b,source,victim}=pair(12)
    one(b,1,'general',100,110.8);source.soldiers[0].meleeCd=100
    tick(b,0.6)
    expect(victim.taken.length).toBeGreaterThan(0)
    expect(victim.leadership).toBeLessThan(MECHANICS.terrorLeadership)
    expect(victim.routing).toBe(false);expect(source.terrorCooldown).toBe(0)
  })

  it('one source cannot terror-rout another target during its cooldown',()=> {
    const {b,source,victim,reserve}=pair();tick(b,0.15)
    expect(victim.routing).toBe(true)
    const cooldown=source.terrorCooldown
    park(victim,220,190);park(reserve,100,102);source.soldiers[0].meleeCd=0
    tick(b,0.15)
    expect(reserve.taken.length).toBeGreaterThan(0);expect(reserve.routing).toBe(false)
    expect(source.terrorCooldown).toBeCloseTo(cooldown-0.15)
    expect(reserve.terrorCooldown).toBe(0)
  })

  it('different terror-causing units have independent cooldowns',()=> {
    const {b,source,victim,reserve}=pair();tick(b,0.15)
    expect(victim.routing).toBe(true)
    const cooldown=source.terrorCooldown
    park(victim,220,190);park(reserve,130,102)
    // A distant reserve: two monsters against one standing sword would otherwise be pushed past its losing mark first.
    one(b,0,'sword',20,20)
    const second=one(b,1,'monster',130,100)
    const start=b.time
    tick(b,0.15)
    expect(reserve.routing).toBe(true)
    expect(second.terrorCooldown).toBeGreaterThan(MECHANICS.terrorCooldown-0.2)
    expect(source.terrorCooldown).toBeCloseTo(cooldown-(b.time-start))
    expect(reserve.terrorCooldown).toBe(0)
  })

  it('expiry requires a fresh hit; it does not replay damage dealt during the cooldown',()=> {
    const {b,source,victim,reserve}=pair();tick(b,0.15)
    park(victim,220,190);park(reserve,100,102);source.soldiers[0].meleeCd=0
    tick(b,0.15)
    expect(reserve.taken.length).toBeGreaterThan(0);expect(reserve.routing).toBe(false)
    source.terrorCooldown=0.05;source.soldiers[0].meleeCd=100
    step(b,0.05)
    expect(source.terrorCooldown).toBe(0);expect(reserve.routing).toBe(false)
    // The monster's blow threw him clear (RULES 四.8), and a man on the ground cannot be hit: back on his feet, in reach.
    park(reserve,100,102);reserve.soldiers[0].down=0
    source.soldiers[0].meleeCd=0;tick(b,0.15)
    expect(reserve.routing).toBe(true)
    expect(source.terrorCooldown).toBeGreaterThan(MECHANICS.terrorCooldown-0.2)
  })

  it('high leadership does not spend the source cooldown or queue a later terror proc',()=> {
    UNITS.sword={...UNITS.sword,leadership:75}
    const {b,source,victim}=pair();tick(b,0.15)
    expect(victim.taken.length).toBeGreaterThan(0)
    expect(victim.routing).toBe(false);expect(source.terrorCooldown).toBe(0)
    UNITS.sword={...UNITS.sword,leadership:20};source.soldiers[0].meleeCd=100
    step(b,0.05)
    expect(victim.leadership).toBeLessThan(MECHANICS.terrorLeadership)
    expect(victim.routing).toBe(false);expect(source.terrorCooldown).toBe(0)
  })

  it('one damaging splash can spend its source cooldown only once across regiments',()=> {
    const {b,source,victim,reserve}=pair()
    park(victim,99.5,102);park(reserve,100.5,102)
    tick(b,0.15)
    expect(victim.taken.length).toBeGreaterThan(0);expect(reserve.taken.length).toBeGreaterThan(0)
    expect([victim,reserve].filter(r=>r.routing)).toHaveLength(1)
    expect(source.terrorCooldown).toBeGreaterThan(MECHANICS.terrorCooldown-0.2)
  })

  it.each(['immunePsychology','causesTerror','unbreakable'] as const)('%s blocks terror without spending the source cooldown',trait=> {
    UNITS.sword={...UNITS.sword,[trait]:true}
    const {b,source,victim}=pair();tick(b,0.15)
    expect(victim.taken.length).toBeGreaterThan(0)
    expect(victim.routing).toBe(false);expect(source.terrorCooldown).toBe(0)
  })

  it('causing fear grants fear immunity but still permits damage-triggered terror',()=> {
    // Without the fear penalty its leadership must start under the terror line for a hit to break it.
    UNITS.sword={...UNITS.sword,causesFear:true,leadership:12}
    const {b,source,victim}=pair();tick(b,0.15)
    expect(victim.moraleFactors.fear).toBe(0)
    expect(victim.routing).toBe(true);expect(victim.terrorCooldown).toBe(0)
    expect(source.terrorCooldown).toBeGreaterThan(MECHANICS.terrorCooldown-0.2)
  })

  it('fear never stacks and remains active while its sources are cooling down',()=> {
    const {b,source,victim}=pair(12)
    const other=one(b,1,'monster',105,100)
    source.terrorCooldown=other.terrorCooldown=10
    step(b,0.05)
    expect(victim.moraleFactors.fear).toBe(MECHANICS.fearPenalty)
    expect(victim.routing).toBe(false)
    park(source,200,180);park(other,210,180);step(b,0.05)
    expect(victim.moraleFactors.fear).toBe(0)
  })
})
