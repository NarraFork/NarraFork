/**
 * Where the swallowed-content scan keeps what it found (outline P2 PR 12c): the tables
 * `outline_spec_loss_findings` (one row per place) and `outline_spec_loss_scans` (one row per
 * session looked at), and the reads of Dynamic Spec revisions the scan needs.
 *
 * Every statement is one SQL text both dialects run, through the outline access executor
 * (`access-reads.ts`), bounded and indexed: findings by primary key, or a page of one status on
 * `idx_outline_spec_loss_findings_status` / `_narrator` (`limit + 1`, never with the excerpt);
 * counts per status capped; a revision's ancestors by primary key, a hundred a statement, with
 * the LENGTH of each only. Nothing here writes Dynamic Spec or the outline.
 */
import type {
	OutlineSpecLossFinding,
	OutlineSpecLossKind,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import { OUTLINE_SPEC_LOSS_STATUSES } from "@shared/outline-spec-import";
import { isSpecLossKind, type SpecLossExcerptPart } from "@shared/spec-content-loss";
import { sql } from "drizzle-orm";
import { runOutlineAccessQuery } from "../access-reads";

export const SPEC_LOSS_STORE_LIMITS = {
	/** Findings one page of a list reads. */
	page: 50,
	/** Findings of one status counted at most (more reads as "1000+"). */
	countCap: 1000,
	/** Ancestors of a revision one statement reads. */
	chainPage: 100,
} as const;

type Row = Record<string, unknown>;

function str(row: Row, column: string): string | null {
	const value = row[column];
	return value === null || value === undefined ? null : String(value);
}

function num(row: Row, column: string): number {
	const n = Number(row[column] ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export function isSpecLossStatus(value: unknown): value is OutlineSpecLossStatus {
	return (OUTLINE_SPEC_LOSS_STATUSES as readonly unknown[]).includes(value);
}

function kindsOf(value: string | null): Partial<Record<OutlineSpecLossKind, number>> {
	const out: Partial<Record<OutlineSpecLossKind, number>> = {};
	if (!value) return out;
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object")
			for (const [kind, n] of Object.entries(parsed as Record<string, unknown>))
				if (isSpecLossKind(kind) && typeof n === "number" && n > 0) out[kind] = n;
	} catch {
		// Unreadable: no kinds shown.
	}
	return out;
}

/** A stored excerpt as its parts; unreadable JSON reads as nothing. */
export function specLossExcerptParts(value: string | null): SpecLossExcerptPart[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(part): part is SpecLossExcerptPart =>
				part !== null &&
				typeof part === "object" &&
				isSpecLossKind((part as SpecLossExcerptPart).kind) &&
				typeof (part as SpecLossExcerptPart).text === "string",
		);
	} catch {
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Spec revisions (read only)
// ─────────────────────────────────────────────────────────────────────────────

/** A revision without its content. */
export interface SpecRevisionMeta {
	id: string;
	parentRevisionId: string | null;
	createdBy: string;
	createdAt: string | null;
	/** Characters of its content. */
	chars: number;
}

/**
 * `revisionId` and up to {@link SPEC_LOSS_STORE_LIMITS.chainPage} - 1 revisions before it along
 * `parent_revision_id`, newest first. A fork's file points into its parent's revisions, so the
 * chain is followed across namespaces. Empty when the revision is gone.
 */
export async function readSpecRevisionChain(revisionId: string): Promise<SpecRevisionMeta[]> {
	const limit = SPEC_LOSS_STORE_LIMITS.chainPage;
	const rows = await runOutlineAccessQuery(sql`
		with recursive chain (id, parent_revision_id, created_by, created_at, chars, depth) as (
			select r.id, r.parent_revision_id, r.created_by, r.created_at, length(r.content), 0
			from spec_file_revisions r where r.id = ${revisionId}
			union all
			select p.id, p.parent_revision_id, p.created_by, p.created_at, length(p.content),
				c.depth + 1
			from spec_file_revisions p join chain c on p.id = c.parent_revision_id
			where c.depth < ${limit - 1}
		)
		select id, parent_revision_id, created_by, created_at, chars, depth
		from chain order by depth limit ${limit}
	`);
	return rows.map((row) => ({
		id: String(row.id),
		parentRevisionId: str(row, "parent_revision_id"),
		createdBy: str(row, "created_by") ?? "",
		createdAt: str(row, "created_at"),
		chars: num(row, "chars"),
	}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scans
// ─────────────────────────────────────────────────────────────────────────────

/** Why a scan did not look at everything. */
export type SpecLossScanNote = "budget" | "files" | "findings";

export interface SpecLossScanRow {
	narratorId: string;
	sourceKey: string;
	saves: number;
	findings: number;
	note: SpecLossScanNote | null;
	scannedAt: string;
}

export async function readSpecLossScan(narratorId: string): Promise<SpecLossScanRow | null> {
	const rows = await runOutlineAccessQuery(sql`
		select narrator_id, source_key, saves, findings, note, scanned_at
		from outline_spec_loss_scans where narrator_id = ${narratorId} limit 1
	`);
	const row = rows[0];
	if (!row) return null;
	const note = str(row, "note");
	return {
		narratorId: String(row.narrator_id),
		sourceKey: str(row, "source_key") ?? "",
		saves: num(row, "saves"),
		findings: num(row, "findings"),
		note: note === "budget" || note === "files" || note === "findings" ? note : null,
		scannedAt: str(row, "scanned_at") ?? "",
	};
}

export async function writeSpecLossScan(row: SpecLossScanRow): Promise<void> {
	await runOutlineAccessQuery(sql`
		insert into outline_spec_loss_scans (narrator_id, source_key, saves, findings, note, scanned_at)
		values (${row.narratorId}, ${row.sourceKey}, ${row.saves}, ${row.findings}, ${row.note},
			${row.scannedAt})
		on conflict (narrator_id) do update set
			source_key = excluded.source_key, saves = excluded.saves, findings = excluded.findings,
			note = excluded.note, scanned_at = excluded.scanned_at
	`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

/** A finding as the scan records it. */
export interface NewSpecLossFinding {
	id: string;
	narratorId: string;
	path: string;
	beforeRevisionId: string;
	afterRevisionId: string;
	beforeAt: string | null;
	savedAt: string | null;
	kinds: Partial<Record<OutlineSpecLossKind, number>>;
	items: number;
	parts: SpecLossExcerptPart[];
	truncated: boolean;
}

/**
 * Record a finding unless it is recorded already (its id follows from the session, the path and
 * the revision before the save): what a person decided about it is never touched. True when the
 * row is new.
 */
export async function insertSpecLossFinding(finding: NewSpecLossFinding): Promise<boolean> {
	const now = new Date().toISOString();
	const rows = await runOutlineAccessQuery(sql`
		insert into outline_spec_loss_findings (
			id, narrator_id, path, before_revision_id, after_revision_id, before_at, saved_at,
			kinds, items, excerpt, truncated, status, created_at, updated_at
		) values (
			${finding.id}, ${finding.narratorId}, ${finding.path}, ${finding.beforeRevisionId},
			${finding.afterRevisionId}, ${finding.beforeAt}, ${finding.savedAt},
			${JSON.stringify(finding.kinds)}, ${finding.items}, ${JSON.stringify(finding.parts)},
			${finding.truncated ? 1 : 0}, 'open', ${now}, ${now}
		)
		on conflict (id) do nothing
		returning id
	`);
	return rows.length > 0;
}

/** A finding's row, without its excerpt unless asked for. */
export interface SpecLossFindingRow extends OutlineSpecLossFinding {
	beforeRevisionId: string;
	afterRevisionId: string;
	resolvedBy: string | null;
	/** The session's task backend now. */
	taskBackend: string | null;
	ownerUserId: string | null;
	/** Only with `withExcerpt`. */
	parts: SpecLossExcerptPart[];
}

const LIST_COLUMNS = sql`
	f.id, f.narrator_id, f.path, f.before_revision_id, f.after_revision_id, f.saved_at, f.kinds,
	f.truncated, f.status, f.block_id, f.resolved_by, f.resolved_at, f.created_at,
	n.title, n.task_backend, n.owner_user_id,
	(select sp.id from outline_spaces sp
		where sp.narrator_id = f.narrator_id and sp.kind = 'session' limit 1) as space_id
`;

function findingOf(row: Row): SpecLossFindingRow {
	const status = str(row, "status");
	const taskBackend = str(row, "task_backend");
	const open = status === "open";
	return {
		id: String(row.id),
		narratorId: String(row.narrator_id),
		title: str(row, "title"),
		path: str(row, "path") ?? "",
		savedAt: str(row, "saved_at"),
		kinds: kindsOf(str(row, "kinds")),
		truncated: num(row, "truncated") !== 0,
		status: isSpecLossStatus(status) ? status : "open",
		blockId: str(row, "block_id"),
		spaceId: str(row, "space_id"),
		resolvedAt: str(row, "resolved_at"),
		createdAt: str(row, "created_at") ?? "",
		attachable: open && taskBackend === "outline",
		beforeRevisionId: str(row, "before_revision_id") ?? "",
		afterRevisionId: str(row, "after_revision_id") ?? "",
		resolvedBy: str(row, "resolved_by"),
		taskBackend,
		ownerUserId: str(row, "owner_user_id"),
		parts: specLossExcerptParts(str(row, "excerpt")),
	};
}

/** One finding by id, with its excerpt when asked for. */
export async function readSpecLossFinding(
	id: string,
	options: { withExcerpt?: boolean } = {},
): Promise<SpecLossFindingRow | null> {
	const excerpt = options.withExcerpt ? sql`, f.excerpt` : sql``;
	const rows = await runOutlineAccessQuery(sql`
		select ${LIST_COLUMNS} ${excerpt}
		from outline_spec_loss_findings f join narrators n on n.id = f.narrator_id
		where f.id = ${id} limit 1
	`);
	return rows[0] ? findingOf(rows[0]) : null;
}

export interface SpecLossCursor {
	createdAt: string;
	id: string;
}

/**
 * One page of the findings in `status`, newest first; of one session with `narratorId`, of every
 * session without. `limit + 1` rows are read to see whether more follow. No excerpt.
 */
export async function listSpecLossFindings(options: {
	status: OutlineSpecLossStatus;
	narratorId?: string | null;
	after?: SpecLossCursor | null;
	limit?: number;
}): Promise<{ items: SpecLossFindingRow[]; next: SpecLossCursor | null }> {
	const limit = Math.max(1, Math.min(options.limit ?? 20, SPEC_LOSS_STORE_LIMITS.page));
	const session = options.narratorId ? sql`and f.narrator_id = ${options.narratorId}` : sql``;
	const after = options.after
		? sql`and (f.created_at < ${options.after.createdAt}
			or (f.created_at = ${options.after.createdAt} and f.id < ${options.after.id}))`
		: sql``;
	const rows = await runOutlineAccessQuery(sql`
		select ${LIST_COLUMNS}
		from outline_spec_loss_findings f join narrators n on n.id = f.narrator_id
		where f.status = ${options.status} ${session} ${after}
		order by f.created_at desc, f.id desc
		limit ${limit + 1}
	`);
	const items = rows.slice(0, limit).map(findingOf);
	const last = items[items.length - 1];
	return {
		items,
		next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}

/** Findings per status (of one session, or all), each counted up to the cap + 1. */
export async function countSpecLossFindings(
	narratorId?: string | null,
): Promise<Record<OutlineSpecLossStatus, number>> {
	const cap = SPEC_LOSS_STORE_LIMITS.countCap + 1;
	const session = narratorId ? sql`and narrator_id = ${narratorId}` : sql``;
	const parts = OUTLINE_SPEC_LOSS_STATUSES.map(
		(status) => sql`select cast(${status} as text) as status, count(*) as n from (
			select 1 as one from outline_spec_loss_findings
			where status = ${status} ${session} limit ${cap}
		) t${sql.raw(status)}`,
	);
	const rows = await runOutlineAccessQuery(sql.join(parts, sql` union all `));
	const out: Record<OutlineSpecLossStatus, number> = { open: 0, attached: 0, dismissed: 0 };
	for (const row of rows) {
		const status = str(row, "status");
		if (isSpecLossStatus(status)) out[status] = num(row, "n");
	}
	return out;
}

/**
 * A person's decision: the finding goes from `from` to `to`, only while it is still `from`
 * (someone else may have decided meanwhile). False when nothing changed.
 */
export async function setSpecLossFindingStatus(args: {
	id: string;
	from: OutlineSpecLossStatus;
	to: OutlineSpecLossStatus;
	userId: string;
	blockId?: string | null;
}): Promise<boolean> {
	const now = new Date().toISOString();
	const open = args.to === "open";
	const rows = await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set
			status = ${args.to}, block_id = ${args.blockId ?? null},
			resolved_by = ${open ? null : args.userId}, resolved_at = ${open ? null : now},
			updated_at = ${now}
		where id = ${args.id} and status = ${args.from}
		returning id
	`);
	return rows.length > 0;
}
