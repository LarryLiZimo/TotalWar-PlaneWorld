import { createEmptyBattle,spawn } from './battle'
import { fileCount } from './formation'
import type { Battle,Side,UnitType } from './types'
import { unitDef } from './units'

export const ARMY_SCALES=[1,2,3,4,6,8] as const
export type ArmyScale=typeof ARMY_SCALES[number]
export const ARMIES={
  classic:{name:'经典步射',units:[['sword',6],['spear',3],['greatsword',2],['archer',3],['musket',1]]},
  advance:{name:'重装推进',units:[['sword',4],['spear',3],['greatsword',2],['ogre',2],['armoredOgre',2],['heavyCavalry',1],['shieldCavalry',1]]},
  nomad:{name:'游牧机动',units:[['sword',2],['spear',3],['horseArcher',4],['lightCavalry',4],['chariot',2]]},
  monsters:{name:'巨兽与英雄',units:[['spear',4],['monster',4],['behemoth',4],['inquisitor',2],['general',1]]},
} as const satisfies Record<string,{name:string;units:readonly (readonly [UnitType,number])[]}>
export type ArmyId=keyof typeof ARMIES
export interface ArmySetup {player:ArmyId;enemy:ArmyId;scale:ArmyScale}
export const DEFAULT_SETUP:ArmySetup={player:'classic',enemy:'advance',scale:4}

export function unitModels(type:UnitType,scale:ArmyScale=4):number {
  const d=unitDef(type)
  const standard=d.category==='monster'||d.models===1?0:d.category==='chariot'?4:d.category==='monstrousInfantry'?12:d.category==='cavalry'?60:d.category==='ranged'?68:120
  return standard?standard*scale/4:1
}
export function scaledFormation(type:UnitType,scale:ArmyScale):{models:number;files:number;hp:number} {
  const d=unitDef(type),models=unitModels(type,scale)
  const ranks=d.category==='infantry'?6:d.category==='ranged'||d.category==='cavalry'?4:d.category==='monstrousInfantry'?2:1
  return {models,files:fileCount(d,Math.ceil(models/ranks),models),hp:d.hp*(d.models===1?scale/4:1)}
}
export function armySummary(id:ArmyId,scale:ArmyScale) {
  return {regiments:ARMIES[id].units.reduce((n,[,count])=>n+count,0),models:ARMIES[id].units.reduce((n,[type,count])=>n+unitModels(type,scale)*count,0)}
}
export function createArmyBattle(setup:ArmySetup=DEFAULT_SETUP,seed=20261104):Battle {
  const battle=createEmptyBattle(seed)
  function deploy(side:Side,id:ArmyId) {
    const entries=ARMIES[id].units.flatMap(([type,count])=>Array.from({length:count},()=>type as UnitType))
    const categoryOrder={infantry:0,monstrousInfantry:1,monster:1,ranged:2,cavalry:3,chariot:3}
    entries.sort((a,b)=>categoryOrder[unitDef(a).category]-categoryOrder[unitDef(b).category])
    // Five lanes and three ranks accommodate all 15-regiment presets, including
    // 8x widths, without overlapping neighbouring formations or map edges.
    entries.forEach((type,i)=> {
      const x=50+(i%5)*50,depth=Math.floor(i/5)*18,y=side?144+depth:86-depth
      spawn(battle,side,type,`${side?'北军':'南军'}${unitDef(type).name}${entries.slice(0,i).filter(t=>t===type).length+1}`,x,y,side?-Math.PI/2:Math.PI/2,scaledFormation(type,setup.scale))
    })
  }
  deploy(0,setup.player);deploy(1,setup.enemy)
  battle.aiEnabled=true
  return battle
}
