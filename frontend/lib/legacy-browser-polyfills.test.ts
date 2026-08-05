/**
 * legacy-browser-polyfills.test.ts — Spec conformance for the Safari 14 shims.
 *
 * The sibling guard test proves a shim EXISTS for each built-in we call; this one
 * proves each shim BEHAVES like the real thing. That distinction matters because a
 * subtly wrong shim is worse than a missing one: a missing built-in throws at the
 * call site and gets noticed, while `at(-1)` quietly returning the wrong element
 * corrupts layout arithmetic with no error anywhere.
 *
 * Bun has all of these natively, so the tests install the shims onto a STRIPPED
 * prototype (native implementation deleted, shim installed, assertions run, native
 * restored). Every case is checked against the ECMAScript semantics rather than
 * against "what the app happens to pass in" — notably the coercion rules for `at`,
 * which run ToIntegerOrInfinity and so must accept fractions and NaN.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { installLegacyBrowserPolyfills } from "./legacy-browser-polyfills";

type Descriptors = Array<{ target: object; key: string; descriptor: PropertyDescriptor }>;

/** Remove a built-in, run `body` against the freshly installed shim, then restore. */
function withoutNative(targets: Array<[object, string]>, body: () => void): void {
	const saved: Descriptors = [];
	for (const [target, key] of targets) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (descriptor) saved.push({ target, key, descriptor });
		delete (target as Record<string, unknown>)[key];
	}
	try {
		installLegacyBrowserPolyfills();
		body();
	} finally {
		for (const entry of saved) {
			Object.defineProperty(entry.target, entry.key, entry.descriptor);
		}
	}
}

afterEach(() => {
	// Guard against a shim leaking into later tests if an assertion threw mid-body.
	expect(typeof Array.prototype.at).toBe("function");
});

describe("Array.prototype.at shim", () => {
	it("matches the spec for in-range, out-of-range and coerced indices", () => {
		withoutNative([[Array.prototype, "at"]], () => {
			const items = [10, 20, 30];

			expect(items.at(0)).toBe(10);
			expect(items.at(2)).toBe(30);
			expect(items.at(-1)).toBe(30);
			expect(items.at(-3)).toBe(10);

			// Out of range in both directions → undefined, never a wrapped value.
			expect(items.at(3)).toBeUndefined();
			expect(items.at(-4)).toBeUndefined();

			// ToIntegerOrInfinity: fractions truncate toward zero, NaN becomes 0.
			expect(items.at(1.9)).toBe(20);
			expect(items.at(-1.9)).toBe(30);
			expect(items.at(Number.NaN)).toBe(10);
			// biome-ignore lint/suspicious/noExplicitAny: exercising coercion of a non-number
			expect(items.at(undefined as any)).toBe(10);

			// ±Infinity is INFINITE, not NaN, and so resolves out of range in both
			// directions. Regression: the first shim tested `Number.isFinite` before
			// coercing, so `-Infinity` fell into the NaN branch and returned `items[0]`
			// — a wrong element with no error, the exact failure mode this file exists
			// to prevent.
			expect(items.at(Number.POSITIVE_INFINITY)).toBeUndefined();
			expect(items.at(Number.NEGATIVE_INFINITY)).toBeUndefined();

			// ToIntegerOrInfinity runs ToNumber first, so a numeric STRING or a boolean
			// is a valid index. Same regression as above: `Number.isFinite("1")` is
			// false, so `.at("1")` used to return `items[0]` instead of `items[1]`.
			// biome-ignore lint/suspicious/noExplicitAny: exercising ToNumber coercion
			expect(items.at("1" as any)).toBe(20);
			// biome-ignore lint/suspicious/noExplicitAny: exercising ToNumber coercion
			expect(items.at("-1" as any)).toBe(30);
			// biome-ignore lint/suspicious/noExplicitAny: exercising ToNumber coercion
			expect(items.at(true as any)).toBe(20);
			// A non-numeric string coerces to NaN → 0, not to "out of range".
			// biome-ignore lint/suspicious/noExplicitAny: exercising ToNumber coercion
			expect(items.at("abc" as any)).toBe(10);
			// -0 indexes as 0 rather than counting from the end.
			expect(items.at(-0)).toBe(10);

			// An empty array has nothing at any index.
			expect([].at(0)).toBeUndefined();
			expect([].at(-1)).toBeUndefined();

			// The shim must be non-enumerable, or `for…in` over an array would yield it
			// and every such loop in the app (or a dependency) would break.
			const keys: string[] = [];
			for (const key in items) keys.push(key);
			expect(keys).toEqual(["0", "1", "2"]);
		});
	});

	it("reads a hole as undefined without skipping later elements", () => {
		withoutNative([[Array.prototype, "at"]], () => {
			// A genuine hole (not an explicit `undefined`): `at` must read through to
			// the missing element rather than compacting the array. Built with
			// `delete` because a sparse literal is a lint error and, more usefully,
			// this states the intent outright.
			const sparse = [1, 2, 3];
			delete sparse[1];
			expect(1 in sparse).toBe(false);
			expect(sparse.at(1)).toBeUndefined();
			expect(sparse.at(-1)).toBe(3);
			expect(sparse.at(-3)).toBe(1);
		});
	});
});

describe("String.prototype.at shim", () => {
	it("indexes by UTF-16 code unit like the native method", () => {
		withoutNative([[String.prototype, "at"]], () => {
			expect("abc".at(0)).toBe("a");
			expect("abc".at(-1)).toBe("c");
			expect("abc".at(3)).toBeUndefined();
			expect("abc".at(-4)).toBeUndefined();
			expect("".at(0)).toBeUndefined();

			// Code UNITS, not code points — the native method splits surrogate pairs
			// and the shim must not "helpfully" differ.
			expect("😀".at(0)).toBe("\ud83d");
			expect("😀".at(-1)).toBe("\ude00");

			// Same coercion rules as the array form (see that test for the regression).
			expect("abc".at(Number.NEGATIVE_INFINITY)).toBeUndefined();
			expect("abc".at(Number.POSITIVE_INFINITY)).toBeUndefined();
			// biome-ignore lint/suspicious/noExplicitAny: exercising ToNumber coercion
			expect("abc".at("1" as any)).toBe("b");
		});
	});

	it("rejects a null / undefined receiver like the native method", () => {
		withoutNative([[String.prototype, "at"]], () => {
			// RequireObjectCoercible. `String(this)` alone would stringify null to
			// "null" and hand back "n" — another silently wrong character.
			// biome-ignore lint/suspicious/noExplicitAny: asserting the TypeError path
			expect(() => (String.prototype.at as any).call(null, 0)).toThrow(TypeError);
			// biome-ignore lint/suspicious/noExplicitAny: asserting the TypeError path
			expect(() => (String.prototype.at as any).call(undefined, 0)).toThrow(TypeError);
		});
	});
});

describe("Array.prototype.findLast / findLastIndex shims", () => {
	it("search from the end and report -1 / undefined when nothing matches", () => {
		withoutNative(
			[
				[Array.prototype, "findLast"],
				[Array.prototype, "findLastIndex"],
			],
			() => {
				const items = [1, 2, 3, 4];

				expect(items.findLast((v) => v % 2 === 1)).toBe(3);
				expect(items.findLastIndex((v) => v % 2 === 1)).toBe(2);
				expect(items.findLast((v) => v > 99)).toBeUndefined();
				expect(items.findLastIndex((v) => v > 99)).toBe(-1);
				expect([].findLastIndex(() => true)).toBe(-1);
			},
		);
	});

	it("pass (value, index, array) to the predicate and honour thisArg", () => {
		withoutNative(
			[
				[Array.prototype, "findLast"],
				[Array.prototype, "findLastIndex"],
			],
			() => {
				const items = ["a", "b"];
				const calls: Array<[string, number, string[]]> = [];
				items.findLast((value, index, array) => {
					calls.push([value, index, array]);
					return false;
				});
				// Visited last-to-first, with the full argument triple each time.
				expect(calls).toEqual([
					["b", 1, items],
					["a", 0, items],
				]);

				const ctx = { limit: 1 };
				const found = items.findLastIndex(function (this: typeof ctx, _v, index) {
					return index <= this.limit;
				}, ctx);
				expect(found).toBe(1);
			},
		);
	});

	it("reject a non-callable predicate", () => {
		withoutNative([[Array.prototype, "findLastIndex"]], () => {
			// biome-ignore lint/suspicious/noExplicitAny: asserting the TypeError path
			expect(() => [1].findLastIndex("nope" as any)).toThrow(TypeError);
		});
	});

	it("clamp an array-like's length the way LengthOfArrayLike does", () => {
		withoutNative(
			[
				[Array.prototype, "findLast"],
				[Array.prototype, "findLastIndex"],
			],
			() => {
				// Both shims honour `thisArg` and array-likes, so they must also honour
				// the length coercion. With a fractional length the raw `this.length - 1`
				// started the loop at 1.7 and returned 1.7 as an INDEX — native returns 1.
				const fractional = { length: 2.7, 0: "x", 1: "y", 2: "z" };
				expect(Array.prototype.findLastIndex.call(fractional, () => true)).toBe(1);
				expect(Array.prototype.findLast.call(fractional, () => true)).toBe("y");

				// A negative or NaN length is zero elements, not a reverse iteration.
				expect(Array.prototype.findLastIndex.call({ length: -1 }, () => true)).toBe(-1);
				expect(Array.prototype.findLastIndex.call({ length: Number.NaN }, () => true)).toBe(-1);

				// A numeric string length is coerced, not treated as 0.
				const stringLength = { length: "2", 0: "x", 1: "y" };
				expect(Array.prototype.findLastIndex.call(stringLength, () => true)).toBe(1);
			},
		);
	});
});

describe("Object.hasOwn shim", () => {
	it("reports own properties only, ignoring the prototype chain", () => {
		withoutNative([[Object, "hasOwn"]], () => {
			expect(Object.hasOwn({ a: 1 }, "a")).toBe(true);
			expect(Object.hasOwn({ a: 1 }, "b")).toBe(false);

			// An inherited property is NOT own — this is the whole point of the API.
			const child = Object.create({ inherited: 1 }) as Record<string, unknown>;
			child.own = 2;
			expect(Object.hasOwn(child, "own")).toBe(true);
			expect(Object.hasOwn(child, "inherited")).toBe(false);

			// Works on primitives (coerced) and on array indices.
			expect(Object.hasOwn([1], 0)).toBe(true);
			expect(Object.hasOwn([1], 1)).toBe(false);

			// A key shadowing hasOwnProperty must not break the check — this is why the
			// shim calls the saved prototype method rather than `target.hasOwnProperty`.
			const hostile = { hasOwnProperty: null, real: 1 } as unknown as object;
			expect(Object.hasOwn(hostile, "real")).toBe(true);

			// biome-ignore lint/suspicious/noExplicitAny: asserting the TypeError path
			expect(() => Object.hasOwn(null as any, "a")).toThrow(TypeError);
		});
	});
});

describe("structuredClone shim", () => {
	it("deep-clones JSON-representable values without sharing references", () => {
		withoutNative([[globalThis, "structuredClone"]], () => {
			const source = { a: 1, nested: { list: [1, 2, { deep: true }] } };
			const clone = structuredClone(source);

			expect(clone).toEqual(source);
			// Deep, not shallow: nested containers must be fresh objects.
			expect(clone).not.toBe(source);
			expect(clone.nested).not.toBe(source.nested);
			expect(clone.nested.list).not.toBe(source.nested.list);
		});
	});

	it("clones `undefined` instead of throwing on it", () => {
		withoutNative([[globalThis, "structuredClone"]], () => {
			// Native returns `undefined`. `JSON.stringify(undefined)` yields the string
			// `undefined`, which `JSON.parse` rejects — so the first fallback threw on
			// the one input the real API handles trivially.
			expect(structuredClone(undefined)).toBeUndefined();
		});
	});

	it("fails loudly for everything a JSON round-trip would quietly mangle", () => {
		withoutNative([[globalThis, "structuredClone"]], () => {
			// A cycle is the realistic mistake, and silently mangling it would be worse
			// than throwing: the caller would persist a corrupted layout envelope.
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			expect(() => structuredClone(cyclic)).toThrow(/cyclic/);

			// ⚠️ `JSON.stringify` throws ONLY for cycles and BigInt. Everything below it
			// mishandles SILENTLY, which is the worse failure: native structuredClone
			// preserves all of these, so a quiet round-trip hands the caller a value of
			// the wrong type or with its contents gone.
			expect(() => structuredClone(new Map([[1, 2]]))).toThrow(/plain objects only/);
			expect(() => structuredClone(new Set([1]))).toThrow(/plain objects only/);
			expect(() => structuredClone(new Date(0))).toThrow(/plain objects only/);
			expect(() => structuredClone(/x/)).toThrow(/plain objects only/);
			// NaN / Infinity survive structuredClone but JSON turns them into `null`.
			expect(() => structuredClone(Number.NaN)).toThrow(/NaN or Infinity/);
			expect(() => structuredClone(Number.POSITIVE_INFINITY)).toThrow(/NaN or Infinity/);
			// A function / symbol is a DataCloneError natively; JSON drops the key.
			expect(() => structuredClone(() => {})).toThrow(/function/);
			expect(() => structuredClone(Symbol("s"))).toThrow(/symbol/);

			// Nested, not just at the top level — the mangling is per value.
			expect(() => structuredClone({ nested: { when: new Date(0) } })).toThrow(
				/plain objects only/,
			);
			expect(() => structuredClone([1, [Number.NaN]])).toThrow(/NaN or Infinity/);
		});
	});

	it("rejects a `transfer` list instead of silently cloning without it", () => {
		withoutNative([[globalThis, "structuredClone"]], () => {
			// A transfer DETACHES the source and moves it into the clone. A JSON
			// round-trip does neither, so quietly dropping the option would hand the
			// caller a copy it thinks is a transfer plus a source it thinks is detached
			// — wrong in a way only the shimmed browser would show.
			const buffer = new ArrayBuffer(8);
			expect(() => structuredClone({ buffer }, { transfer: [buffer] })).toThrow(TypeError);
			expect(() => structuredClone({ buffer }, { transfer: [buffer] })).toThrow(
				/does not support transferables/,
			);

			// An EMPTY list is not a transfer request: libraries pass it
			// unconditionally and native treats it as an ordinary clone.
			expect(structuredClone({ a: 1 }, { transfer: [] })).toEqual({ a: 1 });
			// Same for an omitted / undefined option bag.
			expect(structuredClone({ a: 1 }, {})).toEqual({ a: 1 });
			expect(structuredClone({ a: 1 })).toEqual({ a: 1 });
		});
	});
});

describe("installLegacyBrowserPolyfills", () => {
	it("is idempotent and never replaces a native implementation", () => {
		const nativeAt = Array.prototype.at;
		const nativeHasOwn = Object.hasOwn;

		installLegacyBrowserPolyfills();
		installLegacyBrowserPolyfills();

		// Feature detection means a modern engine keeps exactly what it had.
		expect(Array.prototype.at).toBe(nativeAt);
		expect(Object.hasOwn).toBe(nativeHasOwn);
	});
});
