import { clamp } from './math'
import type { Battle } from './types'
import { MAP_HEIGHT, MAP_WIDTH } from './types'

export function elevationAt(battle: Battle, x: number, y: number): number {
  const t = battle.terrain
  return t.kind === 'flat' ? 0 : t.rise * (t.axis === 'x' ? x / MAP_WIDTH : y / MAP_HEIGHT)
}

export function gradientAlong(battle: Battle, heading: number): number {
  const t = battle.terrain
  if (t.kind === 'flat') return 0
  return t.rise * (t.axis === 'x' ? Math.cos(heading) / MAP_WIDTH : Math.sin(heading) / MAP_HEIGHT)
}

export function slopeSpeed(battle: Battle, heading: number): number {
  return clamp(1 - gradientAlong(battle, heading), 0.5, 1.5)
}

export function slopeFatigue(battle: Battle, heading: number): number {
  const gradient = gradientAlong(battle, heading)
  return gradient > 0.2 ? 2.5 : gradient > 0.1 ? 2 : gradient > 0.05 ? 1.5 : 1
}

export function elevationDamage(delta: number, missile: boolean): number {
  return 1 + clamp(delta / (missile ? 40 : 1), -1, 1) * 0.3
}
