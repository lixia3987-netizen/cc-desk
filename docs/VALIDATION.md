# v0.2 验证记录

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

同时修复 Windows taskkill 后 ConPTY worker 的原生释放，并为CI设置20分钟上限。v0.2 的远程结果以对应提交的 GitHub Actions 记录为准；本地通过不等于三个系统均已验收。

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
