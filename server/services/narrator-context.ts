import { agentGenerateWithMeta } from "../lib/agent";
import { logger } from "../lib/logger";
import { getPrompt, getToolMessage, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { narratorService } from "./narrator-service";

const SUMMARY_MAX_MESSAGES = 50;
const COMPACT_MAX_RETRIES = 2;

/** Tool call statuses that indicate the call is still in-flight. */
const IN_FLIGHT_STATUSES = new Set(["initializing", "pending", "running"]);

export const narratorContext = {
	/**
	 * Generate a compressed context summary from parent narrator's recent messages.
	 * Uses Haiku model for fast, low-cost summarization.
	 *
	 * If the narrator already has a contextSummary (from a previous compact), it is
	 * prepended to the conversation text so the summary model can incorporate it.
	 * This prevents losing context that was compacted before the recent messages.
	 */
	async generateContextSummary(
		narratorId: string,
		locale: Locale = "en",
		options?: { throwOnFailure?: boolean },
	): Promise<string> {
		const narrator = await narratorService.getById(narratorId);
		const messages = await narratorService.getMessages(narratorId, SUMMARY_MAX_MESSAGES);

		if (messages.length === 0 && !narrator.contextSummary) return "No conversation history.";

		let conversationText = messages
			.map((m) => {
				const role = m.role === "assistant" ? "Assistant" : "User";
				const text = m.contentText || JSON.stringify(m.contentJson);
				return `[${role}]: ${text}`;
			})
			.join("\n\n");

		// Include prior compact summary so it isn't lost during fork
		if (narrator.contextSummary) {
			conversationText = `[Previous context summary]:\n${narrator.contextSummary}\n\n---\n\n${conversationText}`;
		}

		const summaryPrompt = getPrompt("compact", locale);

		try {
			const summarySuffix = getPrompt("compactSuffix", locale);
			const summaryUserText = `<conversation>\n${conversationText}\n</conversation>\n\n${summarySuffix}`;
			const result = await agentGenerateWithMeta(
				summaryUserText,
				settings.agent.summaryModel,
				summaryPrompt,
			);

			return result.text || "Failed to generate summary.";
		} catch (err) {
			logger.error("Context summary generation failed", { narratorId, error: String(err) });
			if (options?.throwOnFailure) {
				throw err;
			}
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
	 * - If the narrator already has a contextSummary from a previous compact, it is
	 *   prepended so the summary model can incorporate prior context (summary chaining).
	 */
	async generateCompactSummary(
		narratorId: string,
		locale: Locale = "en",
		providedMessages?: Awaited<ReturnType<typeof narratorService.getMessagesSinceLastCompact>>,
	): Promise<{ summary: string; contextPercent?: number }> {
		const messages =
			providedMessages ?? (await narratorService.getMessagesSinceLastCompact(narratorId));

		// Fetch narrator early — needed for contextSummary chaining and todo check
		const narrator = await narratorService.getById(narratorId);

		if (messages.length === 0 && !narrator.contextSummary) {
			return { summary: "No conversation history." };
		}

		let conversationText = messages
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

		// Chain previous compact summary so earlier context isn't lost across compacts
		if (narrator.contextSummary) {
			conversationText = `[Previous context summary]:\n${narrator.contextSummary}\n\n---\n\n${conversationText}`;
		}

		if (!conversationText.trim()) return { summary: "No conversation history." };

		const compactPrompt = getPrompt("compact", locale);

		// Check if there are pending todos — if so, skip todo generation in summary
		const todos = Array.isArray(narrator.todosJson) ? narrator.todosJson : [];
		const hasPendingTodos = todos.some((t: { status?: string }) => t.status !== "completed");
		const todoSkipHint = hasPendingTodos ? `\n\n${getToolMessage("compactTodoSkip", locale)}` : "";

		const compactSuffix = getPrompt("compactSuffix", locale);
		const compactSystemPrompt = `${compactPrompt}${todoSkipHint}`;
		const compactUserText = `<conversation>\n${conversationText}\n</conversation>\n\n${compactSuffix}`;

		let lastError: unknown;
		for (let attempt = 1; attempt <= COMPACT_MAX_RETRIES; attempt++) {
			try {
				const result = await agentGenerateWithMeta(
					compactUserText,
					settings.agent.summaryModel,
					compactSystemPrompt,
				);
				if (!result.text?.trim()) {
					throw new Error("Compact summary model returned empty output");
				}
				return {
					summary: result.text,
					contextPercent: result.contextPercent,
				};
			} catch (err) {
				lastError = err;
				logger.error("Compact summary generation attempt failed", {
					narratorId,
					attempt,
					maxRetries: COMPACT_MAX_RETRIES,
					error: String(err),
				});
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	},
};

/** Truncate a JSON value to a readable preview string. */
function summarizeJson(val: unknown, maxLen: number): string {
	if (val === null || val === undefined) return "(empty)";
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen)}…[${str.length - maxLen} more chars]`;
}
