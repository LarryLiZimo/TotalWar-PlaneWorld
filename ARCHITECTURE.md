# 技术结构与实现

本文件解释程序怎样落实[战斗规则](RULES.md)。规则描述可观察的行为，这里描述状态、算法、消息、绘制和代码职责。具体兵种与战场配置是模拟的输入；玩家界面、规则 AI 与未来 RL 是控制者；显示层读取结果。

## 系统边界

```text
鼠标 / 键盘 / 页面控件 → 输入转换 → 命令 → 战斗模拟 → 权威状态
规则 AI ──────────────────────→ 命令        │
未来 RL（尚未接入）─────────────→ 命令        ├→ 诊断与无界面测试
兵种 / 军队 / 初始部署 ──────────→ 初始化    └→ 状态传输 → 插值显示 → 绘图与面板
```

当前使用 TypeScript、Vite 与浏览器绘制。核心模拟不依赖 DOM，可以直接在无界面测试中创建战局并推进。独立 Worker 是模拟的默认运行位置，主线程负责交互、镜头、显示和页面；它们不是两套不同的战斗规则。

## 代码按职责分布

| 职责 | 入口 |
| --- | --- |
| 战局、部队、兵模、弹丸与配置类型 | [types.ts](src/sim/types.ts) |
| 初始化、每步调度、移动与战斗流程 | [battle.ts](src/sim/battle.ts) |
| 命令数据与命令执行 | [commands.ts](src/sim/commands.ts)、[orders.ts](src/sim/orders.ts) |
| 队形格位、几何、变阵与列阵条件 | [formation.ts](src/sim/formation.ts) |
| 命中、护甲、修正等计算 | [combat.ts](src/sim/combat.ts) |
| 通用机制参数与疲劳表 | [mechanics.ts](src/sim/mechanics.ts) |
| 物理接触、碰撞尺寸、地面阻力 | [physics.ts](src/sim/physics.ts) |
| 连续弹道与身体相交 | [ballistics.ts](src/sim/ballistics.ts) |
| 士气状态推进（溃逃、重整计时） | [morale.ts](src/sim/morale.ts) |
| 实力（战场价值）、实力条占比与战败判定 | [power.ts](src/sim/power.ts) |
| 邻域候选查询 | [spatial.ts](src/sim/spatial.ts) |
| 具体兵种 / 军队 / 场景 | [units.ts](src/sim/units.ts)、[armies.ts](src/sim/armies.ts)、[scenarios.ts](src/sim/scenarios.ts) |
| 规则 AI 决策 | [ai.ts](src/sim/ai.ts) |
| Worker 调度、协议与主线程客户端 | [battle.worker.ts](src/sim/battle.worker.ts)、[worker-protocol.ts](src/sim/worker-protocol.ts)、[battle-client.ts](src/battle-client.ts) |
| 状态打包、接收与插值 | [transport.ts](src/sim/transport.ts) |
| 页面生命周期与 HUD、指针与键盘输入、镜头 | [main.ts](src/main.ts)、[input.ts](src/input.ts)、[camera.ts](src/camera.ts) |
| 战场绘制、属性面板与军队选择 | [render.ts](src/render.ts)、[unit-panel.ts](src/unit-panel.ts)、[army-setup.ts](src/army-setup.ts) |
| 战场画面：地面与天气、兵模造型、战斗痕迹与粒子、军旗 | [ground.ts](src/scene/ground.ts)、[figures.ts](src/scene/figures.ts)、[fx.ts](src/scene/fx.ts)、[banners.ts](src/scene/banners.ts) |
| 程序合成音效 | [audio.ts](src/audio.ts) |
| 现场导出与不变量检查 | [diagnostics.ts](src/sim/diagnostics.ts) |
| 自动测试、测量与生成资料 | `tests/`、`scripts/`，使用方法见 [TESTING.md](TESTING.md) |

这是现有代码的职责地图，不表示每项规则已经完全独立成单一模块。例如领导力来源收集、伤害事件与实际扣血仍由 battle.ts 组织；不要误以为 morale.ts 包含全部士气逻辑。热键（attachKeys）、隐藏页自动暂停（pauseWhileHidden）、点选规则（clickSelection）和 Alt / Ctrl 拖动手势判定（gestureOf，按住的修饰键中后按下者为准）位于 input.ts，main.ts 只负责接线。Ctrl / Cmd + A 由 attachKeys 拦截并调用 KeyActions.selectAll；这次按下的 A 直到松开都不进入按住的键集合，不会平移镜头。左键拖动越过点击阈值的那一刻，若按着 Alt / Ctrl 且选中了己方部队，会话进入 'place' 模式，否则是框选；'place' 与右键拖动（'front'）共用下面的组合，但不拉战线、不下单击命令。一次拖动的平移 / 旋转由 input.ts 的 Composition 组合：base 是当前手势作用的布局（起初为空，即各队 planEnd），(rx, ry) 是该手势的参照点（起初为按下处），last 是已拖出的布局；生效手势一变（含松开修饰键变为无手势），last 冻结为新的 base，切换时的指针成为新参照点。无手势时返回 base，松开按键用 last 下令。

## 状态怎样表示

Battle 持有战局时间、种子与随机数生成器、部队、弹丸、AI 待执行命令、胜负结果和显示用的实力 power（双方 value / max / losing，首步之前全为零）。Regiment 保存队形锚点、命令、目标、疲劳、领导力和队级计时器；Soldier 保存实际位置、个人朝向、生命、格位、挥击、冲锋、倒地及外力。

移动令另有 disengaging（近战中下令的主动脱离例外，持续到该移动结束）和 stall / stallGap（与敌接触中未能接近目的地的秒数，以及期间离目的地格位的最近平均距离，首次接敌前为 −1）。它们与其他字段一样随 RegimentWire 发送，主线程不读取。nearEnemy 记录本步运动接触搜索是否发现武器外伸 +0.5 米内的敌人，只作该搜索的诊断探针（[contact-query 测试](tests/contact-query.test.ts)读取）。

queue 是 Shift 追加的 QueuedOrder 列表：'move' 带目的地、朝向和可选宽度（排队战线），'attack' 带目标 ID。meleeMode 表示远程切换为近战；射击、攻击接敌、冲锋、接战和脱离窗口等行为统一用 units.ts 的 firesMissiles(reg)（有远程武器且未开近战模式）判断，不直接看 UnitDef.missile。弹药耗尽时由 resolveShooting 在每队每步一次的判定中调用 orders.ts 的 setMeleeMode(reg,true)（与 F 键同一状态切换）：射击循环本就逐人检查，顺带记下是否还有人有弹，不另做扫描；本步打出最后一发的部队在下一步转换。commandBehavior 在 outOfAmmo(reg) 时忽略切回射击，main.ts 的按钮与 F 键同样跳过无弹部队，全部无弹时按钮禁用并显示开启。

单位定义 UnitDef 是配置模板，实际战局的个人最大生命保存在 Regiment.modelHp。后者纳入单体规模变化，负伤、战损士气和显示不能直接套用模板生命。

`escaped` 区分退场与阵亡：退出者 `alive=false`、保留正生命、`deathTime=-1`，不产生新尸体。退场时清除运动、挥击、锁定和冲锋状态，后续查询与绘制排除其身体。原有死者保持原记录。

溃逃使用共同逃跑方向加个人平滑偏转与速度差，不再调用方阵格位跟随或减员补位。方向来自部队实际身体中心、本方边界和附近敌军，个人差异由种子、兵模 ID 与溃逃次数经完整雪崩的整数散列（murmur3 fmix32 收尾）确定，相邻 ID 的步速互不相关，不消耗战斗 RNG；仍通过原运动和碰撞流程推进。普通重整时才在散乱存活者周围重新分配格位，不瞬移身体。

## 模拟怎样推进

标准步长 SIM_DT 为 0.05 秒，即每秒 20 个模拟步。画面刷新频率与模拟频率独立。要求严格重放时，使用同样种子、固定步长，并在同样模拟步提交命令。

step 当前按以下顺序组织：

1. 保存上一姿态，更新冷却 / 负伤标记，取消不应继续的挥击，递减来源惊骇冷却并清空本步伤害来源。
2. 推进时间和临时效果，执行到期的规则 AI 命令，计算攻击目的地（攻击目标覆灭或溃逃且有排队命令时开始下一条，同时判定是否进入冲锋距离 inChargeRange），设置个人冲锋意图和整队的 wantCharge，更新冲锋参差量 ragged。
3. 移动队形和兵模，衰减地面外力，建立本步活体列表与空间网格。
4. 普通近战（带冲锋意图、接敌时达到速度门槛者当步结算第一击）、碰撞攻击、射击 / 弹丸、动能冲撞（只有推挤与击倒）。
5. 最多四轮有界接触分离与冲量响应，处理边界及溃逃整队退场；然后结算移动令：本步被敌方近战命中而损失生命（hurt 记入 struck，碰撞攻击也是近战）的行军就地转坚守（haltMarch）并清空队列，主动脱离不受此影响；有排队命令且队形框已到达目的地（waypointReached，战车仍需 arrived）时开始下一条，否则已到达者转坚守；与敌接触却无法再接近目的地者近处视同到达（有排队则开始下一条），远处就地停下并清空队列。
6. 更新疲劳（fatigueRate 按本步实际活动取一项速率）、停滞、接触与领导力，补齐减员队形，刷新人数，最后由 decideBattle 刷新实力 Battle.power 并在其上判定胜负：一方的 ArmyPower.losing 为真即战败，它仍在场的部队（永不溃败的除外）当即 shatter 并 dropOrders，Battle.winner 写入胜方，再刷新一次实力。winner 只记录结果，step 不因它停止，胜负也只判定一次。

伤害后的惊骇检查发生在领导力阶段，因此可以使用本步结算后的领导力；冷却归属来源部队，不写在受害者身上。实力不参与领导力；step 末尾的 refreshPower 按本步溃逃和死亡之后的战场写入 Battle.power，供胜负判定、显示、传输和导出。阶段顺序属于实现说明，调整时必须检查是否改变接触、伤害、士气和胜负的可观察结果。

## 控制者与命令接口

BattleCommand 当前支持 move、attack、place、hold、behavior、front、groupFront、beginWidth / width / endWidth 和 ai。移动携带部队 ID、目的地与可选朝向；攻击携带己方部队 ID 与敌方目标 ID；place 携带每队各自的目的地与朝向（Alt 平移 / Ctrl 旋转拖动），保持宽度；行为设置携带 run、fireAtWill、meleeMode 等变更。move、place、front 和 groupFront 设置的 'move' 是暂时命令：下令时记下是否处于近战（主动脱离），之后由 step 中的 settleMoveOrders 在到达、受攻击或受阻时自动改为 'hold'，规则见[新命令怎样影响旧行为](RULES.md#2-新命令怎样影响旧行为)。

move、attack、place、front 和 groupFront 可带 queue:true。orders.ts 的 enqueue 把命令追加到 Regiment.queue，待命部队立即开始；位置从 planEnd（最后一条排队移动、当前移动的目的地，否则当前位置）排布，平移 / 旋转预览也取 planEnd。advanceQueue 取出下一条，跳过目标已覆灭或溃逃的攻击，由 step 在上述时机调用。不带 queue 的上述命令和 commandHold 清空队列，haltMarch、溃逃与退场同样清空；改宽和行为设置不影响队列。

主线程视图通过 sendCommand 转发，Worker 的 applyCommand 调用 orders。页面筛选玩家方，执行层检查部队是否存在、存活、未溃逃以及攻击是否跨阵营等条件。当前消息接口是本地游戏接口，并不是经过设计的联网权限安全边界。

现有规则 AI 从 ai.ts 生成意图，由 battle.ts 延迟约 1.5 秒后调用同一套 orders；目前并非所有 AI 决策都经 Worker 消息往返。它包含迎敌、面向骑兵列阵、远程跟随己方步兵并在射程内站定射击，以及机动侧袭（冲向远程时路线旁有任一类已列阵的玩家部队，就改袭侧翼）；AI 的远程同样不会自行后撤，行为设置不变。AI 的移动同样会因到达或受攻击结束；意图签名未变时，已执行过的移动不会重新下达。

未来 RL 应接在“观察战局 → 选择命令”这一边界：复用规则与命令语义，另行定义可见信息、动作频率、奖励及胜负评估。当前尚未实现该观察接口、训练模型、奖励或自博弈；这段是设计方向，不是已有功能。

## 关键算法与数值处理

### 队形与个人运动

手动变阵使用最小总位移的精确分配；减员补位按新格位从前到后选择最近的未分配兵模，采用二次复杂度，避免 240 人编制每次死亡都执行立方复杂度匹配。只有存活人数变化时才触发相应减员整理，改变格位不直接改变身体坐标。

列数上下限由 formation.ts 的 formationLimits(def, 部署人数) 给出，部队用 regimentLimits(reg) 按 Regiment.initial 取值，变阵、改宽、拖线、靠边移入地图和补位都以它调用 fileCount。UnitDef.maxFiles / maxRanks 按 4× 人数（units.ts 的 designModels）调校，部署人数更多时两者乘 √(部署人数 ÷ 4× 人数) 并取整，更少时不变。armies.ts 的 scaledFormation 按同一系数加深默认部署排数，使 8× 军队保持 4× 的比例。

普通个体微小转向进入 0.01 弧度容差，且角速度可在本步停止时，完成对准并清除残余角速度。它防止一个永久小残角让实际速度始终略低于配置值，属于数值稳定处理。

战车转向比较左右转弯圆与切线，沿可行短弧线接近目标；减速或切线失效时重规划，接近泊位按剩余路径制动。转速受配置上限、角加速度与“速度 / 转弯半径”共同限制，到位后才小幅修正朝向。转弯参数按兵种配置：基础战车与火枪战车半径 2.2 米、转速上限 1.6 弧度/秒、角加速度 3 弧度/秒²；重装冲击战车半径 2.8 米、转速上限 1.3 弧度/秒、角加速度 2.5 弧度/秒²；三者泊位容差均约 0.22 米。各兵种生效值以 [转向表](UNITS/MOVEMENT.md#转向) 为准（该表以度为单位），属于可调整的本作近似。

### 运动几何与战斗几何

physics 的移动接触几何与 formation 的武器 / 可见身体几何分开；弹道再使用带高度的圆柱，战车沿胶囊取多个圆柱。战场暂无地形：Battle 不含地形状态，地面高度恒为 0，身体圆柱从 0 起算，弹丸落到 z ≤ 0 即消失（地形作为后续工作记在 [TODO.md](TODO.md)）。友军接触尺寸缩为视觉的 62%，普通敌对接触则使用完整尺寸；例如步兵友军接触半径约 0.198 米，敌对为 0.32 米，避免把友军通行缝也提供给敌人。分离阶段的查询范围、距离粗筛和柔性层随双方关系使用相应尺寸。战车保留其专用牵引 / 碾压碰撞尺寸：视觉半径 1 米、长度 3.4 米，对应移动半径 0.62 米、长度约 2.108 米，牵引预算和高速冲撞规则单独决定能否破阵。

接触方向取胶囊最近接触面，不统一使用身体中心连线。四轮软层恢复每轮采用 `1-exp(-20×dt/4)`，深层穿入另作有界修正，每轮最大位置校正约 0.12 米。位置校正用于消除数值重叠，外力速度另由冲量、摩擦与牵引更新。相关系数集中在 mechanics.ts。

Spatial 是可扩容的局部空间网格，用来缩小选敌、遮挡、弹丸和身体接触的候选范围；它不等同于全局路径规划。当前没有复杂障碍地图的完整寻路系统。

每次填充时，网格按阵营记录窄体（物理体型不超过 1 的圆形身体）和宽体（胶囊或物理体型大于 1）的最大身体半径，宽体另放入自己的分桶。最近敌人、近战目标与到期挥击、碰撞攻击、动能冲撞、改攻扫描和停火判定等接触搜索，范围取“间隙 + 自身半径 + 胶囊半轴 + 两类敌方各自的最大半径 + 填格之后身体已移动的距离”。因此大型或胶囊身体不会因落在 2 米网格中的位置而被漏掉，步兵不会搜索超出自己可触及的范围，少数大型身体也不会扩大所有人的搜索。

分离阶段对窄体只搜索自身碰撞界限加本轮任一窄体已被推开的最大距离，对宽体搜索完整半径，候选顺序不变；若身体被自身接触推出已查格子仍能覆盖的范围（Spatial.room），它余下的循环改用完整搜索的候选列表，因此遇到的身体对及其顺序与原全半径搜索完全一致。火枪射线遮挡只搜索沿弹道的走廊；近战遮挡和弹丸飞行使用同样的精确余量。

### 队形接战

近战怎样接上只有一条主线：**队形是每个兵模唯一的目标**（[规则](RULES.md#3-接近敌人后谁进入近战)）。battle.ts 里没有个人选敌：原先的 chargeAt（按“距离 + 拥挤”在整个目标部队里挑人）、attackLane 与绕行、blockerOnLine、受阻计时 blockedTime 和 attackCommitted 已全部删除，它们是同一个设计的层层补丁——每个没有对手的兵模各自找敌兵，后排因此往缝里挤、从两翼包、绕着友军转，每步还要让每个进攻者扫描目标全队。现在的组成：

- **队形目的地**（updateAttackDest）：近战攻击的目的地是目标存活身体的中心（aliveCenter），从哪一侧来都朝它推进；接战（engaged）后目的地就是自己脚下。
- **整队停与跟**（finishChargeFatigueBog 的 linePressed、moveRegiments）：第一排（rank 0，含只有一排居中短列的部队）被敌人贴住的人数达到 45% 时 engaged，降到 40% 以下解除；溃逃中的敌方身体不算贴住（除非其部队就是本队的攻击目标），nearestEnemy 同样跳过它们，所以没有人为溃兵停步或转身，挥击选目标（resolveMelee）不受此限；刚撞上或打飞敌人的人（Soldier.impactHold > 0，由 resolveImpact 和 heavyBlow 设为 MECHANICS.impactContactHold，逐步递减，新命令清零）同样计入被贴住的人数，所以一名骑手的冲撞不会让整队停下。engaged 之后 wantCharge 才清除（战车是接触且不在穿阵时），个别兵模先接敌不结束全队的冲锋。engaged 的攻击方队形不再行军，而是按 frontLag（上一步第一排被挡住的人落后自己格位的平均距离，沿朝向）每步最多移动 FRAME_SETTLE_PACE × dt：冲过头退回，第一排上前则跟上。待命（hold）部队的队形不动。
- **逐人分支**（moveSoldiers）：倒地、溃逃、冲开、战车各走原路；挥击前摇中站定；武器距离内有敌人时，第一排 closeIn 贴到 CLOSE_GAP，其余人原地转向他；否则第一排在攻击令下调用 runIn——nearestEnemy 在 reach + engageRange（1.5 + 0.2 × 冲锋速度，与按当前速度刹停所需距离 speed² ÷ 2 ÷ 减速度 取较大者）内、自身朝向 ±ENGAGE_CONE（35°）找最近的站立敌兵并直接跑向他；再否则 followSlot 走向自己的格位。只有这一处会让人离开格位，且只有第一排。
- **列内纪律**（followSlot 的 fileLeader）：部队 inContact 或 engaged 时，rank > 0 的人把目标点沿朝向收回到“同列前一人实际位置 − FILE_KEEP × 排距”，所以一列人在被挡住的排头身后依次排队。排头倒地时不受他约束；居中短末排没有同列排头。每个部队每步建一次“排 × 列 → 兵模”表（Press.files）。
- **友军挡路与叠兵**：没有专门的判断。列内纪律只查本队的同列前一人，followSlot 在移动令和攻击令下都用 friendlyHeading 从别队友军的行列间穿过（不论对方站着、行军还是正在交战），友军之间的移动碰撞体本来就比身体细。所以后到的队伍穿过先到的友军，第一排挤进对方第一排之间接敌，两队叠在同一块地上；这是规则允许的叠兵，不是需要修的拥挤。
- **大小友军混站**（separate）：一大一小的友军身体对（战车除外）在判定接触前把间隙加上 MECHANICS.mixedPassShare × 大型一方的移动半径，马和怪步因此能站进步兵列缝。

- **减员补位**（formation.ts 的 compactRanks）：按格位而不是按身体位置重新分配。完整各排从前往后，每个格位取“原格位”离它最近的人，于是倒下者身后的人顶上、同列依次前移；剩下的人按原格位从左到右的顺序排进居中的短末排。按身体位置匹配在参差的接触线上会把前排格位分给恰好离格位线更近的第二排，让正在厮杀的人拿到一个走不回去的后排格位。

每个兵模每步只做局部网格查询，不再遍历目标全队。

### 冲锋节奏、冲撞传导与重击

这几项只改“人怎么动”，都在 battle.ts，数值在 mechanics.ts（chargeRun、surgeStart / surgeEnd、footBurst、chargeStagger 等、shove*、blowShove*）：

- **冲锋距离**：updateAttackDest 用队形锚点到目标身体中心的距离减去目标队形的半对角线，与“冲锋速度 × chargeRun”比较，得到 Regiment.inChargeRange；有转弯半径的身体（骑兵、怪兽）恒为真，接到攻击令就按冲锋速度走。armCharge 据此设 wantCharge（战车恒为真）；moveSpeedOf 对队形只在 wantCharge 时给冲锋速度，所以步兵在远处按跑步接近。个人的 chargeArmed 不变，疲劳的冲锋活动与士气的冲锋项另要求 wantCharge。
- **加速曲线**（surgeRate）：有转弯半径的身体（骑兵、战车）加速度 = 基础值 ×（surgeStart 到 surgeEnd 按当前速度 ÷ 目标步速线性，当前 0.6 到 1.6），到顶速的时间与匀加速大致相同；基础值在 accelRate：骑兵 4、战车 2.2、其余 1.7 米/秒²。无转弯半径的身体在目标步速高于跑步速度、且自身已有半速时乘 footBurst。队形框（march）与兵模（steer、steerCart）用同一个函数，减速仍用 accelRate。
- **冲锋参差**：Regiment.ragged 在 wantCharge 且未接触时按 staggerRise 升到 1，否则按 staggerFall 降到 0。followSlot 把格位沿朝向挪动 fileStagger（由列号、部队 id 和 orderSerial 散列出的 −1～1，同一命令内固定）× chargeStagger × min(排距, staggerSpacing) × ragged × 按排递减的系数；只影响兵模要走去的点，slotOf 本身不变。
- **冲撞传导**（resolveImpact 的 shoveBack、driveBack）：每一下冲撞对没倒的被撞者，以及他身后一条窄带里的同阵营步行身体，加上沿撞击方向的外力速度（pushVx / pushVy），由原有的地面阻力消掉。冲撞的接近速度和 contactPower 都改用对方的自主速度（总速度减外力速度），因此传导不改变冲撞与冲锋的结算。
- **重击击退**（landMelee 之后的 heavyBlow）：掉了血的非碰撞近战命中，按攻击者类别对体型 1 的目标调用 knockDown（怪兽，并给打人的那只 impactHold）或 driveBack（怪步、巨剑）。

### 战车的队形框

队形框的锚点是第一排中点，队形一掉头它就挪动一个队形纵深。凡是用它量距离、定方向再反过来决定朝向的规则都会自己追着自己跑，这是此前黄框来回跳的根源，现在只读身体：

- **战车攻击时的队形框**（moveRegiments 的战车分支）：它只是跟着车的标记。朝向只在车群中心与目标身体中心相距超过 CART_FRAME_APART（12 米）时才转向目标，并按战车自己的转速上限转动；车群在目标阵中时保持不变。移动令下不变。

### 领导力

combat.ts 的 leadershipFactors 是纯函数，输入见 LeadershipInput，数值在 MECHANICS.morale；battle.ts 的 updateMorale 每步从战场取这些输入：

- 战损用存活者生命 ÷（部署人数扣除逃离者）× 单兵生命；骤然减员用 taken 里 recentWindow 内的总伤害；战况只取 DamageEvent.melee 为真的 dealt / taken。
- 侧面 / 背后：resolveMelee 和 resolveImpact 用 blockSide 判断每个够得着的敌人站在本队队形矩形的哪一面，每步数出 flankTouch、rearTouch（人数），达到 flankMen 就把 flankHold / rearHold 置为 flankHold 秒，此后逐步递减。
- 遭骑兵冲击：chargeContact 与 resolveImpact 调用 mountedShock，按是否被冲锋防御挡下记入 stoppedHits 或 shockHits；shockHits 不少于 chargedMen 且多于 stoppedHits 时 chargedHold 置为 chargedTime。
- 遭远程打击：hurt 在敌方 missile 伤害时把 fireHold 置为 underFireTime。
- 冲锋：未溃逃的非射击部队，取全队 chargeStrength 的最大值；尚未接敌的人在 wantCharge、chargeArmed 且达到速度门槛时按 1 计。

这些计时都是部队上的有限数值，随快照传到主线程，详情面板直接读 moraleFactors（标签在 unit-panel.ts）。

例外都来自明确规则或物理：射击中的远程按射程站位（updateAttackDest 的射击分支），战车用 driveChariot 逐车驶向实际敌兵并按转弯弧线行驶。动能冲撞后的接战锁定（Soldier.impactHold = MECHANICS.impactContactHold，约 2.5 秒）记在除战车以外的每个冲撞者身上，经 linePressed 计入整队是否停下；战车改为穿阵（plow）。

### 相对速度判定

所有与速度有关的接触判定都经过 battle.ts 的 contactPower(actor, other)，不再有绝对速度常量。它取 actor 的自主速度（vx − pushVx，即去掉地面外力漂移）与 other 的速度，沿两者中心连线投影求迎面相对速度，交给 combat.ts 的 speedPower(相对速度, effectiveChargeSpeed(def, fatigue))：速度比低于 MECHANICS.speedThreshold（0.5，占位值）返回 0，否则返回 min(1, 速度比)（只为舍入留 1e-9 容差，以自身冲锋速度运动即为 1）。身份条件在比值之前：actor 自身朝 other 的自主速度分量不足 OWN_APPROACH（1 米/秒）时直接返回 0，所以被撞者不会被判为冲锋 / 冲撞的一方，双方互冲时各自满足。调用者：resolveMelee 的冲锋接敌、resolveCollisionAttacks、resolveImpact、runningDown（大型身体对该步兵的同一判定）；fatigueRate 的冲锋活动用 speedPower(自主速度, 有效冲锋速度)。

### 动能冲撞

separate 的战车牵引：慢于 5 米/秒、且不在冲开人群中（plowLeft 为 0）的战车把车头前接触到的小型身体负载累加，未站稳迎击的敌人再按身后车道上紧挨着的同伴（TRACTION_SUPPORT_DEPTH / WIDTH / MAX）乘 1 + MECHANICS.tractionSupport × 人数，站稳迎击者（formation.ts 的 bracedAgainst：本队 stationaryTime ≥ braceTime、本人不在走动、面向车 ±60°，不要求车在第一排前方）的纵深已在 collisionMass 中计入。冲锋已用尽的车（Soldier.chargeSpent），或车头前有 chargeDefended 的敌人（正面列阵、抵御冲锋覆盖战车）时，负载视为无穷大；chargeSpent 在车离开敌人武器距离（contactTime 回零）或接到新命令时清除。负载小于质量 × 加速度时，正前方（前进分量 ≥ TRACTION_PUSHOVER_LOAD）的敌方步兵由 pushOver 就地推倒（倒地 KNOCK_TIME、滑移 ≤ 2 米/秒，不造成伤害），其余照旧推向两侧，这辆车记入 Scratch.pushing。finishChargeFatigueBog 的停滞按车判定：贴着敌人（contactTime > 0）、慢、无冲穿余势且不在 pushing 中的车算被挡住，过半数被挡住才累计 bogTime；反之 bogTime 倒退，回零时解除停滞。停滞限速只作用于正贴着敌人的车（moveSpeedOf）。

resolveImpact 只处理物理，不调用 hurt，按动量计算。身体间隙不大于 0.35 米（RAM_GAP）、攻击者物理体型大于目标时冲撞：一次冲锋的第一下要求 contactPower(冲撞者, 目标) > 0，冲开过程中（plowLeft > 0）只要求迎面接近。接近速度用冲撞者的前进速度（speed 沿朝向）减目标速度，投影到接触法向。目标抗撞质量 = mass × MECHANICS.impactMass，bracedAgainst 时再 × impactBraceMultiplier（1 排 ×1 到 8 排 MECHANICS.impactBraceMax）。bleedSpeed 从冲撞者扣去“接近 × 抗撞 ÷（质量 + 抗撞）”的法向速度中沿朝向的部分，并按朝向重设 vx / vy，不留侧向分量；目标获得“接近 × 质量 ÷（质量 + 抗撞）”。物理体型不超过 1 且这个值不小于 MECHANICS.knockdownSpeedChange 时 knockDown（不消耗 battle.rng），冲撞者 plowLeft = PLOW_TIME 继续冲开；没倒、且在冲撞者前方 PLOUGH_BLOCK（朝向余弦 ≥ 0.7）以内的身体结束冲开（endPlough）。chargeDefended 的目标使冲撞者损失全部接近速度并结束冲开。冲开中的非战车身体由 moveSoldiers 的 coast 沿朝向匀速前进，不加速、不转向、不打，速度低于 PLOUGH_END（1 米/秒）时结束；战车在 driveChariot 中驶向 plowX / plowY，速度不超过当前速度。攻击命令下的战车在敌人接触中结束冲开时记 chargeSpent。separate 中 plowLeft > 0 的身体（不论兵种）完全推开敌方身体。每步先求两军各自最快身体的速度和最小物理体型：自主速度不足 OWN_APPROACH、自主速度加敌方最快速度仍达不到门槛，或体型不大于敌方最小体型的身体不可能撞人，直接跳过接触搜索；倒地者不撞人。latched 记录已撞过的身体，按身体间隙（gapBetween）拉开 2 米（RAM_RELATCH）才释放，所以胶囊或大型身体贴着目标时不会每步重撞。溃逃攻击者照常撞倒与减速，但不设置 plow / impactHold。冲撞不进入 struck，不使行军停下。

### 碰撞攻击与冲锋第一击

resolveCollisionAttacks 只对配置了 UnitDef.collisionAttack 的单位（各类战车与巨兽）生效：攻击命令、未溃逃未倒地、collisionCd 已归零、自主速度不低于 OWN_APPROACH，对间隙 ≤ 0.35 米的每个敌方身体求 contactPower。被撞者不满足身份条件，所以不会反击冲撞者；双方互撞时各自满足。按间隙由近到远取不超过 targets 个强度大于零的目标，各调用一次 landMelee(share = 1 / (damage × 强度))：普通命中判定、冲锋与反体型加成照常，伤害为武器威力 × damage × 强度，单击 8 点以上显示伤害浮字。

armCharge 每步只设置冲锋意图 chargeArmed：存活、未倒地、跑步攻击命令、未溃逃、chargeLeft 已归零。resolveMelee 逐兵模调用 trackContact 维护接触计时（Soldier.contactTime / freeTime，以武器距离内有无敌人为准）：一次接触开始时，若是首次接触，或部队的 Regiment.orderSerial（orders.ts 的 resetMovement 每下一个新命令加一）不同于该兵模上次接触时记下的 contactOrder 且已离开满 MECHANICS.rechargeGap（1 秒），chargeOpen 打开；接触持续超过 MECHANICS.chargeEntryWindow（0.5 秒）即关闭。只有 chargeOpen 的兵模能发动冲锋，所以同一命令下的混战不会重复冲锋，撤出后再下令的跳板冲锋可以。带意图、chargeOpen 且自主速度不低于 OWN_APPROACH 的兵模找到攻击区内最近的目标后，求 contactPower(兵模, 目标)；大于零时 chargeContact 设 chargeLeft = CHARGE_DURATION（10 秒）、chargePower = 该强度（目标的冲锋防御适用时为 0），同一步把一次前摇为零的挥击放进到期列表，与到期挥击用同一套选目标、溅射和 landMelee 结算；正在进行的前摇被取消，meleeCd 设为至少一个攻击间隔。各兵种都走这条路径。被抵消的冲锋同样占用 10 秒的 chargeLeft，所以冲进列阵后继续前冲的巨兽或战车不会每步再触发一次冲锋一击。landMelee 的冲锋加成为 chargeBonus × 疲劳冲锋倍率 × chargeStrength(兵模)，chargeStrength = chargePower × chargeDecay(chargeLeft)；疲劳面板显示同一值（chargePower 随姿态数组传到主线程）。

### 冲锋速度采样

速度在接敌那一步取样：s.vx / s.vy 是本步移动（含漂移）后的位移速度，减去 pushVx / pushVy 即自主移动，外力推动不算冲锋速度。本步刚提速到接敌也算；接触前已停下（例如已贴近后原地转身）的兵模自主速度为零，不会冲锋。

个人的局部近战判定与整队 engaged 状态分别使用，后备尚未贴敌时不套用前排的近战慢速。相应行为回归见 [TESTING.md](TESTING.md#已自动覆盖的行为)。

## Worker 与显示同步

Worker 按固定步推进，每轮累计约 8 ms 软预算后让出任务；一个完整重步仍可能超过该预算。有积压时经 MessageChannel 立即续跑（浏览器对嵌套 setTimeout 至少钳制 4 ms），无积压时以 4 ms 定时等待；未初始化或暂停（含出错自动暂停）时不排任何定时器，init / control 消息重新启动循环。分出胜负后循环照常推进（败方逃离战场），直到主线程因“结束战斗”发来暂停。真实时间间隔最多取 0.1 秒，待补模拟时间最多保留 0.3 秒；负载过大时降低实际倍速，不扩大固定步长。

状态通常最多约 30 Hz 发布，主动命令 / 控制 / 单步也可立即发布；循环即将停止时，未发布的步立即发布，不受节流限制。决胜帧随正常节流发出，winner 此后每帧都带。完整对象只用于初始化；后续姿态使用可转移 Float32Array，每个兵模 18 个槽位（含冲锋强度 chargePower），后附队形姿态。部队摘要、弹丸、临时效果、胜负和实力 power 另随帧发送，部队摘要不含 dealt / taken / terrorHits 事件记录（只留在 Worker；主线程只读派生的士气因素，导出现场向 Worker 请求）；旧缓冲转回复用，回收池最多保留 20 个。快照回复附带回收池状态 pool {size, reused}，供真实 Worker 检查确认缓冲确被复用。

主线程区分最新权威视图与显示视图，显示用至多 16 帧的短历史缓冲，至少保留约 100 ms 的模拟时间延迟来抵抗消息抖动。点击、悬停与镜头定位使用显示中的位置。倍速和暂停切换不重置显示时钟：保留缓冲帧与显示时间，只用切换后发出的帧重新估计实际倍速；重复点击当前倍速对显示无影响（控制消息仍发给 Worker）。暂停或单步后，显示以至少 1× 播完约 100 ms 的缓冲延迟，再停在最新帧。位置和朝向在两帧间插值（朝向取最短角度）；生命、死亡、挥击、闪光与尸体计时取显示时刻之前最新的一帧，弹丸按弹道、飘字按剩余寿命推进到显示时刻（两帧之间命中或落地的弹丸到下一帧才消失）。部队摘要（命令、宽度、士气、存活数）、胜负和实力仍取最新帧，以便下令和改宽即时反馈。主线程只读视图不能调用随机数继续模拟，导出现场向 Worker 请求真实状态。

## 绘制与页面刷新

绘图、图集缓存、批绘制、像素密度处理和细节选择都属于表现层；它们不参与武器可达性或伤害结算。身体图集缓存姿态（站立 / 倒地 / 阵亡）、步态帧、挥击帧、外观变体、选中 / 受击 / 负伤状态与 64 档朝向。图集共 16 页，每页 1024×1024；格子按图形大小分档（32、64、128、256 像素，render.ts 的 GlyphClass），每档有自己的页和自己的最近最少使用顺序，所以步兵的小图形不占长枪兵或骑兵的大格子。一档先用完已有页里的空格，再复用自己 600 帧没人用过的图形，再向图集要新页，没有新页时淘汰自己最久没用的图形；图集已满才第一次用到的一档，从占页最多的一档接管一页。

拉近以后，一个兵种的整幅图形会超出格子，prepareGlyphs 按兵种依次退让（GlyphStyle.mode、zoom、scale）：

1. **整幅放得下**：整个人连武器画进一个格子。
2. **武器另画**：长武器是一条细线，却让图形的外接方格比持武器的人大几倍，而它挥击的每个阶段还要按每个朝向、步态和外观各存一份。所以连武器的半边长超过 SPLIT_HALF（16 像素）的步兵和骑兵（figures.ts 的 splitsWeapon）只把身体画进格子（Pose.part 为 'body'，键里不含挥击帧），武器（'weapon'）另成图形：按挥击阶段各一个，朝 +x 画，由批绘制按身体的朝向旋转（SpriteBatch.draw 的 turn），画在身体下面；半边长不超过 64 像素时按两倍大小画、半大小显示，旋转后的细线才不发糊。半边长超过 ARM_HALF（128 像素）的武器、以及没有批绘制时，武器按同一朝向就地画在身体下面。倒地和阵亡的图形仍连着掉落的武器一起画，过长的部分被格子边缘裁掉。
3. **身体缩小后拉伸**：身体本身也超出格子时（近景的马、怪步、战车），按较小的缩放画进格子，绘制时放大，最多放大 GLYPH_STRETCH（2.5 倍）。
4. **就地绘制**：连这也不够的少数巨兽每帧直接画成矢量。

绘制每个格子时先按格子裁剪，任何图形都不会画进相邻格子。

存活兵模达到 256 时，WebGL2 批绘制用一次实例化绘制画出全部图集身体和武器图形（每个实例带缩放与旋转），每帧只合成一次。就地画的内容不能夹在这一次合成中间：武器排在合成之前（在所有身体下面），整幅就地画的巨兽排在合成之后（drawInked 的 under / over 两个队列）；图集格子用尽、需要中途提交批次时，先画出已排队的武器。没有批绘制时（WebGL2 不可用、兵模不足 256、单元测试）走 Canvas 图集路径，逐个身体先画武器再画图集精灵。是否使用批绘制按图形代次（缩放、战局与画布）决定一次，不逐帧切换；存活人数降到 256 以下时沿用到下次缩放变化。

近景不能退回“逐个身体从图集页 drawImage 到主画布”：Chrome 把每次 drawImage 引用的整页图像计入待处理内存，几次之后就强制提交一次，每个身体因此要花零点几毫秒，比画矢量还慢。

各档按最近最少使用淘汰格子；只有要复用的格子已被当前批次引用时，才需先提交批次。中等缩放的混战曾在这里卡顿：全体图形共用按最大兵种（连武器）取的 128 像素格子，图集只有 1024 格，少于一帧混战要用的图形数，每帧重画并上传一百多格（约 4 百万像素，五十毫秒）。批绘制路径的图集页以 willReadFrequently 创建，只用 getImageData 读回重绘过的格子，预乘 alpha 后以类型化子矩形上传，同一行的格子合并；新页的纹理层只清空一次。Canvas 专用路径的图集页仍由 GPU 栅格化。不能把画布作为纹理数组的上传源：Chrome 每次调用都会同步读回整页；向纹理数组上传类型化数组还要求 UNPACK_PREMULTIPLY_ALPHA_WEBGL=false。

高 DPI 下不能沿用一个只看物理 zoom 的全局阈值，让相同视野的大量小兵意外退回昂贵绘制。具体缓存资格与批处理路径以 render.ts 为准，独立绘制优化不应修改兵种战斗几何。战场叠加层（名称、状态条、疲劳面板、宽度圆点、移动与攻击标记、描边与虚线、网格与地图边框、弹丸最小尺寸）按 CSS 像素定尺寸，render 乘以 RenderInput.pixelRatio（每 CSS 像素对应的画布像素，main.ts 传入；未传入时由画布尺寸测得），DPR 1 时与原画面相同。输入命中检测使用同一比例：点击 / 拖动阈值为 8 CSS 像素，宽度圆点的抓取半径为 12 CSS 像素。

按住空格时 RenderInput.showBoxes 与 showStamina 同时为真：画出全部未溃逃部队的队形框与射程、己方的行军目的地与排队路径（drawQueue），以及双方每支部队的疲劳面板（drawFatigue：“疲劳 状态名”、按耗力值 / 力竭阈值增长并在各档阈值处有刻度的进度条，以及冲锋加成行）；不按空格时，队形框、射程和行军标记只画所选部队（悬停部队另画队形框），也不画疲劳面板。近战模式的远程不画射程。Alt / Ctrl 拖动（左键或右键）的预览是 DragPreview 的 'place' 类型，附带每队组合后的目标位置与朝向，按各队当前宽度画出；其 (x0, y0) 是当前手势的参照点。

绘制对象列表与纵向排序按模拟步更新。图集按缩放绘制，但滚轮缩放是逐帧缓动的，不能每帧重画整个图集：缩放变化中沿用已有图集并按比例拉伸（相差 7% 以内），超出后才换到六分之一倍频一档的尺寸；缩放静止 8 帧后按精确缩放重画一次，画面恢复逐像素清晰（render.ts 的 glyphZoomFor）。新战局或新画布直接按精确缩放绘制。

一帧自下而上依次是：不透明底色、地面贴图、命令与队形标记、尸体、兵模、弹丸、粒子、云影与暗角、军旗与状态条。地面是按战局种子生成的一张贴图（地图外另画 48 米景物，每米 6 像素），由 ground.ts 用值噪声、笔触和草叶画成，血迹、泥痕和落地的箭直接盖在同一张贴图上，所以战斗痕迹不增加每帧开销；拉近超过贴图分辨率后叠加一层平铺的草叶细节。这些离屏图层只用 OffscreenCanvas 创建，没有它时（旧浏览器、单元测试）render 退回纯色场地并跳过云影、暗角和柔边粒子。

兵模由 figures.ts 在自身坐标系里画成俯视的人、马、车和巨兽：+x 为朝向、+y 为右手侧，调用方已把画笔移到身体并转到朝向，figures.ts 内部不再平移或旋转画笔，投影与高光按朝向换算，因此所有身体的光影在屏幕上方向一致。figureExtent 给出任意朝向、挥击和投影都不出界的半边长，图集格子据此定尺寸（tests/scene.test.ts 逐兵种核对）。远景（身体半径不足约 4 像素）改画成不描边的本军色块加头部亮点，保证远看仍能分清敌我。

fx.ts 只读取模拟已公布的状态并逐步比较：存活变阵亡留下尸体与血迹，受击闪白的上升沿溅血并让身体后仰，倒地的上升沿扬尘并开始翻滚，冲锋剩余时间跳升视为冲锋命中（扬尘、土块、泥痕、按体重累加的镜头震动），空中新出现的弹丸视为一次射击（枪口焰与硝烟，或登记箭的落点）。它不使用模拟的随机数，也不写回任何模拟状态，第一次看到一个战局时不补发事件。同一批事件经 RenderInput.sound 交给 audio.ts；出手前探、受击后仰、步态和翻滚都是只作用于绘制位置的偏移。粒子按画面所示的战斗时间老化，暂停即冻结；镜头震动与军旗飘动按墙钟时间。

HUD 约每 100 ms 更新，属性卡只在换对象 / 场景时重建，普通刷新只更新数值节点；兵牌换场景必须重新绑定当前部队，即使种子和卡片数量相同。顶部战况栏的实力条按同一节奏由 paintPower 更新，读最新权威帧的 Battle.power，首步之前由部署现场即时计算。两侧阈值刻度按 MECHANICS.armyLossesShare 定位，悬停文字以取整的预算点显示双方当前 / 部署实力，aria-valuetext 同步双方占比与战败状态。Battle.winner 非空后，战况栏下方的 #outcome 显示胜负和“结束战斗”按钮；按下后 main.ts 的 ended 置真、战斗暂停、中央横幅显示结果，直到再战或重新配置。暂停键、隐藏页恢复都只看 ended，不看 winner。顶部控制栏与战况栏换行变高时，ResizeObserver 在根元素上更新 CSS 变量 --below-top，提示与性能面板始终位于其下方。镜头缓动（滚轮目标缩放、键盘平移的起停）由 camera.ts 的 easeCamera 每帧推进；Camera.glide 为 undefined 的镜头（测试里的普通对象）滚轮仍立即生效。

audio.ts 全部用 Web Audio 现场合成，不带音频文件：零散事件按种类和左右声道分区累加，每 50 ms 合并成有限的几个发声（同时最多 24 个），行军、马蹄和混战的底噪由每秒 10 次的全场扫描驱动，音量与明暗随镜头远近变化；暂停时淡出。首次点击或按键后才创建 AudioContext。导出现场的 power 按导出时的战场即时计算。

主画布使用不透明、同步合成的 2D 上下文（alpha:false、desynchronized:false），每帧直接用不透明背景覆盖全部像素，不先清空整幅画布，以免显示清屏中间状态；图集单元仍单独清理。上下文选项由首次创建确定，更新后需刷新页面。历史说明见 [Chrome 资料](https://developer.chrome.com/blog/desynchronized#avoiding-flicker)，验证记录见 [闪烁修复](reports/render-flicker-fix.json)。

## 性能边界与优化方向

20 Hz 模拟在 1× / 2× / 5× 下的平均预算约为每步 50 / 25 / 10 ms。独立 Worker 隔离主线程阻塞，不会自动将整个模拟并行。低总 CPU / GPU 利用率也可能伴随串行瓶颈、栅格化或呈现长帧。

F3 的绘制耗时是 JS 提交，不覆盖全部 GPU 进程与呈现；Node 无界面吞吐也不能换算为画面 FPS。历史基准与容量限制集中在 [reports/README.md](reports/README.md#性能记录与容量限制)，测量方法见 [TESTING.md](TESTING.md#性能结果怎么读)。

优化先核对实际 DPI / 视野下的缓存与呈现，再检查选敌候选、重复邻域查询、遮挡复验、碰撞活动集合和数据布局。每轮必须使用相同种子、同一交战状态、同一设备复测实际倍速与帧时间，并保留后备参战、实体阻挡与确定性。当前没有证据表明只需换框架就能消除所有热点。

此前评估过 PixiJS 显示层、Bevy/Rust ECS、Godot + GDExtension/C++ + MultiMesh；历史评估及官方资料链接保留在[迁移评估记录](reports/README.md#后续优化与框架选择)。它们不是已实施的迁移，也不是同场景性能承诺。待做工作统一见 [TODO.md](TODO.md)。

## 文档与配置怎样保持一致

RULES 记录规则语义与通用参数；UNITS 记录每个兵种的具体值；BATTLEFIELDS 记录地图和预设初态；CONTROLS 记录玩家交互。修改规则时需要同步对应行为测试，不能只更新文字。

单位资料由 [unit-docs.mjs](scripts/unit-docs.mjs) 从 units.ts、armies.ts 和通用机制配置生成。改单位数值后运行 `npm run docs:units`，再用 `npm run docs:check` 核对，避免手工维护两份数值。测试证据和历史性能保留在 TESTING 与 reports，未完成设计保留在 TODO。
