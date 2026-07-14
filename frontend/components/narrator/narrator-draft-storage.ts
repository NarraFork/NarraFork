import { MAX_NARRATOR_DRAFT_CHARS } from "@shared/narrator-limits";

const INPUT_DRAFT_STORAGE_VERSION = 2;

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

function emptyStoredDraft(): StoredNarratorInputDraft {
	return { text: "", serverRevision: null, serverUpdatedAt: null };
}

function getUserNarratorStorageScope(userId: string, narratorId: string): string {
	return `${userId.length}:${userId}:${narratorId}`;
}

export function getNarratorInputDraftKey(userId: string, narratorId: string): string {
	return `narrafork_draft_${getUserNarratorStorageScope(userId, narratorId)}`;
}

export function getNarratorInputHistoryKey(userId: string, narratorId: string): string {
	return `narrafork_input_history_${getUserNarratorStorageScope(userId, narratorId)}`;
}

export function cleanupLegacyNarratorInputStorage(narratorId: string): void {
	try {
		sessionStorage.removeItem(`narrafork_draft_${narratorId}`);
		sessionStorage.removeItem(`narrafork_input_history_${narratorId}`);
	} catch {
		// Ignore storage cleanup failures (private mode / quota restrictions).
	}
}

export function readNarratorInputDraft(
	userId: string,
	narratorId: string,
): StoredNarratorInputDraft {
	const key = getNarratorInputDraftKey(userId, narratorId);
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return emptyStoredDraft();
		if (raw.length > MAX_NARRATOR_DRAFT_CHARS + 2_000) {
			sessionStorage.removeItem(key);
			return emptyStoredDraft();
		}
		const parsed = JSON.parse(raw) as Partial<
			StoredNarratorInputDraftEnvelope | LegacyStoredNarratorInputDraftEnvelope
		>;
		if (typeof parsed.text !== "string" || parsed.text.length > MAX_NARRATOR_DRAFT_CHARS) {
			sessionStorage.removeItem(key);
			return emptyStoredDraft();
		}
		if (parsed.serverUpdatedAt !== null && typeof parsed.serverUpdatedAt !== "string") {
			sessionStorage.removeItem(key);
			return emptyStoredDraft();
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
			sessionStorage.removeItem(key);
			return emptyStoredDraft();
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

export function persistNarratorInputDraft(
	userId: string,
	narratorId: string,
	text: string,
	serverRevision: number | null,
	serverUpdatedAt: string | null,
): boolean {
	if (text.length > MAX_NARRATOR_DRAFT_CHARS) return false;
	const key = getNarratorInputDraftKey(userId, narratorId);
	try {
		const envelope: StoredNarratorInputDraftEnvelope = {
			version: INPUT_DRAFT_STORAGE_VERSION,
			text,
			serverRevision,
			serverUpdatedAt,
		};
		sessionStorage.setItem(key, JSON.stringify(envelope));
		return true;
	} catch {
		return false;
	}
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
