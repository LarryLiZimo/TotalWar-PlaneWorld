import { fitCamera, focusRegiment, type Camera, type DragPreview } from './camera'
import { attachInput, type PointerState } from './input'
import { render } from './render'
import { isBracing } from './sim/formation'
import { setAiEnabled, step } from './sim'
import type { Regiment } from './sim/types'
import { SIM_DT } from './sim/types'
import { unitDef } from './sim/units'
import { SCENARIOS, createScenario, type Scenario } from './sim/scenarios'
import { battleErrors, battleSnapshot } from './sim/diagnostics'
import { unitIcon } from './icons'
import { paintUnitPanel } from './unit-panel'
import { commandBehavior } from './sim/orders'
import { PerformanceHud } from './performance'
import { BattleClient } from './battle-client'
import { ARMIES,ARMY_SCALES,DEFAULT_SETUP,createArmyBattle,type ArmyId,type ArmyScale,type ArmySetup } from './sim/armies'
import { setupArmyPicker } from './army-setup'

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

const scenarioSelect = document.querySelector<HTMLSelectElement>('#scenario')!
for (const [id, label] of Object.entries(SCENARIOS)) scenarioSelect.add(new Option(label, id))
const url = new URL(location.href)
const performanceHud=new PerformanceHud(url.searchParams.get('perf')==='1')
let scenario: Scenario = Object.hasOwn(SCENARIOS, url.searchParams.get('scenario') ?? '') ? url.searchParams.get('scenario') as Scenario : 'custom'
scenarioSelect.value = scenario
const suppliedSeed = Number(url.searchParams.get('seed'))
let seed = url.searchParams.has('seed') && Number.isFinite(suppliedSeed) ? suppliedSeed : 20261104
let armySetup:ArmySetup={
  player:Object.hasOwn(ARMIES,url.searchParams.get('player')??'')?url.searchParams.get('player') as ArmyId:DEFAULT_SETUP.player,
  enemy:Object.hasOwn(ARMIES,url.searchParams.get('enemy')??'')?url.searchParams.get('enemy') as ArmyId:DEFAULT_SETUP.enemy,
  scale:ARMY_SCALES.includes(Number(url.searchParams.get('scale')) as ArmyScale)?Number(url.searchParams.get('scale')) as ArmyScale:4,
}
let battle = scenario==='custom'?createArmyBattle(armySetup,seed):createScenario(scenario, seed)
let client:BattleClient|null=null
let workerStatus='主线程'
let fatalError=''
const useWorker=url.searchParams.get('sim')!=='main'&&typeof Worker!=='undefined'
let selection: number[] = []
let inspectId: number | null = null
let paused = scenario==='custom'
let speed = 1
let accumulator = 0
let last = performance.now()
let hudAt = -Infinity
let simMs = 0
let pixelRatio = 1

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if(pixelRatio!==dpr) camera.zoom*=dpr/pixelRatio
  pixelRatio=dpr
  const rect = canvas!.getBoundingClientRect()
  canvas!.width = Math.max(1, Math.floor(rect.width * dpr))
  canvas!.height = Math.max(1, Math.floor(rect.height * dpr))
}

function restart(): void {
  fatalError=''
  client?.dispose();client=null
  battle = scenario==='custom'?createArmyBattle(armySetup,seed):createScenario(scenario, seed)
  selection = []
  inspectId = null
  paused = false
  accumulator = 0
  pauseButton!.textContent = '暂停'
  aiButton!.textContent = battle.aiEnabled?'北军行动':'北军停止'
  aiButton!.classList.toggle('on',battle.aiEnabled)
  banner!.hidden = true
  groups.clear()
  pointer.drag = null
  pointer.dragRegId = null
  pointer.hoverId = null
  hudAt = -Infinity
  performanceHud.reset()
  startClient()
}

function startClient():void {
  if(!useWorker) return
  workerStatus='独立模拟线程 · 启动中'
  try {
    client=new BattleClient({scenario,seed,setup:scenario==='custom'?armySetup:undefined},paused,speed,
      current=>{battle=current;hudAt=-Infinity;workerStatus='独立模拟线程'},
      times=>{for(const ms of times) performanceHud.record('sim',ms)},
      message=>{paused=true;fatalError=`模拟停止：${message}`;pauseButton!.textContent='继续';banner!.hidden=false;banner!.textContent=fatalError;console.error(message)},
    )
    const active=client
    battle.sendCommand=command=>active.command(command)
  } catch(error) {workerStatus='主线程 · 独立线程启动失败';console.warn(error)}
}
function setPaused(value:boolean):void {
  paused=value;accumulator=0;pauseButton!.textContent=paused?'继续':'暂停';client?.control(paused,speed)
}
let pausedBeforeSetup=paused
const armyPicker=setupArmyPicker(armySetup,chosen=>{
  armySetup=chosen;scenario='custom';scenarioSelect.value=scenario;speed=1
  for(const button of speedButtons) button.classList.toggle('on',button.dataset.speed==='1')
  restart();setAiEnabled(battle,true)
  // Commands sent before the initial snapshot are queued by the worker in order.
  if(client&&!client.ready) client.control(false,1)
  url.searchParams.set('scenario','custom');url.searchParams.set('player',chosen.player);url.searchParams.set('enemy',chosen.enemy);url.searchParams.set('scale',String(chosen.scale));url.searchParams.set('seed',String(seed))
  history.replaceState(null,'',url)
},()=>setPaused(pausedBeforeSetup))
document.querySelector('#army-setup')!.addEventListener('click',()=>{
  pausedBeforeSetup=paused;setPaused(true);keys.clear();pointer.drag=null;pointer.dragRegId=null;armyPicker.open(armySetup)
})

function setSelection(ids: number[], inspect: number | null): void {
  selection = ids
  inspectId = inspect
  hudAt = -Infinity
}

scenarioSelect.addEventListener('change', () => {
  scenario = scenarioSelect.value as Scenario
  restart()
  url.searchParams.set('scenario', scenario)
  url.searchParams.set('seed', String(seed))
  history.replaceState(null, '', url)
})
document.querySelector('#single-step')!.addEventListener('click', () => {
  setPaused(true)
  if(client) client.singleStep();else step(battle,SIM_DT)
  hudAt=-Infinity
})
document.querySelector('#snapshot')!.addEventListener('click',async()=> {
  const button=document.querySelector<HTMLButtonElement>('#snapshot')!;button.disabled=true
  try {
    const snapshot=client?await client.snapshot():{errors:battleErrors(battle),...battleSnapshot(battle)}
    const blob=new Blob([JSON.stringify({scenario,armySetup,...snapshot as object},null,2)],{type:'application/json'})
    const href=URL.createObjectURL(blob),link=document.createElement('a')
    link.href=href;link.download=`battle-${scenario}-${seed}-${battle.time.toFixed(2)}.json`;link.click()
    setTimeout(()=>URL.revokeObjectURL(href),1000)
  } catch(error) {alert(String(error))} finally {button.disabled=false}
})

attachInput(canvas, camera, () => client?.display??battle, () => selection, setSelection, pointer)

function toggleBehavior(key: 'run' | 'fireAtWill' | 'skirmish'): void {
  const regs=battle.regiments.filter(r=>selection.includes(r.id) && isPlayer(r.id) && (key==='run'||unitDef(r.type).missile))
  commandBehavior(battle,regs.map(r=>r.id),{[key]:!regs.some(r=>r[key])})
  hudAt=-Infinity
}
document.querySelector('#gait')!.addEventListener('click',()=>toggleBehavior('run'))
document.querySelector('#fire-at-will')!.addEventListener('click',()=>toggleBehavior('fireAtWill'))
document.querySelector('#skirmish')!.addEventListener('click',()=>toggleBehavior('skirmish'))

pauseButton.addEventListener('click', () => {
  if (battle.winner !== null) return
  setPaused(!paused)
})

restartButton.addEventListener('click', restart)
aiButton.addEventListener('click', () => {
  setAiEnabled(battle,!battle.aiEnabled)
})
for (const button of speedButtons) {
  button.addEventListener('click', () => {
    speed = Number(button.dataset.speed)
    client?.control(paused,speed)
    for (const other of speedButtons) other.classList.toggle('on', other === button)
  })
}

window.addEventListener('keydown', (event) => {
  if(armyPicker.dialog.open) return
  keys.add(event.code)
  if (event.repeat) return
  if (event.code==='KeyR') toggleBehavior('run')
  if (event.code === 'KeyP') {
    if (battle.winner === null) {
      setPaused(!paused)
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
  performanceHud.record('frame',now-last)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const pan = 48 * dt
  if (keys.has('KeyW') || keys.has('ArrowUp')) camera.y += pan
  if (keys.has('KeyS') || keys.has('ArrowDown')) camera.y -= pan
  if (keys.has('KeyA') || keys.has('ArrowLeft')) camera.x -= pan
  if (keys.has('KeyD') || keys.has('ArrowRight')) camera.x += pan
  if (!client && !paused && battle.winner === null) {
    accumulator += dt * speed
    let steps = 0
    const simulationStart=performance.now()
    while (accumulator >= SIM_DT && steps < 12) {
      const start = performance.now()
      step(battle, SIM_DT)
      simMs = performance.now() - start
      performanceHud.record('sim',simMs)
      accumulator -= SIM_DT
      steps += 1
      if(steps>=2&&performance.now()-simulationStart>=8) break
    }
    // Bound catch-up work rather than freezing a frame with many heavy steps.
    // Under load simulation slows in wall time; no fixed simulation step is skipped.
    accumulator=Math.min(accumulator,0.25)
  }
  const presentation=client?.presentation(now,paused)
  if(client) simMs=client.stepMs
  const renderStart=performance.now()
  render(canvas!, {
    battle:presentation?.battle??battle,
    cacheSprites:url.searchParams.get('sprites')!=='0',
    camera,
    selection,
    hoverId: pointer.hoverId,
    drag: pointer.drag as DragPreview | null,
    dragRegId: pointer.dragRegId,
    showBoxes: keys.has('AltLeft') || keys.has('AltRight'),
    showStamina: keys.has('Space'),
    alpha: presentation?1:paused || battle.winner !== null ? 1 : Math.min(1, accumulator / SIM_DT),
    visualTime: presentation?.time??(paused ? battle.time : Math.max(0, battle.time - SIM_DT + Math.min(SIM_DT,accumulator))),
  })
  performanceHud.record('render',performance.now()-renderStart)
  if (now - hudAt >= 100) { updateHud(); hudAt = now }
  performanceHud.paint(now,!paused&&battle.winner===null&&(client?client.limited:accumulator>=SIM_DT*2),workerStatus,battle.time)
  requestAnimationFrame(frame)
}

function updateHud(): void {
  const armyButton=document.querySelector<HTMLButtonElement>('#army-setup')!
  armyButton.textContent=scenario==='custom'?`部队 · ${armySetup.scale}×`:'部队配置'
  armyButton.title=`${ARMIES[armySetup.player].name} 对 ${ARMIES[armySetup.enemy].name}`
  aiButton!.textContent=battle.aiEnabled?'北军行动':'北军停止';aiButton!.classList.toggle('on',battle.aiEnabled)
  const selected=battle.regiments.filter(r=>selection.includes(r.id) && isPlayer(r.id))
  for (const [id,key] of [['gait','run'],['fire-at-will','fireAtWill'],['skirmish','skirmish']] as const) {
    const button=document.querySelector<HTMLButtonElement>(`#${id}`)!
    const eligible=selected.filter(r=>key==='run'||unitDef(r.type).missile)
    const on=eligible.some(r=>r[key])
    button.disabled=eligible.length===0
    button.classList.toggle('on',on)
    button.setAttribute('aria-pressed',String(on))
    if (key==='run') {
      const mixed=on && eligible.some(r=>!r.run)
      const running=eligible.length===0 || on
      const label=eligible.length===0?'默认跑步':mixed?'混合步态':running?'当前跑步':'当前走路'
      button.textContent=mixed?'»/›':running?'»':'›'
      button.setAttribute('aria-label',label)
      button.title=`${label}；点击切换为${running?'走路':'跑步'}（R）。新命令默认跑步。`
    }
  }
  const men = (sideId: 0 | 1) =>
    battle.regiments.filter((reg) => reg.side === sideId).reduce((sum, reg) => sum + reg.aliveCount, 0)
  score!.textContent = `南军 ${men(0)} · 北军 ${men(1)}`
  const seconds = Math.floor(battle.time)
  clock!.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  clock!.title = `种子 ${seed} · 上一步 ${simMs.toFixed(1)} ms / ${SIM_DT * 1000} ms 预算`
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
  if(fatalError) {banner!.hidden=false;banner!.textContent=fatalError;return}
  if (battle.winner === null) {
    banner!.hidden = true
    return
  }
  banner!.hidden = false
  banner!.textContent = battle.winner === 0 ? '南军胜利' : battle.winner === 1 ? '北军胜利' : '两军同溃'
}

function ensureRoster(): void {
  const root = roster!
  const regs = battle.regiments.filter(r => r.side === 0)
  const rosterKey = `${scenario}:${battle.seed}:${scenario==='custom'?JSON.stringify(armySetup):''}`
  if (root.dataset.seed !== rosterKey || root.childElementCount !== regs.length) {
    root.dataset.seed = rosterKey
    root.replaceChildren()
    for (const reg of regs) {
      const def = unitDef(reg.type)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'unit-card'
      button.dataset.id = String(reg.id)
      button.setAttribute('aria-label', reg.name)
      button.innerHTML = `<span class="card-name">${def.name}</span><span class="portrait">${unitIcon(def)}</span><span class="card-count"></span><span class="card-state"></span><span class="card-hp"><i></i></span><span class="card-ammo"><i></i></span>`
      button.addEventListener('click', event => {
        const current = battle.regiments.find(r => r.id === reg.id)
        if (!current) return
        if (current.routing || current.aliveCount <= 0) { setSelection([],current.id); return }
        const next = event.shiftKey || event.ctrlKey ? selection.includes(current.id) ? selection.filter(id => id !== current.id) : [...selection, current.id] : [current.id]
        setSelection(next, current.id)
      })
      button.addEventListener('dblclick', () => {
        const current=(client?.display??battle).regiments.find(r=>r.id===reg.id)
        if(current) focusRegiment(camera,current)
      })
      root.append(button)
    }
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const reg = battle.regiments.find(r => r.id === Number(button.dataset.id))!
    const def = unitDef(reg.type)
    const escaped=reg.soldiers.filter(s=>s.escaped).length
    const state = reg.aliveCount <= 0 ? escaped?'已退场':'覆灭' : reg.shattered ? '彻底溃散' : reg.routing ? '溃逃' : reg.moraleState==='wavering' ? '动摇' : reg.engaged ? '近战' : reg.shot ? '射击/装填' : reg.order === 'move' ? (reg.run?'跑步':'步行') : reg.order === 'attack' ? '攻击' : '坚守'
    button.className = `unit-card${selection.includes(reg.id) ? ' on' : ''}${reg.routing ? ' routing' : ''}${reg.routing||reg.aliveCount<=0?' uncontrollable':''}`
    button.setAttribute('aria-pressed', String(selection.includes(reg.id)))
    button.title = `${reg.name} · ${state}${escaped?` · 逃离 ${escaped}`:''} · 领导力 ${Math.round(reg.leadership)} · ${reg.routing||reg.aliveCount<=0?'仅查看，无法下令；双击定位仍在场的士兵':'Shift/Ctrl 追加选择，双击定位部队'}`
    button.querySelector('.card-count')!.textContent = `${reg.aliveCount}/${reg.initial}`
    button.querySelector('.card-state')!.textContent = state
    ;(button.querySelector('.card-hp i') as HTMLElement).style.width = `${hpFraction(reg) * 100}%`
    const ammo = def.missile ? reg.soldiers.reduce((sum, s) => sum + (s.alive ? s.ammo : 0), 0) / Math.max(1, reg.aliveCount * def.missile.ammo) : 0
    ;(button.querySelector('.card-ammo') as HTMLElement).hidden = !def.missile
    ;(button.querySelector('.card-ammo i') as HTMLElement).style.width = `${ammo * 100}%`
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
  const def=unitDef(subject.type)
  const foe=nearestAnchor(subject)
  paintUnitPanel(root,subject,foe?isBracing(subject,def,foe.x,foe.y):false)
}

function hpFraction(reg: Regiment): number {
  const max = reg.initial * reg.modelHp
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
startClient()
if(scenario==='custom') armyPicker.open(armySetup)
requestAnimationFrame(frame)
