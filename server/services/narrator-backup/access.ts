import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { localPathSemantics as paths } from "@server/lib/agent/execution/path-semantics";
import {
	intersectOAuthClientPolicies,
	normalizeOAuthClientPolicy,
} from "@server/lib/oauth-client-policy";
import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import { compileExecutionPolicy } from "../execution-policy/compiler";
import {
	mergeExecutionPolicyRuleSets,
	normalizeExecutionPolicyRuleSet,
} from "../execution-policy/normalize";
import type {
	ExecutionTargetContext,
	LegacyExecutionPolicyRuleSet,
} from "../execution-policy/types";
import { gitPathPolicyAllows } from "../git-workspace-path-policy";
import type { ArchiveRow, ArchiveValue } from "../project-archive/main-store";
import type { BackupActor, BackupState } from "./contract";
import type { BackupSqlConnection } from "./main-store";
import { readBackupObjectFile } from "./objects";
import { assertFullExport } from "./state";

export interface BackupAccessOptions {
	/** Server-controlled path; reread on every fence, never an uploaded policy. */
	settingsPath?: string;
	dataDirectory?: string;
}
const denied = () => new Error("Current backup source authorization required");
const json = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
const enabled = (value: unknown) => value === true || value === 1;

/** SQL guards keep denied/oversized policy fields out of the worker's JS heap.
 * Fixed SELECTs only. The inner LIMIT bounds the window sum on SQLite and PG.
 */
async function boundedAccessQuery(
	store: BackupSqlConnection,
	sql: string,
	values: ArchiveValue[] = [],
): Promise<ArchiveRow[]> {
	const match = sql.match(/^SELECT ([a-z_, ]+) FROM ([\s\S]+ LIMIT [0-9]+)$/);
	if (!match) throw new Error("Unsupported backup authorization query");
	const columns = match[1].split(",").map((column) => column.trim());
	const size = columns.map((column) => store.byteLength(column)).join("+");
	const guard = `_backup_bytes <= ${LIMITS.rowBytes} AND sum(_backup_bytes) OVER () <= ${LIMITS.rowBytes * 2}`;
	const rows = await store.query(
		`SELECT ${columns.map((column) => `CASE WHEN ${guard} THEN "${column}" ELSE NULL END AS "${column}"`).join(",")},_backup_bytes FROM (SELECT ${columns.join(",")},(${size}) AS _backup_bytes FROM ${match[2]}) AS bounded_backup_access`,
		values,
	);
	let total = 0;
	for (const row of rows) {
		const bytes = Number(row._backup_bytes);
		total += bytes;
		if (!Number.isSafeInteger(bytes) || bytes > LIMITS.rowBytes || total > LIMITS.rowBytes * 2)
			throw new Error("Backup authorization byte budget exceeded");
	}
	return rows.map((row) =>
		Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
	);
}

/** Mirrors project-acl's own global/project capabilities; domain grants never count. */
export async function requireBackupProjectAccess(
	store: BackupSqlConnection,
	id: string,
	actor: BackupActor,
	need: "read" | "write",
): Promise<ArchiveRow> {
	const project = (
		await boundedAccessQuery(
			store,
			"SELECT id,owner_user_id,visibility,git_path,chapter_settings FROM projects WHERE id=$1 LIMIT 1",
			[id],
		)
	)[0];
	if (!project) throw denied();
	if (
		actor.isAdmin ||
		project.owner_user_id === actor.userId ||
		(need === "read" && project.visibility === "public")
	)
		return project;
	const grant = await boundedAccessQuery(
		store,
		"SELECT id FROM acl_grants WHERE domain_kind IS NULL AND ((scope_type='project' AND scope_id=$1) OR (scope_type='global' AND scope_id IS NULL)) AND ((principal_type='user' AND principal_id=$2) OR (principal_type='role' AND principal_id=$3)) AND capability IN ('write','manage'" +
			(need === "read" ? ",'read')" : ")") +
			" LIMIT 1",
		[id, actor.userId, actor.isAdmin ? "admin" : "user"],
	);
	if (!grant.length) throw denied();
	return project;
}

/** The same independent project + owner axes as device-service.isDeviceAuthorized.
 * No management/admin bypass: administering a private device does not permit using it.
 */
export async function requireBackupDeviceAccess(
	store: BackupSqlConnection,
	id: string,
	projectId: string | null,
	actor: BackupActor,
): Promise<void> {
	if (id === "local") return;
	const device = (
		await boundedAccessQuery(
			store,
			"SELECT id,scope,project_id,owner_scope,created_by,revoked_at FROM remote_devices WHERE id=$1 LIMIT 1",
			[id],
		)
	)[0];
	if (
		!device ||
		device.revoked_at ||
		(device.scope !== "global" &&
			(device.scope !== "project" || !projectId || device.project_id !== projectId)) ||
		(device.owner_scope !== "shared" &&
			(device.owner_scope !== "private" || device.created_by !== actor.userId))
	)
		throw denied();
	const binding = (
		await boundedAccessQuery(
			store,
			"SELECT source_type,source_id,authority_type,authority_id,state FROM integration_resource_bindings WHERE resource_type='device' AND resource_id=$1 LIMIT 1",
			[id],
		)
	)[0];
	if (
		!binding ||
		binding.source_type !== "oauth_client" ||
		binding.authority_type !== "oauth_grant"
	)
		return;
	if (binding.state !== "active") throw denied();
	const authority = (
		await boundedAccessQuery(
			store,
			"SELECT kind,integration_type,integration_id,owner_user_id,state,policy_json,expires_at FROM integration_authorities WHERE id=$1 LIMIT 1",
			[binding.authority_id ?? null],
		)
	)[0];
	if (
		!authority ||
		authority.kind !== "oauth_grant" ||
		authority.integration_type !== "oauth_client" ||
		authority.integration_id !== binding.source_id ||
		authority.state !== "active" ||
		authority.owner_user_id !== device.created_by ||
		(typeof authority.expires_at === "string" && authority.expires_at <= new Date().toISOString())
	)
		throw denied();
	const client = (
		await boundedAccessQuery(
			store,
			"SELECT public_client,revoked_at,policy_json FROM oauth_clients WHERE id=$1 LIMIT 1",
			[binding.source_id ?? null],
		)
	)[0];
	if (
		!client ||
		!enabled(client.public_client) ||
		client.revoked_at ||
		!intersectOAuthClientPolicies(
			normalizeOAuthClientPolicy(json(authority.policy_json)),
			normalizeOAuthClientPolicy(json(client.policy_json)),
		)
	)
		throw denied();
}

export async function backupChapterProject(
	store: BackupSqlConnection,
	row: ArchiveRow,
): Promise<string | null> {
	if (typeof row.chapter_id === "string") {
		const chapter = (
			await boundedAccessQuery(store, "SELECT project_id FROM chapters WHERE id=$1 LIMIT 1", [
				row.chapter_id,
			])
		)[0];
		if (!chapter || typeof chapter.project_id !== "string") throw denied();
		return chapter.project_id;
	}
	return typeof row.context_project_id === "string" ? row.context_project_id : null;
}

async function canonical(path: string, depth = 0): Promise<string> {
	if (!paths.isAbsolute(path) || path.length > 32768 || depth > 128) throw denied();
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw denied();
		const parent = dirname(path);
		if (parent === path) throw denied();
		return join(await canonical(parent, depth + 1), paths.basename(path));
	}
}
function directoryRule(row: ArchiveRow) {
	return {
		id: String(row.id),
		path: String(row.path),
		pathFlavor: row.path_flavor as "posix" | "windows",
		accessLevel: row.access_level as "readOnly" | "readWrite" | "full",
		denyLevel: row.deny_level as "denyAll" | "denyWrite",
		enabled: enabled(row.enabled),
		targetKind: row.target_kind as "all" | "device" | "host" | "oauthGroup" | null,
		targetValue: row.target_value as string | null,
		deviceScope: row.device_scope as string | null,
	};
}

/** Read-only dependency injection. Current live metadata wins; a deleted ID uses
 * actor-attested declared metadata ONLY to locate today's project/device/policy gates.
 * Archived whitelist/blacklist/grant rows are NEVER used as current authority.
 */
export async function authorizeBackupSource(
	store: BackupSqlConnection,
	state: BackupState,
	actor: BackupActor,
	options: BackupAccessOptions,
	check: () => void,
	wholeTree: boolean,
	declaredProjectIds: readonly string[] = [],
): Promise<void> {
	const user = (
		await boundedAccessQuery(store, "SELECT id,role FROM users WHERE id=$1 LIMIT 1", [actor.userId])
	)[0];
	if (!user) throw denied();
	const fresh = { userId: actor.userId, isAdmin: actor.isAdmin && user.role === "admin" };
	for (const id of declaredProjectIds) {
		check();
		await requireBackupProjectAccess(store, id, fresh, "read");
	}
	let global: LegacyExecutionPolicyRuleSet = {};
	if (options.settingsPath) {
		const settings = json(
			(await readBackupObjectFile(options.settingsPath, check, LIMITS.rowBytes)).toString(),
		);
		global = settings.agent ?? {};
	}
	const declared = new Map((state.rows.narrators ?? []).map((row) => [String(row.id), row]));
	const current = new Map<string, ArchiveRow>();
	let metadataBytes = 0;
	for (const [id, row] of declared) {
		check();
		const live = (
			await boundedAccessQuery(
				store,
				"SELECT id,type,variant,parent_narrator_id,acl_root_narrator_id,owner_user_id,chapter_id,context_project_id,default_device_id,cwd,workspace_context,workspace_revision FROM narrators WHERE id=$1 LIMIT 1",
				[id],
			)
		)[0];
		metadataBytes += Buffer.byteLength(JSON.stringify(live ?? row));
		if (metadataBytes > LIMITS.stateBytes)
			throw new Error("Backup authorization metadata budget exceeded");
		current.set(id, live ?? row);
	}
	for (const row of current.values()) {
		check();
		assertFullExport(row, fresh, current.get(String(row.acl_root_narrator_id)));
		const chain: ArchiveRow[] = [];
		let next: ArchiveRow | undefined = row;
		while (next) {
			if (chain.some((r) => r.id === next?.id) || chain.length >= 16) throw denied();
			chain.push(next);
			next = String(next.variant).startsWith("subagent:")
				? current.get(String(next.parent_narrator_id))
				: undefined;
			if (String(chain.at(-1)?.variant).startsWith("subagent:") && !next) throw denied();
		}
		const projects = new Map<string, ArchiveRow>();
		for (const ancestor of chain) {
			const projectId = await backupChapterProject(store, ancestor);
			if (projectId)
				projects.set(projectId, await requireBackupProjectAccess(store, projectId, fresh, "read"));
			if (
				typeof ancestor.context_project_id === "string" &&
				ancestor.context_project_id !== projectId
			)
				projects.set(
					ancestor.context_project_id,
					await requireBackupProjectAccess(store, ancestor.context_project_id, fresh, "read"),
				);
		}
		const projectId = await backupChapterProject(store, row);
		const deviceId = typeof row.default_device_id === "string" ? row.default_device_id : "local";
		await requireBackupDeviceAccess(store, deviceId, projectId, fresh);
		const binding = await boundedAccessQuery(
			store,
			"SELECT id FROM integration_resource_bindings WHERE resource_type='narrator' AND resource_id=$1 AND source_type='oauth_client' LIMIT 1",
			[row.id ?? null],
		);
		// Backup profiles currently exclude OAuth snapshots. Never turn their grant-bound
		// authority into an ordinary actor-owned session by exporting that incomplete state.
		if (binding.length)
			throw new Error("OAuth narrator backup is unsupported without its runtime policy");
		const roots = new Set<string>();
		if (typeof row.cwd === "string" && row.cwd) roots.add(row.cwd);
		const historical = declared.get(String(row.id));
		if (typeof historical?.default_device_id === "string")
			await requireBackupDeviceAccess(store, historical.default_device_id, projectId, fresh);
		if (typeof historical?.cwd === "string" && historical.cwd) roots.add(historical.cwd);
		for (const metadata of [row, historical]) {
			if (typeof metadata?.workspace_context !== "string") continue;
			const context = json(metadata.workspace_context);
			const sourceDevice = metadata.default_device_id ?? "local";
			if (context.deviceId !== sourceDevice || context.revision !== metadata.workspace_revision)
				throw denied();
			if (typeof context.cwd === "string") roots.add(context.cwd);
			if (typeof context.git?.rootPath === "string") roots.add(context.git.rootPath);
		}
		if (wholeTree)
			for (const tool of state.rows.narrator_tool_calls ?? []) {
				if (tool.narrator_id !== row.id) continue;
				const id =
					typeof tool.execution_device_id === "string" ? tool.execution_device_id : deviceId;
				await requireBackupDeviceAccess(store, id, projectId, fresh);
				if (id !== "local" || (tool.runtime_generation != null && tool.runtime_generation !== 0))
					throw new Error("Historical source runtime unavailable; host fallback forbidden");
				if (typeof tool.execution_cwd === "string") roots.add(tool.execution_cwd);
			}
		for (const snapshot of state.rows.narrator_file_snapshots ?? []) {
			if (snapshot.narrator_id !== row.id) continue;
			const id = typeof snapshot.device_id === "string" ? snapshot.device_id : deviceId;
			await requireBackupDeviceAccess(store, id, projectId, fresh);
			if (id !== "local")
				throw new Error("Historical source runtime unavailable; host fallback forbidden");
			if (typeof snapshot.file_path === "string") roots.add(snapshot.file_path);
		}
		for (const resource of state.rows.narrator_worktree_resources ?? []) {
			if (resource.owner_narrator_id !== row.id) continue;
			const id = typeof resource.device_id === "string" ? resource.device_id : deviceId;
			await requireBackupDeviceAccess(store, id, projectId, fresh);
			if (id !== "local")
				throw new Error("Historical source runtime unavailable; host fallback forbidden");
			if (typeof resource.worktree_path === "string") roots.add(resource.worktree_path);
		}
		if (!roots.size) continue;
		if (
			deviceId !== "local" ||
			(historical?.default_device_id != null && historical.default_device_id !== "local")
		)
			throw new Error(
				"Backup path authorization requires a supported local source workspace; host fallback forbidden",
			);
		const ids = chain.map((r) => String(r.id));
		const marks = ids.map((_, i) => `$${i + 1}`).join(",");
		const whitelist = await boundedAccessQuery(
			store,
			`SELECT id,path,path_flavor,access_level,enabled,target_kind,target_value,device_scope FROM narrator_whitelist_dirs WHERE narrator_id IN (${marks}) LIMIT 2001`,
			ids,
		);
		const blacklist = await boundedAccessQuery(
			store,
			`SELECT id,path,path_flavor,deny_level,enabled,target_kind,target_value,device_scope FROM narrator_blacklist_dirs WHERE narrator_id IN (${marks}) LIMIT 2001`,
			ids,
		);
		if (whitelist.length > 2000 || blacklist.length > 2000)
			throw new Error("Backup policy budget exceeded");
		const rules = mergeExecutionPolicyRuleSets(
			normalizeExecutionPolicyRuleSet(global, "global"),
			...[...projects.values()].map((project) =>
				normalizeExecutionPolicyRuleSet(
					json(project.chapter_settings) as LegacyExecutionPolicyRuleSet,
					"project",
				),
			),
			normalizeExecutionPolicyRuleSet(
				{
					whitelistDirs: whitelist.map(directoryRule),
					blacklistDirs: blacklist.map(directoryRule),
				},
				"narrator",
			),
		);
		for (const rule of [...rules.directoryWhitelist, ...rules.directoryBlacklist])
			if (rule.pathFlavor === paths.flavor) rule.path = await canonical(rule.path);
		for (const root of roots) {
			check();
			const path = await canonical(root);
			const data = options.dataDirectory;
			if (
				(data && (paths.contains(data, path) || paths.contains(path, data))) ||
				[".ssh", ".aws", ".gnupg", ".kube", ".config/gcloud", ".azure"].some(
					(part) =>
						paths.contains(join(homedir(), part), path) ||
						paths.contains(path, join(homedir(), part)),
				)
			)
				throw denied();
			// Compiler only uses paths and the frozen selector target, never a backend operation.
			const context = {
				paths,
				deviceClass: "host",
				target: {
					deviceId: "local",
					backendKind: "local",
					cwd: path,
					lexicalPath: path,
					canonicalPath: path,
					pathFlavor: paths.flavor,
					runtimeGeneration: 0,
					selectionSource: "session_default",
				},
			} as ExecutionTargetContext;
			if (!gitPathPolicyAllows(compileExecutionPolicy(rules, context), context, path, "read"))
				throw denied();
			// Standalone/historical cwd cannot bypass a project nested beneath it or an alias.
			const related = await boundedAccessQuery(
				store,
				"SELECT id,git_path FROM projects ORDER BY id LIMIT 2001",
			);
			if (related.length > 2000) throw new Error("Backup related project scan budget exceeded");
			for (const project of related) {
				if (typeof project.git_path !== "string") throw denied();
				const gitPath = await canonical(project.git_path);
				if (paths.contains(gitPath, path) || paths.contains(path, gitPath))
					await requireBackupProjectAccess(store, String(project.id), fresh, "read");
			}
			const chapters = await boundedAccessQuery(
				store,
				"SELECT project_id,worktree_path FROM chapters WHERE worktree_path IS NOT NULL ORDER BY id LIMIT 2001",
			);
			if (chapters.length > 2000) throw new Error("Backup chapter scan budget exceeded");
			for (const chapter of chapters)
				if (typeof chapter.worktree_path === "string") {
					const worktree = await canonical(chapter.worktree_path);
					if (paths.contains(worktree, path) || paths.contains(path, worktree))
						await requireBackupProjectAccess(store, String(chapter.project_id), fresh, "read");
				}
		}
	}
}
