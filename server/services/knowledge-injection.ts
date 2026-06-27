import { settings } from "../lib/settings";
import { knowledgeAcl } from "./knowledge-acl";
import { knowledgeService } from "./knowledge-service";

export interface InjectionHit {
	entryId: string;
	title: string;
	summary: string;
}

/** De-dup set of entry ids already injected this turn (caller owns the set). */
export type InjectedSet = Set<string>;

const MAX_SUMMARY_CHARS = 320;
/** Max keyword terms extracted from the input for an OR-match query. */
const MAX_QUERY_TERMS = 12;
/** Lightweight stopword list (EN). CJK has no spaces so it is handled as whole tokens. */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"if",
	"then",
	"for",
	"of",
	"to",
	"in",
	"on",
	"at",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"do",
	"does",
	"did",
	"how",
	"what",
	"why",
	"when",
	"where",
	"which",
	"who",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"with",
	"from",
	"by",
	"as",
	"i",
	"you",
	"he",
	"she",
	"we",
	"they",
	"my",
	"your",
	"can",
	"could",
	"should",
	"would",
	"will",
	"shall",
	"may",
	"might",
	"not",
	"no",
	"yes",
	"please",
	"help",
	"me",
	"about",
	"into",
]);

function summarize(text: string): string {
	const t = text.trim().replace(/\s+/g, " ");
	return t.length > MAX_SUMMARY_CHARS ? `${t.slice(0, MAX_SUMMARY_CHARS)}…` : t;
}

/**
 * Extract candidate keywords from free text for an OR-match FTS query.
 * Drops stopwords and tokens shorter than minKeywordLen, dedups, caps the count.
 * Returns a space-separated query string (empty if nothing useful remains).
 */
function extractKeywords(text: string, minLen: number): string {
	const seen = new Set<string>();
	const out: string[] = [];
	// Split on non-word boundaries but keep CJK runs (treated as single tokens).
	for (const rawTok of text.split(/[^\p{L}\p{N}]+/u)) {
		const tok = rawTok.trim();
		if (!tok) continue;
		const lower = tok.toLowerCase();
		if (seen.has(lower)) continue;
		const hasCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(tok);
		// For latin tokens enforce min length + stopword filter; CJK tokens pass if >= 2 chars.
		if (hasCjk) {
			if (tok.length < 2) continue;
		} else {
			if (tok.length < Math.max(minLen, 3)) continue;
			if (STOPWORDS.has(lower)) continue;
		}
		seen.add(lower);
		out.push(tok);
		if (out.length >= MAX_QUERY_TERMS) break;
	}
	return out.join(" ");
}

/**
 * Resolve knowledge entries relevant to `text` that the given user may read.
 * ACL is applied (dual-axis) — unreadable entries never surface.
 *   - userId: the user who triggered this loop turn (null → anonymous, public only)
 *   - returns at most settings.knowledge.maxInjectedEntries hits, excluding `already`
 */
export async function resolveInjections(
	userId: string | null | undefined,
	text: string,
	opts: { collectionId?: string; already?: InjectedSet } = {},
): Promise<InjectionHit[]> {
	const cfg = settings.knowledge;
	if (cfg.injectMode === "off") return [];
	const raw = (text ?? "").trim();
	if (raw.length < cfg.minKeywordLen) return [];

	// Extract keywords for an OR-match query — the input is usually a sentence
	// or a tool-output blob, so requiring all terms (AND) would rarely match.
	const keywords = extractKeywords(raw, cfg.minKeywordLen);
	if (!keywords) return [];

	// FTS search (service sanitizes the query); over-fetch a bit then ACL-filter.
	const limit = Math.max(cfg.maxInjectedEntries * 3, cfg.maxInjectedEntries);
	let results: Array<{ id: string; title: string; snippet: string; tags?: string[] }>;
	try {
		results = knowledgeService.search({
			q: keywords,
			collectionId: opts.collectionId,
			limit,
			match: "or",
		}) as typeof results;
	} catch {
		return [];
	}
	if (results.length === 0) return [];

	const caps = await knowledgeAcl.resolveCapsByUserId(userId);
	const principal = { userId: caps.userId, role: caps.role };
	const readable = await knowledgeService.filterReadable(principal, results);

	const hits: InjectionHit[] = [];
	for (const r of readable) {
		if (opts.already?.has(r.id)) continue;
		hits.push({ entryId: r.id, title: r.title, summary: summarize(r.snippet ?? "") });
		if (hits.length >= cfg.maxInjectedEntries) break;
	}
	return hits;
}

/** Render injection hits as a system-reminder style block (or null if none). */
export function formatInjections(hits: InjectionHit[], heading: string): string | null {
	if (hits.length === 0) return null;
	return `<knowledge_base_hint>\n${formatInjectionsBare(hits, heading)}\n</knowledge_base_hint>`;
}

/** Render injection hits as plain text (no XML wrapper) — for callers that wrap themselves. */
export function formatInjectionsBare(hits: InjectionHit[], heading: string): string {
	const lines = hits.map((h) => `- [${h.entryId}] ${h.title}: ${h.summary}`);
	return `${heading}\n${lines.join("\n")}\n\n(Use KnowledgeRead with an id for full content.)`;
}

/**
 * Scan a tool output for relevant knowledge and return a reminder block to append, or null.
 * Truncates the output before scanning (performance guard) and respects the de-dup set.
 */
export async function scanToolOutputForKnowledge(
	userId: string | null | undefined,
	output: string,
	already: InjectedSet,
	opts: { collectionId?: string } = {},
): Promise<string | null> {
	const cfg = settings.knowledge;
	if (cfg.injectMode === "off" || !cfg.scanToolOutput) return null;
	if (!output) return null;
	const scanText =
		output.length > cfg.maxToolOutputScanChars
			? output.slice(0, cfg.maxToolOutputScanChars)
			: output;
	const hits = await resolveInjections(userId, scanText, { ...opts, already });
	if (hits.length === 0) return null;
	for (const h of hits) already.add(h.entryId);
	return formatInjectionsBare(
		hits,
		"Relevant knowledge-base entries were found based on the latest tool output:",
	);
}

export const knowledgeInjection = {
	resolveInjections,
	formatInjections,
	formatInjectionsBare,
	scanToolOutputForKnowledge,
};
