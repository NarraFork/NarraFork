/**
 * Bounded directory walk used by the storage scan.
 *
 * Production calls run only inside the filesystem worker. Tests may call this
 * pure core directly. Async filesystem operations let the worker observe
 * cancellation between entries; they do not make a server-thread walk safe.
 *
 * Symlinks are not followed. A directory link is reported as a directory by
 * `readdir` when its target is a directory, so the walk identifies links with
 * `lstat` and skips them. Otherwise a self-referential link recurses forever.
 */

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
	DIR_SCAN_MAX_DEPTH,
	DIR_SCAN_MAX_ENTRIES,
	DirectoryMeasureAbortedError,
	type DirectoryTreeMeasurement,
	type MeasureDirectoryTreesOptions,
} from "./protocol";

export {
	DIR_SCAN_MAX_DEPTH,
	DIR_SCAN_MAX_ENTRIES,
	DirectoryMeasureAbortedError,
	type DirectoryTreeMeasurement,
	type MeasureDirectoryTreesOptions,
} from "./protocol";

const PROGRESS_EVERY_ENTRIES = 200;

/**
 * Measure each root independently for depth, and share one entry budget across
 * the whole call. Roots are walked one after another inside this call; callers
 * that want parallelism run separate calls.
 */
export async function measureDirectoryTrees(
	roots: string[],
	options: MeasureDirectoryTreesOptions = {},
): Promise<DirectoryTreeMeasurement[]> {
	const maxEntries = options.maxEntries ?? DIR_SCAN_MAX_ENTRIES;
	const maxDepth = options.maxDepth ?? DIR_SCAN_MAX_DEPTH;
	const signal = options.signal;
	let entriesScanned = 0;
	let sizeBytes = 0;
	let truncated = false;
	// Depth stops one branch. The entry budget stops the whole call. Mixing them
	// made a deep child abandon siblings that were still inside the budget, so a
	// file next to a too-deep directory disappeared from the total.
	let budgetExhausted = false;
	let sinceProgress = 0;

	const report = (force = false) => {
		if (!force && sinceProgress < PROGRESS_EVERY_ENTRIES) return;
		sinceProgress = 0;
		options.onProgress?.({ entriesScanned, sizeBytes });
	};

	const walk = async (
		current: string,
		depth: number,
		acc: { sizeBytes: number },
	): Promise<void> => {
		if (signal?.aborted) throw new DirectoryMeasureAbortedError();
		if (budgetExhausted) return;
		if (depth > maxDepth) {
			truncated = true;
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (budgetExhausted) return;
			if (signal?.aborted) throw new DirectoryMeasureAbortedError();
			if (entriesScanned >= maxEntries) {
				truncated = true;
				budgetExhausted = true;
				return;
			}
			entriesScanned++;
			sinceProgress++;
			report();
			const full = resolve(current, entry.name);
			try {
				// lstat, not stat: a symlink must stay a link even when it points at a directory.
				const info = await lstat(full);
				if (info.isSymbolicLink()) continue;
				if (info.isDirectory()) await walk(full, depth + 1, acc);
				else if (info.isFile()) {
					acc.sizeBytes += info.size;
					sizeBytes += info.size;
				}
			} catch (error) {
				if (error instanceof DirectoryMeasureAbortedError) throw error;
				// skip inaccessible entries
			}
		}
	};

	const results: DirectoryTreeMeasurement[] = [];
	for (const root of roots) {
		if (signal?.aborted) throw new DirectoryMeasureAbortedError();
		if (!existsSync(root)) {
			results.push({ sizeBytes: 0, entriesScanned: 0, truncated: false });
			continue;
		}
		if (budgetExhausted) {
			results.push({ sizeBytes: 0, entriesScanned: 0, truncated: true });
			continue;
		}
		const entriesBefore = entriesScanned;
		const truncatedBefore = truncated;
		const acc = { sizeBytes: 0 };
		await walk(root, 0, acc);
		results.push({
			sizeBytes: acc.sizeBytes,
			entriesScanned: entriesScanned - entriesBefore,
			truncated: truncated && !truncatedBefore,
		});
	}
	report(true);
	return results;
}
