import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOCALE,
	getLocaleDirection,
	getLocaleFallbackChain,
	isSupportedLocale,
	LOCALE_OPTIONS,
	normalizeLocale,
	pickLocalizedValue,
} from "../../shared/i18n-locales";

describe("i18n locale registry", () => {
	test("normalizes exact locales and common aliases", () => {
		expect(normalizeLocale("en")).toBe("en");
		expect(normalizeLocale("en-US")).toBe("en");
		expect(normalizeLocale("EN_us")).toBe("en");
		expect(normalizeLocale("zh")).toBe("zh-CN");
		expect(normalizeLocale("zh_Hans_CN")).toBe("zh-CN");
	});

	test("falls back for unknown or empty locales", () => {
		expect(normalizeLocale("ja-JP")).toBe(DEFAULT_LOCALE);
		expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
	});

	test("distinguishes supported locale codes from aliases", () => {
		expect(isSupportedLocale("en")).toBe(true);
		expect(isSupportedLocale("zh-CN")).toBe(true);
		expect(isSupportedLocale("en-US")).toBe(false);
	});

	test("builds fallback chains and exposes text direction", () => {
		expect(getLocaleFallbackChain("en")).toEqual(["en"]);
		expect(getLocaleFallbackChain("zh-CN")).toEqual(["zh-CN", "en"]);
		expect(getLocaleDirection("zh-CN")).toBe("ltr");
	});

	test("picks localized values through the fallback chain", () => {
		expect(pickLocalizedValue({ en: "English", "zh-CN": "中文" }, "zh-CN")).toBe("中文");
		expect(pickLocalizedValue({ en: "English" }, "zh-CN")).toBe("English");
	});

	test("derives language selector options from the registry", () => {
		expect(LOCALE_OPTIONS).toEqual([
			{ value: "en", label: "English" },
			{ value: "zh-CN", label: "简体中文" },
		]);
	});
});
