import type { Battle,Regiment } from './types'
import * as orders from './orders'
import { setAiEnabled } from './battle'

export type BattleCommand=
  |{kind:'move';ids:number[];x:number;y:number;facing:number|null;queue?:boolean}
  |{kind:'attack';ids:number[];targetId:number;queue?:boolean}
  |{kind:'hold';ids:number[];facing?:number}
  |{kind:'behavior';ids:number[];patch:Partial<Pick<Regiment,'run'|'fireAtWill'|'meleeMode'>>}
  |{kind:'front';id:number;x1:number;y1:number;x2:number;y2:number;queue?:boolean}
  |{kind:'groupFront';ids:number[];x1:number;y1:number;x2:number;y2:number;queue?:boolean}
  |{kind:'place';places:orders.Placement[];queue?:boolean}
  |{kind:'beginWidth'|'endWidth';id:number}
  |{kind:'width';id:number;files:number}
  |{kind:'ai';enabled:boolean}

export function applyCommand(b:Battle,c:BattleCommand):void {
  switch(c.kind) {
    case 'move':orders.commandMove(b,c.ids,c.x,c.y,c.facing,c.queue);break
    case 'attack':orders.commandAttack(b,c.ids,c.targetId,c.queue);break
    case 'place':orders.commandPlace(b,c.places,c.queue);break
    case 'hold':orders.commandHold(b,c.ids,c.facing);break
    case 'behavior':orders.commandBehavior(b,c.ids,c.patch);break
    case 'front':orders.commandFront(b,c.id,c.x1,c.y1,c.x2,c.y2,c.queue);break
    case 'groupFront':orders.commandGroupFront(b,c.ids,c.x1,c.y1,c.x2,c.y2,c.queue);break
    case 'beginWidth':orders.beginWidth(b,c.id);break
    case 'endWidth':orders.endWidth(b,c.id);break
    case 'width':orders.commandWidth(b,c.id,c.files);break
    case 'ai':setAiEnabled(b,c.enabled);break
  }
}
