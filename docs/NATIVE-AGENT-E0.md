# E0-01：固定真实工程任务准备

日期：2026-09-28（北京时间）。状态：**评估输入、独立检查及参考材料已准备并完成本地回放；尚未执行真实模型对照。** 这是 E0-01，不扩展 E0-02 的旧评估 CLI，也不开始 E0-03 的实际服务调用。

入口：[工程任务 v1](../evals/native-engineering/v1/README.md)、[任务清单](../evals/native-engineering/v1/manifest.json)、[每轮记录模板](../evals/native-engineering/v1/record-template.json)。原有三个小任务及 `scripts/native-eval.mjs` 用法保持不变。

## 1. 两个必须分开的固定版本

- **taskBaseline**：`b45bd0623d2a44a2878c46d4701fa4b388c7d9be`，即 N1 合入后的 cc-desk。三类任务和全部引擎/轮次均从它创建独立副本，第一类再应用明确的缺陷注入。
- **appRevision**：本次使用的 cc-desk 应用候选提交。它可以包含之后的 N2 改进；同一批 Native/Claude 使用同一应用候选。不得用应用提交替代任务代码基线。
- **suiteDigest**：v1 目录内评估材料的完整摘要，排除派生的 `validation.json`。本地自检记录了它；材料、任务或验收规则改变后需重新生成现场和同版结果，不能跨摘要比较。

Claude 保持默认。准备副本、检查通过或真实对照通过均不授权切换默认引擎、发布或触发 CI。新功能参考代码只存在于评估 patch 中，没有作为产品功能合入。

## 2. 三项固定任务

| 任务 | 起始状态 | 独立自动检查 | 另需人工确认 |
| --- | --- | --- | --- |
| [01-snapshot-refresh](../evals/native-engineering/v1/01-snapshot-refresh/TASK.md) | 在隔离副本中删除已有 worker generation 防回退检查；不是当前产品缺陷声明 | 真实 `ChatSnapshotSync` 不接受旧 worker 的较大 revision；新 host 重启可重置计数；拒绝跨会话、旧 host/重复通知 | 新回归测试确实覆盖竞态；Electron 刷新/切会话体验 |
| [02-session-info](../evals/native-engineering/v1/02-session-info/TASK.md) | 基线没有只读会话摘要 API/信息卡 | 真实 IPC 注册与输入校验、只返回六个字段、只读性、preload 通道转发、React SSR 的字段/转义/读取/错误状态 | ChatPane 打开/刷新、切会话与卸载的迟到响应、窗口实际显示；SSR 不替代这些验收 |
| [03-canonical-json](../evals/native-engineering/v1/03-canonical-json/TASK.md) | core 与 node 工具模块有重复 JSON 编码；要求保留行为的跨包提取 | 公共导出、有限 JSON 编码语料、非法输入错误、两个适配器依赖共享实现、真实 local tool 的审批 inputDigest；相关原 MCP 测试 | 新测试质量、范围与依赖方向；不能顺手改变 task/run-store 的 undefined 语义 |

每项 manifest 固定允许改动路径与必需的新测试。所有原测试、AGENTS.md、CLAUDE.md、package/lock、tsconfig 和 CI 文件按固定基线内容校验，TASK.md 按独立任务指令校验。新增测试不仅检查存在，也在独立验收时运行；测试质量仍由人审查。

## 3. 材料隔离与现场准备

操作者保管整个 `evals/native-engineering/v1`，其中的独立验收器及 `reference.patch` 不交给被评估 Agent。模型只得到自己的任务仓库及对应 TASK.md。目录分开并不构成 OS 沙箱；正式现场应由外层限制它读取评估者目录。

每项 × Native/Claude × 至少两轮，共至少 12 次新现场。以下只演示其中一次；`/absolute/...` 由操作者选为新的独立目录，不复用已完成任务。

```bash
git worktree add --detach /absolute/e0-native-round1-refresh b45bd0623d2a44a2878c46d4701fa4b388c7d9be
git -C /absolute/e0-native-round1-refresh apply /absolute/evaluator/evals/native-engineering/v1/01-snapshot-refresh/injection.patch
cp /absolute/evaluator/evals/native-engineering/v1/01-snapshot-refresh/TASK.md /absolute/e0-native-round1-refresh/TASK.md
```

第二、三项不应用 injection.patch；复制对应 TASK.md。依赖按固定 lockfile 准备，不允许模型改依赖去规避测试。检查前必须有可用的固定依赖和 workspace 链接；自检使用操作者已安装依赖，并把 `@cc-desk/*` 指向各自临时候选包，以免错误地测试操作者工作区里的编译产物。

记录准备后的差异、应用候选、实际服务/模型/协议和配置引用。凭据只记录来源引用，不写入 TASK、报告或仓库。操作者另存每轮 record-template 的副本，不能在结束后覆盖失败轮次为成功重跑。

## 4. 独立验收入口

从评估者目录执行，参数指向候选副本：

```bash
node evals/native-engineering/v1/acceptance/verify.mjs 01-snapshot-refresh /absolute/e0-native-round1-refresh
node evals/native-engineering/v1/acceptance/verify.mjs 02-session-info /absolute/e0-native-round1-session
node evals/native-engineering/v1/acceptance/verify.mjs 03-canonical-json /absolute/e0-native-round1-refactor
```

成功退出 0，失败退出 1，结果写至标准输出/错误；操作者保存原始输出到候选工作区之外。它不改旧评估 CLI、不自动生成真实质量认可、不改变默认引擎。

自动门禁按顺序包含：原文件/任务指令/允许路径校验、独立运行时检查、四个包的 TypeScript 编译，以及该任务选定的原测试和新增测试。结果列出实际命令、退出码、耗时与有界日志及截断标志。**functionalStatus 只代表这些列明的检查，不代表整个仓库所有测试、图形或平台成品通过。** 报告中 realQualityStatus、graphicalAcceptance 始终保持 pending。

验收器会执行候选 JavaScript；内容校验不是抵御恶意代码的安全边界。正式检查应放在不含模型/用户凭据的临时容器或独立账号中，由外层进程监督设置总超时。每个编译/测试子命令有 120 秒上限，但同进程独立 oracle 的无限循环仍需外层终止。只对受控的隔离评估副本运行；不复用日常用户项目目录。

## 5. 已执行的本地材料验收

可重现命令：

```bash
node evals/native-engineering/v1/self-check.mjs
```

自检只创建临时 detached worktree，验证后清理自己创建的现场，不切换开发分支、不联网、不调用真实模型、不启动 Electron、不触发 CI。它分别验证初始预期失败、应用参考 patch 后通过，以及篡改原测试会被拒绝。

| 任务 | 初始结果 | 参考结果 | 实际选定测试 |
| --- | --- | --- | --- |
| 01 | 原始固定基线的独立检查通过；注入后旧 worker 覆盖复现并失败 | 独立检查和四包编译通过 | 原状态同步 + 新回归：13 通过，0 失败 |
| 02 | 因缺少 `session:info` 注册失败 | IPC/preload/SSR 检查和四包编译通过 | 原 session-service + 新功能测试：72 通过，0 失败 |
| 03 | 因尚未提取 `canonical-json.ts` 失败；不把它描述为原运行行为故障 | 跨包语料/摘要检查和四包编译通过 | 原 core/public exports/tools-port/MCP + 两项新测试：91 通过，0 失败 |

三项各自的原测试篡改检查均被拒绝；每项校验了 169 个受保护基线文件。完整记录见 [validation.json](../evals/native-engineering/v1/validation.json)。这些是参考实现与材料的本地 fixture 证据，**没有任何真实模型成功率、无人救援完成率或效率提升结论**。

## 6. 真实运行前与结果登记

`record-template.json` 区分任务/应用版本、引擎、模型/协议、配置与凭据来源引用、预算、人工介入、真实用量、错误分类和证据位置。所有未知数保持 null，不能填 0；模型请求或日志缺失时标记用量/费用不完整。

实际调用前由用户确定服务、模型、凭据来源、单轮/整批费用和请求/时间上限、审批方式及停止条件。本轮没有指定这些参数，不自动分配真实预算。预算模板中的数值故意留空。

逐轮保存成功、失败、取消、超预算和环境异常；区分正常审批、必要澄清、救援提示和人工改代码。人工复核必须确认任务功能、原测试保留、新测试质量、修改范围、状态与记录一致、没有越权副作用或未知结果重放，再登记该模型/配置的小样本通过。每项两轮均符合才认可该项，不能由本地自动检查直接填入 realQualityStatus=passed。

记录模型/工具/检索次数、总耗时与审批等待、用量/费用和救援次数。应用/连接差异应披露；取得基线后再预先确定下一轮效率目标，不能事后挑阈值或用 12 次运行推断通用成功率。E0-02 后续若加入版本化报告 CLI，必须保持这套输入摘要、独立验收与失败保留语义。
