import { easeCamera, fitCamera, focusRegiment, type Camera, type DragPreview } from './camera'
import { attachInput, attachKeys, clickSelection, gestureOf, pauseWhileHidden, type PointerState } from './input'
import { render } from './render'
import { isBracing } from './sim/formation'
import { setAiEnabled, step } from './sim'
import type { Regiment } from './sim/types'
import { SIM_DT } from './sim/types'
import { outOfAmmo, unitDef } from './sim/units'
import { SCENARIOS, createScenario, type Scenario } from './sim/scenarios'
import { battleErrors, battleSnapshot } from './sim/diagnostics'
import { unitIcon } from './icons'
import { paintUnitPanel } from './unit-panel'
import { commandBehavior } from './sim/orders'
import { PerformanceHud } from './performance'
import { BattleClient } from './battle-client'
import { ARMIES,ARMY_SCALES,DEFAULT_SETUP,createArmyBattle,type ArmyId,type ArmyScale,type ArmySetup } from './sim/armies'
import { setupArmyPicker } from './army-setup'
import { armyPower, southShare } from './sim/power'
import { MECHANICS } from './sim/mechanics'
import { createBattleAudio } from './audio'
import { UNIT_GLYPH } from './scene/banners'

const canvas = document.querySelector<HTMLCanvasElement>('#view')
const score = document.querySelector<HTMLElement>('#score')
const clock = document.querySelector<HTMLElement>('#clock')
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')
const restartButton = document.querySelector<HTMLButtonElement>('#restart')
const aiButton = document.querySelector<HTMLButtonElement>('#ai')
const detail = document.querySelector<HTMLElement>('#detail')
const roster = document.querySelector<HTMLElement>('#roster')
const banner = document.querySelector<HTMLElement>('#banner')
const outcome = document.querySelector<HTMLElement>('#outcome')!
const outcomeText = document.querySelector<HTMLElement>('#outcome-text')!
const notices = document.querySelector<HTMLElement>('#notices')
const powerMeter = document.querySelector<HTMLElement>('#power')!
const powerFill = document.querySelector<HTMLElement>('#power-fill')!
const powerLabels = [document.querySelector<HTMLElement>('#power-south')!, document.querySelector<HTMLElement>('#power-north')!] as const
// The outer marks show the share at which either side has lost the battle; they follow the tunable share.
const [breakSouth, , breakNorth] = powerMeter.querySelectorAll<HTMLElement>('.power-mark')
breakSouth.style.left = `${MECHANICS.armyLossesShare * 100}%`
breakNorth.style.left = `${(1 - MECHANICS.armyLossesShare) * 100}%`
const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')]
const soundButton = document.querySelector<HTMLButtonElement>('#sound')!
// All sound is synthesised; the browser lets it start only after the player's first click or key.
const audio = createBattleAudio()
function paintSound(): void {
  soundButton.textContent = audio.muted ? '音效 关' : '音效 开'
  soundButton.classList.toggle('on', !audio.muted)
  soundButton.setAttribute('aria-pressed', String(!audio.muted))
}
function toggleSound(): void { audio.setMuted(!audio.muted); paintSound() }
soundButton.addEventListener('click', toggleSound)
paintSound()
for (const kind of ['pointerdown', 'keydown'] as const) window.addEventListener(kind, () => audio.unlock(), { capture: true })

if (!canvas || !score || !clock || !pauseButton || !restartButton || !aiButton || !detail || !roster || !banner || !notices) {
  throw new Error('页面结构不完整')
}

// `glide: null` opts this view into eased wheel zoom (see Camera.glide).
const camera: Camera = { x: 0, y: 0, zoom: 1, glide: null }
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
// The player pressed 结束战斗 on a decided battle: it stays stopped, and the result is shown, until a new one starts.
let ended = false
let speed = 1
let accumulator = 0
let last = performance.now()
let paintDeadline = last
let hudAt = -Infinity
let simMs = 0
let pixelRatio = 1

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if(pixelRatio!==dpr) {camera.zoom*=dpr/pixelRatio;camera.glide=null}
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
  ended = false
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
// 'close' runs after the dialog restores focus to its opener; hand the keyboard to the battlefield instead.
armyPicker.dialog.addEventListener('close',()=>focusBattlefield())
function focusBattlefield():void {canvas!.focus({preventScroll:true})}
// Pointer clicks on HUD buttons and roster cards give the keyboard back to the battlefield, so held Space
// or arrows never land on them. Keyboard activation (detail 0) keeps focus where Tab users put it.
for(const panel of [document.querySelector('#top')!,document.querySelector('#orders')!,roster]) panel.addEventListener('click',event=>{
  if((event as MouseEvent).detail>0&&!armyPicker.dialog.open&&(event.target as Element).closest('button')) focusBattlefield()
})

function setSelection(ids: number[], inspect: number | null): void {
  if (ids.length && (ids.length !== selection.length || ids.some((id, i) => id !== selection[i]))) audio.emit('uiSelect')
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
  focusBattlefield()
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

attachInput(canvas, camera, () => client?.display??battle, () => selection, setSelection, pointer, () => gestureOf(keys))

function toggleBehavior(key: 'run' | 'fireAtWill' | 'meleeMode'): void {
  // A missile unit out of ammunition stays in melee mode, so it takes no part in that toggle.
  const regs=battle.regiments.filter(r=>selection.includes(r.id) && isPlayer(r.id) && (key==='run'||unitDef(r.type).missile) && !(key==='meleeMode'&&outOfAmmo(r)))
  if (!regs.length) return
  commandBehavior(battle,regs.map(r=>r.id),{[key]:!regs.some(r=>r[key])})
  hudAt=-Infinity
}
document.querySelector('#gait')!.addEventListener('click',()=>toggleBehavior('run'))
document.querySelector('#fire-at-will')!.addEventListener('click',()=>toggleBehavior('fireAtWill'))
document.querySelector('#melee-mode')!.addEventListener('click',()=>toggleBehavior('meleeMode'))

pauseButton.addEventListener('click', () => {
  if (ended) return
  setPaused(!paused)
})

const SIDE_NAMES = ['南军', '北军'] as const
/** Who has won, once the battle is decided on the power bar. */
function outcomeLine(): string {
  const winner = battle.winner
  return winner === null ? '' : winner === -1 ? '两军同溃' : `${SIDE_NAMES[winner]}胜利 · ${SIDE_NAMES[1 - winner]}全军溃散`
}
/** 结束战斗: a decided battle runs on, so the victor can ride the beaten down, until the player stops it here. */
document.querySelector('#end-battle')!.addEventListener('click', () => {
  if (battle.winner === null || ended) return
  ended = true
  setPaused(true)
  const title = battle.winner === -1 ? '两军同溃' : `${SIDE_NAMES[battle.winner]}胜利`
  const left = (side: 0 | 1) => {
    const regs = battle.regiments.filter(reg => reg.side === side)
    return `${SIDE_NAMES[side]}余 ${regs.reduce((sum, reg) => sum + reg.aliveCount, 0)} / ${regs.reduce((sum, reg) => sum + reg.initial, 0)}`
  }
  const summary = document.createElement('small')
  summary.textContent = `${left(0)} · ${left(1)} · 用时 ${clock!.textContent}`
  banner!.replaceChildren(title, summary)
  hudAt = -Infinity
  focusBattlefield()
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

attachKeys(window, keys, {
  ignore: () => armyPicker.dialog.open,
  toggleRun: () => toggleBehavior('run'),
  toggleMelee: () => toggleBehavior('meleeMode'),
  togglePause: () => {
    if (!ended) setPaused(!paused)
  },
  toggleSound,
  selectAll: () => {
    const ids = battle.regiments.filter(reg => isPlayer(reg.id)).map(reg => reg.id)
    setSelection(ids, ids[0] ?? null)
  },
  saveGroup: digit => groups.set(digit, selection.filter(isPlayer)),
  recallGroup: digit => {
    const saved = groups.get(digit)
    if (!saved) return
    const ids = saved.filter(isPlayer)
    setSelection(ids, ids[0] ?? null)
  },
})
pauseWhileHidden(document, window, () => !paused && !fatalError, setPaused,
  () => !ended && !fatalError && !armyPicker.dialog.open)

window.addEventListener('blur', () => keys.clear())
window.addEventListener('resize', resize)
// Notices and the performance overlay sit just below the top bar, however many rows it wraps to.
const header = document.querySelector<HTMLElement>('#topbar')!
new ResizeObserver(() => document.documentElement.style.setProperty('--below-top', `${header.offsetTop + header.offsetHeight + 8}px`)).observe(header)

function isPlayer(id: number): boolean {
  const reg = battle.regiments.find((item) => item.id === id)
  return !!reg && reg.side === 0 && reg.aliveCount > 0 && !reg.routing
}

/** One presented frame at wall time `now` (ms): camera keys, main-thread simulation, drawing and the HUD. */
function tick(now: number): void {
  // Keep spare CPU/GPU time for the simulation on high-refresh displays.
  // Skip presentation work rather than accumulating redraws to catch up.
  if(now+.25<paintDeadline) return
  const period=1000/60,late=Math.max(0,now-paintDeadline)
  paintDeadline=now+period-late%period
  performanceHud.record('frame',now-last)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const held = (...codes: string[]) => codes.some(code => keys.has(code)) ? 1 : 0
  easeCamera(camera, canvas!.width, canvas!.height, dt, held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'), held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'))
  if (!client && !paused) {
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
  const shown=presentation?.battle??battle
  const visualTime=presentation?.time??(paused ? battle.time : Math.max(0, battle.time - SIM_DT + Math.min(SIM_DT,accumulator)))
  const renderStart=performance.now()
  render(canvas!, {
    battle:shown,
    cacheSprites:url.searchParams.get('sprites')!=='0',
    camera,
    pixelRatio,
    selection,
    hoverId: pointer.hoverId,
    drag: pointer.drag as DragPreview | null,
    dragRegId: pointer.dragRegId,
    // Held Space shows the details: every formation outline, missile range, march and queued order, and every regiment's fatigue.
    showBoxes: keys.has('Space'),
    showStamina: keys.has('Space'),
    alpha: presentation?1:paused ? 1 : Math.min(1, accumulator / SIM_DT),
    visualTime,
    wallTime: now,
    sound: audio.emit,
  })
  audio.update({ battle: shown, camera, width: canvas!.width, height: canvas!.height, time: visualTime, paused, speed })
  performanceHud.record('render',performance.now()-renderStart)
  if (now - hudAt >= 100) { updateHud(); hudAt = now }
  performanceHud.paint(now,!paused&&(client?client.limited:accumulator>=SIM_DT*2),workerStatus,battle.time)
}
function frame(now: number): void {
  tick(now)
  requestAnimationFrame(frame)
}

/** The bar follows the simulation's per-step value; before the first step it is computed from the deployed field. */
function paintPower(): void {
  const power = battle.time > 0 ? battle.power : armyPower(battle)
  const share = southShare(power), percent = Math.round(share * 100)
  powerFill.style.width = `${(share * 100).toFixed(1)}%`
  powerMeter.setAttribute('aria-valuenow', String(percent))
  const names = ['南军', '北军'] as const
  for (const side of [0, 1] as const) {
    const own = side === 0 ? percent : 100 - percent
    const text = `${power.losing[side] ? '溃败 ' : ''}${own}%`
    powerLabels[side].textContent = side === 0 ? `${names[0]} ${text}` : `${text} ${names[1]}`
    powerLabels[side].classList.toggle('losing', power.losing[side])
  }
  powerMeter.setAttribute('aria-valuetext', `${powerLabels[0].textContent}，${powerLabels[1].textContent}`)
  const line = (side: 0 | 1) => `${names[side]}实力 ${Math.round(power.value[side])} / ${Math.round(power.max[side])}`
  powerMeter.title = `${line(0)} · ${line(1)}\n占比不超过 ${Math.round(MECHANICS.armyLossesShare * 100)}% 且剩余不超过自身初始 ${Math.round(MECHANICS.armyLossesRemaining * 100)}% 时战败，全军溃散`
}

function updateHud(): void {
  const armyButton=document.querySelector<HTMLButtonElement>('#army-setup')!
  armyButton.textContent=scenario==='custom'?`部队 · ${armySetup.scale}×`:'部队配置'
  armyButton.title=`${ARMIES[armySetup.player].name} 对 ${ARMIES[armySetup.enemy].name}`
  aiButton!.textContent=battle.aiEnabled?'北军行动':'北军停止';aiButton!.classList.toggle('on',battle.aiEnabled)
  const selected=battle.regiments.filter(r=>selection.includes(r.id) && isPlayer(r.id))
  for (const [id,key] of [['gait','run'],['fire-at-will','fireAtWill'],['melee-mode','meleeMode']] as const) {
    const button=document.querySelector<HTMLButtonElement>(`#${id}`)!
    const eligible=selected.filter(r=>key==='run'||unitDef(r.type).missile)
    const on=eligible.some(r=>r[key])
    // Units out of ammunition are held in melee mode: the button shows on and cannot switch them back.
    const forced=key==='meleeMode' && eligible.length>0 && eligible.every(r=>outOfAmmo(r))
    button.disabled=eligible.length===0 || forced
    if (key==='meleeMode') button.title=forced?'弹药耗尽：自动保持近战模式，不能切回射击':'远程部队改为近战：停止射击，像近战部队一样接敌冲锋（F）'
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
  paintPower()
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
  // An enemy, or a routing card Shift-clicked while others stay selected, is inspected on its own panel.
  const outside = inspectId !== null && !selection.includes(inspectId) && !isPlayer(inspectId)
  const subject = battle.regiments.find((reg) => reg.id === (!outside && selection.length === 1 ? selection[0] : inspectId))
  paintDetail(subject ?? null, !outside && selection.length > 1)
  if(fatalError) {outcome.hidden=true;banner!.hidden=false;banner!.textContent=fatalError;return}
  // Decided, not ended: the top bar names the winner and offers to end the battle, and the battle runs on.
  outcome.hidden = battle.winner === null || ended
  if (!outcome.hidden) outcomeText.textContent = outcomeLine()
  banner!.hidden = !ended
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
      button.innerHTML = `<span class="card-glyph">${UNIT_GLYPH[reg.type]}</span><span class="card-name">${def.name}</span><span class="portrait">${unitIcon(def)}</span><span class="card-count"></span><span class="card-state"></span><span class="card-hp"><i></i></span><span class="card-ammo"><i></i></span>`
      button.addEventListener('click', event => {
        const current = battle.regiments.find(r => r.id === reg.id)
        if (!current) return
        const next = clickSelection(selection, current.id, event.shiftKey || event.ctrlKey, !current.routing && current.aliveCount > 0)
        setSelection(next.ids, next.inspect)
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

function paintDetail(subject: Regiment | null, multi: boolean): void {
  const root = detail!
  if (multi) {
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
    hint.textContent = '选中一支队伍查看属性。P 暂停，按住 Alt 看全部队形，按住空格看疲劳。'
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
if(url.searchParams.get('hook')==='1') {
  // Scripted capture (?hook=1, best with sim=main): the page stands still until told to play so many milliseconds,
  // one 60 Hz frame at a time, so screenshots and checks do not depend on the tab being visible.
  let clock=last
  const hooks=window as unknown as {battleStep:(ms:number)=>number;battleCamera:Camera;battleNow:()=>typeof battle}
  hooks.battleStep=ms=> {
    for(const end=clock+ms;clock<end;) {clock+=1000/60;tick(clock)}
    return battle.time
  }
  hooks.battleCamera=camera
  hooks.battleNow=()=>client?.display??battle
} else requestAnimationFrame(frame)
