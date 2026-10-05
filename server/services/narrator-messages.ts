import { parseCompactMessageBlock } from "@shared/compact-message";
import { type FileReferenceDisplay, fileReferenceDisplay } from "@shared/file-reference";
import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import {
	contextBlockViews,
	injectionBlockViews,
	modelTextFromContentBlocks,
} from "@shared/native-injection";
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
	type AnyColumn,
	and,
	asc,
	desc,
	eq,
	exists,
	getTableColumns,
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
import {
	apiRequests,
	knowledgeInjectionEvents,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../db/schema";
import {
	measureMessageCharacters,
	measureSummaryCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { resolveDefaultReasoningEffort, resolveProvider } from "../lib/settings";
import { toolCallWithExecutionTargets } from "../lib/tool-execution-target-projection";
import { MAX_BATCH_DELETE_BLOCKS } from "../lib/validators/narrators";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	AWAIT_AGENT_RESOLVED_FIELD,
	attachAwaitAgentNarratorIds,
	attachTakenOverFlags,
	resolveAwaitAgentIdsForToolCalls,
	TAKEN_OVER_FIELD,
} from "./await-agent-resolution";
import { liveCompactProgress } from "./compact-live-state";
import { deleteRecipientMessageRefs, updateRecipientMessageRef } from "./narrator-persistence";
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
	type SubagentFileChanges,
} from "./subagent-file-changes";
import { getRecentSubagentModelInheritance } from "./subagent-model";
import { isTakenOverForDisplay, listDisplayTakenOverSubagents } from "./subagent-takeover";
import { toolEditPreviewColumns } from "./tool-edit-preview";

// ── Internal helpers ───────────────────────────────────────────────────────

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
type DeletableBlock = { type: string; id?: string; text?: string };
type BlockSelection = { messageId: string; blockIndex: number };
type BlockDeleteOptions = {
	skipRevert?: boolean;
	skipNarratorUpdate?: boolean;
	preserveConversationId?: boolean;
	scope?: RevertScope;
};
type BlockDeletionPlan = {
	message: typeof narratorMessages.$inferSelect;
	ref: typeof narratorMessageRefs.$inferSelect;
	indices: number[];
	remaining: DeletableBlock[];
	removed: DeletableBlock[];
	isShared: boolean;
	toolCalls: Array<typeof narratorToolCalls.$inferSelect>;
	checkpointToolCalls: Array<typeof narratorToolCalls.$inferSelect>;
};

// M0 admission limits: apply to internal callers and skipRevert too, not only HTTP.
// Larger rewrites need the worker-backed history planner, not a larger main-thread tx.
const BLOCK_DELETE_ROW_LIMIT = 5_000;
const BLOCK_DELETE_BYTE_LIMIT = 4 * 1024 * 1024;

function isCheckpointWorthyCall(call: typeof narratorToolCalls.$inferSelect): boolean {
	return (
		call.status === "success" &&
		(call.toolName === "Write" ||
			call.toolName === "Edit" ||
			!!(call.treeHashBefore && call.treeHashAfter && call.treeHashBefore !== call.treeHashAfter))
	);
}

function storedRowBytes(columns: AnyColumn[]): SQL<number> {
	return sql<number>`${sql.join(
		columns
			.filter((column) => !column.generated)
			.map((column) => sql`coalesce(octet_length(${column}), 0)`),
		sql` + `,
	)}`;
}

type HistoryBudget = (rows: number, bytes?: number) => void;
type HistoryWarning = {
	code: "DERIVED_HISTORY_RETAINED";
	reason: "legacy_origin_unverified" | "shared_parent" | "referenced";
	toolCallId?: string;
	toolUseId?: string;
	messageId?: string;
};
const historyToolMetadataColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	isFileHistoryCheckpoint: narratorToolCalls.isFileHistoryCheckpoint,
};
type HistoryToolMetadata = Pick<
	typeof narratorToolCalls.$inferSelect,
	keyof typeof historyToolMetadataColumns
>;
type DerivedHistorySeed = { call: HistoryToolMetadata; seq: number; shared: boolean };

function createHistoryBudget(): HistoryBudget {
	let rows = 0;
	let bytes = 0;
	return (additionalRows, additionalBytes = 0) => {
		rows += additionalRows;
		bytes += additionalBytes;
		if (rows > BLOCK_DELETE_ROW_LIMIT || bytes > BLOCK_DELETE_BYTE_LIMIT) {
			throw new AppError(
				"History deletion exceeds the safety budget; select fewer messages or blocks.",
				409,
				"HISTORY_DELETE_TOO_LARGE",
			);
		}
	};
}

/** Metadata first: never load a tool's potentially large input/output just to find its children. */
function loadHistoryToolsTx(tx: MessageTx, messageIds: string[], reserve: HistoryBudget) {
	if (messageIds.length === 0) return [];
	const rows = tx
		.select({
			...historyToolMetadataColumns,
			bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))),
		})
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.messageId, messageIds))
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	reserve(
		rows.length * 2,
		rows.reduce((sum, row) => sum + row.bytes, 0),
	);
	return rows;
}

function checkpointGroupsTx(
	tx: MessageTx,
	refs: Array<{ messageId: string; seq: number }>,
	reserve: HistoryBudget,
): FileHistoryCheckpointGroup[] {
	if (refs.length === 0) return [];
	// loadHistoryToolsTx (or the block planner) already admitted every row's bytes.
	const rows = tx
		.select()
		.from(narratorToolCalls)
		.where(
			and(
				inArray(
					narratorToolCalls.messageId,
					refs.map((ref) => ref.messageId),
				),
				eq(narratorToolCalls.status, "success"),
				checkpointWorthyToolCall(),
			),
		)
		.orderBy(narratorToolCalls.createdAt, narratorToolCalls.id)
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	const groups = new Map<string, FileHistoryCheckpointGroup>();
	const seqs = new Map(refs.map((ref) => [ref.messageId, ref.seq]));
	for (const call of rows) {
		const group = groups.get(call.messageId) ?? {
			messageId: call.messageId,
			seq: seqs.get(call.messageId) ?? 0,
			toolCalls: [],
		};
		group.toolCalls.push(call);
		groups.set(call.messageId, group);
	}
	reserve(rows.length + groups.size * 2);
	return [...groups.values()];
}

/**
 * Cleanup is not a second history selector. Only a real subagent origin may add
 * unreferenced messages; not even that origin permits deleting another ref.
 * A provider ID, same-narrator inline row, ordinary fork or timestamp proves no ancestry.
 */
function planDerivedHistoryCleanup(
	tx: MessageTx,
	seeds: DerivedHistorySeed[],
	explicitMessageIds: Set<string>,
	skipRevert: boolean,
	reserve: HistoryBudget,
) {
	const warnings: HistoryWarning[] = [];
	const messageIds: string[] = [];
	const toolCallIds: string[] = [];
	const checkpoints: FileHistoryCheckpointGroup[] = [];
	const observations: unknown[] = [];
	const warned = new Set<string>();
	const warn = (
		call: HistoryToolMetadata,
		reason: HistoryWarning["reason"],
		messageId?: string,
	) => {
		const warning: HistoryWarning = {
			code: "DERIVED_HISTORY_RETAINED",
			reason,
			toolCallId: call.id,
			...(messageId ? { messageId } : {}),
		};
		const key = JSON.stringify(warning);
		if (warned.has(key)) return;
		warned.add(key);
		warnings.push(warning);
	};
	const pending = seeds.map((seed) => ({ ...seed, depth: 0 }));
	const seenCalls = new Set<string>();
	const seenMessages = new Set(explicitMessageIds);
	/**
	 * Subagents whose origin Agent/Task tool call is part of this deletion.
	 * Their card is disappearing from the parent timeline, so they must be
	 * interrupted and archived after the history mutation commits — even when
	 * their own messages are retained (shared_parent / referenced).
	 */
	const subagentNarratorIds: string[] = [];
	const childNarratorsByParent = new Map<
		string,
		Array<{ id: string; type: string; variant: string; originToolCallId: string | null }>
	>();
	for (let index = 0; index < pending.length; index++) {
		const { call, seq, shared, depth } = pending[index];
		if (seenCalls.has(call.id) || call.isFileHistoryCheckpoint) continue;
		seenCalls.add(call.id);
		// Legacy inline messages belong to the original narrator, not a proven child.
		const inline = tx
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.narratorId, call.narratorId),
					eq(narratorMessages.parentToolUseId, call.toolUseId),
				),
			)
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(inline.length);
		observations.push(inline);
		for (const row of inline) {
			if (!explicitMessageIds.has(row.id)) warn(call, "legacy_origin_unverified", row.id);
		}
		if (call.toolName !== "Agent" && call.toolName !== "Task") continue;
		if (shared || call.executionOriginToolCallId) {
			warn(call, "shared_parent");
			continue;
		}
		// A COW copy can outlive its original row. The provider ID only bounds this
		// lookup; only the exact immutable origin PK can prove a retained copy.
		const copies = tx
			.select(historyToolMetadataColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.toolUseId, call.toolUseId))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(copies.length);
		observations.push(copies);
		if (
			copies.some(
				(copy) =>
					copy.executionOriginToolCallId === call.id && !explicitMessageIds.has(copy.messageId),
			)
		) {
			warn(call, "shared_parent");
			continue;
		}
		let children = childNarratorsByParent.get(call.narratorId);
		if (!children) {
			// LIMIT before filtering origin: there is an index on parentNarratorId,
			// but no origin index. Refuse a huge sibling set instead of scanning it.
			children = tx
				.select({
					id: narrators.id,
					type: narrators.type,
					variant: narrators.variant,
					originToolCallId: narrators.originToolCallId,
				})
				.from(narrators)
				.where(eq(narrators.parentNarratorId, call.narratorId))
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(children.length);
			childNarratorsByParent.set(call.narratorId, children);
			observations.push(children);
		}
		for (const child of children) {
			if (child.type !== "subagent" || !isSubagentVariant(child.variant)) continue;
			if (!child.originToolCallId) {
				warn(call, "legacy_origin_unverified");
				continue;
			}
			if (child.originToolCallId !== call.id) continue;
			// Proven ancestry: this card is being deleted, so retire the subagent.
			// Collected before message retention checks — a referenced/shared child
			// still must not keep waking from @all members after its card is gone.
			if (!subagentNarratorIds.includes(child.id)) subagentNarratorIds.push(child.id);
			if (depth >= 32)
				throw new AppError(
					"Derived history exceeds the nesting safety budget",
					409,
					"HISTORY_DELETE_TOO_LARGE",
				);
			const rows = tx
				.select({
					id: narratorMessages.id,
					parentToolUseId: narratorMessages.parentToolUseId,
					bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))),
				})
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, child.id))
				.orderBy(narratorMessages.createdAt)
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(rows.length);
			observations.push(rows);
			if (rows.length === 0) continue;
			const refs = tx
				.select({
					id: narratorMessageRefs.id,
					messageId: narratorMessageRefs.messageId,
					narratorId: narratorMessageRefs.narratorId,
				})
				.from(narratorMessageRefs)
				.where(
					inArray(
						narratorMessageRefs.messageId,
						rows.map((row) => row.id),
					),
				)
				.limit(BLOCK_DELETE_ROW_LIMIT + 1)
				.all();
			reserve(refs.length);
			observations.push(refs);
			const referenced = new Set(refs.map((ref) => ref.messageId));
			for (const row of rows) {
				if (seenMessages.has(row.id)) continue;
				seenMessages.add(row.id);
				if (row.parentToolUseId !== call.toolUseId) {
					warn(call, "legacy_origin_unverified", row.id);
					continue;
				}
				if (referenced.has(row.id)) {
					warn(call, "referenced", row.id);
					// A retained child is a traversal boundary. Its own children are not selected.
					continue;
				}
				reserve(1, row.bytes);
				const childTools = loadHistoryToolsTx(tx, [row.id], reserve);
				observations.push(childTools);
				if (!skipRevert && childTools.length > 0) {
					throw new AppError(
						"Child tool history requires a complete rollback selection",
						409,
						"HISTORY_DERIVED_SELECTION_REQUIRED",
					);
				}
				assertNoRunningCompactMessagesTx(tx, [row.id]);
				messageIds.push(row.id);
				toolCallIds.push(...childTools.map((tool) => tool.id));
				if (skipRevert)
					checkpoints.push(...checkpointGroupsTx(tx, [{ messageId: row.id, seq }], reserve));
				pending.push(
					...childTools.map((tool) => ({ call: tool, seq, shared: false, depth: depth + 1 })),
				);
			}
		}
	}
	return { messageIds, toolCallIds, checkpoints, warnings, observations, subagentNarratorIds };
}

function assertNoRunningCompactMessagesTx(tx: MessageTx, messageIds: string[]) {
	if (messageIds.length === 0) return [];
	// All selected message bytes have already been admitted by the caller.
	const rows = tx
		.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(inArray(narratorMessages.id, messageIds))
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	const toolBlocks: Array<{ messageId: string; toolUseId: string }> = [];
	for (const row of rows) {
		const blocks = Array.isArray(row.contentJson) ? row.contentJson : [];
		if (blocks.some((block) => parseCompactMessageBlock(block)?.status === "compacting")) {
			throw new AppError(
				"A running compact must be cancelled before its message can be deleted",
				409,
				"COMPACT_IN_PROGRESS",
			);
		}
		for (const block of blocks as DeletableBlock[]) {
			if (block.type === "tool_use" && block.id)
				toolBlocks.push({ messageId: row.id, toolUseId: block.id });
		}
	}
	return toolBlocks;
}

function missingToolHistoryWarnings(
	blocks: Array<{ messageId: string; toolUseId: string }>,
	calls: HistoryToolMetadata[],
): HistoryWarning[] {
	const known = new Set(calls.map((call) => JSON.stringify([call.messageId, call.toolUseId])));
	return blocks
		.filter((block) => !known.has(JSON.stringify([block.messageId, block.toolUseId])))
		.map((block) => ({
			code: "DERIVED_HISTORY_RETAINED",
			reason: "legacy_origin_unverified",
			...block,
		}));
}

/** Fix indices, COW data and cleanup sets before any rollback touches the files. */
function planBlockDeletions(
	tx: MessageTx,
	narratorId: string,
	grouped: Map<string, number[]>,
	opts?: BlockDeleteOptions,
) {
	const narrator = tx.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: { messageVersion: true } })
		.sync();
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	let rowCount = 0;
	let byteCount = 0;
	const reserve = (rows: number, bytes = 0) => {
		rowCount += rows;
		byteCount += bytes;
		if (rowCount > BLOCK_DELETE_ROW_LIMIT || byteCount > BLOCK_DELETE_BYTE_LIMIT) {
			throw new AppError(
				"Block deletion exceeds the history safety budget; select fewer blocks.",
				409,
				"HISTORY_DELETE_TOO_LARGE",
			);
		}
	};
	const plans: BlockDeletionPlan[] = [];
	for (const [messageId, indices] of grouped) {
		const ref = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			})
			.sync();
		if (!ref) throw new NotFoundError("Message", messageId);
		const size = tx
			.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))) })
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get();
		if (!size) throw new NotFoundError("Message", messageId);
		// Check bytes in SQL before materializing any large JSON/text field.
		reserve(4, size.bytes);
		const message = tx.query.narratorMessages
			.findFirst({ where: eq(narratorMessages.id, messageId) })
			.sync();
		if (!message) throw new NotFoundError("Message", messageId);
		const blocks = Array.isArray(message.contentJson)
			? (message.contentJson as DeletableBlock[])
			: [];
		if (blocks.some((block) => parseCompactMessageBlock(block)?.status === "compacting")) {
			throw new AppError(
				"A running compact must be cancelled before its message can be deleted",
				409,
				"COMPACT_IN_PROGRESS",
			);
		}
		for (const index of indices) {
			if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
				throw new ValidationError(
					`Block index ${index} out of range (0..${blocks.length - 1}) for message ${messageId}`,
				);
			}
		}
		const selected = new Set(indices);
		const injectionViews = injectionBlockViews(blocks);
		const contextViews = contextBlockViews(blocks);
		for (const index of indices) {
			const view =
				injectionViews.find((candidate) => candidate.blockIndex === index) ??
				contextViews.find((candidate) => candidate.blockIndex === index);
			for (const sourceIndex of view?.sourceIndices ?? []) selected.add(sourceIndex);
		}
		const remaining = blocks.filter((_, index) => !selected.has(index));
		const removed = [...selected].map((index) => blocks[index]);

		const removedToolIds = new Set(
			removed
				.filter(
					(block): block is DeletableBlock & { id: string } =>
						block.type === "tool_use" && !!block.id,
				)
				.map((block) => block.id),
		);
		if (
			remaining.some((block) => block.type === "tool_use" && removedToolIds.has(block.id ?? ""))
		) {
			throw new ValidationError("Selected and retained blocks share a tool-use identity");
		}
		const otherRef = tx.query.narratorMessageRefs
			.findFirst({
				where: and(
					eq(narratorMessageRefs.messageId, messageId),
					ne(narratorMessageRefs.narratorId, narratorId),
				),
				columns: { id: true },
			})
			.sync();
		const toolSizes = tx
			.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.messageId, messageId))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(
			toolSizes.length * 2,
			toolSizes.reduce((sum, row) => sum + row.bytes, 0),
		);
		const toolCalls = tx
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.messageId, messageId))
			.orderBy(narratorToolCalls.id)
			.limit(BLOCK_DELETE_ROW_LIMIT)
			.all();
		if (
			!opts?.skipRevert &&
			remaining.length === 0 &&
			toolCalls.some((call) => !removedToolIds.has(call.toolUseId))
		) {
			throw new ValidationError("Message contains tool calls outside the selected block set");
		}
		const checkpointToolCalls = opts?.skipRevert
			? toolCalls.filter(
					(call) =>
						(remaining.length === 0 || removedToolIds.has(call.toolUseId)) &&
						isCheckpointWorthyCall(call),
				)
			: [];
		plans.push({
			message,
			ref,
			indices,
			remaining,
			removed,
			isShared: !!otherRef,
			toolCalls,
			checkpointToolCalls,
		});
	}
	const derived = planDerivedHistoryCleanup(
		tx,
		plans.flatMap((plan) => {
			const removed = new Set(
				plan.removed.filter((block) => block.type === "tool_use").map((block) => block.id),
			);
			return plan.toolCalls
				.filter((call) => removed.has(call.toolUseId))
				.map((call) => ({
					call,
					seq: plan.ref.seq,
					shared: plan.isShared || call.narratorId !== narratorId,
				}));
		}),
		new Set(grouped.keys()),
		!!opts?.skipRevert,
		reserve,
	);
	derived.warnings.push(
		...missingToolHistoryWarnings(
			plans.flatMap((plan) =>
				plan.removed
					.filter(
						(block): block is DeletableBlock & { id: string } =>
							block.type === "tool_use" && !!block.id,
					)
					.map((block) => ({ messageId: plan.message.id, toolUseId: block.id })),
			),
			plans.flatMap((plan) => plan.toolCalls),
		),
	);
	const deletedMessageIds = [
		...plans
			.filter((plan) => !plan.isShared && plan.remaining.length === 0)
			.map((plan) => plan.message.id),
		...derived.messageIds,
	];
	const deletedToolIds = plans.flatMap((plan) => {
		const removed = new Set(
			plan.removed.filter((block) => block.type === "tool_use").map((block) => block.id),
		);
		return [
			...(!plan.isShared
				? plan.toolCalls
						.filter((call) => plan.remaining.length === 0 || removed.has(call.toolUseId))
						.map((call) => call.id)
				: []),
		];
	});
	const associations = collectHistoryDeleteAssociations(
		tx,
		deletedMessageIds,
		[...deletedToolIds, ...derived.toolCallIds],
		reserve,
	);
	return { messageVersion: narrator.messageVersion, plans, derived, associations };
}

function collectHistoryDeleteAssociations(
	tx: MessageTx,
	deletedMessageIds: string[],
	deletedToolIds: string[],
	reserve: HistoryBudget,
) {
	// Include FK cascades / SET NULL and the boundary pointers explicitly cleared by
	// deleteOrphanedMessages. Otherwise a small selection can hide an unbounded tx.
	return [
		{ table: narrators, column: narrators.forkMessageId, ids: deletedMessageIds },
		{ table: narratorPatches, column: narratorPatches.messageId, ids: deletedMessageIds },
		{ table: apiRequests, column: apiRequests.messageId, ids: deletedMessageIds },
		{
			table: knowledgeInjectionEvents,
			column: knowledgeInjectionEvents.triggerMessageId,
			ids: deletedMessageIds,
		},
		{ table: narratorQuestions, column: narratorQuestions.toolCallId, ids: deletedToolIds },
		{
			table: narratorToolContinuations,
			column: narratorToolContinuations.toolCallId,
			ids: deletedToolIds,
		},
		{
			table: knowledgeInjectionEvents,
			column: knowledgeInjectionEvents.triggerToolCallId,
			ids: deletedToolIds,
		},
	].map(({ table, column, ids }) => {
		if (ids.length === 0) return [];
		const rows = tx
			.select({ id: table.id, bytes: storedRowBytes(Object.values(getTableColumns(table))) })
			.from(table)
			.where(inArray(column, [...new Set(ids)]))
			.limit(BLOCK_DELETE_ROW_LIMIT + 1)
			.all();
		reserve(
			rows.length,
			rows.reduce((sum, row) => sum + row.bytes, 0),
		);
		return rows;
	});
}

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
	const planned = db.transaction((tx) => planBlockDeletions(tx, narratorId, grouped, opts));
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
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId))
					.run();
			}
		});
	if (snapshotRevert) await commitSnapshotRevert(snapshotRevert, mutate);
	else mutate();

	// Persisted block edits must reach already-open narrators. Broadcast the exact
	// post-COW message row; a refresh remains the source of truth, while this keeps
	// the live view from retaining the pre-delete projection.
	try {
		const uniqueUpdated = [...new Map(updatedMessageIds.map((item) => [item.id, item])).values()];
		for (const item of uniqueUpdated) {
			const message = db.query.narratorMessages
				.findFirst({
					where: eq(narratorMessages.id, item.id),
					with: { toolCalls: true },
				})
				.sync();
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

/** Plan a bounded caller-owned ref range, checkpoints and proven orphan cleanup. */
function planMessageRangeDeletion(
	tx: MessageTx,
	narratorId: string,
	messageId: string,
	inclusive: boolean,
	opts?: BlockDeleteOptions,
) {
	const reserve = createHistoryBudget();
	const narrator = tx.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: { messageVersion: true } })
		.sync();
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const boundary = tx.query.narratorMessageRefs
		.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		})
		.sync();
	if (!boundary) throw new NotFoundError("Message", messageId);
	const refs = tx
		.select({
			id: narratorMessageRefs.id,
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inclusive
					? gte(narratorMessageRefs.seq, boundary.seq)
					: gt(narratorMessageRefs.seq, boundary.seq),
				// A history-only action must retain previously detached file evidence,
				// not delete/recreate its IDs on every retry. Match only our internal
				// checkpoint shape, never all hidden/compacted refs. File rollback still
				// selects these records through the ordinary range above.
				opts?.skipRevert
					? sql`NOT EXISTS (
						SELECT 1 FROM ${narratorMessages}
						WHERE ${narratorMessages.id} = ${narratorMessageRefs.messageId}
						AND ${narratorMessageRefs.segmentCompactId} = ${narratorMessageRefs.messageId}
						AND ${narratorMessages.role} = 'disp'
						AND ${narratorMessages.contentJson} = ${JSON.stringify([{ type: "file_history_checkpoint" }])}
					)`
					: undefined,
			),
		)
		.orderBy(narratorMessageRefs.seq)
		.limit(BLOCK_DELETE_ROW_LIMIT + 1)
		.all();
	reserve(refs.length);
	const refIds = new Set(refs.map((ref) => ref.id));
	const messageIds = refs.map((ref) => ref.messageId);
	const messages =
		messageIds.length > 0
			? tx
					.select({
						id: narratorMessages.id,
						narratorId: narratorMessages.narratorId,
						bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))),
					})
					.from(narratorMessages)
					.where(inArray(narratorMessages.id, messageIds))
					.orderBy(narratorMessages.id)
					.limit(BLOCK_DELETE_ROW_LIMIT + 1)
					.all()
			: [];
	reserve(
		messages.length,
		messages.reduce((sum, row) => sum + row.bytes, 0),
	);
	if (messages.length !== messageIds.length)
		throw new AppError("Selected history contains a missing message", 409, "HISTORY_DELETE_STALE");
	const toolBlocks = assertNoRunningCompactMessagesTx(tx, messageIds);
	reserve(toolBlocks.length);
	const allRefs =
		messageIds.length > 0
			? tx
					.select({
						id: narratorMessageRefs.id,
						messageId: narratorMessageRefs.messageId,
						narratorId: narratorMessageRefs.narratorId,
					})
					.from(narratorMessageRefs)
					.where(inArray(narratorMessageRefs.messageId, messageIds))
					.limit(BLOCK_DELETE_ROW_LIMIT + 1)
					.all()
			: [];
	reserve(allRefs.length);
	const retainedIds = new Set(
		allRefs.filter((ref) => !refIds.has(ref.id)).map((ref) => ref.messageId),
	);
	const tools = loadHistoryToolsTx(tx, messageIds, reserve);
	const seqs = new Map(refs.map((ref) => [ref.messageId, ref.seq]));
	const derived = planDerivedHistoryCleanup(
		tx,
		tools.map((call) => ({
			call,
			seq: seqs.get(call.messageId) ?? boundary.seq,
			shared: retainedIds.has(call.messageId) || call.narratorId !== narratorId,
		})),
		new Set(messageIds),
		!!opts?.skipRevert,
		reserve,
	);
	derived.warnings.push(...missingToolHistoryWarnings(toolBlocks, tools));
	const orphanIds = [...messageIds.filter((id) => !retainedIds.has(id)), ...derived.messageIds];
	const removedTools = [
		...tools.filter((call) => !retainedIds.has(call.messageId)).map((call) => call.id),
		...derived.toolCallIds,
	];
	const checkpoints = opts?.skipRevert
		? [...checkpointGroupsTx(tx, refs, reserve), ...derived.checkpoints]
		: [];
	const associations = collectHistoryDeleteAssociations(tx, orphanIds, removedTools, reserve);
	return {
		messageVersion: narrator.messageVersion,
		boundary,
		refs,
		messages,
		allRefs,
		tools,
		derived,
		orphanIds,
		checkpoints,
		associations,
	};
}

async function deleteMessageRange(
	narratorId: string,
	messageId: string,
	inclusive: boolean,
	opts?: BlockDeleteOptions,
) {
	const apply = (tx: MessageTx, planned: ReturnType<typeof planMessageRangeDeletion>) => {
		if (planned.refs.length === 0) return;
		insertFileHistoryCheckpoints(tx, narratorId, planned.checkpoints);
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
			.run();
		deleteOrphanedMessages(tx, planned.orphanIds);
		tx.update(narrators)
			.set({
				...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
				messageVersion: sql`${narrators.messageVersion} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId))
			.run();
	};
	const planned = db.transaction((tx) => {
		const plan = planMessageRangeDeletion(tx, narratorId, messageId, inclusive, opts);
		// History-only deletion needs no async gap: plan and mutation share this tx.
		if (opts?.skipRevert) apply(tx, plan);
		return plan;
	});
	const messageIds = planned.refs.map((ref) => ref.messageId);
	let revertWarnings: RevertWarning[] = [];
	if (!opts?.skipRevert && messageIds.length > 0) {
		const version = JSON.stringify(planned);
		const result = await revertForDeletedMessages(narratorId, messageIds, opts?.scope);
		await commitSnapshotRevert(result, () =>
			db.transaction((tx) => {
				if (
					JSON.stringify(planMessageRangeDeletion(tx, narratorId, messageId, inclusive, opts)) !==
					version
				) {
					throw new AppError(
						"Message history changed during deletion; retry the selection",
						409,
						"HISTORY_DELETE_STALE",
					);
				}
				apply(tx, planned);
			}),
		);
		revertWarnings = result.warnings ?? [];
	}
	// Same retire rule as block delete: a removed Agent/Task card archives its subagent.
	if (planned.derived.subagentNarratorIds.length > 0) {
		const { archiveRetiredSubagents } = await import("./subagent-lifecycle");
		await archiveRetiredSubagents(planned.derived.subagentNarratorIds);
	}
	return {
		deletedCount: planned.refs.length,
		deletedMessageIds: messageIds,
		revertWarnings,
		...(planned.derived.warnings.length ? { historyWarnings: planned.derived.warnings } : {}),
		...(planned.derived.subagentNarratorIds.length
			? { archivedSubagentIds: planned.derived.subagentNarratorIds }
			: {}),
	};
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

type ResolvedChildAnchor = CatchUpChildAnchor & { seq: number; narratorId: string };

async function resolveCatchUpChildAnchors(
	parentNarratorId: string,
	anchors: CatchUpChildAnchor[],
): Promise<{
	messageAnchors: Map<string, ResolvedChildAnchor>;
	subagentAnchors: Map<string, CatchUpChildAnchor>;
}> {
	const scope = db.transaction((tx) =>
		resolveAggregateScopeTx(
			tx,
			parentNarratorId,
			anchors.map((anchor) => anchor.parentToolUseId),
		),
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
		if (!msg.toolCalls?.length || !Array.isArray(msg.contentJson)) return msg;
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
	 * blocked until the user stops it (`subagent-takeover.ts`).
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
					streamCompletedAt: narratorToolCalls.streamCompletedAt,
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
						toolMessageRefExists(narratorId),
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
	const currentOptions = await getCurrentSubagentFileChangeOptions(narratorIds);
	// One aggregate for EVERY card on the page. A per-card query here would turn
	// opening a session with a dozen Agent calls into a query storm on a list path.
	const fileChangesByNarrator = await getFileChangesBySubagent(narratorIds, currentOptions);
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
			...(isTakenOverForDisplay(owner.subagentNarratorId) ? { takenOver: true } : {}),
		});
	}
	return activities;
}

const AGGREGATE_METADATA_LIMIT = 500;
const AGGREGATE_BODY_BYTE_LIMIT = 4 * 1024 * 1024;
// Recovery scan thresholds: a message is "oversized" when it alone is likely to
// break the aggregate budget above. Aligned with the per-response tool-call cap.
const HISTORY_RECOVERY_TOOL_COUNT = 32;
const HISTORY_RECOVERY_BYTE_SIZE = 1024 * 1024;
const HISTORY_RECOVERY_CANDIDATES = 10;

function assertAggregateBudget(rows: number, bytes = 0): void {
	if (rows > AGGREGATE_METADATA_LIMIT || bytes > AGGREGATE_BODY_BYTE_LIMIT) {
		throw new AppError(
			"History aggregation exceeds its safety budget; request a smaller history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	}
}

/**
 * Resolve provider groups from real caller refs. No caller-supplied narrator ID
 * or matching parentToolUseId can authorize a child. Enumerate bounded metadata
 * before deciding uniqueness: an omitted tail cannot prove a group has one owner.
 */
function resolveAggregateScopeTx(tx: MessageTx, narratorId: string, toolUseIds: string[]) {
	const ids = [...new Set(toolUseIds)];
	assertAggregateBudget(ids.length);
	const parentRows =
		ids.length > 0
			? tx
					.select({
						...historyToolMetadataColumns,
						executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
						executionAttempt: narratorToolCalls.executionAttempt,
						executionSegmentId: narratorToolCalls.executionSegmentId,
						executionStartedAt: narratorToolCalls.executionStartedAt,
						createdAt: narratorToolCalls.createdAt,
						completedAt: narratorToolCalls.completedAt,
						callerSeq: sql<
							number | null
						>`(SELECT aggregate_ref.seq FROM narrator_message_refs aggregate_ref
			WHERE aggregate_ref.narrator_id = ${narratorId}
			AND aggregate_ref.message_id = narrator_tool_calls.message_id
			AND aggregate_ref.segment_compact_id IS NULL)`,
					})
					.from(narratorToolCalls)
					.where(
						and(
							inArray(narratorToolCalls.toolUseId, ids),
							eq(narratorToolCalls.isFileHistoryCheckpoint, false),
							sql`EXISTS (SELECT 1 FROM narrator_message_refs aggregate_ref
								WHERE aggregate_ref.narrator_id = ${narratorId}
								AND aggregate_ref.message_id = narrator_tool_calls.message_id
								AND aggregate_ref.segment_compact_id IS NULL)`,
						),
					)
					.limit(AGGREGATE_METADATA_LIMIT + 1)
					.all()
			: [];
	assertAggregateBudget(parentRows.length);
	const parentGroups = new Map<string, typeof parentRows>();
	for (const row of parentRows) {
		if (row.callerSeq === null || row.isFileHistoryCheckpoint) continue;
		const group = parentGroups.get(row.toolUseId) ?? [];
		group.push(row);
		parentGroups.set(row.toolUseId, group);
	}
	// The output protocol keys by provider ID. Multiple visible parent rows must
	// remain unknown rather than attaching one row's child to another row.
	const parents = new Map(
		[...parentGroups].flatMap(([id, group]) =>
			group.length === 1 ? [[id, group[0]] as const] : [],
		),
	);
	// COW origins need not be caller-referenced. Fetch them by immutable PK, not
	// provider ID; they validate ancestry but never participate in visible uniqueness.
	const visibleIds = new Set(parentRows.map((row) => row.id));
	const originIds = [
		...new Set(
			[...parents.values()].flatMap((parent) =>
				parent.executionOriginToolCallId && !visibleIds.has(parent.executionOriginToolCallId)
					? [parent.executionOriginToolCallId]
					: [],
			),
		),
	];
	const originRows = originIds.length
		? tx
				.select({
					...historyToolMetadataColumns,
					executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
				})
				.from(narratorToolCalls)
				.where(inArray(narratorToolCalls.id, originIds))
				.limit(AGGREGATE_METADATA_LIMIT + 1)
				.all()
		: [];
	assertAggregateBudget(parentRows.length + originRows.length);
	const originals = new Map([...parentRows, ...originRows].map((row) => [row.id, row]));
	const callerChildRef = sql<boolean>`EXISTS (SELECT 1 FROM narrator_message_refs aggregate_ref
		WHERE aggregate_ref.narrator_id = ${narratorId}
		AND aggregate_ref.message_id = narrator_messages.id
		AND aggregate_ref.segment_compact_id IS NULL)`;
	const childScopes: Array<SQL | undefined> = [];
	const ownerScopes: Array<SQL | undefined> = [];
	const parentByOrigin = new Map<string, string | null>();
	for (const parent of parents.values()) {
		if (!SUBAGENT_TOOL_NAMES.has(parent.toolName)) {
			childScopes.push(and(eq(narratorMessages.parentToolUseId, parent.toolUseId), callerChildRef));
			continue;
		}
		const originId = parent.executionOriginToolCallId ?? parent.id;
		const original = originals.get(originId);
		if (
			(parent.toolName !== "Agent" && parent.toolName !== "Task") ||
			parent.executionIdentityVersion !== 1 ||
			(original &&
				(original.executionOriginToolCallId !== null ||
					original.executionIdentityVersion !== 1 ||
					original.isFileHistoryCheckpoint ||
					original.toolUseId !== parent.toolUseId ||
					(original.toolName !== "Agent" && original.toolName !== "Task")))
		)
			continue;
		// A deleted original cannot validate conflicting provider IDs on COW copies.
		// Do not let the last copy bind an owner's EXISTS proof to another group.
		parentByOrigin.set(originId, parentByOrigin.has(originId) ? null : parent.toolUseId);
		ownerScopes.push(
			and(
				eq(narrators.originToolCallId, originId),
				eq(narrators.type, "subagent"),
				sql`${narrators.variant} GLOB 'subagent:*'`,
				original
					? eq(narrators.parentNarratorId, original.narratorId)
					: isNotNull(narrators.parentNarratorId),
				// Author refs prove that this owner still has real child history, but
				// EXISTS never materializes its transcript merely to identify the owner.
				sql`EXISTS (SELECT 1 FROM narrator_messages aggregate_child
					INNER JOIN narrator_message_refs aggregate_author_ref
					ON aggregate_author_ref.message_id = aggregate_child.id
					AND aggregate_author_ref.narrator_id = ${narrators.id}
					AND aggregate_author_ref.segment_compact_id IS NULL
					WHERE aggregate_child.narrator_id = ${narrators.id}
					AND aggregate_child.parent_tool_use_id = ${parent.toolUseId})`,
			),
		);
	}
	// Budget distinct owner entities separately from caller-referenced inline rows.
	// A child with a long transcript must not exhaust either metadata budget.
	const ownerRows = ownerScopes.length
		? tx
				.select({
					id: narrators.id,
					originToolCallId: narrators.originToolCallId,
					parentNarratorId: narrators.parentNarratorId,
					variant: narrators.variant,
					model: narrators.model,
					reasoningEffort: narrators.reasoningEffort,
				})
				.from(narrators)
				.where(or(...ownerScopes))
				.limit(AGGREGATE_METADATA_LIMIT + 1)
				.all()
		: [];
	assertAggregateBudget(ownerRows.length);
	const childRows =
		childScopes.length > 0
			? tx
					.select({
						id: narratorMessages.id,
						narratorId: narratorMessages.narratorId,
						parentToolUseId: narratorMessages.parentToolUseId,
						callerSeq: sql<
							number | null
						>`(SELECT aggregate_ref.seq FROM narrator_message_refs aggregate_ref
			WHERE aggregate_ref.narrator_id = ${narratorId}
			AND aggregate_ref.message_id = narrator_messages.id
			AND aggregate_ref.segment_compact_id IS NULL)`,
					})
					.from(narratorMessages)
					.innerJoin(narrators, eq(narrators.id, narratorMessages.narratorId))
					.where(or(...childScopes))
					.limit(AGGREGATE_METADATA_LIMIT + 1)
					.all()
			: [];
	assertAggregateBudget(childRows.length);
	const inlineRows: Array<{
		id: string;
		narratorId: string;
		parentToolUseId: string;
		seq: number;
	}> = [];
	const ownerGroups = new Map<string, Map<string, SubagentActivityOwner>>();
	for (const row of childRows) {
		if (!row.parentToolUseId) continue;
		const parent = parents.get(row.parentToolUseId);
		if (!parent) continue;
		// Legacy inline responses remain readable only with an actual caller ref.
		if (!SUBAGENT_TOOL_NAMES.has(parent.toolName) && row.callerSeq !== null)
			inlineRows.push({
				id: row.id,
				narratorId: row.narratorId,
				parentToolUseId: row.parentToolUseId,
				seq: row.callerSeq,
			});
	}
	for (const row of ownerRows) {
		const parentToolUseId = row.originToolCallId && parentByOrigin.get(row.originToolCallId);
		if (!parentToolUseId || !row.parentNarratorId || !isSubagentVariant(row.variant)) continue;
		const group = ownerGroups.get(parentToolUseId) ?? new Map<string, SubagentActivityOwner>();
		const parent = parents.get(parentToolUseId);
		if (!parent) continue;
		group.set(row.id, {
			parentToolUseId,
			subagentNarratorId: row.id,
			model: row.model,
			reasoningEffort: row.reasoningEffort,
		});
		ownerGroups.set(parentToolUseId, group);
	}
	const owners = [...ownerGroups.values()].flatMap((group) =>
		group.size === 1 ? [...group.values()] : [],
	);
	return { parents, inlineRows, owners };
}

function loadAggregateRefMessagesTx(tx: MessageTx, narratorId: string, messageIds: string[]) {
	const ids = [...new Set(messageIds)];
	assertAggregateBudget(ids.length);
	if (ids.length === 0) return [];
	const refs = tx
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				inArray(narratorMessageRefs.messageId, ids),
				isNull(narratorMessageRefs.segmentCompactId),
			),
		)
		.limit(AGGREGATE_METADATA_LIMIT + 1)
		.all();
	if (refs.length !== ids.length)
		throw new AppError(
			"History aggregation references changed; reload the history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	const messages = tx
		.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorMessages))) })
		.from(narratorMessages)
		.where(inArray(narratorMessages.id, ids))
		.limit(AGGREGATE_METADATA_LIMIT + 1)
		.all();
	const tools = tx
		.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
		.from(narratorToolCalls)
		.where(inArray(narratorToolCalls.messageId, ids))
		.limit(AGGREGATE_METADATA_LIMIT + 1)
		.all();
	assertAggregateBudget(
		messages.length + tools.length,
		[...messages, ...tools].reduce((sum, row) => sum + row.bytes, 0),
	);
	return tx.query.narratorMessages
		.findMany({
			where: inArray(narratorMessages.id, ids),
			with: { toolCalls: true, creator: true },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit: AGGREGATE_METADATA_LIMIT,
		})
		.sync();
}

function loadAggregateInlineMessages(narratorId: string, toolUseIds: string[]) {
	return db.transaction((tx) => {
		const scope = resolveAggregateScopeTx(tx, narratorId, toolUseIds);
		return loadAggregateRefMessagesTx(
			tx,
			narratorId,
			scope.inlineRows.map((row) => row.id),
		);
	});
}

async function loadSubagentActivitiesForToolUseIds(
	narratorId: string,
	toolUseIds: string[],
): Promise<Map<string, SubagentActivity>> {
	if (toolUseIds.length === 0) return new Map();
	const scope = db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, toolUseIds));
	const activities = await buildSubagentActivities(scope.owners, toolUseIds);
	// Summary/file aggregation can await other services. A removed caller/child
	// ref must revoke this response too, rather than publishing a stale owner.
	const current = db.transaction((tx) => resolveAggregateScopeTx(tx, narratorId, toolUseIds));
	if (
		JSON.stringify(current.owners) !== JSON.stringify(scope.owners) ||
		JSON.stringify([...current.parents]) !== JSON.stringify([...scope.parents])
	) {
		throw new AppError(
			"History aggregation scope changed; reload the history window.",
			409,
			"HISTORY_AGGREGATE_UNAVAILABLE",
		);
	}
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
		loadSubagentActivitiesForToolUseIds(narratorId, subagentToolUseIds),
		loadAggregateInlineMessages(narratorId, inlineToolUseIds),
	]);
	attachSubagentActivities(topMessages, activities);
	const enriched = enrichToolUseBlocks(
		filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages]), ioBudget),
		),
	);
	// A still-waiting Await knows its target only as a selector; resolve it so the
	// row can open the child's session before the wait returns.
	const awaitAgentIds = await resolveAwaitAgentIdsForMessages([...topMessages, ...childMessages]);
	return attachTakenOverFlags(
		await attachSendTargetDetails(
			attachActiveSendDeliveryTargets(attachAwaitAgentNarratorIds(enriched, awaitAgentIds)),
		),
		collectTakenOverToolUseIds(activities, awaitAgentIds),
	);
}

/**
 * The tool calls on this page whose target subagent is currently taken over.
 *
 * Reuses facts ALREADY in hand — no extra query:
 *   - `activities`   → an Agent/Task/Send card's child narrator id
 *   - `awaitAgentIds`→ a running `Await({type:"agent"})`'s resolved child id
 *
 * Takeover authority is the in-memory Set (`subagent-takeover.ts`), so the
 * membership test is synchronous. A finished Await needs no flag: its output
 * already states `taken_over` in words.
 *
 * Uses the DISPLAY list, which excludes subagents whose release is merely
 * deferred to their loop end — see `isTakeoverReleasePending`.
 */
function collectTakenOverToolUseIds(
	activities: ReadonlyMap<string, SubagentActivity>,
	awaitAgentIds: ReadonlyMap<string, string>,
): Set<string> {
	const flagged = new Set<string>();
	const takenOver = new Set(listDisplayTakenOverSubagents());
	if (takenOver.size === 0) return flagged;
	for (const [toolUseId, activity] of activities) {
		const child = activity.subagentNarratorId;
		if (child && takenOver.has(child)) flagged.add(toolUseId);
	}
	for (const [toolUseId, child] of awaitAgentIds) {
		if (takenOver.has(child)) flagged.add(toolUseId);
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
const TOOL_DETAIL_CANDIDATE_LIMIT = 200;
const TOOL_DETAIL_METADATA_ROW_LIMIT = 1_000;
const TOOL_DETAIL_PAYLOAD_BYTE_LIMIT = 32 * 1024 * 1024;

type ToolDetailReference = { toolCallId?: string; messageId?: string };

function toolDetailSelectionRequired(): AppError {
	return new AppError(
		"Tool detail selection is ambiguous or exceeds the metadata budget; specify toolCallId or messageId.",
		409,
		"TOOL_CALL_DETAIL_SELECTION_REQUIRED",
	);
}

function toolMessageRefExists(narratorId: string | AnyColumn): SQL<boolean> {
	// Keep the outer table qualification literal. Drizzle strips Column qualifiers
	// in single-table projections, which would correlate message_id to detail_ref
	// itself and accidentally authorize every tool whenever any caller ref exists.
	return sql<boolean>`EXISTS (
		SELECT 1 FROM narrator_message_refs detail_ref
		WHERE detail_ref.narrator_id = ${narratorId}
			AND detail_ref.message_id = narrator_tool_calls.message_id
	)`;
}

/** Authorize and load a single row in the same read transaction (no async TOCTOU). */
function selectVisibleToolCallTx(
	tx: MessageTx,
	narratorId: string,
	toolUseId: string,
	reference?: ToolDetailReference,
) {
	for (const value of [reference?.toolCallId, reference?.messageId]) {
		if (
			value !== undefined &&
			(typeof value !== "string" || value.length === 0 || value.length > 128)
		) {
			throw new ValidationError(
				"Tool detail references must be non-empty IDs of at most 128 characters",
			);
		}
	}
	let metadataRows = 0;
	const admit = (length: number) => {
		metadataRows += length;
		if (length > TOOL_DETAIL_CANDIDATE_LIMIT || metadataRows > TOOL_DETAIL_METADATA_ROW_LIMIT) {
			throw toolDetailSelectionRequired();
		}
	};
	const parentColumns = {
		...historyToolMetadataColumns,
		executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
		directRef: toolMessageRefExists(narratorId),
	};
	const candidates = tx
		.select({
			...parentColumns,
			messageNarratorId: narratorMessages.narratorId,
			parentToolUseId: narratorMessages.parentToolUseId,
			authorType: narrators.type,
			authorVariant: narrators.variant,
			authorParentNarratorId: narrators.parentNarratorId,
			authorOriginToolCallId: narrators.originToolCallId,
			authorRef: toolMessageRefExists(narratorMessages.narratorId),
		})
		.from(narratorToolCalls)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
		.innerJoin(narrators, eq(narrators.id, narratorMessages.narratorId))
		.where(
			and(
				eq(narratorToolCalls.toolUseId, toolUseId),
				reference?.toolCallId !== undefined
					? eq(narratorToolCalls.id, reference.toolCallId)
					: undefined,
				reference?.messageId !== undefined
					? eq(narratorToolCalls.messageId, reference.messageId)
					: undefined,
			),
		)
		.limit(TOOL_DETAIL_CANDIDATE_LIMIT + 1)
		.all();
	admit(candidates.length);
	const childVisibility = new Map<string, boolean>();
	const visible = candidates.filter((candidate) => {
		if (candidate.directRef) return true;
		// A provider-supplied parentToolUseId is only a consistency check after the
		// real subagent identity and original tool-call PK have established ancestry.
		if (
			candidate.authorType !== "subagent" ||
			!isSubagentVariant(candidate.authorVariant) ||
			!candidate.authorOriginToolCallId ||
			!candidate.authorParentNarratorId ||
			!candidate.parentToolUseId ||
			!candidate.authorRef ||
			candidate.narratorId !== candidate.messageNarratorId
		)
			return false;
		const originId = candidate.authorOriginToolCallId;
		const key = JSON.stringify([candidate.messageNarratorId, originId, candidate.parentToolUseId]);
		const cached = childVisibility.get(key);
		if (cached !== undefined) return cached;
		const isAgent = (call: {
			toolName: string;
			executionIdentityVersion: number;
			isFileHistoryCheckpoint: boolean;
		}) =>
			(call.toolName === "Agent" || call.toolName === "Task") &&
			call.executionIdentityVersion === 1 &&
			!call.isFileHistoryCheckpoint;
		const original = tx
			.select(parentColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, originId))
			.get();
		admit(original ? 1 : 0);
		if (
			original &&
			(!isAgent(original) ||
				original.executionOriginToolCallId !== null ||
				original.narratorId !== candidate.authorParentNarratorId ||
				original.toolUseId !== candidate.parentToolUseId)
		) {
			childVisibility.set(key, false);
			return false;
		}
		if (original?.directRef) {
			childVisibility.set(key, true);
			return true;
		}
		// The original may have been removed after COW. Its immutable PK survives
		// in the copy; neither a shared provider ID nor an author's identity alone
		// is enough. The requesting narrator must still reference that exact copy.
		const parentCopies = tx
			.select(parentColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.toolUseId, candidate.parentToolUseId))
			.limit(TOOL_DETAIL_CANDIDATE_LIMIT + 1)
			.all();
		admit(parentCopies.length);
		const allowed = parentCopies.some(
			(parent) =>
				parent.directRef && isAgent(parent) && parent.executionOriginToolCallId === originId,
		);
		childVisibility.set(key, allowed);
		return allowed;
	});
	if (visible.length === 0) throw new NotFoundError("ToolCall", toolUseId);
	if (visible.length !== 1) throw toolDetailSelectionRequired();
	return visible[0];
}

function getToolCallDetailTx(
	tx: MessageTx,
	narratorId: string,
	toolUseId: string,
	reference?: ToolDetailReference,
) {
	const selected = selectVisibleToolCallTx(tx, narratorId, toolUseId, reference);
	// Even a unique authorized row has a response budget. Never truncate it and
	// claim it is complete, or parse a large payload just to discover its length.
	const size = tx
		.select({ bytes: storedRowBytes(Object.values(getTableColumns(narratorToolCalls))) })
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!size) throw new NotFoundError("ToolCall", toolUseId);
	if (size.bytes > TOOL_DETAIL_PAYLOAD_BYTE_LIMIT) {
		throw new AppError(
			"Tool detail exceeds the payload byte limit",
			413,
			"TOOL_CALL_DETAIL_TOO_LARGE",
		);
	}
	const detail = tx
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, selected.id))
		.get();
	if (!detail) throw new NotFoundError("ToolCall", toolUseId);
	return toolCallWithExecutionTargets(detail);
}

// ── narratorMessages object ────────────────────────────────────────────────

const narratorMessageQueriesUnlocked = {
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
		return messages.map((message) => ({
			...message,
			toolCalls: latestToolCallAttempts(message.toolCalls),
		}));
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
	async getModelHistorySinceLastCompact(narratorId: string, limit?: number) {
		const compactSeq = await this.getLatestCompactSeq(narratorId);
		const refQuery = db
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
		const refRows = await (limit == null
			? refQuery
			: refQuery.limit(Math.min(Math.max(Math.trunc(limit), 1), 2000)));
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
				createdBy: true,
				origin: true,
				originLabel: true,
			},
			with: {
				// Only public identity fields, never credentials or the complete user row.
				creator: { columns: { username: true } },
				narrator: { columns: { title: true } },
				toolCalls: {
					columns: {
						id: true,
						executionAttempt: true,
						createdAt: true,
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
		return modelMessages.map((message) => ({
			...message,
			toolCalls: latestToolCallAttempts(message.toolCalls),
		}));
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
			with: {
				toolCalls: true,
				creator: { columns: { username: true } },
				narrator: { columns: { title: true } },
			},
		});

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
		const rows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
				role: narratorMessages.role,
				createdAt: narratorMessages.createdAt,
				toolCount,
				byteSize,
				preview: sql<string | null>`substr(COALESCE(${narratorMessages.contentText}, ''), 1, 160)`,
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
			.limit(HISTORY_RECOVERY_CANDIDATES);
		const maxSeqRow = await db
			.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					isNull(narratorMessageRefs.segmentCompactId),
				),
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
		const isTopLevelRef = () =>
			exists(
				db
					.select({ one: sql`1` })
					.from(narratorMessages)
					.where(
						and(
							eq(narratorMessages.id, narratorMessageRefs.messageId),
							isNull(narratorMessages.parentToolUseId),
						),
					),
			);
		const baseConditions = [
			eq(narratorMessageRefs.narratorId, narratorId),
			isNull(narratorMessageRefs.segmentCompactId),
			...(isSubagent ? [] : [isTopLevelRef()]),
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
					narratorId,
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
				limit: AGGREGATE_METADATA_LIMIT + 1,
			});
			assertAggregateBudget(rows.length);
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
				const scope = db.transaction((tx) =>
					resolveAggregateScopeTx(tx, narratorId, [parentMessage.parentToolUseId as string]),
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
		const allMessages = db.transaction((tx) =>
			loadAggregateRefMessagesTx(tx, narratorId, messageIds),
		);

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
			const extraChildren = loadAggregateInlineMessages(narratorId, inlineTopToolUseIds);
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
		return db.transaction((tx) => getToolCallDetailTx(tx, narratorId, toolUseId, reference));
	},

	async getToolCallPreviewMetadata(
		narratorId: string,
		toolUseId: string,
		reference?: ToolDetailReference,
	) {
		return db.transaction((tx) => {
			const selected = selectVisibleToolCallTx(tx, narratorId, toolUseId, reference);
			const row = tx
				.select(toolEditPreviewColumns)
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, selected.id))
				.get();
			if (!row) throw new NotFoundError("ToolCall", toolUseId);
			return row;
		});
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
			const live =
				compactBlock.status === "compacting" ? liveCompactProgress.get(messageId) : undefined;
			return {
				status: compactBlock.status,
				summary: typeof compactBlock.summary === "string" ? compactBlock.summary : "",
				...(live
					? {
							model: live.model || latestAttempt?.model,
							reasoningEffort: live.reasoningEffort,
							startedAt: live.startedAt,
							output: live.output,
							thinking: live.thinking,
							outputChars: live.outputChars,
							thinkingChars: live.thinkingChars,
							outputTruncated: live.outputTruncated,
							thinkingTruncated: live.thinkingTruncated,
						}
					: {
							model: latestAttempt?.model,
							startedAt: latestAttempt?.startedAt,
							finishedAt: latestAttempt?.finishedAt,
						}),
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
		return deleteOutputlessAssistantMessage(narratorId, messageId, "reasoning-only");
	},

	/** Retry-only cleanup of one empty record without tool/file/history boundaries. */
	async deleteEmptyRetryPlaceholder(narratorId: string, messageId: string): Promise<boolean> {
		return deleteOutputlessAssistantMessage(narratorId, messageId, "empty-placeholder");
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
