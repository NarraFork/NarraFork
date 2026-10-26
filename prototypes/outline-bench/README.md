# outline-bench

大纲设计（`docs/OUTLINE_KNOWLEDGE-DESIGN.md`）P0 阶段的两项性能基准。结果和结论见 [RESULTS.md](./RESULTS.md)，每次运行的原始数字（含 EXPLAIN 计划）在 `results/*.json`。

| 基准 | 要回答的问题（设计中的位置） | 代码 |
|---|---|---|
| 1. 按时间点读取 | `outline_block_versions` 只追加、按 `from_seq`/`to_seq` 区间查询，历史变长以后还能不能保持"单个视口 500 块"的延迟（§2.5、§3.2、§7.2）。SQLite（`bun:sqlite`、WAL）和 PostgreSQL 16 都测 | `time-travel/` |
| 2. db-worker 暴力扫描向量 | BLOB 向量在 Bun Worker 里扫描，多大规模以内能守住 200 ms，什么时候必须换 sqlite-vec / pgvector（§5.3、D10、§7.2） | `vector/` |

只用 Bun（不用 `npx`，没有 npm 依赖）。生成的数据库很大，放在仓库外（`OUTLINE_BENCH_DATA`，默认值见 `time-travel/lib.ts`），测完删除。同时占用磁盘最多约 8 GB（100 万 × 1024 维的 float32 向量库 4 GB；30 版本/块的历史连同 PG 副本约 6 GB）。

```sh
export OUTLINE_BENCH_DATA=/some/scratch/dir              # 数据文件，不进仓库
export OUTLINE_BENCH_PG_DIR=/some/scratch/dir/pgbench    # 临时 PostgreSQL 集群
```

## 1. 按时间点读取（`time-travel/`）

`gen.ts` 生成确定性的合成历史（`--seed`）：5 个空间 × 10 页 × 2000 块，外加空间 0 里一个 10,000 块的页，共 11 万块；不断追加提交，直到平均每块 `--vpb` 个版本（10 → 约 110 万版本行、19.5 万个提交）。编辑热度对数正态（少数块改得多），操作包括内容编辑、任务编辑、新建、删除子树（后代各写一条墓碑）、恢复、页内移动、跨页移动子树。正文 8–5000 字符，平均约 370 字节，每个版本存全文。

```sh
# 1. 数据：SQLite 文件 + PostgreSQL COPY 文件
bun time-travel/gen.ts --vpb=10 --out=$OUTLINE_BENCH_DATA/tt-vpb10        # --vpb=3 / 30 是更短 / 更长的历史

# 2. PostgreSQL 16 临时集群（非默认端口 54329，unix socket；root 下用 user namespace 启动，见脚本注释）
time-travel/pg-cluster.sh init && time-travel/pg-cluster.sh start
bun time-travel/pg-load.ts --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --db=ob10

# 3. 基准（每个变体自己建索引、测量、再删除；每次运行会核对各设计返回的行集合完全一致）
bun time-travel/bench.ts --dialect=sqlite --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --variants=A1,A2,B1,B2,B3,B5,C
bun time-travel/bench.ts --dialect=pg --db=ob10 --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --variants=A1,A2,B1,B2,B3,B4,B5,C
bun time-travel/bench.ts --dialect=sqlite --sqlite-cache=big ...           # 2 GB 缓存 + 4 GB mmap，对照仓库默认的 16 MiB / 256 MiB
bun time-travel/bench.ts ... --only-write                                   # 只测写入；--no-write 跳过写入
bun time-travel/cold.ts --dialect=sqlite --dir=... --variants=B3,B5,A2,C   # 每次查询前清掉该文件的操作系统缓存
bun time-travel/report.ts                                                   # 把 results/tt-*.json 打成 markdown 表

# 4. 清理
time-travel/pg-cluster.sh destroy; rm -rf $OUTLINE_BENCH_DATA/tt-*
```

PG 冷读要把集群的 `shared_buffers` 临时调到 16 MB 再重启（`ALTER SYSTEM SET shared_buffers='16MB'`），测完再改回。

被比较的表 / 索引设计（`queries.ts`）：

| 编号 | 做法 | `outline_block_versions` 上的索引 |
|---|---|---|
| A1 | 只靠 `parent_id`，在时刻 T 递归还原子树 | `(parent_id, from_seq)`，过滤 `to_seq IS NULL OR to_seq > T` |
| A2 | 同上 | `(parent_id, from_seq, to_max)`，`to_max` 是 `to_seq` 的 NOT NULL 哨兵版本 |
| B1 | 版本行冗余 `page_id`，按页过滤 | `(page_id, from_seq)` |
| B2 | 同上 | `(page_id, from_seq, to_seq)` |
| B3 | 同上 | `(page_id, from_seq, to_max)` |
| B4 | 同上（仅 PG） | GiST `(page_id, int8range(from_seq, to_seq))` |
| B5 | 同上，结构与正文分两步 | 覆盖索引 `(page_id, from_seq, to_max)` + `INCLUDE (deleted, block_id, parent_id, order_key)`；先读结构，再只读 500 块的正文 |
| C | 版本行不带 `page_id`，另建 `outline_page_members(page_id, block_id, from_seq, to_seq)` 区间表 | 成员表 `(page_id, from_seq, to_max)` |

所有设计都有主键 `(block_id, from_seq)` 和 `(commit_id)`；提交表有 `(space_id, seq)` 唯一索引。

查询：Q1 视口（某一时刻前 500 块，树序）；Q2 某一时刻整页（约 1850 个存活块，也测 1 万块的页）；Q3 两个时刻之间的增删改（窗口 1 / 100 / 5000 个提交）；Q4 提交列表，游标分页，每页 200 条（全部 / 只看 agent / 某个会话 / 某一页）；W 写入成本（1 块提交、200 块提交）。延迟在 JS 客户端测得，包含行物化（Q1 还包含树序整理）。

## 2. 向量扫描（`vector/`）

```sh
bun vector/recall.ts --n=50000 --dim=768 [--noise=0.9]      # int8 量化损失（对 float32 精确结果的召回），纯 JS
bun vector/gen-db.ts 50000 768 i8 r1,r2,r3 /tmp/x.db        # 小数据库，用来冒烟
bun vector/bench.ts --db=/tmp/x.db --n=50000 --dim=768 --dtype=i8
bun vector/run-all.ts                                       # 整个矩阵：对每个 (维度, 规模, 类型) 建库、跑、删库
bun vector/memory.ts --db=<含 r3 的库> --n=... --dim=... --dtype=...   # 稳态内存（新进程，强制 GC）
bun vector/report.ts                                        # 把 results/vec-*.json 打成 markdown 表
vector/build-wasm.sh                                        # 可选：从 kernels.c 重新编译 kernels.wasm（需要 clang 和 wasm-ld）
```

`kernels.wasm`（5 KB）已提交，源码是 `kernels.c`（`clang --target=wasm32 -msimd128`）。比较的维度：

- float32 对 int8（对称量化，每向量一个缩放）；
- JS 类型化数组循环对 WebAssembly SIMD；
- 向量常驻 worker 内存对每次查询从 SQLite 读；
- "目标空间占 10%"的过滤用四种方式：连续区间（向量按空间聚在一起存放）、逐向量空间标签、id 列表、不过滤；从 SQLite 读时三种表：`r1` 设计原样（`blocks` join `embeddings`）、`r2` `WITHOUT ROWID` 聚簇行、`r3` 每行 512 个向量的打包表。

文件说明：`common.ts` 合成向量、量化、JS 内核；`worker.ts` 扫描 worker；`bench.ts` 单个数据集的基准；`gen-db.ts` 建 SQLite 库；`run-all.ts`、`memory.ts`、`recall.ts`、`report.ts` 见上。

## 注意

- `results/*.json` 由脚本以紧凑形式写出，提交前要用 `bunx @biomejs/biome format --write prototypes/outline-bench/results` 整理，否则 `biome check .` 会报格式错误。
- 机器、方法和每个数字的口径见 RESULTS.md 第 1 节；单个最大值（max）受虚拟机噪声影响，不要当结论。
