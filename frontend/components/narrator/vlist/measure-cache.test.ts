/**
 * measure-cache.test.ts — Verifies the measurement cache for correctness.
 *
 * Tests:
 * 1. Same inputs → cache hit, identical result.
 * 2. Different contentWidth / lod / opts → cache miss, fresh measurement.
 * 3. Streaming keys are never cached.
 * 4. Bulk-clear fires at ceiling (bounded memory).
 * 5. Integration: computeVListLayout uses cache, reducing actual measure calls.
 * 6. Large-window regression: 6000+ items still fully cached, no thrash.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("MeasureCache", () => {
	it("returns cached value for identical key", async () => {
		const { MeasureCache } = await import("./measure-cache");
		const cache = new MeasureCache(100);
		const result = {
			height: 42,
			blocks: [],
			frame: null as never,
			contentWidth: 600,
			usedWidth: 600,
		};
		cache.set("k1", result as never);
		expect(cache.get("k1")).toBe(result);
		expect(cache.hits).toBe(1);
	});

	it("returns undefined for missing key", async () => {
		const { MeasureCache } = await import("./measure-cache");
		const cache = new MeasureCache(100);
		expect(cache.get("nope")).toBeUndefined();
		expect(cache.misses).toBe(1);
	});

	it("bulk-clears when ceiling is reached (bounded memory)", async () => {
		const { MeasureCache } = await import("./measure-cache");
		const cache = new MeasureCache(3);
		const mk = (n: number) =>
			({ height: n, blocks: [], frame: null as never, contentWidth: 600, usedWidth: 600 }) as never;
		cache.set("a", mk(1));
		cache.set("b", mk(2));
		cache.set("c", mk(3));
		expect(cache.size).toBe(3);
		// Inserting a 4th entry exceeds ceiling → bulk-clear then insert
		cache.set("d", mk(4));
		expect(cache.size).toBe(1); // only the new entry survives
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBeUndefined();
		expect(cache.get("d")).toBeDefined();
	});

	it("does not clear when updating an existing key at capacity", async () => {
		const { MeasureCache } = await import("./measure-cache");
		const cache = new MeasureCache(3);
		const mk = (n: number) =>
			({ height: n, blocks: [], frame: null as never, contentWidth: 600, usedWidth: 600 }) as never;
		cache.set("a", mk(1));
		cache.set("b", mk(2));
		cache.set("c", mk(3));
		// Overwriting "a" at capacity should NOT trigger bulk-clear
		cache.set("a", mk(10));
		expect(cache.size).toBe(3);
		expect(cache.get("a")).toBeDefined();
		expect((cache.get("a") as { height: number }).height).toBe(10);
	});

	it("clear() empties the cache and resets stats", async () => {
		const { MeasureCache } = await import("./measure-cache");
		const cache = new MeasureCache(100);
		const mk = (n: number) =>
			({ height: n, blocks: [], frame: null as never, contentWidth: 600, usedWidth: 600 }) as never;
		cache.set("x", mk(1));
		cache.get("x");
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.hits).toBe(0);
		expect(cache.get("x")).toBeUndefined();
	});
});

describe("buildCacheKey", () => {
	it("produces identical keys for same inputs", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "markdown", 600, 5, undefined);
		const k2 = buildCacheKey("msg-123", "markdown", 600, 5, undefined);
		expect(k1).toBe(k2);
	});

	it("differentiates by contentWidth", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "markdown", 600, 5, undefined);
		const k2 = buildCacheKey("msg-123", "markdown", 800, 5, undefined);
		expect(k1).not.toBe(k2);
	});

	it("differentiates by lod", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "tool-call", 600, 5, undefined);
		const k2 = buildCacheKey("msg-123", "tool-call", 600, 3, undefined);
		expect(k1).not.toBe(k2);
	});

	it("differentiates by opts (expand state)", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "reasoning", 600, 5, { expanded: true });
		const k2 = buildCacheKey("msg-123", "reasoning", 600, 5, { expanded: false });
		expect(k1).not.toBe(k2);
	});

	it("differentiates by opts with array values (expandedIndices)", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "activity-trace", 600, 2, { expandedIndices: [1, 3] });
		const k2 = buildCacheKey("msg-123", "activity-trace", 600, 2, { expandedIndices: [1, 3, 5] });
		expect(k1).not.toBe(k2);
	});

	it("produces same key regardless of opts key order", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "tool-call", 600, 5, {
			expanded: true,
			isActive: false,
		});
		const k2 = buildCacheKey("msg-123", "tool-call", 600, 5, {
			isActive: false,
			expanded: true,
		});
		expect(k1).toBe(k2);
	});

	it("treats empty opts same as undefined opts", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "markdown", 600, 5, undefined);
		const k2 = buildCacheKey("msg-123", "markdown", 600, 5, {});
		expect(k1).toBe(k2);
	});

	it("rounds contentWidth to integer", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("msg-123", "markdown", 600.4, 5, undefined);
		const k2 = buildCacheKey("msg-123", "markdown", 600.1, 5, undefined);
		expect(k1).toBe(k2);
	});

	it("differentiates by dataRevision (status transitions)", async () => {
		const { buildCacheKey } = await import("./measure-cache");
		const k1 = buildCacheKey("tool-abc", "tool-call", 600, 5, undefined, "s:running");
		const k2 = buildCacheKey("tool-abc", "tool-call", 600, 5, undefined, "s:success");
		expect(k1).not.toBe(k2);
	});
});

describe("extractDataRevision", () => {
	it("extracts status from tool data", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		expect(extractDataRevision({ status: "running", toolName: "Read" })).toBe("s:running");
		expect(extractDataRevision({ status: "success", toolName: "Read" })).toBe("s:success");
	});

	it("includes isStreaming flag", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const rev = extractDataRevision({ status: "running", isStreaming: true });
		expect(rev).toContain("s:running");
		expect(rev).toContain("st:1");
	});

	it("includes isActive and isTerminal flags", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		expect(extractDataRevision({ isActive: true })).toContain("ac:1");
		expect(extractDataRevision({ isTerminal: true })).toContain("te:1");
	});

	it("returns undefined for data without height-affecting mutable fields", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		expect(extractDataRevision(null)).toBeUndefined();
		expect(extractDataRevision("plain string")).toBeUndefined();
		expect(extractDataRevision({ toolName: "Read" })).toBeUndefined();
	});

	/**
	 * A system card's OWN body text is height-affecting: `system-text` paints
	 * `data.text` as pre-wrap, so the height is a function of how it wraps.
	 * `detailTextRevision` only reaches `data.detail`, which a system card has none
	 * of, so this used to be the one text field with no coverage at all.
	 *
	 * It matters because of the compact-marker live-patch channel
	 * (PretextExactMessageList's `replaceOrReload`), which swaps the whole message
	 * in place while deliberately holding `messageVersion` fixed — leaving `status`
	 * as the only thing that could move the key.
	 */
	it("signs a system card's own text, so a same-status rewrite cannot hit the old height", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const marker = (text: string, status = "compacted") => ({ status, text });

		// The failure mode: SAME status, different prose. A `compacted` marker whose
		// summary was rewritten used to produce a byte-identical revision.
		const first = extractDataRevision(marker("Compressed 12 messages"));
		const rewritten = extractDataRevision(marker("Compressed 12 messages into a summary"));
		expect(first).not.toBe(rewritten);

		// Two `failed` markers with different error text — same shape, same status.
		const failedA = extractDataRevision(marker("stream ended unexpectedly", "failed"));
		const failedB = extractDataRevision(marker("provider returned 429", "failed"));
		expect(failedA).not.toBe(failedB);

		// Same-length rewrites too: length alone is not a content signature, and the
		// pre-wrap height depends on where the line breaks fall.
		const oneLine = extractDataRevision(marker("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
		const sixLines = extractDataRevision(marker("aaaa\naaaa\naaaa\naaaa\naaaa\naaaaa"));
		expect(oneLine).not.toBe(sixLines);

		// And identical input must still be identical, or the card never caches.
		expect(extractDataRevision(marker("Compressed 12 messages"))).toBe(first);
	});

	it("tracks a capped detail's body length (its text now drives the height)", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const withDetail = (text?: string) => ({
			status: "pending",
			detail: { kind: "capped", cap: "plan", ...(text === undefined ? {} : { text }) },
		});
		// A plan arriving from a pending permission must not reuse the empty height.
		const empty = extractDataRevision(withDetail());
		const filled = extractDataRevision(withDetail("# Plan\n\nbody"));
		expect(filled).not.toBe(empty);
		// An edit that changes the length invalidates too.
		expect(extractDataRevision(withDetail("# Plan\n\nbody edited"))).not.toBe(filled);
		// The signature leads with the exact length, then a sampled content hash.
		expect(filled).toContain("tx:12.");
	});

	// Length alone let two same-length bodies share a key. The pending-permission
	// plan injection rebuilds from the same loaded input, so `documentRevision`
	// does not move and the stale height (measured 104px vs 164px at one width)
	// was served for the new body.
	it("distinguishes SAME-LENGTH bodies with different line structure", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const body = (text: string) => ({
			status: "success",
			detail: { kind: "capped", cap: "term", text },
		});
		const oneLine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 30 chars, 1 line
		const sixLines = "aaaa\naaaa\naaaa\naaaa\naaaa\naaaaa"; // 30 chars, 6 lines
		expect(oneLine.length).toBe(sixLines.length);
		expect(extractDataRevision(body(oneLine))).not.toBe(extractDataRevision(body(sixLines)));
		// Identical text must still produce an identical revision, or nothing caches.
		expect(extractDataRevision(body(oneLine))).toBe(extractDataRevision(body(oneLine)));
	});

	// Sampling is strided rather than prefix-bounded so it covers the entire range
	// the measure layer can parse (DETAIL_MARKDOWN_PREFIX_MAX_CHARS = 32KB).
	it("detects a same-length edit anywhere inside the measured range", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const rev = (text: string) => extractDataRevision({ detail: { text } });
		for (const depth of [500, 2_000, 8_000, 30_000]) {
			const base = "x".repeat(depth);
			expect(rev(`${base}aaaa bbbb`)).not.toBe(rev(`${base}aaaabbbb_`));
		}
		// A change confined to the very last character is still caught.
		const long = "q".repeat(100_000);
		expect(rev(`${long}A`)).not.toBe(rev(`${long}B`));
	});

	it("keeps the revision cost bounded for a megabyte body", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const huge = "z".repeat(2_000_000);
		const started = performance.now();
		extractDataRevision({ detail: { text: huge } });
		// Fixed sample count → far below any per-frame budget (~0.05ms in practice).
		expect(performance.now() - started).toBeLessThan(20);
	});

	it("tracks body text nested inside a MULTI-PART detail's sections", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const sectioned = (text: string) => ({
			status: "success",
			detail: {
				kind: "sections",
				sections: [
					{ body: { kind: "meta-rows", rows: [{ text: "/src/a.ts" }] } },
					{ label: "output", body: { kind: "capped", cap: "code", text } },
				],
			},
		});
		// The async detail fetch replaces a truncated preview with the full body.
		// Reading only the TOP-LEVEL text fields would return the same revision for
		// both, so the card would hit the stale entry and keep its preview height.
		const preview = extractDataRevision(sectioned("first 200 chars…"));
		const full = extractDataRevision(sectioned("x".repeat(20_000)));
		expect(preview).not.toBe(full);
		expect(full).toContain("tx:20000.");
	});

	it("distinguishes a changed section label / section count", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const base = {
			status: "success",
			detail: {
				kind: "sections",
				sections: [{ label: "output", body: { kind: "capped", cap: "code", text: "a" } }],
			},
		};
		const relabelled = {
			status: "success",
			detail: {
				kind: "sections",
				sections: [{ label: "result", body: { kind: "capped", cap: "code", text: "a" } }],
			},
		};
		const extra = {
			status: "success",
			detail: {
				kind: "sections",
				sections: [
					{ label: "output", body: { kind: "capped", cap: "code", text: "a" } },
					{ label: "error", body: { kind: "error", text: "boom" } },
				],
			},
		};
		expect(extractDataRevision(base)).not.toBe(extractDataRevision(relabelled));
		expect(extractDataRevision(base)).not.toBe(extractDataRevision(extra));
	});

	it("tracks structured ENTRIES and meta ROWS growing", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const withEntries = (count: number) => ({
			status: "success",
			detail: {
				kind: "structured",
				bodyLines: [],
				entries: Array.from({ length: count }, (_, i) => ({ title: `e${i}`, snippet: "s" })),
			},
		});
		expect(extractDataRevision(withEntries(1))).not.toBe(extractDataRevision(withEntries(2)));

		const withRows = (text: string) => ({
			status: "success",
			detail: { kind: "meta-rows", rows: [{ text }] },
		});
		expect(extractDataRevision(withRows("short"))).not.toBe(
			extractDataRevision(withRows("a much longer path value")),
		);
	});

	it("tracks an ask replay gaining its answer", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		// The card keeps its spec.key while the question is answered, so without a
		// questions branch the answered card would serve the unanswered height and
		// clip the answer row away.
		const askDetail = (question: Record<string, unknown>) => ({
			status: "success",
			detail: { kind: "ask", questions: [question] },
		});
		const unanswered = askDetail({
			header: "Pick",
			omitHeader: true,
			options: [{ label: "Alpha" }, { label: "Beta" }],
		});
		const answered = askDetail({
			header: "Pick",
			omitHeader: true,
			options: [{ label: "Alpha", selected: true }, { label: "Beta" }],
			answer: "Answer: Alpha",
		});
		expect(extractDataRevision(unanswered)).not.toBe(extractDataRevision(answered));

		// Option / question count and description text all move the revision.
		const oneOption = askDetail({ header: "Pick", options: [{ label: "Alpha" }] });
		expect(extractDataRevision(oneOption)).not.toBe(extractDataRevision(unanswered));
		const described = askDetail({
			header: "Pick",
			options: [{ label: "Alpha", description: "a much longer description line" }],
		});
		expect(extractDataRevision(described)).not.toBe(extractDataRevision(oneOption));
		// omitHeader changes the height (one row less) and must be part of the key.
		expect(extractDataRevision(oneOption)).not.toBe(
			extractDataRevision(
				askDetail({ header: "Pick", omitHeader: true, options: [{ label: "Alpha" }] }),
			),
		);
	});

	// A STANDALONE card's truncated → full payload swap. The drilled-in trace row
	// keyed this all along (`tdn:`); the standalone card did not, and that is the
	// "loading full data…" that never resolved: a capped box only measures a
	// bounded PREFIX, so an 8KB preview and the 40KB full text can slice to the
	// same measured text — the detail signature does not move, `status` is already
	// terminal, and nothing else in the key changes either. The rebuild after the
	// fetch then hit the pre-fetch entry, whose payload still said
	// `truncatedLeafCount > 0`, so the notice kept painting its loading state.
	it("re-keys a standalone card when its truncated payload is replaced", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const card = (over: Record<string, unknown> = {}) => ({
			status: "success",
			detail: { kind: "capped", cap: "term", text: "identical measured prefix" },
			...over,
		});
		const truncated = extractDataRevision(
			card({ truncatedLeafCount: 1, truncatedTotalBytes: 3072 }),
		);
		// Post-fetch the adapter omits the fields entirely (see truncatedPayloadFields).
		const resolved = extractDataRevision(card());
		expect(truncated).not.toBe(resolved);
		expect(truncated).toContain("tp:1");
		// Several cut fields is a distinct height from one (the notice reports both),
		// and an unchanged card must still HIT or nothing would ever cache.
		expect(extractDataRevision(card({ truncatedLeafCount: 2 }))).not.toBe(truncated);
		expect(extractDataRevision(card({ truncatedLeafCount: 1 }))).toBe(
			extractDataRevision(card({ truncatedLeafCount: 1 })),
		);
	});

	it("tracks generic input/output body lengths", async () => {
		const { extractDataRevision } = await import("./measure-cache");
		const rev = extractDataRevision({
			status: "success",
			detail: { kind: "generic", inputText: "abc", outputText: "de" },
		});
		expect(rev).toContain("it:3");
		expect(rev).toContain("ot:2");
	});

	/**
	 * A DRILLED-IN trace row nests a whole tool card, so the fold's height now
	 * depends on that card. `opts.expandedIndices` says WHICH rows are open, never
	 * what is inside them, so the one transition it cannot express is the important
	 * one: loading the full payload swaps a truncated body (which reserved the whole
	 * cap) for the exact text and shrinks the card, while spec.key, messageVersion
	 * and opts all stay put.
	 */
	describe("drilled-in trace rows", () => {
		const traceWith = (card?: Record<string, unknown>) => ({
			headerCount: "1 call",
			items: [{ key: "tool-tu-1", title: "Read · a.ts", ...(card ? { card } : {}) }],
		});
		const codeCard = (over: Record<string, unknown> = {}) => ({
			toolName: "Read",
			status: "success",
			detail: { kind: "capped", cap: "code", text: "line1\nline2" },
			...over,
		});

		it("a collapsed fold pays nothing (no card → no card component)", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			const rev = extractDataRevision(traceWith());
			expect(rev).toContain("tk:tool-tu-1");
			expect(rev).not.toContain("tds:");
			expect(rev).not.toContain("tdn:");
		});

		it("opening a row changes the revision", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWith(codeCard()))).not.toBe(extractDataRevision(traceWith()));
		});

		it("the truncated → full payload swap re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			// Before: a prefix that reserved the whole cap. After: the exact body.
			const preview = extractDataRevision(
				traceWith(
					codeCard({
						truncatedLeafCount: 1,
						detail: { kind: "capped", cap: "code", text: "first 200…", textTruncated: true },
					}),
				),
			);
			const full = extractDataRevision(
				traceWith(
					codeCard({
						detail: { kind: "capped", cap: "code", text: "x".repeat(20_000) },
					}),
				),
			);
			expect(full).not.toBe(preview);
			expect(preview).toContain("tdn:1");
		});

		it("a status transition on the drilled-in card re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWith(codeCard({ status: "fail" })))).not.toBe(
				extractDataRevision(traceWith(codeCard())),
			);
		});

		it("a reflection gate appearing inside the card re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(
				extractDataRevision(
					traceWith(codeCard({ reflection: { title: "Danger", status: "running" } })),
				),
			).not.toBe(extractDataRevision(traceWith(codeCard())));
		});

		it("an unchanged drilled-in row still HITS (or nothing would ever cache)", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWith(codeCard()))).toBe(
				extractDataRevision(traceWith(codeCard())),
			);
		});

		/**
		 * A drilled-in SUBAGENT card carries the standalone card's whole live-patch
		 * exposure INSIDE the fold: `patchSubagentActivity` grows its recent-calls block
		 * and `subagentConclusionPatch` fills in its result, both without moving
		 * spec.key, messageVersion or opts. Keyed by folding `subagentRevision` over the
		 * row's card — without it the fold would serve the height it had when the child
		 * had made no calls yet, and the rows would be clipped away (the exact failure
		 * the standalone card's `|gn:` component exists to prevent).
		 */
		const agentCard = (over: Record<string, unknown> = {}) => ({
			agentType: "explore",
			description: "trace the vlist path",
			status: "success",
			recentCallCount: 0,
			recentCallNames: [],
			...over,
		});

		it("a subagent card's recent calls arriving re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			const before = extractDataRevision(traceWith(agentCard()));
			const after = extractDataRevision(
				traceWith(agentCard({ recentCallCount: 2, recentCallNames: ["Read", "Grep"] })),
			);
			expect(after).not.toBe(before);
			expect(after).toContain("gn:2");
		});

		it("a subagent conclusion landing re-keys the fold (status stays success)", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(
				extractDataRevision(traceWith(agentCard({ resultText: "found the dispatch site" }))),
			).not.toBe(extractDataRevision(traceWith(agentCard())));
		});

		it("opening the prompt inside a drilled-in subagent card re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			// The prompt fold lives on the CARD, not in the trace's opts, so it is the
			// only thing that moves when the reader unfolds it.
			expect(
				extractDataRevision(traceWith(agentCard({ prompt: "look", promptOpen: true }))),
			).not.toBe(extractDataRevision(traceWith(agentCard({ prompt: "look" }))));
		});

		it("an ordinary tool card pays nothing for the subagent component", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			// Gated on `agentType`, which only SubagentCardData has.
			expect(extractDataRevision(traceWith(codeCard()))).not.toContain("|ga:");
		});
	});

	/**
	 * The OTHER reveal channel: a reasoning-step row inside the L1/L2 activity fold
	 * expands its markdown body (a tool row nests a card instead). Its height is that
	 * body's, and the body arrives on the row payload rather than in `opts` — so a
	 * body edit with the same open row must not serve the earlier geometry.
	 */
	describe("reasoning rows inside the activity fold", () => {
		const traceWithBody = (bodyText?: string) => ({
			headerCount: "1 reasoning · 0 tools",
			items: [
				{ key: "r-run0-0-step-0", title: "Check the cache", ...(bodyText ? { bodyText } : {}) },
			],
		});

		it("a row that gained a body re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWithBody("the key folds lod in"))).not.toBe(
				extractDataRevision(traceWithBody()),
			);
		});

		it("editing the body text re-keys the fold", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWithBody("one line"))).not.toBe(
				extractDataRevision(traceWithBody("one line\n\nand a second paragraph")),
			);
		});

		it("an unchanged body still HITS", async () => {
			const { extractDataRevision } = await import("./measure-cache");
			expect(extractDataRevision(traceWithBody("one line"))).toBe(
				extractDataRevision(traceWithBody("one line")),
			);
		});
	});
});

describe("isStreamingKey", () => {
	it("detects streaming keys", async () => {
		const { isStreamingKey } = await import("./measure-cache");
		expect(isStreamingKey("__streaming__-bubble")).toBe(true);
		expect(isStreamingKey("msg-abc-__streaming__")).toBe(true);
		expect(isStreamingKey("msg-abc123")).toBe(false);
	});
});

describe("measureElementCached (integration)", () => {
	beforeEach(async () => {
		const { measureCache } = await import("./measure-cache");
		measureCache.clear();
	});

	it("same inputs produce identical height on second call (cache hit)", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1");
		const r2 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1");
		expect(r2.height).toBe(r1.height);
		expect(r2).toBe(r1); // same reference — cache hit
		expect(measureCache.hits).toBe(1);
	});

	it("same inputs at the same documentRevision still hit the cache", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1", 7);
		const r2 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1", 7);
		expect(r2).toBe(r1); // upward pagination rebuilds at the same version → reuse
		expect(measureCache.hits).toBe(1);
	});

	it("a new documentRevision invalidates the cache for the same key", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const v7 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1", 7);
		const v8 = measureElementCached("markdown", "Hello world.", 600, 5, undefined, "msg-1", 8);
		expect(v8).not.toBe(v7); // version bump → miss
		expect(measureCache.hits).toBe(0);
		expect(measureCache.misses).toBe(2);
	});

	it("edited-in-place message: same specKey + new documentRevision reflects new height", async () => {
		const { measureElementCached } = await import("./registry");

		// Assistant markdown block under a stable, non-shared message id.
		const short = measureElementCached("markdown", "short", 600, 5, undefined, "edit-target-b0", 3);
		// The user edits the SAME message to a much longer body. Editing keeps the
		// message id (copy-on-write only forks shared rows) but bumps the version.
		const longText = Array.from(
			{ length: 40 },
			(_, i) => `line ${i} with enough content to force real wrapping across the width`,
		).join("\n\n");
		const edited = measureElementCached(
			"markdown",
			longText,
			600,
			5,
			undefined,
			"edit-target-b0",
			4,
		);
		// Without the version in the key this returned the stale short height.
		expect(edited.height).toBeGreaterThan(short.height);
		// Ground truth: a fresh measure of the long text under a different key.
		const fresh = measureElementCached("markdown", longText, 600, 5, undefined, "fresh-key", 4);
		expect(edited.height).toBe(fresh.height);
	});

	it("different contentWidth invalidates cache", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached(
			"markdown",
			"A long text for wrapping",
			600,
			5,
			undefined,
			"m2",
		);
		const r2 = measureElementCached(
			"markdown",
			"A long text for wrapping",
			200,
			5,
			undefined,
			"m2",
		);
		expect(r2).not.toBe(r1);
		expect(measureCache.hits).toBe(0);
		expect(measureCache.misses).toBe(2);
	});

	it("different lod invalidates cache", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached(
			"reasoning",
			{ text: "thought", isStreaming: false },
			600,
			5,
			{ expanded: false },
			"r1",
		);
		const r2 = measureElementCached(
			"reasoning",
			{ text: "thought", isStreaming: false },
			600,
			3,
			{ expanded: false },
			"r1",
		);
		expect(r2).not.toBe(r1);
		expect(measureCache.hits).toBe(0);
	});

	it("different opts (expand state) invalidates cache", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached(
			"reasoning",
			{ text: "a".repeat(400), isStreaming: false },
			600,
			5,
			{ expanded: false },
			"r2",
		);
		const r2 = measureElementCached(
			"reasoning",
			{ text: "a".repeat(400), isStreaming: false },
			600,
			5,
			{ expanded: true },
			"r2",
		);
		expect(r2).not.toBe(r1);
		expect(r2.height).toBeGreaterThan(r1.height);
		expect(measureCache.hits).toBe(0);
	});

	it("streaming keys are never cached", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		measureElementCached("markdown", "streaming text", 600, 5, undefined, "__streaming__-bubble");
		measureElementCached("markdown", "streaming text", 600, 5, undefined, "__streaming__-bubble");
		expect(measureCache.size).toBe(0);
		expect(measureCache.hits).toBe(0);
	});

	it("no specKey disables caching (uncached passthrough)", async () => {
		const { measureElementCached } = await import("./registry");
		const { measureCache } = await import("./measure-cache");

		const r1 = measureElementCached("markdown", "text", 600, 5, undefined, undefined);
		const r2 = measureElementCached("markdown", "text", 600, 5, undefined, undefined);
		// Both return valid results but nothing stored
		expect(r1.height).toBe(r2.height);
		expect(measureCache.size).toBe(0);
	});
});

describe("computeVListLayout with cache (performance)", () => {
	beforeEach(async () => {
		const { measureCache } = await import("./measure-cache");
		measureCache.clear();
	});

	it("second layout build hits cache for unchanged items (O(new) not O(window))", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const { measureCache } = await import("./measure-cache");

		// Build 20 items
		const segments = Array.from({ length: 20 }, (_, i) => ({
			kind: "message" as const,
			msg: {
				id: `msg-${i}`,
				role: "user" as const,
				contentJson: [{ type: "text", text: `Message ${i} with some content` }],
			},
		}));

		// First build: all misses
		measureCache.resetStats();
		computeVListLayout(segments, { contentWidth: 600, lod: 5 });
		const firstMisses = measureCache.misses;
		const firstHits = measureCache.hits;
		expect(firstMisses).toBe(20);
		expect(firstHits).toBe(0);

		// Second build with same items: all hits (simulates loadOlder rebuilding existing)
		measureCache.resetStats();
		computeVListLayout(segments, { contentWidth: 600, lod: 5 });
		const secondHits = measureCache.hits;
		const secondMisses = measureCache.misses;
		expect(secondHits).toBe(20);
		expect(secondMisses).toBe(0);
	});

	it("prepend pattern: new items miss, existing items hit", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const { measureCache } = await import("./measure-cache");

		// Initial window: 10 items
		const existing = Array.from({ length: 10 }, (_, i) => ({
			kind: "message" as const,
			msg: {
				id: `existing-${i}`,
				role: "user" as const,
				contentJson: [{ type: "text", text: `Existing msg ${i}` }],
			},
		}));

		computeVListLayout(existing, { contentWidth: 600, lod: 5 });

		// After loadOlder: 5 new + 10 existing
		const newer = Array.from({ length: 5 }, (_, i) => ({
			kind: "message" as const,
			msg: {
				id: `new-${i}`,
				role: "user" as const,
				contentJson: [{ type: "text", text: `New msg ${i}` }],
			},
		}));
		const combined = [...newer, ...existing];

		measureCache.resetStats();
		computeVListLayout(combined, { contentWidth: 600, lod: 5 });
		// 5 new misses + 10 existing hits
		expect(measureCache.misses).toBe(5);
		expect(measureCache.hits).toBe(10);
	});

	it("large window (6000+ items) retains full working set — no LRU thrash regression", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const { measureCache } = await import("./measure-cache");

		// Simulate a large narrator: 3000 messages → ~6000+ layout items (each user
		// message produces 1 message-bubble spec).
		const N = 6500;
		const segments = Array.from({ length: N }, (_, i) => ({
			kind: "message" as const,
			msg: {
				id: `large-${i}`,
				role: "user" as const,
				contentJson: [{ type: "text", text: `Message ${i} content here` }],
			},
		}));

		// First build: all misses (populates cache with N entries)
		measureCache.resetStats();
		computeVListLayout(segments, { contentWidth: 600, lod: 5 });
		expect(measureCache.misses).toBe(N);
		expect(measureCache.hits).toBe(0);
		expect(measureCache.size).toBe(N);

		// Second build (simulates rebuild after prepend): ALL should hit cache
		measureCache.resetStats();
		computeVListLayout(segments, { contentWidth: 600, lod: 5 });
		expect(measureCache.hits).toBe(N);
		expect(measureCache.misses).toBe(0);

		// Third build with 500 new items prepended: only new items miss
		const prepended = Array.from({ length: 500 }, (_, i) => ({
			kind: "message" as const,
			msg: {
				id: `prepend-${i}`,
				role: "user" as const,
				contentJson: [{ type: "text", text: `Prepended msg ${i}` }],
			},
		}));
		const combined = [...prepended, ...segments];

		measureCache.resetStats();
		computeVListLayout(combined, { contentWidth: 600, lod: 5 });
		expect(measureCache.misses).toBe(500); // only the new items
		expect(measureCache.hits).toBe(N); // all existing items hit
	});
});
