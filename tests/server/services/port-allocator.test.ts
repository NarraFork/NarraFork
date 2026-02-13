import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { chapters, portAllocations, projects, repositories } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

const now = new Date().toISOString();

function seedChapter(chapterId = "ch1") {
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
			id: chapterId,
			projectId: "p1",
			repositoryId: "r1",
			title: "Ch",
			branch: "meanwhile/ch-abc",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

describe("port allocations", () => {
	it("can allocate a port", () => {
		seedChapter();
		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();

		const alloc = sqlite.prepare("SELECT * FROM port_allocations WHERE port = 10000").get() as any;
		expect(alloc).toBeDefined();
		expect(alloc.chapter_id).toBe("ch1");
		expect(alloc.service_name).toBe("web");
	});

	it("rejects duplicate port allocation (PK constraint)", () => {
		seedChapter();
		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();

		expect(() => {
			db.insert(portAllocations)
				.values({ port: 10000, chapterId: "ch1", serviceName: "api", allocatedAt: now })
				.run();
		}).toThrow();
	});

	it("can release ports by chapter", () => {
		seedChapter();
		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();
		db.insert(portAllocations)
			.values({ port: 10001, chapterId: "ch1", serviceName: "api", allocatedAt: now })
			.run();

		db.delete(portAllocations).where(eq(portAllocations.chapterId, "ch1")).run();

		const remaining = sqlite.prepare("SELECT count(*) as c FROM port_allocations").get() as any;
		expect(remaining.c).toBe(0);
	});

	it("allocations for different chapters don't interfere", () => {
		seedChapter("ch1");
		// Add second chapter
		db.insert(chapters)
			.values({
				id: "ch2",
				projectId: "p1",
				repositoryId: "r1",
				title: "Ch2",
				branch: "meanwhile/ch2-def",
				baseBranch: "main",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(portAllocations)
			.values({ port: 10000, chapterId: "ch1", serviceName: "web", allocatedAt: now })
			.run();
		db.insert(portAllocations)
			.values({ port: 10001, chapterId: "ch2", serviceName: "web", allocatedAt: now })
			.run();

		// Release ch1 ports only
		db.delete(portAllocations).where(eq(portAllocations.chapterId, "ch1")).run();

		const remaining = sqlite.prepare("SELECT * FROM port_allocations").all() as any[];
		expect(remaining).toHaveLength(1);
		expect(remaining[0].port).toBe(10001);
		expect(remaining[0].chapter_id).toBe("ch2");
	});
});
