import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { agentMessageDeliveryBody } from "../agent-message-delivery";
import {
	beginAgentReplyWaitRun,
	clearPendingAgentReplyWaits,
	getActiveSendDeliveryTargets,
	registerAgentReplyWait,
	resolvePendingAgentReply,
} from "../agent-reply-waiter";
import { drainPendingInjections, runItems } from "../parent-injection-queue";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const realWs = { ...(await import("../../websocket/narrator-ws")) };
const broadcasts: Array<{ target: string; event: Record<string, unknown> }> = [];
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (target: string, event: Record<string, unknown>) =>
		broadcasts.push({ target, event }),
}));
const realAgent = { ...(await import("../../lib/agent")) };
mock.module("../../lib/agent", () => ({
	...realAgent,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
}));
const { narratorService } = await import("../narrator-service");
const { deliverInjection } = await import("../narrator-injection");
const realResume = { ...(await import("../subagent-resume")) };
let resumeFails = false;
mock.module("../subagent-resume", () => ({
	...realResume,
	resumeSubagent: async (input: import("../subagent-resume").ResumeSubagentInput) => {
		if (resumeFails) throw new Error("resume rejected");
		const userMessage = await narratorService.persistSubagentUserMessage(
			input.subagentId,
			input.prompt ?? "",
			"origin",
			{ delivery: input.delivery, createdBy: input.createdBy },
		);
		return { started: true, userMessage };
	},
}));
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const {
	clearSubagentBufferedMessages,
	consumeNextBufferedSubagentMessage,
	consumeBufferedSubagentMessageInPass,
	executeSubagent,
	getSubagentBufferedMessages,
	pushSubagentBufferedMessage,
	reorderSubagentBufferedMessages,
	updateSubagentBufferedMessage,
} = await import("../subagent-executor");
const { clearTeamInbox, deliverTeamMessage, drainTeamInbox } = await import("../subagent-team");
const now = "2026-09-08T12:00:00.000Z";
function seed(id: string, parent: string | null, status = "working") {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, type, variant, parent_narrator_id, status, is_background, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			parent ? "subagent" : "primary",
			parent ? "subagent:general" : "primary",
			parent,
			status,
			parent ? 1 : 0,
			now,
			now,
		);
}
function send(
	callerNarratorId = "parent",
	id = "child",
	extra: Partial<Parameters<typeof sendSubagentMessageDetailed>[0]> = {},
) {
	return sendSubagentMessageDetailed({
		callerNarratorId,
		id,
		message: "same words",
		toolUseId: "send-call",
		signal: new AbortController().signal,
		locale: "en",
		...extra,
	});
}
function row(id: string | undefined) {
	return sqlite
		.prepare("SELECT id, role, content_text, content_json FROM narrator_messages WHERE id = ?")
		.get(id ?? "") as {
		id: string;
		role: string;
		content_text: string;
		content_json: string;
	} | null;
}
async function consume() {
	return consumeNextBufferedSubagentMessage({
		narratorId: "child",
		parentNarratorId: "parent",
		toolUseId: "origin",
		model: "test-model",
		provider: "anthropic",
		cwd: ".",
		pruneBoundaryId: null,
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	clearPendingAgentReplyWaits();
	clearSubagentBufferedMessages("child");
	drainPendingInjections("parent");
	clearTeamInbox("child");
	clearTeamInbox("sibling");
	broadcasts.length = 0;
	resumeFails = false;
	seed("parent", null);
	seed("child", "parent");
	seed("sibling", "parent");
});
afterAll(() => {
	clearPendingAgentReplyWaits();
	clearSubagentBufferedMessages("child");
	drainPendingInjections("parent");
	mock.module("../subagent-resume", () => realResume);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.module("../../db", () => realDb);
	mock.module("../../lib/agent", () => realAgent);
});

describe("Send exact delivery receipts", () => {
	test("busy child receipt remains nonexistent until actual drain, then points to the one persisted/broadcast row", async () => {
		const notifications: unknown[] = [];
		const result = await send("parent", "child", {
			onDeliveryResolved: (receipt) => notifications.push(receipt),
		});
		const id = result.targets[0].deliveryMessageId;
		expect(result.targets[0].status).toBe("queued");
		expect(id).toBeString();
		expect(row(id)).toBeNull();
		expect(notifications).toEqual([{ id: "child", deliveryMessageId: id }]);
		const envelope = getSubagentBufferedMessages("child")[0].delivery;
		expect(envelope?.recipientMessageId).toBe(id);
		const consumed = await consume();
		expect(consumed?.prompt).toBe("[Message from the parent narrator]\nsame words");
		expect(row(id)?.role).toBe("user");
		expect(JSON.parse(row(id)?.content_json ?? "[]")[1]).toEqual({
			type: "system_injection",
			source: "subagent_message",
			body: agentMessageDeliveryBody(envelope as NonNullable<typeof envelope>),
		});
		const received = broadcasts.filter(({ event }) => event.type === "user_message");
		expect(received).toHaveLength(2);
		expect(received.map(({ target }) => target).sort()).toEqual(["child", "parent"]);
		expect(received.every(({ event }) => (event.message as { id: string }).id === id)).toBe(true);
		expect(await consume()).toBeNull();
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(1);
	});

	test("same text from separate senders has distinct receipts even when priority reorders delivery", async () => {
		const first = await send();
		const second = await send("sibling", "child", { toolUseId: "sibling-send" });
		const ids = [first.targets[0].deliveryMessageId, second.targets[0].deliveryMessageId];
		expect(ids[0]).not.toBe(ids[1]);
		reorderSubagentBufferedMessages(
			"child",
			getSubagentBufferedMessages("child")
				.map((item) => item.id)
				.reverse(),
		);
		await consume();
		await consume();
		expect(JSON.parse(row(ids[0])?.content_json ?? "[]")[1].body.items[0].fromId).toBe("parent");
		expect(JSON.parse(row(ids[1])?.content_json ?? "[]")[1].body.items[0].fromId).toBe("sibling");
	});

	test("queue clearing and a later identical human input cannot reuse the removed delivery", async () => {
		const result = await send();
		const reserved = result.targets[0].deliveryMessageId;
		clearSubagentBufferedMessages("child");
		pushSubagentBufferedMessage("child", "[Message from the parent narrator]\nsame words");
		await consume();
		expect(row(reserved)).toBeNull();
		const human = sqlite.prepare("SELECT origin, content_json FROM narrator_messages").get() as {
			origin: string;
			content_json: string;
		};
		expect(human.origin).toBe("user");
		expect(JSON.parse(human.content_json)).toHaveLength(1);
	});

	test("a human edit invalidates the queued receipt and agent attribution", async () => {
		const result = await send();
		const queued = getSubagentBufferedMessages("child")[0];
		updateSubagentBufferedMessage("child", queued.id, "human correction");
		await consume();
		expect(row(result.targets[0].deliveryMessageId)).toBeNull();
		const actual = sqlite.prepare("SELECT origin, content_text FROM narrator_messages").get() as {
			origin: string;
			content_text: string;
		};
		expect(actual).toEqual({ origin: "user", content_text: "human correction" });
	});

	test("queue capacity failures expose no receipt and do not create a row", async () => {
		for (let i = 0; i < 10_000; i++) {
			if (!pushSubagentBufferedMessage("child", "pending").ok) break;
		}
		const result = await send();
		expect(result.targets[0].status).toBe("failed");
		expect(result.targets[0].deliveryMessageId).toBeUndefined();
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(0);
	});

	test("idle child passes its exact envelope into resume and returns the receiving row", async () => {
		sqlite.prepare("UPDATE narrators SET status = 'idle' WHERE id = 'child'").run();
		const result = await send();
		expect(result.targets[0].status).toBe("started");
		expect(row(result.targets[0].deliveryMessageId)?.content_text).toBe(
			"[Message from the parent narrator]\nsame words",
		);
		expect(getSubagentBufferedMessages("child")).toHaveLength(0);
	});

	test("failed idle resume cannot label later human text", async () => {
		sqlite.prepare("UPDATE narrators SET status = 'idle' WHERE id = 'child'").run();
		resumeFails = true;
		const result = await send();
		expect(result.targets[0].status).toBe("failed");
		const human = await narratorService.persistSubagentUserMessage(
			"child",
			"[Message from the parent narrator]\nsame words",
			"origin",
		);
		expect(human.origin).toBe("user");
	});

	test("child-to-parent keeps sys injection semantics and reuses its reserved receiving ID", async () => {
		const result = await send("child", "parent");
		const id = result.targets[0].deliveryMessageId;
		expect(row(id)).toBeNull();
		const [{ message }] = runItems(drainPendingInjections("parent"), "subagent_message");
		expect(message.delivery?.recipientMessageId).toBe(id);
		const injected = await deliverInjection("parent", {
			content: message.text,
			body: agentMessageDeliveryBody(message.delivery as NonNullable<typeof message.delivery>),
			messageId: message.delivery?.recipientMessageId,
			source: "subagent_message",
			schedule: "onNextTurn",
		});
		expect(injected.messageId).toBe(id ?? null);
		expect(row(id)?.role).toBe("sys");
		expect(broadcasts.filter(({ event }) => event.type === "message")).toHaveLength(1);
	});

	test("awaiting Send exposes the exact reserved ID live and keeps it in completed metadata", async () => {
		let live: unknown[] = [];
		const result = await send("parent", "child", {
			shouldAwait: true,
			onDeliveryResolved: () => {
				live = getActiveSendDeliveryTargets("parent", "send-call");
				resolvePendingAgentReply({
					fromNarratorId: "child",
					toNarratorId: "parent",
					scope: { type: "parent-child", id: "parent\u0000child" },
					message: "reply",
				});
			},
		});
		expect(result.targets[0].status).toBe("completed");
		expect(live).toEqual([{ id: "child", deliveryMessageId: result.targets[0].deliveryMessageId }]);
		expect(getSubagentBufferedMessages("child")[0].delivery?.text).toBe("same words");
		expect(getSubagentBufferedMessages("child")[0].text).toContain("[Reply requested");
	});

	test("explicit replies point to the existing waiting Send row without another inbox message", async () => {
		sqlite
			.prepare(
				"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('wait-message', 'parent', 'assistant', '[]', ?)",
			)
			.run(now);
		sqlite
			.prepare(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, created_at) VALUES ('wait-tool', 'parent', 'wait-message', 'waiting-send', 'Send', ?)",
			)
			.run(now);
		const run = beginAgentReplyWaitRun({ requesterId: "parent", toolUseId: "waiting-send" });
		const wait = registerAgentReplyWait({
			requesterMessageId: "wait-message",
			requesterId: "parent",
			responderId: "child",
			scope: { type: "parent-child", id: "parent\u0000child" },
			run,
		});
		const result = await send("child", "parent", { replyTo: wait.requestId });
		expect(result.targets[0].deliveryMessageId).toBe("wait-message");
		expect(await wait.promise).toMatchObject({ status: "replied", message: "same words" });
		expect(drainPendingInjections("parent")).toHaveLength(0);
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(1);
		run.complete();
	});

	test("commit followed by parent-version failure still consumes exactly once", async () => {
		const result = await send();
		const versionLookup = spyOn(db.query.narratorToolCalls, "findFirst").mockRejectedValueOnce(
			new Error("parent version unavailable"),
		);
		try {
			const consumed = await consumeBufferedSubagentMessageInPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
			});
			expect(consumed?.text).toContain("same words");
			expect(row(result.targets[0].deliveryMessageId)).not.toBeNull();
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
			expect(await consume()).toBeNull();
			expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(1);
			expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(2);
		} finally {
			versionLookup.mockRestore();
		}
	});

	test.each([
		"none",
		"parent lookup",
		"parent update",
		"creator lookup",
		"creator rejection",
	])("edited Send commits once despite post-commit failure: %s", async (failure) => {
		sqlite
			.prepare(
				"INSERT INTO users (id, username, password_hash, created_at) VALUES ('editor', 'Editor', 'unused', ?)",
			)
			.run(now);
		sqlite
			.prepare(
				"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('parent-message', 'parent', 'assistant', '[]', ?)",
			)
			.run(now);
		sqlite
			.prepare(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, created_at) VALUES ('origin-call', 'parent', 'parent-message', 'origin', 'Agent', ?)",
			)
			.run(now);
		const result = await send("parent", "child", { userId: "editor" });
		const queued = getSubagentBufferedMessages("child")[0];
		expect(updateSubagentBufferedMessage("child", queued.id, "human correction")).toBe(true);
		expect(queued.delivery).toBeUndefined();
		const childRows = () =>
			sqlite
				.prepare(
					"SELECT id, origin, content_text, created_by FROM narrator_messages WHERE narrator_id = 'child'",
				)
				.all();
		const consumeInPass = () =>
			consumeBufferedSubagentMessageInPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
				currentUserId: "editor",
			});
		const restores: Array<() => void> = [];
		let rowsAtCreatorFailure = 0;
		if (failure === "parent lookup") {
			const lookup = spyOn(db.query.narratorToolCalls, "findFirst").mockRejectedValueOnce(
				new Error("parent lookup unavailable"),
			);
			restores.push(() => lookup.mockRestore());
		} else if (failure === "parent update") {
			// The child's message/ref transaction commits before this separate update fails.
			sqlite.run(`CREATE TEMP TRIGGER fail_parent_version BEFORE UPDATE OF message_version
					ON narrators WHEN OLD.id = 'parent'
					BEGIN SELECT RAISE(ABORT, 'parent version unavailable'); END`);
			restores.push(() => sqlite.run("DROP TRIGGER fail_parent_version"));
		} else if (failure === "creator lookup") {
			const lookup = spyOn(db.query.users, "findFirst").mockImplementationOnce(() => {
				rowsAtCreatorFailure = childRows().length;
				throw new Error("creator unavailable");
			});
			restores.push(() => lookup.mockRestore());
		} else if (failure === "creator rejection") {
			const lookup = spyOn(db.query.users, "findFirst").mockRejectedValueOnce(
				new Error("creator unavailable"),
			);
			restores.push(() => lookup.mockRestore());
		}
		try {
			expect((await consumeInPass())?.text).toBe("human correction");
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
			expect(await consumeInPass()).toBeNull();
			expect(await consume()).toBeNull();
			expect(row(result.targets[0].deliveryMessageId)).toBeNull();
			expect(childRows()).toEqual([
				{
					id: expect.any(String),
					origin: "user",
					content_text: "human correction",
					created_by: "editor",
				},
			]);
			expect(sqlite.prepare("SELECT id FROM narrator_message_refs").all()).toHaveLength(1);
			expect(
				sqlite.prepare("SELECT message_version FROM narrators WHERE id = 'child'").get(),
			).toEqual({ message_version: 1 });
			expect(
				sqlite.prepare("SELECT message_version FROM narrators WHERE id = 'parent'").get(),
			).toEqual({ message_version: failure.startsWith("parent") ? 0 : 1 });
			const received = broadcasts.filter(({ event }) => event.type === "user_message");
			expect(received).toHaveLength(2);
			for (const { event } of received) {
				expect(event.message).toMatchObject({
					creator: failure.startsWith("creator") ? null : { id: "editor", username: "Editor" },
				});
			}
			if (failure === "creator lookup") expect(rowsAtCreatorFailure).toBe(1);
		} finally {
			for (const restore of restores) restore();
		}
	});

	test("edited Send rolls back message/ref/version and requeues on a real transaction failure", async () => {
		const result = await send();
		const queued = getSubagentBufferedMessages("child")[0];
		updateSubagentBufferedMessage("child", queued.id, "retry human correction");
		const consumeInPass = () =>
			consumeBufferedSubagentMessageInPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
			});
		sqlite.run(`CREATE TEMP TRIGGER fail_message_ref BEFORE INSERT ON narrator_message_refs
			BEGIN SELECT RAISE(ABORT, 'ref insertion unavailable'); END`);
		try {
			expect(await consumeInPass()).toBeNull();
			expect(getSubagentBufferedMessages("child")).toEqual([queued]);
			expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(0);
			expect(sqlite.prepare("SELECT id FROM narrator_message_refs").all()).toHaveLength(0);
			expect(
				sqlite.prepare("SELECT message_version FROM narrators WHERE id = 'child'").get(),
			).toEqual({ message_version: 0 });
			expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(0);
		} finally {
			sqlite.run("DROP TRIGGER fail_message_ref");
		}
		expect((await consumeInPass())?.text).toBe("retry human correction");
		expect(await consumeInPass()).toBeNull();
		expect(getSubagentBufferedMessages("child")).toHaveLength(0);
		expect(row(result.targets[0].deliveryMessageId)).toBeNull();
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(1);
		expect(sqlite.prepare("SELECT id FROM narrator_message_refs").all()).toHaveLength(1);
		expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(2);
	});

	test("actual running-pass callback withholds failed bytes, requeues, then delivers once", async () => {
		const narratorExecutor = await import("../narrator-executor");
		const { settings } = await import("../../lib/settings");
		const previous = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "delivery-provider",
				name: "Delivery test",
				prefix: "delivery-test",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
				officialApi: false,
			},
		];
		sqlite
			.prepare("UPDATE narrators SET auto_continuation_override = 'off' WHERE id = 'child'")
			.run();
		let firstText: string | null | undefined;
		let secondText: string | null | undefined;
		let thirdText: string | null | undefined;
		let reserved: string | undefined;
		let persistedAtFirstBoundary = false;
		let queuedAfterFailure = 0;
		const executor = spyOn(narratorExecutor, "executeAgentLoop").mockImplementation(
			async (input) => {
				const sent = await send();
				reserved = sent.targets[0].deliveryMessageId;
				const failure = spyOn(narratorService, "persistSubagentUserMessage").mockRejectedValueOnce(
					new Error("in-pass persistence rejected"),
				);
				try {
					firstText = await input.config.getAfterToolsInjections?.();
				} finally {
					failure.mockRestore();
				}
				persistedAtFirstBoundary = row(reserved) !== null;
				queuedAfterFailure = getSubagentBufferedMessages("child").length;
				secondText = await input.config.getAfterToolsInjections?.();
				thirdText = await input.config.getAfterToolsInjections?.();
				return { finalText: "done", hasError: false, shouldUpdateTitle: false };
			},
		);
		try {
			await executeSubagent({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				subagentType: "general",
				prompt: "initial turn",
				initialHistory: [],
				initialTrailingToolResults: [],
				cwd: process.env.HOME ?? ".",
				model: "delivery-test:claude-sonnet-4",
				provider: "delivery-test",
				locale: "en",
				signal: new AbortController().signal,
				systemPrompt: "Test subagent",
			});
			expect(firstText ?? "").not.toContain("same words");
			expect(persistedAtFirstBoundary).toBe(false);
			expect(queuedAfterFailure).toBe(1);
			expect(secondText).toBe("[Message from the parent narrator]\nsame words");
			expect(thirdText ?? "").not.toContain("same words");
			expect(row(reserved)?.role).toBe("user");
			expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(2);
		} finally {
			executor.mockRestore();
			settings.anthropicProviders = previous;
		}
	});

	test("reused provider tool ID binds a reply to the precise waiting tool row and attempt", async () => {
		for (const [suffix, attempt] of [
			["old", 1],
			["new", 2],
		] as const) {
			sqlite
				.prepare(
					"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, 'parent', 'assistant', '[]', ?)",
				)
				.run(`wait-${suffix}`, now);
			sqlite
				.prepare(
					"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, execution_attempt, created_at) VALUES (?, 'parent', ?, 'reused-send', 'Send', ?, ?)",
				)
				.run(`tool-${suffix}`, `wait-${suffix}`, attempt, now);
		}
		const binding = { toolCallId: "tool-new", attempt: 2 };
		let response: ReturnType<typeof send> | undefined;
		let active: unknown[] = [];
		let stale: unknown[] = [];
		const result = await send("parent", "child", {
			toolUseId: "reused-send",
			shouldAwait: true,
			toolCallBinding: binding,
			onDeliveryResolved: () => {
				active = getActiveSendDeliveryTargets("parent", "reused-send", binding);
				stale = getActiveSendDeliveryTargets("parent", "reused-send", {
					toolCallId: "tool-old",
					attempt: 1,
				});
				response = send("child", "parent");
			},
		});
		const reply = await response;
		expect(result.targets[0].status).toBe("completed");
		expect(reply?.targets[0].deliveryMessageId).toBe("wait-new");
		expect(active).toEqual([
			{ id: "child", deliveryMessageId: result.targets[0].deliveryMessageId },
		]);
		expect(stale).toEqual([]);
		expect(drainPendingInjections("parent")).toHaveLength(0);
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(2);
	});

	test("TeamStatus broadcast reserves separate IDs and keeps independent inbox scheduling", () => {
		const message = {
			fromId: "parent",
			fromTitle: null,
			fromType: "primary",
			fromLabel: "parent",
			fromToolUseId: "team-send",
			text: "same",
			timestamp: now,
			isBroadcast: true,
		};
		const first = deliverTeamMessage("child", message, "parent");
		const second = deliverTeamMessage("sibling", message, "parent");
		expect(first).toBeString();
		expect(first).not.toBe(second);
		expect(drainTeamInbox("child")[0].delivery?.recipientMessageId).toBe(first);
		expect(drainTeamInbox("sibling")[0].delivery?.recipientMessageId).toBe(second);
		expect(row(first)).toBeNull();
		expect(getSubagentBufferedMessages("child")).toHaveLength(0);
	});
});
