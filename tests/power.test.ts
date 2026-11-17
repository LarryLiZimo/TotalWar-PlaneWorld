import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { MECHANICS } from '../src/sim/mechanics'
import { advanceMorale } from '../src/sim/morale'
import { armyPower, regimentPower, regimentPowerMax, southShare } from '../src/sim/power'
import { applyFrame, frameOf, packPoses, readBattle, wireBattle } from '../src/sim/transport'
import type { Battle, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

const N = Math.PI / 2, S = -Math.PI / 2
const cost = (type: UnitType) => UNITS[type].cost
const melee = MECHANICS.powerRangedMeleeShare, floor = MECHANICS.powerSingleEntityFloor

function unit(b: Battle, side: 0 | 1, type: UnitType, x: number, y: number): Regiment {
  return spawn(b, side, type, type, x, y, side === 0 ? N : S)
}
/** Scale every living model's health (and, if given, ammunition) to a fraction of full. */
function wear(reg: Regiment, hp: number, ammo = 1): Regiment {
  const ammoEach = UNITS[reg.type].missile?.ammo ?? 0
  for (const s of reg.soldiers) { s.hp = reg.modelHp * hp; s.ammo = ammoEach * ammo }
  return reg
}

describe('regiment value: purchase cost, lowered by health and ammunition', () => {
  it('values every fresh regiment and single entity at its cost', () => {
    const b = createEmptyBattle(1)
    for (const [type, x] of [['sword', 100], ['giant', 140], ['archer', 60], ['warWagon', 180], ['general', 20]] as [UnitType, number][]) {
      const reg = unit(b, 0, type, x, 40)
      expect(regimentPower(reg)).toBeCloseTo(cost(type))
      expect(regimentPowerMax(reg)).toBe(cost(type))
    }
  })

  it('scales a melee regiment fully with health', () => {
    const b = createEmptyBattle(2)
    expect(regimentPower(wear(unit(b, 0, 'sword', 100, 40), 0.5))).toBeCloseTo(cost('sword') * 0.5)
    expect(regimentPower(wear(unit(b, 0, 'sword', 100, 80), 0.01))).toBeCloseTo(cost('sword') * 0.01)
  })

  it('splits a missile regiment evenly into a health-bound and an ammunition-bound half', () => {
    expect(melee).toBe(0.5)
    const b = createEmptyBattle(3)
    expect(regimentPower(wear(unit(b, 0, 'archer', 60, 40), 1, 0.5))).toBeCloseTo(cost('archer') * (melee + (1 - melee) * 0.5))
    expect(regimentPower(wear(unit(b, 0, 'archer', 60, 80), 0.5, 0))).toBeCloseTo(cost('archer') * melee * 0.5)
    // Ammunition counts per model left: half the archers dead takes half the arrows with them.
    const archers = unit(b, 0, 'archer', 60, 120)
    for (const s of archers.soldiers.slice(0, archers.soldiers.length / 2)) s.alive = false
    expect(regimentPower(archers)).toBeCloseTo(cost('archer') * 0.5)
  })

  it('keeps a 20% floor for a single entity until it dies, while 80% follows its health', () => {
    const b = createEmptyBattle(4)
    expect(regimentPower(wear(unit(b, 0, 'giant', 160, 40), 0.25))).toBeCloseTo(cost('giant') * (floor + (1 - floor) * 0.25))
    const nearlyDead = wear(unit(b, 0, 'giant', 120, 80), 0.001)
    expect(regimentPower(nearlyDead)).toBeGreaterThan(cost('giant') * floor)
    for (const s of nearlyDead.soldiers) s.alive = false
    expect(regimentPower(nearlyDead)).toBe(0)
    expect(regimentPowerMax(nearlyDead)).toBe(cost('giant'))
  })

  it('still counts a routing regiment, which can rally, but not a shattered one', () => {
    const b = createEmptyBattle(5)
    const reg = unit(b, 0, 'sword', 100, 40)
    advanceMorale(reg, -100, false, false, 0.05)
    expect(reg.routing).toBe(true)
    expect(reg.shattered).toBe(false)
    expect(regimentPower(reg)).toBeCloseTo(cost('sword'))
    reg.shattered = true
    expect(regimentPower(reg)).toBe(0)
  })

  it('shatters only on the third rout', () => {
    const b = createEmptyBattle(6)
    const reg = unit(b, 0, 'sword', 100, 40)
    for (let rout = 1; rout <= 3; rout++) {
      Object.assign(reg, { routing: false, moraleState: 'steady', negativeTime: 0 })
      expect(advanceMorale(reg, -100, false, false, 0.05)).toBe(rout < 3 ? 'routed' : 'shattered')
      expect(reg.shattered).toBe(rout === 3)
    }
  })
})

describe('the power bar decides the battle', () => {
  it('sums each army and gives south\'s share of the bar', () => {
    const b = createEmptyBattle(7)
    unit(b, 0, 'sword', 80, 40); unit(b, 0, 'archer', 120, 40)
    unit(b, 1, 'sword', 100, 190)
    const power = armyPower(b)
    const south = cost('sword') + cost('archer')
    expect(power.value[0]).toBeCloseTo(south)
    expect(power.max).toEqual([south, cost('sword')])
    expect(southShare(power)).toBeCloseTo(south / (south + cost('sword')))
    expect(southShare({ value: [0, 0] })).toBe(0.5)
  })

  it('does not break an army that is merely outnumbered at deployment', () => {
    const b = createEmptyBattle(8)
    unit(b, 0, 'sword', 100, 40)
    for (let i = 0; i < 4; i++) unit(b, 1, 'sword', 40 + i * 40, 190)
    const power = armyPower(b)
    expect(southShare(power)).toBeCloseTo(0.2)
    expect(power.losing).toEqual([false, false])
    step(b, 0.05)
    expect(b.winner).toBeNull()
    expect(b.regiments[0].routing).toBe(false)
  })

  it('needs both a small share of the bar and the army\'s own losses', () => {
    const b = createEmptyBattle(9)
    const south = [unit(b, 0, 'sword', 60, 40), unit(b, 0, 'sword', 140, 40)].map(r => wear(r, 0.4))
    ;[unit(b, 1, 'sword', 60, 190), unit(b, 1, 'sword', 140, 190)].forEach(r => wear(r, 0.9))
    // Down to 40% of its own value, but still holding 0.8 / 2.6 ≈ 31% of the bar.
    expect(southShare(armyPower(b))).toBeGreaterThan(MECHANICS.armyLossesShare)
    expect(armyPower(b).losing).toEqual([false, false])
    // Further losses tip it under the 23% share: 0.5 / 2.3 ≈ 22%.
    south.forEach(r => wear(r, 0.25))
    const power = armyPower(b)
    expect(southShare(power)).toBeLessThanOrEqual(MECHANICS.armyLossesShare)
    expect(power.losing).toEqual([true, false])
  })

  it('decides the battle when an army is pushed past its mark: all of it breaks for good, and the battle runs on', () => {
    const b = createEmptyBattle(10)
    const beaten = [wear(unit(b, 0, 'sword', 60, 40), 0.2), wear(unit(b, 0, 'spear', 140, 40), 0.2)]
    for (let i = 0; i < 3; i++) unit(b, 1, 'sword', 40 + i * 60, 200)
    step(b, 0.05)
    expect(b.winner).toBe(1)
    for (const reg of beaten) {
      expect(reg.routing).toBe(true)
      expect(reg.shattered).toBe(true)
      expect(reg.order).toBe('hold')
    }
    expect(b.notices.map(notice => notice.text)).toContain('南军全军溃散')
    // Broken for good, the beaten army is worth nothing: the bar is pushed all the way over.
    expect(b.power.value[0]).toBe(0)
    expect(b.power.losing).toEqual([true, false])
    // Nothing stops. Time goes on, the beaten run for their own map edge and the victors stand.
    const from = beaten.map(reg => reg.soldiers[0].y), time = b.time
    for (let i = 0; i < 60; i++) step(b, 0.05)
    expect(b.time).toBeCloseTo(time + 3)
    beaten.forEach((reg, i) => expect(reg.soldiers[0].y).toBeLessThan(from[i] - 3))
    expect(b.winner).toBe(1)
    expect(b.regiments.filter(reg => reg.side === 1).every(reg => !reg.routing)).toBe(true)
  })

  it('is not decided by a rout: one regiment against one routs, keeps its place on the bar, rallies and stands again', () => {
    const b = createEmptyBattle(14)
    const south = unit(b, 0, 'sword', 150, 200)
    unit(b, 1, 'sword', 20, 215)
    south.routing = true; south.routCount = 1; south.moraleState = 'routing'
    step(b, 0.05)
    expect(south.routing).toBe(true)
    expect(b.winner).toBeNull()
    expect(southShare(b.power)).toBeCloseTo(0.5)
    expect(b.power.losing).toEqual([false, false])
    for (let i = 0; i < 20 * 25 && south.routing; i++) step(b, 0.05)
    expect(south.routing).toBe(false)
    expect(b.time).toBeGreaterThan(MECHANICS.minimumRout)
    expect(b.winner).toBeNull()
  })

  it('counts an army with nothing left as beaten, and both at once as a draw', () => {
    const b = createEmptyBattle(15)
    const south = unit(b, 0, 'sword', 100, 40), north = unit(b, 1, 'sword', 100, 200)
    for (const s of [...south.soldiers, ...north.soldiers]) { s.alive = false; s.hp = 0 }
    expect(armyPower(b).losing).toEqual([true, true])
    step(b, 0.05)
    expect(b.winner).toBe(-1)
    // A side that deployed nothing is not an army: a lone regiment on an empty field has not won anything.
    const alone = createEmptyBattle(16)
    unit(alone, 0, 'sword', 100, 40)
    step(alone, 0.05)
    expect(alone.power.losing).toEqual([false, false])
    expect(alone.winner).toBeNull()
  })

  it('leaves unbreakable units fighting on after their army has lost', () => {
    const b = createEmptyBattle(11)
    const sword = wear(unit(b, 0, 'sword', 60, 40), 0.1)
    const zealots = wear(unit(b, 0, 'flagellant', 140, 40), 0.1)
    for (let i = 0; i < 3; i++) unit(b, 1, 'sword', 40 + i * 60, 200)
    step(b, 0.05)
    expect(b.winner).toBe(1)
    expect(sword.shattered).toBe(true)
    expect(zealots.routing).toBe(false)
    expect(zealots.shattered).toBe(false)
    // They alone still stand on the bar.
    expect(b.power.value[0]).toBeCloseTo(cost('flagellant') * 0.1)
    for (let i = 0; i < 40; i++) step(b, 0.05)
    expect(zealots.routing).toBe(false)
  })
})

describe('the power bar on the main thread', () => {
  it('is refreshed every step and travels with the worker frame', () => {
    const b = createEmptyBattle(12)
    unit(b, 0, 'archer', 100, 40); unit(b, 1, 'sword', 100, 190)
    expect(b.power.max).toEqual([0, 0])
    const view = readBattle(structuredClone(wireBattle(b)))
    step(b, 0.05)
    expect(b.power).toEqual(armyPower(b))
    expect(b.power.max).toEqual([cost('archer'), cost('sword')])
    applyFrame(view, structuredClone(frameOf(b, packPoses(b), [1], false)))
    expect(view.power).toEqual(b.power)
  })
})
