import type { FileReference } from "@shared/file-reference";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db } from "../db";
import { narratorDrafts } from "../db/schema";
import { copyFileReference } from "../lib/agent/file-reference-projection";
import { narratorDraftLock } from "../lib/async-mutex";
import { generateId } from "../lib/id";

export interface NarratorDraftState {
	hasDraft: boolean;
	text: string;
	fileReferences: FileReference[];
	revision: number;
	updatedAt: string | null;
	updatedBy: string | null;
	sourceId: string | null;
}

export interface NarratorDraftUpdate extends NarratorDraftState {
	previousHasDraft: boolean;
}

export interface NarratorDraftConflict {
	conflict: true;
	current: NarratorDraftState;
}

export type NarratorDraftUpdateResult = NarratorDraftUpdate | NarratorDraftConflict;

function emptyDraftState(): NarratorDraftState {
	return {
		hasDraft: false,
		text: "",
		fileReferences: [],
		revision: 0,
		updatedAt: null,
		updatedBy: null,
		sourceId: null,
	};
}

function rowToDraftState(
	row:
		| {
				text: string;
				fileReferencesJson?: string | null;
				revision: number;
				updatedAt: string;
				sourceId: string | null;
		  }
		| undefined,
	userId: string,
): NarratorDraftState {
	if (!row) return emptyDraftState();
	const fileReferences: FileReference[] = row.fileReferencesJson
		? (JSON.parse(row.fileReferencesJson) as FileReference[]).map(copyFileReference)
		: [];
	return {
		hasDraft: !!row.text.trim() || fileReferences.length > 0,
		text: row.text,
		fileReferences,
		revision: row.revision,
		updatedAt: row.updatedAt,
		updatedBy: userId,
		sourceId: row.sourceId,
	};
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
	revision: narratorDrafts.revision,
	updatedAt: narratorDrafts.updatedAt,
	sourceId: narratorDrafts.sourceId,
};

export async function getNarratorDraft(
	userId: string,
	narratorId: string,
): Promise<NarratorDraftState> {
	const row = await db
		.select(draftColumns)
		.from(narratorDrafts)
		.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId)))
		.get();
	return rowToDraftState(row, userId);
}

export async function updateNarratorDraft(
	userId: string,
	narratorId: string,
	text: string,
	sourceId?: string,
	baseRevision?: number,
	fileReferences?: FileReference[],
): Promise<NarratorDraftUpdateResult> {
	// Capture metadata before awaiting the lock: text and references are one CAS value.
	const suppliedReferences = fileReferences?.map(copyFileReference);
	return narratorDraftLock.acquire(`${userId.length}:${userId}:${narratorId}`, async () => {
		const previous = await db
			.select(draftColumns)
			.from(narratorDrafts)
			.where(and(eq(narratorDrafts.userId, userId), eq(narratorDrafts.narratorId, narratorId)))
			.get();
		const current = rowToDraftState(previous, userId);
		const expectedRevision = baseRevision ?? current.revision;
		if (expectedRevision !== current.revision) {
			return { conflict: true, current };
		}

		const now = new Date().toISOString();
		const storedText = text.trim() ? text : "";
		const storedReferences =
			suppliedReferences ??
			retainMatchingDraftFileReferences(current.text, storedText, current.fileReferences);
		const fileReferencesJson = storedReferences.length ? JSON.stringify(storedReferences) : null;
		// Omission keeps the previous source attribution for legacy autosave clients.
		const storedSourceId = sourceId ?? current.sourceId ?? null;
		const nextRevision = current.revision + 1;
		const fields = {
			text: storedText,
			fileReferencesJson,
			sourceId: storedSourceId,
			revision: nextRevision,
			updatedAt: now,
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
			hasDraft: !!storedText || storedReferences.length > 0,
			text: storedText,
			fileReferences: storedReferences,
			revision: nextRevision,
			updatedAt: now,
			updatedBy: userId,
			sourceId: storedSourceId,
		};
	});
}

// Empty reference lists are always stored as NULL. Presence queries return only
// ids: neither the draft text nor the up-to-64-KiB locator JSON is materialized.
function draftPresent() {
	return or(ne(narratorDrafts.text, ""), isNotNull(narratorDrafts.fileReferencesJson));
}

export async function narratorHasDraft(userId: string, narratorId: string): Promise<boolean> {
	const row = await db
		.select({ narratorId: narratorDrafts.narratorId })
		.from(narratorDrafts)
		.where(
			and(
				eq(narratorDrafts.userId, userId),
				eq(narratorDrafts.narratorId, narratorId),
				draftPresent(),
			),
		)
		.get();
	return !!row;
}

export async function getNarratorIdsWithDraft(
	userId: string,
	narratorIds: string[],
): Promise<Set<string>> {
	if (narratorIds.length === 0) return new Set();
	const rows = await db
		.select({ narratorId: narratorDrafts.narratorId })
		.from(narratorDrafts)
		.where(
			and(
				eq(narratorDrafts.userId, userId),
				inArray(narratorDrafts.narratorId, narratorIds),
				draftPresent(),
			),
		);
	return new Set(rows.map((row) => row.narratorId));
}
