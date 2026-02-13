import { query } from "@anthropic-ai/claude-agent-sdk";
import { db } from "../db";
import { narrators } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { narratorService } from "./narrator-service";

const SUMMARY_MODEL = "claude-haiku-4-5";
const SUMMARY_MAX_MESSAGES = 50;

const SUMMARY_PROMPT = `You are a context summarizer. Analyze the conversation history below and produce a concise summary focusing on:
1. Key decisions made
2. Current state of the code/project
3. Outstanding TODOs and next steps
4. Important context that a new session would need

Respond in the same language as the original conversation. Be concise but thorough.

Conversation history:
`;

interface ForkNarratorInput {
	parentNarratorId: string;
	newChapterId: string;
	inheritMode: "full" | "compressed" | "fresh";
	forkAtMessageUuid?: string;
	type?: "primary" | "secondary";
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
			contextSummary = await this.generateContextSummary(input.parentNarratorId);
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
				status: "active",
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
	async generateContextSummary(narratorId: string): Promise<string> {
		const messages = await narratorService.getMessages(narratorId, SUMMARY_MAX_MESSAGES);

		if (messages.length === 0) return "No conversation history.";

		const conversationText = messages
			.map((m) => {
				const role = m.role === "assistant" ? "Assistant" : "User";
				const text = m.contentText || JSON.stringify(m.contentJson);
				return `[${role}]: ${text}`;
			})
			.join("\n\n");

		try {
			const summaryQuery = query({
				prompt: SUMMARY_PROMPT + conversationText,
				options: {
					model: SUMMARY_MODEL,
					maxTurns: 1,
					tools: [],
					permissionMode: "dontAsk",
				},
			});

			let summary = "";
			for await (const message of summaryQuery) {
				if (message.type === "assistant") {
					const content = message.message.content;
					for (const block of content) {
						if (block.type === "text") {
							summary += block.text;
						}
					}
				}
			}

			return summary || "Failed to generate summary.";
		} catch (err) {
			logger.error("Context summary generation failed", { narratorId, error: String(err) });
			return "Context summary generation failed. Starting fresh.";
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
