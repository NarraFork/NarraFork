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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { buildStreamingMsg, type StreamingBlock } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	applyExactStreamDelta,
	applyExactStreamingSnapshot,
	type StreamDeltaEvent,
} from "./exact-streaming-accumulator";

export interface UseExactStreamingTailOptions {
	/** Only subscribe + accumulate while the narrator is active (working/waiting). */
	enabled: boolean;
	/** A subagent page treats its own (parent-pointing) deltas as top-level. */
	isSubagent?: boolean;
}

/**
 * Accumulate live text/reasoning deltas into a synthetic streaming message.
 * Returns null when there is no active streaming content (or disabled).
 */
export function useExactStreamingTail(
	narratorId: string | undefined,
	options: UseExactStreamingTailOptions,
): NarratorMsg | null {
	const { enabled, isSubagent = false } = options;
	const blocksRef = useRef<StreamingBlock[]>([]);
	const rafRef = useRef(0);
	const [version, setVersion] = useState(0);

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
				// A persisted top-level assistant message ends the current stream; the
				// exact document reload (driven by the shell) will surface it as real
				// content, so drop the synthetic tail to avoid a duplicate frame.
				const message = wsData.message;
				if (message?.role === "assistant" && !message.parentToolUseId) clearBlocks();
			},
			onStatusChange: (status) => {
				if (status !== "working" && status !== "waiting") clearBlocks();
			},
			onNarratorError: () => clearBlocks(),
		},
		undefined,
		{ kind: "messages" },
	);

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
