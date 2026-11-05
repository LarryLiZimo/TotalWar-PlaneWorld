import type { Battle,Regiment,Soldier } from './types'
import { angDiff } from './math'

export const POSE_STRIDE=17
export type BattleWire=Omit<Battle,'rng'|'sendCommand'|'soldierById'>
export type RegimentWire=Omit<Regiment,'soldiers'>
export interface StateFrame {
  time:number;sentAt:number;poses:Float32Array;regiments:RegimentWire[]
  projectiles:Battle['projectiles'];fx:Battle['fx'];notices:Battle['notices']
  winner:Battle['winner'];aiEnabled:boolean;stepTimes:number[];limited:boolean
}
export function wireBattle(b:Battle):BattleWire {
  const {rng:_,sendCommand:__,soldierById:___,...wire}=b
  return wire
}
export function readBattle(wire:BattleWire):Battle {
  return {...wire,rng:()=>{throw new Error('主线程只读视图不可执行模拟')},soldierById:new Map(wire.regiments.flatMap(r=>r.soldiers.map(s=>[s.id,s] as const)))}
}
export function packPoses(b:Battle,buffer?:ArrayBuffer):Float32Array {
  const count=b.regiments.reduce((n,r)=>n+r.soldiers.length,0)
  const length=count*POSE_STRIDE+b.regiments.length*3
  const data=buffer?.byteLength===length*4?new Float32Array(buffer):new Float32Array(length)
  let at=0
  for(const r of b.regiments) for(const s of r.soldiers) {
    data[at++]=s.x;data[at++]=s.y;data[at++]=s.facing;data[at++]=s.speed
    data[at++]=s.hp;data[at++]=s.down;data[at++]=s.flash;data[at++]=s.chargeLeft
    data[at++]=s.ammo;data[at++]=s.deathTime;data[at++]=s.file;data[at++]=s.rank
    data[at++]=s.centerIndex;data[at++]=s.swing?.left??-1
    data[at++]=(s.alive?1:0)|(s.wounded?2:0)|(s.escaped?4:0);data[at++]=s.vx;data[at++]=s.vy
  }
  for(const r of b.regiments) {data[at++]=r.anchorX;data[at++]=r.anchorY;data[at++]=r.facing}
  return data
}
export function frameOf(b:Battle,poses:Float32Array,stepTimes:number[],limited:boolean):StateFrame {
  return {time:b.time,sentAt:performance.timeOrigin+performance.now(),poses,regiments:b.regiments.map(({soldiers:_,...r})=>r),projectiles:b.projectiles,fx:b.fx,notices:b.notices,winner:b.winner,aiEnabled:b.aiEnabled,stepTimes,limited}
}
function readSoldier(s:Soldier,data:Float32Array,at:number,move:boolean):void {
  if(move) {
    s.prevX=s.x;s.prevY=s.y;s.prevFacing=s.facing
    s.x=data[at];s.y=data[at+1];s.facing=data[at+2]
  }
  s.speed=data[at+3]
  s.hp=data[at+4];s.down=data[at+5];s.flash=data[at+6];s.chargeLeft=data[at+7]
  s.ammo=data[at+8];s.deathTime=data[at+9];s.file=data[at+10];s.rank=data[at+11];s.centerIndex=data[at+12]
  const left=data[at+13];s.swing=left<0?null:{left,facing:s.facing,targetId:0}
  s.alive=!!(data[at+14]&1);s.wounded=!!(data[at+14]&2);s.escaped=!!(data[at+14]&4);s.vx=data[at+15];s.vy=data[at+16]
}
export function applyFrame(b:Battle,frame:StateFrame,move=true):void {
  b.time=frame.time;b.projectiles=frame.projectiles;b.fx=frame.fx;b.notices=frame.notices;b.winner=frame.winner;b.aiEnabled=frame.aiEnabled
  let at=0
  for(let i=0;i<b.regiments.length;i++) {
    const r=b.regiments[i],x=r.anchorX,y=r.anchorY,facing=r.facing
    Object.assign(r,frame.regiments[i])
    if(!move) {r.anchorX=x;r.anchorY=y;r.facing=facing}
    for(const s of r.soldiers) {readSoldier(s,frame.poses,at,move);at+=POSE_STRIDE}
  }
}
/** A short buffered history decouples display cadence from worker step bursts. */
export class PoseHistory {
  private frames:StateFrame[]=[]
  private shown:number|null=null
  private lastNow:number|null=null
  private rate=1
  constructor(private readonly recycle:(data:Float32Array)=>void=()=>{}) {}
  add(frame:StateFrame):void {
    const last=this.frames.at(-1)
    if(last&&frame.time===last.time) {this.recycle(this.frames.pop()!.poses)}
    this.frames.push(frame)
    while(this.frames.length>16) this.recycle(this.frames.shift()!.poses)
    const first=this.frames[0]
    if(frame.sentAt-first.sentAt>150) this.rate=Math.max(.05,(frame.time-first.time)*1000/(frame.sentAt-first.sentAt))
  }
  clear():void {for(const f of this.frames)this.recycle(f.poses);this.frames=[];this.shown=null;this.lastNow=null}
  rebase(rate:number):void {
    while(this.frames.length>1) this.recycle(this.frames.shift()!.poses)
    this.rate=rate;this.shown=null;this.lastNow=null
  }
  sample(display:Battle,now:number,paused:boolean):number {
    const latest=this.frames.at(-1)
    if(!latest) return display.time
    const elapsed=this.lastNow===null?0:Math.min(.1,Math.max(0,(now-this.lastNow)/1000))
    this.lastNow=now
    const delay=Math.max(.1,this.rate*.065)
    const sourceAge=Math.max(0,(performance.timeOrigin+now-latest.sentAt)/1000)
    const target=latest.time+Math.min(.1,sourceAge)*this.rate-delay
    if(this.shown===null||paused) this.shown=paused?latest.time:Math.max(this.frames[0].time,target)
    else this.shown=Math.max(this.shown,this.shown+elapsed*this.rate+(target-this.shown)*Math.min(1,elapsed*3))
    this.shown=Math.min(latest.time,Math.max(this.frames[0].time,this.shown))
    let a=this.frames[0],b=latest
    for(let i=1;i<this.frames.length;i++) if(this.frames[i].time>=this.shown) {a=this.frames[i-1];b=this.frames[i];break}
    const alpha=b.time===a.time?1:Math.max(0,Math.min(1,(this.shown-a.time)/(b.time-a.time)))
    let at=0
    for(const r of display.regiments) for(const s of r.soldiers) {
      s.prevX=s.x=a.poses[at]+(b.poses[at]-a.poses[at])*alpha
      s.prevY=s.y=a.poses[at+1]+(b.poses[at+1]-a.poses[at+1])*alpha
      s.prevFacing=s.facing=a.poses[at+2]+angDiff(a.poses[at+2],b.poses[at+2])*alpha
      at+=POSE_STRIDE
    }
    for(const r of display.regiments) {
      r.anchorX=a.poses[at]+(b.poses[at]-a.poses[at])*alpha
      r.anchorY=a.poses[at+1]+(b.poses[at+1]-a.poses[at+1])*alpha
      r.facing=a.poses[at+2]+angDiff(a.poses[at+2],b.poses[at+2])*alpha;at+=3
    }
    return this.shown
  }
}
