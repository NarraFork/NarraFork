import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistDirs,
	terminals,
	terminalTabs,
	terminalViewState,
	users,
} from "../db/schema";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { resolveProvider, settings, usesCodexApiMode } from "../lib/settings";
import { deleteNarratorUploads, type ImageRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { LoadToolNotFound, LoadToolResult } from "./command-service";
import { revertPatchesForMessages, revertPatchForToolUse } from "./snapshot-revert";

/**
 * For child messages belonging to subagent narrators, attach the subagent's
 * resolved model as `subagentModel` on each message. This avoids extra API
 * calls from the frontend.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
async function attachSubagentModels(childMessages: any[]): Promise<void> {
	if (childMessages.length === 0) return;
	const narratorIds = [...new Set(childMessages.map((m) => m.narratorId as string))];
	if (narratorIds.length === 0) return;
	const subagentRows = await db.query.narrators.findMany({
		where: and(inArray(narrators.id, narratorIds), eq(narrators.type, "subagent")),
		columns: { id: true, model: true },
	});
	const modelMap = new Map(subagentRows.map((r) => [r.id, r.model]));
	for (const msg of childMessages) {
		const model = modelMap.get(msg.narratorId);
		if (model) msg.subagentModel = model;
	}
}

/**
 * Build a tree from a flat array of messages.
 * Messages with parentToolUseId are nested under the message whose
 * toolCalls contains the matching toolUseId.
 * Returns only top-level messages (parentToolUseId is null).
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function buildMessageTree(flatMessages: any[]): any[] {
	// Shallow clone each message to avoid mutating drizzle results
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const cloned = flatMessages.map((msg) => ({ ...msg, children: [] as any[] }));

	// Map: toolUseId → cloned message that CONTAINS that tool_use block
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
		// Child messages whose parent isn't in the set are silently dropped
		// (they belong to a different page)
	}

	return topLevel;
}

/** Truncate a JSON value to a preview string if it exceeds maxLen characters */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateJson(val: any, maxLen: number): any {
	if (val === null || val === undefined) return val;
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return val;
	return { _truncated: true, preview: str.slice(0, maxLen), fullLength: str.length };
}

/** Tool names whose inputJson/outputJson should never be truncated in message lists
 *  (their content IS the primary display payload, e.g. plan text). */
const SKIP_TRUNCATE_TOOLS = new Set(["ExitPlanMode"]);

/** Recursively truncate large inputJson/outputJson in tool calls within a message tree */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function truncateToolIO(tree: any[], maxLen = 2000): any[] {
	return tree.map((msg) => ({
		...msg,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		toolCalls: msg.toolCalls?.map((tc: any) => {
			if (SKIP_TRUNCATE_TOOLS.has(tc.toolName)) return tc;
			return {
				...tc,
				inputJson: truncateJson(tc.inputJson, maxLen),
				outputJson: truncateJson(tc.outputJson, maxLen),
			};
		}),
		children: msg.children?.length ? truncateToolIO(msg.children, maxLen) : msg.children,
	}));
}

/**
 * Enrich tool_use blocks in contentJson with fields from the toolCalls relation.
 * This merges status, outputJson, durationMs, etc. directly into the content block
 * so the frontend can read all tool call data from a single source (contentJson)
 * without cross-referencing the separate toolCalls array.
 *
 * The original toolCalls array is preserved for backward compatibility.
 */
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
			// Extract _metadata from structured outputJson (Edit tool stores { _text, _metadata })
			const outputJson = tc.outputJson;
			const _metadata =
				outputJson && typeof outputJson === "object" && !Array.isArray(outputJson)
					? outputJson._metadata
					: undefined;
			return {
				...block,
				// Prefer toolCalls table values (may have been overwritten post-persist)
				inputJson: tc.inputJson ?? block.input,
				outputJson: tc.outputJson,
				status: tc.status,
				durationMs: tc.durationMs,
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
		// Check if next message is a plan compact
		if (
			next?.role === "system" &&
			Array.isArray(next.contentJson) &&
			next.contentJson.some(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				(b: any) => b.type === "compact" && b.subtype === "plan",
			)
		) {
			// Check if current message only has ExitPlanMode tool_use (+ optional empty text)
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
				if (onlyExitPlan) continue; // skip this message
			}
		}
		result.push(msg);
	}
	return result;
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

/** Insert a message into narrator_message_refs junction table */
async function insertMessageRef(
	narratorId: string,
	messageId: string,
	seq: number,
	isCompact = 0,
	prunedPercent?: number | null,
): Promise<void> {
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId,
		seq,
		isCompact,
		prunedPercent: prunedPercent ?? null,
	});
}

/** Atomically get next seq and insert into narrator_message_refs (prevents race conditions) */
async function appendMessageRef(
	narratorId: string,
	messageId: string,
	isCompact = 0,
	prunedPercent?: number | null,
): Promise<number> {
	return db.transaction(async (tx) => {
		const result = await tx
			.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId));
		const seq = (result[0]?.maxSeq ?? -1) + 1;

		// Auto-fetch current prunedPercent from narrator if not explicitly provided
		let resolvedPrunedPercent = prunedPercent ?? null;
		if (resolvedPrunedPercent == null) {
			const narrator = await tx.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { prunedPercent: true },
			});
			resolvedPrunedPercent = narrator?.prunedPercent ?? null;
		}

		await tx.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId,
			messageId,
			seq,
			isCompact,
			prunedPercent: resolvedPrunedPercent,
		});
		return seq;
	});
}

/**
 * Clear or set contextSummary + apiConversationId on the narrator.
 * Pass `summary = null` to clear, or a string to set.
 */

interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
	cwd?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | null;
	fastMode?: boolean;
	relaxedPlan?: boolean;
}

interface CreateSubagentInput {
	parentNarratorId: string;
	subagentType: "explore" | "plan" | "general";
	cwd: string;
	permissionMode?: string;
	model?: string;
	systemPrompt?: string;
}

/**
 * Shared handler for `/load <tool>` commands.
 * Called from both the HTTP route and the WebSocket buffer_message handler.
 *
 * When a tool is newly loaded (not already_loaded), persists an additional
 * role="user" message so the model knows the tool was just made available.
 */
export async function handleLoadToolCommand(
	narratorId: string,
	cmdResult: LoadToolResult | LoadToolNotFound,
	locale: Locale = "en",
): Promise<{ toolName: string; loaded: boolean; alreadyLoaded: boolean }> {
	if ("loadToolNotFound" in cmdResult) {
		const toolId = cmdResult.loadToolNotFound;
		const infoText = `⚠️ Unknown tool: ${toolId}. Available: terminal, share_file`;
		await narratorService.persistInfoMessage(narratorId, infoText);
		return { toolName: toolId, loaded: false, alreadyLoaded: false };
	}
	const { loadOptionalTool } = await import("./narrator-session");
	const toolName = cmdResult.loadTool;
	const result = await loadOptionalTool(narratorId, toolName);
	const alreadyLoaded = result === "already_loaded";
	const infoText = alreadyLoaded
		? `🔧 Tool already loaded: ${toolName}`
		: `🔧 Tool loaded: ${toolName}`;
	await narratorService.persistInfoMessage(narratorId, infoText);

	// Persist a user-role message so the model is aware the tool was just loaded
	if (!alreadyLoaded) {
		const routine = getBuiltinToolRoutines().find((r) => r.tool?.toolName === toolName);
		const toolDescription =
			locale === "zh-CN"
				? (routine?.tool?.descriptionZh ?? routine?.tool?.descriptionEn ?? toolName)
				: (routine?.tool?.descriptionEn ?? toolName);
		const text = getToolMessageWithParams("toolLoaded", locale, {
			toolName,
			toolDescription,
		});
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "tool_loaded", toolName, text }],
				contentText: text,
				createdAt: now,
			})
			.returning();
		await appendMessageRef(narratorId, id);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "user",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
	}

	return { toolName, loaded: true, alreadyLoaded };
}

export const narratorService = {
	async create(input: CreateNarratorInput) {
		if (input.chapterId) {
			const chapter = await db.query.chapters.findFirst({
				where: eq(chapters.id, input.chapterId),
			});
			if (!chapter) throw new NotFoundError("Chapter", input.chapterId);
			if (chapter.status !== "active") {
				throw new ValidationError("Cannot create narrator for non-active chapter");
			}
		}

		const type = input.type ?? "primary";

		// Enforce single primary narrator per chapter (only for chapter-bound narrators)
		if (type === "primary" && input.chapterId) {
			const existing = await db.query.narrators.findFirst({
				where: and(eq(narrators.chapterId, input.chapterId), eq(narrators.type, "primary")),
			});
			if (existing) {
				throw new ValidationError("Chapter already has a primary narrator");
			}
		}

		const now = new Date().toISOString();
		const id = generateId();
		const resolvedPermMode = (input.permissionMode ?? settings.agent.defaultPermissionMode) as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk";

		const resolvedModel = input.model ?? settings.agent.defaultModel;
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			input.reasoningEffort === undefined
				? usesCodexApiMode(resolvedProvider)
					? (settings.codex?.defaultReasoningEffort ?? null)
					: null
				: input.reasoningEffort;

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: input.chapterId ?? null,
				type,
				model: resolvedModel,
				systemPrompt: input.systemPrompt,
				permissionMode: resolvedPermMode,
				reasoningEffort: resolvedReasoningEffort,
				fastMode: input.fastMode ?? false,
				relaxedPlan: input.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
				cwd: input.cwd ?? null,
				inheritMode: "fresh",
				status: "idle",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Narrator created", { id, chapterId: input.chapterId, type });
		return narrator;
	},

	async createSubagent(input: CreateSubagentInput) {
		const parent = await this.getById(input.parentNarratorId);

		// Prevent nested subagents
		if (parent.type === "subagent") {
			throw new ValidationError("Subagents cannot spawn nested subagents");
		}

		const now = new Date().toISOString();
		const id = generateId();

		// Resolve effective permission mode for the subagent.
		// When the parent is in plan mode, subagents should NOT inherit "plan" —
		// plan mode semantics (Write/Edit restricted to plan file) are meaningless
		// for subagents. Instead, resolve to the effective mode:
		// - relaxedPlan → inherit previousPermissionMode (the mode before entering plan)
		// - strict plan → readOnly
		let basePermMode = input.permissionMode ?? parent.permissionMode ?? "default";
		if (basePermMode === "plan") {
			basePermMode = parent.relaxedPlan ? (parent.previousPermissionMode ?? "default") : "readOnly";
		}
		const resolvedPermMode = basePermMode as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk";

		const resolvedModel = input.model ?? parent.model ?? settings.agent.defaultModel;
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			parent.reasoningEffort ??
			(usesCodexApiMode(resolvedProvider)
				? (settings.codex?.defaultReasoningEffort ?? null)
				: null);

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: parent.chapterId ?? null,
				type: "subagent",
				subagentType: input.subagentType,
				model: resolvedModel,
				systemPrompt: input.systemPrompt ?? null,
				permissionMode: resolvedPermMode,
				reasoningEffort: resolvedReasoningEffort,
				fastMode: parent.fastMode ?? false,
				relaxedPlan: parent.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
				parentNarratorId: input.parentNarratorId,
				cwd: input.cwd,
				inheritMode: "fresh",
				status: "thinking",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Subagent created", {
			id,
			parentNarratorId: input.parentNarratorId,
			subagentType: input.subagentType,
		});
		return narrator;
	},

	/**
	 * Fork a subagent: create a new subagent narrator that shares the original's
	 * message history (via copied narrator_message_refs), then continue from there.
	 * The original subagent remains untouched.
	 */
	async forkSubagent(input: {
		originalSubagentId: string;
		parentNarratorId: string;
		subagentType: "explore" | "plan" | "general";
		cwd: string;
		systemPrompt?: string;
		model?: string;
		permissionMode?: string;
		/** Pre-fetched original narrator to avoid redundant DB query */
		_original?: typeof narrators.$inferSelect;
	}) {
		const original = input._original ?? (await this.getById(input.originalSubagentId));
		if (original.type !== "subagent") {
			throw new ValidationError("Can only fork subagent narrators");
		}
		const now = new Date().toISOString();
		const id = generateId();

		// Subagents should never have "plan" permission mode — resolve it
		// the same way as createSubagent (see comment there).
		let basePermMode = input.permissionMode ?? "default";
		if (basePermMode === "plan") {
			basePermMode = original.relaxedPlan
				? (original.previousPermissionMode ?? "default")
				: "readOnly";
		}
		const resolvedPermMode = basePermMode as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk";

		// Copy all message refs from the original subagent
		const prefixRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
				isCompact: narratorMessageRefs.isCompact,
				prunedPercent: narratorMessageRefs.prunedPercent,
			})
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, input.originalSubagentId))
			.orderBy(narratorMessageRefs.seq);

		const resolvedModel = input.model ?? settings.agent.defaultModel;
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			original.reasoningEffort ??
			(usesCodexApiMode(resolvedProvider)
				? (settings.codex?.defaultReasoningEffort ?? null)
				: null);

		const narrator = await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(narrators)
				.values({
					id,
					chapterId: original.chapterId ?? null,
					type: "subagent",
					subagentType: input.subagentType,
					model: resolvedModel,
					systemPrompt: input.systemPrompt ?? null,
					permissionMode: resolvedPermMode,
					reasoningEffort: resolvedReasoningEffort,
					fastMode: original.fastMode ?? false,
					relaxedPlan: original.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
					parentNarratorId: input.parentNarratorId,
					forkMessageId: prefixRows.length > 0 ? prefixRows[prefixRows.length - 1].messageId : null,
					cwd: input.cwd,
					inheritMode: "fresh",
					status: "thinking",
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			if (prefixRows.length > 0) {
				await tx.insert(narratorMessageRefs).values(
					prefixRows.map((row) => ({
						id: generateId(),
						narratorId: id,
						messageId: row.messageId,
						seq: row.seq,
						isCompact: row.isCompact,
						prunedPercent: row.prunedPercent,
					})),
				);
			}

			return created;
		});

		logger.info("Subagent forked", {
			id,
			originalSubagentId: input.originalSubagentId,
			parentNarratorId: input.parentNarratorId,
			subagentType: input.subagentType,
		});
		return narrator;
	},

	/**
	 * Persist a user message for a subagent, linked to the parent's tool_use via parentToolUseId.
	 */
	async persistSubagentUserMessage(
		narratorId: string,
		text: string,
		parentToolUseId: string,
		images?: ImageRef[],
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const contentJson: Array<
			| { type: "text"; text: string }
			| { type: "image"; imageId: string; filename: string; mediaType: string }
		> = [];
		if (images?.length) {
			for (const img of images) {
				contentJson.push({
					type: "image",
					imageId: img.imageId,
					filename: img.filename,
					mediaType: img.mediaType,
				});
			}
		}
		contentJson.push({ type: "text", text });
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				parentToolUseId,
				role: "user",
				contentJson,
				contentText: text,
				createdAt: now,
			})
			.returning();

		await appendMessageRef(narratorId, id);
		return msg;
	},

	async getById(id: string) {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
		});
		if (!narrator) throw new NotFoundError("Narrator", id);
		return narrator;
	},

	async listByChapter(chapterId: string) {
		return db.query.narrators.findMany({
			where: and(eq(narrators.chapterId, chapterId), ne(narrators.type, "subagent")),
			orderBy: (n, { asc }) => [asc(n.createdAt)],
		});
	},

	async getMessages(narratorId: string, limit = 100, offset = 0) {
		return db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, narratorId),
			with: { toolCalls: true },
			orderBy: (m, { asc }) => [asc(m.createdAt)],
			limit,
			offset,
		});
	},

	/**
	 * Fetch all messages after the most recent compact marker.
	 * If no compact marker exists, returns all messages.
	 * Uses narrator_message_refs junction table.
	 */
	async getMessagesSinceLastCompact(narratorId: string) {
		// Find the last compact marker's seq
		const lastCompactRow = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		const compactSeq = lastCompactRow[0]?.seq;

		// Fetch message IDs from narrator_message_refs
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					compactSeq != null ? gt(narratorMessageRefs.seq, compactSeq) : undefined,
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	/**
	 * Fetch messages between the last compact marker and a given message (exclusive).
	 * Used for partial compact — compress only messages before the target.
	 */
	async getMessagesBefore(narratorId: string, beforeMessageId: string) {
		// Find the target message's seq
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, beforeMessageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

		// Find the last compact marker before the target
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

		// Get message IDs in range (compactSeq, targetSeq)
		const refRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					lowerBound,
					lt(narratorMessageRefs.seq, targetRef.seq),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refRows.length === 0) return [];

		const messageIds = refRows.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	/** Fetch the N earliest top-level user/assistant messages with text content. */
	async getEarliestMessages(narratorId: string, limit = 2) {
		// Query via refs so forked narrators see inherited messages too
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

	/**
	 * Shared helper: fetch post-last-compact user/assistant message refs used by
	 * prune/compact boundary calculations.
	 *
	 * For primary narrators, only top-level messages are included.
	 * For subagent narrators, all messages are treated as top-level-equivalent
	 * (they are stored with parentToolUseId set).
	 */
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
					...(includeChildMessages ? [] : [isNull(narratorMessages.parentToolUseId)]),
				),
			)
			.orderBy(narratorMessageRefs.seq);
	},

	/**
	 * Find the message ID that should serve as the compact boundary for auto-compact.
	 * Returns the ID of the message at the start of the "keep" window — all messages
	 * from this point onward will be preserved (not compacted).
	 *
	 * `keepPairs` controls how many recent user-assistant pairs to keep (default 2).
	 * Returns null if there aren't enough messages to make compacting worthwhile.
	 */
	async getCompactBoundaryMessage(narratorId: string, keepPairs = 2): Promise<string | null> {
		const includeChildMessages = await this.isSubagentNarrator(narratorId);
		const refs = await this._getPostCompactTopLevelRefs(narratorId, {
			includeChildMessages,
		});

		// Count how many messages to keep: keepPairs * 2 (user + assistant each)
		const keepCount = keepPairs * 2;

		// Need at least keepCount + 2 messages to make compact worthwhile
		// (at least one pair to compress + keepCount to preserve)
		if (refs.length < keepCount + 2) return null;

		// The boundary is the message at position (length - keepCount)
		const boundaryRef = refs[refs.length - keepCount];
		return boundaryRef.messageId;
	},

	/** Fetch the N most recent top-level user/assistant messages with text content (chronological order). */
	async getRecentMessages(narratorId: string, limit = 4) {
		// Query via refs so forked narrators see inherited messages too
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
	 * Check if a narrator is a subagent.
	 * Subagent messages all have parentToolUseId set, so query logic differs.
	 */
	async isSubagentNarrator(narratorId: string): Promise<boolean> {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { type: true },
		});
		return narrator?.type === "subagent";
	},

	async getMessagesCursor(narratorId: string, limit = 50, cursor?: string) {
		const isSubagent = await this.isSubagentNarrator(narratorId);

		// Build cursor condition on seq
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const cursorConditions: any[] = [eq(narratorMessageRefs.narratorId, narratorId)];
		if (cursor) {
			const cursorSeq = Number.parseInt(cursor, 10);
			if (!Number.isNaN(cursorSeq)) {
				cursorConditions.push(lt(narratorMessageRefs.seq, cursorSeq));
			}
		}

		// Query messages via junction table, ordered by seq DESC.
		// For subagent narrators, include all messages (they all have parentToolUseId).
		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(...cursorConditions, ...(isSubagent ? [] : [isNull(narratorMessages.parentToolUseId)])),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(limit + 1);

		const hasMore = refRows.length > limit;
		const pageRows = hasMore ? refRows.slice(0, limit) : refRows;
		pageRows.reverse(); // chronological order

		if (pageRows.length === 0) {
			return { messages: [], hasMore, nextCursor: null, hasMoreAfter: false };
		}

		const messageIds = pageRows.map((r) => r.messageId);
		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true, creator: true },
		});

		// Sort by seq order from refs (not createdAt)
		const seqMap = new Map(pageRows.map((r) => [r.messageId, r.seq]));
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// For subagent narrators, clear parentToolUseId so buildMessageTree
		// treats them as top-level messages. Also fetch their child messages
		// (nested subagent tool calls within this subagent).
		if (isSubagent) {
			for (const msg of topMessages) {
				msg.parentToolUseId = null;
			}
		}

		// Fetch child messages (don't filter by narratorId — forked narrators
		// share messages whose narratorId points to the original creator)
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true, creator: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);

		const tree = enrichToolUseBlocks(
			filterExitPlanBeforePlanCompact(
				truncateToolIO(buildMessageTree([...topMessages, ...childMessages])),
			),
		);

		return {
			messages: tree,
			hasMore,
			nextCursor: hasMore ? String(pageRows[0].seq) : null,
			hasMoreAfter: false,
		};
	},

	/**
	 * Fetch messages added after a given message ID (for WS catch-up).
	 * Returns:
	 * - `topLevel`: new top-level messages (tree-structured, chronological)
	 * - `orphanChildren`: child messages whose parent top-level message was
	 *    already sent before the catch-up point (e.g. subagent messages that
	 *    arrived while the client was disconnected). These should be sent as
	 *    individual `{ type: "message" }` events so the frontend's
	 *    `insertChildIntoCache` can place them correctly.
	 */
	async getMessagesAfter(narratorId: string, afterMessageId: string, limit = 40) {
		const isSubagent = await this.isSubagentNarrator(narratorId);

		// Find the seq of the reference message
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, afterMessageId),
			),
			columns: { seq: true },
		});
		if (!ref) return { topLevel: [], orphanChildren: [], hitLimit: true };

		// Cheap COUNT to decide catch-up vs full-reload before fetching payloads.
		// For subagent narrators, count all messages (they all have parentToolUseId).
		const countConditions = [
			eq(narratorMessageRefs.narratorId, narratorId),
			gt(narratorMessageRefs.seq, ref.seq),
		];
		if (!isSubagent) {
			countConditions.push(sql`${narratorMessages.parentToolUseId} IS NULL`);
		}
		const [{ cnt }] = await db
			.select({ cnt: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(and(...countConditions));
		if (cnt > limit) return { topLevel: [], orphanChildren: [], hitLimit: true };

		// Fetch ALL messages with seq > ref.seq.
		const refRows = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(eq(narratorMessageRefs.narratorId, narratorId), gt(narratorMessageRefs.seq, ref.seq)),
			)
			.orderBy(sql`${narratorMessageRefs.seq} ASC`)
			.limit(10_000);

		if (refRows.length === 0) return { topLevel: [], orphanChildren: [], hitLimit: false };

		const messageIds = refRows.map((r) => r.messageId);
		const allMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, messageIds),
			with: { toolCalls: true, creator: true },
		});

		const seqMap = new Map(refRows.map((r) => [r.messageId, r.seq]));
		allMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// Separate top-level vs child messages.
		// For subagent narrators, treat all messages as top-level (clear parentToolUseId).
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

		// For new top-level messages, also fetch their children that might
		// NOT be in the refRows (children created before the catch-up point
		// but belonging to new top-level messages — unlikely but safe)
		const newTopToolUseIds = collectToolUseIds(topMsgs);
		const existingChildIds = new Set(childMsgs.map((m) => m.id));
		if (newTopToolUseIds.length > 0) {
			const extraChildren = await db.query.narratorMessages.findMany({
				where: and(
					inArray(narratorMessages.parentToolUseId, newTopToolUseIds),
					// Exclude children we already have
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
			for (const c of extraChildren) {
				if (!existingChildIds.has(c.id)) {
					childMsgs.push(c);
				}
			}
		}

		await attachSubagentModels(childMsgs);

		// Build tree for new top-level messages
		const tree = enrichToolUseBlocks(
			filterExitPlanBeforePlanCompact(truncateToolIO(buildMessageTree([...topMsgs, ...childMsgs]))),
		);

		// Orphan children: child messages whose parentToolUseId does NOT belong
		// to any new top-level message (they belong to an older message already
		// in the client's cache). Skip children of completed subagents — those
		// are already embedded in the parent's tree when the client loads messages.
		const newTopToolUseIdSet = new Set(newTopToolUseIds);
		const candidateOrphans = [] as typeof childMsgs;
		const orphanToolUseIds: string[] = [];
		for (const child of childMsgs) {
			if (!child.parentToolUseId) continue;
			if (!newTopToolUseIdSet.has(child.parentToolUseId)) {
				candidateOrphans.push(child);
				orphanToolUseIds.push(child.parentToolUseId);
			}
		}

		let orphanChildren = [] as Array<(typeof childMsgs)[number] & { children: never[] }>;
		if (candidateOrphans.length > 0) {
			// Check which parent tool calls are truly finished (success/fail).
			// The status column is NOT NULL with default "initializing", so
			// isNotNull() would match every row — including in-progress ones —
			// which incorrectly filtered out ALL orphan children.
			const uniqueToolUseIds = [...new Set(orphanToolUseIds)];
			const completedTcs = await db.query.narratorToolCalls.findMany({
				where: and(
					inArray(narratorToolCalls.toolUseId, uniqueToolUseIds),
					inArray(narratorToolCalls.status, ["success", "fail"]),
				),
				columns: { toolUseId: true },
			});
			const completedSet = new Set(completedTcs.map((tc) => tc.toolUseId));
			orphanChildren = candidateOrphans
				.filter((c) => c.parentToolUseId && !completedSet.has(c.parentToolUseId))
				.map((c) => ({ ...c, children: [] }));
		}

		return {
			topLevel: tree,
			orphanChildren: enrichToolUseBlocks(truncateToolIO(orphanChildren)),
			hitLimit: false,
		};
	},

	/**
	 * Fetch a bounded top-level message window around a target message ID.
	 * If the target is a child message, resolve its top-level ancestor first.
	 * Older pagination remains cursor-based via `hasMore` / `nextCursor`; newer
	 * messages are intentionally bounded to keep permalink/search hydration light.
	 */
	async getMessagesAround(
		narratorId: string,
		messageId: string,
		opts: { before?: number; after?: number } = {},
	) {
		const before = Math.max(0, opts.before ?? 5);
		const after = Math.max(0, opts.after ?? 20);
		const fallbackLimit = Math.max(before + after + 1, 10);
		const isSubagent = await this.isSubagentNarrator(narratorId);

		// Resolve the target via narrator_message_refs so shared prefix messages in
		// forked narrators can still be located by permalink/search result.
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
			columns: { seq: true },
		});
		if (!targetRef) {
			return this.getMessagesCursor(narratorId, fallbackLimit);
		}

		const target = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
		});
		if (!target) {
			return this.getMessagesCursor(narratorId, fallbackLimit);
		}

		// If target is a child message, walk up to find the top-level ancestor.
		// (Skip for subagent narrators — all their messages have parentToolUseId.)
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

		// Fetch older top-level messages (seq < anchorSeq).
		const olderRefRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					lt(narratorMessageRefs.seq, anchorRef.seq),
					...(topLevelFilter ? [topLevelFilter] : []),
				),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(before + 1);

		const hasMore = olderRefRows.length > before;
		const olderRows = hasMore ? olderRefRows.slice(0, before) : olderRefRows;
		olderRows.reverse();

		// Fetch a bounded number of newer top-level messages (seq > anchorSeq).
		const newerRefRows = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gt(narratorMessageRefs.seq, anchorRef.seq),
					...(topLevelFilter ? [topLevelFilter] : []),
				),
			)
			.orderBy(narratorMessageRefs.seq)
			.limit(after + 1);
		const hasMoreAfter = newerRefRows.length > after;
		const newerRows = hasMoreAfter ? newerRefRows.slice(0, after) : newerRefRows;

		const allRows = [
			...olderRows,
			{ messageId: anchorMessageId, seq: anchorRef.seq },
			...newerRows,
		];
		const allIds = allRows.map((r) => r.messageId);

		// Build seq map for ordering.
		const seqMap = new Map<string, number>(allRows.map((r) => [r.messageId, r.seq]));

		const topMessages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, allIds),
			with: { toolCalls: true, creator: true },
		});

		// Sort by seq order.
		topMessages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));

		// For subagent narrators, clear parentToolUseId so buildMessageTree treats
		// them as top-level messages.
		if (isSubagent) {
			for (const msg of topMessages) {
				msg.parentToolUseId = null;
			}
		}

		// Fetch child messages (don't filter by narratorId — shared messages).
		const parentToolUseIds = collectToolUseIds(topMessages);
		const childMessages =
			parentToolUseIds.length > 0
				? await db.query.narratorMessages.findMany({
						where: inArray(narratorMessages.parentToolUseId, parentToolUseIds),
						with: { toolCalls: true, creator: true },
						orderBy: (m, { asc }) => [asc(m.createdAt)],
						limit: 500,
					})
				: [];

		await attachSubagentModels(childMessages);

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
		};
	},

	async getToolCallDetail(narratorId: string, toolUseId: string) {
		// 1. Direct match — tool call belongs to this narrator
		const tc = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
		});
		if (tc) return tc;

		// 2. Fallback — look up by toolUseId alone, then verify the caller
		//    narrator can see it. This covers:
		//    - Forked narrators (shared message refs, tool call under original narrator)
		//    - Subagent tool calls viewed inline in the parent narrator
		//    - Combination of both (fork + subagent)
		const candidate = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
		if (!candidate) throw new NotFoundError("ToolCall", toolUseId);

		// Verify: the tool call's message (or an ancestor via parentToolUseId)
		// must be reachable from this narrator's message refs.
		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, candidate.messageId),
			columns: { id: true, parentToolUseId: true },
		});
		if (msg) {
			// Check if the message itself is in this narrator's refs
			const directRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.messageId, msg.id),
				),
			});
			if (directRef) return candidate;

			// For subagent messages: the message has parentToolUseId pointing to
			// a tool_use block in the parent narrator's message. Find that parent
			// message and check if it's in our refs.
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
					if (parentRef) return candidate;
				}
			}
		}

		throw new NotFoundError("ToolCall", toolUseId);
	},

	/** Extract the full compact summary from a compact system message. */
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

	/**
	 * Delete a compact message and clear the narrator's contextSummary.
	 * Returns metadata about the deletion so callers can assess impact.
	 */
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

		// Check if there's an older compact point that will take over
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

		// Delete atomically
		await db.transaction(async (tx) => {
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, messageId));
			await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));

			// Both regular and plan compacts set contextSummary, so both need to clear it.
			// Also clear prune boundary — compact deletion invalidates the pruning context.
			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					contextSummary: null,
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

		return { previousCompactExists: prevCompact.length > 0 };
	},

	/**
	 * Delete a message and all subsequent messages from a narrator's conversation.
	 * Removes refs for the target message and everything after it (by seq).
	 * Messages not referenced by any other narrator are fully deleted.
	 * Resets apiConversationId since conversation history changed.
	 */
	async deleteMessage(narratorId: string, messageId: string) {
		// Verify the message belongs to this narrator via refs
		const targetRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!targetRef) throw new NotFoundError("Message", messageId);

		// Find all refs at or after this seq (the target + everything after it)
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

		// Auto-revert file changes before deleting messages
		await revertPatchesForMessages(narratorId, messageIds);

		await db.transaction(async (tx) => {
			// Remove refs for this narrator
			await tx.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.id, refIds));

			// Find messages that are now orphaned (not referenced by any narrator)
			// Also include child messages (sub-agent messages via parentToolUseId)
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

			// Also find child messages (sub-agent) of orphaned top-level messages
			const orphanIds = orphanRows.map((r) => r.id);
			if (orphanIds.length > 0) {
				// Get tool_use IDs from orphaned messages to find sub-agent children
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

				// Find child messages that reference these tool_use IDs
				if (toolUseIds.length > 0) {
					const childRows = await tx
						.select({ id: narratorMessages.id })
						.from(narratorMessages)
						.where(inArray(narratorMessages.parentToolUseId, toolUseIds));
					for (const c of childRows) orphanIds.push(c.id);
				}

				// Delete tool calls, then messages
				await tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds));
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			// Reset conversation state since history changed
			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

		return { deletedCount: refsToRemove.length };
	},

	/**
	 * Dismiss a single system error message (type="error") without affecting
	 * surrounding messages or resetting conversation state.
	 */
	async dismissErrorMessage(narratorId: string, messageId: string) {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) throw new NotFoundError("Message", messageId);

		// Verify it's actually an error system message
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
			// Delete the message itself only if no other narrator references it
			const otherRef = await tx.query.narratorMessageRefs.findFirst({
				where: eq(narratorMessageRefs.messageId, messageId),
			});
			if (!otherRef) {
				await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
			}
		});
	},

	/**
	 * Delete all messages strictly AFTER the given message (by seq order).
	 * The target message itself is preserved.
	 * Returns the list of deleted message IDs for WS broadcast.
	 */
	async deleteMessagesAfter(narratorId: string, messageId: string) {
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

		// Auto-revert file changes before deleting messages
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

				await tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, orphanIds));
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			const now = new Date().toISOString();
			await tx
				.update(narrators)
				.set({
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
		});

		return { deletedCount: refsToRemove.length, deletedMessageIds: messageIds };
	},

	/**
	 * Delete a single content block from a message by index.
	 * If the message becomes empty after removal, the entire message is deleted
	 * (without cascading to subsequent messages).
	 * Handles copy-on-write when the message is shared by multiple narrators.
	 */
	async deleteMessageBlock(narratorId: string, messageId: string, blockIndex: number) {
		// Verify the message belongs to this narrator
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

		// Auto-revert file changes if the removed block is a tool_use
		if (removedBlock.type === "tool_use" && removedBlock.id) {
			await revertPatchForToolUse(narratorId, removedBlock.id);
		}

		// Check if this message is shared by multiple narrators
		const refCount = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId));
		const isShared = (refCount[0]?.count ?? 0) > 1;

		let messageDeleted = false;

		await db.transaction(async (tx) => {
			// Helper: clean up a tool_use block's associated records
			const cleanToolUseBlock = async (block: { type: string; id?: string }, msgId: string) => {
				if (block.type !== "tool_use" || !block.id) return;
				// Delete tool call record for THIS message only
				await tx
					.delete(narratorToolCalls)
					.where(
						and(eq(narratorToolCalls.messageId, msgId), eq(narratorToolCalls.toolUseId, block.id)),
					);
				// Delete sub-agent child messages ONLY if no other narrator refs them
				const children = await tx
					.select({ id: narratorMessages.id })
					.from(narratorMessages)
					.where(eq(narratorMessages.parentToolUseId, block.id));
				if (children.length > 0) {
					const childIds = children.map((c) => c.id);
					// Check if any other narrator still references these children
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
						// No other narrator references — safe to delete
						await tx
							.delete(narratorToolCalls)
							.where(inArray(narratorToolCalls.messageId, childIds));
						await tx
							.delete(narratorMessageRefs)
							.where(inArray(narratorMessageRefs.messageId, childIds));
						await tx.delete(narratorMessages).where(inArray(narratorMessages.id, childIds));
					} else {
						// Other narrators still reference — only remove THIS narrator's refs
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
				// No blocks left — delete the entire message (this one only, no cascade)
				messageDeleted = true;

				// Clean up tool_use associations from the removed block
				await cleanToolUseBlock(removedBlock, messageId);

				// Remove ref for this narrator
				await tx
					.delete(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					);

				// If message is now orphaned, delete it
				if (!isShared) {
					await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, messageId));
					await tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId));
				}
			} else if (isShared) {
				// Copy-on-write: create a new message for this narrator
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

				// Update ref to point to new message
				await tx
					.update(narratorMessageRefs)
					.set({ messageId: newId })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					);

				// Copy retained tool_use blocks' tool_calls to new messageId
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

				// Clean up tool_use associations from the removed block (on new message)
				await cleanToolUseBlock(removedBlock, newId);
			} else {
				// Not shared — update in place
				const contentText = remaining
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n");

				await tx
					.update(narratorMessages)
					.set({ contentJson: remaining, contentText: contentText || null })
					.where(eq(narratorMessages.id, messageId));

				// Clean up tool_use associations from the removed block
				await cleanToolUseBlock(removedBlock, messageId);
			}

			// Reset conversation state since history changed
			await tx
				.update(narrators)
				.set({
					apiConversationId: null,
					pruneBoundaryMessageId: null,
					prunedPercent: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, narratorId));
		});

		return { messageDeleted };
	},

	/**
	 * Remove a compacting/compact message by ID without touching narrator's contextSummary.
	 * Used for rollback when compact generation fails mid-way.
	 */
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

	/**
	 * Update the summary text of a compact message and sync to narrator's contextSummary.
	 * Both updates happen atomically in a transaction.
	 */
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

			// Both regular and plan compacts sync contextSummary
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
		return tcs.map((tc) => ({
			id: tc.id,
			toolName: tc.toolName,
			toolUseId: tc.toolUseId,
			inputJson: tc.inputJson,
			decisionReason: tc.permissionDecisionReason,
			suggestions: tc.permissionSuggestions,
		}));
	},

	async persistUserMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		commandText?: string | null,
		createdBy?: string | null,
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: contentBlocks ?? [{ type: "text", text }],
				contentText: text,
				commandText: commandText ?? null,
				createdBy: createdBy ?? null,
				createdAt: now,
			})
			.returning();

		// Insert into narrator_message_refs junction table
		await appendMessageRef(narratorId, id);

		// Attach creator info for WS broadcast
		if (createdBy) {
			const user = await db.query.users.findFirst({
				where: eq(users.id, createdBy),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			});
			return { ...msg, creator: user ?? null };
		}
		return { ...msg, creator: null };
	},

	/**
	 * Persist a system-injected message into the narrator's chat history.
	 * Uses role="user" so the SDK includes it in conversation history
	 * (role="system" is filtered out by buildHistory).
	 * The `contentBlocks` carry structured metadata for the UI; a text block
	 * is always prepended so the model can read the plain-text content.
	 */
	async persistSystemMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		createdBy?: string,
	) {
		const id = generateId();
		const now = new Date().toISOString();
		// Always lead with a text block so the SDK sees the message content,
		// then append structured metadata blocks for the UI.
		const blocks: unknown[] = [{ type: "text", text }, ...(contentBlocks ?? [])];
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: blocks,
				contentText: text,
				createdBy: createdBy ?? null,
				createdAt: now,
			})
			.returning();

		await appendMessageRef(narratorId, id);
		return msg;
	},

	/**
	 * Persist a lightweight info system message (role="system", type="info").
	 * Excluded from model history — purely a UI notification in the chat timeline.
	 * Returns the created message row and broadcasts it via WebSocket.
	 */
	async persistInfoMessage(narratorId: string, text: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "info", message: text }],
				contentText: `[Info] ${text}`,
				createdAt: now,
			})
			.returning();
		await appendMessageRef(narratorId, id);
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "system",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				children: [],
			},
		});
		return msg;
	},

	async persistCompactingMessage(narratorId: string, beforeMessageId?: string) {
		const id = generateId();

		let seq: number;
		if (beforeMessageId) {
			// Atomically shift seq values and compute insertion point
			seq = await db.transaction(async (tx) => {
				const targetRef = await tx.query.narratorMessageRefs.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, beforeMessageId),
					),
				});
				if (!targetRef) throw new NotFoundError("Message", beforeMessageId);
				await tx
					.update(narratorMessageRefs)
					.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							gte(narratorMessageRefs.seq, targetRef.seq),
						),
					);
				return targetRef.seq;
			});
		} else {
			seq = await db.transaction(async (tx) => {
				const result = await tx
					.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, narratorId));
				return (result[0]?.maxSeq ?? -1) + 1;
			});
		}

		const createdAt = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacting" }],
				contentText: "[Compacting]",
				createdAt,
			})
			.returning();

		await insertMessageRef(narratorId, id, seq);

		return msg;
	},

	/**
	 * Insert a plan compact message — a compact marker with subtype "plan"
	 * that displays its content as a card rather than a collapsible indicator.
	 * Atomically inserts the message, sets isCompact=1, and updates contextSummary.
	 */
	async persistPlanMessage(narratorId: string, content: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", subtype: "plan", summary: content }],
				contentText: `[Plan] ${content.slice(0, 200)}...`,
				createdAt: now,
			})
			.returning();

		// Atomically: append ref with isCompact=1 and update narrator's contextSummary
		await db.transaction(async (tx) => {
			const result = await tx
				.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId));
			const seq = (result[0]?.maxSeq ?? -1) + 1;
			await tx.insert(narratorMessageRefs).values({
				id: generateId(),
				narratorId,
				messageId: id,
				seq,
				isCompact: 1,
			});
			await tx
				.update(narrators)
				.set({ contextSummary: content, apiConversationId: null, updatedAt: now })
				.where(eq(narrators.id, narratorId));
		});

		return msg;
	},

	/**
	 * Insert a compact marker with empty summary to clear the context.
	 * Subsequent queries will start loading from after this point,
	 * effectively discarding all prior messages from the AI's context window.
	 */
	async clearContext(narratorId: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", summary: "" }],
				contentText: "[Context cleared]",
				createdAt: now,
			})
			.returning();

		await db.transaction(async (tx) => {
			const result = await tx
				.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId));
			const seq = (result[0]?.maxSeq ?? -1) + 1;
			await tx.insert(narratorMessageRefs).values({
				id: generateId(),
				narratorId,
				messageId: id,
				seq,
				isCompact: 1,
			});
			await tx
				.update(narrators)
				.set({ contextSummary: null, apiConversationId: null, updatedAt: now })
				.where(eq(narrators.id, narratorId));
		});

		return msg;
	},

	/**
	 * Finalize a "compacting" system message to "compacted" with the full summary.
	 * Atomically updates the message content, sets isCompact=1 on the ref,
	 * and stores the summary on the narrator — all in one transaction.
	 */
	async finalizeCompactingMessage(
		messageId: string,
		narratorId: string,
		summary: string,
		contextPercent?: number,
		options?: { status?: "compacted" | "failed"; error?: string },
	) {
		const now = new Date().toISOString();
		const status = options?.status ?? "compacted";
		const compactBlock: Record<string, unknown> = { type: "compact", status, summary };
		if (status === "failed" && options?.error) {
			compactBlock.error = options.error;
		}
		const prefix = status === "failed" ? "[Compact Failed]" : "[Compact]";

		return db.transaction(async (tx) => {
			const [updated] = await tx
				.update(narratorMessages)
				.set({
					contentJson: [compactBlock],
					contentText: `${prefix} ${summary.slice(0, 200)}...`,
					contextPercent: contextPercent ?? null,
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning();
			if (!updated) return null;

			await tx
				.update(narratorMessageRefs)
				.set({ isCompact: status === "compacted" ? 1 : 0 })
				.where(
					and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				);

			// Only successful compact should reset context summary/API conversation.
			if (status === "compacted") {
				await tx
					.update(narrators)
					.set({ contextSummary: summary, apiConversationId: null, updatedAt: now })
					.where(eq(narrators.id, narratorId));
			}

			return updated;
		});
	},

	async persistAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			message: { content: any[]; usage?: any };
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

		// Extract plain text for search
		const contentText = content
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text")
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n");

		const usage = sdkMessage.message.usage;
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				messageUuid: sdkMessage.uuid,
				parentToolUseId: sdkMessage.parent_tool_use_id ?? null,
				role: "assistant",
				contentJson: content,
				contentText: contentText || null,
				tokensIn: usage?.input_tokens,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			})
			.returning();

		// Insert into narrator_message_refs junction table
		await appendMessageRef(narratorId, id);

		// Extract tool_use blocks and create tool call records
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
		for (const block of toolUseBlocks) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId: id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: block.input,
				status: "initializing",
				createdAt: now,
			});
		}

		return msg;
	},

	/**
	 * Create a partial assistant message with no content blocks yet.
	 * Blocks will be appended incrementally via appendBlockToMessage().
	 */
	async createPartialAssistantMessage(
		narratorId: string,
		sdkMessage: {
			uuid: string;
			session_id: string;
			parent_tool_use_id?: string | null;
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
			tokensIn?: number;
			turnUsage?: Record<string, unknown>;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();

		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				messageUuid: sdkMessage.uuid,
				parentToolUseId: sdkMessage.parent_tool_use_id ?? null,
				role: "assistant",
				contentJson: [],
				contentText: null,
				tokensIn: sdkMessage.tokensIn ?? null,
				turnUsageJson: sdkMessage.turnUsage ?? null,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			})
			.returning();

		await appendMessageRef(narratorId, id);
		return msg;
	},

	/**
	 * Append a completed content block to an existing assistant message
	 * and optionally create a tool_call record for tool_use blocks.
	 */
	async appendBlockToMessage(
		messageId: string,
		narratorId: string,
		block:
			| { type: "text"; text: string }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
			  }
			| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
			| { type: "web_search"; id: string; query?: string; queries?: string[] },
	) {
		const existing = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		if (!existing) return;

		// Keep a stable canonical order for assistant blocks regardless of stream arrival order:
		// reasoning → text/other non-tool blocks → tool_use.
		// This avoids cases where streaming tool_use blocks are persisted before reasoning/text.
		type StoredAssistantBlock =
			| { type: "text"; text: string }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
			  }
			| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
			| { type: string; text?: unknown; [key: string]: unknown };
		const current = (
			Array.isArray(existing.contentJson) ? existing.contentJson : []
		) as StoredAssistantBlock[];
		let content: StoredAssistantBlock[];
		if (block.type === "reasoning") {
			const idx = current.findIndex((b) => b.type !== "reasoning");
			content =
				idx === -1 ? [...current, block] : [...current.slice(0, idx), block, ...current.slice(idx)];
		} else if (block.type === "text") {
			const idx = current.findIndex((b) => b.type === "tool_use");
			content =
				idx === -1 ? [...current, block] : [...current.slice(0, idx), block, ...current.slice(idx)];
		} else {
			content = [...current, block];
		}
		const contentText = content
			.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
			.join("\n");

		await db
			.update(narratorMessages)
			.set({ contentJson: content, contentText: contentText || null })
			.where(eq(narratorMessages.id, messageId));

		// Create tool_call record for tool_use blocks
		if (block.type === "tool_use") {
			const now = new Date().toISOString();
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: block.input,
				status: "initializing",
				createdAt: now,
			});
		}
	},

	/**
	 * Patch a reasoning block's translatedText within an existing message.
	 * Finds the reasoning block at the given index and sets its translatedText field.
	 */
	async patchReasoningTranslation(
		messageId: string,
		reasoningIndex: number,
		translatedText: string,
	) {
		const existing = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		if (!existing) return;

		const content = Array.isArray(existing.contentJson) ? [...existing.contentJson] : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON content blocks
		const block = content[reasoningIndex] as any;
		if (!block || block.type !== "reasoning") return;

		block.translatedText = translatedText;
		await db
			.update(narratorMessages)
			.set({ contentJson: content })
			.where(eq(narratorMessages.id, messageId));
	},

	async updateConversationId(narratorId: string, apiConversationId: string) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ apiConversationId, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStats(narratorId: string, costUsd: number) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				messageCount: sql`COALESCE(${narrators.messageCount}, 0) + 1`,
				totalCostUsd: sql`COALESCE(${narrators.totalCostUsd}, 0) + ${costUsd}`,
				lastMessageAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	},

	async updateMessageCost(messageId: string, costUsd: number, turnUsage?: Record<string, unknown>) {
		await db
			.update(narratorMessages)
			.set({
				costUsd,
				...(turnUsage ? { turnUsageJson: turnUsage } : {}),
			})
			.where(eq(narratorMessages.id, messageId));
	},

	async updateTitle(narratorId: string, title: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ title, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateModel(narratorId: string, model: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ model, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updatePermissionMode(
		narratorId: string,
		permissionMode:
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "plan"
			| "dontAsk",
	) {
		const now = new Date().toISOString();

		// When manually switching to plan mode, save the current mode so it can be restored on exit
		if (permissionMode === "plan") {
			const current = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { permissionMode: true },
			});
			const prevMode = current?.permissionMode ?? "default";
			if (prevMode !== "plan") {
				await db
					.update(narrators)
					.set({ permissionMode, previousPermissionMode: prevMode, updatedAt: now })
					.where(eq(narrators.id, narratorId));
			} else {
				await db
					.update(narrators)
					.set({ permissionMode, updatedAt: now })
					.where(eq(narrators.id, narratorId));
			}
		} else {
			await db
				.update(narrators)
				.set({ permissionMode, previousPermissionMode: null, updatedAt: now })
				.where(eq(narrators.id, narratorId));
		}

		// 同步权限模式到所有活跃的 subagent
		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(
				and(
					eq(narrators.parentNarratorId, narratorId),
					eq(narrators.type, "subagent"),
					inArray(narrators.status, ["thinking", "waiting", "idle"]),
				),
			);
	},

	async updateReasoningEffort(
		narratorId: string,
		reasoningEffort: "none" | "low" | "medium" | "high" | null,
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ reasoningEffort, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateFastMode(narratorId: string, fastMode: boolean) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ fastMode, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateRelaxedPlan(narratorId: string, relaxedPlan: boolean) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ relaxedPlan, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updatePruneEnabled(narratorId: string, pruneEnabled: boolean) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ pruneEnabled, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStatus(
		narratorId: string,
		status: "idle" | "thinking" | "waiting" | "done" | "archived" | "error" | "interrupted",
		errorMessage?: string,
	) {
		const now = new Date().toISOString();
		// Keep error message only when status is explicitly "error".
		// Any non-error status transition clears stale error text.
		const normalizedErrorMessage = status === "error" ? (errorMessage ?? null) : null;
		await db
			.update(narrators)
			.set({ status, errorMessage: normalizedErrorMessage, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		eventBus.emit(
			status === "error"
				? {
						type: "narrator:error",
						narratorId,
						error: normalizedErrorMessage ?? "Unknown error",
					}
				: { type: "narrator:status_changed", narratorId, status },
		);

		// Direct WS broadcast (canonical push path)
		if (status === "error") {
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
			});

			// Persist a system-level error message visible in the UI but excluded
			try {
				const errText = normalizedErrorMessage ?? "Unknown error";
				const msgId = generateId();
				await db.insert(narratorMessages).values({
					id: msgId,
					narratorId,
					role: "system",
					contentJson: [{ type: "error", message: errText }],
					contentText: `[Error] ${errText}`,
					createdAt: now,
				});
				await appendMessageRef(narratorId, msgId);
				broadcastToNarrator(narratorId, {
					type: "message",
					narratorId,
					message: {
						id: msgId,
						narratorId,
						role: "system",
						contentJson: [{ type: "error", message: errText }],
						contentText: `[Error] ${errText}`,
						createdAt: now,
						children: [],
					},
				});
			} catch (e) {
				logger.warn("Failed to persist error system message", {
					narratorId,
					error: String(e),
				});
			}
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status,
		});
	},

	/**
	 * Atomically update narrator status only if the current DB status matches one
	 * of the expected values.  Uses a single SQL UPDATE … WHERE to avoid the
	 * TOCTOU race that exists in the read-then-write pattern.
	 *
	 * Returns `true` when the row was actually updated, `false` when the status
	 * had already moved on (no-op).
	 */
	async compareAndSetStatus(
		narratorId: string,
		expectedStatus: string | string[],
		newStatus: "idle" | "thinking" | "waiting" | "done" | "archived" | "error" | "interrupted",
		errorMessage?: string,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const normalizedErrorMessage = newStatus === "error" ? (errorMessage ?? null) : null;
		const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
		const placeholders = expected.map(() => "?").join(",");
		const result = sqlite
			.prepare(
				`UPDATE narrators SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
			)
			.run(newStatus, normalizedErrorMessage, now, narratorId, ...expected);

		if (result.changes === 0) return false;

		eventBus.emit(
			newStatus === "error"
				? {
						type: "narrator:error",
						narratorId,
						error: normalizedErrorMessage ?? "Unknown error",
					}
				: { type: "narrator:status_changed", narratorId, status: newStatus },
		);
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status: newStatus,
		});
		return true;
	},

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	async updateTodos(narratorId: string, todos: any[], toolUseId?: string) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ todosJson: todos, todosToolUseId: toolUseId ?? null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateToolCallResult(
		toolUseId: string,
		result: {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			output?: any;
			status: "success" | "fail";
			errorMessage?: string;
			durationMs?: number;
		},
	) {
		await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				status: result.status,
				errorMessage: result.errorMessage ?? null,
				durationMs: result.durationMs ?? null,
			})
			.where(eq(narratorToolCalls.toolUseId, toolUseId));
	},

	/** Overwrite the persisted inputJson for a tool call (used for broken/truncated calls).
	 *  Also patches the corresponding tool_use block in the parent message's contentJson. */
	async overwriteToolCallInput(toolUseId: string, input: Record<string, unknown>) {
		logger.info("Overwriting broken tool call input", { toolUseId, inputKeys: Object.keys(input) });
		// Update the tool_calls table
		await db
			.update(narratorToolCalls)
			.set({ inputJson: input })
			.where(eq(narratorToolCalls.toolUseId, toolUseId));

		// Also patch the contentJson in the parent message so the UI shows
		// the sanitized input instead of the truncated garbage.
		const tc = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { messageId: true },
		});
		if (tc?.messageId) {
			const msg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, tc.messageId),
				columns: { contentJson: true },
			});
			if (msg?.contentJson && Array.isArray(msg.contentJson)) {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const patched = (msg.contentJson as any[]).map((block: any) =>
					block.type === "tool_use" && block.id === toolUseId ? { ...block, input } : block,
				);
				await db
					.update(narratorMessages)
					.set({ contentJson: patched })
					.where(eq(narratorMessages.id, tc.messageId));
			}
		}
	},

	/**
	 * Retrieve the plan text from an ExitPlanMode tool call's inputJson.
	 * The plan content is stored in inputJson.plan by handlePermission (which
	 * resolves planFile → inline plan content before persisting).
	 */
	async getToolCallPlanText(toolUseId: string): Promise<string | null> {
		const tc = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { inputJson: true },
		});
		const plan = (tc?.inputJson as Record<string, unknown> | null)?.plan;
		return typeof plan === "string" && plan.trim() ? plan : null;
	},

	async remove(narratorId: string) {
		// Recursively remove child narrators (subagents, forks) first
		const children = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, narratorId),
			columns: { id: true },
		});
		for (const child of children) {
			await this.remove(child.id);
		}

		// Delete in dependency order within a transaction
		await db.transaction(async (tx) => {
			// Clean up terminal-related records that reference this narrator
			await tx.delete(terminalViewState).where(eq(terminalViewState.narratorId, narratorId));
			await tx.delete(terminalTabs).where(eq(terminalTabs.narratorId, narratorId));
			await tx.delete(terminals).where(eq(terminals.narratorId, narratorId));

			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
			// Delete narrator_message_refs for this narrator
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));

			// Find messages that are ONLY owned by this narrator (not referenced by other narrators)
			const orphanRows = await tx
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.narratorId, narratorId),
						sql`NOT EXISTS (
							SELECT 1 FROM narrator_message_refs nmr
							WHERE nmr.message_id = ${narratorMessages.id}
							AND nmr.narrator_id != ${narratorId}
						)`,
					),
				);
			const orphanIds = orphanRows.map((r) => r.id);

			if (orphanIds.length > 0) {
				await tx.delete(narratorMessages).where(inArray(narratorMessages.id, orphanIds));
			}

			await tx.delete(narrators).where(eq(narrators.id, narratorId));
		});
		await deleteNarratorUploads(narratorId);

		logger.info("Narrator removed", { narratorId });
	},

	// === Fork ===

	async forkNarrator(
		parentNarratorId: string,
		forkMessageUuid: string | null,
		opts?: {
			title?: string;
			newChapterId?: string;
			inheritMode?: "full" | "compressed" | "fresh";
			locale?: string;
		},
	) {
		const parent = await this.getById(parentNarratorId);

		if (parent.type === "subagent") {
			throw new ValidationError("Cannot fork from a subagent narrator");
		}

		// Chapter-bound narrators must fork via chapter fork (newChapterId required)
		if (parent.chapterId && !opts?.newChapterId) {
			throw new ValidationError(
				"Chapter-bound narrators can only be forked together with a chapter",
			);
		}

		const inheritMode = opts?.inheritMode ?? "fresh";
		const now = new Date().toISOString();
		const id = generateId();

		const resolvedPermMode = (parent.permissionMode ?? "default") as
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "dontAsk";

		// For chapter forks: new chapter ID; for standalone forks: null (stays standalone)
		const targetChapterId = opts?.newChapterId ?? null;

		// Handle context inheritance
		let contextSummary: string | null = null;
		let apiConversationId: string | null = null;
		let systemPrompt = parent.systemPrompt;

		if (inheritMode === "compressed") {
			const { narratorContext } = await import("./narrator-context");
			const locale = (opts?.locale ?? "en") as import("../lib/prompt-i18n").Locale;
			contextSummary = await narratorContext.generateContextSummary(parentNarratorId, locale);
			if (contextSummary && parent.systemPrompt) {
				systemPrompt = `${parent.systemPrompt}\n\n## Previous Context Summary\n\nThis session continues from a previous conversation. Here is a summary of the prior context:\n\n${contextSummary}`;
			}
		} else if (inheritMode === "full") {
			// Store parent session ID so we can fork on first message
			apiConversationId = parent.apiConversationId ?? null;
			// Inherit compact summary so context before the last compact point isn't lost
			contextSummary = parent.contextSummary ?? null;
		}

		// Copy message refs if forkMessageUuid is provided AND inheritance is not fresh
		let prefixRows: Array<{
			messageId: string;
			seq: number;
			isCompact: number;
			prunedPercent: number | null;
		}> = [];
		let resolvedForkMessageId: string | null = null;

		if (forkMessageUuid && inheritMode !== "fresh") {
			// Resolve messageUuid → message ID → narrator ref
			const msg = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.messageUuid, forkMessageUuid),
			});
			if (!msg) throw new ValidationError("Fork message not found");

			const forkRef = await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, parentNarratorId),
					eq(narratorMessageRefs.messageId, msg.id),
				),
			});
			if (!forkRef) throw new ValidationError("Fork message not found in parent narrator's refs");
			resolvedForkMessageId = forkRef.messageId;

			prefixRows = await db
				.select({
					messageId: narratorMessageRefs.messageId,
					seq: narratorMessageRefs.seq,
					isCompact: narratorMessageRefs.isCompact,
					prunedPercent: narratorMessageRefs.prunedPercent,
				})
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentNarratorId),
						sql`${narratorMessageRefs.seq} <= ${forkRef.seq}`,
					),
				)
				.orderBy(narratorMessageRefs.seq);
		}

		// Create narrator + copy refs atomically
		const resolvedModel = parent.model ?? "claude-sonnet-4.5";
		const resolvedProvider = resolveProvider(resolvedModel);
		const resolvedReasoningEffort =
			parent.reasoningEffort ??
			(usesCodexApiMode(resolvedProvider)
				? (settings.codex?.defaultReasoningEffort ?? null)
				: null);

		const newNarrator = await db.transaction(async (tx) => {
			const [created] = await tx
				.insert(narrators)
				.values({
					id,
					chapterId: targetChapterId,
					type: "primary",
					model: resolvedModel,
					systemPrompt,
					permissionMode: resolvedPermMode,
					reasoningEffort: resolvedReasoningEffort,
					fastMode: parent.fastMode ?? false,
					relaxedPlan: parent.relaxedPlan ?? settings.agent.defaultRelaxedPlan,
					parentNarratorId,
					forkMessageId: resolvedForkMessageId,
					inheritMode,
					apiConversationId,
					contextSummary,
					status: "idle",
					title: opts?.title ?? null,
					cwd: parent.cwd ?? null,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			// Batch insert refs (preserve prunedPercent from parent)
			if (prefixRows.length > 0) {
				await tx.insert(narratorMessageRefs).values(
					prefixRows.map((row) => ({
						id: generateId(),
						narratorId: id,
						messageId: row.messageId,
						seq: row.seq,
						isCompact: row.isCompact,
						prunedPercent: row.prunedPercent,
					})),
				);

				// Inherit prune state from parent if the boundary falls within the copied prefix.
				// This prevents fork from resetting prunedPercent to 0, which would cause the
				// new narrator to skip pruning and jump straight to compact.
				if (parent.pruneBoundaryMessageId) {
					const boundaryInPrefix = prefixRows.find(
						(r) => r.messageId === parent.pruneBoundaryMessageId,
					);
					if (boundaryInPrefix) {
						// Recompute prunedPercent relative to the new narrator's ref count
						const boundaryIdx = prefixRows.indexOf(boundaryInPrefix);
						const inheritedPrunedPercent = Math.round(
							((boundaryIdx + 1) / prefixRows.length) * 100,
						);
						await tx
							.update(narrators)
							.set({
								pruneBoundaryMessageId: parent.pruneBoundaryMessageId,
								prunedPercent: inheritedPrunedPercent,
							})
							.where(eq(narrators.id, id));
					}
				}
			}

			// Insert a compact marker for compressed inheritance so the UI shows the summary
			if (inheritMode === "compressed" && contextSummary) {
				const compactMsgId = generateId();
				const compactNow = new Date().toISOString();
				await tx.insert(narratorMessages).values({
					id: compactMsgId,
					narratorId: id,
					role: "system",
					contentJson: [{ type: "compact", status: "compacted", summary: contextSummary }],
					contentText: `[Compressed context from parent conversation]`,
					createdAt: compactNow,
				});
				const maxSeqResult = await tx
					.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, id));
				const compactSeq = (maxSeqResult[0]?.maxSeq ?? -1) + 1;
				await tx.insert(narratorMessageRefs).values({
					id: generateId(),
					narratorId: id,
					messageId: compactMsgId,
					seq: compactSeq,
					isCompact: 1,
				});
			}

			// Inherit whitelist directories from parent narrator
			const parentWhitelistDirs = await tx
				.select()
				.from(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, parentNarratorId));

			if (parentWhitelistDirs.length > 0) {
				await tx.insert(narratorWhitelistDirs).values(
					parentWhitelistDirs.map((dir) => ({
						id: generateId(),
						narratorId: id,
						path: dir.path,
						accessLevel: dir.accessLevel,
						enabled: dir.enabled,
						createdAt: now,
					})),
				);
			}

			return created;
		});

		eventBus.emit({ type: "narrator:forked", narratorId: id, parentNarratorId });
		broadcastToNarrator(parentNarratorId, {
			type: "narrator_forked",
			narratorId: id,
			parentNarratorId,
		});
		logger.info("Narrator forked", { parentNarratorId, newNarratorId: id, forkMessageUuid });
		return newNarrator;
	},

	// === Dynamic pruning boundary ===

	/**
	 * Compute and persist the prune boundary based on current context usage.
	 *
	 * Uses a quadratic ramp: `pruneRatio = t²` where `t = (pct - 90) / 5`.
	 * At minimum, one message is always pruned once the threshold is reached.
	 * A single prune pass is capped at 50% of the currently remaining prunable range.
	 * The boundary never exceeds the compact-keep position (the message returned
	 * by `getCompactBoundaryMessage`), so compact always has something to work with.
	 *
	 * Returns the boundary message ID and pruned percentage, or null if no pruning is needed.
	 */
	async computeAndUpdatePruneBoundary(
		narratorId: string,
		contextPct: number,
	): Promise<{ boundaryMessageId: string; prunedPercent: number } | null> {
		const PRUNE_START = 95;
		const PRUNE_END = 99;

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true, pruneEnabled: true },
		});

		// If pruning is disabled for this narrator, skip entirely.
		if (narrator && !narrator.pruneEnabled) return null;

		if (contextPct < PRUNE_START) {
			if (narrator?.pruneBoundaryMessageId) {
				await this.clearPruneBoundary(narratorId);
			}
			return null;
		}

		const t = Math.min((contextPct - PRUNE_START) / (PRUNE_END - PRUNE_START), 1);
		const pruneRatio = t * t;

		// Reuse the shared helper — same data that getCompactBoundaryMessage uses
		const includeChildMessages = await this.isSubagentNarrator(narratorId);
		const refs = await this._getPostCompactTopLevelRefs(narratorId, {
			includeChildMessages,
		});

		// Compact keeps the last 4 messages (2 pairs). Need at least 6 to have
		// something prunable (4 kept + at least 2 to prune/compact).
		const compactKeepCount = 4;
		if (refs.length < compactKeepCount + 2) return null;

		// Prunable range: everything except the compact-keep tail
		const prunableRefs = refs.slice(0, refs.length - compactKeepCount);

		// Find current boundary position to compute remaining (unpruned) messages
		const currentBoundaryIdx = narrator?.pruneBoundaryMessageId
			? prunableRefs.findIndex((r) => r.messageId === narrator.pruneBoundaryMessageId)
			: -1;

		// Remaining = messages after the current boundary (or all if no boundary yet)
		const alreadyPruned = currentBoundaryIdx + 1; // 0 if no boundary
		const remaining = prunableRefs.length - alreadyPruned;
		if (remaining <= 0) {
			const bid = narrator?.pruneBoundaryMessageId ?? null;
			if (!bid) return null;
			const prunedPercent = Math.round((alreadyPruned / refs.length) * 100);
			return { boundaryMessageId: bid, prunedPercent };
		}

		// Apply ratio to remaining messages — more aggressive as context grows,
		// and each call prunes further into what's left.
		// Safety cap: a single prune pass cannot remove more than 50% of what's remaining.
		const maxPruneThisPass = Math.max(1, Math.floor(remaining * 0.5));
		const additionalPrune = Math.min(
			maxPruneThisPass,
			Math.max(1, Math.floor(pruneRatio * remaining)),
		);
		const newBoundaryIdx = alreadyPruned + additionalPrune - 1;

		const boundaryMessageId = prunableRefs[newBoundaryIdx].messageId;
		const prunedPercent = Math.round(((newBoundaryIdx + 1) / refs.length) * 100);
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ pruneBoundaryMessageId: boundaryMessageId, prunedPercent, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		logger.debug("Updated prune boundary", {
			narratorId,
			contextPct,
			pruneRatio: Math.round(pruneRatio * 100),
			additionalPrune,
			remaining,
			prunableTotal: prunableRefs.length,
			boundaryMessageId,
			prunedPercent,
		});

		return { boundaryMessageId, prunedPercent };
	},

	/** Clear the prune boundary (e.g. after compact completes). */
	async clearPruneBoundary(narratorId: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ pruneBoundaryMessageId: null, prunedPercent: null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},
};
