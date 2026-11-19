import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ExecutionBackend } from "../../lib/agent/execution/backend";
import { localPathSemantics } from "../../lib/agent/execution/path-semantics";
import { setGitHardeningProbeForTests } from "../../lib/git-exec-hardening";
import { logger } from "../../lib/logger";
import * as spawnModule from "../../lib/spawn";
import type {
	WorktreeRetirementPorts,
	WorktreeServicePorts,
	WorktreeTarget,
} from "../narrator-worktree-service";

// Listing must never reach lifecycle mutations or open the production protection database.
mock.module("../worktree-lifecycle-guard", () => ({
	confirmLifecyclePathRemoved: () => {
		throw new Error("Listing must not confirm removal");
	},
	withProtectionReservation: () => {
		throw new Error("Listing must not reserve removal");
	},
}));
const { NarratorWorktreeService, WORKTREE_LIST_MAX_OUTPUT_BYTES, WORKTREE_READ_TIMEOUT_MS } =
	await import("../narrator-worktree-service");

const head = "a".repeat(40);
const inventory =
	`worktree /fixture/repo\0HEAD ${head}\0branch refs/heads/main\0\0` +
	`worktree /fixture/feature\0HEAD ${head}\0branch refs/heads/feature\0\0`;
const result = (stdout = inventory) => ({ stdout, stderr: "", exitCode: 0 });
const signal = () => new AbortController().signal;

function fixture() {
	const target: WorktreeTarget = {
		workspace: {
			deviceId: "local",
			cwd: "/fixture/repo",
			rootPath: "/fixture/repo",
			workspaceKey: "workspace",
			repositoryKey: "repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: { kind: "local", paths: localPathSemantics } as ExecutionBackend,
		repositoryPath: "/fixture/repo/.git",
	};
	const calls: Parameters<NonNullable<WorktreeServicePorts<string>["runGit"]>>[] = [];
	const ports: WorktreeServicePorts<string> = {
		authorize: async () => target,
		withRevision: async (_id, _revision, work) => work(),
		withRepositoryLock: async (_key, work) => work(),
		journal: {
			read: async () => {
				throw new Error("Listing must not read creation receipts");
			},
			claim: async () => {
				throw new Error("Listing must not claim creation receipts");
			},
			save: async () => {
				throw new Error("Listing must not write creation receipts");
			},
		},
		statDirectory: async () => ({ birthtimeMs: 1000, isDirectory: () => true }),
		runGit: async (...args) => {
			calls.push(args);
			return result(args[1][0] === "show" ? `${head} 2\n` : inventory);
		},
	};
	return { target, ports, calls, service: new NarratorWorktreeService(ports) };
}

// This adapter is used only to advertise capabilities; listing must not call its methods.
const retirement = new Proxy({} as WorktreeRetirementPorts, {
	get() {
		throw new Error("Listing must not invoke retirement");
	},
});

afterEach(() => {
	mock.restore();
	setGitHardeningProbeForTests(null);
});

describe("worktree listing scope and observations", () => {
	test("timed pages advertise removal and preserve the workspace scope passed to the port", async () => {
		const { ports, calls, service } = fixture();
		ports.retirement = retirement;
		let now = 0;
		spyOn(performance, "now").mockImplementation(() => now);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const run = ports.runGit;
		ports.runGit = async (...args) => {
			now += 1500;
			return run?.(...args) ?? result();
		};
		const first = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", limit: 1 },
			signal(),
		);
		expect(first.capabilities.delete).toBe(true);
		expect(first.entries).toHaveLength(1);
		expect(first.hasMore).toBe(true);
		expect(calls[0]?.[4]).toEqual({ kind: "workspace" });
		expect(warning.mock.calls[0]?.[1]).toMatchObject({
			inputBytes: Buffer.byteLength(inventory),
			entryCount: 2,
			pageEntryCount: 1,
			stopReason: "complete",
			stages: { inventoryGitElapsedMs: 1500 },
		});
		const callCount = calls.length;
		const second = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", limit: 1, cursor: first.nextCursor },
			signal(),
		);
		expect(second.capabilities.delete).toBe(true);
		expect(second.entries).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(calls).toHaveLength(callCount);
	});

	test("legacy inventory retry keeps scope separate from the shared observation", async () => {
		const { ports, service } = fixture();
		const scopes: unknown[] = [];
		ports.runGit = async (_target, args, _signal, _writing, scope) => {
			scopes.push(scope);
			return args.includes("-z")
				? { stdout: "", stderr: "error: unknown switch `z'\n", exitCode: 129 }
				: result("");
		};
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(page.entries).toEqual([]);
		expect(page.capabilities.delete).toBe(false);
		expect(scopes).toEqual([{ kind: "workspace" }, { kind: "workspace" }]);
	});

	test("a missing local checkout cannot advertise removal even with an adapter", async () => {
		const { target, ports, service } = fixture();
		ports.retirement = retirement;
		target.workspace.state = "missing_directory";
		target.worktreeListOnly = true;
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(page.capabilities.delete).toBe(false);
		expect(page.entries).toHaveLength(2);
	});

	test("production argv retains hardening, capture bounds and recovery repository addressing", async () => {
		setGitHardeningProbeForTests(async () => true);
		const spawn = spyOn(spawnModule, "safeSpawn").mockImplementation(async (options) =>
			result(options.cmd.includes("show") ? `${head} 2\n` : inventory),
		);
		for (const recovery of [false, true]) {
			const { target, ports, service } = fixture();
			delete ports.runGit;
			if (recovery) {
				target.workspace.state = "missing_directory";
				target.worktreeListOnly = true;
			}
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
			const listing = spawn.mock.calls.findLast(([options]) => options.cmd.includes("list"))?.[0];
			expect(listing).toMatchObject({
				timeout: WORKTREE_READ_TIMEOUT_MS,
				maxOutputBytes: WORKTREE_LIST_MAX_OUTPUT_BYTES,
				includeTerminationReason: true,
				killProcessTree: true,
				env: {
					LC_ALL: "C",
					GIT_DIR: undefined,
					GIT_COMMON_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_INDEX_FILE: undefined,
					GIT_EXTERNAL_DIFF: undefined,
					GIT_OPTIONAL_LOCKS: "0",
				},
			});
			expect(listing?.cmd).toEqual([
				"git",
				"--no-optional-locks",
				...(recovery ? ["--git-dir=/fixture/repo/.git"] : ["-C", "/fixture/repo"]),
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]);
			const env = listing?.env ?? {};
			const config = Object.fromEntries(
				Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
					env[`GIT_CONFIG_KEY_${index}`],
					env[`GIT_CONFIG_VALUE_${index}`],
				]),
			);
			expect(config).toMatchObject({ "core.fsmonitor": "false", "diff.external": "" });
			expect(config["core.hooksPath"]).toBeDefined();
		}
	});

	test("hardened inventory termination stays an error with its measured budget reason", async () => {
		setGitHardeningProbeForTests(async () => true);
		let now = 0;
		spyOn(performance, "now").mockImplementation(() => now);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		const spawn = spyOn(spawnModule, "safeSpawn");
		for (const terminationReason of ["timeout", "output-limit"] as const) {
			const { ports, service } = fixture();
			delete ports.runGit;
			spawn.mockImplementation(async () => {
				now += 1500;
				return { stdout: "", stderr: "stopped", exitCode: 143, terminationReason };
			});
			await expect(
				service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
			).rejects.toMatchObject({ code: "WORKTREE_LIST_FAILED" });
			expect(warning.mock.calls.at(-1)?.[1]).toMatchObject({
				inventoryTerminationReason: terminationReason,
				stopReason: "budget",
				stages: { inventoryGitElapsedMs: 1500 },
			});
		}
	});
});
