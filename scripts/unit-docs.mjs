import { createServer } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { UNITS } = await server.ssrLoadModule('/src/sim/units.ts')
  const { collisionRadius } = await server.ssrLoadModule('/src/sim/physics.ts')
  const { MECHANICS } = await server.ssrLoadModule('/src/sim/mechanics.ts')
  const { ARMIES,ARMY_SCALES,unitModels,scaledFormation,armySummary } = await server.ssrLoadModule('/src/sim/armies.ts')
  const units = Object.values(UNITS)
  const categories = { infantry:'步兵', ranged:'远程步兵', cavalry:'骑兵', chariot:'战车', monstrousInfantry:'怪兽步兵', monster:'怪兽' }
  const weapons = { spear:'长矛', sword:'刀盾/剑', greatsword:'巨剑', bow:'弓/弩', musket:'火枪', halberd:'戟', claws:'双爪' }
  const sizes = ['极小','步行','骑乘','怪步/战车','巨兽']
  const yes = value => value ? '是' : '否'
  const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n') + '\n'
  const n = value => Number(value.toFixed(2))
  const pct = value => `${Math.round(value * 100)}%`
  const docs = {
    'UNITS.md': `# 单位目录

此文件及 UNITS 子目录由 \`npm run docs:units\` 从 \`src/sim/units.ts\` 与 \`src/sim/armies.ts\` 生成。改数值后运行生成命令；\`npm run docs:check\` 检查文档与代码一致。编制与生命以默认 4× 标准规模为准。

规则见 [RULES.md](RULES.md)，测试方法见 [TESTING.md](TESTING.md)。数值为本作平衡初稿，参考战锤的兵种定位，**不是战锤 3 某补丁的数据复制**。生命按每个模型计，单体使用相同的伤害与领导力系统。

- [近战、护甲与攻击动作](UNITS/COMBAT.md)
- [队形、移动与身体](UNITS/MOVEMENT.md)
- [射击、散布与穿透](UNITS/RANGED.md)
- [冲锋防御、碰撞攻击与特殊能力](UNITS/ABILITIES.md)
- [四套军队与规模换算](UNITS/ARMIES.md)

## 编制与定位

${table(['代码','名称','类别','4×人数','4×单人生命','武器','反体型分类','定位'],units.map(d=>[d.type,d.name,categories[d.category],unitModels(d.type,4),d.hp,weapons[d.weapon],d.large?'大型':'小型',d.type==='heavyCavalry'?'枪骑：高冲锋，接敌转近战':d.type==='shieldCavalry'?'刀盾：攻防与盾牌，持续作战':d.type==='horseArcher'?'360° 射界，可移动射击':d.type==='ogre'?'低甲高机动，多目标攻击':d.type==='armoredOgre'?'高甲破甲，机动较低':d.type==='monster'?'低甲高机动，恐惧/惊骇':d.type==='behemoth'?'重甲低速，恐惧/惊骇':d.chargeDefense!=='none'?'列阵抵消冲锋，独立反大型加成':d.antiInfantryMa?'破甲反步兵':d.missile?'远程支援':d.models===1?'单体，群攻共享伤害预算':'常规近战']))}
反步兵适用于全部小型目标，包括远程和步行英雄；反大型适用于骑兵、骑射、怪步、怪兽和战车。物理体型另分五级，用于冲撞、溅射和穿透。

默认进入四套军队选择，玩家与 AI 各选 15 队，规模可选 1/2/3/4/6/8。单体人数保持 1，生命乘规模/4；多人编制人数乘规模/4，个人生命不变。旧「完整会战」和专项复现场景保留固定模板人数，便于历史回归，不受配置面板规模影响。所有单位均能通过无界面的 \`spawn\` 放入测试。
`,
    'UNITS/COMBAT.md': `# 战斗属性与攻击动作

[返回单位目录](../UNITS.md)。伤害是一次普通挥击的总预算，多目标按实际选中目标数均分，各自判定命中与护甲。

${table(['名称','攻','防','甲','不破甲/破甲','间隔秒','外伸米','冲锋','反大攻/威','反步攻/威','盾牌','领导力','最多目标'],units.map(d=>[d.name,d.meleeAttack,d.meleeDefense,d.armor,`${d.weaponBase}/${d.weaponAp}`,d.meleeInterval,d.reach,d.chargeBonus,`${d.antiLargeMa}/${d.antiLargeWs}`,`${d.antiInfantryMa}/${d.antiInfantryWs}`,pct(d.shieldBlock),d.leadership,d.splash]))}
## 二维攻击动作

${table(['名称','前摇秒','最短恢复秒','完整攻击角度','可群攻最大体型'],units.map(d=>[d.name,d.attack.windup,d.attack.recovery,d.attack.arc,`${d.attack.splashMaxSize} ${sizes[d.attack.splashMaxSize]}`]))}
前摇结束时重新检查目标位置、身体遮挡和攻击区域，再判命中与伤害。攻击大于可溅射体型的主目标时，改为集中单目标伤害。间隔从起手计时，包含前摇；完成挥击后即使命中失败或挥空也需最短恢复。连续起手周期约为 max(间隔, 前摇＋恢复)，另有最多一个 0.05 秒模拟步的调度误差。普通移动、倒地、溃逃会取消前摇，不返还冷却。出生时各模型有 [0, 间隔) 的随机初始冷却，路上会消耗；疲劳不直接修改近战间隔。碰撞攻击另有独立冷却，不占普通挥击间隔。

所有兵种共用冲锋属性与按个人速度触发的逻辑，包括步兵和单体；远程武器与零加成不构成排除条件。达到本兵种经疲劳/坡向修正的冲锋速度并有效接敌即可，不要求最低距离、队形或整队朝向偏差。前排接敌后，未贴敌后排仍可按冲锋速度接近并独立获得加成，近战慢速仅限制已经进入武器接触范围的个体；明确选择走路仍用步速。正面普通部队不会抵消加成，适用的列阵冲锋防御才会。接敌后 13 秒衰减照常进行，前摇不会暂停衰减。规则见 [RULES.md](../RULES.md)。

「外伸」从双方身体边缘计算，是二维武器长度/接战容差，不是战锤单位面板射程。尚未导入原作逐动画骨骼和武器轨迹。受击人数由实际身体几何决定，不再固定成普通 2、战车 3、单体 8 个攻击位。
`,
    'UNITS/MOVEMENT.md': `# 队形、移动与身体

[返回单位目录](../UNITS.md)。距离米、速度米/秒；「行进」是跑步基础速度，步行乘 0.5。除单体与战车外通常至少两排，死伤后重新限制队形。

${table(['名称','4×列/排','最宽列','最深排','列距/排距','行进/冲锋','视觉半径/长度','移动碰撞半径/长度','物理体型','身高','质量','穿透阻力','可列阵'],units.map(d=>[d.name,`${scaledFormation(d.type,4).files}/${Math.ceil(unitModels(d.type,4)/scaledFormation(d.type,4).files)}`,d.maxFiles,d.maxRanks,`${d.spacing}/${d.rankSpacing}`,`${d.speed}/${d.chargeSpeed}`,`${d.radius}/${d.length}`,`${n(collisionRadius(d))}/${n(d.length*MECHANICS.collisionRadiusScale)}`,d.physicalSize,d.bodyHeight,d.mass,d.penetrationResistance,yes(d.canBrace)]))}

实际移动碰撞尺寸为视觉尺寸的 ${pct(MECHANICS.collisionRadiusScale)}。外层可压缩，友军软层占碰撞半径 ${pct(MECHANICS.friendlySoftFraction)}，敌军为 ${pct(MECHANICS.enemySoftFraction)}，内核阻止直接穿模，外层逐步恢复。普通步兵视觉半径 0.32 米、移动半径约 0.198 米；允许穿过友军行列空隙。友军前方受阻时局部侧身绕过，骑兵/战车可以有限挤开友军，友军不按抗敌列阵墙处理。
## 转向

${table(['名称','最快度/秒','加速度度/秒²','转弯半径米','原地度/秒'],units.map(d=>[d.name,n(d.turnCap*180/Math.PI),n(d.turnAccel*180/Math.PI),d.turnRadius,n(d.pivotRate*180/Math.PI)]))}
战车为长度×直径的胶囊身体，其余为圆形；弹道使用带高度的圆柱，战车沿胶囊取多个圆柱。步兵、骑兵和怪兽在低速近战不能靠质量持续推挤敌军；战车可用有限牵引力克服少量小型身体的地面阻力，缓慢挤出，不能无限推穿整面列阵。高速碰撞、友军避让和战车碾压保留质量效果。战车行进转向按转弯圆/切线接近目标，保留转速和半径约束，到位后才作小幅朝向微调。攻击令下逐辆驶向目标实际模型，独立完成穿阵；不为归队/等人转走，普通移动/坚守仍列队。新命令默认跑步，运动中再选走路。减员后补齐前排并居中短末排，不保留整列空洞；身体不瞬移。行走与外力分离，外力受地面阻力衰减，具体参数见规则。个人列阵受静止和朝向约束，队列纵深提供质量支持，公式见 [RULES.md](../RULES.md)。
`,
    'UNITS/RANGED.md': `# 射击、散布与穿透

[返回单位目录](../UNITS.md)。弓/弩为弧线，火枪为较平直的抛物线；均检查整段飞行的身体高度，不再只检测箭的落点。

${table(['名称','不破甲/破甲','装填秒','射程米','射界度','弹药','弹速米/秒','角度散布','校准距离/半径米','穿透预算','穿透后伤害','移动开火','弹道'],units.filter(d=>d.missile).map(d=>{const m=d.missile;return [d.name,`${m.base}/${m.ap}`,m.reload,m.range,m.cone,m.ammo,m.speed,`±${m.spread}°`,`${m.calibrationDistance}/${m.calibrationRadius}`,m.penetration,pct(m.penetrationDamage),yes(m.fireWhileMoving),m.arc?'弧线':'火枪']}))}
校准圆半径随距离/校准距离线性变化，圆内均匀取点后再加角度散布；没有另投一次“精度成功/失败”骰。移动目标保留半段飞行时间的提前量，是本作近似。

命中身体消耗其穿透阻力，预算归零即消失；继续飞行时按配置衰减伤害，同一弹丸不重复伤害同一模型。当前普通弹药预算为 1，命中步兵即停；测试可增加预算。盾牌整发格挡会停弹。

火枪开火前检查友军与地形遮挡，未开火不耗弹；枪口安全区和末端误伤是用户指定的设计，见 [RULES.md](../RULES.md)。射界按整队朝向，盾牌按受击个人朝向。弹药与装填按士兵记录，装填过程持续计入耗力。
`,
    'UNITS/ARMIES.md': `# 四套军队与规模

[返回单位目录](../UNITS.md)。进入游戏先选玩家部队、AI 部队与共同规模，默认 4×；开始后 AI 自动行动。「部队」按钮可重新配置，「再战」重开相同配置。每套均为 15 队，尚未按费用配平。

${table(['代码','军队','编成','4×模型总数'],Object.entries(ARMIES).map(([id,a])=>[id,a.name,a.units.map(([type,count])=>`${count} ${UNITS[type].name}`).join('、'),armySummary(id,4).models]))}
## 每队人数

${table(['类型',...ARMY_SCALES.map(s=>`${s}×`)],([['步兵','sword'],['骑兵/骑射','heavyCavalry'],['远程步兵','archer'],['怪步','ogre'],['战车','chariot'],['怪兽/英雄','monster']]).map(([name,type])=>[name,...ARMY_SCALES.map(s=>unitModels(type,s))]))}
## 单体生命

单体人数保持 1，最大生命按 4× 生命乘规模/4；伤害、护甲、质量、速度不随规模改变。多人队只改变人数，个人生命不变；1× 的战车虽然只剩一辆，仍按多人编制缩人数，不再次缩个人生命。负伤阈值、生命条、战损士气、全军战力估计均按当局实际最大生命计算。

${table(['单位',...ARMY_SCALES.map(s=>`${s}×生命`)],units.filter(d=>d.models===1).map(d=>[d.name,...ARMY_SCALES.map(s=>scaledFormation(d.type,s).hp)]))}

旧专项场景使用固定测试编制，继续保留原人数和生命以便复现。正常预设对战以本页为准。
`,
    'UNITS/ABILITIES.md': `# 冲锋与特殊能力

[返回单位目录](../UNITS.md)。反大型、冲锋防御和冲锋反制是独立属性，不能相互推导。

${table(['名称','冲锋防御','冲锋反制','动能碰撞威力/人数','碰撞攻击 间隔秒/人数/武器倍率','负伤阈值/伤害/常速','鼓舞','将军','恐惧','惊骇'],units.map(d=>[d.name,({none:'无',large:'抵御大型',all:'抵御全部'})[d.chargeDefense],yes(d.chargeReflection),`${d.impactPower}/${d.cleave}`,d.collisionAttack?`${d.collisionAttack.interval}/${d.collisionAttack.targets}/${d.collisionAttack.damage}`:'无',d.wounds?`${pct(d.wounds.threshold)}/${pct(d.wounds.damage)}/${pct(d.wounds.speed)}`:'无',d.encourage,yes(d.commander),yes(d.causesFear),yes(d.causesTerror)]))}
动能碰撞要求更大的物理体型和超过 5 米/秒的迎面速度，按质量/速度计算；碰撞攻击另用武器伤害、自己的冷却与人数上限，即使陷入低速也可触发，不消耗普通挥击冷却。触发与近似边界见规则。

恐惧是范围士气惩罚，不叠加；惊骇需实际造成正伤害后检查低士气。成功触发的来源单位进入 30 秒冷却，不能再惊骇其他目标；受害者不获得此冷却。冷却期间恐惧光环仍生效，详情显示来源自身的惊骇就绪/剩余秒数。30 秒是本作当前配置，详见规则。

单体负伤在生命不高于阈值时触发，本场永久保留，治疗不会解除；降低基础/破甲武器伤害和普通移动速度，冲锋速度不受负伤减速。

当前兵种的物理、远程、火焰、法术、特保抗性均为 0，免疫心理和永不溃败均为否。这些属性已进入引擎并有测试，但本版没有配套魔法、火焰弹药或不死族崩解系统。
`,
  }
  await mkdir('UNITS', { recursive: true })
  for (const [path, content] of Object.entries(docs)) {
    if (process.argv.includes('--check')) {
      const existing = await readFile(path, 'utf8').catch(() => '')
      if (existing.replaceAll('\r\n', '\n') !== content) throw new Error(`${path} 已过期；运行 npm run docs:units`)
    } else await writeFile(path, content)
  }
  console.log(process.argv.includes('--check') ? 'Unit documentation matches source.' : 'Generated UNITS.md and UNITS/*.md.')
} finally { await server.close() }
