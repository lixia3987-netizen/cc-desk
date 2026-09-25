# 阶段三：自研 Agent Alpha 开发计划

日期：2026-09-25（北京时间）。

分析基线：`dev/native-agent@2c67d6acf04746548d5b7e0782f25d366418e8d6`。阶段二代码候选 `a4e34ce` 已完成三平台验收，见[阶段二验收记录](ENGINE-BOUNDARIES-PHASE-2-VALIDATION.md)。

状态：**计划分析完成，尚未开始阶段三实现**。本文中的新包、接口、工具和 native 入口均为拟议交付，不是当前产品已有能力。本次只提交计划文档，不调用真实付费模型，不修改运行代码，不合入 main、不发布 Release。

关联：[总体计划](NATIVE-AGENT-PLAN.md)、[阶段二边界设计](ENGINE-BOUNDARIES-PHASE-2.md)、[架构说明](ARCHITECTURE.md)。下文路径相对于仓库根目录。

## 1. 交付目标与范围

P3 的交付物是一个能够独立完成小型仓库任务的 **native 编码 Agent Alpha**：读取项目及开发约定，调用模型，申请工具权限，修改代码，运行验证，展示真实差异与结果。不安装 Claude CLI 也能完成这条链路。

过渡期默认仍是 Claude Code。用户按会话显式选择 native；Claude、native、Shell 保留各自的身份、认证和上下文，共享桌面的会话、审批、队列、工作流和 Git 界面。发生副作用后不自动切换引擎重做任务。

| P3 必须完成 | 留给 P4/P5 |
| --- | --- |
| 可独立测试的 agent-core、Node 实现及真实桌面 worker | 多 Agent、TUI、远程常驻服务、插件市场 |
| 一个实际模型协议、流式文本/工具参数、用量与取消 | 多协议兼容矩阵、自动模型路由、复杂模型连接诊断 |
| 列目录、读文件、搜索、受控文本修改、命令执行 | 二进制编辑、复杂补丁事务、后台长期任务 |
| 基本 AGENTS.md 作用域、逐次写入/命令审批、预算 | 完整 Skills、MCP、复杂指令来源与自动权限学习 |
| 完整模型上下文与工具记录、正常续聊、干净重启续聊 | 自动压缩、中断回合自动续跑、复杂恢复与迁移 |
| 崩溃后识别未知副作用并阻止自动重放 | 无需人工核查的广泛故障恢复 |
| 现有文字队列与单会话串行 workflow 的真实 native 验证 | 多会话并行编排、自动工作流恢复 |
| 应用内登记目录的执行互斥、进程树清理 | 操作系统级文件/网络沙箱、跨外部程序的绝对写入互斥 |

“完整上下文”指实际交给模型的内容、工具调用/结果和协议续接信息。工具输出仍受预算限制；不承诺保存无限输出或供应商未提供的内部推理。

## 2. 阶段二留下的真实基础与缺口

| 当前实现 | 可以复用 | P3 需要补齐 |
| --- | --- | --- |
| `packages/contracts/src/{execution,execution-ports}.ts` | 引擎身份、EngineConfig、描述、StructuredExecutor、生命周期 | native 内部运行契约；必要的提交身份和资源释放屏障 |
| `execution/create-executors.ts`、registry、routers | 集中注册与能力校验；Claude/Shell 实现 | 正式 native adapter；当前 `test.native` 只存在于测试装配 |
| `session-service.ts`、queue、workflows | 准入、容量、同会话串行、CLI 范围维护 | 跨会话目录执行占用、稳定提交 ID 的贯通、真实 native 收尾 |
| `chat-history.ts`、ChatArchive | 展示记录、分页、搜索、投影 | 独立完整模型上下文、执行账本、检查点；展示日志不能替代它们 |
| workspace v3 与 `engineDefaults` | 新引擎的非秘密配置和默认值 | 模型连接、凭据存储、native 运行数据；无需为这些数据预先改 workspace v4 |
| `files.ts` | 相对路径、realpath、读句柄和对象身份检查 | 受控写入、版本冲突、搜索/命令边界；不能退化为简单 realpath 后直接读写 |
| `runtime.ts`、Claude runtime | 现有平台进程/PTY/hook 清理 | 按会话可等待的完整释放，覆盖自然退出与残留后代 |
| `scripts/{build,dev}.mjs`、packaged tests | 三平台已有成品矩阵 | 独立 worker 入口及包内实际 native 链路；现有成品测试主要运行 Shell |

三个接口语义必须先澄清：

1. 当前 `resume` 主要限制创建时带外部 conversationId 的操作；普通已有会话的 `send/hydrate` 不因此被禁用。`resume:false` 不能成为丢弃本地上下文或回避重启语义的理由。
2. `ExecutionLifecycle.stop()` 允许 `void`，部分实现发起后台清理后返回。`await stop()`、根进程退出、UI 显示 interrupted、甚至单次 `has() === false`，都不能单独作为新目录租约的释放证明。
3. queue/workflow 没有独立 capability，structured 会话会进入这些现有入口。本计划明确在 P3 验收文字队列和现有串行 workflow；不能通过只禁止默认 workflow 创建来假装关闭所有工作流。

## 3. 包和宿主职责

| 位置 | 拟议职责 |
| --- | --- |
| `packages/contracts` | 保持引擎中立；仅增补真正跨桌面边界的提交身份、释放语义或可见恢复原因 |
| `packages/agent-core` | Agent 状态机、工具循环、上下文组织、审批/预算规则；ModelPort、ToolPort、RunStore 等接口；不依赖 Electron、文件系统或 Claude |
| `packages/agent-node` | 选定模型协议、原生记录库、文件/命令工具、进程监管与项目指令实现；普通 Node 可运行/测试，不反向导入 desktop |
| `apps/desktop/src/main/engines/native` | native 会话投影、StructuredExecutor、utilityProcess 启动、协议桥接、展示事件与桌面注册 |
| desktop main | 凭据与连接管理、目录/容量仲裁、队列/workflow、通知、IPC；持有工具监管器和原生记录库实例 |

依赖顺序为 contracts → agent-core → agent-node → desktop；engine-claude 继续独立依赖 contracts，再由 desktop 装配。保持私有包、单一根 lockfile，不伴随框架升级或增加大型 Agent 框架。

建议每个 native 用户回合或 workflow stage 使用一个新的 utilityProcess。模型上下文由本地记录库跨 worker 保留；首版不做 worker 池。worker 内运行 core 和模型协议适配，桌面通过窄端口提供持久化、工具执行和审批。

命令工具优先交由 **主进程持有的 agent-node ProcessSupervisor** 创建和管理；文件工具也通过绑定本回合授权的宿主工具端口执行。worker 崩溃后，主进程仍拥有实际副作用与子进程的记录及清理责任。worker 无权仅用一句“已完成”解除宿主资源占用。

Electron 入口拟为 `main/engines/native/worker-entry.ts`，单独 bundle 到 `dist/native/worker.cjs`。main/worker 协议带 schemaVersion、sessionId、conversationId、runId、workerGeneration、requestId/seq；运行时校验消息类型、大小和当前所有权，设置背压。审批、凭据、工具端口不直接暴露给 renderer。

utilityProcess 要在 app ready 后启动。其 `kill()` 不提供工具后代清理保证；它承担故障隔离，文件/命令权限仍由应用策略承担。dev、ASAR/unpack、工作目录及中文/空格路径的可执行方案应在 P3-00 提前实测后固定。[1][2]

## 4. 核心循环、身份与持久化

### 4.1 最小接口与执行顺序

| 拟议端口 | 必须表达的内容 |
| --- | --- |
| ModelPort | 流式文本、完整工具调用、终止原因、用量；带版本的协议上下文/续接元数据；统一取消 |
| ToolPort | 工具 schema、风险类别、已校验的输入、执行/取消、受限输出及截断信息 |
| RunStore | conversation 单写者、递增 seq、持久 append/commit、检查点、request→run 映射、未完成副作用查询 |
| ApprovalPort | 一次审批绑定当前 run/tool/input/policy；等待、拒绝、过期与失效 |
| RuntimeHost | 稳定时钟/ID、配置快照、事件、工具监管、资源释放与取消信号 |

循环为：接受稳定提交 → 持久保存用户输入 → 加载已提交上下文/项目指令 → 请求模型 → 收齐、校验并持久提交完整响应 → 逐个审批并执行工具 → 提交结果及上下文 → 下一次模型请求或结束。首版工具按顺序执行；模型返回多个调用时保留其身份和顺序，不并行修改文件。

流式参数只作显示，不能边接收残缺 JSON 边执行工具。响应中断、参数非法、工具未知或模型拒绝时记录明确结果，不将未完成响应标成成功。模型输出是工具请求，不能自行授予权限。

内部终态区分 `completed/cancelled/failed/budget_exhausted/recovery_required`，与资源 `preparing/running/stopping/released/cleanup_failed` 分开。尽量投影到现有 TaskState，并在 UI 显示具体终止/恢复原因；如扩展公共枚举，需审计所有 BUSY 集合、队列和 UI 分支。

### 4.2 独立执行账本

拟在 `userData/native/conversations/<内部安全ID>/` 保存版本化 journal、checkpoint 和有界 artifacts。运行数据不放项目目录、不写 Claude transcript、不使用 ChatHistory 的有界消息数组重建模型上下文。

账本由宿主单写者管理。每个事件关联 session/conversation/run、seq 与提交版本；checkpoint 绑定已提交 seq、协议版本和完整上下文，是已提交日志的索引/快照。写入、同步与原子替换语义必须明确；损坏或未来 schema 不得按空记录继续运行。运行中配置、模型、指令源 hash 和策略版本均保存为可审计快照，不保存凭据明文。

首个工具执行前必须持久提交完整模型响应，包括所有 output items、工具调用及关联 ID、opaque 续接数据。仅保存某个工具的输入不足以恢复协议上下文。checkpoint 可以落后于日志，但必须能由已提交日志重建，不能依赖未保存的 worker 内存。

随后每个副作用的顺序固定为：

1. 检查输入、审批、目录所有权和文件前置版本。
2. 持久提交 `tool_prepared`，包含精确输入、调用身份、授权依据和前置摘要。
3. 执行文件操作或命令。
4. 持久提交 `tool_completed`，记录输出/退出码、实际修改摘要及结果状态。
5. 更新完整模型上下文与检查点，才允许下一模型请求或回合完成。

准备记录写失败时不执行；副作用已发生但结果提交失败时停止后续操作并保留需要核查的状态。只有 prepared 没有 completed 的调用，重启后一律先视为结果未知；不能自动重跑任意 shell 命令。补丁前后 hash 可辅助核对，但不承诺跨磁盘、远程服务和进程的 exactly-once。

`StructuredExecutor.send` 拟增加可选的提交上下文参数，贯通 queue messageId、直接发送 requestId、workflow run/stage/attempt 等稳定来源身份；现有 Claude 适配器保持兼容。native 在接受任务时持久化来源身份→run 映射；相同 ID、相同载荷的重复提交查询已知结果，相同 ID 不同载荷拒绝。原 run 仍活动时绑定既有 run 或明确返回 busy，不新开 worker。显式重试形成新 attempt，不能复用旧审批。

宿主 ToolPort 同样按 `(runId, toolCallId)` 去重：同 ID 不同输入拒绝，已 completed 返回持久结果，prepared/执行中返回既有状态或阻断核查，绝不重复执行。IPC seq 校验不能替代这层副作用去重。

这解决“native 已接受/完成，但队列回执尚未保存”的识别问题，不替代外部副作用幂等。UI 投影按稳定事件 ID/seq 去重，可从 native 记录重建。投影/队列回执写失败也要报告，不能据此重复执行已完成工具。

### 4.3 P3 恢复底线

| 情况 | P3 行为 |
| --- | --- |
| 正常下一用户回合 | 新 worker 加载已提交完整上下文继续 |
| 干净退出后重启 | 可浏览、搜索并从已提交且协议合法的上下文继续已有 native 会话；不依赖供应商保留的临时 response ID |
| 模型流中断，未执行副作用 | 显式 interrupted/failed，保留已提交上下文；用户决定新尝试 |
| 工具结果未知或账本不完整 | 标记 recovery_required，禁止自动续发队列/推进 workflow；显示需核查的调用与文件/命令 |
| 有明确完成记录，回执丢失 | 同提交 ID 查回结果并修复投影/回执，不重新执行 |
| 旧审批、迟到 worker 消息 | 根据 run/generation 拒绝，不影响新回合 |
| 压缩或中断点自动恢复 | P4；P3 超出上下文预算时明确停止，不能偷偷截掉工具历史 |

多工具响应中途正常停止时，记录尚未执行调用的真实 not-executed/cancelled 结局，由适配器形成合法上下文；干净退出不代表全部工具都已完成，也不承诺从任意中断点自动续跑。

用户核查后的处理须有明确操作：确认已完成并记录观察结果，或保留旧记录、明确开启新尝试。任意 shell 结果无法确定时不伪造 tool result；无法构造合法续接上下文的会话保持只读，并允许另开 native 会话。不得用展示摘要冒充无损恢复。

## 5. 首个模型协议与连接

建议首个实际协议采用 **OpenAI Responses 的文本＋function tools 子集**；这是本项目的初始取舍，不是把 core 绑定到 OpenAI。官方当前推荐新项目采用 Responses，并要求手工维护上下文时保留完整 output items。部分模型的工具支持也不能由“兼容 Chat Completions”推断。[4][5][6]

P3-00 根据用户实际可用 endpoint、模型和认证确认首个适配器。若实际服务只提供 Chat Completions，可明确替换这一选择，仍保持 P3 只做一个真实协议；不同时展开 Responses、Chat Completions、Anthropic 三套实现。模型 ID、服务地址与付费账户目前没有在本任务中指定，不默认用户已有 OpenAI API 额度，不借用 Claude CLI 登录。

拟采用本地保存上下文、`store:false` 的调用方式，保留实际返回的完整协议 items、工具关联、phase 及适用的加密 reasoning 续接数据；不将上下文降成 role/text。core 通过版本化 opaque 协议数据承载这些差异，renderer 不解析它们。只启用本应用声明的本地 function tools，不在首版接入供应商托管工具循环。[5][6]

模型适配验收包括：拆分/合并 SSE 帧、多字节字符、多个 tool call、取消/超时、错误终态、usage 缺失、限流、断流和未知事件。重试仅用于能确认安全的传输情形，并受次数预算限制；不能因网络失败重新执行已完成工具。

### 5.1 配置分层

| 数据 | 归属 |
| --- | --- |
| `execution.providerId = native` | 执行引擎身份，沿用 P2 |
| `engineConfig.options.connectionId/model/...` | 会话绑定的连接引用、模型及非秘密配置；创建时物化默认值 |
| 连接 id、name、protocol、baseURL、默认模型 | 独立版本化 ConnectionStore；向 renderer 返回脱敏元数据 |
| API key、环境变量解析值 | 主进程 CredentialStore/SecretResolver；不进入 AppState、engineDefaults、会话日志、导出、命令行参数 |

当前 Settings 和 EngineConfig 会广播到 renderer，不能往普通 EngineConfig 文本字段中放 apiKey。首版提供环境变量名引用；OS 保护已验证时可保存加密凭据，也可只在本次应用内存使用。

若允许 password 输入框，密钥输入会瞬时经过 renderer；独立 mutation IPC 接收后清空，不回读既有密钥、不保存表单草稿、不进入全局状态或日志。只有环境变量引用路径可以说密钥不经过 renderer。

主进程按回合解析连接/凭据并通过专用通道给模型 worker，工具子进程使用独立最小环境，不继承模型密钥。URL 禁止内嵌账号密码；跨 origin 重定向不得自动携带认证；远程默认 HTTPS，本地回环 HTTP 需作为明确连接类型。错误、网络 header 和 utility crash diagnostic report 先限制字段/长度并脱敏。

Linux 安全存储不可用、basic_text 或保护状态无法验证时，拒绝持久保存，使用 env/本次内存；不自动启用明文 fallback。Electron 同步/异步 safeStorage 后端的证明条件不同，不能仅凭一个 available 布尔值宣称 OS 加密保护。[3]

运行回合固定连接修订版；修改/删除正在使用的连接先拒绝并提示停止相关回合。被已有会话引用的连接优先禁用/替换引用，再删除。单一连接失败只影响使用它的会话：当前 capabilities 是 provider/mode 全局值，需另提供所选连接的就绪状态与发送前校验。

## 6. 本地工具、项目指令与权限

| 工具 | Alpha 范围 | 必要约束 |
| --- | --- | --- |
| list_directory | 项目内有界目录/文件列表 | 不递归跟随链接；深度、条数、耗时上限与截断提示 |
| read_file | 普通文本、行/字节范围 | 版本标识覆盖完整文件对象/内容，而非返回片段；编码/二进制/大小边界；读取前后检查对象与父目录身份 |
| search | 项目内文本查找 | 首版固定受限语义；查询不能成为 shell/命令选项；有扫描、匹配和输出上限，支持取消 |
| apply_patch | 创建/更新单个文本文件 | 预期 hash 或明确不存在条件；逐次审批；审批后写前复核，冲突后重新读取，不 fuzzy 覆盖 |
| run_command | 明确 executable、argv、cwd 的有限时命令 | 默认 shell:false；shell 脚本作为独立显式受审模式；输出、超时、取消与后代清理 |

首版补丁不实现文件删除/重命名、二进制和跨文件事务；一次任务可以顺序提交多个单文件修改。每个已完成文件单独记账，后续失败报告部分完成，不自动回滚或重放整批。更新使用同目录临时文件、同步和替换，保留需要保留的模式；新文件必须校验最近存在父目录，并采用不会覆盖并发出现目标的创建语义。不能把“先检查不存在，再无条件 rename”当作排他创建；具体平台原语、部分写入失败及清理策略在工具设计中验收。

复用/提取 `files.ts` 的安全读基础到 agent-node，desktop 通过包出口消费。写入需独立设计。拒绝授权根外路径、`.git`、宿主数据与凭据目录；处理符号链接、Windows junction/大小写/盘符、父目录替换、设备文件和新文件路径。无法支持完整版本校验的大文件不开放补丁。Hash 和 Node 路径检查属于乐观冲突检测，最终检查与替换之间仍可能有外部编辑；应用内串行不能保证任意外部编辑均不丢失，也不能承诺抵御所有恶意本机 ABA 重命名。无法验证授权路径边界时拒绝操作。

权限默认是“授权项目内常规读取可执行，文本修改和所有命令逐次批准”。敏感文件不自动加入模型上下文；需要时由用户显式授权具体范围。审批内容显示工具、路径/补丁或 argv/cwd，以及本次授权范围；内部绑定 session/conversation/run/toolCall/inputDigest/policyRevision/workerGeneration。拒绝是工具结果，不反复无条件请求同一操作；取消或输入变化使审批失效。首版不提供 native 的 bypassPermissions 对应选项。

P3-00 固定默认敏感路径/文件名规则和显式授权方式，统一覆盖 read_file、search 与自动上下文收集；至少包含环境变量文件和常见私钥/凭据文件，并处理链接指向的实际目标。不承诺凭文件名识别代码中的所有秘密；通过同一组样例验证三个入口行为一致。

命令一旦获准执行，可能访问该系统用户可访问的其他文件或网络；cwd 校验和目录租约不能限制任意程序的实际影响。首版面向可信项目并明确这一边界，不能将它称作系统沙箱。输出超限时继续排空并丢弃或终止整棵工具进程树，不能停止读取管道导致阻塞。

搜索优先使用可随产品验证的 Node 有界实现，或明确随包分发并验收的搜索资源；不假设用户机器已装 rg。命令运行依赖用户项目所需的 Git/Node/构建工具，缺失时给出具体诊断；应用 worker 自身不能依赖机器额外安装 Node/tsx。

AGENTS.md 首版规则：

- 仅从授权项目/worktree 根到目标目录逐层加载，浅层到深层；不向 HOME 或根外自动爬升，不自动 include URL/执行指令文件中的命令。
- 用户明确任务优先于项目约定；项目文本不能扩大授权根、读取凭据、关闭审批、提高预算或改变宿主权限。
- 文件操作按目标路径解析适用规则；命令按 cwd 解析，并说明不能静态推导任意脚本触及的所有子目录。
- 记录指令来源、作用域与 hash；进入新子目录时加载其规则。审批等待时规则或目标版本变化，重新校验并使受影响审批失效。
- 限定文件/总量和编码，超限或关键规则无法加载时明确报告，不静默声称已遵循全部规则。工具输出和普通代码内容不自动升级为项目指令。

## 7. 目录互斥、取消与资源释放

### 7.1 应用内执行占用

新增主进程 `DirectoryExecutionCoordinator` 或等价组件，分别管理 Git/worktree 管理操作的占用和任务执行的占用。owner 绑定 session/provider/run/generation；按服务端生成 token 持有，所有关联根一次检查/获取，避免部分获取和死锁。

Git 会话按实际 worktree 根加 canonical cwd 登记，非 Git 按授权项目根登记。同根或父子重叠保守互斥；路径规范化经过 await 后重新检查身份、取消和维护代次。独立 linked worktree 不仅因相同 git-common-dir 而互斥；宿主 Git 管理仍按公共 Git 目录串行。嵌在另一活动根内的 worktree 可保守拒绝并发。

| 执行形态 | 占用规则 |
| --- | --- |
| native structured | 在准入、worker/工具启动前取得；模型、审批、工具、提交与停止期间持续持有；完全释放后归还 |
| Claude structured | 活动回合及未证明释放的进程资源持续占用；空闲连接可在确认无任务/queue/workflow 所有权后，通过明确关闭等待接口释放 |
| Claude terminal / Shell | 整个终端进程树生命周期持续占用；提示符或 Ctrl+C 不表示释放 |
| worktree 创建、合并、删除 | 与相关执行占用互斥，保留来源依赖、父子路径及未释放资源保护 |

不同独立目录仍可并行。冲突时 UI 显示具体占用会话，允许用户关闭它或选择独立 worktree；不自动杀死正在运行的另一个会话。

此规则只协调应用登记根。终端 cd、绝对路径、任意脚本、外部编辑器及共享 Git refs 并不受它完整约束；不承诺独立 worktree 能隔离所有外部效果。

### 7.2 明确释放屏障

在 contracts/各 executor 中增加按会话可等待的释放语义，例如 `stopAndWait`/`whenReleased`；具体接口在 P3-00 固定。保留“发出中断”和“资源完全释放”的区别，不能用 `runChat finally` 无条件归还物理执行占用。

释放分成两层，避免调用关系形成循环等待：

- executor 层负责本回合 preparing、worker、工具进程树、stdout/stderr、PTY、hooks、审批等待、持久化和投影。native `send` 在这些资源收尾、终态已提交后返回；它不能等待调用它的 queue/workflow 释放所有权，因为调用方要在 `send` 返回后才能保存回执并退出。
- SessionService/协调器外层再结合物理释放、queue 持久回执和 workflow 所有权，决定目录归还以及维护/删除准入。串行 workflow 跨 stage 保留外层 owner，同一 owner 内交接回合 token；最终完成、取消或暂停并记账后，才满足外层释放条件。不能在每个 stage 结束时对其他会话短暂开放目录。

覆盖自然退出、根先退出、后代拒绝停止和清理失败。POSIX/Windows 的证明分别验证；不能假设 utilityProcess.kill 或 taskkill 一次调用必然成功。`has/activeCount/isBusy` 在各自所属层反映清理和占用，不能只检查 executor 来推断调用方已完成；清理失败保留相应 owner，给出重试/诊断状态，不显示假空闲。

实际入口审计至少包括 `SessionService.reserve/start/runChat/manage/withSessionCreation/manageWorktree`、`chat:commands` 启动、附件 await、queue、workflow、Runtime、Claude runtime 和相关 routers。不能只在新 native 写工具上加一把锁。

CLI 更新继续只封闭并释放 Claude；native/Shell 的独立目录不被暂停。global shutdown 胜过所有重新准入；维护 finally 不得解除 quitting。旧 run/worker/审批的迟到消息按 generation 丢弃。

主进程异常退出也不等于所有工具后代已退出。启动恢复应结合持久运行信息核对存活资源，避免因 PID 复用误杀其他进程；无法证明清理时保留 recovery_required 和受影响目录阻断，先让用户核查，不自动开始下一轮写入。

## 8. 预算和能力声明

先将边界实现为显式可测试配置，再经固定任务集调整默认值。建议 Alpha 初始值：每回合最多 30 次模型请求、60 次工具调用，主动执行总时长 10 分钟，单命令 120 秒，单工具交给模型的输出 64 KiB。审批等待单独计时并在超时后取消；所有值均是拟议初始值，不是模型自身限制。

token 预算需在请求前检查输入估计/模型窗口配置，并传递适配器支持的输出上限；usage 缺失显示 unknown。供应商事后用量与近似 tokenizer 不能提供绝对费用硬上限。上下文不足时保留记录并明确停止，P3 不静默压缩/截断已提交语义。工具日志/完整上下文也有总磁盘与单记录上限，超限在副作用之前拒绝下一步。

| native capability | P3 目标 |
| --- | --- |
| structured、approvals | 真实链路验收后 true |
| terminal、fork、commands、attachments、liveConfig、recoverContext | false；对应主进程入口也拒绝 |
| resume、history | 外部导入/提供方续接未实现时 false；本地正常续聊和干净重启仍必须实现 |
| contextUsage | 完成真实用量映射后开启；未知窗口不猜数值 |
| export | 完成有界、脱敏的本地导出后开启，不包含凭据和内部 opaque 续接数据 |
| available | 宿主整体就绪；所选 connection 的缺失/失效单独检查与展示 |

native 模型和连接配置只在停止且没有 queue/workflow 所有权时修改，已运行对话切换协议/模型的兼容处理应明确；首版可要求新建会话，不能静默丢弃旧协议上下文。旧 Claude 字段、effort、权限值不映射成 native 含义。

## 9. 任务拆分与依赖

| ID | 任务 / 主要位置 | 前置 | 完成证据 |
| --- | --- | --- | --- |
| P3-00 | 固定协议/身份/成功与取消语义及敏感文件规则；三平台 utilityProcess、ASAR、工具后代与凭据后端小型验证 | P2 | 必需门槛：接口决策、worker 路径与资源释放方案；另列实际服务待确认项，失败先调整方案 |
| P3-01 | agent-core、确定性模型/工具、状态机、预算和审批端口 | 00 | 无 Electron/网络测试；多轮工具、非法参数、取消/迟到事件、预算与审批隔离 |
| P3-02 | agent-node RunStore、提交去重、完整上下文/checkpoint、投影接口 | 00；集成01 | 故障注入、写前失败不执行、未知副作用不重放、正常/干净重启续聊 |
| P3-03 | desktop worker host、命令监管器、按会话资源释放契约 | 00；集成01/02 | 真 utilityProcess/真子进程，退出/崩溃/后代/stdio/清理失败证据 |
| P3-04 | 跨引擎目录执行协调，贯通现有所有启动/管理入口 | 03 | native/Claude/Shell 同根冲突、独立目录并行、await/停止/维护/删除竞态 |
| P3-05 | 一个真实模型协议适配，SSE/工具参数/用量/上下文续接 | 01/02 | 受控 HTTP 协议服务与真实适配器；固定远程服务 smoke 单独记录 |
| P3-06 | ConnectionStore、凭据、脱敏 IPC、连接配置界面 | 00；集成03/05 | 缺 key/失效/修改竞态、env/安全后端降级、secret sentinel 不泄漏 |
| P3-07 | list/read/search/apply_patch/run_command 与输入/路径/版本校验 | 02/03/04 | 真文件/命令、补丁冲突、symlink/junction、输出/超时/取消/写盘失败 |
| P3-08 | AGENTS.md、审批策略与预算贯通 | 01/07 | 嵌套规则、规则变化、权限不升级、拒绝/过期/重启审批、成本未知状态 |
| P3-09 | NativeStructuredExecutor、正式注册、配置/能力/UI/历史投影 | 01–08 | 没有 CLI 的真实 native 会话、分页搜索、跨回合与重启、未知配置保留 |
| P3-10 | 真实 native queue/workflow、并存/维护/退出回归 | 09 | 稳定提交身份、只在完整释放后推进，重启暂停且不自动重放 |
| P3-11 | 根构建/check、三平台源码与实际包、真实小仓库任务、操作/恢复说明 | 09/10 | 同一候选完整通过，明确远程服务/模型/预算与结果；只集成 dev |

建议按三个内部里程碑和 PR 收敛，每个从最新 dev 分支创建：

| 里程碑 | 范围 | 可审查的交付 |
| --- | --- | --- |
| P3a：执行基础 | 00–04 | core＋完整记录＋真实 worker/进程监管＋目录协调，确定性测试贯通；生产界面暂不开放 native 编码 |
| P3b：模型与工具 | 05–08 | 单协议、连接/凭据、本地工具和 AGENTS/审批；通过真实 Node/worker 集成闭环 |
| P3c：桌面 Alpha | 09–11 | 正式 native 入口、现有队列/workflow、无 CLI 的仓库任务与三平台成品验收 |

01 和 02 在契约确定后可并行；03 的平台验证前置；05 和 06 可并行于工具实现。**真实写工具开放依赖持久化、目录协调和释放屏障**，不能为了先演示编码跳过这些前置。通用契约与最终装配由一条集成线维护。

00 的契约和平台验证是基础任务门槛；实际服务、凭据与预算可单独标为待确认，不阻塞 01/02。它们必须在 05 的远程 smoke 和最终真实模型验收前落实，不能把待确认项记成已验证。

实现分支建议分别为 `feat/native-agent-foundation`、`feat/native-agent-tools`、`feat/native-agent-alpha`，PR 目标均为 `dev/native-agent`。沿用验证后自动合入开发分支的偏好；main 和 Release 仍需用户另行授权。本次计划 PR 不启动这些实现任务。

## 10. 验收矩阵与完成定义

| 范围 | 必须获得的证据 |
| --- | --- |
| 包边界 | core/node 普通 Node 编译/运行；无 desktop/Electron 反向依赖；exports 与声明完整 |
| 工具循环 | 多轮调用、顺序结果、完整参数才执行、拒绝/失败/预算明确；模型 final 不提前解除资源 |
| 持久化 | 完整模型响应提交、prepared 前/后、工具执行后、completed/checkpoint/投影提交时逐点故障；重复 submission/工具 IPC；日志截断/损坏/未来版本；不得假成功或重复副作用 |
| 审批 | 跨 session/run、重复、过期、输入/指令变化、取消与重启旧审批全部无效 |
| 文件与命令 | 项目路径/链接逃逸、读后改/批准后改、局部读取后未显示部分被修改、新文件父目录替换/发布前目标出现、磁盘失败；Windows quoting、输出洪泛、后代与超时 |
| 并存和目录 | native/native、native/Claude structured/terminal、native/Shell 同根互斥；独立目录并行；共享容量与 Git/worktree 保护 |
| 生命周期 | 模型/审批/工具/提交中取消；worker 与根进程先退出；清理失败保留占用；全局退出与 Claude scoped 维护 |
| 连接与隐私 | 缺失/禁用/删除连接、运行快照、认证过期、重定向、env/后端降级；secret 不进入 workspace/展示日志/导出/诊断/工具环境 |
| 桌面 | 原 Claude 默认/能力保持；无 CLI 的 native 创建/运行；停止配置、只读恢复、分页搜索、清晰错误 |
| queue/workflow | 真 worker 顺序执行、立即发送完整取消、多 stage 不死锁；send 已返回但 ACK 未持久时仍阻止管理/删除，完成外层收尾后释放；提交 ACK 崩溃、重启暂停且不自动续跑 |
| 真实成品 | 正式 native 注册→正常设置/创建 IPC→包内 utilityProcess→本地 HTTP 协议服务→真实工具→审批/日志/UI；无源码、tsx 或额外 Node 依赖 |

成品保留 Windows ZIP/NSIS、macOS ZIP/DMG-copy、Linux tar/AppImage-extracted 现有矩阵，新增 native 用例。测试服务只模拟 HTTP 模型端点，必须走正式模型适配器、正式 native executor 和真实 worker，不能用 P2 TestEngine 替代。通过 worker ready/PID、工具子进程、实际磁盘结果及重启记录证明真实执行；覆盖中文/空格与仓库外启动目录。

确定性 CI 与真实远程模型验收分开记录：

1. 日常运行受影响包/故障测试；阶段候选执行根 check、全部源码 E2E、三平台分发构建及实际包测试。记录新增/移动/平台跳过，不减少既有覆盖制造通过。
2. 最终在独立、可重置的小仓库 worktree 上，使用用户选定并授权的实际服务和明确预算完成至少三类任务：修复带失败测试的缺陷、添加小功能并补测试、遵循嵌套 AGENTS 的局部重构。预先给出验收断言；记录提交、连接协议、模型、修改、命令退出码、用量与人工介入。
3. 真实任务以文件和测试结果判定，不以模型声称“完成”判定。至少验证一个后续回合及干净重启续聊；另以受控故障证明未知副作用不会重放。
4. 无可用远程凭据时可以完成 P3a 与确定性集成，但不能将完整 P3 Alpha 的真实模型验收标记为通过；不把本地 fixture 的成功扩展成所有“兼容服务”均可用。

未改变既有分发范围时，继续如实注明 Windows 自解压 portable EXE 未单独启动、Linux FUSE 未验证，以及未增加签名/公证/自动更新。本阶段不发布 Release。

## 11. 开始实施前的决策点

当前可直接冻结：两个新增私有包、一个协议、顺序工具、每回合 worker、本地完整记录、逐次写入/命令审批、保守目录互斥、保留 Claude 默认。

P3-00 需要确认：首个实际模型服务/模型/认证来源和小额验收预算；三平台 worker/进程释放方案；安全存储可用后端；日志/输出/上下文预算与初始默认值。这些不阻碍当前计划或无凭据的 core 工作，但必须在开放对应真实功能前落实。

最高风险是资源释放和目录占用、外部副作用与持久化之间的崩溃窗口、跨协议完整上下文以及跨平台凭据/worker 分发。先做小型平台验证，再据结果估算工期；不按文件数量或并行 Agent 数给出完成日期。

## 12. 依据

本计划基于上述固定代码、三路独立源码核查及以下官方文档（查阅于 2026-09-25）。阶段三尚未实现、未进行真实模型调用；文中阶段三验收项是后续门槛，计划 PR 的现有项目检查不能替代这些验收。官方说明用于核实 API 能力，包边界、默认协议、权限与里程碑属于针对 cc-desk 的设计建议。

1. [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)：启动时机、环境、消息与进程终止。
2. [Electron parentPort](https://www.electronjs.org/docs/latest/api/parent-port)：utility worker 与父进程通信。
3. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)：平台后端和 Linux fallback；实施时核对固定 Electron 44.4.3 的实际行为。
4. [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)：新项目接口建议与 Chat Completions 差异。
5. [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)：手动保存完整协议上下文。
6. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)：工具调用、关联结果与流式参数。
