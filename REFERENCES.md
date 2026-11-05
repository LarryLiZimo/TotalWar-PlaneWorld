# 战锤 3 依据与仍有差别的部分

核对日期 2026-11-04。以下是机制依据，不代表本作数值或全部实现与该补丁完全一致。

| 来源 | 已据此处理 |
| --- | --- |
| [CA Damage Part 1](https://community.creative-assembly.com/total-war/total-war-warhammer/blogs/6-feature-focus-2-damage-part-1) | 命中上下限、个人四象限近防、护甲随机减伤、13 秒冲锋、反制短窗与抗性通道 |
| [CA 5.1](https://community.creative-assembly.com/total-war/total-war-warhammer/blogs/23-total-war-warhammer-iii-patch-5-1-0) | 碰撞攻击独立冷却/目标数，与普通溅射预算分开 |
| [CA 5.3 战斗说明](https://community.creative-assembly.com/total-war/total-war-warhammer/forums/7-total-war-warhammer/threads/7586-total-war-warhammer-iii-patch-5-3-0-battle-balance-details) | 攻击区域、穿透、身体拦截；具体动画/弹药仍用本作配置 |
| [CA 6.0.1](https://community.creative-assembly.com/total-war/total-war-warhammer/forums/7-patch-notes-amp-announcements/threads/8337-total-war-warhammer-iii-hotfix-6-0-1) | 溅射目标数与体型限制的重要性 |
| [CA Elevation](https://community.creative-assembly.com/total-war/total-war-warhammer/blogs/11-feature-focus-1-elevation) | 坡速、上坡耗力、高差伤害 |
| [引擎脚本 API 文档镜像](https://chadvandy.github.io/tw_modding_resources/WH3/battle/battle_unit.html) | 六档疲劳、动摇/溃逃/彻底溃散、永不溃败等状态结构 |
| [疲劳数据库实测](https://steamcommunity.com/sharedfiles/filedetails/?id=3248981123)、[AP 疲劳报告](https://community.creative-assembly.com/total-war/total-war-warhammer/bugs/13463-ap-melee-weapon-strength-reduction-from-fatigue-not-displaying-on-unit-card) | 疲劳分项惩罚；具体阈值/速率仍可校准 |
| [负伤数据库示例](https://twdatabase.com/units/the-changeling)、[2.0 更新记录](https://totalwarwarhammer.fandom.com/wiki/Update_2.0) | 25% 阈值、伤害/普通速度下降、治疗后本场保留；后者是社区转录，非独立官方验证 |

仍有差别：原作逐动画接敌与击倒状态、完整战力和士气条件、原版单位/弹药数据库、复杂地形、法术与种族特性未全部复制。动能公式、列阵质量插值、二维攻击动作、散布、士气阈值与活动耗力是明确标注的本作近似；友伤安全区则保留用户指定设计。测试保证这些已写出的行为可回归，不等于已证明与原版逐帧一致。

本文件保留既有核对结果，不代表本轮重新检索了外部资料。现行采用的规则以 [RULES.md](RULES.md) 为准；具体兵种值见 [UNITS.md](UNITS.md)，实现近似见 [ARCHITECTURE.md](ARCHITECTURE.md)，验证边界见 [TESTING.md](TESTING.md)。
