/**
 * streaming-handoff.ts — Decides when the live streaming row has been SUPERSEDED
 * by a persisted message, so it can be dropped in the same commit that brings the
 * real one in.
 *
 * What this replaces
 * ------------------
 * The streaming output used to be an overlay below the canvas, retired by a
 * handshake: on a persisted `assistant` message the overlay recorded a "pending
 * retirement" and waited for that message id to appear in the committed document,
 * with a 3s timeout as a backstop.
 *
 * That handshake had a hole. While the reader is scrolled up, a structural reload
 * is deliberately DEFERRED, so the awaited id can never appear — and the 3s
 * backstop then fired and cleared the overlay while the real card still was not
 * loaded. Live output simply vanished until the reader scrolled back down. The
 * timeout was written for a failed reload; a deferred one took the same branch.
 *
 * Now the streaming row lives IN the document, so the question is no longer "may I
 * clear the overlay yet" but the much simpler, purely structural "does the document
 * already contain this content". No clock is involved, so there is no state in which
 * output is neither in the document nor in the overlay.
 *
 * Pure: no React, no DOM, no timers.
 */

/** The subset of a message this module needs. */
export interface HandoffMessage {
	id?: unknown;
	role?: unknown;
	parentToolUseId?: unknown;
	contentJson?: unknown;
	toolCalls?: unknown;
	/**
	 * Child messages. Not read by the hand-off itself (which only judges the
	 * top level), but the PER-TOOL half walks them — a subagent page renders its
	 * own children as top-level cards, so a child can be the persisted owner of a
	 * live tool id (see collectPersistedToolUseIds).
	 */
	children?: readonly unknown[];
}

/** Id of the synthetic streaming message (shared with buildStreamingMsg). */
export const STREAMING_MESSAGE_ID = "__streaming__";

/**
 * Signature of the committed document's GROWTH.
 *
 * The "text since the last commit" counter must reset when the document GAINS a
 * message, and only then. Watching the messages ARRAY IDENTITY for that is wrong:
 * every live lifecycle patch (a tool finishing, a permission decided, a reflection
 * gate advancing — all routine mid-turn events) rebuilds the array to patch a field
 * in place, without adding anything. Resetting on those defeats the multi-step
 * protection in `isStreamingMessageSuperseded`: the counter drops to 0, an
 * already-stored earlier step then looks like this row's replacement, and the live
 * SECOND step is retired although it was never persisted — the output simply
 * vanishes.
 *
 * Length plus the newest id captures exactly the growth: an in-place patch changes
 * neither, while an append, a reload and an edit all change one of them.
 * Trailing synthetic rows are ignored so a published streaming row cannot mask the
 * persisted tail.
 */
export function commitGrowthSignature(messages: readonly HandoffMessage[]): string {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.id === STREAMING_MESSAGE_ID) index--;
	const last = messages[index];
	const id = typeof last?.id === "string" ? last.id : "";
	return `${index + 1}:${id}`;
}

/**
 * Tool-use ids carried by a message, in order.
 *
 * The streaming row and its persisted counterpart are matched on these rather than
 * on text: text is still arriving when the message persists (the last delta may
 * land after it), while a tool_use id is assigned by the provider and is identical
 * on both sides.
 */
function toolUseIds(message: HandoffMessage): string[] {
	const ids: string[] = [];
	const calls = message.toolCalls;
	if (Array.isArray(calls)) {
		for (const call of calls) {
			const id = (call as { toolUseId?: unknown } | null)?.toolUseId;
			if (typeof id === "string" && id.length > 0) ids.push(id);
		}
	}
	if (ids.length > 0) return ids;
	const blocks = message.contentJson;
	if (Array.isArray(blocks)) {
		for (const block of blocks) {
			const candidate = block as { type?: unknown; id?: unknown } | null;
			if (candidate?.type !== "tool_use") continue;
			if (typeof candidate.id === "string" && candidate.id.length > 0) ids.push(candidate.id);
		}
	}
	return ids;
}

/** True when the message is a top-level assistant message (the streaming kind). */
function isTopLevelAssistant(message: HandoffMessage): boolean {
	return message.role === "assistant" && !message.parentToolUseId;
}

export interface StreamingHandoffInput {
	/** The live streaming row, if one is currently published. */
	streamingMessage: HandoffMessage | null | undefined;
	/** Persisted top-level messages of the committed document. */
	committedMessages: readonly HandoffMessage[];
	/**
	 * Text this row has accumulated SINCE the newest committed message arrived.
	 *
	 * This is what distinguishes "the reply is now stored" from "the model has moved
	 * on to a new paragraph after an earlier step was stored". A turn commonly persists
	 * several messages (text → tool → more text), so a trailing assistant message is
	 * NOT by itself proof that the live text is redundant — during a multi-step turn it
	 * is usually proof of the opposite.
	 *
	 * Absent → treated as 0, i.e. the conservative "nothing new since" reading.
	 */
	charsSinceLastCommit?: number;
}

/**
 * Whether the streaming row is now redundant with the committed document.
 *
 * Only ONE whole-row signal remains: a **text-only** live row whose content has
 * demonstrably been stored (trailing top-level assistant with renderable body,
 * and nothing new streamed since that commit).
 *
 * Tool-bearing rows are NEVER retired here.
 *
 * A persisted `tool_use` id is not proof that this live row's reasoning / answer
 * text / later tools are already on screen. Progressive persistence writes the
 * first tool of a turn into the same partial assistant message while the live row
 * still owns the rest (`reasoning → text → tool1 → tool2`); clearing the whole row
 * on `tool1`'s id wiped reasoning and text together with the still-running tool2,
 * and they only reappeared after the next tool finished and something reloaded the
 * DB row. Per-tool and per-block hand-offs already retire exactly what the document
 * demonstrably contains (`dropPersistedStreamingTools`,
 * `dropSupersededStreamingBlocks`) — that is the structural replacement for a
 * whole-row clear on tool identity.
 *
 * A row still streaming its FIRST tokens (empty content) is never retired — there
 * would be nothing to show in its place.
 */
export function isStreamingMessageSuperseded(input: StreamingHandoffInput): boolean {
	const streaming = input.streamingMessage;
	if (!streaming) return false;

	// Tool-bearing live rows stay until their individual blocks/tools are superseded
	// or the session leaves working/waiting. See the module comment above.
	if (toolUseIds(streaming).length > 0) return false;

	// Text-only rows have no ids to match on, so the only available signal is the
	// document's last persisted message — plus whether this row has produced anything
	// SINCE it landed.
	//
	// Requiring "nothing new since the last commit" is what makes a multi-step turn
	// safe. A turn persists text, then a tool, then more text; without this check the
	// already-stored first step would retire the live SECOND step, and that output was
	// never in the document — it simply vanished, and never appeared in history.
	if ((input.charsSinceLastCommit ?? 0) > 0) return false;
	for (let index = input.committedMessages.length - 1; index >= 0; index--) {
		const message = input.committedMessages[index];
		if (!message || message.id === STREAMING_MESSAGE_ID) continue;
		if (!isTopLevelAssistant(message)) return false;
		return hasRenderableContent(message);
	}
	return false;
}

/**
 * True when a message carries something to render (text or tool calls).
 *
 * An assistant message that persisted EMPTY (a discarded reasoning-only turn) must
 * not retire the streaming row: it would take live text off screen and put nothing
 * in its place.
 */
function hasRenderableContent(message: HandoffMessage): boolean {
	if (toolUseIds(message).length > 0) return true;
	const blocks = message.contentJson;
	if (!Array.isArray(blocks)) return false;
	for (const block of blocks) {
		const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown } | null;
		if (!candidate) continue;
		if (typeof candidate.text === "string" && candidate.text.trim().length > 0) return true;
		if (typeof candidate.thinking === "string" && candidate.thinking.trim().length > 0) return true;
	}
	return false;
}
