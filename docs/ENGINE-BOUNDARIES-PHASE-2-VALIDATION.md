# 阶段二实现与验收记录

日期：2026-09-25。开发集成分支：`dev/native-agent`；阶段分支：`refactor/engine-boundaries`。本阶段不合入 main、不发布 Release。

状态：**实现验证中**。本文记录当前实现、数据恢复方式和待完成的验收，不代表三平台已通过。最终候选提交 SHA、CI 运行链接及结果由集成验收后补齐。

关联：[阶段二计划](ENGINE-BOUNDARIES-PHASE-2.md)、[总体计划](NATIVE-AGENT-PLAN.md)、[阶段一验收](MONOREPO-PHASE-1-VALIDATION.md)、[CLI 更新说明](CLI-UPDATES.md)。

## 实现映射

下列路径相对于仓库根目录；测试文件列出对应验证入口，不等同于已获 CI 结果。

| 范围 | 当前实现 | 主要位置 / 验证入口 |
| --- | --- | --- |
| 公共契约 | 引擎身份、能力、配置封装、描述、事件及执行生命周期；共享类型不要求 Claude 的模型、effort 或权限枚举 | `packages/contracts/src/{execution,execution-ports}.ts`；contracts 公共导出测试 |
| Claude 包 | `ClaudeRuntime`、配置、CLI 探测/参数、协议、transcript 和 hooks；通过宿主端口读写桌面数据 | `packages/engine-claude/src/`；`apps/desktop/src/main/engines/claude/{host,session,structured-executor,terminal-launcher}.ts` |
| 构建和依赖 | npm workspaces、单一根锁文件，顺序为 contracts → engine-claude → desktop；内部包为 private，PTY 及 Electron 生命周期留在 desktop | 根 `package.json`；各 workspace manifest；桌面构建与打包脚本 |
| 唯一配置来源 | `Session.engineConfig = { schemaVersion, options }`，设置使用 `engineDefaults`；适配器负责字段语义、支持版本和已确认配置回写 | shared `types.ts`、`schema.ts`；`execution/registry.ts`；Claude `config.ts`；`session-creation.ts`、`ipc/session-handlers.ts` |
| v3 数据迁移 | 仅磁盘读取兼容 v1/v2，运行中写入只接受 v3；保留原始迁移快照，拒绝损坏或未来版本覆盖 | `shared/workspace-v2.ts`、`shared/schema.ts`、`main/store.ts`；`tests/workspace-v3.test.ts` |
| 引擎维护 | `withEngineMaintenance('claude', action)`；服务先关闭目标准入，再暂停队列、中断工作流并等待目标资源；共享 PTY 使用选定会话范围 | `session-service.ts`、`execution/{registry,terminal-executor}.ts`、`runtime.ts`、`chat-queue.ts`、`workflows.ts` |
| 迟到操作与退出 | 维护代次使旧创建/附件/排队操作失效；等待队列 completion 和工作流所有权；保存失败仍清理其余目标；全局退出不被维护 finally 重新开放 | 对应 service/runtime/queue/workflow 单元测试；`cli-update-service.ts`、`index.ts`、`tests/cli-update.{test,spec}.ts` |
| 描述和界面 | 主进程刷新执行器描述；创建、配置与操作入口按 provider、mode、能力、可用及维护状态处理 | `index.ts`、preload；renderer `EngineConfiguration.tsx`、`App.tsx`、会话/历史组件 |
| 历史来源和离线读 | 外部历史查询带 provider 身份；缺失执行器或不支持的配置保留数据，结构化会话可被动读取宿主已有展示记录 | `execution/{history-sources,offline-history,routers}.ts`；workspace/history IPC 与 renderer 历史入口 |
| 异构引擎与目录保护 | 测试引擎通过真实创建、service 和 IPC 链路验证独立配置及运行；跨引擎共享容量与 Git/worktree 管理锁继续生效 | `tests/{execution-contracts,session-creation,session-service}.test.ts` 及引擎界面 fixture；不作为正式产品入口 |

正式应用仍只装配 Claude structured、Claude terminal 与 Shell，默认新建 Claude structured。P2 没有提供可启用的真实 native 模型连接或编码引擎。

## workspace v3 与备份

应用名称、应用 ID 和默认 Electron userData 路径沿用阶段一；准确数据目录从设置中查看。不要根据仓库所在位置猜测用户数据路径。应用版本号仍与 workspace 数据版本分别管理。

| 输入 | v3 处理 |
| --- | --- |
| v1 Claude / Shell | 先沿用旧身份迁移，再转为 v3；本地会话 ID、对话身份、项目及路径关联保留 |
| v2 Claude | 原 `model`、`effort`、`permissionMode` 原值进入 `engineConfig.options`，`schemaVersion: 1`；原默认权限进入 `settings.engineDefaults.claude` |
| v2 Shell | `schemaVersion: 1`；全默认的旧字段转换为空 options，非默认旧值保存在 `options.legacy`，不应用 Claude 语义 |
| v2 其他 provider | 旧 schema 接受的配置字段保存在 `schemaVersion: 0` 的兼容载荷；不会猜测其含义或自动执行 |
| v3 未知 provider / 配置版本 | 保留符合通用 JSON 边界的原配置；执行入口给出不可用原因，不替换成 Claude 配置 |
| 格式损坏 / workspace 版本大于 3 | 启动明确报错，保留原文件，不写空工作区 |

`StateStore` 先在内存解析旧格式。首次写入 v3 之前，按以下顺序保存：

1. 在同一数据目录以独占创建方式写入 `workspace.pre-v3.<UUID>.json`，保存读取时的**完整原始文件内容**，并同步到磁盘。源文件可能是 v1 或 v2，文件名前缀统一为 `pre-v3`。
2. 写入并同步 `workspace.json.tmp`；把当前 `workspace.json` 复制到滚动备份 `workspace.json.bak`，再将临时文件重命名为 `workspace.json`。
3. 原始快照创建失败时，不替换旧工作文件。后续写入失败时保留错误供重试；同一 `StateStore` 实例重试会复用已成功写入的迁移快照。成功迁移后再次启动或普通保存不会改写这份快照。

`workspace.json.bak` 会在后续保存中滚动替换，不能作为固定的跨版本恢复点。多次从旧格式迁入可能产生多份 `workspace.pre-v3.*.json`；恢复时必须核对其内容与备份时间，不自动选择文件名排序的最后一项。

迁移不搬动 `chat/`、`attachments/`、`logs/`、`workflows.json`、Claude 原始 transcript 或现有 worktree，也不启动旧任务。启动时遗留的运行状态会按现有恢复规则归为停止/中断。迁移快照只保存工作区元数据，不包含上述全部内容或工作目录的文件。

## 回退到 workspace v1/v2 应用

回退不是修改 JSON 的 `version` 数字，也不是仅把 Git 分支切回旧代码。按下列顺序操作：

1. 完全退出新版，包括托盘进程。若 CLI 正在实际安装更新，先等安装结束再退出，见下节。
2. 复制**整个当前 userData 目录**到独立位置，保留现有 `workspace.json`、滚动备份、所有迁移快照、聊天、附件、工作流和日志。另行保全项目及外部 worktree；需要完整重现旧状态时，也应有升级前对应目录的备份。
3. 优先恢复升级前保存的完整数据目录。若只有自动迁移快照，打开所选 `workspace.pre-v3.<UUID>.json`，确认其中 `version` 为旧应用支持的 1 或 2，核对项目、会话及路径。保留该快照原文件，将其**复制**为数据目录中的 `workspace.json`，覆盖操作只在第 2 步备份完成后进行。
4. 使用明确的旧应用版本启动，确认项目、会话及路径后再恢复工作。旧版应拒绝直接加载 v3；其固定版本验证结果列入下方验收表，不能依赖旧版自动降级。

自动快照恢复的是迁移前的工作区登记与配置。迁移后的新增会话、设置和草稿不会倒灌到旧格式；单独恢复 `workspace.json` 也不会回滚日志、附件、工作流或项目文件。保留第 2 步副本供之后重新使用新版或人工核对，不混用新旧应用同时写同一数据目录。需要返回新版时，退出旧版后恢复保存的完整新版数据目录。

## CLI 维护与退出行为

CLI 更新确认后只维护 Claude 会话：暂停 Claude 队列、中断 Claude 工作流，停止 Claude structured/terminal 进程与相关子进程，并等待目标启动、停止、hooks 和清理资源。目标记录保存或资源释放失败会取消安装，且仍尝试清理其他目标。Shell 和其他已注册引擎可继续使用，仍受正常容量和跨引擎目录管理限制。

维护期间 Claude 的启动、发送、创建/导入、配置修改、命令准备、队列继续及工作流推进被拒绝；已有记录阅读、导出、普通草稿保存和停止/取消仍可用。维护完成不会自动重跑原任务、队列或工作流。

退出请求会使尚未开始安装的更新失效；全局 shutdown 仍按物理执行器去重并清理所有引擎，维护结束的 finally 不会清除 quitting。**实际更新已进入 `updating` 阶段时，正常退出请求会显示“请等待安装完成后再退出”并保持应用打开**，以免在 CLI 安装写入期间直接杀死安装器。此保护覆盖安装及其完成后的校验/刷新，不取消既有更新命令超时机制，也不承诺抵御操作系统强制结束进程或断电。

## 已获本地证据

以下是开发工作树的定向结果，尚不能替代固定候选提交的三平台验收。环境：Linux x64，Node.js 22.23.3 / npm 10.9.9。

| 检查 | 已记录结果 |
| --- | --- |
| 根 `npm run check` | 通过：contracts 3/3、engine-claude 11/11、desktop 428 项中 427 通过、1 项平台跳过；包含 TypeScript 与生产构建 |
| `session-service.test.ts`、`cli-update.test.ts`、`runtime.test.ts` 完整定向运行 | 通过；包含共享真实 PTY、目标 prepare/cleanup/后代等待、Shell 交互、保存失败与退出竞态 |
| `chat-queue.test.ts`、`workflows.test.ts` 完整定向运行 | 通过；包含目标范围、迟到操作、保存失败与 completion 等待 |
| 随后新增的 queue completion ownership 服务回归 | 通过；模型 admission 释放后，排队回执仍未完成时安装继续等待 |
| desktop `npm run typecheck` | 通过 |
| `git diff --check` | 通过 |

上述测试不使用真实模型账户，也不证明真实 native 编码能力。UI 与三平台固定候选结果待下方记录。

固定旧版拒绝 v3 已单独验证：从 `c2d0742e10113024c9e858336bd9b041a2541d8b` 提取原始 `StateStore` 与 shared 依赖，逐字节核对 `git show` 内容后读取当前代码生成的 v3 工作区。旧版明确报告工作区无法读取、原文件已保留；工作区前后 SHA256 相同，整个测试数据目录的文件名、权限、大小及内容哈希均不变，没有新增 `.tmp` 或 `.bak`。当前版本随后重新读取成功。该验证没有降级、覆盖实际用户数据。

## 固定候选与三平台验收

最终候选 SHA：**待填写**。PR 快速检查链接：**待填写**。三平台完整 workflow 链接：**待填写**。所有通过记录须对应同一候选提交；源码修复后重跑受影响门槛并更新证据。

| 平台 | 干净安装 / 类型 / 包与单元测试 / 构建 | 源码 Electron 回归 | 分发产物与实际包启动 | 状态 |
| --- | --- | --- | --- | --- |
| Linux x64 | 待跑 | 待跑 | AppImage、tar.gz；默认 userData、engine-claude、真实 PTY | 待跑 |
| macOS arm64 | 待跑 | 待跑 | DMG、ZIP；默认 userData、spawn-helper、真实 PTY | 待跑 |
| Windows x64 | 待跑；含固定 npm Claude launcher 验证 | 待跑 | NSIS、便携 EXE、ZIP；默认 userData、原生资源、安装/卸载 | 待跑 |

| 跨平台专项 | 待补证据 |
| --- | --- |
| v1/v2→v3 保真、独立快照、二次启动、写入失败与未来版本拒绝 | 固定候选单元结果；实际桌面旧数据启动结果 |
| 固定旧版读取 v3 | 记录旧版本/提交、拒绝信息及工作文件未覆盖的证据 |
| 真实包加载内部引擎 | 包内运行代码可加载、无源码路径依赖；原有应用/userData 身份不变 |
| Claude scoped 更新 | 安装前完整释放 Claude；Shell 持续输入和运行；失败后目标任务保持停止；无自动重放 |
| 未安装 Claude / 异构测试引擎 / 未知 provider | 主进程能力检查、界面描述刷新、独立配置、只读历史及迟到事件隔离 |
| 同目录保护 | 非 Claude 活动会话、来源依赖和关闭中的进程继续阻止 worktree 管理 |

根目录 `npm run check` 覆盖依赖顺序构建、desktop 类型检查、contracts/engine-claude/desktop 测试及生产构建。`npm run test:e2e` 使用已有构建；三平台 workflow 先执行 check，再跑 Electron 回归、各平台打包和 `test:packaged`。记录真实通过/跳过数量和跳过原因；不得把未运行项目填写为通过。本阶段保持 `publish_release: false`。

## 已知边界

- 真实 native 模型协议、工具循环、密钥/连接管理、检查点和可恢复的模型上下文属于 P3；测试引擎只用于验收公共边界。宿主聊天展示日志不能代替 native 完整运行日志。
- 未知 provider 或未知配置版本保留原数据；结构化会话可以读取已有宿主展示日志，无日志时明确提示。不会尝试 Claude transcript 补全，不恢复审批或自动继续队列；不承诺缺失适配器时可导出、删除或完整管理该会话。
- 共享容量和 Git/worktree 目录管理锁仍有效，但它们不是所有工具写入的租约。同 cwd 的真实 Claude/native/Shell 并发写入安全没有在 P2 解决；P3 开放 native 编码前必须补齐。并存测试使用独立目录或无副作用任务。
- CLI 更新仍依赖本机安装方式、权限和网络；既有代理/仓库限制见 [CLI 更新说明](CLI-UPDATES.md)。桌面应用仍不自动更新，本阶段不新增签名、公证或 Release 发布。
