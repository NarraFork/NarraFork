import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import {
	and,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
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
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import {
	revertPatchesForMessages,
	revertPatchForToolUse,
	revertPatchForToolUses,
} from "./snapshot-revert";

// ── Internal helpers ───────────────────────────────────────────────────────

function getReflectionStatus(suggestions: unknown): string | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object") continue;
		const record = suggestion as { type?: unknown; status?: unknown };
		const type = String(record.type ?? "");
		if (
			type === "danger_reflection" ||
			type === "plan_reflection" ||
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
async function deleteOrphanedMessages(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	orphanIds: string[],
): Promise<void> {
	if (orphanIds.length === 0) return;

	await tx
		.update(narrators)
		.set({ forkMessageId: null })
		.where(inArray(narrators.forkMessageId, orphanIds));
	await tx
		.update(narrators)
		.set({ pruneBoundaryMessageId: null })
		.where(inArray(narrators.pruneBoundaryMessageId, orphanIds));

	// Delete refs held by subagent narrators pointing to orphaned messages
	await tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.messageId, orphanIds));
	await tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds));
	await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
}

/**
 * For child messages belonging to subagent narrators, attach the subagent's
 * resolved model as `subagentModel` on each message.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
async function attachSubagentModels(childMessages: any[]): Promise<void> {
	if (childMessages.length === 0) return;
	const narratorIds = [...new Set(childMessages.map((m) => m.narratorId as string))];
	if (narratorIds.length === 0) return;
	const subagentRows = await db.query.narrators.findMany({
		where: and(inArray(narrators.id, narratorIds), like(narrators.variant, "subagent:%")),
		columns: { id: true, model: true },
	});
	const modelMap = new Map(subagentRows.map((r) => [r.id, r.model]));
	for (const msg of childMessages) {
		const model = modelMap.get(msg.narratorId);
		if (model) msg.subagentModel = model;
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

function isCatchUpCursor(value: string | CatchUpCursor): value is CatchUpCursor {
	return typeof value === "object" && value !== null;
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
	toolCalls?: Array<{ toolUseId: string }> | null;
};

function collectCursorToolUseIds(message: CatchUpCursorMessage): string[] {
	return message.toolCalls?.map((tc) => tc.toolUseId).filter(Boolean) ?? [];
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
	anchors: CatchUpChildAnchor[],
): Promise<Map<string, ResolvedChildAnchor>> {
	const resolved = new Map<string, ResolvedChildAnchor>();
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

		const existing = resolved.get(anchor.parentToolUseId);
		if (!existing || seq >= existing.seq) {
			resolved.set(anchor.parentToolUseId, {
				parentToolUseId: anchor.parentToolUseId,
				narratorId: narratorForAnchor,
				lastMessageId,
				seq,
			});
		}
	}

	return resolved;
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
				const skipInput = SKIP_INPUT_TRUNCATE_TOOLS.has(tc.toolName);
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
				tcId: tc.id,
				tcCreatedAt: tc.createdAt,
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

// ── narratorMessages object ────────────────────────────────────────────────

export const narratorMessageQueries = {
	async getMessages(narratorId: string, limit = 100, offset = 0) {
		const messages = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
			with: { toolCalls: true, sideCars: true },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit,
			offset,
		});
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
		await hydrateToolUseSideCars(messages);
		return messages;
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

	async isSubagentNarrator(narratorId: string): Promise<boolean> {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { variant: true },
		});
		return narrator != null && isSubagentVariant(narrator.variant);
	},

	async getMessagesCursor(
		narratorId: string,
		limit = 50,
		cursor?: string,
		direction: "older" | "newer" = "older",
	) {
		const isSubagent = await this.isSubagentNarrator(narratorId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const cursorConditions: any[] = [eq(narratorMessageRefs.narratorId, narratorId)];
		if (cursor) {
			const cursorSeq = Number.parseInt(cursor, 10);
			if (!Number.isNaN(cursorSeq)) {
				cursorConditions.push(
					direction === "newer"
						? gt(narratorMessageRefs.seq, cursorSeq)
						: lt(narratorMessageRefs.seq, cursorSeq),
				);
			}
		}

		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					...cursorConditions,
					...(isSubagent ? [] : [isNull(narratorMessages.parentToolUseId)]),
					isNull(narratorMessageRefs.segmentCompactId),
				),
			)
			.orderBy(
				direction === "newer" ? narratorMessageRefs.seq : sql`${narratorMessageRefs.seq} DESC`,
			)
			.limit(limit + 1);

		const hasMoreInDirection = refRows.length > limit;
		const pageRows = hasMoreInDirection ? refRows.slice(0, limit) : refRows;
		if (direction === "older") {
			pageRows.reverse();
		}

		if (pageRows.length === 0) {
			return {
				messages: [],
				hasMore: false,
				nextCursor: null,
				hasMoreAfter: false,
				prevCursor: null,
			};
		}

		const messageIds = pageRows.map((r) => r.messageId);
		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true, sideCars: true, creator: true },
		});

		const seqMap = new Map(pageRows.map((r) => [r.messageId, r.seq]));
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		attachMessageSeqs(topMessages, seqMap);

		if (isSubagent) {
			for (const msg of topMessages) {
				msg.parentToolUseId = null;
			}
		}

		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true, sideCars: true, creator: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);
		await hydrateToolUseSideCars([...topMessages, ...childMessages]);

		const tree = enrichToolUseBlocks(
			filterExitPlanBeforePlanCompact(
				truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
			),
		);

		return {
			messages: tree,
			hasMore: direction === "older" ? hasMoreInDirection : false,
			nextCursor: direction === "older" && hasMoreInDirection ? String(pageRows[0].seq) : null,
			hasMoreAfter: direction === "newer" ? hasMoreInDirection : false,
			prevCursor:
				direction === "newer" && hasMoreInDirection
					? String(pageRows[pageRows.length - 1].seq)
					: null,
		};
	},

	async getMessageVersion(narratorId: string): Promise<number> {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { messageVersion: true },
		});
		return row?.messageVersion ?? 0;
	},

	async getMessagesAfter(narratorId: string, after: string | CatchUpCursor, limit = 200) {
		const isSubagent = await this.isSubagentNarrator(narratorId);
		const inputCursor: CatchUpCursor = isCatchUpCursor(after)
			? after
			: { parentLastMessageId: after };

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
					.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
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
				upsertCursorChildAnchor(baseChildAnchors, {
					parentToolUseId: parentMessage.parentToolUseId,
					narratorId: parentMessage.narratorId,
					lastMessageId: childRef ? childAnchorMessageId : undefined,
				});
			} else if (parentRef) {
				parentAnchorSeq = parentRef.seq;
				await addOpenAnchorsForMessage(parentLastMessageId);
			}
		}

		for (const anchor of inputCursor.childAnchors ?? []) {
			if (anchor.parentToolUseId) upsertCursorChildAnchor(baseChildAnchors, anchor);
		}

		const resolvedChildAnchors = !isSubagent
			? await resolveCatchUpChildAnchors(trimCursorChildAnchors(baseChildAnchors))
			: new Map<string, ResolvedChildAnchor>();

		if (parentAnchorSeq == null && resolvedChildAnchors.size === 0) {
			return { topLevel: [], orphanChildren: [], hitLimit: true };
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
				baseChildAnchors: trimCursorChildAnchors(baseChildAnchors),
				topMessages: [],
				childMessages: [],
			});
			return { topLevel: [], orphanChildren: [], hitLimit: false, cursor };
		}

		// Either stream returning more than `limit` rows means we're past the
		// catch-up threshold. Short-circuit to a full reload before reading any
		// large message payloads (content_json / input_json / output_json).
		if (refRows.length + childRefRows.length > limit) {
			return { topLevel: [], orphanChildren: [], hitLimit: true };
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
		const existingChildIds = new Set(childMsgs.map((m) => m.id));
		if (newTopToolUseIds.length > 0) {
			const extraChildren = await db.query.narratorMessages.findMany({
				where: and(
					inArray(narratorMessages.parentToolUseId, newTopToolUseIds),
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
			for (const c of extraChildren) {
				if (!existingChildIds.has(c.id)) childMsgs.push(c);
			}
		}

		await attachSubagentModels(childMsgs);
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
			baseChildAnchors: trimCursorChildAnchors(baseChildAnchors),
			topMessages: topMsgs,
			childMessages: childMsgs,
		});

		return {
			topLevel: tree,
			orphanChildren: enrichToolUseBlocks(truncateToolIO(orphanChildren)),
			hitLimit: false,
			cursor,
		};
	},

	async getMessagesAround(
		narratorId: string,
		messageId: string,
		opts: { before?: number; after?: number } = {},
	) {
		const before = Math.max(0, opts.before ?? 5);
		const after = Math.max(0, opts.after ?? 20);
		const fallbackLimit = Math.max(before + after + 1, 10);
		const [isSubagent, targetRef, target] = await Promise.all([
			this.isSubagentNarrator(narratorId),
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
				columns: { seq: true },
			}),
			db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
				columns: { id: true, parentToolUseId: true },
			}),
		]);
		if (!targetRef) {
			return this.getMessagesCursor(narratorId, fallbackLimit);
		}
		if (!target) {
			return this.getMessagesCursor(narratorId, fallbackLimit);
		}

		let anchorMessageId = target.id;
		if (!isSubagent && target.parentToolUseId) {
			const [parentTc] = await db
				.select({ messageId: narratorToolCalls.messageId })
				.from(narratorToolCalls)
				.innerJoin(
					narratorMessageRefs,
					eq(narratorToolCalls.messageId, narratorMessageRefs.messageId),
				)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, target.parentToolUseId),
					),
				)
				.limit(1);
			if (parentTc) anchorMessageId = parentTc.messageId;
		}

		const anchorRef =
			anchorMessageId === target.id
				? targetRef
				: await db.query.narratorMessageRefs.findFirst({
						where: and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, anchorMessageId),
						),
						columns: { seq: true },
					});
		if (!anchorRef) {
			return this.getMessagesCursor(narratorId, fallbackLimit);
		}

		const topLevelFilter = isSubagent ? undefined : isNull(narratorMessages.parentToolUseId);

		const [olderRefRows, newerRefRows] = await Promise.all([
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						lt(narratorMessageRefs.seq, anchorRef.seq),
						isNull(narratorMessageRefs.segmentCompactId),
						...(topLevelFilter ? [topLevelFilter] : []),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(before + 1),
			db
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						gt(narratorMessageRefs.seq, anchorRef.seq),
						isNull(narratorMessageRefs.segmentCompactId),
						...(topLevelFilter ? [topLevelFilter] : []),
					),
				)
				.orderBy(narratorMessageRefs.seq)
				.limit(after + 1),
		]);

		const hasMore = olderRefRows.length > before;
		const olderRows = hasMore ? olderRefRows.slice(0, before) : olderRefRows;
		olderRows.reverse();

		const hasMoreAfter = newerRefRows.length > after;
		const newerRows = hasMoreAfter ? newerRefRows.slice(0, after) : newerRefRows;

		const allRows = [
			...olderRows,
			{ messageId: anchorMessageId, seq: anchorRef.seq },
			...newerRows,
		];
		const allIds = allRows.map((r) => r.messageId);
		const seqMap = new Map<string, number>(allRows.map((r) => [r.messageId, r.seq]));

		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, allIds),
			with: { toolCalls: true, sideCars: true, creator: true },
		});
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		attachMessageSeqs(topMessages, seqMap);

		if (isSubagent) {
			for (const msg of topMessages) {
				msg.parentToolUseId = null;
			}
		}

		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true, sideCars: true, creator: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);
		await hydrateToolUseSideCars([...topMessages, ...childMessages]);

		const tree = enrichToolUseBlocks(
			filterExitPlanBeforePlanCompact(
				truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
			),
		);
		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? String(olderRows[0]?.seq ?? anchorRef.seq) : null,
			hasMoreAfter,
			prevCursor: hasMoreAfter
				? String(newerRows[newerRows.length - 1]?.seq ?? anchorRef.seq)
				: null,
		};
	},

	async getToolCallDetail(narratorId: string, toolUseId: string) {
		const tc = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
		});
		if (tc) return attachSideCarsToToolCall(tc);

		const candidate = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
		if (!candidate) throw new NotFoundError("ToolCall", toolUseId);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, candidate.messageId),
			columns: { id: true, parentToolUseId: true },
		});
		if (msg) {
			const directRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, msg.id),
				),
			});
			if (directRef) return attachSideCarsToToolCall(candidate);

			if (msg.parentToolUseId) {
				const parentTc = await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.toolUseId, msg.parentToolUseId),
					columns: { messageId: true },
				});
				if (parentTc) {
					const parentRef = await db.query.narratorMessageRefs.findFirst({
						where: and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, parentTc.messageId),
						),
					});
					if (parentRef) return attachSideCarsToToolCall(candidate);
				}
			}
		}

		throw new NotFoundError("ToolCall", toolUseId);
	},

	async getCompactSummary(narratorId: string, messageId: string): Promise<string> {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact" && b.status === "compacted");
		if (!compactBlock) {
			throw new NotFoundError("CompactSummary", messageId);
		}
		return typeof compactBlock.summary === "string" ? compactBlock.summary : "";
	},

	async deleteCompactMessage(narratorId: string, messageId: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (!compactBlock) throw new ValidationError("Message is not a compact message");

		const currentRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		const prevCompact = currentRef
			? await db
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
			: [];

		await db.transaction(async (tx) => {
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId));
			await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));

			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					contextSummary: null,
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

		return { previousCompactExists: prevCompact.length > 0 };
	},

	async deleteMessage(narratorId: string, messageId: string) {
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

		await revertPatchesForMessages(narratorId, messageIds);

		await db.transaction(async (tx) => {
			await tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds));

			const orphanRows = await tx
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
				);

			const orphanIds = orphanRows.map((r) => r.id);
			if (orphanIds.length > 0) {
				const orphanMsgs = await tx
					.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
					.from(narratorMessages)
					.where(inArray(narratorMessages.id, orphanIds));

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
					const childRows = await tx
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(inArray(narratorMessages.parentToolUseId, toolUseIds));
					for (const c of childRows) orphanIds.push(c.id);
				}

				await deleteOrphanedMessages(tx, orphanIds);
			}

			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

		return { deletedCount: refsToRemove.length };
	},

	async dismissErrorMessage(narratorId: string, messageId: string) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) throw new NotFoundError("Message", messageId);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { role: true, contentJson: true },
		});
		if (
			!msg ||
			msg.role !== "system" ||
			!Array.isArray(msg.contentJson) ||
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			!(msg.contentJson as any[]).some((b: any) => b.type === "error")
		) {
			throw new ValidationError("Message is not an error notice");
		}

		await db.transaction(async (tx) => {
			await tx
				.delete(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				);
			const otherRef = await tx.query.narratorMessageRefs.findFirst({
				where: eq(narratorMessageRefs.messageId, messageId),
			});
			if (!otherRef) {
				await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
			}
			await tx
				.update(narrators)
				.set({
					errorMessage: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
				})
				.where(eq(narrators.id, narratorId));
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
		opts?: { preserveConversationId?: boolean },
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

		await revertPatchesForMessages(narratorId, messageIds);

		await db.transaction(async (tx) => {
			await tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds));

			const orphanRows = await tx
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
				);

			const orphanIds = orphanRows.map((r) => r.id);
			if (orphanIds.length > 0) {
				const orphanMsgs = await tx
					.select({ id: narratorMessages.id, contentJson: narratorMessages.contentJson })
					.from(narratorMessages)
					.where(inArray(narratorMessages.id, orphanIds));

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
					const childRows = await tx
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(inArray(narratorMessages.parentToolUseId, toolUseIds));
					for (const c of childRows) orphanIds.push(c.id);
				}

				await deleteOrphanedMessages(tx, orphanIds);
			}

			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					...(opts?.preserveConversationId ? {} : { apiConversationId: null }),
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

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

		if (!opts?.skipRevert && removedBlock.type === "tool_use" && removedBlock.id) {
			await revertPatchForToolUse(narratorId, removedBlock.id);
		}

		const refCount = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId));
		const isShared = (refCount[0]?.count ?? 0) > 1;

		let messageDeleted = false;

		await db.transaction(async (tx) => {
			const cleanToolUseBlock = async (block: { type: string; id?: string }, msgId: string) => {
				if (block.type !== "tool_use" || !block.id) return;
				await tx
					.delete(narratorToolCalls)
					.where(
						and(eq(narratorToolCalls.messageId, msgId), eq(narratorToolCalls.toolUseId, block.id)),
					);
				const children = await tx
					.select({ id: narratorMessages.id })
					.from(narratorMessages)
					.where(eq(narratorMessages.parentToolUseId, block.id));
				if (children.length > 0) {
					const childIds = children.map((c) => c.id);
					const otherRefs = await tx
						.select({ messageId: narratorMessageRefs.messageId })
						.from(narratorMessageRefs)
						.where(
							and(
								inArray(narratorMessageRefs.messageId, childIds),
								ne(narratorMessageRefs.narratorId, narratorId),
							),
						)
						.limit(1);
					if (otherRefs.length === 0) {
						await tx
							.delete(narratorToolCalls)
							.where(inArray(narratorToolCalls.messageId, childIds));
						await tx
							.delete(narratorMessageRefs)
							.where(inArray(narratorMessageRefs.messageId, childIds));
						await tx.delete(narratorMessages).where(inArray(narratorMessages.id, childIds));
					} else {
						await tx
							.delete(narratorMessageRefs)
							.where(
								and(
									eq(narratorMessageRefs.narratorId, narratorId),
									inArray(narratorMessageRefs.messageId, childIds),
								),
							);
					}
				}
			};

			if (remaining.length === 0) {
				messageDeleted = true;
				await cleanToolUseBlock(removedBlock, messageId);
				await tx
					.delete(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					);
				if (!isShared) {
					await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId));
					await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
				}
			} else if (isShared) {
				const newId = generateId();
				const contentText = remaining
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n");

				await tx.insert(narratorMessages).values({
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
				});

				await tx
					.update(narratorMessageRefs)
					.set({ messageId: newId })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					);

				const remainingToolUseIds = remaining
					.filter((b): b is typeof b & { id: string } => b.type === "tool_use" && !!b.id)
					.map((b) => b.id);
				if (remainingToolUseIds.length > 0) {
					const existingCalls = await tx
						.select()
						.from(narratorToolCalls)
						.where(
							and(
								eq(narratorToolCalls.messageId, messageId),
								inArray(narratorToolCalls.toolUseId, remainingToolUseIds),
							),
						);
					if (existingCalls.length > 0) {
						await tx.insert(narratorToolCalls).values(
							existingCalls.map((tc) => ({
								...tc,
								id: generateId(),
								messageId: newId,
							})),
						);
					}
				}

				await cleanToolUseBlock(removedBlock, newId);
			} else {
				const contentText = remaining
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n");

				await tx
					.update(narratorMessages)
					.set({ contentJson: remaining, contentText: contentText || null })
					.where(eq(narratorMessages.id, messageId));

				await cleanToolUseBlock(removedBlock, messageId);
			}

			if (!opts?.skipNarratorUpdate) {
				await tx
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
		});

		return { messageDeleted };
	},

	async deleteMessageBlocks(
		narratorId: string,
		blocks: Array<{ messageId: string; blockIndex: number }>,
		opts?: { preserveConversationId?: boolean },
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

		const toolUseIdsToRevert: string[] = [];
		const uniqueMessageIds = [...grouped.keys()];
		const messages =
			uniqueMessageIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.id, uniqueMessageIds),
						columns: { id: true, contentJson: true },
					})
				: [];
		const messageMap = new Map(messages.map((m) => [m.id, m]));

		for (const [msgId, indices] of grouped) {
			const msg = messageMap.get(msgId);
			if (!msg) continue;
			const contentBlocks = Array.isArray(msg.contentJson)
				? (msg.contentJson as { type: string; id?: string }[])
				: [];
			for (const idx of indices) {
				const block = contentBlocks[idx];
				if (block?.type === "tool_use" && block.id) {
					toolUseIdsToRevert.push(block.id);
				}
			}
		}

		if (toolUseIdsToRevert.length > 0) {
			await revertPatchForToolUses(narratorId, toolUseIdsToRevert);
		}

		const results: Array<{ messageId: string; blockIndex: number; messageDeleted: boolean }> = [];
		const failed: Array<{ messageId: string; blockIndex: number; error: string }> = [];
		for (const [msgId, indices] of grouped) {
			for (const blockIndex of indices) {
				try {
					const r = await this.deleteMessageBlock(narratorId, msgId, blockIndex, {
						skipRevert: true,
						skipNarratorUpdate: true,
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
		await db.transaction(async (tx) => {
			await tx
				.delete(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				);
			await tx
				.delete(narratorMessages)
				.where(
					and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
				);
		});
	},

	async updateCompactSummary(narratorId: string, messageId: string, summary: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.id, messageId),
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "system"),
			),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact" && b.status === "compacted");
		if (!compactBlock) throw new ValidationError("Message is not a compacted message");

		const isPlan = compactBlock.subtype === "plan";
		const newBlock: Record<string, unknown> = {
			type: "compact",
			status: "compacted",
			summary,
		};
		if (isPlan) newBlock.subtype = "plan";

		const prefix = isPlan ? "[Plan]" : "[Compact]";
		const now = new Date().toISOString();

		await db.transaction(async (tx) => {
			await tx
				.update(narratorMessages)
				.set({
					contentJson: [newBlock],
					contentText: `${prefix} ${summary.slice(0, 200)}...`,
				})
				.where(eq(narratorMessages.id, messageId));

			await tx
				.update(narrators)
				.set({ contextSummary: summary, apiConversationId: null, updatedAt: now })
				.where(eq(narrators.id, narratorId));
		});
	},

	async getPendingPermissions(narratorId: string) {
		const tcs = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "pending"),
			),
			orderBy: (tc, { asc }) => [asc(tc.createdAt)],
		});
		return tcs
			.filter((tc) => !shouldHidePendingPermission(tc.permissionSuggestions))
			.map((tc) => ({
				id: tc.id,
				toolName: tc.toolName,
				toolUseId: tc.toolUseId,
				inputJson: tc.inputJson,
				decisionReason: tc.permissionDecisionReason,
				suggestions: tc.permissionSuggestions,
			}));
	},
};
