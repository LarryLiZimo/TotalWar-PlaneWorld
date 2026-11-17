import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { CHARGE_DURATION, casualtyPenalty, chargeDecay, defenseMultiplier } from '../src/sim/combat'
import { battleErrors, battleSnapshot } from '../src/sim/diagnostics'
import { gapBetween } from '../src/sim/formation'
import { angDiff } from '../src/sim/math'
import { MECHANICS } from '../src/sim/mechanics'
import { commandAttack, commandBehavior, commandFront, commandGroupFront, commandMove, previewGroupFront } from '../src/sim/orders'
import { createScenario } from '../src/sim/scenarios'
import { Spatial } from '../src/sim/spatial'
import type { Battle, Projectile, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

function one(b: Battle, side: 0 | 1, type: UnitType, x: number, y: number, facing: number) {
  const r = spawn(b, side, type, type, x, y, facing)
  for (const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers = r.soldiers.slice(0, 1)
  r.aliveCount = r.initial = r.files = r.destFiles = 1
  const s = r.soldiers[0]
  Object.assign(s, { x, y, prevX: x, prevY: y, meleeCd: 0, reload: 0 })
  return r
}
const tick = (b: Battle, seconds: number) => { for (let i = 0; i < Math.round(seconds / 0.05); i++) step(b, 0.05) }
const hp = (r: Regiment) => r.soldiers.reduce((sum, s) => sum + s.hp, 0)

describe('formation regressions', () => {
  it.each([[60, 100, 210, 100], [210, 100, 60, 100], [0, 0, 80, 80], [290, 220, 600, 220]])('previews and executes mixed-unit lines (%s,%s → %s,%s)', (x1,y1,x2,y2) => {
    const b = createScenario('line', 1), ids = b.regiments.filter(r => r.side === 0).map(r => r.id)
    const plan = previewGroupFront(b, ids, x1,y1,x2,y2)
    expect(plan).toHaveLength(ids.length)
    expect(new Set(plan.map(p => p.facing)).size).toBe(1)
    commandGroupFront(b, ids, x1,y1,x2,y2)
    for (const p of plan) {
      const r = b.regiments.find(r => r.id === p.id)!
      expect(r.destX).toBe(p.x); expect(r.destY).toBe(p.y); expect(r.destFiles).toBe(p.files)
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(300)
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(230)
    }
    for (let i = 1; i < plan.length; i++) {
      const a = plan[i-1], c = plan[i]
      const ra = b.regiments.find(r => r.id === a.id)!, rc = b.regiments.find(r => r.id === c.id)!
      const wa = (a.files - 1) * UNITS[ra.type].spacing / 2 + UNITS[ra.type].radius
      const wc = (c.files - 1) * UNITS[rc.type].spacing / 2 + UNITS[rc.type].radius
      expect(Math.hypot(a.x-c.x,a.y-c.y)).toBeGreaterThanOrEqual(wa+wc+1.99)
    }
  })

  it('does not drop bodies when the spatial grid exceeds its initial capacity', () => {
    const g = new Spatial(2, 2), found: number[] = []
    g.insert(10, 10, 5000); g.query(10, 10, 1, found)
    expect(found).toEqual([5000])
  })

  it('places and faces a single entity at the drag origin without stretching it', () => {
    const b=createEmptyBattle(1), r=one(b,0,'general',100,80,0)
    commandFront(b,r.id,120,120,140,120)
    expect(r.destX).toBe(120); expect(r.destY).toBe(120)
    expect(r.destFacing).toBeCloseTo(Math.PI/2)
    expect(r.destFiles).toBe(1)
  })
})

describe('contact regressions', () => {
  it('scattered chariots drive at the enemy instead of returning to their formation slots', () => {
    const b=createEmptyBattle(31)
    const carts=spawn(b,0,'chariot','carts',150,145,-Math.PI/2)
    const target=spawn(b,1,'sword','target',150,70,-Math.PI/2)
    const positions=[[135,95],[145,105],[160,90],[175,100]]
    for (const [i,s] of carts.soldiers.entries()) {
      const [x,y]=positions[i]
      Object.assign(s,{x,y,prevX:x,prevY:y,facing:Math.atan2(70-y,150-x),speed:0,meleeCd:100})
    }
    carts.lag=20;carts.trail=12
    const before=carts.soldiers.map(s=>Math.hypot(s.x-150,s.y-70))
    commandAttack(b,[carts.id],target.id);tick(b,1)
    for (const s of carts.soldiers) {
      const foe=[...target.soldiers].sort((a,c)=>Math.hypot(a.x-s.x,a.y-s.y)-Math.hypot(c.x-s.x,c.y-s.y))[0]
      // Rolling steering aligns progressively, while still facing the enemy rather than an empty slot.
      expect(Math.abs(angDiff(s.facing,Math.atan2(foe.y-s.y,foe.x-s.x)))).toBeLessThan(0.3)
    }
    const closest=carts.soldiers.map(s=>Math.hypot(s.x-150,s.y-70))
    for(let i=0;i<140;i++) {
      step(b,0.05)
      carts.soldiers.forEach((s,j)=>{closest[j]=Math.min(closest[j],Math.hypot(s.x-150,s.y-70))})
    }
    // A cart may already be driving out the far side at the final timestamp.
    closest.forEach((distance,i)=>expect(distance).toBeLessThan(before[i]-12))
    expect(battleErrors(b)).toEqual([])
  })

  it('retargets out of cavalry melee, turns and reaches the new enemy', () => {
    const b=createEmptyBattle(32);b.rng=()=>0.1
    const rider=one(b,0,'shieldCavalry',100,99,Math.PI/2)
    const old=one(b,1,'general',100,100,-Math.PI/2)
    const next=one(b,1,'general',100,65,Math.PI/2)
    old.soldiers[0].meleeCd=next.soldiers[0].meleeCd=100
    commandAttack(b,[rider.id],old.id);tick(b,1)
    expect(rider.engaged).toBe(true)
    commandAttack(b,[rider.id],next.id);tick(b,12)
    expect(rider.soldiers[0].y).toBeLessThan(90)
    tick(b,12)
    expect(next.taken.length).toBeGreaterThan(0)
    expect(rider.targetId).toBe(next.id)
    expect(battleErrors(b)).toEqual([])
  })

  it('one chariot overrunning does not send its scattered mates along the same heading',()=>{
    const b=createEmptyBattle(35),carts=spawn(b,0,'chariot','carts',150,120,0)
    const target=spawn(b,1,'sword','target',150,60,Math.PI/2)
    commandAttack(b,[carts.id],target.id)
    const lead=carts.soldiers[0],mate=carts.soldiers[1]
    Object.assign(lead,{x:120,y:90,facing:0,plowLeft:1.8,plowX:140,plowY:90})
    Object.assign(mate,{x:180,y:95,facing:Math.atan2(60-95,150-180)})
    carts.plow=1.8
    const before=mate.y
    tick(b,1)
    expect(lead.x).toBeGreaterThan(120)
    expect(mate.y).toBeLessThan(before-0.3)
    expect(mate.plowLeft).toBe(0)
  })

  it('a full cavalry regiment leaves its former target and attacks the replacement',()=>{
    const b=createEmptyBattle(36)
    const riders=spawn(b,0,'shieldCavalry','riders',150,90,Math.PI/2)
    const old=spawn(b,1,'sword','old',150,105,-Math.PI/2)
    const next=spawn(b,1,'sword','next',150,50,Math.PI/2)
    for (const r of [old,next]) for (const s of r.soldiers) s.meleeCd=100
    commandAttack(b,[riders.id],old.id)
    for (let i=0;i<200 && !riders.engaged;i++) step(b,0.05)
    expect(riders.engaged).toBe(true)
    const oldY=riders.soldiers.reduce((sum,s)=>sum+s.y,0)/riders.aliveCount
    commandAttack(b,[riders.id],next.id);tick(b,18)
    const moved=riders.soldiers.filter(s=>s.alive && s.y<oldY-15)
    expect(moved.length).toBeGreaterThan(riders.aliveCount*0.6)
    expect(next.taken.length).toBeGreaterThan(0)
    expect(battleErrors(b)).toEqual([])
  })

  it('repeating an attack on the same enemy does not release its melee lock or refresh charge',()=>{
    // A running rider hits a smaller hero, so both the cavalry contact lock
    // (from the ram) and the charge timer are actually running first.
    const b=createEmptyBattle(37),r=one(b,0,'shieldCavalry',100,99,Math.PI/2)
    const target=one(b,1,'inquisitor',100,102,-Math.PI/2)
    target.soldiers[0].meleeCd=100
    commandAttack(b,[r.id],target.id)
    Object.assign(r.soldiers[0],{speed:9.5,vy:9.5})
    for (let i=0;i<40 && !(r.soldiers[0].impactHold>0 && r.soldiers[0].chargeLeft>0);i++) step(b,0.05)
    tick(b,0.5)
    const lock=r.soldiers[0].impactHold,charge=r.soldiers[0].chargeLeft
    // Both timers are live and already below their initial values, so either
    // clearing or re-arming them on the repeated order would be visible.
    expect(lock).toBeGreaterThan(0);expect(lock).toBeLessThan(MECHANICS.impactContactHold-0.3)
    expect(charge).toBeGreaterThan(0);expect(charge).toBeLessThan(CHARGE_DURATION-0.3)
    expect(r.engaged).toBe(true)
    commandAttack(b,[r.id],target.id);step(b,0.05)
    expect(r.engaged).toBe(true);expect(r.retargeting).toBe(false)
    expect(r.soldiers[0].impactHold).toBeCloseTo(lock-0.05,6)
    expect(r.soldiers[0].chargeLeft).toBeCloseTo(charge-0.05,6)
  })

  it('clipping the former enemy during a retarget does not restart its cavalry lock',()=>{
    const b=createEmptyBattle(39),r=one(b,0,'shieldCavalry',100,100,Math.PI/2)
    const old=one(b,1,'sword',100,101,Math.PI/2)
    const next=one(b,1,'general',100,160,-Math.PI/2)
    commandAttack(b,[r.id],old.id)
    r.engaged=true;r.inContact=true
    commandAttack(b,[r.id],next.id)
    r.anchorY=r.destY=104
    Object.assign(r.soldiers[0],{speed:8,vy:8,meleeCd:100})
    old.soldiers[0].meleeCd=next.soldiers[0].meleeCd=100
    step(b,0.05)
    expect(old.soldiers[0].down).toBeGreaterThan(0)
    expect(r.soldiers[0].impactHold).toBe(0)
    expect(r.engaged).toBe(false)
  })

  it('ignores a rear enemy until an incoming swing, then only the attacked soldier turns', () => {
    const b = createEmptyBattle(1)
    const defender = one(b, 0, 'sword', 100, 100, Math.PI / 2)
    const rear = one(b, 1, 'sword', 100, 98.9, Math.PI / 2)
    rear.soldiers[0].meleeCd = 100
    tick(b, 0.5)
    expect(defender.soldiers[0].facing).toBeCloseTo(Math.PI/2)
    rear.soldiers[0].meleeCd = 0
    tick(b, 2)
    expect(defender.soldiers[0].reactTo).toBe(rear.soldiers[0].id)
    expect(Math.abs(angDiff(Math.PI/2, defender.soldiers[0].facing))).toBeGreaterThan(0.4)
    expect(defender.facing).toBeCloseTo(Math.PI/2)
  })

  it('cannot hit or react to a chariot outside physical weapon reach', () => {
    const b = createEmptyBattle(2)
    const foot = one(b, 0, 'sword', 100, 100, 0)
    const cart = one(b, 1, 'chariot', 104, 100, 0)
    const before = hp(cart)
    expect(gapBetween(foot.soldiers[0], UNITS.sword, cart.soldiers[0], UNITS.chariot)).toBeGreaterThan(UNITS.sword.reach)
    tick(b, 3)
    expect(hp(cart)).toBe(before)
    expect(cart.soldiers[0].reactTo).toBeNull()
  })

  it('decays charge after contact even when the rider has stopped', () => {
    const b = createEmptyBattle(3)
    b.rng = () => 0.1
    const rider = one(b, 0, 'heavyCavalry', 100, 60, Math.PI/2)
    const target = one(b, 1, 'general', 100, 100, -Math.PI/2)
    target.soldiers[0].meleeCd = 100
    commandAttack(b, [rider.id], target.id)
    for (let i = 0; i < 240 && rider.soldiers[0].chargeLeft === 0; i++) step(b, 0.05)
    expect(rider.soldiers[0].chargeLeft).toBeGreaterThan(CHARGE_DURATION - 1)
    tick(b, 1)
    expect(rider.soldiers[0].chargeLeft).toBeGreaterThan(CHARGE_DURATION - 2)
    expect(rider.soldiers[0].speed).toBeLessThan(1)
    expect(chargeDecay(CHARGE_DURATION / 2)).toBe(0.5)
    expect(chargeDecay(-1)).toBe(0)
    expect(defenseMultiplier(Math.PI/2)).toBe(0.6)
    expect(defenseMultiplier(Math.PI)).toBe(0.3)
  })

  it('stops slow cavalry compressing an enemy and permits a move order to disengage', () => {
    const b = createEmptyBattle(4)
    const rider = one(b, 0, 'shieldCavalry', 100, 99, Math.PI/2)
    const target = one(b, 1, 'spear', 100, 100, -Math.PI/2)
    commandAttack(b, [rider.id], target.id)
    const start = target.soldiers[0].y
    tick(b, 8)
    expect(target.soldiers[0].y - start).toBeLessThan(0.5)
    expect(rider.engaged).toBe(true)
    commandMove(b, [rider.id], 100, 70, null)
    tick(b, 12)
    expect(rider.soldiers[0].y).toBeLessThan(90)
  })

  it('gives single entities leadership loss from health damage, not just model count', () => {
    const b = createEmptyBattle(1)
    const r = one(b, 0, 'monster', 100, 60, 0)
    one(b, 1, 'spear', 200, 170, 0)
    r.soldiers[0].hp *= 0.2
    step(b, 0.05)
    expect(r.leadership).toBeCloseTo(UNITS.monster.leadership + casualtyPenalty(0.8))
    expect(casualtyPenalty(0.8)).toBeLessThan(-40)
  })

  it('shares a hero swing budget across nearby enemies instead of multiplying its damage', () => {
    const b = createEmptyBattle(1); b.rng = () => 0.1
    const hero = one(b, 0, 'inquisitor', 100, 100, Math.PI / 2)
    const targets = [[99.4,100.9],[100,101.1],[100.6,100.9]].map(([x,y]) => one(b, 1, 'sword', x,y,-Math.PI/2))
    targets.forEach(r => { r.soldiers[0].meleeCd = 100 })
    step(b, 0.05)
    expect(targets.every(r=>hp(r)===UNITS.sword.hp)).toBe(true)
    tick(b, UNITS.inquisitor.attack.windup)
    const total = hero.dealt.reduce((sum,event) => sum + event.v, 0)
    expect(targets.filter(r => hp(r) < UNITS.sword.hp)).toHaveLength(3)
    expect(total).toBe(84)
    expect(hero.soldiers[0].meleeCd).toBeGreaterThan(0)
  })

  it('lets a closer friendly body screen a single entity from an enemy blow', () => {
    const b = createEmptyBattle(1); b.rng = () => 0.1
    const enemy = one(b, 1, 'spear', 100, 100, Math.PI/2)
    const friend = one(b, 0, 'sword', 100, 100.8, -Math.PI/2)
    const hero = one(b, 0, 'inquisitor', 100, 101.5, -Math.PI/2)
    friend.soldiers[0].meleeCd = hero.soldiers[0].meleeCd = 100
    tick(b, 0.05+UNITS.spear.attack.windup)
    expect(hp(friend)).toBeLessThan(UNITS.sword.hp)
    expect(hp(hero)).toBe(UNITS.inquisitor.hp)
    expect(enemy.soldiers[0].meleeCd).toBeGreaterThan(0)
  })

  it('negates a large attacker charge bonus only against frontal charge defense', () => {
    const hit = (facing: number) => {
      const b = createEmptyBattle(1); b.rng = () => 0.1
      const rider = one(b, 0, 'heavyCavalry', 100,99,Math.PI/2)
      const spear = one(b, 1, 'spear', 100,100,facing)
      Object.assign(rider.soldiers[0], { chargeLeft: CHARGE_DURATION, chargePower: 1 })
      spear.soldiers[0].meleeCd = 100
      spear.stationaryTime = 2
      spear.soldiers[0].braceTime = 2
      tick(b, 0.05+UNITS.heavyCavalry.attack.windup)
      return rider.dealt.reduce((sum,e) => sum+e.v,0)
    }
    expect(hit(-Math.PI/2)).toBe(27)
    expect(hit(0)).toBeGreaterThan(60)
  })

  it('ends a full cavalry charge in melee while a chariot continues through', () => {
    const b = createScenario('cavalry', 42)
    const rider = b.regiments[0]
    let contacted = false, highestAfterContact = 0
    for (let i=0;i<240 && b.winner === null;i++) {
      step(b,0.05)
      if (rider.soldiers[0].impactHold > 0) contacted = true
      if (contacted && rider.engaged) highestAfterContact = Math.max(highestAfterContact,rider.anchorY)
    }
    expect(contacted).toBe(true)
    expect(highestAfterContact).toBeLessThan(123)
  })
})

describe('gait commands',()=>{
  it('new movement, front and attack orders start running; walking is chosen after the order',()=>{
    const b=createEmptyBattle(33),r=one(b,0,'sword',100,50,Math.PI/2)
    const target=one(b,1,'sword',100,150,-Math.PI/2)
    expect(r.run).toBe(true)
    commandBehavior(b,[r.id],{run:false});commandMove(b,[r.id],100,90,null)
    expect(r.run).toBe(true)
    commandBehavior(b,[r.id],{run:false});tick(b,1)
    expect(r.run).toBe(false)
    commandFront(b,r.id,120,100,140,100);expect(r.run).toBe(true)
    commandBehavior(b,[r.id],{run:false});commandAttack(b,[r.id],target.id)
    expect(r.run).toBe(true)
    commandBehavior(b,[r.id],{run:false});tick(b,3)
    expect(r.wantCharge).toBe(false)
    expect(r.soldiers[0].chargeArmed).toBe(false)
  })

  it('a multi-unit front order resets walking for every selected regiment',()=>{
    const b=createScenario('line',34),ids=b.regiments.filter(r=>r.side===0).map(r=>r.id)
    commandBehavior(b,ids,{run:false});commandGroupFront(b,ids,60,100,210,100)
    expect(b.regiments.filter(r=>ids.includes(r.id)).every(r=>r.run)).toBe(true)
  })

  it('switching to walking during a charge actually slows the moving body',()=>{
    const b=createEmptyBattle(38),r=one(b,0,'heavyCavalry',100,45,Math.PI/2)
    // Close enough that the rider breaks into the charge after a few strides, far enough not to arrive in 8 s.
    const target=one(b,1,'general',100,95,-Math.PI/2)
    commandAttack(b,[r.id],target.id);tick(b,5)
    expect(r.wantCharge).toBe(true)
    expect(r.soldiers[0].speed).toBeGreaterThan(UNITS.heavyCavalry.speed)
    commandBehavior(b,[r.id],{run:false});tick(b,3)
    expect(r.wantCharge).toBe(false)
    expect(r.soldiers[0].speed).toBeLessThan(UNITS.heavyCavalry.speed*0.6)
  })
})

describe('missile regressions', () => {
  it('does not spend ammo when a friendly blocks a musket lane', () => {
    const b = createEmptyBattle(1)
    const shooter = one(b, 0, 'musket', 100, 60, Math.PI/2)
    const friend = one(b, 0, 'sword', 100, 80, Math.PI/2)
    const enemy = one(b, 1, 'spear', 100, 105, -Math.PI/2)
    commandAttack(b, [shooter.id], enemy.id)
    tick(b, 2)
    expect(shooter.soldiers[0].ammo).toBe(10)
    expect(hp(friend)).toBe(UNITS.sword.hp)
    friend.soldiers[0].x = friend.anchorX = friend.destX = 110
    tick(b, 1)
    expect(shooter.soldiers[0].ammo).toBe(9)
  })

  function bullet(b: Battle, source: Regiment): Projectile {
    return { x: 100, y: 60, vx: 0, vy: 95, base: 0, ap: 12, side: 0, sourceReg: source.id, shooterId: source.soldiers[0].id, traveled: 0, maxRange: 70, alive: true, arc: false, originX: 100, originY: 60, landX: 100, landY: 100, age: 0, duration: 1, apex: 0, z:1.2,vz:0,gravity:0,penetrationLeft:1,hitIds:[] }
  }
  it('ignores friends near the muzzle and can hit friends at the terminal point', () => {
    const b = createEmptyBattle(5)
    const source = one(b, 0, 'musket', 100, 60, Math.PI/2)
    source.soldiers[0].ammo = 0
    const near = one(b, 0, 'archer', 100, 62, 0)
    const end = one(b, 0, 'archer', 100, 98, 0)
    one(b, 1, 'spear', 200, 200, 0)
    b.projectiles.push(bullet(b, source))
    tick(b, 0.5)
    expect(hp(near)).toBe(UNITS.archer.hp)
    expect(hp(end)).toBe(UNITS.archer.hp - 12)
  })

  it('lets horse archers fire while moving but foot archers hold fire on the march', () => {
    for (const type of ['horseArcher', 'archer'] as const) {
      const b = createEmptyBattle(6), r = one(b, 0, type, 100, 60, Math.PI/2)
      one(b, 1, 'spear', 100, 100, -Math.PI/2)
      commandMove(b, [r.id], 120, 75, null)
      tick(b, 0.3)
      expect(r.soldiers[0].ammo).toBe(UNITS[type].missile!.ammo - (type === 'horseArcher' ? 1 : 0))
    }
  })
})

describe('determinism and invariants', () => {
  it.each([1, 7, 42])('replays the same commands exactly with seed %s', seed => {
    const run = () => {
      const b = createScenario('cavalry', seed)
      tick(b, 10)
      expect(battleErrors(b)).toEqual([])
      return battleSnapshot(b)
    }
    expect(run()).toEqual(run())
  })

  it.each(['duel', 'chariot', 'fire', 'flank', 'roster'] as const)('keeps %s finite and valid', name => {
    const b = createScenario(name, 42)
    if (name === 'roster') {
      for (const r of b.regiments.filter(r => r.side === 0)) {
        const target = b.regiments.find(e => e.side === 1 && e.type === r.type)!
        commandAttack(b, [r.id], target.id)
      }
    }
    tick(b, 12)
    expect(battleErrors(b)).toEqual([])
  }, 15000)
})
