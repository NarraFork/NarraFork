import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	clampAnimBoundary,
	commonPrefixLength,
	DEFAULT_STREAM_ANIM_DURATION_MS,
	graphemeAnimAge,
	MAX_STREAM_ANIM_DURATION_MS,
	STREAM_ANIM_DELAY_QUANTUM_MS,
	STREAM_ANIM_MAX_APPEND,
	STREAM_ANIM_MAX_KEYS,
	STREAM_ANIM_MAX_LIVE_SPANS,
	StreamAnimStore,
	segmentGraphemes,
	setStreamAnimDurationMs,
	splitFragmentForAnim,
	streamAnimDelayQuantumMs,
	streamAnimDurationMs,
} from "./stream-token-anim";

// The duration is module state now, so any test that changes it must put it back
// or it leaks into every test that follows (and the retirement clock is what most
// of this file asserts on).
afterEach(() => {
	setStreamAnimDurationMs(DEFAULT_STREAM_ANIM_DURATION_MS);
});

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
		expect(store.resolveBoundary("k", "hello", "k")).toBe(5);
	});

	it("animates only the appended suffix on pure append", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello", "k");
		// Next frame appended " world" → boundary is the old length (5).
		expect(store.resolveBoundary("k", "hello world", "k")).toBe(5);
		// A further append moves the boundary to the previous full length.
		expect(store.resolveBoundary("k", "hello world!", "k")).toBe(11);
	});

	it("seals a rewritten body instead of animating from the divergence point", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello", "k");
		// "help" diverges at offset 3, but a rewrite is not typing: boundary == length,
		// so nothing animates. See the cost-bound suite below for why.
		expect(store.resolveBoundary("k", "help", "k")).toBe(4);
	});

	it("tracks multiple keys independently", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "foo", "a");
		store.resolveBoundary("b", "bar", "b");
		// Both are pure appends onto their own key, so each animates its own suffix.
		expect(store.resolveBoundary("a", "foobar", "a")).toBe(3);
		expect(store.resolveBoundary("b", "barbaz", "b")).toBe(3);
	});

	it("evicts oldest keys past the capacity bound", () => {
		const store = new StreamAnimStore(3);
		store.resolveBoundary("a", "1", "a");
		store.resolveBoundary("b", "2", "b");
		store.resolveBoundary("c", "3", "c");
		expect(store.size()).toBe(3);
		store.resolveBoundary("d", "4", "d"); // evicts "a"
		expect(store.size()).toBe(3);
		// "a" was evicted → treated as first sighting again (boundary = full len).
		expect(store.resolveBoundary("a", "12", "a")).toBe(2);
	});

	it("re-accessing a key marks it most-recently-used (LRU)", () => {
		const store = new StreamAnimStore(2);
		store.resolveBoundary("a", "1", "a");
		store.resolveBoundary("b", "2", "b");
		// Touch "a" so it becomes newest; inserting "c" should evict "b".
		store.resolveBoundary("a", "1x", "a");
		store.resolveBoundary("c", "3", "c"); // evicts "b", keeps "a"
		// "a" still known → append boundary is its previous length ("1x" → 2).
		expect(store.resolveBoundary("a", "1xy", "a")).toBe(2);
		// "b" was evicted → first sighting again.
		expect(store.resolveBoundary("b", "2", "b")).toBe(1);
	});

	it("clear() drops all keys", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "1", "a");
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
		store.resolveBoundary("k", `不同的开头${long}`, "k");
		// Diverges at offset 0, so animating from the divergence point would put the
		// whole 200k-char body on screen as blurred per-grapheme spans in one frame.
		expect(store.peekBoundary("k", long, "k")).toBe(long.length);
	});

	it("seals front-truncation (past the 120k preview cap)", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", long, "k");
		// The cap drops from the FRONT, so the new text is not a prefix extension.
		const truncated = long.slice(1000);
		expect(store.peekBoundary("k", truncated, "k")).toBe(truncated.length);
	});

	it("clamps a huge APPEND to the trailing window", () => {
		const store = new StreamAnimStore();
		const base = "词".repeat(100);
		store.resolveBoundary("k", base, "k");
		// Genuine growth, but far more than a frame of typing (a coalesced reconnect
		// catch-up). Only the tail animates.
		const grown = base + long;
		expect(grown.length - store.peekBoundary("k", grown, "k")).toBe(STREAM_ANIM_MAX_APPEND);
	});

	it("leaves an ordinary delta untouched", () => {
		const store = new StreamAnimStore();
		const base = "词".repeat(5_000);
		store.resolveBoundary("k", base, "k");
		// A real delta is tens of chars; it must animate in full.
		expect(store.peekBoundary("k", `${base}继续写下去`, "k")).toBe(base.length);
	});

	it("still animates nothing on a first sighting", () => {
		const store = new StreamAnimStore();
		// A fresh key must not flash: boundary == length, so no grapheme is new.
		expect(store.peekBoundary("k", long, "k")).toBe(long.length);
	});

	it("seals a first sighting under a cold scope even when the text is small", () => {
		const store = new StreamAnimStore();
		// Cold scope = a mount (fresh page / narrator switch / reload): seal even a
		// tiny body — the reader has already seen it wherever it came from.
		expect(store.peekBoundary("nar:__streaming__-b0:0", "短", "nar")).toBe(1);
	});

	it("clamps a WARM-scope first sighting to the trailing append window", () => {
		const store = new StreamAnimStore();
		store.commitFrame("nar:__streaming__-b0:0", "已有段落", 1_000, "nar");
		// A block born mid-stream carrying far more than one frame of typing (a
		// hidden-tab catch-up) animates only its tail, like any oversized append.
		expect(store.peekBoundary("nar:__streaming__-b0:1", long, "nar")).toBe(
			long.length - STREAM_ANIM_MAX_APPEND,
		);
	});
});

/**
 * The new-paragraph pop-in regression. Every markdown block of a streaming body
 * animates under its own key (`${narratorId}:${spec.key}:${blockIndex}`), so a
 * paragraph born mid-stream was a FIRST SIGHTING — and first sightings used to
 * seal unconditionally, which painted the new paragraph's opening chunk with no
 * fade at all. The scope split fixes that: siblings already committed under the
 * same narrator scope prove the stream is live, so the birth animates.
 *
 * The MOUNT protection must survive: a cold scope (fresh page, narrator switch,
 * reload mid-stream) still seals, including when many blocks arrive in one frame.
 */
describe("first sighting: mount (cold scope) vs live birth (warm scope)", () => {
	it("animates a block born mid-stream under a warm scope", () => {
		const store = new StreamAnimStore();
		const t0 = 1_000_000;
		// The first paragraph's key seeds cold (mount semantics)…
		store.commitFrame("nar:s-0:0", "第一段话。", t0, "nar");
		// …and its existence makes the scope warm, so the NEW paragraph's key is a
		// live birth: boundary 0, i.e. the whole opening chunk animates.
		expect(store.peekBoundary("nar:s-0:1", "第二段", "nar")).toBe(0);
	});

	it("commits a warm-scope birth so its own appends keep animating", () => {
		const store = new StreamAnimStore();
		const t0 = 2_000_000;
		store.commitFrame("nar:s-0:0", "第一段话。", t0, "nar");
		// Render the birth frame, then commit it (the component's effect).
		const birth = store.peekFrame("nar:s-0:1", "第二段", t0 + 16, "nar");
		expect(birth.sealOffset).toBe(0);
		expect(birth.births).toEqual([{ offset: 0, ts: t0 + 16 }]);
		store.commitFrame("nar:s-0:1", "第二段", t0 + 16, "nar");
		// The next delta is an ordinary append onto the born block.
		const grown = store.peekFrame("nar:s-0:1", "第二段话", t0 + 32, "nar");
		expect(grown.animBoundary).toBe(3);
		expect(grown.sealOffset).toBe(0); // both the birth and the append are live
	});

	it("seals a later key whose scope shares only a PREFIX, not the narrator", () => {
		const store = new StreamAnimStore();
		store.commitFrame("nar-a:s-0:0", "正文", 1_000, "nar-a");
		// "nar-a2" must not warm off "nar-a": scopes compare exactly.
		expect(store.peekBoundary("nar-a2:s-0:0", "别的", "nar-a2")).toBe(2);
	});

	/**
	 * THE reported symptom: a new paragraph / heading / list item showed no fade on
	 * its FIRST delta and only animated from the second one onwards.
	 *
	 * Cause: a live row's keys derive from the constant `__streaming__` id plus a
	 * block index, so turn N+1 REUSES turn N's keys, while this store is
	 * module-level and has no per-turn reset. The new turn's block found the
	 * previous turn's text under its own key, failed `startsWith`, and was sealed
	 * as a jump. One delta later `prev.text` was this turn's text again, the append
	 * test passed, and the fade resumed — which is precisely "only the second text
	 * event animates".
	 */
	it("animates a block re-opened under a RECYCLED key (turn N+1 reusing turn N's keys)", () => {
		const store = new StreamAnimStore();
		const k0 = "n1:__streaming__-b0:0";
		const k1 = "n1:__streaming__-b0:1";
		let t = 1_000_000;
		// Turn 1 leaves text under both keys.
		store.commitFrame(k0, "第一段话有一些内容。", t, "n1");
		t += 16;
		store.commitFrame(k1, "第二段话也有内容。", t, "n1");
		t += 16;
		// Turn 2 reuses the SAME keys with fresh, short openings. Both must animate
		// from offset 0 — before the fix each returned `fullText.length` (sealed).
		expect(store.peekBoundary(k0, "新回复。", "n1")).toBe(0);
		const frame = store.peekFrame(k1, "新标题", t, "n1");
		expect(frame.animBoundary).toBe(0);
		// The stale births of turn 1 must NOT seal the new block's opening graphemes.
		expect(frame.sealOffset).toBe(0);
		store.commitFrame(k1, "新标题", t, "n1");
		t += 16;
		// And the block keeps animating normally as it grows.
		expect(store.peekBoundary(k1, "新标题内容", "n1")).toBe(3);
	});

	/**
	 * The scope is an ARGUMENT, not a slice of the key.
	 *
	 * It used to be derived by cutting the key at its first ":", which made the
	 * mount-vs-birth decision depend on a template built two layers away
	 * (`${narratorId}:${spec.key}:${blockIndex}`). Reordering that template — or
	 * changing its separator — would have degraded the scope to "one per block", so
	 * every first sighting reads cold and every new paragraph pops in without a
	 * fade: the exact defect the scope exists to fix, with no type error and no
	 * failing test. These two cases are only distinguishable once the scope is
	 * passed independently of the key.
	 */
	it("warms off an explicit scope even when the keys share no prefix", () => {
		const store = new StreamAnimStore();
		// Keys deliberately shaped so key-slicing would put them in DIFFERENT scopes.
		store.commitFrame("block-a/0", "第一段话。", 1_000, "nar-1");
		expect(store.peekBoundary("block-b/1", "第二段", "nar-1")).toBe(0);
	});

	it("stays cold across scopes even when the keys share a prefix", () => {
		const store = new StreamAnimStore();
		// Key-slicing would call both of these scope "shared" and warm the second.
		store.commitFrame("shared:0", "正文", 1_000, "nar-1");
		expect(store.peekBoundary("shared:1", "别的", "nar-2")).toBe(2);
	});

	it("decrements the scope of the EVICTED key, not the caller's scope", () => {
		const store = new StreamAnimStore(2);
		store.commitFrame("k0", "一", 1_000, "nar-a");
		store.commitFrame("k1", "二", 1_001, "nar-b");
		// Evicting k0 must cool "nar-a" (the scope k0 was committed under) and leave
		// "nar-b" warm. Reading the scope off the evicting CALLER would cool the wrong
		// one, silently sealing the live narrator's next paragraph.
		store.commitFrame("k2", "三", 1_002, "nar-b");
		expect(store.peekBoundary("k3", "新段落", "nar-a")).toBe(3);
		expect(store.peekBoundary("k4", "新段落", "nar-b")).toBe(0);
	});

	/**
	 * A retry that replaces a long body with a SHORT one is a jump, not typing.
	 *
	 * Size alone cannot see this: "抱歉，重来。" after 3000 characters passes both
	 * the ratio test and the per-frame cap, so the recycled-key branch used to
	 * admit it and replay a fade over text the reader never watched being typed.
	 * What separates a re-opened block from a short rewrite is the CONTENT: a
	 * rewrite of the same paragraph keeps its opening words.
	 */
	it("seals a SHORT rewrite that keeps the previous body's opening words", () => {
		const store = new StreamAnimStore();
		store.commitFrame("n1:s:0", "正文", 1_000, "n1");
		const long = `根据上面的分析，${"详细内容".repeat(500)}`;
		store.commitFrame("n1:s:1", long, 1_016, "n1");
		// Same opening, drastically shorter body: a rewrite of THIS block.
		const shortRewrite = "根据上面的分析，结论是另一个。";
		expect(store.peekBoundary("n1:s:1", shortRewrite, "n1")).toBe(shortRewrite.length);
	});

	it("still animates a short re-opened block that starts differently", () => {
		const store = new StreamAnimStore();
		store.commitFrame("n1:s:0", "正文", 1_000, "n1");
		store.commitFrame("n1:s:1", `旧段落的内容${"很长".repeat(500)}`, 1_016, "n1");
		// A different block under a recycled key: no shared opening, typing scale.
		expect(store.peekBoundary("n1:s:1", "新的一段", "n1")).toBe(0);
	});

	it("still seals a real jump under a warm scope (comparable-size body)", () => {
		const store = new StreamAnimStore();
		store.commitFrame("n1:s:0", "x".repeat(50), 1_000, "n1");
		const body = "词".repeat(5_000);
		store.commitFrame("n1:s:1", body, 1_016, "n1");
		// A reconnect snapshot / retry delivers a body of comparable or greater size.
		// That is what froze the tab, so the recycled-key branch must not admit it.
		const jumped = `不同的开头${body}`;
		expect(store.peekBoundary("n1:s:1", jumped, "n1")).toBe(jumped.length);
	});

	it("refuses the recycled-key branch for a body past the per-frame append cap", () => {
		const store = new StreamAnimStore();
		store.commitFrame("n1:s:0", "x", 1_000, "n1");
		store.commitFrame("n1:s:1", "词".repeat(200_000), 1_016, "n1");
		// Less than half the previous length (so the ratio test passes) but far more
		// than one frame of typing: still a jump, and admitting it would mount tens of
		// thousands of blurred spans.
		const big = `别的开头${"词".repeat(80_000)}`;
		expect(store.peekBoundary("n1:s:1", big, "n1")).toBe(big.length);
	});

	it("turns a scope cold again once its last entry is evicted", () => {
		const store = new StreamAnimStore(2);
		store.commitFrame("nar:s-0:0", "一", 1_000, "nar");
		store.commitFrame("other:s-0:0", "二", 1_001, "other");
		// Evict the only "nar" entry; its scope refcount drops to zero.
		store.commitFrame("third:s-0:0", "三", 1_002, "third");
		// A would-be sibling of the evicted key now seals: the store can no longer
		// prove the stream is live, and sealing is the safe direction.
		expect(store.peekBoundary("nar:s-0:1", "新段落", "nar")).toBe(3);
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
		// Frame 0 seeds the key: a cold-scope first sighting is a mount, so it seals.
		store.commitFrame("k", "连续输出", t0, "k");
		// Four ordinary deltas, one frame apart (~16ms), all inside the 320ms window.
		store.commitFrame("k", "连续输出的一", t0 + 16, "k");
		store.commitFrame("k", "连续输出的一行普", t0 + 32, "k");
		store.commitFrame("k", "连续输出的一行普通文", t0 + 48, "k");
		const text = "连续输出的一行普通文字内容";
		const frame = store.peekFrame("k", text, t0 + 64, "k");

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
		store.commitFrame("k", "abc", t0, "k");
		store.commitFrame("k", "abcdef", t0 + 10, "k");

		// Just inside the window: "def" is still animating, so it keeps its spans.
		const during = store.peekFrame("k", "abcdef", t0 + 10 + streamAnimDurationMs() - 1, "k");
		expect(during.sealOffset).toBe(3);
		expect(splitFragmentForAnim("abcdef", 0, during.sealOffset).animGraphemes).toHaveLength(3);

		// Past the window: the animation has reached its end state, so folding the
		// text into the static string is invisible.
		const after = store.peekFrame("k", "abcdef", t0 + 10 + streamAnimDurationMs(), "k");
		expect(after.sealOffset).toBe(6);
		expect(splitFragmentForAnim("abcdef", 0, after.sealOffset).animGraphemes).toHaveLength(0);
	});

	it("does not re-birth text on a render that appended nothing", () => {
		const store = new StreamAnimStore();
		const t0 = 3_000_000;
		store.commitFrame("k", "abc", t0, "k");
		store.commitFrame("k", "abcdef", t0 + 10, "k");
		// A re-render with identical text (hover, resize, parent rebuild) must not
		// restamp the birth, or the animation restarts and the text re-blurs forever.
		store.commitFrame("k", "abcdef", t0 + 200, "k");
		const frame = store.peekFrame("k", "abcdef", t0 + 200, "k");
		// Age is measured from the ORIGINAL birth (190ms), not from the re-render (0).
		expect(graphemeAnimAge(frame.births, 3, t0 + 200)).toBe(
			Math.floor(190 / streamAnimDelayQuantumMs()) * streamAnimDelayQuantumMs(),
		);
		// And it seals on schedule relative to that original birth.
		expect(store.peekFrame("k", "abcdef", t0 + 10 + streamAnimDurationMs(), "k").sealOffset).toBe(
			6,
		);
	});

	it("keeps the live span count bounded under sustained maximal frames", () => {
		const store = new StreamAnimStore();
		const t0 = 4_000_000;
		let text = "seed";
		store.commitFrame("k", text, t0, "k");
		// 40 frames of the largest animatable append, all inside one window: the time
		// window alone cannot bound this, so the span cap must.
		for (let i = 1; i <= 40; i++) {
			text += "词".repeat(STREAM_ANIM_MAX_APPEND);
			store.commitFrame("k", text, t0 + i, "k");
		}
		const frame = store.peekFrame("k", text, t0 + 41, "k");
		const liveSpans = text.length - frame.sealOffset;
		expect(liveSpans).toBeLessThanOrEqual(STREAM_ANIM_MAX_LIVE_SPANS + STREAM_ANIM_MAX_APPEND);
	});

	it("never seals beyond the text after a rewrite shortens it", () => {
		const store = new StreamAnimStore();
		const t0 = 5_000_000;
		store.commitFrame("k", "词".repeat(500), t0, "k");
		store.commitFrame("k", "词".repeat(900), t0 + 10, "k");
		// A retry replaces the body with something much shorter. A stale birth at
		// offset 500 would seal past the end and hide the whole static prefix.
		const frame = store.peekFrame("k", "短", t0 + 20, "k");
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
			Math.floor(100 / streamAnimDelayQuantumMs()) * streamAnimDelayQuantumMs(),
		);
	});

	it("returns 0 for a grapheme born this very frame (no delay to apply)", () => {
		expect(graphemeAnimAge([{ offset: 0, ts: 1000 }], 5, 1000)).toBe(0);
	});

	it("returns 0 once the animation is over", () => {
		expect(graphemeAnimAge([{ offset: 0, ts: 1000 }], 5, 1000 + streamAnimDurationMs())).toBe(0);
	});

	it("picks the LATEST birth at or before the grapheme's offset", () => {
		const births = [
			{ offset: 0, ts: 1000 },
			{ offset: 10, ts: 1200 },
		];
		// gid 12 belongs to the second birth (200ms younger than the first).
		expect(graphemeAnimAge(births, 12, 1264)).toBe(
			Math.floor(64 / streamAnimDelayQuantumMs()) * streamAnimDelayQuantumMs(),
		);
		// gid 3 predates it, so it uses the first.
		expect(graphemeAnimAge(births, 3, 1264)).toBe(
			Math.floor(264 / streamAnimDelayQuantumMs()) * streamAnimDelayQuantumMs(),
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

describe("configurable duration", () => {
	it("clamps to the allowed range and falls back for non-finite input", () => {
		setStreamAnimDurationMs(-50);
		expect(streamAnimDurationMs()).toBe(0);
		setStreamAnimDurationMs(99_999);
		expect(streamAnimDurationMs()).toBe(MAX_STREAM_ANIM_DURATION_MS);
		setStreamAnimDurationMs(Number.NaN);
		expect(streamAnimDurationMs()).toBe(DEFAULT_STREAM_ANIM_DURATION_MS);
	});

	it("moves the retirement clock with the configured duration", () => {
		setStreamAnimDurationMs(100);
		const store = new StreamAnimStore();
		const t0 = 6_000_000;
		store.commitFrame("k", "abc", t0, "k");
		store.commitFrame("k", "abcdef", t0, "k");

		// Still animating at 99ms under the shortened duration.
		expect(store.peekFrame("k", "abcdef", t0 + 99, "k").sealOffset).toBe(3);
		// Sealed at 100ms — where the default 320ms clock would still hold the spans.
		expect(store.peekFrame("k", "abcdef", t0 + 100, "k").sealOffset).toBe(6);
	});

	it("seals immediately at a zero duration (instant text, no spans)", () => {
		// 0 is how the setting expresses "off". A birth must retire on the very frame
		// after it is stamped, or a span survives with an animation that never runs
		// and the grapheme stays at the keyframe's opacity: 0 — invisible text.
		setStreamAnimDurationMs(0);
		const store = new StreamAnimStore();
		const t0 = 7_000_000;
		store.commitFrame("k", "abc", t0, "k");
		store.commitFrame("k", "abcdef", t0, "k");
		const frame = store.peekFrame("k", "abcdef", t0 + 1, "k");
		expect(frame.sealOffset).toBe(6);
		expect(splitFragmentForAnim("abcdef", 0, frame.sealOffset).animGraphemes).toHaveLength(0);
	});

	it("scales the delay quantum down so it stays a fraction of a short duration", () => {
		// At the default the quantum is the fixed ~2 frames.
		expect(streamAnimDelayQuantumMs()).toBe(STREAM_ANIM_DELAY_QUANTUM_MS);
		// At 60ms a fixed 32ms quantum would be over half the animation, so a
		// remounted grapheme would resume at a wildly wrong progress.
		setStreamAnimDurationMs(60);
		expect(streamAnimDelayQuantumMs()).toBe(6);
		// Never 0: graphemeAnimAge divides by it.
		setStreamAnimDurationMs(0);
		expect(streamAnimDelayQuantumMs()).toBe(1);
	});

	it("lets the span cap, not the clock, govern at the maximum duration", () => {
		// Documents the degradation the setting's description warns about: at a long
		// duration a fast stream reaches STREAM_ANIM_MAX_LIVE_SPANS and the oldest
		// graphemes seal EARLY, so the fade is shorter than configured. The cap must
		// keep holding — raising the duration must not be a way to unbound the span
		// count, which is what froze a tab before.
		setStreamAnimDurationMs(MAX_STREAM_ANIM_DURATION_MS);
		const store = new StreamAnimStore();
		const t0 = 8_000_000;
		let text = "seed";
		store.commitFrame("k", text, t0, "k");
		// ~150 graphemes/sec for 4s — an ordinary fast stream, entirely inside the 5s
		// window, so nothing retires by time alone.
		for (let i = 1; i <= 120; i++) {
			text += "词".repeat(5);
			store.commitFrame("k", text, t0 + i * 33, "k");
		}
		const frame = store.peekFrame("k", text, t0 + 121 * 33, "k");
		const liveSpans = text.length - frame.sealOffset;
		expect(liveSpans).toBeLessThanOrEqual(STREAM_ANIM_MAX_LIVE_SPANS + STREAM_ANIM_MAX_APPEND);
		// And the seal really did move: text is still held back, just a bounded amount.
		expect(frame.sealOffset).toBeGreaterThan(0);
	});

	it("keeps graphemeAnimAge inside the shortened window", () => {
		setStreamAnimDurationMs(100);
		const births = [{ offset: 0, ts: 1000 }];
		// 50ms in: still animating, so a resume offset is emitted (quantum is 10ms).
		expect(graphemeAnimAge(births, 5, 1050)).toBe(50);
		// 100ms in: over, so no delay — the span is about to be sealed anyway.
		expect(graphemeAnimAge(births, 5, 1100)).toBe(0);
	});
});

describe("CSS/JS duration pairing", () => {
	it("the CSS fallback equals the JS default", () => {
		// A CSS duration LONGER than the JS clock seals spans mid-animation and snaps
		// the character to its end state. The two are kept in sync at runtime by one
		// preference, but the FALLBACK path (nothing stored, or a frame painted before
		// AppRootLayout's effect runs) has no such coupling — only this assertion.
		const css = readFileSync(join(import.meta.dir, "..", "vlist-markdown.css"), "utf8");
		const match = css.match(
			/animation:\s*vlist-token-in\s+var\(--nf-stream-token-duration,\s*([\d.]+)s\)/,
		);
		expect(match).not.toBeNull();
		expect(Math.round(Number(match?.[1]) * 1000)).toBe(DEFAULT_STREAM_ANIM_DURATION_MS);
	});
});
