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
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { CompletedNotification } from "../background-task-service";
import type { CompletedBgSubagentNotification } from "../bg-completion-queue";
import type { ParentInboundMessage } from "../parent-inbound-queue";
import {
	drainPendingInjections,
	hasPendingInjections,
	type PendingInjection,
	pushPendingInjection,
	runItems,
} from "../parent-injection-queue";

const P = "parent-1";

function msg(text: string): PendingInjection {
	const message: ParentInboundMessage = {
		fromId: `sub-${text}`,
		fromTitle: text,
		fromType: "general",
		text,
		timestamp: new Date().toISOString(),
	};
	return { kind: "subagent_message", message };
}

function agent(id: string): PendingInjection {
	const task: CompletedBgSubagentNotification = {
		id,
		title: id,
		status: "completed",
		resultPreview: "done",
	};
	return { kind: "bg_agent", task };
}

function bash(id: string): PendingInjection {
	const task: CompletedNotification = {
		id,
		type: "bash",
		title: id,
		alias: id,
		status: "completed",
		outputPreview: "ok",
	};
	return { kind: "bg_bash", task };
}

/** Identity of each entry, for order assertions. */
function ids(entries: readonly PendingInjection[]): string[] {
	return entries.map((e) =>
		e.kind === "subagent_message" ? `msg:${e.message.text}` : `${e.kind}:${e.task.id}`,
	);
}

beforeEach(() => {
	// The queue is globalThis-pinned (hot-reload safe), so it survives between tests.
	drainPendingInjections(P);
	drainPendingInjections("other");
});

describe("parent injection queue — order across kinds", () => {
	test("preserves arrival order when kinds interleave", () => {
		// The exact shape of the reported bug: Send happens first, completion second.
		pushPendingInjection(P, msg("ready"));
		pushPendingInjection(P, agent("t1"));
		expect(ids(drainPendingInjections(P))).toEqual(["msg:ready", "bg_agent:t1"]);
	});

	test("does NOT group by kind — a message between two completions keeps its slot", () => {
		pushPendingInjection(P, agent("t1"));
		pushPendingInjection(P, msg("mid"));
		pushPendingInjection(P, bash("b1"));
		expect(ids(drainPendingInjections(P))).toEqual(["bg_agent:t1", "msg:mid", "bg_bash:b1"]);
	});

	test("order does not depend on which kind was enqueued first", () => {
		// A fixed drain sequence would make one of these two come out reordered; both
		// must come out exactly as pushed.
		pushPendingInjection(P, agent("a"));
		pushPendingInjection(P, msg("m"));
		const completionFirst = ids(drainPendingInjections(P));

		pushPendingInjection(P, msg("m"));
		pushPendingInjection(P, agent("a"));
		const messageFirst = ids(drainPendingInjections(P));

		expect(completionFirst).toEqual(["bg_agent:a", "msg:m"]);
		expect(messageFirst).toEqual(["msg:m", "bg_agent:a"]);
	});

	test("keeps buckets separate per parent narrator", () => {
		pushPendingInjection(P, msg("mine"));
		pushPendingInjection("other", msg("theirs"));
		expect(ids(drainPendingInjections(P))).toEqual(["msg:mine"]);
		expect(ids(drainPendingInjections("other"))).toEqual(["msg:theirs"]);
	});
});

describe("parent injection queue — draining", () => {
	test("empties the bucket, so a second drain yields nothing", () => {
		pushPendingInjection(P, msg("once"));
		expect(drainPendingInjections(P)).toHaveLength(1);
		expect(drainPendingInjections(P)).toEqual([]);
	});

	test("hasPendingInjections reports without consuming", () => {
		// The wake predicates call this and may DECLINE (e.g. a plan-mode narrator); the
		// entries must survive that so the next drain still delivers them.
		expect(hasPendingInjections(P)).toBe(false);
		pushPendingInjection(P, msg("keep"));
		expect(hasPendingInjections(P)).toBe(true);
		expect(hasPendingInjections(P)).toBe(true);
		expect(drainPendingInjections(P)).toHaveLength(1);
		expect(hasPendingInjections(P)).toBe(false);
	});
});

describe("parent injection queue — per-kind caps", () => {
	test("a flood of completions cannot evict queued messages", () => {
		// The reason caps are per kind: the three queues were independent before, and
		// merging them for ORDER must not merge their eviction pressure.
		pushPendingInjection(P, msg("precious"));
		for (let i = 0; i < 250; i++) pushPendingInjection(P, bash(`b${i}`));

		const drained = drainPendingInjections(P);
		const messages = runItems(drained, "subagent_message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message.text).toBe("precious");
		// And the message keeps its position at the front.
		expect(drained[0]?.kind).toBe("subagent_message");
	});

	test("evicts the OLDEST of its own kind, keeping the newest 20 messages", () => {
		for (let i = 0; i < 25; i++) pushPendingInjection(P, msg(`m${i}`));
		const drained = runItems(drainPendingInjections(P), "subagent_message");
		expect(drained).toHaveLength(20);
		// Newest kept, oldest dropped — matches MAX_PARENT_INBOUND_MESSAGES' behaviour.
		expect(drained[0]?.message.text).toBe("m5");
		expect(drained[19]?.message.text).toBe("m24");
	});

	test("each kind has its own budget", () => {
		for (let i = 0; i < 25; i++) {
			pushPendingInjection(P, msg(`m${i}`));
			pushPendingInjection(P, agent(`a${i}`));
			pushPendingInjection(P, bash(`b${i}`));
		}
		const drained = drainPendingInjections(P);
		expect(runItems(drained, "subagent_message")).toHaveLength(20);
		// Completions are under their (much larger) bound, so none were dropped.
		expect(runItems(drained, "bg_agent")).toHaveLength(25);
		expect(runItems(drained, "bg_bash")).toHaveLength(25);
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
	test("two subagents reporting then finishing keeps report → completion order", () => {
		// Exactly the reported interleaving: alpha reports, beta reports, then both finish.
		pushPendingInjection(P, msg("alpha ready"));
		pushPendingInjection(P, msg("beta ready"));
		pushPendingInjection(P, agent("alpha"));
		pushPendingInjection(P, agent("beta"));

		const drained = drainPendingInjections(P);
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

	test("a subagent that finishes BEFORE it is heard from keeps that order too", () => {
		// The mirror case must not be "fixed" into the other order: whichever really
		// happened first is what shows first.
		pushPendingInjection(P, agent("solo"));
		pushPendingInjection(P, msg("late word"));
		expect(ids(drainPendingInjections(P))).toEqual(["bg_agent:solo", "msg:late word"]);
	});

	test("per-subagent report→completion pairs interleave without reordering", () => {
		// alpha finishes while beta is still reporting. The old fixed sequence would hoist
		// alpha's completion past beta's message; arrival order must survive instead.
		pushPendingInjection(P, msg("alpha ready"));
		pushPendingInjection(P, agent("alpha"));
		pushPendingInjection(P, msg("beta ready"));
		pushPendingInjection(P, agent("beta"));

		const drained = drainPendingInjections(P);
		expect(ids(drained)).toEqual([
			"msg:alpha ready",
			"bg_agent:alpha",
			"msg:beta ready",
			"bg_agent:beta",
		]);
		// Four entries, each its own injection row — the price of telling the truth about
		// ordering, and the reason each row is its own bubble.
		expect(drained).toHaveLength(4);
	});

	test("ONE consumer sees every kind, so a wake cannot drop the other kinds", () => {
		// The hazard introduced by merging the queues: each idle path used to drain only
		// its own kind. Against a shared queue that silently discards the rest, so both
		// paths now go through one consumer. This pins the queue half of that contract —
		// a single drain returns all three kinds.
		pushPendingInjection(P, msg("m"));
		pushPendingInjection(P, agent("a"));
		pushPendingInjection(P, bash("b"));

		const drained = drainPendingInjections(P);
		expect(drained).toHaveLength(3);
		expect(new Set(drained.map((e) => e.kind))).toEqual(
			new Set(["subagent_message", "bg_agent", "bg_bash"]),
		);
		// Nothing is left behind for a second consumer to find.
		expect(hasPendingInjections(P)).toBe(false);
	});
});
