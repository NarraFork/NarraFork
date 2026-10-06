import { describe, expect, test } from "bun:test";
import { sliceToUtf8Budget, utf8Bytes, withinUtf8Budget } from "@server/lib/utf8-budget";

/**
 * The whole point of this module is that a `*_BYTES` ceiling means BYTES. Every assertion
 * here compares against what an encoder actually writes (`TextEncoder`), never against
 * `Buffer.byteLength` — the function under test may not be validated by the same primitive
 * whose disagreement with reality is the defect being guarded.
 */
function encodedBytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

describe("utf8Bytes", () => {
	test("matches the encoder on well-formed text", () => {
		for (const value of ["", "ascii", "中文字符", "😀🎉", "mixed 中 😀 text"]) {
			expect(utf8Bytes(value)).toBe(encodedBytes(value));
		}
	});

	test("matches the encoder on a LONE surrogate, which Buffer.byteLength under-reports", () => {
		// Bun 1.3 charges a lone surrogate 2 bytes while every encoder writes the 3-byte
		// U+FFFD replacement. Under-reporting is the dangerous direction: it admits more
		// than the ceiling allows.
		expect(Buffer.byteLength("\ud83d", "utf8")).toBe(2);
		expect(encodedBytes("\ud83d")).toBe(3);
		expect(utf8Bytes("\ud83d")).toBe(3);

		for (const value of ["\udc00", "a\ud83db", "\ud83d".repeat(3)]) {
			expect(utf8Bytes(value)).toBe(encodedBytes(value));
		}
	});
});

describe("withinUtf8Budget", () => {
	test("a negative ceiling means no ceiling", () => {
		expect(withinUtf8Budget("中".repeat(1000), -1)).toBe(true);
	});

	test("counts bytes, not UTF-16 units", () => {
		// 3 CJK chars = 3 units but 9 bytes.
		expect(withinUtf8Budget("中中中", 9)).toBe(true);
		expect(withinUtf8Budget("中中中", 8)).toBe(false);
	});
});

describe("sliceToUtf8Budget", () => {
	test("returns the whole string when it fits", () => {
		expect(sliceToUtf8Budget("中文", 6)).toBe("中文");
		expect(sliceToUtf8Budget("ascii", 100)).toBe("ascii");
	});

	test("a non-positive ceiling yields the empty string", () => {
		expect(sliceToUtf8Budget("anything", 0)).toBe("");
		expect(sliceToUtf8Budget("anything", -5)).toBe("");
	});

	test("never exceeds the byte budget on CJK text", () => {
		const value = "中文内容".repeat(50);
		for (let budget = 1; budget <= 200; budget++) {
			const out = sliceToUtf8Budget(value, budget);
			expect(encodedBytes(out)).toBeLessThanOrEqual(budget);
			expect(value.startsWith(out)).toBe(true);
		}
	});

	test("never returns a lone surrogate when cutting astral characters", () => {
		// The regression: a boundary landing mid-pair leaves an orphan that costs the same
		// 3 bytes as the pair's lead unit, so the budget check ACCEPTS it. On emoji-dense
		// input that was most budget values, not an edge case.
		for (const base of ["😀", "a😀", "中😀", "😀中", "𝄞𝄞ab"]) {
			const value = base.repeat(60);
			for (let budget = 1; budget <= 240; budget++) {
				const out = sliceToUtf8Budget(value, budget);
				expect(out.isWellFormed()).toBe(true);
				expect(encodedBytes(out)).toBeLessThanOrEqual(budget);
				expect(value.startsWith(out)).toBe(true);
			}
		}
	});

	test("a budget that lands exactly mid-pair drops the whole character", () => {
		// "😀" is 2 units / 4 bytes. A 2-byte budget cannot hold any of it.
		expect(sliceToUtf8Budget("😀", 2)).toBe("");
		expect(sliceToUtf8Budget("😀", 3)).toBe("");
		expect(sliceToUtf8Budget("😀", 4)).toBe("😀");
		// One complete emoji plus a partial second one keeps only the complete one.
		expect(sliceToUtf8Budget("😀😀", 6)).toBe("😀");
	});

	test("leaves a lone surrogate that was already IN the input", () => {
		// Only a prefix cut's own orphan is trimmed; pre-existing malformed content is
		// preserved rather than silently rewritten, and is still charged its real 3 bytes.
		const value = `a\ud83db${"x".repeat(20)}`;
		const out = sliceToUtf8Budget(value, 9);
		expect(out).toBe("a\ud83dbxxxx");
		expect(encodedBytes(out)).toBeLessThanOrEqual(9);
	});
});
