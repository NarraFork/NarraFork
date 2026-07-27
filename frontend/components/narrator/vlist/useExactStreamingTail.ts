/**
 * useExactStreamingTail.ts — live streaming tail for the exact-layout shell.
 *
 * The exact shell renders a stable full document (persisted messages → precise
 * heights). Live streaming output is NOT part of that document, so instead of
 * injecting a synthetic message into the layout (which would force a full
 * layout recompute per delta), the shell renders the streaming tail as a small
 * overlay block below the exact canvas. This hook owns the accumulation and
 * returns the synthetic streaming message (or null).
 *
 * Parity target: the band renderer it supersedes only surfaces a plain text
 * tail, so text + reasoning accumulation is enough. Live tool-call chunks are
 * intentionally not folded here; when a tool call is persisted the exact
 * document reload picks it up as a real card.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { buildStreamingMsg, type StreamingBlock } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	applyExactStreamDelta,
	applyExactStreamingSnapshot,
	type StreamDeltaEvent,
} from "./exact-streaming-accumulator";
import {
	resolveStreamingTailRetirement,
	STREAMING_TAIL_RETIRE_TIMEOUT_MS,
} from "./vlist-streaming-tail-retirement";

export interface UseExactStreamingTailOptions {
	/** Only subscribe + accumulate while the narrator is active (working/waiting). */
	enabled: boolean;
	/** A subagent page treats its own (parent-pointing) deltas as top-level. */
	isSubagent?: boolean;
	/**
	 * Top-level message ids in the CURRENTLY COMMITTED document.
	 *
	 * Drives the seamless hand-off: when the persisted assistant message that
	 * supersedes the tail appears here, the tail is released in that same commit —
	 * so there is neither a blank gap (releasing too early) nor a duplicate frame
	 * (releasing too late). See vlist-streaming-tail-retirement.ts for why this is
	 * keyed on message membership rather than on a commit counter.
	 */
	committedMessageIds?: ReadonlySet<string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Accumulate live text/reasoning deltas into a synthetic streaming message.
 * Returns null when there is no active streaming content (or disabled).
 */
export function useExactStreamingTail(
	narratorId: string | undefined,
	options: UseExactStreamingTailOptions,
): NarratorMsg | null {
	const { enabled, isSubagent = false, committedMessageIds = EMPTY_IDS } = options;
	const blocksRef = useRef<StreamingBlock[]>([]);
	const rafRef = useRef(0);
	const [version, setVersion] = useState(0);
	/**
	 * The persisted message we are waiting to see before dropping the tail, plus
	 * when the wait started (for the defensive timeout). Held in a ref because a
	 * pending hand-off must not itself trigger a render — only the actual release
	 * changes what is on screen.
	 */
	const pendingRetireRef = useRef<{ messageId: string; requestedAt: number } | null>(null);
	/**
	 * Arms the defensive timeout for the current pending retirement. Installed by
	 * the effect below (null while streaming is disabled / unmounted), so the WS
	 * handler can schedule the deadline the moment it records a request.
	 */
	const retireDeadlineTimerRef = useRef<((delay: number) => void) | null>(null);

	const flush = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			setVersion((v) => v + 1);
		});
	}, []);

	const clearBlocks = useCallback(() => {
		if (rafRef.current) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = 0;
		}
		pendingRetireRef.current = null;
		if (blocksRef.current.length > 0) {
			blocksRef.current = [];
			setVersion((v) => v + 1);
		}
	}, []);

	// Reset accumulation whenever the target narrator changes or streaming is
	// disabled (e.g. the narrator left the active state, or on unmount).
	useEffect(() => {
		if (!enabled) clearBlocks();
		return () => clearBlocks();
	}, [enabled, clearBlocks]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId reset is intentional
	useEffect(() => {
		clearBlocks();
	}, [narratorId, clearBlocks]);

	const subscriptionId = enabled ? narratorId : undefined;
	useNarratorWS(
		subscriptionId,
		{
			onStreamEvent: (wsData: { event?: Record<string, unknown>; [key: string]: unknown }) => {
				if (applyExactStreamDelta(blocksRef.current, wsData.event as StreamDeltaEvent, isSubagent))
					flush();
			},
			onStreamingSnapshot: (snapshot) => {
				if (
					applyExactStreamingSnapshot(
						blocksRef.current,
						snapshot.streamingBlocks as StreamingBlock[],
					)
				)
					flush();
			},
			onStreamingReset: (parentToolUseId) => {
				// The owning page receives the reset without a parentToolUseId; the
				// parent-page duplicate keeps it set and must be ignored here.
				if (parentToolUseId) return;
				clearBlocks();
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				// A persisted top-level assistant message supersedes the tail — but the
				// real card only exists once the document reload commits. Clearing here
				// would open a blank window for the whole round-trip, so we only REQUEST
				// retirement and let the layout effect below release the tail in the same
				// commit that brings the replacement in.
				const message = wsData.message;
				if (message?.role === "assistant" && !message.parentToolUseId && message.id) {
					// A later message wins: an earlier one is necessarily in the same
					// document, so waiting for the newest covers both.
					pendingRetireRef.current = { messageId: message.id, requestedAt: Date.now() };
					// Arm the defensive deadline from HERE, so it expires exactly
					// STREAMING_TAIL_RETIRE_TIMEOUT_MS after the request.
					retireDeadlineTimerRef.current?.(STREAMING_TAIL_RETIRE_TIMEOUT_MS);
				}
			},
			onStatusChange: (status) => {
				if (status !== "working" && status !== "waiting") clearBlocks();
			},
			onNarratorError: () => clearBlocks(),
		},
		undefined,
		{ kind: "messages" },
	);

	// Release the tail in the SAME commit that paints its replacement.
	//
	// A layout effect (not a passive one) is required: it runs after the DOM is
	// updated with the new document but BEFORE paint, so the frame the reader sees
	// contains the real card and no tail. A passive effect would paint once with
	// both present — a visible duplicate — and then remove the tail.
	useLayoutEffect(() => {
		const pending = pendingRetireRef.current;
		if (!pending) return;
		const decision = resolveStreamingTailRetirement({
			pendingRetireMessageId: pending.messageId,
			committedMessageIds,
			elapsedMs: Date.now() - pending.requestedAt,
			timeoutMs: STREAMING_TAIL_RETIRE_TIMEOUT_MS,
		});
		if (decision.retire) clearBlocks();
	}, [committedMessageIds, clearBlocks]);

	// Defensive sweep for the timeout branch. The layout effect above only re-runs
	// when the document changes, so a replacement that never arrives (failed / 409
	// reload) would otherwise leave the tail pinned indefinitely with nothing to
	// re-trigger it.
	//
	// Scheduled EXACTLY, not polled. A periodic sweep at the timeout's own period
	// can only notice a request one full period after it was made — a request that
	// lands 1ms after a tick waits ~2 × timeout (nearly 6s of frozen streaming text
	// against a documented 3s bound). A one-shot timer armed at the moment the
	// request is made fires when the deadline is actually reached, and there is no
	// timer running at all while nothing is pending.
	useEffect(() => {
		if (!enabled) {
			retireDeadlineTimerRef.current = null;
			return;
		}
		let timer: ReturnType<typeof setTimeout> | null = null;
		const arm = (delay: number) => {
			timer = setTimeout(
				() => {
					timer = null;
					const pending = pendingRetireRef.current;
					if (!pending) return;
					const remaining = STREAMING_TAIL_RETIRE_TIMEOUT_MS - (Date.now() - pending.requestedAt);
					// A later request superseded the one this timer was armed for; wait out
					// the remainder of the new deadline instead of releasing early.
					if (remaining > 0) {
						arm(remaining);
						return;
					}
					clearBlocks();
				},
				Math.max(0, delay),
			);
		};
		// Published so the WS handler can arm the timer the instant it records a
		// pending retirement, rather than waiting for the next render.
		retireDeadlineTimerRef.current = arm;
		// A request recorded before this effect ran still needs its deadline.
		const pending = pendingRetireRef.current;
		if (pending) {
			arm(STREAMING_TAIL_RETIRE_TIMEOUT_MS - (Date.now() - pending.requestedAt));
		}
		return () => {
			retireDeadlineTimerRef.current = null;
			if (timer) clearTimeout(timer);
		};
	}, [enabled, clearBlocks]);

	return useMemo<NarratorMsg | null>(() => {
		void version; // re-read the mutable ref each version bump
		if (!enabled || blocksRef.current.length === 0 || !narratorId) return null;
		return buildStreamingMsg({
			streamingBlocks: blocksRef.current,
			toolChunksMsg: null,
			narratorId,
		});
	}, [enabled, narratorId, version]);
}
