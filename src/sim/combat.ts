import { clamp } from './math'
import type { DamageTraits, Fatigue, Resistances, Soldier, UnitDef } from './types'
import { FATIGUE, MECHANICS } from './mechanics'

/** How long a knocked-down foot soldier stays on the ground. */
export const KNOCK_TIME = MECHANICS.knockdownTime
/** Seconds a charge bonus lasts from contact; it decays linearly to zero over this time (RULES 四.3). */
export const CHARGE_DURATION = 10

export function chargeDecay(secondsLeft: number): number {
  return clamp(secondsLeft / CHARGE_DURATION, 0, 1)
}

/** Share of the full charge bonus a model has now: its charge's strength from contact, decaying linearly to zero. */
export function chargeStrength(soldier: Pick<Soldier, 'chargeLeft' | 'chargePower'>): number {
  return soldier.chargePower * chargeDecay(soldier.chargeLeft)
}

/** A body's effective maximum speed for every relative speed check: its charge speed after fatigue. */
export function effectiveChargeSpeed(def: UnitDef, fatigue: Fatigue): number {
  return def.chargeSpeed * fatigueMods(fatigue).speed
}

/**
 * The one relative speed rule (RULES 四.3): a speed over the acting body's effective maximum speed. Below
 * MECHANICS.speedThreshold the effect does not happen (0); at or above it, the effect's strength is the ratio, capped
 * at 1. A body with no maximum speed never qualifies.
 */
export function speedPower(speed: number, maxSpeed: number): number {
  if (!(maxSpeed > 0) || !(speed > 0)) return 0
  // The tolerance only absorbs rounding: a body moving at exactly its charge speed has full strength.
  const ratio = speed / maxSpeed
  if (ratio + 1e-9 < MECHANICS.speedThreshold) return 0
  return ratio + 1e-9 >= 1 ? 1 : ratio
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

export function resistanceMultiplier(resistances: Resistances, kind: 'melee' | 'missile', traits: DamageTraits = {}): number {
  const combined = resistances.ward + (!traits.magical && !traits.spell ? resistances.physical : 0)
    + (kind === 'missile' ? resistances.missile : 0) + (traits.spell ? resistances.spell : 0)
    + (traits.flaming ? resistances.fire : 0)
  return 1 - Math.min(0.9, combined)
}

export function calibrationRadius(distance: number, calibrationDistance: number, radius: number): number {
  return Math.max(0, distance / Math.max(1, calibrationDistance) * radius)
}

/** What a regiment's leadership is worked out from (RULES 七.1). Everything but `base` and `lost` may be left out. */
export interface LeadershipInput {
  base: number
  /** Share of its deployed health the regiment has lost, 0..1. */
  lost: number
  /** Health lost over the last MECHANICS.morale.recentWindow seconds, as a share of what it had when they began. */
  recentLoss?: number
  /** Melee damage dealt and taken over MECHANICS.morale.combatWindow seconds, as shares of its deployed health. */
  dealt?: number
  taken?: number
  /** Friendly and enemy regiments in good order nearby, each counted by the share of its men it still has. */
  friends?: number
  enemies?: number
  /** An enemy regiment is fighting it from beside it / from behind it. */
  flank?: boolean
  rear?: boolean
  /** 0..1: how fresh a mounted charge into this foot regiment is. */
  charged?: number
  underFire?: boolean
  /** 0..1: charging now, or how much of its charge it still has. */
  charging?: number
  routingFriends?: number
  encourage?: number
  commanderDead?: boolean
  fear?: boolean
  fatigue?: number
}

/** Leadership lost to casualties alone at a share of deployed health lost. */
export function casualtyPenalty(lost: number): number {
  const curve = MECHANICS.morale.casualties, share = clamp(lost, 0, 1)
  let fromShare = 0, fromValue = 0
  for (const [toShare, toValue] of curve) {
    if (share <= toShare) return fromValue + (toValue - fromValue) * (toShare > fromShare ? (share - fromShare) / (toShare - fromShare) : 1)
    fromShare = toShare; fromValue = toValue
  }
  return fromValue
}

export function effectiveLeadership(input: LeadershipInput): number {
  return Object.values(leadershipFactors(input)).reduce((sum, value) => sum + value, 0)
}

export function leadershipFactors(input: LeadershipInput): Record<string, number> {
  const M = MECHANICS.morale
  const recent = Math.max(M.recentMax, Math.min(0, (clamp(input.recentLoss ?? 0, 0, 1) - M.recentFree) * 100 * M.recentRate))
  const dealt = Math.max(0, input.dealt ?? 0), taken = Math.max(0, input.taken ?? 0)
  const balance = dealt + taken >= M.combatFloor ? (dealt - taken) / (dealt + taken) : 0
  const edge = clamp((Math.abs(balance) - M.combatEven) / (1 - M.combatEven), 0, 1)
  const factors: Record<string, number> = {
    base: input.base,
    casualties: casualtyPenalty(input.lost),
    recentLosses: recent,
    combat: balance > 0 ? M.winning * edge : M.losing * edge,
    friends: Math.min(M.friendMax, M.friendNear * Math.max(0, input.friends ?? 0)),
    enemies: Math.max(M.enemyMax, M.enemyNear * Math.max(0, input.enemies ?? 0)),
    flank: input.flank ? M.flank : 0,
    rear: input.rear ? M.rear : 0,
    charged: M.chargedByMounted * clamp(input.charged ?? 0, 0, 1),
    underFire: input.underFire ? M.underFire : 0,
    charging: M.charging * clamp(input.charging ?? 0, 0, 1),
    routingFriends: Math.max(M.routingFriendMax, M.routingFriend * (input.routingFriends ?? 0)),
    encourage: input.encourage ?? 0,
    commander: input.commanderDead ? MECHANICS.commanderDeathPenalty : 0,
    fear: input.fear ? MECHANICS.fearPenalty : 0,
    fatigue: input.fatigue ?? 0,
  }
  // A penalty times nothing is -0; the panel and the tests should see plain 0.
  for (const key in factors) factors[key] += 0
  return factors
}
