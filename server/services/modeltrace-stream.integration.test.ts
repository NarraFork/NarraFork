import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { StreamingBlock } from "../../frontend/components/narrator/message/message-segments";
import { applyStreamingDelta } from "../../frontend/components/narrator/streaming/streaming-delta-fold";
import { getTestDb } from "../../tests/setup";
import { apiRequests, narratorMessageRefs, narratorMessages, narrators, users } from "../db/schema";
import {
	forgetModelTraceRequest,
	rememberModelTraceRequest,
} from "../lib/agent/modeltrace-request";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../lib/agent/provider";

const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("@server/db", () => dbStub);
mock.module("../db", () => dbStub);
const realWs = { ...(await import("../websocket/narrator-ws")) };
interface FrameMessage {
	type: string;
	event?: { delta?: { type?: string; text?: string } };
	message?: { id: string; role: string };
	messageId?: string;
}
const frames: Array<{ target: string; message: FrameMessage }> = [];
let onFrame: ((message: FrameMessage) => void) | undefined;
mock.module("../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (target: string, value: unknown) => {
		const message = value as FrameMessage;
		frames.push({ target, message });
		onFrame?.(message);
	},
	getNarratorConnections: () => [],
}));
let finished = Promise.withResolvers<void>();
mock.module("./agent-runtime/inbox", () => ({
	wakeInboxIfEligible: async () => {
		finished.resolve();
		return false;
	},
}));
const { getStreamingSnapshot, clearStreamingSnapshot } = await import("./narrator-event-handler");
const { narratorPersistence } = await import("./narrator-persistence");
const { retryModelTrace, cancelModelTrace } = await import("./modeltrace-service");
const { tryClaimExecution } = await import("./agent-runtime/ownership");
const id = "modeltrace-stream-child";
const userId = "modeltrace-stream-user";
let chat: ReturnType<typeof mock<ProviderAdapter["chat"]>>;
const source: ChatParams = {
	conversationId: "frozen-session",
	content: "frozen prefix",
	model: "test-model",
	cwd: "/test",
	history: [],
	tools: [],
	toolResults: [],
	signal: new AbortController().signal,
};

beforeEach(async () => {
	frames.length = 0;
	onFrame = undefined;
	finished = Promise.withResolvers<void>();
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "test", createdAt: now })
		.onConflictDoNothing();
	await db.insert(narrators).values({ id, traits: ["modeltrace"], createdAt: now, updatedAt: now });
	chat = mock(async function* () {
		yield { text: "answer" };
	});
	rememberModelTraceRequest(id, { chat } as unknown as ProviderAdapter, source, "test-provider");
});
afterEach(async () => {
	cancelModelTrace(id);
	forgetModelTraceRequest(id);
	clearStreamingSnapshot(id);
	onFrame = undefined;
	mock.restore();
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		await db.delete(apiRequests).where(eq(apiRequests.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
});
afterAll(() => sqlite.close());

async function launch() {
	await retryModelTrace(id, userId);
}
async function replies() {
	return (
		await db.query.narratorMessages.findMany({ where: eq(narratorMessages.narratorId, id) })
	).filter((row) => row.role === "assistant");
}
function deltas() {
	return frames.filter(
		({ message }) => message.type === "stream_event" && message.event?.delta?.type === "text_delta",
	);
}
function assertReleased() {
	const owner = tryClaimExecution(id, "run");
	expect(owner).not.toBeNull();
	owner?.release();
	expect(cancelModelTrace(id)).toBe(false);
}

test("native prefix and reconnect snapshot are visible before completion; final answer keeps one identity and metadata", async () => {
	const partial = spyOn(narratorPersistence, "createPartialAssistantMessage");
	const next = Promise.withResolvers<void>();
	const prefix = Promise.withResolvers<void>();
	let providerEnded = false;
	const answer = JSON.stringify(Array(300).fill(17));
	chat.mockImplementation(async function* (params) {
		expect(params.conversationId).toBe(source.conversationId);
		expect(params.content.startsWith(source.content)).toBe(true);
		yield { reasoning: "private reasoning" };
		yield { text: answer.slice(0, 12) };
		await next.promise;
		yield { text: answer.slice(12), messageId: "native-message", credentialId: "credential" };
		yield {
			usage: { inputTokens: 12, completionTokens: 40 },
			contextUsagePercentage: 23,
			metering: { usage: 1.25, unit: "credit", unitPlural: "credits" },
		};
		providerEnded = true;
	});
	onFrame = (message) => {
		if (message.event?.delta?.type === "text_delta") prefix.resolve();
	};
	await launch();
	await prefix.promise;
	expect(providerEnded).toBe(false);
	expect(deltas()[0]?.message.event?.delta?.text).toBe(answer.slice(0, 12));
	expect(frames.every((frame) => frame.target === id)).toBe(true);
	const snapshot = getStreamingSnapshot(id);
	expect(snapshot?.streamingBlocks).toHaveLength(1);
	expect(snapshot?.streamingBlocks[0]).toMatchObject({ type: "text", text: answer.slice(0, 12) });
	const blockId = snapshot?.streamingBlocks[0]?.id;
	expect(JSON.stringify(frames)).not.toContain("private reasoning");
	next.resolve();
	await finished.promise;
	const rows = await replies();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		messageUuid: "native-message",
		outputTokens: 40,
		ttftMs: expect.any(Number),
		durationMs: expect.any(Number),
		contextPercent: 23,
		meterUsage: 1.25,
		meterUnit: "credit",
		parentToolUseId: null,
	});
	expect(rows[0]?.contentJson).toMatchObject([{ id: blockId, text: answer, completed: true }]);
	expect(partial).toHaveBeenCalledTimes(1);
	const created = (await partial.mock.results[0]?.value) as { id: string };
	expect(created.id).toBe(rows[0]?.id);
	const final = frames.filter(
		({ message }) => message.type === "message" && message.message?.role === "assistant",
	);
	expect(final).toHaveLength(1);
	expect(final[0]?.message.message?.id).toBe(rows[0]?.id);
	expect(
		deltas()
			.map(({ message }) => message.event?.delta?.text)
			.join(""),
	).toBe(answer);
	const folded: StreamingBlock[] = [];
	for (const { message } of deltas()) {
		expect(applyStreamingDelta(folded, message.event, false).applied).toBe(true);
	}
	expect(folded).toMatchObject([{ type: "text", id: blockId, text: answer, textOffset: 0 }]);
	expect(getStreamingSnapshot(id)).toBeUndefined();
	const requests = await db.query.apiRequests.findMany({ where: eq(apiRequests.narratorId, id) });
	expect(requests).toHaveLength(1);
	expect(requests[0]?.messageId).toBe(rows[0]?.id);
	expect(chat).toHaveBeenCalledTimes(1);
	assertReleased();
});

test("coalesces a burst into incremental chunks and flushes pending text during a provider pause", async () => {
	const pause = Promise.withResolvers<void>();
	const prefix = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	chat.mockImplementation(async function* () {
		yield { text: "first" };
		for (let i = 0; i < 100; i++) yield { text: "x" };
		await pause.promise;
		yield { text: "last" };
	});
	onFrame = (message) => {
		if (message.event?.delta?.text === "first") prefix.resolve();
		if (
			deltas()
				.map(({ message }) => message.event?.delta?.text)
				.join("") === `first${"x".repeat(100)}`
		)
			pending.resolve();
	};
	await launch();
	await prefix.promise;
	await pending.promise;
	expect(deltas().length).toBeLessThan(10);
	expect(getStreamingSnapshot(id)?.streamingBlocks[0]).toMatchObject({
		text: `first${"x".repeat(100)}`,
	});
	pause.resolve();
	await finished.promise;
	expect(deltas()[0]?.message.event?.delta?.text).toBe("first");
	expect(deltas().at(-1)?.message.event?.delta?.text).toBe("last");
	expect(
		deltas()
			.map(({ message }) => message.event?.delta?.text)
			.join(""),
	).toBe(`first${"x".repeat(100)}last`);
	expect((await replies())[0]?.contentText).toBe(`first${"x".repeat(100)}last`);
	assertReleased();
});

test("cancellation seals incomplete text, retains usage, clears snapshot, and retries with a fresh block identity", async () => {
	const prefix = Promise.withResolvers<void>();
	chat.mockImplementation(() => {
		let count = 0;
		return {
			next: async () => {
				if (count++ === 0)
					return {
						done: false,
						value: { text: "interrupted", usage: { inputTokens: 7, completionTokens: 3 } },
					};
				return new Promise(() => {});
			},
			return: async () => ({ done: true, value: undefined }),
		} as unknown as AsyncGenerator<ParsedStreamEvent>;
	});
	onFrame = (message) => {
		if (message.event?.delta) prefix.resolve();
	};
	await launch();
	await prefix.promise;
	const firstBlockId = getStreamingSnapshot(id)?.streamingBlocks[0]?.id;
	expect(cancelModelTrace(id)).toBe(true);
	await finished.promise;
	let rows = await replies();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.contentJson).toMatchObject([
		{ id: firstBlockId, text: "interrupted", completed: false },
	]);
	expect(rows[0]?.outputTokens).toBe(3);
	expect(getStreamingSnapshot(id)).toBeUndefined();
	assertReleased();
	finished = Promise.withResolvers<void>();
	chat.mockImplementation(async function* () {
		yield { text: "retry answer" };
	});
	await launch();
	await finished.promise;
	rows = await replies();
	expect(rows).toHaveLength(2);
	const retry = rows.find((row) => row.contentText === "retry answer");
	expect(retry?.contentJson).toMatchObject([{ completed: true, text: "retry answer" }]);
	expect((retry?.contentJson as Array<{ id: string }>)[0]?.id).not.toBe(firstBlockId);
	expect(getStreamingSnapshot(id)).toBeUndefined();
	expect(
		await db.query.apiRequests.findMany({ where: eq(apiRequests.narratorId, id) }),
	).toHaveLength(2);
	assertReleased();
});

test("usage-only cancellation persists one native answer and associates its billing identity", async () => {
	const received = Promise.withResolvers<void>();
	chat.mockImplementation(() => {
		let count = 0;
		return {
			next: async () => {
				if (count++ === 0)
					return { done: false, value: { usage: { inputTokens: 9, completionTokens: 2 } } };
				received.resolve();
				return new Promise(() => {});
			},
			return: async () => ({ done: true, value: undefined }),
		} as unknown as AsyncGenerator<ParsedStreamEvent>;
	});
	await launch();
	await received.promise;
	cancelModelTrace(id);
	await finished.promise;
	const rows = await replies();
	expect(rows).toHaveLength(1);
	expect(rows[0]?.outputTokens).toBe(2);
	const requests = await db.query.apiRequests.findMany({ where: eq(apiRequests.narratorId, id) });
	expect(requests).toHaveLength(1);
	expect(requests[0]?.messageId).toBe(rows[0]?.id);
	expect(getStreamingSnapshot(id)).toBeUndefined();
	assertReleased();
});

test("local report failure cannot strand a sealed answer or execution owner", async () => {
	const persistReport = spyOn(narratorPersistence, "persistDisplayMessage").mockRejectedValue(
		new Error("report write failed"),
	);
	try {
		await launch();
		await finished.promise;
		expect(await replies()).toHaveLength(1);
		expect(frames.some(({ message }) => message.type === "streaming_reset")).toBe(true);
		expect(getStreamingSnapshot(id)).toBeUndefined();
		assertReleased();
	} finally {
		persistReport.mockRestore();
	}
});

test.each([
	false,
	true,
])("seal failure resets the stream, preserves billing identity, and releases ownership (usageOnly=%s)", async (usageOnly) => {
	if (usageOnly)
		chat.mockImplementation(async function* () {
			yield { usage: { inputTokens: 9, completionTokens: 2 } };
		});
	const original = narratorPersistence.patchStepMeta.bind(narratorPersistence);
	let failed = false;
	const patch = spyOn(narratorPersistence, "patchStepMeta").mockImplementation(async (...args) => {
		if (!failed) {
			failed = true;
			throw new Error("seal failed");
		}
		return original(...args);
	});
	try {
		await launch();
		await finished.promise;
		expect(frames.some(({ message }) => message.type === "streaming_reset")).toBe(true);
		expect(getStreamingSnapshot(id)).toBeUndefined();
		const rows = await replies();
		expect(rows).toHaveLength(1);
		const requests = await db.query.apiRequests.findMany({ where: eq(apiRequests.narratorId, id) });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.messageId).toBe(rows[0]?.id);
		expect(patch).toHaveBeenCalledTimes(2);
		assertReleased();
	} finally {
		patch.mockRestore();
	}
});
