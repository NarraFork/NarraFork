import type { KnowledgeInjectionEvidenceQuery } from "./read-store";
import { knowledgeReadStore } from "./store";

export interface KnowledgeEvidence {
	scope: "global" | "personal";
	id: string;
	collectionId: string;
	title: string;
	entryRevisionId: string | null;
	tags: string[];
	keywords: string[];
	updatedAt: string;
	snippet: string;
}

export interface KnowledgeEvidenceOptions {
	userId?: string | null;
	collectionId?: string;
	projectId?: string;
	signal?: AbortSignal;
}

export const MAX_KNOWLEDGE_EVIDENCE_CANDIDATES = 100;

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** The dictionary only discovers ids. Text, revision, keywords and scope come from current rows. */
export async function readKnowledgeEvidence(
	candidates: readonly { scope: "global" | "personal"; id: string }[],
	opts: KnowledgeEvidenceOptions,
): Promise<KnowledgeEvidence[]> {
	const selected = candidates.slice(0, MAX_KNOWLEDGE_EVIDENCE_CANDIDATES);
	const out: KnowledgeEvidence[] = [];
	for (const scope of ["global", "personal"] as const) {
		opts.signal?.throwIfAborted();
		const ids = selected.filter((row) => row.scope === scope).map((row) => row.id);
		if (ids.length === 0 || (scope === "personal" && !opts.userId)) continue;
		const query: KnowledgeInjectionEvidenceQuery = {
			scope,
			ids,
			userId: opts.userId,
			collectionId: opts.collectionId,
			projectId: opts.projectId,
		};
		const rows = await knowledgeReadStore.getInjectionEvidence(query);
		opts.signal?.throwIfAborted();
		for (const row of rows) {
			out.push({
				scope,
				id: row.id,
				collectionId: row.collectionId,
				title: row.title,
				entryRevisionId: row.currentRevisionId,
				tags: stringArray(row.tagsJson),
				keywords: stringArray(row.keywordsJson),
				updatedAt: row.updatedAt,
				snippet: row.snippet ?? "",
			});
		}
	}
	return out;
}

/** A changed row is omitted, not silently relabelled after the final authorization check. */
export function sameKnowledgeEvidence(a: KnowledgeEvidence, b: KnowledgeEvidence): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
