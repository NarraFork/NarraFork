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
import { useCallback, useEffect, useRef } from "react";
import type { PersistedToolLiveUpdate } from "./useVListStreamingMessage";
import { patchToolLiveOutput } from "./vlist-live-patch";

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
): (update: PersistedToolLiveUpdate) => void {
	const applyRef = useRef(applyLivePatch);
	applyRef.current = applyLivePatch;
	const coalescerRef = useRef<PersistedToolLiveCoalescer | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a narrator switch must start a fresh coalescer
	useEffect(() => {
		const coalescer = new PersistedToolLiveCoalescer({
			apply: (update) => {
				applyRef.current((messages) => patchToolLiveOutput(messages, update.toolUseId, update));
			},
			now: () => Date.now(),
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle),
		});
		coalescerRef.current = coalescer;
		return () => {
			coalescer.dispose();
			if (coalescerRef.current === coalescer) coalescerRef.current = null;
		};
	}, [narratorId]);
	return useCallback((update: PersistedToolLiveUpdate) => {
		coalescerRef.current?.push(update);
	}, []);
}
