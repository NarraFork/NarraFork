import { describe, expect, it } from "bun:test";
import {
	clampAnimBoundary,
	commonPrefixLength,
	graphemeAnimAge,
	STREAM_ANIM_DELAY_QUANTUM_MS,
	STREAM_ANIM_DURATION_MS,
	STREAM_ANIM_MAX_APPEND,
	STREAM_ANIM_MAX_KEYS,
	STREAM_ANIM_MAX_LIVE_SPANS,
	StreamAnimStore,
	segmentGraphemes,
	splitFragmentForAnim,
} from "./stream-token-anim";

describe("segmentGraphemes", () => {
	it("splits ASCII into one grapheme per character with offsets", () => {
		const g = segmentGraphemes("abc");
		expect(g).toEqual([
			{ text: "a", start: 0, end: 1 },
			{ text: "b", start: 1, end: 2 },
			{ text: "c", start: 2, end: 3 },
		]);
	});

	it("keeps CJK characters as single graphemes with correct offsets", () => {
		const g = segmentGraphemes("你好");
		expect(g.map((x) => x.text)).toEqual(["你", "好"]);
		expect(g[0]).toEqual({ text: "你", start: 0, end: 1 });
		expect(g[1]).toEqual({ text: "好", start: 1, end: 2 });
	});

	it("keeps surrogate-pair emoji together (code-unit offsets)", () => {
		const g = segmentGraphemes("a😀b");
		expect(g.map((x) => x.text)).toEqual(["a", "😀", "b"]);
		// 😀 is 2 UTF-16 code units → offsets 1..3, then b at 3..4.
		expect(g[1]).toEqual({ text: "😀", start: 1, end: 3 });
		expect(g[2]).toEqual({ text: "b", start: 3, end: 4 });
	});

	it("returns empty for empty input", () => {
		expect(segmentGraphemes("")).toEqual([]);
	});
});

describe("commonPrefixLength", () => {
	it("returns full length when one is a prefix of the other", () => {
		expect(commonPrefixLength("hello", "hello world")).toBe(5);
	});
	it("returns divergence point on rewrite", () => {
		expect(commonPrefixLength("hello", "help")).toBe(3);
	});
	it("returns 0 when nothing matches", () => {
		expect(commonPrefixLength("abc", "xyz")).toBe(0);
	});
});

describe("StreamAnimStore.resolveBoundary", () => {
	it("does not animate on first sighting (boundary = full length)", () => {
		const store = new StreamAnimStore();
		expect(store.resolveBoundary("k", "hello")).toBe(5);
	});

	it("animates only the appended suffix on pure append", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello");
		// Next frame appended " world" → boundary is the old length (5).
		expect(store.resolveBoundary("k", "hello world")).toBe(5);
		// A further append moves the boundary to the previous full length.
		expect(store.resolveBoundary("k", "hello world!")).toBe(11);
	});

	it("seals a rewritten body instead of animating from the divergence point", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello");
		// "help" diverges at offset 3, but a rewrite is not typing: boundary == length,
		// so nothing animates. See the cost-bound suite below for why.
		expect(store.resolveBoundary("k", "help")).toBe(4);
	});

	it("tracks multiple keys independently", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "foo");
		store.resolveBoundary("b", "bar");
		// Both are pure appends onto their own key, so each animates its own suffix.
		expect(store.resolveBoundary("a", "foobar")).toBe(3);
		expect(store.resolveBoundary("b", "barbaz")).toBe(3);
	});

	it("evicts oldest keys past the capacity bound", () => {
		const store = new StreamAnimStore(3);
		store.resolveBoundary("a", "1");
		store.resolveBoundary("b", "2");
		store.resolveBoundary("c", "3");
		expect(store.size()).toBe(3);
		store.resolveBoundary("d", "4"); // evicts "a"
		expect(store.size()).toBe(3);
		// "a" was evicted → treated as first sighting again (boundary = full len).
		expect(store.resolveBoundary("a", "12")).toBe(2);
	});

	it("re-accessing a key marks it most-recently-used (LRU)", () => {
		const store = new StreamAnimStore(2);
		store.resolveBoundary("a", "1");
		store.resolveBoundary("b", "2");
		// Touch "a" so it becomes newest; inserting "c" should evict "b".
		store.resolveBoundary("a", "1x");
		store.resolveBoundary("c", "3"); // evicts "b", keeps "a"
		// "a" still known → append boundary is its previous length ("1x" → 2).
		expect(store.resolveBoundary("a", "1xy")).toBe(2);
		// "b" was evicted → first sighting again.
		expect(store.resolveBoundary("b", "2")).toBe(1);
	});

	it("clear() drops all keys", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "1");
		store.clear();
		expect(store.size()).toBe(0);
	});

	it("exposes a sane default capacity", () => {
		expect(STREAM_ANIM_MAX_KEYS).toBeGreaterThan(0);
	});
});

/**
 * The tab-freeze guard. A live row's spec.key comes from the synthetic
 * `__streaming__` id, so it is the SAME string for every narrator, while the anim
 * store is module-level. Switching to a narrator mid-reasoning therefore found the
 * previous narrator's text under that key, classified the new body as a rewrite,
 * and returned a boundary near 0 — which made the renderer mount one blurred
 * `<span>` per grapheme for the whole body in a single frame. Tens of thousands of
 * `filter: blur()` layers froze the tab, with the text stuck at the keyframe's
 * `opacity: 0` (only inline-code chip backgrounds showed).
 *
 * The key is now namespaced per narrator, but that alone is not a guard: a
 * reconnect snapshot, a retry that rewrites the body, and the front-truncation
 * `appendStreamingTextPreview` applies past its 120k cap all produce the same jump
 * under one key. So the boundary is CLAMPED to a bounded tail regardless of cause.
 */
describe("animation cost is bounded however the text jumps", () => {
	const long = "词".repeat(200_000);

	it("seals a rewrite (a stale key from another narrator, or a retry)", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", `不同的开头${long}`);
		// Diverges at offset 0, so animating from the divergence point would put the
		// whole 200k-char body on screen as blurred per-grapheme spans in one frame.
		expect(store.peekBoundary("k", long)).toBe(long.length);
	});

	it("seals front-truncation (past the 120k preview cap)", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", long);
		// The cap drops from the FRONT, so the new text is not a prefix extension.
		const truncated = long.slice(1000);
		expect(store.peekBoundary("k", truncated)).toBe(truncated.length);
	});

	it("clamps a huge APPEND to the trailing window", () => {
		const store = new StreamAnimStore();
		const base = "词".repeat(100);
		store.resolveBoundary("k", base);
		// Genuine growth, but far more than a frame of typing (a coalesced reconnect
		// catch-up). Only the tail animates.
		const grown = base + long;
		expect(grown.length - store.peekBoundary("k", grown)).toBe(STREAM_ANIM_MAX_APPEND);
	});

	it("leaves an ordinary delta untouched", () => {
		const store = new StreamAnimStore();
		const base = "词".repeat(5_000);
		store.resolveBoundary("k", base);
		// A real delta is tens of chars; it must animate in full.
		expect(store.peekBoundary("k", `${base}继续写下去`)).toBe(base.length);
	});

	it("still animates nothing on a first sighting", () => {
		const store = new StreamAnimStore();
		// A fresh key must not flash: boundary == length, so no grapheme is new.
		expect(store.peekBoundary("k", long)).toBe(long.length);
	});
});

/**
 * THE regression this module was rewritten for.
 *
 * The original implementation had one water mark, the append boundary, and split
 * the fragment there. Because the boundary advances on every delta, a grapheme's
 * animated span existed for exactly ONE frame: the next delta folded it into the
 * static string, React unmounted the span, and the running CSS animation died at
 * roughly 5% progress. During continuous plain-text output almost nothing appeared
 * to fade in — only the last delta before a pause, which had no successor to evict
 * it.
 *
 * These tests pin the fix at the level where it is decidable: after N frames of
 * ordinary appends inside one animation window, the graphemes from the FIRST of
 * those frames must still be animating.
 */
describe("a grapheme keeps animating across later deltas", () => {
	it("still animates text from 4 frames ago (single-boundary bug: it did not)", () => {
		const store = new StreamAnimStore();
		const t0 = 1_000_000;
		// Frame 0 seeds the key: first sighting never animates.
		store.commitFrame("k", "连续输出", t0);
		// Four ordinary deltas, one frame apart (~16ms), all inside the 320ms window.
		store.commitFrame("k", "连续输出的一", t0 + 16);
		store.commitFrame("k", "连续输出的一行普", t0 + 32);
		store.commitFrame("k", "连续输出的一行普通文", t0 + 48);
		const text = "连续输出的一行普通文字内容";
		const frame = store.peekFrame("k", text, t0 + 64);

		// The append boundary is where THIS frame's text starts (content-driven):
		// the length of the previously committed body.
		expect(frame.animBoundary).toBe(10);
		// The seal offset lags all the way back to the first delta of the window —
		// everything typed since is still animating. Under the old single-boundary
		// implementation the split point was 10 and only the last 3 chars animated.
		expect(frame.sealOffset).toBe(4);

		const split = splitFragmentForAnim(text, 0, frame.sealOffset);
		expect(split.staticText).toBe("连续输出");
		// Every character typed during the window holds its own span.
		expect(split.animGraphemes.map((g) => g.text).join("")).toBe("的一行普通文字内容");
	});

	it("seals a grapheme only after its animation has finished", () => {
		const store = new StreamAnimStore();
		const t0 = 2_000_000;
		store.commitFrame("k", "abc", t0);
		store.commitFrame("k", "abcdef", t0 + 10);

		// Just inside the window: "def" is still animating, so it keeps its spans.
		const during = store.peekFrame("k", "abcdef", t0 + 10 + STREAM_ANIM_DURATION_MS - 1);
		expect(during.sealOffset).toBe(3);
		expect(splitFragmentForAnim("abcdef", 0, during.sealOffset).animGraphemes).toHaveLength(3);

		// Past the window: the animation has reached its end state, so folding the
		// text into the static string is invisible.
		const after = store.peekFrame("k", "abcdef", t0 + 10 + STREAM_ANIM_DURATION_MS);
		expect(after.sealOffset).toBe(6);
		expect(splitFragmentForAnim("abcdef", 0, after.sealOffset).animGraphemes).toHaveLength(0);
	});

	it("does not re-birth text on a render that appended nothing", () => {
		const store = new StreamAnimStore();
		const t0 = 3_000_000;
		store.commitFrame("k", "abc", t0);
		store.commitFrame("k", "abcdef", t0 + 10);
		// A re-render with identical text (hover, resize, parent rebuild) must not
		// restamp the birth, or the animation restarts and the text re-blurs forever.
		store.commitFrame("k", "abcdef", t0 + 200);
		const frame = store.peekFrame("k", "abcdef", t0 + 200);
		// Age is measured from the ORIGINAL birth (190ms), not from the re-render (0).
		expect(graphemeAnimAge(frame.births, 3, t0 + 200)).toBe(
			Math.floor(190 / STREAM_ANIM_DELAY_QUANTUM_MS) * STREAM_ANIM_DELAY_QUANTUM_MS,
		);
		// And it seals on schedule relative to that original birth.
		expect(store.peekFrame("k", "abcdef", t0 + 10 + STREAM_ANIM_DURATION_MS).sealOffset).toBe(6);
	});

	it("keeps the live span count bounded under sustained maximal frames", () => {
		const store = new StreamAnimStore();
		const t0 = 4_000_000;
		let text = "seed";
		store.commitFrame("k", text, t0);
		// 40 frames of the largest animatable append, all inside one window: the time
		// window alone cannot bound this, so the span cap must.
		for (let i = 1; i <= 40; i++) {
			text += "词".repeat(STREAM_ANIM_MAX_APPEND);
			store.commitFrame("k", text, t0 + i);
		}
		const frame = store.peekFrame("k", text, t0 + 41);
		const liveSpans = text.length - frame.sealOffset;
		expect(liveSpans).toBeLessThanOrEqual(STREAM_ANIM_MAX_LIVE_SPANS + STREAM_ANIM_MAX_APPEND);
	});

	it("never seals beyond the text after a rewrite shortens it", () => {
		const store = new StreamAnimStore();
		const t0 = 5_000_000;
		store.commitFrame("k", "词".repeat(500), t0);
		store.commitFrame("k", "词".repeat(900), t0 + 10);
		// A retry replaces the body with something much shorter. A stale birth at
		// offset 500 would seal past the end and hide the whole static prefix.
		const frame = store.peekFrame("k", "短", t0 + 20);
		expect(frame.sealOffset).toBeLessThanOrEqual(1);
		expect(splitFragmentForAnim("短", 0, frame.sealOffset).staticText.length).toBeLessThanOrEqual(
			1,
		);
	});
});

describe("graphemeAnimAge", () => {
	it("quantizes the elapsed time so a live span's style is stable", () => {
		const births = [{ offset: 0, ts: 1000 }];
		// 100ms in → floored to the quantum grid.
		expect(graphemeAnimAge(births, 5, 1100)).toBe(
			Math.floor(100 / STREAM_ANIM_DELAY_QUANTUM_MS) * STREAM_ANIM_DELAY_QUANTUM_MS,
		);
	});

	it("returns 0 for a grapheme born this very frame (no delay to apply)", () => {
		expect(graphemeAnimAge([{ offset: 0, ts: 1000 }], 5, 1000)).toBe(0);
	});

	it("returns 0 once the animation is over", () => {
		expect(graphemeAnimAge([{ offset: 0, ts: 1000 }], 5, 1000 + STREAM_ANIM_DURATION_MS)).toBe(0);
	});

	it("picks the LATEST birth at or before the grapheme's offset", () => {
		const births = [
			{ offset: 0, ts: 1000 },
			{ offset: 10, ts: 1200 },
		];
		// gid 12 belongs to the second birth (200ms younger than the first).
		expect(graphemeAnimAge(births, 12, 1264)).toBe(
			Math.floor(64 / STREAM_ANIM_DELAY_QUANTUM_MS) * STREAM_ANIM_DELAY_QUANTUM_MS,
		);
		// gid 3 predates it, so it uses the first.
		expect(graphemeAnimAge(births, 3, 1264)).toBe(
			Math.floor(264 / STREAM_ANIM_DELAY_QUANTUM_MS) * STREAM_ANIM_DELAY_QUANTUM_MS,
		);
	});

	it("returns 0 when no birth covers the offset", () => {
		expect(graphemeAnimAge([{ offset: 10, ts: 1000 }], 3, 1100)).toBe(0);
	});
});

describe("clampAnimBoundary", () => {
	it("pushes an early boundary up to the trailing window", () => {
		expect(clampAnimBoundary(0, 10_000)).toBe(10_000 - STREAM_ANIM_MAX_APPEND);
	});

	it("never moves a boundary already inside the window", () => {
		expect(clampAnimBoundary(9_990, 10_000)).toBe(9_990);
	});

	it("leaves a short body alone (window exceeds its length)", () => {
		expect(clampAnimBoundary(0, 10)).toBe(0);
	});
});

describe("splitFragmentForAnim", () => {
	it("returns all-static when the fragment ends before the boundary", () => {
		const r = splitFragmentForAnim("hello", 0, 10);
		expect(r).toEqual({ staticText: "hello", animGraphemes: [] });
	});

	it("returns all-static when the fragment ends exactly at the boundary", () => {
		const r = splitFragmentForAnim("hello", 0, 5);
		expect(r).toEqual({ staticText: "hello", animGraphemes: [] });
	});

	it("animates every grapheme when the fragment starts at/after the boundary", () => {
		const r = splitFragmentForAnim("abc", 5, 5);
		expect(r.staticText).toBe("");
		expect(r.animGraphemes).toEqual([
			{ gid: 5, text: "a" },
			{ gid: 6, text: "b" },
			{ gid: 7, text: "c" },
		]);
	});

	it("splits a straddling fragment into static prefix + animated tail", () => {
		// Fragment "world" starts at global offset 6; boundary at 8 → "wo" static,
		// "rld" animated with global gids 8,9,10.
		const r = splitFragmentForAnim("world", 6, 8);
		expect(r.staticText).toBe("wo");
		expect(r.animGraphemes).toEqual([
			{ gid: 8, text: "r" },
			{ gid: 9, text: "l" },
			{ gid: 10, text: "d" },
		]);
	});

	it("never splits a multi-unit grapheme across the boundary", () => {
		// "a😀" starts at offset 4; boundary 5 falls INSIDE the emoji's code units
		// (emoji at global 5..7). The emoji's start (5) >= boundary → animated whole.
		const r = splitFragmentForAnim("a😀", 4, 5);
		expect(r.staticText).toBe("a");
		expect(r.animGraphemes).toEqual([{ gid: 5, text: "😀" }]);
	});

	it("keeps CJK grapheme gids at code-unit offsets", () => {
		const r = splitFragmentForAnim("你好", 3, 4);
		expect(r.staticText).toBe("你");
		expect(r.animGraphemes).toEqual([{ gid: 4, text: "好" }]);
	});
});
