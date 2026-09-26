# 阶段三实现与验收记录

日期：2026-09-26。开发基线 `dev/native-agent@bcef474f9381b37cbd5184726ae05b210355699f`，实现分支 `feat/native-agent-alpha`。main 基线 `a3f94b6c74f2abfad7a38306803319226dd5d436` 未修改。本阶段不发布 Release。

当前状态：**实现候选已形成，验收进行中**。不得将本地协议 fixture 测试扩展为真实远程模型或三平台成品已通过。最终固定候选和 CI 链接在验证完成后补入。

## 已实现

- 新增私有 `agent-core` / `agent-node` 包，根 workspaces 构建、类型检查、测试、唯一 lockfile 和桌面 worker bundle 已接入。
- Responses 完整输出与 opaque 上下文；顺序工具、审批绑定、取消、预算与未知副作用恢复。
- conversation 单写者 journal/checkpoint、稳定 request→run 去重、完整指令快照与可重建 UI 投影。
- 主进程工具监管及 utilityProcess 窄 RPC，真实本地文件/命令、嵌套 AGENTS、文件版本与路径保护。
- 原生连接设置与凭据存储、会话就绪检查、正式 native 注册和能力隐藏，Claude 默认保持。
- 跨 Claude/native/Shell 目录协调、物理释放屏障、队列持久回执及跨阶段 workflow 所有权。
- 未知运行只读、具体账本哈希绑定的人工核查确认，确认后另开新会话。

使用和恢复说明见 [自研 Agent Alpha](NATIVE-AGENT-ALPHA.md)。设计基线见 [阶段三计划](NATIVE-AGENT-PHASE-3.md)。

## 本地证据与范围

实现候选 `13df7e6d67d95db6afec7f8bf8b61a1043d8c295` 已完成本地根 `npm run check`：contracts 3 项、engine-claude 13 项、agent-core 49 项、agent-node 86 项、desktop 495 项通过及 1 项跳过，共 646 项通过、0 项失败、1 项跳过；包括全部类型检查和桌面构建。GitHub 独立 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36215567007) 同样通过。

交叉审查已捕获并修复重复提交收尾错误、失败回合混入上轮摘要、未知写入伪造完成记录、完整项目指令未入账、恢复确认哈希失效，以及凭据反射的流式展示风险。每项保持相应回归测试。

首轮 [三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36215567021) 中 Linux 根检查通过，源码 Electron E2E 为 57 项通过、9 项失败；macOS 发现测试期望路径没有解析 `/var` 到 `/private/var`，Windows 发现并发停止 Claude 会话时重复 CIM 查询与释放预算冲突。修复采用规范路径断言、单次 Windows 强制清理及原有完整退出验证，不跳过平台覆盖。界面失败涉及旧并发 fixture 共用目录、初始窗口导航等待及就绪状态，修复候选需继续复验。

三平台工作流分别执行源码 E2E 和成品测试；根检查通过后，即使源码 E2E 失败也继续收集成品诊断，原失败仍使整个 job 失败。这不会降低验收门槛或触发发布。

第二候选 `620c62c` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36216332200) 通过。三平台继续发现 macOS 最小 PATH 下无法找到进程检查工具，以及真实 Electron utilityProcess 退出后的诊断读端收尾问题：Electron 44 的 PassThrough 不自动产生 EOF，退出时还会移除监听器。修复使用系统 `/bin/ps`，并在 worker 已退出后显式关闭宿主读端、验证实际 `closed` 状态；工具、记录写入和未完成 RPC 的释放屏障保持。

本地无窗口的真实 Electron 验证已经完成：四个 utilityProcess 分别覆盖正常回答、取消挂起 HTTP 请求、真实读取→审批补丁→审批命令，以及关闭/重开记录库后使用新 worker 续聊。四个 worker 均退出 0，命令退出 0，实际文件符合预期，监管器进程计数为 0；工具任务含两次审批、五次 HTTP 请求，续聊上下文保留 18 项。相应 worker-host 回归为 17/17 通过。这些使用本地协议服务，仍不是远程模型验收。

补充 Windows 清理按创建时间核查进程身份、保留已退出父进程的发现锚点，并通过持有的进程句柄终止目标；新增首快照后产生孙进程、父进程先退出的实际 Windows 回归。Node 不公开原始 spawn HANDLE，首次活跃根进程捕获仅可核对启动时间窗口，不能声称绝对排除同窗口 PID 复用。无法确认身份时保持目录占用。测试等待与失败清理增加明确截止，强制清理只用于结束失败测试，不能记作正常退出通过。

本地 Electron 图形测试暂不可执行：没有 DISPLAY/Xvfb，安装操作被环境 setgroups/setuid 权限限制阻止。已添加真实 utilityProcess、队列/workflow、ASAR 成品用例，不能把测试收集成功视为执行通过。三平台工作流新增针对 dev/native-agent 的 PR 触发；发布步骤仍仅接受 main 上显式 `publish_release` 的 workflow_dispatch。

## 必需验收门槛

| 门槛 | 状态 |
| --- | --- |
| 同一候选根 `npm run check` | 首候选本地及 workspace CI 通过；平台修复候选待复验 |
| Windows/macOS/Linux 全部源码 Electron E2E | 待 CI |
| 三平台安装/便携实际 payload、ASAR native worker 与本地 HTTP/工具闭环 | 待 CI |
| 未知副作用、审批、目录占用与 ACK 故障回归 | 已有定向证据，待固定候选复验 |
| 用户选定真实 Responses 服务、模型、凭据来源及预算 | 待用户指定 |
| 三类真实小仓库任务、后续回合和重启续聊 | 未执行，依赖上一项 |
| 仅集成 dev/native-agent，main/Release 不变 | 待验收后集成 |

真实模型验收按计划分别完成带失败测试的缺陷修复、小功能及测试、嵌套 AGENTS 局部重构，记录实际代码、退出码、用量与人工介入。未指定的模型/密钥不会被猜测使用，也不自动产生远程费用。

保留既有分发边界：Windows 自解压 portable EXE 未单独启动、Linux FUSE 未验证；本阶段不增加签名、公证或自动更新。
