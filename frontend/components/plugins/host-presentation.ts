/**
 * Tracks the host's theme and language, and reports when either changes.
 *
 * ## What this exists to solve
 *
 * Plugin panels are separate documents: they inherit nothing from the host's stylesheet or its
 * i18n instance. So the host has to hand both across, both on the first frame and again every
 * time the user changes one. This module is the "when did it change" half; `host-tokens.ts` is
 * the "what are the values" half.
 *
 * ## Why an observer rather than React state
 *
 * The four things that change a panel's appearance do not all flow through React:
 *
 * - Mantine color scheme → `data-mantine-color-scheme` on `<html>`
 * - OLED mode → `data-oled` on `<html>` (set by an effect in `AppRootLayout`)
 * - Active plugin theme → `data-plugin-theme` on `<html>` (set by `PluginThemeInjector`)
 * - A plugin theme's *rules* changing → the `<style>` element's text, with no attribute move
 *
 * The first three are attribute mutations, which one `MutationObserver` covers regardless of
 * which component caused them. Subscribing to React state instead would mean finding and
 * following every producer, and missing one would show up only as a panel that fails to follow
 * that particular control.
 *
 * The fourth is invisible to an attribute observer and must be reported explicitly by whoever
 * rewrites the stylesheet — see `notifyPluginThemeChanged`.
 */

import i18n from "@frontend/lib/i18n";
import { getLocaleFallbackChain, normalizeLocale } from "@shared/i18n-locales";
import { readHostTokens, renderTokenCss } from "./host-tokens";
import type { PluginUiPresentation } from "./runtime";

/** `<html>` attributes that change the resolved value of a design token. */
const WATCHED_ATTRIBUTES = ["data-mantine-color-scheme", "data-oled", "data-plugin-theme"];

/** Listeners notified after the host's presentation changed. */
const listeners = new Set<() => void>();

/**
 * Read the host's current presentation.
 *
 * Called for every new panel and again on each change, so it must stay cheap: one
 * `getComputedStyle` plus a bounded number of property reads.
 */
export function readHostPresentation(): PluginUiPresentation {
	const locale = normalizeLocale(i18n.language);
	return {
		tokenCss: renderTokenCss(readHostTokens()),
		locale,
		localeChain: getLocaleFallbackChain(locale),
	};
}

/**
 * Announce that plugin theme CSS was rewritten without any attribute changing.
 *
 * `PluginThemeInjector` replaces the text of a single `<style>` element when the set of enabled
 * themes changes. The active theme's *name* may be identical before and after, so no attribute
 * moves and the observer below sees nothing — yet the values behind every token may differ.
 * Without this call, panels would keep the previous theme's colours until something else
 * happened to trigger a re-read.
 */
export function notifyPluginThemeChanged(): void {
	scheduleNotify();
}

/**
 * Subscribe to host presentation changes.
 *
 * The observer is created on the first subscription and torn down when the last one leaves, so
 * an app that never opens a plugin panel pays nothing.
 */
export function subscribeHostPresentation(listener: () => void): () => void {
	listeners.add(listener);
	ensureWatching();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) stopWatching();
	};
}

let observer: MutationObserver | undefined;
let unsubscribeLanguage: (() => void) | undefined;
let pendingFrame: number | undefined;

function ensureWatching(): void {
	if (typeof document === "undefined" || observer) return;
	observer = new MutationObserver(scheduleNotify);
	// Scoped to the three attributes on one element. A subtree or all-attribute observer would
	// fire on ordinary DOM churn and turn every render into a `getComputedStyle` plus a
	// postMessage per open panel.
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: WATCHED_ATTRIBUTES,
	});
	const onLanguageChanged = () => scheduleNotify();
	i18n.on("languageChanged", onLanguageChanged);
	unsubscribeLanguage = () => i18n.off("languageChanged", onLanguageChanged);
}

function stopWatching(): void {
	observer?.disconnect();
	observer = undefined;
	unsubscribeLanguage?.();
	unsubscribeLanguage = undefined;
	if (pendingFrame !== undefined) {
		cancelAnimationFrame(pendingFrame);
		pendingFrame = undefined;
	}
}

/**
 * Notify listeners after the browser has applied the new styles.
 *
 * A `MutationObserver` callback runs as a microtask, before style recalculation — reading
 * computed values there returns the *old* ones. The symptom would be a panel that lags the host
 * by exactly one theme change, which reads as a refresh bug rather than a timing error.
 *
 * Coalescing on the frame also collapses the bursts that happen in practice: switching to a
 * light plugin theme can move `data-plugin-theme` and `data-mantine-color-scheme` in the same
 * tick, and each open panel should be told once, not twice.
 */
function scheduleNotify(): void {
	if (typeof requestAnimationFrame !== "function") {
		// Isolated the same way the frame path is: one listener throwing must not stop
		// the others. Without this the two paths differ in behaviour, and only the
		// no-rAF one (tests, SSR) loses updates — the environment least likely to notice.
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// See the frame path below.
			}
		}
		return;
	}
	if (pendingFrame !== undefined) return;
	pendingFrame = requestAnimationFrame(() => {
		pendingFrame = undefined;
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One panel failing to receive an update must not stop the others.
			}
		}
	});
}

// The watcher's state is module-level, so a hot replacement would leave the OLD
// module's `MutationObserver` and i18n subscription attached with no way to reach
// them: every attribute change would then be delivered twice per reload, which looks
// like a double-render bug in the panels rather than a stale module. Same reasoning
// (and same shape) as `pretext-document-cache.ts`.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		stopWatching();
		listeners.clear();
	});
}
