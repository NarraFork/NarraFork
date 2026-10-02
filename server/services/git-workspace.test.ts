import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitCommitDetail, GitCommitPatch } from "@shared/git-commit-preview";
import type { GitWorkspace } from "@shared/git-workspace";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { chapters, narrators, projects, remoteDevices, users } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { windowsPathSemantics } from "../lib/agent/execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import { gitRoutes, narratorGitRoutes } from "../routes/git";
import { commitSyncService } from "./commit-sync-service";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import { executionPolicyEngine } from "./execution-policy/engine";
import type { ExecutionTargetContext } from "./execution-policy/types";
import { recordAttribution } from "./file-attribution-service";
import { gitService, withGitRequestContext } from "./git-service";
import { gitWorkspaceIdentity, probeLocalGitWorkspace } from "./git-workspace";
import { gitPathPolicyAllows } from "./git-workspace-access";
import { type ActiveNarrator, activeNarrators } from "./narrator-session-state";

// The singleton starts asynchronously; await it before a fixture captures its handle.
const { db } = await import("../db");

let root: string, repo: string, owner: string, narratorId: string;
const scanProjectIds: string[] = [];
const scanChapterIds: string[] = [];
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
	result.route("/chapters", gitRoutes);
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

async function commitPreviewFixture() {
	const projectId = await project(repo);
	scanProjectIds.push(projectId);
	await db.update(projects).set({ visibility: "public" }).where(eq(projects.id, projectId));
	const chapterId = generateId();
	scanChapterIds.push(chapterId);
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Commit preview",
		branch: "main",
		baseBranch: "main",
		worktreePath: repo,
		createdAt: now(),
		updatedAt: now(),
	});
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
		chapterId,
		workspaceKey: ws.workspaceKey as string,
		sha: await git(repo, "rev-parse", "HEAD"),
		bases: [`/narrators/${narratorId}/git`, `/chapters/${chapterId}/git`],
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
	narratorId = await newNarrator(repo);
});
afterEach(async () => {
	activeNarrators.delete(narratorId);
	setRemoteBackendResolver(null);
	if (scanChapterIds.length)
		await db.delete(chapters).where(inArray(chapters.id, scanChapterIds.splice(0)));
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
	test("context project fallback and explicit cwd override preserve chapter attribution", async () => {
		const projectId = await project(repo);
		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Chapter",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
			createdAt: now(),
			updatedAt: now(),
		});
		const context = await newNarrator(null, { contextProjectId: projectId });
		expect((await workspace(context)).rootPath).toBe(repo);
		const other = await newRepo("other");
		await db.update(narrators).set({ chapterId, cwd: other }).where(eq(narrators.id, narratorId));
		const ws = await workspace();
		expect(ws.rootPath).toBe(other);
		expect(ws.chapterId).toBeUndefined();
		const record = spyOn(commitSyncService, "recordCommit");
		await writeFile(join(other, "new.txt"), "new\n");
		expect((await request("stage", { all: true, workspaceKey: ws.workspaceKey })).status).toBe(200);
		expect(
			(await request("commit", { message: "separate repo", workspaceKey: ws.workspaceKey })).status,
		).toBe(200);
		expect(record).not.toHaveBeenCalled();
		record.mockRestore();
		const legacy = await app().request(`/chapters/${chapterId}/git/workspace`);
		expect(((await legacy.json()) as GitWorkspace).rootPath).toBe(repo);
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
	async function fixtures(mode: "unrelated" | "lexical" | "chapter") {
		const unrelated = join(root, "unrelated");
		await mkdir(unrelated);
		const values = Array.from({ length: 300 }, (_, index) => ({
			id: `scan-${owner}-${String(index).padStart(4, "0")}`,
			name: "Scan fixture",
			gitPath: mode === "lexical" ? repo : unrelated,
			ownerUserId: owner,
			visibility: "private" as const,
			createdAt: now(),
			updatedAt: now(),
		}));
		scanProjectIds.push(...values.map((row) => row.id));
		// Small inserts avoid SQLite parameter limits as well as oversized test transactions.
		for (let start = 0; start < values.length; start += 50)
			await db.insert(projects).values(values.slice(start, start + 50));
		if (mode === "chapter") {
			for (const [index, row] of values.entries()) {
				const id = `scan-chapter-${owner}-${String(index).padStart(4, "0")}`;
				scanChapterIds.push(id);
				await db.insert(chapters).values({
					id,
					projectId: row.id,
					title: "Scan chapter",
					branch: `scan-${index}`,
					baseBranch: "main",
					worktreePath: repo,
					status: "active",
					createdAt: now(),
					updatedAt: now(),
				});
			}
		}
		return values[values.length - 1].id;
	}

	test("more than 256 unrelated registered projects do not deny a workspace", async () => {
		await fixtures("unrelated");
		expect((await workspace()).state).toBe("ready");
	});

	test("a private symlink alias after row 256 still denies access", async () => {
		const lastId = await fixtures("unrelated");
		const alias = join(root, "private-alias");
		await symlink(repo, alias);
		await db
			.update(projects)
			.set({ gitPath: alias, ownerUserId: null })
			.where(eq(projects.id, lastId));
		expect((await workspace()).state).toBe("access_denied");
	});

	for (const mode of ["lexical", "chapter"] as const) {
		test(`${mode} associations paginate completely and enforce the final private project`, async () => {
			const lastId = await fixtures(mode);
			expect((await workspace()).state).toBe("ready");
			await db.update(projects).set({ ownerUserId: null }).where(eq(projects.id, lastId));
			expect((await workspace()).state).toBe("access_denied");
		});
	}
});

describe("authenticated Git management", () => {
	test("legacy chapter routes retain their existing no-workspace-key contract", async () => {
		const projectId = await project(repo);
		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Legacy Git",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
			createdAt: now(),
			updatedAt: now(),
		});
		await writeFile(join(repo, "seed.txt"), "legacy route\n");
		const status = await app().request(`/chapters/${chapterId}/git/status`);
		expect(status.status).toBe(200);
		expect(((await status.json()) as { hasChanges: boolean }).hasChanges).toBe(true);
		const stage = await app().request(`/chapters/${chapterId}/git/stage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ files: ["seed.txt"] }),
		});
		expect(stage.status).toBe(200);
		const diff = await app().request(`/chapters/${chapterId}/git/diff?file=seed.txt&staged=true`);
		expect(diff.status).toBe(200);
		expect(((await diff.json()) as { diff: string }).diff).toContain("legacy route");
		const commit = await app().request(`/chapters/${chapterId}/git/commit`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "legacy route" }),
		});
		expect(commit.status).toBe(200);
		expect(await git(repo, "log", "-1", "--format=%s")).toBe("legacy route");
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
		expect(deniedWorkspace.chapterId).toBeUndefined();
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
			async gitWorkspace(input: { cwd: string }) {
				expect(input.cwd).toBe("/remote/work");
				probes++;
				return { state: "ready", rootPath: "/remote/work", repositoryPath: "/remote/work/.git" };
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
		await db.update(remoteDevices).set({ revokedAt: now() }).where(eq(remoteDevices.id, deviceId));
		expect((await request("workspace")).status).toBe(403);
		expect(probes).toBe(1);
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
			// The narrator path is pinned; the chapter adapter retains its keyless contract.
			const params = new URLSearchParams();
			if (base.startsWith("/narrators/")) params.set("workspaceKey", f.workspaceKey);
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

test("a pre-cancelled chapter request returns no history and starts no Git probe", async () => {
	const projectId = await project(repo);
	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Cancelled chapter",
		branch: "main",
		baseBranch: "main",
		worktreePath: repo,
		createdAt: now(),
		updatedAt: now(),
	});
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
			new Request(`http://localhost/chapters/${chapterId}/git/modifications?scope=uncommitted`, {
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
			new Request(`http://localhost/chapters/${chapterId}/git/modifications`, {
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
