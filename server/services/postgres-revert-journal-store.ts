/**
 * PostgreSQL counterpart of `RevertMutationJournal`'s atomic write sections
 * (`revert-mutation-journal.ts`).
 *
 * WHY A SIBLING, NOT A FLAG
 * -------------------------
 * The SQLite journal is strictly synchronous end to end: `claim` returns its claim
 * directly, `commit` runs the caller's history callback INSIDE its own synchronous
 * transaction and rejects any Promise from it. A networked driver cannot satisfy
 * that shape — an `await` inside a `bun:sqlite` callback commits at the first
 * suspension (`server/db/transaction-atomicity-contract.test.ts`). So the
 * PostgreSQL counterpart is its own module with honestly async methods, sharing
 * with the SQLite journal the section CONTENT and the dialect-free core
 * (`revertJournalInternals`: receipt/journal decoding, verdicts, budgets, hashing).
 * What is rewritten here is the dialect shape:
 *
 *   - `sql`${col} IS ${value}`` → `IS NOT DISTINCT FROM` (the `IS` idiom is
 *     SQLite-only — see `postgres-revert-plan-store.ts` for the same rewrite);
 *   - `json_extract(...)` → `(col::jsonb #>> '{…}')::bigint`;
 *   - `.get()/.run()/.all()` chaining → awaited statements;
 *   - the durability-boundary checks (`PRAGMA foreign_keys`, `PRAGMA busy_timeout`,
 *     `$client.inTransaction`) have no PG counterpart: foreign keys are always
 *     enforced, lock waits are the server's business (the whole-section retry —
 *     not a multi-second busy handler — is the contention answer), and "no
 *     ambient transaction" is structural because every method opens its OWN
 *     `db.transaction` through `withPgRetry`.
 *
 * THE HISTORY COMMIT ON POSTGRESQL
 * --------------------------------
 * `commit` keeps the SQLite journal's central guarantee — the history callback
 * and the committed marker EITHER BOTH COMMIT OR BOTH ROLL BACK — with one shape
 * change: the callback is ASYNC and receives the live PG transaction. The same
 * rules apply: an already committed retry never calls history a second time (the
 * status re-check inside the section returns early), the callback runs before the
 * marker update, and any rejection rolls both back. Whole-section retry replays
 * the section ONLY before its first commit; after a lost commit acknowledgement
 * the re-check turns the replay into a no-op returning the committed row — so the
 * history callback still runs at most once per logical commit, exactly the
 * exactly-once boundary `server/db/pg-retry.ts` defines.
 */

import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { withPgRetry } from "@server/db/pg-retry";
import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	revertOperationFiles as files,
	revertOperations as operations,
	fileChangeScopes as scopes,
} from "@server/db/postgres-schema";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeExecutionReceipt,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	revertOperationFiles as sqliteRevertOperationFiles,
	revertOperations as sqliteRevertOperations,
} from "../db/schema";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import { createFileChangeIdentity } from "./file-change-identity";
import type { PostgresRevertPlanStore } from "./postgres-revert-plan-store";
import type { RevertJournalClaim, RevertJournalContext } from "./revert-mutation-journal";
import {
	revertJournalInternals as J,
	REVERT_JOURNAL_BATCH_ITEMS,
	RevertMutationJournalError,
} from "./revert-mutation-journal";
import type { RevertPlanFileMetadata, RevertPlanManifestProof } from "./revert-plan-service";
import type { WorkspaceWriteLease } from "./workspace-write-coordinator";

/** Transaction handle as produced by `db.transaction(async (tx) => …`. PG-side only. */
type Tx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
/** Same row-shape equivalence argument as `postgres-revert-plan-store.ts`. */
type OperationRecord = typeof sqliteRevertOperations.$inferSelect;
type FileRecord = typeof sqliteRevertOperationFiles.$inferSelect;
type Phase = "apply" | "compensate";
type Scan = {
	operation: OperationRecord;
	bytes: number;
	count: number;
	applied: number;
	allAppliedVerified: boolean;
	allCompensated: boolean;
};

/**
 * The history commit a caller supplies on PostgreSQL: an ASYNC callback over the
 * live transaction. `db` must be the same root handle the journal holds (the
 * object-identity check the SQLite journal makes, in the one spelling available
 * here).
 */
export interface PostgresRevertJournalHistoryCommit {
	db: BunSQLDatabase;
	apply(tx: Tx): Promise<void>;
}

/** The `IS` idiom, in PG spelling: null-safe equality. */
function isNotDistinctFrom(column: unknown, value: unknown) {
	return sql`${column} IS NOT DISTINCT FROM ${value}`;
}

/**
 * The PostgreSQL revert mutation journal. Same options as the SQLite journal;
 * `database` must be a ROOT handle — sections open their own transactions.
 */
export class PostgresRevertMutationJournal {
	private readonly now: () => string;
	private readonly namespaceKey: string;
	private readonly plans: PostgresRevertPlanStore;

	constructor(
		private readonly database: BunSQLDatabase,
		options: { namespaceKey: string; now?: () => string },
		plans: PostgresRevertPlanStore,
	) {
		J.text(options.namespaceKey);
		this.namespaceKey = options.namespaceKey;
		this.now = options.now ?? (() => new Date().toISOString());
		this.plans = plans;
	}

	private timestamp(previous?: string) {
		const now = Date.parse(this.now());
		if (!Number.isFinite(now)) throw J.fail("INVALID_INPUT", "Invalid clock");
		return new Date(Math.max(now, previous ? Date.parse(previous) + 1 : now)).toISOString();
	}

	// ── in-section guards (PG spellings of the SQLite journal's private helpers) ──

	private async namespace(tx: Tx) {
		const rows = await tx
			.select({ status: budgets.status, namespaceKey: budgets.namespaceKey })
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID));
		const row = rows[0];
		if (row?.status !== "ready" || row.namespaceKey !== this.namespaceKey) {
			throw J.fail("CATALOG_UNVERIFIED", "The physical evidence namespace must be ready");
		}
	}

	private async catalogRef(tx: Tx, digestValue: string | null): Promise<FileChangeBlobRef> {
		if (digestValue === null) throw J.fail("LEGACY_UNVERIFIED", "A manifest reference is missing");
		J.sha256(digestValue);
		const rows = await tx
			.select({ digest: blobs.digest, sizeBytes: blobs.sizeBytes, status: blobs.status })
			.from(blobs)
			.where(eq(blobs.digest, digestValue));
		const row = rows[0];
		if (!row || row.status !== "ready") throw J.fail("BLOB_NOT_READY", "A raw object is not ready");
		J.integer(row.sizeBytes, 0, FILE_CHANGE_LIMITS.blobBytes);
		return { algorithm: "sha256", digest: row.digest, sizeBytes: row.sizeBytes };
	}

	private async manifests(tx: Tx, operation: OperationRecord): Promise<number> {
		await this.namespace(tx);
		let sum = 0;
		for (const digestValue of [
			operation.planBlobDigest,
			operation.selectorBlobDigest,
			operation.historyManifestBlobDigest,
		]) {
			sum += (await this.catalogRef(tx, digestValue)).sizeBytes;
		}
		return sum;
	}

	private async readyState(tx: Tx, state: FileChangeState) {
		const ref = J.stateRef(J.normalizeState(state));
		if (ref && !J.equal(ref, await this.catalogRef(tx, ref.digest))) {
			throw J.fail(
				"BLOB_NOT_READY",
				"Raw evidence size does not match its ready catalog reference",
			);
		}
	}

	private async requireOperation(tx: Tx, ctx: RevertJournalContext): Promise<OperationRecord> {
		const rows = (await tx
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.id, ctx.planId),
					eq(operations.requestedBySubjectKey, ctx.owner.subjectKey),
					isNotDistinctFrom(operations.narratorId, ctx.owner.narratorId),
					isNotDistinctFrom(operations.projectId, ctx.owner.projectId),
				),
			)) as OperationRecord[];
		const row = rows[0];
		if (!row) throw J.fail("NOT_FOUND", "Plan not found in the authorized owning context");
		J.metadata(row);
		if (
			row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
			!row.coverageComplete ||
			row.expectedMessageVersion === null ||
			!row.planBlobDigest ||
			!row.selectorBlobDigest ||
			!row.historyManifestBlobDigest
		) {
			throw J.fail("LEGACY_UNVERIFIED", "A complete v2 prepared plan is required");
		}
		if (row.planHash !== ctx.planHash)
			throw J.fail("REQUEST_CONFLICT", "The fixed plan hash changed");
		J.integer(row.fileCount, 0, FILE_CHANGE_LIMITS.revertFiles);
		J.integer(row.appliedFileCount, 0, row.fileCount);
		return row;
	}

	private async requireFile(tx: Tx, operation: OperationRecord, id: string): Promise<FileRecord> {
		const rows = (await tx
			.select()
			.from(files)
			.where(and(eq(files.id, id), eq(files.revertOperationId, operation.id)))) as FileRecord[];
		const row = rows[0];
		if (!row) throw J.fail("NOT_FOUND", "File is not in the fixed plan");
		J.assertFile(operation, row);
		return row;
	}

	private async selectFiles(tx: Tx, id: string, cursor: string | undefined, limit: number) {
		return (await tx
			.select()
			.from(files)
			.where(
				and(
					eq(files.revertOperationId, id),
					cursor ? sql`${files.fileKey} > ${cursor}` : undefined,
				),
			)
			.orderBy(asc(files.fileKey))
			.limit(limit)) as FileRecord[];
	}

	private async assertPinnedReady(tx: Tx, planId: string) {
		// `json_extract(state, '$.blob.sizeBytes')` → `(state::jsonb #>> '{…}')::bigint`.
		const refs = [
			[files.beforeBlobDigest, files.expectedStateJson],
			[files.desiredBlobDigest, files.desiredStateJson],
			[files.observedAfterBlobDigest, files.observedAfterStateJson],
			[files.compensationAfterBlobDigest, files.compensationAfterStateJson],
		] as const;
		const missing = refs.map(
			([ref, state]) => sql`(${ref} IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM ${blobs} WHERE ${blobs.digest} = ${ref} AND ${blobs.status} = 'ready'
			AND ${blobs.sizeBytes} = coalesce((${state}::jsonb #>> '{blob,sizeBytes}')::bigint, (${state}::jsonb #>> '{target,sizeBytes}')::bigint)
		))`,
		);
		const unavailable = await tx
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.revertOperationId, planId), sql`(${sql.join(missing, sql` OR `)})`))
			.limit(1);
		if (unavailable[0])
			throw J.fail("BLOB_NOT_READY", "Pinned raw evidence changed during verification");
	}

	private async assertLease(tx: Tx, lease: WorkspaceWriteLease, file: FileRecord) {
		if (
			!lease ||
			lease.kind !== "rollback" ||
			typeof lease.assertCurrent !== "function" ||
			lease.overlappedUncoordinatedActivity
		) {
			throw J.fail("INVALID_LEASE", "A live rollback coordinator lease is required");
		}
		lease.assertCurrent(lease.executionBinding);
		const rows = await tx.select().from(scopes).where(eq(scopes.id, file.scopeId));
		const scope = rows[0] as (typeof scopes.$inferSelect & { status: string }) | undefined;
		if (
			!scope ||
			scope.status !== "active" ||
			!scope.activeLeaseId ||
			!scope.activeLeaseEpoch ||
			scope.id !== lease.scope.id ||
			scope.revision !== lease.scopeRevision ||
			scope.fencingToken !== lease.executionBinding.fencingToken ||
			file.identityJson.deviceId !== lease.executionBinding.deviceId
		) {
			throw J.fail("STALE_LEASE", "Lease scope, identity, revision or fencing token changed");
		}
		for (const key of [
			"id",
			"sourceInstanceId",
			"deviceId",
			"workspaceInstanceId",
			"pathFlavor",
			"canonicalRoot",
		] as const) {
			if (scope[key] !== lease.scope[key]) {
				throw J.fail("IDENTITY_CONFLICT", "Lease does not own this exact workspace incarnation");
			}
		}
		if (
			!J.equal(
				createFileChangeIdentity(
					scope as Parameters<typeof createFileChangeIdentity>[0],
					file.identityJson,
				),
				file.identityJson,
			)
		) {
			throw J.fail("IDENTITY_CONFLICT", "File identity is outside the leased scope");
		}
		J.normalizeBinding(lease.executionBinding);
	}

	private async assertPlanCommitment(
		tx: Tx,
		operation: OperationRecord,
		entries: Map<number, string>,
		fileEvidenceBytes: number,
	) {
		const ordered = createHash("sha256").update("revert-plan-ordered-files-v1\n");
		for (let i = 0; i < entries.size; i++) ordered.update(`${i}:${entries.get(i)}\n`);
		const header = {
			subjectKey: operation.requestedBySubjectKey,
			narratorId: operation.narratorId,
			projectId: operation.projectId,
			protocolVersion: operation.protocolVersion,
			idempotencyKey: operation.idempotencyKey,
			requestDigest: operation.requestDigest,
			kind: operation.kind,
			revertScope: operation.scope,
			selectorKind: operation.selectorKind,
			selector: await this.catalogRef(tx, operation.selectorBlobDigest),
			historyManifest: await this.catalogRef(tx, operation.historyManifestBlobDigest),
			expectedMessageVersion: operation.expectedMessageVersion,
			expectedFileCount: operation.fileCount,
			parentRevertId: operation.parentRevertId,
		};
		const proof = {
			source: "trusted_published_planner_v1",
			headerDigest: J.digest(header),
			orderedFilesDigest: ordered.digest("hex"),
			fileEvidenceBytes,
			computation: "complete",
			selectorCoverage: "complete",
			historyCoverage: "complete",
			omittedFiles: 0,
			unknownFiles: 0,
		};
		if (
			J.digest([
				"revert-plan-commitment-v1",
				header,
				await this.catalogRef(tx, operation.planBlobDigest),
				proof,
			]) !== operation.planHash
		) {
			throw J.fail(
				"REQUEST_CONFLICT",
				"The full fixed file set no longer matches its prepared manifest commitment",
			);
		}
	}

	private async updateOperation(
		tx: Tx,
		original: OperationRecord,
		patch: Partial<OperationRecord>,
	): Promise<OperationRecord> {
		const values = { ...patch, updatedAt: this.timestamp(original.updatedAt) };
		J.metadata({ ...original, ...values });
		const result = (await tx
			.update(operations)
			.set(values)
			.where(
				and(
					eq(operations.id, original.id),
					eq(operations.updatedAt, original.updatedAt),
					eq(operations.status, original.status),
				),
			)
			.returning()) as OperationRecord[];
		const row = result[0];
		if (!row) throw J.fail("CONCURRENT_CHANGE", "The journal revision changed");
		return row;
	}

	// ── the write operations ──

	/** A real prepared plan and its original complete proof are mandatory, including zero files. */
	async startExecution(
		ctx: RevertJournalContext,
		proof: RevertPlanManifestProof,
		options: { signal?: AbortSignal } = {},
	): Promise<{ operation: OperationRecord; started: boolean }> {
		const context = J.normalizeContext(ctx);
		const original = await this.requireOperation(this.database as unknown as Tx, context);
		if (original.status === "applying") return { operation: original, started: false };
		if (original.status !== "prepared" || !original.coverageComplete) {
			throw J.fail("INVALID_TRANSITION", "A complete prepared plan is required");
		}
		// Reuse the plan store's ordered-manifest digest, fixed refs, full-set and TTL checks.
		await this.plans.finalize(context.owner, context.planId, proof, options);
		options.signal?.throwIfAborted();
		return withPgRetry(
			() => this.database.transaction((tx) => this.startExecutionSection(tx, context, original)),
			{ label: "revertJournal.startExecution" },
		);
	}

	private async startExecutionSection(
		tx: Tx,
		context: RevertJournalContext,
		original: OperationRecord,
	) {
		const operation = await this.requireOperation(tx, context);
		J.assertRevision(original, operation);
		if (Date.parse(operation.expiresAt) <= Date.parse(this.now())) {
			throw J.fail("EXPIRED", "The prepared plan expired");
		}
		await this.manifests(tx, operation);
		await this.assertPinnedReady(tx, operation.id);
		return {
			operation: await this.updateOperation(tx, operation, { status: "applying", reason: null }),
			started: true,
		};
	}

	async claimApply(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): Promise<RevertJournalClaim> {
		return this.claim(ctx, fixed, lease, "apply");
	}

	async claimCompensate(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): Promise<RevertJournalClaim> {
		return this.claim(ctx, fixed, lease, "compensate");
	}

	private claim(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
		phase: Phase,
	): Promise<RevertJournalClaim> {
		const context = J.normalizeContext(ctx);
		J.metadata(fixed);
		J.text(fixed.id);
		return withPgRetry(
			() => this.database.transaction((tx) => this.claimSection(tx, context, fixed, lease, phase)),
			{ label: `revertJournal.claim.${phase}` },
		);
	}

	private async claimSection(
		tx: Tx,
		context: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
		phase: Phase,
	): Promise<RevertJournalClaim> {
		const operation = await this.requireOperation(tx, context);
		const file = await this.requireFile(tx, operation, fixed.id);
		J.assertFixedMetadata(file, fixed);
		const journal = J.readJournal(file);
		const old = journal[phase];
		const expected = phase === "apply" ? file.expectedStateJson : file.observedAfterStateJson;
		const desired = phase === "apply" ? file.desiredStateJson : file.expectedStateJson;
		if (!expected || expected.kind === "unknown") {
			throw J.fail("UNKNOWN_STATE", "An observed known expected state is required");
		}
		const mutationId = J.phaseId(file, phase);
		const requestDigest = J.phaseDigest(file, phase);
		if (old) {
			// Query/idempotence only, even on another connection epoch. Never replace the binding.
			return {
				file,
				mayExecute: false,
				mutationId,
				requestDigest,
				executionBinding: old.executionBinding,
				expected,
				desired,
			};
		}
		if (phase === "apply") {
			if (operation.status !== "applying" || file.status !== "prepared" || journal.compensate) {
				throw J.fail("INVALID_TRANSITION", "Only an unclaimed applying plan file may dispatch");
			}
		} else {
			if (operation.status !== "compensating") {
				throw J.fail("INVALID_TRANSITION", "The plan must explicitly enter compensation");
			}
			if (!J.compensationEligible(file, journal)) {
				throw J.fail(
					"UNSAFE_COMPENSATION",
					"Only a confirmed applied desired state can authorize compensation",
				);
			}
		}
		await this.assertLease(tx, lease, file);
		await this.manifests(tx, operation);
		for (const state of [expected, desired]) await this.readyState(tx, state);
		const binding = J.normalizeBinding(lease.executionBinding);
		journal[phase] = { executionBinding: binding, receipt: null };
		const updated = {
			...file,
			receiptJson: journal,
			status: phase === "apply" ? ("applying" as const) : ("compensating" as const),
			updatedAt: this.timestamp(file.updatedAt),
		};
		J.metadata(updated);
		const result = (await tx
			.update(files)
			.set({ receiptJson: journal, status: updated.status, updatedAt: updated.updatedAt })
			.where(eq(files.id, file.id))
			.returning()) as FileRecord[];
		const record = result[0];
		if (!record) throw J.fail("CONCURRENT_CHANGE", "The claimed file changed");
		await this.updateOperation(tx, operation, {});
		return {
			file: record,
			mayExecute: true,
			mutationId,
			requestDigest,
			executionBinding: binding,
			expected,
			desired,
		};
	}

	async recordApplyReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<FileRecord> {
		return this.recordReceipt(ctx, fileId, receipt, "apply");
	}

	async recordCompensateReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<FileRecord> {
		return this.recordReceipt(ctx, fileId, receipt, "compensate");
	}

	private async recordReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		input: FileChangeExecutionReceipt,
		phase: Phase,
	): Promise<FileRecord> {
		const context = J.normalizeContext(ctx);
		J.text(fileId);
		const receipt = J.normalizeReceipt(input);
		const original = await this.requireOperation(this.database as unknown as Tx, context);
		const originalFile = await this.requireFile(this.database as unknown as Tx, original, fileId);
		const prior = J.readJournal(originalFile)[phase];
		J.assertBoundReceipt(originalFile, prior, receipt, phase);
		if (prior?.receipt) {
			if (!J.equal(prior.receipt, receipt)) {
				throw J.fail("RECEIPT_CONFLICT", "An existing phase receipt cannot be overwritten");
			}
			return originalFile;
		}
		if (!["applying", "compensating", "recovery_required"].includes(original.status)) {
			throw J.fail("INVALID_TRANSITION", "Only an unfinished execution may receive a new receipt");
		}
		if (
			phase === "compensate" &&
			!J.compensationEligible(originalFile, J.readJournal(originalFile))
		) {
			throw J.fail("UNSAFE_COMPENSATION", "Compensation has no confirmed apply baseline");
		}
		// Total budget is bounded by the fixed plan and counted pagewise; no global SUM.
		const scan = await this.scan(context);
		return withPgRetry(
			() =>
				this.database.transaction((tx) =>
					this.recordReceiptSection(
						tx,
						context,
						original,
						originalFile,
						fileId,
						receipt,
						phase,
						scan,
					),
				),
			{ label: `revertJournal.recordReceipt.${phase}` },
		);
	}

	private async recordReceiptSection(
		tx: Tx,
		context: RevertJournalContext,
		original: OperationRecord,
		originalFile: FileRecord,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
		phase: Phase,
		scan: Scan,
	): Promise<FileRecord> {
		const operation = await this.requireOperation(tx, context);
		J.assertRevision(original, scan.operation);
		J.assertRevision(original, operation);
		const file = await this.requireFile(tx, operation, fileId);
		if (!J.equal(file, originalFile)) {
			throw J.fail("CONCURRENT_CHANGE", "The phase changed during receipt admission");
		}
		await this.namespace(tx);
		await this.readyState(tx, receipt.observedAfter);
		const journal = J.readJournal(file);
		J.assertBoundReceipt(file, journal[phase], receipt, phase);
		journal[phase] = { executionBinding: receipt.executionBinding, receipt };
		const oldBytes = J.fileBytes(file);
		const applied = phase === "apply" && receipt.confirmed && receipt.outcome === "applied";
		const after = receipt.observedAfter;
		const valid =
			phase === "apply" ? J.verifiesApply(file, receipt) : J.verifiesCompensation(file, receipt);
		const patch =
			phase === "apply"
				? {
						observedAfterStateJson: after,
						observedAfterBlobDigest: J.stateRef(after)?.digest ?? null,
					}
				: {
						compensationAfterStateJson: after,
						compensationAfterBlobDigest: J.stateRef(after)?.digest ?? null,
					};
		const status = valid
			? phase === "apply"
				? ("verified" as const)
				: ("compensated" as const)
			: applied
				? ("applied" as const)
				: ("unknown" as const);
		const updated = {
			...file,
			...patch,
			receiptJson: journal,
			status,
			reason: valid ? null : "result_unverified",
			updatedAt: this.timestamp(file.updatedAt),
		};
		J.metadata(updated);
		J.evidenceBudget(scan.bytes - oldBytes + J.fileBytes(updated));
		const result = (await tx
			.update(files)
			.set({
				...patch,
				receiptJson: journal,
				status,
				reason: updated.reason,
				updatedAt: updated.updatedAt,
			})
			.where(eq(files.id, fileId))
			.returning()) as FileRecord[];
		const record = result[0];
		if (!record) throw J.fail("CONCURRENT_CHANGE", "The receipt's file changed");
		await this.updateOperation(tx, operation, {
			appliedFileCount: scan.applied + (applied ? 1 : 0),
			// Preserve a compensation window so other proven files may still be restored.
			status:
				!valid && operation.status !== "compensating" ? "recovery_required" : operation.status,
			reason: valid ? operation.reason : "result_unverified",
		});
		return record;
	}

	/** Complete, contiguous, <=32-row pages; counts/statuses alone never prove verification. */
	async finishFiles(
		ctx: RevertJournalContext,
		options: { signal?: AbortSignal } = {},
	): Promise<OperationRecord> {
		const context = J.normalizeContext(ctx);
		const scan = await this.scan(context, options.signal);
		return withPgRetry(
			() => this.database.transaction((tx) => this.finishFilesSection(tx, context, scan)),
			{ label: "revertJournal.finishFiles" },
		);
	}

	private async finishFilesSection(
		tx: Tx,
		context: RevertJournalContext,
		scan: Scan,
	): Promise<OperationRecord> {
		const operation = await this.requireOperation(tx, context);
		J.assertRevision(scan.operation, operation);
		if (
			operation.status === "files_verified" &&
			scan.allAppliedVerified &&
			operation.appliedFileCount === scan.applied
		) {
			return operation;
		}
		if (!["applying", "recovery_required", "files_verified"].includes(operation.status)) {
			throw J.fail("INVALID_TRANSITION", "Only an applying plan can finish its files");
		}
		await this.manifests(tx, operation);
		await this.assertPinnedReady(tx, operation.id);
		return this.updateOperation(tx, operation, {
			status: scan.allAppliedVerified ? "files_verified" : "recovery_required",
			appliedFileCount: scan.applied,
			reason: scan.allAppliedVerified ? null : "files_unverified",
		});
	}

	/**
	 * Caller has just rechecked all live file states and history version under its leases.
	 * The history callback and committed marker either BOTH commit or BOTH roll back.
	 * An already committed retry never calls history a second time — see the header.
	 */
	async commit(
		ctx: RevertJournalContext,
		history?: PostgresRevertJournalHistoryCommit,
	): Promise<OperationRecord> {
		const context = J.normalizeContext(ctx);
		if (history && (history.db !== this.database || typeof history.apply !== "function")) {
			throw J.fail("DURABILITY_BOUNDARY", "History must use a callback bound to the same root DB");
		}
		return withPgRetry(
			() => this.database.transaction((tx) => this.commitSection(tx, context, history)),
			{ label: "revertJournal.commit" },
		);
	}

	private async commitSection(
		tx: Tx,
		context: RevertJournalContext,
		history: PostgresRevertJournalHistoryCommit | undefined,
	): Promise<OperationRecord> {
		const operation = await this.requireOperation(tx, context);
		if (operation.status === "committed") return operation;
		if (operation.status !== "files_verified") {
			throw J.fail(
				"INVALID_TRANSITION",
				"All file receipts must be verified before committing history",
			);
		}
		await this.manifests(tx, operation);
		await this.assertPinnedReady(tx, operation.id);
		if (history) await history.apply(tx);
		return this.updateOperation(tx, operation, { status: "committed", reason: null });
	}

	async beginCompensation(ctx: RevertJournalContext): Promise<OperationRecord> {
		const context = J.normalizeContext(ctx);
		return withPgRetry(
			() => this.database.transaction((tx) => this.beginCompensationSection(tx, context)),
			{ label: "revertJournal.beginCompensation" },
		);
	}

	private async beginCompensationSection(
		tx: Tx,
		context: RevertJournalContext,
	): Promise<OperationRecord> {
		const operation = await this.requireOperation(tx, context);
		if (operation.status === "compensating") return operation;
		if (!["applying", "files_verified", "recovery_required"].includes(operation.status)) {
			throw J.fail("INVALID_TRANSITION", "Committed or unstarted plans cannot compensate");
		}
		await this.manifests(tx, operation);
		return this.updateOperation(tx, operation, { status: "compensating" });
	}

	/** Unknown apply/compensation is never cleaned away to make this terminal. */
	async finishCompensation(
		ctx: RevertJournalContext,
		options: { signal?: AbortSignal } = {},
	): Promise<OperationRecord> {
		const context = J.normalizeContext(ctx);
		const scan = await this.scan(context, options.signal);
		return withPgRetry(
			() => this.database.transaction((tx) => this.finishCompensationSection(tx, context, scan)),
			{ label: "revertJournal.finishCompensation" },
		);
	}

	private async finishCompensationSection(
		tx: Tx,
		context: RevertJournalContext,
		scan: Scan,
	): Promise<OperationRecord> {
		const operation = await this.requireOperation(tx, context);
		J.assertRevision(scan.operation, operation);
		if (operation.status === "compensated") return operation;
		if (operation.status !== "compensating") {
			throw J.fail("INVALID_TRANSITION", "An explicit compensation window is required");
		}
		await this.manifests(tx, operation);
		await this.assertPinnedReady(tx, operation.id);
		return this.updateOperation(tx, operation, {
			status: scan.allCompensated ? "compensated" : "recovery_required",
			reason: scan.allCompensated ? null : "compensation_unverified",
			appliedFileCount: scan.applied,
		});
	}

	private async scanPageSection(
		tx: Tx,
		context: RevertJournalContext,
		original: OperationRecord,
		cursor: string | undefined,
	): Promise<FileRecord[]> {
		J.assertRevision(original, await this.requireOperation(tx, context));
		await this.namespace(tx);
		return this.selectFiles(tx, original.id, cursor, REVERT_JOURNAL_BATCH_ITEMS + 1);
	}

	private async scan(context: RevertJournalContext, signal?: AbortSignal): Promise<Scan> {
		const original = await this.requireOperation(this.database as unknown as Tx, context);
		const result: Scan = {
			operation: original,
			bytes: await this.manifests(this.database as unknown as Tx, original),
			count: 0,
			applied: 0,
			allAppliedVerified: true,
			allCompensated: true,
		};
		const sequences = new Map<number, string>();
		let plannedFileBytes = 0;
		let cursor: string | undefined;
		for (;;) {
			signal?.throwIfAborted();
			const rows = await withPgRetry(
				() =>
					this.database.transaction((tx) => this.scanPageSection(tx, context, original, cursor)),
				{ label: "revertJournal.scan.page" },
			);
			for (const row of rows.slice(0, REVERT_JOURNAL_BATCH_ITEMS)) {
				J.assertFile(original, row);
				if (sequences.has(row.sequence))
					throw J.fail("INCOMPLETE_SET", "Duplicate manifest sequence");
				sequences.set(
					row.sequence,
					J.digest({
						sequence: row.sequence,
						identity: row.identityJson,
						fileKey: row.fileKey,
						expected: J.normalizeState(row.expectedStateJson),
						desired: J.normalizeState(row.desiredStateJson),
					}),
				);
				plannedFileBytes +=
					(J.stateRef(row.expectedStateJson)?.sizeBytes ?? 0) +
					(J.stateRef(row.desiredStateJson)?.sizeBytes ?? 0);
				J.integer(++result.count, 0, original.fileCount);
				result.bytes += J.fileBytes(row);
				J.evidenceBudget(result.bytes);
				for (const state of [
					row.expectedStateJson,
					row.desiredStateJson,
					row.observedAfterStateJson,
					row.compensationAfterStateJson,
				]) {
					if (state) await this.readyState(this.database as unknown as Tx, state);
				}
				const journal = J.readJournal(row);
				const apply = journal.apply?.receipt;
				const compensate = journal.compensate?.receipt;
				if (apply?.confirmed && apply.outcome === "applied") result.applied++;
				result.allAppliedVerified &&=
					row.status === "verified" &&
					!!apply &&
					J.verifiesApply(row, apply) &&
					journal.compensate === null;
				const neverClaimed = journal.apply === null && row.status === "prepared";
				const didNotApply =
					!!apply?.confirmed && apply.outcome === "not_applied" && journal.compensate === null;
				const restored =
					J.compensationEligible(row, journal) &&
					!!compensate &&
					row.status === "compensated" &&
					J.verifiesCompensation(row, compensate);
				result.allCompensated &&= neverClaimed || didNotApply || restored;
			}
			if (rows.length <= REVERT_JOURNAL_BATCH_ITEMS) break;
			cursor = rows[REVERT_JOURNAL_BATCH_ITEMS - 1]?.fileKey;
			await yieldToEventLoop();
		}
		signal?.throwIfAborted();
		if (sequences.size !== original.fileCount) {
			throw J.fail("INCOMPLETE_SET", "The complete fixed file set is missing");
		}
		for (let i = 0; i < original.fileCount; i++) {
			if (!sequences.has(i)) throw J.fail("INCOMPLETE_SET", "A fixed manifest position is missing");
		}
		J.assertRevision(
			original,
			await this.requireOperation(this.database as unknown as Tx, context),
		);
		await this.assertPlanCommitment(
			this.database as unknown as Tx,
			original,
			sequences,
			plannedFileBytes,
		);
		return result;
	}
}

// Re-exported so callers of the PG journal name the same vocabulary the SQLite one produces.
export { RevertMutationJournalError };

/**
 * Compose the journal over caller-supplied handles. Nothing here opens a
 * connection — tests and the future composition root build their own.
 */
export function createPostgresRevertMutationJournal(
	database: BunSQLDatabase,
	options: { namespaceKey: string; now?: () => string },
	plans: PostgresRevertPlanStore,
): PostgresRevertMutationJournal {
	return new PostgresRevertMutationJournal(database, options, plans);
}
