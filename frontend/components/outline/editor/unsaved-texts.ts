/**
 * Text typed into a live page that never reached the page, kept for the person per tab
 * (read-only first, design §6.10; review rounds 3–4). One place for every way it can happen, so
 * no session, client or surface takes such text with it when it goes:
 *
 *   - refused: the page refused the session (too large, no access) after the person typed on
 *     its read;
 *   - read_only: the snapshot said the person may no longer write;
 *   - not_sent: a session was closed with typing not acknowledged yet (it waited as long as it
 *     may, or the client was disposed for another reason);
 *   - moved_away: the block typed into is no longer on the page when the snapshot arrives
 *     (deleted, or moved to another page): restoring adds the text back as a new block.
 *
 * Keyed by page and block: every surface of the page shows the entries (a red notice with copy,
 * dismiss, and restore where it applies) from the moment it mounts, whichever session or panel
 * the text came from. An entry leaves only when the person dismisses it or its restore was
 * acknowledged by the page.
 *
 * In memory only, per tab, never in localStorage: the text may come from a space another person
 * using this browser cannot read. Bounded: at most `UNSAVED_LIMITS.entries` entries and
 * `UNSAVED_LIMITS.bytes` of text (UTF-8, typed text and the text before); the oldest go first,
 * with a console warning, and the notice of their page says how many went (until dismissed). The
 * newest entry stays even if it alone is larger (one block's text).
 *
 * Adding a `moved_away` text back is tracked on its entry (`adding`): on its way, nothing to
 * click; the session closed before the page answered, it may be on the page already, and the
 * notice says so before the person adds it again.
 */
import type { LiveTaskChar } from "@shared/outline-live-protocol";

export type UnsavedReason = "refused" | "read_only" | "not_sent" | "moved_away";

export interface UnsavedEntry {
	/** This entry (dismiss, restore). */
	id: string;
	pageId: string;
	blockId: string;
	/** The block's text as the person left it. */
	text: string;
	/** The block's text before they typed, when known. */
	base?: string;
	reason: UnsavedReason;
	/** `moved_away`: where restoring adds the text back (the nearest block still on the page). */
	restore?: { parentId: string; task: LiveTaskChar | null };
	/**
	 * Adding it back: `sending` — sent, the page has not answered yet; `unknown` — the session
	 * closed before the page answered: it may have been added.
	 */
	adding?: "sending" | "unknown";
	/** When it was kept (oldest go first). */
	at: number;
}

export const UNSAVED_LIMITS = { entries: 50, bytes: 256 * 1024 } as const;

const entries: UnsavedEntry[] = [];
/** Per page, how many of its entries the limits pushed out (shown until dismissed). */
const dropped = new Map<string, number>();
/** Pages whose dropped count is kept, at most (the oldest page goes first). */
const DROPPED_PAGES = 100;
const listeners = new Set<() => void>();
let seq = 0;
let version = 0;
const encoder = new TextEncoder();

function bytesOf(e: UnsavedEntry): number {
	return encoder.encode(e.text).length + encoder.encode(e.base ?? "").length;
}

function changed(): void {
	version++;
	for (const l of [...listeners]) l();
}

/**
 * Keep text that did not reach the page. A newer entry for the same block and reason replaces
 * the older one (the person typed on).
 */
export function keepUnsavedTexts(items: ReadonlyArray<Omit<UnsavedEntry, "id" | "at">>): void {
	if (items.length === 0) return;
	for (const item of items) {
		const at = entries.findIndex(
			(e) => e.pageId === item.pageId && e.blockId === item.blockId && e.reason === item.reason,
		);
		if (at >= 0) entries.splice(at, 1);
		entries.push({ ...item, id: `u${++seq}`, at: Date.now() });
	}
	let total = entries.reduce((n, e) => n + bytesOf(e), 0);
	while (
		entries.length > UNSAVED_LIMITS.entries ||
		(total > UNSAVED_LIMITS.bytes && entries.length > 1)
	) {
		const old = entries.shift() as UnsavedEntry;
		total -= bytesOf(old);
		const count = (dropped.get(old.pageId) ?? 0) + 1;
		dropped.delete(old.pageId);
		dropped.set(old.pageId, count);
		if (dropped.size > DROPPED_PAGES) dropped.delete(dropped.keys().next().value as string);
		console.warn("Outline: unsaved text dropped (this tab keeps only so much)", {
			pageId: old.pageId,
			blockId: old.blockId,
			chars: old.text.length,
		});
	}
	changed();
}

/** The entries of a page, oldest first. */
export function unsavedTextsOf(pageId: string): UnsavedEntry[] {
	return entries.filter((e) => e.pageId === pageId);
}

export function unsavedTextById(id: string): UnsavedEntry | undefined {
	return entries.find((e) => e.id === id);
}

/** Entries of a page the limits pushed out since the person last dismissed the count. */
export function unsavedDroppedOf(pageId: string): number {
	return dropped.get(pageId) ?? 0;
}

export function dismissUnsavedDropped(pageId: string): void {
	if (dropped.delete(pageId)) changed();
}

/** Where adding an entry back stands (null: not being added). */
export function markUnsavedAdding(id: string, adding: UnsavedEntry["adding"] | null): void {
	const entry = entries.find((e) => e.id === id);
	if (!entry || entry.adding === (adding ?? undefined)) return;
	if (adding) entry.adding = adding;
	else delete entry.adding;
	changed();
}

/** The person dismissed it, or its restore was acknowledged. */
export function dropUnsavedText(id: string): void {
	const at = entries.findIndex((e) => e.id === id);
	if (at < 0) return;
	entries.splice(at, 1);
	changed();
}

/** Changes of the store (React: `useSyncExternalStore` with `unsavedTextsVersion`). */
export function onUnsavedTexts(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function unsavedTextsVersion(): number {
	return version;
}

/** Tests: an empty store. */
export function clearUnsavedTextsForTests(): void {
	entries.length = 0;
	dropped.clear();
	changed();
}
