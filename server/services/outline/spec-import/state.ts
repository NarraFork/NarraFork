/**
 * The persisted state of a session's Dynamic Spec import (outline P2 PR 12b2): table
 * `outline_spec_imports`, one row per root session an import was tried for or that was moved back
 * to Dynamic Spec. The source of truth for the Spec panel's banner, the automatic triggers'
 * attempt limits (they survive restarts), the model's one notice per switch, the read-only line
 * on the old Spec files and the admin page; this module keeps an in-memory cache of it only.
 *
 * Every statement is one SQL text both dialects run, through the outline access executor
 * (`access-reads.ts`): a primary-key read, a primary-key upsert, and the admin page's reads on
 * `idx_outline_spec_imports_status` (a page of one state, `limit + 1`; a count per state capped at
 * {@link SPEC_IMPORT_STATE_LIMITS.countCap}). Writes of one session are serialized in this
 * process, each a whole row computed from the one before it.
 */
import { hotSafe } from "@server/lib/hot-safe";
import type { OutlineSpecImportReason } from "@shared/outline-spec-import";
import { sql } from "drizzle-orm";
import { runOutlineAccessQuery } from "../access-reads";

export const SPEC_IMPORT_STATE_LIMITS = {
	/** Sessions whose state is cached (least recently used dropped first). */
	cached: 4096,
	/** Characters of a failure's English detail stored. */
	detailChars: 300,
	/** Rows one page of the admin list reads. */
	page: 50,
	/** Rows of one state the admin page counts at most (more reads as "1000+"). */
	countCap: 1000,
	/** Marker block ids a move back records. */
	noteIds: 4,
} as const;

export const SPEC_IMPORT_STATES = [
	"idle",
	"running",
	"imported",
	"failed",
	"attention",
	"busy",
	"reverted",
] as const;

export type SpecImportStateStatus = (typeof SPEC_IMPORT_STATES)[number];

export function isSpecImportStateStatus(value: unknown): value is SpecImportStateStatus {
	return (SPEC_IMPORT_STATES as readonly unknown[]).includes(value);
}

/** One session's row. */
export interface SpecImportState {
	narratorId: string;
	status: SpecImportStateStatus;
	/** The last attempt's trigger: `run`, `sweep`, `manual`, `admin`. */
	trigger: string | null;
	/** Failed attempts since the last success or an administrator's re-import. */
	attempts: number;
	/** Why the last attempt did not move the session (code and count), or null. */
	reason: OutlineSpecImportReason | null;
	/** The same in English, as logged (at most {@link SPEC_IMPORT_STATE_LIMITS.detailChars}). */
	error: string | null;
	/** The reason's code while the state is `attention`. */
	attentionReason: string | null;
	/** How often an import moved the session to the outline. */
	switchCount: number;
	switchedAt: string | null;
	/** The switch whose notice the session's history holds (`switchCount`: delivered). */
	noticeSwitch: number;
	spaceId: string | null;
	taskPageId: string | null;
	/** The `behavior_fence` revision the import read when it moved the session. */
	fenceRevisionId: string | null;
	tasks: number | null;
	pages: number | null;
	revertCount: number;
	revertedAt: string | null;
	revertedBy: string | null;
	/** Digest of the file pointers when last moved back; cleared by the next switch. */
	revertSourceKey: string | null;
	/** The marker blocks the last move back wrote. */
	revertNoteIds: string[];
	/** The administrator who last re-imported or moved it back. */
	lastActor: string | null;
	createdAt: string;
	updatedAt: string;
}

type Row = Record<string, unknown>;

function str(row: Row, column: string): string | null {
	const value = row[column];
	return value === null || value === undefined ? null : String(value);
}

function num(row: Row, column: string): number | null {
	const value = row[column];
	if (value === null || value === undefined) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

const REASON_CODES: ReadonlySet<string> = new Set<OutlineSpecImportReason["code"]>([
	"too_many_files",
	"too_large",
	"broken_tasks",
	"task_mismatch",
	"kept_blocks",
	"fence_too_large",
	"sop_too_large",
	"not_started",
	"changed",
	"moved_elsewhere",
	"off",
	"other",
]);

function noteIdsOf(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed
					.filter((id): id is string => typeof id === "string")
					.slice(0, SPEC_IMPORT_STATE_LIMITS.noteIds)
			: [];
	} catch {
		return [];
	}
}

function stateOf(row: Row): SpecImportState {
	const status = str(row, "status");
	const code = str(row, "last_error_code");
	const count = num(row, "last_error_count");
	return {
		narratorId: String(row.narrator_id),
		status: isSpecImportStateStatus(status) ? status : "idle",
		trigger: str(row, "trigger"),
		attempts: num(row, "attempts") ?? 0,
		reason:
			code && REASON_CODES.has(code)
				? {
						code: code as OutlineSpecImportReason["code"],
						...(count === null ? {} : { count }),
					}
				: null,
		error: str(row, "last_error_detail"),
		attentionReason: str(row, "attention_reason"),
		switchCount: num(row, "switch_count") ?? 0,
		switchedAt: str(row, "switched_at"),
		noticeSwitch: num(row, "notice_switch") ?? 0,
		spaceId: str(row, "space_id"),
		taskPageId: str(row, "task_page_id"),
		fenceRevisionId: str(row, "fence_revision_id"),
		tasks: num(row, "tasks"),
		pages: num(row, "pages"),
		revertCount: num(row, "revert_count") ?? 0,
		revertedAt: str(row, "reverted_at"),
		revertedBy: str(row, "reverted_by"),
		revertSourceKey: str(row, "revert_source_key"),
		revertNoteIds: noteIdsOf(str(row, "revert_note_ids")),
		lastActor: str(row, "last_actor"),
		createdAt: str(row, "created_at") ?? "",
		updatedAt: str(row, "updated_at") ?? "",
	};
}

const COLUMNS = sql`
	narrator_id, status, "trigger", attempts, last_error_code, last_error_count, last_error_detail,
	attention_reason, switch_count, switched_at, notice_switch, space_id, task_page_id,
	fence_revision_id, tasks, pages, revert_count, reverted_at, reverted_by, revert_source_key,
	revert_note_ids, last_actor, created_at, updated_at
`;

/** Cached rows; `null`: the session has no row (read, or never written). */
const cache = hotSafe(
	"narrafork.outline.specImport.state",
	() => new Map<string, SpecImportState | null>(),
);
/** The write in flight per session: the next one starts after it. */
const writing = hotSafe(
	"narrafork.outline.specImport.stateWrites",
	() => new Map<string, Promise<unknown>>(),
);

function cachePut(narratorId: string, state: SpecImportState | null): void {
	cache.delete(narratorId);
	cache.set(narratorId, state);
	while (cache.size > SPEC_IMPORT_STATE_LIMITS.cached) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** What is cached for a session: its state, null (no row), or undefined (not read yet). */
export function cachedSpecImportState(narratorId: string): SpecImportState | null | undefined {
	return cache.get(narratorId);
}

/** Forget the cache (tests: what a restart does; data import: rows were dropped). */
export function resetSpecImportStateCache(narratorId?: string): void {
	if (narratorId === undefined) cache.clear();
	else cache.delete(narratorId);
}

/** The session's state: from the cache, else one primary-key read (cached). */
export async function readSpecImportState(narratorId: string): Promise<SpecImportState | null> {
	const cached = cache.get(narratorId);
	if (cached !== undefined) {
		cachePut(narratorId, cached);
		return cached;
	}
	const rows = await runOutlineAccessQuery(sql`
		select ${COLUMNS} from outline_spec_imports where narrator_id = ${narratorId} limit 1
	`);
	const state = rows[0] ? stateOf(rows[0]) : null;
	// A write that landed meanwhile is newer than what was read.
	if (!cache.has(narratorId)) cachePut(narratorId, state);
	return cache.get(narratorId) ?? state;
}

/**
 * Whether the import moved the session into the outline and it was not moved back since (the
 * caller knows its task backend is `outline`). Never rejects: false when the state cannot be
 * read.
 */
export async function isSpecImportedSession(narratorId: string): Promise<boolean> {
	try {
		const state = await readSpecImportState(narratorId);
		return state !== null && state.switchCount > 0 && state.status !== "reverted";
	} catch {
		return false;
	}
}

/** The fields a write may set; the rest is carried over from the row before it. */
export type SpecImportStatePatch = Partial<
	Omit<SpecImportState, "narratorId" | "createdAt" | "updatedAt">
>;

function emptyState(narratorId: string, now: string): SpecImportState {
	return {
		narratorId,
		status: "idle",
		trigger: null,
		attempts: 0,
		reason: null,
		error: null,
		attentionReason: null,
		switchCount: 0,
		switchedAt: null,
		noticeSwitch: 0,
		spaceId: null,
		taskPageId: null,
		fenceRevisionId: null,
		tasks: null,
		pages: null,
		revertCount: 0,
		revertedAt: null,
		revertedBy: null,
		revertSourceKey: null,
		revertNoteIds: [],
		lastActor: null,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Write a session's row: `patch` (or what `update` makes of the current row) over the current
 * row, as one upsert. Serialized per session in this process. Rejects when the write fails (the
 * cache then holds what was there before). Resolves to the row written.
 */
export async function writeSpecImportState(
	narratorId: string,
	update: SpecImportStatePatch | ((current: SpecImportState | null) => SpecImportStatePatch),
): Promise<SpecImportState> {
	const before = writing.get(narratorId) ?? Promise.resolve();
	const run = before
		.catch(() => {})
		.then(async () => {
			const current = await readSpecImportState(narratorId);
			const patch = typeof update === "function" ? update(current) : update;
			const now = new Date().toISOString();
			const next: SpecImportState = {
				...(current ?? emptyState(narratorId, now)),
				...patch,
				narratorId,
				updatedAt: now,
			};
			const error = next.error ? next.error.slice(0, SPEC_IMPORT_STATE_LIMITS.detailChars) : null;
			next.error = error;
			next.revertNoteIds = next.revertNoteIds.slice(0, SPEC_IMPORT_STATE_LIMITS.noteIds);
			const noteIds = next.revertNoteIds.length > 0 ? JSON.stringify(next.revertNoteIds) : null;
			await runOutlineAccessQuery(sql`
				insert into outline_spec_imports (${COLUMNS}) values (
					${narratorId}, ${next.status}, ${next.trigger}, ${next.attempts},
					${next.reason?.code ?? null}, ${next.reason?.count ?? null}, ${error},
					${next.attentionReason}, ${next.switchCount}, ${next.switchedAt}, ${next.noticeSwitch},
					${next.spaceId}, ${next.taskPageId}, ${next.fenceRevisionId}, ${next.tasks},
					${next.pages}, ${next.revertCount}, ${next.revertedAt}, ${next.revertedBy},
					${next.revertSourceKey}, ${noteIds}, ${next.lastActor}, ${next.createdAt}, ${now}
				)
				on conflict (narrator_id) do update set
					status = excluded.status, "trigger" = excluded."trigger",
					attempts = excluded.attempts, last_error_code = excluded.last_error_code,
					last_error_count = excluded.last_error_count,
					last_error_detail = excluded.last_error_detail,
					attention_reason = excluded.attention_reason, switch_count = excluded.switch_count,
					switched_at = excluded.switched_at, notice_switch = excluded.notice_switch,
					space_id = excluded.space_id, task_page_id = excluded.task_page_id,
					fence_revision_id = excluded.fence_revision_id, tasks = excluded.tasks,
					pages = excluded.pages, revert_count = excluded.revert_count,
					reverted_at = excluded.reverted_at, reverted_by = excluded.reverted_by,
					revert_source_key = excluded.revert_source_key,
					revert_note_ids = excluded.revert_note_ids, last_actor = excluded.last_actor,
					updated_at = excluded.updated_at
			`);
			cachePut(narratorId, next);
			return next;
		});
	writing.set(narratorId, run);
	try {
		return await run;
	} finally {
		if (writing.get(narratorId) === run) writing.delete(narratorId);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The admin page
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the admin page: the state and what names the session. */
export interface SpecImportStateListItem extends SpecImportState {
	title: string | null;
	taskBackend: string | null;
	ownerUserId: string | null;
	ownerName: string | null;
}

/** A cursor: the last row's `updated_at` and narrator id. */
export interface SpecImportStateCursor {
	updatedAt: string;
	narratorId: string;
}

/**
 * One page of the sessions in `status`, most recently changed first (`limit + 1` read to see
 * whether more follow). Each with its title, task backend and owner (primary-key joins).
 */
export async function listSpecImportStates(options: {
	status: SpecImportStateStatus;
	after?: SpecImportStateCursor | null;
	limit?: number;
}): Promise<{ items: SpecImportStateListItem[]; next: SpecImportStateCursor | null }> {
	const limit = Math.max(1, Math.min(options.limit ?? 20, SPEC_IMPORT_STATE_LIMITS.page));
	const after = options.after
		? sql`and (i.updated_at < ${options.after.updatedAt}
			or (i.updated_at = ${options.after.updatedAt} and i.narrator_id < ${options.after.narratorId}))`
		: sql``;
	const rows = await runOutlineAccessQuery(sql`
		select i.narrator_id, i.status, i."trigger", i.attempts, i.last_error_code,
			i.last_error_count, i.last_error_detail, i.attention_reason, i.switch_count,
			i.switched_at, i.notice_switch, i.space_id, i.task_page_id, i.fence_revision_id,
			i.tasks, i.pages, i.revert_count, i.reverted_at, i.reverted_by, i.revert_source_key,
			i.revert_note_ids, i.last_actor, i.created_at, i.updated_at,
			n.title, n.task_backend, n.owner_user_id, u.username as owner_name
		from outline_spec_imports i
			join narrators n on n.id = i.narrator_id
			left join users u on u.id = n.owner_user_id
		where i.status = ${options.status} ${after}
		order by i.updated_at desc, i.narrator_id desc
		limit ${limit + 1}
	`);
	const items = rows.slice(0, limit).map((row) => ({
		...stateOf(row),
		title: str(row, "title"),
		taskBackend: str(row, "task_backend"),
		ownerUserId: str(row, "owner_user_id"),
		ownerName: str(row, "owner_name"),
	}));
	const last = items[items.length - 1];
	return {
		items,
		next:
			rows.length > limit && last
				? { updatedAt: last.updatedAt, narratorId: last.narratorId }
				: null,
	};
}

/** How many sessions are in each state, each counted up to {@link SPEC_IMPORT_STATE_LIMITS.countCap} + 1. */
export async function countSpecImportStates(): Promise<Record<SpecImportStateStatus, number>> {
	const cap = SPEC_IMPORT_STATE_LIMITS.countCap + 1;
	const parts = SPEC_IMPORT_STATES.map(
		(status) => sql`select cast(${status} as text) as status, count(*) as n from (
			select 1 as one from outline_spec_imports where status = ${status} limit ${cap}
		) t${sql.raw(status)}`,
	);
	const rows = await runOutlineAccessQuery(sql.join(parts, sql` union all `));
	const out = Object.fromEntries(SPEC_IMPORT_STATES.map((s) => [s, 0])) as Record<
		SpecImportStateStatus,
		number
	>;
	for (const row of rows) {
		const status = str(row, "status");
		if (isSpecImportStateStatus(status)) out[status] = num(row, "n") ?? 0;
	}
	return out;
}
