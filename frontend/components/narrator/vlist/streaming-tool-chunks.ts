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
	getStreamingFieldPreview,
	getToolOutputPreview,
	type TopLevelStreamingChunk,
} from "../narrator-message-helpers";

/** Live per-tool state for the streaming row, keyed by toolUseId in arrival order. */
export type StreamingToolStore = Map<string, TopLevelStreamingChunk>;

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
	streamingField?: { name: string; delta: string };
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

	let streamingFieldName = existing?.streamingFieldName;
	let streamingFieldValue = existing?.streamingFieldValue;
	if (event.streamingField) {
		const sameField = streamingFieldName === event.streamingField.name;
		streamingFieldName = event.streamingField.name;
		streamingFieldValue = getStreamingFieldPreview(
			sameField
				? `${streamingFieldValue ?? ""}${event.streamingField.delta}`
				: event.streamingField.delta,
		);
	}

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
		...(event.extractedFields !== undefined ? { extractedFields: event.extractedFields } : {}),
		...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
		...(streamingFieldName !== undefined ? { streamingFieldName } : {}),
		...(streamingFieldValue !== undefined ? { streamingFieldValue } : {}),
	});
	return true;
}

export interface ToolStartedEvent {
	toolUseId: string;
	toolName: string;
	streamStartedAt?: number;
	input?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

/**
 * Promote a tool to RUNNING. From here the card renders as a real tool card with
 * its resolved input rather than an argument-progress placeholder.
 */
export function applyStreamingToolStarted(
	store: StreamingToolStore,
	event: ToolStartedEvent,
): boolean {
	if (!event.toolUseId) return false;
	const existing = store.get(event.toolUseId);
	store.set(event.toolUseId, {
		toolUseId: event.toolUseId,
		toolName: event.toolName || existing?.toolName || "Tool",
		inputCharsTotal: existing?.inputCharsTotal ?? 0,
		...existing,
		_started: true,
		_status: "running",
		...(event.input ? { _input: event.input } : {}),
		...(event.streamStartedAt != null ? { _startedAt: event.streamStartedAt } : {}),
		...(event.metadata ? { _metadata: event.metadata } : {}),
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
		...(event.updatedInput ? { _input: event.updatedInput } : {}),
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
