import { clamp } from './math'
import type { Fatigue } from './types'

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
  braced: boolean,
): number {
  if (power <= 0 || closing <= 5) return 0
  const massFactor = massAttacker / (massAttacker + massTarget)
  const speedFactor = Math.pow(closing / 10, 1.3)
  let raw = power * speedFactor * massFactor
  if (braced) raw *= 0.3
  return raw
}

export function splitBonus(base: number, ap: number, bonus: number): { base: number; ap: number } {
  const total = base + ap
  if (bonus === 0 || total <= 0) return { base: 0, ap: 0 }
  const ratio = ap / total
  return { base: bonus * (1 - ratio), ap: bonus * ratio }
}

/** Full bonus for 4s, then linear decay to 0 at 12s. */
export function chargeScale(timer: number): number {
  if (timer < 0) return 0
  if (timer <= 4) return 1
  if (timer >= 12) return 0
  return 1 - (timer - 4) / 8
}

export function fatigueMods(level: Fatigue): { stat: number; reload: number } {
  if (level === 'exhausted') return { stat: 0.8, reload: 1.2 }
  return { stat: 1, reload: 1 }
}

export function accuracyAt(distance: number, near: number, far: number, accNear: number, accFar: number): number {
  if (distance <= near) return accNear
  if (distance >= far) return accFar
  return accNear + ((accFar - accNear) * (distance - near)) / (far - near)
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
}): number {
  const lossPct = input.initial <= 0 ? 0 : ((input.initial - input.alive) / input.initial) * 100
  let leadership = input.base - 0.5 * lossPct
  if (input.rear) leadership -= 25
  else if (input.flank) leadership -= 15
  if (input.recentDamage) leadership -= 10
  if (input.winning) leadership += 8
  leadership -= 12 * input.routingFriends
  return leadership
}
