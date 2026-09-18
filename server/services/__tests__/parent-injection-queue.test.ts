/**
 * parent-injection-queue.test.ts — the ordering guarantee this module exists for.
 *
 * The bug being locked down: three independent queues fed one turn boundary, so
 * `drainInjectionsIntoHistory` had to pick a hard-coded sequence (completions first,
 * messages second). A subagent that reported "ready" via `Send` and then finished
 * therefore had its completion shown BEFORE the message that caused it — the result
 * before its own cause, reproduced on narrator 366EIzp1mnthlBsoUsAfB with the two rows
 * 3ms apart in the wrong order.
 *
 * So the property under test is not "each kind is ordered" (it always was) but
 * "order is preserved ACROSS kinds", which is only true if it is established at enqueue.
 *
 * MODERN PRODUCER CONTRACT (rewritten for the mailbox runtime): a subagent_message is
 * admitted only with its exact tool execution receipt (`pushPendingInjection`), and
 * background completions arrive as task_notice mailbox rows (publication outbox —
 * produced here through the shared mailbox store with the transfer's metadata shape).
 * The drain is a READ-ONLY projection: consuming is the claim/materialize path's job.
 * The mailbox REJECTS at per-kind capacity instead of evicting — the old in-memory
 * eviction tests pinned a policy the durable queue deliberately does not have.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));

import type { ParentInboundMessage } from "../parent-inbound-queue";
import type { PendingInjection } from "../parent-injection-queue";

const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { formatParentInboundMessages, pushParentInboundMessage } = await import(
	"../parent-inbound-queue"
);
const { drainPendingInjections, hasPendingInjections, pushPendingInjection } = await import(
	"../parent-injection-queue"
);

const P = "parent-1";
const TIME = "2026-09-09T00:00:00.000Z";
const mailboxStore = createMailboxStore(db);
let serial = 0;

/** A subagent_message entry with the exact persisted execution receipt it needs. */
function msg(
	text: string,
	toolUseId?: string,
): Extract<PendingInjection, { kind: "subagent_message" }> {
	const sender = `sender-${++serial}`;
	db.insert(narrators)
		.values({
			id: sender,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: P,
			createdAt: TIME,
			updatedAt: TIME,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: `${sender}-msg`,
			narratorId: sender,
			role: "assistant",
			contentJson: [],
			createdAt: TIME,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${sender}-tool`,
			narratorId: sender,
			messageId: `${sender}-msg`,
			toolUseId: toolUseId ?? `${sender}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: TIME,
		})
		.run();
	const delivery = createAgentMessageDelivery(
		P,
		{ id: sender, title: text, label: sender, type: "general", isParent: false },
		toolUseId ?? `${sender}-use`,
		text,
		{ toolCallId: `${sender}-tool`, attempt: 1 },
	);
	const message: ParentInboundMessage = {
		delivery,
		fromId: sender,
		fromTitle: text,
		fromType: "general",
		fromToolUseId: delivery.fromToolUseId,
		text,
		timestamp: TIME,
	};
	return { kind: "subagent_message", message };
}

/** A background completion as it actually arrives: a task_notice mailbox row. */
function notice(producerKind: "agent" | "bash", taskId: string) {
	const result = mailboxStore.enqueue({
		kind: "task_notice",
		noticeKind: producerKind,
		narratorId: P,
		text: `[System] Background ${producerKind} "${taskId}" completed.`,
		projectedByteSize: 128,
		sourceKey: `test-notice:${producerKind}:${taskId}:${++serial}`,
		metadata: { producerKind, taskId, logicalRunId: `run-${taskId}`, eventKind: "completed" },
	});
	if (result.status !== "accepted") throw new Error(`notice enqueue rejected: ${result.status}`);
	return result.delivery;
}

/** Identity of each entry, for order assertions. */
function ids(entries: readonly PendingInjection[]): string[] {
	return entries.map((e) =>
		e.kind === "subagent_message" ? `msg:${e.message.text}` : `${e.kind}:${e.task.id}`,
	);
}

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of [P, "other"])
		db.insert(narrators)
			.values({ id, type: "primary", variant: "primary", createdAt: TIME, updatedAt: TIME })
			.run();
});
afterAll(() => {
	sqlite.close();
});

describe("parent injection queue — order across kinds", () => {
	test("preserves the exact Send invocation without leaking it into model text", async () => {
		const entry0 = msg("progress report", "send-tool-secret");
		await pushParentInboundMessage(P, entry0.message);
		const entry = (await drainPendingInjections(P))[0];
		expect(entry?.kind).toBe("subagent_message");
		if (entry?.kind !== "subagent_message") throw new Error("missing delivery");
		expect(entry.message.fromToolUseId).toBe("send-tool-secret");
		expect(formatParentInboundMessages([entry.message], "en")).not.toContain("send-tool-secret");
	});

	test("Send producer and persisted injection keep the invocation coordinate", async () => {
		const producer = await Bun.file(new URL("../agent-communication.ts", import.meta.url)).text();
		const delivery = await Bun.file(new URL("../narrator-session.ts", import.meta.url)).text();
		expect(producer).toContain("input.toolCallBinding");
		expect(producer).toContain("input.toolUseId");
		expect(producer).not.toContain("getSubagentResultMessageId");
		expect(delivery).toContain("{ fromToolUseId: message.fromToolUseId }");
	});

	test("preserves arrival order when kinds interleave", async () => {
		// The exact shape of the reported bug: Send happens first, completion second.
		await pushPendingInjection(P, msg("ready"));
		notice("agent", "t1");
		expect(ids(await drainPendingInjections(P))).toEqual(["msg:ready", "bg_agent:t1"]);
	});

	test("does NOT group by kind — a message between two completions keeps its slot", async () => {
		notice("agent", "t1");
		await pushPendingInjection(P, msg("mid"));
		notice("bash", "b1");
		expect(ids(await drainPendingInjections(P))).toEqual(["bg_agent:t1", "msg:mid", "bg_bash:b1"]);
	});

	test("order does not depend on which kind was enqueued first", async () => {
		notice("agent", "a");
		await pushPendingInjection(P, msg("m"));
		const completionFirst = ids(await drainPendingInjections(P));

		cleanDb(sqlite);
		db.insert(narrators)
			.values({ id: P, type: "primary", variant: "primary", createdAt: TIME, updatedAt: TIME })
			.run();

		await pushPendingInjection(P, msg("m"));
		notice("agent", "a");
		const messageFirst = ids(await drainPendingInjections(P));

		expect(completionFirst).toEqual(["bg_agent:a", "msg:m"]);
		expect(messageFirst).toEqual(["msg:m", "bg_agent:a"]);
	});

	test("keeps buckets separate per parent narrator", async () => {
		await pushPendingInjection(P, msg("mine"));
		const other = msg("theirs");
		if (!other.message.delivery) throw new Error("missing fixture delivery");
		other.message.delivery.recipientNarratorId = "other";
		await pushPendingInjection("other", other);
		expect(ids(await drainPendingInjections(P))).toEqual(["msg:mine"]);
		expect(ids(await drainPendingInjections("other"))).toEqual(["msg:theirs"]);
	});
});

describe("parent injection queue — read-only drain", () => {
	test("draining is a projection: a second drain sees the same rows", async () => {
		await pushPendingInjection(P, msg("once"));
		expect(await drainPendingInjections(P)).toHaveLength(1);
		expect(await drainPendingInjections(P)).toHaveLength(1);
	});

	test("hasPendingInjections reports without consuming", async () => {
		// The wake predicates call this and may DECLINE (e.g. a plan-mode narrator); the
		// entries must survive that so the next drain still delivers them.
		expect(await hasPendingInjections(P)).toBe(false);
		await pushPendingInjection(P, msg("keep"));
		expect(await hasPendingInjections(P)).toBe(true);
		expect(await hasPendingInjections(P)).toBe(true);
		expect(await drainPendingInjections(P)).toHaveLength(1);
		expect(await hasPendingInjections(P)).toBe(true);
	});
});

describe("parent injection queue — admission contract", () => {
	test("completions are rejected: they require the durable publication outbox", async () => {
		const completion = {
			kind: "bg_agent" as const,
			task: { id: "t1", title: "t1", status: "completed" as const, resultPreview: "done" },
		};
		await expect(pushPendingInjection(P, completion)).rejects.toThrow("publication outbox");
		expect(await hasPendingInjections(P)).toBe(false);
	});

	test("a message without its execution receipt is rejected", async () => {
		const entry = msg("no receipt");
		delete entry.message.delivery;
		await expect(pushPendingInjection(P, entry)).rejects.toThrow("exact delivery receipt");
		expect(await hasPendingInjections(P)).toBe(false);
	});

	test("the mailbox rejects at per-kind capacity instead of evicting", async () => {
		// agentPending is 50: the 51st Send to the same recipient is refused loudly.
		for (let index = 0; index < 50; index++) await pushPendingInjection(P, msg(`m${index}`));
		await expect(pushPendingInjection(P, msg("overflow"))).rejects.toThrow("queue is full");
		// … while a different kind keeps its own budget.
		notice("bash", "still-fits");
		expect(await hasPendingInjections(P)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The reported bug, end to end at the queue level
//
// Narrator 366EIzp1mnthlBsoUsAfB: two subagents each reported "ready" with
// `Send({ id: "parent" })` and then finished. The parent's timeline showed
//
//     beta  completed      ← bg_agent
//     alpha completed      ← bg_agent
//     alpha general        ← subagent_message
//     beta  general        ← subagent_message
//
// i.e. both completions before either message, though the messages were sent first.
// The two rows landed 3ms apart, which is the gap between two lines of drain code —
// not the gap between the events.
// ─────────────────────────────────────────────────────────────────────────────

describe("regression: Send before completion stays before completion", () => {
	test("two subagents reporting then finishing keeps report → completion order", async () => {
		// Exactly the reported interleaving: alpha reports, beta reports, then both finish.
		await pushPendingInjection(P, msg("alpha ready"));
		await pushPendingInjection(P, msg("beta ready"));
		notice("agent", "alpha");
		notice("agent", "beta");

		const drained = await drainPendingInjections(P);
		expect(ids(drained)).toEqual([
			"msg:alpha ready",
			"msg:beta ready",
			"bg_agent:alpha",
			"bg_agent:beta",
		]);
		// Each entry now persists as its OWN row (the consecutive-kind merge is gone), so
		// the arrival order IS the delivery order — messages first, then completions.
		expect(drained.map((e) => e.kind)).toEqual([
			"subagent_message",
			"subagent_message",
			"bg_agent",
			"bg_agent",
		]);
	});

	test("a subagent that finishes BEFORE it is heard from keeps that order too", async () => {
		// The mirror case must not be "fixed" into the other order: whichever really
		// happened first is what shows first.
		notice("agent", "solo");
		await pushPendingInjection(P, msg("late word"));
		expect(ids(await drainPendingInjections(P))).toEqual(["bg_agent:solo", "msg:late word"]);
	});

	test("per-subagent report→completion pairs interleave without reordering", async () => {
		// alpha finishes while beta is still reporting. The old fixed sequence would hoist
		// alpha's completion past beta's message; arrival order must survive instead.
		await pushPendingInjection(P, msg("alpha ready"));
		notice("agent", "alpha");
		await pushPendingInjection(P, msg("beta ready"));
		notice("agent", "beta");

		const drained = await drainPendingInjections(P);
		expect(ids(drained)).toEqual([
			"msg:alpha ready",
			"bg_agent:alpha",
			"msg:beta ready",
			"bg_agent:beta",
		]);
		expect(drained).toHaveLength(4);
	});

	test("ONE consumer sees every kind, so a wake cannot drop the other kinds", async () => {
		// The hazard introduced by merging the queues: each idle path used to drain only
		// its own kind. Against a shared queue that silently discards the rest, so both
		// paths now go through one consumer. This pins the queue half of that contract —
		// a single drain returns all three kinds.
		await pushPendingInjection(P, msg("m"));
		notice("agent", "a");
		notice("bash", "b");

		const drained = await drainPendingInjections(P);
		expect(drained).toHaveLength(3);
		expect(new Set(drained.map((e) => e.kind))).toEqual(
			new Set(["subagent_message", "bg_agent", "bg_bash"]),
		);
		// The drain is read-only: entries stay queued for the claiming consumer.
		expect(await hasPendingInjections(P)).toBe(true);
	});
});

/**
 * The idle-parent path formats its own text (the busy path goes through the
 * sidecar renderer), so the sender-naming rule has to hold in both. An untitled
 * subagent used to be named by an 8-char slice of its nanoid here.
 */
describe("formatParentInboundMessages names the sender readably", () => {
	const NANOID = "UscgG1vLFnxzyKyaUOIfR";

	function inbound(over: Partial<ParentInboundMessage> = {}): ParentInboundMessage {
		return {
			fromId: NANOID,
			fromTitle: null,
			fromType: "explore",
			text: "found it",
			timestamp: TIME,
			...over,
		};
	}

	test("uses the alias when the sender has no title", () => {
		const text = formatParentInboundMessages([inbound({ fromLabel: "trace-providers" })], "en");
		expect(text).toContain("trace-providers");
		expect(text).not.toContain(NANOID);
	});

	test("a title still outranks the alias", () => {
		const text = formatParentInboundMessages(
			[inbound({ fromTitle: "Explorer", fromLabel: "trace-providers" })],
			"en",
		);
		expect(text).toContain("Explorer");
	});

	test("without either, it falls back to a short id rather than the whole one", () => {
		const text = formatParentInboundMessages([inbound()], "en");
		expect(text).toContain("UscgG1vL");
		expect(text).not.toContain(NANOID);
	});
});
