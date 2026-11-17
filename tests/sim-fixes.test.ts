import { describe, expect, it } from 'vitest'
import { createEmptyBattle, routJitter, spawn, step } from '../src/sim/battle'
import { battleErrors } from '../src/sim/diagnostics'
import { slotOf } from '../src/sim/formation'
import { MECHANICS } from '../src/sim/mechanics'
import { advanceMorale } from '../src/sim/morale'
import { commandAttack, commandMove } from '../src/sim/orders'
import { MAP_HEIGHT, MAP_WIDTH, SIM_DT } from '../src/sim/types'
import type { Regiment } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

const NORTH = Math.PI / 2, SOUTH = -Math.PI / 2

describe('chariot moves near the map edge', () => {
  it.each(['chariot', 'heavyChariot', 'warWagon'] as const)('%s ordered beside the edge forms its line inside the map and stops', type => {
    const b = createEmptyBattle(7), r = spawn(b, 0, type, 'carts', 100, 40, 0)
    spawn(b, 1, 'general', 'far', 280, 210, Math.PI)
    commandMove(b, [r.id], 200, 3, null)
    for (let i = 0; i < 60 / SIM_DT && r.order === 'move'; i++) step(b, SIM_DT)
    expect(r.order).toBe('hold')
    expect(r.destY).toBeGreaterThan(3)
    for (let i = 0; i < 2 / SIM_DT; i++) step(b, SIM_DT)
    const d = UNITS[type]
    for (const s of r.soldiers) {
      const slot = slotOf(r, d, s.file, s.rank, s.centerIndex)
      expect(Math.hypot(slot.x - s.x, slot.y - s.y)).toBeLessThan(0.3)
      expect(slot.y).toBeGreaterThan(d.radius)
      expect(slot.y).toBeLessThan(MAP_HEIGHT - d.radius)
      expect(slot.x).toBeLessThan(MAP_WIDTH - d.radius)
    }
    expect(r.bodySpeed).toBeLessThan(0.1)
    expect(r.fatigue).toBe('fresh')
    expect(battleErrors(b)).toEqual([])
  }, 30000)
})

describe('morale timers count whole steps', () => {
  it('routs on the 50th consecutive negative step, which is the documented 2.5 s', () => {
    const b = createEmptyBattle(1), r = spawn(b, 0, 'sword', 'r', 100, 100, NORTH)
    const steps = Math.round(MECHANICS.routDelay / SIM_DT)
    expect(steps).toBe(50)
    for (let i = 0; i < steps - 1; i++) expect(advanceMorale(r, -1, true, false, SIM_DT)).toBeNull()
    expect(r.routing).toBe(false)
    expect(advanceMorale(r, -1, true, false, SIM_DT)).toBe('routed')
    expect(r.routing).toBe(true)
  })

  it('rallies after exactly the 10 s minimum rout and then 8 safe seconds', () => {
    const b = createEmptyBattle(1), r = spawn(b, 0, 'sword', 'r', 100, 100, NORTH)
    for (let i = 0; i < 50; i++) advanceMorale(r, -1, true, false, SIM_DT)
    expect(r.routing).toBe(true)
    // RULES 七.3: at least 10 s of rout, then 8 s in a row of safety, which is 200 + 160 routing steps.
    const steps = Math.round(MECHANICS.minimumRout / SIM_DT) + Math.round(MECHANICS.rallyDelay / SIM_DT)
    expect(steps).toBe(360)
    for (let i = 0; i < steps - 1; i++) expect(advanceMorale(r, 40, false, false, SIM_DT)).toBeNull()
    expect(r.routing).toBe(true)
    expect(advanceMorale(r, 40, false, false, SIM_DT)).toBe('rallied')
    expect(r.routing).toBe(false)
  })
})

describe('ordinary breaks take precedence over terror', () => {
  // A terror source's damaging blow in a given step: its id in the victim's hit list survives the start-of-step reset.
  const blowIn = (victim: Regiment, sourceId: number) => {
    victim.terrorHits = new Proxy([sourceId], { set: (t, k, v) => k === 'length' ? true : Reflect.set(t, k, v) })
  }
  it.each([[49, true], [50, false]] as const)('a terror blow on negative step %i spends the source cooldown: %s', (at, terror) => {
    const original = UNITS.sword
    UNITS.sword = { ...original, leadership: -5 }
    try {
      const b = createEmptyBattle(1), victim = spawn(b, 0, 'sword', 'victim', 100, 60, NORTH)
      // Far beyond the fear aura, so only the blow itself can count.
      const source = spawn(b, 1, 'monster', 'terror', 250, 200, SOUTH)
      spawn(b, 0, 'general', 'reserve', 20, 200, NORTH)
      for (let i = 1; i < at; i++) step(b, SIM_DT)
      expect(victim.routing).toBe(false)
      expect(victim.leadership).toBeLessThan(0)
      expect(victim.leadership).toBeGreaterThan(MECHANICS.instantRoutLeadership)
      blowIn(victim, source.id)
      step(b, SIM_DT)
      victim.terrorHits = []
      expect(victim.routing).toBe(true)
      expect(source.terrorCooldown).toBe(terror ? MECHANICS.terrorCooldown : 0)
      expect(b.notices.map(n => n.text)).toEqual([terror ? `${victim.name}被${source.name}惊骇` : `${victim.name}溃逃`])
    } finally {
      UNITS.sword = original
    }
  })
})

describe('swing retarget', () => {
  it.each(['knocked down', 'walked off'] as const)('a swing whose target is %s during the windup: only a knocked-down target passes the blow to another standing foe', fate => {
    const b = createEmptyBattle(3); b.rng = () => 0.1
    const cav = UNITS.heavyCavalry, foot = UNITS.sword
    const rider = spawn(b, 0, 'heavyCavalry', 'rider', 100, 100, 0, { models: 1, files: 1 })
    // Both foes stand in the rider's attack zone, the second one off to the side and not screened by the first.
    const near = spawn(b, 1, 'sword', 'near', 100 + cav.radius + foot.radius + 0.3, 100, Math.PI, { models: 1, files: 1 })
    const other = spawn(b, 1, 'sword', 'other', 101.2, 100.7, Math.PI, { models: 1, files: 1 })
    for (const r of [near, other]) r.soldiers[0].meleeCd = 100
    const s = rider.soldiers[0], first = near.soldiers[0], second = other.soldiers[0]
    s.meleeCd = 0
    step(b, SIM_DT)
    expect(s.swing?.targetId).toBe(first.id)
    if (fate === 'knocked down') first.down = 2
    else { first.x += 3; first.prevX += 3 }
    for (let i = 0; i < 20 && s.swing; i++) step(b, SIM_DT)
    expect(s.swing).toBeNull()
    expect(first.hp).toBe(foot.hp)
    if (fate === 'knocked down') { expect(second.hp).toBeLessThan(foot.hp); expect(second.reactTo).toBe(s.id) }
    else expect(second.hp).toBe(foot.hp)
  })
})

describe('rout individuality', () => {
  it('neighbouring soldier ids get independent rout pace', () => {
    const b = createEmptyBattle(20261104), r = spawn(b, 0, 'sword', 'r', 150, 60, NORTH)
    for (const routCount of [1, 2, 3]) {
      const pace = r.soldiers.map(s => routJitter(b.seed, s.id, routCount).pace)
      const mean = pace.reduce((a, v) => a + v, 0) / pace.length
      let num = 0, den = 0
      for (let i = 0; i < pace.length; i++) {
        den += (pace[i] - mean) ** 2
        if (i > 0) num += (pace[i] - mean) * (pace[i - 1] - mean)
      }
      expect(Math.abs(num / den)).toBeLessThan(0.2)
      const close = pace.slice(1).filter((v, i) => Math.abs(v - pace[i]) < 0.03).length
      expect(close).toBeLessThan(pace.length * 0.15)
      expect(Math.min(...pace)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...pace)).toBeLessThanOrEqual(1)
    }
    expect(routJitter(5, 17, 2)).toEqual(routJitter(5, 17, 2))
    expect(routJitter(5, 17, 2)).not.toEqual(routJitter(5, 17, 3))
  })
})
