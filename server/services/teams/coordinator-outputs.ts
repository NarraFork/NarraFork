/**
 * A team coordinator's saved tool outputs (Project Teams P2, plan §二.14 "上下文保护").
 *
 * WHERE: `~/.narrafork/coordinator-outputs/<narratorId>/` (`coordinator-outputs-path.ts`), one
 * directory per coordinator, never a shared temp directory. Only the narrator itself reads its
 * directory without approval (the permission gate's own-output rule), and Read returns these
 * files whole (no 2,000-character line cut).
 *
 * NAMES: the SHA-256 of the saved text (first 32 hex digits). The same text saved again by the
 * same coordinator (a retried call) lands on the same file; different text never collides, and
 * different coordinators never share a directory.
 *
 * PARTS: Read's whole-file mode (`limit: -1`) returns up to 100,000 characters, counting each
 * line plus 16. A text over that is saved as consecutive parts, each readable whole with one
 * `limit: -1` Read; joined without separators they are the text exactly (a line too long for a
 * part is split between parts).
 *
 * SIZE: at most {@link COORDINATOR_OUTPUT_LIMITS.bytesPerNarrator} per coordinator; when a save
 * goes over, the oldest files (by modification time) go first, never the ones just written. So
 * the reminder says the result is kept "while available". A coordinator's directory is removed
 * when the narrator is deleted, and directories of narrators that no longer exist are swept at
 * startup (`coordinator-maintenance.ts`). The storage page counts them (`coordinatorOutputs`).
 *
 * All file IO is async; the in-memory size index is built once per directory and process by one
 * bounded scan, and saves to one directory are serialized.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hotSafe } from "@server/lib/hot-safe";
import { coordinatorOutputsDir, coordinatorOutputsRoot } from "../../lib/coordinator-outputs-path";
import { logger } from "../../lib/logger";

export const COORDINATOR_OUTPUT_LIMITS = {
	/** Saved outputs kept per coordinator; the oldest go first past it. */
	bytesPerNarrator: 200 * 1024 * 1024,
	/** Read budget of one part: Read's whole-file cap (100,000) with room to spare. */
	partChars: 90_000,
	/** What Read's whole-file mode counts per line on top of its characters. */
	lineOverhead: 16,
	/** A text that needs more parts than this is not saved (the full text is returned instead). */
	maxParts: 64,
	/** Files looked at when a directory's index is first built. */
	indexFiles: 20_000,
} as const;

/** Split a text into parts that Read's `limit: -1` returns whole; joined they are the text. */
export function splitForRead(text: string): string[] {
	const budget = COORDINATOR_OUTPUT_LIMITS.partChars;
	const overhead = COORDINATOR_OUTPUT_LIMITS.lineOverhead;
	const parts: string[] = [];
	let partStart = 0;
	let partCost = 0;
	let index = 0;
	while (index < text.length) {
		const newline = text.indexOf("\n", index);
		const lineEnd = newline === -1 ? text.length : newline + 1;
		const cost = lineEnd - index - (newline === -1 ? 0 : 1) + overhead;
		if (partCost > 0 && partCost + cost > budget) {
			parts.push(text.slice(partStart, index));
			partStart = index;
			partCost = 0;
		}
		if (cost > budget) {
			// One line longer than a part: whole slices of it, each its own part.
			const chunk = budget - overhead;
			let at = index;
			while (lineEnd - at > chunk) {
				let end = at + chunk;
				const code = text.charCodeAt(end - 1);
				if (code >= 0xd800 && code <= 0xdbff) end--;
				parts.push(text.slice(at, end));
				at = end;
			}
			partStart = at;
			partCost = lineEnd - at + overhead;
		} else {
			partCost += cost;
		}
		index = lineEnd;
	}
	if (partStart < text.length || parts.length === 0) parts.push(text.slice(partStart));
	return parts;
}

interface DirIndex {
	files: Map<string, { size: number; mtimeMs: number }>;
	bytes: number;
}

const indexes = hotSafe<Map<string, Promise<DirIndex>>>(
	"narrafork.teams.coordinatorOutputIndexes",
	() => new Map(),
);
const queues = hotSafe<Map<string, Promise<unknown>>>(
	"narrafork.teams.coordinatorOutputQueues",
	() => new Map(),
);

async function buildIndex(dir: string): Promise<DirIndex> {
	const index: DirIndex = { files: new Map(), bytes: 0 };
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return index;
	}
	for (const name of names.slice(0, COORDINATOR_OUTPUT_LIMITS.indexFiles)) {
		try {
			const info = await stat(join(dir, name));
			if (!info.isFile()) continue;
			index.files.set(name, { size: info.size, mtimeMs: info.mtimeMs });
			index.bytes += info.size;
		} catch {
			// gone meanwhile
		}
	}
	return index;
}

function indexOf(narratorId: string, dir: string): Promise<DirIndex> {
	let index = indexes.get(narratorId);
	if (!index) {
		index = buildIndex(dir);
		indexes.set(narratorId, index);
	}
	return index;
}

/** Run one save of a directory after the previous one. */
function serialized<T>(narratorId: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(narratorId) ?? Promise.resolve();
	const next = previous.then(task, task);
	const tail = next.catch(() => {});
	queues.set(narratorId, tail);
	void tail.then(() => {
		if (queues.get(narratorId) === tail) queues.delete(narratorId);
	});
	return next;
}

let capOverride: number | null = null;

/** Use a smaller per-coordinator cap (tests); null restores the real one. */
export function setCoordinatorOutputCapForTests(bytes: number | null): void {
	capOverride = bytes;
}

const capBytes = () => capOverride ?? COORDINATOR_OUTPUT_LIMITS.bytesPerNarrator;

/** Drop the oldest files until the directory fits, never one of `keep`. */
async function prune(dir: string, index: DirIndex, keep: ReadonlySet<string>): Promise<void> {
	if (index.bytes <= capBytes()) return;
	const oldest = [...index.files.entries()]
		.filter(([name]) => !keep.has(name))
		.sort((a, b) => a[1].mtimeMs - b[1].mtimeMs || (a[0] < b[0] ? -1 : 1));
	for (const [name, info] of oldest) {
		if (index.bytes <= capBytes()) break;
		try {
			await unlink(join(dir, name));
		} catch {
			// already gone: drop it from the index all the same
		}
		index.files.delete(name);
		index.bytes -= info.size;
	}
}

/**
 * Save a coordinator's full output; the part paths in order, or null when it could not be saved
 * (an unusable id, too many parts, a file system error). Never throws.
 */
export async function saveCoordinatorOutput(
	narratorId: string,
	text: string,
): Promise<string[] | null> {
	const dir = coordinatorOutputsDir(narratorId);
	if (!dir) return null;
	const parts = splitForRead(text);
	if (parts.length > COORDINATOR_OUTPUT_LIMITS.maxParts) return null;
	const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
	const names =
		parts.length === 1
			? [`${hash}.txt`]
			: parts.map((_, i) => `${hash}.part${i + 1}of${parts.length}.txt`);
	try {
		return await serialized(narratorId, async () => {
			await mkdir(dir, { recursive: true });
			const index = await indexOf(narratorId, dir);
			const now = new Date();
			for (const [i, name] of names.entries()) {
				const path = join(dir, name);
				const known = index.files.get(name);
				if (known) {
					// The same text again: keep the file, make it the newest.
					await utimes(path, now, now).catch(() => writeFile(path, parts[i] as string, "utf8"));
					known.mtimeMs = now.getTime();
					continue;
				}
				await writeFile(path, parts[i] as string, "utf8");
				const size = Buffer.byteLength(parts[i] as string, "utf8");
				index.files.set(name, { size, mtimeMs: now.getTime() });
				index.bytes += size;
			}
			await prune(dir, index, new Set(names));
			return names.map((name) => join(dir, name));
		});
	} catch (error) {
		logger.warn("Could not save a coordinator's full tool output", {
			narratorId,
			error: String(error),
		});
		return null;
	}
}

/** Remove a coordinator's saved outputs (its narrator is gone). Never throws. */
export async function removeCoordinatorOutputs(narratorId: string): Promise<void> {
	const dir = coordinatorOutputsDir(narratorId);
	if (!dir) return;
	await serialized(narratorId, async () => {
		indexes.delete(narratorId);
		await rm(dir, { recursive: true, force: true });
	}).catch((error) =>
		logger.warn("Could not remove a coordinator's saved outputs", {
			narratorId,
			error: String(error),
		}),
	);
}

/** The narrator ids that have a saved-output directory (at most `limit`). */
export async function listCoordinatorOutputOwners(limit: number): Promise<string[]> {
	try {
		const entries = await readdir(coordinatorOutputsRoot(), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.slice(0, limit);
	} catch {
		return [];
	}
}

/** Forget the in-memory indexes (tests). */
export function resetCoordinatorOutputIndexes(): void {
	indexes.clear();
}
