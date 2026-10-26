/**
 * Run the whole vector matrix: for every (dim, n, dtype) build the SQLite database, run bench.ts in its
 * own process (clean memory numbers), then delete the database.
 *
 * Run: bun vector/run-all.ts [--dims=768,1024] [--ns=50000,200000,1000000] [--dtypes=f32,i8]
 *        [--queries=100] [--budget=20000] [--scenarios=resident,sqlite]
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { arg, DATA_ROOT } from "../time-travel/lib";
import { buildDbs, type DbSpec } from "./gen-db";

const dims = (arg("dims") ?? "768,1024").split(",").map(Number);
const ns = (arg("ns") ?? "50000,200000,1000000").split(",").map(Number);
const dtypes = (arg("dtypes") ?? "f32,i8").split(",") as ("f32" | "i8")[];
const queries = arg("queries") ?? "100";
const budget = arg("budget") ?? "20000";
const scenarios = arg("scenarios") ?? "resident,sqlite";

for (const dim of dims) {
	for (const n of ns) {
		for (const dtype of dtypes) {
			// disk budget: the 1M float32 databases are 3-4 GB, so only the clustered table (needed for the
			// resident load and the SQLite-read scenario) is built for them
			const tables: DbSpec["tables"] =
				dtype === "f32" && n >= 1_000_000 ? ["r2"] : ["r1", "r2", "r3"];
			const path = join(DATA_ROOT, `vec-${n}-${dim}-${dtype}.db`);
			const t0 = performance.now();
			console.log(`\n##### build ${path} tables=${tables.join(",")}`);
			buildDbs(n, dim, [{ dtype, path, tables }]);
			console.log(`built in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
			const p = Bun.spawn(
				[
					"bun",
					join(import.meta.dir, "bench.ts"),
					`--db=${path}`,
					`--n=${n}`,
					`--dim=${dim}`,
					`--dtype=${dtype}`,
					`--queries=${queries}`,
					`--budget=${budget}`,
					`--scenarios=${scenarios}`,
					`--tables=${tables.join(",")}`,
				],
				{ stdout: "inherit", stderr: "inherit" },
			);
			await p.exited;
			rmSync(path, { force: true });
		}
	}
}
