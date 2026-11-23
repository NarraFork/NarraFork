import { describe, expect, test } from "bun:test";
import type { GitStatusPageResult, GitStatusPageScopeProof } from "../../shared/git-status-page";
import { GitStatusPageService } from "./git-status-page";
import { GitStatusPageEngine } from "./git-status-page-engine";
import type { GitStatusPageRawResult, GitStatusPageRequest } from "./git-status-page-protocol";

const signal = new AbortController().signal;
const raw = (stdout: string, complete = true): GitStatusPageRawResult => ({ stdout, complete });
const status = "AM dir/a\0MM dir/b\0 M dir2/c\0?? dir/new\0";
const request = (): GitStatusPageRequest => ({
	scope: { actorId: "alice", workspaceKey: "workspace", queryKey: '["remote","device",7,"/root"]' },
	query: { limit: 1, filter: ["M"] },
	source: { kind: "remote", identity: "device:7:/root" },
});
const noRemote = async (): Promise<GitStatusPageRawResult> => {
	throw new Error("Unexpected source read");
};
function ready(value: GitStatusPageResult) {
	if (value.status !== "ready") throw new Error("Expected ready");
	return value;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function warm(engine: GitStatusPageEngine, complete = true) {
	await engine.observe(request(), signal, async () => raw(status, complete));
	return ready(await engine.read(request(), signal));
}

describe("background membership validation", () => {
	test("same members retain cursors and changed/partial observations reject old cursors", async () => {
		const engine = new GitStatusPageEngine();
		const first = await warm(engine);
		expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
			changed: false,
			reliable: true,
		});
		expect(
			ready(
				await engine.read(
					{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
					signal,
				),
			).snapshotId,
		).toBe(first.snapshotId);
		expect(
			await engine.validateSnapshots(request(), signal, async () => raw(`${status} M dir/newer\0`)),
		).toEqual({ changed: true, reliable: true });
		await expect(
			engine.read(
				{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
				signal,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(
			await engine.validateSnapshots(request(), signal, async () => raw(status, false)),
		).toEqual({ changed: true, reliable: false });
		engine.close();
	});
	test("a cold validation prewarms without an HTTP reader and an older producer cannot win", async () => {
		const engine = new GitStatusPageEngine();
		const source = deferred<GitStatusPageRawResult>();
		const older = engine.validateSnapshots(request(), signal, () => source.promise);
		expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
			changed: true,
			reliable: true,
		});
		source.resolve(raw(`${status} M obsolete\0`));
		expect(await older).toEqual({ changed: false, reliable: false });
		expect(ready(await engine.read(request(), signal)).counts.totalFiles).toBe(4);
		engine.close();
	});
});

describe("worker verified batch scope", () => {
	test("statistics-only refresh preserves a matching write-time membership scan", async () => {
		for (const onDemand of [false, true]) {
			const engine = new GitStatusPageEngine();
			const first = onDemand
				? await engine.readOnDemand(request(), signal, async () => raw(status))
				: await warm(engine);
			const source = deferred<GitStatusPageRawResult>();
			const pending = engine.assertScope(
				{
					...request(),
					proof: {
						snapshotId: first.snapshotId,
						filter: ["M"],
						section: "unstaged",
						directory: "dir",
					},
					files: ["dir/a", "dir/b"],
				},
				signal,
				() => source.promise,
			);
			engine.invalidateStats(request().scope.queryKey);
			source.resolve(raw(status));
			expect(await pending).toBe(true);
			engine.close();
		}
	});

	test("directory and filter prove the complete section, not only the loaded page", async () => {
		const engine = new GitStatusPageEngine();
		const first = await warm(engine);
		expect(first.files).toHaveLength(1);
		const proof: GitStatusPageScopeProof = {
			snapshotId: first.snapshotId,
			filter: ["M"],
			section: "unstaged",
			directory: "dir",
		};
		const scoped = { ...request(), proof, files: ["dir/a", "dir/b"] };
		expect(await engine.assertScope(scoped, signal, async () => raw(status))).toBe(true);
		for (const files of [
			["dir/a"],
			["dir/a", "dir/a"],
			["dir/a", "dir/b", "dir/new"],
			["dir/a", "dir/b", "dir2/c"],
		])
			await expect(
				engine.assertScope({ ...scoped, files }, signal, noRemote),
			).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		await expect(
			engine.assertScope({ ...scoped, proof: { ...proof, section: "staged" } }, signal, noRemote),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(
			await engine.assertScope(
				{ ...scoped, files: ["dir/b"], proof: { ...proof, section: "staged" } },
				signal,
				async () => raw(status),
			),
		).toBe(true);
		engine.close();
	});

	test("actor, workspace, generation, filter and directory remain isolated", async () => {
		const engine = new GitStatusPageEngine();
		const first = await warm(engine);
		const proof: GitStatusPageScopeProof = {
			snapshotId: first.snapshotId,
			filter: ["M"],
			section: "unstaged",
		};
		const scoped = { ...request(), proof, files: ["dir/a", "dir/b", "dir2/c"] };
		for (const changed of [
			{ ...scoped, scope: { ...scoped.scope, actorId: "bob" } },
			{ ...scoped, scope: { ...scoped.scope, workspaceKey: "other" } },
			{ ...scoped, source: { kind: "remote" as const, identity: "device:8:/root" } },
			{ ...scoped, proof: { ...proof, filter: ["A" as const] } },
			{ ...scoped, proof: { ...proof, directory: "../dir" } },
		])
			await expect(engine.assertScope(changed, signal, noRemote)).rejects.toMatchObject({
				code: "GIT_STATUS_PAGE_EXPIRED",
			});
		engine.close();
	});

	test("readable last-good never authorizes a write without a complete fresh scan", async () => {
		for (const next of [
			raw(`${status} M dir/added-later\0`),
			raw(status.replace("MM dir/b", " M dir/b")),
			raw(`${status}R  renamed\0old\0`),
			raw(status, false),
		]) {
			const engine = new GitStatusPageEngine();
			const first = await warm(engine);
			engine.invalidate(request().scope.queryKey);
			expect(ready(await engine.read(request(), signal)).cache.updating).toBe(true);
			let freshScans = 0;
			await expect(
				engine.assertScope(
					{
						...request(),
						proof: {
							snapshotId: first.snapshotId,
							filter: ["M"],
							section: "unstaged",
							directory: "dir",
						},
						files: ["dir/a", "dir/b"],
					},
					signal,
					async () => {
						freshScans++;
						return next;
					},
				),
			).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
			expect(freshScans).toBe(1);
			engine.close();
		}
	});

	test("evicted/expired/partial observations cannot authorize any batch", async () => {
		let now = 0;
		const engine = new GitStatusPageEngine(undefined, () => now);
		const first = await warm(engine);
		const proof: GitStatusPageScopeProof = {
			snapshotId: first.snapshotId,
			filter: ["M"],
			section: "unstaged",
			directory: "dir",
		};
		for (let index = 0; index < 8; index++)
			await engine.read(
				{ ...request(), scope: { ...request().scope, actorId: `actor-${index}` } },
				signal,
			);
		expect(engine.stats.snapshots).toBe(8);
		await expect(
			engine.assertScope({ ...request(), proof, files: ["dir/a", "dir/b"] }, signal, noRemote),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		const fresh = ready(await engine.read(request(), signal));
		now = 120_000;
		await expect(
			engine.assertScope(
				{
					...request(),
					proof: { ...proof, snapshotId: fresh.snapshotId },
					files: ["dir/a", "dir/b"],
				},
				signal,
				noRemote,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		const partial = await warm(engine, false);
		await expect(
			engine.assertScope(
				{
					...request(),
					proof: { ...proof, snapshotId: partial.snapshotId },
					files: ["dir/a", "dir/b"],
				},
				signal,
				noRemote,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		engine.close();
	});

	test("eviction or dirty during a write-time scan rejects its late result", async () => {
		for (const mode of ["evict", "dirty"] as const) {
			const engine = new GitStatusPageEngine();
			const first = await warm(engine);
			const source = deferred<GitStatusPageRawResult>();
			const pending = engine.assertScope(
				{
					...request(),
					proof: {
						snapshotId: first.snapshotId,
						filter: ["M"],
						section: "unstaged",
						directory: "dir",
					},
					files: ["dir/a", "dir/b"],
				},
				signal,
				() => source.promise,
			);
			if (mode === "evict")
				for (let i = 0; i < 8; i++)
					await engine.read(
						{ ...request(), scope: { ...request().scope, actorId: `actor-${i}` } },
						signal,
					);
			else engine.invalidate(request().scope.queryKey);
			source.resolve(raw(status));
			await expect(pending).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
			engine.close();
		}
	});
});

test("parent statistics invalidation preserves an in-flight scoped write assertion", async () => {
	const pages = new GitStatusPageService();
	const entered = deferred<void>();
	const scan = deferred<GitStatusPageRawResult>();
	let checking = false;
	const source = {
		kind: "remote" as const,
		identity: "device:7:/root",
		read: async () => {
			if (!checking) return raw(status);
			entered.resolve();
			return scan.promise;
		},
	};
	try {
		const first = await pages.readOnDemand({ ...request(), source });
		checking = true;
		const pending = pages.assertScope({
			scope: request().scope,
			source,
			proof: { snapshotId: first.snapshotId, filter: ["M"], section: "unstaged", directory: "dir" },
			files: ["dir/a", "dir/b"],
		});
		await entered.promise;
		pages.invalidateStats(request().scope.queryKey);
		scan.resolve(raw(status));
		await pending;
	} finally {
		scan.resolve(raw(status));
		await pages.close();
	}
});

test("parent service transports background validation and scope proofs to the isolated Worker", async () => {
	const pages = new GitStatusPageService();
	let stdout = status;
	let scans = 0;
	const source = {
		kind: "remote" as const,
		identity: "device:7:/root",
		read: async () => {
			scans++;
			return raw(stdout);
		},
	};
	try {
		await pages.validate({ queryKey: request().scope.queryKey, source });
		const first = ready(await pages.read({ ...request(), source }));
		expect(await pages.validate({ queryKey: request().scope.queryKey, source })).toEqual({
			changed: false,
			reliable: true,
		});
		await pages.assertScope({
			scope: request().scope,
			source,
			proof: { snapshotId: first.snapshotId, filter: ["M"], section: "unstaged", directory: "dir" },
			files: ["dir/b", "dir/a"],
		});
		expect(scans).toBe(3);
		expect(
			ready(
				await pages.read({
					...request(),
					source,
					query: { ...request().query, cursor: first.nextCursor as string },
				}),
			).snapshotId,
		).toBe(first.snapshotId);
		expect(scans).toBe(3);
		stdout += " M dir/late\0";
	} finally {
		await pages.close();
	}
});
