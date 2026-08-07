/**
 * mock-stream-store.ts — Tiny external store holding "which narrator currently
 * has a mock run in flight", plus that run's live stats.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Why a store rather than local panel state
 * ----------------------------------------
 * `useVListStreamingMessage` only subscribes while the page reports the narrator
 * as ACTIVE (`status === "working" | "waiting"`). A mock run does not touch the
 * database, so the narrator stays `idle` and the streaming tail would never
 * mount. NarratorPanel therefore ORs this store's flag into its `isActive`.
 *
 * Faking activity by injecting a `status_change` frame instead does not work:
 * `useNarratorPanelWS.onStatusChange` invalidates the narrator query, and the
 * refetch immediately restores `idle`.
 *
 * The panel that drives the run and the panel that consumes `isActive` are
 * dockview SIBLINGS (no shared React parent), which is the second reason this is
 * a module-level store rather than context.
 */

import { useSyncExternalStore } from "react";

export interface MockStreamStats {
	/** Frames dispatched so far in the current/last run. */
	frames: number;
	/** Visible characters dispatched so far. */
	chars: number;
	/** Total steps in the loaded script. */
	totalSteps: number;
	/** Total visible characters the loaded script will deliver. */
	totalChars: number;
	/** Wall-clock ms since the run started (frozen when not running). */
	elapsedMs: number;
}

const EMPTY_STATS: MockStreamStats = {
	frames: 0,
	chars: 0,
	totalSteps: 0,
	totalChars: 0,
	elapsedMs: 0,
};

interface MockStreamState {
	/** Narrator id with a run in flight, or null when idle. */
	activeNarratorId: string | null;
	stats: MockStreamStats;
}

let state: MockStreamState = { activeNarratorId: null, stats: EMPTY_STATS };

const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Mark a narrator as having a mock run in flight (or clear it with null). */
export function setMockStreamActiveNarrator(narratorId: string | null): void {
	if (state.activeNarratorId === narratorId) return;
	state = { ...state, activeNarratorId: narratorId };
	emit();
}

export function setMockStreamStats(stats: MockStreamStats): void {
	state = { ...state, stats };
	emit();
}

export function resetMockStreamStats(totalSteps: number, totalChars: number): void {
	state = { ...state, stats: { ...EMPTY_STATS, totalSteps, totalChars } };
	emit();
}

function getSnapshot(): MockStreamState {
	return state;
}

/**
 * Whether `narratorId` currently has a mock run in flight.
 *
 * `enabled` short-circuits to `false` so the production path pays nothing when
 * the mock preference is off: the subscription still runs (hooks must be
 * unconditional) but the value is constant.
 */
export function useMockStreamActive(narratorId: string | undefined, enabled: boolean): boolean {
	const active = useSyncExternalStore(
		subscribe,
		() => getSnapshot().activeNarratorId,
		() => null,
	);
	if (!enabled || !narratorId) return false;
	return active === narratorId;
}

/** Live stats for the panel's readout. */
export function useMockStreamStats(): MockStreamStats {
	return useSyncExternalStore(
		subscribe,
		() => getSnapshot().stats,
		() => EMPTY_STATS,
	);
}
