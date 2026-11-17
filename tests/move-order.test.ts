import { describe, expect, it } from 'vitest'
import { scaledFormation } from '../src/sim/armies'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { battleErrors } from '../src/sim/diagnostics'
import { slotOf } from '../src/sim/formation'
import { commandAttack, commandBehavior, commandFront, commandGroupFront, commandHold, commandMove } from '../src/sim/orders'
import { createScenario } from '../src/sim/scenarios'
import { SIM_DT } from '../src/sim/types'
import type { Battle, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'

const NORTH = Math.PI / 2, SOUTH = -Math.PI / 2
const tick = (b: Battle, seconds: number, each?: () => void) => { for (let i = 0; i < Math.round(seconds / 0.05); i++) { step(b, 0.05); each?.() } }
const lost = (r: Regiment) => r.soldiers.reduce((sum, s) => sum + r.modelHp - (s.alive ? s.hp : 0), 0)
const swingsStarted = (r: Regiment) => r.soldiers.filter(s => s.swing && Math.abs(s.swing.left - UNITS[r.type].attack.windup) < 1e-9).length
function block(b: Battle, side: 0 | 1, type: UnitType, x: number, y: number, facing: number) {
  return spawn(b, side, type, `${side}-${type}-${x}`, x, y, facing, scaledFormation(type, 2))
}
function worstSlot(r: Regiment) {
  const d = UNITS[r.type]
  return Math.max(...r.soldiers.filter(s => s.alive).map(s => { const p = slotOf(r, d, s.file, s.rank, s.centerIndex); return Math.hypot(p.x - s.x, p.y - s.y) }))
}

describe('a move order ends on arrival', () => {
  it.each(['move', 'front', 'groupFront'] as const)('a regiment placed by %s holds its destination and fights back when attacked', mode => {
    const b = createEmptyBattle(4)
    const ours = block(b, 0, 'sword', 150, 60, NORTH), other = block(b, 0, 'sword', 100, 60, NORTH)
    const foe = block(b, 1, 'sword', 150, 110, SOUTH)
    if (mode === 'move') commandMove(b, [ours.id], 150, 66, null)
    if (mode === 'front') commandFront(b, ours.id, 140, 66, 160, 66)
    if (mode === 'groupFront') commandGroupFront(b, [ours.id, other.id], 110, 66, 190, 66)
    expect(ours.order).toBe('move')
    const dest = [ours.destX, ours.destY, ours.destFacing, ours.destFiles]
    tick(b, 15)
    // Idle as in Warhammer III: the destination position, facing and width are kept.
    expect(ours.order).toBe('hold')
    expect([ours.destX, ours.destY, ours.destFacing, ours.destFiles]).toEqual(dest)
    expect(worstSlot(ours)).toBeLessThan(0.3)
    commandAttack(b, [foe.id], ours.id)
    let swings = 0
    // The enemy runs up and breaks into its charge only for the last strides, so it is some 12 s before the lines meet.
    tick(b, 38, () => { swings += swingsStarted(ours) })
    // The front rank does the fighting: about twelve men swinging for the last 18 s or so.
    expect(swings).toBeGreaterThan(30)
    expect(lost(foe)).toBeGreaterThan(50)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it('a regiment weaving through allied files keeps its move until every man is through and in his slot', () => {
    const b = createEmptyBattle(84), moving = spawn(b, 0, 'sword', 'moving', 100, 95, NORTH)
    spawn(b, 0, 'sword', 'standing', 100, 110, NORTH)
    spawn(b, 1, 'general', 'distant', 280, 210, 0)
    commandMove(b, [moving.id], 100, 130, null)
    let switched: { through: number; slot: number } | null = null
    tick(b, 28, () => {
      if (!switched && moving.order === 'hold') switched = { through: moving.soldiers.filter(s => s.y > 117).length, slot: worstSlot(moving) }
    })
    expect(switched).toEqual({ through: 80, slot: expect.any(Number) })
    expect(switched!.slot).toBeLessThan(0.3)
  }, 30000)

  it('a chariot looping round to reach its spot keeps its move until it has stopped there, then stands still', () => {
    const b = createEmptyBattle(86), r = spawn(b, 0, 'chariot', 'cart', 100, 100, 0, { models: 1, files: 1 }), s = r.soldiers[0]
    spawn(b, 1, 'general', 'distant', 280, 210, 0)
    commandMove(b, [r.id], 98, 100, null)
    let turned = 0, at: number | null = null
    for (let i = 0; i < 240 && at === null; i++) {
      step(b, 0.05)
      turned += Math.abs(s.omega) * 0.05
      if (r.order === 'hold') at = i
    }
    expect(at).not.toBeNull()
    // The U-turn loop was driven on the move order; only then does the cart count as arrived.
    expect(turned).toBeGreaterThan(3)
    expect(Math.hypot(s.x - 98, s.y - 100)).toBeLessThan(0.3)
    const x = s.x, y = s.y
    let path = 0
    tick(b, 10, () => { path += Math.hypot(s.vx, s.vy) * 0.05 })
    expect(path).toBeLessThan(0.05)
    expect(Math.hypot(s.x - x, s.y - y)).toBeLessThan(0.05)
  })

  it('the mixed passing scene switches foot and carts to hold only once they stand in their slots', () => {
    const b = createScenario('friendlypass', 42), foot = b.regiments[1], carts = b.regiments[3]
    const seen = new Map<Regiment, number>()
    tick(b, 30, () => {
      for (const r of [foot, carts]) if (r.order === 'hold' && !seen.has(r)) seen.set(r, Math.max(worstSlot(r), ...r.soldiers.map(s => Math.hypot(s.vx, s.vy) > 0.1 ? 9 : 0)))
    })
    expect(seen.get(foot)).toBeLessThan(0.3)
    expect(seen.get(carts)).toBeLessThan(0.3)
    expect(foot.soldiers.filter(s => s.y > 140).length).toBe(80)
    expect(carts.soldiers.filter(s => s.y > 140).length).toBe(4)
  }, 30000)
})

describe('an attack cancels a move', () => {
  it('a column attacked on the march stops where it stands and fights back', () => {
    const b = createEmptyBattle(9)
    const ours = block(b, 0, 'sword', 60, 60, 0), foe = block(b, 1, 'sword', 150, 85, SOUTH)
    commandMove(b, [ours.id], 240, 60, 0)
    commandAttack(b, [foe.id], ours.id)
    let haltedAt: { x: number; y: number } | null = null, jump = 0, swings = 0
    for (let i = 0; i < 900; i++) {
      const before = ours.soldiers.map(s => [s.x, s.y])
      step(b, 0.05)
      if (!haltedAt && ours.order === 'hold') {
        haltedAt = { x: ours.anchorX, y: ours.anchorY }
        jump = Math.max(...ours.soldiers.map((s, k) => Math.hypot(s.x - before[k][0], s.y - before[k][1])))
        // It stops advancing: the hold point is where the block stands, not its far destination.
        expect([ours.destX, ours.destY]).toEqual([ours.anchorX, ours.anchorY])
        expect(ours.destFacing).toBe(ours.facing)
        expect(ours.inContact).toBe(true)
      }
      if (haltedAt) swings += swingsStarted(ours)
    }
    expect(haltedAt).not.toBeNull()
    expect(haltedAt!.x).toBeLessThan(200)
    // No body is moved by the order change itself.
    expect(jump).toBeLessThan(0.5)
    expect(swings).toBeGreaterThan(50)
    expect(lost(foe)).toBeGreaterThan(100)
    expect(ours.anchorX).toBeLessThan(haltedAt!.x + 10)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it('missile fire does not cancel a move', () => {
    const b = createEmptyBattle(11)
    const ours = block(b, 0, 'sword', 60, 60, 0), archers = block(b, 1, 'archer', 130, 110, SOUTH)
    commandMove(b, [ours.id], 200, 60, 0)
    commandAttack(b, [archers.id], ours.id)
    let hitWhileMoving = 0, contact = 0
    tick(b, 50, () => {
      if (ours.inContact) contact++
      if (ours.order === 'move' && lost(ours) > 0) hitWhileMoving++
      if (ours.order === 'hold' && Math.hypot(ours.anchorX - 200, ours.anchorY - 60) > 0.5) throw new Error('stopped short of its destination')
    })
    expect(contact).toBe(0)
    expect(lost(ours)).toBeGreaterThan(0)
    expect(hitWhileMoving).toBeGreaterThan(0)
    expect(ours.order).toBe('hold')
    expect(Math.hypot(ours.anchorX - 200, ours.anchorY - 60)).toBeLessThan(0.5)
  }, 30000)

  it('a move ordered in melee is a disengagement that no enemy attack cancels until it arrives', () => {
    const b = createEmptyBattle(12)
    const ours = block(b, 0, 'sword', 150, 100, NORTH), foe = block(b, 1, 'sword', 150, 112, SOUTH)
    commandAttack(b, [ours.id], foe.id); commandAttack(b, [foe.id], ours.id)
    tick(b, 6)
    expect(ours.engaged).toBe(true)
    commandMove(b, [ours.id], 150, 50, null)
    expect(ours.disengaging).toBe(true)
    const startY = ours.anchorY
    let hurtMarching = 0
    const marching = () => {
      if (ours.order !== 'move') return
      expect(ours.disengaging).toBe(true)
      if (lost(ours) > hpBefore) hurtMarching++
      hpBefore = lost(ours)
    }
    let hpBefore = lost(ours)
    // The pursuer keeps hitting the men pulling out, but the regiment keeps its move.
    tick(b, 4, () => { expect(ours.order).toBe('move'); marching() })
    expect(hurtMarching).toBeGreaterThan(0)
    expect(ours.anchorY).toBeLessThan(startY - 3)
    // Contact is broken for a while: the disengagement does not lapse.
    commandHold(b, [foe.id])
    tick(b, 4, () => { expect(ours.order).toBe('move'); marching() })
    expect(ours.inContact).toBe(false)
    // Caught again on the walk, it takes melee damage on the march and still walks on to its destination.
    commandBehavior(b, [ours.id], { run: false })
    commandAttack(b, [foe.id], ours.id)
    const caught = hurtMarching
    let heldAt: { x: number; y: number } | null = null
    tick(b, 40, () => { marching(); if (!heldAt && ours.order === 'hold') heldAt = { x: ours.anchorX, y: ours.anchorY } })
    expect(hurtMarching).toBeGreaterThan(caught)
    expect(heldAt).not.toBeNull()
    expect(Math.hypot(heldAt!.x - 150, heldAt!.y - 50)).toBeLessThan(1)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it.each(['heavyCavalry', 'chariot'] as const)('a marching column rammed by %s keeps its move through rams and knockdowns; only melee damage stops it', type => {
    const b = createEmptyBattle(9)
    const ours = block(b, 0, 'sword', 60, 60, 0), foe = block(b, 1, type, 110, 110, SOUTH)
    commandMove(b, [ours.id], 240, 60, 0)
    commandAttack(b, [foe.id], ours.id)
    // No weapon swing and no charge blow (an unexpired charge cannot re-arm): only the ram, and for the chariot its
    // collision attack, can reach the column.
    for (const s of foe.soldiers) { s.meleeCd = 1e4; s.chargeLeft = 1e4 }
    let rammed = 0, hurtAt = -1
    for (let i = 0; i < 600 && hurtAt < 0; i++) {
      const before = ours.soldiers.map(s => [s.down, s.hp])
      step(b, SIM_DT)
      rammed += ours.soldiers.filter((s, k) => s.down > 0 && before[k][0] <= 0).length
      if (ours.soldiers.some((s, k) => s.hp < before[k][1])) hurtAt = i
      else expect(ours.order).toBe('move')
    }
    expect(rammed).toBeGreaterThan(0)
    expect(foe.soldiers.every(s => s.swing === null)).toBe(true)
    if (type === 'chariot') {
      // The collision attack is a melee attack: the step it takes HP the column halts.
      expect(hurtAt).toBeGreaterThanOrEqual(0)
      expect(ours.order).toBe('hold')
    } else {
      // Rams deal no damage: the column marches on with men knocked down.
      expect(hurtAt).toBe(-1)
      expect(lost(ours)).toBe(0)
    }
  }, 30000)

  it('a swing that misses does not stop the march; the first blow that takes HP does', () => {
    const b = createEmptyBattle(9)
    b.rng = () => 0.99
    const ours = block(b, 0, 'sword', 60, 60, 0), foe = block(b, 1, 'sword', 150, 85, SOUTH)
    commandMove(b, [ours.id], 240, 60, 0)
    commandAttack(b, [foe.id], ours.id)
    const fresh = Math.max(4, UNITS.sword.meleeInterval + 0.5)
    let swung = 0
    for (let i = 0; i < 900 && swung < 20; i++) {
      step(b, SIM_DT)
      swung += ours.soldiers.filter(s => s.reactTime === fresh).length
      expect(ours.order).toBe('move')
    }
    expect(swung).toBeGreaterThanOrEqual(20)
    expect(lost(ours)).toBe(0)
    b.rng = () => 0.1
    let hurt = false
    for (let i = 0; i < 900 && !hurt; i++) {
      step(b, SIM_DT)
      hurt = lost(ours) > 0
      if (!hurt) expect(ours.order).toBe('move')
    }
    expect(hurt).toBe(true)
    expect(ours.order).toBe('hold')
  }, 30000)

  it('a halted march lays its frame over the men where they stand, so nobody walks on', () => {
    const b = createEmptyBattle(9)
    const ours = block(b, 0, 'sword', 60, 60, 0), foe = block(b, 1, 'sword', 60, 70, SOUTH)
    commandMove(b, [ours.id], 240, 60, 0)
    commandAttack(b, [foe.id], ours.id)
    // Only wound-up swings, whose landing step is known in advance: a charge in progress keeps the foe from a
    // zero-windup charge blow.
    for (const s of foe.soldiers) s.chargeLeft = 1e4
    const d = UNITS.sword, ids = new Set(ours.soldiers.map(s => s.id))
    const offset = () => {
      let x = 0, y = 0, n = 0
      for (const s of ours.soldiers) if (s.alive) { const p = slotOf(ours, d, s.file, s.rank, s.centerIndex); x += s.x - p.x; y += s.y - p.y; n++ }
      return Math.hypot(x / n, y / n)
    }
    const centroidX = () => ours.soldiers.reduce((t, s) => t + s.x, 0) / ours.soldiers.length
    let led = false
    for (let i = 0; i < 400 && ours.order === 'move'; i++) {
      // On the step an enemy blow will land, let the frame run a metre ahead of the men.
      if (!led && foe.soldiers.some(s => s.swing && s.swing.left - SIM_DT <= 1e-9 && ids.has(s.swing.targetId))) {
        ours.anchorX += Math.cos(ours.facing); ours.anchorY += Math.sin(ours.facing); led = true
      }
      step(b, SIM_DT)
    }
    expect(led).toBe(true)
    expect(ours.order).toBe('hold')
    expect(offset()).toBeLessThan(0.05)
    const x = centroidX()
    tick(b, 2)
    expect(centroidX() - x).toBeLessThan(0.3)
  }, 30000)

  it('a new move order re-evaluates the disengagement', () => {
    const b = createEmptyBattle(13)
    const ours = block(b, 0, 'sword', 150, 100, NORTH), foe = block(b, 1, 'sword', 150, 112, SOUTH)
    commandMove(b, [ours.id], 150, 90, null)
    expect(ours.disengaging).toBe(false)
    commandAttack(b, [ours.id], foe.id)
    tick(b, 6)
    commandMove(b, [ours.id], 150, 40, null)
    expect(ours.disengaging).toBe(true)
    commandAttack(b, [ours.id], foe.id)
    expect(ours.disengaging).toBe(false)
  })
})

describe('a march pressed against the enemy that can get no closer ends', () => {
  function engaged(seed: number, type: UnitType = 'sword') {
    const b = createEmptyBattle(seed)
    const ours = block(b, 0, type, 150, 100, NORTH), foe = block(b, 1, 'sword', 150, 112, SOUTH)
    commandAttack(b, [ours.id], foe.id); commandAttack(b, [foe.id], ours.id)
    tick(b, 6)
    expect(ours.engaged).toBe(true)
    return { b, ours, foe }
  }

  it.each(['move', 'front', 'wider front'] as const)('an engaged block given a %s on its own spot holds there within seconds and fights', mode => {
    const { b, ours, foe } = engaged(12)
    const ax = ours.anchorX, ay = ours.anchorY, f = ours.facing, rx = Math.sin(f), ry = -Math.cos(f)
    if (mode === 'move') commandMove(b, [ours.id], ax, ay, f)
    if (mode === 'front') commandFront(b, ours.id, ax - rx * 8, ay - ry * 8, ax + rx * 8, ay + ry * 8)
    if (mode === 'wider front') commandFront(b, ours.id, ax - rx * 14, ay - ry * 14, ax + rx * 14, ay + ry * 14)
    expect(ours.order).toBe('move')
    expect(ours.disengaging).toBe(true)
    const dest = [ours.destX, ours.destY, ours.destFacing, ours.destFiles]
    let heldAfter = Infinity
    for (let i = 0; i < 160 && heldAfter === Infinity; i++) {
      step(b, SIM_DT)
      expect(ours.inContact).toBe(true)
      if (ours.order === 'hold') heldAfter = (i + 1) * SIM_DT
    }
    expect(heldAfter).toBeLessThan(6)
    // Nowhere further to go counts as arrival: the line, its facing and its new width are kept.
    expect([ours.destX, ours.destY, ours.destFacing, ours.destFiles]).toEqual(dest)
    expect(ours.files).toBe(ours.destFiles)
    const before = lost(foe)
    let swings = 0
    tick(b, 10, () => { swings += swingsStarted(ours) })
    expect(swings).toBeGreaterThan(20)
    // It fights: the front rank's blows cost the foe some health in these 10 s, how much depends on the hit rolls.
    expect(lost(foe) - before).toBeGreaterThan(15)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it('a disengaging block chased all the way to its destination holds there and fights back', () => {
    const { b, ours, foe } = engaged(13, 'spear')
    commandMove(b, [ours.id], 150, 75, null)
    expect(ours.disengaging).toBe(true)
    let heldAt: { x: number; y: number; contact: boolean } | null = null, lapsed = false
    tick(b, 20, () => {
      if (ours.order === 'move' && !ours.disengaging) lapsed = true
      if (!heldAt && ours.order === 'hold') heldAt = { x: ours.anchorX, y: ours.anchorY, contact: ours.inContact }
    })
    // The pursuers never let go, so the disengagement lasted the whole way.
    expect(lapsed).toBe(false)
    expect(heldAt).not.toBeNull()
    expect(Math.hypot(heldAt!.x - 150, heldAt!.y - 75)).toBeLessThan(1)
    expect(heldAt!.contact).toBe(true)
    expect(ours.routing).toBe(false)
    const before = lost(foe)
    tick(b, 10)
    // Holding in a melee it cannot charge in again under the same order (RULES 四.3), it still fights back.
    expect(lost(foe)).toBeGreaterThan(before + 10)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it('two blocks marching into each other stop pushing and fight', () => {
    const b = createEmptyBattle(5)
    const a = block(b, 0, 'sword', 150, 80, NORTH), c = block(b, 1, 'sword', 150, 120, SOUTH)
    commandMove(b, [a.id], 150, 130, NORTH); commandMove(b, [c.id], 150, 70, SOUTH)
    let met = Infinity, held = Infinity
    tick(b, 30, () => {
      if (met === Infinity && a.inContact) met = b.time
      if (held === Infinity && a.order === 'hold' && c.order === 'hold') held = b.time
    })
    expect(met).toBeLessThan(15)
    expect(held - met).toBeLessThan(4)
    expect(lost(a)).toBeGreaterThan(100)
    expect(lost(c)).toBeGreaterThan(100)
    expect(battleErrors(b)).toEqual([])
  }, 30000)

  it('a disengagement that is getting away is not cut short while it turns about', () => {
    for (const type of ['sword', 'heavyCavalry'] as const) {
      const { b, ours } = engaged(12, type)
      const startY = ours.anchorY
      commandMove(b, [ours.id], 150, 20, null)
      tick(b, 4, () => { expect(ours.order).toBe('move') })
      expect(ours.anchorY, type).toBeLessThan(startY - 2)
    }
  }, 30000)
})
