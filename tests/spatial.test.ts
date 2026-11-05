import {describe,expect,it} from 'vitest'
import {Spatial} from '../src/sim/spatial'
import {bodyContact} from '../src/sim/physics'
import {unitDef} from '../src/sim/units'
import type {Soldier,UnitDef} from '../src/sim/types'

describe('spatial queries by army',()=> {
  it('preserves the unrestricted candidate order while filtering either army and deduplicating capsule points',()=> {
    const grid=new Spatial(2,2),sides=new Map<number,0|1>()
    for(let i=0;i<32;i++) {
      const id=i===31?5000:i,side=(i%2) as 0|1
      sides.set(id,side)
      for(const dx of [-.8,0,.8]) grid.insert(10+i*.15+dx,10+(i%4)*.5,id,side)
    }
    for(const radius of [.1,1,3,10]) {
      const all:number[]=[];grid.query(12,11,radius,all)
      expect(new Set(all).size).toBe(all.length)
      for(const side of [0,1] as const) {
        const result:number[]=[];grid.query(12,11,radius,result,side)
        expect(result).toEqual(all.filter(id=>sides.get(id)===side))
      }
    }
  })
  it('clears both army indexes along with the shared grid',()=> {
    const grid=new Spatial(),result:number[]=[]
    grid.insert(10,10,1,0);grid.insert(10,10,2,1);grid.clear();grid.insert(10,10,3,1)
    grid.query(10,10,1,result,0);expect(result).toEqual([])
    grid.query(10,10,1,result,1);expect(result).toEqual([3])
    grid.query(10,10,1,result);expect(result).toEqual([3])
  })
})

describe('circle collision fast path',()=> {
  it.each([0,1e-9,1e-6,.4,2])('agrees with the same geometry represented as zero-axis capsules at separation %s',distance=> {
    const circle=unitDef('sword'),capsule:UnitDef={...circle,shape:'capsule',length:circle.radius*2}
    const a={id:1,x:10,y:10,facing:.7} as Soldier,b={id:2,x:10+distance,y:10+distance/2,facing:2.1} as Soldier
    expect(bodyContact(a,circle,b,circle)).toEqual(bodyContact(a,capsule,b,capsule))
  })
})
