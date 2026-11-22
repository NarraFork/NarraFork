import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitLineStats } from "../../shared/git-line-stats";
import type { GitStatusPageStatsRow } from "../../shared/git-status-page";
import type { GitStatusPageRawResult, GitStatusPageScope } from "./git-status-page";
import { GitStatusPageService } from "./git-status-page";

const exec = promisify(execFile);
const services: GitStatusPageService[] = [];
const fixtures: string[] = [];
const scope: GitStatusPageScope = {
	actorId: "alice",
	workspaceKey: "workspace",
	queryKey: '["remote","device",3,"/repo"]',
};
const sourceRows = (count: number) =>
	Array.from({ length: count }, (_, index) => `?? f-${String(index).padStart(4, "0")}\0`).join("");
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
	await exec("git", args, { cwd, timeout: 15_000, maxBuffer: 4096 });
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((value) => value.close()));
	await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("real statistics worker service", () => {
	const row: GitStatusPageStatsRow = { type: "directory", section: "unstaged", path: "目录" };
	const paths = Array.from(
		{ length: 561 },
		(_, index) => `目录/file-${String(index).padStart(4, "0")}`,
	);
	const stats = (): GitLineStats => ({
		files: paths.map((path) => ({
			path,
			unstagedLinesAdded: 2,
			unstagedLinesRemoved: 1,
			complete: true,
		})),
		linesAdded: 1122,
		linesRemoved: 561,
		complete: true,
	});
	const source = {
		kind: "remote" as const,
		identity: "device:3:/repo",
		read: async () => ({ stdout: paths.map((path) => `?? ${path}\0`).join(""), complete: true }),
	};

	test("first-page directory statistics and later files reuse a single source and cached full-status association", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		let reads = 0;
		const readStats = async () => {
			reads++;
			return stats();
		};
		const result = await pages.readStats({
			scope,
			source,
			query: { snapshotId: page.snapshotId, rows: [row] },
			readStats,
		});
		expect(page.files).toHaveLength(100);
		expect(page.hasMore).toBe(true);
		expect(result).toEqual({
			snapshotId: page.snapshotId,
			rows: [{ ...row, added: 1122, removed: 561, complete: true }],
		});
		const file = { type: "file" as const, section: "unstaged" as const, path: paths[560] };
		expect(
			(
				await pages.readStats({
					scope,
					source,
					query: { snapshotId: page.snapshotId, rows: [file] },
					readStats,
				})
			).rows,
		).toEqual([{ ...file, added: 2, removed: 1, complete: true }]);
		expect(reads).toBe(1);
	});

	test("statistics identities and batch limits are checked before the authorized callback runs", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
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
			expect(await rejected(pages.readStats(changed))).toMatchObject({
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

	test("facts invalidation rejects pending measurements, discards late data and preserves continuation cursors", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		const started = deferred<void>();
		const delayed = deferred<GitLineStats>();
		let sourceSignal: AbortSignal | undefined;
		const pending = pages
			.readStats({
				scope,
				source,
				query: { snapshotId: page.snapshotId, rows: [row] },
				readStats: (readSignal) => {
					sourceSignal = readSignal;
					started.resolve();
					return delayed.promise;
				},
			})
			.catch((error) => error);
		await started.promise;
		pages.invalidateStats(scope.queryKey);
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(sourceSignal?.aborted).toBe(true);
		delayed.resolve(stats());
		const next = await pages.read({ scope, source, query: { cursor: page.nextCursor as string } });
		expect(next.snapshotId).toBe(page.snapshotId);
		let reads = 0;
		const result = await pages.readStats({
			scope,
			source,
			query: { snapshotId: page.snapshotId, rows: [row] },
			readStats: async () => {
				reads++;
				return {
					...stats(),
					files: stats().files.map((file) => ({ ...file, unstagedLinesAdded: 3 })),
				};
			},
		});
		expect(reads).toBe(1);
		expect(result.rows[0].added).toBe(1683);
	});

	test("shared statistics survive cancellation of the request that first opened their bridge", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		const started = deferred<void>();
		const delayed = deferred<GitLineStats>();
		const controller = new AbortController();
		let reads = 0;
		let sourceSignal: AbortSignal | undefined;
		const options = {
			scope,
			source,
			query: { snapshotId: page.snapshotId, rows: [row] },
			readStats: (readSignal: AbortSignal) => {
				reads++;
				sourceSignal = readSignal;
				started.resolve();
				return delayed.promise;
			},
		};
		const first = pages
			.readStats({ ...options, signal: controller.signal })
			.catch((error) => error);
		await started.promise;
		const second = pages.readStats(options);
		// Let dispatch enqueue its read before cancellation on the same ordered Worker port.
		await Promise.resolve();
		controller.abort(new Error("viewport replaced"));
		expect((await first).message).toBe("viewport replaced");
		expect(sourceSignal?.aborted).toBe(false);
		delayed.resolve(stats());
		expect((await second).rows[0].added).toBe(1122);
		expect(reads).toBe(1);
	});

	test("cancellation before bridge delivery preserves another authorized statistics waiter", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		const controller = new AbortController();
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
		const first = pages
			.readStats({ ...options, signal: controller.signal })
			.catch((error) => error);
		const second = pages.readStats(options);
		await Promise.resolve();
		controller.abort();
		const cancelled = await first;
		expect(cancelled).toMatchObject({
			code: "GIT_STATUS_PAGE_CANCELLED",
			cause: { name: "AbortError" },
		});
		expect((await second).rows[0].added).toBe(1122);
		expect(reads).toBe(1);
	});

	test("cancelling every statistics waiter aborts the shared source and permits a fresh read", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		const started = deferred<void>();
		const controller = new AbortController();
		let sourceSignal: AbortSignal | undefined;
		const pending = pages
			.readStats({
				scope,
				source,
				query: { snapshotId: page.snapshotId, rows: [row] },
				signal: controller.signal,
				readStats: (readSignal) =>
					new Promise<GitLineStats>((_resolve, reject) => {
						sourceSignal = readSignal;
						readSignal.addEventListener("abort", () => reject(readSignal.reason), { once: true });
						started.resolve();
					}),
			})
			.catch((error) => error);
		await started.promise;
		controller.abort(new Error("cancelled"));
		expect((await pending).message).toBe("cancelled");
		expect(sourceSignal?.aborted).toBe(true);
		expect(
			(
				await pages.readStats({
					scope,
					source,
					query: { snapshotId: page.snapshotId, rows: [row] },
					readStats: async () => stats(),
				})
			).rows[0].added,
		).toBe(1122);
	});

	test("unsupported statistics remain unknown and close aborts active source work", async () => {
		const pages = service();
		const page = await pages.read({ scope, source, query: {} });
		const result = await pages.readStats({
			scope,
			source,
			query: { snapshotId: page.snapshotId, rows: [row] },
			readStats: async () => {
				throw new Error("GIT_LINE_STATS_UNSUPPORTED");
			},
		});
		expect(result).toEqual({
			snapshotId: page.snapshotId,
			rows: [{ ...row, added: undefined, removed: undefined, complete: false }],
		});
		pages.invalidateStats(scope.queryKey);
		const started = deferred<void>();
		let sourceSignal: AbortSignal | undefined;
		const pending = pages
			.readStats({
				scope,
				source,
				query: { snapshotId: page.snapshotId, rows: [row] },
				readStats: (readSignal) =>
					new Promise<GitLineStats>((_resolve, reject) => {
						sourceSignal = readSignal;
						readSignal.addEventListener("abort", () => reject(readSignal.reason), { once: true });
						started.resolve();
					}),
			})
			.catch((error) => error);
		await started.promise;
		await pages.close();
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_CLOSED" });
		expect(sourceSignal?.aborted).toBe(true);
	});
});

describe("real paging worker service", () => {
	test("raw remote source is read only once and continuation never falls back to local Git", async () => {
		const pages = service();
		let reads = 0;
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
			read: async () => {
				reads++;
				return { stdout: sourceRows(562), complete: true };
			},
		};
		let page = await pages.read({ scope, source, query: {} });
		const paths: string[] = [];
		while (true) {
			paths.push(...page.files.map((file) => file.path));
			if (!page.nextCursor) break;
			page = await pages.read({ scope, source, query: { cursor: page.nextCursor } });
		}
		expect(reads).toBe(1);
		expect(paths.length).toBe(562);
		expect(new Set(paths).size).toBe(562);
		expect(page.complete).toBe(true);
	});

	test("full raw status decoding runs in Worker rather than the parent event loop", async () => {
		const pages = service();
		const stdout = sourceRows(9000);
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
			read: async () => ({ stdout, complete: true }),
		};
		const decode = TextDecoder.prototype.decode;
		TextDecoder.prototype.decode = () => {
			throw new Error("Parent must not decode porcelain");
		};
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 1);
		try {
			const page = await pages.read({ scope, source, query: {} });
			expect(page.files).toHaveLength(100);
			expect(page.counts.totalFiles).toBe(9000);
			expect(ticks).toBeGreaterThan(0);
		} finally {
			clearInterval(timer);
			TextDecoder.prototype.decode = decode;
		}
	});

	test("remote truncation, absent completeness metadata, identity changes and invalidation are explicit", async () => {
		const pages = service();
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
			read: async (): Promise<GitStatusPageRawResult> => ({
				stdout: sourceRows(3),
				complete: false,
				limitReason: "remote-truncated",
			}),
		};
		const page = await pages.read({ scope, source, query: { limit: 1 } });
		expect(page).toMatchObject({
			complete: false,
			limitReason: "remote-truncated",
			counts: { exact: false },
		});
		const missing = await pages.read({
			scope,
			source: { ...source, read: async () => ({ stdout: "?? x\0" }) },
			query: {},
		});
		expect(missing).toMatchObject({ complete: false, limitReason: "remote-incomplete" });
		expect(
			await rejected(
				pages.read({
					scope,
					source: { ...source, identity: "device:4:/repo" },
					query: { limit: 1, cursor: page.nextCursor as string },
				}),
			),
		).toMatchObject({ code: "GIT_STATUS_PAGE_INVALID_CURSOR" });
		pages.invalidate(scope.queryKey);
		expect(
			await rejected(
				pages.read({ scope, source, query: { limit: 1, cursor: page.nextCursor as string } }),
			),
		).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	});

	test("two running scans, sixteen queued requests and cancellation stay bounded", async () => {
		const pages = service();
		const started = deferred<void>();
		let running = 0;
		let maximum = 0;
		let reads = 0;
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
			read: (signal: AbortSignal) =>
				new Promise<GitStatusPageRawResult>((_resolve, reject) => {
					reads++;
					running++;
					maximum = Math.max(maximum, running);
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
		const requests = controllers.map((controller) =>
			pages.read({ scope, source, query: {}, signal: controller.signal }).then(
				() => "unexpected",
				(error: unknown) => error,
			),
		);
		expect(await rejected(pages.read({ scope, source, query: {} }))).toMatchObject({
			code: "GIT_STATUS_PAGE_BUSY",
		});
		await started.promise;
		expect(reads).toBe(2);
		// Abort queued work before releasing either running slot.
		for (const controller of controllers.slice(2)) controller.abort();
		for (const controller of controllers.slice(0, 2)) controller.abort();
		const results = await Promise.all(requests);
		expect(results.every((result) => result instanceof Error)).toBe(true);
		expect(maximum).toBe(2);
		expect(reads).toBe(2);
		expect(running).toBe(0);
	});

	test("invalidation during raw source read aborts its owner and prevents snapshot publication", async () => {
		const pages = service();
		const started = deferred<void>();
		const result = deferred<GitStatusPageRawResult>();
		let aborted = false;
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
			read: (signal: AbortSignal) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
					},
					{ once: true },
				);
				started.resolve();
				return result.promise;
			},
		};
		const pending = pages.read({ scope, source, query: {} }).then(
			() => "unexpected",
			(error: unknown) => error,
		);
		await started.promise;
		pages.invalidate(scope.queryKey);
		result.resolve({ stdout: sourceRows(2), complete: true });
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(aborted).toBe(true);
	});

	test("service close cancels active source work, drains the worker and rejects new requests", async () => {
		const pages = service();
		const started = deferred<void>();
		let aborted = false;
		const source = {
			kind: "remote" as const,
			identity: "device:3:/repo",
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
		const pending = pages.read({ scope, source, query: {} }).then(
			() => "unexpected",
			(error: unknown) => error,
		);
		await started.promise;
		await pages.close();
		expect(await pending).toMatchObject({ code: "GIT_STATUS_PAGE_CLOSED" });
		expect(aborted).toBe(true);
		expect(await rejected(pages.read({ scope, source, query: {} }))).toMatchObject({
			code: "GIT_STATUS_PAGE_CLOSED",
		});
	});

	test("isolated real Git repository pages more than 561 paths including rename and AM/MM", async () => {
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
		const extras = Array.from(
			{ length: 562 },
			(_, index) => `untracked-${String(index).padStart(4, "0")}.txt`,
		);
		extras.push("中文 空格.txt");
		if (process.platform !== "win32") extras.push("换\n行.txt");
		await Promise.all(extras.map((name) => writeFile(join(root, name), "x\n")));
		const pages = service();
		const localScope = { ...scope, queryKey: JSON.stringify(["local", root]) };
		const source = { kind: "local" as const, cwd: root };
		let page = await pages.read({ scope: localScope, source, query: {} });
		const files = [...page.files];
		while (page.nextCursor) {
			page = await pages.read({ scope: localScope, source, query: { cursor: page.nextCursor } });
			files.push(...page.files);
		}
		expect(page.complete).toBe(true);
		expect(files).toHaveLength(extras.length + 3);
		expect(new Set(files.map((file) => file.path)).size).toBe(extras.length + 3);
		expect(files.find((file) => file.path === "新 名.txt")).toMatchObject({
			status: "R ",
			oldPath: "旧 名.txt",
		});
		expect(files.find((file) => file.path === "added.txt")?.status).toBe("AM");
		expect(files.find((file) => file.path === "both.txt")?.status).toBe("MM");
		for (const path of extras) expect(files.some((file) => file.path === path)).toBe(true);
	}, 30_000);

	test.skipIf(process.platform === "win32")(
		"cancelling a local scan waits for owned Git and inherited-pipe descendants to exit",
		async () => {
			const root = await fixture();
			const bin = join(root, "bin");
			await mkdir(bin);
			const fakeScript = join(root, "git-fixture.js");
			await writeFile(
				fakeScript,
				`const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "inherit", stderr: "inherit" });\nawait Bun.write("child.pid", JSON.stringify({ pid: process.pid, descendant: descendant.pid }));\nprocess.stdout.write("?? waiting.txt\\0");\nsetInterval(() => {}, 1000);\n`,
			);
			const gitPath = join(bin, "git");
			await writeFile(gitPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}"\n`);
			await chmod(gitPath, 0o755);
			// Explicit subprocess environment works on Bun versions whose Worker ignores JS env mutations.
			const probe = `import { GitStatusPageService } from ${JSON.stringify(new URL("./git-status-page.ts", import.meta.url).href)};
const pages = new GitStatusPageService();
const controller = new AbortController();
const root = process.cwd();
const pending = pages.read({ scope: { actorId: "fixture", workspaceKey: "fixture", queryKey: JSON.stringify(["local", root]) }, source: { kind: "local", cwd: root }, query: {}, signal: controller.signal }).then(() => ({ success: true }), error => ({ name: error.name, code: error.code }));
try {
 let ids;
 const deadline = Date.now() + 5000;
 while (!ids && Date.now() < deadline) {
  try { ids = await Bun.file("child.pid").json(); } catch { await Bun.sleep(5); }
 }
 if (!ids) { controller.abort(); throw new Error("Fixture Git did not start: " + Bun.which("git") + " result=" + JSON.stringify(await pending)); }
 controller.abort();
 const result = await pending;
 await pages.close();
 let parentGone = false;
 try { process.kill(ids.pid, 0); } catch { parentGone = true; }
 console.log(JSON.stringify({ ...ids, parentGone, cancelled: !result.success }));
} finally { await pages.close(); }
`;
			const { stdout } = await exec(process.execPath, ["-e", probe], {
				cwd: root,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				timeout: 12_000,
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
		15_000,
	);
});
