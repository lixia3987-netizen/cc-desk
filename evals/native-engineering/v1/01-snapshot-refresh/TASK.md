# E0-01：修复旧 worker 状态覆盖新进度

这是从 `b45bd0623d2a44a2878c46d4701fa4b388c7d9be` 派生、明确注入缺陷的隔离评估副本，不代表产品分支仍有此缺陷。

现象：同一会话、conversation、host epoch 下，界面已接受 worker generation 3 的运行状态；随后 generation 2 的迟到快照即使 revision/eventSequence 更大，也会把它覆盖为“完成”。修复 `ChatSnapshotSync`，拒绝这种旧 worker 覆盖，同时允许真正的新 host epoch 从较小计数器重新开始。

要求保留版本/事件序号防回退、跨会话拒绝、旧 host 通知忽略、错误及重试行为。不得通过拒绝所有快照或取消刷新规避问题。在 `apps/desktop/tests/e0-snapshot-regression.test.ts` 新增有意义的异步回归测试，保留全部原测试与指令，运行有关测试并说明修改及尚未实际运行的验收。

允许修改：`apps/desktop/src/renderer/chat-snapshot-sync.ts` 及指定新测试。禁止修改原测试、依赖、CI、默认引擎、验收器和任务要求。不使用远程模型或服务完成测试。缺少图形环境时不得声明 Electron 实机验收通过。
