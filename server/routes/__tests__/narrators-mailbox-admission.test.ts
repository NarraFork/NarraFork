/**
 * The HTTP send path must not bypass a durable mailbox head that was left by an
 * earlier producer. A stale-idle primary is the regression shape: the next user
 * message must join the queue rather than starting a second direct send.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-narrator-mailbox-admission-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const inboxModule = { ...(await import("../../services/agent-runtime/inbox")) };
let wakeCalls = 0;
mock.module("../../services/agent-runtime/inbox", () => ({
	...inboxModule,
	wakeInboxIfEligible: async () => {
		wakeCalls++;
		return false;
	},
}));

const sessionModule = { ...(await import("../../services/narrator-session")) };
let directSendCalls = 0;
mock.module("../../services/narrator-session", () => ({
	...sessionModule,
	sendMessage: async () => {
		directSendCalls++;
		throw new Error("direct send must not happen");
	},
}));

const wsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...wsModule,
	broadcastToNarrator: () => {},
}));

const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { runtimeInbox } = await import("../../services/agent-runtime/inbox");

const OWNER = "mailbox-admission-owner";
const NARRATOR_ID = "mailbox-admission-primary";
const SUBAGENT_ID = "mailbox-admission-subagent";
const SOURCE_ID = "mailbox-admission-source";

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
		return new Response(JSON.stringify({ error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
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
	await db.insert(narrators).values([
		{
			id: NARRATOR_ID,
			title: "mailbox primary",
			ownerUserId: OWNER,
			visibility: "private",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SUBAGENT_ID,
			title: "mailbox subagent",
			ownerUserId: OWNER,
			visibility: "private",
			variant: "subagent:general",
			type: "subagent",
			parentNarratorId: NARRATOR_ID,
			aclRootNarratorId: NARRATOR_ID,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: SOURCE_ID,
			title: "mailbox source",
			ownerUserId: OWNER,
			visibility: "private",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		},
	]);

	for (const narratorId of [NARRATOR_ID, SUBAGENT_ID]) {
		runtimeInbox.enqueue({
			kind: "agent_message",
			narratorId,
			sourceNarratorId: SOURCE_ID,
			sourceToolCallId: `source-tool-${narratorId}`,
			sourceAttempt: 1,
			sourceKey: "send",
			text: "earlier agent work",
			projectedByteSize: Buffer.byteLength("earlier agent work"),
		});
	}
});

afterAll(() => {
	mock.restore();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

test("queues HTTP user input behind an earlier mailbox item instead of direct send", async () => {
	const response = await app().request(`http://localhost/narrators/${NARRATOR_ID}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "new user work" }),
	});

	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({ buffered: true });
	expect(directSendCalls).toBe(0);
	expect(wakeCalls).toBe(1);
	expect(runtimeInbox.list(NARRATOR_ID).filter((row) => row.kind === "user_input")).toHaveLength(1);
});

test("queues /goal behind mailbox work instead of mutating the spec fast path", async () => {
	const response = await app().request(`http://localhost/narrators/${NARRATOR_ID}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "/goal queued objective" }),
	});

	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({ buffered: true, specGoalQueued: true });
	expect(directSendCalls).toBe(0);
	expect(wakeCalls).toBe(2);
	expect(runtimeInbox.list(NARRATOR_ID).filter((row) => row.kind === "user_input")).toHaveLength(2);
});

test("wakes a subagent mailbox after queuing user input behind agent work", async () => {
	const response = await app().request(`http://localhost/narrators/${SUBAGENT_ID}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "human follow up" }),
	});

	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({ buffered: true });
	expect(directSendCalls).toBe(0);
	expect(wakeCalls).toBe(3);
	expect(runtimeInbox.list(SUBAGENT_ID).filter((row) => row.kind === "user_input")).toHaveLength(1);
});
