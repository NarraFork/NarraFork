import { settings } from "../lib/settings";
import { knowledgeAcl } from "./knowledge-acl";
import { knowledgeService } from "./knowledge-service";

export interface InjectionHit {
	entryId: string;
	entryRevisionId?: string | null;
	title: string;
	summary: string;
}

export interface KnowledgeHintBlock {
	type: "knowledge_hint";
	entries: InjectionHit[];
	source: "user_message" | "tool_output" | "system_continuation";
	compactSeq: number;
}

export interface ToolOutputKnowledgeScanResult {
	content: string;
	hits: InjectionHit[];
}

/** De-dup set of entry ids already injected this turn (caller owns the set). */
export type InjectedSet = Set<string>;

const MAX_SUMMARY_CHARS = 320;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const WORD_RE = /[\p{L}\p{N}_]/u;

function summarize(text: string): string {
	const t = text.trim().replace(/\s+/g, " ");
	return t.length > MAX_SUMMARY_CHARS ? `${t.slice(0, MAX_SUMMARY_CHARS)}…` : t;
}

type KeywordCandidate = ReturnType<typeof knowledgeService.listKeywordInjectionCandidates>[number];

interface KeywordNeedle {
	keyword: string;
	entries: KeywordCandidate[];
	needsBoundary: boolean;
}

interface TrieNode {
	next: Map<string, number>;
	fail: number;
	out: number[];
}

function normalizeForKeywordMatch(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isNonCjkWordChar(ch: string | undefined): boolean {
	return !!ch && WORD_RE.test(ch) && !CJK_RE.test(ch);
}

function hasKeywordBoundary(
	text: string,
	start: number,
	length: number,
	needsBoundary: boolean,
): boolean {
	if (!needsBoundary) return true;
	return !isNonCjkWordChar(text[start - 1]) && !isNonCjkWordChar(text[start + length]);
}

function buildMatcher(candidates: KeywordCandidate[]): {
	nodes: TrieNode[];
	needles: KeywordNeedle[];
} {
	const nodes: TrieNode[] = [{ next: new Map(), fail: 0, out: [] }];
	const needles: KeywordNeedle[] = [];
	const needleByKeyword = new Map<string, number>();
	const entryIdsByKeyword = new Map<string, Set<string>>();

	for (const entry of candidates) {
		for (const rawKeyword of entry.keywords) {
			const keyword = normalizeForKeywordMatch(rawKeyword);
			if (!keyword) continue;
			let needleIndex = needleByKeyword.get(keyword);
			if (needleIndex === undefined) {
				needleIndex = needles.length;
				needleByKeyword.set(keyword, needleIndex);
				entryIdsByKeyword.set(keyword, new Set());
				needles.push({ keyword, entries: [], needsBoundary: !CJK_RE.test(keyword) });

				let nodeIndex = 0;
				for (const ch of keyword) {
					let nextIndex = nodes[nodeIndex].next.get(ch);
					if (nextIndex === undefined) {
						nextIndex = nodes.length;
						nodes[nodeIndex].next.set(ch, nextIndex);
						nodes.push({ next: new Map(), fail: 0, out: [] });
					}
					nodeIndex = nextIndex;
				}
				nodes[nodeIndex].out.push(needleIndex);
			}

			const entryIds = entryIdsByKeyword.get(keyword);
			if (entryIds && !entryIds.has(entry.id)) {
				entryIds.add(entry.id);
				needles[needleIndex].entries.push(entry);
			}
		}
	}

	const queue: number[] = [];
	for (const child of nodes[0].next.values()) queue.push(child);
	for (let head = 0; head < queue.length; head++) {
		const nodeIndex = queue[head];
		for (const [ch, childIndex] of nodes[nodeIndex].next) {
			let fail = nodes[nodeIndex].fail;
			while (fail !== 0 && !nodes[fail].next.has(ch)) fail = nodes[fail].fail;
			nodes[childIndex].fail = nodes[fail].next.get(ch) ?? 0;
			nodes[childIndex].out.push(...nodes[nodes[childIndex].fail].out);
			queue.push(childIndex);
		}
	}

	return { nodes, needles };
}

interface CompiledMatcher {
	nodes: TrieNode[];
	needles: KeywordNeedle[];
	/** Stable candidate order for deterministic tie-breaking in match results. */
	candidateOrder: Map<string, number>;
}

function compileMatcher(candidates: KeywordCandidate[]): CompiledMatcher {
	const { nodes, needles } = buildMatcher(candidates);
	const candidateOrder = new Map(candidates.map((candidate, index) => [candidate.id, index]));
	return { nodes, needles, candidateOrder };
}

/**
 * Per-scope compiled-matcher cache. Building the Aho-Corasick trie means reading up
 * to 5000 rows + JSON-parsing every keyword list, which is wasteful to redo on every
 * user message and tool output. We key by scope and guard with the candidate-set
 * signature so a cached matcher is reused until the underlying entries change.
 */
interface MatcherCacheEntry {
	signature: string;
	matcher: CompiledMatcher;
}
const matcherCache = new Map<string, MatcherCacheEntry>();
const MATCHER_CACHE_MAX_SCOPES = 64;

function matcherCacheKey(opts: { collectionId?: string; projectId?: string }): string {
	return `${opts.collectionId ?? ""}|${opts.projectId ?? ""}`;
}

function getCompiledMatcher(opts: { collectionId?: string; projectId?: string }): CompiledMatcher {
	const key = matcherCacheKey(opts);
	const signature = knowledgeService.keywordInjectionCandidatesSignature(opts);
	const cached = matcherCache.get(key);
	if (cached && cached.signature === signature) return cached.matcher;

	const candidates = knowledgeService.listKeywordInjectionCandidates(opts);
	const matcher = compileMatcher(candidates);
	// Simple size guard: evict the oldest scope when the cache grows too large. Scopes
	// are (collection, project) tuples, so 64 covers realistic deployments comfortably.
	if (!matcherCache.has(key) && matcherCache.size >= MATCHER_CACHE_MAX_SCOPES) {
		const oldest = matcherCache.keys().next().value;
		if (oldest !== undefined) matcherCache.delete(oldest);
	}
	matcherCache.set(key, { signature, matcher });
	return matcher;
}

function matchWithCompiledMatcher(
	normalizedText: string,
	matcher: CompiledMatcher,
): KeywordCandidate[] {
	const { nodes, needles, candidateOrder } = matcher;
	if (!normalizedText || needles.length === 0) return [];

	const hits = new Map<
		string,
		{ candidate: KeywordCandidate; firstIndex: number; keywordLength: number }
	>();
	let nodeIndex = 0;
	let index = 0;
	for (const ch of normalizedText) {
		while (nodeIndex !== 0 && !nodes[nodeIndex].next.has(ch)) nodeIndex = nodes[nodeIndex].fail;
		nodeIndex = nodes[nodeIndex].next.get(ch) ?? 0;
		for (const needleIndex of nodes[nodeIndex].out) {
			const needle = needles[needleIndex];
			const start = index - needle.keyword.length + 1;
			if (start < 0) continue;
			if (!hasKeywordBoundary(normalizedText, start, needle.keyword.length, needle.needsBoundary)) {
				continue;
			}
			for (const candidate of needle.entries) {
				const existing = hits.get(candidate.id);
				if (
					!existing ||
					start < existing.firstIndex ||
					(start === existing.firstIndex && needle.keyword.length > existing.keywordLength)
				) {
					hits.set(candidate.id, {
						candidate,
						firstIndex: start,
						keywordLength: needle.keyword.length,
					});
				}
			}
		}
		index += ch.length;
	}

	return [...hits.values()]
		.sort(
			(a, b) =>
				a.firstIndex - b.firstIndex ||
				b.keywordLength - a.keywordLength ||
				(candidateOrder.get(a.candidate.id) ?? 0) - (candidateOrder.get(b.candidate.id) ?? 0),
		)
		.map((hit) => hit.candidate);
}

/**
 * Resolve knowledge entries relevant to `text` that the given user may read.
 *
 * Matching is KEYWORD-ONLY and treats knowledge keywords as a dictionary: normalize the
 * input text, scan it once for all declared keywords in the current scope, then ACL-filter
 * the matched entries. This is intentionally NOT an FTS query: passive injection needs
 * "input contains keyword" semantics, while FTS answers the opposite direction
 * ("indexed document contains query").
 *
 * Entries with no keywords are never auto-injected (they remain findable via KnowledgeSearch).
 * ACL is applied (dual-axis) — unreadable entries never surface.
 *   - userId: the user who triggered this loop turn (null → anonymous, public only)
 *   - projectId: restrict to this project's collections + global ones (cross-project isolation)
 *   - returns at most settings.knowledge.maxInjectedEntries hits, excluding `already`
 */
export async function resolveInjections(
	userId: string | null | undefined,
	text: string,
	opts: { collectionId?: string; projectId?: string; already?: InjectedSet } = {},
): Promise<InjectionHit[]> {
	const cfg = settings.knowledge;
	if (cfg.injectMode === "off") return [];
	const normalizedText = normalizeForKeywordMatch(text ?? "");
	if (!normalizedText || normalizedText.length < cfg.minKeywordLen) return [];

	let matcher: CompiledMatcher;
	try {
		matcher = getCompiledMatcher({
			collectionId: opts.collectionId,
			projectId: opts.projectId,
		});
	} catch {
		return [];
	}
	const matched = matchWithCompiledMatcher(normalizedText, matcher);
	if (matched.length === 0) return [];

	const caps = await knowledgeAcl.resolveCapsByUserId(userId);
	const principal = { userId: caps.userId, role: caps.role };
	// Reuse the caps we just resolved so filterReadable doesn't re-query grants.
	const readable = await knowledgeService.filterReadable(principal, matched, { caps });

	const selected: typeof readable = [];
	for (const r of readable) {
		if (opts.already?.has(r.id)) continue;
		selected.push(r);
		if (selected.length >= cfg.maxInjectedEntries) break;
	}
	if (selected.length === 0) return [];

	const snippets = knowledgeService.snippetsByEntryIds(selected.map((r) => r.id));
	return selected.map((r) => ({
		entryId: r.id,
		entryRevisionId: r.entryRevisionId,
		title: r.title,
		summary: summarize(snippets.get(r.id) ?? ""),
	}));
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

export function createKnowledgeHintBlock(
	hits: InjectionHit[],
	source: KnowledgeHintBlock["source"],
	compactSeq: number,
): KnowledgeHintBlock {
	return { type: "knowledge_hint", entries: hits, source, compactSeq };
}

/**
 * Scan a tool output for relevant knowledge and return a reminder block to append, or null.
 * Truncates the output before scanning (performance guard) and respects the de-dup set.
 */
export async function scanToolOutputForKnowledgeDetailed(
	userId: string | null | undefined,
	output: string,
	already: InjectedSet,
	opts: { collectionId?: string; projectId?: string } = {},
): Promise<ToolOutputKnowledgeScanResult | null> {
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
	return {
		hits,
		content: formatInjectionsBare(
			hits,
			"Relevant knowledge-base entries were found based on the latest tool output:",
		),
	};
}

export async function scanToolOutputForKnowledge(
	userId: string | null | undefined,
	output: string,
	already: InjectedSet,
	opts: { collectionId?: string; projectId?: string } = {},
): Promise<string | null> {
	const result = await scanToolOutputForKnowledgeDetailed(userId, output, already, opts);
	return result?.content ?? null;
}

export const knowledgeInjection = {
	resolveInjections,
	formatInjections,
	formatInjectionsBare,
	createKnowledgeHintBlock,
	scanToolOutputForKnowledgeDetailed,
	scanToolOutputForKnowledge,
};
