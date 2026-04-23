/**
 * Benchmark API routes.
 */
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import {
	cancelRun,
	compareRuns,
	createRun,
	createSuite,
	executeRun,
	getRun,
	getRunResults,
	getRunSummary,
	getSuite,
	listRuns,
	listSuites,
} from "../services/benchmark-service";

export const benchmarkRoutes = new Hono();

// ── Suite endpoints ─────────────────────────────────────────────────

const createSuiteSchema = z.object({
	name: z.string().min(1),
	version: z.string().optional(),
	description: z.string().optional(),
	tasks: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			prompt: z.string(),
			language: z.string().optional(),
			expectedOutput: z.string().optional(),
			testCode: z.string().optional(),
			rubric: z
				.array(
					z.object({
						name: z.string(),
						description: z.string(),
						maxPoints: z.number(),
					}),
				)
				.optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
			timeoutMs: z.number().optional(),
		}),
	),
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
	suiteId: z.string(),
	name: z.string().min(1),
	model: z.string().min(1),
	systemPrompt: z.string().optional(),
	permissionMode: z
		.enum(["default", "acceptEdits", "bypassPermissions", "readOnly", "plan", "dontAsk"])
		.optional(),
	config: z.record(z.string(), z.unknown()).optional(),
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
		// Fire-and-forget: executeRun does atomic status claim internally
		executeRun(runId).catch((err) => {
			logger.error("Benchmark run execution failed", { runId, error: String(err) });
		});
		return c.json({ ok: true, message: "Run started" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("not found")) return c.json({ error: msg }, 404);
		if (msg.includes("already") || msg.includes("not pending")) return c.json({ error: msg }, 409);
		return c.json({ error: msg }, 400);
	}
});

benchmarkRoutes.post("/runs/:id/cancel", async (c) => {
	const runId = c.req.param("id");
	const cancelled = cancelRun(runId);
	if (!cancelled) return c.json({ error: "Run is not active" }, 404);
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
