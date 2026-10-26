/**
 * Load the TSV files written by gen.ts into a fresh PostgreSQL database.
 * Needs a running cluster (see README.md), reachable through PG_SOCKET.
 *
 * Run: bun time-travel/pg-load.ts --dir=<datadir> --db=ob10
 */
import { SQL } from "bun";
import { join } from "node:path";
import { PG_DDL } from "./gen";
import { arg, DATA_ROOT, PG_SOCKET } from "./lib";

const dir = arg("dir") ?? join(DATA_ROOT, "tt-vpb10");
const dbName = arg("db") ?? "ob10";
const sockDir = PG_SOCKET.replace(/\/\.s\.PGSQL\.\d+$/, "");
const port = PG_SOCKET.match(/\.s\.PGSQL\.(\d+)$/)?.[1] ?? "5432";

const admin = new SQL({ path: PG_SOCKET, user: "postgres", database: "postgres", max: 1 });
await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
await admin.close();

async function psql(command: string) {
	const p = Bun.spawn(
		["psql", "-h", sockDir, "-p", port, "-U", "postgres", "-d", dbName, "-v", "ON_ERROR_STOP=1", "-q", "-c", command],
		{ stdout: "inherit", stderr: "inherit", env: { ...process.env, PATH: `/usr/lib/postgresql/16/bin:${process.env.PATH}` } },
	);
	const code = await p.exited;
	if (code !== 0) throw new Error(`psql failed: ${command}`);
}

const t0 = performance.now();
for (const stmt of PG_DDL.split(";")) if (stmt.trim()) await psql(stmt);
await psql("CREATE EXTENSION IF NOT EXISTS btree_gist");
for (const t of ["outline_commits", "outline_blocks", "outline_block_versions", "outline_page_members"]) {
	const t1 = performance.now();
	await psql(`\\copy ${t} FROM '${join(dir, `${t}.tsv`)}'`);
	console.log(`copied ${t} in ${((performance.now() - t1) / 1000).toFixed(1)}s`);
}
// base (variant independent) constraints and indexes, same as the SQLite side
await psql("ALTER TABLE outline_block_versions ADD PRIMARY KEY (block_id, from_seq)");
await psql("CREATE INDEX v_commit ON outline_block_versions (commit_id)");
await psql("ALTER TABLE outline_commits ADD PRIMARY KEY (id)");
await psql("CREATE UNIQUE INDEX c_space_seq ON outline_commits (space_id, seq)");
await psql("ALTER TABLE outline_blocks ADD PRIMARY KEY (id)");
await psql("VACUUM (ANALYZE)");
await psql("CHECKPOINT");
console.log(`pg load done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
