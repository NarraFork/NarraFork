# 超大树的历史：去掉「页」这个边界之后怎么存、怎么读（设计研究）

依据：`origin/main`（9bb31f88）的代码；上一份研究 `docs/OUTLINE_LIVE-SUBTREE-STUDY.md`（D56）；小型基准在 `scratchpad/tree-history-prototypes/`（不进产品代码，附说明）。

## 背景

大纲是每个空间一棵块的树，每次改动是一次**提交**（一个空间内从 1 递增的序号 `seq`），每个块每改一次留一行**版本**，带「从哪个序号起有效、到哪个序号失效」的区间。「时间机器」就是按某个序号去读这些区间。现在每一行版本都冗余记着「这个块当时在哪一页」（`page_id`，页 = 顶层块），所以「某页在某时刻的样子」是一次范围查询。代价是：子树换页时要给每个后代写一行新版本（实测 1999 块 73 ms，超过 2000 行拒绝），超过 10,000 块的页读不了整页，而且「页」渗进了所有地方。负责人在 D56 把实时编辑的单位改成任意子树，现在问：历史这边能不能把「页」彻底去掉，同时在 10 万到 100 万块的空间里保持编辑和历史都快。

## 建议（先看这一节）

**可以去掉。建议：版本表不动，仍是唯一的事实来源；旁边加两张可以随时重建的小表，读历史时从父块往下一层一层走，不再按页圈一块。**

- **位置表**（每个块「在哪个父块下、排第几」的区间，只在创建、移动、删除、恢复时写一行；改字不写）。「X 的子块在时刻 T 是哪些」是这张表上的一次查找。
- **变动表**（每次提交，把被改的块的每一个祖先记一行「祖先, 序号」）。它回答两件事：任意一个块（不只是页）的时间线；以及「这棵子树在两个时刻之间有没有变过」，没变过的子树在比较和缓存时整棵跳过。
- **移动任意大的子树只写 1 行版本**（实测 0.2–0.7 ms、共 6 行，和子树大小无关；按现在的写法，搬 2 万块在 10 万块的空间里要 2 秒、在 100 万块的空间里要 6.5 秒，搬 10 万块要 18.7 秒，都在主线程的一个事务里；所以今天超过 2000 块直接拒绝）。
- **读历史的耗时跟着「屏幕上显示多少」走，不跟着「这一页有多大」走**：50 块的可见范围 0.3–0.7 ms（今天要先读整页：2000 块的页 25 ms，10,000 块的页 93 ms）；一次显示 800 块 6–12 ms，子树是 2 千块还是 10 万块都一样。
- **比较两个时刻**：只沿着变过的路径往下走，2000 块的子树相隔 1000 次提交 1.7–3.8 ms（今天读两遍整页再比：18–43 ms），1 万块 15 ms（今天 139–191 ms）。
- 代价：历史占用增加约 12%（SQLite；PostgreSQL 上约 49%，因为那边每行的固定开销大）；每次普通提交多写 2–3 行、多花约 0.05 ms；整棵子树一次读完并不比今天快（基本持平）；当前状态的整页读取如果不再靠 `page_id` 会慢约 3 倍，所以要同时把读取改成「按显示预算一层层读」。
- 两张新表都是从版本表**派生**的：可以后台补建、可以对照校验、不行就删掉回到今天的读法。所以前四个 PR 没有不可逆的步骤。
- 没采用的方向：整棵树做成不可变结构、每次提交复制到根的那条路径（Git、Dolt 的做法）——每改一个块要写 15–18 KB，是现在的 30 倍，而且「这个块谁改过」「全文搜索」「在 SQL 里过滤」都得另建一套；纯操作日志加快照——快照只能按子树切，等于把「页」换个名字请回来。

---

## 1. 做完之后读者看到什么

- **拖动、移动不再有「跨页 2000 块」的上限。** 把一整页（哪怕几万块）拖到另一页的某个块下面，是一次提交，立刻完成。
- **时间轴可以开在任何一个块上。** 聚焦到某个块，底部的时间线就是「动过这个块或它下面任何内容的提交」，不再只有「这一页的历史」。拖动时间轴时，屏幕上展开的那部分跟着变；没展开的部分不读。
- **很大的顶层块也能看历史。** 今天超过 10,000 块的页整页读不出来；改完后树是一层层读的，没有「这页太大」这回事，只有「一次显示多少块」的预算（现状 800，最多 2000）。
- **两个时刻之间改了什么**：对任何子树都能比较（今天只有计划有 diff，而且是读两遍整页）。
- **把一个块或一棵子树恢复到某个时刻**：今天只有「撤销某一次提交」；有了便宜的比较之后，可以做「把这棵子树恢复成那时的样子」，仍然是一次新的补偿提交，不改写历史（第 6 节 H4；问题 1 的选项 C 是不做这一组）。
- **不变的**：每个块自己的历史、出处（谁、哪个代理、哪条消息写的）、撤销提交的规则、搜索、权限。
- **仍然看得见的限制**见 3.4。

## 2. 现在的做法（要点；细节和文件位置在附录 A）

- 三张表：`outline_commits`（每次写入一行）、`outline_blocks`（每个块的当前状态，含已删除的）、`outline_block_versions`（只追加的版本，主键 `(block_id, from_seq)`，区间 `[from_seq, to_seq)`，当前版本 `to_seq` 为空）。
- 每行版本存的是**整块内容的完整副本**（不是差异），外加父块、排序键、任务、别名、内容哈希和一个「这次改了什么」的位标记。实测每个版本连索引约 460 字节（合成数据，内容平均约 130 字节）。
- 按时刻读一页 = 索引 `(page_id, from_seq, to_seq)` 上的一次范围扫描。**它的耗时和「这一页累计有多少版本」成正比，不是和「这一页有多少块」成正比**：扫的是这一页所有 `from_seq ≤ T` 的版本。所以一页里有几个被反复输入的块就会拖慢整页（实测：60 块、5 万个版本的页，读一次 3.3–3.9 ms，和读一个 500 块的普通页差不多）；库比缓存大之后也更慢（100 万块的空间里，2000 块的页 p50 22.5 ms / p95 30 ms，不是 P0 基准的 8–10 ms）。
- 为了让这个查询成立：删除子树给每个后代写一行墓碑；换页给每个后代写一行新版本；一次提交最多 2000 行。
- 没有任何保留或压缩策略：版本只增不减（D3：共享空间的历史永久保留）。
- 依赖 `page_id` 的地方很多（约 50 个文件）：按页读结构、页时间线、实时会话把外部提交推回、待确认改动（每页 100 条）、折叠状态、页订阅、页上的未答提问和锁标记、搜索结果和反链里的页标题等。

## 3. 建议的设计

### 3.1 三张表各管什么

```
outline_block_versions   不变。每个块每次改动一行（完整内容）。唯一的事实来源。
                         （page_id 一栏先留着不再维护，最后删掉；见第 5 节）

outline_block_edges      新。「位置」：块在哪个父块下、排序键是什么，从哪个序号到哪个序号。
  parent_key  父块 id；顶层块填空间 id（这样「空间」就是树根，顶层块不再特殊）
  block_id, from_seq, to_seq（空 = 现在仍然如此）, order_key
  主键 (parent_key, block_id, from_seq)；另一个索引 (block_id, from_seq)
  只在创建、移动、换顺序、删除、恢复时写；改内容、改任务不写。

outline_subtree_changes  新。「变动」：(ancestor_id, seq)。
  一次提交里每个被改的块，它改动前、改动后的每一个祖先各记一行（同一提交内去重）。
  主键 (ancestor_id, seq)。
```

- SQLite 上两张新表都建成 `WITHOUT ROWID`（行直接按主键排在一棵 B 树里，不另存一份行号索引），实测位置表每行 67 + 59 字节，变动表每行 34 字节。
- **为什么位置要单独一张表**，而不是只给版本表加一个 `(parent_id, from_seq, to_seq)` 索引（那样连表都不用加）：改字也会产生版本行，所以那个索引里一个父块下面挂着「子块数 × 每块版本数」条记录。实测在 10,000 块的页上取前 50 个子块要 7.3 ms（位置表 0.6 ms），被反复输入的 50 个子块 3.2 ms（位置表 0.23 ms），PostgreSQL 上整棵子树递归比今天慢 2.3–3.3 倍。位置很少变，单独存，读的时候就不受内容版本数量的影响。
- 当前状态仍然读 `outline_blocks`（它的 `(space_id, parent_id, order_key)` 索引已经有了）。

### 3.2 必须成立的事

1. 版本表仍是只追加的事实来源；每个块恰好一个未关闭的版本（现有不变式 4，不变）。
2. 每个块在任一序号上至多有一条有效的位置；活着的块未关闭的那条位置等于它当前行的父块和排序键。
3. 位置表和变动表都能**只凭版本表重算出同样的结果**（按序号重放）。所以它们可以后台补建、可以抽查对照、坏了可以重建。
4. 变动表的保证：一次提交改了块 b，那么 b 在改动前和改动后的每个祖先都有一行。于是：**某个块 X 在 (T1, T2] 里既没有自己的版本、也没有变动行 ⇒ X 这棵子树在 T1 和 T2 完全一样。**（证明思路：子树里任何一块变了，要么它当时还在 X 下面——那一刻 X 是它的祖先；要么它之前已经离开——离开的那次移动记在 X 上。）
5. 不成环、深度有上限（现有检查，不变）。
6. 新表的行和版本行在**同一个事务**里写入；一个空间在补建完成并标记之前，读取走今天的按页路径。

### 3.3 每种操作怎么做、多快

数字是 SQLite（`bun:sqlite`，应用自己的连接参数）上 100 万块、1004 万个版本、415 万次提交的合成空间的中位数；括号里是 p95。方法和全部数字见附录 D。「n」= 子树块数，「k」= 要显示的块数，「d」= 深度，「Δ」= 两个时刻之间变过的块数。

| 操作 | 今天 | 建议的做法 | 实测（今天 → 建议） |
|---|---|---|---|
| ① 某时刻的子块 / 可见范围 | 读整页结构，O(页的累计版本数) | 位置表按父块查，再按块取那一刻的版本；O(该父块下出现过的子块 + k·log) | 50 块：2.5 / 25 / 93 ms（500 / 2000 / 10,000 块的页）→ 0.3–0.6 ms（0.5–0.7） |
| ① 某时刻的一屏（800 块，带内容） | 整页结构 + 800 块内容 | 广度优先递归，到预算就停 | 22 / 96 / 784 ms + 2.7 ms → 6–12 ms（8–15），和子树大小无关 |
| ① 某时刻的整棵子树（只要结构） | 一次范围扫描 | 递归；每块一次位置查找 + 一次版本查找 | 2000 块：22.5 → 25.5 ms；1 万块：96 → 132 ms；10 万块：784 → 1108 ms（**持平或略慢**） |
| ② 拖动时间轴 | 每动一下重读整页 | 相邻提交：读这次提交写的版本，只应用到已展开的父块；跳得远：重读可见范围 | 一次提交的版本：0.02 ms；重读 50 块 0.3–0.6 ms |
| ③ 两个时刻的差异 | 读两遍整页再比（只有计划用） | 从根往下，只进入有变动行的子块；O(变过的路径上的子块数)。子树特别大时改用「取这段提交写的版本，逐个往上找它属不属于这棵子树」，O(这段时间空间里的改动数 × d) | 相隔 1000 次提交。2000 块：43 → 1.7 ms；1 万块：191 → 15 ms；10 万块：1540 → 50 ms（第二种做法；第一种 158 ms） |
| ④ 一个块的历史 | 主键范围扫描 | 不变 | 0.16 ms（50 个版本） |
| ⑤ 恢复到某时刻 | 只有「撤销一次提交」 | ③ 得到差异 → 生成反向操作 → 走普通写入（现有的补偿模式），一次提交最多 2000 行，超过就分批 | 读的部分同 ③；写的部分同普通提交 |
| ⑥ 空间自 T 以来改了什么 | 提交范围 → 按提交索引取版本（汇报已经这样做） | 不变；要限定在某棵子树时用变动表 | 没有单独测（包含在 ③ 第二种做法的 50 ms 里） |
| 任意块的时间线（最近 50 次） | 只有页有；`(page_id, from_seq)` | 变动表 `(ancestor_id, seq)` 倒序 + 这个块自己的版本 | 0.01–0.02 ms → 0.01–0.02 ms |
| ⑦ 移动子树到别处 | 每个后代：关一行、写一行、改一行当前状态；超过 2000 行拒绝 | 1 行版本、关 1 条位置、开 1 条位置、两条祖先链各几行变动；O(d) | 2000 块：0.24–2 s → 0.2–0.7 ms；2 万块：2–6.5 s → 0.3 ms；10 万块：18.7 s → 0.3 ms |
| ⑦ 删除 / 恢复大子树 | 每个后代一行墓碑；超过 2000 行拒绝 | 见问题 2：先只关根的位置（树上立刻消失），后代的「已删除」标记后台分批补 | 未测 |
| ⑧ 子树下的统计（进行中的任务数等），现在 | 按页或按空间的部分索引 | 小子树直接走一遍；大子树「先从部分索引拿候选，再逐个往上确认在不在这棵子树里」；真要常驻显示再加沿祖先维护的计数 | 走一遍：2000 块 4.7 ms，1 万块 42 ms，10 万块 428 ms（所以大子树不能走一遍） |
| ⑧ 同上，某时刻 | 无 | 按预算读那一刻的子树再数；超预算的标「至少」 | 同 ① |
| ⑨ 在 SQL 里先过滤权限再 LIMIT | 权限按空间，`space_id IN (…)` | 不变。位置表和变动表里的 id 都属于一个空间。**如果以后要做子树级权限，就得逐条往上查祖先，不能在一条 SQL 里先过滤**——这是这套设计明确不解决的事 | — |
| ⑩ 保留与压缩 | 没有 | 见问题 3；新表是派生的，跟着版本表一起清 | — |
| 普通的一块内容提交 | 0.105 ms | 多写变动行 | 0.105 → 0.15 ms（平均 2.7 行） |
| 当前状态读整棵子树（不看历史） | `page_id` 索引 | 递归走子块索引；或同样按预算读 | 2000 块：2.9 → 8.5 ms；1 万块：12.8 → 72 ms；**前 800 块：3–8.5 ms** |

要点：

- **变快的是「只看一部分」和「只看变了的」**，这正是超大树上唯一行得通的读法；「一次读完整棵」哪种方案都是线性的。
- 「整棵读完」没有变快的原因：今天的结构行里带着任务和别名（判断「事实/过程」视图要用），新做法得为每个块再查一次版本行。只要位置（id、父、顺序）的话是 5.6 / 50 / 375 ms，比今天快 2–4 倍。如果以后发现整棵读是热点，可以把「是不是任务」这一位放进位置表（任务状态变了不用写，只有「变成/不再是任务」才写）。
- 递归查询必须**钉住连接顺序**。原型里有一次 SQLite 自己把顺序反过来，变成扫整张版本表，慢了 10–20 倍（附录 C 有写法）。要有一个检查查询计划的测试守着。

### 3.4 还剩下的限制，来自哪里

| 限制 | 来自哪里 | 读者什么时候碰到 |
|---|---|---|
| 一次显示的块数（800，最多 2000） | 浏览器排版和一次响应的大小（上一份研究实测过） | 展开很多内容时，其余显示「还有 N 块」 |
| 一个父块最多 10,000 个子块 | 兄弟之间要排序；读子块时要看过这个父块下出现过的所有位置 | 极少；批量导入成一层时 |
| 深度 1000；很深的链上每次提交要写「深度」那么多变动行 | 变动表按祖先记 | 几乎碰不到；合成数据里故意放了 150 层的链，平均每次提交仍只有 5–7 行 |
| 一次提交最多 2000 行 | 写入是主线程上的一个同步事务 | 一次改动 2000 个以上不同的块（移动不算，移动只有 1 行） |
| 删除、恢复很大的子树要后台收尾 | 当前状态里每个块都有搜索索引、别名、链接、任务认领要动，这些省不掉 | 删一棵几万块的子树后几秒内，搜索里可能还搜得到它（问题 2） |
| 整棵导出、对整棵子树做某时刻的统计，仍然和子树大小成正比 | 没有不读就能知道的办法（除非为每种统计维护计数） | 对 10 万块的子树做这些事要等几百毫秒到一秒，放读线程 |
| 被输入上万次的块，历史要翻页 | 每次提交一行完整内容 | 看这个块的历史时 |
| 历史只增不减 | D3 | 存储页上看得到（问题 3） |
| 跨空间移动仍是「复制再删除」 | 序号和历史按空间（上一份研究的问题 2） | 不变 |

### 3.5 主线程

- 位置和变动的写入在提交的同一个同步事务里，都是有索引的小插入；实测每次提交多 0.05 ms。
- 读：按父块读一层、按预算读一屏都是「小、快、有索引、有上限」，留在主线程（0.3–12 ms）。**超过 2000 行的递归读取**（整棵 1 万块 50–130 ms）和大子树的比较，走现有的读线程池，和今天「超过 2000 块的页走读线程」同一条规则。读线程不可用时明确失败，不回主线程重读。
- 补建和删除收尾是后台任务：每个事务不超过 2000 行，事务之间让出；可取消；有进度水位，重启后接着做。
- 新读取都带 `LIMIT`；没有新的无上限 `.all()`。

## 4. 为什么不是别的方案

| | A 版本行上加父块索引 | **A′+B 位置表 + 变动表（建议）** | C 不可变树、复制到根的路径 | D 操作日志 + 快照 | E 系统自动切块 |
|---|---|---|---|---|---|
| 是什么 | 现有版本行已经有 `parent_id`，只加索引 `(parent_id, from_seq, to_seq)` | 3.1 | 节点不可变、按内容哈希寻址；每次提交从改动处到根新写一条路径；提交指向根 | 历史 = 按序的操作；读某时刻 = 最近的快照 + 重放 | 版本行上的 `page_id` 换成系统管的「块组」id，块组太大就分裂、太小就合并，像 B 树的节点 |
| 移动大子树 | 1 行 | 1 行 + 几行变动 | O(深度) 个节点 | 1 个操作 | 子树根所在的那一组要重写（≤ 组大小），其余按指针走 |
| 某时刻的 50 块 | 0.4–7.3 ms（父块下版本越多越慢） | 0.3–0.6 ms | 从那次提交的根往下几次查找，很快 | 快照在不在这附近；否则重放 | 读一组，和今天读一页一样 |
| 某时刻的整棵 | 比今天慢 1.1–3.3 倍 | 持平 | 快（顺着哈希读） | 快照 + 重放 | 和今天一样 |
| 两时刻比较 | 读两遍 | 只走变过的路径 | **最好**：哈希相同的子树直接跳过 | 重放区间里的操作 | 读两遍 |
| 每块的历史、「谁改过这块」 | 主键扫描 | 主键扫描 | **没有现成的**：要沿提交一个个比，或另建索引 | 另建索引 | 主键扫描 |
| 全文搜索、任务索引、SQL 里过滤 | 不受影响 | 不受影响 | 都要另外维护一份「当前状态」表，等于两套存储 | 同左 | 不受影响 |
| 每次改一个块写多少 | 约 0.5 KB | 约 0.6 KB | **15–18 KB**（子块列表也分块存时；整存是 55–233 KB） | 约 0.2 KB + 周期性快照 | 约 0.5 KB + 分裂时重写一组 |
| 从今天迁移 | 加一个索引 | 加两张派生表，后台补建，可删 | 全部重写 | 全部重写 | 重写版本行的分组，分裂合并是新逻辑 |
| 主要问题 | 热块拖慢它的兄弟；PostgreSQL 上递归慢 | 占用 +12%（PG +49%）；整棵读不变快 | 写放大；两套存储；和现有写入路径（别名、认领、锁、待确认都在关系表上检查）不合 | 快照只能按子树切 → 又是「页」；重放时间没有上界，除非快照够密 | 把「页」换成看不见的「组」，写放大和边界逻辑都还在；读整组仍和组内累计版本数成正比 |

- **C 的长处（比较最快、快照免费）我们用变动表拿到了大部分**：变动表就是「这棵子树的指纹变没变」的关系表写法，只是按序号记，不按哈希记。C 的短处（每块历史、搜索、SQL 过滤、写放大）正好是这个产品天天用的东西。
- **D 其实已经有了一半**：版本表按提交索引（`idx_outline_versions_commit`）就是一份操作日志，「相邻两次提交之间变了什么」直接读它。缺的只是快照，而有了按父块的位置区间之后不需要快照——任何时刻都能直接读。
- **E** 在这份数据上没有读的好处：今天按页扫描的耗时来自「累计版本数」，自动切块不改变这一点；位置表的递归只读位置，已经比按页扫描快 2–4 倍。
- 还看过、没采用的：嵌套集合 / 嵌套区间 / 物化路径 / 闭包表（移动子树都要改 O(子树) 行甚至更多，见附录 B）；SQLite 的 R 树模块存区间（要整数 id，要多一张虚表，而位置表已经把热块的问题解决了）；PostgreSQL 的 GiST 区间索引（实测能解决热块：4.9 → 0.41 ms，但索引是 B 树的两倍大、建了 39 秒，而且 SQLite 没有对应物）。

## 5. 迁移

全程在线，不停服；前三步随时可以退回。

1. **加表，双写。** 两张新表用规定流程生成迁移（SQLite：`schema.ts` → `db:generate`；PG：转译 → `db:generate:pg`）。提交时在同一个事务里写位置和变动。`outline_spaces` 加一个「历史索引建到哪个序号」的水位。
2. **后台补建。** 每个空间按序号从头重放版本（按提交索引读，每个事务不超过 2000 行），写出位置和变动；追上最新提交后，在这个空间的写入通道里做最后一小段并标记「就绪」。没就绪的空间照旧按页读。规模参考：100 万块的空间要写 146 万条位置、2785 万条变动（没有单独测补建耗时；生成这份合成数据连同所有表用了 10 分钟，补建应在这个量级以内，在读线程/子进程里做）。
3. **读取切过去，带对照。** 按时刻读、时间线、比较改走新表；一段时间内抽样把新旧两种读法的结果比一遍（测试里是全量比，线上是抽样、只记日志）。
4. **移动不再改页。** 写入路径不再给后代写「只改了页」的版本；`outline_blocks.page_id` 降级成「顶层祖先」的缓存（像现有的 `in_process`：2000 行以内随提交更新，更大的由后台补，补完之前按页读当前状态的地方退回递归读取）。跨页 2000 块的上限取消。**这一步之后新写的版本行 `page_id` 不再可信，按页读历史的旧路径对新数据失效**——所以它必须在第 3 步稳定之后做。要退回，得用重放把 `page_id` 补写回去（做得到，但贵）。
5. **逐个把用 `page_id` 的地方改掉**（待确认改动、折叠状态、页订阅、提问和锁的列表……各自一个小 PR），最后删掉版本表上的 `page_id` 索引（省回约 9% 的历史占用），再删列。
6. 大纲的表目前不在数据导入导出的固定表清单里（`data-portability.ts`），所以导入导出不用动；将来若纳入，两张新表不必导出，导入后重建即可。

## 6. 分步计划

每个 PR 单独可合、可回退，非测试代码不超过约 2,500 行。H1–H3 读者看不到变化。

| PR | 内容 | 约行数 | 验收 | 回退 |
|---|---|---|---|---|
| H1 | 位置表：表结构、提交时双写、按序号重放的补建任务和水位；一个「对照器」：随机生成几千次提交（含移动、删除、恢复、撤销），断言位置表读出的每个时刻的树和按页读出的一样 | 1,900 | 对照器在两种存储上通过；补建中断后能续 | 删表、删水位 |
| H2 | 变动表：双写、补建；任意块的时间线接口（`/blocks/:id/commits`）；对照：页的时间线两种算法结果一致 | 1,400 | 同上；不变式 4 的性质测试（没有变动行的子树两个时刻逐块相同） | 删表 |
| H3 | 读取：按父块读一层、按预算读一屏（当前和某时刻）；`OutlineRead` 的按时刻读在就绪的空间改走新路径；查询计划守卫测试；超过 2000 行走读线程；线上抽样对照 | 2,200 | 现有按时刻读的全部测试原样通过；新增大页（> 10,000 块）按时刻读一屏 | 开关关掉回到按页读 |
| H4a | 服务端：任意子树的比较（把计划 diff 的做法推广，按变动表剪枝）；「恢复到某时刻」生成补偿提交（复用撤销的规划器） | 2,000 | 比较结果和「读两遍再比」一致；恢复后再比较为空；被后来改动挡住的块按现有撤销规则报告 | 独立，直接回退 |
| H4b | 界面：聚焦到任何块都有时间轴；拖动时只更新展开的部分；比较视图；恢复按钮；中英文 | 2,000 | 浏览器测试：在非页的块上回放；360 px、暗色 | 独立 |
| H5 | 移动只写 1 行：不再写「只改了页」的版本；`page_id` 变成缓存 + 后台补；取消跨页 2000 块上限；实时会话推回外部提交时按「父块在不在已加载范围」判断移入移出 | 2,300 | 移动 5 万块的子树一次提交、主线程阻塞 < 5 ms；撤销这次移动；会话里别人看到的是移动 | 见第 5 节第 4 步 |
| H6 | 树和编辑器的加载改成按父块一层层读（当前状态）；去掉「顶层块 10,000 块」的读取上限 | 2,200 | 20 万块的顶层块能打开、能展开、能看历史 | 开关 |
| H7 | 大子树删除/恢复：先关根、后台收尾（若问题 2 选 A） | 2,000 | 删除 5 万块：树上立刻消失；收尾完成前搜索结果不出现已删内容；恢复后和删除前逐块相同 | 开关回到「每个后代一行墓碑、2000 行上限」 |
| H8 | 保留策略（若问题 3 选做）和存储页上的历史用量 | 1,500 | 合并后任何保留下来的时刻读出的树不变 | 策略默认关 |
| H9 | 逐个改掉用 `page_id` 的地方；删索引、删列 | 多个小 PR | 守卫测试全仓搜旧路径 | — |

## 7. 风险（按大小排）和放弃条件

1. **双写的两张表和版本表对不上，历史悄悄读错。** 这是最要紧的。对策：对照器（H1）、线上抽样对照（H3）、重放重建就是修复手段。**放弃条件：H3 的对照在真实数据上出现修不掉的不一致 → 停在按页读，两张表删掉，没有任何数据损失。**
2. **递归查询被数据库换了连接顺序而变慢**（原型里实际发生过）。对策：写法钉死顺序、查询计划守卫测试、两种存储各测。
3. **主线程被大读取占住。** 对策：预算和「超过 2000 行走读线程」的硬规则；没有例外。
4. **变动表比预想的大。** 合成数据：普通的一块提交 2.7 行，全部提交平均 5.4–6.7 行（因为有一次改几十块的提交和很深的链）；SQLite 每行 34 字节，PG 每行约 105 字节。**放弃条件：真实空间里中位数超过每次提交 10 行，或 PG 上历史占用增加超过一倍 → 变动表只保留「时间线」用途所需的最上面几层祖先，比较改用按提交范围的做法（第 3.3 节 ③ 的第二种，50 ms 量级，不依赖变动表）。**
5. **当前状态的整页读取变慢 3 倍**（如果在 H6 之前就不用 `page_id`）。对策：`page_id` 缓存留到 H6 之后。
6. **「先关根」的删除改变了「活着」的定义**（从「每个块自己标着」变成「顺着位置能走到根」）。这是改动面最大的一步，放在最后，可以不做。
7. **补建在大库上要跑很久**，期间读线程有额外负载。可暂停、限速。
8. **深链**：1000 层的链上每次提交 1000 行变动。计入每次提交 2000 行的预算；超了拒绝并说明。

## 8. 和实时编辑改造（D56 研究，方案 B′）怎么配合

- **互不阻塞的部分**：H1–H4 只动存储和读取，不碰实时协议；B′ 的 P1（文字按块）、P2（一空间一会话）不碰历史。可以并行。
- **B′ 里因为「历史不改」而留下的两条限制，做完这里就没了**：
  - 「一次跨页移动的子树超过 2000 块 → 拒绝」：H5 之后没有。
  - 「单个顶层块超过 10,000 块 → 只读」：H6 之后没有。
- **B′ 的「加载按顶层块整块进出」建议改成「按父块整层进出」**：客户端要么有某个父块的全部活着的子块，要么没有。于是「一个操作发不发给某人」只看它涉及的父块在不在那人的已加载集合里；移进来的子树不用整棵带上（只带那一块和「下面还有多少」），所以不需要 2000 行的上限。服务端的镜像相应地是「已加载的父块」而不是「已加载的页」。**建议 B′ 的 P2/P3 在定协议时就把 `watch` 的对象定成块 id（任何块），哪怕第一版客户端只传顶层块**，这样 H6 不用再改协议。
- **会话把外部提交推回时**（`session.ts` `applyVersions`）今天靠后代身上「只改了页」的版本来发现「移出/移入这一页」；H5 之后没有这些行，要按父块判断。这一处是 H5 和 B′ P2 的交点，H5 排在 P2 之后。
- **文字按块、安静 2 秒提交**：每次文字提交仍是一行内容版本；被长时间输入的块版本很多，位置表使它不再拖慢兄弟块的读取；这些细碎版本是否合并是问题 3。
- **懒加载子树**和时间轴用同一个接口（按父块读一层，带不带「某时刻」只差一个参数）。

## 9. 负责人要定的事

**问题 1　这件事和实时编辑改造的先后**

背景：历史这边约 9 个 PR、1.75 万行左右；前三个（H1–H3，约 5,500 行）读者看不到变化，只是把地基换好。实时编辑改造（B′）约 9 个 PR、1.5 万行，也有三个看不到变化的。两边在 H5 / P2 处交汇。

例子：现在把一个 3,000 块的章节拖到另一页会被拒绝；一个 12,000 块的页打不开历史。

- **A（建议）**：H1–H3 现在就做，和 B′ 的 P1–P3 并行（改的文件不重叠：一边是存储和读取，一边是实时会话）；H5（移动 1 行）排在 B′ P2 之后；H4（任意块的时间轴、比较、恢复）可以在 B′ 之前就上线，是这条线上最早能看见的东西。
- B：先做完 B′ 再做历史。树里能编辑得早；但 B′ 会带着「跨页 2000 块」「顶层块 10,000 块」两条限制上线，之后再改一次协议（加载单位从页改成父块）。
- C：只做 H1–H3 + H5（约 7,800 行），不做任意块的时间轴、比较、恢复和懒加载。最省；限制去掉了，但读者得不到新的历史功能，超大顶层块仍然打不开。

**问题 2　删除一棵很大的子树时怎么办**

背景：移动可以只写 1 行，删除不行——每个被删的块都要从搜索、别名、链接、任务认领里退出来，这些是逐块的。今天的做法是给每个后代写一行墓碑，超过 2000 行就拒绝。

例子：读者删掉一个导入进来的、有 30,000 块的旧文档。

- **A（建议）**：先关掉根的位置——树上、时间机器里它立刻整棵消失，恢复也只要重新打开这一条，整棵原样回来；后代的「已删除」标记由后台几秒内分批补上。补完之前，搜索和任务列表对结果多做一步「它的祖先还在不在」的检查。代价：「活着」的定义变了，是整个计划里改动面最大的一步（H7），放最后。
- B：保持今天的做法，上限仍是 2000 块，超过就请读者分几次删。零风险；但「移动没有上限、删除有上限」很难向读者解释。
- C：后台任务分批删，每批一次提交（30,000 块 = 15 次提交），界面显示「正在删除」。不改「活着」的定义；但时间线上多出一串提交，撤销要撤 15 次，中途失败会留下删了一半的子树。

**问题 3　历史要不要瘦身**

背景：每改一次留一份完整内容，永久保留（D3）。实测每个版本连索引约 0.46 KB，每次提交另有约 0.24 KB；100 万块、每块平均改 10 次的空间，历史约 5 GB。实时输入「安静 2 秒就提交」，一个人写一小时会给同一块留下几百个只差几个字的版本。

例子：一个块被人连续改了 400 次，三个月后有人打开它的历史。

- **A（建议）**：先不删任何东西，只在存储页上显示每个空间的历史占用（随 H8）；同时把规则定下来备用——「同一个人、同一个块、相邻提交间隔不到 5 分钟、只改了文字」的一串版本，30 天后合并成一个（保留最后一版的内容和首尾时间），别人的改动、结构改动、被待确认改动或计划引用的版本永不合并。等真实占用到了让人在意的程度再打开。
- B：现在就按上面的规则合并。占用最省；但 D3 的「永久保留」变成「30 天内逐字保留，之后按段保留」，要向用户说明，而且合并不可逆。
- C：永远不合并，写进文档。最简单；长期占用只增不减，大库的备份和补建会越来越慢。

**问题 4　「页」这个词在产品里留不留**

背景：做完之后，存储和历史里不再有「页」；任何块都能聚焦、有自己的时间轴、能比较和恢复。但界面上很多东西还按顶层块分组：树里的页行、地址、快速切换、「这一页的历史」、待确认改动（每页 100 条）、折叠状态（每人每页一份）。

例子：读者把一个二级标题拖成顶层块，又把一整页拖到另一页下面。

- **A（建议）**：留着这个词，含义改成「顶层块」，只是个称呼：凡是顶层的就叫页、列在页列表里；历史、比较、恢复、时间轴对任何块都一样，不再说「这一页的历史」而说「这里的历史」。待确认改动的名额、折叠状态改成按空间或按块记（H9 里各一个小 PR）。读者几乎不用重新学。
- B：界面上也不再提「页」，统一叫「块」，空间下面直接是块。概念最干净；但地址、快速切换、导入、代理工具的说明（`OutlineRead` 里到处是 page）都要改，读者和代理都要重新适应。
- C：保留页作为特殊的块（比如只有页能有别名、只有页出现在快速切换里），但不再是边界。最接近现状；留下「把块拖成顶层时它算不算页」这类要逐条回答的问题。

---

## 附录 A　现状细节（origin/main 9bb31f88）

**表（`server/db/schema.ts`，约 5749–5973 行）**

- `outline_spaces`：`next_seq` 是提交计数器，提交时在同一事务里「认领并加一」（不是 MAX+1），按旧值规划的写入会在认领时被挡回；`last_commit_at`；`in_process_ready` / `in_process_epoch`（派生缓存的后台重建标记）。
- `outline_commits`：`(space_id, seq)` 唯一；`kind`（edit / revert / import / confirm / answer / plan）；`actor_kind` / `actor_id` / `responsible_user_id` / `narrator_id` / `message_id` / `tool_call_id`（出处，故意不设外键）；`summary`。索引 `(space_id, narrator_id, seq)`。
- `outline_blocks`：当前状态，删除的块也留行。`parent_id`、`page_id`（顶层祖先，活块必须正确）、`order_key`（分数排序键，按字节序）、`content`、`content_hash`（SHA-256 十六进制，64 字符）、`alias`、`task_json`、`ask_json`、`author_*`、`version_seq`、`deleted`、`in_process`（派生缓存，不进版本）。索引：`(space_id, sid)` 唯一、别名部分唯一、`(page_id)`、`(space_id, parent_id, order_key)`、若干任务的部分索引、`(page_id)` 上的锁部分索引。
- `outline_block_versions`：主键 `(block_id, from_seq)`；`to_seq`（空 = 当前）、`commit_id`、`page_id`、`parent_id`、`order_key`、`content`（完整内容；墓碑不存内容）、`task_json`、`ask_json`、`alias`、`content_hash`、`change_flags`、`deleted`。索引 `idx_outline_versions_page_range (page_id, from_seq, to_seq)`（注释：不带 `to_seq` 按时刻读页慢约 3 倍）、`idx_outline_versions_commit (commit_id)`。
- `outline_links`：块发出的链接，同样带 `[from_seq, to_seq)`。
- `change_flags`（`server/services/outline/model.ts` `OUTLINE_CHANGE`）：CREATE 1、CONTENT 2、MOVE 4、DELETE 8、RESTORE 16、TASK 32、PAGE 64、PROPS 128、MERGE 256、ASK 512。

**写入（`write.ts`、`store/sqlite-store.ts` `applyCommitSection`）**

- 一次提交是一个严格同步的事务：认领序号 → 插提交行 → `UPDATE … SET to_seq = seq WHERE block_id IN (…) AND to_seq IS NULL` 关旧版本 → 改当前行 → `INSERT INTO outline_block_versions SELECT … FROM outline_blocks WHERE id IN (…)` 从当前行抄出新版本 → 链接、认领、待确认。
- 移动（`write.ts` `move`）：换页时 `liveSubtree` 取出全部活着的后代，逐个改 `pageId`，于是每个后代一行带 PAGE 标记的版本。删除（`delete`）：整棵活子树每块一行墓碑。恢复（`restore`）：只恢复这一块，页重新算；撤销一次删除时由 `revert.ts` 逐块恢复。
- 上限（`OUTLINE_LIMITS`）：一次事务 200 个操作、16 KiB / 块、128 KiB / 事务、**2000 行**（版本 + 链接 + 认领）、每个父块 10,000 个子块、深度 1000、读一页 10,000 块。

**读取（`read.ts`、`store/sqlite-read.ts`、`store/postgres-read.ts`）**

- 步骤：定位块（按时刻读时先取它那一刻的版本，得到当时的页）→ 一条语句读这一页的**结构**（不含内容）→ 内存里建树、截出子树、按视图和预算广度优先排出要显示的块 → 只为这些块按「(块, 版本序号)」取内容（每条语句最多 250 个键，`bodyChunk` 100）→ 渲染。
- 按时刻的结构语句：`… FROM outline_block_versions v JOIN outline_blocks b … WHERE v.page_id = ? AND v.from_seq <= ? AND (v.to_seq IS NULL OR v.to_seq > ?) AND v.deleted = 0 LIMIT ? OFFSET ?`。2000 行以内在主线程（`MAIN_THREAD_PAGE_ROWS`），更多的重读一遍放读线程（最多 10,000 行，`SELECT_ROWS_MAX_ROWS`）；读线程不可用就失败。
- 时间线（`readPageTimeline`，`GET /spaces/:spaceId/pages/:pageId/commits`）：`listPageSeqs` 取这一页「开始于」的不同序号（最新 51 个），再取这一窗口里「结束于且没有后继」的序号（移走的块），合并；每页 50，最多 200；两条都走读线程。
- 每块历史（`GET …/blocks/:blockId/history`，`views.ts` `readBlockHistory`）：主键倒序，每页 50。
- 比较：只有计划有（`plan-diff.ts`，`GET …/plans/:blockId/diff`）：读两遍子树（各一次整页结构），按块 id 比；子树最多 2000 块，列出最多 200 个变化。
- 撤销（`revert.ts`，`POST /commits/:commitId/revert`）：对某次提交写的每个版本，和它之前的版本比，生成反向操作，经 `writeOutline` 的补偿模式写成一次 `revert` 提交；被后来改过的、父块没了的、会成环的、后来有了别人子块的，跳过并报告。**没有「恢复到某时刻」，只有「撤销某一次提交」。**
- 「某个时间对应哪个序号」（`commitSeqAt`）：对提交的时间做二分。
- 汇报（`digest.ts`、`store/sqlite-digest.ts`）：按 `(space_id, seq)` 取提交范围，再按提交索引取版本（不含内容）；每个空间每次最多 2000 次提交、5000 个版本。
- 待确认改动（`pending.ts`，`outline_pending.page_id`，部分索引 `idx_outline_pending_page_open`）：每页最多 100 条未决；块换页时跟着改（`checkRepage`）。
- 全文搜索（`server/db/fts.ts`）：`outline_blocks_fts` 只索引**当前**内容（trigram），触发器同步；历史内容不可搜。
- 保留 / 压缩：没有（只有汇报和「已读」记录有清理）。

**用到 `page_id` 的查询**（`store/port.ts`、`read-port.ts` 及两个实现）

`listPageStructure`（当前 / 按时刻）、`listPagesStructure`、`listPageBlocks`（实时会话开页）、`listPageVersions`（会话推回外部提交）、`listPageSeqs`（时间线）、`listBlockHistory` 返回的 `pageId`、`listOpenPendingByPage` / `countOpenPendingByPage` / `listUnreportedPending`、`listOpenQuestionBlocksOnPage`、`listLockedBlocks`、任务列表里按页排除（`notInArray(page_id)`）、搜索结果行、提交计划里的 `repage`；以及服务层的 `OutlinePageState`、`OutlineReadResult.pageId`、页订阅（`outline-page-ws.ts`）、`outline_view_state.page_block_id`、实时会话和日志表。

**每次编辑的存储增长**（合成数据实测，SQLite；内容平均约 130 字节）

| | 字节 / 行 |
|---|---|
| 版本行（含 64 字符哈希、三个 21 字符 id） | 344–347 |
| 版本主键索引 / 页索引 / 提交索引 | 38 / 42 / 34 |
| 提交行 + 两个索引 | 171 + 约 70 |
| 合计：改一个块的一次提交 | 约 0.7 KB |

## 附录 B　文献与实践，以及放到这里意味着什么

**时态数据模型**

- SQL:2011 的「系统版本表」（Kulkarni & Michels [1]）：每行带系统时间的起止，`FOR SYSTEM_TIME AS OF` 读某一刻。SQL Server [2]、MariaDB [3] 的实现都是「当前表 + 历史表」。——我们的 `outline_blocks` + `outline_block_versions` 正是这个形状，只是时间用提交序号而不是时钟（更好：没有时钟回拨，区间天然不重叠）。数据仓库的「缓慢变化维度第 2 型」是同一件事。
- 时态索引的综述（Salzberg & Tsotras [4]）和两个经典结构：时间分裂 B 树（Lomet & Salzberg）、多版本 B 树（Becker 等 [5]）。它们解决的是「按键范围 + 时间点」查询的最坏情况，办法是按时间分裂页面并复制仍然有效的记录。——这是引擎内部的结构，SQLite 和 PostgreSQL 都没有；我们能用的是普通 B 树上的 `(键, from, to)`。它的弱点正是实测到的那个：同一个键下历史越长，扫得越多。**把很少变的东西（位置）和经常变的东西（内容）分开存，就是在应用层绕开这个弱点。**
- 关系库里的区间索引：RI 树（Kriegel 等 [6]）把区间树映射到两个 B 树索引上，在普通关系表里做区间相交查询；SQLite 的 R 树模块 [7] 可以把一维区间当矩形存（需要整数主键、是一张虚表）；PostgreSQL 有范围类型 + GiST [8]，配合 `btree_gist` [9] 可以建 `(parent_id, 区间)` 的复合索引和「不重叠」的排除约束，PG 18 起还有 `WITHOUT OVERLAPS` 的时态主键 [10]（搜索结果来自二手资料，未读到官方发布说明原文）。——实测 PG 上 GiST `(parent_id, int4range(from_seq, to_seq))` 确实解决热块问题（4.9 → 0.41 ms），但大小是 B 树的两倍、构建慢，且 SQLite 侧没有等价物（R 树要先把块 id 映射成整数）。位置表在两种存储上用同一种普通索引就够了。排除约束可以在 PG 上作为「同一块的位置区间不重叠」的额外保险，SQLite 上靠写入路径和对照器。

**持久化（不可变）数据结构**

- Driscoll、Sarnak、Sleator、Tarjan [11]：让一个结构保留所有旧版本的两种通用办法——「胖节点」（每个节点里记下每个字段在各个版本的值）和「路径复制」（改一个节点就把到根的路径复制一份）。胖节点改一次只多 O(1) 空间，但读某个版本时每个节点要在自己的版本表里找一次；路径复制读起来和普通结构一样，但每次改动多 O(深度)。——**我们现在的版本区间就是胖节点**，建议的方案仍是胖节点（每块一次「那一刻的版本」查找，实测约 6 微秒）。
- 写时复制的 B 树：LMDB [12]、Btrfs（Rodeh [13]）、ZFS 都是「改一页就把到根的路径重写」，换来免费的快照和崩溃一致性，代价是写放大。
- Merkle 树 / prolly 树：Git [14] 的树对象按内容哈希寻址，重命名或移动目录只改父目录那一个对象，子树的哈希不变所以不用动——这就是 Git 里移动便宜的原因；Dolt [15][16][17] 和 Noms [18] 把表存成按内容分块的 B 树，两个版本的差异计算量正比于差异大小，因为哈希相同的子树直接跳过；Irmin [19] 是同类的 OCaml 库；Fossil [20] 把每个制品存成相对另一个版本的差量；TerminusDB [21] 用只追加的差量层。——比较和快照是它们的强项。弱项也清楚：Dolt 的每行历史要沿提交图逐个比较（官方文章只说「diff 正比于差异大小」，没有给出按行历史的代价；这是我的推断），写一个值要重写一条块路径（我们的估算：15–18 KB / 次）。**我们用变动表拿到了「没变的子树跳过」，没有付路径复制的代价。**
- Datomic [22][23]：每个事实是 (实体, 属性, 值, 事务)，几套覆盖索引各存一份；历史和当前在同一组索引里，按时刻读 = 用当前索引再把晚于那一刻的过滤掉；另有按事务排序的日志，适合取「两个时刻之间的事务」（细节来自非官方的内部机制指南 [23]）。XTDB [24] 是双时态（系统时间 + 有效时间）。——**位置表本质上就是「把父子关系这一个属性单独做成带时间的事实」**，提交索引上的版本表相当于它的日志。我们不需要有效时间（没有「补记过去」的需求）。

**SQL 里的层级，带历史**

- 邻接表 + 递归查询（SQLite [25] 和 PG 都支持）：移动 O(1)，读子树 O(子树) 次查找。物化路径 / PG 的 `ltree` [26]：读子树是一次前缀扫描，移动要改写子树里每一行的路径。嵌套集合（Celko）：读子树是一次范围扫描，插入和移动平均要改半张表的编号；嵌套区间（Tropashko [27]）用有理数避免重新编号，但移动子树仍要重算整棵。闭包表（Karwin [28]）：存每一对（祖先, 后代），读祖先和后代都是一次查找，移动要删加「子树大小 × 祖先数」行。XML 的节点编号：Dewey / ORDPATH [29] 插入不用重编号，但移动子树仍要给整棵重新编号。——**凡是把「祖先信息」写在后代行上的方案，移动都是 O(子树)；今天的 `page_id` 是其中最轻的一种（只记最顶上那个祖先）。要让移动 O(1)，后代行上就不能有任何祖先信息**，于是读子树必须顺着父子关系走，这正是位置表 + 递归。带历史时更是如此：闭包表每一行都要带区间，移动一次要关掉并重开「子树 × 祖先」那么多个区间。
- 兄弟顺序用分数索引（Figma [30]）：在两个键之间生成一个新键，不动别人。现状已是这样（`order_key`）。
- 带版本的树 / XML：Chien、Tsotras、Zaniolo [31] 比较了「存编辑脚本」和「存带时间戳的引用」，并按「页面里还有多少记录有效」来聚簇；XyDiff（Cobena 等 [32]）给节点持久 id 再算差量；Buneman 等的「归档」[33] 把所有版本合并成一棵树，**节点的时间戳默认继承父节点，只有和父节点不同才自己记**。——最后这一条就是问题 2 选项 A 的依据：子树被删时只在根上记，后代不用各记一笔。

**大纲 / 块编辑器 / 协作工具（只写查得到公开资料的）**

- Notion [34][35]：块有向下的 `content`（子块 id 的有序数组）和向上的 `parent` 指针；权限沿 `parent` 往上找；编辑是一组针对单条记录的操作，打包成事务整体提交或拒绝；按工作区分片。**版本历史只在官方文章里出现过一句「保存后服务器可能安排版本历史快照」，怎么存、多久一次没有公开**；页面历史是按页的周期性快照这一点是产品行为，不是我查到的实现说明。
- Figma [36][37]：对象的父链接存在子对象上，和排序位置合成一个属性一起更新（所以移动是原子的、对象身份不变）；服务器拒绝会成环的改父操作；文件每 30–60 秒整份做一次检查点存到 S3，另有一份日志每约 0.5 秒落盘，恢复 = 最近的检查点 + 重放序号更大的日志。官方只说检查点「是某些产品功能的基础」并链接到版本历史的帮助页，**没有说明版本历史具体怎样使用检查点**。——这是「日志 + 整份快照」的典型；它成立是因为一个文件有界（整份装进内存）。我们的空间没有这个上界。
- Google Docs：2010 年的官方博客系列 [38] 讲的是操作变换；「文档是一份修订日志」是该系列的常见转述，**我这次没能读到正文核实，也没有找到官方对快照/检查点做法的说明**。
- Linear [39]：每个事务有一个全局递增的同步序号，客户端记着自己到哪个序号、掉线后取增量。官方只有一个演讲页面；细节来自第三方的逆向分析。——和我们的「空间序号 + 按提交取版本」同构。
- Yjs：文档本身含全部历史；按快照回看旧状态要求关掉垃圾回收（论坛上维护者和用户的说法 [40]，**官方文档页这次没检索到**），而关掉回收后文档的内存、磁盘、传输都明显变差。Automerge [41][42]：存全部改动历史（列式压缩），3.0 之前加载长历史的文档内存会膨胀。——印证上一份研究的结论：静止时块就是「内容 + 版本行」，CRDT 状态只在有人编辑时存在；历史不放在 CRDT 里。
- 可移动树的 CRDT（Kleppmann 等 [43]）：每个移动操作带全局时间戳，副本按时间戳顺序应用；晚到的旧操作要「撤回后来的、应用它、再重做」，会成环的操作在重放时被跳过；为此要保留操作日志（记着每次移动前的父节点）。（算法细节来自我对论文的了解，这次只抓取到摘要页。）——我们由服务端排序，不需要这套；但它说明了一件事：**移动的历史天然是「块 → 旧父、新父、时间」的日志**，位置表正是这个。
- Replicache / Zero [44]：客户端视图 = 服务端状态 + 重放未确认的本地改动；不涉及长期历史。
- Roam、Logseq、Workflowy：Logseq 的数据库版用带持久化的 DataScript（存进 SQLite）[45]；DataScript 是 Datomic 思路的内存实现。**Roam 的服务端存储和历史、Workflowy 的任何实现细节，没有找到权威的公开资料。**

**事件溯源、快照、压缩**

- 事件溯源（Fowler [46]）：状态 = 重放事件；快照用来给重放设上界。重放的上界 = 快照间隔 × 单位时间的事件数；快照的大小 = 状态的大小。——在一棵没有大小上限的树上，快照必须按子树切，切法要么用户定（页）要么系统定（方案 E）；而区间表不需要快照。
- 完整副本 vs 差量：我们每个版本存完整内容，读任何版本一次到位，代价是相似版本重复占空间。差量（Fossil、RCS 风格）省空间但读旧版本要沿链还原。按内容哈希去重在这里收益小：合成数据里 86% 的版本是改内容，哈希本来就不同；真正重复的是「只移动 / 只改任务」的版本（它们把内容又抄了一遍），H5 之后「只改了页」的那一类不再产生。
- 所以瘦身的办法只剩「合并细碎版本」（问题 3），以及把很老的版本内容搬到另一个库文件（分层存储；SQLite 可以 ATTACH，但跨库没有原子提交的便利，暂不建议）。

## 附录 C　SQL

两种存储写法基本一致；不同处单独标出。`:T` 是要读的序号，`:S` 是空间 id。

```sql
-- 表（SQLite）
CREATE TABLE outline_block_edges (
  parent_key TEXT NOT NULL,            -- 父块 id；顶层块为空间 id
  block_id   TEXT NOT NULL,
  from_seq   INTEGER NOT NULL,
  to_seq     INTEGER,
  order_key  TEXT NOT NULL,
  PRIMARY KEY (parent_key, block_id, from_seq)
) WITHOUT ROWID;
CREATE INDEX idx_outline_edges_block ON outline_block_edges (block_id, from_seq);

CREATE TABLE outline_subtree_changes (
  ancestor_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (ancestor_id, seq)
) WITHOUT ROWID;
-- PostgreSQL：同样的列和主键（没有 WITHOUT ROWID）；order_key 用 COLLATE "C"；
-- 可选的保险：EXCLUDE USING gist (block_id WITH =, int4range(from_seq, to_seq) WITH &&)

-- ① 某时刻 X 的子块（一层）
SELECT block_id, order_key FROM outline_block_edges
WHERE parent_key = :X AND from_seq <= :T AND (to_seq IS NULL OR to_seq > :T)
ORDER BY order_key LIMIT :k;
-- 计划：SEARCH e USING PRIMARY KEY (parent_key=?)

-- 某块在某时刻的版本（内容、任务、别名）
SELECT from_seq, alias, task_json, ask_json, content FROM outline_block_versions
WHERE block_id = :B AND from_seq <= :T ORDER BY from_seq DESC LIMIT 1;
-- 计划：SEARCH … USING INDEX 主键 (block_id=? AND from_seq<?)

-- ① 某时刻的子树，广度优先，到预算为止（SQLite；CROSS JOIN 用来钉住连接顺序）
WITH RECURSIVE sub(id, parent_id, order_key) AS (
  SELECT :X, NULL, ''
  UNION ALL
  SELECT e.block_id, e.parent_key, e.order_key
  FROM sub JOIN outline_block_edges e
    ON e.parent_key = sub.id AND e.from_seq <= :T AND (e.to_seq IS NULL OR e.to_seq > :T))
SELECT s.id, s.parent_id, s.order_key, v.alias, v.task_json, v.from_seq
FROM (SELECT * FROM sub LIMIT :budget) s
CROSS JOIN outline_block_versions v
  ON v.block_id = s.id
 AND v.from_seq = (SELECT max(x.from_seq) FROM outline_block_versions x
                   WHERE x.block_id = s.id AND x.from_seq <= :T);
-- PostgreSQL：把最后的连接换成
--   JOIN LATERAL (SELECT alias, task_json, from_seq FROM outline_block_versions v
--                 WHERE v.block_id = s.id AND v.from_seq <= :T
--                 ORDER BY v.from_seq DESC LIMIT 1) v ON true

-- 当前状态的子树（不看历史；列直接带在递归里，避免再连一次）
WITH RECURSIVE sub(id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json) AS (
  SELECT id, sid, parent_id, order_key, alias, task_json, version_seq, ask_json
  FROM outline_blocks WHERE id = :X
  UNION ALL
  SELECT b.id, b.sid, b.parent_id, b.order_key, b.alias, b.task_json, b.version_seq, b.ask_json
  FROM sub JOIN outline_blocks b
    ON b.space_id = :S AND b.parent_id = sub.id AND b.deleted = 0)
SELECT * FROM sub LIMIT :budget;

-- 任意块的时间线（最近 50 次动过 X 或它下面内容的提交）
SELECT seq FROM outline_subtree_changes WHERE ancestor_id = :X AND seq < :before ORDER BY seq DESC LIMIT 51;
SELECT from_seq FROM outline_block_versions WHERE block_id = :X AND from_seq < :before ORDER BY from_seq DESC LIMIT 51;
-- 两个结果在应用里归并去重，再按 (space_id, seq) 取提交行

-- ② 相邻提交之间变了什么（时间轴走一步）
SELECT v.block_id, v.parent_id, v.order_key, v.change_flags, v.deleted, v.content
FROM outline_commits c JOIN outline_block_versions v ON v.commit_id = c.id
WHERE c.space_id = :S AND c.seq = :T;

-- ③ 比较 (T1, T2]：对每个要展开的节点 N 取它两个时刻之间出现过的子块，
--    并问每个子块「自己变没变」「下面变没变」；只对「下面变了」的子块递归
SELECT e.block_id, e.from_seq, e.to_seq, e.order_key,
  EXISTS (SELECT 1 FROM outline_block_versions v
          WHERE v.block_id = e.block_id AND v.from_seq > :T1 AND v.from_seq <= :T2) AS self_changed,
  EXISTS (SELECT 1 FROM outline_subtree_changes t
          WHERE t.ancestor_id = e.block_id AND t.seq > :T1 AND t.seq <= :T2) AS below_changed
FROM outline_block_edges e
WHERE e.parent_key = :N AND e.from_seq <= :T2 AND (e.to_seq IS NULL OR e.to_seq > :T1);
-- 位置区间盖住 [T1, T2] 的子块没有移动过；只在 T1 有的是移走或删除；只在 T2 有的是新来的。

-- 某块在某时刻的父块（往上走：面包屑、「它那时属不属于 X」）
SELECT parent_key FROM outline_block_edges
WHERE block_id = :B AND from_seq <= :T AND (to_seq IS NULL OR to_seq > :T)
ORDER BY from_seq DESC LIMIT 1;

-- ⑦ 移动子树根 R 到新父块 P（同一事务，序号 :seq）
UPDATE outline_block_versions SET to_seq = :seq WHERE block_id = :R AND to_seq IS NULL;
UPDATE outline_blocks SET parent_id = :P, order_key = :key, version_seq = :seq WHERE id = :R;
INSERT INTO outline_block_versions (…) SELECT id, :seq, NULL, :commit, … FROM outline_blocks WHERE id = :R;
UPDATE outline_block_edges SET to_seq = :seq WHERE parent_key = :oldParent AND block_id = :R AND to_seq IS NULL;
INSERT INTO outline_block_edges VALUES (:P, :R, :seq, NULL, :key);
INSERT INTO outline_subtree_changes VALUES (:a, :seq) ON CONFLICT DO NOTHING;  -- 旧祖先链和新祖先链上的每个 a
```

## 附录 D　测量

**方法**

- 环境：本容器（4 核），Bun 1.4.3，SQLite 3.53.4（`bun:sqlite`），PostgreSQL 16.15（临时实例，只在草稿目录里，用完已删）。数字只适合相互比较。
- 数据（`gen.ts`，确定性伪随机）：一个空间；顶层块（页）大小的中位数约 150 块、少数上千，另放进特定大小的顶层块（2,000 / 10,000 / 20,000 / 100,000）和一个「热」页（60 块，其中 50 块被反复输入）；形状以浅而宽为主（第 1–3 层占 82%），每 40 页有一条 150 层的深链；历史平均每块 10 个版本，其中 86% 改内容、4% 改任务、5% 换顺序、4% 换父块（只移动叶子，1% 跨页）、1% 删除；70% 的提交改 1 块、25% 改 2–4 块、5% 改 10–30 块；id 是 21 个随机字符（和 nanoid 一样在索引里无序）。
- 三个规模：1 万块（10.5 万版本、4.5 万提交，78 MB）、10 万块（105 万版本、45.6 万提交，0.8 GB）、100 万块（1004 万版本、415 万提交，7.8 GB）。**同一个库文件里并排放着几种方案的行和索引**，所以各方案读的是完全相同的历史。表结构照 `schema.ts`（带文本主键的普通表）；两张新表 `WITHOUT ROWID`。索引在写入之前建好，按提交顺序写入，使 B 树的填充接近真实使用。
- 读取（`bench.ts`、`extra.ts`）：连接用应用自己的参数（WAL、`synchronous=NORMAL`、16 MB 页缓存、256 MB mmap）；每项在历史后半段随机取序号重复 15–200 次（表中 n），先热身 3 次；计时包含语句和把行建成树的 JavaScript；给出 p50 / p95 / 最大值。所有语句都用 `EXPLAIN QUERY PLAN` 看过走的是预期的索引（`--plans`）。
- 移动：在库的副本上真正提交（WAL）。「今天的做法」按 `sqlite-store.ts` 的三条语句、每 500 个 id 一批；测它之前删掉了只有别的方案才需要的那个索引并做了检查点。10 万块规模跑了两遍，100 万块规模一遍。
- PostgreSQL（`pg-bench.sql`）：10 万块那份数据经 CSV 导入，`shared_buffers` 256 MB，在服务端用 PL/pgSQL 计时并只数行数——**不含把行传给客户端和建树的时间，所以和 SQLite 的数字不能直接横比**，只看同一存储内各方案的相对关系。

**SQLite：按时刻读（毫秒，p50 / p95）**

| | 1 万块空间 | 10 万块空间 | 100 万块空间 |
|---|---|---|---|
| **50 块的可见范围**，普通页（约 450 块）：今天 / A / A′ | 1.18 / 0.21 / 0.24 | 1.63 / 0.26 / 0.38 | 2.52（6.3）/ 0.37 / 0.29（0.56） |
| 同上，2000 块的页 | 7.96（12.0）/ 1.06 / 0.33 | 17.6（24.5）/ 1.38 / 0.58 | 24.8（46.2）/ 1.74 / 0.36（0.46） |
| 同上，10,000 块的页 | — | 67.2（93.8）/ 4.88 / 0.73 | 93.4（157.5）/ 7.26 / 0.61（0.69） |
| 热页（50 块各被改 100 / 1000 / 1000 次） | 0.47 / 0.44 / 0.24 | 3.91 / 3.46 / 0.36 | 3.34 / 3.24 / 0.23 |
| **2000 块子树的结构**：今天 / A / A′ 只位置 / A′ 带任务和别名 | 9.1（12.1）/ 12.2 / 4.8 / 9.1 | 14.0（17.7）/ 16.2 / 5.1 / 15.9 | 22.5（30.1）/ 24.6 / 5.6 / 25.5（30.5） |
| 10,000 块子树 | — | 79（92）/ 90 / 30 / 93（135） | 96（203）/ 117 / 50 / 132（154） |
| 20,000 块子树 | — | 114（162）/ 146 / 58 / 206 | 184（339）/ 216 / 81 / 253 |
| 100,000 块子树 | — | — | 784（1169）/ 935 / 375 / 1108（1176） |
| 800 块的内容（各方案相同） | 2.5 | 3.6 | 2.9 |
| **一屏 800 块，某时刻，带内容**（A′，广度优先到预算为止），子树 2 千 / 1 万 / 2 万 / 10 万块 | — | 5.9 / 5.0 / 5.8 / — | 7.2 / 7.0 / 7.6 / 12.4（15.4） |

「今天」= 按 `(page_id, from_seq, to_seq)` 读整页；A = 版本行上的 `(parent_id, from_seq, to_seq)` 索引；A′ = 位置表。

**SQLite：当前状态（不看历史）**

| 子树 | 按 `page_id` | 递归走子块索引 | 前 800 块（递归，到预算为止） |
|---|---|---|---|
| 2000 块（100 万块空间） | 2.9（3.6） | 8.5（9.3） | 3.2（4.6） |
| 10,000 块 | 12.8（18.4） | 72（83） | 5.9（7.1） |
| 20,000 块 | 31（35） | 127（149） | 8.5（9.7） |
| 100,000 块 | 129（157） | 604（897） | 44（53）※ |

※ 这一项是在移动测试改写过这个库文件之后测的，比别的规模慢得不成比例，原因没有查。

**SQLite：比较相隔 1000 次提交的两个时刻（毫秒，p50 / p95）**

| 子树 | 今天（读两遍整页） | A′ 读两遍 | B 沿变动往下走 | D 取这 1000 次提交的版本逐个往上找 |
|---|---|---|---|---|
| 2000 块（1 万块空间，这段时间里它变了约 170–430 块） | 18.3（27.4） | 19.2 | 3.8（5.1），看了 948 条位置 | 15.8 |
| 2000 块（10 万） | 27.2（34.4） | 29.6 | 2.6（3.8） | 37.3 |
| 2000 块（100 万） | 43.4（45.6） | 52.9 | 1.7（2.5） | 52.6 |
| 10,000 块（10 万） | 139（160） | 203 | 15.5（21.3），2954 条 | 32.8 |
| 10,000 块（100 万） | 191（223） | 259 | 15.1（18.4） | 47.1 |
| 100,000 块（100 万） | 1540（1610） | 2307 | 158（185），26,968 条 | 49.6（61.5） |

B 的耗时正比于「变过的路径上所有节点的子块总数」（每个子块两次存在性查找）；D 的耗时正比于「这段时间整个空间里的改动数」，和子树大小无关。两者取其小：子树在 1 万块以内用 B，更大用 D。

**SQLite：其余**

| | 结果 |
|---|---|
| 最近 50 次提交的时间线，今天（页）/ 变动表（任意块） | 0.01–0.02 ms / 0.01–0.02 ms（p95 ≤ 0.08） |
| 一个块的历史（50 个版本） | 0.03–0.16 ms（p95 0.78，100 万块空间） |
| 一次提交写的版本 | 0.01–0.02 ms |
| 走一遍子树数「进行中的任务」：2000 / 1 万 / 10 万块 | 4.7 / 42 / 428 ms |
| 一块内容的提交：今天 / 加变动行（10 万块空间，各 1500 次，两轮） | p50 0.105 → 0.15 ms，p95 0.27–0.29 → 0.35–0.39 ms；平均 2.7 行变动 |
| 全部提交平均的变动行数 | 5.4 / 5.5 / 6.7 行（1 万 / 10 万 / 100 万块） |
| 变动行按祖先的层数分布（10 万块） | 第 0 层 29%，第 1 层 32%，第 2 层 17%，第 3 层 9%，更深 13% |

**SQLite：把子树移到另一页的块下面**

| 子树 | 今天的做法：行数；收集 + 写入 | 建议的做法 |
|---|---|---|
| 约 1,850 块（1 万块空间） | 3 × 1,816 行；3–5 ms + 191–237 ms | 6 行，0.5 ms |
| 约 1,900 块（10 万块空间，两遍） | 3 × 1,899 行；9–11 ms + 240 / 420 ms | 6 行，0.7 ms |
| 约 9,400 块（10 万，两遍） | 31–42 ms + 957 / 1170 ms | 6 行，0.2–0.3 ms |
| 约 18,300 块（10 万，两遍） | 57–69 ms + 1963 / 2151 ms | 6 行，0.3 ms |
| 约 2,050 块（100 万块空间，一遍，缓存是冷的） | 11 ms + 2046 ms | 6 行，0.65 ms |
| 约 10,000 块（100 万） | 72 ms + 1801 ms | 6 行，0.2 ms |
| 约 19,300 块（100 万） | 102 ms + 6547 ms | 6 行，0.3 ms |
| 约 90,100 块（100 万） | 523 ms + 18,720 ms | 6 行，0.3 ms |

- 「3 × N 行」= 每个后代关一行旧版本、写一行新版本、改一行当前状态。上一份研究在很小的测试库上量到 1999 块 73 ms；库变大之后每块 0.1–0.2 ms，而且波动大（第一批最慢，取决于缓存）。这些都在主线程的一个同步事务里。
- 建议做法的每组 5 次里第一次偶尔很慢（最大 9.6–413 ms，是那次写入碰上了 WAL 的检查点），中位数如表。

**SQLite：占用（10 万块空间，`dbstat`）**

| | MiB | 字节 / 行 |
|---|---|---|
| 版本表 | 346.8 | 347 |
| 版本主键索引 / 页索引 / 提交索引 | 38.0 / 42.4 / 34.1 | 38 / 42 / 34 |
| （方案 A 的父块索引） | 42.5 | 43 |
| 位置表 + 它的索引 | 9.4 + 8.3 | 67 + 59（每个版本摊 17） |
| 变动表 | 82.5 | 34（每个版本摊 82） |
| 提交表 + 索引 | 74.3 + 31.4 | 171 + 约 70 |

今天的历史（版本表 + 三个索引）461 MiB；加两张新表 +100 MiB（+22%）；最后删掉页索引 −42 MiB；净增约 12.5%。1 万块规模的每行字节数相同。

**PostgreSQL 16（10 万块空间；服务端计时，只数行）**

| | 今天 | A | A′ |
|---|---|---|---|
| 50 块可见范围：普通页 / 2000 块页 / 10,000 块页（ms，p50） | 1.6 / 13.4 / 71.7（只读结构） | 0.26 / 1.43 / 6.30 | 0.28 / 0.46 / 1.01 |
| 热页 | 7.6 | 4.9（GiST：0.41） | 0.56 |
| 2000 块子树，某时刻 | 15.2 | 49.5 | 5.5（只位置）/ 14.4（带版本） |
| 10,000 块子树 | 75.9 | 173.7 | 22.9 / 61.8 |
| 20,000 块子树 | 93.8 | 307.1 | 44.7 / 122.1 |
| 当前状态，2000 / 1 万 / 2 万块：按 `page_id` → 递归 | 0.9 / 3.0 / 4.1 → 8.7 / 37 / 66（前者因为只数行而偏低） | | |
| 时间线 | 0.06 | | 0.04（变动表） |

占用：版本表 376 MB，主键 / 页 / 父块 / 提交索引 50 / 50 / 51 / 22 MB；位置表 13 + 9.8 + 7.2 MB；**变动表 146 MB + 主键 120 MB（每行约 105 字节）**；GiST `(parent_id, int4range)` 99 MB，建了 39 秒。净增约 49%。

**路径复制每次改一个块要写多少**（`pathcopy-cost.ts`，在同样的树上估算：每个节点 60 字节 + 每个子块 33 字节；抽 3000 个被改的块）

| | 1 万块 | 10 万块 | 100 万块 |
|---|---|---|---|
| 重写的节点数（平均 / p95） | 4.7 / 8 | 4.9 / 7 | 5.4 / 8 |
| 字节，子块列表整存（平均 / p95） | 8,119 / 16,493 | 55,148 / 151,907 | 232,669 / 778,574 |
| 字节，子块列表按约 128 项分块（平均 / p95） | 6,733 / 11,147 | 15,158 / 18,716 | 17,691 / 32,873 |

**没有测的**

- 真实数据：空间有多大、树多深、每块多少版本、提交多密，全是假设（本机库是空的测试库）。变动表的大小对「深度」和「一次提交改多少块」敏感。
- 应用的真实代码路径（Drizzle、读线程池、行到对象的映射）；这里是裸语句。
- 补建两张表的耗时；删除的「先关根、后台收尾」；保留策略的合并。
- PostgreSQL 上的移动、比较、100 万块规模；PG 把行传回客户端的开销。
- 并发：有人在写的同时读；多个读线程；WAL 很大时。
- 冷磁盘（所有读取都在操作系统缓存热的情况下）；Windows。
- SQLite 的 R 树存区间（只在文献里讨论，未测）；全文搜索（设计不涉及它）。
- 「恢复到某时刻」的写入部分；任意块时间轴的界面延迟。

## 参考资料

1. K. Kulkarni, J.-E. Michels. Temporal features in SQL:2011. SIGMOD Record 41(3), 2012. https://sigmodrecord.org/publications/sigmodRecord/1209/pdfs/07.industry.kulkarni.pdf
2. Microsoft. Temporal tables（SQL Server 文档）. https://learn.microsoft.com/en-us/sql/relational-databases/tables/temporal-tables
3. MariaDB. System-Versioned Tables. https://mariadb.com/kb/en/system-versioned-tables/
4. B. Salzberg, V. J. Tsotras. Comparison of access methods for time-evolving data. ACM Computing Surveys 31(2), 1999. https://www.vislab.ucr.edu/IGERT/papers/temporal-index-survey.pdf
5. B. Becker, S. Gschwind, T. Ohler, B. Seeger, P. Widmayer. An asymptotically optimal multiversion B-tree. VLDB Journal 5(4), 1996. https://link.springer.com/article/10.1007/s007780050028
6. H.-P. Kriegel, M. Pötke, T. Seidl. Managing intervals efficiently in object-relational databases. VLDB 2000. https://www.vldb.org/conf/2000/P407.pdf
7. SQLite. The R*Tree Module. https://www.sqlite.org/rtree.html ；Clustered Indexes and the WITHOUT ROWID Optimization. https://www.sqlite.org/withoutrowid.html
8. PostgreSQL. Range Types. https://www.postgresql.org/docs/current/rangetypes.html
9. PostgreSQL. btree_gist. https://www.postgresql.org/docs/current/btree-gist.html
10. PostgreSQL 18 的时态约束（`WITHOUT OVERLAPS`）——二手说明：https://betterstack.com/community/guides/databases/postgres-temporal-constraints/ ；提交说明转述：https://www.depesz.com/tag/period/
11. J. R. Driscoll, N. Sarnak, D. D. Sleator, R. E. Tarjan. Making data structures persistent. JCSS 38(1), 1989. https://www.cs.cmu.edu/~sleator/papers/another-persistence.pdf
12. LMDB 文档. http://www.lmdb.tech/doc/
13. O. Rodeh. B-trees, shadowing, and clones. ACM Transactions on Storage 3(4), 2008. https://dl.acm.org/doi/10.1145/1326542.1326544
14. Pro Git, Git Internals – Git Objects. https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
15. Dolt 文档：Prolly Trees. https://docs.dolthub.com/architecture/storage-engine/prolly-tree
16. DoltHub. Efficient Diff on Prolly-Trees. https://www.dolthub.com/blog/2020-06-16-efficient-diff-on-prolly-trees/
17. DoltHub. How Dolt Scales to Millions of Versions, Branches, and Rows. https://www.dolthub.com/blog/2025-05-16-millions-of-versions/
18. Noms. https://github.com/attic-labs/noms/blob/master/doc/intro.md
19. Irmin. https://irmin.org/
20. Fossil：文件格式与差量格式. https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki ；https://fossil-scm.org/home/doc/trunk/www/delta_format.wiki
21. TerminusDB 文档. https://terminusdb.com/docs/
22. Datomic 文档：Indexes；Database Filters. https://docs.datomic.com/query/indexes.html ；https://docs.datomic.com/time/filters.html
23. N. Prokopov. Unofficial guide to Datomic internals. https://tonsky.me/blog/unofficial-guide-to-datomic-internals/
24. XTDB 文档. https://docs.xtdb.com/
25. SQLite. The WITH Clause（递归公用表表达式）. https://www.sqlite.org/lang_with.html
26. PostgreSQL. ltree. https://www.postgresql.org/docs/current/ltree.html
27. V. Tropashko. Nested intervals tree encoding with continued fractions. https://arxiv.org/abs/cs/0402051
28. B. Karwin. Models for hierarchical data（闭包表等的比较）. https://www.slideshare.net/billkarwin/models-for-hierarchical-data
29. P. O'Neil 等. ORDPATHs: insert-friendly XML node labels. SIGMOD 2004. https://dl.acm.org/doi/10.1145/1007568.1007686
30. Figma. Realtime editing of ordered sequences. https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
31. S.-Y. Chien, V. J. Tsotras, C. Zaniolo. Efficient schemes for managing multiversion XML documents. VLDB Journal 11(4), 2002. https://link.springer.com/doi/10.1007/s00778-002-0079-4
32. G. Cobena, S. Abiteboul, A. Marian. Detecting changes in XML documents. ICDE 2002. https://ieeexplore.ieee.org/document/994696
33. P. Buneman, S. Khanna, K. Tajima, W.-C. Tan. Archiving scientific data. ACM TODS 29(1), 2004. https://dl.acm.org/doi/10.1145/974750.974752
34. Notion. The data model behind Notion's flexibility. https://www.notion.com/blog/data-model-behind-notion
35. Notion. Herding elephants: lessons learned from sharding Postgres at Notion. https://www.notion.com/blog/sharding-postgres-at-notion
36. Figma. How Figma's multiplayer technology works. https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
37. Figma. Making multiplayer more reliable. https://www.figma.com/blog/making-multiplayer-more-reliable/
38. Google. What's different about the new Google Docs（2010 年系列；正文这次未能读取）. https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs_22.html
39. Linear. Scaling the Linear Sync Engine（演讲页）. https://linear.app/blog/scaling-the-linear-sync-engine ；第三方逆向分析：https://github.com/wzhudev/reverse-linear-sync-engine
40. Yjs 论坛：Garbage Collection and Version Snapshotting；Is there a way to revert to a specific version? https://discuss.yjs.dev/t/garbage-collection-and-version-snapshotting/1839 ；https://discuss.yjs.dev/t/is-there-a-way-to-revert-to-a-specific-version/379
41. Automerge. Binary document format. https://automerge.org/automerge-binary-format-spec/
42. Automerge. Automerge 3.0. https://automerge.org/blog/automerge-3/
43. M. Kleppmann, D. P. Mulligan, V. B. F. Gomes, A. R. Beresford. A highly-available move operation for replicated trees. IEEE TPDS 33(7), 2022. https://martin.kleppmann.com/papers/move-op.pdf
44. Replicache：How it works. https://doc.replicache.dev/concepts/how-it-works ；Zero 文档. https://zero.rocicorp.dev/docs
45. Logseq 论坛：Why the database version and how it's going? https://discuss.logseq.com/t/why-the-database-version-and-how-its-going/26744
46. M. Fowler. Event Sourcing. https://martinfowler.com/eaaDev/EventSourcing.html
