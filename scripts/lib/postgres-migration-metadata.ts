import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const CURRENT_SNAPSHOT = "current_snapshot.json";
export const HISTORY_FILE = "_snapshot_history.json";
export const PENDING_FILE = "_generation_pending.json";
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SQL_BYTES = 1024 * 1024;
const MAX_TOTAL_SQL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const JOURNAL_FILE = "_journal.json";
const ROOT_ID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type PgJournalEntry = {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
};
export type PgJournal = {
	version: string;
	dialect: "postgresql";
	entries: PgJournalEntry[];
};
export type PgSnapshot = {
	id: string;
	prevId: string;
	version: string;
	dialect: "postgresql";
	[key: string]: unknown;
};
export type PgHistoryEntry = {
	idx: number;
	tag: string;
	id: string;
	prevId: string;
	version: string;
	snapshotDigest: string;
};
export type PgHistory = { version: 1; entries: PgHistoryEntry[] };
export type PgMetadata = {
	mode: "legacy" | "baseline";
	journal: PgJournal;
	journalText: string;
	history: PgHistory;
	historyText: string;
	snapshot: PgSnapshot;
	snapshotText: string;
	files: Record<string, string>;
	legacySnapshots: string[];
};

export function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Offline tooling only. Never follow a final symlink or read a FIFO/device.
 * Bound the allocation AND read, and reject identity/content changes during reading. */
export function readBounded(path: string, max: number): string {
	if (!Number.isSafeInteger(max) || max < 0) throw new Error("Invalid byte limit");
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink())
		throw new Error(`Not a regular non-symlink file: ${path}`);
	if (before.size > max) throw new Error(`File exceeds ${max} bytes: ${path}`);
	const fd = openSync(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
	);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
			throw new Error(`File identity changed: ${path}`);
		if (opened.size > max) throw new Error(`File exceeds ${max} bytes: ${path}`);
		const bytes = Buffer.alloc(Math.min(max, opened.size) + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		const after = fstatSync(fd);
		const current = lstatSync(path);
		if (
			length > max ||
			length !== opened.size ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			current.isSymbolicLink() ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			current.size !== opened.size ||
			current.mtimeMs !== opened.mtimeMs ||
			current.ctimeMs !== opened.ctimeMs
		)
			throw new Error(`File changed or exceeded byte limit while reading: ${path}`);
		// Fatal decoding prevents a digest of replacement characters instead of file bytes.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes.subarray(0, length),
		);
	} finally {
		closeSync(fd);
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`Invalid ${label}: expected object`);
	return value as Record<string, unknown>;
}

function json(text: string, max: number, label: string): Record<string, unknown> {
	if (Buffer.byteLength(text) > max) throw new Error(`${label} exceeds ${max} bytes`);
	try {
		return record(JSON.parse(text), label);
	} catch (cause) {
		throw new Error(`Invalid ${label} JSON`, { cause });
	}
}

function entries(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || value.length > MAX_ENTRIES)
		throw new Error(`Invalid ${label} entries (maximum ${MAX_ENTRIES})`);
	return value;
}

function indexTag(entry: Record<string, unknown>, position: number): void {
	if (!Number.isSafeInteger(entry.idx) || entry.idx !== position)
		throw new Error(`Invalid idx at entry ${position}: must be contiguous from zero`);
	if (
		typeof entry.tag !== "string" ||
		entry.tag.length > 200 ||
		!/^\d{4}_[A-Za-z0-9_-]+$/.test(entry.tag) ||
		!entry.tag.startsWith(`${String(position).padStart(4, "0")}_`)
	)
		throw new Error(`Invalid or unsafe tag at entry ${position}`);
}

function identity(entry: Record<string, unknown>, label: string): void {
	if (
		typeof entry.id !== "string" ||
		!UUID.test(entry.id) ||
		entry.id === ROOT_ID ||
		typeof entry.prevId !== "string" ||
		!UUID.test(entry.prevId) ||
		entry.id === entry.prevId
	)
		throw new Error(`Invalid ${label} id/prevId`);
	if (entry.version !== "7") throw new Error(`Unsupported ${label} version`);
}

export function parseJournal(text: string): PgJournal {
	const journal = json(text, MAX_METADATA_BYTES, "journal");
	if (journal.version !== "7" || journal.dialect !== "postgresql")
		throw new Error("Unsupported journal version/dialect");
	const tags = new Set<string>();
	for (const [position, value] of entries(journal.entries, "journal").entries()) {
		const entry = record(value, "journal entry");
		indexTag(entry, position);
		if (
			entry.version !== journal.version ||
			!Number.isSafeInteger(entry.when) ||
			(entry.when as number) < 0 ||
			typeof entry.breakpoints !== "boolean" ||
			tags.has(entry.tag as string)
		)
			throw new Error(`Invalid journal entry ${position}`);
		tags.add(entry.tag as string);
	}
	return journal as PgJournal;
}

export function parseSnapshot(text: string): PgSnapshot {
	const snapshot = json(text, MAX_SNAPSHOT_BYTES, "snapshot");
	identity(snapshot, "snapshot");
	if (snapshot.dialect !== "postgresql") throw new Error("Unsupported snapshot dialect");
	return snapshot as PgSnapshot;
}

export function parseHistory(text: string): PgHistory {
	const history = json(text, MAX_METADATA_BYTES, "history");
	if (history.version !== 1) throw new Error("Unsupported history version");
	const ids = new Set<string>();
	const parents = new Set<string>();
	let previousId = ROOT_ID;
	for (const [position, value] of entries(history.entries, "history").entries()) {
		const entry = record(value, "history entry");
		indexTag(entry, position);
		identity(entry, "history entry");
		if (typeof entry.snapshotDigest !== "string" || !SHA256.test(entry.snapshotDigest))
			throw new Error(`Invalid snapshotDigest at entry ${position}`);
		if (ids.has(entry.id as string)) throw new Error(`Duplicate snapshot id at ${position}`);
		if (parents.has(entry.prevId as string)) throw new Error(`Snapshot parent fork at ${position}`);
		if (entry.prevId !== previousId) throw new Error(`Snapshot parent chain gap at ${position}`);
		ids.add(entry.id as string);
		parents.add(entry.prevId as string);
		previousId = entry.id as string;
		// A thin history must not silently become a second schema archive or SQL hash ledger.
		if (
			Object.keys(entry).some(
				(key) => !["idx", "tag", "id", "prevId", "version", "snapshotDigest"].includes(key),
			)
		)
			throw new Error(`Unexpected history entry property at ${position}`);
	}
	if (Object.keys(history).some((key) => key !== "version" && key !== "entries"))
		throw new Error("Unexpected history property");
	return history as PgHistory;
}

/** Digests bind the CURRENT schema bytes; old entries preserve lineage, not proof
 * against edits predating this operation. Published history needs a Git/release baseline. */
export function validateHistory(
	journal: PgJournal,
	history: PgHistory,
	snapshotText: string,
): void {
	// Validate object callers too, rather than trusting TypeScript's structural types.
	const checkedJournal = parseJournal(JSON.stringify(journal));
	const checkedHistory = parseHistory(JSON.stringify(history));
	const snapshot = parseSnapshot(snapshotText);
	if (
		checkedJournal.entries.length === 0 ||
		checkedJournal.entries.length !== checkedHistory.entries.length
	)
		throw new Error("Journal/history entry count mismatch or empty baseline");
	for (const [index, entry] of checkedJournal.entries.entries()) {
		const historic = checkedHistory.entries[index];
		if (
			historic.idx !== entry.idx ||
			historic.tag !== entry.tag ||
			historic.version !== entry.version
		)
			throw new Error(`Journal/history mismatch at entry ${index}`);
	}
	const latest = checkedHistory.entries[checkedHistory.entries.length - 1];
	if (
		latest.id !== snapshot.id ||
		latest.prevId !== snapshot.prevId ||
		latest.version !== snapshot.version ||
		latest.snapshotDigest !== digest(snapshotText)
	)
		throw new Error("Current snapshot identity/digest does not match latest history");
}

function directory(path: string) {
	// Normalize trailing '/' and '/.' so lstat cannot accidentally follow a final link.
	const stat = lstatSync(resolve(path));
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`Not a non-symlink directory: ${path}`);
	return stat;
}

function names(path: string, max: number): Set<string> {
	directory(path);
	const result = new Set<string>();
	const dir = opendirSync(path);
	try {
		for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
			if (result.size >= max) throw new Error(`Too many files in ${path}`);
			result.add(entry.name);
		}
	} finally {
		dir.closeSync();
	}
	return result;
}

export function readPgMetadata(
	folder: string,
	options: { allowLegacy?: boolean; allowPending?: boolean } = {},
): PgMetadata {
	const root = resolve(folder);
	const rootIdentity = directory(root);
	const rootNames = names(root, MAX_ENTRIES + 1);
	const meta = join(root, "meta");
	const metaIdentity = directory(meta);
	const metaNames = names(meta, MAX_ENTRIES + 4);
	const files: Record<string, string> = {};
	const read = (relative: string, max: number) => {
		const text = readBounded(join(root, relative), max);
		files[relative] = digest(text);
		return text;
	};
	const journalText = read(`meta/${JOURNAL_FILE}`, MAX_METADATA_BYTES);
	const journal = parseJournal(journalText);
	if (journal.entries.length === 0) throw new Error("Empty journal has no current schema baseline");
	const sqlNames = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
	for (const name of rootNames) {
		if (name !== "meta" && !sqlNames.has(name))
			throw new Error(`Unexpected or orphan migration file: ${name}`);
	}
	let sqlBytes = 0;
	for (const name of sqlNames) {
		if (!rootNames.has(name)) throw new Error(`Missing migration SQL: ${name}`);
		if (lstatSync(join(root, name)).size > MAX_TOTAL_SQL_BYTES - sqlBytes)
			throw new Error("SQL total exceeds 32 MiB");
		const text = read(name, Math.min(MAX_SQL_BYTES, MAX_TOTAL_SQL_BYTES - sqlBytes));
		sqlBytes += Buffer.byteLength(text);
		if (sqlBytes > MAX_TOTAL_SQL_BYTES) throw new Error("SQL total exceeds 32 MiB");
	}
	const hasCurrent = metaNames.has(CURRENT_SNAPSHOT);
	const hasHistory = metaNames.has(HISTORY_FILE);
	if (hasCurrent !== hasHistory)
		throw new Error("Incomplete baseline: current/history pair required");
	const mode = hasCurrent ? "baseline" : "legacy";
	if (mode === "legacy" && !options.allowLegacy)
		throw new Error("Legacy snapshots require allowLegacy");
	const legacySnapshots =
		mode === "legacy"
			? journal.entries.map((entry) => `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`)
			: [];
	const allowed = new Set([
		JOURNAL_FILE,
		...(mode === "baseline"
			? [CURRENT_SNAPSHOT, HISTORY_FILE]
			: legacySnapshots.map((s) => s.slice(5))),
	]);
	for (const name of metaNames) {
		if (name === "_generation.lock") {
			directory(join(meta, name));
			continue; // Do not traverse lock contents or follow any paths inside it.
		}
		if (name === PENDING_FILE) {
			if (!options.allowPending) throw new Error("Unfinished generation pending receipt exists");
			readBounded(join(meta, name), MAX_METADATA_BYTES);
			continue; // Receipt is transactional state, not part of the committed asset digest set.
		}
		if (!allowed.has(name)) throw new Error(`Unexpected or mixed-layout metadata file: ${name}`);
	}
	let snapshotText = "";
	let history: PgHistory;
	let historyText: string;
	if (mode === "baseline") {
		snapshotText = read(`meta/${CURRENT_SNAPSHOT}`, MAX_SNAPSHOT_BYTES);
		historyText = read(`meta/${HISTORY_FILE}`, MAX_METADATA_BYTES);
		history = parseHistory(historyText);
	} else {
		history = { version: 1, entries: [] };
		for (const [index, relative] of legacySnapshots.entries()) {
			if (!metaNames.has(relative.slice(5)))
				throw new Error(`Missing legacy snapshot: ${relative}`);
			snapshotText = read(relative, MAX_SNAPSHOT_BYTES);
			const snapshot = parseSnapshot(snapshotText);
			const entry = journal.entries[index];
			history.entries.push({
				idx: entry.idx,
				tag: entry.tag,
				id: snapshot.id,
				prevId: snapshot.prevId,
				version: snapshot.version,
				snapshotDigest: digest(snapshotText),
			});
		}
		historyText = JSON.stringify(history, null, 2);
		history = parseHistory(historyText);
	}
	validateHistory(journal, history, snapshotText);
	// Recheck directory identities after scanning; transaction callers additionally
	// compare the full returned digest map immediately before/after publishing.
	for (const [path, before] of [
		[root, rootIdentity],
		[meta, metaIdentity],
	] as const) {
		const after = directory(path);
		if (before.dev !== after.dev || before.ino !== after.ino)
			throw new Error(`Directory identity changed while reading: ${path}`);
	}
	return {
		mode,
		journal,
		journalText,
		history,
		historyText,
		snapshot: parseSnapshot(snapshotText),
		snapshotText,
		files,
		legacySnapshots,
	};
}
