import { worldToScreen, type Camera, type DragPreview } from './camera'
import { flankHandles, formationCorners } from './sim/formation'
import { forward, right } from './sim/math'
import { previewFront } from './sim/orders'
import type { Battle, Regiment, Soldier } from './sim/types'
import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import { unitDef } from './sim/units'

export interface RenderInput {
  battle: Battle
  camera: Camera
  selection: number[]
  hoverId: number | null
  drag: DragPreview | null
  dragRegId: number | null
  showBoxes: boolean
  showStamina: boolean
}

export function render(canvas: HTMLCanvasElement, view: RenderInput): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  const { battle, camera } = view
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#141812'
  ctx.fillRect(0, 0, width, height)

  const origin = worldToScreen(camera, width, height, 0, 0)
  const far = worldToScreen(camera, width, height, MAP_WIDTH, MAP_HEIGHT)
  const left = origin.x
  const top = far.y
  const mapW = far.x - origin.x
  const mapH = origin.y - far.y
  ctx.fillStyle = '#3c4636'
  ctx.fillRect(left, top, mapW, mapH)

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, mapW, mapH)
  ctx.clip()
  ctx.strokeStyle = 'rgba(232, 220, 190, 0.08)'
  ctx.lineWidth = 1
  for (let x = 10; x < MAP_WIDTH; x += 10) {
    const a = worldToScreen(camera, width, height, x, 0)
    const b = worldToScreen(camera, width, height, x, MAP_HEIGHT)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  for (let y = 10; y < MAP_HEIGHT; y += 10) {
    const a = worldToScreen(camera, width, height, 0, y)
    const b = worldToScreen(camera, width, height, MAP_WIDTH, y)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.restore()

  ctx.strokeStyle = 'rgba(224, 194, 122, 0.45)'
  ctx.lineWidth = 2
  ctx.strokeRect(left, top, mapW, mapH)

  ctx.fillStyle = 'rgba(231, 225, 209, 0.55)'
  ctx.font = `${Math.max(12, camera.zoom * 2.2)}px "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  const south = worldToScreen(camera, width, height, MAP_WIDTH / 2, 6)
  const north = worldToScreen(camera, width, height, MAP_WIDTH / 2, MAP_HEIGHT - 6)
  ctx.fillText('南', south.x, south.y)
  ctx.fillText('北', north.x, north.y)

  if (view.drag?.kind === 'box') drawBox(ctx, camera, width, height, view.drag)
  if (view.drag?.kind === 'front' && view.dragRegId !== null) {
    drawFrontPreview(ctx, camera, width, height, battle, view.dragRegId, view.drag)
  }

  for (const reg of battle.regiments) {
    const selected = view.selection.includes(reg.id)
    const hovered = view.hoverId === reg.id
    if (!selected && !hovered && !view.showBoxes) continue
    const color = selected ? '#e0c27a' : view.showBoxes ? 'rgba(224, 194, 122, 0.7)' : 'rgba(224, 194, 122, 0.45)'
    strokeFormation(ctx, camera, width, height, reg, color)
  }

  const bodies: { soldier: Soldier; reg: Regiment }[] = []
  for (const reg of battle.regiments) {
    for (const soldier of reg.soldiers) {
      if (!soldier.alive && (soldier.deathTime < 0 || battle.time - soldier.deathTime > 0.55)) continue
      bodies.push({ soldier, reg })
    }
  }
  bodies.sort((a, b) => b.soldier.y - a.soldier.y)
  for (const body of bodies) drawSoldier(ctx, camera, width, height, body.reg, body.soldier)

  for (const projectile of battle.projectiles) {
    const ground = worldToScreen(camera, width, height, projectile.x, projectile.y)
    if (projectile.arc) {
      const progress = projectile.duration > 0 ? Math.min(1, projectile.age / projectile.duration) : 1
      const lift = Math.sin(progress * Math.PI) * projectile.apex * camera.zoom
      ctx.fillStyle = 'rgba(20, 22, 16, 0.45)'
      ctx.beginPath()
      ctx.arc(ground.x, ground.y, Math.max(1.2, camera.zoom * 0.12), 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#f3e2b0'
      ctx.lineWidth = Math.max(1, camera.zoom * 0.07)
      ctx.beginPath()
      ctx.moveTo(ground.x, ground.y - lift)
      ctx.lineTo(ground.x - Math.cos(Math.atan2(projectile.landY - projectile.originY, projectile.landX - projectile.originX)) * 7, ground.y - lift + 2)
      ctx.stroke()
      continue
    }
    const tip = worldToScreen(
      camera,
      width,
      height,
      projectile.x - projectile.vx * 0.03,
      projectile.y - projectile.vy * 0.03,
    )
    ctx.strokeStyle = '#f7f1d8'
    ctx.lineWidth = Math.max(1, camera.zoom * 0.06)
    ctx.beginPath()
    ctx.moveTo(ground.x, ground.y)
    ctx.lineTo(tip.x, tip.y)
    ctx.stroke()
  }

  for (const reg of battle.regiments) {
    if (reg.aliveCount <= 0 && !reg.routing) continue
    drawRegimentMarks(ctx, camera, width, height, battle, reg, view.selection.includes(reg.id), view.showStamina)
  }

  if (view.selection.length === 1) {
    const reg = battle.regiments.find((item) => item.id === view.selection[0])
    if (reg && reg.side === 0 && reg.aliveCount > 0 && !reg.routing) {
      const def = unitDef(reg.type)
      for (const handle of flankHandles(reg, def)) {
        const p = worldToScreen(camera, width, height, handle.x, handle.y)
        ctx.fillStyle = '#e0c27a'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  ctx.font = `${Math.max(11, camera.zoom * 1.3)}px "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  for (const floater of battle.fx) {
    const p = worldToScreen(camera, width, height, floater.x, floater.y + (0.75 - floater.life) * 2)
    ctx.globalAlpha = Math.max(0, floater.life)
    ctx.fillStyle = '#f4efe2'
    ctx.fillText(floater.text, p.x, p.y)
    ctx.globalAlpha = 1
  }
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
  ctx.lineWidth = 1
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
): void {
  const preview = previewFront(battle, regId, drag.x0, drag.y0, drag.x1, drag.y1)
  if (!preview) return
  const a = worldToScreen(camera, width, height, preview.x1, preview.y1)
  const b = worldToScreen(camera, width, height, preview.x2, preview.y2)
  ctx.strokeStyle = '#e0c27a'
  ctx.lineWidth = 2
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
  ctx.setLineDash([6, 4])
  strokePoly(ctx, corners)
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
  ctx.lineWidth = 1.5
  strokePoly(ctx, corners)
}

function strokePoly(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  ctx.closePath()
  ctx.stroke()
}

function drawSoldier(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  reg: Regiment,
  soldier: Soldier,
): void {
  const def = unitDef(reg.type)
  const p = worldToScreen(camera, width, height, soldier.x, soldier.y)
  const radius = Math.max(3.1, def.radius * camera.zoom)
  const dead = !soldier.alive
  ctx.globalAlpha = dead ? 0.35 : 1
  ctx.fillStyle = soldier.flash > 0 ? '#f7f3ea' : reg.side === 0 ? '#9ec3e0' : '#e0a090'
  ctx.strokeStyle = reg.side === 0 ? '#1d3e5c' : '#6a2e28'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (def.type === 'chariot') {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(-soldier.facing)
    const length = Math.max(radius * 2.4, def.length * camera.zoom)
    const breadth = Math.max(radius * 1.3, def.radius * 2 * camera.zoom)
    ctx.roundRect(-length / 2, -breadth / 2, length, breadth, breadth / 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  } else if (def.type === 'cavalry') {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(-soldier.facing)
    ctx.ellipse(0, 0, radius * 1.55, radius * 0.95, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  } else if (def.type === 'musket') {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(-soldier.facing)
    ctx.rect(-radius * 0.75, -radius * 0.75, radius * 1.5, radius * 1.5)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(radius * 0.2, 0)
    ctx.lineTo(radius * 2.4, 0)
    ctx.stroke()
    ctx.restore()
  } else if (def.type === 'archer') {
    ctx.moveTo(p.x, p.y - radius)
    ctx.lineTo(p.x + radius, p.y)
    ctx.lineTo(p.x, p.y + radius)
    ctx.lineTo(p.x - radius, p.y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else {
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  if (!dead && def.type !== 'chariot' && def.type !== 'cavalry' && def.type !== 'musket') {
    const fx = Math.cos(soldier.facing) * (radius + 2)
    const fy = -Math.sin(soldier.facing) * (radius + 2)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.lineTo(p.x + fx, p.y + fy)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawRegimentMarks(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  battle: Battle,
  reg: Regiment,
  selected: boolean,
  showStamina: boolean,
): void {
  const corners = formationCorners(reg, unitDef(reg.type))
  const mark = worldToScreen(
    camera,
    width,
    height,
    corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
    corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
  )
  const barW = 46
  const hp = hpFraction(reg)
  ctx.fillStyle = 'rgba(12, 14, 10, 0.55)'
  ctx.fillRect(mark.x - barW / 2, mark.y - 28, barW, 5)
  ctx.fillStyle = reg.side === 0 ? '#7ea36a' : '#b55248'
  ctx.fillRect(mark.x - barW / 2, mark.y - 28, barW * hp, 5)
  const leadershipWidth = Math.max(0, Math.min(1, reg.leadership / unitDef(reg.type).leadership))
  ctx.fillStyle = reg.leadership < 0 ? '#c4493a' : '#e0c27a'
  ctx.fillRect(mark.x - barW / 2, mark.y - 22, barW * leadershipWidth, 2)
  ctx.font = '12px "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = selected ? '#f3e6c2' : 'rgba(231, 225, 209, 0.8)'
  const label = `${reg.name.replace('南军', '').replace('北军', '')} ${reg.aliveCount}`
  ctx.fillText(label, mark.x, mark.y - 32)
  if (showStamina) drawStamina(ctx, mark.x, mark.y - 48, reg)
  if (reg.order === 'attack' && reg.targetId !== null) {
    const target = battle.regiments.find((item) => item.id === reg.targetId)
    if (target) {
      const to = worldToScreen(camera, width, height, target.anchorX, target.anchorY)
      ctx.strokeStyle = 'rgba(196, 92, 74, 0.35)'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(mark.x, mark.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

function drawStamina(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  reg: Regiment,
): void {
  const state = reg.fatigue === 'exhausted' ? '力竭' : reg.fatigue === 'winded' ? '气喘' : '精神'
  const left = Math.max(0, 1 - reg.exertion / 80)
  ctx.fillStyle = 'rgba(12, 14, 10, 0.72)'
  ctx.fillRect(x - 28, y - 14, 56, 16)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.fillRect(x - 24, y - 4, 48, 4)
  ctx.fillStyle = left > 0.5 ? '#7ea36a' : left > 0.2 ? '#e0c27a' : '#c4493a'
  ctx.fillRect(x - 24, y - 4, 48 * left, 4)
  ctx.font = '11px "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#f3e6c2'
  ctx.fillText(`体力 ${state}`, x, y - 6)
}

function hpFraction(reg: Regiment): number {
  const max = reg.initial * unitDef(reg.type).hp
  if (max <= 0) return 0
  let hp = 0
  for (const soldier of reg.soldiers) if (soldier.alive) hp += Math.max(0, soldier.hp)
  return Math.max(0, Math.min(1, hp / max))
}
