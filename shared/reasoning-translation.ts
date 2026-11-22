/** A display-only translation of an exact UTF-16 half-open source range. */
export interface ReasoningTranslationPart {
	id: string;
	generation: string;
	start: number;
	end: number;
	sourceText: string;
	translatedText: string;
}

export interface ReasoningTranslationFields {
	/** Display hint for an open checkpoint; server activity authorizes its source. */
	sealedReasoningLength?: number;
	/** Appending source preserves the generation; replacing source does not. */
	translationGeneration?: string;
	translationParts?: ReasoningTranslationPart[];
}

export interface ReasoningTranslationPatch {
	type: "reasoning_translation_patch";
	narratorId: string;
	ownerNarratorId: string;
	messageId: string;
	blockId: string;
	elementId: string;
	blockRevision: number;
	stateRevision: number;
	translationGeneration: string;
	part: ReasoningTranslationPart;
}

export interface ReasoningTranslationVisibilityTarget {
	ownerNarratorId: string;
	messageId: string;
	blockId: string;
	blockRevision: number;
	elementId: string;
}

export const MAX_REASONING_TRANSLATION_VISIBLE_TARGETS = 16;

export interface ReasoningTranslationVisibilityReport {
	type: "reasoning_translation_visibility";
	narratorId: string;
	visibilityId: string;
	targets: ReasoningTranslationVisibilityTarget[];
}

export type ReasoningTranslationStatus = "queued" | "running" | "idle" | "deferred";

export interface ReasoningTranslationStatusFrame {
	type: "reasoning_translation_status";
	narratorId: string;
	visibilityId: string;
	target: ReasoningTranslationVisibilityTarget;
	status: ReasoningTranslationStatus;
}

export function reasoningTranslationTargetKey(
	target: ReasoningTranslationVisibilityTarget,
): string {
	return JSON.stringify([
		target.ownerNarratorId,
		target.messageId,
		target.blockId,
		target.blockRevision,
		target.elementId,
	]);
}

export function readReasoningTranslationStatus(
	value: unknown,
): ReasoningTranslationStatusFrame | null {
	if (!value || typeof value !== "object") return null;
	const frame = value as ReasoningTranslationStatusFrame;
	const target = frame.target;
	if (
		frame.type !== "reasoning_translation_status" ||
		!isReasoningTranslationId(frame.narratorId) ||
		!isReasoningTranslationId(frame.visibilityId) ||
		(frame.status !== "queued" &&
			frame.status !== "running" &&
			frame.status !== "idle" &&
			frame.status !== "deferred") ||
		!target ||
		typeof target !== "object" ||
		![target.ownerNarratorId, target.messageId, target.blockId, target.elementId].every(
			isReasoningTranslationId,
		) ||
		!Number.isSafeInteger(target.blockRevision) ||
		target.blockRevision < 0
	)
		return null;
	return frame;
}

export const MAX_REASONING_TRANSLATION_ID_LENGTH = 256;
export const MAX_REASONING_TRANSLATION_SOURCE_BYTES = 32 * 1024;
export const MAX_REASONING_TRANSLATION_OUTPUT_BYTES = 64 * 1024;

export function isReasoningTranslationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_REASONING_TRANSLATION_ID_LENGTH
	);
}

export function isReasoningTranslationBoundary(text: string, offset: number): boolean {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
	if (offset === 0 || offset === text.length) return true;
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Normalize and bound a wire patch before it can enter a retained client queue. */
export function readReasoningTranslationPatch(value: unknown): ReasoningTranslationPatch | null {
	if (!value || typeof value !== "object") return null;
	const frame = value as ReasoningTranslationPatch;
	if (
		frame.type !== "reasoning_translation_patch" ||
		![
			frame.narratorId,
			frame.ownerNarratorId,
			frame.messageId,
			frame.blockId,
			frame.elementId,
			frame.translationGeneration,
		].every(isReasoningTranslationId) ||
		![frame.blockRevision, frame.stateRevision].every(
			(rev) => Number.isSafeInteger(rev) && rev >= 0,
		)
	)
		return null;
	const part = frame.part;
	if (
		!part ||
		typeof part !== "object" ||
		typeof part.sourceText !== "string" ||
		!Number.isSafeInteger(part.start) ||
		part.start < 0 ||
		!Number.isSafeInteger(part.end) ||
		part.end - part.start !== part.sourceText.length ||
		!getValidReasoningTranslationParts(part.sourceText, frame.translationGeneration, [
			{ ...part, start: 0, end: part.sourceText.length },
		]).length
	)
		return null;
	return {
		type: frame.type,
		narratorId: frame.narratorId,
		ownerNarratorId: frame.ownerNarratorId,
		messageId: frame.messageId,
		blockId: frame.blockId,
		elementId: frame.elementId,
		blockRevision: frame.blockRevision,
		stateRevision: frame.stateRevision,
		translationGeneration: frame.translationGeneration,
		part: {
			id: part.id,
			generation: part.generation,
			start: part.start,
			end: part.end,
			sourceText: part.sourceText,
			translatedText: part.translatedText,
		},
	};
}

/** Discard stale or ambiguous ranges; accepted ranges never overlap. */
export function getValidReasoningTranslationParts(
	text: string,
	generation: string | undefined,
	parts: readonly ReasoningTranslationPart[] | undefined,
): ReasoningTranslationPart[] {
	if (!isReasoningTranslationId(generation) || !Array.isArray(parts)) return [];
	const encoder = new TextEncoder();
	const candidates = parts.filter(
		(part): part is ReasoningTranslationPart =>
			part != null &&
			isReasoningTranslationId(part.id) &&
			part.generation === generation &&
			typeof part.sourceText === "string" &&
			typeof part.translatedText === "string" &&
			part.sourceText.length <= MAX_REASONING_TRANSLATION_SOURCE_BYTES &&
			part.translatedText.length <= MAX_REASONING_TRANSLATION_OUTPUT_BYTES &&
			part.translatedText.trim().length > 0 &&
			part.start < part.end &&
			part.end - part.start === part.sourceText.length &&
			isReasoningTranslationBoundary(text, part.start) &&
			isReasoningTranslationBoundary(text, part.end) &&
			text.slice(part.start, part.end) === part.sourceText &&
			encoder.encode(part.sourceText).byteLength <= MAX_REASONING_TRANSLATION_SOURCE_BYTES &&
			encoder.encode(part.translatedText).byteLength <= MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	);
	candidates.sort(
		(a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const result: ReasoningTranslationPart[] = [];
	const ids = new Set<string>();
	let coveredEnd = 0;
	for (const part of candidates) {
		if (part.start < coveredEnd || ids.has(part.id)) continue;
		result.push(part);
		ids.add(part.id);
		coveredEnd = part.end;
	}
	return result;
}

/** Keep a fragment's original boundary whitespace, including Markdown separators. */
export function preserveReasoningTranslationWhitespace(
	sourceText: string,
	translatedText: string,
): string {
	const leadingLength = sourceText.length - sourceText.trimStart().length;
	if (leadingLength === sourceText.length) return sourceText;
	return (
		sourceText.slice(0, leadingLength) +
		translatedText.trim() +
		sourceText.slice(sourceText.trimEnd().length)
	);
}

/** Null means none of the source was translated. Gaps and the active tail stay original. */
export function composeReasoningTranslation(
	text: string,
	generation: string | undefined,
	parts: readonly ReasoningTranslationPart[] | undefined,
): string | null {
	const valid = getValidReasoningTranslationParts(text, generation, parts);
	if (!valid.length) return null;
	const result: string[] = [];
	let offset = 0;
	for (const part of valid) {
		result.push(
			text.slice(offset, part.start),
			preserveReasoningTranslationWhitespace(part.sourceText, part.translatedText),
		);
		offset = part.end;
	}
	result.push(text.slice(offset));
	return result.join("");
}
