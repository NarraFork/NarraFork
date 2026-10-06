import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type {
	EditorDocumentDescriptor,
	EditorUploadDescriptor,
} from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { chapters, narrators, projects, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { commitEditorUploadSchema } from "../lib/validators/editor-documents";
import { EditorDocumentService } from "../services/editor-document-service";
import { LocalFileChangeRuntime } from "../services/file-change-runtime";
import { createEditorDocumentRoutes, readEditorMetadata } from "./editor-documents";

let root: string, path: string, narratorId: string, userId: string, tokenUser: string;
let app: Hono, service: EditorDocumentService;
beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(testEnvironment.isolatedHome, "editor-http-"));
	path = join(root, "test.txt");
	await writeFile(path, "original\r\n");
	userId = generateId();
	tokenUser = userId;
	narratorId = generateId();
	const now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			cwd: root,
			ownerUserId: userId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const runtime = new LocalFileChangeRuntime({ db, privateRoot: testEnvironment.narraforkHome });
	service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: (request) => runtime.executeEditor(request),
	});
	app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: tokenUser, role: "user", iat: 1, exp: 9999999999 });
		await next();
	});
	app.route(
		"/api/narrators",
		createEditorDocumentRoutes(() => service),
	);
	app.onError((error, c) =>
		c.json(
			{ error: error.message, code: error instanceof AppError ? error.code : "ERROR" },
			error instanceof AppError ? (error.statusCode as 400) : 500,
		),
	);
});
afterEach(async () => {
	await service.dispose();
	await rm(root, { recursive: true, force: true });
});
const base = () => `/api/narrators/${narratorId}/editor-documents`;
function request(url: string, method = "GET", body?: unknown) {
	return app.request(`http://localhost${url}`, {
		method,
		...(body === undefined
			? {}
			: {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
}
async function openDoc(origin = "legacy", deviceId = "local") {
	const response = await request(base(), "POST", { path, origin, deviceId });
	expect(response.status).toBe(200);
	return (await response.json()) as EditorDocumentDescriptor;
}
async function seal(doc: EditorDocumentDescriptor) {
	const response = await request(`${base()}/${doc.docId}/uploads`, "POST", {
		baseHash: doc.baseHash,
		encoding: doc.encoding,
		snapshotRevision: 123,
	});
	expect(response.status).toBe(200);
	const upload = (await response.json()) as EditorUploadDescriptor;
	const url = `${base()}/${doc.docId}/uploads/${upload.uploadId}`;
	const put = await app.request(`http://localhost${url}`, {
		method: "PUT",
		headers: { "content-type": "application/octet-stream" },
		body: "new\n",
	});
	expect(put.status).toBe(200);
	return { upload, url };
}
function bindChapter(
	options: { cwd?: string | null; worktreePath?: string | null; gitPath?: string } = {},
) {
	const projectId = generateId();
	const chapterId = generateId();
	const now = new Date().toISOString();
	db.insert(projects)
		.values({
			id: projectId,
			name: "Editor workspace",
			gitPath: options.gitPath ?? testEnvironment.isolatedHome,
			ownerUserId: userId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(chapters)
		.values({
			id: chapterId,
			projectId,
			title: "Editor chapter",
			branch: "main",
			baseBranch: "main",
			worktreePath: options.worktreePath === undefined ? root : options.worktreePath,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.update(narrators)
		.set({ chapterId, cwd: options.cwd ?? null })
		.where(eq(narrators.id, narratorId))
		.run();
	return { chapterId, projectId };
}

describe("editor HTTP identity, small metadata and policies", () => {
	test.each([
		"legacy",
		"reference",
	])("chapter without explicit cwd can open and save a relative %s source", async (origin) => {
		bindChapter();
		const response = await request(base(), "POST", {
			path: "test.txt",
			origin,
			deviceId: "local",
		});
		expect(response.status).toBe(200);
		const doc = (await response.json()) as EditorDocumentDescriptor;
		expect(doc.target.path).toBe(path);
		const { url } = await seal(doc);
		const saved = await request(`${url}/commit`, "POST", {});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ status: "saved" });
		expect(await readFile(path, "utf8")).toBe("new\r\n");
	});
	test("explicit narrator cwd takes precedence over the chapter worktree", async () => {
		bindChapter({ cwd: root, worktreePath: testEnvironment.isolatedHome });
		const response = await request(base(), "POST", {
			path: "test.txt",
			origin: "reference",
			deviceId: "local",
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as EditorDocumentDescriptor).target.path).toBe(path);
	});
	test.each([
		"dormant chapter",
		"standalone project",
	])("%s without cwd falls back to the project directory", async (kind) => {
		const { projectId } = bindChapter({ worktreePath: null, gitPath: root });
		if (kind === "standalone project") {
			db.update(narrators)
				.set({ chapterId: null, contextProjectId: projectId })
				.where(eq(narrators.id, narratorId))
				.run();
		}
		const response = await request(base(), "POST", {
			path: "test.txt",
			origin: "reference",
			deviceId: "local",
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as EditorDocumentDescriptor).target.path).toBe(path);
	});
	test("inherited worktree changes invalidate an opened document before commit", async () => {
		const { chapterId } = bindChapter();
		const doc = await openDoc();
		const { url } = await seal(doc);
		db.update(chapters)
			.set({ worktreePath: testEnvironment.isolatedHome })
			.where(eq(chapters.id, chapterId))
			.run();
		const response = await request(`${url}/commit`, "POST", {});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "EDITOR_IDENTITY_CHANGED" });
		expect(await readFile(path, "utf8")).toBe("original\r\n");
	});
	test("actual routes expose immutable content, read-only upload status and stable operation ID", async () => {
		const doc = await openDoc();
		const { upload, url } = await seal(doc);
		expect(upload.operationId).toBeString();
		expect(await (await request(url)).json()).toMatchObject({
			state: "sealed",
			operationId: upload.operationId,
		});
		const commit = await request(`${url}/commit`, "POST", {});
		expect(commit.status).toBe(200);
		expect(await commit.json()).toMatchObject({
			status: "saved",
			operationId: upload.operationId,
			snapshotRevision: 123,
		});
		expect(await (await request(url)).json()).toMatchObject({
			state: "settled",
			operationId: upload.operationId,
		});
		expect(
			await (await request(`${base()}/${doc.docId}/content?version=${doc.versionHandle}`)).text(),
		).toBe("original\n");
		expect(await readFile(path, "utf8")).toBe("new\r\n");
	});
	test("host narrator cannot substitute for bound source narrator, even with access to both", async () => {
		const doc = await openDoc();
		const other = generateId(),
			now = new Date().toISOString();
		db.insert(narrators)
			.values({ id: other, cwd: root, ownerUserId: userId, createdAt: now, updatedAt: now })
			.run();
		const response = await request(
			`/api/narrators/${other}/editor-documents/${doc.docId}/content?version=${doc.versionHandle}`,
		);
		expect(response.status).toBe(410);
	});
	test("ACL revocation and cwd changes are rechecked for existing sessions", async () => {
		const doc = await openDoc();
		const { url } = await seal(doc);
		tokenUser = "different-user";
		expect((await request(`${url}/commit`, "POST", {})).status).toBe(404);
		tokenUser = userId;
		db.update(narrators)
			.set({ cwd: testEnvironment.isolatedHome })
			.where(eq(narrators.id, narratorId))
			.run();
		expect((await request(`${url}/commit`, "POST", {})).status).toBe(403);
		expect(await readFile(path, "utf8")).toBe("original\r\n");
	});
	test("read visibility never grants write and remote never falls back to local", async () => {
		const doc = await openDoc();
		db.update(narrators)
			.set({ ownerUserId: null, visibility: "public" })
			.where(eq(narrators.id, narratorId))
			.run();
		expect(
			(
				await request(`${base()}/${doc.docId}/uploads`, "POST", {
					baseHash: doc.baseHash,
					encoding: doc.encoding,
					snapshotRevision: 1,
				})
			).status,
		).toBe(404);
		expect(
			(await request(base(), "POST", { path, origin: "legacy", deviceId: "remote-test" })).status,
		).toBe(422);
	});
	test("secret, git-internal, symlink and post-open symlink swaps are hard refusals", async () => {
		const original = path;
		for (const target of [
			join(testEnvironment.narraforkHome, "settings.json"),
			join(testEnvironment.narraforkHome, "editor-transfers", "ed-private.json"),
			join(root, ".git", "config"),
		]) {
			const response = await request(base(), "POST", {
				path: target,
				origin: "legacy",
				deviceId: "local",
			});
			expect(response.status).toBe(403);
		}
		const link = join(root, "link.txt");
		await symlink(original, link);
		expect(
			(await request(base(), "POST", { path: link, origin: "legacy", deviceId: "local" })).status,
		).toBe(403);
		const doc = await openDoc();
		const { url } = await seal(doc);
		await rm(path);
		await symlink(join(root, "other.txt"), path);
		expect((await request(`${url}/commit`, "POST", {})).status).toBe(403);
	});
	test("reference read policy remains enforced, legacy origin keeps its old broader read policy", async () => {
		const external = join(testEnvironment.isolatedHome, `outside-${generateId()}.txt`);
		await writeFile(external, "outside");
		try {
			expect(
				(await request(base(), "POST", { path: external, origin: "reference", deviceId: "local" }))
					.status,
			).toBe(403);
			expect(
				(await request(base(), "POST", { path: external, origin: "legacy", deviceId: "local" }))
					.status,
			).toBe(200);
			await openDoc("reference");
		} finally {
			await rm(external);
		}
	});
	test("metadata is capped without Content-Length; invalid JSON and unknown fields are rejected", async () => {
		const oversized = new Request("http://localhost", {
			method: "POST",
			body: new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(32769));
					c.close();
				},
			}),
		});
		await expect(readEditorMetadata(oversized, commitEditorUploadSchema)).rejects.toThrow("32 KiB");
		expect(
			(
				await request(base(), "POST", {
					path,
					origin: "legacy",
					deviceId: "local",
					hostNarratorId: "ignored",
				})
			).status,
		).toBe(400);
		const invalid = await app.request(`http://localhost${base()}`, { method: "POST", body: "{" });
		expect(invalid.status).toBe(400);
	});
});
