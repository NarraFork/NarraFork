import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError, ValidationError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { GITHUB_SKILL_IMPORT_LIMITS, validateImportedSkillPath } from "./skill-github-import";

export interface SkillDirectorySnapshot {
	fingerprint: string;
}

const HASH_CHUNK_BYTES = 64 * 1024;

type ManifestEntry =
	| { path: string; type: "directory"; stat: BigIntStats }
	| { path: string; type: "file"; hash: string; executable: number; stat: BigIntStats };

interface Observation {
	path: string;
	stat: BigIntStats;
}

function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new AppError(
			"Skill synchronization was cancelled or timed out.",
			408,
			"SKILL_SYNC_ABORTED",
		);
	}
}

function localChanged(): AppError {
	return new AppError(
		"The local skill directory changed while it was being read. Retry the synchronization.",
		409,
		"SKILL_SYNC_LOCAL_CHANGED",
	);
}

function unsafePath(): ValidationError {
	return new ValidationError(
		"The local skill contains symbolic links, special files, or conflicting paths.",
		"SKILL_SYNC_PATH",
	);
}

function limitExceeded(): ValidationError {
	return new ValidationError(
		"The local skill exceeds the directory snapshot limits.",
		"SKILL_SYNC_LIMIT",
	);
}

function sameStat(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

function statManifest(stat: BigIntStats): string[] {
	return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function inspectPath(path: string): Promise<BigIntStats> {
	try {
		return await fs.lstat(path, { bigint: true });
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) throw localChanged();
		throw error;
	}
}

async function verifyObservation(observation: Observation): Promise<void> {
	if (!sameStat(observation.stat, await inspectPath(observation.path))) throw localChanged();
}

async function hashFile(
	path: string,
	before: BigIntStats,
	limit: number,
	buffer: Buffer,
	signal?: AbortSignal,
): Promise<string> {
	checkAbort(signal);
	let file: fs.FileHandle;
	try {
		file = await fs.open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
	} catch (error) {
		if (hasCode(error, "ELOOP")) throw unsafePath();
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) throw localChanged();
		throw error;
	}
	try {
		checkAbort(signal);
		const opened = await file.stat({ bigint: true });
		if (!opened.isFile() || !sameStat(before, opened)) throw localChanged();
		const hash = createHash("sha256");
		let bytes = 0;
		while (true) {
			checkAbort(signal);
			// Read at most one extra byte: growing files cannot turn a small snapshot
			// into an unbounded read. Each 64 KiB read yields before the next hash update.
			const length = Math.min(buffer.byteLength, Number(before.size) - bytes + 1);
			const { bytesRead } = await file.read(buffer, 0, length, null);
			checkAbort(signal);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			if (bytes > limit) throw limitExceeded();
			if (bytes > Number(before.size)) throw localChanged();
			hash.update(buffer.subarray(0, bytesRead));
		}
		if (bytes !== Number(before.size) || !sameStat(before, await file.stat({ bigint: true }))) {
			throw localChanged();
		}
		await verifyObservation({ path, stat: before });
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}

/** Bounded local IO only; the caller owns the synchronization deadline and scope lock. */
export async function snapshotSkillDirectory(
	dir: string,
	signal?: AbortSignal,
): Promise<SkillDirectorySnapshot> {
	checkAbort(signal);
	const root = await inspectPath(dir);
	if (!root.isDirectory() || root.isSymbolicLink()) throw unsafePath();
	const observations: Observation[] = [{ path: dir, stat: root }];
	const entries: ManifestEntry[] = [];
	const paths = new Set<string>();
	const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
	let entryCount = 0;
	let fileCount = 0;
	let totalBytes = 0;

	const walk = async (absolute: string, relative: string, before: BigIntStats): Promise<void> => {
		checkAbort(signal);
		// Unlike readdir(), opendir() does not first materialize an unbounded directory.
		const directory = await fs.opendir(absolute, { bufferSize: 1 });
		try {
			// opendir has no NOFOLLOW flag: reject a swapped directory before reading
			// any children. Its original identity is checked again at the end as well.
			await verifyObservation({ path: absolute, stat: before });
			checkAbort(signal);
		} catch (error) {
			await directory.close();
			throw error;
		}
		for await (const entry of directory) {
			checkAbort(signal);
			if (++entryCount > GITHUB_SKILL_IMPORT_LIMITS.entries) throw limitExceeded();
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			validateImportedSkillPath(path);
			const key = path.normalize("NFC").toUpperCase().toLowerCase();
			if (paths.has(key)) throw unsafePath();
			paths.add(key);
			const fullPath = join(absolute, entry.name);
			const stat = await inspectPath(fullPath);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw unsafePath();
			observations.push({ path: fullPath, stat });
			if (stat.isDirectory()) {
				// Include directories themselves, so removing even an empty one is a change.
				entries.push({ path, type: "directory", stat });
				await walk(fullPath, path, stat);
				continue;
			}
			if (++fileCount > GITHUB_SKILL_IMPORT_LIMITS.files) throw limitExceeded();
			const limit = GITHUB_SKILL_IMPORT_LIMITS.fileBytes;
			if (stat.size < 0n || stat.size > BigInt(limit)) throw limitExceeded();
			totalBytes += Number(stat.size);
			if (totalBytes > GITHUB_SKILL_IMPORT_LIMITS.totalBytes) throw limitExceeded();
			entries.push({
				path,
				type: "file",
				stat,
				hash: await hashFile(fullPath, stat, limit, buffer, signal),
				executable: Number(stat.mode & 0o111n),
			});
		}
	};

	await walk(dir, "", root);
	// Detect edits to an earlier file/directory while later entries were being read.
	for (const observation of observations) {
		checkAbort(signal);
		await verifyObservation(observation);
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const complete = createHash("sha256").update("skill-directory-identity-v1\n");
	complete.update(`${JSON.stringify(["root", statManifest(root)])}\n`);
	for (const entry of entries) {
		checkAbort(signal);
		const record =
			entry.type === "file"
				? [entry.type, entry.path, entry.hash, entry.executable]
				: [entry.type, entry.path];
		// Identity also detects same-content rewrites and delete/recreate ABA during downloads.
		complete.update(`${JSON.stringify([record, statManifest(entry.stat)])}\n`);
	}
	checkAbort(signal);
	return { fingerprint: complete.digest("hex") };
}

/** Raw-text updates own only the definition; attachments are intentionally never enumerated. */
export async function snapshotSkillDefinition(
	skillFile: string,
	signal?: AbortSignal,
): Promise<SkillDirectorySnapshot> {
	checkAbort(signal);
	const directory = dirname(skillFile);
	const root = await inspectPath(directory);
	if (!root.isDirectory() || root.isSymbolicLink()) throw unsafePath();
	checkAbort(signal);
	const stat = await inspectPath(skillFile);
	if (!stat.isFile() || stat.isSymbolicLink()) throw unsafePath();
	const limit = GITHUB_SKILL_IMPORT_LIMITS.skillBytes;
	if (stat.size < 0n || stat.size > BigInt(limit)) throw limitExceeded();
	const hash = await hashFile(skillFile, stat, limit, Buffer.allocUnsafe(HASH_CHUNK_BYTES), signal);
	checkAbort(signal);
	await verifyObservation({ path: directory, stat: root });
	await verifyObservation({ path: skillFile, stat });
	checkAbort(signal);
	return {
		fingerprint: createHash("sha256")
			.update("skill-definition-identity-v1\n")
			.update(JSON.stringify([statManifest(root), basename(skillFile), statManifest(stat), hash]))
			.digest("hex"),
	};
}

async function unusedBackupPath(target: string, signal?: AbortSignal): Promise<string> {
	for (let attempt = 0; attempt < 8; attempt++) {
		checkAbort(signal);
		const path = join(dirname(target), `.skill-sync-backup-${generateId()}`);
		try {
			await fs.lstat(path);
		} catch (error) {
			if (hasCode(error, "ENOENT")) return path;
			throw error;
		}
	}
	throw new AppError(
		"Could not allocate a skill synchronization backup.",
		500,
		"SKILL_SYNC_BACKUP",
	);
}

/** The caller has already locked the scope and rechecked its target identity/snapshot. */
export async function replaceSkillDirectory(
	staging: string,
	target: string,
	signal?: AbortSignal,
): Promise<{ cleanupWarning?: string }> {
	const backupPath = await unusedBackupPath(target, signal);
	checkAbort(signal);
	await fs.rename(target, backupPath);
	// Do not honor cancellation between moving the old copy and committing/rolling back.
	try {
		await fs.rename(staging, target);
	} catch (publishError) {
		try {
			await fs.rename(backupPath, target);
		} catch {
			// No finally cleanup: the backup can now be the only remaining old copy.
			throw new AppError(
				"Skill synchronization could not restore the previous directory. Administrator recovery is required.",
				500,
				"SKILL_SYNC_RECOVERY_REQUIRED",
				undefined,
				{ backupPath },
			);
		}
		throw publishError;
	}
	try {
		await fs.rm(backupPath, { recursive: true });
	} catch {
		return {
			cleanupWarning: `The skill was updated, but its previous directory could not be removed: ${backupPath}`,
		};
	}
	return {};
}
