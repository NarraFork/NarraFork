import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");
test("compiled token worker loads outside the repository and commits counters plus version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nf-token-worker-compiled-"));
	const probe = join(project, `.token-worker-probe-${crypto.randomUUID()}.ts`);
	const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
	const database = new Database(join(directory, "fixture.db"));
	try {
		database.exec(`CREATE TABLE api_requests (
			id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT, model TEXT, credential_id TEXT,
			input_tokens INTEGER, cached_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
			cache_creation_5m_tokens INTEGER, cache_creation_1h_tokens INTEGER, token_accounting_version INTEGER
		); INSERT INTO api_requests VALUES ('a','2026-01-01',NULL,NULL,NULL,10000,3000,0,0,0,NULL);`);
		await writeFile(
			probe,
			`import { createTokenRecalculationWorkerStore } from "./server/services/token-recalculation-worker-client";
const store = await createTokenRecalculationWorkerStore(process.argv[2]);
try {
 const rows = await store.scan({start:"",end:"2030-01-01"});
 const before = rows[0];
 const result = await store.apply([{before,after:{input_tokens:7000,cached_input_tokens:3000,cache_creation_input_tokens:0,cache_creation_5m_tokens:0,cache_creation_1h_tokens:0},fallback:true}]);
 console.log(JSON.stringify(result));
} finally { await store.close(); }
`,
		);
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(project, "server/services/token-recalculation-worker.ts"),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ cwd: project, timeout: 60_000, maxBuffer: 1024 * 1024 },
		);
		await rm(probe, { force: true });
		const result = await exec(binary, [join(directory, "fixture.db")], {
			cwd: directory,
			env: { ...process.env, NARRAFORK_HOME: directory },
			timeout: 40_000,
			maxBuffer: 1024 * 1024,
		});
		expect(JSON.parse(result.stdout.trim())).toEqual({ processed: 1, changed: 1, fallback: 1 });
		expect(
			database.query("SELECT input_tokens,token_accounting_version FROM api_requests").get(),
		).toEqual({ input_tokens: 7000, token_accounting_version: 1 });
	} finally {
		database.close();
		await rm(probe, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
}, 120_000);
