import { agentGenerateWithMeta } from "../lib/agent";
import { logger } from "../lib/logger";
import { getPrompt, getToolMessage, type Locale } from "../lib/prompt-i18n";
import { getModelContextWindow, parseModelId, settings } from "../lib/settings";
import { narratorService } from "./narrator-service";

const SUMMARY_MAX_MESSAGES = 50;
const COMPACT_MAX_RETRIES = 2;

/** Tool call statuses that indicate the call is still in-flight. */
const IN_FLIGHT_STATUSES = new Set(["initializing", "pending", "running"]);

/**
 * Target ratio of the summary model's context window to use for compact input.
 * Leaves 20% headroom for the model's output and safety margin.
 */
const COMPACT_TARGET_RATIO = 0.8;

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Estimate token count for a string using character-based heuristics.
 * - ASCII / Latin characters: ~0.3 tokens per character
 * - CJK / wide characters: ~0.6 tokens per character
 *
 * This is intentionally conservative (over-estimates) so we stay within budget.
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// CJK Unified Ideographs, CJK Extension A, Hangul, Kana, fullwidth forms, etc.
		if (
			(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, ideographs
			(code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
			(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
			(code >= 0xff00 && code <= 0xffef) || // Fullwidth forms
			(code >= 0x3000 && code <= 0x303f) || // CJK symbols and punctuation
			(code >= 0x3040 && code <= 0x30ff) // Hiragana + Katakana
		) {
			tokens += 0.6;
		} else {
			tokens += 0.3;
		}
	}
	return Math.ceil(tokens);
}

/**
 * Get the effective context window (in tokens) for the summary model.
 *   reliable context window metadata)
 * - Other providers: use getModelContextWindow() which checks user overrides,
 *   provider config, and built-in table (falls back to 128K)
 */
function getSummaryModelContextWindow(): number {
	const model = settings.agent.summaryModel;
	const parsed = parseModelId(model);

		return 200_000;
	}

	return getModelContextWindow(parsed.model, provider) ?? 128_000;
}

// ── Message → text conversion ─────────────────────────────────────────────────

type CompactMessage = Awaited<ReturnType<typeof narratorService.getMessagesSinceLastCompact>>[0];

/**
 * Convert a single message to its compact text representation.
 * Returns null for messages that produce no text (e.g. empty content, in-flight tools).
 */
function messageToCompactText(m: CompactMessage): string | null {
	// Only user and assistant messages
	if (m.role !== "user" && m.role !== "assistant") return null;

	// Skip messages with in-flight tool calls
	const tcs = m.toolCalls;
	if (tcs?.length && tcs.some((tc) => IN_FLIGHT_STATUSES.has(tc.status))) return null;

	const role = m.role === "assistant" ? "Assistant" : "User";
	let text = m.contentText || "";

	// For assistant messages, enrich with tool call details
	if (m.role === "assistant" && tcs?.length) {
		const toolSummaries = tcs.map((tc) => {
			const inputStr = summarizeJson(tc.inputJson, 300);
			const outputStr = summarizeJson(tc.outputJson, 500);
			const statusTag = tc.status === "fail" ? " [FAILED]" : "";
			return `  - ${tc.toolName}${statusTag}: input=${inputStr} → output=${outputStr}`;
		});
		const toolBlock = `\n[Tool calls]\n${toolSummaries.join("\n")}`;
		text = text ? `${text}${toolBlock}` : toolBlock.trimStart();
	}

	if (!text) return null;
	return `[${role}]: ${text}`;
}

/**
 * Strip tool call details from a message's compact text, keeping only the
 * plain text content. Used when pruning messages to reduce token count.
 */
function messageToCompactTextPruned(m: CompactMessage): string | null {
	if (m.role !== "user" && m.role !== "assistant") return null;
	const tcs = m.toolCalls;
	if (tcs?.length && tcs.some((tc) => IN_FLIGHT_STATUSES.has(tc.status))) return null;

	const role = m.role === "assistant" ? "Assistant" : "User";
	const text = m.contentText || "";
	if (!text) return null;
	return `[${role}]: ${text}`;
}

// ── Compact summary generation ────────────────────────────────────────────────

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
	 * Uses progressive input fitting to ensure the conversation text fits within
	 * the summary model's context window (target: 80% of capacity). When the raw
	 * input exceeds the budget, it alternates between:
	 *   1. Pruning tool calls from the earliest unpruned messages (cheaper)
	 *   2. Dropping the earliest messages entirely (more aggressive)
	 *
	 * @param pruneBoundaryMessageId  The main session's current prune boundary.
	 *   Messages at or before this ID start with tool calls already stripped.
	 */
	async generateCompactSummary(
		narratorId: string,
		locale: Locale = "en",
		providedMessages?: CompactMessage[],
		pruneBoundaryMessageId?: string | null,
	): Promise<{ summary: string; contextPercent?: number }> {
		const messages =
			providedMessages ?? (await narratorService.getMessagesSinceLastCompact(narratorId));

		// Fetch narrator early — needed for contextSummary chaining and todo check
		const narrator = await narratorService.getById(narratorId);

		if (messages.length === 0 && !narrator.contextSummary) {
			return { summary: "No conversation history." };
		}

		// ── Build per-message compact text entries ──
		// Track prune state per message: initially, messages at or before the
		// main session's prune boundary are already "pruned" (tool calls stripped).
		const pruneBoundaryIdx = pruneBoundaryMessageId
			? messages.findIndex((m) => m.id === pruneBoundaryMessageId)
			: -1;

		const entries: Array<{
			message: CompactMessage;
			text: string;
			pruned: boolean;
			dropped: boolean;
		}> = [];

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const shouldPrune = i <= pruneBoundaryIdx;
			const text = shouldPrune ? messageToCompactTextPruned(m) : messageToCompactText(m);
			if (text == null) continue;
			entries.push({ message: m, text, pruned: shouldPrune, dropped: false });
		}

		// ── Compute fixed overhead (system prompt, previous summary, wrapper) ──
		const compactPrompt = getPrompt("compact", locale);
		const todos = Array.isArray(narrator.todosJson) ? narrator.todosJson : [];
		const hasPendingTodos = todos.some((t: { status?: string }) => t.status !== "completed");
		const todoSkipHint = hasPendingTodos ? `\n\n${getToolMessage("compactTodoSkip", locale)}` : "";
		const compactSuffix = getPrompt("compactSuffix", locale);
		const compactSystemPrompt = `${compactPrompt}${todoSkipHint}`;

		const previousSummaryPrefix = narrator.contextSummary
			? `[Previous context summary]:\n${narrator.contextSummary}\n\n---\n\n`
			: "";

		// Wrapper tokens: <conversation>\n ... \n</conversation>\n\n{suffix}
		const wrapperText = `<conversation>\n\n</conversation>\n\n${compactSuffix}`;
		const fixedTokens =
			estimateTokens(compactSystemPrompt) +
			estimateTokens(previousSummaryPrefix) +
			estimateTokens(wrapperText);

		const tokenBudget = Math.floor(getSummaryModelContextWindow() * COMPACT_TARGET_RATIO);
		const contentBudget = tokenBudget - fixedTokens;

		// ── Progressive fitting: alternate prune ↔ drop until within budget ──
		// Phase tracking: alternate between pruning tool calls from the earliest
		// unpruned message and dropping the earliest non-dropped message.
		let totalTokens = entries.reduce(
			(sum, e) => (e.dropped ? sum : sum + estimateTokens(e.text)),
			0,
		);

		// Pointer for the next message to prune (scan from start)
		let prunePtr = 0;
		// Pointer for the next message to drop (scan from start)
		let dropPtr = 0;
		// Alternate: true = try prune first, false = try drop first
		let preferPrune = true;

		const MAX_ITERATIONS = entries.length * 3; // safety cap
		let iterations = 0;

		while (totalTokens > contentBudget && iterations < MAX_ITERATIONS) {
			iterations++;
			let madeProgress = false;

			if (preferPrune) {
				// Try to prune tool calls from the earliest unpruned, non-dropped message
				while (prunePtr < entries.length) {
					const e = entries[prunePtr];
					if (!e.dropped && !e.pruned) break;
					prunePtr++;
				}
				if (prunePtr < entries.length) {
					const e = entries[prunePtr];
					const oldTokens = estimateTokens(e.text);
					const newText = messageToCompactTextPruned(e.message);
					if (newText && newText.length < e.text.length) {
						totalTokens -= oldTokens;
						e.text = newText;
						e.pruned = true;
						totalTokens += estimateTokens(newText);
						madeProgress = true;
					} else {
						// Pruning didn't help (no tool calls or text-only), mark as pruned
						e.pruned = true;
					}
					prunePtr++;
				}
			}

			if (!preferPrune || !madeProgress) {
				// Drop the earliest non-dropped message
				while (dropPtr < entries.length) {
					if (!entries[dropPtr].dropped) break;
					dropPtr++;
				}
				if (dropPtr < entries.length) {
					const e = entries[dropPtr];
					totalTokens -= estimateTokens(e.text);
					e.dropped = true;
					dropPtr++;
					madeProgress = true;
				}
			}

			if (!madeProgress) break; // nothing left to trim
			preferPrune = !preferPrune; // alternate strategy
		}

		// ── Assemble final conversation text ──
		const activeTexts = entries.filter((e) => !e.dropped).map((e) => e.text);
		let conversationText = activeTexts.join("\n\n");

		if (previousSummaryPrefix) {
			conversationText = `${previousSummaryPrefix}${conversationText}`;
		}

		if (!conversationText.trim()) return { summary: "No conversation history." };

		const droppedCount = entries.filter((e) => e.dropped).length;
		const prunedCount = entries.filter((e) => e.pruned && !e.dropped).length;
		if (droppedCount > 0 || prunedCount > 0) {
			logger.info("Compact input fitted to summary model budget", {
				narratorId,
				totalEntries: entries.length,
				droppedMessages: droppedCount,
				prunedMessages: prunedCount,
				estimatedTokens: totalTokens + fixedTokens,
				tokenBudget,
			});
		}

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
