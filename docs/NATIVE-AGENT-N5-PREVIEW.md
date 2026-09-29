# N5-02：Native 图片预览

日期：2026-09-29（北京时间）。开发基线：N5-01 本地候选 `a4727a5`；功能分支 `feat/native-n5-image-preview`。

用户要求继续开发，服务兼容性确认仍后移。本批补充发送前图片预览与历史图片查看，复用 N5-01 的 PNG/JPEG、4 张及合计 1 MiB 限制；不进行真实模型调用或改变默认引擎。

## 用户行为

- Native 附件和历史图片记录提供“预览”入口。用户点击后才读取一张图片，打开可关闭的查看窗口；支持加载、失败提示和重试，沿用已有键盘焦点与 Escape 关闭行为。
- 草稿预览显示当前暂存版本，要求该文件仍属于本会话草稿且未被队列接管。预览不发送消息，不修改附件，也不产生模型调用；发送仍走原有内容快照和队列校验。
- 历史预览显示当次发送保存在原始模型记录中的版本，核对会话、运行、图片序号与内容哈希。原始来源或暂存文件随后改变、移除，不改变已发送版本；原始模型记录缺失或损坏时明确失败，不读取其它文件代替。
- 普通快照、历史分页、搜索及会话导出继续只包含图片元数据。预览数据只在用户打开查看窗口时返回，关闭或切换会话后释放界面状态，迟到结果不能显示到其它会话。

## 读取边界

新增单图预览 IPC 只接受会话归属和草稿／历史定位信息，不提供任意文件或网络地址读取。宿主验证 PNG/JPEG 内容和大小；界面验证响应身份和内联数据后显示。沿用现有 `data:` 图片策略，不开放 `file:`、远端资源或额外浏览器权限。

历史预览使用只读账本读取，复用完整记录及检查点校验。读取不创建目录、获取写锁、清理临时文件、生成恢复事件或替换检查点，不改变正在运行或待恢复的会话状态。文件或目录在读取过程中改变时停止，原始文件保留。预览请求有并发上限，不自动遍历全部历史图片。

历史预览当前需要校验完整有界账本；大历史的响应耗时尚未量测，纳入目标平台验收。队列归属查询也使用只读入口，不触发首次恢复时的状态规范化或写回。开发模式的重复 effect 不会重复发起预览请求。

预览不依赖模型连接、密钥或服务识图能力。含图上下文压缩仍按 N5-01 明确阻塞；本批没有实现视觉摘要、自动截图或图片编辑。

## 验证与交付

固定代码候选：`31c4c2d39218c162a831196c7ca4b858549dc771`，tree `018900c26de0d18b529cc61b82127ab3180e17fe`。之后仅更新说明文档。

测试覆盖双协议历史提取、缺失及损坏账本、只读与稳定文件身份、草稿／队列切换、跨会话访问、迟到响应与界面关闭，并回归现有发送与历史行为。Linux 环境实际结果：

| 命令 / 范围 | 结果 |
| --- | --- |
| 根目录 `npm run build:packages` | 通过 |
| 根目录 `node --test --test-concurrency=1 packages/agent-node/tests/run-store*.test.mjs packages/agent-node/tests/chat-context-maintenance.test.mjs packages/agent-node/tests/native-image-protocol.test.mjs` | 173 通过，0 失败、跳过 |
| `apps/desktop` 中 `node --import tsx --test --test-concurrency=1 tests/native-image*.test.ts tests/attachments.test.ts tests/native-projection.test.ts tests/native-executor.test.ts tests/native-historical-receipt-executor.test.ts tests/session-service.test.ts tests/chat-queue.test.ts tests/chat-archive.test.ts tests/chat-snapshot-sync.test.ts` | 253 通过，0 失败、跳过 |
| 根目录 `npm run typecheck --workspace claude-workbench` | 通过 |
| 根目录 `npm run build --workspace claude-workbench` | 通过；保留既有大 chunk 提示 |
| `git diff --check`、独立复核 | 通过；无剩余阻断项 |

上述不重叠测试合计 **426 通过，0 失败、跳过**，分工期间的定向结果不重复相加。本轮范围根据新增只读路径、共用账本重放、会话生命周期和界面状态选择，不称为全部 workspace 测试。

复核已修复三个具体问题：冷队列查询触发恢复写回、提取共用重放函数时改变原写入路径的文件身份绑定时机、开发模式重复 effect 导致同会话第二次预览被并发限制拒绝。对应回归验证了预览前后文件内容不变、同大小替换账本后拒绝追加，以及一次实际预览读取。

目标 Windows 平台的实际图片解码、键盘焦点、窗口尺寸适配、关闭和重启体验列为 RA-30 待验。本地协议／组件测试与生产构建不能替代 Electron 图形验收。RA-29 真实识图和 E0-03 仍待执行。

Claude 保持默认；不触发 CI、平台安装包或 Release。用户已于 2026-09-29 明确授权推送，远端集成目标仅为 `dev/native-agent`。
