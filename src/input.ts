import { screenToWorld, worldToScreen, type Camera, type DragPreview } from './camera'
import { flankHandles, regimentAt } from './sim/formation'
import { right } from './sim/math'
import {
  beginWidth,
  commandAttack,
  commandFront,
  commandMove,
  commandWidth,
  endWidth,
  filesForLateral,
} from './sim/orders'
import type { Battle } from './sim/types'
import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import { unitDef } from './sim/units'

export interface PointerState {
  drag: DragPreview | null
  dragRegId: number | null
  hoverId: number | null
}

interface Session {
  mode: 'none' | 'left' | 'box' | 'front' | 'width' | 'pan'
  pointerId: number
  sx: number
  sy: number
  wx: number
  wy: number
  panX: number
  panY: number
  widthId: number | null
}

export function attachInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  getBattle: () => Battle,
  getSelection: () => number[],
  setSelection: (ids: number[], inspectId: number | null) => void,
  pointer: PointerState,
): void {
  const session: Session = {
    mode: 'none',
    pointerId: -1,
    sx: 0,
    sy: 0,
    wx: 0,
    wy: 0,
    panX: 0,
    panY: 0,
    widthId: null,
  }

  const locate = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect()
    const sx = (event.clientX - rect.left) * (canvas.width / rect.width)
    const sy = (event.clientY - rect.top) * (canvas.height / rect.height)
    const world = screenToWorld(camera, canvas.width, canvas.height, sx, sy)
    return { sx, sy, ...world }
  }

  let gestureOrdered = false

  const orderAt = (x: number, y: number) => {
    const battle = getBattle()
    const ids = playerIds(battle, getSelection())
    const hit = regimentAt(battle, x, y)
    if (hit && hit.side === 1 && ids.length > 0) commandAttack(battle, ids, hit.id)
    else if (ids.length > 0) commandMove(battle, ids, x, y, null)
    gestureOrdered = true
  }

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (gestureOrdered) return
    const point = locate(event)
    orderAt(point.x, point.y)
  })

  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus()
    const point = locate(event)
    session.pointerId = event.pointerId
    session.sx = point.sx
    session.sy = point.sy
    session.wx = point.x
    session.wy = point.y
    gestureOrdered = false
    canvas.setPointerCapture(event.pointerId)
    if (event.button === 1) {
      session.mode = 'pan'
      session.panX = point.sx
      session.panY = point.sy
      return
    }
    if (event.button === 0) {
      const handle = handleAt(getBattle(), getSelection(), camera, canvas, point.sx, point.sy)
      if (handle !== null) {
        session.mode = 'width'
        session.widthId = handle
        beginWidth(getBattle(), handle)
        return
      }
      session.mode = 'left'
      return
    }
    if (event.button === 2) session.mode = 'front'
  })

  canvas.addEventListener('pointermove', (event) => {
    const point = locate(event)
    const battle = getBattle()
    const hovered = regimentAt(battle, point.x, point.y)
    pointer.hoverId = hovered?.id ?? null
    if (session.pointerId !== event.pointerId || session.mode === 'none') return
    if (session.mode === 'pan') {
      camera.x -= (point.sx - session.panX) / camera.zoom
      camera.y += (point.sy - session.panY) / camera.zoom
      session.panX = point.sx
      session.panY = point.sy
      return
    }
    if (session.mode === 'width' && session.widthId !== null) {
      const reg = battle.regiments.find((item) => item.id === session.widthId)
      if (!reg) return
      const axis = right(reg.facing)
      const lateral = (point.x - reg.anchorX) * axis.x + (point.y - reg.anchorY) * axis.y
      commandWidth(battle, reg.id, filesForLateral(unitDef(reg.type).spacing, lateral, reg.aliveCount))
      return
    }
    const moved = Math.hypot(point.sx - session.sx, point.sy - session.sy)
    if (session.mode === 'left' && moved > 8) {
      session.mode = 'box'
      pointer.drag = { kind: 'box', x0: session.wx, y0: session.wy, x1: point.x, y1: point.y }
    } else if (session.mode === 'box') {
      pointer.drag = { kind: 'box', x0: session.wx, y0: session.wy, x1: point.x, y1: point.y }
    } else if ((session.mode === 'front' || pointer.drag?.kind === 'front') && moved > 8) {
      session.mode = 'front'
      const selected = playerIds(battle, getSelection())
      pointer.dragRegId = selected.length === 1 ? selected[0] : null
      pointer.drag = { kind: 'front', x0: session.wx, y0: session.wy, x1: point.x, y1: point.y }
    }
  })

  canvas.addEventListener('pointerup', (event) => {
    if (session.pointerId !== event.pointerId) return
    const point = locate(event)
    const battle = getBattle()
    const moved = Math.hypot(point.sx - session.sx, point.sy - session.sy)
    if (session.mode === 'width' && session.widthId !== null) endWidth(battle, session.widthId)
    if (session.mode === 'box' && pointer.drag?.kind === 'box') {
      const x0 = Math.min(pointer.drag.x0, pointer.drag.x1)
      const x1 = Math.max(pointer.drag.x0, pointer.drag.x1)
      const y0 = Math.min(pointer.drag.y0, pointer.drag.y1)
      const y1 = Math.max(pointer.drag.y0, pointer.drag.y1)
      const ids = battle.regiments
        .filter(
          (reg) =>
            reg.side === 0 &&
            reg.aliveCount > 0 &&
            reg.anchorX >= x0 &&
            reg.anchorX <= x1 &&
            reg.anchorY >= y0 &&
            reg.anchorY <= y1,
        )
        .map((reg) => reg.id)
      const next = event.shiftKey ? unique([...getSelection(), ...ids]) : ids
      setSelection(next, next[0] ?? null)
    } else if (session.mode === 'left' && moved <= 8) {
      const hit = regimentAt(battle, point.x, point.y)
      if (!hit) {
        if (!event.shiftKey) setSelection([], null)
      } else if (hit.side === 1) {
        setSelection([], hit.id)
      } else if (event.shiftKey) {
        const current = getSelection()
        const next = current.includes(hit.id) ? current.filter((id) => id !== hit.id) : [...current, hit.id]
        setSelection(next, hit.id)
      } else if (event.detail === 2) {
        const ids = battle.regiments.filter((reg) => reg.side === 0 && reg.type === hit.type && reg.aliveCount > 0).map((reg) => reg.id)
        setSelection(ids, hit.id)
      } else {
        setSelection([hit.id], hit.id)
      }
    } else if (session.mode === 'front' && moved <= 8) {
      orderAt(point.x, point.y)
    } else if (session.mode === 'front' && moved > 8) {
      const ids = playerIds(battle, getSelection())
      if (ids.length === 1) commandFront(battle, ids[0], session.wx, session.wy, point.x, point.y)
      else if (ids.length > 1) commandMove(battle, ids, point.x, point.y, null)
      gestureOrdered = true
    }
    session.mode = 'none'
    pointer.drag = null
    pointer.dragRegId = null
    session.widthId = null
  })

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const point = locate(event)
      const before = screenToWorld(camera, canvas.width, canvas.height, point.sx, point.sy)
      const minZoom = Math.min(canvas.width / MAP_WIDTH, canvas.height / MAP_HEIGHT) * 0.45
      camera.zoom = clamp(camera.zoom * (event.deltaY < 0 ? 1.08 : 0.92), minZoom, minZoom * 8)
      const after = screenToWorld(camera, canvas.width, canvas.height, point.sx, point.sy)
      camera.x += before.x - after.x
      camera.y += before.y - after.y
    },
    { passive: false },
  )
}

function handleAt(
  battle: Battle,
  selection: number[],
  camera: Camera,
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
): number | null {
  if (selection.length !== 1) return null
  const reg = battle.regiments.find((item) => item.id === selection[0])
  if (!reg || reg.side !== 0 || reg.aliveCount <= 0 || reg.routing) return null
  for (const handle of flankHandles(reg, unitDef(reg.type))) {
    const screen = worldToScreen(camera, canvas.width, canvas.height, handle.x, handle.y)
    if (Math.hypot(screen.x - sx, screen.y - sy) <= 12) return reg.id
  }
  return null
}

function playerIds(battle: Battle, ids: number[]): number[] {
  return ids.filter((id) => {
    const reg = battle.regiments.find((item) => item.id === id)
    return !!reg && reg.side === 0 && reg.aliveCount > 0 && !reg.routing
  })
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)]
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}
