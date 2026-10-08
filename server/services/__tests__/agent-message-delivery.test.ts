import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	agentMessageDeliveryBody,
	consumeAgentMessageHistory,
	markAgentMessageConsumed,
	trackAgentMessageHistory,
} from "../agent-message-delivery";
import {
	beginAgentReplyWaitRun,
	clearPendingAgentReplyWaits,
	getActiveSendDeliveryTargets,
	registerAgentReplyWait,
	resolvePendingAgentReply,
} from "../agent-reply-waiter";
import {
	drainPendingInjections,
	projectPendingInjection,
	runItems,
} from "../parent-injection-queue";

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
const { clearTeamInbox, deliverTeamMessage, drainTeamInbox, projectTeamMessage } = await import(
	"../subagent-team"
);
const { listInboxRows, inboxDelivery, inboxAgentText, runtimeInbox, claimInboxHead } = await import(
	"../agent-runtime/inbox"
);
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
afterEach(() => {
	for (const id of ["parent", "child", "sibling"]) getExecutionOwner(id)?.release();
});
async function agentQueued(id = "child") {
	return (await listInboxRows(id, ["agent_message"])).map((row) => ({
		id: row.id,
		delivery: inboxDelivery(row),
		text: inboxAgentText(row),
	}));
}
async function inPass(input: Parameters<typeof consumeBufferedSubagentMessageInPass>[0]) {
	const owner = tryClaimExecution(input.narratorId, "primary");
	try {
		return await consumeBufferedSubagentMessageInPass(input);
	} finally {
		owner?.release();
	}
}
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
let sourceSerial = 0;
function sourceBinding(
	narratorId: string,
	toolUseId: string,
	binding = { toolCallId: `source-${++sourceSerial}`, attempt: 1 },
) {
	const messageId = `source-message-${binding.toolCallId}`;
	sqlite
		.prepare(
			"INSERT OR IGNORE INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES (?,?,'assistant','[]',?)",
		)
		.run(messageId, narratorId, now);
	sqlite
		.prepare(
			"INSERT OR IGNORE INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,execution_attempt,execution_identity_version,created_at) VALUES (?,?,?,?,'Send',?,1,?)",
		)
		.run(binding.toolCallId, narratorId, messageId, toolUseId, binding.attempt, now);
	return binding;
}
function send(
	callerNarratorId = "parent",
	id = "child",
	extra: Partial<Parameters<typeof sendSubagentMessageDetailed>[0]> = {},
) {
	const binding = sourceBinding(
		callerNarratorId,
		extra.toolUseId ?? "send-call",
		extra.toolCallBinding,
	);
	return sendSubagentMessageDetailed({
		callerNarratorId,
		id,
		message: "same words",
		toolUseId: "send-call",
		signal: new AbortController().signal,
		locale: "en",
		...extra,
		toolCallBinding: binding,
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
function consumedAt(messageId: string | undefined, narratorId = "child") {
	return (
		(
			sqlite
				.prepare(
					"SELECT injection_consumed_at AS value FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ?",
				)
				.get(narratorId, messageId ?? "") as { value: number | null } | null
		)?.value ?? null
	);
}

async function consume() {
	return consumeNextBufferedSubagentMessage({
		narratorId: "child",
		parentNarratorId: "parent",
		toolUseId: "origin",
		model: "test-model",
		provider: "anthropic",
		cwd: ".",
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
	test("persisted and rebuilt input stays unconsumed until the recipient adopts that exact history", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId;
		const prepared = await consume();
		expect(row(id)).not.toBeNull();
		expect(consumedAt(id)).toBeNull();
		// An idle resume can fail after preparing this history; preparation is not receipt.
		expect(prepared?.history).toBeArray();
		expect(consumedAt(id)).toBeNull();
		consumeAgentMessageHistory(prepared?.history ?? [], prepared?.prompt ?? "");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id)).toBeNumber();
	});

	test("sender execution binding survives persistence and history replay into the receipt", async () => {
		const binding = { toolCallId: "send-attempt-id", attempt: 3 };
		const sent = await send("parent", "child", { toolCallBinding: binding });
		const id = sent.targets[0].deliveryMessageId as string;
		expect((await agentQueued())[0].delivery?.senderToolCallBinding).toEqual(binding);
		const prepared = await consume();
		const saved = row(id);
		expect(JSON.parse(saved?.content_json ?? "[]")[1].body.items[0].fromToolCallBinding).toEqual(
			binding,
		);
		consumeAgentMessageHistory(prepared?.history ?? [], prepared?.prompt ?? "");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const receipts = broadcasts.filter(
			({ event }) =>
				event.type === "send_delivery_resolved" &&
				(event.targets as Array<{ injectionConsumedAt?: string }>)?.some(
					(target) => target.injectionConsumedAt,
				),
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].event.toolCallBinding).toEqual(binding);
		expect(
			(receipts[0].event.targets as Array<{ injectionConsumedAt: string }>)[0].injectionConsumedAt,
		).toBe(new Date(consumedAt(id) as number).toISOString());
	});

	test("consumption is idempotent, exact-recipient scoped, and survives a fresh history build", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		};
		const first = new Date("2026-09-08T12:00:01.123Z");
		await markAgentMessageConsumed(delivery, first);
		await markAgentMessageConsumed(delivery, new Date("2026-09-08T13:00:00.000Z"));
		expect(consumedAt(id)).toBe(first.getTime());
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('fork-ref','sibling',?,1)",
			)
			.run(id);
		const saved = row(id);
		const reloaded = [
			{
				id,
				narratorId: "child",
				role: "user",
				contentJson: JSON.parse(saved?.content_json ?? "[]"),
			},
		];
		const freshHistory: unknown[] = [];
		trackAgentMessageHistory("child", freshHistory, reloaded);
		consumeAgentMessageHistory(freshHistory, saved?.content_text ?? "");
		consumeAgentMessageHistory(freshHistory, saved?.content_text ?? "");
		const forkHistory: unknown[] = [];
		trackAgentMessageHistory("sibling", forkHistory, reloaded);
		consumeAgentMessageHistory(forkHistory, saved?.content_text ?? "");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id)).toBe(first.getTime());
		expect(consumedAt(id, "sibling")).toBeNull();
	});

	test("cold receipt lookup preserves the persisted consumption time without another version bump", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const timestamp = new Date("2026-09-08T01:00:00Z").getTime();
		sqlite
			.prepare("UPDATE narrator_message_refs SET injection_consumed_at = ? WHERE message_id = ?")
			.run(timestamp, id);
		const before = sqlite.prepare("SELECT id,message_version FROM narrators ORDER BY id").all();
		await markAgentMessageConsumed({
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		});
		expect(consumedAt(id)).toBe(timestamp);
		expect(sqlite.prepare("SELECT id,message_version FROM narrators ORDER BY id").all()).toEqual(
			before,
		);
	});

	test("pending receipt work is capped and overflow does not permanently cache a missing row", async () => {
		const reads = spyOn(db, "select");
		try {
			await Promise.all(
				Array.from({ length: 4100 }, (_, index) =>
					markAgentMessageConsumed({
						recipientNarratorId: "child",
						recipientMessageId: `overflow-${index}`,
						senderNarratorId: "parent",
						fromToolUseId: "send-call",
					}),
				),
			);
			expect(reads.mock.calls.length).toBeLessThanOrEqual(4096);
			expect(reads.mock.calls.length).toBeGreaterThan(0);
		} finally {
			reads.mockRestore();
		}
		sqlite
			.prepare(
				"INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES ('overflow-4099','child','sys','[]',?)",
			)
			.run(now);
		sqlite
			.prepare(
				"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('overflow-ref','child','overflow-4099',1)",
			)
			.run();
		await markAgentMessageConsumed({
			recipientNarratorId: "child",
			recipientMessageId: "overflow-4099",
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		});
		expect(consumedAt("overflow-4099")).toBeNumber();
	});

	test("concurrent receipts share one write and successful replay avoids SQLite entirely", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		};
		const first = markAgentMessageConsumed(delivery);
		const concurrent = markAgentMessageConsumed({ ...delivery });
		expect(concurrent).toBe(first);
		await first;
		const reads = spyOn(db, "select");
		const transactions = spyOn(db, "transaction");
		try {
			await markAgentMessageConsumed(delivery);
			expect(reads).not.toHaveBeenCalled();
			expect(transactions).not.toHaveBeenCalled();
		} finally {
			reads.mockRestore();
			transactions.mockRestore();
		}
	});

	test("a missing recipient ref is not cached as successfully consumed", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		};
		await markAgentMessageConsumed(delivery);
		expect(row(id)).toBeNull();
		await consume();
		await markAgentMessageConsumed(delivery);
		expect(consumedAt(id)).toBeNumber();
	});

	test("a large consumption batch yields to the event loop before finishing its writes", async () => {
		const ids = Array.from({ length: 40 }, (_, index) => `batch-receipt-${index}`);
		for (const [index, id] of ids.entries()) {
			sqlite
				.prepare(
					"INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES (?,'child','sys','[]',?)",
				)
				.run(id, now);
			sqlite
				.prepare(
					"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES (?,'child',?,?)",
				)
				.run(`ref-${id}`, id, index + 1);
		}
		const writes = ids.map((id) =>
			markAgentMessageConsumed({
				recipientNarratorId: "child",
				recipientMessageId: id,
				senderNarratorId: "parent",
				fromToolUseId: "send-call",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ids.filter((id) => consumedAt(id) !== null).length).toBeLessThan(ids.length);
		await Promise.all(writes);
		expect(ids.every((id) => consumedAt(id) !== null)).toBe(true);
	});

	test.each([
		"parent",
		"sibling",
	])("consumption invalidates sender %s and its parent exactly once for reconnect", async (sender) => {
		const sent = await send(sender, "child");
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const versions = () =>
			Object.fromEntries(
				(
					sqlite.prepare("SELECT id,message_version AS version FROM narrators").all() as Array<{
						id: string;
						version: number;
					}>
				).map((row) => [row.id, row.version]),
			);
		const before = versions();
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: sender,
			fromToolUseId: "send-call",
		};
		await markAgentMessageConsumed(delivery);
		const after = versions();
		expect(after.parent).toBe(before.parent + 1);
		expect(after.sibling).toBe(before.sibling + (sender === "sibling" ? 1 : 0));
		expect(after.child).toBe(before.child);
		// Even when the live frame is lost, durable version comparison forces reload.
		broadcasts.length = 0;
		await markAgentMessageConsumed(delivery);
		expect(versions()).toEqual(after);
		expect(consumedAt(id)).toBeNumber();
		expect(broadcasts).toHaveLength(0);
	});

	test("failed sender invalidation rolls back its receipt and can be repaired without redelivery", async () => {
		const sent = await send("sibling", "child");
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const versions = () =>
			sqlite.prepare("SELECT id,message_version FROM narrators ORDER BY id").all();
		const before = versions();
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "sibling",
			fromToolUseId: "send-call",
		};
		sqlite.run(`CREATE TEMP TRIGGER fail_receipt_version BEFORE UPDATE OF message_version ON narrators
			WHEN OLD.id = 'parent' BEGIN SELECT RAISE(ABORT,'version unavailable'); END`);
		try {
			await markAgentMessageConsumed(delivery);
			expect(consumedAt(id)).toBeNull();
			expect(versions()).toEqual(before);
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
		} finally {
			sqlite.run("DROP TRIGGER fail_receipt_version");
		}
		await markAgentMessageConsumed(delivery);
		expect(consumedAt(id)).toBeNumber();
		expect(versions()).not.toEqual(before);
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
	});

	test("failed consumption bookkeeping never throws or requeues already adopted bytes", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		sqlite.run(`CREATE TEMP TRIGGER fail_consumption BEFORE UPDATE OF injection_consumed_at
			ON narrator_message_refs BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`);
		const delivery = {
			recipientNarratorId: "child",
			recipientMessageId: id,
			senderNarratorId: "parent",
			fromToolUseId: "send-call",
		};
		try {
			await expect(markAgentMessageConsumed(delivery)).resolves.toBeUndefined();
			expect(consumedAt(id)).toBeNull();
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
			expect(await consume()).toBeNull();
			expect(
				sqlite
					.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'")
					.all(),
			).toHaveLength(1);
		} finally {
			sqlite.run("DROP TRIGGER fail_consumption");
		}
		// A later bookkeeping repair is independent of delivering the same text again.
		await markAgentMessageConsumed(delivery);
		expect(consumedAt(id)).toBeNumber();
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
	});

	test.each([
		"disp",
		"system",
		"missing current prompt",
		"missing extracted sys prompt",
	])("filtered or extracted-but-unsent rows are not acknowledged: %s", async (scenario) => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const saved = row(id);
		const history: unknown[] = [];
		const role =
			scenario === "missing current prompt"
				? "user"
				: scenario === "missing extracted sys prompt"
					? "sys"
					: scenario;
		trackAgentMessageHistory(
			"child",
			history,
			[{ id, narratorId: "child", role, contentJson: JSON.parse(saved?.content_json ?? "[]") }],
			scenario === "missing extracted sys prompt" ? saved?.content_text : undefined,
		);
		consumeAgentMessageHistory(history, "unrelated continuation prompt");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id)).toBeNull();
	});

	test("ordinary history and an unrelated history identity cannot acknowledge a delivery", async () => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const untracked: unknown[] = [];
		trackAgentMessageHistory("child", untracked, [
			{
				id,
				narratorId: "child",
				role: "user",
				contentJson: [{ type: "text", text: "same words" }],
			},
		]);
		consumeAgentMessageHistory(untracked, "same words");
		consumeAgentMessageHistory([], "same words");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id)).toBeNull();
	});

	test("busy child receipt remains nonexistent until actual drain, then points to the one persisted/broadcast row", async () => {
		const notifications: unknown[] = [];
		const result = await send("parent", "child", {
			onDeliveryResolved: (receipt) => notifications.push(receipt),
		});
		const id = result.targets[0].deliveryMessageId;
		expect(result.targets[0].status).toBe("queued");
		expect(id).toBeString();
		expect(row(id)).toBeNull();
		const envelope = (await agentQueued())[0].delivery;
		expect(notifications).toEqual([
			expect.objectContaining({
				id: "child",
				deliveryMessageId: id,
				title: null,
				deliveryId: envelope.deliveryId,
				revision: 1,
			}),
		]);
		expect(envelope.deliveryId).toBeString();
		expect(envelope?.recipientMessageId).toBe(id as string);
		const consumed = await consume();
		expect(consumed?.prompt).toBe(
			'<sender kind="agent" id="parent" name="parent" />\n[Message from the parent narrator]\nsame words',
		);
		expect(row(id)?.content_text).toBe("[Message from the parent narrator]\nsame words");
		expect(consumed?.prompt.match(/same words/g)).toHaveLength(1);
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
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
	});

	test("same text from separate senders has distinct receipts even when priority reorders delivery", async () => {
		const first = await send();
		const second = await send("sibling", "child", { toolUseId: "sibling-send" });
		const ids = [first.targets[0].deliveryMessageId, second.targets[0].deliveryMessageId];
		expect(ids[0]).not.toBe(ids[1]);
		await reorderSubagentBufferedMessages(
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

	test("clearing user buffers preserves accepted agent delivery and identical human text stays separate", async () => {
		const result = await send();
		const reserved = result.targets[0].deliveryMessageId;
		clearSubagentBufferedMessages("child");
		expect(await agentQueued()).toHaveLength(1);
		await pushSubagentBufferedMessage("child", "[Message from the parent narrator]\nsame words");
		await consume();
		await consume();
		expect(row(reserved)).not.toBeNull();
		const human = sqlite
			.prepare(
				"SELECT origin, content_json FROM narrator_messages WHERE narrator_id = 'child' AND origin = 'user'",
			)
			.get() as { origin: string; content_json: string };
		expect(human.origin).toBe("user");
		expect(JSON.parse(human.content_json)).toHaveLength(1);
	});

	test("human buffer editing cannot rewrite an accepted agent message or its attribution", async () => {
		const result = await send();
		const queued = (await agentQueued())[0];
		expect(await updateSubagentBufferedMessage("child", queued.id, "human correction")).toBe(false);
		await consume();
		expect(row(result.targets[0].deliveryMessageId)?.content_text).toContain("same words");
		const actual = sqlite
			.prepare("SELECT origin, content_text FROM narrator_messages WHERE narrator_id = 'child'")
			.get() as { origin: string; content_text: string };
		expect(actual.origin).toBe("assistant");
		expect(actual.content_text).not.toContain("human correction");
	});

	test("queue capacity failures expose no receipt and do not create a row", async () => {
		for (let i = 0; i < 50; i++) {
			expect((await send()).targets[0].status).toBe("queued");
		}
		// User quota is independent of the full agent-message quota.
		expect((await pushSubagentBufferedMessage("child", "pending")).ok).toBe(true);
		const result = await send();
		expect(result.targets[0].status).toBe("failed");
		expect(result.targets[0].deliveryMessageId).toBeUndefined();
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(0);
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
		expect(result.targets[0].status).toBe("queued");
		expect(await agentQueued()).toHaveLength(1);
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
		expect(tryClaimExecution("parent", "primary")).not.toBeNull();
		const claimed = await claimInboxHead("parent", (row) => row.kind === "agent_message");
		if (!claimed) throw new Error("Expected parent mailbox claim");
		const [{ message }] = runItems([projectPendingInjection(claimed)], "subagent_message");
		expect(message.delivery?.recipientMessageId).toBe(id);
		const injected = await deliverInjection("parent", {
			content: message.text,
			body: agentMessageDeliveryBody(message.delivery as NonNullable<typeof message.delivery>),
			messageId: message.delivery?.recipientMessageId,
			onPersist: (tx, messageId, refId) => {
				if (message.delivery?.mailboxClaim)
					runtimeInbox.materializeInTransaction(tx, message.delivery.mailboxClaim, {
						messageId,
						refId,
					});
			},
			source: "subagent_message",
			schedule: "onNextTurn",
		});
		expect(injected.messageId).toBe(id ?? null);
		expect(row(id)?.role).toBe("sys");
		const nativeBlocks = JSON.parse(row(id)?.content_json ?? "[]");
		expect(nativeBlocks).toHaveLength(1);
		expect(nativeBlocks[0].modelText).toBe("same words");
		expect(injected.turnText).toBe('<sender kind="agent" id="child" name="child" />\nsame words');
		expect(injected.turnText?.match(/same words/g)).toHaveLength(1);
		expect(consumedAt(id, "parent")).toBeNull();
		const source = row(id);
		const history: unknown[] = [];
		trackAgentMessageHistory(
			"parent",
			history,
			[
				{
					id: id as string,
					narratorId: "parent",
					role: "sys",
					contentJson: JSON.parse(source?.content_json ?? "[]"),
				},
			],
			injected.turnText ?? undefined,
		);
		consumeAgentMessageHistory(history, injected.turnText ?? "");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id, "parent")).toBeNumber();
		expect(broadcasts.filter(({ event }) => event.type === "message")).toHaveLength(1);
	});

	test("awaiting Send exposes the exact reserved ID live and keeps it in completed metadata", async () => {
		let live: unknown[] = [];
		const binding = sourceBinding("parent", "send-call");
		const result = await send("parent", "child", {
			toolCallBinding: binding,
			shouldAwait: true,
			onDeliveryResolved: () => {
				live = getActiveSendDeliveryTargets("parent", "send-call", binding);
				resolvePendingAgentReply({
					fromNarratorId: "child",
					toNarratorId: "parent",
					scope: { type: "parent-child", id: "parent\u0000child" },
					message: "reply",
				});
			},
		});
		expect(result.targets[0].status).toBe("completed");
		expect(live).toEqual([
			{
				id: "child",
				deliveryMessageId: result.targets[0].deliveryMessageId,
				title: null,
				deliveryId: result.targets[0].deliveryId,
				revision: 1,
			},
		]);
		expect((await agentQueued())[0].delivery?.text).toBe("same words");
		expect((await agentQueued())[0].text).toContain("[Reply requested");
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
		expect(await drainPendingInjections("parent")).toHaveLength(0);
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
		run.complete();
	});

	test("commit followed by parent-version failure still consumes exactly once", async () => {
		const result = await send();
		const versionLookup = spyOn(db.query.narratorToolCalls, "findFirst").mockRejectedValueOnce(
			new Error("parent version unavailable"),
		);
		try {
			const consumed = await inPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
			});
			expect(consumed?.text).toContain("same words");
			expect(row(result.targets[0].deliveryMessageId)).not.toBeNull();
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
			expect(await consume()).toBeNull();
			expect(
				sqlite
					.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'")
					.all(),
			).toHaveLength(1);
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
	])("edited human input after cancelled Send commits once despite post-commit failure: %s", async (failure) => {
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
		runtimeInbox.cancel(
			(await agentQueued())[0].delivery.deliveryId as string,
			"explicit test cancellation",
		);
		await pushSubagentBufferedMessage("child", "draft", { createdBy: "editor" });
		const queued = getSubagentBufferedMessages("child")[0];
		expect(await updateSubagentBufferedMessage("child", queued.id, "human correction")).toBe(true);
		expect(queued.delivery).toBeUndefined();
		const childRows = () =>
			sqlite
				.prepare(
					"SELECT id, origin, content_text, created_by FROM narrator_messages WHERE narrator_id = 'child'",
				)
				.all();
		const restart = consume;
		// Explicit turn/pass input must wait for restart, never inject into this pass.
		expect(
			await inPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
				currentUserId: "editor",
			}),
		).toBeNull();
		expect(getSubagentBufferedMessages("child")).toHaveLength(1);
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
			const consumed = await restart();
			expect(consumed?.currentInput).toBe("human correction");
			expect(consumed?.prompt).toBe(
				'<sender kind="human" id="editor" name="Editor" />\nhuman correction',
			);
			expect(getSubagentBufferedMessages("child")).toHaveLength(0);
			expect(await restart()).toBeNull();
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

	test("edited human input rolls back message/ref/version and requeues on a real transaction failure", async () => {
		const result = await send();
		runtimeInbox.cancel(
			(await agentQueued())[0].delivery.deliveryId as string,
			"explicit test cancellation",
		);
		await pushSubagentBufferedMessage("child", "draft");
		const queued = getSubagentBufferedMessages("child")[0];
		expect(await updateSubagentBufferedMessage("child", queued.id, "retry human correction")).toBe(
			true,
		);
		const edited = getSubagentBufferedMessages("child")[0];
		const restart = consume;
		expect(
			await inPass({
				narratorId: "child",
				parentNarratorId: "parent",
				toolUseId: "origin",
				cwd: ".",
			}),
		).toBeNull();
		sqlite.run(`CREATE TEMP TRIGGER fail_message_ref BEFORE INSERT ON narrator_message_refs
			BEGIN SELECT RAISE(ABORT, 'ref insertion unavailable'); END`);
		try {
			await expect(restart()).rejects.toThrow("ref insertion unavailable");
			expect(getSubagentBufferedMessages("child")).toEqual([
				{ ...edited, error: expect.stringContaining("ref insertion unavailable") },
			]);
			expect(
				sqlite
					.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'")
					.all(),
			).toHaveLength(0);
			expect(sqlite.prepare("SELECT id FROM narrator_message_refs").all()).toHaveLength(0);
			expect(
				sqlite.prepare("SELECT message_version FROM narrators WHERE id = 'child'").get(),
			).toEqual({ message_version: 0 });
			expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(0);
		} finally {
			sqlite.run("DROP TRIGGER fail_message_ref");
		}
		const consumed = await restart();
		expect(consumed?.currentInput).toBe("retry human correction");
		expect(consumed?.prompt).toBe('<sender kind="human" />\nretry human correction');
		expect(await restart()).toBeNull();
		expect(getSubagentBufferedMessages("child")).toHaveLength(0);
		expect(row(result.targets[0].deliveryMessageId)).toBeNull();
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
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
		let firstText: string | undefined;
		let secondText: string | undefined;
		let thirdText: string | undefined;
		const injectionText = (
			injection:
				| Awaited<
						ReturnType<
							NonNullable<import("../../lib/agent/types").AgentConfig["getAfterToolsInjections"]>
						>
				  >
				| undefined,
		) => (typeof injection === "string" ? injection : injection?.text);
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
					firstText = injectionText(await input.config.getAfterToolsInjections?.());
				} finally {
					failure.mockRestore();
				}
				persistedAtFirstBoundary = row(reserved) !== null;
				queuedAfterFailure = (await agentQueued()).length;
				const prepared = await input.config.getAfterToolsInjections?.();
				secondText = injectionText(prepared);
				expect(consumedAt(reserved)).toBeNull();
				if (typeof prepared !== "string") prepared?.onConsumed?.();
				await Promise.resolve();
				thirdText = injectionText(await input.config.getAfterToolsInjections?.());
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
			expect(secondText).toBe(
				'<sender kind="agent" id="parent" name="parent" />\n[Message from the parent narrator]\nsame words',
			);
			expect(thirdText ?? "").not.toContain("same words");
			expect(row(reserved)?.role).toBe("user");
			expect(consumedAt(reserved)).toBeNumber();
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
					"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, execution_attempt, execution_identity_version, created_at) VALUES (?, 'parent', ?, 'reused-send', 'Send', ?, 1, ?)",
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
			{
				id: "child",
				deliveryMessageId: result.targets[0].deliveryMessageId,
				title: null,
				deliveryId: result.targets[0].deliveryId,
				revision: 1,
			},
		]);
		expect(stale).toEqual([]);
		expect(await drainPendingInjections("parent")).toHaveLength(0);
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(2);
	});

	test("broadcast rechecks persisted status before admission without requiring a runtime owner", async () => {
		const message = {
			fromId: "parent",
			fromTitle: null,
			fromType: "primary",
			fromToolUseId: "status-broadcast",
			fromToolCallBinding: sourceBinding("parent", "status-broadcast"),
			text: "new scope",
			timestamp: now,
			isBroadcast: true,
		};
		for (const status of ["idle", "archived"]) {
			sqlite.prepare("UPDATE narrators SET status = ? WHERE id = 'child'").run(status);
			expect(await deliverTeamMessage("child", message, "parent")).toBeUndefined();
			expect(await agentQueued()).toHaveLength(0);
		}
		expect(broadcasts).toHaveLength(0);
		sqlite.prepare("UPDATE narrators SET status = 'working' WHERE id = 'child'").run();
		sqlite.prepare("UPDATE narrators SET status = 'waiting' WHERE id = 'sibling'").run();
		expect(getExecutionOwner("child")).toBeUndefined();
		expect(getExecutionOwner("sibling")).toBeUndefined();
		expect(await deliverTeamMessage("child", message, "parent")).toBeString();
		expect(await deliverTeamMessage("sibling", message, "parent")).toBeString();
		expect(await agentQueued("child")).toHaveLength(1);
		expect(await agentQueued("sibling")).toHaveLength(1);
		// Broadcast does not schedule the historical runner even with a working/waiting row.
		expect(getExecutionOwner("child")).toBeUndefined();
		expect(getExecutionOwner("sibling")).toBeUndefined();
	});
	test("TeamStatus broadcast reserves separate IDs and keeps independent inbox scheduling", async () => {
		const message = {
			fromId: "parent",
			fromTitle: null,
			fromType: "primary",
			fromLabel: "parent",
			fromToolUseId: "team-send",
			fromToolCallBinding: { toolCallId: "team-call", attempt: 2 },
			text: "same",
			timestamp: now,
			isBroadcast: true,
		};
		sourceBinding("parent", "team-send", message.fromToolCallBinding);
		const first = await deliverTeamMessage("child", message, "parent");
		const second = await deliverTeamMessage("sibling", message, "parent");
		expect(first).toBeString();
		expect(first).not.toBe(second);
		expect(tryClaimExecution("child", "subagent")).not.toBeNull();
		const claimed = await claimInboxHead("child", (row) => row.kind === "agent_message");
		if (!claimed) throw new Error("Expected team mailbox claim");
		const childMessage = projectTeamMessage(claimed);
		expect(childMessage.delivery?.recipientMessageId).toBe(first);
		expect(childMessage.delivery?.senderToolCallBinding).toEqual(message.fromToolCallBinding);
		expect((await drainTeamInbox("sibling"))[0].delivery?.recipientMessageId).toBe(second);
		expect(row(first)).toBeNull();
		expect(getSubagentBufferedMessages("child")).toHaveLength(0);
		const injection = await deliverInjection("child", {
			messageId: first,
			onPersist: (tx, messageId, refId) => {
				if (childMessage.delivery?.mailboxClaim)
					runtimeInbox.materializeInTransaction(tx, childMessage.delivery.mailboxClaim, {
						messageId,
						refId,
					});
			},
			content: "same",
			body: agentMessageDeliveryBody(
				childMessage.delivery as NonNullable<typeof childMessage.delivery>,
			),
			source: "team_message",
			schedule: "onNextTurn",
		});
		expect(consumedAt(first)).toBeNull();
		const teamBlocks = JSON.parse(row(first)?.content_json ?? "[]");
		expect(teamBlocks).toHaveLength(1);
		expect(teamBlocks[0].modelText).toBe("same");
		expect(injection.turnText).toBe('<sender kind="agent" id="parent" name="parent" />\nsame');
		const history: unknown[] = [];
		trackAgentMessageHistory(
			"child",
			history,
			[
				{
					id: first as string,
					narratorId: "child",
					role: "sys",
					contentJson: JSON.parse(row(first)?.content_json ?? "[]"),
				},
			],
			injection.turnText ?? undefined,
		);
		consumeAgentMessageHistory(history, injection.turnText ?? "");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(first)).toBeNumber();
		expect(row(second)).toBeNull();
		expect(consumedAt(second, "sibling")).toBeNull();
	});
});
