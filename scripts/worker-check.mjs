// Exercise the actual production Worker bundle with a browser-message shim.
// No browser, manual placement or additional test dependency is required.
import {Worker} from 'node:worker_threads'
import {readdir,mkdir,writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'

const asset=(await readdir('dist/assets')).find(name=>name.startsWith('battle.worker-')&&name.endsWith('.js'))
if(!asset) throw new Error('Run npm run build first: production worker bundle missing.')
const worker=new Worker(`
 const {parentPort,workerData}=require('node:worker_threads');
 global.self={postMessage:(value,transfer)=>parentPort.postMessage(value,transfer),onmessage:null};
 // A browser queues each MessagePort message as one task behind messages already received; a Node port drains
 // up to 1000 self-posted messages first, which would starve commands behind the worker's backlog continuation.
 global.MessageChannel=class{constructor(){const port1={onmessage:null};this.port1=port1;this.port2={postMessage:data=>setImmediate(()=>port1.onmessage?.({data}))}}};
 parentPort.on('message',value=>self.onmessage?.({data:value}));
 import(workerData).then(()=>parentPort.postMessage({kind:'ready'}));
`,{eval:true,workerData:pathToFileURL(resolve('dist/assets',asset)).href})
const waiters=[]
function next(predicate,timeout=10000) {
 return new Promise((resolve,reject)=> {
  const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error('worker response timeout'))},timeout)}
  waiters.push(waiter)
 })
}
worker.on('message',value=> {
 if(value.kind==='error') {for(const w of waiters.splice(0)){clearTimeout(w.timer);w.reject(new Error(value.message))}return}
 for(const w of [...waiters]) if(w.predicate(value)) {waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(value)}
})
worker.on('error',error=>{for(const w of waiters.splice(0)){clearTimeout(w.timer);w.reject(error)}})
const post=value=>worker.postMessage(value)
try {
 await next(value=>value.kind==='ready')
 post({kind:'init',source:{scenario:'custom',seed:42,setup:{player:'monsters',enemy:'nomad',scale:8}},paused:true,speed:1})
 const initial=await next(value=>value.kind==='init')
 const id=initial.battle.regiments[0].id
 assert.equal(initial.battle.regiments.find(r=>r.type==='monster').modelHp,13000)
 assert.equal(initial.battle.regiments[0].soldiers.length,240)
 const startX=initial.frame.poses[0],startY=initial.frame.poses[1]
 post({kind:'command',command:{kind:'move',ids:[id],x:50,y:96,facing:null}})
 await next(value=>value.kind==='frame'&&value.frame.regiments[0].order==='move')
 post({kind:'command',command:{kind:'behavior',ids:[id],patch:{run:false}}})
 await next(value=>value.kind==='frame'&&!value.frame.regiments[0].run)
 let frame=initial.frame
 for(let i=0;i<10;i++) {
  const time=frame.time;post({kind:'step'});frame=(await next(value=>value.kind==='frame'&&value.frame.time>time)).frame
 }
 assert.ok(Math.abs(frame.time-.5)<1e-9)
 assert.ok(Math.hypot(frame.poses[0]-startX,frame.poses[1]-startY)>.05)
 post({kind:'command',command:{kind:'beginWidth',id}})
 post({kind:'command',command:{kind:'width',id,files:35}})
 await next(value=>value.kind==='frame'&&value.frame.regiments[0].files===35)
 post({kind:'command',command:{kind:'endWidth',id}})
 // The worker must keep the returned buffer and pack the next frame into it.
 const pool=async requestId=>{post({kind:'snapshot',requestId});return (await next(value=>value.kind==='snapshot'&&value.requestId===requestId)).pool}
 const before=await pool(40)
 worker.postMessage({kind:'recycle',buffer:initial.frame.poses.buffer},[initial.frame.poses.buffer])
 assert.deepEqual(await pool(41),{size:before.size+1,reused:before.reused})
 post({kind:'step'});frame=(await next(value=>value.kind==='frame'&&value.frame.time>.5)).frame
 assert.ok(frame.poses.length>0&&Number.isFinite(frame.poses[0]))
 assert.deepEqual(await pool(42),{size:before.size,reused:before.reused+1})
 post({kind:'snapshot',requestId:39})
 let snapshot=(await next(value=>value.kind==='snapshot'&&value.requestId===39)).snapshot
 assert.deepEqual(snapshot.errors,[])
 assert.equal(snapshot.regiments.find(r=>r.type==='monster').modelHp,13000)
 const gaps=[];let previous=performance.now()
 const timer=setInterval(()=>{const now=performance.now();gaps.push(now-previous);previous=now},10)
 post({kind:'control',paused:false,speed:5})
 await new Promise(resolve=>setTimeout(resolve,1200))
 clearInterval(timer);post({kind:'control',paused:true,speed:1});post({kind:'snapshot',requestId:43})
 snapshot=(await next(value=>value.kind==='snapshot'&&value.requestId===43)).snapshot
 assert.deepEqual(snapshot.errors,[]);assert.ok(snapshot.time>.55)
 // Newly added types must also initialize and step through the production worker.
 post({kind:'init',source:{scenario:'custom',seed:199,setup:{player:'blackpowder',enemy:'warTrain',scale:8}},paused:true,speed:1})
 const expanded=await next(value=>value.kind==='init')
 assert.equal(expanded.battle.regiments.find(r=>r.type==='ironsides').soldiers.length,120)
 assert.equal(expanded.battle.regiments.find(r=>r.type==='longRifle').soldiers.length,64)
 assert.equal(expanded.battle.regiments.find(r=>r.type==='warWagon').soldiers.length,8)
 post({kind:'step'});await next(value=>value.kind==='frame'&&value.frame.time>0)
 post({kind:'snapshot',requestId:44})
 const expandedSnapshot=(await next(value=>value.kind==='snapshot'&&value.requestId===44)).snapshot
 assert.deepEqual(expandedSnapshot.errors,[])
 assert.equal(expandedSnapshot.regiments.length,30)
 // Play a short decisive battle at the top UI speed: the decided frame must arrive with no further message. A decided
 // battle runs on until it is paused, so pause it before comparing with the snapshot.
 post({kind:'init',source:{scenario:'chariot',seed:20261104},paused:false,speed:5})
 await next(value=>value.kind==='init')
 post({kind:'command',command:{kind:'ai',enabled:true}})
 const decided=(await next(value=>value.kind==='frame'&&value.frame.winner!==null,30000)).frame
 post({kind:'control',paused:true,speed:5});post({kind:'snapshot',requestId:45})
 const decidedSnapshot=(await next(value=>value.kind==='snapshot'&&value.requestId===45)).snapshot
 assert.equal(decided.winner,decidedSnapshot.winner);assert.ok(decidedSnapshot.time>=decided.time)
 assert.deepEqual(decidedSnapshot.errors,[])
 const sorted=gaps.toSorted((a,b)=>a-b)
 const result={date:new Date().toISOString(),workerAsset:asset,scale:8,models:initial.battle.regiments.reduce((n,r)=>n+r.soldiers.length,0),simulatedSeconds:snapshot.time,decided:{winner:decided.winner,time:decided.time},checks:['real worker init','8x single health','queued move','walk toggle','fixed single steps','width change','transfer and recycle','authoritative snapshot','expanded roster 8x init and step','decisive frame at 5x'],errors:snapshot.errors,mainHeartbeat:{intervalMs:10,samples:gaps.length,p95Ms:sorted[Math.floor(sorted.length*.95)],maxMs:sorted.at(-1)}}
 await mkdir('reports',{recursive:true});await writeFile('reports/worker-check.json',JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result,null,2))
} finally {for(const w of waiters)clearTimeout(w.timer);await worker.terminate()}
