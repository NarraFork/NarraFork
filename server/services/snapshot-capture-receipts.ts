import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeUnavailableReason } from "@shared/file-change-protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { fileChangeScopes, snapshotCaptures } from "../db/schema";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { localDirectoryIdentity } from "./file-change-local-io";

/** Metadata only: no retries, workspace leases, catalog initialization or tree listings.
 * SQLite uses the application's short busy timeout (250ms), not a new long wait.
 * Async filesystem work gets a separate wall-clock bound; late work cannot publish. */
const METADATA_BUDGET_MS = 500;
const MAX_PATH_BYTES = FILE_CHANGE_LIMITS.metadataBytes;
const PATH_FLAVOR = process.platform === "win32" ? "windows" : "posix";

interface LocalCaptureScope {
	id: string;
	lexicalPath: string;
	root: string;
	rootObject: string;
	source: string;
	sourceObject: string;
	workspaceInstanceId: string;
}

export interface SnapshotCaptureAttempt {
	readonly id: string;
	readonly scope: LocalCaptureScope;
}

/** Observation-only writer. A hash is never promoted to complete evidence here.
 * No operation/tool/message refs are written, including after a hot-path timeout. */
export class SnapshotCaptureReceiptService {
	private warnedAt = -Infinity;
	private metadataInFlight = 0;
	private readonly unfinished = new WeakSet<SnapshotCaptureAttempt>();

	constructor(
		private readonly options: {
			db: typeof db;
			privateRoot: string;
			metadataBudgetMs?: number;
		},
	) {}

	async begin(worktreePath: string, deviceId: string): Promise<SnapshotCaptureAttempt | null> {
		try {
			return await this.bounded(async (signal) => {
				if (deviceId !== LOCAL_DEVICE_ID) throw new Error("unsupported_backend");
				const scope = await this.resolveScope(worktreePath, signal);
				signal.throwIfAborted();
				const id = generateId();
				this.assertConnection();
				this.options.db
					.insert(snapshotCaptures)
					.values({
						id,
						scopeId: scope.id,
						startedAt: new Date().toISOString(),
						// A process crash / failed finish leaves explicit unavailable/unknown,
						// never an implicitly successful scan waiting to be upgraded by hash.
						coverage: "unavailable",
						temporalConsistency: "unknown",
						policyVersion: 0,
						reason: "result_unknown",
					})
					.run();
				const attempt = Object.freeze({ id, scope: Object.freeze(scope) });
				this.unfinished.add(attempt);
				return attempt;
			});
		} catch {
			this.warn("begin_unavailable");
			return null;
		}
	}

	async finish(
		attempt: SnapshotCaptureAttempt | null,
		outcome: { treeHash: string } | { reason: FileChangeUnavailableReason },
	): Promise<void> {
		// An attempt gets exactly one finish opportunity, even if persistence fails.
		if (!attempt || !this.unfinished.delete(attempt)) return;
		try {
			await this.bounded(async (signal) => {
				let treeHash: string | null = null;
				let reason: FileChangeUnavailableReason =
					"reason" in outcome ? outcome.reason : "capture_incomplete";
				if ("treeHash" in outcome) {
					try {
						const current = await this.resolveScope(attempt.scope.lexicalPath, signal);
						if (JSON.stringify(current) !== JSON.stringify(attempt.scope))
							throw new Error("target_unverified");
						if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(outcome.treeHash))
							throw new Error("Invalid tree hash");
						treeHash = outcome.treeHash;
					} catch {
						reason = "target_unverified";
					}
				}
				signal.throwIfAborted();
				this.assertConnection();
				this.options.db
					.update(snapshotCaptures)
					.set({
						finishedAt: new Date().toISOString(),
						treeHash,
						coverage: treeHash ? "partial" : "unavailable",
						// Neither idle locks nor an unchanged tree measure all writers.
						temporalConsistency: "unknown",
						reason,
					})
					.where(
						and(
							eq(snapshotCaptures.id, attempt.id),
							eq(snapshotCaptures.scopeId, attempt.scope.id),
							isNull(snapshotCaptures.finishedAt),
						),
					)
					.run();
			});
		} catch {
			// Leave the durable pending record unavailable, with no hash. Do not
			// retry later and retroactively claim this boundary became usable.
			this.warn("finish_unavailable");
		}
	}

	private async resolveScope(
		worktreePath: string,
		signal: AbortSignal,
	): Promise<LocalCaptureScope> {
		if (!isAbsolute(worktreePath) || Buffer.byteLength(worktreePath) > MAX_PATH_BYTES)
			throw new Error("target_unverified");
		const root = await realpath(worktreePath);
		if (Buffer.byteLength(root) > MAX_PATH_BYTES) throw new Error("target_unverified");
		signal.throwIfAborted();
		const rootObject = await localDirectoryIdentity(root);
		signal.throwIfAborted();
		const source = await readExistingSource(this.options.privateRoot, signal);
		// Exactly the existing local runtime's length-prefixed incarnation key.
		// Never select an old/remote/imported scope merely because its path matches.
		const hash = createHash("sha256");
		for (const text of [source.id, root, rootObject])
			hash.update(`${Buffer.byteLength(text)}:`).update(text);
		const workspaceInstanceId = hash.digest("hex");
		signal.throwIfAborted();
		this.assertConnection();
		const row = this.options.db
			.select({
				id: sql<string>`substr(${fileChangeScopes.id}, 1, 257)`,
				root: sql<string>`substr(${fileChangeScopes.canonicalRoot}, 1, 8193)`,
				object: sql<string | null>`substr(${fileChangeScopes.rootIdentityJson}, 1, 1025)`,
				status: fileChangeScopes.status,
				flavor: fileChangeScopes.pathFlavor,
			})
			.from(fileChangeScopes)
			.where(
				and(
					eq(fileChangeScopes.sourceInstanceId, source.id),
					eq(fileChangeScopes.deviceId, LOCAL_DEVICE_ID),
					eq(fileChangeScopes.workspaceInstanceId, workspaceInstanceId),
				),
			)
			.limit(1)
			.get();
		if (
			!row ||
			row.id.length > 256 ||
			row.root !== root ||
			row.status !== "active" ||
			row.flavor !== PATH_FLAVOR ||
			!row.object ||
			row.object.length > 1024 ||
			JSON.parse(row.object).object !== rootObject
		)
			throw new Error("target_unverified");
		signal.throwIfAborted();
		return {
			id: row.id,
			lexicalPath: worktreePath,
			root,
			rootObject,
			source: source.id,
			sourceObject: source.object,
			workspaceInstanceId,
		};
	}

	private assertConnection(): void {
		// A JS timer cannot interrupt SQLite's synchronous busy handler. Recheck
		// after every async identity read instead of trusting startup configuration.
		if (this.options.db.$client.inTransaction)
			throw new Error("Capture receipts require independent durable statements");
		const timeout = this.options.db.get<[number]>(sql`PRAGMA busy_timeout`)?.[0];
		if (timeout === undefined || !Number.isInteger(timeout) || timeout < 0 || timeout > 250)
			throw new Error("Capture receipts require a short SQLite busy timeout");
		if (this.options.db.get<[number]>(sql`PRAGMA foreign_keys`)?.[0] !== 1)
			throw new Error("Capture receipts require foreign key enforcement");
	}

	private async bounded<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
		// A stuck OS read cannot be force-cancelled. Bound retained async work too:
		// once slots are occupied, later scans continue without queuing metadata.
		if (this.metadataInFlight >= FILE_CHANGE_LIMITS.captureQueueItems)
			throw new Error("Receipt metadata concurrency budget exceeded");
		this.metadataInFlight++;
		const controller = new AbortController();
		const pending = body(controller.signal).finally(() => {
			this.metadataInFlight--;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("Receipt metadata budget exceeded"));
					}, this.options.metadataBudgetMs ?? METADATA_BUDGET_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private warn(stage: string): void {
		if (Date.now() - this.warnedAt < 60_000) return;
		this.warnedAt = Date.now();
		logger.warn("Snapshot capture receipt unavailable; observation is not recovery evidence", {
			stage,
		});
	}
}

/** Read-only counterpart of the runtime's source publication: never creates an
 * installation or blob namespace. Validate owner-controlled ancestors and the
 * same bounded private, non-symlink source object before trusting its ID. */
async function readExistingSource(privateRoot: string, signal: AbortSignal) {
	const root = resolve(privateRoot);
	if (Buffer.byteLength(root) > MAX_PATH_BYTES || (await realpath(root)) !== root)
		throw new Error("Invalid source directory");
	const chain: Awaited<ReturnType<typeof directoryStat>>[] = [];
	for (let cursor = root; ; cursor = dirname(cursor)) {
		signal.throwIfAborted();
		if (chain.length >= 128) throw new Error("Source ancestor budget exceeded");
		const stat = await directoryStat(cursor);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid source ancestor");
		chain.push(stat);
		if (cursor === dirname(cursor)) break;
	}
	let privateAncestor = false;
	const uid = BigInt(process.geteuid?.() ?? -1);
	const boundary = createHash("sha256");
	for (const stat of chain.reverse()) {
		if (process.platform !== "win32") {
			if (stat.uid !== uid && stat.uid !== 0n) throw new Error("Untrusted source owner");
			if (!privateAncestor && (stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)
				throw new Error("Untrusted source ancestor");
			if (stat.uid === uid && (stat.mode & 0o011n) === 0n) privateAncestor = true;
		}
		boundary.update(`${stat.dev}:${stat.ino}:${stat.birthtimeNs};`);
	}
	const leaf = chain[chain.length - 1];
	if (
		process.platform !== "win32" &&
		(!leaf ||
			leaf.uid !== uid ||
			(leaf.mode & 0o002n) !== 0n ||
			(!privateAncestor && (leaf.mode & 0o020n) !== 0n))
	)
		throw new Error("Untrusted source directory");
	signal.throwIfAborted();
	const path = join(root, "file-change-source.json");
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		signal.throwIfAborted();
		const initial = await file.stat({ bigint: true });
		if (
			!initial.isFile() ||
			initial.nlink !== 1n ||
			initial.size > 512n ||
			(process.platform !== "win32" && ((initial.mode & 0o077n) !== 0n || initial.uid !== uid))
		)
			throw new Error("Invalid source object");
		const bytes = Buffer.alloc(513);
		const read = await file.read(bytes, 0, bytes.length, 0);
		if (read.bytesRead > 512) throw new Error("Source byte budget exceeded");
		const [final, entry] = await Promise.all([file.stat({ bigint: true }), directoryStat(path)]);
		for (const key of ["dev", "ino", "birthtimeNs", "size", "mtimeNs", "ctimeNs"] as const) {
			if (initial[key] !== final[key] || final[key] !== entry[key])
				throw new Error("Source changed while reading");
		}
		if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n)
			throw new Error("Source entry changed");
		signal.throwIfAborted();
		const value = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
		if (value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id))
			throw new Error("Invalid source format");
		boundary.update(`${initial.dev}:${initial.ino}:${initial.birthtimeNs}`);
		return { id: value.id as string, object: boundary.digest("hex") };
	} finally {
		// Closing a late filesystem operation is cleanup only; it cannot write a receipt.
		await file.close();
	}
}

function directoryStat(path: string) {
	return lstat(path, { bigint: true });
}

const context = new AsyncLocalStorage<SnapshotCaptureReceiptService>();
let defaultService: SnapshotCaptureReceiptService | undefined;

/** Scoped injection for actual Git/isolated-DB lifecycle tests, never a hash fixture. */
export function withSnapshotCaptureReceipts<T>(
	service: SnapshotCaptureReceiptService,
	body: () => T,
): T {
	return context.run(service, body);
}

export function snapshotCaptureReceipts(): SnapshotCaptureReceiptService {
	defaultService ??= new SnapshotCaptureReceiptService({ db, privateRoot: getNarraforkHome() });
	return context.getStore() ?? defaultService;
}
