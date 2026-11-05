import { describe,expect,it } from 'vitest'
import { createEmptyBattle,spawn,step } from '../src/sim/battle'
import { battleErrors } from '../src/sim/diagnostics'
import { gapBetween,slotOf } from '../src/sim/formation'
import { commandMove } from '../src/sim/orders'
import { bodyContact } from '../src/sim/physics'
import { createScenario } from '../src/sim/scenarios'
import type { Battle,Regiment,UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

function tick(b:Battle,seconds:number) {for(let i=0;i<seconds/.05;i++) step(b,.05)}
function single(b:Battle,type:UnitType,x:number,y:number,facing:number) {
  const r=spawn(b,0,type,type,x,y,facing)
  for(const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1);r.initial=r.aliveCount=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y})
  return r
}
function opponent(b:Battle) {spawn(b,1,'general','distant',280,210,0)}
function displacement(r:Regiment) {
  const d=UNITS[r.type]
  return r.soldiers.reduce((sum,s)=>{const p=slotOf(r,d,s.file,s.rank,s.centerIndex);return sum+Math.hypot(s.x-p.x,s.y-p.y)},0)/r.aliveCount
}

describe('slim and flexible movement bodies',()=> {
  it('visible infantry may overlap while their actual movement bodies are separated',()=> {
    const b=createEmptyBattle(81),a=single(b,'sword',100,100,0),c=single(b,'sword',100.55,100,0)
    expect(gapBetween(a.soldiers[0],UNITS.sword,c.soldiers[0],UNITS.sword)).toBeLessThan(0)
    expect(bodyContact(a.soldiers[0],UNITS.sword,c.soldiers[0],UNITS.sword).gap).toBeGreaterThan(.1)
  })
  it('a shallow contact relaxes gradually and settles without bouncing or sliding away',()=> {
    const b=createEmptyBattle(82),a=single(b,'sword',100,100,0),c=single(b,'sword',100.35,100,Math.PI)
    opponent(b);step(b,.05)
    expect(a.soldiers[0].x).toBeGreaterThan(99.97)
    expect(c.soldiers[0].x).toBeLessThan(100.38)
    tick(b,3)
    expect(bodyContact(a.soldiers[0],UNITS.sword,c.soldiers[0],UNITS.sword).gap).toBeGreaterThan(.005)
    expect(displacement(a)).toBeLessThan(.1);expect(displacement(c)).toBeLessThan(.1)
    expect(Math.hypot(a.soldiers[0].pushVx,a.soldiers[0].pushVy)).toBeLessThan(.01)
  })
  it('infantry fit between the visible models of an ordinary standing allied regiment',()=> {
    const b=createEmptyBattle(83),walker=single(b,'sword',100,100,Math.PI/2)
    const line=spawn(b,0,'sword','allies',100,110,Math.PI/2)
    opponent(b);commandMove(b,[walker.id],100,125,null);tick(b,12)
    expect(walker.soldiers[0].y).toBeGreaterThan(120)
    expect(displacement(line)).toBeLessThan(.2)
    expect(battleErrors(b)).toEqual([])
  })
  it('a full infantry regiment passes through allied files and reforms beyond them',()=> {
    const b=createEmptyBattle(84),moving=spawn(b,0,'sword','moving',100,95,Math.PI/2)
    const standing=spawn(b,0,'sword','standing',100,110,Math.PI/2)
    opponent(b);commandMove(b,[moving.id],100,130,null);tick(b,28)
    expect(moving.soldiers.filter(s=>s.y>117).length).toBe(80)
    expect(displacement(standing)).toBeLessThan(.4)
    expect(displacement(moving)).toBeLessThan(.4)
    expect(moving.soldiers.every(s=>s.hp===UNITS.sword.hp)).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })
  it.each(['chariot','heavyCavalry'] as const)('%s can cross a standing allied spear formation without treating it as an enemy wall',type=> {
    const b=createEmptyBattle(85),moving=single(b,type,100,100,0)
    const standing=spawn(b,0,'spear','allies',110,100,Math.PI)
    opponent(b);commandMove(b,[moving.id],128,100,null);tick(b,16)
    expect(moving.soldiers[0].x).toBeGreaterThan(122)
    expect(standing.soldiers.every(s=>s.hp===UNITS.spear.hp&&s.down===0)).toBe(true)
    expect(displacement(standing)).toBeLessThan(.7)
    expect(battleErrors(b)).toEqual([])
  })
  it('two full allied infantry regiments can pass in opposite directions without a permanent jam',()=> {
    const b=createEmptyBattle(87),a=spawn(b,0,'sword','outbound',100,95,Math.PI/2),c=spawn(b,0,'sword','inbound',100,125,-Math.PI/2)
    opponent(b);commandMove(b,[a.id],100,130,null);commandMove(b,[c.id],100,90,null);tick(b,32)
    expect(a.soldiers.filter(s=>s.y>118).length).toBe(80)
    expect(c.soldiers.filter(s=>s.y<102).length).toBe(80)
    expect([...a.soldiers,...c.soldiers].every(s=>s.hp===UNITS.sword.hp)).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })
  it.each([0,6.5])('a nearby U-turn at speed %s stays inside a compact envelope while rolling',initialSpeed=> {
    const b=createEmptyBattle(86),r=single(b,'chariot',100,100,0),s=r.soldiers[0]
    s.speed=initialSpeed
    opponent(b);commandMove(b,[r.id],98,100,null)
    let excursion=0,travel=0,rollingTurn=0
    for(let i=0;i<240;i++) {
      const x=s.x,y=s.y;step(b,.05)
      const moved=Math.hypot(s.x-x,s.y-y);travel+=moved
      if(moved>.005) rollingTurn+=Math.abs(s.omega)*.05
      excursion=Math.max(excursion,Math.hypot(s.x-100,s.y-100))
    }
    expect(Math.hypot(s.x-98,s.y-100)).toBeLessThan(.5)
    expect(excursion).toBeLessThan(initialSpeed?8:6)
    expect(travel).toBeLessThan(initialSpeed?24:20)
    expect(rollingTurn).toBeGreaterThan(3)
    tick(b,2)
    expect(Math.hypot(s.x-98,s.y-100)).toBeLessThan(.5)
    expect(s.speed).toBeLessThan(.1)
    expect(battleErrors(b)).toEqual([])
  })
  it('the complete mixed passing scene gets all four carts and the infantry through allied formations',()=> {
    const b=createScenario('friendlypass',42),foot=b.regiments[1],carts=b.regiments[3]
    tick(b,28)
    expect(foot.soldiers.filter(s=>s.y>140).length).toBe(80)
    expect(carts.soldiers.filter(s=>s.y>140).length).toBe(4)
    expect(b.regiments.every(r=>r.soldiers.every(s=>s.hp===UNITS[r.type].hp&&s.down===0))).toBe(true)
    expect(displacement(b.regiments[0])).toBeLessThan(.4)
    expect(displacement(b.regiments[2])).toBeLessThan(.7)
    expect(battleErrors(b)).toEqual([])
  })
})
