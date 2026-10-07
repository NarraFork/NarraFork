# 测试注意事项

## 测试隔离（`--isolate`）

`bun test` 默认让所有测试文件共享一个 global 和 module registry。linkedom 的 `parseHTML()` 每次返回新 window，但 `window.HTMLElement.prototype` 是**模块级单例**——多个 window 共用同一个原型对象。因此测试里给它装几何 stub（linkedom 没有布局引擎，不伪造就测不了滚动/测量）实际是进程级改动，`afterEach` 不还原就会泄漏给后续测试文件。

受害者是那些断言"我的代码完全不读几何"的测试（如 `ContentScrollbars.test.tsx` 把 `clientWidth` 定义成读了就抛错）：它们在自己从没装过的 stub 上失败，报错 `Forbidden geometry read: ...`。**中弹名单取决于文件枚举顺序**，所以一次目录重命名就能让受害集合整体改变，看起来像重构引入了回归。

诊断特征：**单个文件跑全绿、混在一起跑失败**。遇到这种就先加 `--isolate` 复跑，再判断是否真回归。

- `bun run test` 已默认带 `--isolate`（等价于 `bun test --isolate`）；CI 中的 `bun test` 也已加上。
- `--isolate` 让每个文件拿到全新 global 并清空 module registry，代价是全仓耗时约 2.5 倍（量级示意：本机 136s → 346s，随仓库规模变化）。赶时间且只关心自己那几个文件时可用 `bun run test:fast`（无隔离），但**判断"是否有回归"必须以 `--isolate` 的结果为准**。
- `bunfig.toml` 不支持 `isolate` 键，只能通过 CLI 传入；`--parallel` 隐含 `--isolate`，不要与 `--no-isolate` 并用。
- 隔离不是万能：它救不了"文件路径写错"这类问题（见下方"源码文本守卫"）。

## 源码文本守卫（`readFileSync` 类测试）

约 250+ 个测试文件用 `readFileSync` / `Bun.file` 把**源码当纯文本**读进来做断言（其中约 20 个显式命名 `*.guard.test.ts`）。存在的理由是真实的：`NarratorPanel` 这类组件挂着 query、WS 订阅和滚动容器，单元测试挂载不起来；而"某段代码**不存在**"（如 vlist 之外不得静态 import vlist）本就是模块图性质，运行时观察不到。

代价是**这些路径对 TypeScript 和打包器完全不可见**——它们只是字符串。移动或重命名文件时：

- `bun run build` 和 `bunx tsgo --noEmit` 都会通过，因为业务 import 已修好；
- 而守卫测试在文件顶层 `readFileSync` 直接抛 ENOENT，**整个测试文件挂掉**。

后果不对称：这类守卫的唯一职责就是"防止某个不变量被悄悄改掉"，它自己失效等于保险丝被拔掉，且过程无声。`--isolate` 对此无效。

因此**移动 `frontend/components/narrator/` 等目录下的文件后，必须全仓搜索旧路径字符串**，而不是只看类型检查和构建是否通过。

改这类断言时的原则：
- 断言指向的逻辑若已搬家，应把断言**改指新宿主**（必要时拆成两处分别验证"上游转发"与"下游归属"），而不是删掉或放宽它。
- 断言"某段代码**存在**"（如 `toContain("if (dockOpenFilePanel) return ...")`）是把实现细节抄了一份，重构必然同步失败，且验证的是"文本长这样"而非"行为正确"。这类应优先改造成真实行为测试——逻辑一旦抽成 hook 就可以直接调用测试。

## 中断与重启恢复

Ctrl+C 停止服务器后，下次启动默认继续被中断的前台、后台及嵌套子代理。
已开始执行但未保存最终结果的普通工具会记录“执行结果未知，可能已产生副作用”，不会自动重执行；
人工审批继续等待，自动反思可重试，人工接管的反思继续等用户决定。
只丢弃明确未完成的文本／推理块，保留已完成输出与工具历史。

只启动服务器、不自动继续代理或工具时，传入 `--no-auto-resume`：

```sh
bun server/index.ts --no-auto-resume
# 打包后的可执行文件：
./narrafork --no-auto-resume
```

该参数保留审批和恢复清单；可以手动“继续”指定会话。未消费的清单必须跨越再次 Ctrl+C，且保持原 continuation epoch。

恢复测试使用隔离数据库和临时数据目录，不中断承载当前会话的服务器。至少覆盖：

- `--no-auto-resume` 启动 → 再次信号停机 → 默认冷启动，审批身份和恢复资格不丢失。
- 工具结果已保存、owner 尚未继续的停机窗口，不重复执行工具或覆盖成功结果。
- 原执行 owner 的 partial 被 fork 共享时，输出清理／完成只隔离 sibling 快照，保留真实工具 PK、审批、continuation 和 Agent origin。
- 通过实际 `executePersistedToolCall` 恢复审批；批准前零执行，批准后只执行一次，sibling 的工具快照与输出不改变。
- 历史 COW 工具行不获得自动恢复授权，不放宽 `prepareToolCallAttempt` 的身份与已启动守卫。
