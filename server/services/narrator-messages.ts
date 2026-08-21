import { parseCompactMessageBlock } from "@shared/compact-message";
import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import { projectToolIO, TOOL_IO_BUDGETS } from "@shared/pretext-layout/tool-io-projection";
import {
	isDanglingReasoningOnlyAssistantMessage,
	isMetadataOnlyEmptyReasoningAssistantMessage,
} from "@shared/reasoning-content";
import {
	MAX_SUBAGENT_SUMMARY_INPUT_BYTES,
	MAX_SUBAGENT_SUMMARY_VALUE_CHARS,
	normalizeSubagentToolInputSummary,
	SUBAGENT_SUMMARY_INPUT_KEYS,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators, narratorToolCalls } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { resolveDefaultReasoningEffort, resolveProvider } from "../lib/settings";
import { toolCallWithExecutionTargets } from "../lib/tool-execution-target-projection";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	AWAIT_AGENT_RESOLVED_FIELD,
	attachAwaitAgentNarratorIds,
	resolveAwaitAgentIdsForToolCalls,
} from "./await-agent-resolution";
import {
	ensureRefsCoverMessage,
	ensureRefsCoverSeq,
	hasUnmaterializedRefsBelow,
} from "./narrator-refs-backfill";
import {
	revertNarratorScopedForMessages,
	revertNarratorScopedForToolUses,
} from "./narrator-scoped-revert";
import {
	assertSnapshotRevertComplete,
	commitSnapshotRevert,
	DEFAULT_REVERT_SCOPE,
	discardSnapshotRevert,
	finalizeSnapshotRevert,
	type RevertResult,
	type RevertScope,
	type RevertWarning,
	revertForMessagesTree,
	revertPatchesForMessages,
	revertPatchForToolUse,
	revertPatchForToolUses,
} from "./snapshot-revert";

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Roll back the files a set of deleted messages changed.
 *
 * Strategy order, narrowest first:
 *   1. narrator scope — reverse only this narrator's changes (default), so other
 *      actors' work in the same window survives
 *   2. workspace tree — restore everything to the recorded boundary
 *   3. per-file replay — for history recorded before snapshots existed
 *
 * Steps 1 and 2 return null when they do not apply (no boundary, a non-contiguous
 * window, a missing snapshot), which is what makes this a fallback chain rather
 * than a choice. A *conflict* in step 1 is not a fallback: it returns failures so
 * the caller reports them, because silently widening to step 2 would discard the
 * other actor's changes the user was never asked about.
 */
async function revertForDeletedMessages(
	narratorId: string,
	messageIds: string[],
	scope: RevertScope | undefined,
): Promise<RevertResult> {
	if ((scope ?? DEFAULT_REVERT_SCOPE) === "narrator") {
		const scoped = await revertNarratorScopedForMessages(narratorId, messageIds);
		if (scoped) return scoped;
	}
	return (
		(await revertForMessagesTree(narratorId, messageIds)) ??
		(await revertPatchesForMessages(narratorId, messageIds))
	);
}

/**
 * Roll back the files a single deleted tool_use block changed.
 *
 * Strategy order, narrowest first, mirroring `revertForDeletedMessages`:
 *   1. narrator scope — reverse just this call's recorded boundary, so later work
 *      and other actors' work in the same worktree survive
 *   2. per-file replay — for calls recorded before tree snapshots existed
 *
 * Step 1 returning null means it cannot express this window (no boundary, a remote
 * workspace, git too old), which is what makes this a fallback chain. A *conflict*
 * is not a fallback: it comes back as failures so the caller reports them, because
 * replaying instead would rebuild the file from tool inputs and quietly drop
 * whatever another actor wrote in the same region.
 */
async function revertForDeletedBlock(
	narratorId: string,
	removedBlock: { type: string; id?: string },
	messageId: string,
	opts?: { skipRevert?: boolean; scope?: RevertScope; revertHandledByCaller?: boolean },
): Promise<RevertResult | null> {
	if (opts?.skipRevert || opts?.revertHandledByCaller) return null;
	if (removedBlock.type !== "tool_use" || !removedBlock.id) return null;

	if ((opts?.scope ?? DEFAULT_REVERT_SCOPE) === "narrator") {
		const scoped = await revertNarratorScopedForToolUses(narratorId, [
			{ messageId, toolUseId: removedBlock.id },
		]);
		if (scoped) return scoped;
	}
	return revertPatchForToolUse(narratorId, removedBlock.id);
}

/**
 * Resolve which tool calls a set of pending block deletions targets.
 *
 * Read before any deletion happens: `blockIndex` addresses a position in the
 * message's current content array, and removing one block shifts the rest.
 */
async function resolveBlockToolUses(
	grouped: Map<string, number[]>,
): Promise<Array<{ messageId: string; toolUseId: string }>> {
	const targets: Array<{ messageId: string; toolUseId: string }> = [];
	for (const [messageId, indices] of grouped) {
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		const blocks = Array.isArray(message?.contentJson)
			? (message.contentJson as Array<{ type: string; id?: string }>)
			: [];
		for (const blockIndex of indices) {
			const block = blocks[blockIndex];
			if (block?.type === "tool_use" && block.id) {
				targets.push({ messageId, toolUseId: block.id });
			}
		}
	}
	return targets;
}

/**
 * Reject a batch whose blocks are not all deletable, before anything is written.
 *
 * `deleteMessageBlocks` calls `deleteMessageBlock` per block and each of those commits
 * its own transaction, so there is no enclosing transaction to abandon: by the time the
 * fifth block fails, the first four are already gone from the database. Since the batch
 * also rolls the workspace back as a single window, a mid-batch failure would leave
 * files reverted with the history that described them deleted — unrecoverable in both
 * directions.
 *
 * The fix is therefore to make mid-batch failure not happen, by checking here every
 * precondition `deleteMessageBlock` would raise on before it mutates: the ref exists,
 * the message exists, and every index is in range. Indices are validated against the
 * message's current content array with the shifting accounted for — the caller sorts
 * each message's indices descending, so removing them in that order never moves an
 * index that has not been handled yet, and each one only has to be in range originally.
 *
 * A running compact is deliberately NOT checked here: it is enforced inside each
 * transaction by `assertNoRunningCompactRefsTx`, and a compact that starts between this
 * check and the write would slip past anything checked out here anyway. Callers already
 * gate on `prepareHistoryRewrite` before reaching this path.
 */
function assertBlocksDeletable(narratorId: string, grouped: Map<string, number[]>): void {
	// Kept synchronous-per-message rather than one big query: the batch is small (it comes
	// from a user selection) and per-message errors need to name the message that failed.
	for (const [messageId, indices] of grouped) {
		const ref = db.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
				columns: { id: true },
			})
			.sync();
		if (!ref) throw new NotFoundError("Message", messageId);

		const message = db.query.narratorMessages
			.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { contentJson: true },
			})
			.sync();
		if (!message) throw new NotFoundError("Message", messageId);

		const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
		for (const blockIndex of indices) {
			if (blockIndex < 0 || blockIndex >= blocks.length) {
				throw new ValidationError(
					`Block index ${blockIndex} out of range (0..${blocks.length - 1}) for message ${messageId}`,
				);
			}
		}
	}
}

/**
 * Roll back the files a batch of deleted tool_use blocks changed, in one pass.
 *
 * Same narrowest-first chain as the single-block path: the narrator scope reverses
 * only these calls' recorded boundaries, and replay covers calls with no boundary.
 * Returns null when neither applies (nothing to undo).
 */
async function revertForDeletedBlocks(
	narratorId: string,
	toolUses: Array<{ messageId: string; toolUseId: string }>,
	scope: RevertScope | undefined,
): Promise<RevertResult | null> {
	if ((scope ?? DEFAULT_REVERT_SCOPE) === "narrator") {
		const scoped = await revertNarratorScopedForToolUses(narratorId, toolUses);
		if (scoped) return scoped;
	}
	return revertPatchForToolUses(
		narratorId,
		toolUses.map((target) => target.toolUseId),
	);
}

type MessageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
			columns: { forkMessageId: true, pruneBoundaryMessageId: true },
		})
		.sync();
	const narratorUpdates: Partial<typeof narrators.$inferInsert> = {};
	if (narrator?.forkMessageId === message.id) narratorUpdates.forkMessageId = newMessageId;
	if (narrator?.pruneBoundaryMessageId === message.id) {
		narratorUpdates.pruneBoundaryMessageId = newMessageId;
	}
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

function isCompactLifecycleMessage(message: { contentJson: unknown }): boolean {
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
 * Delete orphaned messages and their associated refs/tool-calls within a
 * transaction. Also clears narrator FK references (forkMessageId,
 * pruneBoundaryMessageId) that point to the orphaned messages.
 *
 * Shared by deleteMessagesFromSeq and deleteMessagesFromSeqInclusive.
 */
function deleteOrphanedMessages(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	orphanIds: string[],
): void {
	if (orphanIds.length === 0) return;

	tx.update(narrators)
		.set({ forkMessageId: null })
		.where(inArray(narrators.forkMessageId, orphanIds))
		.run();
	tx.update(narrators)
		.set({ pruneBoundaryMessageId: null })
		.where(inArray(narrators.pruneBoundaryMessageId, orphanIds))
		.run();

	// Delete refs held by subagent narrators pointing to orphaned messages
	tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.messageId, orphanIds)).run();
	tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds)).run();
	tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds)).run();
}

type FileHistoryToolCall = typeof narratorToolCalls.$inferSelect;
type FileHistoryCheckpointGroup = {
	messageId: string;
	seq: number;
	toolCalls: FileHistoryToolCall[];
};

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
function checkpointWorthyToolCall() {
	return or(
		sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
		and(
			isNotNull(narratorToolCalls.treeHashBefore),
			isNotNull(narratorToolCalls.treeHashAfter),
			ne(narratorToolCalls.treeHashBefore, narratorToolCalls.treeHashAfter),
		),
	);
}

/**
 * Preserve successful file mutations when a user deletes history without asking
 * us to revert the filesystem. The checkpoint ref is hidden by the existing
 * segment-compact visibility mechanism, while its tool calls remain available
 * to file-state rebuild and future rollback operations.
 */
async function collectFileHistoryCheckpointGroups(
	refs: Array<{ messageId: string; seq: number }>,
): Promise<FileHistoryCheckpointGroup[]> {
	if (refs.length === 0) return [];
	const seqByMessageId = new Map(refs.map((ref) => [ref.messageId, ref.seq]));
	const toolCalls = await db
		.select()
		.from(narratorToolCalls)
		.where(
			and(
				inArray(narratorToolCalls.messageId, [...seqByMessageId.keys()]),
				eq(narratorToolCalls.status, "success"),
				checkpointWorthyToolCall(),
			),
		)
		.orderBy(narratorToolCalls.createdAt);
	const groups = new Map<string, FileHistoryCheckpointGroup>();
	for (const toolCall of toolCalls) {
		const seq = seqByMessageId.get(toolCall.messageId);
		if (seq == null) continue;
		const group = groups.get(toolCall.messageId) ?? {
			messageId: toolCall.messageId,
			seq,
			toolCalls: [],
		};
		group.toolCalls.push(toolCall);
		groups.set(toolCall.messageId, group);
	}
	return [...groups.values()];
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
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "Send"]);

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

type ResolvedChildAnchor = CatchUpChildAnchor & { seq: number };

function refKey(narratorId: string, messageId: string): string {
	return `${narratorId}\u0000${messageId}`;
}

async function resolveCatchUpChildAnchors(
	parentNarratorId: string,
	anchors: CatchUpChildAnchor[],
): Promise<{
	messageAnchors: Map<string, ResolvedChildAnchor>;
	subagentAnchors: Map<string, CatchUpChildAnchor>;
}> {
	const messageAnchors = new Map<string, ResolvedChildAnchor>();
	const subagentAnchors = new Map<string, CatchUpChildAnchor>();
	const parentToolUseIds = [...new Set(anchors.map((anchor) => anchor.parentToolUseId))];
	const parentToolRows =
		parentToolUseIds.length > 0
			? await db
					.select({
						toolUseId: narratorToolCalls.toolUseId,
						toolName: narratorToolCalls.toolName,
					})
					.from(narratorToolCalls)
					.innerJoin(
						narratorMessageRefs,
						and(
							eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
							eq(narratorMessageRefs.narratorId, parentNarratorId),
						),
					)
					.where(inArray(narratorToolCalls.toolUseId, parentToolUseIds))
			: [];
	const visibleToolNames = new Map(
		parentToolRows.map((toolCall) => [toolCall.toolUseId, toolCall.toolName]),
	);
	const lastMessageIds = [
		...new Set(anchors.map((anchor) => anchor.lastMessageId).filter((id): id is string => !!id)),
	];
	const childMessageMap = new Map<
		string,
		{ id: string; narratorId: string; parentToolUseId: string | null }
	>();
	const refSeqMap = new Map<string, number>();

	if (lastMessageIds.length > 0) {
		const [childMessages, childRefs] = await Promise.all([
			db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, lastMessageIds),
				columns: { id: true, narratorId: true, parentToolUseId: true },
			}),
			db.query.narratorMessageRefs.findMany({
				where: inArray(narratorMessageRefs.messageId, lastMessageIds),
				columns: { messageId: true, narratorId: true, seq: true },
			}),
		]);
		for (const message of childMessages) {
			childMessageMap.set(message.id, message);
		}
		for (const ref of childRefs) {
			refSeqMap.set(refKey(ref.narratorId, ref.messageId), ref.seq);
		}
	}

	for (const anchor of anchors) {
		const toolName = visibleToolNames.get(anchor.parentToolUseId);
		if (!toolName) continue;
		if (SUBAGENT_TOOL_NAMES.has(toolName)) {
			subagentAnchors.set(anchor.parentToolUseId, {
				parentToolUseId: anchor.parentToolUseId,
			});
			continue;
		}
		let narratorForAnchor = anchor.narratorId;
		let seq = -1;
		let lastMessageId = anchor.lastMessageId;
		if (lastMessageId) {
			const childMessage = childMessageMap.get(lastMessageId);
			if (childMessage?.parentToolUseId !== anchor.parentToolUseId) continue;
			narratorForAnchor = narratorForAnchor ?? childMessage.narratorId;
			const childSeq = narratorForAnchor
				? refSeqMap.get(refKey(narratorForAnchor, lastMessageId))
				: undefined;
			if (childSeq == null) continue;
			seq = childSeq;
		} else {
			lastMessageId = undefined;
		}

		const existing = messageAnchors.get(anchor.parentToolUseId);
		if (!existing || seq >= existing.seq) {
			messageAnchors.set(anchor.parentToolUseId, {
				parentToolUseId: anchor.parentToolUseId,
				narratorId: narratorForAnchor,
				lastMessageId,
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
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateToolIO(tree: any[], maxLen = DEFAULT_TOOL_IO_BUDGET): any[] {
	return tree.map((msg) => {
		return {
			...msg,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			toolCalls: msg.toolCalls?.map((tc: any) => {
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
		if (!msg.toolCalls?.length || !Array.isArray(msg.contentJson)) return msg;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const tcMap = new Map<string, any>(msg.toolCalls.map((tc: any) => [tc.toolUseId, tc]));
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
				durationMs: tc.durationMs,
				streamStartedAt: tc.streamStartedAt,
				permissionStartedAt: tc.permissionStartedAt,
				executionStartedAt: tc.executionStartedAt,
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
 * (frontend/components/narrator/message-segments.ts) builds each `ToolCallData`
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
		const hadEncrypted = Object.values(providerMetadata as Record<string, unknown>).some(
			(metadata) => {
				if (!metadata || typeof metadata !== "object") return false;
				const encrypted = (metadata as Record<string, unknown>).reasoningEncryptedContent;
				return typeof encrypted === "string" && encrypted.length > 0;
			},
		);
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

const SUBAGENT_ACTIVITY_LIMIT = 3;

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
	latestToolCalls: SubagentActivityToolCall[];
}

export interface SubagentActivityCatchUp {
	parentToolUseId: string;
	activity: SubagentActivity;
}

export type SubagentActivitySnapshot = SubagentActivityCatchUp[];

interface SubagentActivityOwner {
	parentToolUseId: string;
	subagentNarratorId: string;
	model: string | null;
	reasoningEffort: string | null;
}

/**
 * SQL projection of the whitelisted short input keys for one activity row.
 *
 * WHY IN SQL AND NOT IN JS
 * `input_json` is deliberately NOT selected by this query: for Write/Edit it can
 * hold a whole file (observed max 180KB across 835k rows). Selecting it to read a
 * 40-char path would pull the blob into JS and re-parse it on the main thread,
 * which CLAUDE.md forbids on summary paths. `json_extract` keeps the parse inside
 * SQLite and returns only the short leaves.
 *
 * TWO GUARDS, BOTH LOAD-BEARING:
 *
 *  1. `json_valid` — NOT a nicety. A single malformed row makes `json_extract`
 *     raise "malformed JSON" and abort the ENTIRE statement, so one bad row would
 *     blank every card's activity list rather than just its own. (Measured: the
 *     unguarded query throws; the guarded one returns all rows.)
 *
 *  2. `octet_length` — bounds the parse for a pathological blob. The ceiling is
 *     256KB rather than a tighter number on purpose: a 32KB cap would have
 *     suppressed the summary for a large-file `Write`, i.e. exactly the case where
 *     `file_path` is the only useful label. Both guards sit in front of the
 *     extract so an oversized row costs a length check, not a parse.
 *
 * Each value is capped with `substr` so a multi-KB `description` cannot inflate
 * the response.
 */
function subagentSummarySql(): SQL<string | null> {
	const paths = SUBAGENT_SUMMARY_INPUT_KEYS.map(
		(key) =>
			sql`substr(json_extract(${narratorToolCalls.inputJson}, ${`$.${key}`}), 1, ${MAX_SUBAGENT_SUMMARY_VALUE_CHARS})`,
	);
	// json_object(k1, v1, k2, v2, ...) — one row-shaped JSON string instead of ten
	// result columns, so adding a key later does not reshape the row type.
	const pairs: SQL[] = [];
	SUBAGENT_SUMMARY_INPUT_KEYS.forEach((key, index) => {
		pairs.push(sql`${key}, ${paths[index]}`);
	});
	return sql<string | null>`CASE
		WHEN ${narratorToolCalls.inputJson} IS NOT NULL
			AND octet_length(${narratorToolCalls.inputJson}) <= ${MAX_SUBAGENT_SUMMARY_INPUT_BYTES}
			AND json_valid(${narratorToolCalls.inputJson})
		THEN json_object(${sql.join(pairs, sql`, `)})
	END`;
}

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
): Promise<Map<string, SubagentActivityToolCall[]>> {
	const result = new Map<string, SubagentActivityToolCall[]>();
	const uniqueNarratorIds = [...new Set(narratorIds)];
	if (uniqueNarratorIds.length === 0) return result;

	const rowsByNarrator = await Promise.all(
		uniqueNarratorIds.map(async (narratorId) => {
			const rows = await db
				.select({
					toolCallId: narratorToolCalls.id,
					toolUseId: narratorToolCalls.toolUseId,
					toolName: narratorToolCalls.toolName,
					status: narratorToolCalls.status,
					createdAt: narratorToolCalls.createdAt,
					streamStartedAt: narratorToolCalls.streamStartedAt,
					permissionStartedAt: narratorToolCalls.permissionStartedAt,
					executionStartedAt: narratorToolCalls.executionStartedAt,
					completedAt: narratorToolCalls.completedAt,
					durationMs: narratorToolCalls.durationMs,
					// Short whitelisted input keys only — never the `input_json` blob.
					inputSummary: subagentSummarySql(),
				})
				.from(narratorToolCalls)
				.where(
					and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.isFileHistoryCheckpoint, false),
					),
				)
				.orderBy(desc(narratorToolCalls.createdAt), desc(narratorToolCalls.id))
				.limit(SUBAGENT_ACTIVITY_LIMIT);
			return { narratorId, rows: rows.reverse() };
		}),
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

async function buildSubagentActivities(
	owners: SubagentActivityOwner[],
	expectedToolUseIds: string[] = [],
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
	const toolCallsByNarrator = await loadLatestSubagentToolCalls(narratorIds);
	for (const owner of owners) {
		const effectiveReasoningEffort =
			owner.reasoningEffort ??
			(owner.model
				? resolveDefaultReasoningEffort(resolveProvider(owner.model), owner.model)
				: undefined);
		activities.set(owner.parentToolUseId, {
			subagentNarratorId: owner.subagentNarratorId,
			model: owner.model,
			reasoningEffort: effectiveReasoningEffort ?? null,
			latestToolCalls: toolCallsByNarrator.get(owner.subagentNarratorId) ?? [],
		});
	}
	return activities;
}

async function loadSubagentActivitiesForToolUseIds(
	toolUseIds: string[],
): Promise<Map<string, SubagentActivity>> {
	if (toolUseIds.length === 0) return new Map();
	const rows = await db
		.select({
			parentToolUseId: narratorMessages.parentToolUseId,
			subagentNarratorId: narratorMessages.narratorId,
			model: narrators.model,
			reasoningEffort: narrators.reasoningEffort,
		})
		.from(narratorMessages)
		.innerJoin(narrators, eq(narrators.id, narratorMessages.narratorId))
		.where(inArray(narratorMessages.parentToolUseId, toolUseIds))
		.groupBy(
			narratorMessages.parentToolUseId,
			narratorMessages.narratorId,
			narrators.model,
			narrators.reasoningEffort,
		);
	const owners = rows.flatMap((row) =>
		row.parentToolUseId
			? [
					{
						parentToolUseId: row.parentToolUseId,
						subagentNarratorId: row.subagentNarratorId,
						model: row.model ?? null,
						reasoningEffort: row.reasoningEffort ?? null,
					},
				]
			: [],
	);
	return buildSubagentActivities(owners, toolUseIds);
}

async function loadSubagentActivityCatchUp(
	toolUseIds: string[],
): Promise<SubagentActivitySnapshot> {
	const activities = await loadSubagentActivitiesForToolUseIds(toolUseIds);
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
	refRows: Array<{ messageId: string; seq: number }>,
	isSubagent: boolean,
	ioBudget: number,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
): Promise<any[]> {
	if (refRows.length === 0) return [];

	const messageIds = refRows.map((r) => r.messageId);
	const topMessages = await db.query.narratorMessages.findMany({
		where: inArray(narratorMessages.id, messageIds),
		with: { toolCalls: true, creator: true },
	});
	const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
	topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
	attachMessageSeqs(topMessages, seqMap);
	if (isSubagent) {
		for (const message of topMessages) message.parentToolUseId = null;
	}

	const subagentToolUseIds = collectSubagentToolUseIds(topMessages);
	const subagentToolUseIdSet = new Set(subagentToolUseIds);
	const inlineToolUseIds = collectToolUseIds(topMessages).filter(
		(toolUseId) => !subagentToolUseIdSet.has(toolUseId),
	);
	const [activities, childMessages] = await Promise.all([
		loadSubagentActivitiesForToolUseIds(subagentToolUseIds),
		inlineToolUseIds.length > 0
			? db.query.narratorMessages.findMany({
					where: inArray(narratorMessages.parentToolUseId, inlineToolUseIds),
					with: { toolCalls: true, creator: true },
					orderBy: (m, { asc }) => [asc(m.createdAt)],
					limit: 500,
				})
			: Promise.resolve([]),
	]);
	attachSubagentActivities(topMessages, activities);
	const enriched = enrichToolUseBlocks(
		filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages]), ioBudget),
		),
	);
	// A still-waiting Await knows its target only as a selector; resolve it so the
	// row can open the child's session before the wait returns.
	return attachAwaitAgentNarratorIds(
		enriched,
		await resolveAwaitAgentIdsForMessages([...topMessages, ...childMessages]),
	);
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
): Promise<Map<string, string>> {
	const candidates: Array<{
		toolUseId: string;
		toolName: string;
		inputJson?: unknown;
		outputJson?: unknown;
		narratorId?: string;
	}> = [];
	for (const msg of messages) {
		for (const tc of msg?.toolCalls ?? []) {
			if (tc?.toolName !== "Await") continue;
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
export { AWAIT_AGENT_RESOLVED_FIELD, attachAwaitAgentNarratorIds };

// ── narratorMessages object ────────────────────────────────────────────────

export const narratorMessageQueries = {
	async getMessages(narratorId: string, limit = 100, offset = 0) {
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId))
			.orderBy(narratorMessageRefs.seq)
			.limit(limit)
			.offset(offset);
		if (refRows.length === 0) return [];

		const messageIds = refRows.map((row) => row.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});
		const seqMap = new Map(refRows.map((row) => [row.messageId, row.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	async getLatestCompactSeq(narratorId: string): Promise<number | null> {
		const lastCompactRow = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);
		return lastCompactRow[0]?.seq ?? null;
	},

	async getMessagesSinceLastCompact(narratorId: string) {
		const compactSeq = await this.getLatestCompactSeq(narratorId);

		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
					isNull(narratorMessageRefs.segmentCompactId),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

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
		return messages;
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
		const rawRefRows = await db
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
			.limit(boundedLimit + 1);

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
		const messageRows = await db
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
			.where(inArray(narratorMessages.id, messageIds));

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

		const rawToolRows = await db
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
			.limit(CONTEXT_ASK_TOOL_CALL_LIMIT + 1);

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
	async getModelHistorySinceLastCompact(narratorId: string) {
		const compactSeq = await this.getLatestCompactSeq(narratorId);
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
					ne(narratorMessages.role, "disp"),
					isNull(narratorMessageRefs.segmentCompactId),
				),
			)
			.orderBy(narratorMessageRefs.seq);
		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			columns: {
				id: true,
				narratorId: true,
				role: true,
				contentJson: true,
				contentText: true,
				parentToolUseId: true,
				messageUuid: true,
			},
			with: {
				toolCalls: {
					columns: {
						toolUseId: true,
						toolName: true,
						inputJson: true,
						outputJson: true,
						status: true,
					},
				},
			},
		});
		if (messages.length !== refRows.length) {
			const foundIds = new Set(messages.map((message) => message.id));
			const missingMessageIds = messageIds.filter((id) => !foundIds.has(id)).slice(0, 20);
			logger.warn("Narrator model history refs point to missing messages", {
				narratorId,
				refCount: refRows.length,
				messageCount: messages.length,
				missingMessageIds,
			});
		}
		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		// Compact lifecycle markers and metadata-only empty reasoning records are
		// UI/control-plane data. They remain in the database and display history,
		// but must not become model-history boundaries or hide trailing tool results.
		const modelMessages = messages.filter(
			(message) =>
				!isCompactLifecycleMessage(message) &&
				!isMetadataOnlyEmptyReasoningAssistantMessage(message),
		);
		return modelMessages;
	},

	async getMessagesBefore(narratorId: string, beforeMessageId: string) {
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, beforeMessageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

		const lastCompactRow = await db
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
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;
		const lowerBound = compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : sql`1=1`;

		const refRows = await db
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
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		// A failed earlier compact marker may sit inside this retry range. Keep it
		// visible in the transcript, but never summarize it into a later compact.
		const compactableMessages = messages.filter((message) => !isCompactLifecycleMessage(message));
		return compactableMessages;
	},

	async getEarliestMessages(narratorId: string, limit = 2) {
		const rows = await db
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
			.limit(limit);
		return rows;
	},

	async _getPostCompactTopLevelRefs(
		narratorId: string,
		options?: { includeChildMessages?: boolean },
	) {
		const includeChildMessages = options?.includeChildMessages ?? false;

		const lastCompactRow = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		return db
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
					...(includeChildMessages ? [] : [isNull(narratorMessages.parentToolUseId)]),
				),
			)
			.orderBy(narratorMessageRefs.seq);
	},

	async getCompactBoundaryMessage(narratorId: string, keepPairs = 2): Promise<string | null> {
		const includeChildMessages = await this.isSubagentNarrator(narratorId);
		const refs = await this._getPostCompactTopLevelRefs(narratorId, {
			includeChildMessages,
		});
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
		const includeChildMessages = await this.isSubagentNarrator(narratorId);
		const refs = await this._getPostCompactTopLevelRefs(narratorId, {
			includeChildMessages,
		});
		// Need at least 2 messages: one to summarize + one to keep as the boundary.
		if (refs.length < 2) return null;
		// Keep only the most recent message; compact everything before it.
		const boundaryRef = refs[refs.length - 1];
		return boundaryRef.messageId;
	},

	async getRecentMessages(narratorId: string, limit = 4) {
		const rows = await db
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
			.limit(limit);
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
		const rows = await db
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
			.limit(Math.max(1, Math.floor(scanLimit)));

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
		const rows = await db
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
			.limit(1);

		const row = rows[0];
		if (!row) return null;
		const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
		const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
		const summary = typeof compactBlock?.summary === "string" ? compactBlock.summary : "";
		if (!summary.trim()) return null;
		return { id: row.id, summary };
	},

	async isSubagentNarrator(narratorId: string): Promise<boolean> {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { variant: true },
		});
		return narrator != null && isSubagentVariant(narrator.variant);
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
	async getMessageVersion(narratorId: string): Promise<number> {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { messageVersion: true },
		});
		return row?.messageVersion ?? 0;
	},

	/**
	 * Resolve a message id to the top-level seq used by the chunk manifest.
	 *
	 * This is the lightweight replacement for the old around-window query: it only
	 * reads narrow indexed columns and never returns content_json/message trees.
	 * For primary narrators, child messages are resolved by walking parent
	 * tool-use ownership until a referenced top-level message is found. For a
	 * subagent narrator, its own refs are already top-level from that page's point
	 * of view, even when messages carry parentToolUseId pointing to the parent
	 * narrator.
	 */
	async getMessageLocation(
		narratorId: string,
		messageId: string,
	): Promise<{
		messageId: string;
		topLevelMessageId: string;
		seq: number;
	}> {
		const [isSubagent, target] = await Promise.all([
			this.isSubagentNarrator(narratorId),
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { id: true, parentToolUseId: true },
			}),
		]);
		if (!target) throw new NotFoundError("Message", messageId);

		// Jumping to a message (from search, or a citation) may target history a lazy
		// fork has not materialized yet. Resolve it against the lineage and pull in
		// everything down to it, so the location — and the surrounding page the client
		// fetches next — actually exist locally.
		await ensureRefsCoverMessage(narratorId, messageId);

		const findVisibleRef = async (candidateMessageId: string) =>
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, candidateMessageId),
					isNull(narratorMessageRefs.segmentCompactId),
				),
				columns: { seq: true },
			});

		const directRef = await findVisibleRef(target.id);
		if (directRef && (isSubagent || !target.parentToolUseId)) {
			return { messageId: target.id, topLevelMessageId: target.id, seq: directRef.seq };
		}

		let parentToolUseId = target.parentToolUseId;
		for (let depth = 0; parentToolUseId && depth < 32; depth++) {
			const candidates = await db
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
				.limit(10);
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
		opts: { afterSeq?: number; beforeSeq?: number; limit?: number; messageVersion?: number } = {},
	) {
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
		const isSubagent = await this.isSubagentNarrator(narratorId);
		const messageVersion = await this.getMessageVersion(narratorId);
		if (opts.messageVersion != null && opts.messageVersion !== messageVersion)
			throw new AppError(
				"Narrator document changed before the exact-layout page was built",
				409,
				"PRETEXT_DOCUMENT_CHANGED",
			);
		const assertDocumentUnchanged = async () => {
			if ((await this.getMessageVersion(narratorId)) !== messageVersion)
				throw new AppError(
					"Narrator document changed while the exact-layout page was being built",
					409,
					"PRETEXT_DOCUMENT_CHANGED",
				);
		};
		const baseConditions = [
			eq(narratorMessageRefs.narratorId, narratorId),
			isNull(narratorMessageRefs.segmentCompactId),
			...(isSubagent ? [] : [isNull(narratorMessages.parentToolUseId)]),
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

		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(and(...conditions))
			.orderBy(ascending ? asc(narratorMessageRefs.seq) : desc(narratorMessageRefs.seq))
			.limit(limit + 1);
		const hasMoreInDirection = refRows.length > limit;
		const pageRows = hasMoreInDirection ? refRows.slice(0, limit) : refRows;
		// Descending queries return newest-first; flip to the ascending order the
		// exact-layout builder always consumes.
		if (!ascending) pageRows.reverse();

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
					pageRows,
					isSubagent,
					// The ONLY path whose bodies are measured for the exact layout: the budget
					// must fill the detail caps, or a card reserves a box it cannot fill.
					EXACT_TOOL_IO_BUDGET,
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
						await db
							.select({ seq: narratorMessageRefs.seq })
							.from(narratorMessageRefs)
							.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
							.where(and(...baseConditions, lt(narratorMessageRefs.seq, minSeq)))
							.limit(1)
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
	},

	async getMessagesAfter(narratorId: string, after: CatchUpCursor, limit = 200) {
		const isSubagent = await this.isSubagentNarrator(narratorId);
		const inputCursor: CatchUpCursor = after;

		let parentAnchorSeq: number | null = null;
		let parentLastMessageId = inputCursor.parentLastMessageId;
		const baseChildAnchors = new Map<string, CatchUpChildAnchor>();

		async function addOpenAnchorsForMessage(messageId: string) {
			const rows = await db.query.narratorToolCalls.findMany({
				where: eq(narratorToolCalls.messageId, messageId),
				columns: { toolUseId: true },
			});
			for (const row of rows) {
				upsertCursorChildAnchor(baseChildAnchors, { parentToolUseId: row.toolUseId });
			}
		}

		if (parentLastMessageId) {
			const parentRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, parentLastMessageId),
				),
				columns: { seq: true },
			});
			const parentMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, parentLastMessageId),
				columns: { narratorId: true, parentToolUseId: true },
			});
			if (!isSubagent && parentMessage?.parentToolUseId) {
				const childAnchorMessageId = parentLastMessageId;
				const [toolParentRef] = await db
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
						toolName: narratorToolCalls.toolName,
					})
					.from(narratorToolCalls)
					.innerJoin(
						narratorMessageRefs,
						eq(narratorToolCalls.messageId, narratorMessageRefs.messageId),
					)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorToolCalls.toolUseId, parentMessage.parentToolUseId),
						),
					)
					.limit(1);
				const childRef = await db.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, parentMessage.narratorId),
						eq(narratorMessageRefs.messageId, childAnchorMessageId),
					),
					columns: { seq: true },
				});
				parentAnchorSeq = toolParentRef?.seq ?? null;
				parentLastMessageId = toolParentRef?.messageId ?? parentLastMessageId;
				const isSubagentAnchor = !!toolParentRef && SUBAGENT_TOOL_NAMES.has(toolParentRef.toolName);
				upsertCursorChildAnchor(baseChildAnchors, {
					parentToolUseId: parentMessage.parentToolUseId,
					narratorId: parentMessage.narratorId,
					lastMessageId: !isSubagentAnchor && childRef ? childAnchorMessageId : undefined,
				});
			} else if (parentRef) {
				parentAnchorSeq = parentRef.seq;
				await addOpenAnchorsForMessage(parentLastMessageId);
			}
		}

		for (const anchor of inputCursor.childAnchors ?? []) {
			if (anchor.parentToolUseId) upsertCursorChildAnchor(baseChildAnchors, anchor);
		}

		const resolvedAnchors = !isSubagent
			? await resolveCatchUpChildAnchors(narratorId, trimCursorChildAnchors(baseChildAnchors))
			: {
					messageAnchors: new Map<string, ResolvedChildAnchor>(),
					subagentAnchors: new Map<string, CatchUpChildAnchor>(),
				};
		const resolvedChildAnchors = resolvedAnchors.messageAnchors;
		const cursorChildAnchors = trimCursorChildAnchors(
			new Map<string, CatchUpChildAnchor>([
				...[...resolvedChildAnchors].map(
					([toolUseId, { seq: _seq, ...anchor }]) => [toolUseId, anchor] as const,
				),
				...resolvedAnchors.subagentAnchors,
			]),
		);
		const subagentActivities = await loadSubagentActivityCatchUp([
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
			if (!isSubagent) rowConditions.push(sql`${narratorMessages.parentToolUseId} IS NULL`);
			refRows = await db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
				})
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(and(...rowConditions))
				.orderBy(sql`${narratorMessageRefs.seq} ASC`)
				.limit(limit + 1);
		}

		const childRefRows: Array<{ messageId: string; seq: number }> = childWhere
			? await db
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
					})
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(childWhere)
					.orderBy(sql`${narratorMessageRefs.seq} ASC`)
					.limit(limit + 1)
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
		const allMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true, creator: true },
		});

		const seqMap = new Map(allRefRows.map((r) => [r.messageId, r.seq]));
		allMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		attachMessageSeqs(allMessages, seqMap);

		const topMsgs = [] as typeof allMessages;
		const childMsgs = [] as typeof allMessages;
		for (const msg of allMessages) {
			if (isSubagent) {
				msg.parentToolUseId = null;
				topMsgs.push(msg);
			} else if (msg.parentToolUseId) {
				childMsgs.push(msg);
			} else {
				topMsgs.push(msg);
			}
		}

		const newTopToolUseIds = collectToolUseIds(topMsgs);
		const newTopSubagentToolUseIdSet = new Set(collectSubagentToolUseIds(topMsgs));
		const inlineTopToolUseIds = newTopToolUseIds.filter(
			(toolUseId) => !newTopSubagentToolUseIdSet.has(toolUseId),
		);
		const existingChildIds = new Set(childMsgs.map((m) => m.id));
		if (inlineTopToolUseIds.length > 0) {
			const extraChildren = await db.query.narratorMessages.findMany({
				where: and(
					inArray(narratorMessages.parentToolUseId, inlineTopToolUseIds),
					childMsgs.length > 0
						? sql`${narratorMessages.id} NOT IN (${sql.join(
								childMsgs.map((m) => sql`${m.id}`),
								sql`, `,
							)})`
						: undefined,
				),
				with: { toolCalls: true, creator: true },
				orderBy: (m, { asc }) => [asc(m.createdAt)],
				limit: 500,
			});
			for (const child of extraChildren) {
				if (!existingChildIds.has(child.id)) childMsgs.push(child);
			}
		}

		attachSubagentActivities(
			topMsgs,
			await loadSubagentActivitiesForToolUseIds([...newTopSubagentToolUseIdSet]),
		);
		const awaitAgentIds = await resolveAwaitAgentIdsForMessages([...topMsgs, ...childMsgs]);
		const tree = attachAwaitAgentNarratorIds(
			enrichToolUseBlocks(
				filterExitPlanBeforePlanCompact(
					truncateToolIO(buildMessageTree([...topMsgs, ...childMsgs])),
				),
			),
			awaitAgentIds,
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
			topLevel: tree,
			orphanChildren: attachAwaitAgentNarratorIds(
				enrichToolUseBlocks(truncateToolIO(orphanChildren)),
				awaitAgentIds,
			),
			subagentActivities,
			hitLimit: false,
			cursor,
		};
	},

	async getToolCallDetail(narratorId: string, toolUseId: string) {
		const candidates = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
		if (candidates.length === 0) throw new NotFoundError("ToolCall", toolUseId);

		for (const candidate of candidates) {
			const msg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, candidate.messageId),
				columns: { id: true, parentToolUseId: true },
			});
			if (!msg) continue;

			// Visibility is determined by the narrator's refs, never by the message or
			// tool-call owner. This keeps shared fork history readable without exposing
			// rows that are no longer part of the caller's view.
			const directRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, msg.id),
				),
				columns: { id: true },
			});
			if (directRef) return toolCallWithExecutionTargets(candidate);

			if (!msg.parentToolUseId) continue;
			const parentTc = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.toolUseId, msg.parentToolUseId),
				columns: { messageId: true },
			});
			if (!parentTc) continue;
			const parentRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, parentTc.messageId),
				),
				columns: { id: true },
			});
			if (parentRef) return toolCallWithExecutionTargets(candidate);
		}

		throw new NotFoundError("ToolCall", toolUseId);
	},

	async getCompactSummary(narratorId: string, messageId: string) {
		return db.transaction((tx) => {
			const msg = tx.query.narratorMessages
				.findFirst({
					where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.role, "system")),
				})
				.sync();
			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
					columns: { seq: true, isCompact: true },
				})
				.sync();
			if (!msg || !ref) throw new NotFoundError("Message", messageId);

			const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const compactBlock = blocks.map(parseCompactMessageBlock).find(Boolean);
			if (!compactBlock) throw new NotFoundError("CompactSummary", messageId);
			const latestCompactRows = tx
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(1)
				.all();
			const latestCompactSeq = latestCompactRows[0]?.seq ?? null;
			const canRetry =
				compactBlock.status === "failed" &&
				ref.isCompact === 0 &&
				(latestCompactSeq == null || ref.seq > latestCompactSeq);
			const latestAttempt = compactBlock.attempts?.at(-1);
			return {
				status: compactBlock.status,
				summary: typeof compactBlock.summary === "string" ? compactBlock.summary : "",
				error:
					typeof compactBlock.error === "string"
						? compactBlock.error
						: latestAttempt?.status === "failed"
							? latestAttempt.error
							: undefined,
				mode: compactBlock.mode,
				trigger: compactBlock.trigger,
				contextPercentBefore: compactBlock.contextPercentBefore,
				contextPercentAfter: compactBlock.contextPercentAfter,
				attempts: compactBlock.attempts ?? [],
				canRetry,
			};
		});
	},

	async deleteCompactMessage(narratorId: string, messageId: string) {
		return db.transaction((tx) => {
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
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, currentRef.id)).run();
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
								apiConversationId: null,
								pruneBoundaryMessageId: null,
								prunedPercent: null,
							}
						: {}),
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			return {
				previousCompactExists: compactBlock.status === "compacted" && previousCompact.length > 0,
			};
		});
	},

	async deleteMessage(
		narratorId: string,
		messageId: string,
		opts?: { skipRevert?: boolean; scope?: RevertScope },
	) {
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", messageId);

		const refsToRemove = await db
			.select({
				id: narratorMessageRefs.id,
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gte(narratorMessageRefs.seq, targetRef.seq),
				),
			);

		if (refsToRemove.length === 0) return { deletedCount: 0 };

		const refIds = refsToRemove.map((r) => r.id);
		const messageIds = [...new Set(refsToRemove.map((r) => r.messageId))];
		const fileHistoryCheckpoints = opts?.skipRevert
			? await collectFileHistoryCheckpointGroups(refsToRemove)
			: [];

		const mutate = () =>
			db.transaction((tx) => {
				assertNoRunningCompactRefsTx(tx, narratorId, refIds);
				if (opts?.skipRevert) {
					insertFileHistoryCheckpoints(tx, narratorId, fileHistoryCheckpoints);
				}
				tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds)).run();

				const orphanRows = tx
					.select({ id: narratorMessages.id })
					.from(narratorMessages)
					.where(
						and(
							inArray(narratorMessages.id, messageIds),
							sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
						)`,
						),
					)
					.all();

				const orphanIds = orphanRows.map((r) => r.id);
				if (orphanIds.length > 0) {
					const orphanMsgs = tx
						.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
						.from(narratorMessages)
						.where(inArray(narratorMessages.id, orphanIds))
						.all();

					const toolUseIds: string[] = [];
					for (const msg of orphanMsgs) {
						const blocks = Array.isArray(msg.contentJson)
							? (msg.contentJson as { type: string; id?: string }[])
							: [];
						for (const b of blocks) {
							if (b.type === "tool_use" && b.id) toolUseIds.push(b.id);
						}
					}

					if (toolUseIds.length > 0) {
						const childRows = tx
							.select({ id: narratorMessages.id })
							.from(narratorMessages)
							.where(inArray(narratorMessages.parentToolUseId, toolUseIds))
							.all();
						for (const c of childRows) orphanIds.push(c.id);
					}

					deleteOrphanedMessages(tx, orphanIds);
				}

				const now = new Date().toISOString();
				tx.update(narrators)
					.set({
						apiConversationId: null,
						pruneBoundaryMessageId: null,
						prunedPercent: null,
						messageVersion: sql`${narrators.messageVersion} + 1`,
						updatedAt: now,
					})
					.where(eq(narrators.id, narratorId))
					.run();
			});

		// skipRevert: delete message history only, leaving filesystem/spec untouched.
		if (opts?.skipRevert) {
			mutate();
		} else {
			const snapshotRevert = await revertForDeletedMessages(narratorId, messageIds, opts?.scope);
			await commitSnapshotRevert(snapshotRevert, mutate);
		}

		return { deletedCount: refsToRemove.length };
	},

	async dismissSpecCarryoverMessage(narratorId: string, messageId: string) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) return;

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true },
		});
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
			tx.delete(narratorMessageRefs)
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
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) return;

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true },
		});
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
			tx.delete(narratorMessageRefs)
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
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
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
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) return false;

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true, contentText: true },
			with: { toolCalls: { columns: { id: true } } },
		});
		if (!msg) return false;
		if (!isDanglingReasoningOnlyAssistantMessage(msg)) {
			throw new ValidationError("Message is not a reasoning-only assistant record");
		}

		db.transaction((tx) => {
			assertNoRunningCompactRefsTx(tx, narratorId, [ref.id]);
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, ref.id)).run();
			const otherRef = tx.query.narratorMessageRefs
				.findFirst({ where: eq(narratorMessageRefs.messageId, messageId) })
				.sync();
			if (!otherRef) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
			tx.update(narrators)
				.set({
					// The provider-side conversation no longer matches the stored history.
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
		return true;
	},

	async dismissCwdRecoveryMessage(narratorId: string, messageId: string) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) return;

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true },
		});
		const blocks = Array.isArray(msg?.contentJson)
			? (msg.contentJson as Array<{ type?: unknown }>)
			: [];
		const isCwdRecovery = blocks.some((block) => block.type === "cwd_recovery");
		if (msg?.role !== "disp" || !isCwdRecovery) {
			throw new ValidationError("Message is not a working directory recovery notice");
		}

		db.transaction((tx) => {
			tx.delete(narratorMessageRefs)
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
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	async dismissErrorMessage(narratorId: string, messageId: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true },
		});

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
				})
				.where(eq(narrators.id, narratorId));
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { status: true },
			});
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
			tx.delete(narratorMessageRefs)
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
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { status: true },
		});
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
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", messageId);

		const refsToRemove = await db
			.select({
				id: narratorMessageRefs.id,
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gt(narratorMessageRefs.seq, targetRef.seq),
				),
			);

		if (refsToRemove.length === 0) return { deletedCount: 0, deletedMessageIds: [] };

		const refIds = refsToRemove.map((r) => r.id);
		const messageIds = [...new Set(refsToRemove.map((r) => r.messageId))];
		const fileHistoryCheckpoints = opts?.skipRevert
			? await collectFileHistoryCheckpointGroups(refsToRemove)
			: [];

		const mutate = () =>
			db.transaction((tx) => {
				assertNoRunningCompactRefsTx(tx, narratorId, refIds);
				if (opts?.skipRevert) {
					insertFileHistoryCheckpoints(tx, narratorId, fileHistoryCheckpoints);
				}
				tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds)).run();

				const orphanRows = tx
					.select({ id: narratorMessages.id })
					.from(narratorMessages)
					.where(
						and(
							inArray(narratorMessages.id, messageIds),
							sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
						)`,
						),
					)
					.all();

				const orphanIds = orphanRows.map((r) => r.id);
				if (orphanIds.length > 0) {
					const orphanMsgs = tx
						.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
						.from(narratorMessages)
						.where(inArray(narratorMessages.id, orphanIds))
						.all();

					const toolUseIds: string[] = [];
					for (const msg of orphanMsgs) {
						const blocks = Array.isArray(msg.contentJson)
							? (msg.contentJson as { type: string; id?: string }[])
							: [];
						for (const b of blocks) {
							if (b.type === "tool_use" && b.id) toolUseIds.push(b.id);
						}
					}

					if (toolUseIds.length > 0) {
						const childRows = tx
							.select({ id: narratorMessages.id })
							.from(narratorMessages)
							.where(inArray(narratorMessages.parentToolUseId, toolUseIds))
							.all();
						for (const c of childRows) orphanIds.push(c.id);
					}

					deleteOrphanedMessages(tx, orphanIds);
				}

				const now = new Date().toISOString();
				tx.update(narrators)
					.set({
						...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
						pruneBoundaryMessageId: null,
						prunedPercent: null,
						messageVersion: sql`${narrators.messageVersion} + 1`,
						updatedAt: now,
					})
					.where(eq(narrators.id, narratorId))
					.run();
			});

		// skipRevert: delete message history only, leaving filesystem/spec untouched.
		let revertWarnings: RevertWarning[] = [];
		if (opts?.skipRevert) {
			mutate();
		} else {
			const snapshotRevert = await revertForDeletedMessages(narratorId, messageIds, opts?.scope);
			await commitSnapshotRevert(snapshotRevert, mutate);
			revertWarnings = snapshotRevert.warnings ?? [];
		}

		return {
			deletedCount: refsToRemove.length,
			deletedMessageIds: messageIds,
			// Surfaced so the caller can pass the advice on: a workspace rollback also
			// discards other actors' changes from the same window.
			revertWarnings,
		};
	},

	async deleteMessageBlock(
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: {
			skipRevert?: boolean;
			skipNarratorUpdate?: boolean;
			preserveConversationId?: boolean;
			scope?: RevertScope;
			/**
			 * Set by `deleteMessageBlocks`, which reverts the whole batch in one pass.
			 * Without it each block would reverse its own boundary again, applying the
			 * same rollback twice.
			 */
			revertHandledByCaller?: boolean;
		},
	) {
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", messageId);

		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
		});
		if (!message) throw new NotFoundError("Message", messageId);

		const blocks = Array.isArray(message.contentJson)
			? (message.contentJson as { type: string; id?: string; text?: string }[])
			: [];
		if (blockIndex < 0 || blockIndex >= blocks.length) {
			throw new ValidationError(`Block index ${blockIndex} out of range (0..${blocks.length - 1})`);
		}

		const removedBlock = blocks[blockIndex];
		const remaining = blocks.filter((_, i) => i !== blockIndex);

		const refCount = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId));
		const isShared = (refCount[0]?.count ?? 0) > 1;
		// A tool_use block is exactly one recorded boundary pair, so the tree path can
		// reverse it on its own: each segment merges against the accumulated result, so
		// removing one block from the middle keeps everything that came after it.
		//
		// It is preferred over replay because replay can only reproduce changes some
		// tool input describes — it cannot see what Bash, a build script or an external
		// editor wrote. Replay stays as the fallback for history with no recorded
		// boundary, which is most pre-snapshot history.
		const snapshotRevert = await revertForDeletedBlock(narratorId, removedBlock, messageId, opts);
		const fileHistoryCheckpointToolCalls =
			opts?.skipRevert && removedBlock.type === "tool_use" && removedBlock.id
				? await db
						.select()
						.from(narratorToolCalls)
						.where(
							and(
								eq(narratorToolCalls.messageId, messageId),
								eq(narratorToolCalls.toolUseId, removedBlock.id),
								eq(narratorToolCalls.status, "success"),
								checkpointWorthyToolCall(),
							),
						)
				: [];

		let messageDeleted = false;

		const mutateMessage = () =>
			db.transaction((tx) => {
				assertNoRunningCompactRefsTx(tx, narratorId, [targetRef.id]);
				if (fileHistoryCheckpointToolCalls.length > 0) {
					insertFileHistoryCheckpoints(tx, narratorId, [
						{
							messageId,
							seq: targetRef.seq,
							toolCalls: fileHistoryCheckpointToolCalls,
						},
					]);
				}
				/**
				 * Detach a removed tool_use block: drop its tool call row and its subagent subtree.
				 *
				 * `dropToolCallRow` is false when the message is still referenced by another
				 * narrator. That row holds the `treeHashBefore/After` boundary those narrators
				 * revert against, so deleting it would leave their history describing changes it
				 * can no longer undo. The child subtree is separate — it is already reference
				 * counted below and only removed once nobody else points at it.
				 */
				const cleanToolUseBlock = (
					block: { type: string; id?: string },
					msgId: string,
					dropToolCallRow = true,
				) => {
					if (block.type !== "tool_use" || !block.id) return;
					if (dropToolCallRow) {
						tx.delete(narratorToolCalls)
							.where(
								and(
									eq(narratorToolCalls.messageId, msgId),
									eq(narratorToolCalls.toolUseId, block.id),
								),
							)
							.run();
					}
					const children = tx
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(eq(narratorMessages.parentToolUseId, block.id))
						.all();
					if (children.length > 0) {
						const childIds = children.map((c) => c.id);
						const otherRefs = tx
							.select({ messageId: narratorMessageRefs.messageId })
							.from(narratorMessageRefs)
							.where(
								and(
									inArray(narratorMessageRefs.messageId, childIds),
									ne(narratorMessageRefs.narratorId, narratorId),
								),
							)
							.limit(1)
							.all();
						if (otherRefs.length === 0) {
							tx.delete(narratorToolCalls)
								.where(inArray(narratorToolCalls.messageId, childIds))
								.run();
							tx.delete(narratorMessageRefs)
								.where(inArray(narratorMessageRefs.messageId, childIds))
								.run();
							tx.delete(narratorMessages).where(inArray(narratorMessages.id, childIds)).run();
						} else {
							tx.delete(narratorMessageRefs)
								.where(
									and(
										eq(narratorMessageRefs.narratorId, narratorId),
										inArray(narratorMessageRefs.messageId, childIds),
									),
								)
								.run();
						}
					}
				};

				if (remaining.length === 0) {
					messageDeleted = true;
					// Keep the tool call row while another narrator still references this message: it
					// carries that narrator's `treeHashBefore/After` boundary, and dropping it would
					// silently make their history unrevertable. Same reasoning as the shared branch
					// below, which clones the message rather than editing it in place. The subagent
					// subtree is still cleaned either way — it has its own reference counting.
					cleanToolUseBlock(removedBlock, messageId, !isShared);
					tx.delete(narratorMessageRefs)
						.where(
							and(
								eq(narratorMessageRefs.narratorId, narratorId),
								eq(narratorMessageRefs.messageId, messageId),
							),
						)
						.run();
					if (!isShared) {
						tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId)).run();
						tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
					}
				} else if (isShared) {
					const newId = generateId();
					const contentText = remaining
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("\n");

					tx.insert(narratorMessages)
						.values({
							id: newId,
							narratorId: message.narratorId,
							messageUuid: message.messageUuid,
							parentToolUseId: message.parentToolUseId,
							role: message.role,
							contentJson: remaining,
							contentText: contentText || null,
							tokensIn: message.tokensIn,
							costUsd: message.costUsd,
							turnUsageJson: message.turnUsageJson,
							contextPercent: message.contextPercent,
							meterUsage: message.meterUsage,
							meterUnit: message.meterUnit,
							commitSha: message.commitSha,
							createdAt: message.createdAt,
						})
						.run();

					tx.update(narratorMessageRefs)
						.set({ messageId: newId })
						.where(
							and(
								eq(narratorMessageRefs.narratorId, narratorId),
								eq(narratorMessageRefs.messageId, messageId),
							),
						)
						.run();

					const remainingToolUseIds = remaining
						.filter((b): b is typeof b & { id: string } => b.type === "tool_use" && !!b.id)
						.map((b) => b.id);
					if (remainingToolUseIds.length > 0) {
						const existingCalls = tx
							.select()
							.from(narratorToolCalls)
							.where(
								and(
									eq(narratorToolCalls.messageId, messageId),
									inArray(narratorToolCalls.toolUseId, remainingToolUseIds),
								),
							)
							.all();
						if (existingCalls.length > 0) {
							tx.insert(narratorToolCalls)
								.values(
									existingCalls.map((tc) => ({
										...tc,
										id: generateId(),
										messageId: newId,
									})),
								)
								.run();
						}
					}

					cleanToolUseBlock(removedBlock, newId);
				} else {
					const contentText = remaining
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("\n");

					tx.update(narratorMessages)
						.set({ contentJson: remaining, contentText: contentText || null })
						.where(eq(narratorMessages.id, messageId))
						.run();

					cleanToolUseBlock(removedBlock, messageId);
				}

				if (!opts?.skipNarratorUpdate) {
					tx.update(narrators)
						.set({
							...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
							pruneBoundaryMessageId: null,
							prunedPercent: null,
							messageVersion: sql`${narrators.messageVersion} + 1`,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(narrators.id, narratorId))
						.run();
				}
			});
		if (snapshotRevert) await commitSnapshotRevert(snapshotRevert, mutateMessage);
		else mutateMessage();

		return { messageDeleted };
	},

	async deleteMessageBlocks(
		narratorId: string,
		blocks: Array<{ messageId: string; blockIndex: number }>,
		opts?: { preserveConversationId?: boolean; skipRevert?: boolean; scope?: RevertScope },
	) {
		const grouped = new Map<string, number[]>();
		for (const b of blocks) {
			const arr = grouped.get(b.messageId) ?? [];
			arr.push(b.blockIndex);
			grouped.set(b.messageId, arr);
		}
		for (const arr of grouped.values()) {
			arr.sort((a, b) => b - a);
		}

		// Every block the batch will touch must be addressable and deletable BEFORE the
		// rollback runs. Each `deleteMessageBlock` below commits its own transaction, so
		// a failure halfway through cannot be rolled back as one unit — the only real
		// protection is to reject the batch while nothing has been written yet.
		assertBlocksDeletable(narratorId, grouped);

		// One rollback for the whole batch rather than one per block. Reverting block
		// by block would treat each call as an isolated window, so a run of adjacent
		// calls could not be collapsed into a single segment and each pass would merge
		// against the previous pass's output. Resolved before anything is deleted,
		// because removing a block rewrites the content array these indices address.
		const targetedToolUses = opts?.skipRevert ? [] : await resolveBlockToolUses(grouped);
		const snapshotRevert =
			targetedToolUses.length > 0
				? await revertForDeletedBlocks(narratorId, targetedToolUses, opts?.scope)
				: null;
		// A conflict (or any rollback failure) refuses the whole batch: the files were
		// left untouched, so deleting the history would strand changes with nothing
		// left to describe them. Per-block tolerance below is for history errors.
		if (snapshotRevert) assertSnapshotRevertComplete(snapshotRevert);

		const results: Array<{ messageId: string; blockIndex: number; messageDeleted: boolean }> = [];
		const failed: Array<{ messageId: string; blockIndex: number; error: string }> = [];
		for (const [msgId, indices] of grouped) {
			for (const blockIndex of indices) {
				try {
					const r = await this.deleteMessageBlock(narratorId, msgId, blockIndex, {
						skipNarratorUpdate: true,
						preserveConversationId: opts?.preserveConversationId,
						skipRevert: opts?.skipRevert,
						// The batch already reverted these files; per-block rollback would
						// reverse the same boundary a second time.
						revertHandledByCaller: !opts?.skipRevert,
					});
					results.push({ messageId: msgId, blockIndex, messageDeleted: r.messageDeleted });
					if (r.messageDeleted) break;
				} catch (err) {
					failed.push({
						messageId: msgId,
						blockIndex,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		if (snapshotRevert) {
			// Which way to close the rollback depends on whether any history was actually
			// removed, NOT on whether every block succeeded.
			//
			// Each `deleteMessageBlock` above commits its own transaction, so once one has
			// returned its history is gone for good. Undoing the rollback at that point
			// would put the reverted bytes back on disk while the tool calls that describe
			// them no longer exist — changes with nothing left to explain them, and no way
			// to roll them back again. Keeping the rollback is the only outcome that leaves
			// history and workspace describing the same thing.
			//
			// `assertBlocksDeletable` already rejected the batch before the rollback ran for
			// every failure this layer can foresee, so reaching here with partial failures
			// means something unforeseeable happened mid-batch; the surviving blocks are
			// reported in `failed` so the caller can retry them.
			if (results.length === 0) {
				await discardSnapshotRevert(snapshotRevert);
			} else {
				finalizeSnapshotRevert(snapshotRevert);
				if (failed.length > 0) {
					logger.error("Batch block deletion partially failed after its rollback ran", {
						narratorId,
						deleted: results.length,
						failed: failed.length,
						failures: failed.slice(0, 10),
					});
				}
			}
		}

		if (results.length > 0) {
			await db
				.update(narrators)
				.set({
					...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId));
		}

		return {
			deleted: results.length,
			failed: failed.length,
			results,
			...(snapshotRevert?.warnings?.length ? { revertWarnings: snapshotRevert.warnings } : {}),
		};
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
			tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, ref.id)).run();
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
		return db.transaction((tx) => {
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
					contentText: `${prefix} ${summary.slice(0, 200)}...`,
				})
				.where(eq(narratorMessages.id, copied.messageId))
				.run();

			tx.update(narrators)
				.set({
					contextSummary: summary,
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return copied.messageId;
		});
	},

	async getPendingPermissions(narratorId: string) {
		const visibleSubagentToolRows = await db
			.select({ toolUseId: narratorToolCalls.toolUseId })
			.from(narratorToolCalls)
			.innerJoin(
				narratorMessageRefs,
				and(
					eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
					eq(narratorMessageRefs.narratorId, narratorId),
				),
			)
			.where(inArray(narratorToolCalls.toolName, [...SUBAGENT_TOOL_NAMES]));
		const visibleSubagentToolUseIds = visibleSubagentToolRows.map((row) => row.toolUseId);
		const childVisibility =
			visibleSubagentToolUseIds.length > 0
				? and(
						eq(narrators.parentNarratorId, narratorId),
						inArray(narratorMessages.parentToolUseId, visibleSubagentToolUseIds),
					)
				: sql`0`;
		const tcs = await db
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
			.orderBy(narratorToolCalls.createdAt);
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
