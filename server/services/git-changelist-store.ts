import { Database, constants as sqliteConstants } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
	GIT_STAGING_LIMITS,
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingState,
	type GitStagingUnit,
} from "../../shared/git-staging-lists";
import { normalizeTextOwnership, type TextOwnershipSnapshot } from "./git-changelist-ownership";
import { GitStagingKernelError } from "./git-staging-process";

export const CHANGELIST_APPLICATION_ID = 0x4e46434c;
export const CHANGELIST_SCHEMA_VERSION = 1;
/** Lineage JSON has a separate bound from normalized file content. */
export const CHANGELIST_SNAPSHOT_LIMITS = Object.freeze({
	maxFileBytes: 2 * 1024 * 1024,
	maxContentBytes: 64 * 1024 * 1024,
	maxOwnershipFileBytes: 64 * 1024 * 1024,
	maxOwnershipBytes: 256 * 1024 * 1024,
});
export interface LegacyOwnershipScanOptions {
	signal?: AbortSignal;
	checkpoint?: () => void;
	deadline?: number;
}
interface LegacyOwnershipCacheEntry {
	legacy: boolean;
	bytes: number;
}
// Cache only complete immutable-version decisions, never snapshot bodies.
const legacyOwnershipCache = new Map<string, LegacyOwnershipCacheEntry>();
let legacyOwnershipCacheBytes = 0;
function cacheLegacyOwnership(key: string, legacy: boolean) {
	const existing = legacyOwnershipCache.get(key);
	if (existing) {
		legacyOwnershipCacheBytes -= existing.bytes;
		legacyOwnershipCache.delete(key);
	}
	const entry = { legacy, bytes: Buffer.byteLength(key) + 16 };
	if (entry.bytes > 256 * 1024) return;
	legacyOwnershipCache.set(key, entry);
	legacyOwnershipCacheBytes += entry.bytes;
	while (legacyOwnershipCache.size > 1024 || legacyOwnershipCacheBytes > 256 * 1024) {
		const oldest = legacyOwnershipCache.entries().next().value;
		if (!oldest) break;
		legacyOwnershipCache.delete(oldest[0]);
		legacyOwnershipCacheBytes -= oldest[1].bytes;
	}
}
export interface ChangelistRepository {
	root: string;
	gitDir: string;
	directory: string;
	index: string;
	key: string;
}
export interface StoredFile {
	versionId: string;
	fileId: string;
	path: string;
	basePath: string;
	baseMode: string;
	workMode: string;
	baseOid: string | null;
	workOid: string | null;
	baseBytes: Buffer;
	workBytes: Buffer;
	identity: string;
	ownership: TextOwnershipSnapshot | null;
	units: GitStagingUnit[];
}
export interface StoredFileMetadata {
	file_id: string;
	path: string;
	base_path: string;
	version_id: string;
	identity: string;
	base_oid: string | null;
	work_oid: string | null;
	base_mode: string;
	work_mode: string;
	base_size: number;
	work_size: number;
	ownership_size: number;
	has_ownership: number;
}
export interface WorkspaceState {
	generation: number;
	observation_id: string | null;
	active_list_id: string;
	head_oid: string | null;
	head_tree: string | null;
	scanned_at: number | null;
	state: GitStagingState;
	reason: string | null;
}
export interface CommitOperation {
	id: string;
	list_id: string;
	expected_generation: number;
	observation_id: string;
	head_oid: string | null;
	head_tree: string;
	expected_tree: string | null;
	commit_oid: string | null;
	status: string;
	evidence_json: string;
	created_at: number;
	fence_token: string;
}
type FileRow = (string | number | Buffer | null)[];
interface PreparedFile {
	file: StoredFile;
	snapshot: FileRow;
	units: FileRow[];
	lines: FileRow[];
	bytes: number;
	records: number;
}
const fail = (code: string, message: string) => new GitStagingKernelError(code, message);
const schema = `
CREATE TABLE change_lists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
CREATE TABLE observations(id TEXT PRIMARY KEY,head_oid TEXT,head_tree TEXT NOT NULL,created_at INTEGER NOT NULL,complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,observation_id TEXT REFERENCES observations(id),active_list_id TEXT NOT NULL REFERENCES change_lists(id),head_oid TEXT,head_tree TEXT,scanned_at INTEGER,state TEXT NOT NULL,reason TEXT);
CREATE TABLE file_snapshots(version_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,path TEXT NOT NULL,base_path TEXT NOT NULL,base_mode TEXT NOT NULL,work_mode TEXT NOT NULL,base_oid TEXT,work_oid TEXT,base_bytes BLOB NOT NULL,work_bytes BLOB NOT NULL,identity TEXT NOT NULL,ownership_json TEXT);
CREATE TABLE observation_files(observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,file_id TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES file_snapshots(version_id),PRIMARY KEY(observation_id,file_id));
CREATE INDEX observation_files_version ON observation_files(version_id);
CREATE TABLE change_units(version_id TEXT NOT NULL REFERENCES file_snapshots(version_id) ON DELETE CASCADE,id TEXT NOT NULL,file_id TEXT NOT NULL,path TEXT NOT NULL,old_path TEXT,kind TEXT NOT NULL,list_id TEXT NOT NULL REFERENCES change_lists(id),base_start INTEGER NOT NULL,base_end INTEGER NOT NULL,work_start INTEGER NOT NULL,work_end INTEGER NOT NULL,added INTEGER NOT NULL,removed INTEGER NOT NULL,needs_review INTEGER NOT NULL,review_reason TEXT,content_hash TEXT NOT NULL,PRIMARY KEY(version_id,id));
CREATE INDEX change_units_owner_path ON change_units(list_id,path);
CREATE TABLE tracking_lines(version_id TEXT NOT NULL REFERENCES file_snapshots(version_id) ON DELETE CASCADE,side TEXT NOT NULL,position INTEGER NOT NULL,line_id TEXT NOT NULL,base_line_id TEXT,unit_id TEXT,line_text TEXT,PRIMARY KEY(version_id,side,position));
CREATE TABLE commit_operations(id TEXT PRIMARY KEY,list_id TEXT NOT NULL,expected_generation INTEGER NOT NULL,observation_id TEXT NOT NULL,head_oid TEXT,head_tree TEXT NOT NULL,expected_tree TEXT,commit_oid TEXT,status TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,fence_token TEXT NOT NULL);
CREATE UNIQUE INDEX one_pending_commit ON commit_operations((1)) WHERE status NOT IN ('finished','rejected');
CREATE VIEW v_workspace_state AS SELECT generation,observation_id,active_list_id,head_oid,head_tree,scanned_at,state,reason FROM workspace_state WHERE id=1;
CREATE VIEW v_changes AS SELECT w.generation,w.observation_id,f.file_id,f.path,CASE WHEN f.base_path<>f.path THEN f.base_path END old_path,u.id unit_id,u.kind,u.list_id,l.name list_name,u.base_start,u.base_end,u.work_start,u.work_end,u.added,u.removed,u.needs_review,u.review_reason FROM workspace_state w JOIN observation_files m ON m.observation_id=w.observation_id JOIN file_snapshots f ON f.version_id=m.version_id JOIN change_units u ON u.version_id=f.version_id JOIN change_lists l ON l.id=u.list_id WHERE w.id=1;
CREATE VIEW v_changelists AS SELECT l.id,l.name,l.id=w.active_list_id active,w.generation,w.observation_id,COUNT(DISTINCT c.file_id) file_count,COUNT(c.unit_id) unit_count,COALESCE(SUM(c.added),0) added,COALESCE(SUM(c.removed),0) removed,COALESCE(SUM(c.needs_review),0) needs_review_count FROM change_lists l CROSS JOIN workspace_state w LEFT JOIN v_changes c ON c.list_id=l.id WHERE w.id=1 AND l.archived=0 GROUP BY l.id;
`;

export class ChangelistStore {
	private constructor(
		public db: Database,
		readonly path: string,
		private writable: boolean,
		private readonly databaseIdentity: string,
	) {}
	private ensureWritable() {
		if (this.writable) return;
		this.db.close();
		this.db = new Database(
			this.path,
			sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
		);
		this.writable = true;
		this.db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 1);
		this.db.exec(
			"PRAGMA busy_timeout=20; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL",
		);
	}
	static async open(repo: ChangelistRepository, create = false): Promise<ChangelistStore | null> {
		for (const directory of [join(repo.gitDir, "narrafork"), repo.directory]) {
			let info = await lstat(directory).catch((e) => {
				if (e.code === "ENOENT") return null;
				throw e;
			});
			if (!info && create) {
				await mkdir(directory, { mode: 0o700 }).catch((e) => {
					if (e.code !== "EEXIST") throw e;
				});
				info = await lstat(directory);
			}
			if (!info) return null;
			if (!info.isDirectory() || info.isSymbolicLink())
				throw fail("GIT_STAGING_STORAGE_UNSAFE", "Changelist storage must be a real directory");
		}
		const path = join(repo.directory, "changelists.sqlite");
		let info = await lstat(path).catch((e) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
		let fresh = false;
		if (!info) {
			if (!create) return null;
			try {
				const handle = await open(
					path,
					constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				await handle.close();
				fresh = true;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
			info = await lstat(path);
		}
		if (!info.isFile() || info.isSymbolicLink())
			throw fail("GIT_STAGING_STORAGE_UNSAFE", "Invalid changelist database path");
		for (const suffix of ["-wal", "-shm"]) {
			const side = await lstat(path + suffix).catch((e) => {
				if (e.code === "ENOENT") return null;
				throw e;
			});
			if (side && (!side.isFile() || side.isSymbolicLink()))
				throw fail("GIT_STAGING_STORAGE_UNSAFE", "Invalid SQLite sidecar path");
		}
		let db: Database | undefined;
		let writable = fresh || info.size === 0;
		try {
			db = new Database(
				path,
				(writable ? sqliteConstants.SQLITE_OPEN_READWRITE : sqliteConstants.SQLITE_OPEN_READONLY) |
					sqliteConstants.SQLITE_OPEN_NOFOLLOW,
			);
			db.exec("PRAGMA busy_timeout=20; PRAGMA foreign_keys=ON");
			const application = (db.query("PRAGMA application_id").get() as { application_id: number })
				.application_id;
			const version = (db.query("PRAGMA user_version").get() as { user_version: number })
				.user_version;
			const blank = fresh || (info.size === 0 && application === 0 && version === 0);
			const initializing = application === CHANGELIST_APPLICATION_ID && version === 0;
			if (blank || initializing) {
				if (!create)
					throw fail(
						"GIT_STAGING_INITIALIZATION_INCOMPLETE",
						"Run changelist init to finish database initialization",
					);
				if (!writable) {
					db.close();
					db = new Database(
						path,
						sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
					);
					writable = true;
					db.exec("PRAGMA busy_timeout=20;PRAGMA foreign_keys=ON");
				}
				db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 1);
				if (blank) db.exec(`PRAGMA application_id=${CHANGELIST_APPLICATION_ID}`);
				db.exec("BEGIN IMMEDIATE");
				try {
					const liveVersion = (db.query("PRAGMA user_version").get() as { user_version: number })
						.user_version;
					if (liveVersion === CHANGELIST_SCHEMA_VERSION) {
						db.exec("COMMIT");
						db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL");
						return new ChangelistStore(db, path, writable, `${info.dev}:${info.ino}`);
					}
					if (
						liveVersion !== 0 ||
						db.query("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()
					)
						throw fail(
							"GIT_STAGING_UNSUPPORTED_FORMAT",
							"The incomplete changelist database has an unsupported schema",
						);
					db.exec(schema);
					db.exec(
						`PRAGMA application_id=${CHANGELIST_APPLICATION_ID};PRAGMA user_version=${CHANGELIST_SCHEMA_VERSION}`,
					);
					const id = randomUUID();
					db.query("INSERT INTO change_lists(id,name,created_at) VALUES(?,?,?)").run(
						id,
						"Changes",
						Date.now(),
					);
					db.query(
						"INSERT INTO workspace_state VALUES(1,0,NULL,?,NULL,NULL,NULL,'uninitialized',NULL)",
					).run(id);
					db.exec("COMMIT");
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			} else if (application !== CHANGELIST_APPLICATION_ID || version !== CHANGELIST_SCHEMA_VERSION)
				throw fail(
					"GIT_STAGING_UNSUPPORTED_FORMAT",
					`Unsupported changelist SQLite format (${application}/${version})`,
				);
			if (writable) {
				db.fileControl(sqliteConstants.SQLITE_FCNTL_PERSIST_WAL, 1);
				db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL");
			} else db.exec("PRAGMA query_only=ON");
			return new ChangelistStore(db, path, writable, `${info.dev}:${info.ino}`);
		} catch (e) {
			db?.close();
			if (e instanceof GitStagingKernelError) throw e;
			throw fail(
				"GIT_STAGING_STORAGE_INVALID",
				`Cannot open changelist database: ${(e as Error).message}`,
			);
		}
	}
	close() {
		this.db.close();
	}
	state() {
		return this.db.query("SELECT * FROM v_workspace_state").get() as WorkspaceState;
	}
	completeObservation(expected: WorkspaceState) {
		return !!this.db
			.query(
				"SELECT 1 FROM observations WHERE id=? AND complete=1 AND head_oid IS ? AND head_tree IS ?",
			)
			.get(expected.observation_id, expected.head_oid, expected.head_tree);
	}
	assertState(expected: WorkspaceState) {
		const current = this.assertVersion(expected.generation, expected.observation_id);
		if (
			current.state !== expected.state ||
			current.reason !== expected.reason ||
			current.head_oid !== expected.head_oid ||
			current.head_tree !== expected.head_tree ||
			current.active_list_id !== expected.active_list_id ||
			current.scanned_at !== expected.scanned_at
		)
			throw fail("GIT_STAGING_STALE_VERSION", "The observation state changed while scanning");
		return current;
	}
	reuse(expected: WorkspaceState) {
		const current = this.assertState(expected);
		if (
			current.state !== "ready" ||
			current.head_oid !== expected.head_oid ||
			current.head_tree !== expected.head_tree
		)
			throw fail(
				"GIT_STAGING_STALE_VERSION",
				"The observation freshness changed while reusing a snapshot",
			);
		return current;
	}
	assertVersion(generation: number, observationId: string | null) {
		const state = this.state();
		if (state.generation !== generation || state.observation_id !== observationId)
			throw fail(
				"GIT_STAGING_STALE_VERSION",
				"The changelist observation changed; reload before editing",
			);
		return state;
	}
	assertOperationFence(operationId: string, token: string) {
		const operation = this.db
			.query("SELECT * FROM commit_operations WHERE id=?")
			.get(operationId) as CommitOperation | null;
		if (!token || !operation || operation.fence_token !== token)
			throw fail(
				"GIT_STAGING_FENCED",
				`Operation ${operationId} is owned by another producer; recover the existing operation rather than committing again`,
			);
		return operation;
	}
	pending() {
		return this.db
			.query("SELECT * FROM commit_operations WHERE status NOT IN ('finished','rejected') LIMIT 1")
			.get() as CommitOperation | null;
	}
	async transaction<T>(fn: () => T, signal?: AbortSignal, checkpoint?: () => void): Promise<T> {
		this.ensureWritable();
		const deadline = Date.now() + 2_000;
		let delay = 5;
		for (;;) {
			signal?.throwIfAborted();
			checkpoint?.();
			try {
				this.db.exec("BEGIN IMMEDIATE");
				try {
					const value = fn();
					this.db.exec("COMMIT");
					return value;
				} catch (e) {
					this.db.exec("ROLLBACK");
					throw e;
				}
			} catch (e) {
				if (
					!/SQLITE_BUSY|database is locked/.test((e as Error).message) ||
					Date.now() + delay > deadline
				)
					throw e;
				await new Promise((resolve) => setTimeout(resolve, delay));
				delay = Math.min(80, delay * 2);
			}
		}
	}
	async mutate<T>(
		generation: number,
		observationId: string | null,
		fn: () => T,
		signal?: AbortSignal,
	) {
		return this.transaction(() => {
			this.assertVersion(generation, observationId);
			if (this.pending())
				throw fail(
					"GIT_STAGING_RECOVERY_REQUIRED",
					"Finish the pending changelist commit before writing",
				);
			const value = fn();
			this.db.query("UPDATE workspace_state SET generation=generation+1 WHERE id=1").run();
			return value;
		}, signal);
	}
	async mark(
		state: GitStagingState,
		reason: string,
		fence?: { operationId: string; fenceToken: string },
		expected?: WorkspaceState,
	) {
		const current = this.state();
		if (!expected && current.state === state && current.reason === reason) return current;
		return this.transaction(() => {
			if (expected) {
				try {
					this.assertState(expected);
				} catch (error) {
					if (error instanceof GitStagingKernelError && error.code === "GIT_STAGING_STALE_VERSION")
						return null;
					throw error;
				}
			}
			if (fence) {
				const operation = this.db
					.query("SELECT fence_token,status FROM commit_operations WHERE id=?")
					.get(fence.operationId) as { fence_token: string; status: string } | null;
				if (operation?.fence_token !== fence.fenceToken || operation.status === "finished") return;
			}
			this.db
				.query(
					"UPDATE workspace_state SET state=?,reason=? WHERE id=1 AND (state<>? OR reason IS NOT ?)",
				)
				.run(state, reason, state, reason);
			return this.state();
		});
	}
	fileIds(observationId = this.state().observation_id): StoredFileMetadata[] {
		if (!observationId) return [];
		const count = this.db
			.query(
				"SELECT COUNT(*) n FROM (SELECT 1 FROM observation_files WHERE observation_id=? LIMIT ?)",
			)
			.get(observationId, GIT_STAGING_LIMITS.maxRowsPerList + 1) as { n: number };
		if (count.n > GIT_STAGING_LIMITS.maxRowsPerList)
			throw fail("GIT_STAGING_LIMIT", "Too many snapshot files");
		const files = this.db
			.query(
				"SELECT m.file_id,f.path,f.base_path,f.version_id,f.identity,f.base_oid,f.work_oid,f.base_mode,f.work_mode,length(f.base_bytes) base_size,length(f.work_bytes) work_size,coalesce(octet_length(f.ownership_json),0) ownership_size,f.ownership_json IS NOT NULL has_ownership FROM observation_files m LEFT JOIN file_snapshots f ON f.version_id=m.version_id WHERE m.observation_id=? ORDER BY f.path LIMIT 5001",
			)
			.all(observationId) as StoredFileMetadata[];
		for (const file of files) {
			if (
				typeof file.path !== "string" ||
				typeof file.version_id !== "string" ||
				!Number.isSafeInteger(file.base_size) ||
				file.base_size < 0 ||
				!Number.isSafeInteger(file.work_size) ||
				file.work_size < 0 ||
				!Number.isSafeInteger(file.ownership_size) ||
				file.ownership_size < 0
			)
				throw fail("GIT_STAGING_STORAGE_CORRUPT", "Missing or invalid file snapshot metadata");
		}
		return files;
	}
	async legacyReviewFileIds(
		observationId = this.state().observation_id,
		options: LegacyOwnershipScanOptions = {},
	): Promise<Set<string>> {
		if (Number.isNaN(options.deadline))
			throw fail("GIT_STAGING_INVALID", "Invalid ownership detection deadline");
		const deadline = Math.min(
			options.deadline ?? Number.POSITIVE_INFINITY,
			Date.now() + GIT_STAGING_LIMITS.readTimeoutMs,
		);
		const check = () => {
			options.signal?.throwIfAborted();
			options.checkpoint?.();
			if (Date.now() > deadline)
				throw fail("GIT_STAGING_TIMEOUT", "Ownership detection exceeded its deadline");
		};
		const pause = async () => {
			check();
			await new Promise<void>((resolve) => setImmediate(resolve));
			check();
		};
		check();
		const result = new Set<string>();
		if (!observationId) return result;
		const files = this.fileIds(observationId);
		if (files.length > GIT_STAGING_LIMITS.maxRowsPerList)
			throw fail("GIT_STAGING_LIMIT", "Too many ownership files");
		let contentBytes = 0,
			ownershipBytes = 0;
		for (const file of files) {
			check();
			contentBytes += file.base_size + file.work_size;
			ownershipBytes += file.ownership_size;
			if (
				!Number.isSafeInteger(file.ownership_size) ||
				file.ownership_size < 0 ||
				file.base_size > CHANGELIST_SNAPSHOT_LIMITS.maxFileBytes ||
				file.work_size > CHANGELIST_SNAPSHOT_LIMITS.maxFileBytes ||
				file.ownership_size > CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipFileBytes ||
				contentBytes > CHANGELIST_SNAPSHOT_LIMITS.maxContentBytes ||
				ownershipBytes > CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipBytes
			)
				throw fail("GIT_STAGING_LIMIT", "Ownership snapshots exceed their byte budget");
		}
		const staged: [string, boolean][] = [];
		let stagedBytes = 0;
		for (const file of files) {
			check();
			const key = `${this.path}\0${this.databaseIdentity}\0${file.version_id}\0${file.file_id}\0${file.base_size}:${file.work_size}:${file.ownership_size}:${file.has_ownership}`;
			const cached = legacyOwnershipCache.get(key);
			let legacy = cached?.legacy ?? false;
			if (!cached) {
				let cursor: string | null = null;
				for (;;) {
					check();
					const rows = (
						cursor === null
							? this.db
									.query(
										"SELECT substr(id,1,257) id,octet_length(id) id_size,needs_review,review_reason IS NOT NULL has_review_reason FROM change_units WHERE version_id=? ORDER BY id LIMIT 256",
									)
									.all(file.version_id)
							: this.db
									.query(
										"SELECT substr(id,1,257) id,octet_length(id) id_size,needs_review,review_reason IS NOT NULL has_review_reason FROM change_units WHERE version_id=? AND id>? ORDER BY id LIMIT 256",
									)
									.all(file.version_id, cursor)
					) as { id: string; id_size: number; needs_review: number; has_review_reason: number }[];
					for (const row of rows) {
						if (row.id_size > 256)
							throw fail("GIT_STAGING_LIMIT", "Ownership unit identity exceeds its byte budget");
						if (
							typeof row.id !== "string" ||
							!row.id ||
							(row.needs_review !== 0 && row.needs_review !== 1)
						)
							throw fail("GIT_STAGING_STORAGE_CORRUPT", "Invalid ownership unit metadata");
						if (row.needs_review || row.has_review_reason) legacy = true;
					}
					check();
					if (legacy || rows.length < 256) break;
					cursor = rows[rows.length - 1].id;
					await pause();
				}
				if (!legacy && file.has_ownership) {
					check();
					const row = this.db
						.query("SELECT ownership_json FROM file_snapshots WHERE version_id=?")
						.get(file.version_id) as { ownership_json: string | null } | null;
					if (
						typeof row?.ownership_json !== "string" ||
						Buffer.byteLength(row.ownership_json) !== file.ownership_size
					)
						throw fail("GIT_STAGING_STORAGE_CORRUPT", "Ownership snapshot size changed");
					check();
					// Parsing is synchronous: cap its input and check the deadline on both sides.
					const snapshot = JSON.parse(row.ownership_json) as TextOwnershipSnapshot;
					check();
					if (snapshot?.fileId !== file.file_id)
						throw fail(
							"GIT_STAGING_STORAGE_CORRUPT",
							"Ownership snapshot identity does not match its file",
						);
					legacy =
						normalizeTextOwnership(snapshot, {
							timeoutMs: Math.min(500, Math.max(0, deadline - Date.now())),
						}) !== snapshot;
					check();
				}
			}
			if (legacy) result.add(file.file_id);
			await pause();
			const bytes = Buffer.byteLength(key) + 16;
			if (staged.length < 1024 && stagedBytes + bytes <= 256 * 1024) {
				staged.push([key, legacy]);
				stagedBytes += bytes;
			}
		}
		check();
		for (const [key, legacy] of staged) cacheLegacyOwnership(key, legacy);
		return result;
	}
	loadFile(fileId: string, observationId = this.state().observation_id): StoredFile | null {
		if (!observationId) return null;
		const row = this.db
			.query(
				"SELECT f.* FROM observation_files m JOIN file_snapshots f ON f.version_id=m.version_id WHERE m.observation_id=? AND m.file_id=?",
			)
			.get(observationId, fileId) as Record<string, unknown> | null;
		if (!row) return null;
		const units = this.db
			.query("SELECT * FROM change_units WHERE version_id=? ORDER BY base_start,work_start,id")
			.all(row.version_id as string) as Record<string, unknown>[];
		return {
			versionId: row.version_id as string,
			fileId: row.file_id as string,
			path: row.path as string,
			basePath: row.base_path as string,
			baseMode: row.base_mode as string,
			workMode: row.work_mode as string,
			baseOid: row.base_oid as string | null,
			workOid: row.work_oid as string | null,
			baseBytes: Buffer.from(row.base_bytes as Uint8Array),
			workBytes: Buffer.from(row.work_bytes as Uint8Array),
			identity: row.identity as string,
			ownership: row.ownership_json ? JSON.parse(row.ownership_json as string) : null,
			units: units.map((u) => ({
				id: u.id as string,
				fileId: u.file_id as string,
				path: u.path as string,
				...(u.old_path ? { oldPath: u.old_path as string } : {}),
				kind: u.kind as GitStagingUnit["kind"],
				listId: u.list_id as string,
				baseStart: u.base_start as number,
				baseEnd: u.base_end as number,
				workStart: u.work_start as number,
				workEnd: u.work_end as number,
				added: u.added as number,
				removed: u.removed as number,
				needsReview: !!u.needs_review,
				...(u.review_reason ? { reviewReason: u.review_reason as string } : {}),
			})),
		};
	}
	private unassignedList() {
		const list = this.db
			.query("SELECT name,created_at,archived FROM change_lists WHERE id=?")
			.get(GIT_STAGING_UNASSIGNED_LIST_ID) as {
			name: string;
			created_at: number;
			archived: number;
		} | null;
		if (
			list &&
			(typeof list.name !== "string" ||
				!list.name.trim() ||
				[...list.name].length > GIT_STAGING_LIMITS.maxNameChars ||
				[...list.name].some((character) => {
					const code = character.codePointAt(0) ?? 0;
					return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
				}) ||
				!Number.isSafeInteger(list.created_at) ||
				(list.archived !== 0 && list.archived !== 1) ||
				(list.archived === 1 && this.state().active_list_id === GIT_STAGING_UNASSIGNED_LIST_ID))
		)
			throw fail("GIT_STAGING_STORAGE_CORRUPT", "Invalid reserved changelist record");
		return list;
	}
	async draft(headOid: string | null, headTree: string, options: { unassigned?: boolean } = {}) {
		const id = randomUUID();
		await this.transaction(() => {
			if (options.unassigned && !this.unassignedList())
				this.db
					.query("INSERT INTO change_lists(id,name,created_at,archived) VALUES(?,?,?,1)")
					.run(GIT_STAGING_UNASSIGNED_LIST_ID, GIT_STAGING_UNASSIGNED_LIST_NAME, Date.now());
			this.db
				.query("INSERT INTO observations VALUES(?,?,?,?,0)")
				.run(id, headOid, headTree, Date.now());
		});
		return id;
	}
	async copyFiles(
		observationId: string,
		sourceObservationId: string,
		exceptFileIds: readonly string[],
	) {
		return this.transaction(() => {
			const exclusion = exceptFileIds.length
				? ` AND file_id NOT IN (${exceptFileIds.map(() => "?").join(",")})`
				: "";
			return this.db
				.query(
					`INSERT INTO observation_files(observation_id,file_id,version_id) SELECT ?,file_id,version_id FROM observation_files WHERE observation_id=?${exclusion}`,
				)
				.run(observationId, sourceObservationId, ...exceptFileIds).changes;
		});
	}
	private prepareFile(file: StoredFile): PreparedFile {
		const ownershipJson = file.ownership ? JSON.stringify(file.ownership) : null;
		const textUnits = new Map(
			file.ownership?.units.map((u) => [u.id, u.insertedLines.join("")]) ?? [],
		);
		const hashes = new Map(
			file.units.map((u) => [
				u.id,
				createHash("sha256")
					.update(
						u.kind === "text"
							? (textUnits.get(u.id) ?? "")
							: u.kind === "rename"
								? `${file.basePath}\0${file.path}`
								: u.kind === "mode"
									? `${file.baseMode}:${file.workMode}`
									: u.kind === "create" || u.kind === "delete"
										? u.kind
										: file.workBytes,
					)
					.digest("hex"),
			]),
		);
		const snapshot: FileRow = [
			file.versionId,
			file.fileId,
			file.path,
			file.basePath,
			file.baseMode,
			file.workMode,
			file.baseOid,
			file.workOid,
			file.baseBytes,
			file.workBytes,
			file.identity,
			ownershipJson,
		];
		const units: FileRow[] = file.units.map((u) => [
			file.versionId,
			u.id,
			u.fileId,
			u.path,
			u.oldPath ?? null,
			u.kind,
			u.listId,
			u.baseStart,
			u.baseEnd,
			u.workStart,
			u.workEnd,
			u.added,
			u.removed,
			+u.needsReview,
			u.reviewReason ?? null,
			hashes.get(u.id) as string,
		]);
		const lines: FileRow[] = [];
		if (file.ownership) {
			file.ownership.baseLineIds.forEach((id, i) => {
				lines.push([file.versionId, "base", i, id, id, null, null]);
			});
			file.ownership.workLines.forEach((line, i) => {
				lines.push([file.versionId, "work", i, line.id, line.baseLineId, line.unitId, line.text]);
			});
		}
		// Include every SQL-bound value, including repeated identities and tracking text.
		let bytes = 0;
		for (const row of [snapshot, ...units, ...lines, [file.fileId, file.versionId]])
			for (const value of row)
				bytes +=
					typeof value === "string"
						? Buffer.byteLength(value)
						: Buffer.isBuffer(value)
							? value.length
							: typeof value === "number"
								? 8
								: 0;
		return { file, snapshot, units, lines, bytes, records: 2 + units.length + lines.length };
	}
	private insertFile(observationId: string, prepared: PreparedFile) {
		const { file, snapshot, units, lines } = prepared;
		if (!this.db.query("SELECT 1 FROM file_snapshots WHERE version_id=?").get(file.versionId)) {
			this.db.query("INSERT INTO file_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...snapshot);
			const insert = this.db.query(
				"INSERT INTO change_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			);
			for (const row of units) insert.run(...row);
			if (lines.length) {
				const insertLine = this.db.query("INSERT INTO tracking_lines VALUES(?,?,?,?,?,?,?)");
				for (const row of lines) insertLine.run(...row);
			}
		}
		this.db
			.query("INSERT INTO observation_files VALUES(?,?,?)")
			.run(observationId, file.fileId, file.versionId);
	}
	async putFile(
		observationId: string,
		file: StoredFile,
		options: { signal?: AbortSignal; checkpoint?: () => void } = {},
	) {
		options.signal?.throwIfAborted();
		options.checkpoint?.();
		const prepared = this.prepareFile(file);
		await this.transaction(
			() => this.insertFile(observationId, prepared),
			options.signal,
			options.checkpoint,
		);
	}
	async putFiles(
		observationId: string,
		files: readonly StoredFile[],
		options: { signal?: AbortSignal; checkpoint?: () => void } = {},
	) {
		let batch: PreparedFile[] = [];
		let bytes = 0,
			records = 0;
		const check = () => {
			options.signal?.throwIfAborted();
			options.checkpoint?.();
		};
		const flush = async () => {
			if (!batch.length) return;
			check();
			await this.transaction(
				() => {
					check();
					for (const prepared of batch) this.insertFile(observationId, prepared);
				},
				options.signal,
				check,
			);
			batch = [];
			bytes = 0;
			records = 0;
			check();
		};
		for (const file of files) {
			check();
			const prepared = this.prepareFile(file);
			prepared.bytes += Buffer.byteLength(observationId);
			if (prepared.bytes > 2 * 1024 * 1024 || prepared.records > 4096) {
				await flush();
				check();
				await this.putFile(observationId, file, options);
				check();
				continue;
			}
			if (
				batch.length &&
				(bytes + prepared.bytes > 2 * 1024 * 1024 || records + prepared.records > 4096)
			)
				await flush();
			batch.push(prepared);
			bytes += prepared.bytes;
			records += prepared.records;
			if (batch.length === 16 || bytes === 2 * 1024 * 1024 || records === 4096) await flush();
		}
		await flush();
	}
	async collect() {
		await this.transaction(() => {
			this.db
				.query(
					"DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE id IS NOT (SELECT observation_id FROM workspace_state WHERE id=1) AND id NOT IN (SELECT observation_id FROM commit_operations WHERE status NOT IN ('finished','rejected')) AND (complete=1 OR created_at<?) ORDER BY created_at LIMIT 2)",
				)
				.run(Date.now() - 5 * 60_000);
			this.db
				.query(
					"DELETE FROM file_snapshots WHERE version_id IN (SELECT f.version_id FROM file_snapshots f WHERE NOT EXISTS(SELECT 1 FROM observation_files m WHERE m.version_id=f.version_id) LIMIT 8)",
				)
				.run();
			this.db
				.query(
					"DELETE FROM change_lists WHERE id IN (SELECT l.id FROM change_lists l WHERE l.archived=1 AND l.id<>? AND NOT EXISTS(SELECT 1 FROM change_units u WHERE u.list_id=l.id) LIMIT 16)",
				)
				.run(GIT_STAGING_UNASSIGNED_LIST_ID);
		});
	}
	async publish(
		observationId: string,
		expected: WorkspaceState,
		headOid: string | null,
		headTree: string,
		operationId?: string,
		operationFenceToken?: string,
	) {
		await this.transaction(() => {
			if (operationId) {
				this.assertOperationFence(operationId, operationFenceToken ?? "");
				this.assertVersion(expected.generation, expected.observation_id);
			} else this.assertState(expected);
			const pending = this.pending();
			if (pending && pending.id !== operationId)
				throw fail(
					"GIT_STAGING_RECOVERY_REQUIRED",
					"Pending commit prevents observation publication",
				);
			if (
				this.db
					.query(
						"SELECT 1 FROM observation_files m JOIN change_units u ON u.version_id=m.version_id WHERE m.observation_id=? AND u.list_id=? LIMIT 1",
					)
					.get(observationId, GIT_STAGING_UNASSIGNED_LIST_ID)
			) {
				const list = this.unassignedList();
				if (!list) throw fail("GIT_STAGING_STORAGE_CORRUPT", "Missing reserved changelist record");
				if (list.archived === 1) {
					const count = this.db
						.query("SELECT COUNT(*) n FROM change_lists WHERE archived=0")
						.get() as { n: number };
					if (count.n >= GIT_STAGING_LIMITS.maxSummaryLists)
						throw fail("GIT_STAGING_LIMIT", "Too many changelists");
					this.db
						.query("UPDATE change_lists SET archived=0 WHERE id=? AND archived=1")
						.run(GIT_STAGING_UNASSIGNED_LIST_ID);
				}
			}
			this.db.query("UPDATE observations SET complete=1 WHERE id=?").run(observationId);
			this.db
				.query(
					"UPDATE workspace_state SET observation_id=?,generation=generation+1,head_oid=?,head_tree=?,scanned_at=?,state='ready',reason=NULL WHERE id=1",
				)
				.run(observationId, headOid, headTree, Date.now());
			if (operationId)
				this.db.query("UPDATE commit_operations SET status='finished' WHERE id=?").run(operationId);
		});
		await this.collect().catch(() => {});
	}
}
