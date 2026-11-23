/** Real Hono routes and isolated DB/filesystem: no mocks of rollback strategies. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	fileChangeOperations,
	narratorBlacklistDirs,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "@server/db/schema";
import { localBackend } from "@server/lib/agent/execution/local-backend";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { settings } from "@server/lib/settings";
import { safeSpawn } from "@server/lib/spawn";
import { narratorRoutes } from "@server/routes/narrators";
import { executionPolicyEngine } from "@server/services/execution-policy/engine";
import * as fileChangeRuntime from "@server/services/file-change-runtime";
import * as fileStateRebuild from "@server/services/file-state-rebuild";
import * as scopedRevert from "@server/services/narrator-scoped-revert";
import { type ActiveNarrator, activeNarrators } from "@server/services/narrator-session-state";
import { treeSnapshotPhysicalDir } from "@server/services/tree-snapshot-paths";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { ZodError } from "zod";
import { blockIdAt } from "../../block-ids";

const ids: string[] = [];
const dirs: string[] = [];
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "test-admin", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.onError((error) =>
	Response.json(
		{ error: error.message, code: error instanceof AppError ? error.code : "VALIDATION_ERROR" },
		{
			status: error instanceof AppError ? error.statusCode : error instanceof ZodError ? 400 : 500,
		},
	),
);
app.route("/api/narrators", narratorRoutes);

async function fixture(
	capture: boolean,
	status: "success" | "fail" | "initializing" | "pending" | "running" = "success",
	recordOperation = false,
) {
	const repo = mkdtempSync(join(tmpdir(), "nf-route-revert-m0-"));
	dirs.push(repo);
	await safeSpawn({ cmd: ["git", "init"], cwd: repo, timeout: 15_000 });
	const narratorId = generateId();
	const messageId = generateId();
	const previewMessageId = generateId();
	const toolUseId = generateId();
	const now = new Date().toISOString();
	const file = join(repo, "a.txt");
	await db
		.insert(users)
		.values({
			id: "test-admin",
			username: "test-admin",
			passwordHash: "test",
			role: "admin",
			createdAt: now,
		})
		.onConflictDoNothing();
	await db.insert(narrators).values({ id: narratorId, cwd: repo, createdAt: now, updatedAt: now });
	ids.push(narratorId);
	// Rollback keeps the boundary turn and previews every subsequent tool operation.
	await db.insert(narratorMessages).values({
		id: previewMessageId,
		narratorId,
		role: "user",
		contentJson: [{ type: "text", text: "Update the file" }],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId: previewMessageId,
		seq: 0,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				name: "Write",
				id: toolUseId,
				input: { file_path: file, content: "AI\n" },
			},
		],
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({ id: generateId(), narratorId, messageId, seq: 1 });
	writeFileSync(file, "baseline\n");
	// Model existing legacy tree metadata without invoking the disabled capture service.
	const before = capture ? "a".repeat(40) : null;
	writeFileSync(file, "AI\n");
	const after = capture ? "b".repeat(40) : null;
	const toolCallId = generateId();
	const operationId = recordOperation ? generateId() : null;
	if (operationId) {
		await db.insert(fileChangeOperations).values({
			id: operationId,
			sourceInstanceId: "test-installation",
			sourceKind: "tool",
			sourceId: toolCallId,
			attempt: 1,
			narratorId,
			actorSubjectKey: `primary:${narratorId}`,
			actorJson: {
				kind: "primary",
				subjectKey: `primary:${narratorId}`,
				narratorId,
				userId: null,
				label: null,
				deleted: false,
				parentSubjectKey: null,
			},
			startedAt: now,
			updatedAt: now,
		});
	}
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		fileChangeOperationId: operationId,
		narratorId,
		messageId,
		toolUseId,
		toolName: "Write",
		inputJson: { file_path: file, content: "AI\n" },
		status,
		treeHashBefore: before,
		treeHashAfter: after,
		createdAt: now,
	});
	await db.insert(narratorFileSnapshots).values({
		id: generateId(),
		narratorId,
		deviceId: "local",
		filePath: file,
		originalContent: "baseline\n",
		createdAt: now,
	});
	writeFileSync(file, "USER SAVED AFTERWARDS\n");
	return { narratorId, messageId, previewMessageId, toolUseId, file, repo };
}

function request(id: string, endpoint: string, body: unknown = {}) {
	return app.request(`/api/narrators/${id}/${endpoint}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function assertUnavailable(response: Response) {
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "FILE_HISTORY_DISABLED" });
}

afterEach(async () => {
	for (const id of ids.splice(0)) {
		activeNarrators.delete(id);
		executionPolicyEngine.invalidate(id);
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(fileChangeOperations).where(eq(fileChangeOperations.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const dir of dirs.splice(0)) {
		rmSync(treeSnapshotPhysicalDir("local", dir), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("M0 rollback route safety", () => {
	test("narrator scope cannot fall back to replay when tree evidence is absent", async () => {
		const f = await fixture(false);
		await assertUnavailable(
			await request(f.narratorId, "revert", { messageId: f.messageId, scope: "narrator" }),
		);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
		expect(
			await db.query.narratorMessageRefs.findFirst({
				where: eq(narratorMessageRefs.messageId, f.messageId),
			}),
		).toBeTruthy();
	});

	test.each([
		true,
		false,
	])("explicit workspace scope rejects historical evidence (legacy tree metadata=%s)", async (capture) => {
		const f = await fixture(capture);
		expect(
			(await request(f.narratorId, "revert", { messageId: "__all__", scope: "workspace" })).status,
		).toBe(409);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test.each([
		"success",
		"fail",
	] as const)("unrevert without a durable journal cannot replay %s history", async (status) => {
		const f = await fixture(false, status);
		await assertUnavailable(await request(f.narratorId, "unrevert"));
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("retired file-panel routes are unavailable and cannot overwrite a user's save", async () => {
		const f = await fixture(false, "fail");
		for (const endpoint of [
			"file-modifications",
			"patches",
			"patches/retired-snapshot/diff",
			`delete-preview?messageId=${f.messageId}`,
		]) {
			const response = await app.request(`/api/narrators/${f.narratorId}/${endpoint}`);
			expect(response.status).toBe(404);
		}
		expect((await request(f.narratorId, "revert-file", { filePath: f.file })).status).toBe(404);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("local single-block file preview reports disabled before reading legacy history", async () => {
		const f = await fixture(true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.messageId, 0)}/delete-preview`,
		);
		await assertUnavailable(response);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test.each([
		"initializing",
		"pending",
		"running",
	] as const)("an orphaned %s tool reports missing completion evidence without changing its status", async (status) => {
		const f = await fixture(false, status);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.previewMessageId, 0)}/edit-preview`,
		);
		await assertUnavailable(response);
		await assertUnavailable(await request(f.narratorId, "revert", { messageId: f.messageId }));
		expect(
			await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.messageId, f.messageId),
				columns: { status: true },
			}),
		).toEqual({ status });
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("an unrelated live loop sharing the workspace cannot hide the legacy blocker", async () => {
		const f = await fixture(true);
		const other = await fixture(false);
		activeNarrators.set(other.narratorId, {
			cwd: f.repo,
			alive: true,
			_loopRunning: true,
		} as ActiveNarrator);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.previewMessageId, 0)}/edit-preview`,
		);
		await assertUnavailable(response);
		await assertUnavailable(await request(f.narratorId, "revert", { messageId: f.messageId }));
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("incomplete operation evidence still refuses mutation", async () => {
		const f = await fixture(false, "success", true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.previewMessageId, 0)}/edit-preview`,
		);
		await assertUnavailable(response);
		const refusal = await request(f.narratorId, "revert", { messageId: f.messageId });
		expect(refusal.status).toBe(409);
		const body = await refusal.json();
		expect(body.code).toBe("FILE_HISTORY_DISABLED");
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
		expect(
			await db.query.narratorMessageRefs.findFirst({
				where: eq(narratorMessageRefs.messageId, f.messageId),
				columns: { messageId: true },
			}),
		).toEqual({ messageId: f.messageId });
	});

	test("preview cannot advertise a legacy workspace snapshot as an available fallback", async () => {
		const f = await fixture(true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.previewMessageId, 0)}/edit-preview`,
		);
		await assertUnavailable(response);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});
});

describe("permission previews use the actual execution device", () => {
	async function freezeLocalTarget(
		f: Awaited<ReturnType<typeof fixture>>,
		lexicalPath = f.file,
		canonicalPath = f.file,
	) {
		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: "local",
				executionCwd: f.repo,
				executionPathFlavor: "posix",
				resolvedFilePath: lexicalPath,
				canonicalFilePath: canonicalPath,
				runtimeGeneration: 0,
				deviceSelectionSource: "explicit",
				inputJson: { file_path: lexicalPath, content: "AI\n" },
			})
			.where(eq(narratorToolCalls.messageId, f.messageId));
	}

	test("a secret lexical symlink cannot borrow its ordinary canonical target's Read permission", async () => {
		const f = await fixture(false, "pending");
		mkdirSync(join(f.repo, ".ssh"));
		const lexical = join(f.repo, ".ssh", "id_rsa");
		symlinkSync(f.file, lexical);
		await freezeLocalTarget(f, lexical);
		const read = spyOn(localBackend, "readFileBytes");
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(body.currentContent).toBeUndefined();
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});

	test("a cwd changed before preview cannot replace the frozen execution cwd", async () => {
		const f = await fixture(false, "pending");
		await freezeLocalTarget(f);
		const next = join(f.repo, "new-cwd");
		mkdirSync(next);
		await db
			.update(narrators)
			.set({ cwd: next, permissionMode: "bypassPermissions" })
			.where(eq(narrators.id, f.narratorId));
		const previousWritable = settings.paths.extraWritableDirs;
		settings.paths.extraWritableDirs = [...(previousWritable ?? []), f.repo];
		const read = spyOn(localBackend, "readFileBytes");
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			settings.paths.extraWritableDirs = previousWritable;
		}
	});

	test("a lexical symlink redirected after an authorized read cannot publish content", async () => {
		const f = await fixture(false, "pending");
		const lexical = join(f.repo, "file-link.txt");
		const redirected = join(f.repo, "redirected.txt");
		writeFileSync(redirected, "REDIRECTED PRIVATE BYTES\n");
		symlinkSync(f.file, lexical);
		await freezeLocalTarget(f, lexical);
		const original = localBackend.readFileBytes.bind(localBackend);
		const read = spyOn(localBackend, "readFileBytes").mockImplementation(async (...args) => {
			const result = await original(...args);
			unlinkSync(lexical);
			symlinkSync(redirected, lexical);
			return result;
		});
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(body.currentContent).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain("PRIVATE BYTES");
			expect(JSON.stringify(body)).not.toContain("USER SAVED AFTERWARDS");
			expect(read).toHaveBeenCalledTimes(1);
			expect(read.mock.calls[0]?.[0]).toBe(lexical);
		} finally {
			read.mockRestore();
		}
	});

	test("a legacy local call without frozen execution identity cannot preview bytes", async () => {
		const f = await fixture(false, "pending");
		const read = spyOn(localBackend, "readFileBytes");
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});

	test.each([
		"deny",
		"ask",
		"secret",
	] as const)("%s cannot read or disclose local permission-preview bytes", async (scenario) => {
		const f = await fixture(false, "pending");
		const extra = mkdtempSync(join(tmpdir(), "nf-preview-outside-"));
		dirs.push(extra);
		const path =
			scenario === "ask"
				? join(extra, "private.txt")
				: scenario === "secret"
					? join(f.repo, ".ssh", "id_rsa")
					: f.file;
		if (scenario === "secret") mkdirSync(join(f.repo, ".ssh"));
		writeFileSync(path, "DO NOT DISCLOSE THESE PRIVATE BYTES\n");
		const previousWritable = settings.paths.extraWritableDirs;
		settings.paths.extraWritableDirs = [...(previousWritable ?? []), extra];
		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: "local",
				executionCwd: f.repo,
				executionPathFlavor: "posix",
				resolvedFilePath: path,
				canonicalFilePath: path,
				runtimeGeneration: 0,
				deviceSelectionSource: "explicit",
				inputJson: { file_path: path, content: "AI\n" },
			})
			.where(eq(narratorToolCalls.messageId, f.messageId));
		if (scenario === "deny")
			await db.insert(narratorBlacklistDirs).values({
				id: generateId(),
				narratorId: f.narratorId,
				path: f.repo,
				denyLevel: "denyAll",
				enabled: true,
				targetKind: "host",
				createdAt: new Date().toISOString(),
			});
		executionPolicyEngine.invalidate(f.narratorId);
		const read = spyOn(localBackend, "readFileBytes");
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(body.currentContent).toBeUndefined();
			expect(body.previewContent).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain("PRIVATE BYTES");
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			settings.paths.extraWritableDirs = previousWritable;
		}
	});

	test("Read permission revoked during IO cannot publish the bytes", async () => {
		const f = await fixture(false, "pending");
		await freezeLocalTarget(f);
		const original = localBackend.readFileBytes.bind(localBackend);
		const read = spyOn(localBackend, "readFileBytes").mockImplementation(async (...args) => {
			const result = await original(...args);
			await db.insert(narratorBlacklistDirs).values({
				id: generateId(),
				narratorId: f.narratorId,
				path: f.repo,
				denyLevel: "denyAll",
				enabled: true,
				targetKind: "host",
				createdAt: new Date().toISOString(),
			});
			executionPolicyEngine.invalidate(f.narratorId);
			return result;
		});
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			const body = await response.json();
			expect(body).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(body.currentContent).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain("USER SAVED AFTERWARDS");
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			read.mockRestore();
		}
	});

	test("local Write previews current bytes while file history is unavailable", async () => {
		const f = await fixture(false, "pending");
		await db
			.update(narrators)
			.set({ defaultDeviceId: "remote-test" })
			.where(eq(narrators.id, f.narratorId));
		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: "local",
				executionCwd: f.repo,
				executionPathFlavor: "posix",
				resolvedFilePath: f.file,
				canonicalFilePath: f.file,
				deviceSelectionSource: "explicit",
				runtimeGeneration: 0,
			})
			.where(eq(narratorToolCalls.messageId, f.messageId));
		const history = spyOn(fileStateRebuild, "rebuildDeviceFileState").mockRejectedValue(
			new Error("history unavailable"),
		);
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}&device=remote-test`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				deviceId: "local",
				currentContent: "USER SAVED AFTERWARDS\n",
				previewContent: "AI\n",
			});
			expect(history).not.toHaveBeenCalled();
			expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
		} finally {
			history.mockRestore();
		}
	});

	test("oversized current local files report unavailable without falling back to history", async () => {
		const f = await fixture(false, "pending");
		await freezeLocalTarget(f);
		writeFileSync(f.file, "x".repeat(1024 * 1024 + 1));
		const history = spyOn(fileStateRebuild, "rebuildDeviceFileState").mockRejectedValue(
			new Error("history unavailable"),
		);
		try {
			const response = await app.request(
				`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "PERMISSION_FILE_PREVIEW_UNAVAILABLE" });
			expect(history).not.toHaveBeenCalled();
		} finally {
			history.mockRestore();
		}
	});

	test("remote permission preview retains its baseline and does not load local snapshots", async () => {
		const f = await fixture(false, "pending");
		await db
			.update(narratorToolCalls)
			.set({
				executionDeviceId: "remote-test",
				executionCwd: f.repo,
				executionPathFlavor: "posix",
				resolvedFilePath: f.file,
				canonicalFilePath: f.file,
				deviceSelectionSource: "explicit",
			})
			.where(eq(narratorToolCalls.messageId, f.messageId));
		await db
			.update(narratorFileSnapshots)
			.set({ filePath: "C:ambiguous-local-history" })
			.where(eq(narratorFileSnapshots.narratorId, f.narratorId));
		await db.insert(narratorFileSnapshots).values({
			id: generateId(),
			narratorId: f.narratorId,
			deviceId: "remote-test",
			filePath: f.file,
			originalContent: "remote baseline\n",
			createdAt: new Date().toISOString(),
		});
		const response = await app.request(
			`/api/narrators/${f.narratorId}/permission-file-preview?toolUseId=${f.toolUseId}`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			deviceId: "remote-test",
			currentContent: "remote baseline\n",
			previewContent: "AI\n",
		});
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});
});

describe("local message-only defaults", () => {
	for (const action of ["range", "rollback", "single", "multi"] as const) {
		test(`${action} keeps actual files and creates no file checkpoint without consulting a file plan`, async () => {
			const f = await fixture(false);
			const failHistory = async (): Promise<never> => {
				throw new Error("file history is unavailable");
			};
			const spies = [
				spyOn(fileChangeRuntime, "getDefaultLocalFileChangeRuntime").mockImplementation(
					failHistory,
				),
				spyOn(scopedRevert, "revertNarratorScopedForMessages").mockImplementation(failHistory),
				spyOn(scopedRevert, "revertNarratorScopedForToolUses").mockImplementation(failHistory),
				spyOn(scopedRevert, "revertNarratorScopedToBlock").mockImplementation(failHistory),
			];
			try {
				const boundary = await blockIdAt(f.previewMessageId, 0);
				const tool = await blockIdAt(f.messageId, 0);
				const response =
					action === "range"
						? await app.request(`/api/narrators/${f.narratorId}/messages/${f.messageId}`, {
								method: "DELETE",
							})
						: action === "rollback"
							? await request(f.narratorId, "blocks/rollback", { blockIds: [boundary] })
							: await app.request(`/api/narrators/${f.narratorId}/blocks`, {
									method: "DELETE",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										blockIds: action === "multi" ? [boundary, tool] : [tool],
									}),
								});
				expect(response.status, await response.text()).toBe(200);
				expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
				expect(
					await db.query.narratorMessageRefs.findFirst({
						where: eq(narratorMessageRefs.messageId, f.messageId),
					}),
				).toBeUndefined();
				expect(
					(
						await db.query.narratorToolCalls.findMany({
							where: eq(narratorToolCalls.narratorId, f.narratorId),
						})
					).filter((call) => call.isFileHistoryCheckpoint),
				).toHaveLength(0);
				for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		});
	}

	test.each([
		"explicit rollback",
		"legacy edit",
		"explicit edit",
		"confirmed rollback",
		"old prepare",
		"old apply",
	] as const)("%s refuses before interrupting or mutating messages and disk", async (action) => {
		const f = await fixture(false);
		const controller = new AbortController();
		activeNarrators.set(f.narratorId, {
			narratorId: f.narratorId,
			cwd: f.repo,
			alive: true,
			_loopRunning: true,
			abortController: controller,
		} as ActiveNarrator);
		const blockIds = [await blockIdAt(f.previewMessageId, 0)];
		const plan = { planId: generateId(), planHash: "a".repeat(64), action: "rollback_to_block" };
		const refsBefore = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, f.narratorId),
		});
		const response =
			action === "legacy edit" || action === "explicit edit"
				? await request(f.narratorId, `edit-and-regenerate/${f.previewMessageId}`, {
						content: "edited",
						...(action === "legacy edit" ? { rollback: true } : { skipRevert: false }),
					})
				: action === "old prepare"
					? await request(f.narratorId, "revert-plans", {})
					: action === "old apply"
						? await request(f.narratorId, `revert-plans/${plan.planId}/apply`, plan)
						: await request(f.narratorId, "blocks/rollback", {
								blockIds,
								...(action === "confirmed rollback" ? { revertPlan: plan } : { skipRevert: false }),
							});
		await assertUnavailable(response);
		expect(controller.signal.aborted).toBe(false);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
		expect(
			await db.query.narratorMessageRefs.findMany({
				where: eq(narratorMessageRefs.narratorId, f.narratorId),
			}),
		).toEqual(refsBefore);
	});

	test("remote default keeps the existing confirmation branch", async () => {
		const f = await fixture(false);
		await db
			.update(narrators)
			.set({ defaultDeviceId: "remote-test" })
			.where(eq(narrators.id, f.narratorId));
		const response = await request(f.narratorId, "blocks/rollback", {
			blockIds: [await blockIdAt(f.previewMessageId, 0)],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "REVERT_CONFIRMATION_REQUIRED" });
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test.each([
		"apply",
		"rollback",
		"edit",
		"skip with plan",
	] as const)("remote default cannot %s an old local plan before interrupting", async (action) => {
		const f = await fixture(false);
		await db
			.update(narrators)
			.set({ defaultDeviceId: "remote-test" })
			.where(eq(narrators.id, f.narratorId));
		const controller = new AbortController();
		activeNarrators.set(f.narratorId, {
			narratorId: f.narratorId,
			cwd: f.repo,
			alive: true,
			_loopRunning: true,
			abortController: controller,
		} as ActiveNarrator);
		const plan = { planId: generateId(), planHash: "a".repeat(64), action: "rollback_to_block" };
		const refsBefore = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, f.narratorId),
		});
		const response =
			action === "apply"
				? await request(f.narratorId, `revert-plans/${plan.planId}/apply`, {
						planHash: plan.planHash,
						action: plan.action,
					})
				: action === "edit"
					? await request(f.narratorId, `edit-and-regenerate/${f.previewMessageId}`, {
							content: "edited",
							revertPlan: { ...plan, action: "edit_and_regenerate" },
						})
					: await request(f.narratorId, "blocks/rollback", {
							blockIds: [await blockIdAt(f.previewMessageId, 0)],
							revertPlan: plan,
							...(action === "skip with plan" ? { skipRevert: true } : {}),
						});
		await assertUnavailable(response);
		expect(controller.signal.aborted).toBe(false);
		expect(
			await db.query.narratorMessageRefs.findMany({
				where: eq(narratorMessageRefs.narratorId, f.narratorId),
			}),
		).toEqual(refsBefore);
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});
});
