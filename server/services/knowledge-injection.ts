import { KNOWLEDGE_EXCERPT_MAX_CHARS, knowledgeExcerpt } from "@shared/knowledge-excerpt";
import { formatKnowledgeInjections as formatInjectionsBare } from "@shared/sidecar-body";

export { formatInjectionsBare };

import { settings } from "../lib/settings";
import { knowledgeReadStore } from "./knowledge/store";
import { knowledgeAcl } from "./knowledge-acl";
import { knowledgeInjectionReads, knowledgeService } from "./knowledge-service";

export function injectionKey(hit: { scope?: "personal" | "global"; entryId: string }): string {
	return `${hit.scope ?? "global"}:${hit.entryId}`;
}

function candidateKey(candidate: KeywordCandidate): string {
	return injectionKey({ scope: candidate.scope, entryId: candidate.id });
}

export interface InjectionHit {
	scope?: "personal" | "global";
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

const MAX_SUMMARY_CHARS = KNOWLEDGE_EXCERPT_MAX_CHARS;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const WORD_RE = /[\p{L}\p{N}_]/u;

/**
 * One-line excerpt of an entry body, for the hit's `summary`.
 *
 * ⚠️ This used to be `text.replace(/\s+/g, " ")` and nothing else, which is where the
 * "giant heading" rendering came from: an entry body opens with `# Title`, so collapsing
 * it to one line put the WHOLE excerpt behind that `#` and the reader-facing Markdown
 * projection painted 300 characters at display size, with the body's surviving `>` and
 * backtick markers strewn through it. Markdown has to be stripped, not merely flattened
 * — see `@shared/knowledge-excerpt`.
 *
 * `title` is passed so a body whose first line just repeats the entry title contributes
 * its SECOND line instead; the injection bubble's header already shows the title.
 */
function summarize(text: string, title?: string): string {
	return knowledgeExcerpt(text, { title, maxChars: MAX_SUMMARY_CHARS });
}

type KeywordCandidate = Awaited<
	ReturnType<typeof knowledgeInjectionReads.listKeywordInjectionCandidates>
>[number];

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
			if (entryIds && !entryIds.has(candidateKey(entry))) {
				entryIds.add(candidateKey(entry));
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
	const candidateOrder = new Map(
		candidates.map((candidate, index) => [candidateKey(candidate), index]),
	);
	return { nodes, needles, candidateOrder };
}

/**
 * Per-scope compiled-matcher cache. Building the Aho-Corasick trie means reading up
 * to 5000 rows + JSON-parsing every keyword list, which is wasteful to redo on every
 * user message and tool output. We key by scope and guard with the candidate-set
 * signature so a cached matcher is reused until the underlying entries change.
 */
interface MatcherCacheEntry {
	store: typeof knowledgeReadStore;
	signature: string;
	matcher: CompiledMatcher;
}
const matcherCache = new Map<string, MatcherCacheEntry>();
const MATCHER_CACHE_MAX_SCOPES = 64;

function matcherCacheKey(opts: {
	collectionId?: string;
	projectId?: string;
	userId?: string | null;
}): string {
	return JSON.stringify([opts.collectionId ?? "", opts.projectId ?? "", opts.userId ?? ""]);
}

async function getCompiledMatcher(opts: {
	userId?: string | null;
	collectionId?: string;
	projectId?: string;
	signal?: AbortSignal;
}): Promise<CompiledMatcher> {
	const key = matcherCacheKey(opts);
	const store = knowledgeReadStore;
	const signature = await knowledgeInjectionReads.keywordInjectionCandidatesSignature(opts);
	opts.signal?.throwIfAborted();
	const cached = matcherCache.get(key);
	if (cached?.store === store && cached.signature === signature) return cached.matcher;

	const candidates = await knowledgeInjectionReads.listKeywordInjectionCandidates(opts);
	const matcher = compileMatcher(candidates);
	// Simple size guard: evict the oldest scope when the cache grows too large. Scopes
	// are (collection, project) tuples, so 64 covers realistic deployments comfortably.
	if (!matcherCache.has(key) && matcherCache.size >= MATCHER_CACHE_MAX_SCOPES) {
		const oldest = matcherCache.keys().next().value;
		if (oldest !== undefined) matcherCache.delete(oldest);
	}
	matcherCache.set(key, { store, signature, matcher });
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
				const existing = hits.get(candidateKey(candidate));
				if (
					!existing ||
					start < existing.firstIndex ||
					(start === existing.firstIndex && needle.keyword.length > existing.keywordLength)
				) {
					hits.set(candidateKey(candidate), {
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
				(candidateOrder.get(candidateKey(a.candidate)) ?? 0) -
					(candidateOrder.get(candidateKey(b.candidate)) ?? 0),
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
	opts: {
		collectionId?: string;
		projectId?: string;
		already?: InjectedSet;
		signal?: AbortSignal;
	} = {},
): Promise<InjectionHit[]> {
	const cfg = settings.knowledge;
	if (cfg.injectMode === "off") return [];
	const normalizedText = normalizeForKeywordMatch(text ?? "");
	if (!normalizedText || normalizedText.length < cfg.minKeywordLen) return [];

	const matcher = await getCompiledMatcher({
		userId,
		collectionId: opts.collectionId,
		projectId: opts.projectId,
		signal: opts.signal,
	});
	const matched = matchWithCompiledMatcher(normalizedText, matcher);
	if (matched.length === 0) return [];

	const caps = await knowledgeAcl.resolveCapsByUserId(userId);
	const principal = { userId: caps.userId, role: caps.role };
	// Reuse the caps we just resolved so filterReadable doesn't re-query grants.
	const readableGlobal = await knowledgeService.filterReadable(
		principal,
		matched.filter((r) => r.scope !== "personal"),
		{ caps },
	);
	const readableGlobalIds = new Set(readableGlobal.map((r) => r.id));
	const readable = matched.filter((r) => r.scope === "personal" || readableGlobalIds.has(r.id));

	const selected: typeof readable = [];
	for (const r of readable) {
		if (opts.already?.has(candidateKey(r))) continue;
		selected.push(r);
		if (selected.length >= cfg.maxInjectedEntries) break;
	}
	if (selected.length === 0) return [];

	const snippets = await knowledgeInjectionReads.snippetsByEntryIds(
		selected.filter((r) => r.scope !== "personal").map((r) => r.id),
	);
	const personalSnippets = userId
		? await knowledgeInjectionReads.personalSnippetsByEntryIds(
				userId,
				selected.filter((r) => r.scope === "personal").map((r) => r.id),
			)
		: new Map<string, string>();
	return selected
		.filter((r) => r.scope !== "personal" || personalSnippets.has(r.id))
		.map((r) => ({
			scope: r.scope,
			entryId: r.id,
			entryRevisionId: r.entryRevisionId,
			title: r.title,
			summary: summarize(
				(r.scope === "personal" ? personalSnippets : snippets).get(r.id) ?? "",
				r.title,
			),
		}));
}

/** Render injection hits as a system-reminder style block (or null if none). */
export function formatInjections(hits: InjectionHit[], heading: string): string | null {
	if (hits.length === 0) return null;
	return `<knowledge_base_hint>\n${formatInjectionsBare(hits, heading)}\n</knowledge_base_hint>`;
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
	opts: { collectionId?: string; projectId?: string; signal?: AbortSignal } = {},
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
	for (const h of hits) already.add(injectionKey(h));
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
