import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	type GitStagingAction,
	type GitStagingActionResult,
	type GitStagingDiff,
	type GitStagingFile,
	type GitStagingFilesPage,
	type GitStagingStatsBuckets,
	type GitStagingSummary,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../shared/git-staging-lists";
import type { GitStatusFilterChar } from "../../shared/git-status-page";
import { commitChangelist, recoverChangelistCommit } from "./git-changelist-commit";
import {
	changelistObservationPaths,
	checkPathParents,
	checkRelativePath,
	observeChangelists,
	ownershipUnits,
	readBoundedFile,
} from "./git-changelist-observer";
import {
	materializeTextOwnership,
	moveTextUnits,
	normalizeTextOwnership,
} from "./git-changelist-ownership";
import {
	type ChangelistRepository,
	ChangelistStore,
	type StoredFile,
} from "./git-changelist-store";
import { GitStagingKernelError } from "./git-staging-process";
import { projectGitStagingPage } from "./git-staging-stats";
import { projectGitStagingUnitDiff } from "./git-staging-unit-diff";

export type GitStagingBaseline = Pick<
	GitStagingSummary,
	"initialized" | "generation" | "observationId" | "state"
>;
export type GitStagingKernelAction = (
	| Exclude<GitStagingAction, { action: "create" }>
	| (Extract<GitStagingAction, { action: "create" }> & { listId?: string })
) & { authorizedPaths?: string[] };
export interface GitStagingFilesOptions {
	cursor?: string;
	limit?: number;
	filter?: GitStatusFilterChar[];
}
export interface GitStagingDiffOptions {
	path: string;
	oldPath?: string;
}
const fail = (code: string, message: string) => new GitStagingKernelError(code, message);
const invalid = (message: string) => fail("GIT_STAGING_INVALID", message);
const validId = (id: string) => {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid("Invalid changelist identity");
	return id;
};
function validName(name: string) {
	if (
		typeof name !== "string" ||
		!name.trim() ||
		[...name].length > LIMITS.maxNameChars ||
		[...name].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
		})
	)
		throw invalid("Invalid changelist name");
	return name;
}
export async function resolveGitStagingRepository(rootPath: string): Promise<ChangelistRepository> {
	const root = await realpath(rootPath),
		dotgit = join(root, ".git"),
		info = await lstat(dotgit);
	let gitDir: string;
	if (info.isDirectory() && !info.isSymbolicLink()) gitDir = await realpath(dotgit);
	else {
		const pointer = await readBoundedFile(dotgit, 8192);
		const match = pointer && /^gitdir: (.+?)[\r\n]*$/.exec(pointer.toString());
		if (!match?.[1] || /[\0\r\n]/.test(match[1])) throw invalid("Invalid Git-dir pointer");
		gitDir = await realpath(resolve(root, match[1]));
	}
	const normalized =
		process.platform === "win32" ? gitDir.replaceAll("\\", "/").toLowerCase() : gitDir;
	return {
		root,
		gitDir,
		directory: join(gitDir, "narrafork", "changelists"),
		index: join(gitDir, "index"),
		key: createHash("sha256").update(normalized).digest("hex"),
	};
}
function status(file: { base_mode: string; work_mode: string; path: string; base_path: string }) {
	return file.path !== file.base_path
		? "R"
		: file.base_mode === "000000"
			? "A"
			: file.work_mode === "000000"
				? "D"
				: file.base_mode.slice(0, 3) !== file.work_mode.slice(0, 3)
					? "T"
					: "M";
}
function buckets(rows: GitStagingFile[]): GitStagingStatsBuckets {
	const out: GitStagingStatsBuckets = {};
	for (const row of rows) {
		const key = row.status[0] as keyof GitStagingStatsBuckets;
		out[key] ??= { files: 0, added: 0, removed: 0, binaryFiles: 0, gitlinkFiles: 0 };
		const entry = out[key];
		entry.files++;
		if (row.stats.kind === "text") {
			entry.added += row.stats.added;
			entry.removed += row.stats.removed;
		} else if (row.stats.kind === "binary") entry.binaryFiles++;
		else entry.gitlinkFiles++;
	}
	return out;
}
function fileRows(store: ChangelistStore, listId?: string) {
	const state = store.state();
	if (!state.observation_id) return [];
	const rows = store.db
		.query(
			`SELECT f.file_id,f.path,f.base_path,f.base_mode,f.work_mode,COUNT(u.id) unit_count,SUM(u.added) added,SUM(u.removed) removed,SUM(u.needs_review) needs_review_count,MAX(u.kind IN ('binary','symlink')) binary,MAX(u.kind='gitlink') gitlink FROM observation_files m JOIN file_snapshots f ON f.version_id=m.version_id JOIN change_units u ON u.version_id=f.version_id WHERE m.observation_id=? ${listId ? "AND u.list_id=?" : ""} GROUP BY f.file_id ORDER BY f.path LIMIT ${LIMITS.maxRowsPerList + 1}`,
		)
		.all(...(listId ? [state.observation_id, listId] : [state.observation_id])) as {
		file_id: string;
		path: string;
		base_path: string;
		base_mode: string;
		work_mode: string;
		unit_count: number;
		added: number;
		removed: number;
		needs_review_count: number;
		binary: number;
		gitlink: number;
	}[];
	if (rows.length > LIMITS.maxRowsPerList)
		throw fail("GIT_STAGING_LIMIT", "Too many changed files");
	return rows.map((row) => ({
		fileId: row.file_id,
		path: row.path,
		...(row.base_path !== row.path ? { oldPath: row.base_path } : {}),
		status: status(row),
		stats: row.gitlink
			? { kind: "gitlink" as const }
			: row.binary
				? { kind: "binary" as const }
				: { kind: "text" as const, added: row.added, removed: row.removed },
		unitCount: row.unit_count,
		needsReviewCount: row.needs_review_count,
	}));
}
function requireList(store: ChangelistStore, id: string) {
	validId(id);
	if (!store.db.query("SELECT 1 FROM change_lists WHERE id=? AND archived=0").get(id))
		throw fail("GIT_STAGING_NOT_FOUND", "Changelist does not exist");
}
function version(store: ChangelistStore, listId: string) {
	const state = store.state();
	const hash = createHash("sha256").update(listId);
	let count = 0;
	// Hash the selected group's projected mode, matching candidateFile's priority.
	for (const row of store.db
		.query(
			`WITH owned_modes AS (
				SELECT u.version_id,MAX(u.kind='delete') AS deletes_path,
					MAX(u.kind IN ('binary','symlink','gitlink','create','mode')) AS uses_work_mode,
					MAX(u.kind='rename') AS renames_path
				FROM observation_files m JOIN change_units u ON u.version_id=m.version_id
				WHERE m.observation_id=? AND u.list_id=? GROUP BY u.version_id
			)
			SELECT u.id,u.kind,u.path,u.old_path,u.base_start,u.base_end,
				u.added,u.removed,u.needs_review,u.review_reason,u.content_hash,f.base_oid,f.base_mode,
				CASE WHEN modes.deletes_path THEN '000000'
					WHEN modes.uses_work_mode OR (modes.renames_path AND f.base_mode='000000')
					THEN f.work_mode ELSE f.base_mode END AS candidate_mode
			FROM owned_modes modes JOIN file_snapshots f ON f.version_id=modes.version_id
			JOIN change_units u ON u.version_id=f.version_id AND u.list_id=?
			ORDER BY u.path,u.base_start,u.work_start,u.id`,
		)
		.iterate(state.observation_id, listId, listId)) {
		if (++count > LIMITS.maxStatsOperations)
			throw fail("GIT_STAGING_LIMIT", "Group snapshot exceeds the unit budget");
		hash.update(JSON.stringify(row));
	}
	return hash.digest("hex");
}
function actionResult(
	store: ChangelistStore,
	affectedListIds: string[],
	listId?: string,
): GitStagingActionResult {
	const state = store.state();
	return {
		outcome: "applied",
		generation: state.generation,
		observationId: state.observation_id,
		affectedListIds,
		...(listId ? { listId } : {}),
	};
}
function selectUnits(
	store: ChangelistStore,
	action: Extract<GitStagingAction, { action: "move" }>,
) {
	requireList(store, action.fromListId);
	requireList(store, action.toListId);
	const selectors =
		Number(action.all === true) +
		Number(action.paths !== undefined) +
		Number(action.unitIds !== undefined) +
		Number(action.scope !== undefined);
	if (selectors !== 1)
		throw invalid("Select paths, units, scope or all changes from the source list");
	if (action.scope && !action.scope.directory && !action.scope.filter?.length)
		throw invalid("An empty scope is not an explicit all-files selection");
	const conditions = ["c.list_id=?"];
	const parameters: string[] = [action.fromListId];
	let paths: Set<string> | undefined, ids: Set<string> | undefined;
	// JSON selectors keep the parameter count fixed even for thousands of identities.
	if (action.paths) {
		if (!action.paths.length || action.paths.length > LIMITS.maxFilesPerOperation)
			throw invalid("Invalid path selection");
		paths = new Set(action.paths.map(checkRelativePath));
		conditions.push("c.path IN (SELECT value FROM json_each(?))");
		parameters.push(JSON.stringify([...paths]));
	}
	if (action.unitIds) {
		if (!action.unitIds.length || action.unitIds.length > LIMITS.maxUnitsPerOperation)
			throw invalid("Invalid unit selection");
		ids = new Set(
			action.unitIds.map((id) => {
				if (typeof id !== "string" || !id || id.length > 256 || /[\0\r\n]/.test(id))
					throw invalid("Invalid change unit identity");
				return id;
			}),
		);
		conditions.push("c.unit_id IN (SELECT value FROM json_each(?))");
		parameters.push(JSON.stringify([...ids]));
	}
	if (action.scope?.directory) {
		checkRelativePath(action.scope.directory);
		conditions.push("instr(c.path,?)=1");
		parameters.push(`${action.scope.directory}/`);
	}
	if (action.scope?.filter?.length) {
		conditions.push(`EXISTS (
			SELECT 1 FROM observation_files m JOIN file_snapshots f ON f.version_id=m.version_id
			WHERE m.observation_id=c.observation_id AND m.file_id=c.file_id
			AND CASE WHEN f.path<>f.base_path THEN 'R' WHEN f.base_mode='000000' THEN 'A'
				WHEN f.work_mode='000000' THEN 'D' ELSE 'M' END IN (SELECT value FROM json_each(?))
		)`);
		parameters.push(JSON.stringify(action.scope.filter));
	}
	const units = store.db
		.query(
			`SELECT c.unit_id,c.file_id,c.path,c.old_path FROM v_changes c
			WHERE ${conditions.join(" AND ")} ORDER BY c.path,c.unit_id LIMIT ?`,
		)
		.all(...parameters, LIMITS.maxUnitsPerOperation + 1) as {
		unit_id: string;
		file_id: string;
		path: string;
		old_path: string | null;
	}[];
	if (units.length > LIMITS.maxUnitsPerOperation)
		throw fail("GIT_STAGING_LIMIT", "The selection exceeds the unit budget");
	if (paths) {
		const selectedPaths = new Set(units.map((u) => u.path));
		if ([...paths].some((path) => !selectedPaths.has(path)))
			throw fail("GIT_STAGING_STALE_VERSION", "A selected path has no changes in the source list");
	}
	if (ids && units.length !== ids.size)
		throw fail("GIT_STAGING_STALE_VERSION", "A selected unit no longer belongs to the source list");
	return units;
}

/** Worker-only dynamic changelists; queries read the last published SQLite observation. */
export class IndependentGitStagingKernel {
	private readonly repo: Promise<ChangelistRepository>;
	constructor(
		rootPath: string,
		private readonly workspaceKey: string,
		private readonly signal?: AbortSignal,
	) {
		this.repo = resolveGitStagingRepository(rootPath);
	}
	private async store(create = false) {
		const store = await ChangelistStore.open(await this.repo, create);
		if (!store)
			throw fail(
				"GIT_STAGING_NOT_INITIALIZED",
				"Initialize changelists before using this operation",
			);
		return store;
	}
	async baseline(): Promise<GitStagingBaseline> {
		const store = await ChangelistStore.open(await this.repo, false);
		if (!store)
			return {
				initialized: false,
				generation: 0,
				observationId: null,
				state: "uninitialized",
			};
		try {
			store.db.exec("BEGIN");
			const state = store.state();
			// Compile the summary projection without stepping its aggregate view.
			store.db.query(
				"SELECT id,name,active,file_count,unit_count,added,removed,needs_review_count FROM v_changelists LIMIT 0",
			);
			return {
				initialized: state.observation_id !== null,
				generation: state.generation,
				observationId: state.observation_id,
				state: state.state,
			};
		} finally {
			store.close();
		}
	}
	async summary(): Promise<GitStagingSummary> {
		const store = await ChangelistStore.open(await this.repo);
		if (!store)
			return {
				capability: { supported: true },
				workspaceKey: this.workspaceKey,
				initialized: false,
				generation: 0,
				observationId: null,
				activeListId: null,
				scannedAt: null,
				state: "uninitialized",
				lists: [],
				stats: {},
			};
		try {
			store.db.exec("BEGIN");
			const state = store.state();
			const raw = store.db
				.query("SELECT * FROM v_changelists ORDER BY active DESC,name,id LIMIT ?")
				.all(LIMITS.maxSummaryLists + 1) as {
				id: string;
				name: string;
				active: number;
				file_count: number;
				unit_count: number;
				added: number;
				removed: number;
				needs_review_count: number;
			}[];
			if (raw.length > LIMITS.maxSummaryLists)
				throw fail("GIT_STAGING_LIMIT", "Too many changelists");
			const summary: GitStagingSummary = {
				capability: { supported: true },
				workspaceKey: this.workspaceKey,
				initialized: state.observation_id !== null,
				generation: state.generation,
				observationId: state.observation_id,
				activeListId: state.active_list_id,
				scannedAt: state.scanned_at,
				state: state.state,
				stats: buckets(fileRows(store)),
				lists: raw.map((l) => ({
					id: l.id,
					name: l.name,
					active: !!l.active,
					snapshotVersion: version(store, l.id),
					fileCount: l.file_count,
					unitCount: l.unit_count,
					added: l.added,
					removed: l.removed,
					needsReviewCount: l.needs_review_count,
					stats: buckets(fileRows(store, l.id)),
				})),
			};
			if (Buffer.byteLength(JSON.stringify(summary)) > LIMITS.maxSummaryBytes)
				throw fail("GIT_STAGING_LIMIT", "Changelist summary exceeded its response budget");
			return summary;
		} finally {
			store.close();
		}
	}
	async files(listId: string, options: GitStagingFilesOptions = {}): Promise<GitStagingFilesPage> {
		const store = await this.store();
		try {
			store.db.exec("BEGIN");
			requireList(store, listId);
			const state = store.state(),
				snapshotVersion = version(store, listId);
			const cursorVersion = `${snapshotVersion}:${[...(options.filter ?? [])].sort().join("")}`;
			let offset = 0;
			if (options.cursor) {
				try {
					if (options.cursor.length > 512) throw invalid("Invalid cursor");
					const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
					if (
						!Array.isArray(cursor) ||
						cursor.length !== 2 ||
						cursor[0] !== cursorVersion ||
						!Number.isSafeInteger(cursor[1]) ||
						cursor[1] < 0
					)
						throw invalid("Invalid cursor");
					offset = cursor[1];
				} catch {
					throw fail("GIT_STAGING_STALE_CURSOR", "The observation changed; reload its files");
				}
			}
			let rows = fileRows(store, listId);
			if (options.filter?.length)
				rows = rows.filter((f) =>
					options.filter?.includes((f.status === "T" ? "M" : f.status[0]) as GitStatusFilterChar),
				);
			const page = projectGitStagingPage(rows, {
				workspaceKey: this.workspaceKey,
				listId,
				snapshotVersion,
				cursorVersion,
				generation: state.generation,
				observationId: state.observation_id,
				offset,
				limit: options.limit ?? LIMITS.maxPageRows,
			});
			store.assertVersion(state.generation, state.observation_id);
			return page;
		} finally {
			store.close();
		}
	}
	async diff(listId: string, options: GitStagingDiffOptions): Promise<GitStagingDiff> {
		const store = await this.store();
		try {
			store.db.exec("BEGIN");
			requireList(store, listId);
			checkRelativePath(options.path);
			const state = store.state();
			const fileId = store.fileIds().find((f) => f.path === options.path)?.file_id;
			const file = fileId ? store.loadFile(fileId) : null;
			if (!file) throw fail("GIT_STAGING_NOT_FOUND", "File is not in the observation");
			const units = file.units.filter((u) => u.listId === listId);
			if (!units.length) throw fail("GIT_STAGING_NOT_FOUND", "File has no changes in this list");
			let diff: string;
			let selected: string | undefined;
			if (file.ownership) {
				selected = materializeTextOwnership(file.ownership, { groupIds: [listId] });
				const rendered = createTwoFilesPatch(
					file.basePath,
					file.path,
					file.ownership.baseText,
					selected,
					"HEAD",
					listId,
					{ context: 3, timeout: 500, maxEditLength: 20_000 },
				);
				if (rendered === undefined)
					throw fail("GIT_STAGING_LIMIT", "The display diff exceeded its computation budget");
				diff = rendered;
			} else
				diff = `${units[0].kind} change: ${file.basePath === file.path ? file.path : `${file.basePath} → ${file.path}`}\n`;
			const response: GitStagingDiff = {
				path: file.path,
				diff: "",
				truncated: false,
				units,
				generation: state.generation,
				observationId: state.observation_id,
				snapshotVersion: version(store, listId),
			};
			const envelopeBytes = Buffer.byteLength(JSON.stringify(response));
			if (envelopeBytes > LIMITS.maxPageBytes - 128)
				throw fail(
					"GIT_STAGING_LIMIT",
					"The complete change-unit selection exceeds the response budget",
				);
			const bytes = Buffer.from(diff);
			let budget = Math.min(bytes.length, LIMITS.maxDiffBytes);
			for (let attempt = 0; attempt < 8; attempt++) {
				response.diff = new TextDecoder().decode(bytes.subarray(0, budget), { stream: true });
				response.truncated = budget < bytes.length;
				const size = Buffer.byteLength(JSON.stringify(response));
				if (size <= LIMITS.maxPageBytes) break;
				budget = Math.max(0, budget - (size - LIMITS.maxPageBytes) - 16);
			}
			if (Buffer.byteLength(JSON.stringify(response)) > LIMITS.maxPageBytes)
				throw fail("GIT_STAGING_LIMIT", "Change preview exceeds its response budget");
			if (!response.truncated && file.ownership && selected !== undefined) {
				const mappings = projectGitStagingUnitDiff({
					ownership: file.ownership,
					listId,
					units,
					selectedText: selected,
					diff: response.diff,
				});
				if (mappings.length) {
					response.unitMappings = mappings;
					// Metadata never reduces the existing text preview or exceeds its envelope.
					if (Buffer.byteLength(JSON.stringify(response)) > LIMITS.maxPageBytes)
						delete response.unitMappings;
				}
			}
			store.assertVersion(state.generation, state.observation_id);
			return response;
		} finally {
			store.close();
		}
	}
	async actionPaths(action: GitStagingKernelAction): Promise<string[]> {
		const repo = await this.repo;
		if (action.action === "init" || action.action === "sync") {
			const store = await ChangelistStore.open(repo);
			try {
				return await changelistObservationPaths(repo, store ?? undefined, this.signal);
			} finally {
				store?.close();
			}
		}
		const store = await this.store();
		try {
			if (!("expectedGeneration" in action)) throw invalid("Invalid action");
			store.assertVersion(action.expectedGeneration, action.observationId);
			if (action.action === "activate")
				return await changelistObservationPaths(repo, store, this.signal);
			if (action.action === "move")
				return [
					...new Set(
						selectUnits(store, action).flatMap((u) =>
							u.old_path ? [u.path, u.old_path] : [u.path],
						),
					),
				];
			if (action.action === "recover") {
				validId(action.operationId);
				const operation = store.db
					.query("SELECT observation_id FROM commit_operations WHERE id=?")
					.get(action.operationId) as { observation_id: string } | null;
				if (!operation) throw fail("GIT_STAGING_NOT_FOUND", "Recovery operation does not exist");
				return [
					...new Set([
						...store.fileIds(operation.observation_id).flatMap((f) => [f.path, f.base_path]),
						...(await changelistObservationPaths(repo, store, this.signal)),
					]),
				];
			}
			if (action.action === "delete" || action.action === "commit") {
				requireList(store, action.listId);
				const rows = store.db
					.query("SELECT path,old_path FROM v_changes WHERE list_id=? LIMIT ?")
					.all(action.listId, LIMITS.maxUnitsPerOperation + 1) as {
					path: string;
					old_path: string | null;
				}[];
				if (rows.length > LIMITS.maxUnitsPerOperation)
					throw fail(
						"GIT_STAGING_LIMIT",
						"The complete group exceeds the authorization unit budget",
					);
				return [
					...new Set([
						...rows.flatMap((u) => (u.old_path ? [u.path, u.old_path] : [u.path])),
						...(action.action === "commit"
							? await changelistObservationPaths(repo, store, this.signal)
							: []),
					]),
				];
			}
			return [];
		} finally {
			store.close();
		}
	}
	async action(action: GitStagingKernelAction): Promise<GitStagingActionResult> {
		this.signal?.throwIfAborted();
		const repo = await this.repo;
		const store = await this.store(action.action === "init");
		try {
			if (action.action === "init" || action.action === "sync") {
				await observeChangelists(repo, store, this.signal, undefined, action.authorizedPaths);
				return actionResult(
					store,
					(
						store.db.query("SELECT id FROM change_lists WHERE archived=0").all() as { id: string }[]
					).map((l) => l.id),
				);
			}
			if (!("expectedGeneration" in action)) throw invalid("Invalid action");
			let state = store.assertVersion(action.expectedGeneration, action.observationId);
			if (action.action === "recover")
				return await recoverChangelistCommit(
					repo,
					store,
					action.operationId,
					this.signal,
					action.authorizedPaths,
				);
			if (action.action === "commit") {
				requireList(store, action.listId);
				return await commitChangelist(repo, store, action, this.signal, action.authorizedPaths);
			}
			if (action.action === "activate") {
				requireList(store, action.listId);
				await observeChangelists(repo, store, this.signal, undefined, action.authorizedPaths);
				state = store.state();
				await store.mutate(
					state.generation,
					state.observation_id,
					() => {
						store.db
							.query("UPDATE workspace_state SET active_list_id=? WHERE id=1")
							.run(action.listId);
					},
					this.signal,
				);
				return actionResult(store, [state.active_list_id, action.listId], action.listId);
			}
			if (action.action === "create") {
				const name = validName(action.name),
					id = validId(action.listId ?? randomUUID());
				if (id === GIT_STAGING_UNASSIGNED_LIST_ID)
					throw invalid("The changelist identity is reserved for automatic classification");
				await store.mutate(
					state.generation,
					state.observation_id,
					() => {
						const count = (
							store.db.query("SELECT COUNT(*) n FROM change_lists WHERE archived=0").get() as {
								n: number;
							}
						).n;
						if (count >= LIMITS.maxSummaryLists)
							throw fail("GIT_STAGING_LIMIT", "Too many changelists");
						store.db
							.query("INSERT INTO change_lists(id,name,created_at) VALUES(?,?,?)")
							.run(id, name, Date.now());
					},
					this.signal,
				);
				return actionResult(store, [id], id);
			}
			if (action.action === "rename") {
				requireList(store, action.listId);
				const name = validName(action.name);
				await store.mutate(
					state.generation,
					state.observation_id,
					() => {
						store.db.query("UPDATE change_lists SET name=? WHERE id=?").run(name, action.listId);
					},
					this.signal,
				);
				return actionResult(store, [action.listId], action.listId);
			}
			if (action.action === "delete" && action.listId === state.active_list_id)
				throw fail("GIT_STAGING_ACTIVE_LIST", "The active changelist cannot be deleted");
			if (action.action !== "delete" && action.action !== "move")
				throw invalid("Invalid move action");
			const moving =
				action.action === "delete"
					? {
							action: "move" as const,
							fromListId: action.listId,
							toListId: state.active_list_id,
							all: true as const,
							expectedGeneration: state.generation,
							observationId: state.observation_id as string,
						}
					: action;
			const selected = selectUnits(store, moving);
			const authorized = action.authorizedPaths ? new Set(action.authorizedPaths) : undefined;
			for (const unit of selected) {
				if (
					authorized &&
					(!authorized.has(unit.path) || (unit.old_path && !authorized.has(unit.old_path)))
				)
					throw fail("GIT_STAGING_FORBIDDEN", "Selected paths changed after authorization");
				await checkPathParents(repo, unit.path);
				if (unit.old_path) await checkPathParents(repo, unit.old_path);
			}
			if (action.action === "move" && moving.fromListId === moving.toListId) {
				store.assertState(state);
				if (store.pending())
					throw fail("GIT_STAGING_RECOVERY_REQUIRED", "A commit requires recovery");
				if (state.state !== "ready" || !store.completeObservation(state))
					throw fail(
						"GIT_STAGING_STALE_VERSION",
						"Sync a complete observation before moving changes",
					);
				return actionResult(store, [], moving.toListId);
			}
			const legacyFiles = await store.legacyReviewFileIds(state.observation_id, {
				signal: this.signal,
			});
			store.assertState(state);
			if (legacyFiles.size)
				throw fail("GIT_STAGING_STALE_VERSION", "Sync legacy ownership before moving changes");
			const ids = new Set(selected.map((u) => u.unit_id));
			if (!selected.length && action.action === "move")
				return actionResult(store, [], moving.toListId);
			const draft = await store.draft(state.head_oid, state.head_tree as string);
			const changedFileIds = [...new Set(selected.map((u) => u.file_id))];
			await store.copyFiles(draft, state.observation_id as string, changedFileIds);
			for (const fileId of changedFileIds) {
				let file = store.loadFile(fileId) as StoredFile;
				if (file.units.some((u) => ids.has(u.id))) {
					file = {
						...file,
						versionId: randomUUID(),
						units: file.units.map((u) =>
							ids.has(u.id)
								? { ...u, listId: moving.toListId, needsReview: false, reviewReason: undefined }
								: u,
						),
					};
					if (file.ownership) {
						const units = file.ownership.units.filter((u) => ids.has(u.id)).map((u) => u.id);
						file.ownership = moveTextUnits(file.ownership, {
							unitIds: units,
							targetGroupId: moving.toListId,
						});
						file.ownership = normalizeTextOwnership(file.ownership);
						const structural = file.units.filter((u) => u.kind !== "text");
						file.units = [
							...ownershipUnits(file.ownership, file.path, file.basePath),
							...structural,
						];
					}
				}
				file.units = file.units.map((unit) => {
					const { reviewReason: _reason, ...rest } = unit;
					return { ...rest, needsReview: false };
				});
				await store.putFile(draft, file);
			}
			await store.transaction(() => {
				store.assertVersion(state.generation, state.observation_id);
				if (store.pending())
					throw fail("GIT_STAGING_RECOVERY_REQUIRED", "A commit requires recovery");
				store.db.query("UPDATE observations SET complete=1 WHERE id=?").run(draft);
				store.db
					.query("UPDATE workspace_state SET observation_id=?,generation=generation+1 WHERE id=1")
					.run(draft);
				if (action.action === "delete") {
					store.db.query("UPDATE change_lists SET archived=1 WHERE id=?").run(action.listId);
				}
			}, this.signal);
			await store.collect().catch(() => {});
			return actionResult(store, [moving.fromListId, moving.toListId], moving.toListId);
		} finally {
			store.close();
		}
	}
}
