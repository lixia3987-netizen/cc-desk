# v0.2 验证记录

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
