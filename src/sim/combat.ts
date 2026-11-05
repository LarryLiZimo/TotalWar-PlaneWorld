import { clamp } from './math'
import type { DamageTraits, Fatigue, Resistances, Soldier, UnitDef } from './types'
import { FATIGUE, MECHANICS } from './mechanics'

/** How long a knocked-down foot soldier stays on the ground. */
export const KNOCK_TIME = MECHANICS.knockdownTime
export const CHARGE_DURATION = 13

export function chargeDecay(secondsLeft: number): number {
  return clamp(secondsLeft / CHARGE_DURATION, 0, 1)
}

/** Entity-relative quadrants, as documented by CA. */
export function defenseMultiplier(angle: number): number {
  const d = Math.abs(angle)
  return d <= Math.PI / 4 ? 1 : d >= Math.PI * 3 / 4 ? 0.3 : 0.6
}

/** Melee hit chance in percent. Clamped to 8–90. */
export function hitChance(meleeAttack: number, meleeDefense: number): number {
  return clamp(35 + meleeAttack - meleeDefense, 8, 90)
}

/**
 * Armor blocks only the non-AP portion.
 * `armorRoll` is the fraction of armor used this hit, uniform in [0.5, 1].
 */
export function mitigate(base: number, ap: number, armor: number, armorRoll: number): number {
  const reduction = Math.min(100, Math.max(0, armor) * armorRoll)
  return base * (1 - reduction / 100) + ap
}

export function armorRoll(rng: () => number): number {
  return 0.5 + rng() * 0.5
}

/** Raw impact before the 30/70 split and armor. Closing speed must exceed 5 m/s. */
export function impactRaw(
  power: number,
  closing: number,
  massAttacker: number,
  massTarget: number,
): number {
  if (power <= 0 || closing <= 5) return 0
  const massFactor = massAttacker / (massAttacker + massTarget)
  const speedFactor = Math.pow(closing / 10, 1.3)
  return power * speedFactor * massFactor
}

export function splitBonus(base: number, ap: number, bonus: number): { base: number; ap: number } {
  const total = base + ap
  if (bonus === 0 || total <= 0) return { base: 0, ap: 0 }
  const ratio = ap / total
  return { base: bonus * (1 - ratio), ap: bonus * ratio }
}

export function fatigueMods(level: Fatigue) {
  return FATIGUE[level]
}

export function woundMods(def: UnitDef, soldier?: Soldier): { damage: number; speed: number } {
  return def.wounds && soldier?.wounded ? def.wounds : { damage: 1, speed: 1 }
}

export function resistanceMultiplier(resistances: Resistances, kind: 'melee' | 'missile' | 'impact', traits: DamageTraits = {}): number {
  const combined = resistances.ward + (!traits.magical && !traits.spell ? resistances.physical : 0)
    + (kind === 'missile' ? resistances.missile : 0) + (traits.spell ? resistances.spell : 0)
    + (traits.flaming ? resistances.fire : 0)
  return 1 - Math.min(0.9, combined)
}

export function calibrationRadius(distance: number, calibrationDistance: number, radius: number): number {
  return Math.max(0, distance / Math.max(1, calibrationDistance) * radius)
}

export function effectiveLeadership(input: {
  base: number
  initial: number
  alive: number
  flank: boolean
  rear: boolean
  recentDamage: boolean
  winning: boolean
  routingFriends: number
  healthFraction?: number
  recentLossFraction?: number
  encourage?: number
  commanderDead?: boolean
  armyLosses?: boolean
  fear?: boolean
  fatigue?: number
}): number {
  return Object.values(leadershipFactors(input)).reduce((sum, value) => sum + value, 0)
}

export function leadershipFactors(input: Parameters<typeof effectiveLeadership>[0]): Record<string, number> {
  const health = input.healthFraction ?? (input.initial <= 0 ? 1 : input.alive / input.initial)
  const lossPct = (1 - clamp(health, 0, 1)) * 100
  return {
    base: input.base, casualties: -0.5 * lossPct,
    position: input.rear ? -25 : input.flank ? -15 : 0,
    damaged: input.recentDamage ? -10 : 0,
    winning: input.winning ? 8 : 0,
    routingFriends: -Math.min(24, 12 * input.routingFriends),
    recentLosses: -Math.min(30, (input.recentLossFraction ?? 0) * 100),
    encourage: input.encourage ?? 0,
    commander: input.commanderDead ? MECHANICS.commanderDeathPenalty : 0,
    armyLosses: input.armyLosses ? MECHANICS.armyLossesPenalty : 0,
    fear: input.fear ? MECHANICS.fearPenalty : 0,
    fatigue: input.fatigue ?? 0,
  }
}
