import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { battleErrors } from '../src/sim/diagnostics'
import { compactRanks, slotOf } from '../src/sim/formation'
import { angDiff } from '../src/sim/math'
import { commandAttack, commandMove } from '../src/sim/orders'
import type { Battle, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'
import { createScenario } from '../src/sim/scenarios'

function tick(b:Battle,seconds:number) {for(let i=0;i<Math.round(seconds/0.05);i++) step(b,0.05)}
function one(b:Battle,side:0|1,type:UnitType,x:number,y:number,facing=0):Regiment {
  const r=spawn(b,side,type,type,x,y,facing)
  for(const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1);r.initial=r.aliveCount=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,meleeCd:100})
  return r
}
function enemyFar(b:Battle) {return one(b,1,'sword',260,200)}

describe('casualty formation repair',()=> {
  it('fills complete front ranks after a whole central file is lost, without teleporting bodies',()=> {
    const b=createEmptyBattle(71),r=spawn(b,0,'sword','ranks',140,140,Math.PI/2)
    enemyFar(b)
    for(const i of [7,8,23,24,39,40,55,56,71,72]) {r.soldiers[i].alive=false;r.soldiers[i].hp=0}
    r.aliveCount=70
    const before=r.soldiers.filter(s=>s.alive).map(s=>[s.id,s.x,s.y])
    compactRanks(r)
    const rows=Array.from({length:5},(_,rank)=>r.soldiers.filter(s=>s.alive&&s.rank===rank))
    expect(rows.map(row=>row.length)).toEqual([16,16,16,16,6])
    expect(rows[4].map(s=>s.centerIndex).sort((a,c)=>a-c)).toEqual([0,1,2,3,4,5])
    for(const [id,x,y] of before) {const s=b.soldierById.get(id)!;expect([s.x,s.y]).toEqual([x,y])}
    tick(b,16)
    const settled=r.soldiers.filter(s=>s.alive&&Math.hypot(s.x-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).x,s.y-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).y)<0.2)
    expect(settled.length).toBeGreaterThanOrEqual(68)
    expect(battleErrors(b)).toEqual([])
  })
})

describe('rolling chariot manoeuvres and extraction',()=> {
  it.each([[98,100],[100,106],[104,96]])('rolls into a nearby destination (%s,%s) instead of pivoting or orbiting forever',(goalX,goalY)=> {
    const b=createEmptyBattle(72),r=one(b,0,'chariot',100,100,0)
    enemyFar(b);commandMove(b,[r.id],goalX,goalY,null)
    let travel=0,rollingTurn=0,previous={x:100,y:100,facing:0}
    for(let i=0;i<80;i++) {
      step(b,0.05);const s=r.soldiers[0]
      const moved=Math.hypot(s.x-previous.x,s.y-previous.y)
      const turned=Math.abs(angDiff(previous.facing,s.facing))
      travel+=moved;if(moved>0.01) rollingTurn+=turned
      previous={x:s.x,y:s.y,facing:s.facing}
    }
    expect(travel).toBeGreaterThan(Math.min(5,Math.hypot(goalX-100,goalY-100)*1.5))
    expect(rollingTurn).toBeGreaterThan(Math.min(0.9,Math.abs(Math.atan2(goalY-100,goalX-100))*0.6))
    tick(b,20)
    expect(Math.hypot(r.soldiers[0].x-goalX,r.soldiers[0].y-goalY)).toBeLessThan(1.2)
  })

  it('extracts a slow chariot through a few ordinary infantry without needing impact speed',()=> {
    const b=createEmptyBattle(73),cart=one(b,0,'chariot',100,100,0)
    const feet=[[102.2,99.1],[102.2,100],[102.2,100.9],[103,99.55],[103,100.45]].map(([x,y])=>one(b,1,'sword',x,y,0))
    cart.bogged=true;commandMove(b,[cart.id],125,100,null)
    let fastestInContact=0
    for(let i=0;i<160;i++) {step(b,0.05);if(cart.inContact) fastestInContact=Math.max(fastestInContact,cart.soldiers[0].speed)}
    expect(cart.soldiers[0].x).toBeGreaterThan(108)
    expect(feet.every(r=>r.soldiers[0].hp===UNITS.sword.hp&&r.soldiers[0].down===0)).toBe(true)
    expect(fastestInContact).toBeLessThan(5)
    expect(battleErrors(b)).toEqual([])
  })

  it('finite traction cannot slowly bulldoze an entire braced spear front',()=> {
    const b=createEmptyBattle(77),cart=one(b,0,'chariot',100,100,0)
    const line=spawn(b,1,'spear','braced',102.2,100,Math.PI)
    for(const s of line.soldiers) {s.braceTime=2;s.meleeCd=100;s.facing=Math.atan2(100-s.y,100-s.x);s.prevFacing=s.facing}
    commandMove(b,[cart.id],125,100,null);tick(b,8)
    expect(cart.soldiers[0].x).toBeLessThan(102)
    expect(line.aliveCount).toBe(80)
    expect(battleErrors(b)).toEqual([])
  })

  it('the complete four-cart extraction escapes a fighting infantry regiment before routing',()=> {
    const b=createScenario('cartescape',42),carts=b.regiments.find(r=>r.type==='chariot')!
    tick(b,12)
    expect(carts.aliveCount).toBe(4)
    expect(carts.routing).toBe(false)
    expect(carts.soldiers.filter(s=>s.x>160).length).toBe(4)
    expect(battleErrors(b)).toEqual([])
  })
})

describe('ground resistance',()=> {
  it('a stationary foot unit resists a friendly walker instead of sliding along with it',()=> {
    const b=createEmptyBattle(74),walker=one(b,0,'sword',100,100,0),standing=one(b,0,'sword',101,100,Math.PI/2)
    enemyFar(b);commandMove(b,[walker.id],110,100,null);tick(b,4)
    expect(Math.hypot(standing.soldiers[0].x-101,standing.soldiers[0].y-100)).toBeLessThan(0.15)
  })

  it('an external push moves a body briefly and friction brings it to rest',()=> {
    const b=createEmptyBattle(75),r=one(b,0,'sword',100,100,0)
    enemyFar(b)
    Object.assign(r.soldiers[0],{pushVx:2,pushVy:0})
    step(b,0.05)
    expect(r.soldiers[0].x).toBeGreaterThan(100)
    tick(b,0.6)
    expect(r.soldiers[0].pushVx).toBe(0);expect(r.soldiers[0].pushVy).toBe(0)
    expect(r.soldiers[0].x).toBeLessThan(100.45)
  })
})

describe('committed reserves',()=> {
  it('a small detached group rejoins the fight instead of waiting for its old slots',()=> {
    const b=createEmptyBattle(78),r=spawn(b,0,'sword','reserve',150,100,Math.PI/2)
    const target=spawn(b,1,'spear','target',150,125,-Math.PI/2)
    for(const reg of [r,target]) for(const s of reg.soldiers) s.meleeCd=100
    r.soldiers.slice(10).forEach((s,i)=>{s.x=144+(i%14)*0.85;s.y=123.8-Math.floor(i/14)*0.72;s.prevX=s.x;s.prevY=s.y})
    r.soldiers.slice(0,10).forEach((s,i)=>{s.x=165+(i%5)*0.85;s.y=113-Math.floor(i/5)*0.72;s.prevX=s.x;s.prevY=s.y})
    commandAttack(b,[r.id],target.id);tick(b,12)
    expect(r.soldiers.slice(0,10).filter(s=>s.y>120).length).toBeGreaterThanOrEqual(8)
    expect(battleErrors(b)).toEqual([])
  })

  it('rear attackers go around a stationary allied block and join their engaged comrades',()=> {
    const b=createEmptyBattle(76)
    const attackers=spawn(b,0,'sword','attackers',150,90,Math.PI/2)
    const wall=spawn(b,0,'sword','wall',150,110,Math.PI/2)
    const target=spawn(b,1,'spear','target',150,125,-Math.PI/2)
    for(const r of [attackers,wall,target]) for(const s of r.soldiers) s.meleeCd=100
    for(const [i,s] of attackers.soldiers.entries()) {
      if(i<6) Object.assign(s,{x:145+i*0.85,y:123.9,prevX:145+i*0.85,prevY:123.9})
    }
    commandAttack(b,[attackers.id],target.id)
    tick(b,32)
    const rear=attackers.soldiers.slice(6).filter(s=>s.alive)
    expect(rear.filter(s=>s.y>116).length).toBeGreaterThan(rear.length*0.65)
    const wallShift=wall.soldiers.reduce((sum,s)=>sum+Math.hypot(s.x-slotOf(wall,UNITS.sword,s.file,s.rank,s.centerIndex).x,s.y-slotOf(wall,UNITS.sword,s.file,s.rank,s.centerIndex).y),0)/wall.aliveCount
    expect(wallShift).toBeLessThan(1)
    expect(battleErrors(b)).toEqual([])
  },15000)
})
