# 阶段四 P4c：MCP 2025 Streamable HTTP 兼容

日期：2026-09-28（北京时间）。基线：`dev/native-agent@e4fa90601d2ed6bea47f3c64b620de5c79415dfe`（PR #40）；开发分支：`feat/native-mcp-2025`。本批在已有 MCP HTTP 工具闭环上增加显式选择的 `2025-11-25` 兼容路径，完成本地验证后仅合入 `dev/native-agent`，不触发 CI。Claude 仍是默认引擎，P5 仅做功能替换，默认值切换须用户后续明确决定。

## 配置与使用

在设置的「Native Agent Alpha · MCP 连接」中选择协议版本，再保存连接。新建连接和没有 `protocolVersion` 字段的旧连接均保持 `2026-07-28`；需要兼容 2025 服务时，用户明确选择 `2025-11-25 · Streamable HTTP 同步工具`。连接列表与会话 MCP 选择列表显示协议版本，减少同名服务混淆。不会探测后自动降级，也不会把 2026 失败请求重发为 2025。

旧连接文件只在内存读取时补齐默认值，不因打开设置而改写。后续保存会持久化版本；非法或未知版本会被拒绝。改变版本与改变端点一样，需要当前修订版并在活动回合清理完成后操作。相同认证方式下保留已有凭据，编辑版本会立即清空尚未提交的凭据输入框，凭据值不回显。旧版程序不认识新增字段时可能拒绝读取，应保留原数据并使用支持该字段的版本。

仍由 native 会话在「运行配置」中显式选择服务，默认空选择、最多 4 项。列表、设置、保存、刷新和就绪检查只操作本机配置，不访问 MCP 服务。只有发送任务才初始化所选服务并获取工具目录；每次工具调用仍单独审批。

## 两条协议路径

| 事项 | `2026-07-28` | `2025-11-25` |
| --- | --- | --- |
| 选择与默认值 | 新建与旧配置缺省版本 | 用户显式选择 |
| 回合准备 | `server/discover`、分页 `tools/list` | `initialize`、版本/能力校验、`notifications/initialized`、分页 `tools/list` |
| 工具执行 | `tools/call`，沿用 2026 元数据与参数头规则 | 同步 `tools/call`，不附带 2026 专有方法或参数头 |
| 请求响应 | JSON 或请求级 SSE | JSON 或请求级 SSE；不建立独立 GET 长连接 |
| 协议 session | 不使用 2025 协议 session | 若服务分配 session ID，仅保留于该回合的主进程客户端 |
| 结构化结果与输出 schema 根类型 | 支持受限 schema 子集描述的任意 JSON 根类型 | 结构化结果及输出 schema 根类型为对象 |
| 失败处理 | 保留原协议失败，不自动重试 | 版本不符、session 失效等直接失败，不重初始化或重放调用 |

2025 的握手只声明本批实际支持的客户端能力，不声明 roots、sampling、elicitation 或 tasks。服务器提供的说明、通知与资源地址不会被提升为项目指令，也不会触发隐式工具调用或后续取数。

两个版本都沿用有界 JSON Schema 校验，不宣称完整 JSON Schema 兼容。输入根仍为对象；输入和输出 schema 均检查受支持的类型、对象/数组约束、字符串长度、数值范围、enum/const 与组合条件。未知关键词、引用和不支持的方言不能被忽略后执行，相应工具会被排除。工具声明输出 schema 时，还会校验实际结构化结果，参与该校验的 `structuredContent` 值独立限制为 64 KiB；调用已发出但结果违反 schema，按结果未知处理，不能据此断言工具没有副作用。共同预算与校验子集详见 [MCP HTTP 记录](NATIVE-AGENT-PHASE-4C-MCP.md)。

规范依据：[2025 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[2025 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[2025 工具](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。上述范围是本应用实现的子集，不代表实现这些规范列出的所有能力。

## 回合生命周期、审批与私密数据

每个所选服务在每个回合创建独立客户端。2025 初始化和工具目录读取在模型请求前完成；同一回合中的目录复核与工具调用复用这一初始化状态。后续回合重新初始化，不跨会话、跨回合或跨重启复用远端 session。工具目录加载失败时，同批已经建立的客户端也进入清理。

协议版本、连接 ID/修订及目录共同参与策略和审批绑定。批准后复核定义、连接、项目指令与运行归属；版本修改不能沿用旧审批。MCP Bearer 凭据与远端 session ID 仅在主进程使用，不进入模型 worker；模型凭据只按原模型调用链传给 model worker。上述秘密均不进入渲染器、持久审计或工具结果。服务回显敏感值时拒绝对应数据，不以原始正文或异常文本展示诊断。

正常完成、发现失败、停止、预算耗尽及 worker 异常均关闭本回合 MCP 客户端，等待本地活动请求结束后才释放该回合资源。2025 已发出且未完成的非 `initialize` 请求在取消/超时后尝试有界 `notifications/cancelled`；初始化不发送取消通知。有远端 session 时，关闭过程尝试有界 HTTP `DELETE`。这些是尽力通知，不把成功响应、取消失败、DELETE 不受支持或无法连接解释为远端工具已停止。

调用发出后超时、取消、断流、失效 session 或无法安全保存结果，仍保留结果未知与恢复屏障；不自动重试，不自动重新握手再调用。重复提交依旧优先读取账本回执，不能因重复请求重新初始化或执行工具。解除隔离前必须核查远端操作结果和服务状态；确认只解除隔离，旧会话保持只读。

## 本批未覆盖

- stdio 与旧 `2024-11-05 HTTP+SSE` 传输，其他历史协议版本和自动版本回退。
- 独立 GET SSE 长连接、断线重连、事件重放和跨回合 session 续用。
- OAuth、异步 tasks、roots、sampling、elicitation、prompts/resources、订阅和自动安装工具。
- 图片、音频与自动资源读取；完整 JSON Schema、完整 MCP 协议及真实服务兼容性承诺。

P4c 整体仍未完成，更多模型协议、MCP 传输与完整 Skills 管理仍按后续批次推进。真实模型/MCP 服务、凭据与预算未指定，本批只用本地 HTTP/SSE fixtures；未调用真实远程模型或 MCP 服务。

## 本批验证记录

本批使用本地 HTTP/SSE fixtures 验证协议和完整回合生命周期。独立审查发现 2026 数组输出 schema 在 ToolPort 再次过滤时被错误排除，已改为按协议区分输入/输出 schema 校验并补充回归，复审通过。首批 MCP 的 225 项历史定向结果保留在原记录中，不能替代下方本候选验证。

| 检查 | 本批结果 |
| --- | --- |
| `npm run build:node` | 通过 |
| `npm run typecheck --workspace claude-workbench` | 通过 |
| `npm run build --workspace claude-workbench` | 通过；仅既有前端 chunk 体积提示 |
| agent-node：`mcp-client.test.mjs`、`mcp-legacy-client.test.mjs` | 28/28 与 33/33 通过 |
| agent-node：`mcp-schema.test.mjs`、`mcp-lifecycle.test.mjs` | 12/12 与 7/7 通过 |
| agent-node：`mcp-tools.test.mjs`、`public-exports.test.mjs` | 16/16 与 4/4 通过 |
| desktop：`native-mcp-legacy-executor.test.ts` | 10/10 通过 |
| desktop：下列另外 7 个定向测试文件 | 88/88 通过 |
| `native-connections.spec.ts`、`native-agent.spec.ts` | 5 + 6，共 11 项收集成功；未执行 Electron 图形场景 |
| Electron 图形执行、三平台及成品验收 | 未执行 |
| 真实远程模型与 MCP 服务验收 | 未执行 |
| GitHub Actions CI | 未触发；仅用户明确要求时运行 |

上述 100 个 agent-node 与 98 个 desktop 测试为各组唯一用例数量，均为 0 失败、0 跳过、0 取消。desktop 其余 7 个定向文件为 `native-mcp-connections.test.ts`、`native-mcp-ipc.test.ts`、`native-mcp-ui.test.ts`、`native-mcp-executor.test.ts`、`native-executor.test.ts`、`native-worker-host.test.ts` 与 `native-auto-compaction.test.ts`。测试覆盖显式协议选择、旧配置兼容、session 私密性、审批/版本绑定、停止与超时、发现失败清理、worker 异常、重复提交不重放，以及已有 2026 路径和自动压缩回归。

本批未执行完整 workspace 根检查、Electron 图形流程或 Windows/macOS/Linux 成品验收，未调用真实远程服务；不沿用历史 CI 绿灯作为本候选证据。
