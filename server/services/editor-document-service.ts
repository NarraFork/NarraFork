import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
	type CreateEditorDocumentInput,
	type CreateEditorUploadInput,
	EDITOR_MAX_SESSIONS,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_SESSION_IDLE_MS,
	EDITOR_TEMP_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	EDITOR_UPLOAD_IDLE_MS,
	EDITOR_USER_MAX_SESSIONS,
	EDITOR_USER_TEMP_MAX_BYTES,
	type EditorCommitInput,
	type EditorCommitResult,
	type EditorDocumentDescriptor,
	type EditorOperationResult,
	type EditorSaveResult,
	type EditorUploadDescriptor,
} from "../../shared/editor-document";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { EditorOperationMetadata } from "../lib/validators/editor-documents";
import { EditorDocumentJobs } from "./editor-document-jobs";
import type { EditorVersionMetadata } from "./editor-document-worker";
import type { EditorFileChangeRequest, FileChangeCompletion } from "./file-change-runtime";

export interface EditorBinding {
	cwd: string;
	projectId: string | null;
	lexicalPath: string;
	canonicalPath: string;
	outsideRoots: boolean;
}
export interface EditorActor {
	userId: string;
	narratorId: string;
	locale?: "en" | "zh-CN";
	authorize(input: CreateEditorDocumentInput, need: "read" | "write"): Promise<EditorBinding>;
}
export class EditorDocumentError extends AppError {
	constructor(
		code: string,
		message: string,
		status = 409,
		readonly data: Record<string, unknown> = {},
	) {
		super(message, status, code);
	}
}
interface Version {
	handle: string;
	path: string;
	metadata: EditorVersionMetadata;
	readers?: number;
	/** Set synchronously before unlink; never admit a new descriptor after this fence. */
	retiring?: boolean;
}
interface Upload extends CreateEditorUploadInput, EditorUploadDescriptor {
	path: string;
	reserved: number;
	busy: boolean;
	controller: AbortController;
	cleanup?: Promise<void>;
	operationId?: string;
	result?: EditorSaveResult;
	error?: EditorDocumentError;
	confirmation?: {
		token: string;
		expires: number;
		physicalPath: string;
		digest: string;
		baseHash: string | null;
	};
}
interface Session {
	id: string;
	userId: string;
	narratorId: string;
	input: CreateEditorDocumentInput;
	binding: EditorBinding;
	source?: Version;
	conflict?: Version;
	uploads: Map<string, Upload>;
	looseFiles: Set<string>;
	reserved: number;
	lastUsed: number;
	pins: number;
	closing: boolean;
	committing: boolean;
	cleanup?: Promise<void>;
}
interface Operation {
	userId: string;
	narratorId: string;
	value: EditorOperationResult;
	expires: number;
	recovery?: EditorOperationMetadata;
}
export interface EditorDocumentDependencies {
	root: string;
	jobs?: EditorDocumentJobs;
	/** Version-object unlink boundary, injectable for race/failure tests; never target-file IO. */
	unlinkVersion?: (path: string) => Promise<void>;
	execute(
		request: EditorFileChangeRequest<{ hash: string; bytes: number }>,
	): Promise<FileChangeCompletion<{ hash: string; bytes: number }>>;
	queryOperation?(
		actor: EditorActor,
		operationId: string,
		recovery?: EditorOperationMetadata,
	): Promise<EditorOperationResult>;
	afterWrite?(
		binding: EditorBinding,
		narratorId: string,
		requestId: string,
		run: () => Promise<void>,
		actor: EditorActor,
	): Promise<void>;
}
const expired = () =>
	new EditorDocumentError(
		"EDITOR_SESSION_EXPIRED",
		"Editor session expired; keep the local draft and reopen the session",
		410,
	);
const invalid = (message: string) => new EditorDocumentError("EDITOR_INVALID_STATE", message);

function storageUnavailable(message: string): AppError {
	return new AppError(message, 503, "EDITOR_STORAGE_UNAVAILABLE");
}

function tempDirectoryIdentity(stat: Stats): string {
	return `${stat.dev}:${stat.ino}`;
}

function isPrivateOwnedTempDirectory(stat: Stats): boolean {
	if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
	if (process.platform === "win32") return true;
	const euid = process.geteuid?.();
	return (stat.mode & 0o077) === 0 && (euid === undefined || stat.uid === euid);
}

/**
 * Ensure `root` is a private, process-owned, non-symlink directory.
 *
 * The path holds disposable editor transfer objects. Operational faults — loose
 * permissions after a home-directory chmod, a leftover symlink/file from a
 * migration, a missing directory after a partial restore — are repaired in place
 * instead of surfacing as session errors. Only shapes we cannot safely fix
 * (foreign-owned non-empty directory we cannot chown, chmod failures) throw.
 *
 * Symlink/non-directory replacement unlinks the path node itself; it never
 * follows the link or deletes the link target's contents.
 */
async function ensureEditorTempDirectory(root: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await mkdir(root, { recursive: true, mode: 0o700 });
		} catch (error) {
			lastError = error;
		}
		let stat: Stats;
		try {
			stat = await lstat(root);
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (isPrivateOwnedTempDirectory(stat)) return tempDirectoryIdentity(stat);
		try {
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				await rm(root, { recursive: true, force: true });
				continue;
			}
			if (process.platform !== "win32") {
				const euid = process.geteuid?.();
				if (euid !== undefined && stat.uid !== euid) {
					try {
						await chown(root, euid, process.getegid?.() ?? -1);
						continue;
					} catch (error) {
						lastError = error;
					}
					const entries = await readdir(root).catch(() => null);
					if (entries && entries.length === 0) {
						await rmdir(root);
						continue;
					}
					throw storageUnavailable(
						"Editor temporary directory is owned by another account and cannot be repaired automatically",
					);
				}
				await chmod(root, 0o700);
			}
		} catch (error) {
			if (error instanceof AppError) throw error;
			lastError = error;
		}
	}
	const detail =
		lastError instanceof Error && lastError.message
			? lastError.message.slice(0, 160)
			: "unrecoverable filesystem shape";
	throw storageUnavailable(
		`Editor temporary directory must be owned, private and non-symlink; automatic repair failed: ${detail}`,
	);
}

/** All state is bounded metadata. Text exists only in worker memory and private temporary objects. */
export class EditorDocumentService {
	private sessions = new Map<string, Session>();
	private operations = new Map<string, Operation>();
	private readonly jobs: EditorDocumentJobs;
	private ready?: Promise<void>;
	private rootIdentity?: string;
	private heal?: Promise<void>;
	private timer?: ReturnType<typeof setInterval>;
	constructor(private readonly deps: EditorDocumentDependencies) {
		this.jobs = deps.jobs ?? new EditorDocumentJobs();
	}
	private initialize(): Promise<void> {
		this.ready ??= this.bootstrap().catch((error) => {
			// Allow the next editor open to retry after a transient FS failure.
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}
	private async bootstrap(): Promise<void> {
		this.rootIdentity = await ensureEditorTempDirectory(this.deps.root);
		const cleaned = await this.jobs.run("startup-cleanup", {
			action: "cleanup",
			root: this.deps.root,
		});
		if (cleaned.kind !== "cleaned") throw invalid("Unexpected recovery worker response");
		for (const recovery of cleaned.operations)
			this.operations.set(recovery.operationId, {
				userId: recovery.userId,
				narratorId: recovery.narratorId,
				recovery,
				value: { status: "uncertain", operationId: recovery.operationId },
				expires: recovery.createdAt + EDITOR_SESSION_IDLE_MS,
			});
		this.timer = setInterval(() => {
			void this.sweep();
		}, 30_000);
		this.timer.unref();
	}
	private async healRoot(): Promise<void> {
		this.heal ??= (async () => {
			const identity = await ensureEditorTempDirectory(this.deps.root);
			const previous = this.rootIdentity;
			this.rootIdentity = identity;
			if (previous !== identity)
				logger.warn("Repaired editor temporary directory", {
					path: this.deps.root,
					previousIdentity: previous ?? null,
					identity,
				});
		})().finally(() => {
			this.heal = undefined;
		});
		await this.heal;
	}
	private async assertStore() {
		const stat = await lstat(this.deps.root).catch(() => null);
		if (
			stat &&
			isPrivateOwnedTempDirectory(stat) &&
			tempDirectoryIdentity(stat) === this.rootIdentity
		)
			return;
		try {
			await this.healRoot();
		} catch (error) {
			if (error instanceof AppError)
				throw new EditorDocumentError("EDITOR_STORAGE_UNAVAILABLE", error.message, 503);
			throw error;
		}
	}
	private path() {
		return join(this.deps.root, `ed-${randomUUID()}`);
	}
	private reserve(session: Session, delta: number) {
		if (delta > 0) {
			let total = this.operations.size * EDITOR_METADATA_MAX_BYTES,
				user =
					[...this.operations.values()].filter((o) => o.userId === session.userId).length *
					EDITOR_METADATA_MAX_BYTES;
			for (const entry of this.sessions.values()) {
				total += entry.reserved;
				if (entry.userId === session.userId) user += entry.reserved;
			}
			if (total + delta > EDITOR_TEMP_MAX_BYTES || user + delta > EDITOR_USER_TEMP_MAX_BYTES)
				throw new EditorDocumentError(
					"EDITOR_QUOTA_EXCEEDED",
					"Editor temporary storage quota exceeded",
					429,
				);
		}
		session.reserved += delta;
	}
	private async bound(actor: EditorActor, docId: string, need: "read" | "write") {
		const session = this.sessions.get(docId);
		if (
			!session ||
			session.closing ||
			session.userId !== actor.userId ||
			session.narratorId !== actor.narratorId
		)
			throw expired();
		if (Date.now() - session.lastUsed > EDITOR_SESSION_IDLE_MS && session.pins === 0) {
			await this.release(session);
			throw expired();
		}
		await this.assertStore();
		const binding = await actor.authorize(session.input, need);
		if (
			binding.cwd !== session.binding.cwd ||
			binding.projectId !== session.binding.projectId ||
			binding.lexicalPath !== session.binding.lexicalPath ||
			binding.canonicalPath !== session.binding.canonicalPath
		)
			throw new EditorDocumentError(
				"EDITOR_IDENTITY_CHANGED",
				"Editor resource identity changed",
				403,
			);
		if (session.closing || !this.sessions.has(docId)) throw expired();
		session.lastUsed = Date.now();
		return { session, binding };
	}
	async create(
		actor: EditorActor,
		input: CreateEditorDocumentInput,
		signal?: AbortSignal,
	): Promise<EditorDocumentDescriptor> {
		await this.initialize();
		await this.assertStore();
		const binding = await actor.authorize(input, "read");
		if (
			this.sessions.size >= EDITOR_MAX_SESSIONS ||
			[...this.sessions.values()].filter((s) => s.userId === actor.userId).length >=
				EDITOR_USER_MAX_SESSIONS
		)
			throw new EditorDocumentError("EDITOR_QUOTA_EXCEEDED", "Too many editor sessions", 429);
		const session: Session = {
			id: randomUUID(),
			userId: actor.userId,
			narratorId: actor.narratorId,
			input: Object.freeze({ ...input }),
			binding,
			uploads: new Map(),
			looseFiles: new Set(),
			reserved: 0,
			lastUsed: Date.now(),
			pins: 1,
			closing: false,
			committing: false,
		};
		this.sessions.set(session.id, session);
		const path = this.path();
		session.looseFiles.add(path);
		try {
			this.reserve(session, EDITOR_TRANSFER_MAX_BYTES);
			const result = await this.jobs.run(
				actor.userId,
				{ action: "source", sourcePath: binding.canonicalPath, outputPath: path },
				signal,
			);
			if (result.kind !== "source") throw invalid("Unexpected source worker response");
			await this.bound(actor, session.id, "read");
			this.reserve(session, result.metadata.utf8Bytes - EDITOR_TRANSFER_MAX_BYTES);
			session.source = { path, handle: randomUUID(), metadata: result.metadata };
			session.looseFiles.delete(path);
			return {
				docId: session.id,
				target: { deviceId: "local", path: binding.canonicalPath },
				versionHandle: session.source.handle,
				...result.metadata,
			};
		} catch (error) {
			await unlink(path).catch(() => {});
			session.closing = true;
			throw error;
		} finally {
			session.pins--;
			if (session.closing) await this.release(session);
		}
	}
	async content(
		actor: EditorActor,
		docId: string,
		versionHandle: string,
		signal?: AbortSignal,
	): Promise<ReadableStream<Uint8Array>> {
		const { session } = await this.bound(actor, docId, "read");
		const version = [session.source, session.conflict].find((v) => v?.handle === versionHandle);
		if (!version) throw expired();
		if (version.retiring)
			throw new EditorDocumentError(
				"EDITOR_VERSION_RETIRED",
				"This immutable conflict version is being retired and cannot accept new downloads",
				410,
			);
		if (session.pins >= 8)
			throw new EditorDocumentError("EDITOR_BUSY", "Too many active document transfers", 429);
		session.pins++;
		version.readers = (version.readers ?? 0) + 1;
		let file: Awaited<ReturnType<typeof open>>;
		try {
			const entryBefore = await lstat(version.path);
			if (
				!entryBefore.isFile() ||
				entryBefore.isSymbolicLink() ||
				entryBefore.size !== version.metadata.utf8Bytes
			)
				throw expired();
			// The private namespace can still be replaced by external filesystem activity.
			// Do not wait for a FIFO writer if it was swapped in after lstat.
			file = await open(
				version.path,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
			);
			const stat = await file.stat();
			if (!stat.isFile() || stat.size !== version.metadata.utf8Bytes) {
				await file.close();
				throw expired();
			}
		} catch (error) {
			session.pins--;
			version.readers--;
			throw error;
		}
		let closed = false;
		let idle: ReturnType<typeof setTimeout> | undefined;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const close = async () => {
			if (closed) return;
			closed = true;
			clearTimeout(idle);
			signal?.removeEventListener("abort", abort);
			try {
				await file.close();
			} finally {
				session.pins--;
				version.readers = Math.max(0, (version.readers ?? 1) - 1);
				if (session.closing) await this.release(session);
			}
		};
		const abort = () => {
			if (closed) return;
			controller.error(
				new EditorDocumentError(
					"EDITOR_TRANSFER_CANCELLED",
					"Document transfer cancelled or idle",
					408,
				),
			);
			void close().catch((error) =>
				logger.debug("Editor download cleanup failed", { error: String(error) }),
			);
		};
		const touch = () => {
			clearTimeout(idle);
			idle = setTimeout(abort, EDITOR_UPLOAD_IDLE_MS);
			idle.unref();
		};
		return new ReadableStream({
			start: (value) => {
				controller = value;
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				else touch();
			},
			pull: async () => {
				try {
					if (closed) return;
					const bytes = new Uint8Array(EDITOR_TRANSFER_CHUNK_BYTES);
					const result = await file.read(bytes, 0, bytes.length, null);
					if (closed) return;
					if (!result.bytesRead) {
						await close();
						controller.close();
					} else {
						session.lastUsed = Date.now();
						touch();
						controller.enqueue(bytes.subarray(0, result.bytesRead));
					}
				} catch (error) {
					await close();
					controller.error(error);
				}
			},
			cancel: close,
		});
	}
	async createUpload(
		actor: EditorActor,
		docId: string,
		input: CreateEditorUploadInput,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.bound(actor, docId, "write");
		if (session.uploads.size >= 32)
			throw new EditorDocumentError(
				"EDITOR_QUOTA_EXCEEDED",
				"Reopen this document session before another save",
				429,
			);
		if (
			[...session.uploads.values()].some((u) =>
				["uploading", "sealed", "committing"].includes(u.state),
			)
		)
			throw invalid("Document already has an active upload");
		if (input.encoding !== session.source?.metadata.encoding)
			throw invalid("Encoding does not match the opened source");
		this.reserve(session, EDITOR_TRANSFER_MAX_BYTES);
		const upload: Upload = {
			...input,
			uploadId: randomUUID(),
			operationId: randomUUID(),
			state: "uploading",
			path: this.path(),
			reserved: EDITOR_TRANSFER_MAX_BYTES,
			busy: false,
			controller: new AbortController(),
		};
		session.uploads.set(upload.uploadId, upload);
		return { uploadId: upload.uploadId, operationId: upload.operationId, state: upload.state };
	}
	private upload(session: Session, id: string): Upload {
		const upload = session.uploads.get(id);
		if (!upload) throw expired();
		return upload;
	}
	async put(
		actor: EditorActor,
		docId: string,
		uploadId: string,
		body: ReadableStream<Uint8Array> | null,
		length: number | undefined,
		signal?: AbortSignal,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.bound(actor, docId, "write");
		const upload = this.upload(session, uploadId);
		if (upload.state !== "uploading" || upload.busy)
			throw invalid("Upload body is immutable after sealing or while receiving");
		if (
			length !== undefined &&
			(!Number.isSafeInteger(length) || length < 0 || length > EDITOR_TRANSFER_MAX_BYTES)
		)
			throw new EditorDocumentError("EDITOR_TOO_LARGE", "Invalid upload Content-Length", 413);
		upload.busy = true;
		session.pins++;
		const reader = body?.getReader();
		const abort = () => upload.controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		let file: Awaited<ReturnType<typeof open>> | undefined;
		let bytes = 0;
		try {
			file = await open(upload.path, "wx", 0o600);
			while (reader) {
				upload.controller.signal.throwIfAborted();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let onAbort: (() => void) | undefined;
				const chunk = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new EditorDocumentError(
										"EDITOR_UPLOAD_TIMEOUT",
										"Upload made no progress for 10 seconds",
										408,
									),
								),
							EDITOR_UPLOAD_IDLE_MS,
						);
						onAbort = () =>
							reject(new EditorDocumentError("EDITOR_CANCELLED", "Upload cancelled", 409));
						upload.controller.signal.addEventListener("abort", onAbort, { once: true });
					}),
				]).finally(() => {
					clearTimeout(timer);
					if (onAbort) upload.controller.signal.removeEventListener("abort", onAbort);
				});
				if (chunk.done) break;
				if (
					bytes + chunk.value.byteLength > EDITOR_TRANSFER_MAX_BYTES ||
					(length !== undefined && bytes + chunk.value.byteLength > length)
				)
					throw new EditorDocumentError(
						"EDITOR_TOO_LARGE",
						"Upload exceeds its declared length or transfer budget",
						413,
					);
				for (
					let offset = 0;
					offset < chunk.value.byteLength;
					offset += EDITOR_TRANSFER_CHUNK_BYTES
				) {
					upload.controller.signal.throwIfAborted();
					await file.writeFile(chunk.value.subarray(offset, offset + EDITOR_TRANSFER_CHUNK_BYTES));
				}
				bytes += chunk.value.byteLength;
				session.lastUsed = Date.now();
			}
			if (length !== undefined && length !== bytes) throw invalid("Upload was truncated");
			await file.close();
			file = undefined;
			const result = await this.jobs.run(
				actor.userId,
				{ action: "seal", path: upload.path },
				upload.controller.signal,
			);
			if (result.kind !== "sealed" || result.bytes !== bytes)
				throw invalid("Upload validation failed");
			await this.bound(actor, docId, "write");
			upload.controller.signal.throwIfAborted();
			this.reserve(session, bytes - upload.reserved);
			upload.reserved = bytes;
			upload.bytes = bytes;
			upload.digest = result.digest;
			upload.state = "sealed";
			return {
				uploadId,
				operationId: upload.operationId,
				state: "sealed",
				bytes,
				digest: result.digest,
			};
		} catch (error) {
			upload.state = "cancelled";
			void reader?.cancel().catch(() => {});
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
			await file?.close();
			upload.busy = false;
			session.pins--;
			if (upload.state === "cancelled") await this.cleanUpload(session, upload);
			if (session.closing) await this.release(session);
		}
	}
	async commit(
		actor: EditorActor,
		docId: string,
		uploadId: string,
		input: EditorCommitInput,
	): Promise<EditorCommitResult> {
		const { session, binding } = await this.bound(actor, docId, "write");
		const upload = this.upload(session, uploadId);
		if (upload.state === "settled") {
			if (upload.error) throw upload.error;
			if (upload.result) return upload.result;
			throw invalid("Missing settled result");
		}
		if (upload.state === "committing")
			return { status: "committing", operationId: upload.operationId as string };
		if (upload.state !== "sealed" || !upload.digest)
			throw invalid("Only a sealed upload can be committed");
		if (session.committing) throw invalid("Document is already committing");
		if (session.conflict?.readers)
			throw invalid("Finish or cancel the previous conflict download before saving again");
		const confirmed =
			upload.confirmation &&
			upload.confirmation.expires > Date.now() &&
			upload.confirmation.token === input.confirmationToken &&
			upload.confirmation.physicalPath === binding.canonicalPath &&
			upload.confirmation.digest === upload.digest &&
			upload.confirmation.baseHash === upload.baseHash;
		if (binding.outsideRoots && !confirmed) {
			upload.confirmation = {
				token: randomUUID(),
				expires: Date.now() + 60_000,
				physicalPath: binding.canonicalPath,
				digest: upload.digest,
				baseHash: upload.baseHash,
			};
			throw new EditorDocumentError(
				"NEEDS_CONFIRMATION",
				"Confirm saving outside writable roots",
				409,
				{ physicalPath: binding.canonicalPath, confirmationToken: upload.confirmation.token },
			);
		}
		if (
			this.operations.size >= 1024 ||
			[...this.operations.values()].filter((o) => o.userId === actor.userId).length >= 128
		)
			throw new EditorDocumentError(
				"EDITOR_QUOTA_EXCEEDED",
				"Too many recent editor operations",
				429,
			);
		// Reserve conflict capture before dispatch; a quota failure does not consume the sealed body.
		this.reserve(session, EDITOR_TRANSFER_MAX_BYTES + EDITOR_METADATA_MAX_BYTES);
		let conflictReserved = EDITOR_TRANSFER_MAX_BYTES;
		const conflictPath = this.path();
		session.looseFiles.add(conflictPath);
		upload.state = "committing";
		session.committing = true;
		session.pins++;
		const operationId = upload.operationId as string;
		upload.operationId = operationId;
		const recoveryTemporary = join(this.deps.root, `ed-${operationId}`);
		session.looseFiles.add(recoveryTemporary);
		const operation: Operation = {
			userId: actor.userId,
			narratorId: actor.narratorId,
			value: { status: "committing", operationId },
			expires: Date.now() + EDITOR_SESSION_IDLE_MS,
		};
		this.operations.set(operationId, operation);
		this.reserve(session, -EDITOR_METADATA_MAX_BYTES); // Reservation is now owned by operations.
		try {
			const run = async () =>
				this.jobs.withIo(actor.userId, async (signal) => {
					const completed = await this.deps.execute({
						requestId: operationId,
						userId: actor.userId,
						narratorId: actor.narratorId,
						projectId: binding.projectId,
						cwd: binding.cwd,
						lexicalPath: binding.lexicalPath,
						canonicalPath: binding.canonicalPath,
						signal,
						input: {
							docId,
							uploadId,
							digest: upload.digest,
							baseHash: upload.baseHash,
							encoding: upload.encoding,
							snapshotRevision: upload.snapshotRevision,
						},
						authorize: async () => {
							// Cancellation/DELETE may mark closing after commit began; pin keeps the bound bytes alive.
							const fresh = await actor.authorize(session.input, "write");
							if (
								fresh.cwd !== binding.cwd ||
								fresh.projectId !== binding.projectId ||
								fresh.lexicalPath !== binding.lexicalPath ||
								fresh.canonicalPath !== binding.canonicalPath ||
								(fresh.outsideRoots && !confirmed)
							)
								throw new EditorDocumentError(
									"EDITOR_IDENTITY_CHANGED",
									"Write authorization or physical target changed",
									403,
								);
						},
						construct: async (before) => {
							const result = await this.jobs.run(actor.userId, {
								action: "prepare",
								before: before.bytes,
								uploadPath: upload.path,
								conflictPath,
								baseHash: upload.baseHash,
								encoding: upload.encoding,
								digest: upload.digest as string,
								recovery: {
									path: join(this.deps.root, `ed-${operationId}.json`),
									userId: actor.userId,
									narratorId: actor.narratorId,
									operationId,
									snapshotRevision: upload.snapshotRevision,
								},
							});
							if (result.kind === "conflict") {
								if (session.conflict?.readers)
									throw invalid("Previous conflict version is still downloading");
								if (session.conflict) {
									const previous = session.conflict;
									// Atomic with the readers check above and content() admission: no await
									// is allowed before this fence. Keep it retired AND charged if unlink fails.
									previous.retiring = true;
									try {
										await (this.deps.unlinkVersion ?? unlink)(previous.path);
									} catch {
										throw new EditorDocumentError(
											"EDITOR_VERSION_CLEANUP_FAILED",
											"Previous conflict version could not be removed; it remains unavailable and reserved",
											503,
										);
									}
									this.reserve(session, -previous.metadata.utf8Bytes);
								}
								session.conflict = {
									path: conflictPath,
									handle: randomUUID(),
									metadata: result.metadata,
								};
								session.looseFiles.delete(conflictPath);
								this.reserve(session, result.metadata.utf8Bytes - conflictReserved);
								conflictReserved = 0;
								throw new EditorDocumentError(
									"STALE_WRITE",
									"The file changed since it was opened",
									409,
									{
										currentHash: result.absent ? null : result.metadata.baseHash,
										conflictVersionHandle: session.conflict.handle,
										encoding: result.metadata.encoding,
										size: result.metadata.sourceBytes,
									},
								);
							}
							if (result.kind !== "prepared") throw invalid("Unexpected preparation response");
							return {
								nextBytes: result.nextBytes,
								result: { hash: result.hash, bytes: result.bytes },
								lineStats: null,
							};
						},
					});
					upload.result = {
						status: "saved",
						operationId,
						...completed.result,
						snapshotRevision: upload.snapshotRevision,
					};
				});
			if (this.deps.afterWrite)
				await this.deps.afterWrite(binding, actor.narratorId, operationId, run, actor);
			else await run();
			if (!upload.result) throw invalid("Save result unavailable");
			operation.value = { status: "saved", operationId, result: upload.result };
			return upload.result;
		} catch (error) {
			const uncertain = error instanceof Error && error.name === "EditorFileChangeUncertainError";
			upload.error =
				error instanceof EditorDocumentError
					? error
					: new EditorDocumentError(
							uncertain
								? "WRITE_RECONCILE_REQUIRED"
								: error instanceof AppError
									? error.code
									: "WRITE_FAILED",
							error instanceof Error ? error.message.slice(0, 256) : "Editor save failed",
							uncertain ? 500 : error instanceof AppError ? error.statusCode : 500,
						);
			upload.error.data.operationId = operationId;
			operation.value = {
				status: uncertain ? "uncertain" : "failed",
				operationId,
				error: { code: upload.error.code, message: upload.error.message },
			};
			throw upload.error;
		} finally {
			upload.state = "settled";
			session.committing = false;
			session.pins--;
			session.lastUsed = Date.now();
			operation.expires = Date.now() + EDITOR_SESSION_IDLE_MS;
			try {
				await unlink(recoveryTemporary).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				session.looseFiles.delete(recoveryTemporary);
				if (conflictReserved) {
					await unlink(conflictPath).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
					session.looseFiles.delete(conflictPath);
					this.reserve(session, -conflictReserved);
				}
			} catch (error) {
				logger.warn("Editor preparation cleanup deferred", { error: String(error) });
			}
			await this.cleanUpload(session, upload);
			if (session.closing) await this.release(session);
		}
	}
	async operation(actor: EditorActor, operationId: string): Promise<EditorOperationResult> {
		await this.initialize();
		const operation = this.operations.get(operationId);
		if (
			operation &&
			operation.userId === actor.userId &&
			operation.narratorId === actor.narratorId
		) {
			if (operation.recovery && this.deps.queryOperation)
				return this.deps.queryOperation(actor, operationId, operation.recovery);
			return operation.value;
		}
		if (this.deps.queryOperation) return this.deps.queryOperation(actor, operationId);
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"No durable receipt is available; verify before retrying",
			404,
		);
	}
	async uploadStatus(
		actor: EditorActor,
		docId: string,
		uploadId: string,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.bound(actor, docId, "read");
		const upload = this.upload(session, uploadId);
		return {
			uploadId,
			state: upload.state,
			operationId: upload.operationId,
			bytes: upload.bytes,
			digest: upload.digest,
		};
	}
	async cancelUpload(
		actor: EditorActor,
		docId: string,
		uploadId: string,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.bound(actor, docId, "write");
		const upload = this.upload(session, uploadId);
		if (upload.state === "committing" || upload.state === "settled")
			return { uploadId, state: upload.state };
		upload.controller.abort();
		upload.state = "cancelled";
		if (!upload.busy) await this.cleanUpload(session, upload);
		return { uploadId, state: upload.state };
	}
	async remove(actor: EditorActor, docId: string): Promise<{ status: "released" | "committing" }> {
		const { session } = await this.bound(actor, docId, "read");
		await this.release(session);
		return { status: session.committing ? "committing" : "released" };
	}
	private async cleanUpload(session: Session, upload: Upload) {
		if (upload.cleanup) return upload.cleanup;
		upload.cleanup = (async () => {
			try {
				await unlink(upload.path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				this.reserve(session, -upload.reserved);
				upload.reserved = 0;
			} catch (error) {
				// Preserve the reservation for the retry; cleanup cannot reverse a saved receipt.
				logger.warn("Editor upload cleanup deferred", { error: String(error) });
			}
		})();
		try {
			await upload.cleanup;
		} finally {
			upload.cleanup = undefined;
		}
	}
	private async release(session: Session) {
		session.closing = true;
		for (const upload of session.uploads.values())
			if (upload.state === "uploading") upload.controller.abort();
		if (session.pins || session.committing) return;
		if (session.cleanup) return session.cleanup;
		session.cleanup = (async () => {
			try {
				for (const path of session.looseFiles) {
					await unlink(path).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
					session.looseFiles.delete(path);
				}
				for (const version of [session.source, session.conflict])
					if (version)
						await unlink(version.path).catch((error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						});
				for (const upload of session.uploads.values()) await this.cleanUpload(session, upload);
				if ([...session.uploads.values()].some((upload) => upload.reserved > 0)) return;
				this.sessions.delete(session.id);
			} catch (error) {
				logger.warn("Editor session cleanup deferred", { error: String(error) });
			}
		})();
		try {
			await session.cleanup;
		} finally {
			session.cleanup = undefined;
		}
	}
	async sweep(now = Date.now()) {
		// At most 32 live sessions and 1024 small operation records, never a filesystem scan.
		for (const session of this.sessions.values())
			if (now - session.lastUsed > EDITOR_SESSION_IDLE_MS) await this.release(session);
		for (const [id, operation] of this.operations)
			if (operation.value.status !== "committing" && operation.expires < now) {
				try {
					await unlink(join(this.deps.root, `ed-${id}.json`)).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						},
					);
					this.operations.delete(id);
				} catch (error) {
					logger.warn("Editor recovery cleanup deferred", { error: String(error) });
				}
			}
	}
	async dispose() {
		clearInterval(this.timer);
		for (const session of this.sessions.values()) await this.release(session);
	}
}
