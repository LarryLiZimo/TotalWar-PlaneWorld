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
  // Any rammer but a chariot holds the melee it rammed into this long (RULES 三.3). Rams themselves deal no damage.
  impactContactHold: 2.5,
  // Rams exchange momentum (RULES 四.7). A struck body resists with its mass × impactMass (the men packed round and
  // behind it), × impactBraceMultiplier when braced against the rammer: ×1 at one rank up to impactBraceMax at eight.
  // A man on foot whose change of speed reaches knockdownSpeedChange (m/s) is knocked down. Calibrated: a chariot
  // ploughs through about 4 braced light infantry from the front and 6 from flank or rear, heavy cavalry 2 and 3 ranks.
  impactMass: 10,
  impactBraceMax: 3,
  knockdownSpeedChange: 0.7,
  // Every speed-dependent contact (charge, collision attack, ram knockdown, the charging fatigue activity) is judged
  // relative to the acting body's own effective charge speed: no effect below this share of it, and above it the
  // effect's strength is the share itself, capped at 1 (RULES 四.3). Placeholder, to be calibrated.
  speedThreshold: 0.5,
  // A model may charge again only after a new order and rechargeGap seconds out of weapon reach; within
  // chargeEntryWindow seconds of coming into contact it can still deliver its charge (a whole first wave, contacts that
  // reach the attack arc a moment later). No repeated charges inside a melee; cycle charging still works.
  rechargeGap: 1,
  chargeEntryWindow: 0.5,
  // Movement feel (RULES 三.2, 四.3). A regiment on the attack runs up at its running pace and breaks into the charge
  // chargeRun seconds of charging short of its target. Horses and carts gather themselves: their acceleration grows
  // from surgeStart to surgeEnd times the base rate as they near their top pace (the mean is 1, so the time to top
  // pace is unchanged); a man on foot breaking into a charge accelerates footBurst times as hard.
  chargeRun: 3.5,
  surgeStart: 0.6,
  surgeEnd: 1.6,
  footBurst: 1.8,
  // A charging line is ragged: each file runs up to chargeStagger of a rank spacing (of staggerSpacing at most, for
  // the big bodies) ahead of or behind its place, the ranks behind the first by less. It comes on over staggerRise
  // seconds and closes up over staggerFall.
  chargeStagger: 0.6,
  staggerSpacing: 1.5,
  staggerRise: 1.2,
  staggerFall: 1.5,
  // A ram goes through the man it hits into the men at his back (RULES 四.7): he, if he stays on his feet, and the
  // friends within shoveDepth behind him and shoveWidth to either side along the blow, are driven back at shoveShare
  // of the closing speed, less with depth, half for a braced man, never past shoveMax m/s.
  shoveShare: 0.3,
  shoveDepth: 2.6,
  shoveWidth: 0.55,
  shoveMax: 3,
  // Heavy blows (RULES 四.8): a monster's hit throws a man on foot down; a brute's or a great weapon's drives him back
  // at this speed, m/s.
  blowShoveBrute: 3,
  blowShoveGreat: 1.8,
  routDelay: 2.5,
  // Leadership at or below this routs at once instead of after routDelay. Only the shatterRouts-th rout shatters.
  instantRoutLeadership: -30,
  shatterRouts: 3,
  minimumRout: 10,
  rallyDelay: 8,
  rallyEnemyDistance: 30,
  encourageRadius: 40,
  commanderDeathPenalty: -16,
  // Leadership modifiers (RULES 七.1). All local values, shaped after WH3's list of morale effects and calibrated so
  // that an ordinary line regiment losing an even frontal fight breaks at roughly two thirds casualties, and much
  // sooner when it is also flanked, charged from behind or shot at.
  morale: {
    // Leadership lost at each share of deployed health lost; linear between the points.
    casualties: [[0.1, 0], [0.3, -10], [0.5, -30], [0.65, -52], [0.8, -75], [1, -100]],
    // Sudden losses: health lost over the last recentWindow seconds as a share of what the regiment had when the
    // window began. Nothing up to recentFree, then recentRate per further 1 %, down to recentMax.
    recentWindow: 8,
    recentFree: 0.02,
    recentRate: -2.5,
    recentMax: -25,
    // How the fight is going: melee damage dealt against taken over combatWindow seconds, (dealt - taken) / (dealt +
    // taken). Within combatEven of level it counts for nothing; beyond, up to `winning` or down to `losing`. An
    // exchange smaller than combatFloor of the regiment's deployed health is no fight at all.
    combatWindow: 10,
    combatEven: 0.2,
    combatFloor: 0.005,
    winning: 8,
    losing: -12,
    // Company: every friendly regiment in good order within supportRadius adds friendNear, every enemy one takes
    // enemyNear, each weighted by the share of its men it still has.
    supportRadius: 60,
    friendNear: 2,
    friendMax: 6,
    enemyNear: -2,
    enemyMax: -8,
    // Enemies fighting the regiment from beside its block, or from behind it: at least flankMen of its men have one
    // at weapon's reach there. Both can apply; each lasts flankHold seconds after the contact ends.
    flank: -10,
    rear: -18,
    flankMen: 3,
    flankHold: 3,
    // Foot charged or rammed by cavalry or chariots: at least chargedMen of its men are charged home into in one
    // step, and more of them than stop the charge on a braced charge defence. From chargedByMounted fading to nothing
    // over chargedTime seconds.
    chargedByMounted: -15,
    chargedMen: 3,
    chargedTime: 10,
    // Hit by enemy missiles within the last underFireTime seconds.
    underFire: -5,
    underFireTime: 4,
    // Charging: full while running in at charging speed, then fading with the charge bonus itself.
    charging: 8,
    routingFriend: -5,
    routingFriendMax: -10,
    routingFriendRadius: 40,
  },
  // Power bar (power.ts): a missile unit's value is this share health-bound, the rest ammo-bound; a single entity keeps
  // this floor of its cost while alive and not shattered. To be calibrated.
  powerRangedMeleeShare: 0.5,
  powerSingleEntityFloor: 0.2,
  // An army has lost the battle when its share of the bar is at most armyLossesShare and it keeps at most
  // armyLossesRemaining of its deployed value: all of it then breaks for good (battle.ts decideBattle).
  armyLossesShare: 0.23,
  armyLossesRemaining: 0.5,
  fearRadius: 15,
  fearPenalty: -8,
  terrorLeadership: 13,
  terrorCooldown: 30,
  groundFriction: 7.5,
  movingFriction: 5,
  downFriction: 4,
  cartShoveSpeed: 1.8,
  braceGroundGrip: 1.75,
  // Each comrade packed right behind a man a slow cart pushes adds this share of his resistance (up to three).
  tractionSupport: 0.5,
  maxContactCorrection: 0.12,
  collisionRadiusScale: 0.62,
  contactPadding: 0.02,
  friendlySoftFraction: 0.35,
  // A large body and a friend on foot stand this share of the large body's (slim) radius closer still, so riders and
  // monstrous infantry can pass through, and stand in, the file gaps of friendly foot without scattering them.
  mixedPassShare: 0.45,
  enemySoftFraction: 0.12,
  contactStiffness: 20,
  // Preserve the user's deliberate muzzle/terminal friendly-fire design.
  muzzleSafeDistance: 8,
  muzzleSafeFraction: 0.2,
  terminalFriendlyDistance: 8,
  // Exertion per second, one rate per regiment per step from what its bodies actually do (RULES 六.1), in priority
  // melee contact > shooting / reloading > charging > running > walking > standing.
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
