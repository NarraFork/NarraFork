import {
	CONTEXT_CATEGORIES,
	type ContextSegment,
	safeCharacters,
} from "@shared/context-composition";

/** Only persisted numeric metadata is accepted; never infer statistics from a body. */
export function readContextSegments(json: string | null): ContextSegment[] {
	if (!json) return [];
	try {
		const value = JSON.parse(json);
		const segments = Array.isArray(value) ? value : value?.segments;
		if (!Array.isArray(segments)) return [];
		return segments.flatMap((segment): ContextSegment[] =>
			segment && CONTEXT_CATEGORIES.includes(segment.category) && typeof segment.chars === "number"
				? [
						{
							category: segment.category,
							chars: safeCharacters(segment.chars),
							...(segment.category === "toolCall" && typeof segment.toolUseId === "string"
								? { toolUseId: segment.toolUseId }
								: {}),
						},
					]
				: [],
		);
	} catch {
		return [];
	}
}
