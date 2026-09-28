# cc-desk 工程评估输入 v1

此目录由评估操作者保管，**整目录不得复制进被评估工作区，也不要把 reference.patch 发给被评估 Agent**。只把该任务的 TASK.md 交给 Agent。应用候选 `appRevision` 与任务代码 `taskBaseline` 分开固定：较新的 Native/Claude 应用候选均操作相同旧基线。

`manifest.json` 固定三项任务及允许改动；各任务目录含指令、参考 patch，第一项另有明确的缺陷注入 patch。`acceptance/` 是独立验收逻辑；`record-template.json` 是每次运行记录，未知保持 null。v1 不接入旧 `scripts/native-eval.mjs`，不自动请求模型、获取凭据或决定费用预算。

准备和真实评估流程、已执行的本地红/绿验证及限制见仓库 `docs/NATIVE-AGENT-E0.md`。`self-check.mjs` 只在临时隔离 worktree 验证输入/参考材料，不是模型评估。它需要当前操作者仓库已安装的 esbuild、React 等依赖，不联网安装或运行 npm hooks。

目录分开是评估材料的交付约定，不是操作系统沙箱；验收器会执行候选代码。正式评估由操作者在不含模型/用户凭据的临时容器或独立账号中运行检查，并由外层进程监督设置整批超时；脚本中的单命令超时不能中断同进程 oracle 的无限循环。内容校验阻止原测试/指令被改后计为通过，不承诺抵御任意恶意候选对评估器本身的篡改。模型运行现场也不得能读取操作者的验收与参考目录。
