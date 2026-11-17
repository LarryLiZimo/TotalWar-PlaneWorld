import { build } from 'vite'
import { Session } from 'node:inspector'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const label=process.argv[2]??'latest'
const startSeconds=Math.max(0,Number(process.argv[3])||0)
const scenario=process.argv[4]??'demo'
// Profile one plain bundle like the production Worker; Vite SSR modules add
// getter frames and run about 1.4x slower. The source map turns bundle
// positions back into src/... file:line names.
const outDir=resolve('node_modules/.cache/sim-bench/profile'),entry='\0sim-bench-entry',bundle=resolve(outDir,'sim.mjs')
await build({configFile:false,root:process.cwd(),logLevel:'warn',
  plugins:[{name:'sim-bench-entry',resolveId:id=>id==='sim-bench-entry'?entry:null,load:id=>id===entry?"export * from '/src/sim/index.ts'":null}],
  build:{ssr:true,outDir,emptyOutDir:true,minify:false,sourcemap:true,rollupOptions:{input:'sim-bench-entry',output:{entryFileNames:'sim.mjs'}}}})
const map=JSON.parse(await readFile(bundle+'.map','utf8')),bundleUrl=pathToFileURL(bundle).href
const B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',lines=[]
let src=0,line=0
for(const text of map.mappings.split(';')) {
  const segments=[];let column=0
  for(const segment of text.split(',')) {
    if(!segment) continue
    const fields=[];let value=0,shift=0
    for(const ch of segment) {const digit=B64.indexOf(ch);value+=(digit&31)<<shift;if(digit&32)shift+=5;else{fields.push(value&1?-(value>>>1):value>>>1);value=shift=0}}
    column+=fields[0];if(fields.length>=4){src+=fields[1];line+=fields[2];segments.push([column,src,line])}
  }
  lines.push(segments)
}
const sources=map.sources.map(s=>relative(process.cwd(),resolve(outDir,map.sourceRoot??'',s)).replaceAll('\\','/'))
const located=frame=>{
  const segments=lines[frame.lineNumber]??[]
  let hit=segments[0]
  for(const segment of segments) if(segment[0]<=frame.columnNumber) hit=segment
  return hit?`${sources[hit[1]]}:${hit[2]+1}`:`sim.mjs:${frame.lineNumber+1}`
}
const {createScenario,step,setAiEnabled}=await import(bundleUrl)
const session=new Session()
const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)))
try {
  const warm=createScenario(scenario,42);setAiEnabled(warm,true)
  for(let i=0;i<40;i++) step(warm,0.05)
  const battle=createScenario(scenario,42);setAiEnabled(battle,true)
  for(let i=0;i<startSeconds/0.05&&battle.winner===null;i++) step(battle,0.05)
  session.connect();await post('Profiler.enable');await post('Profiler.start')
  const times=[]
  for(let i=0;i<600&&battle.winner===null;i++) {
    const start=performance.now();step(battle,0.05);times.push(performance.now()-start)
  }
  const {profile}=await post('Profiler.stop')
  const nodes=new Map(profile.nodes.map(node=>[node.id,node])),weights=new Map()
  for(let i=0;i<profile.samples.length;i++) {
    const node=nodes.get(profile.samples[i]),frame=node.callFrame
    const where=frame.url===bundleUrl?located(frame):`${frame.url.replaceAll('\\','/').split('/').slice(-3).join('/')}:${frame.lineNumber+1}`
    const key=`${frame.functionName||'(anonymous)'} ${where}`
    weights.set(key,(weights.get(key)??0)+profile.timeDeltas[i])
  }
  const sorted=[...times].sort((a,b)=>a-b)
  const result={label,scenario,seed:42,startSeconds,code:'bundled sim (same plain bindings as the Worker build)',soldiers:battle.regiments.reduce((n,r)=>n+r.initial,0),steps:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),hotspots:[...weights].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,us])=>({name,ms:Math.round(us/1000)}))}
  await mkdir('reports',{recursive:true})
  await writeFile(`reports/profile-${label}.cpuprofile`,JSON.stringify(profile))
  await writeFile(`reports/profile-${label}.json`,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {session.disconnect()}
