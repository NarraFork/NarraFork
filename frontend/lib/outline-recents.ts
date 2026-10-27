/**
 * Recently visited outline pages, kept per browser (a convenience, not shared state). Titles are
 * what the viewer saw at the time; opening one re-reads it with current access.
 */

export interface OutlineRecent {
	spaceId: string;
	blockId: string;
	title: string;
	visitedAt: number;
}

const STORAGE_KEY = "narrafork_outline_recents";
export const OUTLINE_RECENTS_MAX = 12;

function isRecent(value: unknown): value is OutlineRecent {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.spaceId === "string" &&
		typeof v.blockId === "string" &&
		typeof v.title === "string" &&
		typeof v.visitedAt === "number"
	);
}

/** Parse stored recents, dropping anything malformed. */
export function parseOutlineRecents(text: string | null): OutlineRecent[] {
	if (!text) return [];
	try {
		const value = JSON.parse(text) as unknown;
		return Array.isArray(value) ? value.filter(isRecent).slice(0, OUTLINE_RECENTS_MAX) : [];
	} catch {
		return [];
	}
}

/** `list` with `visit` first, replacing an older visit of the same block, capped. */
export function withOutlineRecent(
	list: readonly OutlineRecent[],
	visit: OutlineRecent,
): OutlineRecent[] {
	return [visit, ...list.filter((r) => r.blockId !== visit.blockId)].slice(0, OUTLINE_RECENTS_MAX);
}

export function readOutlineRecents(): OutlineRecent[] {
	try {
		return parseOutlineRecents(localStorage.getItem(STORAGE_KEY));
	} catch {
		return [];
	}
}

export function recordOutlineRecent(visit: OutlineRecent): void {
	try {
		const next = withOutlineRecent(readOutlineRecents(), visit);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Storage may be unavailable (private window, blocked site data): recents are optional.
	}
}

/** Forget pages that turned out to be gone or unreadable. */
export function forgetOutlineRecent(blockId: string): void {
	try {
		const next = readOutlineRecents().filter((r) => r.blockId !== blockId);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// See recordOutlineRecent.
	}
}
