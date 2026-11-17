import { MECHANICS } from './mechanics'
import type { ArmyPower, Battle, Regiment } from './types'
import { unitDef } from './units'

/**
 * Battlefield value (实力). A regiment is worth its purchase cost when whole, and loses value with health and ammunition:
 *
 *   condition = HP share                                             (melee units)
 *   condition = meleeShare × HP share + (1 − meleeShare) × ammo share (missile units; ammo share = ammo × models left)
 *   value     = cost × condition                                     (regiments)
 *   value     = cost × (floor + (1 − floor) × condition)             (single entities: the floor holds while alive)
 *
 * Shares are against the regiment as deployed (initial models × model HP, initial models × ammo each). Routing
 * regiments can come back and keep their value; shattered (third rout), destroyed or escaped regiments are worth 0.
 */
export function regimentCondition(reg: Regiment): number {
  const def = unitDef(reg.type)
  let hp = 0, ammo = 0
  for (const s of reg.soldiers) {
    if (!s.alive) continue
    hp += s.hp
    ammo += s.ammo
  }
  const hpShare = Math.min(1, hp / Math.max(1e-9, reg.initial * reg.modelHp))
  if (!def.missile) return hpShare
  const ammoShare = Math.min(1, ammo / Math.max(1e-9, reg.initial * def.missile.ammo))
  return MECHANICS.powerRangedMeleeShare * hpShare + (1 - MECHANICS.powerRangedMeleeShare) * ammoShare
}

/** What the regiment is worth whole: its purchase cost. */
export function regimentPowerMax(reg: Regiment): number {
  return unitDef(reg.type).cost
}

/** What the regiment is worth now. */
export function regimentPower(reg: Regiment): number {
  // Counted from the bodies: aliveCount is refreshed only at the end of a step.
  if (reg.shattered || !reg.soldiers.some((s) => s.alive)) return 0
  const def = unitDef(reg.type), condition = regimentCondition(reg)
  const floor = def.models === 1 ? MECHANICS.powerSingleEntityFloor : 0
  return def.cost * (floor + (1 - floor) * condition)
}

/** South's share of the bar, 0..1; an empty field reads as even. */
export function southShare(power: Pick<ArmyPower, 'value'>): number {
  const total = power.value[0] + power.value[1]
  return total > 0 ? power.value[0] / total : 0.5
}

/**
 * Both armies' battlefield value, and whether each is beaten (`losing`): its share of the bar is at most
 * `armyLossesShare` AND it has itself lost value down to `armyLossesRemaining` of what it deployed. The second
 * condition keeps an army that merely starts outnumbered from losing before the fighting. An army with nothing left
 * is beaten whatever the other has; a side that deployed nothing is not an army and cannot lose.
 */
export function armyPower(battle: Battle): ArmyPower {
  const value: [number, number] = [0, 0], max: [number, number] = [0, 0]
  for (const reg of battle.regiments) {
    value[reg.side] += regimentPower(reg)
    max[reg.side] += regimentPowerMax(reg)
  }
  const total = value[0] + value[1]
  const losing = [0, 1].map((side) => max[side] > 0
    && value[side] <= total * MECHANICS.armyLossesShare
    && value[side] <= max[side] * MECHANICS.armyLossesRemaining) as [boolean, boolean]
  return { value, max, losing }
}

/** Recompute and store the battle's power for display; the simulation calls this at the end of every step. */
export function refreshPower(battle: Battle): ArmyPower {
  battle.power = armyPower(battle)
  return battle.power
}
