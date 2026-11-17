import type { Battle,Floater,Projectile,Regiment,Soldier } from './types'
import { angDiff } from './math'

export const POSE_STRIDE=18
export type BattleWire=Omit<Battle,'rng'|'sendCommand'|'soldierById'>
/** Damage / terror event logs stay in the worker: the main thread reads only the derived morale factors, and snapshots come from the worker. */
export type RegimentWire=Omit<Regiment,'soldiers'|'dealt'|'taken'|'terrorHits'>
export interface StateFrame {
  time:number;sentAt:number;poses:Float32Array;regiments:RegimentWire[]
  projectiles:Battle['projectiles'];fx:Battle['fx'];notices:Battle['notices']
  winner:Battle['winner'];power:Battle['power'];aiEnabled:boolean;stepTimes:number[];limited:boolean
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
    data[at++]=(s.alive?1:0)|(s.wounded?2:0)|(s.escaped?4:0);data[at++]=s.vx;data[at++]=s.vy;data[at++]=s.chargePower
  }
  for(const r of b.regiments) {data[at++]=r.anchorX;data[at++]=r.anchorY;data[at++]=r.facing}
  return data
}
export function frameOf(b:Battle,poses:Float32Array,stepTimes:number[],limited:boolean):StateFrame {
  return {time:b.time,sentAt:performance.timeOrigin+performance.now(),poses,regiments:b.regiments.map(({soldiers:_,dealt:__,taken:___,terrorHits:____,...r})=>r),projectiles:b.projectiles,fx:b.fx,notices:b.notices,winner:b.winner,power:b.power,aiEnabled:b.aiEnabled,stepTimes,limited}
}
/** Non-pose slots: health, deaths, swings and the other discrete per-model state. */
function readState(s:Soldier,data:Float32Array,at:number):void {
  s.speed=data[at+3]
  s.hp=data[at+4];s.down=data[at+5];s.flash=data[at+6];s.chargeLeft=data[at+7]
  s.ammo=data[at+8];s.deathTime=data[at+9];s.file=data[at+10];s.rank=data[at+11];s.centerIndex=data[at+12]
  const left=data[at+13];s.swing=left<0?null:{left,facing:s.facing,targetId:0}
  s.alive=!!(data[at+14]&1);s.wounded=!!(data[at+14]&2);s.escaped=!!(data[at+14]&4);s.vx=data[at+15];s.vy=data[at+16];s.chargePower=data[at+17]
}
/** move=true updates the authoritative view. move=false updates only a display view's regiment summaries,
 * winner, power, AI flag and notices: its bodies, projectiles, effects and time follow PoseHistory.sample. */
export function applyFrame(b:Battle,frame:StateFrame,move=true):void {
  b.notices=frame.notices;b.winner=frame.winner;b.power=frame.power;b.aiEnabled=frame.aiEnabled
  if(move) {b.time=frame.time;b.projectiles=frame.projectiles;b.fx=frame.fx}
  let at=0
  for(let i=0;i<b.regiments.length;i++) {
    const r=b.regiments[i],x=r.anchorX,y=r.anchorY,facing=r.facing
    Object.assign(r,frame.regiments[i])
    if(!move) {r.anchorX=x;r.anchorY=y;r.facing=facing;continue}
    for(const s of r.soldiers) {
      s.prevX=s.x;s.prevY=s.y;s.prevFacing=s.facing
      s.x=frame.poses[at];s.y=frame.poses[at+1];s.facing=frame.poses[at+2]
      readState(s,frame.poses,at);at+=POSE_STRIDE
    }
  }
}
/** Between steps projectiles fly ballistically, so a frame's shots are carried forward to the shown time
 * (a hit or landing in between shows with the next frame). Copies are pooled; history frames stay unmodified. */
function shotsAt(source:Projectile[],into:Projectile[],dt:number):Projectile[] {
  if(dt<=0) return source
  into.length=Math.min(into.length,source.length)
  for(let i=0;i<source.length;i++) {
    const p=source[i],q=Object.assign(into[i]??={...p},p)
    q.x=p.x+p.vx*dt;q.y=p.y+p.vy*dt;q.z=p.z+p.vz*dt-.5*p.gravity*dt*dt
  }
  return into
}
function floatersAt(source:Floater[],into:Floater[],dt:number):Floater[] {
  if(dt<=0) return source
  let n=0
  for(const f of source) if(f.life>dt) Object.assign(into[n++]??={...f},f).life-=dt
  into.length=n
  return into
}
/** A short buffered history decouples display cadence from worker step bursts. */
export class PoseHistory {
  private frames:StateFrame[]=[]
  private shown:number|null=null
  private lastNow:number|null=null
  private rate=1
  /** Only frames sent after the last speed / pause change estimate the achieved rate. */
  private rateSince=-Infinity
  /** Frame whose discrete state the display currently holds. */
  private state:StateFrame|null=null
  private readonly shots:Projectile[]=[]
  private readonly floaters:Floater[]=[]
  constructor(private readonly recycle:(data:Float32Array)=>void=()=>{}) {}
  add(frame:StateFrame):void {
    const last=this.frames.at(-1)
    if(last&&frame.time===last.time) {this.recycle(this.frames.pop()!.poses)}
    this.frames.push(frame)
    while(this.frames.length>16) this.recycle(this.frames.shift()!.poses)
    const first=this.frames.find(f=>f.sentAt>=this.rateSince)
    if(first&&frame.sentAt-first.sentAt>150) this.rate=Math.max(.05,(frame.time-first.time)*1000/(frame.sentAt-first.sentAt))
  }
  clear():void {for(const f of this.frames)this.recycle(f.poses);this.frames=[];this.shown=null;this.lastNow=null;this.state=null}
  /** A speed or pause change keeps the buffered frames and the shown time, so the display does not jump;
   * the requested rate is used until frames sent after the change measure the achieved one. */
  setRate(rate:number,now=performance.now()):void {this.rate=rate;this.rateSince=performance.timeOrigin+now}
  sample(display:Battle,now:number,paused:boolean):number {
    const latest=this.frames.at(-1)
    if(!latest) return display.time
    const elapsed=this.lastNow===null?0:Math.min(.1,Math.max(0,(now-this.lastNow)/1000))
    this.lastNow=now
    const delay=Math.max(.1,this.rate*.065)
    const sourceAge=Math.max(0,(performance.timeOrigin+now-latest.sentAt)/1000)
    const target=latest.time+Math.min(.1,sourceAge)*this.rate-delay
    if(this.shown===null) this.shown=paused?latest.time:Math.max(this.frames[0].time,target)
    // Paused (or decided): play out the buffered delay, at most about 0.1 s of wall time, then hold the newest frame.
    else if(paused) this.shown+=elapsed*Math.max(1,this.rate)
    else this.shown=Math.max(this.shown,this.shown+elapsed*this.rate+(target-this.shown)*Math.min(1,elapsed*3))
    this.shown=Math.min(latest.time,Math.max(this.frames[0].time,this.shown))
    let a=this.frames[0],b=latest
    for(let i=1;i<this.frames.length;i++) if(this.frames[i].time>=this.shown) {a=this.frames[i-1];b=this.frames[i];break}
    const alpha=b.time===a.time?1:Math.max(0,Math.min(1,(this.shown-a.time)/(b.time-a.time)))
    // Discrete state (health, deaths, swings, corpses' age) comes from the newest frame not after the shown
    // time, so nothing is drawn before the interpolated bodies reach it; shots and effects are carried to it.
    const state=alpha>=1?b:a,fresh=state!==this.state,dt=this.shown-state.time
    if(fresh) {this.state=state;display.time=state.time}
    display.projectiles=shotsAt(state.projectiles,this.shots,dt);display.fx=floatersAt(state.fx,this.floaters,dt)
    let at=0
    for(const r of display.regiments) for(const s of r.soldiers) {
      s.prevX=s.x=a.poses[at]+(b.poses[at]-a.poses[at])*alpha
      s.prevY=s.y=a.poses[at+1]+(b.poses[at+1]-a.poses[at+1])*alpha
      s.prevFacing=s.facing=a.poses[at+2]+angDiff(a.poses[at+2],b.poses[at+2])*alpha
      if(fresh) readState(s,state.poses,at)
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
