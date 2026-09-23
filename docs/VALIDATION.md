# v0.2 验证记录

## 右侧面板收起与展开

- 会话顶栏最右侧增加面板开关，默认展开，支持鼠标与 Enter/Space 操作。显示状态保存在本机布局偏好中，切换会话及重启后沿用；右侧组件保持挂载，收起后不会丢失当前页签和未保存输入。
- 本地 TypeScript 和生产编译通过。新增两项 Electron 测试全部通过，覆盖真实宽度变化、隐藏控件不可聚焦、组件身份不变、未保存模型/提示词/工作流草稿保留，以及跨会话、重启和页面重载后的显示状态。
- 980×680 下使用真实 Shell 验证终端尺寸随开关调整并恢复，环境标记在两次切换后仍保留，进程没有重新启动。既有项目分组/导航/草稿与紧凑顶栏场景也通过，包含长标题及 1600×1000、980×680 两种尺寸。
- 已复核展开/收起两张实际截图。验证环境为 Linux 虚拟 X11；本轮未运行 Windows/macOS 实机验证，未触发 GitHub Actions、安装包构建或 Release。

## 自定义外部 IDE

- 新增本机 IDE 应用路径设置、原生应用选择器和顶部「IDE」入口。旧设置自动使用空值；选择文件只更新草稿，保存后生效，关闭设置保留原配置。未配置时点击入口会定位并聚焦路径输入框。
- 打开会话使用其实际工作目录（包括隔离 worktree），项目入口使用项目根目录；路径作为单独参数传递。支持 Windows 指定 .exe、macOS .app 或可执行文件、Linux 可执行启动器，应用移动、权限不足、工作目录消失及初始启动失败均有错误提示。
- 本地 TypeScript 与生产编译通过；155 项 Node 测试中 154 项通过，1 项既有 Windows 专用测试跳过。新增覆盖旧设置迁移/保存/清空、定制 Windows 路径及 macOS 调用参数、缺失或失效路径、权限和进程错误，以及真实 POSIX 进程仍运行时及时返回。
- 两项新增 Electron / Playwright 场景全部通过：选择器选择/取消、未保存退出、保存重启、工作树原样启动、应用被删除后的反馈和原有文件夹入口。真实可执行 fixture 验证中文、空格及 shell 元字符不会被解释；980×680 下按钮可见且无横向溢出，已复核设置截图。
- 桌面验证在 Linux 虚拟 X11 下运行；Windows/macOS 启动方式以参数与替身测试覆盖，尚未在对应系统启动实际 VS Code/WebStorm。本轮只更新源码，未触发 GitHub Actions、安装包构建或 Release。

## Mermaid 源码与预览

- 会话中的 Mermaid 代码块默认预览，支持独立切换源码、复制原始文本、主题同步和图表区域滚动；工具结果与工作流摘要共用此渲染组件。流式更新会取消过期结果，语法错误保留源码入口，修正后恢复预览。
- 本地 TypeScript 检查与生产编译通过；148 项 Node 测试中 147 项通过，1 项 Windows 专用测试跳过。既有 Markdown、代码高亮、表格及 HTML 文本化测试通过。
- 新增 4 项 Electron / Playwright 场景全部通过：实际流程图与时序图、各代码块独立切换及精确复制、流式错误与恢复、相同图表的独立 SVG/箭头引用、折叠工具结果按需渲染，以及深浅主题切换。已查看实际桌面截图，中文标签和控件正常显示。
- 安全场景验证源码中的 frontmatter/init 指令不能启用活动 HTML 或脚本链接。桌面复制原先会受网页剪贴板权限策略阻止，现通过受校验的只写 IPC 完成；实际系统剪贴板、非法参数及超过 4 MiB UTF-8 的拒绝均已验证。
- 桌面验证使用 Linux 虚拟 X11 和本地消息 fixture，不访问真实 Claude 账号或模型。本轮未触发 GitHub Actions、安装包构建或 Release；Windows/macOS 原生运行尚未验证。

## Bypass 与默认权限模式

- 设置、新建会话、历史导入和会话配置支持 `bypassPermissions`；全局默认值保存到工作台设置，旧配置迁移后保持按需审批。已有会话不随默认值变化，分支继承源会话模式。
- 结构化会话切入或退出 Bypass 时停止空闲 CLI，下一轮按原身份恢复；执行中禁止切换，CLI 交互提问仍由用户回答。终端 hooks 同步 Bypass 状态，其他未支持模式继续要求明确选择。
- 本地 TypeScript 检查与生产编译通过；148 项 Node 测试中 147 项通过，1 项 Windows 专用测试跳过。新增测试覆盖配置迁移和持久化、四种启动/恢复参数、Bypass 进程切换和问答保留。
- Electron 新增默认权限场景和既有结构化审批/问答/工作流场景各 1 项通过。默认权限场景覆盖取消未保存设置、重启、新建覆盖、会话修改、分支继承、导入覆盖及未传权限的 IPC 请求。验证环境的原生 headless 启动崩溃后，改用虚拟 X11 显示器完成验证。
- 本轮只更新源码，未触发 GitHub Actions、打包或 Release。协议测试使用子进程 fixture；真实 Claude 账号调用及 Windows/macOS 新模式实机验收尚未执行。

## v0.2.3 CI 重试与历史消息定位

- [本次重试](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725088146) 基于提交 `7325111`，文件树与 `80637c9` 一致；三平台均成功启动 Runner，进入检查和构建。
- Linux 通过类型、Node 测试和生产编译后，在桌面测试中暴露历史消息搜索定位的时序问题：页请求返回后、新消息 DOM 提交前，滚动记忆可能记录旧页面并覆盖显式目标。
- 滚动控制现在保留待定位目标，在对应消息或审批元素出现后才完成定位；等待期间不让旧页滚动事件或动画帧覆盖目标。“跳到最新消息”会清除待定位状态。
- 本地类型检查和生产构建通过；历史分页/搜索与普通阅读位置恢复两个 Electron 场景各连续执行 3 次，6/6 通过。
- 修复提交 `83f3fe9` 的 [三平台工作流](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725728224) 已成功。Windows 首次执行在桌面测试的欢迎页断言遇到 5 秒超时；仅重试失败的 Windows 作业后完整通过，没有修改断言、增加测试重试或跳过门禁。历史定位场景在修复后的三平台首次执行均通过。
- Node 测试各平台均为 145 项：Windows 138 通过、7 项平台相关测试跳过；macOS/Linux 144 通过、1 项 Windows 专用测试跳过。桌面测试 macOS/Linux 各 8/8 通过；Windows 7 通过、1 项既有 POSIX 协议 fixture 测试跳过。真实 Windows npm Claude Code 2.1.278 启动器检查通过。
- 三平台各 2 项实际发布载荷测试通过：Windows 安装后的 EXE 与 ZIP 解压程序、macOS DMG 与 ZIP、Linux AppImage 提取程序与 tar.gz。三套 `packages-*` 附件已上传，源提交均为 `83f3fe9`；此次发布任务按配置跳过，GitHub Release 仍为 v0.2.2。下文各轮关于构建阻塞或尚无安装包的描述保留为当时的历史记录。

## v0.2.3 项目分组与紧凑布局

- 详见 [布局说明](UX-LAYOUT.md) 和 [实际截图](screenshots/project-layout.png)。`npm run check` 通过：TypeScript、生产构建、145 项 Node 测试（144 通过，1 项 Windows 专用测试在 Linux 跳过）；Electron 桌面回归 8/8 通过。
- 新增连续操作验证：项目内按最近更新时间排序、折叠、项目/会话搜索、项目内直接创建、归档筛选、已移除项目的会话保留、命令面板与通知跳转自动展开、草稿保留；1600×1000 与 980×680 下检查长标题和顶部操作无溢出。
- 五套主题、真实 Shell、历史检索、审批与第一轮连续操作回归通过。测量同尺寸示例界面：消息区起点从 286px 改为 108px，标题栏 72px；无提醒横幅时增加 178px 阅读高度。
- 首次 Node 检查发现既有审批测试超时；测试 CLI 在“拒绝并中断”和后续 interrupt 请求中分别返回一次 result，可能串入下一回合。已修正测试模拟器，只由 interrupt 控制请求结束该回合，并等待控制确认；完整检查随后通过。未改动生产审批协议。
- 本轮为源码更新，提交使用 `[skip ci]`；没有新的安装包、Release 或 Windows/macOS 原生验证。

## v0.2.3 第二轮检索与待处理请求

- 详见 [第二轮记录](UX-FIXES-round2.md)。`npm run check` 完成：145 项 Node 测试中 144 通过，1 项 Windows 专用测试跳过；TypeScript 与生产构建通过。Electron 桌面套件 7/7 通过。
- 新增档案测试覆盖超过 400 条消息的分页、追加后的稳定游标、交错文本片段、正文替换、相同文字的独立消息、旧 result 回声排除、快照独有消息、稀疏搜索续查、损坏与不完整尾行、文件替换和 IPC 体积边界。
- 真实协议子进程验证审批摘要随响应、取消、中断和停止清除；IPC 测试验证仅结构化会话可检索，以及消息游标/查询参数约束。
- 桌面场景覆盖 525 条消息、搜索结果高亮/工具展开、旧消息定位与切换恢复、查找不清空草稿、跨项目审批/提问数量与导航、空待办、主题与原有连续操作。测试暴露并修复了最新快照首帧覆盖历史阅读锚点的问题；短历史没有更早本地记录时保留现有消息并说明边界，该补充场景独立复测。
- 已复核搜索、历史阅读和统一待处理入口的实际截图。没有付费模型调用或新的原生安装包验收。两轮源码均使用 `[skip ci]` 推送，GitHub Actions 付款/支出限制仍是发布阻塞项。

## v0.2.3 第一轮连续操作修复

- 对应 UX01–UX09，详见 [第一轮修复记录](UX-FIXES-round1.md)。完整 Node 测试 136 项：135 通过、1 项 Windows 专用测试跳过；最终 TypeScript 与生产构建通过，Electron 桌面测试 6/6 通过。
- 新增回归覆盖面板草稿跨页签/会话/重启、编辑后立即退出、审阅意见按文件隔离、新建/分支项目选择、长对话阅读位置及缩放、无错误切换终端、模板追加、当前路径检测与同路径重试。
- 两个版本不同的本地 npm CLI 探针验证“保存并检测”确实使用新路径；原有真实协议子进程验证快速回合结束后 Git 自动刷新且保留审阅输入。发现并修复了批量工作区状态更新可能跳过快速回合的边界，修正后 SessionService 10 项和全部桌面测试再次通过。
- 已复核设置和 Git 审阅截图；主题回归保持通过。未调用真实模型；本轮 Windows/macOS 原生安装及正式包验证仍待远程构建恢复。

## v0.2.3 五套外观主题

- 本地 `npm run check`：134 项 Node 测试，133 通过、1 项 Windows 专用测试跳过；TypeScript、生产构建通过。Electron / Playwright 三项桌面测试通过。
- 新增六项主题测试覆盖主题 ID 白名单与旧设置兼容、调色板完整性、CSS 与终端颜色一致性、颜色格式、对比度，以及主界面样式不再绕过语义色。
- 五套主题的正文、辅助文字、代码、状态和差异文本按至少 4.5:1 校验；焦点、关键控件边界、滚动条按至少 3:1 校验。终端同时设置 `minimumContrastRatio: 4.5`，处理程序自行输出的 ANSI、256 色和真彩色文字。这些是具体配色检查，不等于整个应用通过无障碍认证。
- 新增真实 Electron 主题测试，覆盖即时预览、保存、取消、重启恢复、旧数据默认主题、非法主题拒绝、草稿与对话保留，并检查实际渲染的文字对比度、键盘焦点及 1460×920、980×680 两种窗口下主题卡片和保存按钮可见。
- 切换五套主题期间，真实 Shell 的终端 DOM、正在运行的进程和 Shell 环境变量均保持；没有重建 PTY。单独保存外观也不会重新启动 Claude CLI 探测。
- 已复核五套主题的同场景实际截图，包含正文、代码、Git 增删差异、侧栏和输入框；另复核设置面板。预览见 [主题说明](THEMES.md)。测试不访问真实模型。
- 三平台安装载荷保留下述 v0.2.2 的完整门禁，发布必须等待门禁全部成功；CI 配置同时保存五套主题截图。
- 本次远程发布受阻：[Actions 35676911960](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35676911960)，源码提交 `a57179198ea9105fc2f8e8b63ec259655cc245a9`。初次运行及重试均在分配 Runner 前失败（Runner ID 为 0、步骤列表为空），未执行项目代码、三平台检查或打包，发布任务跳过。用户随后提供的 GitHub 注释指向账号付款失败或支出限制，尚不能区分具体是哪一种。v0.2.3 安装包和便携包尚未生成；没有跳过验证门禁发布。

## v0.2.2 可靠性与重复回复修复

- 本地 `npm run check`：128 项 Node 测试，127 通过、1 项 Windows 专用测试跳过；TypeScript、生产构建通过。Electron / Playwright 两项 E2E 通过，截图已复核。
- 重复回复覆盖流式/完整 envelope/result 三路输出、多文本块、缺失或重复消息 ID、子任务、长正文截断，以及不同轮次相同文本应保留。旧数据迁移只移除日志明确证明的 synthetic result 回声，不改写原日志；没有来源依据的历史重复保留。
- 可靠性回归覆盖磁盘写入失败仍停止进程、退出等待后代清理、恢复磁盘后重试退出、后台无进展计时及审批暂停、快照游标回放和部分 JSONL 尾行、外部历史的稳定身份锚点。
- 5000 文件的历史测试证明未变化的连续翻页不再重新解析元数据；同时验证缓存有界及修改后的失效。附件测试覆盖原名/大小重启恢复、未发送副本回收、发送失败保留草稿及已引用文件保护。
- Worktree 测试覆盖目录别名/子目录占用、衍生依赖、仓库串行操作；另验证重命名 diff、实际会话目录诊断、工作流容量回收、导出与持久化失败后的完整退出。
- 桌面 E2E 覆盖真实 Shell，以及协议 fixture 的多轮回复数量、审批理由/回答切换保留、组合输入快捷键、模态焦点、归档/筛选下通知导航、附件重启和纯附件发送、工作流导出/删除。fixture 不访问真实模型，通知通过应用事件触发；不等于真实 OS 通知或实际中文输入法验收。

新增 `npm run test:packaged`，直接运行最终包内程序并断言 `app.isPackaged`、ASAR、架构、独立数据目录，执行真实 PTY 输出、干净退出、旧 version-1 状态与终端记录重启、隐藏窗口后二次启动恢复：

| 平台 | 发布载荷验证 |
| --- | --- |
| Windows x64 | NSIS 静默安装后的 EXE；ZIP 解压程序；完成后卸载 |
| macOS arm64 | DMG 挂载并复制的 app；ZIP 解压 app |
| Linux x64 | tar.gz 解压程序；AppImage 提取出的程序 |

三平台实际结果以 [v0.2.2 Release](https://github.com/lixia3987-netizen/cc-desk/releases/tag/v0.2.2) 附带的 Actions 记录为准；发布依赖这些门禁全部成功。CI 附件保存 `packaged-manifest.json`（包 SHA-256、源提交、架构、验证状态与范围）和测试结果。本地受执行环境 AF_UNIX 限制，无法完成 production singleton 启动验证；没有关闭单实例机制绕过验证。

当前不包含签名/公证、系统安装权限弹窗或 SmartScreen/Gatekeeper 验收；Windows 便携 EXE 外层启动器、Linux FUSE 挂载、卸载时真实旧用户数据保留、实际账户与模型调用仍待实机验收。macOS/Windows 文件预览已补前后身份检查，但面对恶意反复替换目录的完整 ABA 防护仍需原生句柄能力。此前报告逐项处理与剩余边界见 [修复清单](FIXES-v0.2.2.md)。

## v0.2.1 Windows npm 兼容性补丁

- 本地 `npm run check` 通过：70 项 Node 测试通过，1 项仅 Windows 执行的真实子进程测试跳过；TypeScript 和生产构建通过。
- 新增测试验证新版 npm 原生入口、旧版 JavaScript/Node 入口、全局/自定义 prefix/本地 .bin 布局、引号/中文/空格路径、PATH 大小写、入口边界、分类安装错误。Windows 专用测试检查真实原生/Node 子进程保留参数字面值，未执行 CMD/BAT 内容。
- Windows CI 新增实际安装 `@anthropic-ai/claude-code@2.1.278` 的门禁：仅执行 `--version` / `--help`，验证显式 `.cmd`、PATH 自动发现及无 Node PATH 的原生入口解析。三平台实际结果见 [v0.2.1 Release](https://github.com/lixia3987-netizen/cc-desk/releases/tag/v0.2.1) 附带的构建记录。
- 本补丁不包含之前独立检查报告中的其它优化。下面保留 v0.2.0 的历史验收记录；本补丁没有把它们重新表述为真实安装包或模型端到端验收。

## v0.2.0 历史记录

日期：2026-09-21。此文区分代码测试、真实 CLI 控制验证和未完成的外部环境验收。

## 本地验证

- `npm run check`：通过。包括 TypeScript、61 项 Node 单元/集成测试和 Vite/esbuild 生产构建。
- Electron / Playwright：2 项端到端测试通过。
- 已查看当前审批、结构化对话、Git diff、工作流及终端截图，未发现遮挡或溢出。
- `git diff --check`：通过。

测试覆盖：

- JSONL 分包/粘包与畸形输出；真实子进程的双向协议、多轮、恢复、UUID不匹配、控制超时与进程结束。
- 审批不可复用/过期处理、原始参数不可被renderer替换、用户问题、中断、初始化/认证失败重试、日志写入失败、后台任务缺失最终结果。
- 消息投影有界、完整工作台事件日志、旧对话只读导入；附件会话隔离、复制、大小限制、符号链接替换拒绝。
- 510 个较新其他项目不掩盖旧项目历史、全文搜索越过128KiB、分页/缓存失效、损坏行保留、原始JSONL完整导出。
- 真实 Shell PTY 的输入、中文/空格路径、并发、调整尺寸和停止；日志轮转两段导出、停止缓存淘汰。
- 真实本机 HTTP hooks 的令牌验证、载荷限制、无审批响应、身份切换和旧事件过滤；禁止用未确认身份恢复。
- Git 路径穿越/符号链接/literal pathspec、暂存/未暂存/未跟踪/二进制/重命名/删除diff；Worktree所有权、干净/已合并/忽略文件保护、快进合并。
- 配置诊断无秘密泄露、认证语义、MCP/Skills只读来源；没有执行MCP程序或修改用户配置。
- 工作流依赖、摘要、阶段确认、有限手动重试、取消与迟到结果、崩溃恢复、目录绑定、退出中断。

Electron E2E 的第一项运行真实 Shell；第二项通过应用配置一个真正的协议测试可执行进程，经过完整 renderer → IPC → subprocess 通路，验证批准/拒绝/问答、会话切换、重启草稿、旧发送回调不覆盖新草稿、HTML安全显示、diff反馈、项目引用，以及三阶段工作流逐段继续。该 fixture 不访问模型，不能替代真实 Claude 工具执行测试。此结构化 fixture 测试目前在 Windows 跳过，Shell 测试仍在 Windows 执行。

## 真实 Claude CLI 控制验证

使用 Claude Code CLI **2.1.278**，独立临时配置目录，无模型请求：

- `--print --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --include-partial-messages` 启动并建立 initialize 控制握手。
- `initialize`、`set_model`、`set_permission_mode`、`interrupt` 四项控制均收到成功应答，stderr为空。

这证明该版本接受当前双向控制接口，不证明账户、provider、模型、MCP或实际工具审批已通过。真实使用沿用用户配置，测试中的隔离配置不会写入产品默认行为。

## 跨平台 CI

仓库 workflow 会在 Windows/macOS/Linux 上安装依赖、检查、执行桌面测试并打包。v0.1 初始 CI 暴露两项已修复问题：

- macOS node-pty spawn-helper 缺执行位：增加 postinstall 修复。
- Linux electron-builder 在 CI 隐式发布导致缺GH_TOKEN：三个打包脚本增加 `--publish never`。

同时修复 Windows taskkill 后 ConPTY worker 的原生释放，并为 CI 设置 20 分钟上限。跨平台测试还修正了 macOS `/var` 真实路径断言、Windows Git 临时目录短暂占用的有限清理重试，以及 Windows 8.3 短路径与长路径显示不同的问题。真实 Shell 会读取工作目录中的随机标识文件验证目录身份，保留中文输入和启动后立即停止的验证。

验收代码提交为 `a9cca833f40eba495eba594f1eccace9cc18466f`，详见 [GitHub Actions 记录](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35617425289)：

| 平台 | TypeScript / 生产构建 | Node 测试 | Electron E2E | 安装包构建 |
| --- | --- | --- | --- | --- |
| Windows | 通过 | 60 通过，1 跳过 | 1 通过，1 跳过 | NSIS `.exe` 通过 |
| macOS | 通过 | 61 通过 | 2 通过 | `.dmg` 通过 |
| Linux | 通过 | 61 通过 | 2 通过 | `.AppImage` 通过 |

Windows 跳过附件符号链接替换测试和依赖 POSIX 可执行 fixture 的结构化 E2E；这些测试在 macOS/Linux 执行。Windows 仍执行结构化运行器的真实子进程协议测试，以及真实 PowerShell 的输入、Unicode/空格目录、停止、桌面交互和重启持久化测试。上述通过不等于真实账号与模型调用验收。

三平台作业均成功完成。首次交付提交 `810e06e` 仅补充 README 下载指引和本验证记录，没有改动上述已验证的程序与测试代码。后续 Release 构建在此基础上增加便携 EXE、ZIP 和 tar.gz，重新执行同一套检查与桌面测试；实际结果见 [v0.2.0 Release](https://github.com/lixia3987-netizen/cc-desk/releases/tag/v0.2.0) 正文中的构建记录，附件同时提供 SHA-256 校验文件。

安装包尚未签名、公证；CI 运行的是构建后应用，未做安装向导、系统权限弹窗或升级验收。免安装包也不代表默认用户数据存储在程序旁边。

## 尚未验证

- 已登录 Claude 的模型请求、真实工具批准/拒绝、恢复与分支、MCP认证、长期后台子代理和不同provider行为。
- Windows中文输入法、原生CLI、用户电脑上的通知/托盘；macOS实际用户账户及系统权限提示。
- 组织禁用hooks、托管策略、不同CLI版本兼容性。
- 签名、自动更新与真实用户升级；本项目未配置发布签名证书。

## 接口依据

- [程序化 CLI / stream-json](https://code.claude.com/docs/en/headless)
- [CLI 参数和认证](https://code.claude.com/docs/en/cli-reference)
- [公共 hooks 与 HTTP 支持范围](https://code.claude.com/docs/en/hooks)
- [Anthropic SDK 控制消息实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)
- [MCP 配置](https://code.claude.com/docs/en/mcp)
- [Skills](https://code.claude.com/docs/en/skills)
