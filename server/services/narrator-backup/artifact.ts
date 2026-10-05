import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rename, unlink } from "node:fs/promises";
import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import type { ArchiveRow } from "../project-archive/main-store";
import {
	BACKUP_REQUIRED_COLUMNS,
	type BackupManifest,
	type BackupObject,
	type BackupState,
	type BackupTable,
	backupColumns,
	isBackupTable,
} from "./contract";
import { gitDependencies, gitOid, sha256 } from "./objects";
import { validateBackupStateClosure } from "./state";

export const MAX_ARTIFACT_BYTES = LIMITS.totalObjectBytes + LIMITS.stateBytes * 2;
export async function hashBackupFile(path: string, check: () => void): Promise<string> {
	const digest = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
		check();
		bytes += chunk.length;
		if (bytes > MAX_ARTIFACT_BYTES) throw new Error("Artifact byte budget exceeded");
		digest.update(chunk);
	}
	return digest.digest("hex");
}

/** Staged self-contained SQLite, no ZIP expansion, no host object pointers. Worker-only. */
export class NarratorBackupArtifactWriter {
	private readonly db: Database;
	private closed = false;
	constructor(readonly stagingPath: string) {
		this.db = new Database(stagingPath, { create: true });
		this.db.run("PRAGMA journal_mode=DELETE");
		this.db.run("PRAGMA trusted_schema=OFF");
		this.db.run(`CREATE TABLE manifest (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
		CREATE TABLE state_rows (table_name TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(table_name,id));
		CREATE TABLE objects (key TEXT PRIMARY KEY, bytes BLOB NOT NULL);`);
	}
	putState(state: BackupState): void {
		const insert = this.db.prepare("INSERT INTO state_rows VALUES(?,?,?)");
		for (const [table, rows] of Object.entries(state.rows))
			for (const row of rows) insert.run(table, String(row.id), JSON.stringify(row));
	}
	putObject(object: BackupObject, bytes: Buffer): void {
		this.db.prepare("INSERT INTO objects VALUES(?,?)").run(object.key, bytes);
	}
	async publish(
		manifest: BackupManifest,
		target: string,
		check: () => void,
		authorize?: () => Promise<void>,
	): Promise<string> {
		const text = JSON.stringify(manifest);
		if (Buffer.byteLength(text) > LIMITS.manifestBytes)
			throw new Error("Backup manifest budget exceeded");
		this.db.prepare("INSERT INTO manifest VALUES(1,?)").run(text);
		this.close();
		await chmod(this.stagingPath, 0o600);
		const digest = await hashBackupFile(this.stagingPath, check);
		// Validate all recursive/object dependencies BEFORE publication, not only source metadata.
		readNarratorBackupArtifact(this.stagingPath, check);
		// Large hashing/object verification may outlive the source authorization.
		// Refresh after all that work, immediately before the publication boundary.
		await authorize?.();
		check();
		await rename(this.stagingPath, target);
		return digest;
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}
	async discard() {
		this.close();
		await unlink(this.stagingPath).catch(() => {});
	}
}

export interface ValidatedBackupArtifact {
	manifest: BackupManifest;
	state: BackupState;
}
/** Read-only untrusted input, bounded pages/bytes, strict v1 fields (NOT legacy intersection). */
export function readNarratorBackupArtifact(
	path: string,
	check: () => void,
): ValidatedBackupArtifact {
	const db = new Database(path, { readonly: true });
	try {
		db.run("PRAGMA trusted_schema=OFF");
		// Reject views/virtual/generated columns BEFORE selecting untrusted values. Otherwise
		// a tiny SQLite file can synthesize an enormous printf()/recursive query result.
		const definitions = db
			.prepare(
				"SELECT name,type,sql FROM sqlite_schema WHERE name IN ('manifest','state_rows','objects') LIMIT 3",
			)
			.all() as { name: string; type: string; sql: string }[];
		if (
			definitions.length !== 3 ||
			definitions.some((row) => row.type !== "table" || /CREATE\s+VIRTUAL/i.test(row.sql))
		)
			throw new Error("Backup must contain plain artifact tables");
		const expectedFields: Record<string, string[]> = {
			manifest: ["id", "json"],
			state_rows: ["table_name", "id", "json"],
			objects: ["key", "bytes"],
		};
		for (const definition of definitions) {
			const fields = db.prepare(`PRAGMA table_xinfo(${definition.name})`).all() as {
				name: string;
				hidden: number;
			}[];
			if (fields.some((field) => field.hidden !== 0))
				throw new Error("Generated artifact columns are forbidden");
			if (
				JSON.stringify(fields.map((field) => field.name)) !==
				JSON.stringify(expectedFields[definition.name])
			)
				throw new Error("Invalid artifact table fields");
		}
		const manifestRows = db.prepare("SELECT id FROM manifest LIMIT 2").all() as { id: unknown }[];
		if (manifestRows.length !== 1 || manifestRows[0]?.id !== 1)
			throw new Error("Invalid manifest row set");
		const head = db
			.prepare("SELECT length(CAST(json AS BLOB)) AS size FROM manifest WHERE id=1 LIMIT 1")
			.get() as { size: number } | null;
		if (!head || head.size > LIMITS.manifestBytes)
			throw new Error("Invalid or oversized backup manifest");
		const manifest = JSON.parse(
			(db.prepare("SELECT json FROM manifest WHERE id=1").get() as { json: string }).json,
		) as BackupManifest;
		if (
			manifest.format !== "narrafork-narrator-backup-v1" ||
			!["conversation-state-v1", "conversation-tree-v1"].includes(manifest.profile) ||
			manifest.productionDiskRestoreAllowed !== false ||
			manifest.manualActivationRequired !== true ||
			!Array.isArray(manifest.narratorIds) ||
			manifest.narratorIds.some((id) => typeof id !== "string" || !id) ||
			!manifest.columns ||
			typeof manifest.columns !== "object" ||
			Array.isArray(manifest.columns) ||
			Object.entries(manifest.columns).some(
				([table, columns]) =>
					!isBackupTable(table) ||
					!Array.isArray(columns) ||
					columns.some(
						(column) => typeof column !== "string" || !backupColumns(table).includes(column),
					),
			) ||
			!Array.isArray(manifest.projectIds) ||
			manifest.projectIds.some((id) => typeof id !== "string") ||
			!Array.isArray(manifest.objects) ||
			!Array.isArray(manifest.roots) ||
			!Array.isArray(manifest.exclusions)
		)
			throw new Error("Unsupported narrator backup format");
		if (
			typeof manifest.actorUserId !== "string" ||
			typeof manifest.sourceInstanceId !== "string" ||
			manifest.narratorIds.length > LIMITS.stateRows ||
			manifest.objects.length > LIMITS.objects
		)
			throw new Error("Invalid backup identities or object budget");
		const state: BackupState = { rows: {} };
		let total = 0;
		let count = 0;
		let after = 0;
		for (;;) {
			check();
			const page = db
				.prepare(
					"SELECT rowid AS cursor,CASE WHEN length(CAST(table_name AS BLOB))<=64 THEN table_name END AS table_name,CASE WHEN length(CAST(id AS BLOB))<=800 THEN id END AS id,length(CAST(json AS BLOB)) AS size FROM state_rows WHERE rowid>? ORDER BY rowid LIMIT 500",
				)
				.all(after) as { cursor: number; table_name: string; id: string; size: number }[];
			if (!page.length) break;
			for (const info of page) {
				check();
				total += info.size;
				if (
					!isBackupTable(info.table_name) ||
					typeof info.id !== "string" ||
					!info.id ||
					!Number.isSafeInteger(info.size) ||
					info.size < 0 ||
					info.size > LIMITS.rowBytes ||
					total > LIMITS.stateBytes ||
					++count > LIMITS.stateRows
				)
					throw new Error("Invalid backup row or state budget");
				const row = JSON.parse(
					(
						db.prepare("SELECT json FROM state_rows WHERE rowid=?").get(info.cursor) as {
							json: string;
						}
					).json,
				) as ArchiveRow;
				const columns = manifest.columns[info.table_name];
				if (
					!row ||
					typeof row !== "object" ||
					Array.isArray(row) ||
					row.id !== info.id ||
					!columns ||
					Object.keys(row).some(
						(column) =>
							!backupColumns(info.table_name as BackupTable).includes(column) ||
							!columns.includes(column),
					) ||
					Object.values(row).some(
						(value) => value !== null && !["string", "number", "boolean"].includes(typeof value),
					)
				)
					throw new Error("Invalid backup state fields");
				for (const required of BACKUP_REQUIRED_COLUMNS[info.table_name] ?? ["id"])
					if (!Object.hasOwn(row, required)) throw new Error("Required backup state field missing");
				const destination = state.rows[info.table_name] ?? [];
				destination.push(row);
				state.rows[info.table_name] = destination;
				after = info.cursor;
			}
		}
		const actualIds = (state.rows.narrators ?? []).map((row) => String(row.id)).sort();
		if (
			!actualIds.length ||
			JSON.stringify(actualIds) !== JSON.stringify([...new Set(manifest.narratorIds)].sort())
		)
			throw new Error("Narrator selection differs from manifest");
		const objects = new Map<string, BackupObject>();
		let objectTotal = 0;
		for (const object of manifest.objects) {
			check();
			objectTotal += object?.size ?? 0;
			if (
				!object ||
				typeof object.key !== "string" ||
				objects.has(object.key) ||
				!Number.isSafeInteger(object.size) ||
				object.size < 0 ||
				object.size > LIMITS.objectBytes ||
				objectTotal > LIMITS.totalObjectBytes ||
				!Array.isArray(object.dependencies) ||
				object.dependencies.some((key) => typeof key !== "string") ||
				!/^[a-f0-9]{64}$/.test(object.digest)
			)
				throw new Error("Invalid object manifest");
			const size = db
				.prepare("SELECT length(bytes) AS size,typeof(bytes) AS type FROM objects WHERE key=?")
				.get(object.key) as { size: number; type: string } | null;
			if (!size || size.type !== "blob" || size.size !== object.size)
				throw new Error("Missing backup object dependency");
			const bytes = Buffer.from(
				(
					db.prepare("SELECT bytes FROM objects WHERE key=?").get(object.key) as {
						bytes: Uint8Array;
					}
				).bytes,
			);
			if (sha256(bytes) !== object.digest) throw new Error("Backup object tampered");
			if (["git-tree", "git-commit", "git-blob"].includes(object.kind)) {
				if (
					object.key !== `git:${gitOid(object.kind.slice(4), bytes)}` ||
					JSON.stringify(gitDependencies(object.kind, bytes)) !==
						JSON.stringify(object.dependencies)
				)
					throw new Error("Git DAG dependency mismatch");
			} else if (
				!["upload", "file-blob", "worktree-journal"].includes(object.kind) ||
				object.dependencies.length
			)
				throw new Error("Unsupported object kind");
			objects.set(object.key, object);
		}
		const storedKeys = db
			.prepare(
				"SELECT CASE WHEN length(CAST(key AS BLOB))<=800 THEN key END AS key FROM objects LIMIT ?",
			)
			.all(LIMITS.objects + 1) as { key: string | null }[];
		if (
			storedKeys.length !== objects.size ||
			storedKeys.some(({ key }) => !key || !objects.has(key))
		)
			throw new Error("Undeclared backup object payload");
		for (const object of objects.values())
			for (const key of object.dependencies)
				if (!objects.has(key)) throw new Error("Missing recursive Git/blob/DAG dependency");
		for (const root of manifest.roots)
			if (!objects.has(root)) throw new Error("Missing backup root dependency");
		if (manifest.profile === "conversation-tree-v1") {
			for (const row of [
				...(state.rows.narrator_messages ?? []),
				...(state.rows.narrator_tool_calls ?? []),
			]) {
				for (const column of ["tree_hash_before", "tree_hash_after", "snapshot_commit_sha"])
					if (typeof row[column] === "string" && !objects.has(`git:${row[column]}`))
						throw new Error("Missing conversation tree/DAG bytes");
				for (const field of ["content_json", "original_content_json"]) {
					if (typeof row[field] !== "string") continue;
					const blocks = JSON.parse(row[field]);
					if (!Array.isArray(blocks)) continue;
					for (const block of blocks)
						if (
							block?.type === "image" &&
							typeof block.imageId === "string" &&
							!objects.has(`upload:${block.uploadNarratorId ?? row.narrator_id}:${block.imageId}`)
						)
							throw new Error("Missing historical upload object bytes");
				}
			}
		}
		validateBackupStateClosure(state);
		return { manifest, state };
	} finally {
		db.close();
	}
}

export function readArtifactObject(path: string, key: string): Buffer {
	const db = new Database(path, { readonly: true });
	try {
		const size = db.prepare("SELECT length(bytes) AS size FROM objects WHERE key=?").get(key) as {
			size: number;
		} | null;
		if (!size || size.size > LIMITS.objectBytes)
			throw new Error("Missing/oversized artifact object");
		return Buffer.from(
			(db.prepare("SELECT bytes FROM objects WHERE key=?").get(key) as { bytes: Uint8Array }).bytes,
		);
	} finally {
		db.close();
	}
}
