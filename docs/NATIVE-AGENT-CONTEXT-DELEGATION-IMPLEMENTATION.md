# Native Agent 上下文与委派实施记录

日期：2026-10-15。规划与证据基线：`main@23efa6bbaab5494059d66c42eca77d936f4ed400`。

本记录对应 [任务规划](NATIVE-AGENT-CONTEXT-DELEGATION-PLAN.md)。代码交付与模型行为、成本基线、正式工程验收分别记录；没有用 fixture、口头分工或工具终局代替真实模型与人工验收。

## 已落地的能力

| 任务 | 实现 | 验证边界 |
| --- | --- | --- |
| T01 | 三协议完整请求字节、分项长度与 SHA256；普通、子任务、摘要、重试身份；请求准备、实际调用 transport 与终局阶段；账本、worker 和界面贯通 | 默认诊断保存计数、hash 与固定错误码，不保存提示正文或凭据。`dispatched` 只表示 transport 被调用，不能证明服务端收到或收费 |
| T02 | 非缓存输入、缓存读、缓存写与原始 usage；新回合累计核对、旧记录兼容、价格分项、完整性与费用来源；请求级汇总及九场景冻结矩阵入口 | 缺字段不记零。界面当前回合费用包含父请求和回合内摘要；完整父子、发送前/手动摘要范围由基线报告汇总，不能把界面父回合值当作全链路账单 |
| T03 | 共用父/子提示，直接并行请求的宿主策略、明确单 Agent 限制与真实委派完成审计 | 宿主管理委派允许，子递归禁令保留。否定、引用、转述与普通 workflow 用语不构成强制委派证据 |
| T04 | 在既有 `tasks[{title,goal}]` schema 中提供材料、版本、独立问题、范围、已有证据、权限与返回格式；核对真实子账本及成果读取 | 文本成果契约不冒充强类型成果。只读、MCP 排除和宿主预算不变；材料读取或终局不明确时不能报告满足 |
| T05 | 独立子身份、并发 barrier、执行时序、共享预算、取消、持久化失败、伪报完成及负向策略回归 | 确定性 fixture 与实际模型证据分开保存；所有批次保留审计，失败或未知批次不能被成功批次遮盖 |
| T06 | 生产父执行器与 utilityProcess 专项真实模型入口；三个不同自然措辞、独立随机事实、真实读取、父成果汇总、并行时序与只读检查 | 不注入工具调用、不设置强制 tool choice，不代模型生成答案。缺配置或运行失败不登记 passed |
| T07 | 带来源、模型/协议绑定的详细估算与误差比较；未知 fallback；普通请求及摘要独立 payload/上下文字节检查 | 尚无真实校准证据时，候选 tokenizer/校准值不能降低原有保守预算安全线；不会把 UTF-8 字节标成实测 token |
| T08 | 摘要输入中的不透明加密/签名状态以位置、hash 和字节引用投影；保留原始账本、完整工具配对与图片后缀 | 实际请求续接仍使用完整原文。离线投影减量不证明普通请求、累计 token、价格或任务质量已改善；没有更改默认自动压缩开关 |
| T09 | 本记录、真实模型报告入口、固定矩阵、全部尝试保留和可重复命令 | RA-34/RA-35 继续按原正式验收规则执行，专项 smoke 不自动代替工程质量与人工验收 |

## 用量与价格契约

OpenAI 总输入包含缓存分项，非缓存输入为总输入减缓存读取及缓存写入。Anthropic 的普通输入不含缓存，规范化总输入为三项之和。保留固定原始数值字段及归一化规则；计数缺失、分项矛盾、费率不全或模型不一致时显示中文未知原因，不输出完整费用。

当前 OpenAI 官方契约已包含 `input_tokens_details.cache_write_tokens` 与对应 Chat Completions 分项。不能只按旧协议假设所有缓存创建都为零。参考：[官方 prompt caching 文档](https://developers.openai.com/api/docs/guides/prompt-caching)。本项目使用用户填写的费率，不自动假定官网价格适用于用户连接。

`started → request → dispatched → finished` 的多条诊断属于一个请求，按真实请求身份去重。重试使用独立请求身份；失败的未知 usage 不会因后续成功变为完整已知值。新诊断回合的终态累计必须与持久化普通响应及回合内摘要相符。

## 可重复入口

```powershell
npm run check
npm run test:regression
npm run test:e2e -- native-multi-agent.spec.ts
npm run native:regression:delegation -- --out <新目录> --candidate-sha <实际候选SHA>
npm run native:context:baseline -- --input <生产report或journal> --out <新报告.json>
npm run native:context:baseline:matrix -- --manifest <矩阵manifest.json> --out <新矩阵报告.json>
```

真实模型入口从已有受控 Claude 连接配置读取凭据，只读审阅父子均不装载 MCP。`--attempts 1 --cases question` 等缩小范围的调用仅作为 smoke，不能通过完整发布门槛。需其他协议时显式传 `--protocol responses` 或 `--protocol chat-completions`；各协议验收状态分别保存。

矩阵场景、素材摘要、候选、模型、协议与配置冻结方式见 [九场景基线矩阵](NATIVE-CONTEXT-BASELINE-MATRIX.md)。缺失场景保持 pending，fixture 不能登记为真实基线。

## 离线优化测量

| 专用测试样本 | 原始摘要输入字节 | 投影摘要输入字节 |
| --- | ---: | ---: |
| Responses 大型不透明续接状态与工具结果 | 70,226 | 10,542 |
| Anthropic 大型签名/隐藏状态 | 66,533 | 896 |

这些是测试中实际 UTF-8 序列化字节，原始 ledger context 未改变，工具结果仍完整。供应商 token、实际费用和用户任务净收益尚需固定矩阵测量，不能把此表当作真实费用节省百分比。

## 本候选验证

实现候选依次为 `64362676be270dd86039b0f38e15d4f17d130a8e`、`5af6f43d01b006e2c536e569e6230df3a128d47b`。后续文档和边界 fixture 提交不改变第二候选的生产实现。开发过程出现的环境限制、错误配置启动与后续复验分别保存，不能把不同候选或配置的计数混成一次通过。

| 检查 | 实际结果 |
| --- | --- |
| 四个工作区包构建、desktop 类型检查、最终 Vite/main/preload/worker 生产构建 | 通过 |
| 最终 core 全套及本次新增回归/矩阵脚本 | core 184/184、脚本 20/20 通过 |
| 核心、三协议 adapter、诊断、用量和账本定向检查 | 572 通过、1 平台条件跳过；新增模型标签链路定向 70/70 通过 |
| 手动压缩幂等、图像后缀、重启兼容及委派审计 | 最终定向 62/62 通过 |
| 摘要与回合内压缩、取消及完整工具配对 | 最终 31/31 通过；真实 payload 预算边界另 3/3 通过 |
| 本次 Native 完整定向回归 | 305 通过、1 失败；失败为既有真实命令的 Windows Job 编译 helper 无法启动 |
| Electron 生产 utilityProcess 委派 | 4 通过、1 失败；审阅并行、共享预算、取消及无实际委派的伪报拒绝通过，实现子任务的真实命令用例受同一 Windows helper 限制 |
| 正式 cwd 的 desktop 全套单元检查 | 1507 通过、37 失败、2 取消、31 跳过，随后修复并定向复验其中旧摘要幂等与预算 fixture；全套不能登记为通过。剩余命令/stdio/PTY 检查受运行环境或未准备的本地原生二进制影响 |
| 完整 core/node 单元检查首次执行 | 964 通过、33 失败、12 跳过；两处图像旧 usage 断言已修复并定向通过，其他失败涉及未修改的 Windows 命令/stdio 约束，不把定向通过当作整个包全绿 |
| 脚本完整检查 | 新回归与矩阵检查通过；既有工程评估脚本因冻结 v1 测试集 digest 与当前基线不符而失败。没有改写冻结套件或历史验收记录掩盖问题 |

全部检查摘要及失败测试名称保存在 [checks.json](validation/native-context-delegation/checks.json)。未修改的 Windows 命令约束探针失败为 `windows_job / helper_exit / compile`，helper 退出码 `4294901760`，没有执行被约束命令。工程 v1 套件实际 digest 为 `58ec2e1356c5701df023572e98db5072490e4081f5e2a00a83cbf1f3470e71ea`，原固定 digest 为 `7ac65759b84e3946f632a931ff7bece2e50051fc25b2ee9a5e0c23bd2cbfba8a`；工程套件与相关 Windows 监督器源码在本次改动中未修改。

初始 shell 的 `realpath`/loopback/Electron 限制另有失败记录；使用可用运行器后成功执行生产构建与真实 utilityProcess。初次从根目录启动 TSX 测试未使用 desktop 配置，出现 `React is not defined`，已按正式工作区 cwd 重跑，不作为最终产品回归结论。完整检查仍有失败，PR 保持草稿，未合入 main。

### 真实模型全部尝试

1. [第一次完整报告](validation/native-context-delegation/6436267-attempt-1.json)：三个不同并行措辞及五个负向/取消场景，共八项失败。诊断错误把模型标签 `k3[1M]` 当作运行 ID 拒绝；真实父 worker 已启动，未调用上游。模型标签现使用独立有界校验，运行 ID 规则保持严格，三协议及 worker/store 回归已通过。
2. [第二次完整报告](validation/native-context-delegation/5af6f43-attempt-2.json)：八项均通过生产 worker 发出实际上游请求，上游返回 HTTP 401，分类为 `model_authentication`；终态已持久化且 worker 清理已确认。内存复核确认凭据、认证头、端点拼接、模型标签与生产配置一致，没有打印凭据、修改用户配置或猜测替代模型。具体认证拒绝原因仍未知。

第二次报告只证明生产路径和失败边界可观察，不能证明真实模型选择了 `delegate_review`、完成材料分析或满足并行要求。报告保留所有失败、实际请求身份和三个不同措辞，不保留凭据或上游错误正文。没有在相同认证条件下不断重发。

九场景真实费用矩阵、主用模型的自然委派通过门槛、真实校准误差与质量收益继续 pending。正式 RA-34/RA-35 未改为通过。
