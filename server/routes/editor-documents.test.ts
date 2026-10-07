import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type {
	EditorDocumentDescriptor,
	EditorUploadDescriptor,
} from "../../shared/editor-document";
import { FILE_PANEL_PAGE_BYTES, MAX_FILE_PANEL_BYTES } from "../../shared/file-reference";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { chapters, narrators, projects, users } from "../db/schema";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { narraforkDir } from "../lib/settings";
import { commitEditorUploadSchema } from "../lib/validators/editor-documents";
import { readLegacyFilePanel } from "../services/editor-document-panel";
import type { EditorActor } from "../services/editor-document-service";
import { EditorDocumentService } from "../services/editor-document-service";
import { LocalFileChangeRuntime } from "../services/file-change-runtime";
import { createEditorDocumentRoutes, readEditorMetadata } from "./editor-documents";
import { fsRoutes } from "./fs";
import { createFileReferenceRoutes } from "./narrator-file-references";

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
	app.route("/api/narrators/:id/file-references", createFileReferenceRoutes());
	app.route("/api/fs", fsRoutes);
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

describe("fs preview bounded panel reads", () => {
	test("ordinary symlinks retain preview access without relaxing editor/ref boundaries", async () => {
		const link = join(root, "ordinary-link.txt");
		await symlink(path, link);
		for (const endpoint of ["info", "page"]) {
			const query = `path=${encodeURIComponent(link)}&offset=0`;
			expect((await request(`${base()}/${endpoint}?${query}`)).status).toBe(403);
			const preview = await request(`/api/fs/panel-${endpoint}?${query}&deviceId=local`);
			expect(preview.status).toBe(200);
			expect(await preview.json()).toMatchObject({ target: { deviceId: "local", path }, size: 10 });
		}
		// Existing reference boundary is not replaced by broad filesystem preview authorization.
		db.update(narrators)
			.set({ cwd: join(root, "nested") })
			.where(eq(narrators.id, narratorId))
			.run();
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "nested"));
		expect(
			(
				await request(
					`/api/narrators/${narratorId}/file-references/info?deviceId=local&path=${encodeURIComponent(link)}`,
				)
			).status,
		).toBe(403);
	});
	test("lexical secret paths and canonical secret aliases are forbidden", async () => {
		const { mkdir } = await import("node:fs/promises");
		const secretRoot = join(narraforkDir, "editor-transfers", generateId());
		const secret = join(secretRoot, "private.txt");
		await mkdir(secretRoot, { recursive: true });
		await writeFile(secret, "private key");
		const alias = join(root, "secret-alias.txt");
		await symlink(secret, alias);
		for (const endpoint of ["panel-info", "panel-page"])
			for (const target of [secret, alias])
				expect(
					(await request(`/api/fs/${endpoint}?path=${encodeURIComponent(target)}&offset=0`)).status,
				).toBe(403);
	});
	test("preview metadata is stat-only and remote/over-limit pages are refused", async () => {
		const stat = spyOn(LocalBackend.prototype, "statFile").mockResolvedValue({
			isFile: true,
			isDirectory: false,
			resolvedPath: path,
			size: MAX_FILE_PANEL_BYTES + 1,
		});
		const read = spyOn(LocalBackend.prototype, "readFileBytes");
		try {
			const query = `path=${encodeURIComponent(path)}&offset=0`;
			const info = await request(`/api/fs/panel-info?${query}`);
			expect(info.status).toBe(200);
			expect(await info.json()).toMatchObject({ size: MAX_FILE_PANEL_BYTES + 1 });
			expect((await request(`/api/fs/panel-page?${query}`)).status).toBe(413);
			for (const endpoint of ["panel-info", "panel-page"])
				expect((await request(`/api/fs/${endpoint}?${query}&deviceId=remote`)).status).toBe(422);
			expect(read).not.toHaveBeenCalled();
		} finally {
			stat.mockRestore();
			read.mockRestore();
		}
	});
	test("symlink swaps after preview read invalidate the canonical binding", async () => {
		const link = join(root, "swap-link.txt");
		const other = join(root, "other.txt");
		await writeFile(other, "other");
		await symlink(path, link);
		const original = LocalBackend.prototype.readFileBytes;
		const read = spyOn(LocalBackend.prototype, "readFileBytes").mockImplementation(async function (
			this: LocalBackend,
			source,
			options,
		) {
			const result = await original.call(this, source, options);
			await rm(link);
			await symlink(other, link);
			return result;
		});
		try {
			expect(
				(await request(`/api/fs/panel-page?path=${encodeURIComponent(link)}&offset=0`)).status,
			).toBe(403);
		} finally {
			read.mockRestore();
		}
	});
});

describe("legacy bounded panel reads", () => {
	test("external legacy info/page preserve access while reference info/page deny it", async () => {
		db.update(narrators)
			.set({ cwd: join(root, "transfers") })
			.where(eq(narrators.id, narratorId))
			.run();
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, "transfers"), { recursive: true });
		for (const endpoint of ["info", "page"]) {
			const query = `path=${encodeURIComponent(path)}&offset=0`;
			const response = await request(`${base()}/${endpoint}?${query}`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				target: { deviceId: "local", path },
				size: 10,
			});
			const reference = await request(
				`/api/narrators/${narratorId}/file-references/${endpoint}?deviceId=local&path=${encodeURIComponent(path)}${endpoint === "page" ? "&offset=0" : ""}`,
			);
			expect(reference.status).toBe(403);
		}
	});
	test("legacy secret/symlink denial matches the original editor authorizer", async () => {
		const secret = join(root, ".git", "config");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(root, ".git"));
		const link = join(root, "link.txt");
		await writeFile(secret, "SECRET=1");
		await symlink(path, link);
		for (const denied of [secret, link]) {
			expect(
				(await request(base(), "POST", { path: denied, deviceId: "local", origin: "legacy" }))
					.status,
			).toBe(403);
			for (const endpoint of ["info", "page"])
				expect(
					(await request(`${base()}/${endpoint}?path=${encodeURIComponent(denied)}&offset=0`))
						.status,
				).toBe(403);
		}
	});
	test("GiB metadata never reads content; over-limit pages reject before IO", async () => {
		const stat = spyOn(LocalBackend.prototype, "statFile").mockResolvedValue({
			isFile: true,
			isDirectory: false,
			resolvedPath: path,
			size: MAX_FILE_PANEL_BYTES + 1,
		});
		const read = spyOn(LocalBackend.prototype, "readFileBytes");
		try {
			const info = await request(`${base()}/info?path=${encodeURIComponent(path)}`);
			expect(info.status).toBe(200);
			expect(await info.json()).toMatchObject({ size: MAX_FILE_PANEL_BYTES + 1 });
			expect(
				(await request(`${base()}/page?path=${encodeURIComponent(path)}&offset=0`)).status,
			).toBe(413);
			expect(read).not.toHaveBeenCalled();
		} finally {
			stat.mockRestore();
			read.mockRestore();
		}
	});
	test("pages use bounded lookback and aligned UTF8 next offsets", async () => {
		await writeFile(path, `${"a".repeat(FILE_PANEL_PAGE_BYTES - 1)}😀end`);
		const read = spyOn(LocalBackend.prototype, "readFileBytes");
		try {
			const response = await request(
				`${base()}/page?path=${encodeURIComponent(path)}&offset=${FILE_PANEL_PAGE_BYTES + 1}`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				offset: FILE_PANEL_PAGE_BYTES - 1,
				nextOffset: null,
				content: "😀end",
			});
			expect(read.mock.calls[0][1]).toMatchObject({
				offset: FILE_PANEL_PAGE_BYTES - 2,
				maxBytes: FILE_PANEL_PAGE_BYTES + 3,
				expectedResolvedPath: path,
			});
			expect(read.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
		} finally {
			read.mockRestore();
		}
	});
	test("authorization and cwd binding are rechecked after reading", async () => {
		const original = LocalBackend.prototype.readFileBytes;
		const read = spyOn(LocalBackend.prototype, "readFileBytes").mockImplementation(async function (
			this: LocalBackend,
			path,
			options,
		) {
			const result = await original.call(this, path, options);
			db.update(narrators)
				.set({ cwd: testEnvironment.isolatedHome })
				.where(eq(narrators.id, narratorId))
				.run();
			return result;
		});
		try {
			const response = await request(`${base()}/page?path=${encodeURIComponent(path)}&offset=0`);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "EDITOR_IDENTITY_CHANGED" });
		} finally {
			read.mockRestore();
		}
	});
	test("backend cannot exceed the byte budget or return changed canonical identity", async () => {
		const read = spyOn(LocalBackend.prototype, "readFileBytes");
		try {
			read.mockResolvedValue({
				bytes: new Uint8Array(FILE_PANEL_PAGE_BYTES + 1),
				totalSize: FILE_PANEL_PAGE_BYTES + 1,
				truncated: false,
				resolvedPath: path,
			});
			expect(
				(await request(`${base()}/page?path=${encodeURIComponent(path)}&offset=0`)).status,
			).toBe(422);
			read.mockResolvedValue({
				bytes: new Uint8Array(),
				totalSize: 0,
				truncated: false,
				resolvedPath: `${path}.changed`,
			});
			expect(
				(await request(`${base()}/page?path=${encodeURIComponent(path)}&offset=0`)).status,
			).toBe(409);
		} finally {
			read.mockRestore();
		}
	});
	test("legacy endpoints reject remote device requests and use local despite remote defaults", async () => {
		db.update(narrators)
			.set({ defaultDeviceId: "remote-device" })
			.where(eq(narrators.id, narratorId))
			.run();
		for (const endpoint of ["info", "page"]) {
			const url = `${base()}/${endpoint}?path=${encodeURIComponent(path)}&offset=0`;
			expect((await request(url)).status).toBe(200);
			expect((await request(`${url}&deviceId=remote-device`)).status).toBe(422);
		}
	});
	test("cancel and total deadline include authorizer waits", async () => {
		const actor: EditorActor = { userId, narratorId, authorize: async () => new Promise(() => {}) };
		const controller = new AbortController();
		controller.abort();
		await expect(
			readLegacyFilePanel(actor, path, undefined, controller.signal),
		).rejects.toMatchObject({ statusCode: 499 });
		await expect(
			readLegacyFilePanel(actor, path, undefined, undefined, new LocalBackend(), 10),
		).rejects.toMatchObject({ statusCode: 408 });
	});
});

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
