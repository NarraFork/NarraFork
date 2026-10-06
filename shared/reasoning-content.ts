export interface ReasoningContentMessageLike {
	role?: unknown;
	contentJson?: unknown;
	toolCalls?: unknown;
}

/**
 * Same shape plus `contentText`, which providers use as the text fallback when
 * `contentJson` carries no text block. A record with text there is NOT
 * reasoning-only, so the dangling-tail check must see it.
 */
export interface ReasoningTailMessageLike extends ReasoningContentMessageLike {
	contentText?: unknown;
}

function asContentBlock(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** True when a reasoning/thinking block carries no visible reasoning text. */
export function isEmptyReasoningBlock(value: unknown): boolean {
	const block = asContentBlock(value);
	if (!block || (block.type !== "reasoning" && block.type !== "thinking")) return false;
	const text = block.type === "thinking" ? block.thinking : block.text;
	return typeof text !== "string" || text.trim().length === 0;
}

function isBlankTextBlock(value: unknown): boolean {
	const block = asContentBlock(value);
	return (
		block?.type === "text" && (typeof block.text !== "string" || block.text.trim().length === 0)
	);
}

/**
 * True for an assistant record that contains only metadata-only empty reasoning
 * (plus optional blank text) and has no persisted tool calls.
 *
 * These records remain in the database for audit/display compatibility, but they
 * must not become a model-history boundary or hide a preceding tool-result turn.
 */
export function isMetadataOnlyEmptyReasoningAssistantMessage(
	message: ReasoningContentMessageLike,
): boolean {
	if (message.role !== "assistant") return false;
	if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return false;
	if (!Array.isArray(message.contentJson) || message.contentJson.length === 0) return false;

	let hasEmptyReasoning = false;
	for (const block of message.contentJson) {
		if (isEmptyReasoningBlock(block)) {
			hasEmptyReasoning = true;
			continue;
		}
		if (isBlankTextBlock(block)) continue;
		return false;
	}
	return hasEmptyReasoning;
}

/** True for a reasoning/thinking block, regardless of whether it carries text. */
function isReasoningBlock(value: unknown): boolean {
	const block = asContentBlock(value);
	return block?.type === "reasoning" || block?.type === "thinking";
}

/**
 * True for an assistant record whose only output is reasoning — no tool calls, no
 * visible answer text.
 *
 * This is what a turn leaves behind when it dies (or is interrupted) after the
 * model streamed its thinking but before it produced an answer or a tool call:
 * `finalizeOrCleanupPartialMessage` keeps the record because the reasoning is
 * meaningful, and strips the unexecuted tool_use blocks.
 *
 * Such a record carries no conversational content for the model to build on, so
 * "continue" must look past it to find the real tail of the turn. Otherwise a
 * preceding assistant turn whose tool results are still pending gets shadowed,
 * and the continuation degrades into a plain "continue" user message that
 * silently abandons those results.
 *
 * Unlike {@link isMetadataOnlyEmptyReasoningAssistantMessage}, this accepts
 * reasoning WITH text: the distinction there is "metadata-only record", here it
 * is "produced nothing to continue from".
 */
export function isDanglingReasoningOnlyAssistantMessage(
	message: ReasoningTailMessageLike,
): boolean {
	if (message.role !== "assistant") return false;
	if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return false;
	// contentText is the provider-side text fallback; any real text there means the
	// turn did answer, so it is not a dangling reasoning tail.
	if (typeof message.contentText === "string" && message.contentText.trim().length > 0) {
		return false;
	}
	if (!Array.isArray(message.contentJson) || message.contentJson.length === 0) return false;

	let hasReasoning = false;
	for (const block of message.contentJson) {
		if (isReasoningBlock(block)) {
			hasReasoning = true;
			continue;
		}
		if (isBlankTextBlock(block)) continue;
		return false;
	}
	return hasReasoning;
}
