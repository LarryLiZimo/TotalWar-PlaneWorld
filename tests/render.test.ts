import {afterEach,describe,expect,it,vi} from 'vitest'
import {fitCamera,type Camera} from '../src/camera'
import {render,type RenderInput} from '../src/render'
import {createArmyBattle} from '../src/sim/armies'

function drawingSurface(width:number,height:number) {
  const calls:{name:string;args:unknown[]}[]=[]
  const context=new Proxy({}, {
    get:(_target,name)=> {
      if(name==='measureText') return (value:string)=>({width:value.length*7})
      if(name==='createLinearGradient') return ()=>({addColorStop(){}})
      return (...args:unknown[])=>{calls.push({name:String(name),args})}
    },set:()=>true,
  }) as CanvasRenderingContext2D
  return {canvas:{width,height,getContext:()=>context} as unknown as HTMLCanvasElement,calls}
}
afterEach(()=>vi.unstubAllGlobals())

describe('battle rendering under display scaling',()=> {
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
