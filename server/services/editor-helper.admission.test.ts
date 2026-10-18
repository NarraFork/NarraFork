import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { createEditorDocumentRoutes } from "../routes/editor-documents";
import {
	executeAtomicEditorFileChange,
	queryEditorOperation,
	withEditorOperationStore,
} from "./editor-document-runtime";
import { EditorDocumentService } from "./editor-document-service";
import {
	EDITOR_HELPER_LIMITS,
	type EditorHelperResolver,
	EditorHelperSession,
	editorHelperDiagnostics,
} from "./editor-helper";
import { EditorRemoteOperationStore } from "./editor-remote-operation-store";

const binary = resolve(import.meta.dir, "../../.narrafork/editor-phase8-executor");
let root: string;
let resolver: EditorHelperResolver;
let sessions: EditorHelperSession[];
let controllers: AbortController[];
let pending: Promise<unknown>[];
const originalWaitMs = EDITOR_HELPER_LIMITS.waitMs;
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "helper-admission-"));
	await mkdir(join(root, "workspace"));
	const bytes = await readFile(binary);
	const artifact = {
		path: binary,
		filename: "fixture-executor",
		version: "0.9.2",
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	resolver = async () => artifact;
	sessions = [];
	controllers = [];
	pending = [];
});
afterEach(async () => {
	for (const controller of controllers) controller.abort();
	await Promise.allSettled(pending);
	await Promise.all(sessions.map((session) => session.close()));
	EDITOR_HELPER_LIMITS.waitMs = originalWaitMs;
	expect(editorHelperDiagnostics()).toMatchObject({ roots: 0, processes: 0, queued: 0 });
	await rm(root, { recursive: true, force: true });
});
async function open(signal?: AbortSignal) {
	const session = await EditorHelperSession.open(
		resolver,
		join(root, "workspace"),
		join(root, "native"),
		"admission-fixture",
		{ signal },
	);
	sessions.push(session);
	await session.capabilities();
	return session;
}
async function twoRoots() {
	const a = await open();
	const b = await open();
	expect(editorHelperDiagnostics()).toMatchObject({ roots: 2, processes: 2 });
	return [a, b] as const;
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Helper admission observation timed out");
		await Bun.sleep(2);
	}
}

test("real helpers: a bounded FIFO rejects overload, cancelled waiters never spawn, and nested H3 makes progress with both helper root slots occupied", async () => {
	const [a, b] = await twoRoots();
	for (let i = 0; i < EDITOR_HELPER_LIMITS.queue; i++) {
		const controller = new AbortController();
		controllers.push(controller);
		pending.push(
			open(controller.signal).then(
				() => "unexpected spawn",
				(error: Error) => error.name,
			),
		);
	}
	expect(editorHelperDiagnostics().queued).toBe(EDITOR_HELPER_LIMITS.queue);
	await expect(open()).rejects.toMatchObject({ code: "EDITOR_HELPER_BUSY", statusCode: 503 });
	const native = new EditorRemoteOperationStore(join(root, "receipts"), undefined, {
		root: join(root, "workspace"),
		stateDir: join(root, "native"),
		resolveHelper: resolver,
	});
	expect(
		await Promise.all([
			a.withMetadata(() => native.get("missing-a")),
			b.withMetadata(() => native.get("missing-b")),
		]),
	).toEqual([null, null]);
	expect(editorHelperDiagnostics()).toMatchObject({ roots: 2, processes: 2, peak: 4 });
	for (const controller of controllers) controller.abort();
	expect(await Promise.all(pending)).toEqual(Array(EDITOR_HELPER_LIMITS.queue).fill("AbortError"));
	expect(editorHelperDiagnostics()).toMatchObject({ queued: 0, processes: 2 });
});

test("real helpers: queue deadline fails boundedly without borrowing another process", async () => {
	await twoRoots();
	EDITOR_HELPER_LIMITS.waitMs = 20;
	await expect(open()).rejects.toMatchObject({ code: "EDITOR_HELPER_BUSY", statusCode: 503 });
	expect(editorHelperDiagnostics()).toMatchObject({ roots: 2, processes: 2, queued: 0 });
});

test("actual HTTP recovery disconnect cancels the native Host lookup before it can spawn", async () => {
	await twoRoots();
	const now = new Date().toISOString();
	const userId = randomUUID(),
		narratorId = randomUUID();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			ownerUserId: userId,
			cwd: join(root, "workspace"),
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const store = new EditorRemoteOperationStore(join(root, "receipts"), undefined, {
		root: join(root, "workspace"),
		stateDir: join(root, "native"),
		resolveHelper: resolver,
	});
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: executeAtomicEditorFileChange,
		queryOperation: queryEditorOperation,
	});
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 1, exp: 9999999999 });
		await next();
	});
	app.route(
		"/api/narrators",
		createEditorDocumentRoutes(() => service),
	);
	app.onError((error, c) =>
		c.json({ error: error.message }, error instanceof AppError ? (error.statusCode as 400) : 500),
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => withEditorOperationStore(store, () => app.fetch(req)),
	});
	const controller = new AbortController();
	controllers.push(controller);
	const response = fetch(
		`http://127.0.0.1:${server.port}/api/narrators/${narratorId}/editor-operations/${randomUUID()}`,
		{ signal: controller.signal },
	);
	const aborted = response.then(
		() => "unexpected response",
		(error: Error) => error.name,
	);
	pending.push(aborted);
	try {
		await until(() => editorHelperDiagnostics().queued === 1);
		controller.abort();
		expect(await aborted).toBe("AbortError");
		await until(() => editorHelperDiagnostics().queued === 0);
		expect(editorHelperDiagnostics()).toMatchObject({ roots: 2, processes: 2 });
	} finally {
		controller.abort();
		await server.stop(true);
		await service.dispose();
	}
});
