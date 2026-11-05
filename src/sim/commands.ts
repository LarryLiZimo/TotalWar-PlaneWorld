import type { Battle,Regiment } from './types'
import * as orders from './orders'
import { setAiEnabled } from './battle'

export type BattleCommand=
  |{kind:'move';ids:number[];x:number;y:number;facing:number|null}
  |{kind:'attack';ids:number[];targetId:number}
  |{kind:'hold';ids:number[];facing?:number}
  |{kind:'behavior';ids:number[];patch:Partial<Pick<Regiment,'run'|'fireAtWill'|'skirmish'>>}
  |{kind:'front';id:number;x1:number;y1:number;x2:number;y2:number}
  |{kind:'groupFront';ids:number[];x1:number;y1:number;x2:number;y2:number}
  |{kind:'beginWidth'|'endWidth';id:number}
  |{kind:'width';id:number;files:number}
  |{kind:'ai';enabled:boolean}

export function applyCommand(b:Battle,c:BattleCommand):void {
  switch(c.kind) {
    case 'move':orders.commandMove(b,c.ids,c.x,c.y,c.facing);break
    case 'attack':orders.commandAttack(b,c.ids,c.targetId);break
    case 'hold':orders.commandHold(b,c.ids,c.facing);break
    case 'behavior':orders.commandBehavior(b,c.ids,c.patch);break
    case 'front':orders.commandFront(b,c.id,c.x1,c.y1,c.x2,c.y2);break
    case 'groupFront':orders.commandGroupFront(b,c.ids,c.x1,c.y1,c.x2,c.y2);break
    case 'beginWidth':orders.beginWidth(b,c.id);break
    case 'endWidth':orders.endWidth(b,c.id);break
    case 'width':orders.commandWidth(b,c.id,c.files);break
    case 'ai':setAiEnabled(b,c.enabled);break
  }
}
