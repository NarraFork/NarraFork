import {
	CONTEXT_CATEGORIES,
	type ContextCharCache,
	type ContextSegment,
} from "./context-composition";

/** Complete logical model input, excluding binary/opaque and transport-only fields. */
export interface ContextInputCharacters {
	totalChars: number;
	systemChars: number;
	toolsChars: number;
	/** Transient final-request classification; snapshots retain only its paginated pin. */
	compositionSegments?: ContextSegment[] | null;
}

export const MAX_INPUT_COMPOSITION_SEGMENTS = 2048;

/** Allowlist bounded numeric metadata and require exact denominator conservation. */
export function readInputCompositionSegments(
	value: unknown,
	totalChars: number,
): ContextSegment[] | null {
	if (!Array.isArray(value) || value.length > MAX_INPUT_COMPOSITION_SEGMENTS) return null;
	const segments: ContextSegment[] = [];
	let sum = 0;
	for (const item of value) {
		const segment = record(item);
		if (
			!segment ||
			typeof segment.category !== "string" ||
			!CONTEXT_CATEGORIES.includes(segment.category as ContextSegment["category"]) ||
			!characterCount(segment.chars)
		)
			return null;
		sum += segment.chars;
		if (!Number.isSafeInteger(sum) || sum > totalChars) return null;
		if (segment.chars > 0)
			segments.push({
				category: segment.category as ContextSegment["category"],
				chars: segment.chars,
			});
	}
	return sum === totalChars ? segments : null;
}

export type ContextUsageSource = "upstream" | "usage" | "estimate";

/** Occupancy is not billing usage. All members belong to the same logical request. */
export interface ContextUsageSnapshot {
	requestId: string;
	startedAt: string;
	source: ContextUsageSource;
	percentage: number | null;
	contextWindow: number | null;
	occupiedTokens: number | null;
	inputCharacters: ContextInputCharacters | null;
	/** Frozen numeric classification, never a message body. */
	composition: ContextCharCache | null;
}

export const CONTEXT_USAGE_SNAPSHOT_MAX_BYTES = 16 * 1024;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nullableNumber(value: unknown, positive = false): number | null | undefined {
	if (value == null) return null;
	return typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
		? value
		: undefined;
}

function characterCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readInputCharacters(value: unknown): ContextInputCharacters | null {
	const input = record(value);
	if (
		!input ||
		!characterCount(input.totalChars) ||
		!characterCount(input.systemChars) ||
		!characterCount(input.toolsChars)
	)
		return null;
	if (input.systemChars + input.toolsChars > input.totalChars) return null;
	return {
		totalChars: input.totalChars,
		systemChars: input.systemChars,
		toolsChars: input.toolsChars,
	};
}

function readFixedSegments(value: unknown): ContextSegment[] | null {
	if (!Array.isArray(value) || value.length > 3) return null;
	const segments: ContextSegment[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const segment = record(item);
		if (
			!segment ||
			(segment.category !== "system" &&
				segment.category !== "summary" &&
				segment.category !== "toolDefinition") ||
			seen.has(segment.category) ||
			!characterCount(segment.chars)
		)
			return null;
		seen.add(segment.category);
		segments.push({ category: segment.category, chars: segment.chars });
	}
	return segments;
}

function readComposition(value: unknown): ContextCharCache | null {
	const input = record(value);
	if (
		!input ||
		!boundedString(input.generation, 128) ||
		!boundedString(input.revision, 512) ||
		!characterCount(input.pageCount) ||
		!characterCount(input.totalChars) ||
		!Array.isArray(input.totals) ||
		input.totals.length > CONTEXT_CATEGORIES.length
	)
		return null;
	const totals: ContextSegment[] = [];
	const seen = new Set<string>();
	let totalChars = 0;
	for (const item of input.totals) {
		const segment = record(item);
		if (
			!segment ||
			typeof segment.category !== "string" ||
			!CONTEXT_CATEGORIES.includes(segment.category as ContextSegment["category"]) ||
			seen.has(segment.category) ||
			!characterCount(segment.chars)
		)
			return null;
		seen.add(segment.category);
		totalChars += segment.chars;
		totals.push({ category: segment.category as ContextSegment["category"], chars: segment.chars });
	}
	if (!Number.isSafeInteger(totalChars) || totalChars !== input.totalChars) return null;
	let fixedPrefix: ContextCharCache["fixedPrefix"];
	if (input.fixedPrefix != null) {
		const prefix = record(input.fixedPrefix);
		const previous = readFixedSegments(prefix?.previous);
		const current = readFixedSegments(prefix?.current);
		if (
			!previous ||
			!current ||
			current.reduce((sum, segment) => sum + segment.chars, 0) > totalChars
		)
			return null;
		fixedPrefix = { previous, current };
	}
	return {
		generation: input.generation,
		revision: input.revision,
		pageCount: input.pageCount,
		totalChars,
		totals,
		...(fixedPrefix ? { fixedPrefix } : {}),
	};
}

/** Bounded, allowlisted numeric metadata only; unknown body fields are never propagated. */
export function parseContextUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
	if (typeof value === "string") {
		if (
			value.length > CONTEXT_USAGE_SNAPSHOT_MAX_BYTES ||
			new TextEncoder().encode(value).byteLength > CONTEXT_USAGE_SNAPSHOT_MAX_BYTES
		)
			return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const input = record(value);
	if (
		!input ||
		!boundedString(input.requestId, 128) ||
		!boundedString(input.startedAt, 64) ||
		!Number.isFinite(Date.parse(input.startedAt)) ||
		(input.source !== "upstream" && input.source !== "usage" && input.source !== "estimate")
	)
		return null;
	const percentage = nullableNumber(input.percentage);
	const contextWindow = nullableNumber(input.contextWindow, true);
	const occupiedTokens = nullableNumber(input.occupiedTokens);
	if (percentage === undefined || contextWindow === undefined || occupiedTokens === undefined)
		return null;
	const inputCharacters =
		input.inputCharacters == null ? null : readInputCharacters(input.inputCharacters);
	const composition = input.composition == null ? null : readComposition(input.composition);
	if (
		(input.inputCharacters != null && !inputCharacters) ||
		(input.composition != null && !composition)
	)
		return null;
	return {
		requestId: input.requestId,
		startedAt: input.startedAt,
		source: input.source,
		percentage,
		contextWindow,
		occupiedTokens,
		inputCharacters,
		composition,
	};
}
