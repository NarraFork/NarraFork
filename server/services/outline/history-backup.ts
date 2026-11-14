/**
 * The copy of the outline's tables taken before the placement conversion touches a database
 * written before placements existed (pageless plan §二.4): every `outline_*` table, whole, in a
 * separate SQLite file under `<data dir>/backups/` that the owner can keep. It is the only
 * record of the outline as it was, so the conversion does not start without it.
 *
 * HOW IT IS MADE
 * --------------
 * By the dedicated snapshot process (`server/db/snapshot-build.ts`), never on this thread: the
 * process opens the database read-only, copies table by table inside one read transaction,
 * checks every table's row count and writes a stamp last (`backup_stamp`: where the copy came
 * from, when, how much; `backup_spaces`: for each space the seq it stood at and its blocks). It
 * writes to a `.partial` name; the file gets its final name only after the process reported
 * success. When the process cannot be started, is stopped or reports a mismatch, there is no
 * copy and the caller does not convert: nothing is copied on this thread instead.
 *
 * WHAT COUNTS AS A COPY
 * ---------------------
 * Not a file's name. A copy found in the directory is used only if it validates
 * ({@link readOutlineBackup}: it opens, holds `outline_blocks` and a stamp of a format this code
 * knows, and its stamp agrees with itself), was made from THIS database file, and holds every
 * space the caller is about to convert at a seq no later than that space's now: a copy of this
 * database's own past. That is enough for a conversion that deletes nothing (what was written
 * since is still in the database), and it means a conversion resumed after more commits does
 * not write a second full copy. Of several such copies the one stamped latest is used.
 * Anything else is treated as absent, left where it is, and a new copy is written under a name
 * of its own. {@link backupOutlineTablesFresh} skips the search and always writes a new one:
 * for a caller about to delete what the copy holds, which needs it current.
 *
 * Nothing here deletes or rewrites the database, and nothing removes a copy once made, valid or
 * not: how long it is kept is the owner's decision. Only this module's own `.partial` files
 * (left by a copy that was interrupted) are removed. A copy is not started into a directory
 * with less than {@link OUTLINE_BACKUP_MIN_FREE_BYTES} free; beyond that floor the copy itself
 * is the test (the outline's tables may be a small part of a large database, so the database's
 * size says nothing): when the disk fills, the process fails, the partial file is removed and
 * the caller tries again later.
 */
import { Database } from "bun:sqlite";
import { mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { sqlite } from "@server/db";
import { buildSnapshotInSubprocess } from "@server/db/snapshot-build";
import { OUTLINE_BACKUP_FORMAT } from "@server/db/snapshot-protocol";
import { logger } from "@server/lib/logger";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import type { OutlineHistoryPort } from "./store/history-port";
import type { OutlineStore } from "./store/port";
import { sqliteOutlineStore } from "./store/sqlite-store";

const PREFIX = "outline-before-pageless-";
const SUFFIX = ".db";
const PARTIAL = ".partial";
/** A large outline is copied row by row in another process: allow it half an hour. */
const COPY_TIMEOUT_MS = 30 * 60_000;
/** Free space below which no copy is started. */
export const OUTLINE_BACKUP_MIN_FREE_BYTES = 64 * 1024 * 1024;
/** Spaces looked up in a copy between two yields to the event loop. */
const CHECK_CHUNK = 500;

/** What a finished copy says of itself (`backup_stamp`). */
export interface OutlineBackupStamp {
	format: number;
	/** The database file it was copied from. */
	sourcePath: string;
	createdAt: string;
	tables: number;
	rows: number;
	/** Spaces it holds (rows of `backup_spaces`). */
	spaces: number;
}

export interface OutlineBackupResult {
	/** The copy's path. */
	path: string;
	/** False when a copy made earlier was found valid and kept. */
	created: boolean;
	stamp: OutlineBackupStamp;
}

/** The directory has too little free space to start a copy: none was attempted. */
export class OutlineBackupSpaceError extends Error {
	constructor(
		readonly directory: string,
		readonly neededBytes: number,
		readonly freeBytes: number,
	) {
		super(
			`not enough free space in ${directory} to copy the outline's tables: ${freeBytes} bytes free, at least ${neededBytes} wanted`,
		);
		this.name = "OutlineBackupSpaceError";
	}
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Open a copy read-only and read its stamp: null when the file is not a finished copy this code
 * can read (it does not open, has no `outline_blocks`, no stamp, a stamp of another format, or a
 * stamp that disagrees with the file). A few small reads by key; the file is never written.
 */
export function readOutlineBackup(path: string): OutlineBackupStamp | null {
	let copy: Database | undefined;
	try {
		copy = new Database(path, { readonly: true });
		const has = (table: string) =>
			copy?.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !=
			null;
		if (!has("outline_blocks") || !has("backup_stamp") || !has("backup_spaces")) return null;
		const row = copy
			.query(
				"SELECT format, source_path, created_at, tables, rows, spaces FROM backup_stamp LIMIT 1",
			)
			.values()[0] as [number, string, string, number, number, number] | undefined;
		if (!row || Number(row[0]) !== OUTLINE_BACKUP_FORMAT) return null;
		const stamp: OutlineBackupStamp = {
			format: Number(row[0]),
			sourcePath: row[1],
			createdAt: row[2],
			tables: Number(row[3]),
			rows: Number(row[4]),
			spaces: Number(row[5]),
		};
		const spaces = copy.query("SELECT count(*) FROM backup_spaces").values()[0] as [number];
		return Number(spaces[0]) === stamp.spaces ? stamp : null;
	} catch {
		return null;
	} finally {
		try {
			copy?.close();
		} catch {
			// Nothing to do: the file was only read.
		}
	}
}

/**
 * Whether a validated copy is of `sourcePath` and holds every space of `expect` at a seq no
 * later than the one given (the space's now): a copy of this database as it was.
 */
async function covers(
	path: string,
	stamp: OutlineBackupStamp,
	sourcePath: string,
	expect: ReadonlyMap<string, number>,
): Promise<boolean> {
	if (stamp.sourcePath !== sourcePath) return false;
	let copy: Database | undefined;
	try {
		copy = new Database(path, { readonly: true });
		const lookup = copy.query("SELECT next_seq FROM backup_spaces WHERE space_id = ?");
		let checked = 0;
		for (const [spaceId, nextSeq] of expect) {
			const row = lookup.values(spaceId)[0] as [number] | undefined;
			if (!row || Number(row[0]) > nextSeq) return false;
			if (++checked % CHECK_CHUNK === 0) await yieldToEventLoop();
		}
		return true;
	} catch {
		return false;
	} finally {
		try {
			copy?.close();
		} catch {
			// Only read.
		}
	}
}

async function namesIn(directory: string): Promise<string[]> {
	try {
		return await readdir(directory);
	} catch {
		return [];
	}
}

async function freeBytesOf(directory: string): Promise<number | null> {
	try {
		const fs = await statfs(directory);
		return Number(fs.bavail) * Number(fs.bsize);
	} catch {
		// A file system that does not say: the copy itself will tell.
		return null;
	}
}

/**
 * Copy the outline's tables of the SQLite database at `sourcePath` into
 * `<directory>/outline-before-pageless-<date>.db` (`-2`, `-3`… when that name is taken), and
 * resolve with the validated copy.
 *
 * Unless `fresh`, a copy already in the directory is returned instead when it validates, was
 * made from `sourcePath`, and holds every space of `expect` at a seq no later than the one
 * given there (see the module header); `expect` left out accepts any valid copy of this
 * database. Of several, the one stamped latest.
 *
 * Rejects, having left no file with a final name, when there is not enough free space
 * ({@link OutlineBackupSpaceError}), the copy could not be made, or it does not validate.
 */
export async function backupOutlineTables(options: {
	sourcePath: string;
	directory: string;
	/** Spaces the copy must hold, with their `next_seq` now. */
	expect?: ReadonlyMap<string, number>;
	/** Always make a new copy, whatever is there. */
	fresh?: boolean;
	now?: Date;
	signal?: AbortSignal;
	/** Free bytes of a directory, null when unknown (tests inject it). */
	freeBytes?: (directory: string) => Promise<number | null>;
}): Promise<OutlineBackupResult> {
	const { sourcePath, directory } = options;
	await mkdir(directory, { recursive: true });
	const names = await namesIn(directory);
	const ours = (name: string) => name.startsWith(PREFIX);
	// Left by copies that were interrupted, today or earlier: never whole, and only ever ours.
	for (const name of names.filter((n) => ours(n) && n.endsWith(`${SUFFIX}${PARTIAL}`))) {
		await rm(join(directory, name), { force: true });
	}
	const finished = names.filter((n) => ours(n) && n.endsWith(SUFFIX)).sort();
	if (!options.fresh) {
		const usable: OutlineBackupResult[] = [];
		for (const name of finished) {
			const path = join(directory, name);
			const stamp = readOutlineBackup(path);
			if (!stamp) {
				logger.warn(
					"Outline backup: a file with a copy's name is not a finished copy; left as is",
					{ path },
				);
				continue;
			}
			if (await covers(path, stamp, sourcePath, options.expect ?? new Map()))
				usable.push({ path, created: false, stamp });
		}
		// The latest by its own stamp (names say nothing: `-2` sorts before `.db`).
		usable.sort((a, b) => (a.stamp.createdAt < b.stamp.createdAt ? 1 : -1));
		if (usable[0]) return usable[0];
	}

	const free = await (options.freeBytes ?? freeBytesOf)(directory);
	if (free !== null && free < OUTLINE_BACKUP_MIN_FREE_BYTES)
		throw new OutlineBackupSpaceError(directory, OUTLINE_BACKUP_MIN_FREE_BYTES, free);

	const date = (options.now ?? new Date()).toISOString().slice(0, 10);
	let name = `${PREFIX}${date}${SUFFIX}`;
	for (let n = 2; finished.includes(name); n++) name = `${PREFIX}${date}-${n}${SUFFIX}`;
	const path = join(directory, name);
	const partial = `${path}${PARTIAL}`;
	try {
		await buildSnapshotInSubprocess({
			sourcePath,
			outputPath: partial,
			requests: false,
			sessions: false,
			outline: true,
			timeoutMs: COPY_TIMEOUT_MS,
			signal: options.signal,
		});
		// Read back before it gets its name: what is kept is what a later run will accept.
		const stamp = readOutlineBackup(partial);
		if (!stamp || stamp.sourcePath !== sourcePath)
			throw new Error("the copy of the outline's tables does not validate");
		await rename(partial, path);
		return { path, created: true, stamp };
	} catch (error) {
		await rm(partial, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * A new, validated copy whatever copies exist: for a caller about to delete what it holds (the
 * final conversion), which needs the copy to be of the database as it is now. An existing copy
 * is neither reused nor touched.
 */
export function backupOutlineTablesFresh(options: {
	sourcePath: string;
	directory: string;
	now?: Date;
	signal?: AbortSignal;
	freeBytes?: (directory: string) => Promise<number | null>;
}): Promise<OutlineBackupResult> {
	return backupOutlineTables({ ...options, fresh: true });
}

/**
 * The backup step of the conversion for a store, or null when the store has no database file of
 * ours to copy: PostgreSQL is backed up by whoever operates it, and an in-memory SQLite
 * database (tests) has nothing to keep. The step asks for a copy that holds every space still
 * to be converted (as it stands now, or as it stood: see the module header).
 */
export function outlineBackupFor(
	store: OutlineStore,
	pending: Pick<OutlineHistoryPort, "listSpacesPendingEdges"> = store,
): ((signal?: AbortSignal) => Promise<string | null>) | null {
	if (store !== sqliteOutlineStore) return null;
	return async (signal) => {
		const sourcePath = sqlite.filename;
		if (!sourcePath || sourcePath === ":memory:") return null;
		const expect = new Map<string, number>();
		let after: string | null = null;
		for (;;) {
			const page = await pending.listSpacesPendingEdges({ after, limit: CHECK_CHUNK });
			for (const space of page) expect.set(space.id, space.nextSeq);
			const last = page.at(-1);
			if (!last || page.length < CHECK_CHUNK) break;
			after = last.id;
			await yieldToEventLoop();
		}
		const result = await backupOutlineTables({
			sourcePath,
			directory: getNarraforkPath("backups"),
			expect,
			signal,
		});
		if (result.created)
			logger.info("Outline tables copied before the placement conversion", {
				path: result.path,
				...result.stamp,
			});
		return result.path;
	};
}
