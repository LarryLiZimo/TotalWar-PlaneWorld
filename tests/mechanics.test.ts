import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { sweptCylinderT } from '../src/sim/ballistics'
import { calibrationRadius, fatigueMods, resistanceMultiplier, woundMods } from '../src/sim/combat'
import { bracingMassMultiplier, chargeDefended, gapBetween, isBracing } from '../src/sim/formation'
import { FATIGUE, MECHANICS, fatigueAt } from '../src/sim/mechanics'
import { advanceMorale } from '../src/sim/morale'
import { commandAttack, commandBehavior, commandMove } from '../src/sim/orders'
import { createScenario } from '../src/sim/scenarios'
import { battleErrors, battleSnapshot } from '../src/sim/diagnostics'
import { angDiff } from '../src/sim/math'
import type { Battle, Projectile, Regiment, UnitDef, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

function one(b: Battle, side: 0|1, type: UnitType, x: number, y: number, facing=Math.PI/2): Regiment {
  const r=spawn(b,side,type,type,x,y,facing)
  for (const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1); r.aliveCount=r.initial=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,meleeCd:0,reload:0})
  return r
}
/** Centre distance at which this body's front touches a sword's (circle) body: its own extent plus the sword's radius. */
const bodyReach=(def:UnitDef)=>(def.shape==='capsule'?def.length/2:def.radius)+UNITS.sword.radius
function tick(b: Battle, seconds: number) { for (let i=0;i<Math.round(seconds/0.05);i++) step(b,0.05) }
const health=(r:Regiment)=>r.soldiers.reduce((sum,s)=>sum+s.hp,0)
const dealt=(r:Regiment)=>r.dealt.reduce((sum,e)=>sum+e.v,0)
function projectile(source:Regiment, patch: Partial<Projectile>={}): Projectile {
  return {x:100,y:60,vx:0,vy:40,z:1.2,vz:0,gravity:0,base:0,ap:12,
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

describe('rams versus collision attacks',()=>{
  it('a stationary bogged chariot pressed against infantry makes no collision attack: only a body running in strikes',()=>{
    const b=createEmptyBattle(6);b.rng=()=>0.1
    const cart=one(b,0,'chariot',100,100,0), target=one(b,1,'sword',101.5,100,Math.PI)
    cart.soldiers[0].meleeCd=target.soldiers[0].meleeCd=100
    cart.bogged=true;commandAttack(b,[cart.id],target.id)
    tick(b,2)
    expect(health(target)).toBe(64);expect(cart.soldiers[0].collisionCd).toBe(0)
  })

  it('a chariot running into a man strikes him with its collision attack on its own cooldown, then the ram throws him',()=>{
    const b=createEmptyBattle(6);b.rng=()=>0.1
    const cart=one(b,0,'chariot',100,100,0), target=one(b,1,'sword',100+bodyReach(UNITS.chariot)+0.3,100,Math.PI)
    // A charge already in progress (with no bonus) keeps a new one from starting, so no charge strike: only the
    // collision attack hurts him, and the swing timer is untouched.
    Object.assign(cart.soldiers[0],{speed:9,vx:9,meleeCd:100,chargeLeft:100})
    target.soldiers[0].meleeCd=100
    commandAttack(b,[cart.id],target.id);step(b,0.05)
    expect(cart.soldiers[0].chargeContactAt).toBe(-1)
    expect(health(target)).toBeLessThan(64);expect(target.soldiers[0].down).toBeGreaterThan(0)
    expect(cart.soldiers[0].collisionCd).toBeCloseTo(UNITS.chariot.collisionAttack!.interval,9)
    expect(cart.soldiers[0].meleeCd).toBeGreaterThan(99)
  })

  it('a collision attack hits at most its target limit, each for a full share of the weapon',()=>{
    const b=createEmptyBattle(8);b.rng=()=>0.1
    const beast=one(b,0,'monster',100,100,0),def=UNITS.monster
    // Five swordsmen in an arc 0.2 m in front of the running beast, all within ramming contact at once.
    const men=[-36,-18,0,18,36].map(a=>{const d=def.radius+UNITS.sword.radius+0.2,r=a*Math.PI/180
      const m=one(b,1,'sword',100+Math.cos(r)*d,100+Math.sin(r)*d,Math.PI+r);m.soldiers[0].meleeCd=100;m.soldiers[0].hp=1e5;return m})
    // An unexpired charge keeps it from arming a new one, so only the collision attack can strike.
    Object.assign(beast.soldiers[0],{speed:def.chargeSpeed,vx:def.chargeSpeed,meleeCd:100,chargeLeft:100})
    commandAttack(b,[beast.id],men[2].id);step(b,0.05)
    const hurt=men.filter(m=>health(m)<1e5)
    expect(hurt).toHaveLength(def.collisionAttack!.targets)
    // Each target takes the weapon strength times the attack's damage, not a split of one swing.
    expect(Math.min(...hurt.map(m=>1e5-health(m)))).toBeGreaterThan(def.weaponAp)
    expect(men.every(m=>m.soldiers[0].down>0)).toBe(true)
  })

  it('a standing monster charged head-on deals the rider nothing: the body run into never strikes the rammer',()=>{
    const b=createEmptyBattle(7);b.rng=()=>0.1
    const monster=one(b,1,'monster',100,102.45,-Math.PI/2),rider=one(b,0,'heavyCavalry',100,100)
    expect(gapBetween(rider.soldiers[0],UNITS.heavyCavalry,monster.soldiers[0],UNITS.monster)).toBeCloseTo(0.4,3)
    rider.soldiers[0].speed=8;rider.soldiers[0].vy=8
    rider.soldiers[0].meleeCd=monster.soldiers[0].meleeCd=100
    commandAttack(b,[rider.id],monster.id);commandAttack(b,[monster.id],rider.id)
    let closing=0
    for(let i=0;i<4;i++) { step(b,0.05);closing=Math.max(closing,rider.soldiers[0].vy-monster.soldiers[0].vy) }
    // Fast enough for a full-strength contact were the monster the one acting: it is not, as it does not move itself.
    expect(closing).toBeGreaterThan(UNITS.monster.chargeSpeed)
    expect(health(rider)).toBe(UNITS.heavyCavalry.hp);expect(rider.soldiers[0].down).toBe(0)
    expect(monster.dealt).toHaveLength(0)
  })

  it('two chariots ramming each other head-on both strike, whatever the target size',()=>{
    const b=createEmptyBattle(9);b.rng=()=>0.1
    const ext=UNITS.chariot.length/2
    const a=one(b,0,'chariot',100,100,0),c=one(b,1,'chariot',100+2*ext+0.3,100,Math.PI)
    Object.assign(a.soldiers[0],{speed:8,vx:8,meleeCd:100});Object.assign(c.soldiers[0],{speed:8,vx:-8,meleeCd:100})
    commandAttack(b,[a.id],c.id);commandAttack(b,[c.id],a.id)
    step(b,0.05)
    expect(health(a)).toBeLessThan(UNITS.chariot.hp);expect(health(c)).toBeLessThan(UNITS.chariot.hp)
    expect(a.soldiers[0].down).toBe(0);expect(c.soldiers[0].down).toBe(0)
  })

  it('rams deal no damage and knock down only bodies of physical size 1; the rammer pays by momentum',()=>{
    // Two light targets of the same mass, one of them only made bigger: a demigryph rams both, only the man falls.
    const units=UNITS as Record<string,UnitDef>
    units.sizeTwoSword={...UNITS.sword,type:'sizeTwoSword' as UnitType,physicalSize:2}
    try {
      const run=(bigger:boolean)=>{
        const b=createEmptyBattle(7)
        const a=one(b,0,'demigryph',100,99), d=one(b,1,'sword',100,99+bodyReach(UNITS.demigryph)+0.3,-Math.PI/2)
        if(bigger) d.type='sizeTwoSword' as UnitType
        // A charge in progress (with no bonus) keeps the rider from a charge strike: only the ram acts.
        Object.assign(a.soldiers[0],{speed:8,vy:8,chargeLeft:100})
        a.soldiers[0].meleeCd=d.soldiers[0].meleeCd=100
        commandAttack(b,[a.id],d.id);step(b,0.05)
        return {lost:UNITS.sword.hp-health(d),down:d.soldiers[0].down,speed:a.soldiers[0].speed}
      }
      const man=run(false),big=run(true)
      expect(man.lost).toBe(0);expect(man.down).toBeGreaterThan(0)
      expect(big.lost).toBe(0);expect(big.down).toBe(0)
      // An inelastic exchange with the struck body's impact mass (mass × impactMass, unbraced): about 8 × 1900 / 3000.
      const impact=UNITS.sword.mass*MECHANICS.impactMass, kept=UNITS.demigryph.mass/(UNITS.demigryph.mass+impact)
      expect(man.speed).toBeCloseTo(8.1*kept,0)
      // The body that stands takes the same share of the rammer's momentum, then also blocks it like any body in the way.
      expect(big.speed).toBeLessThanOrEqual(man.speed+1e-9)
    } finally { delete units.sizeTwoSword }
  })

  it.each(['monster','behemoth','giant'] as const)('a running %s pushes a rider but never knocks it down',type=>{
    const b=createEmptyBattle(5);b.rng=()=>0.1
    const def=UNITS[type],beast=one(b,1,type,100,100+def.radius+UNITS.heavyCavalry.radius+0.3,-Math.PI/2),rider=one(b,0,'heavyCavalry',100,100)
    Object.assign(beast.soldiers[0],{speed:def.chargeSpeed,vy:-def.chargeSpeed,meleeCd:100,chargeLeft:100,collisionCd:100})
    rider.soldiers[0].meleeCd=100
    commandAttack(b,[beast.id],rider.id)
    const y=rider.soldiers[0].y
    tick(b,0.5)
    expect(rider.soldiers[0].down).toBe(0);expect(health(rider)).toBe(UNITS.heavyCavalry.hp)
    expect(rider.soldiers[0].y).toBeLessThan(y)
  })

  it.each(['lightCavalry','chariot'] as const)('a routing %s still throws men down but deals no damage, credit, plough or contact hold',type=>{
    const run=(routing:boolean)=>{
      const b=createEmptyBattle(7),north=Math.PI/2,south=-north
      // Caught between two enemy sword blocks, it runs for its own (south) edge through the southern block.
      const cav=spawn(b,0,type,'mounted',150,99,south,{models:4,files:4})
      spawn(b,0,'sword','far friend',30,30,north,{models:8,files:8})
      const block=spawn(b,1,'sword','south block',150,92,north,{models:32,files:16})
      spawn(b,1,'sword','north block',150,103,south,{models:32,files:16})
      if(routing) Object.assign(cav,{routing:true,moraleState:'routing',routCount:1,order:'hold'})
      else commandAttack(b,[cav.id],block.id)
      // Already at a run: the men, and for the attack the line they keep, are moving at 7 m/s.
      for(const s of cav.soldiers) Object.assign(s,{speed:7,facing:south})
      if(!routing) cav.anchorSpeed=7
      const hp=health(block)
      let downs=0,lock=0,plough=0,dealtTotal=0
      for(let i=0;i<80;i++) {
        const before=block.soldiers.map(s=>s.down)
        step(b,0.05)
        block.soldiers.forEach((s,k)=>{if(s.down>0&&before[k]<=0) downs++})
        lock=Math.max(lock,...cav.soldiers.map(s=>s.impactHold));plough=Math.max(plough,cav.plow,...cav.soldiers.map(s=>s.plowLeft))
        dealtTotal+=cav.dealt.filter(e=>e.t===b.time).reduce((n,e)=>n+e.v,0)
        if(routing) expect(cav.routing).toBe(true)
      }
      return {lost:hp-block.soldiers.reduce((n,s)=>n+(s.alive?s.hp:0),0),downs,lock,plough,dealtTotal}
    }
    const fleeing=run(true)
    expect(fleeing.downs).toBeGreaterThan(0)
    expect(fleeing.lost).toBe(0);expect(fleeing.dealtTotal).toBe(0)
    expect(fleeing.lock).toBe(0);expect(fleeing.plough).toBe(0)
    // Control: the same unit ordered to attack the block throws men too and holds the melee (light cavalry) or
    // ploughs on (chariot); only the chariot, which has a collision attack, hurts them on contact.
    const attacking=run(false)
    expect(attacking.downs).toBeGreaterThan(0)
    if(type==='chariot') { expect(attacking.lost).toBeGreaterThan(0);expect(attacking.plough).toBeGreaterThan(0) }
    else expect(attacking.lock).toBeGreaterThan(0)
  })

  it('every rammer but a chariot holds the melee it rammed into',()=>{
    const ram=(type:UnitType)=>{
      const b=createEmptyBattle(9);b.rng=()=>0.1
      const def=UNITS[type],a=one(b,0,type,100,100),d=one(b,1,'sword',100,100+bodyReach(def)+0.4,-Math.PI/2)
      a.soldiers[0].speed=def.chargeSpeed;a.soldiers[0].vy=def.chargeSpeed
      a.soldiers[0].meleeCd=d.soldiers[0].meleeCd=100;d.soldiers[0].hp=1e5
      commandAttack(b,[a.id],d.id);step(b,0.05)
      expect(d.soldiers[0].down,type).toBeGreaterThan(0)
      return a
    }
    for (const type of ['heavyCavalry','ogre','armoredOgre','monster'] as UnitType[]) {
      const a=ram(type)
      expect(a.soldiers[0].impactHold,type).toBeCloseTo(MECHANICS.impactContactHold,6);expect(a.engaged,type).toBe(true)
    }
    const cart=ram('chariot')
    expect(cart.soldiers[0].impactHold).toBe(0);expect(cart.plow).toBeGreaterThan(0)
  })

  /** A single `type` running at `fraction` of its charge speed, one step short of a standing swordsman (hp 1e5), its
   * charge already in progress with no bonus so that only the ram and the collision attack act. */
  function runIn(type:UnitType,fraction:number,seed=6) {
    const b=createEmptyBattle(seed),def=UNITS[type],v=def.chargeSpeed*fraction
    const a=one(b,0,type,100,100,0),d=one(b,1,'sword',100+bodyReach(def)+0.1+v*0.05,100,Math.PI)
    Object.assign(a.soldiers[0],{speed:v,vx:v,meleeCd:100,chargeLeft:100})
    Object.assign(d.soldiers[0],{meleeCd:100,hp:1e5})
    commandAttack(b,[a.id],d.id)
    return {b,a,d}
  }

  it('the stone beast, whose charge speed is under 5 m/s, collision-attacks a standing sword block at its charge speed',()=>{
    const b=createEmptyBattle(6);b.rng=()=>0.1
    const def=UNITS.stoneBeast,v=def.chargeSpeed
    expect(v).toBeLessThan(5)
    const swords=spawn(b,1,'sword','swords',110,100,Math.PI,{models:16,files:8})
    for(const s of swords.soldiers) Object.assign(s,{meleeCd:100,hp:1e5})
    const first=swords.soldiers.filter(s=>s.rank===0).sort((p,q)=>Math.abs(p.y-100)-Math.abs(q.y-100))[0]
    const beast=one(b,0,'stoneBeast',first.x-def.radius-UNITS.sword.radius-0.1-v*0.05,first.y,0)
    Object.assign(beast.soldiers[0],{speed:v,vx:v,meleeCd:100,chargeLeft:100})
    commandAttack(b,[beast.id],swords.id);step(b,0.05)
    const hurt=swords.soldiers.filter(s=>s.hp<1e5)
    expect(hurt.length).toBeGreaterThan(0)
    expect(hurt.length).toBeLessThanOrEqual(def.collisionAttack!.targets)
    expect(beast.soldiers[0].collisionCd).toBeCloseTo(def.collisionAttack!.interval,9)
    expect(swords.soldiers.some(s=>s.down>0)).toBe(true)
  })

  it('collision damage grows with closing speed over the attacker\'s charge speed, and stops below the threshold',()=>{
    const damage=(fraction:number)=>{
      const {b,a,d}=runIn('chariot',fraction);b.rng=()=>0.1
      step(b,0.05)
      expect(a.soldiers[0].chargeContactAt).toBe(-1)
      return 1e5-d.soldiers[0].hp
    }
    const below=damage(MECHANICS.speedThreshold-0.1),slow=damage(0.6),fast=damage(0.8),full=damage(1)
    expect(below).toBe(0)
    expect(slow).toBeGreaterThan(0)
    expect(slow).toBeLessThan(fast);expect(fast).toBeLessThan(full)
    expect(slow/full).toBeGreaterThan(0.55);expect(slow/full).toBeLessThan(0.7)
  })

  it('a man goes down when the ram changes his speed by knockdownSpeedChange; only the first ram of a charge needs charge speed',()=>{
    // Unbraced sword against heavy cavalry: the man gains closing × 1200 / (1200 + 110 × impactMass).
    const gain=UNITS.heavyCavalry.mass/(UNITS.heavyCavalry.mass+UNITS.sword.mass*MECHANICS.impactMass)
    const knee=MECHANICS.knockdownSpeedChange/gain
    const ram=(speed:number,ploughing:boolean)=>{
      const {b,a,d}=runIn('heavyCavalry',speed/UNITS.heavyCavalry.chargeSpeed,6)
      if(ploughing) a.soldiers[0].plowLeft=1
      step(b,0.05)
      return {down:d.soldiers[0].down>0,speed:a.soldiers[0].speed,plough:a.soldiers[0].plowLeft}
    }
    // While ploughing, every man met is rammed: just below the knee he stands (and the plough ends), just above he falls.
    expect(knee).toBeGreaterThan(1.1)
    const soft=ram(knee*0.85,true),hard=ram(knee*1.2,true)
    expect(soft.down).toBe(false);expect(soft.plough).toBe(0)
    expect(hard.down).toBe(true);expect(hard.plough).toBeGreaterThan(0)
    // A first contact below the charge-speed threshold is no ram at all, however hard it would hit.
    expect(knee).toBeLessThan(MECHANICS.speedThreshold*UNITS.heavyCavalry.chargeSpeed)
    expect(ram((MECHANICS.speedThreshold-0.1)*UNITS.heavyCavalry.chargeSpeed,false).down).toBe(false)
    // At full charge speed he goes down, the rider keeps closing × gain and ploughs on.
    const full=ram(UNITS.heavyCavalry.chargeSpeed,false)
    expect(full.down).toBe(true);expect(full.plough).toBeGreaterThan(0)
    expect(full.speed).toBeCloseTo(UNITS.heavyCavalry.chargeSpeed*gain,0)
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

  it('a regiment standing on a run+attack order rests: fatigue follows what the bodies do, not order flags',()=>{
    // Musketeers whose every shot is blocked by a friendly line stand still once the first reload is over.
    const b=createEmptyBattle(2),north=Math.PI/2
    const musket=spawn(b,0,'musket','blocked',150,60,north)
    spawn(b,0,'sword','screen',150,72,north,{models:80,files:40})
    const enemy=spawn(b,1,'spear','target',150,115,-north)
    commandAttack(b,[musket.id],enemy.id);musket.exertion=5000
    tick(b,UNITS.musket.missile!.reload+1)
    const start=musket.exertion
    tick(b,5)
    expect(musket.run&&musket.order==='attack').toBe(true);expect(musket.soldiers.every(s=>s.chargeArmed)).toBe(true)
    expect(musket.shot).toBe(false);expect(musket.bodySpeed).toBeLessThan(0.3)
    expect(musket.exertion-start).toBeCloseTo(MECHANICS.fatigueRates.rest*5,0)
  })

  it('a routing regiment counts as running whatever its gait toggle',()=>{
    const b=createEmptyBattle(11),r=spawn(b,0,'militia','walkers',150,100,Math.PI/2)
    // A steady friend far off keeps the battle going while the walkers flee.
    spawn(b,0,'sword','friend',30,30,Math.PI/2);spawn(b,1,'sword','far',150,200,-Math.PI/2)
    commandBehavior(b,[r.id],{run:false})
    Object.assign(r,{routing:true,moraleState:'routing',routCount:1,order:'hold',exertion:8000})
    tick(b,1);const start=r.exertion
    tick(b,3)
    expect(r.run).toBe(false);expect(r.routing).toBe(true);expect(r.bodySpeed).toBeGreaterThan(0.3)
    expect(r.exertion-start).toBeCloseTo(MECHANICS.fatigueRates.run*3,0)
  })

  it('tires at the charge rate only in the charge itself: charge intent at the speed threshold or faster, within charging distance',()=>{
    const b=createEmptyBattle(4),foot=spawn(b,0,'sword','foot',150,30,Math.PI/2)
    const target=spawn(b,1,'sword','target',150,210,-Math.PI/2)
    commandAttack(b,[foot.id],target.id)
    step(b,0.05)
    expect(foot.soldiers.every(s=>s.chargeArmed)).toBe(true)
    // Far from the target men on foot only run up to it: intent, and a pace past the charge's speed threshold, but no charge.
    tick(b,6);const running=foot.exertion
    tick(b,2)
    expect(foot.wantCharge).toBe(false)
    expect(foot.bodySpeed).toBeGreaterThan(MECHANICS.speedThreshold*UNITS.sword.chargeSpeed)
    expect(foot.exertion-running).toBeCloseTo(MECHANICS.fatigueRates.run*2,0)
    // The same men ordered to walk at the target have no charge intent at all: walking pace recovers.
    commandBehavior(b,[foot.id],{run:false});tick(b,3)
    const walking=foot.exertion;tick(b,2)
    expect(foot.soldiers.some(s=>s.chargeArmed)).toBe(false)
    expect(foot.exertion-walking).toBeCloseTo(MECHANICS.fatigueRates.walk*2,0)
    // Running again, they break into the charge within charging distance of the target and tire at its rate.
    commandBehavior(b,[foot.id],{run:true})
    for(let i=0;i<2400&&!foot.wantCharge;i++) step(b,0.05)
    expect(foot.wantCharge).toBe(true)
    tick(b,0.5);const start=foot.exertion
    tick(b,1.5)
    expect(foot.inContact).toBe(false)
    expect(foot.exertion-start).toBeCloseTo(MECHANICS.fatigueRates.charge*1.5,0)
    // Horses are sent in at the charge from the start, however far off the target is.
    const cav=spawn(b,0,'heavyCavalry','riders',60,30,Math.PI/2),far=spawn(b,1,'sword','far',60,210,-Math.PI/2)
    commandAttack(b,[cav.id],far.id)
    tick(b,4);const riding=cav.exertion
    tick(b,2)
    expect(cav.wantCharge).toBe(true);expect(cav.inContact).toBe(false)
    expect(cav.bodySpeed).toBeCloseTo(UNITS.heavyCavalry.chargeSpeed,0)
    expect(cav.exertion-riding).toBeCloseTo(MECHANICS.fatigueRates.charge*2,0)
  })

  it('waits for ordinary missile troops to brake even with an explicit attack target',()=>{
    const b=createEmptyBattle(12),a=one(b,0,'musket',100,60),d=one(b,1,'spear',100,105,-Math.PI/2)
    Object.assign(a.soldiers[0],{speed:2,vy:2})
    commandAttack(b,[a.id],d.id);step(b,0.05)
    expect(a.soldiers[0].speed).toBeGreaterThan(0.5)
    expect(a.soldiers[0].ammo).toBe(10)
    tick(b,2);expect(a.soldiers[0].ammo).toBe(9)
  })
})

describe('morale state machine',()=>{
  it('tolerates short negative leadership, then routes after a sustained interval',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    advanceMorale(r,-1,true,false,1)
    expect(r.moraleState).toBe('wavering');expect(r.routing).toBe(false)
    advanceMorale(r,0,true,false,0.1);expect(r.negativeTime).toBe(0)
    for(let i=0;i<49;i++) advanceMorale(r,-1,true,false,0.05)
    expect(r.routing).toBe(false)
    advanceMorale(r,-1,true,false,0.05)
    expect(r.routing).toBe(true);expect(r.routCount).toBe(1)
  })

  it('routs at once at or below the instant-rout leadership, otherwise only after the delay',()=>{
    expect(MECHANICS.instantRoutLeadership).toBe(-30)
    const b=createEmptyBattle(1),at=one(b,0,'sword',100,100),above=one(b,0,'sword',120,100)
    advanceMorale(at,MECHANICS.instantRoutLeadership,false,false,0.05)
    expect(at.routing).toBe(true);expect(at.shattered).toBe(false)
    advanceMorale(above,MECHANICS.instantRoutLeadership+1,false,false,0.05)
    expect(above.routing).toBe(false)
  })

  it('shattered units never rally even when leadership recovers',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    // Very low leadership routs at once but only the third rout shatters.
    advanceMorale(r,-60,false,false,0.05)
    expect(r.routing).toBe(true);expect(r.shattered).toBe(false)
    Object.assign(r,{routing:false,moraleState:'steady',routCount:2})
    advanceMorale(r,-60,false,false,0.05)
    for(let i=0;i<800;i++) advanceMorale(r,100,false,false,0.05)
    expect(r.shattered).toBe(true);expect(r.routing).toBe(true)
  })

  it('can rally ordinary routs but shatters after repeated routs',()=>{
    const b=createEmptyBattle(1),r=one(b,0,'sword',100,100)
    for(let count=1;count<=3;count++) {
      for(let i=0;i<50;i++) advanceMorale(r,-1,true,false,0.05)
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

  it('breaks the whole army for good, not through leadership, once its strength collapses on the power bar',()=>{
    const b=createEmptyBattle(13),r=one(b,0,'sword',100,50)
    one(b,1,'sword',220,190)
    r.soldiers[0].hp=UNITS.sword.hp*0.05
    step(b,0.05)
    expect(r.moraleFactors.armyLosses).toBeUndefined()
    expect(r.routing).toBe(true);expect(r.shattered).toBe(true);expect(b.winner).toBe(1)
  })
})

describe('ballistics and penetration',()=>{
  it('intersects height continuously and can pass over short bodies',()=>{
    expect(sweptCylinderT(0,0,10,0,3,0,0,1,5,0,1,0,1.7)).toBeNull()
    expect(sweptCylinderT(0,0,10,0,3,0,0,1,5,0,1,0,5)).toBeCloseTo(0.4)
    expect(sweptCylinderT(0,0,10,0,3,-3,0,1,5,0,2,0,1.7)).toBeCloseTo(1.3/3)
  })

  it('arrows can hit a body before their intended landing point',()=>{
    const b=createEmptyBattle(12),source=one(b,0,'archer',100,60),d=one(b,1,'spear',100,70,-Math.PI/2)
    source.fireAtWill=false
    b.projectiles.push(projectile(source,{arc:true}))
    tick(b,0.3)
    expect(health(d)).toBe(UNITS.spear.hp-12)
  })

  it('passes over infantry but can strike a taller monster on the same path',()=>{
    const b=createEmptyBattle(13),source=one(b,0,'archer',100,60)
    const foot=one(b,1,'spear',100,70),monster=one(b,1,'monster',100,75)
    source.fireAtWill=false;b.projectiles.push(projectile(source,{z:3}))
    tick(b,0.5)
    expect(health(foot)).toBe(UNITS.spear.hp)
    expect(health(monster)).toBe(UNITS.monster.hp-12)
  })

  it('penetrates once with reduced damage and never damages the same body twice',()=>{
    const b=createEmptyBattle(14),source=one(b,0,'archer',100,60)
    const first=one(b,1,'spear',100,70),second=one(b,1,'spear',100,74)
    source.fireAtWill=false;b.projectiles.push(projectile(source,{penetrationLeft:2}))
    tick(b,0.5)
    expect(health(first)).toBe(64-12);expect(health(second)).toBe(64-8)
    expect(first.taken).toHaveLength(1);expect(second.taken).toHaveLength(1)
  })

  it('uses target penetration resistance rather than a binary large flag',()=>{
    const b=createEmptyBattle(15),source=one(b,0,'archer',100,60)
    const horse=one(b,1,'heavyCavalry',100,70),second=one(b,1,'spear',100,74)
    source.fireAtWill=false;b.projectiles.push(projectile(source,{penetrationLeft:2}))
    tick(b,0.5)
    expect(health(horse)).toBe(UNITS.heavyCavalry.hp-12);expect(health(second)).toBe(64)
  })

  it('uses calibration distance',()=>{
    expect(calibrationRadius(60,60,1)).toBeGreaterThan(calibrationRadius(15,60,1))
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

describe('flat battlefield',()=>{
  it('running tires and carries a unit the same whichever way it runs',()=>{
    const run=(dir:1|-1)=>{
      const b=createEmptyBattle(8)
      const y=dir>0?60:170,a=one(b,0,'sword',100,y,dir*Math.PI/2)
      one(b,1,'sword',250,200)
      commandMove(b,[a.id],100,y+dir*60,null)
      // Past the start, once the men are up to running pace.
      tick(b,2);const start=a.exertion
      tick(b,3)
      expect(a.bodySpeed).toBeGreaterThan(0.3);expect(angDiff(a.facing,dir*Math.PI/2)).toBeCloseTo(0,3)
      return {gain:a.exertion-start,travel:Math.abs(a.soldiers[0].y-y)}
    }
    const north=run(1),south=run(-1)
    expect(north.gain).toBeCloseTo(MECHANICS.fatigueRates.run*3,0)
    expect(south.gain).toBeCloseTo(north.gain,6);expect(south.travel).toBeCloseTo(north.travel,6)
  })

  it('a projectile that reaches the ground (height 0) is spent',()=>{
    const b=createEmptyBattle(16),source=one(b,0,'archer',100,60)
    one(b,1,'sword',250,200)
    source.fireAtWill=false
    b.projectiles.push(projectile(source,{z:0.3,vz:-2,gravity:9.81,landX:100,landY:62}))
    step(b,0.05)
    expect(b.projectiles).toHaveLength(1)
    tick(b,0.3)
    expect(b.projectiles).toHaveLength(0)
  })
})

describe('mechanics scenarios',()=>{
  it.each(['collision','wounds','morale','cartturn','cavturn','reform','cartescape','reserves','friendlypass'] as const)('%s stays valid and exactly reproducible',name=>{
    const run=()=>{const b=createScenario(name,42);tick(b,10);expect(battleErrors(b)).toEqual([]);return battleSnapshot(b)}
    expect(run()).toEqual(run())
  },15000)
})
