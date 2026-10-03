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
import {
	handoffStreamingEditOrigin,
	type StreamingEditOrigin,
} from "@shared/streaming-edit-origin";
import type { ToolProgressPayload } from "@shared/tool-progress";
import {
	isLiveToolStatusRegression,
	LIVE_TOOL_PHASE_RANK,
	mergeToolLifecycleRecord,
} from "@shared/tool-row-status";
import {
	completeStreamingFieldRanges,
	foldStreamingToolFields,
	getToolOutputPreview,
	type TopLevelStreamingChunk,
} from "../narrator-message-helpers";

/** Live per-tool state for the streaming row, keyed by toolUseId in arrival order. */
export type StreamingToolStore = Map<string, TopLevelStreamingChunk>;

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

export interface ToolChunkEvent {
	toolUseId: string;
	toolName: string;
	inputCharsTotal: number;
	extractedFilePath?: string;
	contentCharsReceived?: number;
	extractedFields?: Record<string, string>;
	metadata?: Record<string, unknown>;
	/** One delta of a field being streamed (accumulated across frames). */
	streamingField?: { name: string; delta: string; startsField?: boolean };
}

/**
 * Fold a `tool_use_chunk` (the model is writing this tool's arguments).
 *
 * `streamingField` arrives as DELTAS and must accumulate; every other field is a
 * running total the server recomputes, so it is simply overwritten.
 */
export function applyStreamingToolChunk(store: StreamingToolStore, event: ToolChunkEvent): boolean {
	if (!event.toolUseId) return false;
	const existing = store.get(event.toolUseId);
	// A promoted tool (started/completed) owns its state through the lifecycle
	// events below; a late argument chunk must not demote it back to "streaming".
	if (existing?._started) return false;

	const fields = foldStreamingToolFields(existing, event);

	store.set(event.toolUseId, {
		...existing,
		toolUseId: event.toolUseId,
		toolName: event.toolName,
		inputCharsTotal: event.inputCharsTotal,
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
	if (!event.toolUseId) return false;
	const existing = store.get(event.toolUseId);
	store.set(event.toolUseId, {
		inputCharsTotal: existing?.inputCharsTotal ?? 0,
		...existing,
		toolUseId: event.toolUseId,
		// AFTER the spread, not before: `applyStreamingToolExecuting` may have created this
		// entry with a placeholder name (it gets no name of its own), and `...existing`
		// would otherwise let that placeholder shadow the real one this event carries.
		toolName: event.toolName || existing?.toolName || UNKNOWN_TOOL_NAME,
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
): boolean {
	if (store.size === 0 || persistedToolUseIds.size === 0) return false;
	let changed = false;
	for (const toolUseId of [...store.keys()]) {
		if (!persistedToolUseIds.has(toolUseId)) continue;
		store.delete(toolUseId);
		changed = true;
	}
	return changed;
}

/** Live chunks in arrival order, for the synthetic message builder. */
export function streamingToolChunks(store: StreamingToolStore): TopLevelStreamingChunk[] {
	return [...store.values()];
}

/**
 * Collect every tool-use id present in a committed message tree.
 *
 * Walks children too: a subagent page renders its own tools as top-level, so a
 * child message can be the persisted owner of a live id.
 */
export function collectPersistedToolUseIds(
	messages: readonly {
		toolCalls?: unknown;
		contentJson?: unknown;
		children?: readonly unknown[];
	}[],
): ReadonlySet<string> {
	const ids = new Set<string>();
	const visit = (list: readonly unknown[]): void => {
		for (const entry of list) {
			const message = entry as {
				toolCalls?: unknown;
				contentJson?: unknown;
				children?: readonly unknown[];
			};
			if (Array.isArray(message?.toolCalls)) {
				for (const call of message.toolCalls) {
					const id = (call as { toolUseId?: unknown } | null)?.toolUseId;
					if (typeof id === "string" && id.length > 0) ids.add(id);
				}
			}
			if (Array.isArray(message?.contentJson)) {
				for (const block of message.contentJson) {
					const candidate = block as { type?: unknown; id?: unknown } | null;
					if (candidate?.type !== "tool_use") continue;
					if (typeof candidate.id === "string" && candidate.id.length > 0) ids.add(candidate.id);
				}
			}
			if (Array.isArray(message?.children) && message.children.length > 0) visit(message.children);
		}
	};
	visit(messages);
	return ids;
}
