import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getTestDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { getDbPath, openDatabase } from "../../db/connection";
import { narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { projectDbManager } from "../../lib/project-db";
import { gitService } from "../../services/git-service";
import { narratorService } from "../../services/narrator-service";
import { importLegacyProjectOnWorker } from "../../services/project-archive/legacy-import-job";
import { exportLegacyProjectOnWorker } from "../../services/project-archive/legacy-sync-job";
import { __testing } from "../../services/project-db-sync";
import { projectRoutes } from "../projects";

const dirs: string[] = [];
const ids: string[] = [];
const userId = generateId();
const now = new Date().toISOString();
await db
	.insert(users)
	.values({ id: userId, username: userId, passwordHash: "fixture", role: "user", createdAt: now });
const actor = { userId, isAdmin: false };
const app = new Hono()
	.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	})
	.route("/projects", projectRoutes);
afterEach(async () => {
	for (const id of ids.splice(0)) projectDbManager.close(id);
	// This singleton is isolated by tests/preload.ts. Never target the real HOME database.
	sqlite.run("PRAGMA foreign_keys=OFF");
	for (const table of [
		"narrator_tool_calls",
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"chapters",
		"projects",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("PRAGMA foreign_keys=ON");
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function create(repoMode: "existing" | "clone") {
	const dir = await mkdtemp(join(tmpdir(), "nf-project-http-archive-"));
	dirs.push(dir);
	const gitPath = join(dir, "repo");
	await mkdir(gitPath);
	const repo = spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	const branch = spyOn(gitService, "getCurrentBranch").mockResolvedValue("main");
	const commit = spyOn(gitService, "commitGitignoreIfDirty").mockResolvedValue(undefined);
	const clone = spyOn(gitService, "cloneRepoStreaming").mockResolvedValue(undefined);
	try {
		const response = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "No root chapter",
				gitPath,
				repoMode,
				...(repoMode === "clone" ? { cloneUrl: "https://example.invalid/repo.git" } : {}),
			}),
		});
		let project: { id: string };
		if (repoMode === "clone") {
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).not.toContain("event: error");
			const complete = text.split("\n\n").find((event) => event.includes("event: complete"));
			const data = complete?.split("\n").find((line) => line.startsWith("data: "));
			if (!data) throw new Error("Clone SSE completion missing");
			project = JSON.parse(data.slice(6));
		} else {
			expect(response.status).toBe(201);
			project = await response.json();
		}
		ids.push(project.id);
		return { id: project.id, dir, gitPath };
	} finally {
		repo.mockRestore();
		branch.mockRestore();
		commit.mockRestore();
		clone.mockRestore();
	}
}
async function target(dir: string) {
	const fixture = getTestDb();
	const path = join(dir, "target.db");
	await writeFile(path, fixture.sqlite.serialize());
	fixture.sqlite.close();
	const connection = openDatabase(path);
	connection
		.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)")
		.run(userId, userId, "fixture", "user", now);
	return { path, connection };
}
for (const mode of ["existing", "clone"] as const) {
	test(`HTTP ${mode} creation without chapters writes a project row before completion; incremental archive imports independently`, async () => {
		const created = await create(mode);
		expect(sqlite.prepare("SELECT id FROM chapters WHERE project_id=?").all(created.id)).toEqual(
			[],
		);
		const archive = await projectDbManager.getDb(created.id);
		if (!archive) throw new Error("Project archive missing");
		expect(archive.prepare("SELECT id FROM projects").all()).toEqual([{ id: created.id }]);
		const narratorId = generateId(),
			messageId = generateId();
		await db.insert(narrators).values({
			id: narratorId,
			contextProjectId: created.id,
			ownerUserId: userId,
			cwd: "/totally-unrelated-cwd",
			createdAt: now,
			updatedAt: now,
		});
		sqlite
			.prepare(
				"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,?,?,?,?)",
			)
			.run(messageId, narratorId, "assistant", "[]", now);
		sqlite
			.prepare("INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES(?,?,?,?)")
			.run(generateId(), narratorId, messageId, 0);
		await __testing.runNarratorSync(narratorId);
		expect(archive.prepare("SELECT id FROM narrators").all()).toEqual([{ id: narratorId }]);
		projectDbManager.close(created.id);
		const { path, connection } = await target(created.dir);
		try {
			await importLegacyProjectOnWorker({
				backend: "sqlite",
				databasePath: path,
				archivePath: join(created.gitPath, ".narrafork", "project.db"),
				gitPath: "/restored",
				actor,
				deadline: Date.now() + 10000,
			});
			expect(connection.prepare("SELECT id FROM projects").all()).toEqual([{ id: created.id }]);
			expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			connection.close();
		}
	});
}

test("production createSubagent leaves contextProjectId null, but project worker includes its real transcript", async () => {
	const created = await create("existing");
	const rootId = generateId();
	await db.insert(narrators).values({
		id: rootId,
		contextProjectId: created.id,
		ownerUserId: userId,
		cwd: created.gitPath,
		createdAt: now,
		updatedAt: now,
	});
	const child = await narratorService.createSubagent({
		parentNarratorId: rootId,
		subagentType: "general",
		cwd: created.gitPath,
		title: "real contextless child",
	});
	expect(child.contextProjectId).toBeNull();
	expect(child.chapterId).toBeNull();
	const messageId = generateId();
	sqlite
		.prepare(
			"INSERT INTO narrator_messages(id,narrator_id,role,content_json,created_at) VALUES(?,?,?,?,?)",
		)
		.run(messageId, child.id, "assistant", "[]", now);
	sqlite
		.prepare("INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES(?,?,?,?)")
		.run(generateId(), child.id, messageId, 0);
	sqlite
		.prepare(
			"INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,tool_name,status,created_at) VALUES(?,?,?,?,?,?,?)",
		)
		.run(generateId(), child.id, messageId, "read", "Read", "success", now);
	projectDbManager.close(created.id);
	await exportLegacyProjectOnWorker({
		backend: "sqlite",
		databasePath: getDbPath(),
		archivePath: join(created.gitPath, ".narrafork", "project.db"),
		projectId: created.id,
		actor,
		deadline: Date.now() + 10000,
	});
	const archive = await projectDbManager.getDb(created.id);
	expect(archive?.prepare("SELECT id FROM narrators WHERE id=?").get(child.id)).toEqual({
		id: child.id,
	});
	expect(archive?.prepare("SELECT id FROM narrator_messages WHERE id=?").get(messageId)).toEqual({
		id: messageId,
	});
	const { path, connection } = await target(created.dir);
	try {
		await importLegacyProjectOnWorker({
			backend: "sqlite",
			databasePath: path,
			archivePath: join(created.gitPath, ".narrafork", "project.db"),
			gitPath: "/restored",
			actor,
			deadline: Date.now() + 10000,
		});
		expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		connection.close();
	}
	// No chapter was created by either HTTP or subagent creation.
	expect(await db.query.projects.findFirst({ where: eq(projects.id, created.id) })).toBeDefined();
	expect(sqlite.prepare("SELECT id FROM chapters").all()).toEqual([]);
});
