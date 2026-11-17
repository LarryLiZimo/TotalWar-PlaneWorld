import {describe,it,expect,vi,afterEach} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {applyCommand} from '../src/sim/commands'
import {commandMove,commandBehavior,commandAttack,commandGroupFront,beginWidth,commandWidth,endWidth} from '../src/sim/orders'
import {battleSnapshot} from '../src/sim/diagnostics'
import {applyFrame,frameOf,packPoses,PoseHistory,readBattle,wireBattle} from '../src/sim/transport'
import type {BattleCommand} from '../src/sim/commands'
import type {Battle,Projectile} from '../src/sim/types'
import type {WorkerReply,WorkerRequest} from '../src/sim/worker-protocol'
import {BattleClient} from '../src/battle-client'
import {unitPanelData} from '../src/unit-panel'

function world() {const b=createEmptyBattle(42);spawn(b,0,'sword','a',100,100,0);spawn(b,1,'spear','b',150,100,Math.PI);return b}
class FakeWorker {
  static last:FakeWorker
  onmessage:((event:{data:WorkerReply})=>void)|null=null
  onerror:unknown=null
  readonly sent:WorkerRequest[]=[]
  constructor() {FakeWorker.last=this}
  postMessage(message:WorkerRequest):void {this.sent.push(message)}
  terminate():void {}
}
/** A BattleClient fed by an emulated worker: one soldier moving at 8 m/s, 20 Hz steps, publishes throttled to 30 Hz. */
function emulatedClient(speed:number) {
  const b=world(),s=b.regiments[0].soldiers[0]
  let now=0,stepWall=0,sent=-Infinity,current:Battle|null=null
  vi.spyOn(performance,'now').mockImplementation(()=>now)
  vi.stubGlobal('Worker',FakeWorker)
  const client=new BattleClient({scenario:'custom',seed:42},false,speed,battle=>{current=battle},()=>{},()=>{})
  const worker=FakeWorker.last,publish=()=>{worker.onmessage!({data:{kind:'frame',frame:structuredClone(frameOf(b,packPoses(b),[],false))}});sent=now}
  s.x=100;worker.onmessage!({data:{kind:'init',battle:structuredClone(wireBattle(b)),frame:structuredClone(frameOf(b,packPoses(b),[],false))}})
  const strides:number[]=[],shown=()=>client.display!.regiments[0].soldiers[0]
  return {
    strides,shown,current:()=>current!.regiments[0].soldiers[0],
    run(ms:number,paused:boolean):void {
      for(const end=now+ms;now+1e-9<end;) {
        now+=1000/60;let stepped=false
        while(!paused&&stepWall+50/speed<=now) {stepWall+=50/speed;b.time=Math.round((b.time+.05)*1000)/1000;s.x=100+8*b.time;stepped=true}
        if(stepped&&now-sent>=1000/30) publish()
        const x=shown().x;client.presentation(now,paused);strides.push(shown().x-x)
      }
    },
    control(paused:boolean,next:number):void {client.control(paused,next);speed=next;stepWall=now;publish();strides.length=0},
  }
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
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
  it('leaves the damage and terror event logs in the worker but still carries what the panel reads',()=> {
    const b=world(),v=readBattle(structuredClone(wireBattle(b))),r=b.regiments[0]
    r.dealt.push({t:0,v:5,melee:true});r.taken.push({t:0,v:3,melee:true});r.terrorHits.push(b.regiments[1].id);r.moraleFactors={recentLosses:-4};r.leadership=61
    const frame=structuredClone(frameOf(b,packPoses(b),[],false))
    for(const key of ['soldiers','dealt','taken','terrorHits']) expect(Object.hasOwn(frame.regiments[0],key)).toBe(false)
    applyFrame(v,frame)
    expect(v.regiments[0].dealt).toEqual([]);expect(v.regiments[0].soldiers).toHaveLength(r.soldiers.length)
    expect(unitPanelData(v.regiments[0]).rows.find(row=>row.key==='leadership')).toMatchObject({value:61,hint:'骤然减员 -4'})
  })
  it('draws deaths, projectiles and effects at the displayed time, not at the newest frame',()=> {
    const b=world(),display=readBattle(structuredClone(wireBattle(b))),history=new PoseHistory(),origin=performance.timeOrigin
    const s=b.regiments[0].soldiers[0],shot={...{x:110,y:100,vx:40,vy:0,z:1.5,vz:2,gravity:9.81},arc:false} as Projectile
    const send=(time:number,sent:number)=> {
      b.time=time;const f=structuredClone(frameOf(b,packPoses(b),[],false));f.sentAt=origin+sent
      applyFrame(display,f,false);history.add(f)
    }
    send(0,0)
    s.x+=.1;b.projectiles=[shot];b.fx=[{x:110,y:101,text:'-9',life:.75}];send(.05,50)
    Object.assign(s,{x:s.x+.1,hp:0,alive:false,deathTime:.1});b.projectiles=[];b.fx=[];send(.1,100)
    const shown=display.regiments[0].soldiers[0]
    history.sample(display,100,false);const time=history.sample(display,150,false)
    expect(time).toBeGreaterThan(.05);expect(time).toBeLessThan(.1)
    expect([shown.alive,shown.hp>0,shown.deathTime,display.time]).toEqual([true,true,-1,.05])
    expect(display.projectiles).toHaveLength(1)
    expect(display.projectiles[0].x).toBeCloseTo(110+40*(time-.05),9)
    expect(display.projectiles[0].z).toBeCloseTo(1.5+2*(time-.05)-.5*9.81*(time-.05)**2,9)
    expect(display.fx[0].life).toBeCloseTo(.75-(time-.05),9)
    expect(history.sample(display,250,false)).toBe(.1)
    expect([shown.alive,shown.hp,shown.deathTime,display.time,display.projectiles.length,display.fx.length]).toEqual([false,0,Math.fround(.1),.1,0,0])
  })
  for(const [from,to] of [[5,1],[1,1]]) it(`keeps the display moving without a jump or a stall on a ${from}× → ${to}× speed click`,()=> {
    const h=emulatedClient(from);h.run(2000,false)
    const normal=Math.max(...h.strides.slice(60))
    h.control(false,to);h.run(300,false)
    expect(Math.max(...h.strides)).toBeLessThanOrEqual(normal*1.1)
    expect(h.strides.every(d=>d>0)).toBe(true)
  })
  it('plays out the buffered delay on pause, then holds the authoritative pose, and resumes without a jump',()=> {
    const h=emulatedClient(5);h.run(2000,false)
    const normal=Math.max(...h.strides.slice(60))
    h.control(true,5);h.run(300,true)
    expect(Math.max(...h.strides)).toBeLessThanOrEqual(normal*1.1)
    expect(h.strides.slice(-6).every(d=>d===0)).toBe(true)
    expect(h.shown().x).toBe(h.current().x)
    h.control(false,5);h.run(300,false)
    expect(Math.max(...h.strides)).toBeLessThanOrEqual(normal*1.1)
    expect(h.shown().x).toBeGreaterThan(h.current().x-normal*30)
  })
})
