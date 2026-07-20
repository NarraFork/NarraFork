export interface ReasoningContentMessageLike {
	role?: unknown;
	contentJson?: unknown;
	toolCalls?: unknown;
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
