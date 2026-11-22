import { describe, expect, test } from "bun:test";
import type { GitStatusPageScopeProof } from "../../shared/git-status-page";
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
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("bounded worker snapshot validation", () => {
	test("repeated same-state validations do not starve a slow first read or filter change", async () => {
		for (const cached of [false, true]) {
			let now = 0;
			const engine = new GitStatusPageEngine(undefined, () => now);
			if (cached) await engine.read(request(), signal, async () => raw(status));
			const source = deferred<GitStatusPageRawResult>();
			const pending = engine.read(
				{ ...request(), query: { limit: 1, filter: ["A"] } },
				signal,
				() => source.promise,
			);
			for (let index = 0; index < 4; index++) {
				now += 3001;
				expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
					changed: false,
					reliable: cached,
				});
			}
			source.resolve(raw(status));
			const page = await pending;
			expect(page.complete).toBe(true);
			expect(page.counts.filteredFiles).toBe(2);
			expect(engine.stats.snapshots).toBe(cached ? 2 : 1);
			engine.close();
		}
	});

	test("a read which publishes during validation is included in the final comparison", async () => {
		const engine = new GitStatusPageEngine();
		await engine.read(request(), signal, async () => raw(status));
		const readSource = deferred<GitStatusPageRawResult>();
		const freshSource = deferred<GitStatusPageRawResult>();
		const pending = engine.read(request(), signal, () => readSource.promise);
		const validating = engine.validateSnapshots(request(), signal, () => freshSource.promise);
		readSource.resolve(raw(`${status} M dir/temporary\0`));
		const published = await pending;
		freshSource.resolve(raw(status));
		expect(await validating).toEqual({ changed: true, reliable: true });
		await expect(
			engine.read(
				{ ...request(), query: { ...request().query, cursor: published.nextCursor as string } },
				signal,
				noRemote,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		engine.close();
	});

	test("an older validation cannot overwrite a newer completed validation", async () => {
		const engine = new GitStatusPageEngine();
		await engine.read(request(), signal, async () => raw(status));
		const oldSource = deferred<GitStatusPageRawResult>();
		const older = engine.validateSnapshots(request(), signal, () => oldSource.promise);
		const current = `${status} M dir/current\0`;
		expect(await engine.validateSnapshots(request(), signal, async () => raw(current))).toEqual({
			changed: true,
			reliable: true,
		});
		const page = await engine.read(request(), signal, async () => raw(current));
		oldSource.resolve(raw(status));
		expect(await older).toEqual({ changed: false, reliable: false });
		const next = await engine.read(
			{ ...request(), query: { ...request().query, cursor: page.nextCursor as string } },
			signal,
			noRemote,
		);
		expect(next.snapshotId).toBe(page.snapshotId);
		engine.close();
	});

	test("existing cache validation prevents an older ABA read from publishing afterward", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request(), signal, async () => raw(status));
		const older = deferred<GitStatusPageRawResult>();
		const pending = engine.read(request(), signal, () => older.promise);
		expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
			changed: false,
			reliable: true,
		});
		older.resolve(raw(`${status} M dir/temporary\0`));
		await expect(pending).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		const next = await engine.read(
			{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
			signal,
			noRemote,
		);
		expect(next.snapshotId).toBe(first.snapshotId);
		expect(engine.stats.snapshots).toBe(1);
		engine.close();
	});
	test("same full fingerprint preserves cursors and changed membership invalidates them", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request(), signal, async () => raw(status));
		expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
			changed: false,
			reliable: true,
		});
		const second = await engine.read(
			{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
			signal,
			noRemote,
		);
		expect(second.snapshotId).toBe(first.snapshotId);
		expect(
			await engine.validateSnapshots(request(), signal, async () =>
				raw(`${status} M dir/new-change\0`),
			),
		).toEqual({ changed: true, reliable: true });
		await expect(
			engine.read(
				{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
				signal,
				noRemote,
			),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		engine.close();
	});

	test("unknown/incomplete validation retains browsing but never claims reliability", async () => {
		const engine = new GitStatusPageEngine();
		expect(await engine.validateSnapshots(request(), signal, noRemote)).toEqual({
			changed: false,
			reliable: false,
		});
		const first = await engine.read(request(), signal, async () => raw(status));
		expect(
			await engine.validateSnapshots(request(), signal, async () => ({
				stdout: status,
				complete: false,
				limitReason: "remote-truncated",
			})),
		).toEqual({ changed: false, reliable: false });
		expect(
			await engine.validateSnapshots(request(), signal, async () => {
				throw new Error("disconnected");
			}),
		).toEqual({ changed: false, reliable: false });
		const second = await engine.read(
			{ ...request(), query: { ...request().query, cursor: first.nextCursor as string } },
			signal,
			noRemote,
		);
		expect(second.snapshotId).toBe(first.snapshotId);
		engine.close();
	});

	test("initial baseline prevents older unpublished scans from becoming a trusted snapshot", async () => {
		const engine = new GitStatusPageEngine();
		const source = deferred<GitStatusPageRawResult>();
		const pending = engine.read(request(), signal, () => source.promise);
		expect(await engine.validateSnapshots(request(), signal, async () => raw(status))).toEqual({
			changed: false,
			reliable: false,
		});
		source.resolve(raw(`${status} M dir/temporary\0`));
		await expect(pending).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		expect(engine.stats.snapshots).toBe(0);
		const fresh = await engine.read(request(), signal, async () => raw(status));
		expect(fresh.complete).toBe(true);
		engine.close();
	});
});

describe("worker verified batch scope", () => {
	test("directory and filter prove the whole section, not merely loaded page membership", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request(), signal, async () => raw(status));
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

	test("actor, workspace, source generation and query filter must match the cached observation", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request(), signal, async () => raw(status));
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

	test("external membership/status/rename changes and incomplete fresh scans reject writes", async () => {
		for (const next of [
			raw(`${status} M dir/added-later\0`),
			raw(status.replace("MM dir/b", " M dir/b")),
			raw(`${status}R  renamed\0old\0`),
			raw(status, false),
		]) {
			const engine = new GitStatusPageEngine();
			const first = await engine.read(request(), signal, async () => raw(status));
			const proof: GitStatusPageScopeProof = {
				snapshotId: first.snapshotId,
				filter: ["M"],
				section: "unstaged",
				directory: "dir",
			};
			await expect(
				engine.assertScope(
					{ ...request(), proof, files: ["dir/a", "dir/b"] },
					signal,
					async () => next,
				),
			).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
			engine.close();
		}
	});

	test("ninth-snapshot eviction, idle expiry and partial cached scans cannot authorize a batch", async () => {
		let now = 0;
		const engine = new GitStatusPageEngine(undefined, () => now);
		const first = await engine.read(request(), signal, async () => raw(status));
		const proof: GitStatusPageScopeProof = {
			snapshotId: first.snapshotId,
			filter: ["M"],
			section: "unstaged",
			directory: "dir",
		};
		for (let index = 0; index < 8; index++)
			await engine.read(request(), signal, async () => raw(status));
		expect(engine.stats.snapshots).toBe(8);
		await expect(
			engine.assertScope({ ...request(), proof, files: ["dir/a", "dir/b"] }, signal, noRemote),
		).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		const fresh = await engine.read(request(), signal, async () => raw(status));
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
		const partial = await engine.read(request(), signal, async () => raw(status, false));
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

	test("eviction during write-time fresh scan rejects the result before authorization", async () => {
		const engine = new GitStatusPageEngine();
		const first = await engine.read(request(), signal, async () => raw(status));
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
		for (let index = 0; index < 8; index++)
			await engine.read(request(), signal, async () => raw(status));
		source.resolve(raw(status));
		await expect(pending).rejects.toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
		engine.close();
	});
});

test("parent service transports validation and scope proofs to the same isolated Worker", async () => {
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
		const first = await pages.read({ ...request(), source });
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
		const next = await pages.read({
			...request(),
			source,
			query: { ...request().query, cursor: first.nextCursor as string },
		});
		expect(next.snapshotId).toBe(first.snapshotId);
		expect(scans).toBe(3);
		stdout += " M dir/late\0";
		const failure = await pages
			.assertScope({
				scope: request().scope,
				source,
				proof: {
					snapshotId: first.snapshotId,
					filter: ["M"],
					section: "unstaged",
					directory: "dir",
				},
				files: ["dir/a", "dir/b"],
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(failure).toMatchObject({ code: "GIT_STATUS_PAGE_EXPIRED" });
	} finally {
		await pages.close();
	}
});
