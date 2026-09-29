# N2-02：多文件变更预览与逐文件回执

日期：2026-09-28（北京时间）。开发基线：`dev/native-agent@ee3ce9a6a9ebc1a0ee5c2dec3b415e40548c6f60`。本批交付 `apply_change_set`，沿用 [N2-01 检索](NATIVE-AGENT-N2.md)、[N1 任务与证据](NATIVE-AGENT-N1.md)的边界。真实运行统一登记到[正式运行验收清单](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)。

## 使用流程与范围

先用 `read_file` 读取每个目标文件和适用的 `AGENTS.md` / `CLAUDE.md`，取得完整内容哈希，再提交一组普通 UTF-8 文件的新内容：

```json
{
  "changes": [
    {"path":"src/feature.ts","expectedHash":"读取所得的完整 SHA-256","content":"完整新内容"},
    {"path":"tests/new-case.ts","expectedHash":null,"content":"新文件内容"}
  ]
}
```

这是一次变更集审批。界面展示每个文件的创建/替换、原始与目标哈希、大小和完整差异；差异行采用 JSON 转义并标注实际行尾，显示完整改动区及附近上下文，不是可直接应用的标准 patch。批准只适用于本次输入与预览。缺失、损坏或超限的预览不能被当作可批准的完整内容。

支持现有目录内创建或替换普通文本文件，不含删除、重命名、创建目录或自动撤销。`expectedHash: null` 只允许创建尚不存在的文件。原工作区可以已有用户修改；版本基准来自实际读取的内容，不从 Git HEAD 重置文件。准确哈希校验防止陈旧变更覆盖其后发生的编辑，完整差异供用户审阅模型是否保留了原内容。

敏感路径、Git 内部目录、符号链接、宿主保护目录及重复/别名目标不能进入变更集。`AGENTS.md`、`CLAUDE.md` 和已选项目 Skill 的规则文件须单独修改，重新读取生效规则后再提出业务文件变更。

## 执行与中断语义

批准后先检查全体目标的版本与目录身份，再按输入顺序处理每个文件。每项写入前重新核对项目指令、运行归属、取消/审批有效性和该文件版本，并先持久保存写入意图；写入结果持久保存后才处理下一项。

| 逐文件结果 | 含义 |
| --- | --- |
| 已应用 | 宿主取得该文件写入回执，并持久保存了对应记录；不代表任务已经验收 |
| 未应用 | 在能够确认尚未发布该项变更时停止，或此前失败使此项未开始 |
| 结果未知 | 写入或记账过程中失去确认，文件可能已改变；须人工核查 |

普通文件系统不提供本工具所需的跨文件原子事务。后续文件冲突、拒绝或取消时，前面已经应用的文件保持原结果；工具不盲目回滚，不自动重放旧审批或未确认的写入。遇到未知副作用，整个运行进入既有人工核查流程。重启保留已记录的逐文件状态和不确定性，不自动继续剩余项。

逐项记录由宿主写入 Native 原始日志，模型输出或 worker 请求不能伪造文件成功记录。审批预览、持久回执和最后的工具结果必须对应同一变更集。运行结束、变更已应用和 N1 整体验收仍是不同状态。

## 限额与兼容

每组最多 16 个文件，总新内容最多 256 KiB，读取的原内容总量最多 4 MiB，完整预览最多 128 KiB。超限时要求拆分，不截断差异后继续批准全部内容。原/新内容合计最多 50,000 行，当前工具实例最多保留 32 组准备结果、总计 16 MiB。工具最终回执也必须在写入前确认满足宿主输出预算；原始日志须先预留本组逐项与终态记录容量。

旧 `apply_patch`、`edit_file`、检索、队列确认和工作流运行结果语义保持。新版本能够读取原来的日志；使用变更集后会增加宿主逐文件事件，旧版本未必认识这些事件，因此回退应用前须保留数据备份，不能删除新记录来强行恢复旧版本读取。

## 验证记录

固定产品/测试候选：本地 `62c2eea8efb530ef71296294c9273456588d1811`，远端对应 `4dd71be7f1b3c59edfe0dfed25a37e83a9b7ad8e`，两者 tree 均为 `77920ec9f107b31bf4434f60b32da7c5f6aefee7`。随后文档提交不改变该产品/测试树中的源码。本地 Linux 验证如下，不把重复定向运行累加：

| 验证 | 实际结果 |
| --- | --- |
| `npm run typecheck` | contracts / engine / core / node 构建与桌面类型检查通过 |
| contracts 公共导出 | 3 通过 |
| agent-core 全套 | 66 通过 |
| agent-node 全套 | 529 通过、12 项平台相关跳过、0 失败 |
| 桌面定向回归 | 207 通过、0 失败；包括新增执行器 14 项和预览组件 7 项，以及原执行器、双协议、日志投影、worker 收束、N1、快照、队列和工作流 |
| `npm run build --workspace claude-workbench` | 本地生产 bundle 构建通过；保留大 chunk 提示，不属于成品打包 |
| Playwright `native-change-set.spec.ts` | 3 场景收集成功；未执行 Electron 图形场景 |

合计 **805 项通过、12 项跳过**。主要边界证据包括：批准前全文件版本/规则复核；写入意图后的再次检查；临时文件写入后重新检查宿主状态并保留最终文件版本检查；顺序写入的部分取消/冲突；rename/link 实际成功后抛错、逐项日志失败的未知结果；投影失败不改变已持久回执；恢复保留文件事实并禁止重放。准备过程串行且有总容量限制；不完整或伪造的宿主回执不能形成整组成功。文件检查继续沿用乐观文件系统边界，不提供操作系统沙箱或跨文件原子事务。

重现桌面定向回归（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-concurrency=1 tests/native-change-set-executor.test.ts tests/native-change-set-preview.test.ts tests/native-projection.test.ts tests/native-worker-host.test.ts tests/native-executor.test.ts tests/native-chat-completions.test.ts tests/native-task-*.test.ts tests/chat-snapshot-sync.test.ts tests/chat-queue.test.ts tests/chat-recovery.test.ts tests/workflows.test.ts
```

没有实际显示环境和已指定的真实服务预算，本次未执行 Electron 图形审批、真实模型修改质量、目标平台文件系统和成品运行。对应 [RA-24](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-24n2-02-多文件变更审批与实际文件结果) 保持 **pending**，其他正式 ID 也不因本地回归升级。本批不扩展 E0-02；下一步按 [后续规划](NATIVE-AGENT-NEXT-PLAN.md)推进版本化评估报告。

Claude 继续保持默认，仅集成到 `dev/native-agent`。本批不触发 CI、不调用真实模型、不构建或发布成品包。
