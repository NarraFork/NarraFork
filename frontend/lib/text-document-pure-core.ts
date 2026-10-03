import { TEXT_DOCUMENT_PAGE_CHARS } from "@shared/pretext-layout/text-document";
import type { GrammarState } from "shiki";
import type { ShikiModule } from "./shiki-loader";

export interface PhysicalLine {
	start: number;
	end: number;
	next: number;
	stable: boolean;
}
/** Append-only raw pages plus a line index. No normalized/full-document mirror. */
export class PagedTextDocument {
	readonly pages: string[] = [];
	readonly lines: PhysicalLine[] = [{ start: 0, end: 0, next: 0, stable: false }];
	length = 0;
	append(offset: number, text: string) {
		if (offset !== this.length) throw new Error("Worker source gap or duplicate append");
		for (let from = 0; from < text.length; ) {
			const index = Math.floor(this.length / TEXT_DOCUMENT_PAGE_CHARS);
			const count = Math.min(
				TEXT_DOCUMENT_PAGE_CHARS - (this.length % TEXT_DOCUMENT_PAGE_CHARS),
				text.length - from,
			);
			this.pages[index] = (this.pages[index] ?? "") + text.slice(from, from + count);
			this.length += count;
			from += count;
		}
		let tail = this.lines[this.lines.length - 1];
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) !== 10) continue;
			const at = offset + i;
			tail.end = at - (this.slice(at - 1, at) === "\r" ? 1 : 0);
			tail.next = at + 1;
			tail.stable = true;
			tail = { start: at + 1, end: at + 1, next: at + 1, stable: false };
			this.lines.push(tail);
		}
		tail.end = this.length;
		tail.next = this.length;
	}
	slice(start: number, end: number): string {
		if (start < 0) start = 0;
		const parts: string[] = [];
		for (let at = start; at < end; ) {
			const index = Math.floor(at / TEXT_DOCUMENT_PAGE_CHARS);
			const stop = Math.min(end, (index + 1) * TEXT_DOCUMENT_PAGE_CHARS);
			parts.push(
				(this.pages[index] ?? "").slice(
					at % TEXT_DOCUMENT_PAGE_CHARS,
					(at % TEXT_DOCUMENT_PAGE_CHARS) + stop - at,
				),
			);
			at = stop;
		}
		return parts.join("");
	}
}

export interface DocumentToken {
	start: number;
	end: number;
	color?: string;
	fontStyle?: number;
}
export function documentTokensForRange(
	tokens: readonly DocumentToken[],
	start: number,
	end: number,
): DocumentToken[] {
	let lo = 0,
		hi = tokens.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (tokens[mid].end <= start) lo = mid + 1;
		else hi = mid;
	}
	const result: DocumentToken[] = [];
	for (let index = lo; index < tokens.length && tokens[index].start < end; index++) {
		const token = tokens[index];
		if (token.end > start)
			result.push({ ...token, start: Math.max(start, token.start), end: Math.min(end, token.end) });
	}
	return result;
}
export interface TokenStyle {
	color?: string;
	fontStyle?: number;
}
export interface CompactTokens {
	/** Triples: raw start, raw end, palette index. */ data: Uint32Array;
}

/** Stable completed lines retain GrammarState. The incomplete tail always recalls from its start. */
export class IncrementalDocumentTokenizer {
	readonly palette: TokenStyle[] = [];
	private styles = new Map<string, number>();
	readonly stable: CompactTokens[] = [];
	private state?: GrammarState;
	private tail: CompactTokens = { data: new Uint32Array() };
	private tailIndex = -1;
	private highlightedLength = -1;
	private stableBytes = 0;
	tokenizedCharacters = 0;
	constructor(
		private shiki: ShikiModule,
		readonly language: string,
		readonly theme: string,
	) {}

	async update(
		source: PagedTextDocument,
		length = source.length,
		shouldContinue = () => true,
	): Promise<void> {
		if (this.highlightedLength === length) return;
		const first = this.stable.length;
		const lines = source.lines.slice(first).map((line) => ({ ...line }));
		let yielded = performance.now();
		for (let local = 0; local < lines.length; local++) {
			if (!shouldContinue()) return;
			const index = first + local;
			const line = lines[local];
			if (line.start > length) break;
			const end = line.stable && line.next > length ? length : Math.min(line.end, length);
			const text = source.slice(line.start, end);
			// A line is passed WITHOUT its newline: TextMate processes an implicit EOL.
			// Passing '\n' would tokenize a second empty line and corrupt the checkpoint.
			const result = await this.shiki.codeToTokens(text, {
				lang: this.language as Parameters<ShikiModule["codeToTokens"]>[1]["lang"],
				theme: this.theme,
				grammarState: this.state,
				tokenizeMaxLineLength: 0,
				tokenizeTimeLimit: 0,
			});
			this.tokenizedCharacters += text.length;
			const values: number[] = [];
			for (const token of result.tokens[0] ?? []) {
				const key = `${token.color ?? ""}:${token.fontStyle ?? 0}`;
				let style = this.styles.get(key);
				if (style === undefined) {
					style = this.palette.length;
					this.styles.set(key, style);
					this.palette.push({ color: token.color, fontStyle: token.fontStyle });
				}
				values.push(
					line.start + token.offset,
					line.start + token.offset + token.content.length,
					style,
				);
			}
			const tokens = { data: new Uint32Array(values) };
			if (line.stable && line.next <= length) {
				this.stable[index] = tokens;
				this.stableBytes += tokens.data.byteLength + 32;
				this.state = result.grammarState;
			} else {
				this.tail = tokens;
				this.tailIndex = index;
			}
			// Let newer source/targets arrive. One expensive *line* is intentionally atomic.
			if (performance.now() - yielded >= 8) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				yielded = performance.now();
			}
		}
		this.highlightedLength = length;
	}

	range(source: PagedTextDocument, start: number, end: number): DocumentToken[] {
		const output: DocumentToken[] = [];
		let lo = 0,
			hi = source.lines.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (source.lines[mid].next <= start) lo = mid + 1;
			else hi = mid;
		}
		for (let line = lo; line < source.lines.length && source.lines[line].start <= end; line++) {
			const data = (this.stable[line] ?? (line === this.tailIndex ? this.tail : undefined))?.data;
			if (!data) continue;
			// Binary search triples so a million-character line doesn't scan all tokens per viewport.
			let from = 0,
				to = data.length / 3;
			while (from < to) {
				const mid = (from + to) >>> 1;
				if (data[mid * 3 + 1] <= start) from = mid + 1;
				else to = mid;
			}
			for (let i = from * 3; i < data.length && data[i] < end; i += 3) {
				output.push({
					start: Math.max(start, data[i]),
					end: Math.min(end, data[i + 1]),
					...this.palette[data[i + 2]],
				});
			}
		}
		return output;
	}
	get bytes() {
		return this.stableBytes + this.tail.data.byteLength + this.palette.length * 64;
	}
}

/** One active work item + one latest replacement, never a FIFO of obsolete prefixes. */
export class LatestDocumentTask<T> {
	private latest?: T;
	private running = false;
	private cancelled = false;
	maxPending = 0;
	constructor(
		private execute: (target: T) => Promise<void>,
		private onError: (error: unknown, target: T) => void,
	) {}
	push(target: T) {
		if (this.cancelled) return;
		this.latest = target;
		this.maxPending = Math.max(this.maxPending, 1);
		if (!this.running) {
			this.running = true;
			void this.drain();
		}
	}
	cancel() {
		this.cancelled = true;
		this.latest = undefined;
	}
	get active() {
		return this.running;
	}
	get pending() {
		return this.latest === undefined ? 0 : 1;
	}
	private async drain() {
		// Coalesce targets that arrived in the same transport batch.
		await new Promise((resolve) => setTimeout(resolve, 0));
		while (this.latest !== undefined && !this.cancelled) {
			const target = this.latest;
			this.latest = undefined;
			try {
				await this.execute(target);
			} catch (error) {
				this.onError(error, target);
			}
		}
		this.running = false;
	}
}

/** A byte-budgeted LRU for rebuildable derived data; source pages are not part of it. */
export class DerivedDocumentCache<T> {
	private entries = new Map<string, { value: T; bytes: number }>();
	bytes = 0;
	constructor(readonly maxBytes: number) {}
	get(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}
	set(key: string, value: T, bytes: number) {
		this.delete(key);
		// An entry larger than the cache is usable by its running task, not retained globally.
		if (bytes > this.maxBytes) return;
		this.entries.set(key, { value, bytes });
		this.bytes += bytes;
		while (this.bytes > this.maxBytes) {
			const key = this.entries.keys().next().value;
			if (key === undefined) break;
			this.delete(key);
		}
	}
	deletePrefix(prefix: string) {
		for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.delete(key);
	}
	delete(key: string) {
		const entry = this.entries.get(key);
		if (entry) this.bytes -= entry.bytes;
		this.entries.delete(key);
	}
}
