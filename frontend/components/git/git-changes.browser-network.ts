import type {
	GitStagingAction,
	GitStagingDiff,
	GitStagingFile,
	GitStagingStatsBuckets,
	GitStagingUnit,
} from "../../../shared/git-staging-lists";
import {
	GIT_STATUS_FILTER_CHARS,
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPageCacheState,
	type GitStatusPageCounts,
	type GitStatusPageFile,
	type GitStatusPageResult,
	type GitStatusPageStatsResponse,
	type GitStatusPageStatsRow,
	gitStatusMatchesSection,
	normalizeGitStatusFilter,
} from "../../../shared/git-status-page";
import type { GitStagingObservationState } from "../../../shared/git-workspace-events";
import { parseUnifiedDiff } from "../../../shared/pretext-layout/parse-unified-diff";

export type GitBrowserBlockScenario =
	| "mapped"
	| "geometry"
	| "source-active"
	| "large"
	| "truncated"
	| "missing"
	| "structural";

export const GIT_BROWSER_STAGING_PATHS = [
	"remote-executor/internal/handlers/git_line_stats.go",
	"remoteexecutor/internal/handlers/git_line_stats.go",
	"服务端/变更分组/处理程序/文件归属统计.go",
	"src/short.ts",
] as const;

export interface GitBrowserRequest {
	id: number;
	workspace: string;
	revision: number;
	filter: string;
	offset: number;
	count: number;
	snapshotId: string;
	aborted: boolean;
	expired: boolean;
	settled: boolean;
	startedAt: number;
	settledAt: number | null;
}

export interface GitBrowserStatsRequest {
	id: number;
	aborted: boolean;
	settled: boolean;
	workspace: string;
	snapshotId: string;
	filter: string;
	rows: GitStatusPageStatsRow[];
	startedAt: number;
	settledAt: number | null;
}

/** Deterministic nonzero measurements, independent from status-page position. */
export function gitBrowserFileStats(path: string) {
	const match = /\/file-(\d+)\.ts$/.exec(path);
	if (!match) throw new Error(`Unknown browser fixture file: ${path}`);
	const index = Number(match[1]);
	return { added: (index % 7) + 1, removed: (index % 5) + 1 };
}

interface Snapshot {
	workspace: string;
	revision: number;
	expiresAt: number;
	filter: GitStatusFilterChar[];
	files: GitStatusPageFile[];
	filesByPath: Map<string, GitStatusPageFile>;
	counts: GitStatusPageCounts;
}

interface Gate {
	record: GitBrowserRequest;
	release: () => void;
}

/** The transport boundary is synthetic; the API, query hook and module Worker stay real. */
export function createGitBrowserNetwork(
	total: number,
	options: {
		directorySize?: number;
		branchingDirectories?: boolean;
		staging?: boolean;
		stagingPaths?: boolean;
		blockMove?: GitBrowserBlockScenario;
	} = {},
) {
	const nativeFetch = window.fetch.bind(window);
	const contentVersions = new Map<string, number>();
	let observationTransport: {
		observation: GitStagingObservationState;
		requests: string[];
		messages: Array<{ workspaceKey: string; status: string; sequence: number; generation: number }>;
		subscriptions: number;
	} | null = null;
	async function observationControl(
		command: string,
		parameters: {
			workspaceKey?: string;
			status?: GitStagingObservationState["status"];
			generation?: number;
			observationId?: string;
			affectedListIds?: string[];
			overrides?: Partial<GitStagingObservationState>;
		} = {},
	) {
		const response = await nativeFetch("/__git-observation-fixture", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fixtureId: new URLSearchParams(location.search).get("fixtureId"),
				command,
				...parameters,
			}),
		});
		if (!response.ok) throw new Error(`Observation fixture control failed (${response.status})`);
		observationTransport = await response.json();
		return observationTransport;
	}
	const requests: GitBrowserRequest[] = [];
	const statsRequests: GitBrowserStatsRequest[] = [];
	const directoryStats = new Map<string, { added: number; removed: number; complete: boolean }>();
	const unexpected: string[] = [];
	const snapshots = new Map<string, Snapshot>();
	const sources = new Map<string, GitStatusPageFile[]>();
	const gates = new Map<number, Gate>();
	const statsGates = new Map<number, () => void>();
	const totals = new Map([[0, total]]);
	const denied = new Map<"page" | "stats", number>();
	const mutations: string[] = [];
	let revision = 0;
	let publishedStats = 1;
	const cacheState = (member = revision): GitStatusPageCacheState => ({
		status: "ready",
		workerEpoch: "browser-fixture",
		memberVersion: member + 1,
		statsVersion: publishedStats,
		updating: false,
	});
	let nextSnapshot = 0;
	let nextRequest = 0;
	let nextStatsRequest = 0;
	let holdNext = false;
	let holdFirst = false;
	let holdStats = false;
	let expireNextCursor = false;
	let expireNextPage = false;
	const stagingReads: string[] = [];
	const stagingSummaryReads: Array<{ generation: number; settled: boolean }> = [];
	let holdSummary = false;
	let releaseSummary: (() => void) | null = null;
	const stagingActions: GitStagingAction[] = [];
	const stagingActionRequests: GitStagingAction[] = [];
	const stagingDiffReads: Array<{
		listId: string;
		status: number;
		generation: number;
		units: GitStagingUnit[];
		unitMappings: GitStagingDiff["unitMappings"];
		rows: number;
		hunks: number;
	}> = [];
	let stagingFailure: 409 | 500 | null = null;
	let holdStagingAction = false;
	let releaseStagingAction: (() => void) | null = null;
	let holdStagingSync = false;
	let releaseStagingSync: (() => void) | null = null;
	let stagingGeneration = 1;
	let stagingLists = options.staging
		? [
				{ id: "A", name: "Feature changes", snapshotVersion: "fixture-v1" },
				{
					id: "B",
					name: "Additional changes with a very long ChangeList name",
					snapshotVersion: "fixture-v1",
				},
			]
		: [];
	const stagingFiles: GitStagingFile[] = [
		{
			fileId: "f1",
			unitCount: 2,
			needsReviewCount: 0,
			path: `src/${"long-file-name-".repeat(12)}.ts`,
			status: "M",
			stats: { kind: "text", added: 17, removed: 9 },
		},
		{
			fileId: "f2",
			unitCount: 1,
			needsReviewCount: 0,
			path: "src/image.bin",
			status: "A",
			stats: { kind: "binary" },
		},
		{
			fileId: "f3",
			unitCount: 1,
			needsReviewCount: 0,
			path: "src/vendor",
			status: "M",
			stats: { kind: "gitlink" },
		},
	];

	if (options.stagingPaths)
		stagingFiles.splice(
			0,
			stagingFiles.length,
			...GIT_BROWSER_STAGING_PATHS.map((path, index) => ({
				fileId: `path-${index}`,
				path,
				...(index === 2 ? { oldPath: "旧目录/原文件名.go" } : {}),
				status: index === 2 ? "R" : "M",
				unitCount: 1,
				needsReviewCount: 0,
				stats: { kind: "text" as const, added: 17, removed: 9 },
			})),
		);

	let stagingActive = "A";
	const stagingUnits: GitStagingUnit[] = stagingFiles.map((file, index) => ({
		id: `a-${index}`,
		fileId: file.fileId,
		path: file.path,
		kind: file.stats.kind === "text" ? "text" : file.stats.kind,
		listId: "A",
		baseStart: 0,
		baseEnd: 9,
		workStart: 0,
		workEnd: 17,
		added: file.stats.kind === "text" ? 17 : 0,
		removed: file.stats.kind === "text" ? 9 : 0,
		needsReview: false,
	}));
	stagingUnits.push({
		...stagingUnits[0],
		id: "b-0",
		listId: "B",
		baseStart: 30,
		baseEnd: 32,
		workStart: 30,
		workEnd: 35,
		added: 5,
		removed: 2,
	});
	const blockEdits = new Map<string, { start: number; end: number; replacement: string[] }>();
	const blockPrelude = options.blockMove === "large" ? 0 : 80;
	const blockBase =
		options.blockMove === "geometry"
			? [
					"context-before",
					"old-multi-one",
					"old-multi-two",
					"context-between",
					"remove-one",
					"remove-two",
					"",
					" ",
					"\t",
					`const wrapped = '${"wrapped-content ".repeat(32)}';`,
					"context-end",
				]
			: options.blockMove === "large"
				? Array.from({ length: 801 }, (_, index) => `const original_${index} = ${index};`)
				: [
						...Array.from(
							{ length: blockPrelude },
							(_, index) => `const before_${index} = ${index};`,
						),
						"before",
						"old-one",
						"between-one",
						"old-two",
						"between-two",
						"delete-only",
						"between-three",
						"last-old",
						"end",
						...Array.from({ length: 80 }, (_, index) => `const after_${index} = ${index};`),
					];
	if (options.blockMove) {
		stagingActive = options.blockMove === "source-active" ? "A" : "B";
		stagingLists = [
			{ id: "A", name: "Feature changes", snapshotVersion: "fixture-v1" },
			{ id: "B", name: "Active changes", snapshotVersion: "fixture-v1" },
			{ id: "C", name: "Later changes", snapshotVersion: "fixture-v1" },
		];
		stagingFiles.splice(0, stagingFiles.length, {
			fileId: "block-file",
			path: "src/blocks.ts",
			status: "M",
			unitCount: 4,
			needsReviewCount: 0,
			stats: { kind: "text", added: 4, removed: 4 },
		});
		stagingUnits.splice(0);
		const edits =
			options.blockMove === "geometry"
				? [
						{ start: 1, end: 3, replacement: ["new-multi-one", "new-multi-two"] },
						{ start: 3, end: 3, replacement: ["adjacent-add-one"] },
						{ start: 4, end: 5, replacement: [] },
						{ start: 5, end: 6, replacement: [] },
					]
				: options.blockMove === "large"
					? Array.from({ length: 400 }, (_, index) => ({
							start: index * 2 + 1,
							end: index * 2 + 2,
							replacement: [`const changed_${index} = ${index + 1};`],
						}))
					: [
							{ start: blockPrelude + 1, end: blockPrelude + 2, replacement: ["new-one"] },
							{
								start: blockPrelude + 3,
								end: blockPrelude + 4,
								replacement: ["new-two-a", "new-two-b"],
							},
							{ start: blockPrelude + 5, end: blockPrelude + 6, replacement: [] },
							{ start: blockPrelude + 7, end: blockPrelude + 8, replacement: ["last-new"] },
						];
		let delta = 0;
		for (const [index, edit] of edits.entries()) {
			const id = `block-${index}`;
			blockEdits.set(id, edit);
			stagingUnits.push({
				id,
				fileId: "block-file",
				path: "src/blocks.ts",
				listId: "A",
				kind: "text",
				baseStart: edit.start,
				baseEnd: edit.end,
				workStart: edit.start + delta,
				workEnd: edit.start + delta + edit.replacement.length,
				added: edit.replacement.length,
				removed: edit.end - edit.start,
				needsReview: false,
			});
			delta += edit.replacement.length - (edit.end - edit.start);
		}
		if (options.blockMove === "structural")
			stagingUnits.splice(0, stagingUnits.length, {
				id: "block-mode",
				fileId: "block-file",
				path: "src/blocks.ts",
				listId: "A",
				kind: "mode",
				baseStart: 0,
				baseEnd: 0,
				workStart: 0,
				workEnd: 0,
				added: 0,
				removed: 0,
				needsReview: false,
			});
	}
	function blockDiff(listId: string, units: GitStagingUnit[]): GitStagingDiff {
		const rows: string[] = [];
		const unitMappings: NonNullable<GitStagingDiff["unitMappings"]> = [];
		const byStart = new Map(units.map((unit) => [unit.baseStart, unit]));
		let projected = blockBase.length;
		for (let index = 0; index < blockBase.length; ) {
			const unit = byStart.get(index);
			const edit = unit ? blockEdits.get(unit.id) : undefined;
			if (!unit || !edit) {
				rows.push(` ${blockBase[index++]}`);
				continue;
			}
			byStart.delete(index);
			const start = rows.length;
			rows.push(...blockBase.slice(edit.start, edit.end).map((line) => `-${line}`));
			rows.push(...edit.replacement.map((line) => `+${line}`));
			unitMappings.push({ unitId: unit.id, lineRanges: [{ start, end: rows.length }] });
			projected += edit.replacement.length - (edit.end - edit.start);
			index = edit.end;
		}
		const diff =
			options.blockMove === "structural"
				? "diff --git a/src/blocks.ts b/src/blocks.ts\nold mode 100644\nnew mode 100755\n"
				: [
						"diff --git a/src/blocks.ts b/src/blocks.ts",
						"--- a/src/blocks.ts",
						"+++ b/src/blocks.ts",
						`@@ -1,${blockBase.length} +1,${projected} @@`,
						...rows,
					].join("\n");
		const parsed = parseUnifiedDiff(diff);
		if (options.blockMove !== "structural")
			for (const mapping of unitMappings) {
				const unit = units.find((candidate) => candidate.id === mapping.unitId);
				const mapped = mapping.lineRanges.flatMap(({ start, end }) =>
					parsed.lines.slice(start, end),
				);
				if (
					mapped.filter((line) => line.type === "added").length !== unit?.added ||
					mapped.filter((line) => line.type === "removed").length !== unit?.removed
				)
					throw new Error(`Invalid browser unit projection: ${mapping.unitId}`);
			}
		return {
			path: "src/blocks.ts",
			snapshotVersion: stagingVersion(listId),
			generation: stagingGeneration,
			observationId: `fixture-o${stagingGeneration}`,
			units,
			diff: options.blockMove === "truncated" ? diff.split("\n").slice(0, 87).join("\n") : diff,
			truncated: options.blockMove === "truncated",
			...(options.blockMove === "mapped" ||
			options.blockMove === "geometry" ||
			options.blockMove === "source-active" ||
			options.blockMove === "large"
				? { unitMappings }
				: {}),
		};
	}
	function stagingVersion(listId: string) {
		return `fixture:${listId}:${stagingUnits
			.filter((unit) => unit.listId === listId)
			.map((unit) => (options.blockMove ? `${unit.id}:${Number(unit.needsReview)}` : unit.id))
			.sort()
			.join(",")}${contentVersions.has(listId) ? `:content-${contentVersions.get(listId)}` : ""}`;
	}
	function groupFiles(listId?: string): GitStagingFile[] {
		return stagingFiles.flatMap((file) => {
			const units = stagingUnits.filter(
				(unit) => unit.fileId === file.fileId && (!listId || unit.listId === listId),
			);
			if (!units.length) return [];
			return [
				{
					...file,
					unitCount: units.length,
					needsReviewCount: units.filter((unit) => unit.needsReview).length,
					stats:
						file.stats.kind === "text"
							? {
									kind: "text" as const,
									added: units.reduce((sum, unit) => sum + unit.added, 0),
									removed: units.reduce((sum, unit) => sum + unit.removed, 0),
								}
							: file.stats,
				},
			];
		});
	}
	function groupStats(files: GitStagingFile[]): GitStagingStatsBuckets {
		const result: GitStagingStatsBuckets = {};
		for (const file of files) {
			const key = file.status as keyof GitStagingStatsBuckets;
			const value = result[key] ?? {
				files: 0,
				added: 0,
				removed: 0,
				binaryFiles: 0,
				gitlinkFiles: 0,
			};
			value.files++;
			if (file.stats.kind === "text") {
				value.added += file.stats.added;
				value.removed += file.stats.removed;
			} else if (file.stats.kind === "binary") value.binaryFiles++;
			else value.gitlinkFiles++;
			result[key] = value;
		}
		return result;
	}

	function source(workspace: string, version: number) {
		const key = `${workspace}/${version}`;
		let files = sources.get(key);
		if (!files) {
			files = Array.from({ length: totals.get(version) ?? total }, (_, index) => {
				const group = options.directorySize
					? `group-${String(Math.floor(index / options.directorySize)).padStart(3, "0")}/`
					: "";
				const directory = options.branchingDirectories
					? `src/${index < 100 ? "a" : "b"}/`
					: `${workspace}/revision-${version}/files/${group}`;
				return {
					path: `${directory}file-${String(index).padStart(5, "0")}.ts`,
					status: index % 2 === 0 ? " M" : "??",
				};
			});
			sources.set(key, files);
		}
		return files;
	}

	function makeSnapshot(workspace: string, filter: GitStatusFilterChar[]): Snapshot {
		const all = source(workspace, revision);
		const files = filter.length
			? all.filter((file) => gitStatusMatchesSection(file.status, "unstaged", filter))
			: all;
		const totalFiles = all.length;
		const modified = Math.ceil(totalFiles / 2);
		return {
			workspace,
			revision,
			expiresAt: Date.now() + 120_000,
			filter,
			files,
			filesByPath: new Map(files.map((file) => [file.path, file])),
			counts: {
				totalFiles,
				staged: 0,
				unstaged: modified,
				untracked: totalFiles - modified,
				filteredFiles: files.length,
				filteredStaged: 0,
				filteredUnstaged: files.length,
				badgeCounts: { A: totalFiles - modified, M: modified, D: 0, R: 0, C: 0, U: 0 },
				exact: true,
			},
		};
	}

	function json(value: unknown, status = 200) {
		return new Response(JSON.stringify(value), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	async function page(url: URL, signal: AbortSignal | null | undefined) {
		const startedAt = performance.now();
		const workspace = url.searchParams.get("workspaceKey") ?? "workspace-a";
		const rawFilter = url.searchParams.getAll("filter").flatMap((value) => value.split(","));
		const filter = normalizeGitStatusFilter(
			rawFilter.filter((char): char is GitStatusFilterChar =>
				(GIT_STATUS_FILTER_CHARS as readonly string[]).includes(char),
			),
		);
		const cursor = url.searchParams.get("cursor");
		let snapshotId: string;
		let offset = 0;
		if (cursor) {
			const decoded = JSON.parse(atob(cursor)) as { snapshotId: string; offset: number };
			snapshotId = decoded.snapshotId;
			offset = decoded.offset;
		} else {
			snapshotId = `${workspace}:${revision}:${++nextSnapshot}`;
			snapshots.set(snapshotId, makeSnapshot(workspace, filter));
		}
		const snapshot = snapshots.get(snapshotId);
		if (!snapshot || snapshot.workspace !== workspace || snapshot.filter.join() !== filter.join()) {
			return json({ error: "Expired Git status page", code: "GIT_STATUS_PAGE_EXPIRED" }, 409);
		}
		const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
		const files = snapshot.files.slice(offset, offset + limit);
		const nextOffset = offset + files.length;
		const hasMore = nextOffset < snapshot.files.length;
		snapshot.expiresAt = Date.now() + 120_000;
		const response: Extract<GitStatusPageResult, { status: "ready" }> = {
			status: "ready",
			cache: cacheState(snapshot.revision),
			snapshotId,
			expiresAt: snapshot.expiresAt,
			files,
			nextCursor: hasMore ? btoa(JSON.stringify({ snapshotId, offset: nextOffset })) : null,
			hasMore,
			complete: true,
			counts: snapshot.counts,
		};
		const record: GitBrowserRequest = {
			id: ++nextRequest,
			workspace,
			revision: snapshot.revision,
			filter: filter.join(),
			offset,
			count: files.length,
			snapshotId,
			aborted: signal?.aborted ?? false,
			expired: false,
			settled: false,
			startedAt,
			settledAt: null,
		};
		requests.push(record);
		signal?.addEventListener(
			"abort",
			() => {
				record.aborted = true;
			},
			{ once: true },
		);
		if ((holdNext && cursor) || (holdFirst && !cursor)) {
			if (cursor) holdNext = false;
			else holdFirst = false;
			// Deliberately resolve even after abort: consumers must also reject stale generations.
			await new Promise<void>((release) => gates.set(record.id, { record, release }));
			gates.delete(record.id);
		}
		const denial = denied.get("page");
		if (denial) denied.delete("page");
		if (expireNextPage || (expireNextCursor && cursor)) {
			expireNextCursor = false;
			expireNextPage = false;
			record.expired = true;
			snapshots.delete(snapshotId);
		}
		const result = record.expired
			? json({ error: "Expired Git status page", code: "GIT_STATUS_PAGE_EXPIRED" }, 409)
			: denial
				? json({ error: `Fixture page access denied (${denial})` }, denial)
				: json(response);
		record.settled = true;
		record.settledAt = performance.now();
		return result;
	}

	async function statistics(url: URL, signal: AbortSignal | null | undefined) {
		const startedAt = performance.now();
		const workspace = url.searchParams.get("workspaceKey") ?? "workspace-a";
		const snapshotId = url.searchParams.get("snapshotId") ?? "";
		const filter = normalizeGitStatusFilter(
			(url.searchParams.get("filter") ?? "")
				.split(",")
				.filter((char): char is GitStatusFilterChar =>
					(GIT_STATUS_FILTER_CHARS as readonly string[]).includes(char),
				),
		);
		const snapshot = snapshots.get(snapshotId);
		if (!snapshot || snapshot.workspace !== workspace || snapshot.filter.join() !== filter.join()) {
			return json({ error: "Expired Git status statistics", code: "GIT_STATUS_PAGE_EXPIRED" }, 409);
		}
		let rows: GitStatusPageStatsRow[];
		try {
			rows = JSON.parse(url.searchParams.get("rows") ?? "[]") as GitStatusPageStatsRow[];
		} catch {
			return json({ error: "Invalid statistics rows" }, 400);
		}
		if (!Array.isArray(rows) || rows.length > GIT_STATUS_PAGE_MAX_LIMIT) {
			return json({ error: "Invalid statistics batch" }, 400);
		}
		const result: Extract<GitStatusPageStatsResponse, { status: "ready" }> = {
			status: "ready",
			cache: cacheState(snapshot.revision),
			snapshotId,
			rows: rows.map((row) => {
				if (row.type === "file") {
					const file = snapshot.filesByPath.get(row.path);
					return file && gitStatusMatchesSection(file.status, row.section, filter)
						? { ...row, ...gitBrowserFileStats(row.path), complete: true }
						: { ...row, complete: false };
				}
				const key = JSON.stringify([snapshotId, filter, row.section, row.path]);
				let aggregate = directoryStats.get(key);
				if (!aggregate) {
					const prefix = `${row.path.replace(/\/$/, "")}/`;
					let added = 0;
					let removed = 0;
					let count = 0;
					// Membership comes from the entire pinned dataset, never the delivered page prefix.
					for (const file of snapshot.files) {
						if (
							!file.path.startsWith(prefix) ||
							!gitStatusMatchesSection(file.status, row.section, filter)
						)
							continue;
						const measured = gitBrowserFileStats(file.path);
						added += measured.added;
						removed += measured.removed;
						count++;
					}
					aggregate = { added, removed, complete: count > 0 };
					directoryStats.set(key, aggregate);
				}
				return aggregate.complete ? { ...row, ...aggregate } : { ...row, complete: false };
			}),
		};
		if (new TextEncoder().encode(JSON.stringify(result)).byteLength > GIT_STATUS_PAGE_MAX_BYTES) {
			return json({ error: "Statistics response exceeds the status-page byte budget" }, 400);
		}
		const record: GitBrowserStatsRequest = {
			id: ++nextStatsRequest,
			aborted: signal?.aborted ?? false,
			settled: false,
			workspace,
			snapshotId,
			filter: filter.join(),
			rows: rows.map((row) => ({ ...row })),
			startedAt,
			settledAt: null,
		};
		statsRequests.push(record);
		signal?.addEventListener(
			"abort",
			() => {
				record.aborted = true;
			},
			{ once: true },
		);
		if (holdStats) {
			await new Promise<void>((release) => statsGates.set(record.id, release));
			statsGates.delete(record.id);
		}
		const denial = denied.get("stats");
		if (denial) denied.delete("stats");
		record.settled = true;
		record.settledAt = performance.now();
		return denial
			? json({ error: `Fixture statistics access denied (${denial})` }, denial)
			: json(result);
	}

	window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (options.staging && method === "POST" && url.pathname.endsWith("/staging-lists/action")) {
			const action = JSON.parse(String(init?.body)) as GitStagingAction & { workspaceKey?: string };
			stagingActionRequests.push(action);
			if (action.action === "sync") {
				stagingActions.push(action);
				const current = await observationControl("sync", { workspaceKey: action.workspaceKey });
				if (holdStagingSync) {
					holdStagingSync = false;
					await new Promise<void>((release) => {
						releaseStagingSync = release;
					});
					releaseStagingSync = null;
				}
				return json({
					outcome: "applied",
					generation: stagingGeneration,
					observationId: `fixture-o${stagingGeneration}`,
					observation: current?.observation,
				});
			}
			if (holdStagingAction) {
				holdStagingAction = false;
				await new Promise<void>((release) => {
					releaseStagingAction = release;
				});
				releaseStagingAction = null;
			}
			if (stagingFailure) {
				const status = stagingFailure;
				stagingFailure = null;
				if (status === 409) stagingGeneration++;
				return json(
					{ error: status === 409 ? "Observation changed" : "Fixture move failed" },
					status,
				);
			}
			if (
				"expectedGeneration" in action &&
				(action.expectedGeneration !== stagingGeneration ||
					action.observationId !== `fixture-o${stagingGeneration}`)
			)
				return json({ error: "Observation changed" }, 409);
			if (action.action === "delete" && action.listId === stagingActive)
				return json({ error: "Active group cannot be deleted" }, 409);
			stagingActions.push(action);
			stagingGeneration++;
			if (action.action === "activate") stagingActive = action.listId;
			if (action.action === "move")
				for (const unit of stagingUnits) {
					if (unit.listId !== action.fromListId) continue;
					const file = stagingFiles.find((file) => file.fileId === unit.fileId);
					if (
						action.unitIds
							? !action.unitIds.includes(unit.id)
							: action.paths
								? !action.paths.includes(unit.path)
								: action.scope
									? (action.scope.directory &&
											!unit.path.startsWith(`${action.scope.directory}/`)) ||
										!gitStatusMatchesSection(
											`${file?.status ?? "M"} `,
											"staged",
											action.scope.filter ?? [],
										)
									: !action.all
					)
						continue;
					unit.listId = action.toListId;
				}
			if (action.action === "delete") {
				for (const unit of stagingUnits)
					if (unit.listId === action.listId) unit.listId = stagingActive;
				stagingLists = stagingLists.filter((list) => list.id !== action.listId);
			}
			if (action.action === "rename")
				stagingLists = stagingLists.map((list) =>
					list.id === action.listId ? { ...list, name: action.name } : list,
				);
			const observation = await observationControl("publish", {
				workspaceKey: action.workspaceKey,
				generation: stagingGeneration,
				affectedListIds: options.blockMove ? ["A", "B", "C"] : ["A", "B"],
			});
			return json({
				outcome: "applied",
				observation: observation?.observation,
				listId: "listId" in action ? action.listId : "A",
				generation: stagingGeneration,
				observationId: `fixture-o${stagingGeneration}`,
				affectedListIds: options.blockMove ? ["A", "B", "C"] : ["A", "B"],
			});
		}
		if (method !== "GET") {
			mutations.push(`${method} ${url.pathname}`);
			unexpected.push(`${method} ${url.pathname}`);
			return json({ error: "Read-only browser fixture" }, 405);
		}
		const workspace = url.searchParams.get("workspaceKey") ?? "workspace-a";
		if (options.staging && /\/staging-lists\/[^/]+\/files$/.test(url.pathname)) {
			const listId = url.pathname.split("/").at(-2) as string;
			stagingReads.push(listId);
			const cursor = url.searchParams.get("cursor");
			const snapshotVersion = stagingVersion(listId);
			const filter = normalizeGitStatusFilter(
				(url.searchParams.get("filter")?.split(",") ?? []) as GitStatusFilterChar[],
			);
			const cursorVersion = `${snapshotVersion}:${[...filter].sort().join("")}`;
			const decoded = cursor ? (JSON.parse(atob(cursor)) as [string, number]) : null;
			if (decoded && decoded[0] !== cursorVersion) return json({ error: "Snapshot changed" }, 409);
			const allFiles = groupFiles(listId);
			const filtered = allFiles.filter((file) =>
				gitStatusMatchesSection(`${file.status} `, "staged", filter),
			);
			const offset = decoded?.[1] ?? 0;
			const files = filtered.slice(offset, cursor ? undefined : 1);
			const next = offset + files.length < filtered.length;
			const totals = groupStats(allFiles);
			return json({
				workspaceKey: workspace,
				listId,
				snapshotVersion,
				generation: stagingGeneration,
				observationId: `fixture-o${stagingGeneration}`,
				files,
				complete: !next,
				nextCursor: next ? btoa(JSON.stringify([cursorVersion, offset + files.length])) : null,
				stats: { complete: true, total: totals, directories: [{ path: "src", byStatus: totals }] },
			});
		}
		if (options.staging && /\/staging-lists\/[^/]+\/diff$/.test(url.pathname)) {
			const listId = url.pathname.split("/").at(-2) as string;
			const path = url.searchParams.get("path") ?? "";
			const units = stagingUnits.filter((unit) => unit.listId === listId && unit.path === path);
			if (options.blockMove) {
				if (!units.length) {
					stagingDiffReads.push({
						listId,
						status: 404,
						generation: stagingGeneration,
						units: [],
						unitMappings: undefined,
						rows: 0,
						hunks: 0,
					});
					return json({ error: "File has no changes in this ChangeList" }, 404);
				}
				const result = blockDiff(
					listId,
					units.map((unit) => ({ ...unit })),
				);
				stagingDiffReads.push({
					listId,
					status: 200,
					generation: stagingGeneration,
					units: result.units,
					unitMappings: result.unitMappings,
					rows: parseUnifiedDiff(result.diff).lines.length,
					hunks: parseUnifiedDiff(result.diff).hunks.length,
				});
				return json(result);
			}
			return json({
				path,
				snapshotVersion: stagingVersion(listId),
				generation: stagingGeneration,
				observationId: `fixture-o${stagingGeneration}`,
				units,
				truncated: true,
				diff: "@@ -1,1 +1,1 @@\n-original\n+group changes\n",
			});
		}
		if (url.pathname.endsWith("/staging-lists")) {
			const result = {
				capability: { supported: true, protocolVersion: 1 },
				workspaceKey: workspace,
				initialized: !!options.staging,
				generation: options.staging ? stagingGeneration : 0,
				observationId: options.staging ? `fixture-o${stagingGeneration}` : null,
				activeListId: options.staging ? stagingActive : null,
				scannedAt: options.staging ? 1 : null,
				state: options.staging ? "ready" : "uninitialized",
				stats: groupStats(groupFiles()),
				lists: stagingLists.map((list) => {
					const files = groupFiles(list.id);
					const units = stagingUnits.filter((unit) => unit.listId === list.id);
					return {
						...list,
						active: list.id === stagingActive,
						fileCount: files.length,
						unitCount: units.length,
						added: units.reduce((sum, unit) => sum + unit.added, 0),
						removed: units.reduce((sum, unit) => sum + unit.removed, 0),
						needsReviewCount: units.filter((unit) => unit.needsReview).length,
						stats: groupStats(files),
						snapshotVersion: stagingVersion(list.id),
					};
				}),
			};
			const read = { generation: stagingGeneration, settled: false };
			stagingSummaryReads.push(read);
			if (holdSummary) {
				holdSummary = false;
				await new Promise<void>((release) => {
					releaseSummary = release;
				});
				releaseSummary = null;
			}
			read.settled = true;
			return json(result);
		}
		if (url.pathname.endsWith("/status-page-stats"))
			return statistics(url, init?.signal ?? (input instanceof Request ? input.signal : undefined));
		if (url.pathname.endsWith("/status-files")) {
			return page(url, init?.signal ?? (input instanceof Request ? input.signal : undefined));
		}
		if (url.pathname.endsWith("/status")) {
			const files = source(workspace, revision);
			return json({
				hasChanges: files.length > 0,
				staged: 0,
				unstaged: Math.ceil(files.length / 2),
				untracked: Math.floor(files.length / 2),
				totalFiles: files.length,
				totalFilesExact: true,
				truncated: files.length > 200,
				files: files.slice(0, 200),
				headSha: "browser-fixture-head",
				branch: "browser-fixture",
			});
		}
		if (url.pathname.endsWith("/line-stats")) {
			return json({ files: [], linesAdded: 0, linesRemoved: 0, complete: false });
		}
		unexpected.push(`${method} ${url.pathname}`);
		return json({ error: `Unexpected fixture endpoint: ${url.pathname}` }, 404);
	}, window.fetch);

	return {
		cacheState,
		publishCache() {
			publishedStats++;
			return cacheState();
		},
		observationControl,
		ordinaryBlockDiff: () =>
			blockDiff(
				"A",
				stagingUnits.filter((unit) => unit.listId === "A"),
			).diff,
		holdStagingSync() {
			holdStagingSync = true;
		},
		releaseStagingSync() {
			releaseStagingSync?.();
		},
		holdStagingSummary() {
			holdSummary = true;
		},
		releaseStagingSummary() {
			releaseSummary?.();
		},
		async editStagingGroup(listId: string) {
			await observationControl("state", { status: "pending" });
			contentVersions.set(listId, (contentVersions.get(listId) ?? 0) + 1);
			if (listId === "A") {
				const edit = blockEdits.get("block-0");
				if (edit) edit.replacement = [`new-one-edited-${contentVersions.get(listId)}`];
			}
			stagingGeneration++;
			return observationControl("publish", {
				generation: stagingGeneration,
				affectedListIds: [listId],
			});
		},
		warm(workspace: string) {
			source(workspace, revision);
		},
		revise(nextTotal = totals.get(revision) ?? total) {
			revision++;
			totals.set(revision, nextTotal);
			return revision;
		},
		holdFirstPage() {
			holdFirst = true;
		},
		holdStatistics() {
			holdStats = true;
		},
		releaseStatistics() {
			holdStats = false;
			for (const release of statsGates.values()) release();
		},
		denyNext(endpoint: "page" | "stats", status: 401 | 403 | 404) {
			denied.set(endpoint, status);
		},
		failNextStagingMove(status: 409 | 500) {
			stagingFailure = status;
		},
		holdStagingMove() {
			holdStagingAction = true;
		},
		releaseStagingMove() {
			releaseStagingAction?.();
		},
		advanceStagingObservation() {
			stagingGeneration++;
		},
		expireNextCursor() {
			expireNextCursor = true;
		},
		expireNextPage() {
			expireNextPage = true;
		},
		holdNextPage() {
			holdNext = true;
		},
		releaseHeld() {
			for (const gate of gates.values()) gate.release();
		},
		snapshot: () => ({
			revision,
			requests: requests.map((request) => ({ ...request })),
			statsRequestCount: statsRequests.length,
			statsRequests: statsRequests.slice(-12).map((request) => ({ ...request })),
			pending: [...gates.keys()],
			pendingStats: [...statsGates.keys()],
			mutations: [...mutations],
			unexpected: [...unexpected],
			stagingReads: [...stagingReads],
			stagingSummaryReads: stagingSummaryReads.map((read) => ({ ...read })),
			stagingSummaryPending: releaseSummary !== null,
			stagingActions: [...stagingActions],
			stagingActionRequests: [...stagingActionRequests],
			stagingDiffReads: stagingDiffReads.slice(-12),
			stagingMovePending: releaseStagingAction !== null,
			observationTransport,
		}),
	};
}
