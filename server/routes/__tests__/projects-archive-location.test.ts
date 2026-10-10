import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { chapters, narrators, narratorWorktreeResources, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { getProjectDbPath, projectDbManager } from "../../lib/project-db";
import {
	projectArchiveMainStore,
	setProjectArchiveMainStore,
} from "../../services/project-archive/store";
import { __testing, syncProject } from "../../services/project-db-sync";
import { projectDbRoutes } from "../project-db";
import { projectRoutes } from "../projects";

const tempDirs: string[] = [];
const projectIds: string[] = [];
const userIds: string[] = [];
const chapterIds: string[] = [];
const narratorIds: string[] = [];
const resourceIds: string[] = [];

afterEach(async () => {
	for (const id of resourceIds.splice(0))
		await db.delete(narratorWorktreeResources).where(eq(narratorWorktreeResources.id, id));
	for (const id of narratorIds.splice(0)) await db.delete(narrators).where(eq(narrators.id, id));
	for (const id of chapterIds.splice(0)) await db.delete(chapters).where(eq(chapters.id, id));
	for (const id of projectIds.splice(0)) {
		projectDbManager.close(id);
		await db.delete(projects).where(eq(projects.id, id));
	}
	for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ProjectRecord {
	name: string;
	git_path: string;
}

function readArchive(gitPath: string, id: string): ProjectRecord {
	const archive = new Database(getProjectDbPath(gitPath), { readonly: true });
	try {
		return archive
			.prepare("SELECT name, git_path FROM projects WHERE id=?")
			.get(id) as ProjectRecord;
	} finally {
		archive.close();
	}
}

async function fixture(withNarrator = false) {
	const root = mkdtempSync(join(tmpdir(), "nf-archive-location-"));
	tempDirs.push(root);
	const oldPath = join(root, "original");
	const newPath = join(root, "restored");
	for (const path of [oldPath, newPath]) {
		mkdirSync(path);
		execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", path], {
			timeout: 5000,
			maxBuffer: 8192,
		});
	}
	const id = generateId();
	const userId = generateId();
	const now = new Date().toISOString();
	projectIds.push(id);
	userIds.push(userId);
	await db.insert(users).values({
		id: userId,
		username: userId,
		passwordHash: "fixture",
		role: "admin",
		createdAt: now,
	});
	await db.insert(projects).values({
		id,
		name: "Original project",
		gitPath: oldPath,
		ownerUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
	const narratorId = withNarrator ? generateId() : null;
	if (narratorId) {
		const chapterId = generateId();
		chapterIds.push(chapterId);
		narratorIds.push(narratorId);
		await db.insert(chapters).values({
			id: chapterId,
			projectId: id,
			title: "Fixture root",
			branch: "main",
			baseBranch: "main",
			isRoot: 1,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: narratorId,
			chapterId,
			ownerUserId: userId,
			title: "Original narrator",
			createdAt: now,
			updatedAt: now,
		});
	}
	const app = new Hono()
		.onError((error) =>
			Response.json(
				{ code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
				{ status: error instanceof AppError ? error.statusCode : 500 },
			),
		)
		.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		})
		.route("/projects", projectRoutes)
		.route("/projects", projectDbRoutes);

	// This endpoint explicitly uses the production worker even under NODE_ENV=test.
	const backup = await app.request(`/projects/${id}/backup/sync`, { method: "POST" });
	expect(backup.status).toBe(200);
	const original = readArchive(oldPath, id);
	expect(original).toEqual({ name: "Original project", git_path: oldPath });
	const cached = await projectDbManager.getDb(id);
	if (!cached) throw new Error("Fixture archive was not cached");
	mkdirSync(dirname(getProjectDbPath(newPath)), { recursive: true });
	// Serialize a consistent SQLite snapshot while deliberately retaining the live cache entry.
	writeFileSync(getProjectDbPath(newPath), cached.serialize());
	return { app, id, oldPath, newPath, original, cached, narratorId };
}

async function deleteAndImport(f: Awaited<ReturnType<typeof fixture>>) {
	const deleted = await f.app.request(`/projects/${f.id}`, { method: "DELETE" });
	expect(deleted.status).toBe(200);
	expect(await deleted.json()).toEqual({ ok: true });
	expect(await db.query.projects.findFirst({ where: eq(projects.id, f.id) })).toBeUndefined();
	expect(await projectDbManager.getDb(f.id)).toBeNull();

	// The public route forces worker:true and preserves the archive's project ID.
	const imported = await f.app.request("/projects/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ gitPath: f.newPath }),
	});
	expect(imported.status).toBe(201);
	expect(await imported.json()).toMatchObject({ projectId: f.id, skipped: false });
	expect(await db.query.projects.findFirst({ where: eq(projects.id, f.id) })).toMatchObject({
		id: f.id,
		gitPath: f.newPath,
	});
	const renamed = await f.app.request(`/projects/${f.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Restored project" }),
	});
	expect(renamed.status).toBe(200);
	expect(await renamed.json()).toMatchObject({ name: "Restored project", gitPath: f.newPath });
	await syncProject(f.id);
	return { original: readArchive(f.oldPath, f.id), restored: readArchive(f.newPath, f.id) };
}

describe("project archive location after deletion and worker import", () => {
	test("a cold cache syncs the restored directory and preserves the original archive", async () => {
		const f = await fixture();
		projectDbManager.close(f.id);
		expect(await deleteAndImport(f)).toEqual({
			original: f.original,
			restored: { name: "Restored project", git_path: f.newPath },
		});
	});

	test("a warm cache syncs the restored directory and preserves the original archive", async () => {
		const f = await fixture();
		expect(await deleteAndImport(f)).toEqual({
			original: f.original,
			restored: { name: "Restored project", git_path: f.newPath },
		});
	});

	test("a resource-protected deletion keeps the project and cached archive usable", async () => {
		const f = await fixture();
		const id = generateId();
		resourceIds.push(id);
		await db.insert(narratorWorktreeResources).values({
			id,
			scopeKind: "project",
			scopeProjectId: f.id,
			deviceId: "local",
			repositoryKey: "fixture-resource",
			worktreePath: f.oldPath,
			state: "ready",
			createRequestId: generateId(),
		});
		const response = await f.app.request(`/projects/${f.id}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ code: "RESOURCE_PROTECTED" });
		expect(await db.query.projects.findFirst({ where: eq(projects.id, f.id) })).toBeDefined();
		expect(await projectDbManager.getDb(f.id)).toBe(f.cached);
		expect(f.cached.prepare("SELECT name, git_path FROM projects WHERE id=?").get(f.id)).toEqual(
			f.original,
		);
	});

	test("a database refusal to delete keeps the cached archive usable", async () => {
		const f = await fixture();
		sqlite.run(`CREATE TEMP TRIGGER reject_fixture_project_delete BEFORE DELETE ON projects
			WHEN OLD.id = '${f.id}' BEGIN SELECT RAISE(ABORT, 'fixture delete refused'); END`);
		try {
			const response = await f.app.request(`/projects/${f.id}`, { method: "DELETE" });
			expect(response.status).toBe(500);
			expect(await db.query.projects.findFirst({ where: eq(projects.id, f.id) })).toBeDefined();
			expect(await projectDbManager.getDb(f.id)).toBe(f.cached);
			expect(f.cached.prepare("SELECT name, git_path FROM projects WHERE id=?").get(f.id)).toEqual(
				f.original,
			);
		} finally {
			sqlite.run("DROP TRIGGER reject_fixture_project_delete");
		}
	});

	test("an in-flight narrator sync settles without corrupting the restored archive", async () => {
		const f = await fixture(true);
		const narratorId = f.narratorId;
		if (!narratorId) throw new Error("Missing fixture narrator");
		const originalStore = projectArchiveMainStore;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let blocked = false;
		setProjectArchiveMainStore({
			...originalStore,
			readRows: async (query) => {
				const page = await originalStore.readRows(query);
				if (
					!blocked &&
					query.table === "narrators" &&
					query.filter?.column === "id" &&
					query.filter.values.includes(narratorId)
				) {
					blocked = true;
					entered.resolve();
					await release.promise;
				}
				return page;
			},
		});
		const warnings = spyOn(logger, "warn");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const pending = __testing.runNarratorSync(narratorId);
		try {
			await entered.promise;
			expect(await deleteAndImport(f)).toEqual({
				original: f.original,
				restored: { name: "Restored project", git_path: f.newPath },
			});
			await db
				.update(narrators)
				.set({ title: "Restored narrator" })
				.where(eq(narrators.id, narratorId));
			await __testing.runNarratorSync(narratorId);
			release.resolve();
			await pending;
			expect(unhandled).toEqual([]);
			expect(warnings.mock.calls).toContainEqual([
				"Project DB narrator sync failed",
				{ narratorId, error: expect.stringContaining("Cannot use a closed database") },
			]);
			expect(
				await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) }),
			).toMatchObject({
				title: "Restored narrator",
			});
			const restored = new Database(getProjectDbPath(f.newPath), { readonly: true });
			try {
				expect(restored.prepare("SELECT title FROM narrators WHERE id=?").get(narratorId)).toEqual({
					title: "Restored narrator",
				});
				await db
					.update(narrators)
					.set({ title: "Following sync" })
					.where(eq(narrators.id, narratorId));
				await __testing.runNarratorSync(narratorId);
				expect(restored.prepare("SELECT title FROM narrators WHERE id=?").get(narratorId)).toEqual({
					title: "Following sync",
				});
			} finally {
				restored.close();
			}
		} finally {
			release.resolve();
			await pending;
			setProjectArchiveMainStore(undefined);
			warnings.mockRestore();
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
