import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import {
	emptyPhysicalAuditSummary,
	type FileChangeAuditIdentity,
	type FileChangePhysicalAuditProgress,
	type FileChangePhysicalAuditRequest,
	type FileChangePhysicalAuditSnapshot,
	finishPhysicalAuditSummary,
	FILE_CHANGE_PHYSICAL_AUDIT_LIMITS as LIMITS,
} from "./file-change-physical-audit";

const DIGEST = /^[a-f0-9]{64}$/;
const SHARD = /^[a-f0-9]{2}$/;
const TEMP = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const BLOB_COLUMNS = `CASE WHEN typeof(digest) = 'text' AND length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest,
 CASE WHEN typeof(size_bytes) = 'integer' THEN size_bytes END AS sizeBytes,
 CASE WHEN status IN ('ready','staging','missing','expired') THEN status END AS status,
 CASE WHEN typeof(gc_generation) = 'integer' THEN gc_generation END AS generation,
 CASE WHEN length(CAST(storage_key AS BLOB)) = 74 AND length(CAST(digest AS BLOB)) = 64
 THEN storage_key = 'sha256/' || substr(digest,1,2) || '/' || digest ELSE 0 END AS keyValid`;
interface BlobRow {
	digest: string | null;
	sizeBytes: number | null;
	status: string | null;
	generation: number | null;
	keyValid: number;
}
interface Pin {
	handle: FileHandle;
	info: BigIntStats;
	parent?: Pin;
	name?: string;
}
class Stop extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** Only this worker opens SQLite or walks disk. All content reads are through pinned
 * Linux directory FDs + O_NOFOLLOW/O_NONBLOCK; unknown directories are never descended.
 * /proc/self/fd links here are to descriptors WE opened, not untrusted symlinks.
 * Directory handles bound memory independently of corpus size; only 256 shard identities
 * are retained. SQLite and filesystem reads do not constitute an atomic snapshot.
 * No logger dumps arguments/errors/SQL/paths. Finally closes every owned handle before
 * posting the result. Forced worker exit is a last-resort read-only cancellation boundary. */
class Audit {
	private readonly summary = emptyPhysicalAuditSummary();
	private readonly started = performance.now();
	private readonly handles = new Set<FileHandle>();
	private readonly directories = new Set<Dir>();
	private readonly ancestors: Pin[] = [];
	private readonly shardStart: (BigIntStats | null)[] = [];
	private db?: Database;
	private root?: Pin;
	private algorithm?: Pin;
	private temporary?: Pin;
	private source?: Pin;
	private lastProgress = -Infinity;
	private sampleBytes = 0;
	private upperDigest: string | null = null;
	private incomplete = false;
	private stopReason: "cancelled" | "deadline" | undefined;

	constructor(private readonly request: FileChangePhysicalAuditRequest) {}
	cancel(code: string): void {
		this.stopReason = code === "cancelled" ? "cancelled" : "deadline";
	}
	private get budget() {
		return this.request.budget;
	}
	private get description() {
		return this.request.description;
	}
	private get metrics() {
		return this.summary.metrics;
	}
	private check(): void {
		if (this.stopReason) throw new Stop(this.stopReason);
		if (performance.now() - this.started >= this.budget.durationMs) throw new Stop("deadline");
	}
	private item(): void {
		this.check();
		if (this.metrics.visitedItems >= this.budget.items) throw new Stop("item_limit");
		this.metrics.visitedItems++;
	}
	private issue(code: string): void {
		this.incomplete = true;
		if (!this.summary.issues.includes(code)) this.summary.issues.push(code);
	}
	private mismatch(
		code: string,
		key?: string,
		expectedBytes?: number,
		observedBytes?: number,
	): void {
		this.metrics.mismatches++;
		const sample = {
			code,
			...(key ? { key } : {}),
			...(expectedBytes !== undefined ? { expectedBytes } : {}),
			...(observedBytes !== undefined ? { observedBytes } : {}),
		};
		const bytes = Buffer.byteLength(JSON.stringify(sample)) + 1;
		if (
			this.summary.samples.length >= this.budget.samples ||
			this.sampleBytes + bytes > this.budget.summaryBytes - FILE_CHANGE_LIMITS.metadataBytes
		) {
			this.summary.samplesTruncated = true;
			this.issue("sample_limit");
		} else {
			this.summary.samples.push(sample);
			this.sampleBytes += bytes;
		}
	}
	private progress(phase: FileChangePhysicalAuditProgress["phase"]): void {
		const now = performance.now();
		if (now - this.lastProgress < LIMITS.progressIntervalMs) return;
		this.lastProgress = now;
		const value: FileChangePhysicalAuditProgress = {
			phase,
			catalogRows: this.metrics.catalogRows,
			physicalObjects: this.metrics.physicalObjects,
			readBytes: this.metrics.readBytes,
			visitedItems: this.metrics.visitedItems,
			durationMs: Math.ceil(now - this.started),
		};
		const message = JSON.stringify({ type: "progress", value });
		if (Buffer.byteLength(message) <= LIMITS.progressBytes) process.send?.(message);
	}
	private rows<T>(sql: string, bindings: SQLQueryBindings[] = []): T[] {
		this.check();
		if (!this.db) throw new Stop("database_not_open");
		this.metrics.queries++;
		try {
			const rows = this.db.query<T, SQLQueryBindings[]>(sql).all(...bindings);
			this.check();
			return rows;
		} catch (error) {
			if (error instanceof Stop) throw error;
			throw new Stop(
				errorCode(error) === "SQLITE_BUSY" || errorCode(error) === "SQLITE_LOCKED"
					? "sqlite_busy"
					: "sqlite_read_failed",
			);
		}
	}
	private async info(path: string): Promise<BigIntStats | null> {
		this.check();
		try {
			return await lstat(path, { bigint: true });
		} catch (error) {
			if (errorCode(error) === "ENOENT") return null;
			throw error;
		}
	}
	private async close(pin: Pin): Promise<void> {
		await pin.handle.close();
		this.handles.delete(pin.handle);
	}
	private async pin(
		path: string,
		directory: boolean,
		parent?: Pin,
		name?: string,
	): Promise<Pin | null> {
		const before = await this.info(path);
		if (!before) return null;
		if (directory ? !before.isDirectory() : !before.isFile()) throw new Stop("unsafe_object_type");
		const handle = await open(
			path,
			constants.O_RDONLY |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK |
				(directory ? constants.O_DIRECTORY : 0),
		);
		this.handles.add(handle);
		try {
			const info = await handle.stat({ bigint: true });
			if (!stable(before, info)) throw new Stop("object_changed");
			if (directory ? !info.isDirectory() : !info.isFile()) throw new Stop("unsafe_object_type");
			return { handle, info, parent, name };
		} catch (error) {
			await handle.close();
			this.handles.delete(handle);
			throw error;
		}
	}
	private async absoluteDirectory(path: string): Promise<Pin> {
		const parts = path.split("/").filter(Boolean);
		if (parts.length > this.budget.directoryDepth) throw new Stop("depth_limit");
		let pin = await this.pin("/", true);
		if (!pin) throw new Stop("source_missing");
		this.ancestors.push(pin);
		for (const name of parts) {
			const next = await this.pin(child(pin, name), true, pin, name);
			if (!next) throw new Stop("directory_missing");
			pin = next;
			this.ancestors.push(pin);
		}
		return pin;
	}
	private privateObject(info: BigIntStats, directory: boolean): void {
		if (
			info.uid !== BigInt(this.description.rootIdentity.uid) ||
			Number(info.uid) !== process.getuid?.()
		)
			throw new Stop("owner_mismatch");
		if ((info.mode & 0o7077n) !== 0n) throw new Stop("non_private_mode");
		if (directory ? !info.isDirectory() : !info.isFile()) throw new Stop("unsafe_object_type");
		if (!directory && info.nlink !== 1n) throw new Stop("link_count_unsafe");
	}
	private async privateDirectory(parent: Pin, name: string): Promise<Pin | undefined> {
		const info = await this.info(child(parent, name));
		if (!info) return undefined;
		this.privateObject(info, true);
		const pin = await this.pin(child(parent, name), true, parent, name);
		if (!pin || !stable(info, pin.info)) throw new Stop("directory_changed");
		this.privateObject(pin.info, true);
		return pin;
	}
	private async verifyPin(pin: Pin, times = true): Promise<BigIntStats> {
		const info = await pin.handle.stat({ bigint: true });
		const pathInfo =
			pin.parent && pin.name ? await this.info(child(pin.parent, pin.name)) : await this.info("/");
		if (!pathInfo || !sameObject(pin.info, info) || !sameObject(info, pathInfo))
			throw new Stop("path_replaced");
		if (times && (!stable(pin.info, info) || !stable(info, pathInfo)))
			this.issue("concurrent_object_change");
		return info;
	}

	async run(): Promise<void> {
		try {
			this.check();
			if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
				throw new Stop("unsupported_platform");
			this.root = await this.absoluteDirectory(this.description.blobRoot);
			this.privateObject(this.root.info, true);
			if (!matches(this.root.info, this.description.rootIdentity))
				throw new Stop("root_identity_mismatch");
			const sourceParent = await this.absoluteDirectory(dirname(this.description.databasePath));
			const sourceName = basename(this.description.databasePath);
			const sourceInfo = await this.info(child(sourceParent, sourceName));
			if (!sourceInfo) throw new Stop("database_missing");
			if (
				!sourceInfo.isFile() ||
				sourceInfo.nlink !== 1n ||
				Number(sourceInfo.uid) !== process.getuid?.()
			)
				throw new Stop("unsafe_database_source");
			this.source =
				(await this.pin(child(sourceParent, sourceName), false, sourceParent, sourceName)) ??
				undefined;
			if (!this.source || !matches(this.source.info, this.description.sourceIdentity))
				throw new Stop("source_identity_mismatch");
			// A read-only SQLite connection can otherwise create WAL sidecars. Do not open a
			// WAL source without its EXISTING regular private sidecars; no hot-journal recovery.
			const header = Buffer.alloc(100);
			await this.source.handle.read(header, 0, 100, 0);
			if (header.subarray(0, 16).toString() !== "SQLite format 3\0")
				throw new Stop("invalid_database_header");
			for (const suffix of ["-wal", "-shm", "-journal"]) {
				const sidecar = await this.info(child(sourceParent, sourceName + suffix));
				if (sidecar) this.privateObject(sidecar, false);
				if (suffix === "-journal" && sidecar) throw new Stop("sqlite_journal_present");
				if (header[18] === 2 && suffix !== "-journal" && !sidecar)
					throw new Stop("wal_sidecars_required");
			}
			this.db = new Database(this.description.databasePath, {
				readonly: true,
				create: false, // Bun's fileMustExist equivalent; never SQLITE_OPEN_CREATE.
				strict: true,
			});
			await this.verifyPin(this.source);
			const timeout = this.rows<{ timeout: number }>("PRAGMA busy_timeout")[0]?.timeout;
			if (!safeInteger(timeout) || timeout > 250) throw new Stop("sqlite_busy_timeout_unsupported");
			this.validateSchema();
			this.summary.start = await this.snapshot();
			this.fence(this.summary.start);
			this.algorithm = await this.privateDirectory(this.root, "sha256");
			this.temporary = await this.privateDirectory(this.root, ".tmp");
			for (let n = 0; n < 256; n++)
				this.shardStart.push(
					this.algorithm ? await this.info(child(this.algorithm, shard(n))) : null,
				);
			await this.reservations();
			await this.catalog();
			await this.physical();
		} catch (error) {
			this.issue(fault(error));
		} finally {
			try {
				if (this.db && this.root && this.source) {
					this.summary.end = await this.snapshot();
					this.fence(this.summary.end);
					if (
						this.summary.start &&
						JSON.stringify(this.summary.start) !== JSON.stringify(this.summary.end)
					)
						this.issue("scan_changed");
				}
				for (const pin of this.ancestors) await this.verifyPin(pin, pin === this.root);
				if (this.algorithm) {
					await this.verifyPin(this.algorithm);
					for (let n = 0; n < this.shardStart.length; n++) {
						if (
							!nullableStable(this.shardStart[n], await this.info(child(this.algorithm, shard(n))))
						)
							this.issue("shard_changed");
					}
				}
				if (this.temporary) await this.verifyPin(this.temporary);
			} catch (error) {
				this.issue(fault(error));
			}
			for (const directory of this.directories) {
				try {
					await directory.close();
				} catch {
					this.issue("directory_close_failed");
				}
			}
			for (const handle of this.handles) {
				try {
					await handle.close();
				} catch {
					this.issue("handle_close_failed");
				}
			}
			try {
				this.db?.close();
			} catch {
				this.issue("database_close_failed");
			}
			this.summary.full =
				!this.incomplete &&
				this.summary.catalogComplete &&
				this.summary.physicalComplete &&
				this.summary.reservationsComplete;
			this.summary.status = this.summary.full
				? "observed"
				: this.summary.start
					? "partial"
					: "unknown";
			this.metrics.durationMs = Math.ceil(performance.now() - this.started);
			const result = finishPhysicalAuditSummary(this.summary, this.budget.summaryBytes);
			process.send?.(JSON.stringify({ type: "summary", value: result }));
			process.disconnect?.();
		}
	}

	private validateSchema(): void {
		for (const table of [
			"file_change_blobs",
			"file_change_storage_budgets",
			"file_change_blob_reservations",
		]) {
			const row = this.rows<{ type: string; ordinary: number }>(
				"SELECT type, sql LIKE 'CREATE TABLE%' AS ordinary FROM main.sqlite_schema WHERE name = ? LIMIT 1",
				[table],
			)[0];
			if (row?.type !== "table" || row.ordinary !== 1) throw new Stop("unsupported_schema");
		}
		for (const [table, name, expected, unique] of [
			["file_change_blobs", "idx_fc_blob_digest", ["digest"], 1],
			[
				"file_change_blob_reservations",
				"idx_fc_reservation_budget",
				["budget_id", "status", "created_at", "id"],
				0,
			],
		] as const) {
			const indexes = this.rows<{ name: string; partial: number; isUnique: number }>(
				"SELECT substr(name,1,128) AS name, partial, \"unique\" AS isUnique FROM pragma_index_list(?, 'main') LIMIT 65",
				[table],
			);
			const index = indexes.find((row) => row.name === name);
			if (indexes.length > 64 || !index || index.partial || index.isUnique !== unique)
				throw new Stop("unsupported_index");
			const columns = this.rows<{ name: string; coll: string; key: number }>(
				"SELECT substr(name,1,64) AS name, substr(coll,1,16) AS coll, key FROM pragma_index_xinfo(?, 'main') LIMIT 6",
				[name],
			);
			if (
				columns.length !== expected.length + 1 ||
				expected.some((name, i) => columns[i]?.name !== name || columns[i]?.coll !== "BINARY")
			)
				throw new Stop("unsupported_index");
		}
	}
	private async snapshot(): Promise<FileChangePhysicalAuditSnapshot> {
		const schemaVersion = this.rows<{ schema_version: number }>("PRAGMA main.schema_version")[0]
			?.schema_version;
		const dataVersion = this.rows<{ data_version: number }>("PRAGMA main.data_version")[0]
			?.data_version;
		const rows = this.rows<{
			id: string;
			namespaceKey: string;
			generation: number;
			status: FileChangePhysicalAuditSnapshot["namespaceStatus"];
			usedBytes: number;
			reservedBytes: number;
			quotaBytes: number;
		}>(
			`SELECT CASE WHEN length(CAST(id AS BLOB)) <= 256 THEN id END AS id,
			 CASE WHEN length(CAST(namespace_key AS BLOB)) <= 256 THEN namespace_key END AS namespaceKey,
			 CASE WHEN typeof(generation) = 'integer' THEN generation END AS generation,
			 CASE WHEN status IN ('ready','unverified','reconciling') THEN status END AS status,
			 CASE WHEN typeof(used_bytes) = 'integer' THEN used_bytes END AS usedBytes,
			 CASE WHEN typeof(reserved_bytes) = 'integer' THEN reserved_bytes END AS reservedBytes,
			 CASE WHEN typeof(quota_bytes) = 'integer' THEN quota_bytes END AS quotaBytes
			 FROM main.file_change_storage_budgets ORDER BY id LIMIT 2`,
		);
		const row = rows[0];
		if (!row) throw new Stop("namespace_missing");
		if (
			rows.length !== 1 ||
			row.id !== FILE_CHANGE_BLOB_BUDGET_ID ||
			row.namespaceKey !== this.description.namespaceKey
		)
			throw new Stop("namespace_mismatch");
		if (
			!row.status ||
			![
				schemaVersion,
				dataVersion,
				row.generation,
				row.usedBytes,
				row.reservedBytes,
				row.quotaBytes,
			].every(safeInteger)
		)
			throw new Stop("invalid_namespace_metadata");
		let pending = row.reservedBytes !== 0;
		let after: string | null = null;
		for (let n = 0; n < 4; n++) {
			const found: { status: string | null } | undefined = this.rows<{ status: string | null }>(
				`SELECT CASE WHEN status IN ('reserved','reconcile_required','settled') THEN status END AS status
				 FROM main.file_change_blob_reservations INDEXED BY idx_fc_reservation_budget
				 WHERE budget_id = ?${after === null ? "" : " AND status > ?"} ORDER BY status LIMIT 1`,
				after === null ? [row.id] : [row.id, after],
			)[0];
			if (!found) break;
			if (!found.status) throw new Stop("invalid_reservation_metadata");
			if (found.status !== "settled") pending = true;
			after = found.status;
		}
		if (!this.root || !this.source) throw new Stop("identity_missing");
		return {
			schemaVersion,
			dataVersion,
			generation: row.generation,
			namespaceStatus: row.status,
			usedBytes: row.usedBytes,
			reservedBytes: row.reservedBytes,
			quotaBytes: row.quotaBytes,
			pendingReservations: pending ? "present" : "none_observed",
			source: describe(await this.verifyPin(this.source)),
			root: describe(await this.verifyPin(this.root)),
		};
	}
	private fence(snapshot: FileChangePhysicalAuditSnapshot): void {
		if (snapshot.generation !== this.description.expectedGeneration)
			throw new Stop("generation_changed");
		if (snapshot.namespaceStatus !== this.description.expectedNamespaceStatus)
			throw new Stop("namespace_status_changed");
	}
	private async reservations(): Promise<void> {
		for (const status of ["reserved", "reconcile_required"]) {
			let after: { createdAt: string; id: string } | undefined;
			for (;;) {
				const rows: { createdAt: string; id: string; size: number; generation: number }[] =
					this.rows(
						`SELECT CASE WHEN length(CAST(id AS BLOB)) BETWEEN 1 AND 256 THEN id END AS id,
					 CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt,
					 CASE WHEN typeof(expected_size) = 'integer' THEN expected_size END AS size,
					 CASE WHEN typeof(generation) = 'integer' THEN generation END AS generation
					 FROM main.file_change_blob_reservations INDEXED BY idx_fc_reservation_budget
					 WHERE budget_id = ? AND status = ?${after ? " AND (created_at,id) > (?,?)" : ""}
					 ORDER BY created_at,id LIMIT ?`,
						[
							FILE_CHANGE_BLOB_BUDGET_ID,
							status,
							...(after ? [after.createdAt, after.id] : []),
							this.budget.pageItems,
						],
					);
				for (const row of rows) {
					this.item();
					if (
						!row.id ||
						!row.createdAt ||
						!safeInteger(row.size) ||
						row.size > LIMITS.blobBytes ||
						!safeInteger(row.generation)
					)
						throw new Stop("invalid_reservation_metadata");
					this.metrics.pendingReservations++;
					this.metrics.pendingReservationBytes += row.size;
					after = row;
				}
				this.progress("reservations");
				await yieldLoop();
				if (rows.length < this.budget.pageItems) break;
			}
		}
		this.summary.reservationsComplete = true;
	}
	private validRow(
		row: BlobRow,
	): row is BlobRow & { digest: string; sizeBytes: number; generation: number; status: string } {
		return (
			!!row.digest &&
			row.digest.length === 64 &&
			DIGEST.test(row.digest) &&
			safeInteger(row.sizeBytes) &&
			row.sizeBytes <= LIMITS.blobBytes &&
			row.keyValid === 1 &&
			!!row.status &&
			safeInteger(row.generation)
		);
	}
	private async catalog(): Promise<void> {
		const upper = this.rows<{ digest: string | null }>(
			"SELECT CASE WHEN typeof(digest) = 'text' AND length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest FROM main.file_change_blobs INDEXED BY idx_fc_blob_digest ORDER BY digest DESC LIMIT 1",
		)[0];
		if (!upper) {
			this.summary.catalogComplete = true;
			return;
		}
		if (!upper.digest || upper.digest.length !== 64 || !DIGEST.test(upper.digest))
			throw new Stop("invalid_catalog_digest");
		this.upperDigest = upper.digest;
		let after: string | null = null;
		let currentShard: Pin | undefined;
		let currentPrefix: string | undefined;
		try {
			for (;;) {
				const rows: BlobRow[] = this.rows(
					`SELECT ${BLOB_COLUMNS} FROM main.file_change_blobs INDEXED BY idx_fc_blob_digest
				 WHERE digest <= ?${after === null ? "" : " AND digest > ?"} ORDER BY file_change_blobs.digest LIMIT ?`,
					[this.upperDigest, ...(after === null ? [] : [after]), this.budget.pageItems],
				);
				this.metrics.catalogPages++;
				this.metrics.maxCatalogPage = Math.max(this.metrics.maxCatalogPage, rows.length);
				for (const row of rows) {
					this.item();
					this.metrics.catalogRows++;
					if (!row.digest || row.digest.length !== 64 || !DIGEST.test(row.digest))
						throw new Stop("invalid_catalog_digest");
					after = row.digest;
					const key = objectKey(row.digest);
					if (!this.validRow(row)) {
						this.mismatch("invalid_catalog_metadata", key);
						this.issue("invalid_catalog_metadata");
						continue;
					}
					if (row.generation !== this.description.expectedGeneration)
						this.mismatch("blob_generation_unverified", key);
					const prefix = row.digest.slice(0, 2);
					if (prefix !== currentPrefix) {
						if (currentShard) {
							await this.verifyPin(currentShard);
							await this.close(currentShard);
						}
						currentShard = undefined;
						currentPrefix = prefix;
						if (this.algorithm) {
							try {
								currentShard = await this.privateDirectory(this.algorithm, prefix);
							} catch (error) {
								this.mismatch(fault(error), `sha256/${prefix}`);
								this.issue("unsafe_shard");
							}
						}
					}
					// Missing/unsafe parents are not interchangeable: unsafe parents imply unknown.
					if (!currentShard && this.algorithm && (await this.info(child(this.algorithm, prefix))))
						continue;
					const info = currentShard ? await this.info(child(currentShard, row.digest)) : null;
					if (!info) {
						this.metrics.catalogOnly++;
						this.mismatch("catalog_only_missing", key, row.sizeBytes);
					} else {
						try {
							this.privateObject(info, false);
						} catch (error) {
							this.mismatch(fault(error), key);
							this.issue("unsafe_object");
							continue;
						}
						if (info.size !== BigInt(row.sizeBytes))
							this.mismatch("size_mismatch", key, row.sizeBytes, boundedSize(info));
					}
				}
				this.progress("catalog");
				await yieldLoop();
				if (rows.length < this.budget.pageItems) break;
			}
			this.summary.catalogComplete = true;
		} finally {
			if (currentShard) await this.close(currentShard);
		}
	}

	private async entries(pin: Pin, visit: (name: string) => Promise<void>): Promise<void> {
		await this.verifyPin(pin);
		const directory = await opendir(`/proc/self/fd/${pin.handle.fd}`, { bufferSize: 1 });
		this.directories.add(directory);
		try {
			let count = 0;
			for (;;) {
				this.check();
				const entry = await directory.read();
				if (!entry) break;
				if (++count > this.budget.directoryItems) throw new Stop("directory_width_limit");
				this.item();
				// Never trust Dirent types, nor recurse based on a filename supplied by disk.
				await visit(entry.name);
				this.progress("physical");
			}
			await this.verifyPin(pin);
		} finally {
			await directory.close();
			this.directories.delete(directory);
		}
	}
	private async physical(): Promise<void> {
		if (!this.root) throw new Stop("root_missing");
		await this.entries(this.root, async (name) => {
			if (name !== "sha256" && name !== ".tmp") {
				this.mismatch("unknown_root_entry");
				this.issue("unknown_path");
			}
		});
		if (this.algorithm) {
			await this.entries(this.algorithm, async (name) => {
				if (name.length !== 2 || !SHARD.test(name)) {
					this.mismatch("unknown_shard_name", "sha256");
					this.issue("unknown_path");
				}
			});
			// Fixed shard space: streaming, no readdir()+sort() or corpus-sized set.
			for (let n = 0; n < 256; n++) {
				const prefix = shard(n);
				let pin: Pin | undefined;
				try {
					pin = await this.privateDirectory(this.algorithm, prefix);
				} catch (error) {
					this.mismatch(fault(error), `sha256/${prefix}`);
					this.issue("unsafe_shard");
					continue;
				}
				if (!nullableStable(this.shardStart[n], pin?.info ?? null)) this.issue("shard_changed");
				if (!pin) continue;
				try {
					await this.entries(pin, async (name) => {
						if (name.length !== 64 || !DIGEST.test(name) || !name.startsWith(prefix)) {
							this.mismatch("unknown_object_name", `sha256/${prefix}`);
							this.issue("unknown_path");
							return;
						}
						await this.object(pin as Pin, name);
					});
				} finally {
					await this.close(pin);
				}
			}
		}
		if (this.temporary) {
			await this.entries(this.temporary, async (name) => {
				const info = await this.info(child(this.temporary as Pin, name));
				if (!info) {
					this.issue("temporary_changed");
					return;
				}
				const known = name.length === 40 && TEMP.test(name);
				if (!known) {
					this.mismatch("unknown_temporary_name", ".tmp");
					this.issue("unknown_path");
				}
				try {
					this.privateObject(info, false);
				} catch (error) {
					this.mismatch(fault(error), ".tmp");
					this.issue("unsafe_temporary_object");
					return;
				}
				this.metrics.temporaryObjects++;
				this.metrics.temporaryBytes += boundedSize(info);
				// Metadata only, including unknown names: no open/read/hash of temporary bytes.
				const after = await this.info(child(this.temporary as Pin, name));
				if (!after || !stable(info, after)) this.issue("temporary_changed");
			});
		}
		this.summary.physicalComplete = true;
	}
	private async object(parent: Pin, digest: string): Promise<void> {
		const key = objectKey(digest);
		let pin: Pin | null = null;
		try {
			const before = await this.info(child(parent, digest));
			if (!before) {
				this.issue("object_disappeared");
				return;
			}
			this.privateObject(before, false);
			const size = boundedSize(before);
			this.metrics.physicalObjects++;
			this.metrics.physicalBytes += size;
			const row = this.rows<BlobRow>(
				`SELECT ${BLOB_COLUMNS} FROM main.file_change_blobs INDEXED BY idx_fc_blob_digest WHERE digest = ? LIMIT 1`,
				[digest],
			)[0];
			if (!row) {
				this.metrics.physicalOnly++;
				this.mismatch("physical_only", key, undefined, size);
			} else if (!this.validRow(row)) {
				this.mismatch("invalid_catalog_metadata", key);
				this.issue("invalid_catalog_metadata");
				return;
			}
			if (row?.status === "staging") this.metrics.stagingBytes += size;
			if (row?.status === "missing") this.mismatch("catalog_missing_but_present", key);
			if (row && (this.upperDigest === null || digest > this.upperDigest))
				this.issue("concurrent_publication");
			if (row && row.sizeBytes !== size)
				this.mismatch("size_mismatch", key, row.sizeBytes ?? undefined, size);
			if (size > this.budget.blobBytes) throw new Stop("blob_byte_limit");
			if (size > this.budget.readBytes - this.metrics.readBytes) throw new Stop("read_byte_limit");
			pin = await this.pin(child(parent, digest), false, parent, digest);
			if (!pin || !stable(before, pin.info)) throw new Stop("object_changed");
			this.privateObject(pin.info, false);
			const hash = createHash("sha256");
			const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(this.budget.chunkBytes, size)));
			let offset = 0;
			while (offset < size) {
				this.check();
				await this.verifyPin(parent);
				const { bytesRead } = await pin.handle.read(
					buffer,
					0,
					Math.min(buffer.byteLength, size - offset),
					offset,
				);
				this.metrics.readBytes += bytesRead;
				if (!bytesRead) throw new Stop("object_changed");
				hash.update(buffer.subarray(0, bytesRead));
				offset += bytesRead;
				this.progress("physical");
			}
			const after = await this.verifyPin(pin);
			this.privateObject(after, false);
			if (!stable(before, after)) throw new Stop("object_changed");
			if (hash.digest("hex") !== digest)
				this.mismatch("hash_mismatch", key, row?.sizeBytes ?? undefined, size);
			else {
				this.metrics.verifiedObjects++;
				this.metrics.verifiedBytes += size;
			}
		} catch (error) {
			const code = fault(error);
			if (
				["deadline", "cancelled", "blob_byte_limit", "read_byte_limit", "item_limit"].includes(code)
			)
				throw error;
			this.mismatch(code, key);
			this.issue("object_comparison_incomplete");
		} finally {
			if (pin) await this.close(pin);
		}
	}
}

function child(pin: Pin, name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
		throw new Stop("unsafe_name");
	return `/proc/self/fd/${pin.handle.fd}/${name}`;
}
function describe(info: BigIntStats): FileChangeAuditIdentity {
	return {
		dev: String(info.dev),
		ino: String(info.ino),
		birthtimeNs: String(info.birthtimeNs),
		ctimeNs: String(info.ctimeNs),
		mtimeNs: String(info.mtimeNs),
		sizeBytes: String(info.size),
		nlink: String(info.nlink),
		mode: Number(info.mode),
		uid: Number(info.uid),
	};
}
function matches(info: BigIntStats, identity: FileChangeAuditIdentity): boolean {
	const observed = describe(info);
	return (Object.keys(observed) as (keyof FileChangeAuditIdentity)[]).every(
		(key) => observed[key] === identity[key],
	);
}
function sameObject(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.birthtimeNs === b.birthtimeNs &&
		a.uid === b.uid &&
		a.mode === b.mode
	);
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
	return (
		sameObject(a, b) &&
		a.ctimeNs === b.ctimeNs &&
		a.mtimeNs === b.mtimeNs &&
		a.size === b.size &&
		a.nlink === b.nlink
	);
}
function nullableStable(a: BigIntStats | null, b: BigIntStats | null): boolean {
	return a === null || b === null ? a === b : stable(a, b);
}
function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function boundedSize(info: BigIntStats): number {
	if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER) / BigInt(LIMITS.items))
		throw new Stop("invalid_physical_size");
	return Number(info.size);
}
function shard(n: number): string {
	return n.toString(16).padStart(2, "0");
}
function objectKey(digest: string): string {
	return `sha256/${digest.slice(0, 2)}/${digest}`;
}
function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
function fault(error: unknown): string {
	if (error instanceof Stop) return error.code;
	switch (errorCode(error)) {
		case "ENOENT":
			return "object_disappeared";
		case "ELOOP":
		case "ENOTDIR":
			return "unsafe_path";
		case "EACCES":
		case "EPERM":
			return "permission_denied";
		default:
			return "io_failed";
	}
}
// Separate OS process: SQLite locks/FDs and forced termination cannot affect the
// caller's connections. Only our maintenance parent supplies this private bounded IPC.
if (process.send) {
	let audit: Audit | undefined;
	process.on("message", (message: unknown) => {
		if (typeof message !== "string" || Buffer.byteLength(message) > LIMITS.requestBytes + 64)
			return;
		const data = JSON.parse(message);
		if (data.type === "cancel") audit?.cancel(data.code);
		else if (data.type === "start" && !audit) {
			audit = new Audit(data.request as FileChangePhysicalAuditRequest);
			void audit.run();
		}
	});
}
