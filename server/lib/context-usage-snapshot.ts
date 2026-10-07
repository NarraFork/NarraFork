import type { ContextCharCache } from "@shared/context-composition";
import {
	CONTEXT_USAGE_SNAPSHOT_MAX_BYTES,
	type ContextInputCharacters,
	type ContextUsageSnapshot,
	parseContextUsageSnapshot,
	readInputCompositionSegments,
} from "@shared/context-usage";

export function validInputCharacters(
	value: ContextInputCharacters | null,
): ContextInputCharacters | null {
	if (
		!value ||
		![value.totalChars, value.systemChars, value.toolsChars].every(
			(n) => Number.isSafeInteger(n) && n >= 0,
		) ||
		value.totalChars <= 0 ||
		value.systemChars + value.toolsChars > value.totalChars
	)
		return null;
	let segments = readInputCompositionSegments(value.compositionSegments, value.totalChars);
	if (
		segments &&
		(segments.reduce(
			(sum, s) => sum + (s.category === "system" || s.category === "summary" ? s.chars : 0),
			0,
		) !== value.systemChars ||
			segments.reduce((sum, s) => sum + (s.category === "toolDefinition" ? s.chars : 0), 0) !==
				value.toolsChars)
	)
		segments = null;
	return {
		totalChars: value.totalChars,
		systemChars: value.systemChars,
		toolsChars: value.toolsChars,
		...(value.compositionSegments !== undefined ? { compositionSegments: segments } : {}),
	};
}

/** Only already-recorded numeric caches may classify the final input. Missing characters stay unknown. */
export function matchContextComposition(
	cache: ContextCharCache | null,
	counts: ContextInputCharacters | null,
): ContextCharCache | null {
	if (!cache || !validInputCharacters(counts) || !counts || cache.totalChars > counts.totalChars)
		return null;
	return structuredClone(cache);
}

export function boundedContextSnapshot(
	value: ContextUsageSnapshot | null | undefined,
): ContextUsageSnapshot | null {
	if (!value) return null;
	try {
		// Strip unknown fields before serialization; never copy an unbounded foreign body first.
		const parsed = parseContextUsageSnapshot(value);
		if (!parsed) return null;
		const json = JSON.stringify(parsed);
		if (Buffer.byteLength(json) > CONTEXT_USAGE_SNAPSHOT_MAX_BYTES) return null;
		if (parsed.inputCharacters && !validInputCharacters(parsed.inputCharacters)) return null;
		if (parsed.composition && !matchContextComposition(parsed.composition, parsed.inputCharacters))
			return null;
		return parsed;
	} catch {
		return null;
	}
}

export function parseContextSnapshot(json: string | null): ContextUsageSnapshot | null {
	if (!json || Buffer.byteLength(json) > CONTEXT_USAGE_SNAPSHOT_MAX_BYTES) return null;
	try {
		return boundedContextSnapshot(JSON.parse(json));
	} catch {
		return null;
	}
}
