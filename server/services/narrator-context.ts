import { db } from "../db";
import { narrators } from "../db/schema";
import { agentGenerate } from "../lib/agent";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getPrompt, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { narratorService } from "./narrator-service";

const SUMMARY_MAX_MESSAGES = 50;
const COMPACT_MAX_MESSAGES = 100;

interface ForkNarratorInput {
	parentNarratorId: string;
	newChapterId: string;
	inheritMode: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
	type?: "primary" | "secondary";
	locale?: Locale;
}

export const narratorContext = {
	/**
	 * Create a forked narrator with the specified inheritance mode.
	 * For "full" mode, actual SDK fork is deferred to first message send.
	 */
	async forkNarrator(input: ForkNarratorInput) {
		const parent = await narratorService.getById(input.parentNarratorId);
		const now = new Date().toISOString();
		const id = generateId();

		let contextSummary: string | null = null;

		if (input.inheritMode === "compressed") {
			contextSummary = await this.generateContextSummary(
				input.parentNarratorId,
				input.locale ?? "en",
			);
		}

		const [narrator] = await db
			.insert(narrators)
			.values({
				id,
				chapterId: input.newChapterId,
				type: input.type ?? parent.type,
				model: parent.model,
				systemPrompt:
					input.inheritMode === "compressed" && contextSummary
						? buildCompressedSystemPrompt(parent.systemPrompt, contextSummary)
						: parent.systemPrompt,
				permissionMode: parent.permissionMode,
				inheritMode: input.inheritMode,
				parentNarratorId: input.parentNarratorId,
				// For "full" mode, store parent session ID so we can fork on first message
				claudeSessionId: input.inheritMode === "full" ? parent.claudeSessionId : null,
				contextSummary,
				status: "idle",
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		logger.info("Narrator forked", {
			id,
			parentId: input.parentNarratorId,
			inheritMode: input.inheritMode,
			forkAtMessageUuid: input.forkAtMessageUuid,
		});

		return narrator;
	},

	/**
	 * Generate a compressed context summary from parent narrator's recent messages.
	 * Uses Haiku model for fast, low-cost summarization.
	 */
	async generateContextSummary(narratorId: string, locale: Locale = "en"): Promise<string> {
		const messages = await narratorService.getMessages(narratorId, SUMMARY_MAX_MESSAGES);

		if (messages.length === 0) return "No conversation history.";

		const conversationText = messages
			.map((m) => {
				const role = m.role === "assistant" ? "Assistant" : "User";
				const text = m.contentText || JSON.stringify(m.contentJson);
				return `[${role}]: ${text}`;
			})
			.join("\n\n");

		const summaryPrompt = getPrompt("summary", locale);

		try {
			const summary = await agentGenerate(
				summaryPrompt + conversationText,
				settings.agent.summaryModel,
			);

			return summary || "Failed to generate summary.";
		} catch (err) {
			logger.error("Context summary generation failed", { narratorId, error: String(err) });
			return "Context summary generation failed. Starting fresh.";
		}
	},

	/**
	 * Generate a thorough compact summary for session rotation.
	 * More detailed than fork summary — preserves file paths, modifications, and working state.
	 */
	async generateCompactSummary(narratorId: string, locale: Locale = "en"): Promise<string> {
		const messages = await narratorService.getMessages(narratorId, COMPACT_MAX_MESSAGES);

		if (messages.length === 0) return "No conversation history.";

		const conversationText = messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => {
				const role = m.role === "assistant" ? "Assistant" : "User";
				let text = m.contentText || "";
				if (!text && m.role === "assistant") {
					const content = m.contentJson as any[];
					const toolNames = content
						?.filter((b: any) => b.type === "tool_use")
						.map((b: any) => b.name);
					if (toolNames?.length) {
						text = `[Used tools: ${toolNames.join(", ")}]`;
					}
				}
				if (!text) return null;
				return `[${role}]: ${text}`;
			})
			.filter(Boolean)
			.join("\n\n");

		const compactPrompt = getPrompt("compact", locale);

		try {
			const summary = await agentGenerate(
				compactPrompt + conversationText,
				settings.agent.summaryModel,
			);

			return summary || "Failed to generate compact summary.";
		} catch (err) {
			logger.error("Compact summary generation failed, falling back to basic summary", {
				narratorId,
				error: String(err),
			});
			return this.generateContextSummary(narratorId, locale);
		}
	},
};

function buildCompressedSystemPrompt(
	originalPrompt: string | null,
	contextSummary: string,
): string {
	const base = originalPrompt ?? "";
	const separator = base ? "\n\n" : "";
	return `${base}${separator}## Previous Context Summary\n\nThis session continues from a previous conversation. Here is a summary of the prior context:\n\n${contextSummary}`;
}
