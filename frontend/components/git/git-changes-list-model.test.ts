import { describe, expect, test } from "bun:test";
import type { GitStagingFilesPage } from "../../../shared/git-staging-lists";
import {
	type GitStatusPage,
	type GitStatusPageFile,
	gitStatusBadgeChar,
	gitStatusInSection,
	gitStatusMatchesSection,
} from "../../../shared/git-status-page";
import {
	GIT_CHANGES_MAX_WINDOW,
	GIT_CHANGES_OVERSCAN,
	type GitChangesListConfig,
	GitChangesListModel,
	gitStagingPagesComplete,
} from "./git-changes-list-model";
import { toggleExpandedPath } from "./git-folder-prefs";

const flat: GitChangesListConfig = {
	mode: "flat",
	filter: [],
	expanded: { staged: [], unstaged: [] },
};
function page(files: GitStatusPageFile[], options: Partial<GitStatusPage> = {}): GitStatusPage {
	const counts: GitStatusPage["counts"] = {
		totalFiles: files.length,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		filteredFiles: files.length,
		filteredStaged: 0,
		filteredUnstaged: 0,
		badgeCounts: { A: 0, M: 0, D: 0, R: 0, C: 0, U: 0 },
		exact: true,
	};
	for (const file of files) {
		if (file.status === "??") counts.untracked++;
		else if (gitStatusInSection(file.status, "unstaged")) counts.unstaged++;
		if (gitStatusInSection(file.status, "staged")) counts.staged++;
		for (const section of ["staged", "unstaged"] as const) {
			if (gitStatusMatchesSection(file.status, section)) {
				counts[section === "staged" ? "filteredStaged" : "filteredUnstaged"]++;
				counts.badgeCounts[gitStatusBadgeChar(file.status, section)]++;
			}
		}
	}
	return {
		snapshotId: "snapshot",
		expiresAt: Date.now() + 120_000,
		files,
		counts,
		hasMore: false,
		nextCursor: null,
		complete: true,
		...options,
	};
}

function stagingConfig(): GitChangesListConfig & {
	staging: NonNullable<GitChangesListConfig["staging"]>;
} {
	return {
		...flat,
		stagingToolbar: true,
		staging: {
			lists: ["A", "B"].map((id) => ({
				id,
				name: id,
				active: id === "A",
				fileCount: 1,
				unitCount: 1,
				added: 1,
				removed: 2,
				needsReviewCount: 0,
				stats: { M: { files: 1, added: 1, removed: 2, binaryFiles: 0, gitlinkFiles: 0 } },
				snapshotVersion: "v1",
			})),
			expanded: ["A", "B"],
			folders: {},
		},
	};
}
function stagingPage(listId: string, paths = ["same.txt"]): GitStagingFilesPage {
	return {
		workspaceKey: "w",
		snapshotVersion: "v1",
		generation: 1,
		observationId: "o1",
		listId,
		complete: true,
		nextCursor: null,
		files: paths.map((path) => ({
			fileId: path,
			unitCount: 1,
			needsReviewCount: 0,
			path,
			status: "M",
			stats: { kind: "text", added: 1, removed: 2 },
		})),
		stats: {
			complete: true,
			total: {
				M: {
					files: paths.length,
					added: paths.length,
					removed: paths.length * 2,
					binaryFiles: 0,
					gitlinkFiles: 0,
				},
			},
			directories: [
				...new Set(
					paths.flatMap((path) =>
						path
							.split("/")
							.slice(0, -1)
							.map((_, index) =>
								path
									.split("/")
									.slice(0, index + 1)
									.join("/"),
							),
					),
				),
			].map((path) => {
				const files = paths.filter((file) => file.startsWith(`${path}/`)).length;
				return {
					path,
					byStatus: {
						M: { files, added: files, removed: files * 2, binaryFiles: 0, gitlinkFiles: 0 },
					},
				};
			}),
		},
	};
}

type FolderTreeKind = "staged" | "unstaged" | "changelist";
function folderTreeConfig(kind: FolderTreeKind, expanded: string[]): GitChangesListConfig {
	if (kind !== "changelist")
		return { ...flat, mode: "tree", expanded: { ...flat.expanded, [kind]: expanded } };
	const config = stagingConfig();
	return {
		...config,
		mode: "tree",
		stagingToolbar: false,
		stagingOnly: true,
		staging: { ...config.staging, lists: [config.staging.lists[0]], folders: { A: expanded } },
	};
}
function appendFolderTreePage(
	model: GitChangesListModel,
	kind: FolderTreeKind,
	paths: string[],
	{ offset = 0, more = false, allPaths = paths } = {},
) {
	const nextCursor = more ? `page-${offset + 1}` : null;
	if (kind === "changelist") {
		const result = stagingPage("A", allPaths);
		const included = new Set(paths);
		model.appendStaging(
			"A",
			[
				{
					...result,
					files: result.files.filter((file) => included.has(file.path)),
					complete: !more,
					nextCursor,
				},
			],
			offset,
		);
	} else {
		model.append([
			page(
				paths.map((path) => ({ path, status: kind === "staged" ? "M " : " M" })),
				{
					hasMore: more,
					nextCursor,
				},
			),
		]);
	}
}

test("published statistics preserve same-member values and reject every foreign version before Worker merge", () => {
	const model = new GitChangesListModel(flat, "pages");
	const cache = {
		status: "ready" as const,
		workerEpoch: "worker",
		memberVersion: 1,
		statsVersion: 1,
		updating: false,
	};
	const first = { ...page([{ path: "a", status: " M" }]), cache };
	model.append([first]);
	const source = {
		snapshotId: "snapshot",
		pageGeneration: "pages",
		filterKey: "",
		epoch: "one",
		workspaceIdentity: "workspace",
		workerEpoch: "worker",
		memberVersion: 1,
		statsVersion: 1,
	};
	const result = {
		snapshotId: "snapshot",
		cache,
		workspaceIdentity: "workspace",
		filterKey: "",
		rows: [
			{
				type: "file" as const,
				section: "unstaged" as const,
				path: "a",
				added: 7,
				removed: 0,
				complete: true,
			},
		],
	};
	model.setStatsSource(source);
	model.mergePageStats(source, result);
	const added = () =>
		model.window().rows.flatMap((row) => (row.type === "file" ? [row.file.displayLinesAdded] : []));
	expect(added()).toEqual([7]);
	model.setStatsSource({ ...source, updating: true });
	expect(added()).toEqual([7]);
	expect(model.window().statsRefreshing).toBe(true);
	const next = { ...source, epoch: "two", statsVersion: 2 };
	model.setStatsSource(next);
	expect(added()).toEqual([7]);
	for (const invalid of [
		{ ...result, cache: { ...cache, statsVersion: 1 } },
		{ ...result, cache: { ...cache, statsVersion: 2, memberVersion: 2 } },
		{ ...result, cache: { ...cache, statsVersion: 2, workerEpoch: "foreign" } },
		{ ...result, cache: { ...cache, statsVersion: 2 }, workspaceIdentity: "foreign" },
		{ ...result, cache: { ...cache, statsVersion: 2 }, filterKey: "M" },
	]) {
		model.mergePageStats(next, {
			...invalid,
			rows: result.rows.map((row) => ({ ...row, added: 999 })),
		});
		expect(added()).toEqual([7]);
	}
	model.mergePageStats(next, {
		...result,
		cache: { ...cache, statsVersion: 2 },
		rows: result.rows.map((row) => ({ ...row, added: 11 })),
	});
	expect(added()).toEqual([11]);
	expect(model.window().statsRefreshing).toBe(false);
	const foreignPage = { ...page([]), cache: { ...cache, memberVersion: 2 } };
	expect(() => model.append([foreignPage])).toThrow("membership");
});

describe("Git changes Worker row index", () => {
	test("ChangeLists use their own observation and keep current pages across unrelated generations", () => {
		const config = stagingConfig();
		config.stagingOnly = true;
		config.staging.observationId = "o1";
		config.staging.generation = 1;
		const model = new GitChangesListModel(config);
		model.appendStaging("A", [stagingPage("A")]);
		model.append([page([{ path: "same.txt", status: "MM" }])]);
		expect(model.window()).toMatchObject({
			snapshotId: "o1",
			statsReady: true,
			statsRefreshing: false,
		});
		expect(
			model
				.window()
				.rows.some(
					(row) => row.type === "file" || row.type === "section" || row.type === "loading",
				),
		).toBe(false);
		model.configure({
			...config,
			staging: { ...config.staging, generation: 2, observationId: "o2" },
		});
		expect(model.window().snapshotId).toBe("o2");
		expect(model.window().rows.some((row) => row.key === "staging:A:file:same.txt")).toBe(true);
		expect(() =>
			model.appendStaging("A", [{ ...stagingPage("A"), snapshotVersion: "stale" }]),
		).toThrow("snapshot changed");
	});
	test("flat staging files start one level inside their group while native files remain at root", () => {
		const model = new GitChangesListModel(stagingConfig());
		model.appendStaging("A", [stagingPage("A", ["root.txt", "src/nested.txt"])]);
		model.append([page([{ path: "native.txt", status: " M" }])]);
		const rows = model.window().rows;
		expect(rows.find((row) => row.key === "staging:A:file:root.txt")).toMatchObject({ depth: 1 });
		expect(rows.find((row) => row.key === "staging:A:file:src/nested.txt")).toMatchObject({
			depth: 1,
		});
		expect(rows.find((row) => row.key === "unstaged:file:native.txt")).toMatchObject({ depth: 0 });
	});
	test("staging tree levels include the group parent and retain compressed directory depth", () => {
		const config = stagingConfig();
		config.mode = "tree";
		config.staging.folders = { A: ["src", "src/nested", "compressed/deep"] };
		config.expanded.unstaged = ["native"];
		const model = new GitChangesListModel(config);
		model.appendStaging("A", [
			stagingPage("A", [
				"root.txt",
				"src/direct.txt",
				"src/nested/leaf.txt",
				"compressed/deep/leaf.txt",
			]),
		]);
		model.append([
			page([
				{ path: "native.txt", status: " M" },
				{ path: "native/child.txt", status: " M" },
			]),
		]);
		const rows = model.window().rows;
		for (const [key, depth] of [
			["staging:A:file:root.txt", 1],
			["staging:A:directory:src", 1],
			["staging:A:file:src/direct.txt", 2],
			["staging:A:directory:src/nested", 2],
			["staging:A:file:src/nested/leaf.txt", 3],
			["staging:A:directory:compressed/deep", 1],
			["staging:A:file:compressed/deep/leaf.txt", 2],
			["unstaged:file:native.txt", 0],
			["unstaged:directory:native", 0],
			["unstaged:file:native/child.txt", 1],
		] as const)
			expect(rows.find((row) => row.key === key)).toMatchObject({ depth });
		expect(rows.find((row) => row.key === "staging:A:directory:compressed/deep")).toMatchObject({
			label: "compressed/deep",
		});
	});
	test("the first staging page projects full group and directory totals per native status filter", () => {
		const config = stagingConfig();
		config.mode = "tree";
		const model = new GitChangesListModel(config);
		const first = stagingPage("A", ["src/first.ts"]);
		first.complete = false;
		first.nextCursor = btoa(JSON.stringify(["v1", 1]));
		first.stats.total = {
			M: { files: 60, added: 180, removed: 120, binaryFiles: 0, gitlinkFiles: 0 },
			T: { files: 2, added: 10, removed: 5, binaryFiles: 1, gitlinkFiles: 0 },
			A: { files: 40, added: 400, removed: 0, binaryFiles: 0, gitlinkFiles: 1 },
		};
		config.staging.lists[0].stats = first.stats.total;
		first.stats.directories = [{ path: "src", byStatus: first.stats.total }];
		model.appendStaging("A", [first]);
		const rows = model.window().rows;
		expect(rows.find((row) => row.type === "staging-section" && row.list.id === "A")).toMatchObject(
			{ stats: { files: 102, added: 590, removed: 125, binaryFiles: 1, gitlinkFiles: 1 } },
		);
		expect(rows.find((row) => row.type === "staging-directory")).toMatchObject({
			fileCount: 102,
			stats: { added: 590, removed: 125 },
		});
		expect(rows.some((row) => row.type === "staging-loading" && row.listId === "A")).toBe(true);
		model.configure({ ...config, filter: ["M"] });
		expect(model.window().rows.find((row) => row.type === "staging-directory")).toMatchObject({
			fileCount: 62,
			stats: { added: 190, removed: 125, binaryFiles: 1, gitlinkFiles: 0 },
		});
		model.configure({ ...config, filter: ["A"] });
		// The first loaded file need not match: its ancestor still has matching later-page files.
		expect(model.window().rows.find((row) => row.type === "staging-directory")).toMatchObject({
			fileCount: 40,
			stats: { added: 400, removed: 0, gitlinkFiles: 1 },
		});
	});
	test("filtered staging pages split a compact row while retaining its expanded ancestor intent", () => {
		const config = stagingConfig();
		config.mode = "tree";
		config.filter = ["M"];
		config.staging.folders = { A: ["src/a"] };
		const model = new GitChangesListModel(config);
		const first = stagingPage("A", ["src/a/file.ts"]);
		const second = stagingPage("A", ["src/b/file.ts"]);
		second.files[0].status = "A";
		const added = { files: 1, added: 1, removed: 0, binaryFiles: 0, gitlinkFiles: 0 };
		const total = { ...first.stats.total, A: added };
		first.stats.total = total;
		first.stats.directories[0].byStatus = total;
		second.stats.total = total;
		second.stats.directories = [
			{ path: "src", byStatus: total },
			{ path: "src/b", byStatus: { A: added } },
		];
		first.complete = false;
		first.nextCursor = "next";
		model.appendStaging("A", [first]);
		expect(
			model.window().rows.find((row) => row.key === "staging:A:directory:src/a"),
		).toMatchObject({
			label: "src/a",
			expanded: true,
		});
		model.appendStaging("A", [second], 1);
		const rows = model.window().rows;
		expect(rows.find((row) => row.key === "staging:A:directory:src")).toMatchObject({
			expanded: true,
		});
		expect(rows.find((row) => row.key === "staging:A:directory:src/a")).toMatchObject({
			path: "src/a",
			label: "a",
			expanded: true,
		});
		expect(rows.some((row) => row.key === "staging:A:file:src/a/file.ts")).toBe(true);
		expect(rows.some((row) => row.key === "staging:A:directory:src/b")).toBe(false);
		model.configure({ ...config, filter: ["A"] });
		expect(
			model.window().rows.find((row) => row.key === "staging:A:directory:src/b"),
		).toMatchObject({
			expanded: false,
		});
		model.configure(config);
		expect(model.window().rows.some((row) => row.key === "staging:A:file:src/a/file.ts")).toBe(
			true,
		);
	});

	test("server filter-bound cursors stay opaque and repeated cursors cannot complete a page chain", () => {
		const first = {
			...stagingPage("A"),
			complete: false,
			nextCursor: btoa(JSON.stringify(["v1:M", 1])),
		};
		const last = { ...stagingPage("A", ["second.txt"]), generation: 2, observationId: "o2" };
		expect(gitStagingPagesComplete([first, last])).toBe(true);
		expect(gitStagingPagesComplete([first, { ...first, files: last.files }, last])).toBe(false);
	});
	test("terminal-page EOF completes a continuous multi-page staging chain without conflating full stats", () => {
		const model = new GitChangesListModel(stagingConfig());
		const first = {
			...stagingPage("A"),
			complete: false,
			nextCursor: btoa(JSON.stringify(["v1", 1])),
		};
		const last = stagingPage("A", ["second.txt"]);
		expect(first.stats.complete).toBe(true);
		expect(gitStagingPagesComplete([first])).toBe(false);
		expect(gitStagingPagesComplete([first, last])).toBe(true);
		model.appendStaging("A", [first, last]);
		expect(
			model.window().rows.some((row) => row.type === "staging-loading" && row.listId === "A"),
		).toBe(false);
		expect(() => model.appendStaging("A", [{ ...first, nextCursor: "" }, last])).toThrow(
			"page sequence changed",
		);
	});
	test("unread groups show full summary counts and changed snapshots retire cached file pages", () => {
		const config = stagingConfig();
		const model = new GitChangesListModel(config);
		expect(model.window().rows.find((row) => row.type === "staging-section")).toMatchObject({
			stats: { files: 1, added: 1, removed: 2 },
		});
		model.appendStaging("A", [stagingPage("A")]);
		model.configure({
			...config,
			staging: {
				...config.staging,
				expanded: [],
				lists: config.staging.lists.map((list) => ({ ...list, snapshotVersion: "v2" })),
			},
		});
		expect(model.window().rows.find((row) => row.type === "staging-section")).toMatchObject({
			stats: { files: 1, added: 1, removed: 2 },
		});
		model.configure(config);
		expect(model.window().rows.some((row) => row.type === "staging-file")).toBe(false);
	});
	test.each([
		16, 32,
	])("%s collapsed independent indexes retain native rows without loading files", (count) => {
		const ids = Array.from({ length: count }, (_, index) => `group-${index}`);
		const model = new GitChangesListModel({
			...flat,
			stagingToolbar: true,
			staging: {
				lists: ids.map((id) => ({ ...stagingConfig().staging.lists[0], id, name: id })),
				expanded: [],
				folders: {},
			},
		});
		model.append([page([{ path: "partial.txt", status: "MM" }])]);
		const rows = model.window(0, 100).rows;
		expect(rows.filter((row) => row.type === "staging-section")).toHaveLength(count);
		expect(
			rows.filter((row) => row.type === "staging-loading" || row.type === "staging-file"),
		).toEqual([]);
		expect(rows.some((row) => row.key === "staged:file:partial.txt")).toBe(true);
		expect(rows.some((row) => row.key === "unstaged:file:partial.txt")).toBe(true);
	});
	test("staging groups share the window, keep identical paths distinct and never supply workspace scopes", () => {
		const model = new GitChangesListModel(stagingConfig());
		model.appendStaging("A", [stagingPage("A")]);
		model.appendStaging("B", [stagingPage("B")]);
		expect(model.window().snapshotId).toBeUndefined();
		expect(() => model.scope("unstaged")).toThrow("not completely loaded");
		model.append([page([{ path: "same.txt", status: "MM" }])]);
		const window = model.window();
		expect(window.rows.map((row) => row.key)).toEqual([
			"staging:tools",
			"staging:A:section",
			"staging:A:file:same.txt",
			"staging:B:section",
			"staging:B:file:same.txt",
			"staged:section",
			"staged:file:same.txt",
			"unstaged:section",
			"unstaged:file:same.txt",
		]);
		expect(window.loadedFiles).toBe(1);
		expect(model.scope("unstaged")).toEqual(["same.txt"]);
		expect(model.scope("staged")).toEqual(["same.txt"]);
	});
	test("independent index versions, filter, pagination and collapse preserve their own source and anchor", () => {
		const config = stagingConfig();
		const model = new GitChangesListModel(config);
		model.append([page([{ path: "work.txt", status: " M" }])]);
		model.appendStaging("A", [
			{ ...stagingPage("A"), nextCursor: btoa(JSON.stringify(["v1", 1])), complete: false },
		]);
		expect(model.window().rows.some((row) => row.key === "staging:A:loading")).toBe(true);
		model.appendStaging("A", [stagingPage("A", ["next.txt"])], 1);
		expect(
			model.window().rows.filter((row) => row.type === "staging-file" && row.listId === "A"),
		).toHaveLength(2);
		model.configure({ ...config, filter: ["D"] });
		expect(model.window().rows.some((row) => row.type === "staging-file")).toBe(false);
		model.configure({
			...config,
			staging: {
				...config.staging,
				lists: config.staging.lists.map((list) =>
					list.id === "A" ? { ...list, snapshotVersion: "v2" } : list,
				),
			},
		});
		model.appendStaging("A", [{ ...stagingPage("A", ["fresh.txt"]), snapshotVersion: "v2" }]);
		expect(model.window().rows.some((row) => row.key === "staging:A:file:fresh.txt")).toBe(true);
		expect(model.window().rows.some((row) => row.key === "staging:A:file:same.txt")).toBe(false);
		model.configure({ ...config, staging: { ...config.staging, expanded: [] } });
		expect(model.window().rows.filter((row) => row.type.startsWith("staging-"))).toHaveLength(3);
	});
	test("pagination rejects mixing independent index versions", () => {
		const model = new GitChangesListModel(stagingConfig());
		model.appendStaging("A", [
			{ ...stagingPage("A"), nextCursor: btoa(JSON.stringify(["v1", 1])), complete: false },
		]);
		expect(() =>
			model.appendStaging("A", [{ ...stagingPage("A", ["fresh.txt"]), snapshotVersion: "v2" }], 1),
		).toThrow("ChangeList snapshot changed");
		expect(model.window().rows.some((row) => row.key === "staging:A:file:same.txt")).toBe(true);
	});
	test("compacted staging directory anchors stay within their own list", () => {
		const config = stagingConfig();
		config.mode = "tree";
		config.staging.folders = { A: ["src/a"], B: ["before", "src", "z"] };
		const model = new GitChangesListModel(config);
		model.appendStaging("A", [stagingPage("A", ["src/a/same.ts"])]);
		model.appendStaging("B", [
			stagingPage("B", ["before/1.ts", "before/2.ts", "before/3.ts", "src/a/file.ts", "z/file.ts"]),
		]);
		const before = model
			.window(0, 100)
			.rows.findIndex((row) => row.key === "staging:B:directory:src");
		expect(before).toBeGreaterThan(0);
		model.window(before, 1);
		model.configure({
			...config,
			staging: { ...config.staging, folders: { ...config.staging.folders, B: ["src/a", "z"] } },
		});
		const after = model.window();
		const compacted = after.rows.findIndex((row) => row.key === "staging:B:directory:src/a");
		expect(compacted).toBeGreaterThanOrEqual(0);
		expect(after.rows[compacted]).toMatchObject({ listId: "B", path: "src/a", label: "src/a" });
		expect(after.anchorDelta).toBe(after.start + compacted - before);
	});

	test("large staging pages stay bounded in the same Worker and tree anchors are list-scoped", () => {
		const config = stagingConfig();
		const model = new GitChangesListModel(config);
		model.append([page([])]);
		model.appendStaging("A", [
			stagingPage(
				"A",
				Array.from({ length: 10_000 }, (_, index) => `src/file-${index}.ts`),
			),
		]);
		expect(model.window(5000, 20).rows.length).toBeLessThanOrEqual(GIT_CHANGES_MAX_WINDOW);
		expect(model.window().loadedFiles).toBe(0);
		model.configure({
			...config,
			mode: "tree",
			staging: { ...config.staging, folders: { A: ["src"] } },
		});
		expect(model.window(0, 20).rows.some((row) => row.key === "staging:A:directory:src")).toBe(
			true,
		);
		expect(model.window().rows.some((row) => row.type === "staging-file")).toBe(true);
	});
	test("ten thousand files produce a bounded window with both MM sections and the final path", () => {
		const files = Array.from({ length: 10_000 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: "MM",
		}));
		const model = new GitChangesListModel(flat);
		model.append([page(files)]);
		const window = model.window(5_000, 20);
		expect(window.loadedFiles).toBe(10_000);
		expect(window.loadedStaged).toBe(10_000);
		expect(window.loadedUnstaged).toBe(10_000);
		expect(window.totalRows).toBe(20_002);
		expect(window.rows).toHaveLength(20 + 2 * GIT_CHANGES_OVERSCAN);
		expect(model.window(1_000, 100_000).rows.length).toBeLessThanOrEqual(GIT_CHANGES_MAX_WINDOW);
		const tail = model.window(19_990, 20);
		expect(tail.rows.at(-1)?.key).toBe("unstaged:file:src/file-9999.ts");
		expect(model.scope("unstaged")).toHaveLength(10_000);
	});

	test("tree compression, expansion and descendants stay in the model rather than window DTOs", () => {
		const model = new GitChangesListModel({ ...flat, mode: "tree" });
		const files = Array.from({ length: 10_000 }, (_, index) => ({
			path: `src/deep/file-${index}.ts`,
			status: " M",
		}));
		model.append([page(files.slice(0, 100), { hasMore: true, nextCursor: "next" })]);
		let window = model.window();
		expect(window.rows.map((row) => row.type)).toEqual(["section", "directory", "loading"]);
		expect(() => model.scope("unstaged", "src/deep")).toThrow("not completely loaded");
		model.append([page(files.slice(100))]);
		window = model.window();
		expect(window.totalRows).toBe(2);
		const folder = window.rows[1];
		expect(folder?.type).toBe("directory");
		if (folder?.type !== "directory") throw new Error("Missing compressed directory");
		expect(folder.label).toBe("src/deep");
		expect(folder.fileCount).toBe(10_000);
		expect("children" in folder).toBe(false);
		expect("files" in folder).toBe(false);
		model.configure({ ...flat, mode: "tree", expanded: { staged: [], unstaged: ["src/deep"] } });
		window = model.window(5_000, 12);
		expect(window.totalRows).toBe(10_002);
		expect(window.rows).toHaveLength(12 + 2 * GIT_CHANGES_OVERSCAN);
		expect(model.scope("unstaged", "src/deep")).toHaveLength(10_000);
	});

	test("incremental pages keep AM per-section filtering, rename metadata and literal full path identity", () => {
		const renamed = { path: "中文/new\n name.ts", oldPath: "old name.ts", status: "R " };
		const literal = `dir/back\\slash-${"x".repeat(1_200)}.ts`;
		const model = new GitChangesListModel({ ...flat, filter: ["A"] });
		model.append([
			page([{ path: "src/fresh.ts", status: "AM" }], { hasMore: true, nextCursor: "next" }),
		]);
		model.append([page([renamed, { path: literal, status: "??" }])]);
		expect(model.scope("staged")).toEqual(["src/fresh.ts"]);
		expect(model.scope("unstaged")).toEqual([literal]);
		model.configure(flat);
		const rows = model.window(0, 30).rows;
		const renameRow = rows.find((row) => row.type === "file" && row.path === renamed.path);
		expect(renameRow?.type === "file" ? renameRow.file.oldPath : null).toBe("old name.ts");
		expect(rows.some((row) => row.type === "file" && row.path === literal)).toBe(true);
		expect(rows.filter((row) => row.type === "file" && row.path === "src/fresh.ts")).toHaveLength(
			2,
		);
	});

	test.each([
		"staged",
		"unstaged",
	] as const)("%s compacted directory keeps its anchor when filtering removes preceding rows", (section) => {
		const config = folderTreeConfig(section, ["src/a", "src/b", "z"]);
		const model = new GitChangesListModel(config);
		const status = (char: string) => (section === "staged" ? `${char} ` : ` ${char}`);
		model.append([
			page([
				{ path: "before/file.ts", status: status("M") },
				{ path: "src/a/file.ts", status: status("A") },
				{ path: "src/b/file.ts", status: status("M") },
				{ path: "z/file.ts", status: status("A") },
			]),
		]);
		const before = model
			.window(0, 100)
			.rows.findIndex((row) => row.key === `${section}:directory:src`);
		expect(before).toBe(2);
		model.window(before, 1);
		model.configure({ ...config, filter: ["A"] });
		const after = model.window();
		expect(after.rows[1]).toMatchObject({
			key: `${section}:directory:src/a`,
			path: "src/a",
			label: "src/a",
		});
		expect(after.anchorDelta).toBe(1 - before);
		expect(model.scope(section, "src/a")).toEqual(["src/a/file.ts"]);
	});

	test("new pages preserve the visible path anchor after tree sorting", () => {
		const model = new GitChangesListModel({ ...flat, mode: "tree" });
		model.append([
			page(
				["b", "c", "d"].map((path) => ({ path, status: " M" })),
				{ hasMore: true, nextCursor: "next" },
			),
		]);
		model.window(2, 2);
		model.append([page([{ path: "a", status: " M" }])]);
		const window = model.window();
		expect(window.anchorDelta).toBe(1);
		expect(window.rows.find((row) => row.key === "unstaged:file:c")).toBeDefined();
	});

	test("partial scan and expired snapshots never authorize a directory or filtered scope", () => {
		for (const options of [
			{ complete: false, limitReason: "records" as const },
			{ expiresAt: Date.now() - 1 },
		]) {
			const model = new GitChangesListModel(flat);
			model.append([page([{ path: "src/a", status: " M" }], options)]);
			expect(model.isComplete).toBe(false);
			expect(() => model.scope("unstaged")).toThrow();
			expect(() => model.scope("unstaged", "src")).toThrow();
		}
	});

	test("missing line statistics stay unknown and incomplete directories are not summed", () => {
		const model = new GitChangesListModel({ ...flat, mode: "tree" });
		model.append([
			page([
				{ path: "src/known", status: " M" },
				{ path: "src/unknown", status: " M" },
			]),
		]);
		const source = { snapshotId: "snapshot", filterKey: "", epoch: "1" };
		model.setStatsSource(source);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "file",
					section: "unstaged",
					path: "src/known",
					added: 8,
					removed: 1,
					complete: true,
				},
			],
		});
		let folder = model.window().rows.find((row) => row.type === "directory");
		expect(folder?.type === "directory" ? folder.added : null).toBeUndefined();
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "file",
					section: "unstaged",
					path: "src/unknown",
					added: 3,
					removed: 0,
					complete: true,
				},
			],
		});
		folder = model.window().rows.find((row) => row.type === "directory");
		expect(folder?.type === "directory" ? folder.added : null).toBeUndefined();
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "directory",
					section: "unstaged",
					path: "src",
					added: 11,
					removed: 1,
					complete: true,
				},
			],
		});
		folder = model.window().rows.find((row) => row.type === "directory");
		expect(folder?.type === "directory" ? folder.added : null).toBe(11);
		expect(folder?.type === "directory" ? folder.removed : null).toBe(1);
	});

	test("561 directory measurements survive unrelated pagination and expiry without authorizing actions", () => {
		const model = new GitChangesListModel({ ...flat, mode: "tree" });
		const expiresAt = Date.now() + 120_000;
		model.append([
			page(
				Array.from({ length: 100 }, (_, index) => ({ path: `src/deep/${index}`, status: " M" })),
				{ hasMore: true, nextCursor: "next", expiresAt },
			),
		]);
		const source = { snapshotId: "snapshot", filterKey: "", epoch: "1" };
		model.setStatsSource(source);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "directory",
					section: "unstaged",
					path: "src/deep",
					added: 1122,
					removed: 561,
					complete: true,
				},
			],
		});
		const before = model.window();
		expect(before.loadedFiles).toBe(100);
		expect(before.rows.find((row) => row.type === "directory")).toMatchObject({
			added: 1122,
			removed: 561,
		});
		expect(() => model.scope("unstaged", "src/deep")).toThrow();
		model.append([
			page([{ path: "other/file", status: " M" }], {
				hasMore: true,
				nextCursor: "third",
				expiresAt: Date.now() - 1,
			}),
		]);
		const after = model.window();
		expect(
			after.rows.find((row) => row.type === "directory" && row.path === "src/deep"),
		).toMatchObject({ added: 1122, removed: 561 });
		expect(
			after.rows.find((row) => row.type === "directory" && row.path === "other"),
		).toMatchObject({ statsComplete: false });
		expect(() => model.scope("unstaged", "src/deep")).toThrow();
	});

	test("incremental measurements keep section/filter/path identity and reject obsolete sources", () => {
		const model = new GitChangesListModel({ ...flat, filter: ["A", "M", "R"] });
		model.append([
			page([
				{ path: "中文/new\\nname", oldPath: "old", status: "RM" },
				{ path: "binary", status: "AM" },
				{ path: "unknown", status: " M" },
			]),
		]);
		const source = { snapshotId: "snapshot", filterKey: "A,M,R", epoch: "1" };
		model.setStatsSource(source);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "file",
					section: "staged",
					path: "中文/new\\nname",
					added: 7,
					removed: 4,
					complete: true,
				},
				{
					type: "file",
					section: "unstaged",
					path: "中文/new\\nname",
					added: 2,
					removed: 1,
					complete: true,
				},
				{ type: "file", section: "unstaged", path: "binary", added: 0, removed: 0, complete: true },
				{ type: "file", section: "unstaged", path: "unknown", added: 9, complete: false },
			],
		});
		const rows = model.window(0, 30).rows;
		expect(rows.find((row) => row.key === "staged:file:中文/new\\nname")).toMatchObject({
			file: { displayLinesAdded: 7, oldPath: "old" },
		});
		expect(rows.find((row) => row.key === "unstaged:file:中文/new\\nname")).toMatchObject({
			file: { displayLinesAdded: 2 },
		});
		expect(rows.find((row) => row.key === "unstaged:file:binary")).toMatchObject({
			file: { displayLinesAdded: 0, displayLinesRemoved: 0, statsComplete: true },
		});
		expect(rows.find((row) => row.key === "unstaged:file:unknown")).toMatchObject({
			file: { displayLinesAdded: undefined, statsComplete: false },
		});
		const next = { ...source, epoch: "2" };
		model.setStatsSource(next);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{ type: "file", section: "staged", path: "binary", added: 88, removed: 0, complete: true },
			],
		});
		model.mergePageStats({ ...next, filterKey: "M" }, { snapshotId: "snapshot", rows: [] });
		model.mergePageStats(next, { snapshotId: "other", rows: [] });
		const refreshing = model.window(0, 30);
		expect(refreshing.statsReady).toBe(false);
		expect(refreshing.statsRefreshing).toBe(true);
		expect(
			refreshing.rows.find((row) => row.key === "unstaged:file:中文/new\\nname"),
		).toMatchObject({
			file: { displayLinesAdded: 2, statsEpoch: "1", statsRefreshing: true },
		});
		expect(refreshing.rows.find((row) => row.key === "staged:file:binary")).toMatchObject({
			file: { displayLinesAdded: undefined, statsRefreshing: true },
		});
	});

	test("measurement batches patch only indexed rows and keep unrelated row objects", () => {
		const model = new GitChangesListModel(flat);
		model.append([
			page(Array.from({ length: 240 }, (_, index) => ({ path: `file-${index}`, status: " M" }))),
		]);
		const source = { snapshotId: "snapshot", filterKey: "", epoch: "1" };
		model.setStatsSource(source);
		const before = model.window(205, 10);
		const untouched = before.rows.find((row) => row.key === "unstaged:file:file-210");
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{
					type: "file",
					section: "unstaged",
					path: "file-205",
					added: 205,
					removed: 1,
					complete: true,
				},
			],
		});
		const after = model.window();
		expect(after.rows.find((row) => row.key === "unstaged:file:file-210")).toBe(untouched);
		expect(after.rows.find((row) => row.key === "unstaged:file:file-205")).toMatchObject({
			file: { displayLinesAdded: 205 },
		});
		expect(after.anchorDelta).toBe(0);
	});

	test("reset windows have no snapshot and an accepted empty page is ready", () => {
		const model = new GitChangesListModel(flat, "pages-1");
		expect(model.window().snapshotId).toBeUndefined();
		expect(model.window().statsReady).toBe(false);
		model.configure({ ...flat, mode: "tree" });
		expect(model.window().snapshotId).toBeUndefined();
		model.append([page([], { snapshotId: "empty-snapshot" })]);
		expect(model.window()).toMatchObject({
			snapshotId: "empty-snapshot",
			loadedFiles: 0,
			statsReady: true,
			statsRefreshing: false,
		});
	});

	test("only measurements received for the current visible rows acknowledge readiness", () => {
		const model = new GitChangesListModel(flat, "pages-1");
		model.append([
			page([
				{ path: "one", status: " M" },
				{ path: "two", status: " M" },
			]),
		]);
		const source = { snapshotId: "snapshot", pageGeneration: "pages-1", filterKey: "", epoch: "1" };
		expect(model.window().statsReady).toBe(false);
		model.setStatsSource(source);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [{ type: "file", section: "unstaged", path: "one", complete: false }],
		});
		expect(model.window().statsReady).toBe(false);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [{ type: "file", section: "unstaged", path: "two", complete: false }],
		});
		expect(model.window()).toMatchObject({ statsReady: true, statsRefreshing: false });
		model.append([page([{ path: "three", status: " M" }])]);
		expect(model.window().statsReady).toBe(false);
	});

	test("epoch refresh keeps display provenance and an explicit unknown replaces old numbers", () => {
		const model = new GitChangesListModel(flat, "pages-1");
		model.append([page([{ path: "one", status: " M" }])]);
		const source = { snapshotId: "snapshot", pageGeneration: "pages-1", filterKey: "", epoch: "1" };
		const known = {
			snapshotId: "snapshot",
			rows: [
				{
					type: "file" as const,
					section: "unstaged" as const,
					path: "one",
					added: 8,
					removed: 2,
					complete: true,
				},
			],
		};
		model.setStatsSource(source);
		model.mergePageStats(source, known);
		const next = { ...source, epoch: "2" };
		model.setStatsSource(next);
		expect(model.window().rows.find((row) => row.type === "file")).toMatchObject({
			file: { displayLinesAdded: 8, statsEpoch: "1", statsRefreshing: true },
		});
		expect(model.window().statsReady).toBe(false);
		model.mergePageStats(source, known);
		expect(model.window().statsReady).toBe(false);
		model.mergePageStats(next, {
			snapshotId: "snapshot",
			rows: [{ type: "file", section: "unstaged", path: "one", added: 99, complete: false }],
		});
		expect(model.window().rows.find((row) => row.type === "file")).toMatchObject({
			file: {
				displayLinesAdded: undefined,
				displayLinesRemoved: undefined,
				statsEpoch: "2",
				statsRefreshing: false,
				statsComplete: false,
			},
		});
		expect(model.window().statsReady).toBe(true);
		model.setStatsSource({ ...next, epoch: "3" });
		expect(model.window().rows.find((row) => row.type === "file")).toMatchObject({
			file: { displayLinesAdded: undefined, statsEpoch: "2", statsRefreshing: true },
		});
	});

	test("foreign page generations and snapshots cannot set or settle the statistics source", () => {
		const model = new GitChangesListModel(flat, "pages-2");
		model.append([page([{ path: "one", status: " M" }])]);
		const source = { snapshotId: "snapshot", pageGeneration: "pages-2", filterKey: "", epoch: "2" };
		const rows = [{ type: "file" as const, section: "unstaged" as const, path: "one" }];
		for (const invalid of [
			{ ...source, pageGeneration: "pages-1" },
			{ ...source, snapshotId: "old" },
			{ ...source, filterKey: "M" },
		]) {
			model.setStatsSource(invalid);
			model.mergePageStats(invalid, undefined, { settled: true, failed: true, rows });
			expect(model.window().statsSource).toBeUndefined();
			expect(model.window().statsReady).toBe(false);
		}
		model.setStatsSource(source);
		model.mergePageStats({ ...source, pageGeneration: "pages-1" }, undefined, {
			settled: true,
			failed: true,
			rows,
		});
		expect(model.window().statsReady).toBe(false);
		model.mergePageStats(source, undefined, { settled: true, failed: true });
		expect(model.window().statsReady).toBe(false);
		model.mergePageStats(source, undefined, { settled: true, failed: true, rows });
		expect(model.window()).toMatchObject({
			statsReady: true,
			statsFailed: true,
			statsRefreshing: false,
		});
		expect(model.window().rows.find((row) => row.type === "file")).toMatchObject({
			file: { displayLinesAdded: undefined, statsEpoch: "2", statsComplete: false },
		});
	});

	test("a delayed failure settles only its requested identities after a new candidate is appended", () => {
		const model = new GitChangesListModel(flat, "pages-1");
		model.append([page([{ path: "one", status: " M" }], { hasMore: true, nextCursor: "next" })]);
		const source = { snapshotId: "snapshot", pageGeneration: "pages-1", filterKey: "", epoch: "1" };
		model.setStatsSource(source);
		const requestedRows = [{ type: "file" as const, section: "unstaged" as const, path: "one" }];
		model.append([page([{ path: "two", status: " M" }])]);
		model.mergePageStats(source, undefined, { settled: true, failed: true, rows: requestedRows });
		const candidate = model.window();
		expect(candidate.statsReady).toBe(false);
		expect(candidate.rows.find((row) => row.type === "file" && row.path === "one")).toMatchObject({
			file: { statsEpoch: "1", statsRefreshing: false, statsComplete: false },
		});
		expect(candidate.rows.find((row) => row.type === "file" && row.path === "two")).toMatchObject({
			file: { statsEpoch: undefined, statsRefreshing: true, statsComplete: false },
		});
		model.mergePageStats(source, undefined, {
			settled: true,
			failed: true,
			rows: [{ type: "file", section: "unstaged", path: "two" }],
		});
		expect(model.window()).toMatchObject({
			statsReady: true,
			statsFailed: true,
			statsRefreshing: false,
		});
	});

	test("a different page generation clears display-only statistics even for the same snapshot", () => {
		const model = new GitChangesListModel(flat);
		model.append([page([{ path: "one", status: " M" }])]);
		const source = { snapshotId: "snapshot", pageGeneration: "pages-1", filterKey: "", epoch: "1" };
		model.setStatsSource(source);
		model.mergePageStats(source, {
			snapshotId: "snapshot",
			rows: [
				{ type: "file", section: "unstaged", path: "one", added: 8, removed: 2, complete: true },
			],
		});
		model.setStatsSource({ ...source, pageGeneration: "pages-2", epoch: "2" });
		expect(model.window().rows.find((row) => row.type === "file")).toMatchObject({
			file: { displayLinesAdded: undefined, statsEpoch: undefined, statsRefreshing: true },
		});
	});

	test("a shrinking viewport request includes the entire legal final viewport", () => {
		const model = new GitChangesListModel(flat);
		model.append([
			page(Array.from({ length: 30 }, (_, index) => ({ path: `file-${index}`, status: " M" }))),
		]);
		const window = model.window(900, 10);
		expect(window.start).toBe(15);
		expect(window.rows.at(-1)?.key).toBe("unstaged:file:file-29");
		expect(window.rows).toHaveLength(16);
	});

	test("a page from another snapshot cannot be appended to a cursor chain", () => {
		const model = new GitChangesListModel(flat);
		model.append([page([{ path: "one", status: " M" }])]);
		expect(() =>
			model.append([page([{ path: "two", status: " M" }], { snapshotId: "other" })]),
		).toThrow("snapshot changed");
		expect(model.window().loadedFiles).toBe(1);
	});
});

describe.each([
	"staged",
	"unstaged",
	"changelist",
] as const)("%s folder expansion across pages", (kind) => {
	const prefix = kind === "changelist" ? "staging:A" : kind;
	const fileKey = (path: string) => `${prefix}:file:${path}`;
	const directoryKey = (path: string) => `${prefix}:directory:${path}`;

	test("historical compact expansion keeps seen files visible through several branching pages", () => {
		const paths = ["src/a/file.ts", "src/b/file.ts", "src/a/later.ts"];
		const config = folderTreeConfig(kind, ["src/a"]);
		const model = new GitChangesListModel(config);
		appendFolderTreePage(model, kind, [paths[0]], { more: true, allPaths: paths });
		expect(model.window().rows.some((row) => row.key === fileKey(paths[0]))).toBe(true);
		if (kind !== "changelist")
			expect(model.window().rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
				label: "src/a",
				expanded: true,
			});
		appendFolderTreePage(model, kind, [paths[1]], { offset: 1, more: true, allPaths: paths });
		let rows = model.window().rows;
		expect(rows.find((row) => row.key === directoryKey("src"))).toMatchObject({ expanded: true });
		expect(rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
			path: "src/a",
			label: "a",
			expanded: true,
		});
		expect(rows.some((row) => row.key === fileKey(paths[0]))).toBe(true);
		expect(rows.find((row) => row.key === directoryKey("src/b"))).toMatchObject({
			expanded: false,
		});
		appendFolderTreePage(model, kind, [paths[2]], { offset: 2, allPaths: paths });
		rows = model.window().rows;
		expect(rows.some((row) => row.key === fileKey(paths[0]))).toBe(true);
		expect(rows.some((row) => row.key === fileKey(paths[2]))).toBe(true);
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
		expect(config).toEqual(folderTreeConfig(kind, ["src/a"]));
	});

	test("compact rows stop at an open parent and closed child boundary", () => {
		const model = new GitChangesListModel(folderTreeConfig(kind, ["src"]));
		appendFolderTreePage(model, kind, ["src/a/file.ts"]);
		const rows = model.window().rows;
		expect(rows.find((row) => row.key === directoryKey("src"))).toMatchObject({
			path: "src",
			label: "src",
			expanded: true,
		});
		expect(rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
			path: "src/a",
			label: "a",
			expanded: false,
		});
		expect(rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(false);
	});

	test("refresh and filtering preserve expansion as branches disappear and compact again", () => {
		const config = folderTreeConfig(kind, ["src/a"]);
		const model = new GitChangesListModel(config);
		appendFolderTreePage(model, kind, ["src/a/file.ts", "src/b/file.ts"]);
		model.configure({ ...config, filter: ["D"] });
		expect(model.window().rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(false);
		model.configure(config);
		expect(model.window().rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(true);
		const refreshed = new GitChangesListModel(config);
		appendFolderTreePage(refreshed, kind, ["src/a/file.ts"]);
		const rows = refreshed.window().rows;
		expect(rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
			path: "src/a",
			label: "src/a",
			expanded: true,
		});
		expect(rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(true);
	});

	test("a manually folded child remains closed after reverse compression and can reopen", () => {
		let expanded = [...toggleExpandedPath(["src/a", "src/b"], "src/a")];
		const branched = new GitChangesListModel(folderTreeConfig(kind, expanded));
		appendFolderTreePage(branched, kind, ["src/a/file.ts", "src/b/file.ts"]);
		expect(branched.window().rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(false);
		const model = new GitChangesListModel(folderTreeConfig(kind, expanded));
		appendFolderTreePage(model, kind, ["src/a/file.ts"]);
		expect(model.window().rows.find((row) => row.key === directoryKey("src"))).toMatchObject({
			expanded: true,
		});
		expect(model.window().rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
			label: "a",
			expanded: false,
		});
		expanded = [...toggleExpandedPath(expanded, "src/a")];
		model.configure(folderTreeConfig(kind, expanded));
		expect(model.window().rows.find((row) => row.key === directoryKey("src/a"))).toMatchObject({
			label: "src/a",
			expanded: true,
		});
		expect(model.window().rows.some((row) => row.key === fileKey("src/a/file.ts"))).toBe(true);
	});

	test("closing and reopening a parent leaves its former descendants folded", () => {
		const paths = ["src/a/deep/file.ts", "src/b/file.ts"];
		const opened = ["src/a/deep", "src/b"];
		const model = new GitChangesListModel(folderTreeConfig(kind, opened));
		appendFolderTreePage(model, kind, paths);
		const closed = toggleExpandedPath(opened, "src");
		model.configure(folderTreeConfig(kind, [...closed]));
		expect(model.window().rows.find((row) => row.key === directoryKey("src"))).toMatchObject({
			expanded: false,
		});
		const reopened = toggleExpandedPath(closed, "src");
		model.configure(folderTreeConfig(kind, [...reopened]));
		expect(
			model.window().rows.some((row) => row.type === "file" || row.type === "staging-file"),
		).toBe(false);
		model.configure(folderTreeConfig(kind, [...toggleExpandedPath(reopened, "src/a/deep")]));
		expect(model.window().rows.some((row) => row.key === fileKey(paths[0]))).toBe(true);
		expect(model.window().rows.some((row) => row.key === fileKey(paths[1]))).toBe(false);
	});

	test("literal special paths and sibling prefixes retain their own operation identities", () => {
		const folders = ["src/a", "src/a2", "src2", "src\\a", "中文 空格/line\n\\name"];
		const paths = folders.map((path) => `${path}/file.ts`);
		const expanded = [...toggleExpandedPath(folders, "src/a")];
		const model = new GitChangesListModel(folderTreeConfig(kind, expanded));
		appendFolderTreePage(model, kind, paths);
		const rows = model.window(0, 100).rows;
		expect(rows.some((row) => row.key === fileKey(paths[0]))).toBe(false);
		for (const path of paths.slice(1))
			expect(rows.find((row) => row.key === fileKey(path))).toMatchObject({ path });
		for (const path of folders)
			expect(rows.find((row) => row.key === directoryKey(path))).toMatchObject({ path });
		if (kind !== "changelist") {
			expect(model.scope(kind, "src/a")).toEqual([paths[0]]);
			expect(model.scope(kind, "src\\a")).toEqual([paths[3]]);
			expect(model.scope(kind, folders[4])).toEqual([paths[4]]);
		}
	});

	test("branching pages preserve the visible file key and its virtual scroll anchor", () => {
		const paths = ["src/a/file.ts", "z/tail.ts", "a/earlier.ts", "src/b/file.ts"];
		const model = new GitChangesListModel(folderTreeConfig(kind, ["src/a"]));
		appendFolderTreePage(model, kind, paths.slice(0, 2), { more: true, allPaths: paths });
		const key = fileKey(paths[0]);
		const before = model.window(0, 100).rows.findIndex((row) => row.key === key);
		expect(before).toBeGreaterThan(0);
		model.window(before, 1);
		appendFolderTreePage(model, kind, paths.slice(2), { offset: 1, allPaths: paths });
		const after = model.window();
		const index = after.rows.findIndex((row) => row.key === key);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(after.anchorDelta).toBe(after.start + index - before);
	});
});
