import type { Database } from "bun:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { readDomainTask } from "@server/db/worker-read";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { and, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
	fileChangeBlobs,
	revertOperationFiles as files,
	revertOperations as operations,
} from "../db/schema";
import { AppError } from "../lib/errors";
import type { RevertPlanManifestProof, RevertPlanOwner } from "./revert-plan-service";

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
	owner: RevertPlanOwner;
	planId: string;
	planHash: string;
}
export interface RevertJournalOptions {
	namespaceKey: string;
	now?: () => string;
}
export interface RevertJournalPage<T, C> {
	items: T[];
	hasMore: boolean;
	nextCursor: C | null;
}
export type RevertFileStatus =
	| "applied"
	| "unchanged"
	| "conflict"
	| "failed"
	| "unknown"
	| "not_attempted";
export interface RevertFileResult {
	status: RevertFileStatus;
	reason: string | null;
	historyStatus: "complete" | "unavailable";
	observedAfter?: FileChangeState;
}
export interface RevertJournalHistoryCommit {
	db: RevertJournalDatabase;
	apply(tx: RevertJournalTransaction): void;
}
export class RevertMutationJournalError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_JOURNAL_${code}`);
		this.name = "RevertMutationJournalError";
	}
}

/** Request deduplication and results only. File IO and history preparation stay outside SQL. */
export class RevertMutationJournal {
	private readonly now: () => string;
	constructor(
		private readonly db: RevertJournalDatabase,
		options: RevertJournalOptions,
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.assertRoot();
	}
	private assertRoot() {
		if (!this.db.$client || this.db.$client.inTransaction)
			throw fail("DURABILITY_BOUNDARY", "A root connection outside a transaction is required");
	}
	private transaction<T>(body: (tx: RevertJournalTransaction) => T): T {
		this.assertRoot();
		return this.db.transaction(body);
	}
	private update(
		tx: RevertJournalTransaction,
		operation: RevertJournalOperation,
		patch: Partial<RevertJournalOperation>,
	) {
		const updatedAt = timestamp(this.now(), operation.updatedAt);
		return tx
			.update(operations)
			.set({ ...patch, updatedAt })
			.where(eq(operations.id, operation.id))
			.returning()
			.get();
	}
	private async readSnapshot(
		ctx: RevertJournalContext,
		cursor: string | null = null,
		limit = 0,
		signal?: AbortSignal,
	) {
		this.assertRoot();
		const snapshot = await readDomainTask(
			this.db.$client,
			"revertPlanSnapshot",
			{ owner: ctx.owner, planId: ctx.planId, cursor, limit },
			{ executionPolicy: "worker-required", signal },
		);
		signal?.throwIfAborted();
		if (!snapshot.operation) throw fail("NOT_FOUND", "Plan not found in the authorized context");
		if (snapshot.operation.planHash !== ctx.planHash)
			throw fail("REQUEST_CONFLICT", "Confirmed plan changed");
		return { ...snapshot, operation: snapshot.operation };
	}
	async getOperation(
		ctx: RevertJournalContext,
		options: { signal?: AbortSignal } = {},
	): Promise<RevertJournalOperation> {
		return (await this.readSnapshot(ctx, null, 0, options.signal)).operation;
	}
	async listFiles(
		ctx: RevertJournalContext,
		options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
	): Promise<RevertJournalPage<RevertJournalFile, string>> {
		const limit = pageLimit(options.limit);
		const { files: rows } = await this.readSnapshot(
			ctx,
			options.cursor ?? null,
			limit + 1,
			options.signal,
		);
		const items = rows.slice(0, limit);
		return {
			items,
			hasMore: rows.length > limit,
			nextCursor: rows.length > limit ? items[items.length - 1].fileKey : null,
		};
	}
	async startExecution(
		ctx: RevertJournalContext,
		_proof?: RevertPlanManifestProof,
		options: { signal?: AbortSignal } = {},
	): Promise<{ operation: RevertJournalOperation; started: boolean }> {
		options.signal?.throwIfAborted();
		return this.transaction((tx) => {
			const operation = requireOperation(tx, ctx);
			if (operation.status !== "prepared") return { operation, started: false };
			assertNewPlan(operation);
			if (Date.parse(operation.expiresAt) <= Date.parse(this.now()))
				throw fail("EXPIRED", "Preview expired");
			return {
				operation: this.update(tx, operation, { status: "applying", reason: null }),
				started: true,
			};
		});
	}
	/** Persist the attempt before IO. An existing attempt grants no dispatch permission. */
	startFile(ctx: RevertJournalContext, fileId: string): boolean {
		return this.transaction((tx) => {
			const operation = requireOperation(tx, ctx);
			assertNewPlan(operation);
			if (operation.status !== "applying") return false;
			const file = requireFile(tx, operation.id, fileId);
			if (file.status !== "prepared") return false;
			tx.update(files)
				.set({
					status: "applying",
					receiptJson: { version: 3, status: "started" },
					updatedAt: this.now(),
				})
				.where(eq(files.id, fileId))
				.run();
			this.update(tx, operation, {});
			return true;
		});
	}
	recordResult(
		ctx: RevertJournalContext,
		fileId: string,
		result: RevertFileResult,
	): RevertJournalFile {
		validateResult(result);
		return this.transaction((tx) => {
			const operation = requireOperation(tx, ctx);
			assertNewPlan(operation);
			const file = requireFile(tx, operation.id, fileId);
			if (file.status !== "prepared" && file.status !== "applying") return file;
			if (operation.status !== "applying")
				throw fail("INVALID_TRANSITION", "Execution already finished");
			const after = result.observedAfter;
			// No-op observations may refer to unarchived live bytes; JSON keeps the fingerprint.
			const ref = result.status === "applied" && after?.kind === "regular" ? after.blob : null;
			const before =
				result.status === "applied" && file.beforeBlobDigest
					? tx
							.select({
								digest: fileChangeBlobs.digest,
								sizeBytes: fileChangeBlobs.sizeBytes,
								status: fileChangeBlobs.status,
							})
							.from(fileChangeBlobs)
							.where(eq(fileChangeBlobs.digest, file.beforeBlobDigest))
							.get()
					: null;
			const updated = tx
				.update(files)
				.set({
					status: result.status,
					reason: result.reason,
					receiptJson: {
						version: 3,
						status: result.status,
						historyStatus: resultHistoryStatus(file, result, before),
						reason: result.reason,
					},
					observedAfterStateJson: after ?? null,
					observedAfterBlobDigest: ref?.digest ?? null,
					updatedAt: this.now(),
				})
				.where(eq(files.id, fileId))
				.returning()
				.get();
			this.update(tx, operation, {
				appliedFileCount: operation.appliedFileCount + (result.status === "applied" ? 1 : 0),
			});
			return updated;
		});
	}
	/** One bounded paginated pass, followed by a revision check in a short transaction. */
	async finishFiles(
		ctx: RevertJournalContext,
		options: { cancelled?: boolean; reason?: string | null } = {},
	): Promise<RevertJournalOperation> {
		const original = await this.getOperation(ctx);
		if (original.status !== "applying") return original;
		let cursor: string | undefined;
		let count = 0;
		let successful = 0;
		let touched = false;
		do {
			const page = await this.listFiles(ctx, { cursor, limit: REVERT_JOURNAL_BATCH_ITEMS });
			for (const file of page.items) {
				count++;
				if (file.status === "applied" || file.status === "unchanged") successful++;
				if (["applied", "unknown", "applying"].includes(file.status)) touched = true;
			}
			if (count > FILE_CHANGE_LIMITS.revertFiles) throw fail("BUDGET_EXCEEDED", "Too many files");
			cursor = page.nextCursor ?? undefined;
			if (cursor) await yieldToEventLoop();
		} while (cursor);
		return this.transaction((tx) => {
			const live = requireOperation(tx, ctx);
			if (live.updatedAt !== original.updatedAt) throw fail("STALE", "File results changed");
			if (count !== live.fileCount) throw fail("INCOMPLETE_FILES", "Fixed file set changed");
			const status = !live.coverageComplete
				? "partial"
				: successful === count
					? "files_verified"
					: touched || successful > 0
						? "partial"
						: options.cancelled
							? "cancelled"
							: "failed";
			return this.update(tx, live, {
				status,
				reason: options.reason ?? (live.coverageComplete ? null : "SELECTED_HISTORY_UNAVAILABLE"),
			});
		});
	}
	failHistory(ctx: RevertJournalContext, reason: string): RevertJournalOperation {
		return this.transaction((tx) => {
			const operation = requireOperation(tx, ctx);
			if (
				operation.status !== "applying" &&
				(operation.status !== "files_verified" || !operation.coverageComplete)
			)
				return operation;
			return this.update(tx, operation, {
				status: operation.fileCount ? "partial" : "failed",
				reason: reason.slice(0, 256),
			});
		});
	}
	commit(ctx: RevertJournalContext, history: RevertJournalHistoryCommit): RevertJournalOperation {
		if (history.db !== this.db)
			throw fail("DURABILITY_BOUNDARY", "History must use the same database");
		return this.transaction((tx) => {
			const operation = requireOperation(tx, ctx);
			if (operation.status === "committed") return operation;
			assertNewPlan(operation);
			if (operation.status !== "files_verified" || !operation.coverageComplete)
				throw fail("FILES_UNVERIFIED", "Every required file must succeed");
			const value: unknown = history.apply(tx);
			if (value && typeof (value as Promise<unknown>).then === "function")
				throw fail("ASYNC_HISTORY", "History transaction must be synchronous");
			return this.update(tx, operation, { status: "committed", reason: null });
		});
	}
}

function requireOperation(
	tx: RevertJournalTransaction,
	ctx: RevertJournalContext,
): RevertJournalOperation {
	const row = tx
		.select()
		.from(operations)
		.where(
			and(
				eq(operations.id, ctx.planId),
				eq(operations.requestedBySubjectKey, ctx.owner.subjectKey),
				sql`${operations.narratorId} IS ${ctx.owner.narratorId}`,
				sql`${operations.projectId} IS ${ctx.owner.projectId}`,
			),
		)
		.get();
	if (!row) throw fail("NOT_FOUND", "Plan not found in the authorized context");
	if (row.planHash !== ctx.planHash) throw fail("REQUEST_CONFLICT", "Confirmed plan changed");
	return row;
}
function requireFile(
	tx: RevertJournalTransaction,
	operationId: string,
	fileId: string,
): RevertJournalFile {
	const row = tx
		.select()
		.from(files)
		.where(and(eq(files.id, fileId), eq(files.revertOperationId, operationId)))
		.get();
	if (!row) throw fail("NOT_FOUND", "File is outside the fixed plan");
	return row;
}
export function assertNewPlan(operation: RevertJournalOperation): void {
	if (operation.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION || !operation.planHash)
		throw fail("LEGACY_READ_ONLY", "Create a fresh preview to restore files");
}
/** Disk success does not imply that a new reversible before snapshot was archived. */
export function resultHistoryStatus(
	file: RevertJournalFile,
	result: RevertFileResult,
	availableBefore?: { digest: string; sizeBytes: number; status: string } | null,
): RevertFileResult["historyStatus"] {
	if (result.historyStatus === "unavailable" || result.status !== "applied")
		return result.historyStatus;
	const expected = file.expectedStateJson;
	const before =
		expected.kind === "regular"
			? expected.blob
			: expected.kind === "symlink"
				? expected.target
				: null;
	if (
		expected.kind === "unknown" ||
		(before &&
			(file.beforeBlobDigest !== before.digest ||
				availableBefore?.digest !== before.digest ||
				availableBefore.sizeBytes !== before.sizeBytes ||
				availableBefore.status !== "ready"))
	)
		return "unavailable";
	return result.observedAfter && result.observedAfter.kind !== "unknown"
		? "complete"
		: "unavailable";
}
export function validateResult(result: RevertFileResult): void {
	if (
		!["applied", "unchanged", "conflict", "failed", "unknown", "not_attempted"].includes(
			result.status,
		) ||
		!["complete", "unavailable"].includes(result.historyStatus) ||
		(result.reason !== null && (typeof result.reason !== "string" || result.reason.length > 256))
	)
		throw fail("INVALID_INPUT", "Invalid file result");
}
export function timestamp(now: string, previous: string): string {
	if (!Number.isFinite(Date.parse(now))) throw fail("INVALID_INPUT", "Invalid clock");
	return new Date(Math.max(Date.parse(now), Date.parse(previous) + 1)).toISOString();
}
export function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > FILE_CHANGE_LIMITS.historyPageItems)
		throw fail("INVALID_INPUT", "Invalid page size");
	return value;
}
function fail(code: string, message: string): RevertMutationJournalError {
	return new RevertMutationJournalError(code, message);
}
