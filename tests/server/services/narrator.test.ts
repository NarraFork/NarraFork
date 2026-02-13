import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	repositories,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedProject() {
	db.insert(projects).values({ id: "p1", name: "Proj", createdAt: now, updatedAt: now }).run();
	db.insert(repositories)
		.values({
			id: "r1",
			projectId: "p1",
			path: "/tmp/repo",
			displayName: "repo",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			repositoryId: "r1",
			title: "Chapter 1",
			branch: "meanwhile/ch1-abc",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

describe("narrator CRUD", () => {
	it("can create a narrator bound to a chapter", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n1",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const result = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(result).toBeDefined();
		expect(result!.chapterId).toBe("ch1");
		expect(result!.type).toBe("primary");
		expect(result!.status).toBe("idle");
		expect(result!.model).toBe("sonnet");
	});

	it("can create a standalone narrator (null chapterId)", async () => {
		db.insert(narrators)
			.values({
				id: "n-standalone",
				chapterId: null,
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const result = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n-standalone"),
		});
		expect(result!.chapterId).toBeNull();
	});

	it("can list narrators by chapter", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n1",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(narrators)
			.values({
				id: "n2",
				chapterId: "ch1",
				type: "secondary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const results = await db.query.narrators.findMany({
			where: eq(narrators.chapterId, "ch1"),
		});
		expect(results).toHaveLength(2);
	});
});

describe("narrator messages", () => {
	it("can persist a user message", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n1",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(narratorMessages)
			.values({
				id: "msg1",
				narratorId: "n1",
				role: "user",
				contentJson: JSON.stringify([{ type: "text", text: "Hello" }]),
				contentText: "Hello",
				createdAt: now,
			})
			.run();

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "msg1"),
		});
		expect(msg!.role).toBe("user");
		expect(msg!.contentText).toBe("Hello");
	});

	it("can persist assistant message with tool calls", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n1",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(narratorMessages)
			.values({
				id: "msg-a1",
				narratorId: "n1",
				sdkMessageUuid: "uuid-123",
				role: "assistant",
				contentJson: JSON.stringify([
					{ type: "text", text: "Let me check" },
					{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/foo" } },
				]),
				contentText: "Let me check",
				tokensIn: 100,
				tokensOut: 50,
				createdAt: now,
			})
			.run();

		db.insert(narratorToolCalls)
			.values({
				id: "tc1",
				narratorId: "n1",
				messageId: "msg-a1",
				toolUseId: "tu1",
				toolName: "Read",
				inputJson: JSON.stringify({ path: "/foo" }),
				status: "running",
				createdAt: now,
			})
			.run();

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "msg-a1"),
			with: { toolCalls: true },
		});
		expect(msg!.tokensIn).toBe(100);
		expect(msg!.toolCalls).toHaveLength(1);
		expect(msg!.toolCalls[0].toolName).toBe("Read");
	});
});

describe("narrator cascade delete", () => {
	it("deleting narrator messages and tool calls in order works", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n1",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(narratorMessages)
			.values({
				id: "msg1",
				narratorId: "n1",
				role: "user",
				contentJson: "[]",
				createdAt: now,
			})
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "tc1",
				narratorId: "n1",
				messageId: "msg1",
				toolUseId: "tu1",
				toolName: "Bash",
				status: "completed",
				createdAt: now,
			})
			.run();

		// Delete in dependency order (same as narratorService.remove)
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n1")).run();
		db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n1")).run();
		db.delete(narrators).where(eq(narrators.id, "n1")).run();

		const remaining = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(remaining).toBeUndefined();
	});
});
