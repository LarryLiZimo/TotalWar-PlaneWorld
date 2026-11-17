/** getImageData is straight alpha; atlas texels are premultiplied for ONE/ONE_MINUS_SRC_ALPHA blending. */
function premultiply(data:Uint8ClampedArray):void {
  for(let i=3;i<data.length;i+=4) {
    const a=data[i]
    if(a===255) continue
    if(a===0) {if(data[i-3]|data[i-2]|data[i-1]) data[i-3]=data[i-2]=data[i-1]=0;continue}
    const k=a/255;data[i-3]*=k;data[i-2]*=k;data[i-1]*=k
  }
}

/** Floats per instance: screen rectangle, atlas rectangle, then layer, opacity and the cosine and sine of its turn. */
const STRIDE=12

/**
 * A transparent soldier layer: one instanced draw, then one Canvas composite.
 * Atlas pages must be CPU readable (willReadFrequently): only repainted cells are read back and
 * uploaded as typed pixel rectangles. A canvas source into a texture array would copy the whole
 * page through a synchronous readback on every call.
 */
export class SpriteBatch {
  private readonly canvas=document.createElement('canvas')
  private readonly gl:WebGL2RenderingContext
  private readonly program:WebGLProgram
  private readonly vao:WebGLVertexArrayObject
  private readonly buffer:WebGLBuffer
  private readonly atlas:WebGLTexture
  private readonly resolution:WebGLUniformLocation
  private readonly layers=new Map<HTMLCanvasElement,number>()
  /** Repainted cells per page, merged into one span per cell row: top y -> [left, right, bottom]. */
  private readonly dirty=new Map<HTMLCanvasElement,Map<number,number[]>>()
  /** Layers newly given to a page this generation; they still hold an earlier generation's texels. */
  private readonly fresh:number[]=[]
  private zeros:Uint8Array|null=null
  private data=new Float32Array(4096*STRIDE)
  private count=0
  private generation=-1

  static create():SpriteBatch|null {
    try {return new SpriteBatch()} catch {return null}
  }
  private constructor() {
    const gl=this.canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false})
    if(!gl) throw new Error('WebGL2 unavailable')
    this.gl=gl
    const shader=(kind:number,source:string)=> {
      const value=gl.createShader(kind)
      if(!value) throw new Error('Shader unavailable')
      gl.shaderSource(value,source);gl.compileShader(value)
      if(!gl.getShaderParameter(value,gl.COMPILE_STATUS)) throw new Error('Sprite shader compilation failed')
      return value
    }
    const vertex=shader(gl.VERTEX_SHADER,`#version 300 es
      layout(location=0) in vec2 corner;
      layout(location=1) in vec4 rectangle;
      layout(location=2) in vec4 tile;
      layout(location=3) in vec4 parameters;
      uniform vec2 resolution;
      out vec2 uv;
      flat out int layer;
      out float opacity;
      void main(){
        vec2 arm=(corner-0.5)*rectangle.zw;
        vec2 turned=vec2(arm.x*parameters.z-arm.y*parameters.w,arm.x*parameters.w+arm.y*parameters.z);
        vec2 p=(rectangle.xy+rectangle.zw*0.5+turned)/resolution*2.0-1.0;
        gl_Position=vec4(p.x,-p.y,0.0,1.0);
        uv=mix(tile.xy,tile.zw,corner);layer=int(parameters.x);opacity=parameters.y;
      }`)
    const fragment=shader(gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;
      uniform highp sampler2DArray atlas;
      in vec2 uv;
      flat in int layer;
      in float opacity;
      out vec4 color;
      void main(){color=texture(atlas,vec3(uv,float(layer)))*opacity;}`)
    const program=gl.createProgram(),vao=gl.createVertexArray(),quad=gl.createBuffer(),buffer=gl.createBuffer(),atlas=gl.createTexture()
    if(!program||!vao||!quad||!buffer||!atlas) throw new Error('Sprite resources unavailable')
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program)
    gl.deleteShader(vertex);gl.deleteShader(fragment)
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Sprite program link failed')
    this.program=program;this.vao=vao;this.buffer=buffer;this.atlas=atlas
    this.resolution=gl.getUniformLocation(program,'resolution')!
    gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'atlas'),0)
    gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,quad)
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]),gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0)
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer)
    for(const [location,size,offset] of [[1,4,0],[2,4,16],[3,4,32]]) {
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,STRIDE*4,offset);gl.vertexAttribDivisor(location,1)
    }
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,atlas)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.RGBA8,1024,1024,16)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.clearColor(0,0,0,0)
    // Typed uploads into a texture array require UNPACK_PREMULTIPLY_ALPHA_WEBGL=false; see premultiply.
    if(gl.getError()!==gl.NO_ERROR) throw new Error('Sprite texture unavailable')
  }
  begin(width:number,height:number,generation:number):boolean {
    // Forget the old pages even while the context is lost, so repaints keep being recorded per generation.
    if(this.generation!==generation) {this.generation=generation;this.layers.clear();this.dirty.clear();this.fresh.length=0}
    if(this.gl.isContextLost()) return false
    if(this.canvas.width!==width||this.canvas.height!==height) {this.canvas.width=width;this.canvas.height=height}
    this.count=0
    return true
  }
  /** Record a repainted atlas cell. Every paint of the current generation must be reported, used or not. */
  invalidate(page:HTMLCanvasElement,x:number,y:number,size:number):void {
    let rows=this.dirty.get(page)
    if(!rows) {rows=new Map();this.dirty.set(page,rows)}
    const row=rows.get(y)
    if(row) {row[0]=Math.min(row[0],x);row[1]=Math.max(row[1],x+size);row[2]=Math.max(row[2],y+size)}
    else rows.set(y,[x,x+size,y+size])
  }
  /**
   * Queue the atlas square (sx, sy, size) with its top-left corner at (x, y); `scale` grows it about its centre and
   * `turn` turns it about its centre, in radians the way a Canvas rotate() does.
   */
  draw(page:HTMLCanvasElement,sx:number,sy:number,size:number,x:number,y:number,opacity:number,scale=1,turn=0):void {
    let layer=this.layers.get(page)
    if(layer===undefined) {layer=this.layers.size;this.layers.set(page,layer);this.fresh.push(layer)}
    if((this.count+1)*STRIDE>this.data.length) {const grown=new Float32Array(this.data.length*2);grown.set(this.data);this.data=grown}
    let at=this.count++*STRIDE
    const grown=size*scale,inset=(size-grown)/2
    this.data[at++]=x+inset;this.data[at++]=y+inset;this.data[at++]=grown;this.data[at++]=grown
    this.data[at++]=sx/1024;this.data[at++]=sy/1024;this.data[at++]=(sx+size)/1024;this.data[at++]=(sy+size)/1024
    this.data[at++]=layer;this.data[at++]=opacity
    if(turn) {this.data[at++]=Math.cos(turn);this.data[at]=Math.sin(turn)}
    else {this.data[at++]=1;this.data[at]=0}
  }
  /** A page whose cells are being laid out afresh: forget what was painted on it and clear its layer before it is sampled again. */
  renew(page:HTMLCanvasElement):void {
    this.dirty.delete(page)
    const layer=this.layers.get(page)
    if(layer!==undefined&&!this.fresh.includes(layer)) this.fresh.push(layer)
  }
  flush(ctx:CanvasRenderingContext2D):void {
    if(!this.count) return
    const gl=this.gl
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.atlas)
    if(this.fresh.length) {
      // Clear once so linear filtering at cell edges never samples stale texels.
      if(!this.zeros) this.zeros=new Uint8Array(1024*1024*4)
      for(const layer of this.fresh) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,layer,1024,1024,1,gl.RGBA,gl.UNSIGNED_BYTE,this.zeros)
      this.fresh.length=0
    }
    // Pages not drawn yet keep their spans until they get a layer.
    for(const [page,rows] of this.dirty) {
      const layer=this.layers.get(page)
      if(layer===undefined) continue
      this.upload(page,layer,rows);this.dirty.delete(page)
    }
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program);gl.uniform2f(this.resolution,this.canvas.width,this.canvas.height)
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,this.count*STRIDE),gl.DYNAMIC_DRAW)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.count)
    ctx.drawImage(this.canvas,0,0)
    this.count=0
  }
  /** Upload dirty row spans; vertically adjacent rows with the same span go up as one rectangle. */
  private upload(page:HTMLCanvasElement,layer:number,rows:Map<number,number[]>):void {
    const gl=this.gl,pen=page.getContext('2d')
    if(!pen) return
    let left=0,right=0,top=0,bottom=0
    const send=()=> {
      if(right<=left||bottom<=top) return
      const pixels=pen.getImageData(left,top,right-left,bottom-top).data
      premultiply(pixels)
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,left,top,layer,right-left,bottom-top,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
    }
    for(const y of [...rows.keys()].sort((a,b)=>a-b)) {
      const [x0,x1,y1]=rows.get(y)!
      if(y===bottom&&x0===left&&x1===right) {bottom=y1;continue}
      send();left=x0;right=x1;top=y;bottom=y1
    }
    send()
  }
}

const batches=new WeakMap<HTMLCanvasElement,SpriteBatch|null>()
export function spriteBatch(canvas:HTMLCanvasElement):SpriteBatch|null {
  if(!batches.has(canvas)) batches.set(canvas,SpriteBatch.create())
  return batches.get(canvas)??null
}
