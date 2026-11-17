import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { battleSnapshot } from '../src/sim/diagnostics'
import { gapBetween } from '../src/sim/formation'
import { mulberry32 } from '../src/sim/math'
import { commandAttack } from '../src/sim/orders'
import { createScenario } from '../src/sim/scenarios'
import { Spatial } from '../src/sim/spatial'
import type { Battle, UnitType } from '../src/sim/types'
import { unitDef } from '../src/sim/units'

const N = Math.PI / 2, S = -Math.PI / 2
const single = { models: 1, files: 1 }
// Offsets across one 2 m grid cell: the same geometry must give the same result wherever it sits.
const offsets = Array.from({ length: 10 }, (_, i) => i * 0.2)
// Single-step checks can afford a finer sweep.
const fine = Array.from({ length: 20 }, (_, i) => i * 0.1)

describe('contact searches cover the bodies on the field, wherever they sit on the grid', () => {
  it('engages a monster and a behemoth that attack each other at every sub-cell offset', () => {
    for (const oy of offsets) {
      const b = createEmptyBattle(11)
      const a = spawn(b, 0, 'monster', 'A', 150, 100 + oy, N)
      const c = spawn(b, 1, 'behemoth', 'B', 150, 112 + oy, S)
      commandAttack(b, [a.id], c.id); commandAttack(b, [c.id], a.id)
      let contact = 0, engagedA = 0, engagedB = 0, anchorGap = 0
      for (let i = 0; i < 300 && b.winner === null; i++) {
        step(b, 0.05)
        const sa = a.soldiers[0], sc = c.soldiers[0]
        if (gapBetween(sa, unitDef('monster'), sc, unitDef('behemoth')) <= 0.35) {
          contact++
          if (a.engaged) engagedA++
          if (c.engaged) engagedB++
          anchorGap = Math.max(anchorGap, Math.hypot(a.anchorX - sa.x, a.anchorY - sa.y))
        }
      }
      expect(contact, `offset ${oy}`).toBeGreaterThan(200)
      expect(engagedA, `offset ${oy}`).toBe(contact)
      expect(engagedB, `offset ${oy}`).toBe(contact)
      // An engaged frame stays on its body instead of marching into the enemy's anchor.
      expect(anchorGap, `offset ${oy}`).toBeLessThan(0.5)
    }
  })

  it.each([['giant', 'giant'], ['behemoth', 'stoneBeast'], ['giant', 'ogre'], ['sword', 'spear']] as [UnitType, UnitType][])(
    '%s pressed against %s 0.3 m apart is engaged at every offset', (near, far) => {
      for (const oy of fine) {
        const b = createEmptyBattle(3)
        const a = spawn(b, 0, near, 'a', 150, 100 + oy, N, single)
        spawn(b, 1, far, 'c', 150, 100 + oy + unitDef(near).radius + unitDef(far).radius + 0.3, S, single)
        step(b, 0.05)
        expect(a.inContact, `offset ${oy}`).toBe(true)
        expect(a.engaged, `offset ${oy}`).toBe(true)
      }
    })

  it('sees two behemoths within weapon reach as in contact at every offset', () => {
    for (const oy of fine) {
      const b = createEmptyBattle(3)
      const a = spawn(b, 0, 'behemoth', 'a', 150, 100 + oy, N, single)
      const c = spawn(b, 1, 'behemoth', 'c', 150, 100 + oy + 3.2 + 0.95, S, single)
      step(b, 0.05)
      expect(a.inContact, `offset ${oy}`).toBe(true)
      expect(c.inContact, `offset ${oy}`).toBe(true)
    }
  })

  it('a war wagon holds fire while a giant is in reach of its rear end, at every offset', () => {
    for (const oy of fine) {
      const b = createEmptyBattle(4)
      const w = spawn(b, 0, 'warWagon', 'w', 150, 60 + oy, N, { ...single, hp: 1200 })
      const ws = w.soldiers[0]; ws.reload = 0
      spawn(b, 1, 'spear', 'target', 150, 110, S, { models: 8, files: 4 })
      // Capsule shape points sit 0.7 m from the centre; the giant is 0.3 m beyond the rear circle.
      spawn(b, 1, 'giant', 'rear', 150, ws.y - 0.7 - 1 - 1.5 - 0.3, N, single)
      const ammo = ws.ammo
      step(b, 0.05)
      expect(ws.ammo, `offset ${oy}`).toBe(ammo)
    }
  })

  it('a friendly giant beside the line of fire blocks a musket exactly when its widened body crosses the line', () => {
    const shots = (side: number) => {
      const b = createEmptyBattle(1)
      const m = spawn(b, 0, 'musket', 'm', 100, 60, N, single), s = m.soldiers[0]
      Object.assign(s, { reload: 0 })
      spawn(b, 0, 'giant', 'g', 100 + side, 80, N, single)
      const enemy = spawn(b, 1, 'spear', 'e', 100, 105, S, single)
      commandAttack(b, [m.id], enemy.id)
      step(b, 0.05)
      return unitDef('musket').missile!.ammo - s.ammo
    }
    // Blocking needs the line within radius + 0.15 = 1.65 m of the giant's centre.
    expect(shots(1.6)).toBe(0)
    expect(shots(-1.6)).toBe(0)
    expect(shots(1.75)).toBe(1)
  })

  // The movement grid is filled before anyone moves, so a rider that has already moved this step is filed
  // where it was. The spearman's search must still reach him on the step he comes within reach.
  it.each([['heavyCavalry', 40], ['heavyCavalry', 40.3], ['chariot', 40], ['chariot', 40.15]] as [UnitType, number][])(
    'a spearman notices a charging %s (from y %s) on the same step at every offset', (type, start) => {
      const noticed = (oy: number) => {
        const b = createEmptyBattle(5)
        // Spawned first, so the rider moves before the spearman looks for enemies.
        const rider = spawn(b, 0, type, 'r', 150, start + oy, N, single)
        const foot = spawn(b, 1, 'spear', 's', 150, 100 + oy, S, single)
        commandAttack(b, [rider.id], foot.id)
        for (let i = 0; i < 400; i++) { step(b, 0.05); if (foot.nearEnemy) return i }
        return -1
      }
      const first = noticed(0)
      expect(first).toBeGreaterThan(100)
      for (const oy of fine) expect(noticed(oy), `offset ${oy}`).toBe(first)
    })
})

describe('tight searches meet exactly what the full-radius searches meet', () => {
  // Reference: every wide-body search widened to its outer radius (the separation solver's old full search),
  // and the line-of-fire corridor widened to a circle around the shot.
  function fullSearch<T>(run: () => T): T {
    const wide = Spatial.prototype.queryWide, segment = Spatial.prototype.querySegment
    Spatial.prototype.queryWide = function (x, y, radius, wideRadius, out, side) { this.query(x, y, Math.max(radius, wideRadius), out, side) }
    Spatial.prototype.querySegment = function (x0, y0, x1, y1, radius, wideRadius, out, side) {
      this.query((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0) / 2 + Math.max(radius, wideRadius), out, side)
    }
    try { return run() } finally { Spatial.prototype.queryWide = wide; Spatial.prototype.querySegment = segment }
  }
  const state = (b: Battle) => JSON.stringify([battleSnapshot(b), b.rng()])
  function same(make: () => Battle, steps: number) {
    const run = () => { const b = make(); for (let i = 0; i < steps && b.winner === null; i++) step(b, 0.05); return b }
    const tight = run(), full = fullSearch(run)
    expect(state(tight)).toBe(state(full))
    return tight
  }
  // A sword just inside one 2 m cell and an enemy just inside the next, about 0.8 m apart: out of contact
  // reach (0.66 m) and filed beyond the cells the sword searches, until one of them is pushed toward the other.
  const ax = 101.215

  it('a body pushed out of the cells it searched by its own contacts still meets one filed across a cell boundary', () => {
    for (const bx of [102.002, 102.012, 102.022]) {
      const b = same(() => {
        const b = createEmptyBattle(1)
        // Spawned first, so both friendly ogres push the sword toward the enemy within its own loop.
        spawn(b, 0, 'sword', 'a', ax, 101, N, single)
        spawn(b, 0, 'ogre', 'h', ax - 0.2, 100.85, N, single)
        spawn(b, 0, 'ogre', 'h', ax - 0.2, 101.15, N, single)
        spawn(b, 1, 'sword', 'b', bx, 101, S, single)
        return b
      }, 1)
      // The pushed sword reached the enemy and shoved him back (a little: large friends push foot less than they did).
      expect(b.regiments[3].soldiers[0].x, `enemy at ${bx}`).toBeGreaterThan(bx + 0.01)
    }
  })

  it('a body meets one that was pushed toward it earlier in the same pass from across a cell boundary', () => {
    for (const bx of [102.002, 102.012, 102.022]) {
      const b = same(() => {
        const b = createEmptyBattle(1)
        // Spawned before the sword, so the ogres push their comrade toward it before the sword searches.
        spawn(b, 1, 'ogre', 'h', bx + 0.2, 100.85, S, single)
        spawn(b, 1, 'ogre', 'h', bx + 0.2, 101.15, S, single)
        spawn(b, 0, 'sword', 'a', ax, 101, N, single)
        spawn(b, 1, 'sword', 'b', bx, 101, S, single)
        return b
      }, 1)
      // The comrade was pushed into the sword, which gave way.
      expect(b.regiments[2].soldiers[0].x, `enemy at ${bx}`).toBeLessThan(ax - 0.02)
    }
  })

  // With seed 42 the cavalry charge pushes a body out of the cells it searched into another one (first at step 142).
  it.each(['roster', 'fire', 'chariot', 'cavalry'] as const)('the %s scenario plays out the same with full searches', name => {
    same(() => {
      const b = createScenario(name, 42)
      if (name === 'roster') {
        for (const r of b.regiments.filter(r => r.side === 0)) commandAttack(b, [r.id], b.regiments.find(e => e.side === 1 && e.type === r.type)!.id)
      }
      return b
    }, 160)
  }, 20000)
})

describe('Spatial wide-body queries', () => {
  // Random entries, some wide and some with several points (like capsules), on both armies.
  function filled(seed: number) {
    const rng = mulberry32(seed), grid = new Spatial(2, 4), points = new Map<number, { x: number; y: number }[]>()
    const wide = new Set<number>(), side = new Map<number, 0 | 1>()
    for (let id = 0; id < 400; id++) {
      const x = 40 + rng() * 30, y = 40 + rng() * 30, isWide = rng() < 0.15, army = (rng() < 0.5 ? 0 : 1) as 0 | 1
      const list = isWide && rng() < 0.5 ? [-0.7, 0, 0.7].map(d => ({ x: x + d, y: y + d * 0.5 })) : [{ x, y }]
      for (const p of list) grid.insert(p.x, p.y, id, army, isWide ? 1.5 : 0.32, isWide)
      points.set(id, list); side.set(id, army)
      if (isWide) wide.add(id)
    }
    return { grid, points, wide, side, rng }
  }

  it('returns query(wideRadius) without the narrow entries outside the narrow search, in the same order', () => {
    const { grid, wide, side, rng } = filled(7)
    for (let n = 0; n < 200; n++) {
      const x = 38 + rng() * 34, y = 38 + rng() * 34, radius = rng() * 2, wideRadius = radius + rng() * 3
      for (const army of [undefined, 0, 1] as const) {
        const all: number[] = [], near: number[] = [], got: number[] = []
        grid.query(x, y, wideRadius, all, army); grid.query(x, y, radius, near, army)
        grid.queryWide(x, y, radius, wideRadius, got, army)
        const inNear = new Set(near)
        expect(got).toEqual(all.filter(id => wide.has(id) || inNear.has(id)))
        if (army !== undefined) expect(got.every(id => side.get(id) === army)).toBe(true)
      }
    }
  })

  it('finds every entry within the corridor radius of a segment', () => {
    const { grid, points, wide, side, rng } = filled(9)
    const distance = (p: { x: number; y: number }, x0: number, y0: number, x1: number, y1: number) => {
      const dx = x1 - x0, dy = y1 - y0, length2 = dx * dx + dy * dy
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / length2)) : 0
      return Math.hypot(p.x - x0 - dx * t, p.y - y0 - dy * t)
    }
    const segments: number[][] = [[50, 50, 50, 50], [35, 55, 75, 55], [55, 35, 55, 75], [-10, -10, 60, 60]]
    for (let n = 0; n < 200; n++) segments.push([35 + rng() * 40, 35 + rng() * 40, 35 + rng() * 40, 35 + rng() * 40])
    for (const [x0, y0, x1, y1] of segments) {
      const radius = 0.47, wideRadius = 1.65
      for (const army of [undefined, 0, 1] as const) {
        const got: number[] = []
        grid.querySegment(x0, y0, x1, y1, radius, wideRadius, got, army)
        expect(new Set(got).size).toBe(got.length)
        const found = new Set(got)
        for (const [id, list] of points) {
          if (army !== undefined && side.get(id) !== army) { expect(found.has(id)).toBe(false); continue }
          const reach = wide.has(id) ? wideRadius : radius
          if (list.some(p => distance(p, x0, y0, x1, y1) <= reach)) expect(found.has(id), `${id} near ${[x0, y0, x1, y1]}`).toBe(true)
        }
      }
    }
  })

  it('says how far a point may move while the cells of a search still hold every entry around it', () => {
    const { grid, points, rng } = filled(11)
    let held = 0, lost = 0
    for (let n = 0; n < 400; n++) {
      const x0 = 40 + rng() * 30, y0 = 40 + rng() * 30, radius = 0.3 + rng() * 1.5
      const x = x0 + (rng() - 0.5) * 2, y = y0 + (rng() - 0.5) * 2, room = grid.room(x0, y0, radius)
      expect(room).toBeGreaterThanOrEqual(0)
      if (!(Math.abs(x - x0) < room && Math.abs(y - y0) < room)) { lost++; continue }
      held++
      const found: number[] = []
      grid.query(x0, y0, radius, found)
      const searched = new Set(found)
      for (const [id, list] of points) {
        if (list.some(p => Math.hypot(p.x - x, p.y - y) < radius)) expect(searched.has(id), `${id} near ${[x0, y0, radius, x, y]}`).toBe(true)
      }
    }
    expect(held).toBeGreaterThan(30)
    expect(lost).toBeGreaterThan(30)
    // The search's own cells: 101.215 + 0.66 leaves 0.125 m before the cell edge at x = 102.
    expect(grid.room(101.215, 101, 0.66)).toBeCloseTo(0.125, 9)
    // The border cells also hold everything beyond the map edge, so far off the map only the inner edge limits.
    expect(grid.room(-40, -40, 1)).toBeCloseTo(25, 9)
  })

  it('records the largest narrow and wide radius per army and forgets them on clear', () => {
    const grid = new Spatial()
    grid.insert(10, 10, 1, 0, 0.32); grid.insert(10, 10, 2, 0, 1.6, true); grid.insert(10, 10, 3, 1, 0.45)
    grid.insert(10, 10, 4, undefined, 9, true)
    expect(grid.reach[0]).toMatchObject({ narrow: 0.32, wide: 1.6 })
    expect(grid.reach[1]).toMatchObject({ narrow: 0.45, wide: 0 })
    grid.reach[0].narrowDrift = 0.4
    grid.clear()
    expect(grid.reach).toEqual([{ narrow: 0, wide: 0, narrowDrift: 0, wideDrift: 0 }, { narrow: 0, wide: 0, narrowDrift: 0, wideDrift: 0 }])
    const out: number[] = []
    grid.queryWide(10, 10, 0, 5, out); expect(out).toEqual([])
  })
})
