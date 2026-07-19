import { normalizeLocale } from "@shared/i18n-locales";
import { summaryGenerate } from "../lib/agent";
import { estimateTokens } from "../lib/agent/estimate-tokens";
import { getPrompt } from "../lib/prompts/core";
import { getSummaryModelContextWindow } from "../lib/settings/provider";
import type { ContextAskMessageSnapshot } from "./narrator-messages";
import { narratorService } from "./narrator-service";

const CONTEXT_ASK_MAX_MODEL_INPUT_TOKENS = 48_000;
const CONTEXT_ASK_INPUT_RATIO = 0.55;
const CONTEXT_ASK_MIN_CHUNK_TOKENS = 2_000;
const CONTEXT_ASK_MAX_PREVIOUS_TOKENS = 8_000;
export const CONTEXT_ASK_MAX_OUTPUT_CHARS = 16_000;
const CONTEXT_ASK_TRUNCATION_MARKER = "\n... [ContextAsk content truncated] ...\n";

export interface ContextAskInput {
	callerNarratorId: string;
	targetNarratorId: string;
	questions?: string[];
	locale?: string;
	signal?: AbortSignal;
}

export interface ContextAskResult {
	answer: string;
	target: {
		id: string;
		title: string | null;
		status: string;
	};
	questions: string[];
	messageCount: number;
	hasMore: boolean;
	sourceBytes: number;
	sourceTruncated: boolean;
	toolCallsTruncated: boolean;
	chunkCount: number;
	contextPercent?: number;
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= CONTEXT_ASK_TRUNCATION_MARKER.length + 2) return text.slice(0, maxChars);
	const available = maxChars - CONTEXT_ASK_TRUNCATION_MARKER.length;
	const headLength = Math.ceil(available * 0.7);
	const tailLength = Math.max(0, available - headLength);
	return `${text.slice(0, headLength)}${CONTEXT_ASK_TRUNCATION_MARKER}${text.slice(-tailLength)}`;
}

function truncateToTokenBudget(text: string, tokenBudget: number): string {
	if (tokenBudget <= 0) return "";
	const tokens = estimateTokens(text);
	if (tokens <= tokenBudget) return text;

	let maxChars = Math.max(128, Math.floor(text.length * (tokenBudget / tokens) * 0.9));
	let truncated = truncateMiddle(text, maxChars);
	while (estimateTokens(truncated) > tokenBudget && maxChars > 128) {
		maxChars = Math.max(128, Math.floor(maxChars * 0.85));
		truncated = truncateMiddle(text, maxChars);
	}
	return truncated;
}

function formatToolCall(toolCall: ContextAskMessageSnapshot["toolCalls"][number]): string {
	const lines = [`  [tool ${toolCall.toolName} status=${toolCall.status}]`];
	if (toolCall.inputText) {
		lines.push(`    input: ${toolCall.inputText}${toolCall.inputTruncated ? " [truncated]" : ""}`);
	}
	if (toolCall.outputText) {
		lines.push(
			`    output: ${toolCall.outputText}${toolCall.outputTruncated ? " [truncated]" : ""}`,
		);
	}
	return lines.join("\n");
}

export function formatContextAskMessage(message: ContextAskMessageSnapshot): string | null {
	const content = message.contentText?.trim() ?? "";
	if (!content && message.toolCalls.length === 0 && message.omittedToolCalls === 0) return null;

	const lines = [`[seq=${message.seq}] ${message.role}`];
	if (content) {
		lines.push(content + (message.contentTruncated ? "\n[message text truncated]" : ""));
	}
	for (const toolCall of message.toolCalls) lines.push(formatToolCall(toolCall));
	if (message.omittedToolCalls > 0) {
		lines.push(`  [${message.omittedToolCalls} older tool call(s) omitted]`);
	}
	return lines.join("\n");
}

export function splitContextAskEntries(entries: string[], tokenBudget: number): string[][] {
	if (entries.length === 0) return [[]];
	const boundedBudget = Math.max(CONTEXT_ASK_MIN_CHUNK_TOKENS, tokenBudget);
	const chunks: string[][] = [];
	let current: string[] = [];
	let currentTokens = 0;

	for (const rawEntry of entries) {
		const entry = truncateToTokenBudget(rawEntry, boundedBudget);
		const entryTokens = estimateTokens(entry);
		if (current.length > 0 && currentTokens + entryTokens > boundedBudget) {
			chunks.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(entry);
		currentTokens += entryTokens;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function normalizeQuestions(questions: string[] | undefined): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const raw of questions ?? []) {
		const question = raw.trim();
		if (!question || seen.has(question)) continue;
		seen.add(question);
		normalized.push(question);
	}
	return normalized;
}

function emptyContextAnswer(locale: string): string {
	return normalizeLocale(locale) === "zh-CN"
		? "目标子代理目前没有可供 ContextAsk 读取的持久化上下文。"
		: "The target subagent does not currently have persisted context available to ContextAsk.";
}

export const contextAskService = {
	_generate: summaryGenerate,

	async ask(input: ContextAskInput): Promise<ContextAskResult> {
		const locale = normalizeLocale(input.locale);
		const questions = normalizeQuestions(input.questions);
		const target = await narratorService.getById(input.targetNarratorId);
		const snapshot = await narratorService.getContextAskHistorySnapshot(target.id);
		const entries = snapshot.messages
			.map(formatContextAskMessage)
			.filter((entry): entry is string => entry !== null);
		const previousContext = target.contextSummary?.trim() ?? "";

		if (!previousContext && entries.length === 0) {
			return {
				answer: emptyContextAnswer(locale),
				target: { id: target.id, title: target.title, status: target.status },
				questions,
				messageCount: snapshot.messages.length,
				hasMore: snapshot.hasMore,
				sourceBytes: snapshot.sourceBytes,
				sourceTruncated: snapshot.sourceTruncated,
				toolCallsTruncated: snapshot.toolCallsTruncated,
				chunkCount: 0,
			};
		}

		const systemPrompt = getPrompt("contextAsk", locale);
		const modelWindow = getSummaryModelContextWindow();
		const inputBudget = Math.max(
			CONTEXT_ASK_MIN_CHUNK_TOKENS * 2,
			Math.min(
				CONTEXT_ASK_MAX_MODEL_INPUT_TOKENS,
				Math.floor(modelWindow * CONTEXT_ASK_INPUT_RATIO),
			),
		);
		const fixedPayload = {
			requestedLocale: locale,
			target: {
				id: target.id,
				title: target.title,
				status: target.status,
				variant: target.variant,
			},
			questions,
			sourceTruncated: snapshot.sourceTruncated,
			hasMoreMessages: snapshot.hasMore,
			toolCallsTruncated: snapshot.toolCallsTruncated,
			sourceChunk: { index: 0, total: 0, messages: [] as string[] },
			accumulatedKind: "none",
			accumulatedContextOrAnswer: null as string | null,
		};
		const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(fixedPayload));
		const previousTokenBudget = Math.min(
			CONTEXT_ASK_MAX_PREVIOUS_TOKENS,
			Math.max(0, Math.floor(inputBudget * 0.2)),
		);
		const chunkTokenBudget = Math.max(
			CONTEXT_ASK_MIN_CHUNK_TOKENS,
			inputBudget - fixedTokens - previousTokenBudget - 256,
		);
		const chunks = splitContextAskEntries(entries, chunkTokenBudget);

		let accumulated = truncateToTokenBudget(previousContext, previousTokenBudget);
		let accumulatedKind = accumulated ? "persisted_context_summary" : "none";
		let contextPercent: number | undefined;
		for (let index = 0; index < chunks.length; index++) {
			if (input.signal?.aborted) {
				throw new DOMException("ContextAsk aborted", "AbortError");
			}
			const payload = {
				...fixedPayload,
				sourceChunk: {
					index: index + 1,
					total: chunks.length,
					messages: chunks[index],
				},
				accumulatedKind,
				accumulatedContextOrAnswer: truncateToTokenBudget(accumulated, previousTokenBudget) || null,
			};
			const result = await this._generate(
				JSON.stringify(payload),
				systemPrompt,
				{ narratorId: input.callerNarratorId, kind: "context_ask" },
				input.signal,
			);
			const answer = result.text?.trim();
			if (!answer) throw new Error("ContextAsk summary model returned empty output");
			accumulated = truncateMiddle(answer, CONTEXT_ASK_MAX_OUTPUT_CHARS);
			accumulatedKind = "directed_answer";
			if (typeof result.contextPercent === "number") {
				contextPercent = Math.max(contextPercent ?? 0, result.contextPercent);
			}
		}

		return {
			answer: truncateMiddle(accumulated, CONTEXT_ASK_MAX_OUTPUT_CHARS),
			target: { id: target.id, title: target.title, status: target.status },
			questions,
			messageCount: snapshot.messages.length,
			hasMore: snapshot.hasMore,
			sourceBytes: snapshot.sourceBytes,
			sourceTruncated: snapshot.sourceTruncated,
			toolCallsTruncated: snapshot.toolCallsTruncated,
			chunkCount: chunks.length,
			contextPercent,
		};
	},
};
