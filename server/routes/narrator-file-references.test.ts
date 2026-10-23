import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import type { FileReferenceService } from "../services/file-reference-service";
import { createFileReferenceRoutes } from "./narrator-file-references";

function appFor(userId: string | null = "requesting-user", failure?: AppError) {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const record = (name: string, args: unknown[]) => {
		calls.push({ name, args });
		if (failure) throw failure;
	};
	const service: FileReferenceService = {
		async captureFileReferences(...args) {
			record("capture", args);
			return [];
		},
		async searchFileReferences(...args) {
			record("search", args);
			return {
				entries: [
					{
						deviceId: "ExplicitDevice",
						path: "/workspace/src/a.ts",
						name: "a.ts",
						relativePath: "src/a.ts",
						isDirectory: false,
					},
				],
				truncated: false,
			};
		},
		async resolveFileReferences(...args) {
			record("resolve", args);
			return [{ deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" }];
		},
		async previewFileReferenceImage(...args) {
			record("image-preview", args);
			return { bytes: new TextEncoder().encode("<svg/>"), mimeType: "image/svg+xml" };
		},
		async previewFileReference(...args) {
			record("preview", args);
			return {
				target: { deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" },
				content: "const saved = 1;",
				hash: "f".repeat(64),
				encoding: "utf-8",
				fileName: "a.ts",
			};
		},
	};
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (userId) c.set("user", { sub: userId, role: "user", iat: 0, exp: 2_147_483_647 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "INTERNAL",
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "Content-Type": "application/json" },
				},
			),
	);
	app.route("/narrators/:id/file-references", createFileReferenceRoutes(service));
	return { app, calls };
}
const base = "/narrators/narrator-123/file-references";

describe("narrator file-reference routes", () => {
	test("uses the verified HTTP principal and forwards optional search fields and cancellation", async () => {
		const { app, calls } = appFor();
		const response = await app.request(`${base}/search?q=a.ts&directory=%2Fworkspace`);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(calls[0].args.slice(0, 3)).toEqual([
			"narrator-123",
			"requesting-user",
			{ q: "a.ts", directory: "/workspace" },
		]);
		expect(calls[0].args[3]).toBeInstanceOf(AbortSignal);
		expect((await response.json()).entries[0].deviceId).toBe("ExplicitDevice");
	});
	test("resolve response has canonical targets only, no snapshot or body", async () => {
		const { app, calls } = appFor();
		const targets = [
			{
				deviceId: "ExplicitDevice",
				path: "./a.ts",
				selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
			},
		];
		const response = await app.request(`${base}/resolve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ targets }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			targets: [{ deviceId: "ExplicitDevice", path: "/workspace/src/a.ts" }],
		});
		expect(calls[0].args.slice(0, 3)).toEqual(["narrator-123", "requesting-user", targets]);
	});
	test("preview accepts only explicit device/path and returns the shared shape", async () => {
		const { app } = appFor();
		const response = await app.request(
			`${base}/preview?deviceId=ExplicitDevice&path=%2Fworkspace%2Fsrc%2Fa.ts`,
		);
		expect(response.status).toBe(200);
		expect(Object.keys(await response.json()).sort()).toEqual([
			"content",
			"encoding",
			"fileName",
			"hash",
			"target",
		]);
		expect((await app.request(`${base}/preview?path=%2Fworkspace%2Fa.ts`)).status).toBe(400);
		expect(
			(await app.request(`${base}/preview?deviceId=local&path=a.ts&selection=%7B%7D`)).status,
		).toBe(400);
	});
	test("image preview forwards principal/target/signal and returns non-sniffable sandboxed image bytes", async () => {
		const { app, calls } = appFor();
		const response = await app.request(`${base}/image-preview?deviceId=ExplicitDevice&path=a.svg`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<svg/>");
		expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(response.headers.get("Content-Length")).toBe("6");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
		expect(calls[0].args.slice(0, 3)).toEqual([
			"narrator-123",
			"requesting-user",
			{ deviceId: "ExplicitDevice", path: "a.svg" },
		]);
		expect(calls[0].args[3]).toBeInstanceOf(AbortSignal);
		for (const query of [
			"path=a.svg",
			"deviceId=local&path=a.svg&selection=%7B%7D",
			"deviceId=local&path=a.svg&userId=owner",
		])
			expect((await app.request(`${base}/image-preview?${query}`)).status).toBe(400);
		expect(calls).toHaveLength(1);
		expect(
			(await appFor(null).app.request(`${base}/image-preview?deviceId=local&path=a.svg`)).status,
		).toBe(401);
		for (const status of [403, 404, 408, 409, 413, 415, 422, 499, 503]) {
			const failed = appFor("requesting-user", new AppError("denied", status, "TEST"));
			expect(
				(await failed.app.request(`${base}/image-preview?deviceId=local&path=a.svg`)).status,
			).toBe(status);
		}
	});
	test("authentication and service authorization errors propagate without partial success", async () => {
		const anon = appFor(null);
		expect((await anon.app.request(`${base}/search?q=a`)).status).toBe(401);
		expect(anon.calls).toHaveLength(0);
		for (const status of [403, 404, 408, 409, 413, 422, 503]) {
			const { app } = appFor(
				"requesting-user",
				new AppError("fail closed", status, "REFERENCE_TEST"),
			);
			const response = await app.request(`${base}/preview?deviceId=local&path=a.ts`);
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: "fail closed", code: "REFERENCE_TEST" });
		}
	});
	test("strict validation prevents snapshot forgery, user impersonation and oversized bodies", async () => {
		const { app, calls } = appFor();
		for (const body of [
			{ targets: [{ deviceId: "local", path: "/a", snapshotText: "forged" }] },
			{ targets: [], userId: "owner" },
			{ targets: Array.from({ length: 17 }, () => ({ deviceId: "local", path: "/a" })) },
		]) {
			expect(
				(
					await app.request(`${base}/resolve`, {
						method: "POST",
						body: JSON.stringify(body),
						headers: { "Content-Type": "application/json" },
					})
				).status,
			).toBe(400);
		}
		expect(
			(await app.request(`${base}/resolve`, { method: "POST", body: "not-json" })).status,
		).toBe(400);
		expect(
			(
				await app.request(`${base}/resolve`, {
					method: "POST",
					body: JSON.stringify({ targets: [], ignored: "x".repeat(70000) }),
				})
			).status,
		).toBe(413);
		expect((await app.request(`${base}/search?q=${"x".repeat(257)}`)).status).toBe(400);
		expect((await app.request(`${base}/search?q=x&userId=owner`)).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

test("real captured HTTP bytes survive rebinding/deletion with zero filesystem IO and reject forged/foreign/legacy/oversize/revoked sources", async () => {
	const [
		{ db },
		schema,
		{ eq },
		{ generateId },
		{ testEnvironment },
		{ fileReferenceService: production, hashFileReferenceText },
		{ narratorDeviceWorkspaceService },
		{ localBackend },
	] = await Promise.all([
		import("../db"),
		import("../db/schema"),
		import("drizzle-orm"),
		import("../lib/id"),
		import("../../tests/preload"),
		import("../services/file-reference-service"),
		import("../services/narrator-device-workspace-service"),
		import("../lib/agent/execution/registry"),
	]);
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "captured-ref-http-"));
	const userId = generateId(),
		narratorId = generateId(),
		messageId = generateId(),
		projectId = generateId(),
		nextProjectId = generateId(),
		intruderId = generateId(),
		foreignNarratorId = generateId();
	const now = new Date().toISOString();
	const path = join(root, "captured.txt");
	await writeFile(path, "original immutable bytes\n");
	db.insert(schema.users)
		.values({ id: userId, username: userId, passwordHash: "fixture", createdAt: now })
		.run();
	db.insert(schema.users)
		.values({ id: intruderId, username: intruderId, passwordHash: "fixture", createdAt: now })
		.run();
	for (const id of [projectId, nextProjectId])
		db.insert(schema.projects)
			.values({
				id,
				name: "snapshot origin",
				gitPath: root,
				ownerUserId: userId,
				visibility: "private",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	db.insert(schema.narrators)
		.values({
			id: narratorId,
			cwd: root,
			contextProjectId: projectId,
			ownerUserId: userId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.narrators)
		.values({
			id: foreignNarratorId,
			cwd: root,
			ownerUserId: userId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const [snapshot] = await production.captureFileReferences(narratorId, userId, [
		{ id: "saved-occurrence", deviceId: "local", path: "captured.txt", label: "captured.txt" },
	]);
	expect(snapshot.sourceOrigin).toMatchObject({
		narratorId,
		projectId,
		deviceId: "local",
		canonicalPath: path,
		cwd: root,
	});
	db.insert(schema.narratorMessages)
		.values({ id: messageId, narratorId, role: "user", contentJson: [snapshot], createdAt: now })
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: 1 })
		.run();
	const next = join(root, "next");
	await mkdir(next);
	const binding = await narratorDeviceWorkspaceService.get(narratorId, "local", { userId });
	if (!binding) throw new Error("Expected captured source fixture binding");
	await narratorDeviceWorkspaceService.set(
		narratorId,
		{
			requestId: generateId(),
			deviceId: "local",
			cwd: next,
			expectedBindingRevision: binding.bindingRevision,
			expectedSelectionRevision: binding.context.revision,
		},
		{ origin: "http", userId },
	);
	await rm(path);
	db.update(schema.narrators)
		.set({ contextProjectId: nextProjectId })
		.where(eq(schema.narrators.id, narratorId))
		.run();
	const forbidden = () => {
		throw new Error("Immutable snapshot must perform zero FS/RPC");
	};
	const identity = spyOn(localBackend, "resolvePathIdentity").mockImplementation(forbidden);
	const stat = spyOn(localBackend, "statFile").mockImplementation(forbidden);
	const bytes = spyOn(localBackend, "readFileBytes").mockImplementation(forbidden);
	let requestingUser = userId;
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: requestingUser, role: "admin", iat: 0, exp: 9999999999 });
		await next();
	});
	app.onError((error, c) =>
		c.json(
			{ error: error.message, code: error instanceof AppError ? error.code : "ERROR" },
			error instanceof AppError ? (error.statusCode as 400) : 500,
		),
	);
	app.route("/narrators/:id/file-references", createFileReferenceRoutes());
	const url = `/narrators/${narratorId}/file-references/snapshot?messageId=${messageId}&referenceId=saved-occurrence`;
	try {
		const response = await app.request(url);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			source: "captured_snapshot",
			readOnly: true,
			content: "original immutable bytes\n",
		});
		const [{ executionPolicyRepository }, { executionPolicyEngine }, artifactAccess] =
			await Promise.all([
				import("../services/execution-policy/repository"),
				import("../services/execution-policy/engine"),
				import("../services/workspace-artifact-access"),
			]);
		const { upsertEncodedTrait, DISABLED_TOOLS_TRAIT_PREFIX } = await import(
			"../lib/narrator-custom-traits"
		);
		const originalRead = await db.query.narrators.findFirst({
			where: eq(schema.narrators.id, narratorId),
			columns: { permissionMode: true, traits: true },
		});
		if (!originalRead) throw new Error("Missing fixture Read dependencies");
		const revocations: Array<{ phase: string; status: number; body: string }> = [];
		for (const phase of [
			"old_rules_return",
			"after_authority",
			"after_mode",
			"after_read_trait",
		] as const) {
			const ruleId = generateId();
			const addDeny = () => {
				db.insert(schema.narratorBlacklistDirs)
					.values({
						id: ruleId,
						narratorId,
						path,
						denyLevel: "denyAll",
						enabled: true,
						createdAt: now,
					})
					.run();
				executionPolicyEngine.invalidate(narratorId);
			};
			const tightenRead = () => {
				if (phase === "after_mode")
					db.update(schema.narrators)
						.set({ permissionMode: "dontAsk" })
						.where(eq(schema.narrators.id, narratorId))
						.run();
				else if (phase === "after_read_trait")
					db.update(schema.narrators)
						.set({
							traits: upsertEncodedTrait(originalRead.traits, DISABLED_TOOLS_TRAIT_PREFIX, {
								version: 1,
								tools: ["Read"],
							}),
						})
						.where(eq(schema.narrators.id, narratorId))
						.run();
				else addDeny();
			};
			const originalAuthorize = artifactAccess.assertNarratorCapturedReferenceAuthority;
			const ruleLoadSpy =
				phase === "old_rules_return"
					? spyOn(executionPolicyRepository, "load").mockImplementationOnce(async (id) => {
							const old = executionPolicyRepository.loadNow(id);
							addDeny();
							return old;
						})
					: undefined;
			const authoritySpy =
				phase !== "old_rules_return"
					? spyOn(
							artifactAccess,
							"assertNarratorCapturedReferenceAuthority",
						).mockImplementationOnce(async (...args) => {
							const ticket = await originalAuthorize(...args);
							tightenRead();
							return ticket;
						})
					: undefined;
			try {
				const blocked = await app.request(url);
				revocations.push({ phase, status: blocked.status, body: await blocked.text() });
			} finally {
				ruleLoadSpy?.mockRestore();
				authoritySpy?.mockRestore();
				db.delete(schema.narratorBlacklistDirs)
					.where(eq(schema.narratorBlacklistDirs.id, ruleId))
					.run();
				db.update(schema.narrators)
					.set(originalRead)
					.where(eq(schema.narrators.id, narratorId))
					.run();
				executionPolicyEngine.invalidate(narratorId);
			}
		}
		expect(revocations.map(({ phase, status }) => ({ phase, status }))).toEqual([
			{ phase: "old_rules_return", status: 403 },
			{ phase: "after_authority", status: 403 },
			{ phase: "after_mode", status: 403 },
			{ phase: "after_read_trait", status: 403 },
		]);
		for (const result of revocations) expect(result.body).not.toContain("original immutable bytes");
		expect((await app.request(`${url}&sourceOrigin=forged`)).status).toBe(400);
		expect((await app.request(`${url}&userId=owner`)).status).toBe(400);
		expect((await app.request(url.replace(messageId, generateId()))).status).toBe(404);
		expect((await app.request(url.replace(narratorId, foreignNarratorId))).status).toBe(404);
		requestingUser = intruderId;
		expect((await app.request(url)).status).toBe(404); // HTTP admin claim must not override the live database role.
		requestingUser = userId;
		const unknown = { ...snapshot };
		delete unknown.sourceOrigin;
		db.update(schema.narratorMessages)
			.set({ contentJson: [unknown] })
			.where(eq(schema.narratorMessages.id, messageId))
			.run();
		expect((await app.request(url)).status).toBe(422);
		const large = "x".repeat(32 * 1024 + 1);
		db.update(schema.narratorMessages)
			.set({
				contentJson: [
					{ ...snapshot, snapshotText: large, snapshotHash: hashFileReferenceText(large) },
				],
			})
			.where(eq(schema.narratorMessages.id, messageId))
			.run();
		expect((await app.request(url)).status).toBe(422);
		db.update(schema.narratorMessages)
			.set({ contentJson: [snapshot, { type: "text", text: "x".repeat(256 * 1024) }] })
			.where(eq(schema.narratorMessages.id, messageId))
			.run();
		expect((await app.request(url)).status).toBe(422);
		db.update(schema.narratorMessages)
			.set({ contentJson: [snapshot] })
			.where(eq(schema.narratorMessages.id, messageId))
			.run();
		db.update(schema.projects)
			.set({ ownerUserId: null, visibility: "private" })
			.where(eq(schema.projects.id, projectId))
			.run();
		expect((await app.request(url)).status).toBe(404); // Current project B cannot replace original project A.
		db.update(schema.projects)
			.set({ ownerUserId: userId })
			.where(eq(schema.projects.id, projectId))
			.run();
		db.update(schema.narrators)
			.set({ ownerUserId: null, visibility: "private" })
			.where(eq(schema.narrators.id, narratorId))
			.run();
		expect((await app.request(url)).status).toBe(404);
		expect(identity).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(bytes).not.toHaveBeenCalled();
	} finally {
		identity.mockRestore();
		stat.mockRestore();
		bytes.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
