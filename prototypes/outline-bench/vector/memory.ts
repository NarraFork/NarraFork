/**
 * Steady-state memory of the resident layout: a fresh process loads the matrix from the chunked table
 * (r3, no per-row garbage), forces a GC, and reads VmRSS. Load time of r3 is reported as well.
 *
 * Run: bun vector/memory.ts --db=<file with r3> --n=1000000 --dim=1024 --dtype=i8
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arg, argNum, fmt } from "../time-travel/lib";
import type { InitMsg } from "./worker";

const db = arg("db") as string;
const n = argNum("n", 200000);
const dim = argNum("dim", 1024);
const dtype = (arg("dtype") ?? "i8") as "i8" | "f32";
const vm = (key: string) =>
	Number(
		readFileSync("/proc/self/status", "utf8").match(new RegExp(`${key}:\\s+(\\d+) kB`))?.[1] ?? 0,
	) / 1024;
const rssBefore = vm("VmRSS");
const w = new Worker(new URL("./worker.ts", import.meta.url).href);
const r = await new Promise<{ loadMs: number; bytes: number }>((resolve, reject) => {
	w.onmessage = (ev) =>
		ev.data.type === "ready"
			? resolve(ev.data)
			: ev.data.type === "error"
				? reject(new Error(ev.data.error))
				: undefined;
	const msg: InitMsg = {
		type: "init",
		mode: "resident",
		dbPath: db,
		dtype,
		dim,
		n,
		layout: "clustered",
		loadFrom: "r3",
		k: 50,
	};
	w.postMessage(msg);
});
const peak = vm("VmHWM");
Bun.gc(true);
await Bun.sleep(1000);
Bun.gc(true);
const out = {
	n,
	dim,
	dtype,
	loadFromR3Ms: r.loadMs,
	matrixMB: r.bytes / 1e6,
	rssBeforeMB: rssBefore,
	rssAfterLoadMB: vm("VmRSS"),
	peakMB: peak,
};
console.log(
	`n=${n} dim=${dim} ${dtype}: load from r3 ${fmt(r.loadMs / 1000, 1)}s, matrix ${fmt(out.matrixMB, 0)}MB, RSS ${fmt(out.rssAfterLoadMB, 0)}MB (process before ${fmt(rssBefore, 0)}MB), peak ${fmt(peak, 0)}MB`,
);
mkdirSync(join(import.meta.dir, "..", "results"), { recursive: true });
writeFileSync(
	join(import.meta.dir, "..", "results", `vec-memory-${n}-${dim}-${dtype}.json`),
	JSON.stringify(out),
);
process.exit(0);
