import { describe, expect, it } from 'vitest'
import { scaledFormation } from '../src/sim/armies'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { applyCommand } from '../src/sim/commands'
import { advanceMorale } from '../src/sim/morale'
import { commandAttack, commandGroupFront, commandHold, commandMove, commandPlace } from '../src/sim/orders'
import type { Battle, Regiment, UnitType } from '../src/sim/types'

const NORTH = Math.PI / 2, SOUTH = -Math.PI / 2
const tick = (b: Battle, seconds: number, each?: () => void) => { for (let i = 0; i < Math.round(seconds / 0.05); i++) { step(b, 0.05); each?.() } }
const block = (b: Battle, side: 0 | 1, type: UnitType, x: number, y: number, facing: number): Regiment =>
  spawn(b, side, type, `${side}-${type}-${x}`, x, y, facing, scaledFormation(type, 2))
/** Without an enemy on the field the battle is decided at once and nothing moves. */
const idleFoe = (b: Battle) => block(b, 1, 'sword', 180, 210, SOUTH)

describe('Shift-queued orders', () => {
  it('marches through queued waypoints one after another and ends holding the last', () => {
    const b = createEmptyBattle(1)
    const ours = block(b, 0, 'sword', 60, 40, NORTH)
    idleFoe(b)
    commandMove(b, [ours.id], 60, 70, null)
    commandMove(b, [ours.id], 100, 70, null, true)
    commandMove(b, [ours.id], 100, 40, null, true)
    expect(ours.order).toBe('move')
    expect(ours.queue.map(q => q.kind === 'move' ? [q.x, q.y] : null)).toEqual([[100, 70], [100, 40]])
    const visits: number[] = []
    tick(b, 60, () => {
      const near = [[60, 70], [100, 70], [100, 40]].findIndex(([x, y]) => Math.hypot(ours.anchorX - x, ours.anchorY - y) < 1)
      if (near >= 0 && visits.at(-1) !== near) visits.push(near)
    })
    expect(visits).toEqual([0, 1, 2])
    expect(ours.order).toBe('hold')
    expect(ours.queue).toEqual([])
    expect(Math.hypot(ours.anchorX - 100, ours.anchorY - 40)).toBeLessThan(0.1)
  })

  it('starts a queued order at once on an idle regiment, and an unqueued order replaces the queue', () => {
    const b = createEmptyBattle(2)
    const ours = block(b, 0, 'sword', 60, 40, NORTH)
    commandMove(b, [ours.id], 60, 80, null, true)
    expect(ours.order).toBe('move')
    expect(ours.queue).toEqual([])
    commandMove(b, [ours.id], 120, 80, null, true)
    expect(ours.queue).toHaveLength(1)
    commandMove(b, [ours.id], 60, 60, null)
    expect(ours.queue).toEqual([])
    commandMove(b, [ours.id], 120, 80, null, true)
    commandHold(b, [ours.id])
    expect(ours.queue).toEqual([])
  })

  it('lays queued moves of a group out from where each regiment\'s plan ends', () => {
    const b = createEmptyBattle(3)
    const a = block(b, 0, 'sword', 60, 40, NORTH), c = block(b, 0, 'sword', 100, 40, NORTH)
    commandMove(b, [a.id, c.id], 80, 80, null)
    commandMove(b, [a.id, c.id], 80, 120, null, true)
    const at = (r: Regiment) => r.queue[0].kind === 'move' ? [r.queue[0].x, r.queue[0].y] : []
    expect(at(a)).toEqual([60, 120])
    expect(at(c)).toEqual([100, 120])
  })

  it('attacks a queued target after the march, then moves on once it breaks', () => {
    const b = createEmptyBattle(4)
    const ours = block(b, 0, 'sword', 100, 40, NORTH), foe = block(b, 1, 'sword', 100, 110, SOUTH)
    commandMove(b, [ours.id], 100, 60, null)
    commandAttack(b, [ours.id], foe.id, true)
    commandMove(b, [ours.id], 40, 60, null, true)
    tick(b, 12)
    expect(ours.order).toBe('attack')
    expect(ours.targetId).toBe(foe.id)
    expect(ours.queue).toHaveLength(1)
    advanceMorale(foe, -100, true, false, 0.05)
    expect(foe.routing).toBe(true)
    step(b, 0.05)
    expect(ours.order).toBe('move')
    expect([ours.destX, ours.destY]).toEqual([40, 60])
  })

  it('drops the queue when an attack halts the march or the regiment routs', () => {
    const b = createEmptyBattle(9)
    const ours = block(b, 0, 'sword', 60, 60, 0), foe = block(b, 1, 'sword', 150, 85, SOUTH)
    commandMove(b, [ours.id], 240, 60, 0)
    commandMove(b, [ours.id], 240, 120, null, true)
    commandAttack(b, [foe.id], ours.id)
    let halted = false
    tick(b, 45, () => { halted ||= ours.order === 'hold' && ours.inContact })
    expect(halted).toBe(true)
    expect(ours.queue).toEqual([])

    const c = createEmptyBattle(10)
    const other = block(c, 0, 'sword', 60, 60, NORTH)
    commandMove(c, [other.id], 60, 90, null)
    commandMove(c, [other.id], 90, 90, null, true)
    other.soldiers.forEach(s => { s.hp *= 0.01 })
    block(c, 1, 'monster' as UnitType, 60, 140, SOUTH)
    for (let i = 0; i < 400 && !other.routing; i++) step(c, 0.05)
    expect(other.routing).toBe(true)
    expect(other.queue).toEqual([])
  })

  it('queues fronts with their width and travels as commands to the worker', () => {
    const b = createEmptyBattle(5)
    const a = block(b, 0, 'sword', 60, 40, NORTH), c = block(b, 0, 'sword', 100, 40, NORTH)
    commandMove(b, [a.id, c.id], 80, 60, null)
    commandGroupFront(b, [a.id, c.id], 40, 120, 130, 120, true)
    expect(a.queue[0]).toMatchObject({ kind: 'move', facing: expect.any(Number), files: expect.any(Number) })
    const sent: unknown[] = []
    b.sendCommand = command => sent.push(command)
    commandMove(b, [a.id], 10, 10, null, true)
    commandPlace(b, [{ id: a.id, x: 20, y: 20, facing: 0 }], true)
    expect(sent).toEqual([{ kind: 'move', ids: [a.id], x: 10, y: 10, facing: null, queue: true }, { kind: 'place', places: [{ id: a.id, x: 20, y: 20, facing: 0 }], queue: true }])
    b.sendCommand = undefined
    applyCommand(b, sent[1] as Parameters<typeof applyCommand>[1])
    expect(a.queue.at(-1)).toEqual({ kind: 'move', x: 20, y: 20, facing: 0 })
  })
})

describe('translate / rotate placement', () => {
  it('marches each regiment to its own spot and facing, keeping its width', () => {
    const b = createEmptyBattle(6)
    const a = block(b, 0, 'sword', 60, 40, NORTH)
    idleFoe(b)
    const files = a.files
    commandPlace(b, [{ id: a.id, x: 80, y: 50, facing: 0 }])
    expect([a.order, a.destX, a.destY, a.destFacing]).toEqual(['move', 80, 50, 0])
    tick(b, 30)
    expect(a.order).toBe('hold')
    expect(Math.hypot(a.anchorX - 80, a.anchorY - 50)).toBeLessThan(0.1)
    expect(a.files).toBe(files)
  })
})
