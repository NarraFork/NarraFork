/**
 * Removing a recorded worktree, on real temporary repositories with fixture ports.
 *
 * The protection port is a fixture here (the production lifecycle guard has its own
 * integration test in `worktree-retirement.integration.test.ts`); everything Git does is
 * real: the loss report, `git worktree remove`, `git branch -d` and the compare-and-delete
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { AppError, GitError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import { createNarratorWorktreeRoutes } from "../routes/narrator-worktrees";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import {
	type RecordedWorktreeResource,
	worktreeResourceId,
} from "./narrator-worktree-resource-store";
import {
	NarratorWorktreeService,
	WORKTREE_MAX_OUTPUT_BYTES,
	type WorktreeServicePorts,
	type WorktreeTarget,
} from "./narrator-worktree-service";

let temporary: string;
let source: string;
let target: WorktreeTarget;
let ports: WorktreeServicePorts<string>;
let service: NarratorWorktreeService<string>;
let rows: Map<string, RecordedWorktreeResource>;
let retirements: string[];
let confirmed: string[];
let blocked: AppError | null;
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
async function exists(path: string) {
	return lstat(path).then(
		() => true,
		() => false,
	);
}
async function commitIn(cwd: string, file: string, text: string) {
	await writeFile(join(cwd, file), text);
	await git(["add", file], cwd);
	await git(["-c", "user.name=F", "-c", "user.email=f@example.test", "commit", "-qm", file], cwd);
	return git(["rev-parse", "HEAD"], cwd);
}
/** A worktree with a record, the way CreateWorktree leaves one. */
async function recordedWorktree(name: string, state: RecordedWorktreeResource["state"] = "ready") {
	const path = join(source, ".worktrees", name);
	await git(["worktree", "add", "-q", "-b", name, path]);
	const row: RecordedWorktreeResource = {
		id: worktreeResourceId("local", path),
		ownerNarratorId: "narrator",
		deviceId: "local",
		repositoryKey: "repository",
		worktreePath: path,
		state,
		createRequestId: `request-${name}`,
	};
	rows.set(row.id, row);
	return path;
}
function removal(path: string, extra: Record<string, unknown> = {}) {
	return { workspaceKey: "workspace", path, ...extra };
}
async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (cause) {
		return cause as AppError;
	}
	throw new Error("Expected a rejection");
}

beforeEach(async () => {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-worktree-remove-")));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"]);
	await commitIn(source, "tracked.txt", "committed\n");
	await mkdir(join(source, ".worktrees"));
	await writeFile(join(source, ".git", "info", "exclude"), ".worktrees/\n");
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
	rows = new Map();
	retirements = [];
	confirmed = [];
	blocked = null;
	ports = {
		authorize: async () => target,
		withRevision: async (_id, _expected, action) => action(),
		withRepositoryLock: async (_key, action) => action(),
		journal: new FileWorktreeJournal(join(temporary, "receipts")),
		resources: {
			register: async () => ({ inserted: true }),
			setState: async () => {},
			find: async (deviceId, paths) =>
				paths.flatMap((path) => {
					const row = rows.get(worktreeResourceId(deviceId, path));
					return row ? [row] : [];
				}),
			retire: async (row) => {
				retirements.push(row.id);
				return rows.delete(row.id);
			},
		},
		withRetirement: async (resource, body) => {
			if (blocked) throw blocked;
			return body(async () => {
				confirmed.push(resource.id);
			});
		},
	};
	service = new NarratorWorktreeService(ports);
});

afterEach(async () => {
	await rm(temporary, { recursive: true, force: true });
});

describe("recorded worktree removal", () => {
	test("a clean, merged worktree is removed with its record; the branch stays unless asked", async () => {
		const path = await recordedWorktree("clean");
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report).toMatchObject({
			branch: "clean",
			uncommittedFiles: 0,
			uncommittedExact: true,
			unmergedCommits: 0,
			missing: false,
		});
		const result = await service.remove("actor", "narrator", removal(path), signal());
		expect(result).toMatchObject({ removed: true, record: "retired", branch: null });
		expect(await exists(path)).toBe(false);
		expect(confirmed).toEqual([worktreeResourceId("local", path)]);
		expect(rows.size).toBe(0);
		expect(await git(["branch", "--list", "clean"])).toContain("clean");
	});

	test("uncommitted changes refuse removal and report what would be lost", async () => {
		const path = await recordedWorktree("dirty");
		await writeFile(join(path, "tracked.txt"), "edited\n");
		await writeFile(join(path, "new.txt"), "new\n");
		const refused = await rejection(service.remove("actor", "narrator", removal(path), signal()));
		expect(refused.code).toBe("WORKTREE_REMOVAL_WOULD_LOSE_WORK");
		expect(refused.statusCode).toBe(409);
		expect((refused.details as { report: { uncommittedFiles: number } }).report).toMatchObject({
			uncommittedFiles: 2,
			unmergedCommits: 0,
		});
		expect(await exists(join(path, "new.txt"))).toBe(true);
		expect(rows.size).toBe(1);
	});

	test("commits outside the base and the upstream refuse removal", async () => {
		const path = await recordedWorktree("ahead");
		await commitIn(path, "a.txt", "1\n");
		await commitIn(path, "b.txt", "2\n");
		const refused = await rejection(service.remove("actor", "narrator", removal(path), signal()));
		expect(refused.code).toBe("WORKTREE_REMOVAL_WOULD_LOSE_WORK");
		expect(
			(refused.details as { report: { unmergedCommits: number } }).report.unmergedCommits,
		).toBe(2);
		expect(await exists(path)).toBe(true);
		// The same commits are kept once the base contains them.
		await git(["merge", "-q", "--ff-only", "ahead"]);
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report.unmergedCommits).toBe(0);
	});

	test("a confirmed discard removes exactly what the person saw, and nothing that grew since", async () => {
		const path = await recordedWorktree("discard");
		const tip = await commitIn(path, "a.txt", "1\n");
		await writeFile(join(path, "scratch.txt"), "x\n");
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report).toMatchObject({ head: tip, uncommittedFiles: 1, unmergedCommits: 1 });
		const discard = { head: report.head, uncommittedFiles: 1, unmergedCommits: 1 };
		// A file appears after the confirmation: the confirmation no longer covers it.
		await writeFile(join(path, "late.txt"), "y\n");
		const changed = await rejection(
			service.remove("actor", "narrator", removal(path, { discard }), signal()),
		);
		expect(changed.code).toBe("WORKTREE_REMOVAL_CHANGED");
		expect(await exists(join(path, "late.txt"))).toBe(true);
		const moved = await rejection(
			service.remove(
				"actor",
				"narrator",
				removal(path, { discard: { ...discard, uncommittedFiles: 2, head: "0".repeat(40) } }),
				signal(),
			),
		);
		expect(moved.code).toBe("WORKTREE_REMOVAL_CHANGED");
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { discard: { ...discard, uncommittedFiles: 2 }, deleteBranch: true }),
			signal(),
		);
		expect(result.branch).toEqual({ name: "discard", deleted: true, method: "forced" });
		expect(await exists(path)).toBe(false);
		expect(await git(["branch", "--list", "discard"])).toBe("");
	});

	test("git branch -d deletes a branch merged into HEAD", async () => {
		const path = await recordedWorktree("merged");
		await commitIn(path, "m.txt", "1\n");
		await git(["merge", "-q", "--ff-only", "merged"]);
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { deleteBranch: true }),
			signal(),
		);
		expect(result.branch).toEqual({ name: "merged", deleted: true, method: "merged" });
		expect(await git(["branch", "--list", "merged"])).toBe("");
	});

	test("when git branch -d refuses, an is-ancestor proof against the main branch deletes", async () => {
		const path = await recordedWorktree("released");
		const fork = await git(["rev-parse", "HEAD"]);
		await commitIn(path, "r.txt", "1\n");
		await git(["merge", "-q", "--ff-only", "released"]);
		// A stale upstream makes Git judge `-d` against it and refuse; main contains the tip.
		await git(["remote", "add", "origin", join(temporary, "unused-remote")]);
		await git(["update-ref", "refs/remotes/origin/released", fork]);
		await git(["branch", "--set-upstream-to=origin/released", "released"]);
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { deleteBranch: true }),
			signal(),
		);
		expect(result.report.base?.ref).toBe("refs/heads/main");
		expect(result.report.unmergedCommits).toBe(0);
		expect(result.branch).toEqual({ name: "released", deleted: true, method: "contained" });
		expect(await git(["branch", "--list", "released"])).toBe("");
		expect(await git(["config", "--get-regexp", "^branch\\.released\\."]).catch(() => "")).toBe("");
	});

	test("the caller cannot choose what counts as kept: no baseRef, and the branch never keeps itself", async () => {
		const path = await recordedWorktree("feat");
		const tip = await commitIn(path, "a.txt", "1\n");
		for (const baseRef of ["feat", tip, "refs/heads/feat", "HEAD"]) {
			for (const call of [
				service.inspectRemoval("actor", "narrator", removal(path, { baseRef }), signal()),
				service.remove(
					"actor",
					"narrator",
					removal(path, { baseRef, deleteBranch: true }),
					signal(),
				),
			])
				expect((await rejection(call)).name).toBe("ZodError");
		}
		// An upstream that is the branch itself is not evidence either.
		await git(["config", "branch.feat.remote", "."]);
		await git(["config", "branch.feat.merge", "refs/heads/feat"]);
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report).toMatchObject({ unmergedCommits: 1, upstream: null });
		expect(report.base?.ref).toBe("refs/heads/main");
		const refused = await rejection(
			service.remove("actor", "narrator", removal(path, { deleteBranch: true }), signal()),
		);
		expect(refused.code).toBe("WORKTREE_REMOVAL_WOULD_LOSE_WORK");
		expect(await git(["rev-parse", "feat"])).toBe(tip);
		expect(await exists(path)).toBe(true);
	});

	test("kept means the main checkout's branch even when the session works elsewhere", async () => {
		const other = await recordedWorktree("other");
		const path = await recordedWorktree("task");
		const tip = await commitIn(path, "t.txt", "1\n");
		// The session's checkout contains the commit; the main branch does not.
		await git(["merge", "-q", "--ff-only", "task"], other);
		target.workspace.rootPath = other;
		target.workspace.cwd = other;
		// A sibling of the session's checkout needs the same explicit grant as creation.
		ports.authorizeDestination = async () => {};
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report.base?.ref).toBe("refs/heads/main");
		expect(report.unmergedCommits).toBe(1);
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, {
				deleteBranch: true,
				discard: { head: tip, uncommittedFiles: 0, unmergedCommits: 1 },
			}),
			signal(),
		);
		expect(result.branch).toMatchObject({ name: "task", deleted: true, method: "forced" });
	});

	test("a detached main checkout keeps nothing; only the upstream can", async () => {
		const path = await recordedWorktree("detached-main");
		await git(["checkout", "-q", "--detach"]);
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report.base).toBeNull();
		expect(report.unmergedCommits).toBeGreaterThan(0);
	});

	test("a discard must equal the current report; inflated counts are refused", async () => {
		const path = await recordedWorktree("inflated");
		const tip = await commitIn(path, "a.txt", "1\n");
		await writeFile(join(path, "x.txt"), "x\n");
		for (const discard of [
			{ head: tip, uncommittedFiles: 999999, unmergedCommits: 999999 },
			{ head: tip, uncommittedFiles: 1, unmergedCommits: 2 },
			{ head: tip, uncommittedFiles: 0, unmergedCommits: 1 },
		]) {
			const refused = await rejection(
				service.remove("actor", "narrator", removal(path, { discard }), signal()),
			);
			expect(refused.code).toBe("WORKTREE_REMOVAL_CHANGED");
		}
		expect(await exists(path)).toBe(true);
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { discard: { head: tip, uncommittedFiles: 1, unmergedCommits: 1 } }),
			signal(),
		);
		expect(result.removed).toBe(true);
	});

	test("ignored files are not counted (and are deleted); skip-worktree edits are invisible", async () => {
		const path = await recordedWorktree("ignored");
		await writeFile(join(path, ".gitignore"), ".env\n");
		await git(["add", ".gitignore"], path);
		await git(["-c", "user.name=F", "-c", "user.email=f@e.t", "commit", "-qm", "ig"], path);
		await git(["merge", "-q", "--ff-only", "ignored"]);
		await writeFile(join(path, ".env"), "SECRET=1\n");
		await git(["update-index", "--skip-worktree", "tracked.txt"], path);
		await writeFile(join(path, "tracked.txt"), "hidden edit\n");
		// Documented blind spots: the report says nothing is lost, and the UI says ignored
		// files go with the directory.
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report).toMatchObject({ uncommittedFiles: 0, unmergedCommits: 0, stale: false });
	});

	test("a cancelled request still finishes once Git was dispatched: no stale record", async () => {
		const path = await recordedWorktree("cancelled");
		const controller = new AbortController();
		const run = ports.runGit;
		ports.runGit = async (workspace, args, abort, writing) => {
			const result = await safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", workspace.workspace.rootPath ?? "", ...args],
				timeout: writing ? 10_000 : 5000,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
				signal: abort,
			});
			// The client goes away while Git removes the worktree.
			if (args[0] === "worktree" && args[1] === "remove") controller.abort();
			return result;
		};
		expect(run).toBeUndefined();
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { deleteBranch: true }),
			controller.signal,
		);
		expect(result).toMatchObject({ removed: true, record: "retired" });
		expect(result.branch).toMatchObject({ name: "cancelled", deleted: true });
		expect(await exists(path)).toBe(false);
		expect(rows.size).toBe(0);
	});

	test("a record whose Git entry and directory are both gone is retired", async () => {
		const path = await recordedWorktree("forgotten");
		await git(["worktree", "remove", path]);
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report).toMatchObject({ stale: true, missing: true, branch: null, head: null });
		const result = await service.remove("actor", "narrator", removal(path), signal());
		expect(result).toMatchObject({ removed: true, record: "retired", branch: null });
		expect(rows.size).toBe(0);
		// A directory Git forgot but that still exists is not the record's to delete.
		const kept = await recordedWorktree("kept-dir");
		await git(["worktree", "remove", kept]);
		await mkdir(kept);
		await writeFile(join(kept, "mine.txt"), "x\n");
		const refused = await rejection(service.remove("actor", "narrator", removal(kept), signal()));
		expect(refused.code).toBe("WORKTREE_NOT_REGISTERED");
		expect(await exists(join(kept, "mine.txt"))).toBe(true);
	});

	test("a pushed but unmerged branch is removed without force; git -d follows its upstream", async () => {
		const path = await recordedWorktree("pushed");
		const tip = await commitIn(path, "p.txt", "1\n");
		await git(["remote", "add", "origin", join(temporary, "unused-remote")]);
		await git(["update-ref", "refs/remotes/origin/pushed", tip]);
		await git(["branch", "--set-upstream-to=origin/pushed", "pushed"]);
		const report = await service.inspectRemoval("actor", "narrator", removal(path), signal());
		expect(report.upstream).toEqual({ ref: "refs/remotes/origin/pushed", sha: tip });
		expect(report.unmergedCommits).toBe(0);
		const result = await service.remove(
			"actor",
			"narrator",
			removal(path, { deleteBranch: true }),
			signal(),
		);
		expect(result.branch).toMatchObject({ name: "pushed", deleted: true, method: "merged" });
	});

	test("an unrecorded .worktrees directory is never listed as removable or removed", async () => {
		const legacy = join(source, ".worktrees", "legacy-chapter");
		await git(["worktree", "add", "-q", "-b", "legacy-chapter", legacy]);
		const plain = join(source, ".worktrees", "hand-made");
		await mkdir(plain);
		await writeFile(join(plain, "keep.txt"), "mine\n");
		const recorded = await recordedWorktree("recorded");
		const listed = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(listed.capabilities.delete).toBe(true);
		const flags = Object.fromEntries(listed.entries.map((entry) => [entry.path, entry.recorded]));
		expect(flags[legacy]).toBe(false);
		expect(flags[recorded]).toBe(true);
		expect(flags[source]).toBe(false);
		for (const path of [legacy, plain]) {
			for (const call of [
				service.inspectRemoval("actor", "narrator", removal(path), signal()),
				service.remove("actor", "narrator", removal(path), signal()),
			]) {
				const refused = await rejection(call);
				expect(refused.code).toBe("WORKTREE_NOT_RECORDED");
				expect(refused.statusCode).toBe(404);
			}
		}
		await service.remove("actor", "narrator", removal(recorded), signal());
		expect(await exists(join(plain, "keep.txt"))).toBe(true);
		expect(await exists(legacy)).toBe(true);
		expect(await git(["worktree", "list", "--porcelain"])).toContain(legacy);
	});

	test("only the removed entry is pruned; another stale entry stays registered", async () => {
		const stale = join(source, ".worktrees", "stale-unrecorded");
		await git(["worktree", "add", "-q", "-b", "stale-unrecorded", stale]);
		await rm(stale, { recursive: true });
		const gone = await recordedWorktree("gone");
		await rm(gone, { recursive: true });
		const report = await service.inspectRemoval("actor", "narrator", removal(gone), signal());
		expect(report).toMatchObject({ missing: true, uncommittedFiles: 0 });
		await service.remove("actor", "narrator", removal(gone), signal());
		const listing = await git(["worktree", "list", "--porcelain"]);
		expect(listing).not.toContain(gone);
		expect(listing).toContain(stale);
	});

	test("protection, locks, the main checkout and in-flight creations are refused", async () => {
		const path = await recordedWorktree("guarded");
		blocked = new AppError("A session cwd is inside", 409, "WORKTREE_IN_USE");
		expect(
			(await rejection(service.remove("actor", "narrator", removal(path), signal()))).code,
		).toBe("WORKTREE_IN_USE");
		blocked = null;
		await git(["worktree", "lock", path]);
		expect(
			(await rejection(service.remove("actor", "narrator", removal(path), signal()))).code,
		).toBe("WORKTREE_LOCKED");
		await git(["worktree", "unlock", path]);
		rows.set(worktreeResourceId("local", source), {
			...(rows.get(worktreeResourceId("local", path)) as RecordedWorktreeResource),
			id: worktreeResourceId("local", source),
			worktreePath: source,
		});
		expect(
			(await rejection(service.remove("actor", "narrator", removal(source), signal()))).code,
		).toBe("WORKTREE_REMOVE_DENIED");
		const preparing = await recordedWorktree("preparing", "preparing");
		expect(
			(await rejection(service.remove("actor", "narrator", removal(preparing), signal()))).code,
		).toBe("WORKTREE_RESOURCE_PREPARING");
		expect(await exists(path)).toBe(true);
		expect(await exists(preparing)).toBe(true);
	});

	test("a killed status query fails the removal instead of reading as clean", async () => {
		const path = await recordedWorktree("stalled");
		await writeFile(join(path, "unsaved.txt"), "x\n");
		ports.runGit = async (workspace, args, abort, writing) => {
			if (args[0] === "status") return { stdout: "", stderr: "", exitCode: 143 };
			return safeSpawn({
				cmd: ["git", "--no-optional-locks", "-C", workspace.workspace.rootPath ?? "", ...args],
				timeout: writing ? 10_000 : 5000,
				maxOutputBytes: WORKTREE_MAX_OUTPUT_BYTES,
				signal: abort,
			});
		};
		const failure = await rejection(service.remove("actor", "narrator", removal(path), signal()));
		expect(failure).toBeInstanceOf(GitError);
		expect(await exists(join(path, "unsaved.txt"))).toBe(true);
	});

	test("a record that something still references is reported as retained", async () => {
		const path = await recordedWorktree("referenced");
		ports.resources = { ...ports.resources, retire: async () => false } as typeof ports.resources;
		const result = await service.remove("actor", "narrator", removal(path), signal());
		expect(result.record).toBe("retained");
		expect(await exists(path)).toBe(false);
	});

	test("without the protection port removal is unsupported and the list says so", async () => {
		const path = await recordedWorktree("unsupported");
		service = new NarratorWorktreeService({ ...ports, withRetirement: undefined });
		const listed = await service.list("actor", "narrator", { workspaceKey: "workspace" }, signal());
		expect(listed.capabilities.delete).toBe(false);
		expect(listed.entries.every((entry) => entry.recorded === undefined)).toBe(true);
		expect(
			(await rejection(service.remove("actor", "narrator", removal(path), signal()))).code,
		).toBe("WORKTREE_REMOVE_UNSUPPORTED");
	});

	test("HTTP routes report and remove through the same service", async () => {
		const path = await recordedWorktree("http");
		await writeFile(join(path, "draft.txt"), "x\n");
		const app = new Hono();
		app.onError((cause, c) =>
			c.json(
				{
					code: cause instanceof AppError ? cause.code : "INTERNAL_ERROR",
					details: cause instanceof AppError ? cause.details : undefined,
				},
				cause instanceof AppError ? (cause.statusCode as 409) : 500,
			),
		);
		app.route(
			"/api/narrators",
			createNarratorWorktreeRoutes(service, () => "actor"),
		);
		const post = (suffix: string, body: unknown) =>
			app.request(`/api/narrators/narrator/git/worktrees/${suffix}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const report = await post("removal-report", removal(path));
		expect(report.status).toBe(200);
		const measured = await report.json();
		expect(measured.uncommittedFiles).toBe(1);
		const refused = await post("remove", removal(path));
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("WORKTREE_REMOVAL_WOULD_LOSE_WORK");
		expect((await post("remove", { ...removal(path), force: true })).status).toBe(500);
		const removed = await post(
			"remove",
			removal(path, {
				discard: { head: measured.head, uncommittedFiles: 1, unmergedCommits: 0 },
			}),
		);
		expect(removed.status).toBe(200);
		expect((await removed.json()).removed).toBe(true);
		expect(await exists(path)).toBe(false);
	});
});
