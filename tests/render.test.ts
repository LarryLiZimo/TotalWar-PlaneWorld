import {afterEach,describe,expect,it,vi} from 'vitest'
import {fitCamera,focusRegiment,worldToScreen,type Camera} from '../src/camera'
import {render,type RenderInput} from '../src/render'
import {createArmyBattle} from '../src/sim/armies'
import {flankHandles} from '../src/sim/formation'
import {FATIGUE,FATIGUE_NAMES,fatigueAt} from '../src/sim/mechanics'
import {MAP_HEIGHT,MAP_WIDTH} from '../src/sim/types'
import {unitDef} from '../src/sim/units'
import {SpriteBatch,spriteBatch} from '../src/sprite-batch'

function drawingSurface(width:number,height:number) {
  const calls:{name:string;args:unknown[]}[]=[]
  const contexts:{type:string;options?:CanvasRenderingContext2DSettings}[]=[]
  const context=new Proxy({}, {
    get:(_target,name)=> {
      if(name==='measureText') return (value:string)=>({width:value.length*7})
      if(name==='createLinearGradient') return ()=>({addColorStop(){}})
      return (...args:unknown[])=>{calls.push({name:String(name),args})}
    },set:()=>true,
  }) as CanvasRenderingContext2D
  return {canvas:{width,height,getContext:(type:string,options?:CanvasRenderingContext2DSettings)=>{contexts.push({type,options});return context}} as unknown as HTMLCanvasElement,calls,contexts}
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})

describe('battle rendering under display scaling',()=> {
  it.each([true,false])('keeps full-scene redraws synchronized without exposing a cleared frame (sprites %s)',cacheSprites=> {
    vi.stubGlobal('document',{createElement:()=>drawingSurface(1024,1024).canvas})
    const {canvas,calls,contexts}=drawingSurface(1600,900)
    const battle=createArmyBattle({player:'blackpowder',enemy:'knightly',scale:4},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,canvas.width,canvas.height)
    const view:RenderInput={battle,camera,selection:[],hoverId:null,drag:null,dragRegId:null,showBoxes:false,showStamina:false,cacheSprites}
    for(let i=0;i<2;i++) {
      calls.length=0;render(canvas,view)
      expect(contexts.every(request=>request.options?.desynchronized===false)).toBe(true)
      expect(calls[0]).toEqual({name:'fillRect',args:[0,0,1600,900]})
      expect(calls.some(call=>call.name==='clearRect')).toBe(false)
    }
  })

  it.each([1,1.25,1.5,2])('keeps an overview on the sprite path at DPR %s',pixelRatio=> {
    vi.stubGlobal('document',{createElement:()=>drawingSurface(1024,1024).canvas})
    const {canvas,calls}=drawingSurface(1600*pixelRatio,900*pixelRatio)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:8},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,canvas.width,canvas.height)
    render(canvas,{battle,camera,selection:[],hoverId:null,drag:null,dragRegId:null,showBoxes:false,showStamina:false})
    expect(calls.filter(call=>call.name==='drawImage')).toHaveLength(6368)
    // Each model must not fall back to a separate canvas rotation/path sequence.
    expect(calls.filter(call=>call.name==='rotate').length).toBeLessThan(100)
  })

  it('keeps a large overview on the sprite path even above the former logical zoom cutoff',()=> {
    vi.stubGlobal('document',{createElement:()=>drawingSurface(1024,1024).canvas})
    const {canvas,calls}=drawingSurface(2560,1440)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:8},43)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,canvas.width,canvas.height)
    expect(camera.zoom).toBeGreaterThan(4)
    render(canvas,{battle,camera,selection:[],hoverId:null,drag:null,dragRegId:null,showBoxes:false,showStamina:false})
    expect(calls.filter(call=>call.name==='drawImage')).toHaveLength(6368)
  })

  it('sizes atlas cells for large bodies and weapons at high DPI without crossing texture edges',()=> {
    const atlasSurfaces:ReturnType<typeof drawingSurface>[]=[]
    vi.stubGlobal('document',{createElement:()=>{const surface=drawingSurface(1024,1024);atlasSurfaces.push(surface);return surface.canvas}})
    const {canvas,calls}=drawingSurface(3200,1800)
    const battle=createArmyBattle({player:'monsters',enemy:'nomad',scale:8},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,canvas.width,canvas.height)
    const view:RenderInput={battle,camera,selection:[],hoverId:null,drag:null,dragRegId:null,showBoxes:false,showStamina:false}
    render(canvas,view)
    const sprites=calls.filter(call=>call.name==='drawImage')
    expect(sprites.length).toBeGreaterThan(1000)
    expect(sprites.some(call=>Number(call.args[3])>32)).toBe(true)
    const cellWidths=atlasSurfaces.flatMap(surface=>surface.calls.filter(call=>call.name==='clearRect').map(call=>Number(call.args[2])))
    const cellSize=Math.max(...cellWidths)
    for(const {args} of sprites) {
      const [,sx,sy,w,h]=args as [HTMLCanvasElement,number,number,number,number]
      expect(sx).toBeGreaterThanOrEqual(0);expect(sy).toBeGreaterThanOrEqual(0)
      expect(sx+w).toBeLessThanOrEqual(1024);expect(sy+h).toBeLessThanOrEqual(1024)
      expect(Math.floor(sx/cellSize)).toBe(Math.floor((sx+w-1)/cellSize))
      expect(Math.floor(sy/cellSize)).toBe(Math.floor((sy+h-1)/cellSize))
    }
  })
})

/** `at` orders calls across every recording surface. */
interface Call {name:string;args:unknown[];at?:number}
let clock=0
interface Surface {width:number;height:number;clientWidth?:number;kind?:'2d'|'gl';options?:CanvasRenderingContext2DSettings;calls:Call[];getContext:(type:string,options?:CanvasRenderingContext2DSettings)=>unknown}
/** A recording canvas: the 2D context also logs property writes; the WebGL2 context initialises the sprite batch. */
function surface(width:number,height:number,pixel?:number[]):Surface {
  const calls:Call[]=[]
  let context:unknown
  const target:Surface={width,height,calls,getContext:(type,options)=> {
    if(context) return context
    if(type==='webgl2') {target.kind='gl';return context=webgl(calls)}
    target.kind='2d';target.options=options
    return context=new Proxy({}, {
      get:(_target,name)=> {
        if(name==='measureText') return (value:string)=>({width:value.length*7})
        if(name==='createLinearGradient') return ()=>({addColorStop(){}})
        if(name==='getImageData') return (x:number,y:number,w:number,h:number)=> {
          calls.push({name:'getImageData',args:[x,y,w,h],at:clock++})
          const data=new Uint8ClampedArray(w*h*4)
          if(pixel) for(let i=0;i<data.length;i+=4) data.set(pixel,i)
          return {width:w,height:h,data}
        }
        return (...args:unknown[])=>{calls.push({name:String(name),args,at:clock++})}
      },
      set:(_target,name,value)=>{calls.push({name:`=${String(name)}`,args:[value],at:clock++});return true},
    })
  }}
  return target
}
function webgl(calls:Call[]):unknown {
  const handles=new Set(['createShader','createProgram','createVertexArray','createBuffer','createTexture','getUniformLocation'])
  return new Proxy({}, {get:(_target,name)=> {
    if(typeof name!=='string') return undefined
    if(/^[A-Z0-9_]+$/.test(name)) return name==='NO_ERROR'?0:name
    if(name==='getShaderParameter'||name==='getProgramParameter') return ()=>true
    if(name==='getError') return ()=>0
    if(name==='isContextLost') return ()=>false
    if(handles.has(name)) return ()=>({})
    return (...args:unknown[])=>{calls.push({name,args,at:clock++})}
  }})
}
function stubSurfaces(pixel?:number[]):Surface[] {
  const made:Surface[]=[]
  vi.stubGlobal('document',{createElement:()=>{const item=surface(0,0,pixel);made.push(item);return item}})
  return made
}
const element=(item:Surface)=>item as unknown as HTMLCanvasElement
const composites=(main:Surface)=>main.calls.filter(call=>call.name==='drawImage'&&(call.args[0] as Surface).kind==='gl').length
const uploads=(gl:Surface)=>gl.calls.filter(call=>call.name==='texSubImage3D'||call.name==='texImage3D')
/** Cell uploads carry getImageData pixels; layer clears carry a zeroed Uint8Array. */
const pixelUpload=(call:Call)=>call.args[10] instanceof Uint8ClampedArray
const covered=(sent:Call[],[x,y,w,h]:number[])=>sent.some(({args})=> {
  const [,,ux,uy,,uw,uh]=args as number[]
  return ux<=x&&uy<=y&&x+w<=ux+uw&&y+h<=uy+uh
})
const idle=(battle:RenderInput['battle'],camera:Camera):RenderInput=>({battle,camera,selection:[],hoverId:null,drag:null,dragRegId:null,showBoxes:false,showStamina:false})
/** Fresh headings, steps, swings and wound/flash states for every model force new glyphs. */
function churn(battle:RenderInput['battle'],frame:number):void {
  for(const reg of battle.regiments) for(const soldier of reg.soldiers) {
    soldier.facing=soldier.prevFacing=(soldier.id*0.61+frame*1.37)%(Math.PI*2)
    soldier.flash=(soldier.id+frame)%3===0?0.1:0
    soldier.wounded=(soldier.id+frame)%5===0
    soldier.speed=1
    soldier.swing={left:((soldier.id*7+frame*3)%11)/10*unitDef(reg.type).attack.windup,facing:0,targetId:-1}
  }
}

describe('sprite batch uploads and composites',()=> {
  it('uploads only repainted atlas cells as premultiplied pixel rectangles, never a whole canvas page',()=> {
    const made=stubSurfaces([200,100,50,128])
    const main=surface(3200,1800)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:8},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,main.width,main.height)
    const view=idle(battle,camera)
    render(element(main),view)
    const gl=made.find(item=>item.kind==='gl')!
    expect(gl).toBeDefined()
    const pages=made.filter(item=>item.kind==='2d')
    expect(pages.length).toBeGreaterThan(0)
    // Atlas pages stay CPU readable so cells can be read back without a GPU stall.
    for(const page of pages) expect(page.options?.willReadFrequently).toBe(true)
    expect(composites(main)).toBe(1)
    const first=uploads(gl)
    for(const {args} of first) expect(ArrayBuffer.isView(args[10])).toBe(true)
    // Each layer is cleared once when its page is first used; painted cells follow as rectangles.
    const clears=first.filter(call=>!pixelUpload(call))
    expect(clears.map(({args})=>args[4])).toEqual([...new Set(first.map(({args})=>args[4]))])
    for(const {args} of clears) {
      expect(args.slice(2,8)).toEqual([0,0,args[4],1024,1024,1])
      expect((args[10] as Uint8Array).every(value=>value===0)).toBe(true)
    }
    const cells=first.filter(pixelUpload)
    expect(cells.length).toBeGreaterThan(0)
    for(const {args} of pages.flatMap(page=>page.calls.filter(call=>call.name==='clearRect'))) expect(covered(cells,args as number[])).toBe(true)
    // getImageData is straight alpha; the texture holds premultiplied texels for ONE/ONE_MINUS_SRC_ALPHA blending.
    expect([...(cells[0].args[10] as Uint8ClampedArray).slice(0,4)]).toEqual([100,50,25,128])
    expect(gl.calls.some(call=>call.name==='pixelStorei'&&call.args[0]==='UNPACK_PREMULTIPLY_ALPHA_WEBGL'&&call.args[1])).toBe(false)

    for(const item of [gl,main,...pages]) item.calls.length=0
    view.selection=[battle.regiments[0].id]
    render(element(main),view)
    const painted=pages.flatMap(page=>page.calls.filter(call=>call.name==='clearRect').map(call=>call.args as number[]))
    const second=uploads(gl)
    expect(painted.length).toBeGreaterThan(0)
    expect(second.length).toBeGreaterThan(0)
    expect(composites(main)).toBe(1)
    const reads=pages.flatMap(page=>page.calls.filter(call=>call.name==='getImageData').map(call=>call.args))
    expect(reads).toHaveLength(second.length)
    for(const call of second) {
      const [,,x,y,,w,h,depth]=call.args as number[]
      expect(pixelUpload(call)).toBe(true)
      expect(depth).toBe(1)
      expect(w*h).toBeLessThan(1024*1024)
      expect(reads).toContainEqual([x,y,w,h])
    }
    for(const rect of painted) expect(covered(second,rect)).toBe(true)
    // New cells are allocated in order, so their rectangles cover exactly what was repainted.
    const area=(rects:number[][])=>rects.reduce((sum,[,,w,h])=>sum+w*h,0)
    expect(area(second.map(({args})=>[0,0,Number(args[5]),Number(args[6])]))).toBe(area(painted))
  })

  it('merges dirty cells into row rectangles and keeps cells of undrawn pages pending',()=> {
    const made=stubSurfaces()
    const batch=spriteBatch(element(surface(800,600)))!
    expect(batch).not.toBeNull()
    const gl=made.find(item=>item.kind==='gl')!
    const page=surface(1024,1024),other=surface(1024,1024),main=surface(800,600)
    const ctx=main.getContext('2d') as CanvasRenderingContext2D
    expect(batch.begin(800,600,1)).toBe(true)
    for(const x of [960,896]) batch.invalidate(element(page),x,0,64)
    for(let x=0;x<1024;x+=64) for(const y of [64,128]) batch.invalidate(element(page),x,y,64)
    // The untouched cell between them is re-sent from the unchanged canvas, which is harmless.
    batch.invalidate(element(page),128,192,64);batch.invalidate(element(page),0,192,64)
    batch.invalidate(element(page),0,512,64)
    batch.invalidate(element(other),64,0,64)
    batch.draw(element(page),0,64,64,10,10,1)
    batch.flush(ctx)
    const rects=(calls:Call[])=>calls.filter(pixelUpload).map(({args})=>[args[4],args[2],args[3],args[5],args[6]])
    expect(uploads(gl).filter(call=>!pixelUpload(call)).map(({args})=>args[4])).toEqual([0])
    expect(rects(uploads(gl))).toEqual([[0,896,0,128,64],[0,0,64,1024,128],[0,0,192,192,64],[0,0,512,64,64]])
    expect(composites(main)).toBe(1)

    // The second page's cell waits for the page's first draw; already uploaded cells are not sent again.
    gl.calls.length=0
    expect(batch.begin(800,600,1)).toBe(true)
    batch.draw(element(page),0,64,64,10,10,1);batch.draw(element(other),64,0,64,20,20,1)
    batch.flush(ctx)
    expect(uploads(gl).filter(call=>!pixelUpload(call)).map(({args})=>args[4])).toEqual([1])
    expect(rects(uploads(gl))).toEqual([[1,64,0,64,64]])
    expect(composites(main)).toBe(2)

    // A new generation drops pending cells and reassigns layers from zero.
    gl.calls.length=0
    batch.invalidate(element(other),0,0,64)
    expect(batch.begin(800,600,2)).toBe(true)
    batch.draw(element(page),0,0,64,0,0,1)
    batch.flush(ctx)
    expect(uploads(gl).map(({args})=>[args[4],pixelUpload({name:'',args})])).toEqual([[0,false]])
  })

  it('keeps one WebGL composite per frame after the atlas fills and evicts cells',()=> {
    const made=stubSurfaces()
    const main=surface(3840,2160)
    const battle=createArmyBattle({player:'classic',enemy:'advance',scale:4},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,main.width,main.height)
    const view=idle(battle,camera)
    let painted=0,cell=0
    for(let frame=0;frame<10;frame++) {
      // New glyphs every frame push the atlas past its cache limit.
      churn(battle,frame)
      main.calls.length=0
      render(element(main),view)
      expect(composites(main)).toBe(1)
      const gl=made.find(item=>item.kind==='gl')!,pages=made.filter(item=>item.kind==='2d')
      const sent=uploads(gl)
      for(const {args} of sent) expect(ArrayBuffer.isView(args[10])).toBe(true)
      const cells=sent.filter(pixelUpload)
      for(const page of pages) {
        const cleared=page.calls.filter(call=>call.name==='clearRect')
        painted+=cleared.length;if(cleared.length) cell=Number(cleared[0].args[2])
        // Every repainted cell reaches the texture within the same frame.
        for(const {args} of cleared) expect(covered(cells,args as number[])).toBe(true)
        page.calls.length=0
      }
      // At most one rectangle per dirty cell row of each page.
      expect(cells.length).toBeLessThanOrEqual(pages.length*1024/cell)
      gl.calls.length=0
    }
    const limit=Math.min(8192,(1024/cell)**2*16)
    expect(painted).toBeGreaterThan(limit*1.5)
    expect(made.filter(item=>item.kind==='2d').length).toBeLessThanOrEqual(16)
  })

  it('holds a whole melee at middle zoom: every body in a cell of its own size, weapons apart, nothing repainted the next frame',()=> {
    const made=stubSurfaces()
    const main=surface(2560,1440)
    const battle=createArmyBattle({player:'blackpowder',enemy:'advance',scale:8},42)
    // 12 px per metre: a halberdier with his weapon is some 80 px across, the man himself under 30. With one cell
    // size for every figure the atlas held 1024 glyphs here, fewer than one frame of a melee asks for, and repainted
    // and re-sent over a hundred of them every frame.
    const men=battle.regiments.flatMap(reg=>reg.soldiers)
    const camera:Camera={x:men.reduce((sum,s)=>sum+s.x,0)/men.length,y:men.reduce((sum,s)=>sum+s.y,0)/men.length,zoom:12}
    const view=idle(battle,camera)
    // Every man at his own heading, some striking, struck or wounded.
    churn(battle,0)
    const queued=vi.spyOn(SpriteBatch.prototype,'draw')
    render(element(main),view)
    const pages=made.filter(item=>item.kind==='2d'),gl=made.find(item=>item.kind==='gl')!
    const painted=()=>pages.flatMap(page=>page.calls.filter(call=>call.name==='clearRect'))
    const first=painted(),sizes=new Set(first.map(call=>Number(call.args[2])))
    expect(queued.mock.calls.length).toBeGreaterThan(3000)
    expect(first.length).toBeGreaterThan(1024)
    // Men on foot have the smallest cells and most of the glyphs; riders, brutes and the weapons have larger ones.
    expect(Math.min(...sizes)).toBe(32);expect(sizes.size).toBeGreaterThanOrEqual(3)
    expect(first.filter(call=>call.args[2]===32).length).toBeGreaterThan(first.length*0.6)
    expect(pages.length).toBeLessThanOrEqual(12)
    expect(composites(main)).toBe(1)
    // Nothing is drawn in place, and the same frame again finds every glyph where it was.
    expect(main.calls.filter(call=>call.name==='translate')).toHaveLength(0)
    for(const item of [main,gl,...pages]) item.calls.length=0
    render(element(main),view)
    expect(painted()).toHaveLength(0)
    expect(uploads(gl)).toHaveLength(0)
    expect(composites(main)).toBe(1)
  })

  it('flushes queued sprites before reusing their cells when one frame needs more glyphs than the atlas holds',()=> {
    const made=stubSurfaces()
    const main=surface(7680,4320)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:8},42)
    // Close in, a man's glyph needs a large cell and the atlas holds about a thousand of them; the view holds more men.
    const men=battle.regiments.filter(reg=>reg.side===0).flatMap(reg=>reg.soldiers)
    const camera:Camera={x:men.reduce((sum,s)=>sum+s.x,0)/men.length,y:men.reduce((sum,s)=>sum+s.y,0)/men.length,zoom:56}
    const view=idle(battle,camera)
    const queued:Call[]=[]
    const draw=SpriteBatch.prototype.draw
    vi.spyOn(SpriteBatch.prototype,'draw').mockImplementation(function(this:SpriteBatch,...args:Parameters<SpriteBatch['draw']>) {
      queued.push({name:'queue',args,at:clock++})
      return draw.apply(this,args)
    })
    for(let frame=0;frame<3;frame++) {
      churn(battle,frame)
      render(element(main),view)
      const gl=made.find(item=>item.kind==='gl')!,pages=made.filter(item=>item.kind==='2d')
      const repaints=pages.flatMap(page=>page.calls.filter(call=>call.name==='clearRect').map(call=>({...call,page})))
      const flushes=gl.calls.filter(call=>call.name==='drawArraysInstanced')
      // The bodies' cells are the smallest in use; even if every page held only those, the atlas would hold `limit`.
      const cell=Math.min(...repaints.map(call=>Number(call.args[2]))),limit=(1024/cell)**2*16
      expect(pages.length).toBe(16)
      // This frame alone references more distinct glyphs than the atlas holds, so cells it queued get reused.
      expect(repaints.length).toBeGreaterThan(limit)
      expect(composites(main)).toBe(flushes.length)
      expect(flushes.length).toBeGreaterThanOrEqual(2)
      expect(flushes.length).toBeLessThanOrEqual(8)
      // Replay in call order: a cell queued since the last flush must keep its glyph until that flush samples it.
      const events=[
        ...queued.map(call=>({kind:'queue',call})),...repaints.map(call=>({kind:'paint',call})),...flushes.map(call=>({kind:'flush',call})),
      ].sort((a,b)=>a.call.at!-b.call.at!)
      let pending=new Set<string>(),segment=0,stale=0,sampled=0
      for(const {kind,call} of events) {
        if(kind==='queue') {
          const [page,sx,sy,size]=call.args as [Surface,number,number,number]
          pending.add(`${pages.indexOf(page)}:${sx+size/2}:${sy+size/2}`);segment++
        } else if(kind==='paint') {
          const [x,y,w]=call.args as number[]
          if(pending.has(`${pages.indexOf((call as Call&{page:Surface}).page)}:${x+w/2}:${y+w/2}`)) stale++
        } else {
          expect(call.args[3]).toBe(segment)
          sampled+=segment;pending=new Set();segment=0
        }
      }
      expect(segment).toBe(0)
      expect(sampled).toBe(queued.length)
      expect(sampled).toBeGreaterThan(limit)
      expect(stale).toBe(0)
      for(const item of [main,gl,...pages]) item.calls.length=0
      queued.length=0
    }
  })

  it('keeps close-up bodies and their weapons on the glyph layer: a body glyph and a turned weapon glyph each, one composite',()=> {
    stubSurfaces()
    const main=surface(3840,2160)
    const battle=createArmyBattle({player:'knightly',enemy:'knightly',scale:8},42)
    // At 22 px per metre a demigryph with its lance is far too wide for a body's cell. The body is cached without it,
    // and the lance is one glyph for every heading, turned by the sprite layer: nothing is drawn in place.
    const camera:Camera={x:0,y:0,zoom:22}
    const riders=battle.regiments.find(reg=>reg.type==='demigryph')!
    for(const reg of battle.regiments) {
      if(reg===riders) continue
      reg.aliveCount=0
      for(const soldier of reg.soldiers) {soldier.alive=false;soldier.deathTime=-10}
    }
    riders.soldiers.forEach((soldier,i)=>{soldier.facing=soldier.prevFacing=i*0.37})
    focusRegiment(camera,riders)
    // (The sprite layer is used from 256 bodies up; the dead of the other regiments are not drawn.)
    const more=battle.regiments.filter(reg=>reg.type==='sword'&&reg.side===riders.side)
    for(const reg of more) {reg.aliveCount=reg.soldiers.length;for(const soldier of reg.soldiers) {soldier.alive=true;soldier.x=soldier.prevX=5;soldier.y=soldier.prevY=5}}
    const queued=vi.spyOn(SpriteBatch.prototype,'draw')
    render(element(main),idle(battle,camera))
    expect(composites(main)).toBe(1)
    expect(main.calls.filter(call=>call.name==='translate')).toHaveLength(0)
    expect(main.calls.filter(call=>call.name==='drawImage'&&(call.args[0] as Surface).kind==='2d')).toHaveLength(0)
    const sprites=queued.mock.calls
    expect(sprites).toHaveLength(riders.soldiers.length*2)
    // Lance first, then the rider over it. Every lance is the same glyph, turned to its rider's heading (rounded to
    // the 64 headings bodies are painted at); the bodies are not turned, each heading has its own glyph.
    const lances=sprites.filter((_,i)=>i%2===0),bodies=sprites.filter((_,i)=>i%2===1)
    expect(new Set(lances.map(args=>`${args[1]}:${args[2]}`)).size).toBe(1)
    expect(new Set(bodies.map(args=>`${args[1]}:${args[2]}`)).size).toBeGreaterThan(20)
    for(const args of bodies) expect(args[8]??0).toBe(0)
    lances.forEach((args,i)=> {
      const sector=Math.round(riders.soldiers[i].facing*64/(Math.PI*2))%64
      expect(Math.cos(Number(args[8])+sector*Math.PI*2/64)).toBeCloseTo(1,6)
    })
  })

  it('draws a weapon too long for a glyph in place, under the one composite, even when only a later regiment of its type is alive',()=> {
    stubSurfaces()
    const main=surface(3840,2160)
    const battle=createArmyBattle({player:'knightly',enemy:'knightly',scale:8},42)
    // At 44 px per metre a demigryph's lance is longer than the largest weapon glyph: the body is still a (stretched)
    // glyph, and the lance is drawn in place before the composite, under the bodies.
    const camera:Camera={x:0,y:0,zoom:44}
    const survivor=battle.regiments.filter(reg=>reg.type==='demigryph')[1]
    for(const reg of battle.regiments) {
      if(reg===survivor||!['general','demigryph','demigryphHalberd'].includes(reg.type)) continue
      reg.aliveCount=0
      for(const soldier of reg.soldiers) {soldier.alive=false;soldier.deathTime=-10}
    }
    focusRegiment(camera,survivor)
    render(element(main),idle(battle,camera))
    expect(composites(main)).toBe(1)
    const composite=main.calls.findIndex(call=>call.name==='drawImage'&&(call.args[0] as Surface).kind==='gl')
    const inPlace=main.calls.map((call,index)=>call.name==='translate'?index:-1).filter(index=>index>=0)
    expect(main.calls.filter(call=>call.name==='drawImage'&&(call.args[0] as Surface).kind==='2d')).toHaveLength(0)
    expect(inPlace.length).toBe(survivor.soldiers.length)
    expect(Math.max(...inPlace)).toBeLessThan(composite)
  })
})

describe('glyphs while the zoom moves',()=> {
  it('an eased zoom reuses the atlas it has, moves on only when the glyphs no longer fit, and repaints exactly once it rests',()=> {
    const made=stubSurfaces()
    const main=surface(1600,900)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:1},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,main.width,main.height)
    const view=idle(battle,camera),start=camera.zoom
    // Sprites go through the WebGL batch here; its draw calls carry the scale each glyph is shown at.
    const queued=vi.spyOn(SpriteBatch.prototype,'draw')
    /** Glyph cells painted, and sprites drawn at other than their painted size, by one frame at this zoom. */
    const frame=(zoom:number)=> {
      camera.zoom=zoom
      for(const item of [main,...made]) item.calls.length=0
      queued.mockClear()
      render(element(main),view)
      // A weapon glyph painted at twice the size is shown at half: that is its size at rest, not a stretch.
      const scales=queued.mock.calls.map(args=>args[7]??1).map(scale=>scale<0.75?scale*2:scale)
      return {painted:made.filter(item=>item.kind==='2d').reduce((n,page)=>n+page.calls.filter(call=>call.name==='clearRect').length,0),
        stretched:scales.filter(scale=>Math.abs(scale-1)>1e-9).length,sprites:scales.length}
    }
    const first=frame(start)
    expect(first.painted).toBeGreaterThan(0)
    expect(first.sprites).toBeGreaterThan(100)
    expect(first.stretched).toBe(0)
    // Every frame of a glide has a new zoom. Within a few percent the same glyphs are stretched, none repainted.
    for(const ratio of [1.015,1.03,1.045,1.06]) {
      const moving=frame(start*ratio)
      expect(moving.painted,`at ${ratio}`).toBe(0)
      expect(moving.stretched).toBe(moving.sprites)
    }
    // Further than that the atlas moves on once, to a size it then keeps while the zoom goes on moving.
    expect(frame(start*1.09).painted).toBeGreaterThan(0)
    expect(frame(start*1.1).painted).toBe(0)
    // At rest: a few frames later the glyphs are repainted at exactly this zoom, and that is the end of it.
    const resting=Array.from({length:12},()=>frame(start*1.1))
    expect(resting.filter(item=>item.painted>0)).toHaveLength(1)
    expect(resting.at(-1)!.stretched).toBe(0)
    expect(resting.at(-1)!.painted).toBe(0)
  })
})

describe('battlefield overlays under display scaling',()=> {
  function overlays(main:Surface,ratio?:number) {
    stubSurfaces()
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:1},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,main.width,main.height)
    const reg=battle.regiments.find(item=>item.side===0)!
    render(element(main),{...idle(battle,camera),selection:[reg.id],showStamina:true,pixelRatio:ratio})
    const handles=flankHandles(reg,unitDef(reg.type)).map(point=>worldToScreen(camera,main.width,main.height,point.x,point.y))
    const arcs=main.calls.filter(call=>call.name==='arc')
    return {
      handleRadii:handles.map(point=>arcs.find(call=>call.args[0]===point.x&&call.args[1]===point.y)?.args[2]),
      fonts:new Set(main.calls.filter(call=>call.name==='=font').map(call=>call.args[0])),
      widths:new Set(main.calls.filter(call=>call.name==='fillRect').map(call=>call.args[2])),
    }
  }

  it.each([[1,6,46],[1.5,9,69],[2,12,92]])('sizes labels, bars and width handles in CSS pixels at DPR %s',(ratio,radius,bar)=> {
    const {handleRadii,fonts,widths}=overlays(surface(1600*ratio,900*ratio),ratio)
    expect(handleRadii).toEqual([radius,radius])
    expect(fonts).toContain(`${Math.round(12*ratio)}px "Microsoft YaHei", sans-serif`)
    expect(fonts).toContain(`${Math.round(11*ratio)}px "Microsoft YaHei", sans-serif`)
    // HP bar and stamina panel backgrounds.
    expect(widths).toContain(bar)
    expect(widths).toContain(116*ratio)
  })

  it('held Space shows every regiment of both sides its fatigue level and a bar that fills as it tires',()=> {
    stubSurfaces()
    const main=surface(1600,900)
    const battle=createArmyBattle({player:'classic',enemy:'classic',scale:1},42)
    const camera:Camera={x:0,y:0,zoom:1};fitCamera(camera,main.width,main.height)
    battle.regiments.forEach((reg,i)=>{reg.exertion=(i%5)*6000;reg.fatigue=fatigueAt(reg.exertion)})
    render(element(main),{...idle(battle,camera),showStamina:true,pixelRatio:1})
    const texts=main.calls.filter(call=>call.name==='fillText').map(call=>String(call.args[0]))
    const living=battle.regiments.filter(reg=>reg.aliveCount>0)
    expect(new Set(living.map(reg=>reg.side))).toEqual(new Set([0,1]))
    expect(texts.filter(text=>text.startsWith('疲劳 '))).toHaveLength(living.length)
    for(const reg of living) expect(texts).toContain(`疲劳 ${FATIGUE_NAMES[reg.fatigue]}`)
    expect(texts.some(text=>text.startsWith('体力'))).toBe(false)
    // The bar is 104 px at exhaustion and grows with exertion.
    const widths=main.calls.filter(call=>call.name==='fillRect').map(call=>Number(call.args[2]))
    for(const reg of living) expect(widths.some(w=>Math.abs(w-104*reg.exertion/FATIGUE.exhausted.threshold)<1e-9)).toBe(true)
  })

  it('reads the display ratio from the canvas size when the caller does not pass one',()=> {
    const main=surface(3200,1800);main.clientWidth=1600
    const {handleRadii,fonts}=overlays(main)
    expect(handleRadii).toEqual([12,12])
    expect(fonts).toContain('24px "Microsoft YaHei", sans-serif')
    expect(overlays(surface(1600,900)).handleRadii).toEqual([6,6])
  })
})
