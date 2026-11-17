import { build } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Time one plain bundle like the production Worker. Vite SSR modules route
// every imported binding through getter objects and run about 1.4x slower.
const outDir = resolve('node_modules/.cache/sim-bench/benchmark'), entry = '\0sim-bench-entry'
await build({ configFile: false, root: process.cwd(), logLevel: 'warn',
  plugins: [{ name: 'sim-bench-entry', resolveId: id => id === 'sim-bench-entry' ? entry : null,
    load: id => id === entry ? "export * from '/src/sim/index.ts'; export { createArmyBattle } from '/src/sim/armies.ts'" : null }],
  build: { ssr: true, outDir, emptyOutDir: true, minify: false, rollupOptions: { input: 'sim-bench-entry', output: { entryFileNames: 'sim.mjs' } } } })
const { createScenario, createArmyBattle, step, setAiEnabled, battleErrors } = await import(pathToFileURL(resolve(outDir, 'sim.mjs')).href)
const report = { date: new Date().toISOString(), node: process.version, code: 'bundled sim (same plain bindings as the Worker build)', scenarios: [] }
// Fixed scenarios, plus three 4x preset battles that together field all 21 Empire-template units.
const scenarios = ['custom','demo', 'cavalry', 'chariot', 'roster', 'collision', 'cartturn', 'cavturn', 'reform', 'cartescape', 'reserves','friendlypass']
  .map(name => ({ name, create: () => { const b = createScenario(name, 42); if (name === 'demo' || name === 'roster') setAiEnabled(b, true); return b } }))
  .concat([['warTrain', 'monstrousGuard'], ['stateTroops', 'fanatics'], ['blackpowder', 'knightly']]
    .map(([player, enemy]) => ({ name: `${player}-${enemy}`, create: () => createArmyBattle({ player, enemy, scale: 4 }, 42) })))
for (const { name: scenario, create } of scenarios) {
  const b = create()
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
