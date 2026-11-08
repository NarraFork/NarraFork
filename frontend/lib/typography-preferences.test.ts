/**
 * Preferences ↔ typography: the line height is read from and written to the CURRENT-scale
 * field only. The old-scale `narratorLineHeightScalePercent` still arrives from the server (for
 * clients built before the rescale); applying it would set the line height on the wrong scale.
 */
import { describe, expect, it } from "bun:test";
import { typographyFromPreferences, typographyPreferencePatch } from "./typography-preferences";

describe("typography preferences", () => {
	it("reads the current-scale line height, not the old field", () => {
		const prefs = {
			narratorFontScalePercent: 115,
			narratorLetterSpacingPercent: 2,
			narratorLineHeightV2Percent: 92,
			narratorParagraphScalePercent: 130,
			// What the server also sends: the same line height on the old scale.
			narratorLineHeightScalePercent: 110,
		};
		expect(typographyFromPreferences(prefs)).toEqual({
			fontScalePercent: 115,
			letterSpacingPercent: 2,
			lineHeightScalePercent: 92,
			paragraphScalePercent: 130,
		});
	});

	it("writes only the knobs that moved, the line height under its current-scale field", () => {
		expect(typographyPreferencePatch({ lineHeightScalePercent: 110 })).toEqual({
			narratorLineHeightV2Percent: 110,
		});
		expect(typographyPreferencePatch({ fontScalePercent: 90 })).toEqual({
			narratorFontScalePercent: 90,
		});
		expect(
			typographyPreferencePatch({
				fontScalePercent: 100,
				letterSpacingPercent: 0,
				lineHeightScalePercent: 100,
				paragraphScalePercent: 100,
			}),
		).toEqual({
			narratorFontScalePercent: 100,
			narratorLetterSpacingPercent: 0,
			narratorLineHeightV2Percent: 100,
			narratorParagraphScalePercent: 100,
		});
		expect(typographyPreferencePatch({})).toEqual({});
	});
});
