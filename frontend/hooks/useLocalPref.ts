import { useCallback, useSyncExternalStore } from "react";
import {
	DEFAULT_STREAM_ANIM_DURATION_MS,
	MAX_STREAM_ANIM_DURATION_MS,
} from "../lib/stream-anim-duration";

/**
 * Lightweight hook for boolean preferences stored in localStorage.
 * Changes are broadcast across tabs via the "storage" event and
 * within the same tab via a manual notify mechanism.
 */

type Key =
	| "narrafork_fullscreen"
	| "narrafork_oled"
	| "narrafork_wakelock"
	| "narrafork_advanced_anim"
	| "narrafork_expand_reasoning"
	| "narrafork_narrator_centered_column"
	// Alt+wheel / pinch stepping of the render LOD, plus the Alt-held indicator.
	// Default ON; can be turned off because Alt+wheel collides with OS/browser
	// gestures on some setups (window drag, horizontal scroll, IME) and an
	// accidental Alt while scrolling then silently changes how much detail the
	// whole transcript renders. With it off, Alt does nothing for LOD — the
	// toolbar's detail-level menu (`lodlevel`) is the remaining click entry point.
	| "narrafork_lod_alt_gesture"
	// Ruler's deprecation notice has been acknowledged. Not per-project: the fact that
	// the view is deprecated is global, so being told once is enough.
	| "narrafork_ruler_deprecation_ack"
	// Unified morph driver (visual-state + single rAF loop) instead of the keyframe
	// planners. Now DEFAULT ON, after the browser comparison this gate existed for: the
	// keyframe path loses a whole activity group's animation whenever the two levels'
	// geometries disagree, which the unified path fixes structurally (identity-based
	// pairing + group-anchored admission) rather than per-case.
	//
	// The switch stays so the old path remains reachable if a regression turns up in use;
	// removing it is a separate, later step — see the rewrite plan's §4. Note that flipping
	// this default only affects readers with NOTHING stored: anyone who toggled it by hand
	// keeps their stored value either way.
	| "narrafork_unified_morph"
	// TEMPORARY debug surface — see components/narrator/mock/README-REMOVAL.md.
	| "narrafork_mock_stream";

/**
 * Numeric preference keys. Kept in this module (rather than a separate hook) so
 * they share the one `storage` listener and the same in-tab notify path — a
 * numeric pref written here must wake boolean subscribers' siblings too, and
 * duplicating the subscription machinery is how those two sets drift apart.
 */
type NumberKey =
	// Duration of the card-level blur-in (`nf-blur-in`, applied to newly appearing
	// user messages / tool cards / reasoning cards).
	| "narrafork_blur_in_ms"
	// Duration of the streaming per-grapheme fade-in (`vlist-anim-token` in the
	// virtual list, `.animatedWord` in the classic renderer). Read by BOTH CSS and
	// JS: stream-token-anim.ts uses it to decide when a grapheme's span may be
	// folded back into static text, so AppRootLayout must publish this one value
	// to the CSS variable and to setStreamAnimDurationMs together.
	| "narrafork_stream_token_ms";

const listeners = new Set<() => void>();

// --- Singleton storage listener ---
// One global "storage" listener dispatches to all subscribers,
// instead of each useLocalPref instance registering its own.
let storageListener: ((e: StorageEvent) => void) | null = null;

function ensureStorageListener() {
	if (storageListener) return;
	storageListener = (e: StorageEvent) => {
		if (e.key?.startsWith("narrafork_")) {
			for (const cb of listeners) cb();
		}
	};
	window.addEventListener("storage", storageListener);
}

function removeStorageListenerIfIdle() {
	if (listeners.size > 0 || !storageListener) return;
	window.removeEventListener("storage", storageListener);
	storageListener = null;
}

function subscribe(cb: () => void) {
	listeners.add(cb);
	ensureStorageListener();
	return () => {
		listeners.delete(cb);
		removeStorageListenerIfIdle();
	};
}

function notify() {
	for (const cb of listeners) cb();
}

/** Keys whose default value is `true` (opt-out instead of opt-in). */
const DEFAULT_TRUE: ReadonlySet<Key> = new Set([
	"narrafork_advanced_anim",
	// The LOD gesture is existing behavior, so nothing-stored must keep it working;
	// the switch exists to opt OUT.
	"narrafork_lod_alt_gesture",
	// The unified morph driver is now the intended path; the switch exists to opt OUT
	// while the keyframe planners are still present. See the key's note above.
	"narrafork_unified_morph",
]);

/**
 * The default value of a preference key when nothing is stored in localStorage.
 * Exported (pure, no DOM) so tests can lock critical defaults.
 */
export function localPrefDefault(key: Key): boolean {
	return DEFAULT_TRUE.has(key);
}

function getSnapshot(key: Key): boolean {
	const raw = localStorage.getItem(key);
	if (raw === null) return localPrefDefault(key);
	return raw === "true";
}

export function useLocalPref(key: Key): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => getSnapshot(key),
		() => localPrefDefault(key),
	);
	const setValue = useCallback(
		(v: boolean) => {
			localStorage.setItem(key, String(v));
			notify();
		},
		[key],
	);
	return [value, setValue];
}

/** Allowed range and default for each numeric preference. */
const NUMBER_PREF_RANGE: Record<NumberKey, { min: number; max: number; fallback: number }> = {
	// 0 = instant (no animation at all), so the slider itself can express "off"
	// without a second switch. The upper bound keeps a mistyped/edited value from
	// leaving a card blurred for seconds, during which it reads as broken.
	narrafork_blur_in_ms: { min: 0, max: 2000, fallback: 400 },
	// Bounds come FROM the animation's own module (via lib/stream-anim-duration, so
	// this hook does not reach into the vlist render tree). Copying the numbers here
	// would let the slider and the clamp drift apart silently.
	narrafork_stream_token_ms: {
		min: 0,
		max: MAX_STREAM_ANIM_DURATION_MS,
		fallback: DEFAULT_STREAM_ANIM_DURATION_MS,
	},
};

/**
 * Default value of a numeric preference when nothing (or garbage) is stored.
 *
 * Pure and exported so tests can pin the defaults without a DOM.
 */
export function localNumberPrefDefault(key: NumberKey): number {
	return NUMBER_PREF_RANGE[key].fallback;
}

/** Clamp to the key's range, falling back to its default for non-finite input. */
export function clampLocalNumberPref(key: NumberKey, value: number): number {
	const { min, max, fallback } = NUMBER_PREF_RANGE[key];
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function readLocalNumberPref(key: NumberKey): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return localNumberPrefDefault(key);
		const parsed = Number.parseInt(raw, 10);
		if (Number.isNaN(parsed)) return localNumberPrefDefault(key);
		return clampLocalNumberPref(key, parsed);
	} catch {
		// A storage-less environment (SSR, locked-down WebView) reads the default.
		return localNumberPrefDefault(key);
	}
}

export function useLocalNumberPref(key: NumberKey): [number, (v: number) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => readLocalNumberPref(key),
		() => localNumberPrefDefault(key),
	);
	const setValue = useCallback(
		(v: number) => {
			try {
				localStorage.setItem(key, String(clampLocalNumberPref(key, v)));
			} catch {
				// Ignore: the in-tab notify below still updates this session.
			}
			notify();
		},
		[key],
	);
	return [value, setValue];
}
