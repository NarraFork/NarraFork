import { describe, expect, test } from "bun:test";
import {
	normalizePluginLocale,
	type PluginStringTables,
	translatePluginString,
} from "./plugin-i18n";

/**
 * Translation lookup for plugin panels.
 *
 * The fallback rules are the host's own (`getLocaleFallbackChain`), reused rather than
 * reimplemented. These tests pin the observable behaviour so that a future change to those rules
 * shows up here rather than as a plugin panel quietly rendering the wrong language.
 */

const tables: PluginStringTables = {
	en: { signIn: "Sign in", balance: "Balance: {amount}", onlyEnglish: "English only" },
	"zh-CN": { signIn: "登录", balance: "余额：{amount}" },
};

describe("plugin i18n: lookup and fallback", () => {
	test("an exact locale match wins", () => {
		expect(translatePluginString(tables, "zh-CN", "signIn")).toBe("登录");
	});

	test("an alias resolves to the table it means", () => {
		// `zh`, `zh-Hans` and `zh-SG` are declared aliases of `zh-CN`. A plugin should not have to
		// know that, which is why normalization is the host's job.
		for (const locale of ["zh", "zh-Hans", "zh-SG"]) {
			expect(translatePluginString(tables, locale, "signIn"), locale).toBe("登录");
		}
	});

	test("a key missing from the active locale falls back to English", () => {
		expect(translatePluginString(tables, "zh-CN", "onlyEnglish")).toBe("English only");
	});

	test("a key missing everywhere returns the key itself", () => {
		// Not an empty string: a button reading `nope` is visibly a missing translation, while a
		// blank button is indistinguishable from a rendering fault and gets debugged as one.
		expect(translatePluginString(tables, "zh-CN", "nope")).toBe("nope");
	});

	test("an unsupported locale falls back rather than returning keys", () => {
		expect(translatePluginString(tables, "fr-FR", "signIn")).toBe("Sign in");
	});
});

describe("plugin i18n: interpolation", () => {
	test("placeholders are substituted", () => {
		expect(translatePluginString(tables, "zh-CN", "balance", { amount: "$1.00" })).toBe(
			"余额：$1.00",
		);
	});

	test("numbers are accepted", () => {
		expect(translatePluginString(tables, "en", "balance", { amount: 42 })).toBe("Balance: 42");
	});

	test("a missing parameter leaves the placeholder visible", () => {
		// Same reasoning as returning the key: a visible `{amount}` says "a parameter was not
		// passed", a blank says nothing.
		expect(translatePluginString(tables, "en", "balance")).toBe("Balance: {amount}");
		expect(translatePluginString(tables, "en", "balance", {})).toBe("Balance: {amount}");
	});

	test("a substituted value is not itself scanned for placeholders", () => {
		// Single-pass on purpose: otherwise translated text could interpolate parameters the
		// caller never meant to expose.
		const nested: PluginStringTables = { en: { greet: "Hi {name}" } };
		expect(
			translatePluginString(nested, "en", "greet", { name: "{secret}", secret: "leaked" }),
		).toBe("Hi {secret}");
	});
});

describe("plugin i18n: locale normalization", () => {
	test("supported and aliased tags normalize to a table key", () => {
		expect(normalizePluginLocale("zh-Hans-CN")).toBe("zh-CN");
		expect(normalizePluginLocale("en-GB")).toBe("en");
	});

	test("an absent or unknown tag normalizes to the default", () => {
		expect(normalizePluginLocale(undefined)).toBe("en");
		expect(normalizePluginLocale("xx")).toBe("en");
	});
});
