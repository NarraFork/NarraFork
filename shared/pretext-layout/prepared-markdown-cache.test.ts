/**
 * prepared-markdown-cache.test.ts — The cross-width prepared-block memo.
 *
 * What must hold:
 *  1. EQUIVALENCE — a cached parse must produce byte-identical geometry to a fresh
 *     one, at every width, in any order. This is the whole safety claim.
 *  2. IMMUTABILITY — the cached array is shared, so a consumer that mutates a block
 *     corrupts every other consumer of the same text. The plan-detail measure used
 *     to do exactly that (`block.marginTop = …`), so it is pinned here.
 *  3. KEYING — the KaTeX revision must participate, or bodies prepared before the
 *     runtime landed (formulas as literal text) get served afterwards. The FONT
 *     generation must participate for the same reason and on every body, math or
 *     not: the prepared layer bakes each fragment's pixel width in, so a face swap
 *     invalidates the wrap points of plain prose too.
 *  4. BOUNDED RETENTION — the bulk-clear has to actually fire, not merely be
 *     configured.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const LONG = `# Title\n\n${"A paragraph with markdown and `code`. ".repeat(60)}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n- one\n- two\n\n> quoted\n`;
const TABLE = `| a | b |\n| --- | --- |\n| ${"cell ".repeat(8)} | ${"y ".repeat(12)} |\n`;

/** Hostile width order: repeats, shrink, grow — exposes order-dependent state. */
const WIDTHS = [900, 300, 900, 640, 300, 1200, 640, 420, 900];

describe("prepared markdown cache", () => {
	beforeEach(async () => {
		// The font-generation seam (not the plain reset): several tests below advance
		// the generation, and it is deliberately monotonic across an entry reset, so
		// each test needs the baseline restored explicitly.
		const { resetPreparedFontRevisionForTest, resetPreparedMarkdownCache } = await import(
			"./prepared-markdown-cache"
		);
		resetPreparedFontRevisionForTest();
		// Entries too: the cache is module-level, so bodies left behind by a SIBLING
		// test file are still retained here. The ceiling test computes how many bodies
		// it must insert to cross the limit, and a non-empty starting point makes it
		// cross early — the drop then happens before its loop begins and `sawDrop`
		// reads false. It passed alone and failed in a group run.
		resetPreparedMarkdownCache();
	});

	it("measures identically whether blocks come from the cache or a fresh parse", async () => {
		const { getPreparedMarkdownBlocks } = await import("./prepared-markdown-cache");
		const { parseMarkdownToPreparedBlocks } = await import("./parse-markdown");
		const { accumulateFrame } = await import("./prepared-block");
		const { pretextLineMetrics } = await import(
			"../../frontend/components/narrator/vlist/measure/pretext-metrics"
		);

		for (const text of [LONG, TABLE]) {
			for (const width of WIDTHS) {
				const fresh = accumulateFrame(
					parseMarkdownToPreparedBlocks(text, undefined),
					width,
					pretextLineMetrics,
				);
				const cached = accumulateFrame(
					getPreparedMarkdownBlocks(text, undefined, 0),
					width,
					pretextLineMetrics,
				);
				expect(cached.contentHeight).toBe(fresh.contentHeight);
				expect(cached.usedWidth).toBe(fresh.usedWidth);
				expect(cached.blocks.length).toBe(fresh.blocks.length);
				for (let i = 0; i < fresh.blocks.length; i++) {
					expect(cached.blocks[i]?.height).toBe(fresh.blocks[i]?.height);
					expect(cached.blocks[i]?.top).toBe(fresh.blocks[i]?.top);
				}
			}
		}
	});

	it("returns the SAME array across widths (so the parse is actually reused)", async () => {
		const { getPreparedMarkdownBlocks, preparedMarkdownCacheStats } = await import(
			"./prepared-markdown-cache"
		);
		const first = getPreparedMarkdownBlocks(LONG, undefined, 0);
		for (const _width of WIDTHS) {
			expect(getPreparedMarkdownBlocks(LONG, undefined, 0)).toBe(first);
		}
		const stats = preparedMarkdownCacheStats();
		expect(stats.misses).toBe(1);
		expect(stats.hits).toBe(WIDTHS.length);
	});

	it("keys on the KaTeX revision so a pre-runtime parse is not reused after load", async () => {
		const { getPreparedMarkdownBlocks } = await import("./prepared-markdown-cache");
		const before = getPreparedMarkdownBlocks(LONG, undefined, 0);
		const after = getPreparedMarkdownBlocks(LONG, undefined, 1);
		expect(after).not.toBe(before);
	});

	it("does not cache across different bodies", async () => {
		const { getPreparedMarkdownBlocks } = await import("./prepared-markdown-cache");
		const a = getPreparedMarkdownBlocks("# one", undefined, 0);
		const b = getPreparedMarkdownBlocks("# two", undefined, 0);
		expect(a).not.toBe(b);
	});

	/**
	 * FONT GENERATION — the hazard that has nothing to do with math.
	 *
	 * `prepareRichInline` / `prepareWithSegments` bake a PIXEL WIDTH into every
	 * fragment, measured against whatever face canvas `measureText` could resolve at
	 * that moment. A math-free document's key contained no font information at all,
	 * so a body prepared under a fallback face kept serving its old wrap points after
	 * the real face arrived — measured line counts against repainted DOM, i.e. the
	 * exact list's one forbidden state.
	 *
	 * Before the cross-width memo every resize re-measured, which hid this. Caching
	 * across widths is what exposes it.
	 */
	it("misses on a font-generation change, with no math involved", async () => {
		const { getPreparedMarkdownBlocks, setPreparedFontRevision, getPreparedFontRevision } =
			await import("./prepared-markdown-cache");
		const before = getPreparedMarkdownBlocks(LONG, undefined, 0);
		expect(getPreparedMarkdownBlocks(LONG, undefined, 0)).toBe(before);

		expect(setPreparedFontRevision(getPreparedFontRevision() + 1)).toBe(true);
		// A new generation must not serve the previous generation's baked widths.
		expect(getPreparedMarkdownBlocks(LONG, undefined, 0)).not.toBe(before);
	});

	it("misses on a font-generation change for plain segment bodies too", async () => {
		const { getPreparedTextWithSegments, setPreparedFontRevision, getPreparedFontRevision } =
			await import("./prepared-markdown-cache");
		const font = "14px sans-serif";
		const before = getPreparedTextWithSegments("hello world", font, "pre-wrap");
		expect(getPreparedTextWithSegments("hello world", font, "pre-wrap")).toBe(before);

		setPreparedFontRevision(getPreparedFontRevision() + 1);
		expect(getPreparedTextWithSegments("hello world", font, "pre-wrap")).not.toBe(before);
	});

	it("reports no change (and keeps entries) when the generation is unchanged", async () => {
		const { getPreparedMarkdownBlocks, setPreparedFontRevision, getPreparedFontRevision } =
			await import("./prepared-markdown-cache");
		const blocks = getPreparedMarkdownBlocks(LONG, undefined, 0);
		// Re-publishing the SAME generation must be a no-op: a redundant
		// `document.fonts.ready` settle may not throw away a warm cache and force a
		// full-document re-measure.
		expect(setPreparedFontRevision(getPreparedFontRevision())).toBe(false);
		expect(getPreparedMarkdownBlocks(LONG, undefined, 0)).toBe(blocks);
	});

	it("keeps the generation monotonic across an entry reset", async () => {
		const {
			getPreparedMarkdownBlocks,
			setPreparedFontRevision,
			getPreparedFontRevision,
			resetPreparedMarkdownCache,
		} = await import("./prepared-markdown-cache");
		setPreparedFontRevision(getPreparedFontRevision() + 1);
		const generation = getPreparedFontRevision();
		resetPreparedMarkdownCache();
		// The generation describes the ENVIRONMENT, not the cached content; rewinding
		// it on a narrator switch would let a stale key be minted a second time.
		expect(getPreparedFontRevision()).toBe(generation);
		expect(getPreparedMarkdownBlocks("# post reset", undefined, 0).length).toBeGreaterThan(0);
	});

	/**
	 * The bulk-clear must ACTUALLY FIRE.
	 *
	 * The previous version of this test inserted 200 entries and asserted the size
	 * stayed under a 16384-ENTRY cap — true before it inserted anything, so it
	 * exercised nothing. Retention is now bounded by source characters, which lets a
	 * test reach the ceiling with a realistic number of bodies and observe the drop.
	 */
	it("bulk-clears once retained source passes the ceiling", async () => {
		const { getPreparedTextWithSegments, preparedMarkdownCacheStats, PREPARED_CACHE_CHAR_CEILING } =
			await import("./prepared-markdown-cache");
		// Driven through the SEGMENT cache: both caches share the ceiling and the
		// accounting, and this one costs a segment pass rather than a full markdown
		// parse per body — filling 4M chars through `marked` would take ~10s.
		const font = "14px sans-serif";
		const bodySize = 128 * 1024;
		const body = "word ".repeat(bodySize / 5);
		const count = Math.ceil(PREPARED_CACHE_CHAR_CEILING / bodySize) + 2;
		let sawDrop = false;
		let previousChars = 0;
		for (let i = 0; i < count; i++) {
			getPreparedTextWithSegments(`${i} ${body}`, font, "pre-wrap");
			const { chars } = preparedMarkdownCacheStats();
			// A clear is the only way retention shrinks while inserting.
			if (chars < previousChars) sawDrop = true;
			previousChars = chars;
			expect(chars).toBeLessThanOrEqual(PREPARED_CACHE_CHAR_CEILING);
		}
		expect(sawDrop).toBe(true);
		// And the cache is still usable afterwards (a clear, not a permanent stop).
		const before = preparedMarkdownCacheStats().hits;
		const prepared = getPreparedTextWithSegments("after the clear", font, "pre-wrap");
		expect(getPreparedTextWithSegments("after the clear", font, "pre-wrap")).toBe(prepared);
		expect(preparedMarkdownCacheStats().hits).toBe(before + 1);
	});

	// ── The mutation hazard ──────────────────────────────────────────────────────
	//
	// buildMarkdownDetailFrame (measure-tool-call) needs the FIRST block to carry a
	// different marginTop. It used to assign it in place. With a shared cache that
	// re-margins the body for every other consumer of the same markdown, so it must
	// copy instead. This test fails if the in-place write returns.
	it("plan-detail measurement leaves the cached blocks pristine", async () => {
		const { getPreparedMarkdownBlocks } = await import("./prepared-markdown-cache");
		const { measureMarkdownDetail } = await import(
			"../../frontend/components/narrator/vlist/measure/measure-tool-call"
		);

		const planMarkdown = `${LONG}\n\nplan tail\n`;
		const originalFirstMargin = getPreparedMarkdownBlocks(planMarkdown, undefined, 0)[0]?.marginTop;
		expect(originalFirstMargin).toBeDefined();

		// Both branches of the marginTop rewrite: with and without a provenance line,
		// at several widths (the detail re-measures per width).
		for (const width of [900, 500, 900]) {
			measureMarkdownDetail(planMarkdown, 400, width, undefined);
			measureMarkdownDetail(planMarkdown, 400, width, "docs/plan.md");
		}

		// The cached array must be untouched by those measurements.
		expect(getPreparedMarkdownBlocks(planMarkdown, undefined, 0)[0]?.marginTop).toBe(
			originalFirstMargin,
		);
	});
});

describe("prepared plain-text (segments) cache", () => {
	beforeEach(async () => {
		const { resetPreparedFontRevisionForTest } = await import("./prepared-markdown-cache");
		resetPreparedFontRevisionForTest();
	});

	it("measures identically to a fresh prepareWithSegments at every width", async () => {
		const { getPreparedTextWithSegments } = await import("./prepared-markdown-cache");
		const { measureLineStats, prepareWithSegments } = await import("@chenglou/pretext");

		const text = `用户提问：${"这是一段中文提问内容，用于验证换行一致性。".repeat(10)}\nsecond line`;
		const font = "14px sans-serif";
		for (const width of WIDTHS) {
			const fresh = measureLineStats(
				prepareWithSegments(text, font, { whiteSpace: "pre-wrap" }),
				width,
			);
			const cached = measureLineStats(getPreparedTextWithSegments(text, font, "pre-wrap"), width);
			expect(cached.lineCount).toBe(fresh.lineCount);
			expect(cached.maxLineWidth).toBe(fresh.maxLineWidth);
		}
	});

	it("reuses one prepared payload across widths and distinguishes fonts", async () => {
		const { getPreparedTextWithSegments } = await import("./prepared-markdown-cache");
		const text = "hello world";
		const a = getPreparedTextWithSegments(text, "14px sans-serif", "pre-wrap");
		expect(getPreparedTextWithSegments(text, "14px sans-serif", "pre-wrap")).toBe(a);
		expect(getPreparedTextWithSegments(text, "12px monospace", "pre-wrap")).not.toBe(a);
	});
});
