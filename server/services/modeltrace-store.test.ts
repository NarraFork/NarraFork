import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../tests/setup";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	userRecentTabs,
	users,
} from "../db/schema";

const { db, sqlite } = getTestDb();
const NOW = "2026-10-31T00:00:00.000Z";

mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
mock.module("@server/lib/agent/provider", () => ({
	resolveProviderAndModel(model?: string, sticky?: string) {
		if (!model || model === "gone") throw new Error("unresolved");
		if (model.startsWith("proxy:")) {
			return { provider: "proxy", model: model.slice("proxy:".length), adapter: {} };
		}
		return { provider: sticky ?? "openai", model, adapter: {} };
	},
}));

let forkCount = 0;
const forkNarrator = mock(async (parentId: string) => {
	forkCount += 1;
	const parent = db.select().from(narrators).where(eq(narrators.id, parentId)).get();
	const id = `fork-${forkCount}`;
	db.insert(narrators)
		.values({
			id,
			title: "fork",
			ownerUserId: parent?.ownerUserId ?? null,
			visibility: "public",
			writeAudience: "public",
			cwd: parent?.cwd ?? null,
			contextProjectId: parent?.contextProjectId ?? null,
			parentNarratorId: parentId,
			traits: [],
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(aclGrants)
		.values({
			id: `grant-${id}`,
			scopeType: "narrator",
			scopeId: id,
			principalType: "user",
			principalId: "bob",
			capability: "read",
			createdAt: NOW,
		})
		.run();
	return { id, traits: [] as string[] };
});
const remove = mock(async (id: string) => {
	db.delete(aclGrants).where(eq(aclGrants.scopeId, id)).run();
	db.delete(narrators).where(eq(narrators.id, id)).run();
});
mock.module("./narrator-service", () => ({ narratorService: { forkNarrator, remove } }));

const { clearTraceHistory, ensureTraceNarrator, findModelTraceNarrator, modelTraceKey } =
	await import("./modeltrace-store");
const { adoptLegacyModelTraceNarrators } = await import("./modeltrace-compat");

function user(id: string) {
	db.insert(users).values({ id, username: id, passwordHash: "x", createdAt: NOW }).run();
}

function narrator(values: { id: string } & Partial<typeof narrators.$inferInsert>) {
	db.insert(narrators)
		.values({
			title: values.id,
			visibility: "private",
			writeAudience: "owner",
			createdAt: NOW,
			updatedAt: NOW,
			...values,
		})
		.run();
}

function narratorRow(id: string) {
	return db.select().from(narrators).where(eq(narrators.id, id)).get();
}

beforeEach(() => {
	forkCount = 0;
	forkNarrator.mockClear();
	remove.mockClear();
	user("alice");
	user("bob");
});

afterEach(() => cleanDb(sqlite));

describe("modeltrace cabin", () => {
	test("one private cabin per user and resolved model", async () => {
		narrator({ id: "p1", ownerUserId: "bob", cwd: "/work/a" });
		db.insert(projects)
			.values({
				id: "proj-b",
				name: "b",
				gitPath: "/repo",
				ownerUserId: "bob",
				visibility: "private",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		narrator({ id: "p2", ownerUserId: "bob", cwd: "/work/b", contextProjectId: "proj-b" });

		const first = await ensureTraceNarrator({
			parentId: "p1",
			userId: "alice",
			provider: "proxy",
			model: "cn:x",
			title: "T1",
			locale: "en",
		});
		const again = await ensureTraceNarrator({
			parentId: "p2",
			userId: "alice",
			provider: "proxy",
			model: "cn:x",
			title: "T2",
			locale: "en",
		});
		const bobCabin = await ensureTraceNarrator({
			parentId: "p1",
			userId: "bob",
			provider: "proxy",
			model: "cn:x",
			title: "Bob",
			locale: "en",
		});

		expect(again).toBe(first);
		expect(bobCabin).not.toBe(first);
		expect(forkNarrator).toHaveBeenCalledTimes(2);
		const row = narratorRow(first);
		expect(row).toMatchObject({
			cwd: "/work/b",
			contextProjectId: "proj-b",
			title: "T2",
			parentNarratorId: "p2",
			ownerUserId: "alice",
			visibility: "private",
			writeAudience: "owner",
			hiddenFromLists: true,
			modeltraceKey: modelTraceKey("alice", "proxy", "cn:x"),
		});
		expect(row?.traits).toContain("modeltrace");
		expect(await findModelTraceNarrator("alice", "proxy:cn:x")).toBe(first);
		expect(await findModelTraceNarrator("bob", "proxy:cn:x")).toBe(bobCabin);
		expect(await findModelTraceNarrator("alice", "gone")).toBeNull();
		expect(db.select().from(aclGrants).where(eq(aclGrants.scopeId, first)).all()).toHaveLength(0);
	});

	test("clear keeps a shared message and drops the cabin's own history", async () => {
		narrator({ id: "parent", ownerUserId: "alice" });
		narrator({
			id: "cabin",
			ownerUserId: "alice",
			status: "working",
			nextSeq: 4,
			errorMessage: "stale",
			apiConversationId: "conv",
			substatus: '["error"]',
			contextUsageSnapshotJson: {
				requestId: "r",
				startedAt: NOW,
				source: "estimate",
				percentage: null,
				contextWindow: null,
				occupiedTokens: null,
				inputCharacters: null,
				composition: null,
			},
		});
		narrator({ id: "sibling", ownerUserId: "alice" });
		db.insert(narratorMessages)
			.values([
				{
					id: "shared",
					narratorId: "parent",
					role: "user",
					contentJson: [{ type: "text", text: "keep" }],
					createdAt: NOW,
				},
				{
					id: "only",
					narratorId: "cabin",
					role: "assistant",
					contentJson: [{ type: "text", text: "drop" }],
					createdAt: NOW,
				},
			])
			.run();
		db.insert(narratorMessageRefs)
			.values([
				{ id: "ref-parent", narratorId: "parent", messageId: "shared", seq: 0 },
				{ id: "ref-shared", narratorId: "cabin", messageId: "shared", seq: 0 },
				{ id: "ref-only", narratorId: "cabin", messageId: "only", seq: 1 },
			])
			.run();
		db.insert(narratorToolCalls)
			.values({
				id: "call-1",
				narratorId: "cabin",
				messageId: "only",
				toolUseId: "use-1",
				toolName: "Bash",
				createdAt: NOW,
			})
			.run();
		db.update(narrators).set({ forkMessageId: "only" }).where(eq(narrators.id, "sibling")).run();

		await clearTraceHistory("cabin");

		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, "shared")).get(),
		).toBeTruthy();
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, "only")).get(),
		).toBeUndefined();
		expect(
			db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, "parent"))
				.all(),
		).toHaveLength(1);
		expect(
			db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, "cabin"))
				.all(),
		).toHaveLength(0);
		expect(db.select().from(narratorToolCalls).all()).toHaveLength(0);
		expect(narratorRow("sibling")?.forkMessageId).toBeNull();
		expect(narratorRow("cabin")).toMatchObject({
			status: "working",
			nextSeq: 0,
			errorMessage: null,
			apiConversationId: null,
			substatus: "[]",
			contextUsageSnapshotJson: null,
		});
	});

	test("adoption claims the newest row per user and tombs the rest", async () => {
		for (const row of [
			{
				id: "alice-old",
				ownerUserId: "alice",
				model: "gpt",
				updatedAt: "2026-10-01T00:00:00.000Z",
				visibility: "public" as const,
			},
			{
				id: "alice-new",
				ownerUserId: "alice",
				model: "gpt",
				updatedAt: "2026-10-02T00:00:00.000Z",
				visibility: "public" as const,
			},
			{
				id: "bob-row",
				ownerUserId: "bob",
				model: "gpt",
				updatedAt: "2026-10-03T00:00:00.000Z",
				visibility: "public" as const,
			},
			{
				id: "gone-row",
				ownerUserId: "alice",
				model: "gone",
				updatedAt: "2026-10-04T00:00:00.000Z",
				visibility: "project" as const,
			},
			{
				id: "ownerless",
				ownerUserId: null,
				model: "gpt",
				updatedAt: "2026-10-05T00:00:00.000Z",
				visibility: "public" as const,
			},
		]) {
			narrator({
				...row,
				traits: ["modeltrace"],
				hiddenFromLists: false,
				writeAudience: "public",
			});
		}
		narrator({ id: "plain", ownerUserId: "alice", hiddenFromLists: false });
		for (const id of ["alice-new", "alice-old"]) {
			db.insert(aclGrants)
				.values({
					id: `grant-${id}`,
					scopeType: "narrator",
					scopeId: id,
					principalType: "user",
					principalId: "bob",
					capability: "read",
					createdAt: NOW,
				})
				.run();
		}
		for (const [id, entityId, representedNarratorId] of [
			["tab-new", "alice-new", "alice-new"],
			["tab-old", "tab-entity", "alice-old"],
			["tab-plain", "plain", "plain"],
		] as const) {
			db.insert(userRecentTabs)
				.values({
					id,
					userId: "alice",
					tabKey: `narrator:${id}`,
					section: "work",
					type: "narrator",
					entityId,
					representedNarratorId,
					title: id,
					lastVisitedAt: 1,
					sortOrder: 1,
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}

		await adoptLegacyModelTraceNarrators();

		expect(narratorRow("alice-new")).toMatchObject({
			modeltraceKey: modelTraceKey("alice", "openai", "gpt"),
			visibility: "private",
			writeAudience: "owner",
			hiddenFromLists: true,
		});
		expect(narratorRow("alice-old")).toMatchObject({
			modeltraceKey: "legacy/alice-old",
			visibility: "public",
			writeAudience: "public",
			hiddenFromLists: true,
		});
		expect(narratorRow("bob-row")?.modeltraceKey).toBe(modelTraceKey("bob", "openai", "gpt"));
		expect(narratorRow("gone-row")).toMatchObject({
			modeltraceKey: "legacy/gone-row",
			visibility: "project",
			hiddenFromLists: true,
		});
		expect(narratorRow("ownerless")?.modeltraceKey).toBe("legacy/ownerless");
		expect(narratorRow("plain")?.modeltraceKey).toBeNull();
		expect(
			db.select().from(aclGrants).where(eq(aclGrants.scopeId, "alice-new")).all(),
		).toHaveLength(0);
		expect(
			db.select().from(aclGrants).where(eq(aclGrants.scopeId, "alice-old")).all(),
		).toHaveLength(1);
		expect(
			db
				.select({ id: userRecentTabs.id })
				.from(userRecentTabs)
				.all()
				.map((row) => row.id),
		).toEqual(["tab-plain"]);

		db.update(narrators).set({ hiddenFromLists: false }).where(eq(narrators.id, "alice-old")).run();
		await adoptLegacyModelTraceNarrators();
		expect(narratorRow("alice-old")?.hiddenFromLists).toBe(false);
	});

	test("a key already stored stays with its cabin", async () => {
		const key = modelTraceKey("alice", "openai", "gpt");
		narrator({
			id: "held",
			ownerUserId: "alice",
			model: "gpt",
			traits: ["modeltrace"],
			modeltraceKey: key,
			hiddenFromLists: true,
			visibility: "private",
			writeAudience: "owner",
		});
		narrator({
			id: "older",
			ownerUserId: "alice",
			model: "gpt",
			traits: ["modeltrace"],
			hiddenFromLists: false,
			visibility: "public",
			writeAudience: "public",
		});

		await adoptLegacyModelTraceNarrators();

		expect(narratorRow("held")?.modeltraceKey).toBe(key);
		expect(narratorRow("older")).toMatchObject({
			modeltraceKey: "legacy/older",
			visibility: "public",
			hiddenFromLists: true,
		});
	});
});
