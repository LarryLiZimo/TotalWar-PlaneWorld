import { createBattle, createEmptyBattle, spawn } from './battle'
import { commandAttack, commandMove } from './orders'
import type { Battle, UnitType } from './types'
import { UNITS } from './units'
import { createArmyBattle } from './armies'

export const SCENARIOS = {
  custom: '预设部队对战',
  demo: '完整会战',
  line: '多队拖线',
  cavalry: '骑兵接敌与脱离',
  chariot: '战车冲阵',
  fire: '火枪射界与友军遮挡',
  flank: '侧背受击转身',
  duel: '单体与步兵',
  roster: '扩展兵种会战',
  collision: '低速碰撞攻击',
  wounds: '单体负伤对照',
  morale: '惊骇与将军阵亡',
  hill: '高低地与弹道',
  cartturn: '战车散阵转攻',
  cavturn: '骑兵近战转攻',
  reform: '减员补位',
  cartescape: '战车低速挤出',
  reserves: '散兵补入战斗',
  friendlypass: '友军穿行与柔性碰撞',
} as const
export type Scenario = keyof typeof SCENARIOS

export function createScenario(name: Scenario, seed = 20261104): Battle {
  if(name==='custom') return createArmyBattle(undefined,seed)
  if (name === 'demo') return createBattle(seed)
  const b = createEmptyBattle(seed)
  const north = Math.PI / 2, south = -north
  const add = (side: 0 | 1, type: UnitType, x: number, y: number, facing = side ? south : north) => spawn(b, side, type, `${side ? '北军' : '南军'}${UNITS[type].name}`, x, y, facing)
  if (name === 'line') {
    add(0, 'sword', 100, 70); add(0, 'heavyCavalry', 130, 60); add(0, 'archer', 170, 55); add(0, 'general', 195, 65)
    add(1, 'spear', 150, 185)
  } else if (name === 'cavalry' || name === 'chariot') {
    const attacker = add(0, name === 'cavalry' ? 'heavyCavalry' : 'chariot', 150, 70)
    const target = add(1, 'spear', 150, 120, name === 'chariot' ? north : south)
    commandAttack(b, [attacker.id], target.id)
  } else if (name === 'friendlypass') {
    add(0,'sword',125,120)
    const foot=add(0,'sword',125,100)
    add(0,'spear',175,120)
    const carts=add(0,'chariot',175,104)
    add(1,'general',280,210)
    commandMove(b,[foot.id],125,150,null)
    commandMove(b,[carts.id],175,150,null)
  } else if (name === 'reform') {
    const foot=add(0,'sword',150,140)
    for(const i of [7,8,23,24,39,40,55,56,71,72]) {
      Object.assign(foot.soldiers[i],{alive:false,hp:0,deathTime:0})
    }
    foot.aliveCount=70
    add(1,'inquisitor',150,80)
  } else if (name === 'cartescape') {
    const carts=add(0,'chariot',150,130,0)
    const positions=[[146,129],[150,129],[154,129],[158,129]]
    carts.soldiers.forEach((s,i)=>Object.assign(s,{x:positions[i][0],y:positions[i][1],prevX:positions[i][0],prevY:positions[i][1]}))
    add(1,'spear',150,130,north)
    carts.bogged=true
    commandMove(b,[carts.id],195,130,null)
  } else if (name === 'reserves') {
    const foot=add(0,'sword',150,100),target=add(1,'spear',150,125)
    foot.soldiers.forEach((s,i)=> {
      const x=i<10?165+(i%5)*0.85:144+((i-10)%14)*0.85
      const y=i<10?113-Math.floor(i/5)*0.72:123.8-Math.floor((i-10)/14)*0.72
      Object.assign(s,{x,y,prevX:x,prevY:y})
    })
    commandAttack(b,[foot.id],target.id)
  } else if (name === 'cartturn') {
    const carts=add(0,'chariot',150,145,south)
    const positions=[[135,95],[145,105],[160,90],[175,100]]
    carts.soldiers.forEach((s,i)=> {
      const [x,y]=positions[i]
      Object.assign(s,{x,y,prevX:x,prevY:y,facing:Math.atan2(70-y,150-x),prevFacing:Math.atan2(70-y,150-x)})
    })
    const next=add(1,'sword',150,70,north)
    add(1,'sword',150,160,south)
    commandAttack(b,[carts.id],next.id)
  } else if (name === 'cavturn') {
    const riders=add(0,'shieldCavalry',150,110,north)
    const current=add(1,'sword',150,113,south)
    add(1,'sword',150,60,north)
    commandAttack(b,[riders.id],current.id)
  } else if (name === 'fire') {
    add(0, 'musket', 130, 70); add(0, 'sword', 130, 90)
    add(0, 'musket', 180, 70); add(1, 'spear', 130, 120); add(1, 'spear', 180, 120)
  } else if (name === 'flank') {
    const defender = add(0, 'sword', 150, 115)
    const rear = add(1, 'sword', 150, 85, north)
    commandAttack(b, [rear.id], defender.id)
  } else if (name === 'duel') {
    const hero = add(0, 'inquisitor', 150, 85)
    const target = add(1, 'sword', 150, 120)
    commandAttack(b, [hero.id], target.id)
  } else if (name === 'collision') {
    const cart=add(0,'chariot',150,112,north)
    const target=add(1,'sword',150,115,south)
    cart.bogged=true
    commandAttack(b,[cart.id],target.id)
  } else if (name === 'wounds') {
    const healthy=add(0,'inquisitor',110,85), wounded=add(0,'inquisitor',180,85)
    wounded.soldiers[0].hp*=0.2
    const left=add(1,'sword',110,120), right=add(1,'sword',180,120)
    commandAttack(b,[healthy.id],left.id); commandAttack(b,[wounded.id],right.id)
  } else if (name === 'morale') {
    const commander=add(0,'general',140,70)
    commander.soldiers[0].alive=false; commander.soldiers[0].hp=0; commander.soldiers[0].deathTime=0; commander.aliveCount=0
    const front=add(0,'sword',150,110)
    front.soldiers.forEach(s=>{s.hp*=0.1})
    add(0,'sword',60,50)
    const giant=add(1,'monster',150,122)
    commandAttack(b,[giant.id],front.id)
  } else if (name === 'hill') {
    b.terrain={kind:'slope',rise:60,axis:'y'}
    add(0,'archer',115,90); add(1,'archer',115,150)
    const foot=add(0,'sword',180,80), enemy=add(1,'sword',180,160)
    commandAttack(b,[foot.id],enemy.id)
  } else {
    const types: UnitType[] = ['halberd', 'shieldCavalry', 'crossbow', 'horseArcher', 'ogre', 'armoredOgre', 'monster', 'behemoth']
    types.forEach((type, i) => {
      const x = 42 + (i % 4) * 65, y = 65 - Math.floor(i / 4) * 24
      add(0, type, x, y)
      add(1, type, x, 170 + Math.floor(i / 4) * 24)
    })
  }
  return b
}
