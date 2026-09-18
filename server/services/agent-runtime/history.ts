import { buildHistory } from "../../lib/agent";
import {
	getFileReferenceSnapshots,
	projectFileReferenceText,
} from "../../lib/agent/file-reference-projection";
import type { BuiltHistory, DbMessage } from "../../lib/agent/provider";
import { trackAgentMessageHistory } from "../agent-message-delivery";

export type RuntimeHistoryMessage = DbMessage & {
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
	const modelMessages = sourceMessages.map((message) => ({
		...message,
		...(options.profile === "subagent" ? { parentToolUseId: null } : {}),
		contentJson: Array.isArray(message.contentJson)
			? message.contentJson.map((block) =>
					block && typeof block === "object" ? { ...block } : block,
				)
			: message.contentJson,
		toolCalls: message.toolCalls?.map((call) => ({ ...call })),
	}));
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
		modelMessages,
		built.trailingUserText,
	);
	const input = options.currentInput ?? "";
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
	return {
		...built,
		sourceMessages,
		modelMessages,
		currentText: isPureToolResultReplay
			? ""
			: combined.trim()
				? combined
				: (recoveredTrailingUserText ?? combined),
		isPureToolResultReplay,
		recoveredTrailingUserText,
	};
}
