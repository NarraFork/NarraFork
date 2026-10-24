/**
 * Project index: which projects a session belongs to, derived from its directory.
 *
 * Run: bun test --isolate server/services/__tests__/project-index.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { narratorProjectLinks, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { resolveNarratorProjectId } from "../narrator-project";
import {
	ancestorKeys,
	directoryKey,
	ensureNarratorProjectLinks,
	ensureProjectRootKeys,
	resetProjectIndexStateForTests,
	scheduleProjectIndexRebuild,
	syncNarratorProjectLinks,
} from "../project-index";
import { narratorProjectIdText } from "../read/acl-sql";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nf-project-index-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function makeDir(...parts: string[]): string {
	const dir = join(root, ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeRepo(name: string): string {
	const dir = makeDir(name);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), "x");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

async function makeUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `index-${id}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function makeProject(gitPath: string, createdAt = new Date().toISOString()): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({ id, name: id, gitPath, createdAt, updatedAt: createdAt });
	return id;
}

async function makeNarrator(fields: Partial<typeof narrators.$inferInsert>): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({ id, createdAt: now, updatedAt: now, ...fields });
	return id;
}

async function linksOf(narratorId: string) {
	return await db
		.select({
			projectId: narratorProjectLinks.projectId,
			role: narratorProjectLinks.role,
			source: narratorProjectLinks.source,
		})
		.from(narratorProjectLinks)
		.where(eq(narratorProjectLinks.narratorId, narratorId));
}

async function projectsAt(gitPath: string) {
	return await db
		.select({ id: projects.id, rootKey: projects.rootKey })
		.from(projects)
		.where(eq(projects.gitPath, gitPath));
}

beforeEach(() => resetProjectIndexStateForTests());

describe("ancestorKeys", () => {
	test("walks whole path segments up to the root", () => {
		expect(ancestorKeys("/a/bc/d")).toEqual(["/a/bc/d", "/a/bc", "/a", "/"]);
		expect(ancestorKeys("/a/bc")).not.toContain("/a/b");
	});

	test("ends a Windows path at its drive root", () => {
		expect(ancestorKeys("c:/a/b")).toEqual(["c:/a/b", "c:/a", "c:/"]);
	});
});

describe("matching existing projects", () => {
	test("matches on segment boundaries only", async () => {
		const owner = await makeUser();
		const projectDir = makeDir("plain", "a");
		const sibling = makeDir("plain", "abc");
		const project = await makeProject(projectDir);
		await ensureProjectRootKeys();

		const inside = await makeNarrator({ cwd: join(projectDir, "sub"), ownerUserId: owner });
		makeDir("plain", "a", "sub");
		const beside = await makeNarrator({ cwd: sibling, ownerUserId: owner });
		await syncNarratorProjectLinks(inside);
		await syncNarratorProjectLinks(beside);

		expect(await linksOf(inside)).toEqual([{ projectId: project, role: "primary", source: "cwd" }]);
		// `abc` is not inside `a`, and it is no git repository, so no project at all.
		expect(await linksOf(beside)).toEqual([]);
		expect(await projectsAt(sibling)).toEqual([]);
	});

	test("prefers the longest project root", async () => {
		const outer = makeDir("nested");
		const inner = makeDir("nested", "inner");
		const outerProject = await makeProject(outer);
		const innerProject = await makeProject(inner);
		const narrator = await makeNarrator({ cwd: makeDir("nested", "inner", "deep") });
		await syncNarratorProjectLinks(narrator);
		const links = await linksOf(narrator);
		expect(links.map((link) => link.projectId)).toEqual([innerProject]);
		expect(links.map((link) => link.projectId)).not.toContain(outerProject);
	});
});

describe("git repositories without a project", () => {
	test("a subdirectory and a linked worktree both resolve to the main repository", async () => {
		const owner = await makeUser();
		const repo = makeRepo("repo-main");
		const worktree = join(repo, ".worktrees", "feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

		const inSubdir = await makeNarrator({ cwd: makeDir("repo-main", "src"), ownerUserId: owner });
		await syncNarratorProjectLinks(inSubdir);
		const created = await projectsAt(repo);
		expect(created).toHaveLength(1);
		const project = await db.query.projects.findFirst({ where: eq(projects.id, created[0].id) });
		expect(project).toMatchObject({ ownerUserId: owner, visibility: "public", name: "repo-main" });

		const inWorktree = await makeNarrator({ cwd: worktree, ownerUserId: owner });
		await syncNarratorProjectLinks(inWorktree);
		expect(await linksOf(inWorktree)).toEqual([
			{ projectId: created[0].id, role: "primary", source: "cwd" },
		]);
		expect(await projectsAt(repo)).toHaveLength(1);
	});

	test("a directory outside every repository creates nothing", async () => {
		const dir = makeDir("not-a-repo");
		const narrator = await makeNarrator({ cwd: dir });
		await syncNarratorProjectLinks(narrator);
		expect(await linksOf(narrator)).toEqual([]);
		expect(await projectsAt(dir)).toEqual([]);
	});

	test("concurrent sessions in one new repository create one project", async () => {
		const repo = makeRepo("repo-race");
		const ids = await Promise.all(Array.from({ length: 5 }, () => makeNarrator({ cwd: repo })));
		await Promise.all(ids.map((id) => syncNarratorProjectLinks(id)));
		const created = await projectsAt(repo);
		expect(created).toHaveLength(1);
		for (const id of ids) expect((await linksOf(id))[0]?.projectId).toBe(created[0].id);
	});

	test("a remote device's directory is never indexed", async () => {
		const repo = makeRepo("repo-remote");
		const narrator = await makeNarrator({ cwd: repo, defaultDeviceId: "some-device" });
		await syncNarratorProjectLinks(narrator);
		expect(await linksOf(narrator)).toEqual([]);
		expect(await projectsAt(repo)).toEqual([]);
	});
});

describe("primary project", () => {
	test("an explicit project wins over the directory, which becomes additional", async () => {
		const explicit = await makeProject(makeDir("explicit-home"));
		const repo = makeRepo("repo-additional");
		const narrator = await makeNarrator({ cwd: repo, contextProjectId: explicit });
		await syncNarratorProjectLinks(narrator);

		const derived = (await projectsAt(repo))[0].id;
		const links = await linksOf(narrator);
		expect(links).toContainEqual({ projectId: explicit, role: "primary", source: "explicit" });
		expect(links).toContainEqual({ projectId: derived, role: "additional", source: "cwd" });

		// Access and configuration follow the primary project only, in JS and in SQL.
		expect(await resolveNarratorProjectId({ id: narrator, contextProjectId: explicit })).toBe(
			explicit,
		);
		const row = sqlite
			.query<{ projectId: string }, [string]>(
				`select ${narratorProjectIdText("n")} as projectId from narrators n where n.id = ?`,
			)
			.get(narrator);
		expect(row?.projectId).toBe(explicit);
	});

	test("without an explicit project the directory's project is primary", async () => {
		const repo = makeRepo("repo-primary");
		const narrator = await makeNarrator({ cwd: repo });
		await syncNarratorProjectLinks(narrator);
		const derived = (await projectsAt(repo))[0].id;
		expect(await resolveNarratorProjectId({ id: narrator, contextProjectId: null })).toBe(derived);
		const row = sqlite
			.query<{ projectId: string }, [string]>(
				`select ${narratorProjectIdText("n")} as projectId from narrators n where n.id = ?`,
			)
			.get(narrator);
		expect(row?.projectId).toBe(derived);
	});
});

describe("rebuild", () => {
	test("deletes links that can no longer be derived and adds missing ones", async () => {
		const stale = await makeProject(makeDir("stale-project"));
		const repo = makeRepo("repo-rebuild");
		const moved = await makeNarrator({ cwd: makeDir("moved-away") });
		const unindexed = await makeNarrator({ cwd: repo });
		await db.insert(narratorProjectLinks).values({
			narratorId: moved,
			projectId: stale,
			role: "primary",
			source: "cwd",
			directory: "/nowhere",
			updatedAt: new Date().toISOString(),
		});

		await scheduleProjectIndexRebuild();

		expect(await linksOf(moved)).toEqual([]);
		expect((await linksOf(unindexed))[0]?.projectId).toBe((await projectsAt(repo))[0].id);
	});
});

describe("lazy verification", () => {
	test("derives links the first time a narrator is viewed, then skips it", async () => {
		const repo = makeRepo("repo-lazy");
		const narrator = await makeNarrator({ cwd: repo });
		expect(await linksOf(narrator)).toEqual([]);

		await ensureNarratorProjectLinks(narrator);
		const projectId = (await projectsAt(repo))[0].id;
		expect((await linksOf(narrator))[0]?.projectId).toBe(projectId);

		await db.delete(narratorProjectLinks).where(eq(narratorProjectLinks.narratorId, narrator));
		await ensureNarratorProjectLinks(narrator);
		expect(await linksOf(narrator)).toEqual([]);
	});
});

describe("root keys", () => {
	test("only the oldest of several projects on one directory takes part in matching", async () => {
		const dir = makeDir("duplicated");
		const older = await makeProject(dir, "2020-01-01T00:00:00.000Z");
		const newer = await makeProject(dir, "2021-01-01T00:00:00.000Z");
		await ensureProjectRootKeys();
		const rows = await projectsAt(dir);
		expect(rows.find((row) => row.id === older)?.rootKey).toBe(await directoryKey(dir));
		expect(rows.find((row) => row.id === newer)?.rootKey).toBeNull();

		const narrator = await makeNarrator({ cwd: dir });
		await syncNarratorProjectLinks(narrator);
		expect((await linksOf(narrator))[0]?.projectId).toBe(older);
	});
});
