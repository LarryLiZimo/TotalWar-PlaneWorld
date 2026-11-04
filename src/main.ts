import { fitCamera, type Camera, type DragPreview } from './camera'
import { attachInput, type PointerState } from './input'
import { render } from './render'
import { isBracing } from './sim/formation'
import { createBattle, setAiEnabled, step } from './sim'
import type { Regiment } from './sim/types'
import { SIM_DT } from './sim/types'
import { unitDef } from './sim/units'

const canvas = document.querySelector<HTMLCanvasElement>('#view')
const score = document.querySelector<HTMLElement>('#score')
const clock = document.querySelector<HTMLElement>('#clock')
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')
const restartButton = document.querySelector<HTMLButtonElement>('#restart')
const aiButton = document.querySelector<HTMLButtonElement>('#ai')
const detail = document.querySelector<HTMLElement>('#detail')
const roster = document.querySelector<HTMLElement>('#roster')
const banner = document.querySelector<HTMLElement>('#banner')
const notices = document.querySelector<HTMLElement>('#notices')
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')]

if (!canvas || !score || !clock || !pauseButton || !restartButton || !aiButton || !detail || !roster || !banner || !notices) {
  throw new Error('页面结构不完整')
}

const camera: Camera = { x: 0, y: 0, zoom: 1 }
const pointer: PointerState = { drag: null, dragRegId: null, hoverId: null }
const keys = new Set<string>()
const groups = new Map<number, number[]>()

let battle = createBattle()
let selection: number[] = []
let inspectId: number | null = null
let paused = false
let speed = 1
let seed = 20261103
let accumulator = 0
let last = performance.now()

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const rect = canvas!.getBoundingClientRect()
  canvas!.width = Math.max(1, Math.floor(rect.width * dpr))
  canvas!.height = Math.max(1, Math.floor(rect.height * dpr))
}

function restart(): void {
  seed += 1
  battle = createBattle(seed)
  selection = []
  inspectId = null
  paused = false
  accumulator = 0
  pauseButton!.textContent = '暂停'
  aiButton!.textContent = '北军停止'
  aiButton!.classList.remove('on')
  banner!.hidden = true
}

function setSelection(ids: number[], inspect: number | null): void {
  selection = ids
  inspectId = inspect
}

attachInput(canvas, camera, () => battle, () => selection, setSelection, pointer)

pauseButton.addEventListener('click', () => {
  if (battle.winner !== null) return
  paused = !paused
  pauseButton.textContent = paused ? '继续' : '暂停'
})

restartButton.addEventListener('click', restart)
aiButton.addEventListener('click', () => {
  setAiEnabled(battle, !battle.aiEnabled)
  aiButton.textContent = battle.aiEnabled ? '北军行动' : '北军停止'
  aiButton.classList.toggle('on', battle.aiEnabled)
})
for (const button of speedButtons) {
  button.addEventListener('click', () => {
    speed = Number(button.dataset.speed)
    for (const other of speedButtons) other.classList.toggle('on', other === button)
  })
}

window.addEventListener('keydown', (event) => {
  keys.add(event.code)
  if (event.repeat) return
  if (event.code === 'KeyP') {
    if (battle.winner === null) {
      paused = !paused
      pauseButton!.textContent = paused ? '继续' : '暂停'
    }
  }
  if (event.code === 'Space' || event.code === 'AltLeft' || event.code === 'AltRight') event.preventDefault()
  const digit = digitOf(event.code)
  if (digit === null) return
  if (event.ctrlKey || event.metaKey) {
    groups.set(digit, selection.filter(isPlayer))
    event.preventDefault()
    return
  }
  const saved = groups.get(digit)
  if (!saved) return
  const ids = saved.filter(isPlayer)
  setSelection(ids, ids[0] ?? null)
})

window.addEventListener('keyup', (event) => keys.delete(event.code))
window.addEventListener('blur', () => keys.clear())
window.addEventListener('resize', resize)

function isPlayer(id: number): boolean {
  const reg = battle.regiments.find((item) => item.id === id)
  return !!reg && reg.side === 0 && reg.aliveCount > 0 && !reg.routing
}

function digitOf(code: string): number | null {
  if (!/^Digit[1-9]$/.test(code)) return null
  return Number(code.slice(5))
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const pan = 48 * dt
  if (keys.has('KeyW') || keys.has('ArrowUp')) camera.y += pan
  if (keys.has('KeyS') || keys.has('ArrowDown')) camera.y -= pan
  if (keys.has('KeyA') || keys.has('ArrowLeft')) camera.x -= pan
  if (keys.has('KeyD') || keys.has('ArrowRight')) camera.x += pan
  if (!paused && battle.winner === null) {
    accumulator += dt * speed
    let steps = 0
    while (accumulator >= SIM_DT && steps < 8) {
      step(battle, SIM_DT)
      accumulator -= SIM_DT
      steps += 1
    }
    if (steps === 8) accumulator = 0
  }
  render(canvas!, {
    battle,
    camera,
    selection,
    hoverId: pointer.hoverId,
    drag: pointer.drag as DragPreview | null,
    dragRegId: pointer.dragRegId,
    showBoxes: keys.has('AltLeft') || keys.has('AltRight'),
    showStamina: keys.has('Space'),
  })
  updateHud()
  requestAnimationFrame(frame)
}

function updateHud(): void {
  const men = (sideId: 0 | 1) =>
    battle.regiments.filter((reg) => reg.side === sideId).reduce((sum, reg) => sum + reg.aliveCount, 0)
  score!.textContent = `南军 ${men(0)} · 北军 ${men(1)}`
  const seconds = Math.floor(battle.time)
  clock!.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const noticeText = battle.notices.map((notice) => notice.text).join('\n')
  if (notices!.dataset.text !== noticeText) {
    notices!.dataset.text = noticeText
    notices!.replaceChildren(
      ...battle.notices.map((notice) => {
        const item = document.createElement('li')
        item.textContent = notice.text
        return item
      }),
    )
  }
  ensureRoster()
  const subject = battle.regiments.find((reg) => reg.id === (selection.length === 1 ? selection[0] : inspectId))
  paintDetail(subject ?? null)
  if (battle.winner === null) {
    banner!.hidden = true
    return
  }
  banner!.hidden = false
  banner!.textContent = battle.winner === 0 ? '南军胜利' : battle.winner === 1 ? '北军胜利' : '两军同溃'
}

function ensureRoster(): void {
  const root = roster!
  if (root.dataset.seed === String(battle.seed) && root.childElementCount === battle.regiments.length) {
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
      const reg = battle.regiments.find((item) => item.id === Number(button.dataset.id))
      if (!reg) continue
      const text = `${reg.name}  ${reg.aliveCount}/${reg.initial}`
      if (button.textContent !== text) button.textContent = text
      button.className = selection.includes(reg.id) || inspectId === reg.id ? 'row on' : 'row'
    }
    return
  }
  root.dataset.seed = String(battle.seed)
  root.replaceChildren()
  for (const reg of battle.regiments) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'row'
    button.dataset.id = String(reg.id)
    button.textContent = `${reg.name}  ${reg.aliveCount}/${reg.initial}`
    button.addEventListener('click', () => {
      const current = battle.regiments.find((item) => item.id === reg.id)
      if (!current) return
      if (current.side === 0 && current.aliveCount > 0) setSelection([current.id], current.id)
      else setSelection([], current.id)
    })
    root.append(button)
  }
}

function paintDetail(subject: Regiment | null): void {
  const root = detail!
  if (selection.length > 1) {
    const men = selection.reduce((sum, id) => sum + (battle.regiments.find((item) => item.id === id)?.aliveCount ?? 0), 0)
    const text = `已选 ${selection.length} 支 · ${men} 人`
    if (root.dataset.mode === 'multi' && root.dataset.text === text) return
    root.dataset.mode = 'multi'
    root.dataset.text = text
    root.replaceChildren()
    const summary = document.createElement('p')
    summary.textContent = text
    root.append(summary)
    return
  }
  if (!subject) {
    if (root.dataset.mode === 'empty') return
    root.dataset.mode = 'empty'
    root.dataset.text = ''
    root.replaceChildren()
    const hint = document.createElement('p')
    hint.className = 'muted'
    hint.textContent = '选中一支队伍查看属性。P 暂停，按住 Alt 看全部队形，按住空格看体力。'
    root.append(hint)
    return
  }
  const def = unitDef(subject.type)
  const fatigue = subject.fatigue === 'exhausted' ? '力竭' : subject.fatigue === 'winded' ? '气喘' : '精神'
  const order = subject.routing ? '溃逃' : subject.order === 'attack' ? '攻击' : subject.order === 'move' ? '移动' : '停留'
  const foe = nearestAnchor(subject)
  const bracing = foe ? isBracing(subject, def, foe.x, foe.y) : false
  const text = [
    subject.name,
    `${def.name} · ${order}${bracing ? ' · 列阵' : ''}${subject.bogged ? ' · 停滞' : ''}`,
    `人数 ${subject.aliveCount}/${subject.initial} · 领导力 ${Math.round(subject.leadership)} · ${fatigue}`,
    hpFraction(subject).toFixed(3),
    Math.max(0, subject.leadership / def.leadership).toFixed(3),
  ].join('|')
  if (root.dataset.mode === 'one' && root.dataset.text === text) return
  root.dataset.mode = 'one'
  root.dataset.text = text
  root.replaceChildren()
  const title = document.createElement('h2')
  title.textContent = subject.name
  const meta = document.createElement('p')
  meta.textContent = text.split('|')[1]
  const count = document.createElement('p')
  count.textContent = text.split('|')[2]
  const bars = document.createElement('div')
  bars.className = 'bars'
  bars.append(bar('生命', hpFraction(subject), subject.side === 0 ? '#7ea36a' : '#b55248'))
  bars.append(bar('领导力', Math.max(0, subject.leadership / def.leadership), '#e0c27a'))
  const stats = document.createElement('p')
  stats.className = 'muted'
  stats.textContent = `攻击 ${def.meleeAttack} · 防御 ${def.meleeDefense} · 护甲 ${def.armor} · 武器 ${def.weaponBase}+${def.weaponAp}`
  root.append(title, meta, count, bars, stats)
}

function bar(label: string, fraction: number, color: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'bar-row'
  const name = document.createElement('span')
  name.textContent = label
  const track = document.createElement('div')
  track.className = 'track'
  const fill = document.createElement('div')
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`
  fill.style.background = color
  track.append(fill)
  row.append(name, track)
  return row
}

function hpFraction(reg: Regiment): number {
  const max = reg.initial * unitDef(reg.type).hp
  let hp = 0
  for (const soldier of reg.soldiers) if (soldier.alive) hp += Math.max(0, soldier.hp)
  return max <= 0 ? 0 : hp / max
}

function nearestAnchor(reg: Regiment): { x: number; y: number } | null {
  let best: Regiment | null = null
  let bestD = Infinity
  for (const other of battle.regiments) {
    if (other.side === reg.side || other.aliveCount <= 0) continue
    const distance = Math.hypot(other.anchorX - reg.anchorX, other.anchorY - reg.anchorY)
    if (distance < bestD) {
      best = other
      bestD = distance
    }
  }
  return best ? { x: best.anchorX, y: best.anchorY } : null
}

resize()
fitCamera(camera, canvas.width, canvas.height)
requestAnimationFrame(frame)
