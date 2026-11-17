import { describe, expect, it } from 'vitest'
import { createEmptyBattle, spawn, step } from '../src/sim/battle'
import { scaledFormation } from '../src/sim/armies'
import { battleErrors } from '../src/sim/diagnostics'
import { compactRanks, gapBetween, slotOf } from '../src/sim/formation'
import { angDiff } from '../src/sim/math'
import { commandAttack, commandMove } from '../src/sim/orders'
import type { Battle, Regiment, UnitType } from '../src/sim/types'
import { UNITS } from '../src/sim/units'
import { createScenario } from '../src/sim/scenarios'

function tick(b:Battle,seconds:number) {for(let i=0;i<Math.round(seconds/0.05);i++) step(b,0.05)}
function one(b:Battle,side:0|1,type:UnitType,x:number,y:number,facing=0):Regiment {
  const r=spawn(b,side,type,type,x,y,facing)
  for(const s of r.soldiers.slice(1)) b.soldierById.delete(s.id)
  r.soldiers=r.soldiers.slice(0,1);r.initial=r.aliveCount=r.files=r.destFiles=1
  Object.assign(r.soldiers[0],{x,y,prevX:x,prevY:y,meleeCd:100})
  return r
}
function enemyFar(b:Battle) {return one(b,1,'sword',260,200)}

describe('casualty formation repair',()=> {
  it('fills complete front ranks after a whole central file is lost, without teleporting bodies',()=> {
    const b=createEmptyBattle(71),r=spawn(b,0,'sword','ranks',140,140,Math.PI/2)
    enemyFar(b)
    for(const i of [7,8,23,24,39,40,55,56,71,72]) {r.soldiers[i].alive=false;r.soldiers[i].hp=0}
    r.aliveCount=70
    const before=r.soldiers.filter(s=>s.alive).map(s=>[s.id,s.x,s.y])
    compactRanks(r)
    const rows=Array.from({length:5},(_,rank)=>r.soldiers.filter(s=>s.alive&&s.rank===rank))
    expect(rows.map(row=>row.length)).toEqual([16,16,16,16,6])
    expect(rows[4].map(s=>s.centerIndex).sort((a,c)=>a-c)).toEqual([0,1,2,3,4,5])
    for(const [id,x,y] of before) {const s=b.soldierById.get(id)!;expect([s.x,s.y]).toEqual([x,y])}
    tick(b,16)
    const settled=r.soldiers.filter(s=>s.alive&&Math.hypot(s.x-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).x,s.y-slotOf(r,UNITS.sword,s.file,s.rank,s.centerIndex).y)<0.2)
    expect(settled.length).toBeGreaterThanOrEqual(68)
    expect(battleErrors(b)).toEqual([])
  })
})

describe('rolling chariot manoeuvres and extraction',()=> {
  it.each([[98,100],[100,106],[104,96]])('rolls into a nearby destination (%s,%s) instead of pivoting or orbiting forever',(goalX,goalY)=> {
    const b=createEmptyBattle(72),r=one(b,0,'chariot',100,100,0)
    enemyFar(b);commandMove(b,[r.id],goalX,goalY,null)
    let travel=0,rollingTurn=0,previous={x:100,y:100,facing:0}
    for(let i=0;i<80;i++) {
      step(b,0.05);const s=r.soldiers[0]
      const moved=Math.hypot(s.x-previous.x,s.y-previous.y)
      const turned=Math.abs(angDiff(previous.facing,s.facing))
      travel+=moved;if(moved>0.01) rollingTurn+=turned
      previous={x:s.x,y:s.y,facing:s.facing}
    }
    expect(travel).toBeGreaterThan(Math.min(5,Math.hypot(goalX-100,goalY-100)*1.5))
    expect(rollingTurn).toBeGreaterThan(Math.min(0.9,Math.abs(Math.atan2(goalY-100,goalX-100))*0.6))
    tick(b,20)
    expect(Math.hypot(r.soldiers[0].x-goalX,r.soldiers[0].y-goalY)).toBeLessThan(1.2)
  })

  it.each(['chariot','heavyChariot','warWagon'] as const)('extracts a slow %s through a few ordinary infantry without needing ram speed',type=> {
    const b=createEmptyBattle(73),cart=one(b,0,type,100,100,0)
    const feet=[[102.2,99.1],[102.2,100],[102.2,100.9],[103,99.55],[103,100.45]].map(([x,y])=>one(b,1,'sword',x,y,0))
    cart.fireAtWill=false
    // Bogged as the simulation leaves it: two seconds held among the enemy.
    cart.bogged=true;cart.bogTime=2;commandMove(b,[cart.id],125,100,null)
    let fastestInContact=0
    for(let i=0;i<160;i++) {step(b,0.05);if(cart.inContact) fastestInContact=Math.max(fastestInContact,cart.soldiers[0].speed)}
    expect(cart.soldiers[0].x).toBeGreaterThan(108)
    expect(feet.every(r=>r.soldiers[0].hp===UNITS.sword.hp&&r.soldiers[0].down===0)).toBe(true)
    expect(fastestInContact).toBeLessThan(5)
    expect(battleErrors(b)).toEqual([])
  })

  it('finite traction cannot slowly bulldoze an entire braced spear front',()=> {
    const b=createEmptyBattle(77),cart=one(b,0,'chariot',100,100,0)
    const line=spawn(b,1,'spear','braced',102.2,100,Math.PI)
    for(const s of line.soldiers) {s.braceTime=2;s.meleeCd=100;s.facing=Math.atan2(100-s.y,100-s.x);s.prevFacing=s.facing}
    commandMove(b,[cart.id],125,100,null);tick(b,8)
    expect(cart.soldiers[0].x).toBeLessThan(102)
    expect(line.aliveCount).toBe(80)
    expect(battleErrors(b)).toEqual([])
  })

  it('the complete four-cart extraction escapes a fighting infantry regiment before routing',()=> {
    const b=createScenario('cartescape',42),carts=b.regiments.find(r=>r.type==='chariot')!
    tick(b,12)
    expect(carts.aliveCount).toBe(4)
    expect(carts.routing).toBe(false)
    expect(carts.soldiers.filter(s=>s.x>160).length).toBe(4)
    expect(battleErrors(b)).toEqual([])
  })
})

describe('ground resistance',()=> {
  it('a stationary foot unit resists a friendly walker instead of sliding along with it',()=> {
    const b=createEmptyBattle(74),walker=one(b,0,'sword',100,100,0),standing=one(b,0,'sword',101,100,Math.PI/2)
    enemyFar(b);commandMove(b,[walker.id],110,100,null);tick(b,4)
    expect(Math.hypot(standing.soldiers[0].x-101,standing.soldiers[0].y-100)).toBeLessThan(0.15)
  })

  it('an external push moves a body briefly and friction brings it to rest',()=> {
    const b=createEmptyBattle(75),r=one(b,0,'sword',100,100,0)
    enemyFar(b)
    Object.assign(r.soldiers[0],{pushVx:2,pushVy:0})
    step(b,0.05)
    expect(r.soldiers[0].x).toBeGreaterThan(100)
    tick(b,0.6)
    expect(r.soldiers[0].pushVx).toBe(0);expect(r.soldiers[0].pushVy).toBe(0)
    expect(r.soldiers[0].x).toBeLessThan(100.45)
  })
})

describe('joining a fight: every man goes to his place in the ranks',()=> {
  it('a small detached group rejoins the fight instead of waiting for its old slots',()=> {
    const b=createEmptyBattle(78),r=spawn(b,0,'sword','reserve',150,100,Math.PI/2)
    const target=spawn(b,1,'spear','target',150,125,-Math.PI/2)
    for(const reg of [r,target]) for(const s of reg.soldiers) s.meleeCd=100
    r.soldiers.slice(10).forEach((s,i)=>{s.x=144+(i%14)*0.85;s.y=123.8-Math.floor(i/14)*0.72;s.prevX=s.x;s.prevY=s.y})
    r.soldiers.slice(0,10).forEach((s,i)=>{s.x=165+(i%5)*0.85;s.y=113-Math.floor(i/5)*0.72;s.prevX=s.x;s.prevY=s.y})
    commandAttack(b,[r.id],target.id);tick(b,12)
    expect(r.soldiers.slice(0,10).filter(s=>s.y>120).length).toBeGreaterThanOrEqual(8)
    expect(battleErrors(b)).toEqual([])
  })

  // The men behind used to walk round the ends of the allied block to reach the enemy one by one.
  it('rear attackers walk through a stationary allied block to their places behind their engaged comrades; nobody goes round it',()=> {
    const b=createEmptyBattle(76)
    const attackers=spawn(b,0,'sword','attackers',150,90,Math.PI/2)
    const wall=spawn(b,0,'sword','wall',150,110,Math.PI/2)
    const target=spawn(b,1,'spear','target',150,125,-Math.PI/2)
    for(const r of [attackers,wall,target]) for(const s of r.soldiers) s.meleeCd=100
    for(const [i,s] of attackers.soldiers.entries()) {
      if(i<6) Object.assign(s,{x:145+i*0.85,y:123.9,prevX:145+i*0.85,prevY:123.9})
    }
    commandAttack(b,[attackers.id],target.id)
    const half=(attackers.files-1)*UNITS.sword.spacing/2
    let widest=0
    for(let i=0;i<640;i++) {step(b,0.05);widest=Math.max(widest,...attackers.soldiers.filter(s=>s.alive).map(s=>Math.abs(s.x-150)))}
    const rear=attackers.soldiers.slice(6).filter(s=>s.alive)
    expect(rear.filter(s=>s.y>116).length).toBeGreaterThan(rear.length*0.65)
    // They came straight through the block's files: nobody strayed beyond the regiment's own width to pass its ends.
    expect(widest).toBeLessThan(half+1.5)
    const wallShift=wall.soldiers.reduce((sum,s)=>sum+Math.hypot(s.x-slotOf(wall,UNITS.sword,s.file,s.rank,s.centerIndex).x,s.y-slotOf(wall,UNITS.sword,s.file,s.rank,s.centerIndex).y),0)/wall.aliveCount
    expect(wallShift).toBeLessThan(1)
    expect(battleErrors(b)).toEqual([])
  },15000)

  // Monstrous infantry used to circle a block that friendly infantry was already fighting: shoved just out of reach
  // between blows, they counted as blocked and set off round the friendly block, which had wrapped the enemy. Now
  // their line goes straight for the enemy, through the friendly foot, and its front rank fights among them.
  const approaches=[['from behind the friendly block',150,80,Math.PI/2],['from the open flank',115,106,0]] as const
  it.each((['ogre','armoredOgre','ogreGreatWeapon','ogreHalberd'] as UnitType[]).flatMap(type=>approaches.map(([way,x,y,f])=>[type,way,x,y,f] as const)))
  ('%s ordered onto a block friendly infantry already fights reach it %s, in their ranks and without circling',(type,_way,x,y,facing)=> {
    const b=createEmptyBattle(5)
    const friend=spawn(b,0,'sword','friend',150,100,Math.PI/2),enemy=spawn(b,1,'sword','enemy',150,112,-Math.PI/2)
    commandAttack(b,[friend.id],enemy.id);commandAttack(b,[enemy.id],friend.id)
    tick(b,6)
    expect(friend.inContact).toBe(true)
    const ogres=spawn(b,0,type,'ogres',x,y,facing),start=b.time
    commandAttack(b,[ogres.id],enemy.id)
    const path=new Map<number,number>(),turn=new Map<number,number>()
    let firstHit=Infinity
    for(let i=0;i<600;i++) {
      const before=ogres.soldiers.map(s=>({x:s.x,y:s.y,f:s.facing}))
      step(b,0.05)
      ogres.soldiers.forEach((s,k)=>{
        if(!s.alive) return
        path.set(s.id,(path.get(s.id)??0)+Math.hypot(s.x-before[k].x,s.y-before[k].y))
        turn.set(s.id,(turn.get(s.id)??0)+s.facing-before[k].f)
      })
      if(firstHit===Infinity&&ogres.dealt.length) firstHit=b.time-start
    }
    const def=UNITS[type],standing=ogres.soldiers.filter(s=>s.alive)
    const atFight=standing.filter(s=>enemy.soldiers.some(e=>e.alive&&gapBetween(s,def,e,UNITS.sword)<=def.reach+0.5))
    expect(firstHit).toBeLessThan(10)
    // The front rank is in the fight; the rank behind keeps its places behind it instead of working its way round to
    // the enemy. (With a long weapon it may well reach an enemy from there.)
    expect(atFight.filter(s=>s.rank===0).length).toBeGreaterThanOrEqual(4)
    const astray=standing.filter(s=>s.rank>0).map(s=>{const p=slotOf(ogres,def,s.file,s.rank,s.centerIndex);return Math.hypot(p.x-s.x,p.y-s.y)})
    expect(Math.max(0,...astray)).toBeLessThan(2.5)
    // The approach is about 26-40 m; a full circuit of the melee would add some 60 m more.
    expect(Math.max(...path.values())).toBeLessThan(60)
    expect(Math.max(...[...turn.values()].map(v=>Math.abs(v)/(2*Math.PI)))).toBeLessThan(1.5)
    expect(battleErrors(b)).toEqual([])
  },20000)
})

describe('an enemy standing in the way of an attack takes it; nobody walks round it on his own',()=> {
  const N=Math.PI/2,S=-Math.PI/2
  const near=(s:{x:number;y:number},r:Regiment,d:number)=>r.soldiers.some(o=>o.alive&&Math.hypot(o.x-s.x,o.y-s.y)<d)
  /** Demigryphs ordered onto ogres; a greatsword line stands at blockX, squarely in their path at 100, beside it at 82. */
  const field=(seed:number,blockX:number,ogreX:number)=> {
    const b=createEmptyBattle(seed)
    const riders=spawn(b,0,'demigryph','riders',100,60,N,scaledFormation('demigryph',4))
    const swords=spawn(b,1,'greatsword','swords',blockX,108,S,{...scaledFormation('greatsword',4),files:40})
    const ogres=spawn(b,1,'armoredOgre','ogres',ogreX,126,S,scaledFormation('armoredOgre',4))
    b.aiEnabled=false
    commandAttack(b,[riders.id],ogres.id)
    return {b,riders,swords,ogres}
  }

  // Under the old reserve rule every rider with no one in reach went for the ogres, so riders slipped round and through
  // the swords one by one (7 and 18 of 32 here) while the rest fought on.
  it.each([1,3])('a unit stopped by a line in front of its target fights that line until it breaks (seed %i)',seed=> {
    const {b,riders,swords,ogres}=field(seed,100,100)
    let onOgres=0
    // Only the riders' front rank reaches the line, so breaking it takes about a minute.
    for(let i=0;i<2400&&!swords.routing&&swords.aliveCount>0;i++) {
      step(b,0.05)
      onOgres=Math.max(onOgres,riders.soldiers.filter(s=>s.alive&&near(s,ogres,3)).length)
    }
    expect(swords.routing).toBe(true)
    expect(onOgres).toBe(0)
    // Then it carries out the order: the line rides on and its front rank closes with the ogres.
    tick(b,20)
    expect(riders.soldiers.filter(s=>s.alive&&near(s,ogres,3)).length).toBeGreaterThanOrEqual(riders.files)
    expect(battleErrors(b)).toEqual([])
  },60000)

  // A line that cannot break keeps the fight going long enough to tell the rules apart: under the old rule riders slipped
  // round and through it to the ogres within 20-25 s (1 and 7 here); now none do until gaps open in the line.
  it.each([1,3])('riders stopped by a line that holds stay on it rather than slipping past to their target (seed %i)',seed=> {
    const original=UNITS.greatsword
    UNITS.greatsword={...original,unbreakable:true}
    try {
      const b=createEmptyBattle(seed)
      const riders=spawn(b,0,'heavyCavalry','riders',100,60,N,scaledFormation('heavyCavalry',4))
      spawn(b,1,'greatsword','swords',100,108,S,{...scaledFormation('greatsword',4),files:40})
      const ogres=spawn(b,1,'armoredOgre','ogres',100,126,S,scaledFormation('armoredOgre',4))
      b.aiEnabled=false
      commandAttack(b,[riders.id],ogres.id)
      let onOgres=0
      for(let i=0;i<500;i++) {step(b,0.05);onOgres=Math.max(onOgres,riders.soldiers.filter(s=>s.alive&&near(s,ogres,3)).length)}
      expect(onOgres).toBe(0)
      expect(battleErrors(b)).toEqual([])
    } finally { UNITS.greatsword=original }
  },30000)

  it('files whose way is clear ride on to the target; only the files barred by the line stay and fight it',()=> {
    const {b,riders,swords,ogres}=field(1,82,108)
    tick(b,25)
    const alive=riders.soldiers.filter(s=>s.alive)
    // Two of the eight files meet the end of the line; the others carry the attack home with their front rank (the
    // file between the two enemies may have neither in reach).
    expect(alive.filter(s=>near(s,ogres,3)).length).toBeGreaterThanOrEqual(5)
    expect(alive.filter(s=>near(s,swords,2.6)).length).toBeLessThanOrEqual(9)
    expect(riders.meleeFoes).toContain(ogres.id)
    expect(battleErrors(b)).toEqual([])
  },20000)
})

describe('horses turn about tightly',()=> {
  const N=Math.PI/2,S=-Math.PI/2
  // A horse at full charge reversed onto a foe behind it: it used to need 2.3 s and a loop some 7 m wide (light horse 10 m);
  // now about 1.2 s and 4 m (light horse 5.8 m). What is left is mostly braking from full speed before the turn tightens.
  it.each([['heavyCavalry',4.4,1.3],['lightCavalry',6.3,1.3]] as const)('%s at charge speed turns about within %d m and %d s',(type,width,seconds)=> {
    const b=createEmptyBattle(1),rider=one(b,0,type,100,60,N)
    commandAttack(b,[rider.id],one(b,1,'sword',100,225,S).id)
    // It runs up at its running pace and breaks into the charge within charging distance of the target.
    const s=rider.soldiers[0]
    for(let i=0;i<800&&s.speed<UNITS[type].chargeSpeed-0.02;i++) step(b,0.05)
    // A stride more to settle: catching up with its place it runs a little over the pace.
    tick(b,1)
    const y0=s.y
    expect(s.speed).toBeGreaterThan(UNITS[type].chargeSpeed-0.05)
    expect(s.speed).toBeLessThan(UNITS[type].chargeSpeed*1.15)
    expect(y0).toBeLessThan(215)
    commandAttack(b,[rider.id],one(b,1,'sword',100,y0-40,N).id)
    let sideways=0,turned=Infinity
    for(let i=0;i<100;i++) {
      step(b,0.05)
      sideways=Math.max(sideways,Math.abs(s.x-100))
      if(turned===Infinity&&Math.abs(angDiff(s.facing,S))<10*Math.PI/180) turned=(i+1)*0.05
    }
    expect(sideways).toBeLessThan(width)
    expect(turned).toBeLessThan(seconds)
  })
})

describe('slow cart traction: pushing over light foot from a standstill, held by a deep block',()=> {
  /** One cart at rest, moved straight through a standing, braced block of militia `ranks` deep that never strikes. */
  const through=(type:'chariot'|'heavyChariot',ranks:number)=> {
    const b=createEmptyBattle(11),cart=one(b,0,type,100,100,0)
    const foe=spawn(b,1,'militia','line',103.5,100,Math.PI,{models:10*ranks,files:10})
    for(const s of foe.soldiers) s.meleeCd=1e9
    cart.fireAtWill=false
    const hp=foe.soldiers.reduce((n,s)=>n+s.hp,0),back=Math.max(...foe.soldiers.map(s=>s.x))
    commandMove(b,[cart.id],130,100,null)
    let knocked=0,passed=false
    for(let i=0;i<300;i++) {
      step(b,0.05)
      knocked=Math.max(knocked,foe.soldiers.filter(s=>s.down>0).length)
      passed||=cart.soldiers[0].x>back+2
    }
    return {passed,knocked,lost:hp-foe.soldiers.reduce((n,s)=>n+(s.alive?s.hp:0),0)}
  }

  it.each([['chariot',1],['chariot',4],['heavyChariot',1],['heavyChariot',4],['heavyChariot',6]] as const)('a %s at rest pushes over a %s-rank line and drives through it, unharmed',(type,ranks)=> {
    const run=through(type,ranks)
    expect(run.passed).toBe(true)
    expect(run.knocked).toBeGreaterThan(0)
    expect(run.lost).toBe(0)
  })

  it.each([['chariot',6],['chariot',8],['heavyChariot',8]] as const)('a %s at rest is held by a %s-rank block',(type,ranks)=> {
    expect(through(type,ranks).passed).toBe(false)
  })

  // A charge runs on its momentum (RULES 四.7): spent among the men of a deep block, the carts are held there and push
  // nobody over until they are ordered out. They used to grind on through the rest of the block at shove pace.
  it.each([1,7,42])('a chariot regiment that spends its charge in a sword block is held there (seed %s)',seed=> {
    const b=createEmptyBattle(seed)
    const carts=spawn(b,0,'chariot','carts',100,40,Math.PI/2,scaledFormation('chariot',4))
    const foe=spawn(b,1,'sword','foe',100,110,-Math.PI/2,scaledFormation('sword',4))
    b.aiEnabled=false
    commandAttack(b,[carts.id],foe.id)
    const back=Math.max(...foe.soldiers.map(s=>s.y))
    let deepest=0
    for(let i=0;i<300;i++) {step(b,0.05);for(const s of carts.soldiers) if(s.alive) deepest=Math.max(deepest,s.y)}
    expect(carts.soldiers.filter(s=>s.alive&&s.chargeSpent).length).toBeGreaterThanOrEqual(3)
    expect(carts.bogged).toBe(true)
    expect(deepest).toBeLessThan(back)
    expect(battleErrors(b)).toEqual([])
  },30000)
})

describe('rams run on momentum: how deep one charge goes',()=> {
  const N=Math.PI/2,S=-Math.PI/2
  /** One rammer at charge speed into the middle of a standing 6-rank, 20-file block, at its braced front or its back. */
  const charge=(type:UnitType,foeType:UnitType,from:'front'|'rear')=> {
    const b=createEmptyBattle(1),ram=one(b,0,type,100.3,30,N)
    const block=spawn(b,1,foeType,'block',100,100,from==='front'?S:N,{...scaledFormation(foeType,4),files:20})
    for(const s of block.soldiers) s.meleeCd=1e9
    b.aiEnabled=false
    tick(b,1)
    commandAttack(b,[ram.id],block.id)
    const edge=Math.min(...block.soldiers.map(s=>s.y)),r=ram.soldiers[0],rows=new Map<number,number>()
    let started=-1,during=-1,deep=0
    for(let i=0;i<400;i++) {
      step(b,0.05)
      for(const s of block.soldiers) if(s.down>0&&!rows.has(s.id)) rows.set(s.id,Math.round((s.prevY-edge)/UNITS[foeType].rankSpacing)+1)
      if(started<0&&rows.size) started=b.time
      if(started>=0&&during<0&&r.plowLeft<=0) {during=rows.size;deep=Math.max(...rows.values())}
      if(started>=0&&b.time>started+4) break
    }
    expect(battleErrors(b)).toEqual([])
    return {during,total:rows.size,deep}
  }

  // Calibration starting points to be tuned from play: a chariot has momentum for about four braced light infantry from
  // the front and more from behind, heavy cavalry for two ranks from the front and more from behind.
  it('a chariot throws a few braced light infantry from the front, more from behind, then its charge is spent',()=> {
    const front=charge('chariot','militia','front'),rear=charge('chariot','militia','rear')
    // About four, give or take the order the men are met in; it used to bowl over 15-30 and drive out of the far side.
    expect(front.during).toBeGreaterThanOrEqual(3);expect(front.during).toBeLessThanOrEqual(8)
    expect(rear.during).toBeGreaterThan(front.during)
    // Spent among them it is stuck: nobody more goes down after its momentum is gone.
    expect(front.total).toBeLessThanOrEqual(front.during+1)
  },30000)

  it('heavy cavalry knock down about two ranks from the front and more from behind',()=> {
    const front=charge('heavyCavalry','militia','front'),rear=charge('heavyCavalry','militia','rear')
    expect(front.during).toBeGreaterThanOrEqual(2);expect(front.deep).toBeLessThanOrEqual(2)
    expect(rear.deep).toBeGreaterThan(front.deep)
  },30000)

  // A monster as wide as three men can still throw the men at its shoulders, who do not face it.
  it.each(['chariot','heavyChariot','heavyCavalry','demigryph'] as UnitType[])('braced spears: a %s charging their front knocks no one down and cannot push in afterwards',type=> {
    expect(charge(type,'spear','front').total).toBe(0)
  },30000)
})
