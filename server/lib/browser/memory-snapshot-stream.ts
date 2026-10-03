import { open, rename, unlink } from "node:fs/promises";
import {
	HEAP_SNAPSHOT_PENDING_BYTES,
	HEAP_SNAPSHOT_WORKER_CLEANUP_MS,
	MAX_HEAP_SNAPSHOT_BYTES,
} from "./memory-constants";

// Compatibility exports for the supervisor and stream tests; budgets have one source.
export const SNAPSHOT_MAX_BYTES = MAX_HEAP_SNAPSHOT_BYTES;
export const SNAPSHOT_PENDING_BYTES = HEAP_SNAPSHOT_PENDING_BYTES;
export const SNAPSHOT_CLEANUP_MS = HEAP_SNAPSHOT_WORKER_CLEANUP_MS;

export type SnapshotStage =
	| "busy"
	| "input"
	| "startup"
	| "connect"
	| "target"
	| "capture"
	| "bytes"
	| "queue"
	| "write"
	| "finalize"
	| "cancelled"
	| "timeout"
	| "worker";
export class SnapshotError extends Error {
	constructor(public readonly stage: SnapshotStage) {
		super(`Heap snapshot failed (${stage})`);
		this.name = "SnapshotError";
	}
}
export interface SnapshotFile {
	write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
	close(): Promise<void>;
}
export interface SnapshotIO {
	open(path: string): Promise<SnapshotFile>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}
const diskIO: SnapshotIO = {
	open: (path) => open(path, "wx", 0o600),
	rename,
	unlink,
};

/** Bounds include the currently writing chunk. No cumulative snapshot string exists. */
export class SnapshotStream {
	private file: SnapshotFile | undefined;
	private chain: Promise<void> = Promise.resolve();
	private pending = 0;
	private total = 0;
	private error: SnapshotError | undefined;
	private stopped = false;
	private renamed = false;
	private ownsPartial = false;
	/** CDP chunk boundaries need not coincide with UTF-16 surrogate pairs. */
	private trailingSurrogate = "";
	constructor(
		private readonly savePath: string,
		private readonly maxBytes: number,
		private readonly fail: (error: SnapshotError) => void,
		private readonly io: SnapshotIO = diskIO,
	) {}
	async start(): Promise<void> {
		this.file = await this.io.open(`${this.savePath}.partial`);
		this.ownsPartial = true;
	}
	push(chunk: string): void {
		if (this.stopped || this.error) return;
		let text = this.trailingSurrogate + chunk;
		this.trailingSurrogate = "";
		const last = text.charCodeAt(text.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			this.trailingSurrogate = text.slice(-1);
			text = text.slice(0, -1);
		}
		this.enqueue(text);
	}
	private enqueue(chunk: string): void {
		if (this.stopped || this.error || !chunk) return;
		const bytes = Buffer.byteLength(chunk, "utf8");
		if (this.total + bytes > Math.min(SNAPSHOT_MAX_BYTES, this.maxBytes)) {
			this.refuse("bytes");
			return;
		}
		if (this.pending + bytes > SNAPSHOT_PENDING_BYTES) {
			this.refuse("queue");
			return;
		}
		const buffer = Buffer.from(chunk, "utf8");
		this.total += bytes;
		this.pending += bytes;
		this.chain = this.chain.then(async () => {
			try {
				if (this.stopped || this.error) return;
				let offset = 0;
				while (offset < buffer.length && !this.stopped) {
					const result = await this.file?.write(buffer, offset, buffer.length - offset);
					if (!result || result.bytesWritten <= 0) throw new SnapshotError("write");
					offset += result.bytesWritten;
				}
			} catch {
				this.refuse("write");
			} finally {
				this.pending -= bytes;
			}
		});
	}
	private refuse(stage: SnapshotStage): void {
		if (this.error) return;
		this.error = new SnapshotError(stage);
		this.fail(this.error);
	}
	async finish(): Promise<{ fileSize: number }> {
		this.enqueue(this.trailingSurrogate);
		this.trailingSurrogate = "";
		await this.chain;
		if (this.error) throw this.error;
		if (this.stopped) throw new SnapshotError("cancelled");
		if (!this.total) throw new SnapshotError("capture");
		await this.file?.close();
		this.file = undefined;
		if (this.stopped) throw new SnapshotError("cancelled");
		await this.io.rename(`${this.savePath}.partial`, this.savePath);
		this.renamed = true;
		if (this.stopped) throw new SnapshotError("cancelled");
		return { fileSize: this.total };
	}
	async cleanup(): Promise<void> {
		this.stopped = true;
		await this.chain;
		await this.file?.close().catch(() => {});
		this.file = undefined;
		if (this.ownsPartial) await this.io.unlink(`${this.savePath}.partial`).catch(() => {});
		if (this.renamed) await this.io.unlink(this.savePath).catch(() => {});
	}
}

/** Used for best-effort cleanup only; the supervisor terminates unresponsive workers. */
export async function boundedCleanup(action: () => Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			action().catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SNAPSHOT_CLEANUP_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
