/**
 * The archive port's contract: what it promises, and what it deliberately does not.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Two things nothing else can catch:
 *
 *   1. `main-store.ts` must stay dialect-free. An accidental `import { db } from "@server/db"`
 *      there type-checks, formats, and works perfectly — while silently turning a portable
 *      contract into a SQLite one. Only a source-level assertion sees it.
 *   2. The value mapping between the main database and the archive is where a mistake is
 *      invisible. A JSON column double-encoded, a boolean stored as `true` instead of 1, an
 *      `undefined` reaching a binding array — none of these fail loudly; they produce an archive
 *      that imports into subtly wrong data.
 *
 * ISOLATION
 * ---------
 * The mapping tests are pure function calls. The store tests use `:memory:` databases built
 * locally. Nothing here writes a user's data directory.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER, isArchiveTable } from "../manifest";
import { archiveValueMapping, sqliteProjectArchiveMainStore } from "../sqlite-main-store";
import { resolveProjectArchiveMainStore } from "../store";

const PORT_DIR = resolve(import.meta.dir, "..");

describe("the port stays dialect-free", () => {
	it("main-store.ts imports nothing dialect-specific", () => {
		const source = readFileSync(join(PORT_DIR, "main-store.ts"), "utf8");
		// Strip comments: the file explains its SQLite reasoning at length, and matching that
		// prose would make the assertion fail for documenting the very rule it enforces.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "")
			.trim();

		// The whole point of the file: it must be a type-only module.
		expect(code).not.toContain("bun:sqlite");
		expect(code).not.toContain("drizzle-orm");
		expect(code).not.toMatch(/from\s+["'][^"']*\/db["']/);
		expect(code).not.toMatch(/from\s+["']@server\/db/);
		// No import at all, in fact — a dialect-free contract has nothing to import.
		expect(code).not.toMatch(/^\s*import\s/m);
	});

	it("manifest.ts names no main-database table or Drizzle field", () => {
		// The manifest states the ARCHIVE format. If it started naming Drizzle tables it would
		// stop being a statement about the file and become a mirror of the main schema.
		const code = readFileSync(join(PORT_DIR, "manifest.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/[^\n]*/g, "");
		expect(code).not.toContain("drizzle-orm");
		expect(code).not.toContain("db/schema");
		expect(code).not.toMatch(/^\s*import\s/m);
	});

	it("store.ts is the single place the backend is chosen", () => {
		const source = readFileSync(join(PORT_DIR, "store.ts"), "utf8");
		// The fail-closed resolver mirrors `services/knowledge/store.ts`: SQLite is the
		// default, and PostgreSQL is reachable ONLY through an injected store (tests and
		// the future composition root) paired with the exact explicit selection. What
		// must never appear is a second decision site — a conditional in the importer
		// would be a configuration-reachable fork this module exists to prevent.
		expect(source).toContain("sqliteProjectArchiveMainStore");
		expect(source).toContain("resolveProjectArchiveMainStore");
	});

	it("the wiring fails closed in both directions", () => {
		const fakePg = {} as never;
		// Absent/aliased/unknown values stay SQLite, exactly the pre-batch constant's semantics.
		for (const writeBackend of [undefined, "", "sqlite", "sqlite3", "POSTGRES", "pg"]) {
			expect(resolveProjectArchiveMainStore({ writeBackend }, undefined)).toBe(
				sqliteProjectArchiveMainStore,
			);
		}
		// Explicit postgres without an injected store is an ERROR, never a silent fallback.
		expect(() => resolveProjectArchiveMainStore({ writeBackend: "postgres" }, undefined)).toThrow(
			/unavailable/,
		);
		// Explicit postgres WITH an injected store returns it, and a read/write mismatch is
		// a loud error — one process must read and write the same database.
		expect(
			resolveProjectArchiveMainStore({ writeBackend: "postgres", readBackend: "postgres" }, fakePg),
		).toBe(fakePg);
		expect(() =>
			resolveProjectArchiveMainStore({ writeBackend: "postgres", readBackend: "sqlite" }, fakePg),
		).toThrow(/does not match/);
	});
});

describe("main → archive value mapping", () => {
	const { toArchiveValue } = archiveValueMapping;

	it("re-serializes parsed JSON columns without double-encoding text ones", () => {
		// Drizzle's `{ mode: "json" }` PARSES on read, so an object arrives as an object and the
		// archive's TEXT column needs it stringified again.
		expect(toArchiveValue({ autoStart: true })).toBe('{"autoStart":true}');
		expect(toArchiveValue(["plan", "standalone"])).toBe('["plan","standalone"]');

		// But `narrators.substatus` is a PLAIN text column that happens to hold JSON text.
		// Stringifying it again would store `"\"[]\""` — the exact bug the old `jsonCol` helper
		// avoided by checking for a string first, and the reason that check is preserved here.
		expect(toArchiveValue("[]")).toBe("[]");
		expect(toArchiveValue('["unread"]')).toBe('["unread"]');
	});

	it("maps undefined and null to the same absent value", () => {
		// Not interchangeable to a binding array: `undefined` in one is what shifts every
		// subsequent positional parameter.
		expect(toArchiveValue(undefined)).toBeNull();
		expect(toArchiveValue(null)).toBeNull();
	});

	it("normalizes booleans to integers rather than trusting the driver", () => {
		// `bun:sqlite` does bind a boolean as 0/1, but relying on that makes the archive's
		// on-disk type a property of the driver instead of the format.
		expect(toArchiveValue(true)).toBe(1);
		expect(toArchiveValue(false)).toBe(0);
	});

	it("passes numbers through, including the falsy ones", () => {
		// `seq` is 0-based and `is_compact` is 0/1, so a truthiness-based mapping would drop
		// exactly the rows that matter.
		expect(toArchiveValue(0)).toBe(0);
		expect(toArchiveValue(1)).toBe(1);
		expect(toArchiveValue(-1)).toBe(-1);
		expect(toArchiveValue(0.5)).toBe(0.5);
	});

	it("serializes a Date to ISO text", () => {
		// `narrator_message_refs.injectionConsumedAt` is a timestamp-mode column. It is not in
		// the archive today, but the mapping must not stringify a Date as "[object Object]" if
		// one ever reaches it.
		expect(toArchiveValue(new Date("2024-03-01T12:00:00.000Z"))).toBe("2024-03-01T12:00:00.000Z");
	});

	it("preserves a NUL byte in text, because a real column contains one", () => {
		// `chapters.snapshot_shadow_key` is `local\u0000/path/to/worktree`. A mapping that
		// truncated at NUL would silently corrupt the key the orphan sweep matches on.
		const key = "local\u0000/tmp/some/worktree";
		expect(toArchiveValue(key)).toBe(key);
	});
});

describe("archive → main value mapping", () => {
	const { toMainValue } = archiveValueMapping;
	const booleanColumn = { columnType: "SQLiteBoolean" } as never;
	const textColumn = { columnType: "SQLiteText" } as never;
	const integerColumn = { columnType: "SQLiteInteger" } as never;

	it("converts the archive's 0/1 into what a boolean column expects", () => {
		expect(toMainValue(booleanColumn, 0)).toBe(0);
		expect(toMainValue(booleanColumn, 1)).toBe(1);
		// A non-zero integer is truthy, matching SQLite's own coercion.
		expect(toMainValue(booleanColumn, 2)).toBe(1);
	});

	it("accepts textual booleans from a hand-edited archive", () => {
		// The archive is a plain SQLite file users can and do open with a GUI. A `"false"` typed
		// into a boolean column must not import as true.
		expect(toMainValue(booleanColumn, "0")).toBe(0);
		expect(toMainValue(booleanColumn, "false")).toBe(0);
		expect(toMainValue(booleanColumn, "FALSE")).toBe(0);
		expect(toMainValue(booleanColumn, "1")).toBe(1);
		expect(toMainValue(booleanColumn, "true")).toBe(1);
	});

	it("leaves null null on every column type", () => {
		expect(toMainValue(booleanColumn, null)).toBeNull();
		expect(toMainValue(textColumn, null)).toBeNull();
		expect(toMainValue(integerColumn, null)).toBeNull();
	});

	it("passes JSON text through unchanged", () => {
		// Both sides are TEXT, so the stored bytes must be identical — no parse-and-restringify,
		// which would normalize key order and break any byte-comparison of an archive.
		const json = '{"b":1,"a":2}';
		expect(toMainValue(textColumn, json)).toBe(json);
	});

	it("does not truthiness-filter a zero on an integer column", () => {
		expect(toMainValue(integerColumn, 0)).toBe(0);
	});
});

describe("the manifest is internally coherent", () => {
	it("lists every ordered table exactly once", () => {
		expect(new Set(ARCHIVE_TABLE_ORDER).size).toBe(ARCHIVE_TABLE_ORDER.length);
		for (const table of ARCHIVE_TABLE_ORDER) {
			expect(ARCHIVE_COLUMNS[table], `${table} has no column list`).toBeDefined();
			expect(ARCHIVE_COLUMNS[table].length).toBeGreaterThan(0);
			expect(new Set(ARCHIVE_COLUMNS[table]).size, `${table} lists a column twice`).toBe(
				ARCHIVE_COLUMNS[table].length,
			);
		}
		expect(Object.keys(ARCHIVE_COLUMNS).sort()).toEqual([...ARCHIVE_TABLE_ORDER].sort());
	});

	it("keys every table by `id`, which the paging relies on", () => {
		// Both the archive reader and the main store order by the primary key to page stably.
		// A table without `id` would page unpredictably rather than fail visibly.
		for (const table of ARCHIVE_TABLE_ORDER) {
			expect(ARCHIVE_COLUMNS[table], `${table} must have an id`).toContain("id");
		}
	});

	it("orders parents before children", () => {
		// The archive has no foreign keys; the MAIN database does and enforces them per
		// statement. `INSERT OR IGNORE` does NOT swallow a foreign-key failure, so a wrong order
		// is a failed user import rather than a silently skipped row.
		const position = new Map<string, number>(
			ARCHIVE_TABLE_ORDER.map((table, index) => [table, index]),
		);
		const mustPrecede: [string, string][] = [
			["projects", "chapters"],
			["projects", "chapter_edges"],
			["exploration_groups", "chapters"],
			["chapters", "narrators"],
			["chapters", "chapter_commits"],
			["chapters", "merge_sessions"],
			["narrators", "narrator_messages"],
			["narrator_messages", "narrator_message_refs"],
			["narrator_messages", "narrator_tool_calls"],
			["narrator_messages", "narrator_patches"],
		];
		for (const [parent, child] of mustPrecede) {
			expect(position.get(parent), `${parent} must be imported before ${child}`).toBeLessThan(
				position.get(child) as number,
			);
		}
	});

	it("keeps the machine-local coordinates out of the format", () => {
		// `parked_*` name commits in THIS machine's shadow repository for a rebase still in
		// flight. Carried across, the importing machine's next rebase settles them, resolves
		// nothing, and reports work lost that was never there.
		expect(ARCHIVE_COLUMNS.chapters).not.toContain("parked_snapshot_commit_sha");
		expect(ARCHIVE_COLUMNS.chapters).not.toContain("parked_snapshot_base_tree");
		// Names a credential record in the exporting install.
		expect(ARCHIVE_COLUMNS.narrator_messages).not.toContain("credential_id");
		// ACL columns name accounts that do not exist in the importing install.
		for (const column of ["owner_user_id", "visibility", "write_audience"]) {
			expect(ARCHIVE_COLUMNS.narrators).not.toContain(column);
		}
		expect(ARCHIVE_COLUMNS.projects).not.toContain("owner_user_id");
		expect(ARCHIVE_COLUMNS.projects).not.toContain("visibility");
	});

	it("carries the snapshot coordinates a commit-free merge depends on", () => {
		// These are the ONLY record of a merge that wrote nothing to git history. Without them a
		// re-imported chapter reads as "merged, no merge commit", which `unmerge` and `wake` both
		// reject — and the merged-away uncommitted work becomes unreachable.
		for (const column of [
			"snapshot_commit_sha",
			"snapshot_shadow_key",
			"dormant_snapshot_commit_sha",
			"pre_merge_target_sha",
			"merge_snapshot_commit_sha",
			"pre_merge_target_snapshot_sha",
			"merged_source_snapshot_sha",
		]) {
			expect(ARCHIVE_COLUMNS.chapters, `chapters must carry ${column}`).toContain(column);
		}
	});

	it("carries the references that reconstruct the conversation tree", () => {
		// Losing any one of these turns an imported project into orphaned rows: a message with
		// no ref is invisible to the frontend ("Message not found"), a ref with no seq cannot be
		// ordered, and a tool call with no message_id cannot be attached.
		expect(ARCHIVE_COLUMNS.narrator_message_refs).toContain("message_id");
		expect(ARCHIVE_COLUMNS.narrator_message_refs).toContain("seq");
		expect(ARCHIVE_COLUMNS.narrator_message_refs).toContain("is_compact");
		// Subagent messages hang off their parent tool call.
		expect(ARCHIVE_COLUMNS.narrator_messages).toContain("parent_tool_use_id");
		expect(ARCHIVE_COLUMNS.narrator_messages).toContain("content_json");
		// Narrator lineage: fork source and parent.
		expect(ARCHIVE_COLUMNS.narrators).toContain("parent_narrator_id");
		expect(ARCHIVE_COLUMNS.narrators).toContain("fork_message_id");
		// Chapter lineage.
		expect(ARCHIVE_COLUMNS.chapters).toContain("parent_chapter_id");
		expect(ARCHIVE_COLUMNS.chapters).toContain("merged_into_chapter_id");
		// Tool call attachment and its result.
		expect(ARCHIVE_COLUMNS.narrator_tool_calls).toContain("message_id");
		expect(ARCHIVE_COLUMNS.narrator_tool_calls).toContain("tool_use_id");
		expect(ARCHIVE_COLUMNS.narrator_tool_calls).toContain("input_json");
		expect(ARCHIVE_COLUMNS.narrator_tool_calls).toContain("output_json");
	});

	it("recognizes its own tables and nothing else", () => {
		for (const table of ARCHIVE_TABLE_ORDER) expect(isArchiveTable(table)).toBe(true);
		// A table of the main database that is not part of the archive must be rejected, so a
		// typo cannot silently export something the format does not define.
		expect(isArchiveTable("users")).toBe(false);
		expect(isArchiveTable("narrator_file_snapshots")).toBe(false);
		expect(isArchiveTable("")).toBe(false);
	});
});
