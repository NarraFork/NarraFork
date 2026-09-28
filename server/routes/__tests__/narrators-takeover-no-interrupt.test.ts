/**
 * `POST /narrators/:id/takeover` must NOT stop the turn in flight.
 *
 * Taking over is a claim on the RESULT, not on the current turn: the user says
 * "this conclusion goes through me before it reaches the parent". The turn keeps
 * running, and the subagent parks in `idle[taken_over]` when it ends by itself.
 *
 * The route used to abort the turn, because the hold was only reachable from the
 * runner's "subagent was interrupted" branch. So a user who wanted to inspect the
 * work before it was handed over first had to destroy the turn producing it.
 *
 * What is pinned is the ABSENCE of an abort, which no response body can show
 * (`{takenOver: true}` either way) and which no status check can show either: the
 * subagent stays `working` in both designs, and the takeover badge is written in
 * both. The observable difference is the AbortController the route was handed —
 * hence the assertion is on the signal, plus the hard-interrupt marker so a
 * re-introduced abort cannot sneak back as a "soft" one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-takeover-no-interrupt-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected: these modules initialise the DB at
// import time and must not touch the developer's real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");
const { generateId } = await import("../../lib/id");
const { parseSubstatus } = await import("../../lib/narrator-utils");
const {
	clearTakenOver,
	consumeForegroundSubagentHardInterrupt,
	getBackgroundAbortControllers,
	getForegroundAbortControllers,
	isBackgroundTakenOver,
	isTakenOver,
} = await import("../../services/narrator-subagent");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "takeover-no-interrupt-owner";
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

function takeover(id: string) {
	return app().request(`http://localhost/narrators/${id}/takeover`, { method: "POST" });
}

/** Stand in for a running foreground subagent turn. */
function registerForegroundTurn(id: string): AbortController {
	const controller = new AbortController();
	getForegroundAbortControllers().set(id, controller);
	return controller;
}

/** Stand in for a running background subagent turn. */
function registerBackgroundTurn(id: string): AbortController {
	const controller = new AbortController();
	getBackgroundAbortControllers().set(id, controller);
	return controller;
}

async function setSubagentRow(values: Record<string, unknown>): Promise<void> {
	await db.update(narrators).set(values).where(eq(narrators.id, subagentId));
}

async function readSubagent() {
	const [row] = await db.select().from(narrators).where(eq(narrators.id, subagentId));
	return row;
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
			title: "subagent mid-turn",
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

afterEach(async () => {
	getForegroundAbortControllers().clear();
	getBackgroundAbortControllers().clear();
	consumeForegroundSubagentHardInterrupt(subagentId);
	clearTakenOver(subagentId);
	await setSubagentRow({
		status: "working",
		substatus: "[]",
		isBackground: false,
		backgroundStatus: null,
	});
});

describe("taking over a foreground subagent", () => {
	test("leaves the running turn untouched and records the hold", async () => {
		const controller = registerForegroundTurn(subagentId);

		const res = await takeover(subagentId);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ takenOver: true });
		// The whole point: the turn keeps running to its natural end.
		expect(controller.signal.aborted).toBe(false);
		expect(consumeForegroundSubagentHardInterrupt(subagentId)).toBe(false);
		// The hold is recorded, so the runner's post-turn branch will park the
		// subagent instead of handing the result to the blocked parent.
		expect(isTakenOver(subagentId)).toBe(true);
		expect(isBackgroundTakenOver(subagentId)).toBe(false);
	});

	test("shows the badge immediately while the subagent is still working", async () => {
		registerForegroundTurn(subagentId);

		await takeover(subagentId);

		const row = await readSubagent();
		// Status is deliberately NOT moved to idle: the subagent really is mid-turn.
		// Only the tag is added, so the page and the parent's card can say "taken
		// over" during a turn the user has not stopped.
		expect(row?.status).toBe("working");
		expect(parseSubstatus(row?.substatus)).toContain("taken_over");
	});
});

describe("taking over a background subagent", () => {
	test("leaves the running task alive and remembers it was background", async () => {
		await setSubagentRow({ isBackground: true, backgroundStatus: "running" });
		const controller = registerBackgroundTurn(subagentId);

		const res = await takeover(subagentId);

		expect(res.status).toBe(200);
		expect(controller.signal.aborted).toBe(false);
		// The background flavour must be remembered: the parent holds a
		// background_task_id rather than a blocked tool call, so stop-takeover has to
		// finalize it as a background completion.
		expect(isBackgroundTakenOver(subagentId)).toBe(true);
	});
});

describe("releasing a background takeover after switching to a foreground runner", () => {
	test("records the release for the current foreground driver, not the former background driver", async () => {
		const { markTakenOver, isPendingStopTakeover, consumePendingBackgroundFinalize } = await import(
			"../../services/narrator-subagent"
		);
		markTakenOver(subagentId, { background: true });
		registerForegroundTurn(subagentId);
		const response = await app().request(`http://localhost/narrators/${subagentId}/stop-takeover`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stopped: true, deferred: true });
		expect(isPendingStopTakeover(subagentId)).toBe(true);
		expect(consumePendingBackgroundFinalize(subagentId)).toBe(false);
	});

	test("releases the suspended runner instead of bypassing its terminal completion", async () => {
		const { markTakenOver, waitForManualOverride, isManualOverride } = await import(
			"../../services/narrator-subagent"
		);
		await setSubagentRow({
			status: "idle",
			isBackground: false,
			substatus: JSON.stringify(["taken_over"]),
		});
		markTakenOver(subagentId, { background: true });
		// Suspension retains the foreground runner's controller until finalization.
		registerForegroundTurn(subagentId);
		const controller = new AbortController();
		const completion = waitForManualOverride(
			subagentId,
			controller.signal,
			parentId,
			"origin-tool",
		);
		try {
			const response = await app().request(
				`http://localhost/narrators/${subagentId}/stop-takeover`,
				{ method: "POST" },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ stopped: true, deferred: false });
			expect(isManualOverride(subagentId)).toBe(false);
			expect(await completion).toMatchObject({ action: "finish", hasError: false });
		} finally {
			controller.abort();
			await completion;
		}
	});
});

describe("resuming while releasing a suspended takeover", () => {
	test("defers to the resumed turn when it consumes the wait during the result lookup", async () => {
		const { markTakenOver, waitForManualOverride, resumeManualOverride, isPendingStopTakeover } =
			await import("../../services/narrator-subagent");
		const session = await import("../../services/narrator-session");
		markTakenOver(subagentId);
		registerForegroundTurn(subagentId);
		const controller = new AbortController();
		const completion = waitForManualOverride(
			subagentId,
			controller.signal,
			parentId,
			"origin-tool",
		);
		const lookup = spyOn(session, "getSubagentFinalText").mockImplementationOnce(async () => {
			expect(
				resumeManualOverride(subagentId, {
					prompt: "continue",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			return "previous result";
		});
		try {
			const response = await app().request(
				`http://localhost/narrators/${subagentId}/stop-takeover`,
				{ method: "POST" },
			);
			expect(lookup).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ stopped: true, deferred: true });
			expect(isPendingStopTakeover(subagentId)).toBe(true);
			expect(isTakenOver(subagentId)).toBe(true);
			expect(await completion).toMatchObject({ action: "resume", prompt: "continue" });
		} finally {
			lookup.mockRestore();
			controller.abort();
			await completion;
		}
	});
});

describe("when nothing is actually running", () => {
	test("refuses with 409 rather than recording a hold nobody will honour", async () => {
		// working in the DB, but no engine owns it: a foreground subagent between
		// turns, or a zombie row left by a crashed loop.
		const res = await takeover(subagentId);

		expect(res.status).toBe(409);
		expect(isTakenOver(subagentId)).toBe(false);
		const row = await readSubagent();
		expect(parseSubstatus(row?.substatus)).not.toContain("taken_over");
	});

	test("refuses an idle subagent", async () => {
		await setSubagentRow({ status: "idle", substatus: JSON.stringify(["unread"]) });

		const res = await takeover(subagentId);

		expect(res.status).toBe(400);
		expect(isTakenOver(subagentId)).toBe(false);
	});
});
