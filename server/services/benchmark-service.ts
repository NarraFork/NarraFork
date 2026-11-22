/**
 * Benchmark service — orchestrates one-shot agent evaluation runs.
 *
 * Flow: createSuite → createRun → executeRun (sequential tasks) → collect results.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { activeDatabaseBackend, db, postgresRuntime, sqlite } from "../db";
import { benchmarkRuns, benchmarkSuites, benchmarkTaskResults, narrators } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	createContainer,
	destroyContainer,
	ensureImage,
	execInContainer,
} from "./benchmark-container";
import { agencybenchEvaluator } from "./benchmark-evaluators/agencybench";
import { humanevalEvaluator } from "./benchmark-evaluators/humaneval";
import { swebenchEvaluator } from "./benchmark-evaluators/swe-bench";
import type { BenchmarkEvaluator, BenchmarkTask, EvalResult } from "./benchmark-evaluators/types";
import {
	BENCHMARK_MAX_RESPONSE_BYTES,
	BenchmarkBudgetError,
	MAX_SUITE_JSON_CHARS,
	MAX_TASKS_PER_SUITE,
} from "./benchmark-limits";
import {
	type BenchmarkNarratorMetrics,
	type BenchmarkRead,
	type BenchmarkTaskMetrics,
	benchmarkReadPlan,
	benchmarkReadRowLimit,
} from "./benchmark-read";
import { createBenchmarkReadStream, readSqliteBenchmark } from "./benchmark-suite-stream";
import { narratorService } from "./narrator-service";
import { interruptNarrator, sendMessage } from "./narrator-session";

// ── Evaluator registry ──────────────────────────────────────────────

const evaluators = new Map<string, BenchmarkEvaluator>([
	["humaneval", humanevalEvaluator],
	["swe-bench", swebenchEvaluator],
	["agencybench", agencybenchEvaluator],
]);

type BenchmarkRun = typeof benchmarkRuns.$inferSelect;
type BenchmarkSuite = typeof benchmarkSuites.$inferSelect;

type TableRead = Exclude<BenchmarkRead, { type: "narratorMetrics" }>;
type RunSummaryIdentity = Pick<BenchmarkRun, "suiteId" | "status" | "model">;
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" };

async function readBenchmarkData<T>(read: TableRead, signal?: AbortSignal): Promise<T> {
	if (activeDatabaseBackend !== "postgres") return readSqliteBenchmark<T>(sqlite, read, signal);
	if (!postgresRuntime) throw new Error("Benchmark PostgreSQL reader unavailable");
	signal?.throwIfAborted();
	const { table, projection, filter, order, size, single, decode } = benchmarkReadPlan(read);
	const where = filter ? ` WHERE ${filter[0]} = $1` : "";
	const limit = benchmarkReadRowLimit(read);
	const result = await postgresRuntime.executor.unsafe(
		`WITH selected AS MATERIALIZED (
			SELECT ${projection}, (${size}) AS __bytes, row_number() OVER (${order.trim()}) AS __position
			FROM ${table}${where}${order} LIMIT ${limit + 1}
		)
		SELECT CASE WHEN sum(__bytes) OVER () <= ${BENCHMARK_MAX_RESPONSE_BYTES}
			THEN (to_jsonb(selected) - '__bytes' - '__position')::text END AS payload
		FROM selected ORDER BY __position`,
		filter ? [filter[1]] : [],
	);
	signal?.throwIfAborted();
	if (result.length > limit || result.some((row) => typeof row.payload !== "string"))
		throw new BenchmarkBudgetError("Benchmark response exceeds its budget");
	const rows = result.map((row) => decode(JSON.parse(row.payload as string)));
	return (single ? (rows[0] ?? null) : rows) as T;
}

export async function readBenchmarkResponse(
	read: TableRead,
	signal: AbortSignal,
): Promise<Response | null> {
	if (activeDatabaseBackend === "postgres") {
		const value = await readBenchmarkData<unknown>(read, signal);
		if (value === null) return null;
		const body = JSON.stringify(value);
		if (Buffer.byteLength(body) > BENCHMARK_MAX_RESPONSE_BYTES)
			throw new BenchmarkBudgetError("Benchmark response exceeds its encoded byte budget");
		return new Response(body, { headers: JSON_HEADERS });
	}
	const stream = await createBenchmarkReadStream(sqlite, read, signal);
	return stream && new Response(stream, { headers: JSON_HEADERS });
}

type CancelRunResult = "cancelled" | "not_found" | "not_cancellable";

// ── Active run tracking (for cancellation) ──────────────────────────

const activeRuns = new Map<string, AbortController>();

// ── Suite CRUD ──────────────────────────────────────────────────────

export async function createSuite(input: {
	name: string;
	version?: string;
	description?: string;
	tasks: BenchmarkTask[];
}) {
	if (
		input.tasks.length > MAX_TASKS_PER_SUITE ||
		JSON.stringify(input).length > MAX_SUITE_JSON_CHARS
	)
		throw new BenchmarkBudgetError("Benchmark suite exceeds its producer budget");
	const id = generateId();
	const now = new Date().toISOString();
	const [suite] = await db
		.insert(benchmarkSuites)
		.values({
			id,
			name: input.name,
			version: input.version ?? null,
			description: input.description ?? null,
			tasksJson: input.tasks as unknown,
			createdAt: now,
		})
		.returning();
	logger.info("Benchmark suite created", { id, name: input.name, taskCount: input.tasks.length });
	return suite;
}

async function getSuite(id: string) {
	return readBenchmarkData<BenchmarkSuite | null>({ type: "suite", id });
}

// ── Run CRUD ────────────────────────────────────────────────────────

export async function createRun(input: {
	suiteId: string;
	name: string;
	model: string;
	systemPrompt?: string;
	permissionMode?: string;
	config?: Record<string, unknown>;
}) {
	const suite = await getSuite(input.suiteId);
	if (!suite) throw new Error(`Suite not found: ${input.suiteId}`);

	const tasks = (suite.tasksJson ?? []) as BenchmarkTask[];
	const id = generateId();
	const now = new Date().toISOString();

	const [run] = await db
		.insert(benchmarkRuns)
		.values({
			id,
			suiteId: input.suiteId,
			name: input.name,
			model: input.model,
			systemPrompt: input.systemPrompt ?? null,
			permissionMode: input.permissionMode ?? "bypassPermissions",
			config: (input.config ?? {}) as unknown,
			totalTasks: tasks.length,
			createdAt: now,
		})
		.returning();

	// Pre-create task result placeholders
	for (const task of tasks) {
		await db.insert(benchmarkTaskResults).values({
			id: generateId(),
			runId: id,
			taskId: task.id,
			taskName: task.name,
			status: "pending",
			createdAt: now,
		});
	}

	logger.info("Benchmark run created", { id, model: input.model, tasks: tasks.length });
	return run;
}

function getRun(id: string, signal?: AbortSignal) {
	return readBenchmarkData<BenchmarkRun | null>({ type: "run", id }, signal);
}

function getRunResultMetrics(id: string, signal?: AbortSignal) {
	return readBenchmarkData<BenchmarkTaskMetrics[]>({ type: "resultMetrics", id }, signal);
}

// ── Run execution ───────────────────────────────────────────────────

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Wait for a narrator to finish (status → idle) using event bus. */
async function waitForNarratorIdle(
	narratorId: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	// Check current status first — may already be idle
	const current = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { status: true },
	});
	if (!current) return false;
	if (current.status === "idle") return true;
	if (signal.aborted) return false;

	return new Promise<boolean>((resolve) => {
		let settled = false;
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			eventBus.off("narrator:status_changed", handler);
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};

		const handler = (event: { narratorId: string; status: string }) => {
			if (event.narratorId === narratorId && event.status === "idle") {
				settle(true);
			}
		};

		const onAbort = () => settle(false);
		const timer = setTimeout(() => settle(false), timeoutMs);

		signal.addEventListener("abort", onAbort, { once: true });
		eventBus.on("narrator:status_changed", handler);
	});
}

/** Collect metrics from narrator messages and tool calls. */
function collectMetrics(id: string, signal: AbortSignal) {
	return readSqliteBenchmark<BenchmarkNarratorMetrics>(
		sqlite,
		{ type: "narratorMetrics", id },
		signal,
	);
}

function copySourceWorkspace(sourcePath: string, workDir: string): void {
	if (!existsSync(sourcePath)) {
		throw new Error(`Benchmark sourcePath does not exist: ${sourcePath}`);
	}
	const sourceStat = statSync(sourcePath);
	if (!sourceStat.isDirectory()) {
		throw new Error(`Benchmark sourcePath must be a directory: ${sourcePath}`);
	}
	cpSync(sourcePath, workDir, {
		recursive: true,
		force: true,
		dereference: true,
	});
}

/** Execute a single benchmark task. */
async function executeTask(
	run: BenchmarkRun,
	suiteName: string,
	task: BenchmarkTask,
	taskResultId: string,
	signal: AbortSignal,
): Promise<void> {
	const now = new Date().toISOString();
	const startTime = Date.now();

	// Create temp working directory
	const workDir = await mkdtemp(join(tmpdir(), `nf-bench-${task.id}-`));
	let containerId: string | undefined;

	// Determine if this is a SWE-bench task that needs container isolation
	const isSWEBench = suiteName === "swe-bench";
	const meta = (task.metadata ?? {}) as Record<string, unknown>;

	try {
		// Update status to running
		await db
			.update(benchmarkTaskResults)
			.set({ status: "running", startedAt: now })
			.where(eq(benchmarkTaskResults.id, taskResultId));

		const sourcePath = typeof meta.sourcePath === "string" ? meta.sourcePath : undefined;
		if (sourcePath) {
			copySourceWorkspace(sourcePath, workDir);
			logger.info("Benchmark source workspace copied", { taskId: task.id, sourcePath, workDir });
		}

		// === SWE-bench container setup ===
		if (isSWEBench && meta.repo && meta.baseCommit) {
			const dockerImage = (meta.dockerImage as string) ?? "python:3.9-slim";
			const repo = meta.repo as string;
			const baseCommit = meta.baseCommit as string;
			const installCmd = (meta.installCmd as string) ?? "python -m pip install -e .";
			const preInstall = (meta.preInstall as string[]) ?? [];
			const pipPackages = (meta.pipPackages as string[]) ?? [];

			logger.info("Setting up SWE-bench container", { taskId: task.id, repo, image: dockerImage });

			// Ensure image is available
			await ensureImage(dockerImage);

			// Create container with workDir bind-mounted
			containerId = await createContainer({
				image: dockerImage,
				hostDir: workDir,
				containerDir: "/testbed",
				name: `nf-swe-${task.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}`,
				memoryLimit: "4g",
			});

			// Install git and clone repo inside container
			const setupScript = [
				"set -eo pipefail",
				"apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1",
				...preInstall,
				`git clone https://github.com/${repo}.git /testbed_repo`,
				`cd /testbed_repo && git reset --hard ${baseCommit}`,
				// Copy repo contents to /testbed (the bind-mounted dir)
				"cp -a /testbed_repo/. /testbed/",
				"rm -rf /testbed_repo",
				"cd /testbed",
				...(pipPackages.length > 0 ? [`pip install ${pipPackages.join(" ")} 2>&1 | tail -3`] : []),
				`${installCmd} 2>&1 | tail -5`,
			].join("\n");

			const setupResult = await execInContainer(
				containerId,
				`bash -c '${setupScript.replace(/'/g, "'\\''")}'`,
				300_000,
			);
			if (setupResult.exitCode !== 0) {
				const durationMs = Date.now() - startTime;
				const setupOutput = [setupResult.stdout, setupResult.stderr].filter(Boolean).join("\n");
				logger.warn("SWE-bench container setup failed", {
					taskId: task.id,
					exitCode: setupResult.exitCode,
					stderr: setupResult.stderr.slice(0, 500),
				});
				await db
					.update(benchmarkTaskResults)
					.set({
						status: "error",
						errorMessage: `SWE-bench setup failed (exit ${setupResult.exitCode})`,
						evalOutput: setupOutput.slice(0, 50000),
						durationMs,
						completedAt: new Date().toISOString(),
					})
					.where(eq(benchmarkTaskResults.id, taskResultId));
				return;
			}

			// Inject containerId into task metadata so evaluator can use it
			(task.metadata as Record<string, unknown>).containerId = containerId;

			logger.info("SWE-bench container ready", { taskId: task.id, containerId });
		}

		// Create a standalone narrator for this task
		const narrator = await narratorService.create({
			title: `Bench: ${task.name}`,
			model: run.model,
			systemPrompt: run.systemPrompt ?? undefined,
			permissionMode: run.permissionMode ?? "bypassPermissions",
			cwd: workDir,
			// Benchmark runs are admin-triggered and the run row records no user, so
			// there is no owner to attribute. Public visibility is deliberate: a
			// benchmark result is only useful if the team can inspect the transcript
			// that produced it, and the run itself is already admin-gated.
			visibility: "public",
		});

		// Update task result with narrator ID
		await db
			.update(benchmarkTaskResults)
			.set({ narratorId: narrator.id })
			.where(eq(benchmarkTaskResults.id, taskResultId));

		// Send the task prompt
		await sendMessage(narrator.id, task.prompt, undefined, "en", false, null, null);

		// Wait for completion
		const timeoutMs =
			task.timeoutMs ??
			(run.config as { taskTimeoutMs?: number })?.taskTimeoutMs ??
			DEFAULT_TASK_TIMEOUT_MS;
		const completed = await waitForNarratorIdle(narrator.id, timeoutMs, signal);

		if (signal.aborted) {
			// Interrupt the narrator so it stops consuming tokens
			interruptNarrator(narrator.id);
			await db
				.update(benchmarkTaskResults)
				.set({
					status: "error",
					errorMessage: "Run cancelled",
					completedAt: new Date().toISOString(),
				})
				.where(eq(benchmarkTaskResults.id, taskResultId));
			return;
		}

		// Collect metrics
		if (!completed) interruptNarrator(narrator.id);
		const metrics = await collectMetrics(narrator.id, signal);
		const durationMs = Date.now() - startTime;

		if (!completed) {
			await db
				.update(benchmarkTaskResults)
				.set({
					status: "timeout",
					output: metrics.lastAssistantText.slice(0, 50000),
					durationMs,
					tokensIn: metrics.tokensIn,
					tokensOut: metrics.tokensOut,
					costUsd: metrics.costUsd,
					toolCallCount: metrics.toolCallCount,
					messageCount: metrics.messageCount,
					errorMessage: `Task timed out after ${timeoutMs}ms`,
					completedAt: new Date().toISOString(),
				})
				.where(eq(benchmarkTaskResults.id, taskResultId));
			return;
		}

		// Run evaluator — check suite name, then task metadata, then fallback
		const evaluatorName =
			suiteName && evaluators.has(suiteName)
				? suiteName
				: ((task.metadata as { evaluator?: string })?.evaluator ?? "humaneval");
		const evaluator = evaluators.get(evaluatorName);

		let evalResult: EvalResult = {
			passed: false,
			score: 0,
			maxScore: 1,
			details: "No evaluator found",
		};
		if (evaluator) {
			try {
				evalResult = await evaluator.evaluate(task, metrics.lastAssistantText, workDir);
			} catch (err) {
				evalResult = {
					passed: false,
					score: 0,
					maxScore: 1,
					details: `Evaluator error: ${String(err).slice(0, 1000)}`,
				};
			}
		}

		// Persist result
		await db
			.update(benchmarkTaskResults)
			.set({
				status: evalResult.passed ? "passed" : "failed",
				score: evalResult.score,
				maxScore: evalResult.maxScore,
				output: metrics.lastAssistantText.slice(0, 50000),
				evalOutput: evalResult.details.slice(0, 50000),
				durationMs,
				tokensIn: metrics.tokensIn,
				tokensOut: metrics.tokensOut,
				costUsd: metrics.costUsd,
				toolCallCount: metrics.toolCallCount,
				messageCount: metrics.messageCount,
				metadata: evalResult.metadata as unknown,
				completedAt: new Date().toISOString(),
			})
			.where(eq(benchmarkTaskResults.id, taskResultId));
	} catch (err) {
		await db
			.update(benchmarkTaskResults)
			.set({
				status: "error",
				errorMessage: signal.aborted ? "Run cancelled" : String(err).slice(0, 5000),
				durationMs: Date.now() - startTime,
				completedAt: new Date().toISOString(),
			})
			.where(eq(benchmarkTaskResults.id, taskResultId));
	} finally {
		// Cleanup container (best-effort)
		if (containerId) {
			try {
				await destroyContainer(containerId);
			} catch {
				// ignore
			}
		}
		// Cleanup temp dir (best-effort)
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

/** Best-effort cleanup of stale nf-bench-* temp directories from previous crashed runs.
 *  Runs once at module load time — NOT on every executeRun call. */
function cleanupStaleBenchmarkDirs(): void {
	try {
		const tmp = tmpdir();
		const entries = readdirSync(tmp);
		for (const entry of entries) {
			if (entry.startsWith("nf-bench-")) {
				try {
					rmSync(join(tmp, entry), { recursive: true, force: true });
				} catch {
					// ignore individual failures
				}
			}
		}
	} catch {
		// ignore — non-critical
	}
}

function reconcileStaleBenchmarkRuns(): void {
	try {
		const now = new Date().toISOString();
		const staleTasks = sqlite
			.prepare(
				"UPDATE benchmark_task_results SET status = 'error', error_message = COALESCE(error_message, 'Interrupted by server restart'), completed_at = ? WHERE status = 'running'",
			)
			.run(now);
		const staleRuns = sqlite
			.prepare(
				"UPDATE benchmark_runs SET status = 'failed', completed_at = ?, total_duration_ms = CASE WHEN started_at IS NOT NULL THEN CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) ELSE total_duration_ms END WHERE status = 'running'",
			)
			.run(now, now);
		if (staleRuns.changes > 0 || staleTasks.changes > 0) {
			logger.warn("Reconciled stale benchmark runs from previous process", {
				runs: staleRuns.changes,
				tasks: staleTasks.changes,
			});
		}
	} catch (err) {
		logger.warn("Failed to reconcile stale benchmark runs", { error: String(err) });
	}
}

// Run once at module load
cleanupStaleBenchmarkDirs();
if (activeDatabaseBackend !== "postgres") reconcileStaleBenchmarkRuns();

async function claimRun(runId: string) {
	const run = await getRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);
	if (run.status !== "pending")
		throw new Error(`Run ${runId} is not pending (current: ${run.status})`);

	const suite = await getSuite(run.suiteId);
	if (!suite) throw new Error(`Suite not found: ${run.suiteId}`);
	const taskResults = await getRunResultMetrics(runId);

	const now = new Date().toISOString();
	const claimed = sqlite
		.prepare(
			"UPDATE benchmark_runs SET status = 'running', started_at = ?, completed_at = NULL WHERE id = ? AND status = 'pending'",
		)
		.run(now, runId);
	if (claimed.changes === 0) {
		const current = await getRunStatus(runId);
		throw new Error(`Run ${runId} is not pending (current: ${current ?? run.status})`);
	}

	const claimedRun: BenchmarkRun = { ...run, status: "running", startedAt: now, completedAt: null };
	return { run: claimedRun, suite, taskResults };
}

/** Start a benchmark run in the background after synchronously claiming it. */
export async function startRun(runId: string): Promise<BenchmarkRun> {
	const claim = await claimRun(runId);
	executeClaimedRun(claim).catch((err) => {
		logger.error("Benchmark run execution failed", { runId, error: String(err) });
	});
	return claim.run;
}

/** Execute all tasks in a benchmark run sequentially after it has been claimed. */
async function executeClaimedRun({
	run,
	suite,
	taskResults,
}: Awaited<ReturnType<typeof claimRun>>): Promise<void> {
	const runId = run.id;
	const tasks = (suite.tasksJson ?? []) as BenchmarkTask[];

	const abortController = new AbortController();
	activeRuns.set(runId, abortController);

	logger.info("Benchmark run started", { runId, model: run.model, tasks: tasks.length });

	let completedCount = 0;
	let passedCount = 0;
	let failedCount = 0;
	let totalCost = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;

	try {
		const current = await getRunStatus(runId);
		if (current !== "running") return;
		for (const task of tasks) {
			if (abortController.signal.aborted) break;

			const taskResult = taskResults.find((r) => r.taskId === task.id);
			if (!taskResult) continue;
			if (taskResult.status !== "pending") {
				completedCount++;
				continue;
			}

			logger.info("Executing benchmark task", {
				runId,
				taskId: task.id,
				taskName: task.name,
				progress: `${completedCount + 1}/${tasks.length}`,
			});

			await executeTask(run, suite.name, task, taskResult.id, abortController.signal);

			// Refresh task result
			const updated = await db.query.benchmarkTaskResults.findFirst({
				where: eq(benchmarkTaskResults.id, taskResult.id),
				columns: { status: true, costUsd: true, tokensIn: true, tokensOut: true },
			});

			completedCount++;
			if (updated?.status === "passed") passedCount++;
			if (
				updated?.status === "failed" ||
				updated?.status === "error" ||
				updated?.status === "timeout"
			)
				failedCount++;
			totalCost += updated?.costUsd ?? 0;
			totalTokensIn += updated?.tokensIn ?? 0;
			totalTokensOut += updated?.tokensOut ?? 0;

			// Update run progress
			await db
				.update(benchmarkRuns)
				.set({
					completedTasks: completedCount,
					passedTasks: passedCount,
					failedTasks: failedCount,
					totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
					totalTokensIn,
					totalTokensOut,
				})
				.where(eq(benchmarkRuns.id, runId));
		}

		// Mark run as completed
		const finalStatus = abortController.signal.aborted ? "cancelled" : "completed";
		await db
			.update(benchmarkRuns)
			.set({
				status: finalStatus,
				totalDurationMs: Date.now() - new Date(run.startedAt ?? run.createdAt).getTime(),
				completedAt: new Date().toISOString(),
			})
			.where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, "running")));

		logger.info("Benchmark run completed", {
			runId,
			status: finalStatus,
			passed: passedCount,
			failed: failedCount,
			total: tasks.length,
		});
	} catch (err) {
		const failureStatus = abortController.signal.aborted ? "cancelled" : "failed";
		await db
			.update(benchmarkRuns)
			.set({ status: failureStatus, completedAt: new Date().toISOString() })
			.where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, "running")));
		logger.error("Benchmark run failed", { runId, status: failureStatus, error: String(err) });
		throw err;
	} finally {
		activeRuns.delete(runId);
	}
}

/** Execute all tasks in a benchmark run sequentially and wait for completion. */
export async function executeRun(runId: string): Promise<void> {
	await executeClaimedRun(await claimRun(runId));
}

async function getRunStatus(id: string) {
	const row = await db.query.benchmarkRuns.findFirst({
		where: eq(benchmarkRuns.id, id),
		columns: { status: true },
	});
	return row?.status;
}

/** Cancel a pending or running benchmark. */
export async function cancelRun(runId: string): Promise<CancelRunResult> {
	const status = await getRunStatus(runId);
	if (!status) return "not_found";
	if (status !== "pending" && status !== "running") return "not_cancellable";

	const [cancelled] = await db
		.update(benchmarkRuns)
		.set({ status: "cancelled", completedAt: new Date().toISOString() })
		.where(and(eq(benchmarkRuns.id, runId), inArray(benchmarkRuns.status, ["pending", "running"])))
		.returning({ id: benchmarkRuns.id });

	if (!cancelled) return "not_cancellable";
	activeRuns.get(runId)?.abort();
	return "cancelled";
}

// ── Summary / comparison ────────────────────────────────────────────

export async function getRunSummary(runId: string, signal?: AbortSignal) {
	const run = await readBenchmarkData<RunSummaryIdentity | null>(
		{ type: "runSummary", id: runId },
		signal,
	);
	if (!run) throw new Error(`Run not found: ${runId}`);

	const results = await getRunResultMetrics(runId, signal);
	const suite = run.suiteId
		? await readBenchmarkData<{ name: string } | null>(
				{ type: "suiteName", id: run.suiteId },
				signal,
			)
		: null;

	const passed = results.filter((r) => r.status === "passed").length;
	const failed = results.filter((r) => r.status === "failed").length;
	const errors = results.filter((r) => r.status === "error").length;
	const timeouts = results.filter((r) => r.status === "timeout").length;
	const pending = results.filter((r) => r.status === "pending").length;
	const total = results.length;

	const avgScore =
		results.filter((r) => r.score != null).reduce((sum, r) => sum + (r.score ?? 0), 0) /
		Math.max(results.filter((r) => r.score != null).length, 1);

	const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
	const totalTokensIn = results.reduce((sum, r) => sum + (r.tokensIn ?? 0), 0);
	const totalTokensOut = results.reduce((sum, r) => sum + (r.tokensOut ?? 0), 0);
	const totalDuration = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
	const avgDuration = totalDuration / Math.max(total - pending, 1);

	return {
		runId,
		suiteName: suite?.name ?? "unknown",
		model: run.model,
		status: run.status,
		total,
		passed,
		failed,
		errors,
		timeouts,
		pending,
		passRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : 0,
		avgScore: Math.round(avgScore * 10000) / 10000,
		totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
		totalTokensIn,
		totalTokensOut,
		totalDurationMs: totalDuration,
		avgDurationMs: Math.round(avgDuration),
	};
}

export async function compareRuns(runIds: string[], signal?: AbortSignal) {
	const summaries = await Promise.all(runIds.map((id) => getRunSummary(id, signal)));
	return summaries;
}
