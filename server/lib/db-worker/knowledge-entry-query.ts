import type { Database } from "bun:sqlite";
import type { KnowledgeEntryRow } from "../../services/knowledge/read-store";

export const KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE = "KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE";
const MAX_DETAIL_BYTES = 132 * 1024 * 1024;

const columns = {
	id: "id",
	collectionId: "collection_id",
	title: "title",
	slug: "slug",
	currentRevisionId: "current_revision_id",
	currentContent: "current_content",
	currentKeywords: "current_keywords",
	tagsJson: "tags_json",
	keywordsJson: "keywords_json",
	metadataJson: "metadata_json",
	classificationLevel: "classification_level",
	controlledTagsJson: "controlled_tags_json",
	reviewTagsJson: "review_tags_json",
	ownerUserId: "owner_user_id",
	status: "status",
	createdAt: "created_at",
	updatedAt: "updated_at",
} satisfies Record<keyof KnowledgeEntryRow, string>;
const jsonColumns = [
	"tagsJson",
	"keywordsJson",
	"metadataJson",
	"controlledTagsJson",
	"reviewTagsJson",
] as const;

const selectColumns = Object.entries(columns)
	.map(([key, column]) => `${column} AS "${key}"`)
	.join(", ");
const rowBytes = Object.values(columns)
	.map((column) => `coalesce(octet_length(${column}), 0)`)
	.join(" + ");

export function readKnowledgeEntryDetail(
	sqlite: Database,
	entryId: string,
	signal: AbortSignal,
	maxBytes = MAX_DETAIL_BYTES,
): KnowledgeEntryRow | null {
	signal.throwIfAborted();
	return sqlite.transaction(() => {
		const measured = sqlite
			.query<{ bytes: number }, [string]>(
				`SELECT ${rowBytes} AS bytes FROM knowledge_entries WHERE id = ? LIMIT 1`,
			)
			.get(entryId);
		if (!measured) return null;
		if (measured.bytes > maxBytes) {
			throw Object.assign(new Error("Knowledge entry exceeds its detail byte budget"), {
				code: KNOWLEDGE_ENTRY_DETAIL_TOO_LARGE,
			});
		}
		signal.throwIfAborted();
		const entry = sqlite
			.query<KnowledgeEntryRow, [string]>(
				`SELECT ${selectColumns} FROM knowledge_entries WHERE id = ? LIMIT 1`,
			)
			.get(entryId);
		if (!entry) return null;
		for (const key of jsonColumns) {
			const raw = entry[key];
			if (typeof raw === "string") entry[key] = JSON.parse(raw);
		}
		signal.throwIfAborted();
		return entry;
	})();
}
