import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitBranches } from "@shared/git-branches";
import type { GitCommitDetail, GitCommitPatch } from "@shared/git-commit-preview";
import type { GitLineStats } from "@shared/git-line-stats";
import type { GitWorkspace } from "@shared/git-workspace";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { narrators, projects, remoteDevices, userGitIdentities, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { windowsPathSemantics } from "../lib/agent/execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getHome } from "../lib/platform";
import { safeSpawn } from "../lib/spawn";
import { narratorGitRoutes } from "../routes/git";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionTargetContext } from "./execution-policy/types";
import { recordAttribution } from "./file-attribution-service";
import { gitDiscoveryCache } from "./git-discovery-cache";
import * as lineStatsService from "./git-line-stats";
import { clearGitLineStatsCache } from "./git-line-stats-cache";
import { gitService, withGitRequestContext } from "./git-service";
import { gitWorkspaceIdentity, probeLocalGitWorkspace } from "./git-workspace";
import {
	authorizeGitDestinationForPrincipal,
	authorizeGitTargetForPrincipal,
	gitPathPolicyAllows,
} from "./git-workspace-access";
import { GitAccessScan } from "./git-workspace-access-scan";
import type { NarratorPrincipal } from "./narrator-acl";
import { getNarratorGitSummary } from "./narrator-git-summary";
import { type ActiveNarrator, activeNarrators } from "./narrator-session-state";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import { narratorWorktreeService } from "./narrator-worktree-runtime";
import { NarratorWorktreeService } from "./narrator-worktree-service";
import { cacheLocalWorkspaceContext, workspaceContextService } from "./workspace-context-service";

// The singleton starts asynchronously; await it before a fixture captures its handle.
const { db } = await import("../db");

let root: string, repo: string, owner: string, narratorId: string;
const scanProjectIds: string[] = [];
const now = () => new Date().toISOString();
async function git(cwd: string, ...args: string[]) {
	const r = await safeSpawn({
		cmd: ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
		cwd,
		timeout: 5000,
		maxOutputBytes: 128 * 1024,
	});
	if (r.exitCode) throw new Error(r.stderr);
	return r.stdout.trim();
}
async function newRepo(name: string, commit = true) {
	const path = join(root, name);
	await mkdir(path);
	await git(path, "init", "-b", "main");
	if (commit) {
		await writeFile(join(path, "seed.txt"), "seed\n");
		await git(path, "add", "seed.txt");
		await git(path, "commit", "-m", "baseline");
	}
	return path;
}
async function newNarrator(cwd: string | null, extra: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "Git test",
		cwd,
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		createdAt: now(),
		updatedAt: now(),
		...extra,
	});
	return id;
}
function app(user = owner) {
	const result = new Hono();
	result.use("*", async (c, next) => {
		c.set("user", { sub: user, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	result.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "TEST_ERROR",
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "Content-Type": "application/json" },
				},
			),
	);
	result.route("/narrators", narratorGitRoutes);
	return result;
}
async function request(suffix: string, body?: unknown, id = narratorId, user = owner) {
	return app(user).request(
		`/narrators/${id}/git/${suffix}`,
		body === undefined
			? {}
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
	);
}
async function workspace(id = narratorId) {
	const r = await request("workspace", undefined, id);
	expect(r.status).toBe(200);
	return (await r.json()) as GitWorkspace;
}
async function project(path: string) {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: "Git project",
		gitPath: path,
		ownerUserId: owner,
		visibility: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}

describe("missing checkout durable worktree listing", () => {
	const signal = () => new AbortController().signal;
	const actor = () => ({ userId: owner, isAdmin: false });
	async function deletedCheckout(cache = true) {
		const current = join(root, "deleted-checkout");
		await git(repo, "worktree", "add", "-b", "deleted-checkout", current);
		await db.update(narrators).set({ cwd: current }).where(eq(narrators.id, narratorId));
		if (cache) {
			await authorizeGitTargetForPrincipal(actor(), { narratorId }, "read", signal());
			const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
			expect(row?.workspaceContext?.git?.repositoryPath).toBe(join(repo, ".git"));
		}
		await rm(current, { recursive: true, force: true });
		activeNarrators.delete(narratorId);
		return current;
	}
	test("standalone persisted identity survives lost runtime; list and switch to main or sibling", async () => {
		const sibling = join(root, "surviving-checkout");
		await git(repo, "worktree", "add", "-b", "surviving-checkout", sibling);
		const missing = await deletedCheckout();
		const context = await workspaceContextService.get(narratorId);
		expect(context.cwd).toBe(missing);
		const ordinary = await authorizeGitTargetForPrincipal(
			actor(),
			{ narratorId },
			"read",
			signal(),
		);
		expect(ordinary.workspace).toMatchObject({
			state: "missing_directory",
			capabilities: { read: false, write: false },
		});
		// Recreate the service with empty in-memory pagination state; only SQLite
		// carries checkout identity across runtimes.
		const freshRuntime = new NarratorWorktreeService<NarratorPrincipal>({
			authorize: (principal, id, need, abort) =>
				authorizeGitTargetForPrincipal(principal, { narratorId: id }, need, abort),
			authorizeList: (principal, id, _need, abort) =>
				authorizeGitTargetForPrincipal(principal, { narratorId: id }, "read", abort, false, true),
			principalKey: (principal) => principal.userId,
			journal: new FileWorktreeJournal(join(root, "fresh-journal")),
			withRevision: (_id, _revision, action) => action(),
			withRepositoryLock: (_key, action) => action(),
		});
		const list = await freshRuntime.list(
			actor(),
			narratorId,
			{ workspaceKey: context.git?.workspaceKey },
			signal(),
		);
		expect(list.entries.map((entry) => entry.path)).toContain(repo);
		expect(list.entries.map((entry) => entry.path)).toContain(sibling);
		expect(list.capabilities.create).toBe(false);
		await expect(
			narratorWorktreeService.list(actor(), narratorId, { workspaceKey: "wrong-source" }, signal()),
		).rejects.toThrow();
		for (const cwd of [sibling, repo]) {
			const previous = await workspaceContextService.get(narratorId);
			const result = await workspaceContextService.switch(
				narratorId,
				{
					expectedRevision: previous.revision,
					requestId: generateId(),
					target: { deviceId: "local", cwd },
				},
				{ origin: "http", userId: owner },
			);
			expect(result.current.cwd).toBe(cwd);
		}
	});
	test("no cache, invalid common directory and revoked actor fail closed", async () => {
		await deletedCheckout(false);
		await expect(
			narratorWorktreeService.list(actor(), narratorId, { workspaceKey: "unknown" }, signal()),
		).rejects.toThrow();
		// Discover another surviving checkout to populate a real durable cache.
		await db.update(narrators).set({ cwd: repo }).where(eq(narrators.id, narratorId));
		const context = await workspaceContextService.get(narratorId);
		await rm(repo, { recursive: true, force: true });
		await expect(
			narratorWorktreeService.list(
				actor(),
				narratorId,
				{ workspaceKey: context.git?.workspaceKey },
				signal(),
			),
		).rejects.toThrow();
		await expect(
			narratorWorktreeService.list(
				{ userId: "revoked-user", isAdmin: false },
				narratorId,
				{ workspaceKey: context.git?.workspaceKey },
				signal(),
			),
		).rejects.toThrow();
	});
	test("late discovery CAS cannot overwrite a committed cwd/revision transition", async () => {
		const snapshot = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
		if (!snapshot) throw new Error("Fixture narrator absent");
		const discovered = await workspaceContextService.get(narratorId);
		const other = await newRepo("switch-winner");
		const switched = await workspaceContextService.switch(
			narratorId,
			{
				expectedRevision: discovered.revision,
				requestId: generateId(),
				target: { deviceId: "local", cwd: other },
			},
			{ origin: "http", userId: owner },
		);
		expect(await cacheLocalWorkspaceContext(narratorId, snapshot, discovered)).toBe(false);
		expect(await workspaceContextService.get(narratorId)).toEqual(switched.current);
	});
	test("authoritative probes refresh the cache after main repository move and worktree repair", async () => {
		const current = join(root, "repaired-checkout");
		await git(repo, "worktree", "add", "-b", "repaired-checkout", current);
		await db.update(narrators).set({ cwd: current }).where(eq(narrators.id, narratorId));
		await authorizeGitTargetForPrincipal(actor(), { narratorId }, "read", signal());
		const previous = await workspaceContextService.get(narratorId);
		const moved = join(root, "moved-main");
		await rename(repo, moved);
		await git(moved, "worktree", "repair", current);
		const ready = await authorizeGitTargetForPrincipal(actor(), { narratorId }, "read", signal());
		expect(ready.workspace.state).toBe("ready");
		const refreshed = await workspaceContextService.get(narratorId);
		expect(refreshed.revision).toBe(previous.revision);
		expect(refreshed.git?.repositoryPath).toBe(join(moved, ".git"));
		expect(refreshed.git?.repositoryKey).not.toBe(previous.git?.repositoryKey);
		await rm(current, { recursive: true });
		const list = await narratorWorktreeService.list(
			actor(),
			narratorId,
			{ workspaceKey: refreshed.git?.workspaceKey },
			signal(),
		);
		expect(list.entries.map((entry) => entry.path)).toContain(moved);
	});
	test("a former chapter session without a directory cannot persist the main repository as execution cwd", async () => {
		const projectId = await project(repo);
		scanProjectIds.push(projectId);
		// No cwd and no `standalone` trait: the chapter that supplied its directory is gone.
		await db
			.update(narrators)
			.set({ contextProjectId: projectId, cwd: null, traits: [] })
			.where(eq(narrators.id, narratorId));
		await expect(workspaceContextService.get(narratorId)).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_REQUIRED",
		});
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
		expect(row?.workspaceContext).toBeNull();
		const resolved = await authorizeGitTargetForPrincipal(
			actor(),
			{ narratorId },
			"read",
			signal(),
		);
		expect(resolved.workspace.state).toBe("missing_directory");
		expect(resolved.workspace.rootPath).toBeNull();
	});
	test("legacy standalone cache can verify a surviving recorded Git root", async () => {
		const cwd = join(repo, "deleted-subdirectory");
		await mkdir(cwd);
		await db.update(narrators).set({ cwd }).where(eq(narrators.id, narratorId));
		const context = await workspaceContextService.get(narratorId);
		delete context.git?.repositoryPath;
		await db
			.update(narrators)
			.set({ workspaceContext: context })
			.where(eq(narrators.id, narratorId));
		await rm(cwd, { recursive: true });
		const list = await narratorWorktreeService.list(
			actor(),
			narratorId,
			{ workspaceKey: context.git?.workspaceKey },
			signal(),
		);
		expect(list.entries.map((entry) => entry.path)).toContain(repo);
	});
	test("legacy cache recovers only from verified associated project, not guessed parent paths", async () => {
		const projectId = await project(repo);
		scanProjectIds.push(projectId);
		await db
			.update(narrators)
			.set({ contextProjectId: projectId })
			.where(eq(narrators.id, narratorId));
		await deletedCheckout();
		const context = await workspaceContextService.get(narratorId);
		delete context.git?.repositoryPath;
		await db
			.update(narrators)
			.set({ workspaceContext: context })
			.where(eq(narrators.id, narratorId));
		const list = await narratorWorktreeService.list(
			actor(),
			narratorId,
			{ workspaceKey: context.git?.workspaceKey },
			signal(),
		);
		expect(list.entries.map((entry) => entry.path)).toContain(repo);
		await db.update(projects).set({ ownerUserId: null }).where(eq(projects.id, projectId));
		await expect(
			narratorWorktreeService.list(
				actor(),
				narratorId,
				{ workspaceKey: context.git?.workspaceKey },
				signal(),
			),
		).rejects.toThrow();
		await db.update(projects).set({ ownerUserId: owner }).where(eq(projects.id, projectId));
		await db.update(narrators).set({ contextProjectId: null }).where(eq(narrators.id, narratorId));
		await expect(
			narratorWorktreeService.list(
				actor(),
				narratorId,
				{ workspaceKey: context.git?.workspaceKey },
				signal(),
			),
		).rejects.toThrow();
	});
});

describe("worktree destination authorization", () => {
	async function linkedSource() {
		await mkdir(join(repo, ".worktrees"));
		const current = join(repo, ".worktrees", "current");
		await git(repo, "worktree", "add", "-b", "current", current);
		await db.update(narrators).set({ cwd: current }).where(eq(narrators.id, narratorId));
		return { current, destination: join(repo, ".worktrees", "next") };
	}

	test("checks a sibling target's policy, including narrower grants and read-only access", async () => {
		const { current, destination } = await linkedSource();
		const actor = { userId: owner, isAdmin: false };
		await authorizeGitDestinationForPrincipal(
			actor,
			narratorId,
			destination,
			"write",
			new AbortController().signal,
		);
		for (const mode of ["blacklist", "nested-blacklist", "narrow", "readonly"] as const) {
			const compile = spyOn(executionPolicyEngine, "compile").mockImplementation(
				async (id, context) => ({
					...compileExecutionPolicy(
						{
							directoryWhitelist:
								mode === "narrow" || mode === "readonly"
									? [
											{
												ruleType: "directoryWhitelist",
												enabled: true,
												selector: { kind: "host" },
												source: "narrator",
												path: mode === "narrow" ? current : destination,
												pathKey: mode === "narrow" ? current : destination,
												pathFlavor: "posix",
												accessLevel: mode === "narrow" ? "readWrite" : "readOnly",
											},
										]
									: [],
							directoryBlacklist:
								mode === "blacklist" || mode === "nested-blacklist"
									? [
											{
												ruleType: "directoryBlacklist",
												enabled: true,
												selector: { kind: "host" },
												source: "narrator",
												path: mode === "blacklist" ? destination : join(destination, "secret"),
												pathKey: destination,
												pathFlavor: "posix",
												denyLevel: "denyWrite",
											},
										]
									: [],
							commandWhitelist: [],
							commandBlacklist: [],
						},
						context,
					),
					narratorId: id,
					ownerNarratorId: id,
					projectId: null,
					projectGitPath: null,
					revision: "test",
				}),
			);
			try {
				await expect(
					authorizeGitDestinationForPrincipal(
						actor,
						narratorId,
						destination,
						"write",
						new AbortController().signal,
					),
				).rejects.toMatchObject({ code: "GIT_WORKSPACE_ACCESS_DENIED" });
				if (mode === "readonly")
					await authorizeGitDestinationForPrincipal(
						actor,
						narratorId,
						destination,
						"read",
						new AbortController().signal,
					);
			} finally {
				compile.mockRestore();
			}
		}
	});

	test("does not inherit source permission over another protected project's target", async () => {
		const { destination } = await linkedSource();
		const projectId = await project(destination);
		scanProjectIds.push(projectId);
		await db.update(projects).set({ ownerUserId: null }).where(eq(projects.id, projectId));
		await expect(
			authorizeGitDestinationForPrincipal(
				{ userId: owner, isAdmin: false },
				narratorId,
				destination,
				"read",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "GIT_WORKSPACE_ACCESS_DENIED" });
	});

	test("preserves secret-directory and fail-closed OAuth provenance checks", async () => {
		const { destination } = await linkedSource();
		const actor = { userId: owner, isAdmin: false };
		await expect(
			authorizeGitDestinationForPrincipal(
				actor,
				narratorId,
				join(getHome(), ".ssh", "new"),
				"read",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "GIT_WORKSPACE_ACCESS_DENIED" });
		await db
			.update(narrators)
			.set({ oauthPolicySnapshotJson: {} })
			.where(eq(narrators.id, narratorId));
		await expect(
			authorizeGitDestinationForPrincipal(
				actor,
				narratorId,
				destination,
				"read",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "OAUTH_RUNTIME_FORBIDDEN" });
	});

	test("rejects canonical aliases rather than granting their symlink target", async () => {
		const { destination } = await linkedSource();
		await symlink(join(repo, ".worktrees"), join(repo, "alias"));
		await expect(
			authorizeGitDestinationForPrincipal(
				{ userId: owner, isAdmin: false },
				narratorId,
				join(repo, "alias", "next"),
				"write",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "GIT_WORKSPACE_ACCESS_DENIED" });
		expect(destination).toContain(".worktrees");
	});
});

async function commitPreviewFixture() {
	const projectId = await project(repo);
	scanProjectIds.push(projectId);
	await db.update(projects).set({ visibility: "public" }).where(eq(projects.id, projectId));
	const reader = generateId();
	await db
		.insert(users)
		.values({ id: reader, username: reader, passwordHash: "fixture", createdAt: now() });
	await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId));
	const response = await request("workspace", undefined, narratorId, reader);
	expect(response.status).toBe(200);
	const ws = (await response.json()) as GitWorkspace;
	expect(ws.capabilities).toEqual({ read: true, write: false });
	return {
		reader,
		projectId,
		workspaceKey: ws.workspaceKey as string,
		sha: await git(repo, "rev-parse", "HEAD"),
		bases: [`/narrators/${narratorId}/git`],
	};
}

beforeEach(async () => {
	root = await mkdtemp(join(await realpath(tmpdir()), "nf-git-workspace-"));
	repo = await newRepo("repo");
	owner = generateId();
	await db.insert(users).values({
		id: owner,
		username: owner,
		passwordHash: "fixture",
		gitUsername: "Acting User",
		gitEmail: "acting@example.invalid",
		createdAt: now(),
	});
	// The reusable identity table is authoritative; legacy profile fields are
	// only startup migration input and this user is created after startup.
	await db.insert(userGitIdentities).values({
		id: generateId(),
		userId: owner,
		name: "Acting User",
		email: "acting@example.invalid",
		isDefault: true,
		createdAt: now(),
	});
	narratorId = await newNarrator(repo);
});
afterEach(async () => {
	activeNarrators.delete(narratorId);
	setRemoteBackendResolver(null);
	if (scanProjectIds.length)
		await db.delete(projects).where(inArray(projects.id, scanProjectIds.splice(0)));
	await rm(root, { recursive: true, force: true });
});

describe("Git workspace discovery", () => {
	test("subdirectories share their actual nearest root and device identity", async () => {
		await mkdir(join(repo, "sub"));
		const child = await newNarrator(join(repo, "sub"));
		const a = await workspace();
		const b = await workspace(child);
		expect(a.state).toBe("ready");
		expect(a.capabilities).toEqual({ read: true, write: true });
		expect(b.cwd).toBe(join(repo, "sub"));
		expect(b.rootPath).toBe(repo);
		expect(a.workspaceKey).toBe(b.workspaceKey);
		const nested = await newRepo("nested");
		expect((await probeLocalGitWorkspace(nested)).rootPath).toBe(nested);
		expect(
			gitWorkspaceIdentity({ deviceId: "another-device", paths: localBackend.paths }, repo),
		).not.toBe(a.workspaceKey);
	});
	test("linked worktrees share repository but never workspace identities", async () => {
		const linked = join(root, "linked");
		await git(repo, "worktree", "add", "-b", "other", linked);
		const other = await newNarrator(linked);
		const a = await workspace(),
			b = await workspace(other);
		expect(a.repositoryKey).toBe(b.repositoryKey);
		expect(a.workspaceKey).not.toBe(b.workspaceKey);
		expect(b.rootPath).toBe(linked);
	});
	test("context project fallback and explicit cwd override", async () => {
		const projectId = await project(repo);
		const context = await newNarrator(null, {
			contextProjectId: projectId,
			traits: ["standalone"],
		});
		expect((await workspace(context)).rootPath).toBe(repo);
		const other = await newRepo("other");
		await db
			.update(narrators)
			.set({ contextProjectId: projectId, cwd: other })
			.where(eq(narrators.id, narratorId));
		const ws = await workspace();
		expect(ws.rootPath).toBe(other);
		await writeFile(join(other, "new.txt"), "new\n");
		expect((await request("stage", { all: true, workspaceKey: ws.workspaceKey })).status).toBe(200);
		expect(
			(await request("commit", { message: "separate repo", workspaceKey: ws.workspaceKey })).status,
		).toBe(200);
		expect(await git(other, "log", "-1", "--format=%s")).toBe("separate repo");
		expect(await git(repo, "log", "-1", "--format=%s")).toBe("baseline");
	});
	test("a former chapter session without a directory is unavailable, while a project session keeps the project directory", async () => {
		const projectId = await project(repo);
		await db
			.update(narrators)
			.set({ contextProjectId: projectId, cwd: null, traits: [] })
			.where(eq(narrators.id, narratorId));
		const missing = await workspace();
		expect(missing.state).toBe("missing_directory");
		expect(missing.rootPath).toBeNull();
		expect(missing.cwd).toBe("");
		expect(missing.capabilities).toEqual({ read: false, write: false });
		await db
			.update(narrators)
			.set({ traits: ["standalone"] })
			.where(eq(narrators.id, narratorId));
		expect((await workspace()).rootPath).toBe(repo);
	});
	test("running local session cwd wins over stale persisted configuration", async () => {
		const other = await newRepo("active");
		activeNarrators.set(narratorId, { cwd: other, _defaultDeviceId: "local" } as ActiveNarrator);
		expect((await workspace()).rootPath).toBe(other);
	});
	test("unborn, missing, non-git and bare targets are distinguished", async () => {
		const empty = await newRepo("empty", false);
		await db.update(narrators).set({ cwd: empty }).where(eq(narrators.id, narratorId));
		expect((await workspace()).state).toBe("ready");
		expect(await (await request("log")).json()).toEqual([]);
		await mkdir(join(root, "plain"));
		expect((await probeLocalGitWorkspace(join(root, "plain"))).state).toBe("not_git");
		expect((await probeLocalGitWorkspace(join(root, "missing"))).state).toBe("missing_directory");
		const bare = join(root, "bare");
		await git(root, "init", "--bare", bare);
		expect((await probeLocalGitWorkspace(bare)).state).toBe("unsupported");
	});
});

describe("Git workspace project scan pagination", () => {
	async function fixtures(mode: "unrelated" | "lexical", foreign = false) {
		const unrelated = join(root, "unrelated");
		await mkdir(unrelated);
		const values = Array.from({ length: 300 }, (_, index) => ({
			id: `scan-${owner}-${String(index).padStart(4, "0")}`,
			name: "Scan fixture",
			gitPath: mode === "lexical" ? repo : unrelated,
			ownerUserId: foreign ? null : owner,
			visibility: foreign ? ("public" as const) : ("private" as const),
			createdAt: now(),
			updatedAt: now(),
		}));
		scanProjectIds.push(...values.map((row) => row.id));
		// Small inserts avoid SQLite parameter limits as well as oversized test transactions.
		for (let start = 0; start < values.length; start += 50)
			await db.insert(projects).values(values.slice(start, start + 50));
		return values[values.length - 1].id;
	}

	test("large owner inventories are not canonicalized on first paint or cache hits", async () => {
		await fixtures("unrelated");
		const canonicalize = spyOn(GitAccessScan.prototype, "canonicalize");
		try {
			for (let i = 0; i < 2; i++) {
				const summary = await getNarratorGitSummary(
					narratorId,
					0,
					{ userId: owner, isAdmin: false },
					new AbortController().signal,
				);
				expect(summary?.workspace.state).toBe("ready");
			}
			for (const [rows] of canonicalize.mock.calls)
				expect(rows.some((row) => row.gitPath === join(root, "unrelated"))).toBe(false);
		} finally {
			canonicalize.mockRestore();
		}
		expect((await workspace()).state).toBe("ready");
	});

	test("a private symlink alias after row 256 still denies access", async () => {
		const lastId = await fixtures("unrelated", true);
		const alias = join(root, "private-alias");
		await symlink(repo, alias);
		await db
			.update(projects)
			.set({ gitPath: alias, ownerUserId: null, visibility: "private" })
			.where(eq(projects.id, lastId));
		expect((await workspace()).state).toBe("access_denied");
	});

	test("lexical associations paginate completely and enforce the final private project", async () => {
		const lastId = await fixtures("lexical", true);
		expect((await workspace()).state).toBe("ready");
		await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, lastId));
		expect((await workspace()).state).toBe("access_denied");
	});
});

describe("authenticated Git management", () => {
	test("independent line statistics keep section counts and invalidate after staging", async () => {
		const ws = await workspace();
		await writeFile(join(repo, "seed.txt"), "seed\nstaged\n");
		await git(repo, "add", "seed.txt");
		await writeFile(join(repo, "seed.txt"), "seed\nstaged\nunstaged\n");
		await writeFile(join(repo, "new.txt"), "one\ntwo\n");
		const suffix = `line-stats?workspaceKey=${ws.workspaceKey}`;
		const response = await request(suffix);
		expect(response.status).toBe(200);
		const stats = (await response.json()) as GitLineStats;
		expect(stats).toMatchObject({ linesAdded: 4, linesRemoved: 0, complete: true });
		expect(stats.files.find((file) => file.path === "seed.txt")).toMatchObject({
			stagedLinesAdded: 1,
			unstagedLinesAdded: 1,
		});
		expect((await request("stage", { all: true, workspaceKey: ws.workspaceKey })).status).toBe(200);
		const staged = (await (await request(suffix)).json()) as GitLineStats;
		expect(staged.linesAdded).toBe(4);
		expect(staged.files.every((file) => file.unstagedLinesAdded === 0)).toBe(true);
		expect((await request("line-stats?workspaceKey=obsolete")).status).toBe(409);
	});

	test("slow or failed statistics never hold up lightweight status", async () => {
		clearGitLineStatsCache();
		let started!: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			started = resolve;
		});
		let fail!: (error: Error) => void;
		const statsRead = spyOn(lineStatsService, "getGitLineStats").mockImplementation(() => {
			started();
			return new Promise<GitLineStats>((_resolve, reject) => {
				fail = reject;
			});
		});
		let pending: Promise<Response> | undefined;
		try {
			pending = request("line-stats");
			await startedPromise;
			const status = await request("status");
			expect(status.status).toBe(200);
			expect(await status.json()).not.toHaveProperty("linesAdded");
			fail(new Error("statistics failed"));
			expect((await pending).status).toBe(500);
			expect((await request("status")).status).toBe(200);
		} finally {
			fail?.(new Error("cleanup"));
			await pending;
			statsRead.mockRestore();
			clearGitLineStatsCache();
		}
	});

	test("cached line statistics are still authorized on each request", async () => {
		await writeFile(join(repo, "new.txt"), "one\n");
		expect((await request("line-stats")).status).toBe(200);
		const reader = generateId();
		await db
			.insert(users)
			.values({ id: reader, username: reader, passwordHash: "fixture", createdAt: now() });
		expect((await request("line-stats", undefined, narratorId, reader)).status).toBe(404);
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId));
		expect((await request("line-stats", undefined, narratorId, reader)).status).toBe(200);
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, narratorId));
		expect((await request("line-stats", undefined, narratorId, reader)).status).toBe(404);
	});

	test("full standalone write flow and acting user commit identity", async () => {
		const ws = await workspace();
		const key = { workspaceKey: ws.workspaceKey };
		await writeFile(join(repo, "seed.txt"), "changed\n");
		expect((await request("diff?file=seed.txt")).status).toBe(200);
		expect((await request("stage", { files: ["seed.txt"], ...key })).status).toBe(200);
		expect((await request("unstage", { all: true, ...key })).status).toBe(200);
		expect((await request("stash", { action: "push", message: "park", ...key })).status).toBe(200);
		expect(((await (await request("stash/list")).json()) as unknown[]).length).toBe(1);
		expect((await request("stash", { action: "pop", ...key })).status).toBe(200);
		expect((await request("stage", { all: true, ...key })).status).toBe(200);
		const commit = await request("commit", { message: "user change", ...key });
		expect(commit.status).toBe(200);
		expect(await git(repo, "log", "-1", "--format=%an <%ae>")).toBe(
			"Acting User <acting@example.invalid>",
		);
		expect((await request("reset", { target: "HEAD~1", mode: "soft", ...key })).status).toBe(200);
		expect((await request("reset", { target: "HEAD", mode: "hard", ...key })).status).toBe(200);
		expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("seed\n");
		await writeFile(join(repo, "seed.txt"), "discard\n");
		expect((await request("discard", { files: ["seed.txt"], ...key })).status).toBe(200);
		expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("seed\n");
	});
	test("old workspace keys and missing write keys never mutate a changed target", async () => {
		const ws = await workspace();
		const other = await newRepo("changed-target");
		await writeFile(join(other, "new.txt"), "new\n");
		await db.update(narrators).set({ cwd: other }).where(eq(narrators.id, narratorId));
		const stale = await request("stage", { all: true, workspaceKey: ws.workspaceKey });
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { code: string }).code).toBe("GIT_WORKSPACE_CHANGED");
		expect(await git(other, "diff", "--cached", "--name-only")).toBe("");
		expect((await request("stage", { all: true })).status).toBe(400);
		expect((await request(`status?workspaceKey=${ws.workspaceKey}`)).status).toBe(409);
	});
	test("a read-only narrator viewer cannot use any POST endpoint", async () => {
		const reader = generateId();
		await db
			.insert(users)
			.values({ id: reader, username: reader, passwordHash: "fixture", createdAt: now() });
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId));
		const r = await request("workspace", undefined, narratorId, reader);
		expect(r.status).toBe(200);
		const ws = (await r.json()) as GitWorkspace;
		expect(ws.capabilities).toEqual({ read: true, write: false });
		for (const suffix of [
			"stage",
			"unstage",
			"commit",
			"discard",
			"stash",
			"reset",
			"ai-commit-message",
			"checkout",
			"push",
			"fetch",
		])
			expect(
				(await request(suffix, { workspaceKey: ws.workspaceKey, all: true }, narratorId, reader))
					.status,
			).toBe(404);
	});
	test("standalone ownership does not bypass an unrelated private project", async () => {
		await project(repo);
		const stranger = generateId();
		await db
			.insert(users)
			.values({ id: stranger, username: stranger, passwordHash: "fixture", createdAt: now() });
		const privateNarrator = await newNarrator(repo, { ownerUserId: stranger });
		const r = await request("workspace", undefined, privateNarrator, stranger);
		expect(r.status).toBe(200);
		const deniedWorkspace = (await r.json()) as GitWorkspace;
		expect(deniedWorkspace).toMatchObject({
			state: "access_denied",
			cwd: "",
			rootPath: null,
			workspaceKey: null,
			repositoryKey: null,
		});
		expect(deniedWorkspace.projectId).toBeUndefined();
		expect((await request("status", undefined, privateNarrator, stranger)).status).toBe(403);
	});
	test("traversal, drive paths, metadata and directory symlinks are rejected", async () => {
		const ws = await workspace();
		await symlink(root, join(repo, "outside"));
		for (const file of [
			"../outside",
			"C:escape",
			"C:\\escape",
			"\\\\host\\share",
			"/etc/passwd",
			".git/config",
			"outside/repo/seed.txt",
		])
			expect(
				(await request("stage", { files: [file], workspaceKey: ws.workspaceKey })).status,
			).toBe(400);
		await writeFile(join(repo, ":(glob)*"), "literal\n");
		await writeFile(join(repo, "other.txt"), "other\n");
		expect(
			(await request("stage", { files: [":(glob)*"], workspaceKey: ws.workspaceKey })).status,
		).toBe(200);
		expect(await git(repo, "diff", "--cached", "--name-only")).toBe(":(glob)*");
	});
	test("remote default uses device cwd, remains device-separated, never falls back locally", async () => {
		const deviceId = generateId();
		await db.insert(remoteDevices).values({
			id: deviceId,
			name: "Remote",
			slug: deviceId,
			tokenHash: deviceId,
			tokenPrefix: "fixture",
			createdBy: owner,
			scope: "global",
			ownerScope: "private",
			createdAt: now(),
			updatedAt: now(),
		});
		await db
			.update(narrators)
			.set({ defaultDeviceId: deviceId })
			.where(eq(narrators.id, narratorId));
		expect((await workspace()).state).toBe("device_offline");
		let probes = 0;
		const backend = {
			...localBackend,
			deviceId,
			kind: "remote",
			paths: localBackend.paths,
			pathFlavor: localBackend.pathFlavor,
			runtimeGeneration: 1,
			defaultCwd: "/remote/work",
			supportsGitWorkspace: true,
			async gitWorkspace(input: {
				cwd: string;
				operation: string;
				maxBytes: number;
				timeoutMs: number;
			}) {
				expect(input.cwd).toBe("/remote/work");
				expect(input.operation).toBe("probe");
				probes++;
				if (probes > 1) {
					expect(input.maxBytes).toBe(32 * 1024);
					expect(input.timeoutMs).toBe(10_000);
				}
				return {
					state: "ready",
					rootPath: "/remote/work",
					repositoryPath: "/remote/work/.git",
					branch: "remote-main",
				};
			},
			resolvePathIdentity: async (path: string) => ({
				lexicalPath: path,
				canonicalPath: path,
				exists: true,
				runtimeGeneration: 1,
			}),
		} as unknown as ExecutionBackend;
		setRemoteBackendResolver(() => backend);
		const ws = await workspace();
		expect(ws.deviceId).toBe(deviceId);
		expect(ws.cwd).toBe("/remote/work");
		expect(ws.rootPath).toBe("/remote/work");
		expect(probes).toBe(1);
		const summary = () =>
			getNarratorGitSummary(
				narratorId,
				0,
				{ userId: owner, isAdmin: false },
				new AbortController().signal,
			);
		expect((await summary())?.branch).toBe("remote-main");
		expect((await summary())?.workspace.cwd).toBe("/remote/work");
		expect(probes).toBe(2);
		await db.update(remoteDevices).set({ revokedAt: now() }).where(eq(remoteDevices.id, deviceId));
		expect((await request("workspace")).status).toBe(403);
		expect((await summary())?.workspace.state).toBe("access_denied");
		expect((await summary())?.branch).toBeNull();
		expect(probes).toBe(2);
	});
});

describe("branch management routes", () => {
	test("GET branches reports the current branch and its refs", async () => {
		const ws = await workspace();
		await git(repo, "branch", "side");
		const response = await request(`branches?workspaceKey=${ws.workspaceKey}`);
		expect(response.status).toBe(200);
		const listing = (await response.json()) as GitBranches;
		expect(listing.branch).toBe("main");
		expect(listing.detached).toBe(false);
		expect(listing.headSha).toBe(await git(repo, "rev-parse", "HEAD"));
		expect(listing.local.map((entry) => entry.name)).toEqual(["main", "side"]);
		expect(listing.remote).toEqual([]);
		expect(listing.remotes).toEqual([]);
		expect(listing.defaultRemote).toBeNull();
	});

	test("a stale or missing workspace key never reaches the branch operations", async () => {
		// A write without a key cannot be attributed to a workspace at all.
		expect((await request("checkout", { branch: "side" })).status).toBe(400);
		expect((await request("push", {})).status).toBe(400);
		expect((await request("fetch", {})).status).toBe(400);
		// A key pinned to a different target is rejected before any Git runs.
		expect((await request("checkout", { branch: "side", workspaceKey: "obsolete" })).status).toBe(
			409,
		);
	});

	test("checkout creates a branch and returns the refreshed status", async () => {
		const ws = await workspace();
		const response = await request("checkout", {
			branch: "feature/http",
			create: true,
			workspaceKey: ws.workspaceKey,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: { branch: string } };
		expect(body.status.branch).toBe("feature/http");
		expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("feature/http");
		// Switching back to an existing local branch needs no `create`.
		expect(
			(
				await request("checkout", {
					branch: "main",
					workspaceKey: ws.workspaceKey,
				})
			).status,
		).toBe(200);
		expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
		// A rejected name is a validation error, not a git failure.
		expect(
			(
				await request("checkout", {
					branch: "bad..name",
					workspaceKey: ws.workspaceKey,
				})
			).status,
		).toBe(400);
	});

	test("push and fetch without a configured remote fail before touching the network", async () => {
		const ws = await workspace();
		const push = await request("push", { workspaceKey: ws.workspaceKey });
		expect(push.status).toBe(422);
		expect(((await push.json()) as { code: string }).code).toBe("GIT_NO_REMOTE");
		const fetchRemote = await request("fetch", { workspaceKey: ws.workspaceKey });
		expect(fetchRemote.status).toBe(422);
		expect(((await fetchRemote.json()) as { code: string }).code).toBe("GIT_NO_REMOTE");
		// A remote name the repository does not have is refused, not passed to git.
		expect(
			(await request("fetch", { remote: "elsewhere", workspaceKey: ws.workspaceKey })).status,
		).toBe(400);
	});
});

describe("commit preview routes", () => {
	test("read-only viewers preview both domains without changing HEAD, index bytes or working files", async () => {
		const f = await commitPreviewFixture();
		await writeFile(join(repo, "seed.txt"), "staged draft\n");
		await git(repo, "add", "seed.txt");
		await writeFile(join(repo, "seed.txt"), "unstaged draft\n");
		await writeFile(join(repo, "untracked.txt"), "untracked draft\n");
		const indexBefore = await readFile(join(repo, ".git", "index"));
		for (const base of f.bases) {
			// The narrator path is pinned to its workspace.
			const params = new URLSearchParams({ workspaceKey: f.workspaceKey });
			const metadata = await app(f.reader).request(`${base}/commits/${f.sha}?${params}`);
			expect(metadata.status).toBe(200);
			const detail = (await metadata.json()) as GitCommitDetail;
			expect(detail).toMatchObject({
				sha: f.sha,
				parents: [],
				comparedTo: null,
				message: "baseline",
			});
			expect(detail.files).toContainEqual({
				path: "seed.txt",
				status: "added",
				linesAdded: 1,
				linesRemoved: 0,
				binary: false,
			});
			params.set("file", "seed.txt");
			const response = await app(f.reader).request(`${base}/commits/${f.sha}/diff?${params}`);
			expect(response.status).toBe(200);
			const patch = (await response.json()) as GitCommitPatch;
			expect(patch.diff).toContain("+seed");
			expect(patch.diff).not.toContain("draft");
			expect(patch.truncated).toBe(false);
		}
		expect(await git(repo, "rev-parse", "HEAD")).toBe(f.sha);
		expect((await readFile(join(repo, ".git", "index"))).equals(indexBefore)).toBe(true);
		expect(await readFile(join(repo, "seed.txt"), "utf8")).toBe("unstaged draft\n");
		expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe("untracked draft\n");
	}, 15_000);

	test("wrong workspace pins return 409 for detail and diff in either domain", async () => {
		const f = await commitPreviewFixture();
		for (const base of f.bases) {
			for (const suffix of ["", "/diff"]) {
				const params = new URLSearchParams({
					workspaceKey: "different-device:/different-root",
					file: "seed.txt",
				});
				const response = await app(f.reader).request(`${base}/commits/${f.sha}${suffix}?${params}`);
				expect(response.status).toBe(409);
				expect(await response.json()).toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
			}
		}
	}, 15_000);

	test("revoked narrator and project visibility immediately denies previously readable previews", async () => {
		const f = await commitPreviewFixture();
		for (const base of f.bases)
			expect((await app(f.reader).request(`${base}/commits/${f.sha}`)).status).toBe(200);
		await db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, narratorId));
		await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, f.projectId));
		for (const base of f.bases) {
			for (const suffix of ["", "/diff?file=seed.txt"]) {
				const response = await app(f.reader).request(`${base}/commits/${f.sha}${suffix}`);
				expect(response.status).toBe(404);
				const body = await response.text();
				expect(body).not.toContain(f.sha);
				expect(body).not.toContain("seed.txt");
			}
		}
	}, 15_000);

	test("malicious destination/source paths are rejected and missing objects or files return 404", async () => {
		const f = await commitPreviewFixture();
		for (const base of f.bases) {
			for (const path of [
				"../outside",
				"sub\\..\\..\\outside",
				"C:\\outside",
				"/outside",
				".git/config",
				"seed.txt\0tail",
			]) {
				for (const field of ["file", "oldPath"]) {
					const params = new URLSearchParams({ file: "seed.txt", workspaceKey: f.workspaceKey });
					params.set(field, path);
					const response = await app(f.reader).request(`${base}/commits/${f.sha}/diff?${params}`);
					expect(response.status).toBe(400);
				}
			}
			const missingCommit = await app(f.reader).request(`${base}/commits/${"0".repeat(40)}`);
			expect(missingCommit.status).toBe(404);
			expect(await missingCommit.json()).toMatchObject({ code: "GIT_COMMIT_NOT_FOUND" });
			const missingFile = await app(f.reader).request(
				`${base}/commits/${f.sha}/diff?file=missing.txt`,
			);
			expect(missingFile.status).toBe(404);
			expect(await missingFile.json()).toMatchObject({ code: "GIT_COMMIT_FILE_NOT_FOUND" });
		}
	}, 20_000);
});

test("execution path policy rejects a remote cwd before any Git probe", async () => {
	const deviceId = generateId();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "Denied remote",
		slug: deviceId,
		tokenHash: deviceId,
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.update(narrators).set({ defaultDeviceId: deviceId }).where(eq(narrators.id, narratorId));
	let probes = 0;
	const backend = {
		...localBackend,
		deviceId,
		kind: "remote",
		paths: localBackend.paths,
		pathFlavor: localBackend.pathFlavor,
		runtimeGeneration: 1,
		defaultCwd: "/remote/forbidden",
		supportsGitWorkspace: true,
		async gitWorkspace() {
			probes++;
			return {
				state: "ready",
				rootPath: "/remote/forbidden",
				repositoryPath: "/remote/forbidden/.git",
			};
		},
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver(() => backend);
	const compile = spyOn(executionPolicyEngine, "compile").mockImplementation(
		async (id, context) => ({
			...compileExecutionPolicy(
				{
					directoryWhitelist: [],
					directoryBlacklist: [
						{
							ruleType: "directoryBlacklist",
							enabled: true,
							path: "/remote/forbidden",
							pathFlavor: "posix",
							pathKey: "/remote/forbidden",
							denyLevel: "denyAll",
							selector: { kind: "device", deviceId },
							source: "narrator",
						},
					],
					commandWhitelist: [],
					commandBlacklist: [],
				},
				context,
			),
			narratorId: id,
			ownerNarratorId: id,
			projectId: null,
			projectGitPath: null,
			revision: "test",
		}),
	);
	try {
		expect((await request("workspace")).status).toBe(403);
		expect(probes).toBe(0);
	} finally {
		compile.mockRestore();
	}
});

test("a pre-cancelled modifications request starts no remote Git RPC", async () => {
	const deviceId = generateId();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "Cancelled remote",
		slug: deviceId,
		tokenHash: deviceId,
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.update(narrators).set({ defaultDeviceId: deviceId }).where(eq(narrators.id, narratorId));
	let calls = 0;
	setRemoteBackendResolver(
		() =>
			({
				...localBackend,
				deviceId,
				kind: "remote",
				defaultCwd: "/remote/repo",
				supportsGitWorkspace: true,
				async gitWorkspace() {
					calls++;
					throw new Error("cancelled request must not reach RPC");
				},
			}) as unknown as ExecutionBackend,
	);
	const response = await app().request(
		new Request(`http://localhost/narrators/${narratorId}/git/modifications?scope=uncommitted`, {
			signal: AbortSignal.abort(),
		}),
	);
	expect(response.status).toBe(200);
	expect(
		((await response.json()) as { currentDiff: { baselineStatus: string } }).currentDiff,
	).toMatchObject({ baselineStatus: "unavailable" });
	expect(calls).toBe(0);
});

test("a pre-cancelled local request returns no history and starts no Git probe", async () => {
	const stranger = generateId();
	await db.insert(users).values({
		id: stranger,
		username: stranger,
		passwordHash: "fixture",
		createdAt: now(),
	});
	await db.insert(projects).values({
		id: generateId(),
		name: "Private related repository",
		gitPath: repo,
		ownerUserId: stranger,
		visibility: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await recordAttribution({
		deviceId: "local",
		workspacePath: repo,
		filePath: "private/secret.txt",
		narratorId,
		action: "edit",
	});
	const spawn = spyOn(Bun, "spawn");
	try {
		const response = await app().request(
			new Request(`http://localhost/narrators/${narratorId}/git/modifications?scope=uncommitted`, {
				signal: AbortSignal.abort(),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			byFile: unknown[];
			timeline?: unknown[];
			currentDiff?: { baselineStatus: string };
		};
		expect(body.byFile).toEqual([]);
		expect(body.timeline).toEqual([]);
		expect(body.currentDiff).toMatchObject({ baselineStatus: "unavailable" });
		expect(JSON.stringify(body)).not.toContain("private/secret.txt");

		const historyOnly = await app().request(
			new Request(`http://localhost/narrators/${narratorId}/git/modifications`, {
				signal: AbortSignal.abort(),
			}),
		);
		expect(historyOnly.status).toBe(200);
		expect((await historyOnly.json()).currentDiff).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
	}
});

test("target is re-authorized inside the local write lock", async () => {
	const ws = await workspace();
	const other = await newRepo("late-target");
	await writeFile(join(repo, "late.txt"), "pending\n");
	const original = gitService.stageAll;
	const hook = spyOn(gitService, "stageAll").mockImplementation(async (path) => {
		await db.update(narrators).set({ cwd: other }).where(eq(narrators.id, narratorId));
		return original.call(gitService, path);
	});
	try {
		expect((await request("stage", { all: true, workspaceKey: ws.workspaceKey })).status).toBe(409);
	} finally {
		hook.mockRestore();
	}
	expect(await git(repo, "diff", "--cached", "--name-only")).toBe("");
	expect(await git(other, "diff", "--cached", "--name-only")).toBe("");
});

test("project symlink registration cannot be bypassed through the physical path", async () => {
	const alias = join(root, "project-alias");
	await symlink(repo, alias);
	await project(alias);
	const stranger = generateId();
	await db
		.insert(users)
		.values({ id: stranger, username: stranger, passwordHash: "fixture", createdAt: now() });
	const foreign = await newNarrator(repo, { ownerUserId: stranger });
	const response = await request("workspace", undefined, foreign, stranger);
	expect(((await response.json()) as GitWorkspace).state).toBe("access_denied");
});

test("sibling-directory observations include other narrators but redact private identity", async () => {
	const actorCwd = join(repo, "packages", "a");
	const sibling = join(repo, "packages", "b");
	await mkdir(actorCwd, { recursive: true });
	await mkdir(sibling, { recursive: true });
	await writeFile(join(sibling, "change.txt"), "new\n");
	const privateActor = await newNarrator(actorCwd, {
		ownerUserId: null,
		title: "PRIVATE ACTOR TITLE",
	});
	await recordAttribution({
		deviceId: "local",
		workspacePath: actorCwd,
		filePath: "../b/change.txt",
		narratorId: privateActor,
		action: "edit",
		toolUseId: "PRIVATE TOOL ID",
	});
	await recordAttribution({
		deviceId: "unrelated-device",
		workspacePath: repo,
		filePath: "packages/b/change.txt",
		narratorId,
		action: "edit",
	});
	for (const suffix of ["modifications?scope=uncommitted", "modifications"]) {
		const response = await request(suffix);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { byFile: { filePath: string }[] };
		expect(body.byFile.some((entry) => entry.filePath === "packages/b/change.txt")).toBe(true);
		expect(JSON.stringify(body)).not.toContain("PRIVATE ACTOR TITLE");
		expect(JSON.stringify(body)).not.toContain("PRIVATE TOOL ID");
		expect(JSON.stringify(body)).not.toContain(privateActor);
	}
});

test("a single-file read covers only that file, its rename source and sibling cwd history", async () => {
	const actorCwd = join(repo, "packages", "a");
	await mkdir(actorCwd, { recursive: true });
	await git(repo, "mv", "seed.txt", "renamed.txt");
	await writeFile(join(repo, "other.txt"), "other\n");
	await recordAttribution({
		deviceId: "local",
		workspacePath: repo,
		filePath: "seed.txt",
		narratorId,
		action: "edit",
	});
	await recordAttribution({
		deviceId: "local",
		workspacePath: actorCwd,
		filePath: "../../renamed.txt",
		narratorId,
		action: "edit",
	});
	await recordAttribution({
		deviceId: "local",
		workspacePath: repo,
		filePath: "other.txt",
		narratorId,
		action: "write",
	});
	const response = await request(
		"modifications?scope=uncommitted&projection=byFile&filePath=renamed.txt",
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		byFile: { filePath: string; changeCount: number }[];
		currentDiff: { byFile: { filePath: string }[] };
		timeline?: unknown;
	};
	expect(body.timeline).toBeUndefined();
	expect(body.byFile.map((file) => [file.filePath, file.changeCount])).toEqual([
		["renamed.txt", 2],
	]);
	expect(body.currentDiff.byFile.map((file) => file.filePath)).toEqual(["renamed.txt"]);

	const clean = await request(
		"modifications?scope=uncommitted&projection=byFile&filePath=seed.txt",
	);
	expect(clean.status).toBe(200);
	const cleanBody = (await clean.json()) as { byFile: unknown[]; hasMore: boolean };
	expect(cleanBody.byFile).toEqual([]);
	expect(cleanBody.hasMore).toBe(false);
});

test("a single-file read rejects unscoped, absolute, escaping and .git paths", async () => {
	const base = "modifications?scope=uncommitted&projection=byFile&filePath=";
	for (const suffix of [
		"modifications?scope=uncommitted&filePath=seed.txt",
		"modifications?projection=byFile&filePath=seed.txt",
		`${base}${encodeURIComponent("../outside.txt")}`,
		`${base}${encodeURIComponent("/etc/passwd")}`,
		`${base}${encodeURIComponent(".git/config")}`,
		`${base}${encodeURIComponent("a\0b")}`,
		base,
	]) {
		expect((await request(suffix)).status).toBe(400);
	}
});

test("remote Windows sibling paths use case-folded workspace attribution", async () => {
	const deviceId = generateId();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "Remote attribution",
		slug: deviceId,
		tokenHash: deviceId,
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.update(narrators).set({ defaultDeviceId: deviceId }).where(eq(narrators.id, narratorId));
	const backend = {
		...localBackend,
		deviceId,
		kind: "remote",
		paths: windowsPathSemantics,
		pathFlavor: "windows",
		runtimeGeneration: 1,
		defaultCwd: "C:\\Repo\\Packages\\A",
		supportsGitWorkspace: true,
		async gitWorkspace(input: { cwd: string; operation: string }) {
			if (input.operation === "probe") {
				return {
					state: "ready",
					rootPath: "C:\\Repo",
					repositoryPath: "C:\\Repo\\.git",
				};
			}
			if (input.operation === "status") {
				expect(input.cwd).toBe("C:\\Repo");
				return {
					outputs: {
						status: " M packages/b/change.txt\0",
						unstagedNumstat: "1\t0\tpackages/b/change.txt\0",
						head: "0123456789abcdef",
						branch: "main",
					},
				};
			}
			throw new Error(`unexpected Git operation: ${input.operation}`);
		},
		resolvePathIdentity: async (path: string) => ({
			lexicalPath: path,
			canonicalPath: path,
			exists: true,
			runtimeGeneration: 1,
		}),
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver(() => backend);
	await recordAttribution({
		deviceId,
		workspacePath: "c:\\repo\\packages\\a",
		filePath: "c:\\repo\\packages\\b\\change.txt",
		narratorId,
		action: "edit",
	});
	const response = await request("modifications?scope=uncommitted");
	expect(response.status).toBe(200);
	const body = (await response.json()) as { byFile: { filePath: string }[] };
	expect(body.byFile.map((file) => file.filePath)).toContain("packages/b/change.txt");
});

test("unborn staging can be undone and its staged diff is visible", async () => {
	const empty = await newRepo("unborn", false);
	await db.update(narrators).set({ cwd: empty }).where(eq(narrators.id, narratorId));
	await writeFile(join(empty, "first.txt"), "first commit\n");
	const ws = await workspace();
	expect((await request("stage", { all: true, workspaceKey: ws.workspaceKey })).status).toBe(200);
	expect(await withGitRequestContext(undefined, () => gitService.getFullDiff(empty))).toContain(
		"first commit",
	);
	expect(
		(await request("unstage", { files: ["first.txt"], workspaceKey: ws.workspaceKey })).status,
	).toBe(200);
	expect(await git(empty, "ls-files")).toBe("");
	expect(await readFile(join(empty, "first.txt"), "utf8")).toBe("first commit\n");
});

test("a narrower path grant never authorizes the containing worktree", () => {
	const context: ExecutionTargetContext = {
		backend: localBackend,
		paths: localBackend.paths,
		deviceClass: null,
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd: repo,
			pathFlavor: localBackend.pathFlavor,
			runtimeGeneration: 0,
			selectionSource: "session_default",
		},
	};
	const policy = compileExecutionPolicy(
		{
			directoryWhitelist: [
				{
					ruleType: "directoryWhitelist",
					enabled: true,
					path: join(repo, "sub"),
					pathFlavor: "posix",
					pathKey: join(repo, "sub"),
					accessLevel: "readWrite",
					selector: { kind: "host" },
					source: "narrator",
				},
			],
			directoryBlacklist: [],
			commandWhitelist: [],
			commandBlacklist: [],
		},
		context,
	);
	expect(gitPathPolicyAllows(policy, context, repo, "read")).toBe(false);
	expect(gitPathPolicyAllows(policy, context, repo, "write")).toBe(false);
});

test("repository root above cwd: ancestor grants do not narrow it, a cwd grant still does", () => {
	// cwd is a package inside the repo, so the repo root is an ANCESTOR of cwd.
	const cwd = join(repo, "packages", "a");
	const context: ExecutionTargetContext = {
		backend: localBackend,
		paths: localBackend.paths,
		deviceClass: null,
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd,
			pathFlavor: localBackend.pathFlavor,
			runtimeGeneration: 0,
			selectionSource: "session_default",
		},
	};
	const withGrant = (path: string, accessLevel: "readOnly" | "readWrite") =>
		compileExecutionPolicy(
			{
				directoryWhitelist: [
					{
						ruleType: "directoryWhitelist",
						enabled: true,
						path,
						pathFlavor: "posix",
						pathKey: path,
						accessLevel,
						selector: { kind: "host" },
						source: "narrator",
					},
				],
				directoryBlacklist: [],
				commandWhitelist: [],
				commandBlacklist: [],
			},
			context,
		);
	// A readOnly grant covering the repo (from above) only grants; like no rule at all.
	const ancestor = withGrant(dirname(repo), "readOnly");
	expect(gitPathPolicyAllows(ancestor, context, repo, "read")).toBe(true);
	expect(gitPathPolicyAllows(ancestor, context, repo, "write")).toBe(true);
	// An explicit grant on cwd is narrower than the repo root: still no whole-repo access.
	const narrower = withGrant(cwd, "readWrite");
	expect(gitPathPolicyAllows(narrower, context, repo, "read")).toBe(false);
	expect(gitPathPolicyAllows(narrower, context, repo, "write")).toBe(false);
});

test("a readOnly grant on an ancestor or the root itself never downgrades the worktree", () => {
	const context: ExecutionTargetContext = {
		backend: localBackend,
		paths: localBackend.paths,
		deviceClass: null,
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd: repo,
			pathFlavor: localBackend.pathFlavor,
			runtimeGeneration: 0,
			selectionSource: "session_default",
		},
	};
	// e.g. projects/{a,b,c}: narrator runs in a, grants readOnly on projects/ to read b and c.
	for (const grantPath of [dirname(repo), repo]) {
		const policy = compileExecutionPolicy(
			{
				directoryWhitelist: [
					{
						ruleType: "directoryWhitelist",
						enabled: true,
						path: grantPath,
						pathFlavor: "posix",
						pathKey: grantPath,
						accessLevel: "readOnly",
						selector: { kind: "host" },
						source: "narrator",
					},
				],
				directoryBlacklist: [],
				commandWhitelist: [],
				commandBlacklist: [],
			},
			context,
		);
		expect(gitPathPolicyAllows(policy, context, repo, "read")).toBe(true);
		expect(gitPathPolicyAllows(policy, context, repo, "write")).toBe(true);
	}
});

describe("Narrator first-paint Git summary", () => {
	const summary = (id = narratorId, userId = owner, revision = 0) =>
		getNarratorGitSummary(id, revision, { userId, isAdmin: false }, new AbortController().signal);

	test("returns cached branch identity without scanning status, refreshes on invalidation", async () => {
		const status = spyOn(gitService, "getStatusSummary");
		try {
			const initial = await summary();
			expect(initial?.workspace.state).toBe("ready");
			expect(initial?.workspace.rootPath).toBe(repo);
			expect(initial?.branch).toBe("main");
			expect(initial?.revision).toBe(0);
			await git(repo, "checkout", "-b", "next");
			expect((await summary())?.branch).toBe("main");
			gitDiscoveryCache.invalidate("local", repo);
			expect((await summary())?.branch).toBe("next");
			expect(status).not.toHaveBeenCalled();
		} finally {
			status.mockRestore();
		}
	});

	test("non Git and unborn Git are explicit independent states", async () => {
		const plain = join(root, "plain-summary");
		await mkdir(plain);
		const plainId = await newNarrator(plain);
		expect((await summary(plainId))?.workspace.state).toBe("not_git");
		const unbornId = await newNarrator(await newRepo("unborn-summary", false));
		expect((await summary(unbornId))?.branch).toBe("main");
		expect((await summary(unbornId))?.workspace.state).toBe("ready");
	});

	test("cache does not share permissions or leak branch and root to a public reader", async () => {
		const projectId = await project(repo);
		scanProjectIds.push(projectId);
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId));
		expect((await summary())?.branch).toBe("main");
		const denied = await summary(narratorId, generateId());
		expect(denied?.workspace.state).toBe("access_denied");
		expect(denied?.workspace.rootPath).toBeNull();
		expect(denied?.workspace.workspaceKey).toBeNull();
		expect(denied?.workspace.cwd).toBe("");
		expect(denied?.branch).toBeNull();
		expect(denied?.workspace.branch).toBeUndefined();
		await db.update(projects).set({ visibility: "public" }).where(eq(projects.id, projectId));
		const readable = await summary(narratorId, generateId());
		expect(readable?.workspace.capabilities).toEqual({ read: true, write: false });
		expect(readable?.branch).toBe("main");
	});

	test.each([
		new AppError("Temporary access scan failure", 503, "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE"),
		new Error("Temporary discovery failure"),
	])("temporary summary failure returns no seed and permits an authoritative retry: %s", async (error) => {
		const compile = spyOn(executionPolicyEngine, "compile").mockRejectedValueOnce(error);
		try {
			expect(await summary()).toBeNull();
			const recovered = await workspace();
			expect(recovered.state).toBe("ready");
			expect(recovered.capabilities.read).toBe(true);
			expect((await summary())?.branch).toBe("main");
		} finally {
			compile.mockRestore();
		}
	});

	test("a genuinely unsupported worktree remains an explicit summary state", async () => {
		const bare = join(root, "bare-summary");
		await mkdir(bare);
		await git(bare, "init", "--bare");
		const id = await newNarrator(bare);
		const result = await summary(id);
		expect(result?.workspace.state).toBe("unsupported");
		expect(result?.workspace.capabilities).toEqual({ read: false, write: false });
		expect(result?.branch).toBeNull();
	});

	test("summary discovery does not turn cancellation into a successful seed", async () => {
		const controller = new AbortController();
		const reason = new Error("Summary request cancelled");
		const compile = spyOn(executionPolicyEngine, "compile").mockImplementationOnce(async () => {
			controller.abort(reason);
			throw reason;
		});
		try {
			await expect(
				getNarratorGitSummary(narratorId, 0, { userId: owner, isAdmin: false }, controller.signal),
			).rejects.toBe(reason);
		} finally {
			compile.mockRestore();
		}
	});

	test("rejects a summary paired with an obsolete workspace revision", async () => {
		await db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId));
		expect(await summary()).toBeNull();
		expect((await summary(narratorId, owner, 1))?.revision).toBe(1);
	});
});
