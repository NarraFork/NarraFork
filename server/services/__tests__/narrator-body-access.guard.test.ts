/**
 * narrator-body-access.guard.test.ts — who reads or writes an envelope's body through
 * `content_json` (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3a).
 *
 * A block-format envelope's body is its block rows; `content_json` is a projection of them
 * that P3b stops writing. So nothing may take the column as the body except the body
 * layer itself:
 *   - reads go through `narrator-body-reads.ts` (`contentJsonSql`, `bodyColumns`,
 *     `fillBodies`), or `narrator-bodies.ts` off the main thread;
 *   - read-modify-writes start from `readEnvelope` / `readEnvelopeBody` and write through
 *     `insertEnvelope` / `writeEnvelopeBody` (`narrator-body-writes.ts`), which build the
 *     rows from the body handed over instead of reading the column back.
 *
 * `RAW_BODY_ACCESS` counts what each file still does to the column directly: the body
 * layer; readers where the column is the body (legacy envelopes, PG, the block read switch
 * off); and writes whose rows the sync queue builds from the column. The counts only go
 * down:
 *   - a raw access in an unlisted file, or more than its count, fails — read and write
 *     through the body layer instead;
 *   - fewer than its count fails too — lower it (drop the entry at zero).
 *
 * The scan is lexical over comment-stripped source: the column named in SQL
 * (`content_json`) or in Drizzle (`narratorMessages.contentJson`); whole-row reads
 * (`select().from(narratorMessages)`, `getTableColumns(narratorMessages)`, relational
 * `narratorMessages.findFirst/findMany` without `bodyColumns` or a `columns` list leaving
 * the body out, a bare `.returning()`); and body writes (every envelope insert, an update
 * whose `set` names `contentJson` or is not an object literal). A floor, not a proof.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** Raw body accesses per file, and why they are there. */
const RAW_BODY_ACCESS: Record<string, { count: number; why: string }> = {
	// The body layer.
	"server/services/narrator-body-writes.ts": { count: 6, why: "body writes" },
	"server/services/narrator-block-sync.ts": {
		count: 4,
		why: "the dual-write audit, column resync, the queued sync's column hash",
	},
	"server/lib/narrator-bodies.ts": { count: 6, why: "body reads off the main thread" },
	"server/services/narrator-body-reads.ts": { count: 1, why: "envelope row size" },
	"server/services/narrator-block-scans.ts": { count: 5, why: "scans: column fallback" },
	"server/services/narrator-block-targets.ts": { count: 2, why: "legacy envelopes' ids" },
	"server/services/narrator-block-backfill.ts": {
		count: 5,
		why: "legacy envelope conversion, projection clear/restore",
	},
	"server/lib/db-worker/block-backfill-query.ts": {
		count: 4,
		why: "legacy envelope conversion, verify, projection clear",
	},
	// The column itself: schema, triggers, settings text.
	"server/db/schema.ts": { count: 4, why: "column, compact_pending" },
	"server/db/postgres-schema.ts": { count: 8, why: "PG: the column is the body" },
	"server/services/agent-runtime/model-history-revision-sql.ts": { count: 3, why: "triggers" },
	"server/services/agent-runtime/model-history-fixture.ts": { count: 1, why: "trigger fixture" },
	"server/lib/settings/defaults.ts": { count: 5, why: "switch descriptions" },
	"server/db/test-role-migration.ts": { count: 4, why: "one-off role migration check" },
	// Readers whose column branch serves block reads off (or PG), where it is the body.
	"server/services/narrator-question-service.ts": { count: 3, why: "read switch off" },
	"server/services/storage-service.ts": { count: 2, why: "read switch off" },
	"server/services/narrator-export.ts": { count: 1, why: "read switch off" },
	"server/services/session-interchange/export.ts": { count: 1, why: "read switch off" },
	"server/services/narrator-epochs.ts": { count: 1, why: "read switch off" },
	"server/services/agent-runtime/publication.ts": { count: 1, why: "column fallback" },
	// Writes whose rows the sync queue builds from the column (`insertEnvelopeQueued`'s
	// contract): a legacy-format import, and the revert program's prepared statements, which
	// apply without reads or JSON work and so cannot sync inline.
	"server/services/session-interchange/import.ts": { count: 1, why: "legacy-format import" },
	"server/services/revert-history-commit.ts": { count: 3, why: "prepared row rewrite/copy" },
};

function isExempt(path: string): boolean {
	return (
		path.includes("/__tests__/") ||
		/\.test\.tsx?$/.test(path) ||
		path.startsWith("server/scripts/") ||
		path.startsWith("server/generated/")
	);
}

/**
 * Line comments and block comments out (their line breaks kept, so reported lines match
 * the file), string contents kept (SQL lives in strings).
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** The text between the parenthesis at `open` and the one closing it. */
function callArgs(code: string, open: number): string {
	let depth = 0;
	for (let index = open; index < code.length; index++) {
		if (code[index] === "(") depth++;
		else if (code[index] === ")" && --depth === 0) return code.slice(open + 1, index);
	}
	return "";
}

/** The statement starting at `from`: up to its `;` or the next blank line. */
function statement(code: string, from: number): string {
	const rest = code.slice(from);
	const end = rest.search(/;|\n\s*\n/);
	return end < 0 ? rest : rest.slice(0, end);
}

type Access = { kind: string; at: number };

export function rawBodyAccesses(code: string): Access[] {
	const found: Access[] = [];
	const add = (
		kind: string,
		pattern: RegExp,
		keep: (match: RegExpExecArray) => boolean = () => true,
	) => {
		for (const match of code.matchAll(pattern))
			if (keep(match as RegExpExecArray)) found.push({ kind, at: match.index ?? 0 });
	};
	const argsOf = (match: RegExpExecArray) =>
		callArgs(code, (match.index ?? 0) + match[0].length - 1);
	add("column in SQL", /\bcontent_json\b/g);
	add("column in Drizzle", /\bnarratorMessages\.contentJson\b/g);
	add("whole-row read", /\.select\(\s*\)\s*\.from\(\s*narratorMessages\s*\)/g);
	add("whole-row read", /\bgetTableColumns\(\s*narratorMessages\s*\)/g);
	add("whole-row read", /\bnarratorMessages\s*\.find(?:First|Many)\(/g, (match) => {
		const args = argsOf(match);
		return (
			!args.includes("bodyColumns(") &&
			(!/\bcolumns\s*:/.test(args) || /\bcontentJson\s*:\s*true/.test(args))
		);
	});
	add("whole-row returning", /\.(?:insert|update)\(\s*narratorMessages\s*\)/g, (match) =>
		/\.returning\(\s*\)/.test(statement(code, match.index ?? 0)),
	);
	add("body insert", /\.insert\(\s*narratorMessages\s*\)/g);
	add("body update", /\.update\(\s*narratorMessages\s*\)\s*\.set\(/g, (match) => {
		const args = argsOf(match).trim();
		return !args.startsWith("{") || /\bcontentJson\b/.test(args);
	});
	return found;
}

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
		else if (/\.tsx?$/.test(entry)) files.push(path);
	}
	return files;
}

function scan(): Map<string, string[]> {
	const hits = new Map<string, string[]>();
	for (const file of sourceFiles(join(ROOT, "server"))) {
		const path = relative(ROOT, file).split(sep).join("/");
		if (isExempt(path)) continue;
		const code = stripComments(readFileSync(file, "utf8"));
		const accesses = rawBodyAccesses(code);
		if (accesses.length)
			hits.set(
				path,
				accesses.map((access) => `${access.kind}@${code.slice(0, access.at).split("\n").length}`),
			);
	}
	return hits;
}

describe("raw access to an envelope's body", () => {
	const hits = scan();

	test("no file reads or writes the column as the body beyond its count", () => {
		const over = [...hits]
			.filter(([path, found]) => found.length > (RAW_BODY_ACCESS[path]?.count ?? 0))
			.map(([path, found]) => `${path} (${found.length}): ${found.join(", ")}`);
		expect(over, "read and write through narrator-body-reads/-writes instead").toEqual([]);
	});

	test("every count is current (the list only shrinks)", () => {
		const stale = Object.entries(RAW_BODY_ACCESS)
			.filter(([path, entry]) => (hits.get(path)?.length ?? 0) < entry.count)
			.map(([path, entry]) => `${path}: ${hits.get(path)?.length ?? 0} < ${entry.count}`);
		expect(stale, "lower these counts (drop an entry at zero)").toEqual([]);
	});

	test("the scan sees the column, whole-row reads and body writes, not other columns", () => {
		const kinds = (text: string) => rawBodyAccesses(stripComments(text)).map((hit) => hit.kind);
		expect(kinds("SELECT content_json FROM narrator_messages")).toEqual(["column in SQL"]);
		expect(kinds("SELECT original_content_json FROM narrator_messages")).toEqual([]);
		expect(kinds("db.select({ c: narratorMessages.contentJson })")).toEqual(["column in Drizzle"]);
		expect(kinds("tx.select().from(narratorMessages).all()")).toEqual(["whole-row read"]);
		expect(kinds("db.query.narratorMessages.findFirst({ where })")).toEqual(["whole-row read"]);
		expect(kinds("db.query.narratorMessages.findFirst({ ...bodyColumns(), where })")).toEqual([]);
		expect(
			kinds("db.query.narratorMessages.findFirst({ columns: { id: true, role: true } })"),
		).toEqual([]);
		expect(kinds("tx.update(narratorMessages).set({ status: 1 }).where(w).run();")).toEqual([]);
		expect(kinds("tx.update(narratorMessages).set({ contentJson: c }).run();")).toEqual([
			"body update",
		]);
		expect(kinds("tx.update(narratorMessages).set(overrides).run();")).toEqual(["body update"]);
		expect(kinds("tx.insert(narratorMessages).values(v).returning().get();")).toEqual([
			"whole-row returning",
			"body insert",
		]);
		expect(kinds("// tx.insert(narratorMessages)")).toEqual([]);
	});
});
