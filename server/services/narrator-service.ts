import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRequests,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";

interface CreateNarratorInput {
	chapterId?: string | null;
	type?: "primary" | "secondary";
	model?: string;
	systemPrompt?: string;
	permissionMode?: string;
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

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: input.chapterId ?? null,
				type,
				model: input.model ?? settings.agent.defaultModel,
				systemPrompt: input.systemPrompt,
				permissionMode: (input.permissionMode ?? settings.agent.defaultPermissionMode) as
					| "default"
					| "acceptEdits"
					| "bypassPermissions"
					| "plan"
					| "dontAsk",
				inheritMode: "fresh",
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Narrator created", { id, chapterId: input.chapterId, type });
		return narrator;
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
			where: eq(narrators.chapterId, chapterId),
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

	async getPendingPermissions(narratorId: string) {
		return db.query.permissionRequests.findMany({
			where: and(
				eq(permissionRequests.narratorId, narratorId),
				eq(permissionRequests.decision, "pending"),
			),
			orderBy: (p, { asc }) => [asc(p.createdAt)],
		});
	},

	async persistUserMessage(narratorId: string, text: string) {
		const id = generateId();
		const now = new Date().toISOString();
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				role: "user",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.returning();
		return msg;
	},

	async persistAssistantMessage(
		narratorId: string,
		sdkMessage: { uuid: string; session_id: string; message: { content: any[]; usage?: any } },
	) {
		const id = generateId();
		const now = new Date().toISOString();
		const content = sdkMessage.message.content;

		// Extract plain text for search
		const contentText = content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");

		const usage = sdkMessage.message.usage;
		const [msg] = await db
			.insert(narratorMessages)
			.values({
				id,
				narratorId,
				sdkMessageUuid: sdkMessage.uuid,
				role: "assistant",
				contentJson: content,
				contentText: contentText || null,
				tokensIn: usage?.input_tokens,
				tokensOut: usage?.output_tokens,
				createdAt: now,
			})
			.returning();

		// Extract tool_use blocks and create tool call records
		const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
		for (const block of toolUseBlocks) {
			await db.insert(narratorToolCalls).values({
				id: generateId(),
				narratorId,
				messageId: id,
				toolUseId: block.id,
				toolName: block.name,
				inputJson: block.input,
				status: "running",
				createdAt: now,
			});
		}

		return msg;
	},

	async updateSessionId(narratorId: string, claudeSessionId: string) {
		await db
			.update(narrators)
			.set({ claudeSessionId, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
	},

	async updateStats(narratorId: string, costUsd: number) {
		const narrator = await this.getById(narratorId);
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				messageCount: (narrator.messageCount ?? 0) + 1,
				totalCostUsd: (narrator.totalCostUsd ?? 0) + costUsd,
				lastMessageAt: now,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	},

	async updatePermissionMode(
		narratorId: string,
		permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk",
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ permissionMode, updatedAt: now })
			.where(eq(narrators.id, narratorId));
	},

	async updateStatus(
		narratorId: string,
		status: "active" | "paused" | "completed" | "error",
		errorMessage?: string,
	) {
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ status, errorMessage, updatedAt: now })
			.where(eq(narrators.id, narratorId));

		eventBus.emit(
			status === "error"
				? { type: "narrator:error", narratorId, error: errorMessage ?? "Unknown error" }
				: { type: "narrator:completed", narratorId },
		);
	},

	async updateToolCallResult(
		toolUseId: string,
		result: {
			output?: any;
			status: "completed" | "failed";
			errorMessage?: string;
			durationMs?: number;
		},
	) {
		const now = new Date().toISOString();
		await db
			.update(narratorToolCalls)
			.set({
				outputJson: result.output ?? null,
				status: result.status,
				errorMessage: result.errorMessage,
				durationMs: result.durationMs,
			})
			.where(eq(narratorToolCalls.toolUseId, toolUseId));
	},

	async remove(narratorId: string) {
		// Delete in dependency order
		await db.delete(permissionRequests).where(eq(permissionRequests.narratorId, narratorId));
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
		logger.info("Narrator removed", { narratorId });
	},
};
