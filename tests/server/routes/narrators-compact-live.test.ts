import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	type CompactLiveStreamEvent,
	consumeCompactLiveStream,
} from "@frontend/lib/compact-live-stream";
import { db } from "@server/db";
import { narrators, users } from "@server/db/schema";
import { shutdownDbWorkerPool } from "@server/lib/db-worker/pool";
import { generateId } from "@server/lib/id";
import { narratorRoutes } from "@server/routes/narrators";
import { createCompactProgressReporter } from "@server/services/narrator-compact";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const owner = generateId();
const narratorId = generateId();
const livePath = (messageId: string) => `/api/narrators/${narratorId}/compact/${messageId}/live`;
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: owner, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.route("/api/narrators", narratorRoutes);

beforeAll(async () => {
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: owner, username: owner, passwordHash: "unused", createdAt: now });
	await db.insert(narrators).values({
		id: narratorId,
		ownerUserId: owner,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	// Start the ACL read worker before the time-bounded streaming cases.
	expect((await app.request(livePath(generateId()))).status).toBe(409);
}, 30_000);
afterAll(async () => {
	await shutdownDbWorkerPool();
	await db.delete(narrators).where(eq(narrators.id, narratorId));
	await db.delete(users).where(eq(users.id, owner));
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(() => cleanup?.());

function start(isSegment = false) {
	const messageId = generateId();
	const path = livePath(messageId);
	const progress = createCompactProgressReporter({
		narratorId,
		messageId,
		mode: "blocking",
		isSegment,
	});
	const viewers: Response[] = [];
	cleanup = async () => {
		progress.finish();
		progress.close("failed");
		for (const response of viewers) {
			if (response.body && !response.body.locked) await response.body.cancel();
		}
	};
	async function openViewer(query = "") {
		const response = await app.request(path + query);
		viewers.push(response);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		return response;
	}
	return { progress, openViewer, path };
}
async function readViewer(response: Response, onEvent?: (event: CompactLiveStreamEvent) => void) {
	const events: CompactLiveStreamEvent[] = [];
	await consumeCompactLiveStream(response, (event) => {
		events.push(event);
		onEvent?.(event);
	});
	return events;
}

function delta(
	channel: "output" | "thinking",
	text: string,
	outputChars: number,
	thinkingChars: number,
): Extract<CompactLiveStreamEvent, { kind: "delta" }> {
	return { kind: "delta", channel, delta: text, outputChars, thinkingChars };
}

test.each([
	"ordinary",
	"segment",
] as const)("%s compact gives each viewer its own coalesced deltas", async (kind) => {
	const { progress, openViewer } = start(kind === "segment");
	progress.onTextDelta("old/");
	progress.onReasoningDelta("why/");
	progress.beginRequest();

	// Leave the slow body unread: the two replay frames and heartbeat backpressure its writer.
	const slow = await openViewer("?outputOffset=2&thinkingOffset=3");
	const fast = await openViewer("?outputOffset=4&thinkingOffset=4");
	const firstFastDelta = Promise.withResolvers<void>();
	const fastDone = readViewer(fast, (event) => {
		if (event.kind === "delta") firstFastDelta.resolve();
	});
	// No await between chunks: both connections queue the same two broadcast objects.
	progress.onTextDelta("Hello");
	progress.onTextDelta(" world");
	await Promise.race([firstFastDelta.promise, fastDone]);
	progress.onTextDelta("!");
	progress.onReasoningDelta("bad");
	progress.onReasoningDelta("?");
	progress.resetDraft();
	progress.onReasoningDelta("ok");
	progress.onTextDelta("new");
	progress.close("compacted");

	const fastEvents = await fastDone;
	const slowEvents = await readViewer(slow);
	const heartbeat: Extract<CompactLiveStreamEvent, { kind: "heartbeat" }> = {
		kind: "heartbeat",
		outputChars: 4,
		thinkingChars: 4,
	};
	const rest: CompactLiveStreamEvent[] = [
		delta("thinking", "bad?", 16, 8),
		{
			kind: "reset",
			streamVersion: expect.any(Number),
			outputLength: 4,
			thinkingLength: 4,
			outputChars: 4,
			thinkingChars: 4,
		},
		delta("thinking", "ok", 4, 6),
		delta("output", "new", 7, 6),
		{ kind: "finished", status: "compacted" },
	];
	expect(fastEvents).toEqual([
		heartbeat,
		delta("output", "Hello world", 15, 4),
		delta("output", "!", 16, 4),
		...rest,
	]);
	expect(slowEvents).toEqual([
		delta("output", "d/", 4, 4),
		delta("thinking", "/", 4, 4),
		heartbeat,
		delta("output", "Hello world!", 16, 4),
		...rest,
	]);
});

test("a cancelled viewer does not interrupt bounded frames or terminal status for the other viewer", async () => {
	const { progress, openViewer, path } = start();
	const cancelled = await openViewer();
	const remaining = await openViewer();
	if (!cancelled.body) throw new Error("Missing SSE response body");
	await cancelled.body.cancel();
	const chunk = "x".repeat(31_999);
	progress.onTextDelta(chunk);
	progress.onTextDelta("!");
	progress.onTextDelta("?");
	progress.close("failed");
	expect(await readViewer(remaining)).toEqual([
		{ kind: "heartbeat", outputChars: 0, thinkingChars: 0 },
		delta("output", `${chunk}!`, 32_000, 0),
		delta("output", "?", 32_001, 0),
		{ kind: "finished", status: "failed" },
	]);
	const closed = await app.request(path);
	expect(closed.status).toBe(409);
	expect(await closed.json()).toMatchObject({ code: "COMPACT_NOT_RUNNING" });
});
