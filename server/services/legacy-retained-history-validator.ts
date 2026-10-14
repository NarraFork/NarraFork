import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	assertLegacyLinkedWorktreeIdentityUnchangedSync,
	type LegacyLinkedWorktreeEvidence,
	revalidateLegacyLinkedWorktreeIdentity,
} from "./legacy-linked-worktree-identity";
import {
	emptyLegacyRetainedManifest,
	LEGACY_RETAINED_HISTORY_LIMITS,
	type LegacyRetainedHistoryInput,
	type LegacyRetainedHistoryResult,
	type LegacyRetainedRow,
} from "./legacy-retained-history-contract";
import type { LegacyRootHistoryGuard } from "./legacy-root-history-contract";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";

type WorkspaceGroup = {
	path: string;
	kind: "root" | "linked";
	chapterIds: string[];
	shadowKey: string;
	shadowDirectories: string[];
	linkedEvidence?: LegacyLinkedWorktreeEvidence;
	realObjects: Set<string>;
	shadowObjects: Map<string, "commit" | "tree">;
};
const verifiedLinkedBindings = new WeakMap<
	LegacyRetainedHistoryInput,
	{ bindingsDigest: string; proofs: Map<string, LegacyLinkedWorktreeEvidence> }
>();

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const present = (value: unknown) => value !== null && value !== undefined && value !== "";
const quote = (value: string) => {
	if (!/^[a-z_]+$/.test(value)) throw new Error("invalid schema identifier");
	return `"${value}"`;
};

/** Worker-only, no application DB import, no write-capable snapshot/lifecycle imports. */
export function inspectLegacyRetainedHistoryReadonly(
	input: LegacyRetainedHistoryInput,
	limits: {
		rows: number;
		bytes: number;
		filesystemEntries: number;
		milliseconds: number;
	} = LEGACY_RETAINED_HISTORY_LIMITS,
): LegacyRetainedHistoryResult {
	const manifest = emptyLegacyRetainedManifest(input);
	const guards: LegacyRootHistoryGuard[] = [];
	const started = performance.now();
	let bytes = Buffer.byteLength(JSON.stringify(input));
	let rows = 0;
	let entries = 0;
	let filesystemBytes = 0;
	let db: Database | undefined;
	const check = () => {
		if (
			rows > limits.rows ||
			bytes > limits.bytes ||
			entries > limits.filesystemEntries ||
			filesystemBytes > LEGACY_RETAINED_HISTORY_LIMITS.filesystemBytes ||
			performance.now() - started > limits.milliseconds
		)
			throw new Error("retained history budget exceeded");
	};
	const missing = (path: string) => {
		check();
		try {
			lstatSync(path);
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	};
	const account = (value: unknown) => {
		bytes += Buffer.byteLength(JSON.stringify(value));
		rows++;
		check();
	};
	const result = (reason?: string): LegacyRetainedHistoryResult => ({
		status: reason ? "unknown" : "retained",
		digest: hash({ input, manifest, guards, reason: reason ?? null }),
		guards,
		complete: !reason,
		...(reason ? { reason: reason.slice(0, 160) } : {}),
		manifest,
	});
	try {
		check();
		for (const values of [
			input.chapterIds,
			input.narratorIds,
			input.workspacePaths,
			input.shadowDirectories,
			input.snapshotShadowKeys,
		]) {
			if (
				!Array.isArray(values) ||
				values.length > LEGACY_RETAINED_HISTORY_LIMITS.inputs ||
				values.some((v) => typeof v !== "string" || v.length > 4096)
			)
				throw new Error("invalid retained resolver input");
		}
		if (
			!input.chapterIds.length ||
			!input.narratorIds.length ||
			!isAbsolute(input.databasePath) ||
			!isAbsolute(input.mainCheckoutRoot) ||
			realpathSync(input.mainCheckoutRoot) !== input.mainCheckoutRoot ||
			(!input.workspaceBindings &&
				input.workspacePaths.some((path) => path !== input.mainCheckoutRoot))
		)
			throw new Error("only canonical local main checkout is supported");
		if (
			new Set(input.chapterIds).size !== input.chapterIds.length ||
			new Set(input.narratorIds).size !== input.narratorIds.length ||
			(input.narratorOrigins &&
				(input.narratorOrigins.length > LEGACY_RETAINED_HISTORY_LIMITS.inputs ||
					new Set(input.narratorOrigins.map((o) => o.narratorId)).size !==
						input.narratorOrigins.length)) ||
			(input.ignoredArchiveDirectories &&
				input.ignoredArchiveDirectories.length > LEGACY_RETAINED_HISTORY_LIMITS.inputs)
		)
			throw new Error("duplicate or overbudget retained input membership");
		const root = input.mainCheckoutRoot;
		const groups = new Map<string, WorkspaceGroup>();
		const chapterGroups = new Map<string, WorkspaceGroup>();
		const linkedMode = !!input.workspaceBindings?.some((binding) => binding.kind === "linked");
		if (input.workspaceBindings) {
			if (
				input.workspaceBindings.length !== input.chapterIds.length ||
				new Set(input.workspaceBindings.map((binding) => binding.sourceChapterId)).size !==
					input.chapterIds.length
			)
				throw new Error("incomplete verified workspace bindings");
			const verified = verifiedLinkedBindings.get(input);
			if (linkedMode && (!verified || verified.bindingsDigest !== hash(input.workspaceBindings)))
				throw new Error("linked workspace bindings require a fresh native worker probe");
			for (const binding of input.workspaceBindings) {
				check();
				if (
					!input.chapterIds.includes(binding.sourceChapterId) ||
					binding.deviceId !== "local" ||
					!["root", "linked"].includes(binding.kind) ||
					!isAbsolute(binding.workspacePath) ||
					realpathSync(binding.workspacePath) !== binding.workspacePath ||
					binding.shadowKey !== treeSnapshotKey("local", binding.workspacePath) ||
					!isAbsolute(binding.shadowDirectory) ||
					binding.shadowDirectory !== treeSnapshotPhysicalDir("local", binding.workspacePath) ||
					!input.workspacePaths.includes(binding.workspacePath) ||
					!input.shadowDirectories.includes(binding.shadowDirectory) ||
					!input.snapshotShadowKeys.includes(binding.shadowKey)
				)
					throw new Error("unverified/overridden physical workspace or shadow binding");
				if (binding.kind === "root" && (binding.workspacePath !== root || binding.linked))
					throw new Error("root binding is not native main checkout");
				const proof =
					binding.kind === "linked" ? verified?.proofs.get(binding.sourceChapterId) : undefined;
				if (
					binding.kind === "linked" &&
					(!proof ||
						proof.projectRoot !== root ||
						proof.top !== binding.workspacePath ||
						proof.common !== join(root, ".git") ||
						proof.adminDir === proof.common)
				)
					throw new Error("foreign or unverified linked workspace binding");
				if (proof) assertLegacyLinkedWorktreeIdentityUnchangedSync(proof);
				let group = groups.get(binding.workspacePath);
				if (
					group &&
					(group.kind !== binding.kind ||
						group.shadowKey !== binding.shadowKey ||
						group.shadowDirectories[0] !== binding.shadowDirectory ||
						group.linkedEvidence?.digest !== proof?.digest)
				)
					throw new Error("ambiguous workspace source binding");
				if (!group) {
					group = {
						path: binding.workspacePath,
						kind: binding.kind,
						chapterIds: [],
						shadowKey: binding.shadowKey,
						shadowDirectories: [binding.shadowDirectory],
						linkedEvidence: proof,
						realObjects: new Set(),
						shadowObjects: new Map(),
					};
					groups.set(group.path, group);
				}
				group.chapterIds.push(binding.sourceChapterId);
				chapterGroups.set(binding.sourceChapterId, group);
			}
			if (
				input.workspacePaths.some((path) => !groups.has(path)) ||
				input.shadowDirectories.some(
					(path) => ![...groups.values()].some((group) => group.shadowDirectories.includes(path)),
				) ||
				input.snapshotShadowKeys.some(
					(key) => ![...groups.values()].some((group) => group.shadowKey === key),
				)
			)
				throw new Error("unbound workspace/shadow inventory");
		} else {
			const group: WorkspaceGroup = {
				path: root,
				kind: "root",
				chapterIds: [...input.chapterIds],
				shadowKey: treeSnapshotKey("local", root),
				shadowDirectories: [...input.shadowDirectories],
				realObjects: new Set(),
				shadowObjects: new Map(),
			};
			groups.set(root, group);
			for (const id of input.chapterIds) chapterGroups.set(id, group);
		}
		const originGroups = new Map<string, WorkspaceGroup>();
		const fileGroup = (path: string) => {
			if (!isAbsolute(path)) throw new Error("historical file path is not absolute");
			const candidates = [...groups.values()]
				.filter((group) => {
					const offset = relative(group.path, path);
					return offset !== ".." && !offset.startsWith("../") && !isAbsolute(offset);
				})
				.sort((a, b) => b.path.length - a.path.length);
			if (!candidates.length)
				throw new Error("historical file outside verified physical namespaces");
			return candidates[0];
		};
		const historyOrigins = new Map<string, WorkspaceGroup>();
		const recordOrigin = (
			table: string,
			id: string,
			group: WorkspaceGroup,
			evidence:
				| "root_only"
				| "execution_cwd"
				| "scope"
				| "file_path"
				| "snapshot_membership"
				| "chapter",
		) => {
			const key = `${table}\0${id}`;
			const previous = historyOrigins.get(key);
			if (previous && previous.path !== group.path)
				throw new Error("ambiguous historical execution workspace origin");
			if (!previous) {
				historyOrigins.set(key, group);
				const origin = {
					table,
					id,
					deviceId: "local" as const,
					workspacePath: group.path,
					sourceChapterIds: [...group.chapterIds],
					evidence,
				};
				account(origin);
				manifest.historyOrigins.push(origin);
			}
			return group;
		};
		const databaseIdentity = () => {
			if (realpathSync(input.databasePath) !== input.databasePath)
				throw new Error("database path is not canonical");
			const stat = lstatSync(input.databasePath, { bigint: true });
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
				throw new Error("database physical identity is unknown");
			return {
				path: input.databasePath,
				dev: String(stat.dev),
				ino: String(stat.ino),
				birthtimeNs: String(stat.birthtimeNs),
			};
		};
		manifest.databaseIdentity = databaseIdentity();
		db = new Database(input.databasePath, { readonly: true, strict: true });
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN");
		const database = db;
		const seen = new Map<string, Set<string>>();
		const columns = (table: string): string[] => {
			check();
			const info = database
				.query(`PRAGMA table_info(${quote(table)})`)
				.all() as LegacyRetainedRow[];
			if (!info.length || info.length > 256) throw new Error(`missing schema ${table}`);
			return info.map((c) => String(c.name));
		};
		// Each cell is size-checked inside SQL BEFORE it crosses into JS. No content bodies
		// are projected; metadata is never silently truncated or converted to empty.
		const scan = (table: string, fields: readonly string[], where: string, params: string[]) => {
			const known = columns(table);
			if (fields.some((field) => !known.includes(field)))
				throw new Error(`missing columns ${table}`);
			const max = LEGACY_RETAINED_HISTORY_LIMITS.metadataBytes;
			const primaryKey = table === "workspace_write_leases" ? "lease_id" : "id";
			if (
				database
					.query(
						`SELECT ${quote(primaryKey)} FROM ${quote(table)} WHERE (${where}) AND (${quote(primaryKey)} IS NULL OR ${quote(primaryKey)}='') LIMIT 1`,
					)
					.get(...params)
			)
				throw new Error(`unknown empty row identity ${table}`);
			const rowBytes = fields
				.map((field) => `coalesce(length(CAST(${quote(field)} AS BLOB)),0)`)
				.join("+");
			const projection =
				(primaryKey === "id" ? "" : `${quote(primaryKey)} AS id,`) +
				fields
					.map(
						(field) =>
							`CASE WHEN (${rowBytes}) > ${max} THEN NULL ELSE ${quote(field)} END AS ${quote(field)}`,
					)
					.join(",");
			const oversized = `(${rowBytes}) > ${max}`;
			let cursor = "";
			const found: LegacyRetainedRow[] = [];
			while (true) {
				check();
				const pageSize = Math.max(
					1,
					Math.min(LEGACY_RETAINED_HISTORY_LIMITS.page, Math.floor((limits.bytes - bytes) / max)),
				);
				const page = database
					.query(
						`SELECT ${projection}, (${oversized}) AS oversized FROM ${quote(table)} WHERE (${where}) AND ${quote(primaryKey)} > ? ORDER BY ${quote(primaryKey)} LIMIT ?`,
					)
					.all(...params, cursor, pageSize) as LegacyRetainedRow[];
				for (const row of page) {
					if (row.oversized) throw new Error(`oversized metadata ${table}`);
					delete row.oversized;
					if (Buffer.byteLength(JSON.stringify(row)) > max)
						throw new Error(`oversized metadata ${table}`);
					account(row);
					found.push(row);
				}
				if (page.length < pageSize) break;
				cursor = String(page[page.length - 1].id);
			}
			return found;
		};
		const retain = (table: string, values: LegacyRetainedRow[]) => {
			let ids = seen.get(table);
			if (!ids) {
				ids = new Set();
				seen.set(table, ids);
			}
			const target = manifest.references[table] ?? [];
			manifest.references[table] = target;
			for (const row of values)
				if (!ids.has(String(row.id))) {
					ids.add(String(row.id));
					target.push(row);
				}
		};
		const one = (table: string, fields: readonly string[], id: string) => {
			const values = scan(table, fields, "id=?", [id]);
			if (values.length !== 1) throw new Error(`missing related ${table}`);
			return values[0];
		};
		const project = one(
			"projects",
			[
				"id",
				"git_path",
				"owner_user_id",
				"visibility",
				"startup_script",
				"copy_files",
				"chapter_settings",
			],
			input.projectId,
		);
		if (
			!project.owner_user_id ||
			project.visibility !== "private" ||
			project.git_path !== root ||
			[project.startup_script, project.copy_files, project.chapter_settings].some(present)
		)
			throw new Error("unknown ownership or configured project");
		manifest.ownerUserId = String(project.owner_user_id);
		one("users", ["id"], manifest.ownerUserId);
		const noGrants = (kind: string, id: string) => {
			if (scan("acl_grants", ["id"], "scope_type=? AND scope_id=?", [kind, id]).length)
				throw new Error("shared ACL cannot be retained automatically");
		};
		noGrants("project", input.projectId);
		for (const group of groups.values())
			if (
				scan("narrator_worktree_resources", ["id"], "device_id='local' AND worktree_path=?", [
					group.path,
				]).length
			)
				throw new Error("workspace has an independently owned worktree resource");
		const chapterFields = columns("chapters").filter(
			(c) => !["dock_layout_json", "detached_panels_json"].includes(c),
		);
		for (const id of input.chapterIds) {
			const chapter = one("chapters", chapterFields, id);
			const group = chapterGroups.get(id);
			if (!group) throw new Error("missing source workspace binding");
			if (
				chapter.project_id !== input.projectId ||
				(group.kind === "root"
					? chapter.is_root !== 1 ||
						(present(chapter.worktree_path) && chapter.worktree_path !== group.path)
					: chapter.is_root === 1 ||
						chapter.worktree_path !== group.path ||
						group.linkedEvidence?.branch !==
							(String(chapter.branch).startsWith("refs/heads/")
								? String(chapter.branch)
								: `refs/heads/${chapter.branch}`)) ||
				present(chapter.container_config) ||
				present(chapter.parked_snapshot_commit_sha) ||
				present(chapter.parked_snapshot_base_tree) ||
				present(chapter.dormant_snapshot_commit_sha) ||
				present(chapter.review_source_chapter_id) ||
				present(chapter.review_status) ||
				!(
					group.kind === "linked" ? ["active", "dormant"] : ["active", "merged", "abandoned"]
				).includes(String(chapter.status))
			)
				throw new Error("chapter requires lifecycle/review/worktree handling");
			noGrants("chapter", id);
			const members = scan("narrators", ["id"], "chapter_id=?", [id]);
			if (members.some((member) => !input.narratorIds.includes(String(member.id))))
				throw new Error("incomplete source chapter narrator membership");
			manifest.chapters.push(chapter);
			recordOrigin("chapters", id, group, "chapter");
			// Size/type preflight reads no layout body. Both queries share this readonly
			// SQLite snapshot; nonempty and even non-JSON text are archived byte-for-byte.
			check();
			const layoutSizes = database
				.query(
					"SELECT typeof(dock_layout_json) AS dock_type, typeof(detached_panels_json) AS detached_type, coalesce(length(CAST(dock_layout_json AS BLOB)),0) AS dock_bytes, coalesce(length(CAST(detached_panels_json AS BLOB)),0) AS detached_bytes FROM chapters WHERE id=?",
				)
				.get(id) as LegacyRetainedRow | undefined;
			if (
				!layoutSizes ||
				!["text", "null"].includes(String(layoutSizes.dock_type)) ||
				!["text", "null"].includes(String(layoutSizes.detached_type))
			)
				throw new Error("unknown raw layout storage type");
			if (
				Number(layoutSizes.dock_bytes) > LEGACY_RETAINED_HISTORY_LIMITS.rawLayoutColumnBytes ||
				Number(layoutSizes.detached_bytes) > LEGACY_RETAINED_HISTORY_LIMITS.rawLayoutColumnBytes ||
				Number(layoutSizes.dock_bytes) + Number(layoutSizes.detached_bytes) > limits.bytes - bytes
			)
				throw new Error("raw layout byte budget exceeded");
			check();
			const layout = database
				.query(
					"SELECT dock_layout_json AS dock, detached_panels_json AS detached FROM chapters WHERE id=?",
				)
				.get(id) as LegacyRetainedRow | undefined;
			if (
				!layout ||
				(layout.dock !== null && typeof layout.dock !== "string") ||
				(layout.detached !== null && typeof layout.detached !== "string")
			)
				throw new Error("unknown raw layout data");
			const rawLayout = {
				sourceChapterId: id,
				dockLayoutJson: layout.dock,
				detachedPanelsJson: layout.detached,
			};
			account(rawLayout);
			manifest.rawLayouts.push(rawLayout);
			retain(
				"chapter_commits",
				scan("chapter_commits", columns("chapter_commits"), "chapter_id=?", [id]),
			);
			for (const column of ["source_id", "target_id"])
				retain(
					"chapter_edges",
					scan("chapter_edges", columns("chapter_edges"), `${column}=?`, [id]),
				);
			for (const table of ["terminals", "container_instances"])
				if (scan(table, ["id"], "chapter_id=?", [id]).length)
					throw new Error("chapter has runtime resources");
			check();
			if (db.query("SELECT port FROM port_allocations WHERE chapter_id=? LIMIT 1").get(id))
				throw new Error("chapter has allocated port");
		}
		// Indexed target lookup, scoped to this project's bounded graph. Cross-project
		// source relationships must additionally be rejected by Core's owned-index audit.
		const sessions = scan(
			"merge_sessions",
			columns("merge_sessions"),
			"target_chapter_id IN (SELECT id FROM chapters WHERE project_id=?)",
			[input.projectId],
		);
		for (const session of sessions) {
			const sources: unknown = JSON.parse(String(session.source_chapter_ids));
			if (!Array.isArray(sources)) throw new Error("unknown merge sources");
			if (
				input.chapterIds.includes(String(session.target_chapter_id)) ||
				sources.some((s) => input.chapterIds.includes(String(s)))
			) {
				if (
					!["completed", "cancelled"].includes(String(session.status)) ||
					present(session.conflict_tree)
				)
					throw new Error("unfinished merge/conflict");
				retain("merge_sessions", [session]);
			}
		}
		const narratorFields = [
			"id",
			"chapter_id",
			"owner_user_id",
			"visibility",
			"write_audience",
			"status",
			"cwd",
			"default_device_id",
			"workspace_revision",
			"workspace_context",
			"refs_inherited_from",
			"refs_backfill_cursor",
			"message_version",
			"message_structure_version",
			"next_seq",
			"context_project_id",
			"parent_narrator_id",
			"origin_tool_call_id",
			"subagent_origin_kind",
			"inherit_mode",
			"fork_message_id",
		];
		const related = new Map<string, LegacyRetainedRow>();
		const pending = [...input.narratorIds];
		const messages = new Map<string, LegacyRetainedRow>();
		const toolFields = [
			"id",
			"narrator_id",
			"message_id",
			"status",
			"execution_device_id",
			"execution_cwd",
			"tree_hash_before",
			"tree_hash_after",
			"file_change_operation_id",
			"execution_origin_tool_call_id",
			"execution_identity_version",
			"execution_attempt",
			"execution_segment_id",
			"is_file_history_checkpoint",
			"tool_use_id",
		];
		const inspectedToolOrigins = new Set<string>();
		const inspectToolOrigins = (tool: LegacyRetainedRow) => {
			let cursor = tool;
			const chain = new Set<string>();
			while (true) {
				const id = String(cursor.id);
				if (chain.has(id)) throw new Error("cyclic tool execution origin");
				chain.add(id);
				pending.push(String(cursor.narrator_id));
				if (inspectedToolOrigins.has(id)) break;
				inspectedToolOrigins.add(id);
				if (
					!present(cursor.execution_origin_tool_call_id) ||
					cursor.execution_origin_tool_call_id === id
				)
					break;
				cursor = one(
					"narrator_tool_calls",
					toolFields,
					String(cursor.execution_origin_tool_call_id),
				);
			}
		};
		const messageFields = [
			"id",
			"narrator_id",
			"commit_sha",
			"tree_hash_after",
			"snapshot_commit_sha",
		];
		while (pending.length) {
			const id = pending.shift();
			if (id === undefined) break;
			if (related.has(id)) continue;
			if (related.size >= LEGACY_RETAINED_HISTORY_LIMITS.inputs)
				throw new Error("shared history guard budget exceeded");
			const narrator = one("narrators", narratorFields, id);
			if (linkedMode && !input.narratorIds.includes(id))
				throw new Error("external shared narrator origin is not a declared linked source");
			const sourceGroup = chapterGroups.get(String(narrator.chapter_id));
			const effectivePath = narrator.cwd === null ? sourceGroup?.path : String(narrator.cwd);
			const narratorGroup = effectivePath ? groups.get(effectivePath) : undefined;
			if (!narratorGroup || (input.narratorIds.includes(id) && narratorGroup !== sourceGroup))
				throw new Error("unverified narrator workspace override/subdirectory/source");
			originGroups.set(id, narratorGroup);
			if (
				narrator.owner_user_id !== project.owner_user_id ||
				narrator.visibility !== "private" ||
				narrator.write_audience !== "owner" ||
				(narrator.cwd === null && !sourceGroup) ||
				(present(narrator.default_device_id) && narrator.default_device_id !== "local") ||
				!["idle", "archived"].includes(String(narrator.status))
			)
				throw new Error("unknown shared origin/ownership/cwd or active narrator");
			noGrants("narrator", id);
			if (
				scan("narrator_public_shares", ["id"], "narrator_id=? AND revoked_at IS NULL", [id]).length
			)
				throw new Error("public share cannot be retained automatically");
			const counters = [
				narrator.message_version,
				narrator.message_structure_version,
				narrator.next_seq,
				narrator.workspace_revision,
			];
			if (!counters.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0))
				throw new Error("invalid narrator guards");
			if (input.narratorIds.includes(id) && !input.chapterIds.includes(String(narrator.chapter_id)))
				throw new Error("narrator not in source chapter");
			related.set(id, narrator);
			guards.push({
				id,
				messageVersion: Number(narrator.message_version),
				messageStructureVersion: Number(narrator.message_structure_version),
				nextSeq: Number(narrator.next_seq),
			});
			const origin = {
				narratorId: id,
				sourceChapterId: narrator.chapter_id === null ? null : String(narrator.chapter_id),
				deviceId: "local" as const,
				workspacePath: narratorGroup.path,
				persistedCwd: narrator.cwd === null ? null : String(narrator.cwd),
				workspaceRevision: Number(narrator.workspace_revision),
				workspaceContext:
					narrator.workspace_context === null ? null : String(narrator.workspace_context),
			};
			const supplied = input.narratorOrigins?.find((o) => o.narratorId === id);
			if (
				supplied &&
				(supplied.sourceChapterId !== origin.sourceChapterId ||
					supplied.deviceId !== origin.deviceId ||
					supplied.workspacePath !== origin.workspacePath ||
					supplied.workspaceRevision !== origin.workspaceRevision ||
					supplied.workspaceContext !== origin.workspaceContext ||
					(supplied.persistedCwd !== undefined && supplied.persistedCwd !== origin.persistedCwd))
			)
				throw new Error("stale narrator origin");
			if (origin.workspaceContext) {
				const context = JSON.parse(origin.workspaceContext);
				if (
					context.cwd !== narratorGroup.path ||
					context.deviceId !== "local" ||
					context.revision !== origin.workspaceRevision ||
					(linkedMode &&
						context.git?.rootPath !== undefined &&
						context.git.rootPath !== narratorGroup.path)
				)
					throw new Error("stale workspace context");
			}
			manifest.narratorOrigins.push(origin);
			retain("narrators", [narrator]);
			if (present(narrator.refs_inherited_from)) pending.push(String(narrator.refs_inherited_from));
			if (present(narrator.parent_narrator_id)) pending.push(String(narrator.parent_narrator_id));
			if (present(narrator.origin_tool_call_id))
				inspectToolOrigins(
					one("narrator_tool_calls", toolFields, String(narrator.origin_tool_call_id)),
				);
			if (present(narrator.fork_message_id)) {
				const message = one("narrator_messages", messageFields, String(narrator.fork_message_id));
				messages.set(String(message.id), message);
			}
			for (const tool of scan("narrator_tool_calls", toolFields, "narrator_id=?", [id])) {
				inspectToolOrigins(tool);
				if (!messages.has(String(tool.message_id)))
					messages.set(
						String(tool.message_id),
						one("narrator_messages", messageFields, String(tool.message_id)),
					);
			}
			const refs = scan(
				"narrator_message_refs",
				["id", "narrator_id", "message_id", "seq", "is_compact"],
				"narrator_id=?",
				[id],
			);
			retain("narrator_message_refs", refs);
			for (const message of scan("narrator_messages", messageFields, "narrator_id=?", [id]))
				messages.set(String(message.id), message);
			for (const ref of refs) {
				const messageId = String(ref.message_id);
				if (!messages.has(messageId))
					messages.set(messageId, one("narrator_messages", messageFields, messageId));
			}
			for (const message of messages.values()) {
				pending.push(String(message.narrator_id));
				for (const tool of scan("narrator_tool_calls", toolFields, "message_id=?", [
					String(message.id),
				]))
					inspectToolOrigins(tool);
				for (const patch of scan(
					"narrator_patches",
					columns("narrator_patches").filter((c) => c !== "files_json"),
					"message_id=?",
					[String(message.id)],
				)) {
					pending.push(String(patch.narrator_id));
					retain("narrator_patches", [patch]);
				}
				const sharers = scan(
					"narrator_message_refs",
					["id", "narrator_id", "message_id", "seq", "is_compact"],
					"message_id=?",
					[String(message.id)],
				);
				retain("narrator_message_refs", sharers);
				for (const ref of sharers) pending.push(String(ref.narrator_id));
			}
			for (const table of [
				"narrator_file_snapshots",
				"narrator_patches",
				"file_change_operations",
				"file_attributions",
				"file_change_execution_segments",
			]) {
				const omit = [
					"original_content",
					"files_json",
					"actor_json",
					"execution_binding_json",
					"owned_paths_json",
					"ranges_json",
					"mutation_manifest_json",
				];
				const records = scan(
					table,
					columns(table).filter((c) => !omit.includes(c)),
					"narrator_id=?",
					[id],
				);
				retain(table, records);
			}
			for (const original of manifest.references.narrator_file_snapshots ?? []) {
				const path = String(original.file_path);
				if (original.device_id !== "local")
					throw new Error("file original outside local physical namespace");
				recordOrigin("narrator_file_snapshots", String(original.id), fileGroup(path), "file_path");
			}
			for (const table of ["terminals", "revert_operations"])
				if (scan(table, ["id"], "narrator_id=?", [id]).length)
					throw new Error("narrator runtime/revert dependency");
			const tasks = scan(
				"background_tasks",
				[
					"id",
					"parent_narrator_id",
					"type",
					"background_kind",
					"status",
					"subagent_narrator_id",
					"logical_run_id",
					"tool_call_id",
				],
				"parent_narrator_id=?",
				[id],
			);
			if (
				tasks.some(
					(task) => !["completed", "failed", "cancelled", "timeout"].includes(String(task.status)),
				)
			)
				throw new Error("narrator has active background runtime");
			retain("background_tasks", tasks);
		}
		if (
			manifest.narratorOrigins.length !== related.size ||
			input.narratorOrigins?.some((origin) => !related.has(origin.narratorId))
		)
			throw new Error("incomplete origin closure");
		for (const narrator of related.values()) {
			const ancestors = new Set<string>();
			let cursor = narrator;
			while (present(cursor.refs_inherited_from)) {
				const ancestorId = String(cursor.refs_inherited_from);
				if (ancestors.has(ancestorId)) throw new Error("cyclic lazy history ancestor");
				ancestors.add(ancestorId);
				const ancestor = related.get(ancestorId);
				if (!ancestor) throw new Error("missing lazy history ancestor guard");
				cursor = ancestor;
			}
		}
		manifest.externalNarratorIds = [...related.keys()]
			.filter((id) => !input.narratorIds.includes(id))
			.sort();
		retain("narrator_messages", [...messages.values()]);
		const tools = new Map<string, LegacyRetainedRow>();
		for (const id of related.keys())
			for (const tool of scan("narrator_tool_calls", toolFields, "narrator_id=?", [id]))
				tools.set(String(tool.id), tool);
		for (const id of messages.keys())
			for (const tool of scan("narrator_tool_calls", toolFields, "message_id=?", [id]))
				tools.set(String(tool.id), tool);
		const toolGroups = new Map<string, WorkspaceGroup>();
		const actualTool = (tool: LegacyRetainedRow) => {
			const seen = new Set<string>();
			let cursor = tool;
			while (
				present(cursor.execution_origin_tool_call_id) &&
				cursor.execution_origin_tool_call_id !== cursor.id
			) {
				if (seen.has(String(cursor.id))) throw new Error("cyclic historical tool source");
				seen.add(String(cursor.id));
				const source = tools.get(String(cursor.execution_origin_tool_call_id));
				if (!source) throw new Error("missing immutable historical tool source");
				cursor = source;
			}
			return cursor;
		};
		for (const tool of tools.values()) {
			const source = actualTool(tool);
			const group = present(source.execution_cwd)
				? groups.get(String(source.execution_cwd))
				: !linkedMode
					? groups.get(root)
					: undefined;
			if (!group || (linkedMode && source.execution_device_id !== "local"))
				throw new Error("unknown immutable tool execution workspace origin");
			toolGroups.set(String(tool.id), group);
			recordOrigin(
				"narrator_tool_calls",
				String(tool.id),
				group,
				linkedMode ? "execution_cwd" : "root_only",
			);
			if (
				!related.has(String(tool.narrator_id)) ||
				!["success", "fail"].includes(String(tool.status)) ||
				(present(source.execution_device_id) && source.execution_device_id !== "local") ||
				(present(source.execution_cwd) && !groups.has(String(source.execution_cwd)))
			)
				throw new Error("tool owner/physical execution is unknown or unsettled");
		}
		retain("narrator_tool_calls", [...tools.values()]);
		// Deprecated patches address the chapter-specific snapshots/<chapterId> repo,
		// not the workspace tree-snapshot repo. Until that distinct namespace has its
		// own verified asset/consumer contract, never pretend these bytes are covered.
		if (manifest.references.narrator_patches?.length)
			throw new Error("legacy patch shadow namespace is unverified");
		const scopes = [...groups.values()].flatMap((group) =>
			scan(
				"file_change_scopes",
				columns("file_change_scopes"),
				"device_id='local' AND canonical_root=?",
				[group.path],
			),
		);
		const scopeGroups = new Map<string, WorkspaceGroup>();
		if (
			linkedMode &&
			[...groups.values()].some(
				(group) =>
					new Set(
						scopes
							.filter((scope) => scope.canonical_root === group.path)
							.map((scope) => scope.source_instance_id),
					).size > 1,
			)
		)
			throw new Error("shared/ambiguous physical scope namespace");
		retain("file_change_scopes", scopes);
		for (const scope of scopes) {
			if (typeof scope.id !== "string" || scope.id.length > 1024 || !scope.id)
				throw new Error("unknown or oversized scope identity");
			const group = groups.get(String(scope.canonical_root));
			if (!group) throw new Error("unbound scope execution source");
			scopeGroups.set(String(scope.id), group);
			recordOrigin("file_change_scopes", String(scope.id), group, "scope");
			if (
				scope.status !== "active" ||
				Number(scope.active_mutation_count) !== 0 ||
				present(scope.active_lease_id) ||
				!present(scope.root_identity_json)
			)
				throw new Error("unknown or leased physical scope");
			const rootStat = lstatSync(group.path, { bigint: true });
			const rootIdentity = JSON.parse(String(scope.root_identity_json));
			if (
				rootStat.birthtimeNs <= 0n ||
				rootIdentity.object !== `${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`
			)
				throw new Error("scope root physical identity is unknown or stale");
			for (const table of ["file_change_effects", "snapshot_captures", "workspace_write_leases"])
				retain(
					table,
					scan(
						table,
						columns(table).filter(
							(c) =>
								!["execution_receipt_json", "ranges_json", "mutation_manifest_json"].includes(c),
						),
						"scope_id=?",
						[String(scope.id)],
					),
				);
		}
		const operationGroups = new Map<string, WorkspaceGroup>();
		for (const operation of manifest.references.file_change_operations ?? []) {
			const sourceTool = tools.get(String(operation.tool_call_id));
			const group =
				toolGroups.get(String(operation.tool_call_id)) ??
				(!linkedMode ? groups.get(root) : undefined);
			if (
				!group ||
				(linkedMode &&
					(!sourceTool || actualTool(sourceTool).narrator_id !== operation.narrator_id))
			)
				throw new Error("file operation has no verified immutable execution origin");
			operationGroups.set(String(operation.id), group);
			recordOrigin(
				"file_change_operations",
				String(operation.id),
				group,
				linkedMode ? "execution_cwd" : "root_only",
			);
			if (
				operation.settlement !== "settled" ||
				operation.execution_outcome === "running" ||
				operation.coverage !== "complete"
			)
				throw new Error("unknown or incomplete file operation");
			retain(
				"file_change_effects",
				scan(
					"file_change_effects",
					columns("file_change_effects").filter((c) => c !== "execution_receipt_json"),
					"operation_id=?",
					[String(operation.id)],
				),
			);
		}
		for (const effect of manifest.references.file_change_effects ?? []) {
			if (
				!scopes.some((s) => s.id === effect.scope_id) ||
				!(manifest.references.file_change_operations ?? []).some(
					(o) => o.id === effect.operation_id,
				) ||
				effect.settlement !== "settled" ||
				effect.outcome === "unknown"
			)
				throw new Error("external or unsettled effect dependency");
			const group = scopeGroups.get(String(effect.scope_id));
			if (!group || (linkedMode && operationGroups.get(String(effect.operation_id)) !== group))
				throw new Error("shared scope/effect mismatches historical execution origin");
			if (linkedMode) {
				const identity = JSON.parse(String(effect.identity_json));
				const scope = scopes.find((item) => item.id === effect.scope_id);
				if (
					!scope ||
					identity.deviceId !== "local" ||
					identity.scopeId !== scope.id ||
					identity.sourceInstanceId !== scope.source_instance_id ||
					identity.workspaceInstanceId !== scope.workspace_instance_id ||
					typeof identity.canonicalPath !== "string" ||
					fileGroup(identity.canonicalPath) !== group
				)
					throw new Error("effect immutable identity does not match its physical execution scope");
				for (const [stateField, blobField] of [
					["before_state_json", "before_blob_digest"],
					["intended_after_state_json", "intended_after_blob_digest"],
					["observed_after_state_json", "observed_after_blob_digest"],
				]) {
					const state = JSON.parse(String(effect[stateField]));
					if (
						!state ||
						typeof state !== "object" ||
						Array.isArray(state) ||
						!["absent", "regular", "symlink", "unknown"].includes(state.kind)
					)
						throw new Error("effect has unknown typed historical state");
					const blob =
						state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
					if (
						(!blob && present(effect[blobField])) ||
						(blob && (typeof blob.digest !== "string" || blob.digest !== effect[blobField]))
					)
						throw new Error("effect typed blob reference differs from its immutable reverse index");
				}
			}
			recordOrigin("file_change_effects", String(effect.id), group, "scope");
		}
		for (const lease of manifest.references.workspace_write_leases ?? []) {
			if (!["settled", "recovered"].includes(String(lease.status)))
				throw new Error("physical execution lease not released");
			const group = scopeGroups.get(String(lease.scope_id));
			if (!group || (linkedMode && lease.device_id !== "local"))
				throw new Error("lease has unverified physical scope ownership");
			recordOrigin("workspace_write_leases", String(lease.id), group, "scope");
		}
		for (const capture of manifest.references.snapshot_captures ?? []) {
			const group = scopeGroups.get(String(capture.scope_id));
			if (
				!group ||
				(linkedMode &&
					present(capture.operation_id) &&
					operationGroups.get(String(capture.operation_id)) !== group)
			)
				throw new Error("capture has unknown/shared execution source scope");
			recordOrigin("snapshot_captures", String(capture.id), group, "scope");
			if (capture.coverage !== "complete") {
				manifest.legacyUnknownEvidence.push({
					table: "snapshot_captures",
					id: String(capture.id),
					coverage: capture.coverage === null ? null : String(capture.coverage),
				});
				throw new Error("legacy_unknown or incomplete capture remains unknown");
			}
		}
		for (const group of groups.values()) {
			const snapshots = scan(
				"worktree_tree_snapshots",
				["id", "device_id", "worktree_path", "tree_hash", "snapshot_commit_sha"],
				"device_id='local' AND worktree_path=?",
				[group.path],
			);
			retain("worktree_tree_snapshots", snapshots);
			for (const snapshot of snapshots)
				recordOrigin("worktree_tree_snapshots", String(snapshot.id), group, "snapshot_membership");
			retain(
				"file_attributions",
				scan(
					"file_attributions",
					columns("file_attributions").filter((c) => c !== "owned_paths_json"),
					"device_id='local' AND workspace_path=?",
					[group.path],
				),
			);
		}
		for (const attribution of manifest.references.file_attributions ?? []) {
			const group = groups.get(String(attribution.workspace_path));
			if (
				!related.has(String(attribution.narrator_id)) ||
				attribution.device_id !== "local" ||
				!group ||
				(linkedMode &&
					((present(attribution.scope_id) &&
						scopeGroups.get(String(attribution.scope_id)) !== group) ||
						(present(attribution.operation_id) &&
							operationGroups.get(String(attribution.operation_id)) !== group)))
			)
				throw new Error("external file attribution dependency or shared source scope");
			recordOrigin("file_attributions", String(attribution.id), group, "scope");
		}
		const blobDigests = new Set<string>();
		for (const effect of manifest.references.file_change_effects ?? [])
			for (const field of [
				"before_blob_digest",
				"intended_after_blob_digest",
				"observed_after_blob_digest",
			])
				if (present(effect[field])) blobDigests.add(String(effect[field]));
		for (const capture of manifest.references.snapshot_captures ?? []) {
			if (
				present(capture.operation_id) &&
				!(manifest.references.file_change_operations ?? []).some(
					(o) => o.id === capture.operation_id,
				)
			)
				throw new Error("external capture operation dependency");
			if (present(capture.manifest_blob_digest))
				blobDigests.add(String(capture.manifest_blob_digest));
		}
		for (const digest of blobDigests) {
			const records = scan("file_change_blobs", columns("file_change_blobs"), "digest=?", [digest]);
			if (records.length !== 1 || records[0].status !== "ready")
				throw new Error("missing or unavailable blob metadata");
			retain("file_change_blobs", records);
		}

		const gitEnvironment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		);
		const git = (path: string, args: string[], stdin?: string) => {
			check();
			const proc = spawnSync(
				"git",
				["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", path, ...args],
				{
					encoding: "utf8",
					input: stdin,
					timeout: Math.max(1, Math.min(500, limits.milliseconds - (performance.now() - started))),
					maxBuffer: LEGACY_RETAINED_HISTORY_LIMITS.gitOutputBytes,
					env: {
						...gitEnvironment,
						GIT_OPTIONAL_LOCKS: "0",
						GIT_NO_REPLACE_OBJECTS: "1",
						GIT_NO_LAZY_FETCH: "1",
						GIT_TERMINAL_PROMPT: "0",
					},
				},
			);
			if (proc.error || proc.status !== 0)
				throw new Error("Git identity/object verification failed");
			account(proc.stdout);
			return proc.stdout.trim();
		};
		const hashGitMetadata = (path: string) => {
			const digest = createHash("sha256");
			const chunk = Buffer.alloc(64 * 1024);
			const fd = openSync(path, "r");
			let total = 0;
			try {
				while (true) {
					check();
					const read = readSync(fd, chunk, 0, chunk.length, null);
					if (!read) break;
					total += read;
					filesystemBytes += read;
					if (total > LEGACY_RETAINED_HISTORY_LIMITS.gitMetadataBytes)
						throw new Error("Git metadata file budget exceeded");
					check();
					digest.update(chunk.subarray(0, read));
				}
				return digest.digest("hex");
			} finally {
				closeSync(fd);
			}
		};
		const identity = (path: string, recurse: boolean, gitMetadata = false) => {
			if (!isAbsolute(path) || realpathSync(path) !== path)
				throw new Error("noncanonical artifact path");
			const values: LegacyRetainedRow[] = [];
			const visit = (p: string) => {
				check();
				entries++;
				check();
				const stat = lstatSync(p);
				if (stat.isSymbolicLink()) throw new Error("artifact symlink identity unknown");
				const row: LegacyRetainedRow = {
					path: p,
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
				};
				if (
					gitMetadata &&
					stat.isFile() &&
					["HEAD", "config", "packed-refs", "index"].includes(p.slice(p.lastIndexOf("/") + 1))
				) {
					if (stat.size > LEGACY_RETAINED_HISTORY_LIMITS.gitMetadataBytes)
						throw new Error("Git metadata file budget exceeded");
					row.bytesDigest = hashGitMetadata(p);
				}
				account(row);
				values.push(row);
				if (stat.isDirectory() && recurse) {
					const directory = opendirSync(p);
					try {
						while (true) {
							const child = directory.readSync();
							if (!child) break;
							visit(join(p, child.name));
						}
					} finally {
						directory.closeSync();
					}
				}
			};
			visit(path);
			values.sort((a, b) => String(a.path).localeCompare(String(b.path)));
			const stat = lstatSync(path);
			return {
				dev: String(stat.dev),
				ino: String(stat.ino),
				digest: hash(values),
				entries: values,
			};
		};
		if (
			git(root, ["rev-parse", "--show-toplevel"]) !== root ||
			git(root, ["rev-parse", "--is-bare-repository"]) !== "false"
		)
			throw new Error("not main Git checkout");
		const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
		if (realpathSync(gitDir) !== join(root, ".git"))
			throw new Error("independent worktree not supported");
		if (!missing(join(gitDir, "objects", "info", "alternates")))
			throw new Error("external Git object dependency");
		const gitIdentity = () => {
			const values = [...identity(root, false).entries, ...identity(gitDir, false, true).entries];
			for (const name of ["HEAD", "config", "index", "packed-refs", "objects", "refs"]) {
				try {
					values.push(...identity(join(gitDir, name), name === "refs", true).entries);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !missing(join(gitDir, name)))
						throw error;
				}
			}
			values.push({
				path: gitDir,
				head: git(root, ["rev-parse", "HEAD"]),
				refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
			});
			return { digest: hash(values), entries: values };
		};
		manifest.gitIdentity = gitIdentity();
		for (const name of [
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD",
			"REVERT_HEAD",
			"rebase-merge",
			"rebase-apply",
			"sequencer",
			"index.lock",
		]) {
			try {
				lstatSync(join(gitDir, name));
				throw new Error("Git conflict/reapply in progress");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (git(root, ["ls-files", "--unmerged"]))
			throw new Error("Git index has unresolved conflicts");
		const commonRealObjects = new Set<string>();
		const addObject = (
			value: unknown,
			kind: "commit" | "tree",
			shadow: boolean,
			group: WorkspaceGroup | undefined = linkedMode ? undefined : groups.get(root),
		) => {
			if (!present(value)) return;
			if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/.test(value))
				throw new Error("invalid Git object SHA");
			if (shadow) {
				if (!group) throw new Error("shadow SHA has no verified historical execution source");
				group.shadowObjects.set(value, kind);
			} else if (group) group.realObjects.add(value);
			else commonRealObjects.add(value);
		};
		for (const chapter of manifest.chapters) {
			const group = chapterGroups.get(String(chapter.id));
			if (!group) throw new Error("unverified chapter Git source");
			if (present(chapter.snapshot_shadow_key) && chapter.snapshot_shadow_key !== group.shadowKey)
				throw new Error("chapter shadow key differs from verified workspace");
			for (const field of [
				"head_commit_sha",
				"start_commit_sha",
				"anchor_commit_sha",
				"merge_commit_sha",
				"pre_merge_target_sha",
			])
				addObject(chapter[field], "commit", false, group);
			for (const field of [
				"snapshot_commit_sha",
				"merge_snapshot_commit_sha",
				"pre_merge_target_snapshot_sha",
				"merged_source_snapshot_sha",
				"dormant_snapshot_commit_sha",
				"parked_snapshot_commit_sha",
			])
				addObject(chapter[field], "commit", true, group);
			if (present(chapter.fork_point)) {
				const fork = JSON.parse(String(chapter.fork_point));
				if (fork.commitSha) addObject(fork.commitSha, "commit", false, group);
				else if (fork.sha) addObject(fork.sha, "commit", false, group);
				else throw new Error("unknown fork point representation");
			}
		}
		for (const commit of manifest.references.chapter_commits ?? [])
			addObject(commit.sha, "commit", false, chapterGroups.get(String(commit.chapter_id)));
		for (const message of messages.values()) {
			const toolSources = new Set(
				[...tools.values()]
					.filter((tool) => tool.message_id === message.id)
					.map((tool) => toolGroups.get(String(tool.id)))
					.filter((group): group is WorkspaceGroup => !!group),
			);
			let group: WorkspaceGroup | undefined = !linkedMode
				? groups.get(root)
				: toolSources.size === 1
					? [...toolSources][0]
					: undefined;
			const hasShadow = present(message.tree_hash_after) || present(message.snapshot_commit_sha);
			if (linkedMode && hasShadow && !group) {
				if (toolSources.size > 1) throw new Error("ambiguous message execution workspace origin");
				const memberships = new Set<WorkspaceGroup>();
				for (const table of ["worktree_tree_snapshots", "snapshot_captures"])
					for (const row of manifest.references[table] ?? []) {
						if (
							(!present(message.tree_hash_after) || row.tree_hash === message.tree_hash_after) &&
							(!present(message.snapshot_commit_sha) ||
								row.snapshot_commit_sha === message.snapshot_commit_sha)
						) {
							const candidate = historyOrigins.get(`${table}\0${row.id}`);
							if (candidate) memberships.add(candidate);
						}
					}
				if (memberships.size !== 1)
					throw new Error("unknown or ambiguous message snapshot membership origin");
				group = [...memberships][0];
			}
			if (group)
				recordOrigin(
					"narrator_messages",
					String(message.id),
					group,
					!linkedMode
						? "root_only"
						: toolSources.size === 1
							? "execution_cwd"
							: "snapshot_membership",
				);
			addObject(message.commit_sha, "commit", false, group);
			addObject(message.tree_hash_after, "tree", true, group);
			addObject(message.snapshot_commit_sha, "commit", true, group);
		}
		for (const tool of tools.values()) {
			addObject(tool.tree_hash_before, "tree", true, toolGroups.get(String(tool.id)));
			addObject(tool.tree_hash_after, "tree", true, toolGroups.get(String(tool.id)));
		}
		for (const table of ["worktree_tree_snapshots", "snapshot_captures"])
			for (const row of manifest.references[table] ?? []) {
				const group = historyOrigins.get(`${table}\0${row.id}`);
				addObject(row.tree_hash, "tree", true, group);
				addObject(row.snapshot_commit_sha, "commit", true, group);
			}
		const verify = (path: string, objects: Map<string, "tree" | "commit">) => {
			if (!objects.size) return;
			const response = git(
				path,
				["cat-file", "--batch-check=%(objectname) %(objecttype)"],
				`${[...objects.keys()].join("\n")}\n`,
			).split("\n");
			if (response.length !== objects.size) throw new Error("incomplete object verification");
			let index = 0;
			for (const [sha, kind] of objects)
				if (response[index++] !== `${sha} ${kind}`)
					throw new Error("SHA missing from correct repository namespace");
		};
		for (const session of manifest.references.merge_sessions ?? []) {
			const group =
				chapterGroups.get(String(session.target_chapter_id)) ??
				(!linkedMode ? groups.get(root) : undefined);
			if (!group) throw new Error("external completed merge target workspace is not bound");
			recordOrigin("merge_sessions", String(session.id), group, "chapter");
			addObject(session.pre_merge_target_sha, "commit", false, group);
			addObject(session.pre_merge_target_snapshot, "commit", true, group);
			addObject(session.merge_source_snapshot, "commit", true, group);
			addObject(session.pre_merge_tree, "tree", true, group);
		}
		verify(root, new Map([...commonRealObjects].map((sha) => [sha, "commit" as const])));
		for (const group of groups.values()) {
			verify(group.path, new Map([...group.realObjects].map((sha) => [sha, "commit" as const])));
			const shadowKey = group.shadowKey;
			const shadowObjects = group.shadowObjects;
			const proof = group.linkedEvidence;
			let workspaceIdentity = manifest.gitIdentity;
			if (group.kind === "linked") {
				if (
					!proof ||
					git(group.path, ["rev-parse", "--show-toplevel"]) !== group.path ||
					git(group.path, ["rev-parse", "--absolute-git-dir"]) !== proof.adminDir ||
					git(group.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== gitDir
				)
					throw new Error("linked Git/admin/common identity changed");
				const entries = [
					...identity(group.path, false).entries,
					...identity(proof.gitfile, false).entries,
					...identity(proof.adminDir, false).entries,
				];
				for (const name of ["HEAD", "index", "commondir", "gitdir"]) {
					try {
						entries.push(...identity(join(proof.adminDir, name), false, true).entries);
					} catch (error) {
						if (
							(error as NodeJS.ErrnoException).code !== "ENOENT" ||
							!missing(join(proof.adminDir, name))
						)
							throw error;
					}
				}
				entries.push({
					path: proof.adminDir,
					head: git(group.path, ["rev-parse", "HEAD"]),
					branch: proof.branch,
					common: proof.common,
					registrationId: proof.registration.id,
					registrationWorktree: proof.registration.worktree,
					inventoryDigest: proof.inventoryDigest,
					metadataManifestDigest: proof.metadataManifestDigest,
				});
				workspaceIdentity = { digest: hash(entries), entries };
				for (const name of [
					"MERGE_HEAD",
					"CHERRY_PICK_HEAD",
					"REVERT_HEAD",
					"rebase-merge",
					"rebase-apply",
					"sequencer",
					"index.lock",
				])
					if (!missing(join(proof.adminDir, name)))
						throw new Error("linked Git conflict/reapply in progress");
				if (git(group.path, ["ls-files", "--unmerged"]))
					throw new Error("linked Git index has unresolved conflicts");
			}
			if (!workspaceIdentity) throw new Error("missing verified workspace Git identity");
			const workspace = {
				workspacePath: group.path,
				kind: group.kind,
				sourceChapterIds: [...group.chapterIds],
				shadowKey,
				shadowDirectory: group.shadowDirectories[0] ?? "",
				commonDirectoryPath: gitDir,
				gitAdminDirectoryPath: proof?.adminDir ?? gitDir,
				gitfilePath: proof?.gitfile ?? null,
				branch: proof?.branch ?? git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]),
				headCommitSha: proof?.head ?? git(root, ["rev-parse", "HEAD"]),
				identityDigest: proof?.digest ?? workspaceIdentity.digest,
				gitIdentity: workspaceIdentity,
				...(proof ? { linkedEvidence: proof } : {}),
			};
			account(workspace);
			manifest.workspaces.push(workspace);
			if (
				manifest.chapters.some(
					(c) =>
						group.chapterIds.includes(String(c.id)) &&
						present(c.snapshot_shadow_key) &&
						c.snapshot_shadow_key !== shadowKey,
				) ||
				(!input.workspaceBindings && input.snapshotShadowKeys.some((key) => key !== shadowKey))
			)
				throw new Error("shadow namespace differs from root");
			if (shadowObjects.size && group.shadowDirectories.length !== 1)
				throw new Error("ambiguous shadow repository");
			for (const path of group.shadowDirectories) {
				let before: ReturnType<typeof identity>;
				try {
					before = identity(path, true, true);
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code === "ENOENT" &&
						!shadowObjects.size &&
						missing(path)
					) {
						retain("artifact_inventory", [{ id: path, kind: "shadow", exists: 0 }]);
						continue;
					}
					throw error;
				}
				if (
					git(path, ["rev-parse", "--is-bare-repository"]) !== "true" ||
					git(path, ["rev-parse", "--absolute-git-dir"]) !== path
				)
					throw new Error("shadow is not canonical bare repository");
				if (!missing(join(path, "objects", "info", "alternates")))
					throw new Error("external shadow object dependency");
				verify(path, shadowObjects);
				if (identity(path, true, true).digest !== before.digest)
					throw new Error("shadow changed during prepare");
				for (const sourceChapterId of group.chapterIds)
					manifest.assets.push({
						sourceChapterId,
						kind: "shadow",
						deviceId: "local",
						workspacePath: group.path,
						artifactPath: path,
						shadowKey,
						identity: before,
					});
			}
		}
		const archiveCandidates = new Map<string, { sourceChapterId: string; artifactPath: string }>();
		for (const sourceChapterId of input.chapterIds) {
			if (!/^[a-zA-Z0-9_-]+$/.test(sourceChapterId))
				throw new Error("unsafe source chapter artifact key");
			const artifactPath = getNarraforkPath("dormant-ignored", sourceChapterId);
			archiveCandidates.set(artifactPath, { sourceChapterId, artifactPath });
		}
		for (const archive of input.ignoredArchiveDirectories ?? []) {
			if (!input.chapterIds.includes(archive.sourceChapterId))
				throw new Error("unknown ignored archive owner");
			if (
				archiveCandidates.has(archive.artifactPath) &&
				archiveCandidates.get(archive.artifactPath)?.sourceChapterId !== archive.sourceChapterId
			)
				throw new Error("ambiguous ignored archive ownership");
			archiveCandidates.set(archive.artifactPath, archive);
		}
		for (const archive of archiveCandidates.values()) {
			let before: ReturnType<typeof identity>;
			try {
				before = identity(archive.artifactPath, true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !missing(archive.artifactPath))
					throw error;
				retain("artifact_inventory", [
					{
						id: archive.artifactPath,
						sourceChapterId: archive.sourceChapterId,
						kind: "ignored_archive",
						exists: 0,
					},
				]);
				continue;
			}
			retain("artifact_inventory", [
				{
					id: archive.artifactPath,
					sourceChapterId: archive.sourceChapterId,
					kind: "ignored_archive",
					exists: 1,
					digest: before.digest,
				},
			]);
			if (identity(archive.artifactPath, true).digest !== before.digest)
				throw new Error("ignored archive changed during prepare");
			manifest.assets.push({
				...archive,
				kind: "ignored_archive",
				deviceId: "local",
				workspacePath: chapterGroups.get(archive.sourceChapterId)?.path ?? root,
				identity: before,
			});
		}
		for (const inventory of manifest.references.artifact_inventory ?? []) {
			if (!inventory.exists && !missing(String(inventory.id)))
				throw new Error("artifact appeared during prepare");
		}
		if (gitIdentity().digest !== manifest.gitIdentity.digest)
			throw new Error("physical Git identity changed during prepare");
		if (hash(databaseIdentity()) !== hash(manifest.databaseIdentity))
			throw new Error("database replaced during prepare");
		for (const records of Object.values(manifest.references))
			records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		guards.sort((a, b) => a.id.localeCompare(b.id));
		check();
		if (Buffer.byteLength(JSON.stringify(manifest)) > limits.bytes)
			throw new Error("manifest byte budget exceeded");
		return result();
	} catch (error) {
		return result(error instanceof Error ? error.message : "retained history inspection failed");
	} finally {
		try {
			db?.exec("ROLLBACK");
		} catch {}
		db?.close();
	}
}

/** Worker entry: deserialized evidence is never a native guard. Re-probe every linked
 * source before the readonly SQLite snapshot and once again before publishing it. */
export async function inspectLegacyRetainedHistoryWithBindingsReadonly(
	input: LegacyRetainedHistoryInput,
): Promise<LegacyRetainedHistoryResult> {
	const linked = input.workspaceBindings?.filter((binding) => binding.kind === "linked") ?? [];
	if (!linked.length) return inspectLegacyRetainedHistoryReadonly(input);
	const started = performance.now();
	const fail = (reason: string): LegacyRetainedHistoryResult => ({
		status: "unknown",
		complete: false,
		digest: hash({ input, reason }),
		reason: reason.slice(0, 160),
		guards: [],
		manifest: emptyLegacyRetainedManifest(input),
	});
	try {
		if (
			linked.length > LEGACY_RETAINED_HISTORY_LIMITS.inputs ||
			Buffer.byteLength(JSON.stringify(input)) > LEGACY_RETAINED_HISTORY_LIMITS.bytes
		)
			throw new Error("linked binding probe input budget exceeded");
		const signal = AbortSignal.timeout(LEGACY_RETAINED_HISTORY_LIMITS.milliseconds);
		const proofs = new Map<string, LegacyLinkedWorktreeEvidence>();
		for (const binding of linked) {
			if (
				!binding.linked ||
				binding.linked.input.projectRoot !== input.mainCheckoutRoot ||
				binding.linked.input.worktreePath !== binding.workspacePath ||
				Buffer.byteLength(JSON.stringify(binding.linked.evidence)) > 16 * 1024
			)
				throw new Error("unverified linked source probe input");
			const proof = await revalidateLegacyLinkedWorktreeIdentity(
				{ ...binding.linked.input, signal },
				binding.linked.evidence,
			);
			assertLegacyLinkedWorktreeIdentityUnchangedSync(proof);
			proofs.set(binding.sourceChapterId, proof);
		}
		verifiedLinkedBindings.set(input, { bindingsDigest: hash(input.workspaceBindings), proofs });
		const result = inspectLegacyRetainedHistoryReadonly(input, {
			...LEGACY_RETAINED_HISTORY_LIMITS,
			milliseconds: Math.max(
				0,
				LEGACY_RETAINED_HISTORY_LIMITS.milliseconds - (performance.now() - started),
			),
		});
		if (result.status !== "retained") return result;
		for (const binding of linked) {
			const initial = proofs.get(binding.sourceChapterId);
			if (!initial || !binding.linked) throw new Error("missing fresh native linked source guard");
			const fresh = await revalidateLegacyLinkedWorktreeIdentity(
				{ ...binding.linked.input, signal },
				initial,
			);
			assertLegacyLinkedWorktreeIdentityUnchangedSync(fresh);
		}
		if (performance.now() - started > LEGACY_RETAINED_HISTORY_LIMITS.milliseconds)
			throw new Error("linked binding probe total time budget exceeded");
		const databaseIdentity = result.manifest.databaseIdentity;
		const databaseStat = lstatSync(input.databasePath, { bigint: true });
		if (
			!databaseIdentity ||
			!databaseStat.isFile() ||
			databaseStat.isSymbolicLink() ||
			realpathSync(input.databasePath) !== databaseIdentity.path ||
			String(databaseStat.dev) !== databaseIdentity.dev ||
			String(databaseStat.ino) !== databaseIdentity.ino ||
			String(databaseStat.birthtimeNs) !== databaseIdentity.birthtimeNs
		)
			throw new Error("database replaced during linked post-probe");
		return result;
	} catch (error) {
		return fail(error instanceof Error ? error.message : "linked retained identity probe failed");
	} finally {
		verifiedLinkedBindings.delete(input);
	}
}
