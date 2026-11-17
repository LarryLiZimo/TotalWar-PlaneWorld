import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { commandAttack, commandBehavior } from '../src/sim/orders'
import type { UnitType } from '../src/sim/types'
import { UNITS, firesMissiles } from '../src/sim/units'

const N = Math.PI / 2, S = -Math.PI / 2

describe('missile behaviour defaults', () => {
  it('starts every unit out of melee mode', () => {
    for (const type of Object.keys(UNITS) as UnitType[]) {
      expect(spawn(createEmptyBattle(1), 0, type, type, 100, 100, N).meleeMode, type).toBe(false)
    }
  })

  it('no missile unit backs away from a closing enemy on its own: it stands where it was put', () => {
    for (const type of ['archer', 'horseArcher', 'pistolier', 'warWagon'] as UnitType[]) {
      const b = createEmptyBattle(2), reg = spawn(b, 0, type, type, 100, 60, N)
      const foe = spawn(b, 1, 'sword', 'sword', 100, 95, S)
      const at = { x: reg.anchorX, y: reg.anchorY }
      commandAttack(b, [foe.id], reg.id)
      // The swords run in from 35 m: for three seconds they are well inside the old evade line and not yet in contact.
      for (let i = 0; i < 60; i++) step(b, 0.05)
      expect(reg.order, type).toBe('hold')
      expect(Math.hypot(reg.anchorX - at.x, reg.anchorY - at.y), type).toBeLessThan(0.01)
      expect(Math.hypot(reg.destX - at.x, reg.destY - at.y), type).toBeLessThan(0.01)
    }
  })
})

describe('melee mode (F)', () => {
  /** Archers ordered to attack swords 50 m away, in range; returns what happened over `seconds`. */
  const attack = (meleeMode: boolean, seconds = 25) => {
    const b = createEmptyBattle(3)
    const archers = spawn(b, 0, 'archer', 'archers', 100, 40, N)
    const foe = spawn(b, 1, 'sword', 'foe', 100, 90, S)
    commandBehavior(b, [archers.id], { meleeMode })
    commandAttack(b, [archers.id], foe.id)
    let contact = false, closest = Infinity
    for (let i = 0; i < seconds / 0.05; i++) {
      step(b, 0.05)
      contact ||= archers.inContact
      closest = Math.min(closest, Math.hypot(foe.anchorX - archers.anchorX, foe.anchorY - archers.anchorY))
    }
    const ammoUsed = archers.initial * UNITS.archer.missile!.ammo - archers.soldiers.reduce((n, s) => n + s.ammo, 0)
    return { b, archers, foe, contact, closest, ammoUsed, meleeHits: foe.taken.length }
  }

  it('shoots from range and keeps its distance when off', () => {
    const run = attack(false)
    expect(run.ammoUsed).toBeGreaterThan(0)
    expect(run.contact).toBe(false)
    expect(run.closest).toBeGreaterThan(30)
  })

  it('holds fire, closes in and fights hand to hand when on', () => {
    const run = attack(true)
    expect(run.ammoUsed).toBe(0)
    expect(run.contact).toBe(true)
    expect(run.foe.soldiers.some(s => s.hp < run.foe.modelHp || !s.alive)).toBe(true)
    expect(run.b.projectiles).toHaveLength(0)
  })

  it('applies only to missile units and can be switched back to shooting', () => {
    const b = createEmptyBattle(4)
    const sword = spawn(b, 0, 'sword', 'sword', 60, 40, N), archers = spawn(b, 0, 'archer', 'archers', 140, 40, N)
    const foe = spawn(b, 1, 'sword', 'foe', 140, 100, S)
    commandBehavior(b, [sword.id, archers.id], { meleeMode: true })
    expect(sword.meleeMode).toBe(false)
    expect(archers.meleeMode).toBe(true)
    commandBehavior(b, [archers.id], { meleeMode: false })
    commandAttack(b, [archers.id], foe.id)
    for (let i = 0; i < 200; i++) step(b, 0.05)
    expect(archers.soldiers.some(s => s.ammo < UNITS.archer.missile!.ammo)).toBe(true)
  })
})

describe('out of ammunition', () => {
  it('a missile unit that fires its last round switches to melee mode, closes in and fights', () => {
    const b = createEmptyBattle(3)
    const archers = spawn(b, 0, 'archer', 'archers', 100, 40, N), foe = spawn(b, 1, 'sword', 'foe', 100, 90, S)
    // Spent ammunition lowers the power bar; reserves keep the army clear of its losing mark.
    spawn(b, 0, 'sword', 'reserve', 20, 20, N); spawn(b, 0, 'sword', 'reserve 2', 280, 20, N)
    for (const s of archers.soldiers) s.ammo = 1
    commandAttack(b, [archers.id], foe.id)
    let switchedAt = -1
    for (let i = 0; i < 600 && switchedAt < 0; i++) {
      step(b, 0.05)
      if (archers.meleeMode) switchedAt = b.time
      else expect(firesMissiles(archers)).toBe(true)
    }
    // Every archer shot his one round first; the unit then switched within a step of the last one.
    expect(switchedAt).toBeGreaterThan(0)
    expect(archers.soldiers.every(s => s.ammo === 0)).toBe(true)
    expect(firesMissiles(archers)).toBe(false)
    // Asking it to shoot again is ignored while it has no ammunition.
    commandBehavior(b, [archers.id], { meleeMode: false })
    expect(archers.meleeMode).toBe(true)
    let contact = false
    for (let i = 0; i < 600 && !contact; i++) { step(b, 0.05); contact = archers.inContact }
    expect(contact).toBe(true)
    for (let i = 0; i < 100; i++) step(b, 0.05)
    expect(archers.dealt.length).toBeGreaterThan(0)
    expect(b.projectiles.filter(p => p.sourceReg === archers.id)).toHaveLength(0)
  })

  it.each(['archer', 'musket', 'horseArcher', 'warWagon'] as UnitType[])('%s with no rounds left at the start fights in melee mode; with rounds it can switch back', type => {
    const b = createEmptyBattle(5)
    const empty = spawn(b, 0, type, 'empty', 60, 40, N), stocked = spawn(b, 0, type, 'stocked', 160, 40, N)
    spawn(b, 1, 'sword', 'foe', 110, 200, S)
    for (const s of empty.soldiers) s.ammo = 0
    step(b, 0.05)
    expect(empty.meleeMode).toBe(true);expect(stocked.meleeMode).toBe(false)
    commandBehavior(b, [empty.id, stocked.id], { meleeMode: true })
    commandBehavior(b, [empty.id, stocked.id], { meleeMode: false })
    expect(empty.meleeMode).toBe(true);expect(stocked.meleeMode).toBe(false)
  })

  it('an AI missile unit out of ammunition is switched too and goes into melee', () => {
    const b = createEmptyBattle(6)
    const player = spawn(b, 0, 'sword', 'player', 100, 60, N), archers = spawn(b, 1, 'archer', 'ai archers', 100, 130, S)
    spawn(b, 1, 'sword', 'reserve', 20, 210, S); spawn(b, 1, 'sword', 'reserve 2', 280, 210, S)
    for (const s of archers.soldiers) s.ammo = 0
    b.aiEnabled = true
    step(b, 0.05)
    expect(archers.meleeMode).toBe(true)
    let contact = false
    for (let i = 0; i < 1200 && !contact; i++) { step(b, 0.05); contact = archers.inContact }
    expect(contact).toBe(true)
    expect(archers.order).toBe('attack');expect(archers.targetId).toBe(player.id)
    // Archers hit shielded swordsmen rarely: several rounds of swings, not one.
    let hurt = false
    for (let i = 0; i < 300 && !hurt; i++) { step(b, 0.05); hurt = player.taken.length > 0 }
    expect(hurt).toBe(true)
  })
})
