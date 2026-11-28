import { appearanceDefinition } from "@shared/appearance-preferences";
import { useCallback, useSyncExternalStore } from "react";
import {
	appearanceStore,
	subscribeAppearancePreferences,
} from "../lib/appearance-preference-store";
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
	| "narrafork_narrator_bottom_spacing_resize"
	// Alt+wheel / pinch stepping of the render LOD, plus the Alt-held indicator.
	// Default ON; can be turned off because Alt+wheel collides with OS/browser
	// gestures on some setups (window drag, horizontal scroll, IME) and an
	// accidental Alt while scrolling then silently changes how much detail the
	// whole transcript renders. With it off, Alt does nothing for LOD — the
	// toolbar's detail-level menu (`lodlevel`) is the remaining click entry point.
	| "narrafork_lod_alt_gesture"
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

/**
 * The default value of a preference key when nothing is stored in localStorage.
 * Exported (pure, no DOM) so tests can lock critical defaults.
 */
export function localPrefDefault(key: Key): boolean {
	return appearanceDefinition(key).fallback as boolean;
}

export function readLocalPref(key: Key): boolean {
	return appearanceStore.get(key) as boolean;
}

export function useLocalPref(key: Key): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		subscribeAppearancePreferences,
		() => readLocalPref(key),
		() => localPrefDefault(key),
	);
	const setValue = useCallback((v: boolean) => appearanceStore.set(key, v), [key]);
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
	return clampLocalNumberPref(key, appearanceStore.get(key) as number);
}

export function useLocalNumberPref(key: NumberKey): [number, (v: number) => void] {
	const value = useSyncExternalStore(
		subscribeAppearancePreferences,
		() => readLocalNumberPref(key),
		() => localNumberPrefDefault(key),
	);
	const setValue = useCallback(
		(v: number) => appearanceStore.set(key, clampLocalNumberPref(key, v)),
		[key],
	);
	return [value, setValue];
}
