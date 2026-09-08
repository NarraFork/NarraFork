import { Buffer } from "node:buffer";

export interface ParsedTreeMergeResult {
	tree: string;
	conflicts: string[];
	/** The process exit status, never whether the path list happens to be empty. */
	hasConflicts: boolean;
	/** Every conflict is confined to the concrete files in conflicts. */
	conflictsComplete: boolean;
	/** Marker checks alone can account for every conflict; see the name-only limitation below. */
	conflictMarkersComplete: boolean;
	/** Candidate only: the caller must still verify modes, driver constraints and actual markers. */
	markerCheckAllowed: boolean;
}

// Match the native merge runner's capture budget, before allocating records/sets.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const FILE_CONFLICTS = new Set([
	"CONFLICT (contents)",
	"CONFLICT (binary)",
	"CONFLICT (modify/delete)",
]);

// Git v2.47.3 merge-ort.c: type_short_descriptions + path_msg call sites.
// Counts describe *raw* paths, before deduplication. They are not stage counts.
// Only the three FILE_CONFLICTS above certify individual file locations.
const MESSAGE_PATH_COUNTS = new Map<string, readonly [number, number]>([
	["Auto-merging", [1, 1]],
	["CONFLICT (contents)", [1, 1]],
	["CONFLICT (binary)", [1, 1]],
	["CONFLICT (modify/delete)", [1, 1]],
	["CONFLICT (file/directory)", [2, 2]], // Displaced file AND directory, not two files.
	["CONFLICT (distinct modes)", [2, 3]], // Original and one/two relocated paths.
	["CONFLICT (rename/rename)", [3, 3]], // Source and both destinations.
	["CONFLICT (rename involved in collision)", [2, 2]],
	["CONFLICT (rename/delete)", [2, 2]],
	["CONFLICT (directory rename suggested)", [2, 2]],
	// A variable number of colliding source files follows the target file/directory.
	["CONFLICT (file in way of directory rename)", [2, Infinity]],
	["CONFLICT(directory rename collision)", [3, Infinity]],
	// This is a DIRECTORY, with no list of its affected descendants (e.g. d/c).
	["CONFLICT(directory rename unclear split)", [1, 1]],
	["CONFLICT (submodule)", [1, 1]], // Gitlink, not a marker-bearing regular file.
	["CONFLICT (submodule with possible resolution)", [1, 1]],
	["CONFLICT (submodule not initialized)", [1, 1]],
	["CONFLICT (submodule history not available)", [1, 1]],
	["CONFLICT (submodule may have rewinds)", [1, 1]],
	["CONFLICT (submodule lacks merge base)", [1, 1]],
	["Fast forwarding submodule", [1, 1]],
	["Path updated due to directory rename", [2, 2]],
	["Directory rename skipped since directory was renamed on both sides", [3, 3]],
]);

function malformed(reason: string): never {
	// No human message (or untrusted path) is copied into an error/UI response.
	throw new Error(`Invalid git merge-tree output: ${reason}`);
}

/**
 * Parse one `merge-tree --write-tree --name-only --messages -z` result, NOT --stdin.
 *
 * builtin/merge-tree.c emits: tree NUL, name-only index paths, an empty NUL
 * separator, then zero or more [count NUL, paths..., type NUL, message NUL].
 * There is no extra end-of-messages sentinel. Never split on whitespace, unquote
 * paths, or infer paths/status from localized prose. A full stage record is
 * indistinguishable from a legal filename here; the caller must use --name-only.
 *
 * merge-ort.c calls even symlink, gitlink and mode-only failures "CONFLICT
 * (contents)" (plural). Message/path relationships are many-to-many; binary and
 * submodule conflicts can have an additional contents record for the SAME path.
 *
 * IMPORTANT: even contents + same-path Auto-merging cannot prove marker safety.
 * An add/add mode conflict with ours=empty/100644 and theirs=text/100755 has
 * exactly those types, no distinct-modes record, and NO markers in the result.
 * --name-only hides the modes; the opaque human description is not evidence.
 * Custom merge drivers can likewise fail without writing markers. Therefore
 * this pure parser conservatively returns conflictMarkersComplete=false for
 * EVERY exit-1 result, including ordinary text conflicts. markerCheckAllowed
 * only identifies known contents + same-path Auto-merging candidates; it is NOT
 * a resolution certificate. The caller must separately validate modes, driver
 * constraints and actual markers before upgrading conflictMarkersComplete.
 *
 * The caller must reject safeSpawn's truncation flags: truncation exactly at a
 * record boundary cannot always be detected from stdout alone.
 */
export function parseMergeTreeOutput(stdout: string, exitCode: number): ParsedTreeMergeResult {
	if (exitCode !== 0 && exitCode !== 1) malformed("unexpected exit code");
	if (stdout.length > MAX_OUTPUT_BYTES || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
		malformed("exceeded the 1 MiB size limit");
	}
	let offset = 0;
	const record = (): string => {
		const end = stdout.indexOf("\0", offset);
		if (end < 0) malformed("missing NUL record boundary or section separator");
		const value = stdout.slice(offset, end);
		offset = end + 1;
		return value;
	};
	const tree = record();
	// The length guard also excludes the final newline accepted by JS's `$`.
	if ((tree.length !== 40 && tree.length !== 64) || !OBJECT_ID.test(tree)) {
		malformed("invalid tree object id");
	}
	const indexPaths = new Set<string>();
	for (let path = record(); path !== ""; path = record()) indexPaths.add(path);
	const conflicts = new Set(indexPaths);
	const describedFiles = new Set<string>();
	const contentPaths = new Set<string>();
	const autoMergedPaths = new Set<string>();
	const hasConflicts = exitCode === 1;
	let conflictRecords = 0;
	let conflictsComplete = true;
	let markerCheckAllowed = true;

	while (offset < stdout.length) {
		const countRecord = record();
		const count = Number(countRecord);
		// path_msg always includes a primary path. Canonical decimal avoids
		// parseInt's prefix acceptance, signs, exponents, whitespace and overflow.
		// Reserve >=2 chars/path and the two final fields BEFORE any count loop.
		if (
			!Number.isSafeInteger(count) ||
			count < 1 ||
			String(count) !== countRecord ||
			count > Math.floor((stdout.length - offset - 3) / 2)
		) {
			malformed("invalid or truncated message path count");
		}
		const paths: string[] = [];
		for (let i = 0; i < count; i++) {
			const path = record();
			if (!path) malformed("empty message path");
			paths.push(path);
		}
		const type = record();
		if (!type) malformed("empty message type");
		record(); // Consume opaque human text, but never retain or return it.
		const counts = MESSAGE_PATH_COUNTS.get(type);
		if (counts && (count < counts[0] || count > counts[1])) {
			malformed("unexpected path count for a known message type");
		}
		if (type === "Auto-merging") {
			autoMergedPaths.add(paths[0] as string);
			continue;
		}
		if (type.startsWith("CONFLICT")) {
			conflictRecords++;
			for (const path of paths) conflicts.add(path);
			if (FILE_CONFLICTS.has(type)) {
				for (const path of paths) describedFiles.add(path);
			} else {
				// Related names may denote directories or even branch names. Keep
				// them for display, never certify them as an exhaustive file list.
				conflictsComplete = false;
			}
			if (type === "CONFLICT (contents)") {
				contentPaths.add(paths[0] as string);
			} else {
				markerCheckAllowed = false;
			}
		} else if (!counts || hasConflicts) {
			// Auto-merging is the only harmless context allowed in a conflicted
			// merge. New non-CONFLICT warnings may hide new structural failures.
			conflictsComplete = false;
			markerCheckAllowed = false;
		}
	}

	if (!hasConflicts && conflicts.size > 0) malformed("conflicts reported with a clean exit status");
	if (hasConflicts) {
		if (!conflictRecords) conflictsComplete = false;
		for (const path of indexPaths) {
			if (!describedFiles.has(path)) conflictsComplete = false;
		}
		for (const path of contentPaths) {
			if (!autoMergedPaths.has(path)) markerCheckAllowed = false;
		}
	}
	return {
		tree,
		conflicts: [...conflicts],
		hasConflicts,
		conflictsComplete,
		conflictMarkersComplete: !hasConflicts && conflictsComplete,
		markerCheckAllowed: hasConflicts && conflictsComplete && markerCheckAllowed,
	};
}
