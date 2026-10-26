/**
 * Quantisation loss: recall of the int8 brute-force top-K against the exact float32 top-K, with the
 * same "10% of the vectors" space filter the latency benchmark uses. Also reports the cheap fix:
 * take the int8 top-(4K) and re-score those with the float32 vectors.
 *
 * Run: bun vector/recall.ts --n=50000 --dim=768 [--queries=200]
 */
import { arg, argNum, fmt } from "../time-travel/lib";
import { dotF32, genVector, jsScanF32Range, jsScanI8Range, makeGen, quantize, SPACES, TopK } from "./common";

const n = argNum("n", 50000);
const dim = argNum("dim", 768);
const Q = argNum("queries", 200);
const noise = Number(arg("noise") ?? 0.9);
const K = 50;

const g = makeGen(dim, n);
const f32 = new Float32Array(n * dim);
const i8 = new Int8Array(n * dim);
const scales = new Float32Array(n);
const tmp = new Float32Array(dim);
// clustered layout: space-major so each space is a contiguous range
const ids: number[] = [];
for (let s = 0; s < SPACES; s++) for (let j = 0; j < n / SPACES; j++) ids.push(j * SPACES + s);
for (let p = 0; p < n; p++) {
	genVector(g, ids[p] as number, tmp, noise);
	f32.set(tmp, p * dim);
	scales[p] = quantize(tmp, i8.subarray(p * dim, (p + 1) * dim));
}
const per = n / SPACES;
let r10 = 0;
let r50 = 0;
let rr10 = 0;
let rr50 = 0;
let gap = 0;
for (let j = 0; j < Q; j++) {
	const q = new Float32Array(dim);
	genVector(g, n + 1 + j, q, noise * 1.2);
	const qi = new Int8Array(dim);
	const qs = quantize(q, qi);
	const s = j % SPACES;
	const start = s * per;
	const exact = new TopK(K);
	jsScanF32Range(exact, f32, start, start + per, dim, q);
	const approx = new TopK(K);
	jsScanI8Range(approx, i8, scales, start, start + per, dim, qi, qs);
	const wide = new TopK(4 * K);
	jsScanI8Range(wide, i8, scales, start, start + per, dim, qi, qs);
	const rerank = new TopK(K);
	for (let t = 0; t < wide.n; t++) {
		const id = wide.ids[t] as number;
		rerank.push(dotF32(q, f32, id * dim, dim), id);
	}
	const set = (t: TopK, at: number) => new Set(Array.from(t.ids.subarray(0, Math.min(at, t.n))));
	const hit = (a: Set<number>, ref: Set<number>) => {
		let h = 0;
		for (const x of a) if (ref.has(x)) h++;
		return h / ref.size;
	};
	r10 += hit(set(approx, 10), set(exact, 10));
	r50 += hit(set(approx, 50), set(exact, 50));
	rr10 += hit(set(rerank, 10), set(exact, 10));
	rr50 += hit(set(rerank, 50), set(exact, 50));
	gap += (exact.scores[0] as number) - (exact.scores[K - 1] as number);
}
console.log(
	JSON.stringify({
		n,
		dim,
		queries: Q,
		noise,
		meanTop1MinusTop50Score: gap / Q,
		int8RecallAt10: r10 / Q,
		int8RecallAt50: r50 / Q,
		int8Top200ThenF32RerankRecallAt10: rr10 / Q,
		int8Top200ThenF32RerankRecallAt50: rr50 / Q,
	}),
);
console.log(`n=${n} dim=${dim}: int8 recall@10 ${fmt(r10 / Q, 3)} @50 ${fmt(r50 / Q, 3)}; with f32 rerank of int8 top-200: @10 ${fmt(rr10 / Q, 3)} @50 ${fmt(rr50 / Q, 3)}`);
