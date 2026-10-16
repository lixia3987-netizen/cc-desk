# E0-03：跨包复用 canonical JSON，保持审批摘要兼容

当前 `agent-core/src/run.ts` 有公共 `canonicalJson`；agent-node 的 `tools/local-tools.ts` 和 `mcp-tools.ts` 又各有重复的有限 JSON 值递归排序实现。

将核心实现提取到 `packages/agent-core/src/canonical-json.ts`，使用命名导出 `canonicalJson`。保留已有 core 根导出与 run.ts 导出路径，并让 run.ts、两个 node 工具模块都使用同一核心实现（允许 `canonicalJson as canonical`）。删除两个 node 模块中的递归实现，不新增包或改变包依赖层级。

对有效 `JsonValue` 保持完整字节行为：对象键按既有排序、数组顺序不变、字符串转义不变、`-0` 与既有结果一致、`__proto__`/constructor 是普通 JSON 键。core 的非有限数值与非 JSON 输入继续抛原错误。输入/策略/审批 digest 不得变化，不放宽审批或项目边界。

特别注意：`task.ts` 和 `run-store.ts` 的编码器有过滤 undefined 的不同语义，本任务禁止顺手统一它们。保留原测试和历史格式，不迁移或重写用户数据。

在 `packages/agent-core/tests/e0-canonical-json.test.mjs` 与 `packages/agent-node/tests/e0-tool-digests.test.mjs` 增加回归测试，验证公共导出与真实工具准备阶段的 inputDigest。运行相关原测试并报告。允许改动仅限 manifest 的核心模块、两个工具模块及指定新测试；不改依赖、CI、默认引擎或验收器。
