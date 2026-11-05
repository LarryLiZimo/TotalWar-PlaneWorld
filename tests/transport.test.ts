import {describe,it,expect} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {applyCommand} from '../src/sim/commands'
import {commandMove,commandBehavior,commandAttack,commandGroupFront,beginWidth,commandWidth,endWidth} from '../src/sim/orders'
import {battleSnapshot} from '../src/sim/diagnostics'
import {applyFrame,frameOf,packPoses,PoseHistory,readBattle,wireBattle} from '../src/sim/transport'
import type {BattleCommand} from '../src/sim/commands'

function world() {const b=createEmptyBattle(42);spawn(b,0,'sword','a',100,100,0);spawn(b,1,'spear','b',150,100,Math.PI);return b}
describe('worker state and input transport',()=> {
  it('clones a battle without functions and reconstructs a correct soldier index',()=> {
    const b=world(),v=readBattle(structuredClone(wireBattle(b)))
    expect(v.soldierById.get(v.regiments[0].soldiers[0].id)).toBe(v.regiments[0].soldiers[0])
    expect(battleSnapshot(v)).toEqual(battleSnapshot(b))
    expect(()=>v.rng()).toThrow()
  })
  it('carries poses, deaths, casualty slots, ammo and morale without replacing soldier objects',()=> {
    const b=world(),v=readBattle(structuredClone(wireBattle(b))),s=b.regiments[0].soldiers[0],before=v.regiments[0].soldiers[0]
    Object.assign(s,{x:100.125,y:99.875,facing:2.25,hp:0,alive:false,wounded:true,ammo:3,rank:2,centerIndex:1,deathTime:1.5})
    b.regiments[0].routing=true;b.regiments[0].moraleState='routing';b.time=2
    applyFrame(v,structuredClone(frameOf(b,packPoses(b),[12],false)))
    expect(v.regiments[0].soldiers[0]).toBe(before)
    expect([before.x,before.y,before.facing,before.hp,before.alive,before.wounded,before.ammo,before.rank,before.centerIndex,before.deathTime]).toEqual([100.125,99.875,2.25,0,false,true,3,2,1,1.5])
    expect(v.regiments[0].routing).toBe(true)
  })
  it('forwards all player order types to the simulation and preserves their outcome',()=> {
    const a=world(),b=world(),queue:BattleCommand[]=[]
    const view=readBattle(structuredClone(wireBattle(a)));view.sendCommand=c=>queue.push(c)
    const id=a.regiments[0].id,target=a.regiments[1].id
    const issue=(w:typeof a)=>{commandMove(w,[id],120,90,null);commandBehavior(w,[id],{run:false});beginWidth(w,id);commandWidth(w,id,20);endWidth(w,id);commandGroupFront(w,[id],110,95,125,95);commandAttack(w,[id],target)}
    issue(view);expect(a.regiments[0].order).toBe('hold');issue(b)
    for(const c of queue)applyCommand(a,c)
    for(let i=0;i<10;i++){step(a,.05);step(b,.05)}
    expect(battleSnapshot(a)).toEqual(battleSnapshot(b))
  })
  it('a newly received simulation frame does not move the rendered picking positions before interpolation',()=> {
    const b=world(),display=readBattle(structuredClone(wireBattle(b))),x=display.regiments[0].soldiers[0].x
    b.regiments[0].soldiers[0].x+=5;b.regiments[0].anchorX+=5
    applyFrame(display,frameOf(b,packPoses(b),[],false),false)
    expect(display.regiments[0].soldiers[0].x).toBe(x)
    expect(display.regiments[0].anchorX).toBe(100)
  })
  it('interpolates across angle wrap and freezes the latest pose on pause',()=> {
    const b=world(),display=readBattle(structuredClone(wireBattle(b))),history=new PoseHistory(),s=b.regiments[0].soldiers[0]
    const origin=performance.timeOrigin
    s.x=100;s.facing=Math.PI-.1;b.time=0
    const a=frameOf(b,packPoses(b),[],false);a.sentAt=origin;history.add(a)
    s.x=102;s.facing=-Math.PI+.1;b.time=.1
    const c=frameOf(b,packPoses(b),[],false);c.sentAt=origin+100;history.add(c)
    history.sample(display,100,false);const time=history.sample(display,150,false)
    const shown=display.regiments[0].soldiers[0]
    expect(time).toBeGreaterThan(0);expect(shown.x).toBeGreaterThan(100);expect(shown.x).toBeLessThan(102)
    expect(Math.abs(shown.facing)).toBeGreaterThan(3)
    expect(history.sample(display,200,true)).toBe(.1);expect(shown.x).toBe(102)
    history.sample(display,400,true);expect(shown.x).toBe(102)
  })
  it('keeps constant motion smooth when two simulation steps arrive together',()=> {
    const b=world(),display=readBattle(structuredClone(wireBattle(b))),history=new PoseHistory(),origin=performance.timeOrigin
    const s=b.regiments[0].soldiers[0],shown=display.regiments[0].soldiers[0]
    const make=(time:number,sent:number)=> {b.time=time;s.x=100+time*2;const f=frameOf(b,packPoses(b),[],false);f.sentAt=origin+sent;return f}
    history.add(make(0,0));let previous=shown.x,maxStride=0
    for(let i=0;i<=60;i++) {
      const ms=i*1000/60
      if(i&&i%6===0) {history.add(make(ms/1000-.05,ms));history.add(make(ms/1000,ms))}
      history.sample(display,ms,false)
      expect(shown.x).toBeGreaterThanOrEqual(previous)
      maxStride=Math.max(maxStride,shown.x-previous);previous=shown.x
    }
    expect(shown.x).toBeGreaterThan(101.5)
    expect(maxStride).toBeLessThan(.06)
  })
})
