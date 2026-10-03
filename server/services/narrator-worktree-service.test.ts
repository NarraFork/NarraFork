import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { createWorktreeTool } from "../lib/agent/tools/worktree";
import type { ToolContext } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import type { WorktreeCreateRequest } from "../lib/validators/narrator-worktrees";
import { createNarratorWorktreeRoutes } from "../routes/narrator-worktrees";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import {
	boundWorktreeGitResult,
	NarratorWorktreeService,
	parseWorktreePorcelain,
	WORKTREE_MAX_ENTRIES,
	WORKTREE_MAX_OUTPUT_BYTES,
	type WorktreeServicePorts,
	type WorktreeTarget,
	worktreeDirectoryName,
} from "./narrator-worktree-service";

let temporary: string;
let source: string;
let target: WorktreeTarget;
let ports: WorktreeServicePorts<string>;
let service: NarratorWorktreeService<string>;
let revision: number;
let lock: boolean;
let writes: number;
let authorizations: string[];
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
function proposal(
	id = "request-one",
	branch = "feature",
	kind: "new" | "existing" = "new",
): WorktreeCreateRequest {
	return {
		expectedRevision: 4,
		workspaceKey: "workspace",
		requestId: id,
		destinationPath: join(source, ".worktrees", id),
		branch: { kind, name: branch },
	};
}

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "narrafork-worktree-test-"));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-b", "main"]);
	await writeFile(join(source, "tracked.txt"), "committed\n");
	await git(["add", "tracked.txt"]);
	await git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.test",
		"commit",
		"-m",
		"initial",
	]);
	await mkdir(join(source, ".worktrees"));
	await writeFile(join(source, ".gitignore"), ".worktrees/\n");
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
	revision = 4;
	lock = false;
	writes = 0;
	authorizations = [];
	ports = {
		authorize: async (_principal, _id, need) => {
			authorizations.push(need);
			return target;
		},
		withRevision: async (_id, expected, action) => {
			if (expected !== revision)
				throw new AppError("Old revision", 409, "WORKSPACE_CONTEXT_CONFLICT");
			return action();
		},
		withRepositoryLock: async (_key, action) => {
			if (lock) throw new AppError("Busy repository", 409, "GIT_WORKSPACE_BUSY");
			lock = true;
			try {
				return await action();
			} finally {
				lock = false;
			}
		},
		journal: new FileWorktreeJournal(join(temporary, "receipts")),
		runGit: async (workspace, args, abort, writing) => {
			if (writing) writes++;
			return safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", workspace.workspace.rootPath ?? "", ...args],
				timeout: writing ? 10_000 : 5000,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
				signal: abort,
			});
		},
	};
	service = new NarratorWorktreeService(ports);
});

afterEach(async () => {
	await rm(temporary, { recursive: true, force: true });
});

describe("local worktree list/create fixtures", () => {
	test("lists without write authorization and explicitly disables unsupported capabilities", async () => {
		target.workspace.capabilities.write = false;
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(result.repositoryKey).toBe("repository");
		expect(result.entries[0]?.branch).toBe("refs/heads/main");
		expect(result.capabilities).toMatchObject({
			list: true,
			create: false,
			delete: false,
			prune: false,
			remote: false,
			switch: false,
		});
		expect(authorizations).toEqual(["read"]);
	});

	test("list batches unique HEAD timestamps, including detached worktrees, in one bounded read", async () => {
		const detached = join(source, ".worktrees", "detached");
		await git(["worktree", "add", "--detach", detached, "HEAD"]);
		await git([
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"--allow-empty",
			"-C",
			"HEAD",
		]);
		const run = ports.runGit;
		const calls: string[][] = [];
		ports.runGit = async (workspace, args, abort, writing) => {
			calls.push(args);
			expect(writing).toBe(false);
			return run?.(workspace, args, abort, writing) as ReturnType<NonNullable<typeof run>>;
		};
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		const shows = calls.filter((args) => args[0] === "show");
		expect(shows).toHaveLength(1);
		expect(shows[0]).toEqual([
			"show",
			"--no-walk",
			"--no-patch",
			"--format=%H %ct",
			...new Set(result.entries.map((entry) => entry.head ?? "")),
			"--",
		]);
		expect(result.entries.find((entry) => entry.path === detached)?.detached).toBe(true);
		for (const entry of result.entries) {
			expect(entry.lastCommitAt).toBe(
				Number(await git(["show", "-s", "--format=%ct", entry.head ?? ""])) * 1000,
			);
			const birthtime = (await lstat(entry.path)).birthtimeMs;
			expect(entry.createdAt).toBe(birthtime > 0 ? birthtime : null);
		}
	});

	test("list preserves missing HEAD/path metadata and deduplicates shared HEADs", async () => {
		const head = "a".repeat(40);
		const missing = "b".repeat(40);
		const paths = [source, join(source, "missing"), join(source, "zero-birthtime")];
		const calls: string[][] = [];
		ports.runGit = async (_workspace, args) => {
			calls.push(args);
			return {
				exitCode: 0,
				stderr: "",
				stdout:
					args[0] === "show"
						? `${head} 1700000000\n`
						: paths
								.map(
									(path, index) =>
										`worktree ${path}\0HEAD ${index === 1 ? missing : head}\0detached\0\0`,
								)
								.join(""),
			};
		};
		ports.statDirectory = async (path) => {
			if (path === paths[1]) throw new Error("ENOENT");
			return { birthtimeMs: path === source ? 1234 : 0, isDirectory: () => true };
		};
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(calls[1]?.slice(4, -1)).toEqual([head, missing]);
		expect(result.entries.map((entry) => [entry.createdAt, entry.lastCommitAt])).toEqual([
			[1234, 1700000000000],
			[null, null],
			[null, 1700000000000],
		]);
	});

	test("empty/unborn HEADs skip the metadata Git command and never use non-directory birthtime", async () => {
		let calls = 0;
		ports.runGit = async () => {
			calls++;
			return {
				exitCode: 0,
				stderr: "",
				stdout: `worktree ${source}\0HEAD ${"0".repeat(40)}\0\0worktree missing\0\0`,
			};
		};
		ports.statDirectory = async () => ({ birthtimeMs: 1234, isDirectory: () => false });
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(calls).toBe(1);
		expect(
			result.entries.every((entry) => entry.createdAt === null && entry.lastCommitAt === null),
		).toBe(true);
	});

	test("Git metadata failures, throws and truncated output keep the worktree inventory usable", async () => {
		const run = ports.runGit;
		for (const failure of ["exit", "throw", "truncate", "invalid"] as const) {
			ports.runGit = async (workspace, args, abort, writing) => {
				if (args[0] !== "show")
					return run?.(workspace, args, abort, writing) as ReturnType<NonNullable<typeof run>>;
				if (failure === "throw") throw new Error("metadata unavailable");
				return {
					exitCode: failure === "exit" ? 128 : 0,
					stderr: "",
					stdout: `${args[4]} ${failure === "invalid" ? "9007199254740991" : "1700000000"}\n`,
					stdoutTruncated: failure === "truncate",
				};
			};
			const result = await service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace" },
				signal(),
			);
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.lastCommitAt).toBeNull();
			expect(result.capabilities.list).toBe(true);
		}
	});

	test("directory metadata concurrency is bounded and caller cancellation is not swallowed", async () => {
		const controller = new AbortController();
		let reads = 0;
		ports.runGit = async () => ({
			exitCode: 0,
			stderr: "",
			stdout: Array.from({ length: 12 }, (_, index) => `worktree path-${index}\0\0`).join(""),
		});
		ports.statDirectory = async () => {
			reads++;
			if (reads === 4) controller.abort(new Error("cancel metadata"));
			return new Promise(() => {});
		};
		await expect(
			service.list("actor", "narrator", { workspaceKey: "workspace" }, controller.signal),
		).rejects.toThrow("cancel metadata");
		expect(reads).toBe(4);
	});

	test("creates a new branch from a pinned base in one argv call; leaves dirty source intact", async () => {
		await writeFile(join(source, "tracked.txt"), "dirty source\n");
		await writeFile(join(source, "untracked.txt"), "untracked\n");
		const request = { ...proposal(), baseRef: "main" };
		const headBefore = await git(["rev-parse", "HEAD"]);
		const result = await service.create("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		expect(result.worktree?.branch).toBe("refs/heads/feature");
		expect(result.worktree?.head).toBe(headBefore);
		expect(result.worktree).not.toHaveProperty("createdAt");
		expect(result.worktree).not.toHaveProperty("lastCommitAt");
		expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("dirty source\n");
		expect(await readFile(join(request.destinationPath, "tracked.txt"), "utf8")).toBe(
			"committed\n",
		);
		expect(await Bun.file(join(request.destinationPath, "untracked.txt")).exists()).toBe(false);
		expect(await git(["branch", "--show-current"])).toBe("main");
		expect(writes).toBe(1);
		expect(authorizations).toEqual(["write", "write"]);
	});

	test("creates an existing branch without changing its tip", async () => {
		await git(["branch", "existing"]);
		const request = proposal("existing-id", "existing", "existing");
		const result = await service.create("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		expect(result.worktree?.head).toBe(await git(["rev-parse", "refs/heads/existing"]));
	});

	test("persistent same-ID replay survives service/journal recreation; a different proposal conflicts", async () => {
		const request = proposal();
		const first = await service.create("actor", "narrator", request, signal());
		service = new NarratorWorktreeService({
			...ports,
			journal: new FileWorktreeJournal(join(temporary, "receipts")),
		});
		expect(await service.create("actor", "narrator", request, signal())).toEqual(first);
		expect(writes).toBe(1);
		await expect(
			service.create(
				"actor",
				"narrator",
				{ ...request, branch: { kind: "new", name: "other" } },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		expect(writes).toBe(1);
	});

	test("rejects branches already checked out, invalid/missing branch and invalid base without writes", async () => {
		const requests = [
			proposal("checked", "main", "existing"),
			proposal("badbranch", "bad..branch"),
			proposal("option", "--orphan"),
			proposal("missing", "absent", "existing"),
			{ ...proposal("badbase"), baseRef: "--help" },
			{ ...proposal("missingbase"), baseRef: "nonexistent" },
		];
		for (const request of requests)
			expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("failed");
		expect(writes).toBe(0);
	});

	test("rejects relative/outside/traversal/missing-parent/existing destinations", async () => {
		const exists = join(source, ".worktrees", "already");
		await mkdir(exists);
		const paths = [
			"relative",
			join(temporary, "sibling"),
			`${source}/.worktrees/../escape`,
			join(source, "missing", "child"),
			exists,
		];
		for (const [index, destinationPath] of paths.entries()) {
			const result = await service.create(
				"actor",
				"narrator",
				{ ...proposal(`path-${index}`), destinationPath },
				signal(),
			);
			expect(result.outcome).toBe("failed");
		}
		expect(writes).toBe(0);
	});

	test("rejects symlink parents and dangling/existing symlink destinations", async () => {
		const outside = join(temporary, "outside");
		await mkdir(outside);
		await symlink(outside, join(source, "alias"));
		await symlink(join(outside, "missing"), join(source, ".worktrees", "dangling"));
		const destinations = [join(source, "alias", "child"), join(source, ".worktrees", "dangling")];
		for (const [index, destinationPath] of destinations.entries()) {
			expect(
				(
					await service.create(
						"actor",
						"narrator",
						{ ...proposal(`symlink-${index}`), destinationPath },
						signal(),
					)
				).outcome,
			).toBe("failed");
		}
		expect(writes).toBe(0);
	});

	test("stale revision/workspace and repository lock contention fail before mutation", async () => {
		revision = 5;
		await expect(service.create("actor", "narrator", proposal(), signal())).rejects.toMatchObject({
			code: "WORKSPACE_CONTEXT_CONFLICT",
		});
		revision = 4;
		await expect(
			service.create("actor", "narrator", { ...proposal(), workspaceKey: "old" }, signal()),
		).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
		lock = true;
		await expect(service.create("actor", "narrator", proposal(), signal())).rejects.toMatchObject({
			code: "GIT_WORKSPACE_BUSY",
		});
		expect(writes).toBe(0);
	});

	test("revalidates Git workspace immediately before dispatch", async () => {
		ports.authorize = async (_actor, _id, need) => {
			authorizations.push(need);
			return authorizations.length > 1
				? { ...target, workspace: { ...target.workspace, workspaceKey: "rebound" } }
				: target;
		};
		const result = await service.create("actor", "narrator", proposal(), signal());
		expect(result).toMatchObject({ outcome: "failed", error: { code: "GIT_WORKSPACE_CHANGED" } });
		expect(writes).toBe(0);
	});

	test("Git failure is verified and residual branches are retained, never force cleaned", async () => {
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (writing) {
				writes++;
				await git(["branch", "feature"]);
				return { exitCode: 1, stdout: "", stderr: "fixture creation failure" };
			}
			if (!run) throw new Error("Missing fixture runner");
			return run(workspace, args, abort, writing);
		};
		const result = await service.create("actor", "narrator", proposal(), signal());
		expect(result).toMatchObject({
			outcome: "failed",
			residuals: { destinationExists: false, branchExists: true },
		});
		expect(await git(["rev-parse", "refs/heads/feature"])).toBe(await git(["rev-parse", "HEAD"]));
		expect(writes).toBe(1);
	});

	test("lost response after successful add is reconciled as created despite cancellation", async () => {
		const controller = new AbortController();
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			if (writing) {
				controller.abort();
				throw new Error("Disconnected after execution");
			}
			return result;
		};
		expect((await service.create("actor", "narrator", proposal(), controller.signal)).outcome).toBe(
			"created",
		);
		expect(writes).toBe(1);
	});

	test("unknown with incomplete evidence is durable; retry only verifies and never re-adds", async () => {
		const run = ports.runGit;
		let dispatched = false;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (writing) {
				writes++;
				dispatched = true;
				throw new Error("Timeout/lost response");
			}
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			if (dispatched && args[0] === "worktree" && args[1] === "list")
				return { ...result, stdoutTruncated: true };
			return result;
		};
		const request = proposal();
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("unknown");
		service = new NarratorWorktreeService({
			...ports,
			journal: new FileWorktreeJournal(join(temporary, "receipts")),
		});
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("unknown");
		expect(writes).toBe(1);
	});

	test("bounded porcelain ignores incomplete records and caps entries; byte-truncated list forbids create", async () => {
		const output = Array.from(
			{ length: WORKTREE_MAX_ENTRIES + 20 },
			(_, i) => `worktree /repo/${i}\0HEAD ${"a".repeat(40)}\0branch refs/heads/a${i}\0\0`,
		).join("");
		const parsed = parseWorktreePorcelain(output);
		expect(parsed.entries).toHaveLength(WORKTREE_MAX_ENTRIES);
		expect(parsed.truncated).toBe(true);
		expect(parseWorktreePorcelain("worktree /partial\0HEAD aaa", true)).toEqual({
			entries: [],
			truncated: true,
		});
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			return args[0] === "worktree" && args[1] === "list"
				? { ...result, stdoutTruncated: true }
				: result;
		};
		expect(
			(await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal())).truncated,
		).toBe(true);
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("authorized remote backend is explicitly unsupported rather than silently running local", async () => {
		target.backend = { ...new LocalBackend(), kind: "remote" } as typeof target.backend;
		target.workspace.deviceId = "remote";
		await expect(
			service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_UNSUPPORTED" });
		expect(writes).toBe(0);
	});

	test("permission rejection precedes revision filesystem resolution and does not enter Git", async () => {
		let revisionReads = 0;
		ports.withRevision = async (_id, _revision, action) => {
			revisionReads++;
			return action();
		};
		ports.authorize = async () => {
			throw new AppError("Denied", 403, "GIT_WORKSPACE_ACCESS_DENIED");
		};
		await expect(service.create("actor", "narrator", proposal(), signal())).rejects.toMatchObject({
			code: "GIT_WORKSPACE_ACCESS_DENIED",
		});
		expect(revisionReads).toBe(0);
		expect(writes).toBe(0);
	});

	test("argv preserves literal shell metacharacters in destination and never executes them", async () => {
		const request = {
			...proposal(),
			destinationPath: join(source, ".worktrees", "literal;$(touch injected)"),
		};
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		expect(await Bun.file(join(source, "injected")).exists()).toBe(false);
	});

	test("real process output is bounded in bytes before returning", async () => {
		const result = boundWorktreeGitResult(
			await safeSpawn({
				cmd: [
					process.execPath,
					"-e",
					"process.stdout.write('x'.repeat(524288)); process.stderr.write('y'.repeat(524288))",
				],
				timeout: 5000,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
			}),
		);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stderrTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(WORKTREE_MAX_OUTPUT_BYTES);
		expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(WORKTREE_MAX_OUTPUT_BYTES);
	});

	test("production local argv executor ignores inherited Git directory overrides", async () => {
		delete ports.runGit;
		const previous = process.env.GIT_DIR;
		process.env.GIT_DIR = join(temporary, "foreign-git-dir");
		try {
			const result = await service.create("actor", "narrator", proposal(), signal());
			expect(result.outcome).toBe("created");
			expect(
				(await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal())).entries,
			).toHaveLength(2);
		} finally {
			if (previous === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = previous;
		}
	});

	test("lost final receipt write leaves a recoverable pending receipt, never re-adds", async () => {
		const save = ports.journal.save.bind(ports.journal);
		let saves = 0;
		ports.journal.save = async (...args) => {
			saves++;
			if (saves === 2) throw new Error("Receipt storage failed after Git succeeded");
			return save(...args);
		};
		const request = proposal();
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		service = new NarratorWorktreeService({
			...ports,
			journal: new FileWorktreeJournal(join(temporary, "receipts")),
		});
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		expect(writes).toBe(1);
	});

	test("unreadable or unavailable durable receipt is unknown and forbids new dispatch", async () => {
		ports.journal.claim = async () => {
			throw new Error("Receipt cannot be read safely");
		};
		const result = await service.create("actor", "narrator", proposal(), signal());
		expect(result).toMatchObject({
			outcome: "unknown",
			error: { code: "WORKTREE_RECEIPT_UNAVAILABLE" },
		});
		expect(writes).toBe(0);
	});

	test("registered HEAD alone cannot prove a checkout interrupted midway", async () => {
		const request = proposal();
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			if (writing) {
				await rm(join(request.destinationPath, "tracked.txt"));
				throw new Error("Lost response with incomplete checkout");
			}
			return result;
		};
		const result = await service.create("actor", "narrator", request, signal());
		expect(result).toMatchObject({
			outcome: "unknown",
			residuals: { destinationExists: true, branchExists: true },
		});
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("unknown");
		expect(writes).toBe(1);
	});

	test("real Git timeout is verified instead of blindly retried", async () => {
		await writeFile(join(source, ".git", "hooks", "post-checkout"), "#!/bin/sh\nsleep 2\n", {
			mode: 0o755,
		});
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!writing) {
				if (!run) throw new Error("Missing fixture runner");
				return run(workspace, args, abort, writing);
			}
			writes++;
			return safeSpawn({
				cmd: ["git", "-C", workspace.workspace.rootPath ?? "", ...args],
				timeout: 100,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
				killProcessTree: true,
				signal: abort,
			});
		};
		const request = proposal();
		const result = await service.create("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		expect(writes).toBe(1);
	});

	test("Worktree tool returns unknown as an explicit error outcome, not created", async () => {
		const run = ports.runGit;
		let dispatched = false;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (writing) {
				writes++;
				dispatched = true;
				throw new Error("Response lost");
			}
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			return dispatched && args[0] === "worktree" && args[1] === "list"
				? { ...result, stdoutTruncated: true }
				: result;
		};
		const tool = createWorktreeTool(service, async () => "actor");
		const result = await tool.execute({ action: "create", ...proposal() }, {
			narratorId: "narrator",
			signal: signal(),
		} as ToolContext);
		expect(JSON.parse(result.output).outcome).toBe("unknown");
		expect(result.isError).toBe(true);
		expect(writes).toBe(1);
	});

	test("new branch name is optional and generated once, then frozen across persistent replay", async () => {
		let naming = 0;
		ports.generateBranchName = async () => {
			naming++;
			return "fixture-task";
		};
		const request = { ...proposal(), branch: { kind: "new" as const } };
		const result = await service.create("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		expect(result.worktree?.branch).toMatch(/^refs\/heads\/nf\/fixture-task-[a-f0-9]{10}$/);
		service = new NarratorWorktreeService({
			...ports,
			journal: new FileWorktreeJournal(join(temporary, "receipts")),
			generateBranchName: async () => {
				throw new Error("Must never generate a different name on replay");
			},
		});
		expect(await service.create("actor", "narrator", request, signal())).toEqual(result);
		expect(naming).toBe(1);
		expect(writes).toBe(1);
	});

	test("existing branch still requires an explicit name before authorization or mutation", async () => {
		await expect(
			service.create(
				"actor",
				"narrator",
				{ ...proposal(), branch: { kind: "existing" } },
				signal(),
			),
		).rejects.toThrow();
		expect(authorizations).toHaveLength(0);
		expect(writes).toBe(0);
	});

	test("Chinese and slash-normalized branch names get distinct stable bounded destinations without changing Git refs", async () => {
		ports.generateBranchName = async () => {
			throw new Error("Explicit branches must not call the model");
		};
		const names = ["修复登录", "修复支付", "feature/a", "feature-a"];
		const destinations = new Set<string>();
		for (const [index, name] of names.entries()) {
			const input = { expectedRevision: 4, workspaceKey: "workspace", branchName: name };
			const first = await service.prepare("actor", "narrator", input, signal());
			expect(await service.prepare("actor", "narrator", input, signal())).toEqual(first);
			expect(first.branchName).toBe(name);
			expect(first.worktreeName).toMatch(/^[a-z0-9_-]+-[a-f0-9]{12}$/);
			expect(first.worktreeName.length).toBeLessThanOrEqual(77);
			destinations.add(first.destinationPath);
			const request = {
				...proposal(`unicode-${index}`, name),
				destinationPath: first.destinationPath,
			};
			const created = await service.create("actor", "narrator", request, signal());
			expect(created.outcome).toBe("created");
			expect(created.worktree?.branch).toBe(`refs/heads/${name}`);
			service = new NarratorWorktreeService({
				...ports,
				journal: new FileWorktreeJournal(join(temporary, "receipts")),
			});
			expect(await service.create("actor", "narrator", request, signal())).toEqual(created);
		}
		expect(destinations.size).toBe(4);
		expect(writes).toBe(4);
	});

	test("registry registration is awaited before Git and a registration error dispatches no add", async () => {
		let registered = false;
		let state: string | undefined;
		ports.resources = {
			register: async () => {
				await Promise.resolve();
				registered = true;
			},
			setState: async (_resource, value) => {
				state = value;
			},
		};
		const run = ports.runGit;
		ports.runGit = async (...args) => {
			if (args[3]) expect(registered).toBe(true);
			if (!run) throw new Error("Missing fixture Git port");
			return run(...args);
		};
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"created",
		);
		expect(state).toBe("ready");
		ports.resources.register = async () => {
			throw new Error("Registry unavailable");
		};
		expect(
			(await service.create("actor", "narrator", proposal("registry-error", "other"), signal()))
				.outcome,
		).toBe("failed");
		expect(writes).toBe(1);
	});

	test("prepare prioritizes an explicit name, returns real safe defaults and never writes Git", async () => {
		ports.generateBranchName = async () => {
			throw new Error("Explicit name must bypass the model");
		};
		const prepared = await service.prepare(
			"actor",
			"narrator",
			{
				expectedRevision: 4,
				workspaceKey: "workspace",
				name: "chosen-name",
				requirement: "ignored",
			},
			signal(),
		);
		expect(prepared).toEqual({
			branchName: "chosen-name",
			worktreeName: worktreeDirectoryName("chosen-name"),
			destinationPath: join(source, ".worktrees", worktreeDirectoryName("chosen-name")),
		});
		expect(await git(["branch", "--list", "chosen-name"])).toBe("");
		expect(writes).toBe(0);
		const result = await service.create(
			"actor",
			"narrator",
			{
				...proposal(),
				destinationPath: prepared.destinationPath,
				branch: { kind: "new", name: prepared.branchName },
			},
			signal(),
		);
		expect(result.outcome).toBe("created");
	});

	test("prepare uses the model for a requirement and exposes failure for retry instead of silent fallback", async () => {
		let attempt = 0;
		ports.generateBranchName = async (_principal, _id, requirement) => {
			expect(requirement).toBe("support this task");
			attempt++;
			if (attempt === 1) throw new Error("Model unavailable");
			return "support-task";
		};
		const request = {
			expectedRevision: 4,
			workspaceKey: "workspace",
			requirement: "support this task",
		};
		await expect(service.prepare("actor", "narrator", request, signal())).rejects.toMatchObject({
			code: "WORKTREE_NAME_GENERATION_FAILED",
			statusCode: 503,
		});
		const prepared = await service.prepare("actor", "narrator", request, signal());
		expect(prepared.branchName).toMatch(/^nf\/support-task-[a-f0-9]{10}$/);
		expect(prepared.destinationPath.startsWith(join(source, ".worktrees"))).toBe(true);
		expect(writes).toBe(0);
	});

	test("model naming timeout is bounded and cancelled, with no new Git creation", async () => {
		ports.nameTimeoutMs = 20;
		let aborted = false;
		ports.generateBranchName = async (_principal, _id, _requirement, abort) =>
			new Promise<string>((_resolve, reject) => {
				abort.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(abort.reason);
					},
					{ once: true },
				);
			});
		await expect(
			service.prepare(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", requirement: "task" },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_NAME_GENERATION_FAILED" });
		expect(aborted).toBe(true);
		expect(writes).toBe(0);
	});

	test("missing or invalid generated names are explicit failures, never success", async () => {
		for (const name of ["", "../../escape", "two\nlines", "x".repeat(4000)]) {
			ports.generateBranchName = async () => name;
			const result = await service.create(
				"actor",
				"narrator",
				{ ...proposal(`bad-name-${name.length}`), branch: { kind: "new" } },
				signal(),
			);
			expect(result).toMatchObject({
				outcome: "failed",
				error: { code: "WORKTREE_NAME_GENERATION_FAILED" },
			});
		}
		expect(writes).toBe(0);
	});

	test("prepare works without .worktrees by deriving an existing-parent root destination", async () => {
		await rm(join(source, ".worktrees"), { recursive: true, force: true });
		const prepared = await service.prepare(
			"actor",
			"narrator",
			{ expectedRevision: 4, workspaceKey: "workspace", name: "safe-default" },
			signal(),
		);
		expect(prepared.destinationPath).toBe(
			join(source, `nf-worktree-${worktreeDirectoryName("safe-default")}`),
		);
		expect(
			(
				await service.create(
					"actor",
					"narrator",
					{
						...proposal(),
						destinationPath: prepared.destinationPath,
						branch: { kind: "new", name: prepared.branchName },
					},
					signal(),
				)
			).outcome,
		).toBe("created");
	});

	test("prepare validates final branch/path overrides rather than conflicting unused defaults", async () => {
		await git(["branch", "fix"]);
		await mkdir(join(source, ".worktrees", "fix"));
		const custom = join(source, ".worktrees", "custom");
		ports.generateBranchName = async () => {
			throw new Error("Explicit override must bypass model naming");
		};
		const result = await service.prepare(
			"actor",
			"narrator",
			{
				expectedRevision: 4,
				workspaceKey: "workspace",
				name: "fix",
				branchName: "fix-2",
				destinationPath: custom,
			},
			signal(),
		);
		expect(result).toEqual({
			branchName: "fix-2",
			worktreeName: "custom",
			destinationPath: custom,
		});
		expect(writes).toBe(0);
		expect(
			(
				await service.create(
					"actor",
					"narrator",
					{
						...proposal(),
						branch: { kind: "new", name: result.branchName },
						destinationPath: result.destinationPath,
					},
					signal(),
				)
			).outcome,
		).toBe("created");
	});

	test("unused empty basic fields do not invalidate a final advanced branch override", async () => {
		const result = await service.prepare(
			"actor",
			"narrator",
			{
				expectedRevision: 4,
				workspaceKey: "workspace",
				name: "",
				requirement: "",
				branchName: "fix-3",
				destinationPath: join(source, "custom"),
			},
			signal(),
		);
		expect(result.branchName).toBe("fix-3");
		await expect(
			service.prepare(
				"actor",
				"narrator",
				{ expectedRevision: 4, workspaceKey: "workspace", name: "", requirement: "" },
				signal(),
			),
		).rejects.toThrow();
		expect(writes).toBe(0);
	});

	test("prepare accepts an explicit custom directory despite its unused default directory collision", async () => {
		await mkdir(join(source, ".worktrees", "fix-2"));
		const custom = join(source, "custom-tree");
		const result = await service.prepare(
			"actor",
			"narrator",
			{ expectedRevision: 4, workspaceKey: "workspace", name: "fix-2", destinationPath: custom },
			signal(),
		);
		expect(result.destinationPath).toBe(custom);
		expect(result.branchName).toBe("fix-2");
		expect(writes).toBe(0);
	});

	test("prepare never probes an unused symlink default parent when a custom target is supplied", async () => {
		await rm(join(source, ".worktrees"), { recursive: true, force: true });
		await mkdir(join(temporary, "outside"));
		await symlink(join(temporary, "outside"), join(source, ".worktrees"));
		const result = await service.prepare(
			"actor",
			"narrator",
			{
				expectedRevision: 4,
				workspaceKey: "workspace",
				branchName: "fix-2",
				destinationPath: join(source, "custom"),
			},
			signal(),
		);
		expect(result.destinationPath).toBe(join(source, "custom"));
		await expect(
			service.prepare(
				"actor",
				"narrator",
				{
					expectedRevision: 4,
					workspaceKey: "workspace",
					name: "valid",
					branchName: "bad..branch",
					destinationPath: join(source, "custom"),
				},
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_INVALID_BRANCH" });
		await expect(
			service.prepare(
				"actor",
				"narrator",
				{
					expectedRevision: 4,
					workspaceKey: "workspace",
					branchName: "valid",
					destinationPath: join(temporary, "outside", "new-tree"),
				},
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_DESTINATION_DENIED" });
		expect(writes).toBe(0);
	});

	test("unknown receipt is recovered read-only after manually switching root/key/revision", async () => {
		const request = proposal();
		const run = ports.runGit;
		let dispatched = false;
		let evidenceAvailable = false;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			if (writing) {
				dispatched = true;
				throw new Error("Lost response after actual successful add");
			}
			if (dispatched && !evidenceAvailable && args[0] === "rev-parse")
				return { ...result, exitCode: 1, stdout: "", stderr: "Evidence temporarily unavailable" };
			return result;
		};
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("unknown");
		const receiptBefore = await ports.journal.read("narrator", request.requestId);
		evidenceAvailable = true;
		revision = 9;
		target.workspace = {
			...target.workspace,
			cwd: request.destinationPath,
			rootPath: request.destinationPath,
			workspaceKey: "switched-workspace",
			capabilities: { read: true, write: false },
		};
		ports.withRevision = async () => {
			throw new Error("Read-only recovery must not require the old revision");
		};
		ports.journal.claim = async () => {
			throw new Error("Read-only recovery must not claim a request");
		};
		ports.journal.save = async () => {
			throw new Error("Read-only recovery must not rewrite the receipt");
		};
		const result = await service.reconcileRequest("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		expect(result.worktree?.path).toBe(request.destinationPath);
		expect(await ports.journal.read("narrator", request.requestId)).toEqual(receiptBefore);
		expect(authorizations.slice(-2)).toEqual(["read", "read"]);
		expect(writes).toBe(1);
	});

	test("recovery rejects another actor/repository/proposal and a different narrator scope", async () => {
		const request = proposal();
		await service.create("actor", "narrator", request, signal());
		await expect(
			service.reconcileRequest("other-actor", "narrator", request, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		await expect(
			service.reconcileRequest("actor", "narrator", { ...request, expectedRevision: 10 }, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		await expect(
			service.reconcileRequest("actor", "other-narrator", request, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_NOT_FOUND" });
		target.workspace.repositoryKey = "another-repository";
		await expect(
			service.reconcileRequest("actor", "narrator", request, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		target.workspace.deviceId = "remote";
		await expect(
			service.reconcileRequest("actor", "narrator", request, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_UNSUPPORTED" });
		expect(writes).toBe(1);
	});

	test("recovery cannot widen a narrow sibling-worktree directory grant", async () => {
		const request = proposal();
		await service.create("actor", "narrator", request, signal());
		const sibling = join(source, ".worktrees", "sibling");
		await git(["worktree", "add", "-b", "sibling", "--", sibling, "HEAD"]);
		target.workspace = {
			...target.workspace,
			cwd: sibling,
			rootPath: sibling,
			workspaceKey: "sibling-workspace",
		};
		await expect(
			service.reconcileRequest("actor", "narrator", request, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		expect(writes).toBe(1);
	});

	test("a missing receipt never creates a journal directory or starts Git creation", async () => {
		await expect(
			service.reconcileRequest("actor", "narrator", proposal(), signal()),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_NOT_FOUND" });
		await expect(lstat(join(temporary, "receipts"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(writes).toBe(0);
	});

	test("HTTP reconcile accepts the original stale creation request without a new add", async () => {
		const request = proposal();
		await service.create("actor", "narrator", request, signal());
		revision = 9;
		target.workspace = {
			...target.workspace,
			cwd: request.destinationPath,
			rootPath: request.destinationPath,
			workspaceKey: "switched",
			capabilities: { read: true, write: false },
		};
		const app = new Hono();
		app.route(
			"/api/narrators",
			createNarratorWorktreeRoutes(service, () => "actor"),
		);
		const response = await app.request("/api/narrators/narrator/git/worktrees/reconcile", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).outcome).toBe("created");
		expect(writes).toBe(1);
	});

	test("real HTTP prepare endpoint returns a proposal and reports naming failures explicitly", async () => {
		const app = new Hono();
		app.onError((cause, c) =>
			c.json({ code: cause instanceof AppError ? cause.code : "INTERNAL_ERROR" }, 503),
		);
		app.route(
			"/api/narrators",
			createNarratorWorktreeRoutes(service, () => "actor"),
		);
		const url = "/api/narrators/narrator/git/worktrees/prepare";
		const response = await app.request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ expectedRevision: 4, workspaceKey: "workspace", name: "from-http" }),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).branchName).toBe("from-http");
		ports.generateBranchName = async () => {
			throw new Error("Model unavailable");
		};
		const failed = await app.request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ expectedRevision: 4, workspaceKey: "workspace", requirement: "task" }),
		});
		expect(failed.status).toBe(503);
		expect((await failed.json()).code).toBe("WORKTREE_NAME_GENERATION_FAILED");
		expect(writes).toBe(0);
	});

	test("HTTP list/create and Worktree tool use the same concrete service and durable receipts", async () => {
		const app = new Hono();
		app.route(
			"/api/narrators",
			createNarratorWorktreeRoutes(service, () => "actor"),
		);
		const listing = await app.request(
			"/api/narrators/narrator/git/worktrees?workspaceKey=workspace",
		);
		expect(listing.status).toBe(200);
		expect((await listing.json()).entries).toHaveLength(1);
		const request = proposal();
		const response = await app.request("/api/narrators/narrator/git/worktrees", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).outcome).toBe("created");
		const tool = createWorktreeTool(service, async () => "actor");
		const ctx = { narratorId: "narrator", signal: signal() } as ToolContext;
		const result = await tool.execute({ action: "create", ...request }, ctx);
		expect(JSON.parse(result.output).outcome).toBe("created");
		expect(result.isError).toBe(false);
		expect(writes).toBe(1);
		expect(tool.executionRouting?.resolve({ action: "list" }, {} as never)).toMatchObject({
			operation: "read",
		});
	});
});
