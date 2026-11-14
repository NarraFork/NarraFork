import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Dir, Dirent } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type ProtectionSource,
	protectionSources,
	protectionTables,
	type ReceiptProjectionProgress,
	receiptProjectionPrefix,
} from "../db/resource-protection-index";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { hotSafe } from "../lib/hot-safe";
import { worktreeReceiptHasResourceEffect } from "./narrator-worktree-journal";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import type { LifecycleTarget, ResourceClaim } from "./worktree-lifecycle-guard";

const PAGE = 64;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const PENDING_RECEIPT =
	/^([a-f0-9]{64}\.json)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;
const tick = () => new Promise<void>((done) => setTimeout(done, 0));

function check(deadline: number, signal?: AbortSignal) {
	if (performance.now() > deadline || signal?.aborted)
		throw new Error("Protection index budget exceeded");
}
async function bounded<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
	try {
		check(deadline, signal);
	} catch (error) {
		void work.catch(() => {});
		throw error;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Protection index deadline")),
					Math.max(0, deadline - performance.now()),
				);
				abort = () => reject(new Error("Protection index cancelled"));
				signal?.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
	}
}

/** Same admission semantics as the lifecycle guard, including a dangling symlink leaf. */
export async function canonicalProtectionAdmissionPath(path: string): Promise<string> {
	if (!isAbsolute(path) || path.length > 4096 || path.includes("\0"))
		throw new Error("Invalid resource path");
	let current = path;
	const suffix: string[] = [];
	for (let depth = 0; depth < 64; depth++) {
		try {
			return resolve(await realpath(current), ...suffix);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const node = await lstat(current).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw cause;
			});
			if (node?.isSymbolicLink()) {
				const link = await readlink(current);
				if (Buffer.byteLength(link) > 4096) throw new Error("Symlink target exceeds budget");
				current = resolve(dirname(current), link);
				continue;
			}
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.unshift(localPathSemantics.basename(current));
			current = parent;
		}
	}
	throw new Error("Resource path ancestry exceeded budget");
}
export async function canonicalProtectionPath(path: string): Promise<string> {
	return localPathSemantics.identityKey(await canonicalProtectionAdmissionPath(path));
}

type SourceState = {
	source: ProtectionSource;
	source_id: string;
	revision: number;
};
type PathRow = {
	source: ProtectionSource;
	source_id: string;
	slot: number;
	canonical_path?: string | null;
};
type IndexedClaim = {
	claim: ResourceClaim;
	/** Immutable receipt upgrades retain the original serialized source evidence. */
	claimJson?: string;
	/** Canonical logical reference; claim.shadowKey retains the persisted physical hash input. */
	shadowKey?: string;
	canonicalPath: string | null;
	deviceId: string;
	alias: number;
};

function validText(value: unknown, max = 4096): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
	);
}
function receiptClaim(record: unknown, id: string): ResourceClaim {
	if (!record || typeof record !== "object" || Array.isArray(record))
		throw new Error("Invalid receipt");
	const row = record as Record<string, unknown>;
	if (
		Object.hasOwn(row, "__proto__") ||
		Object.hasOwn(row, "version") ||
		!validText(row.destination) ||
		!validText(row.repositoryKey) ||
		!row.repositoryKey.trim() ||
		(Object.hasOwn(row, "deviceId") &&
			(typeof row.deviceId !== "string" || !/^[-A-Za-z0-9_]{1,128}$/.test(row.deviceId)))
	)
		throw new Error("Invalid receipt");
	const deviceId = (row.deviceId as string | undefined) ?? "local";
	if (deviceId === "local" && !isAbsolute(row.destination)) throw new Error("Invalid receipt");
	treeSnapshotKey(deviceId, row.destination);
	return {
		kind: "receipt",
		id,
		deviceId,
		path: row.destination,
		repositoryKey: row.repositoryKey,
	};
}

/** Injectable handles keep custom fixtures entirely out of the production database. */
export function createResourceProtectionIndex(database: Database, receiptDirectory: string) {
	let dirtyCursor: [string, string] = ["", ""];
	let receiptEntries: Dir | undefined;
	let receiptEntry: Dirent | null | undefined;
	let receiptImport: Promise<void> | undefined;
	let receiptRetryCursor = "";
	/**
	 * Chapters were removed. Their rows in the index would otherwise stay as permanent,
	 * unmaintained claims; retire them one bounded page per maintenance pass.
	 */
	let chapterSourcePurged = false;
	function purgeRemovedChapterSource() {
		if (chapterSourcePurged) return;
		let removed = 0;
		database.transaction(() => {
			removed += database
				.query(`DELETE FROM resource_protection_paths WHERE source = 'chapter'
				AND source_id IN (SELECT source_id FROM resource_protection_paths
					WHERE source = 'chapter' LIMIT ?)`)
				.run(PAGE).changes;
			removed += database
				.query(`DELETE FROM resource_protection_sources WHERE source = 'chapter'
				AND source_id IN (SELECT source_id FROM resource_protection_sources
					WHERE source = 'chapter' LIMIT ?)`)
				.run(PAGE).changes;
		})();
		if (removed === 0) chapterSourcePurged = true;
	}
	// Project bounded scalars before crossing the SQLite/JS boundary, including malformed legacy rows.
	const smallText = (column: string, max = 4096) =>
		`CASE WHEN length(cast(${column} AS blob)) > ${max} THEN char(0) ELSE ${column} END`;
	function requireSmall(row: object | null): void {
		if (row && Object.values(row).some((value) => value === "\0"))
			throw new Error("Protection source scalar exceeds row budget");
	}
	function readRaw(source: ProtectionSource, id: string): ResourceClaim[] {
		if (!validText(id)) throw new Error("Invalid protection source key");
		if (source === "receipt") return [];
		if (source === "registry") {
			const row = database
				.query(`SELECT ${smallText("id")} AS id, ${smallText("device_id", 256)} AS deviceId,
				${smallText("worktree_path")} AS path, ${smallText("repository_key")} AS repositoryKey,
				${smallText("scope_project_id")} AS scopeProjectId, ${smallText("state", 256)} AS state
				FROM narrator_worktree_resources WHERE id = ?`)
				.get(id) as Omit<ResourceClaim, "kind"> | null;
			requireSmall(row);
			return row ? [{ kind: "registry", ...row }] : [];
		}
		const row = database
			.query(`SELECT ${smallText("id")} AS id,
			${smallText("cwd")} AS cwd, ${smallText("default_device_id", 256)} AS default_device_id, workspace_revision,
			CASE WHEN length(cast(workspace_context AS blob)) <= ${MAX_ROW_BYTES} THEN workspace_context END AS context,
			length(cast(workspace_context AS blob)) AS context_bytes FROM narrators WHERE id = ?`)
			.get(id) as {
			id: string;
			cwd: string | null;
			default_device_id: string | null;
			workspace_revision: number;
			context: string | null;
			context_bytes: number | null;
		} | null;
		if (!row) return [];
		requireSmall(row);
		if ((row.context_bytes ?? 0) > MAX_ROW_BYTES)
			throw new Error("Workspace context exceeds row budget");
		const context = row.context === null ? null : JSON.parse(row.context);
		const contextCwd = context?.cwd ?? null;
		const contextDevice = context?.deviceId ?? null;
		for (const device of [row.default_device_id, contextDevice])
			if (device !== null && !validText(device, 256))
				throw new Error("Legacy claim device is unverifiable");
		for (const path of [row.cwd, contextCwd])
			if (path !== null && !validText(path)) throw new Error("Legacy claim cwd is unverifiable");
		if (contextCwd && !contextDevice && row.default_device_id && row.default_device_id !== "local")
			throw new Error("Legacy context device is unverifiable");
		const deviceId = contextDevice ?? row.default_device_id ?? "local";
		// Modern switches commit cwd/context together. The older SwitchDevice left
		// an absolute host cwd untouched while committing a different remote context;
		// require that inconsistent pair AND matching explicit remote devices before
		// retaining its local owner. Absolute syntax alone never proves local ownership.
		const legacyHostCwd =
			row.cwd !== null &&
			isAbsolute(row.cwd) &&
			contextCwd !== null &&
			row.cwd !== contextCwd &&
			contextDevice !== null &&
			contextDevice !== "local" &&
			row.default_device_id === contextDevice;
		const rawDevice = legacyHostCwd ? "local" : deviceId;
		const base = {
			kind: "narrator" as const,
			id: row.id,
			revision: row.workspace_revision,
		};
		const claims: ResourceClaim[] = [];
		if (row.cwd)
			claims.push({
				...base,
				path: rawDevice === "local" ? localPathSemantics.resolve(process.cwd(), row.cwd) : row.cwd,
				deviceId: rawDevice,
			});
		if (contextCwd) {
			const repositoryKey = context?.git?.repositoryKey;
			if (repositoryKey != null && !validText(repositoryKey))
				throw new Error("Invalid repository key");
			claims.push({
				...base,
				deviceId,
				path:
					deviceId === "local" ? localPathSemantics.resolve(process.cwd(), contextCwd) : contextCwd,
				...(repositoryKey ? { repositoryKey } : {}),
			});
		}
		return claims;
	}

	async function indexedPath(
		claim: ResourceClaim,
		path: string | undefined,
		deviceId: string,
		deadline: number,
		signal?: AbortSignal,
	): Promise<IndexedClaim> {
		if (!validText(deviceId, 256)) throw new Error("Invalid resource device");
		if (!path) return { claim, canonicalPath: null, deviceId, alias: 0 };
		if (!validText(path)) throw new Error("Invalid resource path");
		if (deviceId !== "local") return { claim, canonicalPath: path, deviceId, alias: 0 };
		const canonicalPath = await bounded(canonicalProtectionPath(path), deadline, signal);
		const metadata = await bounded(
			lstat(path).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}),
			deadline,
			signal,
		);
		return {
			claim,
			canonicalPath,
			deviceId,
			alias:
				canonicalPath !== localPathSemantics.identityKey(path) || metadata?.isSymbolicLink()
					? 1
					: 0,
		};
	}
	async function indexed(
		claim: ResourceClaim,
		deadline: number,
		signal?: AbortSignal,
	): Promise<IndexedClaim[]> {
		if (Buffer.byteLength(JSON.stringify(claim)) > MAX_ROW_BYTES)
			throw new Error("Claim exceeds row budget");
		const { shadowKey, ...direct } = claim;
		const rows: IndexedClaim[] = [];
		if (shadowKey) {
			const parts = shadowKey.split("\0");
			const [deviceId, logicalPath] = parts;
			if (
				parts.length !== 2 ||
				!deviceId ||
				!logicalPath ||
				(deviceId === "local" && !isAbsolute(logicalPath))
			)
				throw new Error("Invalid shadow reference");
			// Snapshot identity validates remote absolute grammar without resolving it on the host.
			treeSnapshotKey(deviceId, logicalPath);
			const reference = { ...claim, path: undefined };
			const logical = await indexedPath(reference, logicalPath, deviceId, deadline, signal);
			const physical = await indexedPath(
				reference,
				treeSnapshotPhysicalDir(deviceId, logicalPath),
				deviceId,
				deadline,
				signal,
			);
			rows.push({
				...physical,
				shadowKey: treeSnapshotKey(deviceId, logical.canonicalPath ?? logicalPath),
				alias: logical.alias || physical.alias,
			});
		}
		if (claim.path || !shadowKey)
			rows.push(await indexedPath(direct, claim.path, claim.deviceId ?? "local", deadline, signal));
		return rows;
	}

	function changedSource(source: ProtectionSource) {
		database
			.query(
				"UPDATE resource_protection_sources SET revision = revision + 1 WHERE source = ? AND source_id = ''",
			)
			.run(source);
	}
	function save(
		source: ProtectionSource,
		id: string,
		revision: number,
		rows: IndexedClaim[],
	): boolean {
		return database.transaction(() => {
			const state = database
				.query(
					"SELECT revision, dirty FROM resource_protection_sources WHERE source = ? AND source_id = ?",
				)
				.get(source, id) as { revision: number; dirty: number } | null;
			if (!state || state.revision !== revision) return false;
			const old = database
				.query(
					"SELECT slot, device_id, canonical_path, shadow_key, alias_sensitive, claim_json FROM resource_protection_paths WHERE source = ? AND source_id = ? ORDER BY slot LIMIT ?",
				)
				.all(source, id, PAGE + 1) as {
				slot: number;
				device_id: string;
				canonical_path: string | null;
				shadow_key: string | null;
				alias_sensitive: number;
				claim_json: string;
			}[];
			const unchanged =
				old.length === rows.length &&
				rows.every(
					(row, i) =>
						old[i]?.slot === (row.shadowKey ? -1 : i) &&
						old[i]?.device_id === row.deviceId &&
						old[i]?.canonical_path === row.canonicalPath &&
						old[i]?.shadow_key === (row.shadowKey ?? null) &&
						old[i]?.alias_sensitive === row.alias &&
						old[i]?.claim_json === (row.claimJson ?? JSON.stringify(row.claim)),
				);
			if (!state.dirty && unchanged) return true;
			database
				.query(
					"UPDATE resource_protection_sources SET dirty = 0 WHERE source = ? AND source_id = ?",
				)
				.run(source, id);
			changedSource(source);
			if (unchanged) return true;
			database
				.query("DELETE FROM resource_protection_paths WHERE source = ? AND source_id = ?")
				.run(source, id);
			for (const [slot, row] of rows.entries())
				database
					.query(`INSERT INTO resource_protection_paths
				(source, source_id, slot, device_id, canonical_path, repository_key, shadow_key, scope_project_id, alias_sensitive, claim_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						source,
						id,
						row.shadowKey ? -1 : slot,
						row.deviceId,
						row.canonicalPath,
						row.claim.repositoryKey ?? null,
						row.shadowKey ?? null,
						row.claim.scopeProjectId ?? null,
						row.alias,
						row.claimJson ?? JSON.stringify(row.claim),
					);
			return true;
		})();
	}

	async function readReceipt(
		filePath: string,
		deadline: number,
		signal?: AbortSignal,
	): Promise<ResourceClaim | null | false> {
		check(deadline, signal);
		let file: FileHandle;
		try {
			file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			check(deadline, signal);
			const before = await file.stat();
			check(deadline, signal);
			if (!before.isFile() || before.size > MAX_RECEIPT_BYTES)
				throw new Error("Receipt exceeds row budget");
			const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			check(deadline, signal);
			const after = await file.stat();
			check(deadline, signal);
			if (
				bytesRead > MAX_RECEIPT_BYTES ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new Error("Receipt changed while reading");
			const record: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
			if (
				!record ||
				typeof record !== "object" ||
				Array.isArray(record) ||
				Object.hasOwn(record, "__proto__") ||
				Object.hasOwn(record, "version")
			)
				throw new Error("Invalid receipt");
			// An explicit no-dispatch result is durable retry metadata, not a claim.
			// Its invalid original destination need not be canonicalizable.
			if (!worktreeReceiptHasResourceEffect(record)) return false;
			return receiptClaim(record, filePath);
		} finally {
			await file.close();
		}
	}

	/** Register a durable retry before consuming the current directory entry. */
	function registerReceipt(filePath: string): number | null {
		const state = database
			.query(
				"SELECT revision, dirty FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ?",
			)
			.get(filePath) as { revision: number; dirty: number } | null;
		if (state && !state.dirty) return null;
		database
			.query(`INSERT INTO resource_protection_sources (source, source_id)
			VALUES ('receipt', ?) ON CONFLICT DO NOTHING`)
			.run(filePath);
		return state?.revision ?? 1;
	}
	/** Legacy files are imported once. Existing pins never follow later journal rewrites/deletes. */
	async function importReceipt(
		filePath: string,
		revision: number,
		deadline: number,
		signal?: AbortSignal,
	) {
		try {
			const claim = await readReceipt(filePath, deadline, signal);
			if (claim === null) throw new Error("Legacy receipt disappeared before import");
			save(
				"receipt",
				filePath,
				revision,
				claim === false ? [] : await indexed(claim, deadline, signal),
			);
		} catch {
			check(deadline, signal); // Retry bad finals after reaching EOF, without starving later files.
		}
	}
	/** Rebuild derived identities from durable pins, never from mutable journal files. */
	async function reprojectReceiptPins(
		progress: ReceiptProjectionProgress,
		initialCursor: string,
		deadline: number,
		signal?: AbortSignal,
	) {
		let expectedCursor = initialCursor;
		const advance = (state: { source_id: string; revision: number; dirty: number }) => {
			const cursor =
				receiptProjectionPrefix + JSON.stringify({ ...progress, after: state.source_id });
			const result = database
				.query(`UPDATE resource_protection_sources
				SET cursor = ?, revision = revision + 1
				WHERE source = 'receipt' AND source_id = '' AND cursor = ? AND complete = 0
				AND EXISTS (SELECT 1 FROM resource_protection_sources
					WHERE source = 'receipt' AND source_id = ? AND revision = ? AND dirty = ?)`)
				.run(cursor, expectedCursor, state.source_id, state.revision, state.dirty);
			if (result.changes !== 1) throw new Error("Receipt projection cursor or pin changed");
			expectedCursor = cursor;
		};
		const states = database
			.query(`SELECT source_id, revision, dirty FROM resource_protection_sources
			WHERE source = 'receipt' AND source_id > ? ORDER BY source_id LIMIT ?`)
			.all(progress.after, PAGE) as { source_id: string; revision: number; dirty: number }[];
		for (const state of states) {
			check(deadline, signal);
			if (state.dirty) {
				// Keep the import retry pending, but commit this skipped prefix as well.
				progress.complete = 0;
				advance(state);
				continue;
			}
			const saved = database
				.query(`SELECT ${smallText("claim_json", MAX_ROW_BYTES)} AS claim_json,
				${smallText("device_id", 256)} AS device_id, ${smallText("canonical_path")} AS canonical_path
				FROM resource_protection_paths WHERE source = 'receipt' AND source_id = ?
				ORDER BY slot LIMIT ?`)
				.all(state.source_id, PAGE + 1) as {
				claim_json: string;
				device_id: string;
				canonical_path: string | null;
			}[];
			if (saved.length > PAGE) throw new Error("Receipt projection exceeds row budget");
			const rows: IndexedClaim[] = [];
			const claims = new Map<string, ResourceClaim>();
			for (const entry of saved) {
				requireSmall(entry);
				if (claims.has(entry.claim_json)) continue;
				const claim = JSON.parse(entry.claim_json) as ResourceClaim;
				if (claim?.kind !== "receipt" || claim.id !== state.source_id)
					throw new Error("Invalid persisted receipt claim");
				claims.set(entry.claim_json, claim);
				rows.push(
					...(await indexed(claim, deadline, signal)).map((row) => ({
						...row,
						claimJson: entry.claim_json,
					})),
				);
			}
			for (const entry of saved) {
				const claim = claims.get(entry.claim_json);
				if (
					!claim?.shadowKey ||
					entry.canonical_path === null ||
					rows.some(
						(row) => row.deviceId === entry.device_id && row.canonicalPath === entry.canonical_path,
					)
				)
					continue;
				// A receipt is immutable historical evidence. Its v1 physical hash may
				// differ from the corrected logical key; retain that old footprint as a
				// direct path alongside the original shadow claim, never a second shadow slot.
				const footprint = {
					...claim,
					shadowKey: undefined,
					deviceId: entry.device_id,
					path: entry.canonical_path,
				};
				rows.push(...(await indexed(footprint, deadline, signal)));
			}
			if (!save("receipt", state.source_id, state.revision, rows))
				throw new Error("Receipt pin changed during projection");
			// Save/CAS stays per pin. A cursor failure may repeat this pin, never undo it;
			// an interrupted page must not repeat its already-committed expensive prefix.
			advance({ ...state, dirty: 0 });
		}
		check(deadline, signal);
		if (states.length < PAGE) {
			const result = database
				.query(`UPDATE resource_protection_sources
				SET cursor = ?, complete = ?, revision = revision + 1
				WHERE source = 'receipt' AND source_id = '' AND cursor = ? AND complete = 0`)
				.run(progress.cursor, progress.complete, expectedCursor);
			if (result.changes !== 1) throw new Error("Receipt projection cursor changed");
		}
	}
	async function runLegacyImport(deadline: number, signal?: AbortSignal) {
		const progress = database
			.query(
				"SELECT cursor, complete FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ''",
			)
			.get() as { cursor: string | null; complete: number } | null;
		if (!progress) throw new Error("Protection triggers not installed");
		if (progress.cursor?.startsWith(receiptProjectionPrefix)) {
			await reprojectReceiptPins(
				JSON.parse(progress.cursor.slice(receiptProjectionPrefix.length)),
				progress.cursor,
				deadline,
				signal,
			);
			return;
		}
		if (progress.complete) return;
		if (progress.cursor !== "eof") {
			if (!receiptEntries) {
				const metadata = await lstat(receiptDirectory).catch((error) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				});
				check(deadline, signal);
				if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
					throw new Error("Unsafe receipt directory");
				if (metadata) receiptEntries = await opendir(receiptDirectory);
			}
			for (let count = 0; count < PAGE; count++) {
				check(deadline, signal);
				if (receiptEntry === undefined) {
					try {
						receiptEntry = receiptEntries ? await receiptEntries.read() : null;
						check(deadline, signal);
					} catch (error) {
						const entries = receiptEntries;
						receiptEntries = undefined;
						receiptEntry = undefined;
						await entries?.close().catch(() => {});
						throw error;
					}
				}
				check(deadline, signal);
				if (!receiptEntry) {
					const entries = receiptEntries;
					receiptEntries = undefined;
					await entries?.close();
					check(deadline, signal);
					database
						.query(
							"UPDATE resource_protection_sources SET cursor = 'eof' WHERE source = 'receipt' AND source_id = ''",
						)
						.run();
					receiptEntry = undefined;
					break;
				}
				if (PENDING_RECEIPT.test(receiptEntry.name)) {
					receiptEntry = undefined;
					continue;
				}
				const filePath = join(receiptDirectory, receiptEntry.name);
				const revision = registerReceipt(filePath);
				receiptEntry = undefined;
				if (revision !== null) await importReceipt(filePath, revision, deadline, signal);
			}
			// Keep the directory handle across bounded batches; restart safely skips imported rows.
			return;
		}
		const failed = database
			.query(`SELECT source_id FROM resource_protection_sources
			WHERE dirty = 1 AND source = 'receipt' AND source_id > ? ORDER BY source_id LIMIT ?`)
			.all(receiptRetryCursor, PAGE) as { source_id: string }[];
		if (!failed.length) receiptRetryCursor = "";
		for (const row of failed) {
			check(deadline, signal);
			try {
				const revision = registerReceipt(row.source_id);
				if (revision !== null) await importReceipt(row.source_id, revision, deadline, signal);
			} finally {
				receiptRetryCursor = row.source_id;
			}
		}
		if (
			!database
				.query(
					"SELECT 1 FROM resource_protection_sources WHERE dirty = 1 AND source = 'receipt' AND source_id != '' LIMIT 1",
				)
				.get()
		)
			database
				.query(
					"UPDATE resource_protection_sources SET complete = 1, revision = revision + 1 WHERE source = 'receipt' AND source_id = '' AND complete = 0",
				)
				.run();
	}

	async function importLegacyReceipts(deadline: number, signal?: AbortSignal) {
		// A timed-out filesystem operation (including close) still owns its handles until it settles.
		// Pause only legacy import instead of reopening it or blocking the three business sources.
		if (receiptImport) return;
		const work = runLegacyImport(deadline, signal);
		receiptImport = work;
		void work
			.finally(() => {
				if (receiptImport === work) receiptImport = undefined;
			})
			.catch(() => {});
		await bounded(work, deadline, signal);
	}

	async function maintain(
		deadline = performance.now() + 1000,
		signal?: AbortSignal,
	): Promise<void> {
		check(deadline, signal);
		purgeRemovedChapterSource();
		for (const source of ["narrator", "registry"] as const) {
			check(deadline, signal);
			const progress = database
				.query(
					"SELECT cursor, complete FROM resource_protection_sources WHERE source = ? AND source_id = ''",
				)
				.get(source) as { cursor: string | null; complete: number } | null;
			if (!progress) throw new Error("Protection triggers not installed");
			if (progress.complete) continue;
			const ids = database
				.query(`SELECT id FROM ${protectionTables[source].table} WHERE id > ? ORDER BY id LIMIT ?`)
				.all(progress.cursor ?? "", PAGE) as { id: string }[];
			database.transaction(() => {
				for (const { id } of ids)
					database
						.query(`INSERT INTO resource_protection_sources (source, source_id)
					VALUES (?, ?) ON CONFLICT(source, source_id) DO UPDATE
					SET revision = revision + 1, dirty = 1`)
						.run(source, id);
				database
					.query(
						"UPDATE resource_protection_sources SET cursor = ?, complete = ?, revision = revision + 1 WHERE source = ? AND source_id = ''",
					)
					.run(ids.at(-1)?.id ?? progress.cursor, ids.length < PAGE ? 1 : 0, source);
			})();
			await tick();
		}
		const dirty = database
			.query(`SELECT source, source_id, revision FROM resource_protection_sources
			WHERE dirty = 1 AND source_id != '' AND source != 'receipt' AND (source, source_id) > (?, ?)
			ORDER BY source, source_id LIMIT ?`)
			.all(...dirtyCursor, PAGE) as SourceState[];
		if (!dirty.length) dirtyCursor = ["", ""];
		for (const state of dirty) {
			check(deadline, signal);
			try {
				save(
					state.source,
					state.source_id,
					state.revision,
					(
						await Promise.all(
							readRaw(state.source, state.source_id).map((claim) =>
								indexed(claim, deadline, signal),
							),
						)
					).flat(),
				);
			} catch {
				check(deadline, signal); /* Keep invalid facts dirty and fail closed on reads. */
			} finally {
				dirtyCursor = [state.source, state.source_id];
			}
		}
		await importLegacyReceipts(deadline, signal);
	}

	function pathQueries(
		target: LifecycleTarget,
	): { clause: string; values: SQLQueryBindings[]; pathOrder?: boolean }[] {
		const device = target.deviceId ?? "local";
		const queries: { clause: string; values: SQLQueryBindings[]; pathOrder?: boolean }[] = [];
		if (target.scopeProjectId)
			queries.push({ clause: "scope_project_id = ?", values: [target.scopeProjectId] });
		if (target.shadowKey) queries.push({ clause: "shadow_key = ?", values: [target.shadowKey] });
		if (target.repositoryKey)
			queries.push({
				clause: "device_id = ? AND repository_key = ?",
				values: [device, target.repositoryKey],
			});
		if (target.path) {
			const separator = device === "local" && process.platform === "win32" ? "\\" : "/";
			let path = target.path;
			for (let depth = 0; depth < 65; depth++) {
				queries.push({ clause: "device_id = ? AND canonical_path = ?", values: [device, path] });
				const parent = localPathSemantics.identityKey(dirname(path));
				if (parent === path) break;
				if (depth === 64) throw new Error("Target ancestry exceeds budget");
				path = parent;
			}
			const prefix = target.path.endsWith(separator) ? target.path : target.path + separator;
			queries.push({
				clause: "device_id = ? AND canonical_path >= ? AND canonical_path < ?",
				values: [
					device,
					prefix,
					prefix.slice(0, -1) + String.fromCharCode(separator.charCodeAt(0) + 1),
				],
				pathOrder: true,
			});
		}
		return queries;
	}
	function matches(targets: readonly LifecycleTarget[], row: IndexedClaim): boolean {
		return targets.some((target) => {
			if (target.scopeProjectId && target.scopeProjectId === row.claim.scopeProjectId) return true;
			if (target.shadowKey && target.shadowKey === row.shadowKey) return true;
			if ((target.deviceId ?? "local") !== row.deviceId) return false;
			if (target.repositoryKey && target.repositoryKey === row.claim.repositoryKey) return true;
			const a = target.path,
				b = row.canonicalPath;
			return !!(
				a &&
				b &&
				(row.deviceId === "local"
					? localPathSemantics.contains(a, b) || localPathSemantics.contains(b, a)
					: a === b ||
						a.startsWith(b.endsWith("/") ? b : `${b}/`) ||
						b.startsWith(a.endsWith("/") ? a : `${a}/`))
			);
		});
	}

	async function read(
		targets: readonly LifecycleTarget[],
		deadline: number,
		signal?: AbortSignal,
		includeLegacyReceipts = true,
	): Promise<{ complete: boolean; claims: AsyncIterable<ResourceClaim> }> {
		const empty = async function* () {};
		check(deadline, signal);
		const sources = includeLegacyReceipts
			? protectionSources
			: protectionSources.filter((source) => source !== "receipt");
		const sourceFilter = `source IN (${sources.map(() => "?").join(", ")})`;
		const progress = database
			.query(
				`SELECT source, complete FROM resource_protection_sources WHERE ${sourceFilter} AND source_id = ''`,
			)
			.all(...sources) as { source: ProtectionSource; complete: number }[];
		if (progress.length !== sources.length) return { complete: false, claims: empty() };
		if (progress.some((state) => state.source === "receipt" && !state.complete))
			return { complete: false, claims: empty() };
		const bootstrapOverlay: { source: Exclude<ProtectionSource, "receipt">; id: string }[] = [];
		// Small fresh databases can be proved completely in memory, without mutating bootstrap state.
		// LIMIT n+1 is a completeness proof, never a truncated inventory interpreted as empty.
		for (const state of progress) {
			if (state.complete || state.source === "receipt") continue;
			const ids = database
				.query(`SELECT id FROM ${protectionTables[state.source].table} ORDER BY id LIMIT ?`)
				.all(PAGE + 1) as { id: string }[];
			if (ids.length > PAGE) return { complete: false, claims: empty() };
			for (const { id } of ids) bootstrapOverlay.push({ source: state.source, id });
		}
		const version = () =>
			JSON.stringify(
				database
					.query(
						`SELECT source, revision FROM resource_protection_sources WHERE ${sourceFilter} AND source_id = '' ORDER BY source`,
					)
					.all(...sources),
			);
		const initialVersion = version();
		const bootstrapKeys = new Set(bootstrapOverlay.map(({ source, id }) => `${source}\0${id}`));
		const rebuildingSources = new Set(
			progress.filter((state) => !state.complete).map((state) => state.source),
		);
		function candidateClaim(row: PathRow): ResourceClaim {
			const saved = database
				.query(`SELECT ${smallText("claim_json", MAX_ROW_BYTES)} AS claim_json FROM resource_protection_paths
				WHERE source = ? AND source_id = ? AND slot = ?`)
				.get(row.source, row.source_id, row.slot) as { claim_json: string } | null;
			requireSmall(saved);
			if (!saved) throw new Error("Protection candidate disappeared");
			return JSON.parse(saved.claim_json) as ResourceClaim;
		}
		// LIMIT is applied to raw indexed candidates, never after a dirty-row anti-join.
		function skipCandidate(row: PathRow): boolean {
			if (row.source === "receipt") return !includeLegacyReceipts;
			if (rebuildingSources.has(row.source)) return true;
			return !!(
				database
					.query("SELECT dirty FROM resource_protection_sources WHERE source = ? AND source_id = ?")
					.get(row.source, row.source_id) as { dirty: number } | null
			)?.dirty;
		}
		async function* claims(): AsyncGenerator<ResourceClaim> {
			for (const { source, id } of bootstrapOverlay) {
				for (const claim of readRaw(source, id))
					for (const row of await indexed(claim, deadline, signal))
						if (matches(targets, row)) yield row.claim;
			}
			const seen = new Set<string>();
			for (const target of targets)
				for (const query of pathQueries(target)) {
					const order = query.pathOrder
						? "canonical_path, source, source_id, slot"
						: "source, source_id, slot";
					let cursor: SQLQueryBindings[] = query.pathOrder ? ["", "", "", -1] : ["", "", -1];
					const cursorParameters = query.pathOrder ? "?, ?, ?, ?" : "?, ?, ?";
					while (true) {
						check(deadline, signal);
						const rows = database
							.query(`SELECT source, source_id, slot, canonical_path FROM resource_protection_paths
						WHERE ${query.clause}
						AND (${order}) > (${cursorParameters}) ORDER BY ${order} LIMIT ?`)
							.all(...query.values, ...cursor, PAGE) as PathRow[];
						for (const row of rows) {
							if (skipCandidate(row)) continue;
							const key = `${row.source}\0${row.source_id}\0${row.slot}`;
							if (!seen.has(key)) {
								seen.add(key);
								const claim = candidateClaim(row);
								if (row.slot >= 0 && claim.shadowKey) {
									for (const projection of await indexed(claim, deadline, signal))
										if (matches(targets, projection)) yield projection.claim;
								} else yield claim;
							}
						}
						if (rows.length < PAGE) break;
						const last = rows.at(-1);
						if (!last) break;
						if (query.pathOrder && last.canonical_path == null)
							throw new Error("Unverifiable path-range cursor");
						cursor = query.pathOrder
							? [last.canonical_path ?? "", last.source, last.source_id, last.slot]
							: [last.source, last.source_id, last.slot];
						await tick();
					}
				}
			// Raw-PK overlay: never repair the database from the guard's read path.
			let cursor: [string, string] = ["", ""];
			while (true) {
				check(deadline, signal);
				const states = database
					.query(`SELECT source, source_id, revision FROM resource_protection_sources
					WHERE dirty = 1 AND source IN ('narrator', 'registry') AND source_id != '' AND (source, source_id) > (?, ?) ORDER BY source, source_id LIMIT ?`)
					.all(...cursor, PAGE) as SourceState[];
				for (const state of states) {
					if (bootstrapKeys.has(`${state.source}\0${state.source_id}`)) continue;
					for (const claim of readRaw(state.source, state.source_id))
						for (const row of await indexed(claim, deadline, signal))
							if (matches(targets, row)) yield row.claim;
				}
				if (states.length < PAGE) break;
				const last = states.at(-1);
				if (!last) break;
				cursor = [last.source, last.source_id];
				await tick();
			}
			let aliasCursor: [string, string, number] = ["", "", -1];
			while (true) {
				check(deadline, signal);
				const rows = database
					.query(`SELECT source, source_id, slot, canonical_path FROM resource_protection_paths
					WHERE alias_sensitive = 1
					AND (source, source_id, slot) > (?, ?, ?) ORDER BY source, source_id, slot LIMIT ?`)
					.all(...aliasCursor, PAGE) as PathRow[];
				for (const row of rows) {
					if (skipCandidate(row)) continue;
					const claim = candidateClaim(row);
					for (const projection of await indexed(claim, deadline, signal))
						if (matches(targets, projection)) yield projection.claim;
				}
				if (rows.length < PAGE) break;
				const last = rows.at(-1);
				if (!last) break;
				aliasCursor = [last.source, last.source_id, last.slot];
				await tick();
			}
			check(deadline, signal);
			if (version() !== initialVersion)
				throw new Error("Protection facts changed during inspection");
		}
		return { complete: true, claims: claims() };
	}

	return { read, maintain };
}

let singleton: ReturnType<typeof createResourceProtectionIndex> | undefined;
async function productionIndex() {
	if (singleton) return singleton;
	const { sqlite } = await import("../db");
	const { narraforkDir } = await import("../lib/settings");
	singleton = createResourceProtectionIndex(sqlite, join(narraforkDir, "worktree-requests"));
	return singleton;
}
let lastWarning = -Infinity;
let suppressedWarnings = 0;
async function warnUnavailable(error: unknown): Promise<void> {
	if (performance.now() - lastWarning < 60_000) {
		suppressedWarnings++;
		return;
	}
	lastWarning = performance.now();
	const { logger } = await import("../lib/logger");
	logger.warn("Resource protection evidence unavailable", {
		reason: error instanceof Error ? error.message : String(error),
		suppressedWarnings,
	});
	suppressedWarnings = 0;
}
export async function readProtectionClaims(
	targets: readonly LifecycleTarget[],
	deadline: number,
	signal?: AbortSignal,
	includeLegacyReceipts = true,
) {
	try {
		const result = await (await productionIndex()).read(
			targets,
			deadline,
			signal,
			includeLegacyReceipts,
		);
		if (!result.complete) await warnUnavailable(new Error("Protection index bootstrap incomplete"));
		return {
			complete: result.complete,
			claims: (async function* () {
				try {
					yield* result.claims;
				} catch (error) {
					await warnUnavailable(error);
					throw error;
				}
			})(),
		};
	} catch (error) {
		await warnUnavailable(error);
		throw error;
	}
}
export async function maintainProtectionIndex(
	deadline = performance.now() + 1000,
	signal?: AbortSignal,
) {
	try {
		await (await productionIndex()).maintain(deadline, signal);
	} catch (error) {
		await warnUnavailable(error);
		throw error;
	}
}
const maintenance = hotSafe("resource-protection-index-maintenance", () => ({
	timer: undefined as ReturnType<typeof setTimeout> | undefined,
}));
export function startProtectionIndexMaintenance(): void {
	if (maintenance.timer || process.env.NARRAFORK_TEST === "1") return;
	const run = async () => {
		try {
			await maintainProtectionIndex();
		} catch {
			/* Backlog or invalid evidence stays dirty; destructive reads fail closed. */
		}
		maintenance.timer = setTimeout(run, 1000);
		maintenance.timer.unref();
	};
	maintenance.timer = setTimeout(run, 0);
	maintenance.timer.unref();
}
