# Native 上下文成本基线矩阵

日期：2026-10-15。对应 `NATIVE-AGENT-CONTEXT-DELEGATION-PLAN.md` 的 T01/T02 基线交付。

本入口只读取已生成的生产诊断报告，固定九个场景并核对比较条件。它不启动模型、不执行工具、不修改连接、不生成模型答案。缺少真实运行证据时输出 `pending`；本文件不声明九个场景已经运行，也不声明真实模型委派或正式验收通过。

## 固定场景

同一轮收集使用同一个候选版本、协议和模型。先冻结素材包与完整配置，再逐场景运行。素材包包含各场景的用户输入、文件、图像和负载定义摘要；各报告记录这个共同的素材包摘要，不能把某次请求的 `contextDigest` 当成素材包摘要。

| case ID | 场景与收集方式 | 冻结内容与检查重点 |
|---|---|---|
| `short_zh` | 新会话提交一次自然中文短问答 | 固定中文用户输入；不添加工具强制选择或预写答案；计量固定指令和工具目录开销 |
| `short_en` | 新会话提交一次自然英文短问答 | 固定英文用户输入；独立于中文场景收集，不能复用中文请求登记两行 |
| `continuous_read` | 在一个任务中连续读取预先准备的多个文件 | 固定路径、文件字节与读取目标；保留每次实际模型请求和工具结果贡献 |
| `long_command_output` | 用户明确授权只读命令任务，产生预先定义的长输出 | 固定命令、输入文件、输出长度和分页/截断策略；分别记录工具结果和后续请求大小；汇总脚本不代替用户执行命令 |
| `mcp_skills` | 使用已配置的只读 MCP 与指定 Skills 完成固定任务 | 固定服务工具目录、版本、技能摘要和所选技能；无已配置服务时保留 pending，不能用本地假工具冒充真实 MCP |
| `long_task` | 固定多轮任务，跨多次实际工具结果边界继续 | 固定原始目标、素材与预算；记录每个请求、重试、失败及取消，不能只保留最后一次成功 |
| `image` | 提交同一张或同一组图像完成固定任务 | 固定图像文件摘要、顺序、格式、尺寸及用户输入；编码字节不等于实际图像 token；不保存图像 payload 到矩阵 |
| `delegation` | 用户自然要求对两至四个独立范围并行分析 | 记录真实 `delegate_review`、父子请求及成果读取；与真实委派专用回归分开验收；只有分工文本时保留 pending |
| `compaction` | 在已冻结的历史与策略上运行压缩及后续任务 | 冻结手动/发送前/回合内策略、保留边界和历史；摘要请求单独识别，父回合已有累计用量不再叠加；不能把未完成摘要当成压缩成功 |

压缩策略、权限、MCP/Skills、预算或图像不同，意味着配置或素材不同。不要在这些条件变化后沿用旧摘要以获得“可比较”的结果。不同协议/模型分别生成矩阵。

## 指标口径

矩阵保留每个唯一 `(runId, requestKey)` 的最后一个诊断阶段。同一请求的 `started/request/finished` 是状态更新；不同重试和子请求分别记录。矩阵只从请求诊断累计，不能再加上父回合 `run_finished.usage`、子代理总量或压缩回执总量。

| 指标 | 定义与未知处理 |
|---|---|
| 单次输入 | `diagnostics[].usage.inputTokens`，来自服务报告的归一化计数；未报告为 null |
| 输入峰值 | 已知单次输入的最大值；`peakInputTokensComplete=false` 表示仍有请求输入未知 |
| 累计输入/输出 | 保留 `knownSubtotal`、`unknownRequests`、`total`；任何请求缺计数时 `total=null`，不能以已知小计替代完整累计 |
| 非缓存输入、缓存读取、缓存创建 | 三项分别累计；缺失不是零，输入总量已包含缓存分项，不能再次相加 |
| 请求与分类字节 | 请求序列化大小与各分类的字节/hash；`logical` 分类可能重叠，不相加为传输大小，也不当成模型 token |
| 请求状态 | 保留失败、取消、重试、是否确认发送和耗时；未结束或是否发送未知时场景为 pending |
| 费用 | 当前安全基线投影未提供完整费率/账单证据，因此矩阵 `costUSD=null`、`costSource=unknown`；桌面费用估价须另附当次价格快照与来源，不能把未知价改成零 |

`measured` 只表示该场景有来源与元数据一致、结束状态及完整用量/字节计量的诊断。它不表示任务语义正确、委派并发验收通过或实际账单已核对。

诊断中的 `requestSent=true` 表示已进入真实传输调用，不保证远端收到请求或已经计费；是否计费仍由服务 usage/账单核对。只有未发送尝试且没有一次确认传输的场景保持 pending。

## 收集与报告封装

1. 在实际运行前记录候选 SHA，确保它对应运行的代码。工作树有未冻结修改时不能用旧提交 SHA 冒称新候选。记录真实连接的协议、模型、配置和素材摘要；缺失就保留 null。
2. 将每个场景的生产账本及其子账本保存在独立收集目录；对正常请求、失败/重试、取消和摘要都保留诊断。不要扫描混有其他场景或旧回合的整个用户数据目录来替代一次独立收集。
3. 使用已有安全投影脚本生成场景报告。例如，在仓库根目录执行：

```powershell
node scripts/native-context-baseline.mjs --input .audit/short_zh/native --out .audit/short_zh-safe.json --label short_zh --candidate-sha <实际候选SHA> --configuration-digest <实际配置SHA256>
```

以上命令只做离线投影。`--input` 可为生产 `journal.jsonl`、包含账本的目录或已有报告；必须包含真实请求诊断。占位符必须替换为实际采集值。

4. 将安全场景报告与原始收集方已经记录的来源/素材元数据合并到**新文件**，不要覆盖原始账本或删除 fixture 标记。安全报告的 `source=production_diagnostics` 本身不证明调用过远端模型。只有可核对的真实传输记录才可附 `evidenceSource=real_model` 和实际 `materialDigest`；缺证据时省略或置 null，矩阵会保持 pending。不得只修改布尔值/来源标签，把 mock 转成真实模型证据。

统一场景报告兼容以下安全字段；`requests` 使用 `native-context-baseline.mjs` 的输出，不填原始请求/响应正文：

```json
{
  "version": 1,
  "kind": "native_context_baseline",
  "source": "production_diagnostics",
  "evidenceSource": null,
  "status": "not_run",
  "label": "short_zh",
  "candidateSha": null,
  "configurationDigest": null,
  "materialDigest": null,
  "groups": [],
  "requests": []
}
```

配置摘要使用排序后的 UTF-8 JSON SHA-256；可使用脚本中的键排序口径。冻结字段至少包括协议/模型、有效预算、权限/工具策略、压缩/重试策略、模型能力来源、指令/工具目录/所选 Skills 摘要、MCP 工具版本、价格快照与连接版本。不要哈希或导出 API Key、认证头及包含秘密的原始连接对象。素材摘要使用排序后的“相对素材标识 → 文件或固定输入 SHA-256”映射；纳入九个场景的固定用户输入、负载定义、图像摘要与文件摘要。更换随机素材、nonce 或内容后必须重新冻结素材摘要。

工具还可直接读取真实运行报告的 `records`、`diagnostics` 或 `attempts[].diagnostic`。此类报告必须包含 `source=real_model`、上述实际元数据及 `baselineCaseId`。多 case 报告使用 manifest 的 `reportCaseId` 明确选择。现有委派回归的 `mode=parallel` 可映射到 `delegation`；它缺少共同配置或素材摘要时仍为 pending，不能凭委派回归成功推定完整成本矩阵已齐。

## 完整 manifest 模板

保存为 `.audit/context-matrix-manifest.json`。报告路径相对 manifest 所在目录；同一场景可引用多个**实际独立尝试**的报告，重复引用被拒绝。缺失报告保留 pending，不用空 usage 或零值填补。

```json
{
  "version": 1,
  "binding": {
    "candidateSha": null,
    "protocol": null,
    "model": null,
    "configurationDigest": null,
    "materialDigest": null
  },
  "reports": [
    { "caseId": "short_zh", "path": "short_zh-safe.json" },
    { "caseId": "short_en", "path": "short_en-safe.json" },
    { "caseId": "continuous_read", "path": "continuous_read-safe.json" },
    { "caseId": "long_command_output", "path": "long_command_output-safe.json" },
    { "caseId": "mcp_skills", "path": "mcp_skills-safe.json" },
    { "caseId": "long_task", "path": "long_task-safe.json" },
    { "caseId": "image", "path": "image-safe.json" },
    { "caseId": "delegation", "path": "delegation-safe.json" },
    { "caseId": "compaction", "path": "compaction-safe.json" }
  ]
}
```

候选 SHA 为实际 40 位小写十六进制；配置与素材摘要为实际 64 位 SHA-256。协议支持 `responses`、`chat-completions`、`anthropic` 及其生产协议 ID，统一为 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。实际模型从报告及请求诊断核对，不能仅取 manifest 的期望模型。

多 case 现有报告的明确选择示例：

```json
{ "caseId": "delegation", "path": "delegation-run/report.json", "reportCaseId": "parallel-1" }
```

## 生成与比较

```powershell
node scripts/native-context-baseline-matrix.mjs --manifest .audit/context-matrix-manifest.json --out .audit/context-matrix-run1.json
node scripts/native-context-baseline-matrix.mjs --manifest .audit/context-matrix-manifest-run2.json --out .audit/context-matrix-run2.json --compare .audit/context-matrix-run1.json
node --test scripts/tests/native-context-baseline-matrix.test.mjs
```

输出必须是新文件；`--out` 已存在时拒绝覆盖。退出码：0 表示完整矩阵且要求的比较可用；2 表示报告已生成但有 pending；1 表示输入错误、来源冲突、fixture/mock、条件不匹配或比较被阻止。stdout 只显示报告路径、状态和覆盖数量，错误不回显原始正文或配置。

只有两份矩阵的**实际候选 SHA、协议、模型、配置摘要、素材摘要全部相同**，且九个场景都是完整真实测量，才输出 `comparison.status=comparable`。候选或条件不同输出 `blocked`；条件一致但场景/用量未齐输出 `pending`，没有可冒称节省的零差值。当前比较用于同条件重复测量；跨候选优化因果比较需要单独设计受控试验，不绕过这一冻结检查。

每个场景可保留多个请求、父子代理和摘要，诊断阶段由现有安全投影去重。将同一个实际请求引用为两个不同场景会使矩阵失效。报告保存来源文件 SHA-256，而不导出来源绝对路径、素材正文、模型正文、图像 payload、URL、认证头或凭据。

## 中文验收记录模板

```text
记录时间：
候选 SHA / 实际运行代码核对证据：
协议 / 实际模型：
配置摘要 / 冻结字段与证据位置：
素材摘要 / 固定输入、文件与图像摘要证据位置：
真实传输来源 / 生产账本证据位置：
矩阵报告 SHA-256 / 九场景覆盖数量：

short_zh：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
short_en：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
continuous_read：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
long_command_output：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
mcp_skills：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
long_task：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
image：measured / pending / invalid；请求数；峰值；累计输入/输出；缓存分项；未知原因：
delegation：measured / pending / invalid；父子/摘要请求数；峰值；累计用量；真实并发与成果核对另附证据：
compaction：measured / pending / invalid；压缩策略；摘要请求；后续请求；原始历史与保留边界证据：

失败 / 取消 / 重试 / 未确认发送的请求与未知用量：
费用：unknown，或另附完整估价/账单来源（不能把 unknown 写成 0）：
比较结论：comparable / pending / blocked；五项条件核对与数值差异：
正确性、权限、取消/恢复与成果可核对性验证：
未执行场景 / 缺配置、usage、模型能力或真实证据原因：
后续行动与人工验收状态：
```

该模板中的真实运行、正确性和人工验收状态分别填写。离线单元测试通过不自动填写真实测量；真实委派 smoke 通过也不自动推进 RA-34/RA-35。
