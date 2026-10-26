import { describe, expect, test } from "bun:test";
import { compareOrderKeys, isOrderKey, keyBetween, keysBetween, OrderKeyError } from "../order-key";
import { rng } from "./fuzz.fixture";

/** Bytewise comparison, which is what SQLite BINARY and PostgreSQL `COLLATE "C"` do. */
function byteCompare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

describe("keyBetween", () => {
	test("random inserts always land strictly between their neighbours", () => {
		const r = rng(1);
		const keys = [keyBetween(null, null)];
		for (let i = 0; i < 3000; i++) {
			const at = Math.floor(r() * (keys.length + 1));
			const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
			expect(isOrderKey(k)).toBe(true);
			if (at > 0) expect(k > (keys[at - 1] as string)).toBe(true);
			if (at < keys.length) expect(k < (keys[at] as string)).toBe(true);
			keys.splice(at, 0, k);
		}
		expect(new Set(keys).size).toBe(keys.length);
	});

	test('JavaScript order and bytewise (COLLATE "C") order agree', () => {
		const r = rng(2);
		const keys = [keyBetween(null, null)];
		for (let i = 0; i < 2000; i++) {
			const at = Math.floor(r() * (keys.length + 1));
			keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
		}
		const shuffled = [...keys].sort(() => r() - 0.5);
		expect([...shuffled].sort()).toEqual(keys);
		expect([...shuffled].sort(compareOrderKeys)).toEqual(keys);
		expect([...shuffled].sort(byteCompare)).toEqual(keys);
		// A locale collation would not: it folds case.
		expect(["a0", "Zz"].sort((a, b) => a.localeCompare(b, "en"))).toEqual(["a0", "Zz"]);
		expect(["a0", "Zz"].sort(compareOrderKeys)).toEqual(["Zz", "a0"]);
	});

	test("appending and prepending grow keys logarithmically", () => {
		let last = keyBetween(null, null);
		let first = last;
		for (let i = 0; i < 10_000; i++) {
			const next = keyBetween(last, null);
			expect(next > last).toBe(true);
			last = next;
			const prev = keyBetween(null, first);
			expect(prev < first).toBe(true);
			first = prev;
		}
		expect(last.length).toBeLessThanOrEqual(4);
		expect(first.length).toBeLessThanOrEqual(4);
	});

	test("repeatedly inserting before the same key stays reasonable", () => {
		const hi = keyBetween(null, null);
		let lo = keyBetween(null, hi);
		for (let i = 0; i < 200; i++) {
			const k = keyBetween(lo, hi);
			expect(lo < k && k < hi).toBe(true);
			lo = k;
		}
		// Bisecting toward one neighbour adds a digit about every six steps.
		expect(lo.length).toBeLessThan(45);
	});

	test("rejects malformed keys and inverted bounds", () => {
		for (const bad of ["", "a", "a00", "0a", "a0-", "aé", `A${"0".repeat(26)}`])
			expect(() => keyBetween(bad, null)).toThrow(OrderKeyError);
		expect(() => keyBetween("a1", "a0")).toThrow(OrderKeyError);
		expect(() => keyBetween("a0", "a0")).toThrow(OrderKeyError);
	});
});

describe("keysBetween", () => {
	test("returns n increasing keys strictly inside the bounds", () => {
		const cases: Array<[string | null, string | null]> = [
			[null, null],
			["a0", null],
			[null, "a0"],
			["a0", "a1"],
			["a0V", "a0W"],
		];
		for (const [a, b] of cases) {
			const ks = keysBetween(a, b, 200);
			expect(ks).toHaveLength(200);
			for (let i = 0; i < ks.length; i++) {
				const k = ks[i] as string;
				expect(isOrderKey(k)).toBe(true);
				if (i > 0) expect(k > (ks[i - 1] as string)).toBe(true);
				if (a !== null) expect(k > a).toBe(true);
				if (b !== null) expect(k < b).toBe(true);
			}
		}
	});

	test("a batch between two neighbours stays short", () => {
		const ks = keysBetween("a0", "a1", 200);
		expect(Math.max(...ks.map((k) => k.length))).toBeLessThanOrEqual(5);
	});

	test("edge counts", () => {
		expect(keysBetween("a0", "a1", 0)).toEqual([]);
		expect(keysBetween("a0", "a1", 1)).toEqual([keyBetween("a0", "a1")]);
		expect(() => keysBetween(null, null, -1)).toThrow(OrderKeyError);
	});
});
