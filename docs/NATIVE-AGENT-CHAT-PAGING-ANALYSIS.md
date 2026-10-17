# Native 会话：刷新不及时与翻页加载失效分析

日期：2026-10-17。分析基线：`main@b1377d7f59916fabc3690eaeedc7b97eab3e41bb`。本文是静态代码分析，未改动代码，也未运行应用复现，结论待实测验证（见文末“验证方法”）。下文路径相对 `apps/desktop/src/`，`packages/` 开头的路径除外。

## 现象

- 自研 Agent（Native）会话的信息刷新不及时。
- 往上滚动时不能自动加载更早的会话内容，通常只能看到一页左右。

## 结论

问题不在虚拟列表本身，而是三类原因叠加：

1. **自动翻页只靠 `scroll` 事件触发。** Native 首屏消息条数很少，往往撑不满一屏；没有滚动条就不会产生 `scroll` 事件，所以永远不会触发加载。
2. **Native 每写一条账本记录，就全量重建并重写整个展示文件。** 智能体本身要等重建完成才继续，会话越长越卡。
3. **前端合并逻辑有几条路径会清掉“更早消息”的游标，或让列表停止追加新消息。**

Claude 会话共用同一套 `ChatPane`、`useChatDisplay` 和虚拟列表，差异主要在主进程如何写入和发布记录：

| 方面 | Claude | Native |
| --- | --- | --- |
| `readDisplay` | `display.page(id, options, { conversationId })`，不要求严格匹配 | `requireConversationMatch: true`（`main/engines/native/projection.ts:552`） |
| 写入记录 | 原地追加（`chat-history.ts:193-207` 的 `appendFileSync`），在内存中 upsert | 每个事件都全量重建、改名覆盖文件（`projection.ts:139-467`） |
| `<id>.json` 快照 | 200ms 后保存，旧页读取会用到 | 从不存在：`projection.ts:405` 会删除它，且 `ChatHistory` 以只读方式打开 |
| 旧页索引 | 文件身份不变，索引增量更新 | 每次重建都改变文件身份，执行期间每次读旧页都要全量重建索引 |
| 变更通知 | 40ms 防抖（`packages/engine-claude/src/runtime.ts:185-187`） | 每个 delta、每次重建各发一次，主进程不节流（`projection.ts:556-563`） |

## 一、为什么只能显示一页左右

### 1. 没有“不满一屏就自动补页”的逻辑（主因）

- `renderer/ChatPane.tsx:358-367` 的 `handleScroll` 只在 `scroll` 事件里、且 `scrollTop<180` 时才调用 `loadEarlier()`。
- 整个 renderer 没有用 IntersectionObserver 做加载，也没有判断 `scrollHeight <= clientHeight`（已 grep 确认）。
- 内容不溢出时没有滚动条，滚轮也不会产生 `scroll` 事件，自动加载永远不会被触发。
- 已经在顶部（`scrollTop=0`）时继续往上滚，同样不会产生事件。

```tsx
const handleScroll=()=>{
  onScroll();
  if(scroll.current&&scroll.current.scrollTop<180&&!display.loading&&!display.error&&!earlierFrame.current){
    earlierFrame.current=requestAnimationFrame(()=>{earlierFrame.current=requestAnimationFrame(()=>{
      earlierFrame.current=0;if(mounted.current&&scroll.current&&scroll.current.scrollTop<180)void loadEarlier();
    });});
  }
};
```

### 2. Native 首屏条数特别少

- `main/chat-display-reader.ts:37-60` 的 `displayPage`：首屏预算约 240 KiB（`PAGE_BYTES - 16 KiB`），最多 50 条；每条正文和工具输入各截取 16 KiB（`PREVIEW`）。
- Native 工具消息同时带输入（投影中最多 64 KiB）和输出（最多 256 KiB），每条约占 32~40 KiB，所以首屏往往只能装 **6~15 条**。
- 这些工具消息在 `ChatPane.tsx:99` 被渲染成折叠的 `<details>`，每条只占一行，而且折叠时详情根本不渲染。预算都花在了看不见的工具详情上，结果一屏都撑不满，于是又回到第 1 点。
- 前端快照里其实已经有最近 400 条消息，但 `mergeDisplaySnapshot`（`renderer/chat-display-state.ts:66-94`）只更新已有消息、在尾部追加新消息，不会用快照里更早的消息往前补。

### 3. 一次失败的“更早消息”请求会把游标永久清空

`main/chat-display-reader.ts:112-117`：

```ts
if (options.before || options.after || options.around) {
  const fallback = source.requireConversationMatch ? await this.page(id, {}, source) : await this.fallback(id);
  if (source.requireConversationMatch && !fallback.messages.length && fallback.incomplete) return fallback;
  ...
}
```

- Native 读更早一页时，会先按严格模式重读尾部。下列任一情况都会让尾部读到空且不完整，此时直接返回一个空页：sidecar 的会话不匹配（L129-131）、尾部有其他会话的记录（L169）、文件缺失（L120-121）。
- 前端 `mergeDisplayPage`（`chat-display-state.ts:50`）用 `before: incoming.before` 合并，`before` 变成 `null`。
- 结果是“查看更早消息”按钮消失，自动加载也停止，直到重新打开会话。
- 另外，`chat-display-reader.ts:27` 在读取期间文件被改名替换时会抛出“显示记录在读取时发生变化，请重试。”；`chat-archive.ts:112` 找不到锚点时会抛错。两者都会设置 `display.error`，而 `handleScroll` 在有错误时不会自动加载。

### 4. 8 MiB 估算上限很快被触及，加载的内容会被裁掉

- `chat-display-state.ts:4,53-59`：大小估算按每个字符 2 字节；快照里的消息会用最大 256 KiB 的版本（`chat-history.ts:10`）替换掉 16 KiB 预览（`chat-display-state.ts:84-88`）。
- 快照部分最多约占 4 MiB 估算值，每个旧页约 2 MiB，所以加载两三页后就开始裁剪：
  - 用户停在底部、跟随最新时（`protectHistory=false`），从头部裁掉刚加载的旧消息；
  - 用户往上看时（`protectHistory=true`），从尾部裁掉最新消息并设置 `after`，此后实时消息不再追加（见二.3）。

## 二、为什么刷新不及时

### 1. 每次写入都全量重建，智能体要等它跑完（主因）

`main/engines/native/structured-executor.ts:845-862`：`beginRun` / `append` 每写一条账本记录，都要 `await this.refreshProjection(id, ledger, true)`，进而进入 `projection.hydrate` → `rebuild`。命令事件（L753-757）、变更集事件（L770-779）也一样。

`projection.ts` 的 `rebuild`（L139-467）每次都会：

| 步骤 | 位置 | 开销 |
| --- | --- | --- |
| 从 seq 0 重放并克隆整个账本 | L150-155 | O(全部记录) |
| 逐行 `await handle.writeFile(line)` 写临时文件 | L389-394 | 记录多少行就 await 多少次 |
| `handle.sync()` | L396 | Windows 上的 FlushFileBuffers 很慢 |
| 删除 `.json`，改名覆盖 `.jsonl` | L405-407 | Windows 上文件正被读取时可能报 EPERM；重试只有 10/25/50ms（L33-42），之后标记投影失败 |
| `new ChatHistory().get(id)` **同步 readSync** 重读整个文件 | L421-422 | 阻塞主进程，所有 IPC 一起变慢 |
| 写 sidecar、加载质量审查与子 Agent 回执 | L424-451 | 额外文件 I/O |
| 最后才发 `changed` | L466 | 界面要等上面全部完成才得知更新 |

结果是每次写入的耗时和会话长度成正比，整轮执行越往后越慢。

另外，执行期间读快照不会 hydrate（`structured-executor.ts:206-207`），只能看到最近一次完成的重建结果。

### 2. 流式输出时，每个 token 都要深拷贝一次完整快照

- `projection.ts:556-563`：每个 `text_delta` 都调用 `changed()`，主进程没有任何节流。
- `projection.ts:122` 的 `changed()` 为了拿 `taskState`，调用了 `this.snapshot(id)`，这会对最多 400 条 / 2 MiB 的快照做一次完整的 `structuredClone`（L523）。
- `session-service.ts:62-72` 每次都发一次 `chat:changed`；渲染进程每 80ms 再拉一次完整快照（`renderer/shared-chat-snapshot.ts:221-231`）。

### 3. 列表一旦“脱离尾部”，就不再追加新消息

- `chat-display-state.ts:89` 只在 `page.after === null` 时追加新消息。
- 被一.4 的裁剪设置了 `after` 之后，往下滚动也没有自动加载较新内容的逻辑，看起来就是“内容停住了”，只能点“跳到最新消息”。而“跳到最新消息”会把列表重置为尾部首屏（`ChatPane.tsx:161-165`）。

### 4. 连续两次同步失败后，自动刷新和 5 秒轮询都会停止（次要）

- `renderer/chat-snapshot-sync.ts:27`：`canAutoRefresh` 为 `failures < 2`。
- `ChatPane.tsx:310`：`failures>=2` 时停止轮询，需要手动点“重新同步状态”。

## 三、解决方案（按优先级）

### P0-1 前端：不满一屏时自动补页，顶部滚轮也触发（`renderer/ChatPane.tsx`）

```tsx
// 放在 handleScroll 之后
useLayoutEffect(()=>{
  const el=scroll.current;
  if(!el||!display.page?.before||display.loading||display.paging||display.error)return;
  if(exhaustedBefore&&exhaustedBefore===visible.messages[0]?.id)return;
  if(el.scrollHeight-el.clientHeight<180){            // 内容未溢出，不会产生 scroll 事件
    const id=requestAnimationFrame(()=>void loadEarlier());
    return()=>cancelAnimationFrame(id);
  }
},[display.page,display.loading,display.paging,display.error,exhaustedBefore,visible.messages,loadEarlier]);

const handleWheel=(e:React.WheelEvent)=>{
  if(e.deltaY<0&&scroll.current&&scroll.current.scrollTop<=0&&!display.loading&&!display.error)void loadEarlier();
};
// <div className="chat-scroll" ... onScroll={handleScroll} onWheel={handleWheel}>
```

这个循环会自然结束：没有更早消息时 `before` 变成 `null`；出错时被 `display.error` 拦住。

### P0-2 主进程：临时空页不能清掉游标（`main/chat-display-reader.ts:115`）

```ts
if (source.requireConversationMatch && !fallback.messages.length && fallback.incomplete)
  throw new Error('会话记录正在更新，请稍后重试读取更早消息。');   // 保留游标，交给重试按钮处理
```

可选的前端兜底：`mergeDisplayPage` 在 `direction==='before'`、收到空页且 `incomplete` 时保留 `current.before`。但不要和 P0-1 的自动补页叠加成重复请求，优先用主进程抛错的方案。

### P0-3 主进程：`changed()` 不再深拷贝，流式通知加节流（`main/engines/native/projection.ts`）

```ts
private taskStateOf(id: string): TaskState {
  const e = this.entry(id);
  if (e.override) return e.override.taskState;
  if (e.pending.length) return e.pending.some(i => i.kind === 'question') ? 'waiting_input' : 'waiting_approval';
  return e.history.get(id).taskState;          // 与 snapshot() L540-541 的逻辑一致
}
private changed(id: string): void {
  this.events.emit({ type: 'conversation.changed', identity: getSessionIdentity(this.getSession(id)), taskState: this.taskStateOf(id) });
}

private deltaTimers = new Map<string, NodeJS.Timeout>();
// event() 中把 this.changed(id) 换成：
if (!this.deltaTimers.has(id)) this.deltaTimers.set(id, setTimeout(() => { this.deltaTimers.delete(id); this.changed(id); }, 50));
```

会话删除或释放时需要清理对应的计时器。

### P1-1 提高 Native 首屏密度（`main/chat-display-reader.ts` 的 `displayPage`、`main/chat-archive.ts` 的 `preview`）

- 对 `role==='tool'` 改用更小的预览，例如 2~4 KiB，让首屏真正能装下 50 条。
- 展开工具卡片时再按需取完整内容：新增一个 `chat:message` IPC，复用 `ChatArchive.message()`。
- 最简单的替代方案：把首屏 `PAGE_BYTES` 提到 1 MiB，和旧页预算（`chat-archive.ts:6`）一致。注意 `writeDisplaySidecar` 也用同一个上限。

### P1-2 降低重建开销（`projection.ts` 的 `rebuild`）

- 把所有行拼成约 1 MiB 的块分批写入，不再每行 await 一次。
- 展示投影可以从账本重建（启动时 `seq=0` 会全量重建），可以考虑去掉每次的 `handle.sync()`，或只在本轮结束、关闭时同步一次。
- 不再用 `new ChatHistory().get(id)` 同步重读文件。数据已经在内存里的 `projected` 中，可以给 `ChatHistory` 加一个公开的 `applyEvents(id, events)` 方法（复用私有的 `applyEvent`，`chat-history.ts:295`），在内存中构建快照。

### P2-1 增量投影（根治方案）

- 代码里已经把 `seq > old.seq` 当作增量来发 journal（`projection.ts:465`）。可以把重建循环里的状态（`tools`、`changeSets`、`streamEpochs`、`preparedTools`、用量统计等）保存在 entry 中，每次写入只把新的行追加到 `.jsonl`，并 upsert 到 `ChatHistory`，和 Claude 的做法一致。
- 全量重建只保留给 hydrate、恢复、压缩这几种情况。
- 注意 `context_compaction_attempted` 依赖运行时状态（`store.lookupAutoCompaction`、`isAutoCompacting`），尾部的 `context` 事件每次都会重新生成，增量时需要单独处理。
- 同时，`append` 可以不再 await 展示重建，改成合并调度：同一时间最多一个在执行、一个在排队。展示失败本来就按 `bestEffortDisplay` 处理，不影响账本。
- 这样也能消除 Windows 上的改名冲突，以及旧页索引每次都要全量重扫的问题（`chat-archive.ts:61` 按 dev/ino 判断文件身份，每次改名都会让索引失效）。

### P2-2 前端合并（`renderer/chat-display-state.ts`、`renderer/useChatDisplay.ts`）

- 加一个 `later()` 方法：列表已脱离尾部（`after` 有值）时，滚到底部附近自动加载较新的一页，和 `earlier()` 对称；脱离尾部时显示“有新消息”提示。
- 合并快照时，对已折叠的工具消息保留预览版本，不用 256 KiB 的完整版本替换，避免很快触及 8 MiB 上限。
- 同步失败后不要完全停掉轮询，改成退避重试，例如 5s → 15s → 30s。

### 建议实施顺序

1. 先做 P0-1、P0-2、P0-3：改动小，能直接解决“不自动翻页”和流式输出时的卡顿。
2. 再做 P1：提高首屏密度，降低每次重建的固定开销。
3. 最后做 P2：解决长会话越来越慢的问题，以及脱离尾部后的体验。

建议补充回归测试：目前 Native 没有分页相关测试，`tests/native-display.test.ts` 只校验会话绑定（L38-72）。可以参照 Claude 的 `tests/session-loading.spec.ts:252-326`，补充以下场景：首屏不满一屏时自动补页；读旧页时尾部暂时为空不清游标；长会话执行期间每次写入的耗时不随会话长度线性增长。

## 验证方法

- 启动前设置环境变量 `CC_DESK_CHAT_PERF=1`，看主进程日志里的 `[cc-desk:chat-load]`（`main/ipc/chat-handlers.ts:74-83`）：
  - Native 会话 `operation: display` 的 `messages` 如果只有个位数到十几条，就印证了一.2；
  - `operation: snapshot` 的 `elapsedMs` 如果在执行过程中持续增长，就印证了二.1。
- 在 DevTools 里对 `.chat-scroll` 元素检查 `scrollHeight <= clientHeight`，如果成立，就印证了一.1。
- 读旧页后如果“查看更早消息”按钮消失，且界面没有出现“已到本地保留记录的开头”提示，就印证了一.3。
