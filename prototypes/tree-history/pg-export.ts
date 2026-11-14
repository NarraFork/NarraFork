/** Dump a gen.ts space to CSV files for COPY. Usage: bun pg-export.ts <space.db> <outdir> */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
const db = new Database(process.argv[2] as string, { readonly: true });
const dir = process.argv[3] as string;
mkdirSync(dir, { recursive: true });
const esc = (v: unknown) => (v === null ? "" : typeof v === "number" ? String(v) : `"${String(v).replaceAll('"', '""')}"`);
for (const table of ["commits", "blocks", "versions", "edges", "touch", "meta"]) {
	const w = Bun.file(`${dir}/${table}.csv`).writer({ highWaterMark: 8 << 20 });
	for (const row of db.query(`SELECT * FROM ${table}`).iterate() as Iterable<Record<string, unknown>>) {
		w.write(`${Object.values(row).map(esc).join(",")}\n`);
	}
	await w.end();
}
