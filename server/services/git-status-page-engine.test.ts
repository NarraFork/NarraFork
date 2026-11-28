import { describe, expect, spyOn, test } from "bun:test";
import type { GitLineStats } from "../../shared/git-line-stats";
import {
	GIT_STATUS_PAGE_MAX_BYTES,
	type GitStatusPageQuery,
	type GitStatusPageResult,
	type GitStatusPageStatsResponse,
	type GitStatusPageStatsRow,
	gitStatusBadgeChar,
	gitStatusMatchesSection,
} from "../../shared/git-status-page";
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

const signal = new AbortController().signal;
const request = (query: GitStatusPageQuery = {}): GitStatusPageRequest => ({
	scope: { actorId: "alice", workspaceKey: "workspace", queryKey: '["remote","device",7,"/root"]' },
	query,
	source: { kind: "remote", identity: "device:7:/root" },
});
const raw = (stdout: string, complete = true): GitStatusPageRawResult => ({ stdout, complete });
const rows = (count: number) =>
	Array.from({ length: count }, (_, i) => `?? file-${String(i).padStart(5, "0")}\0`).join("");
const noRemote = async (): Promise<GitStatusPageRawResult> => {
	throw new Error("GET must not scan");
};
function ready<T extends GitStatusPageResult | GitStatusPageStatsResponse>(
	value: T,
): Extract<T, { status: "ready" }> {
	if (value.status !== "ready") throw new Error(`Expected ready: ${JSON.stringify(value)}`);
	return value as Extract<T, { status: "ready" }>;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const stats = (files: GitLineStats["files"] = []): GitLineStats => ({
	files,
	linesAdded: 0,
	linesRemoved: 0,
	complete: true,
});
const directory = (
	path: string,
	section: "staged" | "unstaged" = "unstaged",
): GitStatusPageStatsRow => ({ type: "directory", path, section });
const file = (
	path: string,
	section: "staged" | "unstaged" = "unstaged",
): GitStatusPageStatsRow => ({ type: "file", path, section });
function statsRequest(
	snapshotId: string,
	rows: GitStatusPageStatsRow[],
	base = request(),
): GitStatusPageRequest {
	return {
		...base,
		operation: "stats",
		statsQuery: { snapshotId, rows, filter: base.query.filter },
	};
}

describe("legacy on-demand reads", () => {
	test("invalidated measurements remain accounted until their source actually settles", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.readOnDemand(request(), signal, async () => raw(rows(1)));
		const measurement = deferred<GitLineStats>();
		const pending = engine.readStatsOnDemand(
			statsRequest(page.snapshotId, [file("file-00000")]),
			signal,
			() => measurement.promise,
		);
		const rejected = pending.catch((error: unknown) => error);
		engine.invalidate(request().scope.queryKey);
		expect(await rejected).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(engine.stats.bytes).toBeGreaterThan(0);
		measurement.resolve(stats());
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(engine.stats.bytes).toBe(0);
		engine.close();
	});

	test("empty repositories keep the old page DTO without pending/cache fields", async () => {
		const engine = new GitStatusPageEngine();
		const page = await engine.readOnDemand(request(), signal, async () => raw(""));
		expect(page.files).toEqual([]);
		expect(page.counts.totalFiles).toBe(0);
		expect(page.complete).toBe(true);
		expect(page).not.toHaveProperty("status");
		expect(page).not.toHaveProperty("cache");
		engine.close();
	});

	test("source errors reject rather than returning pending or a fake empty success", async () => {
		const engine = new GitStatusPageEngine();
		let scans = 0;
		await expect(
			engine.readOnDemand(request(), signal, async () => {
				scans++;
				throw new Error("offline");
			}),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_SOURCE_FAILED" });
		expect(scans).toBe(1);
		const page = await engine.readOnDemand(request(), signal, async () => raw(rows(1)));
		expect(page.files).toHaveLength(1);
		engine.close();
	});

	test("unsubscribed legacy readers refresh membership and measurements after five seconds", async () => {
		let now = 0;
		let scans = 0;
		let measurements = 0;
		const engine = new GitStatusPageEngine(undefined, () => now);
		const read = async () => {
			scans++;
			return raw(rows(now < 5000 ? 1 : 2));
		};
		const measure = async () => {
			measurements++;
			return stats([
				{
					path: "file-00000",
					unstagedLinesAdded: measurements,
					unstagedLinesRemoved: 0,
					complete: true,
				},
			]);
		};
		const first = await engine.readOnDemand(request(), signal, read);
		const query = statsRequest(first.snapshotId, [file("file-00000")]);
		expect((await engine.readStatsOnDemand(query, signal, measure)).rows[0]?.added).toBe(1);
		now = 4999;
		expect((await engine.readOnDemand(request(), signal, read)).snapshotId).toBe(first.snapshotId);
		expect((await engine.readStatsOnDemand(query, signal, measure)).rows[0]?.added).toBe(1);
		expect(scans).toBe(1);
		expect(measurements).toBe(1);
		now = 5000;
		expect((await engine.readStatsOnDemand(query, signal, measure)).rows[0]?.added).toBe(2);
		const fresh = await engine.readOnDemand(request(), signal, read);
		expect(fresh.snapshotId).not.toBe(first.snapshotId);
		expect(fresh.files).toHaveLength(2);
		await expect(engine.readStatsOnDemand(query, signal, measure)).rejects.toMatchObject({
			code: "GIT_STATUS_PAGE_EXPIRED",
		});
		expect(scans).toBe(2);
		expect(measurements).toBe(2);
		engine.close();
	});
});

describe("shared section semantics", () => {
	test("AM/MM, untracked and pair-wide conflicts retain section badges", () => {
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
	test("one-byte UTF-8 chunks retain NUL, spaces, newlines and both rename paths", () => {
		const parser = new GitStatusPageParser();
		for (const byte of new TextEncoder().encode("R  新 名\n.txt\0旧 名\n.txt\0AM tracked\0?? 新\0"))
			expect(parser.push(new Uint8Array([byte]))).toBe(true);
		parser.finish(true);
		expect(parser.files).toEqual([
			{ status: "R ", path: "新 名\n.txt", oldPath: "旧 名\n.txt" },
			{ status: "AM", path: "tracked" },
			{ status: "??", path: "新" },
		]);
	});
	test("an unfinished rename is excluded and natural EOF rejects it", () => {
		const parser = new GitStatusPageParser();
		parser.push(new TextEncoder().encode("?? first\0R  new\0old"));
		expect(parser.files).toEqual([{ status: "??", path: "first" }]);
		expect(() => parser.finish(true)).toThrow("Incomplete Git status record");
		expect(
			parseGitStatusPageRaw({
				stdout: "?? first\0R  new\0old",
				complete: false,
				limitReason: "remote-truncated",
			}),
		).toMatchObject({
			files: [{ status: "??", path: "first" }],
			complete: false,
			limitReason: "remote-truncated",
		});
	});
	test("record/byte limits retain whole records and remote completeness must be explicit", () => {
		const capped = parseGitStatusPageRaw(raw(rows(GIT_STATUS_PAGE_MAX_RECORDS + 1)));
		expect(capped.files).toHaveLength(GIT_STATUS_PAGE_MAX_RECORDS);
		expect(capped).toMatchObject({ complete: false, limitReason: "records" });
		expect(
			parseGitStatusPageRaw(raw(`?? ok\0?? ${"中".repeat(GIT_STATUS_PAGE_SCAN_BYTES)}\0`)),
		).toMatchObject({
			files: [{ status: "??", path: "ok" }],
			complete: false,
			limitReason: "bytes",
		});
		expect(parseGitStatusPageRaw({ stdout: "?? a\0" })).toMatchObject({
			complete: false,
			limitReason: "remote-incomplete",
		});
		expect(() => new GitStatusPageParser().push(new Uint8Array([255]))).toThrow();
	});
});

describe("published background observations", () => {
	test("cold GET is pending and repeated actors, filters and continuation never scan", async () => {
		let scans = 0;
		const engine = new GitStatusPageEngine();
		const source = async () => {
			scans++;
			return raw(`${rows(562)}R  中文 新\0中文 旧\0AM dual\0MM modified\0`);
		};
		expect(await engine.read(request(), signal, source)).toMatchObject({
			status: "pending",
			cache: { memberVersion: 0, statsVersion: 0 },
		});
		expect(scans).toBe(0);
		await engine.observe(request(), signal, source);
		let page = ready(await engine.read(request(), signal, source));
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
				filteredStaged: 3,
				filteredUnstaged: 564,
				exact: true,
			});
			paths.push(...page.files.map((entry) => entry.path));
			if (!page.nextCursor) break;
			page = ready(await engine.read(request({ cursor: page.nextCursor }), signal, source));
		}
		for (const actorId of ["alice", "bob"])
			for (const filter of [[], ["M"], ["A"]] as const)
				expect(
					ready(
						await engine.read(
							{ ...request({ filter: [...filter] }), scope: { ...request().scope, actorId } },
							signal,
							source,
						),
					).cache.memberVersion,
				).toBe(page.cache.memberVersion);
		expect(paths).toHaveLength(565);
		expect(new Set(paths).size).toBe(565);
		expect(scans).toBe(1);
		engine.close();
	});

	test("all actor/filter/limit GETs share prebuilt member projections without whole-index work", async () => {
		const engine = new GitStatusPageEngine();
		const build = spyOn(
			engine as unknown as { buildMemberProjections: (...args: unknown[]) => unknown },
			"buildMemberProjections",
		);
		await engine.observe(request(), signal, async () => raw(`${rows(561)}AM dual\0MM both\0`));
		expect(build).toHaveBeenCalledTimes(1);
		const retained = engine.stats.bytes;
		for (const actorId of ["alice", "bob", "carol"])
			for (const filter of [[], ["A"], ["M"], ["A", "M"]] as const)
				for (const limit of [1, 100, 200]) {
					const page = ready(
						await engine.read(
							{
								...request({ filter: [...filter], limit }),
								scope: { ...request().scope, actorId },
							},
							signal,
						),
					);
					expect(page.files.length).toBeLessThanOrEqual(limit);
				}
		expect(build).toHaveBeenCalledTimes(1);
		expect(engine.stats.bytes - retained).toBeLessThan(8 * 5000);
		build.mockRestore();
		engine.close();
	});

	test("members publish before statistics and 561 members use one full background index", async () => {
		const engine = new GitStatusPageEngine();
		const paths = Array.from({ length: 561 }, (_, i) => `目录/sub/file-${i}`);
		const delayed = deferred<GitLineStats>();
		const published = deferred<void>();
		let measurements = 0;
		const production = engine.observe(
			request(),
			signal,
			async () => raw(paths.map((path) => `?? ${path}\0`).join("")),
			async () => {
				measurements++;
				return delayed.promise;
			},
			() => published.resolve(),
		);
		await published.promise;
		const page = ready(await engine.read(request(), signal, noRemote));
		expect(page.cache).toMatchObject({ memberVersion: 1, statsVersion: 0, updating: true });
		expect(
			await engine.readStats(statsRequest(page.snapshotId, [directory("目录")]), signal),
		).toMatchObject({ status: "pending", cache: { memberVersion: 1, statsVersion: 0 } });
		delayed.resolve(
			stats(
				paths.map((path) => ({
					path,
					unstagedLinesAdded: 2,
					unstagedLinesRemoved: 1,
					complete: true,
				})),
			),
		);
		await production;
		const result = ready(
			await engine.readStats(
				statsRequest(page.snapshotId, [directory("目录"), directory("目录/sub"), file(paths[560])]),
				signal,
			),
		);
		expect(result.rows).toEqual([
			{ ...directory("目录"), added: 1122, removed: 561, complete: true },
			{ ...directory("目录/sub"), added: 1122, removed: 561, complete: true },
			{ ...file(paths[560]), added: 2, removed: 1, complete: true },
		]);
		const retained = engine.stats.bytes;
		await engine.readStats(statsRequest(page.snapshotId, [file(paths[200])]), signal, async () => {
			throw new Error("GET must not measure");
		});
		expect(engine.stats.bytes).toBe(retained);
		expect(measurements).toBe(1);
		engine.release(request().scope.queryKey);
		expect(engine.stats.bytes).toBe(0);
	});

	test("six status buckets combine directories per section/filter without rebuilding", async () => {
		const engine = new GitStatusPageEngine();
		const stdout =
			"AM a/sub/双 名\0MM a/both\0R  a/new\0old/name\0 M ab/not-a\0?? a/binary\0UU a/conflict\0";
		await engine.observe(
			request(),
			signal,
			async () => raw(stdout),
			async () =>
				stats([
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
					{ path: "a/new", stagedLinesAdded: 7, stagedLinesRemoved: 4, complete: true },
					{ path: "ab/not-a", unstagedLinesAdded: 100, unstagedLinesRemoved: 100, complete: true },
					{ path: "a/binary", unstagedLinesAdded: 0, unstagedLinesRemoved: 0, complete: true },
					{
						path: "a/conflict",
						stagedLinesAdded: 8,
						stagedLinesRemoved: 1,
						unstagedLinesAdded: 9,
						unstagedLinesRemoved: 1,
						complete: true,
					},
				]),
		);
		const retained = engine.stats.statisticsBytes;
		for (const [filter, staged, unstaged] of [
			[[], 23, 19],
			[["M"], 5, 10],
			[["A"], 3, 0],
			[["R"], 7, undefined],
			[["U"], 8, 9],
			[["M", "R"], 12, 10],
		] as const) {
			const base = request({ filter: [...filter] });
			const page = ready(await engine.read(base, signal));
			const result = ready(
				await engine.readStats(
					statsRequest(
						page.snapshotId,
						[directory("a", "staged"), directory("a"), file("a/binary")],
						base,
					),
					signal,
				),
			);
			expect(result.rows[0].added).toBe(staged);
			expect(result.rows[1].added).toBe(unstaged);
			expect(engine.stats.statisticsBytes).toBe(retained);
		}
		engine.close();
	});

	test("partial scan/measurement stays unknown while binary zero stays complete", async () => {
		const engine = new GitStatusPageEngine();
		await engine.observe(
			request(),
			signal,
			async () => raw("?? a/known\0?? a/unknown\0?? b/binary\0", false),
			async () =>
				stats([
					{ path: "a/known", unstagedLinesAdded: 3, unstagedLinesRemoved: 1, complete: true },
					{ path: "b/binary", unstagedLinesAdded: 0, unstagedLinesRemoved: 0, complete: true },
				]),
		);
		const page = ready(await engine.read(request(), signal));
		const result = ready(
			await engine.readStats(
				statsRequest(page.snapshotId, [
					directory("a"),
					file("a/known"),
					file("a/unknown"),
					file("b/binary"),
				]),
				signal,
			),
		);
		expect(page.complete).toBe(false);
		expect(result.rows).toEqual([
			{ ...directory("a"), complete: false },
			{ ...file("a/known"), added: 3, removed: 1, complete: true },
			{ ...file("a/unknown"), complete: false },
			{ ...file("b/binary"), added: 0, removed: 0, complete: true },
		]);
		engine.close();
	});

	test("same-member dirty retains last-good and advances only the statistics version", async () => {
		const engine = new GitStatusPageEngine();
		const source = async () => raw("?? dir/a\0?? dir/b\0");
		const measure = (added: number) =>
			stats([
				{ path: "dir/a", unstagedLinesAdded: added, unstagedLinesRemoved: 0, complete: true },
			]);
		await engine.observe(request(), signal, source, async () => measure(2));
		const page = ready(await engine.read(request({ limit: 1 }), signal));
		engine.invalidate(request().scope.queryKey);
		const unchanged = ready(await engine.read(request({ limit: 1 }), signal));
		expect(unchanged.snapshotId).toBe(page.snapshotId);
		expect(unchanged.cache.updating).toBe(true);
		expect(
			ready(await engine.readStats(statsRequest(page.snapshotId, [file("dir/a")]), signal)).rows[0]
				.added,
		).toBe(2);
		await engine.observe(request(), signal, source, async () => measure(5));
		const next = ready(
			await engine.read(request({ limit: 1, cursor: page.nextCursor as string }), signal),
		);
		expect(next.cache.memberVersion).toBe(page.cache.memberVersion);
		expect(next.cache.statsVersion).toBeGreaterThan(page.cache.statsVersion);
		expect(
			ready(await engine.readStats(statsRequest(page.snapshotId, [file("dir/a")]), signal)).rows[0]
				.added,
		).toBe(5);
		await engine.observe(request(), signal, async () => raw("?? dir/new\0"));
		await expect(
			engine.read(request({ limit: 1, cursor: page.nextCursor as string }), signal),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		await expect(
			engine.readStats(statsRequest(page.snapshotId, [file("dir/a")]), signal),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(ready(await engine.read(request(), signal)).cache.statsVersion).toBe(0);
		engine.close();
	});

	test("source errors publish error; failed updates retain explicitly marked last-good", async () => {
		const engine = new GitStatusPageEngine();
		const failing = async (): Promise<GitStatusPageRawResult> => {
			throw new Error("offline");
		};
		await engine.observe(request(), signal, failing);
		expect(await engine.read(request(), signal)).toMatchObject({
			status: "error",
			cache: { status: "error", updating: false, errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" },
		});
		await engine.observe(
			request(),
			signal,
			async () => raw("?? a\0"),
			async () =>
				stats([{ path: "a", unstagedLinesAdded: 2, unstagedLinesRemoved: 0, complete: true }]),
		);
		const page = ready(await engine.read(request(), signal));
		await engine.observe(request(), signal, failing);
		const retained = ready(await engine.read(request(), signal));
		expect(retained.snapshotId).toBe(page.snapshotId);
		expect(retained.cache).toMatchObject({
			updating: false,
			errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED",
			statsVersion: page.cache.statsVersion,
		});
		engine.close();
	});

	test("late dirty and older producers cannot overwrite current publications", async () => {
		const engine = new GitStatusPageEngine();
		const older = deferred<GitStatusPageRawResult>();
		const pending = engine.observe(request(), signal, () => older.promise).catch((error) => error);
		engine.invalidate(request().scope.queryKey);
		await engine.observe(request(), signal, async () => raw("?? current\0"));
		older.resolve(raw("?? obsolete\0"));
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(ready(await engine.read(request(), signal)).files[0].path).toBe("current");
		const delayed = deferred<GitStatusPageRawResult>();
		const validation = engine.validateSnapshots(request(), signal, () => delayed.promise);
		await engine.validateSnapshots(request(), signal, async () => raw("?? newest\0"));
		delayed.resolve(raw("?? current\0"));
		expect(await validation).toEqual({ changed: false, reliable: false });
		expect(ready(await engine.read(request(), signal)).files[0].path).toBe("newest");
		engine.close();
	});

	test("signed cursors and statistics identities isolate actors, filters, size and source generation", async () => {
		const engine = new GitStatusPageEngine();
		await engine.observe(request(), signal, async () => raw(rows(3)));
		const page = ready(await engine.read(request({ limit: 1, filter: ["A", "M"] }), signal));
		const base = request({ cursor: page.nextCursor as string, limit: 1, filter: ["A", "M"] });
		for (const changed of [
			{ ...base, scope: { ...base.scope, actorId: "bob" } },
			{ ...base, scope: { ...base.scope, workspaceKey: "other" } },
			{ ...base, scope: { ...base.scope, queryKey: "other" } },
			{ ...base, source: { kind: "remote" as const, identity: "device:8:/root" } },
			{ ...base, query: { ...base.query, filter: ["M" as const] } },
			{ ...base, query: { ...base.query, limit: 2 } },
			{ ...base, query: { ...base.query, cursor: `x${base.query.cursor}` } },
		])
			await expect(engine.read(changed, signal)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_INVALID_CURSOR",
			});
		await expect(
			engine.readStats(
				statsRequest(page.snapshotId, [file("file-00000")], {
					...request({ filter: ["A", "M"] }),
					scope: { ...base.scope, actorId: "bob" },
				}),
				signal,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(
			ready(await engine.read({ ...base, query: { ...base.query, filter: ["M", "A"] } }, signal))
				.files,
		).toHaveLength(1);
		engine.close();
	});

	test("bounded snapshots expire independently from shared observations and release frees all bytes", async () => {
		let now = 0;
		const engine = new GitStatusPageEngine(
			{ snapshots: 2, bytes: 64 * 1024 * 1024, idleMs: 1000 },
			() => now,
		);
		await engine.observe(request(), signal, async () => raw(rows(3)));
		const first = ready(await engine.read(request({ limit: 1 }), signal));
		await engine.read(request({ limit: 2 }), signal);
		await engine.read(request({ limit: 3 }), signal);
		expect(engine.stats.snapshots).toBe(2);
		await expect(
			engine.read(request({ limit: 1, cursor: first.nextCursor as string }), signal),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		now = 1000;
		engine.prune();
		expect(engine.stats.snapshots).toBe(0);
		expect(ready(await engine.read(request(), signal)).files).toHaveLength(3);
		engine.release(request().scope.queryKey);
		expect(engine.stats.bytes).toBe(0);
		expect((await engine.read(request(), signal)).status).toBe("pending");
		engine.close();
	});

	test("page byte limits advance cursors, oversized records and tiny budgets fail explicitly", async () => {
		const engine = new GitStatusPageEngine();
		await engine.observe(request(), signal, async () =>
			raw(Array.from({ length: 8 }, (_, i) => `?? ${i}${"x".repeat(50000)}\0`).join("")),
		);
		let page = ready(await engine.read(request({ limit: 200 }), signal));
		let count = 0;
		while (true) {
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
				GIT_STATUS_PAGE_MAX_BYTES,
			);
			count += page.files.length;
			if (!page.nextCursor) break;
			page = ready(await engine.read(request({ limit: 200, cursor: page.nextCursor }), signal));
		}
		expect(count).toBe(8);
		await engine.observe(request(), signal, async () =>
			raw(`?? ${"x".repeat(GIT_STATUS_PAGE_MAX_BYTES)}\0`),
		);
		await expect(engine.read(request(), signal)).rejects.toMatchObject({
			code: "GIT_STATUS_PAGE_RECORD_TOO_LARGE",
		});
		engine.close();
		const bounded = new GitStatusPageEngine({ snapshots: 2, bytes: 8192, idleMs: 1000 });
		expect(await bounded.observe(request(), signal, async () => raw(rows(100)))).toMatchObject({
			errorCode: "GIT_STATUS_PAGE_BUSY",
		});
		expect(bounded.stats.bytes).toBeLessThanOrEqual(8192);
		bounded.close();
	});

	test("eviction cancels late producers and counts retired observation references until they settle", async () => {
		const engine = new GitStatusPageEngine({ snapshots: 1, bytes: 1024 * 1024, idleMs: 1000 });
		await engine.observe(request(), signal, async () => raw(rows(3)));
		const delayed = deferred<GitLineStats>();
		const started = deferred<void>();
		const pending = engine
			.observe(
				request(),
				signal,
				async () => raw(rows(3)),
				async () => {
					started.resolve();
					return delayed.promise;
				},
			)
			.catch((error) => error);
		await started.promise;
		const oldBytes = engine.stats.bytes;
		const other = { ...request(), scope: { ...request().scope, queryKey: "other" } };
		await engine.observe(other, signal, async () => raw(rows(4)));
		expect(engine.stats.bytes).toBeGreaterThan(oldBytes);
		expect((await engine.read(request(), signal)).status).toBe("pending");
		delayed.resolve(stats());
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		const retained = engine.stats.bytes;
		expect(retained).toBeGreaterThan(0);
		expect(retained).toBeLessThan(oldBytes * 2);
		engine.release(other.scope.queryKey);
		expect(engine.stats.bytes).toBe(0);
	});

	test("statistics errors leave validated members usable and retain last-good numbers independently", async () => {
		const engine = new GitStatusPageEngine();
		const source = async () => raw("?? dir/a\0");
		const failed = async (): Promise<GitLineStats> => {
			throw new Error("statistics unavailable");
		};
		await engine.observe(request(), signal, source, failed);
		const page = ready(await engine.read(request(), signal));
		expect(page.cache.errorCode).toBeUndefined();
		expect(page.cache.statsErrorCode).toBe("GIT_STATUS_PAGE_SOURCE_FAILED");
		expect(
			(await engine.readStats(statsRequest(page.snapshotId, [file("dir/a")]), signal)).status,
		).toBe("error");
		expect(
			await engine.assertScope(
				{
					...request(),
					proof: { snapshotId: page.snapshotId, filter: [], section: "unstaged" },
					files: ["dir/a"],
				},
				signal,
				source,
			),
		).toBe(true);
		await engine.observe(request(), signal, source, async () =>
			stats([{ path: "dir/a", unstagedLinesAdded: 3, unstagedLinesRemoved: 0, complete: true }]),
		);
		await engine.observe(request(), signal, source, failed);
		const retained = ready(
			await engine.readStats(statsRequest(page.snapshotId, [file("dir/a")]), signal),
		);
		expect(retained.rows[0].added).toBe(3);
		expect(retained.cache.errorCode).toBeUndefined();
		expect(retained.cache.statsErrorCode).toBe("GIT_STATUS_PAGE_SOURCE_FAILED");
		await engine.observe(request(), signal, async () => {
			throw new Error("members unavailable");
		});
		expect(ready(await engine.read(request(), signal)).cache.errorCode).toBe(
			"GIT_STATUS_PAGE_SOURCE_FAILED",
		);
		engine.close();
	});

	test("rename statistics never borrow an old path's independent or reused measurement", async () => {
		for (const reused of [false, true]) {
			const engine = new GitStatusPageEngine();
			await engine.observe(
				request(),
				signal,
				async () => raw(`R  dir/new\0dir/old\0${reused ? "?? dir/old\0" : ""}`),
				async () =>
					stats([
						{
							path: "dir/old",
							stagedLinesAdded: 99,
							stagedLinesRemoved: 98,
							unstagedLinesAdded: 7,
							unstagedLinesRemoved: 0,
							complete: true,
						},
					]),
			);
			const page = ready(await engine.read(request(), signal));
			const result = ready(
				await engine.readStats(
					statsRequest(page.snapshotId, [
						file("dir/new", "staged"),
						directory("dir", "staged"),
						file("dir/old"),
					]),
					signal,
				),
			);
			expect(result.rows[0].complete).toBe(false);
			expect(result.rows[0].added).toBeUndefined();
			expect(result.rows[1].complete).toBe(false);
			expect(result.rows[2].added).toBe(reused ? 7 : undefined);
			engine.close();
		}
	});

	test("filtered row counts preserve unfiltered AM/MM/conflict badge counts", async () => {
		const engine = new GitStatusPageEngine();
		await engine.observe(request(), signal, async () =>
			raw("AM dual\0MM both\0?? added\0D  gone\0UU conflicted\0"),
		);
		const page = ready(await engine.read(request({ filter: ["M"] }), signal));
		expect(page.files.map((entry) => entry.path)).toEqual(["both", "dual"]);
		expect(page.counts).toMatchObject({
			totalFiles: 5,
			filteredFiles: 2,
			filteredStaged: 1,
			filteredUnstaged: 2,
			badgeCounts: { A: 2, M: 3, D: 1, U: 2 },
		});
		engine.close();
	});

	test("statistics output budget covers both row expansion and the final version envelope", async () => {
		const engine = new GitStatusPageEngine();
		await engine.observe(
			request(),
			signal,
			async () => raw("?? a\0"),
			async () => stats(),
		);
		const page = ready(await engine.read(request(), signal));
		const count = 64;
		const overhead = Buffer.byteLength(
			JSON.stringify({
				snapshotId: page.snapshotId,
				rows: Array.from({ length: count }, () => ({ ...file(""), complete: false })),
			}),
		);
		const nearLength = Math.floor((GIT_STATUS_PAGE_MAX_BYTES - 32 - overhead) / count);
		const below = ready(
			await engine.readStats(
				statsRequest(
					page.snapshotId,
					Array.from({ length: count }, () => file("x".repeat(nearLength - 8))),
				),
				signal,
			),
		);
		const belowBytes = Buffer.byteLength(JSON.stringify(below));
		expect(belowBytes).toBeLessThanOrEqual(GIT_STATUS_PAGE_MAX_BYTES);
		expect(belowBytes).toBeGreaterThan(GIT_STATUS_PAGE_MAX_BYTES - 1024);
		for (const length of [nearLength, nearLength + 10]) {
			const queries = Array.from({ length: count }, () => file("x".repeat(length)));
			await expect(
				engine.readStats(statsRequest(page.snapshotId, queries), signal),
			).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_RECORD_TOO_LARGE" });
		}
		engine.close();
	});

	test("nine active workspaces admit eight observations without scan/eviction churn", async () => {
		const engine = new GitStatusPageEngine();
		let scans = 0;
		const bases = Array.from({ length: 9 }, (_, i) => ({
			...request(),
			scope: { ...request().scope, queryKey: `workspace-${i}` },
		}));
		for (const base of bases) engine.retain(base.scope.queryKey);
		for (const base of bases)
			await engine.observe(base, signal, async () => {
				scans++;
				return raw(rows(2));
			});
		expect(scans).toBe(8);
		for (let round = 0; round < 3; round++)
			for (const base of bases) {
				const state = engine.cacheState(base);
				expect(state.status).toBe(base === bases[8] ? "error" : "ready");
			}
		expect(engine.cacheState(bases[8]).errorCode).toBe("GIT_STATUS_PAGE_BUSY");
		engine.release(bases[0].scope.queryKey);
		expect(engine.cacheState(bases[8]).status).toBe("pending");
		await engine.observe(bases[8], signal, async () => {
			scans++;
			return raw(rows(2));
		});
		expect(scans).toBe(9);
		for (const base of bases.slice(1)) expect(engine.cacheState(base).status).toBe("ready");
		engine.close();
	});

	test("scope overlap and invalid limits reject before any source access", async () => {
		expect(gitStatusPageScopesOverlap('["local","/repo/sub"]', '["local","/repo"]')).toBe(true);
		expect(gitStatusPageScopesOverlap('["local","/repository"]', '["local","/repo"]')).toBe(false);
		expect(gitStatusPageScopesOverlap('["remote","d",1,"/repo"]', '["remote","d",2,"/repo"]')).toBe(
			false,
		);
		const engine = new GitStatusPageEngine();
		for (const limit of [0, -1, 201, 1.5, Number.NaN])
			await expect(engine.read(request({ limit }), signal, noRemote)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_INVALID_QUERY",
			});
		engine.close();
	});
});
