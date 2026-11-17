import type { Battle } from './sim/types'
import type { BattleCommand } from './sim/commands'
import { applyFrame,PoseHistory,readBattle } from './sim/transport'
import type { BattleSource,WorkerReply,WorkerRequest } from './sim/worker-protocol'

export class BattleClient {
  private readonly worker:Worker
  private readonly history:PoseHistory
  private shown:Battle|null=null
  private current:Battle|null=null
  private snapshotId=0
  private disposed=false
  private paused:boolean
  private speed:number
  private snapshots=new Map<number,{resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  ready=false
  limited=false
  stepMs=0
  constructor(source:BattleSource,paused:boolean,speed:number,private readonly onBattle:(battle:Battle)=>void,private readonly onSteps:(times:number[])=>void,private readonly onError:(message:string)=>void) {
    this.paused=paused;this.speed=speed
    this.worker=new Worker(new URL('./sim/battle.worker.ts',import.meta.url),{type:'module'})
    this.history=new PoseHistory(data=>this.send({kind:'recycle',buffer:data.buffer as ArrayBuffer},[data.buffer as ArrayBuffer]))
    this.worker.onmessage=({data}:MessageEvent<WorkerReply>)=> {
      if(this.disposed) return
      if(data.kind==='error') {this.onError(data.message);return}
      if(data.kind==='snapshot') {
        const request=this.snapshots.get(data.requestId)
        if(request) {clearTimeout(request.timer);this.snapshots.delete(data.requestId);request.resolve(data.snapshot)}
        return
      }
      if(data.kind==='init') {
        this.current=readBattle(data.battle)
        this.shown=readBattle(structuredClone(data.battle))
        this.current.sendCommand=command=>this.send({kind:'command',command})
        this.shown.sendCommand=this.current.sendCommand
        this.ready=true;this.onBattle(this.current)
      }
      if(!this.current||!this.shown) return
      applyFrame(this.current,data.frame);applyFrame(this.shown,data.frame,false)
      this.limited=data.frame.limited
      if(data.frame.stepTimes.length) this.stepMs=data.frame.stepTimes.at(-1)!
      this.onSteps(data.frame.stepTimes)
      this.history.add(data.frame)
    }
    this.worker.onerror=event=>this.onError(event.message||'模拟线程异常')
    this.send({kind:'init',source,paused,speed})
  }
  private send(message:WorkerRequest,transfer?:Transferable[]):void {if(!this.disposed)this.worker.postMessage(message,transfer??[])}
  get display():Battle|null {return this.shown}
  /** Always forwarded (the worker also pauses itself on an error); the display clock keeps running across the change. */
  control(paused:boolean,speed:number):void {
    if(paused!==this.paused||speed!==this.speed) this.history.setRate(speed)
    this.paused=paused;this.speed=speed;this.send({kind:'control',paused,speed})
  }
  command(command:BattleCommand):void {this.send({kind:'command',command})}
  singleStep():void {this.send({kind:'step'})}
  presentation(now:number,paused:boolean):{battle:Battle;time:number}|null {
    if(!this.shown) return null
    return {battle:this.shown,time:this.history.sample(this.shown,now,paused)}
  }
  snapshot():Promise<unknown> {
    const requestId=++this.snapshotId
    return new Promise((resolve,reject)=> {
      const timer=setTimeout(()=>{this.snapshots.delete(requestId);reject(new Error('现场导出超时，请稍后重试'))},10000)
      this.snapshots.set(requestId,{resolve,reject,timer});this.send({kind:'snapshot',requestId})
    })
  }
  dispose():void {
    // Terminate first: history buffers can simply be collected with this client.
    this.disposed=true;this.worker.terminate()
    for(const {reject,timer} of this.snapshots.values()) {clearTimeout(timer);reject(new Error('战局已重置'))}
    this.snapshots.clear()
  }
}
