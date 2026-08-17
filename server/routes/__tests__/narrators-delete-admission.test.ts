/**
 * Admission for the endpoints that rewrite a narrator's history.
 *
 * These used to refuse whenever the narrator looked busy, and the refusal was much
 * broader than the actual conflict:
 *
 *  - `isWorkspaceBeingWritten` matched by WORKTREE PATH, so a different narrator or a
 *    background subagent sharing the worktree blocked every deletion — including
 *    "delete messages only", which writes no file at all;
 *  - a running loop produced "Cannot delete blocks while narrator is running",
 *    sending the user to press Stop before doing the thing that discards that turn
 *    anyway.
 *
 * Now the narrator's own loop is interrupted on the user's behalf and awaited, and
 * the workspace check is gone (the write path 3-way merges under its own lock and
 * reports conflicts precisely). So what is pinned here is:
 *
 *  - a busy narrator is stopped and the request proceeds, rather than being refused;
 *  - an unrelated narrator in the same worktree is nobody else's business;
 *  - the interrupt reaches a loop parked on a pending permission;
 *  - a loop that refuses to stop is still reported instead of being written over.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-delete-admission-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected: these modules initialise the DB at
// import time and must not touch the developer's real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { activeNarrators, pendingPermissions } = await import(
	"../../services/narrator-session-state"
);
type ActiveNarrator = import("../../services/narrator-session-state").ActiveNarrator;

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "delete-admission-owner";
const WORKTREE = join(testHome, "shared-worktree");

let narratorId: string;

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

function del(path: string) {
	return app().request(`http://localhost/narrators${path}`, { method: "DELETE" });
}

/**
 * A live agent loop in `cwd`, as the runtime checks see it.
 *
 * `stopsOnAbort` models the real loop's behaviour: it notices the abort at its next
 * await point and clears `_loopRunning` in its `finally`. A session created with
 * `stopsOnAbort: false` stands in for a loop wedged inside a call that ignores the
 * signal, which is the case the timeout path exists for.
 */
function registerBusyLoop(id: string, cwd: string, opts?: { stopsOnAbort?: boolean }) {
	const controller = new AbortController();
	const session = {
		narratorId: id,
		cwd,
		alive: true,
		_loopRunning: true,
		abortController: controller,
	} as unknown as ActiveNarrator;
	if (opts?.stopsOnAbort !== false) {
		controller.signal.addEventListener("abort", () => {
			session._loopRunning = false;
			session.alive = false;
		});
	}
	activeNarrators.set(id, session);
	return session;
}

/**
 * The admission refusal, or null when the request got past admission.
 *
 * A request that passes admission goes on to fail on the message id (which does not
 * exist), so the assertion is "refused by admission" vs "got through" — not overall
 * success. Admission's only remaining refusal is the interrupt timeout.
 */
async function admissionError(res: Response): Promise<string | null> {
	const body = (await res.json()) as { error?: string };
	if (res.status === 400 && body.error?.includes("did not stop after being interrupted")) {
		return body.error ?? null;
	}
	return null;
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

	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "target session",
		ownerUserId: OWNER,
		visibility: "private",
		status: "idle",
		cwd: WORKTREE,
		createdAt: now,
		updatedAt: now,
	});
});

afterEach(async () => {
	activeNarrators.clear();
	pendingPermissions.clear();
	await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, narratorId));
});

describe("another narrator running in the same worktree", () => {
	test("does not block a deletion that rolls files back", async () => {
		const other = registerBusyLoop(generateId(), WORKTREE);
		expect(await admissionError(await del(`/${narratorId}/messages/${generateId()}`))).toBeNull();
		// Somebody else's loop is not ours to stop.
		expect(other._loopRunning).toBe(true);
	});

	test("does not block a history-only deletion", async () => {
		registerBusyLoop(generateId(), WORKTREE);
		expect(
			await admissionError(await del(`/${narratorId}/messages/${generateId()}?skipRevert=1`)),
		).toBeNull();
	});

	test("does not block a history-only block deletion", async () => {
		registerBusyLoop(generateId(), WORKTREE);
		expect(
			await admissionError(
				await del(`/${narratorId}/messages/${generateId()}/blocks/0?skipRevert=1`),
			),
		).toBeNull();
	});
});

describe("the narrator itself running", () => {
	test("is interrupted and the deletion proceeds", async () => {
		const session = registerBusyLoop(narratorId, WORKTREE);
		expect(await admissionError(await del(`/${narratorId}/messages/${generateId()}`))).toBeNull();
		expect(session.abortController.signal.aborted).toBe(true);
		expect(session._loopRunning).toBe(false);
	});

	test("is interrupted for a history-only deletion too", async () => {
		const session = registerBusyLoop(narratorId, WORKTREE);
		expect(
			await admissionError(await del(`/${narratorId}/messages/${generateId()}?skipRevert=1`)),
		).toBeNull();
		expect(session.abortController.signal.aborted).toBe(true);
	});

	test("a loop parked on a pending permission is released, not waited on forever", async () => {
		const session = registerBusyLoop(narratorId, WORKTREE);
		const requestId = generateId();
		// The pause keeps the turn alive with nobody driving it, so an abort alone would
		// leave the loop on a promise whose decider is gone.
		pendingPermissions.set(requestId, {
			narratorId,
			toolName: "Write",
			toolUseId: generateId(),
			broadcastTargetId: narratorId,
			input: {},
			cwd: WORKTREE,
			locale: "en",
			signal: session.abortController.signal,
			// The real cleanup deregisters the request; that removal is what stops
			// `isNarratorRuntimeBusy` reporting this narrator as busy.
			cleanup: () => {
				pendingPermissions.delete(requestId);
			},
			// The real loop resumes from its suspended await on being resolved, then
			// unwinds because the decision was a denial.
			resolve: () => {
				session._loopRunning = false;
				session.alive = false;
			},
		} as unknown as NonNullable<ReturnType<typeof pendingPermissions.get>>);

		expect(await admissionError(await del(`/${narratorId}/messages/${generateId()}`))).toBeNull();
		expect(pendingPermissions.has(requestId)).toBe(false);
	});

	test("a loop that ignores the abort is reported, not written over", async () => {
		registerBusyLoop(narratorId, WORKTREE, { stopsOnAbort: false });
		const error = await admissionError(await del(`/${narratorId}/messages/${generateId()}`));
		expect(error).toContain("did not stop after being interrupted");
	}, 30_000);
});

describe("an idle narrator", () => {
	test("is admitted without an interrupt", async () => {
		expect(await admissionError(await del(`/${narratorId}/messages/${generateId()}`))).toBeNull();
	});
});
