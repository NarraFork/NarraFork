/**
 * A `/goal` for a session whose tasks live in the outline (outline P2 PR 3): refused at every way
 * in, and dropped by the queue consumers if one gets into the queue anyway — never saved as a
 * message, never stalling the queue, never escaping the drain.
 *
 * Ways in: the HTTP admission (`narrators-message-admission.test.ts`), the queued-message edit
 * (`routes/__tests__/narrators-outline-goal.test.ts`), and the WebSocket `buffer_message` and
 * `update_buffer` frames (here). Consumers: `executeQueuedGoalCommand` itself, the post-interrupt
 * resume (`resumeNextBufferedMessage`) and the run's own queue consumer (here).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is set before each case (the preload restores settings after it).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { handleNarratorWS } from "../../websocket/narrator-ws";
import * as inbox from "../agent-runtime/inbox";
import { getExecutionOwner } from "../agent-runtime/ownership";
import { startNarratorRun } from "../agent-runtime/run";
import {
	enqueueBufferedMessage,
	getBufferedMessagesAsync,
	updateBufferedMessage,
} from "../narrator-buffer";
import type { ExecuteLoopResult } from "../narrator-executor";
import * as executor from "../narrator-executor";
import { narratorService } from "../narrator-service";
import {
	executeQueuedGoalCommand,
	parseQueuedGoalCommand,
	resumeNextBufferedMessage,
} from "../narrator-session";

const NOW = "2026-10-31T00:00:00.000Z";

const restores: Array<() => void> = [];
beforeEach(() => {
	settings.outline.enabled = true;
});
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

async function user(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `outline-goal-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

async function session(
	options: { backend?: "spec" | "outline"; status?: "idle" | "working"; owner?: string } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		status: options.status ?? "idle",
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner ?? null,
		cwd: "/tmp",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function savedMessages(narratorId: string): Promise<string[]> {
	const rows = await db
		.select({ text: narratorMessages.contentText })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return rows.map((row) => row.text ?? "");
}

async function queued(narratorId: string): Promise<string[]> {
	return (await getBufferedMessagesAsync(narratorId)).map((message) => message.text);
}

describe("the queue consumers drop an outline session's /goal unsaved", () => {
	test("executeQueuedGoalCommand refuses before saving anything", async () => {
		const id = await session();
		await enqueueBufferedMessage(id, "/goal ship it");
		const [buffered] = await getBufferedMessagesAsync(id);
		if (!buffered) throw new Error("expected a queued message");
		const goal = parseQueuedGoalCommand(buffered.text, buffered.commandText);
		expect(goal?.objective).toBe("ship it");
		expect(await executeQueuedGoalCommand(id, buffered, goal?.objective ?? "")).toEqual({
			refused: true,
		});
		expect(await savedMessages(id)).toEqual([]);
		expect(await queued(id)).toEqual([]);
	});

	test("a row edited into something else before the drop is claimed, seen, and left queued", async () => {
		const id = await session();
		await enqueueBufferedMessage(id, "/goal ship it");
		const [read] = await getBufferedMessagesAsync(id);
		if (!read) throw new Error("expected a queued message");
		// The person edits it after the consumer read it, before the refusal drops it.
		expect(await updateBufferedMessage(id, read.id, "fix the build instead")).toBe(true);
		expect(await executeQueuedGoalCommand(id, read, "ship it")).toEqual({ refused: true });
		const [left] = await getBufferedMessagesAsync(id);
		expect(left?.text).toBe("fix the build instead");
		expect(left?.state).toBe("queued");
		expect(await savedMessages(id)).toEqual([]);
	});

	test("a /goal not at the head is left for its consumer to meet", async () => {
		const id = await session();
		await enqueueBufferedMessage(id, "first, a plain message");
		await enqueueBufferedMessage(id, "/goal ship it");
		const goal = (await getBufferedMessagesAsync(id))[1];
		if (!goal) throw new Error("expected a queued /goal");
		expect(await executeQueuedGoalCommand(id, goal, "ship it")).toEqual({ refused: true });
		expect(await queued(id)).toEqual(["first, a plain message", "/goal ship it"]);
		expect(await savedMessages(id)).toEqual([]);
	});

	test("the post-interrupt resume drops it and drains on to the next message", async () => {
		const id = await session({ status: "working" });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it");
		await enqueueBufferedMessage(id, "and then this");
		const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(undefined as never);
		restores.push(() => wake.mockRestore());
		await resumeNextBufferedMessage({ narratorId: id, locale: "en" } as never, "en");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await savedMessages(id)).toEqual([]);
		expect(await queued(id)).toEqual(["and then this"]);
		// The drain goes on: the next message is woken, nothing is marked failed.
		expect(wake).toHaveBeenCalledWith(id, "en");
		expect((await narratorService.getById(id)).substatus).not.toContain("error");
		expect(getExecutionOwner(id)).toBeUndefined();
	});

	test("with nothing behind it the session settles idle, not in error", async () => {
		const id = await session({ status: "working" });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it");
		await resumeNextBufferedMessage({ narratorId: id, locale: "en" } as never, "en");
		const row = await narratorService.getById(id);
		expect(row.status).toBe("idle");
		expect(row.substatus).not.toContain("error");
		expect(await savedMessages(id)).toEqual([]);
		expect(await queued(id)).toEqual([]);
	});

	test("a spec session's queued /goal still runs as before", async () => {
		const id = await session({ backend: "spec" });
		await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it");
		const [buffered] = await getBufferedMessagesAsync(id);
		if (!buffered) throw new Error("expected a queued message");
		expect(await executeQueuedGoalCommand(id, buffered, "ship it")).toEqual({ refused: false });
		expect(await savedMessages(id)).toContain("/goal ship it");
	});

	test("the run's own queue consumer drops it and ends the run cleanly", async () => {
		const id = await session();
		await db
			.update(narrators)
			.set({ model: "outlinegoaltest:claude-sonnet-4" })
			.where(eq(narrators.id, id));
		settings.anthropicProviders = [
			{
				id: "outline-goal-test",
				name: "Outline goal test",
				prefix: "outlinegoaltest",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
			},
		];
		let passes = 0;
		const model = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			passes++;
			// Queued while the session works, past every entry point (as an edit could).
			if (passes === 1)
				await enqueueBufferedMessage(id, "/goal ship it", undefined, "/goal ship it");
			const result: ExecuteLoopResult = {
				finalText: "done",
				hasError: false,
				shouldUpdateTitle: false,
				hadToolUses: false,
				completedNaturally: true,
			};
			return result;
		});
		restores.push(() => model.mockRestore());
		const run = await startNarratorRun({
			narratorId: id,
			text: "start",
			locale: "en",
			principal: null,
			foreground: true,
		});
		expect((await run.terminal).hasError).toBe(false);
		expect(passes).toBe(1);
		const saved = await savedMessages(id);
		expect(saved.some((text) => text.includes("/goal"))).toBe(false);
		expect(await queued(id)).toEqual([]);
	});
});

describe("the WebSocket ways in refuse it before queueing", () => {
	function openWs(userId: string) {
		const sent: Array<Record<string, unknown>> = [];
		const ws = {
			data: {
				channel: "narrator" as const,
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				subscribedNarrators: new Set<string>(),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
				userId,
				userRole: "user",
			},
			send(payload: string) {
				sent.push(JSON.parse(payload) as Record<string, unknown>);
			},
		} as unknown as Parameters<typeof handleNarratorWS.open>[0];
		handleNarratorWS.open(ws);
		restores.push(() => handleNarratorWS.close(ws));
		return { ws, sent };
	}

	test("buffer_message and update_buffer with /goal leave the queue as it was", async () => {
		const owner = await user();
		const id = await session({ owner, status: "working" });
		const { ws, sent } = openWs(owner);
		await handleNarratorWS.message(ws, {
			type: "buffer_message",
			narratorId: id,
			text: "/goal ship it",
		});
		expect(await queued(id)).toEqual([]);
		expect(
			sent.some((frame) => frame.type === "error" && String(frame.message).includes("/goal")),
		).toBe(true);

		const plain = await enqueueBufferedMessage(id, "fix the build");
		await handleNarratorWS.message(ws, {
			type: "update_buffer",
			narratorId: id,
			messageId: plain.id,
			text: "/goal ship it",
		});
		expect(await queued(id)).toEqual(["fix the build"]);
		expect(await savedMessages(id)).toEqual([]);
	});
});
