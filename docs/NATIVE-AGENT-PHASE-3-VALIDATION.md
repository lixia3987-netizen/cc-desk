# 阶段三实现与验收记录

日期：2026-09-26。开发基线 `dev/native-agent@bcef474f9381b37cbd5184726ae05b210355699f`，实现分支 `feat/native-agent-alpha`。main 基线 `a3f94b6c74f2abfad7a38306803319226dd5d436` 未修改。本阶段不发布 Release。

当前状态：**实现候选已形成，验收进行中**。不得将本地协议 fixture 测试扩展为真实远程模型或三平台成品已通过。最终固定候选和 CI 链接在验证完成后补入。

## 已实现

- 新增私有 `agent-core` / `agent-node` 包，根 workspaces 构建、类型检查、测试、唯一 lockfile 和桌面 worker bundle 已接入。
- Responses 完整输出与 opaque 上下文；顺序工具、审批绑定、取消、预算与未知副作用恢复。
- conversation 单写者 journal/checkpoint、稳定 request→run 去重、完整指令快照与可重建 UI 投影。
- 主进程工具监管及 utilityProcess 窄 RPC，真实本地文件/命令、嵌套 AGENTS、文件版本与路径保护。
- 原生连接设置与凭据存储、会话就绪检查、正式 native 注册和能力隐藏，Claude 默认保持。
- 跨 Claude/native/Shell 目录协调、物理释放屏障、队列持久回执及跨阶段 workflow 所有权。
- 未知运行只读、具体账本哈希绑定的人工核查确认，确认后另开新会话。

使用和恢复说明见 [自研 Agent Alpha](NATIVE-AGENT-ALPHA.md)。设计基线见 [阶段三计划](NATIVE-AGENT-PHASE-3.md)。

## 本地证据与范围

首轮定向验证包括：core 45 项；store 23 项；Responses HTTP/SSE 29 项；本地文件/指令/进程 26 项；投影 5 项；连接与就绪 14 项；目录/会话/队列/workflow 98 项；包出口/声明 8 项；native executor 真实工具闭环 6 项。后续审查新增对抗测试与修复，最终数量以固定候选日志为准，不能简单相加为总数。

交叉审查已捕获并修复重复提交收尾错误、失败回合混入上轮摘要、未知写入伪造完成记录、完整项目指令未入账、恢复确认哈希失效，以及凭据反射的流式展示风险。每项保持相应回归测试；全部根检查仍需候选统一运行。

本地 Electron 图形测试暂不可执行：没有 DISPLAY/Xvfb，安装操作被环境 setgroups/setuid 权限限制阻止。已添加真实 utilityProcess、队列/workflow、ASAR 成品用例，不能把测试收集成功视为执行通过。三平台工作流新增针对 dev/native-agent 的 PR 触发；发布步骤仍仅接受 main 上显式 `publish_release` 的 workflow_dispatch。

## 必需验收门槛

| 门槛 | 状态 |
| --- | --- |
| 同一候选根 `npm run check` | 待统一完成 |
| Windows/macOS/Linux 全部源码 Electron E2E | 待 CI |
| 三平台安装/便携实际 payload、ASAR native worker 与本地 HTTP/工具闭环 | 待 CI |
| 未知副作用、审批、目录占用与 ACK 故障回归 | 已有定向证据，待固定候选复验 |
| 用户选定真实 Responses 服务、模型、凭据来源及预算 | 待用户指定 |
| 三类真实小仓库任务、后续回合和重启续聊 | 未执行，依赖上一项 |
| 仅集成 dev/native-agent，main/Release 不变 | 待验收后集成 |

真实模型验收按计划分别完成带失败测试的缺陷修复、小功能及测试、嵌套 AGENTS 局部重构，记录实际代码、退出码、用量与人工介入。未指定的模型/密钥不会被猜测使用，也不自动产生远程费用。

保留既有分发边界：Windows 自解压 portable EXE 未单独启动、Linux FUSE 未验证；本阶段不增加签名、公证或自动更新。
