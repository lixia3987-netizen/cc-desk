# 阶段四 P4c：MCP HTTP 工具

日期：2026-09-28（北京时间）。基线：`dev/native-agent@5f89aeaea9b7cba8a2a1e03b11d55f39393b2176`；开发分支：`feat/native-mcp-http`。完成本地验证后仅合入 `dev/native-agent`，不触发 CI。Claude 保持默认引擎；P5 仅做功能替换，默认引擎切换仍由用户后续明确决定。

首批已通过 PR #40 合入 `dev/native-agent@e4fa906`，显式 `2025-11-25` Streamable HTTP 已通过 PR #41 合入 `dev/native-agent@cb0d909`，其范围和验证见 [2025 兼容记录](NATIVE-AGENT-PHASE-4C-MCP-2025.md)。当前继续增加 [stdio 本地服务](NATIVE-AGENT-PHASE-4C-MCP-STDIO.md)，本批验收独立登记；下方验证表仅保留 PR #40 固定候选的历史结果。

## 使用方式

HTTP 连接在设置的「Native Agent Alpha · MCP 连接」中保存服务名称与完整端点，可选无认证或独立 Bearer 认证（环境变量、仅本次内存、系统安全存储）。远端必须使用 HTTPS，本地回环 HTTP 需要明确勾选；端点禁止内嵌账号、密码、查询参数和片段，不跟随重定向。模型凭据与 MCP 凭据分开管理，凭据只写不回显，安全存储不可用时不降级为明文保存。

HTTP 协议版本默认 `2026-07-28`，旧配置缺少版本字段时保持原行为；用户可显式选择 `2025-11-25`，不会自动协商切换到另一版本。改变版本须在运行和清理结束后保存新修订，下一回合生效。

在 native 会话「运行配置」中读取已保存 MCP 连接，显式勾选并保存，最多 4 项，默认不选。活动回合结束并释放资源后才能修改，下一回合生效。已选服务丢失、禁用或凭据失效会阻止该回合，不能静默忽略；可取消失效选择。读取列表、打开设置和保存配置只操作本地数据，不连接服务或启动本地程序。发送任务才读取所选服务的工具目录；「本机配置就绪」不代表已验证服务在线或兼容。

每次 MCP 调用都需用户审批，审批显示配置的服务、原始工具名与实际参数；服务的只读提示不授予免审批权限。停止、拒绝或审批失效后不执行该调用。活动回合包含目录读取、审批等待和清理，期间不能修改其连接地址或凭据；被会话引用的连接不能删除。

本地程序请显式选择 stdio，固定使用 `2025-11-25` 同步工具协议；配置、启动审批、进程归属和恢复另见 [stdio 说明](NATIVE-AGENT-PHASE-4C-MCP-STDIO.md)。本页 HTTP 的端点、认证和 session 规则不适用于 stdio。

## 协议和边界

首批实现 **MCP 2026-07-28 Streamable HTTP**，现另有显式选择的 **2025-11-25 Streamable HTTP 同步工具**路径，均不自动降级到其他版本。2026 路径实现 `server/discover`、分页 `tools/list` 与 `tools/call`，支持 JSON 和请求级 SSE 响应，发送必需的协议/client 元数据、方法和工具名头，以及 `x-mcp-header` 参数头与规定编码。非法工具定义会被排除，重复名称、循环游标、过量分页及超限目录会拒绝整次读取。

2026 路径规范依据：[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。2026 路径不使用旧协议的 `initialize`、协议 session 或 GET 长连接；2025 路径使用逐回合握手及私有 session，清理与取消边界见 [2025 兼容说明](NATIVE-AGENT-PHASE-4C-MCP-2025.md)。

- 最多 4 个连接、合计 64 个工具与 128 KiB 工具目录。每次目录读取最多 8 页，单响应最多 1 MiB，完整发现响应合计最多 2 MiB，单 schema 最多 16 KiB。准备目录总时长最多 30 秒且不能超出剩余回合预算；后续单次协议操作也有超时与取消边界。
- 工具名以连接 ID 和远端工具名生成稳定命名空间，避免覆盖本地或其他服务工具。目录只是数据，不执行服务提供的 instructions、资源链接或其他请求。
- 工具输入限制为有限深度/节点、64 KiB 的 JSON 对象，并在本地校验受支持的 JSON Schema：类型（子 schema 可用类型联合）、对象 properties/required/additionalProperties/属性数量、数组 items/长度/去重、字符串码点长度、数值上下界、enum/const，以及 allOf/anyOf/oneOf/not。校验不做类型转换、不注入默认值；参数头另校验类型和安全整数范围。不支持的关键词（例如 `$ref`、pattern、format、multipleOf、条件和依赖）使该工具从目录中排除，不能忽略约束后执行。schema、输入及验证工作量均有上限，不宣称完整 JSON Schema 兼容。服务仍负责自身业务语义校验。
- 结果只接受文本与结构化 JSON；图片、音频、资源读取、MRTR/sampling/elicitation、长任务与订阅均不支持，也不会自动发起后续请求。
- 声明输出 schema 时同样按受限子集校验实际结构化结果。2026 输出 schema 可描述任意 JSON 根类型；2025 输出 schema 与结构化结果的根必须为对象。返回结果违反已声明 schema 不能证明远端未执行，按结果未知处理。
- JSON Schema 方言限缺省的 2020-12 或显式 `https://json-schema.org/draft/2020-12/schema`（可带末尾 `#`）；其他方言不按本地规则猜测解释。
- stdio 已有独立实现，范围见上方说明；仍不支持 2025-11-25 之外的历史版本、旧 HTTP+SSE、独立 GET 长连接/重连、OAuth、prompts/resources、roots、自动工具安装或全局服务导入。完整 P4c 仍有后续工作；更多模型协议依据实际服务需求推进。

## 审批、预算和恢复

回合审计保留所选连接 ID/修订、工具定义和项目指令来源；不记录 Bearer 凭据。策略摘要绑定连接元数据、工具目录与项目指令/Skills 摘要，审批另外绑定具体输入和运行归属。批准后重新读取工具定义，执行前再次核对连接、指令与归属；已知变化使旧审批失效。远端服务不提供与客户端审批原子绑定的事务，客户端复核不能保证服务在最后检查后没有改变内部实现。

完整本地工具及 MCP 工具定义计入普通模型请求、发送前自动压缩和预算展示的保守 UTF-8 估算。目录在模型请求前读取，不能借动态工具绕过预算；摘要请求不携带工具定义、不执行 MCP 工具。实际用量仍以模型服务返回值为准。

MCP 凭据只在主进程使用，不传给模型 worker 或模型服务。目录、工具结果和审计数据检查已知凭据回显，worker 主进程桥也校验分片与完整数据。服务器文本、错误正文和未经校验的异常不会成为诊断输出。

请求发出前拒绝能证明未执行；发出后超时、取消、断流、协议异常或无法安全保留结果按结果未知处理，保留恢复屏障，不自动重试。正常 `isError` 完成结果记录为确定失败。重复提交先查询账本回执，返回既有结果，不重新解析凭据、发现工具或执行调用。

解除未知状态的目录隔离前，除工作目录与本地进程外，还须核查远端 MCP 操作结果和服务状态。停止客户端不能证明服务未执行或已停止。确认只解除隔离，旧会话保持只读，不重新执行未知调用。

旧配置缺少 `mcpConnections` 时按空选择处理。新版写入该字段后，旧版严格配置校验可能拒绝该 native 会话；应保留数据并使用支持该字段的版本。

## 首批验证记录（PR #40，历史）

本批使用本地 HTTP/SSE fixtures 验证协议、审批、预算和恢复。独立审查发现的输入 schema 未校验、审批同名参数覆盖问题已修复并补充回归；恢复提示已要求同时核查远端现场。最终本地结果如下：

| 检查 | 结果 |
| --- | --- |
| `npm run build:node` | 通过 |
| `npm run typecheck --workspace claude-workbench` | 通过 |
| `npm run build --workspace claude-workbench` | 通过；既有前端 chunk 大小提示仍在 |
| agent-node：`mcp-client.test.mjs` | 26/26 通过，含 JSON/SSE、分页、参数头、secret、取消、超限与未知结果 |
| agent-node：`mcp-schema.test.mjs`、`mcp-tools.test.mjs` | 10/10 与 16/16 通过，含校验、审批绑定、去重及复核 |
| agent-node：`responses-model.test.mjs`、`public-exports.test.mjs` | 34/34 与 4/4 通过 |
| desktop：下列 14 个定向测试文件 | 135/135 通过，含实际 `runAgent` 和两个本地 HTTP 服务的完整闭环 |
| `native-agent.spec.ts`、`native-connections.spec.ts` | 共 11 项收集成功，含 2 项新增 MCP 图形场景；未执行 Electron |

上述 90 个 Node 与 135 个 desktop 测试是各组唯一用例数量，均为 0 失败、0 跳过、0 取消。客户端超大输入测试已按新增的更早 64 KiB 参数校验更新预期错误码，并确认 HTTP 请求数仍为 0。

desktop 定向执行命令（从 `apps/desktop` 运行）：

```sh
node --import tsx --test --test-concurrency=1 \
  tests/native-mcp-executor.test.ts tests/native-mcp-connections.test.ts \
  tests/native-mcp-ipc.test.ts tests/native-mcp-ui.test.ts \
  tests/native-tool-budget.test.ts tests/native-auto-compaction.test.ts \
  tests/native-context-summary.test.ts tests/native-projection.test.ts \
  tests/native-worker-host.test.ts tests/native-executor.test.ts \
  tests/native-maintenance.test.ts tests/native-project-skills.test.ts \
  tests/native-project-skills-ui.test.ts tests/native-readiness.test.ts
```

Electron 图形执行、Windows/macOS/Linux 三平台及成品验收保持待执行；本轮不触发 CI，不调用真实远程模型或 MCP 服务，也不沿用历史 CI 结果作为本候选的验证证据。
