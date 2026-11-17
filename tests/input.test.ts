import { describe, expect, it } from 'vitest'
import { attachInput, type PointerState } from '../src/input'
import { createScenario } from '../src/sim/scenarios'

class Canvas extends EventTarget {
  width = 300
  height = 230
  style = { cursor: '' }
  captured = false
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 230 } }
  setPointerCapture() { this.captured = true }
  hasPointerCapture() { return this.captured }
  releasePointerCapture() { this.captured = false }
  pointer(type: string, x: number, y: number, button = 2) {
    this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: 230-y, pointerId: 1, button, shiftKey: false }))
  }
}

describe('actual pointer event pipeline', () => {
  it('sends group front orders instead of ordinary moves, with matching previews', () => {
    const b = createScenario('line', 1), canvas = new Canvas()
    let selection = b.regiments.filter(r => r.side === 0).slice(0, 2).map(r => r.id)
    const pointer: PointerState = { drag: null, dragRegId: null, hoverId: null }
    attachInput(canvas as unknown as HTMLCanvasElement, { x:150, y:115, zoom:1 }, () => b, () => selection, ids => { selection = ids }, pointer)
    canvas.pointer('pointerdown', 60, 120)
    canvas.pointer('pointermove', 150, 120)
    expect(pointer.drag?.kind).toBe('front')
    canvas.pointer('pointerup', 150, 120)
    const selected = b.regiments.filter(r => selection.includes(r.id))
    expect(selected.every(r => r.order === 'move')).toBe(true)
    expect(selected[0].destY).toBeCloseTo(selected[1].destY)
    expect(selected.every(r => r.destFacing === Math.PI / 2)).toBe(true)
    expect(pointer.drag).toBeNull()
    expect(canvas.captured).toBe(false)
    const before = selected.map(r => [r.destX,r.destY])
    canvas.pointer('contextmenu', 150, 120)
    expect(selected.map(r => [r.destX,r.destY])).toEqual(before)
  })

  it('clears a cancelled drag instead of leaving the preview stuck', () => {
    const b = createScenario('line', 1), canvas = new Canvas()
    const pointer: PointerState = { drag: null, dragRegId: null, hoverId: null }
    attachInput(canvas as unknown as HTMLCanvasElement, { x:150, y:115, zoom:1 }, () => b, () => [b.regiments[0].id], () => {}, pointer)
    canvas.pointer('pointerdown', 60,120); canvas.pointer('pointermove', 150,120)
    canvas.dispatchEvent(new Event('pointercancel'))
    expect(pointer.drag).toBeNull()
    canvas.pointer('pointerup', 150,120)
    expect(b.regiments[0].order).toBe('hold')
  })
})
