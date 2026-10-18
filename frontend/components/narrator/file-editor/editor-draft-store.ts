import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EDITOR_TRANSFER_MAX_BYTES } from "@shared/editor-document";
import { createEditorLocalId } from "./editor-local-id";

export interface EditorDraftBody {
	size: number;
	slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
export interface EditorDraftFormatIndex {
	bytes: number;
	chunks: number;
	digest: string;
}
export const editorDraftFormatIndex = (row: Pick<EditorDraftMetadata, "format">) =>
	row.format?.codec === "eol-tags-v1" ? (row.format.root as EditorDraftFormatIndex) : undefined;
function uniformDraftFormat(row: Pick<EditorDraftMetadata, "format">) {
	if (row.format?.codec !== "eol-uniform-v1") return undefined;
	const root = row.format.root as { tag: 1 | 2 | 3; count: number; digest: string } | undefined;
	return root &&
		[1, 2, 3].includes(root.tag) &&
		Number.isSafeInteger(root.count) &&
		root.count >= 0 &&
		root.count <= 1_000_000 &&
		/^[a-f0-9]{64}$/.test(root.digest)
		? root
		: undefined;
}
export const EDITOR_DRAFT_DB = "narrafork-editor-drafts";
export const EDITOR_DRAFT_LIMITS = {
	count: 32,
	bytes: 128 * 1024 * 1024,
	ttlMs: 7 * 86400_000,
	entryBytes: EDITOR_TRANSFER_MAX_BYTES,
	chunkBytes: 64 * 1024,
	writeMs: 60_000,
};
/** The opaque server keys cover principal, actual narrator, origin, device, execution
 * workspace/root and canonical path. The path below is only a display/filter hint. */
export interface EditorDraftScope {
	recoveryKey: string;
	resourceKey: string;
	narratorId: string;
	deviceId: string;
	origin: "legacy" | "reference";
	canonicalPath: string;
	/** UI filter only; never used to authorize or merge resources. */
	requestedPath?: string;
}
export interface EditorDraftOperation {
	/** No transfer/doc IDs or confirmation tokens are persisted. */
	operationId?: string;
	snapshotRevision: number;
	status: "query-first";
}
export interface EditorDraftMetadata {
	id: string;
	schemaVersion: number;
	scope: EditorDraftScope;
	writerId: string;
	modelLifetime: string;
	anchor?: { anchorId: string; checkpointGeneration: string };
	generation: string;
	revision: number;
	alternativeVersionId: number;
	length: number;
	baseVersion: { hash: string | null; hashKind: "v1-decoded-sha256" | "raw-sha256" };
	encoding: string;
	bodyCodec: string;
	protocol: "v1" | "raw-v2";
	/** Future raw metadata is optional, NEVER synthesized for v1. */
	rawDigest?: string;
	textDigest?: string;
	bom?: "none" | "utf8" | "utf16le" | "utf16be";
	preferredEol?: "LF" | "CRLF" | "CR";
	format?: { revision: number; codec: string; root: unknown };
	operation?: EditorDraftOperation;
	digest: string;
	bytes: number;
	chunks: number;
	updatedAt: number;
	/** A bounded writer lease, renewed by the single background scheduler. */
	activeUntil: number;
	complete: true;
}
export type EditorDraftInput = Omit<
	EditorDraftMetadata,
	| "id"
	| "schemaVersion"
	| "generation"
	| "digest"
	| "bytes"
	| "chunks"
	| "updatedAt"
	| "activeUntil"
	| "complete"
>;
interface PendingWrite {
	id: string;
	modelLifetime: string;
	generation: string;
	bytes: number;
	revision: number;
	expires: number;
}
const key = (writer: string, resource: string, modelLifetime: string) =>
	JSON.stringify([writer, resource, modelLifetime]);
const chunkRange = (generation: string) =>
	IDBKeyRange.bound([generation, 0], [generation, 1_000_000]);
const request = <T>(value: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error ?? new Error("EDITOR_DRAFT_TRANSACTION"));
	});
const completed = (tx: IDBTransaction) => {
	const done = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("EDITOR_DRAFT_ABORTED"));
	});
	// A request may reject before its transaction event: keep both failure paths handled.
	void done.catch(() => {});
	return done;
};
function abortable(tx: IDBTransaction, signal?: AbortSignal) {
	const abort = () => {
		try {
			tx.abort();
		} catch {
			/* already settled */
		}
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	return () => signal?.removeEventListener("abort", abort);
}
function validDraftMetadata(row: EditorDraftMetadata) {
	return (
		!!row &&
		row.complete === true &&
		Number.isSafeInteger(row.schemaVersion) &&
		!!row.scope &&
		[
			row.id,
			row.writerId,
			row.modelLifetime,
			row.generation,
			row.scope.recoveryKey,
			row.scope.resourceKey,
			row.scope.narratorId,
			row.scope.deviceId,
			row.scope.canonicalPath,
			row.encoding,
			row.bodyCodec,
		].every((value) => typeof value === "string" && value.length > 0 && value.length <= 4096) &&
		(row.scope.origin === "legacy" || row.scope.origin === "reference") &&
		Number.isSafeInteger(row.revision) &&
		Number.isSafeInteger(row.alternativeVersionId) &&
		Number.isSafeInteger(row.length) &&
		row.length >= 0 &&
		row.length <= 20 * 1024 * 1024 &&
		Number.isSafeInteger(row.bytes) &&
		row.bytes >= 0 &&
		row.bytes <= EDITOR_TRANSFER_MAX_BYTES &&
		Number.isSafeInteger(row.chunks) &&
		row.chunks >= 0 &&
		row.chunks <= 1024 &&
		(!row.anchor ||
			(typeof row.anchor.anchorId === "string" &&
				row.anchor.anchorId.length <= 128 &&
				row.anchor.checkpointGeneration === row.generation)) &&
		Number.isFinite(row.updatedAt) &&
		/^[a-f0-9]{64}$/.test(row.digest) &&
		!!row.baseVersion &&
		(row.baseVersion.hash === null || typeof row.baseVersion.hash === "string")
	);
}
function draftInput(input: EditorDraftInput): EditorDraftInput {
	// Explicit projection: do not persist arbitrary API/session objects or credentials.
	const clean: EditorDraftInput = {
		scope: {
			recoveryKey: input.scope.recoveryKey,
			resourceKey: input.scope.resourceKey,
			narratorId: input.scope.narratorId,
			deviceId: input.scope.deviceId,
			origin: input.scope.origin,
			canonicalPath: input.scope.canonicalPath,
			requestedPath: input.scope.requestedPath,
		},
		writerId: input.writerId,
		modelLifetime: input.modelLifetime,
		...(input.anchor
			? {
					anchor: {
						anchorId: input.anchor.anchorId,
						checkpointGeneration: input.anchor.checkpointGeneration,
					},
				}
			: {}),
		revision: input.revision,
		alternativeVersionId: input.alternativeVersionId,
		length: input.length,
		baseVersion: { hash: input.baseVersion.hash, hashKind: input.baseVersion.hashKind },
		encoding: input.encoding,
		bodyCodec: input.bodyCodec,
		protocol: input.protocol,
		...(input.operation
			? {
					operation: {
						status: "query-first",
						operationId: input.operation.operationId,
						snapshotRevision: input.operation.snapshotRevision,
					},
				}
			: {}),
		...(input.rawDigest !== undefined ? { rawDigest: input.rawDigest } : {}),
		...(input.textDigest !== undefined ? { textDigest: input.textDigest } : {}),
		...(input.bom !== undefined ? { bom: input.bom } : {}),
		...(input.preferredEol !== undefined ? { preferredEol: input.preferredEol } : {}),
		...(input.format !== undefined ? { format: structuredClone(input.format) } : {}),
	};
	if (
		new TextEncoder().encode(JSON.stringify(clean)).byteLength > 32 * 1024 ||
		!validDraftMetadata({
			...clean,
			id: "id",
			generation: clean.anchor?.checkpointGeneration ?? "generation",
			schemaVersion: 1,
			complete: true,
			bytes: 0,
			chunks: 0,
			digest: "0".repeat(64),
			updatedAt: 0,
			activeUntil: 0,
		}) ||
		(clean.format && clean.format.revision !== clean.revision)
	)
		throw new Error("EDITOR_DRAFT_LIMIT");
	return clean;
}
/** Rejection from the owned atomic writer is proof that it did not publish a new pointer. */
export class EditorDraftWriteFailure extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : "EDITOR_DRAFT_WRITE_FAILED", { cause });
		this.name = "EditorDraftWriteFailure";
	}
}
/** An independent database: never touches composer/chat drafts. All scans have hard limits. */
export class EditorDraftStore {
	private database: Promise<IDBDatabase> | undefined;
	readonly diagnostics = { metadataReads: 0, bodyReads: 0, published: 0 };
	constructor(
		private factory = () => globalThis.indexedDB,
		readonly limits = EDITOR_DRAFT_LIMITS,
		private now = Date.now,
		private name = EDITOR_DRAFT_DB,
	) {}
	private open() {
		this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
			try {
				const factory = this.factory();
				if (!factory) throw new Error("EDITOR_DRAFT_UNAVAILABLE");
				const opening = factory.open(this.name, 1);
				opening.onupgradeneeded = () => {
					const db = opening.result;
					const metadata = db.createObjectStore("metadata", { keyPath: "id" });
					metadata.createIndex("owner", "scope.recoveryKey");
					metadata.createIndex("updated", "updatedAt");
					db.createObjectStore("chunks", { keyPath: ["generation", "seq"] });
					db.createObjectStore("writes", { keyPath: "id" });
				};
				opening.onsuccess = () => {
					const db = opening.result;
					db.onversionchange = () => {
						db.close();
						this.database = undefined;
					};
					resolve(db);
				};
				opening.onerror = () => reject(opening.error);
				opening.onblocked = () => reject(new Error("EDITOR_DRAFT_UNAVAILABLE"));
			} catch (error) {
				reject(error);
			}
		}).catch((error) => {
			this.database = undefined;
			throw error;
		});
		return this.database;
	}
	async ensureAvailable(signal?: AbortSignal) {
		signal?.throwIfAborted();
		await this.open();
		signal?.throwIfAborted();
	}
	async list(recoveryKey: string, signal?: AbortSignal): Promise<EditorDraftMetadata[]> {
		signal?.throwIfAborted();
		const db = await this.open();
		const tx = db.transaction("metadata", "readonly");
		const done = completed(tx);
		this.diagnostics.metadataReads++;
		const rows = await request<EditorDraftMetadata[]>(
			tx
				.objectStore("metadata")
				.index("owner")
				.getAll(IDBKeyRange.only(recoveryKey), this.limits.count + 1),
		);
		await done;
		signal?.throwIfAborted();
		if (rows.length > this.limits.count) throw new Error("EDITOR_DRAFT_LIMIT");
		if (rows.some((row) => !validDraftMetadata(row))) throw new Error("EDITOR_DRAFT_CORRUPT");
		return rows.filter(
			(row) => row.updatedAt > this.now() - this.limits.ttlMs || row.activeUntil > this.now(),
		);
	}
	async write(
		input: EditorDraftInput,
		body: EditorDraftBody,
		signal?: AbortSignal,
		sidecar?: Uint8Array,
	) {
		try {
			return await this.writeAtomic(input, body, signal, sidecar);
		} catch (error) {
			throw new EditorDraftWriteFailure(error);
		}
	}
	private async writeAtomic(
		input: EditorDraftInput,
		body: EditorDraftBody,
		signal?: AbortSignal,
		sidecar?: Uint8Array,
	) {
		signal?.throwIfAborted();
		if (sidecar) {
			if (sidecar.length > 1_000_000 || sidecar.some((tag) => tag < 1 || tag > 3))
				throw new Error("EDITOR_FORMAT_INVALID");
			input = {
				...input,
				format: {
					revision: input.revision,
					codec: "eol-tags-v1",
					root: {
						bytes: sidecar.length,
						chunks: Math.ceil(sidecar.length / this.limits.chunkBytes),
						digest: bytesToHex(sha256(sidecar)),
					},
				},
			};
		}
		input = draftInput(input);
		if (body.size > this.limits.entryBytes) throw new Error("EDITOR_DRAFT_LIMIT");
		const db = await this.open();
		const id = key(input.writerId, input.scope.resourceKey, input.modelLifetime);
		const generation = input.anchor?.checkpointGeneration ?? createEditorLocalId();
		const started = this.now();
		const reservation = db.transaction(["metadata", "writes", "chunks"], "readwrite");
		const reserved = completed(reservation);
		try {
			const metadata = reservation.objectStore("metadata"),
				writes = reservation.objectStore("writes");
			const [rows, pending] = await Promise.all([
				request<EditorDraftMetadata[]>(
					metadata.index("updated").getAll(undefined, this.limits.count + 1),
				),
				request<PendingWrite[]>(writes.getAll(undefined, this.limits.count + 1)),
			]);
			if (rows.length > this.limits.count || pending.length > this.limits.count)
				throw new Error("EDITOR_DRAFT_LIMIT");
			if (rows.some((row) => !validDraftMetadata(row))) throw new Error("EDITOR_DRAFT_CORRUPT");
			const live = rows.filter(
				(row) =>
					row.updatedAt > started - this.limits.ttlMs ||
					row.activeUntil > started ||
					pending.some((write) => write.id === row.id && write.expires > started),
			);
			for (const row of rows)
				if (!live.includes(row)) {
					metadata.delete(row.id);
					reservation.objectStore("chunks").delete(chunkRange(row.generation));
				}
			const active = pending.filter((row) => row.expires > started && row.id !== id);
			for (const row of pending)
				if (!active.includes(row)) {
					writes.delete(row.id);
					reservation.objectStore("chunks").delete(chunkRange(row.generation));
				}
			const ids = new Set([...live, ...active].map((row) => row.id));
			ids.add(id);
			const bytes = [...live, ...active].reduce(
				(sum, row) =>
					sum + row.bytes + ("format" in row ? (editorDraftFormatIndex(row)?.bytes ?? 0) : 0),
				body.size + (sidecar?.length ?? 0),
			);
			if (ids.size > this.limits.count || bytes > this.limits.bytes)
				throw new Error("EDITOR_DRAFT_LIMIT");
			writes.put({
				id,
				generation,
				bytes: body.size + (sidecar?.length ?? 0),
				revision: input.revision,
				modelLifetime: input.modelLifetime,
				expires: started + this.limits.writeMs,
			} satisfies PendingWrite);
			await reserved;
		} catch (error) {
			try {
				reservation.abort();
			} catch {
				/* completed */
			}
			await reserved.catch(() => {});
			throw error;
		}
		let chunks = 0;
		const hash = sha256.create();
		try {
			for (let offset = 0; offset < body.size; offset += this.limits.chunkBytes) {
				signal?.throwIfAborted();
				if (this.now() - started >= this.limits.writeMs) throw new Error("EDITOR_DRAFT_TIMEOUT");
				const bytes = new Uint8Array(
					await body.slice(offset, offset + this.limits.chunkBytes).arrayBuffer(),
				);
				hash.update(bytes);
				const tx = db.transaction(["writes", "chunks"], "readwrite");
				const done = completed(tx);
				const current = await request<PendingWrite | undefined>(tx.objectStore("writes").get(id));
				if (current?.generation !== generation || signal?.aborted) {
					tx.abort();
					await done.catch(() => {});
					throw new Error("EDITOR_DRAFT_CANCELLED");
				}
				tx.objectStore("chunks").put({ generation, seq: chunks++, bytes });
				await done;
			}
			if (sidecar)
				for (
					let offset = 0, seq = 1024;
					offset < sidecar.length;
					offset += this.limits.chunkBytes, seq++
				) {
					signal?.throwIfAborted();
					const tx = db.transaction(["writes", "chunks"], "readwrite"),
						settled = completed(tx);
					const current = await request<PendingWrite | undefined>(tx.objectStore("writes").get(id));
					if (current?.generation !== generation) {
						tx.abort();
						throw new Error("EDITOR_DRAFT_CANCELLED");
					}
					tx.objectStore("chunks").put({
						generation,
						seq,
						bytes: sidecar.slice(offset, offset + this.limits.chunkBytes),
					});
					await settled;
				}
			signal?.throwIfAborted();
			const row: EditorDraftMetadata = {
				...input,
				id,
				generation,
				schemaVersion: 1,
				complete: true,
				bytes: body.size,
				chunks,
				digest: bytesToHex(hash.digest()),
				updatedAt: this.now(),
				activeUntil: this.now() + 30_000,
			};
			const tx = db.transaction(["metadata", "writes", "chunks"], "readwrite");
			const done = completed(tx),
				detach = abortable(tx, signal);
			try {
				const current = await request<PendingWrite | undefined>(tx.objectStore("writes").get(id));
				if (current?.generation !== generation || current.expires <= this.now())
					throw new Error("EDITOR_DRAFT_CANCELLED");
				const old = await request<EditorDraftMetadata | undefined>(
					tx.objectStore("metadata").get(id),
				);
				tx.objectStore("metadata").put(row);
				tx.objectStore("writes").delete(id);
				if (old) tx.objectStore("chunks").delete(chunkRange(old.generation));
				await done;
				this.diagnostics.published++;
				return row;
			} catch (error) {
				try {
					tx.abort();
				} catch {}
				await done.catch(() => {});
				throw error;
			} finally {
				detach();
			}
		} catch (error) {
			const tx = db.transaction(["writes", "chunks"], "readwrite"),
				done = completed(tx);
			const current = await request<PendingWrite | undefined>(tx.objectStore("writes").get(id));
			if (current?.generation === generation) tx.objectStore("writes").delete(id);
			tx.objectStore("chunks").delete(chunkRange(generation));
			await done.catch(() => {});
			throw error;
		}
	}
	/** CAS: a late save/discard cannot remove a newer checkpoint or another window. */
	async remove(row: Pick<EditorDraftMetadata, "id" | "generation" | "writerId">, writerId: string) {
		if (row.writerId !== writerId) return false;
		const db = await this.open(),
			tx = db.transaction(["metadata", "chunks"], "readwrite"),
			done = completed(tx);
		const current = await request<EditorDraftMetadata | undefined>(
			tx.objectStore("metadata").get(row.id),
		);
		const matches = current?.generation === row.generation && current.writerId === writerId;
		if (matches) {
			tx.objectStore("metadata").delete(row.id);
			tx.objectStore("chunks").delete(chunkRange(row.generation));
		}
		await done;
		return matches;
	}
	/** Save receipt CAS also fences a still-staged matching revision, not just a known pointer. */
	async removeSaved(
		writerId: string,
		resourceKey: string,
		revision: number | undefined,
		modelLifetime: string,
	) {
		const db = await this.open(),
			tx = db.transaction(["metadata", "writes", "chunks"], "readwrite"),
			done = completed(tx);
		const id = key(writerId, resourceKey, modelLifetime);
		const metadata = tx.objectStore("metadata"),
			writes = tx.objectStore("writes");
		const [row, pending] = await Promise.all([
			request<EditorDraftMetadata | undefined>(metadata.get(id)),
			request<PendingWrite | undefined>(writes.get(id)),
		]);
		let remainingRow = !!row;
		if (
			row?.writerId === writerId &&
			(revision === undefined || row.revision === revision) &&
			row.modelLifetime === modelLifetime
		) {
			metadata.delete(id);
			remainingRow = false;
			tx.objectStore("chunks").delete(chunkRange(row.generation));
		}
		// A staged snapshot captured the previous baseline. Restart it after saving;
		// never delete a newer COMPLETE checkpoint above.
		if (pending && pending.modelLifetime === modelLifetime) {
			writes.delete(id);
			tx.objectStore("chunks").delete(chunkRange(pending.generation));
		}
		await done;
		return remainingRow;
	}
	/** Renews at most one existing checkpoint; cannot manufacture a row or revive a deletion. */
	async protect(row: EditorDraftMetadata, writerId: string, signal?: AbortSignal) {
		if (row.writerId !== writerId) return;
		const db = await this.open(),
			tx = db.transaction("metadata", "readwrite"),
			done = completed(tx);
		const detach = abortable(tx, signal);
		try {
			const store = tx.objectStore("metadata"),
				current = await request<EditorDraftMetadata | undefined>(store.get(row.id));
			if (current?.generation === row.generation && current.writerId === writerId)
				store.put({ ...current, activeUntil: this.now() + 30_000 });
			await done;
		} finally {
			detach();
		}
	}
	async markOperation(
		writerId: string,
		resourceKey: string,
		operation: EditorDraftOperation,
		modelLifetime: string,
	) {
		const db = await this.open(),
			tx = db.transaction(["metadata", "writes", "chunks"], "readwrite"),
			done = completed(tx);
		const id = key(writerId, resourceKey, modelLifetime),
			store = tx.objectStore("metadata");
		const [row, pending] = await Promise.all([
			request<EditorDraftMetadata | undefined>(store.get(id)),
			request<PendingWrite | undefined>(tx.objectStore("writes").get(id)),
		]);
		if (pending) {
			tx.objectStore("writes").delete(id);
			tx.objectStore("chunks").delete(chunkRange(pending.generation));
		}
		if (row)
			store.put({
				...row,
				operation: {
					operationId: operation.operationId,
					snapshotRevision: operation.snapshotRevision,
					status: "query-first",
				},
			});
		await done;
		return row?.anchor;
	}
	/** Only callers holding a freshly server-authorized owner key may invoke body access. */
	async read(row: EditorDraftMetadata, recoveryKey: string, signal?: AbortSignal): Promise<Blob> {
		if (
			!validDraftMetadata(row) ||
			row.scope.recoveryKey !== recoveryKey ||
			row.bytes > this.limits.entryBytes ||
			!Number.isSafeInteger(row.chunks) ||
			row.chunks < 0 ||
			row.chunks > Math.ceil(this.limits.entryBytes / this.limits.chunkBytes)
		)
			throw new Error("EDITOR_DRAFT_CORRUPT");
		const db = await this.open(),
			hash = sha256.create(),
			parts: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		const started = this.now();
		for (let seq = 0; seq < row.chunks; seq++) {
			signal?.throwIfAborted();
			if (this.now() - started >= this.limits.writeMs) throw new Error("EDITOR_DRAFT_TIMEOUT");
			const tx = db.transaction("chunks", "readonly"),
				done = completed(tx);
			this.diagnostics.bodyReads++;
			const chunk = await request<{ bytes: Uint8Array<ArrayBuffer> } | undefined>(
				tx.objectStore("chunks").get([row.generation, seq]),
			);
			await done;
			if (
				!chunk ||
				!(chunk.bytes instanceof Uint8Array) ||
				chunk.bytes.length > this.limits.chunkBytes
			)
				throw new Error("EDITOR_DRAFT_CORRUPT");
			size += chunk.bytes.length;
			if (size > row.bytes) throw new Error("EDITOR_DRAFT_CORRUPT");
			hash.update(chunk.bytes);
			parts.push(chunk.bytes);
		}
		if (size !== row.bytes || bytesToHex(hash.digest()) !== row.digest)
			throw new Error("EDITOR_DRAFT_CORRUPT");
		signal?.throwIfAborted();
		return new Blob(parts, { type: "text/plain;charset=utf-8" });
	}
	async readFormat(row: EditorDraftMetadata, recoveryKey: string, signal?: AbortSignal) {
		const uniform = uniformDraftFormat(row);
		if (
			uniform &&
			validDraftMetadata(row) &&
			row.scope.recoveryKey === recoveryKey &&
			row.format?.revision === row.revision
		) {
			signal?.throwIfAborted();
			const tags = new Uint8Array(uniform.count).fill(uniform.tag);
			if (bytesToHex(sha256(tags)) !== uniform.digest) throw new Error("EDITOR_FORMAT_UNAVAILABLE");
			return tags;
		}
		const index = editorDraftFormatIndex(row);
		if (
			!validDraftMetadata(row) ||
			row.scope.recoveryKey !== recoveryKey ||
			row.format?.codec !== "eol-tags-v1" ||
			row.format.revision !== row.revision ||
			!index ||
			!Number.isSafeInteger(index.bytes) ||
			index.bytes < 0 ||
			index.bytes > 1_000_000 ||
			index.chunks !== Math.ceil(index.bytes / this.limits.chunkBytes)
		)
			throw new Error("EDITOR_FORMAT_UNAVAILABLE");
		const db = await this.open(),
			bytes = new Uint8Array(index.bytes);
		let offset = 0;
		for (let seq = 0; seq < index.chunks; seq++) {
			signal?.throwIfAborted();
			const chunk = await request<{ bytes: Uint8Array } | undefined>(
				db
					.transaction("chunks")
					.objectStore("chunks")
					.get([row.generation, 1024 + seq]),
			);
			if (
				!chunk ||
				!(chunk.bytes instanceof Uint8Array) ||
				chunk.bytes.length !== Math.min(this.limits.chunkBytes, bytes.length - offset)
			)
				throw new Error("EDITOR_FORMAT_UNAVAILABLE");
			bytes.set(chunk.bytes, offset);
			offset += chunk.bytes.length;
		}
		if (
			offset !== bytes.length ||
			bytesToHex(sha256(bytes)) !== index.digest ||
			bytes.some((tag) => tag < 1 || tag > 3)
		)
			throw new Error("EDITOR_FORMAT_UNAVAILABLE");
		return bytes;
	}
	async close() {
		const db = await this.database;
		db?.close();
		this.database = undefined;
	}
}
export const editorDraftStore = new EditorDraftStore();
/** Minted in memory once per realm, NEVER inherited from window.open/sessionStorage. */
export const editorDraftWriterId = createEditorLocalId();
export function draftEditable(row: EditorDraftMetadata) {
	if (row.protocol === "raw-v2") {
		const format = editorDraftFormatIndex(row);
		return (
			row.schemaVersion === 1 &&
			row.bodyCodec === "raw-v2" &&
			row.baseVersion.hashKind === "raw-sha256" &&
			!row.operation &&
			["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030"].includes(row.encoding) &&
			["none", "utf8", "utf16le", "utf16be"].includes(row.bom ?? "") &&
			!!row.rawDigest &&
			row.rawDigest === row.digest &&
			!!row.textDigest &&
			row.format?.revision === row.revision &&
			["LF", "CRLF", "CR"].includes(row.preferredEol ?? "") &&
			(!!uniformDraftFormat(row) ||
				(!!format &&
					Number.isSafeInteger(format.bytes) &&
					format.bytes >= 0 &&
					format.bytes <= 1_000_000))
		);
	}
	return (
		row.schemaVersion === 1 &&
		row.protocol === "v1" &&
		row.bodyCodec === "utf8-v1" &&
		row.baseVersion.hashKind === "v1-decoded-sha256" &&
		!row.operation &&
		/^(utf(?:8|16le|16be|32le|32be)|ucs2|ascii|latin1|windows125[0-8]|iso8859(?:[1-9]|10|11|1[3-6])|gbk|gb2312|gb18030|big5|shiftjis|eucjp|euckr|koi8r|koi8u|macintosh)$/.test(
			row.encoding.toLowerCase().replace(/[-_]/g, ""),
		)
	);
}
