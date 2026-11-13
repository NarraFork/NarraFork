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
	OutlineSpecLossAttachNote,
	OutlineSpecLossFinding,
	OutlineSpecLossKind,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import { OUTLINE_SPEC_LOSS_STATUSES } from "@shared/outline-spec-import";
import {
	isSpecLossKind,
	SPEC_LOSS_FENCE_PATH,
	type SpecLossExcerptPart,
} from "@shared/spec-content-loss";
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

const ATTACH_NOTES: readonly OutlineSpecLossAttachNote[] = [
	"no_page",
	"page_cap",
	"session_cap",
	"restored",
	"failed",
	"gave_up",
	"reattach_cap",
	"list_only",
	"rule_page",
	"fork",
	"block_deleted",
];

/**
 * Why a finding is never attached by a pass, or null when it may be (owner decision 2026-11-13:
 * 「只自动贴表格，其余只列出」):
 *   - `rule_page`: it is of the behavior fence. That page is shown to the model as standing rules,
 *     so putting a removed rule back would make it apply again; only a person may, through a
 *     confirmation that says so;
 *   - `fork`: the save was made in the session this one was forked from; it is attached there,
 *     once, and only listed in every fork;
 *   - `list_only`: it holds something other than tables (task items, images, HTML, footnotes,
 *     front matter): removals on purpose cannot be told from losses often enough.
 */
export function specLossListedNote(finding: {
	path: string;
	kinds: Partial<Record<OutlineSpecLossKind, number>>;
	inherited: boolean;
}): "rule_page" | "fork" | "list_only" | null {
	if (finding.path === SPEC_LOSS_FENCE_PATH) return "rule_page";
	if (finding.inherited) return "fork";
	const kinds = Object.entries(finding.kinds).filter(([, n]) => (n ?? 0) > 0);
	return kinds.length > 0 && kinds.every(([kind]) => kind === "table") ? null : "list_only";
}

function attachNoteOf(value: string | null): OutlineSpecLossAttachNote | null {
	return ATTACH_NOTES.find((note) => note === value) ?? null;
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
	/** The namespace (session) the revision was written in. */
	namespaceId: string | null;
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
		with recursive chain (
			id, namespace_id, parent_revision_id, created_by, created_at, chars, depth
		) as (
			select r.id, r.namespace_id, r.parent_revision_id, r.created_by, r.created_at,
				length(r.content), 0
			from spec_file_revisions r where r.id = ${revisionId}
			union all
			select p.id, p.namespace_id, p.parent_revision_id, p.created_by, p.created_at,
				length(p.content), c.depth + 1
			from spec_file_revisions p join chain c on p.id = c.parent_revision_id
			where c.depth < ${limit - 1}
		)
		select id, namespace_id, parent_revision_id, created_by, created_at, chars, depth
		from chain order by depth limit ${limit}
	`);
	return rows.map((row) => ({
		id: String(row.id),
		namespaceId: str(row, "namespace_id"),
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
	/** The save was made in the session this one was forked from. */
	inherited: boolean;
}

/**
 * Record a finding unless it is recorded already (its id follows from the session, the path, the
 * revision before the save and whether it is the tables or the rest): what a person decided about
 * it is never touched. A finding no pass attaches says so from the start
 * ({@link specLossListedNote}). True when the row is new.
 */
export async function insertSpecLossFinding(finding: NewSpecLossFinding): Promise<boolean> {
	const now = new Date().toISOString();
	const rows = await runOutlineAccessQuery(sql`
		insert into outline_spec_loss_findings (
			id, narrator_id, path, before_revision_id, after_revision_id, before_at, saved_at,
			kinds, items, excerpt, truncated, status, attach_note, inherited, created_at, updated_at
		) values (
			${finding.id}, ${finding.narratorId}, ${finding.path}, ${finding.beforeRevisionId},
			${finding.afterRevisionId}, ${finding.beforeAt}, ${finding.savedAt},
			${JSON.stringify(finding.kinds)}, ${finding.items}, ${JSON.stringify(finding.parts)},
			${finding.truncated ? 1 : 0}, 'open', ${specLossListedNote(finding)},
			${finding.inherited ? 1 : 0}, ${now}, ${now}
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
	attachSeq: number;
	/** Automatic attaches that failed. */
	attachAttempts: number;
	/** The save was made in the session this one was forked from. */
	inherited: boolean;
	/** The session's task backend now. */
	taskBackend: string | null;
	ownerUserId: string | null;
	/** Only with `withExcerpt`. */
	parts: SpecLossExcerptPart[];
}

const LIST_COLUMNS = sql`
	f.id, f.narrator_id, f.path, f.before_revision_id, f.after_revision_id, f.saved_at, f.kinds,
	f.truncated, f.status, f.block_id, f.attach_note, f.attach_seq, f.attach_attempts, f.inherited,
	f.resolved_by, f.resolved_at, f.created_at,
	n.title, n.task_backend, n.owner_user_id,
	(select sp.id from outline_spaces sp
		where sp.narrator_id = f.narrator_id and sp.kind = 'session' limit 1) as space_id
`;

function findingOf(row: Row): SpecLossFindingRow {
	const status = str(row, "status");
	const taskBackend = str(row, "task_backend");
	const open = status === "open";
	const note = attachNoteOf(str(row, "attach_note"));
	const path = str(row, "path") ?? "";
	return {
		id: String(row.id),
		narratorId: String(row.narrator_id),
		title: str(row, "title"),
		path,
		savedAt: str(row, "saved_at"),
		kinds: kindsOf(str(row, "kinds")),
		truncated: num(row, "truncated") !== 0,
		status: isSpecLossStatus(status) ? status : "open",
		blockId: str(row, "block_id"),
		// Of an open finding: why it is not on the page. Of a dismissed one: only that its block was
		// deleted on the page (nobody pressed "dismiss").
		attachNote: open || (status === "dismissed" && note === "block_deleted") ? note : null,
		rulePage: path === SPEC_LOSS_FENCE_PATH,
		spaceId: str(row, "space_id"),
		resolvedAt: str(row, "resolved_at"),
		createdAt: str(row, "created_at") ?? "",
		attachable: open && taskBackend === "outline",
		beforeRevisionId: str(row, "before_revision_id") ?? "",
		afterRevisionId: str(row, "after_revision_id") ?? "",
		resolvedBy: str(row, "resolved_by"),
		attachSeq: num(row, "attach_seq"),
		attachAttempts: num(row, "attach_attempts"),
		inherited: num(row, "inherited") !== 0,
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
 * The finding goes from one of `from` to `to`, only while it is still one of `from` (someone else,
 * or a pass, may have changed it meanwhile). `blockId` undefined keeps the block recorded; `note`
 * is why it stands there (none unless given). False when nothing changed.
 */
export async function setSpecLossFindingStatus(args: {
	id: string;
	from: readonly OutlineSpecLossStatus[];
	to: OutlineSpecLossStatus;
	/** The person deciding; null: the scan's own attach. */
	userId: string | null;
	blockId?: string | null;
	note?: OutlineSpecLossAttachNote | null;
}): Promise<boolean> {
	const now = new Date().toISOString();
	const decided = args.to === "dismissed";
	const from = sql.join(
		args.from.map((status) => sql`${status}`),
		sql`, `,
	);
	const block = args.blockId === undefined ? sql`block_id` : sql`${args.blockId}`;
	const rows = await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set
			status = ${args.to}, block_id = ${block}, attach_note = ${args.note ?? null},
			resolved_by = ${decided ? args.userId : null}, resolved_at = ${decided ? now : null},
			attach_attempts = ${sql.raw(args.to === "open" ? "0" : "attach_attempts")},
			updated_at = ${now}
		where id = ${args.id} and status in (${from})
		returning id
	`);
	return rows.length > 0;
}

/** Why an open finding is not on the page (while it is still open). */
export async function setSpecLossAttachNote(
	id: string,
	note: OutlineSpecLossAttachNote,
): Promise<void> {
	await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set attach_note = ${note}, updated_at = ${new Date().toISOString()}
		where id = ${id} and status = 'open'
	`);
}

/**
 * An automatic attach of an open finding failed: counted, and after `max` failures the finding is
 * left to a person (`gave_up`; no pass lists it again). The note it carries now; null when it is
 * not open any more.
 */
export async function noteSpecLossAttachFailure(
	id: string,
	max: number,
): Promise<"failed" | "gave_up" | null> {
	const rows = await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set
			attach_attempts = attach_attempts + 1,
			attach_note = case when attach_attempts + 1 >= ${max} then 'gave_up' else 'failed' end,
			updated_at = ${new Date().toISOString()}
		where id = ${id} and status = 'open'
		returning attach_note
	`);
	const note = rows[0] ? str(rows[0], "attach_note") : null;
	return note === "failed" || note === "gave_up" ? note : null;
}

/**
 * The finding's block was deleted and it is attached anew: its next short id. Only from `from`,
 * so two attaches at once take the same one. The sequence now.
 */
export async function bumpSpecLossAttachSeq(id: string, from: number): Promise<number> {
	await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set attach_seq = ${from + 1}
		where id = ${id} and attach_seq = ${from}
	`);
	const rows = await runOutlineAccessQuery(sql`
		select attach_seq from outline_spec_loss_findings where id = ${id} limit 1
	`);
	return rows[0] ? num(rows[0], "attach_seq") : from + 1;
}

/** How many findings are attached to the page of `path` in the session, counted up to `cap`. */
export async function countSpecLossAttached(
	narratorId: string,
	path: string,
	cap: number,
): Promise<number> {
	const rows = await runOutlineAccessQuery(sql`
		select count(*) as n from (
			select 1 as one from outline_spec_loss_findings
			where narrator_id = ${narratorId} and status = 'attached' and path = ${path}
			limit ${cap}
		) t
	`);
	return rows[0] ? num(rows[0], "n") : 0;
}

/**
 * The session's open findings a pass attaches, with their excerpts: the ones not tried yet and
 * the ones a later pass tries again (`session_cap`, `failed`), those that failed least first (so
 * findings that keep failing never hold up the others), then oldest first. At most `limit`. A
 * finding with any other note is not listed: it is left to a person.
 */
export async function listSpecLossToAttach(
	narratorId: string,
	limit: number,
): Promise<SpecLossFindingRow[]> {
	const rows = await runOutlineAccessQuery(sql`
		select ${LIST_COLUMNS}, f.excerpt
		from outline_spec_loss_findings f join narrators n on n.id = f.narrator_id
		where f.narrator_id = ${narratorId} and f.status = 'open'
			and (f.attach_note is null or f.attach_note in ('session_cap', 'failed'))
		order by f.attach_attempts, f.created_at, f.id
		limit ${limit}
	`);
	return rows.map(findingOf);
}

/** The open findings a pass has not tried become `session_cap`: one statement. */
export async function markSpecLossSessionCap(narratorId: string): Promise<void> {
	await runOutlineAccessQuery(sql`
		update outline_spec_loss_findings set attach_note = 'session_cap'
		where narrator_id = ${narratorId} and status = 'open' and attach_note is null
	`);
}

/**
 * The session's attached findings (id, block, attach sequence), oldest first, at most `limit`,
 * after `after` when given.
 */
export async function listSpecLossAttached(
	narratorId: string,
	limit: number,
	after: SpecLossCursor | null = null,
): Promise<Array<{ id: string; blockId: string | null; attachSeq: number; createdAt: string }>> {
	const from = after
		? sql`and (created_at > ${after.createdAt}
			or (created_at = ${after.createdAt} and id > ${after.id}))`
		: sql``;
	const rows = await runOutlineAccessQuery(sql`
		select id, block_id, attach_seq, created_at from outline_spec_loss_findings
		where narrator_id = ${narratorId} and status = 'attached' ${from}
		order by created_at, id limit ${limit}
	`);
	return rows.map((row) => ({
		id: String(row.id),
		blockId: str(row, "block_id"),
		attachSeq: num(row, "attach_seq"),
		createdAt: str(row, "created_at") ?? "",
	}));
}
