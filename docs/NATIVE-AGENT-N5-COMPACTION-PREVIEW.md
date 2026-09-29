# N5-04：上下文压缩范围预览

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@4aa6c80f03c5d1d1e13d3d7913246db7d52be1a2`（PR #65）。用户要求继续推进；指定服务兼容性、E0-03 真实评估与平台验收继续后置。

## 交付范围

N5-03 已能压缩首个含图完整回合之前的纯文本前缀，但界面仍只有压缩按钮，无法查看保留范围，按钮不可用时也没有原因。本批在已有运行预算展开区显示当前已保存上下文的压缩范围：

- 可交给摘要器的历史本地编码大小。
- 必须原样保留内容的本地编码大小、图片数量，以及保留原始目标/最近回合或首图回合及其后所有记录的规则。
- 无完整旧前缀、首轮含图、会话忙碌、恢复待核查、上下文协议不支持或范围暂不可用等原因。

两组字节数独立序列化，原始目标可能同时存在于摘要源和保留内容中，因此不能相加为占比分区，也不是预计可节省量。预览不生成摘要，不预测摘要长度、质量、实际 token、费用或下一次完整请求能否装入预算。

## 快照与操作边界

宿主在既有 `refreshProjection()` 流程中复用已打开账本的 `getCompactionSource()`，只向 renderer 提供白名单元数据。预览与维护视图共用同一 `headHash`；不返回历史正文、图片编码、文件路径、模型配置、凭据或原始错误信息。

展开界面只读取已有快照，不新增 IPC、账本打开/读取通道、模型调用、压缩预留或持久化事件。现有 `hydrate()` 的写者锁、恢复检查与投影刷新保持原有行为，本批不将整个既有刷新流程重新声称为磁盘只读。

运行、维护、任务复核或恢复屏障出现时，宿主覆盖旧的可用范围；界面在本地提交/压缩进行中、恢复待核查或同步失败时也不显示陈旧数字。缺少连接凭据、只读查看或归档导致的操作禁用不等于范围失效，可以继续查看已保存范围。取消、结束或恢复后的范围由后续权威快照刷新，不由 renderer 推算。

预览不改变压缩授权。实际点击仍检查会话状态和 `expectedHead`，沿用 N5-03 的保留内容、摘要输入预算与持久化确认规则。缺少模型凭据不妨碍已保存范围的展示，但不代表能发起摘要。

`NativeContextMaintenance.preview` 是可选字段。旧快照没有该字段时显示范围信息未提供，原有按钮行为保持不变；非法数字或未知状态不显示为可用范围。本批不修改账本 schema、上下文内容、模型配置、自动压缩默认开关或 Claude 默认引擎。

## 验证记录

固定产品/测试候选：本地 `0a76211da0ce5b3e54ea0bf8a16ce25ed3e5526c`，tree `20304436c88c01ca6243951365f3d2a146290745`；之后仅更新说明文档。Linux、Node.js 24.19.0 的实际结果如下，开发期间重复运行不累加。

| 验证 | 结果 |
| --- | --- |
| `npm run build:packages` | 通过 |
| contracts 全套测试 | 3 通过，0 失败、跳过 |
| 桌面预览、维护界面、维护执行、图片执行、Native 执行及快照同步共 6 个文件 | 103 通过，0 失败、跳过 |
| 桌面类型检查与生产 bundle | 通过；保留既有大 chunk 提示，未构建平台安装包 |
| 独立代码审查、`git diff --check` | 通过，无剩余阻断项 |

合计 **106 通过，0 失败、0 跳过**。新增覆盖包括两协议范围与图片计数、同一账本 head 的单次源读取、压缩后刷新/重启、首轮图片与恢复原因、无凭据查看、缓存快照不打开账本/不预留/不写入/不调用模型、修改返回值与跨会话隔离、活动/维护遮蔽，以及旧快照、无效数字和未知字段的界面回退。

独立审查发现，原 `compactDisabled` 同时包含缺密钥和运行状态，直接用它隐藏预览会使无凭据的历史范围不可见。已改为独立的 `previewBlockedReason`，仅对已知忙碌、恢复或同步失效遮蔽范围；按钮禁用仍沿用原规则。类型检查期间修正了两处新增测试的类型标注，最终候选重新通过检查，未削弱断言。

复现命令（仓库根）：

```sh
npm run build:packages
node --test --test-reporter=tap packages/contracts/tests/*.test.mjs
npm run typecheck --workspace claude-workbench
npm run build --workspace claude-workbench
```

桌面测试（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/native-compaction-preview.test.ts tests/native-maintenance-ui.test.ts tests/native-maintenance.test.ts tests/native-image-executor.test.ts tests/native-executor.test.ts tests/chat-snapshot-sync.test.ts
```

正式运行新增 [RA-32](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)：Windows Electron 下的范围展示、状态切换与无额外请求检查。状态保持 `pending`，静态渲染与本地测试不替代图形验收。

仅向 `dev/native-agent` 集成，不触发 CI、平台成品构建或 Release。
