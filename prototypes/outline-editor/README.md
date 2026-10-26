# 大纲编辑器原型（P0 + PR1 导图与聚焦）

验证 `docs/OUTLINE_KNOWLEDGE-DESIGN.md` §6（编辑器与实时协同）能不能成立；PR1 在上面加了 §6.10 的导图视图、
视图切换动画、聚焦和快速切换（`docs/OUTLINE_IMPLEMENTATION-PLAN.md` §10）。结果见 [RESULTS.md](RESULTS.md)。

- 直接用 ProseMirror（model / state / view / transform / keymap / commands），不用 Tiptap 的文档和协同扩展；多人协同用 Yjs；方言分词用 marked@18（与 `shared/` 同版本）；导图节点的文字测量用 `@chenglou/pretext` 0.0.8（与仓库根同版本）。版本全部写死，见 `package.json`。
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
node e2e/run.mjs       # P0 验收第 1、3–8 项 + PR1 的 9.1–9.8（Playwright 无头 Chromium），结果写到 results/e2e.json
node e2e/run.mjs 1 5   # 只跑某几项（0 是附加的键位 / 外框 / 光标映射；9 = 9.1–9.8 全部；9.3 = 导图编辑）
bun run check          # tsgo 类型检查 + Biome（在仓库根用根目录的 tsgo / Biome 跑）
```

e2e 用预装的 Playwright（`require('playwright')`，`chromium.launch()` 不带参数），不要 `playwright install`。`node e2e/run.mjs` 不会自动构建，改了 `src/` 先 `bun run build`。性能模式：`?mode=perf&n=2000`（`&pages=5` 另加 4 页各 n 块，快速切换器的索引覆盖全部页；`&premeasure=0` 关掉导图节点的预先测量）。网络延迟：`?latency=80` 或页面上的输入框。

## 页面

- 上面两栏：Alice、Bob 各自编辑「设计文档（P1）」。P1 里有标题、段落（含标记和提及）、代码、引用、表格、一个嵌入别页的块 `![[P2/P2b3]]`、一个嵌入本页块的 `![[P1/P1b3]]`（同一个块在一页里出现两次）。
- 下面：Alice 的拼接视图（P1 / P2 / P3 的块混排），Bob 看「任务（P2）」。
- 右边：服务端当前状态（大纲 markdown）、日志；工具栏可以暂停任一方的网络（模拟并发）、让 agent 读写。
- 键位：Enter 拆块、块首 Backspace 合并、块尾 Delete 合并下一块、Tab / Shift-Tab、Alt+↑↓、Shift-Enter 块内换行、Mod-Enter 变任务、Mod-z / Mod-Shift-z 撤销重做、Mod-b / i / e 标记；输入 `[[地址]]` 变成提及，行首 `# `、`> `、三个反引号变块体。点折叠箭头（项目符号左边的 ▾ / ▸）折叠，点项目符号聚焦，点复选框切换状态。

测试接口挂在 `window.proto` 上（`focus`、`insertVia`、`cmd`、`agentRead` / `agentWrite`、`net.hold`、`undo` / `redo`、`serverOutline` 等；PR1 加了 `setView`、`setLayout`、`focusBlock`、`viewState`、`mapState`、`mapTree`、`mapSelect`、`mapEdit`、`mapFit`、`nodeRect`、`nodeAccuracy`、`anchorScreen`、`mapStats`、`transitionLog`、`blockTree`、`switcher` 等，见 `src/app/main.ts`）。

## 导图与聚焦（PR1）

Alice、Bob 的两栏各是一个**编辑面**：上面一排工具栏（大纲 / 导图，→ 向右 / ↓ 向下，全部折叠 / 全部展开 / 适应窗口），下面是面包屑，再下面是固定高度的编辑区。两种视图共用一份视图状态（聚焦的块、折叠集合、光标所在的块和块选择、视口锚点、导图方向）；导图里的编辑走和大纲同一套大纲事务和撤销栈，所以一个人在导图里改、另一个人在大纲里改同一块照常合并。

- **切换**：点「大纲 / 导图」或「向右 / 向下」。可见的块从旧位置移到新位置（FLIP，250 ms），离视口中心最近的块在屏幕上不动；系统开了「减少动态效果」时直接切换。
- **大纲里**：Alt+→ 聚焦光标所在的块（点项目符号也一样），Alt+← 退一层，面包屑任意跳；Mod-↑ / Mod-↓ 全部折叠 / 展开，Alt+1…9 展开到第 N 层；Esc 选中光标所在的整块（块选择，再按一次退出）。地址栏是 `#/outline/<页>/<块>`，浏览器前进后退走聚焦历史。
- **导图里（选中节点时）**：
  - 方向键按屏幕方向走：向右展开时 → 第一个子块、← 父块、↑↓ 相邻同级（到头了找屏幕上那个方向最近的节点）；向下展开时对调。
  - Tab 加子块并编辑；Shift-Tab 提升一级；Alt+↑↓（向右）/ Alt+←→（向下）和相邻同级换位置；Alt+→ / Alt+←（向右）或 Alt+↓ / Alt+↑（向下）聚焦 / 退出聚焦。
  - Enter 加下一个同级并进入编辑，Tab 加子块；F2、双击或直接打字进入编辑；空格折叠 / 展开；Mod-Enter 切换任务；Delete / Backspace 删除整块；Mod-z / Mod-Shift-z 撤销重做；Shift 点击加入 / 移出块选择；Esc 清掉块选择。
  - 编辑中（节点里是一个只编辑这一块的 ProseMirror 视图，键位、方言、输入法处理和大纲一样）：Enter 在光标处拆块（在末尾就是加下一个同级），编辑跟到新块；Shift+Enter 块内换行；Tab 加子块；Shift-Tab 提升一级并接着编辑；Esc 回到节点选择。
  - 鼠标：滚轮平移，Ctrl+滚轮（触控板捏合）缩放，拖空白处平移；点节点选中、双击编辑；拖节点到另一个节点中间 = 挂到它下面，拖到节点靠前 / 靠后的四分之一 = 放在它前 / 后；点节点的项目符号聚焦、折叠箭头折叠、复选框切换状态。
  - 触屏：单指拖动平移（在节点上直接划也是平移），双指捏合缩放，点选，连点两下编辑，长按后拖动节点。
- **快速切换**：Mod-K 打开，按标题、别名（`alias:: …` 或 `别名:: …`）、正文找块，最近访问的排前面；Enter 在当前视图里聚焦过去（可以跨页）。
- 导图节点尺寸用 pretext 免 DOM 测量；页面打开后在 Worker 里预先测量整页（`?premeasure=0` 关掉，第一次切到导图时当场测）。

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
  view.ts        一个大纲视图（页 / 嵌入子树 / 拼接视图 / 导图节点里的单块）：投影、reconcile、输入法推迟、源码映射、剪贴板
  commands.ts    大纲键位和导图的结构键（全部是 ProseMirror 事务）
  schema.ts      编辑器 schema；convert.ts：AST ↔ ProseMirror 节点
  chrome.ts      块外框（折叠箭头、项目符号、复选框）和块体的静态渲染，大纲和导图节点共用
  viewstate.ts   视图状态（聚焦、折叠、选中、锚点、方向），两种视图共用
  surface.ts     编辑面：大纲 / 导图切换（FLIP）、聚焦（整页视图停放 + 聚焦视图）、面包屑、地址栏历史
  switcher.ts    快速切换器（Mod-K，内存索引）
src/mindmap/
  layout.ts      非分层紧凑树布局（van der Ploeg 2014，线性时间，节点大小不一），向右 / 向下
  measure.ts     节点尺寸：pretext 测量（富文本片段、硬换行、代码 / 表格缩略），按正文缓存；Worker 预先测量
  measure-worker.ts  预先测量的 Worker（OffscreenCanvas）
  mindmap.ts     导图视图：原生 DOM 节点 + 一层 SVG 连线、平移缩放、选中 / 编辑 / 拖动、键位、FLIP 动画
src/app/       原型页面
test/          bun 单元测试（第 9 项 + 导图布局）
e2e/           Playwright 验收脚本（P0 第 1、3–8 项 + 附加的键位测试；PR1 的 t9-1 … t9-8）
```

## 注意

- `test/*.test.ts` 只依赖 marked（仓库根也装了同版本），仓库根跑全量 `bun test` 时会被一并发现，约 4 秒，能通过。
- `results/`、`dist/`、`node_modules/` 不提交（本目录的 `.gitignore`）。
