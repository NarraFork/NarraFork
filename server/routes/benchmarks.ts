/**
 * Benchmark API routes.
 */
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DbReadTaskExecutionError, WorkersUnavailableError } from "../lib/db-worker/pool";
import { logger } from "../lib/logger";
import { permissionModeSchema } from "../lib/permission-modes";
import { requireAdmin } from "../middleware/auth";
import {
	BENCHMARK_MAX_COMPARE_RUNS,
	BENCHMARK_MAX_RESPONSE_BYTES,
	MAX_SUITE_JSON_CHARS,
	MAX_TASKS_PER_SUITE,
} from "../services/benchmark-limits";
import {
	cancelRun,
	compareRuns,
	createRun,
	createSuite,
	getRunSummary,
	readBenchmarkResponse,
	startRun,
} from "../services/benchmark-service";

export const benchmarkRoutes = new Hono();

// Benchmarks can execute model- or suite-provided code. Keep the entire surface admin-only.
benchmarkRoutes.use("*", requireAdmin);

// ── Suite endpoints ─────────────────────────────────────────────────

const MAX_PROMPT_CHARS = 200_000;
const MAX_TEST_CODE_CHARS = 500_000;
const MAX_OUTPUT_CHARS = 500_000;
const MAX_METADATA_JSON_CHARS = 200_000;

function readFailure(c: Context, error: unknown): Response | undefined {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	if (code === "BENCHMARK_READ_BUDGET")
		return c.json({ error: "Benchmark response exceeds its budget" }, 413);
	if (code === "DB_READ_TASK_TIMEOUT") return c.json({ error: "Benchmark read timed out" }, 504);
	if (
		error instanceof WorkersUnavailableError ||
		error instanceof DbReadTaskExecutionError ||
		code === "DB_READ_TASK_OVERLOADED"
	)
		return c.json({ error: "Benchmark reader unavailable" }, 503);
}

async function readResponse(
	c: Context,
	read: Parameters<typeof readBenchmarkResponse>[0],
	missing = "",
) {
	try {
		return (await readBenchmarkResponse(read, c.req.raw.signal)) ?? c.json({ error: missing }, 404);
	} catch (error) {
		const response = readFailure(c, error);
		if (response) return response;
		throw error;
	}
}

function jsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

const metadataSchema = z
	.record(z.string().max(100), z.unknown())
	.refine((value) => jsonSize(value) <= MAX_METADATA_JSON_CHARS, {
		message: `metadata must be <= ${MAX_METADATA_JSON_CHARS} JSON characters`,
	});

const benchmarkTaskSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(120)
		.regex(
			/^[A-Za-z0-9._:-]+$/,
			"Task ID may only contain letters, numbers, '.', '_', ':' and '-'",
		),
	name: z.string().min(1).max(300),
	prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
	language: z.string().min(1).max(50).optional(),
	expectedOutput: z.string().max(MAX_OUTPUT_CHARS).optional(),
	testCode: z.string().max(MAX_TEST_CODE_CHARS).optional(),
	rubric: z
		.array(
			z.object({
				name: z.string().min(1).max(120),
				description: z.string().min(1).max(5_000),
				maxPoints: z.number().positive().max(1_000),
			}),
		)
		.max(100)
		.optional(),
	metadata: metadataSchema.optional(),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.max(24 * 60 * 60 * 1000)
		.optional(),
});

const createSuiteSchema = z
	.object({
		name: z.string().min(1).max(120),
		version: z.string().min(1).max(120).optional(),
		description: z.string().max(2_000).optional(),
		tasks: z.array(benchmarkTaskSchema).min(1).max(MAX_TASKS_PER_SUITE),
	})
	.superRefine((suite, ctx) => {
		const seenTaskIds = new Set<string>();
		for (const [index, task] of suite.tasks.entries()) {
			if (seenTaskIds.has(task.id)) {
				ctx.addIssue({
					code: "custom",
					message: `Duplicate task ID: ${task.id}`,
					path: ["tasks", index, "id"],
				});
			}
			seenTaskIds.add(task.id);
		}
		if (jsonSize(suite) > MAX_SUITE_JSON_CHARS) {
			ctx.addIssue({
				code: "custom",
				message: `Suite payload must be <= ${MAX_SUITE_JSON_CHARS} JSON characters`,
			});
		}
	});

benchmarkRoutes.post(
	"/suites",
	bodyLimit({
		maxSize: BENCHMARK_MAX_RESPONSE_BYTES,
		onError: (c) => c.json({ error: "Benchmark suite payload exceeds its byte budget" }, 413),
	}),
	async (c) => {
		const body = await c.req.json();
		const parsed = createSuiteSchema.safeParse(body);
		if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
		const suite = await createSuite(parsed.data);
		return c.json(suite, 201);
	},
);

benchmarkRoutes.get("/suites", (c) => readResponse(c, { type: "suites" }));

benchmarkRoutes.get("/suites/:id", (c) =>
	readResponse(c, { type: "suite", id: c.req.param("id") }, "Suite not found"),
);

// ── Run endpoints ───────────────────────────────────────────────────

const createRunSchema = z.object({
	suiteId: z.string().min(1).max(120),
	name: z.string().min(1).max(120),
	model: z.string().min(1).max(200),
	systemPrompt: z.string().max(100_000).optional(),
	permissionMode: permissionModeSchema.optional(),
	config: metadataSchema.optional(),
});

benchmarkRoutes.post("/runs", async (c) => {
	const body = await c.req.json();
	const parsed = createRunSchema.safeParse(body);
	if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
	try {
		const run = await createRun(parsed.data);
		return c.json(run, 201);
	} catch (err) {
		return readFailure(c, err) ?? c.json({ error: String(err) }, 400);
	}
});

benchmarkRoutes.get("/runs", (c) =>
	readResponse(c, { type: "runs", suiteId: c.req.query("suiteId") }),
);

benchmarkRoutes.get("/runs/:id", (c) =>
	readResponse(c, { type: "run", id: c.req.param("id") }, "Run not found"),
);

benchmarkRoutes.post("/runs/:id/start", async (c) => {
	const runId = c.req.param("id");
	try {
		const run = await startRun(runId);
		return c.json({ ok: true, message: "Run started", runId: run.id, status: run.status });
	} catch (err) {
		const response = readFailure(c, err);
		if (response) return response;
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("Benchmark run start rejected", { runId, error: msg });
		if (msg.includes("not found") || msg.includes("Suite not found"))
			return c.json({ error: msg }, 404);
		if (msg.includes("not pending")) return c.json({ error: msg }, 409);
		return c.json({ error: msg }, 400);
	}
});

benchmarkRoutes.post("/runs/:id/cancel", async (c) => {
	const runId = c.req.param("id");
	const result = await cancelRun(runId);
	if (result === "not_found") return c.json({ error: "Run not found" }, 404);
	if (result === "not_cancellable") return c.json({ error: "Run is not pending or running" }, 409);
	return c.json({ ok: true, message: "Run cancellation requested" });
});

// ── Results & summary ───────────────────────────────────────────────

benchmarkRoutes.get("/runs/:id/results", (c) =>
	readResponse(c, { type: "results", id: c.req.param("id") }),
);

benchmarkRoutes.get("/runs/:id/summary", async (c) => {
	try {
		const summary = await getRunSummary(c.req.param("id"), c.req.raw.signal);
		return c.json(summary);
	} catch (err) {
		return readFailure(c, err) ?? c.json({ error: String(err) }, 404);
	}
});

benchmarkRoutes.get("/compare", async (c) => {
	const runIdsParam = c.req.query("runIds");
	if (!runIdsParam) return c.json({ error: "runIds query parameter required" }, 400);
	const runIds = runIdsParam.split(",").filter(Boolean);
	if (runIds.length < 2) return c.json({ error: "At least 2 run IDs required" }, 400);
	if (runIds.length > BENCHMARK_MAX_COMPARE_RUNS)
		return c.json({ error: `At most ${BENCHMARK_MAX_COMPARE_RUNS} run IDs allowed` }, 400);
	try {
		const comparison = await compareRuns(runIds, c.req.raw.signal);
		return c.json(comparison);
	} catch (err) {
		return readFailure(c, err) ?? c.json({ error: String(err) }, 400);
	}
});
