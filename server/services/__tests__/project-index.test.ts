/**
 * Project index: which projects a session belongs to, derived from its directory.
 *
 * Run: bun test --isolate server/services/__tests__/project-index.test.ts
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	type PathLike,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { narratorProjectLinks, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { resolveNarratorProjectId } from "../narrator-project";
import {
	ancestorKeys,
	assignProjectRootKey,
	directoryKey,
	ensureProjectRootKeys,
	resetProjectIndexStateForTests,
	scheduleProjectIndexRebuild,
	syncNarratorProjectLinks,
	syncNarratorProjectLinksSafely,
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
afterEach(() => mock.restore());

function afterRealpath(callback: (path: PathLike) => Promise<void>): void {
	const original = fsPromises.realpath;
	// Forward both string and Buffer overloads, then open a deterministic async
	// mutation window without weakening the production filesystem implementation.
	const wrapped = async (path: PathLike, options?: Parameters<typeof original>[1]) => {
		const resolved = await original(path, options);
		await callback(path);
		return resolved;
	};
	spyOn(fsPromises, "realpath").mockImplementation(wrapped as typeof original);
}

async function makeNarratorsAt(cwd: string, count: number): Promise<string[]> {
	const now = new Date().toISOString();
	const ids = Array.from({ length: count }, () => generateId());
	for (let start = 0; start < ids.length; start += 100) {
		await db
			.insert(narrators)
			.values(
				ids.slice(start, start + 100).map((id) => ({ id, cwd, createdAt: now, updatedAt: now })),
			);
	}
	return ids;
}

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
	test("reuses repeated directories across pages and does not open unchanged transactions", async () => {
		const dir = makeDir("repeated-cwd");
		const projectId = await makeProject(dir);
		const ids = await makeNarratorsAt(dir, 425);
		await scheduleProjectIndexRebuild();
		const realpaths = spyOn(fsPromises, "realpath");
		const transactions = spyOn(db, "transaction");
		const logs = spyOn(logger, "info");

		await scheduleProjectIndexRebuild();

		expect(realpaths.mock.calls.filter(([path]) => path === dir)).toHaveLength(1);
		expect(transactions).not.toHaveBeenCalled();
		for (const id of [ids[0], ids[200], ids[424]]) {
			expect(await linksOf(id)).toEqual([{ projectId, role: "primary", source: "cwd" }]);
		}
		const result = logs.mock.calls.find(([message]) => message === "Project index rebuilt")?.[1];
		expect(result).toMatchObject({ changed: 0, failed: 0 });
		expect(result?.scanned).toBeGreaterThanOrEqual(425);
		expect(result?.skipped).toBe(result?.scanned);
		expect(result?.ms).toBeGreaterThanOrEqual(0);
	});

	test("one changed row does not force unchanged rows into transactions", async () => {
		await scheduleProjectIndexRebuild();
		const dir = makeDir("mixed-change");
		const project = await makeProject(dir);
		await assignProjectRootKey(project);
		const key = await directoryKey(dir);
		const ids = ["00-mixed-1", "00-mixed-2", "00-mixed-3"];
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values(ids.map((id) => ({ id, cwd: dir, createdAt: now, updatedAt: now })));
		await db.insert(narratorProjectLinks).values(
			ids.slice(1).map((narratorId) => ({
				narratorId,
				projectId: project,
				role: "primary" as const,
				source: "cwd" as const,
				directory: key,
				updatedAt: now,
			})),
		);
		const transactions = spyOn(db, "transaction");

		await scheduleProjectIndexRebuild();

		expect(transactions).toHaveBeenCalledTimes(1);
		for (const id of ids)
			expect(await linksOf(id)).toEqual([{ projectId: project, role: "primary", source: "cwd" }]);
	});

	test("single-pass directory caches evict old entries rather than growing without bound", async () => {
		const dir = makeDir("bounded-cache");
		const project = await makeProject(dir);
		await ensureProjectRootKeys();
		const key = await directoryKey(dir);
		const now = new Date().toISOString();
		const narrator = sqlite.query(
			"insert into narrators (id, cwd, created_at, updated_at) values (?, ?, ?, ?)",
		);
		const link = sqlite.query(
			"insert into narrator_project_links (narrator_id, project_id, role, source, directory, updated_at) values (?, ?, 'primary', 'cwd', ?, ?)",
		);
		const first = join(dir, "0");
		sqlite.transaction(() => {
			for (let index = 0; index < 514; index++) {
				const id = `zz-bound-${String(index).padStart(4, "0")}`;
				const cwd = index === 513 ? first : join(dir, String(index));
				narrator.run(id, cwd, now, now);
				link.run(id, project, `${key}/${index === 513 ? 0 : index}`, now);
			}
		})();
		const realpaths = spyOn(fsPromises, "realpath");

		await scheduleProjectIndexRebuild();

		expect(realpaths.mock.calls.filter(([path]) => path === first)).toHaveLength(2);
		expect(await linksOf("zz-bound-0513")).toEqual([
			{ projectId: project, role: "primary", source: "cwd" },
		]);
	});

	test("a new pass discovers an offline git init even within the normal probe TTL", async () => {
		const dir = makeDir("offline-repository");
		const id = await makeNarrator({ cwd: dir });
		await syncNarratorProjectLinks(id); // Populate the normal negative probe cache too.
		await scheduleProjectIndexRebuild();
		expect(await linksOf(id)).toEqual([]);

		makeRepo("offline-repository");
		await scheduleProjectIndexRebuild();

		expect((await linksOf(id))[0]?.projectId).toBe((await projectsAt(dir))[0]?.id);
		expect(await linksOf(id)).toHaveLength(1);
	});

	test("normal synchronization does not retain a rebuild's realpath cache", async () => {
		if (process.platform === "win32") return;
		const first = makeDir("symlink-first");
		const second = makeDir("symlink-second");
		const firstProject = await makeProject(first);
		const secondProject = await makeProject(second);
		const alias = join(root, "symlink-alias");
		symlinkSync(first, alias, "dir");
		const id = await makeNarrator({ cwd: alias });
		await scheduleProjectIndexRebuild();
		expect((await linksOf(id))[0]?.projectId).toBe(firstProject);

		unlinkSync(alias);
		symlinkSync(second, alias, "dir");
		await syncNarratorProjectLinks(id);

		expect((await linksOf(id))[0]?.projectId).toBe(secondProject);
	});

	test("rebuild preserves explicit primary and remote directory semantics", async () => {
		const dir = makeDir("rebuild-semantics");
		const cwdProject = await makeProject(dir);
		const explicit = await makeProject(makeDir("rebuild-explicit"));
		const local = await makeNarrator({ cwd: dir, contextProjectId: explicit });
		const remote = await makeNarrator({
			cwd: dir,
			contextProjectId: explicit,
			defaultDeviceId: "remote",
		});
		await scheduleProjectIndexRebuild();

		expect(await linksOf(local)).toContainEqual({
			projectId: explicit,
			role: "primary",
			source: "explicit",
		});
		expect(await linksOf(local)).toContainEqual({
			projectId: cwdProject,
			role: "additional",
			source: "cwd",
		});
		expect(await linksOf(remote)).toEqual([
			{ projectId: explicit, role: "primary", source: "explicit" },
		]);
		expect(await resolveNarratorProjectId({ id: local, contextProjectId: explicit })).toBe(
			explicit,
		);
	});

	test("a concurrent cwd/explicit update and single-row sync cannot be overwritten", async () => {
		const oldDir = makeDir("race-old");
		const newDir = makeDir("race-new");
		const oldProject = await makeProject(oldDir);
		const newProject = await makeProject(newDir);
		const explicit = await makeProject(makeDir("race-explicit"));
		await ensureProjectRootKeys();
		const id = await makeNarrator({ cwd: oldDir });
		let mutated = false;
		afterRealpath(async (path) => {
			if (path === oldDir && !mutated) {
				mutated = true;
				await db
					.update(narrators)
					.set({ cwd: newDir, contextProjectId: explicit })
					.where(eq(narrators.id, id));
				await syncNarratorProjectLinks(id);
			}
		});

		await scheduleProjectIndexRebuild();

		expect(mutated).toBe(true);
		expect(await linksOf(id)).toContainEqual({
			projectId: explicit,
			role: "primary",
			source: "explicit",
		});
		expect(await linksOf(id)).toContainEqual({
			projectId: newProject,
			role: "additional",
			source: "cwd",
		});
		expect((await linksOf(id)).some((link) => link.projectId === oldProject)).toBe(false);
	});

	test("unrelated writes during every realpath cannot starve a cwd/permission update", async () => {
		const oldDir = makeDir("unrelated-write-old");
		const newDir = makeDir("unrelated-write-new");
		const oldProject = await makeProject(oldDir);
		const newProject = await makeProject(newDir);
		await ensureProjectRootKeys();
		const id = await makeNarrator({ cwd: oldDir });
		const unrelated = await makeNarrator({});
		await syncNarratorProjectLinks(id);
		expect((await linksOf(id))[0]?.projectId).toBe(oldProject);
		await db.update(narrators).set({ cwd: newDir }).where(eq(narrators.id, id));
		let noisyWrites = 0;
		afterRealpath(async (path) => {
			if (path === newDir) {
				noisyWrites++;
				await db
					.update(narrators)
					.set({ updatedAt: `noise-${noisyWrites}` })
					.where(eq(narrators.id, unrelated));
			}
		});
		const warnings = spyOn(logger, "warn");

		await syncNarratorProjectLinksSafely(id);

		expect(noisyWrites).toBe(1);
		expect(await linksOf(id)).toEqual([{ projectId: newProject, role: "primary", source: "cwd" }]);
		expect(await resolveNarratorProjectId({ id, contextProjectId: null })).toBe(newProject);
		expect(
			warnings.mock.calls.some(([message]) => message === "Project index: narrator sync failed"),
		).toBe(false);
	});

	test("project deletion during derivation cannot resurrect its links", async () => {
		const dir = makeDir("race-project-delete");
		const project = await makeProject(dir);
		await ensureProjectRootKeys();
		const id = await makeNarrator({ cwd: dir, contextProjectId: project });
		let deleted = false;
		afterRealpath(async (path) => {
			if (path === dir && !deleted) {
				deleted = true;
				await db.delete(projects).where(eq(projects.id, project));
			}
		});

		await scheduleProjectIndexRebuild();

		expect(deleted).toBe(true);
		expect(await linksOf(id)).toEqual([]);
	});

	test("a write through another SQLite connection invalidates a page snapshot", async () => {
		const dir = makeDir("external-connection");
		await makeProject(dir);
		await ensureProjectRootKeys();
		const id = await makeNarrator({ cwd: dir });
		const other = new Database(sqlite.filename);
		let mutated = false;
		afterRealpath(async (path) => {
			if (path === dir && !mutated) {
				mutated = true;
				other.query("update narrators set default_device_id = 'remote' where id = ?").run(id);
			}
		});
		try {
			await scheduleProjectIndexRebuild();
			expect(mutated).toBe(true);
			expect(await linksOf(id)).toEqual([]);
		} finally {
			other.close();
		}
	});

	test("a project root mutation invalidates cached matches for later rows", async () => {
		const dir = makeDir("root-mutation");
		const trigger = makeDir("root-mutation-trigger");
		const moved = makeDir("root-mutation-away");
		const project = await makeProject(dir);
		await ensureProjectRootKeys();
		const key = await directoryKey(dir);
		const ids = ["zz-root-mutation-1", "zz-root-mutation-2", "zz-root-mutation-3"];
		const now = new Date().toISOString();
		await db.insert(narrators).values(
			ids.map((id, index) => ({
				id,
				cwd: index === 1 ? trigger : dir,
				createdAt: now,
				updatedAt: now,
			})),
		);
		await db.insert(narratorProjectLinks).values(
			[ids[0], ids[2]].map((narratorId) => ({
				narratorId,
				projectId: project,
				role: "primary" as const,
				source: "cwd" as const,
				directory: key,
				updatedAt: now,
			})),
		);
		let mutated = false;
		afterRealpath(async (path) => {
			if (path === trigger && !mutated) {
				mutated = true;
				await db.update(projects).set({ gitPath: moved }).where(eq(projects.id, project));
				await assignProjectRootKey(project);
			}
		});

		await scheduleProjectIndexRebuild();

		expect(mutated).toBe(true);
		expect(await linksOf(ids[2])).toEqual([]);
		// A project route schedules a follow-up full pass as well, repairing rows
		// visited before its mutation rather than trusting a persistent done marker.
		await scheduleProjectIndexRebuild();
		expect(await linksOf(ids[0])).toEqual([]);
	});

	test("a deleted narrator is not recreated after asynchronous derivation", async () => {
		const dir = makeDir("race-narrator-delete");
		await makeProject(dir);
		await ensureProjectRootKeys();
		const id = await makeNarrator({ cwd: dir });
		let deleted = false;
		afterRealpath(async (path) => {
			if (path === dir && !deleted) {
				deleted = true;
				await db.delete(narrators).where(eq(narrators.id, id));
			}
		});

		await scheduleProjectIndexRebuild();
		expect(deleted).toBe(true);
		expect(await linksOf(id)).toEqual([]);
	});

	test("a failed row is retried successfully by the next complete pass", async () => {
		await scheduleProjectIndexRebuild();
		const dir = makeDir("retry-row");
		const projectId = await makeProject(dir);
		await assignProjectRootKey(projectId);
		const id = await makeNarrator({ cwd: dir });
		spyOn(db, "transaction").mockImplementationOnce(() => {
			throw new Error("injected transaction failure");
		});
		const logs = spyOn(logger, "info");

		await scheduleProjectIndexRebuild();
		expect(await linksOf(id)).toEqual([]);
		expect(
			logs.mock.calls.find(([message]) => message === "Project index rebuilt")?.[1],
		).toMatchObject({ failed: 1 });
		await scheduleProjectIndexRebuild();
		expect(await linksOf(id)).toEqual([{ projectId, role: "primary", source: "cwd" }]);
	});

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

describe("root keys", () => {
	test("a delayed root assignment cannot overwrite a newer project directory", async () => {
		const oldDir = makeDir("assign-old");
		const newDir = makeDir("assign-new");
		const project = await makeProject(oldDir);
		let updated = false;
		afterRealpath(async (path) => {
			if (path === oldDir && !updated) {
				updated = true;
				await db.update(projects).set({ gitPath: newDir }).where(eq(projects.id, project));
				await assignProjectRootKey(project);
			}
		});

		await assignProjectRootKey(project);

		expect((await projectsAt(newDir))[0]?.rootKey).toBe(await directoryKey(newDir));
	});

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
