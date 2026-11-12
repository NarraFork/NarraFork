/**
 * The one mapping between the typography module's knobs and the user-preference fields that
 * store them, both ways.
 *
 * Line height is the field that makes this worth a module: it is stored as
 * `narratorLineHeightV2Percent` on the current scale (100 = the old 120%, see
 * LINE_HEIGHT_BASELINE_PERCENT), while the server still returns the old-scale
 * `narratorLineHeightScalePercent` for clients built before the rescale. Reading or writing the
 * old field here would apply a value on the wrong scale, so every surface (the app shell, the
 * docked 外观 panel, Settings) goes through these two functions.
 */
import type { TypographySettings } from "@shared/pretext-layout/typography";

/** The preference fields the typography lives in (current scale only). */
export interface TypographyPreferences {
	narratorFontScalePercent: number;
	narratorLetterSpacingPercent: number;
	narratorLineHeightV2Percent: number;
	narratorParagraphScalePercent: number;
}

/** Stored preferences → the module's settings (`setTypography` clamps them). */
export function typographyFromPreferences(prefs: TypographyPreferences): TypographySettings {
	return {
		fontScalePercent: prefs.narratorFontScalePercent,
		letterSpacingPercent: prefs.narratorLetterSpacingPercent,
		lineHeightScalePercent: prefs.narratorLineHeightV2Percent,
		paragraphScalePercent: prefs.narratorParagraphScalePercent,
	};
}

/**
 * Changed knobs → a preference PATCH body. Only the knobs present are sent, so two surfaces
 * adjusting different knobs cannot overwrite each other.
 */
export function typographyPreferencePatch(
	patch: Partial<TypographySettings>,
): Partial<TypographyPreferences> {
	const body: Partial<TypographyPreferences> = {};
	if (patch.fontScalePercent !== undefined) body.narratorFontScalePercent = patch.fontScalePercent;
	if (patch.letterSpacingPercent !== undefined) {
		body.narratorLetterSpacingPercent = patch.letterSpacingPercent;
	}
	if (patch.lineHeightScalePercent !== undefined) {
		body.narratorLineHeightV2Percent = patch.lineHeightScalePercent;
	}
	if (patch.paragraphScalePercent !== undefined) {
		body.narratorParagraphScalePercent = patch.paragraphScalePercent;
	}
	return body;
}
