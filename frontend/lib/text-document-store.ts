import {
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRangeReader,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";

export const TEXT_DOCUMENT_CACHE_BYTES = 32 * 1024 * 1024;
export const TEXT_DOCUMENT_READ_TIMEOUT_MS = 10_000;
interface Span {
	start: number;
	text: string;
}
interface Page {
	spans: Span[];
	touched: number;
}
interface Entry {
	ref: TextDocumentRef;
	pages: Map<number, Page>;
	reader?: TextDocumentRangeReader;
	imported?: string;
	listeners: Set<() => void>;
	retains: number;
}

function aborted(signal?: AbortSignal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Sparse UTF-16 pages: overlap is verified, holes are never represented as empty text. */
export class TextDocumentStore {
	private entries = new Map<string, Entry>();
	private bytes = 0;
	private clock = 0;
	constructor(
		private maxBytes = TEXT_DOCUMENT_CACHE_BYTES,
		private readTimeoutMs = TEXT_DOCUMENT_READ_TIMEOUT_MS,
	) {}

	register(ref: TextDocumentRef, reader?: TextDocumentRangeReader): void {
		const old = this.entries.get(ref.id);
		if (!old || old.ref.epoch !== ref.epoch) {
			if (old) for (const page of old.pages.values()) this.bytes -= this.pageBytes(page);
			const entry: Entry = {
				ref: { ...ref },
				pages: new Map(),
				reader,
				listeners: old?.listeners ?? new Set(),
				retains: old?.retains ?? 0,
			};
			this.entries.set(ref.id, entry);
			this.notify(entry);
			return;
		}
		if (reader && old.imported === undefined) {
			old.reader = reader;
			this.evict();
		}
		if (ref.revision < old.ref.revision) return;
		if (ref.length < old.ref.length)
			throw new Error("Document length regressed without a new epoch");
		const complete = ref.complete || old.ref.complete;
		const originKnown = ref.originKnown || old.ref.originKnown;
		if (
			ref.revision === old.ref.revision &&
			ref.length === old.ref.length &&
			complete === old.ref.complete &&
			originKnown === old.ref.originKnown &&
			(ref.source === old.ref.source || !ref.source)
		)
			return;
		old.ref = { ...ref, complete, originKnown, source: ref.source ?? old.ref.source };
		this.notify(old);
	}

	append(ref: TextDocumentRef, offset: number, text: string): void {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset + text.length > ref.length)
			throw new RangeError("Document append lies outside its watermark");
		const current = this.entries.get(ref.id);
		if (current?.ref.epoch === ref.epoch) this.verifyOverlap(current, offset, text);
		if (current?.ref.epoch === ref.epoch && ref.revision < current.ref.revision) {
			// Delayed chunks may fill an earlier hole; never roll metadata back.
			if (this.put(current, offset, text)) this.publishAvailability(current);
			return;
		}
		this.register(ref);
		const entry = this.entry(ref.id);
		if (this.put(entry, offset, text)) this.publishAvailability(entry);
	}

	importText(id: string, text: string, complete = true, epoch?: string): TextDocumentRef {
		const old = this.entries.get(id);
		if (old?.imported === text && (epoch == null || epoch === old.ref.epoch)) {
			if (old.ref.complete !== complete) this.register({ ...old.ref, complete });
			return old.ref;
		}
		// Reconcile an authoritative seal without rebuilding an identical live document.
		if (
			old &&
			(epoch == null || epoch === old.ref.epoch) &&
			old.ref.length === text.length &&
			this.equalsText(id, text)
		) {
			old.imported = text;
			old.reader = async (ref, offset, limit) => ({
				ref,
				offset,
				text: text.slice(offset, offset + limit),
			});
			this.register({ ...old.ref, complete, originKnown: true });
			return old.ref;
		}
		const ref: TextDocumentRef = {
			id,
			epoch: epoch ?? `${id}:${(old?.ref.revision ?? -1) + 1}`,
			revision: (old?.ref.revision ?? -1) + 1,
			length: text.length,
			complete,
			originKnown: true,
		};
		// If the caller explicitly reused an epoch for changed content, make replacement explicit.
		if (old && old.ref.epoch === ref.epoch) ref.epoch = `${ref.epoch}:${ref.revision}`;
		this.register(ref, async (snapshot, offset, limit) => ({
			ref: snapshot,
			offset,
			text: text.slice(offset, offset + limit),
		}));
		const entry = this.entry(id);
		entry.imported = text;
		this.put(entry, 0, text);
		return entry.ref;
	}

	getSnapshot(id: string): TextDocumentRef | undefined {
		const ref = this.entries.get(id)?.ref;
		return ref && ref.revision >= 0 ? ref : undefined;
	}
	private equalsText(id: string, text: string): boolean {
		for (let offset = 0; offset < text.length; offset += TEXT_DOCUMENT_PAGE_CHARS) {
			const end = Math.min(text.length, offset + TEXT_DOCUMENT_PAGE_CHARS);
			if (this.peekRange(id, offset, end) !== text.slice(offset, end)) return false;
		}
		return true;
	}
	subscribe(id: string, listener: () => void): () => void {
		let entry = this.entries.get(id);
		if (!entry) {
			// Subscription may precede registration. Placeholder is not publicly visible.
			this.register({
				id,
				epoch: "",
				revision: -1,
				length: 0,
				complete: false,
				originKnown: false,
			});
			entry = this.entry(id);
		}
		entry.listeners.add(listener);
		return () => this.entries.get(id)?.listeners.delete(listener);
	}

	peekRange(id: string, start: number, end: number): string | undefined {
		const entry = this.entries.get(id);
		if (!entry || start < 0 || end < start || end > entry.ref.length) return undefined;
		if (start === end) return "";
		const parts: string[] = [];
		let offset = start;
		while (offset < end) {
			const index = Math.floor(offset / TEXT_DOCUMENT_PAGE_CHARS);
			const page = entry.pages.get(index);
			const local = offset - index * TEXT_DOCUMENT_PAGE_CHARS;
			const span = page?.spans.find(
				(part) => part.start <= local && part.start + part.text.length > local,
			);
			if (!span || !page) return undefined;
			page.touched = ++this.clock;
			const count = Math.min(end - offset, span.start + span.text.length - local);
			parts.push(span.text.slice(local - span.start, local - span.start + count));
			offset += count;
		}
		return parts.join("");
	}

	async readRange(id: string, start: number, end: number, signal?: AbortSignal): Promise<string> {
		aborted(signal);
		const entry = this.entry(id);
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			end > entry.ref.length
		)
			throw new RangeError("Invalid document range");
		const parts: string[] = [];
		for (let offset = start; offset < end; ) {
			aborted(signal);
			const stop = Math.min(
				end,
				(Math.floor(offset / TEXT_DOCUMENT_PAGE_CHARS) + 1) * TEXT_DOCUMENT_PAGE_CHARS,
			);
			let part = this.peekRange(id, offset, stop);
			if (part === undefined) {
				if (!entry.reader)
					throw new Error("Document source range unavailable; reconnect or reload its detail");
				const epoch = entry.ref.epoch;
				const range = await this.readSource(entry, offset, stop - offset, signal);
				if (this.entries.get(id) !== entry || range.ref.id !== id || range.ref.epoch !== epoch)
					throw new Error("Document source changed while reading");
				if (range.offset > offset || range.offset + range.text.length <= offset)
					throw new Error("Document reader returned no progress");
				this.put(entry, range.offset, range.text);
				// Some servers return a shorter packet. Continue from its actual end.
				const availableEnd = Math.min(stop, range.offset + range.text.length);
				// The freshly read page may itself exceed a tiny test/cache budget.
				// Return the verified source packet directly; eviction cannot erase a read.
				part = range.text.slice(offset - range.offset, availableEnd - range.offset);
			}
			parts.push(part);
			offset += part.length;
		}
		return parts.join("");
	}

	readAll(id: string, signal?: AbortSignal): Promise<string> {
		return this.readRange(id, 0, this.entry(id).ref.length, signal);
	}

	async search(
		id: string,
		query: string,
		start = 0,
		signal?: AbortSignal,
	): Promise<{ start: number; end: number } | null> {
		const length = this.entry(id).ref.length;
		if (!query) return null;
		// Streaming KMP: query and source may cross any page/CRLF/surrogate boundary.
		const failure = new Uint32Array(query.length);
		for (let i = 1, matched = 0; i < query.length; i++) {
			while (matched && query[i] !== query[matched]) matched = failure[matched - 1];
			if (query[i] === query[matched]) matched++;
			failure[i] = matched;
		}
		let matched = 0;
		for (let offset = Math.max(0, start); offset < length; offset += TEXT_DOCUMENT_PAGE_CHARS) {
			const page = await this.readRange(
				id,
				offset,
				Math.min(length, offset + TEXT_DOCUMENT_PAGE_CHARS),
				signal,
			);
			for (let i = 0; i < page.length; i++) {
				while (matched && page[i] !== query[matched]) matched = failure[matched - 1];
				if (page[i] === query[matched]) matched++;
				if (matched === query.length)
					return { start: offset + i + 1 - matched, end: offset + i + 1 };
			}
			if (offset % (TEXT_DOCUMENT_PAGE_CHARS * 16) === 0)
				await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return null;
	}

	retain(id: string): () => void {
		const entry = this.entry(id);
		entry.retains++;
		let released = false;
		return () => {
			if (!released) {
				released = true;
				const current = this.entries.get(id);
				if (current) current.retains = Math.max(0, current.retains - 1);
				this.evict();
			}
		};
	}

	stats() {
		return { bytes: this.bytes, documents: this.entries.size };
	}
	private entry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown document: ${id}`);
		return entry;
	}
	private notify(entry: Entry) {
		for (const listener of entry.listeners) listener();
	}
	private pageBytes(page: Page) {
		return page.spans.reduce((bytes, span) => bytes + span.text.length * 2, 0);
	}
	private verifyOverlap(entry: Entry, offset: number, text: string) {
		for (let consumed = 0; consumed < text.length; ) {
			const index = Math.floor((offset + consumed) / TEXT_DOCUMENT_PAGE_CHARS);
			const start = offset + consumed - index * TEXT_DOCUMENT_PAGE_CHARS;
			const count = Math.min(text.length - consumed, TEXT_DOCUMENT_PAGE_CHARS - start);
			for (const span of entry.pages.get(index)?.spans ?? []) {
				const from = Math.max(start, span.start),
					to = Math.min(start + count, span.start + span.text.length);
				if (
					from < to &&
					text.slice(consumed + from - start, consumed + to - start) !==
						span.text.slice(from - span.start, to - span.start)
				)
					throw new Error("Conflicting document overlap; a replacement must use a new epoch");
			}
			consumed += count;
		}
	}
	private publishAvailability(entry: Entry) {
		// Same server watermark can arrive in several packets. Availability is a
		// document-scoped snapshot change, not a fabricated server revision.
		entry.ref = { ...entry.ref };
		this.notify(entry);
	}
	private put(entry: Entry, offset: number, text: string) {
		let added = false;
		for (let consumed = 0; consumed < text.length; ) {
			const index = Math.floor((offset + consumed) / TEXT_DOCUMENT_PAGE_CHARS);
			const start = offset + consumed - index * TEXT_DOCUMENT_PAGE_CHARS;
			const count = Math.min(text.length - consumed, TEXT_DOCUMENT_PAGE_CHARS - start);
			const incoming = text.slice(consumed, consumed + count);
			const page = entry.pages.get(index) ?? { spans: [], touched: 0 };
			// Check *all* intersections before mutating this page.
			for (const span of page.spans) {
				const from = Math.max(start, span.start),
					to = Math.min(start + count, span.start + span.text.length);
				if (
					from < to &&
					incoming.slice(from - start, to - start) !==
						span.text.slice(from - span.start, to - span.start)
				)
					throw new Error("Conflicting document overlap; a replacement must use a new epoch");
			}
			const before = this.pageBytes(page);
			this.bytes -= before;
			page.spans.push({ start, text: incoming });
			page.spans.sort((a, b) => a.start - b.start);
			const merged: Span[] = [];
			for (const span of page.spans) {
				const prev = merged[merged.length - 1];
				if (prev && span.start <= prev.start + prev.text.length) {
					const overlap = prev.start + prev.text.length - span.start;
					if (overlap < span.text.length) prev.text += span.text.slice(overlap);
				} else merged.push({ ...span });
			}
			page.spans = merged;
			page.touched = ++this.clock;
			entry.pages.set(index, page);
			const after = this.pageBytes(page);
			this.bytes += after;
			added ||= after > before;
			consumed += count;
		}
		this.evict();
		return added;
	}
	private evict() {
		if (this.bytes <= this.maxBytes) return;
		const candidates: { entry: Entry; index: number; page: Page }[] = [];
		for (const entry of this.entries.values()) {
			// Never discard unrecoverable deltas. Reader registration makes them evictable.
			if (!entry.reader) continue;
			for (const [index, page] of entry.pages) candidates.push({ entry, index, page });
		}
		candidates.sort((a, b) => a.page.touched - b.page.touched);
		for (const { entry, index, page } of candidates) {
			if (this.bytes <= this.maxBytes) break;
			entry.pages.delete(index);
			this.bytes -= this.pageBytes(page);
		}
	}
	private async readSource(entry: Entry, offset: number, limit: number, signal?: AbortSignal) {
		const controller = new AbortController();
		const cancel = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", cancel, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				entry.reader?.(entry.ref, offset, limit, controller.signal) ??
					Promise.reject(new Error("Missing reader")),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error("Document source read timed out (10s); retry available"));
						controller.abort();
					}, this.readTimeoutMs);
					controller.signal.addEventListener(
						"abort",
						() => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
	}
}

export const textDocumentStore = new TextDocumentStore();
