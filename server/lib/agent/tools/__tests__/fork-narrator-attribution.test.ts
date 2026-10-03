import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../../../tests/setup";
import { chapters, narrators, projects } from "../../../../db/schema";
import type { ToolContext } from "../../types";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("@server/db")) };
const realSession = { ...(await import("@server/services/narrator-session")) };
const realDepth = { ...(await import("../../fork-narrator-depth")) };
const sendCalls: unknown[][] = [];
mock.module("@server/db", () => ({ ...realDb, db, sqlite }));
mock.module("@server/services/narrator-session", () => ({
	...realSession,
	sendMessage: async (...args: unknown[]) => {
		sendCalls.push(args);
	},
}));
mock.module("../../fork-narrator-depth", () => ({ ...realDepth, resolveForkDepth: async () => 0 }));
const { narratorService } = await import("@server/services/narrator-service");
const { chapterFork } = await import("@server/services/chapter-fork");
const { forkNarratorTool } = await import("../fork-narrator");
const original = {
	getById: narratorService.getById,
	getLatestMessageUuid: narratorService.getLatestMessageUuid,
	forkNarrator: narratorService.forkNarrator,
	forkChapter: chapterFork.fork,
};
afterEach(() => {
	narratorService.getById = original.getById;
	narratorService.getLatestMessageUuid = original.getLatestMessageUuid;
	narratorService.forkNarrator = original.forkNarrator;
	chapterFork.fork = original.forkChapter;
	sendCalls.length = 0;
	cleanDb(sqlite);
});
afterAll(() => {
	mock.module("@server/db", () => realDb);
	mock.module("@server/services/narrator-session", () => realSession);
	mock.module("../../fork-narrator-depth", () => realDepth);
	mock.restore();
});
const ctx = { narratorId: "parent", userId: "caller-A", locale: "en" } as ToolContext;

describe("ordinary ForkNarrator", () => {
	for (const chapterId of [null, "chapter"]) {
		for (const inheritMode of ["fresh", "full", "compressed"] as const) {
			test(`${chapterId ?? "standalone"} ${inheritMode} retains model, actor and origin without resources`, async () => {
				const now = new Date().toISOString();
				if (chapterId) {
					await db.insert(projects).values({
						id: "project",
						name: "fixture",
						gitPath: "/fixture",
						createdAt: now,
						updatedAt: now,
					});
					await db.insert(chapters).values({
						id: chapterId,
						projectId: "project",
						title: "fixture",
						branch: "fixture",
						baseBranch: "main",
						createdAt: now,
						updatedAt: now,
					});
				}
				await db
					.insert(narrators)
					.values({ id: "parent", chapterId, createdAt: now, updatedAt: now });
				narratorService.getById = mock(
					async () => ({ id: "parent", chapterId, variant: "primary" }) as never,
				);
				narratorService.getLatestMessageUuid = mock(async () => "latest");
				const fork = mock(
					async (..._args: Parameters<typeof narratorService.forkNarrator>) =>
						({ id: "child", title: "child" }) as never,
				);
				narratorService.forkNarrator = fork;
				const resourceFork = mock(async () => {
					throw new Error("must not create resources");
				});
				chapterFork.fork = resourceFork;
				const result = await forkNarratorTool.execute(
					{
						mode: inheritMode === "fresh" ? "fresh" : "fork",
						inheritMode: inheritMode === "fresh" ? undefined : inheritMode,
						message: "continue",
						title: "child",
						model: "custom-model",
					},
					ctx,
				);
				expect(result.isError, String(result.output)).not.toBe(true);
				expect(fork.mock.calls[0]?.[2]).toMatchObject({
					userId: "caller-A",
					inheritMode,
					standalone: true,
					model: "custom-model",
					title: "child",
				});
				expect(resourceFork).not.toHaveBeenCalled();
				expect(await db.select().from(chapters)).toHaveLength(chapterId ? 1 : 0);
				expect(await db.select().from(projects)).toHaveLength(chapterId ? 1 : 0);
				expect(sendCalls[0]?.[6]).toBe("caller-A");
				expect(sendCalls[0]?.[9]).toMatchObject({ origin: "assistant" });
			});
		}
	}
	test.each([
		{ worktreeSource: "workspace" },
		{ worktreeSource: "commit" },
		{ commitSha: "abc" },
	])("deprecated resource args are explicitly rejected before effects: %j", async (deprecated) => {
		const get = mock(async () => {
			throw new Error("must not read parent");
		});
		narratorService.getById = get;
		const result = await forkNarratorTool.execute(
			{ mode: "fresh", message: "go", ...deprecated },
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Worktree");
		expect(get).not.toHaveBeenCalled();
		expect(sendCalls).toHaveLength(0);
	});
	test("schema omission does not inject deprecated defaults", () => {
		const parsed = forkNarratorTool.parameters.parse({ mode: "fresh", message: "go" });
		expect(parsed).not.toHaveProperty("worktreeSource");
		expect(parsed).not.toHaveProperty("commitSha");
	});
});
