import { logger } from "../../lib/logger";
import { knowledgeService } from "../knowledge-service";
import { sanitizeQuery } from "../search/query";
import type { KnowledgeEvidence, KnowledgeEvidenceOptions } from "./injection-evidence";
import { candidateKey, type KeywordCandidate, normalizeForKeywordMatch } from "./keyword-index";

const MAX_QUERY_CHARS = 512;
const MAX_QUERY_TERMS = 8;
const MAX_FULL_TEXT_HITS = 50;
const SEARCH_BUDGET_MS = 750;

export interface FullTextEvidence extends KeywordCandidate {
	snippet: string;
}

/** A bounded query, never an empty browse-all request. Short words remain dictionary-only. */
export function knowledgeHybridQuery(text: string): string {
	const terms = sanitizeQuery(text).split(/\s+/);
	const selected: string[] = [];
	const seen = new Set<string>();
	let length = 0;
	for (const term of terms) {
		if (term.length < 3 || term.length > 64 || seen.has(term) || !/[\p{L}\p{N}]/u.test(term))
			continue;
		if (length + term.length + selected.length > MAX_QUERY_CHARS) break;
		seen.add(term);
		selected.push(term);
		length += term.length;
		if (selected.length >= MAX_QUERY_TERMS) break;
	}
	return selected.join(" ");
}

/** Search is advisory; failure costs only the full-text channel, never exact keyword evidence. */
export async function retrieveFullTextEvidence(
	text: string,
	opts: KnowledgeEvidenceOptions,
): Promise<FullTextEvidence[]> {
	opts.signal?.throwIfAborted();
	const q = knowledgeHybridQuery(text);
	if (!q) return [];
	const controller = new AbortController();
	const signal = opts.signal
		? AbortSignal.any([opts.signal, controller.signal])
		: controller.signal;
	const timer = setTimeout(
		() => controller.abort(new Error("Knowledge search budget exceeded")),
		SEARCH_BUDGET_MS,
	);
	let onAbort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const rows = await Promise.race([
			knowledgeService.search({
				q,
				collectionId: opts.collectionId,
				projectId: opts.projectId,
				limit: MAX_FULL_TEXT_HITS,
				match: "or",
				sort: "relevance",
				signal,
			}),
			cancelled,
		]);
		signal.throwIfAborted();
		return rows.flatMap((row) => {
			if (
				row.fromDraft ||
				row.personalEntryId ||
				row.status !== "active" ||
				!row.collectionId ||
				row.entryRevisionId === undefined
			)
				return [];
			return [
				{
					scope: "global" as const,
					id: row.id,
					collectionId: row.collectionId,
					title: row.title,
					entryRevisionId: row.entryRevisionId,
					tags: row.tags,
					keywords: [],
					updatedAt: row.updatedAt,
					snippet: row.snippet,
				},
			];
		});
	} catch {
		opts.signal?.throwIfAborted();
		logger.warn("Knowledge full-text recall unavailable; retaining keyword candidates", {
			timedOut: controller.signal.aborted,
		});
		return [];
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** Declared keywords outrank title evidence, which outranks body-only matches.
 * Reciprocal rank combines the channels without comparing backend-specific rank magnitudes. */
export function rankKnowledgeCandidates<T extends KeywordCandidate>(
	text: string,
	keywords: readonly T[],
	fullText: readonly T[],
): T[] {
	const rows = new Map<string, { row: T; score: number }>();
	for (const [channel, candidates] of [
		["keywords", keywords],
		["fullText", fullText],
	] as const) {
		candidates.forEach((row, index) => {
			const key = candidateKey(row);
			const score = (channel === "keywords" ? 1000 : 0) + 1 / (60 + index + 1);
			const existing = rows.get(key);
			if (existing) existing.score += score;
			else rows.set(key, { row, score });
		});
	}
	for (const value of rows.values()) {
		const title = normalizeForKeywordMatch(value.row.title);
		if (title === text) value.score += 500;
		else if (text && title.includes(text)) value.score += 100;
	}
	return [...rows.values()]
		.sort((a, b) => {
			const difference = b.score - a.score;
			if (difference) return difference;
			if (a.row.updatedAt !== b.row.updatedAt) return a.row.updatedAt > b.row.updatedAt ? -1 : 1;
			const left = candidateKey(a.row),
				right = candidateKey(b.row);
			return left < right ? -1 : left > right ? 1 : 0;
		})
		.map(({ row }) => row);
}

export function isCurrentFullTextEvidence(
	hit: FullTextEvidence,
	current: KnowledgeEvidence,
): boolean {
	return (
		hit.scope === current.scope &&
		hit.id === current.id &&
		hit.entryRevisionId === current.entryRevisionId &&
		hit.updatedAt === current.updatedAt &&
		hit.title === current.title &&
		hit.collectionId === current.collectionId
	);
}
