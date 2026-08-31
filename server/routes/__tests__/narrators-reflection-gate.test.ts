/**
 * The `/permissions/:requestId/*` access gate must be able to resolve the owner of
 * EVERY kind of pending decision that can be keyed by request id — including the
 * AI reflection gates whose ids are SYNTHETIC.
 *
 * The plan reflection's `exit_plan_*` id lives ONLY in its in-memory registry: it
 * never appears as a `narrator_tool_calls` row id and never enters
 * `pendingPermissions`. The gate's resolver used to know only those two sources,
 * so clicking "手动接管" (manual takeover) on a running plan reflection produced
 *
 *   POST /permissions/exit_plan_.../stop-plan-reflection
 *   → 404 {"error":"Narrator not found: unknown"}
 *
 * before the route handler ever ran — the button did nothing. Task reflection
 * (`task_reflect_*`) was one registry lookup away from the same failure.
 *
 * What is pinned here is the gate's RESOLUTION, not the takeover itself: for each
 * registry-owned synthetic id, the owner must be authorized like any narrator id,
 * and an unknown id must still fail closed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-reflection-gate-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected: these modules initialise the DB at
// import time and must not touch the developer's real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");

// The reflection registries under test — imported AFTER the routes so we see the
// same module instance the gate resolves through.
const { createExitPlanReflectionDecision } = await import(
	"../../lib/agent/tools/exit-plan-reflection"
);
const { createTaskReflectionDecision } = await import("../../lib/agent/tools/task-reflection");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "reflection-gate-owner";
const STRANGER = "reflection-gate-stranger";

let narratorId: string;

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	app.route("/narrators", narratorRoutes);
	return app;
}

function post(userId: string, path: string, body: unknown = {}) {
	return appAs(userId).request(`http://localhost/narrators${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values([
		{
			id: OWNER,
			username: `${OWNER}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		},
		{
			id: STRANGER,
			username: `${STRANGER}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		},
	]);
	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "reflection gate session",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
});

// Route handlers below the gate will report "not found" for these reflection ids —
// the gate is what must NOT turn the OWNER's request into a 404 before that point.
// The takeover handlers return `{ok:true}` while a decision is actually pending,
// which is exactly the state a running reflection is in.
const PLAN_REQUEST_ID = `exit_plan_${Date.now()}_gatepin`;
const TASK_REQUEST_ID = `task_reflect_${Date.now()}_gatepin`;

describe("the permissions gate resolves synthetic reflection ids", () => {
	// The takeover handlers intentionally LEAVE the decision promise unresolved
	// (`reflectionStoppedByUser` blocks every later resolver — the real loop drops
	// it once its reflection thread observes the abort). Teardown therefore only
	// clears the registry entry; awaiting the decision here would hang the suite.
	test("an exit_plan_* id owned by a PENDING plan reflection authorizes its owner", async () => {
		const { cleanupExitPlanReflection } = await import(
			"../../lib/agent/tools/exit-plan-reflection"
		);
		createExitPlanReflectionDecision(PLAN_REQUEST_ID, {
			narratorId,
			broadcastTargetId: narratorId,
			toolUseId: "pin-plan-tool-use",
			toolName: "ExitPlanMode",
			inputJson: { plan: "pin" },
		});
		try {
			const res = await post(OWNER, `/permissions/${PLAN_REQUEST_ID}/stop-plan-reflection`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			cleanupExitPlanReflection(PLAN_REQUEST_ID);
		}
	});

	test("an exit_plan_* id is refused for a stranger (fail closed)", async () => {
		const { cleanupExitPlanReflection } = await import(
			"../../lib/agent/tools/exit-plan-reflection"
		);
		const requestId = `exit_plan_${Date.now()}_gatestranger`;
		createExitPlanReflectionDecision(requestId, {
			narratorId,
			broadcastTargetId: narratorId,
			toolUseId: "pin-plan-tool-use-2",
			toolName: "ExitPlanMode",
			inputJson: { plan: "pin" },
		});
		try {
			const res = await post(STRANGER, `/permissions/${requestId}/stop-plan-reflection`);
			expect(res.status).toBe(404);
		} finally {
			cleanupExitPlanReflection(requestId);
		}
	});

	test("a task_reflect_* id owned by a PENDING task reflection authorizes its owner", async () => {
		const { cleanupTaskReflection } = await import("../../lib/agent/tools/task-reflection");
		createTaskReflectionDecision(TASK_REQUEST_ID, {
			narratorId,
			broadcastTargetId: narratorId,
			toolUseId: "pin-task-tool-use",
			toolName: "Write",
			inputJson: { file_path: "spec://tasks.json", content: "pin" },
			mutations: [],
		});
		try {
			const res = await post(OWNER, `/permissions/${TASK_REQUEST_ID}/stop-task-reflection`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		} finally {
			cleanupTaskReflection(TASK_REQUEST_ID);
		}
	});

	test("an unknown request id still fails closed with 404", async () => {
		const res = await post(OWNER, "/permissions/does-not-exist/stop-plan-reflection");
		expect(res.status).toBe(404);
	});
});
