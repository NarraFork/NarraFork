import { describe, expect, test } from "bun:test";
import {
	applyHunks,
	diffHunks,
	hunksToDelta,
	MAX_EDIT_TOKENS,
	mapOffset,
	merge3,
	simpleDiff,
} from "../text-merge";
import { rng } from "./fuzz.fixture";

const ALPHABET = ["a", "b", "word", " ", "  ", "中", "文", "，", "*", "[", "]", "\n", "😀"];

function randomString(r: () => number, max: number): string {
	let s = "";
	const n = Math.floor(r() * max);
	for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
	return s;
}

/** A random edit of `s`: a few replacements at random places. */
function edit(r: () => number, s: string): string {
	let out = s;
	for (let k = Math.floor(r() * 3) + 1; k > 0; k--) {
		const at = Math.floor(r() * (out.length + 1));
		const del = Math.floor(r() * Math.min(4, out.length - at + 1));
		out = out.slice(0, at) + randomString(r, 4) + out.slice(at + del);
	}
	return out;
}

describe("diffs", () => {
	test("applying a diff gives the target, for random pairs", () => {
		const r = rng(5);
		for (let i = 0; i < 2000; i++) {
			const a = randomString(r, 40);
			const b = r() < 0.5 ? edit(r, a) : randomString(r, 40);
			expect(applyHunks(a, diffHunks(a, b))).toBe(b);
			const one = simpleDiff(a, b);
			expect(one ? applyHunks(a, [one]) : a).toBe(b);
		}
	});

	test("hunks never split a word, and huge differences stay one hunk", () => {
		expect(diffHunks("hello world", "hello there world")).toEqual([
			{ start: 6, end: 6, text: "there " },
		]);
		const a = Array.from({ length: MAX_EDIT_TOKENS * 3 }, (_, i) => `w${i}`).join(" ");
		const b = Array.from({ length: MAX_EDIT_TOKENS * 3 }, (_, i) => `x${i}`).join(" ");
		const hunks = diffHunks(a, b);
		expect(applyHunks(a, hunks)).toBe(b);
		expect(hunks.length).toBe(1);
	});

	test("offsets map across a change", () => {
		const delta = hunksToDelta(diffHunks("abc def", "abc XX def"));
		expect(mapOffset(delta, 0)).toBe(0);
		expect(mapOffset(delta, 4)).toBe(7);
		expect(mapOffset(delta, 7)).toBe(10);
	});
});

describe("three-way merge", () => {
	test("changes in different places both apply", () => {
		const m = merge3("one two three", "one 2 two three", "one two three 3");
		expect(m).toMatchObject({ ok: true, result: "one 2 two three 3" });
	});

	test("overlapping changes conflict, or merge leniently keeping both", () => {
		const strict = merge3("one two three", "one TWO three", "one deux three");
		expect(strict.ok).toBe(false);
		const lenient = merge3("one two three", "one TWO three", "one deux three", { lenient: true });
		expect(lenient.ok).toBe(true);
		if (lenient.ok) {
			expect(lenient.result).toContain("TWO");
			expect(lenient.result.startsWith("one ")).toBe(true);
		}
	});

	test("the same change on both sides is made once", () => {
		expect(merge3("crash", "crash test", "crash test")).toMatchObject({
			ok: true,
			result: "crash test",
		});
		expect(merge3("a b", "a x b c", "a x b")).toMatchObject({ ok: true, result: "a x b c" });
	});

	test("random non-overlapping edits keep every character of both sides", () => {
		const r = rng(77);
		for (let i = 0; i < 1000; i++) {
			const base = Array.from({ length: 12 }, (_, k) => `w${k}`).join(" ");
			const words = base.split(" ");
			const left = [...words];
			const right = [...words];
			left[2] = "LEFT";
			right[9] = r() < 0.5 ? "RIGHT" : "";
			const m = merge3(base, left.join(" "), right.join(" "));
			expect(m.ok).toBe(true);
			if (m.ok) {
				expect(m.result).toContain("LEFT");
				expect(m.result.includes("w2")).toBe(false);
				expect(m.result.includes("w9")).toBe(false);
			}
		}
	});

	test("lenient merges of random edits never throw and keep mine", () => {
		const r = rng(91);
		for (let i = 0; i < 2000; i++) {
			const base = randomString(r, 30);
			const mine = edit(r, base);
			const theirs = edit(r, base);
			const m = merge3(base, mine, theirs, { lenient: true });
			expect(m.ok).toBe(true);
			if (m.ok) expect(applyHunks(theirs, m.patch)).toBe(m.result);
		}
	});
});
