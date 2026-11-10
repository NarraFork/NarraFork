/**
 * Measures mind-map nodes ahead, off the main thread (design §6.10, the prototype's practice):
 * pretext on an OffscreenCanvas, with the same code and fonts as the main thread
 * (`measure.ts`). The page sends bodies with the text their mentions show; this answers sizes
 * keyed the way the main thread's cache is.
 */
import { setTypography, type TypographySettings } from "@shared/pretext-layout/typography";
import { parseToPM } from "../editor/convert";
import { measureBody, NODE } from "./measure";

export interface MeasureRequest {
	id: number;
	/**
	 * The reader's typography on the main thread. The Worker has its own copy of the
	 * typography module (at the default until told otherwise), so every request carries the
	 * setting its keys were made under (`measureKey`'s signature) and it is applied first.
	 */
	typography: TypographySettings;
	items: Array<{ key: string; content: string; labels: Record<string, string> }>;
}

export interface MeasureReply {
	id: number;
	out: Array<[string, number, number]>;
	ms: number;
}

const scope = self as unknown as {
	onmessage: ((e: MessageEvent<MeasureRequest>) => void) | null;
	postMessage(message: MeasureReply): void;
};

scope.onmessage = (e) => {
	const t0 = performance.now();
	setTypography(e.data.typography);
	const out: Array<[string, number, number]> = [];
	for (const it of e.data.items) {
		try {
			const node = parseToPM(it.content).node;
			const r = measureBody(
				node,
				NODE.maxBody,
				(ref, label) => it.labels[JSON.stringify([ref, label])] ?? label ?? ref,
			);
			out.push([it.key, r.w, r.h]);
		} catch {
			// Missing keys are counted as failed by the client and keep their placeholder.
		}
	}
	scope.postMessage({ id: e.data.id, out, ms: performance.now() - t0 });
};
