export const CONTEXT_CATEGORIES = [
	"system",
	"summary",
	"toolDefinition",
	"user",
	"assistant",
	"toolCall",
	"toolResult",
	"attachment",
	"other",
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export interface ContextSegment {
	category: ContextCategory;
	chars: number;
	/** Write-time marker only; counts remain canonical on the tool row. */
	toolUseId?: string;
}
/** Persisted at content write time. Missing historical statistics always mean zero. */
export interface ContextCharStats {
	segments: ContextSegment[];
}
/** Small persistent summary; ordered pages live separately from this record. */
export interface ContextCharCache {
	generation: string;
	revision: string;
	pageCount: number;
	totalChars: number;
	totals: ContextSegment[];
	/** Request-specific fixed prefix projected over immutable base numeric pages. */
	fixedPrefix?: { previous: ContextSegment[]; current: ContextSegment[] };
}
export interface ContextComposition {
	generation: string | null;
	totalChars: number;
	totals: ContextSegment[];
	segments: ContextSegment[];
	nextCursor: string | null;
	pending: boolean;
	/** Matched request occupancy and complete character calibration, if available. */
	usage?: import("./context-usage").ContextUsageSnapshot | null;
}
export function safeCharacters(chars: number): number {
	return Number.isFinite(chars) ? Math.max(0, Math.trunc(chars)) : 0;
}
export function groupContextSegments(segments: readonly ContextSegment[]): ContextSegment[] {
	return CONTEXT_CATEGORIES.map((category) => ({
		category,
		chars: segments.reduce(
			(sum, segment) => sum + (segment.category === category ? safeCharacters(segment.chars) : 0),
			0,
		),
	}));
}
export function contextCharacterPercent(chars: number, totalChars: number): number {
	return totalChars > 0 ? (safeCharacters(chars) / totalChars) * 100 : 0;
}
export function emptyContextComposition(pending = false): ContextComposition {
	return {
		generation: null,
		totalChars: 0,
		totals: groupContextSegments([]),
		segments: [],
		nextCursor: null,
		pending,
	};
}
