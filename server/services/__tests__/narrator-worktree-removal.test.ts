import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeDependent } from "@shared/narrator-worktrees";
import { sqlite } from "../../db";
import { LocalBackend } from "../../lib/agent/execution/local-backend";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { safeSpawn } from "../../lib/spawn";
import {
	NarratorWorktreeService,
	WORKTREE_MAX_OUTPUT_BYTES,
	type WorktreeRegistrationSnapshot,
	type WorktreeRetirementPorts,
	type WorktreeServicePorts,
	type WorktreeTarget,
} from "../narrator-worktree-service";
import { maintainProtectionIndex } from "../resource-protection-index";
import { type LifecycleGuardPorts, withLifecycleGuardPorts } from "../worktree-lifecycle-guard";

let temporary: string;
let source: string;
let worktreePath: string;
let target: WorktreeTarget;
let ports: WorktreeServicePorts<string>;
let service: NarratorWorktreeService<string>;
let calls: string[];
let dependents: WorktreeDependent[];
let registration: { id: string; state: "preparing" | "ready" | "unknown" } | null;
let containers: number;
let failGit: boolean;
let snapshot: WorktreeRegistrationSnapshot | null;
let revision: number;
const signal = () => new AbortController().signal;

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({
		cmd: ["git", "-C", cwd, ...args],
		timeout: 10_000,
		maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** The guard's real protection index must never be consulted by a fixture test. */
const guardPorts: LifecycleGuardPorts = {
	readClaims: async () => ({ complete: true, claims: [] }),
	canonicalPath: async (path) => path,
	pathIdentity: async (path) => {
		const node = await lstat(path).catch(() => null);
		return node ? `${node.dev}:${node.ino}` : null;
	},
};

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "narrafork-worktree-removal-"));
	source = join(temporary, "repo");
	worktreePath = join(source, ".worktrees", "feature");
	await mkdir(source);
	await git(["init", "-b", "main"]);
	await writeFile(join(source, "tracked.txt"), "committed\n");
	await git(["add", "tracked.txt"]);
	await git(["-c", "user.name=F", "-c", "user.email=f@e.test", "commit", "-m", "initial"]);
	await mkdir(join(source, ".worktrees"));
	await writeFile(join(source, ".gitignore"), ".worktrees/\n");
	await git(["worktree", "add", "-b", "feature", worktreePath]);
	target = {
		workspace: {
			deviceId: "local",
			cwd: source,
			rootPath: source,
			workspaceKey: "workspace",
			repositoryKey: "repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: new LocalBackend(),
		repositoryPath: join(source, ".git"),
	};
	calls = [];
	dependents = [];
	registration = { id: "registration", state: "ready" };
	containers = 0;
	failGit = false;
	snapshot = null;
	revision = 4;
	const retirement: WorktreeRetirementPorts = {
		inspect: async () => {
			calls.push("inspect");
			return {
				registration,
				dependents,
				inventory: {
					backgroundTasks: 0,
					browserSessions: 0,
					terminals: 0,
					containers,
					volumeSnapshots: 0,
					treeSnapshots: 2,
				},
				truncated: false,
				revision,
			};
		},
		relocate: async (input) => {
			calls.push(`relocate:${input.mode}:${input.dependent.id}`);
			return { relocated: true };
		},
		stopRuntime: async (input) => {
			calls.push(`stopRuntime:${input.dependent.id}`);
			return { cancelledTasks: 1, closedBrowsers: 0 };
		},
		archiveSubagent: async (dependent) => {
			calls.push(`archive:${dependent.id}`);
		},
		releaseAttachments: async () => {
			calls.push("releaseAttachments");
			return { closedTerminals: 1 };
		},
		releaseRegistration: async (input) => {
			calls.push("releaseRegistration");
			snapshot = {
				id: input.registrationId,
				ownerNarratorId: "narrator",
				deviceId: "local",
				repositoryKey: "repository",
				worktreePath: input.worktreePath,
				createRequestId: "request",
				scopeKind: "standalone",
				scopeProjectId: null,
				scopeOwnerUserId: "user",
				ownershipRevision: 0,
				state: "ready",
				containerConfig: null,
				createdAt: new Date().toISOString(),
			};
			return snapshot;
		},
		restoreRegistration: async () => {
			// The port owns the restored state (`unknown`); the service only asks for it.
			calls.push("restoreRegistration");
		},
		releasePathRows: async () => {
			calls.push("releasePathRows");
			return 2;
		},
	};
	ports = {
		authorize: async () => target,
		withRevision: async (_id, expected, action) => {
			expect(expected).toBe(revision);
			return action();
		},
		withRepositoryLock: async (_key, action) => action(),
		journal: {
			read: async () => null,
			claim: async () => {
				throw new Error("removal must not claim a creation receipt");
			},
			save: async () => undefined,
		},
		runGit: (workspace, args, abort, writing, scope) => {
			if (writing) calls.push(`git:${args.join(" ")}`);
			if (failGit && writing)
				return Promise.resolve({ stdout: "", stderr: "fatal: nope", exitCode: 1 });
			const cwd =
				scope?.kind === "directory"
					? scope.path
					: scope?.kind === "repository"
						? source
						: (workspace.workspace.rootPath ?? source);
			return safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", cwd, ...args],
				timeout: 10_000,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
				signal: abort,
			});
		},
		retirement,
	};
	service = new NarratorWorktreeService(ports);
});

afterEach(async () => {
	await rm(temporary, { recursive: true, force: true });
});

const run = <T>(action: () => Promise<T>): Promise<T> =>
	withLifecycleGuardPorts(guardPorts, action);

describe("worktree removal plan", () => {
	test("reports state, effects and dependents without writing anything", async () => {
		dependents = [
			{ id: "narrator", title: "Self", status: "idle", kind: "self", running: false },
			{
				id: "sub",
				title: "Sub",
				status: "archived",
				kind: "subagent",
				running: false,
			},
		];
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.status).toBe("ready");
		expect(plan.worktree).toMatchObject({
			mode: "remove",
			present: true,
			registered: true,
			registrationId: "registration",
			dirty: false,
		});
		expect(plan.worktree.branch).toBe("refs/heads/feature");
		expect(plan.dependents).toHaveLength(2);
		expect(plan.inventory.treeSnapshots).toBe(2);
		expect(plan.confirmations).toEqual([]);
		expect(plan.expectedRevision).toBe(4);
		expect(calls).toEqual(["inspect"]);
		expect(await lstat(worktreePath).then(() => true)).toBe(true);
	});

	test("blocks on a root conversation that still records the directory", async () => {
		dependents = [
			{ id: "narrator", title: "Self", status: "idle", kind: "self", running: false },
			{ id: "other", title: "Other", status: "idle", kind: "primary", running: false },
		];
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.status).toBe("blocked");
		expect(plan.blockers[0]).toMatchObject({
			code: "WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED",
			params: { count: 1 },
		});
		expect(plan.blockers[0]?.dependents?.map((item) => item.id)).toEqual(["other"]);
	});

	test("blocks on a running subagent and on the requesting session itself", async () => {
		dependents = [
			{ id: "narrator", title: "Self", status: "working", kind: "self", running: true },
			{ id: "sub", title: "Sub", status: "working", kind: "subagent", running: true },
		];
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
			"WORKTREE_REMOVAL_BUSY",
			"WORKTREE_REMOVAL_DEPENDENT_RUNNING",
		]);
	});

	test("blocks while a container or volume snapshot still owns the resource", async () => {
		containers = 1;
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.blockers[0]?.code).toBe("WORKTREE_REMOVAL_RESOURCE_IN_USE");
	});

	test("asks for confirmation only when the checkout is dirty or unregistered", async () => {
		await writeFile(join(worktreePath, "dirty.txt"), "uncommitted\n");
		let plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.worktree.dirty).toBe(true);
		expect(plan.worktree.dirtyFileCount).toBeGreaterThan(0);
		expect(plan.confirmations).toEqual(["force"]);
		registration = null;
		plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.confirmations).toEqual(["force", "acknowledgeUnregistered"]);
	});

	test("refuses the repository's own working tree", async () => {
		await git(["worktree", "add", "-b", "second", join(temporary, "second")]);
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: source },
			signal(),
		);
		expect(plan.blockers[0]?.code).toBe("WORKTREE_REMOVAL_MAIN_ROOT");
	});
});

describe("worktree removal", () => {
	test("retires sessions and runtime before Git, then cleans path rows", async () => {
		dependents = [
			{ id: "narrator", title: "Self", status: "idle", kind: "self", running: false },
			{ id: "sub", title: "Sub", status: "archived", kind: "subagent", running: false },
			{ id: "old", title: "Old", status: "archived", kind: "primary", running: false },
		];
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				{
					expectedRevision: 4,
					workspaceKey: "workspace",
					path: worktreePath,
				},
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
		expect(result.effects).toMatchObject({
			relocated: 3,
			archivedSubagents: 1,
			closedTerminals: 1,
			removedTreeSnapshots: 2,
		});
		expect(result.relocatedTo).toBe(source);
		// The checkout is gone, and the requesting session left it through a real switch.
		expect(await lstat(worktreePath).catch(() => null)).toBeNull();
		expect(calls).toEqual([
			"inspect",
			"stopRuntime:narrator",
			"relocate:switch:narrator",
			"stopRuntime:sub",
			"archive:sub",
			"relocate:repair:sub",
			"stopRuntime:old",
			"relocate:repair:old",
			"releaseAttachments",
			"releaseRegistration",
			`git:worktree remove -- ${worktreePath}`,
			"releasePathRows",
		]);
	});

	test("a stale expected revision is refused before anything is written", async () => {
		revision = 9;
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_STALE" });
		expect(calls).toEqual(["inspect"]);
	});

	test("uncommitted changes need the explicit force confirmation", async () => {
		await writeFile(join(worktreePath, "dirty.txt"), "uncommitted\n");
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_FORCE_REQUIRED" });
		const head = await git(["rev-parse", "HEAD"], worktreePath);
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				{
					expectedRevision: 4,
					workspaceKey: "workspace",
					path: worktreePath,
					force: true,
					confirmedLoss: { head, dirtyFileCount: 1, unreachableCommits: 0 },
				},
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
		expect(calls).toContain(`git:worktree remove --force -- ${worktreePath}`);
	});

	test("an unregistered checkout needs an explicit acknowledgement", async () => {
		registration = null;
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_ACKNOWLEDGEMENT_REQUIRED" });
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				{
					expectedRevision: 4,
					workspaceKey: "workspace",
					path: worktreePath,
					acknowledgeUnregistered: true,
				},
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
	});

	test("a deleted checkout only loses its Git entry, removed by path", async () => {
		await rm(worktreePath, { recursive: true, force: true });
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
		expect(result.effects.prunedRegistrations).toBe(1);
		expect(calls).toContain(`git:worktree remove -- ${worktreePath}`);
		expect(await git(["worktree", "list", "--porcelain"])).not.toContain(worktreePath);
	});

	test("a failed Git removal restores the owner row as unknown", async () => {
		failGit = true;
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_FAILED" });
		expect(calls).toContain("restoreRegistration");
		expect(calls).not.toContain("releasePathRows");
		expect(await lstat(worktreePath).then(() => true)).toBe(true);
	});

	test("a path that is already fully gone reports already_absent", async () => {
		await rm(worktreePath, { recursive: true, force: true });
		await git(["worktree", "prune"]);
		registration = null;
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(result.outcome).toBe("already_absent");
		expect(calls).not.toContain("releaseRegistration");
		expect(calls).not.toContain("releasePathRows");
	});

	test("the protection reservation still refuses a path claimed after the relocation", async () => {
		// A claim that reappears between relocation and the destructive step must win.
		const protectedPorts: LifecycleGuardPorts = {
			...guardPorts,
			readClaims: async () => ({
				complete: true,
				claims: [{ kind: "narrator", id: "late", deviceId: "local", path: worktreePath }],
			}),
		};
		await expect(
			withLifecycleGuardPorts(protectedPorts, () =>
				service.remove(
					"actor",
					"narrator",
					{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
		expect(calls).toContain("releaseRegistration");
		expect(calls).toContain("restoreRegistration");
		expect(calls).not.toContain("releasePathRows");
		expect(await lstat(worktreePath).then((node) => node.isDirectory())).toBe(true);
	});

	test("a checkout Git no longer lists is left on disk and only its rows are retired", async () => {
		registration = null;
		// Losing the admin entry is what makes Git forget a checkout that is still there.
		await rm(join(source, ".git", "worktrees", "feature"), { recursive: true, force: true });
		expect(await git(["worktree", "list", "--porcelain"])).not.toContain(worktreePath);
		expect(await lstat(worktreePath).then((node) => node.isDirectory())).toBe(true);
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.worktree.mode).toBe("rows");
		expect(plan.confirmations).toEqual([]);
	});

	test("refuses a path Git never listed and NarraFork never registered", async () => {
		// `rows` removal still closes terminals and moves sessions, so an ordinary directory
		// must not reach it: only the managed namespace or a durable owner row is a target.
		registration = null;
		const plain = join(source, "src");
		await mkdir(plain, { recursive: true });
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: plain },
			signal(),
		);
		expect(plan.worktree.mode).toBe("rows");
		expect(plan.status).toBe("blocked");
		expect(plan.blockers.map((item) => item.code)).toContain("WORKTREE_REMOVAL_UNKNOWN_PATH");
		await expect(
			service.remove(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", path: plain },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_UNKNOWN_PATH" });
		expect(calls).not.toContain("releaseAttachments");
		expect(calls).not.toContain("releasePathRows");
		expect(await lstat(plain).then((node) => node.isDirectory())).toBe(true);
	});

	test("an unregistered deleted checkout is cleared by path; sibling stale entries stay", async () => {
		// `git worktree prune` has no path argument, so it is never used.
		registration = null;
		const other = join(source, ".worktrees", "other");
		await git(["worktree", "add", "-b", "other", other]);
		await rm(worktreePath, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
		const plan = await service.planRemoval(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", path: worktreePath },
			signal(),
		);
		expect(plan.worktree.mode).toBe("prune");
		expect(plan.worktree.pruneSiblings).toBe(0);
		const result = await service.remove(
			"actor",
			"narrator",
			{
				expectedRevision: 4,
				workspaceKey: "workspace",
				path: worktreePath,
				acknowledgeUnregistered: true,
			},
			signal(),
		);
		expect(result.outcome).toBe("removed");
		expect(result.effects.prunedRegistrations).toBe(1);
		expect(await git(["worktree", "list", "--porcelain"])).toContain(other);
	});

	test("a session that had already left is not reported as relocated", async () => {
		dependents = [{ id: "old", title: "Old", status: "archived", kind: "primary", running: false }];
		const retirement = ports.retirement;
		if (!retirement) throw new Error("fixture must wire retirement");
		const original = retirement.relocate;
		retirement.relocate = async (input) => {
			calls.push(`relocate:${input.mode}:${input.dependent.id}`);
			return { relocated: false };
		};
		try {
			const result = await service.remove(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", path: worktreePath },
				signal(),
			);
			expect(result.effects.relocated).toBe(0);
		} finally {
			retirement.relocate = original;
		}
	});
});

/**
 * Holes the Teams G1 reviews found in a parallel removal design, checked against this
 * channel. Each test fails on the channel as first merged (#493).
 */
describe("worktree removal hardening", () => {
	const removeRequest = (extra: Record<string, unknown> = {}) => ({
		expectedRevision: 4,
		workspaceKey: "workspace",
		path: worktreePath,
		...extra,
	});

	test("a request cancelled after Git was dispatched still finishes; the row is not restored", async () => {
		const controller = new AbortController();
		const runGit = ports.runGit;
		if (!runGit) throw new Error("fixture must wire runGit");
		ports.runGit = async (workspace, args, abort, writing, scope) => {
			const result = await runGit(workspace, args, abort, writing, scope);
			// The client disconnects while Git deletes the checkout.
			if (writing && args[0] === "worktree") controller.abort();
			return result;
		};
		const result = await run(() =>
			service.remove("actor", "narrator", removeRequest(), controller.signal),
		);
		expect(result.outcome).toBe("removed");
		expect(calls).not.toContain("restoreRegistration");
		expect(calls).toContain("releasePathRows");
		expect(await lstat(worktreePath).catch(() => null)).toBeNull();
	});

	test("force removes exactly the loss the person confirmed; anything that grew is refused", async () => {
		await writeFile(join(worktreePath, "dirty.txt"), "uncommitted\n");
		const plan = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(plan.worktree).toMatchObject({ dirtyFileCount: 1, dirtyExact: true });
		const confirmedLoss = {
			head: plan.worktree.head,
			dirtyFileCount: 1,
			unreachableCommits: 0,
		};
		// A bare force is not a confirmation of anything in particular.
		await expect(
			run(() => service.remove("actor", "narrator", removeRequest({ force: true }), signal())),
		).rejects.toThrow();
		await writeFile(join(worktreePath, "late.txt"), "written after the confirmation\n");
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					removeRequest({ force: true, confirmedLoss }),
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_CHANGED" });
		// An inflated confirmation is not the report either.
		await expect(
			run(() =>
				service.remove(
					"actor",
					"narrator",
					removeRequest({ force: true, confirmedLoss: { ...confirmedLoss, dirtyFileCount: 99 } }),
					signal(),
				),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_CHANGED" });
		expect(calls).not.toContain("releaseRegistration");
		expect(await lstat(join(worktreePath, "late.txt")).then(() => true)).toBe(true);
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				removeRequest({ force: true, confirmedLoss: { ...confirmedLoss, dirtyFileCount: 2 } }),
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
	});

	test("a status probe that fails or is killed blocks removal instead of reading as clean", async () => {
		await writeFile(join(worktreePath, "unsaved.txt"), "x\n");
		const runGit = ports.runGit;
		if (!runGit) throw new Error("fixture must wire runGit");
		ports.runGit = async (workspace, args, abort, writing, scope) =>
			args[0] === "status"
				? { stdout: "", stderr: "", exitCode: 143 }
				: runGit(workspace, args, abort, writing, scope);
		const plan = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(plan.status).toBe("blocked");
		expect(plan.blockers.map((item) => item.code)).toContain("WORKTREE_REMOVAL_STATUS_UNAVAILABLE");
		await expect(
			run(() => service.remove("actor", "narrator", removeRequest(), signal())),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_STATUS_UNAVAILABLE" });
		expect(calls).not.toContain("releaseRegistration");
		expect(await lstat(join(worktreePath, "unsaved.txt")).then(() => true)).toBe(true);
	});

	test("commits only a detached HEAD reaches are a loss that must be confirmed", async () => {
		await git(["checkout", "-q", "--detach"], worktreePath);
		await writeFile(join(worktreePath, "only-here.txt"), "x\n");
		await git(["add", "only-here.txt"], worktreePath);
		await git(
			["-c", "user.name=F", "-c", "user.email=f@e.test", "commit", "-qm", "detached"],
			worktreePath,
		);
		const head = await git(["rev-parse", "HEAD"], worktreePath);
		const plan = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(plan.worktree).toMatchObject({
			detached: true,
			dirtyFileCount: 0,
			unreachableCommits: 1,
		});
		expect(plan.confirmations).toContain("force");
		await expect(
			run(() => service.remove("actor", "narrator", removeRequest(), signal())),
		).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_FORCE_REQUIRED" });
		expect(await lstat(worktreePath).then(() => true)).toBe(true);
		const result = await run(() =>
			service.remove(
				"actor",
				"narrator",
				removeRequest({
					force: true,
					confirmedLoss: { head, dirtyFileCount: 0, unreachableCommits: 1 },
				}),
				signal(),
			),
		);
		expect(result.outcome).toBe("removed");
	});

	test("commits a branch still holds are not a loss", async () => {
		await writeFile(join(worktreePath, "kept.txt"), "x\n");
		await git(["add", "kept.txt"], worktreePath);
		await git(
			["-c", "user.name=F", "-c", "user.email=f@e.test", "commit", "-qm", "on branch"],
			worktreePath,
		);
		const plan = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(plan.worktree.unreachableCommits).toBe(0);
		expect(plan.confirmations).toEqual([]);
	});

	test("a deleted checkout removes only its own Git entry; other stale entries stay", async () => {
		const other = join(source, ".worktrees", "other");
		await git(["worktree", "add", "-b", "other", other]);
		await rm(worktreePath, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
		const plan = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: worktreePath },
				signal(),
			),
		);
		expect(plan.worktree).toMatchObject({ mode: "prune", pruneSiblings: 0 });
		const result = await run(() => service.remove("actor", "narrator", removeRequest(), signal()));
		expect(result.effects.prunedRegistrations).toBe(1);
		expect(calls).not.toContain("git:worktree prune");
		const listing = await git(["worktree", "list", "--porcelain"]);
		expect(listing).not.toContain(worktreePath);
		expect(listing).toContain(other);
	});

	test("rows mode never asks Git about a directory it does not list", async () => {
		// R1: a registered directory outside any repository. `git status` there fails, but
		// rows mode deletes nothing on disk, so there is nothing to measure.
		const sibling = join(temporary, "sibling");
		await mkdir(sibling);
		await writeFile(join(sibling, "data.txt"), "x");
		const runGit = ports.runGit;
		if (!runGit) throw new Error("fixture must wire runGit");
		const probes: string[][] = [];
		ports.runGit = async (workspace, args, abort, writing, scope) => {
			if (scope?.kind === "directory") probes.push(args);
			return runGit(workspace, args, abort, writing, scope);
		};
		const outside = await run(() =>
			service.planRemoval(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", path: sibling },
				signal(),
			),
		);
		expect(outside.worktree.mode).toBe("rows");
		expect(outside.status).toBe("ready");
		expect(outside.blockers).toEqual([]);
		expect(outside.confirmations).toEqual([]);
		expect(outside.worktree).toMatchObject({ dirtyFileCount: 0, unreachableCommits: 0 });
		// R2: a plain directory under `.worktrees/` that Git does not list. `git status`
		// would walk up to the main checkout and report ITS changes as this path's loss.
		registration = null;
		const old = join(source, ".worktrees", "chapter-old");
		await mkdir(old);
		await writeFile(join(old, "notes.md"), "x");
		await writeFile(join(source, "tracked.txt"), "main edit\n");
		const legacy = await run(() =>
			service.planRemoval("actor", "narrator", { workspaceKey: "workspace", path: old }, signal()),
		);
		expect(legacy.worktree.mode).toBe("rows");
		expect(legacy.worktree).toMatchObject({ dirty: false, dirtyFileCount: 0 });
		expect(legacy.confirmations).toEqual([]);
		expect(probes).toEqual([]);
	});

	test("a session at the main checkout of the same repository does not block the removal", async () => {
		// Every session in this repository carries its repository key; only a claim inside
		// the checkout (or one that cannot be told apart from it) may protect it.
		const sameRepository: LifecycleGuardPorts = {
			...guardPorts,
			readClaims: async () => ({
				complete: true,
				claims: [
					{
						kind: "narrator",
						id: "root",
						deviceId: "local",
						path: source,
						repositoryKey: "repository",
					},
				],
			}),
			probeGitRoot: async (path) => ({ root: path, common: join(source, ".git") }),
		};
		const result = await withLifecycleGuardPorts(sameRepository, () =>
			service.remove("actor", "narrator", removeRequest(), signal()),
		);
		expect(result.outcome).toBe("removed");
	});

	test("only the worktree's own creation receipt is waived, matched by its recorded request", async () => {
		const receipt = (requestId: string): LifecycleGuardPorts => ({
			...guardPorts,
			readClaims: async () => ({
				complete: true,
				claims: [
					{
						kind: "receipt",
						id: "/journal/creation.json",
						deviceId: "local",
						path: worktreePath,
						repositoryKey: "repository",
					},
				],
			}),
			receiptRequest: async () => ({ requestId, destination: worktreePath }),
		});
		// The fixture snapshot's createRequestId is "request".
		await expect(
			withLifecycleGuardPorts(receipt("someone-else"), () =>
				service.remove("actor", "narrator", removeRequest(), signal()),
			),
		).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
		expect(calls).toContain("restoreRegistration");
		// An unreadable receipt proves nothing and keeps protecting.
		await expect(
			withLifecycleGuardPorts({ ...receipt("request"), receiptRequest: async () => null }, () =>
				service.remove("actor", "narrator", removeRequest(), signal()),
			),
		).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
		const result = await withLifecycleGuardPorts(receipt("request"), () =>
			service.remove("actor", "narrator", removeRequest(), signal()),
		);
		expect(result.outcome).toBe("removed");
	});

	test("through the real protection index: its own legacy receipt is waived without an owner", async () => {
		// The receipt is matched by the request it records, so a deleted owner session
		// (owner_narrator_id set to null) cannot make the worktree unremovable.
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		const file = join(directory, `${createHash("sha256").update(worktreePath).digest("hex")}.json`);
		const importReceipts = async () => {
			sqlite.exec(`UPDATE resource_protection_sources SET complete = 0, cursor = NULL
				WHERE source = 'receipt' AND source_id = ''`);
			for (let batch = 0; batch < 8; batch++) {
				await maintainProtectionIndex(performance.now() + 5000);
				const state = sqlite
					.query<{ complete: number }, []>(
						"SELECT complete FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ''",
					)
					.get();
				if (state?.complete) return;
			}
			throw new Error("Receipt import did not complete");
		};
		const receipt = (requestId: string) =>
			JSON.stringify({
				proposalHash: "fixture",
				request: { requestId, destinationPath: worktreePath },
				repositoryKey: "repository",
				deviceId: "local",
				destination: worktreePath,
				expectedHead: "",
				dispatchState: "started",
			});
		try {
			await writeFile(file, receipt("someone-else"));
			await importReceipts();
			await expect(
				service.remove("actor", "narrator", removeRequest(), signal()),
			).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
			await writeFile(file, receipt("request"));
			sqlite.exec("DELETE FROM resource_protection_paths WHERE source = 'receipt'");
			sqlite.exec(
				"DELETE FROM resource_protection_sources WHERE source = 'receipt' AND source_id != ''",
			);
			await importReceipts();
			const result = await service.remove("actor", "narrator", removeRequest(), signal());
			expect(result.outcome).toBe("removed");
		} finally {
			await rm(file, { force: true });
			sqlite.exec("DELETE FROM resource_protection_paths WHERE source = 'receipt'");
			sqlite.exec(
				"DELETE FROM resource_protection_sources WHERE source = 'receipt' AND source_id != ''",
			);
		}
	});
});
