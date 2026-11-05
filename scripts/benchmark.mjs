import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { createScenario } = await server.ssrLoadModule('/src/sim/scenarios.ts')
  const { step, setAiEnabled } = await server.ssrLoadModule('/src/sim/battle.ts')
  const { battleErrors } = await server.ssrLoadModule('/src/sim/diagnostics.ts')
  const report = { date: new Date().toISOString(), node: process.version, scenarios: [] }
  for (const scenario of ['custom','demo', 'cavalry', 'chariot', 'roster', 'collision', 'hill', 'cartturn', 'cavturn', 'reform', 'cartescape', 'reserves','friendlypass']) {
    const b = createScenario(scenario, 42)
    if (scenario === 'demo' || scenario === 'roster') setAiEnabled(b, true)
    const times = []
    for (let i = 0; i < 600 && b.winner === null; i++) {
      const start = performance.now()
      step(b, 0.05)
      times.push(performance.now() - start)
      if (i % 20 === 0) {
        const errors = battleErrors(b)
        if (errors.length) throw new Error(`${scenario} ${b.time}: ${errors.join('; ')}`)
      }
    }
    const sorted = [...times].sort((a, b) => a - b)
    const mean = times.reduce((a, b) => a + b, 0) / times.length
    const result = { scenario, seed: 42, soldiers: b.regiments.reduce((sum,r) => sum + r.initial, 0), steps: times.length, simulatedSeconds: Number(b.time.toFixed(2)), meanMs: Number(mean.toFixed(2)), p95Ms: Number(sorted[Math.floor(sorted.length * .95)].toFixed(2)), maxMs: Number(sorted.at(-1).toFixed(2)), realtimeHeadroom: Number((50 / mean).toFixed(2)), errors: battleErrors(b) }
    report.scenarios.push(result)
    console.log(JSON.stringify(result))
  }
  await mkdir('reports', { recursive: true })
  await writeFile('reports/benchmark.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Saved reports/benchmark.json (headless simulation; browser rendering is not included).')
} finally {
  await server.close()
}
