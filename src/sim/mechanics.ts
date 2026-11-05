import type { Fatigue } from './types'

/** Published mechanics and local approximations are separated in RULES.md.
 * Timing/activity values here are calibratable approximations, not a copied KV database. */
export const MECHANICS = {
  braceTime: 0.5,
  braceTurnRate: 1.5,
  braceStillFraction: 0.75,
  chargeReflectWindow: 3.9,
  chargeReflectDamage: 2,
  knockdownTime: 2,
  cavalryContactHold: 2.5,
  routDelay: 2.5,
  shatterLeadership: -50,
  shatterRouts: 3,
  minimumRout: 10,
  rallyDelay: 8,
  rallyEnemyDistance: 30,
  encourageRadius: 40,
  commanderDeathPenalty: -16,
  armyLossesFraction: 0.22,
  armyLossesRatio: 2.6,
  armyLossesPenalty: -120,
  fearRadius: 15,
  fearPenalty: -8,
  terrorLeadership: 13,
  terrorCooldown: 30,
  groundFriction: 7.5,
  movingFriction: 5,
  downFriction: 4,
  cartShoveSpeed: 1.8,
  braceGroundGrip: 1.75,
  maxContactCorrection: 0.12,
  collisionRadiusScale: 0.62,
  contactPadding: 0.02,
  friendlySoftFraction: 0.35,
  enemySoftFraction: 0.12,
  contactStiffness: 20,
  // Preserve the user's deliberate muzzle/terminal friendly-fire design.
  muzzleSafeDistance: 8,
  muzzleSafeFraction: 0.2,
  terminalFriendlyDistance: 8,
  fatigueRates: { rest: -120, walk: -50, run: 40, charge: 100, melee: 150, shooting: 70 },
} as const

export const FATIGUE: Record<Fatigue, { threshold: number; speed: number; attack: number; defense: number; armor: number; ap: number; charge: number; reload: number; leadership: number }> = {
  fresh: { threshold: 0, speed: 1, attack: 1, defense: 1, armor: 1, ap: 1, charge: 1, reload: 1, leadership: 0 },
  active: { threshold: 2800, speed: 1, attack: 0.95, defense: 1, armor: 1, ap: 1, charge: 1, reload: 1, leadership: 0 },
  winded: { threshold: 6600, speed: 0.95, attack: 0.95, defense: 1, armor: 1, ap: 0.9, charge: 1, reload: 1 / 0.9, leadership: 0 },
  tired: { threshold: 12200, speed: 0.9, attack: 0.85, defense: 1, armor: 1, ap: 0.9, charge: 0.8, reload: 1 / 0.85, leadership: -2 },
  veryTired: { threshold: 18000, speed: 0.85, attack: 0.75, defense: 1, armor: 0.9, ap: 0.9, charge: 0.75, reload: 1 / 0.75, leadership: -4 },
  exhausted: { threshold: 27000, speed: 0.85, attack: 0.7, defense: 0.9, armor: 0.75, ap: 0.9, charge: 0.7, reload: 1 / 0.65, leadership: -8 },
}

export const FATIGUE_NAMES: Record<Fatigue, string> = { fresh: '精神', active: '活跃', winded: '气喘', tired: '疲惫', veryTired: '非常疲惫', exhausted: '力竭' }
export function fatigueAt(points: number): Fatigue {
  const levels = Object.keys(FATIGUE) as Fatigue[]
  return levels.reverse().find(level => points >= FATIGUE[level].threshold) ?? 'fresh'
}
