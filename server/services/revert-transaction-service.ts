/**
 * CAPABILITY BOUNDARY: this module is SQLite-only by design, and that is a
 * deliberate capability decision, not unfinished porting.
 *
 * It orchestrates the file/history revert end to end over connection-scoped
 * SQLite facts: `total_changes()`/`PRAGMA data_version` stamps that fence the
 * prepared plan against ANY intervening write, the synchronous same-root
 * transaction the history commit must run inside, and the raw `$client` handle
 * the journal's durability boundary checks against.
 *
 * THE PG ALTERNATIVE (for whoever ports the orchestration): the atomic sections
 * it sequences already have PG counterparts — the plan store, the mutation
 * journal (including `commit`, whose history callback runs inside the journal's
 * own PG transaction), the evidence store, the blob catalog and the durable
 * lease store (`postgres-revert-plan-store.ts`, `postgres-revert-journal-store.ts`,
 * `postgres-file-change-evidence-store.ts`, `postgres-file-change-blob-catalog.ts`,
 * `postgres-workspace-lease-store.ts`). What remains to port is the sequencing
 * itself, against `REPEATABLE READ` snapshots in place of the stamps; see the
 * capability headers in those modules.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeExecutionReceipt,
	type FileChangeRevertAction,
	type FileChangeRevertMutationJournal,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { fileChangeBlobs, fileChangeScopes, revertOperationFiles } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
	fileChangeExecutionBindingMatches,
	fileChangeIdentityKey,
} from "./file-change-identity";
import {
	fileChangeLocalIo,
	type LocalFileObservation,
	localDirectoryIdentity,
	localObjectIdentity,
} from "./file-change-local-io";
import {
	type LocalFileRestoreInput,
	type LocalFileRestoreResult,
	type LocalRestoreObservation,
	preflightLocalFileRestore,
	restoreLocalFile,
} from "./file-change-local-restore";
import { FileChangeNamespaceBusyError } from "./file-change-namespace-reset";
import { type LocalFileChangeRuntime, localFileChangeRuntimeBinding } from "./file-change-runtime";
import type { NarratorPrincipal } from "./narrator-acl";
import { type RevertHistoryApplyResult, RevertHistoryCommitService } from "./revert-history-commit";
import {
	type RevertJournalClaim,
	type RevertJournalContext,
	type RevertJournalDatabase,
	type RevertJournalFile,
	type RevertJournalOperation,
	RevertMutationJournal,
} from "./revert-mutation-journal";
import { type RevertPlanOptions, RevertPlanService } from "./revert-plan-service";
import type { RevertPlannerAccess } from "./revert-planner-service";
import { RevertSelectionService } from "./revert-selection-service";
import type {
	TransactionManifestFile,
	TransactionManifestRequest,
	ValidatedTransactionManifest,
} from "./revert-transaction-manifest-worker";
import {
	RevertTransactionError,
	runRevertManifestWorker as worker,
} from "./revert-transaction-worker";
import {
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
	type WorkspaceRuntimeBinding,
	type WorkspaceWriteBatch,
	type WorkspaceWriteLease,
} from "./workspace-write-coordinator";

import {
	freezeWorkspaceRanges,
	WORKSPACE_RANGE_LIMITS,
	type WorkspaceWriteRange,
} from "./workspace-write-ranges";

export { RevertTransactionError } from "./revert-transaction-worker";

/** Admission bounds for already-authorized fixed targets, never additional mutation authority. */
export function buildRevertScopeRanges(
	scope: Readonly<FileChangeScopeIdentity>,
	canonicalPaths: readonly string[],
): readonly WorkspaceWriteRange[] {
	bound(canonicalPaths.length, FILE_CHANGE_LIMITS.revertFiles, 1);
	const ranges = canonicalPaths.map((canonicalPath) => ({ kind: "file" as const, canonicalPath }));
	if (
		ranges.length <= WORKSPACE_RANGE_LIMITS.count &&
		Buffer.byteLength(JSON.stringify({ version: 1, ranges })) <= WORKSPACE_RANGE_LIMITS.jsonBytes
	)
		return freezeWorkspaceRanges(scope, ranges);
	// Do not hide an invalid/out-of-scope target behind the conservative fallback.
	for (const range of ranges) freezeWorkspaceRanges(scope, [range]);
	return freezeWorkspaceRanges(scope);
}

type Namespace = Awaited<ReturnType<LocalFileChangeRuntime["verifyNamespace"]>>;
type Scope = typeof fileChangeScopes.$inferSelect;
export interface RevertTransactionRequest {
	principal: NarratorPrincipal;
	narratorId: string;
	planId: string;
	planHash: string;
	/** Required by HTTP; internal callers may still exercise non-UI preview plans. */
	action?: FileChangeRevertAction;
	acceptSnapshotRestore?: true;
	signal?: AbortSignal;
}
export interface RevertTransactionOutcome {
	planId: string;
	status: "committed" | "compensated" | "recovery_required";
	/** Actual durable state, or null when even the commit result cannot be read. */
	journalStatus: RevertJournalOperation["status"] | null;
	/** True only for a bounded response whose execution/cleanup still owns its leases. */
	settling: boolean;
	/** May report coordination recovery even when history/files committed or compensated. */
	reason: string | null;
	/** Internal post-commit invalidation data, never serialized as the public result. */
	historyResult?: RevertHistoryApplyResult;
	worktreePaths?: string[];
}
export interface RevertTransactionExecution {
	/** Bounded caller wait. Rejection means preflight refused without target dispatch. */
	result: Promise<RevertTransactionOutcome>;
	/** Actual lifetime, including late kernel IO and fd close. Must not be discarded by an owner. */
	whenSettled: Promise<RevertTransactionOutcome>;
}
export interface RevertTransactionOptions {
	access: RevertPlannerAccess;
	/** SAME real root, coordinator and verified physical store used to produce the plan. */
	runtime: LocalFileChangeRuntime;
	namespace: Namespace;
	planOptions: RevertPlanOptions;
	/** Defaults to the actual local authority, never an invented execution epoch. */
	readRuntime?: (deviceId: string) => WorkspaceRuntimeBinding | null;
	timeoutMs?: number;
	cleanupTimeoutMs?: number;
	/** Trusted admission configuration may lower, never raise, the shared evidence ceiling. */
	maxEvidenceBytes?: number;
	onSlow?: (event: {
		service: "revert-transaction";
		durationMs: number;
		files: number;
		status: string;
	}) => void;
}

type BoundFile = {
	manifest: TransactionManifestFile;
	fixed: RevertJournalFile;
	scope: Scope;
	objectIdentity: string | null;
	/** Only the original apply observation may guard compensation; never a fresh same-byte inode. */
	appliedObservation?: LocalRestoreObservation;
};
type Run = {
	request: Omit<RevertTransactionRequest, "signal">;
	signal: AbortSignal;
	ctx?: RevertJournalContext;
	started: boolean;
	usedBytes: number;
	files: BoundFile[];
	worktreePaths: string[];
	historyResult?: RevertHistoryApplyResult;
	leases: readonly WorkspaceWriteLease[];
};

/** Internal POSIX/local narrator-only vertical execution. NO HTTP apply, broadcasts, legacy
 * deletion adapters, workspace/unrevert fallback, re-planning or recovery redispatch.
 *
 * All fixed files pass raw/object/mode/history preflight before startExecution. Durable claim
 * -> exact pending mutation -> real IO lifetime -> ready raw observation -> receipt -> settle.
 * The final history program is the FIRST write in the journal's same-root synchronous commit.
 * External processes are not locked: detected third-party bytes OR inode replacements refuse
 * compensation and retain recovery evidence. This is not cross-file filesystem atomicity.
 *
 * execute returns TWO promises deliberately: a caller deadline never shortens the coordinator
 * body. The body remains owned until every actual whenSettled barrier resolves, even after the
 * caller receives recovery_required. No automatic resume/replay exists after a lost receipt.
 */
export class RevertTransactionService {
	private readonly journal: RevertMutationJournal;
	private readonly plans: RevertPlanService;
	private readonly history: RevertHistoryCommitService;
	private readonly selection: RevertSelectionService;
	private readonly readRuntime: NonNullable<RevertTransactionOptions["readRuntime"]>;
	private readonly timeoutMs: number;
	private readonly cleanupMs: number;
	private readonly maxEvidenceBytes: number;
	private active = 0;

	constructor(
		private readonly db: RevertJournalDatabase,
		private readonly options: RevertTransactionOptions,
	) {
		for (const key of [
			"authenticate",
			"authorizeNarrator",
			"resolveContext",
			"authorizeFile",
			"resolveFile",
		] as const)
			if (typeof options.access?.[key] !== "function") throw fail("AUTHORIZATION_REQUIRED");
		if (!options.runtime || !options.namespace) throw fail("RUNTIME_REQUIRED");
		this.readRuntime = options.readRuntime ?? localFileChangeRuntimeBinding;
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.cleanupMs = options.cleanupTimeoutMs ?? 30_000;
		this.maxEvidenceBytes = options.maxEvidenceBytes ?? FILE_CHANGE_LIMITS.operationEvidenceBytes;
		bound(this.maxEvidenceBytes, FILE_CHANGE_LIMITS.operationEvidenceBytes, 1);
		bound(this.timeoutMs, FILE_CHANGE_LIMITS.planLifetimeMs, 1);
		bound(this.cleanupMs, 120_000, 1);
		this.journal = new RevertMutationJournal(db, options.planOptions);
		this.plans = new RevertPlanService(db, options.planOptions);
		this.history = new RevertHistoryCommitService(db, {
			authorize: (...args) => options.access.authorizeNarrator(...args),
		});
		this.selection = new RevertSelectionService(db, {
			authorize: (...args) => options.access.authorizeNarrator(...args),
		});
	}

	/** Bounded read-only admission preflight: invalid consent must not interrupt a live turn. */
	async validateHttpAction(input: RevertTransactionRequest): Promise<void> {
		const request = fixedRequest(input);
		if (!request.action) throw fail("ACTION_MISMATCH");
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency) throw fail("BUSY");
		this.active++;
		const signal = AbortSignal.any([
			...(input.signal ? [input.signal] : []),
			AbortSignal.timeout(this.timeoutMs),
		]);
		const started = performance.now();
		try {
			await this.options.access.authenticate(request.principal, signal);
			const context = await this.options.access.resolveContext({
				principal: request.principal,
				narratorId: request.narratorId,
				signal,
			});
			const operation = this.journal.getOperation({
				owner: {
					subjectKey: `human:${request.principal.userId}`,
					narratorId: request.narratorId,
					projectId: context.projectId,
				},
				planId: request.planId,
				planHash: request.planHash,
			});
			await this.verifyEntrypoint(request, operation, signal);
		} finally {
			this.active--;
			this.report(started, 0, "action_preflight");
		}
	}

	private async verifyEntrypoint(
		request: Omit<RevertTransactionRequest, "signal">,
		operation: RevertJournalOperation,
		signal: AbortSignal,
	): Promise<void> {
		// Terminal replay checks immutable consent only, not target IO. A reopened
		// runtime may supply a new namespace object with the same durable binding.
		const terminal = operation.status !== "prepared";
		await this.namespace(signal, terminal);
		const blob = this.db
			.select({ size: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, operation.selectorBlobDigest ?? ""))
			.get();
		if (!operation.selectorBlobDigest || blob?.status !== "ready")
			throw fail("MANIFEST_UNAVAILABLE");
		const ref: FileChangeBlobRef = {
			algorithm: "sha256",
			digest: operation.selectorBlobDigest,
			sizeBytes: blob.size,
		};
		await worker<boolean>(
			{
				action: "entrypoint",
				raw: { ref, bytes: await this.readBlob(ref, signal, terminal) },
				operation,
				userId: request.principal.userId,
				...(request.action === undefined ? {} : { expectedAction: request.action }),
				...(request.acceptSnapshotRestore === undefined
					? {}
					: { acceptSnapshotRestore: request.acceptSnapshotRestore }),
			},
			signal,
		);
	}

	execute(input: RevertTransactionRequest): RevertTransactionExecution {
		const request = fixedRequest(input);
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency) throw fail("BUSY");
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(fail("TIMEOUT")), this.timeoutMs);
		const abort = () => controller.abort(fail("CANCELLED"));
		input.signal?.addEventListener("abort", abort, { once: true });
		if (input.signal?.aborted) abort();
		const run: Run = {
			request,
			signal: controller.signal,
			started: false,
			usedBytes: 0,
			files: [],
			worktreePaths: [],
			leases: [],
		};
		this.active++;
		const started = performance.now();
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let stopResponse: () => void = () => {};
		const body = this.run(run).finally(() => {
			this.active--;
			clearTimeout(deadline);
			if (responseTimer) clearTimeout(responseTimer);
			controller.signal.removeEventListener("abort", stopResponse);
			input.signal?.removeEventListener("abort", abort);
		});
		const limited = new Promise<RevertTransactionOutcome>((resolve, reject) => {
			stopResponse = () => {
				responseTimer = setTimeout(() => {
					if (!run.started) reject(fail("PREFLIGHT_CANCELLED"));
					else resolve(this.outcome(run, this.safeOperation(run), true, "IO_OR_CLEANUP_PENDING"));
				}, this.cleanupMs);
			};
			controller.signal.addEventListener("abort", stopResponse, { once: true });
			if (controller.signal.aborted) stopResponse();
			body.then(resolve, reject);
		});
		// Both capabilities are observed here, while their original rejection remains visible.
		void body.then(
			(result) => this.report(started, run.files.length, result.status),
			() => this.report(started, run.files.length, "refused"),
		);
		void limited.catch(() => {});
		return { result: limited, whenSettled: body };
	}

	private async run(run: Run): Promise<RevertTransactionOutcome> {
		// Namespace admission protects preview/blob reads, but must end before waiting
		// for workspace admission: writes acquire coordinator -> namespace, never reverse.
		const preflight = await this.options.runtime.withNamespaceAccess(async () => {
			run.signal.throwIfAborted();
			await this.options.access.authenticate(run.request.principal, run.signal);
			const context = await this.options.access.resolveContext({
				principal: run.request.principal,
				narratorId: run.request.narratorId,
				signal: run.signal,
			});
			run.ctx = {
				owner: {
					subjectKey: `human:${run.request.principal.userId}`,
					narratorId: run.request.narratorId,
					projectId: context.projectId,
				},
				planId: run.request.planId,
				planHash: run.request.planHash,
			};
			const operation = this.journal.getOperation(run.ctx);
			if (
				operation.scope !== "narrator" ||
				!["revert", "history_delete", "rollback_to_block"].includes(operation.kind)
			)
				throw fail("UNSUPPORTED");
			await this.verifyEntrypoint(run.request, operation, run.signal);
			if (operation.status !== "prepared") return { outcome: this.outcome(run, operation) };
			if (this.plans.getSummary(run.ctx.owner, operation.id).expired) throw fail("EXPIRED");
			await this.namespace(run.signal);
			const rows: RevertJournalFile[] = [];
			let cursor: string | undefined;
			do {
				const page = this.journal.listFiles(run.ctx, { cursor, limit: 32 });
				rows.push(...page.items);
				bound(rows.length, FILE_CHANGE_LIMITS.revertFiles);
				cursor = page.nextCursor ?? undefined;
				if (page.hasMore && !cursor) throw fail("INCOMPLETE_FILES");
				await yieldToEventLoop();
				run.signal.throwIfAborted();
			} while (cursor);
			const raw: Extract<TransactionManifestRequest, { action: "validate" }>["raw"] = [];
			for (const digest of [
				operation.planBlobDigest,
				operation.selectorBlobDigest,
				operation.historyManifestBlobDigest,
			]) {
				const row = this.db
					.select({ size: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
					.from(fileChangeBlobs)
					.where(eq(fileChangeBlobs.digest, digest ?? ""))
					.get();
				if (!digest || row?.status !== "ready") throw fail("MANIFEST_UNAVAILABLE");
				const ref: FileChangeBlobRef = { algorithm: "sha256", digest, sizeBytes: row.size };
				raw.push({ ref, bytes: await this.readBlob(ref, run.signal) });
			}
			const manifest = await worker<ValidatedTransactionManifest>(
				{
					action: "validate",
					raw,
					operation,
					files: rows,
					userId: run.request.principal.userId,
					...(run.request.acceptSnapshotRestore === undefined
						? {}
						: { acceptSnapshotRestore: run.request.acceptSnapshotRestore }),
				},
				run.signal,
			);
			run.usedBytes = manifest.evidenceBytes;
			bound(run.usedBytes, this.maxEvidenceBytes);
			for (const ref of manifest.rawRefs) await this.readBlob(ref, run.signal);
			const scopes = new Map<string, Scope>();
			for (const file of manifest.files) {
				const fileAccess = {
					principal: run.request.principal,
					owner: run.ctx.owner,
					identity: file.identity,
					signal: run.signal,
				};
				await this.options.access.authorizeFile(fileAccess);
				const preview = await this.options.access.resolveFile(fileAccess);
				await preview.assertCurrent({ signal: run.signal });
				if (
					preview.executionBinding.deviceId !== file.executionBinding.deviceId ||
					preview.executionBinding.runtimeEpoch !== file.executionBinding.runtimeEpoch ||
					preview.executionBinding.runtimeGeneration !== file.executionBinding.runtimeGeneration ||
					fileChangeIdentityKey(preview.identity) !== fileChangeIdentityKey(file.identity) ||
					preview.identity.scopeId !== file.identity.scopeId
				)
					throw fail("PLAN_STALE");
				const scope = this.db
					.select()
					.from(fileChangeScopes)
					.where(eq(fileChangeScopes.id, file.identity.scopeId))
					.get();
				// The lease below owns CURRENT admission. A fence from the read-only
				// preview is not a dependency on every other file in this workspace.
				if (!scope || scope.status !== "active") throw fail("SCOPE_STALE");
				this.scopeIdentity(scope, file);
				if ((await localDirectoryIdentity(scope.canonicalRoot)) !== scope.rootIdentityJson?.object)
					throw fail("ROOT_STALE");
				scopes.set(scope.id, scope);
				const fixed = rows.find((row) => row.sequence === file.sequence);
				if (!fixed) throw fail("INCOMPLETE_FILES");
				run.files.push({ manifest: file, fixed, scope, objectIdentity: null });
			}
			run.worktreePaths = [...new Set([...scopes.values()].map((scope) => scope.canonicalRoot))];
			bound(scopes.size, WORKSPACE_WRITE_COORDINATOR_LIMITS.batchScopes);
			for (const scope of scopes.values()) {
				// Reserve independent compensation IDs too; never auto-split one fixed transaction.
				bound(
					run.files.filter((file) => file.scope.id === scope.id).length * 2,
					WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease,
				);
			}
			return { operation, manifest, scopes };
		}, run.signal);
		if (preflight.outcome) return preflight.outcome;
		const { operation, manifest, scopes } = preflight;
		const perform = (batch?: WorkspaceWriteBatch) =>
			this.options.runtime.tryWithNamespaceAccess(async () => {
				run.leases = batch?.leases ?? [];
				run.signal.throwIfAborted();
				// Waiting permits reset/expiry/journal changes, including for history-only
				// plans. Revalidate before even observing a target or claiming execution.
				await this.namespace(run.signal);
				const current = this.journal.getOperation(run.ctx as RevertJournalContext);
				await this.verifyEntrypoint(run.request, current, run.signal);
				if (current.status !== "prepared") return this.outcome(run, current);
				if (this.plans.getSummary((run.ctx as RevertJournalContext).owner, current.id).expired)
					throw fail("EXPIRED");
				for (const file of run.files) {
					const lease = this.lease(run, file);
					if (
						lease.executionBinding.runtimeEpoch !== file.manifest.executionBinding.runtimeEpoch ||
						lease.executionBinding.runtimeGeneration !==
							file.manifest.executionBinding.runtimeGeneration
					)
						throw fail("WAITING_PLAN_STALE");
					await this.guard(run, file, lease, run.signal);
					// This first read only captures the inode. The full restore preflight below
					// repeats typed/raw/permissions/path checks for every ORIGINAL expected/desired.
					file.objectIdentity = await currentObjectIdentity(
						file.manifest.identity.canonicalPath,
						run.signal,
					);
					const result = await preflightLocalFileRestore(
						this.restoreInput(run, file, lease, run.signal),
					);
					await result.whenSettled;
					if (result.status !== "not_dispatched" || result.reason !== "preflight_verified")
						throw fail(`FILE_PREFLIGHT_${result.reason.toUpperCase()}`);
				}
				// Validate history SQL/COW/cascade support before any target IO, not only at commit.
				if (operation.kind !== "revert")
					await this.history.prepare({
						principal: run.request.principal,
						fixedSelection: manifest.selection,
						signal: run.signal,
					});
				await this.authorizeOwner(run, run.signal);
				await this.freshSelection(run, manifest);
				run.signal.throwIfAborted();
				try {
					const admission = await this.journal.startExecution(
						run.ctx as RevertJournalContext,
						manifest.proof,
						{ signal: run.signal },
					);
					if (!admission.started) return this.outcome(run, admission.operation);
					run.started = true;
					// startExecution validates paginated plan metadata. Catch history writes
					// during those awaits before the first target can be dispatched.
					await this.freshSelection(run, manifest);
					for (const file of run.files) {
						run.signal.throwIfAborted();
						const lease = this.lease(run, file);
						const apply = () => this.mutate(run, file, lease, "apply", run.signal);
						const result = batch ? await batch.runInScope(lease.token, apply) : await apply();
						if (
							!result.confirmed ||
							(result.outcome !== "applied" &&
								!fileChangeStatesEqual(file.manifest.expected, file.manifest.desired))
						)
							throw fail("FILE_NOT_APPLIED");
					}
					// Current state AND original after inode must still match before history can commit.
					for (const file of run.files) await this.verifyDesired(run, file, run.signal);
					await this.freshSelection(run, manifest);
					const finished = await this.journal.finishFiles(run.ctx as RevertJournalContext, {
						signal: run.signal,
					});
					if (finished.status !== "files_verified") throw fail("FILES_UNVERIFIED");
					await this.authorizeOwner(run, run.signal);
					// No journal/coordinator/catalog writes after this preparation until commit.
					const prepared =
						operation.kind === "revert"
							? null
							: await this.history.prepare({
									principal: run.request.principal,
									fixedSelection: manifest.selection,
									signal: run.signal,
								});
					// Last read-only file sweep AFTER every history/owner preparation await.
					// No publication/receipt/lease mutation here: preserve the prepared history
					// stamp while detecting external changes during the worker/ACL window.
					for (const file of run.files) await this.verifyDesired(run, file, run.signal);
					run.signal.throwIfAborted();
					const committed = this.journal.commit(run.ctx as RevertJournalContext, {
						db: this.db,
						apply: (tx) => {
							if (prepared) run.historyResult = this.history.applyToTransaction(tx, prepared);
						},
					});
					return this.outcome(run, committed);
				} catch (error) {
					const live = this.safeOperation(run);
					if (live?.status === "committed") return this.outcome(run, live);
					if (!run.started) {
						if (live?.status === "prepared") throw error;
						this.quarantine(run);
						return this.outcome(run, live, false, "ADMISSION_RESULT_UNKNOWN");
					}
					if (!live || this.db.$client.inTransaction) {
						this.quarantine(run);
						return this.outcome(run, live, false, "COMMIT_RESULT_UNKNOWN");
					}
					logger.warn("Revert execution failed; compensating target files", {
						planId: run.request.planId,
						error: String(error),
					});
					// Return-await keeps namespace ownership through compensation and its
					// real IO settlement, even after the bounded HTTP result has returned.
					return await this.compensate(run, batch);
				}
			}, run.signal);
		for (;;) {
			// Legacy hot-loaded callers may still own namespace before requesting coordinator.
			// Drain outside workspace admission, then atomically try namespace without waiting.
			await this.options.runtime.waitForNamespaceDrain(run.signal);
			try {
				// No fabricated scope for positive no_dispatch / history-only selections.
				if (!scopes.size) return await perform();
				return await this.options.runtime.coordinator.withRollbackMany(
					{
						scopes: [...scopes.values()].map((scope) => ({
							scope,
							runtime: this.runtimeBinding(scope.deviceId),
							activityPolicy: "strict" as const,
							ranges: buildRevertScopeRanges(
								scope,
								run.files
									.filter((file) => file.scope.id === scope.id)
									.map((file) => file.manifest.identity.canonicalPath),
							),
							// This service exclusively awaits native restoreLocalFile IO; it
							// does not launch Bash or delegate mutations to remote processes.
							executionClass: "local_file_io" as const,
						})),
						signal: run.signal,
					},
					perform,
				);
			} catch (error) {
				// withRollbackMany has released every lease before this retry. Cleanup errors
				// wrap the body failure and must never be unwrapped into a retryable busy.
				if (error instanceof FileChangeNamespaceBusyError && !run.started) continue;
				// A failed lease-release SQL write after commit cannot turn committed history
				// into a reported preflight rejection or trigger compensation after release.
				if (!run.started) throw error;
				return this.outcome(run, this.safeOperation(run), false, "COORDINATOR_RECOVERY_REQUIRED");
			}
		}
	}

	private async mutate(
		run: Run,
		file: BoundFile,
		lease: WorkspaceWriteLease,
		phase: "apply" | "compensate",
		signal: AbortSignal,
	): Promise<FileChangeExecutionReceipt> {
		const ctx = run.ctx as RevertJournalContext;
		const claim =
			phase === "apply"
				? this.journal.claimApply(ctx, file.fixed, lease)
				: this.journal.claimCompensate(ctx, file.fixed, lease);
		if (!claim.mayExecute) throw fail("RECOVERY_REQUIRED");
		lease.registerMutation(claim.mutationId);
		let result: LocalFileRestoreResult;
		try {
			result = await restoreLocalFile(this.restoreInput(run, file, lease, signal, claim, phase));
			await result.whenSettled;
		} catch (error) {
			lease.markUncertain();
			throw error;
		}
		// Finishing this invocation is independent of the user's cancellation. No late
		// result (including same desired bytes) upgrades uncertain_after_dispatch.
		const finishing = AbortSignal.timeout(this.cleanupMs);
		let observation = result.observation;
		try {
			if (!observation) observation = await this.observeForReceipt(run, file, lease, finishing);
			observation = await this.publishObservation(run, file, observation, finishing);
			const receipt: FileChangeExecutionReceipt = {
				receiptId: generateId(),
				mutationId: claim.mutationId,
				requestDigest: claim.requestDigest,
				executionBinding: claim.executionBinding,
				confirmed: result.status !== "uncertain_after_dispatch",
				outcome:
					result.status === "applied"
						? "applied"
						: result.status === "not_dispatched"
							? "not_applied"
							: "unknown",
				observedAfter: observation.state,
			};
			const recorded =
				phase === "apply"
					? await this.journal.recordApplyReceipt(ctx, file.fixed.id, receipt)
					: await this.journal.recordCompensateReceipt(ctx, file.fixed.id, receipt);
			// Keep only the original apply object identity; release retained raw bodies.
			if (
				phase === "apply" &&
				result.status === "applied" &&
				result.observation &&
				fileChangeStatesEqual(result.observation.state, file.manifest.desired)
			)
				file.appliedObservation = { ...result.observation, raw: null };
			lease.settle(claim.mutationId, receipt.confirmed ? receipt.outcome : "unknown");
			if (phase === "compensate" && recorded.status !== "compensated") lease.markUncertain();
			return receipt;
		} catch (error) {
			// A publication/receipt error never settles an unpersisted mutation. The
			// durable applying claim and scope hold survive restart; no blind retry.
			lease.markUncertain();
			throw error;
		}
	}

	private async compensate(
		run: Run,
		batch?: WorkspaceWriteBatch,
	): Promise<RevertTransactionOutcome> {
		const ctx = run.ctx as RevertJournalContext;
		const signal = AbortSignal.timeout(this.cleanupMs);
		try {
			const operation = this.journal.getOperation(ctx);
			if (operation.status === "committed") return this.outcome(run, operation);
			this.journal.beginCompensation(ctx);
			for (const file of [...run.files].reverse()) {
				if (!file.appliedObservation) continue;
				const lease = this.lease(run, file);
				try {
					signal.throwIfAborted();
					const act = () => this.mutate(run, file, lease, "compensate", signal);
					if (batch) await batch.runInScope(lease.token, act);
					else await act();
				} catch {
					// An uncertain scope cannot authorize more writes. Other proven scopes
					// may finish only while the independent, bounded cleanup budget remains.
					try {
						lease.markUncertain();
					} catch {
						/* Coordinator retains failed persistence. */
					}
				}
			}
			const finished = await this.journal.finishCompensation(ctx, { signal });
			if (finished.status !== "compensated") this.quarantine(run);
			return this.outcome(run, finished);
		} catch {
			const operation = this.safeOperation(run);
			if (operation?.status !== "committed" && operation?.status !== "compensated")
				this.quarantine(run);
			return this.outcome(run, operation, false, "RECOVERY_REQUIRED");
		}
	}

	private restoreInput(
		run: Run,
		file: BoundFile,
		lease: WorkspaceWriteLease,
		signal: AbortSignal,
		claim?: RevertJournalClaim,
		phase: "apply" | "compensate" = "apply",
	): LocalFileRestoreInput {
		const compensation = phase === "compensate";
		const mutationId = claim?.mutationId ?? file.fixed.applyMutationId;
		const expected = claim?.expected ?? file.manifest.expected;
		const desired = claim?.desired ?? file.manifest.desired;
		if (expected.kind === "unknown" || desired.kind === "unknown") throw fail("UNKNOWN_STATE");
		if (compensation && !file.appliedObservation) throw fail("APPLY_OBSERVATION_REQUIRED");
		const rootObjectIdentity = file.scope.rootIdentityJson?.object;
		if (typeof rootObjectIdentity !== "string") throw fail("ROOT_UNVERIFIED");
		return {
			mutationId,
			requestDigest: claim?.requestDigest ?? file.fixed.applyRequestDigest,
			identity: file.manifest.identity,
			scope: file.scope,
			executionBinding: claim?.executionBinding ?? lease.executionBinding,
			rootObjectIdentity,
			expectedObjectIdentity: compensation
				? (file.appliedObservation?.objectIdentity ?? null)
				: file.objectIdentity,
			expected,
			desired,
			createParents: false,
			backend: localBackend,
			lease,
			readRuntime: this.readRuntime,
			signal,
			timeoutMs: Math.min(this.timeoutMs, 120_000),
			authorize: async (guard) =>
				this.options.access.authorizeFile({
					principal: run.request.principal,
					owner: (run.ctx as RevertJournalContext).owner,
					identity: guard.identity,
					signal: guard.signal,
				}),
			assertCurrent: async (guard) => {
				await this.guard(run, file, lease, guard.signal);
				if (claim) this.assertClaim(run, file, claim, phase);
			},
			onDispatch: () => {
				if (!claim) throw fail("PREFLIGHT_DISPATCH_FORBIDDEN");
				this.assertClaim(run, file, claim, phase);
				lease.assertMutationPending(mutationId);
			},
			readBlob: (ref, options) => this.readBlob(ref, options.signal),
		};
	}

	private assertClaim(
		run: Run,
		file: BoundFile,
		claim: RevertJournalClaim,
		phase: "apply" | "compensate",
	) {
		const operation = this.journal.getOperation(run.ctx as RevertJournalContext);
		if (operation.status !== (phase === "apply" ? "applying" : "compensating"))
			throw fail("PHASE_STALE");
		const row = this.db
			.select()
			.from(revertOperationFiles)
			.where(eq(revertOperationFiles.id, file.fixed.id))
			.get();
		const stored = (row?.receiptJson as FileChangeRevertMutationJournal | null)?.[phase];
		if (
			row?.revertOperationId !== operation.id ||
			row.status !== (phase === "apply" ? "applying" : "compensating") ||
			row.fileKey !== file.fixed.fileKey ||
			row.scopeId !== file.fixed.scopeId ||
			row.sequence !== file.fixed.sequence ||
			!fileChangeStatesEqual(row.expectedStateJson, file.manifest.expected) ||
			!fileChangeStatesEqual(row.desiredStateJson, file.manifest.desired) ||
			JSON.stringify(row.identityJson) !== JSON.stringify(file.fixed.identityJson) ||
			row[phase === "apply" ? "applyMutationId" : "compensateMutationId"] !== claim.mutationId ||
			row[phase === "apply" ? "applyRequestDigest" : "compensateRequestDigest"] !==
				claim.requestDigest ||
			!stored ||
			stored.receipt ||
			!fileChangeExecutionBindingMatches(stored.executionBinding, claim.executionBinding)
		)
			throw fail("CLAIM_STALE");
		const namespace = this.options.namespace;
		const budget = namespace.catalog.getBudget();
		if (
			budget?.status !== "ready" ||
			budget.generation !== namespace.generation ||
			budget.namespaceKey !== this.options.planOptions.namespaceKey
		)
			throw fail("NAMESPACE_STALE");
		for (const [state, pin] of [
			[row.expectedStateJson, row.beforeBlobDigest],
			[row.desiredStateJson, row.desiredBlobDigest],
		] as const) {
			if (state.kind === "absent") {
				if (pin !== null) throw fail("CLAIM_PIN_STALE");
				continue;
			}
			if (state.kind !== "regular" || state.blob.digest !== pin) throw fail("CLAIM_PIN_STALE");
			const ready = namespace.catalog.getMetadata({
				expectedGeneration: namespace.generation,
				ref: state.blob,
			});
			if (ready?.status !== "ready" || ready.sizeBytes !== state.blob.sizeBytes)
				throw fail("CLAIM_PIN_STALE");
		}
	}
	private async guard(run: Run, file: BoundFile, lease: WorkspaceWriteLease, signal: AbortSignal) {
		signal.throwIfAborted();
		lease.assertCurrent();
		await this.options.access.authorizeFile({
			principal: run.request.principal,
			owner: (run.ctx as RevertJournalContext).owner,
			identity: file.manifest.identity,
			signal,
		});
		// Recheck the real target AFTER the last caller-owned authorization await.
		// An ACL callback cannot retarget a path and then let a cleanup read follow it.
		const namespace = await this.namespace(signal);
		const current = this.db
			.select()
			.from(fileChangeScopes)
			.where(eq(fileChangeScopes.id, file.scope.id))
			.get();
		if (
			!current ||
			current.status !== "active" ||
			current.sourceInstanceId !== namespace.sourceInstanceId ||
			current.rootIdentityJson?.object !== file.scope.rootIdentityJson?.object ||
			current.canonicalRoot !== file.scope.canonicalRoot
		)
			throw fail("SCOPE_STALE");
		this.scopeIdentity(current, file.manifest);
		if (
			(await localDirectoryIdentity(current.canonicalRoot)) !== file.scope.rootIdentityJson?.object
		)
			throw fail("ROOT_STALE");
		const resolved = await localBackend.resolvePathIdentity(file.manifest.identity.lexicalPath, {
			signal,
		});
		if (
			// Windows canonicalization may differ only in drive-letter/case spelling.
			// POSIX `equals` compares normalized canonical paths, i.e. the same object.
			!localBackend.paths.equals(resolved.canonicalPath, file.manifest.identity.canonicalPath) ||
			resolved.runtimeGeneration !== lease.executionBinding.runtimeGeneration
		)
			throw fail("PATH_STALE");
		const runtime = this.runtimeBinding(LOCAL_DEVICE_ID);
		if (
			runtime.runtimeEpoch !== lease.executionBinding.runtimeEpoch ||
			runtime.runtimeGeneration !== lease.executionBinding.runtimeGeneration ||
			localBackend.runtimeGeneration !== runtime.runtimeGeneration
		)
			throw fail("RUNTIME_STALE");
		lease.assertCurrent();
		signal.throwIfAborted();
	}
	private scopeIdentity(scope: Scope, file: TransactionManifestFile) {
		if (
			file.identity.deviceId !== LOCAL_DEVICE_ID ||
			(localBackend.pathFlavor !== "posix" && localBackend.pathFlavor !== "windows") ||
			file.identity.pathFlavor !== localBackend.pathFlavor ||
			scope.pathFlavor !== localBackend.pathFlavor ||
			!scope.rootIdentityJson?.object ||
			fileChangeIdentityKey(createFileChangeIdentity(scope, file.identity)) !==
				fileChangeIdentityKey(file.identity) ||
			scope.id !== file.identity.scopeId
		)
			throw fail("IDENTITY_UNVERIFIED");
	}
	private async verifyDesired(run: Run, file: BoundFile, signal: AbortSignal) {
		const lease = this.lease(run, file);
		await this.guard(run, file, lease, signal);
		const current = await observe(file.manifest.identity.canonicalPath, signal);
		if (
			!fileChangeStatesEqual(current.state, file.manifest.desired) ||
			current.objectIdentity !==
				(file.appliedObservation ? file.appliedObservation.objectIdentity : file.objectIdentity)
		)
			throw fail("FINAL_FILE_STALE");
		await this.guard(run, file, lease, signal);
	}
	private async freshSelection(run: Run, manifest: ValidatedTransactionManifest) {
		const stamp = this.stamp();
		const current = await this.selection.collect({
			principal: run.request.principal,
			narratorId: run.request.narratorId,
			expectedMessageVersion: manifest.header.expectedMessageVersion,
			selector: manifest.selection.selector,
			signal: run.signal,
		});
		await worker({ action: "compare", fixed: manifest.selection, current }, run.signal);
		if (this.stamp() !== stamp) throw fail("HISTORY_STALE");
	}
	private stamp() {
		const changes = this.db.$client
			.query<{ value: number }, []>("SELECT total_changes() AS value")
			.get()?.value;
		const version = this.db.$client
			.query<{ data_version: number }, []>("PRAGMA data_version")
			.get()?.data_version;
		return `${changes}:${version}`;
	}
	private async authorizeOwner(run: Run, signal: AbortSignal) {
		await this.options.access.authenticate(run.request.principal, signal);
		const current = await this.options.access.resolveContext({
			principal: run.request.principal,
			narratorId: run.request.narratorId,
			signal,
		});
		if (current.projectId !== run.ctx?.owner.projectId) throw fail("OWNER_STALE");
	}
	private async namespace(signal: AbortSignal, allowRecoveredNamespace = false) {
		const namespace = await this.options.runtime.verifyNamespace(signal);
		const budget = namespace.catalog.getBudget();
		if (
			(allowRecoveredNamespace
				? namespace.generation !== this.options.namespace.generation
				: namespace !== this.options.namespace) ||
			budget?.status !== "ready" ||
			budget.namespaceKey !== this.options.planOptions.namespaceKey ||
			budget.generation !== namespace.generation
		)
			throw fail("NAMESPACE_STALE");
		return namespace;
	}
	private async readBlob(
		ref: FileChangeBlobRef,
		signal: AbortSignal,
		allowRecoveredNamespace = false,
	) {
		bound(ref.sizeBytes, FILE_CHANGE_LIMITS.blobBytes);
		const namespace = await this.namespace(signal, allowRecoveredNamespace);
		const row = namespace.catalog.getMetadata({ expectedGeneration: namespace.generation, ref });
		if (row?.status !== "ready" || row.sizeBytes !== ref.sizeBytes) throw fail("RAW_UNAVAILABLE");
		const bytes = await namespace.store.readBytes(ref, {
			signal,
			maxBytes: FILE_CHANGE_LIMITS.blobBytes,
		});
		await this.namespace(signal, allowRecoveredNamespace);
		return bytes;
	}
	private async observeForReceipt(
		run: Run,
		file: BoundFile,
		lease: WorkspaceWriteLease,
		signal: AbortSignal,
	): Promise<LocalRestoreObservation> {
		try {
			await this.guard(run, file, lease, signal);
			const observed = await observe(file.manifest.identity.canonicalPath, signal);
			await this.guard(run, file, lease, signal);
			return observed;
		} catch {
			// Cleanup is not a new read capability. Revoked ACL/runtime or a retargeted
			// path cannot authorize reading/publishing another referent as our after-state.
			// Execution outcome still comes exclusively from this invocation's result.
			return unknownObservation("target_unverified");
		}
	}
	private async publishObservation(
		run: Run,
		file: BoundFile,
		observation: LocalRestoreObservation,
		signal: AbortSignal,
	): Promise<LocalRestoreObservation> {
		const state = observation.state;
		if (state.kind === "absent" || state.kind === "unknown") {
			if (observation.raw !== null || observation.objectIdentity !== null)
				throw fail("OBSERVATION_INVALID");
			return observation;
		}
		if (
			state.kind !== "regular" ||
			!observation.raw ||
			observation.raw.byteLength !== state.blob.sizeBytes
		)
			throw fail("OBSERVATION_UNAVAILABLE");
		// The fixed plan already charged expected + desired. Journal fileBytes uses
		// the same typed-state comparison; do not fail after IO by charging normal
		// apply/compensation copies again. Only independent third-state evidence grows.
		const extraBytes =
			fileChangeStatesEqual(state, file.manifest.expected) ||
			fileChangeStatesEqual(state, file.manifest.desired)
				? 0
				: state.blob.sizeBytes;
		if (extraBytes > this.maxEvidenceBytes - run.usedBytes)
			return unknownObservation("budget_exceeded");
		const namespace = await this.namespace(signal);
		await namespace.store.putBytes(observation.raw, {
			signal,
			expectedDigest: state.blob.digest,
			expectedSize: state.blob.sizeBytes,
		});
		const ready = namespace.catalog.getMetadata({
			expectedGeneration: namespace.generation,
			ref: state.blob,
		});
		if (ready?.status !== "ready" || ready.sizeBytes !== state.blob.sizeBytes)
			throw fail("OBSERVATION_NOT_READY");
		run.usedBytes += extraBytes;
		return observation;
	}
	private runtimeBinding(deviceId: string) {
		const runtime = this.readRuntime(deviceId);
		if (!runtime) throw fail("RUNTIME_UNAVAILABLE");
		return runtime;
	}
	private lease(run: Run, file: BoundFile) {
		const lease = run.leases.find((value) => value.scope.id === file.scope.id);
		if (!lease) throw fail("MISSING_LEASE");
		return lease;
	}
	private safeOperation(run: Run) {
		try {
			return run.ctx ? this.journal.getOperation(run.ctx) : null;
		} catch {
			return null;
		}
	}
	private quarantine(run: Run) {
		for (const lease of run.leases) {
			try {
				lease.markUncertain();
			} catch {
				/* Coordinator also retains failed quarantine persistence. */
			}
		}
	}
	private outcome(
		run: Run,
		operation: RevertJournalOperation | null,
		settling = false,
		reason: string | null = null,
	): RevertTransactionOutcome {
		const status =
			operation?.status === "committed" || operation?.status === "compensated"
				? operation.status
				: "recovery_required";
		return {
			planId: run.request.planId,
			status,
			journalStatus: operation?.status ?? null,
			settling,
			...(status === "committed"
				? { historyResult: run.historyResult, worktreePaths: run.worktreePaths }
				: {}),
			// History/file terminality does not prove coordinator finalization succeeded.
			// Preserve an explicit release/recovery warning alongside the durable result.
			reason:
				reason ??
				(status === "committed" || status === "compensated"
					? null
					: (operation?.reason ?? "RECOVERY_REQUIRED")),
		};
	}
	private report(started: number, files: number, status: string) {
		const durationMs = performance.now() - started;
		if (durationMs < 1_000) return;
		try {
			const event = { service: "revert-transaction" as const, durationMs, files, status };
			if (this.options.onSlow) this.options.onSlow(event);
			else console.warn("[revert-transaction] slow local transaction", event);
		} catch {
			/* Reporting is not transaction authority. */
		}
	}
}

function unknownObservation(
	reason: "target_unverified" | "budget_exceeded",
): LocalRestoreObservation {
	return { state: { kind: "unknown", reason }, raw: null, objectIdentity: null };
}
async function currentObjectIdentity(path: string, signal: AbortSignal): Promise<string | null> {
	signal.throwIfAborted();
	try {
		const stat = await lstat(path, { bigint: true });
		signal.throwIfAborted();
		if (!stat.isFile() || stat.nlink !== 1n || stat.isSymbolicLink())
			throw fail("UNSUPPORTED_OBJECT");
		if (stat.size < 0n || stat.size > BigInt(FILE_CHANGE_LIMITS.blobBytes))
			throw fail("BUDGET_EXCEEDED");
		return localObjectIdentity(stat);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
async function observe(path: string, signal: AbortSignal): Promise<LocalRestoreObservation> {
	const observation: LocalFileObservation = await fileChangeLocalIo.read(path, signal);
	if (observation.bytes === null)
		return { state: { kind: "absent" }, raw: null, objectIdentity: null };
	if (observation.mode === null || !observation.identity) throw fail("OBSERVATION_INVALID");
	const hash = createHash("sha256");
	for (
		let offset = 0;
		offset < observation.bytes.byteLength;
		offset += FILE_CHANGE_LIMITS.streamChunkBytes
	) {
		signal.throwIfAborted();
		hash.update(observation.bytes.subarray(offset, offset + FILE_CHANGE_LIMITS.streamChunkBytes));
		await yieldToEventLoop();
	}
	return {
		state: {
			kind: "regular",
			mode: observation.mode,
			blob: {
				algorithm: "sha256",
				digest: hash.digest("hex"),
				sizeBytes: observation.bytes.byteLength,
			},
		},
		raw: observation.bytes,
		objectIdentity: observation.identity,
	};
}
function fixedRequest(input: RevertTransactionRequest): Omit<RevertTransactionRequest, "signal"> {
	if (
		!input ||
		Object.keys(input).some(
			(key) =>
				![
					"principal",
					"narratorId",
					"planId",
					"planHash",
					"action",
					"acceptSnapshotRestore",
					"signal",
				].includes(key),
		)
	)
		throw fail("INVALID_REQUEST");
	if (
		!input.principal ||
		Object.keys(input.principal).some((key) => !["userId", "isAdmin"].includes(key)) ||
		typeof input.principal.isAdmin !== "boolean"
	)
		throw fail("AUTHENTICATION_REQUIRED");
	for (const value of [input.principal.userId, input.narratorId, input.planId])
		if (
			typeof value !== "string" ||
			!value ||
			value.includes("\0") ||
			Buffer.byteLength(value) > 256
		)
			throw fail("INVALID_REQUEST");
	if (
		input.action !== undefined &&
		!["revert_files", "rollback_to_block", "delete_tool_block"].includes(input.action)
	)
		throw fail("INVALID_REQUEST");
	if (input.acceptSnapshotRestore !== undefined && input.acceptSnapshotRestore !== true)
		throw fail("INVALID_REQUEST");
	if (typeof input.planHash !== "string" || !/^[a-f0-9]{64}$/.test(input.planHash))
		throw fail("INVALID_PLAN_HASH");
	return Object.freeze({
		principal: Object.freeze({ ...input.principal }),
		narratorId: input.narratorId,
		planId: input.planId,
		planHash: input.planHash,
		...(input.action === undefined ? {} : { action: input.action }),
		...(input.acceptSnapshotRestore === undefined
			? {}
			: { acceptSnapshotRestore: input.acceptSnapshotRestore }),
	});
}
function bound(value: number, max: number, min = 0) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw fail("BUDGET_EXCEEDED");
}
function fail(code: string) {
	return new RevertTransactionError(code);
}
