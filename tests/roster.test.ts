import { describe, expect, it } from 'vitest'
import { ARMIES, armySummary, scaledFormation, unitModels } from '../src/sim/armies'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { battleErrors, battleSnapshot } from '../src/sim/diagnostics'
import { advanceMorale } from '../src/sim/morale'
import { commandAttack, commandBehavior, commandMove } from '../src/sim/orders'
import type { Battle, Projectile, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'
import { unitPanelData } from '../src/unit-panel'

const added: UnitType[] = ['militia','shieldSpear','flagellant','huntsmen','freeCompany','ironsides','longRifle',
  'reiksguard','blackRose','pistolier','outrider','demigryph','demigryphHalberd','warWagon','heavyChariot',
  'ogreGreatWeapon','ogreHalberd','giant','stoneBeast','captain','warriorPriest']
const tick=(b:Battle,seconds:number)=>{for(let i=0;i<Math.round(seconds/.05);i++) step(b,.05)}
const one=(b:Battle,side:0|1,type:UnitType,x:number,y:number)=>spawn(b,side,type,type,x,y,side?-Math.PI/2:Math.PI/2,{models:1,files:1})

describe('expanded shared roster',()=> {
  it('makes every unit selectable through a preset and supplies finite complete stats',()=> {
    const selectable=new Set(Object.values(ARMIES).flatMap(a=>a.units.map(([type])=>type)))
    expect(added).toHaveLength(21)
    expect(Object.keys(UNITS)).toHaveLength(39)
    for(const [type,d] of Object.entries(UNITS)) {
      expect(d.type).toBe(type);expect(selectable.has(d.type)).toBe(true)
      expect(d.cost).toBeGreaterThan(0);expect(d.role.length).toBeGreaterThan(8)
      for(const value of Object.values(d)) if(typeof value==='number') expect(Number.isFinite(value)).toBe(true)
      expect(d.hp).toBeGreaterThan(0);expect(d.chargeSpeed).toBeGreaterThanOrEqual(d.speed)
      if(d.missile) {
        expect(d.missile.range).toBeGreaterThan(0);expect(d.missile.reload).toBeGreaterThan(0)
        expect(d.missile.ammo).toBeGreaterThan(0)
        for(const value of Object.values(d.missile)) if(typeof value==='number') expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('retains smaller elite formations at every army size and prices regiments consistently',()=> {
    for(const scale of [1,2,3,4,6,8] as const) {
      expect(unitModels('ironsides',scale)).toBe(60*scale/4)
      for(const type of ['longRifle','demigryph','demigryphHalberd'] as const) expect(unitModels(type,scale)).toBe(32*scale/4)
      for(const id of Object.keys(ARMIES) as (keyof typeof ARMIES)[]) {
        expect(armySummary(id,scale).budget).toBe(ARMIES[id].units.reduce((sum,[type,n])=>sum+n*UNITS[type].cost,0))
      }
    }
  })

  it.each(added)('%s can move and engage with valid simulation and detail-panel data',type=> {
    const b=createEmptyBattle(771),d=UNITS[type]
    const r=spawn(b,0,type,type,150,75,Math.PI/2,scaledFormation(type,1))
    const foe=spawn(b,1,'shieldSpear','target',150,108,-Math.PI/2,scaledFormation('shieldSpear',1))
    commandMove(b,[r.id],150,85,null);tick(b,2)
    expect(r.soldiers.some(s=>s.y>s.prevY)).toBe(true)
    commandAttack(b,[r.id],foe.id);tick(b,8)
    expect(battleErrors(b)).toEqual([])
    expect(unitPanelData(r).rows.every(row=>Number.isFinite(row.value)&&row.max>0)).toBe(true)
    if(d.missile) expect(r.soldiers.some(s=>s.ammo<d.missile!.ammo)).toBe(true)
    if(type==='longRifle') expect(unitPanelData(r).abilities.some(a=>a.key==='penetration')).toBe(true)
  })

  it('new mixed mechanics replay exactly',()=> {
    const run=()=> {
      const b=createEmptyBattle(981)
      for(const [i,type] of (['huntsmen','demigryphHalberd','warWagon','flagellant','warriorPriest'] as const).entries()) {
        const a=spawn(b,0,type,type,45+i*50,80,Math.PI/2,scaledFormation(type,1))
        const target=spawn(b,1,'ogre','foe',45+i*50,110,-Math.PI/2,scaledFormation('ogre',1))
        commandAttack(b,[a.id],target.id)
      }
      tick(b,6);expect(battleErrors(b)).toEqual([])
      return {...battleSnapshot(b),nextRandom:b.rng()}
    }
    expect(run()).toEqual(run())
  })
})

describe('roster-specific behavior',()=> {
  it('each war wagon fires six independently scattered shots and spends one volley',()=> {
    const b=createEmptyBattle(7),wagon=one(b,0,'warWagon',100,60)
    one(b,1,'spear',100,110)
    wagon.soldiers[0].reload=0;step(b,.05)
    expect(b.projectiles).toHaveLength(6)
    expect(new Set(b.projectiles.map(p=>`${p.vx},${p.vy}`)).size).toBeGreaterThan(1)
    expect(wagon.soldiers[0].ammo).toBe(UNITS.warWagon.missile!.ammo-1)
    expect(wagon.soldiers[0].reload).toBe(UNITS.warWagon.missile!.reload)
    expect(unitPanelData(wagon).abilities.some(a=>a.key==='volley')).toBe(true)
  })

  it('a fire-wagon attack stops to shoot at range instead of using melee-cart drive-through steering',()=> {
    const b=createEmptyBattle(7),wagon=one(b,0,'warWagon',100,60)
    const foe=one(b,1,'spear',100,110)
    commandBehavior(b,[wagon.id],{skirmish:false});commandAttack(b,[wagon.id],foe.id)
    tick(b,8)
    expect(wagon.soldiers[0].y).toBeLessThan(65)
    expect(wagon.soldiers[0].ammo).toBeLessThan(UNITS.warWagon.missile!.ammo)
  })

  it.each(['pistolier','huntsmen','warWagon','outrider'] as const)('%s observes its mobile-fire setting during an explicit movement order',type=> {
    const b=createEmptyBattle(11),r=one(b,0,type,100,60)
    one(b,1,'spear',100,90)
    Object.assign(r.soldiers[0],{reload:0,speed:2,vy:2})
    commandMove(b,[r.id],100,80,null);step(b,.05)
    expect(r.soldiers[0].speed).toBeGreaterThan(.5)
    expect(r.soldiers[0].ammo).toBe(UNITS[type].missile!.ammo-(UNITS[type].missile!.fireWhileMoving?1:0))
  })

  it('huntsmen add missile damage against large bodies only and still respect armor',()=> {
    const run=(type:'militia'|'pistolier')=> {
      const b=createEmptyBattle(15);b.rng=()=>0
      const a=one(b,0,'huntsmen',100,60),target=one(b,1,type,100,70)
      a.soldiers[0].ammo=target.soldiers[0].ammo=0
      const p:Projectile={x:100,y:60,vx:0,vy:40,z:1.2,vz:0,gravity:0,sourceGround:0,
        base:9,ap:4,side:0,sourceReg:a.id,shooterId:a.soldiers[0].id,traveled:0,maxRange:95,
        alive:true,arc:true,originX:100,originY:60,landX:100,landY:70,age:0,duration:1,apex:0,penetrationLeft:1,hitIds:[]}
      b.projectiles.push(p);tick(b,.3)
      return target.modelHp-target.soldiers[0].hp
    }
    // Militia armor 10: round(9*.95+4)=13; pistolier armor 20:
    // round((9+6*9/13)*.9+(4+6*4/13))=18.
    expect(run('militia')).toBe(13)
    expect(run('pistolier')).toBe(18)
  })

  it('flagellants remain steady through army losses and terror while ordinary militia rout',()=> {
    const b=createEmptyBattle(3),fanatics=one(b,0,'flagellant',100,60),militia=one(b,0,'militia',150,60)
    advanceMorale(fanatics,-100,true,true,5);advanceMorale(militia,-100,true,true,5)
    expect(fanatics.routing).toBe(false);expect(fanatics.shattered).toBe(false)
    expect(militia.routing).toBe(true)
    expect(unitPanelData(fanatics).abilities.some(a=>a.key==='unbreakable')).toBe(true)
  })
})
