import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	realpath,
	statfs,
	unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";

const DEFAULT_TIMEOUT_MS = 30_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const EMPTY_RELEASE = Object.freeze({ ref: null, published: false });

export type FileChangeBlobErrorCode =
	| "invalid_input"
	| "invalid_ref"
	| "invalid_path"
	| "unsafe_object"
	| "too_large"
	| "chunk_too_large"
	| "size_mismatch"
	| "hash_mismatch"
	| "not_found"
	| "insufficient_space"
	| "disk_full"
	| "aborted"
	| "timeout";

export class FileChangeBlobStoreError extends Error {
	constructor(
		readonly code: FileChangeBlobErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "FileChangeBlobStoreError";
	}
}

export interface FileChangeBlobRelease {
	/** Also present after publication if later cleanup/accounting fails. */
	ref: FileChangeBlobRef | null;
	/** True only when this attempt created the published object. */
	published: boolean;
}

export interface FileChangeBlobLease {
	/** Called exactly once, including failures. Must be bounded and must not need the aborted signal. */
	release(result: FileChangeBlobRelease): void | Promise<void>;
}

export interface FileChangeBlobAdmission {
	/** Reserve temporary bytes before consuming input; account deduplication in release(). */
	reserve(request: {
		expectedSize: number;
		signal: AbortSignal;
	}): FileChangeBlobLease | Promise<FileChangeBlobLease>;
}

export interface FileChangeBlobStoreOptions {
	/** Absolute, non-symlink storage directory. No directory is touched by construction. */
	root?: string;
	minimumFreeBytes?: number;
	defaultTimeoutMs?: number;
	admission?: FileChangeBlobAdmission;
	/** Injectable volume probe for deterministic tests or a stricter storage backend. */
	getAvailableBytes?: (root: string) => Promise<bigint>;
}

export interface FileChangeBlobOperationOptions {
	signal?: AbortSignal;
	/** Includes producer wait / stream lifetime. In-flight filesystem calls settle before cleanup. */
	timeoutMs?: number;
}

export interface FileChangeBlobPutOptions extends FileChangeBlobOperationOptions {
	expectedSize: number;
	expectedDigest?: string;
}

export interface FileChangeBlobReadOptions extends FileChangeBlobOperationOptions {
	/** May lower, never raise, the shared single-blob limit. */
	maxBytes?: number;
}

export type FileChangeBlobSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

type InputCursor = {
	next(): Promise<IteratorResult<Uint8Array>>;
	close(): void;
};

/**
 * Raw immutable bytes only: no DB, catalog scan, ACL, global quota or GC. The caller
 * supplies admission/accounting and must authorize references before reading them.
 * The private directory is an OS trust boundary, not a sandbox against its owner.
 * Hard-link publication is deliberately fail-closed on filesystems without support.
 */
export class FileChangeBlobStore {
	private readonly root: string;
	private readonly minimumFreeBytes: bigint;
	private readonly defaultTimeoutMs: number;
	private readonly admission?: FileChangeBlobAdmission;
	private readonly getAvailableBytes: (root: string) => Promise<bigint>;

	constructor(options: FileChangeBlobStoreOptions = {}) {
		this.root = validateRoot(
			options.root === undefined ? getNarraforkPath("file-change-blobs") : options.root,
		);
		const minimumFreeBytes = options.minimumFreeBytes ?? FILE_CHANGE_LIMITS.minimumFreeBytes;
		assertSize(minimumFreeBytes, "minimumFreeBytes", Number.MAX_SAFE_INTEGER);
		this.minimumFreeBytes = BigInt(minimumFreeBytes);
		this.defaultTimeoutMs = validateTimeout(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
		this.admission = options.admission;
		this.getAvailableBytes =
			options.getAvailableBytes ??
			(async (root) => {
				const volume = await statfs(root, { bigint: true });
				return volume.bavail * volume.bsize;
			});
	}

	async putBytes(bytes: Uint8Array, options: FileChangeBlobPutOptions): Promise<FileChangeBlobRef> {
		validatePutOptions(options);
		if (!(bytes instanceof Uint8Array)) {
			throw fail("invalid_input", "Blob input must be raw Uint8Array bytes");
		}
		if (bytes.byteLength !== options.expectedSize) {
			throw fail("size_mismatch", "Input byte length does not match expectedSize");
		}
		async function* chunks() {
			for (
				let offset = 0;
				offset < bytes.byteLength;
				offset += FILE_CHANGE_LIMITS.streamChunkBytes
			) {
				yield bytes.subarray(offset, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
			}
		}
		return this.putStream(chunks(), options);
	}

	/** Input chunks larger than 1 MiB are rejected, not buffered or silently truncated. */
	async putStream(
		source: FileChangeBlobSource,
		options: FileChangeBlobPutOptions,
	): Promise<FileChangeBlobRef> {
		validatePutOptions(options);
		const { expectedSize, expectedDigest } = options;
		const budget = this.budget(options);
		let cursor: InputCursor | undefined;
		let lease: FileChangeBlobLease | undefined;
		let temp: { path: string; identity: BigIntStats } | undefined;
		let ownedTempPath: string | undefined;
		let handle: FileHandle | undefined;
		let release: FileChangeBlobRelease = EMPTY_RELEASE;
		let primaryError: Error | undefined;
		const cleanupErrors: unknown[] = [];
		try {
			budget.check();
			cursor = inputCursor(source);
			lease = await this.reserve(expectedSize, budget);
			await this.rootDirectory(true, budget);
			await privateDirectory(join(this.root, ".tmp"), true, budget);
			await this.checkFreeSpace(expectedSize, budget);
			const tempPath = join(this.root, ".tmp", `${randomUUID()}.tmp`);
			budget.check();
			handle = await open(
				tempPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			// Record ownership before observing cancellation or a failed first fstat.
			ownedTempPath = tempPath;
			temp = { path: tempPath, identity: await handle.stat({ bigint: true }) };
			budget.check();
			const hash = createHash("sha256");
			let written = 0;
			while (true) {
				budget.check();
				const chunk = await budget.wait(cursor.next());
				budget.check();
				if (chunk.done) break;
				if (!(chunk.value instanceof Uint8Array)) {
					throw fail("invalid_input", "Blob streams must yield Uint8Array chunks");
				}
				if (chunk.value.byteLength > FILE_CHANGE_LIMITS.streamChunkBytes) {
					throw fail("chunk_too_large", "Blob stream chunks must not exceed 1 MiB");
				}
				if (written + chunk.value.byteLength > expectedSize) {
					throw fail("size_mismatch", "Blob stream exceeded expectedSize");
				}
				if (chunk.value.byteLength === 0) {
					// An endless stream of empty resolved promises must not starve the deadline timer.
					await yieldToEventLoop();
					continue;
				}
				// Never hash/write a producer-owned view while asynchronous IO can mutate it.
				const bytes = Buffer.from(chunk.value);
				await this.checkFreeSpace(expectedSize - written, budget);
				let offset = 0;
				while (offset < bytes.byteLength) {
					budget.check();
					const result = await handle.write(
						bytes,
						offset,
						bytes.byteLength - offset,
						written + offset,
					);
					if (result.bytesWritten <= 0) throw new Error("Blob write made no progress");
					offset += result.bytesWritten;
				}
				written += bytes.byteLength;
				hash.update(bytes);
			}
			if (written !== expectedSize)
				throw fail("size_mismatch", "Blob stream ended before expectedSize");
			const digest = hash.digest("hex");
			if (expectedDigest !== undefined && digest !== expectedDigest) {
				throw fail("hash_mismatch", "Blob bytes do not match expectedDigest");
			}
			const ref: FileChangeBlobRef = Object.freeze({
				algorithm: "sha256",
				digest,
				sizeBytes: written,
			});
			budget.check();
			await handle.sync();
			await verifyHandle(handle, ref, budget);
			const destination = await this.objectPath(ref, true, budget);
			await this.checkTempIdentity(temp, budget);
			budget.check();
			try {
				// rename() would overwrite a corrupt existing object. link() is atomic no-clobber.
				await link(temp.path, destination);
				release = { ref, published: true };
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
				const existing = await this.openVerified(ref, budget);
				await existing.close();
				release = { ref, published: false };
			}
			budget.check();
		} catch (error) {
			primaryError = normalizeError(error);
		} finally {
			try {
				cursor?.close();
			} catch (error) {
				cleanupErrors.push(error);
			}
			if (handle && ownedTempPath && !temp) {
				try {
					temp = { path: ownedTempPath, identity: await handle.stat({ bigint: true }) };
				} catch (error) {
					// Fail closed if even cleanup cannot establish the inode we own.
					cleanupErrors.push(error);
				}
			}
			if (handle) await handle.close().catch((error) => cleanupErrors.push(error));
			if (temp) await this.removeOwnTemp(temp).catch((error) => cleanupErrors.push(error));
			// A failed catalog callback never authorizes deleting an already published object.
			if (lease) {
				try {
					await lease.release(Object.freeze(release));
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			budget.dispose();
		}
		if (cleanupErrors.length) {
			throw new AggregateError(
				primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
				"Blob cleanup or admission release failed",
				{ cause: primaryError ?? cleanupErrors[0] },
			);
		}
		if (primaryError) throw primaryError;
		if (!release.ref) throw new Error("Blob publication did not produce a reference");
		return release.ref;
	}

	async readBytes(
		input: FileChangeBlobRef,
		options: FileChangeBlobReadOptions = {},
	): Promise<Uint8Array> {
		const ref = validateRef(input);
		const stream = await this.openReadStream(ref, options);
		const reader = stream.getReader();
		try {
			const result = new Uint8Array(ref.sizeBytes);
			let offset = 0;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (offset + chunk.value.byteLength > result.byteLength) {
					throw fail("size_mismatch", "Blob read exceeded the reference size");
				}
				result.set(chunk.value, offset);
				offset += chunk.value.byteLength;
			}
			if (offset !== ref.sizeBytes) throw fail("size_mismatch", "Blob read ended early");
			return result;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}

	/**
	 * Verify before exposing bytes, then stream at most 1 MiB per pull from that same
	 * descriptor and recheck its hash at EOF. Consumers must observe successful EOF.
	 * An idle, abandoned stream is closed by its operation deadline; cancel it sooner.
	 */
	async openReadStream(
		input: FileChangeBlobRef,
		options: FileChangeBlobReadOptions = {},
	): Promise<ReadableStream<Uint8Array>> {
		const ref = validateRef(input);
		const maxBytes = options.maxBytes ?? FILE_CHANGE_LIMITS.blobBytes;
		assertSize(maxBytes, "maxBytes");
		if (ref.sizeBytes > maxBytes) throw fail("too_large", "Blob exceeds this read's byte budget");
		const budget = this.budget(options);
		let handle: FileHandle | undefined;
		try {
			handle = await this.openVerified(ref, budget);
			budget.check();
			return verifiedReadStream(handle, ref, budget);
		} catch (error) {
			budget.dispose();
			await handle?.close();
			throw normalizeError(error);
		}
	}

	private budget(options: FileChangeBlobOperationOptions): OperationBudget {
		return new OperationBudget(options.signal, options.timeoutMs ?? this.defaultTimeoutMs);
	}

	private async reserve(
		size: number,
		budget: OperationBudget,
	): Promise<FileChangeBlobLease | undefined> {
		if (!this.admission) return undefined;
		budget.check();
		const pending = Promise.resolve(
			this.admission.reserve({ expectedSize: size, signal: budget.signal }),
		);
		try {
			return await budget.wait(pending);
		} catch (error) {
			// A callback ignoring AbortSignal may resolve late. It still owns exactly one release.
			void pending
				.then((lateLease) => lateLease.release(EMPTY_RELEASE))
				.catch((cleanupError) => {
					if (cleanupError !== error)
						console.warn("Late blob admission cleanup failed", cleanupError);
				});
			throw error;
		}
	}

	private async checkFreeSpace(remaining: number, budget: OperationBudget): Promise<void> {
		budget.check();
		const available = await budget.wait(this.getAvailableBytes(this.root));
		budget.check();
		if (typeof available !== "bigint" || available < 0n) {
			throw fail("invalid_input", "Free-space probe must return nonnegative bigint bytes");
		}
		if (available < this.minimumFreeBytes + BigInt(remaining)) {
			throw fail("insufficient_space", "Blob would breach the minimum free disk space");
		}
	}

	private async rootDirectory(create: boolean, budget?: OperationBudget): Promise<void> {
		const base = parse(this.root).root;
		let current = base;
		await checkedDirectory(current, false, false, budget);
		for (const part of this.root.slice(base.length).split(sep)) {
			current = join(current, part);
			await checkedDirectory(current, create, current === this.root, budget);
		}
		budget?.check();
		if (normalizedPath(await realpath(this.root)) !== normalizedPath(this.root)) {
			throw fail("invalid_path", "Blob root must not resolve through a symbolic link");
		}
	}

	private async objectPath(
		ref: FileChangeBlobRef,
		create: boolean,
		budget: OperationBudget,
	): Promise<string> {
		await this.rootDirectory(create, budget);
		const algorithmDirectory = join(this.root, "sha256");
		await privateDirectory(algorithmDirectory, create, budget);
		const shard = join(algorithmDirectory, ref.digest.slice(0, 2));
		await privateDirectory(shard, create, budget);
		return join(shard, ref.digest);
	}

	private async openVerified(ref: FileChangeBlobRef, budget: OperationBudget): Promise<FileHandle> {
		const path = await this.objectPath(ref, false, budget);
		budget.check();
		const before = await lstat(path, { bigint: true });
		assertRegularFile(before);
		const handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		try {
			const opened = await handle.stat({ bigint: true });
			assertRegularFile(opened);
			if (!sameIdentity(before, opened)) throw fail("unsafe_object", "Blob changed while opening");
			await verifyHandle(handle, ref, budget);
			return handle;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	private async checkTempIdentity(
		temp: { path: string; identity: BigIntStats },
		budget?: OperationBudget,
	): Promise<void> {
		await this.rootDirectory(false, budget);
		await privateDirectory(join(this.root, ".tmp"), false, budget);
		const current = await lstat(temp.path, { bigint: true });
		assertRegularFile(current);
		if (!sameIdentity(temp.identity, current)) {
			throw fail("unsafe_object", "Temporary blob was replaced; refusing to touch it");
		}
	}

	private async removeOwnTemp(temp: { path: string; identity: BigIntStats }): Promise<void> {
		try {
			await this.checkTempIdentity(temp);
			await unlink(temp.path);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
	}
}

function verifiedReadStream(
	handle: FileHandle,
	ref: FileChangeBlobRef,
	budget: OperationBudget,
): ReadableStream<Uint8Array> {
	let offset = 0;
	let finished = false;
	let closePromise: Promise<void> | undefined;
	let abortListener: () => void;
	const hash = createHash("sha256");
	const close = () => {
		finished = true;
		budget.signal.removeEventListener("abort", abortListener);
		budget.dispose();
		closePromise ??= handle.close();
		return closePromise;
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abortListener = () => {
					if (finished) return;
					controller.error(budget.signal.reason);
					void close().catch((error) => console.warn("Aborted blob stream close failed", error));
				};
				budget.signal.addEventListener("abort", abortListener, { once: true });
				if (budget.signal.aborted) abortListener();
			},
			async pull(controller) {
				if (finished) return;
				try {
					budget.check();
					let bytes: Uint8Array | undefined;
					if (offset < ref.sizeBytes) {
						const buffer = Buffer.allocUnsafe(
							Math.min(FILE_CHANGE_LIMITS.streamChunkBytes, ref.sizeBytes - offset),
						);
						const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
						if (finished) return;
						budget.check();
						if (!bytesRead) throw fail("size_mismatch", "Blob changed during streaming");
						bytes = buffer.subarray(0, bytesRead);
						offset += bytesRead;
						hash.update(bytes);
					}
					if (offset === ref.sizeBytes) {
						await verifyEnd(handle, ref, hash.digest("hex"), budget);
						if (finished) return;
						if (bytes) controller.enqueue(bytes);
						controller.close();
						await close();
					} else if (bytes) controller.enqueue(bytes);
				} catch (error) {
					if (!finished) controller.error(normalizeError(error));
					await close();
				}
			},
			cancel() {
				return close();
			},
		},
		{ highWaterMark: 0 },
	);
}

async function verifyHandle(
	handle: FileHandle,
	ref: FileChangeBlobRef,
	budget: OperationBudget,
): Promise<void> {
	budget.check();
	const before = await handle.stat({ bigint: true });
	assertRegularFile(before);
	if (before.size !== BigInt(ref.sizeBytes))
		throw fail("size_mismatch", "Stored blob size differs");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(
		Math.min(FILE_CHANGE_LIMITS.streamChunkBytes, ref.sizeBytes || 1),
	);
	let offset = 0;
	while (offset < ref.sizeBytes) {
		budget.check();
		const { bytesRead } = await handle.read(
			buffer,
			0,
			Math.min(buffer.byteLength, ref.sizeBytes - offset),
			offset,
		);
		budget.check();
		if (!bytesRead) throw fail("size_mismatch", "Stored blob ended before its reference size");
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	await verifyEnd(handle, ref, hash.digest("hex"), budget);
	const after = await handle.stat({ bigint: true });
	// Concurrent no-clobber publication/unlink changes ctime/nlink, but not the bytes.
	if (!sameIdentity(before, after) || before.mtimeNs !== after.mtimeNs) {
		throw fail("unsafe_object", "Blob changed while being verified");
	}
}

async function verifyEnd(
	handle: FileHandle,
	ref: FileChangeBlobRef,
	digest: string,
	budget: OperationBudget,
): Promise<void> {
	budget.check();
	const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, ref.sizeBytes);
	const current = await handle.stat({ bigint: true });
	budget.check();
	assertRegularFile(current);
	if (extra.bytesRead || current.size !== BigInt(ref.sizeBytes)) {
		throw fail("size_mismatch", "Stored blob grew or shrank during verification");
	}
	if (digest !== ref.digest)
		throw fail("hash_mismatch", "Stored blob SHA256 differs from its reference");
}

class OperationBudget {
	private readonly controller = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly externalAbort: () => void;
	readonly signal = this.controller.signal;

	constructor(
		private readonly external: AbortSignal | undefined,
		timeoutMs: number,
	) {
		validateTimeout(timeoutMs);
		this.externalAbort = () =>
			this.controller.abort(fail("aborted", "Blob operation was aborted", external?.reason));
		external?.addEventListener("abort", this.externalAbort, { once: true });
		this.timer = setTimeout(
			() => this.controller.abort(fail("timeout", "Blob operation exceeded its deadline")),
			timeoutMs,
		);
		if (external?.aborted) this.externalAbort();
	}

	check(): void {
		if (this.signal.aborted) throw this.signal.reason;
	}

	wait<T>(pending: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const aborted = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", aborted, { once: true });
			pending.then(
				(value) => {
					this.signal.removeEventListener("abort", aborted);
					resolve(value);
				},
				(error) => {
					this.signal.removeEventListener("abort", aborted);
					reject(error);
				},
			);
			if (this.signal.aborted) aborted();
		});
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.external?.removeEventListener("abort", this.externalAbort);
	}
}

function inputCursor(source: FileChangeBlobSource): InputCursor {
	if (source && "getReader" in source && typeof source.getReader === "function") {
		const reader = source.getReader();
		return {
			next: async () => {
				const chunk = await reader.read();
				return chunk.done ? { done: true, value: undefined } : { done: false, value: chunk.value };
			},
			close: () => {
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			},
		};
	}
	if (!source || typeof source[Symbol.asyncIterator] !== "function") {
		throw fail("invalid_input", "Blob source must be an async byte iterable or ReadableStream");
	}
	const iterator = source[Symbol.asyncIterator]();
	return {
		next: async () => iterator.next(),
		close: () => {
			// Uncooperative generators can remain stuck in next(); never await their return().
			try {
				void Promise.resolve(iterator.return?.()).catch(() => {});
			} catch {
				// Input cleanup cannot undo a settled file operation or bypass lease release.
			}
		},
	};
}

function validateRoot(root: string): string {
	if (
		typeof root !== "string" ||
		root.length > 4096 ||
		root.includes("\0") ||
		!isAbsolute(root) ||
		root.split(/[\\/]/).some((part) => part === "." || part === "..")
	) {
		throw fail("invalid_path", "Blob root must be an absolute path without traversal components");
	}
	const path = resolve(root);
	if (path === parse(path).root || path.split(sep).length > 256) {
		throw fail(
			"invalid_path",
			"Filesystem roots and excessively deep blob directories are forbidden",
		);
	}
	return path;
}

function normalizedPath(path: string): string {
	return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

async function checkedDirectory(
	path: string,
	create: boolean,
	privateMode: boolean,
	budget?: OperationBudget,
): Promise<void> {
	budget?.check();
	let info: BigIntStats;
	try {
		info = await lstat(path, { bigint: true });
	} catch (error) {
		if (!create || !hasCode(error, "ENOENT")) throw error;
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (mkdirError) {
			if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
		}
		info = await lstat(path, { bigint: true });
	}
	budget?.check();
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw fail("invalid_path", "Blob directory is not a real directory");
	}
	if (privateMode && process.platform !== "win32" && (info.mode & 0o077n) !== 0n) {
		throw fail("invalid_path", "Blob directories must be private (0700)");
	}
}

function privateDirectory(path: string, create: boolean, budget?: OperationBudget): Promise<void> {
	return checkedDirectory(path, create, true, budget);
}

function assertRegularFile(info: BigIntStats): void {
	if (!info.isFile() || info.isSymbolicLink())
		throw fail("unsafe_object", "Blob is not a regular file");
	if (process.platform !== "win32" && (info.mode & 0o077n) !== 0n) {
		throw fail("unsafe_object", "Blob files must not be accessible to other users");
	}
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function validateRef(input: FileChangeBlobRef): FileChangeBlobRef {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw fail("invalid_ref", "Blob reference must be a plain object");
	}
	const proto = Object.getPrototypeOf(input);
	if (proto !== Object.prototype && proto !== null)
		throw fail("invalid_ref", "Invalid blob reference prototype");
	const keys = Reflect.ownKeys(input);
	if (
		keys.length !== 3 ||
		keys.some(
			(key) => typeof key !== "string" || !["algorithm", "digest", "sizeBytes"].includes(key),
		)
	) {
		throw fail("invalid_ref", "Blob references accept only algorithm, digest and sizeBytes");
	}
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) {
			throw fail("invalid_ref", "Blob reference accessors are forbidden");
		}
	}
	if (
		input.algorithm !== "sha256" ||
		!isDigest(input.digest) ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		input.sizeBytes > FILE_CHANGE_LIMITS.blobBytes
	) {
		throw fail("invalid_ref", "Blob reference has an invalid algorithm, digest or size");
	}
	return Object.freeze({ algorithm: "sha256", digest: input.digest, sizeBytes: input.sizeBytes });
}

function isDigest(value: unknown): value is string {
	// JavaScript's $ anchor alone also matches before a final line terminator.
	return typeof value === "string" && value.length === 64 && DIGEST_PATTERN.test(value);
}

function validatePutOptions(options: FileChangeBlobPutOptions): void {
	if (!options || typeof options !== "object")
		throw fail("invalid_input", "expectedSize is required");
	assertSize(options.expectedSize, "expectedSize");
	if (options.expectedDigest !== undefined && !isDigest(options.expectedDigest)) {
		throw fail("invalid_ref", "expectedDigest must be a lowercase SHA256 digest");
	}
}

function assertSize(
	value: number,
	field: string,
	maximum: number = FILE_CHANGE_LIMITS.blobBytes,
): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw fail("invalid_input", `${field} must be a nonnegative safe integer`);
	}
	if (value > maximum) throw fail("too_large", `${field} exceeds the byte budget`);
}

function validateTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
		throw fail("invalid_input", "timeoutMs must be an integer between 1 and 2147483647");
	}
	return value;
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function normalizeError(error: unknown): Error {
	if (error instanceof FileChangeBlobStoreError) return error;
	if (hasCode(error, "ENOSPC") || hasCode(error, "EDQUOT")) {
		return fail("disk_full", "Disk space or filesystem quota exhausted", error);
	}
	if (hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
		return fail("invalid_path", "Blob path contains an unsafe filesystem object", error);
	}
	if (hasCode(error, "ENOENT"))
		return fail("not_found", "Blob object or storage directory is missing", error);
	return error instanceof Error ? error : new Error("Blob operation failed", { cause: error });
}

function fail(
	code: FileChangeBlobErrorCode,
	message: string,
	cause?: unknown,
): FileChangeBlobStoreError {
	return new FileChangeBlobStoreError(code, message, cause === undefined ? undefined : { cause });
}
