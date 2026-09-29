# N3-01：长命令生命周期

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@9850883691b2449ee7772024bdee0c96f474bc79`。本批沿用既有命令审批、进程树清理、持久日志与 [N1 任务证据](NATIVE-AGENT-N1.md)，为超过一次同步工具等待的命令增加有界句柄。正式运行另记于[验收清单](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)。

## 工具与使用范围

| 工具 | 作用 | 关键输入 |
| --- | --- | --- |
| `start_command` | 精确审批后启动命令，返回当前回合持有的不透明句柄 | `executable`、字面 `argv`、项目相对 `cwd`，可选 `timeoutMs`、`maxOutputBytes` |
| `command_status` | 查询当前句柄状态，可做短暂等待 | `commandId`，可选 `waitMs`（0–1000 ms） |
| `read_command_output` | 分页读取当前已保留的单个输出流 | `commandId`、`stream`（stdout/stderr）、`offset`、`limit` |
| `stop_command` | 停止本回合内指定句柄并确认清理结果 | `commandId` |

`start_command` 复用 `run_command` 的字面参数、工作目录、运行归属和项目指令审批边界。启动后的句柄仅属于本次运行和宿主绑定的任务；简单任务没有显式计划时也可使用。控制工具不能操作其他任务、旧回合、其他会话或任意 PID，不授予新的命令执行权限。停止已有句柄不因后来修改项目规则而失去可达性；新命令仍须按当前规则重新审批。

此批不提供 stdin、PTY、跨回合后台服务或跨重启接管。希望命令继续运行时，应在本回合查询/读取并等待实际结果；模型结束回合、用户停止、预算耗尽或退出时，宿主会停止剩余命令。旧 `run_command` 保持同步完成且最长 120 秒的接口。

## 容量与日志

- 每回合最多创建 8 个句柄，同时最多 2 个未释放的命令；结束的句柄保留到本回合结束，ID 不复用于新命令。
- 默认命令时限 120 秒，可显式请求更长时限，接口上限 1 小时，同时受当前回合剩余预算约束。当前应用回合预算默认 10 分钟、配置上限 30 分钟，本批不提高该配置上限。超时、等待审批和停止的实际语义以回执为准。
- 默认保留 stdout/stderr 合计 16 KiB，最多 64 KiB；保留前缀，超出部分继续排空并标记截断。输出字节计数不等于保留长度；无输出或暂时读到末尾不表示命令结束。
- 日志分页按 UTF-16 字符位置使用 `offset` / `nextOffset`，每页最多 4096 个代码单元，不拆开代理项对。单个代码单元不足以读取当前位置的代理项对时，明确返回 `page_limit_too_small`，要求增大页长。`currentEnd` / `hasMore` 表示当次已保留输出范围，`finished` 单独表示已持久保存并确认释放的终态。
- 有界输出经已知凭据检查后才进入模型、任务证据、界面或日志。跨块、跨页的凭据前缀以及异常 UTF-8 需要保守处理。运行中只暴露完成凭据检查的安全前缀，`currentEnd` 为当次可读范围；永久截断或终态缩短以 `truncated` 标记，不当作完整日志。

## 持久事实与收束

宿主先持久保存 `prepared` 启动意图，再次核对审批、工作目录、规则、归属和取消后才启动。确认已启动后记录 `running`；极快失败或停止可以直接从 prepared 到终态。最终回执保留退出码、信号、超时、取消、清理结果、输出总量、截断标志与有界日志。

`finished` 只表示命令生命周期与进程清理已确认结束；退出码非零、超时或取消仍属于失败或未完成的命令结果。`unknown` 表示启动、终态记账或清理缺少确认，不能显示成功或自动重做。运行开始成功、工具返回句柄和任务验收通过互不等同。

每个已准备命令持续预留终态记录空间，后续模型响应或工具记录不能占用这部分容量；空间不足时在新进程启动前停止。宿主生命周期事件不能由模型或 worker 伪造。回合最终结果在剩余命令清理和终态持久化之后才能提交，随后才允许原来的队列确认与目录释放；正常和异常退出均有收束路径。

进程机制继续复用 ProcessSupervisor 的 POSIX 进程组与 Windows Job/guardian，不增加基于裸 PID 的接管或杀进程兜底。清理失败保持占用；可以对仍由宿主持有的句柄重试清理，但不会改写此前未知的历史事实。应用崩溃后，缺少终态的命令保留启动事实并派生为结果未知，不按旧 PID 恢复、接管或重新执行。

这些机制不构成操作系统沙箱。命令仍可能访问用户权限允许的工作目录之外资源；目录占用、审批和日志不能被描述成 OS 隔离。

## 任务证据与界面

只在命令终态已由宿主持久保存后生成任务命令证据。`start_command`、状态查询和日志读取的工具成功本身不生成命令通过证据。工作区观察绑定实际执行前后版本；并行命令、其他修改或不完整扫描保持保守，退出 0 也需人工确认相关性和覆盖范围。任务元数据保存失败不导致已执行命令重放。

界面从宿主持久日志派生命令列表，显示任务/运行身份、命令、当前或历史状态、退出/取消/超时/清理信息及终态日志。列表最多显示最近 64 条命令，遗漏数量明确显示；历史或读取失败时不能用模型文字补造运行中或已成功状态。写盘失败后即使宿主仍为恢复保留目录占用，也将缺少终态的命令显示为结果未知，已持久保存的终态保持不变。面板只读；用户可用已有会话停止入口结束本回合所有命令。

旧日志仍可读取；新增宿主命令事件可能不被旧应用版本识别，回退前应保留数据备份，不删除事件强行兼容。

## 验证记录

固定产品/测试候选：本地 `765d6ac6863a620689f1a1f606697bbbeb381536`，远端对应 `797e1de685574fbe596d2a23560f23104ee0cfc8`，两者 tree 均为 `5f3ae0b50cdd3af81a837e93f602208e86a82c1e`。之后仅补充交付与正式验收文档。2026-09-29（北京时间），本地 Linux、Node.js 24.19.0 / npm 11.9.0 验证如下，不重复累加开发期间的定向运行：

| 验证 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 四个公共包编译与桌面类型检查通过 |
| contracts 全套 | 3 通过、0 失败、0 跳过 |
| engine-claude 全套 | 23 通过、0 失败；7 项 Windows 实机用例在 Linux 跳过 |
| agent-core 全套 | 74 通过、0 失败、0 跳过 |
| agent-node 全套 | 555 通过、0 失败；12 项 Windows 实机用例在 Linux 跳过 |
| 桌面 Native 与共享状态/队列/工作流定向回归 | 452 通过、0 失败、0 跳过 |
| `npm run build --workspace claude-workbench` | 本地生产 bundle 通过；原有大 chunk 提示仍在，不是平台成品打包 |
| Playwright `native-long-command.spec.ts --list` | 直接 CLI 收集 2 个场景，未执行 Electron |

最终共 **1107 项通过、19 项平台跳过、0 失败**。首次 agent-node 全套运行发现新公共入口未加入精确依赖白名单，已仅补入 `@cc-desk/contracts/native-commands` 后完整重跑通过，原隔离检查保持有效。

新增与关联回归覆盖句柄容量、异步启动/完成、稳定 UTF-8 前缀、同时排空输出、超时/取消/清理失败、Windows 启动准备模拟、命令审批及项目指令/归属变化、宿主事件身份和容量预留、重启未知事实、凭据跨块/跨页及 JSON 转义、UTF-16 分页、任务证据保守性和真实 ledger 投影。完整执行器的 8 项回归使用本地实际子进程与两种模型协议 fixture，验证审批 → 启动 → 查询/分页 → 终态 → 任务证据 → 重启不重放，以及模型提前结束、用户停止、拒绝、终态落盘后回执丢失、终态落盘前失败和任务证据写盘失败。fixture 只运行短时进程，没有将 `timeoutMs: 180000` 的请求当作实际超过 120 秒的运行证据。

独立复核发现并关闭一项状态显示问题：终态写盘失败而目录仍被占用时，缺少终态的命令曾被错误显示为运行中；修复后通过真实 ledger 和完整执行器故障回归，已保存的终态不会被改写。当前无剩余阻断发现。

重现包回归（仓库根；先执行类型检查以重建公共包）：

```sh
npm run typecheck
npm run test --workspace @cc-desk/contracts
npm run test --workspace @cc-desk/engine-claude
npm run test --workspace @cc-desk/agent-core
npm run test --workspace @cc-desk/agent-node
npm run build --workspace claude-workbench
```

重现桌面定向回归与场景收集（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-concurrency=1 tests/native-*.test.ts tests/chat-snapshot-sync.test.ts tests/chat-queue.test.ts tests/chat-recovery.test.ts tests/workflows.test.ts
node ../../node_modules/@playwright/test/cli.js test --config playwright.config.ts native-long-command.spec.ts --list
```

真实 Electron、实际超过 120 秒的工程命令、真实模型长任务质量、目标平台原生进程树与成品行为由 [RA-26](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-26n3-01-长命令生命周期) 独立确认。本环境无 DISPLAY / Xvfb，未配置正式模型现场；本地 fixture、SSR、Windows 模拟或场景收集不能抵扣正式验收。清单全部 26 个正式 ID 仍为 `pending`。

本批仅合入 `dev/native-agent`；Claude 保持默认，不触发 CI、平台成品构建或 Release。完成后按[后续规划](NATIVE-AGENT-NEXT-PLAN.md)推进 N3-02 回合内上下文维护。
