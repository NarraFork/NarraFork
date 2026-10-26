import { modelTextFromContentBlocks } from "@shared/native-injection";
import { buildHistory, resolveHistoryToolLoadingStrategy } from "../../lib/agent";
import { projectAttachmentLocations } from "../../lib/agent/attachment-projection";
import {
	getFileReferenceSnapshots,
	projectFileReferenceText,
} from "../../lib/agent/file-reference-projection";
import { historyTail } from "../../lib/agent/history-build";
import type { BuiltHistory } from "../../lib/agent/provider";
import {
	findCurrentSenderMessage,
	projectMessageSenderForModel,
	projectMessageSenderText,
	projectSenderText,
	type SenderMessage,
} from "../../lib/agent/sender-projection";
import {
	deriveToolLoadingState,
	projectToolLoadingHistory,
	resolveLoadableToolDefinition,
	type ToolLoadingEpoch,
	type ToolLoadingState,
	usesToolLoading,
} from "../../lib/agent/tool-loading";
import type { ToolDefinition } from "../../lib/agent/types";
import { isTopLevelMessage, type OwnTurnPlacement } from "../../lib/runtime-source";
import { trackAgentMessageHistory } from "../agent-message-delivery";

export type RuntimeHistoryMessage = SenderMessage & {
	injectionConsumedAt?: Date | string | null;
};

/** The one "top-level message" rule; defined beside the placement it reads. */
export { isTopLevelMessage } from "../../lib/runtime-source";

export interface RuntimeHistoryOptions {
	narratorId: string;
	model: string;
	provider: string;
	/**
	 * Explicit own transcript placement. Its placement is dropped for the
	 * model view only; persisted ownership never changes. Omitted: read the session's
	 * durable historical placement, falling back to its live run destination.
	 */
	ownTurnPlacement?: OwnTurnPlacement;
	/** Already-authorized exact history page, when the caller also needs it for context preparation. */
	sourceMessages?: readonly RuntimeHistoryMessage[];
	/** Already accepted current input, with its original principal/attachment barrier. */
	currentInput?: string;
	/** Explicit server-local cwd only; never a remote workspace path. */
	attachmentCwd?: string;
	attachmentSignal?: AbortSignal;
	/** Shared deadline, including source reads and provider projection. */
	deadline?: number;
	/**
	 * Optional tools whose presence follows session loading, and the currently loaded
	 * ones. When set, loads inside the history keep the request's tool array fixed.
	 */
	toolLoading?: {
		managed: ReadonlySet<string>;
		current: Iterable<string>;
		/** The request's already-materialized registry candidates; never re-read the registry. */
		candidates?: readonly ToolDefinition[];
		/** A reconciled epoch. Property presence suppresses the legacy compact query, even if empty. */
		epoch?: ToolLoadingEpoch;
	};
}

export interface PreparedRuntimeHistory extends BuiltHistory {
	/** Provenance reported by the actual provider builder, never inferred from DB row presence. */
	replayedInjectionMessageIds: readonly string[];
	/** Original rows for audit/context consumers; never mutated by provider projection. */
	sourceMessages: readonly RuntimeHistoryMessage[];
	/** Detached rows that entered this particular provider build and receipt candidate registration. */
	modelMessages: RuntimeHistoryMessage[];
	/** Current input no persisted row carries; empty when `history` already holds it. */
	currentText: string;
	/** Projected caller packet only, for a subagent whose initial history is already prepared. */
	currentInputText: string;
	/** Whether a persisted row (now part of `history`) carries the current input. */
	currentInputPersisted: boolean;
	/** Whether the history ends with tool results the model has not answered yet. */
	endsWithToolResults: boolean;
	/** Whether the history ends with input of any kind (a user or sys row, or tool results). */
	endsWithInput: boolean;
	/** Loading state of this history; the loop derives the tool array from it. */
	toolLoading?: ToolLoadingState;
	/** Full request candidates from the same registry view as `toolLoading`. */
	toolCandidates?: readonly ToolDefinition[];
}

/**
 * The current input as the model reads it, and whether a persisted row already carries
 * it. A persisted input is part of the projected history; only unpersisted control or
 * continuation text still travels as the request's separate current content.
 */
function projectCurrentInput(
	messages: readonly RuntimeHistoryMessage[],
	text: string,
): { text: string; persisted: boolean } {
	if (!text.trim()) {
		// No prompt (a restart or recovery): the accepted tail user, if any, is the input.
		const accepted = findCurrentSenderMessage(messages);
		if (!accepted) return { text: "", persisted: true };
		const blocks = Array.isArray(accepted.contentJson) ? accepted.contentJson : [];
		const snapshots = getFileReferenceSnapshots(blocks);
		const flat = accepted.contentText ?? "";
		const blockText = modelTextFromContentBlocks(blocks);
		const body = projectFileReferenceText(
			snapshots.length ? flat || blockText : blockText || flat,
			snapshots,
		);
		return { text: body.trim() ? projectMessageSenderText(accepted, body) : "", persisted: true };
	}
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
		if (projected !== undefined) return { text: projected, persisted: true };
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		// Model projection: own turns have no placement left (see isTopLevelMessage).
		if (message.parentToolUseId || message.role === "disp" || message.role === "system") continue;
		if (message.role === "assistant" || message.role === "user") break;
		const projected = projectMatch(message);
		if (projected !== undefined) return { text: projected, persisted: true };
	}
	// Unpersisted control/continuation text has no authenticated human author.
	return { text: projectSenderText(text, { kind: "system" }), persisted: false };
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

/** No principal changes, mailbox draining or persistence; attachment copies require explicit cwd. */
export async function buildRuntimeHistory(
	options: RuntimeHistoryOptions,
): Promise<PreparedRuntimeHistory> {
	const deadline = Math.min(options.deadline ?? Number.POSITIVE_INFINITY, Date.now() + 10_000);
	const checkBudget = () => {
		options.attachmentSignal?.throwIfAborted();
		if (Date.now() >= deadline) throw new Error("Model history preparation exceeded 10s budget");
	};
	checkBudget();
	const sourceMessages =
		options.sourceMessages ??
		(await (
			await import("../narrator-service")
		).narratorService.getModelHistorySinceLastCompact(options.narratorId, undefined, {
			signal: options.attachmentSignal,
			deadline,
		}));
	checkBudget();
	const ownPlacement =
		options.ownTurnPlacement !== undefined
			? options.ownTurnPlacement
			: await (await import("../narrator-session")).readSessionOwnTurnPlacement(options.narratorId);
	checkBudget();
	// Detach mutable row arrays and block metadata, not huge text payloads,
	// so shared/COW source rows remain unchanged during provider projection.
	let modelMessages = sourceMessages
		.filter((message) => message.role !== "disp")
		.map((message) => ({
			...message,
			// Historical mounting is not nesting, even when no live run delivers there.
			...(isTopLevelMessage(message, ownPlacement) ? { parentToolUseId: null } : {}),
			contentJson: Array.isArray(message.contentJson)
				? message.contentJson.map((block) =>
						block && typeof block === "object" ? { ...block } : block,
					)
				: message.contentJson,
			toolCalls: message.toolCalls?.map((call) => ({ ...call })),
		}));
	let currentInput = options.currentInput;
	if (options.attachmentCwd) {
		const prepared = await projectAttachmentLocations(modelMessages, {
			cwd: options.attachmentCwd,
			narratorId: options.narratorId,
			currentInput,
			signal: options.attachmentSignal,
		});
		modelMessages = prepared.messages;
		currentInput = prepared.currentInput;
	}
	checkBudget();
	const loading = options.toolLoading;
	const epoch = loading
		? Object.hasOwn(loading, "epoch")
			? loading.epoch
			: loading.managed.size
				? await (await import("../narrator-epochs")).toolLoadingEpochOf(
						options.narratorId,
						modelMessages,
					)
				: undefined
		: undefined;
	const toolLoadingState = loading
		? deriveToolLoadingState(
				// No managed tool means no events to derive; do not scan the history at all.
				loading.managed.size ? modelMessages : [],
				loading.managed,
				loading.current,
				epoch,
			)
		: undefined;
	const toolLoadingStrategy = usesToolLoading(toolLoadingState)
		? resolveHistoryToolLoadingStrategy(options.model, options.provider)
		: undefined;
	// Injected schemas are plain notice text, so they are written here: the receipt guards
	// and a notice recovered as the current turn then carry the same bytes as a rebuild.
	if (toolLoadingState && toolLoadingStrategy === "custom_injection") {
		const candidates = loading?.candidates;
		const byName = candidates ? new Map(candidates.map((tool) => [tool.name, tool])) : undefined;
		const resolveDefinition = (name: string) => {
			if (!byName) return resolveLoadableToolDefinition(name);
			const tool = byName.get(name);
			if (!tool || (tool.isAvailable && !tool.isAvailable())) return null;
			if (typeof tool.description !== "string" || tool.getRawJsonSchema) return null;
			return { ...tool, description: tool.description };
		};
		modelMessages = projectToolLoadingHistory(
			modelMessages,
			toolLoadingState,
			toolLoadingStrategy,
			resolveDefinition,
		) as typeof modelMessages;
	}
	// Full Await outputs remain intact until the actual provider-input boundary.
	// A builder may omit/move a user receipt (or a prebuilt child may replace
	// this history), so row presence alone is not a safe deduplication decision.
	const built = await buildHistory(
		modelMessages,
		options.model,
		options.provider,
		options.narratorId,
		{
			// The current input row, when persisted, is part of this history with its
			// referenced files; nothing is withheld for a separate current turn.
			...(toolLoadingState && toolLoadingStrategy && toolLoadingStrategy !== "custom_injection"
				? { toolLoading: { state: toolLoadingState, strategy: toolLoadingStrategy } }
				: {}),
		},
	);
	checkBudget();
	// The WeakMap key MUST stay the builder's actual history array. A copied array loses
	// the exact sourceHistory/adoption boundary, including edited currentRevision candidates.
	await trackAgentMessageHistory(
		options.narratorId,
		built.history,
		// Receipt guards must compare the same bytes the model receives, especially
		// grouped agent messages whose markers are inserted between item bodies.
		modelMessages.map(projectMessageSenderForModel),
	);
	// The history carries every persisted row, the current input included; only text no
	// row holds is still sent as the request's current content.
	const current = projectCurrentInput(modelMessages, currentInput ?? "");
	const tail = historyTail(modelMessages);
	return {
		...built,
		replayedInjectionMessageIds: built.replayedInjectionMessageIds ?? [],
		sourceMessages,
		modelMessages,
		currentInputText: current.text,
		currentText: current.persisted ? "" : current.text,
		currentInputPersisted: current.persisted,
		endsWithToolResults: tail.toolResults,
		endsWithInput: tail.input,
		...(toolLoadingState ? { toolLoading: toolLoadingState } : {}),
		...(loading?.candidates ? { toolCandidates: loading.candidates } : {}),
	};
}
