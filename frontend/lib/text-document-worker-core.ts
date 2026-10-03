import { clearCache } from "@chenglou/pretext";
import {
	documentBoundaryAtX,
	layoutTextDocumentLine,
	sliceDocumentVisualLine,
	type TextDocumentTypography,
	type TextDocumentVisualLine,
} from "@shared/pretext-layout/text-document-layout";
import type { ShikiModule } from "./shiki-loader";
import {
	DerivedDocumentCache,
	IncrementalDocumentTokenizer,
	LatestDocumentTask,
	PagedTextDocument,
} from "./text-document-pure-core";
import {
	assertDocumentPacket,
	type DocumentPoint,
	type DocumentRow,
	type DocumentWorkerRequest,
	type DocumentWorkerResponse,
	sendDocumentParts,
	TEXT_DOCUMENT_DERIVED_CACHE_BYTES,
} from "./text-document-worker-protocol";

type WorkRequest = Extract<DocumentWorkerRequest, { type: "view" | "tokens" | "position" }>;
interface WorkerDocument {
	epoch: string;
	source: PagedTextDocument;
	pending: Map<number, WorkRequest>;
	task: LatestDocumentTask<object>;
}

export class TextDocumentLayoutIndex {
	readonly rows: TextDocumentVisualLine[] = [];
	private stablePhysicalLines = 0;
	private stableVisualLines = 0;
	private stableWidth = 0;
	private stableBytes = 0;
	private retainedBytes = 0;
	width = 0;
	length = -1;
	constructor(readonly options: TextDocumentTypography) {}
	async update(source: PagedTextDocument, shouldContinue = () => true) {
		if (this.length === source.length) return;
		const length = source.length;
		const lines = source.lines.slice(this.stablePhysicalLines).map((line) => ({ ...line }));
		this.rows.length = this.stableVisualLines;
		this.retainedBytes = this.stableBytes;
		this.width = this.stableWidth;
		let yielded = performance.now();
		for (const line of lines) {
			if (!shouldContinue()) return;
			const rows = layoutTextDocumentLine(
				source.slice(line.start, line.end),
				line.start,
				this.options,
			);
			for (const row of rows) {
				this.rows.push(row);
				this.width = Math.max(this.width, row.width);
				this.retainedBytes += 64 + row.offsets.byteLength + row.x.byteLength;
			}
			if (line.stable) {
				this.stablePhysicalLines++;
				this.stableVisualLines = this.rows.length;
				this.stableWidth = this.width;
				this.stableBytes = this.retainedBytes;
			}
			if (performance.now() - yielded >= 8) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				yielded = performance.now();
			}
		}
		this.length = length;
	}
	position(offset: number) {
		let lo = 0,
			hi = this.rows.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.rows[mid].start <= offset) lo = mid + 1;
			else hi = mid;
		}
		const index = Math.max(0, lo - 1),
			row = this.rows[index];
		if (!row) return { index: 0, top: 0, left: 0 };
		lo = 0;
		hi = row.offsets.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (row.offsets[mid] <= offset) lo = mid + 1;
			else hi = mid;
		}
		return { index, top: index * this.options.lineHeight, left: row.x[Math.max(0, lo - 1)] ?? 0 };
	}
	offsetAtPosition(top: number, left: number) {
		const row =
			this.rows[
				Math.min(this.rows.length - 1, Math.max(0, Math.floor(top / this.options.lineHeight)))
			];
		return row ? row.offsets[documentBoundaryAtX(row, left)] : 0;
	}
	get bytes() {
		return this.retainedBytes;
	}
}

/** Testable runtime; layout and Shiki run in separate instances/workers. */
export class TextDocumentWorkerRuntime {
	private documents = new Map<string, WorkerDocument>();
	private tokens = new DerivedDocumentCache<IncrementalDocumentTokenizer>(
		TEXT_DOCUMENT_DERIVED_CACHE_BYTES / 2,
	);
	private layouts = new DerivedDocumentCache<TextDocumentLayoutIndex>(
		TEXT_DOCUMENT_DERIVED_CACHE_BYTES / 2,
	);
	private cancelled = new Set<number>();
	private activeRequests = new Set<number>();
	private highlighter?: Promise<ShikiModule>;
	private assetBase = "";
	private role?: "layout" | "tokens";
	private slowOperations = 0;
	private maxTaskMs = 0;
	private lastSlowLog = new Map<string, number>();
	constructor(
		private send: (packet: DocumentWorkerResponse) => void,
		private loadShiki: (assetBase: string) => Promise<ShikiModule>,
	) {}

	handle(message: DocumentWorkerRequest): void {
		assertDocumentPacket(message);
		if (message.type === "boot") {
			const base = new URL(message.assetBase);
			if (!/^https?:$/.test(base.protocol) || !base.pathname.endsWith("/"))
				throw new Error("Invalid Worker app mount base");
			if (this.role && this.role !== message.role) throw new Error("Worker role cannot change");
			this.role = message.role;
			this.assetBase = base.href;
			return;
		}
		if (message.type === "reset") {
			this.release(message.docId);
			const doc: WorkerDocument = {
				epoch: message.epoch,
				source: new PagedTextDocument(),
				pending: new Map(),
				task: new LatestDocumentTask(
					async () => this.run(message.docId, doc),
					() => {},
				),
			};
			this.documents.set(message.docId, doc);
			return;
		}
		if (message.type === "release") {
			this.release(message.docId);
			return;
		}
		if (message.type === "cancel") {
			const doc = this.documents.get(message.docId);
			if (doc?.pending.delete(message.requestId)) {
				this.fail(message.requestId, "Document request cancelled");
				return;
			}
			if (this.activeRequests.has(message.requestId)) this.cancelled.add(message.requestId);
			else this.fail(message.requestId, "Document request cancelled");
			return;
		}
		const docId = message.type === "append" ? message.docId : message.ref.id;
		const doc = this.documents.get(docId);
		if (!doc || doc.epoch !== (message.type === "append" ? message.epoch : message.ref.epoch)) {
			if ("requestId" in message)
				this.fail(message.requestId, "Worker source epoch unavailable; retry available");
			return;
		}
		if (message.type === "append") {
			doc.source.append(message.offset, message.text);
			return;
		}
		if (!this.role || (message.type === "tokens") !== (this.role === "tokens")) {
			this.fail(message.requestId, "Document work sent to the wrong Worker lane");
			return;
		}
		doc.pending.set(message.requestId, message);
		doc.task.push({});
	}
	private async run(id: string, doc: WorkerDocument) {
		const requests = Array.from(doc.pending.values());
		doc.pending.clear();
		for (const request of requests) this.activeRequests.add(request.requestId);
		for (const request of requests) {
			const started = performance.now();
			const live = () => this.documents.get(id) === doc && !this.cancelled.has(request.requestId);
			try {
				if (!live()) continue;
				if (request.ref.length > doc.source.length)
					throw new Error("Document source gap; retry available");
				if (request.type === "tokens") {
					const key = JSON.stringify([id, doc.epoch, request.language, request.theme]);
					let tokenizer = this.tokens.get(key);
					if (!tokenizer) {
						if (!this.assetBase) throw new Error("Worker boot app mount base missing");
						this.highlighter ??= this.loadShiki(this.assetBase).catch((error) => {
							this.highlighter = undefined;
							throw error;
						});
						tokenizer = new IncrementalDocumentTokenizer(
							await this.highlighter,
							request.language,
							request.theme,
						);
					}
					await tokenizer.update(doc.source, request.ref.length, live);
					if (this.documents.get(id) === doc) this.tokens.set(key, tokenizer, tokenizer.bytes);
					if (!live()) continue;
					for (const range of request.ranges)
						sendDocumentParts(
							request.requestId,
							"tokens",
							tokenizer.range(doc.source, range.start, range.end),
							this.send,
						);
					this.done(request);
				} else {
					const { font, lineHeight, letterSpacing, tabSize, width, wrap, fontRevision, locale } =
						request.options;
					const typography = {
						font,
						lineHeight,
						letterSpacing,
						tabSize,
						width,
						wrap,
						fontRevision,
						locale,
					};
					const key = JSON.stringify([id, doc.epoch, typography]);
					let layout = this.layouts.get(key);
					if (!layout) layout = new TextDocumentLayoutIndex(typography);
					try {
						await layout.update(doc.source, live);
					} finally {
						clearCache();
					} // pretext's own unbounded prepared-text cache must not retain old tails.
					if (this.documents.get(id) === doc) this.layouts.set(key, layout, layout.bytes);
					if (!live()) continue;
					if (request.type === "position")
						this.done(request, { position: layout.position(request.offset) });
					else {
						const { top, height, left, viewportWidth } = request.options;
						const overscan = lineHeight * 3;
						const from = Math.max(0, Math.floor((top - overscan) / lineHeight));
						const to = Math.min(
							layout.rows.length,
							Math.ceil((top + height + overscan) / lineHeight),
						);
						const rows: DocumentRow[] = [],
							points: DocumentPoint[] = [];
						for (let index = from; index < to; index++) {
							const row = layout.rows[index];
							const crop = sliceDocumentVisualLine(
								row,
								wrap ? 0 : left,
								wrap ? width : viewportWidth,
							);
							rows.push({
								index,
								start: crop.start,
								end: crop.end,
								left: crop.left,
								width: row.width,
								top: index * lineHeight,
								height: lineHeight,
							});
							for (const point of crop.points) points.push({ index, ...point });
						}
						sendDocumentParts(request.requestId, "rows", rows, this.send);
						sendDocumentParts(request.requestId, "points", points, this.send);
						this.done(request, {
							contentHeight: layout.rows.length * lineHeight,
							contentWidth: layout.width,
						});
					}
				}
			} catch (error) {
				if (live())
					this.fail(request.requestId, error instanceof Error ? error.message : String(error));
			} finally {
				if (this.cancelled.has(request.requestId) || this.documents.get(id) !== doc)
					this.fail(request.requestId, "Document request cancelled or superseded");
				this.cancelled.delete(request.requestId);
				this.activeRequests.delete(request.requestId);
				const elapsedMs = performance.now() - started;
				this.maxTaskMs = Math.max(this.maxTaskMs, elapsedMs);
				if (elapsedMs >= 250) {
					this.slowOperations++;
					if (started - (this.lastSlowLog.get(id) ?? -Infinity) >= 10_000) {
						this.lastSlowLog.set(id, started);
						console.warn("[text-document-worker] slow operation", {
							docId: id,
							epoch: request.ref.epoch,
							revision: request.ref.revision,
							kind: request.type,
							elapsedMs: Math.round(elapsedMs),
							chars: request.ref.length,
							derivedBytes: this.tokens.bytes + this.layouts.bytes,
							pending: doc.task.pending,
						});
					}
				}
			}
		}
	}
	private done(
		request: WorkRequest,
		values: Partial<Extract<DocumentWorkerResponse, { type: "done" }>> = {},
	) {
		this.send({
			type: "done",
			requestId: request.requestId,
			epoch: request.ref.epoch,
			revision: request.ref.revision,
			...values,
		});
	}
	private fail(requestId: number, error: string) {
		this.send({ type: "error", requestId, error });
	}
	private release(id: string) {
		const doc = this.documents.get(id);
		doc?.task.cancel();
		for (const request of doc?.pending.values() ?? [])
			this.fail(request.requestId, "Document source released or superseded");
		doc?.pending.clear();
		this.documents.delete(id);
		this.lastSlowLog.delete(id);
		const prefix = `${JSON.stringify([id]).slice(0, -1)},`;
		this.tokens.deletePrefix(prefix);
		this.layouts.deletePrefix(prefix);
	}
	stats() {
		return {
			documents: this.documents.size,
			derivedBytes: this.tokens.bytes + this.layouts.bytes,
			slowOperations: this.slowOperations,
			maxTaskMs: this.maxTaskMs,
			pending: Array.from(this.documents.values()).reduce((sum, doc) => sum + doc.task.pending, 0),
		};
	}
}
