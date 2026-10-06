import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTraceEvents } from "../gc-trace-stream";
import { analyzeGcTrace, failedGcSummary, type GcTraceOptions } from "../gc-trace-summary";
import { MemoryProfileError, PROFILE_LIMITS } from "../memory-profile-constants";

const startMarker = "nf-start-PRIVATE-MARKER";
const endMarker = "nf-end-PRIVATE-MARKER";
function markers(end = 11_000) {
	return [
		{ name: startMarker, ph: "I", pid: 1, tid: 2, ts: 1000 },
		{ name: endMarker, ph: "I", pid: 1, tid: 2, ts: end },
		{
			name: "thread_name",
			ph: "M",
			pid: 1,
			tid: 2,
			args: { name: "CrRendererMain", url: "PRIVATE-URL" },
		},
	];
}
function gc(ts: number, dur: number, name = "MinorGC", extra = {}) {
	return { name, ph: "X", pid: 1, tid: 2, ts, dur, ...extra };
}
async function withTrace(
	value: unknown,
	run: (opts: GcTraceOptions, dir: string) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "nf-gc-analysis-"));
	const inputPath = join(dir, "private-raw.json");
	try {
		await writeFile(inputPath, typeof value === "string" ? value : JSON.stringify(value));
		await run(
			{
				inputPath,
				outputPath: join(dir, "gc.trace.json"),
				startMarker,
				endMarker,
				dataLossOccurred: false,
				bufferLimited: false,
				signal: new AbortController().signal,
			},
			dir,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
async function genericFailure(opts: GcTraceOptions, stage: string) {
	try {
		await analyzeGcTrace(opts);
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(MemoryProfileError);
		expect((error as MemoryProfileError).stage).toBe(stage);
		expect(String(error)).not.toContain("PRIVATE");
		expect(String(error)).not.toContain(opts.inputPath);
	}
}

describe("target-scoped GC trace analysis", () => {
	test("microseconds, clipping, duplicate/nested counts, overlap union, heap endpoints and privacy", async () => {
		const parent = gc(500, 4500, "MinorGC", {
			args: {
				data: {
					usedHeapSizeBefore: 1000,
					usedHeapSizeAfter: 400,
					url: "https://other-page.test/PRIVATE-URL",
					content: "PRIVATE-BODY",
				},
			},
		});
		await withTrace(
			{
				traceEvents: [
					gc(7000, 7000, "MajorGC"),
					parent,
					gc(1500, 500),
					{ ...parent },
					gc(4000, 3000, "MajorGC"),
					gc(2000, 99_000, "MajorGC", { pid: 99, args: { url: "PRIVATE-OTHER-PAGE" } }),
					{
						name: "EvaluateScript",
						ph: "X",
						pid: 1,
						tid: 2,
						ts: 3000,
						dur: 100,
						args: { code: "PRIVATE-CODE" },
					},
					...markers(),
				],
				metadata: { otherUrl: "PRIVATE-GLOBAL" },
			},
			async (opts) => {
				const result = await analyzeGcTrace(opts);
				expect(result).toMatchObject({
					status: "ok",
					durationMs: 10,
					minorCount: 1,
					majorCount: 2,
					observedCount: 3,
					nestedCount: 1,
					duplicateCount: 1,
					gcWallTimeMs: 10,
					gcWallTimeRatio: 1,
					frequencyPerSecond: 300,
					longestMs: 4,
					p50Ms: 4,
					p95Ms: 4,
				});
				expect(result.topEvents[0]).toMatchObject({ heapBeforeBytes: 1000, heapAfterBytes: 400 });
				expect(result.intervalMs).toMatchObject({ mean: 3, min: 3, max: 3 });
				const text = await readFile(opts.outputPath, "utf8");
				expect(text).not.toContain("PRIVATE");
				expect(text).not.toContain("https:");
				expect(text).not.toContain("EvaluateScript");
				const output = JSON.parse(text);
				expect(output.traceEvents).toHaveLength(5);
				expect(output.metadata).toEqual({ recordingWindow: { startTs: 1000, endTs: 11000 } });
				expect(output.traceEvents[0]).toEqual({
					name: "thread_name",
					ph: "M",
					pid: 1,
					tid: 2,
					args: { name: "CrRendererMain" },
				});
				expect((await stat(opts.outputPath)).mode & 0o777).toBe(0o600);
				expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12 * 1024);
			},
		);
	});

	test("out-of-order B/E pairing and unnamed nested non-GC E do not close GC early", async () => {
		await withTrace(
			{
				traceEvents: [
					{ name: "MinorGC", ph: "E", pid: 1, tid: 2, ts: 5000, args: { usedHeapSizeAfter: 20 } },
					{ ph: "E", pid: 1, tid: 2, ts: 4000 },
					{ name: "PRIVATE-INNER", ph: "B", pid: 1, tid: 2, ts: 3000 },
					{ name: "MinorGC", ph: "B", pid: 1, tid: 2, ts: 2000, args: { usedHeapSizeBefore: 100 } },
					...markers(),
				],
			},
			async (opts) => {
				const result = await analyzeGcTrace(opts);
				expect(result).toMatchObject({ status: "ok", observedCount: 1, gcWallTimeMs: 3 });
				expect(result.topEvents[0]).toMatchObject({ heapBeforeBytes: 100, heapAfterBytes: 20 });
				expect(await readFile(opts.outputPath, "utf8")).not.toContain("PRIVATE");
			},
		);
	});

	test("X and paired B/E representing the same span are counted once", async () => {
		await withTrace(
			{
				traceEvents: [
					...markers(),
					gc(2000, 3000),
					{ name: "MinorGC", ph: "B", pid: 1, tid: 2, ts: 2000 },
					{ ph: "E", pid: 1, tid: 2, ts: 5000 },
				],
			},
			async (opts) => {
				expect(await analyzeGcTrace(opts)).toMatchObject({
					observedCount: 1,
					duplicateCount: 1,
					gcWallTimeMs: 3,
				});
			},
		);
	});

	test("nearest-rank p50/p95, longest top10, frequency and start-to-start intervals", async () => {
		const events = Array.from({ length: 20 }, (_, i) => gc(2000 + i * 30_000, (i + 1) * 1000));
		await withTrace({ traceEvents: [...events.reverse(), ...markers(1_001_000)] }, async (opts) => {
			const result = await analyzeGcTrace(opts);
			expect(result).toMatchObject({
				observedCount: 20,
				gcWallTimeMs: 210,
				durationMs: 1000,
				p50Ms: 10,
				p95Ms: 19,
				longestMs: 20,
				frequencyPerSecond: 20,
				intervalMs: { mean: 30, min: 30, max: 30, p50: 30, p95: 30 },
			});
			expect(result.topEvents.map((event) => event.durationMs)).toEqual([
				20, 19, 18, 17, 16, 15, 14, 13, 12, 11,
			]);
		});
	});

	test("distinct crossing events clipped to identical spans are not false duplicates or nesting", async () => {
		await withTrace(
			{ traceEvents: [...markers(), gc(0, 20_000), gc(500, 30_000)] },
			async (opts) => {
				expect(await analyzeGcTrace(opts)).toMatchObject({
					observedCount: 2,
					duplicateCount: 0,
					nestedCount: 0,
					gcWallTimeMs: 10,
				});
			},
		);
	});

	test("verified idle means zero observed count; percentile and interval remain unavailable", async () => {
		await withTrace(
			{ traceEvents: [...markers(), gc(500, 100), gc(12_000, 100)] },
			async (opts) => {
				expect(await analyzeGcTrace(opts)).toMatchObject({
					status: "ok",
					observedCount: 0,
					gcWallTimeMs: 0,
					frequencyPerSecond: 0,
					p50Ms: null,
					p95Ms: null,
					longestMs: null,
					intervalMs: null,
				});
			},
		);
	});

	test("missing/ambiguous/mismatched markers or absent/conflicting thread mapping give null stats and no artifact", async () => {
		for (const events of [
			[],
			markers().slice(1),
			markers().slice(0, 2),
			[...markers(), { ...markers()[0], ts: 1200 }],
			[...markers().slice(0, 1), { ...markers()[1], tid: 9 }, markers()[2]],
			[
				...markers(),
				{ name: "thread_name", ph: "M", pid: 1, tid: 2, args: { name: "OtherThread" } },
			],
		]) {
			await withTrace({ traceEvents: [...events, gc(2000, 1000)] }, async (opts, dir) => {
				expect(await analyzeGcTrace(opts)).toMatchObject({
					status: "scope_unavailable",
					durationMs: null,
					observedCount: null,
					gcWallTimeMs: null,
					frequencyPerSecond: null,
				});
				expect(await readdir(dir)).toEqual(["private-raw.json"]);
			});
		}
	});

	test("frame/process metadata is cross-checked when available, without retaining private URLs", async () => {
		const framed = markers().map((event) =>
			event.ph === "I" ? { ...event, args: { frame: "PRIVATE-FRAME" } } : event,
		);
		for (const processId of [1, 99]) {
			await withTrace(
				{
					traceEvents: [
						...framed,
						gc(2000, 1000),
						{
							name: "TracingStartedInBrowser",
							ph: "I",
							args: {
								data: { frames: [{ frame: "PRIVATE-FRAME", processId, url: "PRIVATE-OTHER-URL" }] },
							},
						},
					],
				},
				async (opts, dir) => {
					const result = await analyzeGcTrace(opts);
					expect(result.status).toBe(processId === 1 ? "ok" : "scope_unavailable");
					if (processId === 1)
						expect(await readFile(opts.outputPath, "utf8")).not.toContain("PRIVATE");
					else expect(await readdir(dir)).toEqual(["private-raw.json"]);
				},
			);
		}
	});

	test("data loss, buffer limits, invalid durations, unsupported phases and unpaired B/E mark incomplete", async () => {
		await withTrace(
			{
				traceEvents: [
					...markers(),
					{ name: "MinorGC", ph: "B", pid: 1, tid: 2, ts: 2000 },
					{ name: "MajorGC", ph: "Q", pid: 1, tid: 2, ts: 3000 },
					gc(4000, -1),
					{ name: "V8.GCScavenger", ph: "X", pid: 1, tid: 2, ts: 2000, dur: 3000 },
				],
			},
			async (opts) => {
				const result = await analyzeGcTrace({
					...opts,
					dataLossOccurred: true,
					bufferLimited: true,
				});
				expect(result.status).toBe("incomplete");
				expect(result.observedCount).toBe(0);
				expect(result.warnings.join(" ")).toContain("data loss");
				expect(result.warnings.join(" ")).toContain("buffer");
				expect(result.warnings.join(" ")).toContain("Unpaired");
				expect(result.warnings.join(" ")).toContain("Unsupported");
				expect(result.warnings.join(" ")).toContain("invalid timestamps");
			},
		);
	});

	test("V8 phases without recognized top-level GC cannot masquerade as verified idle", async () => {
		await withTrace(
			{ traceEvents: [...markers(), gc(2000, 3000, "V8.GCNewModel")] },
			async (opts) => {
				const result = await analyzeGcTrace(opts);
				expect(result.status).toBe("incomplete");
				expect(result.warnings.join(" ")).toContain("event model may be unavailable");
			},
		);
	});

	test("UTF8 and JSON strings split across read chunks are decoded as single events", async () => {
		const prefix = '{"traceEvents":[{"name":"';
		const text =
			prefix +
			"x".repeat(65_535 - Buffer.byteLength(prefix)) +
			'🙂中文\\"尾","ph":"X","pid":99,"args":{"body":"PRIVATE-BODY"}},' +
			JSON.stringify(markers()).slice(1, -1) +
			"," +
			JSON.stringify(gc(2000, 1000)) +
			'],"metadata":{"tail":"中文"}}';
		await withTrace(text, async (opts) => {
			const events = [];
			for await (const event of readTraceEvents(opts.inputPath, opts.signal)) events.push(event);
			expect(events[0]?.name).toContain('🙂中文"尾');
			expect(events).toHaveLength(5);
			expect(await analyzeGcTrace(opts)).toMatchObject({ status: "ok", observedCount: 1 });
			expect(await readFile(opts.outputPath, "utf8")).not.toContain("PRIVATE");
		});
	});

	test("strict envelope, malformed/truncated events and escapes fail without reflecting body", async () => {
		for (const text of [
			'{"traceEvents":[{"name":"PRIVATE-BODY"}',
			'{"traceEvents":[{"name":"PRIVATE-BODY"},]}',
			'{"traceEvents":[],"secret":"PRIVATE-BODY"} trailing',
			'{"traceEvents":[false]}',
			'{"traceEvents":[]}[]',
			'{"traceEvents":[],"traceEvents":[]}',
			'{"traceEvents":[],"traceEvents":"PRIVATE"}',
			'{"traceEvents":[{"name":"PRIVATE\\q"}]}',
			'{"traceEvents":[{"n":01,"name":"PRIVATE"}]}',
			'{"notTraceEvents":"PRIVATE"}',
		]) {
			await withTrace(text, async (opts, dir) => {
				await genericFailure(opts, "gc_trace_invalid");
				expect(await readdir(dir)).toEqual(["private-raw.json"]);
			});
		}
	});

	test("single event byte cap (including UTF8) and depth cap prevent unbounded JSON.parse", async () => {
		await withTrace(
			{ traceEvents: [{ name: `PRIVATE${"中".repeat(PROFILE_LIMITS.traceEventBytes / 3)}` }] },
			async (opts) => {
				await genericFailure(opts, "gc_trace_event_bytes_limit");
			},
		);
		let value: unknown = "PRIVATE";
		for (let i = 0; i < PROFILE_LIMITS.traceDepth; i++) value = { nested: value };
		await withTrace({ traceEvents: [{ args: value }] }, async (opts) => {
			await genericFailure(opts, "gc_trace_depth_limit");
		});
	});

	test("200k event boundary accepted; extra event rejected without scanning unlimited tail", async () => {
		await withTrace(
			{ traceEvents: Array.from({ length: PROFILE_LIMITS.traceEvents }, () => ({})) },
			async (opts) => {
				expect((await analyzeGcTrace(opts)).status).toBe("scope_unavailable");
				await writeFile(
					opts.inputPath,
					`{"traceEvents":[${"{},".repeat(PROFILE_LIMITS.traceEvents)}{}]}`,
				);
				await genericFailure(opts, "gc_trace_events_limit");
			},
		);
	});

	test("50k span cap, 64MiB file cap and output cap all fail safely", async () => {
		await withTrace(
			{
				traceEvents: [
					...markers(200_000),
					...Array.from({ length: PROFILE_LIMITS.gcSpans + 1 }, (_, i) => gc(2000 + i, 1)),
				],
			},
			async (opts) => {
				await genericFailure(opts, "gc_spans_limit");
			},
		);
		await withTrace({ traceEvents: [] }, async (opts) => {
			await truncate(opts.inputPath, PROFILE_LIMITS.traceBytes + 1);
			await genericFailure(opts, "gc_trace_bytes_limit");
		});
		await withTrace({ traceEvents: [...markers(), gc(2000, 1000)] }, async (opts, dir) => {
			await genericFailure({ ...opts, maxOutputBytes: 10 }, "gc_output_bytes_limit");
			expect(await readdir(dir)).toEqual(["private-raw.json"]);
		});
	});

	test("output cannot replace private input and invalid output budgets are rejected", async () => {
		await withTrace({ traceEvents: markers() }, async (opts, dir) => {
			await genericFailure({ ...opts, outputPath: opts.inputPath }, "gc_output_path");
			await genericFailure({ ...opts, maxOutputBytes: Number.NaN }, "gc_output_bytes_limit");
			expect(await readdir(dir)).toEqual(["private-raw.json"]);
		});
	});

	test("stream abort between events and invalid UTF8 errors contain no raw body", async () => {
		await withTrace({ traceEvents: markers() }, async (opts) => {
			const controller = new AbortController();
			try {
				for await (const _event of readTraceEvents(opts.inputPath, controller.signal))
					controller.abort(new Error("PRIVATE-TOKEN"));
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(MemoryProfileError);
				expect(String(error)).not.toContain("PRIVATE");
			}
			await writeFile(
				opts.inputPath,
				Buffer.concat([
					Buffer.from('{"traceEvents":[],"secret":"PRIVATE'),
					Buffer.from([0xff]),
					Buffer.from('"}'),
				]),
			);
			await genericFailure(opts, "gc_trace_invalid");
		});
	});

	test("cancellation at the atomic rename boundary deletes the creator's late output", async () => {
		await withTrace({ traceEvents: [...markers(), gc(2000, 1000)] }, async (opts, dir) => {
			// A real AbortSignal with a deterministic checkpoint: cancellation becomes visible
			// only once rename has published the file, without process-wide filesystem mocks.
			Object.defineProperty(opts.signal, "aborted", { get: () => existsSync(opts.outputPath) });
			await genericFailure(opts, "cancelled");
			expect(await readdir(dir)).toEqual(["private-raw.json"]);
		});
	});

	test("aborted input fails without output and error text does not expose abort reason", async () => {
		await withTrace({ traceEvents: markers() }, async (opts, dir) => {
			const controller = new AbortController();
			controller.abort(new Error("PRIVATE-TOKEN"));
			await genericFailure({ ...opts, signal: controller.signal }, "cancelled");
			expect(await readdir(dir)).toEqual(["private-raw.json"]);
		});
	});

	test("failed summary does not pretend that zero GC was observed", () => {
		expect(failedGcSummary()).toMatchObject({
			status: "failed",
			observedCount: null,
			durationMs: null,
			scope: null,
		});
	});
});
