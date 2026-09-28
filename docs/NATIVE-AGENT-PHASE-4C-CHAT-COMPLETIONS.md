# P4c：Chat Completions 模型协议

2026-09-28：新增第二个显式可选模型协议 `chat-completions`。连接、诊断、worker、持久上下文、工具循环、恢复、手动与发送前自动压缩均接入。既有连接缺省仍为 Responses；Claude 仍为新会话默认引擎。

## 使用

在设置的 Native 模型连接中选择「Chat Completions」，填写 API 基地址、模型和独立凭据。地址末尾由适配器追加 `/chat/completions`，因此应填写服务的 API 根地址（如 `https://service.example/v1`），而非完整请求端点。服务必须支持此处的明确协议范围。

保存和就绪检查不会请求模型。用户主动测试才发送一次固定的小型文本请求；测试可能产生费用，仅证明该修订本次文本流完成，不代表工具调用与长任务兼容。配置完成后显式创建 native 会话并选用该连接，不使用 Claude 登录。

运行中的连接仍受修订锁保护。已有模型上下文绑定原连接、服务、协议和模型；修改连接协议后，原会话继续发送与压缩会在模型请求前停止，请新建会话。没有自动协议回退或自动重试。

## 协议与历史

支持 OpenAI Chat Completions SSE 文本、refusal、function `tool_calls`、增量名称/参数和报告的 token 用量，使用 `max_completion_tokens`、`stream_options.include_usage`、`n: 1`、`store: false`。工具请求带 `parallel_tool_calls: false`，完整返回的多项工具调用仍按核心既有顺序逐个处理。

保存协议 ID `openai-chat-completions` v1 和完整原生 user/assistant/tool messages。工具结果使用 `role: tool` 与 `tool_call_id`，不转换成 Responses 消息，不把展示记录当作模型历史。顶层响应 ID 不用于隐式续传。恢复仅能为尚未准备执行的调用补记 `not_executed`；未知副作用继续保持恢复屏障。压缩保留最初用户输入、最新完整回合和原始持久记录，历史摘要仍是 assistant 数据。

worker 主进程按连接选择的协议核对 beginRun、完整工具调用与结果消息，不接受 worker 自行改换协议或伪造调用结果。摘要请求隔离为无工具的一次模型请求，拒绝 refusal、工具请求与未支持的消息字段。

## 明确边界

- 仅支持 SSE 文本与函数工具调用；拒绝多 choice、旧 `function_call`、音视频/图片以及非空厂商 reasoning 等消息扩展，避免丢失未支持的继续状态。
- 工具 ID/type 须在该工具首个分片完整提供；名称和参数可分片。最多 256 个工具槽位；运行预算仍可设置更低调用上限。
- 必须同时收到有效终结 choice 和 `[DONE]`；断流不返回可执行工具调用。
- 延续既有 HTTPS/显式本地回环 HTTP、凭据隔离、敏感值检测、请求/响应字节上限、取消/超时和不跟随重定向策略。
- token 缺失保持未知。费用仅依据用户填写的具体模型价格与完整实际用量估算；历史回合按持久价格快照重建，不因连接价格后来修改而改变，不等同服务商账单。

官方协议参考：

- https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

## 本地验证

本批定向集合：agent-node **120/120**（Chat adapter 50、Chat context 13、原 Responses 34、恢复/压缩 19、公开 exports 4）；desktop **62/62**（完整 Chat 执行/压缩 5、worker host 27、摘要 12、展示/成本 18）。这些集合存在与总回归的交集，不能重复相加为整体新增用例数。

`npm run build:node` 和 desktop typecheck 通过。实际请求均为本机 HTTP/SSE fixtures，包含真实本地文件读取、重启后原生上下文重放、手动/自动压缩、协议切换拒绝、凭据检测和未知工具结果屏障。

本记录不代表远程模型、Electron 图形流程、打包成品或三平台验收通过。没有使用真实服务凭据，没有触发 CI。默认引擎保持 Claude。
