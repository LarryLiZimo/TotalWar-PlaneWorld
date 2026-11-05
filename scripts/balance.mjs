import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { createEmptyBattle, spawn, step } = await server.ssrLoadModule('/src/sim/battle.ts')
  const { commandAttack } = await server.ssrLoadModule('/src/sim/orders.ts')
  const { battleErrors } = await server.ssrLoadModule('/src/sim/diagnostics.ts')
  const { UNITS } = await server.ssrLoadModule('/src/sim/units.ts')
  const { scaledFormation } = await server.ssrLoadModule('/src/sim/armies.ts')
  const pairings = [
    ['heavyCavalry','sword'], ['shieldCavalry','sword'],
    ['heavyCavalry','spear'], ['shieldCavalry','spear'],
    ['ogre','halberd'], ['armoredOgre','halberd'], ['monster','halberd'], ['behemoth','halberd'],
  ]
  const results = []
  for (const [attacker, defender] of pairings) {
    for (const seed of [1,7,42]) {
      const b = createEmptyBattle(seed)
      const a = spawn(b,0,attacker,UNITS[attacker].name,150,70,Math.PI/2,scaledFormation(attacker,4))
      const d = spawn(b,1,defender,UNITS[defender].name,150,115,-Math.PI/2,scaledFormation(defender,4))
      commandAttack(b,[a.id],d.id)
      for (let i=0;i<900 && b.winner===null;i++) step(b,0.05)
      const errors = battleErrors(b)
      if (errors.length) throw new Error(`${attacker}/${defender}/${seed}: ${errors.join('; ')}`)
      const health = reg => Number((reg.soldiers.reduce((sum,s)=>sum+(s.alive?s.hp:0),0)/(reg.initial*reg.modelHp)).toFixed(4))
      results.push({ attacker, defender, seed, seconds:Number(b.time.toFixed(2)), winner:b.winner===0?'attacker':b.winner===1?'defender':b.winner===-1?'draw':'timeout', attackerHealth:health(a), defenderHealth:health(d), attackerAlive:a.aliveCount, defenderAlive:d.aliveCount })
    }
    console.log(`${attacker} vs ${defender}: ${JSON.stringify(results.slice(-3).map(r=>({seed:r.seed,winner:r.winner,attackerHealth:r.attackerHealth,defenderHealth:r.defenderHealth})))}`)
  }
  await mkdir('reports',{recursive:true})
  await writeFile('reports/balance.json',JSON.stringify({date:new Date().toISOString(),method:'Attacker charges a stationary defender frontally, 45 m approach, 45 s limit, seeds 1/7/42. Full default regiments; not cost-normalized; timeout is not a draw.',results},null,2)+'\n')
} finally { await server.close() }
