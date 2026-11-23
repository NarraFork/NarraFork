// biome-ignore-all lint/suspicious/noControlCharactersInRegex: JSON escaping requires these control-byte ranges.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeState,
	type FileHistoryStatus,
	type FileWriteOutcome,
} from "@shared/file-change-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import { fileAttributions, narrators, narratorToolCalls } from "../db/schema";
import { type ExecutionBackend, LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import type { ToolContext, ToolDefinition, ToolResult } from "../lib/agent/types";
import { requireApplicationDataDirectory } from "../lib/data-directory-security";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { applyLocalFileChange } from "./file-change-apply-result";
import { FileChangeBlobCatalog } from "./file-change-blob-catalog";
import { FileChangeBlobStore, type FileChangeBlobStoreOptions } from "./file-change-blob-store";
import { FileChangeDiagnostics, fileChangeDiagnosticSuffix } from "./file-change-diagnostics";
import {
	type BeginFileChangeOperation,
	type FileChangeEffectRecord,
	FileChangeEvidenceService,
	type FileChangeNoDispatchProof,
	type FileChangeOperationRecord,
} from "./file-change-evidence";
import {
	attachFileHistoryBudgetDiagnostic,
	FileHistoryNamespaceDiagnostics,
	type FileHistoryStage,
} from "./file-change-history-diagnostics";
import { createFileChangeIdentity, type FileChangeScopeIdentity } from "./file-change-identity";
import {
	type FileChangeLocalIo,
	fileChangeLocalIo,
	type LocalFileObservation,
	LocalFileValidationError,
	localDirectoryIdentity,
} from "./file-change-local-io";
import {
	assertLocalWriteFootprint,
	captureLocalWriteFootprint,
} from "./file-change-write-footprint";
import { withFileWrite } from "./file-write-queue";

type RuntimeDb = typeof applicationDb;
type RuntimeBinding = Readonly<{ runtimeEpoch: string; runtimeGeneration: number }>;
type HostNoDispatchObservation = Readonly<{
	toolCallId: string;
	attempt: number;
	narratorId: string;
	toolUseId: string | undefined;
	toolName: FileChangeToolName;
	targetJson: string;
	status: "initializing" | "pending" | "running";
}>;
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
	segmentId: narratorToolCalls.executionSegmentId,
};

/** Process identity survives --hot but is never reused across an actual restart. */
export function localFileChangeRuntimeBinding(deviceId = LOCAL_DEVICE_ID): RuntimeBinding | null {
	return deviceId === LOCAL_DEVICE_ID
		? hotSafe("narrafork.local-file-change-runtime.epoch.v1", () =>
				Object.freeze({ runtimeEpoch: randomUUID(), runtimeGeneration: 0 }),
			)
		: null;
}

interface PreparedFileChange<Result> {
	nextBytes: Uint8Array;
	rawDigest?: string;
	beforeRawDigest?: string | null;
	result: Result;
	lineStats: { added: number; removed: number } | null;
}
export type PreparedLocalFileChange = PreparedFileChange<ToolResult>;
export interface EditorFileChangeRequest<Result> {
	resourceKey?: string;
	workspaceRevision?: number;
	/** Editor-only IO seam, selected by the trusted provider, never HTTP input. */
	io?: FileChangeLocalIo;
	/** Remote target identity/IO comes only from the authorized provider, never Host FS. */
	remote?: {
		backend: ExecutionBackend;
		runtime: RuntimeBinding;
		currentRuntime(): RuntimeBinding | null;
		rootIdentity: string;
		assertParent(signal: AbortSignal): Promise<void>;
	};
	requestId: string;
	userId: string;
	narratorId: string;
	projectId?: string | null;
	cwd: string;
	lexicalPath: string;
	canonicalPath: string;
	signal: AbortSignal;
	input: Record<string, unknown>;
	authorize(): Promise<void>;
	/** Pure construction from the raw before captured inside this file's write queue. */
	construct(
		before: LocalFileObservation,
	): PreparedFileChange<Result> | Promise<PreparedFileChange<Result>>;
}
export interface FileChangeCompletion<Result> {
	result: Result;
	diskOutcome: FileWriteOutcome;
	historyStatus: FileHistoryStatus;
	fileChangeTiming?: { waitMs: number; executionMs: number; totalMs: number };
	linesAdded: number | null;
	linesRemoved: number | null;
	fileChangeEvidence?: {
		version: 3;
		operationId: string;
		effectId: string;
		grade: FileChangeEffectRecord["attributionGrade"];
		settlement: FileChangeEffectRecord["settlement"];
		outcome: FileChangeEffectRecord["outcome"];
	};
}
export class EditorFileChangeUncertainError extends Error {
	readonly diskOutcome = "unknown";
	constructor(
		readonly operationId: string | undefined,
		cause: unknown,
		readonly historyStatus: FileHistoryStatus = "unavailable",
	) {
		super(
			`Editor save outcome is unknown; inspect the file before retrying${fileChangeDiagnosticSuffix(cause)}`,
			{ cause },
		);
		this.name = "EditorFileChangeUncertainError";
	}
}
export type FileChangeToolName = "Write" | "Edit" | "StructSed" | "GenUI";
type BoundFileChange<Result> = {
	io?: FileChangeLocalIo;
	remote?: EditorFileChangeRequest<Result>["remote"];
	backend: ExecutionBackend;
	cwd: string;
	lexicalPath: string;
	canonicalPath: string;
	runtime: RuntimeBinding;
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
	noDispatch?(): Promise<void>;
	linkOperation?(operationId: string): void;
	exclusiveCreate?: boolean;
};
export interface LocalFileChangeRequest {
	ctx: ToolContext;
	backend: ExecutionBackend;
	toolName: FileChangeToolName;
	filePath: string;
	exclusiveCreate?: boolean;
	input: Record<string, unknown>;
	construct(
		before: LocalFileObservation,
	): PreparedLocalFileChange | Promise<PreparedLocalFileChange>;
}
export interface LocalFileChangeRuntimeOptions {
	db: RuntimeDb;
	privateRoot: string;
	readRuntime?: (deviceId: string) => RuntimeBinding | null;
	io?: FileChangeLocalIo;
	evidence?: FileChangeEvidenceService;
	blobStoreOptions?: Omit<FileChangeBlobStoreOptions, "root" | "admission">;
	quotaBytes?: number;
	/** Monotonic clock seam for the bounded namespace failure diagnostic only. */
	historyDiagnosticClock?: () => number;
}
type Namespace = {
	sourceInstanceId: string;
	catalog: FileChangeBlobCatalog;
	store: FileChangeBlobStore;
	generation: number;
};
type AttemptSummary = {
	running: boolean;
	operationId?: string;
	diskOutcome?: FileWriteOutcome;
	historyStatus?: FileHistoryStatus;
};
// Metadata only. Durable operations provide the normal replay barrier; this bounded
// cache also covers in-flight requests and unavailable-history windows across --hot.
const attempts = hotSafe(
	"narrafork.file-write-attempts.v3",
	() => new WeakMap<object, Map<string, AttemptSummary>>(),
);
const remoteAttempts = hotSafe(
	"narrafork.remote-file-write-attempts.v3",
	() => new Map<string, { running: boolean }>(),
);
const MAX_ATTEMPTS = 8192;
const HISTORY_BUDGET_MS = 1500;

export class LocalFileChangeRuntime {
	readonly evidence: FileChangeEvidenceService;
	private readonly database: RuntimeDb;
	private readonly readRuntime: (deviceId: string) => RuntimeBinding | null;
	private readonly io: FileChangeLocalIo;
	private initialization?: Promise<Namespace>;
	private readonly historyDiagnostics: FileHistoryNamespaceDiagnostics;
	private readonly noDispatchObservations = new WeakSet<HostNoDispatchObservation>();

	constructor(private readonly options: LocalFileChangeRuntimeOptions) {
		if (!isAbsolute(options.privateRoot)) throw new Error("Private evidence root must be absolute");
		this.database = options.db;
		this.readRuntime = options.readRuntime ?? localFileChangeRuntimeBinding;
		this.io = options.io ?? fileChangeLocalIo;
		this.evidence = options.evidence ?? new FileChangeEvidenceService(options.db);
		this.historyDiagnostics = new FileHistoryNamespaceDiagnostics({
			now: options.historyDiagnosticClock,
			log: (message, fields) => logger.warn(message, fields),
		});
	}

	initialize(): Promise<Namespace> {
		if (!this.initialization) {
			const pending = this.initializeNamespace();
			this.initialization = pending;
			void pending.catch((cause) => {
				if (this.initialization === pending) this.initialization = undefined;
				// Count one actual initialization, regardless of its concurrent waiters.
				this.historyDiagnostics.failure("initialize", cause);
			});
		}
		return this.initialization;
	}

	private async initializeSourceIdentity(): Promise<string> {
		const privateRoot = resolve(this.options.privateRoot);
		await mkdir(privateRoot, { recursive: true, mode: 0o700 });
		await requireApplicationDataDirectory(privateRoot);
		return persistentSourceId(privateRoot);
	}

	/** Querying an old receipt must never create a replacement source identity. */
	async readExistingSourceInstanceId(signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		await requireApplicationDataDirectory(resolve(this.options.privateRoot));
		const sourceInstanceId = await persistentSourceId(this.options.privateRoot, false);
		signal?.throwIfAborted();
		return sourceInstanceId;
	}

	private async initializeNamespace(): Promise<Namespace> {
		this.historyDiagnostics.clearIdentity();
		const privateRoot = resolve(this.options.privateRoot);
		const sourceInstanceId = await this.initializeSourceIdentity();
		const root = join(privateRoot, "file-change-blobs");
		await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		await requirePrivateDirectory(root);
		const directoryIdentity = await localDirectoryIdentity(root);
		const namespaceKey = hash([sourceInstanceId, root, directoryIdentity]);
		this.historyDiagnostics.rememberIdentity({
			sourceInstanceId,
			root,
			directoryIdentity,
			namespaceKey,
		});
		const catalog = new FileChangeBlobCatalog({ db: this.database, namespaceKey });
		const budget = catalog.initializeNamespace({
			expectedGeneration: null,
			quotaBytes: this.options.quotaBytes,
		});
		const runtime = this.readRuntime(LOCAL_DEVICE_ID);
		if (!runtime) throw new Error("Local execution runtime is unavailable");
		return {
			sourceInstanceId,
			catalog,
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

	async verifyNamespace(signal?: AbortSignal): Promise<Namespace> {
		signal?.throwIfAborted();
		const namespace = await this.initialize();
		await requireApplicationDataDirectory(resolve(this.options.privateRoot));
		await requirePrivateDirectory(join(this.options.privateRoot, "file-change-blobs"));
		if ((await persistentSourceId(this.options.privateRoot, false)) !== namespace.sourceInstanceId)
			throw new Error("File history source identity changed");
		signal?.throwIfAborted();
		return namespace;
	}

	assertAdmission(
		request: Pick<LocalFileChangeRequest, "ctx" | "backend" | "toolName" | "filePath">,
	): void {
		if (request.ctx.toolCallBinding) this.validateCall(request);
	}
	private validateCall(
		request: Pick<
			LocalFileChangeRequest,
			"ctx" | "backend" | "toolName" | "filePath" | "exclusiveCreate"
		>,
	) {
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
			(toolName === "GenUI" && row.segmentId !== (ctx.executionSegmentId ?? null)) ||
			((row.status !== "running" || row.startedAt === null) && row.operationId === null)
		)
			throw new Error("Tool-call row/attempt does not match its real authorized execution");
		const filePath = backend.paths.resolve(target.cwd, request.filePath);
		if (request.exclusiveCreate) {
			// The authorized/persisted target remains the UI base. Only the generated
			// direct child App.tsx may refine it; never rewrite the tool-call identity.
			const directory = backend.paths.dirname(filePath);
			if (
				toolName !== "GenUI" ||
				!backend.paths.equals(target.lexicalPath, target.canonicalPath) ||
				!backend.paths.equals(backend.paths.dirname(directory), target.canonicalPath) ||
				backend.paths.basename(filePath) !== "App.tsx" ||
				!/^[\p{L}\p{N}][\p{L}\p{N}_-]{1,112}$/u.test(backend.paths.basename(directory))
			)
				throw new Error("Exclusive create escaped its frozen directory target");
			return {
				row,
				target: Object.freeze({ ...target, lexicalPath: filePath, canonicalPath: filePath }),
				runtime: Object.freeze({ ...runtime }),
			};
		}
		if (!backend.paths.equals(filePath, target.lexicalPath))
			throw new Error("Tool input changed its frozen path");
		return { row, target: Object.freeze({ ...target }), runtime: Object.freeze({ ...runtime }) };
	}

	prepareHostNoDispatch(
		ctx: ToolContext,
		toolName: FileChangeToolName,
	): (reason: FileChangeNoDispatchProof["reason"], claimed: boolean) => Promise<void> {
		const frozen: ToolContext = {
			...ctx,
			toolCallBinding: ctx.toolCallBinding && Object.freeze({ ...ctx.toolCallBinding }),
			executionTarget: ctx.executionTarget && Object.freeze({ ...ctx.executionTarget }),
		};
		const binding = frozen.toolCallBinding;
		const target = frozen.executionTarget;
		if (!binding || !target) throw new Error("No-dispatch observation requires a frozen attempt");
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
			row.narratorId !== ctx.narratorId ||
			row.toolUseId !== ctx.currentToolUseId ||
			row.toolName !== toolName ||
			row.device !== target.deviceId ||
			row.generation !== target.runtimeGeneration ||
			row.cwd !== target.cwd ||
			row.flavor !== target.pathFlavor ||
			row.lexical !== (target.lexicalPath ?? null) ||
			row.canonical !== (target.canonicalPath ?? null) ||
			!["initializing", "pending", "running"].includes(row.status) ||
			row.startedAt !== null ||
			row.operationId !== null
		)
			throw new Error(
				"No-dispatch observation must precede the live attempt's claim or termination",
			);
		const observation: HostNoDispatchObservation = Object.freeze({
			toolCallId: binding.toolCallId,
			attempt: binding.attempt,
			narratorId: ctx.narratorId,
			toolUseId: ctx.currentToolUseId,
			toolName,
			targetJson: JSON.stringify(target),
			status: row.status as HostNoDispatchObservation["status"],
		});
		this.noDispatchObservations.add(observation);
		return (reason, claimed) =>
			this.recordHostNoDispatch(frozen, toolName, reason, claimed, observation);
	}

	/** Host control-flow fact only: no IO lease, blob, file state or remote receipt. */
	async recordHostNoDispatch(
		ctx: ToolContext,
		toolName: FileChangeToolName,
		reason: FileChangeNoDispatchProof["reason"],
		claimed: boolean,
		observation?: HostNoDispatchObservation,
	): Promise<void> {
		const binding = ctx.toolCallBinding && Object.freeze({ ...ctx.toolCallBinding });
		const target = ctx.executionTarget && Object.freeze({ ...ctx.executionTarget });
		if (
			!binding ||
			!target ||
			target.pathFlavor === undefined ||
			target.runtimeGeneration === undefined
		)
			throw new Error("No-dispatch proof requires a frozen tool identity");
		const pathFlavor = target.pathFlavor;
		const observedLive =
			observation !== undefined &&
			this.noDispatchObservations.has(observation) &&
			observation.toolCallId === binding.toolCallId &&
			observation.attempt === binding.attempt &&
			observation.narratorId === ctx.narratorId &&
			observation.toolUseId === ctx.currentToolUseId &&
			observation.toolName === toolName &&
			observation.targetJson === JSON.stringify(target);
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
			binding.attempt < 1 ||
			row.narratorId !== ctx.narratorId ||
			row.toolUseId !== ctx.currentToolUseId ||
			row.toolName !== toolName ||
			row.device !== target.deviceId ||
			row.generation !== target.runtimeGeneration ||
			row.cwd !== target.cwd ||
			row.flavor !== target.pathFlavor ||
			row.lexical !== (target.lexicalPath ?? null) ||
			row.canonical !== (target.canonicalPath ?? null) ||
			(claimed
				? row.status !== "running" || row.startedAt === null
				: (!["initializing", "pending", "running"].includes(row.status) &&
						!(observedLive && row.status === "fail")) ||
					row.startedAt !== null)
		)
			throw new Error("No-dispatch proof does not match the live host attempt");
		const actorRow = this.database
			.select({
				type: narrators.type,
				variant: narrators.variant,
				title: narrators.title,
				parent: narrators.parentNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, ctx.narratorId))
			.get();
		if (!actorRow) throw new Error("Executing narrator no longer exists");
		await boundedFileHistory(async () => {
			const sourceInstanceId = await this.initializeSourceIdentity();
			const subagent = actorRow.type === "subagent" || actorRow.variant.startsWith("subagent");
			this.evidence.beginNoDispatchOperation(
				{
					sourceInstanceId,
					sourceKind: "tool",
					sourceId: binding.toolCallId,
					toolCallId: binding.toolCallId,
					toolUseId: ctx.currentToolUseId,
					attempt: binding.attempt,
					requestDigest: hash([
						"host-no-dispatch-v1",
						binding.toolCallId,
						String(binding.attempt),
						JSON.stringify(target),
						reason,
					]),
					expectedEffectCount: 1,
					actor: {
						kind: subagent ? "subagent" : "primary",
						subjectKey: `narrator:${ctx.narratorId}`,
						narratorId: ctx.narratorId,
						userId: null,
						label: actorRow.title?.slice(0, 160) ?? null,
						deleted: false,
						parentSubjectKey: subagent && actorRow.parent ? `narrator:${actorRow.parent}` : null,
					},
					narratorId: ctx.narratorId,
					projectId: ctx.projectId,
					ownerUserId: ctx.userId,
					executionSegmentId: ctx.executionSegmentId,
					executionBinding: null,
				},
				{
					targetDispatched: false,
					reason,
					frozenTarget: {
						cwd: target.cwd,
						pathFlavor,
						lexicalPath: target.lexicalPath,
						canonicalPath: target.canonicalPath,
					},
					...(!claimed
						? {
								beforeInvocation: {
									status: row.status as "initializing" | "pending" | "running" | "fail",
									...(observedLive ? { observedStatus: observation.status } : {}),
									executionStartedAt: null as null,
								},
							}
						: {}),
				},
			);
		});
	}

	async execute(request: LocalFileChangeRequest): Promise<ToolResult> {
		request = {
			...request,
			input: request.input,
			ctx: {
				...request.ctx,
				toolCallBinding:
					request.ctx.toolCallBinding && Object.freeze({ ...request.ctx.toolCallBinding }),
				executionTarget:
					request.ctx.executionTarget && Object.freeze({ ...request.ctx.executionTarget }),
			},
		};
		const { ctx, backend } = request;
		if (request.toolName === "GenUI" && !request.exclusiveCreate)
			throw new Error("GenUI file changes require exclusive creation");
		const frozen = ctx.toolCallBinding ? this.validateCall(request) : undefined;
		if (!frozen && (request.toolName === "StructSed" || request.toolName === "GenUI"))
			throw new Error(`${request.toolName} requires a recorded tool call to write`);
		if (frozen?.row.operationId) throw new FileRequestReplayError(frozen.row.operationId);
		try {
			request.input = snapshotFileToolInput(request.input);
		} catch (error) {
			if (frozen)
				await this.recordHostNoDispatch(ctx, request.toolName, "validation_rejected", true).catch(
					() => {},
				);
			throw error;
		}
		const target =
			frozen?.target ??
			(await backend.resolvePathIdentity(backend.paths.resolve(ctx.cwd, request.filePath), {
				signal: ctx.signal,
			}));
		const runtime = frozen?.runtime ?? this.readRuntime(LOCAL_DEVICE_ID);
		if (!runtime || !target.lexicalPath || !target.canonicalPath)
			throw new Error("Local file target is unavailable");
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
		if (!actorRow && frozen) throw new Error("Executing narrator no longer exists");
		const isSubagent = actorRow?.variant.startsWith("subagent") || actorRow?.type === "subagent";
		const completed = await this.executeBound({
			backend,
			cwd: frozen?.target.cwd ?? ctx.cwd,
			lexicalPath: target.lexicalPath,
			canonicalPath: target.canonicalPath,
			runtime,
			signal: ctx.signal,
			input: request.input,
			sourceKind: "tool",
			sourceId: frozen?.row.id ?? `unbound:${randomUUID()}`,
			attempt: frozen?.row.attempt ?? 1,
			toolName: request.toolName,
			toolUseId: ctx.currentToolUseId,
			narratorId: ctx.narratorId,
			projectId: ctx.projectId,
			userId: ctx.userId,
			actor: {
				kind: isSubagent ? "subagent" : "primary",
				subjectKey: `narrator:${ctx.narratorId}`,
				narratorId: ctx.narratorId,
				userId: null,
				label: actorRow?.title?.slice(0, 160) ?? null,
				deleted: false,
				parentSubjectKey: isSubagent && actorRow?.parent ? `narrator:${actorRow.parent}` : null,
			},
			subtype: actorRow?.subtype ?? null,
			executionSegmentId: ctx.executionSegmentId ?? null,
			construct: request.construct,
			exclusiveCreate: request.exclusiveCreate,
			assertBinding: async () => {
				if (frozen) this.validateCall(request);
				await ctx.recheckAuthorization?.();
				ctx.assertFinalExecutionPermission?.();
			},
			...(frozen
				? {
						noDispatch: () =>
							this.recordHostNoDispatch(ctx, request.toolName, "validation_rejected", true),
					}
				: {}),
			...(frozen
				? {
						linkOperation: (id: string) => {
							const linked = this.database
								.update(narratorToolCalls)
								.set({ fileChangeOperationId: id })
								.where(
									and(
										eq(narratorToolCalls.id, frozen.row.id),
										eq(narratorToolCalls.executionAttempt, frozen.row.attempt),
										isNull(narratorToolCalls.fileChangeOperationId),
									),
								)
								.returning({ id: narratorToolCalls.id })
								.get();
							if (!linked) throw new FileRequestReplayError(frozen.row.id);
						},
					}
				: {}),
		});
		return {
			...completed.result,
			metadata: {
				...completed.result.metadata,
				diskOutcome: completed.diskOutcome,
				historyStatus: completed.historyStatus,
				...(completed.fileChangeEvidence
					? { fileChangeEvidence: completed.fileChangeEvidence }
					: {}),
				...(completed.fileChangeTiming ? { fileChangeTiming: completed.fileChangeTiming } : {}),
			},
		};
	}

	async executeEditor<Result>(
		request: EditorFileChangeRequest<Result>,
	): Promise<FileChangeCompletion<Result>> {
		request = Object.freeze({ ...request, input: snapshotFileToolInput(request.input) });
		if (
			request.remote &&
			(request.input.hashKind !== "raw-sha256" ||
				!Number.isSafeInteger(request.input.snapshotRevision) ||
				Number(request.input.snapshotRevision) < 0)
		)
			throw new LocalFileValidationError("Remote editor requires its raw snapshot revision");
		const runtime = request.remote?.runtime ?? this.readRuntime(LOCAL_DEVICE_ID);
		const backend = request.remote?.backend ?? localBackend;
		if (request.remote && (!request.io || request.io.deviceId !== backend.deviceId))
			throw new LocalFileValidationError(
				"Remote editor requires an explicitly device-bound IO provider",
			);
		if (!runtime || !request.requestId || !request.userId || !request.narratorId)
			throw new Error("Authenticated editor request and execution runtime required");
		if (
			![request.cwd, request.lexicalPath, request.canonicalPath].every((path) =>
				backend.paths.isAbsolute(path),
			)
		)
			throw new LocalFileValidationError("Editor requires a frozen absolute target");
		await request.authorize();
		return this.executeBound({
			...request,
			backend,
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
		});
	}

	private async executeBound<Result>(
		request: BoundFileChange<Result>,
	): Promise<FileChangeCompletion<Result>> {
		const { backend, lexicalPath, canonicalPath } = request;
		const io = request.io ?? this.io;
		if (backend.pathFlavor !== "posix" && backend.pathFlavor !== "windows")
			throw new Error("File writes require a filesystem path grammar");
		const diagnostics = new FileChangeDiagnostics();
		diagnostics.identify({ sourceId: request.sourceId });
		const startedAt = performance.now();
		let records = attempts.get(this.database);
		if (!records) {
			records = new Map();
			attempts.set(this.database, records);
		}
		const key = `${request.sourceKind}:${request.sourceId}:${request.attempt}`;
		if (records.has(key))
			throw new Error("This file request was already attempted; no mutation was retried");
		while (records.size >= MAX_ATTEMPTS) {
			const evict = [...records].find(([, item]) => !item.running)?.[0];
			if (!evict) throw new Error("Too many active file requests");
			records.delete(evict);
		}
		const summary: AttemptSummary = { running: true };
		records.set(key, summary);
		// Local writes retain only identity, replay protection and real IO metadata.
		const historyEnabled = backend.kind !== "local";
		let sourceInstanceId: string | undefined;
		let namespace: Namespace | undefined;
		let operation: FileChangeOperationRecord | undefined;
		let scope: FileChangeScopeIdentity | undefined;
		let beforeState: FileChangeState = { kind: "unknown", reason: "history_unavailable" };
		let intendedAfter: FileChangeState = { kind: "unknown", reason: "history_unavailable" };
		let historyStatus: FileHistoryStatus = historyEnabled ? "complete" : "disabled";
		let diskOutcome: FileWriteOutcome = "not_applied";
		let prepared: PreparedFileChange<Result> | undefined;
		let observed: LocalFileObservation | undefined;
		let before: LocalFileObservation | undefined;
		let error: unknown;
		let failed = false;
		let dispatched = false;
		let effect: FileChangeEffectRecord | undefined;
		let historyStage: FileHistoryStage = "initialize";
		const historyUnavailable = (cause: unknown, diagnose = true, stage = historyStage) => {
			if (historyEnabled) historyStatus = "unavailable";
			if (diagnose && historyEnabled) this.historyDiagnostics.failure(stage, cause);
			logger.warn(
				historyEnabled
					? "File history unavailable for this request"
					: "File write metadata unavailable",
				{
					sourceId: request.sourceId,
					error: String(cause),
				},
			);
		};
		try {
			const digest = await hashLocalFileChangeRequest(
				[request.toolName ?? "editor", lexicalPath, canonicalPath],
				request.input,
				request.signal,
			);
			// Identity and optional history preparation stay outside the file's IO queue.
			let initializationRejected = false;
			try {
				if (historyEnabled) {
					namespace = await boundedFileHistory(() =>
						this.initialize().catch((cause) => {
							initializationRejected = true;
							throw cause;
						}),
					);
					sourceInstanceId = namespace.sourceInstanceId;
				} else {
					sourceInstanceId = await boundedFileHistory(() => this.initializeSourceIdentity());
				}
			} catch (cause) {
				// Shared initialization failures are diagnosed by initialize(), not each waiter.
				// A request's own history budget timeout still needs a diagnostic.
				historyUnavailable(cause, !initializationRejected);
			}
			diagnostics.enter("read_before");
			await withFileWrite(
				{ deviceId: backend.deviceId, pathFlavor: backend.pathFlavor, canonicalPath },
				async () => {
					request.signal.throwIfAborted();
					await request.assertBinding();
					const footprint = request.remote
						? {
								anchor: request.cwd,
								anchorIdentity: request.remote.rootIdentity,
								ranges: [{ kind: "file" as const, canonicalPath }],
							}
						: await captureLocalWriteFootprint(canonicalPath, request.signal);
					const assertTarget = async () => {
						// Staging can outlive the initial permission check. Reauthorize immediately
						// before dispatch, but never turn caller cancellation into a false IO result.
						if (request.sourceKind === "editor" && !dispatched) await request.assertBinding();
						if (request.remote) {
							await request.remote.assertParent(AbortSignal.timeout(5_000));
							if (
								!backend.paths.contains(request.cwd, canonicalPath) ||
								backend.paths.equals(request.cwd, canonicalPath)
							)
								throw new LocalFileValidationError("Remote target escaped its authorized root");
						} else await assertLocalWriteFootprint(footprint);
						const target = await backend.resolvePathIdentity(lexicalPath);
						const current = request.remote
							? request.remote.currentRuntime()
							: this.readRuntime(backend.deviceId);
						if (
							!backend.paths.equals(target.canonicalPath, canonicalPath) ||
							target.runtimeGeneration !== request.runtime.runtimeGeneration ||
							current?.runtimeGeneration !== request.runtime.runtimeGeneration ||
							current.runtimeEpoch !== request.runtime.runtimeEpoch
						)
							throw new LocalFileValidationError("Authorized canonical path or runtime changed");
					};
					await assertTarget();
					before = await io.read(canonicalPath, request.signal);
					if (request.sourceKind === "editor") await request.assertBinding();
					if (before.mode !== null && (before.mode & 0o222) === 0)
						throw new LocalFileValidationError("File is read-only");
					diagnostics.enter("construct");
					prepared = await request.construct(before);
					if (prepared.nextBytes.byteLength > FILE_CHANGE_LIMITS.blobBytes)
						throw new LocalFileValidationError("Output exceeds the 32 MiB file limit");
					if (sourceInstanceId) {
						try {
							historyStage = "resolve_scope";
							const cwd = request.remote
								? { canonicalPath: request.cwd }
								: await boundedFileHistory((signal) =>
										backend.resolvePathIdentity(request.cwd, { signal }),
									);
							const root =
								backend.paths.contains(cwd.canonicalPath, canonicalPath) &&
								!backend.paths.equals(cwd.canonicalPath, canonicalPath)
									? cwd.canonicalPath
									: footprint.anchor;
							historyStage = "prepare_scope";
							scope = this.evidence.prepareScope({
								sourceInstanceId,
								deviceId: backend.deviceId,
								workspaceInstanceId: request.remote
									? hash([sourceInstanceId, backend.deviceId, root, request.remote.rootIdentity])
									: hash([sourceInstanceId, root]),
								canonicalRoot: root,
								pathFlavor: backend.pathFlavor as "posix" | "windows",
							});
							const input: BeginFileChangeOperation = {
								sourceInstanceId,
								sourceKind: request.sourceKind,
								sourceId: request.sourceId,
								attempt: request.attempt,
								requestDigest: digest,
								expectedEffectCount: 1,
								// Recovery returns this exact revision; NULL is never inferred later.
								editorRawSnapshotRevision:
									request.remote && request.input.hashKind === "raw-sha256"
										? Number(request.input.snapshotRevision)
										: null,
								actor: request.actor,
								executionBinding:
									request.remote || request.sourceKind === "editor"
										? {
												deviceId: backend.deviceId,
												runtimeEpoch: request.runtime.runtimeEpoch,
												runtimeGeneration: request.runtime.runtimeGeneration,
												fencingToken: request.runtime.runtimeGeneration,
											}
										: null,
								toolCallId:
									request.sourceKind === "tool" && request.linkOperation ? request.sourceId : null,
								toolUseId: request.toolUseId,
								narratorId: request.narratorId,
								projectId: request.projectId,
								ownerUserId: request.userId,
								executionSegmentId: request.executionSegmentId ?? null,
							};
							historyStage = "begin_operation";
							const allocated = this.evidence.beginOperation(input);
							if (allocated.replayed) throw new FileRequestReplayError(allocated.id);
							operation = allocated;
							summary.operationId = operation.id;
							diagnostics.identify({ operationId: operation.id });
						} catch (cause) {
							if (
								cause instanceof FileRequestReplayError ||
								(cause as { code?: string })?.code === "FILE_CHANGE_REQUEST_CONFLICT"
							)
								throw cause;
							historyUnavailable(cause);
						}
						if (operation) {
							try {
								historyStage = "link_tool";
								request.linkOperation?.(operation.id);
							} catch (cause) {
								if (cause instanceof FileRequestReplayError) throw cause;
								historyUnavailable(cause);
							}
						}
						// Without both records settlement cannot reference any blobs. Do not spend
						// quota or hold the write queue publishing history that cannot be attached.
						if (operation && scope && namespace) {
							const ns = namespace;
							let publicationStage: FileHistoryStage = "publish_before";
							try {
								const capturedBefore = before;
								const capturedPrepared = prepared;
								const states = await boundedFileHistory(async (signal) => {
									const publishedBefore = await this.publish(ns, capturedBefore, signal);
									publicationStage = "publish_intended_after";
									const publishedAfter = await this.publish(
										ns,
										{
											bytes: capturedPrepared.nextBytes,
											mode:
												capturedBefore.mode ??
												(request.exclusiveCreate && process.platform !== "win32" ? 0o600 : 0o666) &
													~process.umask(),
											identity: null,
										},
										signal,
									);
									return [publishedBefore, publishedAfter];
								});
								[beforeState, intendedAfter] = states;
							} catch (cause) {
								historyUnavailable(cause, true, publicationStage);
							}
						}
					}
					request.signal.throwIfAborted();
					await request.assertBinding();
					diagnostics.enter("apply_adapter");
					const execution = await applyLocalFileChange(
						io,
						{
							editor:
								request.sourceKind === "editor"
									? {
											sourceId: request.sourceId,
											userId: request.userId as string,
											sourceInstanceId,
											operationId: operation?.id,
											snapshotRevision: Number(request.input.snapshotRevision),
											requestDigest: digest,
											root: request.cwd,
											rootIdentity: request.remote?.rootIdentity,
											runtime: request.runtime,
											rawDigest: prepared.rawDigest,
											beforeRawDigest: prepared.beforeRawDigest,
										}
									: undefined,
							backend,
							lexicalPath,
							canonicalPath,
							before,
							nextBytes: prepared.nextBytes,
							exclusiveCreate: request.exclusiveCreate,
							signal: request.signal,
							assertTarget,
							diagnostics,
							onDispatch: () => {
								dispatched = true;
							},
						},
						footprint,
					);
					diskOutcome = execution.receiptOutcome;
					if (
						execution.result.kind === "not_applied" &&
						execution.result.error instanceof LocalFileValidationError
					)
						diskOutcome = "conflict";
					observed = execution.result.observedAfter;
					// A remote terminal receipt is the executor's durable proof of the target bytes.
					// Re-reading up to 20 MiB over RPC adds no evidence, only an "unknown" path.
					const receipt = execution.result.editorReceipt;
					if (!observed && request.remote && receipt && receipt.outcome !== "uncertain")
						observed =
							receipt.outcome === "committed"
								? { bytes: prepared.nextBytes, mode: intendedMode(intendedAfter), identity: null }
								: before;
					// A legacy/injected local adapter may omit its observation; only that case rereads.
					// A remote unknown outcome stays unknown: current bytes never prove a save, and
					// only the executor's exact-op query may settle it later.
					if (!observed && !request.remote) {
						try {
							historyStage = "read_after";
							observed = await io.read(canonicalPath, AbortSignal.timeout(5_000));
						} catch (cause) {
							historyUnavailable(cause);
						}
					}
					if (
						diskOutcome === "applied" &&
						(!observed?.bytes || !Buffer.from(observed.bytes).equals(prepared.nextBytes))
					) {
						if (execution.result.editorReceipt?.outcome === "committed") {
							historyStage = "verify_after";
							historyUnavailable(
								new Error("Provider committed; current bytes could not be verified for history"),
							);
						} else diskOutcome = "unknown";
					}
					if (diskOutcome !== "applied") {
						failed = true;
						error = execution.result.error ?? new Error("File write outcome is unknown");
					}
				},
				{ signal: request.signal },
			);
		} catch (cause) {
			failed = true;
			error = cause;
			if (cause instanceof LocalFileValidationError) diskOutcome = "conflict";
		} finally {
			// All metadata settlement runs after withFileWrite has released the target.
			if (operation && scope) {
				try {
					let observedAfter: FileChangeState = {
						kind: "unknown",
						reason: historyEnabled ? "missing_after" : "history_unavailable",
					};
					if (
						observed &&
						prepared &&
						observed.bytes !== null &&
						Buffer.from(observed.bytes).equals(prepared.nextBytes) &&
						stateModeMatches(intendedAfter, observed.mode)
					)
						observedAfter = intendedAfter;
					else if (observed && before && sameObservedBytes(observed, before))
						observedAfter = beforeState;
					else if (observed && namespace) {
						const ns = namespace;
						const captured = observed;
						historyStage = "publish_observed_after";
						observedAfter = await boundedFileHistory((signal) =>
							this.publish(ns, captured, signal),
						);
					}
					historyStage = "record_effect";
					effect = this.evidence.recordEffect({
						operationId: operation.id,
						identity: createFileChangeIdentity(scope, {
							deviceId: backend.deviceId,
							pathFlavor: backend.pathFlavor as "posix" | "windows",
							canonicalPath,
							lexicalPath,
							objectRole: "referent",
						}),
						before: beforeState,
						intendedAfter,
						observedAfter,
						outcome: diskOutcome === "conflict" ? "not_applied" : diskOutcome,
						linesAdded: prepared?.lineStats?.added,
						linesRemoved: prepared?.lineStats?.removed,
					});
					historyStage = "finish_operation";
					this.evidence.finishOperation(
						operation.id,
						(diskOutcome as FileWriteOutcome) === "applied"
							? "succeeded"
							: request.signal.aborted
								? "interrupted"
								: "failed",
					);
					if (effect.outcome !== "no_change") {
						historyStage = "project_effect";
						this.project(request, operation, effect, scope);
					}
				} catch (cause) {
					historyUnavailable(cause);
				}
			} else {
				if (historyEnabled) historyStatus = "unavailable";
				if (
					!dispatched &&
					failed &&
					request.noDispatch &&
					!(error instanceof FileRequestReplayError)
				) {
					try {
						historyStage = "record_no_dispatch";
						await boundedFileHistory(() => request.noDispatch?.() ?? Promise.resolve());
					} catch (cause) {
						historyUnavailable(cause);
					}
				}
			}
			summary.running = false;
			summary.diskOutcome = diskOutcome;
			summary.historyStatus = historyStatus;
			diagnostics.finish();
			if (performance.now() - startedAt > 1000)
				logger.warn("Slow file write", {
					sourceId: request.sourceId,
					diskOutcome,
					historyStatus,
					diagnostics: diagnostics.snapshot(),
				});
		}
		if (failed) {
			if ((diskOutcome as FileWriteOutcome) === "unknown" && request.sourceKind === "editor")
				throw new EditorFileChangeUncertainError(operation?.id, error, historyStatus);
			if (error && typeof error === "object") Object.assign(error, { diskOutcome, historyStatus });
			throw diagnostics.attach(error);
		}
		if (!prepared) throw new Error("File writer did not construct a result");
		return {
			result: prepared.result,
			diskOutcome,
			historyStatus,
			fileChangeTiming: diagnostics.timing(),
			linesAdded: prepared.lineStats?.added ?? null,
			linesRemoved: prepared.lineStats?.removed ?? null,
			...(operation && effect
				? {
						fileChangeEvidence: {
							version: 3 as const,
							operationId: operation.id,
							effectId: effect.id,
							grade: effect.attributionGrade,
							settlement: effect.settlement,
							outcome: effect.outcome,
						},
					}
				: {}),
		};
	}

	private async publish(
		namespace: Namespace,
		observed: LocalFileObservation,
		signal: AbortSignal,
	): Promise<FileChangeState> {
		if (observed.bytes === null) return { kind: "absent" };
		const blob = await namespace.store.putBytes(observed.bytes, {
			expectedSize: observed.bytes.byteLength,
			signal,
		});
		return { kind: "regular", blob, mode: observed.mode };
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
					deviceId: scope.deviceId,
					workspacePath: scope.canonicalRoot,
					filePath: effect.identityJson.displayPath,
					narratorId: request.sourceKind === "editor" ? null : request.narratorId,
					userId: request.actor.userId,
					subagentType: request.subtype,
					action:
						request.sourceKind === "editor"
							? "human"
							: request.toolName === "Write" || request.toolName === "GenUI"
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

export function fileWriteOutcomeMetadata(error: unknown): Record<string, unknown> {
	if (!error || typeof error !== "object") return {};
	const value = error as { diskOutcome?: FileWriteOutcome; historyStatus?: FileHistoryStatus };
	return {
		...(value.diskOutcome ? { diskOutcome: value.diskOutcome } : {}),
		...(value.historyStatus ? { historyStatus: value.historyStatus } : {}),
	};
}

class FileRequestReplayError extends Error {
	constructor(id: string) {
		super(`File operation ${id} was already attempted; no mutation was retried`);
	}
}

export async function boundedFileHistory<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			body(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const error = new Error("File history preparation budget exceeded");
					attachFileHistoryBudgetDiagnostic(error);
					controller.abort(error);
					reject(error);
				}, HISTORY_BUDGET_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function sameObservedBytes(left: LocalFileObservation, right: LocalFileObservation): boolean {
	return (
		left.mode === right.mode &&
		(left.bytes === null
			? right.bytes === null
			: right.bytes !== null && Buffer.from(left.bytes).equals(right.bytes))
	);
}
const runtimeContext = hotSafe(
	"narrafork.local-file-change-runtime.context.v1",
	() => new AsyncLocalStorage<LocalFileChangeRuntime>(),
);

/** Scoped dependency injection for real tool tests; no global DB or production runtime reset. */
export function withLocalFileChangeRuntime<T>(runtime: LocalFileChangeRuntime, body: () => T): T {
	return runtimeContext.run(runtime, body);
}

let defaultRuntime: LocalFileChangeRuntime | undefined;

/** A local history failure, separate from the tool's actual execution outcome. */
export class FileNoDispatchEvidenceError extends Error {
	constructor(cause: unknown) {
		super("Failed to persist trusted no-dispatch evidence", { cause });
		this.name = "FileNoDispatchEvidenceError";
	}
}

interface FileToolDispatchControl {
	/** Called BEFORE any IO or ordinary intent can be dispatched. */
	writing(): void;
	/** The runtime explicitly returned without invoking IO (legacy/remote eligibility decline). */
	declined(): void;
	/** A successful read-only branch returned without attempting a write. */
	preview(): void;
	/** Internal approval UI rendering is not an executed tool attempt. */
	suppressEvidence(): void;
}

export function withFileHistoryNotice(result: ToolResult, locale?: string): ToolResult {
	if (
		result.isError ||
		result.metadata?.diskOutcome !== "applied" ||
		result.metadata?.historyStatus !== "unavailable"
	)
		return result;
	const notice =
		locale === "zh-CN"
			? "文件已保存；本次文件历史不可用。"
			: "File saved; history is unavailable for this operation.";
	return { ...result, output: `${result.output}\n\n${notice}` };
}

/** Share the control-flow fence without nesting/reindenting each tool's entire implementation. */
export function withFileToolNoDispatch(
	toolName: FileChangeToolName,
	body: (
		args: Record<string, unknown>,
		ctx: ToolContext,
		control: FileToolDispatchControl,
	) => Promise<ToolResult>,
): ToolDefinition["execute"] {
	return async (args, ctx) => {
		ctx = {
			...ctx,
			toolCallBinding: ctx.toolCallBinding && Object.freeze({ ...ctx.toolCallBinding }),
			executionTarget: ctx.executionTarget && Object.freeze({ ...ctx.executionTarget }),
		};
		let remoteAttempt: { running: boolean } | undefined;
		let result: ToolResult | undefined;
		const record = createFileToolNoDispatchRecorder(ctx, toolName);
		let writing = false;
		let suppressed = false;
		let reason: "validation_rejected" | "preview" = "validation_rejected";
		try {
			result = await body(args, ctx, {
				writing: () => {
					writing = true;
					if (
						ctx.executionTarget?.backendKind === "remote" &&
						ctx.toolCallBinding &&
						!remoteAttempt
					) {
						const key = `${ctx.toolCallBinding.toolCallId}:${ctx.toolCallBinding.attempt}`;
						if (remoteAttempts.has(key)) throw new FileRequestReplayError(key);
						while (remoteAttempts.size >= MAX_ATTEMPTS) {
							const evict = [...remoteAttempts].find(([, item]) => !item.running)?.[0];
							if (!evict) throw new Error("Too many active remote file requests");
							remoteAttempts.delete(evict);
						}
						remoteAttempt = { running: true };
						remoteAttempts.set(key, remoteAttempt);
					}
					writing = true;
				},
				declined: () => {
					writing = false;
				},
				preview: () => {
					reason = "preview";
				},
				suppressEvidence: () => {
					suppressed = true;
				},
			});
			if (!writing && ctx.executionTarget?.backendKind === "local")
				result.metadata = { ...result.metadata, historyStatus: "disabled" };
			return withFileHistoryNotice(result, ctx.locale);
		} finally {
			if (remoteAttempt) remoteAttempt.running = false;
			if (!writing && !suppressed) {
				try {
					await boundedFileHistory(() => record(reason));
				} catch (error) {
					if (result)
						result.metadata = {
							...result.metadata,
							historyStatus:
								ctx.executionTarget?.backendKind === "local" ? "disabled" : "unavailable",
						};
					logger.warn("Host no-dispatch history unavailable", { toolName, error: String(error) });
				}
			}
		}
	};
}

/** Freeze the host assertion identity before the tool's first await. */
export function createFileToolNoDispatchRecorder(
	ctx: ToolContext,
	toolName: FileChangeToolName,
): (reason: "validation_rejected" | "preview") => Promise<void> {
	const frozen: ToolContext = {
		...ctx,
		toolCallBinding: ctx.toolCallBinding && Object.freeze({ ...ctx.toolCallBinding }),
		executionTarget: ctx.executionTarget && Object.freeze({ ...ctx.executionTarget }),
	};
	return (reason) => recordFileToolNoDispatch(frozen, toolName, reason);
}

/** Called by trusted tools BEFORE crossing any file-writing/intent boundary. */
export async function recordFileToolNoDispatch(
	ctx: ToolContext,
	toolName: FileChangeToolName,
	reason: "validation_rejected" | "preview",
): Promise<void> {
	if (!ctx.toolCallBinding || !ctx.executionTarget || ctx.executionTarget.pathFlavor === "spec")
		return;
	try {
		if (ctx.recordFileNoDispatch) await ctx.recordFileNoDispatch(reason);
		else await (await currentRuntime()).recordHostNoDispatch(ctx, toolName, reason, true);
	} catch (cause) {
		throw new FileNoDispatchEvidenceError(cause);
	}
}

export async function assertLocalFileChangeAdmission(
	request: Pick<LocalFileChangeRequest, "ctx" | "backend" | "toolName" | "filePath">,
): Promise<void> {
	if (request.backend.kind !== "local") return;
	(await currentRuntime()).assertAdmission(request);
}

export async function executeLocalFileChange(
	request: LocalFileChangeRequest,
): Promise<ToolResult | undefined> {
	if (request.backend.kind !== "local") return undefined;
	return (await currentRuntime()).execute(request);
}

/** The authenticated editor uses the same single-file IO path as tools. */
export async function executeEditorFileChange<Result>(
	request: EditorFileChangeRequest<Result>,
): Promise<FileChangeCompletion<Result>> {
	return (await currentRuntime()).executeEditor(request);
}

async function currentRuntime(): Promise<LocalFileChangeRuntime> {
	return runtimeContext.getStore() ?? getDefaultLocalFileChangeRuntime();
}

/** Shared runtime for local tool and editor writes. */
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

/** Application-private backup provenance only; never an authorization credential. */
export async function readOrInitializeFileChangeSourceInstanceId(): Promise<string> {
	const root = getNarraforkHome();
	await requireApplicationDataDirectory(root);
	return persistentSourceId(root);
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

/** The intended mode, so a receipt-proven observation never reports a spurious mode change. */
function intendedMode(state: FileChangeState): number | null {
	return state.kind === "regular" ? state.mode : null;
}
function stateModeMatches(state: FileChangeState, mode: number | null): boolean {
	return state.kind !== "regular" || state.mode === mode;
}
