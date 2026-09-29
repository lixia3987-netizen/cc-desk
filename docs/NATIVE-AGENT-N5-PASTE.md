# N5-05：显式粘贴图片

日期：2026-09-29（北京时间）。开发基线：`dev/native-agent@b7f03587ce059b726b005bc478514287c6300c5a`（PR #66）。用户要求继续开发；指定服务兼容性、E0-03 真实评估与平台验收继续后置。

## 交付范围

Native 会话现在可以在提示词输入框按 Ctrl+V / ⌘V，将剪贴板中的 PNG/JPEG 图片加入待发送附件。此前文件选择和拖拽依赖磁盘路径，无法接收没有本机路径的截图 File。

粘贴沿用现有图片限额：当前草稿最多 4 张、合计 1 MiB，每边不超过 4096 像素。超限或不支持的格式明确报错，不自动缩小、转码或分批发送。普通文本粘贴保留浏览器行为；同时包含图片和纯文本时，两者分别进入附件和输入框。图片拒绝不会取消文本粘贴。

图片暂存后可移除或显式预览；只有用户发送才进入已有队列、不可变提交与历史记录流程。正在执行的回合可继续准备下一条消息，已有队列持有的图片不被覆盖。Claude 和终端的粘贴行为不变。

## 输入、存储和异步边界

入口只消费用户在编辑器触发的 paste 事件中已有的 File 数据。不读取系统剪贴板，不新增浏览器剪贴板权限，不监听全局粘贴，不解析 HTML 中的图片、远端 URL 或本机路径，也不截图或调用模型。

renderer 在读取文件前检查数量和字节数，并同步登记附件导入状态，防止立即按 Enter 或重复粘贴与导入交错。读取完成后继续核对源会话和可导入状态；IPC 和宿主串行暂存期间再次检查状态。读取期间离开原会话面板会取消尚未发出的导入；已发出的 IPC 结果只应用到原会话，不能因切换界面写入新会话。

IPC 仅接受有界 PNG/JPEG data URL；宿主独立核对规范 base64、实际 PNG/JPEG 结构、尺寸和当前草稿总限额。文件名和私有暂存路径由宿主生成，不接受 renderer 指定目标路径。新文件以独占方式创建，写入同步后才提交清单；验证或状态检查失败时恢复旧清单，再清理本批新文件。旧草稿和已发送/队列保留的文件不受正常回滚影响。若恢复清单本身失败，保守保留字节并返回失败，不把磁盘异常声明为成功或跨文件原子事务。

新图片使用原有 staged manifest，重启、发送、队列接管、历史预览和删除流程不需要新 schema。粘贴本身不改变模型连接、预算或自动压缩开关，Claude 仍为默认引擎。

## 验证记录

固定产品/测试候选：本地 `fa0376d615c24d7227c535d4f22bff806a560942`，tree `09df33a4204d568d4a4302759268afd7e075630b`；之后仅更新说明文档。Linux、Node.js 24.19.0 的实际结果如下，开发期间重复运行不累加。

| 验证 | 结果 |
| --- | --- |
| `npm run build:packages` | 通过 |
| 桌面 13 个定向测试文件 | **174 通过，0 失败、0 跳过**（含子测试） |
| 桌面类型检查与生产 bundle | 通过；保留既有大 chunk 提示，未构建平台安装包 |
| 独立代码审查、`git diff --check` | 通过，无剩余阻断项 |

新增覆盖包括读前数量/字节检查、PNG/JPEG 精确编码、非规范 base64/伪造 MIME/结构尺寸拒绝、同步导入门闩与重复导入、异步读取后源会话失效、严格 IPC 载荷和专用 preload 转发、宿主串行等待与最终读取阶段失效、整批回滚、写盘/清单失败、回滚失败保守保留、原草稿/队列文件保护及重启。已有图片执行、预览、队列和键盘用例同时回归。renderer 测试验证文件捕获、导入门闩和状态检查函数；没有把模拟的门闩读取当作真实 DOM Enter 或系统混合粘贴证据。

复现命令（仓库根）：

```sh
npm run build:packages
npm run typecheck --workspace claude-workbench
npm run build --workspace claude-workbench
```

桌面测试（`apps/desktop` 目录）：

```sh
node --import tsx --test --test-reporter=tap --test-concurrency=1 tests/native-pasted-images.test.ts tests/native-image-attachments.test.ts tests/attachments.test.ts tests/native-images-ipc.test.ts tests/native-image-paste.test.ts tests/native-images-ui.test.ts tests/native-image-queue.test.ts tests/native-image-executor.test.ts tests/native-image-draft-preview.test.ts tests/native-image-preview-host.test.ts tests/native-image-preview-ui.test.ts tests/composer-keyboard.test.ts tests/chat-queue.test.ts
```

正式运行新增 [RA-33](NATIVE-AGENT-RUNTIME-ACCEPTANCE.md)：Windows Electron 截图粘贴、混合文本和异步操作。状态保持 `pending`；单元测试不替代系统剪贴板和图形体验。宿主结构校验不进行像素解压，Windows 实际图片解码仍需现场确认。模型识图继续由 RA-29 验收。

仅向 `dev/native-agent` 集成，不触发 CI、平台成品构建或 Release。
