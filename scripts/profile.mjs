import { createServer } from 'vite'
import { Session } from 'node:inspector'
import { mkdir, writeFile } from 'node:fs/promises'

const label=process.argv[2]??'latest'
const startSeconds=Math.max(0,Number(process.argv[3])||0)
const scenario=process.argv[4]??'demo'
const server=await createServer({server:{middlewareMode:true},appType:'custom'})
const session=new Session()
const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)))
try {
  const {createScenario}=await server.ssrLoadModule('/src/sim/scenarios.ts')
  const {step,setAiEnabled}=await server.ssrLoadModule('/src/sim/battle.ts')
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
    const key=`${frame.functionName||'(anonymous)'} ${frame.url.replaceAll('\\','/').split('/').slice(-3).join('/')}:${frame.lineNumber+1}`
    weights.set(key,(weights.get(key)??0)+profile.timeDeltas[i])
  }
  const sorted=[...times].sort((a,b)=>a-b)
  const result={label,scenario,seed:42,startSeconds,soldiers:battle.regiments.reduce((n,r)=>n+r.initial,0),steps:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1),hotspots:[...weights].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([name,us])=>({name,ms:Math.round(us/1000)}))}
  await mkdir('reports',{recursive:true})
  await writeFile(`reports/profile-${label}.cpuprofile`,JSON.stringify(profile))
  await writeFile(`reports/profile-${label}.json`,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {session.disconnect();await server.close()}
