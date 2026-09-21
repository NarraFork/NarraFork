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
	create: narratorService.create,
	getLatestMessageUuid: narratorService.getLatestMessageUuid,
	forkNarrator: narratorService.forkNarrator,
	forkChapter: chapterFork.fork,
};

afterEach(() => {
	narratorService.getById = original.getById;
	narratorService.create = original.create;
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

describe("ForkNarrator attribution", () => {
	test.each([
		"fresh",
		"fork",
	] as const)("standalone %s keeps caller identity and assistant origin", async (mode) => {
		const parent = { id: "parent", chapterId: null, variant: "primary", ownerUserId: "owner-B" };
		narratorService.getById = mock(async () => parent as never);
		narratorService.getLatestMessageUuid = mock(async () => null);
		narratorService.create = mock(async () => ({ id: "child", title: "child" }) as never);
		const fork = mock(
			async (..._args: Parameters<typeof narratorService.forkNarrator>) =>
				({ id: "child", title: "child" }) as never,
		);
		narratorService.forkNarrator = fork;
		const result = await forkNarratorTool.execute(
			{ mode, message: "continue", inheritMode: "compressed" },
			{
				narratorId: "parent",
				userId: "caller-A",
				locale: "en",
			} as ToolContext,
		);
		expect(result.isError).not.toBe(true);
		if (mode === "fork")
			expect(fork.mock.calls[0]?.[2]).toMatchObject({
				userId: "caller-A",
				inheritMode: "compressed",
			});
		expect(sendCalls[0]?.[6]).toBe("caller-A");
		expect(sendCalls[0]?.[9]).toMatchObject({ origin: "assistant" });
	});

	test("chapter compressed fork passes the caller to its summary and initial message", async () => {
		narratorService.getById = mock(
			async () => ({ id: "parent", chapterId: "chapter", variant: "primary" }) as never,
		);
		narratorService.getLatestMessageUuid = mock(async () => null);
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: "project",
			name: "test",
			gitPath: "/tmp/test",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(chapters).values({
			id: "new-chapter",
			title: "child chapter",
			projectId: "project",
			branch: "branch",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: "child",
			chapterId: "new-chapter",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		});
		const fork = mock(
			async (..._args: Parameters<typeof chapterFork.fork>) =>
				({ id: "new-chapter", title: "child chapter" }) as never,
		);
		chapterFork.fork = fork;
		const result = await forkNarratorTool.execute(
			{ mode: "fork", message: "continue", inheritMode: "compressed" },
			{
				narratorId: "parent",
				userId: "caller-A",
				locale: "en",
			} as ToolContext,
		);
		expect(result.isError).not.toBe(true);
		expect(fork.mock.calls[0]?.[1]).toMatchObject({
			userId: "caller-A",
			inheritMode: "compressed",
		});
		expect(sendCalls[0]?.[6]).toBe("caller-A");
		expect(sendCalls[0]?.[9]).toMatchObject({ origin: "assistant" });
	});
});
