/**
 * What the Dynamic Spec import reads and the one row it changes (outline P2 PR 12b; PR 12 design
 * §3), in SQL that SQLite and PostgreSQL both run unchanged, through the outline access executor
 * (`access-reads.ts`). The Dynamic Spec service reads through the SQLite handle only, so the
 * import cannot use it: spec rows a PostgreSQL deployment holds must be importable too.
 *
 * Every statement is bounded and indexed: a session and its namespace by primary key and the
 * namespace's unique index; a namespace's file pointers (`idx_spec_namespace_files_namespace_path`)
 * with only the LENGTH of each current revision; revision contents by primary key, a few at a
 * time and within a byte budget the caller keeps ({@link SPEC_IMPORT_READ_LIMITS}); the protected
 * locks of a namespace (`idx_spec_protected_tasks_namespace_status`) with who first wrote each;
 * namespaces page by page on the primary key for the idle job. Nothing here writes Dynamic Spec.
 */
import { sql } from "drizzle-orm";
import { runOutlineAccessQuery } from "../access-reads";

export const SPEC_IMPORT_READ_LIMITS = {
	/** File pointers of one namespace read (one more than the import takes, to see "too many"). */
	files: 501,
	/** Revisions whose content one statement reads. */
	contentsPerRead: 20,
	/** Characters of content one statement reads (a file holds at most 200 000). */
	contentCharsPerRead: 1_000_000,
	/** Protected-task locks of one namespace read. */
	locks: 1000,
	/** Namespaces one page of the idle job's scan reads. */
	candidatePage: 50,
} as const;

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== "string") throw new Error(`spec import read: ${column} is not text`);
	return value;
}

function textOrNull(row: Row, column: string): string | null {
	const value = row[column];
	return value === null || value === undefined ? null : String(value);
}

function truthy(value: unknown): boolean {
	return value === true || value === 1 || value === 1n || value === "1" || value === "t";
}

/** A session as the import judges it. */
export interface SpecImportSession {
	narratorId: string;
	/** `subagent` is never imported. */
	type: string;
	taskBackend: string;
	archived: boolean;
	ownerUserId: string | null;
	/** Its spec namespace; null when it never touched Dynamic Spec. */
	namespaceId: string | null;
	/**
	 * Provisioned through the external API (an OAuth client's binding): such a session keeps its
	 * tasks in Dynamic Spec, which its client drives (`external-resource-service.ts`).
	 */
	external: boolean;
}

const SESSION_COLUMNS = sql`
	n.id, n.type, n.task_backend, n.status, n.owner_user_id, s.id as namespace_id,
	(select 1 from integration_resource_bindings b
		where b.resource_type = 'narrator' and b.resource_id = n.id
			and b.source_type = 'oauth_client' limit 1) as external
`;

function sessionOf(row: Row): SpecImportSession {
	return {
		narratorId: text(row, "id"),
		type: text(row, "type"),
		taskBackend: text(row, "task_backend"),
		archived: text(row, "status") === "archived",
		ownerUserId: textOrNull(row, "owner_user_id"),
		namespaceId: textOrNull(row, "namespace_id"),
		external: row.external !== null && row.external !== undefined,
	};
}

export async function readSpecImportSession(narratorId: string): Promise<SpecImportSession | null> {
	const rows = await runOutlineAccessQuery(sql`
		select ${SESSION_COLUMNS}
		from narrators n left join spec_namespaces s on s.narrator_id = n.id
		where n.id = ${narratorId} limit 1
	`);
	return rows[0] ? sessionOf(rows[0]) : null;
}

/** One current file of a namespace, without its content. */
export interface SpecImportFilePointer {
	path: string;
	/** Null: never written, or its revision is gone (a fork whose parent was deleted). */
	revisionId: string | null;
	deleted: boolean;
	/** Characters of the current revision; null when it cannot be read. */
	chars: number | null;
}

/**
 * The namespace's live file pointers by path, at most {@link SPEC_IMPORT_READ_LIMITS.files}. A
 * deleted file is left out: it is not imported and does not count toward the limit (a file
 * deleted during the import still changes what this returns).
 */
export async function readSpecFilePointers(namespaceId: string): Promise<SpecImportFilePointer[]> {
	const rows = await runOutlineAccessQuery(sql`
		select f.path, f.revision_id, f.deleted, r.id as revision_found, length(r.content) as chars
		from spec_namespace_files f left join spec_file_revisions r on r.id = f.revision_id
		where f.namespace_id = ${namespaceId} and not f.deleted
		order by f.path limit ${SPEC_IMPORT_READ_LIMITS.files}
	`);
	return rows.map((row) => {
		const found = textOrNull(row, "revision_found");
		return {
			path: text(row, "path"),
			revisionId: found,
			deleted: truthy(row.deleted),
			chars: found === null ? null : Number(row.chars ?? 0),
		};
	});
}

/**
 * The contents of these revisions, by id. The caller passes at most
 * {@link SPEC_IMPORT_READ_LIMITS.contentsPerRead} ids whose lengths (read with the pointers) sum
 * to at most {@link SPEC_IMPORT_READ_LIMITS.contentCharsPerRead}.
 */
export async function readSpecRevisionContents(
	revisionIds: readonly string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (revisionIds.length === 0) return out;
	if (revisionIds.length > SPEC_IMPORT_READ_LIMITS.contentsPerRead)
		throw new Error("spec import read: too many revisions in one read");
	const ids = sql.join(
		revisionIds.map((id) => sql`${id}`),
		sql`, `,
	);
	const rows = await runOutlineAccessQuery(sql`
		select id, content from spec_file_revisions where id in (${ids})
		limit ${SPEC_IMPORT_READ_LIMITS.contentsPerRead}
	`);
	for (const row of rows) out.set(text(row, "id"), text(row, "content"));
	return out;
}

/** Who first protected a task: the author of the revision its lock was made in. */
export type SpecProtector = "user" | "assistant" | "system" | "unknown";

/**
 * The live protected-task locks of a namespace, by text hash (`taskTextHash`): who first
 * protected each. `truncated` when the namespace holds more than the read takes.
 */
export async function readSpecProtectors(
	namespaceId: string,
): Promise<{ byHash: Map<string, SpecProtector>; truncated: boolean }> {
	const rows = await runOutlineAccessQuery(sql`
		select l.text_hash, r.created_by
		from spec_protected_tasks l left join spec_file_revisions r on r.id = l.first_revision_id
		where l.namespace_id = ${namespaceId} and l.status <> 'deleted'
		limit ${SPEC_IMPORT_READ_LIMITS.locks + 1}
	`);
	const byHash = new Map<string, SpecProtector>();
	for (const row of rows.slice(0, SPEC_IMPORT_READ_LIMITS.locks)) {
		const by = textOrNull(row, "created_by");
		byHash.set(
			text(row, "text_hash"),
			by === "user" || by === "assistant" || by === "system" ? by : "unknown",
		);
	}
	return { byHash, truncated: rows.length > SPEC_IMPORT_READ_LIMITS.locks };
}

/**
 * One page of spec namespaces after `afterNamespaceId` (primary-key order), each with its session
 * as {@link readSpecImportSession} reads it. The caller keeps the ones to import; `next` is the
 * cursor of the following page, null at the end.
 */
export async function readSpecNamespacePage(
	afterNamespaceId: string | null,
): Promise<{ sessions: SpecImportSession[]; next: string | null }> {
	const limit = SPEC_IMPORT_READ_LIMITS.candidatePage;
	const rows = await runOutlineAccessQuery(sql`
		select ${SESSION_COLUMNS}
		from spec_namespaces s join narrators n on n.id = s.narrator_id
		where s.id > ${afterNamespaceId ?? ""}
		order by s.id limit ${limit}
	`);
	const sessions = rows.map(sessionOf);
	const last = sessions[sessions.length - 1];
	return { sessions, next: rows.length === limit && last ? last.namespaceId : null };
}

/**
 * Move a session to the outline: its column goes from `spec` to `outline`, only while it is still
 * `spec` and the narrator is not a subagent. False when nothing changed (moved already, gone).
 */
export async function switchSessionToOutline(narratorId: string): Promise<boolean> {
	const rows = await runOutlineAccessQuery(sql`
		update narrators set task_backend = 'outline'
		where id = ${narratorId} and task_backend = 'spec' and type <> 'subagent'
		returning id
	`);
	return rows.length > 0;
}
