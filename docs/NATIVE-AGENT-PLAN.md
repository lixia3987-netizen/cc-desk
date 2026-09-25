# cc-desk：monorepo 与自研 Agent 开发计划

日期：2026-09-24（北京时间）  
历史代码分析基线：`main@a3f94b6c74f2abfad7a38306803319226dd5d436`，基线应用版本 `0.5.0`。
开发分支：`dev/native-agent`，从上述提交创建。  
状态：阶段一 monorepo 迁移已完成，验收记录见 [MONOREPO-PHASE-1-VALIDATION.md](MONOREPO-PHASE-1-VALIDATION.md)。阶段二状态：**已完成，三平台验收通过**；固定实现候选为 `a4e34ce736dd59a6c29ca3a5878a64d0a10b2711`，工作位于 `refactor/engine-boundaries`，目标集成分支仍为 `dev/native-agent`。完整 CI 证据见 [#37](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36107597893)，结论以固定候选的验收记录为准。

实际落地接口、迁移/回退说明及验证结果见 [ENGINE-BOUNDARIES-PHASE-2-VALIDATION.md](ENGINE-BOUNDARIES-PHASE-2-VALIDATION.md)。P2 代码及后续独立 docs PR 的目标都仅为 `dev/native-agent`，不合入 main、不发布 Release；真实 native 运行时仍属于阶段三。

阶段二的基线分析、具体任务与验收条件见 [ENGINE-BOUNDARIES-PHASE-2.md](ENGINE-BOUNDARIES-PHASE-2.md)。下文“当前代码”保留的是总体计划编写时的基线，不作为阶段二最新实现清单；其中 `src/` 和 `tests/` 路径在阶段一后已分别位于 `apps/desktop/src/` 和 `apps/desktop/tests/`。

## 1. 目标与实施原则

先迁移为 monorepo，再逐步接入能独立工作的自研 Agent。过渡期在同一桌面应用中保留 Claude Code CLI 与自研 Agent，按会话选择执行引擎。新引擎达到日常开发要求后，再调整新会话默认值并推进替代。

优先复用现有会话、消息、审批、队列、工作流、项目和 worktree 体验。自研范围是模型调用编排、上下文管理、工具执行、权限和恢复；继续使用外部模型 API 或本地模型服务，无需训练基础模型。

第一阶段保留 npm，使用 npm workspaces；保留 React、Electron、Vite、esbuild 和现有测试工具版本。根目录维护一个 lockfile。暂不引入 Nx/Turborepo、公共 UI 库、通用插件平台或新的数据库。

## 2. 当前代码已有的基础

| 当前位置 | 已有能力 | 迁移处理 |
| --- | --- | --- |
| `src/shared/execution.ts` | 引擎身份、能力、会话身份命名空间 | 沿用 `execution.providerId / mode / conversationId` |
| `src/main/execution/ports.ts`、`registry.ts`、`routers.ts` | 执行生命周期、结构化聊天、终端接口和路由 | 自研执行器接入同一注册表 |
| `src/main/session-creation.ts` | 委托提供方创建并验证身份 | 增加 native 身份工厂 |
| `src/main/session-service.ts`、`chat-queue.ts`、`workflows.ts` | 会话仲裁、队列、工作流、资源和目录管理 | 保留共同调度入口，逐步注入桌面通知等宿主依赖 |
| `src/shared/schema.ts`、`src/main/store.ts` | workspace v2、v1 迁移、原子保存 | 结构搬迁阶段不改数据格式；引擎配置变更单独迁移 |
| `tests/execution-contracts.test.ts`、`session-identity.test.ts` | 非 Claude 假执行器和身份边界验证 | 用于新执行器共用契约验收 |

目前不是从零建立多引擎架构。主要剩余耦合如下：

- `chat-runtime.ts` 实际属于 Claude：直接使用连接、协议事件、CLI 参数、transcript 和 Claude 身份校验，不适合作为自研 Agent 的通用父类。
- `engines/claude/structured-executor.ts` 依赖桌面内部的 `StateStore` 和 `ChatRuntime`；直接搬目录会造成包反向依赖应用。
- `NewSessionForm.tsx`、`SessionConfig.tsx`、`SettingsPanel.tsx` 等入口仍围绕 Claude 模型、effort、权限和连接设置。应按引擎及模型能力生成选项。
- `history.ts` 查询的是 Claude transcript；不能把它当作所有引擎的历史来源。
- `index.ts` 和 `SessionService.withDisconnectedWorkspaces` 在更新 CLI 时进入全局维护并停止所有会话。双引擎阶段需要按引擎维护。
- `ChatHistory` 是有界 UI 投影与完整展示事件日志。自研引擎仍需要独立、完整、可恢复的模型上下文与工具执行记录。

## 3. monorepo 结构与依赖方向

第一步只建立 `apps/desktop` 和 `packages/contracts`。其他包在对应功能阶段创建，不预先建立大量空包。

| 目标路径 | 职责 | 引入时机 |
| --- | --- | --- |
| `apps/desktop` | Electron main/preload、React、IPC、桌面装配、设置和项目体验 | P1 |
| `packages/contracts` | 引擎身份、消息、事件、能力、审批等跨边界契约 | P1，先迁移真正公共的部分 |
| `packages/agent-core` | Agent 循环、运行状态、上下文策略、模型/工具/存储端口 | P3 |
| `packages/agent-node` | 模型协议适配、本地工具、持久化、进程管理及 native 执行适配 | P3 |
| `packages/engine-claude` | CLI 探测、启动、通信、transcript、Claude runtime | P2 边界清理完成后提取；此前保留在 desktop |

根目录保留 `docs/`、统一脚本和 CI 配置。桌面专属字体、主题、面板状态继续在 desktop 内；模型适配、工具和 MCP 初期作为 agent-node 内模块，确有独立依赖或复用需求后再拆包。

依赖规则：

1. `desktop → agent-node → agent-core → contracts`；Claude 适配器使用公共契约和宿主注入的端口。
2. contracts 不导入 Electron/React 或 Node 实现；agent-core 不依赖 Electron、桌面目录或 Claude CLI。
3. package 不反向导入 desktop；跨包只使用明确的 exports，不跨目录引用包内部源文件。
4. 会话仓库、历史输出、通知和凭据等以窄接口注入。必要时提取共用存储实现，不为提取 Claude 包先创造一个庞大的 workspace-core。
5. 内部包先设为 private。桌面应用维持现有版本和发布身份，暂不开展独立包发布。
6. TypeScript 配置分开浏览器与 Node 环境；全包独立类型检查。构建明确依赖顺序，不能把 workspace 枚举顺序当成拓扑排序。

## 4. 双引擎并存规则

| 事项 | 设计 |
| --- | --- |
| 引擎标识 | 沿用 `execution.providerId`：`claude`、`native`；Shell 仍为 `shell` |
| 模型服务 | native 配置独立的连接引用、模型服务类型、模型 ID；与执行引擎 providerId 分开 |
| 默认值 | 过渡期 Claude 保持现有默认，新建会话可显式选择自研 Agent |
| 旧会话 | 保留原引擎、会话 ID、transcript 关联、日志和附件位置 |
| 跨引擎继续 | 创建新会话，明确导入用户可见消息或摘要；不能把 Claude conversationId 直接交给 native，也不承诺无损延续 |
| 故障处理 | 显示错误并允许用户另开会话；发生副作用后不自动切换另一引擎重做任务 |
| 功能能力 | UI 和主进程都按 capabilities 检查；native 初期只声明已实现的 structured、approvals 等能力，工具清单另行声明 |
| 认证 | Claude 保留现有 CLI 认证；native 使用单独配置的 API/本地服务凭据，不能假设 CLI 登录可用于直接模型请求 |
| 并发 | 延续会话和目录管理；两引擎同时修改项目时优先使用独立 worktree，明确同目录写入的互斥范围 |
| 维护 | CLI 更新只维护 Claude 会话及其工作流；应用退出仍统一清理全部资源 |

模型名、推理强度、上下文窗口、附件和工具调用能力应由连接适配器/经过验证的配置给出。保留 Claude 专属选项，不把 `ultracode`、`bypassPermissions` 等直接当作 native 的语义。

产品上复用同一聊天、审批、Git 和工作流界面，显示清晰的会话引擎标识；设置页区分执行引擎连接和模型服务连接。未安装 Claude CLI 时，已配置 native 的会话仍可完整运行。

## 5. 自研 Agent 的最小可用范围

第一版应完成“读项目 → 调模型 → 执行工具 → 回传结果 → 继续迭代 → 验证修改”的完整编码闭环，而非只有聊天接口。

- 一个实际模型协议和确定性的测试 provider；支持流式内容、增量工具参数、用量、错误与取消。第二个模型协议在第一条链路稳定后接入。
- 加载基本项目指令（如适用目录的 AGENTS.md），定义作用域、优先级、大小上限及与用户指令的关系；让首版编码任务能够遵循仓库开发约定。
- 核心工具：列目录、读文件、搜索、受控文件编辑/补丁、执行命令。补丁应用前校验文件版本，避免覆盖外部编辑；Windows/macOS 命令参数和进程树单独验收。
- 在执行前校验工具输入，接入批准/拒绝/提问；路径边界、符号链接、输出上限、超时和命令权限属于首版工具实现。普通子进程隔离不等于系统沙箱。
- 运行循环明确正常结束、等待审批、失败、中断和步数耗尽；设置步数、耗时、token 和输出预算。
- 贯穿模型请求、工具进程和审批等待的取消信号；取消返回与资源完全释放分开处理，迟到结果不得覆盖已终止回合。
- 独立保存完整结构化 messages、tool calls、tool results、模型续接所需元数据和检查点；展示日志从运行事件投影生成。
- 副作用工具至少记录“准备执行/执行完成”状态。崩溃后结果未知的操作需要核对，不能自动重复执行；不宣称跨外部进程具备无条件 exactly-once。
- 错误重试针对可确认安全的请求；文件写入、命令执行等副作用不做盲目重试。

建议 agent-core 可以脱离 Electron 测试和运行；桌面通过独立 Node 子进程宿主承载 native 任务，优先验证 Electron utilityProcess。宿主负责消息边界和资源管理，模型密钥不经过 renderer；它提供故障隔离，不提供文件/命令安全沙箱。为便于复用，Electron 专属启动代码留在 desktop。

首版暂缓多 Agent 并行、自研终端 TUI、远程常驻服务和插件市场。MCP、完整 Skills 机制、复杂指令来源和上下文压缩等在可靠的单 Agent 闭环后继续完善。

## 6. 分阶段交付与验收

| 阶段 | 主要交付 | 通过标准 |
| --- | --- | --- |
| P0：基线 | 记录当前功能、测试、打包和数据样本；确认新增 CI 触发方式 | 区分原有失败和迁移回归，保留可回退基线 |
| P1：monorepo | desktop workspace、contracts、根脚本、TS/构建/测试/打包路径 | 干净安装、类型检查、单测、桌面 E2E、三平台打包与包内启动通过；旧数据与应用身份正确 |
| P2：引擎边界 | Claude runtime 收拢、宿主依赖注入、引擎配置/能力、按引擎维护 | 原 Claude 功能通过回归；假 native 执行器通过真实 SessionService 的发送、审批、取消、工作流、队列测试 |
| P3：native Alpha | agent-core/node、一个实际模型协议、基本项目指令、工具循环、审批、预算、基本持久化和桌面入口 | 不安装 CLI 也能完成小型真实仓库任务：读代码、修改、运行验证、输出差异；Claude/native 同时可用且互不串状态 |
| P4：日常可用 | 完整恢复与压缩、模型协议扩展、MCP、完整 Skills/指令管理、连接诊断和成本信息 | 长任务、断流、重启、磁盘错误、审批失效、工具取消、队列/工作流恢复均可解释且不重复副作用 |
| P5：逐步替代 | 固定任务集评估、扩大使用范围、调整新会话默认引擎 | 达到事先定义的质量与稳定性门槛，再讨论减少 CLI 依赖；旧 Claude 会话仍有明确处理方式 |

P2 包提取可按真实依赖成熟度推进，不阻止 agent-core 的独立开发；P3 实现需要依赖 P2 已稳定的契约。UI 配置与能力入口、agent-core、模型/工具模块可在契约确定后并行开发，公共契约修改由同一集成任务协调。

预计主要复杂度集中在 P3/P4：恢复、上下文管理和工具可靠性通常比目录迁移更难。先完成 P0/P1 的实测，再估算后续工期；不以文件数量或 Agent 并发数量推算交付日期。

## 7. 第一阶段需要特别处理的工程细节

1. 根 `package.json` 改为编排入口，桌面包保留 `name/productName/appId` 等运行身份，避免 userData 目录改变。暂不伴随品牌或数据库迁移。
2. `build.mjs`、`dev.mjs`、Vite 和 Electron 启动路径按 workspace 重定位；保留产物内 main/preload/renderer 的相对关系。
3. 内部普通 TS 包继续纳入 esbuild/Vite bundle，外置依赖显式声明并核验；不能因为 workspace 链接存在就假设安装包内也可解析。
4. node-pty 继续作为桌面运行依赖；验证提升后的依赖收集、ASAR 解包、架构和 macOS spawn-helper 执行权限。保留 postinstall 修复语义。
5. 调整测试中的 `electron ['.']` 和相对导入；`verify-packaged.mjs`、`publish-release.mjs` 明确读取桌面版本，根元数据不成为第二个版本来源。
6. 现有 `.github/workflows/build.yml` 仅手动触发。添加开发分支/PR 的快速检查；打包相关改动与阶段验收运行三平台打包，复用现有 packaged smoke tests。正式发布仍限制在 main。
7. 协议/身份、取消/审批、历史/恢复、队列/workflow、worktree 删除和打包启动是重点回归；使用现有测试，新增测试只覆盖新的边界或真实风险。

## 8. 验收不能遗漏的行为

- 同一个会话只能有一个运行中用户回合；后台子任务未结束时不能误判父回合结束。
- approvals 关联 session/run/toolCall/request 身份；重复、过期、取消后的审批不可生效。
- 工具事件有稳定调用 ID、序号和明确终态；原始引擎协议不泄漏到通用 UI 契约。
- 同一逻辑会话的并发和物理 worker 的数量分别管理；取消和关闭必须等待工具进程树、句柄和目录占用释放。
- 先保存关键事件/检查点再确认操作完成；写盘失败应明确中止或降级，不展示虚假的可恢复状态。
- 旧 schema、损坏文件、未知引擎和离线历史都须有明确定义；未知引擎不能静默退回 Claude。
- 跨引擎共用界面不代表共用内部上下文；native 不写入 Claude transcript，也不覆盖其认证配置。
- 回退应用版本与回退数据格式分别设计。新数据版本保存备份，旧版本无法识别时拒绝覆盖；不依靠降级二进制自动修复数据。

## 9. 分支和 PR 组织

`dev/native-agent` 用作此次工作的集成分支；后续分阶段分支以它为基础，例如 `refactor/monorepo-foundation`、`refactor/engine-boundaries`、`feat/native-agent-loop`。每个 PR 只包含一个可独立验收的阶段。

沿用“完成并验证后自动合并”的偏好：阶段代码 PR 验证后仅合入开发集成分支 `dev/native-agent`。本次 P2 固定候选的验收状态见本文开头，验收状态与证据通过独立 docs PR 更新，目标同样仅为 `dev/native-agent`。在用户另行明确授权前，不推进 main，也不发布 Release；创建分支或更新计划本身不代表验收完成。P2 的测试引擎不作为可启用的正式产品入口，真实 native 产品入口属于 P3。

第一批建议依次处理：

1. P0 + P1：npm workspaces、desktop/contracts、路径和 CI 迁移。
2. P2a：Claude runtime 归位，梳理接口和数据依赖；使用现有契约测试验证。
3. P2b：按引擎配置/维护、能力驱动入口、数据迁移与双引擎测试。
4. P3a：agent-core、假模型/假工具、状态与持久化契约。
5. P3b：真实模型协议和本地工具，桌面 native Alpha 闭环。

## 10. 依据与验证范围

本计划最初基于上述历史分析基线的源码、构建脚本、工作流和测试代码阅读，并对引擎、数据/UI、构建三个方面进行了独立交叉检查。最初计划编写时未安装依赖、运行项目测试或进行实际模型调用；下文引用保留当时的分析依据。P2 固定候选的实际验证结果由[阶段二验收记录](ENGINE-BOUNDARIES-PHASE-2-VALIDATION.md)另行登记，本文的验收项不代表已经通过。

相关官方文档（查阅于 2026-09-24）：

- [npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces/)：工作区和根 lockfile 管理。版本号在实现阶段结合当前 Node 22 CI 固定。
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)：桌面启动独立 Node 子进程的宿主能力。
- [electron-builder v26 two-package structure](https://www.electron.build/v26/docs/tutorials/two-package-structure/)：应用依赖、开发依赖与原生模块构建环境的区分。

这些文档支持工具能力判断；具体包边界、阶段和并存策略属于针对 cc-desk 当前源码提出的设计建议。
