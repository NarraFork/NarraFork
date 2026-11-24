import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	GitStagingListsChanged,
	GitStagingObservationState,
	GitWorkspaceCategory,
} from "@shared/git-workspace-events";
import { eventBus } from "../lib/event-bus";
import { createGitStagingListsService } from "./git-staging-lists-service";
import { markStatusDirty } from "./git-status-cache";
import type { GitWorkspaceTarget } from "./git-workspace";
import {
	GitWorkspaceWatchPool,
	probeGitStagingState,
	probeGitWatch,
	settleGitStagingWatch,
} from "./git-workspace-watch";

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("watch condition timed out");
		await pause();
	}
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "nf-changelist-watch-"));
	const git = (...args: string[]) =>
		promisify(execFile)(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.test",
				"-c",
				"commit.gpgSign=false",
				...args,
			],
			{ cwd: root, timeout: 10_000, maxBuffer: 32_768 },
		);
	await git("init", "--quiet");
	await writeFile(join(root, "f"), "base\n");
	await git("add", "f");
	await git("commit", "--quiet", "-m", "base");
	await writeFile(join(root, "f"), "first\n");
	const directory = join(root, ".git", "narrafork", "changelists");
	const service = createGitStagingListsService(
		{
			rootPath: root,
			workspaceKey: root,
			authorizationKey: "fixture:narrator",
			beforeWrite: async () => {},
			authorizePaths: async () => {},
		},
		{ changed: (event) => eventBus.emit({ type: "git:staging_lists_changed", ...event }) },
	);
	await service.action({ action: "init" });
	const target = {
		workspace: { rootPath: root, deviceId: "local", workspaceKey: root, repositoryKey: root },
		backend: { kind: "local" },
	} as GitWorkspaceTarget;
	return {
		root,
		directory,
		git,
		service,
		target,
		close: () => rm(root, { recursive: true, force: true }),
	};
}
function observer(f: Awaited<ReturnType<typeof fixture>>, actualWorktree = false, writable = true) {
	const events: GitStagingListsChanged[] = [];
	const onEvent = (event: GitStagingListsChanged) => {
		if (event.workspaceKey === f.root) events.push(event);
	};
	eventBus.on("git:staging_lists_changed", onEvent);
	let probes = 0;
	const invalidate = mock(() => {});
	const pool = new GitWorkspaceWatchPool(
		async (target, signal, onStaging, previous) => {
			probes++;
			if (actualWorktree) return probeGitWatch(target, signal, onStaging, previous);
			const state = await probeGitStagingState(f.root, signal);
			onStaging?.(state);
			return {
				fingerprints: { worktree: "stable" },
				uncertain: [],
				stagingListsState: state,
				stagingListsFingerprint: state.fingerprint,
			};
		},
		100,
		{
			status: async () => {
				throw new Error("unused");
			},
			lineStats: async () => {
				throw new Error("unused");
			},
			invalidate,
			validate: () => {},
		},
	);
	const categories: GitWorkspaceCategory[][] = [];
	const observations: GitStagingObservationState[] = [];
	const off = pool.subscribe(
		f.target,
		(changed) => categories.push(changed),
		undefined,
		actualWorktree
			? {
					authorizationKey: "fixture:narrator",
					writable,
					beforeWrite: async () => {},
					authorizePaths: async () => {},
					observation: (state) => observations.push(state),
				}
			: undefined,
	);
	return {
		events,
		observations,
		categories,
		invalidate,
		probes: () => probes,
		close: async () => {
			off();
			eventBus.off("git:staging_lists_changed", onEvent);
			await settleGitStagingWatch(f.root);
		},
	};
}

test("SQLite observations ignore every legacy JSON/index artifact", async () => {
	const f = await fixture();
	try {
		const before = await probeGitStagingState(f.root, new AbortController().signal);
		await mkdir(join(f.directory, "lists"));
		await mkdir(join(f.directory, "indexes"));
		await writeFile(join(f.directory, "lists", "legacy.json"), "broken old metadata");
		await writeFile(join(f.directory, "indexes", "legacy.index"), "frozen index");
		const after = await probeGitStagingState(f.root, new AbortController().signal);
		expect(after.listIds).toEqual(before.listIds);
		expect(after.generation).toBe(before.generation);
		expect(after.fingerprint).toBe(before.fingerprint);
	} finally {
		await f.close();
	}
}, 20_000);

test("WAL-only external transactions refresh all affected groups and carry the published version", async () => {
	const f = await fixture();
	const observe = observer(f);
	let db: Database | undefined;
	try {
		await waitFor(() => observe.probes() >= 2);
		await settleGitStagingWatch(f.root);
		db = new Database(join(f.directory, "changelists.sqlite"));
		db.exec("PRAGMA wal_autocheckpoint=0");
		const main = await readFile(join(f.directory, "changelists.sqlite"));
		db.transaction(() => {
			db?.query("UPDATE change_lists SET name='external name'").run();
			db?.query("UPDATE workspace_state SET generation=generation+1").run();
		})();
		expect(await readFile(join(f.directory, "changelists.sqlite"))).toEqual(main);
		await waitFor(() => observe.events.some((event) => event.generation !== undefined));
		const latest = await f.service.summary();
		expect(observe.events.at(-1)).toMatchObject({
			metadataChanged: true,
			generation: latest.generation,
			observationId: latest.observationId,
			affectedListIds: latest.lists.map((list) => list.id),
		});
	} finally {
		await observe.close();
		db?.close();
		await f.close();
	}
}, 20_000);

test("application writes acknowledge their database baseline without a refresh loop", async () => {
	const f = await fixture();
	const observe = observer(f);
	try {
		await waitFor(() => observe.probes() >= 3);
		await settleGitStagingWatch(f.root);
		observe.events.length = 0;
		const summary = await f.service.summary();
		if (!summary.observationId) throw new Error("No observation");
		await f.service.action({
			action: "create",
			name: "B",
			expectedGeneration: summary.generation,
			observationId: summary.observationId,
		});
		await settleGitStagingWatch(f.root);
		const initialEvents = observe.events.length;
		const baseline = observe.probes();
		await waitFor(() => observe.probes() >= baseline + 3);
		expect(observe.events).toHaveLength(initialEvents);
		expect(initialEvents).toBe(1);
	} finally {
		await observe.close();
		await f.close();
	}
}, 20_000);

test("working file edits trigger one shared Worker observation and preserve the native index", async () => {
	const f = await fixture();
	const observe = observer(f, true);
	try {
		const native = await readFile(join(f.root, ".git", "index"));
		await waitFor(() => observe.probes() >= 3);
		await settleGitStagingWatch(f.root);
		const before = await f.service.summary();
		await writeFile(join(f.root, "f"), "second\nthird\n");
		markStatusDirty(f.root);
		await waitFor(async () => (await f.service.summary()).observationId !== before.observationId);
		expect(await readFile(join(f.root, ".git", "index"))).toEqual(native);
		const after = await f.service.summary();
		if (!after.activeListId) throw new Error("Missing active group");
		expect((await f.service.diff(after.activeListId, { path: "f" })).diff).toContain("third");
		expect(observe.categories.some((categories) => categories.includes("worktree"))).toBe(true);
	} finally {
		await observe.close();
		await f.close();
	}
}, 20_000);

test("readonly worktree subscribers never synchronize; an authorized manual target settles their state", async () => {
	const f = await fixture();
	const observe = observer(f, true, false);
	try {
		const before = await f.service.summary();
		const native = await readFile(join(f.root, ".git", "index"));
		await waitFor(() => observe.probes() >= 2);
		await writeFile(join(f.root, "f"), "readable pending edit\n");
		markStatusDirty(f.root);
		const baseline = observe.probes();
		await waitFor(() => observe.probes() >= baseline + 3);
		expect((await f.service.summary()).observationId).toBe(before.observationId);
		expect(observe.observations.at(-1)?.status).toBe("pending");
		const result = await f.service.action({ action: "sync" });
		expect(result.observation?.status).toBe("settled");
		expect(result.observation?.completedEpoch).toBeGreaterThanOrEqual(
			result.observationTargetEpoch ?? Infinity,
		);
		expect((await f.service.summary()).observationId).not.toBe(before.observationId);
		expect(await readFile(join(f.root, ".git", "index"))).toEqual(native);
	} finally {
		await observe.close();
		await f.close();
	}
}, 20_000);

test("manual no-op synchronization publishes settled state without a redundant changed event or watch loop", async () => {
	const f = await fixture();
	const observe = observer(f, true);
	try {
		await waitFor(() => observe.observations.at(-1)?.status === "settled");
		await settleGitStagingWatch(f.root);
		const before = await f.service.summary();
		observe.events.length = 0;
		const sequence = observe.observations.at(-1)?.stateSequence ?? 0;
		const result = await f.service.action({ action: "sync" });
		expect(result.generation).toBe(before.generation);
		expect(result.observationId).toBe(before.observationId);
		expect(result.observation?.stateSequence).toBeGreaterThan(sequence);
		await settleGitStagingWatch(f.root);
		const count = observe.probes();
		await waitFor(() => observe.probes() >= count + 3);
		expect(observe.events).toEqual([]);
		expect(observe.observations.at(-1)?.status).toBe("settled");
	} finally {
		await observe.close();
		await f.close();
	}
}, 20_000);

test("linked worktrees resolve their real Git-dir and independent SQLite state", async () => {
	const f = await fixture();
	const linked = `${f.root}-linked`;
	try {
		await f.git("worktree", "add", "--quiet", "-b", "linked", linked);
		await writeFile(join(linked, "file"), "linked\n");
		const service = createGitStagingListsService({
			rootPath: linked,
			workspaceKey: linked,
			beforeWrite: async () => {},
		});
		await service.action({ action: "init" });
		const state = await probeGitStagingState(linked, new AbortController().signal);
		expect(state.listIds).not.toEqual((await f.service.summary()).lists.map((list) => list.id));
		expect((await lstat(join(linked, ".git"))).isFile()).toBe(true);
	} finally {
		await rm(linked, { recursive: true, force: true });
		await f.close();
	}
}, 20_000);

test("a disabled Worker explicitly rejects metadata probes instead of scanning on the service thread", async () => {
	const previous = process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
	process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER = "1";
	try {
		await expect(
			probeGitStagingState("/not-read", new AbortController().signal),
		).rejects.toMatchObject({ code: "GIT_STAGING_WORKER_UNAVAILABLE" });
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER;
		else process.env.NARRAFORK_DISABLE_GIT_STAGING_WORKER = previous;
	}
});
