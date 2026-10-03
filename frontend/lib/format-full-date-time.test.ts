import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { formatFullLocaleDateTime } from "./format";
import { type DateInput, formatLocaleDateTime } from "./intl-format";

const options: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
};
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
	if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
	else Reflect.deleteProperty(globalThis, "document");
});

function original(value: DateInput, locale: string) {
	return formatLocaleDateTime(value, options, locale);
}

describe("bounded full timestamp labels", () => {
	test("matches the native path for every existing field and input form", () => {
		const values: DateInput[] = [
			0,
			-1,
			Date.UTC(2026, 0, 1, 0, 0, 0),
			Date.UTC(2025, 6, 9, 12, 30, 50),
			Date.UTC(1900, 0, 1),
			8640000000000000,
			-8640000000000000,
			new Date("2024-02-29T23:59:59.999Z"),
			"2024-02-29",
			"2024-02-29T23:59:59.999Z",
			new Date(Number.NaN),
			"not a date",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		for (const locale of ["en", "en-GB", "zh-CN", "zh_Hans_CN", "unsupported"]) {
			for (const value of values)
				expect(formatFullLocaleDateTime(value, locale)).toBe(original(value, locale));
		}
	});

	test("reuses repeated numeric labels including irrelevant millisecond differences", () => {
		const value = Date.UTC(2002, 3, 5, 10, 11, 12);
		const expected = original(value, "en");
		const native = spyOn(Date.prototype, "toLocaleString");
		try {
			for (const milliseconds of [0, 100, 999, 0])
				expect(formatFullLocaleDateTime(value + milliseconds, "en")).toBe(expected);
			expect(native).toHaveBeenCalledTimes(1);
		} finally {
			native.mockRestore();
		}
	});

	test("separates active languages and notices document language changes on every call", () => {
		const value = Date.UTC(2003, 3, 5, 10, 11, 12);
		const expectedEn = original(value, "en");
		const expectedZh = original(value, "zh-CN");
		const root = { lang: "en" };
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: { documentElement: root },
		});
		expect(formatFullLocaleDateTime(value)).toBe(expectedEn);
		root.lang = "zh-CN";
		expect(formatFullLocaleDateTime(value)).toBe(expectedZh);
		root.lang = "en";
		expect(formatFullLocaleDateTime(value)).toBe(expectedEn);
		expect(formatFullLocaleDateTime(value, "zh-CN")).toBe(expectedZh);
	});

	test("does not cache or alter the string and custom-Date input paths", () => {
		class CustomDate extends Date {
			toLocaleString() {
				return "custom date implementation";
			}
		}
		expect(formatFullLocaleDateTime(new CustomDate(123))).toBe("custom date implementation");
		class MutatingDate extends Date {
			toLocaleString(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
				if (options) options.month = "long";
				return super.toLocaleString(locales, options);
			}
		}
		const custom = new MutatingDate(Date.UTC(2007, 2, 1));
		expect(formatFullLocaleDateTime(custom, "en")).toBe(
			custom.toLocaleString("en", { ...options }),
		);
		const numeric = Date.UTC(2007, 2, 1);
		expect(formatFullLocaleDateTime(numeric, "en")).toBe(original(numeric, "en"));
		const date = new Date(Date.UTC(2005, 1, 2, 3, 4, 5));
		for (const locale of ["en", "zh-CN"]) {
			expect(formatFullLocaleDateTime(date, locale)).toBe(original(date, locale));
			date.setMinutes(date.getMinutes() + 1);
			expect(formatFullLocaleDateTime(date, locale)).toBe(original(date, locale));
			expect(formatFullLocaleDateTime("2005-02-02", locale)).toBe(original("2005-02-02", locale));
		}
	});

	test("invalid numbers do not resolve locale or invoke a formatter", () => {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			get() {
				throw new Error("invalid date must not inspect locale");
			},
		});
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 8640000000000001])
			expect(formatFullLocaleDateTime(value)).toBe("");
	});

	test("retains at most 256 labels and promotes a recently reused label", () => {
		const base = Date.UTC(2006, 0, 1, 0, 0, 0);
		const native = spyOn(Date.prototype, "toLocaleString");
		try {
			for (let i = 0; i < 256; i++) formatFullLocaleDateTime(base + i * 60000, "en");
			expect(native).toHaveBeenCalledTimes(256);
			formatFullLocaleDateTime(base, "en");
			expect(native).toHaveBeenCalledTimes(256);
			formatFullLocaleDateTime(base + 256 * 60000, "en");
			formatFullLocaleDateTime(base, "en");
			expect(native).toHaveBeenCalledTimes(257);
			formatFullLocaleDateTime(base + 60000, "en");
			expect(native).toHaveBeenCalledTimes(258);
		} finally {
			native.mockRestore();
		}
	});
});
