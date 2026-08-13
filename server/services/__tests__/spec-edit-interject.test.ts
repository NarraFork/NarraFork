/**
 * Delivery contract for UI spec edits.
 *
 * The bug this pins: a spec edit reached the model only as a low-weight aside
 * appended to the next turn's text (historically a `<side_car>` block). Because
 * `taskReflection` reads the parent history, it could not distinguish a task the
 * user had just added from noise the assistant injected itself, and rejected
 * such tasks as "off the main line". A working narrator must instead receive the
 * edit as a real cut-in user message.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PendingSpecUpdate } from "../spec-update-queue";

const NARRATOR_ID = "spec-edit-interject-narrator";

// ── Buffer queue double ───────────────────────────────────────────────────────
// A real in-memory queue rather than call-recording stubs: the merge behavior
// under test is about queue CONTENT and ORDER, which assertions on call
// arguments alone would not catch.

interface FakeBuffered {
	id: string;
	text: string;
	bufferedAt: string;
	priority?: boolean;
}

let queue: FakeBuffered[] = [];
let nextBufferId = 1;
/** Set to simulate a full queue / an inactive narrator. */
let pushRejects: { full?: boolean } | null = null;

const realBufferModule = { ...(await import("../narrator-buffer")) };
mock.module("../narrator-buffer", () => ({
	...realBufferModule,
	pushBufferedMessage: async (
		_narratorId: string,
		text: string,
		_images?: unknown,
		_commandText?: unknown,
		_createdBy?: unknown,
		_creator?: unknown,
		_textFiles?: unknown,
		position?: "back" | "front",
	) => {
		if (pushRejects) {
			return { ok: false, bufferedAt: "", id: "", full: pushRejects.full };
		}
		const entry: FakeBuffered = {
			id: `buf-${nextBufferId++}`,
			text,
			bufferedAt: new Date().toISOString(),
			priority: position === "front" || undefined,
		};
		if (position === "front") queue.unshift(entry);
		else queue.push(entry);
		return { ok: true, bufferedAt: entry.bufferedAt, id: entry.id };
	},
	updateBufferedMessage: (_narratorId: string, messageId: string, text: string) => {
		const msg = queue.find((m) => m.id === messageId);
		if (!msg) return false;
		msg.text = text;
		return true;
	},
	getBufferedMessages: () => queue,
	toBufferSummary: (msgs: readonly FakeBuffered[]) =>
		msgs.map((m) => ({
			id: m.id,
			text: m.text,
			bufferedAt: m.bufferedAt,
			imageCount: 0,
			creator: null,
			priority: m.priority,
		})),
}));

// ── Session double ────────────────────────────────────────────────────────────

let loopRunning = true;
const softStopRequests: string[] = [];

const realSessionModule = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSessionModule,
	isLoopRunning: () => loopRunning,
	requestBufferedMessageSoftStop: (narratorId: string) => {
		softStopRequests.push(narratorId);
		return true;
	},
}));

// ── Sidecar queue double ──────────────────────────────────────────────────────

const idleQueued: PendingSpecUpdate[] = [];
const realSpecUpdateQueue = { ...(await import("../spec-update-queue")) };
mock.module("../spec-update-queue", () => ({
	...realSpecUpdateQueue,
	pushSpecUpdateForNarrator: (_narratorId: string, update: PendingSpecUpdate) => {
		idleQueued.push(update);
	},
}));

// ── Broadcast double ──────────────────────────────────────────────────────────

const broadcasts: Array<{ target: string; message: Record<string, unknown> }> = [];
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: (narratorId: string, message: Record<string, unknown>) => {
		broadcasts.push({ target: narratorId, message });
	},
}));

const { formatSpecEditInterjection, interjectSpecEditAsUserMessage } = await import(
	"../spec-edit-interject"
);

function tasksUpdate(taskSummary: string): PendingSpecUpdate {
	return {
		uri: "spec://tasks.json",
		path: "tasks.json",
		revisionId: "rev-1",
		updatedBy: "user",
		preview: null,
		taskSummary,
		timestamp: new Date().toISOString(),
	};
}

/** Save through the panel. `userId` is null so no `users` lookup is needed. */
function save(update: PendingSpecUpdate) {
	return interjectSpecEditAsUserMessage(NARRATOR_ID, update, "en", null);
}

function bufferSetEvents() {
	return broadcasts.filter((b) => b.message.type === "buffer_set");
}

beforeEach(() => {
	queue = [];
	nextBufferId = 1;
	pushRejects = null;
	loopRunning = true;
	softStopRequests.length = 0;
	idleQueued.length = 0;
	broadcasts.length = 0;
});

afterAll(() => {
	mock.module("../narrator-buffer", () => realBufferModule);
	mock.module("../narrator-session", () => realSessionModule);
	mock.module("../spec-update-queue", () => realSpecUpdateQueue);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	mock.restore();
});

describe("interjectSpecEditAsUserMessage — working narrator", () => {
	test("cuts in at the front of the queue and requests a soft stop", async () => {
		const result = await save(tasksUpdate("- [doing] Ship the parser"));

		expect(result.delivered).toBe("interjected");
		expect(queue).toHaveLength(1);
		// Front-of-queue is what makes it land right after the current tool call.
		expect(queue[0].priority).toBe(true);
		expect(queue[0].text).toContain("Ship the parser");
		expect(softStopRequests).toEqual([NARRATOR_ID]);
		// Must NOT also go down the low-weight queued path.
		expect(idleQueued).toHaveLength(0);
	});

	test("broadcasts the queue snapshot so the panel shows the queued message", async () => {
		// Regression: pushBufferedMessage only touches the map and DB. Without an
		// explicit broadcast the interjected message stays invisible in the
		// narrator panel until a manual refresh.
		await save(tasksUpdate("- [todo] Write the tests"));

		const events = bufferSetEvents();
		expect(events).toHaveLength(1);
		expect(events[0].target).toBe(NARRATOR_ID);
		const messages = events[0].message.messages as Array<{ id: string; text: string }>;
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toContain("Write the tests");
	});
});

describe("interjectSpecEditAsUserMessage — rapid saves", () => {
	test("collapses consecutive saves into one message without reversing order", async () => {
		// The Spec panel binds mod+s, so several saves during one tool call are
		// routine. Unshifting each would stack near-duplicates AND put the newest
		// first, which reads as out-of-order to the model.
		await save(tasksUpdate("- [doing] First snapshot"));
		await save(tasksUpdate("- [doing] Second snapshot"));
		await save(tasksUpdate("- [doing] Third snapshot"));

		expect(queue).toHaveLength(1);
		// The surviving entry carries the LATEST task snapshot.
		expect(queue[0].text).toContain("Third snapshot");
		expect(queue[0].text).not.toContain("First snapshot");
		// Every save still asks for the boundary, since an earlier request may
		// already have been consumed.
		expect(softStopRequests).toHaveLength(3);
		expect(bufferSetEvents()).toHaveLength(3);
	});

	test("keeps an unrelated queued message intact while merging its own", async () => {
		queue.push({ id: "user-typed", text: "please also fix the lint", bufferedAt: "t0" });

		await save(tasksUpdate("- [doing] First snapshot"));
		await save(tasksUpdate("- [doing] Second snapshot"));

		expect(queue).toHaveLength(2);
		expect(queue[0].text).toContain("Second snapshot");
		expect(queue[1].text).toBe("please also fix the lint");
	});

	test("creates a fresh message once the tracked one was consumed", async () => {
		await save(tasksUpdate("- [doing] First snapshot"));
		expect(queue).toHaveLength(1);

		// The loop consumed it (or the user cancelled it) — liveness is decided by
		// queue membership, so no cleanup hook runs and the next save must not try
		// to rewrite a message that no longer exists.
		queue = [];

		await save(tasksUpdate("- [doing] Second snapshot"));

		expect(queue).toHaveLength(1);
		expect(queue[0].text).toContain("Second snapshot");
	});
});

describe("interjectSpecEditAsUserMessage — idle queue fallback", () => {
	test("an idle narrator is not woken and stays on the queued path", async () => {
		loopRunning = false;

		const result = await save(tasksUpdate("- [todo] Later work"));

		expect(result.delivered).toBe("queued");
		expect(queue).toHaveLength(0);
		expect(softStopRequests).toHaveLength(0);
		expect(idleQueued).toHaveLength(1);
		expect(idleQueued[0].taskSummary).toContain("Later work");
	});

	test("a full queue falls back instead of dropping the notification", async () => {
		pushRejects = { full: true };

		const result = await save(tasksUpdate("- [todo] Overflow work"));

		expect(result.delivered).toBe("queued");
		expect(idleQueued).toHaveLength(1);
	});

	test("an inactive narrator (e.g. a subagent) falls back safely", async () => {
		// A subagent's queue lives in a separate map, so pushBufferedMessage
		// reports ok: false rather than throwing.
		pushRejects = {};

		const result = await save(tasksUpdate("- [todo] Subagent work"));

		expect(result.delivered).toBe("queued");
		expect(idleQueued).toHaveLength(1);
	});
});

describe("formatSpecEditInterjection", () => {
	test("reads as a first-person user instruction, not a system aside", () => {
		const en = formatSpecEditInterjection(tasksUpdate("- [doing] Build the thing"), "en");
		expect(en).toContain("I updated spec://tasks.json via the Spec panel");
		expect(en).toContain("Open tasks:");
		expect(en).toContain("- [doing] Build the thing");
		// The aside's third-person framing is exactly what diluted its weight.
		expect(en).not.toContain("[System]");
		expect(en).not.toContain("The user updated");

		const zh = formatSpecEditInterjection(tasksUpdate("- [doing] 构建功能"), "zh-CN");
		expect(zh).toContain("我通过 Spec 面板更新了 spec://tasks.json");
		expect(zh).toContain("当前开放任务：");
		expect(zh).not.toContain("[系统]");
	});

	test("falls back to a content preview for non-task files", () => {
		const update: PendingSpecUpdate = {
			uri: "spec://behavior_fence",
			path: "behavior_fence",
			revisionId: "rev-2",
			updatedBy: "user",
			preview: "Never touch auth without approval.",
			taskSummary: null,
			timestamp: new Date().toISOString(),
		};

		const en = formatSpecEditInterjection(update, "en");
		expect(en).toContain("Content preview:");
		expect(en).toContain("Never touch auth without approval.");
	});

	test("a cleared task list tells the model to stop resurrecting old tasks", () => {
		const update: PendingSpecUpdate = {
			uri: "spec://tasks.json",
			path: "tasks.json",
			revisionId: "rev-3",
			updatedBy: "user",
			preview: null,
			taskSummary: null,
			cleared: true,
			timestamp: new Date().toISOString(),
		};

		const en = formatSpecEditInterjection(update, "en");
		expect(en).toContain("cleared the task list");
		expect(en).toContain("wait for my next instruction");
		// The whole point of the flag: no stale task summary may ride along.
		expect(en).not.toContain("Open tasks:");

		const zh = formatSpecEditInterjection(update, "zh-CN");
		expect(zh).toContain("清空了任务列表");
		expect(zh).toContain("等待我的下一条指令");
	});

	test("a namespace reset tells the model to drop the earlier plan", () => {
		const update: PendingSpecUpdate = {
			uri: "spec://",
			path: "",
			revisionId: null,
			updatedBy: "user",
			preview: null,
			taskSummary: null,
			reset: true,
			timestamp: new Date().toISOString(),
		};

		const en = formatSpecEditInterjection(update, "en");
		expect(en).toContain("reset the entire Dynamic Spec");
		expect(en).toContain("Drop the earlier plan");

		const zh = formatSpecEditInterjection(update, "zh-CN");
		expect(zh).toContain("重置了整个 Dynamic Spec");
	});
});
