# 阶段一实现与验收记录

日期：2026-09-24。开发集成分支：`dev/native-agent`；阶段分支：`refactor/monorepo-foundation`。本阶段不合入 main、不发布 Release。

## 实现范围

- 采用 npm workspaces：现有桌面应用迁入 `apps/desktop`，新增私有 `packages/contracts`，根目录保留一个锁文件和日常命令。
- 提取 execution、chat、execution-events 及 SessionStatus/TerminalChunk；桌面原路径单向 re-export。契约提供编译后的 ESM 和声明，桌面仍将运行时代码打包到 CJS。
- 构建、开发、Playwright、原生依赖准备和安装包验证使用明确的桌面路径。`release/`、文档和测试报告仍位于仓库根目录。
- 应用身份保持 `claude-workbench` / `Claude Workbench` / `0.5.0` / `io.local.claude-workbench`。存储 schema、CLI 行为和执行器保持不变。
- 增加 PR 快速检查；保留手动三平台源码回归、安装包构建和解包后验收。发布作业仍要求 main 且显式开启发布。

## 本地基线与验证

基线提交为 `15fb917fb24d6104ea96fbdf526a429e51d5e601`，应用代码等同 `main@a3f94b6c74f2abfad7a38306803319226dd5d436`。

| 项目 | 结果 |
| --- | --- |
| 运行环境 | Linux x64，Node 22.23.3，npm 10.9.9 |
| 基线干净安装与 `npm run check` | 成功；381 项单测中 380 通过、1 跳过；类型检查和构建通过 |
| 迁移后干净 `npm ci` | 成功；真实运行 native postinstall |
| 迁移后 `npm run check` | 成功；桌面 382 项中 381 通过、1 跳过；契约新增 3 项全部通过；类型检查和构建通过 |
| 测试发现清单 | 保留全部 39 个基线单测文件、14 个源码 spec（55 项）和 1 个 packaged spec |
| 锁文件比对 | 已有第三方依赖版本没有变化，新增本地 workspace 链接 |
| 独立审查 | 参数转发缺陷已修复，复核未发现其他迁移缺陷 |

基线与候选保留相同的既有平台跳过项，未删除测试或增加重试。安装环境最初的 Node 24 头文件解包失败已通过使用项目 Node 22 环境解决。构建的大 chunk 提示与基线一致。

## 安装包与数据身份验收

完整三平台验收尚待执行，结果以本阶段 PR 和 GitHub Actions 的候选提交记录为准，不能把本地构建通过视为安装包通过。

安装包测试保留 PTY、持久化、旧 version-1 数据、第二实例、正常退出和包内资源检查；增加包内 manifest、应用名称/版本断言。额外默认 userData 探针仅在一次性 GitHub Actions 用户下运行：不设置 `--user-data-dir`，验证平台默认路径与固定应用身份、实际工作区数据路径一致。探针拒绝使用已有目录，确认进程退出及目录归属后才清理新建目录；本地运行明确跳过此探针，原有隔离数据目录测试继续运行。

本阶段建立后续双引擎开发的包边界，尚未实现自研 Agent 的模型循环、工具执行或引擎选择界面。
