# outline-bench

P0 benchmarks for the outline design (`docs/OUTLINE_KNOWLEDGE-DESIGN.md`). Results and conclusions are in
[RESULTS.md](./RESULTS.md); raw per-run numbers are in `results/*.json`.

| Benchmark | Question (design reference) | Code |
|---|---|---|
| 1. point-in-time reads | Can an append-only `outline_block_versions` (from_seq / to_seq) keep viewport-level latency (500 blocks, §7.2) when history grows? SQLite (`bun:sqlite`, WAL) and PostgreSQL 16 | `time-travel/` |
| 2. brute-force vector scan | How far does BLOB + scan in a Bun Worker go before the 200 ms budget (§5.3, D10, §7.2) is blown? | `vector/` |

Everything runs with Bun only (no `npx`, no npm dependencies). The generated databases are large; they live
outside the repo (default `OUTLINE_BENCH_DATA`, see `time-travel/lib.ts`) and are deleted after a run.
Disk needed: up to about 8 GB at the same time (the 1 M x 1024 float32 vector database is 4 GB, the 30
versions-per-block history is about 6 GB with its PostgreSQL copy).

```sh
export OUTLINE_BENCH_DATA=/some/scratch/dir            # data files, not in the repo
export OUTLINE_BENCH_PG_DIR=/some/scratch/dir/pgbench  # throw-away PostgreSQL cluster
```

## 1. Point-in-time reads (`time-travel/`)

What is generated (`gen.ts`, deterministic, `--seed`): 5 spaces x 10 pages x 2000 blocks plus one 10,000-block
page = 110,000 blocks; versions are appended until the average is `--vpb` per block (10 => 1.1 M version
rows, about 195 k commits). Edit hotness is log-normal (median block 3 versions, p99 108, hottest block
1637). Operations: content edit, task edit, create, delete subtree (tombstone for every descendant), restore,
move inside a page, move a subtree to another page (one new version for every descendant). Content length
is 8..5000 chars (mean about 380 bytes UTF-8, mixed Chinese / English / code / `[[links]]`), full copy in
every version row.

```sh
# 1. data: SQLite file + PostgreSQL COPY files
bun time-travel/gen.ts --vpb=10 --out=$OUTLINE_BENCH_DATA/tt-vpb10

# 2. PostgreSQL 16 cluster (non-default port 54329, unix socket, tuned for a small server; see pg-cluster.sh)
time-travel/pg-cluster.sh init && time-travel/pg-cluster.sh start
bun time-travel/pg-load.ts --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --db=ob10

# 3. benchmarks (one run per dialect; each variant creates its own indexes, measures, drops them)
bun time-travel/bench.ts --dialect=sqlite --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --variants=A1,A2,B1,B2,B3,B5,C
bun time-travel/bench.ts --dialect=pg --db=ob10 --dir=$OUTLINE_BENCH_DATA/tt-vpb10 --variants=A1,A2,B1,B2,B3,B4,B5,C
bun time-travel/bench.ts --dialect=sqlite --sqlite-cache=big ...   # 2 GB page cache + 4 GB mmap instead of the repo defaults
bun time-travel/cold.ts --dialect=sqlite --dir=... --variants=B3,B5,A2,C   # page cache dropped before every query

# 4. clean up
time-travel/pg-cluster.sh destroy; rm -rf $OUTLINE_BENCH_DATA/tt-*
```

`--vpb=3` / `--vpb=30` give the shorter and longer histories used for the growth curve.

Table / index designs (all queries return the same rows; `bench.ts` checks that for 60 samples per run):

| id | design | index on `outline_block_versions` |
|---|---|---|
| A1 | reconstruct from `parent_id` only (recursive CTE per time point) | `(parent_id, from_seq)`, filter `to_seq IS NULL OR to_seq > T` |
| A2 | same | `(parent_id, from_seq, to_max)`, `to_max` = `to_seq` or a sentinel for "open" |
| B1 | redundant `page_id` on every version | `(page_id, from_seq)`, NULL-or filter |
| B2 | same | `(page_id, from_seq, to_seq)`, NULL-or filter |
| B3 | same | `(page_id, from_seq, to_max)` sentinel |
| B4 | same, PostgreSQL only | GiST `(page_id, int8range(from_seq, to_seq))` (btree_gist) |
| B5 | same, structure/content split | covering `(page_id, from_seq, to_max) INCLUDE (deleted, block_id, parent_id, order_key)`; content fetched for the 500 shown blocks only |
| C | no `page_id` on versions, separate `outline_page_members(page_id, block_id, from_seq, to_seq)` interval table | `(page_id, from_seq, to_max)` on the members table |

Always present: PK `(block_id, from_seq)` and `(commit_id)` on versions, `(space_id, seq)` unique on commits.

Queries (`queries.ts`): Q1 viewport (first 500 blocks in tree order at time T), Q2 whole page at T (about 1850
live blocks; also the 10,000-block page), Q3 changes between two time points (window of 1 / 100 / 5000
commits), Q4 commit list by cursor (200 per page; all, agent only, one narrator, one page), W write cost
(1-block commit, 200-block commit). Latency is measured in the JS client including row materialisation (and
the tree ordering for Q1).

## 2. Vector scan in a Worker (`vector/`)

```sh
bun vector/recall.ts --n=50000 --dim=768                       # int8 quantisation loss (recall@10/@50)
bun vector/gen-db.ts 50000 768                                 # tiny smoke test database
bun vector/run-all.ts                                          # the whole matrix (several hours at 1 M vectors)
bun vector/bench.ts --db=<file> --n=200000 --dim=1024 --dtype=i8   # one dataset
vector/build-wasm.sh                                           # optional: rebuild kernels.wasm from kernels.c
```

`kernels.wasm` (5 KB) is committed; `kernels.c` is its source (clang `--target=wasm32 -msimd128`). The
benchmark compares three storage / compute choices: float32 or int8 (symmetric, per-vector scale), JS typed-array
loops or WebAssembly SIMD, vectors resident in the worker or re-read from SQLite for every query, with a
"target space = 10% of the vectors" filter implemented four ways (contiguous range, per-vector tag, id list, SQL).
