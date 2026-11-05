import { describe,expect,it } from 'vitest'
import { createEmptyBattle,spawn } from '../src/sim/battle'
import { unitPanelData } from '../src/unit-panel'
import { UNITS } from '../src/sim/units'

describe('unit detail attributes',()=> {
  it('shows effective wounded and fatigued attributes with actual remaining health',()=> {
    const r=spawn(createEmptyBattle(1),0,'inquisitor','hero',100,100,0)
    r.soldiers[0].hp=100;r.soldiers[0].wounded=true;r.fatigue='exhausted'
    const data=unitPanelData(r),def=UNITS.inquisitor
    expect(data.hp).toBe(100)
    expect(data.rows.find(s=>s.key==='weapon')!.value).toBeCloseTo((def.weaponBase+def.weaponAp*.9)*def.wounds!.damage)
    expect(data.rows.find(s=>s.key==='speed')!.value).toBeCloseTo(def.speed*.85*def.wounds!.speed)
    expect(data.rows.find(s=>s.key==='attack')!.value).toBeCloseTo(def.meleeAttack*.7)
  })
  it('keeps anti-large, brace and reflection abilities together',()=> {
    const r=spawn(createEmptyBattle(2),0,'spear','spears',100,100,0)
    const keys=unitPanelData(r).abilities.map(a=>a.key)
    expect(keys).toContain('large');expect(keys).toContain('brace');expect(keys).toContain('reflection')
  })
  it('shows ammunition only for living shooters and includes ranged attributes',()=> {
    const r=spawn(createEmptyBattle(3),0,'archer','archers',100,100,0)
    r.soldiers[0].alive=false;r.aliveCount--
    r.soldiers[1].ammo=0
    const data=unitPanelData(r)
    expect(data.rows.find(s=>s.key==='ammo')!.value).toBe((r.initial-2)*UNITS.archer.missile!.ammo)
    expect(data.rows.find(s=>s.key==='range')!.value).toBe(UNITS.archer.missile!.range)
    expect(data.rows.every(s=>Number.isFinite(s.value)&&s.max>0)).toBe(true)
  })
  it('shows terror cooldown on the source alongside its separate fear ability',()=> {
    const b=createEmptyBattle(4),source=spawn(b,0,'monster','monster',100,100,0),victim=spawn(b,1,'sword','victim',110,100,0)
    source.terrorCooldown=12.1
    expect(unitPanelData(source).abilities.find(a=>a.key==='terror')!.label).toBe('惊骇 13s')
    expect(unitPanelData(source).abilities.some(a=>a.key==='fear')).toBe(true)
    expect(unitPanelData(victim).abilities.some(a=>a.key==='terror')).toBe(false)
  })
})
