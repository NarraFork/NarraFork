import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STREAM_ANIM_DURATION_MS,
	MAX_STREAM_ANIM_DURATION_MS,
} from "../lib/stream-anim-duration";
import { clampLocalNumberPref, localNumberPrefDefault, localPrefDefault } from "./useLocalPref";

/**
 * Default/opt-out contract for the local preferences.
 *
 * Pins the opt-out set so a new default-true key can't sneak in unnoticed.
 */
describe("useLocalPref — defaults", () => {
	test("opt-out keys stay opt-in", () => {
		expect(localPrefDefault("narrafork_advanced_anim")).toBe(true);
		expect(localPrefDefault("narrafork_oled")).toBe(false);
		expect(localPrefDefault("narrafork_wakelock")).toBe(false);
		expect(localPrefDefault("narrafork_fullscreen")).toBe(false);
		expect(localPrefDefault("narrafork_expand_reasoning")).toBe(false);
		// The reading-width cap is opt-in: by default the message list fills the viewport.
		expect(localPrefDefault("narrafork_narrator_centered_column")).toBe(false);
		// The Alt LOD gesture is existing behavior, so it must stay default-ON:
		// nothing stored (a fresh browser) keeps alt+wheel and the Alt-held
		// indicator working; the switch exists to opt OUT.
		expect(localPrefDefault("narrafork_lod_alt_gesture")).toBe(true);
	});
});

describe("useLocalPref — numeric prefs", () => {
	test("blur-in duration defaults to the CSS fallback", () => {
		// Must stay in sync with the `var(--nf-blur-in-duration, 400ms)` fallback in
		// styles/blur-anim.css: a mismatch makes the pre-effect frame animate at a
		// different speed than the stored setting, which reads as a flicker on load.
		expect(localNumberPrefDefault("narrafork_blur_in_ms")).toBe(400);
	});

	test("streaming fade duration uses the animation module's own bounds", () => {
		// The range comes from lib/stream-anim-duration (the animation's own owner),
		// not from numbers copied into this hook — a pref allowing more than the
		// animation accepts is silently clamped, and the slider then shows a value the
		// animation does not use. Asserted here as well so the wiring is checked, not
		// just assumed from the shared import.
		expect(localNumberPrefDefault("narrafork_stream_token_ms")).toBe(
			DEFAULT_STREAM_ANIM_DURATION_MS,
		);
		expect(clampLocalNumberPref("narrafork_stream_token_ms", 99_999)).toBe(
			MAX_STREAM_ANIM_DURATION_MS,
		);
		expect(clampLocalNumberPref("narrafork_stream_token_ms", 0)).toBe(0);
	});

	test("clamps to the allowed range and rejects non-finite input", () => {
		expect(clampLocalNumberPref("narrafork_blur_in_ms", -100)).toBe(0);
		expect(clampLocalNumberPref("narrafork_blur_in_ms", 5000)).toBe(2000);
		expect(clampLocalNumberPref("narrafork_blur_in_ms", 250)).toBe(250);
		expect(clampLocalNumberPref("narrafork_blur_in_ms", 250.6)).toBe(251);
		expect(clampLocalNumberPref("narrafork_blur_in_ms", Number.NaN)).toBe(400);
	});

	test("zero is a valid value, not a fallback trigger", () => {
		// 0 = instant is how the slider expresses "off"; a falsy-check anywhere in
		// the read path would silently restore 400ms instead.
		expect(clampLocalNumberPref("narrafork_blur_in_ms", 0)).toBe(0);
	});
});
