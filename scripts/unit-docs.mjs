import { createServer } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const { UNITS } = await server.ssrLoadModule('/src/sim/units.ts')
  const { collisionRadius } = await server.ssrLoadModule('/src/sim/physics.ts')
  const { MECHANICS } = await server.ssrLoadModule('/src/sim/mechanics.ts')
  const { ARMIES,ARMY_SCALES,unitModels,scaledFormation,armySummary } = await server.ssrLoadModule('/src/sim/armies.ts')
  const units = Object.values(UNITS)
  const armyCount = Object.keys(ARMIES).length
  const categories = { infantry:'步兵', ranged:'远程步兵', cavalry:'骑兵', chariot:'战车', monstrousInfantry:'怪兽步兵', monster:'怪兽' }
  const weapons = { spear:'长矛', sword:'刀盾/剑', greatsword:'巨剑', bow:'弓/弩', musket:'火枪', halberd:'戟', claws:'双爪' }
  const sizes = ['极小','步行','骑乘','怪步/战车','巨兽']
  const yes = value => value ? '是' : '否'
  const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n') + '\n'
  const n = value => Number(value.toFixed(2))
  const pct = value => `${Math.round(value * 100)}%`
  const docs = {
    'UNITS.md': `# 单位目录

本目录只记录具体兵种的编制、数值和能力归属。属性与能力怎样运作，见 [RULES.md](RULES.md)；操作见 [CONTROLS.md](CONTROLS.md)，战场预设见 [BATTLEFIELDS.md](BATTLEFIELDS.md)。

本页和 UNITS 子目录由 \`npm run docs:units\` 从单位、军队和通用机制配置生成；改数值后重新生成，\`npm run docs:check\` 检查一致性。生成方式见 [ARCHITECTURE.md](ARCHITECTURE.md#文档与配置怎样保持一致)。

编制与生命以默认 4× 标准规模为准，生命按每个兵模计。数值是本作平衡初稿，参考战锤的兵种定位，不是战锤 3 某补丁的数据复制。

- [近战、护甲与攻击动作](UNITS/COMBAT.md)
- [队形、移动与身体](UNITS/MOVEMENT.md)
- [射击、散布与穿透](UNITS/RANGED.md)
- [冲锋防御、碰撞攻击与特殊能力](UNITS/ABILITIES.md)
- [预设军队与规模换算](UNITS/ARMIES.md)
- [帝国模板设计与来源](ROSTER-DESIGN.md)

## 编制与定位

${table(['代码','名称','类别','预算点','4×人数','4×单人生命','武器','反体型分类','定位'],units.map(d=>[d.type,d.name,categories[d.category],d.cost,unitModels(d.type,4),d.hp,weapons[d.weapon],d.large?'大型':'小型',d.role]))}

“类别”“大型 / 小型”“物理体型”和“质量”分别定义，不能从其中一项推导其他项。含义见[对象与属性](RULES.md#一战场中的对象与属性)。

现有 ${units.length} 种共享兵种、${armyCount} 套预设。预算点按标准规模的每队编制给出，在同倍率下比较组合，不随规模另乘；界面不设预算上限，预设尚未按同点数配平。旧完整会战与固定复现场景沿用各自模板，见[战场配置](BATTLEFIELDS.md)。
`,
    'UNITS/COMBAT.md': `# 战斗属性与攻击动作

[返回单位目录](../UNITS.md)。本页列具体配置；命中、伤害、冲锋与群攻的作用方式见[近战规则](../RULES.md#四近战冲锋与伤害)。

“攻 / 防”是近战攻击 / 防御；“不破甲 / 破甲”是一击的两部分武器预算；“反大 / 反步攻 / 威”分别是对相应标签目标增加的近攻 / 武器威力。间隔单位秒，外伸单位米。

${table(['名称','攻','防','甲','不破甲/破甲','间隔秒','外伸米','冲锋','反大攻/威','反步攻/威','盾牌','领导力','最多目标'],units.map(d=>[d.name,d.meleeAttack,d.meleeDefense,d.armor,`${d.weaponBase}/${d.weaponAp}`,d.meleeInterval,d.reach,d.chargeBonus,`${d.antiLargeMa}/${d.antiLargeWs}`,`${d.antiInfantryMa}/${d.antiInfantryWs}`,pct(d.shieldBlock),d.leadership,d.splash]))}

## 二维攻击动作

${table(['名称','前摇秒','最短恢复秒','完整攻击角度','可群攻最大体型'],units.map(d=>[d.name,d.attack.windup,d.attack.recovery,d.attack.arc,`${d.attack.splashMaxSize} ${sizes[d.attack.splashMaxSize]}`]))}

前摇、恢复和攻击间隔的时间关系见[一次普通攻击](../RULES.md#1-一次普通攻击怎样发生)；最多目标数和可群攻体型见[群攻规则](../RULES.md#6-群攻不是每个目标都吃一整份伤害)。外伸按身体边缘计算，是本作二维武器接触距离，不是原作面板射程；尚未导入逐动画武器轨迹。
`,
    'UNITS/MOVEMENT.md': `# 队形、移动与身体

[返回单位目录](../UNITS.md)。距离单位米、速度单位米/秒；列 / 排为横向 / 纵深人数，“行进”是基础跑速。队形与身体接触的含义见[移动规则](../RULES.md#三移动队形与身体接触)。

${table(['名称','4×列/排','最宽列','最深排','列距/排距','行进/冲锋','视觉半径/长度','友军移动半径/长度','物理体型','身高','质量','穿透阻力','可列阵'],units.map(d=>[d.name,`${scaledFormation(d.type,4).files}/${Math.ceil(unitModels(d.type,4)/scaledFormation(d.type,4).files)}`,d.maxFiles,d.maxRanks,`${d.spacing}/${d.rankSpacing}`,`${d.speed}/${d.chargeSpeed}`,`${d.radius}/${d.length}`,`${n(collisionRadius(d))}/${n(d.length*MECHANICS.collisionRadiusScale)}`,d.physicalSize,d.bodyHeight,d.mass,d.penetrationResistance,yes(d.canBrace)]))}

“最宽列 / 最深排”按 4× 人数配置；部署人数多于 4× 的部队两者都乘 √(部署人数 ÷ 4× 人数) 再取整，保持相同的宽深比例范围，默认部署排数也按同一系数加深，见[队形规则](../RULES.md#1-队形怎样形成与恢复)。

表中较细移动尺寸用于友军通行；普通敌对身体使用完整视觉 / 战斗尺寸，不能挤过完整敌阵。战车牵引与碾压沿用其专用较细碰撞体。物理体型、身高、质量、穿透阻力分别配置；只有物理体型不超过 1 的身体会被冲撞撞倒，更大的只被推开（[碰撞规则](../RULES.md#7-动能冲撞碰撞攻击和击倒)）。柔性层、友军通过与地面阻力见[身体接触](../RULES.md#4-碰撞柔性与地面阻力)，胶囊 / 圆柱与接触算法见[技术结构](../ARCHITECTURE.md#运动几何与战斗几何)。

## 转向

${table(['名称','最快度/秒','加速度度/秒²','转弯半径米','原地度/秒'],units.map(d=>[d.name,n(d.turnCap*180/Math.PI),n(d.turnAccel*180/Math.PI),d.turnRadius,n(d.pivotRate*180/Math.PI)]))}

转向表是各兵种配置；战车前进转弯的行为见[移动与转向](../RULES.md#2-怎样前进与转向)，转弯圆 / 切线路径及数值容差见[实现说明](../ARCHITECTURE.md#队形与个人运动)。
`,
    'UNITS/RANGED.md': `# 射击、散布与穿透

[返回单位目录](../UNITS.md)。本页列具体武器和弹药配置，射击条件、弹丸、盾牌和友伤见[射击规则](../RULES.md#五射击与弹丸)。

威力分不破甲 / 破甲，装填单位秒，距离单位米，角度单位度。弹药按轮计，全队打完后自动转为近战模式；威力按单发计，“每轮弹丸”列为每次装填发出的弹丸数。穿透预算决定途中还能穿过多少身体阻力；“穿透后伤害”为继续飞行时保留的倍率；“反大型额伤”只作用于命中大型目标的弹丸。

${table(['名称','不破甲/破甲','装填秒','射程米','射界度','弹药','弹速米/秒','角度散布','校准距离/半径米','反大型额伤','每轮弹丸','穿透预算','穿透后伤害','移动开火','弹道'],units.filter(d=>d.missile).map(d=>{const m=d.missile;return [d.name,`${m.base}/${m.ap}`,m.reload,m.range,m.cone,m.ammo,m.speed,`±${m.spread}°`,`${m.calibrationDistance}/${m.calibrationRadius}`,m.bonusVsLarge??0,m.shotsPerVolley??1,m.penetration,pct(m.penetrationDamage),yes(m.fireWhileMoving),m.arc?'弧线':'火枪']}))}

“校准距离 / 半径”定义散布圆随距离的变化，见[弹丸规则](../RULES.md#2-弹丸怎样飞行与命中)。本作枪口安全区与末端友伤范围见[友伤规则](../RULES.md#4-友军遮挡与友伤)。
`,
    'UNITS/ARMIES.md': `# ${armyCount} 套预设军队与规模

[返回单位目录](../UNITS.md)。本页只列军队编成与规模换算，选择方法见 [CONTROLS.md](../CONTROLS.md#开始与重开)，地图与部署见 [BATTLEFIELDS.md](../BATTLEFIELDS.md)。每套均为 15 队，表中预算点用于比较，尚未按同点数配平。

${table(['代码','军队','编成','4×模型总数','预算点'],Object.entries(ARMIES).map(([id,a])=>[id,a.name,a.units.map(([type,count])=>`${count} ${UNITS[type].name}`).join('、'),armySummary(id,4).models,armySummary(id,4).budget]))}

## 每队人数

${table(['类型',...ARMY_SCALES.map(s=>`${s}×`)],([['步兵','sword'],['骑兵/骑射','heavyCavalry'],['远程步兵','archer'],['铁甲火枪','ironsides'],['长管步枪/半狮鹫','longRifle'],['怪步','ogre'],['战车','chariot'],['怪兽/英雄','monster']]).map(([name,type])=>[name,...ARMY_SCALES.map(s=>unitModels(type,s))]))}

## 单体生命

以下为各单体在不同规模的个人最大生命；攻击、护甲、质量和速度不随规模改变。缩放规则与负伤阈值见[单体与规模](../RULES.md#2-单体负伤)。

${table(['单位',...ARMY_SCALES.map(s=>`${s}×生命`)],units.filter(d=>d.models===1).map(d=>[d.name,...ARMY_SCALES.map(s=>scaledFormation(d.type,s).hp)]))}

多人编制按规模改变人数、个人生命不变。1× 战车虽然只剩一辆，仍按多人模板缩人数，不再次缩个人生命。固定复现场景沿用自己的模板，不套用本表的对战规模。
`,
    'UNITS/ABILITIES.md': `# 冲锋与特殊能力

[返回单位目录](../UNITS.md)。本页列能力归属和具体值，通用定义见 [RULES.md](../RULES.md)。反大型、冲锋防御和冲锋反制是独立属性，不能相互推导。

碰撞攻击列为间隔秒 / 每次最多目标数 / 武器倍率，冲锋或攻击中自己撞上敌人、迎面相对速度达到自身有效冲锋速度的 ${pct(MECHANICS.speedThreshold)}（[速度门槛](../RULES.md#3-冲锋何时生效)）时发动，伤害随速度比增加、以冲锋速度撞上时为满额，撞击伤害只来自它；动能冲撞本身不造成伤害，只按物理体型与质量推挤、击倒，没有单独的单位数值。负伤列为触发生命比例 / 剩余伤害倍率 / 剩余普通速度倍率。

${table(['名称','冲锋防御','冲锋反制','碰撞攻击 间隔秒/人数/武器倍率','负伤阈值/伤害/常速','鼓舞','将军','恐惧','惊骇','免疫心理','永不溃逃','物/射/火/法/特抗性'],units.map(d=>[d.name,({none:'无',large:'抵御大型',all:'抵御全部'})[d.chargeDefense],yes(d.chargeReflection),d.collisionAttack?`${d.collisionAttack.interval}/${d.collisionAttack.targets}/${d.collisionAttack.damage}`:'无',d.wounds?`${pct(d.wounds.threshold)}/${pct(d.wounds.damage)}/${pct(d.wounds.speed)}`:'无',d.encourage,yes(d.commander),yes(d.causesFear),yes(d.causesTerror),yes(d.immunePsychology),yes(d.unbreakable),[d.resistances.physical,d.resistances.missile,d.resistances.fire,d.resistances.spell,d.resistances.ward].map(pct).join("/")]))}

冲锋防御与反制见[列阵规则](../RULES.md#4-站稳迎击冲锋防御与反制)，动能冲撞、碰撞攻击与击倒见[碰撞规则](../RULES.md#7-动能冲撞碰撞攻击和击倒)，恐惧和来源惊骇冷却见[心理规则](../RULES.md#2-恐惧与惊骇分别是什么)，永久负伤见[负伤规则](../RULES.md#2-单体负伤)。

鞭笞者永不溃逃且免疫心理；黑玫瑰、磐石巨兽和战斗牧师免疫心理。磐石巨兽物理抗性 15%，战斗牧师 10%，其余抗性见表。战斗牧师只有既有鼓舞、近战和抗性，没有主动法术；现有内容仍没有完整法术、火焰弹药或不死族崩解系统。
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
