import {describe,expect,it} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {battleErrors} from '../src/sim/diagnostics'
import {commandMove} from '../src/sim/orders'
import {gapBetween,slotOf} from '../src/sim/formation'
import {UNITS} from '../src/sim/units'
import type {Battle,Regiment,Side} from '../src/sim/types'

function tick(b:Battle,seconds:number) {for(let i=0;i<Math.round(seconds/.05);i++)step(b,.05)}
function silence(b:Battle) {for(const r of b.regiments)for(const s of r.soldiers)s.meleeCd=1000}
function fixture(side:Side) {
  const b=createEmptyBattle(199),walker=spawn(b,0,'sword','walker',100,90,Math.PI/2,{models:1,files:1})
  // Halfway between files, the same path formerly fitted through either side.
  const line=spawn(b,side,'sword','line',100,105,side===0?Math.PI/2:-Math.PI/2,{models:80,files:16})
  spawn(b,1,'general','enemy reserve',280,210,0)
  silence(b);commandMove(b,[walker.id],100,125,null)
  return {b,walker,line}
}
function lineDrift(line:Regiment) {
  return Math.max(...line.soldiers.filter(s=>s.alive).map(s=>{const p=slotOf(line,UNITS[line.type],s.file,s.rank,s.centerIndex);return Math.hypot(s.x-p.x,s.y-p.y)}))
}

describe('enemy infantry lines block movement',()=> {
  it('blocks a move through ordinary enemy files without pushing the stationary line away',()=> {
    const {b,walker,line}=fixture(1)
    tick(b,24)
    expect(walker.soldiers[0].y).toBeLessThan(105)
    expect(lineDrift(line)).toBeLessThan(.25)
    expect(line.aliveCount).toBe(80);expect(walker.soldiers[0].hp).toBe(UNITS.sword.hp)
    expect(battleErrors(b)).toEqual([])
  })
  it('lets the same soldier and path pass between allied files',()=> {
    const {b,walker,line}=fixture(0)
    tick(b,24)
    expect(walker.soldiers[0].y).toBeGreaterThan(122)
    expect(lineDrift(line)).toBeLessThan(.4)
    expect(line.soldiers.every(s=>s.hp===UNITS.sword.hp)).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })
  it('repeated move commands cannot force a full infantry regiment through an enemy line',()=> {
    const {b,walker,line}=fixture(1)
    for(const s of walker.soldiers)b.soldierById.delete(s.id)
    b.regiments.splice(b.regiments.indexOf(walker),1)
    const attackers=spawn(b,0,'sword','attackers',100.425,90,Math.PI/2,{models:80,files:16})
    const middle=attackers.soldiers.filter(s=>s.file>=2&&s.file<=13)
    silence(b)
    for(let i=0;i<400;i++) {
      if(i%20===0)commandMove(b,[attackers.id],100.425,125,null)
      step(b,.05)
    }
    expect(middle.every(s=>s.y<105)).toBe(true)
    expect(lineDrift(line)).toBeLessThan(.5)
    expect(line.aliveCount).toBe(80)
    expect(battleErrors(b)).toEqual([])
  })
  it('also blocks scattered routing infantry rather than letting their escape bypass the line',()=> {
    const {b,walker,line}=fixture(0)
    // A northern unit normally escapes north; a southern reserve keeps the
    // battle running while this individual meets a southern enemy line.
    walker.side=1
    spawn(b,0,'general','friendly reserve',25,25,0)
    // Two enemy riders close behind outweigh the line's own repulsion, so the
    // escape heading runs straight into the files instead of away from them.
    for(const x of [98,102]) spawn(b,0,'general','chaser',x,90,Math.PI/2)
    silence(b)
    const s=walker.soldiers[0]
    Object.assign(s,{y:97,prevY:97});walker.anchorY=97
    Object.assign(walker,{routing:true,shattered:true,moraleState:'shattered'})
    // The rout may run round a flank of the line, but never between its files.
    const xs=line.soldiers.map(o=>o.x),ys=line.soldiers.map(o=>o.y)
    let inside=0,pressed=0
    for(let i=0;i<480;i++) {
      step(b,.05)
      if(line.soldiers.some(o=>gapBetween(s,UNITS.sword,o,UNITS.sword)<.3)) pressed++
      if(s.x>Math.min(...xs)&&s.x<Math.max(...xs)&&s.y>Math.min(...ys)&&s.y<Math.max(...ys)) inside++
    }
    expect(pressed).toBeGreaterThan(40)
    expect(inside).toBe(0)
    expect(line.aliveCount).toBe(80)
    expect(battleErrors(b)).toEqual([])
  })
  it('allows a real breach in the enemy line to be crossed',()=> {
    const b=createEmptyBattle(199),walker=spawn(b,0,'sword','walker',100,90,Math.PI/2,{models:1,files:1})
    // Two intact units leave a genuinely open lane, rather than an invisible
    // regiment-sized wall or knocked-down bodies that could be pushed aside.
    spawn(b,1,'sword','left',95,105,-Math.PI/2,{models:30,files:6})
    spawn(b,1,'sword','right',105,105,-Math.PI/2,{models:30,files:6})
    silence(b);commandMove(b,[walker.id],100,125,null)
    tick(b,24)
    expect(walker.soldiers[0].y).toBeGreaterThan(122)
    expect(battleErrors(b)).toEqual([])
  })
})
