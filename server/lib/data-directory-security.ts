import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DataDirectorySecurityStatus } from "@shared/data-directory-security";
import { logger } from "./logger";

const MAX_ANCESTORS = 128;
const CHECK_BUDGET_MS = 5_000;
const REPAIR_HINT =
	"Ask an administrator to check data directory permissions in Settings > Storage, then retry. / 请让管理员在设置 > 存储中检查并修复数据目录权限后重试。";

export class DataDirectorySecurityError extends Error {
	constructor(
		readonly code: string,
		readonly path: string,
		message: string,
	) {
		super(`${message}. ${REPAIR_HINT}`);
		this.name = "DataDirectorySecurityError";
	}
}

/**
 * The probe ran out of budget, so nothing was decided about the directory.
 * Reported as `unknown`, never as a permission fault: a slow or hung filesystem
 * used to surface as "permissions are unsafe", sending admins to inspect a
 * directory that turned out to be perfectly fine.
 */
export class DataDirectoryCheckIncompleteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DataDirectoryCheckIncompleteError";
	}
}

type DirectoryEntry = { path: string; stat: BigIntStats };
type DirectoryChain = { canonical: string; entries: DirectoryEntry[]; uid: number | undefined };

function checkDeadline(deadline: number) {
	if (Date.now() > deadline)
		throw new DataDirectoryCheckIncompleteError("Data directory permission check timed out");
}

/**
 * Windows `realpath` may return an extended-length `\\?\` form. Strip the prefix
 * so path comparisons and UI diagnostics show the ordinary path.
 */
function stripWindowsExtendedPrefix(path: string): string {
	if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
	if (path.startsWith("\\\\?\\")) return path.slice(4);
	return path;
}

/** Only metadata on a bounded ancestor chain: never enumerate application files. */
async function readChain(path: string, deadline: number): Promise<DirectoryChain> {
	const requested = resolve(path);
	checkDeadline(deadline);
	// Identity is the real directory we secure, not the spelling the operator typed.
	// Windows realpath routinely rewrites case, 8.3 names, junctions and `\\?\`
	// prefixes; requiring the configured path to equal that result character-by-
	// character rejects ordinary user-profile layouts. POSIX keeps the strict
	// "already canonical" rule so a symlink alias cannot hide a swapped target.
	const canonical = stripWindowsExtendedPrefix(resolve(await realpath(requested)));
	checkDeadline(deadline);
	if (process.platform !== "win32" && canonical !== requested)
		throw new DataDirectorySecurityError(
			"canonical_path",
			requested,
			`Application data directory must use its real canonical path: ${requested}`,
		);
	const entries: DirectoryEntry[] = [];
	for (let cursor = canonical; ; cursor = dirname(cursor)) {
		checkDeadline(deadline);
		if (entries.length >= MAX_ANCESTORS)
			throw new Error("Application data directory ancestor limit exceeded");
		const link = await lstat(cursor, { bigint: true });
		let identity = link;
		if (link.isSymbolicLink()) {
			// After realpath the chain should already be fully resolved. A remaining
			// symlink is either a POSIX policy violation or a Windows reparse point
			// (junction) whose referent is a directory; only the latter is accepted.
			if (process.platform !== "win32")
				throw new DataDirectorySecurityError(
					"directory_type",
					cursor,
					`Application data ancestor must be a non-symlink directory: ${cursor}`,
				);
			const followed = await stat(cursor, { bigint: true });
			if (!followed.isDirectory())
				throw new DataDirectorySecurityError(
					"directory_type",
					cursor,
					`Application data ancestor must be a non-symlink directory: ${cursor}`,
				);
			identity = followed;
		} else if (!link.isDirectory()) {
			throw new DataDirectorySecurityError(
				"directory_type",
				cursor,
				`Application data ancestor must be a non-symlink directory: ${cursor}`,
			);
		}
		entries.push({ path: cursor, stat: identity });
		if (dirname(cursor) === cursor) break;
	}
	checkDeadline(deadline);
	return { canonical, entries: entries.reverse(), uid: process.geteuid?.() };
}

/** Preserve the runtime's identity digest, including its private-ancestor exception. */
function validateChain(chain: DirectoryChain, repairedLeaf = false): string {
	const { canonical, entries, uid } = chain;
	let privateAncestor = false;
	const digest = createHash("sha256");
	for (const { path, stat } of entries) {
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new DataDirectorySecurityError(
				"directory_type",
				path,
				`Application data ancestor must be a non-symlink directory: ${path}`,
			);
		if (process.platform !== "win32") {
			if (uid === undefined || (stat.uid !== BigInt(uid) && stat.uid !== 0n))
				throw new DataDirectorySecurityError(
					"owner",
					path,
					`Application data ancestor has an untrusted owner: ${path}`,
				);
			const own = stat.uid === BigInt(uid);
			const mode = repairedLeaf && path === canonical ? 0o700n : stat.mode;
			if (
				path === canonical &&
				(!own || (mode & 0o002n) !== 0n || (!privateAncestor && (mode & 0o020n) !== 0n))
			)
				throw new DataDirectorySecurityError(
					own ? "leaf_permissions" : "owner",
					canonical,
					`Application data directory must be owner-controlled; shared write permissions require a private ancestor: ${canonical}`,
				);
			// A sticky shared parent protects owned child names. A non-sticky writable
			// ancestor does not, even if the application's own directory is 0700.
			if (!privateAncestor && (mode & 0o022n) !== 0n && (mode & 0o1000n) === 0n)
				throw new DataDirectorySecurityError(
					"ancestor_permissions",
					path,
					`Application data directory is writable by others without a private ancestor: ${path}`,
				);
			if (own && (mode & 0o011n) === 0n) privateAncestor = true;
		}
		const value = `${path}\0${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
		digest.update(`${Buffer.byteLength(value)}:`).update(value);
	}
	return digest.digest("hex");
}

/** Used by write admission too, so UI health can never silently relax its policy. */
export async function requireApplicationDataDirectory(path: string): Promise<string> {
	return validateChain(await readChain(path, Date.now() + CHECK_BUDGET_MS));
}

function errorStatus(
	path: string,
	error: unknown,
	chain?: DirectoryChain,
): DataDirectorySecurityStatus {
	let canRepair = false;
	if (
		chain &&
		error instanceof DataDirectorySecurityError &&
		error.code === "leaf_permissions" &&
		process.platform !== "win32"
	) {
		try {
			validateChain(chain, true);
			canRepair = true;
		} catch {
			// A chmod of the leaf cannot repair unsafe ancestors or ownership.
		}
	}
	const badPath = error instanceof DataDirectorySecurityError ? error.path : resolve(path);
	const entry = chain?.entries.find((item) => item.path === badPath);
	return {
		status:
			error instanceof DataDirectorySecurityError
				? "restricted"
				: error instanceof DataDirectoryCheckIncompleteError
					? "unknown"
					: "unavailable",
		canRepair,
		details: {
			code:
				error instanceof DataDirectorySecurityError
					? error.code
					: error instanceof DataDirectoryCheckIncompleteError
						? "check_incomplete"
						: "check_failed",
			path: badPath,
			message: error instanceof Error ? error.message : "Data directory permission check failed",
			...(entry
				? {
						mode: (entry.stat.mode & 0o7777n).toString(8).padStart(4, "0"),
						ownerUid: Number(entry.stat.uid),
					}
				: {}),
			...(chain?.uid !== undefined ? { serviceUid: chain.uid } : {}),
		},
	};
}

export async function inspectApplicationDataDirectory(
	path: string,
): Promise<DataDirectorySecurityStatus> {
	const start = Date.now();
	let chain: DirectoryChain | undefined;
	try {
		chain = await readChain(path, start + CHECK_BUDGET_MS);
		validateChain(chain);
		return { status: "ok", canRepair: false };
	} catch (error) {
		// An inconclusive probe is reported as such; it is not evidence of a fault.
		return errorStatus(path, error, chain);
	} finally {
		if (Date.now() - start > 1_000)
			logger.warn("Slow data directory permission check", { elapsedMs: Date.now() - start });
	}
}

function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.uid === b.uid;
}

const repairs = new Map<string, Promise<DataDirectorySecurityStatus>>();

/** Caller must authorize and confirm. No arbitrary paths are accepted by the HTTP route. */
export function repairApplicationDataDirectory(
	path: string,
	authorize?: () => void,
): Promise<DataDirectorySecurityStatus> {
	const canonical = resolve(path);
	const existing = repairs.get(canonical);
	if (existing) return existing;
	const repair = repairDirectory(canonical, authorize).finally(() => {
		if (repairs.get(canonical) === repair) repairs.delete(canonical);
	});
	repairs.set(canonical, repair);
	return repair;
}

async function repairDirectory(
	path: string,
	authorize?: () => void,
): Promise<DataDirectorySecurityStatus> {
	let chain: DirectoryChain | undefined;
	try {
		const deadline = Date.now() + CHECK_BUDGET_MS;
		chain = await readChain(path, deadline);
		try {
			validateChain(chain);
			return { status: "ok", canRepair: false };
		} catch (error) {
			const status = errorStatus(path, error, chain);
			if (!status.canRepair) return status;
		}
		const boundary = validateChain(chain, true);
		const leaf = chain.entries.at(-1);
		if (!leaf || process.platform === "win32" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
			throw new Error("Safe directory-handle permission repair is unavailable on this platform");
		// Work on an opened directory, never chmod(path) after a separate path check.
		const handle = await open(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const opened = await handle.stat({ bigint: true });
			if (!sameDirectory(opened, leaf.stat) || !opened.isDirectory())
				throw new Error("Data directory identity changed; check again before repairing");
			const current = await readChain(path, deadline);
			if (validateChain(current, true) !== boundary)
				throw new Error("Data directory ancestors changed; check again before repairing");
			checkDeadline(deadline);
			// Role/authorization may have changed while filesystem reads were pending.
			authorize?.();
			await handle.chmod(0o700);
			logger.info("Repaired application data directory permissions", { path, mode: "0700" });
		} finally {
			await handle.close();
		}
		return await inspectApplicationDataDirectory(path);
	} catch (error) {
		// A failed chmod is not a completed repair; expose diagnostics for the admin.
		return errorStatus(path, error, chain);
	}
}

/** Non-admin status contains no OS account names, paths, or permission diagnostics. */
export function publicDataDirectoryStatus(
	status: DataDirectorySecurityStatus,
): DataDirectorySecurityStatus {
	return { status: status.status, canRepair: false };
}
