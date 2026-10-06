/**
 * `POST /narrators/:id/interrupt` against a TAKEN-OVER foreground subagent.
 *
 * The Stop button and the takeover flow met in a way that silently destroyed user
 * input. During a takeover the primary action button turns into the red interrupt
 * button, and when the queue head is a priority message it is even LABELLED "cut in
 * line" (`interruptCutInLine`) — so holding it is exactly what a user does to make a
 * queued message run next. That gesture calls this route.
 *
 * The route's subagent fallback was unconditionally HARD:
 *
 *   interruptForegroundSubagent(id, { hard: true })
 *
 * A hard interrupt makes `runForegroundLoop` take its `hardSubagentInterrupt` branch
 * and `break` out of the loop BEFORE the queue drain and before the takeover
 * suspension. `finalizeSubagent` then calls `clearSubagentBufferedMessages`, so every
 * queued message is discarded, and the terminal publication resolves the parent's
 * blocked tool call — the takeover ends and the parent's Agent card gets a result it
 * was never supposed to get yet.
 *
 * So what is pinned here is the interrupt FLAVOUR, not a message count: the flavour is
 * the single bit that decides whether the loop keeps the queue and the takeover, and
 * it is invisible in the response body (both flavours answer `{interrupted: true}`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-takeover-interrupt-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected: these modules initialise the DB at
// import time and must not touch the developer's real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");
const { generateId } = await import("../../lib/id");
const {
	clearTakenOver,
	consumeForegroundSubagentHardInterrupt,
	getDetachableMap,
	getForegroundAbortControllers,
	isTakenOver,
	markTakenOver,
	ProxyAbortController,
} = await import("../../services/narrator-subagent");
const { activeNarrators } = await import("../../services/narrator-session-state");
type ActiveNarrator = import("../../services/narrator-session-state").ActiveNarrator;

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "takeover-interrupt-owner";
let parentId: string;
let subagentId: string;

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

function interrupt(id: string) {
	return app().request(`http://localhost/narrators/${id}/interrupt`, { method: "POST" });
}

/**
 * Stand in for a running foreground subagent turn.
 *
 * The registry entry is all the route sees; the loop that would consume the abort
 * lives in `subagent-runner` and is out of scope here.
 */
function registerForegroundTurn(id: string): AbortController {
	const controller = new AbortController();
	getForegroundAbortControllers().set(id, controller);
	return controller;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: `${OWNER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});

	parentId = generateId();
	subagentId = generateId();
	await db.insert(narrators).values([
		{
			id: parentId,
			title: "parent",
			ownerUserId: OWNER,
			visibility: "private",
			status: "working",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: subagentId,
			title: "taken-over subagent",
			ownerUserId: OWNER,
			visibility: "private",
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: parentId,
			// A subagent holds no access state of its own: the route gate judges it by
			// this root. Omitting it makes every request a 404 before the handler runs.
			aclRootNarratorId: parentId,
			status: "working",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

/**
 * Stand in for a running foreground subagent the way production has it.
 *
 * A live subagent is ALWAYS registered in `activeNarrators` (subagent-executor does
 * it before the first pass) and in the detach registry (subagent-runner, for the
 * whole run). Registering only the foreground controller — as the cases above do —
 * lets `interruptNarrator` return false and silently skips the branch production
 * actually takes, which is how the takeover-destroying Stop went unnoticed.
 */
function registerRealisticForegroundRun(id: string, parentSignal = new AbortController().signal) {
	const turn = registerForegroundTurn(id);
	const session = new AbortController();
	activeNarrators.set(id, {
		narratorId: id,
		alive: true,
		abortController: session,
	} as unknown as ActiveNarrator);
	getDetachableMap().set(id, {
		runId: "route-test-run",
		markDetached: () => {},
		publishHandoff: () => false,
		proxy: new ProxyAbortController(),
		parentSignal,
		fgAbort: turn,
		toolUseId: "route-test-tool-use",
		parentNarratorId: parentId,
		subagentId: id,
	});
	return { turn, session };
}

afterEach(async () => {
	getForegroundAbortControllers().clear();
	getDetachableMap().clear();
	activeNarrators.delete(subagentId);
	consumeForegroundSubagentHardInterrupt(subagentId);
	clearTakenOver(subagentId);
	// Restore the running-turn state the other tests assume, so a case that parks the
	// subagent in idle cannot make its neighbours pass for the wrong reason.
	await db
		.update(narrators)
		.set({ status: "working", substatus: "[]" })
		.where(eq(narrators.id, subagentId));
});

describe("interrupting a taken-over foreground subagent", () => {
	test("stops the turn softly so the queue and the takeover survive", async () => {
		markTakenOver(subagentId);
		const controller = registerForegroundTurn(subagentId);

		const res = await interrupt(subagentId);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ interrupted: true });
		// The turn must still be stopped — a takeover does not make Stop a no-op.
		expect(controller.signal.aborted).toBe(true);
		// But NOT hard: the hard marker is what makes the runner skip the queue drain,
		// discard queued messages and hand the result back to the blocked parent.
		expect(consumeForegroundSubagentHardInterrupt(subagentId)).toBe(false);
		// The takeover itself is untouched by stopping a turn within it.
		expect(isTakenOver(subagentId)).toBe(true);
	});

	test("a subagent that is NOT taken over is still hard-interrupted", async () => {
		const controller = registerForegroundTurn(subagentId);

		const res = await interrupt(subagentId);

		expect(res.status).toBe(200);
		expect(controller.signal.aborted).toBe(true);
		// The plain Stop button must keep fully ending the subagent, otherwise the
		// parent tool call stays blocked while the subagent looks idle.
		expect(consumeForegroundSubagentHardInterrupt(subagentId)).toBe(true);
	});

	test("does not end the takeover when it sits SUSPENDED with no turn running", async () => {
		/*
		 * A suspended takeover is parked in `idle[taken_over]` waiting for the user's
		 * next command: no foreground controller, nothing in flight to stop.
		 *
		 * What matters is what must NOT happen. The soft path's only other lever is
		 * `interruptManualOverride`, which SETTLES the subagent and hands a result to the
		 * blocked parent — reaching for it here would silently end the takeover instead
		 * of interrupting anything, and ending one is `POST /:id/stop-takeover`'s job.
		 * The zombie fallback further down the route is also inert here, because
		 * `idle` is neither `working` nor `waiting`.
		 *
		 * Pinned because it is unreachable from the UI (which shows "Stop takeover" in
		 * this state), so only a direct API caller can observe it — and a change that
		 * "fixes" the falsy result by settling the subagent would destroy a live
		 * takeover with the user's queued work in it.
		 */
		markTakenOver(subagentId);
		await db
			.update(narrators)
			.set({ status: "idle", substatus: JSON.stringify(["taken_over"]) })
			.where(eq(narrators.id, subagentId));

		const res = await interrupt(subagentId);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ interrupted: false });
		// Still taken over, still the user's session: nothing was concluded.
		expect(isTakenOver(subagentId)).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(subagentId)).toBe(false);
		const after = await db.select().from(narrators).where(eq(narrators.id, subagentId));
		expect(after[0]?.status).toBe("idle");
		expect(after[0]?.substatus).toBe(JSON.stringify(["taken_over"]));
	});

	test("REAL registration: stops the turn softly, never the session controller", async () => {
		markTakenOver(subagentId);
		const { turn, session } = registerRealisticForegroundRun(subagentId);

		const res = await interrupt(subagentId);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ interrupted: true });
		// The turn controller is what routes the stop into the takeover-aware control
		// transition (drain the queue or re-suspend in `taken_over`).
		expect(turn.signal.aborted).toBe(true);
		expect(consumeForegroundSubagentHardInterrupt(subagentId)).toBe(false);
		// The session controller must stay untouched: aborting it is the generic
		// terminal abort that cleared the takeover and settled the parent's Agent call.
		expect(session.signal.aborted).toBe(false);
		expect(isTakenOver(subagentId)).toBe(true);
		// Nothing was settled on the subagent row either.
		const after = await db.select().from(narrators).where(eq(narrators.id, subagentId));
		expect(after[0]?.status).toBe("working");
	});

	test("REAL registration while SUSPENDED: nothing is stopped or settled", async () => {
		markTakenOver(subagentId);
		const { turn, session } = registerRealisticForegroundRun(subagentId);
		// Suspended in the control transition: the runner still owns the run, but no
		// turn is in flight, so there is no foreground controller.
		getForegroundAbortControllers().delete(subagentId);
		await db
			.update(narrators)
			.set({ status: "idle", substatus: JSON.stringify(["taken_over"]) })
			.where(eq(narrators.id, subagentId));

		const res = await interrupt(subagentId);

		expect(await res.json()).toEqual({ interrupted: false });
		expect(turn.signal.aborted).toBe(false);
		expect(session.signal.aborted).toBe(false);
		expect(isTakenOver(subagentId)).toBe(true);
		const after = await db.select().from(narrators).where(eq(narrators.id, subagentId));
		expect(after[0]?.substatus).toBe(JSON.stringify(["taken_over"]));
	});

	test("REAL registration without a takeover still stops the whole session", async () => {
		const { session } = registerRealisticForegroundRun(subagentId);

		const res = await interrupt(subagentId);

		expect(await res.json()).toEqual({ interrupted: true });
		expect(session.signal.aborted).toBe(true);
	});
});
