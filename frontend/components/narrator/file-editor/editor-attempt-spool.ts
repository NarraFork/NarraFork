import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	EDITOR_FILE_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_UPLOAD_CHUNK_BYTES,
} from "@shared/editor-document";
import { createEditorLocalId } from "./editor-local-id";
import type { EditorRawSeal } from "./editor-save-codec";
export const EDITOR_ATTEMPT_CHUNK_BYTES = EDITOR_UPLOAD_CHUNK_BYTES;
export const EDITOR_ATTEMPT_MAX_CHUNKS = Math.ceil(
	EDITOR_FILE_MAX_BYTES / EDITOR_TRANSFER_CHUNK_BYTES,
);
const TTL = 10 * 60_000;
const range = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
const req = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
const done = (tx: IDBTransaction) => {
	const value = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = tx.onerror = () => reject(tx.error);
	});
	void value.catch(() => {});
	return value;
};
export interface EditorAttemptChunk {
	seq: number;
	offset: number;
	digest: string;
	data: Uint8Array<ArrayBuffer>;
}
let ramOwner: EditorAttemptSpool | undefined;
/** Immutable after finish. Never a Blob, joined body, or recapture of the changing model. */
export class EditorAttemptSpool {
	readonly id = createEditorLocalId();
	private db?: IDBDatabase;
	private ram?: EditorAttemptChunk[];
	private count = 0;
	private bytes = 0;
	private disposed = false;
	seal?: EditorRawSeal;
	get chunkCount() {
		return this.count;
	}
	get storage() {
		return this.ram ? "memory" : "indexeddb";
	}
	private constructor(
		readonly revision: number,
		readonly modelLifetime: string,
	) {}
	static async create(
		revision: number,
		modelLifetime: string,
		factory?: IDBFactory | null,
		name = "narrafork-editor-attempts",
		signal?: AbortSignal,
	) {
		const spool = new EditorAttemptSpool(revision, modelLifetime);
		try {
			if (factory === undefined) factory = globalThis.indexedDB;
			if (!factory) throw new Error("EDITOR_IDB_UNAVAILABLE");
			const opening = factory.open(name, 1);
			opening.onupgradeneeded = () => {
				opening.result.createObjectStore("attempts", { keyPath: "id" });
				opening.result.createObjectStore("chunks");
			};
			const deadline = signal ?? AbortSignal.timeout(30_000);
			spool.db = await new Promise<IDBDatabase>((resolve, reject) => {
				const abort = () => reject(deadline.reason);
				deadline.addEventListener("abort", abort, { once: true });
				opening.onsuccess = () => {
					deadline.removeEventListener("abort", abort);
					if (deadline.aborted) {
						opening.result.close();
						reject(deadline.reason);
					} else resolve(opening.result);
				};
				opening.onerror = () => {
					deadline.removeEventListener("abort", abort);
					reject(opening.error);
				};
				if (deadline.aborted) abort();
			});
			const tx = spool.db.transaction(["attempts", "chunks"], "readwrite"),
				settled = done(tx);
			const meta = tx.objectStore("attempts"),
				chunks = tx.objectStore("chunks");
			const all = await req(meta.getAll(undefined, 33));
			if (all.length > 32) {
				tx.abort();
				throw new Error("EDITOR_ATTEMPT_QUOTA");
			}
			let count = 0;
			for (const row of all) {
				if (row.expires < Date.now()) {
					meta.delete(row.id);
					chunks.delete(range(row.id));
				} else count++;
			}
			if (count >= 32 || (count + 1) * EDITOR_FILE_MAX_BYTES > 128 * 1024 * 1024) {
				tx.abort();
				throw new Error("EDITOR_ATTEMPT_QUOTA");
			}
			meta.put({ id: spool.id, expires: Date.now() + TTL });
			await settled;
		} catch (error) {
			if (signal?.aborted) {
				spool.db?.close();
				throw error;
			}
			try {
				await spool.fallback();
			} catch (error) {
				spool.db?.close();
				throw error;
			}
		}
		return spool;
	}
	private async fallback() {
		if (ramOwner && ramOwner !== this) throw new Error("EDITOR_ATTEMPT_MEMORY_BUSY");
		ramOwner = this;
		const prefix: EditorAttemptChunk[] = [];
		try {
			for (let seq = 0; seq < this.count; seq++) prefix.push(await this.read(seq));
			this.ram = prefix;
			await this.removeIdb().catch(() => {});
		} catch (error) {
			ramOwner = undefined;
			throw error;
		}
	}
	async append(data: Uint8Array<ArrayBuffer>) {
		if (
			this.disposed ||
			this.seal ||
			data.length > EDITOR_ATTEMPT_CHUNK_BYTES ||
			this.bytes + data.length > EDITOR_FILE_MAX_BYTES
		)
			throw new Error("EDITOR_ATTEMPT_LIMIT");
		if (!data.length) return;
		if (this.count >= EDITOR_ATTEMPT_MAX_CHUNKS) throw new Error("EDITOR_ATTEMPT_LIMIT");
		const chunk: EditorAttemptChunk = {
			seq: this.count,
			offset: this.bytes,
			digest: bytesToHex(sha256(data)),
			data,
		};
		if (!this.ram) {
			try {
				if (!this.db) throw new Error("EDITOR_IDB_UNAVAILABLE");
				const tx = this.db.transaction(["chunks", "attempts"], "readwrite"),
					settled = done(tx);
				tx.objectStore("chunks").add(chunk, [this.id, this.count]);
				tx.objectStore("attempts").put({ id: this.id, expires: Date.now() + TTL });
				await settled;
			} catch {
				await this.fallback();
			}
		}
		if (this.ram) this.ram.push(chunk);
		this.count++;
		this.bytes += data.length;
	}
	finish(seal: EditorRawSeal) {
		if (this.disposed || this.seal || seal.bytes !== this.bytes)
			throw new Error("EDITOR_ATTEMPT_INCOMPLETE");
		this.seal = Object.freeze({ ...seal });
		return this;
	}
	async read(seq: number): Promise<EditorAttemptChunk> {
		if (this.disposed || seq < 0 || seq >= this.count) throw new Error("EDITOR_ATTEMPT_MISSING");
		const value = this.ram
			? this.ram[seq]
			: this.db
				? ((await req(
						this.db.transaction("chunks").objectStore("chunks").get([this.id, seq]),
					)) as EditorAttemptChunk)
				: undefined;
		if (!value || value.seq !== seq || bytesToHex(sha256(value.data)) !== value.digest)
			throw new Error("EDITOR_ATTEMPT_CORRUPT");
		return value;
	}
	async *chunks() {
		for (let seq = 0; seq < this.count; seq++) yield await this.read(seq);
	}
	/** Sequential bounded slice adapter for the existing checkpoint store, not a Blob. */
	body() {
		let seq = 0,
			current: EditorAttemptChunk | undefined,
			position = 0;
		return {
			size: this.bytes,
			slice: (start: number, end: number) => ({
				arrayBuffer: async (): Promise<ArrayBuffer> => {
					end = Math.min(end, this.bytes);
					if (start !== position || end - start > 64 * 1024)
						throw new Error("EDITOR_ATTEMPT_RANGE");
					const bytes = new Uint8Array(end - start);
					let filled = 0;
					while (filled < bytes.length) {
						if (!current || position === current.offset + current.data.length)
							current = await this.read(seq++);
						const from = position - current.offset,
							length = Math.min(bytes.length - filled, current.data.length - from);
						bytes.set(current.data.subarray(from, from + length), filled);
						filled += length;
						position += length;
					}
					return bytes.buffer;
				},
			}),
		};
	}
	private async removeIdb() {
		if (!this.db) return;
		const tx = this.db.transaction(["chunks", "attempts"], "readwrite"),
			settled = done(tx);
		tx.objectStore("chunks").delete(range(this.id));
		tx.objectStore("attempts").delete(this.id);
		try {
			await settled;
		} finally {
			this.db.close();
			this.db = undefined;
		}
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.ram = undefined;
		if (ramOwner === this) ramOwner = undefined;
		await this.removeIdb().catch(() => {});
	}
}
