/**
 * vlist-tail-meta.ts — Pure replication of ChunkedMessageList's buildChunkTailMeta,
 * operating on a FLAT message list (PretextMessageList already flattens chunks).
 *
 * Derives the tail summary NarratorPanel consumes (retry/continue button state,
 * status bar, spec-tasks spinner): lastRealMessage / lastUserMessageId /
 * contextPercent / turnUsageJson / latestSpecTasksToolUseId, plus pass-through
 * statusReady.
 *
 * Kept pure + DOM-free (findSpecTasksToolUseId injected) so it is unit-testable;
 * the shell injects the real helper from narrator-message-helpers.
 */

/** Structural subset of NarratorMsg this computation needs. */
export interface TailMetaMessage {
	id?: string;
	role: string;
	contextPercent?: number | null;
	turnUsageJson?: unknown;
	contentJson?: Array<{ type?: unknown }>;
}

export interface TailMetaResult {
	statusReady: boolean;
	lastRealMessage: { id: string; role: string } | null;
	lastUserMessageId?: string;
	contextPercent?: number | null;
	turnUsageJson?: unknown;
	latestSpecTasksToolUseId?: string | null;
}

export interface TailMetaOptions {
	statusReady: boolean;
	/** The streaming placeholder message id (excluded from lastRealMessage). */
	streamingMsgId: string;
	/** Injected: latest spec://tasks.json tool-use id over the messages. */
	findSpecTasksToolUseId: (messages: TailMetaMessage[]) => string | null;
}

/** True when a message is a system error card (excluded from lastRealMessage). */
function isErrorSystemMessage(msg: TailMetaMessage): boolean {
	return (
		msg.role === "system" &&
		Array.isArray(msg.contentJson) &&
		msg.contentJson.some((block) => block?.type === "error")
	);
}

/**
 * Build tail meta from a flat, chronologically-ordered message list. Mirrors
 * buildChunkTailMeta: scans tail-first, filling the three derived fields and
 * short-circuiting once all are found.
 */
export function buildTailMeta(
	messages: readonly TailMetaMessage[],
	opts: TailMetaOptions,
): TailMetaResult {
	const latestSpecTasksToolUseId = opts.findSpecTasksToolUseId(messages as TailMetaMessage[]);
	let lastRealMessage: TailMetaResult["lastRealMessage"] = null;
	let lastUserMessageId: string | undefined;
	let contextPercent: number | null | undefined;
	let turnUsageJson: unknown;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		const id = typeof msg.id === "string" ? msg.id : undefined;
		if (!id) continue;
		if (!lastRealMessage && id !== opts.streamingMsgId && !isErrorSystemMessage(msg)) {
			lastRealMessage = { id, role: msg.role };
		}
		if (!lastUserMessageId && msg.role === "user" && !id.startsWith("optimistic-")) {
			lastUserMessageId = id;
		}
		if (contextPercent == null && msg.contextPercent != null) {
			contextPercent = msg.contextPercent;
			turnUsageJson = msg.turnUsageJson ?? null;
		}
		if (lastRealMessage && lastUserMessageId && contextPercent != null) break;
	}

	return {
		statusReady: opts.statusReady,
		lastRealMessage,
		lastUserMessageId,
		contextPercent,
		turnUsageJson,
		latestSpecTasksToolUseId,
	};
}
