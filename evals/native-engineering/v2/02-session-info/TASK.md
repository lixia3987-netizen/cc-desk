# E0-02：增加只读会话摘要卡

在固定基线增加贯穿 main → IPC → preload → renderer 的小功能，不影响会话执行、队列、审批和默认引擎。

1. 在现有 `registerSessionHandlers` 中注册只读 `session:info`，沿用已有 `idSchema` 与 `ports.session(id)` 查找。返回且只返回 `{sessionId,title,providerId,mode,archived,workspaceKind}`；providerId/mode 来自 session.execution，workspaceKind 为有 worktree 时的 `worktree`，否则为 `project`。不存在的会话继续报错，不修改存储。不得包含 cwd、worktree 路径、engineConfig 或凭据。
2. 在 shared/types 声明 `SessionInfo` 和 `DesktopAPI.getSessionInfo(id: string): Promise<SessionInfo>`；preload 通过 `ipcRenderer.invoke('session:info', id)` 转发，不放宽 IPC 来源或输入校验。
3. 增加导出的纯展示 `SessionInfoCard({info?,loading,error?,onRefresh})`，显示上述信息、明确读取/错误状态及刷新入口。React 正常转义标题，不使用 HTML 拼接。为了便于独立验收，providerId、mode、workspaceKind 保留原值可见。
4. 在 ChatPane 中提供“会话摘要”开关，打开时读取、可手动刷新。切换 session 或组件卸载后，旧请求不得覆盖新会话数据；请求失败须显示错误和重试入口。读取不启动 agent、不发送消息、不修改配置。
5. 在 `apps/desktop/tests/e0-session-info.test.ts` 新增 main 输入/输出、只读性与展示/请求边界测试；保留全部原测试。说明本地覆盖与必须另行运行的真实 Electron 交互验收。

允许修改 manifest 指定的六个产品源文件及一个新测试文件。不得改依赖、CI、原测试、任务要求或默认引擎。现有基线缺少此功能属于评估输入，不要求把参考答案合入产品。
