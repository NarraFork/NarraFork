import { parseCompactMessageBlock } from "@shared/compact-message";
import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import { isMetadataOnlyEmptyReasoningAssistantMessage } from "@shared/reasoning-content";
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
import {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { resolveDefaultReasoningEffort, resolveProvider } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	commitSnapshotRevert,
	revertPatchesForMessages,
	revertPatchForToolUse,
} from "./snapshot-revert";

// ── Internal helpers ───────────────────────────────────────────────────────

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
				sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
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

function sideCarDedupeKey(sideCar: Record<string, unknown>): string {
	if (typeof sideCar.id === "string" && sideCar.id) return sideCar.id;
	return [
		sideCar.target,
		sideCar.source,
		sideCar.toolUseId ?? "",
		sideCar.orderIndex ?? "",
		sideCar.content,
	].join("\u0000");
}

function mergeSideCars(existing: unknown, additional: unknown[]): unknown[] {
	const merged: unknown[] = [];
	const seen = new Set<string>();
	for (const sideCar of [...(Array.isArray(existing) ? existing : []), ...additional]) {
		if (!sideCar || typeof sideCar !== "object") continue;
		const key = sideCarDedupeKey(sideCar as Record<string, unknown>);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(sideCar);
	}
	return merged;
}

/**
 * Relation loading only returns sidecars linked through message_id. Some historical
 * tool-result sidecars were persisted with only tool_use_id, so hydrate them onto
 * their owning message before truncateToolIO/enrichToolUseBlocks attach them to
 * tool call records and content blocks.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
async function hydrateToolUseSideCars(messages: any[]): Promise<void> {
	if (messages.length === 0) return;
	const narratorIds = new Set<string>();
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const toolUseToMessages = new Map<string, Set<any>>();
	for (const msg of messages) {
		if (typeof msg.narratorId === "string") narratorIds.add(msg.narratorId);
		const register = (toolUseId: unknown) => {
			if (typeof toolUseId !== "string" || !toolUseId) return;
			let owners = toolUseToMessages.get(toolUseId);
			if (!owners) {
				owners = new Set();
				toolUseToMessages.set(toolUseId, owners);
			}
			owners.add(msg);
		};
		for (const tc of msg.toolCalls ?? []) {
			register(tc.toolUseId);
		}
		for (const block of Array.isArray(msg.contentJson) ? msg.contentJson : []) {
			if (block?.type === "tool_use") register(block.id);
		}
	}

	const narratorIdList = [...narratorIds];
	const toolUseIds = [...toolUseToMessages.keys()];
	if (narratorIdList.length === 0 || toolUseIds.length === 0) return;

	const sideCars = await db.query.narratorSidecars.findMany({
		where: and(
			inArray(narratorSidecars.narratorId, narratorIdList),
			inArray(narratorSidecars.toolUseId, toolUseIds),
			eq(narratorSidecars.target, "tool_result"),
			isNull(narratorSidecars.messageId),
		),
		orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
	});

	for (const sideCar of sideCars) {
		if (!sideCar.toolUseId) continue;
		const owners = toolUseToMessages.get(sideCar.toolUseId);
		if (!owners) continue;
		for (const msg of owners) {
			msg.sideCars = mergeSideCars(msg.sideCars, [sideCar]);
		}
	}
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

/** Truncate a JSON value to a preview string if it exceeds maxLen characters */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateJson(val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	return { _truncated: true, preview: str.slice(0, maxLen), fullLength: str.length };
}

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
 * Extract short header-relevant fields from a tool's inputJson before truncation.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function extractHeaderHints(toolName: string, input: any): Record<string, unknown> | undefined {
	if (!input || typeof input !== "object") return undefined;
	const h: Record<string, unknown> = {};
	const str = (k: string) => (typeof input[k] === "string" ? input[k] : undefined);
	const num = (k: string) => (typeof input[k] === "number" ? input[k] : undefined);

	switch (toolName) {
		case "Write":
		case "Edit":
		case "Read": {
			const fp = str("file_path") ?? str("filePath") ?? str("path");
			if (fp) h.file_path = fp;
			const offset = num("offset");
			if (offset != null) h.offset = offset;
			const limit = num("limit");
			if (limit != null) h.limit = limit;
			break;
		}
		case "Bash": {
			const cmd = str("command");
			if (cmd) h.command = cmd.length > 100 ? cmd.slice(0, 100) : cmd;
			// The card header prefers `description` over `command`; keep it in hints
			// so the low-LOD (body-dropped) projection still shows the bash summary.
			const desc = str("description");
			if (desc) h.description = desc.length > 100 ? desc.slice(0, 100) : desc;
			const timeout = num("timeout");
			if (timeout != null) h.timeout = timeout;
			break;
		}
		case "Glob":
		case "Grep": {
			const pat = str("pattern") ?? str("glob");
			if (pat) h.pattern = pat;
			const p = str("path");
			if (p) h.path = p;
			const g = str("glob");
			if (g) h.glob = g;
			break;
		}
		case "WebSearch": {
			const q = str("query");
			if (q) h.query = q;
			break;
		}
		case "WebFetch": {
			const url = str("url");
			if (url) h.url = url;
			const mode = str("mode");
			if (mode) h.mode = mode;
			break;
		}
		case "Terminal": {
			const action = str("action");
			if (action) h.action = action;
			const tid = str("terminal_id");
			if (tid) h.terminal_id = tid;
			const inp = str("input");
			if (inp) h.input = inp.length > 60 ? inp.slice(0, 60) : inp;
			break;
		}
		case "ShareFile": {
			const fp = str("path");
			if (fp) h.path = fp;
			break;
		}
		case "AskUserQuestion": {
			const qs = input.questions;
			if (Array.isArray(qs) && qs.length > 0 && typeof qs[0]?.header === "string") {
				h._firstHeader = qs[0].header;
			}
			break;
		}
		case "Recall": {
			const action = str("action");
			if (action) h.action = action;
			const q = str("query");
			if (q) h.query = q;
			const nid = str("narrator_id");
			if (nid) h.narrator_id = nid;
			const tcId = str("tool_call_id");
			if (tcId) h.tool_call_id = tcId;
			break;
		}
		case "ApprovePermission":
		case "DenyPermission":
		case "GetNarratorContext":
		case "ListManagedNarrators": {
			const rid = str("requestId");
			if (rid) h.requestId = rid;
			const nid = str("narratorId");
			if (nid) h.narratorId = nid;
			break;
		}
		default:
			return undefined;
	}
	return Object.keys(h).length > 0 ? h : undefined;
}

/**
 * Truncate inputJson with header hints attached.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function truncateInputWithHints(toolName: string, val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	const hints = extractHeaderHints(toolName, val);
	return {
		_truncated: true,
		preview: str.slice(0, maxLen),
		fullLength: str.length,
		...(hints && { _hints: hints }),
	};
}

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => {
		const msgSideCars = Array.isArray(msg.sideCars) ? msg.sideCars : [];
		return {
			...msg,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			toolCalls: msg.toolCalls?.map((tc: any) => {
				const toolSideCars = msgSideCars.filter((sc: Record<string, unknown>) => {
					return (
						sc.target === "tool_result" && (sc.toolUseId === tc.toolUseId || sc.toolUseId == null)
					);
				});
				const withSideCars = toolSideCars.length > 0 ? { ...tc, sideCars: toolSideCars } : tc;
				if (SKIP_TRUNCATE_TOOLS.has(tc.toolName)) return withSideCars;
				const skipInput =
					SKIP_INPUT_TRUNCATE_TOOLS.has(tc.toolName) || isSpecTasksInput(tc.toolName, tc.inputJson);
				return {
					...withSideCars,
					inputJson: skipInput
						? tc.inputJson
						: truncateInputWithHints(tc.toolName, tc.inputJson, maxLen),
					outputJson: truncateJson(tc.outputJson, maxLen),
				};
			}),
			children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
		};
	});
}

/**
 * Enrich tool_use blocks in contentJson with fields from the toolCalls relation.
 */
async function attachSideCarsToToolCall<T extends { narratorId: string; toolUseId: string }>(
	toolCall: T,
): Promise<T & { sideCars: unknown[] }> {
	const sideCars = await db.query.narratorSidecars.findMany({
		where: and(
			eq(narratorSidecars.narratorId, toolCall.narratorId),
			eq(narratorSidecars.toolUseId, toolCall.toolUseId),
			eq(narratorSidecars.target, "tool_result"),
		),
		orderBy: (s, { asc }) => [asc(s.orderIndex), asc(s.createdAt)],
	});
	return { ...toolCall, sideCars };
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
				sideCars: tc.sideCars,
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
				return {
					toolCallId: row.toolCallId ?? null,
					toolUseId: row.toolUseId,
					toolName: row.toolName,
					status: row.status,
					createdAt: row.createdAt ?? null,
					timing: Object.values(timing).some((value) => value != null) ? timing : null,
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
async function buildTreeFromTopLevelRefs(
	refRows: Array<{ messageId: string; seq: number }>,
	isSubagent: boolean,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
): Promise<any[]> {
	if (refRows.length === 0) return [];

	const messageIds = refRows.map((r) => r.messageId);
	const topMessages = await db.query.narratorMessages.findMany({
		where: inArray(narratorMessages.id, messageIds),
		with: { toolCalls: true, sideCars: true, creator: true },
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
					with: { toolCalls: true, sideCars: true, creator: true },
					orderBy: (m, { asc }) => [asc(m.createdAt)],
					limit: 500,
				})
			: Promise.resolve([]),
	]);
	attachSubagentActivities(topMessages, activities);
	await hydrateToolUseSideCars([...topMessages, ...childMessages]);
	return enrichToolUseBlocks(
		filterExitPlanBeforePlanCompact(
			truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
		),
	);
}

// ── Chunk manifest helpers ─────────────────────────────────────────────────

/** Number of top-level messages per chunk. Keep in sync with the frontend. */
export const CHUNK_SIZE = 20;

/** Compact manifest chunk tuple: [id, firstSeq, lastSeq, count]. */
type ManifestChunkTuple = [string, number, number, number];

interface ComputedManifest {
	messageVersion: number;
	total: number;
	chunks: ManifestChunkTuple[];
}

/**
 * Per-narrator manifest cache, keyed by narratorId and validated by
 * messageVersion. Because the manifest is a pure function of the ref table at a
 * given messageVersion, a cached entry whose version still matches is exact —
 * so even a first load (no client `since`) of a recently-viewed narrator skips
 * the full ref scan. Bounded LRU to cap memory.
 *
 * On off-threading: the remaining cost on a cache MISS is a single synchronous
 * indexed ref scan (~17-23ms on the largest histories) plus ~4ms of JS slicing.
 * That is one-time per (narrator, version) and below the threshold where a
 * worker + separate DB connection would pay for its complexity/risk. If a
 * pathological narrator (far beyond ~30k messages) ever makes the first-open
 * scan visibly block, revisit moving the scan to a worker then.
 */
const MANIFEST_CACHE_LIMIT = 64;
const manifestCache = new Map<string, ComputedManifest>();

function getCachedManifest(narratorId: string, version: number): ComputedManifest | null {
	const hit = manifestCache.get(narratorId);
	if (!hit || hit.messageVersion !== version) return null;
	// LRU touch.
	manifestCache.delete(narratorId);
	manifestCache.set(narratorId, hit);
	return hit;
}

function setCachedManifest(narratorId: string, entry: ComputedManifest): void {
	manifestCache.delete(narratorId);
	manifestCache.set(narratorId, entry);
	while (manifestCache.size > MANIFEST_CACHE_LIMIT) {
		const oldest = manifestCache.keys().next().value;
		if (oldest === undefined) break;
		manifestCache.delete(oldest);
	}
}

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
			with: { toolCalls: true, sideCars: true },
		});
		const seqMap = new Map(refRows.map((row) => [row.messageId, row.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		await hydrateToolUseSideCars(messages);
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
			with: { toolCalls: true, sideCars: true },
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
		await hydrateToolUseSideCars(messages);
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
				sideCars: {
					columns: {
						id: true,
						messageId: true,
						toolUseId: true,
						target: true,
						source: true,
						content: true,
						orderIndex: true,
						createdAt: true,
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
		await hydrateToolUseSideCars(modelMessages);
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
			with: { toolCalls: true, sideCars: true },
		});

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		// A failed earlier compact marker may sit inside this retry range. Keep it
		// visible in the transcript, but never summarize it into a later compact.
		const compactableMessages = messages.filter((message) => !isCompactLifecycleMessage(message));
		await hydrateToolUseSideCars(compactableMessages);
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
	 * Lightweight chunk manifest for the virtualized message list.
	 *
	 * Reads ONLY the narrow narrator_message_refs join (indexed by seq), never
	 * the large content_json/output_json payloads. Returns one fingerprint per
	 * CHUNK_SIZE top-level messages so the client can detect which chunks changed
	 * without refetching content. When `sinceVersion` matches the current
	 * messageVersion, short-circuits with `{ unchanged: true }`.
	 */
	/**
	 * Compute (or read from cache) the FULL manifest for a narrator at the given
	 * messageVersion. The full chunk array is the cheap part (one indexed ref
	 * scan + JS slicing) and stays cached so windowed reads never rescan. Pure
	 * function of the ref table at this version, so a cached hit is exact.
	 */
	async computeFullManifest(narratorId: string, messageVersion: number): Promise<ComputedManifest> {
		const cached = getCachedManifest(narratorId, messageVersion);
		if (cached) return cached;

		const isSubagent = await this.isSubagentNarrator(narratorId);

		// Narrow query: seq + messageId only, ordered by seq. No large columns,
		// no COUNT(*). Uses idx_narrator_refs_seq.
		//
		// Primary narrators never have refs pointing to child (parent_tool_use_id
		// IS NOT NULL) messages — children are not referenced in the junction
		// table — so the join to narrator_messages would filter nothing and is
		// pure overhead (≈4x slower on large histories). Skip it entirely and
		// query the narrow refs table alone. Subagent narrators legitimately hold
		// child refs as top-level, so they keep the (cheap, small) join path.
		const refRows = isSubagent
			? await db
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
					})
					.from(narratorMessageRefs)
					.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							isNull(narratorMessageRefs.segmentCompactId),
						),
					)
					.orderBy(narratorMessageRefs.seq)
			: await db
					.select({
						messageId: narratorMessageRefs.messageId,
						seq: narratorMessageRefs.seq,
					})
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							isNull(narratorMessageRefs.segmentCompactId),
						),
					)
					.orderBy(narratorMessageRefs.seq);

		// Compact tuple payload: [id, firstSeq, lastSeq, count]. Tuples avoid
		// repeating object keys ~1.5k times (≈60% smaller wire/parse than an
		// array of objects). The structural fingerprint (hash) is intentionally
		// omitted here — it is only needed by the (not-yet-built) chunks_dirty
		// incremental reconciliation, and would otherwise cost wire bytes + a
		// djb2 pass per chunk for no current consumer.
		const chunks: ManifestChunkTuple[] = [];
		for (let i = 0; i < refRows.length; i += CHUNK_SIZE) {
			const slice = refRows.slice(i, i + CHUNK_SIZE);
			const first = slice[0];
			const last = slice[slice.length - 1];
			chunks.push([first.messageId, first.seq, last.seq, slice.length]);
		}

		const entry: ComputedManifest = { messageVersion, total: refRows.length, chunks };
		setCachedManifest(narratorId, entry);
		return entry;
	},

	/**
	 * Lightweight chunk manifest for the virtualized message list.
	 *
	 * Reads ONLY the narrow narrator_message_refs join (indexed by seq), never
	 * the large content_json/output_json payloads. Returns one fingerprint per
	 * CHUNK_SIZE top-level messages so the client can detect which chunks changed
	 * without refetching content. When `sinceVersion` matches the current
	 * messageVersion, short-circuits with `{ unchanged: true }`.
	 *
	 * Windowing: the client opens with only the newest `limitChunks` chunks and
	 * walks older bands via `beforeSeq` (reverse infinite scroll). The full chunk
	 * array is still computed/cached server-side (cheap), but only the requested
	 * window is sent on the wire. `total` is always the full top-level count so
	 * callers know the true history size; `windowFirstIndex`/`hasOlderChunks`
	 * locate the window inside the full history.
	 */
	async getChunkManifest(
		narratorId: string,
		sinceVersion?: number,
		window?: { limitChunks?: number; beforeSeq?: number },
	): Promise<
		| { unchanged: true; messageVersion: number }
		| {
				unchanged: false;
				messageVersion: number;
				total: number;
				/** Index of the first returned chunk within the full history. */
				windowFirstIndex: number;
				/** True when chunks older than the returned window exist. */
				hasOlderChunks: boolean;
				/** Compact tuples: [id, firstSeq, lastSeq, count]. */
				chunks: Array<[string, number, number, number]>;
		  }
	> {
		const messageVersion = await this.getMessageVersion(narratorId);
		if (sinceVersion != null && sinceVersion === messageVersion) {
			return { unchanged: true, messageVersion };
		}

		const full = await this.computeFullManifest(narratorId, messageVersion);
		const allChunks = full.chunks;

		// Resolve the window [windowFirstIndex, windowEnd) over the full chunk
		// array. `beforeSeq` walks older: take the chunks whose firstSeq < beforeSeq,
		// keeping the newest `limit` of them. No `beforeSeq` → newest `limit`.
		const limit =
			window?.limitChunks != null && Number.isFinite(window.limitChunks)
				? Math.min(Math.max(Math.trunc(window.limitChunks), 1), 200)
				: allChunks.length;
		let windowEnd = allChunks.length; // exclusive
		if (window?.beforeSeq != null && Number.isFinite(window.beforeSeq)) {
			// First chunk index whose firstSeq >= beforeSeq; everything before it is older.
			let idx = allChunks.length;
			for (let i = 0; i < allChunks.length; i++) {
				if (allChunks[i][1] >= window.beforeSeq) {
					idx = i;
					break;
				}
			}
			windowEnd = idx;
		}
		const windowFirstIndex = Math.max(0, windowEnd - limit);
		const chunks = allChunks.slice(windowFirstIndex, windowEnd);

		return {
			unchanged: false,
			messageVersion,
			total: full.total,
			windowFirstIndex,
			hasOlderChunks: windowFirstIndex > 0,
			chunks,
		};
	},

	/**
	 * Fetch a contiguous range of top-level messages (with full child trees) for
	 * the virtualized list. Replaces the legacy 20/50 + around triple-path.
	 *
	 * - direction "older": messages with seq < fromSeq (descending then reversed)
	 * - direction "newer": messages with seq > fromSeq (ascending)
	 * - fromSeq omitted: the latest tail
	 *
	 * `count` is expressed in chunks; the row limit is count * CHUNK_SIZE. Uses
	 * LIMIT n+1 for the queried direction and a separate indexed LIMIT 1 existence
	 * probe for the opposite edge, so hasOlder/hasNewer are exact without a COUNT(*).
	 */
	async getChunksByRange(
		narratorId: string,
		opts: { fromSeq?: number; direction?: "older" | "newer"; count?: number } = {},
	) {
		const direction = opts.direction ?? "older";
		const chunkCount = Math.min(Math.max(opts.count ?? 7, 1), 20);
		const rowLimit = chunkCount * CHUNK_SIZE;
		const isSubagent = await this.isSubagentNarrator(narratorId);

		// Base predicate shared by the window query and the opposite-edge existence
		// probe below. Excludes the seq cursor so it can be reused for either side.
		const baseConditions = [
			eq(narratorMessageRefs.narratorId, narratorId),
			isNull(narratorMessageRefs.segmentCompactId),
			...(isSubagent ? [] : [isNull(narratorMessages.parentToolUseId)]),
		];
		const conditions = [...baseConditions];
		if (opts.fromSeq != null && Number.isFinite(opts.fromSeq)) {
			conditions.push(
				direction === "newer"
					? gt(narratorMessageRefs.seq, opts.fromSeq)
					: lt(narratorMessageRefs.seq, opts.fromSeq),
			);
		}

		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(and(...conditions))
			.orderBy(
				direction === "newer" ? narratorMessageRefs.seq : sql`${narratorMessageRefs.seq} DESC`,
			)
			.limit(rowLimit + 1);

		const hasMoreInDirection = refRows.length > rowLimit;
		const pageRows = hasMoreInDirection ? refRows.slice(0, rowLimit) : refRows;
		if (direction === "older") {
			pageRows.reverse();
		}

		const messageVersion = await this.getMessageVersion(narratorId);

		if (pageRows.length === 0) {
			return {
				messages: [],
				minSeq: null,
				maxSeq: null,
				hasOlder: false,
				hasNewer: false,
				messageVersion,
			};
		}

		const tree = await buildTreeFromTopLevelRefs(pageRows, isSubagent);
		const minSeq = pageRows[0].seq;
		const maxSeq = pageRows[pageRows.length - 1].seq;

		// hasOlder/hasNewer relative to the returned window. For the direction we
		// queried, hasMoreInDirection answers it directly. For the opposite side,
		// probe for the existence of a single row beyond the window edge — a small,
		// indexed LIMIT 1 lookup, not a heuristic based on seq sign/anchor presence.
		const existsBeyond = async (op: "older" | "newer", edgeSeq: number): Promise<boolean> => {
			const row = await db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						...baseConditions,
						op === "newer"
							? gt(narratorMessageRefs.seq, edgeSeq)
							: lt(narratorMessageRefs.seq, edgeSeq),
					),
				)
				.limit(1);
			return row.length > 0;
		};

		const hasOlder =
			direction === "older" ? hasMoreInDirection : await existsBeyond("older", minSeq);
		const hasNewer =
			direction === "newer" ? hasMoreInDirection : await existsBeyond("newer", maxSeq);

		return {
			messages: tree,
			minSeq,
			maxSeq,
			hasOlder,
			hasNewer,
			messageVersion,
		};
	},

	/**
	 * Exact-layout input page. This is a transport page only: it carries ordered
	 * full message trees and never defines a scrollbar unit or height estimate.
	 * The client must collect the complete document before committing a layout.
	 */
	async getPretextDocumentPage(
		narratorId: string,
		opts: { afterSeq?: number; limit?: number; messageVersion?: number } = {},
	) {
		const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 100);
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
		const conditions = [
			eq(narratorMessageRefs.narratorId, narratorId),
			isNull(narratorMessageRefs.segmentCompactId),
			...(isSubagent ? [] : [isNull(narratorMessages.parentToolUseId)]),
		];
		if (opts.afterSeq != null && Number.isFinite(opts.afterSeq))
			conditions.push(gt(narratorMessageRefs.seq, Math.trunc(opts.afterSeq)));
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(and(...conditions))
			.orderBy(asc(narratorMessageRefs.seq))
			.limit(limit + 1);
		const hasNext = refRows.length > limit;
		const pageRows = hasNext ? refRows.slice(0, limit) : refRows;
		if (pageRows.length === 0) {
			await assertDocumentUnchanged();
			return { messages: [], minSeq: null, maxSeq: null, hasNext: false, messageVersion };
		}
		const tree = await buildTreeFromTopLevelRefs(pageRows, isSubagent);
		await assertDocumentUnchanged();
		return {
			messages: tree,
			minSeq: pageRows[0]?.seq ?? null,
			maxSeq: pageRows.at(-1)?.seq ?? null,
			hasNext,
			messageVersion,
		};
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
			with: { toolCalls: true, sideCars: true, creator: true },
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
				with: { toolCalls: true, sideCars: true, creator: true },
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
		await hydrateToolUseSideCars([...topMsgs, ...childMsgs]);
		const tree = enrichToolUseBlocks(
			filterExitPlanBeforePlanCompact(truncateToolIO(buildMessageTree([...topMsgs, ...childMsgs]))),
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
			orphanChildren: enrichToolUseBlocks(truncateToolIO(orphanChildren)),
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
			if (directRef) return attachSideCarsToToolCall(candidate);

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
			if (parentRef) return attachSideCarsToToolCall(candidate);
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
				tx.delete(narratorSidecars).where(eq(narratorSidecars.messageId, messageId)).run();
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

	async deleteMessage(narratorId: string, messageId: string, opts?: { skipRevert?: boolean }) {
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
			const snapshotRevert = await revertPatchesForMessages(narratorId, messageIds);
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
		opts?: { preserveConversationId?: boolean; skipRevert?: boolean },
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
		if (opts?.skipRevert) {
			mutate();
		} else {
			const snapshotRevert = await revertPatchesForMessages(narratorId, messageIds);
			await commitSnapshotRevert(snapshotRevert, mutate);
		}

		return { deletedCount: refsToRemove.length, deletedMessageIds: messageIds };
	},

	async deleteMessageBlock(
		narratorId: string,
		messageId: string,
		blockIndex: number,
		opts?: { skipRevert?: boolean; skipNarratorUpdate?: boolean; preserveConversationId?: boolean },
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
		const snapshotRevert =
			!opts?.skipRevert && removedBlock.type === "tool_use" && removedBlock.id
				? await revertPatchForToolUse(narratorId, removedBlock.id)
				: null;
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
								sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
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
				const cleanToolUseBlock = (block: { type: string; id?: string }, msgId: string) => {
					if (block.type !== "tool_use" || !block.id) return;
					tx.delete(narratorToolCalls)
						.where(
							and(
								eq(narratorToolCalls.messageId, msgId),
								eq(narratorToolCalls.toolUseId, block.id),
							),
						)
						.run();
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
					cleanToolUseBlock(removedBlock, messageId);
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
		opts?: { preserveConversationId?: boolean; skipRevert?: boolean },
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

		const results: Array<{ messageId: string; blockIndex: number; messageDeleted: boolean }> = [];
		const failed: Array<{ messageId: string; blockIndex: number; error: string }> = [];
		for (const [msgId, indices] of grouped) {
			for (const blockIndex of indices) {
				try {
					const r = await this.deleteMessageBlock(narratorId, msgId, blockIndex, {
						skipNarratorUpdate: true,
						preserveConversationId: opts?.preserveConversationId,
						skipRevert: opts?.skipRevert,
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

		return { deleted: results.length, failed: failed.length, results };
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
				tx.delete(narratorSidecars).where(eq(narratorSidecars.messageId, messageId)).run();
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
				resolvedFilePath: narratorToolCalls.resolvedFilePath,
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
			.map((tc) => ({
				id: tc.id,
				toolName: tc.toolName,
				toolUseId: tc.toolUseId,
				inputJson: tc.inputJson,
				decisionReason: tc.permissionDecisionReason,
				suggestions: tc.permissionSuggestions,
				executionDeviceId: tc.executionDeviceId,
				executionCwd: tc.executionCwd,
				resolvedFilePath: tc.resolvedFilePath,
				deviceSelectionSource: tc.deviceSelectionSource,
				parentToolUseId: tc.ownerNarratorId === narratorId ? null : tc.parentToolUseId,
				subagentNarratorId: tc.ownerNarratorId === narratorId ? null : tc.ownerNarratorId,
				ownerNarratorId: tc.ownerNarratorId,
			}));
	},
};
