import {
	EDITOR_WORKER_LIMITS as L,
	type ReplacePlan,
	type SearchOptions,
	type SearchPage,
	type TextEdit,
	type TextMatch,
} from "./editor-worker-protocol";

/** Immutable rope. Edits retain untouched chunks instead of expanding the document. */
export class EditorText {
	readonly chunks: readonly string[];
	readonly length: number;
	private readonly starts: number[] = [];
	constructor(chunks: readonly string[]) {
		const compact: string[] = [];
		let parts: string[] = [];
		let pendingLength = 0;
		const flush = () => {
			if (parts.length) compact.push(parts.join(""));
			parts = [];
			pendingLength = 0;
		};
		for (const chunk of chunks) {
			for (let offset = 0; offset < chunk.length; offset += L.chunkBytes / 2) {
				const part = chunk.slice(offset, offset + L.chunkBytes / 2);
				if (pendingLength + part.length > L.chunkBytes / 2) flush();
				parts.push(part);
				pendingLength += part.length;
				if (pendingLength === L.chunkBytes / 2) flush();
			}
		}
		flush();
		this.chunks = compact;
		let length = 0;
		for (const chunk of this.chunks) {
			this.starts.push(length);
			length += chunk.length;
		}
		if (length > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
		this.length = length;
	}
	private chunkAt(offset: number): number {
		let low = 0;
		let high = this.starts.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (this.starts[mid] <= offset) low = mid + 1;
			else high = mid;
		}
		return low - 1;
	}
	charAt(offset: number): string {
		if (offset < 0 || offset >= this.length) return "";
		const index = this.chunkAt(offset);
		return this.chunks[index].charAt(offset - this.starts[index]);
	}
	sliceChunks(start: number, end: number): string[] {
		const result: string[] = [];
		for (let i = Math.max(0, this.chunkAt(start)); i < this.chunks.length; i++) {
			const base = this.starts[i];
			if (base >= end) break;
			const part = this.chunks[i].slice(Math.max(0, start - base), end - base);
			if (part) result.push(part);
		}
		return result;
	}
	apply(edits: readonly TextEdit[]): EditorText {
		let cursor = 0;
		let length = this.length;
		const chunks: string[] = [];
		for (const edit of edits) {
			if (
				!Number.isSafeInteger(edit.offset) ||
				!Number.isSafeInteger(edit.length) ||
				edit.offset < cursor ||
				edit.length < 0 ||
				edit.offset + edit.length > this.length
			) {
				throw new Error("EDITOR_PROTOCOL");
			}
			length += edit.text.length - edit.length;
			chunks.push(...this.sliceChunks(cursor, edit.offset));
			for (let i = 0; i < edit.text.length; i += L.chunkBytes / 2)
				chunks.push(edit.text.slice(i, i + L.chunkBytes / 2));
			cursor = edit.offset + edit.length;
		}
		if (length > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
		chunks.push(...this.sliceChunks(cursor, this.length));
		return new EditorText(chunks);
	}
	flatten(): string {
		return this.chunks.join("");
	}
}

const word = /[\p{L}\p{N}\p{M}_]/u;
function wholeWord(text: EditorText, offset: number, length: number): boolean {
	let before = text.charAt(offset - 1);
	if (before && /[\uDC00-\uDFFF]/.test(before)) before = text.charAt(offset - 2) + before;
	let after = text.charAt(offset + length);
	if (after && /[\uD800-\uDBFF]/.test(after)) after += text.charAt(offset + length + 1);
	return !word.test(before) && !word.test(after);
}
function validateQuery(options: SearchOptions): void {
	if (typeof options.query !== "string" || options.query.length > L.queryLength)
		throw new Error("EDITOR_QUERY_LIMIT");
}
function cooperativeYield(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Regex sees exactly one full string; literal KMP streams across rope boundaries. */
async function scan(
	text: EditorText,
	options: SearchOptions,
	visit: (match: TextMatch, captured?: RegExpExecArray, source?: string) => boolean,
): Promise<void> {
	validateQuery(options);
	if (!options.query) return;
	let sliceStart = performance.now();
	if (options.regexp) {
		const source = text.flatten();
		let expression: RegExp;
		try {
			expression = new RegExp(options.query, options.caseSensitive ? "gmu" : "gimu");
		} catch {
			throw new Error("EDITOR_INVALID_REGEX");
		}
		for (;;) {
			const match = expression.exec(source);
			if (!match) break;
			if (
				(!options.wholeWord || wholeWord(text, match.index, match[0].length)) &&
				!visit({ offset: match.index, length: match[0].length }, match, source)
			)
				return;
			if (match[0].length === 0) {
				// AdvanceStringIndex in Unicode mode, including empty matches at EOF.
				expression.lastIndex += (source.codePointAt(expression.lastIndex) ?? 0) > 0xffff ? 2 : 1;
			}
			if (performance.now() - sliceStart >= 8) {
				await cooperativeYield();
				sliceStart = performance.now();
			}
		}
		return;
	}
	// Preserve the old SearchCursor contract: NFKD plus optional lowercase, applied
	// per original code point. Mapping rings retain UTF-16 source offsets even when
	// normalization expands a glyph (e.g. İ or ﬀ); the whole document is never folded.
	const normalize = (value: string) => {
		const normalized = value.normalize("NFKD");
		return options.caseSensitive ? normalized : normalized.toLowerCase();
	};
	const query = normalize(options.query);
	if (!query.length) return;
	const asciiQuery = /^\p{ASCII}+$/u.test(query);
	const prefix = new Int32Array(query.length);
	const starts = new Int32Array(query.length);
	const preciseStarts = new Uint8Array(query.length);
	for (let i = 1, j = 0; i < query.length; i++) {
		while (j && query[i] !== query[j]) j = prefix[j - 1];
		if (query[i] === query[j]) j++;
		prefix[i] = j;
	}
	const normalizedPoints = new Map<string, string>();
	let matched = 0;
	let offset = 0;
	let normalizedOffset = 0;
	let sinceYield = 0;
	let skip = 0;
	for (const chunk of text.chunks) {
		let i = skip;
		skip = 0;
		if (matched === 0) {
			let probe = chunk.slice(i);
			let extra = 0;
			if (/[\uD800-\uDBFF]$/.test(probe)) {
				const next = text.charAt(offset + probe.length);
				if (/[\uDC00-\uDFFF]/.test(next)) {
					probe += next;
					extra = 1;
				}
			}
			const folded = normalize(probe);
			// Whole-string lowercase has one contextual rule (final sigma). Include
			// that variant so this *negative-only* filter cannot hide per-point matches.
			if (!folded.includes(query[0]) && !(query[0] === "σ" && folded.includes("ς"))) {
				offset += chunk.length - i + extra;
				skip = extra;
				if (performance.now() - sliceStart >= 8) {
					await cooperativeYield();
					sliceStart = performance.now();
				}
				continue;
			}
			// Native indexOf is safe for ASCII queries only when every original
			// non-ASCII point keeps its width and cannot expose a partial ASCII glyph.
			// This retains source offsets without a per-ASCII-character KMP loop.
			let directOffsets = asciiQuery;
			if (directOffsets) {
				for (const match of probe.matchAll(/\P{ASCII}/gu)) {
					const point = match[0];
					let normalized = normalizedPoints.get(point);
					if (normalized === undefined) {
						normalized = normalize(point);
						if (normalizedPoints.size >= 2048) normalizedPoints.clear();
						normalizedPoints.set(point, normalized);
					}
					if (
						normalized.length !== point.length ||
						(point.length > 1 && /\p{ASCII}/u.test(normalized))
					) {
						directOffsets = false;
						break;
					}
				}
			}
			if (directOffsets) {
				let cursor = 0;
				for (;;) {
					const found = folded.indexOf(query, cursor);
					if (found < 0) break;
					const start = offset + found;
					if (!options.wholeWord || wholeWord(text, start, query.length)) {
						if (!visit({ offset: start, length: query.length })) return;
						cursor = found + query.length;
					} else cursor = found + 1;
					if (performance.now() - sliceStart >= 8) {
						await cooperativeYield();
						sliceStart = performance.now();
					}
				}
				let tail = Math.max(cursor, probe.length - query.length + 1);
				if (
					tail > 0 &&
					/[\uDC00-\uDFFF]/.test(probe[tail] ?? "") &&
					/[\uD800-\uDBFF]/.test(probe[tail - 1])
				)
					tail--;
				offset += tail;
				i += tail;
				if (i >= chunk.length) {
					skip = i - chunk.length;
					if (performance.now() - sliceStart >= 8) {
						await cooperativeYield();
						sliceStart = performance.now();
					}
					continue;
				}
			}
			// With no combining marks or contextual sigma, chunk normalization is
			// concatenative. A negative full-query check can skip its prefix, retaining
			// enough original code points to detect every possible cross-chunk match.
			if (
				!folded.includes(query) &&
				!/\p{M}/u.test(folded) &&
				(options.caseSensitive || !/[σς]/.test(query))
			) {
				let stop = Math.max(i, chunk.length - query.length * 2 - 2);
				if (
					stop > i &&
					/[\uDC00-\uDFFF]/.test(chunk[stop]) &&
					/[\uD800-\uDBFF]/.test(chunk[stop - 1])
				)
					stop--;
				offset += stop - i;
				i = stop;
			}
		}
		while (i < chunk.length) {
			const first = chunk.charCodeAt(i);
			let point = chunk[i];
			if (first >= 0xd800 && first <= 0xdbff) {
				const next = i + 1 < chunk.length ? chunk[i + 1] : text.charAt(offset + 1);
				const low = next.charCodeAt(0);
				if (low >= 0xdc00 && low <= 0xdfff) point += next;
			}
			let normalized: string;
			if (first < 128) {
				normalized =
					!options.caseSensitive && first >= 65 && first <= 90
						? String.fromCharCode(first + 32)
						: point;
			} else {
				const cached = normalizedPoints.get(point);
				if (cached !== undefined) normalized = cached;
				else {
					normalized = normalize(point);
					if (normalizedPoints.size >= 2048) normalizedPoints.clear();
					normalizedPoints.set(point, normalized);
				}
			}
			const end = offset + point.length;
			let position = offset;
			let positionPrecise = true;
			for (let n = 0; n < normalized.length; n++) {
				const char = normalized[n];
				starts[normalizedOffset % query.length] = position;
				preciseStarts[normalizedOffset % query.length] = positionPrecise ? 1 : 0;
				while (matched && char !== query[matched]) matched = prefix[matched - 1];
				if (char === query[matched]) matched++;
				normalizedOffset++;
				if (matched === query.length) {
					const index = (normalizedOffset - query.length) % query.length;
					const start = starts[index];
					if (!options.wholeWord || wholeWord(text, start, end - start)) {
						const precise = !!preciseStarts[index] && n === normalized.length - 1;
						if (
							!visit({ offset: start, length: end - start, ...(precise ? {} : { precise: false }) })
						)
							return;
						matched = 0;
						break; // Non-overlap also skips the rest of an expanded original glyph.
					}
					matched = prefix[matched - 1];
				}
				if (positionPrecise && n < point.length && point[n] === char) position++;
				else positionPrecise = false;
			}
			offset = end;
			i += point.length;
			if (i > chunk.length) skip = i - chunk.length;
			if (++sinceYield >= 4096) {
				sinceYield = 0;
				if (performance.now() - sliceStart >= 8) {
					await cooperativeYield();
					sliceStart = performance.now();
				}
			}
		}
	}
}

export async function searchText(
	text: EditorText,
	options: SearchOptions,
	anchor = 0,
	backwards = false,
	selectAll = false,
): Promise<SearchPage> {
	const limit = selectAll ? L.selectAll : L.page;
	const matches: TextMatch[] = [];
	const wrapped: TextMatch[] = [];
	let count = 0;
	let matchCursor = 0;
	let wrappedCursor = 0;
	await scan(text, options, (match) => {
		count = Math.min(L.cache + 1, count + 1);
		if (selectAll && count > L.selectAll) throw new Error("EDITOR_SELECT_LIMIT");
		const direct = selectAll || (backwards ? match.offset < anchor : match.offset >= anchor);
		const bucket = direct ? matches : wrapped;
		if (backwards) {
			const cursor = direct ? matchCursor++ : wrappedCursor++;
			bucket[cursor % limit] = match;
		} else if (bucket.length < limit) bucket.push(match);
		// Once the capped statistic and requested page are known, no full-match cache is needed.
		return !(
			count > L.cache &&
			((!backwards && matches.length === limit) ||
				(backwards && matches.length > 0 && match.offset >= anchor))
		);
	});
	let selected = matches.length ? matches : wrapped;
	if (backwards) {
		const cursor = matches.length ? matchCursor : wrappedCursor;
		const start = cursor >= limit ? cursor % limit : 0;
		selected = [...selected.slice(start), ...selected.slice(0, start)].reverse();
	}
	return { matches: selected, count: Math.min(count, L.cache), more: count > L.cache };
}

/** JS replacement substitution without repeating the regular expression. */
function substitute(replacement: string, match: RegExpExecArray, source: string): string {
	const expand = (token: string, key: string): string => {
		if (key === "$") return "$";
		if (key === "&") return match[0];
		if (key === "`") return source.slice(0, match.index);
		if (key === "'") return source.slice(match.index + match[0].length);
		if (key[0] === "<") return match.groups ? (match.groups[key.slice(1, -1)] ?? "") : token;
		const index = Number(key);
		if (index > 0 && index < match.length) return match[index] ?? "";
		if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.length)
			return (match[Number(key[0])] ?? "") + key[1];
		return token;
	};
	const parts: string[] = [];
	let offset = 0;
	let length = 0;
	for (const token of replacement.matchAll(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g)) {
		const literal = replacement.slice(offset, token.index);
		const value = expand(token[0], token[1]);
		length += literal.length + value.length;
		if (length > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
		parts.push(literal, value);
		offset = token.index + token[0].length;
	}
	const rest = replacement.slice(offset);
	if (length + rest.length > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
	parts.push(rest);
	return parts.join("");
}

/** Streaming UTF-8 encoder carries a high surrogate across input chunk boundaries. */
export async function encodeText(
	text: EditorText,
	retain = true,
	onChunk?: (chunk: Uint8Array) => void,
): Promise<{ chunks: Uint8Array[]; bytes: number }> {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	let carry = "";
	let bytes = 0;
	let sliceStart = performance.now();
	for (let index = 0; index <= text.chunks.length; index++) {
		let value = carry + (text.chunks[index] ?? "");
		carry = "";
		if (index < text.chunks.length && /[\uD800-\uDBFF]$/.test(value)) {
			carry = value.slice(-1);
			value = value.slice(0, -1);
		}
		// In Unicode mode a valid surrogate pair is one astral code point, outside
		// this range. Reject lone units before TextEncoder could repair them to U+FFFD.
		if (/[\uD800-\uDFFF]/u.test(value)) throw new Error("EDITOR_INVALID_UNICODE");
		for (let offset = 0; offset < value.length; ) {
			let end = Math.min(value.length, offset + 16000);
			if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
			const encoded = encoder.encode(value.slice(offset, end));
			offset = end;
			bytes += encoded.byteLength;
			if (bytes > L.utf8Bytes) throw new Error("EDITOR_UTF8_LIMIT");
			onChunk?.(encoded);
			if (retain) chunks.push(encoded);
		}
		if (performance.now() - sliceStart >= 8) {
			await cooperativeYield();
			sliceStart = performance.now();
		}
	}
	return { chunks, bytes };
}

export async function replaceText(
	text: EditorText,
	options: SearchOptions,
	replacement: string,
	all: boolean,
	anchor: number,
	revision: number,
): Promise<ReplacePlan> {
	if (replacement.length > L.queryLength) throw new Error("EDITOR_QUERY_LIMIT");
	const edits: TextEdit[] = [];
	let first: TextEdit | undefined;
	let addedLength = 0;
	await scan(text, options, (match, captured, source) => {
		if (match.precise === false) return true;
		const value =
			options.regexp && captured && source !== undefined
				? substitute(replacement, captured, source)
				: replacement;
		const edit = { ...match, text: value };
		if (!all) {
			first ??= edit;
			if (match.offset < anchor) return true;
			edits.push(edit);
			return false;
		}
		edits.push(edit);
		addedLength += value.length;
		if (edits.length > L.replaceAll) throw new Error("EDITOR_REPLACE_LIMIT");
		if (addedLength > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
		return true;
	});
	if (!all && !edits.length && first) edits.push(first);
	const result = text.apply(edits);
	const { bytes } = await encodeText(result, false);
	return { revision, edits, length: result.length, utf8Bytes: bytes };
}
