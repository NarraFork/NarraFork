import { messageBody, splitRowBlocks } from "@shared/narrator-blocks/message-blocks";
import {
	appendSourceText,
	createSourceText,
	nextSourceEpoch,
	reconcileSourceText,
	type SourceTextRange,
	type SourceTextSnapshot,
	safeSourceSliceStart,
} from "@shared/pretext-layout/source-text";
import { copyStreamingEditInput } from "@shared/streaming-edit-origin";
import type { ToolProgressPayload } from "@shared/tool-progress";
import { upsertStreamingToolBlock } from "./message/message-tree-utils";
import { isNestedRow } from "./message/nested-rows";
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

/** Keep only the trailing window of a streamed tool output preview. */
export function getToolOutputPreview(output: string): string {
	if (output.length <= STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS) return output;
	return output.slice(
		safeSourceSliceStart(output, output.length - STREAMING_TOOL_OUTPUT_PREVIEW_MAX_CHARS),
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
	if (chunk._input) {
		// Validated once on started/updatedInput; rendering never re-hashes old_string.
		return copyStreamingEditInput(chunk._input, ranges);
	}
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
	// Edit preview origins belong to input._streamingMetadata. Promoting them to
	// result metadata would bypass target validation and shadow the actual result.
	const metadata = chunk._metadata ?? (chunk.toolName === "Edit" ? undefined : chunk.metadata);
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
			...(metadata ? { _metadata: metadata } : {}),
			...(chunk._longRunning ? { _longRunning: true } : {}),
			...(chunk._streamedFullOutput ? { _streamedFullOutput: true } : {}),
			_streamingOutput: chunk._streamingOutput,
			...(chunk._structuredProgress ? { _structuredProgress: chunk._structuredProgress } : {}),
		};
	}

	return {
		...receipts,
		inputJson: streamingChunkInput(chunk),
		...(chunk.metadata && chunk.toolName !== "Edit" ? { _metadata: chunk.metadata } : {}),
	};
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
					...(chunk.metadata && chunk.toolName !== "Edit" && { _metadata: chunk.metadata }),
					...(chunk._metadata && { _metadata: chunk._metadata }),
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
		blocks: splitRowBlocks({ id: STREAMING_CHUNKS_MSG_ID, role: "assistant" }, blocks),
		contentText: null,
		toolCalls,
		createdAt: createdAt ?? new Date().toISOString(),
	} as NarratorMsg;
}

/**
 * Find the tool-use id of the LAST spec://tasks.json operation across an ordered
 * message list (Read/Write/Edit). Only this snapshot reflects the live task
 * state, so SpecTasksDetail animates a "doing" row only on this card. Scans both
 * the assistant's tool_use elements and the `toolCalls` records, in
 * message order, and returns the id seen last. Returns null when there is none.
 */
export function findLatestSpecTasksToolUseId(messages: NarratorMsg[]): string | null {
	let latest: string | null = null;
	for (const msg of messages) {
		if (isNestedRow(msg)) continue;
		for (const block of messageBody(msg)) {
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
