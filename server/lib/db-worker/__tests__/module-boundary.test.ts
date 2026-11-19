import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { safeSpawn } from "../../spawn";

/**
 * The database read worker runs in a thread of THIS process. If its module graph ever reaches
 * `server/db/index.ts`, that module is evaluated a second time inside the worker thread and:
 *
 *   - opens a second READ-WRITE connection to the same database,
 *   - re-runs migrations, column backfills and `ensureFts`,
 *   - registers a second WAL-checkpoint interval and exit handler,
 *   - calls `consumeCleanShutdownState`, which CLEARS the clean-shutdown marker — verified
 *     experimentally to flip a freshly marked database back to "unclean", so the next startup
 *     believes the process crashed and pays for a full background integrity probe.
 *
 * `acquireInstanceLock` does not protect against this: the pid matches, so it silently "reuses" the
 * lock instead of refusing. The failure is therefore invisible until data or startup behaviour is
 * already wrong.
 *
 * This test bundles the worker entry and asserts the bootstrap never made it in. It is the guard
 * that keeps a future well-meaning import from reintroducing the problem.
 */

const ROOT = join(import.meta.dir, "../../../..");
const WORKER_ENTRY = join(ROOT, "server/lib/db-worker/worker-entry.ts");

/** Identifiers that only exist in the DB bootstrap / ORM layer the worker must never pull in. */
const FORBIDDEN_SYMBOLS = [
	"consumeCleanShutdownState",
	"acquireInstanceLock",
	"markDatabaseCleanShutdown",
	"releaseDatabaseInstanceLockOnly",
	"startWalCheckpointInterval",
	"ensureFts",
	"runMigrations",
];

const DOMAIN_MODULES = [
	"server/services/database-cleanup-read.ts",
	"server/services/benchmark-read.ts",
	"server/services/integration-authority-read-task.ts",
	"server/services/tool-edit-preview-reader.ts",
	"server/services/execution-policy/facts-reader.ts",
	"server/services/narrator-tool-snapshot-reader.ts",
	"server/services/search/recall-reader.ts",
	"server/services/knowledge/entry-reader.ts",
	"server/services/narrator-read-snapshots.ts",
	"server/services/narrator-message-snapshot-reader.ts",
	"server/services/agent-runtime/model-history-revision.ts",
	"server/services/agent-runtime/publication-reader.ts",
	"server/services/file-read-snapshots.ts",
	"server/services/git-current-diff-reader.ts",
	"server/services/execution-log-reader.ts",
	"server/services/tool-continuation-reader.ts",
] as const;
const PURE_MODULES = new Set<string>([
	...DOMAIN_MODULES,
	"server/services/revert-selection-message-queries.ts",
	"server/services/narrator-question-history.ts",
	"server/services/database-cleanup-utils.ts",
	"server/services/narrator-cleanup-contract.ts",
	"server/services/benchmark-limits.ts",
	"server/db/relations.ts",
	"server/services/execution-policy/facts.ts",
	"server/lib/runtime-source.ts",
	"server/lib/validators/runtime-registration.ts",
	"server/db/schema.ts",
	"server/services/storage-scan-queries.ts",
	"server/services/agent-runtime/model-history-json.ts",
	"server/services/agent-runtime/model-history-revision-sql.ts",
	"server/services/agent-runtime/publication-result.ts",
	"server/services/agent-runtime/publication-key.ts",
	"server/services/agent-runtime/limits.ts",
	"server/services/file-change-identity.ts",
	"server/lib/errors.ts",
	"server/lib/narrator-utils.ts",
	"server/lib/narrator-bodies.ts",
	"server/lib/narrator-body-length.ts",
	"server/services/read/acl-sql.ts",
	"shared/agent-protocol/tool-output.ts",
	"shared/narrator-blocks/decode.ts",
	"shared/narrator-blocks/plan.ts",
	"shared/narrator-blocks/storage.ts",
	"shared/reasoning-translation.ts",
	"server/lib/tool-execution-target-projection.ts",
	"server/lib/agent/tool-name.ts",
	"server/lib/agent/execution/path-semantics.ts",
	"shared/pretext-layout/tool-io-projection.ts",
	"shared/file-reference.ts",
	"shared/error-catalog.ts",
	"shared/file-change-protocol.ts",
	"shared/compact-message.ts",
	"shared/native-injection.ts",
	"shared/sidecar-body.ts",
	"shared/knowledge-excerpt.ts",
	"shared/i18n-locales.ts",
]);
const PURE_NATIVE_IMPORTS = new Set([
	"bun",
	"bun:sqlite",
	"crypto",
	"node:crypto",
	"path",
	"node:path",
	"buffer",
	"node:buffer",
	"util",
	"node:util",
]);
function modulePath(path: string): string {
	return relative(ROOT, resolve(ROOT, path)).split(sep).join("/");
}
function sourceViolations(meta: Bun.BuildMetafile, entries: string[] = []): string[] {
	const allowedEntries = new Set(entries.map(modulePath));
	return Object.keys(meta.inputs)
		.map(modulePath)
		.filter((path) => {
			if (
				path.startsWith("node_modules/") ||
				path.includes("/node_modules/") ||
				allowedEntries.has(path)
			)
				return false;
			if (
				path.startsWith("server/lib/db-worker/") &&
				!path.includes("/__tests__/") &&
				!path.endsWith(".test.ts")
			)
				return false;
			return !PURE_MODULES.has(path);
		});
}
function retainedImports(source: string): string[] {
	const file = ts.createSourceFile(
		"worker-bundle.js",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const imports: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		)
			imports.push(node.moduleSpecifier.text);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					["require", "__require"].includes(node.expression.text)) ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require"))
		) {
			const target = node.arguments[0];
			if (target && ts.isStringLiteralLike(target)) imports.push(target.text);
			else if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
				imports.push("<dynamic-module-path>");
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return imports;
}

describe("db read worker module boundary", () => {
	test("numeric observation helper has no initialization dependencies or logging sink", async () => {
		const entry = join(ROOT, "server/lib/db-worker/read-budget.ts");
		const build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true });
		expect(build.success).toBe(true);
		if (!build.metafile) throw new Error("Observation helper did not produce a dependency graph");
		expect(Object.keys(build.metafile.inputs).map(modulePath)).toEqual([
			"server/lib/db-worker/read-budget.ts",
		]);
	});
	test("compiled reader executes the embedded worker outside the source tree", async () => {
		const source = mkdtempSync(join(ROOT, ".narrafork/reader-compile-"));
		const output = mkdtempSync(join(tmpdir(), "nf-reader-binary-"));
		const databasePath = join(output, "fixture.db");
		const database = new Database(databasePath);
		database.run("CREATE TABLE marker(value TEXT)");
		database.run("INSERT INTO marker VALUES ('embedded')");
		database.run("CREATE TABLE narrator_messages(id TEXT,role TEXT,content_json TEXT)");
		database.run(
			"CREATE TABLE narrator_message_refs(narrator_id TEXT,message_id TEXT,seq INTEGER,is_compact INTEGER)",
		);
		database.close();
		try {
			const entry = join(source, "probe.ts");
			writeFileSync(
				entry,
				`import { runReadTask, drainDbWorkerPool } from "../../server/lib/db-worker/pool";
import { NotFoundError } from "../../server/lib/errors";
const probe = await runReadTask(process.argv[2], { kind: "domainRead", task: "readerProbe", input: null }, { timeoutMs: 10000 });
const rows = await runReadTask(process.argv[2], { kind: "selectRows", sql: "SELECT value FROM marker", params: [], maxRows: 1 }, { timeoutMs: 10000 });
const businessError = await runReadTask(process.argv[2], { kind: "domainRead", task: "narratorCompactSummary", input: { narratorId: "n", messageId: "missing" } }, { timeoutMs: 10000 }).then(() => null, error => ({ statusCode: error.statusCode, code: error.code, notFound: error instanceof NotFoundError }));
console.log(JSON.stringify({ probe, rows, businessError }));
await drainDbWorkerPool({ timeoutMs: 5000 });
`,
			);
			const executable = join(output, process.platform === "win32" ? "reader.exe" : "reader");
			const build = await safeSpawn({
				cmd: [process.execPath, "build", "--compile", "--outfile", executable, entry, WORKER_ENTRY],
				cwd: ROOT,
				timeout: 60000,
				maxOutputBytes: 1024 * 1024,
			});
			expect(build.exitCode, build.stderr).toBe(0);
			const run = await safeSpawn({
				cmd: [executable, databasePath],
				cwd: output,
				timeout: 20000,
				maxOutputBytes: 64 * 1024,
				env: { ...process.env, NARRAFORK_DB_WORKER: "on", NARRAFORK_DB_WORKER_CONCURRENCY: "2" },
			});
			expect(run.exitCode, run.stderr).toBe(0);
			expect(JSON.parse(run.stdout.trim())).toEqual({
				probe: { ready: true },
				rows: { columns: ["value"], rows: [["embedded"]] },
				businessError: { statusCode: 404, code: "NOT_FOUND", notFound: true },
			});
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(output, { recursive: true, force: true });
		}
	}, 90000);
	test("worker entry bundles without reaching the database bootstrap", async () => {
		const build = await Bun.build({
			entrypoints: [WORKER_ENTRY],
			target: "bun",
		});

		expect(build.success).toBe(true);
		expect(build.outputs.length).toBeGreaterThan(0);

		const bundled = await build.outputs[0].text();
		const leaked = FORBIDDEN_SYMBOLS.filter((symbol) => bundled.includes(symbol));
		expect(leaked).toEqual([]);
	}, 60_000);

	test("fixed lazy domain modules resolve only approved pure dependencies", async () => {
		const build = await Bun.build({ entrypoints: [WORKER_ENTRY], target: "bun", metafile: true });
		expect(build.success).toBe(true);
		expect(build.metafile).toBeDefined();
		if (!build.metafile) throw new Error("Worker build did not produce a dependency graph");
		expect(sourceViolations(build.metafile)).toEqual([]);
		const inputs = Object.keys(build.metafile.inputs).map(modulePath);
		expect(inputs).toContain("server/db/schema.ts");
		const registry = Object.entries(build.metafile.inputs).find(
			([path]) => modulePath(path) === "server/lib/db-worker/domain-task-registry.ts",
		)?.[1];
		if (!registry) throw new Error("Worker graph omitted the static domain registry");
		const targets = [
			...new Set(
				registry.imports
					.filter((entry) => entry.kind === "dynamic-import")
					.map((entry) => modulePath(entry.entryPoint ?? entry.path)),
			),
		].sort();
		expect(targets).toEqual([...DOMAIN_MODULES].sort());
		// Inputs can contain an elided unused import; inspect retained output imports as well.
		for (const output of build.outputs) {
			const retained = retainedImports(await output.text());
			expect(retained.filter((path) => !PURE_NATIVE_IMPORTS.has(path))).toEqual([]);
		}
	}, 60_000);

	test("dependency allowlist rejects real settings and database-bootstrap imports", async () => {
		const fixture = mkdtempSync(join(ROOT, ".narrafork/reader-boundary-"));
		try {
			for (const forbidden of ["server/lib/settings/index.ts", "server/db/index.ts"]) {
				const entry = join(fixture, "probe.ts");
				writeFileSync(
					entry,
					`import * as forbidden from ${JSON.stringify(join(ROOT, forbidden))}; console.log(forbidden);`,
				);
				const build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true });
				expect(build.success).toBe(true);
				if (!build.metafile) throw new Error("Negative probe did not produce a dependency graph");
				expect(sourceViolations(build.metafile, [entry])).toContain(forbidden);
			}
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}, 60_000);

	test("the shared query module itself stays free of the db singleton", async () => {
		const build = await Bun.build({
			entrypoints: [join(ROOT, "server/services/storage-scan-queries.ts")],
			target: "bun",
		});
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();
		for (const symbol of FORBIDDEN_SYMBOLS) {
			expect(bundled).not.toContain(symbol);
		}
	}, 60_000);

	/**
	 * The storage-scan port is a MAIN-THREAD abstraction, and it must stay on that side.
	 *
	 * Its SQLite adapter reaches `database-cleanup-service`, which imports `@server/db` — so the
	 * moment the worker's graph touches the port it inherits the whole bootstrap the tests above
	 * exist to keep out. The symbol checks would eventually catch that, but only as a confusing
	 * failure about `ensureFts`; naming the port here makes the actual mistake ("the worker imported
	 * the orchestration layer") legible at the point it is made.
	 */
	test("worker entry does not bundle the storage port or the cleanup service", async () => {
		const build = await Bun.build({ entrypoints: [WORKER_ENTRY], target: "bun" });
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();

		for (const symbol of [
			"databaseStoragePort",
			"sqliteDatabaseStoragePort",
			"enforceReportLimits",
			"runWithScanBudget",
			"databaseCleanupService",
			"scanDatabaseBreakdown",
		]) {
			expect(bundled, `worker entry must not bundle ${symbol}`).not.toContain(symbol);
		}
	}, 60_000);

	/**
	 * The port is dialect-free, so it must also be bootstrap-free.
	 *
	 * Asserted on the PORT rather than only on the adapter because the port is what a future
	 * PostgreSQL implementation imports: if the contract module itself dragged in the SQLite
	 * bootstrap, every backend would inherit it no matter how careful its own adapter was.
	 */
	test("the storage port carries neither the db bootstrap nor a driver", async () => {
		const build = await Bun.build({
			entrypoints: [join(ROOT, "server/services/storage/database-storage-port.ts")],
			target: "bun",
		});
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();

		for (const symbol of FORBIDDEN_SYMBOLS) {
			expect(bundled, `the port must not reach ${symbol}`).not.toContain(symbol);
		}
		expect(bundled).not.toContain("bun:sqlite");
		expect(bundled).not.toContain("drizzle-orm");
		// Guard against a vacuous pass: the bundle must actually contain the port's own code.
		expect(bundled).toContain("enforceReportLimits");
		expect(bundled).toContain("runWithScanBudget");
	}, 60_000);
});
