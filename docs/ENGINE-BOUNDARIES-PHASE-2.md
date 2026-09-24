# 阶段二：引擎边界与并存基础

日期：2026-09-25（北京时间）。

分析基线：`dev/native-agent@b9a644fda61b8f74bf9e47cdff4f7cda35ae75b8`。

关联文档：[总体计划](NATIVE-AGENT-PLAN.md)、[阶段一验收](MONOREPO-PHASE-1-VALIDATION.md)。

状态：开发计划，尚未实施。本文中的接口名与新目录是设计建议；验收项不是已经通过的结果。此次只阅读当前源码和既有验收记录，没有运行新测试或调用模型。

## 1. 阶段目标

让桌面应用通过稳定的引擎接口调度 Claude 与后续 native：Claude 运行代码能独立成包，公共会话接口不再要求 Claude 配置，CLI 更新只影响 Claude，第二个测试引擎能够通过真实桌面服务完成会话流程。

阶段二完成后，正式应用仍默认使用 Claude Code，并保留 Shell。真实 native 模型调用、工具循环及可用入口属于阶段三；阶段二的假 native 仅用于证明边界，不能作为正式产品功能展示。

本阶段交付五项成果：

1. `packages/engine-claude`，通过宿主端口接入桌面；没有对 desktop 源码的反向引用。
2. 引擎描述、配置及校验契约，配套 workspace v3 迁移与恢复说明。
3. Claude 范围内的维护、排队暂停、工作流中断和资源释放。
4. 按引擎能力展示的会话配置、状态及历史来源。
5. Claude 回归与第二引擎并存的契约、集成、桌面及打包验收。

## 2. 已有基础与真实缺口

下列源码路径均相对于仓库根目录。

| 当前代码 | 已有基础 | 阶段二需要处理 |
| --- | --- | --- |
| `packages/contracts/src/execution.ts` | `providerId / mode / conversationId`、能力与身份比较 | 扩展引擎描述和配置契约，不另造一套 engine ID |
| `apps/desktop/src/main/execution/{ports,registry,routers}.ts` | 注册、路由、生命周期与能力检查 | `Session`、`Effort`、`PermissionMode` 仍来自 desktop；维护仅有全局接口 |
| `apps/desktop/src/main/chat-runtime.ts` | 完整 Claude 结构化执行、审批、恢复与子任务处理 | 直接引用 `StateStore`、展示历史、Claude 协议；不能作为 native 基类 |
| `apps/desktop/src/main/engines/claude/` | 已有连接、事件、能力、启动器等模块 | structured executor、transcript hydrator、terminal launcher 仍依赖桌面内部实现 |
| `apps/desktop/src/main/execution/create-executors.ts` | 集中装配执行器 | Claude terminal 与 Shell 共用同一个 `PtyExecutor / Runtime`；按注册项过滤后调用 `disconnectAll()` 仍会误停 Shell |
| `apps/desktop/src/main/session-service.ts` | 会话准入、取消、目录管理、队列和工作流 | `withDisconnectedWorkspaces()` 全局暂停；异步等待后需要按目标引擎再次检查维护状态 |
| `apps/desktop/src/main/index.ts` | CLI 检测、更新与 IPC 装配 | `terminal:write` 也受全局 `cliUpdates.assertIdle()` 限制；更新确认文案与统计覆盖全部引擎 |
| `apps/desktop/src/shared/{types,schema}.ts` | workspace v2、v1 迁移、严格会话 schema | 所有 Agent 都必须有 Claude 风格的 model/effort/permissionMode；设置缺少引擎默认值作用域 |
| `apps/desktop/src/renderer/workspace/NewSessionForm.tsx`、`SessionConfig.tsx`、`App.tsx` | 已存在部分执行能力驱动的按钮 | 创建、配置、导入、草稿默认值仍直接使用 Claude；需要贯通数据入口 |
| `apps/desktop/src/main/history.ts`、`workspace-queries.ts` | Claude transcript 查询、分页与导出 | 历史查询缺少提供方身份，不能默认所有历史都来自 Claude |
| `apps/desktop/tests/execution-contracts.test.ts` | 已通过真实 `SessionService` IPC 验证非 Claude 的发送、审批、工作流、取消和身份隔离 | 增加与 Claude/Shell 同时运行、独立配置、队列、维护竞态和旧数据验证，而非重写已有测试 |

一个必须明确的限制：现有 `directoryLocks` 保护 Git/worktree 创建、清理等管理操作；普通 `runChat()` 和终端启动没有同目录写入互斥。不能据此宣称两个 Agent 可以安全地同时修改同一工作目录。

## 3. 包边界和宿主职责

### 3.1 目标归属

| 位置 | 本阶段职责 |
| --- | --- |
| `packages/contracts` | 跨引擎身份、能力、配置封装、描述、事件、审批和最小执行接口；保持不依赖 Electron、React、Node 实现 |
| `packages/engine-claude` | `ClaudeRuntime`、CLI 能力检测与参数、连接/协议/事件、transcript 解析/导入/导出、Claude hooks 协议、Claude 专属配置定义 |
| `apps/desktop/src/main/engines/claude` | 可保留薄装配层：把桌面会话映射为 Claude 输入，连接宿主端口与标准事件，注册执行器 |
| `apps/desktop/src/main` | StateStore、展示历史、会话/队列/工作流/目录调度、Electron 通知和 IPC、CLI 更新交互、通用 PTY 生命周期 |
| `apps/desktop/src/main/engines/shell` | Shell 启动配置；不通过 Claude 运行时创建 Shell |

`ChatRuntime` 改名并归位为 `ClaudeRuntime`。`chat-protocol.ts`、`chat-import.ts`、`history.ts` 中的 Claude 部分随之迁入包；`commands.ts` 要先拆开 Claude 参数/探测与 Shell、通用环境辅助函数。共享的进程组信号、环境构造等通过小型宿主端口复用，不复制平台清理逻辑，也不为此新建大型公共包。

PTY 的 `Runtime`、`node-pty`、Windows 资源清理和 Electron 专属启动逻辑继续归 desktop。Claude terminal 适配器输出启动 spec、hooks 资源及元数据，PTY 宿主统一拥有进程、句柄与 hooks 资源的关闭责任。

### 3.2 最小宿主端口

| 端口职责 | 输入/输出范围 | 必须保留的语义 |
| --- | --- | --- |
| 会话读取与更新 | 当前会话身份、cwd、启动状态、引擎配置、允许更新的运行元数据；按需查询 transcript 来源路径 | 不暴露 `store.state` 或任意修改整个 AppState 的回调；关键写失败必须传播 |
| 展示历史与归档 | snapshot、追加事件、分页/搜索、现有缓存与错误通知 | 沿用日志路径、分页和错误语义；完整模型上下文仍由各引擎自己拥有 |
| 子任务投影 | begin/observe/end 与运行摘要 | 后台子任务仍占用父回合；持久化错误不能被通知回调吞掉 |
| 执行事件与状态通知 | 已规范化的事件和身份变化 | 主进程再转成 IPC/系统通知；renderer 观察者失败不能终止执行 |
| 展示策略和启动限制 | 首条已接受消息、所需配置与容量 getter | 自动标题仍由桌面生成，保留并发手动改名保护；不传完整 Settings |
| 平台辅助与启动上下文 | 所需环境、程序解析、进程组信号等窄操作 | 继承现有 Windows/POSIX 行为；不能在接口拆分时提前释放进程树或目录 |

`ClaudeSession` 是包消费的运行投影，不是把整个 desktop `Session` 搬入 contracts。Claude 的 Effort、权限模式和 CLI flags 留在 Claude 包。通用调用端不能通过类型断言把未知引擎配置转换成 Claude 配置。

现有 TranscriptHydrator 依赖投影引用和异步前后的状态检查。端口要约定是受控可变视图还是显式读写操作，不能无意改成每次返回副本而丢失更新。完整事件先进入日志，再生成有界展示投影；保留现有 flush 屏障及缺失 transcript 时的显式恢复流程。

导出函数和窄类型即可，不建立通用插件容器、动态代码加载器或包发布体系。内部包仍 private；只开放需要的 exports。构建顺序显式为 contracts → engine-claude → desktop，内部代码继续随应用 bundle，原生 PTY 依赖的打包策略沿用阶段一。继续使用一个 lockfile，不伴随第三方依赖升级。

## 4. 引擎配置与数据迁移

### 4.1 固定的接口方向

- `execution.providerId` 标识执行引擎，`mode` 标识 structured/terminal；引擎身份创建和校验仍归注册适配器。
- 会话新增唯一的 `engineConfig: { schemaVersion, options }` 配置来源；options 是有大小、深度和字段数量约束的可序列化数据，已安装引擎负责验证其版本与字段语义。
- 创建、更新、保存默认配置及 `StructuredExecutor.updateConfig` 都使用这套边界。原有顶层 model/effort/permissionMode 只在旧数据输入及兼容映射中出现，不长期双写。
- 创建时将所选引擎默认配置物化到会话；之后修改设置只影响新会话，不成为既有会话配置的第二来源。
- Claude 配置保留原有 model、effort、permissionMode 的值和语义。测试引擎使用与 Claude 不同的字段/选项，证明公共链路没有硬编码 Claude 枚举。
- 引擎描述提供名称、可用模式、就绪/维护状态、操作能力、支持的配置项与默认值。首批配置 UI 只需已有文本/选择控件，不做通用 JSON Schema 表单平台。
- 模型服务连接 ID、协议类型和模型 ID 属于后续 native 配置，不能复用执行引擎 providerId。阶段二只固定这个命名边界，不新建密钥管理器或尚不可用的模型连接页面。
- 将当前笼统的 CLI `Capabilities` 在内部归位为 Claude 检测信息；通用页面消费引擎描述。离线状态不等于不支持某项功能，维护状态也不等于未安装。
- 描述需要有更新通道：CLI 重新检测、配置保存或维护状态变化后，renderer 收到新的描述，不能一直使用启动时的 executors 快照。

能力限制必须同时在 UI 和主进程执行。运行中改配只开放适配器明确支持的操作；涉及重启的 Claude 权限变更继续按现有规则处理。模型名和未知配置值不得被 UI 静默替换。

改配不是天然原子的：当前 Claude 可能已成功修改并保存模型，随后修改权限失败。新接口应由适配器经宿主端口提交已确认配置，或返回带已生效配置的部分失败结果；IPC 不能最后用旧快照整体覆盖。`pty-hooks.ts`、Claude events 的配置回写也必须使用同一来源。`observedPermissionMode` 属于运行观测值，不作为用户配置的第二份镜像。

### 4.2 workspace v3

建议在 P2b 完成一次明确的 v3 迁移，以解除公共会话接口对 Claude 配置的要求。P2a 的纯包提取可以保持 v2，便于单独回归。

| 输入/情况 | 处理规则 |
| --- | --- |
| v1 Claude / Shell | 沿用已有身份迁移，再规范化到 v3；保留本地 ID、conversationId、forkFrom、项目/cwd/worktree、日志和附件关联 |
| v2 Claude | 顶层配置原值迁入 Claude engineConfig；默认权限迁入 Claude 作用域的默认配置，不变更含义 |
| v2 Shell | 使用 Shell 专属配置；旧通用字段中非默认的历史值如需保留，放入明确的兼容数据区，不赋予 Claude 语义 |
| v2 非 Claude / 未知提供方 | 保留身份和原配置数据为带版本的兼容载荷；没有适配器时不猜测语义，不伪装成 Claude，也不丢弃整个会话 |
| v3 未知引擎或未知配置版本 | 保留可序列化的原配置和会话；显示不可执行原因，允许访问已保存的展示记录；不自动回退 |
| 格式损坏或未来 workspace 版本 | 明确报错并保留原文件；区分“格式损坏”和“版本较新”，不生成空工作区覆盖 |

迁移前保存不覆盖的版本快照，例如 `workspace.pre-v3.<唯一标识>.json`；确认备份写入成功后才原子替换工作文件。现有 `workspace.json.bak` 每次写入都会被替换，不能承担跨版本回退备份。迁移与再次启动应幂等，磁盘写入失败后保持原始版本可恢复。

旧 v2 应用需要拒绝覆盖 v3；用固定旧版本验证这一点。回退说明应要求退出应用、保全整个数据目录、再从明确的版本快照恢复，并说明迁移后的新增会话/配置不会自动倒灌。Git 回退代码不能替代数据恢复。

不移动现有 transcript、展示日志、附件和 worktree 路径；不为引擎独立配置同时引入新数据库。

## 5. 按引擎维护与资源隔离

### 5.1 维护范围

建议提供类似 `withEngineMaintenance('claude', action)` 的服务入口。全应用退出仍走独立的全局 shutdown。

| 行为 | Claude 维护期间 | native 测试引擎 / Shell |
| --- | --- | --- |
| 查看已有记录、导出、保存普通草稿 | 可用；不启动执行进程 | 可用 |
| 新建 Claude 会话、导入/分支、改启动配置 | 明确拒绝，结束维护后重试 | 按正常校验和目录约束处理 |
| 启动、发送、命令准备、队列继续、工作流推进 | 阻止新的执行；既有队列保留并暂停，运行工作流中断 | 持续可用 |
| 停止/取消与失败后的清理重试 | 可用；旧审批失效 | 按原有会话状态处理 |
| 终端输入/调整尺寸 | 只限制目标 Claude 会话 | Shell 可继续交互 |
| 维护完成 | 恢复准入；原任务、队列和工作流需手动继续 | 不改变原运行/暂停状态 |

“其他引擎可用”仍受正常的 maxSessions、磁盘状态和跨引擎目录管理锁约束。不能为了演示并存绕开共享资源保护。

### 5.2 必须覆盖的调用链

1. 在服务层先建立引擎维护屏障，阻止新增目标操作；维护操作本身串行化，全局退出优先。
2. 对目标会话推进取消代次、暂停队列并失效工作流 token；即使保存失败，也先使迟到结果不能继续推进下一阶段。
3. 共享 PTY 增加按会话选择的启动限制、停止和完成等待；覆盖 preparing/starting/running/stopping、hooks 资源和延迟清理。不能对共享 Runtime 使用全局 maintenance/disconnectAll 来维护 Claude。
4. 队列与工作流增加按目标会话筛选的方法；工作流使用持久化的 providerId 与会话绑定确定范围，不能依赖已被维护屏障拒绝的 getSession 调用。覆盖磁盘失败后内存残留的 running 记录，不只处理当前 active map。
5. 等待目标 Claude 的 admissions、工作流所有权、进程树及关闭资源。native/Shell 的活跃状态不能使 CLI 更新一直等待；全局 shutdown 仍按物理运行时去重并清理所有引擎。
6. `reserve()`、附件复制、启动器 prepare、原生文件选择等 await 之后再次检查目标引擎和取消代次，防止维护开始前的请求在屏障后启动进程。
7. 保留关键持久化检查；任何目标资源释放或记录保存失败都取消安装。清理各目标资源时汇总错误，不能因一个失败跳过其余对象，也不能因工作流保存失败跳过 completion 等待。CLIUpdateService 现有的确认后、断开后的安装身份校验及失败后能力刷新继续保留。
8. 安装完成或失败后可靠解除本次维护屏障；全局 quitting 状态不能被 finally 清掉。停止失败的会话仍受资源占用约束，不能因为解除维护就假装空闲。

同步调整 `index.ts` 的 `terminal:write` 全局更新锁、session creation、CLI 更新确认文案、影响会话/运行数和设置校验。确认弹窗的统计只是展示，真正执行前要在屏障内重新确定目标，不能把弹窗时的列表当成永久事实。

### 5.3 同目录限制

P2 保留并验证跨引擎的目录管理保护：清理一个 worktree 时，另一个引擎的活动会话、来源依赖和未释放进程同样能够阻止操作。

真实工具写入租约/互斥属于 P3 的执行安全前置任务，必须在开放 native 编码前完成；不能假定 Claude CLI 和交互 Shell 都能逐条声明写操作。首版应保守处理 Agent 回合的共享 cwd，优先使用独立 worktree。P2 并存演示使用不同目录或无副作用测试任务，不宣称已解决所有同目录并发写冲突。

## 6. UI、历史和离线行为

- 新建会话按已注册引擎及模式生成入口，默认仍为 Claude structured。切换引擎时重新生成该引擎的配置草稿，不携带上一引擎的权限默认值。
- 配置面板、会话标识、缺失依赖提示、连接设置按会话 provider 路由。CLI 未安装不能成为所有 Agent 页面的全局禁用条件。
- P2 生产构建只注册已实现的 Claude/Shell 适配器。CLI 未安装时仍保留 Claude 描述与离线创建能力，启动时明确提示缺失；维护期间遵循上一节的临时限制。假 native 通过测试构造器或隔离测试入口注入，不提供 renderer 可开启的假引擎开关。
- 区分“桌面已保存的会话记录”和“某引擎外部可导入的历史”。Claude transcript 查询归 Claude 历史提供方；查询/分页游标、结果和导入操作都携带 provider 身份。
- 引擎切换后取消或忽略旧历史查询的迟到结果；外部历史导入能力单独声明，不能仅凭 resume 就展示导入入口。
- 没有执行器时可读取已存在的通用展示日志；没有可读日志就明确提示不可用，不尝试用 Claude transcript 补齐未知引擎的上下文。离线投影不恢复活跃审批或自动继续任务。
- 上述离线读取是 P2-06 要新增的宿主读取路径，当前未知 provider 的 snapshot/export/delete 仍会因依赖注册适配器而失败。P2 不顺带承诺未知引擎的完整导出/删除；这些操作明确提示不可用，保留记录与 worktree 保护。
- `resume`、`fork`、上下文恢复和导出分别按实际能力处理；跨引擎不能复用 conversationId。跨引擎摘要导入产品功能留待后续。
- Claude CLI 设置保留原功能和路径。模型连接管理、密钥存储和 native 设置的实际可用入口由 P3 与真实适配器一起交付。

## 7. 任务顺序和完成证据

| ID | 任务 / 主要修改位置 | 前置 | 完成证据 |
| --- | --- | --- | --- |
| P2-00 | 固定 P1 基线、数据样本及回归清单；从 dev 创建 `refactor/engine-boundaries` | 无 | 记录源码 SHA、应用身份、v1/v2 fixtures、现有测试发现清单 |
| P2-01 | 确定最小执行/宿主端口、引擎描述、配置封装、维护和审批生命周期规则 | 00 | 类型草案能表达 Claude、Shell、异构测试引擎；公共接口没有 Claude 枚举 |
| P2-02 | 先在 desktop 注入窄端口，再移动 Claude runtime/协议族到 engine-claude；拆分 commands/history 依赖 | 01 | Claude 包可独立编译与测试；没有 desktop/Electron 反向依赖；旧运行行为回归 |
| P2-03 | 接通 workspace manifest、exports、根构建/check 与打包依赖 | 02 | 干净构建按依赖顺序执行，desktop 经包名消费，产物包含运行代码且没有源码路径依赖 |
| P2-04 | engineConfig 单一来源、v3 迁移、固定旧版备份、IPC/默认值/adapter 校验 | 01；集成依赖02 | 旧会话和配置迁移保真；异构配置经过创建、更新、重启仍保留；失败不覆盖原数据 |
| P2-05 | 按引擎维护：service/registry/runtime/queue/workflows/index/update UI | 01；集成依赖02 | Claude 更新时 native/Shell 不被暂停；异步启动、清理失败、维护与退出竞态可控 |
| P2-06 | 能力和配置驱动 UI、描述刷新、历史来源路由、未知引擎离线展示 | 04；维护展示依赖05 | 第二引擎测试入口无需修改共享聊天/审批页面；CLI 缺失不阻止其他引擎 |
| P2-07 | 共用契约与并存测试：真实 SessionCreation/SessionService/IPC、队列、workflow、维护竞态 | 与02/04/05/06同步补充 | 无需 CLI 的异构引擎完成全部公共流程；同一进程内验证与 Claude/Shell 隔离 |
| P2-08 | 完整回归、三平台包验证、迁移/回退说明和开发分支 PR 验收 | 03–07 | 同一候选提交通过阶段门槛，记录已知限制与真实 CI 证据；只合入 dev |

建议按两个内部里程碑交付：

- **P2a：包与宿主边界。** 完成 00–03 以及相应契约回归；先让 Claude 独立成包，保持数据格式不变。公共配置接口的最终形状在 01 确定，兼容映射可以暂留装配层。
- **P2b：配置与并存。** 完成 04–08；完成旧配置兼容映射向单一 engineConfig 写入来源的切换，实现维护、UI/历史和数据迁移，形成阶段二最终验收。

01 稳定后，包提取、配置迁移、维护改造可以按文件归属并行；UI 等配置与描述定型后接入。contracts、Session/IPC 类型和最终装配由一个集成任务统一修改，避免多条线各建一套接口。

P2a 的入口任务是注入 ChatRuntime/TranscriptHydrator/子任务和展示历史依赖，再提包。只移动文件或先加 native 选项，都不足以解决当前依赖。

## 8. 验收矩阵

| 范围 | 必须证明的行为 |
| --- | --- |
| 包边界 | contracts 保持平台中立；engine-claude 在无 Electron 的测试进程中编译/运行；包源码和输出声明没有 desktop 导入；不依赖深层源码别名 |
| Claude 原功能 | structured/terminal、CLI 参数、npm launcher、流式消息、审批/提问、上下文/命令、resume/fork/recovery、日志、子任务和进程清理保持回归覆盖 |
| 提包后的真实链路 | 公共包入口 → 桌面 host adapter → 真实 SessionService → Claude fixture 子进程 → 持久化；重启后 hydrate/search/export 一致，写盘失败不返回假成功 |
| 第二引擎接入 | 使用不同配置字段和非 Claude conversationId，通过真实 SessionCreation → SessionService → IPC 完成发送、审批、取消、队列和多阶段 workflow |
| 能力和配置 | attachments/commands/liveConfig/fork 等不支持时在主进程调用前拒绝；离线已保存配置可显示；非法配置、未知版本和 CLI 专属选项不被错误接受；模型成功而权限失败时保留已生效事实 |
| 审批与迟到事件 | 两引擎使用相同底层 requestId 仍按会话/当前运行隔离；重复、跨会话、取消后及新回合收到的旧审批不能生效；适配器保留内部工具调用关联 |
| 回合与队列 | 同会话只有一个用户回合；后台子任务未结束仍忙碌；取消/立即发送等待资源和所有权释放；迟到结果不触发队列重发或后续 workflow 阶段 |
| 维护隔离 | Claude structured、Claude terminal、Shell、测试 native 同时存在；更新仅中断 Claude。覆盖 preparing、附件保留、队列唤醒、工作流推进、磁盘失败、停止失败及全局退出 |
| 目录保护 | native/Shell 占用的 cwd、worktree 来源依赖和进程关闭中的目录继续阻止删除/清理；不因 provider 筛选而漏掉其他引擎 |
| 数据与离线 | v1/v2→v3、二次启动、迁移备份、写盘失败、未知引擎/配置版本、未来版本拒绝覆盖；历史路径/ID/附件保持关联 |
| 桌面产品 | 默认 Claude；描述更新及时；不支持的入口关闭且有原因；未装 CLI 的测试环境仍能运行测试引擎；正式包不包含可启用的假 native 入口 |
| 分发产物 | 三平台现有安装/便携包回归、应用/userData 身份不变、PTY/native 资源正确收集、包内可加载 engine-claude；不发布 release |

审批不要求 Claude 协议凭空提供新的 runId：适配器可以为每个本地运行生成代次和不复用的对外请求标识，映射到底层 requestId/tool call；响应时校验当前运行所有权。完整 native checkpoint、工具日志和重放协议由 P3 实现，不能用 P2 的 UI 事件日志代替。

复用 `execution-contracts.test.ts`、`session-creation.test.ts`、`session-service.test.ts`、`chat-queue.test.ts`、`workflows.test.ts`、`cli-update.test.ts` 及现有 Claude/runtime/history/PTY 测试。新增测试针对异构配置、维护作用域、资源屏障及迁移等新风险，使用受控 Promise/fixture 事件同步，不用加长睡眠或重复重试掩盖竞态。

日常先跑受影响测试与 `npm run check`；收敛后针对同一候选代码运行三平台源 E2E 和现有打包验证。以 P1 的三平台验收为比较基线，记录新增/移动/跳过用例；不能通过减少覆盖宣称通过。P1 未单独启动 Windows 自解压 portable EXE，沿用该范围时须如实记录。

## 9. 范围、风险与分支约束

最高风险是共享 PTY 的维护和取消、运行配置变更与磁盘保存的一致性，以及 v3 迁移后的回退。中等风险是历史来源/离线展示和动态能力刷新。包目录与构建变更本身相对直接，但必须经过真实产物验证。

若运行中改配成功而磁盘保存失败，应明确报告状态不一致并阻止盲目继续；根据现有适配器能力停止运行或重新读取配置后再恢复，不能假装回滚了 CLI。包提取阶段同样不能弱化既有同步关键写、延迟写错误和资源清理保障。

本阶段不创建 agent-core/agent-node 空包，不接真实模型，不实现工具执行器、上下文压缩、MCP、完整 Skills、多 Agent、TUI 或插件市场。P3 在稳定契约上开始；真实编码能力上线前必须补齐独立上下文、工具权限/预算、持久化与写入并发规则。

实施分支建议为 `refactor/engine-boundaries`，从最新 `dev/native-agent` 创建。阶段 PR 目标仅为 `dev/native-agent`；如按 P2a/P2b 分 PR，两者分别满足自身验收且第二个从已集成的 dev 开始。当前计划文档不启动阶段二实施，也不触发 main 合并或发布。

在用户另行明确授权前，所有代码继续只进入开发分支，不合入 main。
