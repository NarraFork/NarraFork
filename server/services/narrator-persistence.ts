import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { broadcastToNarrator } from "../websocket/narrator-ws";

// ── Internal helpers ───────────────────────────────────────────────────────

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

/** Atomically get next seq and insert into narrator_message_refs */
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

		await tx
			.update(narrators)
			.set({ messageVersion: sql`${narrators.messageVersion} + 1` })
			.where(eq(narrators.id, narratorId));

		return seq;
	});
}

// ── Exported appendMessageRef for use by narrator-service.ts ───────────────
export { appendMessageRef, insertMessageRef };

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

		await appendMessageRef(narratorId, id);

		if (createdBy) {
			const user = await db.query.users.findFirst({
				where: eq(users.id, createdBy),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			});
			return { ...msg, creator: user ?? null };
		}
		return { ...msg, creator: null };
	},

	async persistSystemMessage(
		narratorId: string,
		text: string,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentBlocks?: any[],
		createdBy?: string,
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const blocks: unknown[] = [{ type: "text", text }, ...(contentBlocks ?? [])];
		const [msg] = await db
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
			.returning();

		await appendMessageRef(narratorId, id);
		return msg;
	},

	async persistDisplayMessage(narratorId: string, text: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "disp",
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
				role: "disp",
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

		await appendMessageRef(narratorId, id);

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

		await appendMessageRef(narratorId, id);
		return msg;
	},

	async appendBlockToMessage(
		messageId: string,
		narratorId: string,
		block:
			| { type: "text"; text: string }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
					outputIndex?: number;
			  }
			| {
					type: "tool_use";
					id: string;
					name: string;
					input: Record<string, unknown>;
					outputIndex?: number;
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
			  },
	) {
		const existing = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, messageId),
			columns: { contentJson: true },
		});
		if (!existing) return;

		type StoredAssistantBlock =
			| { type: "text"; text: string }
			| {
					type: "reasoning";
					text: string;
					providerMetadata?: import("@server/lib/agent/types").ReasoningProviderMetadata;
					outputIndex?: number;
			  }
			| {
					type: "tool_use";
					id: string;
					name: string;
					input: Record<string, unknown>;
					outputIndex?: number;
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
				inputJson: block.input,
				status: "initializing",
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
		reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null,
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
		status: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
			errorCode?: string;
			setTurnStart?: boolean;
		},
	) {
		const errorMessage = options?.errorMessage;
		const errorCode = options?.errorCode;
		const setTurnStart = options?.setTurnStart;
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags (e.g. leftover "unread"/"error"/"interrupted").
		const substatus =
			options?.substatus ?? (status === "working" || status === "waiting" ? [] : undefined);
		const isError = substatus?.includes("error");
		const now = new Date().toISOString();
		const normalizedErrorMessage = isError ? (errorMessage ?? null) : null;
		const turnStartedAt = setTurnStart ? now : undefined;
		await db
			.update(narrators)
			.set({
				status,
				errorMessage: normalizedErrorMessage,
				updatedAt: now,
				...(turnStartedAt !== undefined && { turnStartedAt }),
				...(substatus !== undefined && { substatus: JSON.stringify(substatus) }),
			})
			.where(eq(narrators.id, narratorId));

		// Always emit status_changed so downstream listeners (gateway, notifications)
		// are notified. For errors, also emit the dedicated narrator:error event.
		eventBus.emit({ type: "narrator:status_changed", narratorId, status, substatus });
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
			});
		}

		if (isError) {
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
				errorCode,
			});

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
			substatus,
			turnStartedAt: turnStartedAt ?? undefined,
		});
	},

	async compareAndSetStatus(
		narratorId: string,
		expectedStatus: string | string[],
		newStatus: "idle" | "working" | "waiting" | "archived",
		options?: {
			substatus?: string[];
			errorMessage?: string;
		},
	): Promise<boolean> {
		// When transitioning to an active status without explicit substatus,
		// auto-clear stale tags.
		const substatus =
			options?.substatus ?? (newStatus === "working" || newStatus === "waiting" ? [] : undefined);
		const errorMessage = options?.errorMessage;
		const isError = substatus?.includes("error");
		const now = new Date().toISOString();
		const normalizedErrorMessage = isError ? (errorMessage ?? null) : null;
		const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
		const substatusJson = substatus !== undefined ? JSON.stringify(substatus) : undefined;
		const placeholders = expected.map(() => "?").join(",");
		const result = sqlite
			.prepare(
				substatusJson !== undefined
					? `UPDATE narrators SET status = ?, error_message = ?, substatus = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`
					: `UPDATE narrators SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
			)
			.run(
				...(substatusJson !== undefined
					? [newStatus, normalizedErrorMessage, substatusJson, now, narratorId, ...expected]
					: [newStatus, normalizedErrorMessage, now, narratorId, ...expected]),
			);

		if (result.changes === 0) return false;

		// Always emit status_changed; for errors also emit narrator:error.
		eventBus.emit({ type: "narrator:status_changed", narratorId, status: newStatus, substatus });
		if (isError) {
			eventBus.emit({
				type: "narrator:error",
				narratorId,
				error: normalizedErrorMessage ?? "Unknown error",
			});
		}
		broadcastToNarrator(narratorId, {
			type: "status_change",
			narratorId,
			status: newStatus,
			substatus,
		});
		return true;
	},

	/**
	 * Update only the substatus tags without changing the main status.
	 * Broadcasts a substatus_change event to all subscribers.
	 */
	async updateSubstatus(narratorId: string, substatus: string[]) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ substatus: JSON.stringify(substatus), updatedAt: now })
			.where(eq(narrators.id, narratorId));

		broadcastToNarrator(narratorId, {
			type: "substatus_change",
			narratorId,
			substatus,
		});
	},

	/**
	 * Add a single substatus tag. No-op if already present.
	 * Returns the new substatus array.
	 *
	 * @internal Only call through narrator-session.ts's in-memory Set which
	 * serializes access via the single-threaded event loop. Direct calls from
	 * routes or other services will cause read-modify-write race conditions.
	 */
	async addSubstatus(narratorId: string, tag: string): Promise<string[]> {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { substatus: true },
		});
		const current = parseSubstatus(row?.substatus);
		if (current.includes(tag)) return current;
		const updated = [...current, tag];
		await this.updateSubstatus(narratorId, updated);
		return updated;
	},

	/**
	 * Remove a single substatus tag. No-op if not present.
	 * Returns the new substatus array.
	 *
	 * @internal Same serialization requirement as addSubstatus — see above.
	 */
	async removeSubstatus(narratorId: string, tag: string): Promise<string[]> {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { substatus: true },
		});
		const current = parseSubstatus(row?.substatus);
		if (!current.includes(tag)) return current;
		const updated = current.filter((t) => t !== tag);
		await this.updateSubstatus(narratorId, updated);
		return updated;
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
			resultMessageId?: string;
		},
		messageId?: string,
	) {
		const conditions = [eq(narratorToolCalls.toolUseId, toolUseId)];
		if (messageId) conditions.push(eq(narratorToolCalls.messageId, messageId));
		await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				status: result.status,
				errorMessage: result.errorMessage ?? null,
				durationMs: result.durationMs ?? null,
				...(result.resultMessageId != null && { resultMessageId: result.resultMessageId }),
			})
			.where(and(...conditions));
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

	async copyOnWriteToolCallMessage(
		narratorId: string,
		messageId: string,
		toolUseId: string,
	): Promise<string> {
		const newMessageId = generateId();
		const now = new Date().toISOString();

		await db.transaction(async (tx) => {
			const original = await tx.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, messageId),
			});
			if (!original) throw new NotFoundError("Message", messageId);

			await tx.insert(narratorMessages).values({
				...original,
				id: newMessageId,
				createdAt: now,
			});

			await tx
				.update(narratorMessageRefs)
				.set({ messageId: newMessageId })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.messageId, messageId),
					),
				);

			const originalTc = await tx.query.narratorToolCalls.findFirst({
				where: and(
					eq(narratorToolCalls.messageId, messageId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			});
			if (originalTc) {
				await tx.insert(narratorToolCalls).values({
					...originalTc,
					id: generateId(),
					messageId: newMessageId,
				});
			}
		});

		return newMessageId;
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

		await db.transaction(async (tx) => {
			await tx
				.update(narratorMessageRefs)
				.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						gte(narratorMessageRefs.seq, insertSeq),
					),
				);

			await tx.insert(narratorMessages).values({
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
			});

			await tx.insert(narratorMessageRefs).values({
				id: generateId(),
				narratorId,
				messageId: id,
				seq: insertSeq,
				isCompact: 0,
			});

			const targetMessageIds = refs.map((r) => r.messageId);
			await tx
				.update(narratorMessageRefs)
				.set({ segmentCompactId: id })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						inArray(narratorMessageRefs.messageId, targetMessageIds),
					),
				);
		});

		const [msg] = await db.select().from(narratorMessages).where(eq(narratorMessages.id, id));

		const hiddenMessageIds = refs.map((r) => r.messageId);
		return { message: msg, hiddenMessageIds };
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
			with: { toolCalls: true },
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

		return db.transaction(async (tx) => {
			const [updated] = await tx
				.update(narratorMessages)
				.set({
					contentJson: [block],
					contentText: `${prefix}\n${summary}`,
					contextPercent: contextPercent ?? null,
				})
				.where(and(eq(narratorMessages.id, messageId), eq(narratorMessages.narratorId, narratorId)))
				.returning();

			if (!updated) return null;

			if (status === "failed") {
				await tx
					.update(narratorMessageRefs)
					.set({ segmentCompactId: null })
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.segmentCompactId, messageId),
						),
					);
			}

			await tx
				.update(narrators)
				.set({
					messageVersion: sql`${narrators.messageVersion} + 1`,
					apiConversationId: null,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));

			return updated;
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
			with: { toolCalls: true },
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

		await db.transaction(async (tx) => {
			await tx
				.update(narratorMessageRefs)
				.set({ segmentCompactId: null })
				.where(
					and(
						eq(narratorMessageRefs.narratorId, narratorId),
						eq(narratorMessageRefs.segmentCompactId, messageId),
					),
				);

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

			await tx
				.update(narrators)
				.set({
					apiConversationId: null,
					messageVersion: sql`${narrators.messageVersion} + 1`,
					updatedAt: now,
				})
				.where(eq(narrators.id, narratorId));
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
		await db.transaction(async (tx) => {
			await tx
				.update(narratorMessages)
				.set({
					contentJson: [newBlock],
					contentText: `[Segment Compact]\n${summary}`,
				})
				.where(eq(narratorMessages.id, messageId));

			await tx
				.update(narrators)
				.set({ apiConversationId: null, updatedAt: now })
				.where(eq(narrators.id, narratorId));
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

	async clearPruneBoundary(narratorId: string): Promise<void> {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ pruneBoundaryMessageId: null, prunedPercent: null, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},
};
