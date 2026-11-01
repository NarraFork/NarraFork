/** Narrator selections use durable previews and the shared per-file restore executor. */
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertAction,
	type FileChangeRevertSelector,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narrators, narratorToolCalls, users } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	invalidateWorkspaceTreeCache,
	resetActiveUpstreamSession,
	withNarratorWorkAdmission,
} from "./narrator-session-state";
import type { RevertPlanSummary } from "./revert-plan-service";
import {
	executeLocalRevertPlan,
	getLocalRevertPlan,
	listLocalRevertPlanFiles,
	prepareLocalRevertPlan,
	RevertPlannerLocalAccess,
} from "./revert-planner-local-access";
import { RevertPlannerError } from "./revert-planner-service";
import type { RevertTransactionOutcome } from "./revert-transaction-service";
import { emptyRevertResult, type RevertResult, unavailableSnapshotRevert } from "./snapshot-revert";

export type ScopedRevertSelector =
	| { minSeq: number }
	| { messageIds: string[] }
	| { toolUses: Array<{ messageId: string; toolUseId: string }> }
	| { afterBlock: { messageId: string; keepThroughBlockIndex: number } };

export type ScopedRevertUnavailableReason =
	| "no_boundaries"
	| "snapshot_missing"
	| "no_workspace"
	| "git_unsupported"
	| "window_too_large"
	| "legacy_unverified"
	| "execution_unavailable"
	| "runtime_reload_required"
	| "incomplete_coverage"
	| "file_conflict"
	| "history_changed"
	| "unsupported_target"
	| "platform_unsupported"
	| "pending_operations"
	| "nothing_owned";

export interface ConfirmedScopedRevertPlan {
	planId: string;
	planHash: string;
	action: FileChangeRevertAction;
	acceptSnapshotRestore?: true;
}

export interface ScopedRevertOptions {
	revertPlan?: ConfirmedScopedRevertPlan;
	/** Actual requester, forwarded by HTTP/session callers; never inferred from narrator ownership. */
	principal?: NarratorPrincipal;
	signal?: AbortSignal;
	withContents?: boolean;
}

/** Internal session callers carry a user id; re-read its role rather than borrowing an owner's ACL. */
export async function revertPrincipalForUser(userId: string | null | undefined) {
	if (!userId)
		throw new AppError(
			"An authenticated restore requester is required",
			401,
			"REVERT_AUTHENTICATION_REQUIRED",
		);
	const user = db
		.select({ id: users.id, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user || !["user", "admin"].includes(user.role))
		throw new AppError("Restore requester is unavailable", 401, "REVERT_AUTHENTICATION_REQUIRED");
	return { userId: user.id, isAdmin: user.role === "admin" };
}

function principalOf(options?: ScopedRevertOptions): NarratorPrincipal {
	if (!options?.principal)
		throw new AppError(
			"An authenticated restore requester is required",
			401,
			"REVERT_AUTHENTICATION_REQUIRED",
		);
	return options.principal;
}

export async function authorizeRevertHistory(narratorId: string, options: ScopedRevertOptions) {
	await new RevertPlannerLocalAccess().owner(
		principalOf(options),
		narratorId,
		options.signal ?? AbortSignal.timeout(60_000),
	);
}

async function select(
	narratorId: string,
	scope: ScopedRevertSelector,
): Promise<FileChangeRevertSelector> {
	if ("minSeq" in scope) return { kind: "from_seq", minSeq: scope.minSeq };
	if ("messageIds" in scope) return { kind: "messages", messageIds: scope.messageIds };
	if ("afterBlock" in scope) return { kind: "after_block", ...scope.afterBlock };
	if (scope.toolUses.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
		throw new RevertPlannerError("BUDGET_EXCEEDED", "Tool selection exceeds its bound");
	const wanted = new Set(
		scope.toolUses.map((item) => JSON.stringify([item.messageId, item.toolUseId])),
	);
	if (!wanted.size) return { kind: "tool_calls", toolCallIds: [] };
	const rows = await db
		.select({
			id: narratorToolCalls.id,
			messageId: narratorToolCalls.messageId,
			toolUseId: narratorToolCalls.toolUseId,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			inArray(narratorToolCalls.messageId, [
				...new Set(scope.toolUses.map((item) => item.messageId)),
			]),
		)
		.limit(FILE_CHANGE_LIMITS.historyToolRelatedChanges + 1);
	if (rows.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
		throw new RevertPlannerError("BUDGET_EXCEEDED", "Tool selection exceeds its bound");
	const matched = rows.filter((item) =>
		wanted.has(JSON.stringify([item.messageId, item.toolUseId])),
	);
	const found = new Set(matched.map((item) => JSON.stringify([item.messageId, item.toolUseId])));
	if (found.size !== wanted.size)
		throw new RevertPlannerError(
			"EVIDENCE_INCOMPLETE",
			"Selected tool history is unavailable; retain the original message selection",
		);
	return { kind: "tool_calls", toolCallIds: matched.map((item) => item.id) };
}

export async function planNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
	options?: ScopedRevertOptions,
	kind: "revert" | "rollback_to_block" = "revert",
) {
	const principal = principalOf(options);
	await new RevertPlannerLocalAccess().owner(
		principal,
		narratorId,
		options?.signal ?? AbortSignal.timeout(60_000),
	);
	const narrator = db
		.select({ messageVersion: narrators.messageVersion })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	return prepareLocalRevertPlan({
		principal,
		narratorId,
		expectedMessageVersion: narrator.messageVersion,
		idempotencyKey: generateId(),
		kind,
		revertScope: "narrator",
		selector: await select(narratorId, scope),
		signal: options?.signal,
	});
}

export interface ScopedRevertPreviewFile {
	deviceId: string;
	filePath: string;
	relPath: string;
	willBeDeleted: boolean;
	currentContent?: string | null;
	revertedContent?: string | null;
	reason?: string;
}
export interface ScopedRevertPreview {
	available: boolean;
	reason?: ScopedRevertUnavailableReason;
	files: ScopedRevertPreviewFile[];
	totalFileCount?: number;
	hasMore?: boolean;
	conflicts: string[];
	plan?: RevertPlanSummary;
	historySummary?: { deletedMessageCount: number; deletedBlockCount: number };
}

function unavailableReason(error: AppError): ScopedRevertUnavailableReason {
	if (/STALE/.test(error.code)) return "history_changed";
	if (/BUDGET|TOO_LARGE/.test(error.code)) return "window_too_large";
	if (/BLOB|CATALOG|NAMESPACE|MANIFEST/.test(error.code)) return "snapshot_missing";
	if (/UNSUPPORTED|TARGET|WORKSPACE/.test(error.code)) return "unsupported_target";
	return "incomplete_coverage";
}

function previewFailure(error: AppError): ScopedRevertPreview {
	const diagnostics = error instanceof RevertPlannerError ? error.diagnostics : [];
	return {
		available: false,
		reason: unavailableReason(error),
		files: diagnostics.flatMap((item) =>
			item.filePath
				? [
						{
							deviceId: "local",
							filePath: item.filePath,
							relPath: item.filePath,
							willBeDeleted: false,
							reason: item.reason ?? item.code,
						},
					]
				: [],
		),
		conflicts: diagnostics
			.filter((item) => item.reason?.includes("conflict"))
			.flatMap((item) => (item.filePath ? [item.filePath] : [])),
	};
}

export async function previewNarratorScopedRevert(
	narratorId: string,
	scope: ScopedRevertSelector,
	options?: ScopedRevertOptions,
): Promise<ScopedRevertPreview> {
	const principal = principalOf(options);
	const signal = options?.signal ?? AbortSignal.timeout(60_000);
	try {
		const { plan, historySummary } = await planNarratorScopedRevert(narratorId, scope, {
			...options,
			signal,
		});
		const page = await listLocalRevertPlanFiles(principal, narratorId, plan.id, {
			limit: 100,
			signal,
		});
		let bytesLeft = FILE_CHANGE_LIMITS.summaryBytes / 2;
		const text = async (state: FileChangeState): Promise<string | null> => {
			if (!options?.withContents || state.kind !== "regular" || state.blob.sizeBytes > bytesLeft)
				return null;
			bytesLeft -= state.blob.sizeBytes;
			try {
				const runtime = await getDefaultLocalFileChangeRuntime();
				const namespace = await runtime.verifyNamespace(signal);
				const bytes = await namespace.store.readBytes(state.blob, {
					signal,
					maxBytes: FILE_CHANGE_LIMITS.previewFileBytes,
				});
				const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				return value.includes("\0") ? null : value;
			} catch {
				signal.throwIfAborted();
				return null;
			}
		};
		const files: ScopedRevertPreviewFile[] = [];
		for (const item of page.items) {
			files.push({
				deviceId: item.identityJson.deviceId,
				filePath: item.identityJson.displayPath,
				relPath: item.identityJson.displayPath,
				willBeDeleted: item.desiredStateJson.kind === "absent",
				...(item.desiredStateJson.kind === "unknown"
					? { reason: item.desiredStateJson.reason }
					: {}),
				...(options?.withContents
					? {
							currentContent: await text(item.expectedStateJson),
							revertedContent: await text(item.desiredStateJson),
						}
					: {}),
			});
		}
		return {
			available: true,
			files,
			conflicts: [],
			totalFileCount: plan.expectedFileCount,
			hasMore: page.hasMore,
			plan,
			historySummary,
		};
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 409) throw error;
		return previewFailure(error);
	}
}

/** Return pending IO honestly; nested work admission follows its actual settlement. */
async function revertNarratorScoped(
	narratorId: string,
	scope: ScopedRevertSelector,
	options?: ScopedRevertOptions,
	kind: "revert" | "rollback_to_block" = "revert",
	action?: FileChangeRevertAction,
): Promise<RevertResult> {
	if (
		("messageIds" in scope && scope.messageIds.length === 0) ||
		("toolUses" in scope && scope.toolUses.length === 0)
	)
		return emptyRevertResult();
	const principal = principalOf(options);
	try {
		const confirmation = options?.revertPlan;
		const expectedAction =
			action ?? (kind === "rollback_to_block" ? "rollback_to_block" : "revert_files");
		if (confirmation && confirmation.action !== expectedAction)
			throw new RevertPlannerError(
				"ACTION_MISMATCH",
				"Confirmed action does not match this operation",
			);
		const { plan } = confirmation
			? await getLocalRevertPlan(
					principal,
					narratorId,
					confirmation.planId,
					options?.signal ?? AbortSignal.timeout(60_000),
				)
			: await planNarratorScopedRevert(narratorId, scope, options, kind);
		if (
			confirmation &&
			(plan.kind !== kind ||
				plan.planHash !== confirmation.planHash ||
				plan.status !== "prepared" ||
				plan.expired)
		)
			throw new RevertPlannerError(
				"ACTION_MISMATCH",
				"Confirmed plan changed or expired; load a fresh preview",
			);
		const expectedSelector = confirmation ? await select(narratorId, scope) : undefined;
		if (!plan.planHash)
			throw new RevertPlannerError("INCOMPLETE_PLAN", "Prepared restore has no confirmation hash");
		const planHash = plan.planHash;
		const execution = await withNarratorWorkAdmission(
			narratorId,
			() =>
				executeLocalRevertPlan({
					principal,
					narratorId,
					planId: plan.id,
					planHash,
					...(confirmation
						? {
								action: expectedAction,
								expectedSelector,
								acceptSnapshotRestore: confirmation.acceptSnapshotRestore,
							}
						: {}),
					signal: options?.signal,
				}),
			(run) => run.whenSettled,
		);
		const refresh = async (outcome: RevertTransactionOutcome) => {
			try {
				if (
					outcome.historyCommitted ||
					outcome.files.some((file) => file.status === "applied" || file.status === "unknown")
				) {
					for (const path of outcome.worktreePaths ?? []) invalidateWorkspaceTreeCache(path);
					const reset = new Set([
						narratorId,
						...(outcome.historyResult?.affectedNarratorIds ?? []),
					]);
					for (const id of reset) {
						if (outcome.historyCommitted)
							resetActiveUpstreamSession(id, { persistedIdentityCleared: true });
						broadcastToNarrator(id, { type: "full_reload", narratorId: id });
					}
					// Delivery senders only gain a message version; reload them without a reset.
					for (const id of new Set(outcome.historyResult?.refreshedNarratorIds ?? []))
						if (!reset.has(id)) broadcastToNarrator(id, { type: "full_reload", narratorId: id });
				}
				if (outcome.historyResult?.affectedQuestionIds?.length) {
					const { notifyQuestionHistoryChanged } = await import("./narrator-question-service");
					await notifyQuestionHistoryChanged(narratorId, outcome.historyResult.affectedQuestionIds);
				}
			} catch (error) {
				logger.warn("Restore refresh deferred", { narratorId, error: String(error) });
			}
		};
		const settled = execution.whenSettled.then(refresh).catch((error) => {
			logger.warn("Restore settlement deferred", { narratorId, error: String(error) });
		});
		const outcome = await execution.result;
		if (outcome.settling) await refresh(outcome);
		else await settled;
		const { historyResult: _historyResult, worktreePaths: _worktreePaths, ...result } = outcome;
		return { ...result, journalStatus: outcome.journalStatus ?? "failed" };
	} catch (error) {
		if (!(error instanceof AppError) || error.statusCode !== 409) throw error;
		logger.warn("Scoped restore unavailable", { narratorId, code: error.code });
		const preview = previewFailure(error);
		return unavailableSnapshotRevert(
			error.code,
			"(history)",
			preview.files.map((file) => ({
				deviceId: file.deviceId,
				filePath: file.filePath,
				status: "not_attempted",
				reason: file.reason ?? error.code,
			})),
		);
	}
}

export function revertNarratorScopedToBlock(
	narratorId: string,
	messageId: string,
	keepThroughBlockIndex: number,
	options?: ScopedRevertOptions,
) {
	return revertNarratorScoped(
		narratorId,
		{ afterBlock: { messageId, keepThroughBlockIndex } },
		options,
		"rollback_to_block",
	);
}

/** Editing must execute the exact preview, never silently create a replacement plan. */
export function revertNarratorScopedForEdit(
	narratorId: string,
	messageId: string,
	keepThroughBlockIndex: number,
	options: ScopedRevertOptions,
) {
	if (!options.revertPlan)
		throw new RevertPlannerError(
			"CONFIRMATION_REQUIRED",
			"Review a fresh edit preview before restoring files",
		);
	return revertNarratorScoped(
		narratorId,
		{ afterBlock: { messageId, keepThroughBlockIndex } },
		options,
		"rollback_to_block",
		"edit_and_regenerate",
	);
}

export function revertNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
	options?: ScopedRevertOptions,
) {
	return revertNarratorScoped(narratorId, { minSeq }, options);
}
export function revertNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
	options?: ScopedRevertOptions,
) {
	return revertNarratorScoped(narratorId, { messageIds }, options);
}
export function revertNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	options?: ScopedRevertOptions,
) {
	return revertNarratorScoped(narratorId, { toolUses }, options);
}
export function previewNarratorScopedForToolUses(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	options?: ScopedRevertOptions,
) {
	return previewNarratorScopedRevert(narratorId, { toolUses }, options);
}
export function previewNarratorScopedFromSeq(
	narratorId: string,
	minSeq: number,
	options?: ScopedRevertOptions,
) {
	return previewNarratorScopedRevert(narratorId, { minSeq }, options);
}
export function previewNarratorScopedForMessages(
	narratorId: string,
	messageIds: string[],
	options?: ScopedRevertOptions,
) {
	return previewNarratorScopedRevert(narratorId, { messageIds }, options);
}
