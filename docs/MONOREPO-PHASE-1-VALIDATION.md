# 阶段一实现与验收记录

日期：2026-09-24。开发集成分支：`dev/native-agent`；阶段分支：`refactor/monorepo-foundation`。本阶段不合入 main、不发布 Release。

## 实现范围

- 采用 npm workspaces：现有桌面应用迁入 `apps/desktop`，新增私有 `packages/contracts`，根目录保留一个锁文件和日常命令。
- 提取 execution、chat、execution-events 及 SessionStatus/TerminalChunk；桌面原路径单向 re-export。契约提供编译后的 ESM 和声明，桌面仍将运行时代码打包到 CJS。
- 构建、开发、Playwright、原生依赖准备和安装包验证使用明确的桌面路径。`release/`、文档和测试报告仍位于仓库根目录。
- 应用身份保持 `claude-workbench` / `Claude Workbench` / `0.5.0` / `io.local.claude-workbench`。存储 schema、CLI 行为和执行器保持不变。
- 增加 PR 快速检查；保留手动三平台源码回归、安装包构建和解包后验收。发布作业仍要求 main 且显式开启发布。
- 三平台验收期间修正基线测试的 Windows fixture 差异，并修复聊天快照在会话删除后返回错误时污染页面的既有竞态；没有改变删除、目录清理或 CLI 执行逻辑。

## 本地基线与验证

基线提交为 `15fb917fb24d6104ea96fbdf526a429e51d5e601`，应用代码等同 `main@a3f94b6c74f2abfad7a38306803319226dd5d436`。

| 项目 | 结果 |
| --- | --- |
| 运行环境 | Linux x64，Node 22.23.3，npm 10.9.9 |
| 基线干净安装与 `npm run check` | 成功；381 项单测中 380 通过、1 跳过；类型检查和构建通过 |
| 迁移后干净 `npm ci` | 成功；真实运行 native postinstall |
| 迁移后 `npm run check` | 成功；桌面 382 项中 381 通过、1 跳过；契约新增 3 项全部通过；类型检查和构建通过 |
| 测试发现清单 | 保留全部 39 个基线单测文件、14 个源码 spec（55 项）和 1 个 packaged spec |
| Linux 源码桌面回归 | 55 项全部通过，运行 7.4 分钟 |
| 根命令参数转发 | `npm run typecheck -- --pretty false` 实际传入 TypeScript 并通过 |
| 锁文件比对 | 已有第三方依赖版本没有变化，新增本地 workspace 链接 |
| 独立审查 | 参数转发缺陷已修复，复核未发现其他迁移缺陷 |

基线与候选保留相同的既有平台跳过项，未删除测试或增加重试。安装环境最初的 Node 24 头文件解包失败已通过使用项目 Node 22 环境解决。构建的大 chunk 提示与基线一致。

## 安装包与数据身份验收

候选 `1dc5f17` 的 [PR 快速检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36034548378) 已通过。[首轮三平台验收](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36034704893) 发现新增契约测试在 Windows 下未统一路径分隔符，误将 TypeScript 标准库判为外部依赖。现已在比较前用 `path.resolve()` 统一路径，保持全部边界断言，修复后的契约 3 项测试通过。完整矩阵需在修复候选上重新执行，首轮不能作为修复后代码的验收证据。

[第二轮候选 `18262ad`](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36035411051) 的 Linux 完整验收通过：桌面 55/55，默认数据目录及 tar/AppImage 成品测试 3/3；该候选的 [PR 快速检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36035257276) 也通过。Windows 契约 3/3 通过后，暴露出基线 Git 测试的 CRLF 和隐藏 `.git` 文件写入问题；修复仅固定 fixture 仓库本地换行配置，并以 `r+` 截断写入既有测试文件，全部文件保护断言保留，Linux 定向 Git 测试 16/16 通过。

首轮 macOS 静默 PTY 退出测试发生一次 `EPERM`，涉及的两个运行时文件与基线逐字一致；第二轮该检查通过。由于缺少出错瞬间的进程表，原因未确证，未修改清理逻辑，也不宣称已修复此问题。第二轮 macOS 桌面回归为 54/55，最后一项删除会话后出现异步错误提示。

针对上述 UI 问题，真实 Electron 受控回归已复现：聊天刷新请求在会话删除、ChatPane 卸载后继续执行，原 IPC handler 抛出“会话不存在。”，旧实现仍显示错误横幅。修复令失败与成功结果采用同样的挂载状态和请求序号判断；活动会话当前请求的真实错误仍上报。新增回归在旧实现失败、修复后通过，并验证活动错误可见。修复后两种损坏 Worktree 与新回归 3/3 通过，类型检查和独立审查通过；最终源码发现清单为 14 个 spec、56 项测试，须随最终候选运行完整三平台验收。

本地 Linux 构建退出码为 0，但成品测试未通过：tar 包完整，启动受容器 Unix socket 限制；AppImage 的 ASAR 尾部截断。两个失败均未计为通过，未更改应用单实例机制或环境权限。第二轮原生 Linux CI 的两个成品均已正常启动并完成全部断言，本地截断问题没有在 CI 复现。

候选 `131e1d9` 的完整矩阵三平台基础检查通过，但并行 [PR 快速检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36037812370) 在既有异步子任务测试中暴露调度竞态：fixture 输出启动确认 150ms 后自动完成，父测试可能一次看到确认和完成，随后忙碌断言失败。现改为临时文件同步：fixture 先监听，父测试验证原有忙碌、单任务和 running 断言后显式放行完成事件；所有结束断言保留。旧 fixture 加速完成的受控实验复现原失败，修复后的 async/remote 两分支定向测试通过，未增加睡眠或重试。

安装包测试保留 PTY、持久化、旧 version-1 数据、第二实例、正常退出和包内资源检查；增加包内 manifest、应用名称/版本断言。额外默认 userData 探针仅在一次性 GitHub Actions 用户下运行：不设置 `--user-data-dir`，验证平台默认路径与固定应用身份、实际工作区数据路径一致。探针拒绝使用已有目录，确认进程退出及目录归属后才清理新建目录；本地运行明确跳过此探针，原有隔离数据目录测试继续运行。

本阶段建立后续双引擎开发的包边界，尚未实现自研 Agent 的模型循环、工具执行或引擎选择界面。
