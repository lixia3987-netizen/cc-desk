# 阶段一：monorepo 改造任务分解

日期：2026-09-24（北京时间）

分析基线：`dev/native-agent@9d5cbf9586f4aa290cc4d4993c83d6d85ea55211`；应用代码等同 `main@a3f94b6`。

总体计划：[NATIVE-AGENT-PLAN.md](NATIVE-AGENT-PLAN.md)。

状态：任务分析完成，以下实施任务均未开始；本次仅增加此文档。

## 1. 阶段交付物

将现有桌面应用迁至 npm workspaces，建立真正被桌面消费的公共契约包，完成构建、测试、打包和 CI 迁移。对用户而言，现有 Claude/Shell 使用体验和数据保持兼容；对后续开发而言，可在同一仓库新增独立 agent-core/node 包。

阶段一交付两项 workspace：`apps/desktop` 和 `packages/contracts`。根目录继续提供日常 npm 命令。此阶段不新增 native 执行器，不改变 CLI 参数、审批语义、全局维护行为或存储 schema；这些工作按总体计划进入后续阶段。

## 2. 先固定的工程决定

| 项目 | 阶段一决定 |
| --- | --- |
| 包管理 | 保留 npm，一个根 `package-lock.json`；工具和第三方依赖版本沿用当前锁定版本 |
| 根 package | `cc-desk-workspace`、private，只承担工作区与任务编排；不作为 Electron 应用，也不是发布版本来源 |
| 桌面 package | 保留 `claude-workbench`、`Claude Workbench`、`0.5.0`、`io.local.claude-workbench` 和 `dist/main/index.cjs` 入口 |
| 契约 package | `@cc-desk/contracts@0.0.0`、private，构建 ESM JS 和 `.d.ts`，公开有限 subpath exports |
| 依赖归属 | 现有运行依赖归 desktop；desktop 显式依赖 contracts；各包直接使用的开发工具显式声明、版本一致，npm 可去重 |
| 模块格式 | desktop 的 main/preload 仍打包成 CJS；contracts 为 ESM，随应用 bundle，不列为 external |
| 开发入口 | 根 `npm run dev` 启动前构建 contracts；contracts/main 修改后重启开发命令，P1 不引入新的 watch 框架 |
| 安装生命周期 | 仅根 postinstall 调用 desktop 的 prepare-native 脚本；不重复设置 workspace postinstall，不在安装阶段编译 contracts |
| 发布 | 桌面 manifest 为唯一应用版本来源；P1 验证不发布 release |

根版本与应用版本解耦。后续发布版本更新位置是 `apps/desktop/package.json` 及根 lockfile 中对应 workspace 元数据，不是根编排包的版本。

## 3. 文件与目录迁移表

| 当前路径 | 目标路径/处理 |
| --- | --- |
| `src/` | `apps/desktop/src/`，第一步整目录迁移 |
| `tests/`（含 fixtures/helpers） | `apps/desktop/tests/`，保留多数 `../src` 相对关系 |
| `vite.config.ts` | `apps/desktop/vite.config.ts` |
| `playwright.config.ts` | `apps/desktop/playwright.config.ts` |
| `playwright.packaged.config.ts` | `apps/desktop/playwright.packaged.config.ts` |
| 当前应用 `package.json` 内容 | 迁入 `apps/desktop/package.json`，根另建编排 manifest |
| `tsconfig.json` | 根建立不带平台 ambient 类型的 base；desktop 和 contracts 分别声明环境、输入和输出 |
| `scripts/build.mjs`、`dev.mjs` | `apps/desktop/scripts/` |
| `scripts/prepare-native.mjs` | `apps/desktop/scripts/`，由根 postinstall 唯一调用 |
| `scripts/run-desktop-tests.mjs`、`verify-packaged.mjs` | `apps/desktop/scripts/` |
| `scripts/capture-layout.cjs`、`verify-windows-npm.ts` | `apps/desktop/scripts/`，同步文档和 CI 调用位置 |
| `scripts/start.sh`、`start.ps1` | 保留根 scripts，转到根目录安装/构建/启动 |
| `scripts/publish-release.mjs` | 保留根 scripts，显式读取 desktop manifest |
| `README.md`、`LICENSE`、`docs/`、`.github/` | 保留根目录 |

脚本必须区分以下目录，不能把一个 `root` 同时当成仓库、应用和输出目录：

| 名称 | 固定位置 | 用途 |
| --- | --- | --- |
| repoRoot | 仓库根 | lockfile、docs、CI、发布文档 |
| desktopRoot | `apps/desktop` | Electron 启动、桌面源码、测试配置、应用 manifest |
| desktopDist | `apps/desktop/dist` | main/preload/renderer 产物 |
| releaseRoot | 根 `release/` | 三平台安装包和便携包 |
| testOutputRoot | 根 `test-results/` | 测试结果；desktop/contracts/packaged 使用子目录区分 |

截图继续写根 `docs/screenshots/` 和 `docs/themes/`；Playwright HTML 报告继续写根 `playwright-report/`。开发过程不应误生成 `apps/desktop/docs` 或第二个 `release`。

## 4. 公共契约的精确范围

| 当前定义 | 处理 |
| --- | --- |
| `src/shared/execution.ts` | 迁入 contracts，保留所有现有 DTO 及 `getSessionIdentity`、`sameConversation` 两个纯函数 |
| `src/shared/chat.ts` | 整体迁入 contracts，保持消息/审批/队列投影等结构与语义 |
| `src/shared/execution-events.ts` | 迁入 contracts，解除对 desktop `types.ts` 的依赖 |
| `src/shared/types.ts` 的 `SessionStatus`、`TerminalChunk` | 定义迁至 contracts/execution，供事件使用 |

这是能解除事件反向依赖的最小完整集合。`Session`、`Settings`、`AppState`、`DesktopAPI`、`Effort`、`PermissionMode`、Zod schema、字体和主题均留在 desktop。`execution/ports.ts` 仍依赖桌面 Session 和 Claude 配置类型，留待 P2 清理。

在 desktop 原来的 `shared/execution.ts`、`chat.ts`、`execution-events.ts` 保留单向 re-export。`types.ts` 从包导入并再导出两个基础类型；不保留两份定义。这样保留现有消费者入口，不需要在搬目录的同时大面积改写业务 import。

契约包实现约定：

- 使用已有 TypeScript 构建，`target: ES2022`，`module/moduleResolution: NodeNext`，`rootDir: src`，`outDir: dist`，生成 declaration。
- `type: module`，包内相对 import 使用 `.js`；exports 的 types 指向 `.d.ts`，运行时指向 `.js`，公开 `./execution`、`./chat`、`./execution-events`。
- `lib: [ES2022]`、`types: []`；不继承 desktop 的 DOM、React、node 或 vite/client。仍须检查显式 import，不能把 types 配置当作依赖隔离保证。
- desktop 的 dependencies 声明与本地包版本一致的 `@cc-desk/contracts: 0.0.0`；使用 npm 支持的常规版本声明，不照搬其他包管理器的 workspace 协议。
- 不开放 `./src/*` 深层路径，不通过 paths 别名绕过 exports；构建后的声明不得指向 desktop 源文件。

## 5. 任务清单与依赖

| ID | 任务与主要修改 | 前置 | 完成证据 |
| --- | --- | --- | --- |
| P1-00 | 固定基线：记录 Node/npm、应用身份、测试发现清单、已有构建结果和数据样本 | 无 | 基线记录；原有失败与迁移回归能区分 |
| P1-01 | 建立 workspace、搬迁 desktop、调整 manifests/lockfile/TS 配置，接通根 postinstall 和最小 build/start 代理 | 00 | 根 npm ci 和基本构建可运行，workspace 归属明确，无意外依赖升级 |
| P1-02 | 提取最小 contracts、compiled exports、单向兼容入口 | 01 | 独立编译成功，桌面经包名消费，声明没有反向依赖 |
| P1-03 | 改造根命令与 desktop build/dev/start，统一输入/输出路径 | 01；集成时依赖02 | 干净目录可 build/dev/start，主进程与 preload/renderer 正常加载 |
| P1-04 | 打包、native postinstall、包验证及 release 元数据读取 | 03 | 包内能找到 node-pty、README/VALIDATION、正确版本和启动入口 |
| P1-05 | 测试发现、Electron launcher、截图/报告与旧数据身份验证 | 01；集成时依赖02/03 | 原用例未漏跑，Xvfb/信号/筛选参数正确，旧数据与身份兼容 |
| P1-06 | 新增 PR 快速检查；迁移原三平台手动流程与 artifact 路径 | 03/04/05 | PR 有真实快速检查；三平台能收集包和验证报告，发布约束保留 |
| P1-07 | README/架构/验证文档更新、干净安装验收、阶段 PR 整合 | 02–06 | 同一候选代码通过门槛，验证证据与提交 SHA 对应 |

P1-01 先由一个集成负责人落定 manifest 和目录，接通迁移后的 prepare-native 及基本 build/start，建立可安装、可构建的 desktop workspace；P1-03 完善各命令和跨 cwd 路径，P1-04 完善并验收 native 打包。在 P1-02 创建 contracts 时再添加对应消费依赖和前置构建步骤，避免引用尚不存在的包。P1-02、P1-03、P1-05 可按最终路径约定并行；P1-04 依赖构建路径稳定，P1-06 依赖输出约定稳定。根 manifest、lockfile 与 CI 由集成负责人统一合并，避免多任务同时改写依赖图。

## 6. 构建与命令任务细则

根入口继续支持 `dev/start/build/typecheck/test/check/test:e2e/test:packaged/dist:win/dist:mac/dist:linux`。实现时保留失败退出码和额外参数转发。

| 根命令 | 执行约定 |
| --- | --- |
| `npm ci` | 依据唯一 lockfile 安装并链接包，然后唯一 postinstall 修复 native helper；不编译源码 |
| `npm run build` | 先构建 contracts，再执行 desktop Vite/esbuild |
| `npm run typecheck` | 验证 contracts 并生成供消费的声明，再检查 desktop；不依赖历史 dist |
| `npm test` | 先准备 contracts 产物，运行包入口/边界检查和现有 desktop 单测 |
| `npm run check` | 顺序执行完整类型、测试、构建；内部可以复用已经构建的契约，避免无意义重复编译 |
| `npm run dev` | 先编译 contracts，再以明确 desktopRoot 启动 Vite 与 Electron |
| `npm start` | 启动已构建的 desktop 应用；根 start.sh/start.ps1 首次运行负责安装和构建 |
| `npm run test:e2e -- ...` | 使用已构建产物进入 desktop runner，明确配置路径、cwd 和参数转发；独立调用前先 build，CI 复用 check 中的构建 |
| `npm run dist:*` | 先完成源码构建，再按 desktop 的 builder 配置打包至根 release |
| `npm run test:packaged` | 验证已有 release 产物；缺包则明确失败，不隐式替代为源码测试 |

独立 workspace 的命令应在约定前置产物存在时可调用；对外推荐根命令。根入口显式构建依赖顺序，不使用 `--if-present` 隐藏必需脚本，也不把 `npm run --workspaces` 的枚举顺序当成自动拓扑排序。

`build.mjs`/`dev.mjs` 从自身位置推导 desktopRoot，esbuild 使用明确 absWorkingDir，Vite 使用明确配置路径，Electron 使用明确应用目录。不能在根执行 `electron .` 导致加载编排 manifest。

## 7. 打包与兼容的重点任务

- 保留桌面 main/preload 的 CJS 格式及包内相对布局。contracts 纳入 esbuild/Vite bundle；`electron`、`node-pty` 保持已有外置策略。
- builder 配置属于 desktop；`directories.output` 指向根 release。README 和 VALIDATION 的来源改为根文件的明确路径，目标文件名保留。
- node-pty 仍为 desktop 运行依赖；prepare-native 使用 `createRequire(...).resolve('node-pty/package.json')` 定位真实依赖，不能假设只在某层 node_modules。
- 保留当前 `npmRebuild: false`、ASAR 解包和 macOS helper 可执行位处理；用最终包的真实 PTY 测试确认依赖收集/架构/权限。若确有打包器适配问题，先定位证据再调整策略。
- publish-release 从 desktop manifest 读取应用版本；release-assets、release notes、tag 及校验文件路径由 repoRoot 推导。仅改路径，不执行发布验证。
- 默认 userData 由应用身份参与决定。既有 packaged 测试传入了 `--user-data-dir`，无法单独证明默认路径不漂移。应在一次性 CI 测试用户环境中，对照搬迁前后的 app.getName/getVersion/default userData，且不传覆盖参数；本地业务数据不用于此测试。
- 使用隔离样本验证 workspace v1/v2、聊天/队列/工作流、附件、导入字体、面板状态和 worktree 路径兼容。不移动实际用户数据，不进行 schema 升级。

## 8. 测试迁移与新增验证

当前基线有 39 个 `*.test.ts` 文件、14 个源码 E2E spec 及 1 个 packaged spec。这里只记录文件数，不代表用例数或已通过结果。迁移后的发现清单应保持一致；新增检查单独列出。

需要专门检查：

- `tests/helpers/electron-launch.ts` 默认 `['.']` 与 runner 的 cwd；desktop-launch 单测对路径、筛选、退出码和进程组信号的断言同步调整。
- `tests/runtime.test.ts` 的源码 URL/子进程 cwd，`themes.test.ts` 的 CSS 读取，fixtures 的相对 import，renderer-permissions 的 dist 路径。
- Playwright 的测试路径、packaged 配置、JSON/trace 输出和截图。共享测试路径工具须兼容当前 tsx 与 Playwright 的实际转译方式，不全面改成可能破坏 CJS 场景的 import.meta 访问。
- Vite 静态资源的输出与包内 URL 正确；系统字体继续由系统提供，导入字体继续通过 FontLibrary 持久化、readFont IPC 和 FontFace 加载。安装包中分别验证，不把导入字体误当作 Vite 内置资源。

值得新增的验证仅围绕此次真实风险：

1. contracts 经公共 exports 被 Node/tsx 与应用构建消费，不能靠源码相对路径或旧 dist 才能通过。
2. contracts 的源码/声明不依赖 desktop、Electron、React 或 Node 平台实现，包内深层路径未开放。
3. 根命令与不同调用 cwd 均定位同一 desktopRoot，额外参数不丢失。
4. 默认应用身份/userData 与基线一致；显式数据目录的现有测试继续保留。

现有身份、事件、审批、恢复、队列、工作流、worktree 和 PTY 测试继续使用。纯函数迁移不重复编写相同测试，不调整断言来掩盖行为改变。

## 9. CI 分层和最终验收

新增 `verify.yml`：针对目标为 `dev/native-agent` 或 `main` 的 pull_request，以及手动触发，运行 Ubuntu 的干净安装、全包类型/单测/构建。避免同一提交同时因 push 和 PR 重复触发；采用独立 concurrency 分组取消过时快速检查。若采用路径过滤，应覆盖所有源码、配置、脚本和 lockfile，且不造成必需状态永久等待。

现有 `build.yml` 保持手动三平台完整验证：Windows x64、macOS arm64、Linux x64，覆盖 check、源码 E2E、打包和 packaged smoke。Windows 仍验真实 npm Claude launcher。更新迁移后的路径，但保留 main + 手动 publish_release=true 才正式发布的条件。

验收分两层：日常 PR 快速检查；P1 候选稳定后一次三平台完整验证。构建产物、packaged manifest、trace 与报告关联同一源提交。候选运行时不要继续往该引用推代码；若代码变化，旧验证不能作为新代码通过证据。

最终门槛：

- 干净 checkout，无旧 node_modules/dist，以根 npm ci 和根命令通过检查。
- 全包 typecheck、39 个基线单测文件对应用例、14 个源码 E2E spec 和新增边界检查实际执行。
- 三个平台的最终包可以启动，真实 PTY、二次启动、数据保留、进程退出正常。
- 应用身份、默认数据目录及旧数据兼容符合基线。
- 包内不存在依赖仓库 workspace symlink 才能解析的业务代码；公共包没有反向依赖。
- 新 PR 快速 CI 与原手动打包流程都有正确触发/结果收集；发布条件没有扩大。
- README 中开发、测试、构建、版本更新说明与实际目录一致。

现有 packaged 验证不覆盖 Windows 便携 exe launcher、Linux FUSE 启动、签名/公证、SmartScreen/Gatekeeper；P1 保留这些既有范围说明，不将其写成已经验证。最后若只改说明文档，不重复三平台测试；manifest、lockfile、共享构建路径或 native 处理变更需要重验受影响平台。

## 10. 分支与交付安排

实施时从 `dev/native-agent` 创建 `refactor/monorepo-foundation`，阶段 PR 目标为 `dev/native-agent`。本次分析尚未创建该实施分支。

建议一个阶段 PR，内部组织三组可审查提交：workspace/目录与构建迁移、contracts 提取、测试/CI/文档验收。每个提交尽量维持可构建；不要在目录迁移的同时格式化全项目或批量升级依赖。

完成 P1-00、P1-01 后可并行处理契约、构建和测试路径；最终由同一集成任务处理 lockfile/脚本/CI并收集验收证据。满足门槛后按既定偏好合入开发分支，下一阶段再开展引擎边界整理。

阶段一最大工作量来自路径与分发链路协调，风险集中在原生模块、包内资源和数据身份。基线实测前不承诺具体天数；若已有失败，先记录和定位，不通过删测试、扩大重试或跳过平台获得表面通过。

## 11. 本次分析范围与依据

已核对当前远端 main/dev 分支、逐项阅读 manifests、源码依赖、构建/测试/发布脚本、CI及既有计划，并对构建、契约、测试三个方面并行交叉检查。本次未安装依赖、运行项目测试、改造代码或发布软件。

官方资料：

- [npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces/)：工作区安装与命令顺序。
- [npm scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts/)：生命周期和脚本工作目录。
- [TypeScript modules reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html)：NodeNext、模块解析与包 exports。
- [Electron app](https://www.electronjs.org/docs/latest/api/app)：应用名称、版本及默认 userData。

包边界、任务顺序和验收分层是针对此仓库的设计决定；具体实现仍须通过上述实际门槛。
