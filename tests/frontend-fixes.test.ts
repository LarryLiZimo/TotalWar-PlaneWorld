import { describe, expect, it } from 'vitest'
import { worldToScreen, type Camera } from '../src/camera'
import { attachInput, attachKeys, clickSelection, gestureOf, pauseWhileHidden, type Gesture, type PointerState } from '../src/input'
import { createArmyBattle } from '../src/sim/armies'
import { applyCommand, type BattleCommand } from '../src/sim/commands'
import { flankHandles, massCenter } from '../src/sim/formation'
import { commandMove, step } from '../src/sim/index'
import { right } from '../src/sim/math'
import { createScenario } from '../src/sim/scenarios'
import { SIM_DT, type Battle } from '../src/sim/types'
import { unitDef } from '../src/sim/units'

/** A canvas of `width`x`height` device px shown at `css` CSS px (DPR = width / css.width). */
class Canvas extends EventTarget {
  style = { cursor: '' }
  captured = false
  constructor(public width = 1000, public height = 1000, private css = { width: 1000, height: 1000 }) { super() }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, ...this.css } }
  setPointerCapture() { this.captured = true }
  hasPointerCapture() { return this.captured }
  releasePointerCapture() { this.captured = false }
  fire(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, pointerId: 1, button: 2, shiftKey: false, ...extra })
    this.dispatchEvent(event)
    return event
  }
  /** CSS client position of a world point. */
  client(camera: Camera, x: number, y: number) {
    const p = worldToScreen(camera, this.width, this.height, x, y), scale = this.width / this.css.width
    return { x: p.x / scale, y: p.y / scale }
  }
}

const pointerState = (): PointerState => ({ drag: null, dragRegId: null, hoverId: null })
const attach = (canvas: Canvas, camera: Camera, b: Battle, selection: { ids: number[] }, pointer = pointerState()) =>
  attachInput(canvas as unknown as HTMLCanvasElement, camera, () => b, () => selection.ids, ids => { selection.ids = ids }, pointer)

/** Record every command and still apply it, like the worker would. */
function recordCommands(b: Battle): BattleCommand[] {
  const sent: BattleCommand[] = []
  const relay = (c: BattleCommand) => {
    sent.push(c)
    b.sendCommand = undefined
    applyCommand(b, c)
    b.sendCommand = relay
  }
  b.sendCommand = relay
  return sent
}

function standingSwords() {
  const b = createArmyBattle({ player: 'classic', enemy: 'classic', scale: 4 }, 7)
  b.aiEnabled = false
  const reg = b.regiments.find(r => r.side === 0 && r.soldiers.length > 50)!
  for (let i = 0; i < 20; i++) step(b, SIM_DT)
  return { b, reg }
}

const key = (target: EventTarget, type: string, code: string, extra: Record<string, unknown> = {}) => {
  const event = Object.assign(new Event(type, { cancelable: true }), { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra })
  target.dispatchEvent(event)
  return event
}

describe('battle hotkeys', () => {
  const setup = (ignore = false) => {
    const target = new EventTarget(), held = new Set<string>(), calls: string[] = []
    attachKeys(target, held, {
      ignore: () => ignore,
      toggleRun: () => calls.push('run'),
      toggleMelee: () => calls.push('melee'),
      togglePause: () => calls.push('pause'),
      selectAll: () => calls.push('all'),
      saveGroup: digit => calls.push(`save ${digit}`),
      recallGroup: digit => calls.push(`recall ${digit}`),
    })
    return { target, held, calls }
  }

  it('cancels held Space on every auto-repeat and on release, so a focused HUD button is never clicked', () => {
    const { target, held } = setup()
    expect(key(target, 'keydown', 'Space').defaultPrevented).toBe(true)
    for (let i = 0; i < 6; i++) expect(key(target, 'keydown', 'Space', { repeat: true }).defaultPrevented).toBe(true)
    expect(held.has('Space')).toBe(true)
    expect(key(target, 'keyup', 'Space').defaultPrevented).toBe(true)
    expect(held.has('Space')).toBe(false)
    expect(key(target, 'keydown', 'AltLeft', { repeat: true, altKey: true }).defaultPrevented).toBe(true)
  })

  it('Ctrl+A selects the army once, cancels the page select-all and is never the camera key', () => {
    const { target, held, calls } = setup()
    key(target, 'keydown', 'ControlLeft', { ctrlKey: true })
    expect(key(target, 'keydown', 'KeyA', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key(target, 'keydown', 'KeyA', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true)
    // Ctrl let go first: the A still held does not start panning, and does not select again.
    key(target, 'keyup', 'ControlLeft')
    expect(key(target, 'keydown', 'KeyA', { repeat: true }).defaultPrevented).toBe(true)
    expect(held.has('KeyA')).toBe(false)
    expect(calls).toEqual(['all'])
    key(target, 'keyup', 'KeyA')
    // A plain A pans again; Cmd+A selects like Ctrl+A, also when A was already held for the camera.
    key(target, 'keydown', 'KeyA')
    expect(held.has('KeyA')).toBe(true)
    expect(key(target, 'keydown', 'KeyA', { metaKey: true, repeat: true }).defaultPrevented).toBe(true)
    expect(held.has('KeyA')).toBe(false)
    expect(calls).toEqual(['all', 'all'])
    // While the setup dialog owns the keyboard, Ctrl+A is the browser's.
    const ignored = setup(true)
    expect(key(ignored.target, 'keydown', 'KeyA', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(ignored.calls).toEqual([])
  })

  it('consumes panning arrows (no scenario switch, no Alt+Arrow history) and Ctrl+digit repeats', () => {
    const { target, held, calls } = setup()
    expect(key(target, 'keydown', 'ArrowDown').defaultPrevented).toBe(true)
    expect(key(target, 'keydown', 'ArrowDown', { repeat: true }).defaultPrevented).toBe(true)
    expect(key(target, 'keydown', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(true)
    expect(held.has('ArrowDown') && held.has('ArrowLeft')).toBe(true)
    expect(key(target, 'keydown', 'Digit3', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key(target, 'keydown', 'Digit3', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true)
    key(target, 'keydown', 'Digit3')
    key(target, 'keydown', 'KeyP')
    key(target, 'keydown', 'KeyP', { repeat: true })
    key(target, 'keydown', 'KeyR')
    expect(key(target, 'keydown', 'KeyF').defaultPrevented).toBe(true)
    key(target, 'keydown', 'KeyF', { repeat: true })
    expect(calls).toEqual(['save 3', 'recall 3', 'pause', 'run', 'melee'])
    // Browser shortcuts built on battle letters keep their default.
    expect(key(target, 'keydown', 'KeyR', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key(target, 'keydown', 'KeyF', { ctrlKey: true }).defaultPrevented).toBe(false)
    // ...and do not also act: Ctrl is the rotate modifier, Ctrl+R/F/P stay browser shortcuts.
    key(target, 'keydown', 'KeyP', { ctrlKey: true })
    expect(calls).toEqual(['save 3', 'recall 3', 'pause', 'run', 'melee'])
    expect(key(target, 'keydown', 'KeyW', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('leaves every key to the setup dialog while it is open', () => {
    const { target, held, calls } = setup(true)
    expect(key(target, 'keydown', 'Space').defaultPrevented).toBe(false)
    expect(key(target, 'keydown', 'ArrowDown').defaultPrevented).toBe(false)
    expect(key(target, 'keyup', 'Space').defaultPrevented).toBe(false)
    expect(held.size).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('box selection uses the displayed bodies', () => {
  const boxSelect = (b: Battle, x0: number, y0: number, x1: number, y1: number, camera: Camera) => {
    const canvas = new Canvas(), selection = { ids: [] as number[] }
    attach(canvas, camera, b, selection)
    const a = canvas.client(camera, x0, y0), c = canvas.client(camera, x1, y1)
    canvas.fire('pointerdown', a.x, a.y, { button: 0 })
    canvas.fire('pointermove', c.x, c.y, { button: 0 })
    canvas.fire('pointerup', c.x, c.y, { button: 0 })
    return selection.ids
  }
  const bodies = (b: Battle, id: number) => {
    const alive = b.regiments.find(r => r.id === id)!.soldiers.filter(s => s.alive)
    return { x0: Math.min(...alive.map(s => s.x)), x1: Math.max(...alive.map(s => s.x)), y0: Math.min(...alive.map(s => s.y)), y1: Math.max(...alive.map(s => s.y)) }
  }

  it('a box over every rank but the front one selects the block', () => {
    const { b, reg } = standingSwords()
    expect(Math.sin(reg.facing)).toBeCloseTo(1)
    const k = bodies(b, reg.id), camera = { x: reg.anchorX, y: reg.anchorY, zoom: 20 }
    expect(boxSelect(b, k.x0 - 1, k.y0 - 1, k.x1 + 1, k.y1 - 0.6, camera)).toContain(reg.id)
  })

  it('right after a short move, the bodies select it and an empty box at the destination does not', () => {
    const { b, reg } = standingSwords()
    commandMove(b, [reg.id], reg.anchorX, reg.anchorY + 7.5, null)
    step(b, SIM_DT)
    const k = bodies(b, reg.id), camera = { x: reg.anchorX, y: reg.anchorY - 4, zoom: 20 }
    expect(reg.anchorY - 1).toBeGreaterThan(k.y1 + unitDef(reg.type).radius)
    expect(boxSelect(b, k.x0 - 0.5, k.y0 - 0.5, k.x1 + 0.5, k.y1 + 0.5, camera)).toContain(reg.id)
    expect(boxSelect(b, reg.anchorX - 1, reg.anchorY - 1, reg.anchorX + 1, reg.anchorY + 1, camera)).not.toContain(reg.id)
  })
})

describe('flank width handle', () => {
  const grab = (b: Battle, id: number) => {
    const reg = b.regiments.find(r => r.id === id)!
    const canvas = new Canvas(), camera = { x: reg.anchorX, y: reg.anchorY, zoom: 20 }
    attach(canvas, camera, b, { ids: [id] })
    const handle = flankHandles(reg, unitDef(reg.type))[1]
    const axis = right(reg.facing)
    const at = (outward: number) => canvas.client(camera, handle.x + axis.x * outward, handle.y + axis.y * outward)
    const p = at(0)
    canvas.fire('pointerdown', p.x, p.y, { button: 0 })
    return { canvas, at, move: (outward: number) => { const q = at(outward); canvas.fire('pointermove', q.x, q.y, { button: 0 }) }, release: () => canvas.fire('pointerup', p.x, p.y, { button: 0 }) }
  }

  it('grabbing and nudging the handle does not re-form the block, even right after a sideways move', () => {
    for (const shift of [0, 7.5]) {
      const { b, reg } = standingSwords()
      if (shift) { commandMove(b, [reg.id], reg.anchorX + shift, reg.anchorY, null); step(b, SIM_DT) }
      const files = reg.files, sent = recordCommands(b)
      const drag = grab(b, reg.id)
      drag.canvas.fire('pointermove', drag.at(0).x + 1, drag.at(0).y, { button: 0 })
      drag.canvas.fire('pointermove', drag.at(0).x - 1, drag.at(0).y + 1, { button: 0 })
      drag.release()
      expect(reg.files).toBe(files)
      expect(sent.filter(c => c.kind === 'width')).toEqual([])
    }
  })

  it('follows the pointer from the grab and sends a width command only when the file count changes', () => {
    const { b, reg } = standingSwords()
    const files = reg.files, spacing = unitDef(reg.type).spacing, sent = recordCommands(b)
    const drag = grab(b, reg.id)
    for (let i = 1; i <= 30; i++) drag.move(i * 0.1)
    const widths = sent.filter(c => c.kind === 'width').map(c => c.kind === 'width' ? c.files : 0)
    expect(widths.at(-1)).toBe(files + Math.round((2 * 3) / spacing))
    expect(reg.files).toBe(widths.at(-1))
    expect(new Set(widths).size).toBe(widths.length)
    expect(widths.length).toBeLessThan(10)
    drag.move(0)
    expect(reg.files).toBe(files)
    drag.release()
    expect(sent.at(-1)?.kind).toBe('endWidth')
  })

  /** Press `offsetCss` CSS px outward from the right handle on `canvas`, then drag `dragCss` CSS px further out. */
  const pressNearHandle = (canvas: Canvas, zoom: number, offsetCss: number, dragCss: number) => {
    const { b, reg } = standingSwords()
    const files = reg.files, sent = recordCommands(b)
    const camera = { x: reg.anchorX, y: reg.anchorY, zoom }
    attach(canvas, camera, b, { ids: [reg.id] })
    const handle = flankHandles(reg, unitDef(reg.type))[1], axis = right(reg.facing)
    const h = canvas.client(camera, handle.x, handle.y), out = canvas.client(camera, handle.x + axis.x, handle.y + axis.y)
    const len = Math.hypot(out.x - h.x, out.y - h.y), ux = (out.x - h.x) / len, uy = (out.y - h.y) / len
    const at = (css: number) => ({ x: h.x + ux * css, y: h.y + uy * css })
    canvas.fire('pointerdown', at(offsetCss).x, at(offsetCss).y, { button: 0 })
    for (let i = 1; i <= 10; i++) canvas.fire('pointermove', at(offsetCss + dragCss * i / 10).x, at(offsetCss + dragCss * i / 10).y, { button: 0 })
    canvas.fire('pointerup', at(offsetCss + dragCss).x, at(offsetCss + dragCss).y, { button: 0 })
    return { files, reg, widths: sent.filter(c => c.kind === 'width') }
  }

  it('grabs the handle within 12 CSS px at DPR 2, as drawn, and not beyond', () => {
    const dpr2 = () => new Canvas(2000, 2000, { width: 1000, height: 1000 })
    const near = pressNearHandle(dpr2(), 40, 9, 60)
    expect(near.widths.length).toBeGreaterThan(0)
    expect(near.reg.files).toBeGreaterThan(near.files)
    const far = pressNearHandle(dpr2(), 40, 14, 60)
    expect(far.widths).toEqual([])
    expect(far.reg.files).toBe(far.files)
  })

  it('ignores a grab that moves less than 8 CSS px even when that would change the width at fit zoom', () => {
    // At zoom 2 one CSS px is half a metre, so 6 px outward would already add several files without the dead zone.
    const nudge = pressNearHandle(new Canvas(), 2, 0, 6)
    expect(nudge.widths).toEqual([])
    expect(nudge.reg.files).toBe(nudge.files)
    // Control: the same drag past the dead zone does change the width.
    const drag = pressNearHandle(new Canvas(), 2, 0, 12)
    expect(drag.widths.length).toBeGreaterThan(0)
  })
})

describe('Alt translate, Ctrl rotate and Shift queue', () => {
  it('lets the modifier pressed last decide between translate and rotate', () => {
    expect(gestureOf([])).toBeNull()
    expect(gestureOf(['KeyW', 'Space'])).toBeNull()
    expect(gestureOf(['AltLeft'])).toBe('translate')
    expect(gestureOf(['ControlRight'])).toBe('rotate')
    expect(gestureOf(['AltLeft', 'ControlLeft'])).toBe('rotate')
    expect(gestureOf(['ControlLeft', 'AltRight'])).toBe('translate')
  })

  /** Right-drag the two selected blocks by `dx, dy` metres with `gesture` held; returns the preview and the result. */
  const drag = (gesture: Gesture, to: (cx: number, cy: number) => { x: number; y: number }, shift = false) => {
    const { b } = standingSwords()
    const regs = b.regiments.filter(r => r.side === 0 && r.type === 'sword').slice(0, 2)
    const before = regs.map(r => ({ x: r.anchorX, y: r.anchorY, facing: r.facing, files: r.files }))
    const cx = before.reduce((s, p) => s + p.x, 0) / 2, cy = before.reduce((s, p) => s + p.y, 0) / 2
    const canvas = new Canvas(), camera = { x: cx, y: cy, zoom: 4 }, pointer = pointerState(), sent = recordCommands(b)
    attachInput(canvas as unknown as HTMLCanvasElement, camera, () => b, () => regs.map(r => r.id), () => {}, pointer, () => gesture)
    const press = canvas.client(camera, cx + 20, cy), end = to(cx, cy), release = canvas.client(camera, end.x, end.y)
    return { b, regs, before, cx, cy, pointer, sent, canvas, press, release, shift }
  }
  const run = (d: ReturnType<typeof drag>) => {
    d.canvas.fire('pointerdown', d.press.x, d.press.y)
    d.canvas.fire('pointermove', d.release.x, d.release.y)
    const preview = d.pointer.drag
    d.canvas.fire('pointerup', d.release.x, d.release.y, { shiftKey: d.shift })
    return preview
  }

  it('Alt + right drag moves the selection by the drag, keeping facings and widths', () => {
    const d = drag('translate', (cx, cy) => ({ x: cx + 20 + 12, y: cy - 6 }))
    const preview = run(d)
    expect(preview?.kind).toBe('place')
    d.regs.forEach((r, i) => {
      expect(r.order).toBe('move')
      expect(r.destX).toBeCloseTo(d.before[i].x + 12, 0)
      expect(r.destY).toBeCloseTo(d.before[i].y - 6, 0)
      expect(r.destFacing).toBeCloseTo(d.before[i].facing)
      expect(r.files).toBe(d.before[i].files)
    })
  })

  it('Ctrl + right drag turns the selection about its centre by the swept angle', () => {
    // Pressed 20 m east of the centre, released 20 m north of it: a quarter turn anticlockwise.
    const d = drag('rotate', (cx, cy) => ({ x: cx, y: cy + 20 }))
    run(d)
    d.regs.forEach((r, i) => {
      const ox = d.before[i].x - d.cx, oy = d.before[i].y - d.cy
      expect(r.destX).toBeCloseTo(d.cx - oy, 0)
      expect(r.destY).toBeCloseTo(d.cy + ox, 0)
      expect(Math.cos(r.destFacing - d.before[i].facing - Math.PI / 2)).toBeCloseTo(1)
    })
  })

  it('Alt or Ctrl + left drag does what the right drag does; a left drag without them is the box, a left click orders nothing', () => {
    const left = { button: 0 }
    const run = (d: ReturnType<typeof drag>) => {
      d.canvas.fire('pointerdown', d.press.x, d.press.y, left)
      d.canvas.fire('pointermove', d.release.x, d.release.y, left)
      const preview = d.pointer.drag
      d.canvas.fire('pointerup', d.release.x, d.release.y, left)
      return preview
    }
    const moved = drag('translate', (cx, cy) => ({ x: cx + 20 + 12, y: cy - 6 }))
    expect(run(moved)?.kind).toBe('place')
    expect(moved.sent.map(c => c.kind)).toEqual(['place'])
    moved.regs.forEach((r, i) => {
      expect(r.order).toBe('move')
      expect(r.destX).toBeCloseTo(moved.before[i].x + 12, 0)
      expect(r.destY).toBeCloseTo(moved.before[i].y - 6, 0)
      expect(r.destFacing).toBeCloseTo(moved.before[i].facing)
      expect(r.files).toBe(moved.before[i].files)
    })
    const turned = drag('rotate', (cx, cy) => ({ x: cx, y: cy + 20 }))
    expect(run(turned)?.kind).toBe('place')
    turned.regs.forEach((r, i) => {
      const ox = turned.before[i].x - turned.cx, oy = turned.before[i].y - turned.cy
      expect(r.destX).toBeCloseTo(turned.cx - oy, 0)
      expect(r.destY).toBeCloseTo(turned.cy + ox, 0)
      expect(Math.cos(r.destFacing - turned.before[i].facing - Math.PI / 2)).toBeCloseTo(1)
    })
    // No modifier: the left drag is the selection box and orders nothing.
    const box = drag(null, (cx, cy) => ({ x: cx + 20 + 12, y: cy - 6 }))
    expect(run(box)?.kind).toBe('box')
    expect(box.sent).toHaveLength(0)
    // A left click with a modifier held is still only a click: no layout, no move order, no front.
    const click = drag('translate', (cx, cy) => ({ x: cx + 20, y: cy }))
    expect(run(click)).toBeNull()
    expect(click.sent).toHaveLength(0)
    click.regs.forEach(r => expect(r.order).toBe('hold'))
  })

  it('Shift appends the drag or click to the queued orders instead of replacing them', () => {
    const d = drag('translate', (cx, cy) => ({ x: cx + 20 + 12, y: cy }), true)
    commandMove(d.b, d.regs.map(r => r.id), d.cx, d.cy + 10, null)
    run(d)
    expect(d.sent.filter(c => c.kind === 'place').every(c => c.kind === 'place' && c.queue)).toBe(true)
    d.regs.forEach(r => expect(r.queue).toHaveLength(1))
    // A plain Shift right click queues a move too.
    const p = d.canvas.client({ x: d.cx, y: d.cy, zoom: 4 }, d.cx, d.cy - 30)
    d.canvas.fire('pointerdown', p.x, p.y)
    d.canvas.fire('pointerup', p.x, p.y, { shiftKey: true })
    d.regs.forEach(r => expect(r.queue.length).toBeGreaterThanOrEqual(2))
  })
})

describe('Alt and Ctrl compose within one right drag', () => {
  /** Two selected blocks, a canvas and a gesture the test switches between pointer moves, like held modifiers. */
  const setup = () => {
    const { b } = standingSwords()
    const regs = b.regiments.filter(r => r.side === 0 && r.type === 'sword').slice(0, 2)
    const before = regs.map(r => ({ x: r.anchorX, y: r.anchorY, facing: r.facing, files: r.files }))
    const cx = before.reduce((s, p) => s + p.x, 0) / 2, cy = before.reduce((s, p) => s + p.y, 0) / 2
    const canvas = new Canvas(), camera = { x: cx, y: cy, zoom: 4 }, pointer = pointerState(), sent = recordCommands(b)
    const held: { gesture: Gesture } = { gesture: null }
    attachInput(canvas as unknown as HTMLCanvasElement, camera, () => b, () => regs.map(r => r.id), () => {}, pointer, () => held.gesture)
    const at = (x: number, y: number) => canvas.client(camera, x, y)
    const down = (x: number, y: number) => { const p = at(x, y); canvas.fire('pointerdown', p.x, p.y) }
    const move = (gesture: Gesture, x: number, y: number) => { held.gesture = gesture; const p = at(x, y); canvas.fire('pointermove', p.x, p.y) }
    const up = (x: number, y: number, shiftKey = false) => { const p = at(x, y); canvas.fire('pointerup', p.x, p.y, { shiftKey }) }
    return { b, regs, before, cx, cy, pointer, sent, down, move, up }
  }
  /** Each block's offset from the pair's centre turned by `turn` and placed about (x, y). */
  const expectLaid = (d: ReturnType<typeof setup>, x: number, y: number, turn: number) => d.regs.forEach((r, i) => {
    const ox = d.before[i].x - d.cx, oy = d.before[i].y - d.cy, cos = Math.cos(turn), sin = Math.sin(turn)
    expect(r.order).toBe('move')
    expect(r.destX).toBeCloseTo(x + ox * cos - oy * sin, 0)
    expect(r.destY).toBeCloseTo(y + ox * sin + oy * cos, 0)
    expect(Math.cos(r.destFacing - d.before[i].facing - turn)).toBeCloseTo(1)
    expect(r.files).toBe(d.before[i].files)
  })

  it('Alt then Ctrl turns the already moved layout about its new centre', () => {
    const d = setup(), { cx, cy } = d
    d.down(cx + 20, cy)
    d.move('translate', cx + 50, cy)
    // Ctrl now: the pointer, 20 m east of the moved centre, is the new reference; a quarter turn about (cx+30, cy).
    d.move('rotate', cx + 50, cy)
    d.move('rotate', cx + 30, cy + 20)
    expect(d.pointer.drag?.kind).toBe('place')
    d.up(cx + 30, cy + 20)
    expectLaid(d, cx + 30, cy, Math.PI / 2)
  })

  it('Ctrl then Alt moves the already turned layout', () => {
    const d = setup(), { cx, cy } = d
    d.down(cx + 20, cy)
    d.move('rotate', cx, cy + 20)
    d.move('translate', cx, cy + 20)
    d.move('translate', cx + 15, cy + 15)
    d.up(cx + 15, cy + 15)
    expectLaid(d, cx + 15, cy - 5, Math.PI / 2)
  })

  it('switching back and forth keeps accumulating', () => {
    const d = setup(), { cx, cy } = d
    d.down(cx + 20, cy)
    d.move('translate', cx + 30, cy)
    // Turn a quarter about the moved centre (cx+10, cy), from 20 m east of it to 20 m north of it.
    d.move('rotate', cx + 30, cy)
    d.move('rotate', cx + 10, cy + 20)
    d.move('translate', cx + 10, cy + 20)
    d.move('translate', cx + 10, cy + 30)
    // And a second quarter about the centre now at (cx+10, cy+10), referenced from where Ctrl took over again.
    d.move('rotate', cx + 30, cy + 10)
    d.move('rotate', cx + 10, cy + 30)
    d.up(cx + 10, cy + 30)
    expectLaid(d, cx + 10, cy + 10, Math.PI)
  })

  it('releasing the modifiers mid-drag keeps the composed layout; release issues it and Shift queues it', () => {
    const d = setup(), { cx, cy } = d
    commandMove(d.b, d.regs.map(r => r.id), cx, cy, null)
    d.sent.length = 0
    d.down(cx + 20, cy)
    d.move('translate', cx + 32, cy - 6)
    const built = d.pointer.drag?.places
    d.move(null, cx - 40, cy + 40)
    expect(d.pointer.drag?.kind).toBe('place')
    expect(d.pointer.drag?.places).toEqual(built)
    d.up(cx - 40, cy + 40, true)
    expect(d.sent.map(c => c.kind)).toEqual(['place'])
    expect(d.sent[0].kind === 'place' && d.sent[0].queue).toBe(true)
    d.regs.forEach((r, i) => {
      expect(r.queue).toHaveLength(1)
      const queued = r.queue[0]
      expect(queued.kind).toBe('move')
      if (queued.kind !== 'move') return
      // Queued from where the current move ends: the pair is centred on (cx, cy), so the place is that plus (12, -6).
      expect(queued.x).toBeCloseTo(d.regs[i].destX + 12, 0)
      expect(queued.y).toBeCloseTo(d.regs[i].destY - 6, 0)
    })
  })

  it('separate drags chain through the plan: an issued Alt move then a Ctrl drag turns about the destination', () => {
    const d = setup(), { cx, cy } = d
    d.down(cx + 20, cy)
    d.move('translate', cx + 50, cy)
    d.up(cx + 50, cy)
    expectLaid(d, cx + 30, cy, 0)
    d.down(cx + 50, cy)
    d.move('rotate', cx + 30, cy + 20)
    d.up(cx + 30, cy + 20)
    expectLaid(d, cx + 30, cy, Math.PI / 2)
  })
})

describe('right click drift at high DPR', () => {
  const dpr2 = () => new Canvas(3840, 2160, { width: 1920, height: 1080 })
  /** Right click at the camera centre that drifts `drift` CSS px; returns the preview shown during the drift. */
  const rightClick = (b: Battle, ids: number[], target: { x: number; y: number }, drift: number, zoom: number) => {
    const canvas = dpr2(), camera = { x: target.x, y: target.y, zoom }, pointer = pointerState()
    attach(canvas, camera, b, { ids }, pointer)
    canvas.fire('pointerdown', 960, 540)
    canvas.fire('pointermove', 960 + drift, 540)
    const preview = pointer.drag
    canvas.fire('pointerup', 960 + drift, 540)
    canvas.fire('contextmenu', 960 + drift, 540)
    return preview
  }

  it('a multi-selection still moves when the click drifts 5 CSS px', () => {
    const b = createScenario('line', 1), ids = b.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id)
    rightClick(b, ids, { x: 150, y: 140 }, 5, 20)
    expect(ids.map(id => b.regiments.find(r => r.id === id)!.order)).toEqual(['move', 'move'])
  })

  it('a single regiment right-clicking an enemy still attacks after a few px of drift', () => {
    for (const [drift, zoom] of [[5, 20], [7, 8.3]]) {
      const b = createArmyBattle({ player: 'classic', enemy: 'classic', scale: 4 }, 3)
      b.aiEnabled = false
      const mine = b.regiments.find(r => r.side === 0)!, foe = b.regiments.find(r => r.side === 1)!
      rightClick(b, [mine.id], massCenter(foe), drift, zoom)
      expect([mine.order, mine.targetId]).toEqual(['attack', foe.id])
    }
  })

  it('a drag past the pixel threshold but too short for a front is a click order, with no front preview', () => {
    // DPR 2, zoom 40: 10 CSS px = 20 device px = 0.5 m, under the 0.8 m a front line needs.
    const b = createArmyBattle({ player: 'classic', enemy: 'classic', scale: 4 }, 3)
    b.aiEnabled = false
    const mine = b.regiments.find(r => r.side === 0)!, foe = b.regiments.find(r => r.side === 1)!
    expect(rightClick(b, [mine.id], massCenter(foe), 10, 40)).toBeNull()
    expect([mine.order, mine.targetId]).toEqual(['attack', foe.id])
    const line = createScenario('line', 1), ids = line.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id)
    expect(rightClick(line, ids, { x: 150, y: 140 }, 10, 40)).toBeNull()
    expect(ids.map(id => line.regiments.find(r => r.id === id)!.order)).toEqual(['move', 'move'])
  })

  it('a real drag still draws and orders a front', () => {
    const b = createScenario('line', 1), ids = b.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id)
    const canvas = dpr2(), pointer = pointerState()
    attach(canvas, { x: 150, y: 140, zoom: 20 }, b, { ids }, pointer)
    canvas.fire('pointerdown', 700, 540)
    canvas.fire('pointermove', 704, 540)
    expect(pointer.drag).toBeNull()
    canvas.fire('pointermove', 1300, 540)
    expect(pointer.drag?.kind).toBe('front')
    canvas.fire('pointerup', 1300, 540)
    const regs = ids.map(id => b.regiments.find(r => r.id === id)!)
    expect(regs.every(r => r.order === 'move' && r.destFacing === Math.PI / 2)).toBe(true)
  })
})

describe('contextmenu fallback on every platform', () => {
  const setup = () => {
    const b = createScenario('line', 1), canvas = new Canvas(300, 230, { width: 300, height: 230 }), sent: BattleCommand[] = []
    b.sendCommand = c => sent.push(c)
    const selection = { ids: b.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id) }
    attach(canvas, { x: 150, y: 115, zoom: 1 }, b, selection)
    return { canvas, sent, selection }
  }

  it('a press-time contextmenu (macOS/Linux) sends nothing; release sends exactly one order', () => {
    const { canvas, sent } = setup()
    canvas.fire('pointerdown', 60, 110)
    canvas.fire('contextmenu', 60, 110)
    canvas.fire('pointermove', 150, 110)
    expect(sent).toEqual([])
    canvas.fire('pointerup', 150, 110)
    expect(sent.map(c => c.kind)).toEqual(['groupFront'])
    sent.length = 0
    canvas.fire('pointerdown', 60, 110)
    canvas.fire('contextmenu', 60, 110)
    canvas.fire('pointerup', 60, 110)
    expect(sent.map(c => c.kind)).toEqual(['move'])
  })

  it('Windows order still sends one order, a lone contextmenu still orders, a chord during a box drag does not', () => {
    const lone = setup()
    lone.canvas.fire('contextmenu', 80, 110)
    expect(lone.sent.map(c => c.kind)).toEqual(['move'])
    const { canvas, sent, selection } = setup()
    canvas.fire('pointerdown', 60, 110)
    canvas.fire('pointerup', 60, 110)
    canvas.fire('contextmenu', 60, 110)
    expect(sent.map(c => c.kind)).toEqual(['move'])
    sent.length = 0
    const before = [...selection.ids]
    canvas.fire('pointerdown', 10, 10, { button: 0 })
    canvas.fire('pointermove', 40, 40, { button: -1 })
    canvas.fire('contextmenu', 40, 40)
    expect(sent).toEqual([])
    canvas.fire('pointerup', 40, 40, { button: 0 })
    expect(sent).toEqual([])
    expect(selection.ids).not.toEqual(before)
  })
})

describe('wheel', () => {
  it('horizontal swipes and Shift+wheel (deltaY 0) do not zoom; vertical wheel still does', () => {
    const b = createScenario('line', 1), canvas = new Canvas(300, 230, { width: 300, height: 230 }), camera = { x: 150, y: 115, zoom: 1 }
    attach(canvas, camera, b, { ids: [] })
    for (let i = 0; i < 10; i++) expect(canvas.fire('wheel', 150, 115, { deltaX: 40, deltaY: 0 }).defaultPrevented).toBe(true)
    expect(camera.zoom).toBe(1)
    canvas.fire('wheel', 150, 115, { deltaX: 0, deltaY: -100 })
    expect(camera.zoom).toBeCloseTo(1.08)
    canvas.fire('wheel', 150, 115, { deltaX: 0, deltaY: 100 })
    expect(camera.zoom).toBeCloseTo(1.08 * 0.92)
  })
})

describe('hidden page', () => {
  const page = (hidden = false) => {
    const doc = Object.assign(new EventTarget(), { hidden }), win = new EventTarget(), state = { paused: false, calls: [] as boolean[] }
    pauseWhileHidden(doc, win, () => !state.paused, value => { state.paused = value; state.calls.push(value) })
    const visibility = (hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')) }
    return { win, state, visibility }
  }

  it('pauses a running battle when hidden and resumes it on return', () => {
    const { state, visibility } = page()
    visibility(true)
    expect(state.paused).toBe(true)
    visibility(false)
    expect(state.calls).toEqual([true, false])
  })

  it('leaves a battle the player paused paused', () => {
    const { state, visibility } = page()
    state.paused = true
    visibility(true)
    visibility(false)
    expect(state.paused).toBe(true)
    expect(state.calls).toEqual([])
  })

  it('pauses a battle that loads in a background tab and resumes it when first shown', () => {
    const { state, visibility } = page(true)
    expect(state.calls).toEqual([true])
    visibility(false)
    expect(state.calls).toEqual([true, false])
    expect(page(false).state.calls).toEqual([])
  })

  it('handles pagehide/pageshow (bfcache) the same way', () => {
    const { win, state } = page()
    win.dispatchEvent(new Event('pagehide'))
    expect(state.paused).toBe(true)
    win.dispatchEvent(new Event('pageshow'))
    expect(state.calls).toEqual([true, false])
  })
})

describe('modifier clicks on uncontrollable regiments', () => {
  it('keeps the selection when a routing or destroyed card is Shift/Ctrl-clicked, and only inspects it', () => {
    expect(clickSelection([1, 2, 3, 4], 9, true, false)).toEqual({ ids: [1, 2, 3, 4], inspect: 9 })
    expect(clickSelection([1, 2, 3, 4], 9, false, false)).toEqual({ ids: [], inspect: 9 })
    expect(clickSelection([1, 2], 3, true, true)).toEqual({ ids: [1, 2, 3], inspect: 3 })
    expect(clickSelection([1, 2], 2, true, true)).toEqual({ ids: [1], inspect: 2 })
    expect(clickSelection([1, 2], 3, false, true)).toEqual({ ids: [3], inspect: 3 })
  })

  it('Shift-clicking an enemy on the battlefield keeps the selection', () => {
    const b = createArmyBattle({ player: 'classic', enemy: 'classic', scale: 4 }, 3)
    const foe = b.regiments.find(r => r.side === 1)!, mine = b.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id)
    const canvas = new Canvas(), camera = { ...massCenter(foe), zoom: 20 }, selection = { ids: mine }
    let inspected: number | null = null
    attachInput(canvas as unknown as HTMLCanvasElement, camera, () => b, () => selection.ids, (ids, inspect) => { selection.ids = ids; inspected = inspect }, pointerState())
    canvas.fire('pointerdown', 500, 500, { button: 0, shiftKey: true })
    canvas.fire('pointerup', 500, 500, { button: 0, shiftKey: true })
    expect(selection.ids).toEqual(mine)
    expect(inspected).toBe(foe.id)
  })
})
