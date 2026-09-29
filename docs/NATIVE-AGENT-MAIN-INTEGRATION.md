# Native 与 main 集成记录

日期：2026-09-30（北京时间）。用户明确要求：整理本轮修复，在独立集成分支吸收最新 main，处理接口与行为差异，验证候选后再合 main。本次授权覆盖此前仅合入 `dev/native-agent` 的目标限制；不触发 CI、平台安装包构建或 Release。Claude 继续作为默认引擎，Windows、cc-switch/代理兼容性及真实模型验收保持后置。

## 基线与整理

- Native：`3371bf9ec723a5798212848a897d92e56fca8ba5`，含 N5-05 图片粘贴及此前所有 Native 本地交付。
- main：`68a89e3ddefc18e789178f04eaf995ab7d139f01`，含 PR #48/#50 的命名、Worktree 分支与连接管理，#54 的发布验证修复，#56/#58 的新建和会话操作流程，以及 #63 的上下文用量刷新。
- 独立分支：`integration/native-main-20260930`。在独立 worktree 内合并，未重置、暂存或改写其它工作区的已有修改。
- 先整理未发布的 Windows／不限预算评估：将原 `8324d23` 的脚本与测试完整移植为 `8012929`；Windows 文档选择性移植并保留新版 N5、兼容性后移决策，提交 `28aef82`。旧工作区重复和过时的 Mac 准备改动未整包提交，Mac 原记录标为历史。

## 接口与行为处理

保留 Native 分支的 monorepo 边界：桌面在 `apps/desktop`，Claude 运行代码在 `packages/engine-claude`，共享契约、Native core/node 独立。main 的 `src`、`tests`、Playwright 配置迁入相应位置，删除旧根路径重复实现。根 package 仍为 workspace；桌面版本跟随 main 的 `0.5.1`，不递增或发布。

| 集成点 | 合并后的行为 |
| --- | --- |
| Claude 上下文用量 | 将 main 的 `message_delta` 测量、同消息字段合并、零占位与迟到流隔离迁入引擎包；保留 Native 的独立用量和预算语义 |
| 自动命名与退出 | 命名策略和桌面状态留在宿主，包只接收可选元数据生命周期端口；停止、维护和退出等待实际清理。连接输出上限适配新构造签名，保留 Native 分支更强的 Windows 进程树释放规则 |
| 首次发送创建 | 普通新建在首次发送时明确创建所选引擎的 structured 会话，Claude 默认；草稿、附件和重试身份保留。底层创建 API 的旧缺省 terminal 语义不变，显式旧终端仍可恢复 |
| 承接会话 | 单独创建未发送草稿，保留源身份及快照检查；不进入普通首发流程覆盖承接文本，不自动执行 |
| Native 图片 | 首条 Ctrl+V 先保存在 renderer 的有界内存中，发送后才创建会话、暂存并提交；磁盘附件使用 Native 专用校验。分批准备失败不提交部分消息，重试复用已准备路径和请求身份 |
| 首条图片预览 | 对当前已选磁盘文件提供只读、限额内的预会话预览；粘贴图片从本次显式粘贴的内存数据预览。标明当前选择的本地预览，不因预览创建会话或写入暂存；既有草稿和历史预览保持原范围 |
| 删除与快照 | main 的会话删除失效检查结合 Native 有版本的快照重同步；迟到读取不恢复已删状态，删除失败后允许重新读取 |
| 菜单、配置与连接 | 保留 main 目录筛选、列表菜单与确认弹框；按引擎能力、未知配置只读及维护状态决定操作，保留 Native 配置与承接入口。Native 默认标题不冒充 Claude 的辅助命名 |
| Worktree | 保留起始分支选择、随机默认目录名和 v2 所有权；同时保留引擎 admission、目录占用及承接快照重检 |

预会话图片预览不会放宽已有 manifest/history 端点。磁盘请求必须匹配此前显式选择的 selection ID 和路径，前后核对源身份，限 PNG/JPEG、单张 1 MiB、每边 4096；关闭、切换或移除后丢弃迟到结果。主机最终发送暂存仍独立验证，预览不授予执行权限。

## 候选验证

本地代码候选为 `0d604bcb64583c22762e5dcdbb6c6f0953f5d540`，tree 为 `8e7c73c33e6fc6f28ea4f367abbb4c27bc02e478`。它包含集成提交 `6ee55a6` 及两份测试 fixture 的语义适配；之后仅登记本文及验证索引。Git Data API 发布保留双亲合并关系，远端提交身份与本地的对应表记在集成 PR，逐提交 tree 必须相同。

| 验证范围 | 通过 | 按平台跳过 | 结果 |
| --- | ---: | ---: | --- |
| 评估与发布脚本 | 50 | 0 | 通过 |
| contracts、agent-core、agent-node | 825 | 12 | 通过 |
| engine-claude | 28 | 7 | 通过 |
| desktop（全量加修复文件定向重跑） | 1240 | 5 | 通过 |
| 合计 | 2143 | 24 | 无未解决失败；跳过项均为 Windows 专属 |

桌面首次完整执行为 1244 项：1237 通过、5 跳过、2 失败。两项均是合并后过时的测试假设：上下文场景由 4 增至 5，旧宿主 fixture 仍假定同步从首条文本命名且缺少隔离命名 flags。只改两份测试后分别重跑 7/7 和 3/3 通过；新增 1 项旧 CLI 能力不足时不启动命名子进程的验证，因此最终覆盖为 1245 项。命名测试通过真实 fixture 子进程与显式释放门证明前台先完成、命名随后持久化且不污染聊天记录，未将 `auto` 断言简单改成默认标题。生产代码在这些重跑期间未变。

公共包构建、最终 TypeScript 检查和桌面生产 bundle 均通过；Vite 仍报告既有大 chunk 提示。Playwright 最终成功收集 105 项／26 个文件，未执行图形场景。独立复核识别并闭环首发预览回退和 Native 自动命名误导文案，最后复核无阻断项；`git diff --check` 通过。

主要复现命令（默认在仓库根目录，desktop 测试例外）：

```sh
npm run build:packages
node --test --test-reporter=tap --test-concurrency=1 scripts/tests/*.test.mjs
node --test --test-reporter=tap --test-concurrency=1 packages/contracts/tests/*.test.mjs packages/agent-core/tests/*.test.mjs packages/agent-node/tests/*.test.mjs
node --test --test-reporter=tap --test-concurrency=1 packages/engine-claude/tests/*.test.mjs
npm run typecheck --workspace claude-workbench
npm run build --workspace claude-workbench
cd apps/desktop
node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/*.test.ts
node --import tsx --test --test-concurrency=1 tests/desktop-launch.test.ts tests/engine-host-integration.test.ts
node ../../node_modules/@playwright/test/cli.js test --list
```

本地运行环境为 Linux、Node.js 24.19.0，无 X11/Wayland 或 Xvfb。Windows 专属测试按平台条件跳过，Playwright 场景收集不等于 Electron 图形执行。真实 CLI、服务识图和当前平台成品仍按 [正式运行验收清单](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)登记；本次合入 main 不把 pending 改成通过。

## 发布边界

集成通过独立 PR 合入 main。两个工作流仍仅 `workflow_dispatch`，提交带 `[skip ci]`；本次不执行 CI、安装包构建或 Release。Git Data API 发布时逐提交核对 tree，与已验证的本地内容完全一致，并在 PR 中登记 SHA 映射。

旧版 v2 工作区在首次写入 v3 前的迁移备份规则保持不变；旧版本不能直接写入 v3 数据。若需要运行旧安装包，使用对应迁移前备份或独立数据目录，不把源码集成成功视为数据可以无损降级。
