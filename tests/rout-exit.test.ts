import {describe,expect,it} from 'vitest'
import {createEmptyBattle,spawn,step} from '../src/sim/battle'
import {battleErrors,battleSnapshot} from '../src/sim/diagnostics'
import {applyFrame,frameOf,packPoses,readBattle,wireBattle} from '../src/sim/transport'
import {commandMove} from '../src/sim/orders'
import {unitPanelData} from '../src/unit-panel'
import {focusRegiment,type Camera} from '../src/camera'
import type {Battle,Regiment,UnitType} from '../src/sim/types'

function route(reg:Regiment) {reg.routing=true;reg.shattered=true;reg.moraleState='shattered'}
function battlefield() {
  const b=createEmptyBattle(71)
  spawn(b,0,'sword','friendly reserve',40,50,Math.PI/2)
  spawn(b,1,'sword','enemy reserve',240,190,-Math.PI/2)
  return b
}
function tick(b:Battle,seconds:number) {for(let i=0;i<seconds/.05;i++) step(b,.05)}

describe('routing units leave the battlefield',()=> {
  it.each([['sword',12,4],['general',1,1],['heavyCavalry',6,3],['chariot',4,2]] as const)('%s flees from inside the map until the whole unit exits',(type,models,files)=> {
    const b=battlefield(),r=spawn(b,0,type as UnitType,'routed',120,24,-Math.PI/2,{models,files})
    const health=r.soldiers.map(s=>s.hp)
    route(r);tick(b,1)
    expect(r.aliveCount).toBe(models);expect(r.soldiers.every(s=>!s.escaped)).toBe(true)
    tick(b,20)
    expect(r.soldiers.every(s=>s.escaped&&!s.alive&&s.deathTime===-1)).toBe(true)
    expect(r.aliveCount).toBe(0);expect(r.soldiers.map(s=>s.hp)).toEqual(health)
    expect(r.taken).toHaveLength(0);expect(battleErrors(b)).toEqual([])
    const positions=r.soldiers.map(s=>[s.x,s.y])
    commandMove(b,[r.id],150,150,null);tick(b,2)
    expect(r.aliveCount).toBe(0);expect(r.soldiers.map(s=>[s.x,s.y])).toEqual(positions)
  })
  it.each([[.3,80],[299.7,80],[120,.3],[120,229.7]])('a living soldier reaching edge (%s,%s) retires the whole unit',(x,y)=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,100,0,{models:8,files:4}),s=r.soldiers[3]
    route(r);Object.assign(s,{x,y,prevX:x,prevY:y})
    step(b,.05)
    expect(r.soldiers.every(s=>s.escaped&&!s.alive&&s.hp===r.modelHp&&s.deathTime===-1)).toBe(true)
    expect(r.aliveCount).toBe(0)
    expect(battleSnapshot(b).regiments.find(item=>item.id===r.id)?.escaped).toBe(8)
  })
  it('lets a straggler escape with the crowd instead of returning to an old formation slot',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,100,-Math.PI/2,{models:3,files:1})
    route(r)
    // Off to one side, already facing the shared escape direction.
    Object.assign(r.soldiers[0],{x:140,y:100,prevX:140,prevY:100,facing:-Math.PI/2})
    tick(b,2)
    expect(r.soldiers[0].x).toBeGreaterThan(139)
    expect(r.soldiers[0].y).toBeLessThan(98)
    expect(r.anchorY).toBeLessThan(100)
    expect(r.aliveCount).toBe(3)
  })
  it.each([0,1] as const)('breaks ranks with different paces while side %s keeps one escape direction',side=> {
    const b=battlefield(),facing=side===0?-Math.PI/2:Math.PI/2
    const r=spawn(b,side,'sword','routed',140,110,facing,{models:24,files:6})
    route(r)
    const positions=r.soldiers.map(s=>({x:s.x,y:s.y}))
    step(b,.05)
    for(const [i,s] of r.soldiers.entries()) expect(Math.hypot(s.x-positions[i].x,s.y-positions[i].y)).toBeLessThan(.1)
    tick(b,6)
    const forward=r.soldiers.map((s,i)=>(s.y-positions[i].y)*(side===0?-1:1))
    expect(Math.min(...forward)).toBeGreaterThan(8)
    expect(Math.max(...forward)-Math.min(...forward)).toBeGreaterThan(2)
    expect(r.soldiers.some((s,i)=>Math.abs(s.x-positions[i].x)>.5)).toBe(true)
    for(const s of r.soldiers) expect(Math.abs(s.vx)).toBeLessThan(Math.abs(s.vy)*.5)
    expect(battleErrors(b)).toEqual([])
  })
  it('replays the same disordered escape exactly without drawing extra combat random numbers',()=> {
    const run=()=> {
      const b=battlefield(),r=spawn(b,0,'sword','routed',140,110,-Math.PI/2,{models:16,files:4})
      route(r)
      const random=b.rng;let calls=0;b.rng=()=>{calls++;return random()}
      tick(b,5)
      expect(calls).toBe(0)
      return battleSnapshot(b)
    }
    expect(run()).toEqual(run())
  })
  it('returns scattered survivors to formation only after rallying, without teleporting their bodies',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',140,110,-Math.PI/2,{models:12,files:4})
    route(r);tick(b,4)
    Object.assign(r,{shattered:false,routeTime:12,rallyTime:7.95})
    const before=r.soldiers.map(s=>({x:s.x,y:s.y}))
    step(b,.05)
    expect(r.routing).toBe(false);expect(r.order).toBe('hold')
    for(const [i,s] of r.soldiers.entries()) expect(Math.hypot(s.x-before[i].x,s.y-before[i].y)).toBeLessThan(.4)
    expect(r.soldiers.every(s=>Number.isFinite(s.x)&&Number.isFinite(s.y))).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })
  it('preserves already dead soldiers when one survivor takes the rest of the regiment out',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,30,-Math.PI/2,{models:3,files:1})
    route(r)
    Object.assign(r.soldiers[0],{x:120,y:.3})
    Object.assign(r.soldiers[2],{alive:false,hp:0,deathTime:0})
    r.aliveCount=2
    r.soldiers[1].hp-=10
    step(b,.05)
    expect(r.aliveCount).toBe(0);expect(r.soldiers.filter(s=>s.escaped)).toHaveLength(2)
    expect(r.soldiers[1].hp).toBe(r.modelHp-10)
    expect([r.soldiers[2].hp,r.soldiers[2].escaped,r.soldiers[2].deathTime]).toEqual([0,false,0])
    const panel=unitPanelData(r)
    expect(panel.hp).toBe(0);expect(panel.escaped).toBe(2)
    expect(battleErrors(b)).toEqual([])
  })
  it('ignores dead soldiers at the edge when deciding whether the regiment exits',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,30,-Math.PI/2,{models:3,files:1})
    route(r);Object.assign(r.soldiers[0],{x:120,y:.3,alive:false,hp:0,deathTime:0});r.aliveCount=2
    step(b,.05)
    expect(r.aliveCount).toBe(2);expect(r.soldiers.every(s=>!s.escaped)).toBe(true)
  })
  it('keeps an orderly unit on the field at the same edge',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','standing',120,10,0,{models:1,files:1}),s=r.soldiers[0]
    Object.assign(s,{x:120,y:.3})
    step(b,.05)
    expect(s.alive).toBe(true);expect(s.escaped).toBe(false);expect(s.y).toBeGreaterThanOrEqual(.8)
  })
  it('cannot rally or rejoin after the whole regiment has exited',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,50,-Math.PI/2,{models:3,files:1})
    Object.assign(r,{routing:true,shattered:false,moraleState:'routing',routeTime:10,rallyTime:7.95})
    Object.assign(r.soldiers[0],{x:120,y:.3})
    for(const s of r.soldiers.slice(1)) s.down=2
    step(b,.05)
    expect(r.routing).toBe(true);expect(r.aliveCount).toBe(0)
    const positions=r.soldiers.map(s=>[s.x,s.y])
    commandMove(b,[r.id],150,150,null);tick(b,30)
    expect(r.routing).toBe(true);expect(r.aliveCount).toBe(0)
    expect(r.soldiers.every(s=>s.escaped&&!s.alive)).toBe(true)
    expect(r.soldiers.map(s=>[s.x,s.y])).toEqual(positions)
  })
  it('excludes escaped soldiers from later melee and collision damage',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,10,-Math.PI/2,{models:1,files:1}),s=r.soldiers[0]
    route(r);s.y=.3;step(b,.05)
    const enemy=spawn(b,1,'sword','pursuer',120,1.1,-Math.PI/2,{models:1,files:1})
    Object.assign(enemy.soldiers[0],{x:s.x,y:s.y+.5,meleeCd:0})
    const hp=s.hp;tick(b,5)
    expect(s.hp).toBe(hp);expect(s.escaped).toBe(true);expect(s.deathTime).toBe(-1)
    expect(r.taken).toHaveLength(0);expect(enemy.dealt).toHaveLength(0)
  })
  it('does not apply commander-death morale when the commander escaped',()=> {
    const b=battlefield(),r=spawn(b,0,'general','commander',120,10,-Math.PI/2),s=r.soldiers[0]
    route(r);Object.assign(s,{x:120,y:.3})
    step(b,.05)
    expect(s.escaped).toBe(true);expect(b.regiments[0].moraleFactors.commander).toBe(0)
    expect(unitPanelData(r).status).toContain('已退场')
  })
  it('sends escape state through the real worker pose format, preserving health without a corpse',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',120,10,-Math.PI/2,{models:6,files:3})
    const view=readBattle(structuredClone(wireBattle(b)))
    route(r);Object.assign(r.soldiers[0],{x:120,y:.3});step(b,.05)
    applyFrame(view,frameOf(b,packPoses(b),[],false))
    const display=view.regiments.find(item=>item.id===r.id)!,s=display.soldiers[0]
    expect([s.alive,s.escaped,s.deathTime,s.hp]).toEqual([false,true,-1,r.modelHp])
    expect(display.aliveCount).toBe(0);expect(display.soldiers.every(s=>s.escaped&&!s.alive)).toBe(true)
    expect(battleErrors(view)).toEqual([])
  })
  it('awards victory to the army still fighting after the last enemy escapes',()=> {
    const b=createEmptyBattle(9),r=spawn(b,0,'sword','routed',120,10,-Math.PI/2,{models:6,files:3})
    spawn(b,1,'sword','enemy',200,180,-Math.PI/2)
    route(r);r.soldiers[0].y=.3;step(b,.05)
    expect(r.aliveCount).toBe(0);expect(b.winner).toBe(1)
  })
})

describe('roster camera focus',()=> {
  it('centres on active bodies instead of an outdated anchor, including routing units, preserving zoom',()=> {
    const b=battlefield(),r=spawn(b,0,'sword','routed',200,150,0,{models:3,files:1})
    route(r)
    Object.assign(r.soldiers[0],{x:20,y:30})
    Object.assign(r.soldiers[1],{x:24,y:32})
    Object.assign(r.soldiers[2],{x:299,y:229,alive:false,hp:0,escaped:false})
    const camera:Camera={x:150,y:115,zoom:5}
    expect(focusRegiment(camera,r)).toBe(true)
    expect(camera).toEqual({x:22,y:31,zoom:5})
  })
  it('leaves the camera in place when everyone has left or died',()=> {
    const b=battlefield(),r=b.regiments[0]
    for(const s of r.soldiers) s.alive=false
    const camera:Camera={x:15,y:25,zoom:3}
    expect(focusRegiment(camera,r)).toBe(false);expect(camera).toEqual({x:15,y:25,zoom:3})
  })
})
