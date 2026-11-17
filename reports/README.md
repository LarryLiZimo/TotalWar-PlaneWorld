# 验证资料与报告

这里只保留仍能对应当前代码的验证输出，回答“最近测到了什么、证据在哪里”。它们不是游戏规则，也不代表每次代码变更后都重新验收。当前规则见 [RULES.md](../RULES.md)，实现结构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，测试方法与覆盖范围见 [TESTING.md](../TESTING.md)，后续工作见 [TODO.md](../TODO.md)。

2026-11-05 清理了旧报告：11-04 的阶段截图（界面已改）、Worker 与共享图集之前的性能调查 / 深度 Profile / 修复报告、Vite SSR 时代的基准与 CPU 采样、只覆盖旧兵种的平衡样本，以及配套的本地 `.cpuprofile` 和冻结副本。需要追溯时，可在提交 `8a0f9b8` 及更早的 Git 历史中查看。

## 现有文件

| 文件 | 内容 | 生成方式 |
| --- | --- | --- |
| [worker-check.json](worker-check.json) | 生产构建的真实 Worker：初始化、命令、单步、改宽、缓冲回收与复用计数、权威快照、8× 预设、5× 下自动收到决胜帧，共 10 项 | `npm run test:worker` |
| [benchmark.json](benchmark.json) | 15 个固定场景的无界面模拟吞吐，计时打包后的模拟代码 | `npm run bench` |
| [render-flicker-fix.json](render-flicker-fix.json) | 主画布整屏闪烁的诊断与修复验证（同步、不透明 2D 上下文） | 浏览器实测记录 |
| [roster-validation.json](roster-validation.json) | 帝国兵表合并（18 → 39 种单位、10 套预设）时的构建、测试、Worker 与文档检查 | 合并时记录 |

`npm run profile -- latest` 与 `npm run balance` 运行时会在本目录写入新报告；它们不再随仓库提交旧结果。

## 性能记录与容量限制

固定步为 50 ms。一倍速平均每步预算约 50 ms，2× 约 25 ms，5× 约 10 ms；单个重步超过预算时，Worker 只能避免阻塞主线程，不能保证模拟满速。无界面吞吐不含 Canvas 绘制，不能换算成 FPS；F3 的绘制耗时只是 JS 提交，不含全部 GPU 进程与呈现时间。

2026-11-05 移除地形（`hill` 场景随之删除）、统一寻敌与冲撞门槛后的基准（每场景前 30 秒、600 步，种子 42，打包代码）：

| 场景 | 模型数 | 平均 / P95 / 最大 ms | 实时余量 |
| --- | --- | --- | --- |
| 4× 经典对推进（`custom`） | 2840 | 11.16 / 18.48 / 72.96 | 4.5× |
| 完整会战（`demo`） | 1974 | 6.41 / 8.53 / 27.27 | 7.8× |
| 4× 行省征召对信仰远征 | 2648 | 7.47 / 9.96 / 39.08 | 6.7× |
| 4× 黑火药战线对骑士突击 | 2070 | 9.49 / 13.99 / 25.71 | 5.3× |
| 4× 机动战车对巨兽卫队 | 1270 | 4.09 / 5.72 / 17.83 | 12.2× |

同一台机器上连跑两次，单场平均可相差 10～25%（首轮含 JIT 预热），比较时以多次运行为准。

全部场景无状态异常，完整数据见 [benchmark.json](benchmark.json)。旧报告来自 Vite SSR 模块（约慢 1.4 倍），又早于本轮查询优化，不能与此表计算提速比例。峰值包含 JIT 和垃圾回收。

尚无当前代码的浏览器帧率记录。旧的 8× 浏览器窗口曾测得模拟单步明显超过 50 ms、实际倍速低于 1×，该结论来自已删除的旧版本，现在 8× 是否满速流畅需要重新实测。

## 后续优化与框架选择

现有实现仍有可识别的算法与数据布局优化空间，尚不能把最大规模卡顿归因于“框架已到上限”。先在相同种子、相同交战状态和同一设备定位慢项，再决定迁移范围；提高模拟频率、增加 Worker 数量或直接换引擎都不能自动消除重复扫描。

1. 在实际 DPI 与视野下测量帧间隔、长帧、缓存命中、栅格化与合成，比较 DPR 1 / 1.5 / 2。
2. 继续收紧选敌、遮挡复验与碰撞活动集合，再调整数据布局；必须保留远处后备实际参战、实体阻挡和确定性。
3. 用相同状态重新测量 4× / 8× 模拟吞吐、实际倍速、帧 P95 与长帧，只保留可追溯的报告。

已评估、尚未实施的迁移方向（均未做同场景移植基准）：

| 方向 | 适用范围与限制 | 资料 |
| --- | --- | --- |
| 浏览器显示层改为 PixiJS | GPU 批绘制减少逐模型 Canvas 调用；不能单独解决超预算的模拟步 | [渲染循环](https://pixijs.com/8.x/guides/concepts/render-loop)、[性能说明](https://pixijs.com/8.x/guides/concepts/performance-tips) |
| 原生桌面 Bevy/Rust ECS | 面向 8× 及更大规模；可评估数据布局、阶段并行与实例化显示，迁移量最大 | [ECS](https://bevy.org/learn/quick-start/getting-started/ecs/)、[并行查询分批](https://docs.rs/bevy/latest/bevy/ecs/batching/struct.BatchingStrategy.html)、[精灵压力示例](https://bevy.org/examples-webgpu/stress-tests/many-sprites/) |
| Godot + GDExtension/C++ 模拟 + MultiMesh | 需要编辑器时的方向；密集模拟应走原生扩展和批量显示 | [MultiMesh](https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html)、[线程接口](https://docs.godotengine.org/en/stable/tutorials/performance/thread_safe_apis.html) |

兵种数值与十套预设仍为初稿，未按费用配平；实力条的权重与阈值也是待校准的模板参数。RL 对战 AI、地形（暂已移除，战场为平地）与全局寻路、飞行、炮兵、攻城、魔法等仍未开始，待办见 [TODO.md](../TODO.md)。
