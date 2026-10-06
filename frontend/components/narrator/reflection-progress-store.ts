/**
 * reflection-progress-store.ts — RENDER-ONLY store for live reflection-gate
 * progress ("thinking · N chars" → "N chars").
 *
 * WHY A STORE RATHER THAN MESSAGE STATE
 *
 * Every other reflection lifecycle event (`*_reflection_started` / `_stopped` /
 * `_resolved`) is merged into the loaded message tree, which in the exact vlist
 * means a document rebuild. Progress cannot go there: it fires on a throttled
 * cadence (~8×/s per running gate), so routing it through the document would
 * re-run the layout pipeline several times a second for a label that never
 * changes any height. `vlist-live-wiring.test.ts` pins this as an invariant by
 * asserting `onReflectionProgress` never appears in the live-patch hook.
 *
 * So progress lives OUTSIDE both message trees, in this module-level map, and is
 * read directly by the render layers through `useSyncExternalStore` — the same
 * escape hatch `ElapsedTimer` uses for a running tool's ticking duration: a value
 * that changes constantly, is painted inside an already-measured fixed slot, and
 * therefore must never reach the measure path.
 *
 * WHY IT LIVES OUTSIDE vlist/
 *
 * Both renderers need it (the chunked `ReflectionNotice` and the exact
 * `RenderReflectionNotice`), and `vlist-isolation.guard.test.ts` forbids anything
 * outside `vlist/` from statically importing into it. A shared module in the
 * narrator directory is the only placement that lets both paths read one store.
 *
 * Keyed by gate `requestId` (what the WS event and both notices carry). Entries
 * are dropped when the gate resolves and when the narrator changes, so the map
 * stays bounded by the number of gates in flight.
 */

import type { ProgressSnapshot } from "@shared/progress-phase";
import { useSyncExternalStore } from "react";

type Listener = () => void;

const snapshots = new Map<string, ProgressSnapshot>();
const listeners = new Map<string, Set<Listener>>();

function notify(requestId: string): void {
	const subscribers = listeners.get(requestId);
	if (!subscribers) return;
	for (const listener of subscribers) listener();
}

function sameSnapshot(a: ProgressSnapshot | undefined, b: ProgressSnapshot): boolean {
	return (
		!!a &&
		a.phase === b.phase &&
		a.thinkingChars === b.thinkingChars &&
		a.outputChars === b.outputChars
	);
}

/** Record a progress tick for a gate. No-ops when nothing actually moved. */
export function setReflectionProgress(requestId: string, snapshot: ProgressSnapshot): void {
	if (!requestId) return;
	if (sameSnapshot(snapshots.get(requestId), snapshot)) return;
	snapshots.set(requestId, snapshot);
	notify(requestId);
}

/** Drop a gate's progress (it resolved, or the user took over). */
export function clearReflectionProgress(requestId: string): void {
	if (!requestId || !snapshots.has(requestId)) return;
	snapshots.delete(requestId);
	notify(requestId);
}

/**
 * Drop every entry — used on narrator switch/unmount. A provider request id can
 * legitimately recur across narrators, so leaving stale entries behind could show
 * one narrator's progress on another's card.
 */
export function clearAllReflectionProgress(): void {
	if (snapshots.size === 0) return;
	const affected = [...snapshots.keys()];
	snapshots.clear();
	for (const requestId of affected) notify(requestId);
}

export function getReflectionProgress(requestId: string): ProgressSnapshot | undefined {
	return snapshots.get(requestId);
}

function subscribe(requestId: string, listener: Listener): () => void {
	let subscribers = listeners.get(requestId);
	if (!subscribers) {
		subscribers = new Set();
		listeners.set(requestId, subscribers);
	}
	subscribers.add(listener);
	return () => {
		subscribers?.delete(listener);
		if (subscribers && subscribers.size === 0) listeners.delete(requestId);
	};
}

/**
 * Subscribe to one gate's live progress. Returns `undefined` while no tick has
 * arrived (or after the gate resolved), which renders no progress fragment at
 * all — the label is additive, never a placeholder.
 */
export function useReflectionProgress(requestId: string | undefined): ProgressSnapshot | undefined {
	return useSyncExternalStore(
		(listener) => (requestId ? subscribe(requestId, listener) : () => {}),
		() => (requestId ? snapshots.get(requestId) : undefined),
		() => undefined,
	);
}
