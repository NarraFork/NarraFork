# 大纲编辑器原型（P0）

验证 `docs/OUTLINE_KNOWLEDGE-DESIGN.md` §6（编辑器与实时协同）能不能成立。结果见 [RESULTS.md](RESULTS.md)。

- 直接用 ProseMirror（model / state / view / transform / keymap / commands），不用 Tiptap 的文档和协同扩展；多人协同用 Yjs；方言分词用 marked@18（与 `shared/` 同版本）。版本全部写死，见 `package.json`。
- **块模型是真相，编辑器文档只是投影**：块存储（id、父块、排序键、markdown 正文、任务状态）在客户端和「服务端」各有一份；编辑器文档是 `outline > block+`、`block = body + children?`，每个块节点带块 id。
- 同一个页面里：内存「服务端」、两个客户端（Alice、Bob）、一个模拟 agent。

## 怎么跑

依赖装在这个目录里（不碰仓库根的 `package.json` / `bun.lock`）：

```bash
cd prototypes/outline-editor
bun install
bun run build          # 打包到 dist/
bun run serve          # 起静态服务（默认 http://127.0.0.1:7790/），浏览器里手动试
bun test test/         # 验收第 9 项：方言往返（不依赖 DOM 的单元测试）+ 三方合并 / 排序键 / diff
node e2e/run.mjs       # 验收第 1、3–8 项（Playwright 无头 Chromium），结果写到 results/e2e.json
node e2e/run.mjs 1 5   # 只跑某几项（0 是附加的键位 / 外框 / 光标映射）
bun run check          # tsgo 类型检查 + Biome（在仓库根用根目录的 tsgo / Biome 跑）
```

e2e 用预装的 Playwright（`require('playwright')`，`chromium.launch()` 不带参数），不要 `playwright install`。性能模式：`?mode=perf&n=2000`。网络延迟：`?latency=80` 或页面上的输入框。

## 页面

- 上面两栏：Alice、Bob 各自编辑「设计文档（P1）」。P1 里有标题、段落（含标记和提及）、代码、引用、表格、一个嵌入别页的块 `![[P2/P2b3]]`、一个嵌入本页块的 `![[P1/P1b3]]`（同一个块在一页里出现两次）。
- 下面：Alice 的拼接视图（P1 / P2 / P3 的块混排），Bob 看「任务（P2）」。
- 右边：服务端当前状态（大纲 markdown）、日志；工具栏可以暂停任一方的网络（模拟并发）、让 agent 读写。
- 键位：Enter 拆块、块首 Backspace 合并、块尾 Delete 合并下一块、Tab / Shift-Tab、Alt+↑↓、Shift-Enter 块内换行、Mod-Enter 变任务、Mod-z / Mod-Shift-z 撤销重做、Mod-b / i / e 标记；输入 `[[地址]]` 变成提及，行首 `# `、`> `、三个反引号变块体。点项目符号折叠，点复选框切换状态。

测试接口挂在 `window.proto` 上（`focus`、`insertVia`、`cmd`、`agentRead` / `agentWrite`、`net.hold`、`undo` / `redo`、`serverOutline` 等，见 `src/app/main.ts`）。

## 代码结构

```
src/dialect/   块内方言（§6.8 / D23），不依赖 DOM 和 ProseMirror，服务端和浏览器共用
  lexer.ts       marked@18 + `[[…]]` / `![[…]]` 分词扩展（行内代码里的是字面文字）；不认 GFM 裸链接
  parse.ts       源文本 → 块体 AST + 「内容偏移 → 源码偏移」映射；方言外的结构拆成子块或原样保留
  serialize.ts   AST → 规范 markdown（最小转义）
  safe.ts        写完立即用同一解析器读回核对；标记写不出来时降级（见 RESULTS「中文标点」）
src/model/     块存储与大纲操作、排序键（分数索引）、词元级 diff、三方合并
src/server/    内存服务端：大纲事务排序 / 校验 / 广播，按页 Y.Doc、按块 Y.Text，agent 读写
src/net.ts     内存网络：按链路有序投递，可设延迟、可暂停
src/client/
  client.ts      客户端副本：confirmed + pending = visible，按页 Y.Doc，统一撤销栈
  view.ts        一个编辑面（页 / 嵌入子树 / 拼接视图）：投影、reconcile、输入法推迟、源码映射、剪贴板
  commands.ts    大纲键位（全部是 ProseMirror 事务）
  schema.ts      编辑器 schema；convert.ts：AST ↔ ProseMirror 节点
src/app/       原型页面
test/          bun 单元测试（第 9 项）
e2e/           Playwright 验收脚本（第 1、3–8 项 + 附加的键位测试）
```

## 注意

- `test/*.test.ts` 只依赖 marked（仓库根也装了同版本），仓库根跑全量 `bun test` 时会被一并发现，约 4 秒，能通过。
- `results/`、`dist/`、`node_modules/` 不提交（本目录的 `.gitignore`）。
