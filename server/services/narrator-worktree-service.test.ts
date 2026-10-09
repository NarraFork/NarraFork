import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { resolveToolJsonSchema } from "../lib/agent/tool-registry";
import {
	createAgentWorktreeTools,
	createWorktreeTool,
	worktreeToolSchema,
} from "../lib/agent/tools/worktree";
import type { ToolContext } from "../lib/agent/types";
import { AppError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import type { WorktreeCreateRequest } from "../lib/validators/narrator-worktrees";
import { createNarratorWorktreeRoutes } from "../routes/narrator-worktrees";
import {
	FileWorktreeJournal,
	type WorktreeJournalRecord,
	worktreeProposalHash,
} from "./narrator-worktree-journal";
import {
	boundWorktreeGitResult,
	NarratorWorktreeService,
	parseLegacyWorktreePorcelain,
	parseWorktreePorcelain,
	WORKTREE_LIST_CACHE_MAX_BYTES,
	WORKTREE_LIST_CACHE_MAX_SNAPSHOTS,
	WORKTREE_LIST_CACHE_TTL_MS,
	WORKTREE_LIST_MAX_ENTRIES,
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

const unsupportedZ = {
	stdout: "",
	stderr: "error: unknown switch `z'\nusage: git worktree list [<options>]\n",
	exitCode: 129,
};

/** Match Git 2.34's raw line-separated paths, including paths newer Git would quote. */
function emulateLegacyGit() {
	const run = ports.runGit;
	const listCalls: string[][] = [];
	ports.runGit = async (workspace, args, abort, writing) => {
		if (!run) throw new Error("Missing fixture runner");
		if (args[0] !== "worktree" || args[1] !== "list") return run(workspace, args, abort, writing);
		listCalls.push(args);
		if (args.includes("-z")) return unsupportedZ;
		const result = await run(workspace, [...args, "-z"], abort, writing);
		return { ...result, stdout: result.stdout.replaceAll("\0", "\n") };
	};
	return listCalls;
}

describe("legacy Git worktree compatibility", () => {
	test("new Git keeps the NUL-delimited command without a fallback", async () => {
		const run = ports.runGit;
		const listCalls: string[][] = [];
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] === "worktree" && args[1] === "list") listCalls.push(args);
			return run(workspace, args, abort, writing);
		};
		const listed = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(listed.truncated).toBe(false);
		expect(listCalls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
	});

	test("Git 2.34 lists raw Unicode, spaces, quotes and backslashes with no write permission", async () => {
		const path = join(source, ".worktrees", '中文 space "quote" \\literal');
		await git(["worktree", "add", "-b", "feature/中文", path]);
		target.workspace.capabilities.write = false;
		const calls = emulateLegacyGit();
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(result.truncated).toBe(false);
		expect(result.entries.find((entry) => entry.path === path)?.branch).toBe(
			"refs/heads/feature/中文",
		);
		expect(result.capabilities.create).toBe(false);
		expect(calls).toEqual([
			["worktree", "list", "--porcelain", "-z"],
			["worktree", "list", "--porcelain"],
		]);
		expect(writes).toBe(0);
	});

	test("Git 2.34 creates once and reconciles the same request without another add", async () => {
		emulateLegacyGit();
		const request = proposal();
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("created");
		expect(writes).toBe(1);
		expect(await git(["branch", "--list", "feature"])).toContain("feature");
	});

	test("Git 2.34 still rejects a branch already checked out without dispatching add", async () => {
		emulateLegacyGit();
		const request = proposal("checked-out", "main", "existing");
		expect((await service.create("actor", "narrator", request, signal())).outcome).toBe("failed");
		expect(writes).toBe(0);
	});

	test("new Git handles newline paths, while raw legacy newline paths fail closed", async () => {
		const path = join(source, ".worktrees", "line\nsecond");
		await git(["worktree", "add", "-b", "newline-path", path]);
		const modern = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(modern.truncated).toBe(false);
		expect(modern.entries.some((entry) => entry.path === path)).toBe(true);
		emulateLegacyGit();
		const legacy = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(legacy.truncated).toBe(true);
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("a real path embedding complete fake records is never trusted by the legacy fallback", async () => {
		const head = await git(["rev-parse", "HEAD"]);
		const fake = join(source, ".worktrees", "fake");
		const path = join(
			source,
			".worktrees",
			`real\nHEAD ${head}\nbranch refs/heads/injected\n\nworktree ${fake}`,
		);
		await git(["worktree", "add", "-b", "actual", path]);
		const modern = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(modern.truncated).toBe(false);
		expect(modern.entries.some((entry) => entry.path === path)).toBe(true);
		emulateLegacyGit();
		const legacy = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(legacy).toMatchObject({ entries: [], truncated: true });
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("legacy fallback preserves registrations whose prunable target no longer exists", async () => {
		const path = join(source, ".worktrees", "missing");
		await git(["worktree", "add", "-b", "missing", path]);
		await rm(path, { recursive: true, force: true });
		emulateLegacyGit();
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(result.truncated).toBe(false);
		expect(result.entries.find((entry) => entry.path === path)).toMatchObject({ prunable: true });
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"created",
		);
		expect(writes).toBe(1);
	});

	test("legacy verification reads the common registration inventory when invoked from a linked worktree", async () => {
		const path = join(source, ".worktrees", "linked-source");
		await git(["worktree", "add", "-b", "linked-source", path]);
		target.workspace.rootPath = path;
		target.workspace.cwd = path;
		emulateLegacyGit();
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(result.truncated).toBe(false);
		expect(result.entries.map((entry) => entry.path).sort()).toEqual([source, path].sort());
	});

	test("legacy verification supports linked worktrees backed by a bare common repository", async () => {
		const bare = join(temporary, "bare.git");
		const path = join(temporary, "bare-linked");
		await git(["clone", "--bare", source, bare]);
		await git(["worktree", "add", "-b", "bare-linked", path], bare);
		target.workspace.rootPath = path;
		target.workspace.cwd = path;
		target.repositoryPath = bare;
		emulateLegacyGit();
		const result = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(result.truncated).toBe(false);
		expect(result.entries.map((entry) => entry.path).sort()).toEqual([bare, path].sort());
	});

	test("missing, symlinked or oversized registration evidence returns no paths and permits no add", async () => {
		const path = join(source, ".worktrees", "registered");
		await git(["worktree", "add", "-b", "registered", path]);
		const pointer = join(source, ".git", "worktrees", "registered", "gitdir");
		const original = await readFile(pointer, "utf8");
		const external = join(temporary, "external-pointer");
		await writeFile(external, original);
		emulateLegacyGit();
		for (const mode of ["missing", "symlink", "oversized"] as const) {
			await rm(pointer, { force: true });
			if (mode === "symlink") await symlink(external, pointer);
			if (mode === "oversized") await writeFile(pointer, "x".repeat(16 * 1024 + 1));
			const result = await service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace" },
				signal(),
			);
			expect(result).toMatchObject({ entries: [], truncated: true });
			expect(
				(await service.create("actor", "narrator", proposal(`evidence-${mode}`), signal())).outcome,
			).toBe("failed");
			await rm(pointer, { force: true });
			await writeFile(pointer, original);
		}
		expect(writes).toBe(0);
		expect(await readFile(external, "utf8")).toBe(original);
	});

	test("legacy metadata enumeration is capped and cannot certify an incomplete set", async () => {
		const directory = join(source, ".git", "worktrees");
		await mkdir(directory);
		for (let i = 0; i < WORKTREE_MAX_ENTRIES; i++) {
			const entry = join(directory, `registration-${i}`);
			await mkdir(entry);
			await writeFile(
				join(entry, "gitdir"),
				`${join(source, ".worktrees", `registered-${i}`, ".git")}\n`,
			);
		}
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] !== "worktree" || args[1] !== "list") return run(workspace, args, abort, writing);
			return args.includes("-z")
				? unsupportedZ
				: {
						stdout: `worktree ${source}\nHEAD ${await git(["rev-parse", "HEAD"])}\nbranch refs/heads/main\n\n`,
						stderr: "",
						exitCode: 0,
					};
		};
		expect(
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
		).toMatchObject({ entries: [], truncated: true });
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("legacy verification bounds aggregate registration bytes, not only each individual file", async () => {
		const directory = join(source, ".git", "worktrees");
		await mkdir(directory);
		for (let i = 0; i < 9; i++) {
			const entry = join(directory, `large-${i}`);
			await mkdir(entry);
			await writeFile(join(entry, "gitdir"), `/${i}${"x".repeat(16 * 1024 - 16)}/.git\n`);
		}
		const run = ports.runGit;
		const head = await git(["rev-parse", "HEAD"]);
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] !== "worktree" || args[1] !== "list") return run(workspace, args, abort, writing);
			return args.includes("-z")
				? unsupportedZ
				: {
						stdout: `worktree ${source}\nHEAD ${head}\nbranch refs/heads/main\n\n`,
						stderr: "",
						exitCode: 0,
					};
		};
		expect(
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
		).toMatchObject({ entries: [], truncated: true });
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("a metadata/text inventory mismatch cannot authorize creation or show an unregistered path", async () => {
		emulateLegacyGit();
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			const result = await run(workspace, args, abort, writing);
			if (args[0] !== "worktree" || args[1] !== "list" || args.includes("-z")) return result;
			return { ...result, stdout: result.stdout.replace(source, join(source, "unregistered")) };
		};
		expect(
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
		).toMatchObject({ entries: [], truncated: true });
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"failed",
		);
		expect(writes).toBe(0);
	});

	test("legacy verification propagates cancellation instead of converting it to an incomplete list", async () => {
		const run = ports.runGit;
		const controller = new AbortController();
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] !== "worktree" || args[1] !== "list") return run(workspace, args, abort, writing);
			if (args.includes("-z")) return unsupportedZ;
			const result = await run(workspace, [...args, "-z"], abort, writing);
			setTimeout(() => controller.abort(new Error("Registration verification cancelled")), 0);
			return { ...result, stdout: result.stdout.replaceAll("\0", "\n") };
		};
		await expect(
			service.list("actor", "narrator", { workspaceKey: "workspace" }, controller.signal),
		).rejects.toThrow("Registration verification cancelled");
		expect(writes).toBe(0);
	});

	test("legacy parser cannot certify unverified, forged, duplicate or newline-containing registration sets", () => {
		const head = "a".repeat(40);
		const path = `/repo/real\nHEAD ${head}\nbranch refs/heads/injected\n\nworktree /repo/fake`;
		const forged = `worktree ${path}\nHEAD ${head}\nbranch refs/heads/actual\n\n`;
		expect(parseLegacyWorktreePorcelain(forged)).toEqual({ entries: [], truncated: true });
		expect(parseLegacyWorktreePorcelain(forged, false, [path])).toEqual({
			entries: [],
			truncated: true,
		});
		const valid = `worktree /repo\nHEAD ${head}\nbranch refs/heads/main\n\n`;
		for (const paths of [["/other"], ["/repo", "/repo"], ["/repo\nHEAD injected"]])
			expect(parseLegacyWorktreePorcelain(valid, false, paths)).toEqual({
				entries: [],
				truncated: true,
			});
		expect(parseLegacyWorktreePorcelain(valid, false, ["/repo"]).truncated).toBe(false);
	});

	test("ordinary Git failures and truncated unsupported diagnostics never trigger a fallback", async () => {
		for (const failure of [
			{ stdout: "", stderr: "fatal: Permission denied", exitCode: 128 },
			{ ...unsupportedZ, stderr: "error: unknown switch `x'" },
			{ ...unsupportedZ, stderrTruncated: true },
		]) {
			let calls = 0;
			ports.runGit = async () => {
				calls++;
				return failure;
			};
			await expect(
				service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()),
			).rejects.toMatchObject({ code: "WORKTREE_LIST_FAILED" });
			expect(calls).toBe(1);
		}
		expect(writes).toBe(0);
	});

	test("failed fallback reports the actual bounded error, not the unsupported option", async () => {
		let calls = 0;
		ports.runGit = async () => {
			calls++;
			return calls === 1
				? unsupportedZ
				: {
						stdout: "",
						stderr: `fatal: repository unavailable\n${"x".repeat(2000)}`,
						exitCode: 128,
					};
		};
		try {
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
			throw new Error("Expected Git failure");
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			const failure = error as AppError;
			expect(failure.code).toBe("WORKTREE_LIST_FAILED");
			expect(failure.message).toContain("fatal: repository unavailable");
			expect(failure.message).not.toContain("unknown switch");
			expect(failure.message.length).toBeLessThan(560);
			expect(failure.message).not.toContain("\n");
		}
		expect(calls).toBe(2);
	});

	test("cancellation between the unsupported option and fallback launches no second command", async () => {
		const controller = new AbortController();
		let calls = 0;
		ports.runGit = async () => {
			calls++;
			controller.abort(new Error("Cancelled"));
			return unsupportedZ;
		};
		await expect(
			service.list("actor", "narrator", { workspaceKey: "workspace" }, controller.signal),
		).rejects.toThrow("Cancelled");
		expect(calls).toBe(1);
	});

	test("a truncated or ambiguous legacy inventory never permits worktree creation", async () => {
		const legacy = emulateLegacyGit();
		const run = ports.runGit;
		for (const mode of ["stdout", "stderr", "partial", "newline-path"] as const) {
			ports.runGit = async (workspace, args, abort, writing) => {
				if (!run) throw new Error("Missing fixture runner");
				const result = await run(workspace, args, abort, writing);
				if (args[0] !== "worktree" || args[1] !== "list" || args.includes("-z")) return result;
				if (mode === "stdout") return { ...result, stdoutTruncated: true };
				if (mode === "stderr") return { ...result, stderrTruncated: true };
				if (mode === "partial") return { ...result, stdout: result.stdout.slice(0, -1) };
				return { ...result, stdout: result.stdout.replace(source, `${source}\nambiguous`) };
			};
			expect(
				(await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal()))
					.truncated,
			).toBe(true);
			expect(
				(await service.create("actor", "narrator", proposal(`bad-${mode}`), signal())).outcome,
			).toBe("failed");
		}
		expect(legacy.length).toBeGreaterThan(0);
		expect(writes).toBe(0);
	});

	test("legacy parsing preserves raw paths and recognizes bare, detached, locked and prunable", () => {
		const head = "a".repeat(40);
		const path = '/repo/中文 space "quote" \\123\ttab ';
		const result = parseLegacyWorktreePorcelain(
			`worktree ${path}\nHEAD ${head}\ndetached\nlocked "reason\\nquoted"\nprunable gitdir file points to non-existent location\n\nworktree /bare\nbare\n\n`,
			false,
			[path, "/bare"],
		);
		expect(result.truncated).toBe(false);
		expect(result.entries[0]).toMatchObject({
			path,
			head,
			detached: true,
			locked: true,
			prunable: true,
		});
		expect(result.entries[1]).toMatchObject({ path: "/bare", head: null });
	});

	test("legacy parsing rejects incomplete records, duplicate fields, NULs and ambiguous newlines", () => {
		const head = "a".repeat(40);
		for (const output of [
			`worktree /partial\nHEAD ${head}\n`,
			"worktree /partial\n\n",
			`worktree /bad\nHEAD ${head}\nHEAD ${head}\n\n`,
			`worktree /bad\nHEAD ${head}\nbranch refs/heads/a\ndetached\n\n`,
			`worktree /bad\nHEAD invalid\n\n`,
			`worktree /bad\0path\nHEAD ${head}\n\n`,
			`worktree /bad\npath\nHEAD ${head}\n\n`,
			`worktree /bad\nlocked injected\nHEAD ${head}\n\n`,
			`worktree /bad\nprunable injected\nHEAD ${head}\n\n`,
		]) {
			expect(parseLegacyWorktreePorcelain(output)).toEqual({ entries: [], truncated: true });
		}
		const output = Array.from(
			{ length: WORKTREE_MAX_ENTRIES + 1 },
			(_, i) => `worktree /repo/${i}\nHEAD ${head}\nbranch refs/heads/a${i}\n\n`,
		).join("");
		expect(parseLegacyWorktreePorcelain(output)).toEqual({ entries: [], truncated: true });
	});
});

describe("bounded worktree snapshot pagination", () => {
	function inventory(count: number, padding = "") {
		const calls: string[][] = [];
		const rows = Array.from({ length: count }, (_, index) => {
			const name = `branch-${String(index).padStart(4, "0")}`;
			return {
				name,
				path: `${source}/${padding}${name}`,
				head: (index + 1).toString(16).padStart(40, "0"),
				time: 1700000000 + index,
			};
		});
		ports.runGit = async (_target, args) => {
			calls.push(args);
			const stdout =
				args[0] === "show"
					? args
							.slice(4, -1)
							.map((head) => {
								const row = rows.find((row) => row.head === head);
								return row ? `${head} ${row.time}\n` : "";
							})
							.join("")
					: rows
							.map(
								(row) =>
									`worktree ${row.path}\0HEAD ${row.head}\0branch refs/heads/${row.name}\0\0`,
							)
							.join("");
			return { exitCode: 0, stderr: "", stdout };
		};
		ports.statDirectory = async (path) => ({
			birthtimeMs: (rows.findIndex((row) => row.path === path) + 1) * 1000,
			isDirectory: () => true,
		});
		return { rows, calls };
	}

	test("default 20 newest entries and every subsequent page cover more than 128 without re-enumeration", async () => {
		const { rows, calls } = inventory(257);
		let page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(page.entries).toHaveLength(20);
		expect(page.entries[0]?.branch).toBe("refs/heads/branch-0256");
		expect(page.truncated).toBe(false);
		const all = [...page.entries];
		const firstCalls = calls.length;
		while (page.nextCursor) {
			page = await service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", cursor: page.nextCursor },
				signal(),
			);
			all.push(...page.entries);
		}
		expect(all.map((row) => row.path)).toEqual(rows.toReversed().map((row) => row.path));
		expect(new Set(all.map((row) => row.path)).size).toBe(257);
		expect(page.hasMore).toBe(false);
		expect(page.nextCursor).toBeNull();
		expect(calls).toHaveLength(firstCalls);
		expect(calls.filter((args) => args[0] === "show").map((args) => args.length - 5)).toEqual([
			128, 128, 1,
		]);
		expect(authorizations).toHaveLength(13);
	});

	test("legacy listing independently verifies more than 128 registrations before paging", async () => {
		const { rows } = inventory(140);
		for (let index = 0; index < rows.length; index++) {
			const admin = join(source, ".git", "worktrees", `linked-${index}`);
			await mkdir(admin, { recursive: true });
			await writeFile(join(admin, "gitdir"), `${rows[index]?.path}/.git\n`);
		}
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] !== "worktree") return run(workspace, args, abort, writing);
			if (args.includes("-z")) return unsupportedZ;
			const result = await run(workspace, args, abort, writing);
			return {
				...result,
				stdout: `worktree ${source}\nHEAD ${rows[0]?.head}\nbranch refs/heads/main\n\n${result.stdout.replaceAll("\0", "\n")}`,
			};
		};
		let page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(page.entries).toHaveLength(20);
		expect(page.truncated).toBe(false);
		let total = page.entries.length;
		while (page.nextCursor) {
			page = await service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", cursor: page.nextCursor },
				signal(),
			);
			total += page.entries.length;
		}
		expect(total).toBe(141);
	});

	test("listing output budget exceeds mutation budget but still reports byte truncation", async () => {
		const { rows } = inventory(80, "x".repeat(3000));
		const page = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", limit: 100 },
			signal(),
		);
		expect(page.entries).toHaveLength(rows.length);
		expect(page.truncated).toBe(false);
		inventory(1400, "x".repeat(3500));
		const limited = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace" },
			signal(),
		);
		expect(limited.truncated).toBe(true);
		expect(limited.entries).toHaveLength(20);
		// Paging metadata must precede bulky rows in tool JSON, whose tail may be clipped.
		expect(Object.keys(limited).slice(0, 5)).toEqual([
			"repositoryKey",
			"hasMore",
			"nextCursor",
			"truncated",
			"entries",
		]);
		expect(JSON.stringify(limited).slice(0, 256)).toContain(limited.nextCursor ?? "missing cursor");
	});

	test("globally sorts and filters branch names and paths before paging", async () => {
		inventory(160);
		for (const sort of ["lastCommitAt", "createdAt", "name"] as const) {
			for (const order of ["asc", "desc"] as const) {
				const page = await service.list(
					"actor",
					"narrator",
					{ workspaceKey: "workspace", sort, order, search: "BRANCH-01", limit: 7 },
					signal(),
				);
				expect(page.entries).toHaveLength(7);
				expect(page.entries[0]?.branch).toBe(
					order === "asc" ? "refs/heads/branch-0100" : "refs/heads/branch-0159",
				);
				expect(page.hasMore).toBe(true);
			}
		}
		const paths = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", search: source, limit: 100 },
			signal(),
		);
		expect(paths.entries).toHaveLength(100);
		const empty = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", search: "no-match" },
			signal(),
		);
		expect(empty.entries).toEqual([]);
		expect(empty.nextCursor).toBeNull();
		expect(empty.hasMore).toBe(false);
	});

	test("unknown times stay last in either direction and equal times tie by name then path", async () => {
		const head = "a".repeat(40);
		const paths = ["/repo/z", "/repo/b", "/repo/a", "/repo/unknown"];
		ports.runGit = async (_target, args) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				args[0] === "show"
					? `${head} 1700000000\n`
					: paths
							.map(
								(path, index) =>
									`worktree ${path}\0${index === 3 ? "" : `HEAD ${head}\0`}branch refs/heads/${index === 0 ? "same" : index === 1 ? "same" : index === 2 ? "first" : "unknown"}\0\0`,
							)
							.join(""),
		});
		ports.statDirectory = async (path) => ({
			birthtimeMs: path.endsWith("unknown") ? 0 : 1234,
			isDirectory: () => true,
		});
		for (const sort of ["lastCommitAt", "createdAt"] as const) {
			for (const order of ["asc", "desc"] as const) {
				const page = await service.list(
					"actor",
					"narrator",
					{ workspaceKey: "workspace", sort, order },
					signal(),
				);
				expect(page.entries.map((row) => row.path)).toEqual([
					"/repo/a",
					"/repo/b",
					"/repo/z",
					"/repo/unknown",
				]);
			}
		}
	});

	test("snapshot is immutable to returned rows and subsequent inventory changes", async () => {
		const { calls } = inventory(45);
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		if (page.entries[0]) page.entries[0].path = "mutated";
		const before = calls.length;
		ports.runGit = async () => {
			throw new Error("must not enumerate again");
		};
		const next = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", cursor: page.nextCursor },
			signal(),
		);
		expect(next.entries[0]?.branch).toBe("refs/heads/branch-0024");
		expect(calls).toHaveLength(before);
	});

	test("rejects forged cursors and actor, repository, narrator and query mismatches", async () => {
		inventory(40);
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		const request = { workspaceKey: "workspace", cursor: page.nextCursor };
		for (const query of [{ sort: "name" }, { order: "asc" }, { search: "x" }]) {
			await expect(
				service.list("actor", "narrator", { ...request, ...query }, signal()),
			).rejects.toMatchObject({ code: "WORKTREE_CURSOR_MISMATCH" });
		}
		await expect(service.list("other", "narrator", request, signal())).rejects.toMatchObject({
			code: "WORKTREE_CURSOR_MISMATCH",
		});
		await expect(service.list("actor", "other", request, signal())).rejects.toMatchObject({
			code: "WORKTREE_CURSOR_MISMATCH",
		});
		target.workspace.repositoryKey = "other";
		await expect(service.list("actor", "narrator", request, signal())).rejects.toMatchObject({
			code: "WORKTREE_CURSOR_MISMATCH",
		});
		target.workspace.repositoryKey = "repository";
		target.workspace.workspaceKey = "other";
		await expect(
			service.list("actor", "narrator", { ...request, workspaceKey: "other" }, signal()),
		).rejects.toMatchObject({ code: "WORKTREE_CURSOR_MISMATCH" });
		target.workspace.workspaceKey = "workspace";
		for (const cursor of ["bogus", page.nextCursor?.replace(":20:", ":21:")]) {
			await expect(
				service.list("actor", "narrator", { ...request, cursor }, signal()),
			).rejects.toMatchObject({ code: "WORKTREE_CURSOR_INVALID" });
		}
	});

	test("reauthorizes cached pages and refuses revoked permissions without Git reads", async () => {
		const { calls } = inventory(40);
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		const count = calls.length;
		ports.authorize = async () => {
			throw new AppError("Denied", 403, "DENIED");
		};
		await expect(
			service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", cursor: page.nextCursor },
				signal(),
			),
		).rejects.toMatchObject({ code: "DENIED" });
		expect(calls).toHaveLength(count);
	});

	test("expires snapshots with explicit code and bounds cache capacity", async () => {
		const { calls } = inventory(40);
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		const before = calls.length;
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now + WORKTREE_LIST_CACHE_TTL_MS + 1);
		try {
			await expect(
				service.list(
					"actor",
					"narrator",
					{ workspaceKey: "workspace", cursor: page.nextCursor },
					signal(),
				),
			).rejects.toMatchObject({ code: "WORKTREE_CURSOR_EXPIRED" });
			expect(calls).toHaveLength(before);
		} finally {
			clock.mockRestore();
		}
		const first = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		for (let index = 0; index < WORKTREE_LIST_CACHE_MAX_SNAPSHOTS; index++)
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		await expect(
			service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", cursor: first.nextCursor },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_CURSOR_EXPIRED" });
	});

	test("bounds total retained bytes independently of snapshot count", async () => {
		inventory(1000, "x".repeat(3500));
		const first = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		const pages = Math.ceil(WORKTREE_LIST_CACHE_MAX_BYTES / 3_500_000);
		for (let index = 0; index < pages; index++)
			await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		await expect(
			service.list(
				"actor",
				"narrator",
				{ workspaceKey: "workspace", cursor: first.nextCursor },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_CURSOR_EXPIRED" });
	});

	test("listing cap is explicit and mutation inventory still fails closed at 128", async () => {
		inventory(WORKTREE_LIST_MAX_ENTRIES + 1);
		const page = await service.list(
			"actor",
			"narrator",
			{ workspaceKey: "workspace", limit: 100 },
			signal(),
		);
		expect(page.entries).toHaveLength(100);
		expect(page.truncated).toBe(true);
		const parsed = parseWorktreePorcelain(
			Array.from({ length: 130 }, (_, index) => `worktree /repo/${index}\0\0`).join(""),
		);
		expect(parsed.entries).toHaveLength(128);
		expect(parsed.truncated).toBe(true);
	});

	test("metadata deadline cancels pending Git, bounds stat concurrency and launches no next batch", async () => {
		inventory(260);
		const run = ports.runGit;
		let showCalls = 0;
		let statCalls = 0;
		let gitSignal: AbortSignal | undefined;
		ports.metadataTimeoutMs = 10;
		ports.runGit = async (workspace, args, abort, writing) => {
			if (!run) throw new Error("Missing fixture runner");
			if (args[0] !== "show") return run(workspace, args, abort, writing);
			showCalls++;
			gitSignal = abort;
			return new Promise(() => {});
		};
		ports.statDirectory = async () => {
			statCalls++;
			return new Promise(() => {});
		};
		const page = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(page.entries).toHaveLength(20);
		expect(
			page.entries.every((entry) => entry.createdAt === null && entry.lastCommitAt === null),
		).toBe(true);
		expect(showCalls).toBe(1);
		expect(statCalls).toBe(4);
		expect(gitSignal?.aborted).toBe(true);
	});

	test("cancellation releases caller while a Git adapter is pending and launches no metadata", async () => {
		const controller = new AbortController();
		let calls = 0;
		ports.runGit = async () => {
			calls++;
			controller.abort(new Error("cancelled read"));
			return new Promise(() => {});
		};
		await expect(
			service.list("actor", "narrator", { workspaceKey: "workspace" }, controller.signal),
		).rejects.toThrow("cancelled read");
		expect(calls).toBe(1);
	});
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
		expect(shows[0]?.slice(0, 4)).toEqual(["show", "--no-walk", "--no-patch", "--format=%H %ct"]);
		expect(shows[0]?.slice(4, -1).sort()).toEqual(
			[...new Set(result.entries.map((entry) => entry.head ?? ""))].sort(),
		);
		expect(shows[0]?.at(-1)).toBe("--");
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
			[null, 1700000000000],
			[null, null],
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

	test("Worktree provider schema exposes top-level parameters without weakening validation", () => {
		const schema = resolveToolJsonSchema(createWorktreeTool(service, async () => "actor"));
		expect(schema.type).toBe("object");
		expect(schema.anyOf).toBeUndefined();
		expect(schema.required).toEqual(["workspaceKey", "action"]);
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		expect(properties.action.enum).toEqual(["list", "create"]);
		for (const field of ["expectedRevision", "requestId", "destinationPath", "branch"]) {
			expect(properties[field].description).toContain("Required for create");
		}
		expect(
			worktreeToolSchema.safeParse({ action: "list", workspaceKey: "workspace" }).success,
		).toBe(true);
		expect(worktreeToolSchema.safeParse({ action: "create", ...proposal() }).success).toBe(true);
		expect(worktreeToolSchema.safeParse({}).success).toBe(false);
		expect(
			worktreeToolSchema.safeParse({ action: "create", workspaceKey: "workspace" }).success,
		).toBe(false);
		expect(
			worktreeToolSchema.safeParse({
				action: "create",
				...proposal(),
				branch: { kind: "existing" },
			}).success,
		).toBe(false);
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

	test("Worktree list tool supplies structured display metadata without changing protocol output", async () => {
		const tool = createWorktreeTool(service, async () => "actor");
		const result = await tool.execute({ action: "list", workspaceKey: proposal().workspaceKey }, {
			narratorId: "narrator",
			signal: signal(),
		} as ToolContext);
		const output = JSON.parse(result.output);
		expect(result.isError).not.toBe(true);
		expect(result.metadata?.workspaceWorktrees).toEqual({
			entries: output.entries.map(
				(entry: { path: string; branch: string | null; detached: boolean }) => ({
					path: entry.path,
					branch: entry.branch,
					detached: entry.detached,
				}),
			),
			truncated: output.truncated,
		});
		expect(output.repositoryKey).toBeDefined();
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

	test("registry scope uses the fresh authorized target evidence, never the authenticated actor", async () => {
		target.resourceScope = {
			scopeKind: "standalone",
			scopeProjectId: null,
			scopeOwnerUserId: "stale-owner",
		};
		let checks = 0;
		ports.authorize = async () => {
			checks++;
			return checks < 2
				? target
				: {
						...target,
						resourceScope: {
							scopeKind: "project",
							scopeProjectId: "verified-project",
							scopeOwnerUserId: "verified-root-owner",
						},
					};
		};
		ports.resources = {
			register: async (resource) => {
				expect(resource.scope).toEqual({
					scopeKind: "project",
					scopeProjectId: "verified-project",
					scopeOwnerUserId: "verified-root-owner",
				});
				expect(resource.scope?.scopeOwnerUserId).not.toBe("actor");
			},
			setState: async () => {},
		};
		expect((await service.create("actor", "narrator", proposal(), signal())).outcome).toBe(
			"created",
		);
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

describe("read-only worktree operation lookup", () => {
	const operationId = `wt1_${"a".repeat(64)}`;
	const query = (actor = "actor", id = operationId) =>
		service.getOperation(actor, "narrator", id, signal());
	const receiptPath = () =>
		join(
			temporary,
			"receipts",
			`${createHash("sha256")
				.update(JSON.stringify(["narrator", operationId]))
				.digest("hex")}.json`,
		);
	async function seed() {
		const request = proposal(operationId);
		const record: WorktreeJournalRecord = {
			request,
			proposalHash: worktreeProposalHash(request),
			repositoryKey: "repository",
			actorKey: "actor",
			deviceId: "local",
			destination: request.destinationPath,
			expectedHead: await git(["rev-parse", "HEAD"]),
			branchName: "feature",
		};
		await ports.journal.claim("narrator", operationId, record);
		return record;
	}
	function forbidWrites() {
		ports.withRevision = async () => {
			throw new Error("Lookup must not admit a revision mutation");
		};
		ports.journal.claim = async () => {
			throw new Error("Lookup must not claim a receipt");
		};
		ports.journal.save = async () => {
			throw new Error("Lookup must not save a receipt");
		};
	}

	test("intent tools use stable receipts across tool-call ids and recover with an old revision", async () => {
		const tools = createAgentWorktreeTools(service, async (ctx) => ctx.userId ?? "");
		const create = tools.find((tool) => tool.name === "CreateWorktree");
		const get = tools.find((tool) => tool.name === "GetWorktreeOperation");
		if (!create || !get) throw new Error("Missing intent tool definitions");
		const context = {
			narratorId: "narrator",
			userId: "actor",
			signal: signal(),
			currentToolUseId: "first-call",
			workspaceContext: {
				revision: 4,
				deviceId: "local",
				cwd: source,
				pathFlavor: "posix",
				contextKey: "fixture-context",
				git: { workspaceKey: "workspace", repositoryKey: "repository", rootPath: source },
				capabilities: { switchDirectory: true },
			},
		} as ToolContext;
		const intent = { branchName: "feature", destinationPath: proposal().destinationPath };
		const first = JSON.parse((await create.execute(intent, context)).output);
		expect(first.outcome).toBe("created");
		expect(first.operationId).toMatch(/^wt1_[a-f0-9]{64}$/);
		const second = JSON.parse(
			(await create.execute(intent, { ...context, currentToolUseId: "second-call" })).output,
		);
		expect(second.operationId).toBe(first.operationId);
		expect(second.outcome).toBe("created");
		expect(writes).toBe(1);
		const record = await ports.journal.read("narrator", first.operationId);
		expect(record?.request.requestId).toBe(first.operationId);
		expect(record?.request.expectedRevision).toBe(4);
		if (!context.workspaceContext) throw new Error("Missing fixture workspace context");
		revision = 5;
		forbidWrites();
		const recovered = JSON.parse(
			(
				await get.execute(
					{ operationId: first.operationId },
					{
						...context,
						workspaceContext: { ...context.workspaceContext, revision: 5 },
						currentToolUseId: "recovery-call",
					},
				)
			).output,
		);
		expect(recovered.outcome).toBe("created");
		expect(recovered.operationId).toBe(first.operationId);
		expect(writes).toBe(1);
		expect(await ports.journal.read("narrator", first.operationId)).toEqual(record);
	});

	test("same-id creation replay rejects injected stored results and inconsistent proposals", async () => {
		const record = await seed();
		const corruptions = [
			{ ...record, result: { outcome: "created", arbitrary: "payload" } },
			{ ...record, request: { ...record.request, expectedRevision: 8 } },
			{ ...record, expectedHead: "--injected-head" },
			{ ...record, destination: join(source, "elsewhere") },
		];
		for (const corrupted of corruptions) {
			await writeFile(receiptPath(), JSON.stringify(corrupted));
			await expect(
				service.create("actor", "narrator", record.request, signal()),
			).rejects.toMatchObject({ code: "WORKTREE_RECEIPT_INVALID" });
		}
		expect(writes).toBe(0);
	});

	test("same-id creation replay checks the current proposal independently of journal claim", async () => {
		const record = await seed();
		ports.journal.claim = async () => ({ fresh: false, record });
		await expect(
			service.create(
				"actor",
				"narrator",
				{ ...record.request, branch: { kind: "new", name: "different" } },
				signal(),
			),
		).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		expect(writes).toBe(0);
	});

	test("a 256-character multi-component branch survives query and same-id replay", async () => {
		const branch = `${"a".repeat(120)}/${"b".repeat(135)}`;
		expect(branch.length).toBe(256);
		const request = proposal(operationId, branch);
		const created = await service.create("actor", "narrator", request, signal());
		expect(created.outcome).toBe("created");
		expect(created.worktree?.branch).toBe(`refs/heads/${branch}`);
		expect(await query()).toEqual(created);
		expect(await service.create("actor", "narrator", request, signal())).toEqual(created);
		expect(writes).toBe(1);
	});

	for (const failure of ["base-ref", "branch", "non-normalized-path", "outside-path"] as const) {
		test(`a real ${failure} validation failure stays terminal with original receipt and scope`, async () => {
			const request = proposal(operationId);
			if (failure === "base-ref") request.baseRef = "-bad";
			if (failure === "branch") request.branch.name = "-bad";
			if (failure === "non-normalized-path")
				request.destinationPath = `${source}/.worktrees/../.worktrees/failed-path`;
			if (failure === "outside-path") request.destinationPath = join(temporary, "outside-path");
			const failed = await service.create("actor", "narrator", request, signal());
			expect(failed.outcome).toBe("failed");
			const record = await ports.journal.read("narrator", operationId);
			expect(record?.expectedHead).toBe("");
			expect(record?.commandSucceeded).toBeUndefined();
			const before = await readFile(receiptPath(), "utf8");
			let probes = 0;
			ports.runGit = async () => {
				probes++;
				throw new Error("Terminal validation failures must not probe Git");
			};
			if (failure === "outside-path") {
				await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
				await expect(service.create("actor", "narrator", request, signal())).rejects.toMatchObject({
					code: "WORKTREE_RECOVERY_DENIED",
				});
			} else {
				expect(await query()).toEqual(failed);
				expect(await service.create("actor", "narrator", request, signal())).toEqual(failed);
			}
			expect(await readFile(receiptPath(), "utf8")).toBe(before);
			expect(probes).toBe(0);
			expect(writes).toBe(0);
		});
	}

	test("unsafe failed proposals cannot become reconciliation evidence through result tampering", async () => {
		const request = proposal(operationId, "-bad");
		await service.create("actor", "narrator", request, signal());
		const record = await ports.journal.read("narrator", operationId);
		if (!record?.result) throw new Error("Missing failed fixture receipt");
		const corruptions = [
			{ ...record, result: { ...record.result, outcome: "unknown" } },
			{ ...record, result: { ...record.result, outcome: "created" } },
			{ ...record, result: undefined },
			{ ...record, commandSucceeded: false },
			{ ...record, expectedHead: "a".repeat(40) },
			{
				...record,
				result: { ...record.result, residuals: { destinationExists: false, branchExists: null } },
			},
			{ ...record, result: { ...record.result, error: undefined } },
		];
		let probes = 0;
		ports.runGit = async () => {
			probes++;
			throw new Error("Invalid receipt must not probe Git");
		};
		for (const corrupted of corruptions) {
			await writeFile(receiptPath(), JSON.stringify(corrupted));
			await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECEIPT_INVALID" });
			await expect(service.create("actor", "narrator", request, signal())).rejects.toMatchObject({
				code: "WORKTREE_RECEIPT_INVALID",
			});
		}
		expect(probes).toBe(0);
		expect(writes).toBe(0);
	});

	test("queries completed operation repeatedly with frozen old revision and zero writes", async () => {
		const request = proposal(operationId);
		const result = await service.create("actor", "narrator", request, signal());
		expect(result.outcome).toBe("created");
		const before = await readFile(receiptPath(), "utf8");
		revision = 99;
		target.workspace.workspaceKey = "new-workspace";
		writes = 0;
		forbidWrites();
		authorizations = [];
		expect(await query()).toEqual(result);
		expect(await query()).toEqual(result);
		expect(authorizations.every((need) => need === "read")).toBe(true);
		expect(await readFile(receiptPath(), "utf8")).toBe(before);
		expect(writes).toBe(0);
	});

	test("pending receipt uses bounded reconciliation and never dispatches create", async () => {
		await seed();
		const before = await readFile(receiptPath(), "utf8");
		forbidWrites();
		ports.runGit = async () => {
			throw new Error("Lost repository runtime");
		};
		expect((await query()).outcome).toBe("unknown");
		expect((await query()).outcome).toBe("unknown");
		expect(await readFile(receiptPath(), "utf8")).toBe(before);
		expect(writes).toBe(0);
	});

	test("lost final result reconciles to created under an old revision without rewriting receipt", async () => {
		const request = proposal(operationId);
		await service.create("actor", "narrator", request, signal());
		const record = await ports.journal.read("narrator", operationId);
		if (!record) throw new Error("Missing fixture receipt");
		delete record.result;
		await ports.journal.save("narrator", operationId, record);
		const before = await readFile(receiptPath(), "utf8");
		revision = 100;
		target.workspace.rootPath = request.destinationPath;
		target.workspace.workspaceKey = "created-workspace";
		writes = 0;
		forbidWrites();
		const result = await query();
		expect(result.outcome).toBe("created");
		expect(result.worktree?.path).toBe(request.destinationPath);
		expect(await readFile(receiptPath(), "utf8")).toBe(before);
		expect(writes).toBe(0);
	});

	test("failed validation receipt remains queryable before resolving HEAD or branch", async () => {
		const record = await seed();
		record.expectedHead = "";
		delete record.branchName;
		record.result = {
			outcome: "failed",
			worktree: null,
			residuals: { destinationExists: null, branchExists: null },
			error: { code: "WORKTREE_VALIDATION_FAILED", message: "Validation failed" },
		};
		await ports.journal.save("narrator", operationId, record);
		forbidWrites();
		expect(await query()).toEqual(record.result);
		expect(writes).toBe(0);
	});

	test("missing and invalid operation ids do not claim or create receipt directories", async () => {
		forbidWrites();
		await expect(query()).rejects.toMatchObject({
			code: "WORKTREE_REQUEST_NOT_FOUND",
			statusCode: 404,
		});
		for (const id of [
			"request-one",
			`wt1_${"A".repeat(64)}`,
			`wt1_${"a".repeat(63)}`,
			`${operationId}\n`,
		])
			await expect(query("actor", id)).rejects.toMatchObject({
				code: "WORKTREE_INVALID_OPERATION",
			});
		await expect(lstat(join(temporary, "receipts"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(writes).toBe(0);
	});

	test("authorizes and validates actor before reading any receipt", async () => {
		let reads = 0;
		ports.journal.read = async () => {
			reads++;
			return null;
		};
		await expect(query("")).rejects.toMatchObject({ code: "WORKTREE_ACTOR_REQUIRED" });
		ports.authorize = async () => {
			throw new AppError("Denied", 403, "ACL_DENIED");
		};
		await expect(query()).rejects.toMatchObject({ code: "ACL_DENIED" });
		expect(reads).toBe(0);
	});

	test("another actor, device, repository and narrow path scope cannot recover", async () => {
		const record = await seed();
		await expect(query("other")).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		target.workspace.repositoryKey = "other";
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		target.workspace.repositoryKey = "repository";
		await ports.journal.save("narrator", operationId, { ...record, deviceId: "other-device" });
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		await ports.journal.save("narrator", operationId, record);
		target.workspace.rootPath = join(source, "sibling");
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		expect(writes).toBe(0);
	});

	test("repository lock and reauthorization still protect operation queries", async () => {
		await seed();
		lock = true;
		await expect(query()).rejects.toMatchObject({ code: "GIT_WORKSPACE_BUSY" });
		lock = false;
		const authorize = ports.authorize;
		let count = 0;
		ports.authorize = async (...args) => {
			if (++count === 3) target.workspace.repositoryKey = "changed-under-lock";
			return authorize(...args);
		};
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		expect(writes).toBe(0);
	});

	test("malformed JSON and oversized real receipts fail closed", async () => {
		await seed();
		for (const content of ["{", " ".repeat(32 * 1024 + 1)]) {
			await writeFile(receiptPath(), content);
			await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECEIPT_UNAVAILABLE" });
		}
		expect(writes).toBe(0);
	});

	test("receipt structure, proposal, identities, refs and stored result are verified", async () => {
		const record = await seed();
		const corruptions: unknown[] = [
			{},
			[],
			"invalid-record",
			{ ...record, request: { ...record.request, requestId: "other" } },
			{ ...record, request: { ...record.request, expectedRevision: -1 } },
			{ ...record, request: { ...record.request, expectedRevision: 9 } },
			{ ...record, proposalHash: "b".repeat(64) },
			{ ...record, destination: join(source, "elsewhere") },
			{ ...record, actorKey: "" },
			{ ...record, deviceId: "" },
			{ ...record, repositoryKey: "" },
			{ ...record, expectedHead: "--option" },
			{ ...record, branchName: "--option" },
			{ ...record, branchName: "other-branch" },
			{ ...record, result: { outcome: "created", arbitrary: "payload" } },
			{
				...record,
				result: {
					outcome: "created",
					worktree: null,
					residuals: { destinationExists: true, branchExists: true },
				},
			},
		];
		for (const corrupted of corruptions) {
			await writeFile(receiptPath(), JSON.stringify(corrupted));
			await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECEIPT_INVALID" });
		}
		expect(writes).toBe(0);
	});

	test("a receipt replaced between lookup and recovery is validated again", async () => {
		await seed();
		const read = ports.journal.read.bind(ports.journal);
		let reads = 0;
		ports.journal.read = async (...args) => {
			if (++reads === 2) await writeFile(receiptPath(), JSON.stringify({ request: {} }));
			return read(...args);
		};
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_RECEIPT_INVALID" });
		expect(reads).toBe(2);
		expect(writes).toBe(0);
	});

	test("a self-consistent replacement proposal cannot replace the original lookup request", async () => {
		const record = await seed();
		const read = ports.journal.read.bind(ports.journal);
		let reads = 0;
		ports.journal.read = async (...args) => {
			if (++reads === 2) {
				const request = { ...record.request, expectedRevision: 8 };
				await writeFile(
					receiptPath(),
					JSON.stringify({ ...record, request, proposalHash: worktreeProposalHash(request) }),
				);
			}
			return read(...args);
		};
		await expect(query()).rejects.toMatchObject({ code: "WORKTREE_REQUEST_CONFLICT" });
		expect(writes).toBe(0);
	});
});
