# Claude Workbench

封装本机 **Claude Code CLI** 的独立桌面客户端。中文界面，支持 Windows、macOS 和 Linux。桌面层使用 Electron + React + TypeScript；交互层使用 node-pty + xterm.js。

这是一个可运行的 v0.1 客户端，不需要 Claude Desktop。需要另外安装并登录 Claude Code CLI；模型、账户权限、计费以及 MCP 都由 CLI 处理。

## Windows 便携版

1. 解压 `Claude-Workbench-0.1.0-Windows-x64.zip` 到本地目录。
2. 运行目录中的 `Claude Workbench.exe`。**不要只提取 exe，其他文件必须保留。**
3. 点击「设置与连接」。通常会自动检测 `claude`；如未找到，填写官方原生安装的 `claude.exe` 完整路径，例如 `C:\Users\你的用户名\.local\bin\claude.exe`。
4. 添加项目文件夹 → 新建会话 → 启动会话。
5. 在内嵌终端内完成 CLI 的登录、目录信任确认和工具审批。

便携包已在 Linux 上交叉打包并检查所需 Windows ConPTY 文件；没有在真实 Windows 机器上启动验收，属于预览构建。当前未做代码签名。

## 从源码运行

需要 Node.js 22.12+（建议 22 LTS 或 24 LTS）、npm、Git，以及你安装的 Claude Code。

```powershell
npm ci
npm run dev
```

或者在 PowerShell 执行 `./scripts/start.ps1`，在 macOS/Linux 执行 `bash scripts/start.sh`。脚本首次运行安装依赖并执行生产构建，后续直接启动；修改源码后请重新 `npm run build`。

```sh
npm run check       # TypeScript、单元/集成测试、生产构建
npm run test:e2e    # 桌面 UI + 真实终端自动化
npm start          # 运行已有 dist 构建
npm run dist:win    # 在 Windows 生成 NSIS 安装包
npm run dist:mac    # 在 macOS 生成 DMG
npm run dist:linux  # 在 Linux 生成 AppImage
```

node-pty 1.1 使用 Node-API。Windows/macOS 包提供预编译模块；Linux 从源码编译，需要 Python 3、make 和 C++ 编译器。若 Windows 预编译不可用，需安装 Visual Studio Build Tools 的 C++ 工具链和 Python。无需为 Electron 重复重编译 Node-API 模块。

## 已实现

| 能力 | 行为 |
| --- | --- |
| 项目管理 | 原生文件夹选择器添加项目、按项目筛选、搜索会话 |
| 会话生命周期 | 创建、启动、切换、重命名、中断当前任务、停止进程、恢复、归档及取消归档 |
| CLI 会话恢复 | 新建时指定 UUID；真实 transcript 存在时使用 `--resume`；导入始终恢复指定 ID |
| 真实交互终端 | ANSI、中文输入、滚动、尺寸自适应；审批、登录、斜杠命令交给 Claude Code |
| Shell | Windows 默认 PowerShell，macOS/Linux 默认登录 Shell；可以指定完整路径 |
| CLI 能力检测 | 读取本机 `--version` 与 `--help`；仅展示帮助中声明的 effort |
| 模型与权限 | 模型别名或完整 ID；default、plan、acceptEdits；不自动跳过审批 |
| 多会话 | 默认最多 4 个进程，可设置 1–12 个；切换标签不结束后台会话 |
| 历史导入 | 只读扫描本地 CLI transcript；也支持输入会话 UUID |
| 会话分支 | `--resume` + `--fork-session` + 新 UUID；再次恢复沿用分支 UUID |
| Worktree | 基于所选源目录 HEAD 创建独立 Git 分支和目录 |
| Git 查看 | 当前分支、改动文件、暂存与未暂存变更统计 |
| 工作流提示词 | 开发、审查、修复模板放入编辑器，由用户确认后粘贴到终端 |
| 本地持久化 | 原子替换、上一版备份、崩溃后将运行状态还原为已停止 |
| 终端日志 | 每会话日志滚动、重开回放、文本导出；内存缓冲有大小上限 |

## 需要知道的行为

- **运行中**表示 CLI 进程仍在运行，不表示模型正在生成。这一版不解析 TUI 文本来猜测任务完成状态。
- **中断任务**发送 Ctrl+C；**停止**终止整个会话进程树。再次恢复的是 Claude 保存的对话，不是原操作系统进程、Shell 作业或尚未保存的编辑器状态。
- 提示词编辑器用于准备长文本。点击「粘贴到终端」后，请检查当前是 Claude 的输入框，再按 Enter 发送。不要在权限选择器、登录交互或 Shell 提示符中粘贴任务提示词。
- 归档只修改工作台列表，不删除 `.claude` 历史、worktree、分支或项目文件。不会自动合并、清理 worktree。
- 同一目录的多个会话可能同时改文件；希望隔离时创建 worktree。新 worktree 不带入未提交改动，不自动安装项目依赖。
- `max`、`xhigh`、`ultracode` 各自传给 CLI；可用强度取决于本机帮助信息与模型，不将 `ultracode` 替换为 `max`，不声称提示词模板等于官方多 Agent 编排。
- 客户端沿用 CLI 的用户/项目配置以及从父进程继承的环境变量，不复制认证文件，不存储 API Key，不修改 ccSwitch 的配置。若 provider 仅在某个 Shell profile 中设置环境变量，请从该 Shell 启动本客户端，或者放到 Claude Code 支持的配置中。
- 历史扫描是对本机 JSONL 的尽力兼容：最多检查 300 个项目目录、每目录 1,000 个条目、最近 500 个候选、每文件头部 128 KiB，最多显示 100 条。CLI 历史格式不是工作台拥有的稳定接口；找不到记录时可使用 UUID 导入，或在 Claude 终端内使用 `/resume`。
- 在终端里使用 `/resume` 切换到另一个会话、`/clear` 创建新会话等操作时，客户端不会解析 TUI 来重新绑定 UUID。需要管理另一个 ID 时，请通过「导入 CLI 历史」创建对应条目。正常对话和 `/compact` 不影响本客户端的 ID 管理。
- 终端输出按原样保存在本机，可能包含代码、命令输出或敏感内容。每个日志达到约 5 MiB 后滚动为 `.previous`，导出的是当前日志；这不是完整 Claude 对话的备份。
- Windows 原生 PowerShell 与 Git Bash 可通过路径配置。此版没有 WSL 路径转换和发行版管理；不要直接填入 `wsl.exe` 期待自动映射项目路径。

## 数据位置

在「设置与连接」中显示实际路径，默认由 Electron 的 userData 规则决定：Windows `%APPDATA%/claude-workbench`，macOS `~/Library/Application Support/claude-workbench`，Linux `~/.config/claude-workbench`。实际显示的路径为准。

```text
workspace.json       项目、会话元数据和非秘密设置
workspace.json.bak   上次保存的副本
logs/                有界终端日志
worktrees/           客户端创建的独立 Git 工作目录
```

如果状态文件损坏，应用会明确报错并保留原文件。关闭应用后，保留损坏文件副本，再用 `workspace.json.bak` 恢复。卸载、迁移或清理数据目录前应检查其中的 worktree 未提交改动。

## 项目文件

- `src/main/`：受验证的 IPC、PTY 生命周期、存储、CLI 参数、Git、历史扫描。
- `src/preload/`：最小类型化桥接，不暴露任意 IPC 通道。
- `src/renderer/`：React 工作台和 xterm.js 终端。
- `src/shared/`：跨层类型和输入验证。
- `tests/`：恢复、存储、注入防护、PTY、Git worktree、桌面 UI 测试。
- `docs/REQUEST_AND_PROMPT.md`：找回的需求与本次重建的开发提示词，明确区别于历史原文。
- `docs/ARCHITECTURE.md`：架构与边界。
- `docs/VALIDATION.md`：实际验证记录与未验证范围。

## 官方接口依据

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [node-pty](https://github.com/microsoft/node-pty)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)

这是个人本地客户端项目，与 Anthropic 官方桌面产品没有隶属关系。
