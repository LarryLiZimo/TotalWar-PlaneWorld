import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { CHARGE_DURATION } from '../src/sim/combat'
import { commandAttack, commandBehavior } from '../src/sim/orders'
import { UNITS } from '../src/sim/units'
import { battleErrors } from '../src/sim/diagnostics'
import { gapBetween } from '../src/sim/formation'
import type { UnitType } from '../src/sim/types'

function encounter(type: UnitType = 'sword', targetType: UnitType = 'sword', fraction = 1) {
  const b = createEmptyBattle(42)
  b.rng = () => .1
  const def = UNITS[type], targetDef = UNITS[targetType]
  const attacker = spawn(b, 0, type, 'attacker', 100, 100, 0, { models: 1, files: 1 })
  const extent = def.shape === 'capsule' ? def.length / 2 : def.radius
  const target = spawn(b, 1, targetType, 'target', 100 + extent + targetDef.radius + .1, 100, Math.PI, { models: 1, files: 1 })
  target.soldiers[0].meleeCd = 100
  commandAttack(b, [attacker.id], target.id)
  Object.assign(attacker.soldiers[0], { speed: def.chargeSpeed * fraction, vx: def.chargeSpeed * fraction, vy: 0, meleeCd: 100 })
  return { b, attacker, target, s: attacker.soldiers[0] }
}

describe('speed-based charge qualification', () => {
  it.each(Object.keys(UNITS) as UnitType[])('%s can charge at its effective charge speed, including infantry, single entities and ranged units', type => {
    const { b, attacker, s } = encounter(type)
    // A near target, scattered formation and wrong regiment facing must not veto
    // the individual model, which is already moving into its own attack zone.
    attacker.facing = Math.PI / 2
    attacker.lag = attacker.trail = 100
    attacker.anchorSpeed = 0
    step(b, .05)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
  })

  it.each(['sword', 'heavyCavalry', 'chariot', 'monster'] as UnitType[])('%s does not receive a charge just because an attack order was issued at low speed', type => {
    const { b, s } = encounter(type, 'sword', .25)
    step(b, .05)
    expect(s.chargeLeft).toBe(0)
  })

  it('uses the fatigue-adjusted speed rather than the fresh-unit threshold', () => {
    const { b, attacker, s } = encounter('sword', 'sword', .9)
    attacker.fatigue = 'tired'; attacker.exertion = 13000
    step(b, .05)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
  })

  it('has no extra one-metre-per-second approach requirement', () => {
    const def = UNITS.sword, previous = { speed: def.speed, chargeSpeed: def.chargeSpeed }
    try {
      Object.assign(def, { speed: .3, chargeSpeed: .5 })
      const { b, s } = encounter()
      step(b, .05)
      expect(s.chargeLeft).toBe(CHARGE_DURATION)
    } finally { Object.assign(def, previous) }
  })

  it('negates a frontal large charge only with applicable charge defence', () => {
    const front = encounter('heavyCavalry', 'spear')
    front.target.soldiers[0].braceTime = 1
    step(front.b, .05)
    expect(front.s.chargeLeft).toBe(0)
    expect(front.s.chargeContactAt).toBe(front.b.time)

    const ordinary = encounter('heavyCavalry', 'sword')
    ordinary.target.soldiers[0].braceTime = 1
    step(ordinary.b, .05)
    expect(ordinary.s.chargeLeft).toBe(CHARGE_DURATION)

    const rear = encounter('heavyCavalry', 'spear')
    rear.target.facing = rear.target.soldiers[0].facing = 0
    rear.target.soldiers[0].braceTime = 1
    step(rear.b, .05)
    expect(rear.s.chargeLeft).toBe(CHARGE_DURATION)
  })

  it('charge defence against large does not negate an infantry charge', () => {
    const { b, target, s } = encounter('sword', 'spear')
    target.soldiers[0].braceTime = 1
    step(b, .05)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
  })

  it.each(['sword', 'heavyCavalry'] as UnitType[])('braced halberds negate a frontal %s charge', type => {
    const { b, target, s } = encounter(type, 'halberd')
    target.soldiers[0].braceTime = 1
    step(b, .05)
    expect(s.chargeContactAt).toBe(b.time)
    expect(s.chargeLeft).toBe(0)
  })

  it('does not qualify a walking model or external shove as a charge', () => {
    const walk = encounter()
    commandBehavior(walk.b, [walk.attacker.id], { run: false })
    step(walk.b, .05)
    expect(walk.s.chargeLeft).toBe(0)

    const pushed = encounter('sword', 'sword', 0)
    pushed.s.pushVx = pushed.s.vx = 10
    step(pushed.b, .05)
    expect(pushed.s.chargeLeft).toBe(0)
  })

  it('a model that accelerated before arriving receives the bonus without any distance gate', () => {
    const b = createEmptyBattle(6)
    const a = spawn(b, 0, 'sword', 'a', 100, 100, 0, { models: 1, files: 1 })
    const target = spawn(b, 1, 'general', 'target', 108, 100, Math.PI)
    target.soldiers[0].meleeCd = 100
    commandAttack(b, [a.id], target.id)
    for (let i = 0; i < 100 && a.soldiers[0].chargeLeft === 0; i++) step(b, .05)
    expect(a.soldiers[0].chargeLeft).toBeGreaterThan(12)
  })

  it('does not refresh the timer with repeated point-blank attack orders', () => {
    const { b, attacker, target, s } = encounter()
    step(b, .05)
    for (let i = 0; i < 10; i++) { commandAttack(b, [attacker.id], target.id); step(b, .05) }
    expect(s.chargeLeft).toBeCloseTo(CHARGE_DURATION - .5, 8)
  })

  it('recognises reaching charge speed during the same movement step that makes contact', () => {
    const { b, s, target } = encounter()
    s.speed = s.vx = UNITS.sword.chargeSpeed - .05
    target.anchorX = target.destX = target.soldiers[0].x = 100 + 2 * UNITS.sword.radius + .3
    step(b, .05)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
  })

  it('clears old readiness if a model slowed down before it reached an enemy', () => {
    const { b, s } = encounter('sword', 'sword', 0)
    s.chargeArmed = true
    step(b, .05)
    expect(s.chargeArmed).toBe(false)
    expect(s.chargeLeft).toBe(0)
  })
})

describe('ordinary attack timing', () => {
  function swings(interval = UNITS.sword.meleeInterval) {
    const b = createEmptyBattle(7)
    b.rng = () => .1
    const a = spawn(b, 0, 'sword', 'attacker', 100, 100, 0, { models: 1, files: 1 })
    const d = spawn(b, 1, 'general', 'target', 101.1, 100, Math.PI, { models: 1, files: 1, hp: 100000 })
    a.soldiers[0].meleeCd = 0; d.soldiers[0].meleeCd = 100
    const starts: number[] = [], hits: number[] = []
    const previous = UNITS.sword.meleeInterval
    try {
      UNITS.sword.meleeInterval = interval
      let wasSwing = false, hp = d.soldiers[0].hp
      for (let i = 0; i < 200; i++) {
        step(b, .05)
        const swinging = !!a.soldiers[0].swing
        if (swinging && !wasSwing) starts.push(b.time)
        if (d.soldiers[0].hp < hp) hits.push(b.time)
        wasSwing = swinging; hp = d.soldiers[0].hp
      }
    } finally { UNITS.sword.meleeInterval = previous }
    return { starts, hits }
  }

  it('includes windup within the attack interval instead of adding it to every attack period', () => {
    const { starts, hits } = swings()
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0] - starts[0]).toBeCloseTo(UNITS.sword.attack.windup, 7)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(UNITS.sword.meleeInterval - 1e-6)
    expect(starts[1] - starts[0]).toBeLessThanOrEqual(UNITS.sword.meleeInterval + .051)
  })

  it('honours recovery after a completed swing when the interval expires earlier', () => {
    const { starts, hits } = swings(.2)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(starts[1] - hits[0]).toBeGreaterThanOrEqual(UNITS.sword.attack.recovery - 1e-6)
    expect(starts[1] - hits[0]).toBeLessThanOrEqual(UNITS.sword.attack.recovery + .051)
  })
})

describe('individual approach while the regiment is engaged', () => {
  function staggered(type: UnitType) {
    const b = createEmptyBattle(81), def = UNITS[type]
    const target = spawn(b, 1, 'shieldCavalry', 'defender', 122, 100, Math.PI, { models: 4, files: 2, hp: 100000 })
    const first = target.soldiers[0], next = target.soldiers[1]
    const a = spawn(b, 0, type, 'staggered attackers', first.x - def.radius - UNITS.shieldCavalry.radius - .1, first.y, 0, { models: 2, files: 1 })
    const rear = a.soldiers[1]
    Object.assign(rear, { x: 85, y: next.y, prevX: 85, prevY: next.y })
    for (const r of [a, target]) for (const s of r.soldiers) s.meleeCd = 100
    commandAttack(b, [a.id], target.id)
    step(b, .05)
    expect(a.engaged).toBe(true)
    expect(a.attackCommitted).toBe(true)
    return { b, a, target, rear }
  }

  it.each(['sword', 'spear', 'greatsword', 'heavyCavalry', 'shieldCavalry', 'ogre', 'armoredOgre'] as UnitType[])('%s reserves accelerate and receive their own charge even after the front rank engaged', type => {
    const { b, a, target, rear } = staggered(type)
    let peakBeforeContact = 0, charged = false
    const trace: unknown[] = []
    for (let i = 0; i < 360 && !charged; i++) {
      const gap = Math.min(...target.soldiers.filter(s => s.alive).map(s => gapBetween(rear, UNITS[type], s, UNITS[target.type])))
      if (gap > 3) peakBeforeContact = Math.max(peakBeforeContact, rear.speed)
      if (i % 20 === 0) trace.push({ time: b.time, x: rear.x, y: rear.y, speed: rear.speed, facing: rear.facing, gap })
      step(b, .05)
      charged = rear.chargeLeft > 0
    }
    expect(peakBeforeContact).toBeGreaterThan(UNITS[type].speed)
    expect(charged, JSON.stringify(trace)).toBe(true)
    expect(a.engaged).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })

  it('keeps a rear model walking when walking was explicitly selected', () => {
    const { b, a, rear } = staggered('heavyCavalry')
    commandBehavior(b, [a.id], { run: false })
    for (let i = 0; i < 60; i++) step(b, .05)
    expect(rear.speed).toBeGreaterThan(2.5)
    expect(rear.speed).toBeLessThanOrEqual(UNITS.heavyCavalry.speed * .5 + 1e-6)
    expect(rear.chargeLeft).toBe(0)
  })

  it('slows the model already fighting while its distant comrade keeps charging', () => {
    const { b, a, rear } = staggered('heavyCavalry'), front = a.soldiers[0], x = front.x
    for (let i = 0; i < 70; i++) step(b, .05)
    expect(a.engaged).toBe(true)
    expect(front.speed).toBeLessThanOrEqual(2)
    expect(Math.abs(front.x - x)).toBeLessThan(.3)
    expect(rear.speed).toBeGreaterThan(UNITS.heavyCavalry.speed)
  })

  it('a full scattered cavalry regiment runs its rear group into a fight already reached by the front', () => {
    const b = createEmptyBattle(82)
    const target = spawn(b, 1, 'spear', 'target', 150, 125, Math.PI / 2)
    const a = spawn(b, 0, 'heavyCavalry', 'scattered cavalry', 142.655, 124, 0)
    for (const [i, s] of a.soldiers.entries()) {
      const x = i < 12 ? 142.655 : 85 - Math.floor((i - 12) / 8) * 3
      const y = i < 12 ? 120.5 + i * .6 : 115 + ((i - 12) % 8) * 2
      Object.assign(s, { x, y, prevX: x, prevY: y, meleeCd: 100 })
    }
    for (const s of target.soldiers) s.meleeCd = 100
    commandAttack(b, [a.id], target.id)
    step(b, .05)
    expect(a.engaged).toBe(true)
    const rear = a.soldiers.slice(12), charged = new Set<number>()
    for (let i = 0; i < 70; i++) step(b, .05)
    expect(rear.filter(s => s.speed > UNITS.heavyCavalry.speed).length).toBeGreaterThanOrEqual(18)
    for (let i = 0; i < 300; i++) {
      step(b, .05)
      for (const s of rear) if (s.chargeLeft > 0) charged.add(s.id)
    }
    // A dense spear line may block or defend individual contacts. Unobstructed
    // arrivals must still gain their own bonus after the front already engaged.
    expect(charged.size).toBeGreaterThan(0)
    expect(battleErrors(b)).toEqual([])
  })
})
