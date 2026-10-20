import {
	assertRevision,
	canonical,
	catalogRef,
	equal,
	fail,
	integer,
	metadata,
	requireOperation,
	selectFiles,
	sha256,
} from "./revert-journal-read";

export { RevertMutationJournalError } from "./revert-journal-read";

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeExecutionBinding,
	type FileChangeExecutionReceipt,
	type FileChangeRevertMutationJournal,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
	fileChangeBlobs as blobs,
	revertOperationFiles as files,
	revertOperations as operations,
	fileChangeScopes as scopes,
} from "../db/schema";
import { readQuery, readTransactionTask } from "../db/worker-read";
import {
	createFileChangeIdentity,
	fileChangeExecutionBindingMatches,
	fileChangeIdentityKey,
} from "./file-change-identity";
import { normalizeLocalIoEvidence } from "./file-change-local-io-evidence";
import {
	type RevertJournalReadTask,
	readJournalManifests,
	readRevertJournalTask,
} from "./revert-journal-read-task";
import {
	type RevertPlanFileMetadata,
	type RevertPlanManifestProof,
	type RevertPlanOwner,
	RevertPlanService,
} from "./revert-plan-service";
import type { WorkspaceWriteLease } from "./workspace-write-coordinator";

export const REVERT_JOURNAL_BATCH_ITEMS = 32;
export type RevertJournalOperation = typeof operations.$inferSelect;
export type RevertJournalFile = typeof files.$inferSelect;
export type RevertJournalTransaction = Pick<
	BunSQLiteDatabase,
	"select" | "insert" | "update" | "delete" | "get" | "run"
>;
export type RevertJournalDatabase = RevertJournalTransaction & {
	readonly $client: Database;
	transaction<T>(body: (tx: RevertJournalTransaction) => T): T;
};
export interface RevertJournalContext {
	/** Authorized resource context, supplied again for every read/write; this is NOT an ACL. */
	owner: RevertPlanOwner;
	planId: string;
	planHash: string;
}
export interface RevertJournalOptions {
	namespaceKey: string;
	now?: () => string;
}
export interface RevertJournalClaim {
	file: RevertJournalFile;
	/** True ONLY for the first durable claim. False means reconcile, never redispatch. */
	mayExecute: boolean;
	mutationId: string;
	requestDigest: string;
	executionBinding: FileChangeExecutionBinding;
	expected: FileChangeState;
	desired: FileChangeState;
}
export interface RevertJournalHistoryCommit {
	/** Must be the same root object as the journal, not another connection/transaction. */
	db: RevertJournalDatabase;
	/** Synchronous bounded history changes using ONLY the supplied live transaction. */
	apply(tx: RevertJournalTransaction): void;
}
export interface RevertJournalPage<T, C> {
	items: T[];
	hasMore: boolean;
	nextCursor: C | null;
}
export type RevertJournalPendingStatus =
	| "applying"
	| "files_verified"
	| "compensating"
	| "recovery_required";
export interface RevertJournalPendingCursor {
	updatedAt: string;
	id: string;
}
type Phase = "apply" | "compensate";
/**
 * Running totals that a complete scan proved for ONE exact operation revision. Every journal
 * write that touches a file row also advances the operation revision in the same transaction,
 * and namespace reset rewrites the operation row too, so "cached row equals the live row" means
 * no file row changed through any sanctioned path since these totals were proven.
 */
type RunningTotals = { operation: RevertJournalOperation; bytes: number; applied: number };
/** Operations that may still receive receipts or compensation; anything else is evicted. */
const LIVE_TOTAL_STATUSES = ["applying", "files_verified", "compensating", "recovery_required"];
/** Bound on concurrently cached plans per journal; a miss only costs one complete scan. */
const MAX_CACHED_TOTALS = 64;
type Scan = {
	operation: RevertJournalOperation;
	bytes: number;
	count: number;
	applied: number;
	allAppliedVerified: boolean;
	allCompensated: boolean;
};

/**
 * Internal metadata journal: no target IO, blob-body reads, authorization, history
 * enumeration, broadcasts, automatic recovery or unrevert. Caller supplies REAL
 * coordinator leases and backend receipts, keeps raw objects published, reauthorizes,
 * and rereads live files before history commit. files_verified is receipt verification,
 * not proof that an external process has not subsequently changed the workspace.
 *
 * Claim commits the binding first; caller then registerMutation, guarded IO, receipt,
 * lease.settle. Neither claim nor registration proves an action occurred. A crash between
 * them NEVER grants mayExecute again. Keep backend receipts until recording succeeds.
 * All operations use the root connection outside ambient transactions. No await spans a
 * transaction. Durable means committed under that connection's durability configuration.
 * appliedFileCount counts confirmed APPLIED receipts, even if after differs from desired;
 * it counts neither claimed files, verified no-ops nor inferred current-byte matches.
 */
export class RevertMutationJournal {
	private readonly now: () => string;
	private readonly namespaceKey: string;
	private readonly plans: RevertPlanService;
	private readonly totals = new RunningTotalsCache();

	constructor(
		private readonly db: RevertJournalDatabase,
		options: RevertJournalOptions,
	) {
		text(options.namespaceKey);
		this.namespaceKey = options.namespaceKey;
		this.now = options.now ?? (() => new Date().toISOString());
		this.assertRoot();
		this.plans = new RevertPlanService(db, options);
	}

	private assertRoot() {
		if (!this.db.$client || this.db.$client.inTransaction)
			throw fail("DURABILITY_BOUNDARY", "A root connection outside any transaction is required");
		const client = this.db.$client;
		if (client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
			throw fail("DURABILITY_BOUNDARY", "Foreign-key protection is required");
		const timeout = client.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
		if (timeout === undefined || timeout < 0 || timeout > 250)
			throw fail("DURABILITY_BOUNDARY", "SQLite busy_timeout must be between 0 and 250ms");
	}

	private transaction<T>(body: (tx: RevertJournalTransaction) => T): T {
		this.assertRoot();
		return this.db.transaction(body);
	}

	private timestamp(previous?: string) {
		const now = Date.parse(this.now());
		if (!Number.isFinite(now)) throw fail("INVALID_INPUT", "Invalid clock");
		return new Date(Math.max(now, previous ? Date.parse(previous) + 1 : now)).toISOString();
	}

	private manifests(tx: RevertJournalTransaction, operation: RevertJournalOperation) {
		return readJournalManifests(tx, operation, this.namespaceKey);
	}
	private async readTask<T>(task: RevertJournalReadTask, signal?: AbortSignal): Promise<T> {
		this.assertRoot();
		return readTransactionTask<T>(this.db, task, () => readRevertJournalTask(this.db, task) as T, {
			signal,
		});
	}

	/** A real prepared plan and its original complete proof are mandatory, including zero files. */
	async startExecution(
		ctx: RevertJournalContext,
		proof: RevertPlanManifestProof,
		options: { signal?: AbortSignal } = {},
	): Promise<{ operation: RevertJournalOperation; started: boolean }> {
		const context = normalizeContext(ctx);
		this.assertRoot();
		const original = await this.readTask<RevertJournalOperation>({
			kind: "revertJournalReadV1",
			action: "operation",
			context,
		});
		if (original.status === "applying") return { operation: original, started: false };
		if (original.status !== "prepared" || !original.coverageComplete)
			throw fail("INVALID_TRANSITION", "A complete prepared plan is required");
		// Reuse the plan service's ordered-manifest digest, fixed refs, full-set and TTL checks.
		await this.plans.finalize(context.owner, context.planId, proof, options);
		options.signal?.throwIfAborted();
		return this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			assertRevision(original, operation);
			if (Date.parse(operation.expiresAt) <= Date.parse(this.now()))
				throw fail("EXPIRED", "The prepared plan expired");
			this.manifests(tx, operation);
			assertPinnedReady(tx, operation.id);
			return {
				operation: this.updateOperation(tx, operation, { status: "applying", reason: null }),
				started: true,
			};
		});
	}

	claimApply(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): RevertJournalClaim {
		return this.claim(ctx, fixed, lease, "apply");
	}

	claimCompensate(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
	): RevertJournalClaim {
		return this.claim(ctx, fixed, lease, "compensate");
	}

	private claim(
		ctx: RevertJournalContext,
		fixed: RevertPlanFileMetadata,
		lease: WorkspaceWriteLease,
		phase: Phase,
	): RevertJournalClaim {
		const context = normalizeContext(ctx);
		metadata(fixed);
		text(fixed.id);
		const claimed = this.transaction(
			(
				tx,
			): RevertJournalClaim | { claim: RevertJournalClaim; carried: RunningTotals | undefined } => {
				const operation = requireOperation(tx, context);
				const file = requireFile(tx, operation, fixed.id);
				assertFixedMetadata(file, fixed);
				const journal = readJournal(file);
				const old = journal[phase];
				const expected = phase === "apply" ? file.expectedStateJson : file.observedAfterStateJson;
				const desired = phase === "apply" ? file.desiredStateJson : file.expectedStateJson;
				if (!expected || expected.kind === "unknown")
					throw fail("UNKNOWN_STATE", "An observed known expected state is required");
				const mutationId = phaseId(file, phase);
				const requestDigest = phaseDigest(file, phase);
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
					if (operation.status !== "applying" || file.status !== "prepared" || journal.compensate)
						throw fail("INVALID_TRANSITION", "Only an unclaimed applying plan file may dispatch");
				} else {
					if (operation.status !== "compensating")
						throw fail("INVALID_TRANSITION", "The plan must explicitly enter compensation");
					if (!compensationEligible(file, journal))
						throw fail(
							"UNSAFE_COMPENSATION",
							"Only a confirmed applied desired state can authorize compensation",
						);
				}
				assertLease(tx, lease, file);
				this.manifests(tx, operation);
				for (const state of [expected, desired]) readyState(tx, state);
				const binding = normalizeBinding(lease.executionBinding);
				journal[phase] = { executionBinding: binding, receipt: null };
				const updated = {
					...file,
					receiptJson: journal,
					status: phase === "apply" ? ("applying" as const) : ("compensating" as const),
					updatedAt: this.timestamp(file.updatedAt),
				};
				metadata(updated);
				const result = tx
					.update(files)
					.set({ receiptJson: journal, status: updated.status, updatedAt: updated.updatedAt })
					.where(eq(files.id, file.id))
					.returning()
					.get();
				// A claim changes only the binding/status of one row, never evidence bytes or the
				// applied count, so totals proven for the previous revision carry forward.
				const carried = this.totals.get(operation);
				const next = this.updateOperation(tx, operation, {});
				return {
					claim: {
						file: result,
						mayExecute: true,
						mutationId,
						requestDigest,
						executionBinding: binding,
						expected,
						desired,
					},
					carried: carried ? { ...carried, operation: next } : undefined,
				};
			},
		);
		if ("carried" in claimed && claimed.carried) this.totals.set(claimed.carried);
		return "claim" in claimed ? claimed.claim : claimed;
	}

	recordApplyReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<RevertJournalFile> {
		return this.recordReceipt(ctx, fileId, receipt, "apply");
	}

	recordCompensateReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		receipt: FileChangeExecutionReceipt,
	): Promise<RevertJournalFile> {
		return this.recordReceipt(ctx, fileId, receipt, "compensate");
	}

	private async recordReceipt(
		ctx: RevertJournalContext,
		fileId: string,
		input: FileChangeExecutionReceipt,
		phase: Phase,
	): Promise<RevertJournalFile> {
		const context = normalizeContext(ctx);
		text(fileId);
		const receipt = normalizeReceipt(input);
		this.assertRoot();
		const original = await this.readTask<RevertJournalOperation>({
			kind: "revertJournalReadV1",
			action: "operation",
			context,
		});
		const originalFile = requireFile(this.db, original, fileId);
		const prior = readJournal(originalFile)[phase];
		assertBoundReceipt(originalFile, prior, receipt, phase);
		if (prior?.receipt) {
			if (!equal(prior.receipt, receipt))
				throw fail("RECEIPT_CONFLICT", "An existing phase receipt cannot be overwritten");
			return originalFile;
		}
		if (!["applying", "compensating", "recovery_required"].includes(original.status))
			throw fail("INVALID_TRANSITION", "Only an unfinished execution may receive a new receipt");
		if (phase === "compensate" && !compensationEligible(originalFile, readJournal(originalFile)))
			throw fail("UNSAFE_COMPENSATION", "Compensation has no confirmed apply baseline");
		// Total budget is bounded by the fixed plan. The first receipt of a revision proves the
		// totals with a complete pagewise scan; later receipts carry them forward incrementally and
		// validate only their own row. Full-set integrity is re-proven by finish/commit regardless.
		const totals = await this.runningTotals(context);
		const written = this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			assertRevision(original, totals.operation);
			assertRevision(original, operation);
			const file = requireFile(tx, operation, fileId);
			if (!equal(file, originalFile))
				throw fail("CONCURRENT_CHANGE", "The phase changed during receipt admission");
			// The row checks a complete scan would have applied to THIS file.
			assertFile(operation, file);
			this.manifests(tx, operation);
			for (const state of [
				file.expectedStateJson,
				file.desiredStateJson,
				file.observedAfterStateJson,
				file.compensationAfterStateJson,
			])
				if (state) readyState(tx, state);
			readyState(tx, receipt.observedAfter);
			const journal = readJournal(file);
			assertBoundReceipt(file, journal[phase], receipt, phase);
			journal[phase] = { executionBinding: receipt.executionBinding, receipt };
			const oldBytes = fileBytes(file);
			const applied = phase === "apply" && receipt.confirmed && receipt.outcome === "applied";
			const after = receipt.observedAfter;
			const valid =
				phase === "apply" ? verifiesApply(file, receipt) : verifiesCompensation(file, receipt);
			const patch =
				phase === "apply"
					? {
							observedAfterStateJson: after,
							observedAfterBlobDigest: stateRef(after)?.digest ?? null,
						}
					: {
							compensationAfterStateJson: after,
							compensationAfterBlobDigest: stateRef(after)?.digest ?? null,
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
			metadata(updated);
			const bytes = totals.bytes - oldBytes + fileBytes(updated);
			evidenceBudget(bytes);
			const appliedCount = totals.applied + (applied ? 1 : 0);
			const result = tx
				.update(files)
				.set({
					...patch,
					receiptJson: journal,
					status,
					reason: updated.reason,
					updatedAt: updated.updatedAt,
				})
				.where(eq(files.id, fileId))
				.returning()
				.get();
			const next = this.updateOperation(tx, operation, {
				appliedFileCount: appliedCount,
				// Preserve a compensation window so other proven files may still be restored.
				status:
					!valid && operation.status !== "compensating" ? "recovery_required" : operation.status,
				reason: valid ? operation.reason : "result_unverified",
			});
			return { result, totals: { operation: next, bytes, applied: appliedCount } };
		});
		// Seed only after COMMIT returned. A rolled-back write never reaches here, and a cached
		// revision that is not the live row is simply a miss.
		this.totals.set(written.totals);
		return written.result;
	}

	/** Complete, contiguous, <=32-row pages; counts/statuses alone never prove verification. */
	async finishFiles(
		ctx: RevertJournalContext,
		options: { signal?: AbortSignal } = {},
	): Promise<RevertJournalOperation> {
		const context = normalizeContext(ctx);
		const scan = await this.scan(context, options.signal);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			assertRevision(scan.operation, operation);
			if (
				operation.status === "files_verified" &&
				scan.allAppliedVerified &&
				operation.appliedFileCount === scan.applied
			)
				return operation;
			if (!["applying", "recovery_required", "files_verified"].includes(operation.status))
				throw fail("INVALID_TRANSITION", "Only an applying plan can finish its files");
			this.manifests(tx, operation);
			assertPinnedReady(tx, operation.id);
			return this.updateOperation(tx, operation, {
				status: scan.allAppliedVerified ? "files_verified" : "recovery_required",
				appliedFileCount: scan.applied,
				reason: scan.allAppliedVerified ? null : "files_unverified",
			});
		});
	}

	/**
	 * Caller has just rechecked all live file states and history version under its leases.
	 * The history callback and committed marker either BOTH commit or BOTH roll back.
	 * An already committed retry never calls history a second time. No async callback or
	 * transaction from another service/connection is accepted. File-only execution omits it.
	 */
	commit(ctx: RevertJournalContext, history?: RevertJournalHistoryCommit): RevertJournalOperation {
		const context = normalizeContext(ctx);
		if (
			history &&
			(history.db !== this.db ||
				typeof history.apply !== "function" ||
				history.apply.constructor.name === "AsyncFunction")
		)
			throw fail(
				"DURABILITY_BOUNDARY",
				"History must use a synchronous callback on the same root DB",
			);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			if (operation.status === "committed") return operation;
			if (operation.status !== "files_verified")
				throw fail(
					"INVALID_TRANSITION",
					"All file receipts must be verified before committing history",
				);
			this.manifests(tx, operation);
			assertPinnedReady(tx, operation.id);
			// Keep the callback's transaction capability scoped even for a misdeclared
			// promise-returning callback: asynchronous continuation cannot reuse this proxy.
			const { proxy, revoke } = Proxy.revocable(tx, {});
			try {
				const result: unknown = history?.apply(proxy);
				if (
					result &&
					(typeof result === "object" || typeof result === "function") &&
					"then" in result
				) {
					void Promise.resolve(result).catch(() => undefined);
					throw fail("DURABILITY_BOUNDARY", "History callback must not return a Promise");
				}
				if (!this.db.$client.inTransaction)
					throw fail("DURABILITY_BOUNDARY", "History escaped the journal transaction");
				return this.updateOperation(tx, operation, { status: "committed", reason: null });
			} finally {
				revoke();
			}
		});
	}

	beginCompensation(ctx: RevertJournalContext): RevertJournalOperation {
		const context = normalizeContext(ctx);
		const began = this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			if (operation.status === "compensating") return { next: operation, carried: undefined };
			if (!["applying", "files_verified", "recovery_required"].includes(operation.status))
				throw fail("INVALID_TRANSITION", "Committed or unstarted plans cannot compensate");
			this.manifests(tx, operation);
			// Only the status changes; no file row is touched, so proven totals carry forward.
			const carried = this.totals.get(operation);
			const next = this.updateOperation(tx, operation, { status: "compensating" });
			return { next, carried: carried ? { ...carried, operation: next } : undefined };
		});
		if (began.carried) this.totals.set(began.carried);
		return began.next;
	}

	/** Unknown apply/compensation is never cleaned away to make this terminal. */
	async finishCompensation(
		ctx: RevertJournalContext,
		options: { signal?: AbortSignal } = {},
	): Promise<RevertJournalOperation> {
		const context = normalizeContext(ctx);
		const scan = await this.scan(context, options.signal);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, context);
			assertRevision(scan.operation, operation);
			if (operation.status === "compensated") return operation;
			if (operation.status !== "compensating")
				throw fail("INVALID_TRANSITION", "An explicit compensation window is required");
			this.manifests(tx, operation);
			assertPinnedReady(tx, operation.id);
			return this.updateOperation(tx, operation, {
				status: scan.allCompensated ? "compensated" : "recovery_required",
				reason: scan.allCompensated ? null : "compensation_unverified",
				appliedFileCount: scan.applied,
			});
		});
	}

	async getOperation(ctx: RevertJournalContext): Promise<RevertJournalOperation> {
		return this.readTask<RevertJournalOperation>({
			kind: "revertJournalReadV1",
			action: "operation",
			context: normalizeContext(ctx),
		});
	}
	/** Same-turn final dispatch validation on the journal's owning connection. */
	getOperationForDispatch(ctx: RevertJournalContext): RevertJournalOperation {
		return requireOperation(this.db, normalizeContext(ctx));
	}

	async listFiles(
		ctx: RevertJournalContext,
		options: { cursor?: string; limit?: number } = {},
	): Promise<RevertJournalPage<RevertJournalFile, string>> {
		const context = normalizeContext(ctx);
		const limit = pageLimit(options.limit);
		if (options.cursor !== undefined) sha256(options.cursor);
		return page(
			await this.readTask<RevertJournalFile[]>({
				kind: "revertJournalReadV1",
				action: "files",
				context,
				cursor: options.cursor,
				limit: limit + 1,
			}),
			limit,
			(row) => row.fileKey,
		);
	}

	/** Owner/context-bound single-state inventory; query each state during recovery.
	 * The compound owner/context/status index and tuple cursor avoid scanning terminal
	 * history or another project to fill a page. TTL never hides unfinished records. */
	async listPending(
		owner: RevertPlanOwner,
		options: {
			status: RevertJournalPendingStatus;
			cursor?: RevertJournalPendingCursor;
			limit?: number;
		},
	) {
		normalizeOwner(owner);
		const limit = pageLimit(options.limit);
		if (
			!["applying", "files_verified", "compensating", "recovery_required"].includes(options.status)
		)
			throw fail("INVALID_INPUT", "A single pending journal state is required");
		const cursor = options.cursor;
		if (cursor) {
			text(cursor.id);
			text(cursor.updatedAt);
		}
		const rows = await readQuery(
			this.db
				.select()
				.from(operations)
				.where(
					and(
						eq(operations.requestedBySubjectKey, owner.subjectKey),
						sql`${operations.narratorId} IS ${owner.narratorId}`,
						sql`${operations.projectId} IS ${owner.projectId}`,
						eq(operations.status, options.status),
						cursor
							? sql`(${operations.updatedAt}, ${operations.id}) > (${cursor.updatedAt}, ${cursor.id})`
							: undefined,
					),
				)
				.orderBy(asc(operations.updatedAt), asc(operations.id))
				.limit(limit + 1),
		);
		return page(rows, limit, (row) => ({ updatedAt: row.updatedAt, id: row.id }));
	}

	private updateOperation(
		tx: RevertJournalTransaction,
		original: RevertJournalOperation,
		patch: Partial<RevertJournalOperation>,
	) {
		const values = { ...patch, updatedAt: this.timestamp(original.updatedAt) };
		metadata({ ...original, ...values });
		const result = tx
			.update(operations)
			.set(values)
			.where(
				and(
					eq(operations.id, original.id),
					eq(operations.updatedAt, original.updatedAt),
					eq(operations.status, original.status),
				),
			)
			.returning()
			.get();
		if (!result) throw fail("CONCURRENT_CHANGE", "The journal revision changed");
		// The revision moved; totals proven for `original` no longer describe it. recordReceipt
		// re-seeds the cache itself after its own write. Eviction is in-memory and idempotent, so
		// it is harmless if this transaction later rolls back (the next receipt simply rescans).
		this.totals.evict(original.id);
		return result;
	}

	/**
	 * Totals for the CURRENT revision: reused when the cached revision still equals the live row,
	 * otherwise proven by a complete scan (which also runs every full-set integrity check).
	 */
	private async runningTotals(context: RevertJournalContext): Promise<RunningTotals> {
		const live = await this.readTask<RevertJournalOperation>({
			kind: "revertJournalReadV1",
			action: "operation",
			context,
		});
		const cached = this.totals.get(live);
		if (cached) return cached;
		const scan = await this.scan(context);
		return { operation: scan.operation, bytes: scan.bytes, applied: scan.applied };
	}

	private async scan(context: RevertJournalContext, signal?: AbortSignal): Promise<Scan> {
		this.assertRoot();
		const { operation: original, bytes } = await this.readTask<{
			operation: RevertJournalOperation;
			bytes: number;
		}>(
			{ kind: "revertJournalReadV1", action: "start", context, namespaceKey: this.namespaceKey },
			signal,
		);
		const result: Scan = {
			operation: original,
			bytes,
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
			const rows = await this.readTask<RevertJournalFile[]>(
				{
					kind: "revertJournalReadV1",
					action: "page",
					context,
					original,
					namespaceKey: this.namespaceKey,
					cursor,
				},
				signal,
			);
			for (const row of rows.slice(0, REVERT_JOURNAL_BATCH_ITEMS)) {
				assertFile(original, row);
				if (sequences.has(row.sequence))
					throw fail("INCOMPLETE_SET", "Duplicate manifest sequence");
				sequences.set(
					row.sequence,
					digest({
						sequence: row.sequence,
						identity: row.identityJson,
						fileKey: row.fileKey,
						expected: normalizeState(row.expectedStateJson),
						desired: normalizeState(row.desiredStateJson),
					}),
				);
				plannedFileBytes +=
					(stateRef(row.expectedStateJson)?.sizeBytes ?? 0) +
					(stateRef(row.desiredStateJson)?.sizeBytes ?? 0);
				integer(++result.count, 0, original.fileCount);
				result.bytes += fileBytes(row);
				evidenceBudget(result.bytes);
				for (const state of [
					row.expectedStateJson,
					row.desiredStateJson,
					row.observedAfterStateJson,
					row.compensationAfterStateJson,
				])
					if (state) {
						const ref = stateRef(normalizeState(state));
						if (
							ref &&
							!equal(
								ref,
								await this.readTask<FileChangeBlobRef>(
									{ kind: "revertJournalReadV1", action: "catalog", context, digest: ref.digest },
									signal,
								),
							)
						)
							throw fail(
								"BLOB_NOT_READY",
								"Raw evidence size does not match its ready catalog reference",
							);
					}
				const journal = readJournal(row);
				const apply = journal.apply?.receipt;
				const compensate = journal.compensate?.receipt;
				if (apply?.confirmed && apply.outcome === "applied") result.applied++;
				result.allAppliedVerified &&=
					row.status === "verified" &&
					!!apply &&
					verifiesApply(row, apply) &&
					journal.compensate === null;
				const neverClaimed = journal.apply === null && row.status === "prepared";
				const didNotApply =
					!!apply?.confirmed && apply.outcome === "not_applied" && journal.compensate === null;
				const restored =
					compensationEligible(row, journal) &&
					!!compensate &&
					row.status === "compensated" &&
					verifiesCompensation(row, compensate);
				result.allCompensated &&= neverClaimed || didNotApply || restored;
			}
			if (rows.length <= REVERT_JOURNAL_BATCH_ITEMS) break;
			cursor = rows[REVERT_JOURNAL_BATCH_ITEMS - 1]?.fileKey;
			await yieldToEventLoop();
		}
		signal?.throwIfAborted();
		if (sequences.size !== original.fileCount)
			throw fail("INCOMPLETE_SET", "The complete fixed file set is missing");
		for (let i = 0; i < original.fileCount; i++)
			if (!sequences.has(i)) throw fail("INCOMPLETE_SET", "A fixed manifest position is missing");
		assertRevision(original, requireOperation(this.db, context));
		assertPlanCommitment(this.db, original, sequences, plannedFileBytes);
		return result;
	}
}

function normalizeContext(ctx: RevertJournalContext): RevertJournalContext {
	normalizeOwner(ctx.owner);
	text(ctx.planId);
	sha256(ctx.planHash);
	return { owner: { ...ctx.owner }, planId: ctx.planId, planHash: ctx.planHash };
}
function normalizeOwner(owner: RevertPlanOwner) {
	text(owner.subjectKey);
	if (owner.narratorId !== null) text(owner.narratorId);
	if (owner.projectId !== null) text(owner.projectId);
}

function requireFile(
	tx: RevertJournalTransaction,
	operation: RevertJournalOperation,
	id: string,
): RevertJournalFile {
	const row = tx
		.select()
		.from(files)
		.where(and(eq(files.id, id), eq(files.revertOperationId, operation.id)))
		.get();
	if (!row) throw fail("NOT_FOUND", "File is not in the fixed plan");
	assertFile(operation, row);
	return row;
}
/**
 * In-memory, per-journal-instance running totals keyed by plan id. A hit requires the cached
 * operation row to be deep-equal to the live row (same updatedAt/status/counters), so a write by
 * another connection or process, a namespace reset, or a rolled-back transaction can only cause
 * a miss, never a stale hit. Bounded; insertion-ordered eviction.
 */
class RunningTotalsCache {
	private readonly entries = new Map<string, RunningTotals>();

	get(live: RevertJournalOperation): RunningTotals | undefined {
		const cached = this.entries.get(live.id);
		if (!cached) return undefined;
		if (!LIVE_TOTAL_STATUSES.includes(live.status) || !equal(cached.operation, live)) {
			this.entries.delete(live.id);
			return undefined;
		}
		return cached;
	}

	set(totals: RunningTotals): void {
		this.entries.delete(totals.operation.id);
		if (!LIVE_TOTAL_STATUSES.includes(totals.operation.status)) return;
		this.entries.set(totals.operation.id, totals);
		while (this.entries.size > MAX_CACHED_TOTALS) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	evict(planId: string): void {
		this.entries.delete(planId);
	}
}

function assertFile(operation: RevertJournalOperation, row: RevertJournalFile) {
	metadata(row);
	integer(row.sequence, 0, operation.fileCount - 1);
	const expected = normalizeState(row.expectedStateJson);
	const desired = normalizeState(row.desiredStateJson);
	if (expected.kind === "unknown" || desired.kind === "unknown")
		throw fail("UNKNOWN_STATE", "The fixed plan requires known expected/desired states");
	const fileKey = fileChangeIdentityKey(row.identityJson);
	if (fileKey !== row.fileKey || row.scopeId !== row.identityJson.scopeId)
		throw fail("IDENTITY_CONFLICT", "File identity changed");
	const binding = [
		operation.id,
		operation.requestDigest,
		operation.planHash,
		fileKey,
		row.sequence,
	];
	for (const phase of ["apply", "compensate"] as const) {
		const request = phase === "apply" ? [expected, desired] : [desired, expected];
		if (
			phaseId(row, phase) !== digest(["revert-mutation-v1", ...binding, phase]) ||
			phaseDigest(row, phase) !== digest(["revert-request-v1", ...binding, phase, ...request])
		)
			throw fail("REQUEST_CONFLICT", "The fixed phase mutation/request binding changed");
	}
	if (
		row.beforeBlobDigest !== (stateRef(expected)?.digest ?? null) ||
		row.desiredBlobDigest !== (stateRef(desired)?.digest ?? null)
	)
		throw fail("REFERENCE_CONFLICT", "The fixed raw reverse references changed");
	for (const [state, ref] of [
		[row.observedAfterStateJson, row.observedAfterBlobDigest],
		[row.compensationAfterStateJson, row.compensationAfterBlobDigest],
	] as const) {
		if (state !== null) normalizeState(state);
		if (ref !== (state ? (stateRef(state)?.digest ?? null) : null))
			throw fail("REFERENCE_CONFLICT", "Observed raw references changed");
	}
	const journal = readJournal(row);
	for (const phase of ["apply", "compensate"] as const) {
		const entry = journal[phase];
		const observation =
			phase === "apply" ? row.observedAfterStateJson : row.compensationAfterStateJson;
		if (entry?.receipt) {
			assertBoundReceipt(row, entry, entry.receipt, phase);
			if (!equal(entry.receipt.observedAfter, observation))
				throw fail(
					"RECEIPT_CONFLICT",
					"A stored receipt no longer matches its immutable observation",
				);
		} else if (observation !== null)
			throw fail(
				"LEGACY_UNVERIFIED",
				"An observation without its phase receipt is not executable evidence",
			);
	}
}
function assertPlanCommitment(
	tx: RevertJournalTransaction,
	operation: RevertJournalOperation,
	entries: Map<number, string>,
	fileEvidenceBytes: number,
) {
	// Verify, never construct/replace, the prepared planner's original commitment.
	// Hash one bounded fingerprint per sequence; do not retain 1000 full identities.
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
		selector: catalogRef(tx, operation.selectorBlobDigest),
		historyManifest: catalogRef(tx, operation.historyManifestBlobDigest),
		expectedMessageVersion: operation.expectedMessageVersion,
		expectedFileCount: operation.fileCount,
		parentRevertId: operation.parentRevertId,
	};
	const proof = {
		source: "trusted_published_planner_v1",
		headerDigest: digest(header),
		orderedFilesDigest: ordered.digest("hex"),
		fileEvidenceBytes,
		computation: "complete",
		selectorCoverage: "complete",
		historyCoverage: "complete",
		omittedFiles: 0,
		unknownFiles: 0,
	};
	if (
		digest([
			"revert-plan-commitment-v1",
			header,
			catalogRef(tx, operation.planBlobDigest),
			proof,
		]) !== operation.planHash
	)
		throw fail(
			"REQUEST_CONFLICT",
			"The full fixed file set no longer matches its prepared manifest commitment",
		);
}

function assertFixedMetadata(row: RevertJournalFile, fixed: RevertPlanFileMetadata) {
	for (const key of [
		"id",
		"fileKey",
		"sequence",
		"identityJson",
		"expectedStateJson",
		"desiredStateJson",
		"applyMutationId",
		"applyRequestDigest",
		"compensateMutationId",
		"compensateRequestDigest",
	] as const)
		if (!equal(row[key], fixed[key]))
			throw fail("REQUEST_CONFLICT", "Caller file metadata differs from the fixed plan");
}
function assertLease(
	tx: RevertJournalTransaction,
	lease: WorkspaceWriteLease,
	file: RevertJournalFile,
) {
	if (
		!lease ||
		lease.kind !== "rollback" ||
		typeof lease.assertCurrent !== "function" ||
		(lease.activityPolicy !== "observe" && lease.overlappedUncoordinatedActivity)
	)
		throw fail("INVALID_LEASE", "A live rollback coordinator lease is required");
	lease.assertCurrent(lease.executionBinding);
	const scope = tx.select().from(scopes).where(eq(scopes.id, file.scopeId)).get();
	if (
		!scope ||
		scope.status !== "active" ||
		!scope.activeLeaseId ||
		!scope.activeLeaseEpoch ||
		scope.id !== lease.scope.id ||
		scope.revision !== lease.scopeRevision ||
		scope.fencingToken !== lease.executionBinding.fencingToken ||
		file.identityJson.deviceId !== lease.executionBinding.deviceId
	)
		throw fail("STALE_LEASE", "Lease scope, identity, revision or fencing token changed");
	for (const key of [
		"id",
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"pathFlavor",
		"canonicalRoot",
	] as const)
		if (scope[key] !== lease.scope[key])
			throw fail("IDENTITY_CONFLICT", "Lease does not own this exact workspace incarnation");
	if (!equal(createFileChangeIdentity(scope, file.identityJson), file.identityJson))
		throw fail("IDENTITY_CONFLICT", "File identity is outside the leased scope");
	normalizeBinding(lease.executionBinding);
}
function readJournal(file: RevertJournalFile): FileChangeRevertMutationJournal {
	if (file.receiptJson === null) {
		if (file.status !== "prepared")
			throw fail("LEGACY_UNVERIFIED", "An attempted file requires a typed phase journal");
		return { version: 1, apply: null, compensate: null };
	}
	const raw = file.receiptJson;
	keys(raw, ["version", "apply", "compensate"]);
	if (raw.version !== 1 || !Object.hasOwn(raw, "apply") || !Object.hasOwn(raw, "compensate"))
		throw fail("LEGACY_UNVERIFIED", "A versioned apply/compensate journal is required");
	const result: FileChangeRevertMutationJournal = { version: 1, apply: null, compensate: null };
	for (const phase of ["apply", "compensate"] as const) {
		const entry = raw[phase];
		if (entry === null) continue;
		if (!entry || typeof entry !== "object")
			throw fail("LEGACY_UNVERIFIED", "Invalid phase journal");
		keys(entry, ["executionBinding", "receipt"]);
		const phaseEntry = entry as NonNullable<FileChangeRevertMutationJournal[Phase]>;
		result[phase] = {
			executionBinding: normalizeBinding(phaseEntry.executionBinding),
			receipt: phaseEntry.receipt === null ? null : normalizeReceipt(phaseEntry.receipt),
		};
	}
	if (result.compensate && !result.apply)
		throw fail("LEGACY_UNVERIFIED", "Compensation is missing its original apply journal");
	return result;
}
function assertBoundReceipt(
	file: RevertJournalFile,
	entry: FileChangeRevertMutationJournal[Phase],
	receipt: FileChangeExecutionReceipt,
	phase: Phase,
) {
	if (
		!entry ||
		receipt.mutationId !== phaseId(file, phase) ||
		receipt.requestDigest !== phaseDigest(file, phase) ||
		!fileChangeExecutionBindingMatches(entry.executionBinding, receipt.executionBinding) ||
		receipt.executionBinding.deviceId !== file.identityJson.deviceId
	)
		throw fail(
			"RECEIPT_CONFLICT",
			"Receipt does not match the originally claimed phase and execution binding",
		);
}
function verifiesApply(file: RevertJournalFile, receipt: FileChangeExecutionReceipt) {
	return (
		receipt.confirmed &&
		fileChangeStatesEqual(receipt.observedAfter, file.desiredStateJson) &&
		(receipt.outcome === "applied" ||
			(receipt.outcome === "not_applied" &&
				fileChangeStatesEqual(file.expectedStateJson, file.desiredStateJson)))
	);
}
function compensationEligible(file: RevertJournalFile, journal: FileChangeRevertMutationJournal) {
	const receipt = journal.apply?.receipt;
	return (
		!!receipt?.confirmed &&
		receipt.outcome === "applied" &&
		file.observedAfterStateJson !== null &&
		fileChangeStatesEqual(receipt.observedAfter, file.desiredStateJson) &&
		fileChangeStatesEqual(file.observedAfterStateJson, file.desiredStateJson)
	);
}
function verifiesCompensation(file: RevertJournalFile, receipt: FileChangeExecutionReceipt) {
	return (
		receipt.confirmed &&
		fileChangeStatesEqual(receipt.observedAfter, file.expectedStateJson) &&
		(receipt.outcome === "applied" ||
			(receipt.outcome === "not_applied" &&
				fileChangeStatesEqual(file.desiredStateJson, file.expectedStateJson)))
	);
}
function normalizeReceipt(receipt: FileChangeExecutionReceipt): FileChangeExecutionReceipt {
	keys(receipt, [
		"receiptId",
		"mutationId",
		"requestDigest",
		"executionBinding",
		"confirmed",
		"observedAfter",
		"outcome",
		"localIo",
	]);
	text(receipt.receiptId);
	sha256(receipt.mutationId);
	sha256(receipt.requestDigest);
	if (
		typeof receipt.confirmed !== "boolean" ||
		!["applied", "not_applied", "unknown"].includes(receipt.outcome)
	)
		throw fail("INVALID_INPUT", "Invalid execution acknowledgement");
	const result = {
		receiptId: receipt.receiptId,
		mutationId: receipt.mutationId,
		requestDigest: receipt.requestDigest,
		executionBinding: normalizeBinding(receipt.executionBinding),
		confirmed: receipt.confirmed,
		observedAfter: normalizeState(receipt.observedAfter),
		outcome: receipt.outcome,
		...(receipt.localIo === undefined
			? {}
			: { localIo: normalizeLocalIoEvidence(receipt.localIo) }),
	};
	metadata(result);
	return result;
}
function normalizeBinding(binding: FileChangeExecutionBinding): FileChangeExecutionBinding {
	keys(binding, ["deviceId", "runtimeEpoch", "runtimeGeneration", "fencingToken"]);
	text(binding.deviceId);
	text(binding.runtimeEpoch);
	integer(binding.runtimeGeneration);
	integer(binding.fencingToken);
	return { ...binding };
}
function normalizeState(state: FileChangeState): FileChangeState {
	if (!state || typeof state !== "object")
		throw fail("UNKNOWN_STATE", "Null/missing never means absent");
	if (state.kind === "absent") {
		keys(state, ["kind"]);
		return { kind: "absent" };
	}
	if (state.kind === "unknown") {
		keys(state, ["kind", "reason"]);
		if (
			![
				"legacy_unverified",
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
			throw fail("UNKNOWN_STATE", "Unsupported uncertainty reason");
		return { kind: "unknown", reason: state.reason };
	}
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("UNKNOWN_STATE", "Unsupported file object");
	keys(state, state.kind === "regular" ? ["kind", "blob", "mode"] : ["kind", "target", "mode"]);
	if (state.mode !== null) integer(state.mode, 0, 0xffff);
	const ref = state.kind === "regular" ? state.blob : state.target;
	keys(ref, ["algorithm", "digest", "sizeBytes"]);
	if (ref.algorithm !== "sha256")
		throw fail("INVALID_INPUT", "Only SHA-256 raw refs are supported");
	sha256(ref.digest);
	integer(ref.sizeBytes, 0, FILE_CHANGE_LIMITS.blobBytes);
	return state.kind === "regular"
		? { kind: "regular", mode: state.mode, blob: { ...ref } }
		: { kind: "symlink", mode: state.mode, target: { ...ref } };
}
function stateRef(state: FileChangeState): FileChangeBlobRef | null {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}
function fileBytes(file: RevertJournalFile) {
	let bytes =
		(stateRef(file.expectedStateJson)?.sizeBytes ?? 0) +
		(stateRef(file.desiredStateJson)?.sizeBytes ?? 0);
	for (const state of [file.observedAfterStateJson, file.compensationAfterStateJson])
		if (
			state &&
			!fileChangeStatesEqual(state, file.expectedStateJson) &&
			!fileChangeStatesEqual(state, file.desiredStateJson)
		)
			bytes += stateRef(state)?.sizeBytes ?? 0;
	return bytes;
}

function assertPinnedReady(tx: RevertJournalTransaction, planId: string) {
	// Scoped indexed EXISTS over at most 1000 admitted files, fetching no row bodies.
	// Rechecks catalog changes across page yields immediately before the transition.
	const refs = [
		[files.beforeBlobDigest, files.expectedStateJson],
		[files.desiredBlobDigest, files.desiredStateJson],
		[files.observedAfterBlobDigest, files.observedAfterStateJson],
		[files.compensationAfterBlobDigest, files.compensationAfterStateJson],
	] as const;
	const missing = refs.map(
		([ref, state]) => sql`(${ref} IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM ${blobs} WHERE ${blobs.digest} = ${ref} AND ${blobs.status} = 'ready'
		AND ${blobs.sizeBytes} = coalesce(json_extract(${state}, '$.blob.sizeBytes'), json_extract(${state}, '$.target.sizeBytes'))
	))`,
	);
	const unavailable = tx
		.select({ id: files.id })
		.from(files)
		.where(and(eq(files.revertOperationId, planId), sql`(${sql.join(missing, sql` OR `)})`))
		.limit(1)
		.get();
	if (unavailable) throw fail("BLOB_NOT_READY", "Pinned raw evidence changed during verification");
}

function readyState(tx: RevertJournalTransaction, state: FileChangeState) {
	const ref = stateRef(normalizeState(state));
	if (ref && !equal(ref, catalogRef(tx, ref.digest)))
		throw fail("BLOB_NOT_READY", "Raw evidence size does not match its ready catalog reference");
}
function phaseId(file: RevertJournalFile, phase: Phase) {
	return phase === "apply" ? file.applyMutationId : file.compensateMutationId;
}
function phaseDigest(file: RevertJournalFile, phase: Phase) {
	return phase === "apply" ? file.applyRequestDigest : file.compensateRequestDigest;
}

function page<T, C>(rows: T[], limit: number, cursor: (row: T) => C): RevertJournalPage<T, C> {
	const items: T[] = [];
	let bytes = 1024;
	for (const row of rows) {
		metadata(row);
		const size = Buffer.byteLength(JSON.stringify(row));
		if (items.length === limit || bytes + size > FILE_CHANGE_LIMITS.summaryBytes) break;
		items.push(row);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw fail("METADATA_BUDGET", "Row does not fit in a bounded response");
	const hasMore = rows.length > items.length;
	const last = items.at(-1);
	return { items, hasMore, nextCursor: hasMore && last ? cursor(last) : null };
}
function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems) {
	integer(value, 1, FILE_CHANGE_LIMITS.historyPageItems);
	return value;
}

function evidenceBudget(value: number) {
	integer(value, 0, FILE_CHANGE_LIMITS.operationEvidenceBytes);
}
function text(value: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("INVALID_INPUT", "Invalid bounded identifier");
}

function keys(value: object, allowed: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw fail("INVALID_INPUT", "Only declared bounded metadata fields are accepted");
}

function digest(value: unknown) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * The dialect-free core of the mutation journal, exported for the PostgreSQL
 * sibling (`postgres-revert-journal-store.ts`) — and nothing else.
 *
 * Everything here is pure normalization, hashing, budgeting, receipt/journal
 * decoding or verdict logic: no SQL fragment, no drizzle object, no driver shape.
 * The pieces that DO carry a dialect (the `IS` null-safe idiom, `json_extract`,
 * the sync `.get()/.run()` chaining) stay private above; the PG store rewrites
 * those against its own schema. Exporting the pure half is what lets the two
 * backends share the section CONTENT — the same validations in the same order —
 * rather than diverging copies of it.
 */
export const revertJournalInternals = {
	RunningTotalsCache,
	normalizeContext,
	normalizeOwner,
	assertRevision,
	assertFile,
	assertFixedMetadata,
	readJournal,
	assertBoundReceipt,
	verifiesApply,
	compensationEligible,
	verifiesCompensation,
	normalizeReceipt,
	normalizeBinding,
	normalizeState,
	stateRef,
	fileBytes,
	phaseId,
	phaseDigest,
	selectFiles,
	page,
	pageLimit,
	metadata,
	evidenceBudget,
	text,
	sha256,
	integer,
	keys,
	digest,
	equal,
	fail,
};
