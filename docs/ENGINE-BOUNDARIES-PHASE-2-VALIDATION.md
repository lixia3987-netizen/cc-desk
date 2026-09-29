# 阶段二实现与验收记录

日期：2026-09-25。开发集成分支：`dev/native-agent`；阶段分支：`refactor/engine-boundaries`。本阶段不合入 main、不发布 Release。

状态：**已完成，三平台验收通过**。最终代码候选为 `a4e34ce736dd59a6c29ca3a5878a64d0a10b2711`。本文区分该候选的最终证据、前两轮失败记录及本地验证，不把不同提交的结果拼接为通过。

关联：[阶段二计划](ENGINE-BOUNDARIES-PHASE-2.md)、[总体计划](NATIVE-AGENT-PLAN.md)、[阶段一验收](MONOREPO-PHASE-1-VALIDATION.md)、[CLI 更新说明](CLI-UPDATES.md)。

## 实现映射

下列路径相对于仓库根目录；测试文件列出对应验证入口，不等同于已获 CI 结果。

| 范围 | 当前实现 | 主要位置 / 验证入口 |
| --- | --- | --- |
| 公共契约 | 引擎身份、能力、配置封装、描述、事件及执行生命周期；共享类型不要求 Claude 的模型、effort 或权限枚举 | `packages/contracts/src/{execution,execution-ports}.ts`；contracts 公共导出测试 |
| Claude 包与宿主边界 | `ClaudeRuntime`、配置、CLI 探测/参数、协议、transcript 和 hooks；通过窄宿主端口读写桌面数据，不接受 Store/AppState | `packages/engine-claude/src/host.ts`；desktop `engines/claude/{host,session,structured-executor,terminal-launcher}.ts`；包内 `public-exports.test.mjs`、`runtime-host.test.mjs` |
| 提包后的真实链路 | 公共包入口 → desktop host → 真实 SessionCreation/SessionService/IPC → fixture 子进程 → 日志与配置；重启分页、搜索和导出；关键写盘失败不得报告成功 | `apps/desktop/tests/engine-host-integration.test.ts`；已有 chat/runtime/history/PTY 回归 |
| 构建和依赖 | npm workspaces、单一根锁文件，顺序为 contracts → engine-claude → desktop；内部包为 private，PTY 及 Electron 生命周期留在 desktop | 根 `package.json`；各 workspace manifest；桌面构建与打包脚本 |
| 唯一配置来源 | `Session.engineConfig = { schemaVersion, options }`，设置使用 `engineDefaults`；适配器负责字段语义、支持版本和已确认配置回写 | shared `types.ts`、`schema.ts`；`execution/registry.ts`；Claude `config.ts`；`session-creation.ts`、`ipc/session-handlers.ts` |
| v3 数据迁移 | 仅磁盘读取兼容 v1/v2，运行中写入只接受 v3；保留原始迁移快照，拒绝损坏或未来版本覆盖 | `shared/workspace-v2.ts`、`shared/schema.ts`、`main/store.ts`；`tests/workspace-v3.test.ts` |
| 引擎维护 | `withEngineMaintenance('claude', action)`；服务先关闭目标准入，再暂停队列、中断工作流并等待目标资源；共享 PTY 使用选定会话范围 | `session-service.ts`、`execution/{registry,terminal-executor}.ts`、`runtime.ts`、`chat-queue.ts`、`workflows.ts` |
| 迟到操作与退出 | 维护代次使旧创建/附件/排队操作失效；等待队列 completion 和工作流所有权；保存失败仍清理其余目标；全局退出不被维护 finally 重新开放 | 对应 service/runtime/queue/workflow 单元测试；`cli-update-service.ts`、`index.ts`、`tests/cli-update.{test,spec}.ts` |
| 描述和界面 | 主进程刷新执行器描述；创建、配置与操作入口按 provider、mode、能力、可用及维护状态处理 | `index.ts`、preload；renderer `EngineConfiguration.tsx`、`App.tsx`、会话/历史组件 |
| 历史来源和离线读 | 外部历史查询带 provider 身份；缺失执行器或不支持的配置保留数据，结构化会话可被动读取宿主已有展示记录 | `execution/{history-sources,offline-history,routers}.ts`；workspace/history IPC 与 renderer 历史入口 |
| 异构引擎与目录保护 | 测试引擎通过真实创建、service 和 IPC 链路验证独立配置及运行；跨引擎共享容量与 Git/worktree 管理锁继续生效 | `tests/{execution-contracts,session-creation,session-service}.test.ts` 及引擎界面 fixture；不作为正式产品入口 |

正式应用仍只装配 Claude structured、Claude terminal 与 Shell，默认新建 Claude structured。P2 没有提供可启用的真实 native 模型连接或编码引擎。`engine-ui.spec.ts` 通过测试专用 esbuild 重定向向隔离测试 bundle 注入假引擎，并检查正式 bundle 不含 `test.native`；正式源码没有 renderer 可开启的假引擎开关，测试 bundle 不写入 `apps/desktop/dist` 或分发包。

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

上述测试不使用真实模型账户，也不证明真实 native 编码能力。它们属于开发过程证据；固定候选结果单独记录于下方，不以本地通过替代三平台验收。

固定旧版拒绝 v3 已单独验证：从 `c2d0742e10113024c9e858336bd9b041a2541d8b` 提取原始 `StateStore` 与 shared 依赖，逐字节核对 `git show` 内容后读取当前代码生成的 v3 工作区。旧版明确报告工作区无法读取、原文件已保留；工作区前后 SHA256 相同，整个测试数据目录的文件名、权限、大小及内容哈希均不变，没有新增 `.tmp` 或 `.bak`。当前版本随后重新读取成功。该验证没有降级、覆盖实际用户数据。

## 固定候选与三平台验收

最终代码候选：`a4e34ce736dd59a6c29ca3a5878a64d0a10b2711`；代码 PR：[#29 → dev/native-agent](https://github.com/lixia3987-netizen/cc-desk/pull/29)。[PR 快速检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107479628)：**通过（contracts 3/3、engine-claude 11/11、desktop 427 通过/1 跳过；类型检查与构建通过）**。[三平台完整验收 #37](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107597893)：**全部通过，发布作业跳过**。开发分支集成记录：代码 PR #29 已合入 `dev/native-agent`，合并提交为 `27c6a187c04eb9ec6d560e44eead27644c191ceb`；其完整 Git tree 与已验证候选相同（`363f76a184e8f9fb37f65cb5a3c7535cbac4538c`）。main 仍为 `a3f94b6c74f2abfad7a38306803319226dd5d436`。

所有最终结果必须对应上述同一源码候选。本文与配套状态更新通过独立文档 PR 进入 `dev/native-agent`，不修改应用代码、测试或构建逻辑；安装包证据对应固定代码候选，后续文档提交不重新生成分发包。不合入 main、不发布 Release。

| 平台 / 作业证据 | 干净安装、类型检查与生产构建 | contracts / engine-claude / desktop 单测 | 源码 Electron 回归 | 实际成品测试 |
| --- | --- | --- | --- | --- |
| [Linux x64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107597893/job/107983610177) | 全部通过 | 3 / 11 / 427 通过；desktop 1 项平台跳过 | 59 通过，0 项平台跳过，无失败 | 3/3 通过：默认数据目录、tar、AppImage 解包运行 |
| [macOS arm64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107597893/job/107983610102) | 全部通过 | 3 / 11 / 424 通过；desktop 4 项平台跳过 | 59 通过，0 项平台跳过，无失败 | 3/3 通过：默认数据目录、ZIP、DMG 复制后运行 |
| [Windows x64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107597893/job/107983610000) | 全部通过 | 3 / 11 / 404 通过；desktop 24 项平台跳过 | 57 通过，2 项平台跳过，无失败 | 3/3 通过：默认数据目录、ZIP、NSIS 安装运行及卸载 |

Windows 固定 npm Claude Code `2.1.278` 的真实 launcher 专项：**通过：使用 npm 实际安装的固定 2.1.278 启动器完成验证**。产物归档、各平台 `packaged-manifest.json` 的 `sourceCommit` / `verified` 核对与发布作业结果：三个分发文件归档与三个测试报告归档均已上传至同一运行；三份 `packaged-manifest.json` 均为 `verified: true`、`sourceCommit: a4e34ce736dd59a6c29ca3a5878a64d0a10b2711`，所列实际运行包的 SHA256 已记录。下载的三份测试报告 ZIP 的 SHA256 与 GitHub artifact digest 一致；没有在本地重复下载大分发归档。三个平台的成品 JSON 结果均为 3 通过、0 失败、0 跳过、0 flaky。发布作业为 `skipped`，未发布 Release。

成品验证的实际范围如下；表中的范围不是未获结果的通过声明：

| 平台 | 构建文件 | 实际运行范围与限制 |
| --- | --- | --- |
| Linux x64 | AppImage、tar.gz | tar 解包运行；AppImage 用 `--appimage-extract` 解包后运行，**没有验证 FUSE 挂载启动** |
| macOS arm64 | DMG、ZIP | ZIP 解包运行；DMG 只读挂载后复制 `.app` 并运行；检查 PTY spawn-helper |
| Windows x64 | NSIS setup.exe、portable.exe、portable.zip | ZIP 解包运行；NSIS 安装、运行与卸载；自解压 portable.exe 仅构建及文件存在/大小检查，**未单独启动** |

每个平台的成品测试包括一次性 CI 用户下的默认 userData/应用身份探针，以及两种实际包的 PTY、持久化、旧 v1→v3、不可变原始迁移快照、第二实例、正常退出、v3 再次启动和包内资源断言。默认 userData 探针不设置隔离 profile 参数，拒绝既有数据目录，并在确认应用退出及目录归属后清理新建目录；本地运行明确跳过这一探针。内部 engine-claude 代码随主进程 bundle 分发，不依赖工作区源码或独立 Electron 宿主之外的加载路径。

所有产物均未进行签名、公证、SmartScreen 或 Gatekeeper 接受验证。构建和运行验证不能替代这些分发信任检查。

### 平台跳过与覆盖变化

以下跳过分类已从最终 #37 日志逐项核对，与 #36 相同，数量未扩张；最终通过与跳过数量见上表。

| 平台 | desktop 单测跳过 | 源码 E2E 跳过 |
| --- | --- | --- |
| Linux | 1 项 Windows 专属 native/legacy 真实 invocation 探针 | 0 |
| macOS | 4 项：1 项 Windows 探针、3 项 Linux/Xvfb runner 测试 | 0 |
| Windows | 24 项：6 项 symlink fixture、6 项 POSIX 进程组/信号/后代 fixture、3 项 POSIX npm launcher、2 项 POSIX CLI updater、3 项 Linux/Xvfb runner、4 项 POSIX IDE/macOS `.app` fixture | 2 项既有 POSIX 可执行/shebang fixture：structured 协议、真实 IDE launcher |

与阶段一最终发现清单相比，desktop 单测从 382 项增至 428 项，源码 E2E 从 56 项增至 59 项，contracts 保留 3 项，engine-claude 新增 11 项；成品入口仍为每平台 3 项，并增加真实 v3 迁移及二次启动断言。Windows 单测增加的 1 项跳过是使用 `ps`、SIGTERM/SIGHUP 的目标后代资源 fixture；核心 Claude/Shell 并存、共享容量、维护屏障、注册/配置/迁移和新增引擎 UI 场景没有因此跳过。未通过删除用例、提高布局容差或增加重试来形成通过结果。

### 专项证据映射

| 范围 | 对应证据 |
| --- | --- |
| 包边界、普通 Node 加载、声明和依赖隔离 | contracts/engine-claude `public-exports.test.mjs`；最终包测试及三平台构建 |
| 公共包→宿主→真实服务→子进程→持久化 | `engine-host-integration.test.ts`：审批 wire ID 映射与旧响应失效、模型确认后权限失败仍保存已确认配置、重启、分页、搜索、导出和写盘失败 |
| 宿主审批代次及配置失败 | engine-claude `runtime-host.test.mjs`：跨会话/回合审批隔离、观察者异常、部分配置确认及宿主配置写盘失败 |
| v1/v2→v3 保真与失败保护 | `workspace-v3.test.ts`、现有 v1 fixture；成品实际 v1→v3、逐字节快照和 v3 重启断言 |
| 固定旧版拒绝 v3 | 上述 `c2d0742e10113024c9e858336bd9b041a2541d8b` 本地旧 reader 检查：拒绝读取、原工作文件和整个测试数据目录保持不变 |
| Claude 范围维护与全局退出 | service/runtime/queue/workflows/CLI 更新单测及 `cli-update.spec.ts`；只释放目标，Shell 持续输入，保存/停止失败取消安装，迟到操作失效 |
| 未装 CLI、异构配置与未知 provider | execution-contracts/session-creation/workspace-v3 单测及 `engine-ui.spec.ts`；真实 IPC 与独立测试 bundle，不添加生产假引擎入口 |
| 跨引擎目录管理保护 | service/runtime 的 cwd、worktree 来源依赖、活动任务与关闭资源回归；不承诺工具写入租约 |

根 `npm run check` 覆盖依赖顺序构建、desktop 类型检查、contracts/engine-claude/desktop 测试及生产构建。三平台 workflow 先运行 check，再运行源码 Electron、平台分发构建和 `test:packaged`。本阶段始终设置 `publish_release: false`；未运行项目必须如实标记，不计为通过。

## 迭代中的失败与修复

[首轮 #35](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36104037415) 对应 `d326be03649c8d82c3e7871bda0ea9fdd256b56b`，结论为失败。Linux/macOS 契约、引擎包测试与基础检查通过后，源码 E2E 分别为 57/59、56/59；Windows desktop 为 403 通过、1 失败、24 跳过，后续源码/成品没有运行。三个平台的成品测试均未执行。

- 未安装 CLI 的结构化提示放在工作台顶端，增加高度并破坏紧凑布局；同时「开始输入」错误地依赖 CLI 可用性，阻止单纯聚焦草稿。修复将结构化提示移入 composer，保留可见状态提示，并让草稿聚焦只受原有 busy/archived 限制。原两项 experience 回归本地 2/2 通过；未修改测试阈值或 fixture。
- macOS inspector 还出现等宽列 317px 而预期 320±0.5px；没有放宽容差，只增加失败时的容器/滚动条/面板几何诊断。该用例在下一轮原断言下通过；不将缺少当时 DOM 证据的滚动条推断写成已确证根因。
- Windows 维护 fixture 原来只运行定时器，未模拟驻留 Claude 的 Ctrl-C 行为，失败最终显示为 shutdown 资源未释放且缺少内部原因。fixture 改为先注册 SIGINT 再报告 ready，父测试等待中断确认并保留驻留断言；增加 activeCount、cleanup 和错误断言与阶段诊断。未放松生产清理逻辑，下一轮该测试通过。
- 同一修复候选还将未改变的引擎默认配置比较改为深值比较，避免对象键顺序变化使未知配置被误当成编辑；新增 UI 回归保留未知配置并检查实际改变仍被拒绝。

[第二轮 #36](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36105517766) 对应 `b7cfe8e399c30dbdb830e027486b41d52bc3192f`，结论仍为失败。三平台 contracts 3/3、engine-claude 11/11 通过，desktop 分别为 Linux 427 通过/1 跳过、macOS 424/4、Windows 404/24。源码 E2E 为 Linux 59/59、Windows 57 通过/2 跳过、macOS 57/59；第一轮三个 UI 失败均已通过。Windows 固定 npm launcher 专项通过。

- macOS 两个 Mermaid 用例等待未进入可视范围的惰性渲染块而超时。`a4e34ce` 仅在断言前将目标块滚入可视范围，保留真实 SVG、错误恢复、主题、安全和源码断言及原超时，没有修改产品渲染实现。
- Linux/Windows 已成功构建分发文件，但成品各为 1 通过、2 失败：旧测试把新建的 v3 Shell 数据仅改写 version/identity 后作为 v1，遗漏旧格式必需的 model/effort/permissionMode，导致第二次启动拒绝读取。`a4e34ce` 生成真实合法 v1 输入并先经历史 schema 检查，再让实际成品迁移；新增 engineConfig、逐字节不可变快照、滚动备份及第三次 v3 启动断言。原第二实例和进程退出断言保留。

#36 的 Linux/Windows 成品仅完成首次 PTY、持久化和退出，后续旧数据与第二实例断言未到达；其 manifest 为 `verified: false`。macOS 因源码 E2E 失败没有运行打包或成品测试。两轮失败均不计作最终候选的成功证据。

## 已知边界

- 真实 native 模型协议、工具循环、密钥/连接管理、检查点和可恢复的模型上下文属于 P3；测试引擎只用于验收公共边界。宿主聊天展示日志不能代替 native 完整运行日志。
- 未知 provider 或未知配置版本保留原数据；结构化会话可以读取已有宿主展示日志，无日志时明确提示。不会尝试 Claude transcript 补全，不恢复审批或自动继续队列；不承诺缺失适配器时可导出、删除或完整管理该会话。
- 共享容量和 Git/worktree 目录管理锁仍有效，但它们不是所有工具写入的租约。同 cwd 的真实 Claude/native/Shell 并发写入安全没有在 P2 解决；P3 开放 native 编码前必须补齐。并存测试使用独立目录或无副作用任务。
- CLI 更新仍依赖本机安装方式、权限和网络；既有代理/仓库限制见 [CLI 更新说明](CLI-UPDATES.md)。桌面应用仍不自动更新，本阶段不新增签名、公证或 Release 发布。
