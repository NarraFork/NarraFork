import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorSidecars,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import type { ApiRequestDiagnostics, ToolExecutionTarget } from "../lib/agent/types";
import { narratorSubstatusLock } from "../lib/async-mutex";
import type {
	AutoContinuationOverride,
	BooleanOverride,
	DangerReflectionOverride,
} from "../lib/boolean-override";
import { withDbRetry } from "../lib/db-resilience";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import type { PermissionMode } from "../lib/permission-modes";
import { getMinPruneRatio } from "../lib/settings/provider";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { preserveTurnTimingSubstatus, transitionTurnTimingSubstatus } from "./narrator-turn-timing";
import { preserveTakenOverSubstatus } from "./subagent-takeover";

// ── Internal helpers ───────────────────────────────────────────────────────

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Embed a Gemini 3 thought signature inside a tool call's persisted inputJson
 * under a reserved key so it survives history rebuilds (reload/compact) without
 * a DB schema change. The Gemini provider strips this key before sending the
 * args back to the model. Non-Gemini tool calls are stored unchanged.
 */
function withGeminiThoughtSignature(
	input: unknown,
	thoughtSignature: unknown,
	thoughtSignatureSource: unknown,
): unknown {
	if (
		typeof thoughtSignature !== "string" ||
		!thoughtSignature ||
		!input ||
		typeof input !== "object" ||
		Array.isArray(input)
	) {
		return input;
	}
	return {
		...(input as Record<string, unknown>),
		__geminiThoughtSignature: thoughtSignature,
		...(typeof thoughtSignatureSource === "string" && thoughtSignatureSource
			? { __geminiThoughtSignatureSource: thoughtSignatureSource }
			: {}),
	};
}

async function bumpNarratorMessageVersions(
	narratorIds: Iterable<string | null | undefined>,
): Promise<void> {
	const ids = [...new Set([...narratorIds].filter((id): id is string => !!id))];
	if (ids.length === 0) return;
	await db
		.update(narrators)
		.set({
			messageVersion: sql`${narrators.messageVersion} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(inArray(narrators.id, ids));
}

export async function bumpParentNarratorMessageVersion(
	parentToolUseId?: string | null,
): Promise<void> {
	if (!parentToolUseId) return;
	const parentToolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.toolUseId, parentToolUseId),
		columns: { narratorId: true },
	});
	if (!parentToolCall) return;
	await bumpNarratorMessageVersions([parentToolCall.narratorId]);
}

/** Insert a message into narrator_message_refs junction table */
async function insertMessageRef(
	narratorId: string,
	messageId: string,
	seq: number,
	isCompact = 0,
	prunedPercent?: number | null,
): Promise<void> {
	await withDbRetry(
		() =>
			db.insert(narratorMessageRefs).values({
				id: generateId(),
				narratorId,
				messageId,
				seq,
				isCompact,
				prunedPercent: prunedPercent ?? null,
			}),
		{ label: "insertMessageRef", maxRetries: 5 },
	);
}

/**
 * Synchronous variant of {@link appendMessageRefTx} for use inside a
 * synchronous `db.transaction((tx) => …)` — the ONLY genuinely atomic
 * transaction form under bun:sqlite (async callbacks commit at the first
 * `await`, leaving later writes outside the transaction). Uses Drizzle's
 * synchronous terminal methods (`.all()` / `.run()` / `.sync()`).
 */
function appendMessageRefSync(
	tx: DbTx,
	narratorId: string,
	messageId: string,
	isCompact = 0,
	prunedPercent?: number | null,
): number {
	const result = tx
		.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.all();
	const seq = (result[0]?.maxSeq ?? -1) + 1;

	let resolvedPrunedPercent = prunedPercent ?? null;
	if (resolvedPrunedPercent == null) {
		const narrator = tx.query.narrators
			.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { prunedPercent: true },
			})
			.sync();
		resolvedPrunedPercent = narrator?.prunedPercent ?? null;
	}

	tx.insert(narratorMessageRefs)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			seq,
			isCompact,
			prunedPercent: resolvedPrunedPercent,
		})
		.run();

	tx.update(narrators)
		.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
		.where(eq(narrators.id, narratorId))
		.run();

	return seq;
}

/** Atomically get next seq and insert into narrator_message_refs */
async function appendMessageRef(
	narratorId: string,
	messageId: string,
	isCompact = 0,
	prunedPercent?: number | null,
): Promise<number> {
	return withDbRetry(
		async () =>
			db.transaction((tx) =>
				appendMessageRefSync(tx, narratorId, messageId, isCompact, prunedPercent),
			),
		{ label: "appendMessageRef", maxRetries: 5 },
	);
}

// ── Exported appendMessageRef for use by narrator-service.ts ───────────────
export { appendMessageRef, insertMessageRef };

const BACKGROUND_COMPACTING_SUBSTATUS = "background_compacting";

function preserveBackgroundCompactingSubstatus(current: string[], next: string[]): string[] {
	if (
		current.includes(BACKGROUND_COMPACTING_SUBSTATUS) &&
		!next.includes(BACKGROUND_COMPACTING_SUBSTATUS) &&
		!next.includes("compacting")
	) {
		return [...next, BACKGROUND_COMPACTING_SUBSTATUS];
	}
	return next;
}

async function writeSubstatus(
	narratorId: string,
	substatus: string[],
	now = new Date().toISOString(),
) {
	// Retry on transient SQLite locks so a busy DB never leaves a stale substatus
	// tag (e.g. "reflecting"/"reasoning") stuck on the narrator forever.
	await withDbRetry(
		() =>
			db
				.update(narrators)
				.set({ substatus: JSON.stringify(substatus), updatedAt: now })
				.where(eq(narrators.id, narratorId)),
		{ label: "writeSubstatus", maxRetries: 5 },
	);
}

// ── narratorPersistence object ─────────────────────────────────────────────

export const narratorPersistence = {
	async persistUserMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		commandText?: string | null,
		createdBy?: string | null,
	) {
		return withDbRetry(
			async () => {
				const id = generateId();
				const now = new Date().toISOString();
				const { msg, seq } = db.transaction((tx) => {
					const created = tx
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
						.returning()
						.get();
					const seq = appendMessageRefSync(tx, narratorId, id);
					return { msg: created, seq };
				});

				if (createdBy) {
					const user = await db.query.users.findFirst({
						where: eq(users.id, createdBy),
						columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
					});
					return { ...msg, seq, creator: user ?? null };
				}
				return { ...msg, seq, creator: null };
			},
			{ label: "persistUserMessage", maxRetries: 5 },
		);
	},

	async persistSystemMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		createdBy?: string,
	) {
		return withDbRetry(
			async () =>
				db.transaction((tx) => {
					const id = generateId();
					const now = new Date().toISOString();
					const blocks: unknown[] = [{ type: "text", text }, ...(contentBlocks ?? [])];
					const msg = tx
						.insert(narratorMessages)
						.values({
							id,
							narratorId,
							role: "sys",
							contentJson: blocks,
							contentText: text,
							createdBy: createdBy ?? null,
							createdAt: now,
						})
						.returning()
						.get();

					const seq = appendMessageRefSync(tx, narratorId, id);
					return { ...msg, seq };
				}),
			{ label: "persistSystemMessage", maxRetries: 5 },
		);
	},

	async persistDisplayMessage(
		narratorId: string,
		text: string,
		// UI-only content blocks. When provided they replace the default `info`
		// block, letting callers render richer cards (e.g. spec_goal_added) while
		// keeping the message role `disp` so it never enters the model history.
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
	) {
		const { msg, seq } = await withDbRetry(
			async () =>
				db.transaction((tx) => {
					const id = generateId();
					const now = new Date().toISOString();
					const msg = tx
						.insert(narratorMessages)
						.values({
							id,
							narratorId,
							role: "disp",
							contentJson: contentBlocks ?? [{ type: "info", message: text }],
							// Preserve the legacy `[Info] …` contentText for the default info
							// card (a documented parity contract); custom-block callers pass
							// their own already-formatted text.
							contentText: contentBlocks ? text : `[Info] ${text}`,
							createdAt: now,
						})
						.returning()
						.get();
					const seq = appendMessageRefSync(tx, narratorId, id);
					return { msg, seq };
				}),
			{ label: "persistDisplayMessage", maxRetries: 5 },
		);
		broadcastToNarrator(narratorId, {
			type: "message",
			narratorId,
			message: {
				id: msg.id,
				narratorId,
				role: "disp",
				contentJson: msg.contentJson,
				contentText: msg.contentText,
				createdAt: msg.createdAt,
				seq,
				children: [],
			},
		});
		return { ...msg, seq };
	},

	async persistCompactingMessage(
		narratorId: string,
		beforeMessageId?: string,
		mode: "blocking" | "background" = "blocking",
	) {
		const id = generateId();
		const createdAt = new Date().toISOString();

		return withDbRetry(
			async () =>
				db.transaction((tx) => {
					let seq: number;
					if (beforeMessageId) {
						const targetRef = tx.query.narratorMessageRefs
							.findFirst({
								where: and(
									eq(narratorMessageRefs.narratorId, narratorId),
									eq(narratorMessageRefs.messageId, beforeMessageId),
								),
							})
							.sync();
						if (!targetRef) throw new NotFoundError("Message", beforeMessageId);
						seq = targetRef.seq;
						tx.update(narratorMessageRefs)
							.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
							.where(
								and(
									eq(narratorMessageRefs.narratorId, narratorId),
									gte(narratorMessageRefs.seq, seq),
								),
							)
							.run();
					} else {
						const result = tx
							.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
							.from(narratorMessageRefs)
							.where(eq(narratorMessageRefs.narratorId, narratorId))
							.all();
						seq = (result[0]?.maxSeq ?? -1) + 1;
					}

					const msg = tx
						.insert(narratorMessages)
						.values({
							id,
							narratorId,
							role: "system",
							contentJson: [{ type: "compact", status: "compacting", mode }],
							contentText: "[Compacting]",
							createdAt,
						})
						.returning()
						.get();

					tx.insert(narratorMessageRefs)
						.values({
							id: generateId(),
							narratorId,
							messageId: id,
							seq,
							isCompact: 0,
						})
						.run();

					tx.update(narrators)
						.set({
							messageVersion: sql`${narrators.messageVersion} + 1`,
							updatedAt: createdAt,
						})
						.where(eq(narrators.id, narratorId))
						.run();

					return { ...msg, seq };
				}),
			{ label: "persistCompactingMessage", maxRetries: 5 },
		);
	},

	async persistPlanMessage(narratorId: string, content: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = db.transaction((tx) => {
			const msg = tx
				.insert(narratorMessages)
				.values({
					id,
					narratorId,
					role: "system",
					contentJson: [
						{ type: "compact", status: "compacted", subtype: "plan", summary: content },
					],
					contentText: `[Plan] ${content.slice(0, 200)}...`,
					createdAt: now,
				})
				.returning()
				.get();

			const result = tx
				.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId))
				.all();
			const seq = (result[0]?.maxSeq ?? -1) + 1;
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					contextSummary: content,
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq };
		});

		return { ...msg, seq };
	},

	async clearContext(narratorId: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = db.transaction((tx) => {
			const msg = tx
				.insert(narratorMessages)
				.values({
					id,
					narratorId,
					role: "system",
					contentJson: [{ type: "compact", status: "compacted", summary: "" }],
					contentText: "[Context cleared]",
					createdAt: now,
				})
				.returning()
				.get();

			const result = tx
				.select({ maxSeq: sql<number | null>`MAX(${narratorMessageRefs.seq})` })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId))
				.all();
			const seq = (result[0]?.maxSeq ?? -1) + 1;
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					contextSummary: null,
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq };
		});

		return { ...msg, seq };
	},

	/**
	 * Insert an empty compact marker positioned *before* the given message, so
	 * subsequent context builds start fresh from that point (discarding earlier
	 * context) without running an AI summary. Mirrors `clearContext` but anchors
	 * the marker at a specific message instead of appending at the end.
	 */
	async clearContextBefore(narratorId: string, beforeMessageId: string) {
		const id = generateId();
		const now = new Date().toISOString();

		const { msg, seq } = db.transaction((tx) => {
			const targetRef = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, beforeMessageId),
					),
				})
				.sync();
			if (!targetRef) throw new NotFoundError("Message", beforeMessageId);

			const msg = tx
				.insert(narratorMessages)
				.values({
					id,
					narratorId,
					role: "system",
					contentJson: [{ type: "compact", status: "compacted", summary: "" }],
					contentText: "[Context cleared]",
					createdAt: now,
				})
				.returning()
				.get();

			tx.update(narratorMessageRefs)
				.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						gte(narratorMessageRefs.seq, targetRef.seq),
					),
				)
				.run();
			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq: targetRef.seq,
					isCompact: 1,
				})
				.run();
			tx.update(narrators)
				.set({
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
			return { msg, seq: targetRef.seq };
		});

		return { ...msg, seq };
	},

	async finalizeCompactingMessage(
		messageId: string,
		narratorId: string,
		summary: string,
		contextPercent?: number,
		options?: { status?: "compacted" | "failed"; error?: string; mode?: "blocking" | "background" },
	) {
		const now = new Date().toISOString();
		const status = options?.status ?? "compacted";
		const compactBlock: Record<string, unknown> = { type: "compact", status, summary };
		if (options?.mode) {
			compactBlock.mode = options.mode;
		}
		if (status === "failed" && options?.error) {
			compactBlock.error = options.error;
		}
		const prefix = status === "failed" ? "[Compact Failed]" : "[Compact]";

		return db.transaction((tx) => {
			const updated = tx
				.update(narratorMessages)
				.set({
					contentJson: [compactBlock],
					contentText: `${prefix} ${summary.slice(0, 200)}...`,
					contextPercent: contextPercent ?? null,
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning()
				.get();
			if (!updated) return null;

			tx.update(narratorMessageRefs)
				.set({ isCompact: status === "compacted" ? 1 : 0 })
				.where(
					and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				)
				.run();

			tx.update(narrators)
				.set({
					...(status === "compacted" ? { contextSummary: summary, apiConversationId: null } : {}),
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
					columns: { seq: true },
				})
				.sync();

			return { ...updated, seq: ref?.seq };
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
			provider?: string;
			credentialId?: string;
			model?: string;
			outputTokens?: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			cacheCreation5mTokens?: number;
			cacheCreation1hTokens?: number;
			reasoningTokens?: number;
			ttftMs?: number;
			durationMs?: number;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

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
				provider: sdkMessage.provider ?? null,
				credentialId: sdkMessage.credentialId ?? null,
				model: sdkMessage.model ?? null,
				outputTokens: sdkMessage.outputTokens ?? null,
				cachedInputTokens: sdkMessage.cachedInputTokens ?? null,
				cacheCreationInputTokens: sdkMessage.cacheCreationInputTokens ?? null,
				cacheCreation5mTokens: sdkMessage.cacheCreation5mTokens ?? null,
				cacheCreation1hTokens: sdkMessage.cacheCreation1hTokens ?? null,
				reasoningTokens: sdkMessage.reasoningTokens ?? null,
				ttftMs: sdkMessage.ttftMs ?? null,
				durationMs: sdkMessage.durationMs ?? null,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			})
			.returning();

		const seq = await appendMessageRef(narratorId, id);
		await bumpParentNarratorMessageVersion(sdkMessage.parent_tool_use_id);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
		for (const block of toolUseBlocks) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId: id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: withGeminiThoughtSignature(
					block.input,
					block.thoughtSignature,
					block.thoughtSignatureSource,
				),
				status: "initializing",
				streamStartedAt:
					"streamStartedAt" in block && typeof block.streamStartedAt === "number"
						? new Date(block.streamStartedAt).toISOString()
						: null,
				createdAt: now,
			});
		}

		return { ...msg, seq };
	},

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
			provider?: string;
			credentialId?: string;
			model?: string;
			outputTokens?: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			cacheCreation5mTokens?: number;
			cacheCreation1hTokens?: number;
			reasoningTokens?: number;
			ttftMs?: number;
			durationMs?: number;
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
				provider: sdkMessage.provider ?? null,
				credentialId: sdkMessage.credentialId ?? null,
				model: sdkMessage.model ?? null,
				outputTokens: sdkMessage.outputTokens ?? null,
				cachedInputTokens: sdkMessage.cachedInputTokens ?? null,
				cacheCreationInputTokens: sdkMessage.cacheCreationInputTokens ?? null,
				cacheCreation5mTokens: sdkMessage.cacheCreation5mTokens ?? null,
				cacheCreation1hTokens: sdkMessage.cacheCreation1hTokens ?? null,
				reasoningTokens: sdkMessage.reasoningTokens ?? null,
				ttftMs: sdkMessage.ttftMs ?? null,
				durationMs: sdkMessage.durationMs ?? null,
				contextPercent: sdkMessage.contextPercent ?? null,
				meterUsage: sdkMessage.meterUsage ?? null,
				meterUnit: sdkMessage.meterUnit ?? null,
				createdAt: now,
			})
			.returning();

		const seq = await appendMessageRef(narratorId, id);
		await bumpParentNarratorMessageVersion(sdkMessage.parent_tool_use_id);
		return { ...msg, seq };
	},

	async appendBlockToMessage(
		messageId: string,
		narratorId: string,
		block:
			| { type: "text"; text: string; outputIndex?: number }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
					outputIndex?: number;
			  }
			| { type: "redacted_thinking"; data: string; outputIndex?: number; signatureSource?: string }
			| {
					type: "tool_use";
					id: string;
					name: string;
					input: Record<string, unknown>;
					streamStartedAt?: number;
					outputIndex?: number;
					thoughtSignature?: string;
					thoughtSignatureSource?: string;
			  }
			| {
					type: "web_search";
					id: string;
					query?: string;
					queries?: string[];
					outputIndex?: number;
			  }
			| {
					type: "image_generation";
					id: string;
					revisedPrompt?: string;
					outputIndex?: number;
					savedPath?: string;
					result?: string;
					width?: number;
					height?: number;
			  },
	) {
		const existing = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		if (!existing) return;

		type StoredAssistantBlock =
			| { type: "text"; text: string; outputIndex?: number }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
					outputIndex?: number;
			  }
			| { type: "redacted_thinking"; data: string; outputIndex?: number; signatureSource?: string }
			| {
					type: "tool_use";
					id: string;
					name: string;
					input: Record<string, unknown>;
					streamStartedAt?: number;
					outputIndex?: number;
					thoughtSignature?: string;
					thoughtSignatureSource?: string;
			  }
			| {
					type: "web_search";
					id: string;
					query?: string;
					queries?: string[];
					outputIndex?: number;
			  }
			| { type: string; text?: unknown; outputIndex?: unknown; [key: string]: unknown };
		const current = (
			Array.isArray(existing.contentJson) ? existing.contentJson : []
		) as StoredAssistantBlock[];
		let content: StoredAssistantBlock[];
		if (typeof (block as { outputIndex?: unknown }).outputIndex === "number") {
			const getOutputIndex = (entry: StoredAssistantBlock): number | undefined => {
				const outputIndex = (entry as { outputIndex?: unknown }).outputIndex;
				return typeof outputIndex === "number" ? outputIndex : undefined;
			};
			const next = [...current, block as StoredAssistantBlock];
			const indexed = next.map((entry, index) => ({ entry, index }));
			indexed.sort((a, b) => {
				const aOrder = getOutputIndex(a.entry) ?? Number.POSITIVE_INFINITY;
				const bOrder = getOutputIndex(b.entry) ?? Number.POSITIVE_INFINITY;
				return aOrder === bOrder ? a.index - b.index : aOrder - bOrder;
			});
			content = indexed.map(({ entry }) => entry);
		} else if (block.type === "reasoning") {
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

		if (block.type === "tool_use") {
			const now = new Date().toISOString();
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: withGeminiThoughtSignature(
					block.input,
					block.thoughtSignature,
					block.thoughtSignatureSource,
				),
				status: "initializing",
				streamStartedAt:
					typeof block.streamStartedAt === "number"
						? new Date(block.streamStartedAt).toISOString()
						: null,
				createdAt: now,
			});
		}
	},

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

	async updateMessageHistoryTokenEstimate(
		messageId: string,
		narratorId: string,
		estimate: {
			promptTokens: number;
			turnUsage: Record<string, unknown>;
			contextPercent?: number;
		},
	) {
		return db.transaction((tx) => {
			const updated = tx
				.update(narratorMessages)
				.set({
					tokensIn: estimate.promptTokens,
					turnUsageJson: estimate.turnUsage,
					...(estimate.contextPercent != null ? { contextPercent: estimate.contextPercent } : {}),
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning()
				.get();
			if (!updated) return null;

			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
					columns: { seq: true },
				})
				.sync();

			return { ...updated, seq: ref?.seq };
		});
	},

	async updateTitle(narratorId: string, title: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ title, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateCwd(narratorId: string, cwd: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ cwd, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updateModel(narratorId: string, model: string) {
		const now = new Date().toISOString();
		await db.update(narrators).set({ model, updatedAt: now }).where(eq(narrators.id, narratorId));
	},

	async updatePermissionMode(narratorId: string, permissionMode: PermissionMode) {
		const now = new Date().toISOString();

		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(
				and(
					eq(narrators.parentNarratorId, narratorId),
					like(narrators.variant, "subagent:%"),
					inArray(narrators.status, ["working", "waiting", "idle"]),
				),
			);
	},

	async updateReasoningEffort(
		narratorId: string,
		reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null,
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

	async updateReflectionOverrides(
		narratorId: string,
		updates: {
			planReflectionAutoApproveOverride?: BooleanOverride;
			dangerReflectionOverride?: DangerReflectionOverride;
			autoContinuationOverride?: AutoContinuationOverride;
			tasksReminderIntervalOverride?: number | null;
		},
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ ...updates, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateBehaviorFenceSettings(
		narratorId: string,
		updates: {
			behaviorFenceIntervalOverride?: number | null;
			behaviorFenceAttachOverride?: BooleanOverride;
		},
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ ...updates, updatedAt: now })
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
		status: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
			errorCode?: string;
			diagnostics?: ApiRequestDiagnostics;
			setTurnStart?: boolean;
			turnStartedAt?: string;
			resumeTurn?: boolean;
			skipErrorMessage?: boolean;
		},
	) {
		const errorMessage = options?.errorMessage;
		const errorCode = options?.errorCode;
		const diagnostics = options?.diagnostics;
		const setTurnStart = options?.setTurnStart;
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags (e.g. leftover "unread"/"error"/"interrupted"),
		// but preserve a background compact that is intentionally running alongside it.
		const requestedSubstatus =
			options?.substatus ?? (status === "working" || status === "waiting" ? [] : undefined);
		const isError = requestedSubstatus?.includes("error");
		const keepsErrorMessage = isError || requestedSubstatus?.includes("payment_required");
		const now = new Date().toISOString();
		const nowMs = new Date(now).getTime();
		const normalizedErrorMessage = keepsErrorMessage ? (errorMessage ?? null) : null;
		const turnStartedAt = setTurnStart ? now : options?.turnStartedAt;
		let actualSubstatus = requestedSubstatus;
		// The generation broadcast to clients: the fresh turn start when this call
		// begins a turn, otherwise the narrator's existing turnStartedAt read from
		// the DB. Broadcasting it on terminal (done/unread) transitions lets the
		// notification layer key dedup on the specific execution generation, so a
		// resubscribe snapshot for the same turn is suppressed while a new turn's
		// completion (e.g. during a disconnect) still notifies.
		let broadcastTurnStartedAt: string | undefined = turnStartedAt;
		const writeStatus = async () => {
			if (requestedSubstatus !== undefined) {
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { substatus: true, turnStartedAt: true, updatedAt: true },
				});
				if (broadcastTurnStartedAt === undefined) {
					broadcastTurnStartedAt = row?.turnStartedAt ?? undefined;
				}
				const currentSubstatus = parseSubstatus(row?.substatus);
				actualSubstatus = preserveBackgroundCompactingSubstatus(
					currentSubstatus,
					requestedSubstatus,
				);
				// Keep the taken_over tag alive across loop-completion overwrites
				// (finalizeSubagent / status transitions) while the in-memory
				// takeover state is active.
				actualSubstatus = preserveTakenOverSubstatus(narratorId, actualSubstatus);
				actualSubstatus = transitionTurnTimingSubstatus(currentSubstatus, actualSubstatus, {
					status,
					nowMs,
					setTurnStart,
					resumeTurn: options?.resumeTurn,
					fallbackPauseStartedAtMs: row?.updatedAt ? new Date(row.updatedAt).getTime() : null,
				});
			}
			// Retry on transient SQLite locks so a status/substatus transition
			// (e.g. clearing "reflecting" after a danger reflection ends) is never
			// silently dropped when the DB is momentarily busy.
			await withDbRetry(
				() =>
					db
						.update(narrators)
						.set({
							status,
							errorMessage: normalizedErrorMessage,
							updatedAt: now,
							...(turnStartedAt !== undefined && { turnStartedAt }),
							...(actualSubstatus !== undefined && { substatus: JSON.stringify(actualSubstatus) }),
						})
						.where(eq(narrators.id, narratorId)),
				{ label: "updateStatus.write", maxRetries: 5 },
			);
		};
		if (requestedSubstatus !== undefined) {
			await narratorSubstatusLock.acquire(narratorId, writeStatus);
		} else {
			await writeStatus();
		}

		// Always emit status_changed so downstream listeners (gateway, notifications)
		// are notified. For errors, also emit the dedicated narrator:error event.
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId,
			status,
			substatus: actualSubstatus,
		});
		// Emit the semantic attention intent for the two persistent, unambiguous
		// "alert the user" states. `waiting` is intentionally excluded — its
		// attention intent is decided by the producer (handlePermission), not
		// re-derived here, because `waiting` is also reused for reflection states.
		if (status === "idle" && actualSubstatus?.includes("unread")) {
			eventBus.emit({ type: "narrator:attention", narratorId, reason: "done" });
		} else if (actualSubstatus?.includes("error")) {
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "error",
				detail: normalizedErrorMessage ?? undefined,
			});
		}
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				diagnostics,
			});
		}

		if (isError) {
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				errorCode,
				diagnostics,
			});

			if (!options?.skipErrorMessage) {
				try {
					const errText = normalizedErrorMessage ?? "Unknown error";
					const msgId = generateId();
					const contentJson = [{ type: "error", message: errText }];
					const contentText = `[Error] ${errText}`;
					// Insert the message and its ref atomically. We MUST use a
					// synchronous native sqlite transaction here: bun:sqlite +
					// Drizzle's `db.transaction(async (tx) => …)` only wraps the
					// synchronous prefix before the first `await` in BEGIN/COMMIT,
					// so awaited statements (the ref insert) run OUTSIDE the
					// transaction. That left "message without ref" orphans whenever
					// the ref insert hit a lock/error — the card showed up in the
					// frontend (via the broadcast below) but `dismissErrorMessage`
					// could not find the ref → "Message not found". A sync
					// transaction commits both rows atomically.
					await withDbRetry(
						async () => {
							const insertAtomic = sqlite.transaction(() => {
								sqlite
									.prepare(
										`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
										 VALUES (?, ?, 'system', ?, ?, ?)`,
									)
									.run(msgId, narratorId, JSON.stringify(contentJson), contentText, now);
								const maxSeqRow = sqlite
									.prepare(
										"SELECT MAX(seq) AS maxSeq FROM narrator_message_refs WHERE narrator_id = ?",
									)
									.get(narratorId) as { maxSeq: number | null } | undefined;
								const seq = (maxSeqRow?.maxSeq ?? -1) + 1;
								const prunedRow = sqlite
									.prepare("SELECT pruned_percent AS prunedPercent FROM narrators WHERE id = ?")
									.get(narratorId) as { prunedPercent: number | null } | undefined;
								sqlite
									.prepare(
										`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact, pruned_percent)
										 VALUES (?, ?, ?, ?, 0, ?)`,
									)
									.run(generateId(), narratorId, msgId, seq, prunedRow?.prunedPercent ?? null);
								sqlite
									.prepare(
										"UPDATE narrators SET message_version = message_version + 1 WHERE id = ?",
									)
									.run(narratorId);
							});
							insertAtomic();
						},
						{ label: "persistErrorSystemMessage", maxRetries: 5 },
					);
					// Broadcast only after the transaction has committed, so a
					// visible error card always has a backing ref the user can
					// dismiss.
					broadcastToNarrator(narratorId, {
						type: "message",
						narratorId,
						message: {
							id: msgId,
							narratorId,
							role: "system",
							contentJson,
							contentText,
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
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status,
			substatus: actualSubstatus,
			turnStartedAt: broadcastTurnStartedAt,
		});
	},

	async compareAndSetStatus(
		narratorId: string,
		expectedStatus: string | string[],
		newStatus: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
			diagnostics?: ApiRequestDiagnostics;
		},
	): Promise<boolean> {
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags, while preserving background compact state.
		const requestedSubstatus =
			options?.substatus ?? (newStatus === "working" || newStatus === "waiting" ? [] : undefined);
		const errorMessage = options?.errorMessage;
		const diagnostics = options?.diagnostics;
		const isError = requestedSubstatus?.includes("error");
		const now = new Date().toISOString();
		const nowMs = new Date(now).getTime();
		const normalizedErrorMessage = isError ? (errorMessage ?? null) : null;
		const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
		let actualSubstatus = requestedSubstatus;
		// The execution generation to broadcast on the terminal (done/unread)
		// transition so clients can dedup notifications per turn (see updateStatus).
		let broadcastTurnStartedAt: string | undefined;
		const placeholders = expected.map(() => "?").join(",");
		const runCompareAndSet = async () => {
			if (requestedSubstatus !== undefined) {
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { substatus: true, turnStartedAt: true },
				});
				broadcastTurnStartedAt = row?.turnStartedAt ?? undefined;
				const currentSubstatus = parseSubstatus(row?.substatus);
				actualSubstatus = preserveBackgroundCompactingSubstatus(
					currentSubstatus,
					requestedSubstatus,
				);
				actualSubstatus = preserveTakenOverSubstatus(narratorId, actualSubstatus);
				actualSubstatus = transitionTurnTimingSubstatus(currentSubstatus, actualSubstatus, {
					status: newStatus,
					nowMs,
				});
			}
			const substatusJson =
				actualSubstatus !== undefined ? JSON.stringify(actualSubstatus) : undefined;
			// Retry on transient SQLite locks so the terminal working/waiting → idle
			// transition (which clears transient substatus tags) is never dropped.
			return withDbRetry(
				async () =>
					sqlite
						.prepare(
							substatusJson !== undefined
								? `UPDATE narrators SET status = ?, error_message = ?, substatus = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`
								: `UPDATE narrators SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
						)
						.run(
							...(substatusJson !== undefined
								? [newStatus, normalizedErrorMessage, substatusJson, now, narratorId, ...expected]
								: [newStatus, normalizedErrorMessage, now, narratorId, ...expected]),
						),
				{ label: "compareAndSetStatus.write", maxRetries: 5 },
			);
		};
		const result =
			requestedSubstatus !== undefined
				? await narratorSubstatusLock.acquire(narratorId, runCompareAndSet)
				: await runCompareAndSet();

		if (result.changes === 0) return false;

		// Always emit status_changed; for errors also emit narrator:error.
		eventBus.emit({
			type: "narrator:status_changed",
			narratorId,
			status: newStatus,
			substatus: actualSubstatus,
		});
		// Emit the semantic attention intent for done/error (see updateStatus for
		// why `waiting` is excluded). compareAndSetStatus is the path that marks a
		// finished turn idle+unread, so this is the primary "done" emit point.
		if (newStatus === "idle" && actualSubstatus?.includes("unread")) {
			eventBus.emit({ type: "narrator:attention", narratorId, reason: "done" });
		} else if (actualSubstatus?.includes("error")) {
			eventBus.emit({
				type: "narrator:attention",
				narratorId,
				reason: "error",
				detail: normalizedErrorMessage ?? undefined,
			});
		}
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				diagnostics,
			});
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status: newStatus,
			substatus: actualSubstatus,
			turnStartedAt: broadcastTurnStartedAt,
		});
		return true;
	},

	/**
	 * Update only the substatus tags without changing the main status.
	 * Broadcasts a substatus_change event to all subscribers.
	 */
	async updateSubstatus(narratorId: string, substatus: string[]) {
		await narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const actualSubstatus = preserveTurnTimingSubstatus(
				parseSubstatus(row?.substatus),
				substatus,
			);
			await writeSubstatus(narratorId, actualSubstatus);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: actualSubstatus,
			});
		});
	},

	/**
	 * Add a single substatus tag. No-op if already present.
	 * Returns the new substatus array.
	 *
	 * Serialized with all other substatus writers to avoid stale read-modify-write
	 * updates clobbering persistent tags like "error" or "unread".
	 */
	async addSubstatus(narratorId: string, tag: string): Promise<string[]> {
		return narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const current = parseSubstatus(row?.substatus);
			if (current.includes(tag)) return current;
			const updated = [...current, tag];
			await writeSubstatus(narratorId, updated);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: updated,
			});
			return updated;
		});
	},

	/**
	 * Remove a single substatus tag. No-op if not present.
	 * Returns the new substatus array.
	 *
	 * Serialized with all other substatus writers to avoid stale read-modify-write
	 * updates clobbering persistent tags like "error" or "unread".
	 */
	async removeSubstatus(narratorId: string, tag: string): Promise<string[]> {
		return narratorSubstatusLock.acquire(narratorId, async () => {
			const row = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { substatus: true },
			});
			const current = parseSubstatus(row?.substatus);
			if (!current.includes(tag)) return current;
			const updated = current.filter((t) => t !== tag);
			await writeSubstatus(narratorId, updated);
			broadcastToNarrator(narratorId, {
				type: "substatus_change",
				narratorId,
				substatus: updated,
			});
			return updated;
		});
	},

	async updateToolCallExecutionTarget(
		narratorId: string,
		toolUseId: string,
		target: ToolExecutionTarget,
	) {
		const existing = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
			// Order by newest first: some providers (GLM, DeepSeek, etc.) reuse short
			// sequential toolUseIds across requests (call_0, call_1, call_2...). Without
			// this ordering, findFirst may hit a stale completed row from a previous turn
			// instead of the current "initializing" row, tripping the frozen-target guard.
			orderBy: [desc(narratorToolCalls.createdAt)],
			columns: {
				id: true,
				status: true,
				executionDeviceId: true,
				executionCwd: true,
				resolvedFilePath: true,
				deviceSelectionSource: true,
			},
		});
		if (!existing) {
			throw new NotFoundError("Tool call", toolUseId);
		}

		const nextResolvedPath = target.resolvedFilePath ?? null;
		const targetChanged =
			existing.executionDeviceId !== target.deviceId ||
			existing.executionCwd !== target.cwd ||
			existing.resolvedFilePath !== nextResolvedPath ||
			existing.deviceSelectionSource !== target.selectionSource;
		const mayRefineBeforeApproval = existing.status === "initializing";

		if (existing.executionDeviceId !== null && existing.executionDeviceId !== target.deviceId) {
			throw new ValidationError(
				`Execution target for tool call ${toolUseId} is already frozen to ` +
					`"${existing.executionDeviceId}" and cannot change to "${target.deviceId}".`,
			);
		}
		if (targetChanged && !mayRefineBeforeApproval) {
			throw new ValidationError(
				`Execution target for tool call ${toolUseId} is already frozen and cannot change ` +
					`after permission handling has begun.`,
			);
		}

		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: target.deviceId,
				executionCwd: target.cwd,
				resolvedFilePath: nextResolvedPath,
				deviceSelectionSource: target.selectionSource,
			})
			.where(eq(narratorToolCalls.id, existing.id));
	},

	async updateToolCallResult(
		toolUseId: string,
		result: {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			output?: any;
			status: "success" | "fail";
			errorMessage?: string;
			durationMs?: number;
			permissionStartedAt?: number;
			executionStartedAt?: number;
			completedAt?: number;
			resultMessageId?: string;
			bumpMessageVersion?: boolean;
		},
		messageId?: string,
	) {
		const conditions = [eq(narratorToolCalls.toolUseId, toolUseId)];
		if (messageId) conditions.push(eq(narratorToolCalls.messageId, messageId));
		const affectedToolCalls = await db
			.select({ narratorId: narratorToolCalls.narratorId, messageId: narratorToolCalls.messageId })
			.from(narratorToolCalls)
			.where(and(...conditions));
		await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				status: result.status,
				errorMessage: result.errorMessage ?? null,
				durationMs: result.durationMs ?? null,
				permissionStartedAt:
					typeof result.permissionStartedAt === "number"
						? new Date(result.permissionStartedAt).toISOString()
						: undefined,
				executionStartedAt:
					typeof result.executionStartedAt === "number"
						? new Date(result.executionStartedAt).toISOString()
						: undefined,
				completedAt:
					typeof result.completedAt === "number"
						? new Date(result.completedAt).toISOString()
						: new Date().toISOString(),
				...(result.resultMessageId != null && { resultMessageId: result.resultMessageId }),
			})
			.where(and(...conditions));

		const affectedNarratorIds = affectedToolCalls.map((tc) => tc.narratorId);
		const affectedMessageIds = [
			...new Set(affectedToolCalls.map((tc) => tc.messageId).filter((id): id is string => !!id)),
		];
		if (affectedMessageIds.length > 0) {
			const affectedMessages = await db.query.narratorMessages.findMany({
				where: inArray(narratorMessages.id, affectedMessageIds),
				columns: { parentToolUseId: true },
			});
			const parentToolUseIds = [
				...new Set(
					affectedMessages.map((msg) => msg.parentToolUseId).filter((id): id is string => !!id),
				),
			];
			if (parentToolUseIds.length > 0) {
				const parentToolCalls = await db.query.narratorToolCalls.findMany({
					where: inArray(narratorToolCalls.toolUseId, parentToolUseIds),
					columns: { narratorId: true },
				});
				affectedNarratorIds.push(...parentToolCalls.map((tc) => tc.narratorId));
			}
		}
		if (result.bumpMessageVersion !== false) {
			await bumpNarratorMessageVersions(affectedNarratorIds);
		}
	},

	async isMessageSharedByMultipleNarrators(messageId: string): Promise<boolean> {
		const result = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId));
		return (result[0]?.count ?? 0) > 1;
	},

	async getToolCallByToolUseId(toolUseId: string) {
		return db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
		});
	},

	async copyOnWriteMessage(
		narratorId: string,
		messageId: string,
		overrides?: Partial<typeof narratorMessages.$inferInsert>,
	): Promise<string> {
		const ref = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		});
		if (!ref) throw new NotFoundError("Message", messageId);

		const [refCount] = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, messageId));
		const isShared = (refCount?.count ?? 0) > 1;
		if (!isShared) {
			if (overrides && Object.keys(overrides).length > 0) {
				db.transaction((tx) => {
					tx.update(narratorMessages)
						.set(overrides)
						.where(eq(narratorMessages.id, messageId))
						.run();
					tx.update(narrators)
						.set({
							messageVersion: sql`${narrators.messageVersion} + 1`,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(narrators.id, narratorId))
						.run();
				});
			}
			return messageId;
		}

		const newMessageId = generateId();
		const now = new Date().toISOString();

		db.transaction((tx) => {
			const original = tx.query.narratorMessages
				.findFirst({
					where: eq(narratorMessages.id, messageId),
				})
				.sync();
			if (!original) throw new NotFoundError("Message", messageId);

			tx.insert(narratorMessages)
				.values({
					...original,
					...overrides,
					id: newMessageId,
					narratorId,
					createdAt: original.createdAt,
				})
				.run();

			tx.update(narratorMessageRefs)
				.set({ messageId: newMessageId })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				)
				.run();

			const originalToolCalls = tx.query.narratorToolCalls
				.findMany({
					where: eq(narratorToolCalls.messageId, messageId),
				})
				.sync();
			if (originalToolCalls.length > 0) {
				tx.insert(narratorToolCalls)
					.values(
						originalToolCalls.map((tc) => ({
							...tc,
							id: generateId(),
							narratorId,
							messageId: newMessageId,
							createdAt: now,
						})),
					)
					.run();
			}

			const originalToolUseIds = originalToolCalls.map((tc) => tc.toolUseId);
			const originalSideCars = tx.query.narratorSidecars
				.findMany({
					where:
						originalToolUseIds.length > 0
							? or(
									eq(narratorSidecars.messageId, messageId),
									and(
										eq(narratorSidecars.narratorId, original.narratorId),
										inArray(narratorSidecars.toolUseId, originalToolUseIds),
									),
								)
							: eq(narratorSidecars.messageId, messageId),
				})
				.sync();
			if (originalSideCars.length > 0) {
				tx.insert(narratorSidecars)
					.values(
						originalSideCars.map((sideCar) => ({
							...sideCar,
							id: generateId(),
							narratorId,
							messageId: newMessageId,
						})),
					)
					.run();
			}

			const narrator = tx.query.narrators
				.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { forkMessageId: true, pruneBoundaryMessageId: true },
				})
				.sync();
			const narratorUpdates: Partial<typeof narrators.$inferInsert> = {};
			if (narrator?.forkMessageId === messageId) narratorUpdates.forkMessageId = newMessageId;
			if (narrator?.pruneBoundaryMessageId === messageId) {
				narratorUpdates.pruneBoundaryMessageId = newMessageId;
			}
			tx.update(narrators)
				.set({
					...narratorUpdates,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});

		return newMessageId;
	},

	async copyOnWriteToolCallMessage(
		narratorId: string,
		messageId: string,
		_toolUseId: string,
	): Promise<string> {
		return this.copyOnWriteMessage(narratorId, messageId);
	},

	async overwriteToolCallInput(toolUseId: string, input: Record<string, unknown>) {
		logger.info("Overwriting broken tool call input", { toolUseId, inputKeys: Object.keys(input) });
		await db
			.update(narratorToolCalls)
			.set({ inputJson: input })
			.where(eq(narratorToolCalls.toolUseId, toolUseId));

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

	async getToolCallPlanText(toolUseId: string): Promise<string | null> {
		const tc = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.toolUseId, toolUseId),
			columns: { inputJson: true },
		});
		const plan = (tc?.inputJson as Record<string, unknown> | null)?.plan;
		return typeof plan === "string" && plan.trim() ? plan : null;
	},

	// ── Segment compact ──────────────────────────────────────────────────────

	async persistSegmentCompactMarker(narratorId: string, messageIds: string[]) {
		if (messageIds.length === 0) throw new ValidationError("No messages to compact");

		const id = generateId();
		const now = new Date().toISOString();

		const refs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					inArray(narratorMessageRefs.messageId, messageIds),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refs.length === 0) throw new ValidationError("No matching messages found");

		const insertSeq = refs[0].seq;

		db.transaction((tx) => {
			tx.update(narratorMessageRefs)
				.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						gte(narratorMessageRefs.seq, insertSeq),
					),
				)
				.run();

			tx.insert(narratorMessages)
				.values({
					id,
					narratorId,
					role: "user",
					contentJson: [
						{
							type: "segment_compact",
							status: "compacting",
							messageCount: refs.length,
						},
					],
					contentText: "[Segment compacting]",
					createdAt: now,
				})
				.run();

			tx.insert(narratorMessageRefs)
				.values({
					id: generateId(),
					narratorId,
					messageId: id,
					seq: insertSeq,
					isCompact: 0,
				})
				.run();

			const targetMessageIds = refs.map((r) => r.messageId);
			tx.update(narratorMessageRefs)
				.set({ segmentCompactId: id })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessageRefs.messageId, targetMessageIds),
					),
				)
				.run();

			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});

		const [msg] = await db.select().from(narratorMessages).where(eq(narratorMessages.id, id));

		const hiddenMessageIds = refs.map((r) => r.messageId);
		return { message: { ...msg, seq: insertSeq }, hiddenMessageIds };
	},

	async getMessagesForSegmentCompact(narratorId: string, messageIds: string[]) {
		const refs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					inArray(narratorMessageRefs.messageId, messageIds),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refs.length === 0) return [];

		const ids = refs.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, ids),
			with: { toolCalls: true, sideCars: true },
		});

		const seqMap = new Map(refs.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	async finalizeSegmentCompact(
		messageId: string,
		narratorId: string,
		summary: string,
		contextPercent?: number,
		options?: { status?: "compacted" | "failed"; error?: string },
	) {
		const now = new Date().toISOString();
		const status = options?.status ?? "compacted";

		const [countRow] = await db
			.select({ cnt: sql<number>`count(*)` })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.segmentCompactId, messageId),
				),
			);
		const messageCount = countRow?.cnt ?? 0;

		const block: Record<string, unknown> = {
			type: "segment_compact",
			status,
			summary,
			messageCount,
		};
		if (status === "failed" && options?.error) {
			block.error = options.error;
		}

		const prefix = status === "failed" ? "[Segment Compact Failed]" : "[Segment Compact]";

		return db.transaction((tx) => {
			const updated = tx
				.update(narratorMessages)
				.set({
					contentJson: [block],
					contentText: `${prefix}\n${summary}`,
					contextPercent: contextPercent ?? null,
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning()
				.get();

			if (!updated) return null;

			if (status === "failed") {
				tx.update(narratorMessageRefs)
					.set({ segmentCompactId: null })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.segmentCompactId, messageId),
						),
					)
					.run();
			}

			tx.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					apiConversationId: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();

			const ref = tx.query.narratorMessageRefs
				.findFirst({
					where: and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
					columns: { seq: true },
				})
				.sync();

			return { ...updated, seq: ref?.seq };
		});
	},

	async getSegmentCompactHiddenMessages(narratorId: string, segmentCompactId: string) {
		const refs = await db
			.select({
				messageId: narratorMessageRefs.messageId,
				seq: narratorMessageRefs.seq,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					eq(narratorMessageRefs.segmentCompactId, segmentCompactId),
				),
			)
			.orderBy(narratorMessageRefs.seq);

		if (refs.length === 0) return [];

		const ids = refs.map((r) => r.messageId);
		const messages = await db.query.narratorMessages.findMany({
			where: inArray(narratorMessages.id, ids),
			with: { toolCalls: true, sideCars: true },
		});

		const seqMap = new Map(refs.map((r) => [r.messageId, r.seq]));
		messages.sort((a, b) => (seqMap.get(a.id) ?? 0) - (seqMap.get(b.id) ?? 0));
		return messages;
	},

	async deleteSegmentCompact(narratorId: string, messageId: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const scBlock = blocks.find((b: any) => b.type === "segment_compact");
		if (!scBlock) throw new ValidationError("Message is not a segment compact message");

		const now = new Date().toISOString();

		db.transaction((tx) => {
			tx.update(narratorMessageRefs)
				.set({ segmentCompactId: null })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.segmentCompactId, messageId),
					),
				)
				.run();

			tx.delete(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.messageId, messageId),
						eq(narratorMessageRefs.narratorId, narratorId),
					),
				)
				.run();
			tx.delete(narratorMessages)
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.run();

			tx.update(narrators)
				.set({
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	async getSegmentCompactSummary(narratorId: string, messageId: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const scBlock = blocks.find((b: any) => b.type === "segment_compact");
		if (!scBlock) throw new ValidationError("Message is not a segment compact message");

		return scBlock.summary ?? "";
	},

	async updateSegmentCompactSummary(narratorId: string, messageId: string, summary: string) {
		const msg = await db.query.narratorMessages.findFirst({
			where: and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)),
		});
		if (!msg) throw new NotFoundError("Message", messageId);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as any[]) : [];
		const scBlock = blocks.find(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "segment_compact" && b.status === "compacted",
		);
		if (!scBlock) throw new ValidationError("Message is not a compacted segment compact message");

		const newBlock = {
			type: "segment_compact" as const,
			status: "compacted" as const,
			summary,
			messageCount: scBlock.messageCount ?? 0,
		};

		const now = new Date().toISOString();
		db.transaction((tx) => {
			tx.update(narratorMessages)
				.set({
					contentJson: [newBlock],
					contentText: `[Segment Compact]\n${summary}`,
				})
				.where(eq(narratorMessages.id, messageId))
				.run();

			tx.update(narrators)
				.set({ apiConversationId: null, updatedAt: now })
				.where(eq(narrators.id, narratorId))
				.run();
		});
	},

	// ── Dynamic pruning boundary ──────────────────────────────────────────────

	async computeAndUpdatePruneBoundary(
		narratorId: string,
		contextPct: number,
		thresholds: { pruneStart: number; compactStart: number },
	): Promise<{ boundaryMessageId: string; prunedPercent: number } | null> {
		const { narratorMessageQueries: nm } = await import("./narrator-messages");
		const PRUNE_START = thresholds.pruneStart;
		const PRUNE_END = thresholds.compactStart;

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true, pruneEnabled: true },
		});

		// compactStart <= pruneStart means there is no progressive pruning window.
		// Clear any stale boundary from a previous configuration and let callers
		// compact directly at compactStart.
		if (PRUNE_END <= PRUNE_START) {
			if (narrator?.pruneBoundaryMessageId) {
				await this.clearPruneBoundary(narratorId);
			}
			return null;
		}

		if (narrator && !narrator.pruneEnabled) return null;

		if (contextPct < PRUNE_START) {
			if (narrator?.pruneBoundaryMessageId) {
				await this.clearPruneBoundary(narratorId);
			}
			return null;
		}

		const t = Math.min((contextPct - PRUNE_START) / (PRUNE_END - PRUNE_START), 1);
		const pruneRatio = t * t;

		const includeChildMessages = await nm.isSubagentNarrator(narratorId);
		const refs = await nm._getPostCompactTopLevelRefs(narratorId, {
			includeChildMessages,
		});

		const compactKeepCount = 4;
		if (refs.length < compactKeepCount + 2) return null;

		const prunableRefs = refs.slice(0, refs.length - compactKeepCount);

		const currentBoundaryIdx = narrator?.pruneBoundaryMessageId
			? prunableRefs.findIndex((r) => r.messageId === narrator.pruneBoundaryMessageId)
			: -1;

		const alreadyPruned = currentBoundaryIdx + 1;
		const remaining = prunableRefs.length - alreadyPruned;
		if (remaining <= 0) {
			const bid = narrator?.pruneBoundaryMessageId ?? null;
			if (!bid) return null;
			const prunedPercent = Math.round((alreadyPruned / refs.length) * 100);
			return { boundaryMessageId: bid, prunedPercent };
		}

		const maxPruneThisPass = Math.max(1, Math.floor(remaining * 0.5));
		const curveStep = Math.min(maxPruneThisPass, Math.max(1, Math.floor(pruneRatio * remaining)));
		// Enforce a minimum prune step so each pass drops at least `minPruneRatio`
		// of the remaining prunable messages. Pruning in larger steps means the
		// prune boundary moves less often, which keeps the prompt-cache prefix
		// stable for longer and reduces billing from repeated cache invalidation.
		// The minimum is allowed to exceed the 50% soft cap above, since the whole
		// point is to prune in fewer, bigger steps.
		const minStep = Math.max(1, Math.ceil(getMinPruneRatio() * remaining));
		const additionalPrune = Math.min(remaining, Math.max(curveStep, minStep));
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

	async clearPruneBoundary(narratorId: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ pruneBoundaryMessageId: null, prunedPercent: null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},
};
