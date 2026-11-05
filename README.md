# 平原四兵

俯视二维实时会战。每个兵模独立移动、碰撞和攻击，玩家以部队为单位下令。

## 从哪里开始读

| 你想了解什么 | 文档 |
| --- | --- |
| 战斗怎样运作，各种属性是什么意思 | [RULES.md](RULES.md)：对象 → 命令 → 移动接触 → 战斗 → 状态 → 胜负 |
| 怎样选择、拖线、下令和查看信息 | [CONTROLS.md](CONTROLS.md) |
| 程序怎样组织与执行规则 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 每种兵的数值与能力配置 | [UNITS.md](UNITS.md) 与生成的 UNITS 子目录 |
| 军队预设、规模、地图和复现场景 | [BATTLEFIELDS.md](BATTLEFIELDS.md)、[军队编成表](UNITS/ARMIES.md) |
| 怎样自动测试、复现和定位问题 | [TESTING.md](TESTING.md) |
| 历史验证、性能测量与容量限制 | [reports/README.md](reports/README.md) |
| 战锤 3 的历史机制依据与差异 | [REFERENCES.md](REFERENCES.md) |
| 尚未完成的工作 | [TODO.md](TODO.md) |

规则与内容分别维护：例如“反大型怎样生效”在规则，“某队拥有多少反大型”在单位资料。算法、线程和绘图放在技术结构中，历史进度不再混入规则。

## 运行

```bash
npm install
npm run dev
```

打开 http://127.0.0.1:5173/ 。从十套军队中选择双方预设与规模后开始，默认 4×。共享兵表共 39 种，完整数值见 [UNITS.md](UNITS.md)，帝国模板与取舍见 [ROSTER-DESIGN.md](ROSTER-DESIGN.md)。左键选择、右键移动或攻击、右键拖线设置战线；新命令默认跑步，R 切换走路。双击底部兵牌定位部队，P 暂停。完整操作见 [CONTROLS.md](CONTROLS.md)。

## 检查与迭代

```bash
npm run check               # 类型/构建、全部测试、生产 Worker、单位文档一致性
npm run test:regression     # 既有问题与机制快速回归
npm run test:watch          # 持续迭代
npm run test:worker         # 真实 Worker 消息检查
npm run bench              # 无界面性能报告
npm run profile -- melee 90 # 采样第 90 秒之后的混战
npm run balance            # 固定种子兵种对抗
npm run docs:units         # 单位配置变更后生成资料
```

默认模拟在独立 Worker 中运行，画面使用显示插值；无界面测试可直接创建小场景验证行为。测试数量以实际输出为准，性能需同时看模拟实际倍速和画面帧时间，具体步骤见 [TESTING.md](TESTING.md)。
