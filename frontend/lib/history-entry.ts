import type { HistoryLocation, HistoryState } from "@tanstack/react-router";

/**
 * App-owned keys stored alongside TanStack's own history metadata.
 *
 * `__NF_history_key` is a per-entry identity for legacy entries that predate router metadata.
 * `__NF_scroll_key` lets an ephemeral same-URL entry point back at the scroll identity of the
 * entry it was pushed from, and `__NF_sentinel_id` marks that entry (see `./history-state`).
 */
export interface AppHistoryState {
	mobileNav?: true;
	terminalDrawer?: true;
	contentViewerFullscreen?: true;
	__NF_history_key?: string;
	__NF_scroll_key?: string;
	__NF_sentinel_id?: string;
}

declare module "@tanstack/history" {
	interface HistoryState extends AppHistoryState {}
}

export type AppHistoryStatePatch = {
	[K in keyof AppHistoryState]?: AppHistoryState[K] | null;
};

export type BrowserHistoryTarget = Pick<Window, "history" | "location">;

export type CompatibleHistoryState = HistoryState & {
	key?: string;
	__TSR_key?: string;
	__TSR_index?: number;
};

export function asHistoryState(value: unknown): CompatibleHistoryState {
	return value !== null && typeof value === "object" ? (value as CompatibleHistoryState) : {};
}

export function currentBrowserHref(target: BrowserHistoryTarget): string {
	return `${target.location.pathname}${target.location.search}${target.location.hash}`;
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
	target.history.replaceState(
		mergeAppHistoryState(target.history.state, patch),
		"",
		href ?? currentBrowserHref(target),
	);
}

export function createAppHistoryEntryKey(): string {
	const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `nf-${randomPart}`;
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

	const existingFallback = browserState.__NF_history_key;
	if (existingFallback) return { key: existingFallback, needsFallbackPersistence: false };

	return { key: fallback, needsFallbackPersistence: true };
}
