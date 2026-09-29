# N2-03：文件行位置与任务证据

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@fe1d7147553279fe6f2fdf70ce1093feb473934f`。本批补齐 [N1 任务证据](NATIVE-AGENT-N1.md)与 [N2-01 文件检索](NATIVE-AGENT-N2.md)之间的代码位置记录，正式运行单独登记到[验收清单](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)。

## 使用流程

1. 为工程任务创建计划和稳定步骤、验收条件；用 `read_file` 或 `search` 找到文件，取得完整文件 SHA-256。
2. 调用 `read_task` 取得当前任务修订，再以 `record_code_location` 提交项目相对路径、预期文件哈希、起止行和关联步骤/条件。
3. 宿主重新读取目标文件，核对版本、行范围和任务现场后，保存代码位置记录。工具返回记录 ID 和位置元数据；任务面板展示记录时的代码片段。
4. 人工查看片段、命令回执和实际文件后，仍需分别核验验收条件。位置记录本身不能将任何条件或任务改为通过。

```json
{
  "expectedRevision": 2,
  "path": "src/feature.ts",
  "expectedHash": "read_file 或 search 返回的完整文件 SHA-256",
  "startLine": 10,
  "endLine": 18,
  "stepIds": ["implement"],
  "criterionIds": ["scope-review"]
}
```

`expectedRevision`、路径、哈希和 ID 均须使用当前任务的实际值。记录工具是一轮新的宿主读取，不冒充先前某次检索的回执。模型只能提出位置与关联，不能提交片段正文、宿主记录 ID 或验收结果；实际文件与片段摘要由宿主计算，并核对输入的预期哈希。

## 记录与展示语义

位置记录采用独立的 `source: location`，状态只能为 `unverified`。持久记录绑定会话、任务、运行、工具调用、计划/条件修订以及工作区版本，包含完整文件哈希、文件大小、起止行、原文片段与片段摘要。模型提出的步骤/条件关联只供人工核查相关性，不证明代码满足这些条件。位置记录以任务存储的持久提交为准，可能先于运行日志的工具完成回执；它不确认运行完成，不替代队列 ACK。

任务面板可从步骤或条件跳到对应位置记录，展开带行号的只读片段。片段始终表示**记录时的文件版本**；没有重新读取当前文件，也不会通过路径启动外部程序。文件、计划或验收条件变化后，沿用 N1 的证据过期规则，旧片段保留供核查。快照读取失败时显示当前状态未知，不将保存过的片段当作当前代码。

`read_task` 的证据分页索引包含位置元数据，不重复注入片段正文。普通问答、读取和搜索不会自动创建计划或大量位置记录。命令回执、人工确认、队列 ACK 和工作流运行结果保留原语义；运行正常结束仍不代表整体验收通过。

## 边界与兼容

- 每次一个普通 UTF-8 文件，完整文件最多 1 MiB；行号从 1 开始，闭区间最多 80 行，原文片段最多 8 KiB。超限拒绝并要求缩小范围，不保存截断片段。空文件没有可引用行；末尾换行不产生额外空行；CRLF 保留实际行尾。
- 使用既有 `ProjectFiles` 检查项目边界、目录/文件身份和内容版本。敏感路径、Git 内部、符号链接与宿主保护目录不能成为位置记录；已知模型凭据不能进入参数、片段或持久记录。
- 同时检查目标适用的 `AGENTS.md` / `CLAUDE.md` 和已选 Skills，遵守已有优先级与变化失效机制；记录位置不授予编辑、命令或外部工具权限。
- 当前工作区清单必须包含同路径、完整哈希和大小；其他文件未被完整扫描时仍可保存未验证位置，但不能据此确认整个工作区完整。观察到的工作区变化先更新现场版本，模型重新读取修订后才能记录。
- 最终保存前复核运行归属、取消、规则和文件版本；提交结果不确定时停止并保留待核查状态。文件系统检查是有界的乐观观察，不提供操作系统沙箱或并发修改的事务快照。
- 沿用每任务 256 条证据、512 次状态修订和会话任务文件容量限制。容量不足明确失败，不静默丢弃旧证据。
- 新版本读取不含位置字段的旧 schema 1 任务记录。新增 `location` 来源后，旧版本可能拒绝这些记录；回退应用前保留数据备份，不能删改证据以强行兼容。

## 验证记录

固定产品/测试候选：本地 `98c0bc94696de4f0fc40a134e268e353c4195ecf`，远端对应 `7689ab5b4f29200473f8d0b100b4a349f5a6da29`，两者 tree 均为 `7d98de6a5b6a51e17aa48cfb409b7377ea1c8212`。之后仅提交交付文档。2026-09-29（北京时间）本地 Linux 验证如下，不重复累加开发期间的定向运行：

| 验证 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 四个公共包编译及桌面类型检查通过 |
| contracts、agent-core 全套及 agent-node task-store | 95 通过、0 失败、0 跳过 |
| 桌面定向回归 | 205 通过、0 失败、0 跳过；包含位置 helper/tool/session 13 项、独立执行器 1 项、任务面板 14 项及原任务/状态/运行/队列/工作流回归 |
| `npm run build --workspace claude-workbench` | 本地生产 bundle 通过；原有大 chunk 提示仍在，不是平台成品打包 |
| Playwright `native-task.spec.ts --list` | 直接 CLI 成功收集 3 个场景，其中新增位置交互 1 个；未执行 Electron |

共 **300 项通过**。边界证据覆盖旧 schema 1、位置只可未验证、当前文件清单绑定、CRLF/多字节/空文件/末尾换行、哈希和行范围冲突、敏感/保护路径、凭据、深层双指令变化、不完整工作区、并发准备/执行去重、外部修改后的独立现场修订与显式重试、最终保存前取消、提交结果未知、实际 256 条证据上限、类型明确的存储容量错误，以及实际转义路径与指令输出预算。完整执行器 fixture 验证“计划 → 读取 → 错误哈希拒绝 → 位置记录 → 索引 → 结束 → 重启 → 外部编辑后过期”，模型自称通过仍不改变验收状态。独立复核发现的取消窗口、预算与容量分类问题已修复，无剩余阻塞发现。

重现包回归（仓库根）：

```sh
node --test packages/contracts/tests/*.test.mjs packages/agent-core/tests/*.test.mjs packages/agent-node/tests/task-store.test.mjs
```

重现桌面定向回归（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-concurrency=1 tests/native-code-location-*.test.ts tests/native-task-*.test.ts tests/native-projection.test.ts tests/native-worker-host.test.ts tests/native-executor.test.ts tests/native-chat-completions.test.ts tests/chat-snapshot-sync.test.ts tests/chat-queue.test.ts tests/chat-recovery.test.ts tests/workflows.test.ts
node ../../node_modules/@playwright/test/cli.js test --config playwright.config.ts native-task.spec.ts --list
```

本次先执行的 `npm run test:e2e -- native-task.spec.ts --list` 在启动包装器中因缺少 DISPLAY / `xvfb-run` 返回 1；随后直接 CLI 仅收集场景成功，没有启动或执行 Electron。此环境限制不改成图形通过。Electron 实际操作、真实模型选行及相关性、目标平台与成品行为由 [RA-25](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-25n2-03-文件行位置与任务证据) 单独确认；全部 25 个正式 ID 仍为 `pending`，本地 fixture、SSR 或场景收集不抵扣正式验收。

本批没有足以证明检索效率提升的真实工程数据，暂不引入 symbol/reference 或 LSP。完成后按[后续规划](NATIVE-AGENT-NEXT-PLAN.md)推进 N3 长任务连续性；E0-03 真实对照仍需指定服务、模型、凭据来源和预算。

Claude 保持默认，本批仅合入 `dev/native-agent`，不触发 CI、平台成品构建或 Release。
