# Tree-history prototypes (throwaway)

Benchmarks for `scratchpad/outline-tree-history-design.md`. Standalone scripts (bun + `bun:sqlite`,
no server modules), based on the table shapes of `server/db/schema.ts` at origin/main 9bb31f88.
The generated databases were deleted (the 1M one is 7.8 GB); the `result-*.txt` files are the runs
the note quotes.

| file | what |
|---|---|
| `gen.ts` | `bun gen.ts <blocks> <out.db> [versionsPerBlock=10]` — a synthetic space with history; one file holds the rows of every scheme (page-keyed versions, a parent index on the same rows, `edges`, `touch`). 10k: 2 s / 78 MB; 100k: 31 s / 0.8 GB; 1M: about 10 min / 7.8 GB, needs ~2 GB RAM |
| `bench.ts` | `bun bench.ts <db> [--plans] [--sizes] [--no-moves] [--only-moves]` — as-of reads, diff, timeline, aggregates, storage (dbstat), moves. **The move test writes: run it on a copy** |
| `extra.ts` | `bun extra.ts <copy.db>` — budgeted breadth-first reads; cost of the touch rows per commit (writes) |
| `pathcopy-cost.ts` | `bun pathcopy-cost.ts <db>` — bytes one edit would write under a path-copying tree |
| `pg-export.ts`, `pg-schema.sql`, `pg-index.sql`, `pg-bench.sql`, `pg-gist.sql` | the same data and reads on PostgreSQL 16 (CSV → `\copy`), server-side timings; `pg-gist.sql` needs `btree_gist` |

Default run (well under a minute):

    bun gen.ts 10000 space-10k.db && cp space-10k.db work.db && bun bench.ts work.db --plans --sizes

PostgreSQL was a private instance inside the scratchpad (`unshare -U initdb/pg_ctl`, unix socket
only), stopped and removed after the run.

Notes on the saved results: the 10k-block numbers in the note came from a console run that was not
saved (regenerate in seconds with the default run above). `result-1m.txt` and `result-extra-1m.txt`
were taken on one file in sequence: reads first, then the move test, then `extra.ts` (whose write
part failed on that already-moved file; the 100k run has those numbers).
