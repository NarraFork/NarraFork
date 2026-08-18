/**
 * A concluded review has to reach the MODEL, not just the transcript.
 *
 * `review-event-handler` writes the conclusion as a `role: "user"` row and the design
 * rests on "the next request rebuilds history and sees it". That premise is false on its
 * own, and the failure is completely silent:
 *
 * Every provider's history builder POPS the last top-level user row, on the contract
 * that the caller sends it as the current turn (`buildAnthropicHistory`, and the
 * identical three lines in openai/gemini/cline). An ordinary user message satisfies that
 * contract because whoever wrote the row also passes its text into `runAgentLoop`. The
 * review card's "handle" button starts `runAgentLoop(active, "")` — deliberately, since
 * the row is supposed to already be in history — so the conclusion was popped as "the
 * current turn" while the current turn was empty. `pushUserTurn` pushes nothing for empty
 * content, so the findings appeared in NEITHER history nor the turn.
 *
 * Nothing signals that. The turn runs, the model answers from stale context, and the card
 * still sits in the transcript — so it reads as the model ignoring the review rather than
 * never having been shown it.
 *
 * Asserted at both levels:
 *   1. the builder really does drop the row (so the recovery is not guarding a non-bug);
 *   2. `resolvePoppedTrailingUserText` recovers exactly that text, and stays silent for
 *      the shapes where recovery would double-send or displace something.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../../lib/agent/anthropic-provider";
import { resolvePoppedTrailingUserText } from "../narrator-session";

const CONCLUSION_TEXT =
	"## Code Review: Changes Requested\n\n- 🚨 **[critical]** `server/db/schema.ts` — the index has no migration\n";

interface Row {
	id: string;
	narratorId?: string;
	role: string;
	contentJson: unknown;
	contentText: string;
	createdAt: string;
	parentToolUseId?: string | null;
}

function row(id: string, role: string, blocks: unknown[], text: string): Row {
	return {
		id,
		narratorId: "n1",
		role,
		contentJson: blocks,
		contentText: text,
		createdAt: `2026-08-18T00:00:0${id.slice(-1)}.000Z`,
	};
}

/** The row `review-event-handler` writes: model text + the reader's card, on one row. */
function conclusionRow(id = "m3"): Row {
	return row(
		id,
		"user",
		[
			{ type: "text", text: CONCLUSION_TEXT },
			{
				type: "review_feedback",
				verdict: "request_changes",
				findings: [{ severity: "critical", message: "the index has no migration" }],
				reviewChapterId: "rc1",
				text: CONCLUSION_TEXT,
			},
		],
		CONCLUSION_TEXT,
	);
}

const CONVERSATION = [
	row("m1", "user", [{ type: "text", text: "implement the feature" }], "implement the feature"),
	row("m2", "assistant", [{ type: "text", text: "done" }], "done"),
];

function provider(): AnthropicProvider {
	// Only `buildHistory` is exercised; it makes no network call, so a placeholder
	// config is enough and keeps the test off the wire.
	return new AnthropicProvider({
		apiKey: "test-key",
		baseUrl: "https://example.invalid",
	} as never);
}

describe("the provider history builder drops a trailing user row", () => {
	test("the conclusion is in NEITHER the history nor trailingUserText", async () => {
		const built = await provider().buildHistory(
			[...CONVERSATION, conclusionRow()] as never,
			"claude-sonnet-4-5",
			"n1",
		);

		// This is the whole reason the recovery exists: without it, an empty pass sends a
		// request that contains no trace of the review at all.
		expect(JSON.stringify(built.history)).not.toContain("the index has no migration");
		// `trailingUserText` only lifts trailing `sys` rows, so it cannot cover this.
		expect(built.trailingUserText).toBeUndefined();
	});
});

describe("resolvePoppedTrailingUserText", () => {
	test("recovers the conclusion text the builder popped", () => {
		const recovered = resolvePoppedTrailingUserText([...CONVERSATION, conclusionRow()]);
		expect(recovered).toContain("the index has no migration");
		// The model-facing `text` block, not the card's structured fields.
		expect(recovered).toBe(CONCLUSION_TEXT);
	});

	test("falls back to contentText for a row written without a text block", () => {
		// Older rows (and any producer that only persists a structured block) still have
		// the flat column, which is what the builders' own text reader falls back to.
		const legacy = row("m3", "user", [{ type: "review_feedback", verdict: "approve" }], "Approved");
		expect(resolvePoppedTrailingUserText([...CONVERSATION, legacy])).toBe("Approved");
	});

	test("returns null when history ends on an assistant turn", () => {
		// Nothing was popped, so there is nothing to resend — and inventing text here
		// would put words in the user's mouth on every continuation.
		expect(resolvePoppedTrailingUserText(CONVERSATION)).toBeNull();
	});

	test("returns null when history ends on a sys injection", () => {
		// The builders lift a trailing `sys` run into `trailingUserText` themselves.
		// Recovering it here too would send the same text twice.
		const injection = row("m3", "sys", [{ type: "text", text: "spec reminder" }], "spec reminder");
		expect(resolvePoppedTrailingUserText([...CONVERSATION, injection])).toBeNull();
	});

	test("ignores subagent rows, matching the builders' top-level filter", () => {
		const subagentRow = { ...conclusionRow(), parentToolUseId: "tu_1" };
		expect(resolvePoppedTrailingUserText([...CONVERSATION, subagentRow])).toBeNull();
	});

	test("returns null for a user row with no usable text", () => {
		const empty = row("m3", "user", [{ type: "text", text: "   " }], "");
		expect(resolvePoppedTrailingUserText([...CONVERSATION, empty])).toBeNull();
	});
});
