import { blockAtIndex, type MessageWithBody } from "../narrator-blocks/message-blocks";
import {
	getValidReasoningTranslationParts,
	isReasoningTranslationId,
	MAX_REASONING_TRANSLATION_VISIBLE_TARGETS,
	type ReasoningTranslationFields,
	type ReasoningTranslationVisibilityTarget,
} from "../reasoning-translation";

interface SourceElement extends ReasoningTranslationFields {
	type: string;
	id?: unknown;
	text?: string | null;
	thinking?: string | null;
	translatedText?: string | null;
}

interface SourceMessage extends MessageWithBody<SourceElement> {
	id?: string;
	narratorId?: string | null;
}

/** Keep the original named-block identity when adjacent reasoning is rendered as one run. */
export function reasoningTranslationSources(
	message: SourceMessage,
	entries: readonly { index: number; block: SourceElement }[],
): ReasoningTranslationVisibilityTarget[] {
	const { id: messageId, narratorId: ownerNarratorId } = message;
	if (!isReasoningTranslationId(messageId) || !isReasoningTranslationId(ownerNarratorId)) return [];
	const targets: ReasoningTranslationVisibilityTarget[] = [];
	if (entries.length > 256) return targets;
	for (const { index, block } of entries) {
		const source = block.thinking ?? block.text;
		if (
			(block.type !== "reasoning" && block.type !== "thinking") ||
			!isReasoningTranslationId(block.id) ||
			!source ||
			block.translatedText
		)
			continue;
		let offset = 0;
		for (const part of getValidReasoningTranslationParts(
			source,
			block.translationGeneration,
			block.translationParts,
		)) {
			if (part.start !== offset) break;
			offset = part.end;
		}
		if (offset === source.length) continue;
		const holder = blockAtIndex(message, index);
		if (!holder?.named || holder.phase !== "done" || !isReasoningTranslationId(holder.id)) continue;
		targets.push({
			ownerNarratorId,
			messageId,
			blockId: holder.id,
			blockRevision: holder.revision,
			elementId: block.id,
		});
		if (targets.length >= MAX_REASONING_TRANSLATION_VISIBLE_TARGETS) break;
	}
	return targets;
}
