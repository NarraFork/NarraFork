/**
 * 节点尺寸的预先测量（Worker）：pretext 在 Worker 里用 OffscreenCanvas，和主线程同一份测量代码。
 * 主线程把块的源文本和提及的显示文字发过来，这里回尺寸。
 */
import { parseToPM } from "../client/convert";
import { measureBody, NODE } from "./measure";

interface Req {
	id: number;
	items: Array<{ key: string; content: string; labels: string[] }>;
}

self.onmessage = (e: MessageEvent<Req>) => {
	const t0 = performance.now();
	const out: Array<[string, number, number]> = [];
	for (const it of e.data.items) {
		const node = parseToPM(it.content).node;
		let i = 0;
		const r = measureBody(node, NODE.maxBody, (ref, label) => it.labels[i++] ?? label ?? ref);
		out.push([it.key, r.w, r.h]);
	}
	postMessage({ id: e.data.id, out, ms: performance.now() - t0 });
};
