import { useComputedColorScheme } from "@mantine/core";
import { setTypography } from "@shared/pretext-layout/typography";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { changeAppLanguage, getNamespacesForPath, normalizeLanguage } from "../lib/i18n";
import { setStreamAnimDurationMs } from "../lib/stream-anim-duration";
import { useLocalNumberPref, useLocalPref } from "./useLocalPref";
import type { useUserPreferences } from "./useUserPreferences";

/** Shared preferences only: no navigation, badges, workspace or realtime subscriptions. */
export function useAuthenticatedAppearance(prefs: ReturnType<typeof useUserPreferences>["data"]) {
	const { i18n } = useTranslation("common");
	const [oledMode] = useLocalPref("narrafork_oled");
	const [advancedAnim] = useLocalPref("narrafork_advanced_anim");
	const [blurInMs] = useLocalNumberPref("narrafork_blur_in_ms");
	const [streamTokenMs] = useLocalNumberPref("narrafork_stream_token_ms");
	const computedScheme = useComputedColorScheme("dark");
	// Sync language from backend preference on login / app init
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally do not react to i18n.language changes, otherwise manual language switches can be rolled back by stale backend prefs
	useEffect(() => {
		if (!prefs?.language) return;

		const preferredLanguage = normalizeLanguage(prefs.language);
		const currentLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
		if (preferredLanguage !== currentLanguage) {
			void changeAppLanguage(prefs.language, getNamespacesForPath(window.location.pathname));
		}
	}, [prefs?.language]);

	// Publish the reader's narrator typography into the height model's parameter
	// source. Done here (not in the narrator route) because `typography.ts` is a
	// module singleton read by the measure layer: it must hold the right values BEFORE
	// any transcript measures itself, otherwise the first paint uses the neutral
	// setting and then re-measures the whole document a moment later.
	//
	// `setTypography` clamps, no-ops when nothing moved, and notifies its subscribers
	// (the prepared cache drops entries; `usePretextDocument` rebuilds the committed
	// layout with an anchor) — so nothing else is needed here. Values are only applied
	// once prefs have loaded; `undefined` would clamp to the defaults and cause a
	// visible reflow on every page load for anyone who changed a setting.
	useEffect(() => {
		if (!prefs) return;
		setTypography({
			fontScalePercent: prefs.narratorFontScalePercent,
			letterSpacingPercent: prefs.narratorLetterSpacingPercent,
			lineHeightScalePercent: prefs.narratorLineHeightScalePercent,
			paragraphScalePercent: prefs.narratorParagraphScalePercent,
		});
	}, [
		prefs,
		prefs?.narratorFontScalePercent,
		prefs?.narratorLetterSpacingPercent,
		prefs?.narratorLineHeightScalePercent,
		prefs?.narratorParagraphScalePercent,
	]);

	// Sync OLED mode data attribute on <html>
	useEffect(() => {
		const html = document.documentElement;
		if (oledMode) {
			html.setAttribute("data-oled", "true");
		} else {
			html.removeAttribute("data-oled");
		}
	}, [oledMode]);

	// Sync advanced animation data attribute on <html>
	useEffect(() => {
		const html = document.documentElement;
		if (advancedAnim) {
			html.setAttribute("data-advanced-anim", "true");
		} else {
			html.removeAttribute("data-advanced-anim");
		}
	}, [advancedAnim]);

	// Publish the configured blur-in duration as a CSS variable on <html>.
	// Removing it (rather than writing the default) when advanced animation is
	// off keeps the stylesheet's own fallback as the single source of the default.
	useEffect(() => {
		const html = document.documentElement;
		if (advancedAnim) {
			html.style.setProperty("--nf-blur-in-duration", `${blurInMs}ms`);
		} else {
			html.style.removeProperty("--nf-blur-in-duration");
		}
	}, [advancedAnim, blurInMs]);

	// The streaming per-grapheme fade has TWO consumers that must agree: the CSS
	// animation and the JS retirement clock in stream-token-anim, which decides
	// when a grapheme's span may be folded back into static text. A JS duration
	// SHORTER than the CSS one seals spans mid-animation and snaps the character
	// to its end state — so both are written here, from one value, in one effect.
	//
	// The JS side is set first: it only takes effect on the next animation frame,
	// while the CSS var applies to spans already on screen. Setting the (longer)
	// clock before the (shorter) CSS duration can only over-retain spans for a
	// frame, which is invisible; the reverse order truncates fades in flight.
	useEffect(() => {
		setStreamAnimDurationMs(streamTokenMs);
		const html = document.documentElement;
		html.style.setProperty("--nf-stream-token-duration", `${streamTokenMs}ms`);
	}, [streamTokenMs]);

	// Sync theme-color meta tag with actual background color
	useEffect(() => {
		const color = computedScheme === "dark" ? (oledMode ? "#000000" : "#1a1b1e") : "#ffffff";
		for (const el of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
			el.setAttribute("content", color);
		}
	}, [computedScheme, oledMode]);
}
