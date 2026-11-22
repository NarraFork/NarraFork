/**
 * vlist-persisted-tool-live.ts — Live output / progress for tools that are still
 * executing on an already-committed card.
 *
 * The gap this closes
 * -------------------
 * A turn's assistant message is persisted the moment the model finishes the tool
 * call, i.e. just BEFORE the tool starts executing. That retires the synthetic
 * streaming card (useVListStreamingMessage drops every tool whose id the committed
 * document already holds), and the streaming store then ignores `tool_output` /
 * `tool_structured_progress` for that id by design. useVListLivePatches must not
 * take those events either (they fire at streaming frequency). So for the whole
 * execution of a long tool nobody drew its output: the card showed only its input
 * JSON until it finished or was stopped.
 *
 * Design
 * ------
 * The streaming hook hands those orphaned frames here; this module coalesces them
 * per tool (leading edge + trailing timer) and applies ONE live patch per window.
 * The patch writes the same `_streamingOutput` / `_structuredProgress` fields the
 * streaming tail uses, so the committed card measures and paints them through the
 * identical adapter → classifier → measure path, and the detail body's text
 * signature re-keys the cache. The rate is bounded so a chatty tool costs a few
 * single-card rebuilds per second, not one per socket frame.
 */

import type { TreeMessage } from "@frontend/lib/api";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { useCallback, useEffect, useRef } from "react";
import type { PersistedToolLiveUpdate } from "./useVListStreamingMessage";
import { isTerminalToolStatus, type LivePatch, patchToolLiveOutput } from "./vlist-live-patch";

/**
 * The last live body applied to a still-running tool, pinned to the occurrence it
 * was applied to. A canonical window replacement (warm-open revalidation, reload)
 * swaps in fresh page rows that never carry live fields; a quiet tool sends no
 * further frame, so without this its committed card would go blank again.
 */
export interface RetainedLive {
	output?: string;
	progress?: PersistedToolLiveUpdate["progress"];
	rowId?: string;
	executionAttempt?: number;
}

interface ToolRowView {
	id?: unknown;
	/** Tool-call id copied onto the enriched block (page-shaped rows drop `toolCalls`). */
	tcId?: unknown;
	status?: unknown;
	executionAttempt?: unknown;
	_streamingOutput?: unknown;
	_structuredProgress?: unknown;
}

/**
 * Newest loaded occurrence of `toolUseId`. Lifecycle and live fields are read from
 * the enriched `tool_use` block first (the side the adapter reads, same rule as
 * `newestToolStatus`), the occurrence identity from the `toolCalls` row.
 */
export function newestToolRow(
	messages: readonly TreeMessage[],
	toolUseId: string,
): ToolRowView | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message) continue;
		const blocks = messageBody(message) as readonly (ToolRowView & { type?: unknown })[];
		let block: ToolRowView | undefined;
		for (let b = blocks.length - 1; b >= 0 && !block; b--) {
			const candidate = blocks[b];
			if (candidate?.type === "tool_use" && candidate.id === toolUseId) block = candidate;
		}
		const rows = Array.isArray(message.toolCalls) ? message.toolCalls : [];
		let row: ToolRowView | undefined;
		for (let r = rows.length - 1; r >= 0 && !row; r--) {
			const candidate = rows[r] as (ToolRowView & { toolUseId?: unknown }) | undefined;
			if (candidate?.toolUseId === toolUseId) row = candidate;
		}
		if (!block && !row) continue;
		const live = block ?? row;
		// Exact-history pages strip the `toolCalls` relation after enrichment copied the
		// tool-call id onto the block as `tcId`; read it there so a WS-shaped card and
		// its page-shaped replacement resolve to the same occurrence.
		const id = row?.id ?? block?.tcId;
		return {
			...(id !== undefined ? { id } : {}),
			executionAttempt: row?.executionAttempt ?? block?.executionAttempt,
			status: block?.status ?? row?.status,
			_streamingOutput: live?._streamingOutput,
			_structuredProgress: live?._structuredProgress,
		};
	}
	return null;
}

/**
 * Drop retained bodies whose tool finished or whose occurrence changed (a retry
 * under the same toolUseId); keep the ones whose row is merely not loaded.
 */
export function pruneRetainedLive(
	messages: readonly TreeMessage[],
	retained: Map<string, RetainedLive>,
): void {
	for (const [toolUseId, live] of retained) {
		const row = newestToolRow(messages, toolUseId);
		if (!row) continue;
		// Only a KNOWN mismatch is a different occurrence: a side that lacks the field
		// (older payload shape) says nothing either way.
		const sameRow = live.rowId === undefined || row.id === undefined || row.id === live.rowId;
		const sameAttempt =
			live.executionAttempt === undefined ||
			row.executionAttempt === undefined ||
			row.executionAttempt === live.executionAttempt;
		if (isTerminalToolStatus(row.status) || !sameRow || !sameAttempt) retained.delete(toolUseId);
	}
}

/**
 * Re-write retained bodies that a window replacement dropped. Only rows actually
 * missing them are patched, so re-running on the patched document is a no-op
 * (unchanged reference — no rebuild, no effect loop).
 */
export function retainedLivePatch(retained: ReadonlyMap<string, RetainedLive>): LivePatch {
	return (messages) => {
		let current = messages;
		let changed = false;
		for (const [toolUseId, live] of retained) {
			const row = newestToolRow(current, toolUseId);
			if (!row) continue;
			const missing =
				(live.output !== undefined && row._streamingOutput !== live.output) ||
				(live.progress !== undefined && row._structuredProgress !== live.progress);
			if (!missing) continue;
			const result = patchToolLiveOutput(current, toolUseId, live);
			if (!result.changed) continue;
			current = result.messages;
			changed = true;
		}
		return { messages: current, changed };
	};
}

/** Minimum spacing between two patches of the SAME tool. */
export const PERSISTED_TOOL_LIVE_INTERVAL_MS = 400;

type ApplyLivePatch = (
	patch: (messages: readonly TreeMessage[]) => {
		readonly messages: readonly TreeMessage[];
		changed: boolean;
	},
) => boolean;

interface PendingLive {
	output?: string;
	progress?: PersistedToolLiveUpdate["progress"];
	lastAppliedAt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface PersistedToolLiveHost {
	apply: (update: PersistedToolLiveUpdate) => void;
	now: () => number;
	setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Per-tool leading + trailing coalescer. The latest output / progress always lands. */
export class PersistedToolLiveCoalescer {
	private pending = new Map<string, PendingLive>();

	constructor(
		private host: PersistedToolLiveHost,
		private intervalMs = PERSISTED_TOOL_LIVE_INTERVAL_MS,
	) {}

	push(update: PersistedToolLiveUpdate): void {
		let state = this.pending.get(update.toolUseId);
		if (!state) {
			this.pruneIdle();
			state = { lastAppliedAt: Number.NEGATIVE_INFINITY, timer: null };
			this.pending.set(update.toolUseId, state);
		}
		if (update.output !== undefined) state.output = update.output;
		if (update.progress !== undefined) state.progress = update.progress;
		if (state.timer) return;
		const wait = state.lastAppliedAt + this.intervalMs - this.host.now();
		if (wait <= 0) {
			this.flushTool(update.toolUseId);
			return;
		}
		state.timer = this.host.setTimer(() => this.flushTool(update.toolUseId), wait);
	}

	private flushTool(toolUseId: string): void {
		const state = this.pending.get(toolUseId);
		if (!state) return;
		state.timer = null;
		if (state.output === undefined && state.progress === undefined) return;
		const update: PersistedToolLiveUpdate = {
			toolUseId,
			...(state.output !== undefined ? { output: state.output } : {}),
			...(state.progress !== undefined ? { progress: state.progress } : {}),
		};
		state.output = undefined;
		state.progress = undefined;
		state.lastAppliedAt = this.host.now();
		this.host.apply(update);
	}

	/**
	 * Forget tools whose window has fully elapsed with nothing pending: they would
	 * apply at once anyway, so keeping their entry only grows the map over a session.
	 */
	private pruneIdle(): void {
		const now = this.host.now();
		for (const [toolUseId, state] of this.pending) {
			if (!state.timer && state.lastAppliedAt + this.intervalMs <= now) {
				this.pending.delete(toolUseId);
			}
		}
	}

	dispose(): void {
		for (const state of this.pending.values()) {
			if (state.timer) this.host.clearTimer(state.timer);
		}
		this.pending.clear();
	}
}

/**
 * Returns the `onPersistedToolLive` sink for useVListStreamingMessage. A narrator
 * switch drops every pending frame: they belong to the previous document.
 */
export function usePersistedToolLive(
	narratorId: string | undefined,
	applyLivePatch: ApplyLivePatch,
	/** The loaded document; a replaced window gets the retained live bodies back. */
	committedMessages?: readonly TreeMessage[],
): (update: PersistedToolLiveUpdate) => void {
	const applyRef = useRef(applyLivePatch);
	applyRef.current = applyLivePatch;
	const messagesRef = useRef(committedMessages);
	messagesRef.current = committedMessages;
	const retainedRef = useRef(new Map<string, RetainedLive>());
	const coalescerRef = useRef<PersistedToolLiveCoalescer | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a narrator switch must start a fresh coalescer
	useEffect(() => {
		const retained = new Map<string, RetainedLive>();
		retainedRef.current = retained;
		const coalescer = new PersistedToolLiveCoalescer({
			apply: (update) => {
				const applied = applyRef.current((messages) =>
					patchToolLiveOutput(messages, update.toolUseId, update),
				);
				if (!applied) return;
				const row = newestToolRow(messagesRef.current ?? [], update.toolUseId);
				const previous = retained.get(update.toolUseId);
				const sameOccurrence = previous && (row?.id === undefined || previous.rowId === row.id);
				retained.set(update.toolUseId, {
					...(sameOccurrence ? previous : {}),
					...(update.output !== undefined ? { output: update.output } : {}),
					...(update.progress !== undefined ? { progress: update.progress } : {}),
					...(typeof row?.id === "string" ? { rowId: row.id } : {}),
					...(typeof row?.executionAttempt === "number"
						? { executionAttempt: row.executionAttempt }
						: {}),
				});
			},
			now: () => Date.now(),
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle),
		});
		coalescerRef.current = coalescer;
		return () => {
			coalescer.dispose();
			retained.clear();
			if (coalescerRef.current === coalescer) coalescerRef.current = null;
		};
	}, [narratorId]);
	// A canonical window replacement drops the live fields; put the still-running
	// occurrences' bodies back. Terminal / re-attempted tools are pruned first.
	useEffect(() => {
		const retained = retainedRef.current;
		if (!committedMessages || retained.size === 0) return;
		pruneRetainedLive(committedMessages, retained);
		if (retained.size === 0) return;
		applyRef.current(retainedLivePatch(retained));
	}, [committedMessages]);
	return useCallback((update: PersistedToolLiveUpdate) => {
		coalescerRef.current?.push(update);
	}, []);
}
