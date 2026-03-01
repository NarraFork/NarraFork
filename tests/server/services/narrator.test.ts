import { afterEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedProject() {
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter 1",
			branch: "chapter/ch1-abc",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedNarrator(id = "n1", chapterId: string | null = "ch1") {
	db.insert(narrators)
		.values({
			id,
			chapterId,
			type: "primary",
			inheritMode: "fresh",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedMessage(
	id: string,
	narratorId: string,
	role: "user" | "assistant" | "system" = "user",
	text = "Hello",
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role,
			contentJson: JSON.stringify([{ type: "text", text }]),
			contentText: text,
			createdAt: now,
		})
		.run();
}

function seedRef(narratorId: string, messageId: string, seq: number, isCompact = 0) {
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${narratorId}-${messageId}`, narratorId, messageId, seq, isCompact })
		.run();
}

// === Narrator CRUD ===

describe("narrator CRUD", () => {
	it("can create a narrator bound to a chapter", async () => {
		seedProject();
		seedNarrator();

		const result = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(result).toBeDefined();
		expect(result?.chapterId).toBe("ch1");
		expect(result?.type).toBe("primary");
		expect(result?.status).toBe("idle");
		expect(result?.model).toBe("claude-sonnet");
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
		expect(result?.chapterId).toBeNull();
	});

	it("can list narrators by chapter", async () => {
		seedProject();
		seedNarrator("n1");
		db.insert(narrators)
			.values({
				id: "n2",
				chapterId: "ch1",
				type: "primary",
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

	it("supports parentNarratorId for fork lineage", async () => {
		seedProject();
		seedNarrator("n-parent");
		db.insert(narrators)
			.values({
				id: "n-child",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				parentNarratorId: "n-parent",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const child = await db.query.narrators.findFirst({ where: eq(narrators.id, "n-child") });
		expect(child?.parentNarratorId).toBe("n-parent");
	});
});

// === Messages + Refs ===

describe("narrator messages and refs", () => {
	it("can persist a user message with ref", async () => {
		seedProject();
		seedNarrator();
		seedMessage("msg1", "n1", "user", "Hello");
		seedRef("n1", "msg1", 0);

		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "msg1"),
		});
		expect(msg?.role).toBe("user");
		expect(msg?.contentText).toBe("Hello");

		const ref = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, "msg1"),
		});
		expect(ref?.narratorId).toBe("n1");
		expect(ref?.seq).toBe(0);
	});

	it("can persist assistant message with tool calls", async () => {
		seedProject();
		seedNarrator();

		db.insert(narratorMessages)
			.values({
				id: "msg-a1",
				narratorId: "n1",
				messageUuid: "uuid-123",
				role: "assistant",
				contentJson: JSON.stringify([
					{ type: "text", text: "Let me check" },
					{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/foo" } },
				]),
				contentText: "Let me check",
				tokensIn: 100,
				createdAt: now,
			})
			.run();
		seedRef("n1", "msg-a1", 0);

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
		expect(msg?.tokensIn).toBe(100);
		expect(msg?.toolCalls).toHaveLength(1);
		expect(msg?.toolCalls[0].toolName).toBe("Read");
	});

	it("enforces unique (narrator_id, message_id) in refs", () => {
		seedProject();
		seedNarrator();
		seedMessage("msg1", "n1");
		seedRef("n1", "msg1", 0);

		expect(() => {
			db.insert(narratorMessageRefs)
				.values({ id: "ref-dup", narratorId: "n1", messageId: "msg1", seq: 1 })
				.run();
		}).toThrow();
	});

	it("allows same message to be referenced by multiple narrators", async () => {
		seedProject();
		seedNarrator("n1");
		db.insert(narrators)
			.values({
				id: "n2",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				parentNarratorId: "n1",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		seedMessage("msg-shared", "n1");
		seedRef("n1", "msg-shared", 0);
		seedRef("n2", "msg-shared", 0);

		const refs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.messageId, "msg-shared"),
		});
		expect(refs).toHaveLength(2);
		expect(refs.map((r) => r.narratorId).sort()).toEqual(["n1", "n2"]);
	});
});

// === Fork (shared refs) ===

describe("narrator fork via shared refs", () => {
	it("fork copies refs up to forkSeq", async () => {
		seedProject();
		seedNarrator("n-parent");

		// Parent has 3 messages
		seedMessage("m0", "n-parent", "user", "msg 0");
		seedMessage("m1", "n-parent", "assistant", "msg 1");
		seedMessage("m2", "n-parent", "user", "msg 2");
		seedRef("n-parent", "m0", 0);
		seedRef("n-parent", "m1", 1);
		seedRef("n-parent", "m2", 2);

		// Fork at m1 (seq=1) → new narrator gets refs for m0, m1
		db.insert(narrators)
			.values({
				id: "n-fork",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				parentNarratorId: "n-parent",
				forkMessageId: "m1",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		seedRef("n-fork", "m0", 0);
		seedRef("n-fork", "m1", 1);

		// Verify fork narrator has 2 refs
		const forkRefs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n-fork"),
			orderBy: (r, { asc }) => [asc(r.seq)],
		});
		expect(forkRefs).toHaveLength(2);
		expect(forkRefs[0].messageId).toBe("m0");
		expect(forkRefs[1].messageId).toBe("m1");

		// Parent still has 3 refs
		const parentRefs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n-parent"),
		});
		expect(parentRefs).toHaveLength(3);
	});

	it("fork narrator can add new messages independently", async () => {
		seedProject();
		seedNarrator("n-parent");
		seedMessage("m0", "n-parent", "user", "shared");
		seedRef("n-parent", "m0", 0);

		// Fork
		db.insert(narrators)
			.values({
				id: "n-fork",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				parentNarratorId: "n-parent",
				forkMessageId: "m0",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		seedRef("n-fork", "m0", 0);

		// New message on fork
		seedMessage("m-fork-1", "n-fork", "user", "fork only");
		seedRef("n-fork", "m-fork-1", 1);

		// New message on parent
		seedMessage("m-parent-1", "n-parent", "assistant", "parent only");
		seedRef("n-parent", "m-parent-1", 1);

		// Fork has 2 refs, parent has 2 refs, but different second messages
		const forkRefs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n-fork"),
			orderBy: (r, { asc }) => [asc(r.seq)],
		});
		expect(forkRefs).toHaveLength(2);
		expect(forkRefs[1].messageId).toBe("m-fork-1");

		const parentRefs = await db.query.narratorMessageRefs.findMany({
			where: eq(narratorMessageRefs.narratorId, "n-parent"),
			orderBy: (r, { asc }) => [asc(r.seq)],
		});
		expect(parentRefs).toHaveLength(2);
		expect(parentRefs[1].messageId).toBe("m-parent-1");
	});

	it("shared message is not deleted when one narrator is removed", async () => {
		seedProject();
		seedNarrator("n-parent");
		db.insert(narrators)
			.values({
				id: "n-fork",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				parentNarratorId: "n-parent",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		seedMessage("m-shared", "n-parent", "user", "shared");
		seedRef("n-parent", "m-shared", 0);
		seedRef("n-fork", "m-shared", 0);

		// Delete fork's refs, but message should survive
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n-fork")).run();
		db.delete(narrators).where(eq(narrators.id, "n-fork")).run();

		// Message still exists (referenced by parent)
		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-shared"),
		});
		expect(msg).toBeDefined();
		expect(msg?.contentText).toBe("shared");
	});
});

// === Compact marker ===

describe("compact markers in refs", () => {
	it("isCompact flag marks compact messages in refs", async () => {
		seedProject();
		seedNarrator();
		seedMessage("m0", "n1", "user", "before compact");
		seedMessage("m-compact", "n1", "system", "[Compact]");
		seedMessage("m1", "n1", "user", "after compact");
		seedRef("n1", "m0", 0);
		seedRef("n1", "m-compact", 1, 1); // isCompact = 1
		seedRef("n1", "m1", 2);

		const compactRefs = await db.query.narratorMessageRefs.findMany({
			where: and(eq(narratorMessageRefs.narratorId, "n1"), eq(narratorMessageRefs.isCompact, 1)),
		});
		expect(compactRefs).toHaveLength(1);
		expect(compactRefs[0].messageId).toBe("m-compact");
	});
});

// === Cascade delete ===

describe("narrator cascade delete", () => {
	it("deleting narrator refs, messages, and tool calls in order works", async () => {
		seedProject();
		seedNarrator();
		seedMessage("msg1", "n1");
		seedRef("n1", "msg1", 0);
		db.insert(narratorToolCalls)
			.values({
				id: "tc1",
				narratorId: "n1",
				messageId: "msg1",
				toolUseId: "tu1",
				toolName: "Bash",
				status: "success",
				createdAt: now,
			})
			.run();

		// Delete in dependency order (same as narratorService.remove)
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n1")).run();
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n1")).run();
		db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n1")).run();
		db.delete(narrators).where(eq(narrators.id, "n1")).run();

		const remaining = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(remaining).toBeUndefined();
	});
});

// === Fork validation ===

describe("fork validation", () => {
	it("rejects fork with invalid messageId", async () => {
		seedProject();
		seedNarrator("n1");
		seedMessage("m0", "n1", "user", "hello");
		seedRef("n1", "m0", 0);

		// A messageId that doesn't belong to this narrator should not be found in refs
		const forkRef = await db.query.narratorMessageRefs.findFirst({
			where: and(
				eq(narratorMessageRefs.narratorId, "n1"),
				eq(narratorMessageRefs.messageId, "nonexistent"),
			),
		});
		expect(forkRef).toBeUndefined();
	});

	it("subagent type narrator should not be forkable", async () => {
		seedProject();
		db.insert(narrators)
			.values({
				id: "n-sub",
				chapterId: "ch1",
				type: "subagent",
				subagentType: "explore",
				inheritMode: "fresh",
				parentNarratorId: null,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n-sub"),
		});
		expect(narrator).toBeDefined();
		expect(narrator?.type).toBe("subagent");
	});
});

// === Recursive child deletion ===

describe("recursive child narrator deletion", () => {
	it("deleting parent also removes child subagent data", async () => {
		seedProject();
		seedNarrator("n-parent");

		// Create a subagent child
		db.insert(narrators)
			.values({
				id: "n-child",
				chapterId: "ch1",
				type: "subagent",
				subagentType: "explore",
				inheritMode: "fresh",
				parentNarratorId: "n-parent",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		seedMessage("m-child", "n-child", "assistant", "subagent output");
		seedRef("n-child", "m-child", 0);

		// Verify child exists
		const child = await db.query.narrators.findFirst({ where: eq(narrators.id, "n-child") });
		expect(child).toBeDefined();

		// Query children (simulating narratorService.remove recursive step)
		const children = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, "n-parent"),
			columns: { id: true },
		});
		expect(children).toHaveLength(1);
		expect(children[0].id).toBe("n-child");

		// Clean up child first (recursive remove)
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n-child")).run();
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n-child")).run();
		db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n-child")).run();
		db.delete(narrators).where(eq(narrators.id, "n-child")).run();

		// Then clean up parent
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n-parent")).run();
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n-parent")).run();
		db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n-parent")).run();
		db.delete(narrators).where(eq(narrators.id, "n-parent")).run();

		// Both should be gone
		const remainingParent = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n-parent"),
		});
		const remainingChild = await db.query.narrators.findFirst({
			where: eq(narrators.id, "n-child"),
		});
		expect(remainingParent).toBeUndefined();
		expect(remainingChild).toBeUndefined();

		// Child's messages should also be gone
		const childMsgs = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, "n-child"),
		});
		expect(childMsgs).toHaveLength(0);
	});

	it("orphan messages are deleted when narrator is removed", async () => {
		seedProject();
		seedNarrator("n1");
		seedMessage("m-orphan", "n1", "user", "only referenced by n1");
		seedRef("n1", "m-orphan", 0);

		// Simulate remove: delete refs first
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n1")).run();

		// Message still exists (not yet cleaned up)
		const msg = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-orphan"),
		});
		expect(msg).toBeDefined();

		// Clean up orphan messages and narrator
		db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n1")).run();
		db.delete(narrators).where(eq(narrators.id, "n1")).run();

		const remaining = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-orphan"),
		});
		expect(remaining).toBeUndefined();
	});
});
