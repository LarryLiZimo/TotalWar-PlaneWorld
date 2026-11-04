import { describe, expect, it } from 'vitest'
import { createBattle, step } from '../src/sim/battle'
import {
  chargeScale,
  effectiveLeadership,
  hitChance,
  impactRaw,
  mitigate,
} from '../src/sim/combat'
import { assignFormation, isBracing, slotOf } from '../src/sim/formation'
import { facingArc } from '../src/sim/math'
import { clampFrontLine, commandMove } from '../src/sim/orders'
import { UNITS } from '../src/sim/units'

describe('combat formulas', () => {
  it('clamps melee hit chance', () => {
    expect(hitChance(28, 44)).toBe(19)
    expect(hitChance(10, 100)).toBe(8)
    expect(hitChance(100, 0)).toBe(90)
  })

  it('lets armor block only non-AP damage', () => {
    expect(mitigate(24, 8, 0, 1)).toBe(32)
    expect(mitigate(24, 8, 200, 0.5)).toBe(8)
    expect(mitigate(24, 8, 80, 0.8)).toBeCloseTo(16.64, 5)
  })

  it('scales impact by mass, speed, and brace', () => {
    expect(impactRaw(70, 5, 480, 110, false)).toBe(0)
    expect(impactRaw(70, 13, 480, 110, false)).toBeCloseTo(80.09, 1)
    expect(impactRaw(70, 13, 480, 110, true)).toBeCloseTo(24.03, 1)
    expect(impactRaw(70, 13, 110, 480, false)).toBeLessThan(impactRaw(70, 13, 480, 110, false))
  })

  it('decays charge bonus after four seconds', () => {
    expect(chargeScale(-1)).toBe(0)
    expect(chargeScale(2)).toBe(1)
    expect(chargeScale(8)).toBeCloseTo(0.5)
    expect(chargeScale(12)).toBe(0)
  })

  it('keeps leadership above zero until losses and position stack', () => {
    const leadership = effectiveLeadership({
      base: 52,
      initial: 60,
      alive: 44,
      flank: false,
      rear: true,
      recentDamage: true,
      winning: false,
      routingFriends: 0,
    })
    expect(leadership).toBeCloseTo(3.667, 2)
    expect(
      effectiveLeadership({
        base: 75,
        initial: 80,
        alive: 80,
        flank: false,
        rear: false,
        recentDamage: false,
        winning: false,
        routingFriends: 0,
      }),
    ).toBe(75)
  })

  it('reads front, flank, and rear from facing', () => {
    expect(facingArc(Math.PI / 2, 0, 0, 0, 5)).toBe('front')
    expect(facingArc(Math.PI / 2, 0, 0, 0, -5)).toBe('rear')
    expect(facingArc(Math.PI / 2, 0, 0, 5, 0)).toBe('flank')
  })
})

describe('formation line', () => {
  it('pins the left end and refuses to stretch past the unit', () => {
    const wide = clampFrontLine(0, 0, 100, 0, 1, 5)
    expect(wide.x1).toBe(0)
    expect(wide.y1).toBe(0)
    expect(wide.length).toBeCloseTo(4)
    expect(wide.x2).toBeCloseTo(4)
    const reversed = clampFrontLine(100, 2, 0, 2, 1, 5)
    expect(reversed.x1).toBe(0)
    expect(reversed.y1).toBe(2)
    expect(reversed.x2).toBeCloseTo(4)
    const fitted = clampFrontLine(3, 1, 5, 1, 0.85, 80)
    expect(fitted.x1).toBe(3)
    expect(fitted.length).toBeCloseTo(2)
  })
})

describe('rear rank', () => {
  it('stands the short last rank in the center', () => {
    const battle = createBattle(1)
    const reg = battle.regiments[0]
    assignFormation(reg, 6)
    const rear = reg.soldiers.filter((soldier) => soldier.alive && soldier.centerIndex >= 0)
    expect(rear).toHaveLength(80 % 6)
    const rank = rear[0].rank
    const left = slotOf(reg, UNITS.infantry, 0, rank, 0)
    const right = slotOf(reg, UNITS.infantry, 0, rank, rear.length - 1)
    expect((left.x + right.x) / 2).toBeCloseTo(reg.anchorX, 4)
    expect(left.y).toBeCloseTo(right.y, 4)
  })
})

describe('battle', () => {
  it('opens with both armies already formed', () => {
    const battle = createBattle(1)
    expect(battle.regiments).toHaveLength(11)
    const men = battle.regiments.reduce((sum, reg) => sum + reg.initial, 0)
    expect(men).toBe(700)
    expect(battle.regiments.filter((reg) => reg.side === 1 && reg.type === 'infantry')).toHaveLength(5)
    expect(battle.aiEnabled).toBe(false)
    expect(battle.regiments.filter((reg) => reg.type === 'chariot')[0].initial).toBe(4)
    expect(battle.regiments.every((reg) => reg.order === 'hold')).toBe(true)
    const infantry = battle.regiments[0]
    expect(isBracing(infantry, UNITS.infantry, infantry.anchorX, infantry.anchorY + 20)).toBe(false)
    infantry.stationaryTime = 1.5
    expect(isBracing(infantry, UNITS.infantry, infantry.anchorX, infantry.anchorY + 20)).toBe(true)
    expect(isBracing(infantry, UNITS.infantry, infantry.anchorX, infantry.anchorY - 20)).toBe(false)
  })

  it('accepts a move order and stays finite while the enemy closes', () => {
    const battle = createBattle(7)
    const player = battle.regiments[0]
    commandMove(battle, [player.id], player.anchorX + 12, player.anchorY + 8, null)
    const startHp = totalHp(battle)
    for (let i = 0; i < 20 * 25; i++) step(battle, 0.05)
    expect(player.anchorX).toBeGreaterThan(42)
    for (const reg of battle.regiments) {
      expect(Number.isFinite(reg.anchorX)).toBe(true)
      expect(Number.isFinite(reg.anchorY)).toBe(true)
      expect(Number.isFinite(reg.leadership)).toBe(true)
      for (const soldier of reg.soldiers) {
        expect(Number.isFinite(soldier.x)).toBe(true)
        expect(Number.isFinite(soldier.y)).toBe(true)
        expect(Number.isFinite(soldier.hp)).toBe(true)
      }
    }
    const enemy = battle.regiments.find((reg) => reg.name === '北军一步')
    expect(enemy).toBeTruthy()
    expect(enemy!.anchorY).toBeCloseTo(128, 0)
    expect(totalHp(battle)).toBe(startHp)
  })
})

function totalHp(battle: ReturnType<typeof createBattle>): number {
  let hp = 0
  for (const reg of battle.regiments) {
    for (const soldier of reg.soldiers) if (soldier.alive) hp += soldier.hp
  }
  return hp
}
