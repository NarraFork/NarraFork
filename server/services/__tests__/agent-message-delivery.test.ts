import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	agentMessageDeliveryBody,
	consumeAgentMessageHistory,
	isLastModelInputMailbox,
	markAgentMessageConsumed,
	trackAgentMessageHistory,
} from "../agent-message-delivery";
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
	buildHistory: async () => ({ history: [] }),
}));
const { narratorService } = await import("../narrator-service");
const { deliverInjection } = await import("../narrator-injection");
// The model boundary of an idle wake: a Send to an idle session starts its ordinary run.
// Record the start; the message itself is already materialized in the session's history.
const runModule = { ...(await import("../agent-runtime/run")) };
const runStarts: Array<{ narratorId: string; text: string }> = [];
mock.module("../agent-runtime/run", () => ({
	...runModule,
	startNarratorRun: async (request: { narratorId: string; text: string }) => {
		runStarts.push({ narratorId: request.narratorId, text: request.text });
		const idle = Promise.resolve({
			started: true,
			output: "",
			finalText: "",
			hasError: false,
			interrupted: false,
			timedOut: false,
		});
		return { started: true, foreground: idle, terminal: idle, completion: idle };
	},
}));
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const { drainInjectionsIntoHistory } = await import("../narrator-session");
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const {
	clearBufferedMessages,
	enqueueBufferedMessage,
	getBufferedMessages,
	reorderBufferedMessages,
	updateBufferedMessage,
} = await import("../narrator-buffer");
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
/** The running session `narratorId` whose run delivers to the parent's "origin" call. */
function runningSession(narratorId = "child", currentUserId?: string | null) {
	return {
		narratorId,
		cwd: ".",
		locale: "en",
		_currentUserId: currentUserId,
		_tasksReminderInterval: -1,
		_fenceInterval: -1,
	} as Parameters<typeof drainInjectionsIntoHistory>[0];
}
/** One tool-boundary drain of a running pass, as its execution owner. */
async function inPass(input: { narratorId: string; currentUserId?: string | null }) {
	const owner = tryClaimExecution(input.narratorId, "run");
	try {
		const drained = await drainInjectionsIntoHistory(
			runningSession(input.narratorId, input.currentUserId),
			"en",
			{ parentNarratorId: "parent", parentToolUseId: "origin" },
		);
		return drained.parts.length ? drained : null;
	} finally {
		owner?.release();
	}
}
const now = "2026-09-08T12:00:00.000Z";
function seed(id: string, parent: string | null, status = "working") {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, type, variant, parent_narrator_id, status, is_background, runtime_registration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			parent ? "subagent" : "primary",
			parent ? "subagent:general" : "primary",
			parent,
			status,
			parent ? 1 : 0,
			// A delegated run delivers to its creating Agent call (registered at run start).
			parent
				? JSON.stringify({
						version: 1,
						run: {
							logicalRunId: `${id}-run`,
							deliverTo: { narratorId: parent, toolUseId: "origin" },
						},
					})
				: null,
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

/**
 * The next pass of the child's run: adopt what is queued at its boundary, then build the
 * model history the pass sends. Null when nothing was queued.
 */
async function consume() {
	const owner = tryClaimExecution("child", "run");
	try {
		const drained = await drainInjectionsIntoHistory(runningSession(), "en", {
			parentNarratorId: "parent",
			parentToolUseId: "origin",
		});
		if (!drained.parts.length) return null;
		const built = await buildRuntimeHistory({
			narratorId: "child",
			model: "test-model",
			provider: "anthropic",
		});
		return { prompt: built.currentText, history: built.history };
	} finally {
		owner?.release();
	}
}

/**
 * A fresh run of the idle child for its queued human input (the session wake every
 * session uses): the input is persisted once, then the run starts with it as its current
 * input. Returns what the run's current input is and the text the model receives for it
 * (carried by the persisted row in history), or null when nothing was delivered.
 */
async function restart() {
	sqlite
		.prepare("UPDATE narrators SET status = 'idle', cwd = ? WHERE id = 'child'")
		.run(process.env.HOME ?? ".");
	const before = runStarts.length;
	const { resumeBufferedMessagesIfIdle } = await import("../narrator-session");
	const { activeNarrators } = await import("../narrator-session-state");
	try {
		await resumeBufferedMessagesIfIdle("child", "en");
		const started = runStarts.slice(before);
		if (!started.length) return null;
		const built = await buildRuntimeHistory({
			narratorId: "child",
			model: "test-model",
			provider: "anthropic",
			currentInput: started[0].text,
		});
		expect(built.currentInputPersisted).toBe(true);
		return { currentInput: started[0].text, prompt: built.currentInputText };
	} finally {
		activeNarrators.delete("child");
	}
}

beforeEach(() => {
	cleanDb(sqlite);
	clearBufferedMessages("child");
	drainPendingInjections("parent");
	clearTeamInbox("child");
	clearTeamInbox("sibling");
	broadcasts.length = 0;
	runStarts.length = 0;
	seed("parent", null);
	seed("child", "parent");
	seed("sibling", "parent");
});
afterAll(() => {
	clearBufferedMessages("child");
	drainPendingInjections("parent");
	mock.module("../agent-runtime/run", () => runModule);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.module("../../db", () => realDb);
	mock.module("../../lib/agent", () => realAgent);
});

describe("last model input mailbox provenance", () => {
	const mailbox = {
		id: "mailbox-source",
		narratorId: "child",
		role: "user",
		contentJson: [
			{
				type: "system_injection",
				source: "agent_message",
				modelText: "mailbox input",
				body: { kind: "messages", items: [] },
			},
		],
	};
	const ordinary = {
		id: "human-source",
		narratorId: "child",
		role: "user",
		contentJson: [{ type: "text", text: "mailbox input" }],
	};

	test("recognizes only the tracked history identity and exact popped user input", async () => {
		const history: unknown[] = [];
		await trackAgentMessageHistory("child", history, [mailbox]);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(true);
		expect(isLastModelInputMailbox([...history], "mailbox input")).toBe(false);
		expect(isLastModelInputMailbox(history, "new input")).toBe(false);
		expect(isLastModelInputMailbox(history, "mailbox input\n\nlater user input")).toBe(false);
	});

	test.each([
		["ordinary user", [ordinary]],
		["old mailbox followed by ordinary user", [mailbox, ordinary]],
		["assistant tail", [mailbox, { ...ordinary, role: "assistant" }]],
		[
			"other injection kind",
			[
				{
					...mailbox,
					contentJson: [
						{ type: "system_injection", modelText: "mailbox input", body: { kind: "notice" } },
					],
				},
			],
		],
	])("rejects %s even with identical text", async (_label, messages) => {
		const history: unknown[] = [];
		await trackAgentMessageHistory("child", history, messages);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(false);
	});

	test("history-only mailbox accepts empty current input but not a subsequently extended packet", async () => {
		const history: unknown[] = [{ role: "user", content: "mailbox input" }];
		await trackAgentMessageHistory("child", history, [{ ...mailbox, role: "sys" }]);
		expect(isLastModelInputMailbox(history, "")).toBe(true);
		expect(isLastModelInputMailbox(history, "new human input")).toBe(false);
		history.push({ role: "assistant", content: "answer" });
		expect(isLastModelInputMailbox(history, "")).toBe(false);
	});

	test("retains provenance after receipt consumption and when rebuilt already consumed", async () => {
		const history: unknown[] = [];
		await trackAgentMessageHistory("child", history, [mailbox]);
		consumeAgentMessageHistory(history);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(true);
		await trackAgentMessageHistory("child", history, [{ ...mailbox, injectionConsumedAt: now }]);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(true);
		await trackAgentMessageHistory("child", history, [ordinary]);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(false);
	});

	test("a sys row after an older mailbox ends the model input", async () => {
		const history: unknown[] = [{ role: "user", content: "mailbox input\n\nreminder" }];
		await trackAgentMessageHistory("child", history, [mailbox, { ...ordinary, role: "sys" }]);
		expect(isLastModelInputMailbox(history, "")).toBe(false);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(false);
	});

	test("ignores child subtree and display-only tail rows", async () => {
		const history: unknown[] = [];
		await trackAgentMessageHistory("child", history, [
			mailbox,
			{ ...ordinary, parentToolUseId: "nested" },
			{ ...ordinary, role: "disp" },
		]);
		expect(isLastModelInputMailbox(history, "mailbox input")).toBe(true);
	});
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
		consumeAgentMessageHistory(prepared?.history ?? []);
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
		// The Send is one injection row: its first block carries the exact delivery body.
		expect(JSON.parse(saved?.content_json ?? "[]")[0].body.items[0].fromToolCallBinding).toEqual(
			binding,
		);
		consumeAgentMessageHistory(prepared?.history ?? []);
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
		consumeAgentMessageHistory(freshHistory);
		consumeAgentMessageHistory(freshHistory);
		const forkHistory: unknown[] = [];
		trackAgentMessageHistory("sibling", forkHistory, reloaded);
		consumeAgentMessageHistory(forkHistory);
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
			expect(getBufferedMessages("child")).toHaveLength(0);
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
			expect(getBufferedMessages("child")).toHaveLength(0);
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

	test.each(["disp", "system"])("filtered rows are not acknowledged: %s", async (role) => {
		const sent = await send();
		const id = sent.targets[0].deliveryMessageId as string;
		await consume();
		const saved = row(id);
		const history: unknown[] = [];
		trackAgentMessageHistory("child", history, [
			{ id, narratorId: "child", role, contentJson: JSON.parse(saved?.content_json ?? "[]") },
		]);
		consumeAgentMessageHistory(history);
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
		consumeAgentMessageHistory(untracked);
		consumeAgentMessageHistory([]);
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
		expect(consumed).not.toBeNull();
		// Materialized once as an injection row of the recipient, with the producer's framing.
		expect(row(id)?.content_text).toBe("[Message from the parent narrator]\nsame words");
		expect(row(id)?.role).toBe("sys");
		expect(JSON.parse(row(id)?.content_json ?? "[]")[0]).toMatchObject({
			type: "system_injection",
			source: "subagent_message",
			body: agentMessageDeliveryBody(envelope as NonNullable<typeof envelope>),
		});
		// One display frame per side (the recipient and the destination's tool card).
		const received = broadcasts.filter(({ event }) => event.type === "message");
		expect(received.map(({ target }) => target).sort()).toEqual(["child", "parent"]);
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
		await reorderBufferedMessages(
			"child",
			getBufferedMessages("child")
				.map((item) => item.id)
				.reverse(),
		);
		await consume();
		await consume();
		expect(JSON.parse(row(ids[0])?.content_json ?? "[]")[0].body.items[0].fromId).toBe("parent");
		expect(JSON.parse(row(ids[1])?.content_json ?? "[]")[0].body.items[0].fromId).toBe("sibling");
	});

	test("clearing user buffers preserves accepted agent delivery and identical human text stays separate", async () => {
		const result = await send();
		const reserved = result.targets[0].deliveryMessageId;
		clearBufferedMessages("child");
		expect(await agentQueued()).toHaveLength(1);
		await enqueueBufferedMessage("child", "[Message from the parent narrator]\nsame words");
		// The agent message is adopted at the boundary; the human input starts a new turn.
		await consume();
		expect(row(reserved)).not.toBeNull();
		await restart();
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
		expect(await updateBufferedMessage("child", queued.id, "human correction")).toBe(false);
		await consume();
		expect(row(result.targets[0].deliveryMessageId)?.content_text).toContain("same words");
		const actual = sqlite
			.prepare("SELECT origin, content_text FROM narrator_messages WHERE narrator_id = 'child'")
			.get() as { origin: string; content_text: string };
		// Machine-authored, never attributed to a human editor.
		expect(actual.origin).not.toBe("user");
		expect(actual.content_text).not.toContain("human correction");
	});

	test("queue capacity failures expose no receipt and do not create a row", async () => {
		for (let i = 0; i < 50; i++) {
			expect((await send()).targets[0].status).toBe("queued");
		}
		// User quota is independent of the full agent-message quota.
		expect((await enqueueBufferedMessage("child", "pending")).ok).toBe(true);
		const result = await send();
		expect(result.targets[0].status).toBe("failed");
		expect(result.targets[0].deliveryMessageId).toBeUndefined();
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(0);
	});

	test("idle child receives its exact envelope and its ordinary run starts", async () => {
		sqlite
			.prepare("UPDATE narrators SET status = 'idle', cwd = ? WHERE id = 'child'")
			.run(process.env.HOME ?? ".");
		// An idle recipient resumes under its own registered anonymous identity, never the sender's.
		sqlite
			.prepare(
				"UPDATE narrators SET runtime_registration_json = json_set(runtime_registration_json, '$.run.principal', json(?)) WHERE id = 'child'",
			)
			.run(JSON.stringify({ userId: null }));
		const result = await send();
		expect(result.targets[0].status).toBe("started");
		// The run starts with no new input: the message is already in the session's history.
		expect(runStarts).toEqual([{ narratorId: "child", text: "" }]);
		expect(row(result.targets[0].deliveryMessageId)?.content_text).toBe(
			"[Message from the parent narrator]\nsame words",
		);
		expect(getBufferedMessages("child")).toHaveLength(0);
	});

	test("a wake that cannot start leaves the Send queued and never labels later human text", async () => {
		// The recipient's last stop was the user's interrupt: an agent message alone does
		// not restart it, so the message stays queued and the sender is told it is blocked.
		sqlite
			.prepare(
				"UPDATE narrators SET status = 'idle', cwd = ?, last_stop_reason = 'user_interrupt' WHERE id = 'child'",
			)
			.run(process.env.HOME ?? ".");
		const result = await send();
		expect(result.targets[0]).toMatchObject({ status: "blocked", blockedReason: "user_interrupt" });
		expect(runStarts).toHaveLength(0);
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
		expect(tryClaimExecution("parent", "run")).not.toBeNull();
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
		trackAgentMessageHistory("parent", history, [
			{
				id: id as string,
				narratorId: "parent",
				role: "sys",
				contentJson: JSON.parse(source?.content_json ?? "[]"),
			},
		]);
		consumeAgentMessageHistory(history);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(id, "parent")).toBeNumber();
		expect(broadcasts.filter(({ event }) => event.type === "message")).toHaveLength(1);
	});

	test("commit followed by parent-version failure still consumes exactly once", async () => {
		const result = await send();
		const versionLookup = spyOn(db.query.narratorToolCalls, "findFirst").mockRejectedValueOnce(
			new Error("parent version unavailable"),
		);
		try {
			const consumed = await inPass({ narratorId: "child" });
			expect(consumed?.text).toContain("same words");
			expect(row(result.targets[0].deliveryMessageId)).not.toBeNull();
			expect(getBufferedMessages("child")).toHaveLength(0);
			expect(await consume()).toBeNull();
			expect(
				sqlite
					.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'")
					.all(),
			).toHaveLength(1);
			// One display frame for the recipient and one for the destination's tool card.
			expect(
				broadcasts
					.filter(({ event }) => event.type === "message")
					.map(({ target }) => target)
					.sort(),
			).toEqual(["child", "parent"]);
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
		await enqueueBufferedMessage("child", "draft", undefined, null, "editor");
		const queued = getBufferedMessages("child")[0];
		expect(await updateBufferedMessage("child", queued.id, "human correction")).toBe(true);
		// A human draft stays in the user lane: it is never an agent delivery.
		expect((await agentQueued()).map((row) => row.text)).not.toContain("human correction");
		const childRows = () =>
			sqlite
				.prepare(
					"SELECT id, origin, content_text, created_by FROM narrator_messages WHERE narrator_id = 'child'",
				)
				.all();
		// Explicit turn/pass input must wait for restart, never inject into this pass.
		expect(await inPass({ narratorId: "child", currentUserId: "editor" })).toBeNull();
		expect(getBufferedMessages("child")).toHaveLength(1);
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
			expect(getBufferedMessages("child")).toHaveLength(0);
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
		await enqueueBufferedMessage("child", "draft");
		const queued = getBufferedMessages("child")[0];
		expect(await updateBufferedMessage("child", queued.id, "retry human correction")).toBe(true);
		const edited = getBufferedMessages("child")[0];
		expect(await inPass({ narratorId: "child" })).toBeNull();
		sqlite.run(`CREATE TEMP TRIGGER fail_message_ref BEFORE INSERT ON narrator_message_refs
			BEGIN SELECT RAISE(ABORT, 'ref insertion unavailable'); END`);
		try {
			// The wake reports nothing started; the failed persistence is released, not lost.
			expect(await restart().catch(() => null)).toBeNull();
			expect(runStarts).toHaveLength(0);
			expect(getBufferedMessages("child")).toEqual([
				expect.objectContaining({ id: edited.id, text: edited.text }),
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
		expect(getBufferedMessages("child")).toHaveLength(0);
		expect(row(result.targets[0].deliveryMessageId)).toBeNull();
		expect(
			sqlite.prepare("SELECT id FROM narrator_messages WHERE id NOT LIKE 'source-message-%'").all(),
		).toHaveLength(1);
		expect(sqlite.prepare("SELECT id FROM narrator_message_refs").all()).toHaveLength(1);
		expect(broadcasts.filter(({ event }) => event.type === "user_message")).toHaveLength(2);
	});

	// "a running pass withholds failed bytes, requeues, then delivers once" runs the real
	// run service, so it lives in agent-message-delivery-running-pass.test.ts (this
	// file's static imports bind publication before its DB mock is installed).

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
		expect(tryClaimExecution("child", "run")).not.toBeNull();
		const claimed = await claimInboxHead("child", (row) => row.kind === "agent_message");
		if (!claimed) throw new Error("Expected team mailbox claim");
		const childMessage = projectTeamMessage(claimed);
		expect(childMessage.delivery?.recipientMessageId).toBe(first);
		expect(childMessage.delivery?.senderToolCallBinding).toEqual(message.fromToolCallBinding);
		expect((await drainTeamInbox("sibling"))[0].delivery?.recipientMessageId).toBe(second);
		expect(row(first)).toBeNull();
		expect(getBufferedMessages("child")).toHaveLength(0);
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
		trackAgentMessageHistory("child", history, [
			{
				id: first as string,
				narratorId: "child",
				role: "sys",
				contentJson: JSON.parse(row(first)?.content_json ?? "[]"),
			},
		]);
		consumeAgentMessageHistory(history);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consumedAt(first)).toBeNumber();
		expect(row(second)).toBeNull();
		expect(consumedAt(second, "sibling")).toBeNull();
	});
});
