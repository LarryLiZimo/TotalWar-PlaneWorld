import type { ArmySetup } from './armies'
import type { BattleCommand } from './commands'
import type { Scenario } from './scenarios'
import type { BattleWire,StateFrame } from './transport'

export type BattleSource={scenario:Scenario;seed:number;setup?:ArmySetup}
export type WorkerRequest=
 |{kind:'init';source:BattleSource;paused:boolean;speed:number}
 |{kind:'control';paused:boolean;speed:number}
 |{kind:'command';command:BattleCommand}
 |{kind:'step'}
 |{kind:'recycle';buffer:ArrayBuffer}
 |{kind:'snapshot';requestId:number}
export type WorkerReply=
 |{kind:'init';battle:BattleWire;frame:StateFrame}
 |{kind:'frame';frame:StateFrame}
 |{kind:'snapshot';requestId:number;snapshot:unknown}
 |{kind:'error';message:string}
