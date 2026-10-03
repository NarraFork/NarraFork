import {
	appendSourceText,
	createSourceText,
	nextSourceEpoch,
	reconcileSourceText,
	type SourceTextRange,
	type SourceTextSnapshot,
	safeSourceSliceStart,
} from "@shared/pretext-layout/source-text";
import type { ToolProgressPayload } from "@shared/tool-progress";
import type { SubagentActivitySummary, TreeMessage } from "../../lib/api";
import {
	findMsgByToolUseIdInTree,
	normalizeSubagentModel,
	normalizeSubagentReasoningEffort,
	upsertStreamingToolBlock,
} from "./message/message-tree-utils";
import type { ContentBlock, NarratorMsg } from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { isSpecTasksToolUse } from "./tool-call/tool-display";

/**
 * Reflection parsing lives in `@shared/pretext-layout/reflection` so the chunked
 * path here and the exact vlist's MEASURE layer read the gate through one parser.
 * The measure layer needs it because a reflection notice must get an exact
 * arithmetic height at layout time — measuring the real component after paint
 * shifted every row below it without any user action.
 */
export {
	ACTIVE_REFLECTION_STATUSES,
	getPermissionReflectionSuggestion,
	getReflectionSuggestion,
	isActiveReflectionPermissionLike,
	isReflectionPermissionLike,
	normalizeReflectionAfterToolStatus,
	type ReflectionKind,
	type ReflectionStatus,
	type ReflectionSuggestion,
} from "@shared/pretext-layout/reflection";

// Re-export functions that moved to message-segments.ts for backward compatibility
export {
	filterChildrenByToolUse,
	hasToolUse,
	isToolOnlyMessage,
	resolveAllToolCallsFromMsg,
} from "./message/message-segments";

export function revokeContentBlockPreviewUrls(
	blocks: Array<{ previewUrl?: unknown }> | null | undefined,
): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block?.previewUrl === "string") {
			URL.revokeObjectURL(block.previewUrl);
		}
	}
}

const STREAMING_TEXT_PREVIEW_MAX_CHARS = 120_000;

/**
 * Append a streaming text delta to an accumulated preview, capping the total
 * length so a runaway stream cannot grow an unbounded string in memory (keeps
 * the most recent tail). Shared by both the legacy panel WS path and the chunk
 * data layer so they stay byte-for-byte identical.
 */
export function appendStreamingTextPreview(current: string, delta: string): string {
	const next = current + delta;
	if (next.length <= STREAMING_TEXT_PREVIEW_MAX_CHARS) return next;
	return next.slice(-STREAMING_TEXT_PREVIEW_MAX_CHARS);
}

// --- Streaming tool output / field preview bounds ------------------------------
// Shared by the legacy panel WS path and the chunk data layer so the live
// (untruncated) tool output / streaming-field previews stay byte-for-byte
// identical between the two list implementations.

export const STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS = 16_000;
export const STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS = 16_000;

interface TruncatedToolOutput {
	_truncated: true;
	preview: string;
	fullLength: number;
}

function isTruncatedToolOutput(value: unknown): value is TruncatedToolOutput {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { _truncated?: unknown })._truncated === true &&
		typeof (value as { preview?: unknown }).preview === "string" &&
		typeof (value as { fullLength?: unknown }).fullLength === "number"
	);
}

/**
 * When a tool completes with a truncated output payload but we streamed the
 * complete response live, promote the streamed string into the persisted cache
 * instead of replacing it with the (much shorter) final preview.
 *
 * TWO PAYLOAD SHAPES
 *
 * Truncation is FIELD-LEVEL, so `completedOutput` arrives in one of two forms:
 *
 *   - a bare string output → the whole payload IS the truncated leaf (the common
 *     case, and the only one the original version handled), or
 *   - `{_text, _metadata}` → only `_text` is the leaf, and `_metadata` must be
 *     preserved alongside it.
 *
 * The second shape used to fail SILENTLY: a root-level `_truncated` probe returned
 * false, so the complete streamed output was discarded and the card fell back to
 * the short preview. The wrapper shape never changed, so no type error flagged it.
 *
 * Only the OUTPUT BODY can be restored this way — `streamedOutput` is that body
 * and nothing else — so a payload whose truncated leaf is some other field is left
 * untouched.
 */
export function preserveCompleteStreamedOutput(
	completedOutput: unknown,
	streamedOutput?: string,
): { output: unknown; preserved: boolean } {
	if (typeof streamedOutput !== "string") {
		return { output: completedOutput, preserved: false };
	}
	// Shape 1: the payload itself is the truncated leaf.
	if (isTruncatedToolOutput(completedOutput)) {
		if (streamedOutput.length < completedOutput.fullLength) {
			return { output: completedOutput, preserved: false };
		}
		return { output: streamedOutput.slice(0, completedOutput.fullLength), preserved: true };
	}
	// Shape 2: `{_text, _metadata}` with a truncated `_text` leaf. Restoring it in
	// place keeps every sibling field (notably `_metadata`, which drives the
	// structured cards) rather than flattening the payload to a string.
	if (completedOutput && typeof completedOutput === "object" && !Array.isArray(completedOutput)) {
		const record = completedOutput as Record<string, unknown>;
		const textLeaf = record._text;
		if (isTruncatedToolOutput(textLeaf)) {
			if (streamedOutput.length < textLeaf.fullLength) {
				return { output: completedOutput, preserved: false };
			}
			return {
				output: { ...record, _text: streamedOutput.slice(0, textLeaf.fullLength) },
				preserved: true,
			};
		}
	}
	return { output: completedOutput, preserved: false };
}

/** Keep only the trailing window of a streamed tool output preview. */
export function getToolOutputPreview(output: string): string {
	if (output.length <= STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS) return output;
	return output.slice(
		safeSourceSliceStart(output, output.length - STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS),
	);
}

/** Keep only the trailing window of a streamed tool field preview. */
export function getStreamingFieldPreview(value: string): string {
	if (value.length <= STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS) return value;
	return value.slice(
		safeSourceSliceStart(value, value.length - STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS),
	);
}

/**
 * A top-level streaming-tool chunk accumulator entry. While a tool is streaming
 * its input we render a shimmer indicator; once promoted (`_started`) we render
 * a real tool-call card with the resolved input/status/output.
 */
export interface TopLevelStreamingChunk {
	/** Full Write content lives in the document store, never this hot model. */
	textDocument?: import("@shared/pretext-layout/text-document").TextDocumentRef;
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	streamingFieldName?: string;
	streamingFieldValue?: string;
	/** Kept after a field finishes and after the tool starts/completes. */
	streamingFieldRanges?: Record<string, SourceTextRange>;
	// Sentinel fields set once the tool is promoted to started/completed.
	_started?: boolean;
	_input?: Record<string, unknown>;
	_status?: string;
	_startedAt?: number;
	_output?: unknown;
	_durationMs?: number;
	_metadata?: Record<string, unknown>;
	_longRunning?: boolean;
	_streamedFullOutput?: boolean;
	_streamingOutput?: string;
	/** Latest determinate progress measurement (drives a real progress bar). */
	_structuredProgress?: ToolProgressPayload;
	_sendDeliveryTargets?: import("@shared/communication-tool").SendDeliveryTarget[];
	_sendDeliveryTargetCount?: number;
	_sendDeliveryBinding?: { toolCallId: string; attempt: number };
}

function streamingFieldSource(
	chunk: TopLevelStreamingChunk | undefined,
	name: string,
): SourceTextSnapshot | undefined {
	const range = chunk?.streamingFieldRanges?.[name];
	const text =
		typeof chunk?._input?.[name] === "string"
			? chunk._input[name]
			: chunk?.streamingFieldName === name
				? chunk.streamingFieldValue
				: chunk?.extractedFields?.[name];
	if (typeof text !== "string" || !chunk) return undefined;
	return range
		? { text, range }
		: createSourceText(text, {
				epoch: `${chunk.toolUseId}:${name}`,
				originKnown: typeof chunk._input?.[name] === "string",
				complete: typeof chunk._input?.[name] === "string",
			});
}

/** Shared fold: retain completed fields and advance coordinates only by deltas. */
export function foldStreamingToolFields(
	previous: TopLevelStreamingChunk | undefined,
	event: {
		toolUseId: string;
		inputCharsTotal: number;
		extractedFields?: Record<string, string>;
		streamingField?: { name: string; delta: string; startsField?: boolean };
		inputDocument?: import("@shared/pretext-layout/text-document").TextDocumentStreamUpdate;
	},
): Pick<
	TopLevelStreamingChunk,
	"streamingFieldName" | "streamingFieldValue" | "streamingFieldRanges" | "extractedFields"
> {
	// Descriptor-backed Write.content never enters the legacy 16k tail accumulator.
	if (event.inputDocument || previous?.textDocument) {
		const fields = { ...previous?.extractedFields, ...event.extractedFields };
		delete fields.content;
		const name = event.streamingField?.name;
		if (!name || name === "content")
			return {
				extractedFields: fields,
				streamingFieldName: "content",
				streamingFieldValue:
					event.inputDocument?.ref.preview ?? previous?.textDocument?.preview ?? "",
			};
	}
	const fields = { ...previous?.extractedFields };
	const ranges = { ...previous?.streamingFieldRanges };
	let name = previous?.streamingFieldName;
	let value = previous?.streamingFieldValue;
	const discontinuous = previous !== undefined && event.inputCharsTotal < previous.inputCharsTotal;
	if (name !== undefined && value !== undefined && event.streamingField?.name !== name)
		fields[name] = value;
	for (const [field, text] of Object.entries(event.extractedFields ?? {})) {
		const before = streamingFieldSource(previous, field);
		const source = reconcileSourceText(before, text, {
			epoch: `${event.toolUseId}:${field}`,
			limit: STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS,
		});
		fields[field] = source.text;
		ranges[field] = source.range;
		if (field === name) value = source.text;
	}
	if (event.streamingField) {
		const field = event.streamingField.name;
		const same = name === field;
		const before =
			!discontinuous && same && !event.streamingField.startsField
				? streamingFieldSource(previous, field)
				: undefined;
		// Only an explicit field-start marker proves a first delta is not a reconnect tail.
		const source = appendSourceText(
			before ??
				createSourceText("", {
					epoch: ranges[field]
						? nextSourceEpoch(ranges[field].epoch)
						: `${event.toolUseId}:${field}`,
					originKnown: event.streamingField.startsField === true,
					streaming: true,
				}),
			event.streamingField.delta,
			STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS,
		);
		name = field;
		value = source.text;
		ranges[field] = source.range;
		// Some wire events close a field and also flush its last delta. The completed
		// extracted value is authoritative; do not append that tail twice.
		if (Object.hasOwn(event.extractedFields ?? {}, field)) {
			const complete = reconcileSourceText(source, event.extractedFields?.[field] ?? "", {
				epoch: source.range.epoch,
				limit: STREAMING_TOOL_FIELD_PREVIEW_MAX_CHARS,
			});
			value = complete.text;
			ranges[field] = complete.range;
			fields[field] = complete.text;
		}
	}
	return {
		...(Object.keys(fields).length ? { extractedFields: fields } : {}),
		...(Object.keys(ranges).length ? { streamingFieldRanges: ranges } : {}),
		...(name !== undefined ? { streamingFieldName: name } : {}),
		...(value !== undefined ? { streamingFieldValue: value } : {}),
	};
}

/** Full parameters retain verified epochs/translations, never stale preview ranges. */
export function completeStreamingFieldRanges(
	chunk: TopLevelStreamingChunk | undefined,
	input: Record<string, unknown>,
): Record<string, SourceTextRange> | undefined {
	if (!chunk?.streamingFieldRanges) return undefined;
	const ranges = { ...chunk.streamingFieldRanges };
	for (const [name, text] of Object.entries(input)) {
		if (typeof text !== "string" || name.startsWith("_")) continue;
		ranges[name] = reconcileSourceText(streamingFieldSource(chunk, name), text, {
			epoch: `${chunk.toolUseId}:${name}`,
		}).range;
	}
	return ranges;
}

function streamingChunkInput(chunk: TopLevelStreamingChunk): Record<string, unknown> {
	const ranges = chunk.streamingFieldRanges
		? {
				_streamingFieldRanges: chunk.streamingFieldRanges,
				...(chunk.textDocument ? { textDocument: chunk.textDocument } : {}),
			}
		: chunk.textDocument
			? { textDocument: chunk.textDocument }
			: {};
	if (chunk._input) return { ...chunk._input, ...ranges };
	return {
		_streamingChars: chunk.inputCharsTotal,
		...(chunk.extractedFilePath ? { _streamingFilePath: chunk.extractedFilePath } : {}),
		...(chunk.contentCharsReceived != null
			? { _streamingContentChars: chunk.contentCharsReceived }
			: {}),
		...(chunk.extractedFields ? { _streamingFields: chunk.extractedFields } : {}),
		...(chunk.metadata ? { _streamingMetadata: chunk.metadata } : {}),
		...(chunk.streamingFieldName !== undefined
			? { _streamingFieldName: chunk.streamingFieldName }
			: {}),
		...(chunk.streamingFieldValue !== undefined
			? { _streamingFieldValue: chunk.streamingFieldValue }
			: {}),
		...ranges,
	};
}

/**
 * Convert a live top-level tool snapshot into fields that can be merged into the
 * persisted tool call with the same toolUseId. Runtime fields win, while fields
 * that only exist on persisted permission/reflection records are intentionally
 * left untouched.
 */
export function topLevelStreamingChunkToToolFields(
	chunk: TopLevelStreamingChunk,
): Record<string, unknown> {
	const receipts = {
		...(chunk.textDocument?.source?.toolCallId
			? { tcId: chunk.textDocument.source.toolCallId }
			: {}),
		...(chunk.textDocument?.source?.executionAttempt !== undefined
			? { executionAttempt: chunk.textDocument.source.executionAttempt }
			: {}),
		...(chunk._sendDeliveryTargets ? { _sendDeliveryTargets: chunk._sendDeliveryTargets } : {}),
		...(chunk._sendDeliveryTargetCount !== undefined
			? { _sendDeliveryTargetCount: chunk._sendDeliveryTargetCount }
			: {}),
		...(chunk._sendDeliveryBinding
			? {
					tcId: chunk._sendDeliveryBinding.toolCallId,
					executionAttempt: chunk._sendDeliveryBinding.attempt,
				}
			: {}),
	};
	if (chunk._started) {
		return {
			...receipts,
			// `initializing`, not `running`: `_started` means the tool's INPUT finished
			// parsing, and the permission gate sits after that. The real `running` arrives
			// with `tool_executing` (which the store folds into `_status`), so defaulting to
			// it here would claim execution that may not have begun — the bug that made a
			// card awaiting approval animate as though it were working.
			status: chunk._status ?? "initializing",
			...(chunk._input || chunk.streamingFieldRanges
				? { inputJson: streamingChunkInput(chunk) }
				: {}),
			...(chunk._startedAt != null ? { startedAt: chunk._startedAt } : {}),
			...(chunk._output !== undefined ? { outputJson: chunk._output } : {}),
			...(chunk._durationMs != null ? { durationMs: chunk._durationMs } : {}),
			...((chunk._metadata ?? chunk.metadata)
				? { _metadata: chunk._metadata ?? chunk.metadata }
				: {}),
			...(chunk._longRunning ? { _longRunning: true } : {}),
			...(chunk._streamedFullOutput ? { _streamedFullOutput: true } : {}),
			_streamingOutput: chunk._streamingOutput,
			...(chunk._structuredProgress ? { _structuredProgress: chunk._structuredProgress } : {}),
		};
	}

	return {
		...receipts,
		inputJson: streamingChunkInput(chunk),
		...(chunk.metadata ? { _metadata: chunk.metadata } : {}),
	};
}

function jsonLikeEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
		return false;
	}
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function recordMatchesToolFields(
	record: Record<string, unknown>,
	fields: Record<string, unknown>,
): boolean {
	for (const [key, expected] of Object.entries(fields)) {
		if (
			key === "inputJson" &&
			expected &&
			typeof expected === "object" &&
			!Array.isArray(expected)
		) {
			const expectedInput = expected as Record<string, unknown>;
			const hasStreamingMarkers = Object.keys(expectedInput).some((name) =>
				name.startsWith("_streaming"),
			);
			if (hasStreamingMarkers) {
				const currentInput = record.inputJson;
				if (!currentInput || typeof currentInput !== "object" || Array.isArray(currentInput)) {
					return false;
				}
				for (const [name, value] of Object.entries(expectedInput)) {
					if (!jsonLikeEqual((currentInput as Record<string, unknown>)[name], value)) {
						return false;
					}
				}
				continue;
			}
		}
		if (!jsonLikeEqual(record[key], expected)) return false;
	}
	return true;
}

/** Write document attempts carry a stronger identity than a reusable provider id. */
function findStreamingChunkMessage(
	messages: readonly TreeMessage[],
	chunk: TopLevelStreamingChunk,
): TreeMessage | undefined {
	const source = chunk.textDocument?.source;
	if (!chunk.textDocument)
		return findMsgByToolUseIdInTree(messages as TreeMessage[], chunk.toolUseId) ?? undefined;
	if (!source) return undefined;
	for (const message of messages) {
		if (message.narratorId === source.narratorId) {
			const matches = (pk: unknown, attempt: unknown) =>
				source.toolCallId
					? pk === source.toolCallId
					: source.messageId
						? message.id === source.messageId &&
							(source.executionAttempt === undefined || attempt === source.executionAttempt)
						: source.executionAttempt !== undefined && attempt === source.executionAttempt;
			if (
				(message.toolCalls ?? []).some(
					(call) => call.toolUseId === chunk.toolUseId && matches(call.id, call.executionAttempt),
				) ||
				message.contentJson.some(
					(block) =>
						block.type === "tool_use" &&
						block.id === chunk.toolUseId &&
						matches(block.tcId, block.executionAttempt),
				)
			)
				return message;
		}
		const child = findStreamingChunkMessage(message.children ?? [], chunk);
		if (child) return child;
	}
	return undefined;
}

/** Return whether both persisted representations already contain the live chunk fields. */
export function topLevelStreamingChunkMatchesPersistedTool(
	messages: TreeMessage[],
	chunk: TopLevelStreamingChunk,
): boolean {
	const message = findStreamingChunkMessage(messages, chunk);
	if (!message) return false;
	const records: Array<Record<string, unknown>> = [];
	for (const toolCall of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
		if (toolCall.toolUseId === chunk.toolUseId) {
			records.push(toolCall as unknown as Record<string, unknown>);
		}
	}
	for (const block of Array.isArray(message.contentJson) ? message.contentJson : []) {
		if (block.type === "tool_use" && block.id === chunk.toolUseId) {
			records.push(block as unknown as Record<string, unknown>);
		}
	}
	if (records.length === 0) return false;
	const fields = topLevelStreamingChunkToToolFields(chunk);
	return records.every((record) => recordMatchesToolFields(record, fields));
}

/**
 * Partition live top-level chunks by whether their toolUseId is already present
 * in a loaded message tree. Matched chunks can be folded into the persisted card;
 * unmatched chunks must remain synthetic because their message may not be
 * persisted yet (or its chunk may currently be virtualized out).
 */
export function splitTopLevelStreamingChunksByPersistedToolUse(
	chunks: TopLevelStreamingChunk[],
	messages: NarratorMsg[],
): { matched: TopLevelStreamingChunk[]; unmatched: TopLevelStreamingChunk[] } {
	const matched: TopLevelStreamingChunk[] = [];
	const unmatched: TopLevelStreamingChunk[] = [];
	for (const chunk of chunks) {
		if (findStreamingChunkMessage(messages, chunk)) matched.push(chunk);
		else unmatched.push(chunk);
	}
	return { matched, unmatched };
}

export function getSyntheticTopLevelStreamingChunks(
	chunks: TopLevelStreamingChunk[],
	messages: NarratorMsg[],
	reconciledToolUseIds: ReadonlySet<string>,
): TopLevelStreamingChunk[] {
	const candidates = chunks.filter(
		(chunk) => chunk.textDocument || !reconciledToolUseIds.has(chunk.toolUseId),
	);
	return splitTopLevelStreamingChunksByPersistedToolUse(candidates, messages).unmatched;
}

/**
 * Build the synthetic STREAMING_CHUNKS_MSG_ID assistant message that surfaces
 * the currently-streaming top-level tool calls. Pure function shared by the
 * legacy panel WS memo and the chunk data layer so both render identical cards.
 * Returns null when there are no active top-level streaming chunks.
 */
export function buildTopLevelStreamingChunksMsg(
	chunks: TopLevelStreamingChunk[],
	narratorId: string,
	createdAt: string | null,
): NarratorMsg | null {
	if (chunks.length === 0) return null;

	let blocks: ContentBlock[] = [];
	let toolCalls = [] as NonNullable<NarratorMsg["toolCalls"]>;
	for (const chunk of chunks) {
		if (chunk._started) {
			// Tool promoted to started/completed — render as a real card.
			const inputJson =
				chunk._input || chunk.streamingFieldRanges ? streamingChunkInput(chunk) : {};
			const next = upsertStreamingToolBlock(
				blocks,
				toolCalls,
				chunk.toolUseId,
				chunk.toolName,
				inputJson,
			);
			blocks = next.blocks;
			toolCalls = next.toolCalls;
			const tcIdx = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (tcIdx !== -1) {
				toolCalls[tcIdx] = {
					...toolCalls[tcIdx],
					// See topLevelStreamingChunkToToolFields: `_started` is "input parsed", not
					// "executing", so the default must not be `running`.
					status: chunk._status ?? "initializing",
					...(chunk._startedAt && { startedAt: chunk._startedAt }),
					...(chunk._output !== undefined && { outputJson: chunk._output }),
					...(chunk._durationMs != null && { durationMs: chunk._durationMs }),
					...(chunk._metadata && { _metadata: chunk._metadata }),
					...(chunk.metadata && { _metadata: chunk.metadata }),
					...(chunk._longRunning && { _longRunning: true }),
					...(chunk._streamedFullOutput && { _streamedFullOutput: true }),
					...(chunk._streamingOutput && { _streamingOutput: chunk._streamingOutput }),
					...(chunk._structuredProgress && {
						_structuredProgress: chunk._structuredProgress,
					}),
				} as (typeof toolCalls)[number];
			}
		} else {
			const next = upsertStreamingToolBlock(
				blocks,
				toolCalls,
				chunk.toolUseId,
				chunk.toolName,
				streamingChunkInput(chunk),
			);
			blocks = next.blocks;
			toolCalls = next.toolCalls;
			const tcIdx = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (tcIdx !== -1 && chunk.metadata) {
				toolCalls[tcIdx] = {
					...toolCalls[tcIdx],
					_metadata: chunk.metadata,
				} as (typeof toolCalls)[number];
			}
		}
		if (chunk.textDocument?.source) {
			const index = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (index >= 0)
				toolCalls[index] = {
					...toolCalls[index],
					...(chunk.textDocument.source.toolCallId
						? { id: chunk.textDocument.source.toolCallId }
						: {}),
					...(chunk.textDocument.source.executionAttempt !== undefined
						? { executionAttempt: chunk.textDocument.source.executionAttempt }
						: {}),
				};
			for (const block of blocks)
				if (block.type === "tool_use" && block.id === chunk.toolUseId) {
					if (chunk.textDocument.source.toolCallId)
						block.tcId = chunk.textDocument.source.toolCallId;
					if (chunk.textDocument.source.executionAttempt !== undefined)
						block.executionAttempt = chunk.textDocument.source.executionAttempt;
				}
		}
		if (chunk._sendDeliveryTargets || chunk._sendDeliveryTargetCount !== undefined) {
			const index = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
			if (index >= 0)
				toolCalls[index] = {
					...toolCalls[index],
					_sendDeliveryTargets: chunk._sendDeliveryTargets,
					...(chunk._sendDeliveryTargetCount !== undefined
						? { _sendDeliveryTargetCount: chunk._sendDeliveryTargetCount }
						: {}),
					...(chunk._sendDeliveryBinding
						? {
								tcId: chunk._sendDeliveryBinding.toolCallId,
								executionAttempt: chunk._sendDeliveryBinding.attempt,
							}
						: {}),
				} as (typeof toolCalls)[number];
		}
	}

	return {
		id: STREAMING_CHUNKS_MSG_ID,
		narratorId,
		parentToolUseId: null,
		role: "assistant",
		contentJson: blocks,
		contentText: null,
		toolCalls,
		createdAt: createdAt ?? new Date().toISOString(),
		children: [],
	} as NarratorMsg;
}

/**
 * Insert a top-level message into a seq-ascending array at its correct slot.
 * Falls back to appending when seq is missing or it belongs at the tail.
 */
export function insertTopLevelMessageBySeq(
	messages: NarratorMsg[],
	newMsg: NarratorMsg,
): NarratorMsg[] {
	const seq =
		typeof newMsg.seq === "number" && Number.isFinite(newMsg.seq) ? newMsg.seq : undefined;
	if (seq == null) return [...messages, newMsg];

	const insertIdx = messages.findIndex(
		(msg) => typeof msg.seq === "number" && Number.isFinite(msg.seq) && msg.seq > seq,
	);
	if (insertIdx === -1) return [...messages, newMsg];

	const updated = [...messages];
	updated.splice(insertIdx, 0, newMsg);
	return updated;
}

function mergeSubagentActivity(
	existing: SubagentActivitySummary | undefined,
	incoming: SubagentActivitySummary | undefined,
): SubagentActivitySummary | undefined {
	if (!existing) return incoming;
	if (!incoming) return existing;
	const incomingModel = normalizeSubagentModel(incoming.model);
	const existingModel = normalizeSubagentModel(existing.model);
	const model = incomingModel ?? existingModel;
	const incomingReasoningEffort = normalizeSubagentReasoningEffort(incoming.reasoningEffort);
	const existingReasoningEffort = normalizeSubagentReasoningEffort(existing.reasoningEffort);
	const reasoningEffort = incomingReasoningEffort ?? existingReasoningEffort;
	return model !== incoming.model || reasoningEffort !== incoming.reasoningEffort
		? { ...incoming, model, reasoningEffort }
		: incoming;
}

/** Preserve live subagent activity when a terminal message refresh has sparse model metadata. */
export function preserveLiveSubagentActivity(
	existing: NarratorMsg | undefined,
	incoming: NarratorMsg,
): NarratorMsg {
	if (!existing) return incoming;
	const existingActivities = new Map<string, SubagentActivitySummary>();
	for (const toolCall of existing.toolCalls ?? []) {
		if (toolCall._subagentActivity) {
			existingActivities.set(toolCall.toolUseId, toolCall._subagentActivity);
		}
	}
	for (const block of existing.contentJson ?? []) {
		if (block.type === "tool_use" && typeof block.id === "string" && block._subagentActivity) {
			existingActivities.set(block.id, block._subagentActivity);
		}
	}
	if (existingActivities.size === 0) return incoming;

	let changed = false;
	const toolCalls = (incoming.toolCalls ?? []).map((toolCall) => {
		const activity = mergeSubagentActivity(
			existingActivities.get(toolCall.toolUseId),
			toolCall._subagentActivity,
		);
		if (activity === toolCall._subagentActivity) return toolCall;
		changed = true;
		return { ...toolCall, _subagentActivity: activity };
	});
	const contentJson = (incoming.contentJson ?? []).map((block) => {
		if (block.type !== "tool_use" || typeof block.id !== "string") return block;
		const activity = mergeSubagentActivity(
			existingActivities.get(block.id),
			block._subagentActivity,
		);
		if (activity === block._subagentActivity) return block;
		changed = true;
		return { ...block, _subagentActivity: activity };
	});
	return changed ? { ...incoming, toolCalls, contentJson } : incoming;
}

/**
 * Find the tool-use id of the LAST spec://tasks.json operation across an ordered
 * message list (Read/Write/Edit). Only this snapshot reflects the live task
 * state, so SpecTasksDetail animates a "doing" row only on this card. Scans both
 * the assistant `contentJson` tool_use blocks and the `toolCalls` records, in
 * message order, and returns the id seen last. Returns null when there is none.
 */
export function findLatestSpecTasksToolUseId(messages: NarratorMsg[]): string | null {
	let latest: string | null = null;
	for (const msg of messages) {
		for (const block of msg.contentJson ?? []) {
			if (block.type !== "tool_use") continue;
			const id = typeof block.id === "string" ? block.id : null;
			const name = typeof block.name === "string" ? block.name : null;
			if (id && name && isSpecTasksToolUse(name, block.input)) latest = id;
		}
		for (const tc of msg.toolCalls ?? []) {
			if (tc.toolUseId && isSpecTasksToolUse(tc.toolName, tc.inputJson)) {
				latest = tc.toolUseId;
			}
		}
	}
	return latest;
}
