/**
 * low-lod-streaming-cost.test.ts — Per-frame cost of a LIVE turn at low LOD.
 *
 * Why this guard exists
 * ---------------------
 * Low LOD now folds live content into the activity trace (see render-units.ts), so
 * the hand-off from streaming card to folded row is visually inert. That fold has a
 * cost consequence which is easy to regress and invisible in a correctness test: the
 * growing streaming text is no longer a SEPARATE element beside a stable trace, it is
 * a ROW OF that trace. The measurement cache keys on content, so every delta
 * re-ADAPTS the whole fold, and anything in that path which walks the accumulated
 * text turns a long turn into O(len²) — the stream visibly stutters as the reply gets
 * longer, which is exactly the "keep it smooth" requirement this change had to honour.
 *
 * ⚠️ Two ways an earlier version of this file was a FALSE GREEN, both worth stating
 * because either would silently disarm the guard again:
 *
 *  1. It drove `groupRenderUnits` + `adaptRenderUnits` directly. Activity units get
 *     their `key` from `buildPretextDocumentLayout`, so `spec.key` was undefined,
 *     `measureElementCached` took its "no stable key" branch, and the measurement
 *     cache was bypassed entirely (0 entries, 0 hits). It measured a path production
 *     never runs. Always go through `buildPretextDocumentLayout`.
 *  2. It sampled 1-3k vs 20-22k chars, which showed only 1.37x and passed a `< 4x`
 *     threshold while the real regression (0.365ms → 3.573ms, ~9.8x) lived further
 *     out. The window has to reach the sizes a long reasoning stream actually hits.
 *
 * The assertion is a RATIO, not a millisecond budget: absolute numbers vary across
 * machines and CI load, but "a frame carrying 100x more accumulated text must not
 * cost proportionally more" is a property of the algorithm.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

/** A finished tool call, folded as a plain trace row. */
function finishedTool(index: number) {
	return {
		id: `m${index}`,
		seq: index,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: `tu-${index}`,
				name: "Read",
				input: { file_path: `src/f${index}.ts` },
			},
		],
		toolCalls: [{ id: `c${index}`, toolUseId: `tu-${index}`, toolName: "Read", status: "success" }],
		children: [],
	};
}

/** The live row: one reasoning block whose text grows frame to frame. */
function streamingMessage(text: string) {
	return {
		id: "__streaming__",
		seq: 999,
		role: "assistant",
		contentJson: [{ type: "reasoning", text }],
		toolCalls: [],
		children: [],
	};
}

/**
 * Checkpoint projection: a real persisted message whose live revision is being
 * projected back into the document while the same block ID continues streaming.
 * Must take the same incremental parse path as the synthetic streaming row.
 */
function checkpointProjectionMessage(text: string) {
	return {
		id: "msg-checkpoint-1",
		seq: 100,
		role: "assistant",
		contentJson: [{ type: "reasoning", id: "r-1", revision: 2, text }],
		toolCalls: [],
		children: [],
		liveBlockIndex: 0,
		liveContentProjection: true,
	};
}

const HISTORY = Array.from({ length: 12 }, (_, i) => finishedTool(i));

/**
 * The growth unit: prose appended to the CURRENT reasoning step.
 *
 * Deliberately not a new `**title**` per chunk. Cost was measured against both axes
 * separately, and they are different problems:
 *
 *  - vs TEXT SIZE at a realistic step count (40 steps): 6k → 500k chars costs
 *    0.069 → 0.099ms per frame. Flat. That is the axis this fold introduced (the live
 *    row is re-adapted per delta) and the axis this test guards.
 *  - vs ROW COUNT at fixed text: 10 → 2400 rows costs 0.27 → 1.26ms per frame,
 *    because `traceRevision` keys every row and the adapter materialises every row.
 *    That is PRE-EXISTING and unrelated to streaming: a fold of 2000 finished TOOL
 *    calls, with no live content at all, costs 4.0ms/frame warm on the same machine.
 *
 * A fixture that emitted a title every ~84 chars conflated the two and made the flat
 * text axis look like a 6.4x regression, because it was really growing rows.
 */
const GROWTH = "这一段说明了折叠后的渲染行为与图标位置的稳定性。";
/** A titled step, used to build the fixed step scaffold the body grows inside. */
const STEP = `**分析步骤**\n\n${GROWTH.repeat(3)}\n\n`;

describe("low-LOD live turn: per-frame cost stays flat as the reply grows", () => {
	it("does not scale with the ACCUMULATED streaming text", async () => {
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { measureCache } = await import("./measure-cache");
		const { getCategory, getCategoryColor } = await import("../tool-call/tool-display");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		/** One live frame through the REAL document layout (the shell's entry point). */
		const renderFrame = (text: string) => {
			const messages = [...HISTORY, streamingMessage(text)] as never[];
			return buildPretextDocumentLayout(messages, {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 2,
				widthBucket: 800,
				contentWidth: 800,
				viewportHeight: 900,
				resolveToolCategory: getCategory,
				resolveToolColor: (name: string, input: unknown) =>
					getCategoryColor(getCategory(name, input)),
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			});
		};

		/**
		 * Median frame cost while a FIXED number of steps grows to `chars` of prose.
		 *
		 * The step count is held constant on purpose so this measures the text axis
		 * alone (see GROWTH). `charCodeAt(0)` is load-bearing: `text += …` builds a ROPE,
		 * and the first character access inside the pipeline forces an O(len) flatten.
		 * Timing that flatten attributes V8's string representation to our code — it
		 * reported ~0.21ms at 200k chars scaling 28x for an implementation that is in
		 * fact flat. The flatten is real but is not the fold's cost: the streaming
		 * accumulator concatenates onto the same string, so it is paid once per frame no
		 * matter how the reasoning is parsed.
		 */
		const medianFrameCost = (chars: number) => {
			// 40 titled steps — a realistic long reasoning turn.
			const scaffold = STEP.repeat(40);
			let text = scaffold + GROWTH.repeat(Math.ceil(chars / GROWTH.length));
			text.charCodeAt(0);
			renderFrame(text);
			const samples: number[] = [];
			for (let i = 0; i < 25; i++) {
				text += GROWTH;
				text.charCodeAt(0);
				const started = performance.now();
				renderFrame(text);
				samples.push(performance.now() - started);
			}
			samples.sort((left, right) => left - right);
			return samples[Math.floor(samples.length / 2)] ?? 0;
		};

		measureCache.clear();
		medianFrameCost(2_000); // warm the module / JIT paths

		const early = medianFrameCost(5_000);
		const late = medianFrameCost(400_000);

		// 80x the accumulated text at an unchanged row count. Re-parsing the body every
		// frame (the state this change first introduced) measured 0.365ms → 3.573ms
		// across a comparable range; with the incremental titles-only parser the frame
		// measured 0.196ms → 0.149ms, i.e. flat.
		expect(late).toBeLessThan(Math.max(early, 0.05) * 3);
	});

	it("checkpoint projection takes the same incremental path as synthetic streaming", async () => {
		const { parseStreamingReasoningTitles, resetStreamingReasoningCache } = await import(
			"@shared/pretext-layout/reasoning-segments-cache"
		);
		const { segmentMessages } = await import("../message/message-segments");
		const { groupRenderUnits } = await import("../trace/render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");

		// Count full parses by spying on the resolver the adapter falls through to
		// when it does NOT recognise a streaming item.
		let fullParses = 0;
		const ctx = {
			lod: 2 as const,
			resolveReasoningSegments: (text: string) => {
				fullParses++;
				return [{ title: null, body: text, isEmpty: false }];
			},
		};

		const scaffold = STEP.repeat(20);
		const longText = scaffold + GROWTH.repeat(200);
		longText.charCodeAt(0);

		// Warm the incremental cache under a key the adapter will derive.
		resetStreamingReasoningCache("checkpoint-proj");
		parseStreamingReasoningTitles("checkpoint-proj", longText);

		// Drive the REAL adapter path with a checkpoint projection message.
		const messages = [...HISTORY, checkpointProjectionMessage(longText)] as never[];
		const units = groupRenderUnits(segmentMessages(messages), true);
		adaptRenderUnits(units as never, ctx);

		// The checkpoint projection must NOT fall through to the full parser.
		// `isStreamingReasoningItem` now recognises `liveContentProjection`, so the
		// adapter uses `parseStreamingReasoningTitles` (incremental) instead of
		// `resolveReasoningSegments` (full re-parse every frame).
		expect(fullParses).toBe(0);
	});

	it("holds the LIVE reasoning parse flat on a single-title body", async () => {
		// The shape that defeated the first two attempts, isolated from the rest of the
		// frame so a regression points straight at the parser.
		//
		// A body with ONE `**title**` never closes its step, so the naive incremental
		// design still rebuilt a string the size of the whole reply per delta (97.8% of
		// a 0.489ms frame at 400k chars, by inline attribution). Emitting only the
		// first body LINE — all a folded row can show — makes it O(1).
		const { parseStreamingReasoningTitles, resetStreamingReasoningCache } = await import(
			"@shared/pretext-layout/reasoning-segments-cache"
		);

		const cost = (chars: number) => {
			const key = `single-${chars}`;
			resetStreamingReasoningCache(key);
			let text = `**分析步骤**\n\n${GROWTH.repeat(Math.ceil(chars / GROWTH.length))}`;
			text.charCodeAt(0);
			parseStreamingReasoningTitles(key, text);
			const samples: number[] = [];
			for (let i = 0; i < 40; i++) {
				// Blank line every 4th append, like real reasoning prose.
				text += i % 4 === 3 ? `${GROWTH}\n\n` : GROWTH;
				text.charCodeAt(0);
				const started = performance.now();
				parseStreamingReasoningTitles(key, text);
				samples.push(performance.now() - started);
			}
			samples.sort((left, right) => left - right);
			return samples[Math.floor(samples.length / 2)] ?? 0;
		};

		cost(2_000); // warm
		const early = cost(5_000);
		const late = cost(400_000);
		// Measured 0.0071ms → 0.0031ms across this range (it gets CHEAPER, since the
		// first line settles early and later paragraphs are skipped outright).
		expect(late).toBeLessThan(Math.max(early, 0.005) * 3);
	});

	it("keeps the measurement cache bounded across a long turn", async () => {
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { measureCache } = await import("./measure-cache");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		const renderFrame = (text: string) =>
			buildPretextDocumentLayout([...HISTORY, streamingMessage(text)] as never[], {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 2,
				widthBucket: 800,
				contentWidth: 800,
				viewportHeight: 900,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			});

		measureCache.clear();
		measureCache.resetStats();
		// A realistic turn: 25 titled steps, each typed out character by character (that
		// is what makes the row TITLE change and therefore re-key the trace).
		let text = "";
		let frames = 0;
		for (let step = 0; step < 25; step++) {
			const title = `**第 ${step} 步：分析折叠后的渲染行为**`;
			for (let c = 1; c <= title.length; c++) {
				renderFrame(`${text}${title.slice(0, c)}`);
				frames++;
			}
			text += `${title}\n\n`;
		}

		// The trace re-keys only when its measured content changes, so entries are
		// proportional to STEPS, not to frames. A per-frame entry (or a per-delta one)
		// would push a long session toward the cache's bulk-clear ceiling, which
		// re-measures the whole window in one frame — a visible hitch.
		expect(measureCache.size).toBeLessThan(frames / 4);
		// Most frames must be served from cache for the fold to be affordable at all.
		expect(measureCache.hits).toBeGreaterThan(measureCache.misses * 3);
	});

	it("keeps the folded rows correct while the live row grows", async () => {
		const { segmentMessages } = await import("../message/message-segments");
		const { groupRenderUnits } = await import("../trace/render-units");
		const { adaptRenderUnits } = await import("./segment-adapter");

		// A cost optimisation must never drop or reorder rows: the whole point of the
		// fold is that the live row sits in its final position from the first frame.
		const rowsAt = (text: string) => {
			const messages = [...HISTORY, streamingMessage(text)] as never[];
			const units = groupRenderUnits(segmentMessages(messages), true);
			const specs = adaptRenderUnits(units as never, { lod: 2 });
			const data = specs[0]?.data as { items: { key: string }[] };
			return data.items.map((item) => item.key);
		};

		const short = rowsAt(STEP);
		const long = rowsAt(STEP.repeat(400));
		// 12 folded tools first, in source order, at both sizes.
		expect(short.slice(0, 12)).toEqual(HISTORY.map((_, i) => `tool-tu-${i}`));
		expect(long.slice(0, 12)).toEqual(short.slice(0, 12));
		// Then the live reasoning rows, keyed by their run ordinal (hand-off stable).
		expect(short[12]).toBe("r-run0-0-step-0");
		expect(long[12]).toBe(short[12]);
		// A longer body yields MORE steps, never a different prefix.
		expect(long.length).toBeGreaterThan(short.length);
	});
});
