import { describe, expect, it } from 'vitest'
import { createBattle, step } from '../src/sim/battle'
import {
  CHARGE_DURATION,
  casualtyPenalty,
  chargeDecay,
  effectiveChargeSpeed,
  effectiveLeadership,
  hitChance,
  leadershipFactors,
  mitigate,
  speedPower,
} from '../src/sim/combat'
import { MECHANICS } from '../src/sim/mechanics'
import { assignFormation, isBracing, slotOf } from '../src/sim/formation'
import { facingArc } from '../src/sim/math'
import { clampFrontLine, commandAttack, commandMove } from '../src/sim/orders'
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

  it('judges every speed relative to the maximum: nothing below the threshold, then the ratio, capped at 1', () => {
    const t = MECHANICS.speedThreshold
    expect(speedPower(10 * (t - .01), 10)).toBe(0)
    expect(speedPower(10 * t, 10)).toBeCloseTo(t, 12)
    expect(speedPower(6, 10)).toBeCloseTo(.6, 12)
    expect(speedPower(10, 10)).toBe(1)
    expect(speedPower(25, 10)).toBe(1)
    // Rounding just under the maximum still counts as full strength.
    expect(speedPower(10 - 1e-12, 10)).toBe(1)
    expect(speedPower(0, 10)).toBe(0)
    expect(speedPower(-4, 10)).toBe(0)
    expect(speedPower(5, 0)).toBe(0)
    // The maximum is the charge speed after fatigue.
    expect(effectiveChargeSpeed(UNITS.monster, 'fresh')).toBe(UNITS.monster.chargeSpeed)
    expect(effectiveChargeSpeed(UNITS.monster, 'tired')).toBeCloseTo(UNITS.monster.chargeSpeed * .9, 12)
  })

  it('decays charge bonus linearly over ten seconds', () => {
    expect(CHARGE_DURATION).toBe(10)
    expect(chargeDecay(0)).toBe(0)
    expect(chargeDecay(-3)).toBe(0)
    expect(chargeDecay(2.5)).toBe(0.25)
    expect(chargeDecay(5)).toBe(0.5)
    expect(chargeDecay(10)).toBe(1)
    expect(chargeDecay(13)).toBe(1)
  })

  it('adds leadership up from casualties, sudden losses, the state of the fight and who stands where', () => {
    const M = MECHANICS.morale
    expect(effectiveLeadership({ base: 75, lost: 0 })).toBe(75)
    // Casualties follow the curve: nothing for the first tenth, then steeper and steeper.
    expect(casualtyPenalty(0.05)).toBe(0)
    expect(casualtyPenalty(0.3)).toBe(-10)
    expect(casualtyPenalty(0.4)).toBeCloseTo(-20)
    expect(casualtyPenalty(0.5)).toBe(-30)
    expect(casualtyPenalty(1)).toBe(-100)
    expect(casualtyPenalty(0.5) - casualtyPenalty(0.3)).toBeLessThan(casualtyPenalty(0.3) - casualtyPenalty(0.1))
    const worn = leadershipFactors({
      base: 60, lost: 0.3, recentLoss: 0.06, dealt: 0.01, taken: 0.03, friends: 2, enemies: 1.5,
      flank: true, rear: true, charged: 0.5, underFire: true, routingFriends: 3,
    })
    // 6 % lost in the window, 2 % of it free.
    expect(worn.recentLosses).toBeCloseTo((0.06 - M.recentFree) * 100 * M.recentRate)
    // Dealt a third of what it took: (1 - 3) / 4 = -0.5, of which combatEven counts as level.
    expect(worn.combat).toBeCloseTo(M.losing * (0.5 - M.combatEven) / (1 - M.combatEven))
    expect(worn.friends).toBe(2 * M.friendNear)
    expect(worn.enemies).toBe(1.5 * M.enemyNear)
    // Flank and rear are separate effects and both apply.
    expect(worn.flank).toBe(M.flank)
    expect(worn.rear).toBe(M.rear)
    expect(worn.rear).toBeLessThan(worn.flank)
    expect(worn.charged).toBe(M.chargedByMounted * 0.5)
    expect(worn.underFire).toBe(M.underFire)
    expect(worn.routingFriends).toBe(M.routingFriendMax)
    expect(worn.charging).toBe(0)
    expect(Object.values(worn).reduce((sum, value) => sum + value, 0)).toBeCloseTo(effectiveLeadership({
      base: 60, lost: 0.3, recentLoss: 0.06, dealt: 0.01, taken: 0.03, friends: 2, enemies: 1.5,
      flank: true, rear: true, charged: 0.5, underFire: true, routingFriends: 3,
    }))
    // The mirror image of that fight is winning it; charging adds its own.
    const bold = leadershipFactors({ base: 60, lost: 0, dealt: 0.03, taken: 0.01, charging: 1, friends: 9, enemies: 9 })
    expect(bold.combat).toBeCloseTo(M.winning * (0.5 - M.combatEven) / (1 - M.combatEven))
    expect(bold.charging).toBe(M.charging)
    expect(bold.friends).toBe(M.friendMax)
    expect(bold.enemies).toBe(M.enemyMax)
    // A few stray blows are no fight, and a level one moves nobody.
    expect(leadershipFactors({ base: 60, lost: 0, dealt: 0, taken: M.combatFloor / 2 }).combat).toBe(0)
    expect(leadershipFactors({ base: 60, lost: 0, dealt: 0.02, taken: 0.022 }).combat).toBe(0)
    expect(leadershipFactors({ base: 60, lost: 0, recentLoss: M.recentFree }).recentLosses).toBe(0)
    expect(leadershipFactors({ base: 60, lost: 0, recentLoss: 0.9 }).recentLosses).toBe(M.recentMax)
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
    expect(reversed.x1).toBe(100)
    expect(reversed.y1).toBe(2)
    expect(reversed.x2).toBeCloseTo(96)
    const fitted = clampFrontLine(3, 1, 5, 1, 0.85, 80)
    expect(fitted.x1).toBe(3)
    expect(fitted.length).toBeCloseTo(2)
  })

  it('never stands a unit wider than its type allows', () => {
    const battle = createBattle(1)
    for (const reg of battle.regiments) {
      assignFormation(reg, reg.aliveCount)
      expect(reg.files).toBe(Math.min(reg.aliveCount, UNITS[reg.type].maxFiles))
    }
  })
})

describe('rear rank', () => {
  it('stands the short last rank in the center', () => {
    const battle = createBattle(1)
    const reg = battle.regiments[0]
    assignFormation(reg, 9)
    const rear = reg.soldiers.filter((soldier) => soldier.alive && soldier.centerIndex >= 0)
    expect(rear).toHaveLength(80 % 9)
    const rank = rear[0].rank
    const left = slotOf(reg, UNITS[reg.type], 0, rank, 0)
    const right = slotOf(reg, UNITS[reg.type], 0, rank, rear.length - 1)
    expect((left.x + right.x) / 2).toBeCloseTo(reg.anchorX, 4)
    expect(left.y).toBeCloseTo(right.y, 4)
  })
})

describe('battle', () => {
  it('opens with both armies already formed', () => {
    const battle = createBattle(1)
    expect(battle.regiments).toHaveLength(33)
    const men = battle.regiments.reduce((sum, reg) => sum + reg.initial, 0)
    expect(men).toBe(1974)
    expect(battle.regiments.filter((reg) => reg.side === 1 && (reg.type === 'spear' || reg.type === 'sword' || reg.type === 'greatsword'))).toHaveLength(11)
    expect(battle.aiEnabled).toBe(false)
    expect(battle.regiments.filter((reg) => reg.type === 'chariot')[0].initial).toBe(4)
    expect(battle.regiments.every((reg) => reg.order === 'hold')).toBe(true)
    const infantry = battle.regiments[0]
    expect(isBracing(infantry, UNITS[infantry.type], infantry.anchorX, infantry.anchorY + 20)).toBe(false)
    infantry.stationaryTime = 1.5
    expect(isBracing(infantry, UNITS[infantry.type], infantry.anchorX, infantry.anchorY + 20)).toBe(true)
    expect(isBracing(infantry, UNITS[infantry.type], infantry.anchorX, infantry.anchorY - 20)).toBe(false)
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
    const enemy = battle.regiments.find((reg) => reg.name === '北军矛兵')
    expect(enemy).toBeTruthy()
    expect(enemy!.anchorY).toBeCloseTo(148, 0)
    expect(totalHp(battle)).toBe(startHp)
  }, 25000)

  it('isolates the ram: a chariot with no weapon and no collision attack throws infantry unhurt until its momentum is spent', () => {
    const original = UNITS.chariot
    UNITS.chariot = { ...original, chargeBonus: 0, weaponBase: 0, weaponAp: 0, collisionAttack: null }
    try {
      const run = chariotRearCharge()
      expect(run.flung).toBeGreaterThan(8)
      // Rams deal no damage of their own (RULES 四.7).
      expect(run.infantry.aliveCount).toBe(80)
      expect(run.worstOnHit).toBe(UNITS.spear.hp)
      expect(run.infantry.soldiers.every(s => s.hp === UNITS.spear.hp)).toBe(true)
      // Each man thrown takes momentum off it (RULES 四.7): it stops among the spears instead of driving out beyond them.
      expect(run.farthest).toBeLessThan(run.infantry.anchorY + 4)
    } finally {
      UNITS.chariot = original
    }
  })

  it('the same chariot charge with its collision attack hurts the men it runs into', () => {
    const run = chariotRearCharge()
    expect(run.flung).toBeGreaterThan(8)
    expect(run.infantry.soldiers.some(s => !s.alive || s.hp < UNITS.spear.hp)).toBe(true)
  })


})

function chariotRearCharge() {
  const battle = createBattle(3)
  const chariot = battle.regiments.find((reg) => reg.name === '南军战车')!
  const infantry = battle.regiments.find((reg) => reg.name === '北军矛兵二')!
  const north = Math.PI / 2
  let park = 0
  for (const reg of battle.regiments) {
    if (reg === chariot || reg === infantry) continue
    dropRegiment(reg, 18 + (park % 4) * 28, 16 + Math.floor(park / 4) * 22, north)
    park += 1
  }
  dropRegiment(infantry, 200, 120, north)
  dropRegiment(chariot, 200, 72, north)
  commandAttack(battle, [chariot.id], infantry.id)
  let flung = 0
  let worstOnHit = 64
  let farthest = chariot.anchorY
  const seenDown = new Set<number>()
  for (let i = 0; i < 20 * 12; i++) {
    step(battle, 0.05)
    farthest = Math.max(farthest, chariot.anchorY)
    for (const soldier of infantry.soldiers) {
      if (soldier.down > 0 && !seenDown.has(soldier.id)) {
        seenDown.add(soldier.id)
        flung += 1
        if (soldier.alive) worstOnHit = Math.min(worstOnHit, soldier.hp)
      }
    }
  }
  return { battle, chariot, infantry, flung, worstOnHit, farthest }
}

function dropRegiment(reg: ReturnType<typeof createBattle>['regiments'][number], x: number, y: number, facing: number): void {
  reg.anchorX = x
  reg.anchorY = y
  reg.destX = x
  reg.destY = y
  reg.facing = facing
  reg.destFacing = facing
  reg.order = 'hold'
  reg.targetId = null
  reg.wantCharge = false
  reg.engaged = false
  reg.plow = 0
  reg.anchorSpeed = 0
  const def = UNITS[reg.type]
  for (const soldier of reg.soldiers) {
    const slot = slotOf(reg, def, soldier.file, soldier.rank, soldier.centerIndex)
    soldier.x = slot.x
    soldier.y = slot.y
    soldier.facing = facing
    soldier.speed = 0
    soldier.vx = 0
    soldier.vy = 0
    soldier.down = 0
    soldier.knockVx = 0
    soldier.knockVy = 0
  }
}

function totalHp(battle: ReturnType<typeof createBattle>): number {
  let hp = 0
  for (const reg of battle.regiments) {
    for (const soldier of reg.soldiers) if (soldier.alive) hp += soldier.hp
  }
  return hp
}
