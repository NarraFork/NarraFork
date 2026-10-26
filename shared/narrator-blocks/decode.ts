/**
 * Decode stored `content_json` rows into canonical envelopes
 * (docs/BLOCK_STORAGE-DESIGN.md §10.2).
 *
 * Pure and deterministic: the same row always yields the same blocks and block ids, so
 * the history projection, a later backfill and archive imports all agree. Block ids are
 * `${messageId}:${index}`, index being the first physical block the canonical block came
 * from; blocks synthesized from row-level data use a stable suffix instead.
 */

import { isBrokenToolOutput, toolOutputImages } from "../agent-protocol/tool-output";
import type { TextCitation } from "../citations";
import type { MessageOrigin } from "../message-origin";
import {
	contextBlockViews,
	injectionBlockViews,
	modelTextFromContentBlocks,
	NATIVE_MODEL_CONTEXT_BLOCK_TYPES,
} from "../native-injection";
import { getValidReasoningTranslationParts } from "../reasoning-translation";
import type {
	BlockPart,
	BlockPhase,
	CanonicalBlock,
	CanonicalEnvelope,
	ContextBlock,
	EnvelopeRole,
	ProviderMeta,
	ReasoningBlock,
	TextPart,
	ToolBlock,
	ToolChange,
	ToolOutput,
	ToolResult,
} from "./types";

/** One adopted ledger attempt per tool use, as the history loader returns them. */
export interface DecodableToolCall {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	outputJson: unknown;
	status: string;
}

/** The stored message columns the decoder reads. */
export interface DecodableMessage {
	id: string;
	narratorId?: string;
	role: EnvelopeRole;
	contentJson: unknown;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid?: string | null;
	origin?: string | null;
	provider?: string | null;
	toolCalls?: readonly DecodableToolCall[];
}

export interface DecodeOptions {
	/** The tool change a `tool_loaded` / `tool_unloaded` row carries for this request. */
	toolChangeOf?: (message: DecodableMessage) => ToolChange | undefined;
}

/** Ledger input keys that carry provider metadata rather than tool arguments. */
export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";
export const GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY = "__geminiThoughtSignatureSource";
/** Ledger rows of internal executions (Eval's reads); never part of the conversation. */
export const INTERNAL_READ_TOOL_USE_PREFIX = "internal_read_";
const INTERNAL_READ_INPUT_KEY = "__internalRead";

/** Tool calls the user started from the UI, not the model (`/bash`, manual plan mode). */
const USER_ISSUED_TOOL_USE_PREFIXES = ["toolu_bash_", "toolu_manual_"];

type RawBlock = Record<string, unknown>;

function record(value: unknown): RawBlock | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as RawBlock)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function blocksOf(message: DecodableMessage): RawBlock[] {
	if (!Array.isArray(message.contentJson)) return [];
	return message.contentJson.flatMap((block) => {
		const value = record(block);
		return value ? [value] : [];
	});
}

function parseJsonObject(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

/** Ledger input without the reserved metadata keys, plus the metadata it carried. */
export function splitToolInput(value: unknown): {
	input: unknown;
	thoughtSignature?: string;
	thoughtSignatureSource?: string;
} {
	const parsed = parseJsonObject(value);
	const input = record(parsed);
	if (!input) return { input: parsed ?? {} };
	const {
		[GEMINI_THOUGHT_SIGNATURE_KEY]: signature,
		[GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY]: source,
		[INTERNAL_READ_INPUT_KEY]: _internal,
		...args
	} = input;
	return {
		input: args,
		...(typeof signature === "string" && signature ? { thoughtSignature: signature } : {}),
		...(typeof source === "string" && source ? { thoughtSignatureSource: source } : {}),
	};
}

function isInternalCall(call: DecodableToolCall): boolean {
	if (call.toolUseId.startsWith(INTERNAL_READ_TOOL_USE_PREFIX)) return true;
	const input = record(parseJsonObject(call.inputJson));
	return !!input && INTERNAL_READ_INPUT_KEY in input;
}

function terminal(status: string): status is ToolOutput["status"] {
	return status === "success" || status === "fail";
}

/**
 * Phase and result of a local call, from its ledger attempt.
 *
 * A call whose input was invalid never ran: it is `failed`, so neither it nor its stored
 * placeholder result reaches the model (a `broken_call` notice row says why).
 */
function toolState(call: DecodableToolCall | undefined): {
	phase: BlockPhase;
	result?: ToolResult;
	output?: ToolOutput;
} {
	if (!call || !terminal(call.status)) return { phase: "open" };
	if (isBrokenToolOutput(call.outputJson)) return { phase: "failed", result: { isError: true } };
	const images = toolOutputImages(call.outputJson);
	return {
		phase: "done",
		result: {
			isError: call.status === "fail",
			...(images.length
				? {
						parts: images.map((image) => ({
							type: "image" as const,
							assetId: image.imageId,
							mediaType: image.mediaType,
							...("data" in image
								? { data: image.data }
								: { uploadNarratorId: image.uploadNarratorId }),
						})),
					}
				: {}),
		},
		output: { status: call.status, output: call.outputJson },
	};
}

function outputPhase(raw: RawBlock): BlockPhase {
	return raw.completed === false ? "aborted" : "done";
}

function textPart(text: string, citations?: unknown): TextPart {
	return Array.isArray(citations) && citations.length
		? { type: "text", text, citations: citations as TextCitation[] }
		: { type: "text", text };
}

// === Assistant steps ===

function decodeReasoning(id: string, raw: RawBlock): ReasoningBlock {
	if (raw.type === "redacted_thinking") {
		const source = string(raw.signatureSource);
		return {
			id,
			kind: "reasoning",
			ordinal: 0,
			phase: "done",
			payload: { parts: [], redacted: true },
			providerMeta: {
				...(source ? { source } : {}),
				wire: { data: string(raw.data) ?? "" },
			},
		};
	}
	const legacyThinking = raw.type === "thinking";
	const text = string(legacyThinking ? (raw.thinking ?? raw.text) : raw.text) ?? "";
	const metadata = record(raw.providerMetadata);
	const { signatureSource, ...credentials } = metadata ?? {};
	const wire: Record<string, unknown> = { ...credentials };
	if (legacyThinking && typeof raw.signature === "string") {
		wire.anthropic = { ...record(wire.anthropic), signature: raw.signature };
	}
	const source = string(signatureSource);
	const providerMeta: ProviderMeta = {
		...(source ? { source } : {}),
		...(Object.keys(wire).length ? { wire } : {}),
	};
	const openai = record(wire.openai);
	const segment = openai?.textFormat === "reasoning_text" ? "content" : undefined;
	const translated = string(raw.translatedText);
	const generation = string(raw.translationGeneration);
	const parts = getValidReasoningTranslationParts(
		text,
		generation,
		raw.translationParts as
			| import("../reasoning-translation").ReasoningTranslationPart[]
			| undefined,
	);
	const state = {
		...(translated ? { translatedText: translated } : {}),
		...(generation ? { translationGeneration: generation } : {}),
		...(parts.length ? { translationParts: parts } : {}),
	};
	return {
		id,
		kind: "reasoning",
		ordinal: 0,
		phase: outputPhase(raw),
		payload: { parts: text ? [{ type: "text", text, ...(segment ? { segment } : {}) }] : [] },
		...(Object.keys(providerMeta).length ? { providerMeta } : {}),
		...(Object.keys(state).length ? { state } : {}),
	};
}

function decodeToolUse(
	id: string,
	raw: RawBlock,
	call: DecodableToolCall | undefined,
): ToolBlock | undefined {
	const wireId = string(raw.id) ?? string(raw.toolUseId);
	if (!wireId) return undefined;
	const ledger = call ? splitToolInput(call.inputJson) : undefined;
	const blockInput = splitToolInput(raw.input);
	const signature = string(raw.thoughtSignature) ?? ledger?.thoughtSignature;
	const source = string(raw.thoughtSignatureSource) ?? ledger?.thoughtSignatureSource;
	const state = toolState(call);
	return {
		id,
		kind: "tool",
		subtype: call?.toolName || string(raw.name) || "",
		wireId,
		ordinal: 0,
		phase: state.phase,
		payload: {
			input: ledger ? ledger.input : blockInput.input,
			executor: "local",
			issuer: USER_ISSUED_TOOL_USE_PREFIXES.some((prefix) => wireId.startsWith(prefix))
				? "user"
				: "model",
			...(state.result ? { result: state.result } : {}),
		},
		...(signature
			? {
					providerMeta: {
						...(source ? { source } : {}),
						wire: { thoughtSignature: signature },
					},
				}
			: {}),
	};
}

function ledgerOnlyTool(messageId: string, call: DecodableToolCall): ToolBlock {
	const { input, thoughtSignature, thoughtSignatureSource } = splitToolInput(call.inputJson);
	const state = toolState(call);
	return {
		id: `${messageId}:call:${call.toolUseId}`,
		kind: "tool",
		subtype: call.toolName,
		wireId: call.toolUseId,
		ordinal: 0,
		phase: state.phase,
		payload: {
			input,
			executor: "local",
			issuer: "model",
			...(state.result ? { result: state.result } : {}),
		},
		...(thoughtSignature
			? {
					providerMeta: {
						...(thoughtSignatureSource ? { source: thoughtSignatureSource } : {}),
						wire: { thoughtSignature },
					},
				}
			: {}),
	};
}

function decodeProviderTool(id: string, raw: RawBlock): ToolBlock | undefined {
	const wireId = string(raw.id) ?? id;
	if (raw.type === "web_search") {
		return {
			id,
			kind: "tool",
			subtype: "web_search",
			wireId,
			ordinal: 0,
			phase: "done",
			payload: {
				input: {
					...(raw.query !== undefined ? { query: raw.query } : {}),
					...(raw.queries !== undefined ? { queries: raw.queries } : {}),
					...(raw.action !== undefined ? { action: raw.action } : {}),
				},
				executor: "provider",
				issuer: "model",
				result: {},
			},
		};
	}
	const result: Record<string, unknown> = {};
	for (const key of ["revisedPrompt", "savedPath", "width", "height", "result"]) {
		if (raw[key] !== undefined) result[key] = raw[key];
	}
	return {
		id,
		kind: "tool",
		subtype: "image_generation",
		wireId,
		ordinal: 0,
		phase: "done",
		payload: { input: {}, executor: "provider", issuer: "model", result: {} },
		providerMeta: { result },
	};
}

function decodeAssistant(message: DecodableMessage): {
	blocks: CanonicalBlock[];
	toolOutputs: Record<string, ToolOutput>;
} {
	const raws = blocksOf(message);
	const calls = new Map<string, DecodableToolCall>();
	for (const call of message.toolCalls ?? []) {
		if (call.toolUseId && !isInternalCall(call)) calls.set(call.toolUseId, call);
	}
	const toolOutputs: Record<string, ToolOutput> = {};
	const consumed = new Set<string>();
	const blocks: CanonicalBlock[] = [];
	raws.forEach((raw, index) => {
		const id = `${message.id}:${index}`;
		switch (raw.type) {
			case "text": {
				const text = string(raw.text) ?? "";
				blocks.push({
					id,
					kind: "output",
					ordinal: 0,
					phase: outputPhase(raw),
					payload: { parts: [textPart(text, raw.citations)] },
				});
				return;
			}
			case "reasoning":
			case "thinking":
			case "redacted_thinking":
				blocks.push(decodeReasoning(id, raw));
				return;
			case "tool_use": {
				const wireId = string(raw.id) ?? string(raw.toolUseId);
				const call = wireId ? calls.get(wireId) : undefined;
				const block = decodeToolUse(id, raw, call);
				if (!block) return;
				consumed.add(block.wireId);
				const output = toolState(call).output;
				if (output) toolOutputs[block.wireId] = output;
				blocks.push(block);
				return;
			}
			case "web_search":
			case "image_generation": {
				const block = decodeProviderTool(id, raw);
				if (block) blocks.push(block);
				return;
			}
			default:
				// `/bash`'s display-only tool_result and unknown blocks carry nothing for the model.
				return;
		}
	});
	// Rows whose text only lives in the flat column (older rows, edits) keep it ahead
	// of the first tool call, where the model originally wrote it.
	if (!raws.some((raw) => raw.type === "text") && message.contentText) {
		const at = blocks.findIndex((block) => block.kind === "tool");
		const fallback: CanonicalBlock = {
			id: `${message.id}:text`,
			kind: "output",
			ordinal: 0,
			phase: "done",
			payload: { parts: [{ type: "text", text: message.contentText }] },
		};
		blocks.splice(at >= 0 ? at : blocks.length, 0, fallback);
	}
	// Older rows only recorded the call in the ledger.
	for (const call of calls.values()) {
		if (consumed.has(call.toolUseId)) continue;
		blocks.push(ledgerOnlyTool(message.id, call));
		const output = toolState(call).output;
		if (output) toolOutputs[call.toolUseId] = output;
	}
	blocks.forEach((block, ordinal) => {
		block.ordinal = ordinal;
	});
	return { blocks, toolOutputs };
}

// === Single-block envelopes ===

const COMPACT_SUBTYPES = new Set(["plan", "clear_context"]);

function compactPhase(status: unknown): BlockPhase {
	return status === "compacting" ? "open" : status === "failed" ? "failed" : "done";
}

function contextBlock(
	message: DecodableMessage,
	subtype: string,
	modelText: string | null,
	extra: Partial<ContextBlock> = {},
): ContextBlock {
	return {
		id: `${message.id}:0`,
		kind: "context",
		subtype,
		ordinal: 0,
		phase: "done",
		payload: {},
		modelText: modelText || null,
		...extra,
	};
}

function cardBody(raw: RawBlock, omit: readonly string[] = []): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "type" || key === "modelText" || omit.includes(key)) continue;
		body[key] = value;
	}
	return body;
}

function decodeControl(message: DecodableMessage, raws: RawBlock[]): ContextBlock {
	const first = raws[0];
	if (first?.type === "compact") {
		const subtype =
			typeof first.subtype === "string" && COMPACT_SUBTYPES.has(first.subtype)
				? first.subtype
				: first.status === "compacted" && first.summary === "" && first.subtype === undefined
					? "clear_context"
					: "compact";
		const state: Record<string, unknown> = {};
		for (const key of ["attempts", "mode", "error"]) {
			if (first[key] !== undefined) state[key] = first[key];
		}
		return contextBlock(message, subtype, null, {
			phase: compactPhase(first.status),
			payload: { body: cardBody(first, ["status", "attempts", "mode", "error", "subtype"]) },
			...(Object.keys(state).length ? { state } : {}),
		});
	}
	const subtype =
		first && typeof first.type === "string"
			? first.type === "text" && record(first.publicationResult)
				? "publication_result"
				: first.type === "text"
					? "info"
					: first.type
			: "info";
	const state: Record<string, unknown> = {};
	if (first?.status !== undefined) state.status = first.status;
	return contextBlock(message, subtype, null, {
		payload: first ? { body: cardBody(first, ["status"]) } : {},
		...(Object.keys(state).length ? { state } : {}),
	});
}

function inputParts(raws: RawBlock[]): BlockPart[] {
	return raws.flatMap((raw): BlockPart[] => {
		switch (raw.type) {
			case "text":
				return [{ type: "text", text: string(raw.text) ?? "" }];
			case "image": {
				const assetId = string(raw.imageId);
				if (!assetId) return [];
				return [
					{
						type: "image",
						assetId,
						...(string(raw.mediaType) ? { mediaType: string(raw.mediaType) } : {}),
						...(string(raw.filename) ? { name: string(raw.filename) } : {}),
						...(number(raw.size) !== undefined ? { size: number(raw.size) } : {}),
						...(string(raw.sourceMimeType) ? { sourceMimeType: string(raw.sourceMimeType) } : {}),
						...(number(raw.width) !== undefined ? { width: number(raw.width) } : {}),
						...(number(raw.height) !== undefined ? { height: number(raw.height) } : {}),
						...(string(raw.uploadNarratorId)
							? { uploadNarratorId: string(raw.uploadNarratorId) }
							: {}),
						...(string(raw.data) ? { data: string(raw.data) } : {}),
					},
				];
			}
			case "text_file":
				return [
					{
						type: "file",
						name: string(raw.filename) ?? string(raw.name) ?? "",
						...(number(raw.size) !== undefined ? { size: number(raw.size) } : {}),
						...(string(raw.filePath) ? { filePath: string(raw.filePath) } : {}),
						...(string(raw.fileId) ? { fileId: string(raw.fileId) } : {}),
					},
				];
			case "file_reference": {
				const reference = record(raw.reference);
				if (!reference) return [];
				return [
					{
						type: "file_ref",
						reference: reference as unknown as import("../file-reference").FileReference,
						snapshotText: string(raw.snapshotText) ?? "",
						snapshotHash: string(raw.snapshotHash) ?? "",
						capturedAt: string(raw.capturedAt) ?? "",
					},
				];
			}
			default:
				return [];
		}
	});
}

const NATIVE_CARD_TYPES = new Set<string>(NATIVE_MODEL_CONTEXT_BLOCK_TYPES);

function decodeInputOrContext(message: DecodableMessage, raws: RawBlock[]): CanonicalBlock {
	const first = raws[0];
	const flat = message.contentText ?? "";
	const blockText = modelTextFromContentBlocks(raws);

	if (first?.type === "tool_loaded" || first?.type === "tool_unloaded") {
		return contextBlock(message, first.type, string(first.text) || flat, {
			payload: { body: cardBody(first, ["text"]) },
		});
	}
	if (first?.type === "segment_compact") {
		const phase = compactPhase(first.status);
		return contextBlock(message, "segment_compact", phase === "done" ? flat : null, {
			phase,
			payload: { body: cardBody(first, ["status", "error"]) },
			...(first.error !== undefined ? { state: { error: first.error } } : {}),
		});
	}
	if (first?.type === "bash_command") {
		const command = string(first.command) ?? "";
		return {
			id: `${message.id}:0`,
			kind: "input",
			subtype: "bash_command",
			ordinal: 0,
			phase: "done",
			payload: { parts: [{ type: "text", text: command }] },
			modelText: flat || command || null,
		};
	}
	const review = raws.find((raw) => raw.type === "review_feedback");
	if (review) {
		const applied = review.applied;
		return contextBlock(message, "review_feedback", blockText || flat, {
			payload: { body: cardBody(review, ["applied"]) },
			...(applied !== undefined ? { state: { applied } } : {}),
		});
	}
	// A subagent's received input carries its sender in an injection without model text;
	// it is still that agent's input, not a system injection.
	const injections = injectionBlockViews(raws);
	const subagentInput =
		message.role === "user" &&
		injections.length > 0 &&
		injections.every(
			(view) =>
				view.block.source === "subagent_message" && raws[view.blockIndex]?.modelText === undefined,
		);
	if (injections.length > 0 && !subagentInput) {
		const view = injections[0];
		return contextBlock(message, "system_injection", blockText || flat, {
			payload: {
				body: {
					source: view.block.source,
					...(view.block.body ? { body: view.block.body } : {}),
				},
			},
		});
	}
	const cards = contextBlockViews(raws);
	if (cards.length > 0) {
		const card = cards[0].block as RawBlock;
		const state: Record<string, unknown> = {};
		if (card.isLatest !== undefined) state.isLatest = card.isLatest;
		return contextBlock(message, String(card.type), blockText || flat, {
			payload: { body: cardBody(card, ["isLatest"]) },
			...(Object.keys(state).length ? { state } : {}),
		});
	}
	if (first && NATIVE_CARD_TYPES.has(String(first.type))) {
		return contextBlock(message, String(first.type), blockText || flat, {
			payload: { body: cardBody(first) },
		});
	}
	const onlyText = raws.every((raw) => raw.type === "text");
	if (message.role === "sys" || (message.origin === "system" && onlyText)) {
		return contextBlock(message, "system_text", blockText || flat);
	}
	return {
		id: `${message.id}:0`,
		kind: "input",
		ordinal: 0,
		phase: "done",
		payload: { parts: inputParts(raws) },
		modelText: blockText || flat || null,
	};
}

/** Decode one stored row into its canonical envelope. */
export function decodeLegacyContent(
	message: DecodableMessage,
	options: DecodeOptions = {},
): CanonicalEnvelope {
	const envelope: CanonicalEnvelope = {
		id: message.id,
		...(message.narratorId ? { narratorId: message.narratorId } : {}),
		role: message.role,
		origin: (message.origin as MessageOrigin | null | undefined) ?? null,
		parentToolUseId: message.parentToolUseId,
		...(message.provider !== undefined ? { provider: message.provider } : {}),
		blocks: [],
	};
	if (message.role === "assistant") {
		const { blocks, toolOutputs } = decodeAssistant(message);
		envelope.blocks = blocks;
		if (message.messageUuid) envelope.upstreamMessageId = message.messageUuid;
		if (Object.keys(toolOutputs).length) envelope.toolOutputs = toolOutputs;
		return envelope;
	}
	const raws = blocksOf(message);
	const block =
		message.role === "system" || message.role === "disp"
			? decodeControl(message, raws)
			: decodeInputOrContext(message, raws);
	if (block.kind === "context" && options.toolChangeOf) {
		const change = options.toolChangeOf(message);
		if (change) block.toolChange = change;
	}
	envelope.blocks = [block];
	return envelope;
}
