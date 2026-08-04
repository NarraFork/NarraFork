/**
 * reasoning-live-tail.test.ts — The live reasoning tail must show the NEWEST text
 * and cost O(1) per frame.
 *
 * Both properties are load-bearing. The feature exists because a folded reasoning
 * row froze on a settled title while the model kept writing, so a tail that is not
 * actually the end of the text would miss the point entirely. And it is computed on
 * every streaming delta, so any walk of the accumulated body reintroduces the
 * O(len²)-per-turn shape `reasoning-segments-cache.ts` was written to remove.
 */

import { describe, expect, it } from "bun:test";
import { resolveReasoningLiveTail, TAIL_CHARS, TAIL_MIN_CHARS } from "./reasoning-live-tail";

const LONG = "长文本".repeat(200);

describe("resolveReasoningLiveTail — shows the end of the text", () => {
	it("returns null while the text still fits the ordinary title view", () => {
		expect(resolveReasoningLiveTail("短短几个字")).toBeNull();
		expect(resolveReasoningLiveTail("x".repeat(TAIL_MIN_CHARS))).toBeNull();
	});

	it("produces a tail once the text exceeds the threshold", () => {
		const tail = resolveReasoningLiveTail("x".repeat(TAIL_MIN_CHARS + 1));
		expect(tail).not.toBeNull();
	});

	it("supplies enough text to fill a WIDE row", () => {
		// The reported regression: a 48-char budget left obvious empty space on a
		// full-width desktop row. The tail is a SUPPLY budget clipped on the left by
		// CSS, so over-supplying is free while under-supplying is visible.
		// ~200 latin chars is the widest realistic 12px row.
		const tail = resolveReasoningLiveTail("a".repeat(5_000));
		expect(tail?.tail.length).toBeGreaterThanOrEqual(200);
	});

	it("reports the FULL accumulated length, not the tail's own length", () => {
		// This is the "1234 字符" prefix: it tells the reader how much has been
		// written, so it must describe the whole body rather than the visible slice.
		const text = LONG;
		const tail = resolveReasoningLiveTail(text);
		expect(tail?.charCount).toBe(text.length);
		expect(tail?.tail.length).toBeLessThanOrEqual(TAIL_CHARS);
	});

	it("ends with the newest characters", () => {
		// The whole point: whatever arrived last must be visible.
		const tail = resolveReasoningLiveTail(`${LONG}最后到达的内容`);
		expect(tail?.tail.endsWith("最后到达的内容")).toBe(true);
	});

	it("tracks the end as the text grows", () => {
		let text = LONG;
		const first = resolveReasoningLiveTail(text);
		text += "新增的一段话";
		const second = resolveReasoningLiveTail(text);
		expect(second?.tail).not.toBe(first?.tail);
		expect(second?.tail.endsWith("新增的一段话")).toBe(true);
		expect(second?.charCount).toBeGreaterThan(first?.charCount ?? 0);
	});

	it("collapses newlines so a tail spanning a break reads as one line", () => {
		// The row is a single truncating line and cannot render newlines, so leaving
		// them in would only produce stray gaps.
		const tail = resolveReasoningLiveTail(`${LONG}\n\n段落一\n段落二`);
		expect(tail?.tail).not.toContain("\n");
		expect(tail?.tail.endsWith("段落一 段落二")).toBe(true);
	});

	it("still yields a tail when the end is entirely whitespace-padded prose", () => {
		const tail = resolveReasoningLiveTail(`${LONG}   \n   收尾   \n  `);
		expect(tail?.tail.endsWith("收尾")).toBe(true);
	});
});

/**
 * Slicing at a fixed code-UNIT offset can land inside a surrogate pair.
 *
 * `slice(-n)` counts UTF-16 units, so an emoji (or a CJK extension ideograph, or a
 * mathematical alphanumeric) straddling the cut leaves its low half at position 0 and
 * the row opens on a `�`. Neither `trim()` nor the whitespace collapse removes it: a
 * lone surrogate is not whitespace. BMP CJK is unaffected, which is why this went
 * unnoticed — the common case has no astral characters at all.
 */
describe("resolveReasoningLiveTail — no broken characters at the cut", () => {
	/** Every code unit in `text` participates in a valid pair (no orphans). */
	function hasLoneSurrogate(text: string): boolean {
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(i + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
				i++; // consumed the pair
				continue;
			}
			if (code >= 0xdc00 && code <= 0xdfff) return true; // low half with no high half
		}
		return false;
	}

	// The shape that actually triggers it (found by sweeping the cut, not by reading
	// the code): an astral run followed by an ODD number of single-unit characters.
	// The trailing count shifts the `-TAIL_CHARS` boundary by one unit, so odd offsets
	// land between the two halves of an emoji. Verified against the pre-fix
	// implementation: 20 of the 41 offsets below produced an orphan, all odd.
	it("never opens on an orphaned surrogate, at any cut offset", () => {
		for (let trailingAscii = 0; trailingAscii <= 40; trailingAscii++) {
			const text = `${"🙂".repeat(500)}${"b".repeat(trailingAscii)}`;
			const tail = resolveReasoningLiveTail(text);
			expect(tail).not.toBeNull();
			expect(hasLoneSurrogate(tail?.tail ?? "")).toBe(false);
			expect(tail?.tail.includes("\uFFFD")).toBe(false);
		}
	});

	// The same sweep with the astral run in the MIDDLE, so the source-window cut (not
	// just the tail cut) is exercised too.
	it("never opens on an orphaned surrogate with leading prose", () => {
		for (let pad = 0; pad <= 40; pad++) {
			const text = `${"a".repeat(1_500)}${"x".repeat(pad)}${"🙂".repeat(400)}${"c".repeat(pad)}`;
			expect(hasLoneSurrogate(resolveReasoningLiveTail(text)?.tail ?? "")).toBe(false);
		}
	});

	it("keeps reporting the full length even when a character was dropped", () => {
		const text = `${"a".repeat(2_000)}${"🙂".repeat(400)}`;
		// The size prefix describes the accumulated body, not the visible slice, so
		// discarding a broken half must not change it.
		expect(resolveReasoningLiveTail(text)?.charCount).toBe(text.length);
	});

	it("still ends on the newest complete character", () => {
		const tail = resolveReasoningLiveTail(`${"🙂".repeat(400)}🎯`);
		expect(tail?.tail.endsWith("🎯")).toBe(true);
	});

	it("handles a body made ENTIRELY of astral characters", () => {
		// The dense case: every cut offset is inside a pair with probability 1/2.
		const tail = resolveReasoningLiveTail("𝕏".repeat(1_000));
		expect(hasLoneSurrogate(tail?.tail ?? "")).toBe(false);
	});

	it("survives a body that is one astral character past the threshold", () => {
		// Short bodies take the `charCount <= minChars` path; this one is just over it,
		// so the slice runs on a body barely longer than the window.
		const text = "🙂".repeat(TAIL_MIN_CHARS);
		const tail = resolveReasoningLiveTail(text);
		expect(hasLoneSurrogate(tail?.tail ?? "")).toBe(false);
	});
});

describe("resolveReasoningLiveTail — cost is independent of the body size", () => {
	it("does not scale with the accumulated text", () => {
		// A ratio rather than a millisecond budget: absolute numbers vary by machine,
		// but "100x more text must not cost proportionally more" is a property of the
		// implementation (it slices a bounded window off the end).
		const cost = (chars: number) => {
			const text = "长文本".repeat(Math.ceil(chars / 3));
			text.charCodeAt(0); // force rope flatten outside the timed region
			resolveReasoningLiveTail(text); // warm
			const samples: number[] = [];
			for (let i = 0; i < 200; i++) {
				const started = performance.now();
				resolveReasoningLiveTail(text);
				samples.push(performance.now() - started);
			}
			samples.sort((left, right) => left - right);
			return samples[Math.floor(samples.length / 2)] ?? 0;
		};

		cost(5_000); // warm the JIT
		const early = cost(5_000);
		const late = cost(500_000);
		expect(late).toBeLessThan(Math.max(early, 0.002) * 4);
	});
});
