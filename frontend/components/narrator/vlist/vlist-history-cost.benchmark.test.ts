/**
 * Fixed live tail, growing loaded history: benchmark the real document builder.
 *
 * Run: VLIST_HISTORY_BENCH=1 bun test --isolate ./frontend/components/narrator/vlist/vlist-history-cost.benchmark.test.ts
 *
 * The small attribution/parity check always runs. Timing is opt-in, never a CI
 * millisecond assertion. Baseline totals have NO spies; stage totals are a separate
 * pass. Canvas widths are deterministic: this measures JS construction, not real
 * font shaping, React reconciliation, browser layout or paint.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import type { RenderLod } from "./prepared-block";
import type {
	BuildPretextDocumentLayoutOptions,
	BuiltPretextDocumentLayout,
} from "./pretext-document-layout";

const WIDTH = 800;
const VIEWPORT_HEIGHT = 900;
const HISTORY_SIZES = [50, 200, 800, 1200] as const;
const LODS = [2, 5] as const;
const FIXTURES = ["shared", "distinct"] as const;
type HistoryFixture = (typeof FIXTURES)[number];
const WARMUP_FRAMES = 20;
const SAMPLE_FRAMES = 75;
const DELTA = "继续检查这一处实现，保持其他条件不变。";
const TAIL = `**分析步骤**\n\n${"固定的尾部推理正文。".repeat(300)}`;
const PROSE = [
	"## 实现说明",
	"这是一段已经完成、后续流式更新不应重新处理的历史正文。".repeat(16),
	"- 保持原有接口\n- 验证滚动锚点\n- 记录测量结果",
	"```ts\nconst unchanged = true;\nconsole.log(unchanged);\n```",
].join("\n\n");

/** Five messages per completed turn, with fixed payload sizes and ID lengths. */
function historyMessages(count: number, fixture: HistoryFixture = "shared"): NarratorMsg[] {
	return Array.from({ length: count }, (_, index): NarratorMsg => {
		const serial = String(index).padStart(6, "0");
		const id = `history-${serial}`;
		// Unchanged across frames, but unique across messages in the distinct fixture.
		// Construction and any rope flattening happen before the timed frame loop.
		const marker = fixture === "distinct" ? `[${id}]\n` : "";
		const base = {
			id,
			seq: index + 1,
			narratorId: "history-bench",
			parentToolUseId: null,
			contentText: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			children: [],
		};
		switch (index % 5) {
			case 0: {
				const text = marker + "请检查实现并运行相关测试。".repeat(4);
				text.charCodeAt(0);
				return {
					...base,
					role: "user",
					contentJson: [{ type: "text", text }],
					toolCalls: [],
				};
			}
			case 1: {
				const text = `**检查实现**\n\n${marker}${"检查既有数据流和约束。".repeat(20)}\n\n**验证结果**\n\n确认未变化的历史保持稳定。`;
				text.charCodeAt(0);
				return {
					...base,
					role: "assistant",
					contentJson: [{ type: "reasoning", text }],
					toolCalls: [],
				};
			}
			case 2:
			case 3: {
				const toolUseId = `tool-${serial}`;
				const name = index % 5 === 2 ? "Read" : "Bash";
				const file = fixture === "distinct" ? `file-${serial}` : "unchanged";
				const input =
					name === "Read"
						? { file_path: `src/${file}.ts`, offset: 1, limit: 80 }
						: { command: `bun test --isolate src/${file}.test.ts` };
				const content = marker + "已完成的工具输出。".repeat(20);
				content.charCodeAt(0);
				return {
					...base,
					role: "assistant",
					contentJson: [{ type: "tool_use", id: toolUseId, name, input }],
					toolCalls: [
						{
							id: `call-${serial}`,
							toolUseId,
							toolName: name,
							status: "success",
							inputJson: input,
							outputJson: { content },
						},
					],
				};
			}
			default: {
				const text = marker + PROSE;
				text.charCodeAt(0);
				return {
					...base,
					role: "assistant",
					contentJson: [{ type: "text", text }],
					toolCalls: [],
				};
			}
		}
	});
}

/** Construct/flatten strings outside timing; every case receives the same deltas. */
function streamingFrames(historyCount: number): NarratorMsg[] {
	return Array.from({ length: WARMUP_FRAMES + SAMPLE_FRAMES }, (_, index): NarratorMsg => {
		const text = TAIL + DELTA.repeat(index + 1);
		text.charCodeAt(0);
		return {
			id: "__streaming__",
			seq: historyCount + 1,
			narratorId: "history-bench",
			parentToolUseId: null,
			contentText: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			role: "assistant",
			contentJson: [{ type: "reasoning", text }],
			toolCalls: [],
			children: [],
		};
	});
}

type Phase = "segment" | "group" | "adapt" | "compute" | "manifest" | "engine";
const PHASES: Phase[] = ["segment", "group", "adapt", "compute", "manifest", "engine"];
function emptyTimes(): Record<Phase, number> {
	return { segment: 0, group: 0, adapt: 0, compute: 0, manifest: 0, engine: 0 };
}

async function modules() {
	const [document, segments, groups, adapter, pipeline, manifest, engine, cache, tools, recent] =
		await Promise.all([
			import("./pretext-document-layout"),
			import("../message/message-segments"),
			import("../trace/render-units"),
			import("@shared/pretext-layout/segment-adapter"),
			import("./vlist-pipeline"),
			import("./pretext-layout-manifest"),
			import("@shared/pretext-layout/engine"),
			import("./measure-cache"),
			import("../tool-call/tool-display"),
			import("../trace/run-segments"),
		]);
	return { document, segments, groups, adapter, pipeline, manifest, engine, cache, tools, recent };
}

type Modules = Awaited<ReturnType<typeof modules>>;
function buildOptions(mod: Modules, lod: RenderLod): BuildPretextDocumentLayoutOptions {
	return {
		layoutRevision: "history-bench-layout",
		documentRevision: "history-bench-document",
		lod,
		widthBucket: WIDTH,
		contentWidth: WIDTH,
		viewportHeight: VIEWPORT_HEIGHT,
		gap: 4,
		segmentGap: 10,
		topPadding: 12,
		bottomPadding: 12,
		resolveToolCategory: mod.tools.getCategory,
		resolveToolColor: (name, input) =>
			mod.tools.getCategoryColor(mod.tools.getCategory(name, input)),
		resolveRecentMessageIds: (messages) => mod.recent.recentRunSegmentMessageIds([...messages], 2),
	};
}

/** Only module boundaries are wrapped, never a per-item measure/cache operation. */
function installAttribution(mod: Modules) {
	let times = emptyTimes();
	let calls = emptyTimes();
	function timed<T>(phase: Phase, fn: () => T): T {
		const start = performance.now();
		try {
			return fn();
		} finally {
			times[phase] += performance.now() - start;
			calls[phase]++;
		}
	}
	const segment = mod.segments.segmentMessages;
	const group = mod.groups.groupRenderUnits;
	const adapt = mod.adapter.adaptRenderUnits;
	const compute = mod.pipeline.computeVListLayout;
	const manifest = mod.manifest.buildPretextLayoutManifest;
	const engine = mod.engine.buildPretextEngineLayout;
	const spies = [
		spyOn(mod.segments, "segmentMessages").mockImplementation((...args) =>
			timed("segment", () => segment(...args)),
		),
		spyOn(mod.groups, "groupRenderUnits").mockImplementation((...args) =>
			timed("group", () => group(...args)),
		),
		spyOn(mod.adapter, "adaptRenderUnits").mockImplementation((...args) =>
			timed("adapt", () => adapt(...args)),
		),
		spyOn(mod.pipeline, "computeVListLayout").mockImplementation((...args) =>
			timed("compute", () => compute(...args)),
		),
		spyOn(mod.manifest, "buildPretextLayoutManifest").mockImplementation((...args) =>
			timed("manifest", () => manifest(...args)),
		),
		spyOn(mod.engine, "buildPretextEngineLayout").mockImplementation((...args) =>
			timed("engine", () => engine(...args)),
		),
	];
	return {
		reset() {
			times = emptyTimes();
			calls = emptyTimes();
			// Release captured arguments/results outside timing, not 75 whole documents
			// retained by spy bookkeeping until the end of a benchmark case.
			for (const spy of spies) spy.mockClear();
		},
		read: () => ({ times: { ...times }, calls: { ...calls } }),
		restore() {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

function exclusiveTimes(total: number, inclusive: Record<Phase, number>) {
	return {
		segment: inclusive.segment,
		group: inclusive.group,
		adapt: inclusive.adapt,
		// Cache-key construction, lookup/actual measuring, item arrays + initial geometry.
		measureAndGeometry: inclusive.compute - inclusive.adapt,
		// Source attribution, key deduplication, source arrays and consistency validation.
		manifestAndSources: inclusive.manifest - inclusive.compute - inclusive.engine,
		engineAndIndex: inclusive.engine,
		// Pin/recency scans, source-resolver construction, morph labels + wrapper overhead.
		documentOther: total - inclusive.segment - inclusive.group - inclusive.manifest,
	};
}

function layoutSnapshot(layout: BuiltPretextDocumentLayout) {
	return {
		manifest: layout.manifest,
		itemStarts: layout.index.itemStarts,
		itemEnds: layout.index.itemEnds,
		totalHeight: layout.index.totalHeight,
	};
}

function summary(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		median: sorted[Math.floor(sorted.length / 2)] ?? 0,
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
		mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
	};
}

/** A separate bulk probe: no per-item timers, and timings are NOT additive stages. */
async function warmCacheProbe(mod: Modules, fixture: HistoryFixture) {
	const { measureElementCached } = await import("./registry");
	const options = buildOptions(mod, 5);
	const tail = streamingFrames(1200).at(-1);
	if (!tail) throw new Error("missing cache-probe tail");
	mod.cache.measureCache.clear();
	const built = mod.document.buildPretextDocumentLayout(
		[...historyMessages(1200, fixture), tail],
		options,
	);
	const items = built.items.filter(
		({ spec }) => !mod.cache.isStreamingKey(spec.key) && spec.opts?.streamingContent !== true,
	);
	expect(items.length).toBe(1200);
	const scan = () => {
		let checksum = 0;
		for (const { spec } of items) {
			checksum += measureElementCached(
				spec.kind,
				spec.data,
				WIDTH,
				5,
				spec.opts,
				spec.key,
				options.documentRevision,
			).height;
		}
		return checksum;
	};
	// Capture EXACT production cache keys once, outside ALL timing. Restoring
	// here leaves both timed scans free of spies and their retained arguments.
	const keys: string[] = [];
	const get = mod.cache.measureCache.get.bind(mod.cache.measureCache);
	const capture = spyOn(mod.cache.measureCache, "get").mockImplementation((key) => {
		keys.push(key);
		return get(key);
	});
	try {
		scan();
	} finally {
		capture.mockRestore();
	}
	expect(keys.length).toBe(items.length);
	function batch(run: () => number) {
		for (let frame = 0; frame < WARMUP_FRAMES; frame++) run();
		mod.cache.measureCache.resetStats();
		const samples: number[] = [];
		let checksum = 0;
		for (let frame = 0; frame < SAMPLE_FRAMES; frame++) {
			const start = performance.now();
			checksum += run();
			samples.push(performance.now() - start);
		}
		return {
			ms: summary(samples),
			checksum,
			hitsPerScan: mod.cache.measureCache.hits / SAMPLE_FRAMES,
			missesPerScan: mod.cache.measureCache.misses / SAMPLE_FRAMES,
		};
	}
	try {
		const cachedScan = batch(scan);
		const revisionsOnly = batch(() => {
			let checksum = 0;
			for (const { spec } of items)
				checksum += mod.cache.extractDataRevision(spec.data)?.length ?? 0;
			return checksum;
		});
		// Precomputed/prehashed keys: this is a lookup lower bound, NOT a proposed
		// replacement for revision/option validation, nor an additive decomposition.
		const precomputedKeyLookup = batch(() => {
			let checksum = 0;
			for (const key of keys) checksum += mod.cache.measureCache.get(key)?.height ?? 0;
			return checksum;
		});
		expect(cachedScan.hitsPerScan).toBe(items.length);
		expect(cachedScan.missesPerScan).toBe(0);
		expect(precomputedKeyLookup.checksum).toBe(cachedScan.checksum);
		return {
			fixture,
			lod: 5,
			itemCount: items.length,
			cachedScan,
			revisionsOnly,
			precomputedKeyLookup,
		};
	} finally {
		mod.cache.measureCache.clear();
	}
}

let disposeCanvas: (() => void) | undefined;
beforeAll(() => {
	disposeCanvas = installCanvasStub();
});
afterAll(() => disposeCanvas?.());

describe("vlist loaded-history cost", () => {
	it.skipIf(process.env.VLIST_HISTORY_BENCH !== "1")(
		"reports warm baseline and separately attributed stages (no timing assertions)",
		async () => {
			const mod = await modules();
			const cases = FIXTURES.flatMap((fixture) =>
				LODS.flatMap((lod) =>
					HISTORY_SIZES.map((historyCount) => ({ fixture, lod, historyCount })),
				),
			);
			const results: Record<string, unknown>[] = [];
			// Run every uninstrumented baseline FIRST. Even restored export spies can
			// change JIT optimisation; they must not influence our baseline totals.
			const baseline = new Map<string, ReturnType<typeof summary>>();
			const baselineLayouts = new Map<string, ReturnType<typeof layoutSnapshot>>();
			for (const { fixture, lod, historyCount } of cases) {
				mod.cache.measureCache.clear();
				const history = historyMessages(historyCount, fixture);
				const frames = streamingFrames(historyCount).map((tail) => [...history, tail]);
				const options = buildOptions(mod, lod);
				const totals: number[] = [];
				let last: BuiltPretextDocumentLayout | undefined;
				for (const [frame, messages] of frames.entries()) {
					const start = performance.now();
					last = mod.document.buildPretextDocumentLayout(messages, options);
					const elapsed = performance.now() - start;
					if (frame >= WARMUP_FRAMES) totals.push(elapsed);
				}
				if (!last) throw new Error("missing baseline layout");
				baseline.set(`${fixture}:${lod}:${historyCount}`, summary(totals));
				baselineLayouts.set(`${fixture}:${lod}:${historyCount}`, layoutSnapshot(last));
			}
			const attribution = installAttribution(mod);
			try {
				for (const { fixture, lod, historyCount } of cases) {
					mod.cache.measureCache.clear();
					const history = historyMessages(historyCount, fixture);
					const frames = streamingFrames(historyCount).map((tail) => [...history, tail]);
					const options = buildOptions(mod, lod);
					const totals: number[] = [];
					const phases: ReturnType<typeof exclusiveTimes>[] = [];
					let last: BuiltPretextDocumentLayout | undefined;
					for (const [frame, messages] of frames.entries()) {
						attribution.reset();
						if (frame === WARMUP_FRAMES) mod.cache.measureCache.resetStats();
						const start = performance.now();
						last = mod.document.buildPretextDocumentLayout(messages, options);
						const elapsed = performance.now() - start;
						const { times, calls } = attribution.read();
						if (frame < WARMUP_FRAMES) continue;
						for (const phase of PHASES) expect(calls[phase]).toBeGreaterThan(0);
						totals.push(elapsed);
						phases.push(exclusiveTimes(elapsed, times));
					}
					const firstSample = phases[0];
					if (!last || !firstSample) throw new Error("missing attributed samples");
					const expected = baselineLayouts.get(`${fixture}:${lod}:${historyCount}`);
					if (!expected) throw new Error("missing baseline snapshot");
					expect(layoutSnapshot(last)).toEqual(expected);
					const stageNames = Object.keys(firstSample) as (keyof ReturnType<
						typeof exclusiveTimes
					>)[];
					const stageStats = Object.fromEntries(
						stageNames.map((phase) => [phase, summary(phases.map((sample) => sample[phase]))]),
					);
					results.push({
						fixture,
						lod,
						historyCount,
						itemCount: last?.items.length,
						baselineMs: baseline.get(`${fixture}:${lod}:${historyCount}`),
						profiledMs: summary(totals),
						stagesMs: stageStats,
						cacheHitsPerFrame: mod.cache.measureCache.hits / SAMPLE_FRAMES,
						cacheMissesPerFrame: mod.cache.measureCache.misses / SAMPLE_FRAMES,
						textSignatureEntries: mod.cache.measureCache.textSignatureEntries,
						retainedTextSignatureChars: mod.cache.measureCache.retainedTextSignatureChars,
					});
				}
			} finally {
				attribution.restore();
				mod.cache.measureCache.clear();
			}
			const cacheProbes = [];
			for (const fixture of FIXTURES) cacheProbes.push(await warmCacheProbe(mod, fixture));
			console.log(
				"VLIST_HISTORY_BENCH_RESULT",
				JSON.stringify({
					bun: Bun.version,
					platform: process.platform,
					arch: process.arch,
					width: WIDTH,
					viewportHeight: VIEWPORT_HEIGHT,
					warmupFrames: WARMUP_FRAMES,
					sampleFrames: SAMPLE_FRAMES,
					tailBaseChars: TAIL.length,
					deltaChars: DELTA.length,
					results,
					cacheProbes,
				}),
			);
		},
		120_000,
	);
	it("attributes the real call graph without changing the layout", async () => {
		const mod = await modules();
		const tail = streamingFrames(10)[0];
		if (!tail) throw new Error("missing benchmark tail");
		const cases = FIXTURES.flatMap((fixture) => LODS.map((lod) => ({ fixture, lod })));
		for (const { fixture, lod } of cases) {
			const messages = [...historyMessages(10, fixture), tail];
			const options = buildOptions(mod, lod);
			mod.cache.measureCache.clear();
			const expected = mod.document.buildPretextDocumentLayout(messages, options);
			const attribution = installAttribution(mod);
			try {
				const start = performance.now();
				const actual = mod.document.buildPretextDocumentLayout(messages, options);
				const total = performance.now() - start;
				const { times, calls } = attribution.read();
				expect(actual.manifest).toEqual(expected.manifest);
				expect(layoutSnapshot(actual)).toEqual(layoutSnapshot(expected));
				for (const item of expected.manifest.items) {
					expect(actual.index.itemByKey(item.itemKey)).toEqual(
						expected.index.itemByKey(item.itemKey),
					);
					for (const id of item.sourceMessageIds) {
						expect(actual.index.itemIndicesForSourceMessageId(id)).toEqual(
							expected.index.itemIndicesForSourceMessageId(id),
						);
					}
				}
				expect(actual.items).toEqual(expected.items);
				expect(calls).toEqual({
					segment: 1,
					group: 2,
					adapt: 1,
					compute: 1,
					manifest: 1,
					engine: 1,
				});
				for (const value of Object.values(exclusiveTimes(total, times))) {
					expect(value).toBeGreaterThanOrEqual(0);
				}
			} finally {
				attribution.restore();
				mod.cache.measureCache.clear();
			}
		}
	});
});
