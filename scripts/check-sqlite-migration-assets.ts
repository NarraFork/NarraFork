import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_SQL_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 128;

interface JournalEntry {
	idx: number;
	tag: string;
	when: number;
	breakpoints: boolean;
}

export interface SqliteAssetSummary {
	migrations: number;
	snapshots: number;
	bytes: number;
}

function assertNoLegacyContent(value: string, location: string): void {
	if (/kiro/i.test(value)) throw new Error(`${location}: forbidden legacy content`);
}

function checkJsonContent(value: unknown, location: string, depth = 0): void {
	if (depth > MAX_JSON_DEPTH) throw new Error(`${location}: JSON nesting exceeds limit`);
	if (typeof value === "string") {
		assertNoLegacyContent(value, location);
	} else if (Array.isArray(value)) {
		for (const child of value) checkJsonContent(child, location, depth + 1);
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			assertNoLegacyContent(key, location);
			checkJsonContent(child, location, depth + 1);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJournal(value: unknown): JournalEntry[] {
	if (
		!isRecord(value) ||
		value.dialect !== "sqlite" ||
		typeof value.version !== "string" ||
		!Array.isArray(value.entries) ||
		value.entries.length === 0 ||
		value.entries.length > MAX_FILES
	) {
		throw new Error("meta/_journal.json: invalid SQLite journal");
	}
	const tags = new Set<string>();
	return value.entries.map((entry, index) => {
		if (
			!isRecord(entry) ||
			entry.idx !== index ||
			typeof entry.tag !== "string" ||
			entry.tag.length > 128 ||
			!/^\d{4,}_[\p{L}\p{N}_-]+$/u.test(entry.tag) ||
			Number.parseInt(entry.tag, 10) !== index ||
			tags.has(entry.tag) ||
			typeof entry.when !== "number" ||
			!Number.isSafeInteger(entry.when) ||
			entry.when < 0 ||
			typeof entry.breakpoints !== "boolean"
		) {
			throw new Error(`meta/_journal.json: invalid migration entry ${index}`);
		}
		tags.add(entry.tag);
		return entry as unknown as JournalEntry;
	});
}

/** Read-only CLI check. Published migration SQL and snapshots are never rewritten. */
export async function checkSqliteMigrationAssets(
	directory = resolve(import.meta.dir, "..", "drizzle"),
): Promise<SqliteAssetSummary> {
	let bytes = 0;
	const readAsset = async (relativePath: string, maxBytes: number): Promise<string> => {
		assertNoLegacyContent(relativePath, relativePath);
		const path = join(directory, relativePath);
		const info = await lstat(path);
		if (!info.isFile()) throw new Error(`${relativePath}: asset must be a regular file`);
		if (info.size > maxBytes) throw new Error(`${relativePath}: asset exceeds size limit`);
		bytes += info.size;
		if (bytes > MAX_TOTAL_BYTES) throw new Error("SQLite assets exceed total size limit");
		const source = await readFile(path, "utf8");
		assertNoLegacyContent(source, relativePath);
		return source;
	};
	const readJson = async (relativePath: string, maxBytes = MAX_JSON_BYTES): Promise<unknown> => {
		const source = await readAsset(relativePath, maxBytes);
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			throw new Error(`${relativePath}: invalid JSON`);
		}
		checkJsonContent(value, relativePath);
		return value;
	};
	const entries = parseJournal(await readJson("meta/_journal.json", MAX_JOURNAL_BYTES));
	const sqlNames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
	const snapshotNames = (await readdir(join(directory, "meta")))
		.filter((name) => name.endsWith("_snapshot.json"))
		.sort();
	if (sqlNames.length + snapshotNames.length > MAX_FILES) {
		throw new Error("SQLite asset file count exceeds limit");
	}
	const expectedSql = new Set(entries.map((entry) => `${entry.tag}.sql`));
	for (const name of sqlNames) {
		assertNoLegacyContent(name, name);
		if (!expectedSql.delete(name)) throw new Error(`${name}: SQL is not in the journal`);
		const source = await readAsset(name, MAX_SQL_BYTES);
		if (!source.trim()) throw new Error(`${name}: empty migration SQL`);
	}
	if (expectedSql.size) throw new Error(`Missing migration SQL: ${[...expectedSql][0]}`);
	const latest = entries[entries.length - 1];
	const latestSnapshot = `${String(latest.idx).padStart(4, "0")}_snapshot.json`;
	if (!snapshotNames.includes(latestSnapshot)) {
		throw new Error(`Missing latest snapshot: meta/${latestSnapshot}`);
	}
	// Custom migrations may have no snapshot; do not invent historical snapshots for them.
	for (const name of snapshotNames) {
		assertNoLegacyContent(name, name);
		if (!/^\d{4,}_snapshot\.json$/.test(name) || Number.parseInt(name, 10) > latest.idx) {
			throw new Error(`meta/${name}: snapshot has no journal entry`);
		}
		const snapshot = await readJson(`meta/${name}`);
		if (!isRecord(snapshot) || snapshot.dialect !== "sqlite") {
			throw new Error(`meta/${name}: invalid SQLite snapshot`);
		}
	}
	return { migrations: entries.length, snapshots: snapshotNames.length, bytes };
}

if (import.meta.main) {
	try {
		const summary = await checkSqliteMigrationAssets();
		console.log(
			`SQLite assets: ${summary.migrations} migrations, ${summary.snapshots} snapshots, ${summary.bytes} bytes; no forbidden legacy content`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "SQLite asset validation failed");
		process.exitCode = 1;
	}
}
