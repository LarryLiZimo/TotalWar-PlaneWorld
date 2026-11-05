/** A transparent soldier layer: one instanced draw, then one Canvas composite. */
export class SpriteBatch {
  private readonly canvas=document.createElement('canvas')
  private readonly gl:WebGL2RenderingContext
  private readonly program:WebGLProgram
  private readonly vao:WebGLVertexArrayObject
  private readonly buffer:WebGLBuffer
  private readonly atlas:WebGLTexture
  private readonly resolution:WebGLUniformLocation
  private readonly layers=new Map<HTMLCanvasElement,number>()
  private readonly dirty=new Set<HTMLCanvasElement>()
  private data=new Float32Array(4096*10)
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
      layout(location=3) in vec2 parameters;
      uniform vec2 resolution;
      out vec2 uv;
      flat out int layer;
      out float opacity;
      void main(){
        vec2 p=(rectangle.xy+corner*rectangle.zw)/resolution*2.0-1.0;
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
    for(const [location,size,offset] of [[1,4,0],[2,4,16],[3,2,32]]) {
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,40,offset);gl.vertexAttribDivisor(location,1)
    }
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,atlas)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY,1,gl.RGBA8,1024,1024,16)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.clearColor(0,0,0,0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true)
    if(gl.getError()!==gl.NO_ERROR) throw new Error('Sprite texture unavailable')
  }
  begin(width:number,height:number,generation:number):boolean {
    if(this.gl.isContextLost()) return false
    if(this.canvas.width!==width||this.canvas.height!==height) {this.canvas.width=width;this.canvas.height=height}
    if(this.generation!==generation) {this.generation=generation;this.layers.clear();this.dirty.clear()}
    this.count=0
    return true
  }
  invalidate(page:HTMLCanvasElement):void {this.dirty.add(page)}
  draw(page:HTMLCanvasElement,sx:number,sy:number,size:number,x:number,y:number,opacity:number):void {
    let layer=this.layers.get(page)
    if(layer===undefined) {layer=this.layers.size;this.layers.set(page,layer);this.dirty.add(page)}
    if((this.count+1)*10>this.data.length) {const grown=new Float32Array(this.data.length*2);grown.set(this.data);this.data=grown}
    let at=this.count++*10
    this.data[at++]=x;this.data[at++]=y;this.data[at++]=size;this.data[at++]=size
    this.data[at++]=sx/1024;this.data[at++]=sy/1024;this.data[at++]=(sx+size)/1024;this.data[at++]=(sy+size)/1024
    this.data[at++]=layer;this.data[at]=opacity
  }
  flush(ctx:CanvasRenderingContext2D):void {
    if(!this.count) return
    const gl=this.gl
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.atlas)
    for(const page of this.dirty) {
      const layer=this.layers.get(page)
      if(layer!==undefined) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,layer,1024,1024,1,gl.RGBA,gl.UNSIGNED_BYTE,page)
    }
    this.dirty.clear()
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program);gl.uniform2f(this.resolution,this.canvas.width,this.canvas.height)
    gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,this.count*10),gl.DYNAMIC_DRAW)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.count)
    ctx.drawImage(this.canvas,0,0)
    this.count=0
  }
}

const batches=new WeakMap<HTMLCanvasElement,SpriteBatch|null>()
export function spriteBatch(canvas:HTMLCanvasElement):SpriteBatch|null {
  if(!batches.has(canvas)) batches.set(canvas,SpriteBatch.create())
  return batches.get(canvas)??null
}
