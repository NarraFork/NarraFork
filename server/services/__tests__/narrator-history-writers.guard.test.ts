/**
 * narrator-history-writers.guard.test.ts — who may write a narrator's history tables.
 *
 * The model reads a conversation from three tables: `narrator_messages`,
 * `narrator_message_refs` and `narrator_tool_calls`. Producers of model-visible content
 * write them through `narrator-store.ts`, whose operations are one transaction each (a
 * tool_use with its ledger row, a result with its input). The storage underneath moves
 * to block tables in P1 (docs/BLOCK_STORAGE-DESIGN.md §11), which only stays a change
 * inside the store if nothing else writes these tables.
 *
 * Today other modules still write them directly: card state, mailbox receipts on refs,
 * permission and file-change bookkeeping on ledger rows, archive/import/cleanup jobs.
 * `DIRECT_WRITERS` is that list, frozen. It may only shrink:
 *   - a direct write in an unlisted file fails — route it through the store (or the
 *     persistence layer behind it) instead of adding the file here;
 *   - a listed file that no longer writes fails too — drop its entry, so the list keeps
 *     describing the work left.
 *
 * Creating ledger rows is narrower still (`LEDGER_ROW_CREATORS`): a tool call row exists
 * only together with the block or record that owns it.
 *
 * The scan is lexical over comment-stripped source: drizzle `.insert/.update/.delete` on
 * the three table objects and literal SQL statements on the three table names. Writes
 * composed from runtime strings are not seen; the list is a floor, not a proof.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

/** Files that write the history tables directly, and what they write. */
const DIRECT_WRITERS: Record<string, string> = {
	// The persistence layer behind narrator-store, and the message query/edit layer.
	"server/services/narrator-persistence.ts": "store implementation",
	"server/services/narrator-block-sync.ts": "block rows: ledger block binding, body bytes",
	"server/services/narrator-body-writes.ts": "envelope bodies, their rows built from them",
	"server/services/narrator-turns.ts": "the run's trigger envelope",
	"server/services/narrator-block-targets.ts":
		"materialize: flip an envelope to block format, the store syncs its rows",
	"server/services/narrator-block-backfill.ts":
		"legacy envelope conversion: format, bytes, ledger block",
	"server/services/narrator-messages.ts": "block deletion, truncation, card dismissal, COW",
	// Card state and envelope metadata.
	"server/routes/narrators.ts": "manual plan/compact cards and their state",
	"server/services/narrator-subagent-recovery.ts": "recovery card state and parent call result",
	"server/services/narrator-tree-snapshot-hooks.ts": "tree snapshot metadata",
	"server/lib/usage-tracking.ts": "message usage and cost",
	"server/services/user-deletion.ts": "author anonymization",
	// 整库快照导入必须按列交集直写历史表：它拷的是别人机器上的完整库，没有经过本进程的
	// store 事务，也不该经过——store 会重写 id、重建 refs，等于把快照改成当前库的内容。
	"server/services/data-portability.ts": "snapshot import: whole-table copy",
	// Mailbox receipts and publication on refs and messages.
	"server/services/agent-message-delivery.ts": "delivery receipt on refs",
	"server/services/agent-runtime/mailbox.ts": "delivery receipt on refs",
	"server/services/agent-runtime/postgres-runtime-queue.ts": "delivery receipt on refs (PG)",
	"server/services/agent-runtime/publication.ts": "run publication rows",
	"server/services/agent-runtime/postgres-runtime-publication.ts": "run publication (PG)",
	"server/services/parent-injection-queue.ts": "queued parent injection rows",
	// Ledger bookkeeping: permission, execution, file-change evidence.
	"server/lib/agent/tools/exit-plan-reflection.ts": "plan reflection verdict",
	"server/lib/agent/tools/task-reflection.ts": "task reflection verdict",
	"server/services/abandoned-tool-cleanup.ts": "abandoned call status",
	"server/services/agent-runtime/run.ts": "delivered call result",
	"server/services/file-change-evidence.ts": "file-change operation link",
	"server/services/file-change-runtime.ts": "file-change operation link",
	"server/services/postgres-file-change-evidence-store.ts": "file-change operation link (PG)",
	"server/services/narrator-permission.ts": "permission decisions",
	"server/services/narrator-plan-mode.ts": "plan-mode call state",
	"server/services/permission-rule-request-service.ts": "permission rule requests",
	"server/services/struct-sed-remote-change.ts": "remote change link",
	"server/services/tool-final-start-authorization.ts": "start authorization",
	"server/services/update-recovery-service.ts": "update recovery results",
	"server/websocket/narrator-ws.ts": "question answer receipt",
	// Session lifecycle, partial cleanup, refs and seq maintenance.
	"server/services/narrator-service.ts": "fork refs, ownership transfer, purge",
	"server/services/narrator-session.ts": "partial cleanup, interrupted calls",
	"server/services/narrator-refs-backfill.ts": "lazy fork ref backfill",
	"server/services/narrator-refs/seq-store.ts": "ref seq shifting",
	"server/services/subagent-extract.ts": "subagent extraction copy",
	// Bulk jobs: import, cleanup, migration, revision triggers.
	"server/services/session-interchange/import.ts": "session import",
	"server/services/database-cleanup-service.ts": "storage cleanup",
	"server/db/migrate-role-to-disp.ts": "one-off role migration",
	"server/services/agent-runtime/model-history-revision-sql.ts": "revision trigger SQL",
};

/** Files that may create ledger rows (`narrator_tool_calls` inserts). */
const LEDGER_ROW_CREATORS = new Set([
	"server/services/narrator-persistence.ts",
	"server/services/narrator-messages.ts",
	"server/services/session-interchange/import.ts",
]);

const TABLE_OBJECTS = "narratorMessages|narratorMessageRefs|narratorToolCalls";
const TABLE_NAMES = "narrator_messages|narrator_message_refs|narrator_tool_calls";
const WRITE = new RegExp(
	`\\.(?:insert|update|delete)\\(\\s*(?:${TABLE_OBJECTS})\\s*\\)|\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+(?:${TABLE_NAMES})\\b`,
	"g",
);
const LEDGER_INSERT =
	/\.insert\(\s*narratorToolCalls\s*\)|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+narrator_tool_calls\b/g;

function isExempt(path: string): boolean {
	return (
		path.includes("/__tests__/") ||
		/\.test\.tsx?$/.test(path) ||
		path.startsWith("server/scripts/") ||
		path.startsWith("server/generated/")
	);
}

/** Line comments and block comments out, string contents kept (SQL lives in strings). */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
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

function scan(pattern: RegExp): Map<string, number[]> {
	const hits = new Map<string, number[]>();
	for (const file of sourceFiles(join(ROOT, "server"))) {
		const path = relative(ROOT, file).split(sep).join("/");
		if (isExempt(path)) continue;
		const code = stripComments(readFileSync(file, "utf8"));
		const lines: number[] = [];
		for (const match of code.matchAll(pattern))
			lines.push(code.slice(0, match.index).split("\n").length);
		if (lines.length) hits.set(path, lines);
	}
	return hits;
}

describe("narrator history writers", () => {
	const writers = scan(WRITE);

	test("no new module writes the history tables directly", () => {
		const unregistered = [...writers]
			.filter(([path]) => !(path in DIRECT_WRITERS))
			.map(([path, lines]) => `${path}:${lines.join(",")}`);
		expect(unregistered, "write through narrator-store instead").toEqual([]);
	});

	test("every listed direct writer still writes (the list only shrinks)", () => {
		const stale = Object.keys(DIRECT_WRITERS).filter((path) => !writers.has(path));
		expect(stale, "drop these entries from DIRECT_WRITERS").toEqual([]);
	});

	test("ledger rows are only created with what owns them", () => {
		const creators = [...scan(LEDGER_INSERT).keys()].filter(
			(path) => !LEDGER_ROW_CREATORS.has(path),
		);
		expect(creators).toEqual([]);
	});

	test("the event stream's producer writes only through the store", () => {
		expect(writers.has("server/services/narrator-event-handler.ts")).toBe(false);
		expect(writers.has("server/services/narrator-injection.ts")).toBe(false);
	});

	test("the scan sees drizzle and literal SQL writes but not reads or other tables", () => {
		const probe = (text: string) => [...stripComments(text).matchAll(WRITE)].length;
		expect(probe("db.update(narratorToolCalls).set({})")).toBe(1);
		expect(probe("tx.insert( narratorMessages ).values(row)")).toBe(1);
		expect(probe('sqlite.run("DELETE FROM narrator_message_refs WHERE id = ?")')).toBe(1);
		expect(probe("INSERT OR IGNORE INTO narrator_messages (id) VALUES (?)")).toBe(1);
		expect(probe("db.select().from(narratorMessages)")).toBe(0);
		expect(probe("UPDATE narrator_messages_fts SET x = 1")).toBe(0);
		expect(probe("// db.update(narratorMessages)")).toBe(0);
	});
});
