/**
 * vlist-jump-window.ts — Can the loaded window reach a jump target yet?
 *
 * The exact list loads the newest page and extends UPWARD only (see
 * pretext-document-loader). A jump (search hit, deep link, compact marker) may
 * therefore point at a message far above the loaded window, in which case the
 * only way to reveal it is to keep pulling older pages until the window covers
 * its seq.
 *
 * This is the decision that loop needs, kept as a pure function so the rule set
 * — "in the window", "page again", "give up, and why" — is testable without a
 * document, a coordinator or a DOM. The shell owns the paging and the scrolling;
 * this module owns nothing but the arithmetic.
 *
 * `seq` here is the narrator's TOP-LEVEL ref seq, the same coordinate
 * `getMessageLocation` returns and `oldestLoadedSeq` tracks, so "loaded" is
 * exactly `targetSeq >= oldestLoadedSeq`.
 */

/**
 * How many older pages one jump may pull.
 *
 * Each page is a fetch plus a layout rebuild of the (growing) loaded window, so
 * an unbounded loop would let a single click freeze the list for minutes on a
 * long history. At the 100-message transport page size this covers ~6000
 * messages of history, which is past every narrator measured, and the bound is
 * what turns "the UI hung" into "a message you can act on".
 */
export const JUMP_MAX_OLDER_PAGES = 60;

export type JumpWindowDecision =
	/** The target's seq is inside the loaded window; reveal it directly. */
	| { kind: "in-window" }
	/** Pull one more older page, then ask again. */
	| { kind: "expand" }
	/**
	 * No amount of further paging can reach it: either the document has no older
	 * history left, or this jump has spent its page budget.
	 */
	| { kind: "unreachable"; reason: "no-older-history" | "budget-exhausted" };

export interface JumpWindowInput {
	/** Top-level ref seq of the message being jumped to. */
	targetSeq: number;
	/** Smallest loaded top-level seq, or null when nothing is loaded yet. */
	oldestLoadedSeq: number | null;
	/** Older messages exist above the loaded window. */
	hasPrev: boolean;
	/** Older pages already pulled for THIS jump. */
	expansions: number;
	maxExpansions?: number;
}

export function resolveJumpWindowDecision(input: JumpWindowInput): JumpWindowDecision {
	const maxExpansions = input.maxExpansions ?? JUMP_MAX_OLDER_PAGES;
	// An empty window is not "covered by" anything: only paging can help, and only
	// while the document says there is something above.
	if (input.oldestLoadedSeq != null && input.targetSeq >= input.oldestLoadedSeq)
		return { kind: "in-window" };
	if (!input.hasPrev) return { kind: "unreachable", reason: "no-older-history" };
	if (input.expansions >= maxExpansions) return { kind: "unreachable", reason: "budget-exhausted" };
	return { kind: "expand" };
}
