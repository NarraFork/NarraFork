import { db } from "../db";
import { narrators } from "../db/schema";
import { agentGenerate, agentGenerateWithMeta } from "../lib/agent";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getPrompt, getToolMessage, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { narratorService } from "./narrator-service";

const SUMMARY_MAX_MESSAGES = 50;

/** Tool call statuses that indicate the call is still in-flight. */
const IN_FLIGHT_STATUSES = new Set(["initializing", "pending", "running"]);

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
				apiConversationId: input.inheritMode === "full" ? parent.apiConversationId : null,
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

		const summaryPrompt = getPrompt("compact", locale);

		try {
			const summarySuffix = getPrompt("compactSuffix", locale);
			const summary = await agentGenerate(
				`${summaryPrompt}\n<conversation>\n${conversationText}\n</conversation>\n\n${summarySuffix}`,
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
	 *
	 * - Fetches ALL user/assistant messages (no limit) — system messages are excluded
	 *   because the system prompt will be re-injected after compact.
	 * - Skips messages whose tool calls are still in-flight (initializing/pending/running)
	 *   to avoid summarizing incomplete operations.
	 * - Includes tool call input/output summaries so the model retains knowledge of
	 *   file modifications and command results.
	 */
	async generateCompactSummary(
		narratorId: string,
		locale: Locale = "en",
		providedMessages?: Awaited<ReturnType<typeof narratorService.getMessagesSinceLastCompact>>,
	): Promise<{ summary: string; contextPercent?: number }> {
		const messages =
			providedMessages ?? (await narratorService.getMessagesSinceLastCompact(narratorId));

		if (messages.length === 0) return { summary: "No conversation history." };

		const conversationText = messages
			// Only user and assistant messages — system messages (including previous compact
			// markers) are excluded because the system prompt is re-injected after compact.
			.filter((m) => m.role === "user" || m.role === "assistant")
			// Skip messages that have any in-flight tool calls
			.filter((m) => {
				const tcs = m.toolCalls;
				if (!tcs || tcs.length === 0) return true;
				return !tcs.some((tc) => IN_FLIGHT_STATUSES.has(tc.status));
			})
			.map((m) => {
				const role = m.role === "assistant" ? "Assistant" : "User";
				let text = m.contentText || "";

				// For assistant messages, enrich with tool call details
				if (m.role === "assistant") {
					const tcs = m.toolCalls;
					if (tcs?.length) {
						const toolSummaries = tcs.map((tc) => {
							const inputStr = summarizeJson(tc.inputJson, 300);
							const outputStr = summarizeJson(tc.outputJson, 500);
							const statusTag = tc.status === "fail" ? " [FAILED]" : "";
							return `  - ${tc.toolName}${statusTag}: input=${inputStr} → output=${outputStr}`;
						});
						const toolBlock = `\n[Tool calls]\n${toolSummaries.join("\n")}`;
						text = text ? `${text}${toolBlock}` : toolBlock.trimStart();
					}
				}

				if (!text) return null;
				return `[${role}]: ${text}`;
			})
			.filter(Boolean)
			.join("\n\n");

		if (!conversationText.trim()) return { summary: "No conversation history." };

		const compactPrompt = getPrompt("compact", locale);

		// Check if there are pending todos — if so, skip todo generation in summary
		const narrator = await narratorService.getById(narratorId);
		const todos = Array.isArray(narrator.todosJson) ? narrator.todosJson : [];
		const hasPendingTodos = todos.some((t: { status?: string }) => t.status !== "completed");
		const todoSkipHint = hasPendingTodos ? `\n\n${getToolMessage("compactTodoSkip", locale)}` : "";

		try {
			const compactSuffix = getPrompt("compactSuffix", locale);
			const result = await agentGenerateWithMeta(
				`${compactPrompt}${todoSkipHint}\n<conversation>\n${conversationText}\n</conversation>\n\n${compactSuffix}`,
				settings.agent.summaryModel,
			);

			return {
				summary: result.text || "Failed to generate compact summary.",
				contextPercent: result.contextPercent,
			};
		} catch (err) {
			logger.error("Compact summary generation failed, falling back to basic summary", {
				narratorId,
				error: String(err),
			});
			const fallback = await this.generateContextSummary(narratorId, locale);
			return { summary: fallback };
		}
	},
};

/** Truncate a JSON value to a readable preview string. */
function summarizeJson(val: unknown, maxLen: number): string {
	if (val === null || val === undefined) return "(empty)";
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen)}…[${str.length - maxLen} more chars]`;
}

function buildCompressedSystemPrompt(
	originalPrompt: string | null,
	contextSummary: string,
): string {
	const base = originalPrompt ?? "";
	const separator = base ? "\n\n" : "";
	return `${base}${separator}## Previous Context Summary\n\nThis session continues from a previous conversation. Here is a summary of the prior context:\n\n${contextSummary}`;
}
