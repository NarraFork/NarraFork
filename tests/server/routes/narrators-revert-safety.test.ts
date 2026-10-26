/** Real Hono routes and isolated DB/filesystem: no mocks of rollback strategies. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	fileChangeOperations,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "@server/db/schema";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { safeSpawn } from "@server/lib/spawn";
import { narratorRoutes } from "@server/routes/narrators";
import { type ActiveNarrator, activeNarrators } from "@server/services/narrator-session-state";
import { treeSnapshotPhysicalDir } from "@server/services/tree-snapshot-paths";
import { worktreeTreeSnapshot } from "@server/services/worktree-tree-snapshot";
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
	const before = capture ? await worktreeTreeSnapshot.capture(repo) : null;
	writeFileSync(file, "AI\n");
	const after = capture ? await worktreeTreeSnapshot.capture(repo) : null;
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
	return { narratorId, messageId, previewMessageId, file, repo };
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
	const body = await response.json();
	if (body.code === "SNAPSHOT_REVERT_FAILED") {
		expect(body.files[0]).toMatchObject({ status: "not_attempted" });
		expect(body.historyCommitted).toBe(false);
	} else {
		expect(body.code).toBe("REVERT_CONFIRMATION_REQUIRED");
	}
}

afterEach(async () => {
	for (const id of ids.splice(0)) {
		activeNarrators.delete(id);
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
	])("explicit workspace scope rejects historical evidence (tree exists=%s)", async (capture) => {
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

	test("single-block preview remains available without advertising unsafe legacy rollback", async () => {
		const f = await fixture(true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.messageId, 0)}/delete-preview`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			available: false,
			reason: "incomplete_coverage",
		});
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
		expect(response.status).toBe(200);
		expect((await response.json()).narratorScope).toMatchObject({
			available: false,
			reason: "incomplete_coverage",
		});
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
		expect(response.status).toBe(200);
		expect((await response.json()).narratorScope).toMatchObject({
			available: false,
			reason: "incomplete_coverage",
		});
		await assertUnavailable(await request(f.narratorId, "revert", { messageId: f.messageId }));
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("incomplete operation evidence still refuses mutation", async () => {
		const f = await fixture(false, "success", true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/blocks/${await blockIdAt(f.previewMessageId, 0)}/edit-preview`,
		);
		expect(response.status).toBe(200);
		expect((await response.json()).narratorScope).toMatchObject({
			available: false,
			reason: "incomplete_coverage",
			files: [],
		});
		const refusal = await request(f.narratorId, "revert", { messageId: f.messageId });
		expect(refusal.status).toBe(409);
		const body = await refusal.json();
		expect(body.code).toBe("REVERT_CONFIRMATION_REQUIRED");
		expect(body.error).toContain("plan ID and hash");
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
		expect(response.status).toBe(200);
		const preview = await response.json();
		expect(preview.scope).toBe("narrator");
		expect(preview.narratorScope).toMatchObject({
			available: false,
			reason: "incomplete_coverage",
		});
		expect(preview.workspaceScope).toMatchObject({ available: false, reason: "legacy_unverified" });
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});
});
