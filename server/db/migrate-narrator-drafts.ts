import type { Database } from "bun:sqlite";
import { generateId } from "../lib/id";
import { parseDraftTrait, upsertDraftTrait } from "../lib/narrator-utils";

interface LegacyDraftRow {
	id: string;
	traits: string;
}

export interface LegacyNarratorDraftMigrationResult {
	migrated: number;
	discarded: number;
}

/**
 * Move the legacy narrator-wide encoded draft trait into the per-user draft table.
 * Every matching trait is removed even when its owner is unknown, because retaining
 * narrator-wide draft content would preserve the cross-account disclosure.
 */
export function migrateLegacyNarratorDraftTraits(
	sqlite: Database,
): LegacyNarratorDraftMigrationResult {
	const rows = sqlite
		.prepare(`SELECT id, traits FROM narrators WHERE traits LIKE '%"draft:%'`)
		.all() as LegacyDraftRow[];
	if (rows.length === 0) return { migrated: 0, discarded: 0 };

	const userExists = sqlite.prepare("SELECT 1 FROM users WHERE id = ? LIMIT 1");
	const upsertDraft = sqlite.prepare(`
		INSERT INTO narrator_drafts (id, user_id, narrator_id, text, source_id, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, narrator_id) DO UPDATE SET
			text = excluded.text,
			source_id = excluded.source_id,
			revision = narrator_drafts.revision + 1,
			updated_at = excluded.updated_at
		WHERE excluded.updated_at >= narrator_drafts.updated_at
	`);
	const stripLegacyTrait = sqlite.prepare("UPDATE narrators SET traits = ? WHERE id = ?");
	let migrated = 0;
	let discarded = 0;

	const run = sqlite.transaction(() => {
		for (const row of rows) {
			const draft = parseDraftTrait(row.traits);
			if (draft?.updatedBy && userExists.get(draft.updatedBy)) {
				upsertDraft.run(
					generateId(),
					draft.updatedBy,
					row.id,
					draft.text,
					draft.sourceId ?? null,
					draft.updatedAt,
				);
				migrated++;
			} else {
				discarded++;
			}
			stripLegacyTrait.run(JSON.stringify(upsertDraftTrait(row.traits, null)), row.id);
		}
	});
	run();

	return { migrated, discarded };
}
