import { foldHandle, handleLength, MAX_HANDLE_LENGTH } from "./narrator-handle";

export const NAMED_SUGGESTIONS_DEFAULT_LIMIT = 20;
export const NAMED_SUGGESTIONS_MAX_LIMIT = 50;
export const NAMED_SUGGESTIONS_MAX_BYTES = 48 * 1024;
export const NAMED_SUGGESTIONS_TITLE_CHARS = 160;
export const NAMED_SUGGESTIONS_CURSOR_CHARS = 1024;

export interface NamedNarratorSuggestion {
	id: string;
	handle: string;
	title: string | null;
	status: string;
}

export interface NamedNarratorSuggestionsPage {
	items: NamedNarratorSuggestion[];
	nextCursor: string | null;
}

/** null means invalid, not an empty search. Bound raw input before normalization. */
export function normalizeNamedSuggestionQuery(q: string): string | null {
	if (q.length > 256) return null;
	const folded = foldHandle(q);
	return handleLength(folded) <= MAX_HANDLE_LENGTH ? folded : null;
}
