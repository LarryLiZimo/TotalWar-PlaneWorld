import { isBracing } from './formation'
import { distPointToSegment } from './math'
import type { Battle, OrderKind, Regiment } from './types'
import { unitDef } from './units'

export interface AiIntent {
  regId: number
  sig: string
  kind: OrderKind
  x: number
  y: number
  facing: number
  targetId: number | null
}

function dist(a: Regiment, b: Regiment): number {
  return Math.hypot(a.anchorX - b.anchorX, a.anchorY - b.anchorY)
}

function nearest(from: Regiment, list: Regiment[]): Regiment | null {
  let best: Regiment | null = null
  let bestD = Infinity
  for (const reg of list) {
    const d = dist(from, reg)
    if (d < bestD) {
      best = reg
      bestD = d
    }
  }
  return best
}

function standing(battle: Battle, side: Regiment['side'], type?: Regiment['type']): Regiment[] {
  return battle.regiments.filter(
    (reg) => reg.side === side && reg.aliveCount > 0 && !reg.routing && (type === undefined || reg.type === type),
  )
}

function intent(reg: Regiment, kind: OrderKind, x: number, y: number, facing: number, targetId: number | null, sig: string): AiIntent {
  return { regId: reg.id, sig, kind, x, y, facing, targetId }
}

function blockedByBrace(battle: Battle, from: Regiment, to: Regiment): boolean {
  for (const infantry of standing(battle, 0, 'infantry')) {
    if (!isBracing(infantry, unitDef('infantry'), from.anchorX, from.anchorY)) continue
    const d = distPointToSegment(
      infantry.anchorX,
      infantry.anchorY,
      from.anchorX,
      from.anchorY,
      to.anchorX,
      to.anchorY,
    )
    if (d < 10) return true
  }
  return false
}

function decide(battle: Battle, reg: Regiment): AiIntent | null {
  if (reg.side !== 1 || reg.routing || reg.aliveCount <= 0) return null
  const players = standing(battle, 0)
  if (players.length === 0) {
    return intent(reg, 'hold', reg.anchorX, reg.anchorY, reg.facing, null, 'hold')
  }

  if (reg.type === 'infantry') {
    const cavalry = standing(battle, 0, 'cavalry')
    const threat = nearest(reg, cavalry)
    if (threat && dist(reg, threat) < 45) {
      const facing = Math.atan2(threat.anchorY - reg.anchorY, threat.anchorX - reg.anchorX)
      return intent(reg, 'hold', reg.anchorX, reg.anchorY, facing, null, `hold-cav:${threat.id}`)
    }
    const ours = standing(battle, 1, 'infantry')
    const theirs = standing(battle, 0, 'infantry')
    const index = ours.findIndex((item) => item.id === reg.id)
    const foe = theirs[index] ?? theirs[0] ?? nearest(reg, players)
    if (!foe) return null
    const facing = Math.atan2(foe.anchorY - reg.anchorY, foe.anchorX - reg.anchorX)
    return intent(reg, 'attack', foe.anchorX, foe.anchorY, facing, foe.id, `attack:${foe.id}`)
  }

  if (unitDef(reg.type).missile) {
    const missile = unitDef(reg.type).missile!
    const foe = nearest(reg, players)
    if (!foe) return null
    const distance = dist(reg, foe)
    const friends = standing(battle, 1, 'infantry')
    let behindX = reg.anchorX
    let behindY = reg.anchorY
    if (friends.length > 0) {
      behindX = friends.reduce((sum, item) => sum + item.anchorX, 0) / friends.length
      behindY = friends.reduce((sum, item) => sum + item.anchorY, 0) / friends.length + (reg.type === 'musket' ? 12 : 18)
    }
    const behindD = Math.hypot(reg.anchorX - behindX, reg.anchorY - behindY)
    const facing = Math.atan2(foe.anchorY - reg.anchorY, foe.anchorX - reg.anchorX)
    if (distance < 22) {
      return intent(reg, 'attack', foe.anchorX, foe.anchorY, facing, foe.id, `kite:${foe.id}`)
    }
    if (behindD > 6 && distance > 40) {
      return intent(reg, 'move', behindX, behindY, facing, null, `follow:${reg.type}:${Math.round(behindX / 2)}:${Math.round(behindY / 2)}`)
    }
    if (distance <= missile.range) {
      return intent(reg, 'hold', reg.anchorX, reg.anchorY, facing, null, `shoot:${foe.id}`)
    }
    return intent(reg, 'move', behindX, behindY, facing, null, `follow:${reg.type}:${Math.round(behindX / 2)}:${Math.round(behindY / 2)}`)
  }

  const ranged = players.filter((other) => unitDef(other.type).missile)
  const prey = ranged.find((other) => other.type === 'archer') ?? ranged[0] ?? nearest(reg, players)
  if (!prey) return null
  if (unitDef(prey.type).missile && blockedByBrace(battle, reg, prey)) {
    const flank = standing(battle, 0, 'cavalry')[0] ?? players[players.length - 1]
    const facing = Math.atan2(flank.anchorY - reg.anchorY, flank.anchorX - reg.anchorX)
    return intent(reg, 'attack', flank.anchorX, flank.anchorY, facing, flank.id, `flank:${flank.id}`)
  }
  const facing = Math.atan2(prey.anchorY - reg.anchorY, prey.anchorX - reg.anchorX)
  return intent(reg, 'attack', prey.anchorX, prey.anchorY, facing, prey.id, `charge:${prey.id}`)
}

export function planEnemyIntents(battle: Battle): AiIntent[] {
  const intents: AiIntent[] = []
  for (const reg of battle.regiments) {
    const next = decide(battle, reg)
    if (next) intents.push(next)
  }
  return intents
}
