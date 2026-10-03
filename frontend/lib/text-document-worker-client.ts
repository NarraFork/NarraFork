import {
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRef,
} from "@shared/pretext-layout/text-document";
import { getAppBase } from "./base-path";
import type { DocumentToken } from "./text-document-pure-core";
import { type TextDocumentStore, textDocumentStore } from "./text-document-store";
import {
	assertDocumentPacket,
	type DocumentPoint,
	type DocumentPosition,
	type DocumentRow,
	type DocumentWorkerRequest,
	type DocumentWorkerResponse,
	TEXT_DOCUMENT_WORKER_WATCHDOG_MS,
	type TextDocumentViewOptions,
} from "./text-document-worker-protocol";

export interface TextDocumentViewRow extends DocumentRow {
	text: string;
	tokens: DocumentToken[];
	points: { offset: number; x: number }[];
}
export interface TextDocumentViewResult {
	rows: TextDocumentViewRow[];
	contentHeight: number;
	contentWidth: number;
	revision: number;
}
interface WorkerPort {
	postMessage(message: DocumentWorkerRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<DocumentWorkerResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}
interface Result {
	rows: DocumentRow[];
	points: DocumentPoint[];
	tokens: DocumentToken[];
	done: Extract<DocumentWorkerResponse, { type: "done" }>;
}
interface Pending {
	resolve: (result: Result) => void;
	reject: (error: Error) => void;
	rows: DocumentRow[];
	points: DocumentPoint[];
	tokens: DocumentToken[];
	timer: ReturnType<typeof setTimeout>;
	cleanup: () => void;
	ref: TextDocumentRef;
}
interface SourceSync {
	epoch: string;
	sent: number;
	chain: Promise<void>;
	controller: AbortController;
}
const cancelledError = () => new DOMException("Aborted", "AbortError");
const isCancelled = (signal?: AbortSignal) => {
	if (signal?.aborted) throw cancelledError();
};
function wireRef(ref: TextDocumentRef): TextDocumentRef {
	return {
		id: ref.id,
		epoch: ref.epoch,
		revision: ref.revision,
		length: ref.length,
		complete: ref.complete,
		originKnown: ref.originKnown,
	};
}

class WorkerLane {
	private worker?: WorkerPort;
	private sources = new Map<string, SourceSync>();
	private pending = new Map<number, Pending>();
	private detached = new Map<number, { timer: ReturnType<typeof setTimeout>; docId: string }>();
	private nextId = 1;
	constructor(
		private role: "layout" | "tokens",
		private store: TextDocumentStore,
		private factory: () => WorkerPort,
		private appBase: () => string,
		private watchdogMs: number,
	) {}

	private port() {
		if (!this.worker) {
			const worker = this.factory();
			worker.onmessage = (event) => this.receive(event.data);
			worker.onerror = (event) =>
				this.failAll(
					new Error(`Document ${this.role} Worker failed: ${event.message}; retry available`),
				);
			worker.postMessage({ type: "boot", role: this.role, assetBase: this.appBase() });
			this.worker = worker;
		}
		return this.worker;
	}
	private post(packet: DocumentWorkerRequest) {
		assertDocumentPacket(packet);
		this.port().postMessage(packet);
	}
	private async sync(ref: TextDocumentRef) {
		const current = this.store.getSnapshot(ref.id);
		if (current && current.epoch !== ref.epoch)
			throw new Error("Document target epoch superseded; retry available");
		let source = this.sources.get(ref.id);
		if (!source || source.epoch !== ref.epoch) {
			source?.controller.abort();
			this.post({ type: "reset", docId: ref.id, epoch: ref.epoch });
			source = {
				epoch: ref.epoch,
				sent: 0,
				chain: Promise.resolve(),
				controller: new AbortController(),
			};
			this.sources.set(ref.id, source);
		}
		const target = source;
		const work = target.chain
			.catch(() => {})
			.then(async () => {
				while (target.sent < ref.length) {
					isCancelled(target.controller.signal);
					if (this.sources.get(ref.id) !== target) throw cancelledError();
					const end = Math.min(ref.length, target.sent + TEXT_DOCUMENT_PAGE_CHARS);
					const text = await this.store.readRange(
						ref.id,
						target.sent,
						end,
						target.controller.signal,
					);
					if (this.sources.get(ref.id) !== target) throw cancelledError();
					this.post({ type: "append", docId: ref.id, epoch: ref.epoch, offset: target.sent, text });
					target.sent = end;
					// Give UI input a turn when importing large historical documents.
					if (target.sent % (TEXT_DOCUMENT_PAGE_CHARS * 16) === 0)
						await new Promise((resolve) => setTimeout(resolve, 0));
				}
			});
		target.chain = work;
		await work;
	}

	async request(
		request:
			| Omit<Extract<DocumentWorkerRequest, { type: "view" }>, "requestId">
			| Omit<Extract<DocumentWorkerRequest, { type: "tokens" }>, "requestId">
			| Omit<Extract<DocumentWorkerRequest, { type: "position" }>, "requestId">,
		signal?: AbortSignal,
	): Promise<Result> {
		isCancelled(signal);
		await this.sync(request.ref);
		isCancelled(signal);
		const requestId = this.nextId++;
		return new Promise((resolve, reject) => {
			const abort = () => {
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				pending.cleanup();
				// Keep the watchdog until the worker acknowledges cancellation. A blocked
				// single-line tokenizer cannot process cancel and must still be terminated.
				this.detached.set(requestId, { timer: pending.timer, docId: request.ref.id });
				this.post({ type: "cancel", requestId, docId: request.ref.id });
				reject(cancelledError());
			};
			const timer = setTimeout(
				() =>
					this.failAll(
						new Error(
							`Document ${this.role} Worker timed out (60s); source retained, retry available`,
						),
					),
				this.watchdogMs,
			);
			const cleanup = () => signal?.removeEventListener("abort", abort);
			this.pending.set(requestId, {
				resolve,
				reject,
				rows: [],
				points: [],
				tokens: [],
				timer,
				cleanup,
				ref: request.ref,
			});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.post({ ...request, requestId, ref: wireRef(request.ref) } as DocumentWorkerRequest);
			} catch (error) {
				this.pending.delete(requestId);
				cleanup();
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	private receive(packet: DocumentWorkerResponse) {
		assertDocumentPacket(packet);
		if (packet.type === "error" && packet.requestId === -1) {
			this.failAll(new Error(packet.error));
			return;
		}
		const pending = this.pending.get(packet.requestId);
		if (!pending) {
			if (packet.type !== "part") {
				clearTimeout(this.detached.get(packet.requestId)?.timer);
				this.detached.delete(packet.requestId);
			}
			return; // Cancelled/old generation results cannot touch another view.
		}
		if (packet.type === "part") {
			if (packet.section === "rows") pending.rows.push(...packet.items);
			else if (packet.section === "points") pending.points.push(...packet.items);
			else pending.tokens.push(...packet.items);
			return;
		}
		this.pending.delete(packet.requestId);
		clearTimeout(pending.timer);
		pending.cleanup();
		if (packet.type === "error") {
			pending.reject(new Error(packet.error));
			return;
		}
		if (packet.epoch !== pending.ref.epoch || packet.revision !== pending.ref.revision) {
			pending.reject(new Error("Stale document Worker result rejected"));
			return;
		}
		pending.resolve({
			rows: pending.rows,
			points: pending.points,
			tokens: pending.tokens,
			done: packet,
		});
	}
	release(id: string) {
		if (
			Array.from(this.pending.values()).some((pending) => pending.ref.id === id) ||
			Array.from(this.detached.values()).some((pending) => pending.docId === id)
		) {
			this.failAll(new Error("Document view closed; in-flight Worker reclaimed, source retained"));
			return;
		}
		const source = this.sources.get(id);
		source?.controller.abort();
		this.sources.delete(id);
		if (this.worker) this.post({ type: "release", docId: id });
	}
	reset() {
		this.failAll(new Error("Document Worker reset; retry available"));
	}
	private failAll(error: Error) {
		this.worker?.terminate();
		this.worker = undefined;
		for (const source of this.sources.values()) source.controller.abort();
		this.sources.clear();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
		for (const detached of this.detached.values()) clearTimeout(detached.timer);
		this.detached.clear();
	}
}

/** Exactly two lazy shared workers; document subscriptions never use global versions. */
export class TextDocumentWorkerClient {
	private layout: WorkerLane;
	private tokens: WorkerLane;
	private retains = new Map<string, number>();
	constructor(
		private store = textDocumentStore,
		factory: () => WorkerPort = () =>
			new Worker(new URL("./text-document.worker.ts", import.meta.url), { type: "module" }),
		appBase = () => new URL(getAppBase(), location.href).href,
		watchdogMs = TEXT_DOCUMENT_WORKER_WATCHDOG_MS,
	) {
		this.layout = new WorkerLane("layout", store, factory, appBase, watchdogMs);
		this.tokens = new WorkerLane("tokens", store, factory, appBase, watchdogMs);
	}
	retain(id: string): () => void {
		this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
		const releaseStore = this.store.retain(id);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			releaseStore();
			const count = (this.retains.get(id) ?? 1) - 1;
			if (count) this.retains.set(id, count);
			else {
				this.retains.delete(id);
				this.layout.release(id);
				this.tokens.release(id);
			}
		};
	}
	async view(
		ref: TextDocumentRef,
		options: TextDocumentViewOptions,
		signal?: AbortSignal,
	): Promise<TextDocumentViewResult> {
		const result = await this.layout.request({ type: "view", ref, options }, signal);
		isCancelled(signal);
		const points = new Map<number, { offset: number; x: number }[]>();
		for (const point of result.points) {
			const list = points.get(point.index) ?? [];
			list.push({ offset: point.offset, x: point.x });
			points.set(point.index, list);
		}
		const rows: TextDocumentViewRow[] = [];
		for (const row of result.rows)
			rows.push({
				...row,
				text: await this.store.readRange(ref.id, row.start, row.end, signal),
				tokens: [],
				points: points.get(row.index) ?? [],
			});
		return {
			rows,
			contentHeight: result.done.contentHeight ?? 0,
			contentWidth: result.done.contentWidth ?? 0,
			revision: ref.revision,
		};
	}
	async highlight(
		ref: TextDocumentRef,
		options: TextDocumentViewOptions,
		rows: readonly DocumentRow[],
		signal?: AbortSignal,
	): Promise<DocumentToken[]> {
		if (!rows.length) return [];
		const result = await this.tokens.request(
			{
				type: "tokens",
				ref,
				language: options.language || "text",
				theme: options.theme,
				ranges: rows.map((row) => ({ start: row.start, end: row.end })),
			},
			signal,
		);
		isCancelled(signal);
		return result.tokens;
	}
	async position(
		ref: TextDocumentRef,
		options: TextDocumentViewOptions,
		offset: number,
		signal?: AbortSignal,
	): Promise<DocumentPosition> {
		const result = await this.layout.request({ type: "position", ref, options, offset }, signal);
		isCancelled(signal);
		if (!result.done.position) throw new Error("Document Worker position missing");
		return result.done.position;
	}
	retry() {
		this.layout.reset();
		this.tokens.reset();
	}
}

export const textDocumentWorkerClient = new TextDocumentWorkerClient();
