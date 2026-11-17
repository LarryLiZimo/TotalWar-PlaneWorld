import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { CHARGE_DURATION, chargeStrength } from '../src/sim/combat'
import { MECHANICS } from '../src/sim/mechanics'
import { commandAttack, commandBehavior, commandMove, setMeleeMode } from '../src/sim/orders'
import { scaledFormation } from '../src/sim/armies'
import type { Regiment } from '../src/sim/types'
import { UNITS } from '../src/sim/units'
import { battleErrors } from '../src/sim/diagnostics'
import { gapBetween } from '../src/sim/formation'
import type { UnitType } from '../src/sim/types'

const DT = .05
const THRESHOLD = MECHANICS.speedThreshold

/**
 * One attacker running at `fraction` of its charge speed, one step's travel short of a standing target, so the
 * contact happens in the next step while it is still moving: a charge is judged on the closing speed at contact.
 */
function encounter(type: UnitType = 'sword', targetType: UnitType = 'sword', fraction = 1) {
  const b = createEmptyBattle(42)
  b.rng = () => .1
  const def = UNITS[type], targetDef = UNITS[targetType], speed = def.chargeSpeed * fraction
  const attacker = spawn(b, 0, type, 'attacker', 100, 100, 0, { models: 1, files: 1 })
  const extent = def.shape === 'capsule' ? def.length / 2 : def.radius
  const target = spawn(b, 1, targetType, 'target', 100 + extent + targetDef.radius + .1 + speed * DT, 100, Math.PI, { models: 1, files: 1 })
  target.soldiers[0].meleeCd = 100
  commandAttack(b, [attacker.id], target.id)
  // A ranged unit charges in melee mode; otherwise it keeps its shooting distance.
  if (def.missile) setMeleeMode(attacker, true)
  Object.assign(attacker.soldiers[0], { speed, vx: speed, vy: 0, meleeCd: 100 })
  return { b, attacker, target, s: attacker.soldiers[0] }
}

describe('speed-based charge qualification', () => {
  it.each(Object.keys(UNITS) as UnitType[])('%s charges at its effective charge speed, including infantry, single entities and ranged units', type => {
    const { b, attacker, s } = encounter(type)
    // A near target, scattered formation and wrong regiment facing must not veto
    // the individual model, which is already moving into its own attack zone.
    attacker.facing = Math.PI / 2
    attacker.lag = attacker.trail = 100
    attacker.anchorSpeed = 0
    step(b, DT)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
    expect(s.chargePower).toBeGreaterThan(.95)
  })

  it.each(['sword', 'heavyCavalry', 'chariot', 'monster'] as UnitType[])('%s gets no charge below the speed threshold, though it runs at the enemy on an attack order', type => {
    const { b, s } = encounter(type, 'sword', THRESHOLD - .1)
    expect(s.chargeArmed).toBe(false)
    step(b, DT)
    expect(s.chargeArmed).toBe(true)
    expect(s.chargeLeft).toBe(0)
    expect(s.chargePower).toBe(0)
  })

  it('scales the charge bonus by closing speed over charge speed: about 60% of charge speed gives about 60% of it', () => {
    const { b, s } = encounter('heavyCavalry', 'sword', .6)
    step(b, DT)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
    // The rider gains a little speed in the contact step itself.
    expect(s.chargePower).toBeGreaterThanOrEqual(.6)
    expect(s.chargePower).toBeLessThan(.63)
    // The strength holds through the whole linear decay.
    expect(chargeStrength(s)).toBe(s.chargePower)
    s.chargeLeft = CHARGE_DURATION / 2
    expect(chargeStrength(s)).toBeCloseTo(s.chargePower / 2, 12)
  })

  it('the first blow of a charge at about 60% of charge speed carries about 60% of the bonus damage', () => {
    const def = UNITS.heavyCavalry, bonus = def.chargeBonus
    const blow = (fraction: number) => {
      const { b, attacker, target, s } = encounter('heavyCavalry', 'sword', fraction)
      target.soldiers[0].hp = 1e5; s.collisionCd = 100
      step(b, DT)
      expect(attacker.dealt).toHaveLength(1)
      return { damage: attacker.dealt[0].v, power: s.chargePower }
    }
    try {
      def.chargeBonus = 0
      const plain = blow(1).damage
      def.chargeBonus = bonus
      const full = blow(1), part = blow(.6)
      expect(full.power).toBe(1)
      expect(full.damage).toBeGreaterThan(plain + 4)
      // Base and armour-piercing damage round separately: at most one point each.
      expect(Math.abs(part.damage - (plain + part.power * (full.damage - plain)))).toBeLessThanOrEqual(2)
    } finally { def.chargeBonus = bonus }
  })

  it('uses the fatigue-adjusted charge speed rather than the fresh one', () => {
    const fresh = encounter('sword', 'sword', .9)
    step(fresh.b, DT)
    const tired = encounter('sword', 'sword', .9)
    tired.attacker.fatigue = 'tired'; tired.attacker.exertion = 13000
    step(tired.b, DT)
    expect(fresh.s.chargePower).toBeLessThan(.95)
    expect(tired.s.chargePower).toBe(1)
  })

  it('the body run into never charges back: a standing model with charge intent gets no charge bonus', () => {
    const { b, attacker, target, s } = encounter('heavyCavalry', 'sword')
    // The target is ordered to attack its charger at a run, so it means to charge, but it has not started moving.
    commandAttack(b, [target.id], attacker.id)
    target.soldiers[0].hp = 1e5; target.soldiers[0].meleeCd = 0
    step(b, DT)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
    const foot = target.soldiers[0]
    expect(foot.chargeArmed).toBe(true)
    expect(foot.chargeLeft).toBe(0)
    expect(foot.chargePower).toBe(0)
    expect(target.dealt).toHaveLength(0)
  })

  it('a monster running head-on just under its charge speed charges, and so does the one it meets', () => {
    const b = createEmptyBattle(42)
    b.rng = () => .1
    const def = UNITS.monster, speed = def.chargeSpeed - .02
    const a = spawn(b, 0, 'monster', 'a', 100, 100, 0, { models: 1, files: 1 })
    const c = spawn(b, 1, 'monster', 'c', 100 + 2 * def.radius + .1 + 2 * speed * DT, 100, Math.PI, { models: 1, files: 1 })
    commandAttack(b, [a.id], c.id); commandAttack(b, [c.id], a.id)
    for (const [r, vx] of [[a, speed], [c, -speed]] as const) Object.assign(r.soldiers[0], { speed, vx, vy: 0, meleeCd: 100, collisionCd: 100, hp: 1e5 })
    step(b, DT)
    for (const r of [a, c]) {
      expect(r.soldiers[0].chargeLeft).toBe(CHARGE_DURATION)
      expect(r.soldiers[0].chargePower).toBe(1)
      expect(r.dealt).toHaveLength(1)
    }
  })

  it('role guard: a model moving under one metre per second toward its target never charges, whatever the ratio', () => {
    const def = UNITS.sword, previous = { speed: def.speed, chargeSpeed: def.chargeSpeed }
    try {
      Object.assign(def, { speed: .4, chargeSpeed: .9 })
      const { b, s } = encounter()
      step(b, DT)
      expect(s.chargeLeft).toBe(0)
    } finally { Object.assign(def, previous) }
  })

  it('negates a frontal large charge only with applicable charge defence', () => {
    const front = encounter('heavyCavalry', 'spear')
    front.target.soldiers[0].braceTime = 1
    step(front.b, DT)
    // The charge happened, so its window runs and no new charge can start in it, but it carries no bonus.
    expect(front.s.chargeLeft).toBe(CHARGE_DURATION)
    expect(front.s.chargePower).toBe(0)
    expect(front.s.chargeContactAt).toBe(front.b.time)

    const ordinary = encounter('heavyCavalry', 'sword')
    ordinary.target.soldiers[0].braceTime = 1
    step(ordinary.b, DT)
    expect(ordinary.s.chargePower).toBe(1)

    const rear = encounter('heavyCavalry', 'spear')
    rear.target.facing = rear.target.soldiers[0].facing = 0
    rear.target.soldiers[0].braceTime = 1
    step(rear.b, DT)
    expect(rear.s.chargePower).toBe(1)
  })

  it('a negated charge still uses up its window: a monster ploughing on through braced halberds charges only once', () => {
    const b = createEmptyBattle(42)
    b.rng = () => .1
    const def = UNITS.monster, speed = def.chargeSpeed
    const block = spawn(b, 1, 'halberd', 'halberds', 108, 100, Math.PI, { models: 24, files: 6 })
    for (const foe of block.soldiers) Object.assign(foe, { braceTime: 1, meleeCd: 100, hp: 1e5 })
    const first = block.soldiers.filter(f => f.rank === 0).sort((p, q) => Math.abs(p.y - 100) - Math.abs(q.y - 100))[0]
    const beast = spawn(b, 0, 'monster', 'beast', first.x - def.radius - UNITS.halberd.radius - .1 - speed * DT, first.y, 0, { models: 1, files: 1 })
    commandAttack(b, [beast.id], block.id)
    const s = beast.soldiers[0]
    Object.assign(s, { speed, vx: speed, vy: 0, meleeCd: 100, collisionCd: 100 })
    const contacts = new Set<number>()
    // It keeps running into fresh halberdiers above the speed threshold for several steps after the first contact.
    for (let i = 0; i < 20; i++) { step(b, DT); if (s.chargeContactAt >= 0) contacts.add(s.chargeContactAt) }
    expect(contacts.size).toBe(1)
    expect(s.chargePower).toBe(0)
    // One zero-windup blow, split over its splash victims.
    expect(new Set(beast.dealt.map(e => e.t)).size).toBe(1)
  })

  it('charge defence against large does not negate an infantry charge', () => {
    const { b, target, s } = encounter('sword', 'spear')
    target.soldiers[0].braceTime = 1
    step(b, DT)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
    expect(s.chargePower).toBeGreaterThan(.95)
  })

  it.each(['sword', 'heavyCavalry'] as UnitType[])('braced halberds negate a frontal %s charge', type => {
    const { b, target, s } = encounter(type, 'halberd')
    target.soldiers[0].braceTime = 1
    step(b, DT)
    expect(s.chargeContactAt).toBe(b.time)
    expect(s.chargePower).toBe(0)
  })

  it('does not qualify a walking model or external shove as a charge', () => {
    const walk = encounter()
    commandBehavior(walk.b, [walk.attacker.id], { run: false })
    step(walk.b, DT)
    expect(walk.s.chargeLeft).toBe(0)

    const pushed = encounter('sword', 'sword', 0)
    pushed.s.pushVx = pushed.s.vx = 10
    step(pushed.b, DT)
    expect(pushed.s.chargeLeft).toBe(0)
  })

  it('a model that accelerated before arriving receives the bonus without any distance gate', () => {
    const b = createEmptyBattle(6)
    const a = spawn(b, 0, 'sword', 'a', 100, 100, 0, { models: 1, files: 1 })
    const target = spawn(b, 1, 'general', 'target', 108, 100, Math.PI)
    target.soldiers[0].meleeCd = 100
    commandAttack(b, [a.id], target.id)
    for (let i = 0; i < 100 && a.soldiers[0].chargeLeft === 0; i++) step(b, DT)
    expect(a.soldiers[0].chargeLeft).toBeGreaterThan(CHARGE_DURATION - 1)
    expect(a.soldiers[0].chargePower).toBeGreaterThan(THRESHOLD)
  })

  it('does not refresh the timer with repeated point-blank attack orders', () => {
    const { b, attacker, target, s } = encounter()
    step(b, DT)
    for (let i = 0; i < 10; i++) { commandAttack(b, [attacker.id], target.id); step(b, DT) }
    expect(s.chargeLeft).toBeCloseTo(CHARGE_DURATION - .5, 8)
  })

  it('recognises reaching charge speed during the same movement step that makes contact', () => {
    const { b, s, target } = encounter()
    s.speed = s.vx = UNITS.sword.chargeSpeed - .05
    target.anchorX = target.destX = target.soldiers[0].x = 100 + 2 * UNITS.sword.radius + .3
    step(b, DT)
    expect(s.chargeLeft).toBe(CHARGE_DURATION)
    expect(s.chargePower).toBe(1)
  })

  it('a model that slowed down before it reached an enemy still means to charge, but gets no charge', () => {
    const { b, s, target } = encounter('sword', 'sword', 0)
    step(b, DT)
    expect(s.chargeArmed).toBe(true)
    expect(s.chargeLeft).toBe(0)
    expect(target.taken).toHaveLength(0)
  })
})

describe('charge first strike', () => {
  it.each(['sword', 'heavyCavalry', 'chariot', 'ogre', 'monster', 'inquisitor'] as UnitType[])('%s strikes on contact with no windup, with its full charge bonus, then swings on its own cycle', type => {
    const def = UNITS[type], bonus = def.chargeBonus
    const contact = () => {
      const { b, attacker, target, s } = encounter(type, 'sword')
      target.soldiers[0].hp = 1e5
      // Swing ready, collision attack out of the way: only the charge blow can land.
      s.meleeCd = 0; s.collisionCd = 100
      step(b, DT)
      return { b, attacker, s }
    }
    try {
      def.chargeBonus = 0
      const plain = contact().attacker.dealt
      def.chargeBonus = bonus
      const { b, attacker, s } = contact()
      // The charge began and its blow already landed in the contact step: no swing was wound up for it.
      expect(s.chargeLeft).toBe(CHARGE_DURATION)
      expect(attacker.dealt).toHaveLength(1)
      expect(s.swing).toBeNull()
      expect(s.meleeCd).toBeCloseTo(def.meleeInterval, 9)
      // The same blow without the charge bonus deals less.
      expect(plain).toHaveLength(1)
      expect(attacker.dealt[0].v).toBeGreaterThan(plain[0].v)
      // The next swing waits for the ordinary interval and has its windup.
      let next = -1
      for (let i = 0; i < 200 && next < 0; i++) { step(b, DT); if (s.swing) next = b.time }
      expect(next).toBeGreaterThanOrEqual(def.meleeInterval - 1e-6)
    } finally { def.chargeBonus = bonus }
  })

  it('a charge into braced charge defence still strikes at once, without the bonus', () => {
    const run = (braced: boolean) => {
      const { b, attacker, target, s } = encounter('heavyCavalry', 'spear')
      target.soldiers[0].hp = 1e5; s.meleeCd = 0
      if (braced) target.soldiers[0].braceTime = 1
      step(b, DT)
      expect(s.chargeContactAt).toBe(b.time)
      return { power: s.chargePower, dealt: attacker.dealt.reduce((n, e) => n + e.v, 0) }
    }
    const braced = run(true), open = run(false)
    expect(braced.power).toBe(0); expect(open.power).toBe(1)
    expect(braced.dealt).toBeGreaterThan(0)
    expect(braced.dealt).toBeLessThan(open.dealt)
  })

  it.each([['just below', THRESHOLD - .06, false], ['just above', THRESHOLD + .04, true]] as const)('a model running %s the speed threshold (%s of charge speed) at contact charges: %s', (_, fraction, charges) => {
    const { b, s, target } = encounter('sword', 'sword', fraction)
    target.soldiers[0].hp = 1e5
    s.meleeCd = 0
    step(b, DT)
    if (charges) {
      // The zero-windup first strike, with a bonus of the contact's strength.
      expect(s.chargePower).toBeGreaterThanOrEqual(THRESHOLD)
      expect(s.chargePower).toBeLessThan(THRESHOLD + .1)
      expect(target.soldiers[0].hp).toBeLessThan(1e5)
      expect(s.swing).toBeNull()
    } else {
      // No charge and no blow on contact: it winds up as usual.
      expect(s.chargeLeft).toBe(0)
      expect(target.soldiers[0].hp).toBe(1e5)
      expect(s.swing).not.toBeNull()
    }
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

describe('men left behind while the regiment is engaged', () => {
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
    return { b, a, target, rear }
  }

  // Under the old rule the man behind ran past his comrade to find an enemy of his own and charged him.
  it.each(['sword', 'spear', 'greatsword', 'heavyCavalry', 'shieldCavalry', 'ogre', 'armoredOgre'] as UnitType[])('a %s left behind runs up at attacking pace and falls in behind the man fighting ahead of him', type => {
    const { b, a, rear } = staggered(type), def = UNITS[type], front = a.soldiers[0]
    let peak = 0, ahead = -Infinity
    for (let i = 0; i < 400; i++) {
      step(b, .05)
      peak = Math.max(peak, rear.speed)
      // The file faces +x: how far the rear man's centre comes toward the front man's.
      ahead = Math.max(ahead, rear.x - front.x)
    }
    expect(peak).toBeGreaterThan(def.speed)
    // He never comes up level with his file leader, let alone past him into the enemy...
    expect(ahead).toBeLessThan(-def.rankSpacing * .6)
    // ...and ends standing in the place behind him, without a charge of his own.
    expect(front.x - rear.x).toBeLessThan(def.rankSpacing * 1.6)
    expect(Math.abs(rear.y - front.y)).toBeLessThan(def.spacing)
    expect(rear.speed).toBeLessThan(.3)
    expect(rear.chargeLeft).toBe(0)
    expect(a.engaged).toBe(true)
    expect(battleErrors(b)).toEqual([])
  })

  it('a man left behind comes up below the running pace when walking was explicitly selected', () => {
    const { b, a, rear } = staggered('heavyCavalry')
    commandBehavior(b, [a.id], { run: false })
    for (let i = 0; i < 60; i++) step(b, .05)
    // A straggler may jog to catch his ranks up (RULES 三.1), but he does not break into a run.
    expect(rear.speed).toBeGreaterThan(2.5)
    expect(rear.speed).toBeLessThan(UNITS.heavyCavalry.speed)
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

  it('the rear group of a scattered cavalry regiment rides up and forms behind the front that is already fighting', () => {
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
    const rear = a.soldiers.slice(12), front = a.soldiers.slice(0, 12)
    for (let i = 0; i < 70; i++) step(b, .05)
    expect(rear.filter(s => s.speed > UNITS.heavyCavalry.speed).length).toBeGreaterThanOrEqual(18)
    let past = 0
    for (let i = 0; i < 400; i++) {
      step(b, .05)
      // The regiment faces +x; the enemy's nearest file stands just beyond its front rank.
      const line = Math.max(...front.filter(s => s.alive).map(s => s.x))
      past = Math.max(past, ...rear.filter(s => s.alive && s.down <= 0).map(s => s.x - line))
    }
    // Nobody from the rear rides past the fighting rank or round it; they stand formed up behind it.
    expect(past).toBeLessThan(.5)
    const d = UNITS.heavyCavalry, standing = rear.filter(s => s.alive)
    expect(standing.filter(s => s.speed < .3).length).toBeGreaterThanOrEqual(standing.length - 2)
    expect(Math.max(...standing.map(s => Math.abs(s.y - a.anchorY)))).toBeLessThan((a.files + 1) * d.spacing / 2 + 1)
    expect(battleErrors(b)).toEqual([])
  })
})

describe('no repeated charges inside a melee; cycle charging still works', () => {
  const N = Math.PI / 2, S = -Math.PI / 2
  /** Per-model charge starts: the charge window jumping back up to its full length. */
  const charges = (reg: Regiment, before: Map<number, number>, counts: Map<number, number>) => {
    for (const s of reg.soldiers) if (s.chargeLeft > (before.get(s.id) ?? 0) + 1) counts.set(s.id, (counts.get(s.id) ?? 0) + 1)
  }
  const cavalryVsSwords = (seed: number) => {
    const b = createEmptyBattle(seed)
    const cav = spawn(b, 0, 'heavyCavalry', 'cav', 100, 30, N, scaledFormation('heavyCavalry', 4))
    const foe = spawn(b, 1, 'sword', 'foe', 100, 100, S, scaledFormation('sword', 4))
    b.aiEnabled = false
    commandAttack(b, [cav.id], foe.id)
    return { b, cav, foe }
  }
  const tick = (b: ReturnType<typeof createEmptyBattle>, reg: Regiment, counts: Map<number, number>, steps: number, each?: () => void) => {
    for (let i = 0; i < steps; i++) {
      const before = new Map(reg.soldiers.map(s => [s.id, s.chargeLeft]))
      step(b, DT); charges(reg, before, counts); each?.()
    }
  }

  it.each([false, true])('a rider shoved out of a melee runs back in: charges again only after a new order (new order: %s)', reorder => {
    const b = createEmptyBattle(42)
    const a = spawn(b, 0, 'heavyCavalry', 'rider', 100, 100, 0, { models: 1, files: 1 })
    const t = spawn(b, 1, 'sword', 'target', 112, 100, Math.PI, { models: 1, files: 1, hp: 1e7 })
    t.soldiers[0].meleeCd = 1e9
    commandAttack(b, [a.id], t.id)
    const r = a.soldiers[0]
    // From a standing start a horse gathers itself before it surges, so the first charge lands a little later.
    for (let i = 0; i < 340; i++) step(b, DT)
    expect(r.contactTime).toBeGreaterThan(CHARGE_DURATION)
    // Thrown 9 m clear of the fight; he runs straight back in. (A horse gathers itself before it surges: from a
    // standstill it needs that much ground to be at charging speed again.)
    Object.assign(r, { x: r.x - 9, prevX: r.x - 9, vx: 0, vy: 0, speed: 0, chargeLeft: 0 })
    if (reorder) { commandMove(b, [a.id], a.anchorX - 5, a.anchorY, null); commandAttack(b, [a.id], t.id) }
    let again = false
    for (let i = 0; i < 200; i++) { step(b, DT); again ||= r.chargeLeft > CHARGE_DURATION - 1 }
    expect(r.contactTime).toBeGreaterThan(0)
    expect(again).toBe(reorder)
  })

  it('riders pulled out and ordered in again charge again, even while comrades still touch the enemy', () => {
    // Swords that cannot rout, so the battle is still on when the riders come round again.
    const original = UNITS.sword
    UNITS.sword = { ...original, unbreakable: true }
    try {
    const { b, cav, foe } = cavalryVsSwords(1), first = new Map<number, number>(), second = new Map<number, number>()
    let contactAt = -1
    tick(b, cav, first, 400, () => { if (contactAt < 0 && cav.inContact) contactAt = b.time })
    expect(contactAt).toBeGreaterThan(0)
    // Back out 20 m, then straight back in while a few riders are still caught in the melee (2 s: horses turn round
    // fast enough that the whole unit is clear of the swords by about 2.25 s). A regiment-wide rule would allow none.
    commandMove(b, [cav.id], cav.anchorX, cav.anchorY - 20, null)
    tick(b, cav, first, 40)
    const stillTouching = cav.soldiers.filter(s => s.alive && s.contactTime > 0).length
    commandAttack(b, [cav.id], foe.id)
    tick(b, cav, second, 300)
    expect(stillTouching).toBeGreaterThan(0)
    // Over so short a run back in, the riders slow off the mark do not all reach charging speed; some do.
    expect(second.size).toBeGreaterThanOrEqual(2)
    } finally { UNITS.sword = original }
  }, 30000)
})

describe("a mounted charge is the whole line's", () => {
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)

  it('riders ordered to attack ride at the charge from the start, gathering for a moment and then surging', () => {
    const b = createEmptyBattle(7)
    const cav = spawn(b, 0, 'heavyCavalry', 'riders', 100, 40, Math.PI / 2), foe = spawn(b, 1, 'sword', 'target', 100, 180, -Math.PI / 2)
    const def = UNITS.heavyCavalry
    commandAttack(b, [cav.id], foe.id)
    const from = mean(cav.soldiers.map(s => s.y))
    for (let i = 0; i < 20; i++) step(b, DT)
    // However far off the target is, this is the charge, not a run-up to one.
    expect(cav.wantCharge).toBe(true)
    const first = mean(cav.soldiers.map(s => s.y)) - from, pace = mean(cav.soldiers.map(s => s.speed))
    expect(first).toBeGreaterThan(1); expect(first).toBeLessThan(2.2)
    for (let i = 0; i < 20; i++) step(b, DT)
    // The second second gains more speed than the first did: slow off the mark, then the surge.
    expect(mean(cav.soldiers.map(s => s.speed)) - pace).toBeGreaterThan(pace * 1.2)
    for (let i = 0; i < 20; i++) step(b, DT)
    expect(mean(cav.soldiers.map(s => s.speed))).toBeGreaterThan(def.chargeSpeed * 0.97)
    // At full pace within three seconds, some 15 m on.
    expect(mean(cav.soldiers.map(s => s.y)) - from).toBeGreaterThan(13)
    expect(battleErrors(b)).toEqual([])
  })

  it('one rider meeting an enemy short of the line does not stop the others or end their charge', () => {
    const b = createEmptyBattle(7)
    const cav = spawn(b, 0, 'heavyCavalry', 'riders', 100, 40, Math.PI / 2), foe = spawn(b, 1, 'sword', 'target', 100, 120, -Math.PI / 2)
    const def = UNITS.heavyCavalry, front = cav.soldiers.filter(s => s.rank === 0)
    // A lone enemy stands 14 m in front of his own line, in the path of one file.
    const stray = spawn(b, 1, 'sword', 'stray', front[2].x, 104, -Math.PI / 2, { models: 1, files: 1 })
    stray.soldiers[0].meleeCd = 100
    commandAttack(b, [cav.id], foe.id)
    let met = -1
    for (let i = 0; i < 400 && met < 0; i++) { step(b, DT); if (stray.soldiers[0].down > 0 || !stray.soldiers[0].alive) met = i }
    expect(met).toBeGreaterThan(0)
    // He was ridden down by the one file that met him. The line is not held by that, and its charge goes on.
    expect(cav.soldiers.filter(s => s.impactHold > 0).length).toBeLessThanOrEqual(2)
    for (let i = 0; i < 10; i++) {
      step(b, DT)
      expect(cav.engaged).toBe(false); expect(cav.wantCharge).toBe(true)
    }
    const others = front.filter(s => s.alive && s.impactHold <= 0)
    expect(others.length).toBeGreaterThanOrEqual(front.length - 2)
    expect(mean(others.map(s => s.speed))).toBeGreaterThan(def.chargeSpeed * 0.9)
    // They go on to strike the line they were sent at, at the charge.
    const struck = new Set<number>()
    for (let i = 0; i < 100; i++) {
      step(b, DT)
      for (const s of front) if (s.chargeLeft > 0 && s.chargePower >= 0.9) struck.add(s.id)
    }
    expect(cav.engaged).toBe(true)
    expect(struck.size).toBeGreaterThanOrEqual(front.length - 3)
    expect(battleErrors(b)).toEqual([])
  })

  it('a line that meets the enemy at an angle is stopped only once nearly half its front rank is', () => {
    const b = createEmptyBattle(7)
    const cav = spawn(b, 0, 'heavyCavalry', 'riders', 100, 40, Math.PI / 2)
    // The target stands askew to the riders' approach, so one end of their line reaches it first.
    const foe = spawn(b, 1, 'sword', 'target', 100, 100, -Math.PI / 2 + 0.6)
    const front = cav.soldiers.filter(s => s.rank === 0)
    commandAttack(b, [cav.id], foe.id)
    let first = -1, held = -1
    for (let i = 0; i < 400 && held < 0; i++) {
      step(b, DT)
      if (first < 0 && front.some(s => s.impactHold > 0 || s.chargeLeft > 0)) first = i
      if (cav.engaged) held = i
      else if (first >= 0) expect(cav.wantCharge).toBe(true)
    }
    expect(first).toBeGreaterThan(0); expect(held).toBeGreaterThan(first)
    // When the line does stop, close to half of its front rank has struck or is held.
    const live = front.filter(s => s.alive)
    expect(live.filter(s => s.impactHold > 0 || s.chargeLeft > 0).length).toBeGreaterThanOrEqual(Math.floor(live.length * 0.4))
    // The riders still short of the enemy carry their charge home: most of the front rank strikes at the charge.
    const struck = new Set<number>()
    for (let i = 0; i < 60; i++) { step(b, DT); for (const s of front) if (s.chargeLeft > 0) struck.add(s.id) }
    expect(struck.size).toBeGreaterThanOrEqual(front.length - 3)
    expect(battleErrors(b)).toEqual([])
  })
})
