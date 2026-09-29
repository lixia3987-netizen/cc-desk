# N5-03：含图会话的纯文本前缀压缩

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@e69f22b1e1c1a6c3e7d5ecd300a0766d0651ec1c`（PR #64）。用户要求继续功能开发，指定服务兼容性确认和 E0-03 真实评估继续后置。后续 [N5-04](NATIVE-AGENT-N5-COMPACTION-PREVIEW.md)补充压缩范围预览，本页保留 N5-03 固定候选记录。

## 范围与实际限制

N5-01 为避免图片被当作文本摘要，拒绝一切含图会话压缩。本批只放开一个可验证的范围：**压缩首个含图完整回合之前的纯文本历史，首个含图回合及其后所有记录完整保留**。支持手动、发送前自动和回合内压缩；自动模式仍需显式启用，不改变默认关闭设置。

- 压缩边界同时满足最近回合/批次保留规则和图片保护规则，不从用户图片消息、模型响应或工具配对中间切开。保留连续后缀，不抽取或重排离散图片回合。
- 原始用户目标继续保留；回合内当前输入已经包含在图片后缀时不再复制。所有被保留的回合与模型/工具批次位置同步重映射，后续压缩与重启使用同一规则。
- 摘要器只收到纯文本前缀。其独立图片拒绝校验仍保留；不读取图片像素、不发送图片编码给摘要器，也不让模型生成图片描述来替换原图。
- 图片 URL、字节、用户图文关系及后续工具结果保持记录时的原值与顺序。原始提交记录不变，历史预览仍读取原提交快照，不重新读取来源文件。
- 首轮就含图时没有可压缩的纯文本前缀，仍明确停止。首图之后累积的大量文本也属于本批保护后缀，不能借本功能无限延长图片会话；可调整输入预算或新建会话。

这是保留图片的文本压缩，不是视觉摘要，也不承诺服务支持图片、提高识图质量或减少真实图像计费。图片仍按现有编码字节计入保守本地预算。

## 预算、状态与兼容

调用摘要前检查不可缩减的保留内容和最小摘要占位是否已超预算。手动压缩没有当前任务和工具目录，只检查保留的上下文本体；后续发送时再检查完整请求。发送前自动压缩还计算待发送文字、图片、项目指令及工具定义，并预检摘要请求本身能否装入输入预算；这些失败不预留摘要请求或消耗一次自动摘要机会。实际摘要长度仍不可预知，最终上下文必须通过既有缩减检查和发送预算检查。

回合内继续遵守完整批次、活动长命令延后、每回合一次实际摘要尝试、当前任务/证据连续性、取消和写盘确认边界。图片保护不绕过恢复隔离或允许重放未知工具结果。没有可压缩前缀和保留内容超预算分别给出可解释结果。

旧纯文本压缩计划的结构和重算结果保持不变，既有日志仍按完整哈希、检查点及事件重放验证读取。本批不修改 schemaVersion。回退到 N5-01/02 版本后，新含图压缩记录可能被旧保护规则拒绝；应保留完整数据并使用支持本能力的版本继续，或新建会话，不删除账本事件来强制降级。

## 验证记录

固定产品/测试候选：本地 `b6b51622cb52a5a2297d5f3e8956b4ed389ecc71`，tree `bef23cb398344f533a4646831d478e3bd76efb43`；之后仅更新说明文档。Linux、Node.js 24.19.0 环境实际验证如下，开发过程中的重复运行不累加。

| 验证 | 结果 |
| --- | --- |
| 公共包构建，变更后重建 agent-node | 通过 |
| `run-store*.test.mjs` 与 `chat-context-maintenance.test.mjs` | 179 通过，0 失败、跳过 |
| 桌面图片执行、自动/回合内压缩、摘要、维护界面与连续性共 8 个测试文件 | 112 通过，0 失败、跳过 |
| 桌面类型检查与生产 bundle | 通过；保留原有大 chunk 提示，未构建平台安装包 |
| 独立代码审查、`git diff --check` | 通过，无剩余阻断项 |

两个不重叠测试集合计 **291 通过，0 失败、0 跳过**。覆盖双协议三种压缩入口、最近回合保留边界、多次压缩后的索引重映射、原始提交只读查看、重启、无图摘要请求、保留内容与摘要源超预算时零调用/零预留、摘要失败/取消后的防重复请求、提交回执丢失和原纯文本行为。

独立审查提出旧日志需来自真实旧实现，而不能只由新代码生成后重开。已核对 `e69f22b` 的旧源码并独立编译，为两种协议各生成包含手动压缩、回合内压缩及检查点的 22 条旧记录，再由新实现打开：上下文、全部记录与 journal 字节保持一致，无恢复屏障，原提交读取一致。旧 `run-store.ts` SHA-256 为 `9e24050ef529026083735d74d299bb8071c15df335a2493826556cd5438b8781`；未将临时验收数据写入用户会话。

存储回归命令（仓库根）：

```sh
node --test --test-reporter=tap --test-concurrency=1 packages/agent-node/tests/run-store*.test.mjs packages/agent-node/tests/chat-context-maintenance.test.mjs
```

桌面回归命令（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/native-image-executor.test.ts tests/native-auto-compaction.test.ts tests/native-in-turn-compaction-executor.test.ts tests/native-context-summary.test.ts tests/native-maintenance.test.ts tests/native-maintenance-ui.test.ts tests/native-images-ui.test.ts tests/native-context-continuity.test.ts
```

类型与 bundle 命令（仓库根）：

```sh
npm run typecheck --workspace claude-workbench
npm run build --workspace claude-workbench
```

正式运行新增 [RA-31](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)：Windows Electron 中的压缩/续聊/预览交互，以及所选真实模型在保留图片后的识图与摘要连续性。状态仍为 `pending`；本地协议 fixture、存储重放和静态组件测试不替代实机与真实模型结论。

Claude 保持默认，仅向 `dev/native-agent` 集成；不触发 CI、平台成品构建或 Release。
