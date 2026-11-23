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
	start: number;
	end: number;
	step?: number;
	target: ReasoningTranslationVisibilityTarget;
}

/** These are offsets in the exact string produced by the adapter's two-newline join. */
export function mergedReasoningTranslationEvidence(
	message: SourceMessage,
	entries: readonly SourceEntry[],
	showOriginal = false,
): ReasoningTranslationEvidence[] | undefined {
	if (entries.length > 64) return;
	const evidence: ReasoningTranslationEvidence[] = [];
	let chars = 0;
	let end = 0;
	for (const entry of entries) {
		const source = entry.block.thinking ?? entry.block.text ?? "";
		if (!source.length) continue;
		chars += source.length;
		if (chars > MAX_EVIDENCE_CHARS) return;
		const display = reasoningBlockDisplayText(entry.block);
		chars += display?.length ?? 0;
		if (chars > MAX_EVIDENCE_CHARS) return;
		const start = end ? end + 2 : 0;
		end = start + (showOriginal ? source : display || source).length;
		const target =
			evidence.length < MAX_REASONING_TRANSLATION_VISIBLE_TARGETS
				? reasoningTranslationSources(message, [entry])[0]
				: undefined;
		if (target) evidence.push({ start, end, target });
	}
	if (evidence.length) return evidence;
}

/** Map an expanded step's reconstructed paragraph back into the run. */
export function appendReasoningTranslationParagraph(
	evidence: readonly ReasoningTranslationEvidence[],
	result: ReasoningTranslationEvidence[],
	step: number,
	bodyStart: number,
	runStart: number,
	length: number,
): void {
	for (const { start, end, target } of evidence) {
		const from = Math.max(runStart, start);
		const to = Math.min(runStart + length, end);
		if (from >= to) continue;
		const startInBody = bodyStart + from - runStart;
		const endInBody = bodyStart + to - runStart;
		const previous = result.at(-1);
		if (previous?.step === step && previous.target === target && previous.end + 2 === startInBody)
			previous.end = endInBody;
		else result.push({ step, start: startInBody, end: endInBody, target });
	}
}

/** A Markdown token spanning multiple source owners cannot prove visibility for either. */
export function reasoningTranslationTargetForRange(
	evidence: readonly ReasoningTranslationEvidence[],
	start: number,
	end: number,
	step?: number,
): ReasoningTranslationVisibilityTarget | undefined {
	if (start >= end) return;
	return evidence.find((entry) => entry.step === step && start >= entry.start && end <= entry.end)
		?.target;
}
