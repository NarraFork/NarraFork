import { describe, expect, mock, test } from "bun:test";
import type { GitWorkspace } from "@shared/git-workspace";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import type {
	GitWorktreeRequest,
	GitWorktreeResult,
} from "../lib/agent/execution/git-worktree-rpc";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import type { WorktreeJournalRecord } from "./narrator-worktree-journal";
import {
	NarratorWorktreeService,
	type WorktreeServicePorts,
	type WorktreeTarget,
} from "./narrator-worktree-service";

function fixture(supported = true) {
	const rows = new Map<string, WorktreeJournalRecord>();
	const workspace: GitWorkspace = {
		narratorId: "n",
		deviceId: "remote",
		cwd: "/selected/repo/sub",
		rootPath: "/selected/repo",
		workspaceKey: "wk",
		repositoryKey: "common",
		state: "ready",
		capabilities: { read: true, write: true },
	};
	const linked = {
		path: "/selected/repo/linked",
		branch: "refs/heads/new",
		head: "a".repeat(40),
		bare: false,
		detached: false,
		locked: false,
		prunable: false,
	};
	const created = {
		outcome: "created" as const,
		worktree: linked,
		residuals: { destinationExists: true, branchExists: true },
	};
	const rpc = mock(async (input: GitWorktreeRequest): Promise<GitWorktreeResult> => {
		if (input.operation === "list") return { entries: [linked], truncated: false };
		if (input.operation === "prepare")
			return {
				prepared: {
					branchName: input.branchName ?? "new",
					worktreeName: input.worktreeName ?? "linked",
					destinationPath: "/selected/repo/linked",
				},
			};
		return { result: created };
	});
	const backend = {
		kind: "remote",
		deviceId: "remote",
		defaultCwd: "/default/decoy",
		paths: posixPathSemantics,
		runtimeGeneration: 3,
		supportsGitWorktree: supported,
		gitWorktree: rpc,
	} as unknown as ExecutionBackend;
	const target: WorktreeTarget = { workspace, backend, repositoryPath: "/selected/repo/.git" };
	const runGit = mock(async () => {
		throw new Error("Host argv must never run for remote worktree");
	});
	const authorize = mock(
		async (_actor: string, _narrator: string, _need: "read" | "write") => target,
	);
	const ports: WorktreeServicePorts<string> = {
		authorize,
		withRevision: async (_n, revision, action) => {
			expect(revision).toBe(4);
			return action();
		},
		withRepositoryLock: async (key, action) => {
			expect(key).toBe("common");
			return action();
		},
		principalKey: (actor) => actor,
		runGit,
		journal: {
			read: async (_n, id) => rows.get(id) ?? null,
			claim: async (_n, id, record) => {
				const old = rows.get(id);
				if (old && old.proposalHash !== record.proposalHash)
					throw new AppError("conflict", 409, "WORKTREE_REQUEST_CONFLICT");
				if (old) return { fresh: false, record: old };
				rows.set(id, record);
				return { fresh: true, record };
			},
			save: async (_n, id, record) => {
				rows.set(id, record);
			},
		},
	};
	return {
		service: new NarratorWorktreeService(ports),
		rpc,
		runGit,
		authorize,
		target,
		rows,
		created,
	};
}
const signal = () => new AbortController().signal;
const proposal = {
	workspaceKey: "wk",
	expectedRevision: 4,
	requestId: "request-001",
	destinationPath: "/selected/repo/linked",
	branch: { kind: "new", name: "new" },
};

describe("structured remote worktrees", () => {
	test("list/prepare/create retain selected cwd and never spawn host Git", async () => {
		const f = fixture();
		const list = await f.service.list("actor", "n", { workspaceKey: "wk" }, signal());
		expect(list.capabilities.remote).toBe(true);
		expect(list.capabilities.create).toBe(true);
		await f.service.prepare(
			"actor",
			"n",
			{ workspaceKey: "wk", expectedRevision: 4, branchName: "new" },
			signal(),
		);
		const created = await f.service.create("actor", "n", proposal, signal());
		expect(created.outcome).toBe("created");
		expect(f.rpc.mock.calls.every(([input]) => input.cwd === "/selected/repo/sub")).toBe(true);
		expect(f.target.workspace.cwd).toBe("/selected/repo/sub");
		expect(f.runGit).not.toHaveBeenCalled();
	});
	test("unsupported/offline and denied authorization never dispatch", async () => {
		const old = fixture(false);
		await expect(old.service.list("actor", "n", { workspaceKey: "wk" }, signal())).rejects.toThrow(
			"structured worktree",
		);
		expect(old.rpc).not.toHaveBeenCalled();
		const denied = fixture();
		denied.authorize.mockImplementation(async () => {
			throw new AppError("denied", 403, "DENIED");
		});
		await expect(denied.service.create("actor", "n", proposal, signal())).rejects.toThrow("denied");
		expect(denied.rpc).not.toHaveBeenCalled();
		const offline = fixture();
		offline.target.workspace.state = "device_offline";
		await expect(offline.service.create("actor", "n", proposal, signal())).rejects.toThrow(
			"unavailable",
		);
		expect(offline.rpc).not.toHaveBeenCalled();
	});
	test("lost response queries original receipt, never dispatches another create", async () => {
		const f = fixture();
		f.rpc.mockImplementation(async () => {
			throw new Error("transport disconnected");
		});
		const first = await f.service.create("actor", "n", proposal, signal());
		expect(first.outcome).toBe("unknown");
		f.rpc.mockImplementation(async () => ({ result: f.created }));
		const second = await f.service.create("actor", "n", proposal, signal());
		expect(second.outcome).toBe("created");
		expect(f.rpc.mock.calls.filter(([input]) => input.operation === "create")).toHaveLength(1);
		expect(f.rpc.mock.calls.at(-1)?.[0].operation).toBe("reconcile");
		await expect(
			f.service.create(
				"actor",
				"n",
				{ ...proposal, destinationPath: "/selected/repo/other" },
				signal(),
			),
		).rejects.toThrow("conflict");
		await expect(f.service.create("other-actor", "n", proposal, signal())).rejects.toThrow(
			"mismatch",
		);
	});
	test("sibling escape is denied before remote dispatch", async () => {
		const f = fixture();
		const result = await f.service.create(
			"actor",
			"n",
			{ ...proposal, destinationPath: "/selected/other" },
			signal(),
		);
		expect(result.outcome).toBe("failed");
		expect(result.error?.code).toBe("WORKTREE_DESTINATION_DENIED");
		expect(f.rpc).not.toHaveBeenCalled();
	});
});
