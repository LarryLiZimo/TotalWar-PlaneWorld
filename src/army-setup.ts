import { ARMIES,ARMY_SCALES,armySummary,unitModels,scaledFormation,type ArmyId,type ArmyScale,type ArmySetup } from './sim/armies'
import { unitDef } from './sim/units'

export function setupArmyPicker(initial:ArmySetup,onStart:(setup:ArmySetup)=>void,onCancel:()=>void) {
  const dialog=document.querySelector<HTMLDialogElement>('#setup-dialog')!
  const player=document.querySelector<HTMLSelectElement>('#player-army')!,enemy=document.querySelector<HTMLSelectElement>('#enemy-army')!,scale=document.querySelector<HTMLSelectElement>('#army-scale')!
  for(const [id,army] of Object.entries(ARMIES)) {player.add(new Option(army.name,id));enemy.add(new Option(army.name,id))}
  for(const value of ARMY_SCALES) scale.add(new Option(`${value}×${value===4?' · 标准':''}`,String(value)))
  const selected=():ArmySetup=>({player:player.value as ArmyId,enemy:enemy.value as ArmyId,scale:Number(scale.value) as ArmyScale})
  function preview() {
    const chosen=selected()
    document.querySelector('#scale-summary')!.textContent=`常规每队：步兵 ${unitModels('sword',chosen.scale)} · 骑兵/骑射 ${unitModels('heavyCavalry',chosen.scale)} · 射手 ${unitModels('archer',chosen.scale)} · 怪步 ${unitModels('ogre',chosen.scale)} · 战车 ${unitModels('chariot',chosen.scale)}；精锐：铁甲火枪 ${unitModels('ironsides',chosen.scale)} · 长管步枪/半狮鹫 ${unitModels('longRifle',chosen.scale)}；单体生命 ×${chosen.scale/4}`
    for(const [selector,id,side] of [['#player-preview',chosen.player,'玩家'],['#enemy-preview',chosen.enemy,'AI']] as const) {
      const root=document.querySelector(selector)!,summary=armySummary(id,chosen.scale)
      root.replaceChildren()
      const title=document.createElement('h2');title.textContent=`${side} · ${ARMIES[id].name}`
      const count=document.createElement('p');count.className='muted';count.textContent=`${summary.regiments} 队 · ${summary.models} 个模型 · ${summary.budget.toLocaleString()} 预算点`
      const list=document.createElement('ul')
      for(const [type,n] of ARMIES[id].units) {
        const row=document.createElement('li'),name=document.createElement('span'),models=document.createElement('span')
        const def=unitDef(type)
        name.textContent=`${n} × ${def.name}`;row.title=`${def.role}；每队 ${def.cost} 预算点`
        models.textContent=def.models===1?`${scaledFormation(type,chosen.scale).hp.toLocaleString()} 生命`:`${unitModels(type,chosen.scale)} / 队`;row.append(name,models);list.append(row)
      }
      root.append(title,count,list)
    }
  }
  for(const select of [player,enemy,scale]) select.addEventListener('change',preview)
  document.querySelector('#setup-form')!.addEventListener('submit',event=>{event.preventDefault();dialog.close();onStart(selected())})
  document.querySelector('#setup-cancel')!.addEventListener('click',()=>{dialog.close();onCancel()})
  dialog.addEventListener('cancel',()=>onCancel())
  return {dialog,open(setup=initial) {player.value=setup.player;enemy.value=setup.enemy;scale.value=String(setup.scale);preview();dialog.showModal()}}
}
