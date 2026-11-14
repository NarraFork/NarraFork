const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const WORD_RE = /[\p{L}\p{N}_]/u;

export function candidateKey(candidate: { scope: "global" | "personal"; id: string }): string {
	return `${candidate.scope}:${candidate.id}`;
}
export interface KeywordCandidate {
	scope: "global" | "personal";
	id: string;
	collectionId: string;
	title: string;
	entryRevisionId: string | null;
	tags: string[];
	keywords: string[];
	updatedAt: string;
}

export interface KeywordMatcherTask {
	kind: "knowledgeKeywordMatcher";
	candidates: KeywordCandidate[];
}

export const KEYWORD_INDEX_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 65_536;
const MAX_OUTPUTS = 65_536;
const MAX_ASSOCIATIONS = 32_768;

function budgetExceeded(): never {
	throw new Error("Knowledge keyword index budget exceeded");
}

/** Check before structured clone as well as in the worker; never clone an unbounded dictionary. */
export function assertKeywordCandidateBudget(candidates: readonly KeywordCandidate[]): number {
	if (candidates.length > 5000) budgetExceeded();
	let chars = 0;
	for (const row of candidates) {
		if (row.keywords.length > 128 || row.tags.length > 128) budgetExceeded();
		for (const value of [
			row.id,
			row.collectionId,
			row.title,
			row.entryRevisionId ?? "",
			row.updatedAt,
			...row.tags,
			...row.keywords,
		]) {
			if (value.length > 1024) budgetExceeded();
			chars += value.length;
			if (chars > KEYWORD_INDEX_MAX_INPUT_BYTES) budgetExceeded();
		}
		if (row.keywords.some((keyword) => keyword.length > 512)) budgetExceeded();
	}
	const bytes = new TextEncoder().encode(JSON.stringify(candidates)).byteLength;
	if (bytes > KEYWORD_INDEX_MAX_INPUT_BYTES) budgetExceeded();
	return bytes;
}

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

export function normalizeForKeywordMatch(text: string): string {
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
	let associations = 0;
	let outputs = 0;

	for (const entry of candidates) {
		for (const rawKeyword of entry.keywords) {
			const keyword = normalizeForKeywordMatch(rawKeyword);
			if (!keyword) continue;
			if (keyword.length > 512) budgetExceeded();
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
						if (nextIndex >= MAX_NODES) budgetExceeded();
						nodes[nodeIndex].next.set(ch, nextIndex);
						nodes.push({ next: new Map(), fail: 0, out: [] });
					}
					nodeIndex = nextIndex;
				}
				nodes[nodeIndex].out.push(needleIndex);
				if (++outputs > MAX_OUTPUTS) budgetExceeded();
			}

			const entryIds = entryIdsByKeyword.get(keyword);
			if (entryIds && !entryIds.has(candidateKey(entry))) {
				if (++associations > MAX_ASSOCIATIONS) budgetExceeded();
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
			outputs += nodes[nodes[childIndex].fail].out.length;
			if (outputs > MAX_OUTPUTS) budgetExceeded();
			nodes[childIndex].out.push(...nodes[nodes[childIndex].fail].out);
			queue.push(childIndex);
		}
	}

	return { nodes, needles };
}

export interface CompiledMatcher {
	inputBytes: number;
	nodes: TrieNode[];
	needles: KeywordNeedle[];
	/** Stable candidate order for deterministic tie-breaking in match results. */
	candidateOrder: Map<string, number>;
}

export function compileMatcher(candidates: KeywordCandidate[]): CompiledMatcher {
	const inputBytes = assertKeywordCandidateBudget(candidates);
	const { nodes, needles } = buildMatcher(candidates);
	const candidateOrder = new Map(
		candidates.map((candidate, index) => [candidateKey(candidate), index]),
	);
	return { nodes, needles, candidateOrder, inputBytes };
}
export function matchWithCompiledMatcher(
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
	let work = 0;
	// A short input with many overlapping dictionary words must not multiply into an unbounded scan.
	if (normalizedText.length > 64 * 1024) return [];
	for (const ch of normalizedText) {
		while (nodeIndex !== 0 && !nodes[nodeIndex].next.has(ch)) nodeIndex = nodes[nodeIndex].fail;
		nodeIndex = nodes[nodeIndex].next.get(ch) ?? 0;
		for (const needleIndex of nodes[nodeIndex].out) {
			if (++work > 65_536) return [];
			const needle = needles[needleIndex];
			const start = index - needle.keyword.length + 1;
			if (start < 0) continue;
			if (!hasKeywordBoundary(normalizedText, start, needle.keyword.length, needle.needsBoundary)) {
				continue;
			}
			for (const candidate of needle.entries) {
				if (++work > 65_536) return [];
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
