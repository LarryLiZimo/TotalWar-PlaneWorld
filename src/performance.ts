/** Optional on-screen diagnostics, enabled with ?perf=1 or F3. No game state changes. */
export class PerformanceHud {
  private readonly samples:{frame:number[];sim:number[];render:number[]}={frame:[],sim:[],render:[]}
  private readonly root:HTMLOutputElement
  private at=0
  private simulationAt:number|null=null
  private wallAt:number|null=null
  private actualRate=0
  constructor(enabled:boolean) {
    this.root=document.createElement('output');this.root.id='performance';this.root.hidden=!enabled
    document.body.append(this.root)
    window.addEventListener('keydown',e=>{if(e.code==='F3') {e.preventDefault();this.root.hidden=!this.root.hidden}})
  }
  record(key:'frame'|'sim'|'render',ms:number):void {
    if(this.root.hidden) return
    const values=this.samples[key];values.push(ms);if(values.length>240) values.shift()
  }
  reset():void {for(const values of Object.values(this.samples)) values.length=0;this.simulationAt=null;this.wallAt=null;this.actualRate=0}
  paint(now:number,limited:boolean,engine='主线程',simulationTime?:number):void {
    if(this.root.hidden||now-this.at<500) return
    this.at=now
    if(simulationTime!==undefined) {
      if(this.simulationAt!==null&&this.wallAt!==null&&now>this.wallAt) this.actualRate=Math.max(0,(simulationTime-this.simulationAt)*1000/(now-this.wallAt))
      this.simulationAt=simulationTime;this.wallAt=now
    }
    const stats=(values:number[])=> {
      if(!values.length) return {mean:0,p95:0}
      const sorted=[...values].sort((a,b)=>a-b)
      return {mean:values.reduce((a,b)=>a+b,0)/values.length,p95:sorted[Math.floor(sorted.length*.95)]}
    }
    const f=stats(this.samples.frame),s=stats(this.samples.sim),r=stats(this.samples.render)
    const long=this.samples.frame.filter(ms=>ms>1000/30).length
    this.root.textContent=`${f.mean?Math.round(1000/f.mean):0} FPS · 帧 P95 ${f.p95.toFixed(1)} ms\n模拟 ${s.mean.toFixed(1)} / ${s.p95.toFixed(1)} ms · 绘制提交 ${r.mean.toFixed(1)} / ${r.p95.toFixed(1)} ms\n${engine} · 长帧 ${long}/${this.samples.frame.length}${simulationTime===undefined?'':` · 实际 ${this.actualRate.toFixed(2)}×`}${limited?'\n运算受限：实际倍速低于所选倍速':''}`
    this.root.title='最近 240 个采样：平均 / P95；模拟按固定步统计。绘制提交仅为 JS 提交命令，栅格化/合成的延迟体现在实际帧间隔中。实际倍速为模拟时间/墙钟时间，暂停时为零。F3 隐藏。'
  }
}
