# Native 稳固：历史回执状态与提交时长预算

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@a864208275f1d3effcab2edd23dfccc5952e2cb1`。N1/N2/N3 已交付后的定向复核确认两项缺陷，本批修复其可复现路径，不扩大 N4/N5 范围。

## 已确认问题与修复

| 问题 | 旧行为 | 修复后 |
| --- | --- | --- |
| 历史请求覆盖当前状态 | A 成功、B 失败后重发 A，会返回 A 的正确回执，却把当前 B 改成完成并清空错误；刷新因账本未变无法修复。历史失败及输入/配置/任务绑定不匹配也会覆盖后续状态 | 历史回执查询与新运行状态发布分离；查询或拒绝旧请求不覆盖当前状态。账本恢复要求和资源清理失败仍发布阻塞，旧成功回执不能解除隔离 |
| 准备阶段漏计时长 | 未选择 MCP 且未触发发送前压缩时，普通 worker 仍获得完整时长预算；长命令与回合内摘要却已经扣掉准备耗时 | 所有压缩模式都在 worker 派发前扣掉准备耗时，耗尽后不派发；worker 继续扣除 fork/ready 耗时，core 从入口计入 digest 与持久化接纳耗时 |

历史提交保持原有幂等语义：不重新请求模型、不重放工具、不新增执行账本记录。即使较新回合已经崩溃，旧成功回执仍可返回给原请求方以避免队列重放，同时当前会话继续显示恢复阻塞。真实新请求的配置错误仍正常显示。

主动时长从本次提交开始逐层扣减，审批等待继续排除；模型、重试、长命令和摘要共用剩余预算。worker 启动耗尽时不发送 `start`，宿主仍等待子进程和输出流关闭确认后释放资源。core 接纳后耗尽则持久保存预算终态，模型请求数为零。准备阶段预算耗尽不再误报“自动压缩占用预算”。

本修复不承诺在预算到点瞬间中断所有本地准备或清理操作；在后续派发边界检查剩余额度，资源收束及耐久终态写入仍需完成。协议、持久 schema、默认引擎及默认压缩/重试设置均无变更。

## 本地验证

固定产品/测试候选：本地 `a1412b204194e01827f923c428f48a80cb2c8504`，远端对应 `99d8c8ec2fcd8b73632781eb74189b93ea0dc861`；两者 tree 均为 `63ed7fa110d1e541d03ff4303460b3d2a23ac0c2`。其后仅更新说明与正式验收记录。

| 验证 | 实际结果 |
| --- | --- |
| agent-core 全套 | 147 通过，0 失败 |
| worker-host 定向全套 | 67 通过，0 失败 |
| Native 执行器、投影、压缩及共享刷新/队列/恢复/工作流 | 247 通过，0 失败 |
| `npm run typecheck` | 公共包编译及桌面类型检查通过 |
| 最终编译产物下重跑新增执行器回归 | 16 通过，属于上述 247 项，不重复累计 |

共 **461 个不同测试计数通过，0 失败、0 跳过**。Linux、Node.js 24.19.0 / npm 11.9.0；使用本地 HTTP fixture、模拟 worker 和可控时钟，未调用真实模型。

新增历史状态回归 9 项：成功/失败交错、输入/配置/任务 ID 不匹配，以及较新回合崩溃；核对 hydrate、重启、请求数、工具回执及账本不变。前 8 项在旧实现均失败。新增提交预算回归 7 项：三种压缩配置分别覆盖准备耗尽与剩余额度，另验证长命令审批等待排除；旧实现均失败。core 的 digest、接纳及累计耗时、worker 的启动剩余与耗尽清理也先复现再验证修复。独立复核未发现阻塞问题。

重现（仓库根先执行类型检查，以更新公共包产物）：

```sh
npm run typecheck
npm run test --workspace @cc-desk/agent-core
```

桌面回归（`apps/desktop`）：

```sh
node --import tsx --test --test-concurrency=1 tests/native-worker-host.test.ts tests/native-*-executor.test.ts tests/native-executor.test.ts tests/native-auto-compaction.test.ts tests/native-projection.test.ts tests/chat-snapshot-sync.test.ts tests/chat-queue.test.ts tests/chat-recovery.test.ts tests/workflows.test.ts
```

## 正式运行与后续

实际时长/审批等待在 [RA-05](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-05实际用量费用与预算)，历史提交与恢复状态在 [RA-09](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-09恢复未知结果与提交去重)，图形刷新在 [RA-14](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md#ra-14n1-界面状态同步与版本证据) 保持 `pending`，不新增重复 ID。28 个正式 ID 均未因此改为通过。

本批只集成至 `dev/native-agent`。Claude 继续默认；不触发 CI、应用 bundle、三平台成品构建或 Release。后续优先确定 E0-03 的实际服务、模型、协议、凭据来源及每轮/整批预算，再执行已规划的正式验收；N4/N5 仍按实际服务阻塞或任务证据启动。
