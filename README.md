# Claude Workbench / cc-desk

封装本机 Claude Code CLI 的独立桌面工作台，Electron + React + TypeScript，中文界面，面向 Windows、macOS 和 Linux。

**v0.2.3 三平台构建与验证已通过，安装包已生成。** 新增五套完整主题：森野绿、云白靛、暖砂陶、极夜蓝、墨黑琥珀。支持即时预览、保存恢复，终端同步换色并保留运行中的会话。[查看主题预览](docs/THEMES.md)。[本次构建](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725728224) 基于 `83f3fe9`，Windows x64、macOS arm64、Linux x64 均完成检查、桌面测试、打包和实际包启动验证；下载见下方工作流附件。

**v0.2.2** 修复回复重复显示、退出清理、审批等待、历史恢复与缓存、Worktree 依赖和界面交互；新增标准 Markdown、附件草稿恢复、工作流导出/删除，以及实际发布包启动验证。详见 [修复清单](docs/FIXES-v0.2.2.md)。保留 v0.2.1 的 Windows npm CLI 兼容性修复。

v0.2.3 还包含 [第一轮体验修复](docs/UX-FIXES-round1.md)：工作流与审阅草稿跨切换/重启保存、模板追加、正确选择新建项目、长对话阅读位置、CLI 路径检测和 Git 自动刷新等九项改进。最新三平台测试结果见 [验证记录](docs/VALIDATION.md)。

本轮新增 [对话检索与待处理入口](docs/UX-FIXES-round2.md)：Ctrl / ⌘ + F 查找本地消息并定位工具卡片，按页查看更早记录，跨会话恢复阅读，顶栏集中处理各项目的审批与提问。

侧栏现已按项目分组展示会话，可折叠、搜索和在项目内直接创建；对话顶部合并为紧凑标题栏，增加消息阅读空间。[查看布局与新截图](docs/UX-LAYOUT.md)。

**v0.2.0** 增加结构化对话、图形化工具审批、项目文件与代码审阅、配置诊断和持久化工作流，同时保留原生 Claude 终端与 Shell。模型、账户、provider 和底层工具仍由本机 CLI 提供。

## 下载安装包与便携包

v0.2.3 安装包与便携包保存在本次工作流的 Artifacts： [Windows x64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725728224/artifacts/10694005447)、[macOS arm64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725728224/artifacts/10693093630)、[Linux x64](https://github.com/lixia3987-netizen/cc-desk/actions/runs/35725728224/artifacts/10692668154)。登录有仓库访问权限的 GitHub 账户下载并解压附件，再选择其中的安装包或便携包。工作流附件会按保留期限过期；本次没有发布新的 GitHub Release。

当前已发布的 Release 仍为 [v0.2.2](https://github.com/lixia3987-netizen/cc-desk/releases/tag/v0.2.2)，不包含本次主题、体验修复和项目分组布局；下表列出该 Release 的文件。后续版本见 [Releases](https://github.com/lixia3987-netizen/cc-desk/releases)。

| 系统 | 安装包 | 便携包（免安装） |
| --- | --- | --- |
| Windows x64 | `cc-desk-0.2.2-windows-x64-setup.exe` | `cc-desk-0.2.2-windows-x64-portable.exe`，或 `cc-desk-0.2.2-windows-x64-portable.zip` |
| macOS arm64 | `cc-desk-0.2.2-macos-arm64-setup.dmg` | `cc-desk-0.2.2-macos-arm64-portable.zip` |
| Linux x64 | 无系统安装器 | `cc-desk-0.2.2-linux-x86_64-portable.AppImage`，或 `cc-desk-0.2.2-linux-x64-portable.tar.gz` |

macOS 发布包固定为 Apple silicon 的 `arm64`；尚未提供 Intel 包。Windows 单文件便携版直接运行；ZIP 解压后运行其中的应用程序，需保留完整目录。macOS ZIP 解压得到 `.app`。Linux AppImage 增加执行权限后运行；`tar.gz` 解压后运行 `claude-workbench`，需保留完整目录。

这里的“便携”指免安装；会话、附件与设置默认仍保存在 Electron userData 目录，不会随可执行文件迁移。准确数据路径可在设置中查看。Release 同时提供 `SHA256SUMS.txt`，可校验下载文件。

安装包尚未签名或公证，当前没有自动更新；更新时下载新版本。使用前先安装并登录本机 Claude Code CLI，再在“设置与连接”中检测或指定 CLI 路径。安装桌面包本身不需要执行下面的源码构建命令。

### Windows npm 安装的 CLI

新版 npm 包声明的入口是 `bin/claude.exe`，旧版是 `cli.js`；工作台读取实际包信息，分别直接启动原生程序或使用 Node.js。无需把 npm 的 `claude.cmd` 改名为 `.exe`。

自动检测失败时，在 PowerShell 执行 `where.exe claude`，将结果中的 `claude.cmd` 或 `claude.exe` 完整路径填入“设置与连接 → CLI 路径”，点击“保存并检测”（v0.2.3），按当前输入检查 CLI。v0.2.2 及更早版本需先点击“保存设置”，其“重新检测”使用已保存的路径。支持标准全局 npm、自定义 npm prefix 和项目 `node_modules/.bin` 的安装布局。旧版 JavaScript 入口需有同目录或 PATH 中的 `node.exe`；安装 Node 或更改 PATH 后，应完全退出托盘中的工作台再打开。

若提示 npm 启动文件缺失，先在终端确认 `claude --version` 能运行，再修复 npm 安装；工作台不会执行任意 CMD/BAT 内容，也不会自动改写 Claude 配置。

## 运行与打包

需要 Node.js 22.12+、npm、Git；使用 Claude 会话还需要安装并登录 Claude Code CLI。推荐原生 CLI 安装。

```sh
npm ci
npm run dev
```

也可运行 PowerShell 的 `./scripts/start.ps1`，或 macOS/Linux 的 `bash scripts/start.sh`。首次运行会安装依赖和构建；修改代码后重新构建。

```sh
npm run check        # TypeScript、单元/集成测试、生产构建
npm run test:e2e     # Electron UI + 真实 Shell / Claude 协议测试进程
npm start           # 启动已有 dist
npm run dist:win    # Windows 上构建 NSIS 安装包、单文件便携 EXE、ZIP
npm run dist:mac    # macOS 上构建 DMG、免安装 ZIP
npm run dist:linux  # Linux 上构建 AppImage、免安装 tar.gz
npm run test:packaged # 本机验证已构建的实际发布包（Windows 会安装/卸载，手动需 -- --allow-install）
```

Linux 编译 node-pty 需要 Python 3、make、C++ 工具链；无图形桌面的 CI 使用 `xvfb-run -a npm run test:e2e`。postinstall 会修复 node-pty macOS spawn-helper 的执行权限。所有打包命令显式关闭自动发布。

GitHub Actions 构建仅手动触发；日常提交、推送、PR 和 `release:` 提交均不会自动启动构建。需要安装包时，在 Actions → Verify and package desktop → Run workflow 手动运行；默认只验证和打包，产物保存在 Artifacts。

维护者发布版本时，先更新 `package.json` / 锁文件版本及对应的 `docs/releases/v<版本>.md`。随后在 main 分支手动运行构建工作流并勾选 `publish_release`。三个系统的验证与打包全部成功后，工作流上传安装包、便携包和校验文件，核对资源后发布 GitHub Release。

## 主要流程

1. 添加项目目录，创建 Claude 会话，选择“结构化对话”或“原生终端”。Shell 始终使用终端模式。
2. 结构化模式直接发送消息，查看流式文本、工具输入/结果和真实任务状态。CLI 请求人工决定时，会显示批准/拒绝卡片或问题选项。
3. “上下文”面板修改模型、权限和推理强度。结构化模式在空闲回合间可修改模型/权限；修改强度需先停止进程。终端模式的启动配置也在停止后修改。
4. “变更”面板查看暂存、未暂存和未跟踪文件的 diff，将审阅意见放入当前会话草稿。
5. “工作流”面板创建目标和阶段，按依赖顺序执行；阶段由真实 CLI 回合结果推进，支持逐阶段确认、取消、手动重试及恢复。
6. “诊断”面板检查 CLI、认证状态及用户/项目配置，浏览 MCP 和 Skills 清单。

`Ctrl/⌘ + K` 打开命令面板。设置可开启任务通知和关闭窗口后保留到托盘；只有实际退出程序才会停止全部进程。

## 功能与边界

| 能力 | 行为 |
| --- | --- |
| 外观主题 | 两套浅色、三套深色，覆盖对话、代码、终端与弹窗；预览、保存、取消与重启恢复 |
| 项目、会话 | 创建、切换、恢复、重命名、归档、删除；每个会话独立草稿，恢复最近选择 |
| 外部 IDE | 指定 VS Code、WebStorm 或定制版应用路径，一键打开当前项目或会话的隔离工作目录 |
| 面板布局 | 顶栏一键收起/展开右侧面板，记住显示状态；收起后对话与终端自动扩展 |
| 结构化对话 | 单会话单运行器，流式/完整/最终结果按消息来源合并；标准 Markdown、代码复制/高亮、表格；Mermaid 源码/预览切换；HTML 按文本显示 |
| 审批和提问 | 顶栏集中显示各项目的有效请求，点击跳转并聚焦；保持原始工具参数，审批限当前请求，过期不可复用 |
| 模型和权限 | 支持按需审批、Plan、接受编辑、Bypass；可保存默认权限模式，单个会话可覆盖 |
| 上下文 | 项目文件检索/预览与 @引用；附件原名/大小、重启恢复与移除回收、纯附件发送；8 个附件、单个 8 MiB、合计 16 MiB |
| 历史 | CLI 历史按项目分页/全文搜索；当前对话可检索本地保留消息、定位并分页阅读旧记录；不改写原日志 |
| Git 审阅 | 文件级真实 diff、二进制提示、有界预览；不会隐式暂存或提交 |
| Worktree | 创建并记录所有权；干净且可快进时合并；停止、干净、已合并且无忽略数据时清理；保留分支 |
| MCP / Skills | 配置来源与元数据清单；结构化会话显示 CLI 报告的 MCP 状态；只读诊断不会启动服务器 |
| 工作流 | 顺序依赖、摘要产物、有限手动重试、取消和崩溃恢复；历史导出/删除；沿用会话权限和工作目录 |
| 终端 | node-pty + xterm.js；中文、尺寸调整、输入、中断、进程树停止；停止缓存有界 |
| 本地数据 | 原子状态文件和备份；结构化消息快照与事件日志；附件在应用数据目录保存副本 |

“CLI 已检测到”不等于模型服务可达；登录状态也不等于 provider 请求已成功。诊断不会发出收费的模型测试请求，不展示密钥、请求头、命令参数或完整认证错误。

### 会话与权限

终端模式的“运行中”表示进程存活；可用时，客户端额外使用会话专用 HTTP hooks 展示观察到的任务状态与身份。hooks 需要支持的 CLI 版本和用户/组织设置允许。无法获得事件时会明确显示等待/未支持，而不会猜测终端文字。原生终端内清空或切换会话后，身份可能需等下一条可观察事件才能确认；未确认身份不会被用于恢复。

结构化模式要求 CLI 支持 stream-json 及双向权限控制。启动握手不兼容会明确失败，可创建终端模式会话继续使用。底层接口随 CLI 版本变化，应查阅 [验证记录](docs/VALIDATION.md)。客户端不是 Anthropic 官方产品，不提供第三方账户登录服务。

消息中的 `mermaid` 代码块默认显示图表，顶部可切换「预览 / 源码」并复制原始源码。图表在本地按需渲染，跟随工作台主题；宽图和长图可在预览区滚动。流式源码未完成或语法错误时保留源码入口，更新后可恢复预览。工具结果与工作流摘要中的 Mermaid 同样支持；图表不启用 HTML 或链接交互。

会话顶部最右侧的面板按钮可收起或展开右侧「上下文 / 变更 / 工作流 / 诊断」。收起后对话或终端会自动占用释放的空间，再次展开保留当前页签和未保存的输入。显示状态在本机记忆，切换会话或重启后继续沿用；收起面板不停止正在执行的任务。

在「设置与连接 → 外部 IDE 应用」中选择或填写应用的完整路径，点击「保存设置」。顶部「IDE」按钮会用指定应用打开当前会话的工作目录；隔离会话打开对应 worktree，项目概览打开项目根目录。未配置时，点击按钮会直接定位到设置项；清空路径并保存可移除配置。

支持定制版 VS Code / WebStorm：Windows 选择 `Code.exe`、`webstorm64.exe` 等程序；macOS 选择 `.app` 应用或可执行文件；Linux 选择可执行文件或带执行权限的启动脚本（如 `webstorm.sh`）。路径中可以有空格和中文，无需附加项目路径或命令参数。Windows 请直接选择 `.exe`，不使用 `.cmd`、`.bat` 或快捷方式。配置仅在本机保存，应用被移动或删除时会提示重新选择。

在「设置与连接 → 默认权限模式」中选择新建和首次导入会话使用的模式，初始值为按需审批。新建或导入时可单独覆盖；已有会话保留自己的模式，创建分支时继承原会话模式。右侧「上下文 → 运行配置」可以修改当前会话的权限。设置仅保存在工作台，不修改 Claude Code 的全局配置。

Bypass 使用 CLI 的 `--permission-mode bypassPermissions`，允许工具直接修改文件和执行命令；CLI 的强制限制与需要用户回答的提问仍会生效。客户端保留审批通路，不代答 CLI 发出的请求。结构化会话在空闲时切入或退出 Bypass 会停止当前 CLI，下一次发送恢复原会话并应用新的启动模式；任务执行中不能切换，原生终端需先停止再修改。普通模式的启动参数不会额外启用 Bypass。模式语义见 [Claude Code 官方说明](https://code.claude.com/docs/en/permission-modes)。

审批仍遵循 CLI 自身权限规则：已由本地规则允许的工具可能不会向 GUI 请求审批。工作流继承会话权限，阶段的自然语言目标并非额外沙箱；“阶段完成”表示 CLI 回合完成，文件和测试结果仍需审阅。

### 恢复与数据

停止进程后恢复的是 Claude 保存的对话，不是原操作系统进程。已建立的对话缺少原始 transcript 时会报错，禁止静默新建替代上下文。归档不删除数据；删除工作台会话会清理自己的消息记录和附件，保留 CLI 原始历史。独立 worktree 必须先审阅和清理；清理后的会话归档，不自动换到另一个目录继续执行。

结构化实时界面保留有界消息投影，旧消息可按页读取；会话内检索覆盖工作台保留的本地记录，长内容或部分导入会明确提示。完整可用记录仍可导出读取。终端日志是滚动保留的调试输出，导出包含上一段和当前段，不能视为完整对话备份。对话与工具输出可能含项目内容，存放在本机，请按自己的数据保留需求管理。

v0.2.2 会回放快照之后的完整日志事件，并自动修正旧日志能够证明的重复结果。没有足够来源信息的旧重复文本会保留；不会按文本相同批量删除历史。CLI 原始记录不改写。

默认数据目录为 Electron userData，准确路径显示在设置中：

```text
workspace.json / workspace.json.bak  项目、会话、草稿、非秘密设置
chat/                               结构化快照和事件日志
workflows.json                      工作流阶段与摘要产物
attachments/                        用户选定附件的副本
logs/                               滚动终端日志
worktrees/                          客户端创建的 Git 工作目录
```

状态损坏时保留原文件并报错。恢复备份前先关闭应用并保留损坏文件副本。新版的自动 worktree 管理只处理具有可信所有权记录的目录，旧版目录保守保留。

## 规划与验证

- [架构与权限边界](docs/ARCHITECTURE.md)
- [实际验证记录](docs/VALIDATION.md)
- [迭代状态与剩余工作](docs/ROADMAP.md)
- [最初需求与开发提示词](docs/REQUEST_AND_PROMPT.md)

签名安装包、自动更新、WSL/SSH、开发服务器预览、PR/CI 管理和远程调度仍属于后续迭代。当前构建不包含签名证书，也不宣称真实 Claude 账号及所有桌面系统已验收。
