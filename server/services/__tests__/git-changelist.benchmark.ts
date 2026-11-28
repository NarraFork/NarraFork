import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	GitStagingAction,
	GitStagingActionResult,
	GitStagingExpectedVersion,
	GitStagingFilesPage,
	GitStagingSummary,
	GitStagingVersion,
} from "../../../shared/git-staging-lists";
import { safeSpawn } from "../../lib/spawn";

/** Explicit benchmark entry, not a server request or a Worker fallback. Run with `bun <file>`. */
const sampleCount = 3;
const fileCounts = [100, 300];
const budgets = { init: 32, changedSync: 32, unchangedSync: 24, metadata: 0, files: 0 };
const maxStepMs = 60_000;
const traceMaxBytes = 4 * 1024 * 1024;
const sourceRoot = resolve(import.meta.dir, "../../..");
type Mode = "kernel" | "cli-worker";
type GroupRead = { snapshotVersion: string; pages: number };
type Fixture = {
	root: string;
	paths: string[];
	expected: Map<string, string>;
	nativeIndex: Buffer;
	head: Buffer;
	branchRef: Buffer;
};
type Client = {
	action(action: GitStagingAction): Promise<GitStagingActionResult>;
	summary(): Promise<GitStagingSummary>;
	files(listId: string, cursor?: string): Promise<GitStagingFilesPage>;
};
type Measurement = {
	mode: Mode;
	fileCount: number;
	phase: string;
	iteration: number;
	elapsedMs: number;
	gitCommands: string[][];
};
const measurements: Measurement[] = [];
const content = (path: string, revision: number) =>
	`${path} revision ${revision}\n${Array.from({ length: 32 }, (_, n) => `${path} stable line ${n}\n`).join("")}`;

function fixtureEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	delete env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}
async function fixtureGit(root: string, ...args: string[]) {
	const result = await safeSpawn({
		cmd: ["git", "-C", root, ...args],
		env: fixtureEnv(),
		timeout: 20_000,
		maxOutputBytes: 65_536,
	});
	assert.equal(result.exitCode, 0, result.stderr);
	return result.stdout.trim();
}
async function changeFiles(fixture: Fixture, paths: string[], revision: number) {
	for (const path of paths) {
		const text = content(path, revision);
		await writeFile(join(fixture.root, path), text);
		fixture.expected.set(path, text);
	}
}
async function createFixture(fileCount: number): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "nf-changelist-benchmark-"));
	try {
		await fixtureGit(root, "init", "--quiet", "--initial-branch=main");
		await fixtureGit(root, "config", "user.name", "Changelist benchmark");
		await fixtureGit(root, "config", "user.email", "fixture@example.test");
		const paths = Array.from(
			{ length: fileCount },
			(_, n) => `file-${String(n).padStart(4, "0")}.txt`,
		);
		for (const path of paths) await writeFile(join(root, path), content(path, 0));
		await fixtureGit(root, "add", "--all");
		await fixtureGit(root, "commit", "--quiet", "-m", "Fixture baseline");
		const fixture: Fixture = {
			root,
			paths,
			expected: new Map(),
			nativeIndex: await readFile(join(root, ".git", "index")),
			head: await readFile(join(root, ".git", "HEAD")),
			branchRef: await readFile(join(root, ".git", "refs", "heads", "main")),
		};
		await changeFiles(fixture, paths, 1);
		return fixture;
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
function version(state: GitStagingVersion): GitStagingExpectedVersion {
	assert.ok(state.observationId, "A complete observation must identify every ownership write");
	return { expectedGeneration: state.generation, observationId: state.observationId };
}
async function createClient(fixture: Fixture, mode: Mode): Promise<Client> {
	if (mode === "kernel") {
		const { IndependentGitStagingKernel } = await import("../git-staging-kernel");
		const kernel = new IndependentGitStagingKernel(fixture.root, "benchmark");
		return {
			action: (action) => kernel.action(action),
			summary: () => kernel.summary(),
			files: (listId, cursor) => kernel.files(listId, { cursor, limit: 200 }),
		};
	}
	async function cli<T>(args: string[]): Promise<T> {
		const result = await safeSpawn({
			cmd: [
				process.execPath,
				join(sourceRoot, "server", "index.ts"),
				"changelists",
				"--workspace",
				fixture.root,
				...args,
			],
			env: { ...fixtureEnv(), GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT },
			timeout: maxStepMs,
			maxOutputBytes: 1024 * 1024,
			maxStderrBytes: 65_536,
			killProcessTree: true,
		});
		assert.equal(result.exitCode, 0, result.stderr);
		const response = JSON.parse(result.stdout) as { ok: boolean; result: T };
		assert.equal(response.ok, true);
		return response.result;
	}
	return {
		async action(action) {
			const request = join(fixture.root, ".git", "benchmark-request.json");
			await writeFile(request, JSON.stringify(action));
			return cli<GitStagingActionResult>([action.action, "--json-input", request]);
		},
		summary: () => cli<GitStagingSummary>(["list"]),
		files: (listId, cursor) =>
			cli<GitStagingFilesPage>([
				"files",
				"--list",
				listId,
				"--limit",
				"200",
				...(cursor ? ["--cursor", cursor] : []),
			]),
	};
}
async function assertFixtureUnchanged(fixture: Fixture) {
	assert.deepEqual(
		await readFile(join(fixture.root, ".git", "index")),
		fixture.nativeIndex,
		"Native index bytes changed",
	);
	assert.deepEqual(
		await readFile(join(fixture.root, ".git", "HEAD")),
		fixture.head,
		"HEAD bytes changed",
	);
	assert.deepEqual(
		await readFile(join(fixture.root, ".git", "refs", "heads", "main")),
		fixture.branchRef,
		"Branch tip changed",
	);
	for (let offset = 0; offset < fixture.paths.length; offset += 32) {
		await Promise.all(
			fixture.paths.slice(offset, offset + 32).map(async (path) => {
				assert.equal(
					await readFile(join(fixture.root, path), "utf8"),
					fixture.expected.get(path),
					`Worktree bytes changed: ${path}`,
				);
			}),
		);
	}
}
async function measure<T>(
	fixture: Fixture,
	mode: Mode,
	phase: string,
	iteration: number,
	maxCommands: number,
	run: () => Promise<T>,
): Promise<T> {
	const trace = join(fixture.root, ".git", "benchmark-trace.jsonl");
	await writeFile(trace, "");
	const previousTrace = process.env.GIT_TRACE2_EVENT;
	process.env.GIT_TRACE2_EVENT = trace;
	let result: T;
	const started = performance.now();
	let elapsedMs: number;
	try {
		result = await run();
		elapsedMs = performance.now() - started;
	} finally {
		if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
		else process.env.GIT_TRACE2_EVENT = previousTrace;
	}
	assert.ok(elapsedMs < maxStepMs, `${phase} exceeded its ${maxStepMs}ms wall-time budget`);
	assert.ok((await lstat(trace)).size <= traceMaxBytes, "Trace output exceeded its byte budget");
	const gitCommands = (await readFile(trace, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
		.filter((event) => event.event === "start")
		.map((event) => {
			assert.ok(event.argv?.length);
			assert.ok(
				/^git(?:\.exe)?$/.test(basename(event.argv[0] as string)),
				JSON.stringify(event.argv),
			);
			return event.argv;
		});
	assert.ok(
		gitCommands.length <= maxCommands,
		`${mode}/${fixture.paths.length}/${phase}: ${gitCommands.length} Git commands exceeds ${maxCommands}`,
	);
	if (maxCommands > 0) assert.ok(gitCommands.length > 0, "The real Git trace must not be empty");
	measurements.push({
		mode,
		fileCount: fixture.paths.length,
		phase,
		iteration,
		elapsedMs,
		gitCommands,
	});
	await assertFixtureUnchanged(fixture);
	return result;
}
async function readGroup(
	client: Client,
	listId: string,
	expectedPaths: string[],
): Promise<GroupRead> {
	const files: GitStagingFilesPage["files"] = [];
	let cursor: string | undefined;
	let identity: string | undefined;
	for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
		const page = await client.files(listId, cursor);
		assert.equal(page.listId, listId);
		assert.ok(page.snapshotVersion);
		if (identity) assert.equal(page.snapshotVersion, identity);
		identity = page.snapshotVersion;
		assert.equal(page.complete, page.nextCursor === null);
		assert.equal(page.stats.complete, true);
		assert.deepEqual(
			page.stats.total,
			expectedPaths.length
				? {
						M: {
							files: expectedPaths.length,
							added: expectedPaths.length,
							removed: expectedPaths.length,
							binaryFiles: 0,
							gitlinkFiles: 0,
						},
					}
				: {},
		);
		for (const file of page.files) {
			assert.equal(file.status, "M");
			assert.ok(file.fileId);
			assert.equal(file.unitCount, 1);
			assert.equal(file.needsReviewCount, 0);
			assert.deepEqual(file.stats, { kind: "text", added: 1, removed: 1 });
		}
		files.push(...page.files);
		if (page.nextCursor === null) {
			assert.deepEqual(files.map((file) => file.path).sort(), expectedPaths.toSorted());
			assert.equal(new Set(files.map((file) => file.fileId)).size, files.length);
			return { snapshotVersion: identity, pages: pageNumber + 1 };
		}
		assert.ok(page.files.length > 0);
		assert.notEqual(page.nextCursor, cursor);
		cursor = page.nextCursor;
	}
	assert.fail("Fixture exceeded the bounded pagination budget");
}
function assertSqlite(fixture: Fixture, summary: GitStagingSummary) {
	const db = new Database(
		join(fixture.root, ".git", "narrafork", "changelists", "changelists.sqlite"),
		{ readonly: true },
	);
	try {
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; BEGIN");
		const state = db
			.query("SELECT generation,observation_id,active_list_id,state FROM v_workspace_state LIMIT 1")
			.get() as {
			generation: number;
			observation_id: string;
			active_list_id: string;
			state: string;
		};
		assert.deepEqual(state, {
			generation: summary.generation,
			observation_id: summary.observationId,
			active_list_id: summary.activeListId,
			state: "ready",
		});
		const rows = db
			.query(
				"SELECT COUNT(*) units,COUNT(DISTINCT unit_id) unique_units,COUNT(DISTINCT path) files,SUM(needs_review) needs_review FROM v_changes",
			)
			.get() as { units: number; unique_units: number; files: number; needs_review: number };
		assert.deepEqual(rows, {
			units: fixture.paths.length,
			unique_units: fixture.paths.length,
			files: fixture.paths.length,
			needs_review: 0,
		});
		const lists = db
			.query("SELECT id,file_count,unit_count FROM v_changelists ORDER BY id LIMIT 10")
			.all() as { id: string; file_count: number; unit_count: number }[];
		assert.deepEqual(
			lists,
			summary.lists
				.map((list) => ({ id: list.id, file_count: list.fileCount, unit_count: list.unitCount }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
	} finally {
		db.close();
	}
}
async function workflow(fileCount: number, mode: Mode) {
	const fixture = await createFixture(fileCount);
	try {
		const client = await createClient(fixture, mode);
		const timed = <T>(phase: string, iteration: number, budget: number, run: () => Promise<T>) =>
			measure(fixture, mode, phase, iteration, budget, run);
		let state = await timed("init", 0, budgets.init, () => client.action({ action: "init" }));
		assert.equal(state.outcome, "applied");
		let summary = await timed("summary", 0, budgets.files, () => client.summary());
		assert.equal(summary.initialized, true);
		assert.equal(summary.state, "ready");
		assert.equal(summary.lists.length, 1);
		const activeId = summary.activeListId;
		assert.ok(activeId);
		assert.equal(summary.lists[0]?.name, "Changes");
		assert.equal(summary.lists[0]?.fileCount, fileCount);
		assertSqlite(fixture, summary);
		state = await timed("create", 1, budgets.metadata, () =>
			client.action({ action: "create", name: "A", ...version(state) }),
		);
		assert.equal(state.outcome, "applied");
		const primaryId = state.listId;
		assert.ok(primaryId);
		state = await timed("create", 2, budgets.metadata, () =>
			client.action({ action: "create", name: "B", ...version(state) }),
		);
		assert.equal(state.outcome, "applied");
		const otherId = state.listId;
		assert.ok(otherId);
		const primaryPaths = fixture.paths.slice(0, fileCount * 0.8);
		const otherPaths = fixture.paths.slice(primaryPaths.length, fileCount * 0.9);
		const activePaths = fixture.paths.slice(primaryPaths.length + otherPaths.length);
		state = await timed("move", 0, budgets.metadata, () =>
			client.action({
				action: "move",
				fromListId: activeId,
				toListId: primaryId,
				paths: primaryPaths,
				...version(state),
			}),
		);
		assert.equal(state.outcome, "applied");
		state = await timed("move-other", 0, budgets.metadata, () =>
			client.action({
				action: "move",
				fromListId: activeId,
				toListId: otherId,
				paths: otherPaths,
				...version(state),
			}),
		);
		assert.equal(state.outcome, "applied");
		const other = await timed("files-other", 0, budgets.files, () =>
			readGroup(client, otherId, otherPaths),
		);
		for (let iteration = 1; iteration <= sampleCount; iteration++) {
			await changeFiles(fixture, primaryPaths, iteration + 1);
			state = await timed("sync-changed", iteration, budgets.changedSync, () =>
				client.action({ action: "sync" }),
			);
			assert.equal(state.outcome, "applied");
			summary = await timed("summary", iteration, budgets.files, () => client.summary());
			const before = summary;
			state = await timed("sync-unchanged", iteration, budgets.unchangedSync, () =>
				client.action({ action: "sync" }),
			);
			assert.deepEqual(
				version(state),
				version(before),
				"Unchanged sync must preserve generation and observation",
			);
			summary = await timed("summary-unchanged", iteration, budgets.files, () => client.summary());
			assert.deepEqual(
				summary,
				before,
				"Unchanged sync must preserve scannedAt and local group versions",
			);
			const primary: GroupRead = await timed<GroupRead>("files", iteration, budgets.files, () =>
				readGroup(client, primaryId, primaryPaths),
			);
			if (fileCount === 300)
				assert.equal(primary.pages, 2, "The larger fixture must exercise continuation paging");
			await timed("files-active", iteration, budgets.files, () =>
				readGroup(client, activeId, activePaths),
			);
			assert.deepEqual(
				await timed<GroupRead>("files-other", iteration, budgets.files, () =>
					readGroup(client, otherId, otherPaths),
				),
				other,
				"Editing A must preserve B's content identity and ownership",
			);
			assertSqlite(fixture, summary);
			state = await timed("move-back", iteration, budgets.metadata, () =>
				client.action({
					action: "move",
					fromListId: primaryId,
					toListId: activeId,
					all: true,
					...version(state),
				}),
			);
			assert.equal(state.outcome, "applied");
			await timed("files-empty", iteration, budgets.files, () => readGroup(client, primaryId, []));
			state = await timed("move", iteration, budgets.metadata, () =>
				client.action({
					action: "move",
					fromListId: activeId,
					toListId: primaryId,
					paths: primaryPaths,
					...version(state),
				}),
			);
			assert.equal(state.outcome, "applied");
		}
		summary = await client.summary();
		assertSqlite(fixture, summary);
		const reinitialized = await timed("init-existing", 0, budgets.unchangedSync, () =>
			client.action({ action: "init" }),
		);
		assert.deepEqual(version(reinitialized), version(summary));
		assert.deepEqual(
			await client.summary(),
			summary,
			"Repeated init must preserve all lists and ownership",
		);
		await assertFixtureUnchanged(fixture);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
}
async function sourceFingerprint() {
	const paths = [
		"git-changelist-observer.ts",
		"git-changelist-store.ts",
		"git-changelist-ownership.ts",
		"git-staging-kernel.ts",
		"git-staging-process.ts",
		"git-staging-stats.ts",
		"git-staging-worker.ts",
		"git-changelist-cli.ts",
		"__tests__/git-changelist.benchmark.ts",
	];
	const hashes: Record<string, string> = {};
	for (const path of paths)
		hashes[path] = createHash("sha256")
			.update(await readFile(resolve(import.meta.dir, "..", path)))
			.digest("hex");
	return hashes;
}
function statistics() {
	const groups = new Map<string, Measurement[]>();
	for (const sample of measurements) {
		const key = `${sample.mode}/${sample.fileCount}/${sample.phase}`;
		groups.set(key, [...(groups.get(key) ?? []), sample]);
	}
	return [...groups].map(([key, samples]) => {
		const values = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
		const middle = Math.floor(values.length / 2);
		return {
			key,
			samples: samples.length,
			gitCalls: [...new Set(samples.map((sample) => sample.gitCommands.length))],
			medianMs:
				values.length % 2
					? values[middle]
					: ((values[middle - 1] as number) + (values[middle] as number)) / 2,
			p95Ms: values[Math.ceil(values.length * 0.95) - 1],
		};
	});
}
async function main() {
	const env = fixtureEnv();
	for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
	Object.assign(process.env, env);
	const sourceHashes = await sourceFingerprint();
	for (const mode of ["kernel", "cli-worker"] as const)
		for (const count of fileCounts) await workflow(count, mode);
	for (const mode of ["kernel", "cli-worker"] as const) {
		for (const phase of ["init", "sync-changed", "sync-unchanged", "move", "files"]) {
			const counts = fileCounts.map((fileCount) =>
				measurements
					.filter(
						(sample) =>
							sample.mode === mode && sample.fileCount === fileCount && sample.phase === phase,
					)
					.map((sample) => sample.gitCommands.length),
			);
			assert.deepEqual(
				counts[0],
				counts[1],
				`${mode}/${phase} must have constant Git command count across fixture sizes`,
			);
		}
	}
	assert.deepEqual(
		await sourceFingerprint(),
		sourceHashes,
		"Measured sources changed during the run",
	);
	const gitVersion = await safeSpawn({
		cmd: ["git", "--version"],
		timeout: 10_000,
		maxOutputBytes: 4096,
	});
	assert.equal(gitVersion.exitCode, 0, gitVersion.stderr);
	console.log(
		JSON.stringify(
			{
				version: 2,
				measuredAt: new Date().toISOString(),
				environment: {
					bun: Bun.version,
					git: gitVersion.stdout.trim(),
					platform: platform(),
					release: release(),
					architecture: process.arch,
					cpu: cpus()[0]?.model,
					logicalCpus: cpus().length,
				},
				fixture: {
					fileCounts,
					groups: 3,
					primaryShare: 0.8,
					otherShare: 0.1,
					changedLinesPerFile: { added: 1, removed: 1 },
				},
				method: {
					entry:
						"SQLite dynamic init/create/move, then repeated changed sync/unchanged sync/paged files",
					kernel: "Explicit core benchmark; import and fixture setup excluded from timing",
					cliWorker:
						"Real offline CLI and isolated Worker per request; includes startup and messaging",
					counting:
						"Git Trace2 start events from real bounded subprocesses; metadata/move/files must issue zero Git commands",
					checks:
						"Complete pages, exact per-file and group statistics, unique ownership, unchanged group version, no-op generation/observation/scannedAt, native index/HEAD/worktree byte preservation",
					percentile: "Nearest-rank P95 and arithmetic middle median",
					output: "stdout JSON only",
				},
				budgets: { gitCommands: budgets, stepTimeoutMs: maxStepMs, traceMaxBytes },
				sourceHashes,
				statistics: statistics(),
				measurements,
			},
			null,
			2,
		),
	);
}
await main();
