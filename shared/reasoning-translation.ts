/** Author-local live identity, independent of reconnect body retirement. */
export interface ReasoningTranslationActivity {
	elementId: string;
	revision: number;
	/** Durable UTF-16 half-open ranges eligible for translation, independent of display activity. */
	completedRanges: Array<{ start: number; end: number }>;
	/** Original UTF-16 display-tail boundary; only a real content handoff advances it. */
	displayTailStart?: number;
}

export const MAX_REASONING_TRANSLATION_COMPLETED_RANGES = 64;

/** Null is an authoritative clear; omitted protocol fields are handled by callers. */
export function readReasoningTranslationActivity(
	value: unknown,
): ReasoningTranslationActivity | null {
	if (!value || typeof value !== "object") return null;
	const record = value as ReasoningTranslationActivity;
	if (
		!isReasoningTranslationId(record.elementId) ||
		!Number.isSafeInteger(record.revision) ||
		record.revision < 0 ||
		(record.displayTailStart !== undefined &&
			(!Number.isSafeInteger(record.displayTailStart) || record.displayTailStart < 0)) ||
		!Array.isArray(record.completedRanges) ||
		record.completedRanges.length > MAX_REASONING_TRANSLATION_COMPLETED_RANGES
	)
		return null;
	const completedRanges: ReasoningTranslationActivity["completedRanges"] = [];
	let previousEnd = 0;
	for (const range of record.completedRanges) {
		if (
			!range ||
			!Number.isSafeInteger(range.start) ||
			!Number.isSafeInteger(range.end) ||
			range.start < previousEnd ||
			range.start < 0 ||
			range.end <= range.start
		)
			return null;
		completedRanges.push({ start: range.start, end: range.end });
		previousEnd = range.end;
	}
	return {
		elementId: record.elementId,
		revision: record.revision,
		completedRanges,
		...(record.displayTailStart !== undefined ? { displayTailStart: record.displayTailStart } : {}),
	};
}

/** Display-only source translations; never provider reasoning credentials. */
export interface ReasoningTranslationPart {
	id: string;
	generation: string;
	/** UTF-16 half-open offsets in the persisted reasoning text. */
	start: number;
	end: number;
	/** Exact bounded source snapshot, independent of translated text length. */
	sourceText: string;
	translatedText: string;
}

export interface ReasoningTranslationFields {
	/** Append preserves this lineage; non-append rewrites replace it. */
	translationGeneration?: string;
	/** Frozen with the generation; viewers never choose a different cache language. */
	translationLocale?: string;
	translationParts?: ReasoningTranslationPart[];
}

/** Persisted source identity, not a rendered/merged run or a streaming placeholder. */
export interface ReasoningTranslationVisibilityTarget {
	ownerNarratorId: string;
	messageId: string;
	blockId: string;
	elementId?: string;
	/** Original message content-array position for an element without an ID. */
	legacyIndex?: number;
	/** Body/block revision accompanying that positional identity. */
	legacyVersion?: number;
}

export interface ReasoningTranslationVisibilityGroup {
	groupId: string;
	anchor: ReasoningTranslationVisibilityTarget;
	targetIndexes: number[];
}

export type ReasoningTranslationState = "queued" | "running" | "idle";

export interface ReasoningTranslationStatus {
	type: "reasoning_translation_status";
	narratorId: string;
	visibilityId: string;
	revision: number;
	groups: Array<{ groupId: string; state: ReasoningTranslationState }>;
}

export interface ReasoningTranslationVisibilityMessage {
	type: "reasoning_translation_visibility";
	/** Authorized displayed transcript, including its authorized child scope. */
	narratorId: string;
	/** Stable per visible demand holder within this connection. */
	visibilityId: string;
	/** Complete replacement; an empty array releases this holder. */
	targets: ReasoningTranslationVisibilityTarget[];
	groups?: ReasoningTranslationVisibilityGroup[];
	revision?: number;
}

export const REASONING_TRANSLATION_VISIBILITY_LIMITS = {
	targets: 64,
	holdersPerConnection: 32,
	holders: 512,
	uniqueTargets: 256,
} as const;

/** Identity bounds use UTF-16 code units, matching the completed-part WS protocol. */
export const MAX_REASONING_TRANSLATION_ID_LENGTH = 256;
export const MAX_REASONING_TRANSLATION_SOURCE_BYTES = 32 * 1024;
export const MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES = 16 * 1024;
export const MAX_REASONING_TRANSLATION_OUTPUT_BYTES = 64 * 1024;

/** Applies equally to part IDs and generation IDs; never truncate an identity. */
export function isReasoningTranslationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_REASONING_TRANSLATION_ID_LENGTH
	);
}

/** Strict, bounded connection-local status projection. */
export function readReasoningTranslationStatus(value: unknown): ReasoningTranslationStatus | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.type !== "reasoning_translation_status" ||
		!isReasoningTranslationId(record.narratorId) ||
		typeof record.visibilityId !== "string" ||
		!record.visibilityId.length ||
		record.visibilityId.length > 128 ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision as number) < 0 ||
		!Array.isArray(record.groups) ||
		record.groups.length > REASONING_TRANSLATION_VISIBILITY_LIMITS.targets
	)
		return null;
	const groups: ReasoningTranslationStatus["groups"] = [];
	const ids = new Set<string>();
	for (const item of record.groups) {
		if (
			!item ||
			typeof item !== "object" ||
			!isReasoningTranslationId(item.groupId) ||
			ids.has(item.groupId) ||
			!["queued", "running", "idle"].includes(item.state)
		)
			return null;
		ids.add(item.groupId);
		groups.push({ groupId: item.groupId, state: item.state });
	}
	return {
		type: "reasoning_translation_status",
		narratorId: record.narratorId,
		visibilityId: record.visibilityId,
		revision: record.revision as number,
		groups,
	};
}

/** A provider summary seal addresses the normalized emitted item, not replay items. */
export interface ReasoningSummaryPartBoundary {
	id: string;
	index: number;
	/** UTF-16 half-open offsets after the parser's summary separators. */
	start: number;
	end: number;
}

/** A completed part addressed to the existing persistent block and source element. */
export interface ReasoningTranslationPatch {
	narratorId: string;
	ownerNarratorId: string;
	messageId: string;
	blockId: string;
	elementId: string;
	/** Body revision, independent of the envelope's state revision. */
	blockRevision: number;
	stateRevision: number;
	translationGeneration: string;
	part: ReasoningTranslationPart;
	parentToolUseId?: string;
	subagentNarratorId?: string;
}

/** UTF-16 boundaries must not split a Unicode surrogate pair. */
export function isReasoningTranslationBoundary(text: string, offset: number): boolean {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
	if (offset === 0 || offset === text.length) return true;
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Validate persisted/transport data without server imports or length guesses. */
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
			typeof part === "object" &&
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

/** Preserve accepted parts, reject conflicting IDs/ranges, and add independent valid parts. */
export function mergeReasoningTranslationParts(
	text: string,
	generation: string | undefined,
	current: readonly ReasoningTranslationPart[] | undefined,
	incoming: readonly ReasoningTranslationPart[] | undefined,
): ReasoningTranslationPart[] {
	const accepted = getValidReasoningTranslationParts(text, generation, current);
	for (const part of getValidReasoningTranslationParts(text, generation, incoming)) {
		if (
			accepted.some(
				(existing) =>
					existing.id === part.id || (existing.start < part.end && part.start < existing.end),
			)
		)
			continue;
		accepted.push(part);
	}
	return accepted.sort((a, b) => a.start - b.start);
}

/** Decode a bounded completed-part frame; source coordinates are checked again against the row. */
export function readReasoningTranslationPatch(value: unknown): ReasoningTranslationPatch | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key of [
		"narratorId",
		"ownerNarratorId",
		"messageId",
		"blockId",
		"elementId",
		"translationGeneration",
	]) {
		if (!isReasoningTranslationId(record[key])) return null;
	}
	for (const key of ["blockRevision", "stateRevision"]) {
		if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) return null;
	}
	const input = record.part as ReasoningTranslationPart | null;
	if (
		!input ||
		typeof input !== "object" ||
		!isReasoningTranslationId(input.id) ||
		input.generation !== record.translationGeneration ||
		typeof input.sourceText !== "string" ||
		input.sourceText.length > MAX_REASONING_TRANSLATION_SOURCE_BYTES ||
		typeof input.translatedText !== "string" ||
		input.translatedText.length > MAX_REASONING_TRANSLATION_OUTPUT_BYTES ||
		!Number.isSafeInteger(input.start) ||
		input.start < 0 ||
		!Number.isSafeInteger(input.end) ||
		input.end - input.start !== input.sourceText.length
	)
		return null;
	// Do not enumerate or retain transport fields beyond the bounded canonical part.
	const part: ReasoningTranslationPart = {
		id: input.id,
		generation: input.generation,
		start: input.start,
		end: input.end,
		sourceText: input.sourceText,
		translatedText: input.translatedText,
	};
	if (
		getValidReasoningTranslationParts(part.sourceText, record.translationGeneration as string, [
			{ ...part, start: 0, end: part.sourceText.length },
		]).length !== 1
	)
		return null;
	for (const key of ["parentToolUseId", "subagentNarratorId"]) {
		if (record[key] !== undefined && !isReasoningTranslationId(record[key])) return null;
	}
	return {
		narratorId: record.narratorId as string,
		ownerNarratorId: record.ownerNarratorId as string,
		messageId: record.messageId as string,
		blockId: record.blockId as string,
		elementId: record.elementId as string,
		blockRevision: record.blockRevision as number,
		stateRevision: record.stateRevision as number,
		translationGeneration: record.translationGeneration as string,
		part,
		...(record.parentToolUseId ? { parentToolUseId: record.parentToolUseId as string } : {}),
		...(record.subagentNarratorId
			? { subagentNarratorId: record.subagentNarratorId as string }
			: {}),
	};
}

/** Source owns separators between fragments; translated output owns only their body. */
export function preserveReasoningTranslationWhitespace(
	sourceText: string,
	translatedText: string,
): string {
	const leadingLength = sourceText.length - sourceText.trimStart().length;
	if (leadingLength === sourceText.length) return sourceText;
	const leading = sourceText.slice(0, leadingLength);
	const trailing = sourceText.slice(sourceText.trimEnd().length);
	return `${leading}${translatedText.trim()}${trailing}`;
}

/** Keep every untranslated source character, including gaps and the live tail. */
export function composeReasoningTranslation(
	text: string,
	generation: string | undefined,
	parts: readonly ReasoningTranslationPart[] | undefined,
): string {
	const valid = getValidReasoningTranslationParts(text, generation, parts);
	if (!valid.length) return text;
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
