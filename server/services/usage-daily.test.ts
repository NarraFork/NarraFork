import { afterEach, describe, expect, test } from "bun:test";
import {
	apiRequests,
	narratorProjectLinks,
	narrators,
	projects,
	usageDaily,
	users,
} from "@server/db/schema";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../tests/setup";
import { insertApiRequestWithUserUsage } from "./user-usage-totals";

const { db, sqlite } = getTestDb();
afterEach(() => cleanDb(sqlite));

const at = "2026-09-01T10:00:00.000Z";

function record(id: string, extra: Partial<typeof apiRequests.$inferInsert> = {}) {
	return insertApiRequestWithUserUsage(
		{
			id,
			userId: "bob",
			provider: "codex",
			credentialId: "acct-1",
			model: "gpt-5.5",
			createdAt: at,
			inputTokens: 100,
			outputTokens: 20,
			costUsd: 0.01,
			...extra,
		},
		db,
	);
}

function seedOwnedNarrator() {
	for (const id of ["alice", "bob"])
		db.insert(users).values({ id, username: id, passwordHash: "x", createdAt: at }).run();
	db.insert(projects)
		.values({ id: "proj", name: "proj", gitPath: "/tmp/proj", createdAt: at, updatedAt: at })
		.run();
	db.insert(narrators)
		.values({ id: "root", ownerUserId: "alice", createdAt: at, updatedAt: at })
		.run();
	db.insert(narratorProjectLinks)
		.values({
			narratorId: "root",
			projectId: "proj",
			role: "primary",
			source: "cwd",
			updatedAt: at,
		})
		.run();
	db.insert(narrators)
		.values({ id: "sub", aclRootNarratorId: "root", createdAt: at, updatedAt: at })
		.run();
}

describe("request attribution", () => {
	test("a collaborator's turn is billed to the narrator owner and its project", () => {
		seedOwnedNarrator();
		record("r1", { narratorId: "root" });
		expect(db.select().from(apiRequests).where(eq(apiRequests.id, "r1")).get()).toMatchObject({
			userId: "bob",
			billingUserId: "alice",
			projectId: "proj",
		});
	});

	test("subagents inherit billing and project from their root narrator", () => {
		seedOwnedNarrator();
		record("r1", { narratorId: "sub" });
		expect(db.select().from(apiRequests).where(eq(apiRequests.id, "r1")).get()).toMatchObject({
			billingUserId: "alice",
			projectId: "proj",
		});
	});

	test("requests without a narrator are billed to their initiator", () => {
		record("r1");
		expect(db.select().from(apiRequests).get()).toMatchObject({
			billingUserId: "bob",
			projectId: null,
		});
	});
});

describe("usage_daily", () => {
	test("requests in one bucket accumulate; a duplicate completion is not counted", () => {
		record("r1");
		record("r2", { inputTokens: 50, costUsd: null, costStatus: "unknown" });
		expect(record("r1")).toBe(false);
		expect(db.select().from(usageDaily).all()).toEqual([
			expect.objectContaining({
				day: "2026-09-01",
				billingUserId: "bob",
				projectId: "",
				provider: "codex",
				credentialId: "acct-1",
				requestCount: 2,
				inputTokens: 150,
				outputTokens: 40,
				costUsd: 0.01,
				unpricedRequestCount: 1,
			}),
		]);
	});

	test("survives deletion of the narrator whose detail rows cascade away", () => {
		seedOwnedNarrator();
		record("r1", { narratorId: "root" });
		db.delete(narrators).where(eq(narrators.id, "sub")).run();
		db.delete(narrators).where(eq(narrators.id, "root")).run();
		expect(db.select().from(apiRequests).all()).toHaveLength(0);
		expect(db.select().from(usageDaily).get()).toMatchObject({
			billingUserId: "alice",
			projectId: "proj",
			requestCount: 1,
		});
	});

	test("unattributed requests share an empty-key bucket instead of failing the upsert", () => {
		record("r1", { userId: null, credentialId: null, provider: null, model: null });
		record("r2", { userId: null, credentialId: null, provider: null, model: null });
		expect(db.select().from(usageDaily).get()).toMatchObject({
			billingUserId: "",
			credentialId: "",
			requestCount: 2,
		});
	});
});
