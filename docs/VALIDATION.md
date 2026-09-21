# 验证记录

日期：2026-09-21。执行环境：Linux x64，Node.js 24.19.0，Electron 44.4.3。

## 已执行

| 检查 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过 |
| 单元与集成测试 | 10 / 10 通过 |
| React/Vite + 主进程/preload 生产构建 | 通过 |
| Electron 桌面端到端测试 | 1 / 1 通过，覆盖完整操作链 |
| 真实 node-pty Shell | 输入、Unicode、空格路径、调整窗口、并发限制、停止均通过 |
| 本地状态 | 原子保存、上版备份、损坏保护、重启恢复通过 |
| 会话 CLI 参数 | 新建、恢复、导入、分支、max/ultracode 不混淆通过 |
| 历史读取 | 项目隔离、部分 JSONL 行容错、原文件不变通过 |
| Git worktree | 新分支与目录创建、原目录未提交内容保留通过 |
| IPC 与安全参数 | 非法 UUID、非法设置、越界参数拒绝通过 |
| 缓冲大小 | 多块与超大单块边界通过 |
| npm audit | 0 个已知漏洞，扫描结果反映执行当时的依赖数据库 |
| 真实 Claude Code CLI | 通过 npm 调用 2.1.278 的 --version / --help，确认公开接口和换行的 effort 列表 |
| Windows x64 便携 ZIP | 交叉打包完成，检查 Electron exe、app.asar、Windows ConPTY 原生模块和辅助文件 |

桌面测试覆盖：打开工作台 → 添加含中文及空格的目录 → 创建 Shell 会话 → 实际终端输入 → 重命名 → 创建另一个会话 → 切回运行中会话 → 停止 → 归档/取消归档 → 打开设置 → 退出重启 → 确认项目及会话持久化 → 拒绝非法 IPC 参数。

当前 Linux 容器不允许常规 Unix 图形套接字。测试使用隔离的 Xvfb 图形服务和 Playwright 运行真实 Electron；补装 CJK 字体后进行界面检查。这些测试环境配置没有加入正式应用启动参数。

## 尚未验证

- **Windows/macOS 实机运行。** Windows 包是交叉构建的预览版，不等于已经通过 Windows 验收；macOS 打包脚本存在，本次未生成 DMG。
- **登录后的真实 Claude 模型调用与计费。** 未拥有用户本机 Claude 登录状态，不假称已经验证模型回复、真实工具审批、真实 MCP 连接及跨版本恢复行为。
- Claude TUI 内部交互的所有快捷键、输入法组合和不同终端主题；Linux 已验证实际输入与渲染，Windows IME 仍需实机检查。
- GitHub Actions 三平台流水线已提供配置，本次没有创建远程仓库或执行云端 CI。

## 工程边界

- 工作流功能是可编辑提示词模板，不是独立的多 Agent 调度器。
- 历史扫描依赖 CLI 私有磁盘布局，提供 UUID 导入作为兼容路径。
- 终端内切换会话 UUID 不会自动同步到客户端列表；请通过客户端导入对应会话。
- 应用未代码签名，没有自动更新服务。生产构建存在单个前端 bundle 大于 Vite 默认 500 kB 提示阈值的警告；这是构建体积提示，构建成功，桌面测试通过。

## 复验

```sh
npm ci
npm run check
npm run test:e2e
npm audit
```

Linux 无桌面环境时可使用 `xvfb-run -a npm run test:e2e`。正式打包必须在目标系统复验 CLI 登录、权限审批、恢复和停止行为后，再进行签名及分发。
