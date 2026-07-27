/**
 * vlist-streaming-tail-retirement.test.ts — Pins the streaming→persisted hand-off.
 *
 * The load-bearing case is "a live lifecycle patch must NOT retire the tail".
 * Live patches (tool completion, reflection resolution) commit layouts of their
 * own, so any commit-counting judgement would advance mid-hand-off and release
 * the tail before its replacement exists — silently reopening the blank frame the
 * whole mechanism removes. Keying on message membership is what makes that
 * impossible, and that property is asserted directly here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	collectCommittedMessageIds,
	resolveStreamingTailRetirement,
	STREAMING_TAIL_RETIRE_TIMEOUT_MS,
} from "./vlist-streaming-tail-retirement";

const ids = (...values: string[]): ReadonlySet<string> => new Set(values);

function decide(overrides: {
	pendingRetireMessageId?: string | null;
	committedMessageIds?: ReadonlySet<string>;
	elapsedMs?: number;
	timeoutMs?: number;
}) {
	return resolveStreamingTailRetirement({
		pendingRetireMessageId: overrides.pendingRetireMessageId ?? null,
		committedMessageIds: overrides.committedMessageIds ?? ids(),
		elapsedMs: overrides.elapsedMs ?? 0,
		timeoutMs: overrides.timeoutMs ?? STREAMING_TAIL_RETIRE_TIMEOUT_MS,
	});
}

describe("resolveStreamingTailRetirement", () => {
	it("keeps the tail while nothing has requested retirement", () => {
		// Mid-stream: the tail is the only view of live output.
		expect(decide({ committedMessageIds: ids("m1", "m2") })).toEqual({ retire: false });
	});

	it("keeps the tail while the awaited message is NOT yet in the document", () => {
		// This is the blank-frame window: the message exists on the server but the
		// document has not committed it, so the tail must hold.
		expect(
			decide({ pendingRetireMessageId: "m-new", committedMessageIds: ids("m1", "m2") }),
		).toEqual({ retire: false });
	});

	it("retires the tail once the awaited message is committed", () => {
		expect(
			decide({ pendingRetireMessageId: "m-new", committedMessageIds: ids("m1", "m-new") }),
		).toEqual({ retire: true, reason: "replaced" });
	});

	// ── The L1/L2 collision this design exists to prevent ────────────────────
	it("does NOT retire the tail when a live patch commits without adding the message", () => {
		// A tool_completed / reflection_resolved patch re-commits the layout with the
		// SAME message set. Under a commit-counter judgement this would retire the
		// tail early and reopen the flicker; membership makes it a no-op.
		const before = ids("m1", "m2");
		const afterPatch = ids("m1", "m2"); // patch changed FIELDS, not membership
		expect(decide({ pendingRetireMessageId: "m-new", committedMessageIds: before })).toEqual({
			retire: false,
		});
		expect(decide({ pendingRetireMessageId: "m-new", committedMessageIds: afterPatch })).toEqual({
			retire: false,
		});
	});

	it("does not retire on an unrelated message arriving (e.g. a later user message)", () => {
		expect(
			decide({ pendingRetireMessageId: "m-new", committedMessageIds: ids("m1", "m-other") }),
		).toEqual({ retire: false });
	});

	it("retires defensively after the timeout when the replacement never lands", () => {
		// A failed reload (409 version conflict, network error) means the awaited id
		// can never appear; without this the overlay would be pinned forever.
		expect(
			decide({
				pendingRetireMessageId: "m-new",
				committedMessageIds: ids("m1"),
				elapsedMs: STREAMING_TAIL_RETIRE_TIMEOUT_MS,
			}),
		).toEqual({ retire: true, reason: "timeout" });
	});

	it("does not time out one tick early", () => {
		expect(
			decide({
				pendingRetireMessageId: "m-new",
				committedMessageIds: ids("m1"),
				elapsedMs: STREAMING_TAIL_RETIRE_TIMEOUT_MS - 1,
			}),
		).toEqual({ retire: false });
	});

	it("prefers the `replaced` reason when both conditions hold", () => {
		// A slow-but-successful reload must not be reported as a failure.
		expect(
			decide({
				pendingRetireMessageId: "m-new",
				committedMessageIds: ids("m-new"),
				elapsedMs: STREAMING_TAIL_RETIRE_TIMEOUT_MS * 10,
			}),
		).toEqual({ retire: true, reason: "replaced" });
	});

	it("uses a defensive bound long enough for a slow refetch but not indefinite", () => {
		expect(STREAMING_TAIL_RETIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
		expect(STREAMING_TAIL_RETIRE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
	});
});

describe("collectCommittedMessageIds", () => {
	it("collects top-level ids only", () => {
		// A child message belongs to a subagent's own page and never supersedes this
		// page's tail, so walking into children would be wrong.
		const set = collectCommittedMessageIds([
			{ id: "m1" },
			{ id: "m2", children: [{ id: "c1" }] } as { id: string },
		]);
		expect([...set].sort()).toEqual(["m1", "m2"]);
	});

	it("ignores entries without a usable id", () => {
		const set = collectCommittedMessageIds([{ id: "m1" }, {}, { id: "" }, { id: 7 }]);
		expect([...set]).toEqual(["m1"]);
	});

	it("returns an empty set for an empty document", () => {
		expect(collectCommittedMessageIds([]).size).toBe(0);
	});
});

/**
 * The pure decision above answers "may the tail go now"; the HOOK owns the clock
 * that asks. Those two must agree on the bound, and a periodic sweep does not:
 * polling at the timeout's own period notices a request one full period late, so
 * the worst case is 2 × timeout (≈6s of frozen streaming text against a 3s
 * documented bound). These are source-level assertions because the failure mode is
 * a silent re-introduction of the poll, which no test on the pure function sees.
 */
describe("the hook schedules the defensive timeout exactly", () => {
	const hook = readFileSync(join(import.meta.dir, "useExactStreamingTail.ts"), "utf8");

	it("does not poll for the deadline", () => {
		expect(hook).not.toContain("setInterval");
	});

	it("arms a one-shot timer when the retirement is requested", () => {
		expect(hook).toContain("setTimeout");
		// The WS handler that records the request must also start the clock, instead
		// of leaving it to whenever the next sweep happens to run.
		const handler = hook.slice(hook.indexOf("onMessage:"), hook.indexOf("onStatusChange:"));
		expect(handler).toContain("retireDeadlineTimerRef.current?.(STREAMING_TAIL_RETIRE_TIMEOUT_MS)");
	});

	it("re-arms for the remainder when a later request supersedes the armed one", () => {
		// Releasing on the OLD deadline would drop the tail before the newer
		// message's own grace period expired.
		expect(hook).toContain("STREAMING_TAIL_RETIRE_TIMEOUT_MS - (Date.now() - pending.requestedAt)");
		expect(hook).toContain("if (remaining > 0)");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring assertions: the hook must apply the decision at the right time
// ─────────────────────────────────────────────────────────────────────────────

describe("streaming tail hand-off wiring", () => {
	it("requests retirement instead of clearing immediately on a persisted message", async () => {
		const src = await Bun.file(
			new URL("./useExactStreamingTail.ts", import.meta.url).pathname,
		).text();
		const handler = src.slice(src.indexOf("onMessage:"), src.indexOf("onStatusChange:"));
		expect(handler).toContain("pendingRetireRef.current =");
		// Clearing here is exactly the original bug.
		expect(handler).not.toContain("clearBlocks()");
	});

	it("releases the tail in a LAYOUT effect so no frame shows both", async () => {
		// A passive effect paints once with the tail AND the real card (duplicate),
		// then removes the tail. The release must precede paint.
		const src = await Bun.file(
			new URL("./useExactStreamingTail.ts", import.meta.url).pathname,
		).text();
		const block = src.slice(src.indexOf("useLayoutEffect(() => {"));
		expect(block).toContain("resolveStreamingTailRetirement(");
		expect(block).toContain("clearBlocks()");
	});

	it("still clears immediately for genuine invalidations (reset / error / status)", async () => {
		// These are not hand-offs: no replacement is coming, so holding the tail
		// would leave dead streaming text on screen.
		const src = await Bun.file(
			new URL("./useExactStreamingTail.ts", import.meta.url).pathname,
		).text();
		expect(src).toMatch(/onStreamingReset:[\s\S]*?clearBlocks\(\)/);
		expect(src).toMatch(/onNarratorError: \(\) => clearBlocks\(\)/);
		expect(src).toMatch(/onStatusChange:[\s\S]*?clearBlocks\(\)/);
	});

	it("is fed the committed document ids by the shell", async () => {
		const shell = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		expect(shell).toContain("collectCommittedMessageIds(pretextDocument.messages)");
		expect(shell).toContain("committedMessageIds,");
	});
});
