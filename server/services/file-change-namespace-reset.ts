import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, opendir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import { fileChangeStorageBudgets } from "../db/schema";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";

type Database = typeof applicationDb;
// One-time compatibility drain: a hot-reloaded old verifier may still own IO.
// Retire its shared scheduler before admitting the replacement reset protocol.
const legacyJobs = hotSafe(
	"narrafork.file-change-namespace-recovery.v1",
	() => new WeakMap<object, { pending?: Promise<void>; retryAfter: number }>(),
);
export async function retireLegacyNamespaceRecovery(db: object): Promise<void> {
	const state = legacyJobs.get(db) ?? { retryAfter: Number.POSITIVE_INFINITY };
	legacyJobs.set(db, state);
	state.retryAfter = Number.POSITIVE_INFINITY;
	await state.pending?.catch(() => {});
	state.retryAfter = Number.POSITIVE_INFINITY;
}
const locks = hotSafe(
	"narrafork.file-change-namespace-lock.v1",
	() => new Map<string, Promise<void>>(),
);
const held = hotSafe(
	"narrafork.file-change-namespace-context.v2",
	() => new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>(),
);

const NAMESPACE_LOCK_KEY = "local-file-change-blob-cache";

/** No consumer or mutation was admitted; callers must release workspace leases
 * before waiting and retrying. Never reinterpret this as missing blob history. */
export const FileChangeNamespaceBusyError = hotSafe(
	"narrafork.file-change-namespace-busy-error.v1",
	() =>
		class FileChangeNamespaceBusyError extends Error {
			constructor() {
				super("File-change namespace admission is busy");
				this.name = "FileChangeNamespaceBusyError";
			}
		},
);

async function waitForNamespaceTail(tail: Promise<void>, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (!signal) return tail;
	let abort: (() => void) | undefined;
	try {
		await Promise.race([
			tail,
			new Promise<never>((_, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			}),
		]);
		signal.throwIfAborted();
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

/** Lock-free admission barrier, including tails registered by retained old
 * namespace-first closures. Does not reserve a FIFO slot or block consumers. */
export async function waitForFileChangeNamespaceDrain(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (held.getStore()?.get(NAMESPACE_LOCK_KEY)?.active) return;
	for (;;) {
		const tail = locks.get(NAMESPACE_LOCK_KEY);
		if (!tail) return;
		await waitForNamespaceTail(tail, signal);
	}
}

/** Atomic no-wait admission closes the drain -> workspace grant race. A new
 * coordinator-first consumer must never wait for a legacy namespace-first one. */
export async function tryWithFileChangeNamespace<T>(
	root: string,
	body: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	if (!held.getStore()?.get(NAMESPACE_LOCK_KEY)?.active && locks.has(NAMESPACE_LOCK_KEY))
		return Promise.reject(new FileChangeNamespaceBusyError());
	// withFileChangeNamespace registers its slot synchronously, before its first await.
	return withFileChangeNamespace(root, body, signal);
}
/** Protect the entire actual blob-consumer IO/settlement lifetime against reset.
 * Acquire workspace/coordinator/history admission BEFORE this fence, never while
 * holding it. Previews release it before rollback admission and revalidate after.
 * Reentrant for initialize/verify called inside a writer or revert transaction.
 * Bash deliberately does not participate: this lock protects caches, not files. */
export async function withFileChangeNamespace<T>(
	_root: string,
	body: () => Promise<T>,
	/** Cancellation applies to admission only; a running consumer retains its fence. */
	signal?: AbortSignal,
): Promise<T> {
	// The application has exactly one catalog. Different root spellings/copies or
	// freshly opened DB handles must still fence consumers of its former root.
	const key = NAMESPACE_LOCK_KEY;
	signal?.throwIfAborted();
	if (held.getStore()?.get(key)?.active) return body();
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((done) => {
		release = done;
	});
	locks.set(key, current);
	let onAbort: (() => void) | undefined;
	try {
		if (signal) {
			await Promise.race([
				previous,
				new Promise<never>((_, reject) => {
					onAbort = () => reject(signal.reason);
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				}),
			]);
			signal.throwIfAborted();
		} else await previous;
	} catch (error) {
		// Preserve FIFO ownership: cancellation must not release the predecessor.
		void previous.finally(() => {
			release();
			if (locks.get(key) === current) locks.delete(key);
		});
		throw error;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
	const token = { active: true };
	try {
		return await held.run(new Map([...(held.getStore() ?? []), [key, token]]), body);
	} finally {
		token.active = false;
		release();
		if (locks.get(key) === current) locks.delete(key);
	}
}

/** Fixed, cache-only tables/columns. Never enumerate workspace files or messages.
 * Clear typed refs AND reverse indexes before allowing the digest to be republished.
 * Each batch is a small autocommit; the durable unverified budget prevents readers
 * seeing partially invalidated evidence after interruption or process restart. */
const EXPIRED_STATE = `'${JSON.stringify({ kind: "unknown", reason: "expired" })}'`;
const INVALIDATIONS = [
	[
		"file_change_effects",
		`before_blob_digest=NULL, intended_after_blob_digest=NULL, observed_after_blob_digest=NULL, before_state_json=${EXPIRED_STATE}, intended_after_state_json=${EXPIRED_STATE}, observed_after_state_json=${EXPIRED_STATE}`,
	],
	[
		"revert_operation_files",
		`before_blob_digest=NULL, desired_blob_digest=NULL, observed_after_blob_digest=NULL, compensation_after_blob_digest=NULL, expected_state_json=${EXPIRED_STATE}, desired_state_json=${EXPIRED_STATE}, observed_after_state_json=CASE WHEN observed_after_state_json IS NULL THEN NULL ELSE ${EXPIRED_STATE} END, compensation_after_state_json=CASE WHEN compensation_after_state_json IS NULL THEN NULL ELSE ${EXPIRED_STATE} END`,
	],
	[
		"snapshot_captures",
		"manifest_blob_digest=NULL, coverage='unavailable', reason='blob_namespace_reset'",
	],
	[
		"revert_operations",
		"selector_blob_digest=NULL, plan_blob_digest=NULL, history_manifest_blob_digest=NULL, status=CASE WHEN status IN ('planned','prepared') THEN 'expired' ELSE status END, reason='blob_namespace_reset'",
	],
] as const;

async function invalidateMetadata(db: Database): Promise<void> {
	for (const [table, assignments] of INVALIDATIONS) {
		let cursor = 0;
		for (;;) {
			const rows = db.all<{ rowid: number }>(
				sql.raw(`SELECT rowid FROM ${table} WHERE rowid > ${cursor} ORDER BY rowid LIMIT 64`),
			);
			if (!rows.length) break;
			const end = rows[rows.length - 1].rowid;
			db.run(
				sql.raw(`UPDATE ${table} SET ${assignments} WHERE rowid > ${cursor} AND rowid <= ${end}`),
			);
			cursor = end;
			await yieldToEventLoop();
		}
	}
	for (const table of ["file_change_blob_reservations", "file_change_blobs"]) {
		for (;;) {
			const rows = db.all<{ rowid: number }>(
				sql.raw(`SELECT rowid FROM ${table} ORDER BY rowid LIMIT 64`),
			);
			if (!rows.length) break;
			db.run(
				sql.raw(`DELETE FROM ${table} WHERE rowid IN (${rows.map((row) => row.rowid).join(",")})`),
			);
			await yieldToEventLoop();
		}
	}
}

/** Caller owns the namespace lock and has verified the application-data boundary.
 * Rename isolates every old object atomically. Deletion uses bounded asynchronous IO;
 * failure only leaves an isolated disposable cache, never poisons the new store. */
export async function resetFileChangeNamespace(input: {
	db: Database;
	privateRoot: string;
	assertBoundary(): Promise<void>;
}): Promise<void> {
	await input.assertBoundary();
	const budget = input.db
		.select()
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (!budget) throw new Error("Cannot reset a missing blob namespace budget");
	if (!Number.isSafeInteger(budget.generation + 1)) throw new Error("Blob generation exhausted");
	input.db
		.update(fileChangeStorageBudgets)
		.set({
			status: "unverified",
			generation: budget.generation + 1,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(fileChangeStorageBudgets.id, budget.id))
		.run();
	const root = join(input.privateRoot, "file-change-blobs");
	const retired = join(input.privateRoot, `file-change-blobs.retired-${randomUUID()}`);
	try {
		await rename(root, retired);
		scheduleRetiredCleanup(retired);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await input.assertBoundary();
	await mkdir(root, { mode: 0o700 });
	await invalidateMetadata(input.db);
}

const cleanupQueue = hotSafe("narrafork.file-change-cache-cleanup.v1", () => ({
	running: false,
	paths: [] as string[],
}));
function scheduleRetiredCleanup(path: string): void {
	// Backpressure: do not accumulate unbounded tasks if a disk is slow. A skipped
	// directory is already isolated and may be removed by storage maintenance.
	if (cleanupQueue.paths.length >= 8) return;
	cleanupQueue.paths.push(path);
	if (cleanupQueue.running) return;
	cleanupQueue.running = true;
	void (async () => {
		try {
			for (;;) {
				const next = cleanupQueue.paths.shift();
				if (!next) return;
				try {
					let remaining = 20_000;
					const deadline = performance.now() + 30_000;
					const remove = async (directory: string, depth: number): Promise<void> => {
						if (depth > 64) throw new Error("Retired cache exceeds cleanup depth budget");
						const entries = await opendir(directory, { bufferSize: 32 });
						for await (const entry of entries) {
							if (--remaining < 0 || performance.now() > deadline)
								throw new Error("Retired cache cleanup budget exhausted");
							const child = join(directory, entry.name);
							if (entry.isDirectory()) await remove(child, depth + 1);
							else await unlink(child); // Never follow symbolic links out of the cache.
						}
						await rmdir(directory);
					};
					await remove(next, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						logger.warn("Isolated old blob cache cleanup deferred", { error: String(error) });
				}
			}
		} finally {
			cleanupQueue.running = false;
		}
	})();
}
