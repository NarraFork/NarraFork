import type { Database } from "bun:sqlite";
import { DbReadError } from "../../lib/db-worker/errors";
import type { KnowledgeEntryRow } from "./read-store";

export type KnowledgeEntryDetailRaw = Omit<
	KnowledgeEntryRow,
	"tagsJson" | "keywordsJson" | "metadataJson" | "controlledTagsJson" | "reviewTagsJson"
> & {
	tagsJson: string | null;
	keywordsJson: string | null;
	metadataJson: string | null;
	controlledTagsJson: string | null;
	reviewTagsJson: string | null;
};

// Preserve the existing metadata request allowance and one-million-character body contract.
export const KNOWLEDGE_ENTRY_DETAIL_BYTES = 132 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
const FIELDS = {
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
} as const;

export function readKnowledgeEntryDetail(
	database: Database,
	input: { entryId: string },
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): KnowledgeEntryDetailRaw | null {
	const check = () => {
		if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Knowledge read cancelled");
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "Knowledge read deadline expired");
	};
	check();
	return database.transaction(() => {
		const sizes = database.prepare(
			`SELECT ${Object.entries(FIELDS)
				.map(([name, column]) => `length(CAST(${column} AS BLOB)) AS "${name}"`)
				.join(", ")} FROM knowledge_entries WHERE id = ? LIMIT 1`,
		);
		let lengths: Record<string, number | null> | null;
		try {
			lengths = sizes.get(input.entryId) as typeof lengths;
		} finally {
			sizes.finalize();
		}
		if (!lengths) return null;
		const bytes = Object.values(lengths).reduce<number>((sum, size) => sum + (size ?? 0), 1024);
		if (!Number.isSafeInteger(bytes) || bytes > KNOWLEDGE_ENTRY_DETAIL_BYTES)
			throw new DbReadError("DB_READ_BUDGET", "Knowledge entry exceeds its detail byte budget");
		const result: Record<string, string | null> = {};
		for (const [name, column] of Object.entries(FIELDS)) {
			check();
			const size = lengths[name];
			if (size === null) {
				result[name] = null;
				continue;
			}
			const statement = database.prepare(
				`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS chunk FROM knowledge_entries WHERE id = ? LIMIT 1`,
			);
			const decoder = new TextDecoder();
			const parts: string[] = [];
			try {
				for (let offset = 1; offset <= size; offset += CHUNK_BYTES) {
					check();
					const row = statement.get(offset, CHUNK_BYTES, input.entryId) as { chunk: Uint8Array };
					parts.push(decoder.decode(row.chunk, { stream: true }));
				}
				parts.push(decoder.decode());
				result[name] = parts.join("");
			} finally {
				statement.finalize();
			}
		}
		return result as unknown as KnowledgeEntryDetailRaw;
	})();
}
