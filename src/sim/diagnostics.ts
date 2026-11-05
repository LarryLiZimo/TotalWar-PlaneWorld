import type { Battle } from './types'
import { unitDef } from './units'

/** Pure JSON: seed + scenario + commands can reproduce a failing run. */
export function battleSnapshot(battle: Battle) {
  return {
    seed: battle.seed, time: battle.time, winner: battle.winner, terrain: battle.terrain,
    regiments: battle.regiments.map(r => ({
      id: r.id, side: r.side, type: r.type, order: r.order, target: r.targetId,
      modelHp:r.modelHp,
      anchor: [r.anchorX, r.anchorY, r.facing], destination: [r.destX, r.destY, r.destFacing, r.destFiles],
      alive: r.aliveCount, escaped:r.soldiers.filter(s=>s.escaped).length, leadership: r.leadership, routing: r.routing, engaged: r.engaged,
      retargeting:r.retargeting, attackCommitted:r.attackCommitted,
      moraleState:r.moraleState, shattered:r.shattered, moraleFactors:r.moraleFactors, fatigue:r.fatigue, exertion:r.exertion,
      terrorCooldown:r.terrorCooldown, terrorHits:[...r.terrorHits],
      behavior:{run:r.run,fireAtWill:r.fireAtWill,skirmish:r.skirmish,skirmishing:r.skirmishing},
      soldiers: r.soldiers.map(s => ({ id: s.id, x: s.x, y: s.y, facing: s.facing, hp: s.hp, alive: s.alive, escaped:s.escaped, ammo: s.ammo, down: s.down, chargeLeft: s.chargeLeft, wounded:s.wounded, swing:s.swing,collisionCd:s.collisionCd,plowLeft:s.plowLeft,plowX:s.plowX,plowY:s.plowY,pushVx:s.pushVx,pushVy:s.pushVy,blockedTime:s.blockedTime,bypass:s.bypass?{...s.bypass}:null,cartPath:s.cartPath?{...s.cartPath}:null })),
    })),
    projectiles: battle.projectiles.map(p => ({ ...p })),
  }
}

export function battleErrors(battle: Battle): string[] {
  const errors: string[] = []
  for (const r of battle.regiments) {
    const def = unitDef(r.type)
    if(!Number.isFinite(r.modelHp)||r.modelHp<=0) errors.push(`队伍 ${r.id} 最大生命非法`)
    if (![r.anchorX, r.anchorY, r.facing, r.leadership,r.exertion,r.negativeTime,r.routeTime,r.terrorCooldown].every(Number.isFinite)) errors.push(`队伍 ${r.id} 数值非有限`)
    if (r.aliveCount !== r.soldiers.filter(s => s.alive).length) errors.push(`队伍 ${r.id} 人数不一致`)
    for (const s of r.soldiers) {
      if (![s.x, s.y, s.hp, s.facing, s.vx, s.vy, s.speed,s.collisionCd,s.braceTime,s.plowLeft,s.plowX,s.plowY,s.pushVx,s.pushVy,s.blockedTime].every(Number.isFinite)) errors.push(`士兵 ${s.id} 数值非有限`)
      if (s.hp < 0 || s.hp > r.modelHp || (s.alive && s.hp <= 0)) errors.push(`士兵 ${s.id} 生命非法`)
      if (s.escaped && (s.alive || s.hp<=0 || s.deathTime>=0)) errors.push(`士兵 ${s.id} 逃离状态非法`)
      if (s.ammo < 0 || s.ammo > (def.missile?.ammo ?? 0)) errors.push(`士兵 ${s.id} 弹药非法`)
    }
  }
  for (const p of battle.projectiles) {
    if (![p.x,p.y,p.z,p.vz,p.gravity,p.penetrationLeft].every(Number.isFinite)) errors.push('弹丸数值非有限')
  }
  return errors
}
