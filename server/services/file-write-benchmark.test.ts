/**
 * Explicit, isolated performance experiment; ordinary regression runs skip it.
 *
 * NF_FILE_WRITE_BENCH=1 NF_FILE_WRITE_BENCH_BASELINE=/path/to/read-only/checkout \
 *   bun test --isolate server/services/file-write-benchmark.test.ts
 *
 * The SAME worker source loads each checkout's real production modules through
 * its tsconfig aliases. Each worker owns a temporary HOME, an empty migrated
 * schema copy, real files and real Write calls. Initialization, payload/context
 * construction and result verification are outside the measured write interval.
 * No timing assertion is a regression gate. SQL metrics count Drizzle executions
 * and SQLite prepare calls, not the native driver's implicit BEGIN/COMMIT.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, cpus, loadavg, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext, ToolExecutionTarget } from "@server/lib/agent/types";
import type { LocalFileChangeRuntimeOptions } from "@server/services/file-change-runtime";

const MARKER = "FILE_WRITE_BENCHMARK_RESULT ";
const OUTPUT_LIMIT = 1024 * 1024;
const HEARTBEAT_MS = 2;
const MODULES = [
	"@server/db",
	"@server/db/schema",
	"@server/db/relations",
	"@server/services/file-change-runtime",
	"@server/services/file-change-local-io",
	"@server/services/file-change-evidence",
	"@server/services/file-change-blob-catalog",
	"@server/services/file-change-blob-store",
	"@server/lib/agent/execution/local-backend",
	"@server/lib/agent/tools/write",
	"@shared/file-change-protocol",
] as const;

type WorkerInput = {
	label: string;
	checkout: string;
	sandbox: string;
	iterations: number;
	warmups: number;
	revision: string;
};
type Sample = {
	elapsedMs: number;
	sqlCalls: number;
	prepareCalls: number;
	fullReads: number;
	barrierSqlCalls: number;
	eventLoopMaxMs: number;
	eventLoopTicks: number;
};
type Series = { bytes: number; samples: Sample[]; loadStart: number[]; loadEnd: number[] };
type WorkerReport = {
	label: string;
	revision: string;
	evidenceVersion: number;
	bunVersion: string;
	checkout: string;
	modulePaths: Record<string, string>;
	sourceFingerprint: string;
	sourcesModifiedSinceHead: boolean;
	cpu: string;
	parallelism: number;
	fixtureSetupMs: number;
	series: Series[];
};

function boundedInteger(
	input: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	const value = input === undefined ? fallback : Number(input);
	assert(
		Number.isSafeInteger(value) && value >= min && value <= max,
		`Expected integer ${min}..${max}`,
	);
	return value;
}
function sha(bytes: Uint8Array | string) {
	return createHash("sha256").update(bytes).digest("hex");
}
function percentile(values: number[], q: number) {
	assert(values.length > 0);
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}
function round(value: number) {
	return Number(value.toFixed(3));
}
function summarize(samples: Sample[]) {
	const distribution = (key: keyof Sample) => ({
		p50: round(
			percentile(
				samples.map((sample) => sample[key]),
				0.5,
			),
		),
		p95: round(
			percentile(
				samples.map((sample) => sample[key]),
				0.95,
			),
		),
		max: round(Math.max(...samples.map((sample) => sample[key]))),
	});
	return {
		writes: samples.length,
		latencyMs: distribution("elapsedMs"),
		sqlCalls: distribution("sqlCalls"),
		prepareCalls: distribution("prepareCalls"),
		fullReads: distribution("fullReads"),
		barrierSqlCalls: distribution("barrierSqlCalls"),
		eventLoopMaxMs: distribution("eventLoopMaxMs"),
		eventLoopTicks: samples.reduce((total, sample) => total + sample.eventLoopTicks, 0),
	};
}

async function capture(
	command: string[],
	options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number },
) {
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, options.timeoutMs);
	const consume = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > OUTPUT_LIMIT) {
					child.kill();
					throw new Error("Benchmark subprocess exceeded 1 MiB output");
				}
				chunks.push(next.value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			consume(child.stdout),
			consume(child.stderr),
			child.exited,
		]);
		assert(!timedOut, `Benchmark subprocess exceeded ${options.timeoutMs}ms`);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
}

async function revision(checkout: string) {
	const result = await capture(["git", "-C", checkout, "rev-parse", "HEAD"], {
		cwd: checkout,
		timeoutMs: 5000,
	});
	assert.equal(result.exitCode, 0, result.stderr.slice(-2000));
	const value = result.stdout.trim();
	assert(/^[a-f0-9]{40}$/.test(value));
	return value;
}
async function resolvedSources(checkout: string) {
	const paths: Record<string, string> = {};
	for (const specifier of MODULES) {
		const path = await realpath(fileURLToPath(import.meta.resolve(specifier)));
		assert(
			path.startsWith(`${checkout}${sep}`),
			`Alias escaped selected checkout: ${specifier} -> ${path}`,
		);
		paths[specifier] = path;
	}
	return paths;
}
async function fingerprint(paths: Record<string, string>, checkout: string) {
	const records: [string, string][] = [];
	for (const [name, path] of [...Object.entries(paths), ["bun.lock", join(checkout, "bun.lock")]]) {
		assert((await stat(path)).size <= 4 * 1024 * 1024, "Source fingerprint input exceeds 4 MiB");
		records.push([name, sha(await readFile(path))]);
	}
	return sha(JSON.stringify(records));
}

async function runWorker(input: WorkerInput): Promise<WorkerReport> {
	const setupStarted = performance.now();
	assert(isAbsolute(input.checkout) && isAbsolute(input.sandbox));
	assert(basename(input.sandbox).startsWith("nf-file-write-benchmark-"));
	assert.equal(await realpath(input.sandbox), input.sandbox);
	assert.equal(await realpath(input.checkout), input.checkout);
	assert.equal(process.env.NODE_ENV, "test");
	assert.equal(process.env.NARRAFORK_TEST, "1");
	assert.equal(process.env.NARRAFORK_HOME, join(input.sandbox, "home", ".narrafork"));
	assert.equal(process.env.HOME, join(input.sandbox, "home"));
	assert.equal(process.env.NF_DATABASE_BACKEND, "sqlite");
	assert.equal(await revision(input.checkout), input.revision);
	const modulePaths = await resolvedSources(input.checkout);
	const sourceFingerprint = await fingerprint(modulePaths, input.checkout);
	const sourceDiff = await capture(
		[
			"git",
			"-C",
			input.checkout,
			"diff",
			"--quiet",
			"HEAD",
			"--",
			...Object.values(modulePaths).map((path) => relative(input.checkout, path)),
		],
		{ cwd: input.checkout, timeoutMs: 5000 },
	);
	assert(sourceDiff.exitCode === 0 || sourceDiff.exitCode === 1, sourceDiff.stderr.slice(-2000));
	const sourcesModifiedSinceHead = sourceDiff.exitCode === 1;
	if (input.label === "baseline")
		assert(!sourcesModifiedSinceHead, "Baseline production sources differ from HEAD");

	// All production imports are below the environment/path checks. Select packages
	// relative to the target runtime too, rather than borrowing the other checkout.
	const requireFromRuntime = createRequire(modulePaths["@server/services/file-change-runtime"]);
	const { drizzle } = (await import(
		requireFromRuntime.resolve("drizzle-orm/bun-sqlite")
	)) as typeof import("drizzle-orm/bun-sqlite");
	const { eq } = (await import(
		requireFromRuntime.resolve("drizzle-orm")
	)) as typeof import("drizzle-orm");
	const sourceDb = await import("@server/db");
	const schema = await import("@server/db/schema");
	const relations = await import("@server/db/relations");
	const { localBackend } = await import("@server/lib/agent/execution/local-backend");
	const { writeTool } = await import("@server/lib/agent/tools/write");
	const { createFileChangeLocalIo } = await import("@server/services/file-change-local-io");
	const { LocalFileChangeRuntime, withLocalFileChangeRuntime } = await import(
		"@server/services/file-change-runtime"
	);
	const { FILE_CHANGE_EVIDENCE_VERSION } = await import("@shared/file-change-protocol");
	const evidenceVersion = Number(FILE_CHANGE_EVIDENCE_VERSION);
	const helper = new URL(
		"../../tests/sqlite-schema-image.ts",
		`file://${modulePaths["@server/services/file-change-runtime"]}`,
	).href;
	const { openSchemaCopyAt } = (await import(
		helper
	)) as typeof import("../../tests/sqlite-schema-image");
	const sqlite = openSchemaCopyAt(sourceDb.sqlite, join(input.sandbox, "file-history.sqlite"));
	sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	const workspace = join(input.sandbox, "workspace");
	const privateRoot = join(input.sandbox, "private");
	await mkdir(workspace, { mode: 0o700 });
	let active = false;
	let sqlCalls = 0;
	let prepareCalls = 0;
	let fullReads = 0;
	let barrierSqlCalls = 0;
	const db = drizzle({
		client: sqlite,
		schema: { ...schema, ...relations },
		logger: {
			logQuery(query) {
				if (!active) return;
				sqlCalls++;
				if (/workspace_write_lease(?:s|_ranges)/.test(query)) barrierSqlCalls++;
			},
		},
	});
	const nativePrepare = sqlite.prepare;
	sqlite.prepare = ((...args: unknown[]) => {
		if (active) prepareCalls++;
		return Reflect.apply(nativePrepare, sqlite, args);
	}) as typeof sqlite.prepare;
	const io = createFileChangeLocalIo({
		lstat,
		mkdir,
		async open(...args) {
			const handle = await open(...args);
			return {
				stat: (options) => handle.stat(options),
				read(buffer, offset, length, position) {
					if (active && position === 0) fullReads++;
					return handle.read(buffer, offset, length, position);
				},
				write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
				truncate: (length) => handle.truncate(length),
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
		},
	});
	const runtimeOptions: LocalFileChangeRuntimeOptions & { coordinatorState?: unknown } = {
		db,
		privateRoot,
		io,
		blobStoreOptions: { minimumFreeBytes: 0 },
	};
	if (evidenceVersion === 2) {
		const legacyPath = fileURLToPath(
			import.meta.resolve("@server/services/workspace-write-coordinator"),
		);
		assert(legacyPath.startsWith(`${input.checkout}${sep}`));
		const legacy = (await import(legacyPath)) as {
			createWorkspaceWriteCoordinatorState(): unknown;
		};
		runtimeOptions.coordinatorState = legacy.createWorkspaceWriteCoordinatorState();
	} else
		assert.equal(evidenceVersion, 3, "Unexpected evidence version; review benchmark comparability");
	const runtime = new LocalFileChangeRuntime(runtimeOptions);
	const narratorId = randomUUID();
	const timestamp = new Date().toISOString();
	db.insert(schema.narrators)
		.values({
			id: narratorId,
			title: "Isolated benchmark",
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	await runtime.initialize();
	const fixtureSetupMs = performance.now() - setupStarted;
	let lastTick = performance.now();
	let eventLoopMaxMs = 0;
	let eventLoopTicks = 0;
	const observeDelay = (now: number) => {
		eventLoopMaxMs = Math.max(eventLoopMaxMs, Math.max(0, now - lastTick - HEARTBEAT_MS));
		eventLoopTicks++;
		lastTick = now;
	};
	const heartbeat = setInterval(() => {
		const now = performance.now();
		if (active) observeDelay(now);
		else lastTick = now;
	}, HEARTBEAT_MS);
	const series: Series[] = [];
	try {
		for (const bytes of [4096, 1024 * 1024]) {
			const path = join(workspace, `sample-${bytes}.txt`);
			const payload = (sequence: number) => {
				const prefix = `version-${String(sequence).padStart(10, "0")}\n`;
				return prefix + "x".repeat(bytes - prefix.length);
			};
			await writeFile(path, payload(0), { mode: 0o644 });
			const samples: Sample[] = [];
			let loadStart: number[] = [];
			for (let index = 0; index < input.warmups + input.iterations; index++) {
				const content = payload(index + 1);
				const toolCallId = randomUUID();
				const messageId = randomUUID();
				const toolUseId = randomUUID();
				const resolved = await localBackend.resolvePathIdentity(path);
				const target: ToolExecutionTarget = Object.freeze({
					deviceId: "local",
					backendKind: "local",
					cwd: workspace,
					pathFlavor: localBackend.pathFlavor,
					lexicalPath: resolved.lexicalPath,
					canonicalPath: resolved.canonicalPath,
					runtimeGeneration: 0,
					selectionSource: "local_default",
				});
				const now = new Date().toISOString();
				db.insert(schema.narratorMessages)
					.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: now })
					.run();
				db.insert(schema.narratorToolCalls)
					.values({
						id: toolCallId,
						narratorId,
						messageId,
						toolUseId,
						toolName: "Write",
						status: "running",
						executionIdentityVersion: 1,
						executionAttempt: 1,
						executionStartedAt: now,
						executionDeviceId: "local",
						executionCwd: workspace,
						executionPathFlavor: localBackend.pathFlavor,
						resolvedFilePath: target.lexicalPath,
						canonicalFilePath: target.canonicalPath,
						runtimeGeneration: 0,
						createdAt: now,
					})
					.run();
				const context: ToolContext = {
					narratorId,
					cwd: workspace,
					locale: "en",
					signal: new AbortController().signal,
					currentToolUseId: toolUseId,
					toolCallBinding: Object.freeze({ toolCallId, attempt: 1 }),
					executionTarget: target,
					resolveBackend: () => localBackend,
					requestPermission: async () => ({ behavior: "allow" }),
				};
				if (index === input.warmups) loadStart = loadavg();
				sqlCalls = 0;
				prepareCalls = 0;
				fullReads = 0;
				barrierSqlCalls = 0;
				eventLoopMaxMs = 0;
				eventLoopTicks = 0;
				lastTick = performance.now();
				const started = lastTick;
				active = true;
				let result: Awaited<ReturnType<typeof writeTool.execute>>;
				let elapsedMs: number;
				try {
					result = await withLocalFileChangeRuntime(runtime, () =>
						writeTool.execute({ file_path: path, content }, context),
					);
				} finally {
					const ended = performance.now();
					elapsedMs = ended - started;
					observeDelay(ended);
					active = false;
				}
				assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 2000));
				const sample: Sample = {
					elapsedMs,
					sqlCalls,
					prepareCalls,
					fullReads,
					barrierSqlCalls,
					eventLoopMaxMs,
					eventLoopTicks,
				};
				assert.equal(
					await readFile(path, "utf8"),
					content,
					"Real file content must match the write",
				);
				const operation = db
					.select()
					.from(schema.fileChangeOperations)
					.where(eq(schema.fileChangeOperations.toolCallId, toolCallId))
					.get();
				assert(operation, "A successful benchmark write must have real history");
				assert.equal(operation.evidenceVersion, evidenceVersion);
				assert.equal(operation.executionOutcome, "succeeded");
				assert.equal(operation.settlement, "settled");
				const effects = db
					.select({
						outcome: schema.fileChangeEffects.outcome,
						settlement: schema.fileChangeEffects.settlement,
					})
					.from(schema.fileChangeEffects)
					.where(eq(schema.fileChangeEffects.operationId, operation.id))
					.limit(2)
					.all();
				assert.deepEqual(effects, [{ outcome: "changed", settlement: "settled" }]);
				if (index >= input.warmups) samples.push(sample);
			}
			series.push({ bytes, samples, loadStart, loadEnd: loadavg() });
		}
		assert.equal(
			await fingerprint(modulePaths, input.checkout),
			sourceFingerprint,
			"Checkout changed during the worker measurement",
		);
		return {
			label: input.label,
			revision: input.revision,
			evidenceVersion,
			bunVersion: Bun.version,
			checkout: input.checkout,
			modulePaths,
			sourceFingerprint,
			sourcesModifiedSinceHead,
			cpu: cpus()[0]?.model ?? "unknown",
			parallelism: availableParallelism(),
			fixtureSetupMs,
			series,
		};
	} finally {
		active = false;
		clearInterval(heartbeat);
		sqlite.prepare = nativePrepare;
		const legacyRuntime = runtime as typeof runtime & {
			waitForNamespaceDrain?: () => Promise<void>;
		};
		await legacyRuntime.waitForNamespaceDrain?.();
		if (evidenceVersion === 2) {
			const cleanupModule = "@server/services/file-change-namespace-reset";
			const cleanup = (await import(cleanupModule)) as {
				waitForRetiredFileChangeCleanup(root: string): Promise<void>;
			};
			await cleanup.waitForRetiredFileChangeCleanup(privateRoot);
		}
		const { closeReadDatabase } = await import("@server/lib/db-worker/pool");
		await closeReadDatabase(sqlite.filename, { timeoutMs: 5000 });
		sqlite.close(true);
		sourceDb.markDatabaseCleanShutdown();
		sourceDb.sqlite.close(true);
	}
}

async function spawnWorker(
	checkout: string,
	label: string,
	iterations: number,
	warmups: number,
): Promise<WorkerReport> {
	const sandbox = await mkdtemp(join(await realpath(tmpdir()), "nf-file-write-benchmark-"));
	const home = join(sandbox, "home");
	await mkdir(home, { mode: 0o700 });
	const input: WorkerInput = {
		checkout,
		label,
		sandbox,
		iterations,
		warmups,
		revision: await revision(checkout),
	};
	try {
		const result = await capture(
			[
				process.execPath,
				"--no-env-file",
				"--no-install",
				"--tsconfig-override",
				join(checkout, "tsconfig.json"),
				import.meta.filename,
			],
			{
				cwd: checkout,
				timeoutMs: 180_000,
				env: {
					...process.env,
					NODE_ENV: "test",
					NARRAFORK_TEST: "1",
					NARRAFORK_ALLOW_MULTIPLE: "0",
					HOME: home,
					USERPROFILE: home,
					NARRAFORK_HOME: join(home, ".narrafork"),
					NF_DATABASE_BACKEND: "sqlite",
					NF_DATABASE_URL: "",
					DATABASE_URL: "",
					NF_FILE_WRITE_BENCH_WORKER: JSON.stringify(input),
				},
			},
		);
		assert.equal(
			result.exitCode,
			0,
			`${label} worker failed:\n${result.stderr.slice(-8000)}\n${result.stdout.slice(-4000)}`,
		);
		const reportLines = result.stdout.split("\n").filter((line) => line.startsWith(MARKER));
		assert.equal(reportLines.length, 1, "Worker must emit exactly one bounded report");
		const report = JSON.parse(reportLines[0].slice(MARKER.length)) as WorkerReport;
		assert.equal(report.label, label);
		assert.equal(report.revision, input.revision);
		return report;
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

const workerInput = process.env.NF_FILE_WRITE_BENCH_WORKER;
if (workerInput) {
	try {
		const input = JSON.parse(workerInput) as WorkerInput;
		boundedInteger(String(input.iterations), 16, 12, 64);
		boundedInteger(String(input.warmups), 3, 1, 8);
		const result = await runWorker(input);
		await Bun.write(Bun.stdout, `${MARKER}${JSON.stringify(result)}\n`);
		process.exit(0);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
} else if (process.env.NF_FILE_WRITE_BENCH_PROBE === "1") {
	const checkout = await realpath(
		process.env.NF_FILE_WRITE_BENCH_CHECKOUT ?? resolve(import.meta.dir, "../.."),
	);
	console.info(
		JSON.stringify({
			checkout,
			bunVersion: Bun.version,
			revision: await revision(checkout),
			modules: await resolvedSources(checkout),
		}),
	);
} else {
	const { test } = await import("bun:test");
	test.skipIf(process.env.NF_FILE_WRITE_BENCH !== "1")(
		"explicit isolated old/new real Write benchmark",
		async () => {
			const candidate = await realpath(resolve(import.meta.dir, "../.."));
			const baselineInput = process.env.NF_FILE_WRITE_BENCH_BASELINE;
			assert(baselineInput, "Set NF_FILE_WRITE_BENCH_BASELINE to an existing read-only checkout");
			const baseline = await realpath(baselineInput);
			assert.notEqual(candidate, baseline, "Old/new checkouts must be distinct");
			if (process.env.NF_FILE_WRITE_BENCH_BASELINE_REV)
				assert.equal(await revision(baseline), process.env.NF_FILE_WRITE_BENCH_BASELINE_REV);
			const iterations = boundedInteger(process.env.NF_FILE_WRITE_BENCH_SAMPLES, 16, 12, 64);
			const repeats = boundedInteger(process.env.NF_FILE_WRITE_BENCH_REPEATS, 2, 1, 3);
			const reports: WorkerReport[] = [];
			for (let repeat = 0; repeat < repeats; repeat++) {
				const order =
					repeat % 2 === 0
						? (["baseline", "candidate"] as const)
						: (["candidate", "baseline"] as const);
				for (const label of order)
					reports.push(
						await spawnWorker(label === "baseline" ? baseline : candidate, label, iterations, 3),
					);
			}
			for (const label of ["baseline", "candidate"] as const) {
				const selected = reports.filter((report) => report.label === label);
				assert.equal(
					new Set(selected.map((report) => report.sourceFingerprint)).size,
					1,
					`${label} source changed between rounds`,
				);
			}
			const summaries = ["baseline", "candidate"].map((label) => ({
				label,
				series: [4096, 1024 * 1024].map((bytes) => ({
					bytes,
					...summarize(
						reports
							.filter((report) => report.label === label)
							.flatMap((report) =>
								report.series
									.filter((series) => series.bytes === bytes)
									.flatMap((series) => series.samples),
							),
					),
				})),
			}));
			console.info(
				"file-write-benchmark",
				JSON.stringify({
					method:
						"sequential AB/BA; 3 warmups per size; fresh subprocess/HOME/memory DB; real Write/history; 2ms heartbeat including final synchronous tail",
					bounds: {
						samplesPerWorker: iterations,
						repeats,
						workerTimeoutMs: 180_000,
						outputBytesPerStream: OUTPUT_LIMIT,
					},
					summaries,
					runs: reports.map(({ series, ...report }) => ({
						...report,
						series: series.map(({ samples, ...series }) => ({
							...series,
							summary: summarize(samples),
							...(process.env.NF_FILE_WRITE_BENCH_DETAILS === "1" ? { samples } : {}),
						})),
					})),
				}),
			);
		},
		1_200_000,
	);
}
