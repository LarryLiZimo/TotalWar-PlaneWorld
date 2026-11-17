import {describe,expect,it} from 'vitest'
import {easeCamera,type Camera} from '../src/camera'
import {STEPS,figureExtent,figureVariants,paintFigure,type FigureState,type Pose} from '../src/scene/figures'
import {UNIT_GLYPH} from '../src/scene/banners'
import {advance,sceneOf,shake,watch} from '../src/scene/fx'
import {groundFor,layer,skyLayers} from '../src/scene/ground'
import {createScenario} from '../src/sim/scenarios'
import {step} from '../src/sim'
import {SIM_DT,type Side} from '../src/sim/types'
import {UNITS} from '../src/sim/units'

/** A pen that records how far from the figure's centre anything is drawn, and whether the pen itself was moved. */
function probe() {
  let reach=0,moved=0,width=1
  const far=(x:number,y:number,pad=0)=>{reach=Math.max(reach,Math.hypot(x,y)+pad)}
  const pen=new Proxy({}, {
    get:(_target,name)=> {
      if(name==='moveTo'||name==='lineTo') return (x:number,y:number)=>far(x,y,width/2)
      if(name==='ellipse') return (x:number,y:number,rx:number,ry:number)=>far(x,y,Math.max(rx,ry)+width/2)
      if(name==='arc') return (x:number,y:number,r:number)=>far(x,y,r+width/2)
      if(name==='quadraticCurveTo') return (cx:number,cy:number,x:number,y:number)=>{far(cx,cy,width/2);far(x,y,width/2)}
      if(name==='translate'||name==='rotate'||name==='scale'||name==='setTransform'||name==='save'||name==='restore') return ()=>{moved++}
      return ()=>{}
    },
    set:(_target,name,value)=>{if(name==='lineWidth') width=Number(value);return true},
  }) as unknown as CanvasRenderingContext2D
  return {pen,reach:()=>reach,moved:()=>moved}
}

describe('figures',()=> {
  const states:FigureState[]=['up','down','dead']
  it.each([3,8,14,22,40])('every unit type stays inside its glyph cell at any heading, stride and blow, and never moves the pen (zoom %s)',zoom=> {
    for(const def of Object.values(UNITS)) {
      const extent=figureExtent(def,zoom)
      for(const side of [0,1] as Side[]) for(const state of states) for(const step of [-1,0,2,5,STEPS-1]) for(const swing of [-1,0.05,0.55,0.62,0.99]) {
        const {pen,reach,moved}=probe()
        const pose:Pose={heading:1.1,step,swing,state,flash:false,selected:true,wounded:true,variant:(step+2)%figureVariants(def)}
        paintFigure(pen,def,side,zoom,pose)
        expect(reach(),`${def.type} ${state} step ${step} swing ${swing}`).toBeLessThanOrEqual(extent)
        expect(moved()).toBe(0)
      }
    }
  })

  it('gives every unit type a flag glyph and at least one look, and no two types of the roster share a glyph',()=> {
    const glyphs=Object.keys(UNITS).map(type=>UNIT_GLYPH[type as keyof typeof UNIT_GLYPH])
    expect(glyphs.every(glyph=>typeof glyph==='string'&&[...glyph].length===1)).toBe(true)
    expect(new Set(glyphs).size).toBe(glyphs.length)
    for(const def of Object.values(UNITS)) expect(figureVariants(def)).toBeGreaterThanOrEqual(1)
  })
})

describe('scene layers',()=> {
  it('fall back to nothing without OffscreenCanvas, so the renderer paints the plain field',()=> {
    expect(typeof OffscreenCanvas).toBe('undefined')
    expect(layer(64,64)).toBeNull()
    expect(groundFor(1,true)).toBeNull()
    expect(skyLayers()).toBeNull()
  })
})

describe('battle scene',()=> {
  const sounds=()=> {
    const heard:string[]=[]
    return {heard,sink:(kind:string)=>{heard.push(kind)}}
  }
  it('says nothing about the state it first sees, then reports the fallen once and keeps them on the field',()=> {
    const battle=createScenario('duel',3),scene=sceneOf(battle),{heard,sink}=sounds()
    const victim=battle.regiments.find(reg=>reg.soldiers.length>3)!.soldiers
    victim[0].alive=false;victim[0].deathTime=-1
    watch(scene,null,true,1,()=>1,sink)
    expect(heard).toEqual([])
    expect(scene.corpses).toHaveLength(0)
    expect(scene.live).toHaveLength(battle.regiments.reduce((n,reg)=>n+reg.soldiers.filter(s=>s.alive).length,0))

    battle.time+=SIM_DT
    victim[1].alive=false;victim[1].deathTime=battle.time
    // A routing man who leaves the field is gone, not dead.
    victim[2].alive=false;victim[2].escaped=true;victim[2].deathTime=-1
    watch(scene,null,true,1,()=>1,sink)
    expect(heard).toEqual(['death'])
    expect(scene.corpses).toHaveLength(1)
    expect(scene.corpses[0]).toMatchObject({x:victim[1].x,y:victim[1].y})
    expect(scene.live.some(body=>body.soldier===victim[1]||body.soldier===victim[2])).toBe(false)

    // The same step is not watched twice.
    watch(scene,null,true,1,()=>1,sink)
    expect(heard).toEqual(['death'])
  })

  it('turns a blow, a throw and a charge going home into sound, recoil, a tumble and a jolt of the camera',()=> {
    const battle=createScenario('cavalry',5),scene=sceneOf(battle),{heard,sink}=sounds()
    advance(scene,0,0)
    watch(scene,null,true,1,()=>1,sink)
    const rider=battle.regiments.find(reg=>reg.type==='heavyCavalry')!.soldiers[0],foot=battle.regiments.find(reg=>reg.type!=='heavyCavalry')!.soldiers
    battle.time+=SIM_DT
    foot[0].flash=0.12
    foot[1].down=2
    rider.chargeLeft=10;rider.chargePower=1
    watch(scene,null,true,1,()=>1,sink)
    expect(heard.sort()).toEqual(['chargeImpact','knockdown','meleeHit'])
    const body=(soldier:typeof rider)=>scene.entries.find(item=>item.soldier===soldier)!
    expect(body(foot[0]).recoil).toBeGreaterThan(0)
    expect(body(foot[1]).spin).not.toBe(0)
    expect(scene.trauma).toBeGreaterThan(0)
    expect(scene.particles.length).toBeGreaterThan(0)
    const [jx,jy]=shake(scene,1.234,8)
    expect(Math.hypot(jx,jy)).toBeGreaterThan(0)
    expect(Math.hypot(jx,jy)).toBeLessThanOrEqual(8*Math.SQRT2)

    // A charge that lands off screen shakes nothing; the same state next step is not a new event.
    const quiet=sceneOf(createScenario('cavalry',6))
    watch(quiet,null,false,1,()=>0)
    quiet.battle.time+=SIM_DT
    quiet.battle.regiments[0].soldiers[0].chargeLeft=10;quiet.battle.regiments[0].soldiers[0].chargePower=1
    watch(quiet,null,false,1,()=>0)
    expect(quiet.trauma).toBe(0)
    heard.length=0
    battle.time+=SIM_DT
    watch(scene,null,true,1,()=>1,sink)
    expect(heard).toEqual([])
  })

  it('ages its particles in battle time, holds them while paused and lets the shake die away in real time',()=> {
    const battle=createScenario('chariot',2),scene=sceneOf(battle)
    advance(scene,0,0)
    watch(scene,null,true,1,()=>1)
    // Drive the real simulation until the carts are in among the spears.
    for(let i=0;i<260;i++) {step(battle,SIM_DT);advance(scene,battle.time,SIM_DT);watch(scene,null,true,1,()=>1)}
    expect(scene.particles.length).toBeGreaterThan(0)
    const ages=scene.particles.map(p=>p.age)
    advance(scene,battle.time,1)
    expect(scene.particles.map(p=>p.age)).toEqual(ages)
    expect(scene.trauma).toBe(0)
    advance(scene,battle.time+60,0)
    // A jump of a minute is a new scene clock, not a minute of drift.
    expect(scene.particles.map(p=>p.age)).toEqual(ages)
    for(let t=0;t<8;t+=0.1) advance(scene,battle.time+60+t,0.1)
    expect(scene.particles).toHaveLength(0)
  })
})

describe('camera easing',()=> {
  it('glides the zoom to its target while the world point under the pointer stays there',()=> {
    const camera:Camera={x:150,y:115,zoom:4,glide:{zoom:16,sx:900,sy:200,wx:0,wy:0}}
    camera.glide!.wx=camera.x+(900-800)/4;camera.glide!.wy=camera.y-(200-450)/4
    const {wx,wy}=camera.glide!
    let last=camera.zoom
    for(let i=0;i<120&&camera.glide;i++) {
      easeCamera(camera,1600,900,1/60,0,0)
      expect(camera.zoom).toBeGreaterThanOrEqual(last);last=camera.zoom
      expect(camera.x+(900-800)/camera.zoom).toBeCloseTo(wx,6)
      expect(camera.y-(200-450)/camera.zoom).toBeCloseTo(wy,6)
    }
    expect(camera.glide).toBeNull()
    expect(camera.zoom).toBe(16)
  })

  it('brings a keyboard pan up to speed and back to rest, scaled to the view, and keeps the camera near the map',()=> {
    const camera:Camera={x:150,y:115,zoom:8}
    easeCamera(camera,1600,900,1/60,1,0)
    const first=camera.vx!
    expect(first).toBeGreaterThan(0)
    for(let i=0;i<60;i++) easeCamera(camera,1600,900,1/60,1,0)
    // Full speed crosses 85% of the view's width each second.
    expect(camera.vx!).toBeCloseTo(1600/8*0.85,0)
    expect(camera.vx!).toBeGreaterThan(first)
    for(let i=0;i<120;i++) easeCamera(camera,1600,900,1/60,0,0)
    expect(camera.vx).toBe(0)
    for(let i=0;i<600;i++) easeCamera(camera,1600,900,1/60,1,1)
    expect(camera.x).toBe(330)
    expect(camera.y).toBe(260)
  })
})
