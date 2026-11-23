import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	type ReadQueryOptions,
	readDomainTask,
	readQuery,
	readQueryFirst,
} from "@server/db/worker-read";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeExecutionBinding,
	type FileChangeExecutionOutcome,
	type FileChangeIdentity,
	type FileChangeMutationPhase,
	type FileChangeSettlement,
	type FileChangeState,
	type FileWriteOutcome,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileHistoryClock,
	narratorToolCalls,
} from "../db/schema";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
	fileChangeIdentityKey,
} from "./file-change-identity";

type Executor = Pick<BunSQLiteDatabase, "select" | "insert" | "update">;
type EvidenceDatabase = Executor & {
	$client: Database;
	transaction<T>(work: (tx: Executor) => T): T;
};
export type FileChangeScopeRecord = typeof fileChangeScopes.$inferSelect;
export type FileChangeOperationRecord = typeof fileChangeOperations.$inferSelect;
export type FileChangeEffectRecord = typeof fileChangeEffects.$inferSelect;
export type BeginFileChangeOperationResult = FileChangeOperationRecord & { replayed: boolean };
type PendingSettlement = Exclude<FileChangeSettlement, "settled">;

export interface PrepareFileChangeScope extends Omit<FileChangeScopeIdentity, "id"> {
	id?: string;
	displayRoot?: string;
}

export interface BeginFileChangeOperation {
	sourceInstanceId: string;
	sourceKind: FileChangeOperationRecord["sourceKind"];
	/** Actual tool-call/request/task identity; provider toolUseId alone is insufficient. */
	sourceId: string;
	attempt: number;
	requestDigest: string;
	expectedEffectCount: number;
	/** Editor raw-v2 save only: the snapshot revision returned on recovery. */
	editorRawSnapshotRevision?: number | null;
	actor: FileChangeActor;
	/** Historical routing metadata, never a write permit. */
	executionBinding?: FileChangeExecutionBinding | null;
	toolCallId?: string | null;
	toolUseId?: string | null;
	backgroundTaskId?: string | null;
	narratorId?: string | null;
	projectId?: string | null;
	ownerUserId?: string | null;
	initiatorSubjectKey?: string | null;
	parentOperationId?: string | null;
	executionSegmentId?: string | null;
}

export interface FileChangeNoDispatchProof {
	targetDispatched: false;
	reason: "validation_rejected" | "cancelled_before_dispatch" | "preview" | "invocation_rejected";
	beforeInvocation?: {
		status: "initializing" | "pending" | "running" | "fail";
		observedStatus?: "initializing" | "pending" | "running";
		executionStartedAt: null;
	};
	frozenTarget?: {
		cwd: string;
		pathFlavor: string;
		lexicalPath?: string;
		canonicalPath?: string;
	};
}

export interface RecordFileChangeEffect {
	operationId: string;
	identity: FileChangeIdentity;
	before: FileChangeState;
	intendedAfter: FileChangeState;
	observedAfter: FileChangeState;
	outcome: Exclude<FileWriteOutcome, "conflict">;
	linesAdded?: number | null;
	linesRemoved?: number | null;
}

export interface FileChangeOperationCursor {
	updatedAt: string;
	id: string;
}
export interface FileChangeEffectCursor {
	fileKey: string;
	phase: FileChangeMutationPhase;
}
export interface FileChangeEvidencePage<T, C> {
	items: T[];
	hasMore: boolean;
	nextCursor: C | null;
}

export class FileChangeEvidenceError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `FILE_CHANGE_${code}`);
		this.name = "FileChangeEvidenceError";
	}
}

/**
 * Final historical facts only. The authorized caller owns IO and path checks.
 * Every public lookup requires authorization of its owning resource: IDs and
 * digests are not capabilities. Legacy rows are readable and never repaired here.
 * SQLite transactions contain bounded synchronous metadata SQL, never file IO.
 */
export class FileChangeEvidenceService {
	constructor(
		private readonly database: EvidenceDatabase,
		private readonly now: () => string = () => new Date().toISOString(),
	) {
		if (!database.$client)
			throw fail("DURABILITY_BOUNDARY", "A root SQLite connection is required");
	}

	private transaction<T>(work: (tx: Executor) => T): T {
		if (this.database.$client.inTransaction)
			throw fail("DURABILITY_BOUNDARY", "History writes require their own short transaction");
		return this.database.transaction(work);
	}

	prepareScope(input: PrepareFileChangeScope): FileChangeScopeRecord {
		const values = normalizeScope(input);
		return this.transaction((tx) => {
			const existing = tx
				.select()
				.from(fileChangeScopes)
				.where(
					and(
						eq(fileChangeScopes.sourceInstanceId, values.sourceInstanceId),
						eq(fileChangeScopes.deviceId, values.deviceId),
						eq(fileChangeScopes.workspaceInstanceId, values.workspaceInstanceId),
					),
				)
				.get();
			if (existing) {
				assertScopeMetadata(existing, input, values);
				return existing;
			}
			const timestamp = this.now();
			return boundedRecord(
				tx
					.insert(fileChangeScopes)
					.values({
						...values,
						id: input.id ?? generateId(),
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.returning()
					.get(),
			);
		});
	}

	beginOperation(input: BeginFileChangeOperation): BeginFileChangeOperationResult {
		const values = normalizeOperation(input);
		return this.transaction((tx) => {
			const existing = tx
				.select()
				.from(fileChangeOperations)
				.where(operationIdentity(values))
				.get();
			if (existing) {
				assertOperationReplay(existing, values);
				return { ...existing, replayed: true };
			}
			const timestamp = this.now();
			const row = boundedRecord(
				tx
					.insert(fileChangeOperations)
					.values({
						...values,
						id: generateId(),
						journalSeq: nextJournalSeq(tx),
						startedAt: timestamp,
						updatedAt: timestamp,
					})
					.returning()
					.get(),
			);
			return { ...row, replayed: false };
		});
	}

	/** Records trusted host control flow; matching bytes never establish no-dispatch. */
	beginNoDispatchOperation(
		input: BeginFileChangeOperation,
		proof: FileChangeNoDispatchProof,
	): FileChangeOperationRecord {
		const { values, terminal } = normalizeNoDispatch(input, proof);
		return this.transaction((tx) => {
			const tool = tx
				.select(noDispatchToolColumns)
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, values.sourceId))
				.get();
			assertNoDispatchTool(tool, input, proof);
			const existing = tx
				.select()
				.from(fileChangeOperations)
				.where(operationIdentity(values))
				.get();
			if (existing) {
				assertNoDispatchReplay(existing, tool, values, terminal);
				if (
					tx
						.select({ id: fileChangeEffects.id })
						.from(fileChangeEffects)
						.where(eq(fileChangeEffects.operationId, existing.id))
						.limit(1)
						.get()
				)
					throw fail("REQUEST_CONFLICT", "No-dispatch history cannot contain effects");
				return existing;
			}
			assertNoDispatchLive(tool, proof);
			const timestamp = this.now();
			const recorded = boundedRecord(
				tx
					.insert(fileChangeOperations)
					.values({
						...values,
						...terminal,
						id: generateId(),
						journalSeq: nextJournalSeq(tx),
						startedAt: timestamp,
						finishedAt: timestamp,
						updatedAt: timestamp,
					})
					.returning()
					.get(),
			);
			const linked = tx
				.update(narratorToolCalls)
				.set({
					fileChangeOperationId: recorded.id,
					...(proof.beforeInvocation ? { status: "fail" as const } : {}),
				})
				.where(
					and(
						eq(narratorToolCalls.id, tool.id),
						eq(narratorToolCalls.executionAttempt, values.attempt),
						eq(narratorToolCalls.status, tool.status),
						tool.startedAt === null
							? isNull(narratorToolCalls.executionStartedAt)
							: eq(narratorToolCalls.executionStartedAt, tool.startedAt),
						tool.deviceId === null
							? isNull(narratorToolCalls.executionDeviceId)
							: eq(narratorToolCalls.executionDeviceId, tool.deviceId),
						tool.generation === null
							? isNull(narratorToolCalls.runtimeGeneration)
							: eq(narratorToolCalls.runtimeGeneration, tool.generation),
						isNull(narratorToolCalls.fileChangeOperationId),
					),
				)
				.returning({ id: narratorToolCalls.id })
				.get();
			if (!linked)
				throw fail("REQUEST_CONFLICT", "Tool attempt was already linked to other history");
			return recorded;
		});
	}

	/** Called after actual IO. There is no durable permission/preparation state machine. */
	recordEffect(input: RecordFileChangeEffect): FileChangeEffectRecord {
		const normalized = normalizeEffect(input);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, input.operationId);
			assertCurrentOperation(operation);
			const values = effectValues(operation, normalized);
			const existing = tx
				.select()
				.from(fileChangeEffects)
				.where(eq(fileChangeEffects.mutationId, values.mutationId))
				.get();
			if (existing) {
				assertEffectReplay(existing, values);
				return existing;
			}
			if (operation.preparedEffectCount >= operation.expectedEffectCount)
				throw fail("BUDGET_EXCEEDED", "Operation already has its expected file results");
			const scope = tx
				.select()
				.from(fileChangeScopes)
				.where(eq(fileChangeScopes.id, input.identity.scopeId))
				.get();
			assertEffectScope(scope, operation, normalized.identity);
			for (const state of [normalized.before, normalized.intendedAfter, normalized.observedAfter]) {
				const ref = stateBlob(state);
				if (!ref) continue;
				const blob = tx
					.select({ sizeBytes: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
					.from(fileChangeBlobs)
					.where(eq(fileChangeBlobs.digest, ref.digest))
					.get();
				assertBlobMetadata(blob, ref);
			}
			const timestamp = this.now();
			const effect = boundedRecord(
				tx
					.insert(fileChangeEffects)
					.values({
						...values,
						id: generateId(),
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.returning()
					.get(),
			);
			const counts = recordedCounts(operation, normalized);
			const updated = { ...operation, ...counts };
			tx.update(fileChangeOperations)
				.set({
					...counts,
					...operationAggregate(updated, outcomeFlags(tx, operation.id)),
					updatedAt: timestamp,
				})
				.where(eq(fileChangeOperations.id, operation.id))
				.run();
			return effect;
		});
	}

	finishOperation(
		operationId: string,
		outcome: Exclude<FileChangeExecutionOutcome, "running">,
	): FileChangeOperationRecord {
		assertString(operationId, "operationId");
		assertTerminalOutcome(outcome);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, operationId);
			assertCurrentOperation(operation);
			if (operation.executionOutcome !== "running") {
				if (operation.executionOutcome !== outcome)
					throw fail("REQUEST_CONFLICT", "A terminal execution result is immutable");
				return operation;
			}
			return boundedRecord(
				tx
					.update(fileChangeOperations)
					.set({
						...operationAggregate(
							{ ...operation, executionOutcome: outcome },
							outcomeFlags(tx, operationId),
						),
						executionOutcome: outcome,
						finishedAt: this.now(),
						updatedAt: this.now(),
					})
					.where(eq(fileChangeOperations.id, operationId))
					.returning()
					.get(),
			);
		});
	}

	async getScope(
		scopeId: string,
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	): Promise<FileChangeScopeRecord | null> {
		assertString(scopeId, "scopeId");
		return (
			(await readQueryFirst(
				this.database
					.select()
					.from(fileChangeScopes)
					.where(eq(fileChangeScopes.id, scopeId))
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			)) ?? null
		);
	}
	async getOperation(
		operationId: string,
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	): Promise<FileChangeOperationRecord | null> {
		assertString(operationId, "operationId");
		return (
			(await readQueryFirst(
				this.database
					.select()
					.from(fileChangeOperations)
					.where(eq(fileChangeOperations.id, operationId))
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			)) ?? null
		);
	}

	/** Unique installation/editor/request/attempt lookup; never a journal scan. */
	async getEditorOperation(
		sourceInstanceId: string,
		sourceId: string,
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	): Promise<FileChangeOperationRecord | null> {
		assertString(sourceInstanceId, "sourceInstanceId");
		assertString(sourceId, "sourceId");
		return (
			(await readQueryFirst(
				this.database
					.select()
					.from(fileChangeOperations)
					.where(
						and(
							eq(fileChangeOperations.sourceInstanceId, sourceInstanceId),
							eq(fileChangeOperations.sourceKind, "editor"),
							eq(fileChangeOperations.sourceId, sourceId),
							eq(fileChangeOperations.attempt, 1),
						),
					)
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			)) ?? null
		);
	}

	async getEffect(
		operationId: string,
		mutationId: string,
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	): Promise<FileChangeEffectRecord | null> {
		assertString(operationId, "operationId");
		assertString(mutationId, "mutationId");
		return (
			(await readQueryFirst(
				this.database
					.select()
					.from(fileChangeEffects)
					.where(
						and(
							eq(fileChangeEffects.operationId, operationId),
							eq(fileChangeEffects.mutationId, mutationId),
						),
					)
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			)) ?? null
		);
	}
	async listEffects(
		operationId: string,
		options: { cursor?: FileChangeEffectCursor; limit?: number } & Pick<
			ReadQueryOptions,
			"signal" | "timeoutMs" | "deadlineAt"
		> = {},
	): Promise<FileChangeEvidencePage<FileChangeEffectRecord, FileChangeEffectCursor>> {
		assertString(operationId, "operationId");
		const limit = pageLimit(options.limit);
		validateEffectCursor(options.cursor);
		const cursor = options.cursor;
		const rows = await readQuery(
			this.database
				.select()
				.from(fileChangeEffects)
				.where(
					and(
						eq(fileChangeEffects.operationId, operationId),
						cursor
							? sql`(${fileChangeEffects.fileKey}, ${fileChangeEffects.phase}) > (${cursor.fileKey}, ${cursor.phase})`
							: undefined,
					),
				)
				.orderBy(asc(fileChangeEffects.fileKey), asc(fileChangeEffects.phase))
				.limit(limit + 1),
			{
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				deadlineAt: options.deadlineAt,
				executionPolicy: "worker-required",
				maxRows: limit + 1,
			},
		);
		return boundedPage(rows, limit, effectCursor);
	}

	/** Read-only inventory, including legacy pending rows. Never resumes an old write. */
	async listPendingOperations(
		options: {
			settlement: PendingSettlement;
			cursor?: FileChangeOperationCursor;
			limit?: number;
		} & Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt">,
	) {
		validatePendingPage(options);
		const limit = pageLimit(options.limit);
		const c = options.cursor;
		const rows = await readQuery(
			this.database
				.select({
					id: fileChangeOperations.id,
					sourceInstanceId: fileChangeOperations.sourceInstanceId,
					sourceKind: fileChangeOperations.sourceKind,
					sourceId: fileChangeOperations.sourceId,
					attempt: fileChangeOperations.attempt,
					requestDigest: fileChangeOperations.requestDigest,
					projectId: fileChangeOperations.projectId,
					narratorId: fileChangeOperations.narratorId,
					ownerUserId: fileChangeOperations.ownerUserId,
					expectedEffectCount: fileChangeOperations.expectedEffectCount,
					preparedEffectCount: fileChangeOperations.preparedEffectCount,
					settledEffectCount: fileChangeOperations.settledEffectCount,
					unresolvedEffectCount: fileChangeOperations.unresolvedEffectCount,
					evidenceBytes: fileChangeOperations.evidenceBytes,
					settlement: fileChangeOperations.settlement,
					executionOutcome: fileChangeOperations.executionOutcome,
					effectOutcome: fileChangeOperations.effectOutcome,
					coverage: fileChangeOperations.coverage,
					attributionGrade: fileChangeOperations.attributionGrade,
					reason: fileChangeOperations.reason,
					updatedAt: fileChangeOperations.updatedAt,
				})
				.from(fileChangeOperations)
				.where(
					and(
						eq(fileChangeOperations.settlement, options.settlement),
						c
							? sql`(${fileChangeOperations.updatedAt}, ${fileChangeOperations.id}) > (${c.updatedAt}, ${c.id})`
							: undefined,
					),
				)
				.orderBy(asc(fileChangeOperations.updatedAt), asc(fileChangeOperations.id))
				.limit(limit + 1),
			{
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				deadlineAt: options.deadlineAt,
				executionPolicy: "worker-required",
				maxRows: limit + 1,
			},
		);
		return boundedPage(rows, limit, (row) => ({ updatedAt: row.updatedAt, id: row.id }));
	}
	async getEditorSnapshot(
		sourceInstanceId: string,
		sourceId: string,
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	) {
		assertString(sourceInstanceId, "sourceInstanceId");
		assertString(sourceId, "sourceId");
		return readDomainTask(
			this.database.$client,
			"editorOperationEvidence",
			{ sourceInstanceId, sourceId },
			{ ...options, executionPolicy: "worker-required" },
		);
	}
}

const noDispatchToolColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	version: narratorToolCalls.executionIdentityVersion,
	origin: narratorToolCalls.executionOriginToolCallId,
	checkpoint: narratorToolCalls.isFileHistoryCheckpoint,
	attempt: narratorToolCalls.executionAttempt,
	status: narratorToolCalls.status,
	startedAt: narratorToolCalls.executionStartedAt,
	deviceId: narratorToolCalls.executionDeviceId,
	generation: narratorToolCalls.runtimeGeneration,
	cwd: narratorToolCalls.executionCwd,
	pathFlavor: narratorToolCalls.executionPathFlavor,
	lexicalPath: narratorToolCalls.resolvedFilePath,
	canonicalPath: narratorToolCalls.canonicalFilePath,
	operationId: narratorToolCalls.fileChangeOperationId,
};
type ToolRow = typeof narratorToolCalls.$inferSelect;
export type NoDispatchTool = {
	id: ToolRow["id"];
	narratorId: ToolRow["narratorId"];
	toolUseId: ToolRow["toolUseId"];
	toolName: ToolRow["toolName"];
	version: ToolRow["executionIdentityVersion"];
	origin: ToolRow["executionOriginToolCallId"];
	checkpoint: ToolRow["isFileHistoryCheckpoint"];
	attempt: ToolRow["executionAttempt"];
	status: ToolRow["status"];
	startedAt: ToolRow["executionStartedAt"];
	deviceId: ToolRow["executionDeviceId"];
	generation: ToolRow["runtimeGeneration"];
	cwd: ToolRow["executionCwd"];
	pathFlavor: ToolRow["executionPathFlavor"];
	lexicalPath: ToolRow["resolvedFilePath"];
	canonicalPath: ToolRow["canonicalFilePath"];
	operationId: ToolRow["fileChangeOperationId"];
};

function operationIdentity(input: ReturnType<typeof normalizeOperation>): SQL {
	return and(
		eq(fileChangeOperations.sourceInstanceId, input.sourceInstanceId),
		eq(fileChangeOperations.sourceKind, input.sourceKind),
		eq(fileChangeOperations.sourceId, input.sourceId),
		eq(fileChangeOperations.attempt, input.attempt),
	) as SQL;
}
function nextJournalSeq(tx: Executor): number {
	tx.insert(fileHistoryClock).values({ id: 1, lastSeq: 0 }).onConflictDoNothing().run();
	const clock = tx
		.update(fileHistoryClock)
		.set({ lastSeq: sql`${fileHistoryClock.lastSeq} + 1` })
		.where(eq(fileHistoryClock.id, 1))
		.returning({ lastSeq: fileHistoryClock.lastSeq })
		.get();
	if (!clock) throw fail("JOURNAL_UNAVAILABLE", "File history clock is unavailable");
	return clock.lastSeq;
}
function requireOperation(tx: Executor, id: string): FileChangeOperationRecord {
	const row = tx.select().from(fileChangeOperations).where(eq(fileChangeOperations.id, id)).get();
	if (!row) throw fail("NOT_FOUND", "File-change operation not found");
	return row;
}
function outcomeFlags(tx: Executor, operationId: string) {
	const exists = (condition: SQL) =>
		tx
			.select({ id: fileChangeEffects.id })
			.from(fileChangeEffects)
			.where(and(eq(fileChangeEffects.operationId, operationId), condition))
			.limit(1)
			.get() !== undefined;
	return {
		changed: exists(eq(fileChangeEffects.outcome, "changed")),
		unknown: exists(eq(fileChangeEffects.outcome, "unknown")),
		unmeasured: exists(eq(fileChangeEffects.attributionGrade, "unknown")),
	};
}
function operationAggregate(
	operation: FileChangeOperationRecord,
	flags: { changed: boolean; unknown: boolean; unmeasured: boolean },
): Pick<
	FileChangeOperationRecord,
	"settlement" | "effectOutcome" | "attributionGrade" | "coverage" | "reason"
> {
	const complete =
		operation.expectedEffectCount !== null &&
		operation.preparedEffectCount === operation.expectedEffectCount;
	const terminal = operation.executionOutcome !== "running";
	return {
		settlement: terminal ? "settled" : "preparing",
		effectOutcome:
			flags.unknown || (terminal && !complete)
				? "unknown"
				: flags.changed
					? "changed"
					: complete
						? "no_change"
						: "pending",
		attributionGrade: complete && !flags.unmeasured ? "measured" : "unknown",
		coverage: complete ? "complete" : operation.preparedEffectCount ? "partial" : "unavailable",
		reason: terminal && !complete ? "history_unavailable" : flags.unknown ? "result_unknown" : null,
	};
}
function normalizeScope(input: PrepareFileChangeScope) {
	for (const key of ["sourceInstanceId", "deviceId", "workspaceInstanceId"] as const)
		assertString(input[key], key);
	if (input.id !== undefined) assertString(input.id, "scopeId");
	if (input.pathFlavor !== "posix" && input.pathFlavor !== "windows")
		throw fail("INVALID_INPUT", "Explicit disk path flavor required");
	assertString(input.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
	const paths = targetPathSemantics(input.pathFlavor);
	if (!paths.isAbsolute(input.canonicalRoot))
		throw fail("INVALID_INPUT", "Scope root must be absolute on its device");
	const displayRoot = input.displayRoot ?? input.canonicalRoot;
	assertString(displayRoot, "displayRoot", FILE_CHANGE_LIMITS.metadataBytes);
	return boundedRecord({
		sourceInstanceId: input.sourceInstanceId,
		deviceId: input.deviceId,
		workspaceInstanceId: input.workspaceInstanceId,
		pathFlavor: input.pathFlavor,
		canonicalRoot: paths.resolve(input.canonicalRoot, "."),
		displayRoot,
	});
}
function assertScopeMetadata(
	scope: FileChangeScopeRecord,
	input: PrepareFileChangeScope,
	values: ReturnType<typeof normalizeScope>,
) {
	if (
		(input.id !== undefined && input.id !== scope.id) ||
		scope.pathFlavor !== values.pathFlavor ||
		!targetPathSemantics(values.pathFlavor).equals(scope.canonicalRoot, values.canonicalRoot)
	)
		throw fail("IDENTITY_CONFLICT", "Historical scope metadata does not match this identity");
}
function normalizeOperation(input: BeginFileChangeOperation) {
	assertString(input.sourceInstanceId, "sourceInstanceId");
	assertString(input.sourceId, "sourceId");
	if (
		!["tool", "editor", "background_task", "external", "git", "revert", "import"].includes(
			input.sourceKind,
		)
	)
		throw fail("INVALID_INPUT", "Invalid operation source kind");
	assertInteger(input.attempt, "attempt", 1);
	assertDigest(input.requestDigest);
	assertInteger(
		input.expectedEffectCount,
		"expectedEffectCount",
		1,
		FILE_CHANGE_LIMITS.revertFiles,
	);
	const revision = input.editorRawSnapshotRevision ?? null;
	if (revision !== null) {
		assertInteger(revision, "editorRawSnapshotRevision", 0, Number.MAX_SAFE_INTEGER);
		if (input.sourceKind !== "editor")
			throw fail("INVALID_INPUT", "Only an editor save records a raw snapshot revision");
	}
	return boundedRecord({
		evidenceVersion: FILE_CHANGE_EVIDENCE_VERSION,
		sourceInstanceId: input.sourceInstanceId,
		sourceKind: input.sourceKind,
		sourceId: input.sourceId,
		attempt: input.attempt,
		requestDigest: input.requestDigest,
		expectedEffectCount: input.expectedEffectCount,
		// Published column, retired meaning: the per-file queue has no lease to record.
		workspaceLeaseId: null,
		editorRawSnapshotRevision: revision,
		actorSubjectKey: input.actor.subjectKey,
		actorJson: normalizeActor(input.actor),
		executionBindingJson:
			input.executionBinding == null ? null : normalizeBinding(input.executionBinding),
		toolCallId: nullableId(input.toolCallId),
		toolUseId: nullableId(input.toolUseId),
		backgroundTaskId: nullableId(input.backgroundTaskId),
		narratorId: nullableId(input.narratorId),
		projectId: nullableId(input.projectId),
		ownerUserId: nullableId(input.ownerUserId),
		initiatorSubjectKey: nullableId(input.initiatorSubjectKey),
		parentOperationId: nullableId(input.parentOperationId),
		executionSegmentId: nullableId(input.executionSegmentId),
	});
}
function normalizeActor(actor: FileChangeActor): FileChangeActor {
	assertKeys(actor, [
		"kind",
		"subjectKey",
		"narratorId",
		"userId",
		"label",
		"deleted",
		"parentSubjectKey",
	]);
	if (
		!["human", "primary", "subagent", "external_unknown"].includes(actor.kind) ||
		typeof actor.deleted !== "boolean"
	)
		throw fail("INVALID_INPUT", "Invalid actor snapshot");
	assertString(actor.subjectKey, "actor subjectKey");
	if (actor.label !== null) assertString(actor.label, "actor label", 512);
	return {
		kind: actor.kind,
		subjectKey: actor.subjectKey,
		narratorId: nullableId(actor.narratorId),
		userId: nullableId(actor.userId),
		label: actor.label,
		deleted: actor.deleted,
		parentSubjectKey: nullableId(actor.parentSubjectKey),
	};
}
function normalizeBinding(binding: FileChangeExecutionBinding): FileChangeExecutionBinding {
	assertKeys(binding, ["deviceId", "runtimeEpoch", "runtimeGeneration", "fencingToken"]);
	assertString(binding.deviceId, "binding deviceId");
	assertString(binding.runtimeEpoch, "runtimeEpoch");
	assertInteger(binding.runtimeGeneration, "runtimeGeneration");
	// Legacy fence values may be retained as metadata, never compared for admission.
	if (binding.fencingToken != null) assertInteger(binding.fencingToken, "legacy fencingToken");
	return { ...binding };
}
function assertOperationReplay(
	existing: FileChangeOperationRecord,
	values: ReturnType<typeof normalizeOperation>,
) {
	for (const key of Object.keys(values) as (keyof typeof values)[]) {
		if (!jsonEqual(existing[key], values[key]))
			throw fail("REQUEST_CONFLICT", "An execution attempt cannot change its request or actor");
	}
}
function normalizeNoDispatch(input: BeginFileChangeOperation, proof: FileChangeNoDispatchProof) {
	if (
		proof.targetDispatched !== false ||
		![
			"validation_rejected",
			"cancelled_before_dispatch",
			"preview",
			"invocation_rejected",
		].includes(proof.reason) ||
		input.sourceKind !== "tool" ||
		!input.toolCallId ||
		input.sourceId !== input.toolCallId ||
		input.expectedEffectCount !== 1 ||
		!input.narratorId ||
		input.actor.narratorId !== input.narratorId ||
		!["primary", "subagent"].includes(input.actor.kind)
	)
		throw fail(
			"INVALID_INPUT",
			"A bound file-tool attempt and explicit no-dispatch proof are required",
		);
	return {
		values: { ...normalizeOperation(input), expectedEffectCount: 0 },
		terminal: {
			executionOutcome:
				proof.reason === "cancelled_before_dispatch"
					? ("interrupted" as const)
					: proof.reason === "preview"
						? ("succeeded" as const)
						: ("failed" as const),
			effectOutcome: "no_change" as const,
			settlement: "settled" as const,
			coverage: "complete" as const,
			attributionGrade: "unknown" as const,
			preparedEffectCount: 0,
			settledEffectCount: 0,
			unresolvedEffectCount: 0,
			evidenceBytes: 0,
			reason: `no_dispatch:${proof.reason}`,
		},
	};
}
function assertNoDispatchTool(
	tool: NoDispatchTool | undefined,
	input: BeginFileChangeOperation,
	proof: FileChangeNoDispatchProof,
): asserts tool is NoDispatchTool {
	if (
		!tool ||
		tool.version !== 1 ||
		tool.origin !== null ||
		tool.checkpoint ||
		tool.attempt !== input.attempt ||
		tool.narratorId !== input.narratorId ||
		tool.toolUseId !== (input.toolUseId ?? null) ||
		!["Write", "Edit", "StructSed"].includes(tool.toolName) ||
		(input.executionBinding &&
			(tool.deviceId !== input.executionBinding.deviceId ||
				tool.generation !== input.executionBinding.runtimeGeneration)) ||
		(!input.executionBinding && !proof.frozenTarget) ||
		(proof.frozenTarget &&
			(tool.cwd !== proof.frozenTarget.cwd ||
				tool.pathFlavor !== proof.frozenTarget.pathFlavor ||
				tool.lexicalPath !== (proof.frozenTarget.lexicalPath ?? null) ||
				tool.canonicalPath !== (proof.frozenTarget.canonicalPath ?? null)))
	)
		throw fail(
			"IDENTITY_CONFLICT",
			"No-dispatch proof does not match an actual frozen file-tool attempt",
		);
}
function assertNoDispatchReplay(
	existing: FileChangeOperationRecord,
	tool: NoDispatchTool,
	values: ReturnType<typeof normalizeOperation>,
	terminal: ReturnType<typeof normalizeNoDispatch>["terminal"],
) {
	assertOperationReplay(existing, values);
	if (
		tool.operationId !== existing.id ||
		!Object.entries(terminal).every(([key, value]) =>
			jsonEqual(existing[key as keyof FileChangeOperationRecord], value),
		)
	)
		throw fail("REQUEST_CONFLICT", "An existing attempt cannot become a no-dispatch operation");
}
function assertNoDispatchLive(tool: NoDispatchTool, proof: FileChangeNoDispatchProof) {
	const before = proof.beforeInvocation;
	if (
		tool.operationId !== null ||
		(before
			? !proof.frozenTarget ||
				!["invocation_rejected", "cancelled_before_dispatch"].includes(proof.reason) ||
				(!["initializing", "pending", "running"].includes(before.status) &&
					!(
						before.status === "fail" &&
						["initializing", "pending", "running"].includes(before.observedStatus ?? "")
					)) ||
				before.executionStartedAt !== null ||
				tool.status !== before.status ||
				tool.startedAt !== null
			: tool.status !== "running" || tool.startedAt === null)
	)
		throw fail(
			"INVALID_TRANSITION",
			"No-dispatch evidence requires the exact live allocated or claimed attempt",
		);
}
function normalizeEffect(input: RecordFileChangeEffect) {
	assertKeys(input, [
		"operationId",
		"identity",
		"before",
		"intendedAfter",
		"observedAfter",
		"outcome",
		"linesAdded",
		"linesRemoved",
	]);
	assertString(input.operationId, "operationId");
	if (!["applied", "not_applied", "unknown"].includes(input.outcome))
		throw fail("INVALID_INPUT", "An actual IO outcome is required");
	assertKeys(input.identity, [
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"scopeId",
		"pathFlavor",
		"objectRole",
		"canonicalPath",
		"lexicalPath",
		"displayPath",
	]);
	return boundedRecord({
		...input,
		identity: { ...input.identity },
		fileKey: fileChangeIdentityKey(input.identity),
		before: normalizeState(input.before),
		intendedAfter: normalizeState(input.intendedAfter),
		observedAfter: normalizeState(input.observedAfter),
		linesAdded: nullableLines(input.linesAdded),
		linesRemoved: nullableLines(input.linesRemoved),
	});
}
function effectValues(
	operation: FileChangeOperationRecord,
	input: ReturnType<typeof normalizeEffect>,
) {
	const known = input.before.kind !== "unknown" && input.observedAfter.kind !== "unknown";
	const outcome =
		input.outcome === "unknown"
			? ("unknown" as const)
			: input.outcome === "not_applied"
				? ("no_change" as const)
				: !known
					? ("unknown" as const)
					: fileChangeStatesEqual(input.before, input.observedAfter)
						? ("no_change" as const)
						: ("changed" as const);
	return boundedRecord({
		operationId: operation.id,
		journalSeq: operation.journalSeq,
		scopeId: input.identity.scopeId,
		fileKey: input.fileKey,
		identityJson: input.identity,
		scopeRevision: null,
		mutationId: digest([operation.id, operation.attempt, input.fileKey, "apply"]),
		requestDigest: operation.requestDigest as string,
		phase: "apply" as const,
		beforeStateJson: input.before,
		intendedAfterStateJson: input.intendedAfter,
		observedAfterStateJson: input.observedAfter,
		beforeBlobDigest: stateBlob(input.before)?.digest ?? null,
		intendedAfterBlobDigest: stateBlob(input.intendedAfter)?.digest ?? null,
		observedAfterBlobDigest: stateBlob(input.observedAfter)?.digest ?? null,
		diskOutcome: input.outcome,
		outcome,
		settlement: "settled" as const,
		attributionGrade:
			known && input.outcome !== "unknown" ? ("measured" as const) : ("unknown" as const),
		attributionCeiling: null,
		executionConfirmed: input.outcome !== "unknown",
		executionReceiptJson: null,
		executionReceiptDigest: null,
		linesAdded: input.linesAdded,
		linesRemoved: input.linesRemoved,
	});
}
function assertEffectReplay(
	existing: FileChangeEffectRecord,
	values: ReturnType<typeof effectValues>,
) {
	if (
		!Object.entries(values).every(([key, value]) =>
			jsonEqual(existing[key as keyof FileChangeEffectRecord], value),
		)
	)
		throw fail("REQUEST_CONFLICT", "A recorded file result is immutable");
}
function recordedCounts(
	operation: FileChangeOperationRecord,
	input: ReturnType<typeof normalizeEffect>,
) {
	const evidenceBytes =
		operation.evidenceBytes +
		stateBytes(input.before) +
		stateBytes(input.intendedAfter) +
		stateBytes(input.observedAfter);
	assertInteger(evidenceBytes, "evidence bytes", 0, FILE_CHANGE_LIMITS.operationEvidenceBytes);
	return {
		evidenceBytes,
		preparedEffectCount: operation.preparedEffectCount + 1,
		settledEffectCount: operation.settledEffectCount + 1,
		unresolvedEffectCount: operation.unresolvedEffectCount + (input.outcome === "unknown" ? 1 : 0),
	};
}
function assertEffectScope(
	scope: FileChangeScopeRecord | undefined,
	operation: FileChangeOperationRecord,
	identity: FileChangeIdentity,
) {
	if (!scope) throw fail("NOT_FOUND", "File-change scope not found");
	if (
		scope.sourceInstanceId !== operation.sourceInstanceId ||
		scope.sourceInstanceId !== identity.sourceInstanceId ||
		scope.deviceId !== identity.deviceId ||
		scope.workspaceInstanceId !== identity.workspaceInstanceId ||
		scope.pathFlavor !== identity.pathFlavor ||
		(operation.executionBindingJson &&
			scope.deviceId !== operation.executionBindingJson.deviceId) ||
		!jsonEqual(createFileChangeIdentity(scope, identity), identity)
	)
		throw fail("IDENTITY_CONFLICT", "File result does not match its historical source and scope");
}
function assertBlobMetadata(
	blob: { status: string; sizeBytes: number } | undefined,
	ref: NonNullable<ReturnType<typeof stateBlob>>,
) {
	if (blob?.status !== "ready" || blob.sizeBytes !== ref.sizeBytes)
		throw fail(
			"BLOB_NOT_READY",
			"History references require a verified catalog object with matching size",
		);
}
function assertCurrentOperation(
	operation: FileChangeOperationRecord,
): asserts operation is FileChangeOperationRecord & {
	requestDigest: string;
	expectedEffectCount: number;
} {
	if (
		operation.evidenceVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		operation.requestDigest === null ||
		operation.expectedEffectCount === null
	)
		throw fail("LEGACY_READ_ONLY", "Legacy history is read-only");
	assertDigest(operation.requestDigest);
	assertInteger(
		operation.expectedEffectCount,
		"expectedEffectCount",
		0,
		FILE_CHANGE_LIMITS.revertFiles,
	);
}
function assertTerminalOutcome(outcome: string) {
	if (!["succeeded", "failed", "interrupted"].includes(outcome))
		throw fail("INVALID_INPUT", "A terminal execution outcome is required");
}
function normalizeState(state: FileChangeState): FileChangeState {
	if (!state || typeof state !== "object")
		throw fail("INVALID_INPUT", "Absence must be explicit, never null");
	if (state.kind === "absent") {
		assertKeys(state, ["kind"]);
		return { kind: "absent" };
	}
	if (state.kind === "unknown") {
		assertKeys(state, ["kind", "reason"]);
		if (
			![
				"legacy_unverified",
				"history_unavailable",
				"capture_failed",
				"capture_incomplete",
				"capture_concurrent",
				"missing_before",
				"missing_after",
				"unreadable",
				"unsupported_object",
				"unsupported_backend",
				"target_unverified",
				"result_unknown",
				"content_changed",
				"quota_exceeded",
				"budget_exceeded",
				"cancelled",
				"expired",
				"object_missing",
			].includes(state.reason)
		)
			throw fail("INVALID_INPUT", "Invalid unknown-state reason");
		return { kind: "unknown", reason: state.reason };
	}
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("INVALID_INPUT", "Unsupported file object");
	assertKeys(
		state,
		state.kind === "regular" ? ["kind", "blob", "mode"] : ["kind", "target", "mode"],
	);
	if (state.mode !== null) assertInteger(state.mode, "mode", 0, 0xffff);
	const ref = state.kind === "regular" ? state.blob : state.target;
	assertKeys(ref, ["algorithm", "digest", "sizeBytes"]);
	if (ref.algorithm !== "sha256")
		throw fail("INVALID_INPUT", "Only SHA-256 blob references are supported");
	assertDigest(ref.digest);
	assertInteger(ref.sizeBytes, "blob size", 0, FILE_CHANGE_LIMITS.blobBytes);
	const blob = { algorithm: "sha256" as const, digest: ref.digest, sizeBytes: ref.sizeBytes };
	return state.kind === "regular"
		? { kind: "regular", blob, mode: state.mode }
		: { kind: "symlink", target: blob, mode: state.mode };
}
function stateBlob(state: FileChangeState) {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}
function stateBytes(state: FileChangeState): number {
	return stateBlob(state)?.sizeBytes ?? 0;
}
function nullableId(value: string | null | undefined): string | null {
	if (value == null) return null;
	assertString(value, "identifier");
	return value;
}
function nullableLines(value: number | null | undefined): number | null {
	if (value == null) return null;
	assertInteger(value, "measured lines");
	return value;
}
function validatePendingPage(options: {
	settlement: PendingSettlement;
	cursor?: FileChangeOperationCursor;
}) {
	if (
		!["preparing", "intent_durable", "applying", "reconcile_required"].includes(options.settlement)
	)
		throw fail("INVALID_INPUT", "A single pending settlement state is required");
	if (options.cursor) {
		assertString(options.cursor.id, "cursor id");
		assertString(options.cursor.updatedAt, "cursor timestamp", 64);
	}
}
function validateEffectCursor(cursor: FileChangeEffectCursor | undefined) {
	if (!cursor) return;
	assertDigest(cursor.fileKey);
	if (cursor.phase !== "apply" && cursor.phase !== "compensate")
		throw fail("INVALID_INPUT", "Invalid effect cursor phase");
}
function effectCursor(effect: FileChangeEffectRecord): FileChangeEffectCursor {
	return { fileKey: effect.fileKey, phase: effect.phase };
}
function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems): number {
	assertInteger(value, "page limit", 1, FILE_CHANGE_LIMITS.historyPageItems);
	return value;
}
function boundedPage<T, C>(
	rows: T[],
	limit: number,
	toCursor: (row: T) => C,
): FileChangeEvidencePage<T, C> {
	const items: T[] = [];
	let bytes = 1024;
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
		if (items.length === limit || bytes + size > FILE_CHANGE_LIMITS.summaryBytes) break;
		items.push(row);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw fail("METADATA_BUDGET", "An evidence row exceeds the summary budget");
	const hasMore = rows.length > items.length;
	const last = items.at(-1);
	return { items, hasMore, nextCursor: hasMore && last ? toCursor(last) : null };
}
function assertString(value: string, name: string, maxBytes = 256) {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > maxBytes
	)
		throw fail("INVALID_INPUT", `Invalid or oversized ${name}`);
}
function assertInteger(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_EXCEEDED", `Invalid or over-budget ${name}`);
}
function assertDigest(value: string) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw fail("INVALID_INPUT", "Expected a lowercase SHA-256 digest");
}
function assertMetadata(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > FILE_CHANGE_LIMITS.metadataBytes)
		throw fail("METADATA_BUDGET", "Evidence metadata exceeds its bounded row budget");
}
function boundedRecord<T>(record: T): T {
	assertMetadata(record);
	return record;
}
function assertKeys(value: object, keys: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	)
		throw fail("INVALID_INPUT", "Unexpected fields in evidence metadata");
}
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	);
}
function jsonEqual(left: unknown, right: unknown): boolean {
	return stableJson(left) === stableJson(right);
}
function digest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}
function fail(code: string, message: string) {
	return new FileChangeEvidenceError(code, message);
}

export { assertCurrentOperation, assertNoDispatchTool };
/** Pure record validation shared by SQLite and PostgreSQL; no transaction handles. */
export const evidenceInternals = {
	normalizeScope,
	assertScopeMetadata,
	normalizeOperation,
	assertOperationReplay,
	normalizeNoDispatch,
	assertNoDispatchReplay,
	assertNoDispatchLive,
	normalizeEffect,
	effectValues,
	assertEffectReplay,
	recordedCounts,
	assertEffectScope,
	assertBlobMetadata,
	assertTerminalOutcome,
	operationAggregate,
	stateBlob,
	normalizeState,
	validateEffectCursor,
	validatePendingPage,
	effectCursor,
	pageLimit,
	boundedPage,
	assertString,
	assertMetadata,
	boundedRecord,
	jsonEqual,
	fail,
};
