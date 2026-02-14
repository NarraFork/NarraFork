import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { chapters, projects } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

describe("test DB setup", () => {
	it("can insert and query projects", async () => {
		db.insert(projects).values({ id: "p1", name: "Test", createdAt: now, updatedAt: now }).run();

		const result = await db.query.projects.findFirst({ where: eq(projects.id, "p1") });
		expect(result).toBeDefined();
		expect(result!.name).toBe("Test");
		expect(result!.status).toBe("active");
	});

	it("cleanDb resets between tests", async () => {
		const result = await db.query.projects.findFirst({ where: eq(projects.id, "p1") });
		expect(result).toBeUndefined();
	});
});

describe("chapters schema", () => {
	it("can create chapter with FK to project", async () => {
		db.insert(projects)
			.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
			.run();
		db.insert(chapters)
			.values({
				id: "ch1",
				projectId: "p1",
				title: "Chapter 1",
				branch: "chapter/test-abc123",
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const ch = await db.query.chapters.findFirst({ where: eq(chapters.id, "ch1") });
		expect(ch).toBeDefined();
		expect(ch!.status).toBe("active");
	});

	it("supports self-referencing parentChapterId", async () => {
		db.insert(projects)
			.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: now, updatedAt: now })
			.run();
		db.insert(chapters)
			.values({
				id: "parent",
				projectId: "p1",
				title: "Parent",
				branch: "chapter/parent-aaa",
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(chapters)
			.values({
				id: "child",
				projectId: "p1",
				title: "Child",
				branch: "chapter/child-bbb",
				baseBranch: "main",
				parentChapterId: "parent",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const child = await db.query.chapters.findFirst({ where: eq(chapters.id, "child") });
		expect(child!.parentChapterId).toBe("parent");
	});
});
