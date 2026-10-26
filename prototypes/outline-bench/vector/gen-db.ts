/**
 * Build the SQLite files used by the vector benchmark.
 *
 * Tables (see README):
 *   r1  design-literal  : blocks(id, space_id, content_hash) JOIN embeddings(model_id, content_hash, vector_blob)
 *   r2  clustered rows  : vec2(space_id, block_id, scale, vec) WITHOUT ROWID, PK (space_id, block_id)
 *   r3  chunked packs   : chunks(space_id, chunk_no, n, ids, scales, vecs) 512 vectors per row
 *
 * Block i lives in space (i % 10) and is stored as int8 (+scale) or float32.
 */
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { genVector, makeGen, quantize, SPACES } from "./common";

export type Dtype = "i8" | "f32";
export interface DbSpec {
	dtype: Dtype;
	path: string;
	tables: ("r1" | "r2" | "r3")[];
}

export const CHUNK = 512;

export function buildDbs(n: number, dim: number, specs: DbSpec[]) {
	const g = makeGen(dim, n);
	const dbs = specs.map((s) => {
		rmSync(s.path, { force: true });
		rmSync(`${s.path}-wal`, { force: true });
		rmSync(`${s.path}-shm`, { force: true });
		const db = new Database(s.path, { create: true });
		db.run("PRAGMA journal_mode = OFF");
		db.run("PRAGMA synchronous = OFF");
		db.run("PRAGMA cache_size = -200000");
		if (s.tables.includes("r2"))
			db.run(
				"CREATE TABLE vec2 (space_id INTEGER NOT NULL, block_id INTEGER NOT NULL, scale REAL NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (space_id, block_id)) WITHOUT ROWID",
			);
		if (s.tables.includes("r3"))
			db.run(
				"CREATE TABLE chunks (space_id INTEGER NOT NULL, chunk_no INTEGER NOT NULL, n INTEGER NOT NULL, ids BLOB NOT NULL, scales BLOB NOT NULL, vecs BLOB NOT NULL, PRIMARY KEY (space_id, chunk_no)) WITHOUT ROWID",
			);
		if (s.tables.includes("r1")) {
			db.run(
				"CREATE TABLE blocks (id INTEGER PRIMARY KEY, space_id INTEGER NOT NULL, content_hash TEXT NOT NULL)",
			);
			db.run(
				"CREATE TABLE embeddings (model_id TEXT NOT NULL, content_hash TEXT NOT NULL, dims INTEGER NOT NULL, scale REAL NOT NULL, vector_blob BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (model_id, content_hash))",
			);
		}
		return { spec: s, db, begin: false };
	});
	const f = new Float32Array(dim);
	const bytesPer = (d: Dtype) => (d === "i8" ? dim : dim * 4);
	const make = (i: number) => {
		genVector(g, i, f);
		const out: { f32?: Uint8Array; i8?: Uint8Array; scale: number } = { scale: 1 };
		if (dbs.some((d) => d.spec.dtype === "f32"))
			out.f32 = new Uint8Array(new Float32Array(f).buffer);
		if (dbs.some((d) => d.spec.dtype === "i8")) {
			const q = new Int8Array(dim);
			out.scale = quantize(f, q);
			out.i8 = new Uint8Array(q.buffer);
		}
		return out;
	};
	const perSpace = n / SPACES;

	// pass A: clustered order (space-major) for r2 / r3
	const needA = dbs.some((d) => d.spec.tables.includes("r2") || d.spec.tables.includes("r3"));
	if (needA) {
		const ins2 = dbs.map((d) =>
			d.spec.tables.includes("r2") ? d.db.prepare("INSERT INTO vec2 VALUES (?,?,?,?)") : null,
		);
		const ins3 = dbs.map((d) =>
			d.spec.tables.includes("r3") ? d.db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?)") : null,
		);
		for (let s = 0; s < SPACES; s++) {
			const chunkBuf = dbs.map((d) => new Uint8Array(CHUNK * bytesPer(d.spec.dtype)));
			const chunkScale = new Float32Array(CHUNK);
			const chunkIds = new Int32Array(CHUNK);
			let inChunk = 0;
			let chunkNo = 0;
			for (let b = 0; b < dbs.length; b++) (dbs[b] as (typeof dbs)[number]).db.run("BEGIN");
			const flush = () => {
				if (inChunk === 0) return;
				dbs.forEach((d, k) => {
					const st = ins3[k];
					if (!st) return;
					const bytes = bytesPer(d.spec.dtype);
					st.run(
						s,
						chunkNo,
						inChunk,
						new Uint8Array(chunkIds.buffer.slice(0, inChunk * 4)),
						new Uint8Array(chunkScale.buffer.slice(0, inChunk * 4)),
						(chunkBuf[k] as Uint8Array).slice(0, inChunk * bytes),
					);
				});
				chunkNo++;
				inChunk = 0;
			};
			for (let j = 0; j < perSpace; j++) {
				const i = j * SPACES + s;
				const v = make(i);
				dbs.forEach((d, k) => {
					const blob = d.spec.dtype === "i8" ? (v.i8 as Uint8Array) : (v.f32 as Uint8Array);
					const sc = d.spec.dtype === "i8" ? v.scale : 1;
					ins2[k]?.run(s, i, sc, blob);
					if (ins3[k]) (chunkBuf[k] as Uint8Array).set(blob, inChunk * bytesPer(d.spec.dtype));
					if (k === 0) {
						chunkScale[inChunk] = sc;
						chunkIds[inChunk] = i;
					}
				});
				if (ins3.some(Boolean)) {
					inChunk++;
					if (inChunk === CHUNK) flush();
				}
			}
			flush();
			for (const d of dbs) d.db.run("COMMIT");
			process.stdout.write(`  pass A space ${s + 1}/${SPACES}\r`);
		}
		console.log();
	}

	// pass B: arrival order for r1
	const needB = dbs.some((d) => d.spec.tables.includes("r1"));
	if (needB) {
		const insB = dbs.map((d) =>
			d.spec.tables.includes("r1") ? d.db.prepare("INSERT INTO blocks VALUES (?,?,?)") : null,
		);
		const insE = dbs.map((d) =>
			d.spec.tables.includes("r1")
				? d.db.prepare("INSERT INTO embeddings VALUES (?,?,?,?,?,?)")
				: null,
		);
		for (const d of dbs) d.db.run("BEGIN");
		for (let i = 0; i < n; i++) {
			const v = make(i);
			const hash = (Bun.hash(`h${i}`) as bigint).toString(16);
			dbs.forEach((d, k) => {
				if (!insB[k]) return;
				const blob = d.spec.dtype === "i8" ? (v.i8 as Uint8Array) : (v.f32 as Uint8Array);
				insB[k]?.run(i, i % SPACES, hash);
				insE[k]?.run(
					"text-embedding-bench",
					hash,
					dim,
					d.spec.dtype === "i8" ? v.scale : 1,
					blob,
					1700000000000,
				);
			});
			if (i % 50000 === 49999) {
				for (const d of dbs) {
					d.db.run("COMMIT");
					d.db.run("BEGIN");
				}
			}
		}
		for (const d of dbs) d.db.run("COMMIT");
		for (const d of dbs)
			if (d.spec.tables.includes("r1")) d.db.run("CREATE INDEX blocks_space ON blocks (space_id)");
	}
	for (const d of dbs) {
		d.db.run("ANALYZE");
		d.db.close();
	}
}

if (import.meta.main) {
	// bun vector/gen-db.ts <n> <dim> [dtype=i8] [tables=r1,r2,r3] [path]
	const n = Number(process.argv[2] ?? 50000);
	const dim = Number(process.argv[3] ?? 768);
	const dtype = (process.argv[4] ?? "i8") as Dtype;
	const tables = (process.argv[5] ?? "r1,r2,r3").split(",") as DbSpec["tables"];
	const path =
		process.argv[6] ?? `${process.env.OUTLINE_BENCH_DATA ?? "."}/vec-test-${n}-${dim}-${dtype}.db`;
	const t0 = performance.now();
	buildDbs(n, dim, [{ dtype, path, tables }]);
	console.log(`built ${path} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
