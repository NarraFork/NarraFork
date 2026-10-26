/**
 * streaming-tool-chunks.ts — Folds LIVE tool events into the streaming row's
 * synthetic tool calls, so a tool becomes visible while the model is still writing
 * its arguments and shows its output while it runs.
 *
 * The gap this closes
 * -------------------
 * The exact list previously routed these events nowhere. `useVListLivePatches`
 * excluded `tool_use_chunk` / `tool_output` as a performance invariant, on the
 * grounds that they "belong to the streaming tail" — but the tail only ever
 * accumulated text and reasoning. The result: a tool card appeared only after a
 * structural reload (a 120ms-1s coalesced refetch), and a running command showed no
 * output at all until it finished. The chunked path had both from the first delta.
 *
 * They still must not reach the document PATCH channel: those events fire at
 * streaming frequency and a patch rebuilds from the persisted message set. Folding
 * them into the streaming row instead keeps one rebuild per frame (the row is
 * rebuilt anyway for text) and reuses every committed row's cached measurement.
 *
 * The fold itself reuses the chunked path's pure helpers
 * (`buildTopLevelStreamingChunksMsg`, `topLevelStreamingChunkToToolFields`) so both
 * lists render byte-identical cards from the same state.
 *
 * Pure: mutates the passed store and returns whether the caller should re-render.
 */

import {
	isCommunicationTool,
	knownSendDeliveryTargets,
	mergeSendDeliveryTargetCount,
	mergeSendDeliveryTargets,
	type SendDeliveryReceipt,
} from "@shared/communication-tool";
import { type MessageBodySource, messageBody } from "@shared/narrator-blocks/message-blocks";
import { isTextDocumentRef } from "@shared/pretext-layout/tool-detail";
import {
	handoffStreamingEditOrigin,
	type StreamingEditOrigin,
} from "@shared/streaming-edit-origin";
import type { ToolProgressPayload } from "@shared/tool-progress";
import {
	isLiveToolStatusRegression,
	LIVE_TOOL_PHASE_RANK,
	mergeToolLifecycleRecord,
	TERMINAL_TOOL_ROW_STATUSES,
} from "@shared/tool-row-status";
import {
	completeStreamingFieldRanges,
	foldStreamingToolFields,
	getToolOutputPreview,
	type TopLevelStreamingChunk,
} from "../narrator-message-helpers";

/** Live per-tool state for the streaming row, keyed by toolUseId in arrival order. */
export type StreamingToolStore = Map<string, TopLevelStreamingChunk>;

const retiredDocuments = new WeakMap<StreamingToolStore, Set<string>>();
const documentIdentity = (ref: import("@shared/pretext-layout/text-document").TextDocumentRef) =>
	JSON.stringify([ref.id, ref.epoch]);

/** Late frames from an older execution attempt cannot resurrect its card. */
export function isRetiredStreamingDocument(
	store: StreamingToolStore,
	toolUseId: string,
	ref: import("@shared/pretext-layout/text-document").TextDocumentRef,
): boolean {
	if (retiredDocuments.get(store)?.has(documentIdentity(ref))) return true;
	const current = store.get(toolUseId)?.textDocument;
	return (
		!!current &&
		documentIdentity(current) !== documentIdentity(ref) &&
		current.source?.executionAttempt !== undefined &&
		ref.source?.executionAttempt !== undefined &&
		ref.source.executionAttempt < current.source.executionAttempt
	);
}

function switchStreamingDocument(
	store: StreamingToolStore,
	toolUseId: string,
	ref: import("@shared/pretext-layout/text-document").TextDocumentRef,
): TopLevelStreamingChunk | undefined {
	const current = store.get(toolUseId);
	if (!current?.textDocument || documentIdentity(current.textDocument) === documentIdentity(ref))
		return current;
	let retired = retiredDocuments.get(store);
	if (!retired) {
		retired = new Set();
		retiredDocuments.set(store, retired);
	}
	retired.add(documentIdentity(current.textDocument));
	return undefined;
}

/**
 * Placeholder for an entry created by an event that carries no tool name.
 *
 * Only `tool_executing` can do that, and only when it arrives before `tool_started`
 * (eager execution). It is replaced the moment the named event lands.
 */
const UNKNOWN_TOOL_NAME = "Tool";

/** Keep navigation receipts in the live tail store, independently of lifecycle/output. */
export function applyStreamingSendDelivery(
	store: StreamingToolStore,
	event: {
		toolUseId: string;
		targets: SendDeliveryReceipt[];
		toolCallBinding?: { toolCallId: string; attempt: number };
		targetCount?: number;
	},
): boolean {
	if (!event.toolUseId || !Array.isArray(event.targets)) return false;
	const existing = store.get(event.toolUseId);
	if (
		existing &&
		existing.toolName !== UNKNOWN_TOOL_NAME &&
		!isCommunicationTool({ toolName: existing.toolName, inputJson: existing._input })
	)
		return false;
	const binding = existing?._sendDeliveryBinding;
	const matchesBinding =
		!!binding &&
		!!event.toolCallBinding &&
		binding.toolCallId === event.toolCallBinding.toolCallId &&
		binding.attempt === event.toolCallBinding.attempt;
	if (binding && event.toolCallBinding && !matchesBinding) return false;
	const terminal =
		(LIVE_TOOL_PHASE_RANK[existing?._status ?? ""] ?? 0) >= 3 || existing?._output != null;
	if (terminal && !matchesBinding) return false;
	const incoming = event.targets.filter(
		(target) => typeof target?.deliveryMessageId === "string" && !!target.deliveryMessageId.trim(),
	);
	// Legacy consumption has no attempt identity. It may enrich an existing exact
	// receipt, never seed or replace navigation on the currently running attempt.
	const unboundConsumption =
		!event.toolCallBinding && incoming.some((target) => target.injectionConsumedAt !== undefined);
	const matchingReceiptsOnly = terminal || unboundConsumption;
	const prior = knownSendDeliveryTargets({
		_metadata: existing?._metadata,
		outputJson: existing?._output,
		_sendDeliveryTargets: existing?._sendDeliveryTargets,
	});
	const next = mergeSendDeliveryTargets(prior, incoming, matchingReceiptsOnly);
	const targetCount = mergeSendDeliveryTargetCount(
		existing?._sendDeliveryTargetCount,
		unboundConsumption ? undefined : event.targetCount,
	);
	if (
		(!next.length && targetCount === undefined) ||
		(JSON.stringify(next) === JSON.stringify(existing?._sendDeliveryTargets ?? []) &&
			targetCount === existing?._sendDeliveryTargetCount)
	)
		return false;
	// Terminal and unbound consumption frames cannot seed another attempt's navigation.
	if (
		matchingReceiptsOnly &&
		!incoming.some((target) =>
			prior.some(
				(prior) => prior.id === target.id && prior.deliveryMessageId === target.deliveryMessageId,
			),
		)
	)
		return false;
	store.set(event.toolUseId, {
		toolUseId: event.toolUseId,
		inputCharsTotal: 0,
		...existing,
		toolName: existing?.toolName === "TeamStatus" ? "TeamStatus" : "Send",
		_sendDeliveryTargets: next,
		...(targetCount !== undefined ? { _sendDeliveryTargetCount: targetCount } : {}),
		...(event.toolCallBinding ? { _sendDeliveryBinding: event.toolCallBinding } : {}),
	});
	return true;
}

export function createStreamingToolStore(): StreamingToolStore {
	return new Map();
}

type InputBinding = { toolCallId: string; executionAttempt: number };
const MAX_RETIRED_INPUT_BINDINGS = 32;

function inputBinding(
	value: { toolCallId?: string | null; executionAttempt?: number } | undefined,
): InputBinding | undefined {
	return value?.toolCallId &&
		value.toolCallId.trim() &&
		value.toolCallId.length <= 256 &&
		typeof value.executionAttempt === "number" &&
		Number.isSafeInteger(value.executionAttempt) &&
		value.executionAttempt >= 0
		? { toolCallId: value.toolCallId, executionAttempt: value.executionAttempt }
		: undefined;
}

function inputBindingKey(binding: InputBinding): string {
	return JSON.stringify([binding.toolCallId, binding.executionAttempt]);
}

function countsPrompt(toolName: string): boolean {
	return toolName === "Agent" || toolName === "Task";
}

function promptIdentityUnknown(
	existing: TopLevelStreamingChunk | undefined,
	incoming: InputBinding | undefined,
	startedAt?: number,
): boolean {
	if (!existing || !countsPrompt(existing.toolName)) return false;
	const current = inputBinding(existing);
	if (!current || !incoming || inputBindingKey(current) === inputBindingKey(incoming))
		return existing._promptInputIdentityUnknown === true;
	if (
		current.toolCallId === incoming.toolCallId &&
		incoming.executionAttempt > current.executionAttempt
	)
		return false;
	if (
		typeof startedAt === "number" &&
		Number.isFinite(startedAt) &&
		typeof existing._startedAt === "number" &&
		startedAt > existing._startedAt
	)
		return false;
	// Terminal entries release historical identities. Accept a new authoritative
	// input/status, but do not claim its prompt identity from a reused wire id alone.
	return (
		existing._promptInputIdentityUnknown === true ||
		TERMINAL_TOOL_ROW_STATUSES.has(existing._status ?? "")
	);
}

/** Shared by snapshots and both input lifecycle folds before they touch a tool. */
export function isRetiredStreamingToolBinding(
	store: StreamingToolStore,
	event: {
		toolUseId: string;
		toolName?: string;
		toolCallId?: string | null;
		executionAttempt?: number;
	},
): boolean {
	const existing = store.get(event.toolUseId);
	const incoming = inputBinding(event);
	if (!existing || !incoming) return false;
	const key = inputBindingKey(incoming);
	const current = inputBinding(existing);
	if (event.toolName && !countsPrompt(event.toolName)) {
		return (
			current?.toolCallId === incoming.toolCallId &&
			incoming.executionAttempt < current.executionAttempt
		);
	}
	if (existing._retiredInputBindings?.includes(incoming.toolCallId)) return true;
	if (!current || key === inputBindingKey(current)) return false;
	if (current.toolCallId === incoming.toolCallId)
		return incoming.executionAttempt < current.executionAttempt;
	return countsPrompt(existing.toolName) && existing._inputBindingLimitReached === true;
}

/** The fixed budget is admission-only: saturation never forgets an old identity. */
function retireInputBinding(
	store: StreamingToolStore,
	existing: TopLevelStreamingChunk,
	incoming: InputBinding,
	incomingToolName: string,
): readonly string[] | false {
	const retired = existing._retiredInputBindings ?? [];
	if (!countsPrompt(existing.toolName) || !countsPrompt(incomingToolName)) return [];
	const current = inputBinding(existing);
	// Attempts of one PK are ordered; their scalar watermark rejects older ones.
	if (!current || current.toolCallId === incoming.toolCallId) return retired;
	if (retired.length >= MAX_RETIRED_INPUT_BINDINGS) {
		store.set(existing.toolUseId, {
			...existing,
			_inputBindingLimitReached: true,
			streamingPromptChars: null,
		});
		return false;
	}
	return [...retired, current.toolCallId];
}

export interface ToolChunkEvent {
	toolCallId?: string | null;
	executionAttempt?: number;
	/** Subscription snapshots are authoritative identity boundaries, not live deltas. */
	fromSnapshot?: boolean;
	streamStartedAt?: number;
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	/** One delta of a field being streamed (accumulated across frames). */
	streamingField?: { name: string; delta: string; startsField?: boolean; offset?: number };
	inputDocument?: import("@shared/pretext-layout/text-document").TextDocumentStreamUpdate;
}

/**
 * Fold a `tool_use_chunk` (the model is writing this tool's arguments).
 *
 * `streamingField` arrives as DELTAS and must accumulate; every other field is a
 * running total the server recomputes, so it is simply overwritten.
 */
export function applyStreamingToolChunk(store: StreamingToolStore, event: ToolChunkEvent): boolean {
	if (!event.toolUseId || isRetiredStreamingToolBinding(store, event)) return false;
	if (
		event.inputDocument &&
		isRetiredStreamingDocument(store, event.toolUseId, event.inputDocument.ref)
	)
		return false;
	let existing = event.inputDocument
		? switchStreamingDocument(store, event.toolUseId, event.inputDocument.ref)
		: store.get(event.toolUseId);
	const binding = inputBinding(event);
	const unknownPromptIdentity =
		countsPrompt(event.toolName) && promptIdentityUnknown(existing, binding, event.streamStartedAt);
	let retiredBindings = countsPrompt(event.toolName) ? existing?._retiredInputBindings : undefined;
	if (existing && binding) {
		const current = inputBinding(existing);
		if (current && inputBindingKey(current) !== inputBindingKey(binding)) {
			if (current.toolCallId !== binding.toolCallId && !event.fromSnapshot) return false;
			const retired = retireInputBinding(store, existing, binding, event.toolName);
			if (retired === false) return true;
			retiredBindings = retired;
			existing = undefined;
		} else if (!current) existing = undefined;
	}
	if (existing && existing.toolName !== event.toolName) existing = undefined;
	if (
		existing &&
		event.inputCharsTotal < existing.inputCharsTotal &&
		(event.toolName === "Agent" || event.toolName === "Task")
	)
		return false;
	// A promoted tool (started/completed) owns its state through the lifecycle
	// events below; a late argument chunk must not demote it back to "streaming".
	if (existing?._started) return false;

	const sameBinding =
		binding &&
		existing?.toolCallId === binding.toolCallId &&
		existing.executionAttempt === binding.executionAttempt;
	const fields = foldStreamingToolFields(existing, event);
	if (
		event.fromSnapshot &&
		!sameBinding &&
		event.extractedFields?.prompt === undefined &&
		(event.toolName === "Agent" || event.toolName === "Task")
	) {
		// Snapshots do not carry the active large prompt's decoded offset. Never
		// reuse a wire-id-only tail length across an unproven stream identity.
		fields.streamingPromptChars = null;
	}

	store.set(event.toolUseId, {
		...existing,
		toolUseId: event.toolUseId,
		toolName: event.toolName,
		...(binding ?? {}),
		...(retiredBindings?.length
			? { _retiredInputBindings: retiredBindings }
			: existing?._retiredInputBindings
				? { _retiredInputBindings: undefined }
				: {}),
		...(!countsPrompt(event.toolName) && existing?._inputBindingLimitReached
			? { _inputBindingLimitReached: undefined }
			: {}),
		...(unknownPromptIdentity
			? { _promptInputIdentityUnknown: true }
			: existing?._promptInputIdentityUnknown
				? { _promptInputIdentityUnknown: undefined }
				: {}),
		inputCharsTotal: event.inputCharsTotal,
		...(event.inputDocument ? { textDocument: event.inputDocument.ref } : {}),
		...(event.extractedFilePath !== undefined
			? { extractedFilePath: event.extractedFilePath }
			: {}),
		...(event.contentCharsReceived !== undefined
			? { contentCharsReceived: event.contentCharsReceived }
			: {}),
		...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
		...fields,
	});
	return true;
}

export interface ToolStartedEvent {
	toolCallId?: string | null;
	executionAttempt?: number;
	streamingEditOrigin?: StreamingEditOrigin;
	toolUseId: string;
	toolName: string;
	streamStartedAt?: number;
	streamCompletedAt?: number;
	input?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/**
 * Lifecycle rank + regression guard live in `@shared/tool-row-status` so the
 * streaming store, document upserts and live patches share ONE rule.
 *
 * ⚠️ `tool_started` can arrive AFTER `tool_executing` (eager execution), and a
 * message upsert can carry a snapshot older than a live-patched completion.
 * Both would otherwise move a tool BACKWARDS — `initializing` over `running`,
 * or `running` over `success` — which is exactly "status lags by one call".
 */
export { isLiveToolStatusRegression, LIVE_TOOL_PHASE_RANK, mergeToolLifecycleRecord };

/** The status a live entry should keep when an event carrying `incoming` arrives. */
function resolveLiveToolStatus(existing: string | undefined, incoming: string): string {
	return isLiveToolStatusRegression(existing, incoming) ? (existing as string) : incoming;
}

/**
 * Fold `tool_started`: the tool's INPUT finished parsing.
 *
 * ⚠️ NOT the start of execution, which is the distinction this whole event chain was
 * missing. The server yields `tool_call` right after CALLING `executeTool`, and the
 * permission gate is the first thing inside — so at this point the tool may still be
 * waiting on a human. `tool_executing` is what proves execution began; see
 * `applyStreamingToolExecuting` and `@shared/tool-shimmer`.
 *
 * The card still switches from an argument-progress placeholder to a real tool card
 * here, because that transition is about having a complete input to show — which IS
 * true now.
 *
 * ⚠️ This event MUST NOT be dropped when a later phase already landed, even though
 * `applyStreamingToolChunk` above does exactly that for a late argument chunk. The
 * situations differ: a late chunk carries nothing unique, whereas `tool_started` is
 * the ONLY carrier of `_input` (the parsed arguments). Dropping it wholesale would
 * leave `_input` empty forever, and `buildTopLevelStreamingChunksMsg`'s
 * `chunk._input ?? {}` would render a card with no file path and no command — trading
 * a colour error for missing content. So the guard is scoped to `_status` alone.
 */
export function applyStreamingToolStarted(
	store: StreamingToolStore,
	event: ToolStartedEvent,
): boolean {
	if (!event.toolUseId || isRetiredStreamingToolBinding(store, event)) return false;
	const document = isTextDocumentRef(event.input?.textDocument)
		? event.input.textDocument
		: undefined;
	if (document && isRetiredStreamingDocument(store, event.toolUseId, document)) return false;
	let existing = document
		? switchStreamingDocument(store, event.toolUseId, document)
		: store.get(event.toolUseId);
	const binding = inputBinding(event);
	const unknownPromptIdentity =
		countsPrompt(event.toolName) && promptIdentityUnknown(existing, binding, event.streamStartedAt);
	let retiredBindings = countsPrompt(event.toolName) ? existing?._retiredInputBindings : undefined;
	if (existing && binding) {
		const current = inputBinding(existing);
		if (current && inputBindingKey(current) !== inputBindingKey(binding)) {
			const retired = retireInputBinding(store, existing, binding, event.toolName);
			if (retired === false) return true;
			retiredBindings = retired;
			existing = undefined;
		} else if (!current) existing = { ...existing, streamingPromptChars: null };
	}
	store.set(event.toolUseId, {
		inputCharsTotal: existing?.inputCharsTotal ?? 0,
		...existing,
		...(retiredBindings?.length
			? { _retiredInputBindings: retiredBindings }
			: existing?._retiredInputBindings
				? { _retiredInputBindings: undefined }
				: {}),
		...(!countsPrompt(event.toolName) && existing?._inputBindingLimitReached
			? { _inputBindingLimitReached: undefined }
			: {}),
		...(unknownPromptIdentity
			? { _promptInputIdentityUnknown: true }
			: existing?._promptInputIdentityUnknown
				? { _promptInputIdentityUnknown: undefined }
				: {}),
		toolUseId: event.toolUseId,
		// AFTER the spread, not before: `applyStreamingToolExecuting` may have created this
		// entry with a placeholder name (it gets no name of its own), and `...existing`
		// would otherwise let that placeholder shadow the real one this event carries.
		toolName: event.toolName || existing?.toolName || UNKNOWN_TOOL_NAME,
		...(binding ?? {}),
		_started: true,
		// Field-scoped guard: everything else in this object still merges normally.
		_status: resolveLiveToolStatus(existing?._status, "initializing"),
		...(event.input
			? {
					_input: handoffStreamingEditOrigin(
						event.toolUseId,
						event.input,
						event.streamingEditOrigin,
						existing?._input,
					) as Record<string, unknown>,
					...(document ? { textDocument: document } : {}),
					streamingFieldRanges: completeStreamingFieldRanges(existing, event.input),
				}
			: {}),
		...(event.streamStartedAt != null ? { _startedAt: event.streamStartedAt } : {}),
		...(event.streamCompletedAt != null ? { streamCompletedAt: event.streamCompletedAt } : {}),
		...(event.metadata ? { _metadata: event.metadata } : {}),
	});
	return true;
}

export interface ToolExecutingEvent {
	toolUseId: string;
	executionStartedAt?: number;
}

/**
 * Fold `tool_executing`: the permission gate passed and the tool is now running.
 *
 * This is the positive evidence the blue "executing" shimmer needs. Before this event
 * existed the client had to assume `tool_started` meant execution — the auto-allow
 * path writes `running` to the database and broadcasts nothing, so no later frame
 * supplied it — which is why a card awaiting approval used to animate as though work
 * were under way.
 *
 * Creates the entry when the tool is unknown, unlike `applyStreamingToolOutput` below
 * which deliberately ignores unknown ids. The asymmetry is intentional: eager
 * execution means this event can legitimately arrive BEFORE `tool_started`, so
 * discarding it would lose the one fact it carries. A later `tool_started` then fills
 * in the input without demoting the status.
 */
export function applyStreamingToolExecuting(
	store: StreamingToolStore,
	event: ToolExecutingEvent,
): boolean {
	if (!event.toolUseId) return false;
	const existing = store.get(event.toolUseId);
	const nextStatus = resolveLiveToolStatus(existing?._status, "running");
	// Nothing to do when a terminal status already won — avoids a pointless rerender.
	if (existing && existing._status === nextStatus && existing._started) return false;
	store.set(event.toolUseId, {
		inputCharsTotal: existing?.inputCharsTotal ?? 0,
		...existing,
		toolUseId: event.toolUseId,
		// This event carries NO tool name of its own. The placeholder only ever survives
		// until `tool_started` lands (which may be after this frame, hence the ordering
		// note over there); it must never overwrite a name already known.
		toolName: existing?.toolName ?? UNKNOWN_TOOL_NAME,
		// A tool that is executing has necessarily finished parsing its input, so the
		// card should render as a real card even if `tool_started` has not landed yet.
		_started: true,
		_status: nextStatus,
	});
	return true;
}

/**
 * Append streaming stdout for a RUNNING tool.
 *
 * The caller owns throttling (see useVListStreamingTools): this only records the
 * latest bounded preview. Ignored for tools the store has never seen, so an event
 * for a tool that already persisted does not resurrect a synthetic card.
 */
export function applyStreamingToolOutput(
	store: StreamingToolStore,
	toolUseId: string,
	output: string,
): boolean {
	const existing = store.get(toolUseId);
	if (!existing) return false;
	const preview = getToolOutputPreview(output);
	if (existing._streamingOutput === preview) return false;
	store.set(toolUseId, { ...existing, _streamingOutput: preview });
	return true;
}

/**
 * Record a determinate progress measurement for a RUNNING tool.
 *
 * Same "only a tool the store already knows" rule as the output channel: a frame
 * for a tool that already persisted belongs to its real card, and creating an
 * entry here would resurrect a synthetic one beside it.
 */
export function applyStreamingToolProgress(
	store: StreamingToolStore,
	toolUseId: string,
	progress: ToolProgressPayload,
): boolean {
	const existing = store.get(toolUseId);
	if (!existing) return false;
	// Identity check on the fields a bar is drawn from. Byte counts advance
	// monotonically so this rarely short-circuits, but a paused transfer would
	// otherwise re-render the row on every repeated frame.
	const prev = existing._structuredProgress;
	if (
		prev &&
		prev.completed === progress.completed &&
		prev.total === progress.total &&
		prev.itemsDone === progress.itemsDone &&
		prev.currentItem === progress.currentItem
	) {
		return false;
	}
	store.set(toolUseId, { ...existing, _structuredProgress: progress });
	return true;
}

/**
 * Mark a live tool as long-running (the server's "still working" signal).
 *
 * Only applies to a tool the row is already showing; a signal for one that has
 * since persisted belongs to the real card and is handled by the document patch
 * channel instead.
 */
export function applyStreamingToolLongRunning(
	store: StreamingToolStore,
	toolUseId: string,
): boolean {
	const existing = store.get(toolUseId);
	if (!existing || existing._longRunning) return false;
	store.set(toolUseId, { ...existing, _longRunning: true });
	return true;
}

export interface ToolCompletedEvent {
	toolUseId: string;
	status: string;
	output?: unknown;
	durationMs?: number;
	updatedInput?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/**
 * Record a tool's terminal state.
 *
 * The entry is KEPT rather than dropped: the persisted message carrying this tool
 * arrives separately, and removing the card here would blank it out in between.
 * `dropPersistedStreamingTools` retires it once the real one exists.
 */
export function applyStreamingToolCompleted(
	store: StreamingToolStore,
	event: ToolCompletedEvent,
): boolean {
	const existing = store.get(event.toolUseId);
	if (!existing) return false;
	store.set(event.toolUseId, {
		...existing,
		_started: true,
		_status: event.status,
		...(TERMINAL_TOOL_ROW_STATUSES.has(event.status)
			? { _retiredInputBindings: undefined, _inputBindingLimitReached: undefined }
			: {}),
		...(event.output !== undefined ? { _output: event.output } : {}),
		...(event.durationMs != null ? { _durationMs: event.durationMs } : {}),
		...(event.updatedInput
			? {
					_input: handoffStreamingEditOrigin(
						event.toolUseId,
						event.updatedInput,
						undefined,
						existing?._input,
					) as Record<string, unknown>,
					...(isTextDocumentRef(event.updatedInput.textDocument)
						? { textDocument: event.updatedInput.textDocument }
						: {}),
					streamingFieldRanges: completeStreamingFieldRanges(existing, event.updatedInput),
				}
			: {}),
		...(event.metadata ? { _metadata: event.metadata } : {}),
	});
	return true;
}

/**
 * Drop live entries the server has declared abandoned.
 *
 * The ordinary hand-off retires a card when its PERSISTED counterpart appears. A
 * tool whose arguments were still streaming when the connection broke never gets
 * one: the attempt was replayed under fresh ids, so no `tool_completed` and no
 * message will ever carry this id. Nothing would retire the card and it stays
 * "running" forever — the ghost tool with a live elapsed timer.
 *
 * The server names those ids explicitly (`tool_use_discarded`), so this is the one
 * retirement path that does not need a replacement to exist.
 */
export function dropDiscardedStreamingTools(
	store: StreamingToolStore,
	toolUseIds: readonly string[],
): boolean {
	let changed = false;
	for (const toolUseId of toolUseIds) {
		if (store.delete(toolUseId)) changed = true;
	}
	return changed;
}

/**
 * Drop live entries whose tool now exists in the committed document.
 *
 * This is the per-tool half of the hand-off (streaming-handoff.ts covers the row as
 * a whole): a synthetic card must disappear exactly when the persisted one appears,
 * never before (a gap) and never after (a duplicate).
 */
export function dropPersistedStreamingTools(
	store: StreamingToolStore,
	persistedToolUseIds: ReadonlySet<string>,
	matchesDocument?: (chunk: TopLevelStreamingChunk) => boolean,
): boolean {
	if (store.size === 0 || persistedToolUseIds.size === 0) return false;
	let changed = false;
	for (const toolUseId of [...store.keys()]) {
		if (!persistedToolUseIds.has(toolUseId)) continue;
		const chunk = store.get(toolUseId);
		if (chunk?.textDocument && matchesDocument && !matchesDocument(chunk)) continue;
		store.delete(toolUseId);
		changed = true;
	}
	return changed;
}

export interface PersistedDocumentPin {
	narratorId?: string;
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: number;
}

/** Bounded identity index; never touches input/output text or serializes tool payloads. */
export function collectPersistedDocumentPins(
	messages: readonly unknown[],
): ReadonlyMap<string, readonly PersistedDocumentPin[]> {
	const pins = new Map<string, PersistedDocumentPin[]>();
	for (const entry of messages) {
		if (!entry || typeof entry !== "object") continue;
		const message = entry as MessageBodySource & {
			id?: string;
			narratorId?: string;
			toolCalls?: unknown[];
		};
		for (const [records, blocks] of [
			[message.toolCalls, false],
			[messageBody(message), true],
		] as const) {
			for (const raw of records ?? []) {
				if (!raw || typeof raw !== "object") continue;
				const call = raw as {
					id?: string;
					tcId?: string;
					toolUseId?: string;
					type?: string;
					executionAttempt?: number;
				};
				if (blocks && call.type !== "tool_use") continue;
				const id = blocks ? call.id : call.toolUseId;
				if (!id) continue;
				const values = pins.get(id) ?? [];
				values.push({
					narratorId: message.narratorId,
					messageId: message.id,
					toolCallId: blocks ? call.tcId : call.id,
					executionAttempt: call.executionAttempt,
				});
				pins.set(id, values);
			}
		}
	}
	return pins;
}

export function isTextDocumentPersisted(
	ref: import("@shared/pretext-layout/text-document").TextDocumentRef,
	pins: ReadonlyMap<string, readonly PersistedDocumentPin[]>,
): boolean {
	const source = ref.source;
	if (!source) return false;
	return (pins.get(source.toolUseId) ?? []).some((pin) => {
		if (pin.narratorId && pin.narratorId !== source.narratorId) return false;
		if (source.toolCallId) return pin.toolCallId === source.toolCallId;
		if (source.messageId)
			return (
				pin.messageId === source.messageId &&
				(source.executionAttempt === undefined || pin.executionAttempt === source.executionAttempt)
			);
		return (
			source.executionAttempt !== undefined && pin.executionAttempt === source.executionAttempt
		);
	});
}

/** Live chunks in arrival order, for the synthetic message builder. */
export function streamingToolChunks(store: StreamingToolStore): TopLevelStreamingChunk[] {
	return [...store.values()];
}

/**
 * Collect every tool-use id present in the committed rows, nested rows included: a
 * subagent page renders its own tools as top-level, so a nested row can be the
 * persisted owner of a live id.
 */
export function collectPersistedToolUseIds(
	messages: readonly (MessageBodySource & { toolCalls?: unknown })[],
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message) continue;
		if (Array.isArray(message.toolCalls)) {
			for (const call of message.toolCalls) {
				const id = (call as { toolUseId?: unknown } | null)?.toolUseId;
				if (typeof id === "string" && id.length > 0) ids.add(id);
			}
		}
		for (const block of messageBody(message)) {
			const candidate = block as { type?: unknown; id?: unknown } | null;
			if (candidate?.type !== "tool_use") continue;
			if (typeof candidate.id === "string" && candidate.id.length > 0) ids.add(candidate.id);
		}
	}
	return ids;
}
