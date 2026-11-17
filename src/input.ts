import { screenToWorld, worldToScreen, type Camera, type DragPreview } from './camera'
import { flankHandles, massCenter, regimentAt } from './sim/formation'
import { angDiff, right } from './sim/math'
import {
  beginWidth,
  commandAttack,
  commandGroupFront,
  commandMove,
  commandPlace,
  commandWidth,
  endWidth,
  narrowestFiles,
  planEnd,
  previewGroupFront,
  widestFiles,
  type Placement,
} from './sim/orders'
import type { Battle, Regiment } from './sim/types'
import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import { unitDef } from './sim/units'

export interface PointerState {
  drag: DragPreview | null
  dragRegId: number | null
  hoverId: number | null
}

/** Click/drag threshold in CSS pixels, so it does not halve on high-DPR screens. */
const DRAG_PX = 8

/** What a drag does with a modifier held, under either button: Alt translates the selection, Ctrl rotates it. */
export type Gesture = 'translate' | 'rotate' | null

/** The gesture of the held modifiers, in press order: with both Alt and Ctrl held, the one pressed last wins. */
export function gestureOf(held: Iterable<string>): Gesture {
  let gesture: Gesture = null
  for (const code of held) {
    if (code === 'AltLeft' || code === 'AltRight') gesture = 'translate'
    else if (code === 'ControlLeft' || code === 'ControlRight') gesture = 'rotate'
  }
  return gesture
}

/** A flank-handle drag, measured in the frame the handle is drawn in: the bodies' centre and facing at the grab. */
interface WidthDrag {
  id: number
  cx: number
  cy: number
  ax: number
  ay: number
  lateral0: number
  files0: number
  sent: number
  active: boolean
}

/**
 * Translate / rotate within one right drag. `base` is the layout the active gesture works on (null: where the
 * regiments' plans end), measured from the reference point (rx, ry); `last` is the layout built so far. Each change of
 * gesture freezes `last` as the new base and takes the pointer there as the new reference, so gestures compose.
 */
interface Composition {
  base: Placement[] | null
  active: Gesture
  rx: number
  ry: number
  last: Placement[] | null
}

interface Session {
  /** 'place' is a left drag begun with Alt / Ctrl held: it moves or turns the selection, and never lays a front. */
  mode: 'none' | 'left' | 'box' | 'front' | 'place' | 'width' | 'pan'
  pointerId: number
  sx: number
  sy: number
  wx: number
  wy: number
  panX: number
  panY: number
  width: WidthDrag | null
  compose: Composition
}

interface Located {
  sx: number
  sy: number
  scale: number
  x: number
  y: number
}

export function attachInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  getBattle: () => Battle,
  getSelection: () => number[],
  setSelection: (ids: number[], inspectId: number | null) => void,
  pointer: PointerState,
  /** The held translate / rotate modifier; without it, read from the pointer event (Alt first). */
  gesture?: () => Gesture,
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
    width: null,
    compose: { base: null, active: null, rx: 0, ry: 0, last: null },
  }

  const locate = (event: { clientX: number; clientY: number }): Located => {
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const sx = (event.clientX - rect.left) * scale
    const sy = (event.clientY - rect.top) * (canvas.height / rect.height)
    const world = screenToWorld(camera, canvas.width, canvas.height, sx, sy)
    return { sx, sy, scale, ...world }
  }
  /** Pointer travel since the press, in CSS pixels. */
  const dragged = (point: Located) => Math.hypot(point.sx - session.sx, point.sy - session.sy) / point.scale

  let gestureOrdered = false

  /** A right click: attack the enemy under it or move there. Shift appends it to each regiment's queued orders. */
  const orderAt = (x: number, y: number, queue = false) => {
    const battle = getBattle()
    const ids = playerIds(battle, getSelection())
    const hit = regimentAt(battle, x, y)
    if (hit && hit.side === 1 && ids.length > 0) commandAttack(battle, ids, hit.id, queue)
    else if (ids.length > 0) commandMove(battle, ids, x, y, null, queue)
    gestureOrdered = true
  }

  const gestureNow = (event: { altKey?: boolean; ctrlKey?: boolean }): Gesture =>
    gesture ? gesture() : event.altKey ? 'translate' : event.ctrlKey ? 'rotate' : null

  /** Where the selected regiments' plans end: the layout the first gesture of a drag works on. */
  const planLayout = (battle: Battle): Placement[] | null => {
    const regs = playerIds(battle, getSelection()).map(id => battle.regiments.find(r => r.id === id)!)
    if (!regs.length) return null
    return regs.map(reg => { const end = planEnd(battle, reg); return { id: reg.id, x: end.x, y: end.y, facing: end.facing } })
  }

  /**
   * Alt moves a layout by the pointer's travel from (rx, ry); Ctrl turns it about its centre by the angle the pointer
   * sweeps round that centre from (rx, ry) (or, from a reference near the centre, to face the pointer). Shapes,
   * widths and relative places are kept.
   */
  const transform = (from: Placement[], rx: number, ry: number, point: Located, mode: NonNullable<Gesture>): Placement[] | null => {
    if (mode === 'translate') {
      const dx = point.x - rx, dy = point.y - ry
      return from.map(p => ({ id: p.id, x: p.x + dx, y: p.y + dy, facing: p.facing }))
    }
    const cx = from.reduce((sum, p) => sum + p.x, 0) / from.length, cy = from.reduce((sum, p) => sum + p.y, 0) / from.length
    if (Math.hypot(point.x - cx, point.y - cy) < 1) return null
    const facing = Math.atan2(from.reduce((sum, p) => sum + Math.sin(p.facing), 0), from.reduce((sum, p) => sum + Math.cos(p.facing), 0))
    const start = Math.hypot(rx - cx, ry - cy) >= 2 ? Math.atan2(ry - cy, rx - cx) : facing
    const turn = angDiff(start, Math.atan2(point.y - cy, point.x - cx)), cos = Math.cos(turn), sin = Math.sin(turn)
    return from.map(p => {
      const ox = p.x - cx, oy = p.y - cy
      return { id: p.id, x: cx + ox * cos - oy * sin, y: cy + ox * sin + oy * cos, facing: p.facing + turn }
    })
  }

  /**
   * The translate / rotate layout of this drag, or null while it is no such drag. Gestures compose: when the held
   * gesture changes (the modifier pressed last wins), the layout built so far is frozen and the pointer there becomes
   * the new reference, so Alt then Ctrl turns the moved layout about its new centre, and Ctrl then Alt moves the turned
   * one. Releasing the modifiers keeps what was built. The first gesture is measured from the press, past DRAG_PX.
   */
  const placements = (battle: Battle, point: Located, mode: Gesture): Placement[] | null => {
    const c = session.compose
    if (mode !== c.active) {
      if (c.last) { c.base = c.last; c.rx = point.x; c.ry = point.y }
      c.active = mode
    }
    if (!c.active) return c.base
    if (!c.last && dragged(point) <= DRAG_PX) return null
    const from = c.base ?? planLayout(battle)
    if (!from) return null
    const next = transform(from, c.rx, c.ry, point, c.active)
    if (next) c.last = next
    return c.last
  }

  // A right drag only becomes a front once it is a real drag and long enough for the planners to lay a line;
  // shorter drags stay clicks, so the preview always shows what release will order.
  const frontIds = (battle: Battle, point: Located): number[] | null => {
    if (dragged(point) <= DRAG_PX) return null
    const ids = playerIds(battle, getSelection())
    return ids.length > 0 && previewGroupFront(battle, ids, session.wx, session.wy, point.x, point.y).length > 0 ? ids : null
  }

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    // Windows fires this after pointerup, macOS/Linux on press: the pointer gesture gives the order either way.
    // Only a contextmenu outside any gesture (e.g. the menu key) orders on its own.
    if (gestureOrdered || session.mode !== 'none') return
    const point = locate(event)
    orderAt(point.x, point.y, event.shiftKey)
  })

  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus()
    const point = locate(event)
    session.pointerId = event.pointerId
    session.sx = point.sx
    session.sy = point.sy
    session.wx = point.x
    session.wy = point.y
    session.compose = { base: null, active: null, rx: point.x, ry: point.y, last: null }
    gestureOrdered = false
    canvas.setPointerCapture(event.pointerId)
    if (event.button === 1) {
      session.mode = 'pan'
      session.panX = point.sx
      session.panY = point.sy
      return
    }
    if (event.button === 0) {
      const handle = handleAt(getBattle(), getSelection(), camera, canvas, point.sx, point.sy, point.scale)
      if (handle) {
        session.mode = 'width'
        const centre = massCenter(handle), axis = right(handle.facing)
        session.width = {
          id: handle.id,
          cx: centre.x,
          cy: centre.y,
          ax: axis.x,
          ay: axis.y,
          lateral0: Math.abs((point.x - centre.x) * axis.x + (point.y - centre.y) * axis.y),
          files0: handle.files,
          sent: handle.files,
          active: false,
        }
        beginWidth(getBattle(), handle.id)
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
    const attackable = !!hovered && hovered.side === 1 && playerIds(battle, getSelection()).length > 0
    canvas.style.cursor = attackable ? 'crosshair' : ''
    if (session.pointerId !== event.pointerId || session.mode === 'none') return
    if (session.mode === 'pan') {
      if (camera.glide) camera.glide = null
      camera.x -= (point.sx - session.panX) / camera.zoom
      camera.y += (point.sy - session.panY) / camera.zoom
      session.panX = point.sx
      session.panY = point.sy
      return
    }
    if (session.mode === 'width' && session.width) {
      const drag = session.width
      const reg = battle.regiments.find((item) => item.id === drag.id)
      if (!reg) return
      if (!drag.active && dragged(point) <= DRAG_PX) return
      drag.active = true
      // Relative to the grab: the handle moves half a spacing per file, so it stays under the pointer.
      const lateral = Math.abs((point.x - drag.cx) * drag.ax + (point.y - drag.cy) * drag.ay)
      const widest = widestFiles(reg)
      const files = clamp(
        drag.files0 + Math.round((2 * (lateral - drag.lateral0)) / unitDef(reg.type).spacing),
        Math.min(narrowestFiles(reg), widest),
        Math.max(1, widest),
      )
      if (files === drag.sent) return
      drag.sent = files
      commandWidth(battle, reg.id, files)
      return
    }
    // A left drag with Alt / Ctrl held and regiments selected moves or turns them, like a right drag; any other
    // left drag draws the selection box. Which it is is settled once, as the press becomes a drag.
    if (session.mode === 'left' && dragged(point) > DRAG_PX) {
      session.mode = gestureNow(event) && playerIds(battle, getSelection()).length > 0 ? 'place' : 'box'
    }
    if (session.mode === 'box') {
      pointer.drag = { kind: 'box', x0: session.wx, y0: session.wy, x1: point.x, y1: point.y }
    } else if (session.mode === 'front' || session.mode === 'place') {
      const places = placements(battle, point, gestureNow(event))
      if (places) {
        pointer.dragRegId = null
        pointer.drag = { kind: 'place', x0: session.compose.rx, y0: session.compose.ry, x1: point.x, y1: point.y, places }
        return
      }
      if (session.mode === 'place') { pointer.drag = null; return }
      const ids = frontIds(battle, point)
      pointer.dragRegId = ids?.length === 1 ? ids[0] : null
      pointer.drag = ids ? { kind: 'front', x0: session.wx, y0: session.wy, x1: point.x, y1: point.y } : null
    }
  })

  canvas.addEventListener('pointerup', (event) => {
    if (session.pointerId !== event.pointerId) return
    const point = locate(event)
    const battle = getBattle()
    if (session.mode === 'width' && session.width) endWidth(battle, session.width.id)
    if (session.mode === 'box' && pointer.drag?.kind === 'box') {
      const x0 = Math.min(pointer.drag.x0, pointer.drag.x1)
      const x1 = Math.max(pointer.drag.x0, pointer.drag.x1)
      const y0 = Math.min(pointer.drag.y0, pointer.drag.y1)
      const y1 = Math.max(pointer.drag.y0, pointer.drag.y1)
      const ids = battle.regiments
        .filter((reg) => reg.side === 0 && reg.aliveCount > 0 && bodiesInBox(reg, x0, y0, x1, y1))
        .map((reg) => reg.id)
      const next = event.shiftKey ? unique([...getSelection(), ...ids]) : ids
      setSelection(next, next[0] ?? null)
    } else if (session.mode === 'left' && dragged(point) <= DRAG_PX) {
      const hit = regimentAt(battle, point.x, point.y)
      if (!hit) {
        if (!event.shiftKey) setSelection([], null)
      } else {
        const next = clickSelection(getSelection(), hit.id, event.shiftKey, hit.side === 0)
        setSelection(next.ids, next.inspect)
      }
    } else if (session.mode === 'front' || session.mode === 'place') {
      const places = placements(battle, point, gestureNow(event))
      // Only the right button lays a front or gives the click order; a left drag that built no layout orders nothing.
      const ids = places || session.mode === 'place' ? null : frontIds(battle, point)
      if (places) {
        commandPlace(battle, places, event.shiftKey)
        gestureOrdered = true
      } else if (ids) {
        commandGroupFront(battle, ids, session.wx, session.wy, point.x, point.y, event.shiftKey)
        gestureOrdered = true
      } else if (session.mode === 'front') orderAt(session.wx, session.wy, event.shiftKey)
    }
    session.mode = 'none'
    pointer.drag = null
    pointer.dragRegId = null
    session.width = null
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  })

  canvas.addEventListener('pointercancel', () => {
    if (session.width) endWidth(getBattle(), session.width.id)
    session.mode = 'none'
    session.pointerId = -1
    session.width = null
    pointer.drag = null
    pointer.dragRegId = null
  })

  canvas.addEventListener('dblclick', event => {
    const point = locate(event), battle = getBattle()
    const hit = regimentAt(battle, point.x, point.y)
    if (!hit || hit.side !== 0) return
    const ids = battle.regiments.filter(r => r.side === 0 && r.type === hit.type && r.aliveCount > 0 && !r.routing).map(r => r.id)
    setSelection(ids, hit.id)
  })

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      // Horizontal touchpad swipes and Shift+wheel carry no vertical delta: they do not zoom.
      if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const point = locate(event)
      const before = screenToWorld(camera, canvas.width, canvas.height, point.sx, point.sy)
      const minZoom = Math.min(canvas.width / MAP_WIDTH, canvas.height / MAP_HEIGHT) * 0.45
      // Close enough to see a single man's kit: 46 CSS px to the metre, or eight times the widest view if that is closer still.
      const maxZoom = Math.max(minZoom * 8, 46 * point.scale)
      if (camera.glide !== undefined) {
        // An easing view: each notch moves the target, about whatever is under the pointer now.
        const from = camera.glide?.zoom ?? camera.zoom
        camera.glide = { zoom: clamp(from * (event.deltaY < 0 ? 1.16 : 1 / 1.16), minZoom, maxZoom), sx: point.sx, sy: point.sy, wx: before.x, wy: before.y }
        return
      }
      camera.zoom = clamp(camera.zoom * (event.deltaY < 0 ? 1.08 : 0.92), minZoom, maxZoom)
      const after = screenToWorld(camera, canvas.width, canvas.height, point.sx, point.sy)
      camera.x += before.x - after.x
      camera.y += before.y - after.y
    },
    { passive: false },
  )
}

/**
 * Selection after clicking a regiment (battlefield body or roster card). Shift/Ctrl adds or removes;
 * a regiment that cannot join the selection (enemy, routing, destroyed) is only inspected, and with a
 * modifier held the existing selection is kept.
 */
export function clickSelection(selection: number[], id: number, additive: boolean, selectable: boolean): { ids: number[]; inspect: number } {
  if (!selectable) return { ids: additive ? selection : [], inspect: id }
  if (!additive) return { ids: [id], inspect: id }
  return { ids: selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id], inspect: id }
}

export interface KeyActions {
  /** True while another surface (the setup dialog) owns the keyboard. */
  ignore: () => boolean
  toggleRun: () => void
  /** F: switch the selected missile units between shooting and melee. */
  toggleMelee: () => void
  togglePause: () => void
  /** M: sound on or off. */
  toggleSound?: () => void
  /** Ctrl/Cmd+A: select every regiment the player can command. */
  selectAll?: () => void
  saveGroup: (digit: number) => void
  recallGroup: (digit: number) => void
}

/**
 * Battle hotkeys. Keys the battle uses are cancelled on every keydown, auto-repeats included (and Space/Alt
 * on keyup), so a focused HUD button, roster card or select never also acts on them: held Space does not
 * click, arrows do not change the scenario select, Alt+Arrow does not navigate, Ctrl+digit does not switch tabs,
 * Ctrl+A does not select the page's text.
 */
export function attachKeys(target: EventTarget, held: Set<string>, actions: KeyActions): void {
  // The A of a Ctrl/Cmd+A, from its press to its release: it selects the army once and never pans the camera,
  // even if Ctrl is let go first.
  let chordA = false
  target.addEventListener('keydown', (raw) => {
    const event = raw as KeyboardEvent
    if (actions.ignore()) return
    const digit = digitOf(event.code)
    const command = event.ctrlKey || event.metaKey
    if (event.code === 'KeyA' && (command || chordA)) {
      event.preventDefault()
      held.delete('KeyA')
      if (!chordA) actions.selectAll?.()
      chordA = true
      return
    }
    if (battleKey(event.code, digit, command)) event.preventDefault()
    held.add(event.code)
    if (event.repeat) return
    // Letter hotkeys act only without Ctrl/Cmd: Ctrl is the rotate modifier and Ctrl+R/F/P stay browser shortcuts.
    if (!command && event.code === 'KeyR') actions.toggleRun()
    if (!command && event.code === 'KeyF') actions.toggleMelee()
    if (!command && event.code === 'KeyP') actions.togglePause()
    if (!command && event.code === 'KeyM') actions.toggleSound?.()
    if (digit === null) return
    if (command) actions.saveGroup(digit)
    else actions.recallGroup(digit)
  })
  target.addEventListener('keyup', (raw) => {
    const event = raw as KeyboardEvent
    held.delete(event.code)
    if (event.code === 'KeyA') chordA = false
    if (!actions.ignore() && (event.code === 'Space' || event.code === 'AltLeft' || event.code === 'AltRight')) event.preventDefault()
  })
}

function battleKey(code: string, digit: number | null, command: boolean): boolean {
  if (code === 'Space' || code === 'AltLeft' || code === 'AltRight' || code.startsWith('Arrow') || digit !== null) return true
  // Plain letters only: Ctrl/Cmd+R, +P, +W, +S, +F keep their browser meaning.
  return !command && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyP', 'KeyR', 'KeyF'].includes(code)
}

function digitOf(code: string): number | null {
  if (!/^Digit[1-9]$/.test(code)) return null
  return Number(code.slice(5))
}

/**
 * Pause while the page is hidden and resume on return only if the battle was running, so the default
 * Worker mode behaves like the main-thread mode, whose requestAnimationFrame loop stops in a hidden tab.
 */
export function pauseWhileHidden(
  doc: EventTarget & { hidden: boolean },
  win: EventTarget,
  running: () => boolean,
  setPaused: (paused: boolean) => void,
  canResume: () => boolean = () => true,
): void {
  let resume = false
  const hide = () => {
    if (resume || !running()) return
    resume = true
    setPaused(true)
  }
  const show = () => {
    if (!resume || doc.hidden) return
    resume = false
    if (canResume()) setPaused(false)
  }
  doc.addEventListener('visibilitychange', () => (doc.hidden ? hide() : show()))
  win.addEventListener('pagehide', hide)
  win.addEventListener('pageshow', show)
  // A page opened in a background tab fires no visibilitychange until it is first shown.
  if (doc.hidden) hide()
}

function handleAt(
  battle: Battle,
  selection: number[],
  camera: Camera,
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  /** Canvas pixels per CSS pixel: handles are drawn and grabbed at a fixed CSS size (RenderInput.pixelRatio). */
  scale = 1,
): Regiment | null {
  if (selection.length !== 1) return null
  const reg = battle.regiments.find((item) => item.id === selection[0])
  if (!reg || reg.side !== 0 || reg.aliveCount <= 0 || reg.routing) return null
  for (const handle of flankHandles(reg, unitDef(reg.type))) {
    const screen = worldToScreen(camera, canvas.width, canvas.height, handle.x, handle.y)
    if (Math.hypot(screen.x - sx, screen.y - sy) <= 12 * scale) return reg
  }
  return null
}

/** Box selection tests the bodies on screen, like click selection, not the formation's front-centre anchor. */
function bodiesInBox(reg: Regiment, x0: number, y0: number, x1: number, y1: number): boolean {
  const radius = unitDef(reg.type).radius
  return reg.soldiers.some((s) => s.alive && Math.hypot(s.x - clamp(s.x, x0, x1), s.y - clamp(s.y, y0, y1)) <= radius)
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
