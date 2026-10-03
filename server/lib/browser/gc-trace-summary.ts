import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { readTraceEvents, type TraceEvent } from "./gc-trace-stream";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";

export interface GcSpan {
	name: "MinorGC" | "MajorGC";
	startMs: number;
	durationMs: number;
	heapBeforeBytes: number | null;
	heapAfterBytes: number | null;
}
export interface GcSummary {
	status: "ok" | "incomplete" | "failed" | "scope_unavailable";
	warnings: string[];
	scope: { pid: number; tid: number; threadName: "CrRendererMain" } | null;
	durationMs: number | null;
	minorCount: number | null;
	majorCount: number | null;
	observedCount: number | null;
	nestedCount: number | null;
	duplicateCount: number | null;
	gcWallTimeMs: number | null;
	gcWallTimeRatio: number | null;
	frequencyPerSecond: number | null;
	longestMs: number | null;
	p50Ms: number | null;
	p95Ms: number | null;
	intervalMs: { mean: number; min: number; max: number; p50: number; p95: number } | null;
	topEvents: GcSpan[];
}
export interface GcTraceOptions {
	inputPath: string;
	outputPath: string;
	startMarker: string;
	endMarker: string;
	dataLossOccurred: boolean;
	bufferLimited: boolean;
	signal: AbortSignal;
	maxOutputBytes?: number;
}
const semantics = [
	"Scope is the target's renderer main thread, which may be shared with other pages; iframe/worker/background events are not covered.",
	"Observed MajorGC spans are not complete concurrent collection counts. GC wall-clock span ratio is not CPU usage or measured interaction stalls.",
	"Only MinorGC/MajorGC X or paired B/E events are counted; other V8 phases are not independently attributed. Allocation correlation is not causation.",
];
function empty(status: "failed" | "scope_unavailable", warning: string): GcSummary {
	return {
		status,
		warnings: [warning, ...semantics],
		scope: null,
		durationMs: null,
		minorCount: null,
		majorCount: null,
		observedCount: null,
		nestedCount: null,
		duplicateCount: null,
		gcWallTimeMs: null,
		gcWallTimeRatio: null,
		frequencyPerSecond: null,
		longestMs: null,
		p50Ms: null,
		p95Ms: null,
		intervalMs: null,
		topEvents: [],
	};
}
export function failedGcSummary(): GcSummary {
	return empty("failed", "GC analysis failed; no GC measurements are available.");
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function identity(
	event: TraceEvent,
): event is TraceEvent & { pid: number; tid: number; ts: number } {
	return Number.isSafeInteger(event.pid) && Number.isSafeInteger(event.tid) && finite(event.ts);
}
function heap(event: TraceEvent, key: string): number | null {
	const data = event.args?.data;
	const nested =
		data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
	const value = nested ?? event.args?.[key];
	return finite(value) ? value : null;
}
function markerFrame(event: TraceEvent): string | undefined {
	const data = event.args?.data;
	const nested =
		data && typeof data === "object" ? (data as Record<string, unknown>).frame : undefined;
	const value = event.args?.frame ?? nested;
	return typeof value === "string" ? value : undefined;
}
function rank(sorted: number[], percentile: number): number | null {
	return sorted.length
		? (sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? null)
		: null;
}

/** Two bounded streaming passes: identify marker scope, then analyze only that thread. */
export async function analyzeGcTrace(opts: GcTraceOptions): Promise<GcSummary> {
	let partial: string | undefined;
	try {
		if (opts.inputPath === opts.outputPath) throw new MemoryProfileError("gc_output_path");
		if (
			opts.maxOutputBytes !== undefined &&
			(!finite(opts.maxOutputBytes) || opts.maxOutputBytes === 0)
		)
			throw new MemoryProfileError("gc_output_bytes_limit");
		const warnings = [...semantics];
		let incomplete = false;
		const warn = (text: string) => {
			incomplete = true;
			if (!warnings.includes(text)) warnings.push(text);
		};
		if (opts.dataLossOccurred)
			warn("Trace reports data loss; counts and durations are incomplete.");
		if (opts.bufferLimited)
			warn("Trace buffer reached its recording limit; coverage is incomplete.");
		let start: (TraceEvent & { pid: number; tid: number; ts: number }) | undefined;
		let end: typeof start;
		let ambiguous = opts.startMarker === opts.endMarker || !opts.startMarker || !opts.endMarker;
		for await (const event of readTraceEvents(opts.inputPath, opts.signal)) {
			if (event.name !== opts.startMarker && event.name !== opts.endMarker) continue;
			if (!identity(event) || !["I", "i", "R", "X"].includes(event.ph ?? "")) {
				ambiguous = true;
				continue;
			}
			const previous = event.name === opts.startMarker ? start : end;
			if (
				previous &&
				(previous.ts !== event.ts || previous.pid !== event.pid || previous.tid !== event.tid)
			)
				ambiguous = true;
			if (event.name === opts.startMarker) start = event;
			else end = event;
		}
		if (
			ambiguous ||
			!start ||
			!end ||
			start.pid !== end.pid ||
			start.tid !== end.tid ||
			end.ts <= start.ts ||
			!((end.ts - start.ts) / 1000 > 0) ||
			(markerFrame(start) !== undefined &&
				markerFrame(end) !== undefined &&
				markerFrame(start) !== markerFrame(end))
		) {
			const result = empty(
				"scope_unavailable",
				"A unique, same-thread start/end marker window could not be verified.",
			);
			result.warnings.push(...warnings.filter((text) => !result.warnings.includes(text)));
			return result;
		}
		const startTs = start.ts;
		const endTs = end.ts;
		const pid = start.pid;
		const tid = start.tid;
		let mainThread = false;
		let conflictingThread = false;
		let relatedV8Phases = false;
		let frameConflict = false;
		const frame = markerFrame(start) ?? markerFrame(end);
		const spans: GcSpan[] = [];
		const bounds = new Map<GcSpan, { from: number; to: number }>();
		const phases: TraceEvent[] = [];
		const addSpan = (
			name: GcSpan["name"],
			from: number,
			to: number,
			before: number | null,
			after: number | null,
		) => {
			if (!finite(from) || !finite(to) || to < from) {
				warn("GC events contain invalid timestamps or durations.");
				return;
			}
			if (to < startTs || from > endTs) return;
			const clippedStart = Math.max(from, startTs);
			const clippedEnd = Math.min(to, endTs);
			if (clippedEnd <= clippedStart) return;
			if (spans.length >= PROFILE_LIMITS.gcSpans) throw new MemoryProfileError("gc_spans_limit");
			const span: GcSpan = {
				name,
				startMs: (clippedStart - startTs) / 1000,
				durationMs: (clippedEnd - clippedStart) / 1000,
				heapBeforeBytes: before,
				heapAfterBytes: after,
			};
			spans.push(span);
			bounds.set(span, { from, to });
			if (from < startTs || to > endTs) {
				const text =
					"GC spans were clipped to the marker window; heap endpoints refer to the original event boundaries.";
				if (!warnings.includes(text)) warnings.push(text);
			}
		};
		for await (const event of readTraceEvents(opts.inputPath, opts.signal)) {
			// If Chrome supplies frame/process metadata, cross-check it without retaining URLs.
			if (frame && event.name === "TracingStartedInBrowser") {
				const data = event.args?.data;
				const frames =
					data && typeof data === "object" ? (data as Record<string, unknown>).frames : undefined;
				if (Array.isArray(frames))
					for (const item of frames) {
						if (
							item &&
							typeof item === "object" &&
							item.frame === frame &&
							Number.isSafeInteger(item.processId) &&
							item.processId !== pid
						)
							frameConflict = true;
					}
			}
			if (event.pid !== pid || event.tid !== tid) continue;
			if (event.ph === "M" && event.name === "thread_name") {
				if (event.args?.name === "CrRendererMain") mainThread = true;
				else conflictingThread = true;
				continue;
			}
			const gc = event.name === "MinorGC" || event.name === "MajorGC";
			if (
				typeof event.name === "string" &&
				event.name.startsWith("V8.GC") &&
				finite(event.ts) &&
				event.ts <= endTs &&
				event.ts + (finite(event.dur) ? event.dur : 0) >= startTs
			)
				relatedV8Phases = true;
			// Track non-GC B/E structure too: an unnamed nested E must not close a GC B.
			if (!gc && event.ph !== "B" && event.ph !== "E") continue;
			if (!finite(event.ts)) {
				warn("GC events contain invalid timestamps or durations.");
				continue;
			}
			if (gc && event.ph === "X") {
				if (!finite(event.dur)) warn("GC events contain invalid timestamps or durations.");
				else
					addSpan(
						event.name as GcSpan["name"],
						event.ts,
						event.ts + event.dur,
						heap(event, "usedHeapSizeBefore"),
						heap(event, "usedHeapSizeAfter"),
					);
			} else if (event.ph === "B" || event.ph === "E") {
				if (phases.length >= PROFILE_LIMITS.traceEvents)
					throw new MemoryProfileError("gc_trace_events_limit");
				// Retain only fixed scalar fields, never args with page URL/content.
				phases.push({
					name: gc ? event.name : event.name ? "(other)" : undefined,
					ph: event.ph,
					ts: event.ts,
					args: {
						usedHeapSizeBefore: heap(event, "usedHeapSizeBefore"),
						usedHeapSizeAfter: heap(event, "usedHeapSizeAfter"),
					},
				});
			} else warn("Unsupported MinorGC/MajorGC event phases were observed.");
		}
		if (!mainThread || conflictingThread || frameConflict) {
			const result = empty(
				"scope_unavailable",
				"Marker scope could not be verified as CrRendererMain.",
			);
			result.warnings.push(...warnings.filter((text) => !result.warnings.includes(text)));
			return result;
		}
		phases.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
		const stack: TraceEvent[] = [];
		let duplicateCount = 0;
		for (const event of phases) {
			if (event.ph === "B") stack.push(event);
			else {
				const begin = stack.at(-1);
				if (!begin || (event.name && begin.name !== event.name)) {
					if (event.name !== "(other)") warn("Unpaired GC begin/end events were observed.");
					continue;
				}
				stack.pop();
				if (begin.name === "MinorGC" || begin.name === "MajorGC")
					addSpan(
						begin.name,
						begin.ts ?? 0,
						event.ts ?? 0,
						heap(begin, "usedHeapSizeBefore"),
						heap(event, "usedHeapSizeAfter"),
					);
			}
		}
		if (stack.some((event) => event.name === "MinorGC" || event.name === "MajorGC"))
			warn("Unpaired GC begin/end events were observed.");
		if (relatedV8Phases && !spans.length)
			warn(
				"GC-related V8 phases were observed without supported top-level GC spans; the event model may be unavailable.",
			);
		spans.sort((a, b) => {
			const left = bounds.get(a);
			const right = bounds.get(b);
			return (
				(left?.from ?? 0) - (right?.from ?? 0) ||
				(right?.to ?? 0) - (left?.to ?? 0) ||
				a.name.localeCompare(b.name)
			);
		});
		const unique: GcSpan[] = [];
		const spanKeys = new Map<string, GcSpan>();
		for (const span of spans) {
			const raw = bounds.get(span);
			const key = `${span.name}:${raw?.from}:${raw?.to}`;
			const previous = spanKeys.get(key);
			if (previous) {
				duplicateCount++;
				previous.heapBeforeBytes ??= span.heapBeforeBytes;
				previous.heapAfterBytes ??= span.heapAfterBytes;
				continue;
			}
			spanKeys.set(key, span);
			unique.push(span);
		}
		let nestedCount = 0;
		let maxEnd = -1;
		const top: GcSpan[] = [];
		for (const span of unique) {
			const rawEnd = bounds.get(span)?.to ?? 0;
			if (rawEnd <= maxEnd) nestedCount++;
			else top.push(span);
			maxEnd = Math.max(maxEnd, rawEnd);
		}
		let wall = 0;
		let from = 0;
		let to = 0;
		for (const span of unique) {
			if (span.startMs > to) {
				wall += to - from;
				from = span.startMs;
			}
			to = Math.max(to, span.startMs + span.durationMs);
		}
		wall += to - from;
		const durations = top.map((span) => span.durationMs).sort((a, b) => a - b);
		const intervals = top
			.slice(1)
			.map((span, i) => span.startMs - (top[i]?.startMs ?? 0))
			.sort((a, b) => a - b);
		const durationMs = (endTs - startTs) / 1000;
		const summary: GcSummary = {
			status: incomplete ? "incomplete" : "ok",
			warnings,
			scope: { pid, tid, threadName: "CrRendererMain" },
			durationMs,
			minorCount: top.filter((span) => span.name === "MinorGC").length,
			majorCount: top.filter((span) => span.name === "MajorGC").length,
			observedCount: top.length,
			nestedCount,
			duplicateCount,
			gcWallTimeMs: wall,
			gcWallTimeRatio: wall / durationMs,
			frequencyPerSecond: top.length / (durationMs / 1000),
			longestMs: durations.at(-1) ?? null,
			p50Ms: rank(durations, 0.5),
			p95Ms: rank(durations, 0.95),
			intervalMs: intervals.length
				? {
						mean: intervals.reduce((a, b) => a + b, 0) / intervals.length,
						min: intervals[0] ?? 0,
						max: intervals.at(-1) ?? 0,
						p50: rank(intervals, 0.5) ?? 0,
						p95: rank(intervals, 0.95) ?? 0,
					}
				: null,
			topEvents: [...top].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
		};
		partial = `${opts.outputPath}.${randomUUID()}.partial`;
		const file = await open(partial, "wx", 0o600);
		let outputBytes = 0;
		const write = async (text: string) => {
			if (opts.signal.aborted) throw new MemoryProfileError("cancelled");
			const buffer = Buffer.from(text);
			outputBytes += buffer.length;
			if (
				outputBytes >
				Math.min(opts.maxOutputBytes ?? PROFILE_LIMITS.traceBytes, PROFILE_LIMITS.traceBytes)
			)
				throw new MemoryProfileError("gc_output_bytes_limit");
			let offset = 0;
			while (offset < buffer.length) {
				if (opts.signal.aborted) throw new MemoryProfileError("cancelled");
				const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
				if (!bytesWritten) throw new MemoryProfileError("gc_trace_write");
				offset += bytesWritten;
			}
		};
		try {
			await write(
				JSON.stringify({
					traceEvents: [
						{ name: "thread_name", ph: "M", pid, tid, args: { name: "CrRendererMain" } },
					],
				}).slice(0, -2),
			);
			for (const span of unique) {
				await write(
					`,${JSON.stringify({ name: span.name, ph: "X", pid, tid, ts: startTs + span.startMs * 1000, dur: span.durationMs * 1000, args: { usedHeapSizeBefore: span.heapBeforeBytes, usedHeapSizeAfter: span.heapAfterBytes } })}`,
				);
			}
			await write(`],"metadata":${JSON.stringify({ recordingWindow: { startTs, endTs } })}}`);
		} finally {
			await file.close();
		}
		if (opts.signal.aborted) throw new MemoryProfileError("cancelled");
		await rename(partial, opts.outputPath);
		partial = undefined;
		// Rename may finish after the worker's cancellation cleanup. Its creator owns the late file.
		if (opts.signal.aborted) {
			await unlink(opts.outputPath).catch(() => {});
			throw new MemoryProfileError("cancelled");
		}
		return summary;
	} catch (error) {
		if (partial) await unlink(partial).catch(() => {});
		if (error instanceof MemoryProfileError) throw error;
		throw new MemoryProfileError(opts.signal.aborted ? "cancelled" : "gc_analysis");
	}
}
