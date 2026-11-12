/**
 * Exact node sizes are computed only in measure.worker.ts. A failed, missing or hung Worker
 * leaves uncached bodies provisional; resolving this job never authorizes UI-thread measuring.
 * Input, pending work, replies and lifetime are bounded, and obsolete replies cannot fill caches.
 */
import { getTypography, getTypographyRevision } from "@shared/pretext-layout/typography";
import {
	hasMeasuredKey,
	type LabelOf,
	MAX_MEASURE_BODY_CHARS,
	measureKey,
	storeMeasured,
} from "./measure";
import type { MeasureReply, MeasureRequest } from "./measure.worker";

const BATCH = 250;
const MAX_ITEMS = 4000;
/** Across ALL pending calls: at most 4 MB of UTF-16 source/key/label strings. */
const MAX_REQUEST_CHARS = 2_000_000;
const WATCHDOG_MS = 5_000;

export interface PrewarmResult {
	status: "ready" | "partial" | "unavailable" | "failed" | "timeout" | "cancelled" | "limited";
	measured: number;
	failed: number;
}
interface Waiting {
	keys: Set<string>;
	chars: number;
	revision: number;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: PrewarmResult) => void;
}
let worker: Worker | null = null;
let failed = false;
let reqId = 0;
let pendingChars = 0;
const inflight = new Map<string, Promise<PrewarmResult>>();
const waiting = new Map<number, Waiting>();
export const prewarmStats = {
	posted: 0,
	done: 0,
	failed: 0,
	workerMs: 0,
	wallMs: 0,
	batches: 0,
	timeouts: 0,
};

type Factory = () => Worker;
const defaultFactory: Factory = () =>
	new Worker(new URL("./measure.worker.ts", import.meta.url), { type: "module" });
let factory: Factory | null = defaultFactory;

function settle(id: number, result: PrewarmResult): void {
	const entry = waiting.get(id);
	if (!entry) return;
	waiting.delete(id);
	pendingChars -= entry.chars;
	clearTimeout(entry.timer);
	for (const key of entry.keys) inflight.delete(key);
	entry.resolve(result);
}

function stop(status: "failed" | "timeout" | "cancelled"): void {
	const previous = worker;
	worker = null;
	if (previous) {
		previous.onmessage = null;
		previous.onerror = null;
		previous.terminate();
	}
	for (const [id, entry] of waiting) {
		if (status !== "cancelled") prewarmStats.failed += entry.keys.size;
		settle(id, { status, measured: 0, failed: entry.keys.size });
	}
}

/** Tests can disable or replace the isolated executor; pending jobs are explicitly cancelled. */
export function setMeasureWorkerFactoryForTests(next: Factory | null): void {
	stop("cancelled");
	failed = false;
	factory = next;
}

function getWorker(): Worker | null {
	if (worker || failed) return worker;
	if (!factory || typeof Worker !== "function") {
		failed = true;
		return null;
	}
	try {
		const w = factory();
		worker = w;
		w.onmessage = (e: MessageEvent<MeasureReply>) => {
			if (worker !== w) return;
			const entry = waiting.get(e.data.id);
			if (!entry) return;
			// A -> B -> A is also a different generation: a signature alone is insufficient.
			if (entry.revision !== getTypographyRevision()) {
				settle(e.data.id, { status: "cancelled", measured: 0, failed: entry.keys.size });
				return;
			}
			const seen = new Set<string>();
			const out = e.data.out.filter(([key, width, height]) => {
				if (
					!entry.keys.has(key) ||
					seen.has(key) ||
					!Number.isFinite(width) ||
					!Number.isFinite(height) ||
					width < 0 ||
					height < 0
				)
					return false;
				seen.add(key);
				return true;
			});
			storeMeasured(out);
			const failures = entry.keys.size - out.length;
			prewarmStats.done += out.length;
			prewarmStats.failed += failures;
			if (Number.isFinite(e.data.ms)) prewarmStats.workerMs += Math.max(0, e.data.ms);
			settle(e.data.id, {
				status: failures > 0 ? "partial" : "ready",
				measured: out.length,
				failed: failures,
			});
		};
		w.onerror = () => {
			if (worker !== w) return;
			failed = true;
			stop("failed");
		};
	} catch {
		failed = true;
		stop("failed");
	}
	return worker;
}

/** Returns an explicit outcome, including partial failures; never runs a local measurement. */
export function prewarmBodies(
	items: Iterable<{ content: string; labelOf: LabelOf }>,
	options: { timeoutMs?: number; onAccepted?: (key: string) => void } = {},
): Promise<PrewarmResult> {
	const revision = getTypographyRevision();
	// Drop old-generation work before deduplication (A -> B -> A must not join old A).
	if ([...waiting.values()].some((entry) => entry.revision !== revision)) stop("cancelled");
	const w = getWorker();
	if (!w) return Promise.resolve({ status: "unavailable", measured: 0, failed: 0 });
	const t0 = performance.now();
	const batch: MeasureRequest["items"] = [];
	const earlier = new Set<Promise<PrewarmResult>>();
	const unique = new Set<string>();
	let seen = 0;
	let chars = 0;
	let limited = 0;
	for (const it of items) {
		if (++seen > MAX_ITEMS) {
			limited++;
			break;
		}
		if (it.content.length > MAX_MEASURE_BODY_CHARS) {
			limited++;
			continue;
		}
		const { key, labels } = measureKey(it.content, it.labelOf);
		const sent = inflight.get(key);
		if (sent) {
			earlier.add(sent);
			options.onAccepted?.(key);
		}
		if (sent || hasMeasuredKey(key) || unique.has(key)) continue;
		const itemChars = key.length + it.content.length + JSON.stringify(labels).length;
		if (itemChars > MAX_REQUEST_CHARS) {
			limited++;
			continue;
		}
		if (
			chars + itemChars + pendingChars > MAX_REQUEST_CHARS ||
			batch.length + inflight.size >= MAX_ITEMS
		) {
			limited++;
			break;
		}
		chars += itemChars;
		unique.add(key);
		batch.push({ key, content: it.content, labels });
	}
	const jobs: Promise<PrewarmResult>[] = [...earlier];
	const typography = { ...getTypography() };
	for (let i = 0; i < batch.length; i += BATCH) {
		const id = ++reqId;
		const chunk = batch.slice(i, i + BATCH);
		const chunkChars = chunk.reduce(
			(n, it) => n + it.key.length + it.content.length + JSON.stringify(it.labels).length,
			0,
		);
		pendingChars += chunkChars;
		const job = new Promise<PrewarmResult>((resolve) => {
			const timer = setTimeout(() => {
				if (!waiting.has(id)) return;
				prewarmStats.timeouts++;
				// A later explicit prewarm may retry in a fresh Worker, not on the UI thread.
				stop("timeout");
			}, options.timeoutMs ?? WATCHDOG_MS);
			waiting.set(id, {
				keys: new Set(chunk.map((it) => it.key)),
				chars: chunkChars,
				revision,
				timer,
				resolve,
			});
		});
		for (const it of chunk) {
			inflight.set(it.key, job);
			options.onAccepted?.(it.key);
		}
		jobs.push(job);
		try {
			w.postMessage({ id, typography, items: chunk } satisfies MeasureRequest);
			prewarmStats.posted += chunk.length;
			prewarmStats.batches++;
		} catch {
			failed = true;
			stop("failed");
			break;
		}
	}
	return Promise.all(jobs).then((results) => {
		if (batch.length > 0) prewarmStats.wallMs += performance.now() - t0;
		return {
			status: results.find((r) => r.status !== "ready")?.status ?? (limited ? "limited" : "ready"),
			measured: results.reduce((n, r) => n + r.measured, 0),
			failed: limited + results.reduce((n, r) => n + r.failed, 0),
		};
	});
}
