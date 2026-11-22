import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_PAGE_MAX_BYTES,
	type GitStatusPageQuery,
	type GitStatusPageStatsQuery,
	type GitStatusPageStatsRow,
	gitStatusBadgeChar,
	gitStatusMatchesSection,
} from "../../shared/git-status-page";
import { safeSpawn } from "../lib/spawn";
import { closeGitLineStatsWorkers, getGitLineStats } from "./git-line-stats";
import { GitStatusPageEngine } from "./git-status-page-engine";
import {
	GIT_STATUS_PAGE_MAX_RECORDS,
	GIT_STATUS_PAGE_SCAN_BYTES,
	GitStatusPageParser,
	parseGitStatusPageRaw,
} from "./git-status-page-parser";
import {
	type GitStatusPageRawResult,
	type GitStatusPageRequest,
	gitStatusPageScopesOverlap,
} from "./git-status-page-protocol";

afterAll(closeGitLineStatsWorkers);
const signal = new AbortController().signal;
const request = (query: GitStatusPageQuery = {}): GitStatusPageRequest => ({
	scope: { actorId: "alice", workspaceKey: "workspace", queryKey: '["remote","device",7,"/root"]' },
	query,
	source: { kind: "remote", identity: "device:7:/root" },
});
const rows = (count: number) =>
	Array.from({ length: count }, (_, index) => `?? file-${String(index).padStart(5, "0")}\0`).join(
		"",
	);
const raw = (stdout: string, complete = true): GitStatusPageRawResult => ({ stdout, complete });
const noRemote = async (): Promise<GitStatusPageRawResult> => {
	throw new Error("Unexpected rescan");
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shared section semantics", () => {
	test("AM/MM, untracked additions and conflicts retain per-section badges", () => {
		expect(gitStatusBadgeChar("AM", "staged")).toBe("A");
		expect(gitStatusBadgeChar("AM", "unstaged")).toBe("M");
		expect(gitStatusMatchesSection("AM", "staged", ["M"])).toBe(false);
		expect(gitStatusMatchesSection("AM", "unstaged", ["M"])).toBe(true);
		expect(gitStatusMatchesSection("??", "staged", ["A"])).toBe(false);
		expect(gitStatusMatchesSection("??", "unstaged", ["A"])).toBe(true);
		for (const status of ["UU", "AA", "DD", "UD", "DU"])
			for (const section of ["staged", "unstaged"] as const)
				expect(gitStatusMatchesSection(status, section, ["U"])).toBe(true);
	});
});

describe("incremental bounded porcelain parser", () => {
	test("UTF-8, NUL, spaces, newlines and both rename paths survive one-byte chunks", () => {
		const parser = new GitStatusPageParser();
		const bytes = new TextEncoder().encode("R  新 名\n.txt\0旧 名\n.txt\0AM tracked\0?? 新\0");
		for (const byte of bytes) expect(parser.push(new Uint8Array([byte]))).toBe(true);
		parser.finish(true);
		expect(parser.files).toEqual([
			{ status: "R ", path: "新 名\n.txt", oldPath: "旧 名\n.txt" },
			{ status: "AM", path: "tracked" },
			{ status: "??", path: "新" },
		]);
	});

	test("an incomplete rename is not counted and natural EOF rejects it", () => {
		const parser = new GitStatusPageParser();
		parser.push(new TextEncoder().encode("?? first\0R  new\0old"));
		expect(parser.files).toEqual([{ status: "??", path: "first" }]);
		expect(() => parser.finish(true)).toThrow("Incomplete Git status record");
		const partial = parseGitStatusPageRaw({
			stdout: "?? first\0R  new\0old",
			complete: false,
			limitReason: "remote-truncated",
		});
		expect(partial).toMatchObject({
			files: [{ status: "??", path: "first" }],
			complete: false,
			limitReason: "remote-truncated",
		});
	});

	test("record and byte limits retain only whole records and mark partial results", () => {
		const recordLimited = parseGitStatusPageRaw(raw(rows(GIT_STATUS_PAGE_MAX_RECORDS + 1)));
		expect(recordLimited.files).toHaveLength(GIT_STATUS_PAGE_MAX_RECORDS);
		expect(recordLimited).toMatchObject({ complete: false, limitReason: "records" });
		const byteLimited = parseGitStatusPageRaw(
			raw(`?? ok\0?? ${"中".repeat(GIT_STATUS_PAGE_SCAN_BYTES)}\0`),
		);
		expect(byteLimited.files).toEqual([{ status: "??", path: "ok" }]);
		expect(byteLimited).toMatchObject({ complete: false, limitReason: "bytes" });
	});

	test("remote completeness metadata is required and invalid UTF-8 is rejected", () => {
		expect(parseGitStatusPageRaw({ stdout: "?? a\0" })).toMatchObject({
			complete: false,
			limitReason: "remote-incomplete",
		});
		expect(() => new GitStatusPageParser().push(new Uint8Array([255]))).toThrow();
	});
});

const statsRequest = (
	snapshotId: string,
	statsRows: GitStatusPageStatsRow[],
	base = request(),
): GitStatusPageRequest & { statsQuery: GitStatusPageStatsQuery } => ({
	...base,
	operation: "stats",
	statsQuery: { snapshotId, rows: statsRows, filter: base.query.filter },
});
const directoryRow = (
	path: string,
	section: "staged" | "unstaged" = "unstaged",
): GitStatusPageStatsRow => ({
	type: "directory",
	section,
	path,
});
const fileRow = (
	path: string,
	section: "staged" | "unstaged" = "unstaged",
): GitStatusPageStatsRow => ({
	type: "file",
	section,
	path,
});
const lineStats = (files: GitLineStats["files"]): GitLineStats => ({
	files,
	linesAdded: 0,
	linesRemoved: 0,
	complete: true,
});

describe("worker snapshot statistics", () => {
	test("254 real untracked directory members are complete beyond the first status page", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "nf-git-page-lines-"));
		const engine = new GitStatusPageEngine();
		try {
			const initialized = await safeSpawn({
				cmd: ["git", "--no-optional-locks", "init", "-q"],
				cwd,
				timeout: 15_000,
			});
			if (initialized.exitCode) throw new Error(initialized.stderr);
			await mkdir(join(cwd, "directory"));
			const paths = Array.from({ length: 254 }, (_, index) => `directory/file-${index}`);
			for (const path of paths) await writeFile(join(cwd, path), "one\ntwo");
			const page = await engine.read(request(), signal, async () =>
				raw(paths.map((path) => `?? ${path}\0`).join("")),
			);
			expect(page.files).toHaveLength(100);
			expect(page.hasMore).toBe(true);
			const result = await engine.readStats(
				statsRequest(page.snapshotId, [directoryRow("directory"), fileRow(paths[253])]),
				signal,
				(sourceSignal) => getGitLineStats(cwd, sourceSignal),
			);
			expect(result.rows).toEqual([
				{ ...directoryRow("directory"), added: 508, removed: 0, complete: true },
				{ ...fileRow(paths[253]), added: 2, removed: 0, complete: true },
			]);
		} finally {
			engine.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("561 directory members and files beyond 200 are measured from the first page, with one cached index", async () => {
		const engine = new GitStatusPageEngine();
		const paths = Array.from(
			{ length: 561 },
			(_, index) => `目录/sub/file-${String(index).padStart(4, "0")}`,
		);
		const page = await engine.read(request(), signal, async () =>
			raw(paths.map((path) => `?? ${path}\0`).join("")),
		);
		expect(page.files).toHaveLength(100);
		expect(page.hasMore).toBe(true);
		const before = engine.stats.bytes;
		let reads = 0;
		const source = async () => {
			reads++;
			return lineStats(
				paths.map((path) => ({
					path,
					unstagedLinesAdded: 2,
					unstagedLinesRemoved: 1,
					complete: true,
				})),
			);
		};
		const result = await engine.readStats(
			statsRequest(page.snapshotId, [
				directoryRow("目录"),
				directoryRow("目录/sub"),
				fileRow(paths[560]),
			]),
			signal,
			source,
		);
		expect(result).toEqual({
			snapshotId: page.snapshotId,
			rows: [
				{ ...directoryRow("目录"), added: 1122, removed: 561, complete: true },
				{ ...directoryRow("目录/sub"), added: 1122, removed: 561, complete: true },
				{ ...fileRow(paths[560]), added: 2, removed: 1, complete: true },
			],
		});
		expect(engine.stats.statisticsEntries).toBe(563);
		expect(engine.stats.bytes - before).toBe(engine.stats.statisticsBytes);
		const retained = engine.stats.bytes;
		await engine.readStats(statsRequest(page.snapshotId, [fileRow(paths[200])]), signal, source);
		expect(reads).toBe(1);
		expect(engine.stats.bytes).toBe(retained);
		engine.releaseSnapshot(page.snapshotId);
		expect(engine.stats.bytes).toBe(0);
		expect(engine.stats.statisticsEntries).toBe(0);
	});

	test("section/filter, component boundaries, compressed directories, rename and binary zero retain exact membership", async () => {
		const engine = new GitStatusPageEngine();
		const stdout =
			"AM a/sub/双 名\0MM a/both\0R  a/new name\0old/name\0 M ab/not-a\0?? a/binary\0 M partial/file\0 M partial/one-sided\0";
		const source = async () =>
			lineStats([
				{
					path: "a/sub/双 名",
					stagedLinesAdded: 3,
					stagedLinesRemoved: 1,
					unstagedLinesAdded: 4,
					unstagedLinesRemoved: 2,
					complete: true,
				},
				{
					path: "a/both",
					stagedLinesAdded: 5,
					stagedLinesRemoved: 2,
					unstagedLinesAdded: 6,
					unstagedLinesRemoved: 3,
					complete: true,
				},
				{ path: "a/new name", stagedLinesAdded: 7, stagedLinesRemoved: 4, complete: true },
				{ path: "ab/not-a", unstagedLinesAdded: 100, unstagedLinesRemoved: 100, complete: true },
				{ path: "a/binary", unstagedLinesAdded: 0, unstagedLinesRemoved: 0, complete: true },
				{ path: "partial/file", unstagedLinesAdded: 8, unstagedLinesRemoved: 2, complete: false },
				{ path: "partial/one-sided", unstagedLinesAdded: 9, complete: false },
			]);
		const page = await engine.read(request(), signal, async () => raw(stdout));
		const requested = [
			directoryRow("a", "staged"),
			directoryRow("a"),
			directoryRow("a/sub"),
			directoryRow("old", "staged"),
			fileRow("a/new name", "staged"),
			fileRow("a/binary"),
			directoryRow("partial"),
			fileRow("partial/file"),
			fileRow("absent"),
			fileRow("partial/one-sided"),
		];
		const result = await engine.readStats(statsRequest(page.snapshotId, requested), signal, source);
		expect(result.rows).toEqual([
			{ ...requested[0], added: 15, removed: 7, complete: true },
			{ ...requested[1], added: 10, removed: 5, complete: true },
			{ ...requested[2], added: 4, removed: 2, complete: true },
			{ ...requested[3], complete: false },
			{ ...requested[4], added: 7, removed: 4, complete: true },
			{ ...requested[5], added: 0, removed: 0, complete: true },
			{ ...requested[6], added: undefined, removed: undefined, complete: false },
			{ ...requested[7], added: 8, removed: 2, complete: false },
			{ ...requested[8], complete: false },
			{ ...requested[9], added: 9, complete: false },
		]);
		const filtered = request({ filter: ["M"] });
		const filteredPage = await engine.read(filtered, signal, async () => raw(stdout));
		expect(
			(
				await engine.readStats(
					statsRequest(
						filteredPage.snapshotId,
						[directoryRow("a", "staged"), directoryRow("a"), fileRow("a/sub/双 名", "staged")],
						filtered,
					),
					signal,
					source,
				)
			).rows,
		).toEqual([
			{ ...directoryRow("a", "staged"), added: 5, removed: 2, complete: true },
			{ ...directoryRow("a"), added: 10, removed: 5, complete: true },
			{ ...fileRow("a/sub/双 名", "staged"), complete: false },
		]);
		engine.close();
	});

	test("rename statistics require the current path even when the old path has a complete independent measurement", async () => {
		for (const reusedOldPath of [false, true]) {
			const engine = new GitStatusPageEngine();
			const page = await engine.read(request(), signal, async () =>
				raw(`R  dir/b\0dir/a\0${reusedOldPath ? "?? dir/a\0" : ""}`),
			);
			const requested = [
				fileRow("dir/b", "staged"),
				directoryRow("dir", "staged"),
				fileRow("dir/a"),
				directoryRow("dir"),
			];
			const result = await engine.readStats(
				statsRequest(page.snapshotId, requested),
				signal,
				async () => ({
					...lineStats([
						{
							path: "dir/a",
							stagedLinesAdded: 7,
							stagedLinesRemoved: 2,
							unstagedLinesAdded: 11,
							unstagedLinesRemoved: 3,
							complete: true,
						},
					]),
					complete: false,
				}),
			);
			expect(result.rows[0]).toEqual({ ...requested[0], complete: false });
			expect(result.rows[1].complete).toBe(false);
			expect(result.rows[1].added).toBeUndefined();
			expect(result.rows[1].removed).toBeUndefined();
			for (const index of [2, 3]) {
				if (reusedOldPath)
					expect(result.rows[index]).toEqual({
						...requested[index],
						added: 11,
						removed: 3,
						complete: true,
					});
				else expect(result.rows[index]).toEqual({ ...requested[index], complete: false });
			}
			engine.close();
		}
	});

	test("incomplete status, missing measurements and source failures never manufacture directory zeros", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.read(request(), signal, async () =>
			raw("?? a/one\0?? a/two\0", false),
		);
		const source = async () =>
			lineStats([
				{ path: "a/one", unstagedLinesAdded: 0, unstagedLinesRemoved: 0, complete: true },
			]);
		const requested = [directoryRow("a"), fileRow("a/one"), fileRow("a/two")];
		const result = await engine.readStats(statsRequest(page.snapshotId, requested), signal, source);
		expect(result.rows[0]).toMatchObject({ complete: false });
		expect(result.rows[0].added).toBeUndefined();
		expect(result.rows[1]).toMatchObject({ added: 0, removed: 0, complete: true });
		expect(result.rows[2].added).toBeUndefined();
		engine.invalidateStats(request().scope.queryKey);
		const failed = await engine.readStats(
			statsRequest(page.snapshotId, requested),
			signal,
			async () => {
				throw new Error("unsupported");
			},
		);
		expect(failed.rows.every((row) => !row.complete && row.added === undefined)).toBe(true);
		engine.close();
	});

	test("invalid/unknown and cross-identity or filter requests never read the measurement source", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.read(request({ filter: ["A"] }), signal, async () =>
			raw("?? a/file\0"),
		);
		const base = statsRequest(page.snapshotId, [directoryRow("a")], request({ filter: ["A"] }));
		let reads = 0;
		const source = async () => {
			reads++;
			return lineStats([]);
		};
		for (const changed of [
			{ ...base, scope: { ...base.scope, actorId: "bob" } },
			{ ...base, scope: { ...base.scope, workspaceKey: "other" } },
			{ ...base, scope: { ...base.scope, queryKey: "other" } },
			{ ...base, source: { kind: "remote" as const, identity: "device:8:/root" } },
			{
				...base,
				query: { filter: ["M" as const] },
				statsQuery: { ...base.statsQuery, filter: ["M" as const] },
			},
			{ ...base, statsQuery: { ...base.statsQuery, snapshotId: "unknown" } },
		])
			await expect(engine.readStats(changed, signal, source)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_EXPIRED",
			});
		for (const invalidRows of [
			[],
			Array.from({ length: 201 }, () => directoryRow("a")),
			[{ type: "bad", section: "unstaged", path: "a" }],
		])
			await expect(
				engine.readStats(
					{
						...base,
						statsQuery: { ...base.statsQuery, rows: invalidRows as GitStatusPageStatsRow[] },
					},
					signal,
					source,
				),
			).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_QUERY" });
		expect(reads).toBe(0);
		engine.close();
	});

	test("5-second caching, facts epochs and shared pending reads preserve the file page chain", async () => {
		let now = 0;
		const engine = new GitStatusPageEngine(
			{ snapshots: 8, bytes: 64 * 1024 * 1024, idleMs: 120_000 },
			() => now,
		);
		const page = await engine.read(request({ limit: 1 }), signal, async () =>
			raw("?? a/one\0?? a/two\0"),
		);
		const stats = statsRequest(page.snapshotId, [directoryRow("a")]);
		let reads = 0;
		const source = async () => {
			reads++;
			return lineStats(
				["a/one", "a/two"].map((path) => ({
					path,
					unstagedLinesAdded: reads,
					unstagedLinesRemoved: 0,
					complete: true,
				})),
			);
		};
		expect((await engine.readStats(stats, signal, source)).rows[0].added).toBe(2);
		now = 4999;
		await engine.readStats(stats, signal, source);
		expect(reads).toBe(1);
		now = 5000;
		expect((await engine.readStats(stats, signal, source)).rows[0].added).toBe(4);
		engine.invalidateStats(request().scope.queryKey);
		expect(engine.stats.statisticsBytes).toBe(0);
		const next = await engine.read(
			request({ limit: 1, cursor: page.nextCursor as string }),
			signal,
			noRemote,
		);
		expect(next.snapshotId).toBe(page.snapshotId);
		const delayed = deferred<GitLineStats>();
		const controller = new AbortController();
		const first = engine
			.readStats(stats, controller.signal, () => {
				reads++;
				return delayed.promise;
			})
			.catch((error) => error);
		const second = engine.readStats(stats, signal, source);
		controller.abort(new Error("cancelled owner"));
		expect((await first).message).toBe("cancelled owner");
		delayed.resolve(
			lineStats(
				["a/one", "a/two"].map((path) => ({
					path,
					unstagedLinesAdded: 7,
					unstagedLinesRemoved: 0,
					complete: true,
				})),
			),
		);
		expect((await second).rows[0].added).toBe(14);
		expect(reads).toBe(3);
		engine.close();
	});

	test("facts invalidation, idle expiry, eviction and cancellation reject late measurements", async () => {
		for (const event of ["facts", "expiry", "eviction", "cancel"] as const) {
			let now = 0;
			const engine = new GitStatusPageEngine(
				{ snapshots: 1, bytes: 64 * 1024 * 1024, idleMs: 1000 },
				() => now,
			);
			const page = await engine.read(request(), signal, async () => raw("?? a/file\0"));
			const delayed = deferred<GitLineStats>();
			const controller = new AbortController();
			let aborted = false;
			const pending = engine
				.readStats(
					statsRequest(page.snapshotId, [directoryRow("a")]),
					controller.signal,
					(readSignal) => {
						readSignal.addEventListener(
							"abort",
							() => {
								aborted = true;
							},
							{ once: true },
						);
						return delayed.promise;
					},
				)
				.catch((error) => error);
			if (event === "facts") engine.invalidateStats(request().scope.queryKey);
			if (event === "expiry") {
				now = 1000;
				engine.prune();
			}
			if (event === "eviction") await engine.read(request(), signal, async () => raw("?? other\0"));
			if (event === "cancel") controller.abort(new Error("cancelled"));
			const error = await pending;
			expect(error).toBeInstanceOf(Error);
			expect(aborted).toBe(true);
			delayed.resolve(
				lineStats([
					{ path: "a/file", unstagedLinesAdded: 100, unstagedLinesRemoved: 0, complete: true },
				]),
			);
			await Promise.resolve();
			expect(engine.stats.statisticsBytes).toBe(0);
			engine.close();
		}
	});

	test("statistics requests and responses use the existing page byte cap", async () => {
		const engine = new GitStatusPageEngine();
		const path = `${"a".repeat(1240)}/file`;
		const page = await engine.read(request(), signal, async () => raw(`?? ${path}\0`));
		const requested = Array.from({ length: 200 }, () => fileRow(path));
		expect(Buffer.byteLength(JSON.stringify(requested))).toBeLessThan(GIT_STATUS_PAGE_MAX_BYTES);
		await expect(
			engine.readStats(statsRequest(page.snapshotId, requested), signal, async () =>
				lineStats([{ path, unstagedLinesAdded: 1, unstagedLinesRemoved: 0, complete: true }]),
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_RECORD_TOO_LARGE" });
		await expect(
			engine.readStats(
				statsRequest(
					page.snapshotId,
					Array.from({ length: 200 }, () => fileRow("a".repeat(1400))),
				),
				signal,
				async () => lineStats([]),
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_QUERY" });
		engine.close();
	});

	test("statistics mapping is charged to the existing cache budget", async () => {
		const probe = new GitStatusPageEngine();
		await probe.read(request(), signal, async () => raw("?? a/deep/file\0"));
		const baseBytes = probe.stats.bytes;
		probe.close();
		const engine = new GitStatusPageEngine({ snapshots: 8, bytes: baseBytes + 1, idleMs: 120_000 });
		const page = await engine.read(request(), signal, async () => raw("?? a/deep/file\0"));
		await expect(
			engine.readStats(statsRequest(page.snapshotId, [directoryRow("a")]), signal, async () =>
				lineStats([]),
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_BUSY" });
		expect(engine.stats.bytes).toBe(baseBytes);
		expect(engine.stats.statisticsBytes).toBe(0);
		engine.close();
	});
});

describe("worker snapshot engine", () => {
	test("more than 561 files page to EOF exactly once without repeating source reads", async () => {
		const engine = new GitStatusPageEngine();
		let scans = 0;
		let page = await engine.read(request(), signal, async () => {
			scans++;
			return raw(`${rows(562)}R  中文 新\0中文 旧\0AM dual\0MM modified\0`);
		});
		const paths: string[] = [];
		const snapshotId = page.snapshotId;
		while (true) {
			expect(page.files.length).toBeLessThanOrEqual(100);
			expect(page.snapshotId).toBe(snapshotId);
			expect(page.counts).toMatchObject({
				totalFiles: 565,
				staged: 3,
				unstaged: 2,
				untracked: 562,
				filteredFiles: 565,
				filteredStaged: 3,
				filteredUnstaged: 564,
				exact: true,
			});
			paths.push(...page.files.map((file) => file.path));
			if (!page.nextCursor) break;
			page = await engine.read(request({ cursor: page.nextCursor }), signal, noRemote);
		}
		expect(scans).toBe(1);
		expect(paths).toHaveLength(565);
		expect(new Set(paths).size).toBe(565);
		expect(page).toMatchObject({ hasMore: false, nextCursor: null, complete: true });
		engine.close();
	});

	test("filters match the union of per-section badges while badge counts stay unfiltered", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.read(request({ filter: ["M"] }), signal, async () =>
			raw("AM dual\0MM both\0?? added\0D  gone\0UU conflicted\0"),
		);
		expect(page.files.map((file) => file.path)).toEqual(["both", "dual"]);
		expect(page.counts).toMatchObject({
			totalFiles: 5,
			filteredFiles: 2,
			filteredStaged: 1,
			filteredUnstaged: 2,
			badgeCounts: { A: 2, M: 3, D: 1, U: 2 },
		});
		engine.close();
	});

	test("cursor is signed and bound to actor, workspace, query, source generation and page size", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.read(request({ limit: 1, filter: ["A", "M"] }), signal, async () =>
			raw(rows(3)),
		);
		const cursor = page.nextCursor as string;
		const base = request({ cursor, limit: 1, filter: ["A", "M"] });
		for (const changed of [
			{ ...base, scope: { ...base.scope, actorId: "bob" } },
			{ ...base, scope: { ...base.scope, workspaceKey: "other" } },
			{ ...base, scope: { ...base.scope, queryKey: "other" } },
			{ ...base, source: { kind: "remote" as const, identity: "device:8:/root" } },
			{ ...base, query: { ...base.query, filter: ["M" as const] } },
			{ ...base, query: { ...base.query, limit: 2 } },
			{ ...base, query: { ...base.query, cursor: `x${cursor}` } },
		])
			await expect(engine.read(changed, signal, noRemote)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_INVALID_CURSOR",
			});
		const normalized = await engine.read(
			{ ...base, query: { ...base.query, filter: ["M", "A"] } },
			signal,
			noRemote,
		);
		expect(normalized.files).toHaveLength(1);
		engine.close();
	});

	test("incomplete last page never advertises exact totals or natural completion", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request({ limit: 1 }), signal, async () => ({
			stdout: rows(2),
			complete: false,
			limitReason: "remote-truncated",
		}));
		const last = await engine.read(
			request({ limit: 1, cursor: first.nextCursor as string }),
			signal,
			noRemote,
		);
		expect(last).toMatchObject({
			hasMore: false,
			nextCursor: null,
			complete: false,
			limitReason: "remote-truncated",
			counts: { totalFiles: 2, exact: false },
		});
		engine.close();
	});

	test("snapshot count, global bytes and idle expiry are bounded", async () => {
		let now = 0;
		const engine = new GitStatusPageEngine(
			{ snapshots: 2, bytes: 64 * 1024 * 1024, idleMs: 1000 },
			() => now,
		);
		const first = await engine.read(request({ limit: 1 }), signal, async () => raw(rows(2)));
		expect(first.expiresAt).toBe(1000);
		await engine.read(request(), signal, async () => raw(rows(2)));
		await engine.read(request(), signal, async () => raw(rows(2)));
		expect(engine.stats.snapshots).toBe(2);
		await expect(
			engine.read(request({ limit: 1, cursor: first.nextCursor as string }), signal, noRemote),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		now = 1000;
		engine.prune();
		expect(engine.stats).toEqual({
			snapshots: 0,
			bytes: 0,
			statisticsBytes: 0,
			statisticsEntries: 0,
		});
		engine.close();
		const singleBudget = 6000;
		const bounded = new GitStatusPageEngine({ snapshots: 8, bytes: singleBudget, idleMs: 120_000 });
		await bounded.read(request(), signal, async () => raw(rows(3)));
		await bounded.read(request(), signal, async () => raw(rows(3)));
		expect(bounded.stats.snapshots).toBe(1);
		expect(bounded.stats.bytes).toBeLessThanOrEqual(singleBudget);
		bounded.close();
	});

	test("page byte cap advances a stable cursor and oversized records fail explicitly", async () => {
		const engine = new GitStatusPageEngine();
		const stdout = Array.from(
			{ length: 8 },
			(_, index) => `?? ${index}${"x".repeat(50_000)}\0`,
		).join("");
		let page = await engine.read(request({ limit: 200 }), signal, async () => raw(stdout));
		let count = 0;
		while (true) {
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
				GIT_STATUS_PAGE_MAX_BYTES,
			);
			count += page.files.length;
			if (!page.nextCursor) break;
			page = await engine.read(request({ limit: 200, cursor: page.nextCursor }), signal, noRemote);
		}
		expect(count).toBe(8);
		await expect(
			engine.read(request(), signal, async () =>
				raw(`?? ${"x".repeat(GIT_STATUS_PAGE_MAX_BYTES)}\0`),
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_RECORD_TOO_LARGE" });
		engine.close();
	});

	test("invalidation rejects in-flight publication and nested local cursors", async () => {
		const engine = new GitStatusPageEngine();
		const source = deferred<GitStatusPageRawResult>();
		const pending = engine.read(request(), signal, () => source.promise);
		engine.invalidate(request().scope.queryKey);
		source.resolve(raw(rows(2)));
		await expect(pending).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(engine.stats.snapshots).toBe(0);
		expect(gitStatusPageScopesOverlap('["local","/repo/sub"]', '["local","/repo"]')).toBe(true);
		expect(gitStatusPageScopesOverlap('["local","/repository"]', '["local","/repo"]')).toBe(false);
		expect(gitStatusPageScopesOverlap('["remote","d",1,"/repo"]', '["remote","d",2,"/repo"]')).toBe(
			false,
		);
		engine.close();
	});

	test("nested local invalidation expires cached cursors and idle touches extend expiry", async () => {
		let now = 0;
		let scans = 0;
		const engine = new GitStatusPageEngine(
			{ snapshots: 8, bytes: 64 * 1024 * 1024, idleMs: 1000 },
			() => now,
			async () => {
				scans++;
				return parseGitStatusPageRaw(raw(rows(3)));
			},
		);
		const local: GitStatusPageRequest = {
			...request({ limit: 1 }),
			scope: { ...request().scope, queryKey: '["local","/repo/sub"]' },
			source: { kind: "local", cwd: "/repo/sub" },
		};
		const first = await engine.read(local, signal, noRemote);
		now = 900;
		engine.invalidate('["local","/repository"]');
		const second = await engine.read(
			{ ...local, query: { limit: 1, cursor: first.nextCursor as string } },
			signal,
			noRemote,
		);
		expect(second.expiresAt).toBe(1900);
		expect(scans).toBe(1);
		engine.invalidate('["local","/repo"]');
		await expect(
			engine.read(
				{ ...local, query: { limit: 1, cursor: second.nextCursor as string } },
				signal,
				noRemote,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		engine.close();
	});

	test("invalid page limits reject before loading source", async () => {
		const engine = new GitStatusPageEngine();
		for (const limit of [0, -1, 201, 1.5, Number.NaN])
			await expect(engine.read(request({ limit }), signal, noRemote)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_INVALID_QUERY",
			});
		engine.close();
	});
});
