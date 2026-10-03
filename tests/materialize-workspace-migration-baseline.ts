import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface JournalEntry {
	idx: number;
	tag: string;
	version: string;
	when: number;
	breakpoints: boolean;
}
interface Journal {
	version: string;
	dialect: string;
	entries: JournalEntry[];
}

/** Reconstruct the append-only pre-change fixture from our frozen worktree assets.
 *  Existing drizzle SQL/journal/snapshots are read-only; no live main checkout is used. */
export function materializeWorkspaceMigrationBaseline(
	source = resolve("drizzle"),
	target = resolve(".narrafork/frozen-workspace-baseline-0185"),
): string {
	const sourceJournal = JSON.parse(
		readFileSync(join(source, "meta/_journal.json"), "utf8"),
	) as Journal;
	if (
		sourceJournal.entries.length < 187 ||
		sourceJournal.entries[186]?.tag !== "0186_polite_preak" ||
		sourceJournal.entries.some((entry, index) => entry.idx !== index)
	)
		throw new Error(
			"Expected the frozen old prefix followed by the workspace-context increment and append-only successors",
		);
	// Later legal increments do not change the frozen 0000–0185 fixture.
	const entries = sourceJournal.entries.slice(0, 186);
	if (entries.length !== 186 || entries.some((entry, index) => entry.idx !== index))
		throw new Error("Frozen old migration chain is not exactly indexes 0000–0185");
	const baseline: Journal = { ...sourceJournal, entries };
	const targetJournal = join(target, "meta/_journal.json");
	if (existsSync(targetJournal)) {
		if (
			JSON.stringify(JSON.parse(readFileSync(targetJournal, "utf8"))) !== JSON.stringify(baseline)
		)
			throw new Error("Existing frozen baseline journal differs; refuse to overwrite it");
	} else {
		if (existsSync(target))
			throw new Error("Existing incomplete baseline directory must not be overwritten");
		mkdirSync(join(target, "meta"), { recursive: true });
		for (const entry of entries)
			copyFileSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
		// Generated test-fixture journal only: extracting the frozen prefix does not
		// alter any source migration or invent initial CREATE TABLE statements.
		writeFileSync(targetJournal, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
	}
	for (const entry of entries) {
		const name = `${entry.tag}.sql`;
		const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
		if (hash(join(source, name)) !== hash(join(target, name)))
			throw new Error(`Frozen migration bytes differ: ${name}`);
	}
	return target;
}

if (import.meta.main) {
	console.log(
		JSON.stringify({
			path: materializeWorkspaceMigrationBaseline(),
			entries: 186,
			sqlHashesMatch: true,
		}),
	);
}
