// biome-ignore-all lint/suspicious/noControlCharactersInRegex: JSON escaping requires these control-byte ranges.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeExecutionReceipt,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import {
	fileAttributions,
	fileChangeBlobs,
	fileChangeOperations,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { type ExecutionBackend, LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { withWorkspaceWriteLock } from "../lib/agent/tools/write-serialization";
import type { ToolContext, ToolResult } from "../lib/agent/types";
import { requireApplicationDataDirectory } from "../lib/data-directory-security";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { FileChangeBlobCatalog } from "./file-change-blob-catalog";
import { FileChangeBlobStore, type FileChangeBlobStoreOptions } from "./file-change-blob-store";
import {
	type BeginFileChangeOperation,
	type FileChangeEffectRecord,
	FileChangeEvidenceService,
	type FileChangeOperationRecord,
} from "./file-change-evidence";
import { createFileChangeIdentity, type FileChangeScopeIdentity } from "./file-change-identity";
import {
	type FileChangeLocalIo,
	fileChangeLocalIo,
	type LocalFileObservation,
	LocalFileValidationError,
	localDirectoryIdentity,
} from "./file-change-local-io";
import {
	type WorkspaceActivityToken,
	type WorkspaceRuntimeBinding,
	WorkspaceWriteCoordinator,
	type WorkspaceWriteCoordinatorState,
	withFileHistoryWrite,
} from "./workspace-write-coordinator";

type RuntimeDb = typeof applicationDb;
const TOOL_COLUMNS = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	status: narratorToolCalls.status,
	startedAt: narratorToolCalls.executionStartedAt,
	version: narratorToolCalls.executionIdentityVersion,
	origin: narratorToolCalls.executionOriginToolCallId,
	attempt: narratorToolCalls.executionAttempt,
	checkpoint: narratorToolCalls.isFileHistoryCheckpoint,
	device: narratorToolCalls.executionDeviceId,
	cwd: narratorToolCalls.executionCwd,
	flavor: narratorToolCalls.executionPathFlavor,
	lexical: narratorToolCalls.resolvedFilePath,
	canonical: narratorToolCalls.canonicalFilePath,
	generation: narratorToolCalls.runtimeGeneration,
	operationId: narratorToolCalls.fileChangeOperationId,
};

/** Process identity survives --hot but is never reused across an actual restart. */
export function localFileChangeRuntimeBinding(
	deviceId = LOCAL_DEVICE_ID,
): WorkspaceRuntimeBinding | null {
	return deviceId === LOCAL_DEVICE_ID
		? hotSafe("narrafork.local-file-change-runtime.epoch.v1", () =>
				Object.freeze({ runtimeEpoch: randomUUID(), runtimeGeneration: 0 }),
			)
		: null;
}

interface PreparedFileChange<Result> {
	nextBytes: Uint8Array;
	result: Result;
	lineStats: { added: number; removed: number } | null;
}

export type PreparedLocalFileChange = PreparedFileChange<ToolResult>;

/** A real authenticated HTTP request, never a synthetic narrator tool call. */
export interface EditorFileChangeRequest<Result> {
	requestId: string;
	userId: string;
	/** Recording context only; the actor and human projection have no narrator id. */
	narratorId: string;
	projectId?: string | null;
	cwd: string;
	lexicalPath: string;
	canonicalPath: string;
	signal: AbortSignal;
	input: Record<string, unknown>;
	/** Reauthorize the SAME frozen target; cannot return a replacement path. */
	authorize(): Promise<void>;
	/** Pure construction from the raw before captured inside the shared lease. */
	construct(
		before: LocalFileObservation,
	): PreparedFileChange<Result> | Promise<PreparedFileChange<Result>>;
}

export interface FileChangeCompletion<Result> {
	result: Result;
	linesAdded: number | null;
	linesRemoved: number | null;
	fileChangeEvidence: {
		version: 2;
		operationId: string;
		effectId: string;
		grade: FileChangeEffectRecord["attributionGrade"];
		settlement: FileChangeEffectRecord["settlement"];
		outcome: FileChangeEffectRecord["outcome"];
	};
}

/** Target IO may have happened. Never translate this into a stale/create retry. */
export class EditorFileChangeUncertainError extends Error {
	constructor(
		readonly operationId: string | undefined,
		cause: unknown,
	) {
		super("Editor save may have changed the file; inspect evidence before retrying", { cause });
		this.name = "EditorFileChangeUncertainError";
	}
}

/**
 * Tools that go through the local file-change pipeline.
 *
 * Adding a name here is not enough on its own: the replay path (`applyToolCall` in
 * file-state-rebuild.ts) dispatches on this same name and SILENTLY treats an unknown one
 * as "no change", which would reconstruct a file as though the edit never happened. Any
 * new member needs a replay branch there too.
 */
export type FileChangeToolName = "Write" | "Edit" | "StructSed";

type BoundFileChange<Result> = {
	backend: ExecutionBackend;
	cwd: string;
	lexicalPath: string;
	canonicalPath: string;
	runtime: WorkspaceRuntimeBinding;
	signal: AbortSignal;
	input: Record<string, unknown>;
	sourceKind: "tool" | "editor";
	sourceId: string;
	attempt: number;
	toolName?: FileChangeToolName;
	toolUseId?: string;
	narratorId: string;
	projectId?: string | null;
	userId?: string | null;
	actor: FileChangeActor;
	subtype: string | null;
	executionSegmentId?: string | null;
	construct(
		before: LocalFileObservation,
	): PreparedFileChange<Result> | Promise<PreparedFileChange<Result>>;
	assertBinding(): void | Promise<void>;
	linkOperation?(operationId: string): void;
	recordNoDispatch?(operation: BeginFileChangeOperation, error: unknown): void;
	onDispatch?(): void;
};

export interface LocalFileChangeRequest {
	ctx: ToolContext;
	backend: ExecutionBackend;
	toolName: FileChangeToolName;
	filePath: string;
	/** Only this tool's actual input, hashed with the frozen target. Never stored as a body. */
	input: Record<string, unknown>;
	/** Pure construction: no target IO, legacy snapshot or attribution inside this callback. */
	construct(
		before: LocalFileObservation,
	): PreparedLocalFileChange | Promise<PreparedLocalFileChange>;
}

export interface LocalBashActivityRequest {
	backend: ExecutionBackend;
	cwd: string;
	signal: AbortSignal;
	/** Present for real routed calls; bare callers still bind the actual backend/cwd. */
	target?: ToolContext["executionTarget"];
}

export interface LocalBashActivity {
	/** Canonical cwd actually dispatched, not a second resolution of a symlink alias. */
	readonly cwd: string;
	readonly scope: Readonly<FileChangeScopeIdentity>;
	readonly token: WorkspaceActivityToken;
	/** Only pre-spawn cancellation or an authoritative process barrier can finish it. */
	end(outcome: "finished" | "unknown"): void;
}

export interface LocalFileChangeRuntimeOptions {
	db: RuntimeDb;
	/** Constructing a runtime never creates this directory or touches the application DB. */
	privateRoot: string;
	coordinatorState?: WorkspaceWriteCoordinatorState;
	readRuntime?: (deviceId: string) => WorkspaceRuntimeBinding | null;
	io?: FileChangeLocalIo;
	evidence?: FileChangeEvidenceService;
	blobStoreOptions?: Omit<FileChangeBlobStoreOptions, "root" | "admission">;
	quotaBytes?: number;
}

type Namespace = {
	sourceInstanceId: string;
	catalog: FileChangeBlobCatalog;
	store: FileChangeBlobStore;
	generation: number;
	/** Fixed directory objects, not a cached assertion that permissions stay safe. */
	directoryBoundary: string;
	blobRootIdentity: string;
};

/**
 * Local IO vertical slice only. Other writers, remote guarded RPC and revert are
 * NOT implemented by this service. The journal is the local durable receipt;
 * failed journal commits retain the coordinator quarantine, never replay IO.
 */
export class LocalFileChangeRuntime {
	readonly evidence: FileChangeEvidenceService;
	readonly coordinator: WorkspaceWriteCoordinator;
	private readonly database: RuntimeDb;
	private readonly readRuntime: (deviceId: string) => WorkspaceRuntimeBinding | null;
	private readonly io: FileChangeLocalIo;
	private initialization?: Promise<Namespace>;

	constructor(private readonly options: LocalFileChangeRuntimeOptions) {
		if (!isAbsolute(options.privateRoot)) throw new Error("Private evidence root must be absolute");
		this.database = options.db;
		this.readRuntime = options.readRuntime ?? localFileChangeRuntimeBinding;
		this.io = options.io ?? fileChangeLocalIo;
		this.evidence = options.evidence ?? new FileChangeEvidenceService(options.db);
		this.coordinator = new WorkspaceWriteCoordinator({
			db: options.db,
			readRuntime: this.readRuntime,
			state: options.coordinatorState,
		});
	}

	/** Retrying revalidates the namespace; it never clears a durable recovery barrier. */
	initialize(): Promise<Namespace> {
		if (!this.initialization) {
			const pending = this.initializeNamespace();
			this.initialization = pending;
			void pending.catch(() => {
				// Do not poison this runtime forever after a transient FS/permission error.
				// A subsequent call still runs every namespace and reservation check.
				if (this.initialization === pending) this.initialization = undefined;
			});
		}
		return this.initialization;
	}

	private async initializeNamespace(): Promise<Namespace> {
		const privateRoot = resolve(this.options.privateRoot);
		await mkdir(privateRoot, { recursive: true, mode: 0o700 });
		const directoryBoundary = await requireApplicationDataDirectory(privateRoot);
		const sourceInstanceId = await persistentSourceId(privateRoot);
		if ((await requireApplicationDataDirectory(privateRoot)) !== directoryBoundary)
			throw new Error("Application data directory changed during evidence initialization");
		const root = join(privateRoot, "file-change-blobs");
		await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		await requirePrivateDirectory(root);
		const rootIdentity = await localDirectoryIdentity(root);
		const catalog = new FileChangeBlobCatalog({
			db: this.database,
			namespaceKey: hash([sourceInstanceId, root, rootIdentity]),
		});
		let budget = catalog.getBudget();
		if (!budget) {
			// Only a truly empty FIRST namespace has a complete bounded inventory.
			// A nonempty directory needs the real maintenance worker, not guessed totals.
			await requireEmptyDirectory(root);
			if (this.database.select({ id: fileChangeBlobs.id }).from(fileChangeBlobs).limit(1).get())
				throw new Error("Blob catalog has evidence without a verified namespace");
			budget = catalog.initializeNamespace({
				expectedGeneration: null,
				quotaBytes: this.options.quotaBytes,
			});
			budget = catalog.beginReconciliation({ expectedGeneration: budget.generation });
			await requireEmptyDirectory(root);
			await requirePrivateDirectory(root);
			if (
				(await localDirectoryIdentity(root)) !== rootIdentity ||
				(await requireApplicationDataDirectory(privateRoot)) !== directoryBoundary
			)
				throw new Error("Blob namespace changed during empty initialization");
			budget = catalog.completeReconciliation({
				expectedGeneration: budget.generation,
				verifiedUsedBytes: 0,
				verification: {
					namespaceIdentityVerified: true,
					writersQuiescent: true,
					physicalInventoryComplete: true,
					catalogMatchesInventory: true,
				},
			});
		}
		if (budget.status !== "ready")
			throw new Error("Blob namespace needs verified maintenance reconciliation");
		for (const status of ["reserved", "reconcile_required"] as const) {
			if (
				catalog.listReservations({ expectedGeneration: budget.generation, status, limit: 1 }).items
					.length
			)
				throw new Error(
					"Unfinished blob reservation requires reconciliation; no target was written",
				);
		}
		const runtime = this.readRuntime(LOCAL_DEVICE_ID);
		if (!runtime) throw new Error("Local execution runtime is unavailable");
		return {
			sourceInstanceId,
			catalog,
			directoryBoundary,
			blobRootIdentity: rootIdentity,
			generation: budget.generation,
			store: new FileChangeBlobStore({
				...this.options.blobStoreOptions,
				root,
				admission: catalog.admission({
					expectedGeneration: budget.generation,
					ownerEpoch: runtime.runtimeEpoch,
				}),
			}),
		};
	}

	/** Read-only preview admission: never invent a missing installation identity. Cold
	 * startup may attach the existing verified namespace, but this does not repair or
	 * recreate its source object. Rechecks cached directory boundaries and catalog fence. */
	async verifyNamespace(signal?: AbortSignal): Promise<Namespace> {
		signal?.throwIfAborted();
		const privateRoot = resolve(this.options.privateRoot);
		const sourceInstanceId = await persistentSourceId(privateRoot, false);
		signal?.throwIfAborted();
		const namespace = await this.initialize();
		await this.assertNamespaceDirectories(namespace);
		if (
			sourceInstanceId !== namespace.sourceInstanceId ||
			(await persistentSourceId(privateRoot, false)) !== namespace.sourceInstanceId
		)
			throw new Error("File-change source identity changed; evidence needs verification");
		const budget = namespace.catalog.getBudget();
		if (budget?.status !== "ready" || budget.generation !== namespace.generation)
			throw new Error("File-change namespace catalog needs verification");
		signal?.throwIfAborted();
		return namespace;
	}

	private async assertNamespaceDirectories(namespace: Namespace): Promise<void> {
		const privateRoot = resolve(this.options.privateRoot);
		const blobRoot = join(privateRoot, "file-change-blobs");
		if ((await requireApplicationDataDirectory(privateRoot)) !== namespace.directoryBoundary)
			throw new Error("Application data directory identity changed; evidence needs verification");
		await requirePrivateDirectory(blobRoot);
		if ((await localDirectoryIdentity(blobRoot)) !== namespace.blobRootIdentity)
			throw new Error("Blob directory identity changed; evidence needs verification");
	}

	private validateCall(request: LocalFileChangeRequest) {
		const { ctx, backend, toolName } = request;
		const binding = ctx.toolCallBinding;
		const target = ctx.executionTarget;
		const runtime = this.readRuntime(LOCAL_DEVICE_ID);
		if (
			backend.kind !== "local" ||
			backend.deviceId !== LOCAL_DEVICE_ID ||
			!binding ||
			!target ||
			target.backendKind !== "local" ||
			target.deviceId !== LOCAL_DEVICE_ID ||
			target.pathFlavor !== backend.pathFlavor ||
			!target.lexicalPath ||
			!target.canonicalPath ||
			!runtime ||
			target.runtimeGeneration !== runtime.runtimeGeneration ||
			backend.runtimeGeneration !== runtime.runtimeGeneration
		)
			throw new Error("Trusted local tool-call binding and frozen target required");
		const row = this.database
			.select(TOOL_COLUMNS)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, binding.toolCallId))
			.get();
		if (
			!row ||
			row.version !== 1 ||
			row.origin !== null ||
			row.checkpoint ||
			row.attempt !== binding.attempt ||
			!Number.isSafeInteger(binding.attempt) ||
			binding.attempt < 1 ||
			row.narratorId !== ctx.narratorId ||
			row.toolUseId !== ctx.currentToolUseId ||
			row.toolName !== toolName ||
			row.device !== target.deviceId ||
			row.cwd !== target.cwd ||
			row.flavor !== target.pathFlavor ||
			row.lexical !== target.lexicalPath ||
			row.canonical !== target.canonicalPath ||
			row.generation !== target.runtimeGeneration ||
			((row.status !== "running" || row.startedAt === null) && row.operationId === null)
		)
			throw new Error("Tool-call row/attempt does not match its real authorized execution");
		if (
			!backend.paths.equals(backend.paths.resolve(target.cwd, request.filePath), target.lexicalPath)
		)
			throw new Error("Tool input changed its frozen path");
		return { row, target: Object.freeze({ ...target }), runtime: Object.freeze({ ...runtime }) };
	}

	private existingOperation(
		sourceInstanceId: string,
		request: Pick<BoundFileChange<unknown>, "sourceKind" | "sourceId" | "attempt">,
	) {
		return this.database
			.select()
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.sourceInstanceId, sourceInstanceId),
					eq(fileChangeOperations.sourceKind, request.sourceKind),
					eq(fileChangeOperations.sourceId, request.sourceId),
					eq(fileChangeOperations.attempt, request.attempt),
				),
			)
			.get();
	}

	private linkOperation(request: LocalFileChangeRequest, operationId: string): void {
		const binding = request.ctx.toolCallBinding;
		if (!binding) throw new Error("Missing tool-call binding");
		this.validateCall(request);
		const linked = this.database
			.update(narratorToolCalls)
			.set({ fileChangeOperationId: operationId })
			.where(
				and(
					eq(narratorToolCalls.id, binding.toolCallId),
					eq(narratorToolCalls.executionAttempt, binding.attempt),
					isNull(narratorToolCalls.fileChangeOperationId),
				),
			)
			.returning({ id: narratorToolCalls.id })
			.get();
		if (!linked)
			throw new Error("Tool-call operation reference is already bound; refusing redispatch");
	}

	async execute(request: LocalFileChangeRequest): Promise<ToolResult> {
		// Keep the authoritative attempt/target stable across every await. Later
		// caller context updates cannot redirect the journal association or IO.
		request = {
			...request,
			input: snapshotFileToolInput(request.input),
			ctx: {
				...request.ctx,
				toolCallBinding:
					request.ctx.toolCallBinding && Object.freeze({ ...request.ctx.toolCallBinding }),
				executionTarget:
					request.ctx.executionTarget && Object.freeze({ ...request.ctx.executionTarget }),
			},
		};
		const { ctx, backend } = request;
		const frozen = this.validateCall(request);
		const actorRow = this.database
			.select({
				title: narrators.title,
				variant: narrators.variant,
				type: narrators.type,
				parent: narrators.parentNarratorId,
				subtype: narrators.subagentType,
			})
			.from(narrators)
			.where(eq(narrators.id, ctx.narratorId))
			.get();
		if (!actorRow) throw new Error("Executing narrator no longer exists");
		const isSubagent = actorRow.variant.startsWith("subagent") || actorRow.type === "subagent";
		const completed = await this.executeBound({
			backend,
			cwd: frozen.target.cwd,
			lexicalPath: frozen.target.lexicalPath as string,
			canonicalPath: frozen.target.canonicalPath as string,
			runtime: frozen.runtime,
			signal: ctx.signal,
			input: request.input,
			sourceKind: "tool",
			sourceId: frozen.row.id,
			attempt: frozen.row.attempt,
			toolName: request.toolName,
			toolUseId: frozen.row.toolUseId,
			narratorId: ctx.narratorId,
			projectId: ctx.projectId,
			userId: ctx.userId,
			actor: {
				kind: isSubagent ? "subagent" : "primary",
				subjectKey: `narrator:${ctx.narratorId}`,
				narratorId: ctx.narratorId,
				userId: null,
				label: actorRow.title?.slice(0, 160) ?? null,
				deleted: false,
				parentSubjectKey: isSubagent && actorRow.parent ? `narrator:${actorRow.parent}` : null,
			},
			subtype: actorRow.subtype,
			executionSegmentId: ctx.executionSegmentId ?? null,
			construct: request.construct,
			assertBinding: () => {
				this.validateCall(request);
			},
			linkOperation: (id) => this.linkOperation(request, id),
			recordNoDispatch: (operation, error) => this.recordNoDispatch(request, operation, error),
		});
		const metadata = { ...completed.result.metadata };
		delete metadata.linesAdded;
		delete metadata.linesRemoved;
		if (completed.linesAdded !== null) metadata.linesAdded = completed.linesAdded;
		if (completed.linesRemoved !== null) metadata.linesRemoved = completed.linesRemoved;
		return {
			...completed.result,
			metadata: { ...metadata, fileChangeEvidence: completed.fileChangeEvidence },
		};
	}

	async executeEditor<Result>(
		request: EditorFileChangeRequest<Result>,
	): Promise<FileChangeCompletion<Result>> {
		request = Object.freeze({ ...request, input: snapshotFileToolInput(request.input) });
		const runtime = this.readRuntime(LOCAL_DEVICE_ID);
		if (!runtime || !request.requestId || !request.userId || !request.narratorId)
			throw new Error("Authenticated editor request and local runtime required");
		if (
			!isAbsolute(request.cwd) ||
			!isAbsolute(request.lexicalPath) ||
			!isAbsolute(request.canonicalPath)
		)
			throw new LocalFileValidationError("Editor requires a frozen absolute target");
		await request.authorize();
		let dispatched = false;
		let operationId: string | undefined;
		try {
			return await this.executeBound({
				...request,
				backend: localBackend,
				runtime: Object.freeze({ ...runtime }),
				sourceKind: "editor",
				sourceId: request.requestId,
				attempt: 1,
				actor: {
					kind: "human",
					subjectKey: `user:${request.userId}`,
					userId: request.userId,
					narratorId: null,
					label: null,
					deleted: false,
					parentSubjectKey: null,
				},
				subtype: null,
				assertBinding: request.authorize,
				linkOperation: (id) => {
					operationId = id;
				},
				onDispatch: () => {
					dispatched = true;
				},
			});
		} catch (error) {
			if (dispatched) throw new EditorFileChangeUncertainError(operationId, error);
			throw error;
		}
	}

	/** Bash is an unmeasured writer, not reversible history. Use the very same
	 * namespace and physical scope as Write/Edit; fail closed before process dispatch. */
	async registerBashActivity(request: LocalBashActivityRequest): Promise<LocalBashActivity> {
		const { backend, cwd } = request;
		const runtime = this.readRuntime(LOCAL_DEVICE_ID);
		if (
			backend.kind !== "local" ||
			backend.deviceId !== LOCAL_DEVICE_ID ||
			!runtime ||
			backend.runtimeGeneration !== runtime.runtimeGeneration
		)
			throw new Error("Bash activity requires the actual local execution runtime");
		const frozenRuntime = Object.freeze({ ...runtime });
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
		signal.throwIfAborted();
		await this.initialize();
		const namespace = await this.verifyNamespace(signal);
		const { scope, root } = await this.prepareWorkspaceScope(namespace, backend, cwd, signal);
		signal.throwIfAborted();
		const token = this.coordinator.registerActivity({ scope, runtime: frozenRuntime });
		return Object.freeze({
			cwd: root,
			scope,
			token,
			end: (outcome: "finished" | "unknown") => this.coordinator.endActivity(token, outcome),
		});
	}

	/** One scope resolver for actual local Write/Edit/editor targets and Bash cwd.
	 * A file outside cwd uses its nearest existing parent; Bash covers cwd itself. */
	private async prepareWorkspaceScope(
		namespace: Namespace,
		backend: ExecutionBackend,
		cwdPath: string,
		signal: AbortSignal,
		canonicalPath?: string,
	) {
		if (backend.pathFlavor !== "posix" && backend.pathFlavor !== "windows")
			throw new Error("Local evidence requires a filesystem path grammar");
		const cwd = await backend.resolvePathIdentity(cwdPath, { signal });
		await localDirectoryIdentity(cwd.canonicalPath);
		let root = cwd.canonicalPath;
		if (
			canonicalPath !== undefined &&
			(!backend.paths.contains(root, canonicalPath) || backend.paths.equals(root, canonicalPath))
		) {
			root = dirname(canonicalPath);
			for (let depth = 0; ; depth++) {
				if (depth > 128) throw new LocalFileValidationError("Target parent depth limit exceeded");
				try {
					await localDirectoryIdentity(root);
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					root = dirname(root);
				}
			}
		}
		const rootIdentity = await localDirectoryIdentity(root);
		const scope = this.evidence.prepareScope({
			sourceInstanceId: namespace.sourceInstanceId,
			deviceId: LOCAL_DEVICE_ID,
			workspaceInstanceId: hash([namespace.sourceInstanceId, root, rootIdentity]),
			canonicalRoot: root,
			pathFlavor: backend.pathFlavor,
		});
		if (scope.rootIdentityJson === null)
			this.evidence.recordScopeVerification({
				scopeId: scope.id,
				canonicalRoot: root,
				rootIdentity: { object: rootIdentity },
			});
		else if (scope.rootIdentityJson.object !== rootIdentity)
			throw new Error("Workspace incarnation no longer matches the verified scope");
		return { scope, root, rootIdentity };
	}

	/** One actual-byte journal/IO/receipt pipeline for tools and the human editor. */
	private async executeBound<Result>(
		request: BoundFileChange<Result>,
	): Promise<FileChangeCompletion<Result>> {
		const startedAt = performance.now();
		const { backend, lexicalPath, canonicalPath } = request;
		if (backend.pathFlavor !== "posix" && backend.pathFlavor !== "windows")
			throw new Error("Local evidence requires a filesystem path grammar");
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
		const namespace = await this.initialize();
		await this.assertNamespaceDirectories(namespace);
		const existing = this.existingOperation(namespace.sourceInstanceId, request);
		if (existing) throw alreadyAttempted(existing);
		signal.throwIfAborted();
		const path = await backend.resolvePathIdentity(lexicalPath, { signal });
		if (!backend.paths.equals(path.canonicalPath, canonicalPath))
			throw new LocalFileValidationError("Authorized canonical path changed before capture");
		const { scope, root, rootIdentity } = await this.prepareWorkspaceScope(
			namespace,
			backend,
			request.cwd,
			signal,
			canonicalPath,
		);
		const identity = createFileChangeIdentity(scope, {
			deviceId: LOCAL_DEVICE_ID,
			pathFlavor: backend.pathFlavor,
			canonicalPath,
			lexicalPath,
			objectRole: "referent",
		});
		const requestDigest = await hashLocalFileChangeRequest(
			[request.toolName ?? "editor", lexicalPath, canonicalPath],
			request.input,
			signal,
		);
		const historyTarget = {
			deviceId: LOCAL_DEVICE_ID,
			pathFlavor: backend.pathFlavor,
			canonicalPath,
		};
		try {
			return await this.coordinator.withWrite(
				{ scope, runtime: request.runtime, signal },
				// Fixed order: coordinator first, legacy mutex second. This preserves
				// coordinator nesting rejection, rollback barriers and bounded admission.
				// Use the frozen cwd, NOT the evidence root: Bash and legacy tools key
				// their mutex by this workspace spelling (normalized by the helper).
				async (lease) =>
					withFileHistoryWrite(
						historyTarget,
						() =>
							withWorkspaceWriteLock(
								backend,
								request.cwd,
								async () => {
									const repeated = this.existingOperation(namespace.sourceInstanceId, request);
									if (repeated) throw alreadyAttempted(repeated);
									const scopeRevision = this.evidence.getScope(scope.id)?.revision;
									if (scopeRevision === undefined) throw new Error("Granted scope disappeared");
									const operationInput: BeginFileChangeOperation = {
										sourceInstanceId: namespace.sourceInstanceId,
										sourceKind: request.sourceKind,
										sourceId: request.sourceId,
										toolCallId: request.sourceKind === "tool" ? request.sourceId : null,
										toolUseId: request.toolUseId,
										attempt: request.attempt,
										requestDigest,
										expectedEffectCount: 1,
										actor: request.actor,
										narratorId: request.narratorId,
										projectId: request.projectId,
										ownerUserId: request.userId,
										executionBinding: lease.executionBinding,
										executionSegmentId: request.executionSegmentId ?? null,
									};
									const assertTarget = async () => {
										await this.assertNamespaceDirectories(namespace);
										await request.assertBinding();
										lease.assertCurrent(lease.executionBinding);
										const actual = await backend.resolvePathIdentity(lexicalPath);
										if (
											!backend.paths.equals(actual.canonicalPath, canonicalPath) ||
											actual.runtimeGeneration !== request.runtime.runtimeGeneration ||
											(await localDirectoryIdentity(root)) !== rootIdentity
										)
											throw new LocalFileValidationError("Frozen local target/root changed");
										lease.assertCurrent(lease.executionBinding);
									};
									await assertTarget();
									let before: LocalFileObservation;
									let prepared: PreparedFileChange<Result>;
									try {
										before = await this.io.read(canonicalPath, signal);
										// Reading awaits IO too: do not return a conflict body after its ACL or
										// canonical target changed while those bytes were being collected.
										if (request.sourceKind === "editor") await assertTarget();
										if (before.mode !== null && (before.mode & 0o222) === 0)
											throw new LocalFileValidationError("File is read-only");
										prepared = await request.construct(before);
										if (prepared.nextBytes.byteLength > FILE_CHANGE_LIMITS.blobBytes)
											throw new LocalFileValidationError(
												"Output exceeds the 32 MiB evidence limit",
											);
									} catch (error) {
										// Only construction/known validation failures qualify. Infrastructure
										// failures are not evidence of a no-change operation.
										request.recordNoDispatch?.(operationInput, error);
										throw error;
									}
									const beforeState = await this.publish(namespace, before, signal);
									const afterState = await this.publish(
										namespace,
										{
											bytes: prepared.nextBytes,
											mode: before.mode ?? 0o666 & ~process.umask(),
											identity: null,
										},
										signal,
									);
									const operation = this.evidence.beginOperation(operationInput);
									request.linkOperation?.(operation.id);
									const effect = this.evidence.prepareEffects(operation.id, [
										{
											identity,
											scopeRevision,
											requestDigest,
											before: beforeState,
											intendedAfter: afterState,
										},
									])[0];
									await this.evidence.finalizePreparation(operation.id, { signal });
									const selector = {
										operationId: operation.id,
										mutationId: effect.mutationId,
										requestDigest,
									};
									if (
										!this.evidence.markApplying({
											...selector,
											executionBinding: lease.executionBinding,
										}).mayExecute
									)
										throw alreadyAttempted(operation);
									lease.registerMutation(effect.mutationId);
									let dispatched = false;
									let applied = false;
									let ioError: unknown;
									let observed: LocalFileObservation | undefined;
									try {
										await this.io.apply({
											backend,
											lexicalPath,
											canonicalPath,
											before,
											nextBytes: prepared.nextBytes,
											signal,
											assertTarget,
											onDispatch: () => {
												dispatched = true;
												request.onDispatch?.();
											},
										});
										applied = true;
									} catch (error) {
										ioError = error;
									}
									// Cancellation cannot suppress the bounded after observation/settlement.
									try {
										await assertTarget();
										observed = await this.io.read(canonicalPath, AbortSignal.timeout(5_000));
									} catch (error) {
										ioError ??= error;
									}
									// Sample once at the IO boundary. Metadata callbacks never resample or
									// downgrade the grade or line counts of an immutable settled receipt.
									// The exact before/after observation remains reversible even when a nearby
									// Bash activity is intentionally skipped or ambiguous. Ambiguity belongs to
									// that Bash operation, not to this independently journaled file write.
									const attributionCeiling = "measured";
									try {
										const observedAfter: FileChangeState = !observed
											? { kind: "unknown", reason: "missing_after" }
											: observed.bytes !== null &&
													observed.mode === afterStateMode(afterState) &&
													Buffer.from(observed.bytes).equals(prepared.nextBytes)
												? afterState
												: sameObservedBytes(observed, before)
													? beforeState
													: await this.publish(namespace, observed, AbortSignal.timeout(5_000));
										const receipt: FileChangeExecutionReceipt = {
											receiptId: generateId(),
											mutationId: effect.mutationId,
											requestDigest,
											executionBinding: lease.executionBinding,
											observedAfter,
											outcome: applied ? "applied" : dispatched ? "unknown" : "not_applied",
											confirmed: applied || !dispatched,
										};
										const settled = this.evidence.settleEffect({
											...selector,
											receipt,
											attributionCeiling,
											linesAdded: prepared.lineStats?.added,
											linesRemoved: prepared.lineStats?.removed,
										});
										const verified = applied && fileChangeStatesEqual(afterState, observedAfter);
										this.evidence.finishOperation(
											operation.id,
											ioError || !verified
												? signal.aborted
													? "interrupted"
													: "failed"
												: "succeeded",
										);
										lease.settle(
											effect.mutationId,
											settled.settlement === "settled"
												? applied
													? "applied"
													: "not_applied"
												: "unknown",
										);
										// Unknown/failed-but-dispatched effects remain visible with unmeasured
										// counts. A positively non-applied or identical rewrite is not a change.
										if (settled.outcome !== "no_change")
											this.project(request, operation, settled, scope);
										if (ioError) throw ioError;
										if (!verified)
											throw new Error(
												"Local after state did not match the durable intent; reconciliation required",
											);
										return {
											result: prepared.result,
											linesAdded: settled.linesAdded,
											linesRemoved: settled.linesRemoved,
											fileChangeEvidence: {
												version: 2,
												operationId: operation.id,
												effectId: effect.id,
												grade: settled.attributionGrade,
												settlement: settled.settlement,
												outcome: settled.outcome,
											},
										};
									} catch (error) {
										// A settled receipt stays frozen. Only unsettled persistence/IO needs
										// quarantine; never retry a mutation or write a before-state here.
										if (lease.pendingMutationCount > 0) lease.markUncertain();
										throw error;
									}
								},
								signal,
							),
						signal,
					),
			);
		} finally {
			const elapsedMs = Math.round(performance.now() - startedAt);
			if (elapsedMs > 1_000)
				logger.warn("Slow local file-change operation", {
					sourceKind: request.sourceKind,
					sourceId: request.sourceId,
					elapsedMs,
				});
		}
	}

	private async publish(
		namespace: Namespace,
		observed: LocalFileObservation,
		signal: AbortSignal,
	): Promise<FileChangeState> {
		if (observed.bytes === null) return { kind: "absent" };
		await this.assertNamespaceDirectories(namespace);
		const blob = await namespace.store.putBytes(observed.bytes, {
			expectedSize: observed.bytes.byteLength,
			signal,
		});
		if (
			namespace.catalog.getMetadata({ expectedGeneration: namespace.generation, ref: blob })
				?.status !== "ready"
		)
			throw new Error("Published raw evidence did not become ready");
		return { kind: "regular", blob, mode: observed.mode };
	}

	private recordNoDispatch(
		request: LocalFileChangeRequest,
		operation: BeginFileChangeOperation,
		error: unknown,
	): void {
		if (!(error instanceof LocalFileValidationError)) return;
		// This branch is reachable only before io.apply (and before any blob or
		// intent persistence). EACCES/quota/DB failures are NOT no-change evidence.
		this.validateCall(request);
		this.evidence.beginNoDispatchOperation(operation, {
			targetDispatched: false,
			reason: "validation_rejected",
		});
	}

	private project(
		request: BoundFileChange<unknown>,
		operation: FileChangeOperationRecord,
		effect: FileChangeEffectRecord,
		scope: FileChangeScopeIdentity,
	): void {
		try {
			this.database
				.insert(fileAttributions)
				.values({
					id: generateId(),
					deviceId: LOCAL_DEVICE_ID,
					workspacePath: scope.canonicalRoot,
					filePath: effect.identityJson.displayPath,
					narratorId: request.sourceKind === "editor" ? null : request.narratorId,
					userId: request.actor.userId,
					subagentType: request.subtype,
					action:
						request.sourceKind === "editor"
							? "human"
							: request.toolName === "Write"
								? "write"
								: "edit",
					toolName: request.toolName,
					toolUseId: request.toolUseId,
					operationId: operation.id,
					effectId: effect.id,
					scopeId: scope.id,
					fileKey: effect.fileKey,
					actorSubjectKey: operation.actorSubjectKey,
					actorSnapshotJson: operation.actorJson,
					attributionGrade: effect.attributionGrade,
					linesAdded: effect.linesAdded,
					linesRemoved: effect.linesRemoved,
					changedAt: new Date().toISOString(),
				})
				.onConflictDoNothing({ target: fileAttributions.effectId })
				.run();
		} catch (error) {
			// This rebuildable projection never alters the frozen receipt/operation.
			logger.warn("File-change projection unavailable", {
				operationId: operation.id,
				error: String(error),
			});
		}
	}
}

const runtimeContext = hotSafe(
	"narrafork.local-file-change-runtime.context.v1",
	() => new AsyncLocalStorage<LocalFileChangeRuntime>(),
);

/** Scoped dependency injection for real tool tests; no global DB or production runtime reset. */
export function withLocalFileChangeRuntime<T>(runtime: LocalFileChangeRuntime, body: () => T): T {
	return runtimeContext.run(runtime, body);
}

// Cache the service only for this module generation, not the old implementation
// across hot reloads. Authoritative epoch/coordinator state remains hotSafe; live
// old calls keep their own leases and durable recovery barriers are never reset.
let defaultRuntime: LocalFileChangeRuntime | undefined;

/** Undefined is the explicit legacy/remote branch, never a failed v2 fallback. */
export async function executeLocalFileChange(
	request: LocalFileChangeRequest,
): Promise<ToolResult | undefined> {
	if (request.backend.kind !== "local" || !request.ctx.toolCallBinding) return undefined;
	return (await currentRuntime()).execute(request);
}

/** No legacy fallback: a human request either has durable evidence or is refused. */
export async function executeEditorFileChange<Result>(
	request: EditorFileChangeRequest<Result>,
): Promise<FileChangeCompletion<Result>> {
	return (await currentRuntime()).executeEditor(request);
}

/** Resolve no local runtime/DB at all for remote execution, and never turn a
 * mismatched frozen remote target into a local fallback. Shares Write/Edit's DI. */
export async function registerLocalBashActivity(
	request: LocalBashActivityRequest,
): Promise<LocalBashActivity | undefined> {
	const { backend, cwd } = request;
	const target = request.target && Object.freeze({ ...request.target });
	if (
		target &&
		(target.backendKind !== backend.kind ||
			target.deviceId !== backend.deviceId ||
			target.pathFlavor !== backend.pathFlavor ||
			target.runtimeGeneration !== backend.runtimeGeneration ||
			!backend.paths.equals(target.cwd, cwd))
	)
		throw new Error("Bash execution target does not match its frozen backend/cwd");
	if (backend.kind === "remote") {
		if (backend.deviceId === LOCAL_DEVICE_ID)
			throw new Error("A remote Bash backend cannot use the local device identity");
		return undefined;
	}
	if (backend.deviceId !== LOCAL_DEVICE_ID)
		throw new Error("Local Bash requires the local device identity");
	// Real rollback is currently local POSIX only. Do not introduce its namespace
	// requirements on Windows or remote targets where rollback execution is disabled.
	if (backend.pathFlavor === "windows" || process.platform === "win32") return undefined;
	return (await currentRuntime()).registerBashActivity({ ...request, target });
}

async function currentRuntime(): Promise<LocalFileChangeRuntime> {
	return runtimeContext.getStore() ?? getDefaultLocalFileChangeRuntime();
}

/** The same module-generation default used by actual Write/Edit/editor IO, never
 * an old hotSafe class instance or a preview-specific runtime/coordinator. */
export async function getDefaultLocalFileChangeRuntime(): Promise<LocalFileChangeRuntime> {
	const { db } = await import("../db");
	defaultRuntime ??= new LocalFileChangeRuntime({ db, privateRoot: getNarraforkHome() });
	return defaultRuntime;
}

type FileToolScalar = string | number | boolean | null;

function snapshotFileToolInput(
	input: Record<string, unknown>,
): Readonly<Record<string, FileToolScalar>> {
	if (
		!input ||
		(Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
	)
		throw new LocalFileValidationError("File-change input must be a flat JSON object");
	const entries: [string, FileToolScalar][] = [];
	// for-in avoids allocating an unbounded keys array before checking the limit.
	let count = 0;
	for (const key in input) {
		if (!Object.hasOwn(input, key)) continue;
		if (
			++count > FILE_CHANGE_LIMITS.fileToolRequestFields ||
			key.length > FILE_CHANGE_LIMITS.metadataBytes ||
			Buffer.byteLength(key) > FILE_CHANGE_LIMITS.metadataBytes
		)
			throw new LocalFileValidationError("File-change input fields exceed their bounded budget");
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !Object.hasOwn(descriptor, "value"))
			throw new LocalFileValidationError("File-change input cannot contain accessors");
		const value: unknown = descriptor.value;
		if (value === undefined) continue; // Same omission as JSON.stringify of a plain object.
		if (typeof value === "string") {
			if (value.length > FILE_CHANGE_LIMITS.fileToolRequestBytes)
				throw new LocalFileValidationError("File-change request exceeds its bounded input budget");
		} else if (
			value !== null &&
			typeof value !== "boolean" &&
			!(typeof value === "number" && Number.isFinite(value))
		) {
			throw new LocalFileValidationError("File-change input must contain only JSON scalar fields");
		}
		entries.push([key, value as FileToolScalar]);
	}
	return Object.freeze(Object.fromEntries(entries));
}

/** Small identity material only; request bodies use the cancellable streaming path below. */
function identityHasher(parts: readonly string[]) {
	const digest = createHash("sha256");
	if (parts.length > FILE_CHANGE_LIMITS.fileToolRequestFields)
		throw new LocalFileValidationError("Too many file-change identity fields");
	for (const text of parts) {
		if (
			typeof text !== "string" ||
			text.length > FILE_CHANGE_LIMITS.metadataBytes ||
			Buffer.byteLength(text) > FILE_CHANGE_LIMITS.metadataBytes
		)
			throw new LocalFileValidationError("File-change identity exceeds its metadata budget");
		digest.update(`${Buffer.byteLength(text)}:`).update(text);
	}
	return digest;
}

function hash(parts: readonly string[]): string {
	return identityHasher(parts).digest("hex");
}

/** Count UTF-8 bytes of JSON string content without allocating the escaped string. */
function jsonStringContentByteLength(value: string, start: number, end: number): number {
	const chunk = value.slice(start, end);
	// The common path has no JSON escapes or surrogate code units; let native byte
	// counting handle it without a JavaScript loop over every UTF-16 unit.
	if (chunk.search(/[\u0000-\u001f\uD800-\uDFFF"\\]/) < 0) return Buffer.byteLength(chunk);
	if (chunk.search(/[\uD800-\uDFFF]/) < 0) {
		const rawBytes = Buffer.byteLength(chunk);
		const quoteAndSlash = chunk.length - chunk.replace(/["\\]/g, "").length;
		const shortEscapes =
			chunk.length - chunk.replace(/[\u0008\u0009\u000a\u000c\u000d]/g, "").length;
		const longEscapes =
			chunk.length - chunk.replace(/[\u0000-\u0007\u000b\u000e-\u001f]/g, "").length;
		return rawBytes + quoteAndSlash + shortEscapes + longEscapes * 5;
	}
	let bytes = 0;
	for (let index = 0; index < chunk.length; index++) {
		const code = chunk.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			bytes += 2;
		} else if (code < 0x20) {
			bytes += 6;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = index + 1 < chunk.length ? chunk.charCodeAt(index + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 6;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			bytes += 6;
		} else if (code <= 0x7f) {
			bytes++;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else bytes += 3;
	}
	return bytes;
}

/** Yield the exact byte lengths of request JSON parts without creating them. */
function* requestJsonPartByteLengths(
	input: Readonly<Record<string, FileToolScalar>>,
): Generator<number> {
	yield 1; // {
	let first = true;
	for (const [key, value] of Object.entries(input)) {
		if (!first) yield 1; // comma
		first = false;
		yield Buffer.byteLength(JSON.stringify(key));
		yield 1; // colon
		if (typeof value !== "string") {
			yield Buffer.byteLength(JSON.stringify(value));
			continue;
		}
		yield 1; // opening quote
		yield jsonStringContentByteLength(value, 0, value.length);
		yield 1; // closing quote
	}
	yield 1; // }
}

/**
 * Same length-prefixed JSON digest as the original path, without materializing
 * a potentially 96 MiB JSON string or hashing it in one event-loop turn. Inputs
 * are copied as at most 16 immutable scalar references before the first await.
 */
export async function hashLocalFileChangeRequest(
	identityParts: readonly string[],
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const digest = identityHasher(identityParts);
	const snapshot = snapshotFileToolInput(input);
	let size = 0;
	let bytesSinceYield = 0;
	for (const partBytes of requestJsonPartByteLengths(snapshot)) {
		signal?.throwIfAborted();
		size += partBytes;
		bytesSinceYield += partBytes;
		if (size > FILE_CHANGE_LIMITS.fileToolRequestBytes)
			throw new LocalFileValidationError("File-change request exceeds its bounded input budget");
		if (bytesSinceYield >= FILE_CHANGE_LIMITS.streamChunkBytes) {
			bytesSinceYield = 0;
			await yieldToEventLoop();
		}
	}
	signal?.throwIfAborted();
	digest.update(`${size}:`);
	bytesSinceYield = 0;
	for (const part of requestJsonParts(snapshot)) {
		signal?.throwIfAborted();
		digest.update(part);
		bytesSinceYield += Buffer.byteLength(part);
		if (bytesSinceYield >= FILE_CHANGE_LIMITS.streamChunkBytes) {
			bytesSinceYield = 0;
			await yieldToEventLoop();
		}
	}
	signal?.throwIfAborted();
	return digest.digest("hex");
}

function* requestJsonParts(input: Readonly<Record<string, FileToolScalar>>): Generator<string> {
	yield "{";
	let first = true;
	// Worst-case JSON escaping is six bytes per UTF-16 code unit.
	const units = Math.floor(FILE_CHANGE_LIMITS.streamChunkBytes / 6);
	for (const [key, value] of Object.entries(input)) {
		if (!first) yield ",";
		first = false;
		yield `${JSON.stringify(key)}:`;
		if (typeof value !== "string") {
			yield JSON.stringify(value);
			continue;
		}
		yield '"';
		for (let offset = 0; offset < value.length; ) {
			let end = Math.min(value.length, offset + units);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			)
				end--; // Never change JSON's treatment of a pair straddling a chunk boundary.
			yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
			offset = end;
		}
		yield '"';
	}
	yield "}";
}

function afterStateMode(state: FileChangeState): number | null {
	return state.kind === "regular" ? state.mode : null;
}

function sameObservedBytes(left: LocalFileObservation, right: LocalFileObservation): boolean {
	return (
		left.mode === right.mode &&
		(left.bytes === null
			? right.bytes === null
			: right.bytes !== null && Buffer.from(left.bytes).equals(right.bytes))
	);
}

function alreadyAttempted(operation: FileChangeOperationRecord): Error {
	return new Error(
		`File operation ${operation.id} is already ${operation.settlement}; no mutation was retried`,
	);
}

async function requirePrivateDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.platform !== "win32" &&
			((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid?.()))
	)
		throw new Error(
			`Evidence directory must be an owned private (0700) non-symlink directory: ${path}`,
		);
	if (resolve(await realpath(path)) !== resolve(path))
		throw new Error(`Evidence directory must use its real canonical path: ${path}`);
}

async function requireEmptyDirectory(path: string): Promise<void> {
	const directory = await opendir(path);
	try {
		if (await directory.read())
			throw new Error("Nonempty blob namespace requires maintenance reconciliation");
	} finally {
		await directory.close();
	}
}

/** Atomic exclusive publication; never replace an existing instance identity. */
async function persistentSourceId(root: string, createIfMissing = true): Promise<string> {
	const path = join(root, "file-change-source.json");
	const read = async () => {
		const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await file.stat({ bigint: true });
			if (
				!stat.isFile() ||
				stat.nlink !== 1n ||
				stat.size > 512n ||
				(process.platform !== "win32" &&
					((stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.geteuid?.() ?? -1)))
			)
				throw new Error("Invalid private source identity object");
			const bytes = Buffer.alloc(513);
			const result = await file.read(bytes, 0, bytes.length, 0);
			if (result.bytesRead > 512) throw new Error("Source identity exceeds its byte limit");
			const [final, entry] = await Promise.all([
				file.stat({ bigint: true }),
				lstat(path, { bigint: true }),
			]);
			if (
				!entry.isFile() ||
				entry.isSymbolicLink() ||
				entry.nlink !== 1n ||
				entry.dev !== stat.dev ||
				entry.ino !== stat.ino ||
				entry.birthtimeNs !== stat.birthtimeNs ||
				final.size !== stat.size ||
				final.mtimeNs !== stat.mtimeNs ||
				final.ctimeNs !== stat.ctimeNs ||
				entry.size !== final.size ||
				entry.mtimeNs !== final.mtimeNs ||
				entry.ctimeNs !== final.ctimeNs
			)
				throw new Error("Source identity object changed while being read");
			const value = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
			if (value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id))
				throw new Error("Invalid source identity format");
			return value.id as string;
		} finally {
			await file.close();
		}
	};
	try {
		return await read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createIfMissing) throw error;
	}
	const temporary = join(root, `.file-change-source-${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(JSON.stringify({ version: 1, id: randomUUID() }));
		await file.sync();
		await file.close();
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await file.close();
		await unlink(temporary);
	}
	// POSIX requires the directory entry to be flushed as well as the file.
	// Windows does not expose a portable directory-fsync through this API.
	if (process.platform !== "win32") {
		const directory = await open(root, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	return read();
}
