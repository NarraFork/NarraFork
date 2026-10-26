/**
 * Offline check: which spec files lost their GFM tables to a Spec-panel save (design doc D24).
 *
 * The old WYSIWYG spec editor dropped every table when it loaded a file, so the first save from
 * the panel wrote the file back without them. Nothing is lost for good: each save inserts a new
 * `spec_file_revisions` row whose `parent_revision_id` points at the previous one. This lists the
 * saves where the user (`created_by = 'user'`, the Spec panel's PUT route) wrote a revision with no
 * table delimiter row while its parent revision had one, so a person can restore the parent.
 *
 * It only reads: the database is opened read-only with `query_only` on, scanned page by page,
 * and nothing is written back. Not wired into the server; run it by hand:
 *
 *   bun scripts/find-spec-table-loss.ts [path/to/narrafork.db] [--page-size N] [--json]
 *
 * The default path is ~/.narrafork/narrafork.db. SQLite only.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_DATABASE_PATH = join(homedir(), ".narrafork", "narrafork.db");
export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;

/** tasks.json is written by the task board, never by the markdown editor. */
const TASKS_PATH = "tasks.json";

const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

/**
 * A GFM table delimiter row such as `| --- | :-: |` or `--|--`, also when indented (lists) or
 * quoted. It must contain a pipe: a dash line without one is a thematic break or a setext
 * underline, not a table.
 */
export function isGfmTableDelimiterRow(line: string): boolean {
	let row = line.replace(/^[ \t>]*/, "").trimEnd();
	if (!row.includes("|")) return false;
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|")) row = row.slice(0, -1);
	return row.split("|").every((cell) => DELIMITER_CELL.test(cell));
}

export function hasGfmTableDelimiterRow(text: string): boolean {
	return text.split(/\r?\n/).some(isGfmTableDelimiterRow);
}

export interface SpecTableLossFinding {
	path: string;
	namespaceId: string;
	narratorId: string | null;
	narratorTitle: string | null;
	/** The revision that still has the table: restore from this one. */
	before: { revisionId: string; createdAt: string; createdBy: string };
	/** The user's save that no longer has it. */
	after: { revisionId: string; createdAt: string };
}

export interface SpecTableLossReport {
	findings: SpecTableLossFinding[];
	/** User saves examined (non-tasks files whose parent revision contains a pipe). */
	checked: number;
}

interface CandidateRow {
	cursor: number;
	id: string;
	namespaceId: string;
	path: string;
	createdAt: string;
	content: string;
	parentId: string;
	parentCreatedAt: string;
	parentCreatedBy: string;
	parentContent: string;
	narratorId: string | null;
	narratorTitle: string | null;
}

/** Open an existing database strictly read-only; never creates or migrates anything. */
export function openDatabaseReadOnly(path: string): Database {
	const resolved = resolve(path);
	if (!existsSync(resolved)) throw new Error(`Database not found: ${resolved}`);
	const db = new Database(resolved, { readonly: true, create: false });
	db.exec("PRAGMA query_only = ON");
	return db;
}

/** Scan every user save page by page (rowid cursor + LIMIT); memory stays bounded per page. */
export function scanSpecTableLoss(
	db: Database,
	options: { pageSize?: number } = {},
): SpecTableLossReport {
	const pageSize = Math.min(
		Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE)),
		MAX_PAGE_SIZE,
	);
	const table = db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_file_revisions'")
		.get();
	if (!table) throw new Error("No spec_file_revisions table: not a NarraFork database?");
	const page = db.query<CandidateRow, [number, string, number]>(
		`SELECT c.rowid AS cursor, c.id AS id, c.namespace_id AS namespaceId, c.path AS path,
			c.created_at AS createdAt, c.content AS content,
			p.id AS parentId, p.created_at AS parentCreatedAt, p.created_by AS parentCreatedBy,
			p.content AS parentContent,
			ns.narrator_id AS narratorId, n.title AS narratorTitle
		FROM spec_file_revisions c
		JOIN spec_file_revisions p ON p.id = c.parent_revision_id
		LEFT JOIN spec_namespaces ns ON ns.id = c.namespace_id
		LEFT JOIN narrators n ON n.id = ns.narrator_id
		WHERE c.rowid > ?1 AND c.created_by = 'user' AND c.path <> ?2
			AND instr(p.content, '|') > 0
		ORDER BY c.rowid
		LIMIT ?3`,
	);
	const findings: SpecTableLossFinding[] = [];
	let checked = 0;
	let cursor = 0;
	for (;;) {
		const rows = page.all(cursor, TASKS_PATH, pageSize);
		for (const row of rows) {
			checked++;
			if (hasGfmTableDelimiterRow(row.content) || !hasGfmTableDelimiterRow(row.parentContent)) {
				continue;
			}
			findings.push({
				path: row.path,
				namespaceId: row.namespaceId,
				narratorId: row.narratorId,
				narratorTitle: row.narratorTitle,
				before: {
					revisionId: row.parentId,
					createdAt: row.parentCreatedAt,
					createdBy: row.parentCreatedBy,
				},
				after: { revisionId: row.id, createdAt: row.createdAt },
			});
		}
		if (rows.length < pageSize) break;
		cursor = rows[rows.length - 1]?.cursor ?? cursor;
	}
	return { findings, checked };
}

export function formatSpecTableLossReport(
	report: SpecTableLossReport,
	databasePath: string,
): string {
	const lines = [
		`Checked ${report.checked} Spec-panel saves whose previous revision contains a pipe, in ${databasePath}.`,
		report.findings.length === 0
			? "No save dropped a GFM table."
			: `${report.findings.length} save(s) dropped every GFM table the previous revision had. ` +
				"Restore from the 'before' revision if the deletion was not intended:",
	];
	for (const finding of report.findings) {
		const narrator = finding.narratorId
			? `narrator ${finding.narratorId}${finding.narratorTitle ? ` "${finding.narratorTitle}"` : ""}`
			: "narrator (unknown)";
		lines.push(
			"",
			`- spec://${finding.path}  ${narrator}, namespace ${finding.namespaceId}`,
			`  before: ${finding.before.revisionId}  ${finding.before.createdAt}  (${finding.before.createdBy})`,
			`  after:  ${finding.after.revisionId}  ${finding.after.createdAt}  (user)`,
		);
	}
	return lines.join("\n");
}

export function parseArgs(argv: string[]): {
	databasePath: string;
	pageSize: number;
	json: boolean;
} {
	let databasePath = DEFAULT_DATABASE_PATH;
	let pageSize = DEFAULT_PAGE_SIZE;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--json") json = true;
		else if (arg === "--page-size") {
			pageSize = Number(argv[++i]);
			if (!Number.isInteger(pageSize) || pageSize < 1)
				throw new Error("--page-size must be a positive integer");
		} else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
		else databasePath = arg;
	}
	return { databasePath: resolve(databasePath), pageSize, json };
}

if (import.meta.main) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const db = openDatabaseReadOnly(args.databasePath);
		try {
			const report = scanSpecTableLoss(db, { pageSize: args.pageSize });
			console.log(
				args.json
					? JSON.stringify(report, null, 2)
					: formatSpecTableLossReport(report, args.databasePath),
			);
		} finally {
			db.close();
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
