import type {
	GitStagingFile,
	GitStagingFilesPage,
	GitStagingList,
	GitStagingStatsBuckets,
	GitStagingStatsTotal,
} from "../../../shared/git-staging-lists";
import {
	type GitStatusFilterChar,
	type GitStatusPage,
	type GitStatusPageCacheState,
	type GitStatusPageFile,
	type GitStatusPageSection,
	type GitStatusPageStatsResult,
	type GitStatusPageStatsRow,
	gitStatusMatchesSection,
	normalizeGitStatusFilter,
} from "../../../shared/git-status-page";
import { normalizeExpandedPaths } from "./git-folder-prefs";

export const GIT_CHANGES_ROW_HEIGHT = 30;
export const GIT_CHANGES_OVERSCAN = 6;
export const GIT_CHANGES_MAX_WINDOW = 160;

export interface GitChangesStatsSource {
	snapshotId?: string;
	pageGeneration?: string;
	filterKey: string;
	epoch: string;
	workspaceIdentity?: string;
	workerEpoch?: string;
	memberVersion?: number;
	statsVersion?: number;
	updating?: boolean;
}
export type GitChangesPageStatsResult = GitStatusPageStatsResult & {
	cache?: GitStatusPageCacheState;
	workspaceIdentity?: string;
	filterKey?: string;
};
export interface GitChangesStatsSettlement {
	settled?: boolean;
	failed?: boolean;
	rows?: readonly GitStatusPageStatsRow[];
}
interface StatsMeasurement {
	row: GitStatusPageStatsResult["rows"][number];
	epoch: string;
	failed: boolean;
}
const statsKey = ({ type, section, path }: GitStatusPageStatsRow) =>
	JSON.stringify([type, section, path]);

export interface GitChangesDisplayFile extends GitStatusPageFile {
	displayLinesAdded?: number;
	displayLinesRemoved?: number;
	statsComplete: boolean;
	statsEpoch?: string;
	statsRefreshing?: boolean;
}

interface RowBase {
	key: string;
	section: GitStatusPageSection;
	depth: number;
}
export type GitStagingChangesRow =
	| {
			type: "staging-section";
			key: string;
			list: GitStagingList;
			expanded: boolean;
			stats?: GitStagingStatsTotal;
	  }
	| {
			type: "staging-file";
			key: string;
			listId: string;
			depth: number;
			path: string;
			label: string;
			file: GitStagingFile;
	  }
	| {
			type: "staging-directory";
			key: string;
			listId: string;
			depth: number;
			path: string;
			label: string;
			expanded: boolean;
			fileCount: number;
			stats?: GitStagingStatsTotal;
	  }
	| { type: "staging-loading"; key: string; listId: string; incomplete: boolean };

export type GitChangesRow =
	| GitStagingChangesRow
	| (RowBase & { type: "section"; count: number; total: number })
	| (RowBase & { type: "file"; path: string; label: string; file: GitChangesDisplayFile })
	| (RowBase & {
			type: "directory";
			path: string;
			label: string;
			expanded: boolean;
			fileCount: number;
			added?: number;
			removed?: number;
			statsComplete: boolean;
			statsEpoch?: string;
			statsRefreshing?: boolean;
	  })
	| { type: "staging-tools"; key: string }
	| { type: "loading"; key: string }
	| { type: "empty"; key: string };

export interface GitChangesListConfig {
	stagingToolbar?: boolean;
	stagingOnly?: boolean;
	mode: "tree" | "flat";
	filter: GitStatusFilterChar[];
	expanded: { staged: string[]; unstaged: string[] };
	staging?: {
		observationId?: string;
		generation?: number;
		lists: GitStagingList[];
		expanded: string[];
		folders: Record<string, string[]>;
	};
}
export interface GitChangesListWindow {
	/** Present only after the model has actually accepted a page, including empty pages. */
	snapshotId?: string;
	statsSource?: GitChangesStatsSource;
	statsReady?: boolean;
	statsFailed?: boolean;
	statsRefreshing?: boolean;
	rows: GitChangesRow[];
	start: number;
	totalRows: number;
	loadedFiles: number;
	loadedStaged: number;
	loadedUnstaged: number;
	/** Index displacement of the first visible path after a model update. */
	anchorDelta: number;
}

interface Directory {
	path: string;
	name: string;
	directories: Map<string, Directory>;
	files: GitChangesDisplayFile[];
	fileCount: number;
}
const sections = ["staged", "unstaged"] as const;
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compareNames = (left: string, right: string) => nameCollator.compare(left, right);
function directory(path: string, name: string): Directory {
	return {
		path,
		name,
		directories: new Map(),
		files: [],
		fileCount: 0,
	};
}

/** Only the terminal page claims EOF; preceding pages must form one cursor/version chain. */
export function validateGitStagingPages(pages: readonly GitStagingFilesPage[]): boolean {
	if (!pages.length) return false;
	const first = pages[0];
	const cursors = new Set<string>();
	for (let index = 0; index < pages.length; index++) {
		const page = pages[index];
		if (
			page.listId !== first.listId ||
			page.workspaceKey !== first.workspaceKey ||
			page.snapshotVersion !== first.snapshotVersion
		)
			throw new Error("ChangeList snapshot changed; refresh this list");
		if (page.nextCursor === null) {
			if (index !== pages.length - 1 || !page.complete)
				throw new Error("Git staging page sequence changed");
			return true;
		}
		if (page.complete) throw new Error("Git staging page sequence changed");
		// Cursors include server-owned filter bindings and are deliberately opaque here.
		if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor))
			throw new Error("Git staging page sequence changed");
		cursors.add(page.nextCursor);
	}
	return false;
}

export function gitStagingPagesComplete(pages: readonly GitStagingFilesPage[]): boolean {
	try {
		return validateGitStagingPages(pages);
	} catch {
		return false;
	}
}

function stagingStats(
	buckets: GitStagingStatsBuckets,
	filter: GitStatusFilterChar[],
): GitStagingStatsTotal {
	const total: GitStagingStatsTotal = {
		files: 0,
		added: 0,
		removed: 0,
		binaryFiles: 0,
		gitlinkFiles: 0,
	};
	for (const [status, counts] of Object.entries(buckets)) {
		if (!counts || !gitStatusMatchesSection(`${status} `, "staged", filter)) continue;
		for (const field of ["files", "added", "removed", "binaryFiles", "gitlinkFiles"] as const)
			total[field] += counts[field];
	}
	return total;
}

/** Lives in the browser Worker. Window reads only slice the already-built row index. */
export class GitChangesListModel {
	private files = new Map<string, GitStatusPageFile>();
	private stats = new Map<string, StatsMeasurement>();
	private statsSource: GitChangesStatsSource | undefined;
	private rows: GitChangesRow[] = [];
	private rowIndices = new Map<string, number>();
	private roots = new Map<GitStatusPageSection, Directory>();
	private sectionFiles = new Map<GitStatusPageSection, GitChangesDisplayFile[]>();
	private page: GitStatusPage | undefined;
	private pageCache: GitStatusPageCacheState | undefined;
	private snapshotId: string | undefined;
	private viewportStart = 0;
	private viewportCount = 20;
	private pendingAnchorDelta = 0;
	private stagingPages = new Map<string, GitStagingFilesPage[]>();
	private config: GitChangesListConfig;
	private filterKey: string;

	constructor(
		config: GitChangesListConfig,
		private readonly pageGeneration?: string,
	) {
		this.config = config;
		this.filterKey = normalizeGitStatusFilter(config.filter).join(",");
		if (config.staging) this.rebuild();
	}

	append(pages: readonly GitStatusPage[]) {
		for (const page of pages) {
			if (this.snapshotId && page.snapshotId !== this.snapshotId)
				throw new Error("Git snapshot changed; refresh the file list");
			const cache = (page as GitStatusPage & { cache?: GitStatusPageCacheState }).cache;
			if (
				this.pageCache &&
				(!cache ||
					cache.workerEpoch !== this.pageCache.workerEpoch ||
					cache.memberVersion !== this.pageCache.memberVersion)
			)
				throw new Error("Git membership changed; refresh the file list");
			this.pageCache = cache;
			this.snapshotId = page.snapshotId;
			for (const file of page.files) this.files.set(file.path, file);
			this.page = page;
		}
		this.rebuild();
	}

	appendStaging(listId: string, pages: readonly GitStagingFilesPage[], offset = 0) {
		const list = this.config.staging?.lists.find((entry) => entry.id === listId);
		if (!list) return;
		if (
			pages.some(
				(page) =>
					page.listId !== listId ||
					page.snapshotVersion !== list.snapshotVersion ||
					page.snapshotVersion !== pages[0]?.snapshotVersion,
			)
		)
			throw new Error("ChangeList snapshot changed; refresh this list");
		const previous = this.stagingPages.get(listId) ?? [];
		if (!Number.isInteger(offset) || offset < 0 || offset > previous.length)
			throw new Error("Git staging page sequence changed");
		if (offset > 0 && pages.some((page) => page.snapshotVersion !== previous[0]?.snapshotVersion))
			throw new Error("ChangeList snapshot changed; refresh this list");
		const next = [...previous.slice(0, offset), ...pages];
		validateGitStagingPages(next);
		this.stagingPages.set(listId, next);
		this.rebuild();
	}

	configure(config: GitChangesListConfig) {
		for (const [id] of this.stagingPages) {
			const next = config.staging?.lists.find((list) => list.id === id);
			const previous = this.config.staging?.lists.find((list) => list.id === id);
			if (!next || next.snapshotVersion !== previous?.snapshotVersion) this.stagingPages.delete(id);
		}
		this.config = config;
		this.filterKey = normalizeGitStatusFilter(config.filter).join(",");
		this.rebuild();
	}

	setStatsSource(source: GitChangesStatsSource) {
		if (
			(source.pageGeneration !== undefined &&
				this.pageGeneration !== undefined &&
				source.pageGeneration !== this.pageGeneration) ||
			source.snapshotId !== this.snapshotId ||
			source.filterKey !== this.filterKey ||
			(this.pageCache &&
				(source.workerEpoch !== this.pageCache.workerEpoch ||
					source.memberVersion !== this.pageCache.memberVersion))
		)
			return;
		const previousSource = this.statsSource;
		if (
			previousSource?.epoch === source.epoch &&
			previousSource.snapshotId === source.snapshotId &&
			previousSource.pageGeneration === source.pageGeneration &&
			previousSource.filterKey === source.filterKey &&
			previousSource.workspaceIdentity === source.workspaceIdentity &&
			previousSource.workerEpoch === source.workerEpoch &&
			previousSource.memberVersion === source.memberVersion &&
			previousSource.statsVersion === source.statsVersion &&
			previousSource.updating === source.updating
		)
			return;
		const previous = [...this.stats.values()];
		// Keep one measurement per identity. Its original epoch makes the old value
		// display-only; it never becomes a measurement of the new observation.
		if (
			!previousSource ||
			previousSource.snapshotId !== source.snapshotId ||
			previousSource.pageGeneration !== source.pageGeneration ||
			previousSource.filterKey !== source.filterKey ||
			previousSource.workspaceIdentity !== source.workspaceIdentity ||
			previousSource.workerEpoch !== source.workerEpoch ||
			previousSource.memberVersion !== source.memberVersion
		)
			this.stats.clear();
		this.statsSource = source;
		for (const { row } of previous) this.patchStatsRow(row);
	}

	mergePageStats(
		source: GitChangesStatsSource,
		result?: GitChangesPageStatsResult,
		options?: GitChangesStatsSettlement,
	) {
		if (
			!this.statsSource ||
			source.epoch !== this.statsSource.epoch ||
			source.snapshotId !== this.statsSource.snapshotId ||
			source.pageGeneration !== this.statsSource.pageGeneration ||
			source.filterKey !== this.statsSource.filterKey ||
			source.workspaceIdentity !== this.statsSource.workspaceIdentity ||
			source.workerEpoch !== this.statsSource.workerEpoch ||
			source.memberVersion !== this.statsSource.memberVersion ||
			source.statsVersion !== this.statsSource.statsVersion ||
			(result &&
				source.workerEpoch !== undefined &&
				(result.cache?.workerEpoch !== source.workerEpoch ||
					result.cache?.memberVersion !== source.memberVersion ||
					result.cache?.statsVersion !== source.statsVersion ||
					result.workspaceIdentity !== source.workspaceIdentity ||
					result.filterKey !== source.filterKey)) ||
			source.snapshotId !== this.snapshotId ||
			source.filterKey !== this.filterKey ||
			(result && result.snapshotId !== source.snapshotId)
		)
			return;
		const failed = options?.settled === true && options.failed === true;
		const rows = failed
			? (options?.rows ?? []).map(({ type, section, path }) => ({
					type,
					section,
					path,
					complete: false,
				}))
			: (result?.rows ?? []);
		for (const row of rows) {
			this.stats.set(statsKey(row), { row, epoch: source.epoch, failed });
			this.patchStatsRow(row);
		}
	}

	/** Measurements change only their indexed rows; scrolling never rebuilds the file tree. */
	private patchStatsRow(identity: GitStatusPageStatsRow) {
		const index = this.rowIndices.get(`${identity.section}:${identity.type}:${identity.path}`);
		if (index === undefined) return;
		const row = this.rows[index];
		if (row.type === "file") {
			this.rows[index] = { ...row, file: this.displayFile(row.file, row.section) };
		} else if (row.type === "directory") {
			this.rows[index] = { ...row, ...this.displayStats(identity) };
		}
	}

	private displayStats(identity: GitStatusPageStatsRow) {
		const measurement =
			this.statsSource &&
			this.statsSource.snapshotId === this.snapshotId &&
			this.statsSource.filterKey === this.filterKey
				? this.stats.get(statsKey(identity))
				: undefined;
		const stats = measurement?.row;
		const complete =
			stats?.complete === true &&
			typeof stats.added === "number" &&
			Number.isFinite(stats.added) &&
			typeof stats.removed === "number" &&
			Number.isFinite(stats.removed);
		return {
			added: complete ? stats.added : undefined,
			removed: complete ? stats.removed : undefined,
			statsComplete: complete,
			statsEpoch: measurement?.epoch,
			statsRefreshing:
				this.statsSource?.updating === true ||
				!measurement ||
				measurement.epoch !== this.statsSource?.epoch,
		};
	}

	private displayFile(file: GitStatusPageFile, section: GitStatusPageSection) {
		const stats = this.displayStats({ type: "file", section, path: file.path });
		return {
			...file,
			displayLinesAdded: stats.added,
			displayLinesRemoved: stats.removed,
			statsComplete: stats.statsComplete,
			statsEpoch: stats.statsEpoch,
			statsRefreshing: stats.statsRefreshing,
		};
	}

	private rebuild() {
		const oldIndex = this.viewportStart;
		const anchor = this.rows[oldIndex];
		this.rows = [];
		this.rowIndices.clear();
		this.roots.clear();
		this.sectionFiles.clear();
		if (this.config.stagingToolbar) this.rows.push({ type: "staging-tools", key: "staging:tools" });
		this.buildStagingRows();
		for (const section of this.config.stagingOnly ? [] : sections) {
			const files: GitChangesDisplayFile[] = [];
			for (const file of this.files.values()) {
				if (gitStatusMatchesSection(file.status, section, this.config.filter))
					files.push(this.displayFile(file, section));
			}
			if (this.config.mode === "tree") files.sort((a, b) => compareNames(a.path, b.path));
			this.sectionFiles.set(section, files);
			const count =
				this.page?.counts[section === "staged" ? "filteredStaged" : "filteredUnstaged"] ??
				files.length;
			const total =
				section === "staged"
					? (this.page?.counts.staged ?? count)
					: this.page
						? this.page.counts.unstaged + this.page.counts.untracked
						: count;
			if (count === 0 && files.length === 0) continue;
			this.rows.push({
				type: "section",
				key: `${section}:section`,
				section,
				depth: 0,
				count,
				total,
			});
			if (this.config.mode === "flat") {
				for (const file of files) this.pushFile(file, section, 0, file.path);
				continue;
			}
			const root = directory("", "");
			this.roots.set(section, root);
			for (const file of files) {
				// Git paths use '/'. Backslashes, spaces, newlines and Unicode remain literal identity.
				const segments = file.path.split("/");
				segments.pop();
				let parent = root;
				parent.fileCount++;
				for (const segment of segments) {
					const path = parent.path ? `${parent.path}/${segment}` : segment;
					let node = parent.directories.get(segment);
					if (!node) {
						node = directory(path, segment);
						parent.directories.set(segment, node);
					}
					node.fileCount++;
					parent = node;
				}
				parent.files.push(file);
			}
			this.flatten(root, section, 0, normalizeExpandedPaths(this.config.expanded[section]));
		}
		if (!this.config.stagingOnly && (this.page?.hasMore || !this.page))
			this.rows.push({ type: "loading", key: "loading" });
		if (this.rows.length === (this.config.stagingToolbar ? 1 : 0))
			this.rows.push({ type: "empty", key: "empty" });
		for (let index = 0; index < this.rows.length; index++) {
			this.rowIndices.set(this.rows[index].key, index);
		}
		let next = anchor ? this.rowIndices.get(anchor.key) : undefined;
		// A formerly visible ancestor can become part of a compact directory row.
		if (next == null && (anchor?.type === "directory" || anchor?.type === "staging-directory")) {
			const prefix = `${anchor.path}/`;
			const compacted = this.rows.findIndex((row) => {
				if (row.type === "directory" && anchor.type === "directory")
					return row.section === anchor.section && row.path.startsWith(prefix);
				if (row.type === "staging-directory" && anchor.type === "staging-directory")
					return row.listId === anchor.listId && row.path.startsWith(prefix);
				return false;
			});
			if (compacted >= 0) next = compacted;
		}
		// A collapse can hide the anchor file; keep its nearest visible parent in view.
		if (next == null && anchor && "path" in anchor) {
			let path = anchor.path;
			while (next == null && path.includes("/")) {
				path = path.slice(0, path.lastIndexOf("/"));
				next = this.rowIndices.get(
					"listId" in anchor
						? `staging:${anchor.listId}:directory:${path}`
						: `${anchor.section}:directory:${path}`,
				);
			}
		}
		if (next == null && anchor && "listId" in anchor)
			next = this.rowIndices.get(`staging:${anchor.listId}:section`);
		this.viewportStart = Math.max(0, Math.min(next ?? oldIndex, this.rows.length - 1));
		this.pendingAnchorDelta += this.viewportStart - oldIndex;
	}

	private buildStagingRows() {
		const staging = this.config.staging;
		if (!staging) return;
		for (const list of staging.lists) {
			const prefix = `staging:${list.id}`;
			const expanded = staging.expanded.includes(list.id);
			const pages = this.stagingPages.get(list.id) ?? [];
			const totals = list.stats
				? stagingStats(list.stats, this.config.filter)
				: pages[0]?.stats?.complete
					? stagingStats(pages[0].stats.total, this.config.filter)
					: undefined;
			this.rows.push({
				type: "staging-section",
				key: `${prefix}:section`,
				list,
				expanded,
				stats: totals,
			});
			if (!expanded) continue;
			const directoryStats = new Map<string, GitStagingStatsTotal>();
			const files = new Map<string, GitStagingFile>();
			for (const page of pages) {
				for (const entry of page.stats?.directories ?? [])
					directoryStats.set(entry.path, stagingStats(entry.byStatus, this.config.filter));
				for (const file of page.files) files.set(file.path, file);
			}
			const matches = (file: GitStagingFile) =>
				gitStatusMatchesSection(`${file.status[0] ?? "M"} `, "staged", this.config.filter);
			const pushFile = (file: GitStagingFile, depth: number, label: string) =>
				this.rows.push({
					type: "staging-file",
					key: `${prefix}:file:${file.path}`,
					listId: list.id,
					depth,
					path: file.path,
					label,
					file,
				});
			if (this.config.mode === "flat") {
				for (const file of files.values()) if (matches(file)) pushFile(file, 1, file.path);
			} else {
				interface Node {
					path: string;
					name: string;
					children: Map<string, Node>;
					files: GitStagingFile[];
					count: number;
				}
				const node = (path: string, name: string): Node => ({
					path,
					name,
					children: new Map(),
					files: [],
					count: 0,
				});
				const root = node("", "");
				for (const file of files.values()) {
					let parent = root;
					parent.count++;
					for (const part of file.path.split("/").slice(0, -1)) {
						let child = parent.children.get(part);
						if (!child) {
							child = node(parent.path ? `${parent.path}/${part}` : part, part);
							parent.children.set(part, child);
						}
						child.count++;
						parent = child;
					}
					parent.files.push(file);
				}
				const folders = normalizeExpandedPaths(staging.folders[list.id] ?? []);
				const flatten = (parent: Node, depth: number) => {
					for (let child of [...parent.children.values()].sort((a, b) =>
						compareNames(a.name, b.name),
					)) {
						if (directoryStats.get(child.path)?.files === 0) continue;
						let label = child.name;
						while (!child.files.length && child.children.size === 1) {
							const nested = child.children.values().next().value;
							if (
								!nested ||
								folders.has(child.path) !== folders.has(nested.path) ||
								directoryStats.get(child.path)?.files !== directoryStats.get(nested.path)?.files
							)
								break;
							label += `/${nested.name}`;
							child = nested;
						}
						const open = folders.has(child.path);
						this.rows.push({
							type: "staging-directory",
							key: `${prefix}:directory:${child.path}`,
							listId: list.id,
							depth,
							path: child.path,
							label,
							expanded: open,
							fileCount: directoryStats.get(child.path)?.files ?? child.count,
							stats: directoryStats.get(child.path),
						});
						if (open) flatten(child, depth + 1);
					}
					for (const file of parent.files.sort((a, b) => compareNames(a.path, b.path)))
						if (matches(file))
							pushFile(file, depth, file.path.slice(file.path.lastIndexOf("/") + 1));
				};
				flatten(root, 1);
			}
			const last = pages.at(-1);
			if (!gitStagingPagesComplete(pages))
				this.rows.push({
					type: "staging-loading",
					key: `${prefix}:loading`,
					listId: list.id,
					incomplete: !!last && last.nextCursor === null && !last.complete,
				});
		}
	}

	private pushFile(
		file: GitChangesDisplayFile,
		section: GitStatusPageSection,
		depth: number,
		label: string,
	) {
		this.rows.push({
			type: "file",
			key: `${section}:file:${file.path}`,
			section,
			depth,
			path: file.path,
			label,
			file,
		});
	}

	private flatten(
		parent: Directory,
		section: GitStatusPageSection,
		depth: number,
		expanded: Set<string>,
	) {
		const directories = [...parent.directories.values()].sort((a, b) =>
			compareNames(a.name, b.name),
		);
		for (let node of directories) {
			let label = node.name;
			while (node.files.length === 0 && node.directories.size === 1) {
				const child = node.directories.values().next().value;
				if (!child || expanded.has(node.path) !== expanded.has(child.path)) break;
				label += `/${child.name}`;
				node = child;
			}
			const open = expanded.has(node.path);
			this.rows.push({
				type: "directory",
				key: `${section}:directory:${node.path}`,
				section,
				depth,
				path: node.path,
				label,
				expanded: open,
				fileCount: node.fileCount,
				...this.displayStats({ type: "directory", section, path: node.path }),
			});
			if (open) this.flatten(node, section, depth + 1, expanded);
		}
		for (const file of parent.files.sort((a, b) => compareNames(a.path, b.path))) {
			this.pushFile(file, section, depth, file.path.slice(file.path.lastIndexOf("/") + 1));
		}
	}

	get isComplete() {
		return this.page?.complete === true && !this.page.hasMore && this.page.expiresAt > Date.now();
	}

	/** Explicit actions only: never transfer descendant paths on scroll/window reads. */
	scope(section: GitStatusPageSection, path?: string): string[] {
		if (!this.isComplete) throw new Error("Git file range is not completely loaded");
		const files = this.sectionFiles.get(section) ?? [];
		if (path == null) return files.map((file) => file.path);
		const prefix = `${path}/`;
		return files.filter((file) => file.path.startsWith(prefix)).map((file) => file.path);
	}

	private visibleRows() {
		return this.rows.slice(
			Math.max(0, this.viewportStart - GIT_CHANGES_OVERSCAN),
			Math.min(this.rows.length, this.viewportStart + this.viewportCount + GIT_CHANGES_OVERSCAN),
		);
	}

	window(start = this.viewportStart, count = this.viewportCount): GitChangesListWindow {
		this.viewportCount = Math.max(
			1,
			Math.min(Math.ceil(count), GIT_CHANGES_MAX_WINDOW - 2 * GIT_CHANGES_OVERSCAN),
		);
		this.viewportStart = Math.max(
			0,
			Math.min(Math.floor(start), Math.max(0, this.rows.length - this.viewportCount)),
		);
		const rows = this.visibleRows();
		const measurements = rows.flatMap((row) =>
			row.type === "file" || row.type === "directory" ? [this.stats.get(statsKey(row))] : [],
		);
		const sourceValid =
			this.statsSource?.snapshotId === this.snapshotId &&
			this.statsSource?.filterKey === this.filterKey;
		const statsReady =
			!!this.snapshotId &&
			measurements.every(
				(measurement) =>
					sourceValid && !!measurement && measurement.epoch === this.statsSource?.epoch,
			);
		const anchorDelta = this.pendingAnchorDelta;
		this.pendingAnchorDelta = 0;
		return {
			snapshotId: this.config.stagingOnly ? this.config.staging?.observationId : this.snapshotId,
			statsSource: this.statsSource,
			statsReady: this.config.stagingOnly ? true : statsReady,
			statsFailed: measurements.some(
				(measurement) => measurement?.epoch === this.statsSource?.epoch && measurement?.failed,
			),
			statsRefreshing:
				!this.config.stagingOnly && (!statsReady || this.statsSource?.updating === true),
			rows,
			start: Math.max(0, this.viewportStart - GIT_CHANGES_OVERSCAN),
			totalRows: this.rows.length,
			loadedFiles: this.files.size,
			loadedStaged: this.sectionFiles.get("staged")?.length ?? 0,
			loadedUnstaged: this.sectionFiles.get("unstaged")?.length ?? 0,
			anchorDelta,
		};
	}
}
