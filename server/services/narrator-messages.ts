import { parseCompactMessageBlock } from "@shared/compact-message";
import { type FileReferenceDisplay, fileReferenceDisplay } from "@shared/file-reference";
import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import { projectToolIO, TOOL_IO_BUDGETS } from "@shared/pretext-layout/tool-io-projection";
import {
	isDanglingReasoningOnlyAssistantMessage,
	isMetadataOnlyEmptyReasoningAssistantMessage,
} from "@shared/reasoning-content";
import {
	normalizeSubagentToolInputSummary,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import * as modelHistoryDatabase from "../db";
import { db } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { readQuery, readTransactionTask } from "../db/worker-read";
import {
	measureMessageCharacters,
	measureSummaryCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { DISPLAY_PAGE_LIMITS } from "../lib/db-worker/display-page-protocol";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	isTopLevelMessage,
	type OwnTurnPlacement,
	ownTurnPlacementOf,
	ownTurnSql,
	RUNTIME_SOURCE_COLUMNS,
} from "../lib/runtime-source";
import { resolveDefaultReasoningEffort, resolveProvider } from "../lib/settings";
import { sqlExecutionDiagnostics, withSqlDiagnosticSite } from "../lib/sql-execution-diagnostics";
import { toolCallWithExecutionTargets } from "../lib/tool-execution-target-projection";
import { MAX_BATCH_DELETE_BLOCKS } from "../lib/validators/narrators";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	type LoadModelHistoryOptions,
	loadModelHistorySource,
} from "./agent-runtime/model-history-source";
import { isRunHeldForDisplay, listRunHolds } from "./agent-runtime/ownership";
import {
	AWAIT_AGENT_RESOLVED_FIELD,
	type AwaitAgentResolution,
	attachAwaitAgentNarratorIds,
	attachTakenOverFlags,
	resolveAwaitAgentIdsForToolCalls,
	TAKEN_OVER_FIELD,
} from "./await-agent-resolution";
import { liveCompactProgress } from "./compact-live-state";
import {
	createPostgresNarratorDisplayPagePort,
	readDisplayFixtureMessages,
	readNarratorDisplayMessages,
} from "./narrator-display-page-reader";
import { deleteRecipientMessageRefs, updateRecipientMessageRef } from "./narrator-persistence";
import { reconcileQuestionHistoryInTransaction } from "./narrator-question-history";
import {
	AGGREGATE_BODY_BYTE_LIMIT,
	AGGREGATE_METADATA_LIMIT,
	assertAggregateBudget,
	BLOCK_DELETE_ROW_LIMIT,
	type BlockDeleteOptions,
	type BlockDeletionPlan,
	type DeletableBlock,
	type FileHistoryCheckpointGroup,
	getCompactSummaryTx,
	getToolCallDetailTx,
	getToolCallPreviewTx,
	loadAggregateRefMessagesTx,
	loadLatestSubagentToolCallsTx,
	planBlockDeletions,
	planMessageRangeDeletion,
	resolveAggregateScopeTxImpl,
	SUBAGENT_TOOL_NAMES,
	type SubagentActivityOwner,
	type ToolDetailReference,
} from "./narrator-read-transactions";
import {
	ensureRefsCoverMessage,
	ensureRefsCoverSeq,
	hasUnmaterializedRefsBelow,
} from "./narrator-refs-backfill";
import {
	revertNarratorScopedForMessages,
	revertNarratorScopedForToolUses,
} from "./narrator-scoped-revert";
import { withNarratorWorkAdmission } from "./narrator-session-state";
import {
	attachActiveSendDeliveryTargets,
	attachSendTargetDetails,
} from "./send-delivery-resolution";
import {
	commitSnapshotRevert,
	DEFAULT_REVERT_SCOPE,
	type RevertResult,
	type RevertScope,
	type RevertWarning,
	revertForMessagesTree,
	unavailableSnapshotRevert,
} from "./snapshot-revert";
// Pure in-memory state module (no imports of its own), so importing it here
// cannot widen this file's already-delicate import cycle with narrator-service.
import {
	getCurrentSubagentFileChangeOptions,
	getFileChangesBySubagent,
	type SubagentFileChangeReadTiming,
	type SubagentFileChanges,
} from "./subagent-file-changes";
import { getRecentSubagentModelInheritance } from "./subagent-model";

// ── Internal helpers ───────────────────────────────────────────────────────

async function notifyQuestionHistoryAfterCommit(
	narratorId: string,
	questionIds: string[],
): Promise<void> {
	if (!questionIds.length) return;
	try {
		const { notifyQuestionHistoryChanged } = await import("./narrator-question-service");
		await notifyQuestionHistoryChanged(narratorId, questionIds);
	} catch (error) {
		logger.warn("Committed question history notification deferred", {
			narratorId,
			error: String(error),
		});
		broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
	}
}

/** A scope is a choice, never permission to fall back to a broader writer. */
async function revertForDeletedMessages(
	narratorId: string,
	messageIds: string[],
	scope: RevertScope | undefined,
): Promise<RevertResult> {
	const selectedScope = scope ?? DEFAULT_REVERT_SCOPE;
	const result =
		selectedScope === "workspace"
			? await revertForMessagesTree(narratorId, messageIds)
			: await revertNarratorScopedForMessages(narratorId, messageIds);
	return (
		result ??
		unavailableSnapshotRevert(
			`No verified ${selectedScope} rollback is available for these messages; history was retained.`,
		)
	);
}

async function revertForDeletedBlock(
	narratorId: string,
	removedBlock: { type: string; id?: string },
	messageId: string,
	opts?: { skipRevert?: boolean; scope?: RevertScope },
): Promise<RevertResult | null> {
	if (opts?.skipRevert || removedBlock.type !== "tool_use") return null;
	if (!removedBlock.id) {
		return unavailableSnapshotRevert("The selected tool block has no stable tool-use identity.");
	}
	return revertForDeletedBlocks(
		narratorId,
		[{ messageId, toolUseId: removedBlock.id }],
		opts?.scope,
	);
}

async function revertForDeletedBlocks(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	scope: RevertScope | undefined,
): Promise<RevertResult> {
	// A message-wide workspace restore cannot express an arbitrary block selection.
	// Replay is not a safe substitute, even when workspace scope was requested.
	if ((scope ?? DEFAULT_REVERT_SCOPE) === "workspace") {
		return unavailableSnapshotRevert(
			"Workspace rollback is unavailable for block selections; no files or history were changed.",
		);
	}
	return (
		(await revertNarratorScopedForToolUses(narratorId, toolUses)) ??
		unavailableSnapshotRevert(
			"No verified narrator rollback is available for these tool blocks; history was retained.",
		)
	);
}

type MessageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type BlockSelection = { messageId: string; blockIndex: number };

// M0 admission limits: apply to internal callers and skipRevert too, not only HTTP.
// Larger rewrites need the worker-backed history planner, not a larger main-thread tx.

/** Metadata first: never load a tool's potentially large input/output just to find its children. */

/**
 * Cleanup is not a second history selector. Only a real subagent origin may add
 * unreferenced messages; not even that origin permits deleting another ref.
 * A provider ID, same-narrator inline row, ordinary fork or timestamp proves no ancestry.
 */

/** Fix indices, COW data and cleanup sets before any rollback touches the files. */

function applyBlockDeletionTx(
	tx: MessageTx,
	narratorId: string,
	plan: BlockDeletionPlan,
	opts?: BlockDeleteOptions,
): string | null {
	const { message, ref, remaining, removed, isShared } = plan;
	if (plan.checkpointToolCalls.length > 0) {
		insertFileHistoryCheckpoints(tx, narratorId, [
			{ messageId: message.id, seq: ref.seq, toolCalls: plan.checkpointToolCalls },
		]);
	}
	const removedToolIds = removed
		.filter(
			(block): block is DeletableBlock & { id: string } => block.type === "tool_use" && !!block.id,
		)
		.map((block) => block.id);
	if (remaining.length === 0) {
		deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.id, ref.id)).run();
		if (!isShared) deleteOrphanedMessages(tx, [message.id]);
		return null;
	}
	const contentText = modelTextFromContentBlocks(remaining);
	const patch = {
		contentJson: remaining,
		contentText: contentText || null,
		contextCharsJson: measureMessageCharacters(message.role, remaining, contentText),
		// A file rollback invalidates the old message-level boundary; text-only and
		// history-only edits do not change the captured filesystem observation.
		...(!opts?.skipRevert && removedToolIds.length > 0
			? { treeHashAfter: null, snapshotCommitSha: null }
			: {}),
	};
	if (isShared) {
		const newId = generateId();
		tx.insert(narratorMessages)
			.values({ ...message, ...patch, id: newId })
			.run();
		tx.update(narratorMessageRefs)
			.set({ messageId: newId })
			.where(eq(narratorMessageRefs.id, ref.id))
			.run();
		updateRecipientMessageRef(tx, narratorId, ref.id, {
			kind: "semantic_edit",
			messageId: newId,
		});
		const retainedIds = new Set(
			remaining.filter((block) => block.type === "tool_use").map((block) => block.id),
		);
		const retainedCalls = plan.toolCalls.filter((call) => retainedIds.has(call.toolUseId));
		if (retainedCalls.length > 0) {
			tx.insert(narratorToolCalls)
				.values(
					retainedCalls.map((call) => ({
						...call,
						id: generateId(),
						messageId: newId,
						executionOriginToolCallId: call.executionOriginToolCallId ?? call.id,
					})),
				)
				.run();
		}
		// The fork boundary follows this narrator's COW ref, not the shared original.
		tx.update(narrators)
			.set({ forkMessageId: newId })
			.where(and(eq(narrators.id, narratorId), eq(narrators.forkMessageId, message.id)))
			.run();
		return newId;
	} else {
		tx.update(narratorMessages).set(patch).where(eq(narratorMessages.id, message.id)).run();
		updateRecipientMessageRef(tx, narratorId, ref.id, {
			kind: "semantic_edit",
			messageId: message.id,
		});
		if (removedToolIds.length > 0) {
			tx.delete(narratorToolCalls)
				.where(
					and(
						eq(narratorToolCalls.messageId, message.id),
						inArray(narratorToolCalls.toolUseId, removedToolIds),
					),
				)
				.run();
		}
		return message.id;
	}
}

/** One bounded history transaction, so SQL failure compensates the entire rollback. */
async function deleteBlockSelection(
	narratorId: string,
	blocks: BlockSelection[],
	opts?: BlockDeleteOptions,
) {
	if (blocks.length > MAX_BATCH_DELETE_BLOCKS) {
		throw new ValidationError(`Select at most ${MAX_BATCH_DELETE_BLOCKS} blocks`);
	}
	const grouped = new Map<string, number[]>();
	for (const { messageId, blockIndex } of blocks) {
		const indices = grouped.get(messageId) ?? [];
		if (!indices.includes(blockIndex)) indices.push(blockIndex);
		grouped.set(messageId, indices);
	}
	for (const indices of grouped.values()) indices.sort((a, b) => b - a);
	if (grouped.size === 0) return { deleted: 0, failed: 0, results: [] };
	const planned = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "blockDeletionPlan",
			narratorId,
			grouped: [...grouped],
			options: opts,
		},
		() => db.transaction((tx) => planBlockDeletions(tx, narratorId, grouped, opts)),
		{ site: "narrator-messages.blockDeletionPlan" },
	);
	const version = JSON.stringify(planned);
	const toolUses = planned.plans.flatMap(({ message, removed }) =>
		removed
			.filter((block) => block.type === "tool_use")
			.map((block) => ({ messageId: message.id, toolUseId: block.id })),
	);
	let snapshotRevert: RevertResult | null = null;
	if (!opts?.skipRevert && toolUses.length > 0) {
		if (toolUses.some((target) => !target.toolUseId)) {
			snapshotRevert = unavailableSnapshotRevert(
				"A selected tool block has no stable tool-use identity.",
			);
		} else if (toolUses.length === 1) {
			const target = toolUses[0];
			snapshotRevert = await revertForDeletedBlock(
				narratorId,
				{ type: "tool_use", id: target.toolUseId },
				target.messageId,
				opts,
			);
		} else {
			snapshotRevert = await revertForDeletedBlocks(
				narratorId,
				toolUses as Array<{ messageId: string; toolUseId: string }>,
				opts?.scope,
			);
		}
	}
	const updatedMessageIds: Array<{ id: string; oldId?: string; seq: number }> = [];
	const removedRefMessageIds = planned.plans
		.filter((plan) => plan.remaining.length === 0)
		.map((plan) => plan.message.id);
	let affectedQuestionIds: string[] = [];
	const mutate = () =>
		db.transaction((tx) => {
			// Recheck refs, content, tool evidence and narrator version after async rollback.
			// A drift rejects the whole transaction rather than following a moved index.
			if (JSON.stringify(planBlockDeletions(tx, narratorId, grouped, opts)) !== version) {
				throw new AppError(
					"Message history changed during block deletion; retry the selection.",
					409,
					"HISTORY_DELETE_STALE",
				);
			}
			affectedQuestionIds = reconcileQuestionHistoryInTransaction(tx, narratorId, {
				deletedMessageIds: [...removedRefMessageIds, ...planned.derived.messageIds],
				deletedToolBlocks: toolUses.filter(
					(block): block is { messageId: string; toolUseId: string } =>
						typeof block.toolUseId === "string",
				),
			}).affectedQuestionIds;
			insertFileHistoryCheckpoints(tx, narratorId, planned.derived.checkpoints);
			deleteOrphanedMessages(tx, planned.derived.messageIds);
			for (const plan of planned.plans) {
				const updatedId = applyBlockDeletionTx(tx, narratorId, plan, opts);
				if (updatedId)
					updatedMessageIds.push({
						id: updatedId,
						...(updatedId !== plan.message.id ? { oldId: plan.message.id } : {}),
						seq: plan.ref.seq,
					});
			}
			if (!opts?.skipNarratorUpdate) {
				tx.update(narrators)
					.set({
						...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
						messageVersion: sql`${narrators.messageVersion} + 1`,
						contextUsageSnapshotJson: null,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId))
					.run();
			}
		});
	if (snapshotRevert) await commitSnapshotRevert(snapshotRevert, mutate);
	else mutate();
	await notifyQuestionHistoryAfterCommit(narratorId, affectedQuestionIds);

	// Persisted block edits must reach already-open narrators. Broadcast the exact
	// post-COW message row; a refresh remains the source of truth, while this keeps
	// the live view from retaining the pre-delete projection.
	try {
		const uniqueUpdated = [...new Map(updatedMessageIds.map((item) => [item.id, item])).values()];
		for (const item of uniqueUpdated) {
			const message = await readQuery(
				db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, item.id),
					with: { toolCalls: true },
				}),
				{ site: "narrator-messages.deleteBlockSelection" },
			);
			if (!message) throw new Error("updated message disappeared after commit");
			broadcastToNarrator(narratorId, {
				type: "message_updated",
				narratorId,
				message: { ...message, seq: item.seq },
				...(item.oldId ? { oldMessageId: item.oldId, replacedMessageId: item.oldId } : {}),
			});
		}
	} catch (error) {
		logger.warn("history deletion broadcast projection failed; requesting bounded reload", {
			narratorId,
			error,
		});
		broadcastToNarrator(narratorId, { type: "full_reload", narratorId });
	}
	const deletedMessageIds = [...new Set([...planned.derived.messageIds, ...removedRefMessageIds])];
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}
	// Card removal retires its subagent(s): interrupt running work and archive so
	// TeamStatus broadcast (@all members) no longer wakes them. Best-effort after
	// the history mutation — a lifecycle failure must not undo a committed delete.
	if (planned.derived.subagentNarratorIds.length > 0) {
		const { archiveRetiredSubagents } = await import("./subagent-lifecycle");
		await archiveRetiredSubagents(planned.derived.subagentNarratorIds);
	}
	const results = planned.plans.flatMap(({ message, indices, remaining }) =>
		indices.map((blockIndex) => ({
			messageId: message.id,
			blockIndex,
			messageDeleted: remaining.length === 0,
		})),
	);
	return {
		deleted: results.length,
		failed: 0,
		results,
		...(snapshotRevert?.warnings?.length ? { revertWarnings: snapshotRevert.warnings } : {}),
		...(planned.derived.warnings.length ? { historyWarnings: planned.derived.warnings } : {}),
		...(planned.derived.subagentNarratorIds.length
			? { archivedSubagentIds: planned.derived.subagentNarratorIds }
			: {}),
	};
}

function copySharedCompactMessageTx(
	tx: MessageTx,
	narratorId: string,
	message: typeof narratorMessages.$inferSelect,
	ref: typeof narratorMessageRefs.$inferSelect,
): { messageId: string; copied: boolean } {
	const refs = tx
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.messageId, message.id))
		.all();
	if (refs.length <= 1) return { messageId: message.id, copied: false };

	const newMessageId = generateId();
	tx.insert(narratorMessages)
		.values({
			...message,
			id: newMessageId,
			narratorId,
			createdAt: message.createdAt,
		})
		.run();
	tx.update(narratorMessageRefs)
		.set({ messageId: newMessageId })
		.where(eq(narratorMessageRefs.id, ref.id))
		.run();
	const narrator = tx.query.narrators
		.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { forkMessageId: true },
		})
		.sync();
	const narratorUpdates: Partial<typeof narrators.$inferInsert> = {};
	if (narrator?.forkMessageId === message.id) narratorUpdates.forkMessageId = newMessageId;
	if (Object.keys(narratorUpdates).length > 0) {
		tx.update(narrators).set(narratorUpdates).where(eq(narrators.id, narratorId)).run();
	}
	return { messageId: newMessageId, copied: true };
}

function assertNoRunningCompactRefsTx(tx: MessageTx, narratorId: string, refIds: string[]): void {
	if (refIds.length === 0) return;
	const rows = tx
		.select({ contentJson: narratorMessages.contentJson })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), inArray(narratorMessageRefs.id, refIds)),
		)
		.all();
	for (const row of rows) {
		const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
		const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
		if (compactBlock?.status === "compacting") {
			throw new AppError(
				"A running compact must be cancelled before its message can be deleted",
				409,
				"COMPACT_IN_PROGRESS",
			);
		}
	}
}

// Classification and single-ref removal share a transaction: never exempt a range.
function deleteOutputlessAssistantMessage(
	narratorId: string,
	messageId: string,
	kind: "reasoning-only" | "empty-placeholder",
): boolean {
	return db.transaction((tx) => {
		const ref = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			})
			.sync();
		if (!ref) return false;
		const msg = tx.query.narratorMessages
			.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: {
					role: true,
					contentJson: true,
					contentText: true,
					parentToolUseId: true,
					treeHashAfter: true,
					snapshotCommitSha: true,
				},
				with: { toolCalls: { columns: { id: true }, limit: 1 } },
			})
			.sync();
		if (!msg) return false;
		const valid =
			kind === "reasoning-only"
				? isDanglingReasoningOnlyAssistantMessage(msg)
				: msg.role === "assistant" &&
					Array.isArray(msg.contentJson) &&
					msg.contentJson.length === 0 &&
					!msg.contentText?.trim() &&
					msg.toolCalls.length === 0 &&
					!msg.parentToolUseId &&
					!msg.treeHashAfter &&
					!msg.snapshotCommitSha &&
					!ref.isCompact &&
					!ref.segmentCompactId;
		if (!valid) throw new ValidationError(`Message is not a ${kind} assistant record`);
		if (kind === "empty-placeholder") {
			const patch = tx.query.narratorPatches
				.findFirst({
					where: eq(narratorPatches.messageId, messageId),
					columns: { id: true },
				})
				.sync();
			const boundary = tx.query.narrators
				.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { forkMessageId: true },
				})
				.sync();
			// Other narrators' shared refs retain the original record below.
			if (patch || boundary?.forkMessageId === messageId)
				throw new ValidationError("Retry placeholder has file or history boundaries");
		}
		assertNoRunningCompactRefsTx(tx, narratorId, [ref.id]);
		deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.id, ref.id)).run();
		const otherRef = tx.query.narratorMessageRefs
			.findFirst({
				where: eq(narratorMessageRefs.messageId, messageId),
				columns: { id: true },
			})
			.sync();
		if (!otherRef) tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
		tx.update(narrators)
			.set({
				apiConversationId: null,
				messageVersion: sql`${narrators.messageVersion} + 1`,
				contextUsageSnapshotJson: null,
				messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId))
			.run();
		return true;
	});
}

export function isCompactLifecycleMessage(message: { contentJson: unknown }): boolean {
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	return blocks.some((block) => parseCompactMessageBlock(block) !== null);
}

export const CONTEXT_ASK_HISTORY_MESSAGE_LIMIT = 400;
const CONTEXT_ASK_MESSAGE_TEXT_LIMIT = 6_000;
const CONTEXT_ASK_TOOL_INPUT_LIMIT = 1_200;
const CONTEXT_ASK_TOOL_OUTPUT_LIMIT = 2_400;
const CONTEXT_ASK_TOOL_CALL_LIMIT = 1_000;
const CONTEXT_ASK_TOOL_CALLS_PER_MESSAGE_LIMIT = 20;
const CONTEXT_ASK_SOURCE_BYTE_LIMIT = 1_000_000;
const contextAskTextEncoder = new TextEncoder();

export interface ContextAskToolCallSnapshot {
	toolUseId: string;
	toolName: string;
	status: string;
	inputText: string | null;
	outputText: string | null;
	inputTruncated: boolean;
	outputTruncated: boolean;
}

export interface ContextAskMessageSnapshot {
	id: string;
	seq: number;
	role: string;
	contentText: string | null;
	contentTruncated: boolean;
	toolCalls: ContextAskToolCallSnapshot[];
	omittedToolCalls: number;
}

export interface ContextAskHistorySnapshot {
	messages: ContextAskMessageSnapshot[];
	hasMore: boolean;
	sourceTruncated: boolean;
	toolCallsTruncated: boolean;
	sourceBytes: number;
}

function contextAskUtf8Length(value: unknown): number {
	return contextAskTextEncoder.encode(JSON.stringify(value)).byteLength;
}

function getReflectionStatus(suggestions: unknown): string | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as { type?: unknown; status?: unknown };
		const type = String(record.type ?? "");
		if (
			type === "danger_reflection" ||
			type === "plan_reflection" ||
			type === "task_reflection" ||
			type === "question_reflection"
		) {
			return typeof record.status === "string" ? record.status : "running";
		}
	}
	return null;
}

function shouldHidePendingPermission(suggestions: unknown): boolean {
	const status = getReflectionStatus(suggestions);
	return status !== null && status !== "awaiting_user";
}

/**
 * Delete genuinely unreferenced messages and their tool calls in the caller's
 * transaction. A retained ref aborts the whole mutation; it is never erased here.
 * Callers preflight the bounded rows and FK associations before removing refs.
 */
function deleteOrphanedMessages(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	orphanIds: string[],
): void {
	if (orphanIds.length === 0) return;
	if (orphanIds.length > BLOCK_DELETE_ROW_LIMIT) {
		throw new AppError(
			"Orphan cleanup exceeds the history safety budget",
			409,
			"HISTORY_DELETE_TOO_LARGE",
		);
	}
	// Never manufacture an orphan by dropping refs owned by a different history.
	// Callers must remove only their explicit refs before reaching this helper.
	const retainedRef = tx
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.where(inArray(narratorMessageRefs.messageId, orphanIds))
		.limit(1)
		.get();
	if (retainedRef) {
		throw new AppError(
			"Referenced messages cannot be deleted as orphaned history",
			409,
			"HISTORY_DELETE_REFERENCED",
		);
	}

	tx.update(narrators)
		.set({ forkMessageId: null })
		.where(inArray(narrators.forkMessageId, orphanIds))
		.run();

	tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds)).run();
	tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds)).run();
}

/**
 * Which tool calls are worth preserving as a checkpoint.
 *
 * Write/Edit qualify because replay can reconstruct them from their recorded
 * input. Any call carrying a tree boundary that moved the workspace also
 * qualifies, regardless of tool: that boundary is what a later rollback needs, and
 * for Bash (or anything else whose input does not describe its writes) it is the
 * *only* record of the change. Dropping those rows on a `skipRevert` deletion
 * would discard the change's only description while the files stay on disk.
 */

/** Plan a bounded caller-owned ref range, checkpoints and proven orphan cleanup. */

async function deleteMessageRange(
	narratorId: string,
	messageId: string,
	inclusive: boolean,
	opts?: BlockDeleteOptions,
) {
	const timingId = generateId();
	const startedAt = new Date().toISOString();
	const context = { timingId, narratorId, messageId, inclusive, skipRevert: !!opts?.skipRevert };
	logger.info("Message history truncation started", { ...context, startedAt });
	const started = performance.now();
	const phaseDurationsMs: Record<string, number> = {};
	let success = false;
	let selectedMessageCount = 0;
	const recordPhase = (phase: string, phaseStarted: number) => {
		phaseDurationsMs[phase] = (phaseDurationsMs[phase] ?? 0) + performance.now() - phaseStarted;
	};
	const measureSync = <T>(phase: string, fn: () => T): T => {
		const phaseStarted = performance.now();
		try {
			return fn();
		} finally {
			recordPhase(phase, phaseStarted);
		}
	};
	const measureAsync = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
		const phaseStarted = performance.now();
		try {
			return await fn();
		} finally {
			recordPhase(phase, phaseStarted);
		}
	};
	try {
		let affectedQuestionIds: string[] = [];
		const apply = (tx: MessageTx, planned: ReturnType<typeof planMessageRangeDeletion>) => {
			if (planned.refs.length === 0) return;
			measureSync("questions", () => {
				affectedQuestionIds = reconcileQuestionHistoryInTransaction(tx, narratorId, {
					deletedMessageIds: planned.refs.map((ref) => ref.messageId),
				}).affectedQuestionIds;
			});
			measureSync("checkpoints", () =>
				insertFileHistoryCheckpoints(tx, narratorId, planned.checkpoints),
			);
			measureSync("deleteRefs", () =>
				deleteRecipientMessageRefs(tx)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							inArray(
								narratorMessageRefs.id,
								planned.refs.map((ref) => ref.id),
							),
						),
					)
					.run(),
			);
			measureSync("deleteOrphans", () => deleteOrphanedMessages(tx, planned.orphanIds));
			measureSync("updateNarrator", () =>
				tx
					.update(narrators)
					.set({
						...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
						messageVersion: sql`${narrators.messageVersion} + 1`,
						contextUsageSnapshotJson: null,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId))
					.run(),
			);
		};
		const planned = opts?.skipRevert
			? measureSync("transaction", () =>
					db.transaction((tx) => {
						const plan = measureSync("plan", () =>
							planMessageRangeDeletion(tx, narratorId, messageId, inclusive, opts),
						);
						// History-only deletion keeps its plan and mutation in the same write transaction.
						apply(tx, plan);
						return plan;
					}),
				)
			: await measureAsync("readPlan", () =>
					readTransactionTask(
						db,
						{
							kind: "narrator-read-transaction-v1",
							operation: "rangeDeletionPlan",
							narratorId,
							messageId,
							inclusive,
							options: opts,
						},
						() =>
							db.transaction((tx) =>
								planMessageRangeDeletion(tx, narratorId, messageId, inclusive, opts),
							),
						{ site: "narrator-messages.rangeDeletionPlan" },
					),
				);
		selectedMessageCount = planned.refs.length;
		const messageIds = planned.refs.map((ref) => ref.messageId);
		let revertWarnings: RevertWarning[] = [];
		if (!opts?.skipRevert && messageIds.length > 0) {
			const version = JSON.stringify(planned);
			const result = await measureAsync("fileRevert", () =>
				revertForDeletedMessages(narratorId, messageIds, opts?.scope),
			);
			await measureAsync("revertCommit", () =>
				commitSnapshotRevert(result, () =>
					measureSync("transaction", () =>
						db.transaction((tx) => {
							const current = measureSync("plan", () =>
								planMessageRangeDeletion(tx, narratorId, messageId, inclusive, opts),
							);
							if (JSON.stringify(current) !== version) {
								throw new AppError(
									"Message history changed during deletion; retry the selection",
									409,
									"HISTORY_DELETE_STALE",
								);
							}
							apply(tx, planned);
						}),
					),
				),
			);
			revertWarnings = result.warnings ?? [];
		}
		await measureAsync("questionNotifications", () =>
			notifyQuestionHistoryAfterCommit(narratorId, affectedQuestionIds),
		);
		// A removed Agent/Task card archives its subagent after the transaction commits.
		if (planned.derived.subagentNarratorIds.length > 0) {
			await measureAsync("archiveSubagents", async () => {
				const { archiveRetiredSubagents } = await import("./subagent-lifecycle");
				await archiveRetiredSubagents(planned.derived.subagentNarratorIds);
			});
		}
		success = true;
		return {
			deletedCount: planned.refs.length,
			deletedMessageIds: messageIds,
			revertWarnings,
			...(planned.derived.warnings.length ? { historyWarnings: planned.derived.warnings } : {}),
			...(planned.derived.subagentNarratorIds.length
				? { archivedSubagentIds: planned.derived.subagentNarratorIds }
				: {}),
		};
	} finally {
		const round = (ms: number) => Math.round(ms * 100) / 100;
		const durationMs = round(performance.now() - started);
		const log = durationMs >= 100 || !success ? logger.warn : logger.info;
		log("Message history truncation completed", {
			...context,
			startedAt,
			durationMs,
			success,
			selectedMessageCount,
			// Transaction and revertCommit contain their child phases; do not sum them.
			phaseDurationsMs: Object.fromEntries(
				Object.entries(phaseDurationsMs).map(([phase, ms]) => [phase, round(ms)]),
			),
		});
	}
}

function insertFileHistoryCheckpoints(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	narratorId: string,
	groups: FileHistoryCheckpointGroup[],
): void {
	for (const group of groups) {
		if (group.toolCalls.length === 0) continue;
		const checkpointId = generateId();
		tx.insert(narratorMessages)
			.values({
				id: checkpointId,
				narratorId,
				role: "disp",
				contentJson: [{ type: "file_history_checkpoint" }],
				contextCharsJson: { segments: [] },
				contentText: null,
				createdAt: new Date().toISOString(),
			})
			.run();
		tx.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId,
				messageId: checkpointId,
				seq: group.seq,
				// A non-null segmentCompactId keeps this internal state out of all
				// normal message/model queries without a schema migration.
				segmentCompactId: checkpointId,
			})
			.run();
		tx.insert(narratorToolCalls)
			.values(
				group.toolCalls.map((toolCall) => ({
					...toolCall,
					id: generateId(),
					narratorId,
					messageId: checkpointId,
					toolUseId: generateId(),
					executionOriginToolCallId: toolCall.executionOriginToolCallId ?? toolCall.id,
					isFileHistoryCheckpoint: true,
				})),
			)
			.run();
	}
}

/** Attach narrator_message_refs.seq so clients can sort across paginated pages. */
function attachMessageSeqs<T extends { id: string }>(
	messages: T[],
	seqMap: Map<string, number>,
): void {
	for (const msg of messages) {
		const seq = seqMap.get(msg.id);
		if (seq != null) {
			(msg as T & { seq?: number }).seq = seq;
		}
	}
}

/**
 * Build a tree from a flat array of messages.
 * Messages with parentToolUseId are nested under the message whose
 * toolCalls contains the matching toolUseId.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function buildMessageTree(flatMessages: any[]): any[] {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const cloned = flatMessages.map((msg) => ({ ...msg, children: [] as any[] }));
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const toolUseIdToMsg = new Map<string, any>();
	for (const msg of cloned) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				toolUseIdToMsg.set(tc.toolUseId, msg);
			}
		}
	}
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const topLevel: any[] = [];
	for (const msg of cloned) {
		if (msg.parentToolUseId && toolUseIdToMsg.has(msg.parentToolUseId)) {
			toolUseIdToMsg.get(msg.parentToolUseId).children.push(msg);
		} else if (!msg.parentToolUseId) {
			topLevel.push(msg);
		}
	}
	return topLevel;
}

/** Collect all toolUseIds from a set of messages (for iterative child fetching) */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function collectToolUseIds(messages: any[]): string[] {
	const ids: string[] = [];
	for (const msg of messages) {
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				ids.push(tc.toolUseId);
			}
		}
	}
	return ids;
}

/** Tool names that spawn subagents (whose child messages form a subagent tree). */

/**
 * Collect toolUseIds of only subagent-spawning tool calls (Agent/Task/Send).
 * These are the ones whose children may be omitted + lazy-loaded; children of
 * any other tool call (rare/legacy) are always inlined.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function collectSubagentToolUseIds(messages: any[]): string[] {
	const ids: string[] = [];
	for (const msg of messages) {
		if (!msg.toolCalls) continue;
		for (const tc of msg.toolCalls) {
			if (SUBAGENT_TOOL_NAMES.has(tc.toolName)) ids.push(tc.toolUseId);
		}
	}
	return ids;
}

function upsertCursorChildAnchor(
	anchors: Map<string, CatchUpChildAnchor>,
	anchor: CatchUpChildAnchor,
): void {
	if (!anchor.parentToolUseId) return;
	const existing = anchors.get(anchor.parentToolUseId);
	anchors.delete(anchor.parentToolUseId);
	anchors.set(anchor.parentToolUseId, {
		parentToolUseId: anchor.parentToolUseId,
		narratorId: anchor.narratorId ?? existing?.narratorId,
		lastMessageId: anchor.lastMessageId ?? existing?.lastMessageId,
	});
}

function trimCursorChildAnchors(anchors: Map<string, CatchUpChildAnchor>): CatchUpChildAnchor[] {
	return [...anchors.values()].slice(-MAX_CATCH_UP_CHILD_ANCHORS);
}

type CatchUpCursorMessage = {
	id?: string;
	narratorId?: string;
	parentToolUseId?: string | null;
	toolCalls?: Array<{ toolUseId: string; toolName?: string }> | null;
};

function collectCursorToolUseIds(message: CatchUpCursorMessage): string[] {
	return message.toolCalls?.map((toolCall) => toolCall.toolUseId).filter(Boolean) ?? [];
}

function buildCatchUpCursor(params: {
	parentLastMessageId?: string;
	baseChildAnchors: CatchUpChildAnchor[];
	topMessages: CatchUpCursorMessage[];
	childMessages: CatchUpCursorMessage[];
}): CatchUpCursor {
	const anchors = new Map<string, CatchUpChildAnchor>();
	for (const anchor of params.baseChildAnchors) {
		upsertCursorChildAnchor(anchors, anchor);
	}
	for (const top of params.topMessages) {
		for (const toolUseId of collectCursorToolUseIds(top)) {
			upsertCursorChildAnchor(anchors, { parentToolUseId: toolUseId });
		}
	}
	for (const child of params.childMessages) {
		if (!child.parentToolUseId || !child.id) continue;
		upsertCursorChildAnchor(anchors, {
			parentToolUseId: child.parentToolUseId,
			narratorId: child.narratorId,
			lastMessageId: child.id,
		});
	}
	return {
		parentLastMessageId: params.parentLastMessageId,
		childAnchors: trimCursorChildAnchors(anchors),
	};
}

type ResolvedChildAnchor = CatchUpChildAnchor & { seq: number; narratorId: string };

async function resolveCatchUpChildAnchors(
	parentNarratorId: string,
	anchors: CatchUpChildAnchor[],
): Promise<{
	messageAnchors: Map<string, ResolvedChildAnchor>;
	subagentAnchors: Map<string, CatchUpChildAnchor>;
}> {
	const scope = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateScope",
			narratorId: parentNarratorId,
			ids: anchors.map((anchor) => anchor.parentToolUseId),
		},
		() =>
			db.transaction((tx) =>
				resolveAggregateScopeTx(
					tx,
					parentNarratorId,
					anchors.map((anchor) => anchor.parentToolUseId),
				),
			),
		{ site: "narrator-messages.aggregateScope" },
	);
	const messageAnchors = new Map<string, ResolvedChildAnchor>();
	const subagentAnchors = new Map<string, CatchUpChildAnchor>();
	for (const anchor of anchors) {
		const parent = scope.parents.get(anchor.parentToolUseId);
		if (!parent) continue;
		if (SUBAGENT_TOOL_NAMES.has(parent.toolName)) {
			subagentAnchors.set(anchor.parentToolUseId, { parentToolUseId: anchor.parentToolUseId });
			continue;
		}
		const rows = scope.inlineRows.filter((row) => row.parentToolUseId === anchor.parentToolUseId);
		const last = anchor.lastMessageId
			? rows.find((row) => row.id === anchor.lastMessageId)
			: undefined;
		if (anchor.lastMessageId && !last) continue;
		if (
			anchor.narratorId &&
			anchor.narratorId !== parentNarratorId &&
			!rows.some((row) => row.narratorId === anchor.narratorId)
		)
			continue;
		const seq = last?.seq ?? -1;
		const existing = messageAnchors.get(anchor.parentToolUseId);
		if (!existing || seq >= existing.seq) {
			messageAnchors.set(anchor.parentToolUseId, {
				parentToolUseId: anchor.parentToolUseId,
				// Cursor narratorId is a display hint, not authority over a ref stream.
				narratorId: parentNarratorId,
				lastMessageId: last?.id,
				seq,
			});
		}
	}
	return { messageAnchors, subagentAnchors };
}

function childCatchUpCondition(anchor: ResolvedChildAnchor): SQL<unknown> {
	const conditions = [
		gt(narratorMessageRefs.seq, anchor.seq),
		isNull(narratorMessageRefs.segmentCompactId),
		eq(narratorMessages.parentToolUseId, anchor.parentToolUseId),
	];
	if (anchor.narratorId) {
		conditions.push(eq(narratorMessageRefs.narratorId, anchor.narratorId));
	}
	return and(...conditions) as SQL<unknown>;
}

function combineOrConditions(conditions: SQL<unknown>[]): SQL<unknown> | undefined {
	if (conditions.length === 0) return undefined;
	if (conditions.length === 1) return conditions[0];
	return or(...conditions);
}

/**
 * Remove assistant messages that only contain ExitPlanMode tool_use
 * when immediately followed by a plan compact system message.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function filterExitPlanBeforePlanCompact(tree: any[]): any[] {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const result: any[] = [];
	for (let i = 0; i < tree.length; i++) {
		const msg = tree[i];
		const next = tree[i + 1];
		if (
			next?.role === "system" &&
			Array.isArray(next.contentJson) &&
			next.contentJson.some(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(b: any) => b.type === "compact" && b.subtype === "plan",
			)
		) {
			if (msg.role === "assistant" && Array.isArray(msg.contentJson)) {
				const blocks = msg.contentJson;
				const onlyExitPlan =
					blocks.length > 0 &&
					blocks.every(
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						(b: any) =>
							(b.type === "tool_use" && b.name === "ExitPlanMode") ||
							(b.type === "text" && !b.text?.trim()),
					) &&
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					blocks.some((b: any) => b.type === "tool_use");
				if (onlyExitPlan) continue;
			}
		}
		result.push(msg);
	}
	return result;
}

// ── Truncation & enrichment helpers (exported) ─────────────────────────────

/**
 * Truncate a tool payload FIELD BY FIELD, capping every oversized string leaf at
 * `maxLen` while leaving the object structure and short fields intact.
 *
 * This used to wrap the whole value (`JSON.stringify` → slice → `{_truncated,
 * preview}`), which dropped `_metadata` (so every structured card degraded to a
 * JSON dump), made `_text` unreadable, and forced header fields through a
 * hand-maintained `_hints` whitelist. See `@shared/pretext-layout/tool-io-projection`
 * for the full rationale.
 *
 * `maxLen` stays REQUIRED and keeps its 2000 default: the WS broadcast channels
 * and the exact-layout page want very different budgets, and an ambient default
 * is how a high-frequency channel silently inflates.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateJson(val: any, maxLen: number = DEFAULT_TOOL_IO_BUDGET): any {
	if (val === null || val === undefined) return val;
	// A small (broadcast) budget must not be overridden by the larger markdown
	// budget; only the exact-layout path opts into that (see EXACT_TOOL_IO_BUDGET).
	return projectToolIO(val, { leafBudget: maxLen, markdownBudget: maxLen });
}

/**
 * Default per-leaf budget (chars) for every path except the exact-layout page.
 *
 * Deliberately unchanged from the legacy value: WS broadcasts run on every
 * `tool_completed`, and CLAUDE.md requires high-frequency output to stay bounded.
 */
export const DEFAULT_TOOL_IO_BUDGET = 2000;

/**
 * Per-leaf budget (chars) for the exact-layout (`getPretextDocumentPage`) path.
 *
 * Chosen for CONTENT SUFFICIENCY, not height correctness: the vlist's largest
 * non-plan detail cap is 400px ≈ 26 lines ≈ 2600 chars, so 2000 could not fill
 * the box the card already reserved. Height correctness comes from the measure
 * layer's cap clamp, which is budget-independent.
 */
export const EXACT_TOOL_IO_BUDGET = TOOL_IO_BUDGETS.leaf;

/** Tool names whose inputJson/outputJson should never be truncated in message lists */
const SKIP_TRUNCATE_TOOLS = new Set(["ExitPlanMode"]);

/** Tool names whose inputJson should not be truncated */
const SKIP_INPUT_TRUNCATE_TOOLS = new Set(["Agent", "Task", "Send"]);

const SPEC_TASKS_URI = "spec://tasks.json";

/**
 * Whether a tool call is a Write/Edit on the Dynamic Spec task queue
 * (spec://tasks.json). Its input must stay untruncated so the client can render
 * the custom task-list card (SpecTasksDetail) during every phase — including the
 * pending taskReflection window, before the completed output carries the parsed
 * task metadata. tasks.json is small by design, so keeping the full input is cheap.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function isSpecTasksInput(toolName: string, input: any): boolean {
	if (toolName !== "Write" && toolName !== "Edit") return false;
	if (!input || typeof input !== "object") return false;
	const filePath = input.file_path ?? input.filePath ?? input.path;
	return filePath === SPEC_TASKS_URI;
}

/**
 * Recursively project inputJson/outputJson of every tool call in a message tree.
 *
 * `maxLen` is the PER-LEAF budget and keeps the conservative 2000 default: most
 * call sites are WS broadcasts or other collapsed summaries, and only
 * `getPretextDocumentPage` drives the vlist's exact measurement — so the one
 * caller that wants a larger budget opts in explicitly rather than every other
 * caller inheriting an inflated default.
 */
/** Display/model projection only: never use this selector as execution authority. */
export function latestToolCallAttempts<
	T extends {
		toolUseId: string;
		executionAttempt?: number | null;
		createdAt?: string | null;
		id?: string;
	},
>(toolCalls: readonly T[]): T[] {
	const selected = new Map<string, T>();
	for (const row of toolCalls) {
		const previous = selected.get(row.toolUseId);
		if (
			!previous ||
			(row.executionAttempt ?? 0) > (previous.executionAttempt ?? 0) ||
			((row.executionAttempt ?? 0) === (previous.executionAttempt ?? 0) &&
				((row.createdAt ?? "") > (previous.createdAt ?? "") ||
					(row.createdAt === previous.createdAt && (row.id ?? "") > (previous.id ?? ""))))
		) {
			selected.set(row.toolUseId, row);
		}
	}
	return [...selected.values()];
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateToolIO(tree: any[], maxLen = DEFAULT_TOOL_IO_BUDGET): any[] {
	return tree.map((msg) => {
		const toolCalls = msg.toolCalls ? latestToolCallAttempts(msg.toolCalls) : msg.toolCalls;
		return {
			...msg,
			// Display-only projection; the DB row and model-history snapshots stay intact.
			...(Array.isArray(msg.contentJson)
				? {
						contentJson: msg.contentJson.map((block: { type?: string } | null) =>
							block?.type === "file_reference"
								? fileReferenceDisplay(block as FileReferenceDisplay)
								: block,
						),
					}
				: {}),
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			toolCalls: toolCalls?.map((tc: any) => {
				const withExecutionTargets = toolCallWithExecutionTargets(tc);
				if (SKIP_TRUNCATE_TOOLS.has(tc.toolName)) return withExecutionTargets;
				const skipInput =
					SKIP_INPUT_TRUNCATE_TOOLS.has(tc.toolName) || isSpecTasksInput(tc.toolName, tc.inputJson);
				return {
					...withExecutionTargets,
					inputJson: skipInput ? tc.inputJson : truncateJson(tc.inputJson, maxLen),
					outputJson: truncateJson(tc.outputJson, maxLen),
				};
			}),
			children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
		};
	});
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function enrichToolUseBlocks(tree: any[]): any[] {
	return tree.map((msg) => {
		if (!msg.toolCalls?.length || !Array.isArray(msg.contentJson)) {
			return msg.children?.length ? { ...msg, children: enrichToolUseBlocks(msg.children) } : msg;
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const tcMap = new Map<string, any>(
			latestToolCallAttempts(msg.toolCalls).map((tc) => [tc.toolUseId, tc]),
		);
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const enrichedContent = msg.contentJson.map((block: any) => {
			if (block.type !== "tool_use") return block;
			const tc = tcMap.get(block.id);
			if (!tc) return block;
			const outputJson = tc.outputJson;
			const _metadata =
				outputJson && typeof outputJson === "object" && !Array.isArray(outputJson)
					? outputJson._metadata
					: undefined;
			return {
				...block,
				inputJson: tc.inputJson ?? block.input,
				outputJson: tc.outputJson,
				status: tc.status,
				executionAttempt: tc.executionAttempt,
				durationMs: tc.durationMs,
				streamStartedAt: tc.streamStartedAt,
				streamCompletedAt: tc.streamCompletedAt,
				permissionStartedAt: tc.permissionStartedAt,
				executionStartedAt: tc.executionStartedAt,
				// Exact-history pages drop toolCalls after enrichment. Copy only this
				// selected attempt's frozen facts, overwriting any stale block snapshot.
				executionDeviceId: tc.executionDeviceId,
				executionCwd: tc.executionCwd,
				resolvedFilePath: tc.resolvedFilePath,
				executionTarget: tc.executionTarget,
				executionTargets: tc.executionTargets,
				deviceSelectionSource: tc.deviceSelectionSource,
				completedAt: tc.completedAt,
				errorMessage: tc.errorMessage,
				permissionDecisionReason: tc.permissionDecisionReason,
				permissionDenyMessage: tc.permissionDenyMessage,
				permissionSuggestions: tc.permissionSuggestions,
				permissionDecidedAt: tc.permissionDecidedAt,
				permissionDecidedBy: tc.permissionDecidedBy,
				tcId: tc.id,
				tcCreatedAt: tc.createdAt,
				...(tc._subagentActivity ? { _subagentActivity: tc._subagentActivity } : {}),
				...(_metadata && { _metadata }),
			};
		});
		return {
			...msg,
			contentJson: enrichedContent,
			children: msg.children?.length ? enrichToolUseBlocks(msg.children) : msg.children,
		};
	});
}

/**
 * Drop the `toolCalls` relation array from an already-ENRICHED message tree.
 *
 * WHY THIS IS SAFE — and why it must run only after `enrichToolUseBlocks`.
 *
 * The wire payload used to carry every tool call twice: once as the relation row
 * in `toolCalls[]`, and once copied onto its `tool_use` block by
 * `enrichToolUseBlocks`. Measured on real narrators the array was ~33% of the
 * exact-layout page (98KB of 283KB, 151KB of 458KB), of which the duplicated
 * `outputJson` alone was 11-15%.
 *
 * The renderer never needs the array on this path. `segmentMessages`
 * (frontend/components/narrator/message/message-segments.ts) builds each `ToolCallData`
 * as `block.<field> ?? tc?.<field>` for every field it reads — the block is
 * always preferred and the row is only a fallback — and `enrichToolUseBlocks`
 * writes all of those fields onto the block (with `id`/`createdAt` landing as
 * `tcId`/`tcCreatedAt`, which is exactly where `segmentMessages` looks for them).
 * Verified empirically over 157 matched tool_use/toolCall pairs across the four
 * largest narrators: no field present on a row was ever missing from its block.
 *
 * HEIGHT NEUTRALITY: measurement reads only the `ToolCallData` that
 * `segmentMessages` produces, and that object is byte-identical whether or not
 * the fallback array was present — so no measured height can move. This is a
 * transport-only projection, which is why it is confined to the one endpoint
 * whose consumer is the vlist loader rather than applied in `truncateToolIO`
 * (whose other call sites include WS broadcasts, where the array is NOT
 * redundant).
 *
 * `toolCalls` is replaced with `[]` rather than deleted: `segmentMessages` and
 * several call sites do `msg.toolCalls?.find(...)` / `Array.isArray(msg.toolCalls)`,
 * and an empty array keeps every one of those a well-typed no-op.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function stripRedundantToolCallRows(tree: any[]): any[] {
	return tree.map((msg) => {
		const hasRows = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
		const children = msg.children?.length ? stripRedundantToolCallRows(msg.children) : msg.children;
		if (!hasRows) return children === msg.children ? msg : { ...msg, children };
		return { ...msg, toolCalls: [], children };
	});
}

/**
 * Drop `providerMetadata` from every content block for transport.
 *
 * WHAT IT IS. `providerMetadata` (shared/agent-protocol/types.ts —
 * `ReasoningProviderMetadata`) is purely REPLAY state: every field exists so the
 * server can echo a reasoning block back to the upstream that minted it, and none
 * of them is displayable.
 *
 *   openai.reasoningEncryptedContent  opaque ciphertext, replayed as
 *                                     `encrypted_content`
 *   openai.itemId                     Responses API reasoning item id
 *   anthropic.signature               thinking-block signature, must be echoed
 *   gemini.thoughtSignature           ditto, or the next turn 400s
 *   signatureSource                   which upstream minted the signature
 *
 * `openai-provider.ts` is its only reader, and
 * they read it from the DATABASE when replaying history — never from anything the
 * browser sent back. The frontend has no API that returns a message body to the
 * server (edit / retry / fork all address messages by id), so removing it from a
 * read response cannot affect continuation.
 *
 * WHY IT IS WORTH REMOVING. Measured over the six largest narrators' first
 * screens: 254KB across 98 blocks, 10.9% of 2331KB. The ciphertext dominates
 * (212KB) but `anthropic.signature` is another 33KB, so eliding only the
 * ciphertext — the previous version of this function — left a third of the weight
 * on the wire for no reason.
 *
 * THE ONE BIT THAT MUST SURVIVE. Presence of a ciphertext is a display input even
 * though its content is not: `hasEncryptedReasoningMetadata`
 * (shared/pretext-layout/reasoning-segments.ts) tests
 * `typeof encrypted === "string" && encrypted.length > 0`, and
 * `getReasoningEncryptionState` turns that into `"only"` / `"partial"`, which
 * `MessageBubble` renders as a lock-icon placeholder and substitutes for the empty
 * reasoning text. A bare deletion would silently flip that state to `"none"`,
 * removing a rendered row. So the projection replaces the whole object with
 * `{ hasEncryptedReasoning: true }` on exactly the blocks that had one, and
 * `hasEncryptedReasoningMetadata` accepts that flag as an equivalent signal.
 *
 * The vlist adapter never reads `providerMetadata` at all (it derives a reasoning
 * row from `thinking`/`text`), so on the exact path this is height-neutral by
 * construction; the flag is what keeps it height-neutral for the collapsed
 * summary paths too. Both are pinned by tests.
 *
 * Transport-only, and confined to the exact-layout page for the same reason
 * `stripRedundantToolCallRows` is: the real value must survive on every path that
 * feeds history back to a provider.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function stripProviderMetadata(tree: any[]): any[] {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const stripBlock = (block: any) => {
		const providerMetadata = block?.providerMetadata;
		if (!providerMetadata || typeof providerMetadata !== "object") return block;
		if (
			providerMetadata.hasEncryptedReasoning === true &&
			Object.keys(providerMetadata).length === 1
		)
			return block;
		const hadEncrypted =
			providerMetadata.hasEncryptedReasoning === true ||
			Object.values(providerMetadata as Record<string, unknown>).some((metadata) => {
				if (!metadata || typeof metadata !== "object") return false;
				const encrypted = (metadata as Record<string, unknown>).reasoningEncryptedContent;
				return typeof encrypted === "string" && encrypted.length > 0;
			});
		const { providerMetadata: _dropped, ...rest } = block;
		return hadEncrypted ? { ...rest, providerMetadata: { hasEncryptedReasoning: true } } : rest;
	};

	return tree.map((msg) => {
		const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : null;
		const children = msg.children?.length ? stripProviderMetadata(msg.children) : msg.children;
		if (!blocks) return children === msg.children ? msg : { ...msg, children };
		let changed = false;
		const contentJson = blocks.map((block: unknown) => {
			const next = stripBlock(block);
			if (next !== block) changed = true;
			return next;
		});
		if (!changed) return children === msg.children ? msg : { ...msg, children };
		return { ...msg, contentJson, children };
	});
}

export interface SubagentActivityToolCallTiming {
	streamStartedAt?: string | number | null;
	permissionStartedAt?: string | number | null;
	executionStartedAt?: string | number | null;
	completedAt?: string | number | null;
	durationMs?: number | null;
}

export interface SubagentActivityToolCall {
	toolCallId: string | null;
	toolUseId: string;
	toolName: string;
	status: string;
	createdAt: string | null;
	timing: SubagentActivityToolCallTiming | null;
	/**
	 * Whitelisted short input keys for the row label (Bash's `description`, a file
	 * tool's `file_path`, ...). Absent when the input had none, was unparseable, or
	 * exceeded the size guard — the row then falls back to the bare tool name.
	 */
	inputSummary?: SubagentToolInputSummary;
}

export interface SubagentActivity {
	subagentNarratorId: string | null;
	model: string | null;
	/** Effective tier used by the subagent, including the global default when stored override is null. */
	reasoningEffort: string | null;
	/** Last run's follow/fallback decision for `__parent__` children; absent when unknown. */
	modelInheritance?: SubagentModelInheritance;
	latestToolCalls: SubagentActivityToolCall[];
	/**
	 * Files this subagent changed, with cumulative line churn.
	 *
	 * A subagent has its own narrator record, so nothing else on the parent's card
	 * could show what its child wrote to disk. Aggregated ONCE for every card on the
	 * page (see `getFileChangesBySubagent`) rather than per card.
	 *
	 * Absent when the subagent changed nothing, so the common payload keeps its
	 * previous size. Height-AFFECTING on the client: the card lists these rows.
	 */
	fileChanges?: SubagentFileChanges;
	/**
	 * The child is currently TAKEN OVER by the user, so the parent's tool call is
	 * blocked until the user stops it (the run hold in `agent-runtime/ownership.ts`).
	 *
	 * Carried on the activity snapshot because that snapshot is the reconnect
	 * catch-up channel: without it a client that reconnects mid-takeover would keep
	 * showing a plain "running" card, which is exactly the stalled-and-silent state
	 * the flag exists to surface. Absent (rather than `false`) in the normal case so
	 * the payload does not grow for every card.
	 */
	takenOver?: boolean;
}

export interface SubagentActivityCatchUp {
	parentToolUseId: string;
	activity: SubagentActivity;
}

export type SubagentActivitySnapshot = SubagentActivityCatchUp[];

/**
 * Parse the `json_object(...)` projection back into a summary.
 *
 * The payload is bounded by construction (10 keys × 200 chars), so this parse is
 * not the big-field read the query avoids.
 */
function parseSubagentSummary(raw: unknown): SubagentToolInputSummary | null {
	if (typeof raw !== "string" || !raw) return null;
	try {
		return normalizeSubagentToolInputSummary(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function loadLatestSubagentToolCalls(
	narratorIds: string[],
	signal?: AbortSignal,
	deadlineAt?: number,
): Promise<Map<string, SubagentActivityToolCall[]>> {
	const result = new Map<string, SubagentActivityToolCall[]>();
	const uniqueNarratorIds = [...new Set(narratorIds)];
	if (uniqueNarratorIds.length === 0) return result;

	const rowsByNarrator = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "latestSubagentToolCalls",
			narratorId: uniqueNarratorIds[0],
			ids: uniqueNarratorIds,
		},
		() => db.transaction((tx) => loadLatestSubagentToolCallsTx(tx, uniqueNarratorIds, signal)),
		{
			site: "narrator-messages.latestSubagentToolCalls",
			signal,
			timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
		},
	);

	for (const { narratorId, rows } of rowsByNarrator) {
		result.set(
			narratorId,
			rows.map((row) => {
				const timing: SubagentActivityToolCallTiming = {
					streamStartedAt: row.streamStartedAt,
					permissionStartedAt: row.permissionStartedAt,
					executionStartedAt: row.executionStartedAt,
					completedAt: row.completedAt,
					durationMs: row.durationMs,
				};
				const inputSummary = parseSubagentSummary(row.inputSummary);
				return {
					toolCallId: row.toolCallId ?? null,
					toolUseId: row.toolUseId,
					toolName: row.toolName,
					status: row.status,
					createdAt: row.createdAt ?? null,
					timing: Object.values(timing).some((value) => value != null) ? timing : null,
					...(inputSummary ? { inputSummary } : {}),
				};
			}),
		);
	}
	return result;
}

type SubagentActivityReadTiming = {
	ownerCount?: number;
	toolCallsMs?: number;
	fileOptionsMs?: number;
	fileChangesMs?: number;
	fileChangeRead?: SubagentFileChangeReadTiming;
};

async function buildSubagentActivities(
	owners: SubagentActivityOwner[],
	expectedToolUseIds: string[] = [],
	signal?: AbortSignal,
	deadlineAt?: number,
	timing?: SubagentActivityReadTiming,
): Promise<Map<string, SubagentActivity>> {
	const activities = new Map<string, SubagentActivity>();
	for (const toolUseId of expectedToolUseIds) {
		activities.set(toolUseId, {
			subagentNarratorId: null,
			model: null,
			reasoningEffort: null,
			latestToolCalls: [],
		});
	}
	const narratorIds = [...new Set(owners.map((owner) => owner.subagentNarratorId))];
	assertDisplayReadActive(signal, deadlineAt);
	const started = performance.now();
	const toolCallsByNarrator = await loadLatestSubagentToolCalls(narratorIds, signal, deadlineAt);
	const toolCallsAt = performance.now();
	assertDisplayReadActive(signal, deadlineAt);
	const currentOptions = await getCurrentSubagentFileChangeOptions(narratorIds);
	const fileOptionsAt = performance.now();
	assertDisplayReadActive(signal, deadlineAt);
	// One aggregate for EVERY card on the page. A per-card query here would turn
	// opening a session with a dozen Agent calls into a query storm on a list path.
	const fileChangeRead: SubagentFileChangeReadTiming | undefined = timing ? {} : undefined;
	if (timing) timing.fileChangeRead = fileChangeRead;
	const fileChangesByNarrator = await getFileChangesBySubagent(
		narratorIds,
		currentOptions,
		fileChangeRead,
	);
	assertDisplayReadActive(signal, deadlineAt);
	if (timing) {
		timing.ownerCount = narratorIds.length;
		timing.toolCallsMs = Math.round(toolCallsAt - started);
		timing.fileOptionsMs = Math.round(fileOptionsAt - toolCallsAt);
		timing.fileChangesMs = Math.round(performance.now() - fileOptionsAt);
	}
	for (const owner of owners) {
		const effectiveReasoningEffort =
			owner.reasoningEffort ??
			(owner.model
				? resolveDefaultReasoningEffort(resolveProvider(owner.model), owner.model)
				: undefined);
		// In-memory read of the last run's decision; resolving traits per card here
		// would turn a history page into a query storm.
		const modelInheritance =
			owner.model === FOLLOW_PARENT_MODEL
				? getRecentSubagentModelInheritance(owner.subagentNarratorId)
				: undefined;
		activities.set(owner.parentToolUseId, {
			subagentNarratorId: owner.subagentNarratorId,
			model: owner.model,
			reasoningEffort: effectiveReasoningEffort ?? null,
			...(modelInheritance ? { modelInheritance } : {}),
			latestToolCalls: toolCallsByNarrator.get(owner.subagentNarratorId) ?? [],
			// Omitted (not an empty aggregate) when the child changed nothing, so a card
			// that has no files to show carries no extra payload.
			...(fileChangesByNarrator.has(owner.subagentNarratorId)
				? { fileChanges: fileChangesByNarrator.get(owner.subagentNarratorId) }
				: {}),
			// Synchronous in-memory read (no query); omitted when false so the common
			// snapshot stays the same size it was.
			//
			// `…ForDisplay`, not `isTakenOver`: after the user stops a takeover on a
			// still-working subagent the release is DEFERRED to its loop end, and the
			// takeover set stays populated on purpose. Reading the raw set here re-lit
			// the badge on every page load in that window.
			...(isRunHeldForDisplay(owner.subagentNarratorId) ? { takenOver: true } : {}),
		});
	}
	return activities;
}

// Recovery scan thresholds: a message is "oversized" when it alone is likely to
// break the aggregate budget above. Aligned with the per-response tool-call cap.
const HISTORY_RECOVERY_TOOL_COUNT = 32;
const HISTORY_RECOVERY_BYTE_SIZE = 1024 * 1024;
const HISTORY_RECOVERY_CANDIDATES = 10;

/**
 * Resolve provider groups from real caller refs. No caller-supplied narrator ID
 * or matching parentToolUseId can authorize a child. Enumerate bounded metadata
 * before deciding uniqueness: an omitted tail cannot prove a group has one owner.
 */
function resolveAggregateScopeTx(tx: MessageTx, narratorId: string, toolUseIds: string[]) {
	return withSqlDiagnosticSite("narrator-messages.resolveAggregateScopeTx", () =>
		resolveAggregateScopeTxImpl(tx, narratorId, toolUseIds),
	);
}

function assertDisplayReadActive(signal?: AbortSignal, deadlineAt?: number): void {
	if (signal?.aborted)
		throw new AppError("History display read was cancelled", 499, "DISPLAY_PAGE_CANCELLED");
	if (deadlineAt !== undefined && deadlineAt <= Date.now())
		throw new AppError(
			"History display read exceeded its total deadline",
			504,
			"DISPLAY_PAGE_DEADLINE",
		);
}

function sameTransportWindow(
	left: ReadonlyArray<{ messageId: string; seq: number }>,
	right: ReadonlyArray<{ messageId: string; seq: number }>,
): boolean {
	if (left.length !== right.length) return false;
	return left.every(
		(row, index) => row.messageId === right[index]?.messageId && row.seq === right[index]?.seq,
	);
}

/** Total builds (first try included) an unpinned exact-layout page gets under version drift. */
export const PRETEXT_PAGE_DRIFT_ATTEMPTS = 4;

/**
 * Short jittered pause before rebuilding a page whose revision moved mid-build. Writes on a
 * live narrator come in bursts (a block commit, then its tool row, then the parent bump), so
 * an immediate rebuild would mostly collide with the same burst. Never sleeps past the read's
 * own deadline, and wakes early on cancellation.
 */
async function waitForPretextDriftRetry(
	attempt: number,
	signal: AbortSignal | undefined,
	deadlineAt: number,
): Promise<void> {
	const delayMs = Math.min(
		25 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25),
		Math.max(0, deadlineAt - Date.now()),
	);
	if (delayMs > 0) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, delayMs);
			function done() {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			}
			signal?.addEventListener("abort", done, { once: true });
		});
	}
	assertDisplayReadActive(signal, deadlineAt);
}

async function loadAggregateRefMessages(
	narratorId: string,
	messageIds: string[],
	ioBudget = DEFAULT_TOOL_IO_BUDGET,
	signal?: AbortSignal,
	deadlineAt?: number,
	maxRawBytes = AGGREGATE_BODY_BYTE_LIMIT,
) {
	assertDisplayReadActive(signal, deadlineAt);
	if (messageIds.length === 0) return [];
	const refs = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateRefs",
			narratorId: narratorId,
			ids: messageIds,
		},
		() => db.transaction((tx) => loadAggregateRefMessagesTx(tx, narratorId, messageIds)),
		{
			site: "narrator-messages.aggregateRefs",
			signal,
			timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
		},
	);
	const options = {
		ioBudget,
		signal,
		maxRawBytes,
		timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
	};
	const displayDatabase = modelHistoryDatabase;
	const read =
		displayDatabase.activeDatabaseBackend === "postgres"
			? readNarratorDisplayMessages(
					{
						backend: "postgres",
						port: displayDatabase.activePostgresReadUrl
							? createPostgresNarratorDisplayPagePort(displayDatabase.activePostgresReadUrl)
							: undefined,
					},
					messageIds,
					options,
				)
			: process.env.NODE_ENV === "test" && displayDatabase.sqlite.filename === ":memory:"
				? readDisplayFixtureMessages(displayDatabase.sqlite, messageIds, options)
				: readNarratorDisplayMessages(
						{ backend: "sqlite", dbPath: displayDatabase.sqlite.filename },
						messageIds,
						options,
					);
	const messages = await read.catch((error: unknown) => {
		if (error instanceof AppError && error.code === "DISPLAY_PAGE_BUDGET_EXCEEDED")
			throw new AppError(
				"History aggregation exceeds its bounded metadata/body budget; open an explicit detail instead.",
				409,
				"HISTORY_AGGREGATE_UNAVAILABLE",
			);
		throw error;
	});
	assertDisplayReadActive(signal, deadlineAt);
	const current = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateRefs",
			narratorId: narratorId,
			ids: messageIds,
		},
		() => db.transaction((tx) => loadAggregateRefMessagesTx(tx, narratorId, messageIds)),
		{
			site: "narrator-messages.aggregateRefs",
			signal,
			timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
		},
	);
	if (!sameAggregateRows(refs, current))
		throw new AppError(
			"History aggregation references changed; reload the history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	return messages;
}

async function loadAggregateInlineMessages(narratorId: string, toolUseIds: string[]) {
	const scope = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateScope",
			narratorId: narratorId,
			ids: toolUseIds,
		},
		() => db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, toolUseIds)),
		{ site: "narrator-messages.aggregateScope" },
	);
	const messages = await loadAggregateRefMessages(
		narratorId,
		scope.inlineRows.map((row) => row.id),
	);
	assertAggregateScopeUnchanged(
		scope,
		await readTransactionTask(
			db,
			{
				kind: "narrator-read-transaction-v1",
				operation: "aggregateScope",
				narratorId: narratorId,
				ids: toolUseIds,
			},
			() => db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, toolUseIds)),
			{ site: "narrator-messages.aggregateScope" },
		),
	);
	return messages;
}

function sameAggregateRows<T extends object>(left: readonly T[], right: readonly T[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((row, index) => {
		const other = right[index];
		const keys = Object.keys(row) as Array<keyof T>;
		return (
			keys.length === Object.keys(other).length && keys.every((key) => row[key] === other[key])
		);
	});
}

function assertAggregateScopeUnchanged(
	scope: ReturnType<typeof resolveAggregateScopeTx>,
	current: ReturnType<typeof resolveAggregateScopeTx>,
): void {
	const sortedParents = (value: typeof scope) =>
		[...value.parents].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
	const sortedOwners = (value: typeof scope) =>
		[...value.owners].sort((a, b) => a.subagentNarratorId.localeCompare(b.subagentNarratorId));
	const sortedInline = (value: typeof scope) =>
		[...value.inlineRows].sort((a, b) => a.id.localeCompare(b.id));
	if (
		!sameAggregateRows(sortedOwners(current), sortedOwners(scope)) ||
		!sameAggregateRows(sortedParents(current), sortedParents(scope)) ||
		!sameAggregateRows(sortedInline(current), sortedInline(scope))
	)
		throw new AppError(
			"History aggregation scope changed; reload the history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
}

async function loadSubagentActivitiesForToolUseIds(
	narratorId: string,
	toolUseIds: string[],
	initialScope?: ReturnType<typeof resolveAggregateScopeTx>,
	scopeToolUseIds = toolUseIds,
	signal?: AbortSignal,
	deadlineAt?: number,
	timing?: SubagentActivityReadTiming,
): Promise<Map<string, SubagentActivity>> {
	if (toolUseIds.length === 0 && !initialScope) return new Map();
	const scope =
		initialScope ??
		(await readTransactionTask(
			db,
			{
				kind: "narrator-read-transaction-v1",
				operation: "aggregateScope",
				narratorId: narratorId,
				ids: scopeToolUseIds,
			},
			() => db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, scopeToolUseIds)),
			{
				site: "narrator-messages.aggregateScope",
				signal,
				timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
			},
		));
	const activities = await buildSubagentActivities(
		scope.owners,
		toolUseIds,
		signal,
		deadlineAt,
		timing,
	);
	// Summary/file aggregation can await other services. A removed caller/child
	// ref must revoke this response too, rather than publishing a stale owner.
	const current = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateScope",
			narratorId: narratorId,
			ids: scopeToolUseIds,
		},
		() => db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, scopeToolUseIds)),
		{
			site: "narrator-messages.aggregateScope",
			signal,
			timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
		},
	);
	assertAggregateScopeUnchanged(scope, current);
	return activities;
}

async function loadSubagentActivityCatchUp(
	narratorId: string,
	toolUseIds: string[],
): Promise<SubagentActivitySnapshot> {
	const activities = await loadSubagentActivitiesForToolUseIds(narratorId, toolUseIds);
	return [...activities].map(([parentToolUseId, activity]) => ({
		parentToolUseId,
		activity,
	}));
}

type SubagentActivityMessage = {
	toolCalls?: Array<{ toolUseId: string; _subagentActivity?: SubagentActivity }>;
};

function attachSubagentActivities(
	messages: SubagentActivityMessage[],
	activities: Map<string, SubagentActivity>,
): void {
	if (activities.size === 0) return;
	for (const message of messages) {
		for (const toolCall of message.toolCalls ?? []) {
			const activity = activities.get(toolCall.toolUseId);
			if (activity) toolCall._subagentActivity = activity;
		}
	}
}

/**
 * Build a fully-hydrated message tree from a set of top-level ref rows. Agent,
 * Task, and Send children are never loaded into their parent's tree; they expose
 * only a bounded activity snapshot. Non-subagent nested messages retain the
 * existing inline behavior.
 */
/**
 * Build the enriched message tree for a page of top-level refs.
 *
 * `ioBudget` has NO default on purpose: this helper serves both summary-style
 * callers (collapsed cards, small budget) and the exact-layout page (measured
 * bodies, larger budget), so each caller must state which one it is.
 */
async function buildTreeFromTopLevelRefs(
	narratorId: string,
	refRows: Array<{ messageId: string; seq: number }>,
	/** The session's own-turn placement (`ownTurnPlacementOf`). */
	placement: OwnTurnPlacement,
	ioBudget: number,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 10_000,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
): Promise<any[]> {
	if (refRows.length === 0) return [];

	const started = performance.now();
	const messageIds = refRows.map((r) => r.messageId);
	const topMessages = await loadAggregateRefMessages(
		narratorId,
		messageIds,
		ioBudget,
		signal,
		deadlineAt,
		DISPLAY_PAGE_LIMITS.maxRawBytes,
	);
	const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
	topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
	attachMessageSeqs(topMessages, seqMap);
	// Own turns placed under the session's destination are not nesting on its own page.
	for (const message of topMessages)
		if (isTopLevelMessage(message, placement)) message.parentToolUseId = null;

	const subagentToolUseIds = collectSubagentToolUseIds(topMessages);
	const subagentToolUseIdSet = new Set(subagentToolUseIds);
	const inlineToolUseIds = collectToolUseIds(topMessages).filter(
		(toolUseId) => !subagentToolUseIdSet.has(toolUseId),
	);
	const hydratedAt = performance.now();
	const aggregateToolUseIds = [...subagentToolUseIds, ...inlineToolUseIds];
	const scope = await readTransactionTask(
		db,
		{
			kind: "narrator-read-transaction-v1",
			operation: "aggregateScope",
			narratorId: narratorId,
			ids: aggregateToolUseIds,
		},
		() => db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, aggregateToolUseIds)),
		{
			site: "narrator-messages.aggregateScope",
			signal,
			timeoutMs: deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
		},
	);
	const childMessages = await loadAggregateRefMessages(
		narratorId,
		scope.inlineRows.map((row) => row.id),
		ioBudget,
		signal,
		deadlineAt,
	);
	const scopedAt = performance.now();
	const activityTiming: SubagentActivityReadTiming = {};
	const activities = await loadSubagentActivitiesForToolUseIds(
		narratorId,
		subagentToolUseIds,
		scope,
		aggregateToolUseIds,
		signal,
		deadlineAt,
		activityTiming,
	);
	assertDisplayReadActive(signal, deadlineAt);
	const summarizedAt = performance.now();
	attachSubagentActivities(topMessages, activities);
	const enriched = enrichToolUseBlocks(
		filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages]), ioBudget),
		),
	);
	// A still-waiting Await knows its target only as a selector; resolve it so the
	// row can open the child's session before the wait returns.
	const awaitAgentIds = await resolveAwaitAgentIdsForMessages([...topMessages, ...childMessages]);
	const result = attachTakenOverFlags(
		await attachSendTargetDetails(
			attachActiveSendDeliveryTargets(attachAwaitAgentNarratorIds(enriched, awaitAgentIds)),
		),
		collectTakenOverToolUseIds(activities, awaitAgentIds),
	);
	assertDisplayReadActive(signal, deadlineAt);
	const elapsedMs = Math.round(performance.now() - started);
	if (elapsedMs >= 250)
		logger.warn("Slow narrator display page hydration", {
			...sqlExecutionDiagnostics.correlation(),
			narratorId,
			elapsedMs,
			topRows: topMessages.length,
			inlineRows: childMessages.length,
			aggregateGroups: aggregateToolUseIds.length,
			subagentOwners: activityTiming.ownerCount ?? 0,
			activityToolCallsMs: activityTiming.toolCallsMs ?? 0,
			activityFileOptionsMs: activityTiming.fileOptionsMs ?? 0,
			activityFileChangesMs: activityTiming.fileChangesMs ?? 0,
			activityFileChangeRead: activityTiming.fileChangeRead,
			hydrateMs: Math.round(hydratedAt - started),
			scopeMs: Math.round(scopedAt - hydratedAt),
			summaryMs: Math.round(summarizedAt - scopedAt),
			projectionMs: Math.round(performance.now() - summarizedAt),
		});
	return result;
}

/**
 * The tool calls on this page whose target subagent is currently taken over.
 *
 * Reuses facts ALREADY in hand — no extra query:
 *   - `activities`   → an Agent/Task/Send card's child narrator id
 *   - `awaitAgentIds`→ a running `Await({type:"agent"})`'s resolved child id
 *
 * Takeover authority is the in-memory Set (the run hold in `agent-runtime/ownership.ts`), so the
 * membership test is synchronous. A finished Await needs no flag: its output
 * already states `taken_over` in words.
 *
 * Uses the DISPLAY list, which excludes subagents whose release is merely
 * deferred to their loop end — see `isTakeoverReleasePending`.
 */
function collectTakenOverToolUseIds(
	activities: ReadonlyMap<string, SubagentActivity>,
	awaitAgentIds: ReadonlyMap<string, AwaitAgentResolution>,
): Set<string> {
	const flagged = new Set<string>();
	const takenOver = new Set(listRunHolds().filter(isRunHeldForDisplay));
	if (takenOver.size === 0) return flagged;
	for (const [toolUseId, activity] of activities) {
		const child = activity.subagentNarratorId;
		if (child && takenOver.has(child)) flagged.add(toolUseId);
	}
	for (const [toolUseId, child] of awaitAgentIds) {
		if (takenOver.has(child.id)) flagged.add(toolUseId);
	}
	return flagged;
}

/**
 * Resolve the pending Await-agent selectors across a batch of loaded messages.
 *
 * Kept next to its only callers so the extra work is obvious at the call site: it
 * runs at most two small indexed queries per team scope and returns an empty map
 * (no queries at all) when the page contains no in-flight Await-agent call, which
 * is the overwhelmingly common case.
 */
async function resolveAwaitAgentIdsForMessages(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	messages: any[],
): Promise<Map<string, AwaitAgentResolution>> {
	const candidates: Array<{
		toolUseId: string;
		toolName: string;
		inputJson?: unknown;
		outputJson?: unknown;
		narratorId?: string;
	}> = [];
	for (const msg of messages) {
		for (const tc of msg?.toolCalls ?? []) {
			if (tc?.toolName !== "Await" && tc?.toolName !== "Send") continue;
			candidates.push({
				toolUseId: tc.toolUseId,
				toolName: tc.toolName,
				inputJson: tc.inputJson,
				outputJson: tc.outputJson,
				narratorId: tc.narratorId ?? msg?.narratorId,
			});
		}
	}
	if (candidates.length === 0) return new Map();
	return resolveAwaitAgentIdsForToolCalls(candidates);
}

/**
 * Re-exported so callers already importing the message layer keep working; the
 * implementation lives in `await-agent-resolution` because this module sits in an
 * import cycle with `narrator-service` (importing it from a test would evaluate
 * that cycle and fail at module init).
 */
export {
	AWAIT_AGENT_RESOLVED_FIELD,
	attachAwaitAgentNarratorIds,
	attachTakenOverFlags,
	TAKEN_OVER_FIELD,
};

// Tool-use IDs come from providers and are not unique across attempts/sessions.
// Metadata is bounded before visibility filtering, never mistaken for a full set.

/** Authorize and load a single row in the same read transaction (no async TOCTOU). */

// ── narratorMessages object ────────────────────────────────────────────────

const narratorMessageQueriesUnlocked = {
	async getMessages(narratorId: string, limit = 100, offset = 0) {
		const refRows = await readQuery(
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId))
				.orderBy(narratorMessageRefs.seq)
				.limit(limit)
				.offset(offset),
			{ site: "narrator-messages.getMessages" },
		);
		if (refRows.length === 0) return [];

		const messageIds = refRows.map((row) => row.messageId);
		const messages = await readQuery(
			db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, messageIds),
				with: { toolCalls: true },
			}),
			{ site: "narrator-messages.getMessages" },
		);
		const seqMap = new Map(refRows.map((row) => [row.messageId, row.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages.map((message) => ({
			...message,
			toolCalls: latestToolCallAttempts(message.toolCalls),
		}));
	},

	async getLatestCompactSeq(narratorId: string): Promise<number | null> {
		const lastCompactRow = await readQuery(
			db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1),
			{ site: "narrator-messages.getLatestCompactSeq" },
		);
		return lastCompactRow[0]?.seq ?? null;
	},

	async getMessagesSinceLastCompact(narratorId: string) {
		const compactSeq = await this.getLatestCompactSeq(narratorId);

		const refRows = await readQuery(
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
						isNull(narratorMessageRefs.segmentCompactId),
					),
				)
				.orderBy(narratorMessageRefs.seq),
			{ site: "narrator-messages.getMessagesSinceLastCompact" },
		);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await readQuery(
			db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, messageIds),
				with: { toolCalls: true },
			}),
			{ site: "narrator-messages.getMessagesSinceLastCompact" },
		);

		if (messages.length !== refRows.length) {
			const foundIds = new Set(messages.map((m) => m.id));
			const missingMessageIds = messageIds.filter((id) => !foundIds.has(id)).slice(0, 20);
			logger.warn("Narrator message refs point to missing messages", {
				narratorId,
				refCount: refRows.length,
				messageCount: messages.length,
				missingMessageIds,
			});
		}

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages.map((message) => ({
			...message,
			toolCalls: latestToolCallAttempts(message.toolCalls),
		}));
	},

	/**
	 * Load a bounded, purpose-built snapshot for ContextAsk.
	 *
	 * The query keeps large message/tool fields bounded at the SQLite projection layer,
	 * prefers the most recent post-compact messages, and reports every form of truncation
	 * so callers never present a partial source as complete.
	 */
	async getContextAskHistorySnapshot(
		narratorId: string,
		limit = CONTEXT_ASK_HISTORY_MESSAGE_LIMIT,
	): Promise<ContextAskHistorySnapshot> {
		const boundedLimit = Math.min(
			Math.max(Math.trunc(limit), 1),
			CONTEXT_ASK_HISTORY_MESSAGE_LIMIT,
		);
		const compactSeq = await this.getLatestCompactSeq(narratorId);
		const rawRefRows = await readQuery(
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
						ne(narratorMessages.role, "disp"),
						isNull(narratorMessageRefs.segmentCompactId),
						sql`NOT EXISTS (
						SELECT 1
						FROM json_each(${narratorMessages.contentJson}) AS compact_block
						WHERE json_extract(compact_block.value, '$.type') = 'compact'
					)`,
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(boundedLimit + 1),
			{ site: "narrator-messages.getContextAskHistorySnapshot" },
		);

		const hasMore = rawRefRows.length > boundedLimit;
		const refRows = rawRefRows.slice(0, boundedLimit).reverse();
		if (refRows.length === 0) {
			return {
				messages: [],
				hasMore: false,
				sourceTruncated: false,
				toolCallsTruncated: false,
				sourceBytes: 0,
			};
		}

		const messageIds = refRows.map((row) => row.messageId);
		const messageRows = await readQuery(
			db
				.select({
					id: narratorMessages.id,
					role: narratorMessages.role,
					contentText: sql<string | null>`CASE
					WHEN ${narratorMessages.contentText} IS NULL THEN NULL
					ELSE substr(${narratorMessages.contentText}, 1, ${CONTEXT_ASK_MESSAGE_TEXT_LIMIT})
				END`,
					contentTruncated: sql<number>`CASE
					WHEN length(COALESCE(${narratorMessages.contentText}, '')) > ${CONTEXT_ASK_MESSAGE_TEXT_LIMIT}
					THEN 1 ELSE 0
				END`,
				})
				.from(narratorMessages)
				.where(inArray(narratorMessages.id, messageIds)),
			{ site: "narrator-messages.getContextAskHistorySnapshot" },
		);

		const missingMessages = messageRows.length !== refRows.length;
		if (missingMessages) {
			const foundIds = new Set(messageRows.map((message) => message.id));
			logger.warn("ContextAsk refs point to missing messages", {
				narratorId,
				refCount: refRows.length,
				messageCount: messageRows.length,
				missingMessageIds: messageIds.filter((id) => !foundIds.has(id)).slice(0, 20),
			});
		}

		const rawToolRows = await readQuery(
			db
				.select({
					messageId: narratorToolCalls.messageId,
					toolUseId: narratorToolCalls.toolUseId,
					toolName: narratorToolCalls.toolName,
					status: narratorToolCalls.status,
					inputText: sql<string | null>`CASE
					WHEN ${narratorToolCalls.inputJson} IS NULL THEN NULL
					ELSE substr(CAST(${narratorToolCalls.inputJson} AS TEXT), 1, ${CONTEXT_ASK_TOOL_INPUT_LIMIT})
				END`,
					outputText: sql<string | null>`CASE
					WHEN ${narratorToolCalls.outputJson} IS NULL THEN NULL
					ELSE substr(CAST(${narratorToolCalls.outputJson} AS TEXT), 1, ${CONTEXT_ASK_TOOL_OUTPUT_LIMIT})
				END`,
					inputTruncated: sql<number>`CASE
					WHEN ${narratorToolCalls.inputJson} IS NOT NULL
						AND length(CAST(${narratorToolCalls.inputJson} AS TEXT)) > ${CONTEXT_ASK_TOOL_INPUT_LIMIT}
					THEN 1 ELSE 0
				END`,
					outputTruncated: sql<number>`CASE
					WHEN ${narratorToolCalls.outputJson} IS NOT NULL
						AND length(CAST(${narratorToolCalls.outputJson} AS TEXT)) > ${CONTEXT_ASK_TOOL_OUTPUT_LIMIT}
					THEN 1 ELSE 0
				END`,
				})
				.from(narratorToolCalls)
				.where(inArray(narratorToolCalls.messageId, messageIds))
				.orderBy(sql`${narratorToolCalls.createdAt} DESC`)
				.limit(CONTEXT_ASK_TOOL_CALL_LIMIT + 1),
			{ site: "narrator-messages.getContextAskHistorySnapshot" },
		);

		const toolCallsTruncated = rawToolRows.length > CONTEXT_ASK_TOOL_CALL_LIMIT;
		const toolCallsByMessage = new Map<string, ContextAskToolCallSnapshot[]>();
		for (const row of rawToolRows.slice(0, CONTEXT_ASK_TOOL_CALL_LIMIT).reverse()) {
			if (!row.messageId) continue;
			const toolCall: ContextAskToolCallSnapshot = {
				toolUseId: row.toolUseId,
				toolName: row.toolName,
				status: row.status,
				inputText: row.inputText,
				outputText: row.outputText,
				inputTruncated: row.inputTruncated === 1,
				outputTruncated: row.outputTruncated === 1,
			};
			const existing = toolCallsByMessage.get(row.messageId);
			if (existing) existing.push(toolCall);
			else toolCallsByMessage.set(row.messageId, [toolCall]);
		}

		const rowById = new Map(messageRows.map((row) => [row.id, row]));
		const candidates: ContextAskMessageSnapshot[] = [];
		let perMessageToolCallsTruncated = false;
		for (const ref of refRows) {
			const row = rowById.get(ref.messageId);
			if (!row) continue;
			const allToolCalls = toolCallsByMessage.get(row.id) ?? [];
			const omittedToolCalls = Math.max(
				0,
				allToolCalls.length - CONTEXT_ASK_TOOL_CALLS_PER_MESSAGE_LIMIT,
			);
			if (omittedToolCalls > 0) perMessageToolCallsTruncated = true;
			candidates.push({
				id: row.id,
				seq: ref.seq,
				role: row.role,
				contentText: row.contentText,
				contentTruncated: row.contentTruncated === 1,
				toolCalls: allToolCalls.slice(-CONTEXT_ASK_TOOL_CALLS_PER_MESSAGE_LIMIT),
				omittedToolCalls,
			});
		}

		const messages: ContextAskMessageSnapshot[] = [];
		let sourceBytes = 0;
		let byteTruncated = false;
		for (let index = candidates.length - 1; index >= 0; index--) {
			const message = candidates[index];
			const messageBytes = contextAskUtf8Length(message);
			if (messages.length > 0 && sourceBytes + messageBytes > CONTEXT_ASK_SOURCE_BYTE_LIMIT) {
				byteTruncated = true;
				break;
			}
			messages.unshift(message);
			sourceBytes += messageBytes;
		}

		const fieldTruncated = messages.some(
			(message) =>
				message.contentTruncated ||
				message.omittedToolCalls > 0 ||
				message.toolCalls.some((toolCall) => toolCall.inputTruncated || toolCall.outputTruncated),
		);
		return {
			messages,
			hasMore: hasMore || byteTruncated,
			sourceTruncated:
				hasMore ||
				missingMessages ||
				toolCallsTruncated ||
				perMessageToolCallsTruncated ||
				byteTruncated ||
				fieldTruncated,
			toolCallsTruncated: toolCallsTruncated || perMessageToolCallsTruncated,
			sourceBytes,
		};
	},

	/**
	 * Load only the fields required to rebuild provider history.
	 *
	 * This is deliberately separate from getMessagesSinceLastCompact: the latter
	 * remains the complete row shape used by display/compatibility paths, while the
	 * agent loop does not need audit, billing, permission timeline, or UI metadata.
	 */
	async getModelHistorySinceLastCompact(
		narratorId: string,
		limit?: number,
		options: Omit<LoadModelHistoryOptions, "limit"> = {},
	) {
		const postgres = modelHistoryDatabase.postgresRuntime;
		if (
			modelHistoryDatabase.activeDatabaseBackend === "postgres" &&
			(!postgres || !modelHistoryDatabase.activePostgresReadUrl)
		)
			throw new Error("Model history PostgreSQL read source is unavailable");
		const backend =
			modelHistoryDatabase.activeDatabaseBackend === "postgres" && postgres
				? {
						backend: "postgres" as const,
						sql: postgres.client.sql,
						url: modelHistoryDatabase.activePostgresReadUrl ?? "",
					}
				: { backend: "sqlite" as const, sqlite: modelHistoryDatabase.sqlite };
		const source = await loadModelHistorySource(backend, narratorId, { ...options, limit });
		// Lifecycle/metadata-only rows are control-plane data, never provider boundaries.
		return source.messages
			.filter(
				(message) =>
					!isCompactLifecycleMessage(message) &&
					!isMetadataOnlyEmptyReasoningAssistantMessage(message),
			)
			.map((message) => ({
				...message,
				toolCalls: latestToolCallAttempts(message.toolCalls),
			}));
	},

	async getMessagesBefore(narratorId: string, beforeMessageId: string) {
		const targetRef = await readQuery(
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, beforeMessageId),
				),
			}),
			{ site: "narrator-messages.getMessagesBefore" },
		);
		if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

		const lastCompactRow = await readQuery(
			db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.isCompact, 1),
						lt(narratorMessageRefs.seq, targetRef.seq),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1),
			{ site: "narrator-messages.getMessagesBefore" },
		);

		const compactSeq = lastCompactRow[0]?.seq;
		const lowerBound = compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : sql`1=1`;

		const refRows = await readQuery(
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						lowerBound,
						lt(narratorMessageRefs.seq, targetRef.seq),
						isNull(narratorMessageRefs.segmentCompactId),
					),
				)
				.orderBy(narratorMessageRefs.seq),
			{ site: "narrator-messages.getMessagesBefore" },
		);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await readQuery(
			db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, messageIds),
				with: {
					toolCalls: true,
					creator: { columns: { username: true } },
					narrator: { columns: { title: true } },
				},
			}),
			{ site: "narrator-messages.getMessagesBefore" },
		);

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		// A failed earlier compact marker may sit inside this retry range. Keep it
		// visible in the transcript, but never summarize it into a later compact.
		const compactableMessages = messages.filter((message) => !isCompactLifecycleMessage(message));
		return compactableMessages.map((message) => ({
			...message,
			toolCalls: latestToolCallAttempts(message.toolCalls),
		}));
	},

	async getEarliestMessages(narratorId: string, limit = 2) {
		const rows = await readQuery(
			db
				.select({
					id: narratorMessages.id,
					narratorId: narratorMessages.narratorId,
					role: narratorMessages.role,
					contentJson: narratorMessages.contentJson,
					contentText: narratorMessages.contentText,
					createdAt: narratorMessages.createdAt,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessages.role, ["user", "assistant"]),
						isNotNull(narratorMessages.contentText),
					),
				)
				.orderBy(narratorMessageRefs.seq)
				.limit(limit),
			{ site: "narrator-messages.getEarliestMessages" },
		);
		return rows;
	},

	/** The session's own user/assistant turns since its last compact (`isTopLevelMessage`). */
	async _getPostCompactTopLevelRefs(narratorId: string) {
		const ownTurn = ownTurnSql(await this.ownTurnPlacement(narratorId));

		const lastCompactRow = await readQuery(
			db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1),
			{ site: "narrator-messages._getPostCompactTopLevelRefs" },
		);

		const compactSeq = lastCompactRow[0]?.seq;

		return await readQuery(
			db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
						inArray(narratorMessages.role, ["user", "assistant"]),
						isNull(narratorMessageRefs.segmentCompactId),
						ownTurn,
					),
				)
				.orderBy(narratorMessageRefs.seq),
			{ site: "narrator-messages._getPostCompactTopLevelRefs" },
		);
	},

	async getCompactBoundaryMessage(narratorId: string, keepPairs = 2): Promise<string | null> {
		const refs = await this._getPostCompactTopLevelRefs(narratorId);
		const keepCount = Math.max(1, Math.floor(keepPairs)) * 2;
		if (refs.length < keepCount + 2) return null;
		const boundaryRef = refs[refs.length - keepCount];
		return boundaryRef.messageId;
	},

	/**
	 * Emergency compact boundary used by context-overflow recovery.
	 *
	 * Unlike getCompactBoundaryMessage, this ignores the configured keepPairs and
	 * compacts everything except the most recent top-level message so that even a
	 * conversation with only a handful of messages (e.g. a single oversized
	 * message that blew the context window) still has something to summarize.
	 *
	 * Returns null only when there is genuinely nothing to compact (0 or 1
	 * post-compact messages), in which case no summary can reduce the context.
	 */
	async getEmergencyCompactBoundaryMessage(narratorId: string): Promise<string | null> {
		const refs = await this._getPostCompactTopLevelRefs(narratorId);
		// Need at least 2 messages: one to summarize + one to keep as the boundary.
		if (refs.length < 2) return null;
		// Keep only the most recent message; compact everything before it.
		const boundaryRef = refs[refs.length - 1];
		return boundaryRef.messageId;
	},

	async getRecentMessages(narratorId: string, limit = 4) {
		const rows = await readQuery(
			db
				.select({
					id: narratorMessages.id,
					narratorId: narratorMessages.narratorId,
					role: narratorMessages.role,
					contentJson: narratorMessages.contentJson,
					contentText: narratorMessages.contentText,
					createdAt: narratorMessages.createdAt,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessages.role, ["user", "assistant"]),
						isNotNull(narratorMessages.contentText),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(limit),
			{ site: "narrator-messages.getRecentMessages" },
		);
		return rows.reverse();
	},

	/**
	 * Find the most recent assistant message that carries real text content,
	 * WITHOUT the compact-boundary restriction of getModelHistorySinceLastCompact.
	 *
	 * Needed because a background/mid-turn compact that finishes right before the
	 * subagent stops leaves the compact marker at the tail (highest seq). In that
	 * window getModelHistorySinceLastCompact() returns an empty set, so callers
	 * that derive the subagent's final answer (getSubagentFinalText /
	 * getSubagentResultMessageId) would wrongly see "(no output)". This query
	 * looks back across the boundary to recover the last thing the agent said.
	 *
	 * Bounded like getRecentMessages: narrow columns, seq DESC, small LIMIT. The
	 * first assistant message with non-empty text wins; the small limit guards
	 * against a short run of assistant messages that are tool-call-only.
	 */
	async getLatestAssistantTextAndId(
		narratorId: string,
		scanLimit = 10,
	): Promise<{ id: string; text: string } | null> {
		const rows = await readQuery(
			db
				.select({
					id: narratorMessages.id,
					contentJson: narratorMessages.contentJson,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessages.role, "assistant"),
						isNotNull(narratorMessages.contentText),
						isNull(narratorMessageRefs.segmentCompactId),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(Math.max(1, Math.floor(scanLimit))),
			{ site: "narrator-messages.getLatestAssistantTextAndId" },
		);

		for (const row of rows) {
			const blocks = Array.isArray(row.contentJson)
				? (row.contentJson as Array<{ type: string; text?: string }>)
				: [];
			const text = blocks
				.filter((b) => b.type === "text" && b.text)
				.map((b) => b.text ?? "")
				.join("\n");
			if (text.trim()) return { id: row.id, text };
		}
		return null;
	},

	/**
	 * Return the summary and message id of the most recent SUCCESSFUL compact
	 * marker (isCompact=1), or null if none. Used as a fallback conclusion when a
	 * subagent stops immediately after a compact and has no post-compact assistant
	 * text — the compact summary is the best available description of its work.
	 */
	async getLatestSuccessfulCompactSummary(
		narratorId: string,
	): Promise<{ id: string; summary: string } | null> {
		const rows = await readQuery(
			db
				.select({
					id: narratorMessages.id,
					contentJson: narratorMessages.contentJson,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1),
			{ site: "narrator-messages.getLatestSuccessfulCompactSummary" },
		);

		const row = rows[0];
		if (!row) return null;
		const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
		const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
		const summary = typeof compactBlock?.summary === "string" ? compactBlock.summary : "";
		if (!summary.trim()) return null;
		return { id: row.id, summary };
	},

	/**
	 * Bounded recovery scan for timelines that cannot paginate because one message
	 * blew past the history-aggregation budget. Deliberately SQL-level only: no
	 * content_json parse, no tool I/O, and never through resolveAggregateScopeTx —
	 * that is the very path which is already throwing.
	 */
	async getHistoryRecovery(narratorId: string): Promise<{
		candidates: Array<{
			messageId: string;
			seq: number;
			role: string;
			createdAt: string;
			toolCount: number;
			byteSize: number;
			preview: string | null;
			latest: boolean;
		}>;
		thresholds: { toolCount: number; byteSize: number };
	}> {
		const toolCount = sql<number>`(
			SELECT COUNT(*) FROM narrator_tool_calls
			WHERE narrator_tool_calls.message_id = ${narratorMessages.id}
				AND narrator_tool_calls.is_file_history_checkpoint = 0
		)`;
		const byteSize = sql<number>`length(CAST(${narratorMessages.contentJson} AS BLOB))`;
		const rows = await readQuery(
			db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					role: narratorMessages.role,
					createdAt: narratorMessages.createdAt,
					toolCount,
					byteSize,
					preview: sql<
						string | null
					>`substr(COALESCE(${narratorMessages.contentText}, ''), 1, 160)`,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						isNull(narratorMessageRefs.segmentCompactId),
						sql`(
						(SELECT COUNT(*) FROM narrator_tool_calls
						 WHERE narrator_tool_calls.message_id = ${narratorMessages.id}
						   AND narrator_tool_calls.is_file_history_checkpoint = 0)
						> ${HISTORY_RECOVERY_TOOL_COUNT}
						OR length(CAST(${narratorMessages.contentJson} AS BLOB)) > ${HISTORY_RECOVERY_BYTE_SIZE}
					)`,
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(HISTORY_RECOVERY_CANDIDATES),
			{ site: "narrator-messages.getHistoryRecovery" },
		);
		const maxSeqRow = await readQuery(
			db
				.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						isNull(narratorMessageRefs.segmentCompactId),
					),
				),
			{ site: "narrator-messages.getHistoryRecovery" },
		);
		const maxSeq = maxSeqRow[0]?.maxSeq ?? null;
		return {
			candidates: rows.map((row) => ({
				...row,
				latest: row.seq === maxSeq,
			})),
			thresholds: {
				toolCount: HISTORY_RECOVERY_TOOL_COUNT,
				byteSize: HISTORY_RECOVERY_BYTE_SIZE,
			},
		};
	},

	/**
	 * Where this session's own turns are placed (`ownTurnPlacementOf`): the tool call its
	 * run delivers to, `null` for none.
	 */
	async ownTurnPlacement(narratorId: string): Promise<OwnTurnPlacement> {
		const narrator = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: RUNTIME_SOURCE_COLUMNS,
			}),
			{ site: "narrator-messages.ownTurnPlacement" },
		);
		return narrator ? ownTurnPlacementOf(narrator) : null;
	},

	/**
	 * The monotonic message version for a narrator, used by the WS sync protocol
	 * (sync_check / subscribe short-circuit) to decide whether a client is already
	 * up to date and can skip a full catch-up query.
	 *
	 * IMPLICIT CONTRACT — every persistence path that bumps `messageVersion` MUST
	 * also emit a matching realtime broadcast (message / message_updated /
	 * messages_deleted / compact / …). The sync protocol treats an unchanged
	 * version as "nothing to replay", so a version bump WITHOUT a broadcast would
	 * silently strand the client on the old view until its next focus sync_check.
	 * The inverse (broadcast without a version bump) is fine — it just means an
	 * extra sync_check may return catch_up. When adding a new write path, keep the
	 * "bump version ⟺ broadcast" pairing intact.
	 */
	async getMessageVersion(
		narratorId: string,
		signal?: AbortSignal,
		deadlineAt?: number,
	): Promise<number> {
		const row = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { messageVersion: true },
			}),
			{
				site: "narrator-messages.getMessageVersion",
				signal,
				timeoutMs: deadlineAt == null ? undefined : Math.max(1, deadlineAt - Date.now()),
			},
		);
		return row?.messageVersion ?? 0;
	},

	/**
	 * Resolve a message id to the top-level seq used by the chunk manifest.
	 *
	 * This is the lightweight replacement for the old around-window query: it only
	 * reads narrow indexed columns and never returns content_json/message trees.
	 * A session's own turns (`isTopLevelMessage`: no placement, or placed under the
	 * tool call its run delivers to) are their own location. A nested message is
	 * resolved by walking parent tool-use ownership until a referenced top-level
	 * message is found.
	 */
	async getMessageLocation(
		narratorId: string,
		messageId: string,
	): Promise<{
		messageId: string;
		topLevelMessageId: string;
		seq: number;
	}> {
		const [placement, target] = await Promise.all([
			this.ownTurnPlacement(narratorId),
			readQuery(
				db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, messageId),
					columns: { id: true, parentToolUseId: true },
				}),
				{ site: "narrator-messages.getMessageLocation" },
			),
		]);
		if (!target) throw new NotFoundError("Message", messageId);

		// Jumping to a message (from search, or a citation) may target history a lazy
		// fork has not materialized yet. Resolve it against the lineage and pull in
		// everything down to it, so the location — and the surrounding page the client
		// fetches next — actually exist locally.
		await ensureRefsCoverMessage(narratorId, messageId);

		const findVisibleRef = (candidateMessageId: string) =>
			readQuery(
				db.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, candidateMessageId),
						isNull(narratorMessageRefs.segmentCompactId),
					),
					columns: { seq: true },
				}),
				{ site: "narrator-messages.findVisibleRef" },
			);

		const directRef = await findVisibleRef(target.id);
		if (directRef && isTopLevelMessage(target, placement)) {
			return { messageId: target.id, topLevelMessageId: target.id, seq: directRef.seq };
		}

		let parentToolUseId = target.parentToolUseId;
		for (let depth = 0; parentToolUseId && depth < 32; depth++) {
			const candidates = await readQuery(
				db
					.select({
						messageId: narratorToolCalls.messageId,
						parentToolUseId: narratorMessages.parentToolUseId,
						seq: narratorMessageRefs.seq,
					})
					.from(narratorToolCalls)
					.innerJoin(narratorMessages, eq(narratorToolCalls.messageId, narratorMessages.id))
					.innerJoin(
						narratorMessageRefs,
						and(
							eq(narratorToolCalls.messageId, narratorMessageRefs.messageId),
							eq(narratorMessageRefs.narratorId, narratorId),
							isNull(narratorMessageRefs.segmentCompactId),
						),
					)
					.where(eq(narratorToolCalls.toolUseId, parentToolUseId))
					.orderBy(narratorMessageRefs.seq)
					.limit(10),
				{ site: "narrator-messages.getMessageLocation" },
			);
			if (candidates.length === 0) break;

			let nextParentToolUseId: string | null = null;
			for (const candidate of candidates) {
				if (candidate.parentToolUseId) {
					nextParentToolUseId = candidate.parentToolUseId;
					continue;
				}
				return {
					messageId: target.id,
					topLevelMessageId: candidate.messageId,
					seq: candidate.seq,
				};
			}
			parentToolUseId = nextParentToolUseId;
		}

		if (directRef)
			return { messageId: target.id, topLevelMessageId: target.id, seq: directRef.seq };
		throw new NotFoundError("Message", messageId);
	},

	/**
	 * Exact-layout input page. This is a transport page only: it carries ordered
	 * full message trees and never defines a scrollbar unit or height estimate.
	 * The client must collect the complete document before committing a layout.
	 */
	async getPretextDocumentPage(
		narratorId: string,
		opts: {
			afterSeq?: number;
			beforeSeq?: number;
			limit?: number;
			messageVersion?: number;
			signal?: AbortSignal;
		} = {},
	) {
		const deadlineAt = Date.now() + 10_000;
		assertDisplayReadActive(opts.signal, deadlineAt);
		const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 100);
		// A lazy fork only materialized the refs after its parent's last compact.
		// Reading older than `beforeSeq` means reading rows BELOW it, so the backfill
		// must cover the whole requested page — and it must happen BEFORE the
		// messageVersion snapshot below: materializing refs bumps the version, and
		// the page's own consistency check would otherwise fire on the backfill it
		// itself triggered.
		if (opts.beforeSeq != null && Number.isFinite(opts.beforeSeq)) {
			await ensureRefsCoverSeq(narratorId, Math.trunc(opts.beforeSeq as number) - limit);
		}
		// The version check below is an optimistic-concurrency guard, and on a live
		// narrator it loses often: every committed block, tool completion and child
		// subagent row bumps `messageVersion`, while one page build awaits dozens of
		// reads. Surfacing each lost race as a 409 made the first screen of a running
		// narrator fail routinely. An unpinned read accepts drift that left its window
		// in place (see `assertDocumentUnchanged`) and rebuilds against the new
		// revision when the window moved — bounded by attempts and the shared
		// deadline. A pinned read (`opts.messageVersion`) still fails fast.
		const driftErrors = new WeakSet<AppError>();
		const markDrift = (error: AppError) => {
			driftErrors.add(error);
			return error;
		};
		const maxAttempts = opts.messageVersion == null ? PRETEXT_PAGE_DRIFT_ATTEMPTS : 1;
		const buildPage = async () => {
			const narratorMeta = await readQuery(
				db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { ...RUNTIME_SOURCE_COLUMNS, messageVersion: true },
				}),
				{
					site: "narrator-messages.pretextMetadata",
					signal: opts.signal,
					timeoutMs: Math.max(1, deadlineAt - Date.now()),
				},
			);
			const placement = narratorMeta ? ownTurnPlacementOf(narratorMeta) : null;
			const messageVersion = narratorMeta?.messageVersion ?? 0;
			if (opts.messageVersion != null && opts.messageVersion !== messageVersion)
				throw new AppError(
					"Narrator document changed before the exact-layout page was built",
					409,
					"PRETEXT_DOCUMENT_CHANGED",
				);
			// "Top-level message" is expressed as a correlated EXISTS rather than the
			// inner join this used to be, because the join form admitted a catastrophic
			// plan: SQLite drove from `narrator_messages` through
			// `idx_messages_parent_tool_use_lookup`, whose `parent_tool_use_id IS NULL`
			// predicate matches ~90% of all messages, re-looked-up every ref and sorted
			// the whole set in a temp B-tree merely to read the newest `limit` rows.
			// That is the FIRST request of every narrator open, and it measured 306ms
			// on a 131k-message library (p50 8.1s end to end in the logs).
			//
			// As EXISTS the planner walks `idx_narrator_refs_seq` in `seq DESC` order
			// and stops after `limit + 1` rows, since the subquery is answered by the
			// message primary key. Measured 0.07ms — row-for-row identical on the 12
			// largest narrators, for the tail page and the `beforeSeq` scroll-up page
			// alike. Deliberately NOT an `INDEXED BY` hint: this spelling needs no
			// SQLite-only syntax, so it stays off the dialect-migration ledger.
			// The session's own turns (`isTopLevelMessage`).
			const ownTurn = ownTurnSql(placement);
			const isTopLevelRef = (condition: SQL) =>
				exists(
					db
						.select({ one: sql`1` })
						.from(narratorMessages)
						.where(and(eq(narratorMessages.id, narratorMessageRefs.messageId), condition)),
				);
			const baseConditions = [
				eq(narratorMessageRefs.narratorId, narratorId),
				isNull(narratorMessageRefs.segmentCompactId),
				...(ownTurn ? [isTopLevelRef(ownTurn)] : []),
			];

			// `afterSeq` → ascending page after the cursor (kept for compatibility with
			// the legacy full-document loader/tests). Otherwise the newest `limit` rows
			// are taken descending and reversed to ascending: no argument = tail page
			// (first screen), `beforeSeq` = the page immediately older than that seq
			// (reverse infinite scroll toward the top).
			const ascending = opts.afterSeq != null && Number.isFinite(opts.afterSeq);
			const conditions = [...baseConditions];
			if (ascending) {
				conditions.push(gt(narratorMessageRefs.seq, Math.trunc(opts.afterSeq as number)));
			} else if (opts.beforeSeq != null && Number.isFinite(opts.beforeSeq)) {
				conditions.push(lt(narratorMessageRefs.seq, Math.trunc(opts.beforeSeq)));
			}

			const loadWindow = async () => {
				const refRows = await readQuery(
					db
						.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
						.from(narratorMessageRefs)
						.where(and(...conditions))
						.orderBy(ascending ? asc(narratorMessageRefs.seq) : desc(narratorMessageRefs.seq))
						.limit(limit + 1),
					{
						site: "narrator-messages.pretextWindow",
						signal: opts.signal,
						timeoutMs: Math.max(1, deadlineAt - Date.now()),
					},
				);
				const hasMoreInDirection = refRows.length > limit;
				const pageRows = hasMoreInDirection ? refRows.slice(0, limit) : refRows;
				// Descending queries return newest-first; flip to the ascending order the
				// exact-layout builder always consumes.
				if (!ascending) pageRows.reverse();
				return { pageRows, hasMoreInDirection };
			};
			const { pageRows, hasMoreInDirection } = await loadWindow();
			// Most version bumps on a live narrator rewrite bodies in place (a block
			// commit, a tool result, a child row's parent bump) and leave the page's
			// ordered top-level ids untouched. Such a page is not torn: its content is
			// at least as new as the snapshot it reports, and sync catch-up from that
			// snapshot replays the rest. So an unpinned read only rebuilds when the
			// window itself moved (insert, delete, compact). A pinned read is one page
			// of a multi-page walk and must observe exactly one revision.
			const assertDocumentUnchanged = async () => {
				assertDisplayReadActive(opts.signal, deadlineAt);
				if ((await this.getMessageVersion(narratorId, opts.signal, deadlineAt)) === messageVersion)
					return;
				const drift = () =>
					markDrift(
						new AppError(
							"Narrator document changed while the exact-layout page was being built",
							409,
							"PRETEXT_DOCUMENT_CHANGED",
						),
					);
				if (opts.messageVersion != null) throw drift();
				const current = await loadWindow();
				if (
					current.hasMoreInDirection !== hasMoreInDirection ||
					!sameTransportWindow(pageRows, current.pageRows)
				)
					throw drift();
			};

			if (pageRows.length === 0) {
				await assertDocumentUnchanged();
				// An empty window is NOT necessarily the start of history. A lazy fork's
				// ancestors can still hold older messages while this narrator has no visible
				// ref in the requested range — e.g. a segment-compact hole wider than one
				// page, which the backfill cursor skips past without copying anything. The
				// legacy chunk reader probed for that case; reporting `hasPrev: false` here
				// instead ends the client's upward scroll permanently (the loader latches it),
				// silently hiding history that does exist.
				const hasPrevBelowEmptyWindow =
					opts.beforeSeq != null && Number.isFinite(opts.beforeSeq)
						? await hasUnmaterializedRefsBelow(narratorId, Math.trunc(opts.beforeSeq))
						: false;
				return {
					messages: [],
					minSeq: null,
					maxSeq: null,
					// Mirrors the non-empty descending branch: a `beforeSeq` page is by
					// definition preceded by newer rows the caller already holds.
					hasNext: !ascending && opts.beforeSeq != null,
					hasPrev: hasPrevBelowEmptyWindow,
					messageVersion,
				};
			}

			// Transport-only projections, applied AFTER enrichment so both are safe: the
			// tool rows are pure duplicates of the enriched blocks, and `providerMetadata`
			// is replay state the browser can neither display nor send back (its one
			// display-relevant bit is preserved as a flag). Together they removed ~46% of
			// the page on the six largest narrators measured.
			const tree = stripProviderMetadata(
				stripRedundantToolCallRows(
					await buildTreeFromTopLevelRefs(
						narratorId,
						pageRows,
						placement,
						// The ONLY path whose bodies are measured for the exact layout: the budget
						// must fill the detail caps, or a card reserves a box it cannot fill.
						EXACT_TOOL_IO_BUDGET,
						opts.signal,
						deadlineAt,
					),
				),
			);
			const minSeq = pageRows[0]?.seq ?? null;
			const maxSeq = pageRows.at(-1)?.seq ?? null;

			let hasPrev: boolean;
			let hasNext: boolean;
			// A lazy fork can be out of local refs while its parent still holds older
			// history, so "no more rows here" is not the same as "start of history" —
			// the lazy-aware probe keeps hasPrev true until the lineage is exhausted.
			const probeUnmaterializedBelow = async (): Promise<boolean> =>
				minSeq != null && (await hasUnmaterializedRefsBelow(narratorId, minSeq));
			if (ascending) {
				// Ascending page after `afterSeq`: more-in-direction means newer rows
				// remain; probe once (indexed LIMIT 1) for anything older than the window.
				hasNext = hasMoreInDirection;
				hasPrev =
					(minSeq != null &&
						(
							await readQuery(
								db
									.select({ seq: narratorMessageRefs.seq })
									.from(narratorMessageRefs)
									.innerJoin(
										narratorMessages,
										eq(narratorMessageRefs.messageId, narratorMessages.id),
									)
									.where(and(...baseConditions, lt(narratorMessageRefs.seq, minSeq)))
									.limit(1),
								{
									site: "narrator-messages.pretextPrevious",
									signal: opts.signal,
									timeoutMs: Math.max(1, deadlineAt - Date.now()),
								},
							)
						).length > 0) ||
					(await probeUnmaterializedBelow());
			} else {
				// Descending newest page: more-in-direction means older rows remain. The
				// tail page has nothing newer; a `beforeSeq` page is by definition
				// preceded by the newer rows the caller already holds.
				hasPrev = hasMoreInDirection || (await probeUnmaterializedBelow());
				hasNext = opts.beforeSeq != null;
			}

			await assertDocumentUnchanged();
			return { messages: tree, minSeq, maxSeq, hasNext, hasPrev, messageVersion };
		};
		for (let attempt = 1; ; attempt++) {
			try {
				return await buildPage();
			} catch (error) {
				assertDisplayReadActive(opts.signal, deadlineAt);
				if (!(error instanceof AppError) || !driftErrors.has(error) || attempt >= maxAttempts)
					throw error;
			}
			await waitForPretextDriftRetry(attempt, opts.signal, deadlineAt);
		}
	},

	async getMessagesAfter(narratorId: string, after: CatchUpCursor, limit = 200) {
		const placement = await this.ownTurnPlacement(narratorId);
		const ownTurn = ownTurnSql(placement);
		const inputCursor: CatchUpCursor = after;

		let parentAnchorSeq: number | null = null;
		let parentLastMessageId = inputCursor.parentLastMessageId;
		const baseChildAnchors = new Map<string, CatchUpChildAnchor>();

		async function addOpenAnchorsForMessage(messageId: string) {
			const rows = await readQuery(
				db.query.narratorToolCalls.findMany({
					where: eq(narratorToolCalls.messageId, messageId),
					columns: { toolUseId: true },
					limit: AGGREGATE_METADATA_LIMIT + 1,
				}),
				{ site: "narrator-messages.addOpenAnchorsForMessage" },
			);
			assertAggregateBudget(rows.length);
			for (const row of rows) {
				upsertCursorChildAnchor(baseChildAnchors, { parentToolUseId: row.toolUseId });
			}
		}

		if (parentLastMessageId) {
			const parentRef = await readQuery(
				db.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, parentLastMessageId),
					),
					columns: { seq: true },
				}),
				{ site: "narrator-messages.getMessagesAfter" },
			);
			const parentMessage = await readQuery(
				db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, parentLastMessageId),
					columns: { narratorId: true, parentToolUseId: true },
				}),
				{ site: "narrator-messages.getMessagesAfter" },
			);
			if (parentMessage?.parentToolUseId && !isTopLevelMessage(parentMessage, placement)) {
				const childAnchorMessageId = parentLastMessageId;
				const scope = await readTransactionTask(
					db,
					{
						kind: "narrator-read-transaction-v1",
						operation: "aggregateScope",
						narratorId: narratorId,
						ids: [parentMessage.parentToolUseId as string],
					},
					() =>
						db.transaction((tx) =>
							resolveAggregateScopeTx(tx, narratorId, [parentMessage.parentToolUseId as string]),
						),
					{ site: "narrator-messages.aggregateScope" },
				);
				const toolParent = scope.parents.get(parentMessage.parentToolUseId);
				const visibleInline = scope.inlineRows.some((row) => row.id === childAnchorMessageId);
				const visibleSubagent = scope.owners.some(
					(owner) => owner.subagentNarratorId === parentMessage.narratorId,
				);
				if (toolParent && (visibleInline || visibleSubagent)) {
					parentAnchorSeq = toolParent.callerSeq;
					parentLastMessageId = toolParent.messageId;
					upsertCursorChildAnchor(baseChildAnchors, {
						parentToolUseId: parentMessage.parentToolUseId,
						narratorId,
						lastMessageId: visibleInline ? childAnchorMessageId : undefined,
					});
				}
			} else if (parentRef) {
				parentAnchorSeq = parentRef.seq;
				await addOpenAnchorsForMessage(parentLastMessageId);
			}
		}

		for (const anchor of inputCursor.childAnchors ?? []) {
			if (anchor.parentToolUseId) upsertCursorChildAnchor(baseChildAnchors, anchor);
		}

		const resolvedAnchors = await resolveCatchUpChildAnchors(
			narratorId,
			trimCursorChildAnchors(baseChildAnchors),
		);
		const resolvedChildAnchors = resolvedAnchors.messageAnchors;
		const cursorChildAnchors = trimCursorChildAnchors(
			new Map<string, CatchUpChildAnchor>([
				...[...resolvedChildAnchors].map(
					([toolUseId, { seq: _seq, ...anchor }]) => [toolUseId, anchor] as const,
				),
				...resolvedAnchors.subagentAnchors,
			]),
		);
		const subagentActivities = await loadSubagentActivityCatchUp(narratorId, [
			...resolvedAnchors.subagentAnchors.keys(),
		]);

		if (parentAnchorSeq == null && resolvedChildAnchors.size === 0) {
			if (subagentActivities.length > 0) {
				return {
					topLevel: [],
					orphanChildren: [],
					subagentActivities,
					hitLimit: false,
					cursor: buildCatchUpCursor({
						parentLastMessageId,
						baseChildAnchors: cursorChildAnchors,
						topMessages: [],
						childMessages: [],
					}),
				};
			}
			return { topLevel: [], orphanChildren: [], subagentActivities, hitLimit: true };
		}

		const childWhere = combineOrConditions(
			[...resolvedChildAnchors.values()].map((anchor) => childCatchUpCondition(anchor)),
		);

		// Fetch ref rows directly with LIMIT (limit + 1) instead of running a
		// full count(*) first. If either stream returns more than `limit` rows we
		// already know we're over the threshold, so we can short-circuit to a
		// full reload without reading any large message payloads. This avoids the
		// expensive count(*) range scan when the catch-up anchor is far behind.
		let refRows: Array<{ messageId: string; seq: number }> = [];
		if (parentAnchorSeq != null) {
			const rowConditions = [
				eq(narratorMessageRefs.narratorId, narratorId),
				gt(narratorMessageRefs.seq, parentAnchorSeq),
				isNull(narratorMessageRefs.segmentCompactId),
			];
			if (ownTurn) rowConditions.push(ownTurn);
			refRows = await readQuery(
				db
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
					})
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(and(...rowConditions))
					.orderBy(sql`${narratorMessageRefs.seq} ASC`)
					.limit(limit + 1),
				{ site: "narrator-messages.getMessagesAfter" },
			);
		}

		const childRefRows: Array<{ messageId: string; seq: number }> = childWhere
			? await readQuery(
					db
						.select({
							messageId: narratorMessageRefs.messageId,
							seq: narratorMessageRefs.seq,
						})
						.from(narratorMessageRefs)
						.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
						.where(childWhere)
						.orderBy(sql`${narratorMessageRefs.seq} ASC`)
						.limit(limit + 1),
					{ site: "narrator-messages.getMessagesAfter" },
				)
			: [];

		if (refRows.length === 0 && childRefRows.length === 0) {
			const cursor = buildCatchUpCursor({
				parentLastMessageId,
				baseChildAnchors: cursorChildAnchors,
				topMessages: [],
				childMessages: [],
			});
			return { topLevel: [], orphanChildren: [], subagentActivities, hitLimit: false, cursor };
		}

		// Either stream returning more than `limit` rows means we're past the
		// catch-up threshold. Short-circuit to a full reload before reading any
		// large message payloads (content_json / input_json / output_json).
		if (refRows.length + childRefRows.length > limit) {
			return { topLevel: [], orphanChildren: [], subagentActivities, hitLimit: true };
		}

		const allRefRows = [...refRows, ...childRefRows];
		const messageIds = [...new Set(allRefRows.map((r) => r.messageId))];
		const allMessages = await loadAggregateRefMessages(narratorId, messageIds);

		const seqMap = new Map(allRefRows.map((r) => [r.messageId, r.seq]));
		allMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		attachMessageSeqs(allMessages, seqMap);

		const topMsgs = [] as typeof allMessages;
		const childMsgs = [] as typeof allMessages;
		for (const msg of allMessages) {
			if (isTopLevelMessage(msg, placement)) {
				msg.parentToolUseId = null;
				topMsgs.push(msg);
			} else {
				childMsgs.push(msg);
			}
		}

		const newTopToolUseIds = collectToolUseIds(topMsgs);
		const newTopSubagentToolUseIdSet = new Set(collectSubagentToolUseIds(topMsgs));
		const inlineTopToolUseIds = newTopToolUseIds.filter(
			(toolUseId) => !newTopSubagentToolUseIdSet.has(toolUseId),
		);
		const existingChildIds = new Set(childMsgs.map((m) => m.id));
		if (inlineTopToolUseIds.length > 0) {
			const extraChildren = await loadAggregateInlineMessages(narratorId, inlineTopToolUseIds);
			for (const child of extraChildren) {
				if (!existingChildIds.has(child.id)) childMsgs.push(child);
			}
		}

		const topActivities = await loadSubagentActivitiesForToolUseIds(narratorId, [
			...newTopSubagentToolUseIdSet,
		]);
		attachSubagentActivities(topMsgs, topActivities);
		const awaitAgentIds = await resolveAwaitAgentIdsForMessages([...topMsgs, ...childMsgs]);
		const takenOverToolUseIds = collectTakenOverToolUseIds(topActivities, awaitAgentIds);
		const tree = attachActiveSendDeliveryTargets(
			attachTakenOverFlags(
				attachAwaitAgentNarratorIds(
					enrichToolUseBlocks(
						filterExitPlanBeforePlanCompact(
							truncateToolIO(buildMessageTree([...topMsgs, ...childMsgs])),
						),
					),
					awaitAgentIds,
				),
				takenOverToolUseIds,
			),
		);

		const newTopToolUseIdSet = new Set(newTopToolUseIds);
		const candidateOrphans = [] as typeof childMsgs;
		for (const child of childMsgs) {
			if (!child.parentToolUseId) continue;
			if (!newTopToolUseIdSet.has(child.parentToolUseId)) candidateOrphans.push(child);
		}

		const orphanChildren = candidateOrphans.map((c) => ({ ...c, children: [] }));
		const lastTopMessageId = topMsgs[topMsgs.length - 1]?.id ?? parentLastMessageId;
		const cursor = buildCatchUpCursor({
			parentLastMessageId: lastTopMessageId,
			baseChildAnchors: cursorChildAnchors,
			topMessages: topMsgs,
			childMessages: childMsgs,
		});

		return {
			topLevel: await attachSendTargetDetails(tree),
			orphanChildren: await attachSendTargetDetails(
				attachActiveSendDeliveryTargets(
					attachTakenOverFlags(
						attachAwaitAgentNarratorIds(
							enrichToolUseBlocks(truncateToolIO(orphanChildren)),
							awaitAgentIds,
						),
						takenOverToolUseIds,
					),
				),
			),
			subagentActivities,
			hitLimit: false,
			cursor,
		};
	},

	async getToolCallDetail(narratorId: string, toolUseId: string, reference?: ToolDetailReference) {
		return await readTransactionTask(
			db,
			{
				kind: "narrator-read-transaction-v1",
				operation: "toolDetail",
				narratorId: narratorId,
				toolUseId: toolUseId,
				reference: reference,
			},
			() => db.transaction((tx) => getToolCallDetailTx(tx, narratorId, toolUseId, reference)),
			{ site: "narrator-messages.toolDetail" },
		);
	},

	async getToolCallPreviewMetadata(
		narratorId: string,
		toolUseId: string,
		reference?: ToolDetailReference,
	) {
		return readTransactionTask(
			db,
			{
				kind: "narrator-read-transaction-v1",
				operation: "toolPreview",
				narratorId,
				toolUseId,
				reference,
			},
			() => db.transaction((tx) => getToolCallPreviewTx(tx, narratorId, toolUseId, reference)),
			{ site: "narrator-messages.toolPreview" },
		);
	},

	async getCompactSummary(narratorId: string, messageId: string) {
		const summary = await readTransactionTask(
			db,
			{ kind: "narrator-read-transaction-v1", operation: "compactSummary", narratorId, messageId },
			() => db.transaction((tx) => getCompactSummaryTx(tx, narratorId, messageId)),
			{ site: "narrator-messages.compactSummary" },
		);
		const live = summary.status === "compacting" ? liveCompactProgress.get(messageId) : undefined;
		return live
			? {
					...summary,
					model: live.model || summary.model,
					reasoningEffort: live.reasoningEffort,
					startedAt: live.startedAt,
					output: live.output,
					thinking: live.thinking,
					outputChars: live.outputChars,
					thinkingChars: live.thinkingChars,
					outputTruncated: live.outputTruncated,
					thinkingTruncated: live.thinkingTruncated,
				}
			: summary;
	},

	async deleteCompactMessage(narratorId: string, messageId: string) {
		const result = db.transaction((tx) => {
			// Resolve the message through the caller-owned ref. The message owner is
			// intentionally ignored because forked narrators share immutable history.
			const currentRef = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				})
				.sync();
			const msg = tx.query.narratorMessages
				.findFirst({
					where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
				})
				.sync();
			if (!msg || !currentRef) throw new NotFoundError("Message", messageId);

			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
			if (!compactBlock) throw new ValidationError("Message is not a compact message");
			if (compactBlock.status === "compacting") {
				throw new AppError(
					"A running compact must be cancelled before its marker can be deleted",
					409,
					"COMPACT_IN_PROGRESS",
				);
			}

			const previousCompact = tx
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.isCompact, 1),
						lt(narratorMessageRefs.seq, currentRef.seq),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1)
				.all();

			// Delete only this narrator's ref. A sibling fork keeps its own view of
			// the shared marker and its message row remains alive while referenced.
			deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.id, currentRef.id)).run();
			const remainingRef = tx.query.narratorMessageRefs
				.findFirst({ where: eq(narratorMessageRefs.messageId, messageId) })
				.sync();
			if (!remainingRef) {
				tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId)).run();
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}

			const now = new Date().toISOString();
			tx.update(narrators)
				.set({
					...(compactBlock.status === "compacted"
						? {
								contextSummary: null,
								contextSummaryChars: 0,
								apiConversationId: null,
							}
						: {}),
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			return {
				previousCompactExists: compactBlock.status === "compacted" && previousCompact.length > 0,
			};
		});
		queueContextCharacterRefresh(narratorId);
		return result;
	},

	async deleteMessage(
		narratorId: string,
		messageId: string,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) {
		const result = await deleteMessageRange(narratorId, messageId, true, opts);
		return {
			deletedCount: result.deletedCount,
			...(result.historyWarnings ? { historyWarnings: result.historyWarnings } : {}),
			...(result.archivedSubagentIds ? { archivedSubagentIds: result.archivedSubagentIds } : {}),
		};
	},

	async dismissSpecCarryoverMessage(narratorId: string, messageId: string) {
		const ref = await readQuery(
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			}),
			{ site: "narrator-messages.dismissSpecCarryoverMessage" },
		);
		if (!ref) return;

		const msg = await readQuery(
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { role: true, contentJson: true },
			}),
			{ site: "narrator-messages.dismissSpecCarryoverMessage" },
		);
		const blocks = Array.isArray(msg?.contentJson)
			? (msg.contentJson as Array<{ type?: unknown }>)
			: [];
		const isSpecCarryover =
			blocks.length === 1 &&
			(blocks[0]?.type === "spec_fork_carryover" || blocks[0]?.type === "spec_context_cleared");
		if (msg?.role !== "disp" || !isSpecCarryover) {
			throw new ValidationError("Message is not a Dynamic Spec carryover notice");
		}

		db.transaction((tx) => {
			deleteRecipientMessageRefs(tx)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.run();
			const otherRef = tx.query.narratorMessageRefs
				.findFirst({
					where: eq(narratorMessageRefs.messageId, messageId),
				})
				.sync();
			if (!otherRef) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	/**
	 * Dismiss the interrupt task-guard reminder (source "interrupt_task_guard").
	 *
	 * Same three-step pattern as dismissSpecCarryoverMessage: the row is a plain
	 * role="sys" injection (a text block plus the system_injection block persisted by
	 * deliverInjection), so removing the narrator's ref — and the message itself when
	 * no other narrator references it — is enough; the next history rebuild simply
	 * stops reading it. Idempotent when the message is already gone.
	 */
	async dismissInterruptTaskGuardMessage(narratorId: string, messageId: string) {
		const ref = await readQuery(
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			}),
			{ site: "narrator-messages.dismissInterruptTaskGuardMessage" },
		);
		if (!ref) return;

		const msg = await readQuery(
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { role: true, contentJson: true },
			}),
			{ site: "narrator-messages.dismissInterruptTaskGuardMessage" },
		);
		// Unreachable while foreign keys are on: `narrator_message_refs.message_id` is a
		// NOT NULL reference to `narrator_messages.id`, so a ref cannot outlive its
		// message. Treated as "already gone" (like the missing-ref case above) rather
		// than as an error, because that is what it would mean if it ever happened.
		if (!msg) return;
		const blocks = Array.isArray(msg.contentJson)
			? (msg.contentJson as Array<{ type?: unknown; source?: unknown }>)
			: [];
		const isInterruptTaskGuard = blocks.some(
			(block) => block?.type === "system_injection" && block?.source === "interrupt_task_guard",
		);
		if (msg.role !== "sys" || !isInterruptTaskGuard) {
			throw new ValidationError("Message is not an interrupt task-guard reminder");
		}

		db.transaction((tx) => {
			deleteRecipientMessageRefs(tx)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.run();
			const otherRef = tx.query.narratorMessageRefs
				.findFirst({
					where: eq(narratorMessageRefs.messageId, messageId),
				})
				.sync();
			if (!otherRef) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	/**
	 * Mark a review-feedback card as acted on.
	 *
	 * Only a UI latch: the conclusion is already in the history (the row IS the user
	 * message), so this records that a turn was started for it and stops the button
	 * offering the same thing twice. Nothing to compensate on failure — no content is
	 * written or delivered here.
	 *
	 * `alreadyApplied` lets the caller skip starting a second loop while still reporting
	 * success: the reader's intent is satisfied either way.
	 */
	async markReviewFeedbackApplied(
		narratorId: string,
		messageId: string,
	): Promise<{ alreadyApplied: boolean; message?: typeof narratorMessages.$inferSelect }> {
		const ref = await readQuery(
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			}),
			{ site: "narrator-messages.markReviewFeedbackApplied" },
		);
		if (!ref) throw new NotFoundError("Message", messageId);

		return db.transaction((tx) => {
			const msg = tx.query.narratorMessages
				.findFirst({ where: eq(narratorMessages.id, messageId) })
				.sync();
			const blocks = Array.isArray(msg?.contentJson)
				? (msg.contentJson as Array<Record<string, unknown>>)
				: [];
			const index = blocks.findIndex((block) => block?.type === "review_feedback");
			if (!msg || index < 0) {
				throw new ValidationError("Message is not a review feedback card");
			}
			if ((blocks[index] as Record<string, unknown>).applied === true) {
				return { alreadyApplied: true };
			}

			const patched = blocks.map((entry, i) => (i === index ? { ...entry, applied: true } : entry));
			const updated = tx
				.update(narratorMessages)
				.set({ contentJson: patched })
				.where(eq(narratorMessages.id, messageId))
				.returning()
				.get();
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { alreadyApplied: false, message: updated };
		});
	},

	/**
	 * Release a review-feedback claim when no turn was actually started for it.
	 *
	 * The latch is what disables the card's button, and it is taken BEFORE the turn is
	 * attempted. So every path where the attempt does not result in someone reading the
	 * row has to give it back: plan mode, a status row that is not idle, or a throw
	 * inside the continuation. Without this the button reads "Handled" for findings the
	 * model never saw, and the reader has no way to ask again.
	 *
	 * A narrator that was ALREADY running is not such a path — it rebuilds history on
	 * its next pass and takes the row up on its own — so the caller keeps the latch
	 * there (see the apply route's `busy` vs `not_started`).
	 *
	 * Returns undefined when the row is not a review card or no longer exists: this runs
	 * on a failure path and must not turn one failure into two.
	 */
	async releaseReviewFeedbackClaim(narratorId: string, messageId: string) {
		return db.transaction((tx) => {
			const msg = tx.query.narratorMessages
				.findFirst({ where: eq(narratorMessages.id, messageId) })
				.sync();
			const blocks = Array.isArray(msg?.contentJson)
				? (msg.contentJson as Array<Record<string, unknown>>)
				: [];
			const index = blocks.findIndex((block) => block?.type === "review_feedback");
			if (!msg || index < 0) return undefined;
			const patched = blocks.map((entry, i) =>
				i === index ? { ...entry, applied: false } : entry,
			);
			const updated = tx
				.update(narratorMessages)
				.set({ contentJson: patched })
				.where(eq(narratorMessages.id, messageId))
				.returning()
				.get();
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return updated;
		});
	},

	/**
	 * Drop a single reasoning-only assistant record left behind by a turn that died
	 * after streaming its thinking.
	 *
	 * Deliberately narrow, in three ways:
	 *  - only this one ref is removed, unlike `deleteMessage`, which also removes
	 *    everything at a higher seq (background subagent traffic that landed after
	 *    the dead turn must survive)
	 *  - the caller's classification is re-verified here against the stored row, so a
	 *    stale id can never take out a real reply
	 *  - no workspace revert: the record has no tool call, so it changed no files
	 *
	 * Returns true when a row was removed, false when the ref is already gone.
	 * Throws when the target turns out not to be reasoning-only.
	 */
	async deleteDanglingReasoningMessage(narratorId: string, messageId: string): Promise<boolean> {
		return deleteOutputlessAssistantMessage(narratorId, messageId, "reasoning-only");
	},

	/** Retry-only cleanup of one empty record without tool/file/history boundaries. */
	async deleteEmptyRetryPlaceholder(narratorId: string, messageId: string): Promise<boolean> {
		return deleteOutputlessAssistantMessage(narratorId, messageId, "empty-placeholder");
	},

	async dismissCwdRecoveryMessage(narratorId: string, messageId: string) {
		const ref = await readQuery(
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			}),
			{ site: "narrator-messages.dismissCwdRecoveryMessage" },
		);
		if (!ref) return;

		const msg = await readQuery(
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { role: true, contentJson: true },
			}),
			{ site: "narrator-messages.dismissCwdRecoveryMessage" },
		);
		const blocks = Array.isArray(msg?.contentJson)
			? (msg.contentJson as Array<{ type?: unknown }>)
			: [];
		const isCwdRecovery = blocks.some((block) => block.type === "cwd_recovery");
		if (msg?.role !== "disp" || !isCwdRecovery) {
			throw new ValidationError("Message is not a working directory recovery notice");
		}

		db.transaction((tx) => {
			deleteRecipientMessageRefs(tx)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.run();
			const otherRef = tx.query.narratorMessageRefs
				.findFirst({ where: eq(narratorMessageRefs.messageId, messageId) })
				.sync();
			if (!otherRef) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	async dismissErrorMessage(narratorId: string, messageId: string) {
		const msg = await readQuery(
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { role: true, contentJson: true },
			}),
			{ site: "narrator-messages.dismissErrorMessage" },
		);

		// The message may already be gone (e.g. a historical "message without ref"
		// orphan that disappeared on reload, or a double-dismiss). Treat that as an
		// idempotent success: just clear the narrator-level error and notify, so the
		// user never sees a spurious "Message not found" when clicking dismiss.
		if (!msg) {
			await db
				.update(narrators)
				.set({
					errorMessage: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
				})
				.where(eq(narrators.id, narratorId));
			const narrator = await readQuery(
				db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { status: true },
				}),
				{ site: "narrator-messages.dismissErrorMessage" },
			);
			broadcastToNarrator(narratorId, {
				type: "status_change",
				narratorId,
				status: narrator?.status ?? "idle",
			});
			return;
		}

		if (
			msg.role !== "system" ||
			!Array.isArray(msg.contentJson) ||
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			!(msg.contentJson as any[]).some((b: any) => b.type === "error")
		) {
			throw new ValidationError("Message is not an error notice");
		}

		// Delete the ref (if any) and the orphaned message idempotently. A missing
		// ref is NOT an error here: a non-atomic-write orphan still needs cleanup,
		// and the user-facing dismiss must always succeed for a real error notice.
		db.transaction((tx) => {
			deleteRecipientMessageRefs(tx)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.run();
			const otherRef = tx.query.narratorMessageRefs
				.findFirst({
					where: eq(narratorMessageRefs.messageId, messageId),
				})
				.sync();
			if (!otherRef) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
			tx.update(narrators)
				.set({
					errorMessage: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});

		const narrator = await readQuery(
			db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { status: true },
			}),
			{ site: "narrator-messages.dismissErrorMessage" },
		);
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status: narrator?.status ?? "idle",
		});
	},

	async deleteMessagesAfter(
		narratorId: string,
		messageId: string,
		opts?: { preserveConversationId?: boolean; skipRevert?: boolean; scope?: RevertScope },
	) {
		return deleteMessageRange(narratorId, messageId, false, opts);
	},

	async deleteMessageBlock(
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: BlockDeleteOptions,
	) {
		const result = await deleteBlockSelection(narratorId, [{ messageId, blockIndex }], opts);
		return {
			messageDeleted: result.results[0]?.messageDeleted ?? false,
			...(result.historyWarnings ? { historyWarnings: result.historyWarnings } : {}),
			...(result.archivedSubagentIds ? { archivedSubagentIds: result.archivedSubagentIds } : {}),
		};
	},

	async deleteMessageBlocks(
		narratorId: string,
		blocks: Array<{ messageId: string; blockIndex: number }>,
		opts?: { preserveConversationId?: boolean; skipRevert?: boolean; scope?: RevertScope },
	) {
		return deleteBlockSelection(narratorId, blocks, opts);
	},

	async removeCompactingMessage(narratorId: string, messageId: string) {
		db.transaction((tx) => {
			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				})
				.sync();
			const msg = tx.query.narratorMessages
				.findFirst({
					where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
					columns: { contentJson: true },
				})
				.sync();
			if (!ref || !msg) return;
			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
			if (compactBlock?.status === "compacting") {
				throw new AppError(
					"A running compact must be cancelled before its marker can be removed",
					409,
					"COMPACT_IN_PROGRESS",
				);
			}
			deleteRecipientMessageRefs(tx).where(eq(narratorMessageRefs.id, ref.id)).run();
			const remainingRef = tx.query.narratorMessageRefs
				.findFirst({ where: eq(narratorMessageRefs.messageId, messageId) })
				.sync();
			if (!remainingRef) {
				tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId)).run();
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
		});
	},

	async updateCompactSummary(narratorId: string, messageId: string, summary: string) {
		const result = db.transaction((tx) => {
			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				})
				.sync();
			const msg = tx.query.narratorMessages
				.findFirst({
					where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
				})
				.sync();
			if (!msg || !ref) throw new NotFoundError("Message", messageId);

			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const compactBlock = blocks
				.map(parseCompactMessageBlock)
				.find((block) => block?.status === "compacted");
			if (!compactBlock) throw new ValidationError("Message is not a compacted message");

			const isPlan = compactBlock.subtype === "plan";
			const newBlock = { ...compactBlock, summary };
			const prefix = isPlan ? "[Plan]" : "[Compact]";
			const now = new Date().toISOString();
			const copied = copySharedCompactMessageTx(tx, narratorId, msg, ref);

			tx.update(narratorMessages)
				.set({
					contentJson: [newBlock],
					contextCharsJson: { segments: [] },
					contentText: `${prefix} ${summary.slice(0, 200)}...`,
				})
				.where(eq(narratorMessages.id, copied.messageId))
				.run();

			tx.update(narrators)
				.set({
					contextSummary: summary,
					contextSummaryChars: measureSummaryCharacters(summary),
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					contextUsageSnapshotJson: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return copied.messageId;
		});
		queueContextCharacterRefresh(narratorId, result);
		return result;
	},

	async getPendingPermissions(narratorId: string) {
		const visibleSubagentToolRows = await readQuery(
			db
				.select({ toolUseId: narratorToolCalls.toolUseId })
				.from(narratorToolCalls)
				.innerJoin(
					narratorMessageRefs,
					and(
						eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				)
				.where(inArray(narratorToolCalls.toolName, [...SUBAGENT_TOOL_NAMES])),
			{ site: "narrator-messages.getPendingPermissions" },
		);
		const visibleSubagentToolUseIds = visibleSubagentToolRows.map((row) => row.toolUseId);
		const childVisibility =
			visibleSubagentToolUseIds.length > 0
				? and(
						eq(narrators.parentNarratorId, narratorId),
						inArray(narratorMessages.parentToolUseId, visibleSubagentToolUseIds),
					)
				: sql`0`;
		const tcs = await readQuery(
			db
				.select({
					id: narratorToolCalls.id,
					ownerNarratorId: narratorToolCalls.narratorId,
					parentToolUseId: narratorMessages.parentToolUseId,
					toolName: narratorToolCalls.toolName,
					toolUseId: narratorToolCalls.toolUseId,
					inputJson: narratorToolCalls.inputJson,
					permissionDecisionReason: narratorToolCalls.permissionDecisionReason,
					permissionSuggestions: narratorToolCalls.permissionSuggestions,
					executionDeviceId: narratorToolCalls.executionDeviceId,
					executionCwd: narratorToolCalls.executionCwd,
					executionPathFlavor: narratorToolCalls.executionPathFlavor,
					resolvedFilePath: narratorToolCalls.resolvedFilePath,
					canonicalFilePath: narratorToolCalls.canonicalFilePath,
					runtimeGeneration: narratorToolCalls.runtimeGeneration,
					executionTargetsJson: narratorToolCalls.executionTargetsJson,
					deviceSelectionSource: narratorToolCalls.deviceSelectionSource,
					createdAt: narratorToolCalls.createdAt,
				})
				.from(narratorToolCalls)
				.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
				.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
				.where(
					and(
						eq(narratorToolCalls.status, "pending"),
						or(eq(narratorToolCalls.narratorId, narratorId), childVisibility),
					),
				)
				.orderBy(narratorToolCalls.createdAt),
			{ site: "narrator-messages.getPendingPermissions" },
		);
		return tcs
			.filter((tc) => !shouldHidePendingPermission(tc.permissionSuggestions))
			.map((tc) =>
				toolCallWithExecutionTargets({
					id: tc.id,
					toolName: tc.toolName,
					toolUseId: tc.toolUseId,
					inputJson: tc.inputJson,
					decisionReason: tc.permissionDecisionReason,
					suggestions: tc.permissionSuggestions,
					executionDeviceId: tc.executionDeviceId,
					executionCwd: tc.executionCwd,
					executionPathFlavor: tc.executionPathFlavor,
					resolvedFilePath: tc.resolvedFilePath,
					canonicalFilePath: tc.canonicalFilePath,
					runtimeGeneration: tc.runtimeGeneration,
					executionTargetsJson: tc.executionTargetsJson,
					deviceSelectionSource: tc.deviceSelectionSource,
					parentToolUseId: tc.ownerNarratorId === narratorId ? null : tc.parentToolUseId,
					subagentNarratorId: tc.ownerNarratorId === narratorId ? null : tc.ownerNarratorId,
					ownerNarratorId: tc.ownerNarratorId,
				}),
			);
	},
};

function admittedMutation<A extends [string, ...unknown[]], R>(fn: (...args: A) => Promise<R>) {
	return (...args: A): Promise<R> => withNarratorWorkAdmission(args[0], () => fn(...args));
}

// Keep readers unchanged. Every mutation entry, including marker/card deletion,
// reserves admission before reading the history it will later modify.
export const narratorMessageQueries = {
	...narratorMessageQueriesUnlocked,
	deleteCompactMessage: admittedMutation(narratorMessageQueriesUnlocked.deleteCompactMessage),
	deleteMessage: admittedMutation(narratorMessageQueriesUnlocked.deleteMessage),
	deleteMessagesAfter: admittedMutation(narratorMessageQueriesUnlocked.deleteMessagesAfter),
	deleteMessageBlock: admittedMutation(narratorMessageQueriesUnlocked.deleteMessageBlock),
	deleteMessageBlocks: admittedMutation(narratorMessageQueriesUnlocked.deleteMessageBlocks),
	deleteEmptyRetryPlaceholder: admittedMutation(
		narratorMessageQueriesUnlocked.deleteEmptyRetryPlaceholder,
	),
	deleteDanglingReasoningMessage: admittedMutation(
		narratorMessageQueriesUnlocked.deleteDanglingReasoningMessage,
	),
	removeCompactingMessage: admittedMutation(narratorMessageQueriesUnlocked.removeCompactingMessage),
	updateCompactSummary: admittedMutation(narratorMessageQueriesUnlocked.updateCompactSummary),
	dismissSpecCarryoverMessage: admittedMutation(
		narratorMessageQueriesUnlocked.dismissSpecCarryoverMessage,
	),
	dismissInterruptTaskGuardMessage: admittedMutation(
		narratorMessageQueriesUnlocked.dismissInterruptTaskGuardMessage,
	),
	dismissCwdRecoveryMessage: admittedMutation(
		narratorMessageQueriesUnlocked.dismissCwdRecoveryMessage,
	),
	dismissErrorMessage: admittedMutation(narratorMessageQueriesUnlocked.dismissErrorMessage),
	markReviewFeedbackApplied: admittedMutation(
		narratorMessageQueriesUnlocked.markReviewFeedbackApplied,
	),
	releaseReviewFeedbackClaim: admittedMutation(
		narratorMessageQueriesUnlocked.releaseReviewFeedbackClaim,
	),
};
