import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const CONTEXT_ASK_MAX_QUESTIONS = 8;
const CONTEXT_ASK_MAX_QUESTION_CHARS = 2_000;
const CONTEXT_ASK_MAX_TOTAL_QUESTION_CHARS = 8_000;

function formatSourceWarning(locale: string, hasMore: boolean): string {
	if (locale === "zh-CN") {
		return hasMore
			? "注意：目标历史超过 ContextAsk 的安全读取上限，较早的消息未纳入本次回答。"
			: "注意：目标上下文中的部分超长消息或工具输入/输出已按安全上限截断。";
	}
	return hasMore
		? "Note: the target history exceeded ContextAsk's safety limit, so older messages were not included."
		: "Note: some oversized messages or tool inputs/outputs were truncated at ContextAsk safety limits.";
}

export const contextAskTool: ToolDefinition = {
	name: "ContextAsk",
	description:
		"Ask the configured summary model one or more targeted questions about an accessible " +
		"subagent's persisted context. Primary narrators may query their child subagents; subagents " +
		"may query siblings in the same team. This is read-only: it does not Send a message, wake, " +
		"interrupt, or otherwise modify the target's context. Use ContextAsk when you only need " +
		"information already present in another subagent's context; use Send only to deliver new " +
		"information, requirements, or corrections. Omit questions to request a focused status summary. " +
		"Independent lookups against different subagents can be issued as consecutive calls in the " +
		"same turn — they run in parallel.",
	parameters: z.object({
		id: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.describe("Target subagent ID, task alias, title, or unique ID prefix."),
		questions: z
			.array(z.string().trim().min(1).max(CONTEXT_ASK_MAX_QUESTION_CHARS))
			.max(CONTEXT_ASK_MAX_QUESTIONS)
			.optional()
			.describe(
				"Questions to answer from the target's persisted context, in order. Omit or pass an empty array for a focused status summary.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as { id?: string; questions?: string[] };
		const id = raw.id?.trim();
		if (!id) return { output: "ContextAsk error: id is required.", isError: true };

		const questions = (raw.questions ?? []).map((question) => question.trim()).filter(Boolean);
		if (questions.length > CONTEXT_ASK_MAX_QUESTIONS) {
			return {
				output: `ContextAsk error: at most ${CONTEXT_ASK_MAX_QUESTIONS} questions are allowed.`,
				isError: true,
			};
		}
		if (questions.some((question) => question.length > CONTEXT_ASK_MAX_QUESTION_CHARS)) {
			return {
				output: `ContextAsk error: each question must be at most ${CONTEXT_ASK_MAX_QUESTION_CHARS} characters.`,
				isError: true,
			};
		}
		const totalQuestionChars = questions.reduce((sum, question) => sum + question.length, 0);
		if (totalQuestionChars > CONTEXT_ASK_MAX_TOTAL_QUESTION_CHARS) {
			return {
				output: `ContextAsk error: questions may contain at most ${CONTEXT_ASK_MAX_TOTAL_QUESTION_CHARS} characters in total.`,
				isError: true,
			};
		}

		try {
			const { resolveSubagentTargets } = await import("@server/services/agent-communication");
			const targets = await resolveSubagentTargets({ callerNarratorId: ctx.narratorId, id });
			if (targets.length !== 1) {
				throw new Error("ContextAsk requires exactly one accessible subagent target");
			}
			const target = targets[0];
			const { contextAskService } = await import("@server/services/context-ask-service");
			// Reuse the tool_output channel to stream a live character counter.
			// The executor wires ctx.emitOutput (throttled) for every tool; we
			// send the raw cumulative count and let the UI render the label.
			const emitOutput = ctx.emitOutput;
			const result = await contextAskService.ask({
				callerNarratorId: ctx.narratorId,
				targetNarratorId: target.id,
				questions,
				locale: ctx.locale,
				userId: ctx.userId,
				signal: ctx.signal,
				...(emitOutput
					? { onProgress: (totalOutputChars: number) => emitOutput(String(totalOutputChars)) }
					: {}),
			});
			const { agentLabelFromNarrator } = await import("@server/services/subagent-label");
			// `target` is the resolved narrator row, so the alias fallback is free.
			const targetLabel =
				result.target.title?.trim() ||
				agentLabelFromNarrator(target, ctx.parentNarratorId ?? ctx.narratorId);
			const heading =
				ctx.locale === "zh-CN"
					? `ContextAsk（${targetLabel}）结果：`
					: `ContextAsk result for ${targetLabel}:`;
			const warning = result.sourceTruncated
				? `\n\n${formatSourceWarning(ctx.locale, result.hasMore)}`
				: "";
			return {
				output: `${heading}\n\n${result.answer}${warning}`,
				title: `ContextAsk: ${targetLabel}`,
				metadata: {
					kind: "context_ask",
					target: result.target,
					questions: result.questions,
					messageCount: result.messageCount,
					hasMore: result.hasMore,
					sourceBytes: result.sourceBytes,
					sourceTruncated: result.sourceTruncated,
					toolCallsTruncated: result.toolCallsTruncated,
					chunkCount: result.chunkCount,
					contextPercent: result.contextPercent,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { output: `ContextAsk error: ${message}`, isError: true };
		}
	},
};
