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
 * both. The observable difference is the run's cancellation and the session's live
 * turn controller — hence the assertions are on those signals.
 *
 * The run is driven by the one run service for every session; a delegated session is
 * a session whose run registered a result destination (`deliverTo`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
const { eventBus } = await import("../../lib/event-bus");
const { parseSubstatus } = await import("../../lib/narrator-utils");
const { activeNarrators, claimNarratorRuntime } = await import(
	"../../services/narrator-session-state"
);
const {
	getExecutionOwner,
	getRunHold,
	isRunHeldForDisplay,
	setRunControl,
	setRunHold,
	tryClaimExecution,
} = await import("../../services/agent-runtime/ownership");
type RunControl = import("../../services/agent-runtime/ownership").RunControl;
const isTakenOver = isRunHeldForDisplay;

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

function stopTakeover(id: string) {
	return app().request(`http://localhost/narrators/${id}/stop-takeover`, { method: "POST" });
}

/**
 * Stand in for a run of this session in flight: the run service's registry entry
 * (owner + run control) and the session's live turn controller.
 */
function registerRun(id: string, parked = false) {
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("expected a free execution slot");
	const terminal =
		Promise.withResolvers<import("../../services/agent-runtime/ownership").RunResult>();
	const wakes: string[] = [];
	const run: RunControl = {
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: terminal.promise,
		deliverTo: { narratorId: parentId, toolUseId: "origin-tool" },
		...(parked ? { wake: (reason) => void wakes.push(reason) } : {}),
	};
	setRunControl(owner, run);
	const turn = new AbortController();
	activeNarrators.set(id, { narratorId: id, alive: true, abortController: turn } as never);
	return { owner, run, turn, wakes };
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
			runtimeRegistrationJson: {
				version: 1,
				run: {
					logicalRunId: "takeover-run",
					deliverTo: { narratorId: parentId, toolUseId: "origin-tool" },
				},
			},
			status: "working",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterEach(async () => {
	setRunHold(subagentId, undefined);
	getExecutionOwner(subagentId)?.release();
	activeNarrators.delete(subagentId);
	await setSubagentRow({
		status: "working",
		substatus: "[]",
		isBackground: false,
		backgroundStatus: null,
		runtimeRegistrationJson: {
			version: 1,
			run: {
				logicalRunId: "takeover-run",
				deliverTo: { narratorId: parentId, toolUseId: "origin-tool" },
			},
		},
	});
});

describe("taking over a running delegated session", () => {
	test("leaves the running turn untouched and records the hold", async () => {
		const { run, turn } = registerRun(subagentId);

		const res = await takeover(subagentId);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ takenOver: true });
		// The whole point: the turn keeps running to its natural end.
		expect(turn.signal.aborted).toBe(false);
		expect(run.cancel.signal.aborted).toBe(false);
		// The hold is recorded, so the run parks at its turn end instead of delivering.
		expect(isTakenOver(subagentId)).toBe(true);
	});

	test("shows the badge immediately while the subagent is still working", async () => {
		registerRun(subagentId);

		await takeover(subagentId);

		const row = await readSubagent();
		// Status is deliberately NOT moved to idle: the subagent really is mid-turn.
		expect(row?.status).toBe("working");
		expect(parseSubstatus(row?.substatus)).toContain("taken_over");
	});

	test("a detached (background) run stays alive under the same hold", async () => {
		await setSubagentRow({ isBackground: true, backgroundStatus: "running" });
		const { run, turn } = registerRun(subagentId);

		const res = await takeover(subagentId);

		expect(res.status).toBe(200);
		expect(turn.signal.aborted).toBe(false);
		expect(run.cancel.signal.aborted).toBe(false);
		// One hold for every run: where the result goes is the run's registered fact.
		expect(isTakenOver(subagentId)).toBe(true);
	});
});

describe("releasing a hold", () => {
	test("while a turn is still running: deferred to that run's own terminal", async () => {
		const { run, wakes } = registerRun(subagentId);
		setRunHold(subagentId, { released: false });

		const response = await stopTakeover(subagentId);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stopped: true, deferred: true });
		// The run delivers once when it ends; nothing is delivered from the route.
		expect(getRunHold(subagentId)?.released).toBe(true);
		expect(wakes).toEqual([]);
		expect(run.cancel.signal.aborted).toBe(false);
	});

	test("while the run is parked: wakes the same run to deliver its result", async () => {
		await setSubagentRow({ status: "idle", substatus: JSON.stringify(["taken_over"]) });
		const { owner, run, wakes } = registerRun(subagentId, true);
		setRunHold(subagentId, { released: false });

		const response = await stopTakeover(subagentId);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stopped: true, deferred: false });
		expect(wakes).toEqual(["release"]);
		expect(isTakenOver(subagentId)).toBe(false);
		// Delivery is not committed by this stub waiter. Keep the retryable hold fact
		// until the real finalizer commits, even though its takeover badge is off.
		expect(getRunHold(subagentId)?.released).toBe(true);
		// Same owner and run: release neither restarts nor re-times the run.
		expect(getExecutionOwner(subagentId)).toBe(owner);
		expect(run.cancel.signal.aborted).toBe(false);
	});

	test("releases a live hold even when no result destination is registered", async () => {
		await setSubagentRow({ runtimeRegistrationJson: { version: 1 } });
		const { run, wakes } = registerRun(subagentId, true);
		setRunHold(subagentId, { released: false });

		const response = await stopTakeover(subagentId);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stopped: true, deferred: false });
		expect(getRunHold(subagentId)?.released).toBe(true);
		expect(wakes).toEqual(["release"]);
		expect(run.cancel.signal.aborted).toBe(false);
	});

	for (const registration of [null, { version: 1 }]) {
		test(`releases a restored hold without a destination (${JSON.stringify(registration)})`, async () => {
			await setSubagentRow({
				runtimeRegistrationJson: registration,
				status: "idle",
				substatus: JSON.stringify(["taken_over"]),
			});
			setRunHold(subagentId, { released: false });

			const response = await stopTakeover(subagentId);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ stopped: true, deferred: false });
			expect(getRunHold(subagentId)).toBeUndefined();
			expect(getExecutionOwner(subagentId)).toBeUndefined();
			const row = await readSubagent();
			expect(parseSubstatus(row?.substatus)).not.toContain("taken_over");
			// Historical parentage is not authority to deliver a result.
			expect(row?.runtimeRegistrationJson?.run?.deliverTo).toBeUndefined();
		});
	}

	test("refuses a session that is not held", async () => {
		registerRun(subagentId);
		const response = await stopTakeover(subagentId);
		expect(response.status).toBe(400);
	});
});

describe("when nothing is actually running", () => {
	test("waits out the gap between passes and holds the run that resumes", async () => {
		// working in the DB, no run for a moment: the next pass claims it shortly.
		const pending = takeover(subagentId);
		await Bun.sleep(100);
		const { run, turn } = registerRun(subagentId);

		const res = await pending;

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ takenOver: true });
		expect(turn.signal.aborted).toBe(false);
		expect(run.cancel.signal.aborted).toBe(false);
		expect(isTakenOver(subagentId)).toBe(true);
		expect((await readSubagent())?.status).toBe("working");
	});

	test("repairs a zombie row and holds it instead of refusing forever", async () => {
		// working in the DB, but no run will ever own it again: its writer is gone.
		await setSubagentRow({ substatus: JSON.stringify(["interrupted"]) });
		// A parent waiting on this subagent settles when it turns idle without a hold.
		const heldWhenIdle: boolean[] = [];
		const onStatus = (event: { narratorId: string; status: string }) => {
			if (event.narratorId === subagentId && event.status === "idle")
				heldWhenIdle.push(isTakenOver(subagentId));
		};
		eventBus.on("narrator:status_changed", onStatus);

		const res = await Promise.resolve(takeover(subagentId)).finally(() =>
			eventBus.off("narrator:status_changed", onStatus),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ takenOver: true });
		expect(isTakenOver(subagentId)).toBe(true);
		const row = await readSubagent();
		// Idle and held, like a hold restored after a restart: the next message runs it.
		expect(row?.status).toBe("idle");
		expect(parseSubstatus(row?.substatus)).toEqual(
			expect.arrayContaining(["interrupted", "taken_over"]),
		);
		expect(heldWhenIdle.length).toBeGreaterThan(0);
		expect(heldWhenIdle.every(Boolean)).toBe(true);
	});

	test("asks for a retry while work is owned without a run", async () => {
		const release = claimNarratorRuntime(subagentId, "recovery-stage");
		try {
			const res = await takeover(subagentId);

			expect(res.status).toBe(409);
			expect(isTakenOver(subagentId)).toBe(false);
			const row = await readSubagent();
			expect(row?.status).toBe("working");
			expect(parseSubstatus(row?.substatus)).not.toContain("taken_over");
		} finally {
			release();
		}
	});

	test("refuses an idle subagent", async () => {
		await setSubagentRow({ status: "idle", substatus: JSON.stringify(["unread"]) });

		const res = await takeover(subagentId);

		expect(res.status).toBe(400);
		expect(isTakenOver(subagentId)).toBe(false);
	});

	test("refuses a session whose run delivers nowhere", async () => {
		const res = await takeover(parentId);
		expect(res.status).toBe(400);
	});
});

describe("a running subagent whose run delivers nowhere", () => {
	const noDestination = {
		version: 1,
		run: { logicalRunId: "orphan-run" },
	};

	function getDetail(id: string) {
		return app().request(`http://localhost/narrators/${id}`);
	}

	test("detail reports whether takeover has a result to hold", async () => {
		const delegated = await getDetail(subagentId);
		expect(delegated.status).toBe(200);
		expect((await delegated.json()).deliversResult).toBe(true);

		await setSubagentRow({ runtimeRegistrationJson: noDestination });
		const orphan = await getDetail(subagentId);
		expect(orphan.status).toBe(200);
		expect((await orphan.json()).deliversResult).toBe(false);
	});

	test("takeover is refused but Stop still ends it", async () => {
		await setSubagentRow({ runtimeRegistrationJson: noDestination });

		const refused = await takeover(subagentId);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: "This session does not deliver a result" });

		const stop = await app().request(`http://localhost/narrators/${subagentId}/interrupt`, {
			method: "POST",
		});
		expect(stop.status).toBe(200);
		expect(await stop.json()).toEqual({ interrupted: true });
		const row = await readSubagent();
		expect(row.status).toBe("idle");
		expect(parseSubstatus(row.substatus)).toContain("interrupted");
	});
});
