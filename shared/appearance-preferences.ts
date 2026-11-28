/** Bounded presentation preferences. Scope defaults preserve the pre-sync behaviour. */
import { TYPOGRAPHY_RANGE } from "./pretext-layout/typography";

export const DEFAULT_STREAM_ANIM_DURATION_MS = 320;
export const MAX_STREAM_ANIM_DURATION_MS = 5000;
export type AppearanceValue = boolean | number | string;
export interface AppearancePreferenceDefinition {
	defaultSync: boolean;
	customizable: boolean;
	fallback: AppearanceValue;
	storageKey?: string;
	field?: string;
	min?: number;
	max?: number;
	choices?: readonly string[];
}

const local = (fallback: AppearanceValue, storageKey: string, customizable = true) => ({
	defaultSync: false,
	customizable,
	fallback,
	storageKey,
});
const account = (field: string, fallback: AppearanceValue, customizable = true) => ({
	defaultSync: true,
	customizable,
	fallback,
	field,
});

export const APPEARANCE_PREFERENCES = {
	colorScheme: {
		...local("auto", "mantine-color-scheme-value"),
		choices: ["auto", "light", "dark"],
	},
	pluginTheme: local("", "narrafork_plugin_theme"),
	narrafork_oled: local(false, "narrafork_oled"),
	narrafork_advanced_anim: local(true, "narrafork_advanced_anim"),
	narrafork_expand_reasoning: local(false, "narrafork_expand_reasoning"),
	narrafork_narrator_centered_column: local(false, "narrafork_narrator_centered_column"),
	narrafork_narrator_bottom_spacing_resize: local(
		false,
		"narrafork_narrator_bottom_spacing_resize",
	),
	narrafork_lod_alt_gesture: local(true, "narrafork_lod_alt_gesture"),
	narrafork_blur_in_ms: { ...local(400, "narrafork_blur_in_ms"), min: 0, max: 2000 },
	narrafork_stream_token_ms: {
		...local(DEFAULT_STREAM_ANIM_DURATION_MS, "narrafork_stream_token_ms"),
		min: 0,
		max: MAX_STREAM_ANIM_DURATION_MS,
	},
	// Actual browser operations/debug gates are never replayed from another client.
	narrafork_fullscreen: local(false, "narrafork_fullscreen", false),
	narrafork_wakelock: local(false, "narrafork_wakelock", false),
	narrafork_mock_stream: local(false, "narrafork_mock_stream", false),
	narrafork_unified_morph: local(true, "narrafork_unified_morph", false),
	autoLoadOlderMessages: account("autoLoadOlderMessages", true),
	recentTabsShowDirectory: account("recentTabsShowDirectory", false),
	compactAuxiliaryContent: account("compactAuxiliaryContent", true),
	wordWrapMarkdown: account("wordWrapMarkdown", true),
	wordWrapCode: account("wordWrapCode", true),
	wordWrapDiff: account("wordWrapDiff", true),
	showTokenUsage: account("showTokenUsage", false),
	showOutputStats: account("showOutputStats", true),
	terminalTheme: account("terminalTheme", "auto"),
	terminalFontSize: { ...account("terminalFontSize", 14), min: 8, max: 32 },
	narratorFontScalePercent: {
		...account("narratorFontScalePercent", 100),
		...TYPOGRAPHY_RANGE.fontScalePercent,
	},
	narratorLetterSpacingPercent: {
		...account("narratorLetterSpacingPercent", 0),
		...TYPOGRAPHY_RANGE.letterSpacingPercent,
	},
	narratorLineHeightV2Percent: {
		...account("narratorLineHeightV2Percent", 100),
		...TYPOGRAPHY_RANGE.lineHeightScalePercent,
	},
	narratorParagraphScalePercent: {
		...account("narratorParagraphScalePercent", 100),
		...TYPOGRAPHY_RANGE.paragraphScalePercent,
	},
	enterQueueMode: { ...account("enterQueueMode", "turn"), choices: ["turn", "tool", "interrupt"] },
	ctrlEnterQueueMode: {
		...account("ctrlEnterQueueMode", "tool"),
		choices: ["turn", "tool", "interrupt"],
	},
	// These influence shared/server behaviour, not just the current renderer.
	language: { ...account("language", "en", false), choices: ["en", "zh-CN"] },
	replyInUserLanguage: account("replyInUserLanguage", true, false),
	addSubagentToRecentTabs: account("addSubagentToRecentTabs", true, false),
	treatAsLocalAccess: account("treatAsLocalAccess", false, false),
} satisfies Record<string, AppearancePreferenceDefinition>;

export type AppearancePreferenceKey = keyof typeof APPEARANCE_PREFERENCES;
export type AppearanceValues = Partial<Record<AppearancePreferenceKey, AppearanceValue>>;
export const APPEARANCE_KEYS = Object.keys(APPEARANCE_PREFERENCES) as AppearancePreferenceKey[];

export function appearanceDefinition(key: AppearancePreferenceKey): AppearancePreferenceDefinition;
export function appearanceDefinition(key: string): AppearancePreferenceDefinition | undefined;
export function appearanceDefinition(key: string): AppearancePreferenceDefinition | undefined {
	return Object.hasOwn(APPEARANCE_PREFERENCES, key)
		? APPEARANCE_PREFERENCES[key as AppearancePreferenceKey]
		: undefined;
}

export function isAppearanceValue(key: string, value: unknown): value is AppearanceValue {
	const def = appearanceDefinition(key);
	if (!def || typeof value !== typeof def.fallback) return false;
	if (typeof value === "number") {
		return (
			Number.isFinite(value) &&
			Number.isInteger(value) &&
			(def.min === undefined || value >= def.min) &&
			(def.max === undefined || value <= def.max)
		);
	}
	if (typeof value === "string") {
		return value.length <= 256 && (!def.choices || def.choices.includes(value));
	}
	return typeof value === "boolean";
}

/** Only previously-local, customizable values belong in the new account JSON column. */
export function isAccountAppearanceValues(value: unknown): value is AppearanceValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, entry]) => {
		const def = appearanceDefinition(key);
		return def?.customizable === true && !!def.storageKey && isAppearanceValue(key, entry);
	});
}
