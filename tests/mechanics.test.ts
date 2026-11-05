import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { sweptCylinderT } from '../src/sim/ballistics'
import { calibrationRadius, fatigueMods, resistanceMultiplier, woundMods } from '../src/sim/combat'
import { bracingMassMultiplier, chargeDefended, isBracing } from '../src/sim/formation'
import { FATIGUE, MECHANICS, fatigueAt } from '../src/sim/mechanics'
import { advanceMorale } from '../src/sim/morale'
import { commandAttack, commandBehavior, commandMove } from '../src/sim/orders'
import { createScenario } from '../src/sim/scenarios'
import { battleErrors, battleSnapshot } from '../src/sim/diagnostics'
import { elevationDamage, slopeFatigue, slopeSpeed } from '../src/sim/terrain'
import type { Battle, Projectile, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

function one(b: Battle, side: 0|1, type: UnitType, x: number, y: number, facing=Math.PI/2): Regiment {
  const r=spawn(b,side,type,type,x,y,facing)
  for (const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1); r.aliveCount=r.initial=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,meleeCd:0,reload:0})
  return r
}
function tick(b: Battle, seconds: number) { for (let i=0;i<Math.round(seconds/0.05);i++) step(b,0.05) }
const health=(r:Regiment)=>r.soldiers.reduce((sum,s)=>sum+s.hp,0)
const dealt=(r:Regiment)=>r.dealt.reduce((sum,e)=>sum+e.v,0)
function projectile(source:Regiment, patch: Partial<Projectile>={}): Projectile {
  return {x:100,y:60,vx:0,vy:40,z:1.2,vz:0,gravity:0,sourceGround:0,base:0,ap:12,
    side:0,sourceReg:source.id,shooterId:source.soldiers[0].id,traveled:0,maxRange:85,
    alive:true,arc:false,originX:100,originY:60,landX:100,landY:110,age:0,duration:1.25,apex:0,
    penetrationLeft:1,hitIds:[],...patch}
}

describe('independent charge attributes and bracing',()=>{
  it('does not infer charge defence from an anti-large bonus',()=>{
    const b=createEmptyBattle(1), r=one(b,0,'spear',100,100)
    r.soldiers[0].braceTime=1
    const noDefense={...UNITS.spear,chargeDefense:'none' as const}
    expect(chargeDefended(r,noDefense,r.soldiers[0],UNITS.heavyCavalry,100,101)).toBe(false)
    const noBonus={...UNITS.spear,antiLargeMa:0,antiLargeWs:0}
    expect(chargeDefended(r,noBonus,r.soldiers[0],UNITS.heavyCavalry,100,101)).toBe(true)
    expect(chargeDefended(r,noBonus,r.soldiers[0],UNITS.sword,100,101)).toBe(false)
    expect(chargeDefended(r,{...noBonus,chargeDefense:'all'},r.soldiers[0],UNITS.sword,100,101)).toBe(true)
    expect(chargeDefended(r,noBonus,r.soldiers[0],UNITS.heavyCavalry,100,99)).toBe(false)
  })

  it('allows surviving soldiers below half strength to brace, with rank-dependent support',()=>{
    const b=createEmptyBattle(1), r=spawn(b,0,'spear','spear',100,100,Math.PI/2)
    r.soldiers.slice(20).forEach(s=>{s.alive=false;s.hp=0}); r.aliveCount=20
    const s=r.soldiers[0]; s.braceTime=1
    expect(isBracing(r,UNITS.spear,s.x,s.y+2,s)).toBe(true)
    r.files=20; const shallow=bracingMassMultiplier(r)
    r.files=3; expect(bracingMassMultiplier(r)).toBeGreaterThan(shallow)
    const rear=r.soldiers[16];rear.braceTime=1
    expect(isBracing(r,UNITS.spear,rear.x,r.anchorY-0.1,rear)).toBe(false)
  })

  it('reflects weapon damage only in the short contact window',()=>{
    const run=(time:number)=>{
      const b=createEmptyBattle(1); b.rng=()=>0.1; b.time=time
      const spear=one(b,0,'spear',100,100), enemy=one(b,1,'sword',100,101,-Math.PI/2)
      spear.soldiers[0].braceTime=2
      enemy.soldiers[0].chargeContactAt=0; enemy.soldiers[0].meleeCd=100
      tick(b,0.45)
      return dealt(spear)
    }
    expect(run(0)).toBe(2*run(MECHANICS.chargeReflectWindow+1))
  })
})

describe('animated melee and wounds',()=>{
  it('waits for windup and misses if the target leaves its attack zone',()=>{
    const b=createEmptyBattle(1);b.rng=()=>0.1
    const a=one(b,0,'sword',100,100), d=one(b,1,'sword',100,101,-Math.PI/2)
    d.soldiers[0].meleeCd=100
    step(b,0.05)
    expect(a.soldiers[0].swing).not.toBeNull();expect(health(d)).toBe(64)
    d.anchorY=d.destY=d.soldiers[0].y=120
    tick(b,1)
    expect(health(d)).toBe(64);expect(a.soldiers[0].meleeCd).toBeGreaterThan(0)
  })

  it('cancels a pending swing when ordered to move',()=>{
    const b=createEmptyBattle(2);b.rng=()=>0.1
    const a=one(b,0,'sword',100,100), d=one(b,1,'sword',100,101,-Math.PI/2)
    d.soldiers[0].meleeCd=100;step(b,0.05)
    commandMove(b,[a.id],100,80,null);tick(b,0.7)
    expect(a.soldiers[0].swing).toBeNull();expect(health(d)).toBe(64)
  })

  it('uses one concentrated hit against a target above the splash size limit',()=>{
    const b=createEmptyBattle(3);b.rng=()=>0.1
    const hero=one(b,0,'inquisitor',100,100)
    const large=one(b,1,'general',100,101.1,-Math.PI/2)
    const small=one(b,1,'sword',99.2,100.9,-Math.PI/2)
    large.soldiers[0].meleeCd=small.soldiers[0].meleeCd=100
    tick(b,0.8)
    expect(health(large)).toBeLessThan(UNITS.general.hp)
    expect(health(small)).toBe(UNITS.sword.hp)
    expect(hero.dealt).toHaveLength(1)
  })

  it('permits three physically separate attackers to strike the same body',()=>{
    const b=createEmptyBattle(4);b.rng=()=>0.1
    const target=one(b,1,'inquisitor',100,100,0);target.soldiers[0].meleeCd=100
    for (const [x,y] of [[100,101.1],[101.1,100],[100,98.9]]) one(b,0,'sword',x,y,Math.atan2(100-y,100-x))
    tick(b,0.5)
    expect(target.taken).toHaveLength(3)
  })

  it('latches single-entity wounds through healing and reduces weapon damage',()=>{
    const run=(wounded:boolean)=>{
      const b=createEmptyBattle(5);b.rng=()=>0.1
      const a=one(b,0,'inquisitor',100,100),d=one(b,1,'general',100,101,-Math.PI/2)
      d.soldiers[0].meleeCd=100
      if (wounded) a.soldiers[0].hp=UNITS.inquisitor.hp*0.2
      step(b,0.05)
      expect(a.soldiers[0].wounded).toBe(wounded)
      a.soldiers[0].hp=UNITS.inquisitor.hp
      tick(b,0.7)
      expect(a.soldiers[0].wounded).toBe(wounded)
      return {damage:dealt(a),speed:woundMods(UNITS.inquisitor,a.soldiers[0]).speed}
    }
    const healthy=run(false), wounded=run(true)
    expect(wounded.damage).toBeLessThan(healthy.damage)
    expect(wounded.speed).toBeLessThan(healthy.speed)
  })
})

describe('kinetic impact versus contact attacks',()=>{
  it('a stationary bogged chariot retains contact attacks on an independent cooldown',()=>{
    const b=createEmptyBattle(6);b.rng=()=>0.1
    const cart=one(b,0,'chariot',100,100,0), target=one(b,1,'sword',101.5,100,Math.PI)
    cart.soldiers[0].meleeCd=target.soldiers[0].meleeCd=100
    cart.bogged=true;commandAttack(b,[cart.id],target.id)
    step(b,0.05)
    const first=health(target)
    expect(first).toBeLessThan(64);expect(cart.soldiers[0].cleave).toBe(0)
    tick(b,0.4);expect(health(target)).toBe(first)
    tick(b,0.7);expect(health(target)).toBeLessThan(first)
    expect(cart.soldiers[0].meleeCd).toBeGreaterThan(90)
  })

  it('does not apply kinetic impact to an equally sized cavalry target',()=>{
    const b=createEmptyBattle(7);b.rng=()=>0.1
    const a=one(b,0,'heavyCavalry',100,99), d=one(b,1,'heavyCavalry',100,100.2,-Math.PI/2)
    a.soldiers[0].speed=8;a.soldiers[0].vy=8
    a.soldiers[0].meleeCd=d.soldiers[0].meleeCd=100
    commandAttack(b,[a.id],d.id);step(b,0.05)
    expect(health(d)).toBe(UNITS.heavyCavalry.hp)
    expect(d.soldiers[0].down).toBe(0)
  })
})

describe('fatigue and orders',()=>{
  it('uses six stages and distinct armour, AP, attack and defence penalties',()=>{
    expect(Object.keys(FATIGUE)).toHaveLength(6)
    expect(fatigueAt(3000)).toBe('active');expect(fatigueAt(7000)).toBe('winded')
    const m=fatigueMods('exhausted')
    expect(m.attack).toBeLessThan(m.defense);expect(m.armor).toBeLessThan(1);expect(m.ap).toBeLessThan(1)
  })

  it('running tires a unit while walking and resting recover continuously',()=>{
    const run=(walking:boolean)=>{
      const b=createEmptyBattle(8),a=one(b,0,'sword',100,50)
      one(b,1,'sword',220,190)
      a.exertion=walking?5000:0
      commandMove(b,[a.id],100,100,null);commandBehavior(b,[a.id],{run:!walking})
      tick(b,8)
      return a.exertion
    }
    expect(run(false)).toBeGreaterThan(100)
    expect(run(true)).toBeLessThan(5000)
    const b=createEmptyBattle(9),a=one(b,0,'sword',100,50)
    one(b,1,'sword',220,190);a.exertion=7000;tick(b,6)
    expect(a.fatigue).toBe('active')
  })

  it('counts the reload period as exertion and respects free-fire control',()=>{
    const b=createEmptyBattle(10),a=one(b,0,'musket',100,60),d=one(b,1,'spear',100,105,-Math.PI/2)
    commandBehavior(b,[a.id],{fireAtWill:false});tick(b,0.5)
    expect(a.soldiers[0].ammo).toBe(10)
    commandAttack(b,[a.id],d.id);tick(b,1)
    expect(a.soldiers[0].ammo).toBe(9);expect(a.exertion).toBeGreaterThan(50)
  })

  it('waits for ordinary missile troops to brake even with an explicit attack target',()=>{
    const b=createEmptyBattle(12),a=one(b,0,'musket',100,60),d=one(b,1,'spear',100,105,-Math.PI/2)
    Object.assign(a.soldiers[0],{speed:2,vy:2})
    commandAttack(b,[a.id],d.id);step(b,0.05)
    expect(a.soldiers[0].speed).toBeGreaterThan(0.5)
    expect(a.soldiers[0].ammo).toBe(10)
    tick(b,2);expect(a.soldiers[0].ammo).toBe(9)
  })

  it('skirmishes while holding, honours the toggle and yields to manual movement',()=>{
    const b=createEmptyBattle(15),a=one(b,0,'archer',100,60)
    one(b,1,'sword',100,78,-Math.PI/2)
    step(b,0.05)
    expect(a.skirmishing).toBe(true);expect(a.destY).toBeLessThan(60)
    commandBehavior(b,[a.id],{skirmish:false});step(b,0.05)
    expect(a.skirmishing).toBe(false)
    expect(a.destY).toBeCloseTo(a.anchorY,1)
    commandBehavior(b,[a.id],{skirmish:true});commandMove(b,[a.id],130,60,null)
    step(b,0.05)
    expect(a.skirmishing).toBe(false);expect(a.destX).toBe(130)
  })
})

describe('morale state machine',()=>{
  it('tolerates short negative leadership, then routes after a sustained interval',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    advanceMorale(r,-1,true,false,1)
    expect(r.moraleState).toBe('wavering');expect(r.routing).toBe(false)
    advanceMorale(r,0,true,false,0.1);expect(r.negativeTime).toBe(0)
    for(let i=0;i<51;i++) advanceMorale(r,-1,true,false,0.05)
    expect(r.routing).toBe(true);expect(r.routCount).toBe(1)
  })

  it('shattered units never rally even when leadership recovers',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    advanceMorale(r,-60,false,false,0.05)
    for(let i=0;i<800;i++) advanceMorale(r,100,false,false,0.05)
    expect(r.shattered).toBe(true);expect(r.routing).toBe(true)
  })

  it('can rally ordinary routs but shatters after repeated routs',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    for(let count=1;count<=3;count++) {
      for(let i=0;i<51;i++) advanceMorale(r,-1,true,false,0.05)
      expect(r.routCount).toBe(count)
      if(count<3) {
        for(let i=0;i<370;i++) advanceMorale(r,40,false,false,0.05)
        expect(r.routing).toBe(false)
      }
    }
    expect(r.shattered).toBe(true)
  })

  it('does not stack encourage auras and records the commander death penalty',()=>{
    const b=createEmptyBattle(11),r=one(b,0,'sword',100,100)
    const general=one(b,0,'general',110,100),priest=one(b,0,'inquisitor',90,100)
    one(b,1,'sword',220,190);step(b,0.05)
    expect(r.moraleFactors.encourage).toBe(4)
    general.soldiers[0].alive=false;general.soldiers[0].hp=0;general.aliveCount=0
    step(b,0.05)
    expect(r.moraleFactors.encourage).toBe(4)
    expect(r.moraleFactors.commander).toBeLessThan(0)
    expect(priest.aliveCount).toBe(1)
  })

  it('unbreakable overrides panic and the fear scenario requires a damaging terror hit',()=>{
    const old=UNITS.sword
    try {
      UNITS.sword={...old,unbreakable:true}
      const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
      advanceMorale(r,-200,true,true,10)
      expect(r.routing).toBe(false)
    } finally {UNITS.sword=old}
    const b=createScenario('morale',1);step(b,0.05)
    const front=b.regiments.find(r=>r.type==='sword'&&r.anchorX===150)!
    expect(front.moraleFactors.fear).toBeLessThan(0)
    expect(front.taken).toHaveLength(0);expect(front.routing).toBe(false)
    for(let i=0;i<200 && !front.routing;i++) step(b,0.05)
    expect(front.taken.length).toBeGreaterThan(0)
    expect(front.routing).toBe(true)
    expect(front.terrorCooldown).toBe(0)
    expect(b.regiments.find(r=>r.type==='monster')!.terrorCooldown).toBeGreaterThan(0)
  })

  it('applies army losses across surviving units when remaining strength collapses',()=>{
    const b=createEmptyBattle(13),r=one(b,0,'sword',100,50)
    one(b,1,'sword',220,190)
    r.soldiers[0].hp=UNITS.sword.hp*0.05
    step(b,0.05)
    expect(r.moraleFactors.armyLosses).toBe(MECHANICS.armyLossesPenalty)
    expect(r.shattered).toBe(true);expect(r.routing).toBe(true)
  })
})

describe('ballistics, penetration and elevation',()=>{
  it('intersects height continuously and can pass over short bodies',()=>{
    expect(sweptCylinderT(0,0,10,0,3,0,0,1,5,0,1,0,1.7)).toBeNull()
    expect(sweptCylinderT(0,0,10,0,3,0,0,1,5,0,1,0,5)).toBeCloseTo(0.4)
    expect(sweptCylinderT(0,0,10,0,3,-3,0,1,5,0,2,0,1.7)).toBeCloseTo(1.3/3)
  })

  it('arrows can hit a body before their intended landing point',()=>{
    const b=createEmptyBattle(12),source=one(b,0,'archer',100,60),d=one(b,1,'spear',100,70,-Math.PI/2)
    source.soldiers[0].ammo=0
    b.projectiles.push(projectile(source,{arc:true}))
    tick(b,0.3)
    expect(health(d)).toBe(UNITS.spear.hp-12)
  })

  it('passes over infantry but can strike a taller monster on the same path',()=>{
    const b=createEmptyBattle(13),source=one(b,0,'archer',100,60)
    const foot=one(b,1,'spear',100,70),monster=one(b,1,'monster',100,75)
    source.soldiers[0].ammo=0;b.projectiles.push(projectile(source,{z:3}))
    tick(b,0.5)
    expect(health(foot)).toBe(UNITS.spear.hp)
    expect(health(monster)).toBe(UNITS.monster.hp-12)
  })

  it('penetrates once with reduced damage and never damages the same body twice',()=>{
    const b=createEmptyBattle(14),source=one(b,0,'archer',100,60)
    const first=one(b,1,'spear',100,70),second=one(b,1,'spear',100,74)
    source.soldiers[0].ammo=0;b.projectiles.push(projectile(source,{penetrationLeft:2}))
    tick(b,0.5)
    expect(health(first)).toBe(64-12);expect(health(second)).toBe(64-8)
    expect(first.taken).toHaveLength(1);expect(second.taken).toHaveLength(1)
  })

  it('uses target penetration resistance rather than a binary large flag',()=>{
    const b=createEmptyBattle(15),source=one(b,0,'archer',100,60)
    const horse=one(b,1,'heavyCavalry',100,70),second=one(b,1,'spear',100,74)
    source.soldiers[0].ammo=0;b.projectiles.push(projectile(source,{penetrationLeft:2}))
    tick(b,0.5)
    expect(health(horse)).toBe(UNITS.heavyCavalry.hp-12);expect(health(second)).toBe(64)
  })

  it('uses calibration distance and applies uphill/downhill modifiers separately',()=>{
    expect(calibrationRadius(60,60,1)).toBeGreaterThan(calibrationRadius(15,60,1))
    expect(elevationDamage(40,true)).toBe(1.3);expect(elevationDamage(-40,true)).toBe(0.7)
    expect(elevationDamage(1,false)).toBe(1.3)
    const b=createScenario('hill',1)
    expect(slopeSpeed(b,Math.PI/2)).toBeLessThan(1)
    expect(slopeSpeed(b,-Math.PI/2)).toBeGreaterThan(1)
    expect(slopeFatigue(b,Math.PI/2)).toBeGreaterThan(1)
    expect(slopeFatigue(b,-Math.PI/2)).toBe(1)
  })

  it('adds applicable resistances with a cap and keeps magic distinct from AP',()=>{
    const r={physical:0.4,ward:0.2,missile:0.3,spell:0.2,fire:-0.2}
    expect(resistanceMultiplier(r,'melee')).toBeCloseTo(0.4)
    expect(resistanceMultiplier(r,'melee',{magical:true})).toBeCloseTo(0.8)
    expect(resistanceMultiplier(r,'missile',{spell:true})).toBeCloseTo(0.3)
    expect(resistanceMultiplier(r,'melee',{flaming:true})).toBeCloseTo(0.6)
    expect(resistanceMultiplier({...r,ward:1},'melee')).toBeCloseTo(0.1)
  })
})

describe('mechanics scenarios',()=>{
  it.each(['collision','wounds','morale','hill','cartturn','cavturn','reform','cartescape','reserves','friendlypass'] as const)('%s stays valid and exactly reproducible',name=>{
    const run=()=>{const b=createScenario(name,42);tick(b,10);expect(battleErrors(b)).toEqual([]);return battleSnapshot(b)}
    expect(run()).toEqual(run())
  },15000)
})
