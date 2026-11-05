import { worldToScreen, type Camera, type DragPreview } from './camera'
import { KNOCK_TIME, chargeDecay, fatigueMods } from './sim/combat'
import { flankHandles, formationCorners, massCenter } from './sim/formation'
import { angDiff, forward, right } from './sim/math'
import { previewFront, previewGroupFront, type FrontPreview } from './sim/orders'
import type { Battle, Regiment, Soldier, UnitDef, Side } from './sim/types'
import { MAP_HEIGHT, MAP_WIDTH } from './sim/types'
import { isCavalry, unitDef } from './sim/units'
import { FATIGUE, FATIGUE_NAMES } from './sim/mechanics'
import { elevationAt } from './sim/terrain'

export interface RenderInput {
  battle: Battle
  camera: Camera
  selection: number[]
  hoverId: number | null
  drag: DragPreview | null
  dragRegId: number | null
  showBoxes: boolean
  showStamina: boolean
  alpha?: number
  visualTime?: number
  cacheSprites?: boolean
}

interface Body {soldier:Soldier;reg:Regiment;def:UnitDef}
const drawLists=new WeakMap<Battle,{time:number;bodies:Body[];entries:Body[]}>()
function bodiesOf(battle:Battle):Body[] {
  let cache=drawLists.get(battle)
  if(!cache) {
    cache={time:-1,bodies:[],entries:battle.regiments.flatMap(reg=>reg.soldiers.map(soldier=>({soldier,reg,def:unitDef(reg.type)})))}
    drawLists.set(battle,cache)
  }
  if(cache.time!==battle.time) {
    cache.time=battle.time;cache.bodies.length=0
    for(const body of cache.entries) {
      const s=body.soldier
      if(s.alive||(s.deathTime>=0&&battle.time-s.deathTime<=0.55)) cache.bodies.push(body)
    }
    cache.bodies.sort((a,b)=>b.soldier.y-a.soldier.y)
  }
  return cache.bodies
}

export function render(canvas: HTMLCanvasElement, view: RenderInput): void {
  const ctx = canvas.getContext('2d',{alpha:false,desynchronized:true})
  if (!ctx) return
  const { width, height } = canvas
  const { battle, camera } = view
  // Select detail per glyph below. A global world-zoom cutoff also disabled
  // batching for thousands of bodies on high-DPI or simply larger windows.
  const cacheSprites=view.cacheSprites!==false
  if(cacheSprites) prepareGlyphs(battle,camera.zoom)
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
  if (battle.terrain.kind !== 'flat') {
    const gradient=ctx.createLinearGradient(left,top,left,top+mapH)
    gradient.addColorStop(0,'rgba(214,194,113,0.23)'); gradient.addColorStop(1,'rgba(15,35,22,0.25)')
    ctx.fillStyle=gradient; ctx.fillRect(left,top,mapW,mapH)
    ctx.font='11px "Microsoft YaHei", sans-serif'; ctx.textAlign='left'; ctx.fillStyle='#d7cc9e'
    for (let y=30;y<MAP_HEIGHT;y+=30) {
      const p=worldToScreen(camera,width,height,10,y)
      ctx.fillText(`${Math.round(elevationAt(battle,10,y))} m`,p.x,p.y)
    }
  }

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
  if (view.drag?.kind === 'front') {
    const d = view.drag
    for (const plan of previewGroupFront(battle, view.selection, d.x0, d.y0, d.x1, d.y1)) {
      drawFrontPreview(ctx, camera, width, height, battle, plan.id, d, plan)
    }
  }
  for (const reg of battle.regiments) {
    if (reg.side !== 0 || reg.order !== 'move' || reg.aliveCount <= 0 || reg.routing) continue
    if (!view.showBoxes && !view.selection.includes(reg.id)) continue
    drawMoveOrder(ctx, camera, width, height, reg)
  }

  for (const reg of battle.regiments) {
    const selected = view.selection.includes(reg.id)
    const hovered = view.hoverId === reg.id
    if ((selected || view.showBoxes) && reg.aliveCount > 0) drawWeaponRange(ctx, camera, width, height, reg, selected)
    if (!selected && !hovered && !view.showBoxes) continue
    const color = selected ? '#e0c27a' : view.showBoxes ? 'rgba(224, 194, 122, 0.7)' : 'rgba(224, 194, 122, 0.45)'
    strokeFormation(ctx, camera, width, height, reg, color)
  }

  for (const body of bodiesOf(battle)) {
    drawSoldier(ctx, camera, width, height, body.reg, body.soldier, body.def, view.selection.includes(body.reg.id), view.alpha ?? 1, view.visualTime ?? battle.time, cacheSprites)
  }

  for (const projectile of battle.projectiles) {
    const ground = worldToScreen(camera, width, height, projectile.x, projectile.y)
    if (projectile.arc) {
      const lift = Math.max(0,projectile.z-elevationAt(battle,projectile.x,projectile.y)) * camera.zoom
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
    if (reg.aliveCount <= 0) continue
    drawRegimentMarks(ctx, camera, width, height, battle, reg, view.selection.includes(reg.id), view.showStamina, view.visualTime ?? battle.time)
  }
  drawAttackOrders(ctx, camera, width, height, battle, view.selection, view.showStamina)

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
  planned?: FrontPreview,
): void {
  const preview = planned ?? previewFront(battle, regId, drag.x0, drag.y0, drag.x1, drag.y1)
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
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(corners[0].x, corners[0].y)
  ctx.lineTo(corners[1].x, corners[1].y)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(224, 194, 122, 0.55)'
  ctx.setLineDash([6, 4])
  strokePoly(ctx, corners)
  ctx.setLineDash([])
  const mark = worldToScreen(camera, width, height, reg.destX, reg.destY)
  ctx.fillStyle = '#e0c27a'
  ctx.beginPath()
  ctx.arc(mark.x, mark.y, 3.5, 0, Math.PI * 2)
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
  if (!missile) return
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
  ctx.lineWidth = selected ? 1.5 : 1
  ctx.setLineDash([5, 5])
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

// Distant glyphs share a few atlas textures, including their rotation. This
// avoids thousands of save/rotate/restore calls and tiny canvas texture swaps.
interface Glyph {page:HTMLCanvasElement;x:number;y:number;slot:number}
const footSprites=new Map<number,Glyph>()
const glyphPages:{canvas:HTMLCanvasElement;pen:CanvasRenderingContext2D}[]=[]
const glyphTypes=new WeakMap<UnitDef,number>()
const glyphStyles=new Map<UnitDef,{r:number;half:number}>()
let nextGlyphType=0
let spriteZoom=-1
let spriteBattle:Battle|null=null
let spriteCell=32,spriteColumns=32,spritePageSlots=1024,spriteLimit=8192
function prepareGlyphs(battle:Battle,zoom:number):void {
  if(spriteZoom===zoom&&spriteBattle===battle) return
  spriteZoom=zoom;spriteBattle=battle;footSprites.clear();glyphPages.length=0;glyphStyles.clear()
  let half=16
  for(const reg of battle.regiments) {
    const def=unitDef(reg.type)
    if(glyphStyles.has(def)) continue
    const r=Math.max(2.5,def.radius*zoom)
    const body=def.shape==='capsule'?Math.max(r*2.4,def.length*zoom)/2:isCavalry(def.type)?r*1.55:r
    const front=def.shape==='capsule'?def.length*zoom/2:isCavalry(def.type)?r*1.35:r
    // Include weapon rotation, feet, wounds and stroke width at every heading.
    const extent=Math.ceil(Math.max(body,r*1.25+Math.max(1.6,r*.5),r+2,Math.hypot(front+Math.max(3,def.reach*zoom)+3,r+4))+2)
    glyphStyles.set(def,{r,half:extent})
    if(extent<=64) half=Math.max(half,extent)
  }
  spriteCell=32;while(spriteCell<half*2) spriteCell*=2
  spriteColumns=Math.max(1,Math.floor(1024/spriteCell));spritePageSlots=spriteColumns**2
  // At most 16 x 4 MiB atlas pages, including high-DPI large bodies/weapons.
  spriteLimit=Math.min(8192,spritePageSlots*16)
}
function drawSoldier(
  ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number,
  reg: Regiment, soldier: Soldier, def:UnitDef, selected: boolean, alpha: number, time: number,cacheSprites:boolean,
): void {
  const x=soldier.prevX+(soldier.x-soldier.prevX)*alpha,y=soldier.prevY+(soldier.y-soldier.prevY)*alpha
  const p=worldToScreen(camera,width,height,x,y)
  if(p.x < -30 || p.y < -30 || p.x > width+30 || p.y > height+30) return
  const facing=soldier.prevFacing+angDiff(soldier.prevFacing,soldier.facing)*alpha
  const r=Math.max(2.5,def.radius*camera.zoom),dead=!soldier.alive,flash=soldier.flash>0
  const stride=Math.sin(time*Math.max(1,soldier.speed)*5+soldier.id)*r*.45*Math.min(1,soldier.speed)
  const swingAngle=soldier.swing?-.75*Math.sin(Math.PI*soldier.swing.left/Math.max(.05,def.attack.windup)):0
  const opacity=dead?.35:1-Math.min(1,soldier.down/KNOCK_TIME)*.65
  if(cacheSprites&&glyphStyles.get(def)!.half<=64) {
    const foot=def.large||dead?0:Math.max(-16,Math.min(16,Math.round(stride))),swing=Math.round(swingAngle*8)/8
    let typeId=glyphTypes.get(def)
    if(typeId===undefined) {typeId=nextGlyphType++;glyphTypes.set(def,typeId)}
    const sector=((Math.round(facing*64/(Math.PI*2))%64)+64)%64
    const flags=((((typeId*2+reg.side)*2+Number(selected))*2+Number(dead))*2+Number(flash))*2+Number(soldier.wounded)
    const key=((flags*33+foot+16)*7+Math.round(swing*8)+6)*64+sector
    let sprite=footSprites.get(key)
    if(!sprite) {
      let slot=footSprites.size
      if(slot>=spriteLimit) {
        const [oldKey,old]=footSprites.entries().next().value!;footSprites.delete(oldKey)
        sprite=old;slot=old.slot
      }
      const pageIndex=Math.floor(slot/spritePageSlots)
      if(!glyphPages[pageIndex]) {
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1024
        glyphPages.push({canvas,pen:canvas.getContext('2d')!})
      }
      const page=glyphPages[pageIndex],x=(slot%spriteColumns)*spriteCell,y=Math.floor((slot%spritePageSlots)/spriteColumns)*spriteCell
      sprite={page:page.canvas,x,y,slot}
      const pen=page.pen
      pen.clearRect(x,y,spriteCell,spriteCell);pen.save();pen.translate(x+spriteCell/2,y+spriteCell/2);pen.rotate(-sector*Math.PI*2/64)
      paintBody(pen,def,reg.side,r,camera.zoom,dead,soldier.wounded,flash,selected,foot,swing)
      pen.restore()
      footSprites.set(key,sprite)
    }
    if(opacity!==1) ctx.globalAlpha=opacity
    const half=glyphStyles.get(def)!.half
    ctx.drawImage(sprite.page,sprite.x+spriteCell/2-half,sprite.y+spriteCell/2-half,half*2,half*2,p.x-half,p.y-half,half*2,half*2)
    if(opacity!==1) ctx.globalAlpha=1
  } else {
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(-facing);ctx.globalAlpha=opacity
    paintBody(ctx,def,reg.side,r,camera.zoom,dead,soldier.wounded,flash,selected,stride,swingAngle)
    ctx.restore()
  }
}
function paintBody(ctx:CanvasRenderingContext2D,def:UnitDef,side:Side,r:number,zoom:number,dead:boolean,wounded:boolean,flash:boolean,selected:boolean,stride:number,swingAngle:number):void {
  const ink = side === 0 ? '#1d3e5c' : '#6a2e28'
  ctx.fillStyle = ink
  if (!dead && !def.large) {
    const foot = Math.max(1.6, r * 0.5)
    ctx.fillRect(-r * 0.8 + stride, -r * 0.95, foot, foot)
    ctx.fillRect(-r * 0.8 - stride, r * 0.45, foot, foot)
  }
  ctx.fillStyle = flash ? '#f7f3ea' : selected ? (side === 0 ? '#f0d078' : '#ffb089') : side === 0 ? '#9ec3e0' : '#e0a090'
  ctx.strokeStyle = selected ? '#fff4d2' : ink
  ctx.lineWidth = Math.max(1, zoom * 0.08)
  ctx.beginPath()
  if (def.shape === 'capsule') {
    const length = Math.max(r * 2.4, def.length * zoom)
    ctx.roundRect(-length / 2, -r, length, r * 2, r * 0.6)
  } else if (isCavalry(def.type)) {
    ctx.ellipse(0, 0, r * 1.55, r * 0.85, 0, 0, Math.PI * 2)
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.stroke()
  if (!dead && wounded) {
    ctx.strokeStyle = '#e46b51'
    ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, Math.PI * 2); ctx.stroke()
  }
  if (!dead) {
    if (isCavalry(def.type)) {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
    const front = def.shape === 'capsule' ? def.length * zoom / 2 : isCavalry(def.type) ? r * 1.35 : r
    const tip = front + Math.max(3, def.reach * zoom)
    ctx.save()
    if (swingAngle) ctx.rotate(swingAngle)
    ctx.strokeStyle = '#e4dbc1'
    ctx.lineWidth = Math.max(1.1, zoom * 0.1)
    ctx.beginPath()
    if (def.weapon === 'bow') {
      ctx.arc(front, 0, r * 0.9, -1.2, 1.2)
      ctx.moveTo(front + Math.cos(1.2) * r * 0.9, -Math.sin(1.2) * r * 0.9)
      ctx.lineTo(front + Math.cos(1.2) * r * 0.9, Math.sin(1.2) * r * 0.9)
    } else if (def.weapon === 'claws') {
      for (const side of [-1, 1]) { ctx.moveTo(r * 0.5, side * r * 0.7); ctx.lineTo(tip, side * r * 0.9); ctx.lineTo(tip - r * 0.3, side * r * 0.3) }
    } else {
      ctx.moveTo(r * 0.3, -r * 0.25); ctx.lineTo(tip, -r * 0.25)
      if (def.weapon === 'spear' || def.weapon === 'halberd') {
        ctx.moveTo(tip - 3, -r * 0.25 - 2); ctx.lineTo(tip, -r * 0.25); ctx.lineTo(tip - 3, -r * 0.25 + 2)
      } else if (def.weapon !== 'musket') {
        ctx.moveTo(front * 0.7, -r * 0.25 - 2); ctx.lineTo(front * 0.7, -r * 0.25 + 2)
      }
      if (def.weapon === 'halberd') { ctx.moveTo(tip - 3, -r * 0.25); ctx.lineTo(tip - 3, -r * 0.25 - 4) }
      if (def.weapon === 'musket') { ctx.moveTo(r * 0.2, 0); ctx.lineTo(tip * 0.8, 0) }
    }
    ctx.stroke()
    ctx.restore()
    if (def.shieldBlock > 0) {
      ctx.fillStyle = ink; ctx.beginPath(); ctx.ellipse(r * 0.7, r * 0.6, r * 0.3, r * 0.65, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
  }
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
  time: number,
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
  const barW = 46
  const missile = def.missile
  const hpY = missile ? mark.y - 34 : mark.y - 28
  const hp = hpFraction(reg)
  ctx.fillStyle = 'rgba(12, 14, 10, 0.55)'
  ctx.fillRect(mark.x - barW / 2, hpY, barW, 5)
  ctx.fillStyle = reg.side === 0 ? '#7ea36a' : '#b55248'
  ctx.fillRect(mark.x - barW / 2, hpY, barW * hp, 5)
  if (missile) {
    const left = ammoFraction(reg, missile.ammo)
    ctx.fillStyle = 'rgba(12, 14, 10, 0.55)'
    ctx.fillRect(mark.x - barW / 2, hpY + 7, barW, 3)
    ctx.fillStyle = left > 0.25 ? '#d5dbe3' : '#c4493a'
    ctx.fillRect(mark.x - barW / 2, hpY + 7, barW * left, 3)
  }
  const leadershipWidth = Math.max(0, Math.min(1, reg.leadership / def.leadership))
  ctx.fillStyle = reg.leadership < 0 ? '#c4493a' : '#e0c27a'
  ctx.fillRect(mark.x - barW / 2, missile ? hpY + 12 : hpY + 6, barW * leadershipWidth, 2)
  ctx.font = '12px "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = selected ? '#f3e6c2' : 'rgba(231, 225, 209, 0.8)'
  const label = `${reg.name.replace('南军', '').replace('北军', '')} ${reg.aliveCount}`
  ctx.save()
  ctx.globalAlpha *= reg.routing || reg.shattered ? 0.35 : reg.moraleState === 'wavering' ? 0.65 + 0.35 * Math.cos(time * Math.PI * 2) : 1
  ctx.fillText(label, mark.x, hpY - 4)
  ctx.restore()
  if (showStamina) drawStamina(ctx, mark.x, missile ? mark.y - 58 : mark.y - 48, reg)
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
    const tipX = to.x - Math.cos(angle) * 14
    const tipY = to.y - Math.sin(angle) * 14
    ctx.strokeStyle = 'rgba(214, 72, 52, 0.85)'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 6])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(tipX, tipY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(214, 72, 52, 0.95)'
    ctx.beginPath()
    ctx.moveTo(tipX + Math.cos(angle) * 4, tipY + Math.sin(angle) * 4)
    ctx.lineTo(tipX - Math.cos(angle - 0.5) * 12, tipY - Math.sin(angle - 0.5) * 12)
    ctx.lineTo(tipX - Math.cos(angle + 0.5) * 12, tipY - Math.sin(angle + 0.5) * 12)
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
    const lift = (showStamina ? 86 : 48) + pulse * 4
    const size = strong ? 9 : 7
    ctx.fillStyle = strong ? '#e2463a' : 'rgba(226, 70, 50, 0.75)'
    ctx.strokeStyle = 'rgba(20, 10, 8, 0.8)'
    ctx.lineWidth = 1.5
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

function drawStamina(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  reg: Regiment,
): void {
  const def = unitDef(reg.type)
  const state = FATIGUE_NAMES[reg.fatigue]
  const left = Math.max(0, 1 - reg.exertion / FATIGUE.exhausted.threshold)
  const stat = fatigueMods(reg.fatigue).charge
  const full = Math.round(def.chargeBonus * stat)
  const now = Math.round(def.chargeBonus * stat * Math.max(0, ...reg.soldiers.filter(s => s.alive).map(s => chargeDecay(s.chargeLeft))))
  const chargeText = full > 0 ? `冲锋 +${now}/${full}` : '冲锋 无'
  ctx.fillStyle = 'rgba(12, 14, 10, 0.82)'
  ctx.fillRect(x - 58, y - 34, 116, 38)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.fillRect(x - 52, y - 16, 48, 4)
  ctx.fillStyle = left > 0.5 ? '#7ea36a' : left > 0.2 ? '#e0c27a' : '#c4493a'
  ctx.fillRect(x - 52, y - 16, 48 * left, 4)
  ctx.font = '11px "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f3e6c2'
  ctx.fillText(`体力 ${state}`, x - 52, y - 20)
  ctx.fillText(chargeText, x - 52, y - 2)
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
