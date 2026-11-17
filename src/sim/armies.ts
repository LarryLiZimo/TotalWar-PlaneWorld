import { createEmptyBattle,spawn } from './battle'
import { fileCount, formationLimits } from './formation'
import type { Battle,Side,UnitType } from './types'
import { designModels, unitDef } from './units'

export const ARMY_SCALES=[1,2,3,4,6,8] as const
export type ArmyScale=typeof ARMY_SCALES[number]
export const ARMIES={
  classic:{name:'经典步射',units:[['sword',6],['spear',3],['greatsword',2],['archer',3],['musket',1]]},
  advance:{name:'重装推进',units:[['sword',4],['spear',3],['greatsword',2],['ogre',2],['armoredOgre',2],['heavyCavalry',1],['shieldCavalry',1]]},
  nomad:{name:'游牧机动',units:[['sword',2],['spear',3],['horseArcher',4],['lightCavalry',4],['chariot',2]]},
  monsters:{name:'巨兽与英雄',units:[['spear',4],['monster',4],['behemoth',4],['inquisitor',2],['general',1]]},
  stateTroops:{name:'行省征召',units:[['militia',3],['shieldSpear',4],['sword',2],['crossbow',3],['freeCompany',2],['captain',1]]},
  blackpowder:{name:'黑火药战线',units:[['shieldSpear',3],['halberd',2],['ironsides',3],['longRifle',2],['musket',2],['outrider',2],['general',1]]},
  knightly:{name:'骑士突击',units:[['sword',2],['shieldSpear',2],['reiksguard',3],['blackRose',2],['demigryph',2],['demigryphHalberd',2],['pistolier',1],['general',1]]},
  fanatics:{name:'信仰远征',units:[['flagellant',6],['greatsword',2],['huntsmen',3],['warriorPriest',2],['lightCavalry',1],['captain',1]]},
  warTrain:{name:'机动战车',units:[['shieldSpear',3],['freeCompany',3],['warWagon',3],['heavyChariot',2],['pistolier',2],['outrider',1],['general',1]]},
  monstrousGuard:{name:'巨兽卫队',units:[['shieldSpear',3],['ogreGreatWeapon',3],['ogreHalberd',3],['giant',2],['stoneBeast',2],['huntsmen',1],['warriorPriest',1]]},
} as const satisfies Record<string,{name:string;units:readonly (readonly [UnitType,number])[]}>
export type ArmyId=keyof typeof ARMIES
export interface ArmySetup {player:ArmyId;enemy:ArmyId;scale:ArmyScale}
export const DEFAULT_SETUP:ArmySetup={player:'classic',enemy:'advance',scale:4}

export function unitModels(type:UnitType,scale:ArmyScale=4):number {
  const d=unitDef(type)
  return d.category==='monster'||d.models===1?1:designModels(d)*scale/4
}
export function scaledFormation(type:UnitType,scale:ArmyScale):{models:number;files:number;hp:number} {
  const d=unitDef(type),models=unitModels(type,scale)
  // Deployment depth for the 4x size; larger regiments deepen by the same √ factor as their formation limits,
  // so an 8x army deploys in the proportions of a 4x one.
  const ranks=Math.round((d.category==='infantry'?6:d.category==='ranged'||d.category==='cavalry'?4:d.category==='monstrousInfantry'?2:1)*Math.sqrt(Math.max(1,models/designModels(d))))
  return {models,files:fileCount(formationLimits(d,models),Math.ceil(models/ranks),models),hp:d.hp*(d.models===1?scale/4:1)}
}
export function armySummary(id:ArmyId,scale:ArmyScale) {
  return {regiments:ARMIES[id].units.reduce((n,[,count])=>n+count,0),models:ARMIES[id].units.reduce((n,[type,count])=>n+unitModels(type,scale)*count,0),budget:ARMIES[id].units.reduce((n,[type,count])=>n+unitDef(type).cost*count,0)}
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
