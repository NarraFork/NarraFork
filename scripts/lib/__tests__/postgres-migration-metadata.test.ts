import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURRENT_SNAPSHOT,
	digest,
	HISTORY_FILE,
	MAX_SNAPSHOT_BYTES,
	PENDING_FILE,
	type PgHistory,
	type PgJournal,
	type PgSnapshot,
	parseHistory,
	parseJournal,
	parseSnapshot,
	readBounded,
	readPgMetadata,
	validateHistory,
} from "../postgres-migration-metadata";

const ROOT_ID = "00000000-0000-0000-0000-000000000000";
const MiB = 1024 * 1024;
const owned: string[] = [];
const id = (idx: number) => `12345678-abcd-1234-abcd-${String(idx + 1).padStart(12, "0")}`;
const tag = (idx: number) => `${String(idx).padStart(4, "0")}_migration_${idx}`;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

afterEach(() => {
	for (const folder of owned.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temp(): string {
	const folder = mkdtempSync(join(tmpdir(), "nf-pg-metadata-owned-"));
	owned.push(folder);
	return folder;
}

function fixture(mode: "legacy" | "baseline" = "baseline", count = 3) {
	const folder = temp();
	const meta = join(folder, "meta");
	mkdirSync(meta);
	const journal: PgJournal = { version: "7", dialect: "postgresql", entries: [] };
	const history: PgHistory = { version: 1, entries: [] };
	const snapshots: PgSnapshot[] = [];
	const texts: string[] = [];
	for (let idx = 0; idx < count; idx++) {
		journal.entries.push({
			idx,
			version: "7",
			when: 1700000000000 + idx,
			tag: tag(idx),
			breakpoints: true,
		});
		const snapshot: PgSnapshot = {
			id: id(idx),
			prevId: idx === 0 ? ROOT_ID : id(idx - 1),
			version: "7",
			dialect: "postgresql",
			tables: { [`public.table_${idx}`]: { name: `table_${idx}`, columns: {} } },
			_meta: { columns: {}, schemas: {}, tables: {} },
			futureSchemaAttribute: { retained: "中文" },
		};
		const text = `${pretty(snapshot)}\n`;
		snapshots.push(snapshot);
		texts.push(text);
		history.entries.push({
			idx,
			tag: tag(idx),
			id: snapshot.id,
			prevId: snapshot.prevId,
			version: "7",
			snapshotDigest: digest(text),
		});
		writeFileSync(join(folder, `${tag(idx)}.sql`), `-- 中文 custom SQL ${idx}\nSELECT ${idx};\n`);
		if (mode === "legacy")
			writeFileSync(join(meta, `${String(idx).padStart(4, "0")}_snapshot.json`), text);
	}
	writeFileSync(join(meta, "_journal.json"), `${pretty(journal)}\n`);
	if (mode === "baseline") {
		writeFileSync(join(meta, CURRENT_SNAPSHOT), texts[texts.length - 1]);
		writeFileSync(join(meta, HISTORY_FILE), `${pretty(history)}\n`);
	}
	return { folder, meta, journal, history, snapshots, texts };
}

function sparse(path: string, size: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, size);
	} finally {
		closeSync(fd);
	}
}

describe("bounded filesystem reads", () => {
	test("SHA-256 accepts strings and bytes and binds exact original UTF-8", () => {
		const value = "中文\r\n";
		const expected = createHash("sha256").update(value).digest("hex");
		expect(digest(value)).toBe(expected);
		expect(digest(Buffer.from(value))).toBe(expected);
		expect(digest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	test("reads at byte limit, preserves BOM/CRLF, and supports empty files", () => {
		const path = join(temp(), "bounded.txt");
		const content = "\uFEFF中文\r\n";
		writeFileSync(path, content);
		expect(readBounded(path, Buffer.byteLength(content))).toBe(content);
		expect(() => readBounded(path, content.length)).toThrow("exceeds");
		writeFileSync(path, "");
		expect(readBounded(path, 0)).toBe("");
	});

	test.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid byte limit %s", (max) => {
		const path = join(temp(), "file");
		writeFileSync(path, "a");
		expect(() => readBounded(path, max)).toThrow("Invalid byte limit");
	});

	test("rejects symlink, directory, invalid UTF-8, and oversized regular file", () => {
		const folder = temp();
		const path = join(folder, "file");
		writeFileSync(path, "test");
		symlinkSync(path, join(folder, "link"));
		expect(() => readBounded(join(folder, "link"), MiB)).toThrow("non-symlink");
		expect(() => readBounded(folder, MiB)).toThrow("regular");
		expect(() => readBounded(path, 3)).toThrow("exceeds");
		writeFileSync(path, Buffer.from([0xff]));
		expect(() => readBounded(path, MiB)).toThrow();
	});

	test.skipIf(process.platform === "win32")("rejects FIFO without blocking", () => {
		const path = join(temp(), "fifo");
		const result = spawnSync("mkfifo", [path], { timeout: 2000 });
		expect(result.status).toBe(0);
		expect(() => readBounded(path, MiB)).toThrow("regular");
	});
});

describe("strict parsers and lineage", () => {
	test("retains unknown schema attributes without storing them in thin history", () => {
		const f = fixture();
		const snapshot = parseSnapshot(f.texts[2]);
		expect(snapshot.futureSchemaAttribute).toEqual({ retained: "中文" });
		expect(parseJournal(pretty(f.journal))).toEqual(f.journal);
		expect(parseHistory(pretty(f.history))).toEqual(f.history);
		expect(() => validateHistory(f.journal, f.history, f.texts[2])).not.toThrow();
		expect(pretty(f.history)).not.toContain("tables");
		expect(pretty(f.history)).not.toContain("sqlDigest");
	});

	test.each(["{", "null", "[]", "true"])("rejects malformed/nonobject JSON %s", (text) => {
		expect(() => parseJournal(text)).toThrow();
		expect(() => parseSnapshot(text)).toThrow();
		expect(() => parseHistory(text)).toThrow();
	});

	test.each(["6", "8", 7, undefined])("rejects unsupported snapshot version %s", (version) => {
		const f = fixture();
		expect(() => parseSnapshot(pretty({ ...f.snapshots[2], version }))).toThrow("version");
	});

	test.each(["sqlite", "mysql", undefined])("rejects unsupported dialect %s", (dialect) => {
		const f = fixture();
		expect(() => parseSnapshot(pretty({ ...f.snapshots[2], dialect }))).toThrow("dialect");
		expect(() => parseJournal(pretty({ ...f.journal, dialect }))).toThrow("dialect");
	});

	test.each([
		"../outside",
		"0000_../outside",
		"0000_a/b",
		"0000_a\\b",
		"0000_",
		"0000_雪",
		"0001_a",
	])("rejects unsafe/misnumbered migration tag %s", (unsafeTag) => {
		const f = fixture();
		f.journal.entries[0].tag = unsafeTag;
		expect(() => parseJournal(pretty(f.journal))).toThrow("tag");
		f.history.entries[0].tag = unsafeTag;
		expect(() => parseHistory(pretty(f.history))).toThrow("tag");
	});

	test.each([
		-1,
		1,
		0.25,
		"0",
		null,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid migration idx %s", (idx) => {
		const f = fixture();
		const journal = { ...f.journal, entries: [{ ...f.journal.entries[0], idx }] };
		expect(() => parseJournal(pretty(journal))).toThrow("idx");
	});

	test("rejects idx gap, duplicate tag, invalid timestamp, and invalid breakpoint flag", () => {
		const f = fixture();
		for (const change of [
			{ idx: 4 },
			{ tag: f.journal.entries[0].tag },
			{ when: -1 },
			{ when: 0.5 },
			{ breakpoints: "true" },
			{ version: "6" },
		]) {
			const journal = structuredClone(f.journal);
			Object.assign(journal.entries[1], change);
			expect(() => parseJournal(pretty(journal))).toThrow();
		}
	});

	test.each(["bad", ROOT_ID, undefined])("rejects invalid snapshot id %s", (badId) => {
		const f = fixture();
		expect(() => parseSnapshot(pretty({ ...f.snapshots[2], id: badId }))).toThrow("id");
	});

	test("rejects malformed parent id and self-reference", () => {
		const f = fixture();
		expect(() => parseSnapshot(pretty({ ...f.snapshots[2], prevId: "bad" }))).toThrow("id");
		expect(() => parseSnapshot(pretty({ ...f.snapshots[2], prevId: id(2) }))).toThrow("id");
	});

	test("rejects duplicate IDs, parent fork, missing parent, and non-root first parent", () => {
		const f = fixture();
		const duplicate = structuredClone(f.history);
		duplicate.entries[2].id = id(0);
		expect(() => parseHistory(pretty(duplicate))).toThrow("Duplicate");
		const fork = structuredClone(f.history);
		fork.entries[2].prevId = id(0);
		expect(() => parseHistory(pretty(fork))).toThrow("fork");
		const gap = structuredClone(f.history);
		gap.entries[2].prevId = id(99);
		expect(() => parseHistory(pretty(gap))).toThrow("gap");
		const root = structuredClone(f.history);
		root.entries[0].prevId = id(99);
		expect(() => parseHistory(pretty(root))).toThrow("gap");
	});

	test("rejects malformed digest and schema/SQL hash properties in thin history", () => {
		const f = fixture();
		const invalidDigest = structuredClone(f.history);
		invalidDigest.entries[0].snapshotDigest = "bad";
		expect(() => parseHistory(pretty(invalidDigest))).toThrow("snapshotDigest");
		for (const property of ["tables", "sqlDigest"]) {
			const thick = structuredClone(f.history);
			Object.assign(thick.entries[0], { [property]: {} });
			expect(() => parseHistory(pretty(thick))).toThrow("Unexpected");
		}
		expect(() => parseHistory(pretty({ ...f.history, tables: {} }))).toThrow("Unexpected");
		expect(() => parseHistory(pretty({ ...f.history, version: 2 }))).toThrow("version");
	});

	test("rejects journal/history count, tag, and latest snapshot identity/digest mismatch", () => {
		const f = fixture();
		const short = { ...f.history, entries: f.history.entries.slice(0, 2) };
		expect(() => validateHistory(f.journal, short, f.texts[2])).toThrow("count");
		const retagged = structuredClone(f.history);
		retagged.entries[1].tag = "0001_other";
		expect(() => validateHistory(f.journal, retagged, f.texts[2])).toThrow("mismatch");
		expect(() => validateHistory(f.journal, f.history, f.texts[1])).toThrow("identity/digest");
		expect(() => validateHistory(f.journal, f.history, `${f.texts[2]} `)).toThrow(
			"identity/digest",
		);
		const modified = pretty({ ...f.snapshots[2], futureSchemaAttribute: "changed" });
		expect(() => validateHistory(f.journal, f.history, modified)).toThrow("identity/digest");
	});

	test("old snapshot SHA does not claim proof against prior edits", () => {
		const f = fixture();
		f.history.entries[0].snapshotDigest = "a".repeat(64);
		expect(() => validateHistory(f.journal, f.history, f.texts[2])).not.toThrow();
	});

	test("parsers apply byte/entry limits even to direct in-memory inputs", () => {
		expect(() => parseJournal(" ".repeat(MiB + 1))).toThrow("exceeds");
		expect(() => parseHistory(" ".repeat(MiB + 1))).toThrow("exceeds");
		expect(() => parseSnapshot(" ".repeat(MAX_SNAPSHOT_BYTES + 1))).toThrow("exceeds");
		const journal = {
			version: "7",
			dialect: "postgresql",
			entries: Array.from({ length: 4097 }, (_, idx) => ({
				idx,
				tag: tag(idx),
				version: "7",
				when: 0,
				breakpoints: true,
			})),
		};
		expect(() => parseJournal(JSON.stringify(journal))).toThrow("4096");
	});
});

describe("legacy and single-baseline layouts", () => {
	test("loads legacy only explicitly, preserves last bytes, and generates pretty thin history", () => {
		const f = fixture("legacy");
		expect(() => readPgMetadata(f.folder)).toThrow("allowLegacy");
		const result = readPgMetadata(f.folder, { allowLegacy: true });
		expect(result.mode).toBe("legacy");
		expect(result.history).toEqual(f.history);
		expect(result.historyText).toBe(pretty(f.history));
		expect(result.snapshotText).toBe(f.texts[2]);
		expect(result.snapshot).toEqual(f.snapshots[2]);
		expect(result.legacySnapshots).toEqual([
			"meta/0000_snapshot.json",
			"meta/0001_snapshot.json",
			"meta/0002_snapshot.json",
		]);
		expect(Object.keys(result.files)).toHaveLength(7);
		expect(result.files[`meta/${HISTORY_FILE}`]).toBeUndefined();
		for (const [relative, hash] of Object.entries(result.files))
			expect(hash).toBe(digest(readFileSync(join(f.folder, relative))));
		expect(readdirSync(f.meta)).toHaveLength(4); // Reading never converts the formal folder.
	});

	test("loads fixed baseline idempotently without changing any file bytes", () => {
		const f = fixture();
		const result = readPgMetadata(f.folder);
		expect(result.mode).toBe("baseline");
		expect(result.history).toEqual(f.history);
		expect(result.legacySnapshots).toEqual([]);
		expect(Object.keys(result.files)).toHaveLength(6);
		expect(result.journalText).toBe(`${pretty(f.journal)}\n`);
		expect(result.historyText).toBe(`${pretty(f.history)}\n`);
		expect(result.files[`meta/${CURRENT_SNAPSHOT}`]).toBe(digest(f.texts[2]));
		expect(readPgMetadata(f.folder)).toEqual(result);
	});

	test("SQL may be edited before release; returned map detects this operation's change", () => {
		const f = fixture();
		const before = readPgMetadata(f.folder);
		writeFileSync(join(f.folder, `${tag(2)}.sql`), "-- filled custom SQL\nSELECT 123;\n");
		const after = readPgMetadata(f.folder);
		expect(after.history).toEqual(before.history);
		expect(after.files[`${tag(2)}.sql`]).not.toBe(before.files[`${tag(2)}.sql`]);
	});

	test.each(["meta", "root"])("rejects %s symlink", (location) => {
		const f = fixture();
		if (location === "root") {
			const linked = join(temp(), "linked-folder");
			symlinkSync(f.folder, linked, "dir");
			for (const suffix of ["", "/", "/."])
				expect(() => readPgMetadata(`${linked}${suffix}`)).toThrow("non-symlink directory");
		} else {
			renameSync(f.meta, join(f.folder, "real-meta"));
			symlinkSync(join(f.folder, "real-meta"), f.meta, "dir");
			expect(() => readPgMetadata(f.folder)).toThrow("non-symlink directory");
		}
	});

	test.each([
		"meta/_journal.json",
		`meta/${CURRENT_SNAPSHOT}`,
		`meta/${HISTORY_FILE}`,
		`${tag(0)}.sql`,
	])("rejects asset symlink %s", (relative) => {
		const f = fixture();
		const path = join(f.folder, relative);
		const other = join(temp(), "actual-file");
		writeFileSync(other, readFileSync(path));
		unlinkSync(path);
		symlinkSync(other, path);
		expect(() => readPgMetadata(f.folder)).toThrow("non-symlink");
	});

	test.each([CURRENT_SNAPSHOT, HISTORY_FILE])("rejects incomplete baseline missing %s", (name) => {
		const f = fixture();
		unlinkSync(join(f.meta, name));
		expect(() => readPgMetadata(f.folder, { allowLegacy: true })).toThrow("Incomplete baseline");
	});

	test.each([
		"0002_snapshot.json",
		"9999_snapshot.json",
		"other.json",
		"nested",
	])("rejects extra/mixed snapshot or unfamiliar metadata %s", (name) => {
		const f = fixture();
		writeFileSync(join(f.meta, name), "{}");
		expect(() => readPgMetadata(f.folder, { allowLegacy: true })).toThrow("Unexpected");
	});

	test("rejects legacy extra/missing snapshots and wrong snapshot lineage", () => {
		const extra = fixture("legacy");
		writeFileSync(join(extra.meta, "0003_snapshot.json"), extra.texts[2]);
		expect(() => readPgMetadata(extra.folder, { allowLegacy: true })).toThrow("Unexpected");
		const missing = fixture("legacy");
		unlinkSync(join(missing.meta, "0001_snapshot.json"));
		expect(() => readPgMetadata(missing.folder, { allowLegacy: true })).toThrow("Missing legacy");
		const invalid = fixture("legacy");
		writeFileSync(
			join(invalid.meta, "0002_snapshot.json"),
			pretty({ ...invalid.snapshots[2], prevId: id(99) }),
		);
		expect(() => readPgMetadata(invalid.folder, { allowLegacy: true })).toThrow("gap");
	});

	test.each(["9999_orphan.sql", "notes.txt"])("rejects orphan/unfamiliar root file %s", (name) => {
		const f = fixture();
		writeFileSync(join(f.folder, name), "SELECT 1;");
		expect(() => readPgMetadata(f.folder)).toThrow("Unexpected or orphan");
	});

	test("rejects missing SQL and snapshot latest SHA mismatch", () => {
		const missing = fixture();
		unlinkSync(join(missing.folder, `${tag(1)}.sql`));
		expect(() => readPgMetadata(missing.folder)).toThrow("Missing migration SQL");
		const tampered = fixture();
		writeFileSync(join(tampered.meta, CURRENT_SNAPSHOT), pretty(tampered.snapshots[2]));
		expect(() => readPgMetadata(tampered.folder)).toThrow("identity/digest");
	});

	test("rejects pending by default, allows bounded ordinary receipt explicitly", () => {
		const f = fixture();
		const baseline = readPgMetadata(f.folder);
		const pending = join(f.meta, PENDING_FILE);
		writeFileSync(pending, '{"version":1}');
		expect(() => readPgMetadata(f.folder)).toThrow("pending");
		expect(readPgMetadata(f.folder, { allowPending: true })).toEqual(baseline);
		sparse(pending, MiB + 1);
		expect(() => readPgMetadata(f.folder, { allowPending: true })).toThrow("exceeds");
		unlinkSync(pending);
		symlinkSync(join(f.meta, HISTORY_FILE), pending);
		expect(() => readPgMetadata(f.folder, { allowPending: true })).toThrow("non-symlink");
	});

	test("does not traverse generation lock contents but rejects symlink/non-directory locks", () => {
		const f = fixture();
		const lock = join(f.meta, "_generation.lock");
		const baseline = readPgMetadata(f.folder);
		mkdirSync(lock);
		symlinkSync(join(f.folder, "does-not-exist"), join(lock, "unread-foreign-link"));
		expect(readPgMetadata(f.folder)).toEqual(baseline);
		rmSync(lock, { recursive: true });
		writeFileSync(lock, "not a directory");
		expect(() => readPgMetadata(f.folder)).toThrow("directory");
		unlinkSync(lock);
		symlinkSync(temp(), lock, "dir");
		expect(() => readPgMetadata(f.folder)).toThrow("non-symlink directory");
	});

	test.each([
		["meta/_journal.json", MiB],
		[`meta/${HISTORY_FILE}`, MiB],
		[`meta/${CURRENT_SNAPSHOT}`, MAX_SNAPSHOT_BYTES],
		[`${tag(0)}.sql`, MiB],
	] as const)("enforces individual file cap for %s", (relative, limit) => {
		const f = fixture();
		sparse(join(f.folder, relative), limit + 1);
		expect(() => readPgMetadata(f.folder)).toThrow("exceeds");
	});

	test("enforces aggregate SQL 32 MiB without lowering per-file limit", () => {
		const f = fixture("baseline", 33);
		for (const entry of f.journal.entries) sparse(join(f.folder, `${entry.tag}.sql`), MiB);
		expect(() => readPgMetadata(f.folder)).toThrow("SQL total exceeds 32 MiB");
	});

	test("limits directory enumeration even when unfamiliar files dominate", () => {
		const f = fixture();
		for (let i = 0; i < 4098; i++) writeFileSync(join(f.folder, `extra-${i}`), "");
		expect(() => readPgMetadata(f.folder)).toThrow("Too many files");
	});

	test("empty metadata cannot pretend to have a current schema", () => {
		const f = fixture("legacy", 0);
		expect(parseJournal(pretty(f.journal)).entries).toEqual([]);
		expect(() => readPgMetadata(f.folder, { allowLegacy: true })).toThrow("Empty journal");
	});

	test("supports folder names containing spaces", () => {
		const f = fixture();
		const renamed = join(temp(), "migration folder with spaces");
		renameSync(f.folder, renamed);
		expect(readPgMetadata(renamed).snapshotText).toBe(f.texts[2]);
	});
});
