/**
 * Measures mind-map nodes ahead, off the main thread (design §6.10, the prototype's practice):
 * pretext on an OffscreenCanvas, with the same code and fonts as the main thread
 * (`measure.ts`). The page sends bodies with the text their mentions show; this answers sizes
 * keyed the way the main thread's cache is.
 */
import { parseToPM } from "../editor/convert";
import { measureBody, NODE } from "./measure";

export interface MeasureRequest {
	id: number;
	items: Array<{ key: string; content: string; labels: string[] }>;
}

export interface MeasureReply {
	id: number;
	out: Array<[string, number, number]>;
	/** Keys measured nowhere here (the main thread measures them when it needs them). */
	failed: string[];
	ms: number;
}

const scope = self as unknown as {
	onmessage: ((e: MessageEvent<MeasureRequest>) => void) | null;
	postMessage(message: MeasureReply): void;
};

scope.onmessage = (e) => {
	const t0 = performance.now();
	const out: Array<[string, number, number]> = [];
	const failed: string[] = [];
	for (const it of e.data.items) {
		try {
			const node = parseToPM(it.content).node;
			let i = 0;
			const r = measureBody(node, NODE.maxBody, (ref, label) => it.labels[i++] ?? label ?? ref);
			out.push([it.key, r.w, r.h]);
		} catch {
			// Answered as failed: the main thread measures it when needed (and may send it again).
			failed.push(it.key);
		}
	}
	scope.postMessage({ id: e.data.id, out, failed, ms: performance.now() - t0 });
};
