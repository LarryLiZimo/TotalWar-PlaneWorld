import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createBattleAudio,MAX_AMBIENT_TICKS,MAX_STARTS_PER_FRAME,MAX_VOICES,type AudioView} from '../src/audio'
import {step} from '../src/sim/battle'
import {createScenario} from '../src/sim/scenarios'
import {SIM_DT} from '../src/sim/types'

/** Minimal Web Audio stand-in: every node accepts the calls the module makes and the context counts started sources. */
class FakeParam {
  value=0;target:number|null=null
  setValueAtTime(v:number){this.value=v;return this}
  linearRampToValueAtTime(){return this}
  exponentialRampToValueAtTime(){return this}
  setTargetAtTime(v:number){this.target=v;return this}
  cancelScheduledValues(){return this}
}
class FakeNode {
  gain=new FakeParam();frequency=new FakeParam();Q=new FakeParam();pan=new FakeParam();playbackRate=new FakeParam()
  threshold=new FakeParam();knee=new FakeParam();ratio=new FakeParam();attack=new FakeParam();release=new FakeParam()
  type='';buffer:unknown=null;loop=false;onended:(()=>void)|null=null
  constructor(private ctx:FakeAudioContext,private source=false) {}
  connect(){return this}
  disconnect(){}
  start(){if(this.source) this.ctx.started++}
  stop(){}
}
class FakeAudioContext {
  static instances:FakeAudioContext[]=[]
  started=0;currentTime=0;sampleRate=8000;state='running';closed=false
  destination={}
  constructor(){FakeAudioContext.instances.push(this)}
  createGain(){return new FakeNode(this)}
  createBiquadFilter(){return new FakeNode(this)}
  createStereoPanner(){return new FakeNode(this)}
  createDynamicsCompressor(){return new FakeNode(this)}
  createBufferSource(){return new FakeNode(this,true)}
  createOscillator(){return new FakeNode(this,true)}
  createBuffer(_channels:number,length:number,rate:number){const data=new Float32Array(length);return {duration:length/rate,getChannelData:()=>data}}
  resume(){this.state='running';return Promise.resolve()}
  suspend(){return Promise.resolve()}
  close(){this.closed=true;return Promise.resolve()}
}
function memoryStorage() {
  const map=new Map<string,string>()
  return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,String(v))},removeItem:(k:string)=>{map.delete(k)},clear:()=>map.clear()}
}
function view(battle=createScenario('cavalry'),paused=false):AudioView {
  return {battle,camera:{x:150,y:100,zoom:6},width:1200,height:800,time:battle.time,paused,speed:1}
}
const ctx=()=>FakeAudioContext.instances.at(-1)!
/** Advance the fake clock by one 60 Hz frame and update. */
function frame(audio:ReturnType<typeof createBattleAudio>,v:AudioView) {ctx().currentTime+=1/60;audio.update(v)}

beforeEach(()=>{FakeAudioContext.instances=[];vi.stubGlobal('localStorage',memoryStorage())})
afterEach(()=>{vi.unstubAllGlobals()})

describe('battle audio',()=> {
  it('builds no AudioContext and throws nothing before unlock()',()=> {
    vi.stubGlobal('AudioContext',FakeAudioContext)
    const audio=createBattleAudio()
    expect(()=>{audio.emit('meleeHit',150,100,0.5);audio.update(view());audio.setVolume(0.3);audio.setMuted(true);audio.setMuted(false)}).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(audio.stats().active).toBe(false)
    audio.unlock();audio.unlock()
    expect(FakeAudioContext.instances).toHaveLength(1)
    audio.dispose()
    expect(ctx().closed).toBe(true)
    expect(()=>{audio.unlock();audio.update(view());audio.emit('death',1,1)}).not.toThrow()
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('every method is a safe no-op without Web Audio',()=> {
    vi.stubGlobal('AudioContext',undefined)
    vi.stubGlobal('localStorage',undefined)
    const audio=createBattleAudio()
    expect(()=> {
      audio.unlock()
      for(let i=0;i<50;i++) audio.emit('gunShot',150,100,1)
      audio.emit('victory');audio.update(view());audio.setMuted(true);audio.setVolume(2);audio.dispose();audio.dispose()
    }).not.toThrow()
    expect(audio.muted).toBe(true)
    expect(audio.volume).toBe(1)
    expect(audio.stats().active).toBe(false)
  })

  it('clusters an emit flood and keeps the voice caps',()=> {
    vi.stubGlobal('AudioContext',FakeAudioContext)
    const audio=createBattleAudio();audio.unlock()
    const v=view()
    frame(audio,v)
    const kinds=['meleeHit','death','bowShot','gunShot','arrowLand','knockdown','chargeImpact'] as const
    for(let f=0;f<120;f++) {
      for(let i=0;i<500;i++) audio.emit(kinds[i%kinds.length],100+(i%100),80+(i%40),(i%10)/10)
      const before=ctx().started
      frame(audio,v)
      const s=audio.stats()
      expect(s.voices).toBeLessThanOrEqual(MAX_VOICES)
      expect(s.startedLastFrame).toBeLessThanOrEqual(MAX_STARTS_PER_FRAME)
      // Bounded node work per frame: one-shot voices plus ambience detail, never one voice per event.
      expect(ctx().started-before).toBeLessThan(MAX_STARTS_PER_FRAME*20+MAX_AMBIENT_TICKS*4+40)
    }
    expect(audio.stats().dropped).toBeGreaterThan(0)
    expect(audio.stats().pending).toBeLessThanOrEqual(500*kinds.length)
  })

  it('starts no one-shots while paused and fades the ambience out',()=> {
    vi.stubGlobal('AudioContext',FakeAudioContext)
    const audio=createBattleAudio();audio.unlock()
    const v=view(undefined,true)
    for(let f=0;f<30;f++) {
      for(let i=0;i<100;i++) audio.emit('gunShot',150,100,1)
      frame(audio,v)
      expect(audio.stats().startedLastFrame).toBe(0)
      expect(audio.stats().pending).toBe(0)
    }
    expect(audio.stats().voices).toBe(0)
  })

  it('persists mute and volume, and a muted mix starts nothing',()=> {
    vi.stubGlobal('AudioContext',FakeAudioContext)
    const first=createBattleAudio()
    expect(first.muted).toBe(false)
    first.setMuted(true);first.setVolume(0.25)
    const audio=createBattleAudio()
    expect(audio.muted).toBe(true)
    expect(audio.volume).toBe(0.25)
    audio.unlock()
    expect(audio.stats().outputGain).toBe(0)
    const v=view()
    frame(audio,v)
    const before=ctx().started
    for(let f=0;f<10;f++) {for(let i=0;i<50;i++) audio.emit('chargeImpact',150,100,1);frame(audio,v)}
    expect(audio.stats().voices).toBe(0)
    expect(ctx().started).toBe(before)
    audio.setMuted(false)
    expect(audio.stats().outputGain).toBeGreaterThan(0)
    audio.emit('chargeImpact',150,100,1);frame(audio,v);frame(audio,v);frame(audio,v);frame(audio,v)
    expect(audio.stats().voices).toBeGreaterThan(0)
  })

  it('survives a throwing localStorage',()=> {
    vi.stubGlobal('localStorage',{getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}})
    const audio=createBattleAudio()
    expect(()=>{audio.setMuted(true);audio.setVolume(0.5)}).not.toThrow()
    expect(audio.volume).toBe(0.5)
  })

  it('derives ambience from a running battle without error',()=> {
    vi.stubGlobal('AudioContext',FakeAudioContext)
    const battle=createScenario('cavalry')
    const audio=createBattleAudio();audio.unlock()
    const v=view(battle)
    let hooves=0,feet=0
    for(let f=0;f<240;f++) {
      step(battle,SIM_DT)
      v.time=battle.time
      expect(()=>frame(audio,v)).not.toThrow()
      hooves=Math.max(hooves,audio.stats().hooves);feet=Math.max(feet,audio.stats().feet)
    }
    expect(hooves).toBeGreaterThan(0)
    expect(feet).toBeGreaterThan(0)
    // Stingers and UI ticks are non-positional and always get through.
    audio.emit('victory');audio.emit('uiOrder')
    for(let f=0;f<4;f++) frame(audio,v)
    expect(audio.stats().voices).toBeGreaterThan(0)
    audio.dispose()
  })
})
