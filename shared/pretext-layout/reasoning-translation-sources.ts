import { blockAtIndex, type MessageWithBody } from "../narrator-blocks/message-blocks";
import {
	composeReasoningTranslation,
	getValidReasoningTranslationParts,
	isReasoningTranslationBoundary,
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
	completed?: boolean;
}

interface SourceMessage extends MessageWithBody<SourceElement> {
	id?: string;
	narratorId?: string | null;
}

type SourceEntry = { index: number; block: SourceElement };

export function reasoningBlockDisplayText(block: SourceElement): string | undefined | null {
	const source = block.thinking ?? block.text ?? "";
	if (!source.length) return null;
	return block.translationGeneration !== undefined || block.translationParts !== undefined
		? composeReasoningTranslation(source, block.translationGeneration, block.translationParts)
		: block.translatedText;
}

/** Keep the original named-block identity when adjacent reasoning is rendered as one run. */
export function reasoningTranslationSources(
	message: SourceMessage,
	entries: readonly SourceEntry[],
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
		const holder = blockAtIndex(message, index);
		if (!holder?.named || !isReasoningTranslationId(holder.id)) continue;
		const end =
			holder.phase === "done"
				? source.length
				: holder.phase === "open" && block.completed === false
					? block.sealedReasoningLength
					: 0;
		if (!end || !isReasoningTranslationBoundary(source, end)) continue;
		let offset = 0;
		for (const part of getValidReasoningTranslationParts(
			source,
			block.translationGeneration,
			block.translationParts,
		)) {
			if (part.start !== offset) break;
			offset = part.end;
		}
		if (offset >= end) continue;
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

const MAX_EVIDENCE_CHARS = 64 * 1024;

export interface ReasoningTranslationEvidence {
	source: string;
	display?: string;
	target?: ReasoningTranslationVisibilityTarget;
}

function normalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** Include ineligible blocks in matching so their repeated text can't prove visibility. */
export function mergedReasoningTranslationEvidence(
	message: SourceMessage,
	entries: readonly SourceEntry[],
): ReasoningTranslationEvidence[] | undefined {
	if (entries.length > 64) return;
	const evidence: ReasoningTranslationEvidence[] = [];
	let chars = 0;
	let targets = 0;
	for (const entry of entries) {
		const source = entry.block.thinking ?? entry.block.text ?? "";
		chars += source.length;
		if (chars > MAX_EVIDENCE_CHARS) return;
		if (!source.trim()) continue;
		const display = reasoningBlockDisplayText(entry.block);
		chars += display?.length ?? 0;
		if (chars > MAX_EVIDENCE_CHARS) return;
		const target =
			targets < MAX_REASONING_TRANSLATION_VISIBLE_TARGETS
				? reasoningTranslationSources(message, [entry])[0]
				: undefined;
		if (target) targets++;
		evidence.push({
			source: normalized(source),
			display: display ? normalized(display) : undefined,
			target,
		});
	}
	if (targets) return evidence;
}

/** Ambiguous lines and rendered fragments that have no exact source match fail closed. */
export function reasoningTranslationTargetForLine(
	evidence: readonly ReasoningTranslationEvidence[],
	text: string,
): ReasoningTranslationVisibilityTarget | undefined {
	if (text.length > 512) return;
	const line = normalized(text);
	if (!line) return;
	let match: ReasoningTranslationEvidence | undefined;
	for (const entry of evidence) {
		if (!entry.source.includes(line) && !entry.display?.includes(line)) continue;
		if (match) return;
		match = entry;
	}
	return match?.target;
}
