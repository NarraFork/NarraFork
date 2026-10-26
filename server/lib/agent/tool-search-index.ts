/** Pure, bounded BM25 index. Authorization is applied before documents reach this module. */
export interface ToolSearchDocument {
	id: string;
	text: string;
	exactNames?: string[];
}
const MAX_DOCUMENTS = 2048;
const MAX_TEXT = 4096;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

export function tokenizeToolSearch(text: string): string[] {
	const normalized = text
		.slice(0, MAX_TEXT)
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.toLowerCase();
	const words: string[] = [];
	for (const part of segmenter.segment(normalized)) {
		if (!part.isWordLike) continue;
		for (const word of part.segment.split(/[_\W]+/u)) {
			if (word) words.push(word);
		}
		// Chinese word segmentation is not whitespace-based. Keep segmented words intact.
		if (/\p{Script=Han}/u.test(part.segment)) words.push(part.segment);
	}
	return words;
}

type Index = {
	documents: { id: string; exactNames: string[]; terms: Map<string, number>; length: number }[];
	df: Map<string, number>;
	average: number;
};

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	signal?.throwIfAborted();
}

export async function searchToolDocuments(
	documents: ToolSearchDocument[],
	query: string,
	limit = 3,
	signal?: AbortSignal,
): Promise<{ id: string; score: number }[]> {
	signal?.throwIfAborted();
	if (documents.length > MAX_DOCUMENTS) throw new Error("Tool search catalog exceeds 2048 tools");
	const df = new Map<string, number>();
	const indexed: Index["documents"] = [];
	// Build a fresh index from the authorized view. Do not stringify the whole catalog
	// for an LRU key: that duplicates every document and retains schemas after changes.
	for (const document of documents) {
		if (indexed.length % 32 === 0) await yieldToEventLoop(signal);
		const bytes = Buffer.from(document.text.slice(0, MAX_TEXT), "utf8");
		const text =
			bytes.length > MAX_TEXT
				? bytes.subarray(0, MAX_TEXT - 3).toString("utf8")
				: bytes.toString("utf8");
		const tokens = tokenizeToolSearch(text);
		const terms = new Map<string, number>();
		for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
		for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
		indexed.push({
			id: document.id.slice(0, 256),
			exactNames: (document.exactNames ?? [document.id])
				.slice(0, 4)
				.map((name) => name.slice(0, 256).toLowerCase()),
			terms,
			length: tokens.length,
		});
	}
	const index: Index = {
		documents: indexed,
		df,
		average: indexed.reduce((n, doc) => n + doc.length, 0) / (indexed.length || 1) || 1,
	};
	const boundedQuery = query.slice(0, 512);
	const terms = [...new Set(tokenizeToolSearch(boundedQuery))];
	const exactQuery = boundedQuery.trim().toLowerCase();
	const count = index.documents.length;
	const grouped = new Map<string, number>();
	let scored = 0;
	for (const doc of index.documents) {
		if (scored++ % 32 === 0) await yieldToEventLoop(signal);
		let score = doc.exactNames.includes(exactQuery) ? 1_000_000 : 0;
		for (const term of terms) {
			const tf = doc.terms.get(term) ?? 0;
			if (!tf) continue;
			const frequency = index.df.get(term) ?? 0;
			const idf = Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
			score += (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * doc.length) / index.average));
		}
		if (score > (grouped.get(doc.id) ?? 0)) grouped.set(doc.id, score);
	}
	return [...grouped]
		.map(([id, score]) => ({ id, score }))
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.min(5, Math.max(1, limit)));
}
