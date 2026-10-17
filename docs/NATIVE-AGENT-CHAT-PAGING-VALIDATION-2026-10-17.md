# Native 会话分页与刷新：Windows 本机验证

日期：2026-10-17。代码基线：`main@b1377d7f59916fabc3690eaeedc7b97eab3e41bb`。

依据：[原静态分析](NATIVE-AGENT-CHAT-PAGING-ANALYSIS.md)。本报告记录实际运行结果；未修改原分析文档或产品源码。

## 结论

在真实 Windows Electron 桌面窗口中复现了以下三条路径：

1. **首屏未溢出时，顶部滚轮无法触发自动分页。** 相同历史点击“查看更早消息”能正常加载。
2. **读取旧页时收到临时空且 incomplete 的结果，会清空更早游标。** 已显示消息保留，但更早入口消失；界面显示记录不完整提示和重试入口，没有分页异常。此项通过隔离文件故障注入验证，未声称自然并发竞争已发生。
3. **长历史触及前端容量上限后裁掉尾部；之后新消息已到权威快照，当前历史列表仍不追加。** “跳到最新消息”可以恢复显示。

另外，独立进程中的真实投影实现测量确认：新增记录会全量重放、重写展示文件，耗时随历史增长；每个 text_delta 都会调用一次 snapshot 并发送一次 changed 通知。

原分析的裁剪方向、snapshot 计时判据、磁盘同步瓶颈判断，以及“按钮消失且无开头提示”的判断方式需要修正，详见后文。

## 环境和证据范围

- Windows x64，本机 Intel Core i7-13700KF。
- 本次重新执行 `npm run build`，成功后启动当前代码的真实 Electron 44.4.3 窗口，非浏览器替代页面。Electron 内置 Node 24.21.0、Chromium 152.0.7977.130。
- 系统工作区尺寸 2560 × 1392；最大化窗口的页面视口 2560 × 1369，DPR 1。
- 独立性能脚本使用本机 Node 24.14.0，与 Electron 内置 Node 分开计量。
- 启动时启用 `CC_DESK_CHAT_PERF=1`、`WORKBENCH_TEST_MODE=1`；数据目录为本机 `test-results/paging-validation/data`。
- 长历史由正式 `NativeRunStore` 的 beginRun、model_response、tool_prepared、tool_completed、run_finished 接口写入并校验，再用正式 NativeProjection 生成展示文件。工具记录属于离线装置，没有实际执行这些工具。
- 压力装置没有经过模型服务和执行输入预算的准入，界面显示其上下文超过默认预算；它用于验证展示容量边界，不代表当前默认预算允许真实执行这样大的单回合。
- 另复制默认工作区的一份现有 Native 历史作为对照，未复制凭据、模型连接、待发送队列或工作流。原工作区不用于写入验证。
- UI 使用真实生产 IPC/读取实现；仅在 IPC handler 外包装计数和计时，没有伪造分页返回值。通过 Windows 原生输入验证滚轮与按钮；其余读取由 Playwright Electron 获取 DOM 和 IPC 数值。
- 未向外部模型发送请求。本结果不代表真实模型速度、打包安装验收或所有并发竞争场景均已覆盖。

## 1. 首屏不足一屏

装置 A：36 个折叠工具，每个输入 detail 为 20,000 个 ASCII 字符，输出约 256 KiB，另有用户消息和最终短答复，共 38 条展示消息。

在最大化窗口稳定加载后再开始计数，排除窗口调整产生的滚动和已取消请求：

| 操作 | 结果 |
| --- | --- |
| 首次真实 display IPC | 8 条，232,079 bytes，约 2.03 ms；before 非空 |
| 权威 snapshot IPC | 8 条，1,978,853 bytes，约 430.38 ms |
| 对话区域 | scrollHeight = clientHeight = 804，scrollTop = 0 |
| Windows 原生向上滚轮 | wheel 计数 1，scroll 计数 0 |
| 滚轮后再观察 1.2 秒 | display 请求仍仅 1 次；仍显示 8 条 |
| 手动点击“查看更早消息” | 返回 30 条旧消息，约 32.52 ms；合并后 38 条 |

这证明问题位于自动触发条件：既有更早游标，也有实际可读取的历史，滚轮没有产生触发分页所需的 scroll 事件。

截图：[首屏不足](../test-results/paging-validation/01-native-underfilled.png)、[滚轮后未加载](../test-results/paging-validation/02-native-wheel-no-load.png)、[手动加载成功](../test-results/paging-validation/03-native-manual-earlier.png)。

## 2. 临时空页清空游标

装置 B：110 个工具，每个输入 detail 为 20,000 个 ASCII 字符，输出约 64 KiB，另有用户消息和最终答复，共 112 条。首屏 display 为 8 条；权威快照为 25 条，合并不会向前补齐缺少的早期消息。

正常首屏稳定后，在隔离目录短暂改名该会话的 `.jsonl` 文件，再点击“查看更早消息”。等待真实 IPC 返回后，立即在 finally 中恢复文件。

实测结果：

- 请求携带有效 before 锚点。
- 返回 `messages: []`、`before: null`、`after: null`、`incomplete: true`，167 bytes。
- 列表仍保留原 8 条，但“查看更早消息”按钮消失。
- 没有 `.chat-error`，也没有“已到本地保留记录的开头”提示。
- 因 incomplete 为 true，界面仍显示“部分会话记录暂时无法完整显示”的提示和“重试读取记录”按钮，不应将此结果描述为完全无提示或没有恢复入口。
- 文件恢复后的 SHA-256 与故障注入前一致；重新载入后更早入口恢复。

这是**文件短暂不可用的受控故障验证**，不是自然触发 Windows rename/EPERM 竞争的证据。

截图：[临时空页导致游标丢失](../test-results/paging-validation/04-native-empty-page-lost-cursor.png)。

## 3. 长历史裁剪与新消息

恢复装置 B 后重新打开，连续手动读取更早页：

| 旧页请求 | 返回旧消息 | 合并后消息数 |
| --- | ---: | ---: |
| 第 1 页 | 31 | 39 |
| 第 2 页 | 31 | 70 |
| 第 3 页 | 31 | 95 |
| 第 4 页 | 11 | 102 |

完整历史原有 112 条，最终只保留 102 条。列表滚到其底部时，最后挂载的消息为 `fixture-tool-100`，而真实尾部还有 tool-101 至 tool-109 和最终答复；“跳到最新消息”按钮可见。

随后通过正式账本接口离线写入一个新的已完成回合，新增用户消息和唯一助手消息 `PAGING_LIVE_UPDATE_LOCAL_ONLY_20261017`。没有调用模型或执行工具。显式请求正式 snapshot 以发现磁盘变化，投影重建发出的真实 changed 通知又触发了 UI 的快照刷新。

- 最新权威 snapshot 共 27 条，包含新增助手消息。
- UI 当前列表仍为 102 条，停在 tool-100，新增助手消息没有挂载；列表已位于自身底部。
- 点击“跳到最新消息”后，尾页先返回 10 条，随后又触发一次 31 条旧页读取；稳定后列表共 41 条，虚拟列表挂载 10 行。新增助手消息可见，更早入口仍可用。

这验证了“列表脱离尾部后不追加”的前端行为。新增记录是受控本地写入，不应表述为已复现真实模型网络流式执行。

截图：[旧页裁剪后](../test-results/paging-validation/05-native-long-history.png)、[快照已更新但当前列表不追加](../test-results/paging-validation/06-native-detached-new-message.png)、[跳到最新后恢复](../test-results/paging-validation/07-native-jump-latest.png)。

## 4. 现有 Native 历史副本对照

默认工作区现有 Native 会话副本读取结果：

- display 34 条，124,495 bytes，约 2.59 ms。
- snapshot 34 条，184,535 bytes，约 40.26 ms。
- 对话区域 scrollHeight 4700、clientHeight 804，具有真实滚动空间。
- 原生向上滚轮先移动了一个视口；随后明确设置真实 DOM 的 scrollTop = 0，以确定触发顶部路径。自动发出了 before 分页请求。
- 该请求返回空页且 `incomplete: false`，说明已经达到此副本的记录开头；更早按钮消失，列表仍为 34 条。

因此，已有较短历史的正常结束路径不能复现装置 B 的游标丢失故障，也不能据此否定重工具长历史问题。这里还发现：**正常读到开头同样没有“已到本地保留记录的开头”提示**，所以仅凭“按钮消失而没有提示”不能判定记录损坏，必须同时检查 IPC 的 incomplete、已知历史范围和游标。

## 5. 投影性能测量

独立 Node 进程运行实际 NativeProjection 和 NativeRunStore，合成助手消息，使用进程内计数器观测 replay、文件写入、同步读取、clone 和通知。每组冷 hydrate、追加后 hydrate 各采样 3 次，下表为中位数；使用热 OS 缓存，包含本机背景负载和插桩开销。

| 单条正文 | 账本记录数 | 冷 hydrate | 新增一条后的 hydrate |
| --- | ---: | ---: | ---: |
| 约 512 B | 50 | 9.587 ms | 9.247 ms |
| 约 512 B | 250 | 23.903 ms | 22.894 ms |
| 约 512 B | 1000 | 78.006 ms | 78.202 ms |
| 约 8 KiB | 50 | 12.595 ms | 12.703 ms |
| 约 8 KiB | 250 | 41.881 ms | 44.557 ms |
| 约 8 KiB | 1000 | 147.807 ms | 148.641 ms |

观测到：

- 每次新增后均从 `replay(0)` 重放整份账本，并重写展示文件，文件 ino 每次改变。1000 条基线场景的一次追加采样达到 1002 条，产生 2004 次逐行 write 调用，同步重读约 8.62 MB。
- 同 head 连续 20 次 hydrate 均为 0 次 replay、0 次写入，总耗时约 0.02–0.10 ms；不能把所有 hydrate 都算作重建。
- 每组向活动投影注入 200 个合法身份的 text_delta，产生恰好 200 次 snapshot 和 200 次 changed；约 2 MiB 快照场景共约 164–172 ms。这里单位是 delta/chunk，不一定等于模型 token。
- 本机每次 `sync()` 约 0.65–2.87 ms。最大场景逐行异步写入累计约 44 ms，replay/克隆约 17 ms，整体约 149 ms。数据不支持把 FlushFileBuffers 直接认定为主要瓶颈。

这些是实际后端实现的独立进程测量，不包含 Electron 渲染、完整 IPC 和真实模型等待，不可与前面的 UI IPC 耗时直接相减比较。

## 对原分析的修正和未覆盖项

1. `mergeDisplayPage(direction='before')` 超上限时**总是从尾部裁剪**，与 protectHistory 无关；原文“一.4”的该分支描述需要修正。
2. 执行中的 snapshot hydrate 会直接返回，静止且同 head 也不重放。因此 `operation: snapshot` 的 elapsedMs **不能单独证明或排除投影重建增长**。应配合 replay/write 次数、文件身份及单独的重建计时。
3. “每个 token”宜改为“每个 text_delta/chunk”；此次验证的是事件数量。
4. Windows `sync()` 是开销之一，但本机测量未支持其为主要瓶颈。
5. “更早按钮消失且没有开头提示”不是故障的充分条件，现有历史正常结束时也有相同行为。
6. 未主动制造自然并发 rename/EPERM、读取中替换身份、锚点消失，以及连续两次快照失败后的恢复。它们仍属待独立验证路径。

修复优先级仍可保持：先补“不溢出时自动补页/顶部滚轮”及“临时空页保留游标或报可重试错误”，同时消除 changed 中的快照复制并合并 delta 通知；随后处理长历史的增量投影与较新页导航。

## 本机产物

下列产物保存在 Git 忽略目录，仅在本机存在，未提交到仓库：

- [UI 数值和请求记录](../test-results/paging-validation/ui-results.json)
- [真实 Electron chat-load 日志](../test-results/paging-validation/electron-chat-load.log)
- [后端性能完整 JSON](../test-results/paging-validation/projection-bench.json)
- [合法长历史生成脚本](../test-results/paging-validation/prepare.ts)
- [追加验证消息脚本](../test-results/paging-validation/append-update.ts)
- [后端性能复运行脚本](../test-results/paging-validation/projection-bench.mts)

实机隔离窗口保留打开，停在装置 A 的 8 条首屏，便于手动复核。产品源码和原工作区未修改；本次构建成功，未重跑完整测试套件，未提交或推送。
