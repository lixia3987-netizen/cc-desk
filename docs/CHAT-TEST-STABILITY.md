# 聊天协议测试时序修复

日期：2026-09-25（北京时间）。基线：`dev/native-agent@2c67d6a`。修复分支：`fix/chat-fixture-handshakes`，仅集成到 `dev/native-agent`；不合入 main、不发布 Release。

## 原始失败与原因

阶段三计划 PR [#31](https://github.com/lixia3987-netizen/cc-desk/pull/31) 只修改文档，但 [Verify #9](https://github.com/lixia3987-netizen/cc-desk/actions/runs/36121900260) 两次在既有聊天测试失败：

| 运行 | 失败 | 可复现的时序问题 |
| --- | --- | --- |
| attempt 1 | background launch acknowledgement：预期 running，实际 completed | fixture 发出启动确认后 100ms 自动完成；测试轮询的历史消息完成后仍存在，观察到消息不代表任务仍在运行 |
| attempt 2 | CLI cancellation：等待 pending approval 超时 | fixture 发出审批后 80ms 自动取消；测试可能一次处理完请求和取消帧，未观察到短暂的 pending 状态 |

增加轮询超时不能消除已经消失的状态。基线临时副本在 fixture 已接收用户输入后、首次观察前延迟 250ms，两项均复现相同失败。该实验确认测试存在时序竞态，不声称还原了原 CI 的具体调度过程。

产品中的取消请求删除待审批记录，后台任务完成事件更新其状态，符合既有协议语义。本次不修改产品运行逻辑。

## 修复方式

仅修改 `apps/desktop/tests/chat.test.ts` 的模拟子进程及对应断言：

1. 在发布待观察状态前注册文件门闩；子进程等待测试明确释放，再取消审批或完成后台任务。
2. 每个测试使用独立临时目录；门闩消费后删除，watcher 在执行回调前关闭，并防止重复文件通知重复完成。
3. 取消回调绑定原 pending 请求对象。门闩名不使用桌面的公开审批 UUID，因为该 ID 与 CLI 协议 request ID 不同。
4. 测试观察状态后额外等待 250ms，再保留原状态、身份、忙碌与失效审批断言；增加取消结果和 pending 清空断言。该延迟用于回归旧问题，不再决定 fixture 何时推进。
5. 另一个使用取消场景的 attention summaries 测试同步改为显式释放。
6. `releaseAndWait` 为释放后的完成等待提供 4 秒上限，并清理计时器；超时进入已有 finally，关闭 runtime 和子进程、清理临时目录，不依赖测试框架超时自动打断 Promise。

没有跳过测试、扩大原轮询超时、改变产品权限逻辑或减少既有断言。

## 验证记录

本地环境：Linux x64，Node.js 24.19.0。Node 22 的完整验证以修复 PR 对应提交的 CI 记录为准。

| 检查 | 本地结果 |
| --- | --- |
| 基线临时副本：首次观察前延迟 250ms | 2/2 按预期失败，分别为审批观察超时、后台状态已 completed |
| 修复后的两个用例与 attention summaries | 3/3 通过；前两项内置 250ms 延迟状态断言 |
| 修复后同样增加首次观察前 250ms 延迟 | 2/2 通过 |
| 根 `npm run typecheck` | 通过，包含 contracts 和 engine-claude 构建 |
| `git diff --check` 与独立只读复核 | 通过 |

复现使用临时测试副本，实验后删除，不进入仓库和常规测试集合。完整 PR Verify 必须通过才合入开发分支；固定提交、运行链接和最终结果记录在 PR 中。此前失败记录保留，不用重试覆盖原始证据。

此次只修复测试同步，不实现阶段三功能，也不重新声明三平台安装包验收。
