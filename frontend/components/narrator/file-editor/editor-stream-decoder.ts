import type { EditorRawEncoding, EditorRawMetadata } from "@shared/editor-document";
export interface EditorDecodedChunk {
	text: string;
	tags: Uint8Array;
	metadata?: EditorRawMetadata;
}
let liveCodecs = 0;
export const editorCodecDiagnostics = () => ({ workers: liveCodecs });
/** One request/output in flight, no text mirror, Node shims or retained initial text. */
export class EditorStreamDecoder {
	private worker: Worker;
	private pending?: { resolve(value: EditorDecodedChunk): void; reject(error: unknown): void };
	private disposed = false;
	private readyTimer: ReturnType<typeof setTimeout>;
	private abort = () => this.dispose(this.signal.reason);
	readonly ready: Promise<unknown>;
	constructor(
		encoding: EditorRawEncoding,
		private signal: AbortSignal,
	) {
		this.worker = new Worker(new URL("./editor-codec.worker.ts", import.meta.url), {
			type: "module",
		});
		liveCodecs++;
		this.readyTimer = setTimeout(() => this.dispose(new Error("EDITOR_CODEC_READY_TIMEOUT")), 5000);
		this.worker.onmessage = (event) => {
			if (event.data.ready) clearTimeout(this.readyTimer);
			const pending = this.pending;
			this.pending = undefined;
			if (event.data.error) pending?.reject(new Error(event.data.error));
			else pending?.resolve(event.data);
		};
		this.worker.onerror = (event) => this.dispose(new Error(event.message));
		signal.addEventListener("abort", this.abort, { once: true });
		this.ready = this.request({ encoding });
		if (signal.aborted) this.abort();
	}
	private request(message: object, transfer: Transferable[] = []): Promise<EditorDecodedChunk> {
		if (this.disposed || this.pending) return Promise.reject(new Error("EDITOR_CODEC_CLOSED"));
		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject };
			this.worker.postMessage(message, transfer);
		});
	}
	async push(bytes: Uint8Array<ArrayBuffer>, eof: boolean) {
		await this.ready;
		this.signal.throwIfAborted();
		return this.request({ bytes, eof }, [bytes.buffer]);
	}
	dispose(error: unknown = new Error("EDITOR_CODEC_CLOSED")) {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.readyTimer);
		this.signal.removeEventListener("abort", this.abort);
		this.worker.terminate();
		liveCodecs--;
		this.pending?.reject(error);
		this.pending = undefined;
	}
}
