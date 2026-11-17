import {afterEach,describe,expect,it,vi} from 'vitest'
import type {Battle} from '../src/sim/types'
import {SIM_DT} from '../src/sim/types'
import type {WorkerReply,WorkerRequest} from '../src/sim/worker-protocol'

// One virtual clock drives performance.now, timers, MessageChannel deliveries and, when set, the cost of each step.
const clock=vi.hoisted(()=>({now:0,stepCost:0}))
vi.mock('../src/sim/battle',async importOriginal=> {
  const actual=await importOriginal<typeof import('../src/sim/battle')>()
  return {...actual,step:(b:Battle,dt:number)=>{clock.now+=clock.stepCost;actual.step(b,dt)}}
})
type Task={at:number;order:number;run:()=>void}
let tasks:Task[]=[],order=0,wakeups=0
const enqueue=(delay:number,run:()=>void)=>{tasks.push({at:clock.now+delay,order:order++,run})}
class FakeChannel {
  port1:{onmessage:((event:{data:unknown})=>void)|null}={onmessage:null}
  port2={postMessage:(data:unknown)=>enqueue(0,()=>this.port1.onmessage?.({data}))}
}
// Browsers clamp nested timers, as every timer in a self-rescheduling loop is, to at least 4 ms.
const fakeSetTimeout=(run:()=>void,ms=0)=>{enqueue(Math.max(4,ms),run);return 0}
function runFor(ms:number):void {
  const end=clock.now+ms
  for(;;) {
    tasks.sort((a,b)=>a.at-b.at||a.order-b.order)
    const next=tasks[0]
    if(!next||next.at>end) break
    tasks.shift();clock.now=Math.max(clock.now,next.at);wakeups++;next.run()
  }
  clock.now=Math.max(clock.now,end)
}
/** Loads a fresh copy of the real battle.worker.ts against the virtual clock. */
async function loadWorker() {
  vi.resetModules()
  tasks=[];order=0;wakeups=0;clock.now=0;clock.stepCost=0
  const replies:WorkerReply[]=[]
  const scope={postMessage:(reply:WorkerReply)=>{replies.push(reply)},onmessage:null as ((event:{data:WorkerRequest})=>void)|null}
  vi.stubGlobal('self',scope)
  vi.stubGlobal('performance',{now:()=>clock.now,timeOrigin:0})
  vi.stubGlobal('setTimeout',fakeSetTimeout)
  vi.stubGlobal('MessageChannel',FakeChannel)
  await import('../src/sim/battle.worker')
  let request=0
  return {
    post:(data:WorkerRequest)=>scope.onmessage!({data}),
    frames:()=>replies.flatMap(r=>r.kind==='frame'||r.kind==='init'?[r.frame]:[]),
    snapshot:()=> {
      const requestId=++request;scope.onmessage!({data:{kind:'snapshot',requestId}})
      const reply=replies.at(-1)!
      if(reply.kind!=='snapshot'||reply.requestId!==requestId) throw new Error('no snapshot reply')
      return {...reply,state:reply.snapshot as {time:number;winner:number|null}}
    },
  }
}
afterEach(()=>{vi.unstubAllGlobals();clock.stepCost=0})

describe('worker loop under a virtual clock',()=> {
  for(const speed of [2,5]) it(`posts the decided frame at ${speed}× and plays on until it is paused`,async()=> {
    const w=await loadWorker()
    w.post({kind:'init',source:{scenario:'chariot',seed:20261104},paused:false,speed})
    w.post({kind:'command',command:{kind:'ai',enabled:true}})
    // The first rout comes after about 20 s of battle time and decides nothing; the power bar is pushed over at about
    // 35 s. Nothing else is sent meanwhile. Which side wins depends on the rule AI; this test only needs the decision
    // to reach the main thread.
    runFor(42000/speed+2000)
    const decided=w.frames().find(frame=>frame.winner!==null)!
    expect(decided).toBeDefined()
    // A decided battle runs on (the beaten flee the field), so the worker keeps stepping and posting.
    const {state}=w.snapshot()
    expect(state.winner).toBe(decided.winner)
    expect(state.time).toBeGreaterThan(decided.time+1)
    expect(w.frames().at(-1)!.time).toBeGreaterThan(decided.time+1)
    // Pausing it, as 结束战斗 does, is what stops the loop: no step and no timer after that.
    w.post({kind:'control',paused:true,speed})
    const time=w.snapshot().state.time
    runFor(1000)
    expect(w.snapshot().state.time).toBe(time)
    expect(tasks).toHaveLength(0)
  })
  it('continues a CPU-bound backlog without the 4 ms timer clamp',async()=> {
    const w=await loadWorker()
    w.post({kind:'init',source:{scenario:'reform',seed:20261104},paused:false,speed:5})
    clock.stepCost=18.5
    runFor(3000)
    // One 18.5 ms step after another reaches 2.7×; a clamped 4 ms gap after each step would give 2.2×.
    expect(w.snapshot().state.time).toBeGreaterThan(.97*3000/18.5*SIM_DT)
    expect(w.frames().at(-1)!.limited).toBe(true)
  })
  it('schedules nothing while idle and wakes on the messages that can make work',async()=> {
    const w=await loadWorker()
    expect(tasks).toHaveLength(0)
    w.post({kind:'init',source:{scenario:'reform',seed:20261104},paused:true,speed:1})
    runFor(1000)
    expect(wakeups).toBe(0)
    w.post({kind:'control',paused:false,speed:1})
    runFor(1000)
    const ran=wakeups,time=w.snapshot().state.time
    expect(ran).toBeGreaterThan(200)
    expect(time).toBeGreaterThanOrEqual(.9);expect(time).toBeLessThanOrEqual(1+1e-9)
    w.post({kind:'control',paused:true,speed:1})
    runFor(1000)
    expect(wakeups-ran).toBeLessThanOrEqual(1);expect(tasks).toHaveLength(0)
    w.post({kind:'step'});w.post({kind:'command',command:{kind:'ai',enabled:true}})
    expect(tasks).toHaveLength(0)
    expect(w.snapshot().state.time).toBeCloseTo(time+SIM_DT,9)
    w.post({kind:'control',paused:false,speed:2})
    runFor(1000)
    expect(w.snapshot().state.time).toBeGreaterThan(time+SIM_DT+1.8)
  })
  it('reuses a returned pose buffer of the right size and reports the pool',async()=> {
    const w=await loadWorker()
    w.post({kind:'init',source:{scenario:'reform',seed:20261104},paused:true,speed:1})
    const buffer=new ArrayBuffer(w.frames()[0].poses.byteLength)
    w.post({kind:'recycle',buffer})
    expect(w.snapshot().pool).toEqual({size:1,reused:0})
    w.post({kind:'step'})
    expect(w.frames().at(-1)!.poses.buffer).toBe(buffer)
    expect(w.snapshot().pool).toEqual({size:0,reused:1})
    w.post({kind:'recycle',buffer:new ArrayBuffer(8)});w.post({kind:'step'})
    expect(w.frames().at(-1)!.poses.byteLength).toBe(buffer.byteLength)
    expect(w.snapshot().pool).toEqual({size:0,reused:1})
  })
})
