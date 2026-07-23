import type { HistoryLocation, HistoryState, RouterHistory } from "@tanstack/react-router";

export const APP_HISTORY_SENTINEL = {
	mobileNav: "mobileNav",
	terminalDrawer: "terminalDrawer",
	contentViewerFullscreen: "contentViewerFullscreen",
} as const;

export type AppHistorySentinel = (typeof APP_HISTORY_SENTINEL)[keyof typeof APP_HISTORY_SENTINEL];

const APP_HISTORY_ENTRY_KEY = "__NF_history_key" as const;

export interface AppHistoryState {
	mobileNav?: true;
	terminalDrawer?: true;
	contentViewerFullscreen?: true;
	__NF_history_key?: string;
	__NF_scroll_key?: string;
	__NF_sentinel_id?: string;
	__NF_sentinel_version?: 1;
	__NF_sentinel_kind?: AppHistorySentinel;
	__NF_sentinel_base_href?: string;
	__NF_sentinel_base_key?: string;
	__NF_sentinel_base_index?: number;
	__NF_sentinel_base_scroll_key?: string;
	__NF_sentinel_base_navigation_key?: string;
}

declare module "@tanstack/history" {
	interface HistoryState extends AppHistoryState {}
}

export type AppHistoryStatePatch = {
	[K in keyof AppHistoryState]?: AppHistoryState[K] | null;
};

type BrowserHistoryTarget = Pick<Window, "history" | "location"> & {
	navigation?: Pick<Navigation, "currentEntry" | "entries">;
};
type CompatibleHistoryState = HistoryState & {
	key?: string;
	__TSR_key?: string;
	__TSR_index?: number;
};

function asHistoryState(value: unknown): CompatibleHistoryState {
	return value !== null && typeof value === "object" ? (value as CompatibleHistoryState) : {};
}

/** Merge app-owned state without allowing callers to write TanStack's reserved metadata. */
export function mergeAppHistoryState(
	currentState: unknown,
	patch: AppHistoryStatePatch,
): HistoryState {
	const nextState: Record<string, unknown> = { ...asHistoryState(currentState) };
	for (const [key, value] of Object.entries(patch)) {
		if (value == null) {
			delete nextState[key];
		} else {
			nextState[key] = value;
		}
	}
	return nextState as HistoryState;
}

/**
 * Replace the current browser entry while retaining its router metadata and all unrelated state.
 * This intentionally uses the native API: TanStack's `history.replace` allocates a new key.
 */
export function replaceCurrentHistoryState(
	patch: AppHistoryStatePatch,
	href?: string,
	target: BrowserHistoryTarget = window,
): void {
	const currentHref = `${target.location.pathname}${target.location.search}${target.location.hash}`;
	target.history.replaceState(
		mergeAppHistoryState(target.history.state, patch),
		"",
		href ?? currentHref,
	);
}

export function createAppHistoryEntryKey(): string {
	const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `nf-${randomPart}`;
}

function currentBrowserHref(target: BrowserHistoryTarget): string {
	return `${target.location.pathname}${target.location.search}${target.location.hash}`;
}

/**
 * Resolve persisted entry identity without treating equal hrefs as equal entries. When the native
 * entry is legacy metadata-free, callers must supply and then persist their own per-entry fallback.
 */
export function resolveAppShellHistoryEntryKey(
	location: Pick<HistoryLocation, "href" | "state">,
	fallback: string,
	target: BrowserHistoryTarget = window,
): { key: string; needsFallbackPersistence: boolean } {
	if (currentBrowserHref(target) !== location.href) {
		return {
			key:
				location.state.__NF_scroll_key ??
				location.state.__TSR_key ??
				location.state.key ??
				fallback,
			needsFallbackPersistence: false,
		};
	}

	const browserState = asHistoryState(target.history.state);
	const browserTanstackKey = browserState.__TSR_key ?? browserState.key;
	const locationTanstackKey = location.state.__TSR_key ?? location.state.key;
	if (browserTanstackKey && locationTanstackKey && browserTanstackKey !== locationTanstackKey) {
		return {
			key: location.state.__NF_scroll_key ?? locationTanstackKey,
			needsFallbackPersistence: false,
		};
	}

	const scrollKey = browserState.__NF_scroll_key;
	if (scrollKey) return { key: scrollKey, needsFallbackPersistence: false };
	if (browserTanstackKey) return { key: browserTanstackKey, needsFallbackPersistence: false };

	const existingFallback = browserState[APP_HISTORY_ENTRY_KEY];
	if (existingFallback) return { key: existingFallback, needsFallbackPersistence: false };

	return { key: fallback, needsFallbackPersistence: true };
}

export interface HistorySentinelController {
	/** Consume the ephemeral entry when possible. Safe to call repeatedly or during a pending POP. */
	dispose: () => void;
}

const APP_HISTORY_SENTINEL_ID = "__NF_sentinel_id" as const;
const SENTINEL_STATE_PATCH = {
	mobileNav: null,
	terminalDrawer: null,
	contentViewerFullscreen: null,
	__NF_scroll_key: null,
	[APP_HISTORY_SENTINEL_ID]: null,
	__NF_sentinel_version: null,
	__NF_sentinel_kind: null,
	__NF_sentinel_base_href: null,
	__NF_sentinel_base_key: null,
	__NF_sentinel_base_index: null,
	__NF_sentinel_base_scroll_key: null,
	__NF_sentinel_base_navigation_key: null,
} satisfies AppHistoryStatePatch;

function isValidHistoryKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidHistoryIndex(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

interface HistoryIndexTracker {
	target: BrowserHistoryTarget;
	currentIndex: number;
	indexKnown: boolean;
	metadataFreeCurrentObserved: boolean;
	navigationIndexes: Map<string, number>;
	refs: number;
	unsubscribe?: () => void;
}

const historyIndexTrackers = new WeakMap<RouterHistory, HistoryIndexTracker>();

function validNavigationEntryKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function rememberNavigationIndex(tracker: HistoryIndexTracker, index: number): void {
	const key = tracker.target.navigation?.currentEntry?.key;
	if (validNavigationEntryKey(key)) tracker.navigationIndexes.set(key, index);
}

function inferHistoryIndexFromNavigation(tracker: HistoryIndexTracker): number | undefined {
	// NavigationHistoryEntry.getState() is Navigation-API state, not classic history.state. Only
	// entry key/index are usable here, anchored to indexes this module observed in the same session.
	const navigation = tracker.target.navigation;
	const currentEntry = navigation?.currentEntry;
	if (!currentEntry || !isValidHistoryIndex(currentEntry.index)) return;

	try {
		const candidates = new Set<number>();
		for (const entry of navigation.entries()) {
			if (
				!isValidHistoryIndex(entry.index) ||
				entry.sameDocument === false ||
				!validNavigationEntryKey(entry.key)
			) {
				continue;
			}
			const knownIndex = tracker.navigationIndexes.get(entry.key);
			if (!isValidHistoryIndex(knownIndex)) continue;
			const candidate = knownIndex + currentEntry.index - entry.index;
			if (isValidHistoryIndex(candidate)) candidates.add(candidate);
		}
		return candidates.size === 1 ? candidates.values().next().value : undefined;
	} catch {
		// The Navigation API can omit entries outside the active same-origin segment.
		return;
	}
}

function getHistoryIndexTracker(
	history: RouterHistory,
	target: BrowserHistoryTarget,
): HistoryIndexTracker {
	let tracker = historyIndexTrackers.get(history);
	if (tracker) return tracker;
	const initialIndex = asHistoryState(history.location.state).__TSR_index;
	tracker = {
		target,
		currentIndex: isValidHistoryIndex(initialIndex) ? initialIndex : 0,
		indexKnown: isValidHistoryIndex(initialIndex),
		metadataFreeCurrentObserved: false,
		navigationIndexes: new Map(),
		refs: 0,
	};
	if (tracker.indexKnown) rememberNavigationIndex(tracker, tracker.currentIndex);
	historyIndexTrackers.set(history, tracker);
	return tracker;
}

function updateHistoryIndexTracker(
	tracker: HistoryIndexTracker,
	location: Pick<HistoryLocation, "state">,
	action?: "PUSH" | "REPLACE" | "FORWARD" | "BACK" | "GO",
): void {
	const explicitIndex = asHistoryState(location.state).__TSR_index;
	if (isValidHistoryIndex(explicitIndex)) {
		tracker.currentIndex = explicitIndex;
		tracker.indexKnown = true;
		tracker.metadataFreeCurrentObserved = false;
		rememberNavigationIndex(tracker, explicitIndex);
		return;
	}
	const navigationIndex = inferHistoryIndexFromNavigation(tracker);
	if (isValidHistoryIndex(navigationIndex)) {
		tracker.currentIndex = navigationIndex;
		tracker.indexKnown = true;
		tracker.metadataFreeCurrentObserved = true;
		rememberNavigationIndex(tracker, navigationIndex);
		return;
	}
	if (tracker.indexKnown && action === "PUSH") {
		tracker.currentIndex++;
		tracker.metadataFreeCurrentObserved = true;
		rememberNavigationIndex(tracker, tracker.currentIndex);
		return;
	}
	if (tracker.indexKnown && action === "REPLACE") {
		tracker.metadataFreeCurrentObserved = true;
		rememberNavigationIndex(tracker, tracker.currentIndex);
		return;
	}
	tracker.indexKnown = false;
	tracker.metadataFreeCurrentObserved = false;
}

/**
 * Track native pushState/replaceState calls after the app session starts. TanStack synchronously
 * reports those calls as PUSH/REPLACE even when their state omits router metadata. Navigation API
 * entry identity/position is used when available; otherwise the observed action keeps the relative
 * index knowable without treating browser history.length as an absolute app index.
 */
export function installAppHistoryIndexTracking(
	history: RouterHistory,
	target: BrowserHistoryTarget = window,
): () => void {
	const tracker = getHistoryIndexTracker(history, target);
	if (tracker.target.history !== target.history) {
		throw new Error("A RouterHistory cannot track multiple browser history targets");
	}
	tracker.refs++;
	if (!tracker.unsubscribe) {
		tracker.unsubscribe = history.subscribe(({ location, action }) => {
			updateHistoryIndexTracker(tracker, location, action.type);
		});
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		tracker.refs = Math.max(0, tracker.refs - 1);
		if (tracker.refs > 0) return;
		tracker.unsubscribe?.();
		tracker.unsubscribe = undefined;
		historyIndexTrackers.delete(history);
	};
}

/**
 * TanStack only repairs entries that have neither router key when createBrowserHistory starts.
 * Native/external pushState calls can later introduce partial or non-finite metadata, making the
 * next router push allocate a NaN index. Repair the current native entry before sentinel work.
 */
export function normalizeCurrentHistoryEntry(
	history: RouterHistory,
	target: BrowserHistoryTarget = window,
): CompatibleHistoryState {
	const currentState = asHistoryState(target.history.state);
	const tracker = getHistoryIndexTracker(history, target);
	const routerKey = isValidHistoryKey(currentState.__TSR_key)
		? currentState.__TSR_key
		: isValidHistoryKey(currentState.key)
			? currentState.key
			: isValidHistoryKey(currentState.__NF_history_key)
				? currentState.__NF_history_key
				: createAppHistoryEntryKey();
	const inferredIndex =
		inferHistoryIndexFromNavigation(tracker) ??
		(tracker.refs > 0 && tracker.indexKnown && tracker.metadataFreeCurrentObserved
			? tracker.currentIndex
			: undefined);
	// A truly old/foreign metadata-free entry is unknowable without Navigation API data or a
	// session tracker that observed its PUSH. Rebase only that isolated segment to zero: this is a
	// conservative canGoBack=false degradation, while subsequent sentinel PUSH/BACK deltas remain
	// internally correct and all app-owned sentinel/scroll state stays intact.
	const routerIndex = isValidHistoryIndex(currentState.__TSR_index)
		? currentState.__TSR_index
		: (inferredIndex ?? 0);
	const normalizedStatePatch = {
		...currentState,
		key: routerKey,
		__TSR_key: routerKey,
		__TSR_index: routerIndex,
	};
	const needsRepair =
		currentState.key !== routerKey ||
		currentState.__TSR_key !== routerKey ||
		currentState.__TSR_index !== routerIndex;

	if (needsRepair) {
		target.history.replaceState(normalizedStatePatch, "", currentBrowserHref(target));
	}
	updateHistoryIndexTracker(tracker, { state: normalizedStatePatch });

	const normalizedState = asHistoryState(history.location.state);
	if (
		!isValidHistoryKey(normalizedState.__TSR_key) ||
		normalizedState.key !== normalizedState.__TSR_key ||
		!isValidHistoryIndex(normalizedState.__TSR_index)
	) {
		throw new Error("Failed to normalize the current TanStack history entry");
	}
	return normalizedState;
}

const APP_HISTORY_SENTINEL_VERSION = 1 as const;
const HISTORY_TRAVERSAL_TIMEOUT_MS = 2_000;

interface OrphanSentinelDescriptor {
	id: string;
	kind: AppHistorySentinel;
	baseHref: string;
	baseKey: string;
	baseIndex: number;
	baseScrollKey: string;
	baseNavigationKey?: string;
	entryKey: string;
}

export interface OrphanHistorySentinelRecoveryResult {
	status: "none" | "consumed" | "cleared-unverified" | "failed";
	consumed: number;
}

interface OrphanSentinelRecoveryRun {
	pending: boolean;
	promise: Promise<OrphanHistorySentinelRecoveryResult>;
}

const orphanSentinelRecoveryRuns = new WeakMap<RouterHistory, OrphanSentinelRecoveryRun>();

function isAppHistorySentinel(value: unknown): value is AppHistorySentinel {
	return Object.values(APP_HISTORY_SENTINEL).some((sentinel) => sentinel === value);
}

function resolveStateScrollKey(state: CompatibleHistoryState): string | undefined {
	return state.__NF_scroll_key ?? state.__NF_history_key ?? state.__TSR_key ?? state.key;
}

function navigationEntryHref(entry: NavigationHistoryEntry): string | undefined {
	if (!entry.url) return;
	try {
		const url = new URL(entry.url, "https://narrafork.invalid");
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return;
	}
}

function readOrphanSentinelDescriptor(
	history: RouterHistory,
	target: BrowserHistoryTarget,
): OrphanSentinelDescriptor | undefined {
	const state = asHistoryState(target.history.state);
	const id = state[APP_HISTORY_SENTINEL_ID];
	const kind = state.__NF_sentinel_kind;
	const baseHref = state.__NF_sentinel_base_href;
	const baseKey = state.__NF_sentinel_base_key;
	const baseIndex = state.__NF_sentinel_base_index;
	const baseScrollKey = state.__NF_sentinel_base_scroll_key;
	const entryKey = state.__TSR_key;
	const entryIndex = state.__TSR_index;
	if (
		state.__NF_sentinel_version !== APP_HISTORY_SENTINEL_VERSION ||
		!isValidHistoryKey(id) ||
		!isAppHistorySentinel(kind) ||
		state[kind] !== true ||
		typeof baseHref !== "string" ||
		baseHref.length === 0 ||
		!isValidHistoryKey(baseKey) ||
		!isValidHistoryIndex(baseIndex) ||
		!isValidHistoryKey(baseScrollKey) ||
		!isValidHistoryKey(entryKey) ||
		state.key !== entryKey ||
		!isValidHistoryIndex(entryIndex) ||
		entryIndex !== baseIndex + 1 ||
		entryKey === baseKey ||
		state.__NF_scroll_key !== baseScrollKey ||
		history.location.href !== currentBrowserHref(target) ||
		baseHref !== currentBrowserHref(target) ||
		target.history.length <= 1
	) {
		return;
	}

	const navigation = target.navigation;
	const baseNavigationKey = state.__NF_sentinel_base_navigation_key;
	if (navigation) {
		const currentEntry = navigation.currentEntry;
		if (
			!currentEntry ||
			!isValidHistoryIndex(currentEntry.index) ||
			currentEntry.index < 1 ||
			!validNavigationEntryKey(baseNavigationKey)
		) {
			return;
		}
		let previousEntry: NavigationHistoryEntry | undefined;
		try {
			previousEntry = navigation.entries().find((entry) => entry.index === currentEntry.index - 1);
		} catch {
			return;
		}
		if (
			!previousEntry ||
			previousEntry.sameDocument === false ||
			previousEntry.key !== baseNavigationKey ||
			navigationEntryHref(previousEntry) !== baseHref
		) {
			return;
		}
	}

	return {
		id,
		kind,
		baseHref,
		baseKey,
		baseIndex,
		baseScrollKey,
		baseNavigationKey: validNavigationEntryKey(baseNavigationKey) ? baseNavigationKey : undefined,
		entryKey,
	};
}

function hasSentinelState(state: CompatibleHistoryState): boolean {
	return (
		isValidHistoryKey(state[APP_HISTORY_SENTINEL_ID]) ||
		state.__NF_sentinel_version !== undefined ||
		state.__NF_sentinel_kind !== undefined ||
		Object.values(APP_HISTORY_SENTINEL).some((sentinel) => state[sentinel] === true)
	);
}

function clearCurrentSentinelState(history: RouterHistory, target: BrowserHistoryTarget): void {
	normalizeCurrentHistoryEntry(history, target);
	replaceCurrentHistoryState(SENTINEL_STATE_PATCH, currentBrowserHref(target), target);
}

function currentEntryMatchesDescriptor(
	history: RouterHistory,
	descriptor: OrphanSentinelDescriptor,
	target: BrowserHistoryTarget,
): boolean {
	const state = asHistoryState(target.history.state);
	return (
		history.location.href === descriptor.baseHref &&
		currentBrowserHref(target) === descriptor.baseHref &&
		state.__TSR_key === descriptor.baseKey &&
		state.key === descriptor.baseKey &&
		state.__TSR_index === descriptor.baseIndex &&
		resolveStateScrollKey(state) === descriptor.baseScrollKey &&
		(!descriptor.baseNavigationKey ||
			target.navigation?.currentEntry?.key === descriptor.baseNavigationKey)
	);
}

function currentEntryIsSentinel(
	history: RouterHistory,
	descriptor: OrphanSentinelDescriptor,
	target: BrowserHistoryTarget,
): boolean {
	const state = asHistoryState(target.history.state);
	return (
		history.location.href === descriptor.baseHref &&
		currentBrowserHref(target) === descriptor.baseHref &&
		state[APP_HISTORY_SENTINEL_ID] === descriptor.id &&
		state.__TSR_key === descriptor.entryKey
	);
}

function waitForHistoryTraversal(history: RouterHistory, navigate: () => void): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (traversed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe();
			resolve(traversed);
		};
		const unsubscribe = history.subscribe(({ action }) => {
			if (action.type === "PUSH" || action.type === "REPLACE") return;
			finish(true);
		});
		const timeout = setTimeout(() => finish(false), HISTORY_TRAVERSAL_TIMEOUT_MS);
		try {
			navigate();
		} catch {
			finish(false);
		}
	});
}

async function performOrphanSentinelRecovery(
	history: RouterHistory,
	target: BrowserHistoryTarget,
): Promise<OrphanHistorySentinelRecoveryResult> {
	let consumed = 0;
	while (true) {
		const state = asHistoryState(target.history.state);
		if (!hasSentinelState(state)) {
			return { status: consumed > 0 ? "consumed" : "none", consumed };
		}

		const descriptor = readOrphanSentinelDescriptor(history, target);
		if (!descriptor) {
			clearCurrentSentinelState(history, target);
			return { status: "cleared-unverified", consumed };
		}

		const traversed = await waitForHistoryTraversal(history, () => {
			history.back({ ignoreBlocker: true });
		});
		if (!traversed) {
			if (currentEntryIsSentinel(history, descriptor, target)) {
				clearCurrentSentinelState(history, target);
				return { status: "cleared-unverified", consumed };
			}
			return { status: "failed", consumed };
		}
		if (currentEntryMatchesDescriptor(history, descriptor, target)) {
			consumed++;
			continue;
		}

		const rolledForward = await waitForHistoryTraversal(history, () => {
			history.forward({ ignoreBlocker: true });
		});
		if (rolledForward && currentEntryIsSentinel(history, descriptor, target)) {
			clearCurrentSentinelState(history, target);
			return { status: "cleared-unverified", consumed };
		}
		return { status: "failed", consumed };
	}
}

type PendingNavigation = {
	action: "PUSH" | "REPLACE";
	location: HistoryLocation;
};

type SentinelRecordStatus = "queued" | "active" | "popping" | "popped";

interface SentinelRecord {
	id: string;
	sentinel: AppHistorySentinel;
	onPop: () => void;
	target: BrowserHistoryTarget;
	status: SentinelRecordStatus;
	disposed: boolean;
}

class HistorySentinelCoordinator {
	private readonly records: SentinelRecord[] = [];
	private pendingNavigation: PendingNavigation | undefined;
	private replaying = false;
	private activating = false;
	private processingPop = false;
	private continuationQueued = false;
	private currentSentinelId: string | undefined;
	private stopped = false;
	private readonly unblock: () => void;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly history: RouterHistory,
		private readonly onStop: () => void,
	) {
		this.currentSentinelId = this.getLocationSentinelId(history.location);
		this.unblock = history.block({
			enableBeforeUnload: false,
			blockerFn: ({ currentLocation, nextLocation, action }) => {
				if (action !== "PUSH" && action !== "REPLACE") return false;
				const currentRecord = this.getActivatedRecord(this.getLocationSentinelId(currentLocation));
				if (!currentRecord && !this.getQueuedRecord()) return false;

				if (!this.pendingNavigation) {
					this.pendingNavigation = { action, location: nextLocation };
					if (currentRecord?.status === "active") this.requestBack(currentRecord);
					else this.scheduleContinuation();
				}
				return true;
			},
		});
		this.unsubscribe = history.subscribe(({ location, action }) => {
			const previousSentinelId = this.currentSentinelId;
			const nextSentinelId = this.getLocationSentinelId(location);
			this.currentSentinelId = nextSentinelId;
			const isPop = action.type === "BACK" || action.type === "FORWARD" || action.type === "GO";
			if (!isPop || previousSentinelId === nextSentinelId) return;
			if (!this.getActivatedRecord(previousSentinelId)) return;

			this.processingPop = true;
			try {
				while (true) {
					const record = this.getTopActivatedRecord();
					if (!record || record.id === nextSentinelId) break;
					this.finalizeRecord(record);
				}
			} finally {
				this.processingPop = false;
			}
			this.scheduleContinuation();
		});
	}

	push(
		sentinel: AppHistorySentinel,
		onPop: () => void,
		target: BrowserHistoryTarget,
	): HistorySentinelController {
		const record: SentinelRecord = {
			id: createAppHistoryEntryKey(),
			sentinel,
			onPop,
			target,
			status: "queued",
			disposed: false,
		};
		this.records.push(record);
		const controller = {
			dispose: () => this.disposeRecord(record),
		};

		if (this.canActivateQueuedRecords()) {
			try {
				this.activateRecord(record, false);
			} catch (error) {
				this.stopIfIdle();
				throw error;
			}
		} else {
			this.scheduleContinuation();
		}
		return controller;
	}

	hasCurrentController(): boolean {
		return this.getCurrentActivatedRecord() !== undefined;
	}

	resumeAfterOrphanRecovery(): void {
		this.currentSentinelId = this.getLocationSentinelId(this.history.location);
		this.scheduleContinuation();
	}

	private getLocationSentinelId(location: Pick<HistoryLocation, "state">): string | undefined {
		const value = location.state[APP_HISTORY_SENTINEL_ID];
		return isValidHistoryKey(value) ? value : undefined;
	}

	private getActivatedRecord(id: string | undefined): SentinelRecord | undefined {
		if (!id) return;
		return this.records.find(
			(record) => record.id === id && (record.status === "active" || record.status === "popping"),
		);
	}

	private getTopActivatedRecord(): SentinelRecord | undefined {
		for (let index = this.records.length - 1; index >= 0; index--) {
			const record = this.records[index];
			if (record.status === "active" || record.status === "popping") return record;
		}
		return;
	}

	private getCurrentActivatedRecord(): SentinelRecord | undefined {
		return this.getActivatedRecord(this.currentSentinelId);
	}

	private getQueuedRecord(): SentinelRecord | undefined {
		return this.records.find((record) => record.status === "queued" && !record.disposed);
	}

	private hasPoppingRecord(): boolean {
		return this.records.some((record) => record.status === "popping");
	}

	private canActivateQueuedRecords(): boolean {
		return (
			!this.stopped &&
			!orphanSentinelRecoveryRuns.get(this.history)?.pending &&
			!this.pendingNavigation &&
			!this.replaying &&
			!this.activating &&
			!this.processingPop &&
			!this.continuationQueued &&
			!this.hasPoppingRecord()
		);
	}

	private activateRecord(record: SentinelRecord, reportAsyncError: boolean): void {
		if (record.status !== "queued") return;
		if (record.disposed) {
			record.status = "popped";
			return;
		}

		this.activating = true;
		record.status = "active";
		try {
			const currentState = normalizeCurrentHistoryEntry(this.history, record.target);
			const baseKey = currentState.__TSR_key as string;
			const baseIndex = currentState.__TSR_index as number;
			const scrollKey = resolveStateScrollKey(currentState) as string;
			const baseNavigationKey = record.target.navigation?.currentEntry?.key;
			this.history.push(
				this.history.location.href,
				mergeAppHistoryState(currentState, {
					[record.sentinel]: true,
					__NF_scroll_key: scrollKey,
					[APP_HISTORY_SENTINEL_ID]: record.id,
					__NF_sentinel_version: APP_HISTORY_SENTINEL_VERSION,
					__NF_sentinel_kind: record.sentinel,
					__NF_sentinel_base_href: this.history.location.href,
					__NF_sentinel_base_key: baseKey,
					__NF_sentinel_base_index: baseIndex,
					__NF_sentinel_base_scroll_key: scrollKey,
					__NF_sentinel_base_navigation_key: validNavigationEntryKey(baseNavigationKey)
						? baseNavigationKey
						: null,
				}),
				{ ignoreBlocker: true },
			);
			this.history.flush();
			if (this.getLocationSentinelId(this.history.location) !== record.id) {
				throw new Error("TanStack History did not create the requested sentinel entry");
			}
			this.currentSentinelId = record.id;
		} catch (error) {
			record.status = "popped";
			if (!reportAsyncError) throw error;
			queueMicrotask(() => {
				throw error;
			});
		} finally {
			this.activating = false;
		}
		if (record.disposed && record.status === "active") this.requestBack(record);
	}

	private activateQueuedRecords(): void {
		while (this.canActivateQueuedRecords()) {
			const record = this.getQueuedRecord();
			if (!record) return;
			this.activateRecord(record, true);
			if (record.status === "popping") return;
		}
	}

	private requestBack(record: SentinelRecord): void {
		if (
			record.status !== "active" ||
			this.activating ||
			this.getCurrentActivatedRecord() !== record ||
			this.getTopActivatedRecord() !== record
		) {
			return;
		}
		record.status = "popping";
		this.history.back({ ignoreBlocker: true });
	}

	private finalizeRecord(record: SentinelRecord): void {
		if (record.status === "popped") return;
		record.status = "popped";
		if (record.disposed) return;
		try {
			record.onPop();
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}

	private disposeRecord(record: SentinelRecord): void {
		if (record.disposed) return;
		record.disposed = true;
		if (record.status === "queued") {
			record.status = "popped";
			this.scheduleContinuation();
			return;
		}
		if (record.status === "popped") {
			this.stopIfIdle();
			return;
		}
		if (this.getCurrentActivatedRecord() === record) this.requestBack(record);
	}

	private finalizeQueuedRecordsForNavigation(): void {
		while (true) {
			let queuedRecord: SentinelRecord | undefined;
			for (let index = this.records.length - 1; index >= 0; index--) {
				if (this.records[index].status === "queued") {
					queuedRecord = this.records[index];
					break;
				}
			}
			if (!queuedRecord) return;
			this.finalizeRecord(queuedRecord);
		}
	}

	private scheduleContinuation(): void {
		if (this.continuationQueued || this.stopped) return;
		this.continuationQueued = true;
		queueMicrotask(() => {
			this.continuationQueued = false;
			if (this.processingPop || this.activating || this.replaying) {
				this.scheduleContinuation();
				return;
			}

			const currentRecord = this.getCurrentActivatedRecord();
			if (this.pendingNavigation) {
				if (currentRecord) {
					if (currentRecord.status === "active") this.requestBack(currentRecord);
					return;
				}
				if (this.hasPoppingRecord()) return;
				this.finalizeQueuedRecordsForNavigation();
				this.replayPendingNavigation();
				return;
			}

			if (currentRecord?.disposed) {
				if (currentRecord.status === "active") this.requestBack(currentRecord);
				return;
			}
			if (this.hasPoppingRecord()) return;
			this.activateQueuedRecords();
			const activatedRecord = this.getCurrentActivatedRecord();
			if (activatedRecord?.disposed && activatedRecord.status === "active") {
				this.requestBack(activatedRecord);
				return;
			}
			this.stopIfIdle();
		});
	}

	private replayPendingNavigation(): void {
		const navigation = this.pendingNavigation;
		if (!navigation || this.replaying) return;
		this.replaying = true;
		try {
			const nextState = mergeAppHistoryState(navigation.location.state, SENTINEL_STATE_PATCH);
			if (navigation.action === "REPLACE") {
				this.history.replace(navigation.location.href, nextState, { ignoreBlocker: true });
			} else {
				this.history.push(navigation.location.href, nextState, { ignoreBlocker: true });
			}
			this.history.flush();
		} finally {
			this.pendingNavigation = undefined;
			this.replaying = false;
			this.scheduleContinuation();
		}
	}

	private stopIfIdle(): void {
		if (
			this.stopped ||
			this.pendingNavigation ||
			this.replaying ||
			this.activating ||
			this.processingPop ||
			this.continuationQueued ||
			this.records.some((record) => record.status !== "popped")
		) {
			return;
		}
		this.stopped = true;
		this.unblock();
		this.unsubscribe();
		this.onStop();
	}
}

const sentinelCoordinators = new WeakMap<RouterHistory, HistorySentinelCoordinator>();

/**
 * Consume reload-orphaned same-URL sentinel entries before the app shell mounts. New controllers
 * created while traversal is pending stay queued until the recovered base entry is authoritative.
 */
export function recoverOrphanHistorySentinels(
	history: RouterHistory,
	target: BrowserHistoryTarget = window,
): Promise<OrphanHistorySentinelRecoveryResult> {
	const existingRun = orphanSentinelRecoveryRuns.get(history);
	if (existingRun) return existingRun.promise;

	const coordinator = sentinelCoordinators.get(history);
	if (coordinator?.hasCurrentController()) {
		const promise = Promise.resolve({
			status: "none",
			consumed: 0,
		} satisfies OrphanHistorySentinelRecoveryResult);
		orphanSentinelRecoveryRuns.set(history, { pending: false, promise });
		return promise;
	}

	const run: OrphanSentinelRecoveryRun = {
		pending: true,
		promise: Promise.resolve({ status: "none", consumed: 0 }),
	};
	orphanSentinelRecoveryRuns.set(history, run);
	run.promise = Promise.resolve()
		.then(() => performOrphanSentinelRecovery(history, target))
		.catch(() => ({ status: "failed", consumed: 0 }) as const)
		.finally(() => {
			run.pending = false;
			sentinelCoordinators.get(history)?.resumeAfterOrphanRecovery();
		});
	return run.promise;
}

/**
 * Push an ephemeral same-URL entry with valid TanStack metadata. A single coordinator per history
 * serializes stacked overlays, lets only the current top sentinel consume Back, and drains every
 * open sentinel before replaying one blocked route navigation.
 */
export function pushHistorySentinel(
	history: RouterHistory,
	sentinel: AppHistorySentinel,
	onPop: () => void,
	target: BrowserHistoryTarget = window,
): HistorySentinelController {
	let coordinator = sentinelCoordinators.get(history);
	if (!coordinator) {
		coordinator = new HistorySentinelCoordinator(history, () => {
			sentinelCoordinators.delete(history);
		});
		sentinelCoordinators.set(history, coordinator);
	}
	return coordinator.push(sentinel, onPop, target);
}
