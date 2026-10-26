import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { decodeBlockMessage } from "@frontend/lib/block-protocol";
import { messageBlocks, messageBody } from "@shared/narrator-blocks/message-blocks";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../../db/schema";
import { AppError } from "../../lib/errors";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite, activeDatabaseBackend: "sqlite" }));
const { narratorContext } = await import("../narrator-context");
const { narratorService } = await import("../narrator-service");
const { gitService } = await import("../git-service");
const { narratorRoutes } = await import("../../routes/narrators");
const { projectRoutes } = await import("../../routes/projects");
const spies: Array<{ mockRestore(): void }> = [];
const now = new Date().toISOString();

function appFor(userId = "owner") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: 2_147_483_647 });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "Content-Type": "application/json" },
			}),
	);
	app.route("/narrators", narratorRoutes);
	app.route("/projects", projectRoutes);
	return app;
}
function post(app: Hono, path: string, body: unknown = {}) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
function counts() {
	return { projects: sqlite.query("SELECT count(*) AS n FROM projects").get() };
}
/** The source session; `inProject` puts it in a project working in a subdirectory of it. */
async function source(inProject = true, extra: Partial<typeof narrators.$inferInsert> = {}) {
	if (inProject) {
		await db.insert(projects).values({
			id: "project",
			name: "fixture",
			gitPath: "/fixture-host",
			ownerUserId: "owner",
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
	}
	await db.insert(narrators).values({
		id: "source",
		contextProjectId: inProject ? "project" : null,
		cwd: inProject ? "/fixture-host/worktree" : null,
		traits: ["standalone"],
		ownerUserId: "owner",
		visibility: "private",
		writeAudience: "owner",
		permissionMode: "readOnly",
		defaultDeviceId: "local",
		model: "parent-model",
		createdAt: now,
		updatedAt: now,
		...extra,
	});
	await db.insert(narratorMessages).values({
		id: "message",
		narratorId: "source",
		role: "assistant",
		messageUuid: "source-uuid",
		contentJson: [{ type: "text", text: "fixture" }],
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: "ref", narratorId: "source", messageId: "message", seq: 1 });
}
beforeEach(async () => {
	cleanDb(sqlite);
	for (const id of ["owner", "reader"])
		await db
			.insert(users)
			.values({ id, username: id, passwordHash: "fixture", role: "user", createdAt: now });
	spies.push(spyOn(narratorContext, "generateContextSummary").mockResolvedValue("fixture summary"));
});
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("../../db", () => realDb);
});

describe("ordinary HTTP conversation forks", () => {
	test.each([
		"fresh",
		"full",
		"compressed",
	] as const)("project %s HTTP fork keeps model/restrictions/project with no new project", async (inheritMode) => {
		await source();
		const before = counts();
		const response = await post(appFor(), "/narrators/source/fork", {
			forkMessageId: "message",
			inheritMode,
			title: "ordinary child",
		});
		expect(response.status).toBe(201);
		const result = await response.json();
		const child = await narratorService.getById(result.id);
		expect(child).toMatchObject({
			contextProjectId: "project",
			model: "parent-model",
			permissionMode: "readOnly",
			defaultDeviceId: "local",
			cwd: "/fixture-host/worktree",
			title: "ordinary child",
		});
		expect(counts()).toEqual(before);
	});
	test("a public reader with only project/narrator read cannot fork", async () => {
		await source(true, { visibility: "public" });
		await db.insert(aclGrants).values({
			id: "project-read",
			scopeType: "project",
			scopeId: "project",
			principalType: "user",
			principalId: "reader",
			capability: "read",
			createdAt: now,
		});
		const before = counts();
		expect(
			(
				await post(appFor("reader"), "/narrators/source/fork", {
					forkMessageId: "message",
					inheritMode: "full",
				})
			).status,
		).toBe(404);
		expect(counts()).toEqual(before);
		expect(await db.select().from(narrators)).toHaveLength(1);
	});
	test("subagent sources remain restricted", async () => {
		await source(false);
		await db.insert(narrators).values({
			id: "subagent",
			type: "subagent",
			variant: "subagent:review",
			subagentType: "review",
			parentNarratorId: "source",
			aclRootNarratorId: "source",
			ownerUserId: "owner",
			createdAt: now,
			updatedAt: now,
		});
		expect(
			(await post(appFor(), "/narrators/subagent/fork", { forkMessageId: "message" })).status,
		).toBe(400);
		expect(await db.select().from(narrators)).toHaveLength(2);
	});
	test.each([
		false,
		true,
	])("ask-in-passing inProject=%s promote returns narrator route identity without widening", async (inProject) => {
		await source(inProject, { traits: ["standalone", "ask-in-passing"], isAskInPassing: true });
		const before = counts();
		const response = await post(appFor(), "/narrators/source/promote");
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(typeof result.narratorId).toBe("string");
		expect(result).not.toHaveProperty("chapter");
		const child = await narratorService.getById(result.narratorId);
		expect(child.contextProjectId).toBe(inProject ? "project" : null);
		expect(child.permissionMode).toBe("readOnly");
		expect(child.isAskInPassing).toBe(false);
		expect(counts()).toEqual(before);
	});
});

describe("ask-in-passing answers in the block protocol", () => {
	test("start sends the pending message as envelopes and blocks the client decodes", async () => {
		await source(false);
		const response = await post(appFor(), "/narrators/source/ask-in-passing/start", {
			sourceMessageId: "message",
		});
		expect(response.status).toBe(201);
		const result = await response.json();
		const [envelope] = result.message.messages;
		expect(result.message.messages).toHaveLength(1);
		expect(envelope).toMatchObject({ id: result.messageId, seq: 2, parentMessageId: null });
		expect(envelope).not.toHaveProperty("contentJson");
		expect(typeof envelope.askInsertVersion).toBe("number");
		const { message } = decodeBlockMessage(result);
		if (!message) throw new Error("expected the pending message");
		expect(messageBody(message)).toEqual([
			expect.objectContaining({
				type: "ask_in_passing",
				status: "pending",
				sourceMessageId: "message",
			}),
		]);
		expect(messageBlocks(message).every((block) => block.named)).toBe(true);
	});
});

describe("project creation creates context only, no sessions", () => {
	function isolateProjectFilesystem() {
		spies.push(spyOn(gitService, "isGitRepo").mockResolvedValue(true));
		spies.push(spyOn(gitService, "getCurrentBranch").mockResolvedValue("main"));
		spies.push(spyOn(gitService, "cloneRepoStreaming").mockResolvedValue(undefined));
	}
	test("ordinary project POST creates context only", async () => {
		isolateProjectFilesystem();
		const response = await post(appFor(), "/projects", {
			name: "fixture",
			repoMode: "existing",
			gitPath: "/fixture-never-written",
		});
		expect(response.status).toBe(201);
		expect(await db.select().from(projects)).toHaveLength(1);
		expect(await db.select().from(narrators)).toHaveLength(0);
	});
	test("clone SSE completion creates context only without real network/filesystem", async () => {
		isolateProjectFilesystem();
		const response = await post(appFor(), "/projects", {
			name: "fixture",
			repoMode: "clone",
			gitPath: "/fixture-never-written",
			cloneUrl: "https://fixture.invalid/repo.git",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("event: complete");
		expect(await db.select().from(projects)).toHaveLength(1);
		expect(await db.select().from(narrators)).toHaveLength(0);
	});
});
