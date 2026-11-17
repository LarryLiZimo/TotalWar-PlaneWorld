import {describe,expect,it} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {scaledFormation} from '../src/sim/armies'
import {battleErrors} from '../src/sim/diagnostics'
import {gapBetween,slotOf} from '../src/sim/formation'
import {commandAttack} from '../src/sim/orders'
import type {Battle,Regiment} from '../src/sim/types'
import {UNITS} from '../src/sim/units'

/**
 * How a melee is joined (RULES 三.3): the formation is the only thing anyone heads for. Every man goes to his place in
 * the ranks; the front rank fights whoever stops it, and the ranks behind stand behind. These used to be a swarm:
 * once a regiment touched the enemy, every man without an opponent picked an enemy soldier and ran at him, so the rear
 * ranks squeezed into every gap, lapped round the flanks and walked round friendly blocks.
 */
const N=Math.PI/2,S=-Math.PI/2
const tick=(b:Battle,seconds:number,each?:()=>void)=>{for(let i=0;i<Math.round(seconds/0.05);i++) {step(b,0.05);each?.()}}
const standing=(r:Regiment)=>r.soldiers.filter(s=>s.alive&&s.down<=0)
const fromSlot=(r:Regiment)=>standing(r).map(s=>{const p=slotOf(r,UNITS[r.type],s.file,s.rank,s.centerIndex);return Math.hypot(p.x-s.x,p.y-s.y)})
/** Two sword blocks facing each other along y, `ours` to the south. */
function lines(seed:number,width?:{ours?:number;foe?:number}) {
  const b=createEmptyBattle(seed)
  const ours=spawn(b,0,'sword','ours',150,90,N,{...scaledFormation('sword',4),...(width?.ours?{files:width.ours}:{})})
  const foe=spawn(b,1,'sword','foe',150,112,S,{...scaledFormation('sword',4),...(width?.foe?{files:width.foe}:{})})
  b.aiEnabled=false
  return {b,ours,foe}
}

describe('a melee is fought by formations, not by a swarm',()=> {
  it('through a long fight the ranks behind stand behind: nobody squeezes into the front or steps out of the block',()=> {
    const {b,ours,foe}=lines(11)
    commandAttack(b,[ours.id],foe.id);commandAttack(b,[foe.id],ours.id)
    tick(b,12)
    expect(ours.inContact).toBe(true)
    const half=(ours.files-1)*UNITS.sword.spacing/2,d=UNITS.sword,reach=d.reach+d.radius*2
    let deep=0,passed=0,ahead=0,outside=0,past=-Infinity
    tick(b,45,()=> {
      const men=standing(ours),foes=standing(foe)
      if(!men.length||!foes.length) return
      // The enemy's front is the southernmost of his men; ours stand south of it.
      const line=Math.min(...foes.map(s=>s.y))
      past=Math.max(past,...men.map(s=>s.y-line))
      // The two lines met ragged, file by file, so "the front" is not one straight line. What holds is this: nobody
      // from the third rank back is at an enemy, and nobody has come level with the man in front of him in his file.
      deep=Math.max(deep,men.filter(s=>s.rank>=2&&foes.some(e=>Math.hypot(e.x-s.x,e.y-s.y)<reach)).length)
      const place=new Map(men.filter(s=>s.centerIndex<0).map(s=>[s.rank*4096+s.file,s]))
      let level=0
      for(const s of men) {
        const leader=s.rank>0&&s.centerIndex<0?place.get((s.rank-1)*4096+s.file):undefined
        if(leader&&leader.y-s.y<d.rankSpacing*0.4) level++
      }
      passed=Math.max(passed,level)
      // How far ahead of his own place anyone stands. (Sideways a man may have a walk along the rear rank to close a
      // file at the far end of it; that is not pressing forward.)
      ahead=Math.max(ahead,...men.map(s=>s.y-slotOf(ours,d,s.file,s.rank,s.centerIndex).y))
      outside=Math.max(outside,...men.map(s=>Math.abs(s.x-ours.anchorX)-half))
    })
    expect(past).toBeLessThan(0.2)
    expect(deep).toBeLessThanOrEqual(3)
    expect(passed).toBeLessThanOrEqual(3)
    // Everyone is at, or queued a little short of, his own place; nobody has left the block's width.
    expect(ahead).toBeLessThan(1.2)
    expect(outside).toBeLessThan(1.2)
    expect(ours.dealt.length+foe.dealt.length).toBeGreaterThan(0)
    expect(battleErrors(b)).toEqual([])
  },30000)

  it('a wide line attacking a narrow block does not lap round it: nobody ends up behind the enemy',()=> {
    const {b,ours,foe}=lines(12,{ours:30,foe:12})
    commandAttack(b,[ours.id],foe.id)
    let behind=0
    tick(b,45,()=> {
      const foes=standing(foe)
      if(!foes.length) return
      // The foe faces south, so his rear rank is his northernmost.
      const rear=Math.max(...foes.map(s=>s.y))
      behind=Math.max(behind,standing(ours).filter(s=>s.y>rear).length)
    })
    expect(ours.inContact).toBe(true)
    expect(behind).toBe(0)
    expect(battleErrors(b)).toEqual([])
  },30000)

  // Stacking, the classic bad habit: it packs twice the men onto the same ground, where one blast catches them all.
  it('two foot regiments sent at one enemy stack on it: both front ranks crowd the line, each keeps its own ranks behind',()=> {
    const {b,ours:first,foe}=lines(13)
    commandAttack(b,[first.id],foe.id);commandAttack(b,[foe.id],first.id)
    tick(b,12)
    expect(first.inContact).toBe(true)
    const second=spawn(b,0,'sword','second',150,74,N,scaledFormation('sword',4)),d=UNITS.sword
    commandAttack(b,[second.id],foe.id)
    const half=(second.files-1)*d.spacing/2
    let outside=0
    tick(b,20,()=>{outside=Math.max(outside,...standing(second).map(s=>Math.abs(s.x-150)-half))})
    const line=Math.min(...standing(foe).map(s=>s.y))
    const atLine=(r:Regiment)=>standing(r).filter(s=>line-s.y<d.rankSpacing+d.radius).length
    // The second line came straight through the first, not round it, and its front rank is at the enemy too.
    expect(outside).toBeLessThan(1.5)
    expect(second.inContact).toBe(true)
    expect(atLine(second)).toBeGreaterThanOrEqual(second.files*0.7)
    expect(atLine(first)).toBeGreaterThanOrEqual(first.files*0.7)
    // The two regiments stand on the same ground, in among each other.
    const rear=Math.min(...standing(first).map(s=>s.y))
    expect(standing(second).filter(s=>s.y>rear).length).toBeGreaterThan(second.aliveCount*0.6)
    // Within each regiment the ranks keep their order: nobody is ahead of the man in front of him in his own file.
    for(const reg of [first,second]) {
      const place=new Map(standing(reg).filter(s=>s.centerIndex<0).map(s=>[`${s.file}:${s.rank}`,s]))
      let pairs=0,inOrder=0
      for(const s of place.values()) {
        const leader=place.get(`${s.file}:${s.rank-1}`)
        if(!leader) continue
        pairs++
        if(leader.y-s.y>d.rankSpacing*0.5) inOrder++
      }
      expect(pairs).toBeGreaterThan(60)
      expect(inOrder,reg.name).toBeGreaterThanOrEqual(pairs*0.95)
    }
    expect(battleErrors(b)).toEqual([])
  },30000)

  it.each(['heavyCavalry','ogre'] as const)('%s ordered onto the same enemy ride through the friendly foot and fight among them',type=> {
    const {b,ours:first,foe}=lines(14)
    commandAttack(b,[first.id],foe.id);commandAttack(b,[foe.id],first.id)
    tick(b,12)
    const big=spawn(b,0,type,'big',150,70,N,scaledFormation(type,4)),def=UNITS[type]
    commandAttack(b,[big.id],foe.id)
    tick(b,30)
    // Large bodies are not held up behind friends: their front rank is at the enemy, in among the friendly foot.
    const atEnemy=standing(big).filter(s=>foe.soldiers.some(e=>e.alive&&gapBetween(s,def,e,UNITS.sword)<=def.reach+0.5))
    expect(big.inContact).toBe(true)
    expect(atEnemy.length).toBeGreaterThanOrEqual(3)
    const front=Math.max(...standing(first).map(s=>s.y)),rear=Math.min(...standing(first).map(s=>s.y))
    expect(atEnemy.filter(s=>s.y>rear&&s.y<front+def.radius*2+1).length).toBe(atEnemy.length)
    // The foot they pushed through are jostled, not scattered.
    const displaced=fromSlot(first).sort((x,y)=>x-y)
    expect(displaced[Math.floor(displaced.length*0.9)]).toBeLessThan(2)
    expect(battleErrors(b)).toEqual([])
  },30000)
})
