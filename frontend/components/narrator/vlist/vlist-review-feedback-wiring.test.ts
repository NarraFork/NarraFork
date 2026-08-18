/**
 * vlist-review-feedback-wiring.test.ts — the review card's button must be wired end to
 * end, through the FRAMED path.
 *
 * The button STARTS A TURN over history the narrator already holds; it sends nothing (the
 * conclusion row is itself the user message). So an inert button does not lose the
 * findings — they are in the history either way — but it does leave the reader with no way
 * to act on them, because a concluded review deliberately does not wake an idle narrator.
 *
 * The card's own presentation properties are asserted here too, because they are what the
 * two earlier shapes each got wrong: the body has to be MARKDOWN inside a CAPPED SCROLL
 * BOX. A plain-text card silently degrades every code span and file path in a conclusion,
 * and an uncapped one grows the row until a long review is unusable.
 *
 * The shell is not unit-mountable (scroll container + document coordinator + WS
 * subscription), so its half is asserted against the source, in the same spirit as
 * vlist-spec-carryover-wiring.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VListItem } from "./vlist-pipeline";
import {
	isReviewFeedbackItem,
	resolveReviewFeedbackActions,
} from "./vlist-review-feedback-actions";

const DIR = import.meta.dir;
const SHELL = readFileSync(join(DIR, "PretextExactMessageList.tsx"), "utf8");
const DISPATCH = readFileSync(join(DIR, "render-registry.tsx"), "utf8");
const CARD = readFileSync(join(DIR, "render", "RenderReviewCard.tsx"), "utf8");
const ACTIONS = readFileSync(join(DIR, "vlist-review-feedback-actions.ts"), "utf8");

/** A row of the given element kind — the resolvers only read `spec.kind`. */
function row(kind: string): VListItem {
	return {
		spec: { kind, key: `k-${kind}`, data: null },
		measured: { height: 0, blocks: [], frame: { blocks: [], contentHeight: 0, usedWidth: 0 } },
	} as unknown as VListItem;
}

describe("review feedback actions — row resolution", () => {
	it("recognizes the review card", () => {
		expect(isReviewFeedbackItem(row("review-card"))).toBe(true);
	});

	it("ignores every other kind", () => {
		// A stray match would hand the review button to an unrelated card. The bubble and
		// system-text kinds are listed explicitly because the card used to be BOTH of those,
		// so a leftover match there would fire on unrelated rows.
		expect(isReviewFeedbackItem(row("injection-bubble"))).toBe(false);
		expect(isReviewFeedbackItem(row("system-text"))).toBe(false);
		expect(isReviewFeedbackItem(row("system-simple"))).toBe(false);
		expect(isReviewFeedbackItem(row("plan-card"))).toBe(false);
		expect(isReviewFeedbackItem(row("markdown"))).toBe(false);
		expect(isReviewFeedbackItem(row("tool-call"))).toBe(false);
	});

	it("resolves actions from the row's owning message id", () => {
		const seen: Array<string | undefined> = [];
		const resolve = (messageId: string | undefined) => {
			seen.push(messageId);
			return messageId ? { onApply: () => {} } : undefined;
		};
		expect(resolveReviewFeedbackActions(row("review-card"), ["msg-1"], resolve)).toBeDefined();
		expect(seen).toEqual(["msg-1"]);
	});

	it("returns undefined for a non-review row without consulting the resolver", () => {
		let called = false;
		const resolve = () => {
			called = true;
			return { onApply: () => {} };
		};
		expect(resolveReviewFeedbackActions(row("markdown"), ["msg-1"], resolve)).toBeUndefined();
		expect(called).toBe(false);
	});

	it("yields no actions when the row carries no message id", () => {
		// The apply route is addressed by message id, so without one there is nothing to
		// offer — an enabled button would 404.
		const resolve = (messageId: string | undefined) =>
			messageId ? { onApply: () => {} } : undefined;
		expect(resolveReviewFeedbackActions(row("review-card"), [], resolve)).toBeUndefined();
	});
});

describe("review feedback actions — shell wiring", () => {
	it("injects the resolved action into the row's render extra", () => {
		expect(SHELL).toContain("if (reviewFeedbackActions) extra.reviewFeedbackActions");
		expect(SHELL).toContain("reviewFeedbackActions={resolveReviewFeedbackActions(");
		// Row identity must take part in the memo comparison, or the in-flight state would
		// not repaint the button.
		expect(SHELL).toContain("prev.reviewFeedbackActions === next.reviewFeedbackActions");
	});

	it("builds the resolver for the narrator being viewed", () => {
		expect(SHELL).toContain("useReviewFeedbackActions(narratorId)");
	});

	it("dispatches the review-card kind to its own renderer, with the action attached", () => {
		expect(DISPATCH).toContain('case "review-card":');
		expect(DISPATCH).toContain("actions={extra.reviewFeedbackActions as never}");
	});

	it("forwards the adapter's header chrome as data", () => {
		// The verdict badge, the revision marker and the button label all live in the spec
		// data; without them the header paints an empty badge and an unlabelled button.
		expect(DISPATCH).toContain("data={extra.data as never}");
	});

	it("keeps the body in a capped scroll box, so a long conclusion cannot grow the row", () => {
		// The property every earlier shape lacked. All three must hold together: a fixed
		// height from the measure pass, the cap as a ceiling, and `overflow: auto`.
		expect(CARD).toContain("height: measured.bodyHeight");
		expect(CARD).toContain("maxHeight: measured.appliedCap");
		expect(CARD).toContain('overflow: "auto"');
	});

	it("renders the body as markdown rather than painting plain text lines", () => {
		expect(CARD).toContain("<RenderMarkdown");
	});

	it("disables the button once a turn has been started for the row", () => {
		// `applied` is terminal for a row: a second click would start a second turn for the
		// same findings.
		expect(CARD).toContain("disabled={applied || !actions?.onApply}");
	});

	it("calls the apply endpoint and does not patch the row locally", () => {
		// The server flips `applied` and broadcasts `message_updated`; a local patch would be
		// a second source of truth for the same flag.
		expect(ACTIONS).toContain("api.applyReviewFeedback(narratorId, messageId)");
		expect(ACTIONS).not.toContain("setQueryData");
	});
});

describe("the conclusion row itself", () => {
	const HANDLER = readFileSync(
		join(DIR, "..", "..", "..", "..", "server", "services", "review-event-handler.ts"),
		"utf8",
	);
	const ROUTE = readFileSync(
		join(DIR, "..", "..", "..", "..", "server", "routes", "narrators.ts"),
		"utf8",
	);

	it("is written as a model-visible user message, not a display-only card", () => {
		// The row IS the request the model has to answer, so it must be in the history the
		// moment it lands. A `disp` row would need the text delivered separately, which is
		// what put the same findings on screen twice.
		expect(HANDLER).toContain("persistUserMessage");
		expect(HANDLER).not.toContain("persistDisplayMessage");
		// Attributed to the reviewer rather than to the reader, who did not write it.
		expect(HANDLER).toContain('origin: "system"');
	});

	it("carries both projections on one row: text for the model, the card for the reader", () => {
		expect(HANDLER).toContain('{ type: "text", text: feedbackText }');
		expect(HANDLER).toContain('type: "review_feedback"');
	});

	it("needs no delivery mechanism for a running narrator", () => {
		// The full history is rebuilt on every request, so the next pass sees the row. The
		// buffer queue / soft-stop path this replaced was both unnecessary and unable to keep
		// the row's attribution.
		expect(HANDLER).not.toContain("pushBufferedMessage");
		expect(HANDLER).not.toContain("requestBufferedMessageSoftStop");
	});

	it("the button starts a loop over that history instead of writing anything", () => {
		const apply = ROUTE.slice(ROUTE.indexOf('narratorRoutes.post("/:id/review-feedback'));
		const body = apply.slice(0, apply.indexOf("\n});"));
		expect(body).toContain("startInjectionContinuationIfPossible");
		expect(body).not.toContain("persistUserMessage");
		expect(body).not.toContain("sendMessage(");
	});
});
