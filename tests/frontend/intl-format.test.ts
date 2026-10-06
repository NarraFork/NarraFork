import { describe, expect, test } from "bun:test";
import {
	formatLocaleDate,
	formatLocaleNumber,
	resolveIntlLocale,
} from "../../frontend/lib/intl-format";

describe("locale-aware Intl formatting", () => {
	test("normalizes explicit locale aliases", () => {
		expect(resolveIntlLocale("en-US")).toBe("en");
		expect(resolveIntlLocale("zh_Hans_CN")).toBe("zh-CN");
	});

	test("formats numbers with the selected application locale", () => {
		expect(formatLocaleNumber(1234.5, {}, "en")).toBe(new Intl.NumberFormat("en").format(1234.5));
		expect(formatLocaleNumber(1234.5, {}, "zh-CN")).toBe(
			new Intl.NumberFormat("zh-CN").format(1234.5),
		);
	});

	test("treats date-only values as local calendar dates", () => {
		const options: Intl.DateTimeFormatOptions = {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		};
		expect(formatLocaleDate("2026-07-13", options, "en")).toBe(
			new Date(2026, 6, 13).toLocaleDateString("en", options),
		);
	});

	test("returns an empty string for invalid dates", () => {
		expect(formatLocaleDate("not-a-date", {}, "en")).toBe("");
	});
});
