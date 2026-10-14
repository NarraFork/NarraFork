import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { lstat, opendir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AppError, NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import {
	assertLegacyLinkedWorktreeIdentityUnchangedSync,
	revalidateLegacyLinkedWorktreeIdentity,
} from "./legacy-linked-worktree-identity";
import {
	type LegacyRootAdoptionInput,
	type LegacyRootAdoptionResult,
	legacyLocalWorkspaceContext,
} from "./legacy-main-checkout-adoption";
import { validateLegacyProjectBackup } from "./legacy-project-backup-validation";
import {
	LEGACY_RETAINED_HISTORY_LIMITS,
	type LegacyRetainedHistoryResult,
} from "./legacy-retained-history-contract";
import { worktreeResourceId } from "./narrator-worktree-resource-store";
import { treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import {
	assertWorkspaceAdmission,
	canonicalWorkspaceAdmissionTarget,
	type LifecycleTarget,
	withWorkspaceAdmission,
} from "./worktree-lifecycle-guard";

export interface MigrationPrincipal {
	userId: string;
	isAdmin: boolean;
}
export interface MigrationBlocker {
	code: string;
	message: string;
}
type Row = Record<string, string | number | null>;
type Identity = { dev: number; ino: number };
interface ArchiveIdentity {
	root: Identity;
	directory: Identity | null;
	files: Record<string, Identity | null>;
}
const identity = (stat: Identity): Identity => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (a: Identity | null, b: Identity | null) =>
	a?.dev === b?.dev && a?.ino === b?.ino;
const BACKUP_FILES = ["project.db", "project.db-wal", "project.db-shm"];
export interface MigrationResult {
	phase: string;
	narratorIds: string[];
	syncDisabled: boolean;
	blockers?: MigrationBlocker[];
}
export interface MigrationDependencies {
	jobs?: Map<string, Promise<MigrationResult>>;
	sqlite: Database;
	runtimeBusy(id: string): boolean;
	runtimeWorkspace?(id: string): { cwd: string; deviceId: string } | null;
	withRuntimeAdmission?<T>(ids: string[], body: () => Promise<T>): Promise<T | null>;
	prepareRootAdoption?(input: LegacyRootAdoptionInput): Promise<LegacyRootAdoptionResult>;
	/** Enable only after every destructive artifact consumer is protected. */
	retainedHistoryConsumersReady?: boolean;
	/** Fail closed independently of Root0: enable only after linked core and all consumers are verified. */
	linkedWorktreeConsumersReady?: boolean;
	/** Real physical admission is the production default; injectable only for isolated tests. */
	withWorkspaceAdmission?: typeof withWorkspaceAdmission;
	onConverted?(updates: LegacyRootAdoptionResult["updates"]): void;
	/** The actual primary database path; never authorize its unlink even if configured inside a repository. */
	mainDatabasePath?: string;
	syncInFlight?(id: string): boolean;
	disableSync(id: string): Promise<{ syncDisabled: true; drained: boolean }>;
}
const LIMIT = 200;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const meaningful = (value: unknown) =>
	value != null && value !== "" && value !== "[]" && value !== "{}";

/** SQLite production implementation. No message bodies or destructive legacy lifecycle calls. */
export function createLegacyProjectMigrationService(deps: MigrationDependencies) {
	const { sqlite } = deps;
	const jobs = deps.jobs ?? new Map<string, Promise<MigrationResult>>();
	const metadataCache = new Map<string, Row[]>();
	let schemaVersion = -1;
	const all = (sql: string, ...args: SQLQueryBindings[]) => {
		const metadata =
			sql.startsWith("PRAGMA ") ||
			sql.startsWith("EXPLAIN ") ||
			sql.startsWith("SELECT name FROM sqlite_master");
		const cached = metadata ? metadataCache.get(sql) : undefined;
		if (cached) return cached;
		const rows = sqlite.query<Row, SQLQueryBindings[]>(sql).all(...args);
		if (metadata) metadataCache.set(sql, rows);
		return rows;
	};
	const first = (sql: string, ...args: SQLQueryBindings[]) => all(sql, ...args)[0];
	const boundedProjection = (fields: string[]) => {
		const size =
			fields.map((field) => `coalesce(length(CAST(${quote(field)} AS BLOB)),0)`).join("+") || "0";
		return fields
			.map(
				(field) =>
					`CASE WHEN (${size}) > 65536 THEN '__oversized__' ELSE ${quote(field)} END AS ${quote(field)}`,
			)
			.join(",");
	};
	const receipt = (id: string) =>
		first("SELECT * FROM legacy_project_migrations WHERE project_id=? LIMIT 1", id);
	function authorize(row: Row, actor: MigrationPrincipal, historical = false) {
		if (
			!actor.userId ||
			(!actor.isAdmin && row[historical ? "actor_user_id" : "owner_user_id"] !== actor.userId)
		)
			throw new NotFoundError("Project", "legacy migration");
	}
	const retainedResult = (
		adoption: LegacyRootAdoptionResult | null,
	): LegacyRetainedHistoryResult | null =>
		adoption?.history.status === "retained" &&
		adoption.history.complete &&
		deps.retainedHistoryConsumersReady
			? adoption.history
			: null;
	const archivalTables = new Set(["chapter_commits", "chapter_edges", "merge_sessions"]);
	function retainedJournalReferencesOwned(history: LegacyRetainedHistoryResult): boolean {
		const manifest = history.manifest;
		const grouped = manifest.workspaces?.some((workspace) => workspace.kind === "linked") === true;
		const historicalWorkspace = (table: string, id: string) => {
			if (!grouped || !Array.isArray(manifest.historyOrigins)) return null;
			const mappings = manifest.historyOrigins.filter(
				(entry) => entry.table === table && entry.id === id,
			);
			if (mappings.length !== 1) return null;
			const mapping = mappings[0];
			const workspace = manifest.workspaces.find(
				(entry) => entry.workspacePath === mapping.workspacePath,
			);
			if (
				!workspace ||
				mapping.deviceId !== "local" ||
				mapping.evidence === "root_only" ||
				!mapping.sourceChapterIds.length ||
				new Set(mapping.sourceChapterIds).size !== mapping.sourceChapterIds.length ||
				mapping.sourceChapterIds.some(
					(chapterId) =>
						!workspace.sourceChapterIds.includes(chapterId) ||
						!manifest.chapters.some((chapter) => chapter.id === chapterId),
				)
			)
				return null;
			return workspace;
		};
		return (manifest.references.file_change_operations ?? []).every((operation) => {
			const operationWorkspace = historicalWorkspace(
				"file_change_operations",
				String(operation.id),
			);
			if (grouped && !operationWorkspace) return false;
			if (
				(operation.project_id !== null && operation.project_id !== manifest.projectId) ||
				operation.owner_user_id !== manifest.ownerUserId ||
				operation.settlement !== "settled" ||
				operation.coverage !== "complete" ||
				!["succeeded", "failed", "interrupted"].includes(String(operation.execution_outcome)) ||
				!["changed", "no_change"].includes(String(operation.effect_outcome)) ||
				Number(operation.unresolved_effect_count) !== 0 ||
				!manifest.narratorOrigins.some(
					(origin) =>
						origin.narratorId === operation.narrator_id &&
						origin.deviceId === "local" &&
						(grouped
							? !!origin.sourceChapterId &&
								manifest.chapters.some((chapter) => chapter.id === origin.sourceChapterId)
							: origin.workspacePath === manifest.mainCheckoutRoot),
				)
			)
				return false;
			const effects = (manifest.references.file_change_effects ?? []).filter(
				(effect) => effect.operation_id === operation.id,
			);
			if (
				operation.expected_effect_count == null ||
				effects.length !== operation.expected_effect_count ||
				effects.length !== operation.prepared_effect_count ||
				effects.length !== operation.settled_effect_count
			)
				return false;
			return effects.every(
				(effect) =>
					(!grouped ||
						historicalWorkspace("file_change_effects", String(effect.id))?.workspacePath ===
							operationWorkspace?.workspacePath) &&
					effect.settlement === "settled" &&
					["changed", "no_change"].includes(String(effect.outcome)) &&
					manifest.references.file_change_scopes?.some(
						(scope) =>
							scope.id === effect.scope_id &&
							scope.device_id === "local" &&
							scope.canonical_root ===
								(grouped ? operationWorkspace?.workspacePath : manifest.mainCheckoutRoot) &&
							(!grouped ||
								historicalWorkspace("file_change_scopes", String(scope.id))?.workspacePath ===
									operationWorkspace?.workspacePath) &&
							scope.source_instance_id === operation.source_instance_id &&
							scope.status === "active" &&
							Number(scope.active_mutation_count) === 0 &&
							scope.active_lease_id === null,
					),
			);
		});
	}
	function retainedJournalDependency(
		history: LegacyRetainedHistoryResult | null,
		table: string,
		column: string,
		targets: string[],
	): boolean {
		if (
			!history ||
			table !== "file_change_operations" ||
			column !== "project_id" ||
			targets.length !== 1 ||
			targets[0] !== history.manifest.projectId ||
			!retainedJournalReferencesOwned(history)
		)
			return false;
		const fk = all('PRAGMA foreign_key_list("file_change_operations")').find(
			(row) => row.from === "project_id" && row.table === "projects",
		);
		if (fk?.on_delete !== "SET NULL") return false;
		const expected = history.manifest.references.file_change_operations ?? [];
		const fields = [...new Set(expected.flatMap((row) => Object.keys(row)))];
		if (!fields.length) fields.push("id");
		const rows = all(
			`SELECT ${boundedProjection(fields)} FROM file_change_operations WHERE project_id=? ORDER BY id LIMIT 201`,
			targets[0],
		);
		return (
			rows.length < 201 &&
			rows.every((row) => {
				const original = expected.find((value) => value.id === row.id);
				return original && fields.every((field) => row[field] === original[field]);
			})
		);
	}
	function unindexedTargetsAbsent(
		table: string,
		column: string,
		targets: readonly string[],
	): boolean {
		// A missing index is not proof that an unrelated project's single row belongs here.
		// Never run a WHERE scan: inspect only a complete bounded column inventory.
		const rows = all(
			`SELECT CASE WHEN length(CAST(${quote(column)} AS BLOB)) > 4096 THEN '__oversized__' ELSE ${quote(column)} END AS target FROM ${quote(table)} LIMIT 201`,
		);
		return (
			rows.length < 201 &&
			rows.every((row) => row.target !== "__oversized__" && !targets.includes(String(row.target)))
		);
	}
	function archivedDependency(
		history: LegacyRetainedHistoryResult | null,
		table: string,
		column: string,
		targets: string[],
	) {
		if (retainedJournalDependency(history, table, column, targets)) return true;
		if (!history || !archivalTables.has(table)) return false;
		const expected = history.manifest.references[table] ?? [];
		const fields = all(`PRAGMA table_info(${quote(table)})`).map((row) => String(row.name));
		const projection = boundedProjection(fields);
		const rows = all(
			`SELECT ${projection} FROM ${quote(table)} WHERE ${quote(column)} IN (${targets.map(() => "?")}) ORDER BY id LIMIT 201`,
			...targets,
		);
		const owned = new Set(history.manifest.chapters.map((row) => String(row.id)));
		return (
			rows.length < 201 &&
			rows.every((row) => {
				if (
					table === "chapter_edges" &&
					(!owned.has(String(row.source_id)) || !owned.has(String(row.target_id)))
				)
					return false;
				if (table === "merge_sessions") {
					try {
						const sources: unknown = JSON.parse(String(row.source_chapter_ids));
						if (
							!owned.has(String(row.target_chapter_id)) ||
							!["completed", "cancelled"].includes(String(row.status)) ||
							!Array.isArray(sources) ||
							sources.some((source) => !owned.has(String(source)))
						)
							return false;
					} catch {
						return false;
					}
				}
				const original = expected.find((value) => value.id === row.id);
				return original && Object.keys(row).every((key) => row[key] === original[key]);
			})
		);
	}
	function retainedLayoutsMatch(history: LegacyRetainedHistoryResult | null): boolean {
		if (!history || !Array.isArray(history.manifest.rawLayouts)) return false;
		const chapters = new Set(history.manifest.chapters.map((row) => String(row.id)));
		const layouts = history.manifest.rawLayouts;
		return (
			layouts.length === chapters.size &&
			new Set(layouts.map((row) => row.sourceChapterId)).size === layouts.length &&
			layouts.every(
				(layout) =>
					chapters.has(layout.sourceChapterId) &&
					[layout.dockLayoutJson, layout.detachedPanelsJson].every(
						(value) => value === null || typeof value === "string",
					) &&
					!!first(
						"SELECT 1 FROM chapters WHERE id=? AND project_id=? AND dock_layout_json IS ? AND detached_panels_json IS ? LIMIT 1",
						layout.sourceChapterId,
						history.manifest.projectId,
						layout.dockLayoutJson,
						layout.detachedPanelsJson,
					),
			)
		);
	}
	function plan(
		id: string,
		actor: MigrationPrincipal,
		history: LegacyRetainedHistoryResult | null = null,
	) {
		const version = (sqlite.query("PRAGMA schema_version").get() as { schema_version: number })
			.schema_version;
		if (version !== schemaVersion) {
			metadataCache.clear();
			schemaVersion = version;
		}
		const project = first(
			"SELECT id,name,git_path,owner_user_id,visibility,legacy_sync_disabled,updated_at,substr(traits,1,16385) AS traits,substr(chapter_settings,1,16385) AS chapter_settings,substr(startup_script,1,16385) AS startup_script,substr(copy_files,1,16385) AS copy_files,substr(proxy_domain,1,16385) AS proxy_domain FROM projects WHERE id=? LIMIT 1",
			id,
		);
		if (!project) throw new NotFoundError("Project", "legacy migration");
		authorize(project, actor);
		const blockers: MigrationBlocker[] = [];
		const block = (code: string, message: string) => {
			if (blockers.length < LIMIT) blockers.push({ code, message });
		};
		if (history && !retainedJournalReferencesOwned(history))
			block(
				"RETAINED_JOURNAL_ORIGIN",
				"Journal operations/effects have unknown, incomplete or foreign project/source ownership.",
			);
		const chapterFields = all('PRAGMA table_info("chapters")')
			.map((row) => String(row.name))
			.filter((field) => !["dock_layout_json", "detached_panels_json"].includes(field));
		const chapterRows = all(
			`SELECT ${boundedProjection(chapterFields)} FROM chapters WHERE project_id=? ORDER BY id LIMIT 200`,
			id,
		);
		if (
			chapterRows.some((row) => Object.values(row).includes("__oversized__")) ||
			Buffer.byteLength(JSON.stringify(chapterRows)) > 2 * 1024 * 1024
		)
			block("CHAPTER_METADATA_BUDGET", "Chapter scalar metadata exceeds retention budget.");
		const layoutsPreserved = retainedLayoutsMatch(history);
		for (const field of ["dock_layout_json", "detached_panels_json"]) {
			if (
				!layoutsPreserved &&
				all('PRAGMA table_info("chapters")').some((row) => row.name === field) &&
				first(
					`SELECT 1 FROM chapters WHERE project_id=? AND ${quote(field)} IS NOT NULL AND ${quote(field)} NOT IN ('','{}','[]','null') LIMIT 1`,
					id,
				)
			)
				block(
					"CHAPTER_LAYOUT",
					"Legacy chapter layout has no retained standalone reference; it will not be discarded.",
				);
		}
		const chapterIds = chapterRows.map((row) => String(row.id));
		// Two indexed paths, deduplicated; neither loads narrator history/configuration payloads.
		const contextRows = all(
			"SELECT id FROM narrators WHERE context_project_id=? ORDER BY id LIMIT 200",
			id,
		);
		const bound = chapterIds.length
			? all(
					`SELECT id FROM narrators WHERE chapter_id IN (${chapterIds.map(() => "?")}) ORDER BY id LIMIT 200`,
					...chapterIds,
				)
			: [];
		let ids = [...new Set([...contextRows, ...bound].map((row) => String(row.id)))].sort();
		// Include unbound descendants too: their ACL/runtime may still delegate to a retiring root.
		for (let depth = 0; ids.length && ids.length < LIMIT; depth++) {
			if (depth === 8) {
				block("DESCENDANT_BUDGET", "Narrator ancestry exceeds the bounded adoption depth.");
				break;
			}
			const placeholders = ids.map(() => "?").join(",");
			const children = all(
				`SELECT id FROM narrators WHERE parent_narrator_id IN (${placeholders}) OR acl_root_narrator_id IN (${placeholders}) ORDER BY id LIMIT 200`,
				...ids,
				...ids,
			);
			if (children.length === LIMIT)
				block("LIMIT_EXCEEDED", "Narrator descendant inventory exceeds safety budget.");
			const expanded = [...new Set([...ids, ...children.map((row) => String(row.id))])].sort();
			if (expanded.length === ids.length) break;
			ids = expanded;
		}
		if (
			chapterRows.length === LIMIT ||
			contextRows.length === LIMIT ||
			bound.length === LIMIT ||
			ids.length >= LIMIT
		)
			block(
				"LIMIT_EXCEEDED",
				"Migration metadata exceeds the 199-item safety budget; no conversion was attempted.",
			);
		const sessions = ids.length
			? all(
					`SELECT id,chapter_id,context_project_id,type,variant,substr(traits,1,16385) AS traits,parent_narrator_id,acl_root_narrator_id,owner_user_id,visibility,write_audience,status,substatus,cwd,workspace_revision,message_version,message_structure_version,next_seq,updated_at,default_device_id,scheduled_task_id,oauth_owner_grant_id,oauth_provision_key,plan_file_id,substr(workspace_context,1,16385) AS workspace_context,workspace_context IS NOT NULL AS has_workspace_context,oauth_policy_snapshot_json IS NOT NULL AS has_oauth_policy FROM narrators WHERE id IN (${ids.map(() => "?")}) ORDER BY id LIMIT 200`,
					...ids,
				)
			: [];
		if (project.visibility !== "private")
			block(
				"PROJECT_SHARED",
				"Public project access cannot yet be preserved; make ownership and sharing explicit first.",
			);
		for (const field of [
			"traits",
			"chapter_settings",
			"startup_script",
			"copy_files",
			"proxy_domain",
		])
			if (meaningful(project[field]))
				block(
					"PROJECT_CONFIGURATION",
					`Project ${field} needs a standalone policy/configuration adapter.`,
				);
		for (const row of sessions) {
			const runtime = deps.runtimeWorkspace?.(String(row.id));
			row.runtime_cwd = runtime?.cwd ?? null;
			row.runtime_device = runtime?.deviceId ?? null;
		}
		for (const chapter of chapterRows) {
			if (
				chapter.worktree_path &&
				chapter.worktree_path !== project.git_path &&
				!deps.linkedWorktreeConsumersReady
			)
				block(
					"LINKED_WORKTREE_NOT_READY",
					"Linked worktree core and consumer rollout is not enabled.",
				);
			if (
				chapter.worktree_path &&
				chapter.worktree_path !== project.git_path &&
				first(
					"SELECT id FROM narrator_worktree_resources WHERE device_id='local' AND worktree_path=? LIMIT 1",
					chapter.worktree_path,
				)
			)
				block(
					"MIGRATION_RESOURCE_CONFLICT",
					"Allocated linked workspace already has registry ownership and cannot be reclassified.",
				);
			if (
				chapter.worktree_path &&
				chapter.worktree_path !== project.git_path &&
				deps.linkedWorktreeConsumersReady &&
				!deps.withRuntimeAdmission
			)
				block(
					"LINKED_RUNTIME_ADMISSION",
					"Linked adoption requires the server runtime lifecycle admission adapter.",
				);
			if (chapter.role === "review")
				block(
					"REVIEW_POLICY",
					`Chapter ${chapter.id} has inherited review/read-only policy; standalone policy adoption is required.`,
				);
			const linkedCandidate =
				deps.linkedWorktreeConsumersReady === true &&
				deps.retainedHistoryConsumersReady === true &&
				!!deps.prepareRootAdoption &&
				!!chapter.worktree_path &&
				chapter.worktree_path !== project.git_path &&
				!chapter.is_root &&
				["active", "dormant"].includes(String(chapter.status));
			if (!chapter.is_root && chapter.status !== "dormant" && !linkedCandidate)
				block(
					"CHAPTER_LIFECYCLE",
					`Chapter ${chapter.id} must be root, dormant, or an explicitly enabled verified linked source.`,
				);
			for (const field of [
				"worktree_path",
				"container_config",
				"snapshot_shadow_key",
				"snapshot_commit_sha",
				"dormant_snapshot_commit_sha",
				"parked_snapshot_commit_sha",
				"merge_snapshot_commit_sha",
				"merged_source_snapshot_sha",
			]) {
				const preserved =
					field !== "container_config" &&
					history?.manifest.chapters.some(
						(source) => source.id === chapter.id && source[field] === chapter[field],
					);
				const adoptable =
					deps.prepareRootAdoption &&
					(field === "worktree_path" || field === "snapshot_shadow_key" || preserved);
				if (meaningful(chapter[field]) && !adoptable)
					block(
						"CHAPTER_RESOURCE",
						`Chapter ${chapter.id} has ${field}; durable resource/history adoption is required.`,
					);
			}
		}
		for (const row of sessions) {
			authorize(row, actor);
			if (!row.owner_user_id || row.visibility !== "private" || row.write_audience !== "owner")
				block(
					"NARRATOR_ACL",
					`Narrator ${row.id} needs an explicit private owner ACL before migration.`,
				);
			if (row.acl_root_narrator_id && !ids.includes(String(row.acl_root_narrator_id)))
				block("EXTERNAL_ACL_ROOT", `Narrator ${row.id} delegates ACL outside this migration.`);
			if (
				(row.context_project_id && row.context_project_id !== id) ||
				(row.chapter_id && !chapterIds.includes(String(row.chapter_id)))
			)
				block("OTHER_PROJECT_CONTEXT", `Narrator ${row.id} has another project/chapter context.`);
			if (
				!["idle", "archived"].includes(String(row.status)) ||
				row.substatus !== "[]" ||
				deps.runtimeBusy(String(row.id))
			)
				block(
					"NARRATOR_BUSY",
					`Narrator ${row.id} is queued, active, cached, or awaiting a safe unload.`,
				);
			if (!deps.prepareRootAdoption && (!row.cwd || !isAbsolute(String(row.cwd))))
				block(
					"CWD_REQUIRED",
					`Narrator ${row.id} needs an explicit valid absolute local cwd; no home fallback is used.`,
				);
			for (const field of [
				"default_device_id",
				"scheduled_task_id",
				"oauth_owner_grant_id",
				"oauth_provision_key",
				"plan_file_id",
				"has_workspace_context",
				"has_oauth_policy",
			])
				if (
					row[field] &&
					!(field === "default_device_id" && row[field] === "local") &&
					!(
						deps.prepareRootAdoption &&
						(field === "has_workspace_context" || field === "plan_file_id")
					)
				)
					block(
						"NARRATOR_BINDING",
						`Narrator ${row.id} has ${field}; a dedicated adoption adapter is required.`,
					);
		}
		// Enumerate every actual FK, not a hand-maintained cascade allow-list. Unknown dependencies block.
		const tables = all(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 200",
		);
		if (tables.length === LIMIT)
			block("SCHEMA_BUDGET", "Database table inventory exceeds safety budget.");
		for (const table of tables) {
			const name = String(table.name);
			const fks = all(`PRAGMA foreign_key_list(${quote(name)})`);
			for (const fk of fks) {
				if (fk.table !== "projects" && fk.table !== "chapters") continue;
				if (name === "chapters" && fk.table === "projects") continue;
				if (name === "narrators" && ["chapter_id", "context_project_id"].includes(String(fk.from)))
					continue;
				const targets = fk.table === "projects" ? [id] : chapterIds;
				if (!targets.length || !first(`SELECT 1 AS found FROM ${quote(name)} LIMIT 1`)) continue;
				const indexes = all(`PRAGMA index_list(${quote(name)})`);
				const indexed = indexes.some(
					(index) =>
						!index.partial &&
						all(`PRAGMA index_info(${quote(String(index.name))})`)[0]?.name === fk.from,
				);
				if (!indexed) {
					if (unindexedTargetsAbsent(name, String(fk.from), targets)) continue;
					block(
						"DEPENDENCY_INDEX",
						`${name}.${fk.from} cannot be safely checked without a covering index.`,
					);
					continue;
				}
				if (archivedDependency(history, name, String(fk.from), targets)) continue;
				if (
					first(
						`SELECT 1 AS found FROM ${quote(name)} WHERE ${quote(String(fk.from))} IN (${targets.map(() => "?")}) LIMIT 1`,
						...targets,
					)
				)
					block(
						"PROJECT_DEPENDENCY",
						`${name}.${fk.from} contains dependent user content or lifecycle metadata; it will not be cascade-deleted.`,
					);
			}
		}
		// Polymorphic references have no FK: ACLs, hooks, bindings and scheduled targets.
		for (const table of tables) {
			const name = String(table.name);
			const columns = all(`PRAGMA table_info(${quote(name)})`).map((row) => String(row.name));
			for (const [column, values] of [
				["scope_id", [id, ...chapterIds, ...ids]],
				["resource_id", [id, ...chapterIds, ...ids]],
				["target_id", [id, ...chapterIds, ...ids]],
				["project_id", [id]],
				["chapter_id", chapterIds],
				[
					"narrator_id",
					/terminal|container|worktree|resource|binding|public.*share|scheduled|mailbox|buffer/.test(
						name,
					)
						? ids
						: [],
				],
			] as const) {
				if (
					!columns.includes(column) ||
					name === "legacy_project_migrations" ||
					name === "chapters" ||
					name === "narrators" ||
					!values.length
				)
					continue;
				if (!first(`SELECT 1 AS found FROM ${quote(name)} LIMIT 1`)) continue;
				const discriminator =
					column === "scope_id" ? "scope_type" : column === "resource_id" ? "resource_type" : null;
				const prefix =
					discriminator && columns.includes(discriminator)
						? `${quote(discriminator)} IN ('project','chapter','narrator') AND `
						: "";
				const query = `SELECT 1 AS found FROM ${quote(name)} WHERE ${prefix}${quote(column)} IN (${values.map(() => "?")}) LIMIT 1`;
				const indexed = all(`EXPLAIN QUERY PLAN ${query}`, ...values).some((row) =>
					String(row.detail).includes("SEARCH"),
				);
				if (!indexed) {
					if (unindexedTargetsAbsent(name, column, values)) continue;
					block("DEPENDENCY_INDEX", `${name}.${column} requires an indexed dependency adapter.`);
					continue;
				}
				if (archivedDependency(history, name, column, [...values])) continue;
				if (first(query, ...values))
					block("EXTERNAL_DEPENDENCY", `${name}.${column} requires explicit preservation.`);
			}
		}
		if (history && tables.some((table) => table.name === "merge_sessions")) {
			const merges = all(
				"SELECT id,target_chapter_id,CASE WHEN length(CAST(source_chapter_ids AS BLOB)) > 65536 THEN NULL ELSE source_chapter_ids END AS source_chapter_ids FROM merge_sessions ORDER BY id LIMIT 201",
			);
			if (merges.length > 200)
				block(
					"MERGE_SOURCE_BUDGET",
					"Cross-project merge sources cannot be completely verified within the retention budget.",
				);
			for (const merge of merges) {
				try {
					const sources: unknown = JSON.parse(String(merge.source_chapter_ids));
					if (!Array.isArray(sources)) throw new Error("Unknown merge sources");
					if (
						sources.some((source) => chapterIds.includes(String(source))) &&
						!chapterIds.includes(String(merge.target_chapter_id))
					)
						block(
							"EXTERNAL_MERGE_SOURCE",
							"A cross-project merge still depends on the retiring chapter.",
						);
				} catch {
					block(
						"UNKNOWN_MERGE_SOURCE",
						"Merge source metadata is unknown; no graph metadata will be removed.",
					);
				}
			}
		}
		const revision = createHash("sha256")
			.update(JSON.stringify({ project, chapterRows, sessions, blockers }))
			.digest("hex");
		return { project, chapterRows, sessions, ids, blockers, revision };
	}
	async function inspectPaths(p: ReturnType<typeof plan>, allowMissingBase = false) {
		const blockers: MigrationBlocker[] = [];
		let archivePath: string | null = null;
		let archiveIdentity: ArchiveIdentity | null = null;
		try {
			for (const row of deps.prepareRootAdoption ? [] : p.sessions) {
				if (!row.cwd) continue;
				const cwd = String(row.cwd);
				if (
					(await realpath(cwd)) !== resolve(cwd) ||
					!(await lstat(cwd)).isDirectory() ||
					cwd.split(/[\\/]/).includes(".worktrees")
				)
					throw new Error(`Narrator ${row.id} cwd is symlinked, invalid or a worktree.`);
				const git = await optionalStat(join(cwd, ".git"));
				if (git?.isFile())
					throw new Error(
						`Narrator ${row.id} cwd uses a worktree without a durable lifecycle claim.`,
					);
			}
			if (p.project.git_path) {
				const root = String(p.project.git_path);
				if ((await realpath(root)) !== resolve(root))
					throw new Error("Repository path contains symlinks.");
				archivePath = await realpath(root);
				const archiveDirectory = join(archivePath, ".narrafork");
				if (deps.mainDatabasePath) {
					const mainPath = await realpath(deps.mainDatabasePath).catch(() =>
						resolve(deps.mainDatabasePath ?? ""),
					);
					if (BACKUP_FILES.some((name) => join(archiveDirectory, name) === mainPath))
						throw new Error(
							"Repository backup path is the primary database; deletion is prohibited.",
						);
				}
				const dir = await optionalStat(archiveDirectory);
				if (
					dir &&
					(!dir.isDirectory() ||
						dir.isSymbolicLink() ||
						(await realpath(archiveDirectory)) !== archiveDirectory)
				)
					throw new Error("Archive directory identity cannot be verified.");
				if (dir && !deps.prepareRootAdoption) {
					const entries = await opendir(archiveDirectory);
					for await (const entry of entries) {
						if (!BACKUP_FILES.includes(entry.name))
							throw new Error(
								"Project-local skills, hooks, snapshots or other archive resources require adoption.",
							);
					}
				}
				archiveIdentity = {
					root: identity(await lstat(root)),
					directory: dir ? identity(dir) : null,
					files: {},
				};
				for (const name of BACKUP_FILES) {
					const file = await optionalStat(join(archiveDirectory, name));
					if (
						file &&
						(!file.isFile() ||
							file.isSymbolicLink() ||
							file.nlink !== 1 ||
							file.size > 2 * 1024 * 1024 * 1024)
					)
						throw new Error("Backup file is not a uniquely owned regular file.");
					archiveIdentity.files[name] = file ? identity(file) : null;
				}
				if (archiveIdentity.files["project.db"]) {
					if (
						!(await validateLegacyProjectBackup(
							join(archiveDirectory, "project.db"),
							String(p.project.id),
						))
					)
						throw new Error(
							"project.db is not a recognizable backup for this project; it will not be deleted.",
						);
				} else if (
					!allowMissingBase &&
					(archiveIdentity.files["project.db-wal"] || archiveIdentity.files["project.db-shm"])
				)
					throw new Error(
						"Orphan backup sidecars cannot be authorized without the matching project database.",
					);
				const aliases = all(
					"SELECT id,git_path FROM projects WHERE git_path IS NOT NULL ORDER BY id LIMIT 200",
				);
				if (aliases.length === LIMIT)
					throw new Error("Physical repository alias inventory exceeds safety budget.");
				for (const alias of aliases)
					if (
						alias.id !== p.project.id &&
						(await realpath(String(alias.git_path)).catch(() => null)) === (await realpath(root))
					)
						throw new Error("Another project shares the physical repository archive.");
			}
		} catch (error) {
			blockers.push({
				code: "FILESYSTEM_RESOURCE",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return { archivePath, archiveIdentity, blockers };
	}
	type PreparedAdoption = LegacyRootAdoptionResult & { inspectedChanges: number };
	const mutationCounter = () => Number(first("SELECT total_changes() AS changes").changes);
	async function prepareAdoption(p: ReturnType<typeof plan>): Promise<PreparedAdoption | null> {
		if (!deps.prepareRootAdoption || (!p.ids.length && !p.chapterRows.length)) return null;
		if (!deps.mainDatabasePath)
			throw new AppError(
				"Root adoption requires a verified database snapshot",
				503,
				"MIGRATION_HISTORY_UNAVAILABLE",
			);
		const changes = mutationCounter();
		const input: LegacyRootAdoptionInput = {
			// The known one-way sync update is not a workspace/history identity change.
			project: { ...p.project, legacy_sync_disabled: 0, updated_at: null },
			chapters: p.chapterRows,
			sessions: p.sessions,
			databasePath: deps.mainDatabasePath,
			retainHistory: deps.retainedHistoryConsumersReady === true,
			linkedWorktreesReady: deps.linkedWorktreeConsumersReady === true,
		};
		const prepare = deps.prepareRootAdoption;
		const linkedInventory = p.chapterRows.some(
			(row) => row.worktree_path && row.worktree_path !== p.project.git_path,
		);
		const prepareReserved = async () => {
			if (!linkedInventory || !deps.linkedWorktreeConsumersReady) return prepare(input);
			const paths = new Set<string>();
			for (const path of [p.project.git_path, ...p.chapterRows.map((row) => row.worktree_path)]) {
				if (typeof path !== "string" || !isAbsolute(path)) continue;
				paths.add(path);
				paths.add(join(path, ".git"));
				paths.add(treeSnapshotPhysicalDir("local", path));
			}
			for (const chapter of p.chapterRows) {
				if (!/^[a-zA-Z0-9_-]+$/.test(String(chapter.id)))
					throw new AppError("Invalid linked artifact source", 409, "MIGRATION_ADOPTION_INVALID");
				paths.add(getNarraforkPath("dormant-ignored", String(chapter.id)));
			}
			const targets = [...paths].map((path) => ({ deviceId: "local", path }));
			const admit = deps.withWorkspaceAdmission ?? withWorkspaceAdmission;
			return admit(targets, async () => {
				const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
				return admit(canonical, async () => {
					let held = true;
					input.assertLinkedAdmissionReady = () => {
						if (
							!held ||
							deps.linkedWorktreeConsumersReady !== true ||
							deps.retainedHistoryConsumersReady !== true
						)
							throw new AppError(
								"Linked source readiness/reservation is unavailable",
								409,
								"MIGRATION_ADOPTION_INVALID",
							);
						for (const target of [...targets, ...canonical]) assertWorkspaceAdmission(target);
					};
					try {
						return await prepare(input);
					} finally {
						held = false;
					}
				});
			});
		};
		const adoption = await prepareReserved();
		if (
			!adoption.blockers.length &&
			((adoption.history.status !== "empty" && !retainedResult(adoption)) ||
				!/^[a-f0-9]{64}$/.test(adoption.history.digest) ||
				adoption.updates.length !== p.ids.length ||
				new Set(adoption.updates.map((update) => update.id)).size !== p.ids.length ||
				adoption.updates.some((update) => !p.ids.includes(update.id)))
		)
			throw new AppError("Root adoption evidence is incomplete", 409, "MIGRATION_ADOPTION_INVALID");
		if (
			!adoption.blockers.length &&
			adoption.linkedWorktrees?.length &&
			(!deps.linkedWorktreeConsumersReady || !retainedResult(adoption))
		)
			throw new AppError(
				"Linked adoption is not enabled or lacks complete retained proof",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		if (!adoption.blockers.length) {
			const retained = retainedResult(adoption);
			if (retained) {
				try {
					for (const update of adoption.updates) {
						const linked = adoption.linkedWorktrees?.find((entry) =>
							entry.narratorIds.includes(update.id),
						);
						retainedOriginJson(
							retained,
							adoption,
							update.id,
							linked ? worktreeResourceId("local", linked.evidence.top) : undefined,
						);
					}
				} catch (error) {
					if ((error as { code?: string }).code !== "ADOPTION_BUDGET") throw error;
					adoption.blockers.push({
						code: "ADOPTION_BUDGET",
						message: error instanceof Error ? error.message : String(error),
					});
					adoption.updates = [];
				}
			}
		}
		if (!adoption.blockers.length && changes !== mutationCounter())
			throw new AppError(
				"Database evidence changed while inspecting root history",
				409,
				"MIGRATION_STALE",
			);
		return { ...adoption, inspectedChanges: mutationCounter() };
	}

	function verifyRetainedReferences(history: LegacyRetainedHistoryResult) {
		const deadline = performance.now() + 200;
		const checkDeadline = () => {
			if (performance.now() > deadline)
				throw new AppError(
					"Retained history guard exceeds the bounded commit budget",
					409,
					"MIGRATION_HISTORY_BUDGET",
				);
		};
		const manifest = history.manifest;
		if (!retainedLayoutsMatch(history))
			throw new AppError("Retained raw layout evidence changed", 409, "MIGRATION_STALE");
		const aliases = all(
			"SELECT id, CASE WHEN length(CAST(git_path AS BLOB)) > 4096 THEN '__oversized__' ELSE git_path END AS git_path FROM projects WHERE git_path IS NOT NULL ORDER BY id LIMIT 201",
		);
		if (aliases.length > 200)
			throw new AppError("Repository alias guard budget exceeded", 409, "MIGRATION_HISTORY_BUDGET");
		for (const alias of aliases) {
			checkDeadline();
			if (alias.id === manifest.projectId) continue;
			if (alias.git_path === "__oversized__")
				throw new AppError("Repository alias metadata is unknown", 409, "MIGRATION_STALE");
			let canonical: string;
			try {
				canonical = realpathSync(String(alias.git_path));
			} catch {
				continue;
			}
			if (
				normalizePathForComparison(canonical) ===
				normalizePathForComparison(manifest.mainCheckoutRoot)
			)
				throw new AppError("Repository alias changed during adoption", 409, "MIGRATION_STALE");
		}
		if (!manifest.databaseIdentity || manifest.databaseIdentity.path !== deps.mainDatabasePath)
			throw new AppError("Database identity is missing", 409, "MIGRATION_STALE");
		const sourceDb = lstatSync(manifest.databaseIdentity.path, { bigint: true });
		if (
			sourceDb.isSymbolicLink() ||
			String(sourceDb.dev) !== manifest.databaseIdentity.dev ||
			String(sourceDb.ino) !== manifest.databaseIdentity.ino ||
			String(sourceDb.birthtimeNs) !== manifest.databaseIdentity.birthtimeNs
		)
			throw new AppError("Database identity changed", 409, "MIGRATION_STALE");
		const gitEntries = manifest.workspaces?.length
			? manifest.workspaces.flatMap((workspace) => workspace.gitIdentity.entries)
			: (manifest.gitIdentity?.entries ?? []);
		const uniqueGitEntries = new Map<string, Row>();
		const nonPathGitEntries: Row[] = [];
		for (const entry of gitEntries) {
			if (typeof entry.path !== "string" || entry.dev == null || entry.ino == null) {
				nonPathGitEntries.push(entry);
				continue;
			}
			const path = entry.path;
			const previous = uniqueGitEntries.get(path);
			if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
				throw new AppError(
					"Shared Git metadata identity changed between workspace groups",
					409,
					"MIGRATION_STALE",
				);
			uniqueGitEntries.set(path, entry);
		}
		const physicalEntries = [
			...nonPathGitEntries,
			...uniqueGitEntries.values(),
			...manifest.assets.flatMap((asset) => asset.identity.entries),
		];
		if (physicalEntries.length > 2048)
			throw new AppError("Physical identity guard budget exceeded", 409, "MIGRATION_STALE");
		let hashedBytes = 0;
		for (const entry of physicalEntries) {
			checkDeadline();
			if (entry.dev == null || entry.ino == null) continue;
			const current = lstatSync(String(entry.path));
			if (
				current.isSymbolicLink() ||
				["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(
					(field) => entry[field] !== current[field as "dev"],
				)
			)
				throw new AppError("Retained physical history identity changed", 409, "MIGRATION_STALE");
			if (entry.bytesDigest) {
				hashedBytes += current.size;
				if (current.size > 65536 || hashedBytes > 256 * 1024)
					throw new AppError("Retained Git metadata guard budget exceeded", 409, "MIGRATION_STALE");
				const fd = openSync(String(entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					const before = fstatSync(fd);
					if (
						before.dev !== current.dev ||
						before.ino !== current.ino ||
						before.size !== current.size
					)
						throw new AppError("Git descriptor identity changed", 409, "MIGRATION_STALE");
					const data = Buffer.alloc(current.size + 1);
					const length = readSync(fd, data, 0, data.length, 0);
					const after = fstatSync(fd);
					if (
						length !== current.size ||
						after.mtimeMs !== before.mtimeMs ||
						after.ctimeMs !== before.ctimeMs ||
						after.size !== before.size ||
						createHash("sha256").update(data.subarray(0, length)).digest("hex") !==
							entry.bytesDigest
					)
						throw new AppError("Retained Git metadata changed", 409, "MIGRATION_STALE");
				} finally {
					closeSync(fd);
				}
			}
		}
		const narratorIds = manifest.narratorOrigins.map((origin) => origin.narratorId);
		const chapterIds = manifest.chapters.map((row) => String(row.id));
		const messageIds = (manifest.references.narrator_messages ?? []).map((row) => String(row.id));
		const scopeIds = (manifest.references.file_change_scopes ?? []).map((row) => String(row.id));
		const workspacePaths = [
			...new Set(
				manifest.workspaces?.length
					? manifest.workspaces.map((workspace) => workspace.workspacePath)
					: [manifest.mainCheckoutRoot],
			),
		];
		let bytes = 0;
		for (const [table, expected] of Object.entries(manifest.references)) {
			if (table === "artifact_inventory") {
				for (const entry of expected) {
					try {
						lstatSync(String(entry.id));
						if (!entry.exists)
							throw new AppError(
								"History artifact appeared after inspection",
								409,
								"MIGRATION_STALE",
							);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entry.exists) throw error;
					}
				}
				continue;
			}
			const schema = all(`PRAGMA table_info(${quote(table)})`).map((row) => String(row.name));
			const fields = [...new Set(expected.flatMap((row) => Object.keys(row)))];
			// Empty inventories still need insertion checks, but must not project bodies.
			const primary = table === "workspace_write_leases" ? "lease_id" : "id";
			if (!fields.length) fields.push(primary);
			const clauses: string[] = [];
			const params: SQLQueryBindings[] = [];
			for (const [field, values] of [
				["narrator_id", narratorIds],
				["message_id", messageIds],
				["scope_id", scopeIds],
				["chapter_id", chapterIds],
				["source_id", chapterIds],
				["target_id", chapterIds],
				["target_chapter_id", chapterIds],
				["canonical_root", workspacePaths],
				["worktree_path", workspacePaths],
				["workspace_path", workspacePaths],
			] as const) {
				if (schema.includes(field) && values.length) {
					const pathField = ["canonical_root", "worktree_path", "workspace_path"].includes(field);
					const deviceGuard =
						pathField && schema.includes("device_id") ? "device_id='local' AND " : "";
					clauses.push(`(${deviceGuard}${quote(field)} IN (${values.map(() => "?")}))`);
					params.push(...values);
				}
			}
			if (expected.length) {
				clauses.push(`${quote(primary)} IN (${expected.map(() => "?")})`);
				params.push(...expected.map((row) => String(row.id ?? row[primary])));
			}
			if (!clauses.length) continue;
			const sourceFields = fields.map((field) =>
				field === "id" && primary !== "id" ? primary : field,
			);
			const size = sourceFields
				.map((field) => `coalesce(length(CAST(${quote(field)} AS BLOB)),0)`)
				.join("+");
			const projection = fields
				.map(
					(field, index) =>
						`CASE WHEN (${size}) > 65536 THEN '__oversized__' ELSE ${quote(sourceFields[index])} END AS ${quote(field)}`,
				)
				.join(",");
			const originals = new Map(expected.map((row) => [String(row.id ?? row[primary]), row]));
			let cursor = "";
			let count = 0;
			while (true) {
				checkDeadline();
				const rows = all(
					`SELECT ${projection} FROM ${quote(table)} WHERE (${clauses.join(" OR ")}) AND ${quote(primary)} > ? ORDER BY ${quote(primary)} LIMIT 16`,
					...params,
					cursor,
				);
				for (const row of rows) {
					bytes += Buffer.byteLength(JSON.stringify(row));
					const original = originals.get(String(row.id ?? row[primary]));
					if (
						++count > expected.length ||
						bytes > 2 * 1024 * 1024 ||
						!original ||
						fields.some((field) => row[field] !== original[field])
					)
						throw new AppError("Retained history references changed", 409, "MIGRATION_STALE");
				}
				if (rows.length < 16) break;
				cursor = String(rows[rows.length - 1].id ?? rows[rows.length - 1][primary]);
			}
			if (count !== expected.length)
				throw new AppError("Retained history references changed", 409, "MIGRATION_STALE");
		}
	}
	/** Bounded source handles survive the complete SQLite transaction; never follow a Git metadata link. */
	function holdLinkedMetadata(adoption: PreparedAdoption | null) {
		const files: Array<{
			fd: number;
			fact: NonNullable<
				LegacyRootAdoptionResult["linkedWorktrees"]
			>[number]["evidence"]["metadata"][number];
		}> = [];
		const started = performance.now();
		let bytes = 0;
		const checkBudget = () => {
			if (files.length > 128 || bytes > 1024 * 1024 || performance.now() - started > 20)
				throw new AppError("Linked source descriptor budget exceeded", 409, "MIGRATION_STALE");
		};
		const close = () => {
			for (const file of files) closeSync(file.fd);
		};
		const verify = () => {
			const checkStarted = performance.now();
			for (const { fd, fact } of files) {
				if (performance.now() - checkStarted > 20)
					throw new AppError("Linked source CAS exceeded budget", 409, "MIGRATION_STALE");
				const stat = fstatSync(fd, { bigint: true });
				const pathStat = lstatSync(fact.path, { bigint: true });
				if (
					!stat.isFile() ||
					!pathStat.isFile() ||
					pathStat.isSymbolicLink() ||
					String(stat.dev) !== fact.dev ||
					String(stat.ino) !== fact.ino ||
					String(stat.size) !== fact.size ||
					String(stat.mtimeNs) !== fact.mtimeNs ||
					String(stat.ctimeNs) !== fact.ctimeNs ||
					stat.dev !== pathStat.dev ||
					stat.ino !== pathStat.ino ||
					stat.size !== pathStat.size ||
					stat.mtimeNs !== pathStat.mtimeNs ||
					stat.ctimeNs !== pathStat.ctimeNs
				)
					throw new AppError("Held linked metadata identity changed", 409, "MIGRATION_STALE");
				const buffer = Buffer.alloc(Number(stat.size) + 1);
				let offset = 0;
				while (offset < buffer.length) {
					const size = readSync(fd, buffer, offset, buffer.length - offset, offset);
					if (!size) break;
					offset += size;
				}
				if (
					offset !== Number(stat.size) ||
					createHash("sha256").update(buffer.subarray(0, offset)).digest("hex") !==
						fact.contentDigest
				)
					throw new AppError("Held linked metadata content changed", 409, "MIGRATION_STALE");
			}
		};
		try {
			const seen = new Set<string>();
			for (const linked of adoption?.linkedWorktrees ?? []) {
				assertLegacyLinkedWorktreeIdentityUnchangedSync(linked.evidence);
				for (const fact of linked.evidence.metadata) {
					if (fact.kind !== "file" || seen.has(fact.path)) continue;
					if (!fact.contentDigest || !/^\d+$/.test(fact.size ?? ""))
						throw new AppError("Linked source content evidence missing", 409, "MIGRATION_STALE");
					bytes += Number(fact.size);
					checkBudget();
					const fd = openSync(
						fact.path,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					files.push({ fd, fact });
					seen.add(fact.path);
				}
			}
			checkBudget();
			return { verify, close };
		} catch (error) {
			close();
			throw error;
		}
	}
	function retainedOriginJson(
		retained: LegacyRetainedHistoryResult,
		adoption: LegacyRootAdoptionResult,
		narratorId: string,
		resourceId?: string,
	): string {
		const origins = retained.manifest.narratorOrigins.filter(
			(value) => value.narratorId === narratorId,
		);
		if (origins.length !== 1)
			throw new AppError("Retained origin missing or ambiguous", 409, "MIGRATION_ADOPTION_INVALID");
		const origin = origins[0];
		const chapter = retained.manifest.chapters.find((value) => value.id === origin.sourceChapterId);
		const linked = adoption.linkedWorktrees?.find((entry) =>
			entry.narratorIds.includes(narratorId),
		);
		if (!!resourceId !== !!linked)
			throw new AppError(
				"Linked proof resource association missing",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		const grouped = !!adoption.linkedWorktrees?.length;
		if (grouped && !Array.isArray(retained.manifest.historyOrigins))
			throw new AppError(
				"Physical history origin mapping missing",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		const sourceScopeIds = new Set(
			grouped
				? retained.manifest.historyOrigins
						.filter(
							(entry) =>
								entry.table === "file_change_scopes" &&
								entry.workspacePath === origin.workspacePath &&
								!!origin.sourceChapterId &&
								entry.sourceChapterIds.includes(origin.sourceChapterId),
						)
						.map((entry) => entry.id)
				: [],
		);
		if (
			grouped &&
			(retained.manifest.references.file_change_scopes ?? []).some(
				(entry) =>
					entry.device_id === "local" &&
					typeof entry.canonical_root === "string" &&
					normalizePathForComparison(entry.canonical_root) ===
						normalizePathForComparison(origin.workspacePath) &&
					!sourceScopeIds.has(String(entry.id)),
			)
		)
			throw new AppError(
				"Physical scope origin mapping is missing",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		const scopeIds = (retained.manifest.references.file_change_scopes ?? [])
			.filter((entry) => !grouped || sourceScopeIds.has(String(entry.id)))
			.map((entry) => entry.id);
		if (
			scopeIds.length > LEGACY_RETAINED_HISTORY_LIMITS.rows ||
			new Set(scopeIds).size !== scopeIds.length ||
			scopeIds.some((id) => typeof id !== "string" || !id || id.length > 1024)
		)
			throw new AppError(
				"Retained adoption scope IDs exceed the shared row/1024-character limit or contain duplicates",
				409,
				"ADOPTION_BUDGET",
			);
		const json = JSON.stringify({
			version: 1,
			origin,
			shadowKey: chapter?.snapshot_shadow_key ?? null,
			scopeIds,
			...(linked && resourceId
				? {
						linkedWorktree: {
							resourceId,
							ownershipRevision: 0,
							evidenceDigest: linked.evidence.digest,
							commonDirectoryPath: linked.evidence.common,
							gitAdminDirectoryPath: linked.evidence.adminDir,
						},
					}
				: {}),
			manifestDigest: retained.digest,
		});
		if (Buffer.byteLength(json) > 65536)
			throw new AppError(
				"Retained adoption origin JSON exceeds the 64KiB limit",
				409,
				"ADOPTION_BUDGET",
			);
		return json;
	}
	/** Called only inside the receipt/context CAS transaction; never allocates or registers Git state. */
	function persistLinkedResources(
		p: ReturnType<typeof plan>,
		adoption: PreparedAdoption | null,
		now: string,
	) {
		const resourceByNarrator = new Map<string, string>();
		if (!adoption?.linkedWorktrees?.length) return resourceByNarrator;
		const retained = retainedResult(adoption);
		if (
			!deps.linkedWorktreeConsumersReady ||
			!retained ||
			!p.project.owner_user_id ||
			p.project.visibility !== "private"
		)
			throw new AppError(
				"Linked history/consumer readiness is missing",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		if (
			!Array.isArray(retained.manifest.workspaces) ||
			retained.manifest.workspaces.length !== adoption.linkedWorktrees.length + 1 ||
			!retained.manifest.workspaces.some(
				(workspace) =>
					workspace.kind === "root" &&
					workspace.workspacePath === p.project.git_path &&
					workspace.sourceChapterIds.length ===
						p.chapterRows.filter((row) => row.worktree_path === p.project.git_path).length &&
					p.chapterRows
						.filter((row) => row.worktree_path === p.project.git_path)
						.every((row) => workspace.sourceChapterIds.includes(String(row.id))),
			)
		)
			throw new AppError(
				"Retained workspace group inventory changed",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		for (const linked of adoption.linkedWorktrees) {
			const evidence = linked.evidence;
			const workspace = retained.manifest.workspaces.find(
				(group) => group.kind === "linked" && group.workspacePath === evidence.top,
			);
			if (
				!workspace ||
				workspace.sourceChapterIds.length !== 1 ||
				workspace.sourceChapterIds[0] !== linked.sourceChapterId ||
				workspace.commonDirectoryPath !== evidence.common ||
				workspace.gitAdminDirectoryPath !== evidence.adminDir ||
				workspace.gitfilePath !== evidence.gitfile ||
				workspace.branch !== evidence.branch ||
				workspace.headCommitSha !== evidence.head ||
				workspace.linkedEvidence?.digest !== evidence.digest ||
				workspace.linkedEvidence.metadataManifestDigest !== evidence.metadataManifestDigest
			)
				throw new AppError(
					"Retained linked identity binding changed",
					409,
					"MIGRATION_ADOPTION_INVALID",
				);
			const source = p.chapterRows.find((row) => row.id === linked.sourceChapterId);
			const members = p.sessions.filter((row) => row.chapter_id === linked.sourceChapterId);
			const updates = adoption.updates.filter((update) => linked.narratorIds.includes(update.id));
			const evidenceJson = JSON.stringify(evidence);
			const expectedContext = legacyLocalWorkspaceContext(
				evidence.top,
				0,
				String(p.project.id),
				evidence.top,
				evidence.common,
			);
			const repositoryKey = expectedContext.git?.repositoryKey;
			if (!repositoryKey)
				throw new AppError("Linked repository key missing", 409, "MIGRATION_ADOPTION_INVALID");
			if (
				!source ||
				source.worktree_path !== evidence.top ||
				source.is_root ||
				!["active", "dormant"].includes(String(source.status)) ||
				evidence.branch !==
					(String(source.branch).startsWith("refs/heads/")
						? source.branch
						: `refs/heads/${source.branch}`) ||
				evidence.projectRoot !== p.project.git_path ||
				Buffer.byteLength(evidenceJson) > 16384 ||
				!members.length ||
				members.length !== linked.narratorIds.length ||
				updates.length !== members.length ||
				new Set(linked.narratorIds).size !== members.length ||
				members.some(
					(row) =>
						!linked.narratorIds.includes(String(row.id)) ||
						row.owner_user_id !== p.project.owner_user_id ||
						row.visibility !== "private" ||
						row.write_audience !== "owner" ||
						row.type !== "primary" ||
						row.variant !== "primary" ||
						!!row.parent_narrator_id ||
						!!row.acl_root_narrator_id ||
						!!row.runtime_cwd ||
						!!row.runtime_device ||
						!["idle", "archived"].includes(String(row.status)),
				) ||
				updates.some(
					(update) =>
						update.current.cwd !== evidence.top ||
						!update.current.git ||
						update.current.git.rootPath !== evidence.top ||
						update.current.git.repositoryKey !== repositoryKey ||
						update.current.git.workspaceKey !== expectedContext.git?.workspaceKey ||
						update.current.contextKey !== expectedContext.contextKey,
				)
			)
				throw new AppError(
					"Linked claimant/source evidence is incomplete",
					409,
					"MIGRATION_ADOPTION_INVALID",
				);
			if (
				first(
					"SELECT id FROM narrator_worktree_resources WHERE device_id='local' AND worktree_path=? LIMIT 1",
					evidence.top,
				)
			)
				throw new AppError(
					"Linked workspace already has registry ownership; no evidence may be overwritten",
					409,
					"MIGRATION_RESOURCE_CONFLICT",
				);
			assertLegacyLinkedWorktreeIdentityUnchangedSync(evidence);
			const resourceId = worktreeResourceId("local", evidence.top);
			sqlite
				.query(
					"INSERT INTO narrator_worktree_resources (id,owner_narrator_id,scope_kind,scope_project_id,scope_owner_user_id,ownership_revision,device_id,repository_key,worktree_path,state,create_request_id,created_at,updated_at) VALUES (?,NULL,'standalone',NULL,?,0,'local',?,?,'ready',?,?,?)",
				)
				.run(
					resourceId,
					p.project.owner_user_id,
					repositoryKey,
					evidence.top,
					`legacy-linked:${p.project.id}:${source.id}`,
					now,
					now,
				);
			sqlite
				.query(
					"INSERT INTO narrator_worktree_resource_origins (resource_id,migration_project_id,source_chapter_id,device_id,common_directory_path,git_admin_directory_path,evidence_json,evidence_digest,created_at) VALUES (?,?,?,'local',?,?,?,?,?)",
				)
				.run(
					resourceId,
					p.project.id,
					source.id,
					evidence.common,
					evidence.adminDir,
					evidenceJson,
					evidence.digest,
					now,
				);
			for (const member of members) {
				resourceByNarrator.set(String(member.id), resourceId);
				sqlite
					.query(
						"INSERT INTO narrator_worktree_resource_claims (id,resource_id,migration_project_id,source_chapter_id,narrator_id,owner_user_id,state,ownership_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,'claimed',0,?,?)",
					)
					.run(
						generateId(),
						resourceId,
						p.project.id,
						source.id,
						member.id,
						member.owner_user_id,
						now,
						now,
					);
			}
		}
		return resourceByNarrator;
	}
	function verifyAdoptionGuards(adoption: PreparedAdoption | null) {
		if (!adoption) return;
		if (mutationCounter() !== adoption.inspectedChanges)
			throw new AppError("History evidence changed before adoption commit", 409, "MIGRATION_STALE");
		if (
			!adoption.history.guards?.length ||
			adoption.history.guards.length > 256 ||
			adoption.updates.some(
				(update) => !adoption.history.guards?.some((guard) => guard.id === update.id),
			)
		)
			throw new AppError("History revision evidence is missing", 409, "MIGRATION_STALE");
		const retained = retainedResult(adoption);
		if (retained) verifyRetainedReferences(retained);
		for (const update of adoption.updates) {
			const paths = [
				...new Set([update.current.cwd, normalizePathForComparison(update.current.cwd)]),
			];
			const placeholders = paths.map(() => "?").join(",");
			if (
				!retained &&
				(first(
					`SELECT 1 FROM file_change_scopes WHERE device_id='local' AND canonical_root IN (${placeholders}) LIMIT 1`,
					...paths,
				) ||
					first(
						`SELECT 1 FROM worktree_tree_snapshots WHERE device_id='local' AND worktree_path IN (${placeholders}) LIMIT 1`,
						...paths,
					))
			)
				throw new AppError("Workspace history appeared after inspection", 409, "MIGRATION_STALE");
		}
		for (const guard of adoption.history.guards) {
			const current = first(
				"SELECT message_version,message_structure_version,next_seq FROM narrators WHERE id=? LIMIT 1",
				guard.id,
			);
			if (
				!current ||
				current.message_version !== guard.messageVersion ||
				current.message_structure_version !== guard.messageStructureVersion ||
				current.next_seq !== guard.nextSeq
			)
				throw new AppError("History changed after adoption inspection", 409, "MIGRATION_STALE");
		}
	}
	const previewRevision = (
		p: ReturnType<typeof plan>,
		fs: Awaited<ReturnType<typeof inspectPaths>>,
		adoption: LegacyRootAdoptionResult | null = null,
	) =>
		createHash("sha256")
			.update(
				JSON.stringify({
					metadata: p.revision,
					archivePath: fs.archivePath,
					archiveIdentity: fs.archiveIdentity,
					blockers: fs.blockers,
					adoption: adoption?.digest ?? null,
					adoptionBlockers: adoption?.blockers ?? [],
				}),
			)
			.digest("hex");
	async function preview(id: string, actor: MigrationPrincipal) {
		const existing = receipt(id);
		if (existing) {
			authorize(existing, actor, true);
			return {
				projectId: id,
				projectName: existing.project_name,
				syncDisabled: true,
				syncDrained: existing.phase === "completed" || deps.syncInFlight?.(id) === false,
				phase: existing.phase,
				canMigrate: existing.phase === "cleanup_pending",
				narratorCount: (JSON.parse(String(existing.narrator_ids)) as string[]).length,
				chapterCount: Object.keys(JSON.parse(String(existing.chapter_targets))).length,
				blockers: [] as MigrationBlocker[],
				revision: String(existing.revision),
			};
		}
		let p = plan(id, actor);
		const fs = await inspectPaths(p);
		const adoption = await prepareAdoption(p);
		if (retainedResult(adoption)) p = plan(id, actor, retainedResult(adoption));
		const blockers = [...p.blockers, ...fs.blockers, ...(adoption?.blockers ?? [])];
		return {
			projectId: id,
			projectName: p.project.name,
			syncDisabled: !!p.project.legacy_sync_disabled,
			syncDrained: !!p.project.legacy_sync_disabled && deps.syncInFlight?.(id) === false,
			phase: blockers.length ? "blocked" : "none",
			canMigrate: !blockers.length,
			narratorCount: p.ids.length,
			chapterCount: p.chapterRows.length,
			blockers,
			revision: previewRevision(p, fs, adoption),
		};
	}
	function savedRetainedHistory(id: string): LegacyRetainedHistoryResult | null {
		const stored = first(
			"SELECT CASE WHEN length(CAST(manifest_json AS BLOB)) > 2097152 THEN NULL ELSE manifest_json END AS manifest_json,manifest_digest FROM legacy_retained_history_manifests WHERE migration_project_id=? LIMIT 1",
			id,
		);
		if (!stored) return null;
		if (
			typeof stored.manifest_json !== "string" ||
			!/^[a-f0-9]{64}$/.test(String(stored.manifest_digest))
		)
			throw new AppError(
				"Saved retained history evidence is unavailable",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		const manifest = JSON.parse(stored.manifest_json) as LegacyRetainedHistoryResult["manifest"];
		if (
			manifest.version !== 1 ||
			manifest.projectId !== id ||
			!manifest.references ||
			!Array.isArray(manifest.chapters) ||
			!Array.isArray(manifest.narratorOrigins) ||
			!Array.isArray(manifest.rawLayouts)
		)
			throw new AppError(
				"Saved retained history evidence is incomplete",
				409,
				"MIGRATION_ADOPTION_INVALID",
			);
		return {
			status: "retained",
			complete: true,
			digest: String(stored.manifest_digest),
			guards: [],
			manifest,
		};
	}
	async function cleanup(id: string, actor: MigrationPrincipal): Promise<MigrationResult> {
		const r = receipt(id);
		if (!r) throw new NotFoundError("Migration", id);
		authorize(r, actor, true);
		if (r.phase === "completed") return cleanupUnlocked(id, actor);
		// Durable small projections survive deletion of every narrator; never read evidence_json in cleanup.
		const origins = all(
			"SELECT o.device_id,o.common_directory_path,o.git_admin_directory_path,o.source_chapter_id,r.worktree_path FROM narrator_worktree_resource_origins o JOIN narrator_worktree_resources r ON r.id=o.resource_id WHERE o.migration_project_id=? ORDER BY o.resource_id LIMIT 129",
			id,
		);
		if (!origins.length) return cleanupUnlocked(id, actor);
		try {
			if (origins.length > 128)
				throw new Error("Linked cleanup inventory exceeds its admission budget");
			const paths = new Set<string>();
			for (const origin of origins) {
				if (
					origin.device_id !== "local" ||
					!/^[a-zA-Z0-9_-]+$/.test(String(origin.source_chapter_id))
				)
					throw new Error("Linked cleanup source identity is unavailable");
				for (const path of [
					origin.common_directory_path,
					origin.git_admin_directory_path,
					origin.worktree_path,
				]) {
					if (
						typeof path !== "string" ||
						!isAbsolute(path) ||
						path.length > 4096 ||
						/[\0\r\n]/.test(path)
					)
						throw new Error("Linked cleanup has an unknown physical dependency");
					paths.add(path);
				}
				paths.add(treeSnapshotPhysicalDir("local", String(origin.worktree_path)));
				paths.add(getNarraforkPath("dormant-ignored", String(origin.source_chapter_id)));
			}
			if (typeof r.git_path !== "string" || !isAbsolute(r.git_path))
				throw new Error("Linked cleanup main root is missing");
			paths.add(r.git_path);
			paths.add(treeSnapshotPhysicalDir("local", r.git_path));
			const history = savedRetainedHistory(id);
			if (!history) throw new Error("Linked cleanup retained manifest is missing");
			for (const path of [
				...history.manifest.assets.map((asset) => asset.artifactPath),
				...(history.manifest.references.artifact_inventory ?? []).map((row) => String(row.id)),
			]) {
				if (!isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path))
					throw new Error("Unknown retained cleanup artifact");
				paths.add(path);
			}
			const targets = [...paths].map((path) => ({ deviceId: "local", path }));
			const admit = deps.withWorkspaceAdmission ?? withWorkspaceAdmission;
			return await admit(targets, async () => {
				const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
				return admit(canonical, () => cleanupUnlocked(id, actor));
			});
		} catch (error) {
			return {
				phase: String(r.phase),
				narratorIds: JSON.parse(String(r.narrator_ids)),
				syncDisabled: true,
				blockers: [
					{
						code: "CLEANUP_PENDING",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}
	async function cleanupUnlocked(id: string, actor: MigrationPrincipal) {
		const r = receipt(id);
		if (!r) throw new NotFoundError("Migration", id);
		authorize(r, actor, true);
		const result = {
			phase: String(r.phase),
			narratorIds: JSON.parse(String(r.narrator_ids)) as string[],
			syncDisabled: true as const,
		};
		if (r.phase === "completed") return result;
		const drained = await deps.disableSync(id);
		if (!drained.drained)
			return {
				...result,
				blockers: [
					{ code: "SYNC_DRAIN_PENDING", message: "Legacy backup writers have not drained." },
				],
			};
		try {
			const history = savedRetainedHistory(id);
			const currentPlan = plan(id, actor, history);
			const currentPaths = await inspectPaths(
				currentPlan,
				!!r.archive_identity_json &&
					!!(JSON.parse(String(r.archive_identity_json)) as ArchiveIdentity).files["project.db"],
			);
			if (
				currentPlan.ids.length ||
				currentPlan.chapterRows.length ||
				currentPlan.blockers.length ||
				currentPaths.blockers.length ||
				currentPaths.archivePath !== r.archive_path
			)
				throw new Error(
					"Cleanup dependencies or archive identity changed; retaining project and backups.",
				);
			if (r.archive_path) {
				if (!r.archive_identity_json || !currentPaths.archiveIdentity)
					throw new Error(
						"Persisted archive identity is missing; cleanup requires operator reconciliation.",
					);
				const expected = JSON.parse(String(r.archive_identity_json)) as ArchiveIdentity;
				const observed = currentPaths.archiveIdentity;
				if (
					!sameIdentity(expected.root, observed.root) ||
					(observed.directory && !sameIdentity(expected.directory, observed.directory))
				)
					throw new Error(
						"Repository/archive directory was replaced since conversion; refusing cleanup.",
					);
				for (const name of BACKUP_FILES)
					if (observed.files[name] && !sameIdentity(expected.files[name], observed.files[name]))
						throw new Error("Backup file was replaced since conversion; refusing cleanup.");
				const path = join(String(r.archive_path), ".narrafork");
				const dir = await optionalStat(path);
				if (dir) {
					if (!dir.isDirectory() || dir.isSymbolicLink() || (await realpath(path)) !== path)
						throw new Error("Archive identity changed; refusing cleanup.");
					const files = await Promise.all(
						["project.db", "project.db-wal", "project.db-shm"].map(async (name) => ({
							name,
							path: join(path, name),
							stat: await optionalStat(join(path, name)),
						})),
					);
					for (const file of files)
						if (
							file.stat &&
							(!file.stat.isFile() || file.stat.isSymbolicLink() || file.stat.nlink !== 1)
						)
							throw new Error("Backup file identity cannot be safely verified.");
					for (const file of files) {
						if (!file.stat) continue;
						const currentRoot = await lstat(String(r.archive_path));
						const currentDir = await lstat(path);
						const current = await lstat(file.path);
						if (
							!sameIdentity(expected.root, identity(currentRoot)) ||
							!sameIdentity(expected.directory, identity(currentDir)) ||
							!sameIdentity(expected.files[file.name], identity(current)) ||
							!currentRoot.isDirectory() ||
							currentRoot.isSymbolicLink() ||
							!currentDir.isDirectory() ||
							currentDir.isSymbolicLink() ||
							!current.isFile() ||
							current.nlink !== 1 ||
							currentDir.dev !== dir.dev ||
							currentDir.ino !== dir.ino ||
							current.dev !== file.stat.dev ||
							current.ino !== file.stat.ino ||
							current.isSymbolicLink()
						)
							throw new Error("Backup identity changed before unlink.");
						await unlink(file.path);
					}
				}
			}
			sqlite.transaction(() => {
				// Revalidate every dependency; only the already-retained SET NULL journal exception is allowed.
				const p = plan(id, actor, history);
				if (p.blockers.length || p.ids.length || p.chapterRows.length)
					throw new Error("New dependencies appeared during backup cleanup; project retained.");
				sqlite.query("DELETE FROM projects WHERE id=? AND legacy_sync_disabled=1").run(id);
				sqlite
					.query(
						"UPDATE legacy_project_migrations SET phase='completed',updated_at=? WHERE project_id=?",
					)
					.run(new Date().toISOString(), id);
			})();
			return { ...result, phase: "completed" };
		} catch (error) {
			return {
				...result,
				blockers: [
					{
						code: "CLEANUP_PENDING",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}
	async function migrateUnlocked(
		id: string,
		actor: MigrationPrincipal,
		revision: string,
	): Promise<MigrationResult> {
		const existing = receipt(id);
		if (existing) {
			authorize(existing, actor, true);
			return cleanup(id, actor);
		}
		let initial = plan(id, actor);
		const fs = await inspectPaths(initial);
		const adoption = await prepareAdoption(initial);
		if (retainedResult(adoption)) initial = plan(id, actor, retainedResult(adoption));
		if (previewRevision(initial, fs, adoption) !== revision)
			throw new AppError("Migration preview is stale", 409, "MIGRATION_STALE");
		if (initial.blockers.length || fs.blockers.length || adoption?.blockers.length)
			return {
				phase: "blocked",
				narratorIds: [] as string[],
				syncDisabled: !!initial.project.legacy_sync_disabled,
				blockers: [...initial.blockers, ...fs.blockers, ...(adoption?.blockers ?? [])],
			};
		const drain = await deps.disableSync(id);
		if (!drain.drained)
			return {
				phase: "blocked",
				narratorIds: [] as string[],
				syncDisabled: true,
				blockers: [
					{ code: "SYNC_DRAIN_PENDING", message: "Legacy backup writers have not drained." },
				],
			};
		// Another confirmed request may have committed while this request awaited drain.
		if (receipt(id)) return cleanup(id, actor);
		// The disable operation intentionally changes only the gate/updated_at; use its post-drain snapshot for CAS.
		let afterDrain = plan(id, actor, retainedResult(adoption));
		const stable = (p: ReturnType<typeof plan>) =>
			JSON.stringify({
				project: { ...p.project, legacy_sync_disabled: 0, updated_at: null },
				chapters: p.chapterRows,
				sessions: p.sessions,
			});
		if (stable(initial) !== stable(afterDrain))
			throw new AppError("Migration changed while draining", 409, "MIGRATION_STALE");
		const finalInspectionRevision = afterDrain.revision;
		const afterPaths = await inspectPaths(afterDrain);
		const afterAdoption = await prepareAdoption(afterDrain);
		if (retainedResult(afterAdoption)) afterDrain = plan(id, actor, retainedResult(afterAdoption));
		if (afterDrain.revision !== finalInspectionRevision)
			throw new AppError(
				"Migration metadata changed after final history inspection",
				409,
				"MIGRATION_STALE",
			);
		if (adoption?.digest !== afterAdoption?.digest)
			throw new AppError("Workspace or history changed while draining", 409, "MIGRATION_STALE");
		if (receipt(id)) return cleanup(id, actor);
		if (JSON.stringify(fs.archiveIdentity) !== JSON.stringify(afterPaths.archiveIdentity))
			throw new AppError(
				"Backup identity changed while draining; refresh confirmation",
				409,
				"MIGRATION_STALE",
			);
		if (afterDrain.blockers.length || afterPaths.blockers.length || afterAdoption?.blockers.length)
			return {
				phase: "blocked",
				narratorIds: [] as string[],
				syncDisabled: true,
				blockers: [
					...afterDrain.blockers,
					...afterPaths.blockers,
					...(afterAdoption?.blockers ?? []),
				],
			};
		const commit = async () => {
			// Refresh native evidence under the existing lifecycle reservation before entering synchronous SQL.
			for (const linked of afterAdoption?.linkedWorktrees ?? []) {
				linked.evidence = await revalidateLegacyLinkedWorktreeIdentity(
					{
						projectRoot: linked.evidence.projectRoot,
						worktreePath: linked.evidence.top,
						expectedBranch: linked.evidence.branch,
					},
					linked.evidence,
				);
			}
			const heldMetadata = holdLinkedMetadata(afterAdoption);
			try {
				sqlite.transaction(() => {
					heldMetadata.verify();
					const p = plan(id, actor, retainedResult(afterAdoption));
					if (
						p.revision !== afterDrain.revision ||
						p.blockers.length ||
						!p.project.legacy_sync_disabled
					)
						throw new AppError("Migration state changed", 409, "MIGRATION_STALE");
					const targets: Record<string, string[]> = {};
					for (const chapter of p.chapterRows)
						targets[String(chapter.id)] = p.sessions
							.filter((row) => row.chapter_id === chapter.id)
							.map((row) => String(row.id));
					verifyAdoptionGuards(afterAdoption);
					const now = new Date().toISOString();
					sqlite
						.query(
							"INSERT INTO legacy_project_migrations (project_id,project_name,git_path,archive_path,archive_identity_json,actor_user_id,phase,revision,narrator_ids,chapter_targets,created_at,updated_at) VALUES (?,?,?,?,?,?,'cleanup_pending',?,?,?,?,?)",
						)
						.run(
							id,
							p.project.name,
							p.project.git_path,
							afterPaths.archivePath,
							afterPaths.archiveIdentity ? JSON.stringify(afterPaths.archiveIdentity) : null,
							actor.userId,
							revision,
							JSON.stringify(p.ids),
							JSON.stringify(targets),
							now,
							now,
						);
					const retained = retainedResult(afterAdoption);
					if (retained) {
						const manifest = retained.manifest;
						if (
							manifest.projectId !== id ||
							manifest.ownerUserId !== p.project.owner_user_id ||
							manifest.chapters.length !== p.chapterRows.length ||
							p.chapterRows.some(
								(row) =>
									!manifest.chapters.some(
										(original) =>
											original.id === row.id &&
											Object.keys(row).every((key) => row[key] === original[key]),
									),
							)
						)
							throw new AppError("Retained chapter inventory changed", 409, "MIGRATION_STALE");
						sqlite
							.query(
								"INSERT INTO legacy_retained_history_manifests (migration_project_id,manifest_json,manifest_digest,created_at) VALUES (?,?,?,?)",
							)
							.run(id, JSON.stringify(manifest), retained.digest, now);
						for (const chapter of manifest.chapters)
							sqlite
								.query(
									"INSERT INTO legacy_retained_chapter_metadata (source_chapter_id,migration_project_id,metadata_json,manifest_digest,created_at) VALUES (?,?,?,?,?)",
								)
								.run(chapter.id, id, JSON.stringify(chapter), retained.digest, now);
						for (const asset of manifest.assets) {
							const members = manifest.narratorOrigins.filter(
								(origin) => origin.workspacePath === asset.workspacePath,
							);
							if (!members.length)
								throw new AppError(
									"Artifact has no durable members",
									409,
									"MIGRATION_ADOPTION_INVALID",
								);
							for (const member of members)
								sqlite
									.query(
										"INSERT INTO legacy_migration_artifact_claims (id,migration_project_id,source_chapter_id,narrator_id,owner_user_id,kind,device_id,workspace_path,artifact_path,shadow_key,latest_snapshot_commit_sha,identity_json,manifest_digest,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'claimed',?)",
									)
									.run(
										generateId(),
										id,
										asset.sourceChapterId,
										member.narratorId,
										manifest.ownerUserId,
										asset.kind,
										asset.deviceId,
										asset.workspacePath,
										asset.artifactPath,
										asset.shadowKey ?? null,
										asset.kind === "shadow"
											? (manifest.chapters.find((chapter) => chapter.id === asset.sourceChapterId)
													?.snapshot_commit_sha ?? null)
											: null,
										JSON.stringify({
											dev: asset.identity.dev,
											ino: asset.identity.ino,
											digest: asset.identity.digest,
										}),
										retained.digest,
										now,
									);
						}
					}
					const linkedResources = persistLinkedResources(p, afterAdoption, now);
					if (afterAdoption) {
						for (const update of afterAdoption.updates) {
							const source = p.sessions.find((row) => row.id === update.id);
							if (
								!source ||
								update.previous.revision !== source.workspace_revision ||
								update.current.revision !== update.previous.revision + 1 ||
								update.current.deviceId !== "local" ||
								update.current.contextProjectId ||
								(update.current.git &&
									(!update.gitDirectoryIdentity ||
										!Number.isSafeInteger(update.gitDirectoryIdentity.dev) ||
										!Number.isSafeInteger(update.gitDirectoryIdentity.ino))) ||
								!Number.isSafeInteger(update.directoryIdentity.dev) ||
								!Number.isSafeInteger(update.directoryIdentity.ino)
							)
								throw new AppError("Workspace adoption evidence changed", 409, "MIGRATION_STALE");

							sqlite
								.query(
									"INSERT INTO legacy_narrator_workspace_adoptions (narrator_id,migration_project_id,previous_revision,adopted_revision,device_id,cwd,context_key,history_digest,workspace_key,repository_key,directory_dev,directory_ino,git_directory_dev,git_directory_ino,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
								)
								.run(
									update.id,
									id,
									update.previous.revision,
									update.current.revision,
									"local",
									update.current.cwd,
									update.current.contextKey,
									afterAdoption.history.digest,
									update.current.git?.workspaceKey ?? null,
									update.current.git?.repositoryKey ?? null,
									String(update.directoryIdentity.dev),
									String(update.directoryIdentity.ino),
									update.gitDirectoryIdentity ? String(update.gitDirectoryIdentity.dev) : null,
									update.gitDirectoryIdentity ? String(update.gitDirectoryIdentity.ino) : null,
									now,
								);
							if (retained) {
								const originJson = retainedOriginJson(
									retained,
									afterAdoption,
									update.id,
									linkedResources.get(update.id),
								);
								sqlite
									.query(
										"UPDATE legacy_narrator_workspace_adoptions SET proof_mode='retained',origin_json=? WHERE narrator_id=?",
									)
									.run(originJson, update.id);
							}
							const changed = sqlite
								.query(
									"UPDATE narrators SET chapter_id=NULL,context_project_id=NULL,cwd=?,workspace_context=?,workspace_revision=?,updated_at=? WHERE id=? AND workspace_revision=?",
								)
								.run(
									update.current.cwd,
									JSON.stringify(update.current),
									update.current.revision,
									now,
									update.id,
									update.previous.revision,
								);
							if (changed.changes !== 1)
								throw new AppError("Workspace revision changed", 409, "MIGRATION_STALE");
						}
					} else {
						for (const narratorId of p.ids)
							sqlite
								.query(
									"UPDATE narrators SET chapter_id=NULL,context_project_id=NULL,workspace_revision=workspace_revision+1,updated_at=? WHERE id=?",
								)
								.run(now, narratorId);
					}
					if (retained) {
						// Explicit archival cleanup only; original messages/tools/file/blob rows never move.
						for (const table of ["chapter_edges", "merge_sessions", "chapter_commits"])
							for (const row of retained.manifest.references[table] ?? [])
								sqlite.query(`DELETE FROM ${quote(table)} WHERE id=?`).run(row.id);
					}
					heldMetadata.verify();
					for (const linked of afterAdoption?.linkedWorktrees ?? [])
						assertLegacyLinkedWorktreeIdentityUnchangedSync(linked.evidence);
					for (const chapter of p.chapterRows)
						sqlite.query("DELETE FROM chapters WHERE id=?").run(chapter.id);
				})();
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code === "SQLITE_BUSY_SNAPSHOT")
					throw new AppError(
						"Database snapshot changed or is locked before adoption commit",
						409,
						"MIGRATION_STALE",
					);
				throw error;
			} finally {
				heldMetadata.close();
			}
			if (afterAdoption) deps.onConverted?.(afterAdoption.updates);
			return cleanup(id, actor);
		};
		const retained = retainedResult(afterAdoption);
		if (!retained) return commit();
		const assetPaths = new Set([
			retained.manifest.mainCheckoutRoot,
			...retained.manifest.assets.map((asset) => asset.artifactPath),
			...(retained.manifest.references.artifact_inventory ?? []).map((row) => String(row.id)),
		]);
		const targets = [...assetPaths].map((path) => ({ deviceId: "local", path }));
		const admit = deps.withWorkspaceAdmission ?? withWorkspaceAdmission;
		return admit(targets, async () => {
			const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
			return admit(canonical, commit);
		});
	}
	function migrate(
		id: string,
		actor: MigrationPrincipal,
		revision: string,
	): Promise<MigrationResult> {
		const pending = jobs.get(id);
		if (pending) {
			const r = receipt(id);
			if (r) authorize(r, actor, true);
			else plan(id, actor);
			return pending;
		}
		const existing = receipt(id);
		const scope = existing ? null : plan(id, actor);
		const runUnlocked = () => migrateUnlocked(id, actor, revision);
		const run = async () => {
			if (!scope || !deps.retainedHistoryConsumersReady) return runUnlocked();
			const paths = new Set<string>();
			for (const path of [
				scope.project.git_path,
				...scope.sessions.map((row) => row.cwd),
				...scope.chapterRows.map((row) => row.worktree_path),
			])
				if (typeof path === "string" && isAbsolute(path)) {
					paths.add(path);
					paths.add(treeSnapshotPhysicalDir("local", path));
				}
			for (const chapter of scope.chapterRows) {
				if (!/^[a-zA-Z0-9_-]+$/.test(String(chapter.id)))
					throw new AppError("Invalid artifact source identity", 409, "MIGRATION_ADOPTION_INVALID");
				paths.add(getNarraforkPath("dormant-ignored", String(chapter.id)));
			}
			const targets: LifecycleTarget[] = [...paths].map((path) => ({ deviceId: "local", path }));
			if (!targets.length) return runUnlocked();
			const admit = deps.withWorkspaceAdmission ?? withWorkspaceAdmission;
			return admit(targets, async () => {
				// Raw reservations precede alias resolution; canonical reservations overlap the sweepers.
				const canonical = await Promise.all(targets.map(canonicalWorkspaceAdmissionTarget));
				return admit(canonical, runUnlocked);
			});
		};
		const execution =
			deps.withRuntimeAdmission &&
			scope &&
			(!scope.blockers.length || deps.retainedHistoryConsumersReady)
				? deps.withRuntimeAdmission(scope.ids, run).then(
						(result): MigrationResult =>
							result ?? {
								phase: "blocked",
								narratorIds: [],
								syncDisabled: !!scope.project.legacy_sync_disabled,
								blockers: [
									{
										code: "NARRATOR_BUSY",
										message:
											"Narrator lifecycle reservation is busy; no running work was interrupted.",
									},
								],
							},
					)
				: run();
		const task = execution.finally(() => {
			if (jobs.get(id) === task) jobs.delete(id);
		});
		jobs.set(id, task);
		return task;
	}
	function chapterTargetCandidate(chapterId: string) {
		const chapter = first("SELECT project_id FROM chapters WHERE id=? LIMIT 1", chapterId);
		if (chapter) {
			const project = first(
				"SELECT owner_user_id FROM projects WHERE id=? LIMIT 1",
				chapter.project_id,
			);
			const sessions = all(
				"SELECT id FROM narrators WHERE chapter_id=? ORDER BY id LIMIT 200",
				chapterId,
			);
			if (sessions.length === LIMIT)
				throw new AppError("Chapter target exceeds safety budget", 503, "MIGRATION_TARGET_BUDGET");
			return {
				projectId: String(chapter.project_id),
				chapterId,
				narratorIds: sessions.map((row) => String(row.id)),
				actorUserId: project?.owner_user_id,
				phase: "none",
			};
		}
		// Bounded receipt metadata lookup; never scan unbounded JSON history or message tables.
		const mappings = all(
			"SELECT project_id,actor_user_id,phase,json_extract(chapter_targets,?) AS targets FROM legacy_project_migrations ORDER BY project_id LIMIT 200",
			`$.${JSON.stringify(chapterId)}`,
		);
		const found = mappings.find((row) => row.targets != null);
		if (!found) {
			if (mappings.length === LIMIT)
				throw new AppError(
					"Migration receipt lookup exceeds safety budget",
					503,
					"MIGRATION_TARGET_BUDGET",
				);
			throw new NotFoundError("Chapter", chapterId);
		}
		return {
			projectId: String(found.project_id),
			chapterId,
			narratorIds: JSON.parse(String(found.targets)) as string[],
			actorUserId: found.actor_user_id,
			phase: String(found.phase),
		};
	}
	return { preview, migrate, chapterTargetCandidate };
}
async function optionalStat(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
