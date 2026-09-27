# 阶段三实现与验收记录

更新日期：2026-09-27。开发基线 `dev/native-agent@bcef474f9381b37cbd5184726ae05b210355699f`，实现分支 `feat/native-agent-alpha`。main 基线 `a3f94b6c74f2abfad7a38306803319226dd5d436` 未修改。本阶段不发布 Release。

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

第五候选 `2b2e11a` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36219515255) 通过；[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36219515233) 中 macOS 完整通过根检查、66 项源码 E2E 和 5 项成品测试，包括 ZIP/DMG 内真实 ASAR native worker、工具与重启闭环。Linux 根检查和 5 项成品测试通过，源码 E2E 为 65 项通过、1 项失败：worktree 删除后的迟到读取向仍未卸载的界面报“会话不存在”。修复在读取失败后核对主进程的最新会话记录，只丢弃已删除会话的旧错误，并加入删除已完成但 UI 通知尚在途的确定性回归。Windows 的 Claude 包回归通过，但 native 清理超时且失败后的测试资源未全部收尾；该轮被后续候选取消，不能将单个平台结果扩展为整个候选通过。本地根检查为 655 项通过、0 项失败、6 项按平台跳过。

随后审查发现 native Windows 的快照方案无法发现“中间父进程在首次清理快照之前已退出”的独立后代。为此改为命令启动前绑定私有 Job Object：助手先持有 guardian HANDLE，再通过原 Node IPC 的随机挑战确认身份，绑定且核实成功后才授权 launch；关闭 breakaway，启用 KILL_ON_JOB_CLOSE。清理要求 Job 的 ActiveProcesses 为零及助手、guardian 的实际 close，不以一次终止调用或根进程退出替代。绑定失败不执行命令，助手异常或证明缺失保留占用；Claude/PTY 的既有身份快照路径不由此宣称获得相同覆盖。新增首次清理前父进程已退出的 detached 双 fork、助手崩溃和 owner 隔离等真实 Windows 回归，仍须后续候选在 Windows 执行。此机制不是操作系统沙箱，不能管理通过外部服务或代理另行创建的进程。启动前还同步复核 Job 状态，防止 ready 后紧随协议失败仍执行命令；缺失或被凭据过滤的 SystemRoot 直接拒绝，系统助手不通过项目 cwd/PATH 查找。最新相关本地回归为 37 项通过、0 项失败、6 项真实 Windows 测试待 CI。

第六候选 `257af660` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36220653021) 及本地完整根检查通过（679 项通过、0 项失败、10 项平台测试跳过）。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36220653028) 中 macOS 完整通过根检查、67 项源码 E2E 和 5 项成品测试，含实际的删除通知延迟回归；Linux 根检查及源码 E2E 通过，成品继续验证。Windows 的四项真实 Job 回归全部通过：首次清理前父进程已退出的 detached 后代、助手崩溃与 owner 隔离、绑定失败、取消。正常 native 命令仍在过滤环境中的 PowerShell 编译准备阶段超时，未授权命令执行，根检查未通过。独立诊断显示完整环境 CIM 查询约 0.33 秒完成，过滤环境启动正常但查询超时，故后续修复显式加载系统内置模块，不恢复完整宿主环境或原 PSModulePath。另根据 Node/libuv 的实际启动行为，以空值阻止 Windows 必需变量及 NODE_V8_COVERAGE 被重新从宿主注入，并保留真实子进程凭据隔离回归；这些修复仍需下一候选验证。

第七候选 `aa984797` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36221330885) 通过（681 项通过、0 项失败、12 项平台测试跳过）。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36221330986) 中 macOS 完整通过根检查、67 项源码 E2E 和 5 项成品测试。Windows 的 agent-node 为 119 项通过、0 项失败、3 项平台测试跳过：过滤环境中的 Job 编译/绑定/释放、带 stdin 的 CIM 清理，以及宿主身份/coverage 变量隔离均通过。桌面检查暴露 worker 测试的路径分隔符断言、Claude 清理的启动时间窗口拒绝，以及 runtime 测试全部输出后进程未退出的问题；不能据 native 包通过推断 Windows 桌面通过。Linux 检查未结束，取消后日志不可用，无法确定具体停点。

第八候选 `f9faaebf` 仅给平台根检查增加步骤截止，保留全部断言和三平台门槛，避免挂起检查耗尽整个任务的诊断时间；其独立 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36222008841) 同样通过。

随后修复 worker 路径断言并补齐失败时的 fixture 清理，17 项定向测试通过。ClaudeConnection 的 Windows 活根清理改为先由助手持有 HANDLE，再通过原 ChildProcess 的 `kill(0)` 核实原始 HANDLE 仍存活，确认后才采用被持有 HANDLE 的创建时间；不扩大启动时间窗口。已退出根仍是不可采纳的新 PID 的墓碑，拒绝确认时不终止该 PID。以上早期候选的时间窗口限制继续适用于 legacy PTY/独立快照路径，但不再描述该 Claude 活根认证或 native Job 认证；Claude/PTY 仍不具有 Job 的完整后代包含保证。新增错误时钟窗口与拒绝确认的真实 Windows 用例待 CI，传输拆帧回归和原桌面 Claude 集成测试已通过。runtime 增加仅含资源类型计数的 Windows 诊断，并先以有截止的独立步骤定位残留，完整检查门槛保持。

第九候选 `b7c85980` 的 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36222456496) 通过（684 项通过、0 项失败、14 项平台测试跳过）。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36222456465) 中 Linux 完整通过根检查、67 项源码 E2E 和 5 项成品测试。macOS 只有 agent-node 的释放后 PID 存活断言失败，原测试未区分 macOS 的僵尸进程，待核对和修复；不能因此宣称生产释放已确认有缺陷或已无缺陷。Windows 独立 runtime 测试在第六项通过后出现进程级异常退出 `0xC0000374`，后续完整检查未执行；该结果区别于第七轮的测试结束后挂起，正在核查原生 PTY 的生命周期。

2026-09-27 继续修复：macOS 测试改为一次完整、严格解析的 `ps` 状态快照，只把僵尸进程或有效快照中已消失的目标视为退出；快照异常、未知字段和缺失观察者使测试失败，原释放与 owner 断言保留，没有新增等待重试。Windows 源码审查确认 `node-pty 1.1.0` 存在上游 [#922](https://github.com/microsoft/node-pty/pull/922) 修复的跨线程句柄表竞态，以及 [#965](https://github.com/microsoft/node-pty/issues/965) 描述的自然退出未关闭伪控制台路径；这支持修复相应源码，但仅凭退出码仍不能断定第九轮崩溃的具体调用栈。

Windows 保持固定 `node-pty 1.1.0`，以仓库补丁修复原生所有权、关闭顺序和启动失败回收。安装时检查三份原始/修复源码 SHA-256，使用固定 `node-gyp 12.4.0` 重建并验证实际 Release 加载路径和原生修复标记；未知源码或旧预编译模块不被接受。打包后再次核对二进制与修复 JS，并用实际成品 Electron 验证 ASAR 加载。Windows 源码开发因此需要 Python、Visual Studio C++ 构建工具及对应 SDK/库，成品用户不需要编译工具。此构建链的三项本地回归通过，真实 MSVC 编译、并发/自然退出和三平台成品结果待下一候选 CI。

第十候选 `64254cba` 的本地完整根检查通过：689 项通过、0 项失败、15 项平台测试跳过，包括类型检查与构建。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36285770713) 的 Windows 安装步骤完成真实 MSVC 编译及 Release 模块校验，编译约 144 秒，验证二进制 SHA-256 为 `1c5cb799724c48ac77198fb847be8b397af7f57a8020e9518bbff15a82969f00`。随后 Runtime 在首条诊断输出前以 `0xC0000409` 退出，没有执行测试；此时不能将成功编译扩展为 PTY 生命周期已通过。下一步用独立进程分别检查普通 Node、tsx、Runtime 加载、`process.report` 与首次 PTY，将诊断 API 与真实运行断言分开。

第十一候选 `e9d389e9` 的独立 [workspace 检查](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36286167174) 通过（689 项通过、0 项失败、15 项平台测试跳过）。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36286167168) 中 Windows 五个隔离探针及独立 Runtime 检查通过（19 项通过、4 项平台跳过），没有重现进程级崩溃；四种环境的 `process.report` 探针均退出 0，不能据此归因先前崩溃。完整检查的 engine-claude 为 20 项通过、1 项平台跳过，agent-node 为 120 项通过、3 项平台跳过；新原生 PTY 并发、自然退出、启动失败回收用例也通过。桌面完整检查仍有 3 项 Runtime 释放失败（477 项通过、28 项平台跳过），继续定位具体清理阶段，Windows 源码和成品门槛尚未执行。诊断探针为独立可选步骤；正式 Runtime、完整检查、源码和成品门槛均保持必需。

同一第十一候选的 macOS 已完整通过：根检查 684 项通过、0 项失败、20 项平台跳过，源码 E2E 67 项通过，ZIP 与复制安装的 DMG 成品共 5 项通过。Linux 也完整通过：根检查 689 项通过、0 项失败、15 项平台跳过，源码 E2E 67 项通过，tar.gz 与提取后的 AppImage 成品共 5 项通过。

第十二候选 `30d28fd1` 只增加白名单清理阶段诊断、保留测试原始/关闭错误及及时处理异步拒绝。[三平台 CI](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36287092225) 中 macOS 再次通过 684 项根检查、67 项源码 E2E 和 5 项成品测试，Linux 再次通过 689 项根检查、67 项源码 E2E 和 5 项成品测试。Windows 独立 Runtime、完整根检查（672 项通过、0 项失败、32 项平台跳过）、真实 npm Claude launcher 及源码 E2E（65 项通过、2 项既有 POSIX fixture 跳过）均通过；第十一轮的 3 项 Runtime 失败没有在这轮重现，不能把未输出的诊断当作根因已证实。

Windows 第十二候选的成品构建与实际 Electron 原生模块校验通过，成品测试为 3 项通过、2 项失败。两项 native 用例均在测试提取 ASAR 成员时失败：此前文件列表断言已确认 worker 存在，但 `@electron/asar` 按宿主 `path.sep` 拆分路径，测试传入固定正斜杠路径导致 Windows 查找失败。修正测试的宿主路径构造，保留提取大小、真实 ASAR worker、审批、工具及重启的全部断言，待下一候选实际执行。源码的两个 Windows 跳过项分别为 POSIX 可执行协议 fixture 和 POSIX shebang IDE 捕获 fixture；没有新增跳过项。

为消除 PTY 身份对 JavaScript 启动时间窗口的依赖，后续补丁直接从 `CreateProcessW` 返回的原始 HANDLE 读取 UTC 创建身份，保留到终端退出后，并传给清理助手进行严格匹配；未知或不匹配的身份仍拒绝。C++ 与 PowerShell 使用固定的 UTC 微秒格式，不随系统区域设置改变；原生修复标记升为 2，安装及成品加载均拒绝旧模块。新增真实 Windows 回归要求正确原始身份在错误 JavaScript 时间窗口下仍能清理，而错误身份不能杀死目标。此前时间窗口限制不再描述采用原始身份的 PTY；仅有 PID/时间窗口的独立旧入口仍保留该限制。Claude/PTY 的后代发现仍基于快照，不能据此宣称获得 native Job 的完整后代包含保证。原始句柄链路仍待下一候选的真实 Windows 验证。

该补丁的本地完整根检查通过：690 项通过、0 项失败、16 项按平台跳过，包括所有类型检查与桌面构建；Windows 专属创建身份、错误身份保护和非公历区域设置回归由 CI 实际执行。

本地 Electron 图形测试暂不可执行：没有 DISPLAY/Xvfb，安装操作被环境 setgroups/setuid 权限限制阻止。已添加真实 utilityProcess、队列/workflow、ASAR 成品用例，不能把测试收集成功视为执行通过。三平台工作流新增针对 dev/native-agent 的 PR 触发；发布步骤仍仅接受 main 上显式 `publish_release` 的 workflow_dispatch。

## 必需验收门槛

| 门槛 | 状态 |
| --- | --- |
| 同一候选根 `npm run check` | 第十二候选三平台通过；新增原始身份补丁待同一候选复验 |
| Windows/macOS/Linux 全部源码 Electron E2E | 第十二候选 Linux/macOS 各 67 项通过；Windows 65 项通过、2 项既有平台跳过 |
| 三平台安装/便携实际 payload、ASAR native worker 与本地 HTTP/工具闭环 | 第十二候选 macOS/Linux 各 5 项通过；Windows 3 项通过、2 项 ASAR 测试路径失败待复验 |
| 未知副作用、审批、目录占用与 ACK 故障回归 | 已有定向证据，待固定候选复验 |
| 用户选定真实 Responses 服务、模型、凭据来源及预算 | 待用户指定 |
| 三类真实小仓库任务、后续回合和重启续聊 | 未执行，依赖上一项 |
| 仅集成 dev/native-agent，main/Release 不变 | 待验收后集成 |

真实模型验收按计划分别完成带失败测试的缺陷修复、小功能及测试、嵌套 AGENTS 局部重构，记录实际代码、退出码、用量与人工介入。未指定的模型/密钥不会被猜测使用，也不自动产生远程费用。

保留既有分发边界：Windows 自解压 portable EXE 未单独启动、Linux FUSE 未验证；本阶段不增加签名、公证或自动更新。
