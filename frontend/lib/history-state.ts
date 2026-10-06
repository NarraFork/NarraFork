import type { HistoryLocation, HistoryState, RouterHistory } from "@tanstack/react-router";
import {
	type AppHistoryStatePatch,
	asHistoryState,
	type BrowserHistoryTarget,
	type CompatibleHistoryState,
	createAppHistoryEntryKey,
	currentBrowserHref,
	mergeAppHistoryState,
} from "./history-entry";

/**
 * Ephemeral same-URL history entries ("sentinels") so hardware/gesture Back dismisses a mobile
 * overlay instead of navigating away. Entry-identity helpers live in `./history-entry`; using
 * those does not pull in anything from this file.
 *
 * Deliberate tradeoffs, taken to keep this module small:
 * - **One sentinel entry per history.** An overlay opening while another is already open joins the
 *   live entry instead of stacking its own, so a single Back closes both rather than unwinding
 *   them one at a time. Every call site is gated on a mobile viewport and all three overlays cover
 *   the screen, so concurrent overlays are not reachable in practice.
 * - **No recovery across a reload.** Reloading with an overlay open leaves one orphaned same-URL
 *   entry behind, so the first Back after such a reload can appear to do nothing.
 * - **No index inference for foreign entries.** A native/external `pushState` landing a
 *   metadata-free entry is rebased to index 0 (see `normalizeCurrentHistoryEntry`) instead of
 *   having its true position reconstructed from the Navigation API.
 */
export const APP_HISTORY_SENTINEL = {
	mobileNav: "mobileNav",
	terminalDrawer: "terminalDrawer",
	contentViewerFullscreen: "contentViewerFullscreen",
} as const;

export type AppHistorySentinel = (typeof APP_HISTORY_SENTINEL)[keyof typeof APP_HISTORY_SENTINEL];

/** Strip every sentinel-owned key so a destination entry never inherits overlay state. */
const SENTINEL_STATE_PATCH = {
	mobileNav: null,
	terminalDrawer: null,
	contentViewerFullscreen: null,
	__NF_scroll_key: null,
	__NF_sentinel_id: null,
} satisfies AppHistoryStatePatch;

export interface HistorySentinelController {
	/** Consume the ephemeral entry when the overlay closes itself. Safe to call repeatedly. */
	dispose: () => void;
}

function isValidHistoryKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidHistoryIndex(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function locationSentinelId(location: Pick<HistoryLocation, "state">): string | undefined {
	const id = location.state.__NF_sentinel_id;
	return isValidHistoryKey(id) ? id : undefined;
}

/**
 * TanStack only repairs entries that have neither router key when createBrowserHistory starts.
 * A later native/external pushState can introduce partial or non-finite metadata, and
 * `history.push` derives the next index from whatever it finds
 * (`assignKeyAndIndex(currentIndex + 1, …)` in @tanstack/history), so a missing or Infinity index
 * permanently poisons Back/Forward delta detection with NaN. Repair the current native entry
 * before any sentinel work.
 */
export function normalizeCurrentHistoryEntry(
	history: RouterHistory,
	target: BrowserHistoryTarget = window,
): CompatibleHistoryState {
	const currentState = asHistoryState(target.history.state);
	const routerKey = isValidHistoryKey(currentState.__TSR_key)
		? currentState.__TSR_key
		: isValidHistoryKey(currentState.key)
			? currentState.key
			: isValidHistoryKey(currentState.__NF_history_key)
				? currentState.__NF_history_key
				: createAppHistoryEntryKey();
	// A metadata-free entry has no knowable position, so rebase that isolated segment to zero.
	// This is a conservative canGoBack=false degradation: subsequent sentinel PUSH/BACK deltas stay
	// internally correct and every app-owned sentinel/scroll key survives.
	const routerIndex = isValidHistoryIndex(currentState.__TSR_index) ? currentState.__TSR_index : 0;
	const normalizedState = {
		...currentState,
		key: routerKey,
		__TSR_key: routerKey,
		__TSR_index: routerIndex,
	};
	if (
		currentState.key !== routerKey ||
		currentState.__TSR_key !== routerKey ||
		currentState.__TSR_index !== routerIndex
	) {
		target.history.replaceState(normalizedState, "", currentBrowserHref(target));
	}

	const routerState = asHistoryState(history.location.state);
	if (
		!isValidHistoryKey(routerState.__TSR_key) ||
		routerState.key !== routerState.__TSR_key ||
		!isValidHistoryIndex(routerState.__TSR_index)
	) {
		throw new Error("Failed to normalize the current TanStack history entry");
	}
	return routerState;
}

interface SentinelRequest {
	sentinel: AppHistorySentinel;
	target: BrowserHistoryTarget;
	/** One `onPop` per live controller sharing the entry. */
	observers: Set<() => void>;
}

interface SentinelEntry extends SentinelRequest {
	id: string;
	/** A Back was issued for this entry and its POP has not landed yet. */
	consuming: boolean;
}

interface SentinelHost {
	history: RouterHistory;
	entry?: SentinelEntry;
	/** Overlays that opened while a Back was in flight, and the navigation held back for it. */
	queued?: SentinelRequest;
	pending?: { action: "PUSH" | "REPLACE"; href: string; state: HistoryState };
	teardown: () => void;
}

const sentinelHosts = new WeakMap<RouterHistory, SentinelHost>();

function notifyObservers(observers: Iterable<() => void>): void {
	for (const observer of observers) {
		try {
			observer();
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}
}

function teardownIfIdle(host: SentinelHost): void {
	if (host.entry || host.queued || host.pending) return;
	sentinelHosts.delete(host.history);
	host.teardown();
}

function activateEntry(host: SentinelHost, request: SentinelRequest): void {
	const baseState = normalizeCurrentHistoryEntry(host.history, request.target);
	const scrollKey =
		baseState.__NF_scroll_key ??
		baseState.__NF_history_key ??
		baseState.__TSR_key ??
		(baseState.key as string);
	const id = createAppHistoryEntryKey();
	host.entry = { ...request, id, consuming: false };
	host.history.push(
		host.history.location.href,
		mergeAppHistoryState(baseState, {
			[request.sentinel]: true,
			__NF_scroll_key: scrollKey,
			__NF_sentinel_id: id,
		}),
		{ ignoreBlocker: true },
	);
	host.history.flush();
	if (locationSentinelId(host.history.location) !== id) {
		host.entry = undefined;
		throw new Error("TanStack History did not create the requested sentinel entry");
	}
}

/**
 * Retire the live entry. Which overlays get an `onPop` is decided when the POP lands, from the
 * observers still registered then, so one that closed itself meanwhile is not told to close again.
 */
function consumeEntry(host: SentinelHost): void {
	const entry = host.entry;
	if (!entry || entry.consuming) return;
	entry.consuming = true;
	host.history.back({ ignoreBlocker: true });
}

/**
 * Land on the blocked destination, first closing every overlay that queued behind the traversal
 * (including any opened reentrantly from those callbacks) so none outlives the route change.
 */
function replayPendingNavigation(host: SentinelHost): void {
	const pending = host.pending;
	if (!pending) return;
	while (host.queued) {
		const queued = host.queued;
		host.queued = undefined;
		notifyObservers(queued.observers);
	}
	host.pending = undefined;
	if (pending.action === "REPLACE") {
		host.history.replace(pending.href, pending.state, { ignoreBlocker: true });
	} else {
		host.history.push(pending.href, pending.state, { ignoreBlocker: true });
	}
	host.history.flush();
	teardownIfIdle(host);
}

function getSentinelHost(history: RouterHistory): SentinelHost {
	const existing = sentinelHosts.get(history);
	if (existing) return existing;
	const host: SentinelHost = { history, teardown: () => {} };

	const unblock = history.block({
		enableBeforeUnload: false,
		blockerFn: ({ currentLocation, nextLocation, action }) => {
			if (action !== "PUSH" && action !== "REPLACE") return false;
			const entry = host.entry;
			if (!entry) return false;
			if (!entry.consuming && locationSentinelId(currentLocation) !== entry.id) return false;
			// Replaying now would strand the ephemeral entry underneath the destination and make the
			// next Back look like a no-op, so hold the navigation until its POP lands.
			host.pending ??= {
				action,
				href: nextLocation.href,
				state: mergeAppHistoryState(nextLocation.state, SENTINEL_STATE_PATCH),
			};
			consumeEntry(host);
			return true;
		},
	});

	const unsubscribe = history.subscribe(({ location, action }) => {
		if (action.type === "PUSH" || action.type === "REPLACE") return;
		const entry = host.entry;
		if (!entry || locationSentinelId(location) === entry.id) return;
		// The ephemeral entry is gone: either Back reached it, or a dispose/navigation already
		// closed the overlays and issued the Back that just landed.
		host.entry = undefined;
		notifyObservers(entry.observers);
		if (host.pending) {
			replayPendingNavigation(host);
			return;
		}
		const queued = host.queued;
		host.queued = undefined;
		if (!queued) {
			teardownIfIdle(host);
			return;
		}
		try {
			activateEntry(host, queued);
		} catch (error) {
			teardownIfIdle(host);
			queueMicrotask(() => {
				throw error;
			});
		}
	});

	host.teardown = () => {
		unblock();
		unsubscribe();
	};
	sentinelHosts.set(history, host);
	return host;
}

function releaseObserver(host: SentinelHost, observer: () => void): void {
	if (host.entry?.observers.delete(observer)) {
		if (host.entry.observers.size === 0) consumeEntry(host);
		return;
	}
	if (host.queued?.observers.delete(observer) && host.queued.observers.size === 0) {
		host.queued = undefined;
		teardownIfIdle(host);
	}
}

/**
 * Push an ephemeral same-URL entry carrying valid TanStack metadata so Back closes `sentinel`'s
 * overlay. `onPop` fires when Back or a route navigation consumes that entry; call `dispose()`
 * when the overlay closes itself so the entry never outlives it.
 */
export function pushHistorySentinel(
	history: RouterHistory,
	sentinel: AppHistorySentinel,
	onPop: () => void,
	target: BrowserHistoryTarget = window,
): HistorySentinelController {
	const host = getSentinelHost(history);
	// Wrapped so two overlays sharing one callback identity stay independently disposable.
	const observer = () => onPop();

	if (host.entry && !host.entry.consuming) {
		// Joins the live entry: the flag records which overlay created it, not the full set.
		host.entry.observers.add(observer);
	} else if (host.entry || host.pending) {
		if (host.queued) host.queued.observers.add(observer);
		else host.queued = { sentinel, target, observers: new Set([observer]) };
	} else {
		try {
			activateEntry(host, { sentinel, target, observers: new Set([observer]) });
		} catch (error) {
			teardownIfIdle(host);
			throw error;
		}
	}
	return { dispose: () => releaseObserver(host, observer) };
}
