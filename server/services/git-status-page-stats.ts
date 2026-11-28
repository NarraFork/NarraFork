import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPageFile,
	type GitStatusPageStatsQuery,
	type GitStatusPageStatsResult,
	gitStatusBadgeChar,
	gitStatusMatchesSection,
	isGitStatusFilterChar,
} from "../../shared/git-status-page";
import { GitStatusPageError } from "./git-status-page-protocol";

interface Measurement {
	added?: number;
	removed?: number;
	complete: boolean;
}

export interface GitStatusPageStatsIndex {
	files: Map<string, Measurement>;
	directories: Map<string, Measurement>;
	/** Per-section status buckets are built once, independent of actor/filter projections. */
	buckets: Map<string, Measurement>;
	badges: Map<string, GitStatusFilterChar>;
	bytes: number;
}

export function validateGitStatusPageStatsQuery(query: GitStatusPageStatsQuery): void {
	if (
		!query ||
		typeof query.snapshotId !== "string" ||
		query.snapshotId.length === 0 ||
		query.snapshotId.length > 128 ||
		(query.filter !== undefined &&
			(!Array.isArray(query.filter) ||
				query.filter.length > 6 ||
				!query.filter.every(isGitStatusFilterChar))) ||
		!Array.isArray(query.rows) ||
		query.rows.length === 0 ||
		query.rows.length > GIT_STATUS_PAGE_MAX_LIMIT ||
		query.rows.some(
			(row) =>
				!row ||
				(row.type !== "file" && row.type !== "directory") ||
				(row.section !== "staged" && row.section !== "unstaged") ||
				typeof row.path !== "string" ||
				row.path.length === 0 ||
				row.path.length > 4096,
		) ||
		Buffer.byteLength(JSON.stringify(query.rows)) > GIT_STATUS_PAGE_MAX_BYTES
	)
		throw new GitStatusPageError("GIT_STATUS_PAGE_INVALID_QUERY");
}

const validNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Build once per measurement, entirely in the Worker; later viewports are map lookups. */
export function buildGitStatusPageStatsIndex(
	files: readonly GitStatusPageFile[],
	filter: readonly GitStatusFilterChar[],
	statusComplete: boolean,
	stats: GitLineStats,
	maxBytes: number,
): GitStatusPageStatsIndex {
	const measured = new Map(stats.files.map((file) => [file.path, file]));
	const index: GitStatusPageStatsIndex = {
		files: new Map(),
		directories: new Map(),
		buckets: new Map(),
		badges: new Map(),
		bytes: 256,
	};
	const reserve = (key: string) => {
		// Retained string, map entry, measurement and allocator overhead, within the snapshot budget.
		index.bytes += key.length * 2 + 192;
		if (index.bytes > maxBytes)
			throw new GitStatusPageError("GIT_STATUS_PAGE_BUSY", "Git statistics exceed cache budget");
	};
	for (const file of files) {
		const measurement = measured.get(file.path);
		for (const section of ["staged", "unstaged"] as const) {
			if (!gitStatusMatchesSection(file.status, section, filter)) continue;
			const added = measurement
				? measurement[section === "staged" ? "stagedLinesAdded" : "unstagedLinesAdded"]
				: undefined;
			const removed = measurement
				? measurement[section === "staged" ? "stagedLinesRemoved" : "unstagedLinesRemoved"]
				: undefined;
			const valid = validNumber(added) && validNumber(removed);
			const value: Measurement = {
				...(validNumber(added) ? { added } : {}),
				...(validNumber(removed) ? { removed } : {}),
				complete: valid && measurement?.complete === true,
			};
			const fileKey = `${section}:${file.path}`;
			reserve(fileKey);
			index.files.set(fileKey, value);
			const badge = gitStatusBadgeChar(file.status, section);
			index.badges.set(fileKey, badge);
			reserve(fileKey);
			// Use actual status paths, including every ancestor of compressed directory rows.
			for (
				let slash = file.path.indexOf("/");
				slash >= 0;
				slash = file.path.indexOf("/", slash + 1)
			) {
				const key = `${section}:${file.path.slice(0, slash)}`;
				let directory = index.directories.get(key);
				if (!directory) {
					reserve(key);
					directory = { added: 0, removed: 0, complete: statusComplete };
					index.directories.set(key, directory);
				}
				directory.complete &&= value.complete;
				if (directory.complete) {
					directory.added = (directory.added ?? 0) + (value.added ?? 0);
					directory.removed = (directory.removed ?? 0) + (value.removed ?? 0);
					if (!validNumber(directory.added) || !validNumber(directory.removed))
						directory.complete = false;
				}
				if (!directory.complete) {
					directory.added = undefined;
					directory.removed = undefined;
				}
				const bucketKey = `${section}:${badge}:${file.path.slice(0, slash)}`;
				let bucket = index.buckets.get(bucketKey);
				if (!bucket) {
					reserve(bucketKey);
					bucket = { added: 0, removed: 0, complete: statusComplete };
					index.buckets.set(bucketKey, bucket);
				}
				bucket.complete &&= value.complete;
				if (bucket.complete) {
					bucket.added = (bucket.added ?? 0) + (value.added ?? 0);
					bucket.removed = (bucket.removed ?? 0) + (value.removed ?? 0);
					bucket.complete &&= validNumber(bucket.added) && validNumber(bucket.removed);
				}
				if (!bucket.complete) {
					bucket.added = undefined;
					bucket.removed = undefined;
				}
			}
		}
	}
	return index;
}

export function projectGitStatusPageStats(
	query: GitStatusPageStatsQuery,
	index: GitStatusPageStatsIndex,
): GitStatusPageStatsResult {
	const result: GitStatusPageStatsResult = {
		snapshotId: query.snapshotId,
		rows: query.rows.map((row) => {
			const key = `${row.section}:${row.path}`;
			let value = (row.type === "file" ? index.files : index.directories).get(key);
			if (query.filter?.length) {
				if (row.type === "file") {
					const badge = index.badges.get(key);
					if (!badge || !query.filter.includes(badge)) value = undefined;
				} else {
					const buckets = [...new Set(query.filter)].flatMap((badge) => {
						const bucket = index.buckets.get(`${row.section}:${badge}:${row.path}`);
						return bucket ? [bucket] : [];
					});
					const complete = buckets.length > 0 && buckets.every((bucket) => bucket.complete);
					const added = buckets.reduce((sum, bucket) => sum + (bucket.added ?? 0), 0);
					const removed = buckets.reduce((sum, bucket) => sum + (bucket.removed ?? 0), 0);
					value =
						complete && validNumber(added) && validNumber(removed)
							? { added, removed, complete: true }
							: { complete: false };
				}
			}
			return {
				type: row.type,
				section: row.section,
				path: row.path,
				...(value ?? { complete: false }),
			};
		}),
	};
	if (Buffer.byteLength(JSON.stringify(result)) > GIT_STATUS_PAGE_MAX_BYTES)
		throw new GitStatusPageError("GIT_STATUS_PAGE_RECORD_TOO_LARGE");
	return result;
}
