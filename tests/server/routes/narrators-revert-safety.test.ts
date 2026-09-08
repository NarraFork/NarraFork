/** Real Hono routes and isolated DB/filesystem: no mocks of rollback strategies. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "@server/db/schema";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { safeSpawn } from "@server/lib/spawn";
import { narratorRoutes } from "@server/routes/narrators";
import { worktreeTreeSnapshot } from "@server/services/worktree-tree-snapshot";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const ids: string[] = [];
const dirs: string[] = [];
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "test-admin", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.onError((error) =>
	Response.json(
		{ error: error.message },
		{ status: error instanceof AppError ? error.statusCode : 500 },
	),
);
app.route("/api/narrators", narratorRoutes);

async function fixture(capture: boolean, status: "success" | "fail" = "success") {
	const repo = mkdtempSync(join(tmpdir(), "nf-route-revert-m0-"));
	dirs.push(repo);
	await safeSpawn({ cmd: ["git", "init"], cwd: repo, timeout: 15_000 });
	const narratorId = generateId();
	const messageId = generateId();
	const toolUseId = generateId();
	const now = new Date().toISOString();
	const file = join(repo, "a.txt");
	await db.insert(narrators).values({ id: narratorId, cwd: repo, createdAt: now, updatedAt: now });
	ids.push(narratorId);
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
	await db.insert(narratorToolCalls).values({
		id: generateId(),
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
	return { narratorId, messageId, file, repo };
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
	expect(body.code).toBe("SNAPSHOT_REVERT_FAILED");
	expect(body.failures[0].code).toBe("REVERT_UNAVAILABLE");
}

afterEach(async () => {
	for (const id of ids.splice(0)) {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const dir of dirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir);
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
		await assertUnavailable(
			await request(f.narratorId, "revert", { messageId: "__all__", scope: "workspace" }),
		);
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

	test("single-file revert cannot overwrite a user's save from a first-touch baseline", async () => {
		const f = await fixture(false, "fail");
		await assertUnavailable(await request(f.narratorId, "revert-file", { filePath: f.file }));
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});

	test("preview cannot advertise a legacy workspace snapshot as an available fallback", async () => {
		const f = await fixture(true);
		const response = await app.request(
			`/api/narrators/${f.narratorId}/delete-preview?messageId=${f.messageId}`,
		);
		expect(response.status).toBe(200);
		const preview = await response.json();
		expect(preview.scope).toBe("narrator");
		expect(preview.narratorScope).toMatchObject({ available: false, reason: "legacy_unverified" });
		expect(preview.workspaceScope).toMatchObject({ available: false, reason: "legacy_unverified" });
		expect(readFileSync(f.file, "utf8")).toBe("USER SAVED AFTERWARDS\n");
	});
});
