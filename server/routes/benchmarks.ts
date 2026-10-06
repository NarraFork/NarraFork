/**
 * Benchmark API routes.
 */
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { permissionModeSchema } from "../lib/permission-modes";
import { requireAdmin } from "../middleware/auth";
import {
	cancelRun,
	compareRuns,
	createRun,
	createSuite,
	getRun,
	getRunResults,
	getRunSummary,
	getSuite,
	listRuns,
	listSuites,
	startRun,
} from "../services/benchmark-service";

export const benchmarkRoutes = new Hono();

// Benchmarks can execute model- or suite-provided code. Keep the entire surface admin-only.
benchmarkRoutes.use("*", requireAdmin);

// ── Suite endpoints ─────────────────────────────────────────────────

const MAX_TASKS_PER_SUITE = 1_000;
const MAX_PROMPT_CHARS = 200_000;
const MAX_TEST_CODE_CHARS = 500_000;
const MAX_OUTPUT_CHARS = 500_000;
const MAX_METADATA_JSON_CHARS = 200_000;
const MAX_SUITE_JSON_CHARS = 20_000_000;

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

benchmarkRoutes.post("/suites", async (c) => {
	const body = await c.req.json();
	const parsed = createSuiteSchema.safeParse(body);
	if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
	const suite = await createSuite(parsed.data);
	return c.json(suite, 201);
});

benchmarkRoutes.get("/suites", async (c) => {
	const suites = await listSuites();
	return c.json(suites);
});

benchmarkRoutes.get("/suites/:id", async (c) => {
	const suite = await getSuite(c.req.param("id"));
	if (!suite) return c.json({ error: "Suite not found" }, 404);
	return c.json(suite);
});

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
		return c.json({ error: String(err) }, 400);
	}
});

benchmarkRoutes.get("/runs", async (c) => {
	const suiteId = c.req.query("suiteId");
	const runs = await listRuns(suiteId ?? undefined);
	return c.json(runs);
});

benchmarkRoutes.get("/runs/:id", async (c) => {
	const run = await getRun(c.req.param("id"));
	if (!run) return c.json({ error: "Run not found" }, 404);
	return c.json(run);
});

benchmarkRoutes.post("/runs/:id/start", async (c) => {
	const runId = c.req.param("id");
	try {
		const run = await startRun(runId);
		return c.json({ ok: true, message: "Run started", runId: run.id, status: run.status });
	} catch (err) {
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

benchmarkRoutes.get("/runs/:id/results", async (c) => {
	const results = await getRunResults(c.req.param("id"));
	return c.json(results);
});

benchmarkRoutes.get("/runs/:id/summary", async (c) => {
	try {
		const summary = await getRunSummary(c.req.param("id"));
		return c.json(summary);
	} catch (err) {
		return c.json({ error: String(err) }, 404);
	}
});

benchmarkRoutes.get("/compare", async (c) => {
	const runIdsParam = c.req.query("runIds");
	if (!runIdsParam) return c.json({ error: "runIds query parameter required" }, 400);
	const runIds = runIdsParam.split(",").filter(Boolean);
	if (runIds.length < 2) return c.json({ error: "At least 2 run IDs required" }, 400);
	try {
		const comparison = await compareRuns(runIds);
		return c.json(comparison);
	} catch (err) {
		return c.json({ error: String(err) }, 400);
	}
});
