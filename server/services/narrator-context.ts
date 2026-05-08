import { summaryGenerate } from "../lib/agent";
import {
	isContextOverflowMessage,
	isContextWindowExceededError,
} from "../lib/agent/error-handling";
import { estimateTokens } from "../lib/agent/estimate-tokens";
import { logger } from "../lib/logger";
import { getPrompt, getToolMessage, type Locale } from "../lib/prompt-i18n";
import { getSummaryModelContextWindow } from "../lib/settings/provider";
import { narratorService } from "./narrator-service";
import { buildTodoCompactContext } from "./todo-reminder";

export { estimateTokens };

const SUMMARY_MAX_MESSAGES = 50;
const COMPACT_MAX_RETRIES = 2;
const COMPACT_CONTEXT_OVERFLOW_MAX_DEPTH = 8;
const COMPACT_OVERFLOW_RETRY_BUDGET_RATIO = 0.6;
const COMPACT_MIN_TEXT_SPLIT_CHARS = 1_000;

/** Tool call statuses that indicate the call is still in-flight. */
const IN_FLIGHT_STATUSES = new Set(["initializing", "pending", "running"]);

/**
 * Target ratio of the summary model's context window to use for compact input.
 * Leaves 20% headroom for the model's output and safety margin.
 */
const COMPACT_TARGET_RATIO = 0.8;

// ── Message → text conversion ─────────────────────────────────────────────────

type CompactMessage = Awaited<ReturnType<typeof narratorService.getMessagesSinceLastCompact>>[0];

interface CompactEntry {
	message: CompactMessage;
	text: string;
	pruned: boolean;
	dropped: boolean;
}

const TODO_REMINDER_BLOCK_RE = /\n?\s*<todo_reminder>[\s\S]*?<\/todo_reminder>\s*/g;

function stripTodoReminderBlocks(value: unknown): unknown {
	if (typeof value === "string") return value.replace(TODO_REMINDER_BLOCK_RE, "").trimEnd();
	if (Array.isArray(value)) return value.map(stripTodoReminderBlocks);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [key, stripTodoReminderBlocks(nested)]),
		);
	}
	return value;
}

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
	let text = (stripTodoReminderBlocks(m.contentText || "") as string) || "";

	// For assistant messages, enrich with tool call details
	if (m.role === "assistant" && tcs?.length) {
		const toolSummaries = tcs.map((tc) => {
			const inputStr = summarizeJson(tc.inputJson, 300);
			const outputStr = summarizeJson(stripTodoReminderBlocks(tc.outputJson), 500);
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
	const text = (stripTodoReminderBlocks(m.contentText || "") as string) || "";
	if (!text) return null;
	return `[${role}]: ${text}`;
}

function isCompactContextOverflowError(err: unknown): boolean {
	if (isContextWindowExceededError(err)) return true;
	if (typeof err === "string") return isContextOverflowMessage(err);
	if (err instanceof Error) return isContextOverflowMessage(err.message);
	return false;
}

function cloneCompactEntries(entries: CompactEntry[]): CompactEntry[] {
	return entries.map((entry) => ({ ...entry }));
}

function splitTextEntryForContextOverflow(entry: CompactEntry): CompactEntry[][] | null {
	if (entry.text.length < COMPACT_MIN_TEXT_SPLIT_CHARS) return null;

	const midpoint = Math.floor(entry.text.length / 2);
	const window = Math.floor(entry.text.length * 0.1);
	const leftWindow = Math.max(0, midpoint - window);
	const rightWindow = Math.min(entry.text.length, midpoint + window);
	const candidate = entry.text.lastIndexOf("\n\n", midpoint);
	const splitAt = candidate >= leftWindow ? candidate : entry.text.indexOf("\n\n", midpoint);
	const safeSplitAt = splitAt > 0 && splitAt <= rightWindow ? splitAt : midpoint;

	const firstText = `${entry.text.slice(0, safeSplitAt).trimEnd()}\n[Message continues in next compact chunk]`;
	const secondText = `[Continuation of previous message]\n${entry.text.slice(safeSplitAt).trimStart()}`;

	return [[{ ...entry, text: firstText }], [{ ...entry, text: secondText }]];
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
			const result = await summaryGenerate(summaryUserText, summaryPrompt, {
				narratorId,
				kind: "fork_summary",
			});

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
	 * When the conversation exceeds the summary model's context window, uses
	 * **cascading summarization**: splits messages into chunks that each fit the
	 * summary model, summarizes them sequentially, and feeds each chunk's summary
	 * as the "previous context summary" into the next chunk. The final chunk
	 * produces the overall summary.
	 *
	 * Within each chunk, progressive fitting (prune tool calls → drop oldest
	 * messages) is still applied as a safety net.
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

		// Fetch narrator early — needed for contextSummary chaining
		const narrator = await narratorService.getById(narratorId);

		if (messages.length === 0 && !narrator.contextSummary) {
			return { summary: "No conversation history." };
		}

		// ── Build per-message compact text entries ──
		const pruneBoundaryIdx = pruneBoundaryMessageId
			? messages.findIndex((m) => m.id === pruneBoundaryMessageId)
			: -1;

		const entries: CompactEntry[] = [];

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const shouldPrune = i <= pruneBoundaryIdx;
			const text = shouldPrune ? messageToCompactTextPruned(m) : messageToCompactText(m);
			if (text == null) continue;
			entries.push({ message: m, text, pruned: shouldPrune, dropped: false });
		}

		// ── Compute fixed overhead ──
		const compactPrompt = getPrompt("compact", locale);
		const todoSkipHint = getToolMessage("compactTodoSkip", locale);
		const latestTodoContext = buildTodoCompactContext(narrator.todosJson, locale);
		const compactSuffix = getPrompt("compactSuffix", locale);
		const compactSystemPrompt = [compactPrompt, todoSkipHint, latestTodoContext]
			.filter(Boolean)
			.join("\n\n");

		const summaryCtxWindow = getSummaryModelContextWindow();
		const tokenBudget = Math.floor(summaryCtxWindow * COMPACT_TARGET_RATIO);

		// Fixed tokens that are always present (system prompt + wrapper).
		// The previous-summary prefix is variable per chunk, computed below.
		const baseFixedTokens =
			estimateTokens(compactSystemPrompt) +
			estimateTokens(`<conversation>\n\n</conversation>\n\n${compactSuffix}`);

		// ── Determine whether cascading is needed ──
		const totalTokens = entries.reduce((sum, e) => sum + estimateTokens(e.text), 0);
		const previousSummary = narrator.contextSummary ?? "";
		const previousSummaryTokens = previousSummary
			? estimateTokens(`[Previous context summary]:\n${previousSummary}\n\n---\n\n`)
			: 0;
		const contentBudget = tokenBudget - baseFixedTokens - previousSummaryTokens;

		const chunks =
			totalTokens <= contentBudget
				? [cloneCompactEntries(entries)]
				: splitIntoChunks(entries, tokenBudget, baseFixedTokens, previousSummary);

		if (chunks.length > 1) {
			logger.info("Cascading compact: splitting conversation into chunks", {
				narratorId,
				totalEntries: entries.length,
				totalTokens,
				summaryModelCtx: summaryCtxWindow,
				chunks: chunks.length,
			});
		}

		return this._summarizeChunkSequence(
			narratorId,
			chunks,
			previousSummary,
			compactSystemPrompt,
			compactSuffix,
			baseFixedTokens,
			tokenBudget,
			0,
		);
	},

	async _summarizeChunkSequence(
		narratorId: string,
		chunks: CompactEntry[][],
		initialSummary: string,
		compactSystemPrompt: string,
		compactSuffix: string,
		baseFixedTokens: number,
		tokenBudget: number,
		depth: number,
	): Promise<{ summary: string; contextPercent?: number }> {
		let rollingSummary = initialSummary;
		let lastContextPercent: number | undefined;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const isLast = i === chunks.length - 1;

			logger.info("Cascading compact: processing chunk", {
				narratorId,
				chunk: i + 1,
				totalChunks: chunks.length,
				chunkEntries: chunk.length,
				depth,
				isLast,
			});

			const result = await this._summarizeChunkWithOverflowFallback(
				narratorId,
				chunk,
				rollingSummary,
				compactSystemPrompt,
				compactSuffix,
				baseFixedTokens,
				tokenBudget,
				depth,
			);

			rollingSummary = result.summary;
			lastContextPercent = result.contextPercent;

			if (!isLast) {
				logger.info("Cascading compact: intermediate summary generated", {
					narratorId,
					chunk: i + 1,
					depth,
					summaryLength: rollingSummary.length,
				});
			}
		}

		return { summary: rollingSummary, contextPercent: lastContextPercent };
	},

	async _summarizeChunkWithOverflowFallback(
		narratorId: string,
		entries: CompactEntry[],
		previousSummary: string,
		compactSystemPrompt: string,
		compactSuffix: string,
		baseFixedTokens: number,
		tokenBudget: number,
		depth: number,
	): Promise<{ summary: string; contextPercent?: number }> {
		try {
			return await this._summarizeChunk(
				narratorId,
				entries,
				previousSummary,
				compactSystemPrompt,
				compactSuffix,
				baseFixedTokens,
				tokenBudget,
			);
		} catch (err) {
			if (!isCompactContextOverflowError(err) || depth >= COMPACT_CONTEXT_OVERFLOW_MAX_DEPTH) {
				throw err;
			}

			const fallbackChunks = splitChunkForContextOverflow(
				entries,
				tokenBudget,
				baseFixedTokens,
				previousSummary,
			);
			if (fallbackChunks.length <= 1) throw err;

			logger.warn("Compact chunk exceeded summary model context, cascading into smaller chunks", {
				narratorId,
				depth,
				chunkEntries: entries.length,
				fallbackChunks: fallbackChunks.length,
				error: err instanceof Error ? err.message : String(err),
			});

			return this._summarizeChunkSequence(
				narratorId,
				fallbackChunks,
				previousSummary,
				compactSystemPrompt,
				compactSuffix,
				baseFixedTokens,
				tokenBudget,
				depth + 1,
			);
		}
	},

	/**
	 * Summarize a single chunk of entries with progressive fitting + LLM call.
	 * Shared by both single-pass and cascading paths.
	 */
	async _summarizeChunk(
		narratorId: string,
		entries: CompactEntry[],
		previousSummary: string,
		compactSystemPrompt: string,
		compactSuffix: string,
		baseFixedTokens: number,
		tokenBudget: number,
	): Promise<{ summary: string; contextPercent?: number }> {
		const previousSummaryPrefix = previousSummary
			? `[Previous context summary]:\n${previousSummary}\n\n---\n\n`
			: "";
		const fixedTokens = baseFixedTokens + estimateTokens(previousSummaryPrefix);
		const contentBudget = tokenBudget - fixedTokens;

		// ── Progressive fitting: alternate prune ↔ drop until within budget ──
		let totalTokens = entries.reduce(
			(sum, e) => (e.dropped ? sum : sum + estimateTokens(e.text)),
			0,
		);

		let prunePtr = 0;
		let dropPtr = 0;
		let preferPrune = true;
		const MAX_ITERATIONS = entries.length * 3;
		let iterations = 0;

		while (totalTokens > contentBudget && iterations < MAX_ITERATIONS) {
			iterations++;
			let madeProgress = false;

			if (preferPrune) {
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
						e.pruned = true;
					}
					prunePtr++;
				}
			}

			if (!preferPrune || !madeProgress) {
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

			if (!madeProgress) break;
			preferPrune = !preferPrune;
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
				const result = await summaryGenerate(compactUserText, compactSystemPrompt, {
					narratorId,
					kind: "compact",
				});
				if (!result.text?.trim()) {
					throw new Error("Compact summary model returned empty output");
				}
				return {
					summary: result.text,
					contextPercent: result.contextPercent,
				};
			} catch (err) {
				lastError = err;
				if (isCompactContextOverflowError(err)) {
					logger.warn("Compact summary request exceeded summary model context", {
						narratorId,
						estimatedTokens: totalTokens + fixedTokens,
						tokenBudget,
						activeEntries: activeTexts.length,
						error: err instanceof Error ? err.message : String(err),
					});
					throw err;
				}
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

// ── Chunking helper for cascading compact ──────────────────────────────────────

/**
 * Split entries into sequential chunks where each chunk's total tokens fits
 * within the summary model's content budget.
 *
 * The first chunk accounts for the original previousSummary overhead.
 * Subsequent chunks reserve space for an intermediate summary prefix
 * (estimated at a fixed size since we don't know the actual summary yet).
 *
 * Each chunk gets its own copy of entries (with fresh dropped/pruned state)
 * so that `_summarizeChunk` can mutate them independently.
 */
function splitIntoChunks(
	entries: CompactEntry[],
	tokenBudget: number,
	baseFixedTokens: number,
	previousSummary: string,
): CompactEntry[][] {
	// Estimate how much space an intermediate summary prefix will take.
	// A typical compact summary is ~1500-3000 tokens. Reserve a generous
	// estimate so the chunk doesn't overflow.
	const INTERMEDIATE_SUMMARY_RESERVE = 4_000;

	const chunks: CompactEntry[][] = [];
	let cursor = 0;

	while (cursor < entries.length) {
		// For the first chunk, use the actual previousSummary overhead.
		// For subsequent chunks, reserve space for the intermediate summary.
		const summaryOverhead =
			chunks.length === 0 && previousSummary
				? estimateTokens(`[Previous context summary]:\n${previousSummary}\n\n---\n\n`)
				: chunks.length > 0
					? INTERMEDIATE_SUMMARY_RESERVE
					: 0;

		const contentBudget = tokenBudget - baseFixedTokens - summaryOverhead;
		const chunk: CompactEntry[] = [];
		let chunkTokens = 0;

		while (cursor < entries.length) {
			const entryTokens = estimateTokens(entries[cursor].text);
			if (chunk.length > 0 && chunkTokens + entryTokens > contentBudget) {
				break;
			}
			// Clone entry so _summarizeChunk can mutate pruned/dropped independently
			chunk.push({ ...entries[cursor] });
			chunkTokens += entryTokens;
			cursor++;
		}

		if (chunk.length > 0) {
			chunks.push(chunk);
		}
	}

	return chunks;
}

function splitChunkForContextOverflow(
	entries: CompactEntry[],
	tokenBudget: number,
	baseFixedTokens: number,
	previousSummary: string,
): CompactEntry[][] {
	if (entries.length === 0) return [];

	if (entries.length === 1) {
		const textChunks = splitTextEntryForContextOverflow(entries[0]);
		return textChunks ?? [cloneCompactEntries(entries)];
	}

	const reducedBudget = Math.max(
		Math.floor(tokenBudget * COMPACT_OVERFLOW_RETRY_BUDGET_RATIO),
		baseFixedTokens + 1,
	);
	const reducedChunks = splitIntoChunks(entries, reducedBudget, baseFixedTokens, previousSummary);
	if (reducedChunks.length > 1) return reducedChunks;

	const midpoint = Math.max(1, Math.floor(entries.length / 2));
	return [
		cloneCompactEntries(entries.slice(0, midpoint)),
		cloneCompactEntries(entries.slice(midpoint)),
	].filter((chunk) => chunk.length > 0);
}

/** Truncate a JSON value to a readable preview string. */
function summarizeJson(val: unknown, maxLen: number): string {
	if (val === null || val === undefined) return "(empty)";
	const str = typeof val === "string" ? val : JSON.stringify(val);
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen)}…[${str.length - maxLen} more chars]`;
}
