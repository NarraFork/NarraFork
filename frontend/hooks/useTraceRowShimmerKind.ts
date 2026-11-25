import {
	resolveToolShimmerFlash,
	resolveToolShimmerPhase,
	TOOL_SHIMMER_QUEUED_EXIT_MS,
	type ToolShimmerFlash,
	type ToolShimmerKind,
	TRACE_SHIMMER_FLASH_HOLD_MS,
} from "@shared/tool-shimmer";
import { useEffect, useRef, useState } from "react";

/** Lifecycle facts shared by trace rows, without depending on either render surface. */
export interface TraceRowShimmerInput {
	status?: string | null;
	reflectionStatus?: string | null;
	queuedBehindUpstream?: boolean;
	shimmer?: boolean;
}

/**
 * The shimmer STATE of one row, or null for a quiet row.
 *
 * Returns the KIND rather than a class name so each surface can name the state for
 * readers who do not get the colour, and map it to its own class table.
 *
 * `row.shimmer` remains the streaming signal for rows with NO lifecycle (reasoning
 * steps): the adapter sets it on the live step, and those rows carry no status at
 * all, so the resolver has nothing to say about them.
 *
 * A fresh mount never flashes (`prev === null` in `resolveToolShimmerFlash`). Virtual
 * rows mount and unmount constantly while scrolling; a mount-triggered flash would
 * light up whole screens of settled history.
 */
export function useTraceRowShimmerKind(row: TraceRowShimmerInput): ToolShimmerKind | null {
	const status = row.status;
	const prevStatusRef = useRef<string | null | undefined>(null);
	const [flash, setFlash] = useState<ToolShimmerFlash | null>(null);
	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status;
		const next = resolveToolShimmerFlash(prev, status);
		// A transition with no flash CLEARS the stored one; it must not just bail.
		// The timer that would have cleared it is torn down by this effect's own
		// cleanup, so a flash that was outranked by a live `phase` below (a retry
		// landing inside the window: running → fail → running) survived indefinitely
		// and replayed on the NEXT quiet status. `running → fail → running →
		// cancelled` flashed red on the cancellation — precisely the transition that
		// must never flash — and `running → success → running → pending` flashed
		// green on a row waiting for the reader's approval.
		if (!next) {
			setFlash(null);
			return;
		}
		setFlash(next);
		// Keep the class past the shared CSS duration so the highlight is never cut off.
		const timer = setTimeout(() => setFlash(null), TRACE_SHIMMER_FLASH_HOLD_MS);
		return () => clearTimeout(timer);
	}, [status]);

	const phase = resolveToolShimmerPhase({
		status,
		// The row's only disambiguation for a `pending` tool: without it a deliberating
		// gate would fall silent instead of turning purple.
		reflectionStatus: row.reflectionStatus ?? null,
		// The caller resolves this from the real sibling prefix; a folded row cannot
		// see its peers, so it passes the verdict rather than a synthesized peer list.
		queuedBehindUpstream: row.queuedBehindUpstream,
	});
	// Leaving queued dissolves the slate tint instead of cutting the pulse mid-cycle.
	const isQueued = phase === "queued";
	const prevQueuedRef = useRef(false);
	const [queuedExit, setQueuedExit] = useState(false);
	useEffect(() => {
		const wasQueued = prevQueuedRef.current;
		prevQueuedRef.current = isQueued;
		if (isQueued) {
			setQueuedExit(false);
			return;
		}
		if (wasQueued) {
			setQueuedExit(true);
			const timer = setTimeout(() => setQueuedExit(false), TOOL_SHIMMER_QUEUED_EXIT_MS);
			return () => clearTimeout(timer);
		}
		// Non-queued phase changes must not cancel the exit timer (e.g. running → success).
	}, [isQueued]);
	// The leave-fade outranks a live phase for one short window: the parked mark
	// must finish dissolving before the next sweep paints over it. A re-entry into
	// queued cancels the fade (handled above).
	if (queuedExit && phase !== "queued") return "queued_out";
	// A live phase outranks a pending flash (a retry that resumed inside the window).
	if (phase) return phase;
	if (flash) return flash;
	// No lifecycle of its own: fall back to the adapter's live-row marker.
	return row.shimmer ? "streaming" : null;
}
