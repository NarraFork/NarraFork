import {
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRangeReader,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";

export const TEXT_DOCUMENT_CACHE_BYTES = 32 * 1024 * 1024;
export const TEXT_DOCUMENT_READ_TIMEOUT_MS = 10_000;
export const TEXT_DOCUMENT_IMPORTED_BYTES = 8 * 1024 * 1024;
export const TEXT_DOCUMENT_IDLE_LIMIT = 128;
export interface TextDocumentStoreLimits {
	maxImportedBytes?: number;
	maxIdleDocuments?: number;
}
interface Span {
	start: number;
	text: string;
}
interface Page {
	spans: Span[];
	touched: number;
}
interface Observers {
	listeners: Set<() => void>;
	retains: number;
}
interface Entry {
	ref: TextDocumentRef;
	pages: Map<number, Page>;
	pageBytes: number;
	reader?: TextDocumentRangeReader;
	imported?: string;
	observers: Observers;
	sourceOwners: number;
	activeReads: number;
	discarded: boolean;
}

function aborted(signal?: AbortSignal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Sparse UTF-16 pages: overlap is verified, holes are never represented as empty text. */
export class TextDocumentStore {
	private entries = new Map<string, Entry>();
	// Insertion order supplies LRU without collecting/sorting all cached pages on a hot path.
	private idleEntries = new Map<string, Entry>();
	private evictableIdleEntries = new Map<string, Entry>();
	private pageLru = new Map<Page, { entry: Entry; index: number }>();
	private bytes = 0;
	private importedBytes = 0;
	private clock = 0;
	private importSequence = 0;
	private maxImportedBytes: number;
	private maxIdleDocuments: number;
	constructor(
		private maxBytes = TEXT_DOCUMENT_CACHE_BYTES,
		private readTimeoutMs = TEXT_DOCUMENT_READ_TIMEOUT_MS,
		limits: TextDocumentStoreLimits = {},
	) {
		this.maxImportedBytes = limits.maxImportedBytes ?? TEXT_DOCUMENT_IMPORTED_BYTES;
		this.maxIdleDocuments = limits.maxIdleDocuments ?? TEXT_DOCUMENT_IDLE_LIMIT;
	}

	register(ref: TextDocumentRef, reader?: TextDocumentRangeReader): void {
		const old = this.entries.get(ref.id);
		if (!old || old.ref.epoch !== ref.epoch) {
			if (old) this.clearSource(old);
			const entry: Entry = {
				ref: { ...ref },
				pages: new Map(),
				pageBytes: 0,
				reader,
				observers: old?.observers ?? { listeners: new Set(), retains: 0 },
				sourceOwners: 0,
				activeReads: 0,
				discarded: false,
			};
			this.entries.set(ref.id, entry);
			this.touch(entry);
			this.notify(entry);
			this.evict(entry);
			return;
		}
		if (reader) {
			old.reader = reader;
			for (const [index, page] of old.pages) this.touchPage(old, index, page);
		}
		this.touch(old);
		if (ref.revision < old.ref.revision) {
			this.evict(old);
			return;
		}
		if (ref.length < old.ref.length)
			throw new Error("Document length regressed without a new epoch");
		const complete = ref.complete || old.ref.complete;
		const originKnown = ref.originKnown || old.ref.originKnown;
		if (
			ref.revision !== old.ref.revision ||
			ref.length !== old.ref.length ||
			complete !== old.ref.complete ||
			originKnown !== old.ref.originKnown ||
			(ref.source && ref.source !== old.ref.source)
		) {
			old.ref = { ...ref, complete, originKnown, source: ref.source ?? old.ref.source };
			this.notify(old);
		}
		this.touch(old);
		this.evict(old);
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
			this.touch(old);
			this.evict(old);
			return old.ref;
		}
		// Reconcile an authoritative seal without rebuilding an identical live document.
		if (
			old &&
			(epoch == null || epoch === old.ref.epoch) &&
			old.ref.length === text.length &&
			this.equalsText(id, text)
		) {
			this.setImported(old, text);
			this.register({ ...old.ref, complete, originKnown: true });
			return old.ref;
		}
		const ref: TextDocumentRef = {
			id,
			epoch: epoch ?? `${id}:import:${++this.importSequence}`,
			revision: (old?.ref.revision ?? -1) + 1,
			length: text.length,
			complete,
			originKnown: true,
		};
		// If the caller explicitly reused an epoch for changed content, make replacement explicit.
		if (old && old.ref.epoch === ref.epoch)
			ref.epoch = `${ref.epoch}:import:${++this.importSequence}`;
		this.register(ref);
		const entry = this.entry(id);
		// Local readers must not close over the full string: the entry is its sole source owner.
		this.setImported(entry, text);
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
		const observers = entry.observers;
		observers.listeners.add(listener);
		this.touch(entry);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			observers.listeners.delete(listener);
			const current = this.entries.get(id);
			if (current?.observers === observers) this.touch(current);
			this.evict();
		};
	}

	peekRange(id: string, start: number, end: number): string | undefined {
		const entry = this.entries.get(id);
		if (!entry || start < 0 || end < start || end > entry.ref.length) return undefined;
		this.touch(entry);
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
			this.touchPage(entry, index, page);
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
		this.beginRead(entry);
		try {
			const parts: string[] = [];
			for (let offset = start; offset < end; ) {
				aborted(signal);
				this.assertCurrent(entry);
				const stop = Math.min(
					end,
					(Math.floor(offset / TEXT_DOCUMENT_PAGE_CHARS) + 1) * TEXT_DOCUMENT_PAGE_CHARS,
				);
				let part = this.peekRange(id, offset, stop);
				if (part === undefined) {
					const epoch = entry.ref.epoch;
					const range = await this.readSource(entry, offset, stop - offset, signal);
					this.assertCurrent(entry);
					aborted(signal);
					if (range.ref.id !== id || range.ref.epoch !== epoch)
						throw new Error("Document source changed while reading");
					if (range.offset > offset || range.offset + range.text.length <= offset)
						throw new Error("Document reader returned no progress");
					if (
						!Number.isSafeInteger(range.offset) ||
						range.offset < 0 ||
						range.offset + range.text.length > entry.ref.length
					)
						throw new RangeError("Document reader returned an invalid range");
					this.verifyOverlap(entry, range.offset, range.text);
					this.put(entry, range.offset, range.text);
					// Some servers return a shorter packet. Continue from its actual end.
					const availableEnd = Math.min(stop, range.offset + range.text.length);
					// A freshly read page may itself exceed a tiny cache budget.
					part = range.text.slice(offset - range.offset, availableEnd - range.offset);
				}
				parts.push(part);
				offset += part.length;
			}
			return parts.join("");
		} finally {
			this.endRead(entry);
		}
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
		aborted(signal);
		const entry = this.entry(id);
		const length = entry.ref.length;
		if (!query) return null;
		// Keep the source pinned across page reads AND cooperative search yields.
		this.beginRead(entry);
		try {
			// Streaming KMP: query/source may cross any page/CRLF/surrogate boundary.
			const failure = new Uint32Array(query.length);
			for (let i = 1, matched = 0; i < query.length; i++) {
				while (matched && query[i] !== query[matched]) matched = failure[matched - 1];
				if (query[i] === query[matched]) matched++;
				failure[i] = matched;
			}
			let matched = 0;
			for (let offset = Math.max(0, start); offset < length; offset += TEXT_DOCUMENT_PAGE_CHARS) {
				aborted(signal);
				this.assertCurrent(entry);
				const page = await this.readRange(
					id,
					offset,
					Math.min(length, offset + TEXT_DOCUMENT_PAGE_CHARS),
					signal,
				);
				this.assertCurrent(entry);
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
		} finally {
			this.endRead(entry);
		}
	}

	/** Metadata alone (or a few sparse pages) is not a complete readable source. */
	hasReadableSource(id: string, epoch?: string): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.ref.revision < 0 || (epoch != null && entry.ref.epoch !== epoch))
			return false;
		if (entry.reader || entry.imported?.length === entry.ref.length) return true;
		// All accepted spans are in bounds and disjoint. Byte coverage proves there are no holes,
		// without copying or joining even one character of a potentially huge document.
		return entry.ref.originKnown && entry.pageBytes === entry.ref.length * 2;
	}

	retainSource(id: string): (discard?: boolean) => void {
		const entry = this.entry(id);
		entry.sourceOwners++;
		this.touch(entry);
		let released = false;
		return (discard = false) => {
			if (released) return;
			released = true;
			entry.sourceOwners--;
			// Owner tokens belong to their original epoch, not whichever entry now has this ID.
			if (this.entries.get(id) !== entry) return;
			if (discard) entry.discarded = true;
			this.touch(entry);
			this.evict();
		};
	}

	discard(id: string, epoch?: string): void {
		const entry = this.entries.get(id);
		if (!entry || (epoch != null && entry.ref.epoch !== epoch)) return;
		entry.discarded = true;
		this.touch(entry);
		this.evict();
	}

	retain(id: string): () => void {
		const entry = this.entry(id);
		const observers = entry.observers;
		observers.retains++;
		this.touch(entry);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			observers.retains--;
			const current = this.entries.get(id);
			if (current?.observers === observers) this.touch(current);
			this.evict();
		};
	}

	stats() {
		let pinnedDocuments = 0;
		let unrecoverableDocuments = 0;
		let sourceOwners = 0;
		let activeReads = 0;
		for (const entry of this.entries.values()) {
			if (this.pinned(entry)) pinnedDocuments++;
			if (!entry.reader && entry.imported === undefined && entry.pageBytes > 0)
				unrecoverableDocuments++;
			sourceOwners += entry.sourceOwners;
			activeReads += entry.activeReads;
		}
		return {
			bytes: this.bytes,
			pageBytes: this.bytes,
			importedBytes: this.importedBytes,
			totalBytes: this.bytes + this.importedBytes,
			documents: this.entries.size,
			pinnedDocuments,
			unrecoverableDocuments,
			sourceOwners,
			activeReads,
			idleDocuments: this.idleEntries.size,
			overBudgetBytes:
				Math.max(0, this.bytes - this.maxBytes) +
				Math.max(0, this.importedBytes - this.maxImportedBytes),
			overBudgetDocuments: Math.max(0, this.idleEntries.size - this.maxIdleDocuments),
		};
	}
	private pinned(entry: Entry): boolean {
		return (
			entry.sourceOwners > 0 ||
			entry.observers.retains > 0 ||
			entry.observers.listeners.size > 0 ||
			entry.activeReads > 0
		);
	}
	private touch(entry: Entry) {
		if (this.entries.get(entry.ref.id) !== entry) return;
		this.idleEntries.delete(entry.ref.id);
		this.evictableIdleEntries.delete(entry.ref.id);
		if (this.pinned(entry)) return;
		if (entry.discarded) {
			this.deleteEntry(entry);
			return;
		}
		this.idleEntries.set(entry.ref.id, entry);
		// Do not rescan a potentially large set of intentionally retained, unique live chunks.
		if (
			entry.ref.complete ||
			entry.reader ||
			(entry.pageBytes === 0 && entry.imported === undefined)
		)
			this.evictableIdleEntries.set(entry.ref.id, entry);
	}
	private beginRead(entry: Entry) {
		entry.activeReads++;
		this.touch(entry);
	}
	private endRead(entry: Entry) {
		entry.activeReads--;
		this.touch(entry);
		this.evict();
	}
	private assertCurrent(entry: Entry) {
		if (this.entries.get(entry.ref.id) !== entry)
			throw new Error("Document source changed while reading");
	}
	private setImported(entry: Entry, text: string) {
		this.importedBytes += (text.length - (entry.imported?.length ?? 0)) * 2;
		entry.imported = text;
		for (const [index, page] of entry.pages) this.touchPage(entry, index, page);
	}
	private touchPage(entry: Entry, index: number, page: Page) {
		page.touched = ++this.clock;
		this.pageLru.delete(page);
		if (
			entry.reader ||
			(entry.imported !== undefined &&
				page.spans.every(
					(span) =>
						index * TEXT_DOCUMENT_PAGE_CHARS + span.start + span.text.length <=
						(entry.imported?.length ?? 0),
				))
		)
			this.pageLru.set(page, { entry, index });
	}
	private clearSource(entry: Entry) {
		for (const page of entry.pages.values()) this.pageLru.delete(page);
		this.bytes -= entry.pageBytes;
		entry.pages.clear();
		entry.pageBytes = 0;
		this.importedBytes -= (entry.imported?.length ?? 0) * 2;
		entry.imported = undefined;
		entry.reader = undefined;
	}
	private deleteEntry(entry: Entry) {
		if (this.entries.get(entry.ref.id) !== entry) return;
		this.entries.delete(entry.ref.id);
		this.idleEntries.delete(entry.ref.id);
		this.evictableIdleEntries.delete(entry.ref.id);
		// Clear fields too: already-released owner callbacks must not retain strings/readers.
		this.clearSource(entry);
	}
	private entry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown document: ${id}`);
		return entry;
	}
	private notify(entry: Entry) {
		for (const listener of entry.observers.listeners) listener();
	}
	private pageBytes(page: Page) {
		return page.spans.reduce((bytes, span) => bytes + span.text.length * 2, 0);
	}
	private verifyOverlap(entry: Entry, offset: number, text: string) {
		if (entry.imported !== undefined) {
			const end = Math.min(entry.imported.length, offset + text.length);
			if (end > offset && entry.imported.slice(offset, end) !== text.slice(0, end - offset))
				throw new Error("Conflicting document overlap; a replacement must use a new epoch");
		}
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
			entry.pageBytes -= before;
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
			entry.pages.set(index, page);
			this.touchPage(entry, index, page);
			const after = this.pageBytes(page);
			this.bytes += after;
			entry.pageBytes += after;
			added ||= after > before;
			consumed += count;
		}
		this.touch(entry);
		this.evict(entry);
		return added;
	}
	private evict(admission?: Entry) {
		// Recoverable pages have their own budget even when their complete source is pinned.
		for (const [page, { entry, index }] of this.pageLru) {
			if (this.bytes <= this.maxBytes) break;
			entry.pages.delete(index);
			this.pageLru.delete(page);
			const bytes = this.pageBytes(page);
			this.bytes -= bytes;
			entry.pageBytes -= bytes;
		}
		// Only evictable idle candidates are visited; pinned and unique live chunks stay out.
		for (const entry of this.evictableIdleEntries.values()) {
			if (
				this.importedBytes <= this.maxImportedBytes &&
				this.idleEntries.size <= this.maxIdleDocuments &&
				this.bytes <= this.maxBytes
			)
				break;
			if (entry === admission) continue;
			// Incomplete local chunks are the sole durable source. Only explicit discard may drop them.
			if (
				!entry.ref.complete &&
				!entry.reader &&
				(entry.pageBytes > 0 || entry.imported !== undefined)
			)
				continue;
			this.deleteEntry(entry);
		}
	}
	private async readSource(entry: Entry, offset: number, limit: number, signal?: AbortSignal) {
		aborted(signal);
		this.assertCurrent(entry);
		if (entry.imported !== undefined && offset < entry.imported.length)
			return {
				ref: entry.ref,
				offset,
				text: entry.imported.slice(offset, offset + limit),
			};
		if (!entry.reader)
			throw new Error("Document source range unavailable; reconnect or reload its detail");
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
