import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeRevertAction,
	type FileChangeRevertFileResult,
	type FileChangeRevertSelector,
} from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { fileChangeBlobs, fileChangeScopes } from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { fileChangeIdentityKey, fileChangePhysicalIdentityKey } from "./file-change-identity";
import { type LocalFileRestoreResult, restoreLocalFile } from "./file-change-local-restore";
import type { LocalFileChangeRuntime } from "./file-change-runtime";
import { FILE_WRITE_QUEUE_LIMITS, withFileWrite } from "./file-write-queue";
import type { NarratorPrincipal } from "./narrator-acl";
import { type RevertHistoryApplyResult, RevertHistoryCommitService } from "./revert-history-commit";
import {
	type RevertFileResult,
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

export { RevertTransactionError } from "./revert-transaction-worker";

type Namespace = Awaited<ReturnType<LocalFileChangeRuntime["verifyNamespace"]>>;
export interface RevertTransactionRequest {
	principal: NarratorPrincipal;
	narratorId: string;
	planId: string;
	planHash: string;
	action?: FileChangeRevertAction;
	expectedSelector?: FileChangeRevertSelector;
	acceptSnapshotRestore?: true;
	signal?: AbortSignal;
}
export interface RevertTransactionOutcome {
	planId: string;
	status: "committed" | "partial" | "failed" | "cancelled" | "executing";
	journalStatus: RevertJournalOperation["status"] | null;
	settling: boolean;
	reason: string | null;
	files: FileChangeRevertFileResult[];
	historyStatus: "complete" | "unavailable";
	historyCommitted: boolean;
	historyResult?: RevertHistoryApplyResult;
	worktreePaths?: string[];
}
export interface RevertTransactionExecution {
	result: Promise<RevertTransactionOutcome>;
	/** Covers actual IO. A response deadline never releases a running file's queue. */
	whenSettled: Promise<RevertTransactionOutcome>;
}
export interface RevertTransactionOptions {
	access: RevertPlannerAccess;
	runtime: LocalFileChangeRuntime;
	namespace: Namespace;
	planOptions: RevertPlanOptions;
	timeoutMs?: number;
	cleanupTimeoutMs?: number;
	maxEvidenceBytes?: number;
	onSlow?: (event: {
		service: "revert-transaction";
		durationMs: number;
		files: number;
		status: string;
	}) => void;
}
type Run = {
	request: Omit<RevertTransactionRequest, "signal">;
	signal: AbortSignal;
	ctx?: RevertJournalContext;
	operation?: RevertJournalOperation;
	files: RevertJournalFile[];
	results: Map<string, RevertFileResult>;
	origins: Map<string, Map<string, TransactionManifestFile["identity"]>>;
	worktreePaths: Set<string>;
	started: boolean;
	historyUnavailable: boolean;
	historyResult?: RevertHistoryApplyResult;
};

const liveRuns = hotSafe("revert-live-attempts-v3", () => new Map<string, Run>());

/** Fixed preview, independent file attempts, then a short message-history transaction. */
export class RevertTransactionService {
	private readonly journal: RevertMutationJournal;
	private readonly plans: RevertPlanService;
	private readonly history: RevertHistoryCommitService;
	private readonly selection: RevertSelectionService;
	private readonly timeoutMs: number;
	private readonly cleanupMs: number;
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
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.cleanupMs = options.cleanupTimeoutMs ?? 30_000;
		bound(this.timeoutMs, FILE_CHANGE_LIMITS.planLifetimeMs, 1);
		bound(this.cleanupMs, 120_000, 1);
		this.journal = new RevertMutationJournal(db, options.planOptions);
		this.plans = new RevertPlanService(db, options.planOptions);
		const authorize = options.access.authorizeNarrator.bind(options.access);
		this.history = new RevertHistoryCommitService(db, { authorize });
		this.selection = new RevertSelectionService(db, { authorize });
	}
	async validateHttpAction(input: RevertTransactionRequest): Promise<void> {
		const request = fixedRequest(input);
		if (!request.action) throw fail("ACTION_MISMATCH");
		const signal = input.signal ?? AbortSignal.timeout(this.timeoutMs);
		const ctx = await this.context(request, signal);
		await this.verifyEntrypoint(request, this.journal.getOperation(ctx), signal);
	}
	private async context(
		request: Omit<RevertTransactionRequest, "signal">,
		signal: AbortSignal,
	): Promise<RevertJournalContext> {
		await this.options.access.authenticate(request.principal, signal);
		const context = await this.options.access.resolveContext({
			principal: request.principal,
			narratorId: request.narratorId,
			signal,
		});
		return {
			owner: {
				subjectKey: `human:${request.principal.userId}`,
				narratorId: request.narratorId,
				projectId: context.projectId,
			},
			planId: request.planId,
			planHash: request.planHash,
		};
	}
	private async verifyEntrypoint(
		request: Omit<RevertTransactionRequest, "signal">,
		operation: RevertJournalOperation,
		signal: AbortSignal,
	) {
		if (
			operation.scope !== "narrator" ||
			!["revert", "history_delete", "rollback_to_block"].includes(operation.kind)
		)
			throw fail("UNSUPPORTED");
		if (request.action) {
			const kind = {
				revert_files: "revert",
				rollback_to_block: "rollback_to_block",
				delete_tool_block: "history_delete",
				edit_and_regenerate: "rollback_to_block",
			}[request.action];
			if (operation.kind !== kind) throw fail("ACTION_MISMATCH");
		}
		if (operation.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION) return;
		// Terminal replays perform no IO, yet an explicit action/selector must still match
		// the original consent before any recorded result is returned.
		const replay = operation.status !== "prepared";
		if (replay && !request.action && !request.expectedSelector) return;
		const ref = this.blobRef(operation.selectorBlobDigest);
		await worker<boolean>(
			{
				action: "entrypoint",
				raw: { ref, bytes: await this.readBlob(ref, signal) },
				operation,
				userId: request.principal.userId,
				...(request.action ? { expectedAction: request.action } : {}),
				...(request.expectedSelector ? { expectedSelector: request.expectedSelector } : {}),
				// Snapshot consent gates IO only; a terminal replay cannot dispatch again.
				...(request.acceptSnapshotRestore || replay ? { acceptSnapshotRestore: true } : {}),
			},
			signal,
		);
	}
	execute(input: RevertTransactionRequest): RevertTransactionExecution {
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency) throw fail("BUSY");
		const request = fixedRequest(input);
		const controller = new AbortController();
		const stop = () => controller.abort(fail("CANCELLED"));
		input.signal?.addEventListener("abort", stop, { once: true });
		if (input.signal?.aborted) stop();
		const timer = setTimeout(() => controller.abort(fail("TIMEOUT")), this.timeoutMs);
		const run: Run = {
			request,
			signal: controller.signal,
			files: [],
			results: new Map(),
			origins: new Map(),
			worktreePaths: new Set(),
			started: false,
			historyUnavailable: false,
		};
		const started = performance.now();
		this.active++;
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let stopResponse = () => {};
		const body = this.run(run).finally(() => {
			if (liveRuns.get(request.planId) === run) liveRuns.delete(request.planId);
			this.active--;
			clearTimeout(timer);
			if (responseTimer) clearTimeout(responseTimer);
			input.signal?.removeEventListener("abort", stop);
			controller.signal.removeEventListener("abort", stopResponse);
		});
		const result = new Promise<RevertTransactionOutcome>((resolve, reject) => {
			stopResponse = () => {
				responseTimer = setTimeout(
					() =>
						run.started
							? resolve(this.outcome(run, true, "IO_PENDING"))
							: reject(fail("CANCELLED")),
					this.cleanupMs,
				);
			};
			controller.signal.addEventListener("abort", stopResponse, { once: true });
			if (controller.signal.aborted) stopResponse();
			body.then(resolve, reject);
		});
		void result.catch(() => {});
		void body.then(
			(outcome) => {
				const durationMs = performance.now() - started;
				if (durationMs > 1_000)
					this.options.onSlow?.({
						service: "revert-transaction",
						durationMs,
						files: run.files.length,
						status: outcome.status,
					});
			},
			() => {},
		);
		return { result, whenSettled: body };
	}
	private async run(run: Run): Promise<RevertTransactionOutcome> {
		run.ctx = await this.context(run.request, run.signal);
		run.operation = this.journal.getOperation(run.ctx);
		await this.verifyEntrypoint(run.request, run.operation, run.signal);
		run.files = await this.readFiles(run.ctx, run.signal);
		// Queries after a lost response return recorded facts; old/pending attempts never dispatch.
		if (
			run.operation.status !== "prepared" ||
			run.operation.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION
		)
			return this.replay(run);
		if (this.plans.getSummary(run.ctx.owner, run.ctx.planId).expired) throw fail("EXPIRED");
		const manifest = await this.manifest(run);
		await this.freshSelection(run, manifest);
		const admission = await this.journal.startExecution(run.ctx, manifest.proof, {
			signal: run.signal,
		});
		run.operation = admission.operation;
		if (!admission.started) return this.replay(run);
		run.started = true;
		liveRuns.set(run.request.planId, run);
		const rows = new Map(run.files.map((file) => [file.sequence, file]));
		for (const effect of manifest.selection.effects) {
			const key = fileChangePhysicalIdentityKey(effect.identity);
			const origins = run.origins.get(key) ?? new Map();
			origins.set(effect.identity.scopeId, effect.identity);
			run.origins.set(key, origins);
		}
		for (const file of manifest.files) {
			const row = rows.get(file.sequence);
			if (!row) throw fail("INCOMPLETE_FILES");
			await this.attempt(run, row, file);
		}
		try {
			run.operation = await this.journal.finishFiles(run.ctx, {
				cancelled: run.signal.aborted,
				reason: run.signal.aborted ? "CANCELLED" : null,
			});
			if (run.operation.status === "files_verified") await this.commitHistory(run, manifest);
		} catch (error) {
			run.historyUnavailable = true;
			try {
				run.operation = this.journal.failHistory(run.ctx, errorCode(error));
			} catch {
				/* Preserve measured file results. */
			}
		}
		return this.outcome(run);
	}
	private async attempt(run: Run, row: RevertJournalFile, file: TransactionManifestFile) {
		let result: RevertFileResult;
		if (run.signal.aborted) result = fileResult("not_attempted", "CANCELLED");
		else {
			try {
				result = await withFileWrite(
					file.identity,
					async () => {
						run.signal.throwIfAborted();
						// User cancellation affects later items. This item's budget covers actual IO.
						const signal = AbortSignal.timeout(this.timeoutMs);
						const access = {
							principal: run.request.principal,
							owner: (run.ctx as RevertJournalContext).owner,
							identity: file.identity,
							signal,
						};
						await this.options.access.authenticate(run.request.principal, signal);
						await this.authorizeOrigins(run, file, signal);
						const target = await this.options.access.resolveFile(access);
						await target.assertCurrent({ signal });
						if (
							fileChangeIdentityKey(target.identity) !== fileChangeIdentityKey(file.identity) ||
							target.identity.scopeId !== file.identity.scopeId
						)
							return fileResult("conflict", "TARGET_CHANGED");
						const scope = this.db
							.select()
							.from(fileChangeScopes)
							.where(eq(fileChangeScopes.id, file.identity.scopeId))
							.get();
						if (!scope) return fileResult("failed", "SCOPE_METADATA_MISSING");
						run.worktreePaths.add(scope.canonicalRoot);
						if (!this.journal.startFile(run.ctx as RevertJournalContext, row.id))
							return fileResult("unknown", "ATTEMPT_ALREADY_STARTED");
						run.results.set(row.id, fileResult("unknown", "IO_PENDING"));
						if (file.desired.kind === "unknown") return fileResult("failed", file.desired.reason);
						if (file.expected.kind === "unknown")
							return fileResult("conflict", file.expected.reason);
						const restored = await restoreLocalFile({
							mutationId: row.applyMutationId,
							requestDigest: row.applyRequestDigest,
							identity: file.identity,
							scope,
							expected: file.expected,
							desired: file.desired,
							createParents: true,
							backend: localBackend,
							authorize: (guard) => this.authorizeOrigins(run, file, guard.signal),
							assertCurrent: (guard) => target.assertCurrent({ signal: guard.signal }),
							onDispatch: () => {},
							readBlob: (ref, opts) => this.readBlob(ref, opts.signal),
							signal,
							timeoutMs: Math.min(this.timeoutMs, 120_000),
						});
						await restored.whenSettled;
						return restoreResult(restored);
					},
					{
						signal: run.signal,
						// The run budget may exceed the queue's admission ceiling; IO keeps its own.
						waitTimeoutMs: Math.min(this.timeoutMs, FILE_WRITE_QUEUE_LIMITS.maxWaitTimeoutMs),
					},
				);
			} catch (error) {
				result = run.results.has(row.id)
					? fileResult("unknown", errorCode(error))
					: fileResult(
							run.signal.aborted
								? "not_attempted"
								: /STALE|CHANGED|MISMATCH/.test(errorCode(error))
									? "conflict"
									: "failed",
							errorCode(error),
						);
			}
		}
		// Queue is released before history publication and result recording.
		try {
			const after = result.observedAfter;
			if (result.status === "applied" && after?.kind === "regular") this.blobRef(after.blob.digest);
			const recorded = this.journal.recordResult(run.ctx as RevertJournalContext, row.id, result);
			if (
				recorded.receiptJson &&
				"historyStatus" in recorded.receiptJson &&
				recorded.receiptJson.historyStatus === "unavailable"
			) {
				result = { ...result, historyStatus: "unavailable" };
				run.historyUnavailable = true;
			}
		} catch (error) {
			result = { ...result, historyStatus: "unavailable" };
			run.historyUnavailable = true;
			logger.warn("Revert file result history unavailable", {
				planId: run.request.planId,
				reason: errorCode(error),
			});
		}
		run.results.set(row.id, result);
	}
	private async authorizeOrigins(run: Run, file: TransactionManifestFile, signal: AbortSignal) {
		const origins = run.origins.get(fileChangePhysicalIdentityKey(file.identity));
		for (const identity of origins?.values() ?? [file.identity]) {
			await this.options.access.authorizeFile({
				principal: run.request.principal,
				owner: (run.ctx as RevertJournalContext).owner,
				identity,
				signal,
			});
		}
	}
	private async commitHistory(run: Run, manifest: ValidatedTransactionManifest) {
		if (run.signal.aborted) {
			run.operation = this.journal.failHistory(
				run.ctx as RevertJournalContext,
				"CANCELLED_BEFORE_HISTORY",
			);
			return;
		}
		// History.prepare rechecks the fixed selection itself. File-only restores have
		// no history preparation, so retain their source validation here.
		if (run.operation?.kind === "revert") await this.freshSelection(run, manifest);
		else {
			const currentContext = await this.context(run.request, run.signal);
			if (currentContext.owner.projectId !== run.ctx?.owner.projectId) throw fail("CONTEXT_STALE");
		}
		const prepared =
			run.operation?.kind === "revert"
				? null
				: await this.history.prepare({
						principal: run.request.principal,
						fixedSelection: manifest.selection,
						snapshotRecovery: manifest.snapshotRecovery,
						signal: run.signal,
					});
		run.operation = this.journal.commit(run.ctx as RevertJournalContext, {
			db: this.db,
			apply: (tx) => {
				if (prepared) run.historyResult = this.history.applyToTransaction(tx, prepared);
			},
		});
	}
	private async freshSelection(run: Run, manifest: ValidatedTransactionManifest) {
		const currentContext = await this.context(run.request, run.signal);
		if (currentContext.owner.projectId !== run.ctx?.owner.projectId) throw fail("CONTEXT_STALE");
		const current = await this.selection.collect({
			principal: run.request.principal,
			narratorId: run.request.narratorId,
			selector: manifest.selection.selector,
			historyRewrite: run.operation?.kind !== "revert",
			signal: run.signal,
		});
		await worker<boolean>({ action: "compare", fixed: manifest.selection, current }, run.signal);
	}
	private async replay(run: Run): Promise<RevertTransactionOutcome> {
		const ctx = run.ctx as RevertJournalContext;
		let before = this.journal.getOperation(ctx);
		for (let read = 0; read < 3; read++) {
			run.files = await this.readFiles(ctx, run.signal);
			run.operation = this.journal.getOperation(ctx);
			if (run.operation.updatedAt === before.updatedAt) break;
			before = run.operation;
		}
		if (run.operation?.status === "committed") run.files = await this.readFiles(ctx, run.signal);
		const live = liveRuns.get(run.request.planId);
		const settling = !!live && ["applying", "files_verified"].includes(run.operation?.status ?? "");
		if (live) {
			run.results = new Map(live.results);
			run.worktreePaths = new Set(live.worktreePaths);
			run.historyUnavailable = live.historyUnavailable;
		}
		return this.outcome(run, settling);
	}
	private async readFiles(ctx: RevertJournalContext, signal: AbortSignal) {
		const files: RevertJournalFile[] = [];
		let cursor: string | undefined;
		do {
			const page = this.journal.listFiles(ctx, { cursor, limit: 32 });
			files.push(...page.items);
			bound(files.length, FILE_CHANGE_LIMITS.revertFiles);
			cursor = page.nextCursor ?? undefined;
			if (cursor) await yieldToEventLoop();
			signal.throwIfAborted();
		} while (cursor);
		return files.sort((a, b) => a.sequence - b.sequence);
	}
	private async manifest(run: Run): Promise<ValidatedTransactionManifest> {
		const operation = run.operation as RevertJournalOperation;
		const raw: Extract<TransactionManifestRequest, { action: "validate" }>["raw"] = [];
		for (const digest of [
			operation.planBlobDigest,
			operation.selectorBlobDigest,
			operation.historyManifestBlobDigest,
		]) {
			const ref = this.blobRef(digest);
			raw.push({ ref, bytes: await this.readBlob(ref, run.signal) });
		}
		const manifest = await worker<ValidatedTransactionManifest>(
			{
				action: "validate",
				raw,
				operation,
				files: run.files,
				userId: run.request.principal.userId,
				...(run.request.acceptSnapshotRestore ? { acceptSnapshotRestore: true } : {}),
			},
			run.signal,
		);
		bound(
			manifest.evidenceBytes,
			this.options.maxEvidenceBytes ?? FILE_CHANGE_LIMITS.operationEvidenceBytes,
		);
		return manifest;
	}
	private blobRef(digest: string | null): FileChangeBlobRef {
		const row = this.db
			.select({ size: fileChangeBlobs.sizeBytes, status: fileChangeBlobs.status })
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, digest ?? ""))
			.get();
		if (!digest || row?.status !== "ready") throw fail("MANIFEST_UNAVAILABLE");
		return { algorithm: "sha256", digest, sizeBytes: row.size };
	}
	private readBlob(ref: Readonly<FileChangeBlobRef>, signal: AbortSignal) {
		return this.options.namespace.store.readBytes(ref, {
			signal,
			maxBytes: FILE_CHANGE_LIMITS.blobBytes,
		});
	}
	private outcome(run: Run, settling = false, reason?: string): RevertTransactionOutcome {
		let operation = run.operation;
		if (run.ctx)
			try {
				operation = this.journal.getOperation(run.ctx);
			} catch {
				run.historyUnavailable = true;
			}
		const files = run.files.map((file): FileChangeRevertFileResult => {
			const live = run.results.get(file.id);
			const status = live?.status ?? persistedStatus(file.status);
			return {
				filePath: file.identityJson.displayPath,
				deviceId: file.identityJson.deviceId,
				status,
				...((live?.reason ?? file.reason)
					? { reason: live?.reason ?? file.reason ?? undefined }
					: {}),
			};
		});
		const touched = files.some((file) => file.status === "applied" || file.status === "unknown");
		const status =
			operation?.status === "committed"
				? "committed"
				: settling
					? "executing"
					: operation?.status === "cancelled"
						? "cancelled"
						: operation?.status === "partial" || touched
							? "partial"
							: "failed";
		return {
			planId: run.request.planId,
			status,
			journalStatus: operation?.status ?? null,
			settling,
			reason: reason ?? operation?.reason ?? null,
			files,
			historyStatus:
				run.historyUnavailable ||
				run.files.some(
					(file) =>
						file.receiptJson &&
						"historyStatus" in file.receiptJson &&
						file.receiptJson.historyStatus === "unavailable",
				)
					? "unavailable"
					: "complete",
			historyCommitted: operation?.status === "committed" && operation.kind !== "revert",
			...(run.historyResult ? { historyResult: run.historyResult } : {}),
			worktreePaths: [...run.worktreePaths],
		};
	}
}
function fileResult(
	status: RevertFileResult["status"],
	reason: string | null = null,
): RevertFileResult {
	return { status, reason, historyStatus: "complete" };
}
function restoreResult(result: LocalFileRestoreResult): RevertFileResult {
	const status =
		result.status === "applied"
			? "applied"
			: result.status === "uncertain_after_dispatch"
				? "unknown"
				: result.reason === "no_change"
					? "unchanged"
					: ["target_changed", "expected_mismatch"].includes(result.reason)
						? "conflict"
						: "failed";
	// A conflicting current file has no published blob; retain the reason rather than inventing a ref.
	return {
		...fileResult(status, result.reason),
		...(status === "applied" || status === "unchanged"
			? { observedAfter: result.observation?.state }
			: {}),
	};
}
function persistedStatus(status: RevertJournalFile["status"]): RevertFileResult["status"] {
	if (["applied", "unchanged", "conflict", "failed", "unknown", "not_attempted"].includes(status))
		return status as RevertFileResult["status"];
	return status === "prepared" ? "not_attempted" : "unknown";
}
function errorCode(error: unknown): string {
	return String(
		error && typeof error === "object" && "code" in error
			? error.code
			: error instanceof Error
				? error.name
				: "RESTORE_FAILED",
	).slice(0, 256);
}
function fixedRequest(input: RevertTransactionRequest): Omit<RevertTransactionRequest, "signal"> {
	if (
		!input.principal ||
		typeof input.principal.userId !== "string" ||
		typeof input.principal.isAdmin !== "boolean" ||
		![input.narratorId, input.planId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		) ||
		!/^[a-f0-9]{64}$/.test(input.planHash)
	)
		throw fail("INVALID_INPUT");
	if (
		input.action !== undefined &&
		!["revert_files", "rollback_to_block", "delete_tool_block", "edit_and_regenerate"].includes(
			input.action,
		)
	)
		throw fail("ACTION_MISMATCH");
	if (input.acceptSnapshotRestore !== undefined && input.acceptSnapshotRestore !== true)
		throw fail("INVALID_INPUT");
	return Object.freeze({
		principal: Object.freeze({ ...input.principal }),
		narratorId: input.narratorId,
		planId: input.planId,
		planHash: input.planHash,
		...(input.action ? { action: input.action } : {}),
		...(input.expectedSelector ? { expectedSelector: fixedSelector(input.expectedSelector) } : {}),
		...(input.acceptSnapshotRestore ? { acceptSnapshotRestore: true as const } : {}),
	});
}
function fixedSelector(input: FileChangeRevertSelector): FileChangeRevertSelector {
	const id = (value: string) => {
		if (typeof value !== "string" || !value.length || value.length > 256)
			throw fail("INVALID_INPUT");
		return value;
	};
	const ids = (values: string[], max: number) => {
		if (!Array.isArray(values)) throw fail("INVALID_INPUT");
		bound(values.length, max, 1);
		const copy = values.map(id);
		Object.freeze(copy);
		return copy;
	};
	switch (input.kind) {
		case "all":
			return Object.freeze({ kind: "all" });
		case "from_seq":
			bound(input.minSeq, Number.MAX_SAFE_INTEGER);
			return Object.freeze({ kind: input.kind, minSeq: input.minSeq });
		case "messages":
			return Object.freeze({
				kind: input.kind,
				messageIds: ids(input.messageIds, FILE_CHANGE_LIMITS.historyMessageRefChanges),
			});
		case "tool_calls":
			return Object.freeze({
				kind: input.kind,
				toolCallIds: ids(input.toolCallIds, FILE_CHANGE_LIMITS.historyToolRelatedChanges),
			});
		case "after_block":
			bound(input.keepThroughBlockIndex, FILE_CHANGE_LIMITS.historyToolRelatedChanges, -1);
			return Object.freeze({
				kind: input.kind,
				messageId: id(input.messageId),
				keepThroughBlockIndex: input.keepThroughBlockIndex,
			});
		default:
			throw fail("INVALID_INPUT");
	}
}
function bound(value: number, max: number, min = 0) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw fail("BUDGET_EXCEEDED");
}
function fail(code: string) {
	return new RevertTransactionError(code);
}
