/**
 * The copy of the outline's tables taken before the placement conversion touches a database
 * written before placements existed (pageless plan §二.4): every `outline_*` table, whole, in a
 * separate SQLite file under `<data dir>/backups/` that the owner can keep. It is the only
 * record of the outline as it was, so the conversion does not start without it.
 *
 * HOW IT IS MADE
 * --------------
 * By the dedicated snapshot process (`server/db/snapshot-build.ts`), never on this thread: the
 * process opens the database read-only, copies table by table inside one read transaction and
 * checks every table's row count. It writes to a `.partial` name; the file gets its final name
 * only after the process reported success, so a file with the final name is always whole. When
 * the process cannot be started, is stopped or reports a mismatch, there is no copy and the
 * caller does not convert: nothing is copied on this thread instead.
 *
 * Nothing here deletes or rewrites the database, and nothing removes a copy once made: how long
 * it is kept is the owner's decision. A copy already there is not made again.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { sqlite } from "@server/db";
import { buildSnapshotInSubprocess } from "@server/db/snapshot-build";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import type { OutlineStore } from "./store/port";
import { sqliteOutlineStore } from "./store/sqlite-store";

const PREFIX = "outline-before-pageless-";
const SUFFIX = ".db";
/** A large outline is copied row by row in another process: allow it half an hour. */
const COPY_TIMEOUT_MS = 30 * 60_000;

export interface OutlineBackupResult {
	/** The copy's path. */
	path: string;
	/** False when a copy made earlier was found and kept. */
	created: boolean;
	tables?: number;
	rows?: number;
}

/** The copy in `directory`, if one was completed before. */
async function existingCopy(directory: string): Promise<string | null> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return null;
	}
	const found = names.filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX)).sort();
	const first = found[0];
	return first ? join(directory, first) : null;
}

/**
 * Copy the outline's tables of the SQLite database at `sourcePath` into
 * `<directory>/outline-before-pageless-<date>.db`, unless a copy is there already. Rejects when
 * the copy could not be made and verified.
 */
export async function backupOutlineTables(options: {
	sourcePath: string;
	directory: string;
	now?: Date;
	signal?: AbortSignal;
}): Promise<OutlineBackupResult> {
	const existing = await existingCopy(options.directory);
	if (existing) return { path: existing, created: false };
	await mkdir(options.directory, { recursive: true });
	const date = (options.now ?? new Date()).toISOString().slice(0, 10);
	const path = join(options.directory, `${PREFIX}${date}${SUFFIX}`);
	const partial = `${path}.partial`;
	// Left by a copy that was interrupted: never whole, so it is replaced (it is not the database).
	await rm(partial, { force: true });
	try {
		const report = await buildSnapshotInSubprocess({
			sourcePath: options.sourcePath,
			outputPath: partial,
			requests: false,
			sessions: false,
			outline: true,
			timeoutMs: COPY_TIMEOUT_MS,
			signal: options.signal,
		});
		await rename(partial, path);
		return { path, created: true, tables: report.tables, rows: report.rows };
	} catch (error) {
		await rm(partial, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * The backup step of the conversion for a store, or null when the store has no database file of
 * ours to copy: PostgreSQL is backed up by whoever operates it (`docs/`), and an in-memory
 * SQLite database (tests) has nothing to keep.
 */
export function outlineBackupFor(store: OutlineStore): (() => Promise<string | null>) | null {
	if (store !== sqliteOutlineStore) return null;
	return async () => {
		const sourcePath = sqlite.filename;
		if (!sourcePath || sourcePath === ":memory:") return null;
		const result = await backupOutlineTables({
			sourcePath,
			directory: getNarraforkPath("backups"),
		});
		if (result.created)
			logger.info("Outline tables copied before the placement conversion", { ...result });
		return result.path;
	};
}
