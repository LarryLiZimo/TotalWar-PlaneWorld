import { fatigueMods, woundMods } from './sim/combat'
import { FATIGUE_NAMES, MECHANICS } from './sim/mechanics'
import type { Regiment } from './sim/types'
import { unitDef } from './sim/units'

export interface StatRow { key:string;label:string;value:number;max:number;display?:string;hint?:string }
export interface Ability {key:string;label:string;hint:string}

/** General attributes include fatigue and wounds; target-specific bonuses stay in abilities. */
export function unitPanelData(reg:Regiment,bracing=false) {
  const def=unitDef(reg.type),mods=fatigueMods(reg.fatigue)
  let hp=0,ammo=0,damage=0,speed=0,count=0
  for(const s of reg.soldiers) if(s.alive) {
    hp+=Math.max(0,s.hp);ammo+=s.ammo;count++
    const wound=woundMods(def,s);damage+=wound.damage;speed+=wound.speed
  }
  damage=count?damage/count:1;speed=count?speed/count:1
  const base=def.weaponBase*damage,ap=def.weaponAp*mods.ap*damage
  const labels:Record<string,string>={base:'基础',casualties:'战损',position:'侧背',damaged:'受伤',winning:'占优',routingFriends:'友军溃逃',recentLosses:'近期损伤',encourage:'鼓舞',commander:'将军阵亡',armyLosses:'全军败势',fear:'恐惧',fatigue:'疲劳'}
  const reasons=Object.entries(reg.moraleFactors).filter(([,v])=>v!==0).map(([key,v])=>`${labels[key]??key} ${v>0?'+':''}${Math.round(v)}`).join(' · ')
  const rows:StatRow[]=[
    {key:'armor',label:'护甲',value:def.armor*mods.armor,max:200},
    {key:'leadership',label:'领导力',value:reg.leadership,max:100,hint:reasons},
    {key:'speed',label:'速度',value:def.speed*mods.speed*speed,max:15,display:(def.speed*mods.speed*speed).toFixed(1),hint:'跑步速度（米/秒），已计入体力与负伤；地形和接触会进一步影响实际速度。'},
    {key:'attack',label:'近战攻击',value:def.meleeAttack*mods.attack,max:100,hint:'已计入体力；对目标加成与短暂的冲锋加成在交战时另计。'},
    {key:'defense',label:'近战防御',value:Math.max(0,def.meleeDefense*mods.defense-(reg.bogged?8:0)),max:100},
    {key:'weapon',label:'武器威力',value:base+ap,max:150,hint:`普通 ${Math.round(base)} · 破甲 ${Math.round(ap)}；已计入体力与负伤。多模型负伤时显示存活模型均值。横条满刻度 150。`},
    {key:'charge',label:'冲锋加成',value:def.chargeBonus*mods.charge,max:100,hint:'达到本兵种有效冲锋速度并接敌后，同时增加近攻和武器威力，13 秒线性衰减。无距离或队形门槛；适用的正面列阵冲锋防御可抵消。'},
  ]
  if(def.missile) rows.push(
    {key:'range',label:'射程',value:def.missile.range,max:200},
    {key:'missile',label:'远程威力',value:(def.missile.base+def.missile.ap)*damage,max:100,hint:`普通 ${Math.round(def.missile.base*damage)} · 破甲 ${Math.round(def.missile.ap*damage)}`},
    {key:'reload',label:'装填',value:def.missile.reload*mods.reload,max:20,display:`${(def.missile.reload*mods.reload).toFixed(1)}s`},
    {key:'ammo',label:'弹药',value:ammo,max:reg.initial*def.missile.ammo,display:`${ammo}`},
  )
  const abilities:Ability[]=[]
  const add=(key:string,label:string,hint:string)=>abilities.push({key,label,hint})
  if(def.shieldBlock) add('shield',`盾牌 ${Math.round(def.shieldBlock*100)}%`,'正面远程格挡概率。')
  if(def.antiLargeMa||def.antiLargeWs) add('large',`反大型 +${def.antiLargeMa}/${def.antiLargeWs}`,'对大型目标增加近战攻击 / 武器威力。')
  if(def.antiInfantryMa||def.antiInfantryWs) add('infantry',`反步兵 +${def.antiInfantryMa}/${def.antiInfantryWs}`,'对小型目标增加近战攻击 / 武器威力。')
  if(def.chargeDefense!=='none') add('brace',def.chargeDefense==='all'?'全冲锋防御':'反大型冲锋防御',bracing?'当前已列阵，正面满足防御条件。':'站稳并面向来敌时生效。')
  if(def.chargeReflection) add('reflection','冲锋反制','列阵时反制近期冲锋接触的目标。')
  if(def.causesFear) add('fear','恐惧',`周围 ${MECHANICS.fearRadius} 米敌军领导力 ${MECHANICS.fearPenalty}，不叠加。`)
  if(def.causesTerror) add('terror',reg.terrorCooldown>0?`惊骇 ${Math.ceil(reg.terrorCooldown)}s`:'惊骇 · 就绪',`造成有效伤害后可使低领导力目标惊骇；${MECHANICS.terrorCooldown} 秒冷却在本单位上。`)
  if(def.immunePsychology) add('psychology','免疫心理','免疫恐惧和惊骇。')
  if(def.unbreakable) add('unbreakable','永不溃逃','不因领导力下降而溃逃。')
  if(def.commander) add('commander','将军','阵亡影响全军领导力。')
  if(def.encourage) add('encourage',`鼓舞 +${def.encourage}`,`在 ${MECHANICS.encourageRadius} 米内提供领导力。`)
  if(def.collisionAttack) add('collision','碰撞攻击',`每 ${def.collisionAttack.interval} 秒，最多 ${def.collisionAttack.targets} 个目标。`)
  if(def.splash>1) add('splash',`溅射 ${def.splash}`,'一次挥击共享武器伤害的最大目标数。')
  if(def.wounds) add('wounds','负伤机制',`生命低于 ${Math.round(def.wounds.threshold*100)}% 时降低伤害与速度。`)
  for(const [key,label] of [['physical','物理抗性'],['missile','远程抗性'],['fire','火焰抗性'],['spell','法术抗性'],['ward','特保']] as const) {
    if(def.resistances[key]) add(key,`${label} ${Math.round(def.resistances[key]*100)}%`,'符合伤害类型时生效。')
  }
  if(def.missile?.fireWhileMoving) add('mobile','移动射击','移动时仍可射击。')
  if(def.missile?.bonusVsLarge) add('missileLarge',`远程反大型 +${def.missile.bonusVsLarge}`,'仅弹丸命中大型目标时生效；按弹丸普通/破甲比例分配额外伤害。')
  if((def.missile?.penetration??1)>1) add('penetration',`穿透 ${def.missile!.penetration}`,`命中时按目标身体阻力扣除预算；穿透后保留 ${Math.round(def.missile!.penetrationDamage*100)}% 伤害。`)
  if((def.missile?.shotsPerVolley??1)>1) add('volley',`齐射 ${def.missile!.shotsPerVolley} 发`,'每个模型一次装填发射的弹丸数；每发独立散布，弹药按轮计。')
  const escaped=reg.soldiers.filter(s=>s.escaped).length
  const order=reg.aliveCount<=0?(escaped?'已退场':'覆灭'):reg.routing?'溃逃':reg.engaged?'近战':reg.order==='attack'?'攻击':reg.order==='move'?(reg.run?'跑步':'走路'):'坚守'
  const status=[order,FATIGUE_NAMES[reg.fatigue],reg.moraleState==='wavering'?'动摇':'',reg.shattered?'彻底溃散':'',reg.soldiers.some(s=>s.alive&&s.wounded)?'负伤':'',bracing?'列阵':''].filter(Boolean).join(' · ')
  return {hp,maxHp:reg.initial*reg.modelHp,rows,abilities,status,escaped}
}

interface PanelView {root:HTMLElement;reg:Regiment;title:HTMLElement;status:HTMLElement;count:HTMLElement;health:HTMLElement;healthFill:HTMLElement;rows:Map<string,{value:HTMLElement;fill:HTMLElement;row:HTMLElement}>;abilities:Map<string,HTMLElement>}
let view:PanelView|null=null
function element(tag:string,className:string,parent:HTMLElement,text?:string):HTMLElement {
  const node=document.createElement(tag);node.className=className;if(text!==undefined) node.textContent=text;parent.append(node);return node
}
function setText(node:HTMLElement,value:string) {if(node.textContent!==value) node.textContent=value}
function fill(node:HTMLElement,value:number,max:number) {
  const width=`${Math.max(0,Math.min(1,max>0?value/max:0))*100}%`
  if(node.style.width!==width) node.style.width=width
}
export function paintUnitPanel(root:HTMLElement,reg:Regiment,bracing:boolean):void {
  const data=unitPanelData(reg,bracing)
  if(!view||view.root!==root||view.reg!==reg||!root.contains(view.title)) {
    root.replaceChildren();root.dataset.mode='one'
    const title=element('h2','unit-title',root)
    element('p','muted',root,`${unitDef(reg.type).role} · ${unitDef(reg.type).cost} 预算点`)
    const status=element('p','unit-status',root)
    const healthTrack=element('div','health-track',root)
    const healthFill=element('i','',healthTrack),health=element('span','',healthTrack)
    const count=element('p','unit-count',root)
    const list=element('div','stat-list',root),rows:PanelView['rows']=new Map()
    for(const item of data.rows) {
      const row=element('div','stat-row',list);row.dataset.stat=item.key
      element('span','stat-label',row,item.label)
      const value=element('span','stat-value',row),track=element('div','track',row),fill=element('i','',track)
      rows.set(item.key,{value,fill,row})
    }
    element('div','section-label',root,'能力')
    const chips=element('div','abilities',root),abilities=new Map<string,HTMLElement>()
    for(const item of data.abilities) abilities.set(item.key,element('span','ability',chips))
    if(!abilities.size) element('span','muted',chips,'—')
    view={root,reg,title,status,count,health,healthFill,rows,abilities}
  }
  setText(view.title,reg.name);setText(view.status,data.status);setText(view.count,`${unitDef(reg.type).name} · ${reg.aliveCount} / ${reg.initial}${data.escaped?` · 逃离 ${data.escaped}`:''}`)
  setText(view.health,`${Math.ceil(data.hp)} / ${data.maxHp}`);fill(view.healthFill,data.hp,data.maxHp)
  for(const item of data.rows) {
    const row=view.rows.get(item.key)!;setText(row.value,item.display??`${Math.round(item.value)}`);fill(row.fill,item.value,item.max)
    row.row.title=item.hint??`${item.label} ${Math.round(item.value)}`
  }
  for(const item of data.abilities) {const chip=view.abilities.get(item.key)!;setText(chip,item.label);chip.title=item.hint}
}
