import { type ComposerDocument, readComposerDocument } from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorDrafts } from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { copyFileReference } from "../lib/agent/file-reference-projection";
import { narratorDraftLock } from "../lib/async-mutex";
import {
	parseOptionalComposerDocument,
	validateComposerProjection,
} from "../lib/composer-document";
import { generateId } from "../lib/id";

export interface NarratorDraftState {
	hasDraft: boolean;
	text: string;
	fileReferences: FileReference[];
	composerDocument?: ComposerDocument;
	revision: number;
	updatedAt: string | null;
	updatedBy: string | null;
	sourceId: string | null;
	/** True when a previous version was kept after the last overwrite and can be restored. */
	hasPrevious: boolean;
}

export interface NarratorDraftUpdate extends NarratorDraftState {
	previousHasDraft: boolean;
}

/**
 * The single undo slot: the version a write overwrote. Stored verbatim (raw
 * column values) so a restore never round-trips through validation drift.
 */
interface NarratorDraftPreviousSnapshot {
	text: string;
	fileReferencesJson: string | null;
	composerDocument: ComposerDocument | null;
	revision: number;
	updatedAt: string;
}

function emptyDraftState(): NarratorDraftState {
	return {
		hasDraft: false,
		text: "",
		fileReferences: [],
		revision: 0,
		updatedAt: null,
		updatedBy: null,
		sourceId: null,
		hasPrevious: false,
	};
}

function rowToDraftState(
	row:
		| {
				text: string;
				fileReferencesJson?: string | null;
				composerDocument?: ComposerDocument | null;
				revision: number;
				updatedAt: string;
				sourceId: string | null;
				previousJson?: string | null;
		  }
		| undefined,
	userId: string,
): NarratorDraftState {
	if (!row) return emptyDraftState();
	const fileReferences: FileReference[] = row.fileReferencesJson
		? (JSON.parse(row.fileReferencesJson) as FileReference[]).map(copyFileReference)
		: [];
	const composerDocument = readComposerDocument(row.composerDocument);
	return {
		hasDraft: !!row.text.trim() || fileReferences.length > 0 || !!composerDocument?.assets.length,
		text: row.text,
		fileReferences,
		composerDocument,
		revision: row.revision,
		updatedAt: row.updatedAt,
		updatedBy: userId,
		sourceId: row.sourceId,
		hasPrevious: !!row.previousJson,
	};
}

function snapshotRow(row: {
	text: string;
	fileReferencesJson?: string | null;
	composerDocument?: ComposerDocument | null;
	revision: number;
	updatedAt: string;
}): string {
	const snapshot: NarratorDraftPreviousSnapshot = {
		text: row.text,
		fileReferencesJson: row.fileReferencesJson ?? null,
		composerDocument: row.composerDocument ?? null,
		revision: row.revision,
		updatedAt: row.updatedAt,
	};
	return JSON.stringify(snapshot);
}

/** The undo slot is ours alone, but a corrupt blob must cost the slot, not the draft. */
function readPreviousSnapshot(value: unknown): NarratorDraftPreviousSnapshot | null {
	try {
		const raw =
			typeof value === "string"
				? (JSON.parse(value) as Partial<NarratorDraftPreviousSnapshot>)
				: null;
		if (!raw || typeof raw.text !== "string") return null;
		if (raw.fileReferencesJson !== null && typeof raw.fileReferencesJson !== "string") return null;
		if (typeof raw.revision !== "number" || typeof raw.updatedAt !== "string") return null;
		return {
			text: raw.text,
			fileReferencesJson: raw.fileReferencesJson ?? null,
			composerDocument: readComposerDocument(raw.composerDocument) ?? null,
			revision: raw.revision,
			updatedAt: raw.updatedAt,
		};
	} catch {
		return null;
	}
}

/**
 * A legacy text-only client cannot move token offsets. Retain only occurrences
 * whose existing, nonempty token still occupies exactly the same input range.
 * Detached chips have no verifiable range and cannot survive an omitted field.
 */
export function retainMatchingDraftFileReferences(
	previousText: string,
	text: string,
	references: readonly FileReference[],
): FileReference[] {
	return references.filter((reference) => {
		const range = reference.inputRange;
		if (!range) return false;
		const [start, end] = range;
		return (
			Number.isInteger(start) &&
			Number.isInteger(end) &&
			start >= 0 &&
			end > start &&
			end <= previousText.length &&
			end <= text.length &&
			previousText.slice(start, end) === text.slice(start, end)
		);
	});
}

const draftColumns = {
	text: narratorDrafts.text,
	fileReferencesJson: narratorDrafts.fileReferencesJson,
	composerDocument: narratorDrafts.composerDocument,
	revision: narratorDrafts.revision,
	updatedAt: narratorDrafts.updatedAt,
	sourceId: narratorDrafts.sourceId,
	previousJson: narratorDrafts.previousJson,
};

export async function getNarratorDraft(
	userId: string,
	narratorId: string,
): Promise<NarratorDraftState> {
	const row = await readQueryFirst(
		db
			.select(draftColumns)
			.from(narratorDrafts)
			.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId))),
		{ site: "narrator-draft-service.getNarratorDraft" },
	);
	return rowToDraftState(row, userId);
}

/** First-paint metadata never materializes draft text or reference JSON. */
export async function getNarratorDraftMetadata(
	userId: string,
	narratorId: string,
): Promise<Pick<NarratorDraftState, "hasDraft" | "revision" | "updatedAt">> {
	const row = await readQueryFirst(
		db
			.select({
				hasDraft: sql<number>`CASE WHEN length(trim(${narratorDrafts.text})) > 0 OR
			(${narratorDrafts.fileReferencesJson} IS NOT NULL AND ${narratorDrafts.fileReferencesJson} <> '[]') OR ${narratorDrafts.composerDocument} IS NOT NULL THEN 1 ELSE 0 END`,
				revision: narratorDrafts.revision,
				updatedAt: narratorDrafts.updatedAt,
			})
			.from(narratorDrafts)
			.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId))),
		{ site: "narrator-draft-service.getNarratorDraftMetadata" },
	);
	return {
		hasDraft: !!row?.hasDraft,
		revision: row?.revision ?? 0,
		updatedAt: row?.updatedAt ?? null,
	};
}

/**
 * Last-writer-wins save. A draft is a per-user scratchpad, so "conflicts" are
 * always the same person racing their own other tab or a stale base — rejecting
 * the write forced that person to arbitrate against themselves. The overwritten
 * version lands in the undo slot whenever it had content and actually changed,
 * so the replaced version stays recoverable (see restoreNarratorDraftPrevious).
 */
export async function updateNarratorDraft(
	userId: string,
	narratorId: string,
	text: string,
	sourceId?: string,
	fileReferences?: FileReference[],
	composerDocument?: ComposerDocument,
): Promise<NarratorDraftUpdate> {
	composerDocument = parseOptionalComposerDocument(composerDocument);
	validateComposerProjection(composerDocument, text, fileReferences);
	// Capture metadata before awaiting the lock: text and references are one value.
	const suppliedReferences = fileReferences?.map(copyFileReference);
	return narratorDraftLock.acquire(`${userId.length}:${userId}:${narratorId}`, async () => {
		const previous = await readQueryFirst(
			db
				.select(draftColumns)
				.from(narratorDrafts)
				.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId))),
			{ site: "narrator-draft-service.query" },
		);
		const current = rowToDraftState(previous, userId);

		const now = new Date().toISOString();
		const storedText = text.trim() || composerDocument?.assets.length ? text : "";
		const storedReferences =
			suppliedReferences ??
			retainMatchingDraftFileReferences(current.text, storedText, current.fileReferences);
		const fileReferencesJson = storedReferences.length ? JSON.stringify(storedReferences) : null;
		// Omission keeps the previous source attribution for legacy autosave clients.
		const storedSourceId = sourceId ?? current.sourceId ?? null;
		const nextRevision = current.revision + 1;
		const storedComposerDocument =
			storedText.trim() || storedReferences.length || composerDocument?.assets.length
				? composerDocument
				: undefined;
		// Keep the undo slot unless this write replaces real content with something
		// different; an unchanged re-save must not bury the recoverable version.
		const contentChanged =
			storedText !== current.text ||
			JSON.stringify(storedReferences) !== JSON.stringify(current.fileReferences) ||
			JSON.stringify(storedComposerDocument ?? null) !==
				JSON.stringify(current.composerDocument ?? null);
		const previousJson =
			current.hasDraft && contentChanged && previous
				? snapshotRow(previous)
				: (previous?.previousJson ?? null);
		const fields = {
			text: storedText,
			fileReferencesJson,
			composerDocument: storedComposerDocument ?? null,
			sourceId: storedSourceId,
			revision: nextRevision,
			updatedAt: now,
			previousJson,
		};
		await db
			.insert(narratorDrafts)
			.values({ id: generateId(), userId, narratorId, ...fields })
			.onConflictDoUpdate({
				target: [narratorDrafts.userId, narratorDrafts.narratorId],
				set: fields,
			});

		return {
			previousHasDraft: current.hasDraft,
			hasDraft:
				!!storedText.trim() ||
				storedReferences.length > 0 ||
				!!storedComposerDocument?.assets.length,
			text: storedText,
			fileReferences: storedReferences,
			composerDocument: storedComposerDocument,
			revision: nextRevision,
			updatedAt: now,
			updatedBy: userId,
			sourceId: storedSourceId,
			hasPrevious: !!previousJson,
		};
	});
}

/**
 * Swap the current draft with the undo slot. The swap is symmetric — the
 * replaced version becomes the new undo slot — so restoring twice returns to
 * the state before the first restore. Returns null when nothing was ever kept.
 */
export async function restoreNarratorDraftPrevious(
	userId: string,
	narratorId: string,
	sourceId?: string,
): Promise<NarratorDraftUpdate | null> {
	return narratorDraftLock.acquire(`${userId.length}:${userId}:${narratorId}`, async () => {
		const row = await db
			.select(draftColumns)
			.from(narratorDrafts)
			.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId)))
			.get();
		const snapshot = readPreviousSnapshot(row?.previousJson);
		if (!row || !snapshot) return null;
		const current = rowToDraftState(row, userId);
		const now = new Date().toISOString();
		const fields = {
			text: snapshot.text,
			fileReferencesJson: snapshot.fileReferencesJson,
			composerDocument: snapshot.composerDocument,
			sourceId: sourceId ?? row.sourceId,
			revision: row.revision + 1,
			updatedAt: now,
			previousJson: snapshotRow(row),
		};
		await db
			.update(narratorDrafts)
			.set(fields)
			.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId)));
		const fileReferences: FileReference[] = snapshot.fileReferencesJson
			? (JSON.parse(snapshot.fileReferencesJson) as FileReference[]).map(copyFileReference)
			: [];
		return {
			previousHasDraft: current.hasDraft,
			hasDraft:
				!!snapshot.text.trim() ||
				fileReferences.length > 0 ||
				!!snapshot.composerDocument?.assets.length,
			text: snapshot.text,
			fileReferences,
			composerDocument: snapshot.composerDocument ?? undefined,
			revision: fields.revision,
			updatedAt: now,
			updatedBy: userId,
			sourceId: fields.sourceId,
			hasPrevious: true,
		};
	});
}

// Empty reference lists are always stored as NULL. Presence queries return only
// ids: neither the draft text nor the up-to-64-KiB locator JSON is materialized.
function draftPresent() {
	return or(
		ne(narratorDrafts.text, ""),
		isNotNull(narratorDrafts.fileReferencesJson),
		isNotNull(narratorDrafts.composerDocument),
	);
}

export async function narratorHasDraft(userId: string, narratorId: string): Promise<boolean> {
	const row = await readQueryFirst(
		db
			.select({ narratorId: narratorDrafts.narratorId })
			.from(narratorDrafts)
			.where(
				and(
					eq(narratorDrafts.userId, userId),
					eq(narratorDrafts.narratorId, narratorId),
					draftPresent(),
				),
			),
		{ site: "narrator-draft-service.narratorHasDraft" },
	);
	return !!row;
}

export async function getNarratorIdsWithDraft(
	userId: string,
	narratorIds: string[],
): Promise<Set<string>> {
	if (narratorIds.length === 0) return new Set();
	const rows = await readQuery(
		db
			.select({ narratorId: narratorDrafts.narratorId })
			.from(narratorDrafts)
			.where(
				and(
					eq(narratorDrafts.userId, userId),
					inArray(narratorDrafts.narratorId, narratorIds),
					draftPresent(),
				),
			),
		{ site: "narrator-draft-service.getNarratorIdsWithDraft" },
	);
	return new Set(rows.map((row) => row.narratorId));
}
