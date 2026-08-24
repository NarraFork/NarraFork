import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";
import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";

const INPUT_DRAFT_STORAGE_VERSION = 2;

/**
 * Largest draft mirrored into browser storage.
 *
 * ⚠️ Deliberately far below `MAX_NARRATOR_DRAFT_CHARS` (200k), which bounds what
 * the SERVER accepts. Treating the sync limit as the local limit is what let a
 * few narrators approach the whole ~5MB `sessionStorage` quota on their own, and
 * every keystroke re-wrote that whole body synchronously on the main thread.
 *
 * The server is the source of truth for a narrator draft (see `syncDraftNow`),
 * so this local copy only has to survive a crash or reload before the next sync —
 * a few KB of recent typing, not an entire long-form composition. A draft past
 * this size is simply not mirrored; it is still synced and still on screen.
 */
export const MAX_LOCAL_DRAFT_MIRROR_CHARS = 16_000;

export interface StoredNarratorInputDraft {
	text: string;
	serverRevision: number | null;
	serverUpdatedAt: string | null;
}

interface StoredNarratorInputDraftEnvelope extends StoredNarratorInputDraft {
	version: typeof INPUT_DRAFT_STORAGE_VERSION;
}

interface LegacyStoredNarratorInputDraftEnvelope {
	version: 1;
	text: string;
	serverUpdatedAt: string | null;
}

export interface ResolvedNarratorDraft {
	text: string;
	conflict: boolean;
}

export type DraftRevisionConflictAction = "ignore" | "retry" | "conflict";

export function classifyDraftRevisionConflict(options: {
	requestSequence: number;
	latestSequence: number;
	requestSourceId: string;
	currentSourceId: string | null;
}): DraftRevisionConflictAction {
	if (options.requestSequence !== options.latestSequence) return "ignore";
	return options.currentSourceId === options.requestSourceId ? "retry" : "conflict";
}

function emptyStoredDraft(): StoredNarratorInputDraft {
	return { text: "", serverRevision: null, serverUpdatedAt: null };
}

/**
 * Storage id for one `(user, narrator)` pair.
 *
 * The user id is length-prefixed so `("a_b", "c")` and `("a", "b_c")` cannot
 * collide — without it a crafted id could read another account's draft.
 */
function getUserNarratorStorageScope(userId: string, narratorId: string): string {
	return `${userId.length}:${userId}:${narratorId}`;
}

export function getNarratorInputDraftKey(userId: string, narratorId: string): string {
	return `narrafork_draft_${getUserNarratorStorageScope(userId, narratorId)}`;
}

export function getNarratorInputHistoryKey(userId: string, narratorId: string): string {
	return `narrafork_input_history_${getUserNarratorStorageScope(userId, narratorId)}`;
}

/** Session-store id for this pair's draft / input history. */
export function getNarratorDraftStorageId(userId: string, narratorId: string): string {
	return getUserNarratorStorageScope(userId, narratorId);
}

/**
 * Remove key shapes written by earlier versions.
 *
 * Covers BOTH pre-user-scoped v1 keys and the raw `narrafork_draft_*` /
 * `narrafork_input_history_*` keys this module wrote before drafts moved behind
 * the session store. The latter matter more than they look: they were unbounded
 * in count and up to 512k characters each, so a tab upgraded mid-session would
 * otherwise keep paying their quota cost forever with nothing able to reclaim it.
 */
export function cleanupLegacyNarratorInputStorage(userId: string, narratorId: string): void {
	try {
		sessionStorage.removeItem(`narrafork_draft_${narratorId}`);
		sessionStorage.removeItem(`narrafork_input_history_${narratorId}`);
		sessionStorage.removeItem(getNarratorInputDraftKey(userId, narratorId));
		sessionStorage.removeItem(getNarratorInputHistoryKey(userId, narratorId));
	} catch {
		// Ignore storage cleanup failures (private mode / quota restrictions).
	}
}

const LEGACY_DRAFT_KEY_PREFIX = "narrafork_draft_";
const LEGACY_HISTORY_KEY_PREFIX = "narrafork_input_history_";

/**
 * The session-store id a legacy key maps to, or null when it has none.
 *
 * User-scoped keys are `<prefix><len>:<userId>:<narratorId>`, and that suffix IS
 * the session-store id — so the mapping is exact. The pre-user-scoped v1 shape
 * (`narrafork_draft_<narratorId>`) has no owner in it and therefore no id to
 * migrate to: adopting it would file one user's text under an id that means
 * something else. Those keys are only deleted.
 */
function legacyStorageIdFromKey(key: string, prefix: string): string | null {
	if (!key.startsWith(prefix)) return null;
	const suffix = key.slice(prefix.length);
	// `<len>:` is what a user-scoped id starts with; see getUserNarratorStorageScope.
	return /^\d+:/.test(suffix) ? suffix : null;
}

/**
 * Reclaim every legacy narrator draft/history key in the area, regardless of owner.
 *
 * The per-narrator cleanup above can only reclaim ids this tab happens to open
 * again. A tab that already accumulated dozens of them needs a sweep, because
 * nothing else in the codebase ever enumerated the area — that absence is why the
 * old keys could grow until the quota was exhausted.
 *
 * Input HISTORY is migrated rather than dropped. It has no server copy, so
 * deleting it silently costs the user their up-arrow recall for every narrator
 * open in the tab; a draft, by contrast, is owned by the server (see
 * `syncDraftNow`) and its local mirror is rebuilt by hydration, so those keys are
 * simply removed. Migration re-applies the current limits through
 * `writeLegacyHistory`, and the session store's namespace cap bounds how many
 * survive — an unbounded legacy pile cannot become an unbounded new pile.
 *
 * Returns how many legacy keys were removed.
 */
export function purgeLegacyNarratorInputStorage(
	writeLegacyHistory?: (storageId: string, entries: string[]) => void,
): number {
	try {
		const doomed: string[] = [];
		const migrations: Array<{ storageId: string; raw: string }> = [];
		for (let index = 0; index < sessionStorage.length; index++) {
			const key = sessionStorage.key(index);
			if (!key) continue;
			if (key.startsWith(LEGACY_HISTORY_KEY_PREFIX)) {
				doomed.push(key);
				const storageId = legacyStorageIdFromKey(key, LEGACY_HISTORY_KEY_PREFIX);
				const raw = storageId && writeLegacyHistory ? sessionStorage.getItem(key) : null;
				if (storageId && raw) migrations.push({ storageId, raw });
			} else if (key.startsWith(LEGACY_DRAFT_KEY_PREFIX)) {
				doomed.push(key);
			}
		}
		for (const key of doomed) sessionStorage.removeItem(key);
		for (const { storageId, raw } of migrations) {
			// A malformed legacy value is skipped, never thrown: the sweep must free the
			// quota even when one entry is unreadable.
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed)) continue;
				const entries = parsed.filter((item): item is string => typeof item === "string");
				if (entries.length > 0) writeLegacyHistory?.(storageId, entries);
			} catch {
				// Unparseable legacy history — the key is already gone.
			}
		}
		return doomed.length;
	} catch {
		return 0;
	}
}

export function readNarratorInputDraft(
	userId: string,
	narratorId: string,
): StoredNarratorInputDraft {
	const id = getNarratorDraftStorageId(userId, narratorId);
	const drop = () => {
		removeSession("narrator-draft", id);
		return emptyStoredDraft();
	};
	try {
		const raw = readSession("narrator-draft", id);
		if (!raw) return emptyStoredDraft();
		const parsed = JSON.parse(raw) as Partial<
			StoredNarratorInputDraftEnvelope | LegacyStoredNarratorInputDraftEnvelope
		>;
		if (typeof parsed.text !== "string" || parsed.text.length > MAX_NARRATOR_DRAFT_CHARS) {
			return drop();
		}
		if (parsed.serverUpdatedAt !== null && typeof parsed.serverUpdatedAt !== "string") {
			return drop();
		}
		if (parsed.version === 1) {
			return {
				text: parsed.text,
				serverRevision: null,
				serverUpdatedAt: parsed.serverUpdatedAt ?? null,
			};
		}
		if (
			parsed.version !== INPUT_DRAFT_STORAGE_VERSION ||
			(parsed.serverRevision !== null &&
				(typeof parsed.serverRevision !== "number" ||
					!Number.isInteger(parsed.serverRevision) ||
					parsed.serverRevision < 0))
		) {
			return drop();
		}
		return {
			text: parsed.text,
			serverRevision: parsed.serverRevision ?? null,
			serverUpdatedAt: parsed.serverUpdatedAt ?? null,
		};
	} catch {
		return emptyStoredDraft();
	}
}

/**
 * Mirror a draft locally as a crash/reload fallback.
 *
 * Returns whether the text was mirrored. False means the draft is too long for a
 * local copy — NOT that it was lost: the server sync path owns the real draft, and
 * the text is still in the composer. Mirroring it anyway is what made typing
 * stutter, because each keystroke re-wrote the whole body synchronously.
 *
 * The write itself is COALESCED by the session store, so calling this per
 * keystroke costs one queue insertion rather than one storage write.
 */
export function persistNarratorInputDraft(
	userId: string,
	narratorId: string,
	text: string,
	serverRevision: number | null,
	serverUpdatedAt: string | null,
): boolean {
	const id = getNarratorDraftStorageId(userId, narratorId);
	if (text.length > MAX_LOCAL_DRAFT_MIRROR_CHARS) {
		// Drop any smaller copy stored earlier: a stale prefix of the current text
		// would be restored on reload and silently lose the rest.
		removeSession("narrator-draft", id);
		return false;
	}
	const envelope: StoredNarratorInputDraftEnvelope = {
		version: INPUT_DRAFT_STORAGE_VERSION,
		text,
		serverRevision,
		serverUpdatedAt,
	};
	/*
	 * An EMPTY mirror is disposable; one with text is not.
	 *
	 * Every narrator a tab opens writes this record during hydration, and for a
	 * narrator nobody typed into the text is "". Under a pure-LRU key cap those
	 * empty records were the most recent writes, so they outranked — and evicted —
	 * the one narrator whose draft the user had actually written. Switching away and
	 * back then found no local mirror, and hydration correctly treated the server
	 * revision as authoritative: the composer blanked and "restored" the older
	 * server copy, with no error anywhere because every layer did its job.
	 *
	 * The empty record still has to be WRITTEN (it is how a cleared draft stops
	 * resurrecting on reload); it just must never be worth more than typed text.
	 */
	writeSession("narrator-draft", id, JSON.stringify(envelope), text ? "durable" : "disposable");
	return true;
}

export function resolveHydratedNarratorDraft(options: {
	local: StoredNarratorInputDraft;
	serverText: string;
	serverRevision: number;
	currentInput: string;
	localChangedSinceRequest: boolean;
}): ResolvedNarratorDraft {
	if (options.localChangedSinceRequest) {
		return {
			text: options.currentInput,
			conflict:
				options.currentInput !== options.serverText &&
				options.local.serverRevision !== options.serverRevision,
		};
	}
	if (options.local.serverRevision === options.serverRevision) {
		// Same server base but different text means this browser has unsynced edits.
		return { text: options.local.text, conflict: false };
	}
	if (
		options.local.serverRevision === null &&
		options.local.text &&
		options.local.text !== options.serverText
	) {
		// Version-1 browser storage has no trustworthy base revision. Preserve it for an
		// explicit user choice instead of silently overwriting either side.
		return { text: options.local.text, conflict: true };
	}
	// A different known server revision (including a newer clear tombstone) is authoritative.
	return { text: options.serverText, conflict: false };
}
