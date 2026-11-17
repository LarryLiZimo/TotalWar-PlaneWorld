import { createArmyBattle } from './armies'
import { step } from './battle'
import { applyCommand } from './commands'
import { battleErrors,battleSnapshot } from './diagnostics'
import { createScenario } from './scenarios'
import { frameOf,packPoses,wireBattle } from './transport'
import type { Battle } from './types'
import { SIM_DT } from './types'
import type { WorkerReply,WorkerRequest } from './worker-protocol'

const scope=self as unknown as {postMessage:(reply:WorkerReply,transfer?:Transferable[])=>void;onmessage:((event:MessageEvent<WorkerRequest>)=>void)|null}
let battle:Battle|null=null,paused=true,speed=1,accumulator=0,last=performance.now(),sent=-Infinity,scheduled=false,reused=0
const recycled:ArrayBuffer[]=[],times:number[]=[]
// Nested timers are clamped to >= 4 ms even in workers: a backlog continues through a MessageChannel,
// setTimeout only paces the idle wait, and nothing is scheduled without a running battle. A decided battle runs on
// (the beaten army flees the field) until the main thread pauses it.
const wake=new MessageChannel()
wake.port1.onmessage=()=>{scheduled=false;tick()}
function running():boolean {return !!battle&&!paused}
function schedule():void {
  if(scheduled||!running()) return
  scheduled=true
  if(accumulator>=SIM_DT) wake.port2.postMessage(0)
  else setTimeout(()=>{scheduled=false;tick()},4)
}
function publish(initial=false):void {
  if(!battle) return
  const pooled=recycled.pop(),poses=packPoses(battle,pooled),frame=frameOf(battle,poses,times.splice(0),accumulator>=SIM_DT*2)
  if(pooled&&poses.buffer===pooled) reused++
  sent=performance.now()
  scope.postMessage(initial?{kind:'init',battle:wireBattle(battle),frame}:{kind:'frame',frame},[poses.buffer])
}
function advance():void {
  if(!battle) return
  const start=performance.now();step(battle,SIM_DT);times.push(performance.now()-start)
}
scope.onmessage=({data})=> {
  try {
    switch(data.kind) {
      case 'init':
        battle=data.source.setup?createArmyBattle(data.source.setup,data.source.seed):createScenario(data.source.scenario,data.source.seed)
        paused=data.paused;speed=data.speed;accumulator=0;last=performance.now();times.length=0;recycled.length=0;publish(true);schedule();break
      case 'control':paused=data.paused;speed=data.speed;accumulator=0;last=performance.now();publish();schedule();break
      case 'command':if(battle) {applyCommand(battle,data.command);publish()}break
      case 'step':paused=true;accumulator=0;advance();publish();break
      case 'recycle':if(recycled.length<20) recycled.push(data.buffer);break
      case 'snapshot':if(battle) scope.postMessage({kind:'snapshot',requestId:data.requestId,snapshot:{errors:battleErrors(battle),...battleSnapshot(battle)},pool:{size:recycled.length,reused}});break
    }
  } catch(error) {paused=true;scope.postMessage({kind:'error',message:String(error)})}
}
function tick():void {
  const now=performance.now(),elapsed=Math.min(.1,(now-last)/1000);last=now
  if(running()) {
    accumulator=Math.min(.3,accumulator+elapsed*speed)
    const began=performance.now()
    while(accumulator>=SIM_DT) {
      advance();accumulator-=SIM_DT
      if(performance.now()-began>=8) break
    }
  }
  if(times.length&&(!running()||performance.now()-sent>=1000/30)) publish()
  schedule()
}
