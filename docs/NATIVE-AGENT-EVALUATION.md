# P4d / P5 固定任务评估

此工具提供可复现的任务、独立功能检查和并排报告，帮助评估 Claude 与 Native 的功能替换。Claude 继续保持默认引擎。工具本身不调用模型、不访问远程服务、不触发 CI、不修改默认引擎。

真实 cc-desk 工程任务的固定输入、独立检查、参考材料和本地红/绿验收见 [E0-01 工程任务准备](NATIVE-AGENT-E0.md)。三项工程材料已准备，实际模型对照仍待服务/模型/凭据来源与预算；[E0-02 报告 CLI](NATIVE-AGENT-E0-REPORTS.md)已实现，[E0-03 运行前参数检查](NATIVE-AGENT-E0-READINESS.md)提供逐轮只读缺项诊断；真实运行仍未执行。本文三个小任务及现有 CLI 用法保持不变。

## 固定任务

| 任务 | 起始状态 | 验收要求 |
| --- | --- | --- |
| `01-bug-fix` | `clamp` 的区间逻辑有错，原有测试失败 | 修复边界与参数检查，保持原测试，在 `test/range-regression.test.mjs` 增加回归测试 |
| `02-small-feature` | 只有 `sum` | 增加不修改输入的 `groupBy`，正确处理顺序、对象身份和 `__proto__` 键；在 `test/group-by.test.mjs` 增加测试 |
| `03-instruction-refactor` | 两处重复数量格式化 | 保持输出，按分层 CLAUDE.md / AGENTS.md 约定提取 `src/quantity.mjs`；保留原指令和测试 |

每个目录都是独立 Git 仓库，有相同的固定起始提交和 `TASK.md`。验收逻辑保存在本项目的 `scripts/native-eval.mjs`，不交给被评估的工作目录修改。原测试与指令文件按完整内容校验；任务代码即使删改测试，也不能仅凭变绿的测试结果通过。新测试的存在与可执行性可以自动检查，测试质量仍须人工审阅。

## 使用

需要 Node.js 22.12+ 与 Git。为每个引擎准备一个新的空目录，避免复用已完成的任务现场：

```bash
node scripts/native-eval.mjs prepare /absolute/path/eval-native
node scripts/native-eval.mjs prepare /absolute/path/eval-claude
```

已有非空目录会被拒绝，不覆盖原文件。分别在对应引擎中打开每个任务目录，以 `TASK.md` 中的完整任务作为输入。保持服务、模型、预算、Skills/MCP 选择、审批策略等条件一致或清楚记录差异。每次任务开始和结束记录时间、人工介入次数及服务返回用量；不要把验证脚本耗时当作模型完成任务耗时。

完成后，在每个评估根目录的 `assessment.json` 中填写记录。顶层示例：

```json
{
  "engine": "native",
  "model": "实际模型标识",
  "protocol": "responses",
  "appRevision": "应用 Git 提交",
  "configuration": { "reference": "不含凭据的配置快照路径或摘要" },
  "tasks": {
    "bug-fix": {
      "evidence": { "kind": "manual-real", "reference": "本次会话与实际服务记录的路径或标识" },
      "usage": { "inputTokens": 1200, "outputTokens": 300, "costAmount": null, "currency": null },
      "durationMs": 45000,
      "manualInterventions": 2,
      "notes": "说明需要人工修正的步骤、失败重试和服务环境"
    }
  }
}
```

生成的模板已包含三个任务。上例数字仅示范格式，不是验收结果。`configuration.reference` 指向可复核的配置记录，不收集 API 密钥或请求头。用量、费用、耗时和人工介入无法确认时保持 `null`；未知不等于零。费用有数值时必须提供明确币种，不按猜测价格计算。

证据类型：

- `pending`：尚无任务执行证据，也是默认值。删除 `assessment.json` 也只会得到待验收状态。
- `local-fixture`：本地程序或协议 fixture 产生的结果，不代表实际模型能力。
- `manual-real`：人工登记的真实服务任务记录；必须填写可审阅的引用，工具不会自行证明引用真实性。

执行本地功能核验并比较报告：

```bash
node scripts/native-eval.mjs verify /absolute/path/eval-native
node scripts/native-eval.mjs verify /absolute/path/eval-claude
node scripts/native-eval.mjs compare /absolute/path/eval-native/report.json /absolute/path/eval-claude/report.json
```

`verify` 执行任务仓库内的 Node 测试和工具内保存的独立验收逻辑，记录已跟踪文件相对基线的差异、新增文件身份、测试状态、验证耗时及人工记录。差异输出有界，截断会标记；新增文件最多记录 64 项路径、大小及 1 MiB 内普通文件的 SHA-256，不包含完整新增源码 patch，超限另行标记。完整代码审阅仍需打开对应任务仓库。单个命令 15 秒超时，输出受限；超时或命令失败不会判定功能通过。它会执行任务代码，应仅用于自己信任的评估现场；它不是操作系统沙箱。无需安装项目依赖，也不运行仓库自定义 npm 脚本。报告以临时文件原子替换，现有报告符号链接不会使外部文件被写入。

退出码：`0` 为全部功能检查通过，`1` 为至少一个任务未通过，`2` 为参数、元数据或准备过程出错。未修改的基线应失败。重复核验会更新该目录的 `report.json`；保留旧报告时应先复制到另一文件。

## 报告如何判断

`functionalStatus` 只回答固定功能检查是否通过。报告的 `realQualityStatus` / `realQuality.status` 始终为 `pending`，包括本地检查全部通过或填写了 `manual-real` 的情况。实际模型任务质量仍由人结合对话、代码差异、验证记录和介入次数审阅；真实任务验收未完成时不能宣布 Native 已达到 Claude 的日常替换质量。

比较只接受同一套任务版本和 SHA-256 摘要，保留两边原始用量、耗时、配置引用和证据类型，不自动排名或切换默认引擎。配置不同、凭据服务不同、缺失指标和预算停止均应在判断中明确。任务或验收逻辑升级后应重新准备同版现场，不能混用新旧结果。

当前已完成本地工具自测：固定基线失败、正确实现通过、原测试/指令不可篡改、新回归测试必需、报告符号链接安全、同版比较、未知指标与零值分离及 CLI 退出码。此结果不是图形、三平台成品或真实远程服务验收。指定服务、模型、凭据来源和预算后才能登记实际服务结果。

```bash
node --test scripts/tests/native-eval.test.mjs
```
