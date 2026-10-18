import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EditorRawMetadata } from "../../shared/editor-document";
import {
	type CreateEditorDocumentInput,
	type CreateEditorDraftAnchorInput,
	type CreateEditorUploadInput,
	EDITOR_FILE_MAX_BYTES,
	EDITOR_MAX_OPERATIONS,
	EDITOR_MAX_SESSIONS,
	EDITOR_MAX_UPLOADS_PER_SESSION,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_SESSION_IDLE_MS,
	EDITOR_TEMP_MAX_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	EDITOR_UPLOAD_CHUNK_BYTES,
	EDITOR_UPLOAD_IDLE_MS,
	EDITOR_USER_MAX_OPERATIONS,
	EDITOR_USER_MAX_SESSIONS,
	EDITOR_USER_TEMP_MAX_BYTES,
	type EditorCommitInput,
	type EditorCommitResult,
	type EditorDocumentDescriptor,
	type EditorOperationResult,
	type EditorRawEncoding,
	type EditorRawSeal,
	type EditorSaveResult,
	type EditorUploadChunkInput,
	type EditorUploadDescriptor,
} from "../../shared/editor-document";
import {
	EDITOR_LOCAL_V1_CAPABILITIES,
	type EditorProviderCapabilities,
} from "../../shared/editor-provider-contracts";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { EditorOperationMetadata } from "../lib/validators/editor-documents";
import { EditorDocumentJobs } from "./editor-document-jobs";
import { EditorDocumentStreams, type EditorRemoteRawSource } from "./editor-document-streams";
import type { EditorVersionMetadata } from "./editor-document-worker";
import { EditorDraftAnchorStore } from "./editor-draft-anchor-store";
import type { EditorFileChangeRequest, FileChangeCompletion } from "./file-change-runtime";

export interface EditorBinding {
	workspaceRevision?: number;
	writeTarget?: EditorFileChangeRequest<unknown>["remote"];
	cwd: string;
	projectId: string | null;
	lexicalPath: string;
	canonicalPath: string;
	outsideRoots: boolean;
	writeConfirmationRequired?: boolean;
	/** Execution identity, never the UI workspace or dock host. */
	contextKey?: string;
	workspaceIdentity?: string;
	pathFlavor?: "posix" | "windows";
	/** Only a reauthorized remote backend can supply this; never host-open remote paths. */
	rawSource?: EditorRemoteRawSource;
	deviceId?: string;
	runtimeGeneration?: number;
	runtimeEpoch?: string;
}

export function editorResourceKey(
	actor: EditorActor,
	input: CreateEditorDocumentInput,
	binding: EditorBinding,
	stable = false,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"editor-resource-v1",
				actor.userId,
				actor.narratorId,
				binding.deviceId ?? input.deviceId ?? "local",
				input.origin,
				binding.cwd,
				binding.projectId,
				binding.contextKey,
				binding.workspaceIdentity,
				binding.pathFlavor,
				binding.canonicalPath,
				binding.outsideRoots,
				...(input.protocol === "raw-v2"
					? [
							"raw-v2",
							input.encodingHint,
							...(stable ? [] : [binding.runtimeGeneration, binding.runtimeEpoch]),
						]
					: []),
			]),
		)
		.digest("hex");
}
export function editorRecoveryKey(actor: EditorActor, input: CreateEditorDocumentInput) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"editor-recovery-v1",
				actor.userId,
				actor.narratorId,
				input.deviceId ?? "local",
				input.origin,
			]),
		)
		.digest("hex");
}
export interface EditorActor {
	/** Cancels metadata/recovery helpers when the requesting HTTP client leaves. */
	signal?: AbortSignal;
	userId: string;
	narratorId: string;
	locale?: "en" | "zh-CN";
	/** Historical receipt authorization; deliberately does not resolve/reopen its old target. */
	authorizeOperation?(deviceId: string): Promise<void>;
	authorize(
		input: CreateEditorDocumentInput,
		need: "read" | "write",
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<EditorBinding>;
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
function assertSameEditorBinding(
	actor: EditorActor,
	input: CreateEditorDocumentInput,
	expected: EditorBinding,
	fresh: EditorBinding,
) {
	if (
		fresh.lexicalPath !== expected.lexicalPath ||
		editorResourceKey(actor, input, fresh) !== editorResourceKey(actor, input, expected)
	)
		throw new EditorDocumentError(
			"EDITOR_IDENTITY_CHANGED",
			"Editor resource identity changed",
			403,
		);
}

interface SourceVersion {
	handle: string;
	metadata: EditorVersionMetadata;
}
interface Version extends SourceVersion {
	path: string;
	readers?: number;
	/** Set synchronously before unlink; never admit a new descriptor after this fence. */
	retiring?: boolean;
}
interface Upload extends CreateEditorUploadInput, EditorUploadDescriptor {
	nextSeq?: number;
	lastChunk?: EditorUploadChunkInput;
	seal?: EditorRawSeal;
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
	source?: SourceVersion;
	raw?: { handle: string; metadata: EditorRawMetadata };
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
	/** Original execution device; even cached status is metadata-authorized before publication. */
	deviceId?: string;
	userId: string;
	narratorId: string;
	value: EditorOperationResult;
	expires: number;
	recovery?: EditorOperationMetadata;
}
export interface EditorDocumentDependencies {
	root: string;
	/** Fast capability snapshot; must not install/download on the read request's critical path. */
	writerAvailable?(binding: EditorBinding): boolean;
	writerUnavailableReason?(
		binding: EditorBinding,
	): EditorProviderCapabilities["writeUnavailableReason"];
	/** Trusted provider only. Availability is negotiated per authorized resource. */
	rawWriter?: {
		execute: EditorDocumentDependencies["execute"];
		queryOperation: NonNullable<EditorDocumentDependencies["queryOperation"]>;
	};
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
	readonly streams = new EditorDocumentStreams();
	private ready?: Promise<void>;
	private rootIdentity?: string;
	private heal?: Promise<void>;
	private timer?: ReturnType<typeof setInterval>;
	private sweeping?: Promise<void>;
	private userSessions = new Map<string, number>();
	private userOperations = new Map<string, number>();
	private userBytes = new Map<string, number>();
	private totalBytes = 0;
	private downloads = new Map<() => Promise<void>, Session>();
	private count(map: Map<string, number>, user: string, delta: number) {
		const value = (map.get(user) ?? 0) + delta;
		if (value < 0) throw invalid("Editor accounting underflow");
		if (value) map.set(user, value);
		else map.delete(user);
	}
	private addOperation(id: string, operation: Operation) {
		this.operations.set(id, operation);
		this.count(this.userOperations, operation.userId, 1);
		this.count(this.userBytes, operation.userId, EDITOR_METADATA_MAX_BYTES);
		this.totalBytes += EDITOR_METADATA_MAX_BYTES;
	}
	readonly draftAnchors: EditorDraftAnchorStore;
	constructor(private readonly deps: EditorDocumentDependencies) {
		this.draftAnchors = new EditorDraftAnchorStore(`${deps.root}-draft-recovery`);
		this.jobs = deps.jobs ?? new EditorDocumentJobs();
	}
	private async settledDraftOperations(
		actor: EditorActor,
		owner: string,
		writerId: string,
		resourceKey: string,
		modelLifetime: string,
		extra?: { operationId?: string; snapshotRevision: number },
	) {
		const pending = await this.draftAnchors.pendingOperations(
			owner,
			writerId,
			resourceKey,
			modelLifetime,
		);
		if (extra?.operationId && !pending.some((op) => op.operationId === extra.operationId))
			pending.push(extra);
		const settled: string[] = [];
		for (const operation of pending)
			if (operation.operationId) {
				try {
					const receipt = await this.operation(actor, operation.operationId);
					if (
						receipt.operationId === operation.operationId &&
						(receipt.status === "failed" ||
							(receipt.status === "saved" &&
								receipt.result?.operationId === operation.operationId &&
								receipt.result.snapshotRevision === operation.snapshotRevision))
					)
						settled.push(operation.operationId);
				} catch {
					/* Missing/transport failures never prove a terminal operation. */
				}
			}
		return settled;
	}
	async createDraftAnchor(actor: EditorActor, input: CreateEditorDraftAnchorInput) {
		const owner = editorRecoveryKey(actor, { ...input, path: "" });
		const settled = await this.settledDraftOperations(
			actor,
			owner,
			input.writerId,
			input.resourceKey,
			input.modelLifetime,
			input.operation,
		);
		return this.draftAnchors.create(owner, input, settled);
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
			this.addOperation(recovery.operationId, {
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
			if (
				this.totalBytes + delta > EDITOR_TEMP_MAX_BYTES ||
				(this.userBytes.get(session.userId) ?? 0) + delta > EDITOR_USER_TEMP_MAX_BYTES
			)
				throw new EditorDocumentError(
					"EDITOR_QUOTA_EXCEEDED",
					"Editor temporary storage quota exceeded",
					429,
				);
		}
		if (session.reserved + delta < 0) throw invalid("Editor reservation underflow");
		session.reserved += delta;
		this.totalBytes += delta;
		this.count(this.userBytes, session.userId, delta);
	}
	/** Routes still require current narrator ACL. These operations expose only the
	 * verified owner's private transfer metadata, never file bytes or write authority. */
	private async owned(actor: EditorActor, docId: string) {
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
		if (session.closing || !this.sessions.has(docId)) throw expired();
		session.lastUsed = Date.now();
		return session;
	}
	private async bound(actor: EditorActor, docId: string, need: "read" | "write") {
		const session = await this.owned(actor, docId);
		if (need === "write" && session.input.protocol === "raw-v2" && !this.deps.rawWriter)
			throw new EditorDocumentError(
				"EDITOR_RAW_READ_ONLY",
				"The raw-v2 writer is not available",
				403,
			);
		const binding = await actor.authorize(session.input, need);
		if (need === "write" && this.deps.writerAvailable && !this.deps.writerAvailable(binding))
			throw new EditorDocumentError(
				"EDITOR_PROVIDER_UNSUPPORTED",
				"Verified editor helper unavailable; prepare the pinned executor from the configured update source and reopen this file",
				503,
			);
		assertSameEditorBinding(actor, session.input, session.binding, binding);
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
			(this.userSessions.get(actor.userId) ?? 0) >= EDITOR_USER_MAX_SESSIONS
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
		this.count(this.userSessions, actor.userId, 1);
		try {
			if (input.protocol === "raw-v2") {
				const metadata = await this.streams.metadata(
					actor.userId,
					binding.rawSource ?? binding.canonicalPath,
					input.encodingHint,
					signal,
					session.id,
				);
				await this.bound(actor, session.id, "read");
				session.raw = { handle: randomUUID(), metadata };
				return {
					docId: session.id,
					resourceKey: editorResourceKey(actor, input, binding),
					stableResourceKey: editorResourceKey(actor, input, binding, true),
					recoveryKey: editorRecoveryKey(actor, input),
					target: {
						deviceId: binding.deviceId ?? input.deviceId ?? "local",
						path: binding.canonicalPath,
					},
					versionHandle: session.raw.handle,
					capabilities: {
						...EDITOR_LOCAL_V1_CAPABILITIES,
						watch: true,
						v1Save: false,
						...(this.deps.writerAvailable && !this.deps.writerAvailable(binding)
							? {
									writeUnavailableReason:
										this.deps.writerUnavailableReason?.(binding) ??
										(binding.rawSource
											? ("durable_executor_unavailable" as const)
											: ("verified_helper_unavailable" as const)),
								}
							: {}),
						rawRead: true,
						stage: this.deps.writerAvailable
							? !!this.deps.rawWriter && this.deps.writerAvailable(binding)
							: !binding.rawSource,
						durableApply:
							!!this.deps.rawWriter && (this.deps.writerAvailable?.(binding) ?? !binding.rawSource),
						durableQuery:
							!!this.deps.rawWriter && (this.deps.writerAvailable?.(binding) ?? !binding.rawSource),
					},
					...metadata,
				};
			}
			const result = await this.jobs.run(
				actor.userId,
				{ action: "metadata", sourcePath: binding.canonicalPath },
				signal,
			);
			if (result.kind !== "source") throw invalid("Unexpected source worker response");
			await this.bound(actor, session.id, "read");
			session.source = { handle: randomUUID(), metadata: result.metadata };
			return {
				docId: session.id,
				resourceKey: editorResourceKey(actor, session.input, binding),
				recoveryKey: editorRecoveryKey(actor, session.input),
				target: { deviceId: "local", path: binding.canonicalPath },
				versionHandle: session.source.handle,
				// The route admits only local bindings, so this session owns the local
				// worker read and the v1 save; nothing in Phases 6-9 is claimed.
				capabilities: {
					...EDITOR_LOCAL_V1_CAPABILITIES,
					watch: true,
					v1Save: this.deps.writerAvailable?.(binding) ?? true,
					...(this.deps.writerAvailable && !this.deps.writerAvailable(binding)
						? {
								writeUnavailableReason:
									this.deps.writerUnavailableReason?.(binding) ??
									("verified_helper_unavailable" as const),
							}
						: {}),
				},
				...result.metadata,
			};
		} catch (error) {
			session.closing = true;
			throw error;
		} finally {
			session.pins--;
			if (session.closing) await this.release(session);
		}
	}
	/**
	 * Authorized identity probe for a document's live disk source.
	 *
	 * Reuses the bounded two-track metadata worker. Never allocates a new session,
	 * never streams body bytes to the caller, and never advances the stored baseline.
	 * Reauthorization is applied before AND after the worker completes so a revoked
	 * narrator or rebound workspace cannot publish an older observation.
	 */
	async diskState(
		actor: EditorActor,
		docId: string,
		signal?: AbortSignal,
	): Promise<import("../../shared/editor-document").EditorDiskState> {
		const { binding, session } = await this.bound(actor, docId, "read");
		if (session.raw) {
			try {
				const metadata = await this.streams.metadata(
					actor.userId,
					binding.rawSource ?? binding.canonicalPath,
					session.raw.metadata.encoding,
					signal,
					docId,
				);
				await this.bound(actor, docId, "read");
				return { exists: true, ...metadata };
			} catch (error) {
				await this.bound(actor, docId, "read");
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return { exists: false, protocol: "raw-v2", hashKind: "raw-sha256" };
				throw error;
			}
		}
		const result = await this.jobs.run(
			actor.userId,
			{ action: "disk-state", sourcePath: binding.canonicalPath },
			signal,
		);
		if (result.kind !== "disk-state") throw invalid("Unexpected disk-state worker response");
		// bound() itself ends with the closing/sessions guard; it is the publication check.
		await this.bound(actor, docId, "read");
		if (!result.metadata) return { exists: false };
		return {
			exists: true,
			baseHash: result.metadata.baseHash,
			encoding: result.metadata.encoding,
			eol: result.metadata.eol,
			sourceBytes: result.metadata.sourceBytes,
			utf8Bytes: result.metadata.utf8Bytes,
		};
	}
	/** Finite counters only: no filesystem, body or session scan. */
	get diagnostics() {
		return {
			documents: this.sessions.size,
			reservedBytes: this.totalBytes,
			operations: this.operations.size,
			streams: this.streams.diagnostics,
		};
	}
	/** Snapshot only the authorization input, never pin/touch a document for a watcher. */
	watchTarget(actor: EditorActor, docId: string) {
		const session = this.sessions.get(docId);
		if (
			!session ||
			session.closing ||
			session.userId !== actor.userId ||
			session.narratorId !== actor.narratorId ||
			(Date.now() - session.lastUsed > EDITOR_SESSION_IDLE_MS && !session.pins)
		)
			throw expired();
		const input = session.input;
		const resourceId = editorResourceKey(actor, input, session.binding, true);
		// Fresh authorization runs in the four-job shared scheduler, including the
		// initial ACK. Reading a verified metadata entry itself grants nothing.
		return {
			resourceId,
			async authorize(signal: AbortSignal) {
				signal.throwIfAborted();
				const fresh = await actor.authorize(input, "read", signal);
				signal.throwIfAborted();
				if (editorResourceKey(actor, input, fresh, true) !== resourceId)
					throw new EditorDocumentError("EDITOR_IDENTITY_CHANGED", "Editor identity changed", 403);
				return editorResourceKey(actor, input, fresh);
			},
		};
	}
	/** Explicit consumer pulls are credit; no HTTP fetch read-ahead can drain the source. */
	async rawOpen(actor: EditorActor, docId: string, versionHandle: string, signal?: AbortSignal) {
		const { session, binding } = await this.bound(actor, docId, "read");
		if (!session.raw || session.raw.handle !== versionHandle) throw invalid("Invalid raw version");
		session.pins++;
		let opened: { readId: string; metadata: EditorRawMetadata } | undefined;
		try {
			opened = await this.streams.open(
				actor.userId,
				docId,
				binding.rawSource ?? binding.canonicalPath,
				session.raw.metadata.encoding,
				session.raw.metadata,
				signal,
			);
			await this.bound(actor, docId, "read");
			return { readId: opened.readId };
		} catch (error) {
			if (opened) await this.streams.close(docId, opened.readId);
			throw error;
		} finally {
			session.pins--;
			if (session.closing) await this.release(session);
		}
	}
	async rawChunk(
		actor: EditorActor,
		docId: string,
		readId: string,
		offset: number,
		maxBytes: number,
	) {
		try {
			const { session } = await this.bound(actor, docId, "read");
			if (!session.raw) throw invalid("Not a raw document");
			const result = await this.streams.chunk(docId, readId, offset, maxBytes);
			// Publication fence on first chunk AND EOF (and each intervening chunk).
			await this.bound(actor, docId, "read");
			return result;
		} catch (error) {
			await this.streams.close(docId, readId);
			throw error;
		}
	}
	async rawClose(actor: EditorActor, docId: string, readId: string) {
		await this.owned(actor, docId);
		await this.streams.close(docId, readId);
	}
	async content(
		actor: EditorActor,
		docId: string,
		versionHandle: string,
		signal?: AbortSignal,
	): Promise<ReadableStream<Uint8Array>> {
		const { session } = await this.bound(actor, docId, "read");
		if (session.source?.handle === versionHandle)
			return this.sourceContent(actor, session, session.source, signal);
		const version = session.conflict?.handle === versionHandle ? session.conflict : undefined;
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
		const lifecycle = new AbortController();
		const transferSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
		let permit: Awaited<ReturnType<EditorDocumentJobs["acquireTransfer"]>> | undefined;
		let file: Awaited<ReturnType<typeof open>> | undefined;
		let initialized!: () => void;
		const initialization = new Promise<void>((resolve) => {
			initialized = resolve;
		});
		let close: () => Promise<void> = async () => {};
		const cancel = async () => {
			lifecycle.abort();
			await initialization;
			await close();
		};
		this.downloads.set(cancel, session);
		try {
			permit = await this.jobs.acquireTransfer(EDITOR_TRANSFER_CHUNK_BYTES, transferSignal);
			permit.signal.throwIfAborted();
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
			if (!stat.isFile() || stat.size !== version.metadata.utf8Bytes) throw expired();
			permit.signal.throwIfAborted();
		} catch (error) {
			await file?.close();
			permit?.release();
			this.downloads.delete(cancel);
			session.pins--;
			version.readers--;
			initialized();
			if (session.closing) await this.release(session);
			throw error;
		}
		let closed = false;
		let idle: ReturnType<typeof setTimeout> | undefined;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		let closePromise: Promise<void> | undefined;
		close = () =>
			(closePromise ??= (async () => {
				closed = true;
				clearTimeout(idle);
				permit?.signal.removeEventListener("abort", abort);
				try {
					await file?.close();
				} finally {
					permit?.release();
					this.downloads.delete(cancel);
					session.pins--;
					version.readers = Math.max(0, (version.readers ?? 1) - 1);
					if (session.closing) await this.release(session);
				}
			})());
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
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (value) => {
					controller = value;
					permit?.signal.addEventListener("abort", abort, { once: true });
					if (permit?.signal.aborted) abort();
					else touch();
				},
				pull: async () => {
					try {
						if (closed || !file) return;
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
			},
			{ highWaterMark: 0 },
		);
		initialized();
		return stream;
	}
	private async sourceContent(
		actor: EditorActor,
		session: Session,
		source: SourceVersion,
		external?: AbortSignal,
	): Promise<ReadableStream<Uint8Array>> {
		if (session.pins >= 8)
			throw new EditorDocumentError("EDITOR_BUSY", "Too many active document transfers", 429);
		session.pins++;
		const lifecycle = new AbortController();
		const signal = external ? AbortSignal.any([external, lifecycle.signal]) : lifecycle.signal;
		let permit: Awaited<ReturnType<EditorDocumentJobs["acquireTransfer"]>> | undefined;
		let bytes: Uint8Array | undefined;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let closed = false;
		let generating = true;
		let generated!: () => void;
		const generation = new Promise<void>((resolve) => {
			generated = resolve;
		});
		let closePromise: Promise<void> | undefined;
		const close = (): Promise<void> => {
			if (generating) {
				lifecycle.abort();
				return Promise.resolve();
			}
			closePromise ??= (async () => {
				closed = true;
				bytes = undefined;
				permit?.signal.removeEventListener("abort", abort);
				permit?.release();
				this.downloads.delete(cancel);
				session.pins--;
				if (session.closing) await this.release(session);
			})();
			return closePromise;
		};
		const abort = () => {
			if (closed) return;
			controller?.error(
				new EditorDocumentError(
					"EDITOR_TRANSFER_CANCELLED",
					"Document transfer cancelled or timed out",
					408,
				),
			);
			void close();
		};
		const cancel = async () => {
			lifecycle.abort();
			abort();
			await generation;
			await close();
		};
		this.downloads.set(cancel, session);
		try {
			permit = await this.jobs.acquireTransfer(source.metadata.utf8Bytes, signal);
			permit.signal.addEventListener("abort", abort, { once: true });
			const result = await this.jobs.run(
				actor.userId,
				{
					action: "content",
					sourcePath: session.binding.canonicalPath,
					metadata: source.metadata,
				},
				permit.signal,
			);
			permit.signal.throwIfAborted();
			if (result.kind !== "content" || result.bytes.byteLength !== source.metadata.utf8Bytes)
				throw invalid("Unexpected content worker response");
			// Queued IO can outlive grants or a narrator's workspace binding.
			// Reauthorize before publishing any bytes from the newly read source.
			await this.bound(actor, session.id, "read");
			permit.signal.throwIfAborted();
			bytes = result.bytes;
			generating = false;
			let offset = 0;
			return new ReadableStream<Uint8Array>(
				{
					start: (value) => {
						controller = value;
						if (permit?.signal.aborted) abort();
					},
					pull: async (value) => {
						if (closed || !bytes) return;
						if (offset === bytes.byteLength) {
							await close();
							value.close();
							return;
						}
						const end = Math.min(offset + EDITOR_TRANSFER_CHUNK_BYTES, bytes.byteLength);
						value.enqueue(bytes.slice(offset, end));
						offset = end;
						session.lastUsed = Date.now();
					},
					cancel: close,
				},
				{ highWaterMark: 0 },
			);
		} catch (error) {
			generating = false;
			await close();
			throw error;
		} finally {
			generated();
		}
	}
	async createUpload(
		actor: EditorActor,
		docId: string,
		input: CreateEditorUploadInput,
	): Promise<EditorUploadDescriptor> {
		const { session, binding } =
			input.protocol === "raw-v2"
				? await this.stageBound(actor, docId)
				: await this.bound(actor, docId, "write");
		if ((session.input.protocol === "raw-v2") !== (input.protocol === "raw-v2"))
			throw invalid("Upload protocol does not match document");
		if (
			input.protocol === "raw-v2" &&
			(input.hashKind !== "raw-sha256" ||
				input.bom !== session.raw?.metadata.bom ||
				(binding.rawSource && !this.deps.writerAvailable?.(binding)))
		)
			throw invalid("Raw stage format mismatch");
		if (session.uploads.size >= EDITOR_MAX_UPLOADS_PER_SESSION)
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
		if (input.encoding !== (session.raw?.metadata.encoding ?? session.source?.metadata.encoding))
			throw invalid("Encoding does not match the opened source");
		const budget = input.protocol === "raw-v2" ? EDITOR_FILE_MAX_BYTES : EDITOR_TRANSFER_MAX_BYTES;
		this.reserve(session, budget);
		const upload: Upload = {
			...input,
			uploadId: randomUUID(),
			operationId: randomUUID(),
			state: "uploading",
			path: this.path(),
			reserved: budget,
			nextSeq: input.protocol === "raw-v2" ? 0 : undefined,
			bytes: input.protocol === "raw-v2" ? 0 : undefined,
			busy: false,
			controller: new AbortController(),
		};
		session.uploads.set(upload.uploadId, upload);
		return { uploadId: upload.uploadId, operationId: upload.operationId, state: upload.state };
	}
	private async stageBound(actor: EditorActor, docId: string) {
		const value = await this.bound(actor, docId, "read");
		if (
			value.session.input.protocol !== "raw-v2" ||
			(this.deps.writerAvailable
				? !this.deps.writerAvailable(value.binding)
				: !!value.binding.rawSource)
		)
			throw invalid("Raw staging is unavailable for this provider");
		const fresh = await actor.authorize(value.session.input, "write");
		assertSameEditorBinding(actor, value.session.input, value.binding, fresh);
		if (value.session.closing || !this.sessions.has(docId)) throw expired();
		return value;
	}
	async putChunk(
		actor: EditorActor,
		docId: string,
		uploadId: string,
		input: EditorUploadChunkInput,
		body: ReadableStream<Uint8Array> | null,
		signal?: AbortSignal,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.stageBound(actor, docId);
		const upload = this.upload(session, uploadId);
		if (upload.protocol !== "raw-v2" || upload.busy || upload.state !== "uploading")
			throw invalid("Raw upload is not receiving");
		if (
			!Number.isSafeInteger(input.bytes) ||
			input.bytes < 1 ||
			input.bytes > EDITOR_UPLOAD_CHUNK_BYTES ||
			input.offset + input.bytes > EDITOR_FILE_MAX_BYTES
		)
			throw invalid("Raw chunk exceeds budget");
		const duplicate = upload.lastChunk?.seq === input.seq;
		if (
			duplicate
				? upload.lastChunk?.offset !== input.offset ||
					upload.lastChunk?.bytes !== input.bytes ||
					upload.lastChunk?.digest !== input.digest
				: input.seq !== upload.nextSeq || input.offset !== upload.bytes
		)
			throw invalid("Raw chunk order or digest mismatch");
		upload.busy = true;
		session.pins++;
		let wrote = false;
		const reader = body?.getReader();
		const cancelled = AbortSignal.any([upload.controller.signal, ...(signal ? [signal] : [])]);
		try {
			await this.jobs.withIo(
				actor.userId,
				async (deadline) => {
					const bounded = AbortSignal.any([deadline, AbortSignal.timeout(EDITOR_UPLOAD_IDLE_MS)]);
					const abort = () => {
						void reader?.cancel().catch(() => {});
					};
					bounded.addEventListener("abort", abort, { once: true });
					try {
						bounded.throwIfAborted();
						const bytes = new Uint8Array(input.bytes);
						let count = 0;
						while (reader) {
							const next = await reader.read();
							bounded.throwIfAborted();
							if (next.done) break;
							if (count + next.value.length > bytes.length)
								throw invalid("Raw chunk exceeds declared bytes");
							bytes.set(next.value, count);
							count += next.value.length;
						}
						if (
							count !== input.bytes ||
							createHash("sha256").update(bytes).digest("hex") !== input.digest
						)
							throw invalid("Raw chunk truncated or digest mismatch");
						if (!duplicate) {
							const entry = input.seq > 0 ? await lstat(upload.path) : undefined;
							if (entry && (!entry.isFile() || entry.nlink !== 1))
								throw invalid("Raw stage is not private regular storage");
							const file = await open(
								upload.path,
								constants.O_WRONLY |
									(constants.O_NOFOLLOW ?? 0) |
									(constants.O_NONBLOCK ?? 0) |
									(input.seq === 0 ? constants.O_CREAT | constants.O_EXCL : 0),
								0o600,
							);
							try {
								const stat = await file.stat();
								if (
									!stat.isFile() ||
									stat.nlink !== 1 ||
									stat.size !== input.offset ||
									(entry && (entry.dev !== stat.dev || entry.ino !== stat.ino))
								)
									throw invalid("Raw stage identity or length changed");
								let offset = 0;
								wrote = true;
								while (offset < bytes.length) {
									bounded.throwIfAborted();
									const result = await file.write(
										bytes,
										offset,
										bytes.length - offset,
										input.offset + offset,
									);
									if (!result.bytesWritten) throw invalid("Raw stage made no progress");
									offset += result.bytesWritten;
								}
							} finally {
								await file.close();
							}
						}
						await this.stageBound(actor, docId);
						bounded.throwIfAborted();
						if (!duplicate) {
							upload.lastChunk = { ...input };
							upload.bytes = input.offset + input.bytes;
							upload.nextSeq = input.seq + 1;
						}
					} finally {
						bounded.removeEventListener("abort", abort);
					}
				},
				cancelled,
			);
			return {
				uploadId,
				state: upload.state,
				bytes: upload.bytes,
				operationId: upload.operationId,
			};
		} catch (error) {
			void reader?.cancel().catch(() => {});
			if (wrote) upload.state = "cancelled";
			throw error;
		} finally {
			reader?.releaseLock();
			upload.busy = false;
			if (upload.state === "cancelled") await this.cleanUpload(session, upload);
			session.pins--;
			if (session.closing) await this.release(session);
		}
	}
	async sealRaw(
		actor: EditorActor,
		docId: string,
		uploadId: string,
		input: EditorRawSeal,
		signal?: AbortSignal,
	): Promise<EditorUploadDescriptor> {
		const { session } = await this.stageBound(actor, docId),
			upload = this.upload(session, uploadId);
		if (upload.protocol !== "raw-v2" || upload.busy) throw invalid("Raw upload unavailable");
		if (upload.state === "sealed") {
			if (JSON.stringify(upload.seal) !== JSON.stringify(input))
				throw invalid("Raw seal is immutable");
			return {
				uploadId,
				state: "sealed",
				operationId: upload.operationId,
				bytes: upload.bytes,
				digest: upload.digest,
			};
		}
		if (upload.state !== "uploading" || upload.bytes !== input.bytes)
			throw invalid("Raw upload is incomplete");
		upload.busy = true;
		session.pins++;
		try {
			if (!input.bytes) {
				const file = await open(upload.path, "wx", 0o600);
				await file.close();
			}
			const result = await this.jobs.run(
				actor.userId,
				{
					action: "raw-seal",
					path: upload.path,
					encoding: upload.encoding as EditorRawEncoding,
					bom: upload.bom ?? "none",
					expected: input,
				},
				AbortSignal.any([upload.controller.signal, ...(signal ? [signal] : [])]),
			);
			await this.stageBound(actor, docId);
			if (result.kind !== "sealed") throw invalid("Raw seal failed");
			upload.controller.signal.throwIfAborted();
			this.reserve(session, input.bytes - upload.reserved);
			upload.reserved = input.bytes;
			upload.digest = result.digest;
			upload.state = "sealed";
			upload.seal = { ...input };
			return {
				uploadId,
				state: "sealed",
				operationId: upload.operationId,
				bytes: input.bytes,
				digest: result.digest,
			};
		} catch (error) {
			upload.state = "cancelled";
			throw error;
		} finally {
			upload.busy = false;
			session.pins--;
			if (upload.state === "cancelled") await this.cleanUpload(session, upload);
			if (session.closing) await this.release(session);
		}
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
		if (upload.protocol === "raw-v2") throw invalid("Raw uploads require chunk/seal");
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
		if (
			upload.state !== "sealed" ||
			!upload.digest ||
			(upload.protocol === "raw-v2" && !upload.seal)
		)
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
		if ((binding.outsideRoots || binding.writeConfirmationRequired) && !confirmed) {
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
			this.operations.size >= EDITOR_MAX_OPERATIONS ||
			(this.userOperations.get(actor.userId) ?? 0) >= EDITOR_USER_MAX_OPERATIONS
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
			deviceId: binding.deviceId ?? session.input.deviceId ?? "local",
			userId: actor.userId,
			narratorId: actor.narratorId,
			value: { status: "committing", operationId },
			expires: Date.now() + EDITOR_SESSION_IDLE_MS,
		};
		this.addOperation(operationId, operation);
		this.reserve(session, -EDITOR_METADATA_MAX_BYTES); // Reservation is now owned by operations.
		try {
			if (input.draftWriterId) {
				const owner = editorRecoveryKey(actor, session.input),
					resource = editorResourceKey(actor, session.input, binding, true),
					lifetime = input.draftModelLifetime ?? "";
				const settled = await this.settledDraftOperations(
					actor,
					owner,
					input.draftWriterId,
					resource,
					lifetime,
				);
				await this.draftAnchors.beforeDispatch(
					owner,
					input.draftWriterId,
					resource,
					lifetime,
					{ operationId, snapshotRevision: upload.snapshotRevision },
					settled,
				);
			}
			const run = async () =>
				this.jobs.withIo(actor.userId, async (signal) => {
					const completed = await (upload.protocol === "raw-v2"
						? (this.deps.rawWriter?.execute as EditorDocumentDependencies["execute"])
						: this.deps.execute)({
						requestId: operationId,
						resourceKey: editorResourceKey(actor, session.input, binding, true),
						workspaceRevision: binding.workspaceRevision,
						remote: binding.writeTarget,
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
							hashKind: upload.hashKind,
							snapshotRevision: upload.snapshotRevision,
						},
						authorizeReceipt: async () => {
							if (!actor.authorizeOperation)
								throw new EditorDocumentError(
									"EDITOR_OPERATION_UNKNOWN",
									"Receipt metadata authorization unavailable",
									403,
								);
							await actor.authorizeOperation(binding.deviceId ?? session.input.deviceId ?? "local");
						},
						authorize: async () => {
							// Cancellation/DELETE may mark closing after commit began; pin keeps the bound bytes alive.
							const fresh = await actor.authorize(session.input, "write");
							assertSameEditorBinding(actor, session.input, binding, fresh);
							if ((fresh.outsideRoots || fresh.writeConfirmationRequired) && !confirmed)
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
								hashKind: upload.hashKind,
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
						...(upload.hashKind ? { hashKind: upload.hashKind } : {}),
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
			if (operation.deviceId && actor.authorizeOperation)
				await actor.authorizeOperation(operation.deviceId);
			if (operation.recovery?.hashKind === "raw-sha256" && this.deps.rawWriter)
				return this.deps.rawWriter.queryOperation(actor, operationId, operation.recovery);
			if (operation.recovery && this.deps.queryOperation)
				return this.deps.queryOperation(actor, operationId, operation.recovery);
			if (operation.value.status === "uncertain" && this.deps.queryOperation)
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
		const session = await this.owned(actor, docId);
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
		const session = await this.owned(actor, docId);
		const upload = this.upload(session, uploadId);
		if (upload.state === "committing" || upload.state === "settled")
			return { uploadId, state: upload.state };
		upload.controller.abort();
		upload.state = "cancelled";
		if (!upload.busy) await this.cleanUpload(session, upload);
		return { uploadId, state: upload.state };
	}
	async remove(actor: EditorActor, docId: string): Promise<{ status: "released" | "committing" }> {
		const session = await this.owned(actor, docId);
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
		await this.streams.closeOwner(session.id);
		session.closing = true;
		for (const [cancel, owner] of this.downloads) if (owner === session) await cancel();
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
				for (const version of [session.conflict])
					if (version)
						await unlink(version.path).catch((error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						});
				for (const upload of session.uploads.values()) await this.cleanUpload(session, upload);
				if ([...session.uploads.values()].some((upload) => upload.reserved > 0)) return;
				if (this.sessions.delete(session.id)) {
					this.reserve(session, -session.reserved);
					this.count(this.userSessions, session.userId, -1);
				}
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
	sweep(now = Date.now()): Promise<void> {
		this.sweeping ??= this.sweepBatch(now).finally(() => {
			this.sweeping = undefined;
		});
		return this.sweeping;
	}
	private async sweepBatch(now: number) {
		let scanned = 0;
		for (const session of this.sessions.values()) {
			if (now - session.lastUsed > EDITOR_SESSION_IDLE_MS) await this.release(session);
			if (++scanned % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}
		for (const [id, operation] of this.operations) {
			if (operation.value.status !== "committing" && operation.expires < now) {
				try {
					await unlink(join(this.deps.root, `ed-${id}.json`)).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						},
					);
					if (this.operations.delete(id)) {
						this.count(this.userOperations, operation.userId, -1);
						this.count(this.userBytes, operation.userId, -EDITOR_METADATA_MAX_BYTES);
						this.totalBytes -= EDITOR_METADATA_MAX_BYTES;
					}
				} catch (error) {
					logger.warn("Editor recovery cleanup deferred", { error: String(error) });
				}
			}
			if (++scanned % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	async dispose() {
		clearInterval(this.timer);
		await this.streams.dispose();
		for (const cancel of this.downloads.keys()) await cancel();
		for (const session of this.sessions.values()) await this.release(session);
	}
}
