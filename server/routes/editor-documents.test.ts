import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type {
	EditorDocumentDescriptor,
	EditorDraftAnchorDescriptor,
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
import { queryEditorOperation } from "../services/editor-document-runtime";
import type { EditorActor, EditorDocumentDependencies } from "../services/editor-document-service";
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
test("raw-v2 streams exact BOM bytes, has separate cache/hash domain and rejects all v1 writes", async () => {
	await writeFile(path, "\ufeffone\r\ntwo\rthree\n\ufeff");
	const v1 = await openDoc();
	const response = await request(base(), "POST", { path, origin: "legacy", protocol: "raw-v2" });
	expect(response.status).toBe(200);
	const raw =
		(await response.json()) as import("../../shared/editor-document").EditorRawDocumentDescriptor;
	expect(raw.protocol).toBe("raw-v2");
	expect(raw.hashKind).toBe("raw-sha256");
	expect(raw.resourceKey).not.toBe(v1.resourceKey);
	expect(raw.capabilities?.v1Save).toBe(false);
	const open = await request(`${base()}/${raw.docId}/raw-reads`, "POST", {
		versionHandle: raw.versionHandle,
	});
	expect(open.status).toBe(200);
	const { readId } = await open.json();
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (;;) {
		const chunk = await request(`${base()}/${raw.docId}/raw-reads/${readId}`, "POST", {
			offset,
			maxBytes: 3,
		});
		expect(chunk.status).toBe(200);
		const bytes = new Uint8Array(await chunk.arrayBuffer());
		chunks.push(bytes);
		offset += bytes.length;
		if (chunk.headers.get("x-editor-eof") === "1") break;
	}
	expect(Buffer.concat(chunks)).toEqual(await readFile(path));
	expect(service.streams.diagnostics.active).toBe(1);
	expect((await request(`${base()}/${raw.docId}/raw-reads/${readId}`, "DELETE")).status).toBe(204);
	expect(service.streams.diagnostics.active).toBe(0);
	const upload = await request(`${base()}/${raw.docId}/uploads`, "POST", {
		baseHash: raw.baseHash,
		encoding: raw.encoding,
		snapshotRevision: 1,
	});
	expect(upload.status).toBe(403);
	expect((await upload.json()).code).toBe("EDITOR_RAW_READ_ONLY");
	const disk = await request(`${base()}/${raw.docId}/disk-state`);
	expect((await disk.json()).hashKind).toBe("raw-sha256");
	await writeFile(path, "same ascii");
	const ascii = await request(base(), "POST", { path, origin: "legacy", protocol: "raw-v2" });
	const asciiDoc = await ascii.json();
	const old = await openDoc();
	expect(asciiDoc.baseHash).toBe(old.baseHash);
	expect(
		(
			await request(`${base()}/${asciiDoc.docId}/uploads`, "POST", {
				baseHash: old.baseHash,
				encoding: "utf-8",
				snapshotRevision: 1,
			})
		).status,
	).toBe(403);
});
test("raw-v2 rechecks publication authority and closes a revoked owner's active source", async () => {
	const response = await request(base(), "POST", { path, origin: "legacy", protocol: "raw-v2" });
	const raw = await response.json();
	const opened = await request(`${base()}/${raw.docId}/raw-reads`, "POST", {
		versionHandle: raw.versionHandle,
	});
	const { readId } = await opened.json();
	expect(service.streams.diagnostics.active).toBe(1);
	const other = generateId();
	db.insert(users)
		.values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	db.update(narrators).set({ ownerUserId: other }).where(eq(narrators.id, narratorId)).run();
	const chunk = await request(`${base()}/${raw.docId}/raw-reads/${readId}`, "POST", {
		offset: 0,
		maxBytes: 64,
	});
	expect(chunk.status).toBe(404);
	expect(service.streams.diagnostics.active).toBe(0);
});
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

async function anchorFor(
	doc: EditorDocumentDescriptor,
	writerId = "writer-a",
	modelLifetime = "model-a",
	revision = 3,
) {
	const response = await request(`${base()}/draft-anchors`, "POST", {
		origin: "reference",
		deviceId: "local",
		resourceKey: doc.resourceKey,
		writerId,
		modelLifetime,
		revision,
	});
	expect(response.status).toBe(200);
	const anchor = (await response.json()) as EditorDraftAnchorDescriptor;
	expect(
		(
			await request(`${base()}/draft-anchors/${anchor.anchorId}/publish`, "POST", {
				origin: "reference",
				deviceId: "local",
			})
		).status,
	).toBe(200);
	return anchor;
}
const anchorUrl = (id: string) => `${base()}/draft-anchors/${id}?origin=reference&deviceId=local`;
test("draft anchor discovery keeps actual narrator ACL and original owner even when the current file is missing", async () => {
	const doc = await openDoc("reference"),
		anchor = await anchorFor(doc);
	await rm(path);
	expect((await request(anchorUrl(anchor.anchorId))).status).toBe(200);
	expect(
		(await request(`${base()}/draft-anchors/${anchor.anchorId}?origin=legacy&deviceId=local`))
			.status,
	).toBe(404);
	const intruder = generateId();
	db.insert(users)
		.values({
			id: intruder,
			username: intruder,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	tokenUser = intruder;
	expect((await request(anchorUrl(anchor.anchorId))).status).toBeGreaterThanOrEqual(403);
	expect(
		(
			await request(`${base()}/draft-anchors/${anchor.anchorId}/claim`, "POST", {
				origin: "reference",
				deviceId: "local",
			})
		).status,
	).toBeGreaterThanOrEqual(403);
});
test("draft provenance persistence failure fails before file-change dispatch and preserves the original file", async () => {
	const doc = await openDoc("reference");
	await anchorFor(doc);
	const { url } = await seal(doc);
	const execute = spyOn(
		(service as unknown as { deps: EditorDocumentDependencies }).deps,
		"execute",
	);
	const failure = spyOn(service.draftAnchors, "persist").mockRejectedValue(
		new Error("fixture disk failure"),
	);
	try {
		const response = await request(`${url}/commit`, "POST", {
			draftWriterId: "writer-a",
			draftModelLifetime: "model-a",
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "EDITOR_DRAFT_PROVENANCE_UNAVAILABLE" });
		expect(execute).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("original\r\n");
	} finally {
		failure.mockRestore();
		execute.mockRestore();
	}
});
test("draft anchors and the same durable save receipt survive a real editor-service cold restart", async () => {
	const doc = await openDoc("reference"),
		a = await anchorFor(doc),
		b = await anchorFor(doc, "writer-b");
	const { url, upload } = await seal(doc);
	const response = await request(`${url}/commit`, "POST", {
		draftWriterId: "writer-a",
		draftModelLifetime: "model-a",
	});
	expect(response.status).toBe(200);
	const saved = await response.json();
	expect(saved.operationId).toBe(upload.operationId);
	await service.dispose();
	const runtime = new LocalFileChangeRuntime({ db, privateRoot: testEnvironment.narraforkHome });
	service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: (request) => runtime.executeEditor(request),
		queryOperation: queryEditorOperation,
	});
	const anchor = await (await request(anchorUrl(a.anchorId))).json();
	expect(anchor).toMatchObject({
		status: "query-first",
		operation: { operationId: saved.operationId, snapshotRevision: 123 },
	});
	expect(await (await request(anchorUrl(b.anchorId))).json()).toMatchObject({
		status: "no-dispatch",
	});
	const receipt = await request(
		`/api/narrators/${narratorId}/editor-operations/${saved.operationId}`,
	);
	expect(receipt.status).toBe(200);
	expect(await receipt.json()).toMatchObject({
		status: "saved",
		result: { operationId: saved.operationId, snapshotRevision: 123 },
	});
	expect(
		await (
			await request(`${base()}/draft-anchors/${a.anchorId}/claim`, "POST", {
				origin: "reference",
				deviceId: "local",
			})
		).json(),
	).toMatchObject({ status: "query-first", retired: false });
	expect(await readFile(path, "utf8")).toBe("new\r\n");
});
test("new ordinary coverage requires a matching terminal receipt, never just a saved-status hint", async () => {
	const doc = await openDoc("reference");
	await anchorFor(doc);
	const { url } = await seal(doc);
	const saved = await (
		await request(`${url}/commit`, "POST", {
			draftWriterId: "writer-a",
			draftModelLifetime: "model-a",
		})
	).json();
	const mismatch = spyOn(service, "operation").mockResolvedValue({
		operationId: saved.operationId,
		status: "saved",
		result: { ...saved, snapshotRevision: 124 },
	});
	try {
		expect((await anchorFor(doc, "writer-a", "model-a", 4)).status).toBe("query-first");
	} finally {
		mismatch.mockRestore();
	}
	expect((await anchorFor(doc, "writer-a", "model-a", 5)).status).toBe("no-dispatch");
});
test("explicit recovery claim rejects a late old writer lifetime but lets its newly opened editor save", async () => {
	const doc = await openDoc("reference"),
		anchor = await anchorFor(doc),
		old = await seal(doc);
	expect(
		await (
			await request(`${base()}/draft-anchors/${anchor.anchorId}/claim`, "POST", {
				origin: "reference",
				deviceId: "local",
			})
		).json(),
	).toMatchObject({ status: "no-dispatch", retired: true });
	const late = await request(`${old.url}/commit`, "POST", {
		draftWriterId: "writer-a",
		draftModelLifetime: "model-a",
	});
	expect(late.status).toBe(409);
	expect(await late.json()).toMatchObject({ code: "EDITOR_DRAFT_WRITER_RETIRED" });
	expect(await readFile(path, "utf8")).toBe("original\r\n");
	await anchorFor(doc, "writer-a", "model-new");
	const fresh = await seal(doc);
	expect(
		(
			await request(`${fresh.url}/commit`, "POST", {
				draftWriterId: "writer-a",
				draftModelLifetime: "model-new",
			})
		).status,
	).toBe(200);
});
test("resource keys distinguish origin and execution revision even when the absolute path and cwd are unchanged", async () => {
	const legacy = await openDoc("legacy");
	const repeated = await openDoc("legacy");
	const reference = await openDoc("reference");
	expect(legacy.resourceKey).toMatch(/^[a-f0-9]{64}$/);
	expect(repeated.resourceKey).toBe(legacy.resourceKey);
	expect(repeated.docId).not.toBe(legacy.docId);
	expect(reference.resourceKey).not.toBe(legacy.resourceKey);
	db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId)).run();
	const response = await request(
		`${base()}/${legacy.docId}/content?version=${legacy.versionHandle}`,
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: "EDITOR_IDENTITY_CHANGED" });
	const current = await openDoc("legacy");
	expect(current.resourceKey).not.toBe(legacy.resourceKey);
	expect(legacy.recoveryKey).toMatch(/^[a-f0-9]{64}$/);
	expect(current.recoveryKey).toBe(legacy.recoveryKey);
	expect(reference.recoveryKey).not.toBe(legacy.recoveryKey);
	expect(await readFile(path, "utf8")).toBe("original\r\n");
});

for (const failure of ["deleted", "path-denied"] as const)
	test(`independent recovery discovery authorizes only the original owner when current file create is ${failure}`, async () => {
		const doc = await openDoc("reference");
		const sealed = await seal(doc);
		const commit = await request(`${sealed.url}/commit`, "POST", {});
		expect(commit.status).toBe(200);
		const saved = await commit.json();
		if (failure === "deleted") await rm(path);
		else {
			const restricted = join(root, "restricted");
			await mkdir(restricted);
			db.update(narrators)
				.set({ cwd: restricted, workspaceRevision: 1 })
				.where(eq(narrators.id, narratorId))
				.run();
		}
		expect(
			(await request(base(), "POST", { path, origin: "reference", deviceId: "local" })).status,
		).toBeGreaterThanOrEqual(400);
		expect((await request(`${base()}/${doc.docId}`, "DELETE")).status).toBe(200);
		const endpoint = `${base()}/recovery-scope?origin=reference&deviceId=local`;
		const proof = await request(endpoint);
		expect(proof.status).toBe(200);
		expect(await proof.json()).toEqual({ recoveryKey: doc.recoveryKey });
		const receipt = await request(
			`/api/narrators/${narratorId}/editor-operations/${saved.operationId}`,
		);
		expect(receipt.status).toBe(200);
		expect(await receipt.json()).toMatchObject({ status: "saved" });
		const other = generateId();
		db.insert(users)
			.values({
				id: other,
				username: other,
				passwordHash: "x",
				role: "user",
				createdAt: new Date().toISOString(),
			})
			.run();
		db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId)).run();
		tokenUser = other;
		const foreign = await request(endpoint);
		expect(foreign.status).toBe(200);
		expect((await foreign.json()).recoveryKey).not.toBe(doc.recoveryKey);
		expect(
			(await request(`/api/narrators/${narratorId}/editor-operations/${saved.operationId}`)).status,
		).toBe(404);
		db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, narratorId)).run();
		const revoked = await request(endpoint);
		expect(revoked.status).toBe(404);
		expect(await revoked.json()).not.toHaveProperty("recoveryKey");
	});

test("independent recovery scope accepts no path, principal hint or unbounded device metadata", async () => {
	for (const query of [
		"deviceId=local",
		"origin=unknown",
		"origin=reference&path=%2Fsecret",
		"origin=reference&userId=forged",
		`origin=reference&deviceId=${"x".repeat(129)}`,
	])
		expect((await request(`${base()}/recovery-scope?${query}`)).status).toBe(400);
	const result = await request(`${base()}/recovery-scope?origin=legacy&deviceId=local`);
	expect(result.status).toBe(200);
	expect(result.headers.get("Cache-Control")).toBe("no-store");
	expect(Object.keys(await result.json())).toEqual(["recoveryKey"]);
});

test("old operation receipts remain explicitly queryable after a context switch, but require current ACL and original verified ownership", async () => {
	const doc = await openDoc();
	const sealed = await seal(doc);
	const committed = await request(`${sealed.url}/commit`, "POST", {});
	expect(committed.status).toBe(200);
	const saved = await committed.json();
	db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId)).run();
	const receiptUrl = `/api/narrators/${narratorId}/editor-operations/${saved.operationId}`;
	const receipt = await request(receiptUrl);
	expect(receipt.status).toBe(200);
	expect(await receipt.json()).toMatchObject({
		status: "saved",
		operationId: saved.operationId,
		result: { snapshotRevision: 123 },
	});
	const other = generateId();
	db.insert(users)
		.values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId)).run();
	tokenUser = other;
	expect((await request(receiptUrl)).status).toBe(404);
	db.update(narrators).set({ visibility: "private" }).where(eq(narrators.id, narratorId)).run();
	expect((await request(receiptUrl)).status).toBe(404);
});

test("receipt authorization is rechecked after a queued lookup before publishing saved metadata", async () => {
	const doc = await openDoc();
	const sealed = await seal(doc);
	const committed = await request(`${sealed.url}/commit`, "POST", {});
	const saved = await committed.json();
	const other = generateId();
	db.insert(users)
		.values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	let entered!: () => void;
	let resume!: () => void;
	const entering = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const resuming = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const operation = service.operation.bind(service);
	const lookup = spyOn(service, "operation").mockImplementation(async (...args) => {
		const receipt = await operation(...args);
		entered();
		await resuming;
		return receipt;
	});
	const pending = request(`/api/narrators/${narratorId}/editor-operations/${saved.operationId}`);
	try {
		await entering;
		db.update(narrators).set({ ownerUserId: other }).where(eq(narrators.id, narratorId)).run();
		resume();
		const response = await pending;
		expect(response.status).toBe(404);
		expect(await response.json()).not.toHaveProperty("result");
	} finally {
		resume();
		await pending;
		lookup.mockRestore();
	}
});

test("retired private upload metadata can prove non-application and release resources without restoring file access", async () => {
	const doc = await openDoc();
	const sealed = await seal(doc);
	db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId)).run();
	expect((await request(`${sealed.url}/commit`, "POST", {})).status).toBe(403);
	const status = await request(sealed.url);
	expect(status.status).toBe(200);
	expect(await status.json()).toMatchObject({ state: "sealed" });
	const cancelled = await request(sealed.url, "DELETE");
	expect(cancelled.status).toBe(200);
	expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
	expect(
		(await request(`${base()}/${doc.docId}/content?version=${doc.versionHandle}`)).status,
	).toBe(403);
	const other = generateId();
	db.insert(users)
		.values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId)).run();
	tokenUser = other;
	for (const [url, method] of [
		[sealed.url, "GET"],
		[sealed.url, "DELETE"],
		[`${base()}/${doc.docId}`, "DELETE"],
	])
		expect((await request(url, method)).status).toBe(410);
	tokenUser = userId;
	expect((await request(`${base()}/${doc.docId}`, "DELETE")).status).toBe(200);
	expect(await readFile(path, "utf8")).toBe("original\r\n");
});

test("replacing an execution root at the same path invalidates its old resource binding", async () => {
	const first = await openDoc();
	const previousRoot = `${root}-previous`;
	await rename(root, previousRoot);
	try {
		await mkdir(root);
		await writeFile(path, "original\r\n");
		const response = await request(
			`${base()}/${first.docId}/content?version=${first.versionHandle}`,
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "EDITOR_IDENTITY_CHANGED" });
		expect((await openDoc()).resourceKey).not.toBe(first.resourceKey);
	} finally {
		await rm(previousRoot, { recursive: true, force: true });
	}
});

test("the verified principal separates public narrator resources and cannot adopt another user's session", async () => {
	db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, narratorId)).run();
	const first = await openDoc();
	const other = generateId();
	db.insert(users)
		.values({
			id: other,
			username: other,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		})
		.run();
	tokenUser = other;
	const second = await openDoc();
	expect(second.resourceKey).not.toBe(first.resourceKey);
	expect(second.recoveryKey).not.toBe(first.recoveryKey);
	expect(
		(await request(`${base()}/${first.docId}/content?version=${first.versionHandle}`)).status,
	).toBe(410);
});

test("same physical file under two authorized narrators never shares a resource key", async () => {
	const first = await openDoc();
	const other = generateId();
	const now = new Date().toISOString();
	db.insert(narrators)
		.values({ id: other, cwd: root, ownerUserId: userId, createdAt: now, updatedAt: now })
		.run();
	const result = await request(`/api/narrators/${other}/editor-documents`, "POST", {
		path,
		origin: "legacy",
		deviceId: "local",
	});
	expect(result.status).toBe(200);
	expect((await result.json()).resourceKey).not.toBe(first.resourceKey);
});

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
	test.each([
		"editor-transfers",
		"editor-native",
		"editor-native-operations",
	])("lexical %s paths and canonical aliases are forbidden", async (directory) => {
		const { mkdir } = await import("node:fs/promises");
		const secretRoot = join(narraforkDir, directory, generateId());
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
	test("actual routes expose version-checked content, read-only upload status and stable operation ID", async () => {
		const doc = await openDoc();
		expect(
			await (await request(`${base()}/${doc.docId}/content?version=${doc.versionHandle}`)).text(),
		).toBe("original\n");
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
		const stale = await request(`${base()}/${doc.docId}/content?version=${doc.versionHandle}`);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "EDITOR_SOURCE_CHANGED" });
		expect(await readFile(path, "utf8")).toBe("new\r\n");
	});
	test("content rejects a same-length source change and a newly opened version reads it", async () => {
		const doc = await openDoc();
		await writeFile(path, "modified\r\n");
		const stale = await request(`${base()}/${doc.docId}/content?version=${doc.versionHandle}`);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ code: "EDITOR_SOURCE_CHANGED" });
		const fresh = await openDoc();
		const content = await request(
			`${base()}/${fresh.docId}/content?version=${fresh.versionHandle}`,
		);
		expect(content.status).toBe(200);
		expect(await content.text()).toBe("modified\n");
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
	test("disk-state returns bounded identity metadata, no body, and no new session", async () => {
		const doc = await openDoc();
		const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
		const before = sessions.size;
		const unchanged = await request(`${base()}/${doc.docId}/disk-state`);
		expect(unchanged.status).toBe(200);
		expect(unchanged.headers.get("cache-control")).toBe("no-store");
		const body = await unchanged.text();
		expect(body.length).toBeLessThan(512);
		expect(body).not.toContain("original");
		expect(JSON.parse(body)).toEqual({
			exists: true,
			baseHash: doc.baseHash,
			encoding: doc.encoding,
			eol: doc.eol,
			sourceBytes: doc.sourceBytes,
			utf8Bytes: doc.utf8Bytes,
		});
		await writeFile(path, "changed externally\n");
		const changed = (await (await request(`${base()}/${doc.docId}/disk-state`)).json()) as {
			baseHash: string;
		};
		expect(changed.baseHash).not.toBe(doc.baseHash);
		await rm(path);
		expect(await (await request(`${base()}/${doc.docId}/disk-state`)).json()).toEqual({
			exists: false,
		});
		expect(sessions.size).toBe(before);
	});
	test("disk-state rechecks ACL and cwd binding for an existing session", async () => {
		const doc = await openDoc();
		tokenUser = "different-user";
		expect((await request(`${base()}/${doc.docId}/disk-state`)).status).toBe(404);
		tokenUser = userId;
		db.update(narrators)
			.set({ cwd: testEnvironment.isolatedHome })
			.where(eq(narrators.id, narratorId))
			.run();
		expect((await request(`${base()}/${doc.docId}/disk-state`)).status).toBe(403);
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
			join(testEnvironment.narraforkHome, "editor-native", "receipt.op.json"),
			join(testEnvironment.narraforkHome, "editor-native-operations", "operation.json"),
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
