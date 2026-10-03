import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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

const featureIntroductions = [
	/\bCREATE\s+TABLE\s+[`"]?permission_rule_requests[`"]?\s*\(/i,
	/\bCREATE\s+TABLE\s+[`"]?narrator_worktree_resources[`"]?\s*\(/i,
	/\bALTER\s+TABLE\s+[`"]?narrators[`"]?\s+ADD\s+(?:COLUMN\s+)?[`"]?workspace_revision[`"]?\s/i,
	/\bALTER\s+TABLE\s+[`"]?narrators[`"]?\s+ADD\s+(?:COLUMN\s+)?[`"]?workspace_context[`"]?\s/i,
];
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Freeze the complete prefix before the first workspace feature DDL, not a random tag.
 * Existing drizzle assets are read-only; no mutable main checkout is consulted. */
export function materializeWorkspaceMigrationBaseline(
	source = resolve("drizzle"),
	target = resolve(".narrafork/frozen-workspace-migration-baseline"),
): string {
	const sourceJournal = JSON.parse(
		readFileSync(join(source, "meta/_journal.json"), "utf8"),
	) as Journal;
	if (
		sourceJournal.dialect !== "sqlite" ||
		!Array.isArray(sourceJournal.entries) ||
		sourceJournal.entries.some(
			(entry, index) => entry.idx !== index || !/^[A-Za-z0-9_-]+$/.test(entry.tag),
		) ||
		new Set(sourceJournal.entries.map((entry) => entry.tag)).size !== sourceJournal.entries.length
	)
		throw new Error("Expected a contiguous, unique SQLite migration journal");
	const sql = sourceJournal.entries.map((entry) =>
		readFileSync(join(source, `${entry.tag}.sql`), "utf8"),
	);
	const introductions = featureIntroductions.map((pattern) =>
		sql.findIndex((content) => pattern.test(content)),
	);
	if (introductions.some((index) => index <= 0))
		throw new Error("Expected an old migration prefix and all workspace feature introductions");
	// Branch history may introduce the two tables in separate increments; merged main
	// may introduce everything in one. Every old migration is preserved in either case.
	const entries = sourceJournal.entries.slice(0, Math.min(...introductions));
	const baseline: Journal = { ...sourceJournal, entries };
	const descriptor = {
		version: 1,
		sqlFiles: entries.map((entry) => ({
			name: `${entry.tag}.sql`,
			sha256: hash(join(source, `${entry.tag}.sql`)),
		})),
	};
	const targetJournal = join(target, "meta/_journal.json");
	const targetDescriptor = join(target, "baseline-descriptor.json");
	if (existsSync(target)) {
		if (!existsSync(targetJournal) || !existsSync(targetDescriptor))
			throw new Error("Existing incomplete baseline directory must not be overwritten");
		if (
			JSON.stringify(JSON.parse(readFileSync(targetJournal, "utf8"))) !== JSON.stringify(baseline)
		)
			throw new Error("Existing frozen baseline journal differs; refuse to overwrite it");
		if (
			JSON.stringify(JSON.parse(readFileSync(targetDescriptor, "utf8"))) !==
			JSON.stringify(descriptor)
		)
			throw new Error("Existing frozen baseline SQL hashes differ; refuse to overwrite it");
	} else {
		mkdirSync(join(target, "meta"), { recursive: true });
		for (const entry of entries)
			copyFileSync(
				join(source, `${entry.tag}.sql`),
				join(target, `${entry.tag}.sql`),
				constants.COPYFILE_EXCL,
			);
		// Only the ignored fixture journal is derived; no source DDL is rewritten.
		writeFileSync(targetJournal, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
		writeFileSync(targetDescriptor, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
	}
	for (const file of descriptor.sqlFiles) {
		if (
			hash(join(source, file.name)) !== file.sha256 ||
			hash(join(target, file.name)) !== file.sha256
		)
			throw new Error(`Frozen migration bytes differ: ${file.name}`);
	}
	return target;
}

if (import.meta.main) {
	const path = materializeWorkspaceMigrationBaseline();
	const descriptor = JSON.parse(readFileSync(join(path, "baseline-descriptor.json"), "utf8")) as {
		sqlFiles: Array<{ name: string; sha256: string }>;
	};
	console.log(
		JSON.stringify({
			path,
			entries: descriptor.sqlFiles.length,
			sqlHashesMatch: true,
			manifestSha256: hash(join(path, "baseline-descriptor.json")),
		}),
	);
}
