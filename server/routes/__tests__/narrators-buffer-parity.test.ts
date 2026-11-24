/**
 * The queue routes have one implementation for every session. A delegated session
 * (its run delivers to a caller's tool call) and an ordinary session that receive the
 * same edit, reorder, delete and clear requests end with the same queue and the same
 * responses — nothing in the route consults how the session was created.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-buffer-parity-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected so the DB never touches a real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { enqueueBufferedMessage, getBufferedMessagesAsync } = await import(
	"../../services/narrator-buffer"
);

const OWNER = "buffer-parity-owner";
const CALLER = "buffer-parity-caller";
const DELEGATED = "buffer-parity-delegated";
const ORDINARY = "buffer-parity-ordinary";

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: `${OWNER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	const base = { ownerUserId: OWNER, visibility: "private", status: "idle" } as const;
	await db.insert(narrators).values([
		{ id: CALLER, ...base, createdAt: now, updatedAt: now },
		{
			id: DELEGATED,
			...base,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: CALLER,
			// Access is judged on the team root (an ACL concern, not queue behaviour).
			aclRootNarratorId: CALLER,
			runtimeRegistrationJson: {
				version: 1,
				run: { logicalRunId: "parity-run", deliverTo: { narratorId: CALLER, toolUseId: "call" } },
			} as never,
			createdAt: now,
			updatedAt: now,
		},
		{ id: ORDINARY, ...base, createdAt: now, updatedAt: now },
	]);
});

function app(userId = OWNER) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

function send(method: string, path: string, body?: unknown) {
	return app().request(`http://localhost/narrators${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

/** The queue as a user sees it, without the per-session ids. */
async function queueShape(narratorId: string, ids: string[]) {
	return (await getBufferedMessagesAsync(narratorId)).map((message) => ({
		slot: ids.indexOf(message.id),
		text: message.text,
		state: message.state,
	}));
}

async function exercise(narratorId: string) {
	const ids: string[] = [];
	for (const text of ["first", "second", "third"]) {
		const result = await enqueueBufferedMessage(narratorId, text);
		if (!result.ok) throw new Error(`enqueue refused for ${narratorId}`);
		ids.push(result.id);
	}
	const steps: Array<{ status: number; queue: unknown }> = [];
	const record = async (response: Response) =>
		steps.push({ status: response.status, queue: await queueShape(narratorId, ids) });

	await record(await send("PATCH", `/${narratorId}/buffer/${ids[1]}`, { text: "second edited" }));
	await record(
		await send("PUT", `/${narratorId}/buffer/reorder`, { orderedIds: [ids[2], ids[0], ids[1]] }),
	);
	await record(await send("DELETE", `/${narratorId}/buffer/${ids[0]}`));
	await record(await send("DELETE", `/${narratorId}/buffer/${ids[0]}`));
	await record(await send("DELETE", `/${narratorId}/buffer`));
	return steps;
}

test("edit, reorder, delete and clear behave the same for delegated and ordinary sessions", async () => {
	const delegated = await exercise(DELEGATED);
	const ordinary = await exercise(ORDINARY);
	expect(delegated).toEqual(ordinary);
	// The shared result is the intended one, not two identical failures.
	expect(ordinary.map((step) => step.status)).toEqual([200, 200, 200, 404, 200]);
	expect(ordinary[1]?.queue).toEqual([
		{ slot: 2, text: "third", state: "queued" },
		{ slot: 0, text: "first", state: "queued" },
		{ slot: 1, text: "second edited", state: "queued" },
	]);
	expect(ordinary.at(-1)?.queue).toEqual([]);
});

test("edit leases protect the whole queue, authenticate renew/release, reject bypasses and survive failed saves", async () => {
	const { bufferEditHolds } = await import("../../services/buffer-edit-hold");
	const inbox = await import("../../services/agent-runtime/inbox");
	const { tryClaimExecution } = await import("../../services/agent-runtime/ownership");
	const previousListener = bufferEditHolds.setListener(undefined);
	const first = await enqueueBufferedMessage(ORDINARY, "edit this");
	if (!first.ok) throw new Error("enqueue failed");
	const path = `/${ORDINARY}/buffer/${first.id}`;
	const request = (
		method: string,
		suffix: string,
		body?: unknown,
		token?: string,
		userId = OWNER,
	) =>
		app(userId).request(`http://localhost/narrators${path}${suffix}`, {
			method,
			headers: {
				"content-type": "application/json",
				...(token ? { "X-Buffer-Edit-Token": token } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	let owner: ReturnType<typeof tryClaimExecution> = null;
	try {
		const start = await request("POST", "/edit", { token: "editor" });
		expect(start.status).toBe(200);
		expect(await start.json()).toMatchObject({ ok: true, token: "editor", leaseMs: 120000 });
		expect((await request("POST", "/edit", { token: "editor" })).status).toBe(200);
		expect((await request("PATCH", "/edit", { token: "editor" })).status).toBe(200);
		expect((await request("PATCH", "/edit", { token: "other" })).status).toBe(409);
		expect(
			(await request("POST", "/edit", { token: "editor" }, undefined, "stranger")).status,
		).toBe(404);
		const oversized = await request("POST", "/edit", { token: "x".repeat(1100) });
		expect(oversized.status, await oversized.text()).toBe(413);
		expect((await request("PATCH", "", { text: "stolen" })).status).toBe(409);
		expect((await request("PATCH", "", { text: "stolen" }, "other")).status).toBe(409);
		expect((await request("PATCH", "/mode", { mode: "interrupt" })).status).toBe(409);
		expect((await request("POST", "/retry")).status).toBe(409);
		expect((await request("DELETE", "")).status).toBe(409);
		expect((await send("DELETE", `/${ORDINARY}/buffer`)).status).toBe(409);
		expect(
			(await send("PUT", `/${ORDINARY}/buffer/reorder`, { orderedIds: [first.id] })).status,
		).toBe(409);
		const later = await enqueueBufferedMessage(
			ORDINARY,
			"later urgent",
			undefined,
			undefined,
			OWNER,
			undefined,
			undefined,
			"front",
		);
		if (!later.ok) throw new Error("enqueue failed");
		owner = tryClaimExecution(ORDINARY, "tool-replay");
		expect(owner).toBeTruthy();
		expect(await inbox.claimInboxHead(ORDINARY, () => true)).toBeUndefined();
		expect(await inbox.hasInboxKind(ORDINARY, ["user_input", "agent_message"])).toBe(false);
		expect(await inbox.hasWakeEligibleInboxInput(ORDINARY)).toBe(false);
		expect(await inbox.peekInbox(ORDINARY)).toBeUndefined();
		// Validation failure cannot accidentally cancel the hold.
		expect((await request("PATCH", "", { text: "" }, "editor")).status).toBe(400);
		expect(bufferEditHolds.held(ORDINARY)).toBe(true);
		expect((await request("PATCH", "", { text: "saved" }, "editor")).status).toBe(200);
		expect(bufferEditHolds.held(ORDINARY)).toBe(false);
		expect(
			(await getBufferedMessagesAsync(ORDINARY)).find((message) => message.id === first.id)?.text,
		).toBe("saved");
		expect((await request("POST", "/edit", { token: "replacement" })).status).toBe(200);
		expect((await request("DELETE", "/edit", undefined, "editor")).status).toBe(200);
		expect(bufferEditHolds.held(ORDINARY)).toBe(true);
		expect((await request("DELETE", "/edit", undefined, "replacement")).status).toBe(200);
		expect(bufferEditHolds.held(ORDINARY)).toBe(false);
		expect((await inbox.claimInboxHead(ORDINARY, () => true))?.id).toBe(later.id);
	} finally {
		owner?.release();
		await bufferEditHolds.release(ORDINARY, {
			messageId: first.id,
			userId: OWNER,
			token: "editor",
		});
		await bufferEditHolds.release(ORDINARY, {
			messageId: first.id,
			userId: OWNER,
			token: "replacement",
		});
		bufferEditHolds.setListener(previousListener);
	}
});

test("aborting a streamed legacy save cancels its reader and releases the pin without a late write", async () => {
	const { bufferEditHolds } = await import("../../services/buffer-edit-hold");
	const previous = bufferEditHolds.setListener(undefined);
	const entry = await enqueueBufferedMessage(ORDINARY, "unchanged");
	if (!entry.ok) throw new Error("enqueue failed");
	const abort = new AbortController();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"text":"unfinished'));
		},
		cancel() {
			cancelled = true;
		},
	});
	const timeout = setTimeout(
		() => abort.abort(new AppError("request timed out", 408, "BUFFER_EDIT_TIMEOUT")),
		30,
	);
	try {
		const response = await app().request(
			`http://localhost/narrators/${ORDINARY}/buffer/${entry.id}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body,
				signal: abort.signal,
			},
		);
		expect(response.status, await response.text()).toBe(408);
		expect(cancelled).toBe(true);
		expect(bufferEditHolds.held(ORDINARY)).toBe(false);
		expect(
			(await getBufferedMessagesAsync(ORDINARY)).find((message) => message.id === entry.id)?.text,
		).toBe("unchanged");
	} finally {
		clearTimeout(timeout);
		bufferEditHolds.setListener(previous);
	}
});
