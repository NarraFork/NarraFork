/**
 * Vector scan worker (stand-in for a db-worker). Two modes:
 *
 *  - resident: all vectors are loaded once into one WebAssembly.Memory (so the same bytes can be
 *    scanned by the JS kernels and by the SIMD wasm kernels) and every query scans memory.
 *  - sqlite  : nothing is cached; every query reads the candidate vectors from SQLite
 *    (read-only connection inside the worker) and scores them as rows arrive.
 */
import { Database } from "bun:sqlite";
import {
	dotF32,
	dotI8,
	jsScanF32Ids,
	jsScanF32Range,
	jsScanF32Tag,
	jsScanI8Ids,
	jsScanI8Range,
	jsScanI8Tag,
	SPACES,
	TopK,
} from "./common";

type Dtype = "i8" | "f32";

export interface InitMsg {
	type: "init";
	mode: "resident" | "sqlite";
	dbPath: string;
	dtype: Dtype;
	dim: number;
	n: number;
	layout: "clustered" | "interleaved";
	loadFrom: "r2" | "r3";
	k: number;
}
export interface QueryMsg {
	type: "query";
	id: number;
	q: ArrayBuffer;
	qscale: number;
	kernel: "js" | "wasm";
	/** none: whole matrix, range: one space as contiguous range (clustered), tag: per-vector space tag,
	 *  ids: explicit id list, r1/r2/r3: read from SQLite with the given table design, r2-read-only/..: no scoring */
	filter: "none" | "range" | "tag" | "ids" | "r1" | "r2" | "r3" | "r1-read" | "r2-read" | "r3-read";
	space: number;
}

let init: InitMsg;
let db: Database | null = null;
let mem: WebAssembly.Memory;
let wasm: WebAssembly.Instance | null = null;
let vecsI8: Int8Array;
let vecsF32: Float32Array;
let scales: Float32Array;
let space: Uint32Array;
let blockIdAt: Int32Array;
let idsBuf: Uint32Array; // candidate id list scratch (inside wasm memory)
let spaceStart: number[] = [];
let spaceCount: number[] = [];
const ptr = { q: 0, topS: 0, topI: 0, scales: 0, space: 0, ids: 0, vecs: 0 };
const top = new TopK(50);
let N = 0;
let D = 0;

function align(x: number, a = 64) {
	return Math.ceil(x / a) * a;
}

async function loadWasm(bytes: ArrayBuffer, pages: number) {
	mem = new WebAssembly.Memory({ initial: pages, maximum: 65536 });
	const mod = await WebAssembly.compile(bytes);
	wasm = await WebAssembly.instantiate(mod, { env: { memory: mem } });
}

async function doInit(msg: InitMsg) {
	init = msg;
	D = msg.dim;
	N = msg.n;
	top.k = msg.k;
	top.scores = new Float32Array(msg.k);
	top.ids = new Int32Array(msg.k);
	const t0 = performance.now();
	if (msg.mode === "sqlite") {
		db = new Database(msg.dbPath, { readonly: true });
		db.run("PRAGMA cache_size = -16000");
		db.run("PRAGMA mmap_size = 268435456");
		return { loadMs: performance.now() - t0, bytes: 0 };
	}
	// resident
	const bytesPer = msg.dtype === "i8" ? D : D * 4;
	ptr.q = 1 << 20;
	ptr.topS = ptr.q + 8192;
	ptr.topI = ptr.topS + 4096;
	ptr.scales = align(ptr.topI + 4096);
	ptr.space = align(ptr.scales + 4 * N);
	ptr.ids = align(ptr.space + 4 * N);
	ptr.vecs = align(ptr.ids + 4 * Math.ceil(N / SPACES) + 64);
	const total = ptr.vecs + N * bytesPer;
	const pages = Math.ceil(total / 65536);
	if (pages > 65536) throw new Error(`needs ${pages} wasm pages (> 4 GiB)`);
	await loadWasm(await Bun.file(new URL("./kernels.wasm", import.meta.url)).arrayBuffer(), pages);
	const buf = mem.buffer;
	scales = new Float32Array(buf, ptr.scales, N);
	space = new Uint32Array(buf, ptr.space, N);
	idsBuf = new Uint32Array(buf, ptr.ids, Math.ceil(N / SPACES));
	if (msg.dtype === "i8") vecsI8 = new Int8Array(buf, ptr.vecs, N * D);
	else vecsF32 = new Float32Array(buf, ptr.vecs, N * D);
	blockIdAt = new Int32Array(N);
	spaceStart = [];
	spaceCount = new Array(SPACES).fill(0);
	const d = new Database(msg.dbPath, { readonly: true });
	let pos = 0;
	const place = (blockId: number, sp: number, sc: number, blob: Uint8Array, at?: number) => {
		const p = at ?? pos++;
		blockIdAt[p] = blockId;
		space[p] = sp;
		scales[p] = sc;
		if (msg.dtype === "i8") vecsI8.set(new Int8Array(blob.buffer, blob.byteOffset, D), p * D);
		else {
			const dst = new Uint8Array(buf, ptr.vecs + p * bytesPer, bytesPer);
			dst.set(blob);
		}
	};
	if (msg.loadFrom === "r2") {
		// PK order = clustered by space; interleaved layout places each row at its arrival index
		const it = d.query("SELECT space_id, block_id, scale, vec FROM vec2").iterate();
		for (const r of it as Iterable<{
			space_id: number;
			block_id: number;
			scale: number;
			vec: Uint8Array;
		}>) {
			if (msg.layout === "clustered") {
				if (spaceStart[r.space_id] === undefined) spaceStart[r.space_id] = pos;
				spaceCount[r.space_id]++;
				place(r.block_id, r.space_id, r.scale, r.vec);
			} else {
				place(r.block_id, r.space_id, r.scale, r.vec, r.block_id);
			}
		}
	} else {
		const it = d.query("SELECT space_id, n, ids, scales, vecs FROM chunks").iterate();
		for (const r of it as Iterable<{
			space_id: number;
			n: number;
			ids: Uint8Array;
			scales: Uint8Array;
			vecs: Uint8Array;
		}>) {
			const ids = new Int32Array(
				r.ids.buffer.slice(r.ids.byteOffset, r.ids.byteOffset + r.ids.byteLength),
			);
			const scs = new Float32Array(
				r.scales.buffer.slice(r.scales.byteOffset, r.scales.byteOffset + r.scales.byteLength),
			);
			const base = msg.layout === "clustered" ? pos : -1;
			if (msg.layout === "clustered") {
				if (spaceStart[r.space_id] === undefined) spaceStart[r.space_id] = pos;
				spaceCount[r.space_id] += r.n;
			}
			for (let j = 0; j < r.n; j++) {
				const blob = r.vecs.subarray(j * bytesPer, (j + 1) * bytesPer);
				if (base >= 0) place(ids[j] as number, r.space_id, scs[j] as number, blob);
				else place(ids[j] as number, r.space_id, scs[j] as number, blob, ids[j] as number);
			}
		}
	}
	d.close();
	// per-space id lists for the "ids" filter (positions, ascending)
	return { loadMs: performance.now() - t0, bytes: total };
}

const idLists: Uint32Array[] = [];
function idListFor(sp: number): Uint32Array {
	let l = idLists[sp];
	if (!l) {
		const tmp: number[] = [];
		for (let i = 0; i < N; i++) if (space[i] === sp) tmp.push(i);
		l = new Uint32Array(tmp);
		idLists[sp] = l;
	}
	return l;
}

function queryResident(m: QueryMsg) {
	const useWasm = m.kernel === "wasm";
	const k = top.k;
	const mk = (wasm as WebAssembly.Instance).exports as Record<string, (...a: number[]) => number>;
	const bytes = m.q.byteLength;
	new Uint8Array(mem.buffer, ptr.q, bytes).set(new Uint8Array(m.q));
	let ids: Uint32Array | null = null;
	let nIds = 0;
	if (m.filter === "ids") {
		const l = idListFor(m.space);
		idsBuf.set(l);
		ids = idsBuf;
		nIds = l.length;
	}
	let start = 0;
	let end = N;
	if (m.filter === "range") {
		start = spaceStart[m.space] as number;
		end = start + (spaceCount[m.space] as number);
	}
	const t0 = performance.now();
	if (useWasm) {
		mk.topk_reset?.(ptr.topS, ptr.topI, k);
		if (init.dtype === "i8") {
			if (m.filter === "tag")
				mk.scan_i8_tag?.(ptr.vecs, ptr.scales, ptr.space, m.space, 0, N, D, ptr.q, m.qscale);
			else if (m.filter === "ids")
				mk.scan_i8_ids?.(ptr.vecs, ptr.scales, ptr.ids, nIds, D, ptr.q, m.qscale);
			else mk.scan_i8_range?.(ptr.vecs, ptr.scales, start, end, D, ptr.q, m.qscale);
		} else {
			if (m.filter === "tag") mk.scan_f32_tag?.(ptr.vecs, ptr.space, m.space, 0, N, D, ptr.q);
			else if (m.filter === "ids") mk.scan_f32_ids?.(ptr.vecs, ptr.ids, nIds, D, ptr.q);
			else mk.scan_f32_range?.(ptr.vecs, start, end, D, ptr.q);
		}
		const cnt = mk.topk_count?.() as number;
		const scoresOut = new Float32Array(mem.buffer, ptr.topS, cnt).slice();
		const idsOut = new Int32Array(mem.buffer, ptr.topI, cnt).slice();
		return {
			scanMs: performance.now() - t0,
			scores: scoresOut,
			ids: idsOut.map((i) => blockIdAt[i] as number),
		};
	}
	top.reset();
	if (init.dtype === "i8") {
		const q = new Int8Array(mem.buffer, ptr.q, D);
		if (m.filter === "tag") jsScanI8Tag(top, vecsI8, scales, space, m.space, 0, N, D, q, m.qscale);
		else if (m.filter === "ids")
			jsScanI8Ids(top, vecsI8, scales, ids as Uint32Array, nIds, D, q, m.qscale);
		else jsScanI8Range(top, vecsI8, scales, start, end, D, q, m.qscale);
	} else {
		const q = new Float32Array(mem.buffer, ptr.q, D);
		if (m.filter === "tag") jsScanF32Tag(top, vecsF32, space, m.space, 0, N, D, q);
		else if (m.filter === "ids") jsScanF32Ids(top, vecsF32, ids as Uint32Array, nIds, D, q);
		else jsScanF32Range(top, vecsF32, start, end, D, q);
	}
	const cnt = top.n;
	return {
		scanMs: performance.now() - t0,
		scores: top.scores.slice(0, cnt),
		ids: Int32Array.from(top.ids.subarray(0, cnt), (i) => blockIdAt[i] as number),
	};
}

function toI8(blob: Uint8Array): Int8Array {
	return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
}
function toF32(blob: Uint8Array): Float32Array {
	if (blob.byteOffset % 4 === 0)
		return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
	const c = new Uint8Array(blob.byteLength);
	c.set(blob);
	return new Float32Array(c.buffer);
}

const stmtCache = new Map<string, ReturnType<Database["query"]>>();
function stmt(sql: string) {
	let s = stmtCache.get(sql);
	if (!s) {
		s = (db as Database).query(sql);
		stmtCache.set(sql, s);
	}
	return s;
}

function querySqlite(m: QueryMsg) {
	const readOnly = m.filter.endsWith("-read");
	const kind = m.filter.replace("-read", "") as "r1" | "r2" | "r3";
	top.reset();
	const qF32 = init.dtype === "f32" ? new Float32Array(m.q) : null;
	const qI8 = init.dtype === "i8" ? new Int8Array(m.q) : null;
	let rows = 0;
	let bytes = 0;
	const t0 = performance.now();
	const score = (blockId: number, sc: number, blob: Uint8Array) => {
		rows++;
		bytes += blob.byteLength;
		if (readOnly) return;
		const s = qI8
			? dotI8(qI8, toI8(blob), 0, D) * m.qscale * sc
			: dotF32(qF32 as Float32Array, toF32(blob), 0, D);
		if (s > top.thr || top.n < top.k) top.push(s, blockId);
	};
	if (kind === "r2") {
		const it = stmt("SELECT block_id, scale, vec FROM vec2 WHERE space_id = ?1").iterate(m.space);
		for (const r of it as Iterable<{ block_id: number; scale: number; vec: Uint8Array }>)
			score(r.block_id, r.scale, r.vec);
	} else if (kind === "r1") {
		const it = stmt(
			"SELECT b.id AS block_id, e.scale AS scale, e.vector_blob AS vec FROM blocks b JOIN embeddings e ON e.model_id = ?1 AND e.content_hash = b.content_hash WHERE b.space_id = ?2",
		).iterate("text-embedding-bench", m.space);
		for (const r of it as Iterable<{ block_id: number; scale: number; vec: Uint8Array }>)
			score(r.block_id, r.scale, r.vec);
	} else {
		const it = stmt("SELECT n, ids, scales, vecs FROM chunks WHERE space_id = ?1").iterate(m.space);
		const bytesPer = init.dtype === "i8" ? D : D * 4;
		for (const r of it as Iterable<{
			n: number;
			ids: Uint8Array;
			scales: Uint8Array;
			vecs: Uint8Array;
		}>) {
			const ids = new Int32Array(
				r.ids.buffer.slice(r.ids.byteOffset, r.ids.byteOffset + r.ids.byteLength),
			);
			const scs = new Float32Array(
				r.scales.buffer.slice(r.scales.byteOffset, r.scales.byteOffset + r.scales.byteLength),
			);
			for (let j = 0; j < r.n; j++)
				score(
					ids[j] as number,
					scs[j] as number,
					r.vecs.subarray(j * bytesPer, (j + 1) * bytesPer),
				);
		}
	}
	const cnt = top.n;
	return {
		scanMs: performance.now() - t0,
		scores: top.scores.slice(0, cnt),
		ids: top.ids.slice(0, cnt),
		rows,
		bytes,
	};
}

declare const self: Worker;
self.onmessage = async (ev: MessageEvent<InitMsg | QueryMsg | { type: "close" }>) => {
	const m = ev.data;
	try {
		if (m.type === "init") {
			const r = await doInit(m);
			self.postMessage({ type: "ready", ...r });
		} else if (m.type === "query") {
			const r = init.mode === "resident" ? queryResident(m) : querySqlite(m);
			self.postMessage({ type: "result", id: m.id, ...r });
		} else if (m.type === "close") {
			db?.close();
			self.postMessage({ type: "closed" });
		}
	} catch (e) {
		self.postMessage({ type: "error", error: String(e), stack: (e as Error).stack });
	}
};
