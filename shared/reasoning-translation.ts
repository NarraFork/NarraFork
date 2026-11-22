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
	/** Appending source preserves the generation; replacing source does not. */
	translationGeneration?: string;
	translationParts?: ReasoningTranslationPart[];
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
