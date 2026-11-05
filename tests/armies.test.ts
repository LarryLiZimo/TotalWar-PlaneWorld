import {describe,it,expect} from 'vitest'
import {ARMIES,ARMY_SCALES,createArmyBattle,unitModels,scaledFormation} from '../src/sim/armies'
import {UNITS} from '../src/sim/units'
import {formationCorners,compactRanks,slotOf} from '../src/sim/formation'
import {battleErrors,battleSnapshot} from '../src/sim/diagnostics'
import {step,setAiEnabled,createEmptyBattle,spawn} from '../src/sim/battle'
import {unitPanelData} from '../src/unit-panel'

describe('army presets and model scale',()=> {
  it('keeps the exact classic army and fifteen regiments in all four presets',()=> {
    expect(ARMIES.classic.units).toEqual([['sword',6],['spear',3],['greatsword',2],['archer',3],['musket',1]])
    for(const preset of Object.values(ARMIES)) expect(preset.units.reduce((n,[,c])=>n+c,0)).toBe(15)
    expect(ARMIES.monsters.units.find(([t])=>t==='spear')?.[1]).toBe(4)
  })
  it.each(ARMY_SCALES)('uses the requested standard sizes at scale %s',scale=> {
    for(const [type,n] of [['sword',120],['spear',120],['greatsword',120],['heavyCavalry',60],['horseArcher',60],['archer',68],['musket',68],['ogre',12],['chariot',4]] as const) expect(unitModels(type,scale)).toBe(n*scale/4)
    for(const type of ['monster','behemoth','general','inquisitor'] as const) expect(unitModels(type,scale)).toBe(1)
    for(const type of Object.keys(UNITS) as (keyof typeof UNITS)[]) {
      const f=scaledFormation(type,scale),d=UNITS[type]
      expect(f.models).toBeGreaterThan(0);expect(Number.isInteger(f.models)).toBe(true)
      expect(f.files).toBeLessThanOrEqual(d.maxFiles);expect(Math.ceil(f.models/f.files)).toBeLessThanOrEqual(d.maxRanks)
    }
  })
  it.each(ARMY_SCALES)('places both independently chosen armies legally without overlapping formations at %sx',scale=> {
    for(const player of Object.keys(ARMIES) as (keyof typeof ARMIES)[]) {
      const b=createArmyBattle({player,enemy:'nomad',scale},42)
      expect(b.regiments.filter(r=>r.side===0)).toHaveLength(15);expect(b.regiments.filter(r=>r.side===1)).toHaveLength(15)
      expect(battleErrors(b)).toEqual([])
      const boxes=b.regiments.map(r=> {
        const corners=formationCorners(r,UNITS[r.type])
        return {side:r.side,minX:Math.min(...corners.map(p=>p.x)),maxX:Math.max(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxY:Math.max(...corners.map(p=>p.y))}
      })
      for(const box of boxes) {expect(box.minX).toBeGreaterThan(0);expect(box.maxX).toBeLessThan(300);expect(box.minY).toBeGreaterThan(0);expect(box.maxY).toBeLessThan(230)}
      for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) if(boxes[i].side===boxes[j].side) {
        const a=boxes[i],c=boxes[j]
        expect(a.maxX<=c.minX||c.maxX<=a.minX||a.maxY<=c.minY||c.maxY<=a.minY).toBe(true)
      }
    }
  })
  it('replays independent army selections exactly',()=> {
    const run=()=>{const b=createArmyBattle({player:'advance',enemy:'monsters',scale:1},42);setAiEnabled(b,true);for(let i=0;i<40;i++)step(b,.05);expect(battleErrors(b)).toEqual([]);return battleSnapshot(b)}
    expect(run()).toEqual(run())
  })
  it.each(ARMY_SCALES)('scales single-entity health, wound thresholds and morale fractions at %sx',scale=> {
    const b=createArmyBattle({player:'monsters',enemy:'classic',scale},42)
    const single=b.regiments.find(r=>r.type==='monster')!,s=single.soldiers[0],max=UNITS.monster.hp*scale/4
    expect(single.modelHp).toBe(max);expect(s.hp).toBe(max);expect(unitPanelData(single).maxHp).toBe(max)
    step(b,.05);expect(s.wounded).toBe(false);expect(single.moraleFactors.casualties).toBeCloseTo(0)
    s.hp=max*.5;step(b,.05);expect(s.wounded).toBe(false);expect(single.moraleFactors.casualties).toBeCloseTo(-25)
    s.hp=max*.25;step(b,.05);expect(s.wounded).toBe(true)
    expect(battleErrors(b)).toEqual([])
    expect(b.regiments.find(r=>r.type==='spear')!.modelHp).toBe(UNITS.spear.hp)
  })
  it('repairs a missing central file in a 240-model formation without teleporting or leaving holes',()=> {
    const b=createEmptyBattle(97),r=spawn(b,0,'sword','large',140,140,Math.PI/2,scaledFormation('sword',8))
    spawn(b,1,'general','far',280,210,0)
    for(const s of r.soldiers) if(s.file===20) {s.alive=false;s.hp=0;r.aliveCount--}
    const positions=r.soldiers.filter(s=>s.alive).map(s=>[s.id,s.x,s.y])
    compactRanks(r)
    expect(Array.from({length:6},(_,rank)=>r.soldiers.filter(s=>s.alive&&s.rank===rank).length)).toEqual([40,40,40,40,40,34])
    for(const [id,x,y] of positions) expect([b.soldierById.get(id)!.x,b.soldierById.get(id)!.y]).toEqual([x,y])
    for(let i=0;i<320;i++)step(b,.05)
    expect(r.soldiers.filter(s=>s.alive&&Math.hypot(s.x-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).x,s.y-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).y)<.2).length).toBeGreaterThanOrEqual(232)
    expect(battleErrors(b)).toEqual([])
  })
})
