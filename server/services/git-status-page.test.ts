import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Worker } from "node:worker_threads";
import type { GitLineStats } from "../../shared/git-line-stats";
import type {
	GitStatusPageResult,
	GitStatusPageStatsResponse,
	GitStatusPageStatsRow,
} from "../../shared/git-status-page";
import { logger } from "../lib/logger";
import { closeGitLineStatsWorkers, getGitLineStats } from "./git-line-stats";
import {
	type GitStatusPageRawResult,
	type GitStatusPageScope,
	GitStatusPageService,
} from "./git-status-page";

afterAll(closeGitLineStatsWorkers);
const exec = promisify(execFile);
const services: GitStatusPageService[] = [];
const fixtures: string[] = [];
const scope: GitStatusPageScope = {
	actorId: "alice",
	workspaceKey: "workspace",
	queryKey: '["remote","device",3,"/repo"]',
};
const sourceRows = (count: number) =>
	Array.from({ length: count }, (_, i) => `?? f-${String(i).padStart(4, "0")}\0`).join("");
const paths = Array.from({ length: 561 }, (_, i) => `目录/file-${String(i).padStart(4, "0")}`);
const source = {
	kind: "remote" as const,
	identity: "device:3:/repo",
	read: async () => ({ stdout: paths.map((path) => `?? ${path}\0`).join(""), complete: true }),
};
const stats = (added = 2): GitLineStats => ({
	files: paths.map((path) => ({
		path,
		unstagedLinesAdded: added,
		unstagedLinesRemoved: 1,
		complete: true,
	})),
	linesAdded: added * 561,
	linesRemoved: 561,
	complete: true,
});
const row: GitStatusPageStatsRow = { type: "directory", section: "unstaged", path: "目录" };
function ready<T extends GitStatusPageResult | GitStatusPageStatsResponse>(
	value: T,
): Extract<T, { status: "ready" }> {
	if (value.status !== "ready") throw new Error(`Expected ready: ${JSON.stringify(value)}`);
	return value as Extract<T, { status: "ready" }>;
}
function service() {
	const value = new GitStatusPageService();
	services.push(value);
	return value;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => null,
		(error: unknown) => error,
	);
}
async function fixture() {
	const path = await mkdtemp(join(tmpdir(), "git-status-page-"));
	fixtures.push(path);
	return path;
}
async function git(cwd: string, ...args: string[]) {
	await exec("git", args, { cwd, timeout: 15000, maxBuffer: 4096 });
}
afterEach(async () => {
	await Promise.all(services.splice(0).map((value) => value.close()));
	await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("slow page requests log bounded metadata on success and failure but fast reads stay quiet", async () => {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	let clock = 0;
	const now = spyOn(performance, "now").mockImplementation(() => clock);
	try {
		for (const fail of [false, true]) {
			const pages = service();
			const read = pages.readOnDemand({
				scope,
				query: {},
				source: {
					kind: "remote",
					identity: "secret repository identity",
					read: async () => {
						clock += 2_500;
						if (fail) throw new Error("secret transport failure");
						return { stdout: sourceRows(1), complete: true };
					},
				},
			});
			if (fail) expect(await rejected(read)).toBeInstanceOf(Error);
			else expect((await read).files).toHaveLength(1);
		}
		expect(warn.mock.calls).toEqual([
			["Slow Git status page operation", { operation: "read", durationMs: 2500, success: true }],
			["Slow Git status page operation", { operation: "read", durationMs: 2500, success: false }],
		]);
		const page = await service().readOnDemand({
			scope,
			query: {},
			source: {
				kind: "remote",
				identity: "fast",
				read: async () => ({ stdout: sourceRows(1), complete: true }),
			},
		});
		expect(page.files).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(2);
	} finally {
		now.mockRestore();
		warn.mockRestore();
	}
});

describe("shared background paging Worker", () => {
	test("cold GET never scans, production publishes files before statistics, all GETs remain read-only", async () => {
		const pages = service();
		let scans = 0;
		let measures = 0;
		const remote = {
			...source,
			read: async () => {
				scans++;
				return source.read();
			},
		};
		expect(await pages.read({ scope, source: remote, query: {} })).toMatchObject({
			status: "pending",
			cache: { memberVersion: 0, statsVersion: 0 },
		});
		expect(scans).toBe(0);
		const started = deferred<void>();
		const delayed = deferred<GitLineStats>();
		const production = pages.observe({
			queryKey: scope.queryKey,
			source: remote,
			readStats: async () => {
				measures++;
				started.resolve();
				return delayed.promise;
			},
		});
		await started.promise;
		const page = ready(await pages.read({ scope, source: remote, query: {} }));
		expect(page.files).toHaveLength(100);
		expect(page.cache).toMatchObject({ statsVersion: 0, updating: true });
		expect(
			await pages.readStats({
				scope,
				source: remote,
				query: { snapshotId: page.snapshotId, rows: [row] },
			}),
		).toMatchObject({
			status: "pending",
			cache: { memberVersion: page.cache.memberVersion, statsVersion: 0 },
		});
		delayed.resolve(stats());
		await production;
		const measured = ready(
			await pages.readStats({
				scope,
				source: remote,
				query: { snapshotId: page.snapshotId, rows: [row] },
				readStats: async () => {
					throw new Error("GET must not measure");
				},
			}),
		);
		expect(measured.rows).toEqual([{ ...row, added: 1122, removed: 561, complete: true }]);
		const collected = [...page.files];
		let current = page;
		while (current.nextCursor) {
			current = ready(
				await pages.read({ scope, source: remote, query: { cursor: current.nextCursor } }),
			);
			collected.push(...current.files);
		}
		expect(new Set(collected.map((file) => file.path)).size).toBe(561);
		await pages.read({
			scope: { ...scope, actorId: "bob" },
			source: remote,
			query: { filter: ["A"] },
		});
		expect(scans).toBe(1);
		expect(measures).toBe(1);
	});

	test("GET bypasses both occupied production slots and cancelling a GET leaves producers alive", async () => {
		const pages = service();
		const started = deferred<void>();
		const delayed = deferred<GitStatusPageRawResult>();
		const controller = new AbortController();
		let active = 0;
		const remote = {
			...source,
			read: async (signal: AbortSignal) => {
				active++;
				signal.addEventListener("abort", () => active--, { once: true });
				if (active === 2) started.resolve();
				return delayed.promise;
			},
		};
		const productions = ["first", "second"].map((queryKey) =>
			pages
				.observe({
					queryKey,
					source: remote,
					readStats: async () => stats(),
					signal: controller.signal,
				})
				.catch((error) => error),
		);
		await started.promise;
		const cancelled = new AbortController();
		cancelled.abort(new Error("viewport replaced"));
		await expect(
			pages.read({ scope, source: remote, query: {}, signal: cancelled.signal }),
		).rejects.toThrow("viewport replaced");
		expect((await pages.read({ scope, source: remote, query: {} })).status).toBe("pending");
		expect(active).toBe(2);
		delayed.resolve({ stdout: "?? done\0", complete: true });
		await Promise.all(productions);
	});

	test("dirty same-member cache keeps numbers and cursors until atomic replacement", async () => {
		const pages = service();
		await pages.observe({ queryKey: scope.queryKey, source, readStats: async () => stats() });
		const page = ready(await pages.read({ scope, source, query: {} }));
		pages.invalidateStats(scope.queryKey);
		const retained = ready(
			await pages.readStats({ scope, source, query: { snapshotId: page.snapshotId, rows: [row] } }),
		);
		expect(retained.cache.updating).toBe(true);
		expect(retained.rows[0].added).toBe(1122);
		await pages.observe({ queryKey: scope.queryKey, source, readStats: async () => stats(3) });
		const fresh = ready(
			await pages.readStats({ scope, source, query: { snapshotId: page.snapshotId, rows: [row] } }),
		);
		expect(fresh.cache.memberVersion).toBe(page.cache.memberVersion);
		expect(fresh.cache.statsVersion).toBeGreaterThan(page.cache.statsVersion);
		expect(fresh.rows[0].added).toBe(1683);
		expect(
			ready(await pages.read({ scope, source, query: { cursor: page.nextCursor as string } }))
				.snapshotId,
		).toBe(page.snapshotId);
	});

	test("Worker loss changes epoch and a cache GET never falls back to source computation", async () => {
		const pages = service();
		let scans = 0;
		const remote = {
			...source,
			read: async () => {
				scans++;
				return source.read();
			},
		};
		await pages.observe({
			queryKey: scope.queryKey,
			source: remote,
			readStats: async () => stats(),
		});
		const before = ready(await pages.read({ scope, source: remote, query: {} }));
		const worker = (pages as unknown as { worker: Worker }).worker;
		await worker.terminate();
		const cold = await pages.read({ scope, source: remote, query: {} });
		expect(cold.status).toBe("pending");
		expect(cold.cache.workerEpoch).not.toBe(before.cache.workerEpoch);
		expect(scans).toBe(1);
		await pages.observe({
			queryKey: scope.queryKey,
			source: remote,
			readStats: async () => stats(),
		});
		const after = ready(await pages.read({ scope, source: remote, query: {} }));
		expect(after.cache.workerEpoch).toBe(cold.cache.workerEpoch);
		expect(scans).toBe(2);
	});

	test("statistics identity and batch limits reject before any supplied source runs", async () => {
		const pages = service();
		await pages.observe({ queryKey: scope.queryKey, source, readStats: async () => stats() });
		const page = ready(await pages.read({ scope, source, query: {} }));
		let reads = 0;
		const options = {
			scope,
			source,
			query: { snapshotId: page.snapshotId, rows: [row] },
			readStats: async () => {
				reads++;
				return stats();
			},
		};
		for (const changed of [
			{ ...options, scope: { ...scope, actorId: "bob" } },
			{ ...options, scope: { ...scope, workspaceKey: "other" } },
			{ ...options, scope: { ...scope, queryKey: "other" } },
			{ ...options, source: { ...source, identity: "device:4:/repo" } },
			{ ...options, query: { ...options.query, filter: ["M" as const] } },
			{ ...options, query: { ...options.query, snapshotId: "unknown" } },
		])
			expect(await pages.readStats(changed).catch((error: unknown) => error)).toMatchObject({
				code: "GIT_STATUS_PAGE_EXPIRED",
			});
		expect(
			await rejected(
				pages.readStats({
					...options,
					query: { ...options.query, rows: Array.from({ length: 201 }, () => row) },
				}),
			),
		).toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_QUERY" });
		expect(reads).toBe(0);
	});

	test("full porcelain decoding and directory index construction never run on the parent thread", async () => {
		const pages = service();
		const stdout = sourceRows(9000);
		const remote = { ...source, read: async () => ({ stdout, complete: true }) };
		const decode = TextDecoder.prototype.decode;
		TextDecoder.prototype.decode = () => {
			throw new Error("Parent must not decode porcelain");
		};
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		try {
			await pages.observe({
				queryKey: scope.queryKey,
				source: remote,
				readStats: async () => stats(),
			});
			const page = ready(await pages.read({ scope, source: remote, query: {} }));
			expect(page.counts.totalFiles).toBe(9000);
			expect(page.files).toHaveLength(100);
			expect(ticks).toBeGreaterThan(0);
		} finally {
			clearInterval(timer);
			TextDecoder.prototype.decode = decode;
		}
	});

	test("remote truncation and missing metadata remain partial; no local fallback exists", async () => {
		const pages = service();
		const remote = {
			...source,
			read: async (): Promise<GitStatusPageRawResult> => ({
				stdout: sourceRows(3),
				complete: false,
				limitReason: "remote-truncated",
			}),
		};
		await pages.observe({
			queryKey: scope.queryKey,
			source: remote,
			readStats: async () => stats(),
		});
		expect(await pages.read({ scope, source: remote, query: {} })).toMatchObject({
			status: "ready",
			complete: false,
			limitReason: "remote-truncated",
			counts: { exact: false },
		});
		await pages.observe({
			queryKey: scope.queryKey,
			source: { ...remote, read: async () => ({ stdout: "?? x\0" }) },
			readStats: async () => stats(),
		});
		expect(await pages.read({ scope, source: remote, query: {} })).toMatchObject({
			complete: false,
			limitReason: "remote-incomplete",
		});
		const failed = {
			...remote,
			identity: "device:offline",
			read: async (): Promise<GitStatusPageRawResult> => {
				throw new Error("device offline");
			},
		};
		await pages.observe({ queryKey: "offline", source: failed, readStats: async () => stats() });
		expect(
			await pages.read({ scope: { ...scope, queryKey: "offline" }, source: failed, query: {} }),
		).toMatchObject({ status: "error", cache: { errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" } });
	});

	test("two running producers and sixteen queued jobs remain bounded and cancellable", async () => {
		const pages = service();
		const started = deferred<void>();
		let running = 0;
		let reads = 0;
		const remote = {
			...source,
			read: (signal: AbortSignal) =>
				new Promise<GitStatusPageRawResult>((_resolve, reject) => {
					reads++;
					running++;
					if (reads === 2) started.resolve();
					signal.addEventListener(
						"abort",
						() => {
							running--;
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		};
		const controllers = Array.from({ length: 18 }, () => new AbortController());
		const requests = controllers.map((controller, index) =>
			pages
				.observe({
					queryKey: `workspace-${index}`,
					source: remote,
					readStats: async () => stats(),
					signal: controller.signal,
				})
				.catch((error) => error),
		);
		await expect(
			pages.observe({ queryKey: "overflow", source: remote, readStats: async () => stats() }),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_BUSY" });
		await started.promise;
		for (const controller of controllers.slice(2)) controller.abort();
		for (const controller of controllers.slice(0, 2)) controller.abort();
		expect((await Promise.all(requests)).every((result) => result instanceof Error)).toBe(true);
		expect(reads).toBe(2);
		expect(running).toBe(0);
	});

	test("invalidated late production cannot publish and released work cancels its full-statistics source", async () => {
		const pages = service();
		const started = deferred<void>();
		const delayed = deferred<GitStatusPageRawResult>();
		const pending = pages
			.observe({
				queryKey: scope.queryKey,
				source: {
					...source,
					read: async () => {
						started.resolve();
						return delayed.promise;
					},
				},
				readStats: async () => stats(),
			})
			.catch((error) => error);
		await started.promise;
		pages.invalidate(scope.queryKey);
		delayed.resolve({ stdout: "?? obsolete\0", complete: true });
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect((await pages.read({ scope, source, query: {} })).status).toBe("pending");
		const measuring = deferred<void>();
		let aborted = false;
		const work = pages
			.observe({
				queryKey: scope.queryKey,
				source,
				readStats: (signal) =>
					new Promise<GitLineStats>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(signal.reason);
							},
							{ once: true },
						);
						measuring.resolve();
					}),
			})
			.catch((error) => error);
		await measuring.promise;
		pages.release(scope.queryKey);
		expect(await work).toMatchObject({ code: "GIT_STATUS_PAGE_CANCELLED" });
		expect(aborted).toBe(true);
		expect((await pages.read({ scope, source, query: {} })).status).toBe("pending");
	});

	test("cold-start invalidation rejects queued production and stale intermediate publication", async () => {
		const pages = service();
		const internal = pages as unknown as {
			connect: () => Promise<Worker>;
			pending: Map<number, unknown>;
			receive: (message: unknown) => void;
		};
		const connect = internal.connect.bind(pages);
		const started = deferred<void>();
		const gate = deferred<void>();
		internal.connect = async () => {
			started.resolve();
			await gate.promise;
			return connect();
		};
		let scans = 0;
		let published = 0;
		const remote = {
			...source,
			read: async () => {
				scans++;
				return source.read();
			},
		};
		const delayedStats = deferred<GitLineStats>();
		const pending = pages
			.observe({
				queryKey: scope.queryKey,
				source: remote,
				readStats: async () => delayedStats.promise,
				onPublished: () => {
					published++;
				},
			})
			.catch((error) => error);
		await started.promise;
		const id = internal.pending.keys().next().value;
		pages.invalidateStats(scope.queryKey);
		internal.receive({
			action: "cache-published",
			id,
			cache: {
				status: "ready",
				workerEpoch: "old",
				memberVersion: 1,
				statsVersion: 0,
				updating: true,
			},
		});
		gate.resolve();
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		delayedStats.resolve(stats(99));
		expect(scans).toBe(0);
		expect(published).toBe(0);
		expect((await pages.read({ scope, source: remote, query: {} })).status).toBe("pending");
		await pages.observe({
			queryKey: scope.queryKey,
			source: remote,
			readStats: async () => stats(3),
		});
		const page = ready(await pages.read({ scope, source: remote, query: {} }));
		expect(
			ready(
				await pages.readStats({
					scope,
					source: remote,
					query: { snapshotId: page.snapshotId, rows: [row] },
				}),
			).rows[0].added,
		).toBe(1683);
	});

	test("exact source leases keep sibling workspaces and shared owners alive on release", async () => {
		const pages = service();
		const parentScope = { ...scope, queryKey: '["local","/repo"]' };
		const childScope = { ...scope, queryKey: '["local","/repo/sub"]' };
		pages.retain(parentScope.queryKey, source);
		pages.retain(parentScope.queryKey, source);
		pages.retain(childScope.queryKey, source);
		for (const owner of [parentScope, childScope])
			await pages.observe({ queryKey: owner.queryKey, source, readStats: async () => stats() });
		const started = deferred<void>();
		const delayed = deferred<GitLineStats>();
		const childWork = pages.observe({
			queryKey: childScope.queryKey,
			source,
			readStats: async () => {
				started.resolve();
				return delayed.promise;
			},
		});
		await started.promise;
		pages.release(parentScope.queryKey, source);
		expect((await pages.read({ scope: parentScope, source, query: {} })).status).toBe("ready");
		pages.release(parentScope.queryKey, source);
		expect((await pages.read({ scope: parentScope, source, query: {} })).status).toBe("pending");
		expect((await pages.read({ scope: childScope, source, query: {} })).status).toBe("ready");
		delayed.resolve(stats(4));
		expect((await childWork).statsVersion).toBeGreaterThan(0);
		pages.release(childScope.queryKey, source);
		expect((await pages.read({ scope: childScope, source, query: {} })).status).toBe("pending");
	});

	test("same query key with a different source identity owns an independent lease", async () => {
		const pages = service();
		const other = { ...source, identity: "device:4:/repo" };
		pages.retain(scope.queryKey, source);
		pages.retain(scope.queryKey, other);
		await pages.observe({ queryKey: scope.queryKey, source, readStats: async () => stats() });
		await pages.observe({
			queryKey: scope.queryKey,
			source: other,
			readStats: async () => stats(),
		});
		pages.release(scope.queryKey, source);
		expect((await pages.read({ scope, source, query: {} })).status).toBe("pending");
		expect((await pages.read({ scope, source: other, query: {} })).status).toBe("ready");
		pages.release(scope.queryKey, other);
		expect((await pages.read({ scope, source: other, query: {} })).status).toBe("pending");
	});

	test("254 real files flow through the full background measurement bridge beyond WebSocket limits", async () => {
		const root = await fixture();
		await git(root, "init", "-q");
		await mkdir(join(root, "directory"));
		const files = Array.from({ length: 254 }, (_, i) => `directory/file-${i}`);
		await Promise.all(files.map((path) => writeFile(join(root, path), "one\ntwo")));
		const pages = service();
		const local = { kind: "local" as const, cwd: root };
		const owner = { ...scope, queryKey: JSON.stringify(["local", root]) };
		await pages.observe({
			queryKey: owner.queryKey,
			source: local,
			readStats: (signal) => getGitLineStats(root, signal),
		});
		const page = ready(await pages.read({ scope: owner, source: local, query: {} }));
		const rows: GitStatusPageStatsRow[] = [
			{ type: "directory", section: "unstaged", path: "directory" },
			{ type: "file", section: "unstaged", path: files[253] },
		];
		const measured = ready(
			await pages.readStats({
				scope: owner,
				source: local,
				query: { snapshotId: page.snapshotId, rows },
			}),
		);
		expect(page.files).toHaveLength(100);
		expect(measured.rows).toEqual([
			{ ...rows[0], added: 508, removed: 0, complete: true },
			{ ...rows[1], added: 2, removed: 0, complete: true },
		]);
	}, 15000);

	test("close cancels owned work, drains Worker and rejects further requests", async () => {
		const pages = service();
		const started = deferred<void>();
		let aborted = false;
		const remote = {
			...source,
			read: (signal: AbortSignal) =>
				new Promise<GitStatusPageRawResult>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
					started.resolve();
				}),
		};
		const pending = pages
			.observe({ queryKey: scope.queryKey, source: remote, readStats: async () => stats() })
			.catch((error) => error);
		await started.promise;
		await pages.close();
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_CLOSED" });
		expect(aborted).toBe(true);
		expect(await rejected(pages.read({ scope, source, query: {} }))).toMatchObject({
			code: "GIT_STATUS_PAGE_CLOSED",
		});
	});

	test("isolated real Git observes more than 561 files including rename and AM/MM", async () => {
		const root = await fixture();
		await git(root, "init", "-q");
		for (const name of ["旧 名.txt", "both.txt"])
			await writeFile(join(root, name), `original ${name}\n`);
		await git(root, "add", ".");
		await git(
			root,
			"-c",
			"user.name=Page Test",
			"-c",
			"user.email=page@example.invalid",
			"commit",
			"-qm",
			"base",
		);
		await rename(join(root, "旧 名.txt"), join(root, "新 名.txt"));
		await writeFile(join(root, "added.txt"), "staged\n");
		await writeFile(join(root, "both.txt"), "staged change\n");
		await git(root, "add", "-A");
		await writeFile(join(root, "added.txt"), "staged\nworktree\n");
		await writeFile(join(root, "both.txt"), "staged change\nworktree\n");
		const extras = Array.from({ length: 562 }, (_, i) => `untracked-${i}.txt`);
		extras.push("中文 空格.txt");
		if (process.platform !== "win32") extras.push("换\n行.txt");
		await Promise.all(extras.map((path) => writeFile(join(root, path), "x\n")));
		const pages = service();
		const localScope = { ...scope, queryKey: JSON.stringify(["local", root]) };
		const local = { kind: "local" as const, cwd: root };
		expect((await pages.read({ scope: localScope, source: local, query: {} })).status).toBe(
			"pending",
		);
		await pages.observe({
			queryKey: localScope.queryKey,
			source: local,
			readStats: async () => stats(),
		});
		let page = ready(await pages.read({ scope: localScope, source: local, query: {} }));
		const files = [...page.files];
		while (page.nextCursor) {
			page = ready(
				await pages.read({ scope: localScope, source: local, query: { cursor: page.nextCursor } }),
			);
			files.push(...page.files);
		}
		expect(files).toHaveLength(extras.length + 3);
		expect(new Set(files.map((entry) => entry.path)).size).toBe(files.length);
		expect(files.find((entry) => entry.path === "新 名.txt")).toMatchObject({
			status: "R ",
			oldPath: "旧 名.txt",
		});
		expect(files.find((entry) => entry.path === "added.txt")?.status).toBe("AM");
		expect(files.find((entry) => entry.path === "both.txt")?.status).toBe("MM");
		expect(page.complete).toBe(true);
	}, 30000);

	test.skipIf(process.platform === "win32")(
		"cancelling a local producer waits for owned Git and inherited-pipe descendants",
		async () => {
			const root = await fixture();
			const bin = join(root, "bin");
			await mkdir(bin);
			const script = join(root, "git-fixture.js");
			await writeFile(
				script,
				`const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "inherit", stderr: "inherit" });\nawait Bun.write("child.pid", JSON.stringify({ pid: process.pid, descendant: descendant.pid }));\nprocess.stdout.write("?? waiting.txt\\0");\nsetInterval(() => {}, 1000);\n`,
			);
			await writeFile(join(bin, "git"), `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
			await chmod(join(bin, "git"), 0o755);
			const probe = `import { GitStatusPageService } from ${JSON.stringify(new URL("./git-status-page.ts", import.meta.url).href)};
const pages = new GitStatusPageService();
const controller = new AbortController();
const root = process.cwd();
const pending = pages.observe({ queryKey: JSON.stringify(["local", root]), source: { kind: "local", cwd: root }, readStats: async () => ({ files: [], linesAdded: 0, linesRemoved: 0, complete: false }), signal: controller.signal }).then(() => ({ success: true }), error => ({ code: error.code }));
try {
 let ids;
 const deadline = Date.now() + 5000;
 while (!ids && Date.now() < deadline) { try { ids = await Bun.file("child.pid").json(); } catch { await Bun.sleep(5); } }
 if (!ids) { controller.abort(); throw new Error("Fixture Git did not start"); }
 controller.abort();
 const result = await pending;
 await pages.close();
 let parentGone = false;
 try { process.kill(ids.pid, 0); } catch { parentGone = true; }
 console.log(JSON.stringify({ ...ids, parentGone, cancelled: !result.success }));
} finally { await pages.close(); }`;
			const { stdout } = await exec(process.execPath, ["-e", probe], {
				cwd: root,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				timeout: 12000,
				maxBuffer: 4096,
			});
			const result = JSON.parse(stdout.trim()) as {
				pid: number;
				descendant: number;
				parentGone: boolean;
				cancelled: boolean;
			};
			expect(result.pid).toBeGreaterThan(0);
			expect(result.descendant).toBeGreaterThan(0);
			expect(result.parentGone).toBe(true);
			expect(result.cancelled).toBe(true);
			if (process.platform === "linux") {
				let state: string | undefined;
				try {
					state = (await readFile(`/proc/${result.descendant}/stat`, "utf8")).split(") ")[1]?.[0];
				} catch {
					/* descendant reaped */
				}
				expect(state === undefined || state === "Z").toBe(true);
			}
		},
		15000,
	);
});
