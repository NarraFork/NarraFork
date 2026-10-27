/**
 * Measuring a page's mind-map nodes ahead, in a Worker (`measure.worker.ts`), as soon as the page
 * opens: the first switch to the map then lays out from cached sizes. Bounded: at most
 * `MAX_ITEMS` bodies per call, sent in batches of `BATCH`; a body already cached or in flight is
 * not sent again, and one the Worker could not measure is answered as failed (no longer in
 * flight: the main thread measures it when it needs it). Without a Worker (it failed to start,
 * or there is no `Worker`), nothing happens here and bodies are measured where they are needed.
 */
import { hasMeasuredKey, type LabelOf, measureKey, storeMeasured } from "./measure";
import type { MeasureReply, MeasureRequest } from "./measure.worker";

const BATCH = 250;
/** A live page holds at most 2000 blocks; anything beyond is measured on demand. */
const MAX_ITEMS = 4000;

let worker: Worker | null = null;
let failed = false;
let reqId = 0;
/** Bodies sent and not answered yet, with the batch that answers them. */
const inflight = new Map<string, Promise<void>>();
const waiting = new Map<number, () => void>();
export const prewarmStats = {
	posted: 0,
	done: 0,
	failed: 0,
	workerMs: 0,
	wallMs: 0,
	batches: 0,
};

type Factory = () => Worker;

const defaultFactory: Factory = () =>
	new Worker(new URL("./measure.worker.ts", import.meta.url), { type: "module" });
let factory: Factory | null = defaultFactory;

/** Tests: the Worker to use (a prebuilt bundle), or null for none (measure on demand). */
export function setMeasureWorkerFactoryForTests(next: Factory | null): void {
	worker?.terminate();
	worker = null;
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
		w.onmessage = (e: MessageEvent<MeasureReply>) => {
			for (const [key] of e.data.out) inflight.delete(key);
			for (const key of e.data.failed ?? []) inflight.delete(key);
			storeMeasured(e.data.out);
			prewarmStats.done += e.data.out.length;
			prewarmStats.failed += e.data.failed?.length ?? 0;
			prewarmStats.workerMs += e.data.ms;
			waiting.get(e.data.id)?.();
			waiting.delete(e.data.id);
		};
		w.onerror = () => {
			failed = true;
			worker = null;
			inflight.clear();
			for (const done of waiting.values()) done();
			waiting.clear();
		};
		worker = w;
	} catch {
		failed = true;
	}
	return worker;
}

/**
 * Measure these bodies ahead in the Worker. Resolves when every batch came back (or at once
 * when there is nothing to do or no Worker).
 */
export function prewarmBodies(
	items: Iterable<{ content: string; labelOf: LabelOf }>,
): Promise<void> {
	const w = getWorker();
	if (!w) return Promise.resolve();
	const t0 = performance.now();
	const batch: MeasureRequest["items"] = [];
	// Bodies another call sent already: this call is done when their batches are, too.
	const earlier = new Set<Promise<void>>();
	let seen = 0;
	for (const it of items) {
		if (++seen > MAX_ITEMS) break;
		const { key, labels } = measureKey(it.content, it.labelOf);
		const sent = inflight.get(key);
		if (sent) earlier.add(sent);
		if (sent || hasMeasuredKey(key)) continue;
		batch.push({ key, content: it.content, labels });
	}
	const jobs: Promise<void>[] = [...earlier];
	for (let i = 0; i < batch.length; i += BATCH) {
		const id = ++reqId;
		const chunk = batch.slice(i, i + BATCH);
		const job = new Promise<void>((resolve) => waiting.set(id, resolve));
		for (const it of chunk) inflight.set(it.key, job);
		jobs.push(job);
		w.postMessage({ id, items: chunk } satisfies MeasureRequest);
		prewarmStats.posted += chunk.length;
		prewarmStats.batches++;
	}
	if (jobs.length === 0) return Promise.resolve();
	return Promise.all(jobs).then(() => {
		if (batch.length > 0) prewarmStats.wallMs += performance.now() - t0;
	});
}
