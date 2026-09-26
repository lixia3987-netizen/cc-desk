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

第三候选 `61584d8` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36217530271) 通过；[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36217530374) 中 Linux、macOS 的根检查和各 66 项源码 Electron E2E 均通过。Linux 的 5 项成品测试通过；macOS 成品有 4 项在应用启动时超时。Windows 的 engine-claude 回归仍有两个失败：孙进程 fixture 未观察到预期后代，以及一次未能确认树释放。第二轮 Windows 的 agent-node 清理也未通过，原日志未区分具体清理阶段，不能据此猜测根因。

第四候选修正 Windows fixture 和路径身份断言，并补充不含命令、路径、凭据或 helper 原始 stderr 的固定阶段诊断。清理助手沿用本回合已过滤的环境变量。失败测试保留原始错误并有界退出；Windows 根检查失败后仍执行一个独立 native 进程释放回归以取得诊断，不改变失败结论。该候选基于 CIM 快照和 taskkill 的清理仍有检查到终止之间的 PID 复用窗口，后续改为单个助手持有已验证的 HANDLE 执行终止，保留父进程发现锚点及助手本身的 close 屏障；首次根身份捕获的时间窗口限制仍适用。

上述诊断候选的本地根 `npm run check` 已通过：contracts 3、engine-claude 13、agent-core 49、agent-node 87、desktop 497，共 649 项通过、0 项失败、2 项 Windows 平台测试跳过，包含完整类型检查与构建。这不替代 Windows 原生运行结果。

第四候选 `d4057cad` 的 [三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36218469627) 中 Linux 全部检查再次通过。Windows 诊断区分出两条路径：Claude helper 的 `TerminateProcess` 与进程退出竞争；native helper 首次查询超时且尚无输出。前者通过同一已验证 HANDLE 的有界退出等待修复；后者继续核对最小环境和管道启动，不直接继承完整环境或放宽释放条件。macOS 有一项终端关闭回归未确认释放；后续保留信号错误并执行完整存活核查，只有明确无活进程后才继续 PTY/启动资源屏障，失败仍保留占用。

macOS 成品自动化为未签名应用增加测试专用 `--use-mock-keychain`，依据 [Electron 44 的官方测试修复](https://releases.electronjs.org/pr/53790) 避免系统 Keychain 提示阻塞。生产启动参数不变，成品报告明确真实 OS Keychain 持久保存和交互提示未覆盖；需后续候选验证该启动修复。

第五候选 `2b2e11a` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36219515255) 通过；[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36219515233) 中 macOS 完整通过根检查、66 项源码 E2E 和 5 项成品测试，包括 ZIP/DMG 内真实 ASAR native worker、工具与重启闭环。Linux 根检查和 5 项成品测试通过，源码 E2E 为 65 项通过、1 项失败：worktree 删除后的迟到读取向仍未卸载的界面报“会话不存在”。修复在读取失败后核对主进程的最新会话记录，只丢弃已删除会话的旧错误，并加入删除已完成但 UI 通知尚在途的确定性回归。Windows 根检查尚在运行，不能将单个平台结果扩展为整个候选通过。本地根检查为 655 项通过、0 项失败、6 项按平台跳过。

随后审查发现 native Windows 的快照方案无法发现“中间父进程在首次清理快照之前已退出”的独立后代。为此改为命令启动前绑定私有 Job Object：助手先持有 guardian HANDLE，再通过原 Node IPC 的随机挑战确认身份，绑定且核实成功后才授权 launch；关闭 breakaway，启用 KILL_ON_JOB_CLOSE。清理要求 Job 的 ActiveProcesses 为零及助手、guardian 的实际 close，不以一次终止调用或根进程退出替代。绑定失败不执行命令，助手异常或证明缺失保留占用；Claude/PTY 的既有身份快照路径不由此宣称获得相同覆盖。新增首次清理前父进程已退出的 detached 双 fork、助手崩溃和 owner 隔离等真实 Windows 回归，仍须后续候选在 Windows 执行。此机制不是操作系统沙箱，不能管理通过外部服务或代理另行创建的进程。启动前还同步复核 Job 状态，防止 ready 后紧随协议失败仍执行命令；缺失或被凭据过滤的 SystemRoot 直接拒绝，系统助手不通过项目 cwd/PATH 查找。最新相关本地回归为 37 项通过、0 项失败、6 项真实 Windows 测试待 CI。

本地 Electron 图形测试暂不可执行：没有 DISPLAY/Xvfb，安装操作被环境 setgroups/setuid 权限限制阻止。已添加真实 utilityProcess、队列/workflow、ASAR 成品用例，不能把测试收集成功视为执行通过。三平台工作流新增针对 dev/native-agent 的 PR 触发；发布步骤仍仅接受 main 上显式 `publish_release` 的 workflow_dispatch。

## 必需验收门槛

| 门槛 | 状态 |
| --- | --- |
| 同一候选根 `npm run check` | 第五候选 workspace/Linux/macOS 通过；Windows 验证中，新 Job 实现待复验 |
| Windows/macOS/Linux 全部源码 Electron E2E | 第五候选 macOS 通过、Linux 有失败；Windows 待前置检查 |
| 三平台安装/便携实际 payload、ASAR native worker 与本地 HTTP/工具闭环 | 第三/四候选 Linux、第五候选 macOS 通过；待同一候选三平台通过 |
| 未知副作用、审批、目录占用与 ACK 故障回归 | 已有定向证据，待固定候选复验 |
| 用户选定真实 Responses 服务、模型、凭据来源及预算 | 待用户指定 |
| 三类真实小仓库任务、后续回合和重启续聊 | 未执行，依赖上一项 |
| 仅集成 dev/native-agent，main/Release 不变 | 待验收后集成 |

真实模型验收按计划分别完成带失败测试的缺陷修复、小功能及测试、嵌套 AGENTS 局部重构，记录实际代码、退出码、用量与人工介入。未指定的模型/密钥不会被猜测使用，也不自动产生远程费用。

保留既有分发边界：Windows 自解压 portable EXE 未单独启动、Linux FUSE 未验证；本阶段不增加签名、公证或自动更新。
