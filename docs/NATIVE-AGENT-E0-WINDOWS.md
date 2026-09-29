# E0-03：Windows + cc-switch 执行准备

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@5980b06058b8e6d262df71562eeed7513c1202af`。本页记录已确定的执行条件和后续 Windows 操作步骤。2026-09-30 整理至独立集成候选；按用户要求，配置兼容性确认继续后移，本页不要求当前提交配置、不阻塞功能开发或集成。真实模型、图形与平台验收仍归 [RA-21](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-21e0-真实工程任务)，状态 **pending**。

## 已确定的条件与剩余信息

| 项目 | 当前选择 |
| --- | --- |
| 运行平台 | Windows，替代此前的 Mac 选择 |
| 模型来源 | cc-switch 当前转发配置或代理服务 |
| 评估预算 | 用户不设置单轮及整批费用、请求数或时长上限；不再要求填写一个有限额度 |
| 审批 | 沿用逐次确认；预算选择不改变工具审批方式 |
| 应用版本 | 同一批固定完整 commit，并确认实际启动的是该版本 |
| 正式矩阵 | Native / Claude × 3 项任务 × 2 轮，共 12 轮 |

后续正式运行时再核对本机服务的 **API 基础地址、准确模型 ID、协议类型和凭据读取方式**，并保存 cc-switch 服务页面的脱敏截图或摘要；当前无需提供配置或密钥。凭据来源只记“进程环境变量名”“本次内存”或“本机系统加密存储”等引用。

此开发环境是 Linux，不能读取用户 Windows 的 cc-switch、启动该机器的桌面程序或访问该机器的 `localhost`。这里完成的准备和测试不能登记为 Windows 实测。

## 两个引擎如何使用连接

| 引擎 | 当前实现 | 执行前确认 |
| --- | --- | --- |
| Claude | 启动本机 Claude CLI，由 CLI 处理其配置与认证；cc-desk 不导入 cc-switch 数据库 | 核对当前 CLI、会话 `/status` 与实际转发配置，不把“配置存在”当作服务已可用 |
| Native | 使用独立的模型连接，仅支持 `responses` / `chat-completions` | 在设置中录入代理暴露的对应 OpenAI 兼容接口与模型 ID；不自动继承 Claude 配置 |

如果代理只暴露 Anthropic Messages（`/v1/messages`），当前 Native 不能直接使用它。后续实际接入时核对同一代理是否另有 Responses / Chat Completions 接口；确实只有 Messages 时，再作为 N4 的具体协议适配需求处理，不猜测接口地址，也不将这项核对提前作为当前集成条件。

若代理会重写模型别名、自动切换上游或故障转移，保留实际路由的非敏感证据。两边使用相同模型名称不能证明调用的是相同后端；无法固定时须在对照报告披露。

## 后续 Windows 本机最小连接确认

以下步骤在恢复正式评估时执行，本轮代码集成不发起模型请求。

1. 在 cc-switch 选定服务并确认转发已启动，记录非敏感的地址、协议、模型 ID。保持本轮配置固定。
2. 在 cc-desk 的“设置 → 连接与终端 → Native 模型连接”新增连接，选择对应协议，填写 **API 基础地址**与默认模型。基础地址不含最后的 `/responses` 或 `/chat/completions`；实际前缀以代理配置为准。
3. 本机回环 HTTP 需勾选允许；远程服务使用 HTTPS。地址中不放账号、密码、查询令牌或片段。
4. 先保存连接，再在本机配置凭据。支持环境变量、仅本次内存、可用时的系统加密存储。环境变量必须由 cc-desk 主进程继承，修改后重启应用；Claude `settings.json` 的 `env` 不会自动成为 Native 的进程环境变量。当前没有匿名认证模式，代理需要的凭据以它的配置为准，不随意填假密钥。
5. 执行“测试连接”。该操作实际发出一次文本请求，输出上限 256 tokens、时限 30 秒，不调用工具、不重试。成功只证明这次文本请求与流响应可用；本地“就绪”状态仅表示配置可解析。
6. 在可丢弃的独立目录新建 Native 会话，选择该连接，验证读文件、批准一次文件修改、执行一次无副作用命令、取消与状态刷新。为 Claude 新建同等独立现场完成相同确认。保留截图、日志和失败；这些预检不计作 12 轮工程成功。

凭据通过本机界面录入，不写入 TASK.md、仓库、评估记录或报告。连接测试使用所选服务，属于本次已授权评估准备的一部分，无需再要求一个费用上限。

## 无上限记录与实际运行限制

新增 `engineering-init ... --unlimited-budget` 创建 **schemaVersion 2 的运行记录**：六项评估执行预算及费用预算为字符串 `"unlimited"`，保留未配置字段及未知实际指标为 `null`。不提供此参数仍生成原有 v1 记录，固定任务套件 v1 的材料、模板与摘要保持不变。

`unlimited` 表示用户未额外设置评估额度，不代表应用已经支持无限单回合运行。当前桌面默认值如下，真实执行时把所用值保存在 `configurationReference` 指向的配置快照中：

| Native 运行参数 | 当前默认值 | 含义 |
| --- | --- | --- |
| `maxModelRequests` | 30 | 每回合模型请求上限 |
| `maxToolCalls` | 60 | 每回合工具调用上限 |
| `maxActiveMs` | 600000 ms | 每回合主动运行时长，审批等待豁免 |
| `maxInputTokens` | 64000 | 本地上下文输入估算上限，不是整轮累计 token |
| `maxOutputTokens` | 8192 | 每次请求输出上限，不是整轮累计 token |

本次不改这些参数、服务实际上下文窗口、工具超时、取消或未知副作用停止机制。遇到运行限制，先记录真实停止原因和原回合结果；后续续聊、配置调整与人工救援另行登记，不能覆盖原失败。费用未知仍是 `null`，即使预算无限也不填成零；已知费用保留实际币种。

预算中的 `approvalPolicy` 填 `逐次确认`。`stopConditions` 可记录 `用户取消`、`运行限制耗尽`、`不可恢复错误`、`结果未知需核查` 与 `任务完成待独立验收`。这些是实际停止条件，不是额外收费额度。

批次 manifest 仍为 v1，没有整批预算字段；本页保存本次“整批不设上限”的决定，实际操作者在批次外保留对应快照。只读检查中的 `batchBudgetStatus: external_confirmation_required` 表示检查器不读取外部预算决定，不表示需要用户再次批准已确定的无上限预算。`executionAuthorized: false` 同样只是只读检查不签发执行授权。

## 后续 PowerShell 评估入口

以下在已包含本次改动的评估者仓库根目录执行。路径是示例，请先替换为新的绝对路径；批次、报告和候选项目均位于评估者仓库之外。实际应用版本必须单独核对，不能只因 `git rev-parse` 成功就认定正在运行对应二进制。

```powershell
$e0AppRevision = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法取得应用候选 commit' }
$e0Batch = 'C:\cc-desk-e0\batch-01'
node scripts/native-eval.mjs engineering-init $e0Batch $e0AppRevision --unlimited-budget
if ($LASTEXITCODE -ne 0) { throw '初始化失败；不要覆盖已有批次' }
node scripts/native-eval.mjs engineering-readiness $e0Batch
```

初次检查应为 `blocked`：模型、协议、配置/凭据来源、审批和停止条件尚未填写，而显式 `unlimited` 不再被报为预算缺失。使用 UTF-8 编辑每个 `records/<runId>.json` 后再检查；不要打印或提交本机密钥。每轮保留应用 commit、Windows/CLI 版本、配置快照和人工介入记录。

候选的任务基线固定为 `b45bd0623d2a44a2878c46d4701fa4b388c7d9be`，按 [E0-01 隔离步骤](NATIVE-AGENT-E0.md#3-材料隔离与现场准备)准备 12 个独立现场。只给模型任务代码、对应 TASK.md 及必要注入，不提供参考 patch 或验收器；Windows 文件读取边界由外层账号或隔离环境落实，目录分开本身不构成隔离。

最小链路通过后，逐轮完成任务并记录结果，再从评估者目录执行独立验收。例：

```powershell
node scripts/native-eval.mjs engineering-verify $e0Batch native-01-snapshot-refresh-r1 'C:\cc-desk-e0\native-refresh-r1'
# 验收失败也保留本次尝试，再汇总全部轮次；报告使用新文件名。
New-Item -ItemType Directory -Force 'C:\cc-desk-e0\reports' | Out-Null
node scripts/native-eval.mjs engineering-report $e0Batch 'C:\cc-desk-e0\reports\report-01.json'
```

验收器默认 120 秒、最大 300 秒是候选代码检查的现有时限，与用户模型费用预算不同。依赖准备、独立验收与报告要求沿用 [E0-02](NATIVE-AGENT-E0-REPORTS.md)。真实服务、Windows 交互和 12 轮结果尚未执行；不会用本地 fixture 代替。

## 无上限记录的既有本地验证

以下为原本地提交 `8324d23e92e571b760a40663da255b557de079ab` 及文档提交 `80532da0b2c620881b817b68fab9d1ebd5f2afa7` 所登记的结果；本次集成迁入该实现，合并候选仍须单独验证。原批次仅修改评估脚本和文档。Linux / Node.js 24.19.0 下执行 `node --test scripts/tests/*.test.mjs`，**50 项通过，0 失败、0 跳过**，包括新增的 5 项无上限预算回归。覆盖 v1 兼容、v2 初始化/只读检查/报告对照、未知指标、有限与无限时长组合、历史验收快照和非法 CLI 参数不落盘。随后将新测试临时目录归一为真实路径，避免 macOS `/var` 别名导致误报，并单独重跑这 5 项。

固定套件 v1 未修改，脚本语法及 `git diff --check` 通过。未调用真实模型、启动 Windows 桌面或触发 CI、平台打包与 Release；Claude 保持默认。PowerShell 步骤已按代码核对，尚未在用户 Windows 实际执行。
