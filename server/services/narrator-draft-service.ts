import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { narratorDrafts } from "../db/schema";
import { narratorDraftLock } from "../lib/async-mutex";
import { generateId } from "../lib/id";

export interface NarratorDraftState {
	hasDraft: boolean;
	text: string;
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
				revision: number;
				updatedAt: string;
				sourceId: string | null;
		  }
		| undefined,
	userId: string,
): NarratorDraftState {
	if (!row) return emptyDraftState();
	return {
		hasDraft: !!row.text.trim(),
		text: row.text,
		revision: row.revision,
		updatedAt: row.updatedAt,
		updatedBy: userId,
		sourceId: row.sourceId,
	};
}

export async function getNarratorDraft(
	userId: string,
	narratorId: string,
): Promise<NarratorDraftState> {
	const row = await db
		.select({
			text: narratorDrafts.text,
			revision: narratorDrafts.revision,
			updatedAt: narratorDrafts.updatedAt,
			sourceId: narratorDrafts.sourceId,
		})
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
): Promise<NarratorDraftUpdateResult> {
	return narratorDraftLock.acquire(`${userId.length}:${userId}:${narratorId}`, async () => {
		const previous = await db
			.select({
				text: narratorDrafts.text,
				revision: narratorDrafts.revision,
				updatedAt: narratorDrafts.updatedAt,
				sourceId: narratorDrafts.sourceId,
			})
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
		// Preserve the existing source attribution when the caller omits sourceId
		// (undefined) rather than clobbering it to null; only an explicit value
		// reassigns it. This keeps cross-device "who typed this" attribution stable
		// for clients that don't resend sourceId on every autosave.
		const storedSourceId = sourceId ?? current.sourceId ?? null;
		const nextRevision = current.revision + 1;

		await db
			.insert(narratorDrafts)
			.values({
				id: generateId(),
				userId,
				narratorId,
				text: storedText,
				sourceId: storedSourceId,
				revision: nextRevision,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [narratorDrafts.userId, narratorDrafts.narratorId],
				set: {
					text: storedText,
					sourceId: storedSourceId,
					revision: nextRevision,
					updatedAt: now,
				},
			});

		return {
			previousHasDraft: current.hasDraft,
			hasDraft: !!storedText,
			text: storedText,
			revision: nextRevision,
			updatedAt: now,
			updatedBy: userId,
			sourceId: storedSourceId,
		};
	});
}

/**
 * Cheap presence check for a single narrator that never materializes the draft
 * text. Use this when only `hasDraft` is needed (e.g. the narrator detail /
 * by-handle endpoints); `getNarratorDraft` reads the full text column (up to
 * MAX_NARRATOR_DRAFT_CHARS) which is wasteful just to derive a boolean.
 */
export async function narratorHasDraft(userId: string, narratorId: string): Promise<boolean> {
	const row = await db
		.select({ narratorId: narratorDrafts.narratorId })
		.from(narratorDrafts)
		.where(
			and(
				eq(narratorDrafts.userId, userId),
				eq(narratorDrafts.narratorId, narratorId),
				ne(narratorDrafts.text, ""),
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
				ne(narratorDrafts.text, ""),
			),
		);
	return new Set(rows.map((row) => row.narratorId));
}
