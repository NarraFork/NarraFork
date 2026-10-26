/** Synthetic embeddings, quantisation and the pure-JS scan kernels (reference implementation). */
import { Rng } from "../time-travel/lib";

export const SPACES = 10; // block i belongs to space (i % 10): every space holds exactly 10% of the vectors

export interface VecGen {
	dim: number;
	centers: Float32Array;
	nCenters: number;
	seed: number;
}

export function makeGen(dim: number, n: number, seed = 42): VecGen {
	const nCenters = Math.max(256, Math.min(4096, Math.floor(n / 200)));
	const rng = new Rng(seed);
	const centers = new Float32Array(nCenters * dim);
	for (let i = 0; i < centers.length; i++) centers[i] = rng.normal();
	return { dim, centers, nCenters, seed };
}

/** Deterministic clustered unit vector number `i` (cluster centre + noise, L2-normalised). */
export function genVector(g: VecGen, i: number, out: Float32Array, noise = 0.9): void {
	const rng = new Rng((g.seed * 2654435761 + i * 40503) >>> 0);
	const c = rng.int(g.nCenters) * g.dim;
	let norm = 0;
	for (let d = 0; d < g.dim; d++) {
		const x = (g.centers[c + d] as number) + noise * (rng.rnd() + rng.rnd() - 1);
		out[d] = x;
		norm += x * x;
	}
	const inv = 1 / Math.sqrt(norm);
	for (let d = 0; d < g.dim; d++) out[d] = (out[d] as number) * inv;
}

/** Symmetric per-vector int8 quantisation. Returns the scale (value = q * scale). */
export function quantize(v: Float32Array, out: Int8Array): number {
	let max = 0;
	for (let i = 0; i < v.length; i++) {
		const a = Math.abs(v[i] as number);
		if (a > max) max = a;
	}
	const scale = max / 127 || 1;
	const inv = 1 / scale;
	for (let i = 0; i < v.length; i++)
		out[i] = Math.max(-127, Math.min(127, Math.round((v[i] as number) * inv)));
	return scale;
}

export class TopK {
	scores: Float32Array;
	ids: Int32Array;
	n = 0;
	thr = -3.4e38;
	constructor(public k: number) {
		this.scores = new Float32Array(k);
		this.ids = new Int32Array(k);
	}
	reset() {
		this.n = 0;
		this.thr = -3.4e38;
	}
	push(s: number, id: number) {
		const k = this.k;
		const sc = this.scores;
		const ids = this.ids;
		let j: number;
		if (this.n < k) j = this.n++;
		else if (s > this.thr) j = k - 1;
		else return;
		while (j > 0 && (sc[j - 1] as number) < s) {
			sc[j] = sc[j - 1] as number;
			ids[j] = ids[j - 1] as number;
			j--;
		}
		sc[j] = s;
		ids[j] = id;
		if (this.n === k) this.thr = sc[k - 1] as number;
	}
}

export function dotF32(q: Float32Array, v: Float32Array, off: number, dim: number): number {
	let s0 = 0;
	let s1 = 0;
	let s2 = 0;
	let s3 = 0;
	for (let i = 0; i < dim; i += 4) {
		s0 += (q[i] as number) * (v[off + i] as number);
		s1 += (q[i + 1] as number) * (v[off + i + 1] as number);
		s2 += (q[i + 2] as number) * (v[off + i + 2] as number);
		s3 += (q[i + 3] as number) * (v[off + i + 3] as number);
	}
	return s0 + s1 + s2 + s3;
}

export function dotI8(q: Int8Array, v: Int8Array, off: number, dim: number): number {
	let s0 = 0;
	let s1 = 0;
	let s2 = 0;
	let s3 = 0;
	for (let i = 0; i < dim; i += 4) {
		s0 += (q[i] as number) * (v[off + i] as number);
		s1 += (q[i + 1] as number) * (v[off + i + 1] as number);
		s2 += (q[i + 2] as number) * (v[off + i + 2] as number);
		s3 += (q[i + 3] as number) * (v[off + i + 3] as number);
	}
	return s0 + s1 + s2 + s3;
}

export function jsScanF32Range(
	top: TopK,
	vecs: Float32Array,
	start: number,
	end: number,
	dim: number,
	q: Float32Array,
) {
	for (let i = start; i < end; i++) {
		const s = dotF32(q, vecs, i * dim, dim);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
export function jsScanF32Tag(
	top: TopK,
	vecs: Float32Array,
	space: Uint32Array,
	want: number,
	start: number,
	end: number,
	dim: number,
	q: Float32Array,
) {
	for (let i = start; i < end; i++) {
		if (space[i] !== want) continue;
		const s = dotF32(q, vecs, i * dim, dim);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
export function jsScanF32Ids(
	top: TopK,
	vecs: Float32Array,
	ids: Uint32Array,
	n: number,
	dim: number,
	q: Float32Array,
) {
	for (let j = 0; j < n; j++) {
		const i = ids[j] as number;
		const s = dotF32(q, vecs, i * dim, dim);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
export function jsScanI8Range(
	top: TopK,
	vecs: Int8Array,
	scales: Float32Array,
	start: number,
	end: number,
	dim: number,
	q: Int8Array,
	qscale: number,
) {
	for (let i = start; i < end; i++) {
		const s = dotI8(q, vecs, i * dim, dim) * qscale * (scales[i] as number);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
export function jsScanI8Tag(
	top: TopK,
	vecs: Int8Array,
	scales: Float32Array,
	space: Uint32Array,
	want: number,
	start: number,
	end: number,
	dim: number,
	q: Int8Array,
	qscale: number,
) {
	for (let i = start; i < end; i++) {
		if (space[i] !== want) continue;
		const s = dotI8(q, vecs, i * dim, dim) * qscale * (scales[i] as number);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
export function jsScanI8Ids(
	top: TopK,
	vecs: Int8Array,
	scales: Float32Array,
	ids: Uint32Array,
	n: number,
	dim: number,
	q: Int8Array,
	qscale: number,
) {
	for (let j = 0; j < n; j++) {
		const i = ids[j] as number;
		const s = dotI8(q, vecs, i * dim, dim) * qscale * (scales[i] as number);
		if (s > top.thr || top.n < top.k) top.push(s, i);
	}
}
