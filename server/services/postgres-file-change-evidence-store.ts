/**
 * PostgreSQL counterpart of `FileChangeEvidenceService`'s atomic write sections
 * (`file-change-evidence.ts`).
 *
 * WHY A SIBLING, NOT A FLAG
 * -------------------------
 * The SQLite service is strictly synchronous end to end — every section is a
 * `db.transaction((tx) => …)` callback with no `await`, guarded by a
 * `$client.inTransaction` boundary check. A networked driver cannot satisfy that:
 * an `await` inside a `bun:sqlite` callback commits at the first suspension
 * (`server/db/transaction-atomicity-contract.test.ts`). So the PostgreSQL
 * counterpart is its own module with honestly async methods, sharing with the
 * SQLite service the section CONTENT and the dialect-free core
 * (`evidenceInternals`: normalization, verdicts, aggregates, budgets, hashing).
 * What is rewritten here is the dialect shape:
 *
 *   - `.get()/.run()/.all()` chaining → awaited statements;
 *   - the durability-boundary check (`$client`, `inTransaction`) has no PG
 *     counterpart: foreign keys are always enforced, and "no ambient
 *     transaction" is structural — every method opens its OWN `db.transaction`
 *     through `withPgRetry` and never accepts a caller's transaction handle;
 *   - the file-history clock (`INSERT … ON CONFLICT DO NOTHING` then a guarded
 *     `lastSeq + 1` update) is shared drizzle vocabulary and stays verbatim —
 *     on PostgreSQL the UPDATE's row lock is what serializes the counter claim,
 *     the same guarantee SQLite's single writer gave.
 *
 * HOW THE PORT CONTRACT IS MET (see `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------------
 * - PROMISE boundary: every method is honestly async end to end.
 * - ATOMICITY: each section runs in one `db.transaction`; any rejection rolls all
 *   of it back. Sections are NAMED async functions invoked through non-async
 *   arrows.
 * - RETRY: `withPgRetry` wraps the WHOLE section. Sections are idempotent under
 *   replay: `beginOperation` re-finds its committed row through the
 *   (source, kind, id, attempt) check, `prepareEffects` through the mutationId
 *   check, `settleEffect` through the immutable-receipt comparison — a replay
 *   after a lost commit acknowledgement surfaces as the winner's state, never as
 *   duplicate rows or a doubled clock tick (the clock tick happens inside the
 *   same section that would have to be replayed, and the replay re-runs the
 *   existence check first).
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { withPgRetry } from "@server/db/pg-retry";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopeRecoveries,
	fileChangeScopes,
	fileChangeStorageBudgets,
	fileHistoryClock,
	narratorToolCalls,
} from "@server/db/postgres-schema";
import { generateId } from "@server/lib/id";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeExecutionBinding,
	type FileChangeExecutionOutcome,
	type FileChangeExecutionReceipt,
	type FileChangeIdentity,
	type FileChangeRecoveryVerdict,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import type {
	BeginFileChangeOperation,
	FileChangeEffectCursor,
	FileChangeEffectSelector,
	FileChangeNoDispatchProof,
	PrepareFileChangeEffect,
	PrepareFileChangeScope,
	SettleFileChangeEffect,
} from "./file-change-evidence";
import {
	assertJournal as assertEvidenceJournal,
	evidenceInternals as E,
	FILE_CHANGE_PREPARE_BATCH_ITEMS,
	type FileChangeEffectRecord,
	FileChangeEvidenceError,
	type FileChangeOperationRecord,
	type FileChangeScopeRecord,
} from "./file-change-evidence";
import {
	createFileChangeIdentity,
	fileChangeExecutionBindingMatches,
} from "./file-change-identity";

/** Transaction handle as produced by `db.transaction(async (tx) => …`. PG-side only. */
type Tx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
/**
 * The root handle, seen through the transaction's query interface (same confined
 * cast as `postgres-revert-plan-store.ts`).
 */
type RootQueryable = Tx;

/**
 * The PostgreSQL file-change evidence store. Same constructor contract as the
 * SQLite service; `database` must be a ROOT handle — sections open their own
 * transactions.
 */
export class PostgresFileChangeEvidenceStore {
	constructor(
		private readonly database: BunSQLDatabase,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	// ── in-section guards (PG spellings of the SQLite service's private helpers) ──

	private async requireScope(tx: Tx, id: string): Promise<FileChangeScopeRecord> {
		const rows = (await tx
			.select()
			.from(fileChangeScopes)
			.where(eq(fileChangeScopes.id, id))) as FileChangeScopeRecord[];
		const row = rows[0];
		if (!row) throw E.fail("NOT_FOUND", "File-change scope not found");
		return row;
	}

	private async requireOperation(tx: Tx, id: string): Promise<FileChangeOperationRecord> {
		const rows = (await tx
			.select()
			.from(fileChangeOperations)
			.where(eq(fileChangeOperations.id, id))) as FileChangeOperationRecord[];
		const row = rows[0];
		if (!row) throw E.fail("NOT_FOUND", "File-change operation not found");
		return row;
	}

	private async requireEffect(
		tx: Tx,
		input: FileChangeEffectSelector,
	): Promise<FileChangeEffectRecord> {
		const rows = (await tx
			.select()
			.from(fileChangeEffects)
			.where(eq(fileChangeEffects.mutationId, input.mutationId))) as FileChangeEffectRecord[];
		const row = rows[0];
		if (!row || row.operationId !== input.operationId) {
			throw E.fail("NOT_FOUND", "Effect does not belong to this operation");
		}
		if (row.requestDigest !== input.requestDigest) {
			throw E.fail("REQUEST_CONFLICT", "Mutation request digest changed");
		}
		return row;
	}

	private async effectExists(tx: Tx, operationId: string, condition: SQL): Promise<boolean> {
		// Prefix of idx_fc_effect_operation_file; at most the fixed 1000-row operation,
		// never a global aggregation and never fetches JSON/body fields.
		const rows = await tx
			.select({ id: fileChangeEffects.id })
			.from(fileChangeEffects)
			.where(and(eq(fileChangeEffects.operationId, operationId), condition))
			.limit(1);
		return rows[0] !== undefined;
	}

	private async selectEffects(
		tx: Tx,
		operationId: string,
		cursor: FileChangeEffectCursor | undefined,
		limit: number,
	): Promise<FileChangeEffectRecord[]> {
		return (await tx
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
			.limit(limit)) as FileChangeEffectRecord[];
	}

	private async assertEffectScope(
		tx: Tx,
		operation: FileChangeOperationRecord,
		identity: FileChangeIdentity,
		revision: number,
		requireVerified: boolean,
	): Promise<void> {
		const scope = await this.requireScope(tx, identity.scopeId);
		if (scope.status === "retired" || (requireVerified && scope.status !== "active")) {
			throw E.fail("TARGET_UNVERIFIED", "The workspace scope is not verified for execution");
		}
		if (
			scope.sourceInstanceId !== operation.sourceInstanceId ||
			scope.deviceId !== operation.executionBindingJson?.deviceId ||
			scope.sourceInstanceId !== identity.sourceInstanceId ||
			scope.deviceId !== identity.deviceId ||
			scope.workspaceInstanceId !== identity.workspaceInstanceId ||
			scope.pathFlavor !== identity.pathFlavor ||
			scope.revision !== revision ||
			scope.fencingToken !== operation.executionBindingJson?.fencingToken
		) {
			throw E.fail(
				"IDENTITY_CONFLICT",
				"Effect scope or execution fence does not match its operation",
			);
		}
		const normalized = createFileChangeIdentity(
			scope as Parameters<typeof createFileChangeIdentity>[0],
			identity,
		);
		if (!E.jsonEqual(normalized, identity)) {
			throw E.fail(
				"IDENTITY_CONFLICT",
				"Effect identity is not the canonical scoped backend target",
			);
		}
	}

	private async assertReadyStates(tx: Tx, states: FileChangeState[]): Promise<void> {
		const budgets = await tx
			.select({ status: fileChangeStorageBudgets.status })
			.from(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID));
		const budget = budgets[0];
		if (budget?.status !== "ready") {
			throw E.fail(
				"CATALOG_UNVERIFIED",
				"Blob storage reconciliation must finish before protected evidence is used",
			);
		}
		for (const state of states) {
			const ref = E.stateBlob(state);
			if (!ref) continue;
			const rows = await tx
				.select({ sizeBytes: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
				.from(fileChangeBlobs)
				.where(eq(fileChangeBlobs.digest, ref.digest));
			const blob = rows[0];
			if (blob?.status !== "ready" || blob.sizeBytes !== ref.sizeBytes) {
				throw E.fail(
					"BLOB_NOT_READY",
					"Evidence references require a ready catalog object with matching size",
				);
			}
		}
	}

	// ── scopes ──

	async prepareScope(input: PrepareFileChangeScope): Promise<FileChangeScopeRecord> {
		const values = E.normalizeScope(input);
		return withPgRetry(
			() => this.database.transaction((tx) => this.prepareScopeSection(tx, input, values)),
			{ label: "evidence.prepareScope" },
		);
	}

	private async prepareScopeSection(
		tx: Tx,
		input: PrepareFileChangeScope,
		values: ReturnType<typeof E.normalizeScope>,
	): Promise<FileChangeScopeRecord> {
		const existingRows = (await tx
			.select()
			.from(fileChangeScopes)
			.where(
				and(
					eq(fileChangeScopes.sourceInstanceId, values.sourceInstanceId),
					eq(fileChangeScopes.deviceId, values.deviceId),
					eq(fileChangeScopes.workspaceInstanceId, values.workspaceInstanceId),
				),
			)) as FileChangeScopeRecord[];
		const existing = existingRows[0];
		if (existing) {
			if (
				(input.id !== undefined && input.id !== existing.id) ||
				existing.pathFlavor !== values.pathFlavor ||
				!targetPathSemantics(values.pathFlavor).equals(existing.canonicalRoot, values.canonicalRoot)
			) {
				throw E.fail(
					"IDENTITY_CONFLICT",
					"A workspace instance cannot change its root or identity",
				);
			}
			return existing;
		}
		const timestamp = this.now();
		const row = {
			...values,
			id: input.id ?? generateId(),
			status: "needs_verification" as const,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		E.assertMetadata(row);
		const inserted = await tx.insert(fileChangeScopes).values(row).returning();
		const record = inserted[0] as FileChangeScopeRecord | undefined;
		if (!record) throw E.fail("JOURNAL_UNAVAILABLE", "Scope insert returned no row");
		return E.boundedRecord(record);
	}

	/** Records verification already performed by an authorized backend; does not perform it. */
	async recordScopeVerification(input: {
		scopeId: string;
		canonicalRoot: string;
		rootIdentity: Record<string, string>;
	}): Promise<FileChangeScopeRecord> {
		E.assertString(input.scopeId, "scopeId");
		E.assertString(input.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
		const entries = Object.entries(input.rootIdentity);
		if (!entries.length || entries.length > 32)
			throw E.fail("INVALID_INPUT", "Invalid root identity");
		for (const [key, value] of entries) {
			E.assertString(key, "root identity key");
			E.assertString(value, "root identity value");
		}
		E.assertMetadata(input);
		return withPgRetry(
			() => this.database.transaction((tx) => this.recordScopeVerificationSection(tx, input)),
			{ label: "evidence.recordScopeVerification" },
		);
	}

	private async recordScopeVerificationSection(
		tx: Tx,
		input: { scopeId: string; canonicalRoot: string; rootIdentity: Record<string, string> },
	): Promise<FileChangeScopeRecord> {
		const scope = await this.requireScope(tx, input.scopeId);
		if (
			scope.activeLeaseId !== null ||
			scope.activeMutationCount > 0 ||
			(scope.status === "needs_verification" && scope.rootIdentityJson !== null)
		) {
			throw E.fail(
				"TARGET_UNVERIFIED",
				"Active or unsettled writes require recovery; root-path verification cannot clear their barrier",
			);
		}
		if (
			scope.status === "retired" ||
			scope.canonicalRoot !== input.canonicalRoot ||
			(scope.rootIdentityJson !== null && !E.jsonEqual(scope.rootIdentityJson, input.rootIdentity))
		) {
			throw E.fail(
				"IDENTITY_CONFLICT",
				"A retired or changed root requires a new workspace instance",
			);
		}
		const updated = await tx
			.update(fileChangeScopes)
			.set({ status: "active", rootIdentityJson: input.rootIdentity, updatedAt: this.now() })
			.where(eq(fileChangeScopes.id, scope.id))
			.returning();
		const record = updated[0] as FileChangeScopeRecord | undefined;
		if (!record) throw E.fail("NOT_FOUND", "File-change scope not found");
		return E.boundedRecord(record);
	}

	/**
	 * Closes the evidence books of ONE scope after human-driven external recovery.
	 * Frozen execution receipts and observed states are NEVER rewritten.
	 */
	async closeBooksForRecovery(input: {
		scopeId: string;
		recoveredByUserId: string;
		decisions: {
			effectId: string;
			canonicalPath: string;
			verdict: FileChangeRecoveryVerdict;
			observedDigest: string | null;
			observedSizeBytes: number | null;
		}[];
	}): Promise<{ settledEffectCount: number }> {
		E.assertString(input.scopeId, "scopeId");
		E.assertString(input.recoveredByUserId, "recoveredByUserId");
		if (
			!Array.isArray(input.decisions) ||
			input.decisions.length > FILE_CHANGE_LIMITS.revertFiles
		) {
			throw E.fail("INVALID_INPUT", "Invalid recovery decision list");
		}
		for (const decision of input.decisions) {
			E.assertString(decision.effectId, "decision effectId");
			E.assertString(
				decision.canonicalPath,
				"decision canonicalPath",
				FILE_CHANGE_LIMITS.metadataBytes,
			);
			if (
				!["applied", "not_applied", "not_dispatched", "foreign", "unobservable"].includes(
					decision.verdict,
				)
			) {
				throw E.fail("INVALID_INPUT", "Invalid recovery verdict");
			}
			if (decision.observedDigest !== null) E.assertDigest(decision.observedDigest);
			if (decision.observedSizeBytes !== null) {
				E.assertInteger(decision.observedSizeBytes, "observedSizeBytes", 0);
			}
		}
		E.assertMetadata(input.decisions);
		return withPgRetry(() => this.database.transaction((tx) => this.closeBooksSection(tx, input)), {
			label: "evidence.closeBooksForRecovery",
		});
	}

	private async closeBooksSection(
		tx: Tx,
		input: {
			scopeId: string;
			recoveredByUserId: string;
			decisions: {
				effectId: string;
				canonicalPath: string;
				verdict: FileChangeRecoveryVerdict;
				observedDigest: string | null;
				observedSizeBytes: number | null;
			}[];
		},
	): Promise<{ settledEffectCount: number }> {
		const scope = await this.requireScope(tx, input.scopeId);
		const unsettled = (await tx
			.select()
			.from(fileChangeEffects)
			.where(
				and(eq(fileChangeEffects.scopeId, scope.id), ne(fileChangeEffects.settlement, "settled")),
			)) as FileChangeEffectRecord[];
		const byEffectId = new Map(input.decisions.map((decision) => [decision.effectId, decision]));
		if (byEffectId.size !== input.decisions.length || byEffectId.size !== unsettled.length) {
			throw E.fail(
				"INVALID_INPUT",
				"Recovery decisions must cover every unsettled effect exactly once",
			);
		}
		const timestamp = this.now();
		for (const effect of unsettled) {
			const decision = byEffectId.get(effect.id);
			if (!decision) {
				throw E.fail("INVALID_INPUT", `Missing recovery decision for effect ${effect.id}`);
			}
			if (decision.canonicalPath !== effect.identityJson.canonicalPath) {
				throw E.fail("INVALID_INPUT", "Recovery decision path does not match the effect identity");
			}
			const dispatched =
				effect.settlement === "applying" || effect.settlement === "reconcile_required";
			if (!dispatched && decision.verdict !== "not_dispatched") {
				throw E.fail("INVALID_INPUT", "An undispatched effect cannot receive an IO verdict");
			}
			if (dispatched && decision.verdict === "not_dispatched") {
				throw E.fail("INVALID_INPUT", "A dispatched effect cannot be marked not_dispatched");
			}
			const outcome =
				decision.verdict === "foreign" || decision.verdict === "unobservable"
					? ("unknown" as const)
					: decision.verdict === "applied"
						? fileChangeStatesEqual(effect.beforeStateJson, effect.intendedAfterStateJson)
							? ("no_change" as const)
							: ("changed" as const)
						: ("no_change" as const);
			await tx
				.update(fileChangeEffects)
				.set({ outcome, settlement: "settled", updatedAt: timestamp })
				.where(eq(fileChangeEffects.id, effect.id));
		}
		for (const operationId of new Set(unsettled.map((effect) => effect.operationId))) {
			const operation = await this.requireOperation(tx, operationId);
			const effects = await this.selectEffects(
				tx,
				operationId,
				undefined,
				FILE_CHANGE_LIMITS.revertFiles + 1,
			);
			const remaining = effects.filter((effect) => effect.settlement !== "settled").length;
			if (remaining > 0) {
				// Another scope of the same operation is still barred; only refresh counts.
				await tx
					.update(fileChangeOperations)
					.set({
						settledEffectCount: effects.length - remaining,
						unresolvedEffectCount: remaining,
						updatedAt: timestamp,
					})
					.where(eq(fileChangeOperations.id, operationId));
				continue;
			}
			const anyUnknown = effects.some((effect) => effect.outcome === "unknown");
			const anyChanged = effects.some((effect) => effect.outcome === "changed");
			await tx
				.update(fileChangeOperations)
				.set({
					settlement: "settled",
					effectOutcome: anyUnknown ? "unknown" : anyChanged ? "changed" : "no_change",
					settledEffectCount: effects.length,
					unresolvedEffectCount: 0,
					finishedAt: operation.finishedAt ?? timestamp,
					updatedAt: timestamp,
				})
				.where(eq(fileChangeOperations.id, operationId));
		}
		await tx.insert(fileChangeScopeRecoveries).values({
			id: generateId(),
			scopeId: scope.id,
			deviceId: scope.deviceId,
			canonicalRoot: scope.canonicalRoot,
			pathFlavor: scope.pathFlavor,
			recoveredByUserId: input.recoveredByUserId,
			effectDecisionsJson: input.decisions,
			scopeRevisionBefore: scope.revision,
			fencingTokenBefore: scope.fencingToken,
			createdAt: timestamp,
		});
		return { settledEffectCount: unsettled.length };
	}

	// ── operations ──

	/** Only the trusted Write/Edit driver may attest that it has dispatched NO target IO. */
	async beginNoDispatchOperation(
		input: BeginFileChangeOperation,
		proof: FileChangeNoDispatchProof,
	): Promise<FileChangeOperationRecord> {
		if (
			proof.targetDispatched !== false ||
			!["validation_rejected", "cancelled_before_dispatch"].includes(proof.reason) ||
			input.sourceKind !== "tool" ||
			!input.toolCallId ||
			input.sourceId !== input.toolCallId ||
			input.expectedEffectCount !== 1 ||
			!input.narratorId ||
			input.actor.narratorId !== input.narratorId ||
			!["primary", "subagent"].includes(input.actor.kind)
		) {
			throw E.fail(
				"INVALID_INPUT",
				"A bound file-tool attempt and explicit no-dispatch proof are required",
			);
		}
		const values = { ...E.normalizeOperation(input), expectedEffectCount: 0 };
		const terminal = {
			executionOutcome:
				proof.reason === "cancelled_before_dispatch"
					? ("interrupted" as const)
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
		};
		return withPgRetry(
			() =>
				this.database.transaction((tx) => this.beginNoDispatchSection(tx, input, values, terminal)),
			{ label: "evidence.beginNoDispatchOperation" },
		);
	}

	private async beginNoDispatchSection(
		tx: Tx,
		input: BeginFileChangeOperation,
		values: ReturnType<typeof E.normalizeOperation>,
		terminal: {
			executionOutcome: "interrupted" | "failed";
			effectOutcome: "no_change";
			settlement: "settled";
			coverage: "complete";
			attributionGrade: "unknown";
			preparedEffectCount: number;
			settledEffectCount: number;
			unresolvedEffectCount: number;
			evidenceBytes: number;
			reason: string;
		},
	): Promise<FileChangeOperationRecord> {
		const toolRows = await tx
			.select({
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
				operationId: narratorToolCalls.fileChangeOperationId,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, values.sourceId));
		const tool = toolRows[0];
		if (
			!tool ||
			tool.version !== 1 ||
			tool.origin !== null ||
			tool.checkpoint ||
			tool.attempt !== values.attempt ||
			tool.narratorId !== values.narratorId ||
			tool.toolUseId !== values.toolUseId ||
			!["Write", "Edit"].includes(tool.toolName) ||
			tool.deviceId !== input.executionBinding.deviceId ||
			tool.generation !== input.executionBinding.runtimeGeneration
		) {
			throw E.fail(
				"IDENTITY_CONFLICT",
				"No-dispatch proof does not match an actual frozen file-tool attempt",
			);
		}
		const existingRows = (await tx
			.select()
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.sourceInstanceId, values.sourceInstanceId),
					eq(fileChangeOperations.sourceKind, values.sourceKind),
					eq(fileChangeOperations.sourceId, values.sourceId),
					eq(fileChangeOperations.attempt, values.attempt),
				),
			)) as FileChangeOperationRecord[];
		const existing = existingRows[0];
		if (existing) {
			const expected = { ...values, ...terminal };
			const hasEffects = await this.effectExists(tx, existing.id, sql`true`);
			if (
				tool.operationId !== existing.id ||
				!Object.entries(expected).every(([key, value]) =>
					E.jsonEqual(existing[key as keyof FileChangeOperationRecord], value),
				) ||
				hasEffects
			) {
				throw E.fail(
					"REQUEST_CONFLICT",
					"An existing execution attempt cannot become a no-dispatch operation",
				);
			}
			return existing;
		}
		if (tool.operationId !== null || tool.status !== "running" || tool.startedAt === null) {
			throw E.fail(
				"INVALID_TRANSITION",
				"No-dispatch evidence must be recorded by the live claimed tool attempt",
			);
		}
		const timestamp = this.now();
		const row = {
			...values,
			...terminal,
			id: generateId(),
			startedAt: timestamp,
			finishedAt: timestamp,
			updatedAt: timestamp,
		};
		E.assertMetadata(row);
		const inserted = await tx.insert(fileChangeOperations).values(row).returning();
		const recorded = inserted[0] as FileChangeOperationRecord | undefined;
		if (!recorded) throw E.fail("JOURNAL_UNAVAILABLE", "Operation insert returned no row");
		const linked = await tx
			.update(narratorToolCalls)
			.set({ fileChangeOperationId: recorded.id })
			.where(
				and(
					eq(narratorToolCalls.id, tool.id),
					eq(narratorToolCalls.executionAttempt, values.attempt),
					isNull(narratorToolCalls.fileChangeOperationId),
				),
			)
			.returning({ id: narratorToolCalls.id });
		if (!linked[0]) {
			throw E.fail("REQUEST_CONFLICT", "Tool attempt was already linked to other evidence");
		}
		return E.boundedRecord(recorded);
	}

	async beginOperation(input: BeginFileChangeOperation): Promise<FileChangeOperationRecord> {
		const values = E.normalizeOperation(input);
		return withPgRetry(
			() => this.database.transaction((tx) => this.beginOperationSection(tx, values)),
			{ label: "evidence.beginOperation" },
		);
	}

	private async beginOperationSection(
		tx: Tx,
		values: ReturnType<typeof E.normalizeOperation>,
	): Promise<FileChangeOperationRecord> {
		const existingRows = (await tx
			.select()
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.sourceInstanceId, values.sourceInstanceId),
					eq(fileChangeOperations.sourceKind, values.sourceKind),
					eq(fileChangeOperations.sourceId, values.sourceId),
					eq(fileChangeOperations.attempt, values.attempt),
				),
			)) as FileChangeOperationRecord[];
		const existing = existingRows[0];
		if (existing) {
			for (const key of Object.keys(values) as (keyof typeof values)[]) {
				if (!E.jsonEqual(existing[key], values[key])) {
					throw E.fail(
						"REQUEST_CONFLICT",
						"An execution attempt cannot change its request or actor",
					);
				}
			}
			return existing;
		}
		const timestamp = this.now();
		await tx.insert(fileHistoryClock).values({ id: 1, lastSeq: 0 }).onConflictDoNothing();
		const clocks = await tx
			.update(fileHistoryClock)
			.set({ lastSeq: sql`${fileHistoryClock.lastSeq} + 1` })
			.where(eq(fileHistoryClock.id, 1))
			.returning({ lastSeq: fileHistoryClock.lastSeq });
		const clock = clocks[0];
		if (!clock) throw E.fail("JOURNAL_UNAVAILABLE", "File history clock is not initialized");
		const row = {
			...values,
			id: generateId(),
			journalSeq: clock.lastSeq,
			startedAt: timestamp,
			updatedAt: timestamp,
		};
		E.assertMetadata(row);
		const inserted = await tx.insert(fileChangeOperations).values(row).returning();
		const record = inserted[0] as FileChangeOperationRecord | undefined;
		if (!record) throw E.fail("JOURNAL_UNAVAILABLE", "Operation insert returned no row");
		return E.boundedRecord(record);
	}

	/** At most 32 effects per transaction. Repeating the exact batch is safe. */
	async prepareEffects(
		operationId: string,
		inputs: PrepareFileChangeEffect[],
	): Promise<FileChangeEffectRecord[]> {
		E.assertString(operationId, "operationId");
		E.assertInteger(inputs.length, "batch size", 1, FILE_CHANGE_PREPARE_BATCH_ITEMS);
		const normalized = inputs.map(E.normalizeEffect);
		return withPgRetry(
			() =>
				this.database.transaction((tx) => this.prepareEffectsSection(tx, operationId, normalized)),
			{ label: "evidence.prepareEffects" },
		);
	}

	private async prepareEffectsSection(
		tx: Tx,
		operationId: string,
		normalized: ReturnType<typeof E.normalizeEffect>[],
	): Promise<FileChangeEffectRecord[]> {
		let operation = await this.requireOperation(tx, operationId);
		assertEvidenceJournal(operation);
		// Captured while narrowed: the bump re-reads the same row's declared count
		// each iteration, and the assertion above already proved it non-null.
		const expectedEffectCount = operation.expectedEffectCount;
		const results: FileChangeEffectRecord[] = [];
		for (const input of normalized) {
			const mutationId = E.mutationKey(operation, input.fileKey, input.phase);
			const values = {
				operationId,
				scopeId: input.identity.scopeId,
				fileKey: input.fileKey,
				identityJson: input.identity,
				scopeRevision: input.scopeRevision,
				mutationId,
				requestDigest: input.requestDigest,
				phase: input.phase,
				beforeStateJson: input.before,
				intendedAfterStateJson: input.intendedAfter,
				beforeBlobDigest: E.stateBlob(input.before)?.digest ?? null,
				intendedAfterBlobDigest: E.stateBlob(input.intendedAfter)?.digest ?? null,
			};
			const existingRows = (await tx
				.select()
				.from(fileChangeEffects)
				.where(eq(fileChangeEffects.mutationId, mutationId))) as FileChangeEffectRecord[];
			const existing = existingRows[0];
			if (existing) {
				for (const key of Object.keys(values) as (keyof typeof values)[]) {
					if (!E.jsonEqual(existing[key], values[key])) {
						throw E.fail("REQUEST_CONFLICT", "A mutation cannot change its prepared evidence");
					}
				}
				results.push(existing);
				continue;
			}
			if (operation.settlement !== "preparing" || operation.executionOutcome !== "running") {
				throw E.fail("INVALID_TRANSITION", "Only a preparing operation may add effects");
			}
			if (operation.preparedEffectCount >= expectedEffectCount) {
				throw E.fail("INCOMPLETE_SET", "Effects exceed the fixed declared target set");
			}
			await this.assertEffectScope(tx, operation, input.identity, input.scopeRevision, false);
			await this.assertReadyStates(tx, [input.before, input.intendedAfter]);
			// Deliberately count each referenced before+intended size, without global dedup/SUM.
			const evidenceBytes =
				operation.evidenceBytes + E.stateBytes(input.before) + E.stateBytes(input.intendedAfter);
			E.assertEvidenceBudget(evidenceBytes);
			const timestamp = this.now();
			const row = {
				...values,
				journalSeq: operation.journalSeq,
				id: generateId(),
				observedAfterStateJson: E.unknownAfter(),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			E.assertMetadata(row);
			const inserted = await tx.insert(fileChangeEffects).values(row).returning();
			const record = inserted[0] as FileChangeEffectRecord | undefined;
			if (!record) throw E.fail("JOURNAL_UNAVAILABLE", "Effect insert returned no row");
			results.push(E.boundedRecord(record));
			const bumped = await tx
				.update(fileChangeOperations)
				.set({
					preparedEffectCount: operation.preparedEffectCount + 1,
					evidenceBytes,
					updatedAt: timestamp,
				})
				.where(eq(fileChangeOperations.id, operationId))
				.returning();
			operation = bumped[0] as FileChangeOperationRecord;
		}
		return results;
	}

	/** Convenience for a fully enumerated set; still yields between bounded transactions. */
	async prepareOperation(
		input: BeginFileChangeOperation & { effects: PrepareFileChangeEffect[] },
		options: { signal?: AbortSignal } = {},
	): Promise<FileChangeOperationRecord> {
		options.signal?.throwIfAborted();
		E.assertInteger(input.effects.length, "effects length", 1, FILE_CHANGE_LIMITS.revertFiles);
		if (input.effects.length !== input.expectedEffectCount) {
			throw E.fail("INCOMPLETE_SET", "Expected effect count does not match the complete input");
		}
		// Reject the whole over-budget request before persisting a prefix.
		let bytes = 0;
		const keys = new Set<string>();
		const effects: PrepareFileChangeEffect[] = [];
		for (const raw of input.effects) {
			const effect = E.normalizeEffect(raw);
			const key = `${effect.fileKey}:${effect.phase}`;
			if (keys.has(key))
				throw E.fail("REQUEST_CONFLICT", "The fixed effect set contains duplicates");
			keys.add(key);
			effects.push(effect);
			bytes += E.stateBytes(effect.before) + E.stateBytes(effect.intendedAfter);
			E.assertEvidenceBudget(bytes);
		}
		options.signal?.throwIfAborted();
		const operation = await this.beginOperation(input);
		for (let offset = 0; offset < effects.length; offset += FILE_CHANGE_PREPARE_BATCH_ITEMS) {
			options.signal?.throwIfAborted();
			await this.prepareEffects(
				operation.id,
				effects.slice(offset, offset + FILE_CHANGE_PREPARE_BATCH_ITEMS),
			);
			await yieldToEventLoop();
		}
		return this.finalizePreparation(operation.id, options);
	}

	/** An effect's durable flag can be committed a page at a time; the OPERATION gates on all. */
	async finalizePreparation(
		operationId: string,
		options: { signal?: AbortSignal } = {},
	): Promise<FileChangeOperationRecord> {
		E.assertString(operationId, "operationId");
		let cursor: FileChangeEffectCursor | undefined;
		let verifiedEffectCount = 0;
		for (;;) {
			options.signal?.throwIfAborted();
			const page = await withPgRetry(
				() =>
					this.database.transaction((tx) =>
						this.finalizePreparationPageSection(tx, operationId, cursor),
					),
				{ label: "evidence.finalizePreparation.page" },
			);
			if (!page) break;
			const last = page.at(-1);
			if (!last) break;
			verifiedEffectCount += page.length;
			E.assertInteger(verifiedEffectCount, "verified effects", 0, FILE_CHANGE_LIMITS.revertFiles);
			cursor = E.effectCursor(last);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		return withPgRetry(
			() =>
				this.database.transaction((tx) =>
					this.finalizePreparationCommitSection(tx, operationId, verifiedEffectCount),
				),
			{ label: "evidence.finalizePreparation.commit" },
		);
	}

	private async finalizePreparationPageSection(
		tx: Tx,
		operationId: string,
		cursor: FileChangeEffectCursor | undefined,
	): Promise<FileChangeEffectRecord[] | null> {
		const operation = await this.requireOperation(tx, operationId);
		assertEvidenceJournal(operation);
		if (operation.settlement !== "preparing") return null;
		if (
			operation.executionOutcome !== "running" ||
			operation.preparedEffectCount !== operation.expectedEffectCount
		) {
			throw E.fail(
				"INCOMPLETE_SET",
				"Every declared effect must be prepared before intent becomes durable",
			);
		}
		const effects = await this.selectEffects(
			tx,
			operationId,
			cursor,
			FILE_CHANGE_PREPARE_BATCH_ITEMS,
		);
		for (const effect of effects) {
			if (effect.settlement !== "preparing" && effect.settlement !== "intent_durable") {
				throw E.fail("INVALID_TRANSITION", "A preparing operation contains an attempted effect");
			}
			await this.assertEffectScope(tx, operation, effect.identityJson, effect.scopeRevision, true);
			E.assertKnownPreparedStates(effect);
			await this.assertReadyStates(tx, [effect.beforeStateJson, effect.intendedAfterStateJson]);
			await tx
				.update(fileChangeEffects)
				.set({ settlement: "intent_durable", updatedAt: this.now() })
				.where(eq(fileChangeEffects.id, effect.id));
		}
		return effects;
	}

	private async finalizePreparationCommitSection(
		tx: Tx,
		operationId: string,
		verifiedEffectCount: number,
	): Promise<FileChangeOperationRecord> {
		const operation = await this.requireOperation(tx, operationId);
		assertEvidenceJournal(operation);
		if (operation.settlement !== "preparing") return operation;
		if (
			operation.executionOutcome !== "running" ||
			operation.preparedEffectCount !== operation.expectedEffectCount ||
			verifiedEffectCount !== operation.expectedEffectCount ||
			(await this.effectExists(tx, operationId, ne(fileChangeEffects.settlement, "intent_durable")))
		) {
			throw E.fail("INCOMPLETE_SET", "The operation's complete intent is not durable");
		}
		const updated = await tx
			.update(fileChangeOperations)
			.set({ settlement: "intent_durable", coverage: "complete", updatedAt: this.now() })
			.where(eq(fileChangeOperations.id, operationId))
			.returning();
		const record = updated[0] as FileChangeOperationRecord | undefined;
		if (!record) throw E.fail("NOT_FOUND", "File-change operation not found");
		return record;
	}

	/** Only the first successful durable transition grants mayExecute=true. */
	async markApplying(
		input: FileChangeEffectSelector & { executionBinding: FileChangeExecutionBinding },
	): Promise<{ effect: FileChangeEffectRecord; mayExecute: boolean }> {
		E.validateSelector(input);
		const binding = E.normalizeBinding(input.executionBinding);
		return withPgRetry(
			() => this.database.transaction((tx) => this.markApplyingSection(tx, input, binding)),
			{ label: "evidence.markApplying" },
		);
	}

	private async markApplyingSection(
		tx: Tx,
		input: FileChangeEffectSelector & { executionBinding: FileChangeExecutionBinding },
		binding: FileChangeExecutionBinding,
	): Promise<{ effect: FileChangeEffectRecord; mayExecute: boolean }> {
		const operation = await this.requireOperation(tx, input.operationId);
		assertEvidenceJournal(operation);
		const effect = await this.requireEffect(tx, input);
		if (!fileChangeExecutionBindingMatches(operation.executionBindingJson, binding)) {
			throw E.fail("STALE_BINDING", "Execution binding changed after preparation");
		}
		if (["applying", "settled", "reconcile_required"].includes(effect.settlement)) {
			return { effect, mayExecute: false };
		}
		if (
			(operation.settlement !== "intent_durable" && operation.settlement !== "applying") ||
			operation.executionOutcome !== "running" ||
			effect.settlement !== "intent_durable"
		) {
			throw E.fail(
				"INVALID_TRANSITION",
				"The complete operation intent must be durable before applying",
			);
		}
		await this.assertEffectScope(tx, operation, effect.identityJson, effect.scopeRevision, true);
		E.assertKnownPreparedStates(effect);
		await this.assertReadyStates(tx, [effect.beforeStateJson, effect.intendedAfterStateJson]);
		const timestamp = this.now();
		await tx
			.update(fileChangeOperations)
			.set({ settlement: "applying", updatedAt: timestamp })
			.where(eq(fileChangeOperations.id, operation.id));
		const applied = await tx
			.update(fileChangeEffects)
			.set({ settlement: "applying", updatedAt: timestamp })
			.where(eq(fileChangeEffects.id, effect.id))
			.returning();
		const record = applied[0] as FileChangeEffectRecord | undefined;
		if (!record) throw E.fail("NOT_FOUND", "Effect does not belong to this operation");
		return { effect: record, mayExecute: true };
	}

	async settleEffect(input: SettleFileChangeEffect): Promise<FileChangeEffectRecord> {
		E.validateSelector(input);
		const receipt = input.receipt === null ? null : E.normalizeReceipt(input.receipt);
		const observedAfter = E.normalizeState(
			input.observedAfter === undefined
				? (receipt?.observedAfter ?? E.unknownAfter())
				: input.observedAfter,
		);
		const linesAdded = E.nullableLines(input.linesAdded);
		const linesRemoved = E.nullableLines(input.linesRemoved);
		const requestedCeiling = input.attributionCeiling;
		if (
			requestedCeiling !== undefined &&
			!["measured", "observed_ambiguous", "unknown"].includes(requestedCeiling)
		) {
			throw E.fail("INVALID_INPUT", "Invalid attribution confidence ceiling");
		}
		if (receipt && !E.jsonEqual(receipt.observedAfter, observedAfter)) {
			throw E.fail("RECEIPT_CONFLICT", "The observed state must be the receipt's own observation");
		}
		const receiptDigest = receipt === null ? null : E.digest(receipt);
		return withPgRetry(
			() =>
				this.database.transaction((tx) =>
					this.settleEffectSection(
						tx,
						input,
						receipt,
						observedAfter,
						linesAdded,
						linesRemoved,
						requestedCeiling,
						receiptDigest,
					),
				),
			{ label: "evidence.settleEffect" },
		);
	}

	private async settleEffectSection(
		tx: Tx,
		input: SettleFileChangeEffect,
		receipt: FileChangeExecutionReceipt | null,
		observedAfter: FileChangeState,
		linesAdded: number | null,
		linesRemoved: number | null,
		requestedCeiling: SettleFileChangeEffect["attributionCeiling"],
		receiptDigest: string | null,
	): Promise<FileChangeEffectRecord> {
		const operation = await this.requireOperation(tx, input.operationId);
		assertEvidenceJournal(operation);
		const effect = await this.requireEffect(tx, input);
		if (
			receipt &&
			(receipt.mutationId !== effect.mutationId ||
				receipt.requestDigest !== effect.requestDigest ||
				!fileChangeExecutionBindingMatches(
					operation.executionBindingJson,
					receipt.executionBinding,
				))
		) {
			throw E.fail("RECEIPT_CONFLICT", "Receipt identity does not match the durable intent");
		}
		const attributionCeiling = E.settlementAttributionCeiling(effect, requestedCeiling);
		const noChange = fileChangeStatesEqual(effect.beforeStateJson, observedAfter);
		const executionConfirmed = !!receipt?.confirmed && receipt.outcome !== "unknown";
		const confirmedNotApplied = executionConfirmed && receipt?.outcome === "not_applied";
		const measured =
			executionConfirmed &&
			receipt?.outcome === "applied" &&
			effect.beforeStateJson.kind !== "unknown" &&
			fileChangeStatesEqual(effect.intendedAfterStateJson, observedAfter);
		const resolved = measured || confirmedNotApplied;
		const attributionGrade =
			attributionCeiling === "unknown"
				? "unknown"
				: measured && attributionCeiling === "measured"
					? "measured"
					: observedAfter.kind === "unknown"
						? "unknown"
						: "observed_ambiguous";
		// not_applied is evidence about THIS mutation, not about a before→observation delta.
		const outcome =
			confirmedNotApplied || (measured && noChange)
				? "no_change"
				: measured
					? "changed"
					: "unknown";
		const values = {
			observedAfterStateJson: observedAfter,
			observedAfterBlobDigest: E.stateBlob(observedAfter)?.digest ?? null,
			executionReceiptJson: receipt,
			executionReceiptDigest: receiptDigest,
			executionConfirmed,
			outcome,
			attributionGrade,
			// Existing pre-column receipts stay byte-for-byte/field-for-field frozen.
			attributionCeiling:
				effect.executionReceiptDigest !== null && effect.attributionCeiling === null
					? null
					: attributionCeiling,
			settlement: resolved ? ("settled" as const) : ("reconcile_required" as const),
			linesAdded: confirmedNotApplied
				? 0
				: attributionGrade === "measured"
					? noChange
						? 0
						: linesAdded
					: null,
			linesRemoved: confirmedNotApplied
				? 0
				: attributionGrade === "measured"
					? noChange
						? 0
						: linesRemoved
					: null,
		} satisfies Partial<FileChangeEffectRecord>;
		if (effect.executionReceiptDigest !== null) {
			if (
				effect.executionReceiptDigest !== receiptDigest ||
				!Object.entries(values).every(([key, value]) =>
					E.jsonEqual(effect[key as keyof FileChangeEffectRecord], value),
				)
			) {
				throw E.fail(
					"RECEIPT_CONFLICT",
					"An existing receipt or its evidence cannot be overwritten",
				);
			}
			return effect;
		}
		if (effect.settlement !== "applying" && effect.settlement !== "reconcile_required") {
			throw E.fail("INVALID_TRANSITION", "Only an attempted effect can receive execution evidence");
		}
		if (
			effect.observedAfterStateJson.kind !== "unknown" &&
			!E.jsonEqual(effect.observedAfterStateJson, observedAfter)
		) {
			throw E.fail("RECEIPT_CONFLICT", "A previously recorded observation cannot be overwritten");
		}
		await this.assertReadyStates(tx, [
			effect.beforeStateJson,
			effect.intendedAfterStateJson,
			observedAfter,
		]);
		const newObservedBytes =
			effect.observedAfterStateJson.kind === "unknown" &&
			!fileChangeStatesEqual(effect.intendedAfterStateJson, observedAfter)
				? E.stateBytes(observedAfter)
				: 0;
		const evidenceBytes = operation.evidenceBytes + newObservedBytes;
		E.assertEvidenceBudget(evidenceBytes);
		E.assertMetadata({ ...effect, ...values });
		const timestamp = this.now();
		const settledRows = await tx
			.update(fileChangeEffects)
			.set({ ...values, updatedAt: timestamp })
			.where(eq(fileChangeEffects.id, effect.id))
			.returning();
		const settled = settledRows[0] as FileChangeEffectRecord | undefined;
		if (!settled) throw E.fail("NOT_FOUND", "Effect does not belong to this operation");
		const updated = {
			...operation,
			evidenceBytes,
			settledEffectCount: operation.settledEffectCount + (resolved ? 1 : 0),
			unresolvedEffectCount:
				operation.unresolvedEffectCount +
				(resolved ? 0 : 1) -
				(effect.settlement === "reconcile_required" ? 1 : 0),
		};
		const aggregate = await this.operationAggregate(tx, updated);
		await tx
			.update(fileChangeOperations)
			.set({
				...aggregate,
				evidenceBytes,
				settledEffectCount: updated.settledEffectCount,
				unresolvedEffectCount: updated.unresolvedEffectCount,
				updatedAt: timestamp,
			})
			.where(eq(fileChangeOperations.id, operation.id));
		return settled;
	}

	private async operationAggregate(
		tx: Tx,
		operation: FileChangeOperationRecord,
	): Promise<
		Pick<
			FileChangeOperationRecord,
			"settlement" | "effectOutcome" | "attributionGrade" | "coverage" | "reason"
		>
	> {
		// The aggregate reads are EXISTS probes, one per condition — the same probes
		// the SQLite service issues through its synchronous executor.
		const complete =
			operation.expectedEffectCount !== null &&
			operation.preparedEffectCount === operation.expectedEffectCount;
		const allSettled = complete && operation.settledEffectCount === operation.expectedEffectCount;
		const ambiguous = await this.effectExists(
			tx,
			operation.id,
			eq(fileChangeEffects.attributionGrade, "observed_ambiguous"),
		);
		const unmeasured = await this.effectExists(
			tx,
			operation.id,
			ne(fileChangeEffects.attributionGrade, "measured"),
		);
		const changed = await this.effectExists(
			tx,
			operation.id,
			eq(fileChangeEffects.outcome, "changed"),
		);
		const terminal = operation.executionOutcome !== "running";
		const unresolved = operation.unresolvedEffectCount > 0 || (terminal && !allSettled);
		return {
			settlement:
				allSettled && terminal
					? "settled"
					: operation.settlement === "preparing"
						? "preparing"
						: unresolved
							? "reconcile_required"
							: "applying",
			effectOutcome: unresolved
				? "unknown"
				: allSettled
					? changed
						? "changed"
						: "no_change"
					: "pending",
			attributionGrade:
				allSettled && !unmeasured ? "measured" : ambiguous ? "observed_ambiguous" : "unknown",
			coverage: allSettled
				? "complete"
				: unresolved
					? "partial"
					: complete
						? "complete"
						: "unavailable",
			reason: unresolved ? "result_unknown" : null,
		};
	}

	/** Tool/process outcome is separate from actual file effects, including failed-but-written. */
	async finishOperation(
		operationId: string,
		outcome: Exclude<FileChangeExecutionOutcome, "running">,
	): Promise<FileChangeOperationRecord> {
		E.assertString(operationId, "operationId");
		if (!["succeeded", "failed", "interrupted"].includes(outcome)) {
			throw E.fail("INVALID_INPUT", "A terminal execution outcome is required");
		}
		return withPgRetry(
			() =>
				this.database.transaction((tx) => this.finishOperationSection(tx, operationId, outcome)),
			{ label: "evidence.finishOperation" },
		);
	}

	private async finishOperationSection(
		tx: Tx,
		operationId: string,
		outcome: Exclude<FileChangeExecutionOutcome, "running">,
	): Promise<FileChangeOperationRecord> {
		const operation = await this.requireOperation(tx, operationId);
		assertEvidenceJournal(operation);
		if (operation.executionOutcome !== "running") {
			if (operation.executionOutcome !== outcome) {
				throw E.fail("REQUEST_CONFLICT", "A terminal execution outcome is immutable");
			}
			return operation;
		}
		const updated = { ...operation, executionOutcome: outcome };
		const aggregate = await this.operationAggregate(tx, updated);
		const rows = await tx
			.update(fileChangeOperations)
			.set({
				...aggregate,
				executionOutcome: outcome,
				finishedAt: this.now(),
				updatedAt: this.now(),
			})
			.where(eq(fileChangeOperations.id, operationId))
			.returning();
		const record = rows[0] as FileChangeOperationRecord | undefined;
		if (!record) throw E.fail("NOT_FOUND", "File-change operation not found");
		return record;
	}

	// ── reads (same shapes as the SQLite service's read methods) ──

	async getScope(scopeId: string): Promise<FileChangeScopeRecord | null> {
		E.assertString(scopeId, "scopeId");
		const rows = (await this.database
			.select()
			.from(fileChangeScopes)
			.where(eq(fileChangeScopes.id, scopeId))) as FileChangeScopeRecord[];
		return rows[0] ?? null;
	}

	async getOperation(operationId: string): Promise<FileChangeOperationRecord | null> {
		E.assertString(operationId, "operationId");
		const rows = (await this.database
			.select()
			.from(fileChangeOperations)
			.where(eq(fileChangeOperations.id, operationId))) as FileChangeOperationRecord[];
		return rows[0] ?? null;
	}

	async getEffect(operationId: string, mutationId: string): Promise<FileChangeEffectRecord | null> {
		E.assertString(operationId, "operationId");
		E.assertString(mutationId, "mutationId");
		const rows = (await this.database
			.select()
			.from(fileChangeEffects)
			.where(
				and(
					eq(fileChangeEffects.operationId, operationId),
					eq(fileChangeEffects.mutationId, mutationId),
				),
			)) as FileChangeEffectRecord[];
		return rows[0] ?? null;
	}

	async listEffects(
		operationId: string,
		options: { cursor?: FileChangeEffectCursor; limit?: number } = {},
	) {
		E.assertString(operationId, "operationId");
		const limit = E.pageLimit(options.limit);
		E.validateEffectCursor(options.cursor);
		const rows = await this.selectEffects(
			this.database as unknown as RootQueryable,
			operationId,
			options.cursor,
			limit + 1,
		);
		return E.boundedPage(rows, limit, E.effectCursor);
	}
}

// Re-exported so callers name the same vocabulary the SQLite service produces.
export { FileChangeEvidenceError };

/**
 * Compose the store over a caller-supplied handle. Nothing here opens a
 * connection — tests and the future composition root build their own.
 */
export function createPostgresFileChangeEvidenceStore(
	database: BunSQLDatabase,
	now?: () => string,
): PostgresFileChangeEvidenceStore {
	return new PostgresFileChangeEvidenceStore(database, now);
}
