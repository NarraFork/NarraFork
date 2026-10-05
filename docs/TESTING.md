# 测试注意事项

## 测试隔离（`--isolate`）

`bun test` 默认让所有测试文件共享一个 global 和 module registry。linkedom 的 `parseHTML()` 每次返回新 window，但 `window.HTMLElement.prototype` 是**模块级单例**——多个 window 共用同一个原型对象。因此测试里给它装几何 stub（linkedom 没有布局引擎，不伪造就测不了滚动/测量）实际是进程级改动，`afterEach` 不还原就会泄漏给后续测试文件。

受害者是那些断言"我的代码完全不读几何"的测试（如 `ContentScrollbars.test.tsx` 把 `clientWidth` 定义成读了就抛错）：它们在自己从没装过的 stub 上失败，报错 `Forbidden geometry read: ...`。**中弹名单取决于文件枚举顺序**，所以一次目录重命名就能让受害集合整体改变，看起来像重构引入了回归。

诊断特征：**单个文件跑全绿、混在一起跑失败**。遇到这种就先加 `--isolate` 复跑，再判断是否真回归。

- `bun run test` 已默认带 `--isolate`（等价于 `bun test --isolate`）；CI 中的 `bun test` 也已加上。
- `--isolate` 让每个文件拿到全新 global 并清空 module registry，代价是全仓耗时约 2.5 倍（本机 136s → 346s）。赶时间且只关心自己那几个文件时可用 `bun run test:fast`（无隔离），但**判断"是否有回归"必须以 `--isolate` 的结果为准**。
- `bunfig.toml` 不支持 `isolate` 键，只能通过 CLI 传入；`--parallel` 隐含 `--isolate`，不要与 `--no-isolate` 并用。
- 隔离不是万能：它救不了"文件路径写错"这类问题（见下方"源码文本守卫"）。

## 源码文本守卫（`readFileSync` 类测试）

约 140 个测试文件用 `readFileSync` / `Bun.file` 把**源码当纯文本**读进来做断言（其中 18 个显式命名 `*.guard.test.ts`）。存在的理由是真实的：`NarratorPanel` 这类组件挂着 query、WS 订阅和滚动容器，单元测试挂载不起来；而"某段代码**不存在**"（如 vlist 之外不得静态 import vlist）本就是模块图性质，运行时观察不到。

代价是**这些路径对 TypeScript 和打包器完全不可见**——它们只是字符串。移动或重命名文件时：

- `bun run build` 和 `bunx tsgo --noEmit` 都会通过，因为业务 import 已修好；
- 而守卫测试在文件顶层 `readFileSync` 直接抛 ENOENT，**整个测试文件挂掉**。

后果不对称：这类守卫的唯一职责就是"防止某个不变量被悄悄改掉"，它自己失效等于保险丝被拔掉，且过程无声。`--isolate` 对此无效。

因此**移动 `frontend/components/narrator/` 等目录下的文件后，必须全仓搜索旧路径字符串**，而不是只看类型检查和构建是否通过。

改这类断言时的原则：
- 断言指向的逻辑若已搬家，应把断言**改指新宿主**（必要时拆成两处分别验证"上游转发"与"下游归属"），而不是删掉或放宽它。
- 断言"某段代码**存在**"（如 `toContain("if (dockOpenFilePanel) return ...")`）是把实现细节抄了一份，重构必然同步失败，且验证的是"文本长这样"而非"行为正确"。这类应优先改造成真实行为测试——逻辑一旦抽成 hook 就可以直接调用测试。
