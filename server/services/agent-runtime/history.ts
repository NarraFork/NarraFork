import { modelTextFromContentBlocks } from "@shared/native-injection";
import { buildHistory } from "../../lib/agent";
import {
	getFileReferenceSnapshots,
	projectFileReferenceText,
} from "../../lib/agent/file-reference-projection";
import type { BuiltHistory } from "../../lib/agent/provider";
import {
	findCurrentSenderMessage,
	projectMessageSenderForModel,
	projectMessageSenderText,
	projectSenderText,
	type SenderMessage,
} from "../../lib/agent/sender-projection";
import { trackAgentMessageHistory } from "../agent-message-delivery";

export type RuntimeHistoryMessage = SenderMessage & {
	injectionConsumedAt?: Date | string | null;
};

export interface RuntimeHistoryOptions {
	narratorId: string;
	model: string;
	provider: string;
	/** Only the child history view drops its subtree placement; persisted ownership never changes. */
	profile: "primary" | "subagent";
	/** Already-authorized exact history page, when the caller also needs it for context preparation. */
	sourceMessages?: readonly RuntimeHistoryMessage[];
	/** Already accepted current input, with its original principal/attachment barrier. */
	currentInput?: string;
}

export interface PreparedRuntimeHistory extends BuiltHistory {
	/** Original rows for audit/context consumers; never mutated by provider projection. */
	sourceMessages: readonly RuntimeHistoryMessage[];
	/** Detached rows that entered this particular provider build and receipt candidate registration. */
	modelMessages: RuntimeHistoryMessage[];
	currentText: string;
	/** Projected caller packet only, for a subagent whose initial history is already prepared. */
	currentInputText: string;
	isPureToolResultReplay: boolean;
	recoveredTrailingUserText: string | null;
}

/** Recover only the final real user turn; neither a system injection nor a tool replay invents text. */
export function recoverRuntimeTrailingUserText(
	messages: readonly RuntimeHistoryMessage[],
): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.parentToolUseId) continue;
		if (message.role !== "user") return null;
		const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
		const text = blocks
			.filter(
				(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim(),
			)
			.map((block) => block.text as string)
			.join("\n");
		const flat = message.contentText ?? "";
		const snapshots = getFileReferenceSnapshots(blocks);
		const projected = projectFileReferenceText(
			snapshots.length ? flat || text : text || flat,
			snapshots,
		);
		return projected.trim() ? projected : null;
	}
	return null;
}

function projectCurrentInput(messages: readonly RuntimeHistoryMessage[], text: string): string {
	if (!text.trim()) return text;
	const projectMatch = (message: RuntimeHistoryMessage): string | undefined => {
		const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
		const snapshots = getFileReferenceSnapshots(blocks);
		const bodies = [message.contentText ?? "", modelTextFromContentBlocks(blocks)].map((value) =>
			projectFileReferenceText(value, snapshots),
		);
		if (bodies.includes(text)) return projectMessageSenderText(message, text);
		// Recognize only an exact server projection, never sender-like prose.
		if (bodies.some((body) => projectMessageSenderText(message, body) === text)) return text;
		return undefined;
	};
	// The accepted tail user owns current input. A same-text system hint appended
	// after acceptance must not override that author. Never search older users.
	const currentUser = findCurrentSenderMessage(messages);
	if (currentUser) {
		const projected = projectMatch(currentUser);
		if (projected !== undefined) return projected;
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.parentToolUseId || message.role === "disp" || message.role === "system") continue;
		if (message.role === "assistant" || message.role === "user") break;
		const projected = projectMatch(message);
		if (projected !== undefined) return projected;
	}
	// Unpersisted control/continuation text has no authenticated human author.
	return projectSenderText(text, { kind: "system" });
}
/** Exact authenticated receipt candidates; supply is verified later against provider input. */
export function questionModelReceipts(messages: readonly RuntimeHistoryMessage[]) {
	return messages.flatMap((message) => {
		if (message.role !== "user" || !Array.isArray(message.contentJson)) return [];
		const receipt = message.contentJson.some(
			(block) =>
				block?.type === "system_injection" &&
				block.body?.kind === "asyncQuestionAnswers" &&
				block.body.answerMessageId === message.id,
		);
		if (!receipt) return [];
		const projected = projectMessageSenderForModel(message);
		const text =
			modelTextFromContentBlocks(projected.contentJson as unknown[]) || projected.contentText || "";
		return text ? [{ id: message.id, text }] : [];
	});
}

/** Keep the live Await fallback, but replay only one full receipt once its event is in history. */
export function projectQuestionFallbackToolResults(messages: RuntimeHistoryMessage[]): void {
	const receiptIds = new Set(
		messages
			.filter(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.contentJson) &&
					message.contentJson.some(
						(block) =>
							block?.type === "system_injection" && block.body?.kind === "asyncQuestionAnswers",
					),
			)
			.map((message) => message.id),
	);
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			if (call.toolName !== "Await" || typeof call.outputJson !== "string") continue;
			const match = /^<question_answer_fallback event="([A-Za-z0-9_-]{1,100})">\n/.exec(
				call.outputJson,
			);
			if (match && receiptIds.has(match[1]))
				call.outputJson = `The user answered. Answer event: ${match[1]}. The complete receipt is present as its own user event; use Question action=get and Question action=resolve for handling.`;
		}
	}
}

/** No principal changes, attachment reads, mailbox draining, persistence or adoption happen here. */
export async function buildRuntimeHistory(
	options: RuntimeHistoryOptions,
): Promise<PreparedRuntimeHistory> {
	const sourceMessages =
		options.sourceMessages ??
		(await (
			await import("../narrator-service")
		).narratorService.getModelHistorySinceLastCompact(options.narratorId));
	// Detach mutable row arrays and block metadata, not huge text payloads,
	// so shared/COW source rows remain unchanged during provider projection.
	const modelMessages = sourceMessages
		.filter((message) => message.role !== "disp")
		.map((message) => ({
			...message,
			...(options.profile === "subagent" ? { parentToolUseId: null } : {}),
			contentJson: Array.isArray(message.contentJson)
				? message.contentJson.map((block) =>
						block && typeof block === "object" ? { ...block } : block,
					)
				: message.contentJson,
			toolCalls: message.toolCalls?.map((call) => ({ ...call })),
		}));
	// Full Await outputs remain intact until the actual provider-input boundary.
	// A builder may omit/move a user receipt (or a prebuilt child may replace
	// this history), so row presence alone is not a safe deduplication decision.
	const built = await buildHistory(
		modelMessages,
		options.model,
		options.provider,
		options.narratorId,
		{
			currentInput: options.currentInput,
		},
	);
	// The WeakMap key MUST stay the builder's actual history array. A copied array loses
	// the exact sourceHistory/adoption boundary, including edited currentRevision candidates.
	await trackAgentMessageHistory(
		options.narratorId,
		built.history,
		// Receipt guards must compare the same bytes the model receives, especially
		// grouped agent messages whose markers are inserted between item bodies.
		modelMessages.map(projectMessageSenderForModel),
		built.trailingUserText,
	);
	const input = projectCurrentInput(modelMessages, options.currentInput ?? "");
	const combined = built.trailingUserText?.trim()
		? input.trim()
			? `${built.trailingUserText}\n\n${input}`
			: built.trailingUserText
		: input;
	const isPureToolResultReplay = !combined.trim() && built.trailingToolResults.length > 0;
	const recoveredTrailingUserText =
		combined.trim() || isPureToolResultReplay
			? null
			: recoverRuntimeTrailingUserText(modelMessages);
	const recoveredMessage = findCurrentSenderMessage(modelMessages);
	const recoveredModelText =
		recoveredTrailingUserText && recoveredMessage
			? projectMessageSenderText(recoveredMessage, recoveredTrailingUserText)
			: recoveredTrailingUserText;
	return {
		...built,
		sourceMessages,
		modelMessages,
		currentInputText: input,
		currentText: isPureToolResultReplay
			? ""
			: combined.trim()
				? combined
				: (recoveredModelText ?? combined),
		isPureToolResultReplay,
		recoveredTrailingUserText,
	};
}
