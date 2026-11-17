import { worldToScreen, type Camera, type DragPreview } from './camera'
import { chargeStrength, fatigueMods } from './sim/combat'
import { flankHandles, formationCorners, massCenter } from './sim/formation'
import { angDiff, forward, right } from './sim/math'
import { previewFront, previewGroupFront, type FrontPreview } from './sim/orders'
import type { Battle, Regiment, UnitDef, Side } from './sim/types'
import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import { unitDef } from './sim/units'
import { FATIGUE, FATIGUE_NAMES } from './sim/mechanics'
import {spriteBatch,type SpriteBatch} from './sprite-batch'
import { GROUND_PPM, VOID_COLOR, groundFor, groundRect, skyLayers } from './scene/ground'
import { STEPS, figureExtent, figureVariants, paintFigure, splitsWeapon, type FigureState, type Pose } from './scene/figures'
import { advance, drawParticles, sceneOf, shake, watch, type Body, type Scene, type SoundSink } from './scene/fx'
import { TITLE_FONT, UNIT_GLYPH, drawBanner } from './scene/banners'

export interface RenderInput {
  battle: Battle
  camera: Camera
  selection: number[]
  hoverId: number | null
  drag: DragPreview | null
  dragRegId: number | null
  showBoxes: boolean
  /** Held Space: every regiment on the field, of both sides, shows its fatigue panel. */
  showStamina: boolean
  alpha?: number
  visualTime?: number
  cacheSprites?: boolean
  /** Canvas pixels per CSS pixel. Overlays keep their CSS size; omitted, it is measured from the canvas. */
  pixelRatio?: number
  /** Wall clock in milliseconds, for motion that runs while the battle is paused (flags, camera shake). */
  wallTime?: number
  /** Told about what the scene sees happen: blows, deaths, charges going home, volleys. */
  sound?: SoundSink
}

/** Canvas pixels per CSS pixel for labels, bars, handles and overlay strokes in the current render. */
let ui=1
/** The battle last drawn; a different one starts with a clean field. */
let sceneBattle: Battle | null = null
let lastWall = -1

const patterns = new WeakMap<object, Map<object, CanvasPattern | null>>()
/** A repeating fill of `tile`, scaled and pinned to a screen point so it pans and zooms with the field. */
function tiled(ctx: CanvasRenderingContext2D, tile: CanvasImageSource, scale: number, x: number, y: number): CanvasPattern | string {
  let made = patterns.get(ctx)
  if (!made) { made = new Map(); patterns.set(ctx, made) }
  let pattern = made.get(tile as object)
  if (pattern === undefined) { pattern = ctx.createPattern(tile, 'repeat'); made.set(tile as object, pattern) }
  if (!pattern) return 'rgba(0,0,0,0)'
  pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, x, y]))
  return pattern
}

export function render(canvas: HTMLCanvasElement, view: RenderInput): void {
  // Present completed frames through the compositor. Low-latency front-buffer
  // rendering can expose our intermediate background repaint as a visible flash.
  const ctx = canvas.getContext('2d',{alpha:false,desynchronized:false})
  if (!ctx) return
  const { width, height } = canvas
  const { battle } = view
  const ratio=view.pixelRatio??(canvas.clientWidth>0?width/canvas.clientWidth:1)
  ui=Number.isFinite(ratio)&&ratio>0?ratio:1
  const wall = (view.wallTime ?? (typeof performance === 'undefined' ? 0 : performance.now())) / 1000
  const wallStep = lastWall < 0 ? 0 : Math.min(0.1, Math.max(0, wall - lastWall))
  lastWall = wall
  const visual = view.visualTime ?? battle.time
  const scene = sceneOf(battle)
  const fresh = sceneBattle !== battle
  sceneBattle = battle
  const ground = groundFor(battle.seed, fresh), sky = skyLayers()
  advance(scene, visual, wallStep)
  const steady = view.camera
  // Blood and sparks are skipped from far out, where they would be smaller than a pixel.
  watch(scene, ground, steady.zoom >= 7 * ui, Math.max(0.35, Math.min(1, steady.zoom / (10 * ui))), (x, y) => {
    const p = worldToScreen(steady, width, height, x, y)
    return p.x < 0 || p.y < 0 || p.x > width || p.y > height ? 0 : Math.max(0.3, Math.min(1.3, steady.zoom / (14 * ui)))
  }, view.sound)
  const [jx, jy] = shake(scene, wall, 7 * ui)
  const camera: Camera = jx || jy ? { x: steady.x + jx / steady.zoom, y: steady.y + jy / steady.zoom, zoom: steady.zoom } : steady
  // Select detail per glyph below. A global world-zoom cutoff also disabled
  // batching for thousands of bodies on high-DPI or simply larger windows.
  const cacheSprites=view.cacheSprites!==false
  if(cacheSprites) prepareGlyphs(battle,camera.zoom,canvas)
  glyphSerial++
  const batch=cacheSprites&&glyphBatch?.begin(width,height,glyphGeneration)?glyphBatch:null
  // The opaque background replaces every pixel; clearing first is redundant.
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, width, height)

  const origin = worldToScreen(camera, width, height, 0, 0)
  const far = worldToScreen(camera, width, height, MAP_WIDTH, MAP_HEIGHT)
  const left = origin.x
  const top = far.y
  const mapW = far.x - origin.x
  const mapH = origin.y - far.y
  if (ground) {
    const [x, y, w, h] = groundRect(origin.x, origin.y, camera.zoom)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(ground.canvas, x, y, w, h)
    // Past the texture's own resolution the turf gets its blades back from a repeating close-up layer.
    const close = Math.min(1, (camera.zoom - GROUND_PPM * 1.3 * ui) / (GROUND_PPM * 3 * ui))
    if (sky && close > 0) {
      ctx.globalAlpha = close * 0.6
      for (const metres of [7.3, 11.9]) {
        ctx.fillStyle = tiled(ctx, sky.blades.canvas, metres * camera.zoom / 256, origin.x, origin.y)
        ctx.fillRect(left, top, mapW, mapH)
      }
      ctx.globalAlpha = 1
    }
  } else {
    ctx.fillStyle = '#5f733f'
    ctx.fillRect(left, top, mapW, mapH)
  }
  if (view.showBoxes) {
    // Held Space lays a 10 m survey grid over the field.
    ctx.strokeStyle = 'rgba(244, 236, 206, 0.1)'
    ctx.lineWidth = ui
    ctx.beginPath()
    for (let x = 10; x < MAP_WIDTH; x += 10) { ctx.moveTo(left + x * camera.zoom, top); ctx.lineTo(left + x * camera.zoom, top + mapH) }
    for (let y = 10; y < MAP_HEIGHT; y += 10) { ctx.moveTo(left, top + y * camera.zoom); ctx.lineTo(left + mapW, top + y * camera.zoom) }
    ctx.stroke()
  }
  // The edge of the field: a dark seam with a pale line inside it.
  ctx.strokeStyle = 'rgba(10, 12, 8, 0.5)'
  ctx.lineWidth = 4 * ui
  ctx.strokeRect(left - 2 * ui, top - 2 * ui, mapW + 4 * ui, mapH + 4 * ui)
  ctx.strokeStyle = 'rgba(236, 222, 178, 0.42)'
  ctx.lineWidth = ui
  ctx.strokeRect(left, top, mapW, mapH)

  ctx.fillStyle = 'rgba(236, 226, 196, 0.5)'
  ctx.font = `${Math.max(13 * ui, camera.zoom * 2.4)}px ${TITLE_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const south = worldToScreen(camera, width, height, MAP_WIDTH / 2, -5)
  const north = worldToScreen(camera, width, height, MAP_WIDTH / 2, MAP_HEIGHT + 5)
  ctx.fillText('南', south.x, south.y)
  ctx.fillText('北', north.x, north.y)
  ctx.textBaseline = 'alphabetic'

  if (view.drag?.kind === 'box') drawBox(ctx, camera, width, height, view.drag)
  if (view.drag?.kind === 'front') {
    const d = view.drag
    for (const plan of previewGroupFront(battle, view.selection, d.x0, d.y0, d.x1, d.y1)) {
      drawFrontPreview(ctx, camera, width, height, battle, plan.id, d, plan)
    }
  }
  if (view.drag?.kind === 'place') {
    const d = view.drag
    for (const p of d.places ?? []) {
      const reg = battle.regiments.find(r => r.id === p.id)
      if (!reg) continue
      const half = (Math.max(1, Math.min(reg.files, reg.aliveCount)) - 1) * unitDef(reg.type).spacing / 2, side = right(p.facing)
      drawFrontPreview(ctx, camera, width, height, battle, p.id, d, { ...p, files: Math.max(1, Math.min(reg.files, reg.aliveCount)),
        x1: p.x - side.x * half, y1: p.y - side.y * half, x2: p.x + side.x * half, y2: p.y + side.y * half })
    }
  }
  for (const reg of battle.regiments) {
    if (reg.side !== 0 || reg.aliveCount <= 0 || reg.routing) continue
    if (!view.showBoxes && !view.selection.includes(reg.id)) continue
    if (reg.order === 'move') drawMoveOrder(ctx, camera, width, height, reg)
    if (reg.queue.length) drawQueue(ctx, camera, width, height, battle, reg)
  }

  for (const reg of battle.regiments) {
    if(reg.routing) continue
    const selected = view.selection.includes(reg.id)
    const hovered = view.hoverId === reg.id
    if ((selected || view.showBoxes) && reg.aliveCount > 0) drawWeaponRange(ctx, camera, width, height, reg, selected)
    if (!selected && !hovered && !view.showBoxes) continue
    const color = selected ? '#ffe08a' : view.showBoxes ? 'rgba(255, 224, 138, 0.7)' : 'rgba(255, 224, 138, 0.45)'
    strokeFormation(ctx, camera, width, height, reg, color)
  }

  // The fallen lie under the living; both go through the same glyph batch.
  for (const corpse of scene.corpses) {
    const p = worldToScreen(camera, width, height, corpse.x, corpse.y)
    if (p.x < -40 || p.y < -40 || p.x > width + 40 || p.y > height + 40) continue
    drawFigure(ctx, batch, cacheSprites, corpse.def, corpse.side, camera.zoom, p.x, p.y, corpse.heading, 'dead', -1, -1, corpse.variant % figureVariants(corpse.def), false, false, false, 4)
  }
  const chosen = new Set(view.selection)
  for (const body of scene.live) drawBody(ctx, camera, width, height, scene, body, chosen.has(body.reg.id), view.alpha ?? 1, cacheSprites, batch)
  drawInked(ctx,under)
  batch?.flush(ctx)
  drawInked(ctx,over)

  drawProjectiles(ctx, camera, width, height, battle)
  drawParticles(ctx, scene, camera.zoom, width, height, x => width / 2 + (x - camera.x) * camera.zoom, y => height / 2 - (y - camera.y) * camera.zoom)

  if (sky) {
    // Cloud shadow drifts over field and troops alike, then the lens darkens toward its corners.
    const drift = visual * camera.zoom
    ctx.fillStyle = tiled(ctx, sky.clouds.canvas, 420 * camera.zoom / 256, origin.x + drift * 1.3, origin.y + drift * 0.45)
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(sky.vignette.canvas, 0, 0, width, height)
  }

  for (const reg of battle.regiments) {
    if (reg.aliveCount <= 0) continue
    const selected = chosen.has(reg.id)
    drawRegimentMarks(ctx, camera, width, height, reg, selected, selected || view.hoverId === reg.id || view.showBoxes, view.showStamina, visual, wall)
  }
  drawAttackOrders(ctx, camera, width, height, battle, view.selection, view.showStamina)

  if (view.selection.length === 1) {
    const reg = battle.regiments.find((item) => item.id === view.selection[0])
    if (reg && reg.side === 0 && reg.aliveCount > 0 && !reg.routing) {
      const def = unitDef(reg.type)
      for (const handle of flankHandles(reg, def)) {
        const p = worldToScreen(camera, width, height, handle.x, handle.y)
        ctx.fillStyle = '#ffe08a'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 6 * ui, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(20, 16, 8, 0.8)'
        ctx.lineWidth = 1.5 * ui
        ctx.stroke()
      }
    }
  }

  ctx.font = `bold ${Math.round(Math.max(11 * ui, Math.min(17 * ui, camera.zoom * 0.8)))}px "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.lineJoin = 'round'
  for (const floater of battle.fx) {
    const p = worldToScreen(camera, width, height, floater.x, floater.y + (0.75 - floater.life) * 2.4)
    ctx.globalAlpha = Math.max(0, Math.min(1, floater.life * 2.2))
    ctx.strokeStyle = 'rgba(40, 10, 6, 0.85)'
    ctx.lineWidth = 3 * ui
    ctx.strokeText(floater.text, p.x, p.y)
    ctx.fillStyle = '#ffe9c2'
    ctx.fillText(floater.text, p.x, p.y)
    ctx.globalAlpha = 1
  }
}

/** Arrows fly as pale shafts above their shadows; shot leaves a short bright streak. One path per colour. */
function drawProjectiles(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number, battle: Battle): void {
  if (!battle.projectiles.length) return
  const shadows: number[] = [], shafts: number[] = [], tracers: number[] = []
  const length = Math.max(5 * ui, camera.zoom * 0.95)
  for (const projectile of battle.projectiles) {
    const g = worldToScreen(camera, width, height, projectile.x, projectile.y)
    if (g.x < -60 || g.y < -60 || g.x > width + 60 || g.y > height + 60) continue
    const speed = Math.hypot(projectile.vx, projectile.vy) || 1, dx = projectile.vx / speed, dy = -projectile.vy / speed
    if (projectile.arc) {
      const lift = Math.max(0, projectile.z) * camera.zoom * 0.55
      shadows.push(g.x - dx * length * 0.6, g.y - dy * length * 0.6, g.x, g.y)
      shafts.push(g.x - dx * length, g.y - lift - dy * length, g.x, g.y - lift)
    } else {
      const streak = Math.max(8 * ui, speed * 0.035 * camera.zoom)
      tracers.push(g.x - dx * streak, g.y - dy * streak, g.x, g.y)
    }
  }
  const strokeAll = (lines: number[], colour: string, lineWidth: number) => {
    if (!lines.length) return
    ctx.strokeStyle = colour; ctx.lineWidth = lineWidth
    ctx.beginPath()
    for (let i = 0; i < lines.length; i += 4) { ctx.moveTo(lines[i], lines[i + 1]); ctx.lineTo(lines[i + 2], lines[i + 3]) }
    ctx.stroke()
  }
  ctx.lineCap = 'round'
  strokeAll(shadows, 'rgba(10, 14, 8, 0.3)', Math.max(ui, camera.zoom * 0.07))
  strokeAll(shafts, 'rgba(60, 44, 26, 0.9)', Math.max(ui, camera.zoom * 0.07) + ui)
  strokeAll(shafts, '#f1e4bd', Math.max(ui, camera.zoom * 0.07))
  strokeAll(tracers, 'rgba(255, 214, 130, 0.35)', 3.2 * ui)
  strokeAll(tracers, '#fff6da', 1.2 * ui)
  ctx.lineCap = 'butt'
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  drag: DragPreview,
): void {
  const a = worldToScreen(camera, width, height, drag.x0, drag.y0)
  const b = worldToScreen(camera, width, height, drag.x1, drag.y1)
  ctx.strokeStyle = 'rgba(224, 194, 122, 0.9)'
  ctx.lineWidth = ui
  ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
}

function drawFrontPreview(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  battle: Battle,
  regId: number,
  drag: DragPreview,
  planned?: FrontPreview,
): void {
  const preview = planned ?? previewFront(battle, regId, drag.x0, drag.y0, drag.x1, drag.y1)
  if (!preview) return
  const a = worldToScreen(camera, width, height, preview.x1, preview.y1)
  const b = worldToScreen(camera, width, height, preview.x2, preview.y2)
  ctx.strokeStyle = '#e0c27a'
  ctx.lineWidth = 2 * ui
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  const reg = battle.regiments.find((item) => item.id === regId)
  if (!preview || !reg) return
  const def = unitDef(reg.type)
  const ranks = Math.max(1, Math.ceil(reg.aliveCount / preview.files))
  const halfW = ((preview.files - 1) * def.spacing) / 2 + def.radius
  const depth = (ranks - 1) * def.rankSpacing + def.radius
  const fwd = forward(preview.facing)
  const rgt = right(preview.facing)
  const corner = (lx: number, ly: number) =>
    worldToScreen(
      camera,
      width,
      height,
      preview.x + rgt.x * lx + fwd.x * ly,
      preview.y + rgt.y * lx + fwd.y * ly,
    )
  const corners = [
    corner(-halfW, def.radius),
    corner(halfW, def.radius),
    corner(halfW, -depth),
    corner(-halfW, -depth),
  ]
  ctx.strokeStyle = 'rgba(224, 194, 122, 0.75)'
  ctx.setLineDash([6 * ui, 4 * ui])
  strokePoly(ctx, corners)
  ctx.setLineDash([])
}

/** Shift-queued steps: a dashed path from where the current order ends through each queued spot or target. */
function drawQueue(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number, battle: Battle, reg: Regiment): void {
  let from = reg.order === 'move' ? { x: reg.destX, y: reg.destY } : formationMid(reg)
  ctx.lineWidth = 1.5 * ui
  ctx.setLineDash([5 * ui, 5 * ui])
  for (const item of reg.queue) {
    const target = item.kind === 'attack' ? battle.regiments.find(r => r.id === item.targetId) : undefined
    if (item.kind === 'attack' && (!target || target.aliveCount <= 0)) continue
    const to = item.kind === 'move' ? { x: item.x, y: item.y } : formationMid(target!)
    const a = worldToScreen(camera, width, height, from.x, from.y), b = worldToScreen(camera, width, height, to.x, to.y)
    ctx.strokeStyle = item.kind === 'move' ? 'rgba(224, 194, 122, 0.7)' : 'rgba(214, 72, 52, 0.75)'
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.fillStyle = ctx.strokeStyle
    ctx.beginPath()
    ctx.arc(b.x, b.y, 3.5 * ui, 0, Math.PI * 2)
    ctx.fill()
    from = to
  }
  ctx.setLineDash([])
}

function drawMoveOrder(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  reg: Regiment,
): void {
  const dist = Math.hypot(reg.destX - reg.anchorX, reg.destY - reg.anchorY)
  const turn = Math.abs(angDiff(reg.facing, reg.destFacing))
  if (dist < 1.2 && turn < 0.12) return
  const def = unitDef(reg.type)
  const files = Math.max(1, Math.min(reg.destFiles, reg.aliveCount))
  const ranks = Math.max(1, Math.ceil(reg.aliveCount / files))
  const halfW = ((files - 1) * def.spacing) / 2 + def.radius
  const depth = (ranks - 1) * def.rankSpacing + def.radius
  const fwd = forward(reg.destFacing)
  const rgt = right(reg.destFacing)
  const corner = (lx: number, ly: number) =>
    worldToScreen(camera, width, height, reg.destX + rgt.x * lx + fwd.x * ly, reg.destY + rgt.y * lx + fwd.y * ly)
  const corners = [corner(-halfW, def.radius), corner(halfW, def.radius), corner(halfW, -depth), corner(-halfW, -depth)]
  ctx.strokeStyle = 'rgba(224, 194, 122, 0.85)'
  ctx.lineWidth = 2 * ui
  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  ctx.lineTo(corners[1].x, corners[1].y)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(224, 194, 122, 0.55)'
  ctx.setLineDash([6 * ui, 4 * ui])
  strokePoly(ctx, corners)
  ctx.setLineDash([])
  const mark = worldToScreen(camera, width, height, reg.destX, reg.destY)
  ctx.fillStyle = '#e0c27a'
  ctx.beginPath()
  ctx.arc(mark.x, mark.y, 3.5 * ui, 0, Math.PI * 2)
  ctx.fill()
}

function drawWeaponRange(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  reg: Regiment,
  selected: boolean,
): void {
  const missile = unitDef(reg.type).missile
  if (!missile || reg.meleeMode) return
  const range = missile.range
  const fireHalf = (missile.cone / 2) * (Math.PI / 180)
  const mid = massCenter(reg)
  const steps = 28
  ctx.beginPath()
  const origin = worldToScreen(camera, width, height, mid.x, mid.y)
  ctx.moveTo(origin.x, origin.y)
  for (let i = 0; i <= steps; i++) {
    const angle = reg.facing - fireHalf + (2 * fireHalf * i) / steps
    const point = worldToScreen(
      camera,
      width,
      height,
      mid.x + Math.cos(angle) * range,
      mid.y + Math.sin(angle) * range,
    )
    ctx.lineTo(point.x, point.y)
  }
  ctx.closePath()
  ctx.fillStyle = selected ? 'rgba(232, 214, 160, 0.12)' : 'rgba(232, 214, 160, 0.06)'
  ctx.fill()
  ctx.strokeStyle = selected ? 'rgba(232, 214, 160, 0.9)' : 'rgba(232, 214, 160, 0.5)'
  ctx.lineWidth = (selected ? 1.5 : 1) * ui
  ctx.setLineDash([5 * ui, 5 * ui])
  ctx.stroke()
  ctx.setLineDash([])
}

function strokeFormation(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  reg: Regiment,
  color: string,
): void {
  const corners = formationCorners(reg, unitDef(reg.type)).map((point) =>
    worldToScreen(camera, width, height, point.x, point.y),
  )
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5 * ui
  strokePoly(ctx, corners)
}

function strokePoly(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  ctx.closePath()
  ctx.stroke()
}

// Bodies are drawn from a few atlas textures, each glyph already turned to its heading. This
// avoids thousands of save/rotate/restore calls and tiny canvas texture swaps.
// `used` is the glyphSerial of the last queue/draw.
interface Glyph {page:HTMLCanvasElement;x:number;y:number;slot:number;used:number}
/**
 * The glyphs of one cell size. Each size has its own pages of the atlas, so a swordsman's glyph does not take the
 * room of a lancer's, and its own least-recently-used order (`glyphs` is kept in it): the first entry is the one to
 * give up. `filled` counts the cells handed out so far.
 */
interface GlyphClass {cell:number;columns:number;perPage:number;pages:number[];filled:number;glyphs:Map<number,Glyph>}
const glyphClasses=new Map<number,GlyphClass>()
const glyphPages:{canvas:HTMLCanvasElement;pen:CanvasRenderingContext2D}[]=[]
/** Atlas pages in all, 4 MiB each. */
const GLYPH_PAGES=16
/** Frames after which an unused glyph gives up its cell before its class takes another page. */
const GLYPH_IDLE=600
const glyphTypes=new WeakMap<UnitDef,number>()
/** A weapon kept as its own glyph, painted pointing along +x at `fine` times the size and turned by the sprite layer. */
interface ArmStyle {half:number;fine:number;glyphs:GlyphClass}
/**
 * How one unit type is drawn in this glyph generation. `mode`: 0 a whole cached glyph, 1 a cached body with its
 * weapon apart, 2 drawn in place every frame. `zoom` is the zoom its glyph is painted at and `scale` how much
 * the glyph is stretched on screen (1 unless the body outgrew a cell); `half` is the glyph's half-extent as painted and
 * `cull` the whole figure's on screen. `arm` is set when the weapon apart is a glyph too; otherwise it is drawn in place.
 */
interface GlyphStyle {r:number;half:number;mode:0|1|2;zoom:number;scale:number;cull:number;glyphs:GlyphClass;arm:ArmStyle|null}
const glyphStyles=new Map<UnitDef,GlyphStyle>()
/** The largest half-extent a body's glyph cell holds. */
const GLYPH_HALF=64
/** A body too big for a cell is painted smaller and stretched up to this much; past it, it is drawn in place. */
const GLYPH_STRETCH=2.5
/** A figure wider than this with its weapon is cached as a body and a weapon apart: it is the weapon that makes it so wide. */
const SPLIT_HALF=16
/** The largest half-extent a weapon's glyph holds as painted; a longer weapon is drawn in place. */
const ARM_HALF=128
let nextGlyphType=0
let spriteZoom=-1
let glyphGeneration=0
/** Advances every render and every batch flush; a glyph used in the current serial may still be queued. */
let glyphSerial=0
let spriteBattle:Battle|null=null
let spriteCanvas:HTMLCanvasElement|null=null
/** The WebGL layer for this generation, or null when bodies go straight to the Canvas. */
let glyphBatch:SpriteBatch|null=null
/** The zoom seen last frame and for how many frames it has held; a zoom in motion reuses the atlas it has. */
let seenZoom=-1,steadyFrames=0
/** Frames a zoom must hold before glyphs are repainted at exactly that size. */
const ZOOM_SETTLE=8
/** While the zoom moves, glyphs painted within this ratio of it are stretched instead of repainted. */
const ZOOM_REUSE=1.07
/** On-screen size of an atlas glyph over the size it was painted at. */
let glyphScale=1
/**
 * The zoom glyphs are painted for. Repainting the whole atlas every frame of an eased zoom is what makes zooming
 * stutter, so a zoom in motion keeps the glyphs it has (drawn a few percent larger or smaller) and only moves to a
 * new size, in steps of a sixth of an octave, when they no longer fit; once it rests they are repainted exactly.
 */
function glyphZoomFor(zoom:number,fresh:boolean):number {
  // A new battle or canvas has no glyphs worth keeping: it starts exact.
  if(zoom===seenZoom) steadyFrames++
  else {steadyFrames=fresh?ZOOM_SETTLE:0;seenZoom=zoom}
  if(steadyFrames>=ZOOM_SETTLE) return zoom
  if(spriteZoom>0&&Math.max(zoom/spriteZoom,spriteZoom/zoom)<ZOOM_REUSE) return spriteZoom
  return 2**(Math.round(Math.log2(zoom)*6)/6)
}
/** The glyphs whose cells hold a figure of this half-extent. */
function glyphClassFor(half:number):GlyphClass {
  let cell=32;while(cell<half*2) cell*=2
  let made=glyphClasses.get(cell)
  if(!made) {
    const columns=Math.max(1,Math.floor(1024/cell))
    made={cell,columns,perPage:columns*columns,pages:[],filled:0,glyphs:new Map()}
    glyphClasses.set(cell,made)
  }
  return made
}
function prepareGlyphs(battle:Battle,view:number,canvas:HTMLCanvasElement):void {
  const zoom=glyphZoomFor(view,spriteBattle!==battle||spriteCanvas!==canvas)
  glyphScale=view/zoom
  if(spriteZoom===zoom&&spriteBattle===battle&&spriteCanvas===canvas) return
  spriteZoom=zoom;spriteBattle=battle;spriteCanvas=canvas;glyphGeneration++;glyphClasses.clear();glyphPages.length=0;glyphStyles.clear()
  // The WebGL layer composites every glyph over the Canvas in one go; whatever is drawn in place goes down just
  // before that composite (weapons) or just after it (the great monsters): see inPlace.
  glyphBatch=battle.regiments.reduce((n,r)=>n+r.aliveCount,0)>=256?spriteBatch(canvas):null
  for(const reg of battle.regiments) {
    const def=unitDef(reg.type)
    if(glyphStyles.has(def)) continue
    // The figure's own reckoning covers its weapon at every heading and swing, its stride, shadow and selection ring.
    // A long weapon is a thin line that makes the figure's square several times the size of the man holding it, and
    // every stage of its swing would need that square again for every heading, step and coat. So a figure that is
    // wide only for its weapon is cached as a body, in a cell of the body's own size, and a weapon apart: a glyph of
    // its own that the sprite layer turns to the body's heading, or drawn in place when it is too long for one or
    // there is no sprite layer. A body that outgrows a cell by itself (a horse, a brute, a cart) is painted at a
    // smaller zoom and stretched. Only what would need stretching past GLYPH_STRETCH is drawn in place: the few
    // great monsters.
    const cull=figureExtent(def,zoom)
    let mode:0|1|2=0,extent=cull,painted=zoom,arm:ArmStyle|null=null
    if(extent>(glyphBatch?SPLIT_HALF:GLYPH_HALF)&&splitsWeapon(def)) {
      mode=1;extent=figureExtent(def,zoom,true)
      if(glyphBatch&&cull<=ARM_HALF) {
        // Turning a glyph blurs it; a thin weapon is painted at twice the size where that fits, and shown at half.
        const fine=cull*2<=ARM_HALF?2:1
        arm={half:cull*fine,fine,glyphs:glyphClassFor(cull*fine)}
      }
    }
    if(extent>GLYPH_HALF) {
      painted=zoom*GLYPH_HALF/extent
      while(figureExtent(def,painted,mode===1)>GLYPH_HALF) painted*=0.98
      extent=figureExtent(def,painted,mode===1)
      if(zoom/painted>GLYPH_STRETCH) mode=2
    }
    glyphStyles.set(def,{r:Math.max(2.5,def.radius*painted),half:extent,mode,zoom:painted,scale:zoom/painted,cull,glyphs:glyphClassFor(extent),arm:mode===1?arm:null})
  }
}

/**
 * A cell for a new glyph of `glyphs`, cleared, with the pen moved to its centre and clipped to it: paint, then
 * closeGlyph. The class fills the pages it has, then reuses a glyph of its own that has gone unused for a long while,
 * then takes another page of the atlas, and with none left gives up its least recently used glyph. A class that
 * comes late to a full atlas takes over a page from the class that holds most.
 */
let cellPen:CanvasRenderingContext2D|null=null
function openGlyph(ctx:CanvasRenderingContext2D,batch:SpriteBatch|null,glyphs:GlyphClass,key:number):Glyph {
  const oldest=glyphs.glyphs.entries().next().value as [number,Glyph]|undefined
  let slot=-1
  if(glyphs.filled<glyphs.pages.length*glyphs.perPage) slot=glyphs.filled++
  else if(oldest&&glyphSerial-oldest[1].used>GLYPH_IDLE) {glyphs.glyphs.delete(oldest[0]);slot=oldest[1].slot}
  else if(glyphPages.length<GLYPH_PAGES) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1024
    // The WebGL layer reads repainted cells back; Canvas-only pages stay GPU backed.
    glyphPages.push({canvas,pen:canvas.getContext('2d',glyphBatch?{willReadFrequently:true}:undefined)!})
    glyphs.pages.push(glyphPages.length-1);slot=glyphs.filled++
  } else if(oldest) {
    // Only a cell queued in the current batch needs that batch drawn before it is painted over.
    if(batch&&oldest[1].used===glyphSerial) {drawInked(ctx,under);batch.flush(ctx);glyphSerial++}
    glyphs.glyphs.delete(oldest[0]);slot=oldest[1].slot
  } else {
    let donor=glyphs
    for(const other of glyphClasses.values()) if(other.pages.length>donor.pages.length) donor=other
    const index=donor.pages.pop()!,kept=donor.pages.length*donor.perPage
    let queued=false
    for(const [lost,glyph] of donor.glyphs) if(glyph.slot>=kept) {queued||=glyph.used===glyphSerial;donor.glyphs.delete(lost)}
    donor.filled=Math.min(donor.filled,kept)
    if(batch&&queued) {drawInked(ctx,under);batch.flush(ctx);glyphSerial++}
    glyphBatch?.renew(glyphPages[index].canvas)
    glyphs.pages.push(index);slot=glyphs.filled++
  }
  const page=glyphPages[glyphs.pages[Math.floor(slot/glyphs.perPage)]],at=slot%glyphs.perPage,cell=glyphs.cell
  const x=(at%glyphs.columns)*cell,y=Math.floor(at/glyphs.columns)*cell
  const glyph={page:page.canvas,x,y,slot,used:glyphSerial}
  glyphs.glyphs.set(key,glyph)
  const pen=cellPen=page.pen
  // Nothing a figure paints may spill into its neighbours' cells.
  pen.clearRect(x,y,cell,cell);pen.save();pen.beginPath();pen.rect(x,y,cell,cell);pen.clip()
  pen.translate(x+cell/2,y+cell/2)
  return glyph
}
function closeGlyph(glyphs:GlyphClass,glyph:Glyph):void {
  cellPen!.restore()
  glyphBatch?.invalidate(glyph.page,glyph.x,glyph.y,glyphs.cell)
}

/** Stride length of one full gait cycle in metres: a man's two steps, a horse's gallop, a beast's lumbering walk. */
function strideOf(def:UnitDef):number {
  return def.category==='cavalry'||def.category==='chariot'?2.6:def.category==='monster'?3.2:def.category==='monstrousInfantry'?2.2:1.5
}
const SWINGS=6
/** How long a thrown man is in the air, seconds, and how high the eye sees him lifted, metres. */
const THROW_AIR=0.45,THROW_LIFT=0.42

function drawBody(
  ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number, scene: Scene,
  body: Body, selected: boolean, alpha: number, cacheSprites:boolean, batch:SpriteBatch|null,
): void {
  const {soldier,def}=body
  let x=soldier.prevX+(soldier.x-soldier.prevX)*alpha,y=soldier.prevY+(soldier.y-soldier.prevY)*alpha
  const edge=(glyphStyles.get(def)?.cull??40)*glyphScale
  const sx=width/2+(x-camera.x)*camera.zoom,sy=height/2-(y-camera.y)*camera.zoom
  if(sx < -edge || sy < -edge || sx > width+edge || sy > height+edge) return
  let facing=soldier.prevFacing+angDiff(soldier.prevFacing,soldier.facing)*alpha
  const dt=scene.frame,down=soldier.down>0.3
  // A blow leans the whole body into it and a hit rocks it back; both ease out instead of snapping.
  let lunge=0,swing=-1
  if(soldier.swing&&!down) {
    const through=Math.max(0,Math.min(1,1-soldier.swing.left/Math.max(.05,def.attack.windup)))
    lunge=(through<.6?-.22*through/.6:-.22+1.1*(through-.6)/.4)*Math.min(.6,def.radius)
    swing=Math.min(SWINGS-1,Math.floor(through*SWINGS))
  }
  if(dt>0) {
    body.lunge+=(lunge-body.lunge)*scene.lungeEase
    body.recoil*=scene.recoilKeep
    if(soldier.speed>.2) body.gait=(body.gait+soldier.speed*dt/strideOf(def))%1
  } else if(body.lunge===0&&lunge!==0) body.lunge=lunge
  const shift=body.lunge-body.recoil
  if(shift) {x+=Math.cos(facing)*shift;y+=Math.sin(facing)*shift}
  let px=width/2+(x-camera.x)*camera.zoom,py=height/2-(y-camera.y)*camera.zoom
  let state:FigureState='up',step=-1
  if(down) {
    // Thrown: a short flight, tumbling, then he lies where he came to rest until he can rise.
    const since=Math.max(0,scene.visual-body.thrownAt)
    state='down';swing=-1
    facing+=body.spin*(1-Math.exp(-3.2*since))
    if(since<THROW_AIR) py-=Math.sin(Math.PI*since/THROW_AIR)*THROW_LIFT*camera.zoom
  } else if(soldier.speed>.25) {
    step=Math.floor(body.gait*STEPS)%STEPS
    // Too small on screen to tell eight frames apart: four keep the atlas lean.
    if((glyphStyles.get(def)?.r??9)<5) step&=~1
  }
  drawFigure(ctx,batch,cacheSprites,def,body.reg.side,camera.zoom,px,py,facing,state,step,swing,soldier.id%figureVariants(def),selected,soldier.flash>0,soldier.wounded,1)
}

const STATES:Record<FigureState,number>={up:0,down:1,dead:2}
const pose:Pose={heading:0,step:-1,swing:-1,state:'up',flash:false,selected:false,wounded:false,variant:0}
/** One figure at a screen point: from the glyph atlas when it fits a cell, otherwise drawn in place. `coarse` rounds the heading to that many sectors. */
function drawFigure(
  ctx:CanvasRenderingContext2D,batch:SpriteBatch|null,cacheSprites:boolean,def:UnitDef,side:Side,zoom:number,x:number,y:number,heading:number,
  state:FigureState,step:number,swing:number,variant:number,selected:boolean,flash:boolean,wounded:boolean,coarse:number,
):void {
  pose.step=step;pose.swing=swing<0?-1:(swing+.5)/SWINGS;pose.state=state;pose.flash=flash;pose.selected=selected;pose.wounded=wounded;pose.variant=variant;pose.part=undefined
  const style=glyphStyles.get(def)
  if(!cacheSprites||!style||style.mode===2) {
    pose.heading=heading
    inPlace(ctx,batch?over:null,def,side,zoom,x,y,1)
    return
  }
  let typeId=glyphTypes.get(def)
  if(typeId===undefined) {typeId=nextGlyphType++;glyphTypes.set(def,typeId)}
  let sector=((Math.round(heading*64/(Math.PI*2))%64)+64)%64
  if(coarse>1) sector=Math.round(sector/coarse)*coarse%64
  const flags=(((typeId*2+side)*2+Number(selected))*2+Number(flash))*2+Number(wounded)
  // A body painted without its weapon looks the same at every stage of the blow.
  const key=((((flags*3+STATES[state])*4+variant)*(STEPS+1)+step+1)*(SWINGS+1)+(style.mode===1?0:swing+1))*64+sector
  pose.heading=sector*Math.PI*2/64
  const glyphs=style.glyphs
  let sprite=glyphs.glyphs.get(key)
  if(sprite) {
    // Move to the back on its first use in this serial, so the front is the least recently used.
    if(sprite.used!==glyphSerial) {glyphs.glyphs.delete(key);glyphs.glyphs.set(key,sprite)}
  } else {
    sprite=openGlyph(ctx,batch,glyphs,key)
    if(style.mode===1) pose.part='body'
    cellPen!.rotate(-pose.heading)
    paintFigure(cellPen!,def,side,style.zoom,pose)
    closeGlyph(glyphs,sprite)
  }
  sprite.used=glyphSerial
  if(style.mode===1&&state==='up') {
    // The weapon the glyph left out, at the glyph's own heading so hand and haft meet. It goes down before the body:
    // a man holds it low at his side, and the men about him stand over it.
    pose.part='weapon'
    const arm=style.arm
    if(batch&&arm) {
      // One glyph for each stage of the blow serves every heading, step and coat: the sprite layer turns it.
      const armKey=((typeId*2+side)*2+Number(flash))*(SWINGS+1)+swing+1
      let held=arm.glyphs.glyphs.get(-1-armKey)
      if(held) {
        if(held.used!==glyphSerial) {arm.glyphs.glyphs.delete(-1-armKey);arm.glyphs.glyphs.set(-1-armKey,held)}
      } else {
        const turned=pose.heading
        held=openGlyph(ctx,batch,arm.glyphs,-1-armKey)
        pose.heading=0
        if(arm.fine!==1) cellPen!.scale(arm.fine,arm.fine)
        paintFigure(cellPen!,def,side,spriteZoom,pose)
        closeGlyph(arm.glyphs,held)
        pose.heading=turned
      }
      held.used=glyphSerial
      const size=arm.half*2,inset=arm.glyphs.cell/2-arm.half
      batch.draw(held.page,held.x+inset,held.y+inset,size,x-arm.half,y-arm.half,1,glyphScale/arm.fine,-pose.heading)
    } else inPlace(ctx,batch?under:null,def,side,spriteZoom,x,y,glyphScale)
  }
  const half=style.half,grown=glyphScale*style.scale,shown=half*grown,inset=glyphs.cell/2-half
  if(batch) batch.draw(sprite.page,sprite.x+inset,sprite.y+inset,half*2,x-half,y-half,1,grown)
  else ctx.drawImage(sprite.page,sprite.x+inset,sprite.y+inset,half*2,half*2,x-shown,y-shown,shown*2,shown*2)
}

/** A figure, or its weapon alone, to be drawn in place around the WebGL layer's one composite of the glyphs. */
interface Inked extends Pose {def:UnitDef;side:Side;zoom:number;x:number;y:number;scale:number}
interface InkQueue {items:Inked[];count:number}
/** Weapons wait to go down just before the glyphs; whole figures (the great monsters) go over them. */
const under:InkQueue={items:[],count:0},over:InkQueue={items:[],count:0}
/**
 * Draw the current pose at a screen point without the atlas: at once on the plain Canvas path, or into `queue` when
 * the WebGL layer is on. That layer composites every glyph of the frame in one go, so anything drawn in place is
 * either under all of them or over all of them; a composite per body is what the layer exists to avoid.
 */
function inPlace(ctx:CanvasRenderingContext2D,queue:InkQueue|null,def:UnitDef,side:Side,zoom:number,x:number,y:number,scale:number):void {
  if(queue) {
    const item=queue.items[queue.count]??(queue.items[queue.count]={...pose,def,side,zoom,x,y,scale})
    Object.assign(item,pose);item.def=def;item.side=side;item.zoom=zoom;item.x=x;item.y=y;item.scale=scale
    queue.count++
    return
  }
  ctx.save();ctx.translate(x,y);ctx.rotate(-pose.heading)
  if(scale!==1) ctx.scale(scale,scale)
  paintFigure(ctx,def,side,zoom,pose)
  ctx.restore()
}
/** Draw what inPlace held back, in the order it was asked for. */
function drawInked(ctx:CanvasRenderingContext2D,queue:InkQueue):void {
  for(let i=0;i<queue.count;i++) {
    const item=queue.items[i]
    ctx.save();ctx.translate(item.x,item.y);ctx.rotate(-item.heading)
    if(item.scale!==1) ctx.scale(item.scale,item.scale)
    paintFigure(ctx,item.def,item.side,item.zoom,item)
    ctx.restore()
  }
  queue.count=0
}

function drawRegimentMarks(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  reg: Regiment,
  selected: boolean,
  named: boolean,
  showStamina: boolean,
  time: number,
  wall: number,
): void {
  const def = unitDef(reg.type)
  const corners = formationCorners(reg, def)
  const mark = worldToScreen(
    camera,
    width,
    height,
    corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
    corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
  )
  if (mark.x < -90 * ui || mark.x > width + 90 * ui || mark.y < -20 * ui || mark.y > height + 120 * ui) return
  const barW = 46 * ui
  const missile = def.missile
  const hpY = mark.y - (missile ? 34 : 28) * ui
  const hp = hpFraction(reg)
  const broken = reg.routing || reg.shattered, wavering = !broken && reg.moraleState === 'wavering'
  const fade = broken ? 0.55 : wavering ? 0.7 + 0.3 * Math.cos(time * Math.PI * 2) : 1
  drawBanner(ctx, mark.x, hpY - 4 * ui, ui, { side: reg.side, glyph: UNIT_GLYPH[reg.type], selected, routing: broken, wavering, alpha: fade }, wall, reg.id)
  // Strength, ammunition and nerve on a dark plate under the flag.
  ctx.fillStyle = 'rgba(8, 10, 6, 0.6)'
  ctx.fillRect(mark.x - barW / 2 - ui, hpY - ui, barW + 2 * ui, (missile ? 14 : 9) * ui)
  ctx.fillStyle = 'rgba(244, 238, 214, 0.12)'
  ctx.fillRect(mark.x - barW / 2, hpY, barW, 5 * ui)
  ctx.fillStyle = hp > 0.6 ? '#8cc463' : hp > 0.3 ? '#dfb548' : '#d85a42'
  ctx.fillRect(mark.x - barW / 2, hpY, barW * hp, 5 * ui)
  if (missile) {
    const left = ammoFraction(reg, missile.ammo)
    ctx.fillStyle = left > 0.25 ? '#d3dae2' : '#d85a42'
    ctx.fillRect(mark.x - barW / 2, hpY + 6 * ui, barW * left, 3 * ui)
  }
  const leadershipWidth = Math.max(0, Math.min(1, reg.leadership / def.leadership))
  ctx.fillStyle = reg.leadership < 0 ? '#d85a42' : '#ecc970'
  ctx.fillRect(mark.x - barW / 2, hpY + (missile ? 10 : 6) * ui, barW * leadershipWidth, 2 * ui)
  if (named) {
    // Name and strength: shown for the selection, under the pointer, and for everyone while Space is held.
    ctx.font = `${Math.round(12 * ui)}px "Microsoft YaHei", sans-serif`
    ctx.textAlign = 'center'
    const label = `${reg.name.replace('南军', '').replace('北军', '')} ${reg.aliveCount}`
    ctx.save()
    ctx.globalAlpha *= fade
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(8, 10, 6, 0.8)'
    ctx.lineWidth = 3 * ui
    ctx.strokeText(label, mark.x, hpY - 30 * ui)
    ctx.fillStyle = selected ? '#ffe9a6' : '#f1ead6'
    ctx.fillText(label, mark.x, hpY - 30 * ui)
    ctx.restore()
  }
  if (showStamina) drawFatigue(ctx, mark.x, mark.y - (missile ? 92 : 86) * ui, reg)
}

function formationMid(reg: Regiment): { x: number; y: number } {
  const corners = formationCorners(reg, unitDef(reg.type))
  return {
    x: corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
    y: corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
  }
}

/**
 * Every enemy our regiments are attacking carries a red marker. Attackers that are selected also get a red
 * arrow to their target, and the target's formation is outlined in red.
 */
function drawAttackOrders(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  battle: Battle,
  selection: number[],
  showStamina: boolean,
): void {
  const marked = new Map<number, boolean>()
  for (const reg of battle.regiments) {
    if (reg.side !== 0 || reg.order !== 'attack' || reg.targetId === null || reg.aliveCount <= 0 || reg.routing) continue
    const target = battle.regiments.find((item) => item.id === reg.targetId)
    if (!target || target.aliveCount <= 0) continue
    const selected = selection.includes(reg.id)
    marked.set(target.id, (marked.get(target.id) ?? false) || selected)
    if (!selected) continue
    const from = worldToScreen(camera, width, height, formationMid(reg).x, formationMid(reg).y)
    const to = worldToScreen(camera, width, height, formationMid(target).x, formationMid(target).y)
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const tipX = to.x - Math.cos(angle) * 14 * ui
    const tipY = to.y - Math.sin(angle) * 14 * ui
    ctx.strokeStyle = 'rgba(214, 72, 52, 0.85)'
    ctx.lineWidth = 2 * ui
    ctx.setLineDash([8 * ui, 6 * ui])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(tipX, tipY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(214, 72, 52, 0.95)'
    ctx.beginPath()
    ctx.moveTo(tipX + Math.cos(angle) * 4 * ui, tipY + Math.sin(angle) * 4 * ui)
    ctx.lineTo(tipX - Math.cos(angle - 0.5) * 12 * ui, tipY - Math.sin(angle - 0.5) * 12 * ui)
    ctx.lineTo(tipX - Math.cos(angle + 0.5) * 12 * ui, tipY - Math.sin(angle + 0.5) * 12 * ui)
    ctx.closePath()
    ctx.fill()
  }
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180)
  for (const [targetId, strong] of marked) {
    const target = battle.regiments.find((item) => item.id === targetId)
    if (!target) continue
    if (strong) strokeFormation(ctx, camera, width, height, target, `rgba(226, 70, 50, ${0.65 + 0.35 * pulse})`)
    const mid = formationMid(target)
    const p = worldToScreen(camera, width, height, mid.x, mid.y)
    const lift = ((showStamina ? 132 : 84) + pulse * 4) * ui
    const size = (strong ? 9 : 7) * ui
    ctx.fillStyle = strong ? '#e2463a' : 'rgba(226, 70, 50, 0.75)'
    ctx.strokeStyle = 'rgba(20, 10, 8, 0.8)'
    ctx.lineWidth = 1.5 * ui
    ctx.beginPath()
    ctx.moveTo(p.x, p.y - lift)
    ctx.lineTo(p.x - size, p.y - lift - size * 1.5)
    ctx.lineTo(p.x, p.y - lift - size * 0.9)
    ctx.lineTo(p.x + size, p.y - lift - size * 1.5)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

/** Fatigue level by name, a bar that fills as exertion grows towards exhaustion (ticks at each level), and the charge bonus. */
function drawFatigue(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  reg: Regiment,
): void {
  const def = unitDef(reg.type)
  const state = FATIGUE_NAMES[reg.fatigue]
  const max = FATIGUE.exhausted.threshold
  const filled = Math.max(0, Math.min(1, reg.exertion / max))
  const stat = fatigueMods(reg.fatigue).charge
  const full = Math.round(def.chargeBonus * stat)
  const now = Math.round(def.chargeBonus * stat * Math.max(0, ...reg.soldiers.filter(s => s.alive).map(s => chargeStrength(s))))
  const chargeText = full > 0 ? `冲锋 +${now}/${full}` : '冲锋 无'
  ctx.fillStyle = 'rgba(12, 14, 10, 0.82)'
  ctx.fillRect(x - 58 * ui, y - 34 * ui, 116 * ui, 38 * ui)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.fillRect(x - 52 * ui, y - 16 * ui, 104 * ui, 4 * ui)
  const level = reg.fatigue
  ctx.fillStyle = level === 'fresh' || level === 'active' ? '#7ea36a' : level === 'winded' || level === 'tired' ? '#e0c27a' : '#c4493a'
  ctx.fillRect(x - 52 * ui, y - 16 * ui, 104 * ui * filled, 4 * ui)
  ctx.fillStyle = 'rgba(12, 14, 10, 0.7)'
  for (const step of ['active', 'winded', 'tired', 'veryTired'] as const) ctx.fillRect(x - 52 * ui + 104 * ui * FATIGUE[step].threshold / max, y - 16 * ui, ui, 4 * ui)
  ctx.font = `${Math.round(11 * ui)}px "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f3e6c2'
  ctx.fillText(`疲劳 ${state}`, x - 52 * ui, y - 20 * ui)
  ctx.fillText(chargeText, x - 52 * ui, y - 2 * ui)
  ctx.textAlign = 'center'
}

function ammoFraction(reg: Regiment, capacity: number): number {
  if (capacity <= 0) return 0
  let ammo = 0
  let alive = 0
  for (const soldier of reg.soldiers) {
    if (!soldier.alive) continue
    alive += 1
    ammo += Math.max(0, soldier.ammo)
  }
  if (alive <= 0) return 0
  return Math.max(0, Math.min(1, ammo / (alive * capacity)))
}

function hpFraction(reg: Regiment): number {
  const max = reg.initial * reg.modelHp
  if (max <= 0) return 0
  let hp = 0
  for (const soldier of reg.soldiers) if (soldier.alive) hp += Math.max(0, soldier.hp)
  return Math.max(0, Math.min(1, hp / max))
}
