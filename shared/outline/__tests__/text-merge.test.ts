import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
	applyHunks,
	diffHunks,
	diffTokenHunks,
	type Hunk,
	hunksToDelta,
	MAX_EDIT_TOKENS,
	mapOffset,
	merge3,
	simpleDiff,
} from "../text-merge";
import { rng } from "./fuzz.fixture";
import * as legacy from "./text-merge-legacy.fixture";

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
			expect(applyHunks(a, diffTokenHunks(a, b))).toBe(b);
		}
	});

	test("token-aligned diffs replace a word changed inside; the editor's diff stays small", () => {
		expect(diffTokenHunks("one two three", "one twos three")).toEqual([
			{ start: 4, end: 7, text: "twos" },
		]);
		expect(diffHunks("one two three", "one twos three")).toEqual([{ start: 7, end: 7, text: "s" }]);
		expect(diffTokenHunks("这是重点内容", "这是要点内容")).toEqual([
			{ start: 2, end: 3, text: "要" },
		]);
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

	test("strict merges compare whole words; changes that only touch still merge", () => {
		// Inside one word, on different characters: the same word changed twice.
		expect(merge3("one two three", "one TWO three", "one twos three").ok).toBe(false);
		expect(merge3("one two three", "one twoo three", "one tAwo three").ok).toBe(false);
		// Lenient merges keep both, as before.
		expect(
			merge3("one two three", "one TWO three", "one twos three", { lenient: true }),
		).toMatchObject({ ok: true, result: "one TWOs three" });
		// A word changed, a sentence added right after it.
		expect(
			merge3("It takes an hour.", "It takes an hour!", "It takes an hour. Refresh early."),
		).toMatchObject({ ok: true, result: "It takes an hour! Refresh early." });
		// One CJK character is one token.
		expect(merge3("这是重点内容", "这是要点内容", "这是重点内容。")).toMatchObject({
			ok: true,
			result: "这是要点内容。",
		});
		// Two insertions at one place have no order: they overlap.
		expect(merge3("a b", "a b c", "a b d").ok).toBe(false);
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

/** Whether offset `at` of `s` falls between the two halves of a surrogate pair. */
function splitsPair(s: string, at: number): boolean {
	const hi = s.charCodeAt(at - 1);
	const lo = s.charCodeAt(at);
	return at > 0 && at < s.length && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/** Whether applying `hunks` to `a` cuts a character of `a` or of the result. */
function cutsCharacters(a: string, hunks: readonly Hunk[]): boolean {
	let out = 0;
	let pos = 0;
	const result = applyHunks(a, hunks);
	for (const h of hunks) {
		out += h.start - pos;
		if (splitsPair(a, h.start) || splitsPair(a, h.end)) return true;
		if (splitsPair(result, out) || splitsPair(result, out + h.text.length)) return true;
		out += h.text.length;
		pos = h.end;
	}
	return false;
}

describe("surrogate pairs", () => {
	test("a diff never starts or ends between the halves of a character", () => {
		// 🔴 and 🟢 share their first half; U+10000 and U+10400 their second.
		expect(simpleDiff("status 🔴", "status 🟢")).toEqual({ start: 7, end: 9, text: "🟢" });
		expect(diffHunks("status 🔴 ok", "status 🟢 ok")).toEqual([{ start: 7, end: 9, text: "🟢" }]);
		expect(simpleDiff("\u{10000}x", "\u{10400}x")).toEqual({ start: 0, end: 2, text: "\u{10400}" });
		expect(diffHunks("a\u{10000}", "a\u{10400}")).toEqual([
			{ start: 1, end: 3, text: "\u{10400}" },
		]);
		// Inside a ZWJ sequence: the changed person is replaced whole, the joiners stay.
		const family = "👨‍👩‍👧";
		const other = "👨‍👩‍👦";
		for (const hunks of [diffHunks(family, other), [simpleDiff(family, other) as Hunk]]) {
			expect(applyHunks(family, hunks)).toBe(other);
			expect(cutsCharacters(family, hunks)).toBe(false);
		}
	});

	test("random edits of emoji-heavy text: no hunk or patch cuts a character", () => {
		const alphabet = [
			"a",
			" ",
			"中",
			"😀",
			"😃",
			"🔴",
			"🟢",
			"👨‍👩‍👧",
			"\u{10000}",
			"\u{10400}",
			"́",
		];
		const r = rng(2026);
		const gen = (n: number) =>
			Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
		const mutate = (s: string) => {
			const chars = Array.from(s);
			for (let k = Math.floor(r() * 3) + 1; k > 0; k--) {
				const at = Math.floor(r() * (chars.length + 1));
				if (r() < 0.5) chars.splice(at, 1);
				else chars.splice(at, 0, alphabet[Math.floor(r() * alphabet.length)] as string);
			}
			return chars.join("");
		};
		for (let i = 0; i < 3000; i++) {
			const base = gen(Math.floor(r() * 16));
			const mine = mutate(base);
			const theirs = mutate(base);
			const one = simpleDiff(base, mine);
			for (const hunks of [diffHunks(base, mine), diffTokenHunks(base, mine), one ? [one] : []]) {
				expect(applyHunks(base, hunks)).toBe(mine);
				expect(cutsCharacters(base, hunks)).toBe(false);
			}
			const lenient = merge3(base, mine, theirs, { lenient: true });
			if (lenient.ok) expect(cutsCharacters(theirs, lenient.patch)).toBe(false);
			// Applied to a Y.Text, as a live session does, nothing turns into U+FFFD.
			const doc = new Y.Doc();
			const t = doc.getText("b");
			t.insert(0, theirs);
			if (lenient.ok) {
				// As the live session and the editor apply a patch (`session.ts`, `live-client.ts`).
				for (const h of [...lenient.patch].sort((x, y) => x.start - y.start).reverse()) {
					if (h.end > h.start) t.delete(h.start, h.end - h.start);
					if (h.text) t.insert(h.start, h.text);
				}
				expect(t.toString()).toBe(lenient.result);
				expect(t.toString()).not.toContain("�");
			}
		}
	});

	test("elsewhere the lenient merge and the editor's diffs are exactly what they were", () => {
		// The review's alphabet: emoji with shared halves, CJK, combining marks.
		const alphabet = ["a", "b", " ", "两", "字", "😀", "😃", "\n", ".", "-", "1", "ab", "́"];
		const r = rng(7);
		const gen = (n: number) =>
			Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
		const mutate = (s: string) => {
			const chars = Array.from(s);
			for (let k = Math.floor(r() * 3) + 1; k > 0; k--) {
				const at = Math.floor(r() * (chars.length + 1));
				if (r() < 0.5) chars.splice(at, 1);
				else chars.splice(at, 0, alphabet[Math.floor(r() * alphabet.length)] as string);
			}
			return chars.join("");
		};
		let compared = 0;
		for (let i = 0; i < 3000; i++) {
			const base = gen(Math.floor(r() * 20));
			const mine = mutate(base);
			const theirs = mutate(base);
			const oldHunks = legacy.diffHunks(base, mine);
			const oldOne = legacy.simpleDiff(base, mine);
			const oldMerge = legacy.merge3(base, mine, theirs, { lenient: true });
			const oldCut =
				cutsCharacters(base, oldHunks) ||
				(oldOne !== null && cutsCharacters(base, [oldOne])) ||
				cutsCharacters(base, legacy.diffHunks(base, theirs)) ||
				(oldMerge.ok && cutsCharacters(theirs, oldMerge.patch));
			if (oldCut) continue;
			compared++;
			expect(diffHunks(base, mine)).toEqual(oldHunks);
			expect(simpleDiff(base, mine)).toEqual(oldOne);
			expect(merge3(base, mine, theirs, { lenient: true })).toEqual(oldMerge);
		}
		expect(compared).toBeGreaterThan(2000);
	});
});

describe("strict merges: what one person changes as a unit", () => {
	test("dates, versions, times and amounts are one token", () => {
		expect(merge3("Due 2026-10-27.", "Due 2026-10-28.", "Due 2026-11-27.").ok).toBe(false);
		expect(merge3("v1.2", "v1.3", "v2.2").ok).toBe(false);
		expect(merge3("at 10:30", "at 10:45", "at 11:30").ok).toBe(false);
		expect(merge3("costs 1,000", "costs 1,500", "costs 2,000").ok).toBe(false);
		// Different tokens of one sentence still merge.
		expect(
			merge3("Due 2026-10-27 at 10:30.", "Due 2026-10-28 at 10:30.", "Due 2026-10-27 at 11:00."),
		).toMatchObject({ ok: true, result: "Due 2026-10-28 at 11:00." });
	});

	test("marks stay with their letters: Indic vowel signs, NFD accents", () => {
		expect(merge3("किताब", "खिताब", "कितान").ok).toBe(false);
		expect(merge3("cafe", "café", "cafes").ok).toBe(false);
		expect(merge3("kitab", "xitab", "kitan").ok).toBe(false);
	});

	test("an emoji sequence or a flag is one token", () => {
		expect(merge3("👨‍👩‍👧", "👨‍👩‍👦", "👩‍👩‍👧").ok).toBe(false);
		expect(merge3("go 👍🏽 now", "go 👍🏿 now", "go 👍🏽 later")).toMatchObject({
			ok: true,
			result: "go 👍🏿 later",
		});
		expect(merge3("🇫🇷", "🇫🇮", "🇬🇷").ok).toBe(false);
	});

	test("Chinese: changes meeting inside a word overlap; across punctuation they merge", () => {
		expect(merge3("这是重点内容", "这是要点内容", "这是重心内容").ok).toBe(false);
		expect(merge3("任务完成", "任务完结", "任务完成了").ok).toBe(false);
		// Written on after a full-width comma, or in another sentence: both kept.
		expect(merge3("任务完成", "任务完结", "任务完成，明天继续")).toMatchObject({
			ok: true,
			result: "任务完结，明天继续",
		});
		expect(
			merge3("先做设计。再写代码。", "先做草图。再写代码。", "先做设计。再写代码。最后测试。"),
		).toMatchObject({ ok: true, result: "先做草图。再写代码。最后测试。" });
	});

	test("English: a sentence added after the block's last word, which the other side changed", () => {
		expect(
			merge3("It takes an hour", "It takes a day", "It takes an hour, maybe two. Then review."),
		).toMatchObject({ ok: true, result: "It takes a day, maybe two. Then review." });
		expect(merge3("It takes an hour", "It takes a day", "It takes an hour or two").ok).toBe(true);
		// Typing onto the very word the other side changed is one change.
		expect(merge3("It takes an hour", "It takes a day", "It takes an hours").ok).toBe(false);
	});
});
