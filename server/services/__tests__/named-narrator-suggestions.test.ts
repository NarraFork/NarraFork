import { beforeAll, expect, spyOn, test } from "bun:test";
import { NAMED_SUGGESTIONS_TITLE_CHARS } from "@shared/named-narrator-suggestions";
import { foldHandle } from "@shared/narrator-handle";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { listNamedNarratorSuggestions } from "../named-narrator-suggestions";

const ownerId = generateId();
const viewerId = generateId();
const principal = { userId: viewerId, isAdmin: false };
const prefix = `suggest${generateId(6).toLowerCase()}`;
const now = new Date().toISOString();
const visibleIds: string[] = [];

async function named(handle: string, extra: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "界".repeat(1000),
		handle,
		handleFold: foldHandle(handle),
		traits: ["named"],
		ownerUserId: ownerId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
		...extra,
	});
	return id;
}

beforeAll(async () => {
	await db.insert(users).values(
		[ownerId, viewerId].map((id) => ({
			id,
			username: `suggestions-${id}`,
			passwordHash: "x",
			createdAt: now,
		})),
	);
	// The visible set sorts AFTER >1000 private rows. LIMIT-before-ACL would
	// return no suggestions and/or lie about whether more pages exist.
	for (let offset = 0; offset < 1100; offset += 100) {
		await db.insert(narrators).values(
			Array.from({ length: 100 }, (_, i) => {
				const handle = `${prefix}a${String(offset + i).padStart(4, "0")}`;
				return {
					id: generateId(),
					title: "private",
					handle,
					handleFold: handle,
					traits: ["named"],
					ownerUserId: ownerId,
					visibility: "private" as const,
					createdAt: now,
					updatedAt: now,
				};
			}),
		);
	}
	for (let i = 0; i < 55; i++)
		visibleIds.push(
			await named(`${prefix}z${String(i).padStart(3, "0")}`, { visibility: "public" }),
		);
});

test("SQL selects exactly four bounded fields and applies ACL before LIMIT n+1", async () => {
	const select = spyOn(db, "select");
	try {
		const page = await listNamedNarratorSuggestions(principal, { q: prefix });
		expect(page.items).toHaveLength(20);
		expect(page.nextCursor).toBeString();
		expect(page.items.map((item) => item.id)).toEqual(visibleIds.slice(0, 20));
		expect(Object.keys(select.mock.calls[0]?.[0] ?? {})).toEqual([
			"id",
			"handle",
			"title",
			"status",
		]);
		for (const item of page.items) {
			expect(Object.keys(item)).toEqual(["id", "handle", "title", "status"]);
			expect([...(item.title ?? "")]).toHaveLength(NAMED_SUGGESTIONS_TITLE_CHARS);
		}
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(48 * 1024);
	} finally {
		select.mockRestore();
	}
});

test("cursor traversal is disjoint and bounded, maximum page is 50", async () => {
	const first = await listNamedNarratorSuggestions(principal, { q: prefix, limit: 500 });
	expect(first.items).toHaveLength(50);
	const second = await listNamedNarratorSuggestions(principal, {
		q: prefix,
		cursor: first.nextCursor ?? undefined,
		limit: 50,
	});
	expect(second.items).toHaveLength(5);
	expect(second.nextCursor).toBeNull();
	expect([...first.items, ...second.items].map((item) => item.id)).toEqual(visibleIds);
});

test("NFC, non-ASCII case folding, CJK and astral code points match stored handle folds", async () => {
	for (const [handle, q] of [
		[`É${prefix}`, "E\u0301"],
		[`小明${prefix}`, "小"],
		[`𐐀${prefix}`, "𐐨"],
	]) {
		const id = await named(handle, { visibility: "public" });
		expect(
			(await listNamedNarratorSuggestions(principal, { q })).items.some((item) => item.id === id),
		).toBe(true);
	}
	const fullLength = await listNamedNarratorSuggestions(principal, { q: "𐐀".repeat(32) });
	expect(fullLength.items).toEqual([]);
	await expect(listNamedNarratorSuggestions(principal, { q: "𐐀".repeat(33) })).rejects.toThrow(
		"32 code points",
	);
});

test("search metacharacters are literal, cursors are bounded and query-bound", async () => {
	expect((await listNamedNarratorSuggestions(principal, { q: "%" })).items).toEqual([]);
	const page = await listNamedNarratorSuggestions(principal, { q: prefix, limit: 1 });
	await expect(
		listNamedNarratorSuggestions(principal, {
			q: "different",
			cursor: page.nextCursor ?? undefined,
		}),
	).rejects.toThrow("cursor");
	for (const cursor of ["", "*bad", "x".repeat(1025), Buffer.from("{}").toString("base64url")])
		await expect(listNamedNarratorSuggestions(principal, { cursor })).rejects.toThrow("cursor");
	for (const limit of ["", "nan", -1, 0, 1.5])
		await expect(listNamedNarratorSuggestions(principal, { limit })).rejects.toThrow("limit");
});

test("every page rechecks grants and project gates after revocation", async () => {
	const handle = `revoke${generateId(6).toLowerCase()}`;
	const id = await named(handle);
	const grantId = generateId();
	await db.insert(aclGrants).values({
		id: grantId,
		scopeType: "narrator",
		scopeId: id,
		principalType: "user",
		principalId: viewerId,
		capability: "read",
		grantedBy: ownerId,
		createdAt: now,
	});
	expect(
		(await listNamedNarratorSuggestions(principal, { q: handle })).items.map((item) => item.id),
	).toEqual([id]);
	await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
	expect((await listNamedNarratorSuggestions(principal, { q: handle })).items).toEqual([]);
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "private suggestion project",
		ownerUserId: ownerId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: id,
		principalType: "user",
		principalId: viewerId,
		capability: "read",
		grantedBy: ownerId,
		createdAt: now,
	});
	await db.update(narrators).set({ contextProjectId: projectId }).where(eq(narrators.id, id));
	expect((await listNamedNarratorSuggestions(principal, { q: handle })).items).toEqual([]);
	expect(
		(await listNamedNarratorSuggestions({ ...principal, isAdmin: true }, { q: handle })).items.map(
			(item) => item.id,
		),
	).toEqual([id]);
});

test("exclude non-named or subagent rows even if a stale handle exists", async () => {
	const handle = `stale${generateId(6).toLowerCase()}`;
	await named(handle, { visibility: "public", traits: [] });
	await named(`${handle}sub`, { visibility: "public", type: "subagent" });
	expect((await listNamedNarratorSuggestions(principal, { q: handle })).items).toEqual([]);
});

test("untitled named sessions keep a nullable title without constructing the full DTO", async () => {
	const handle = `untitled${generateId(6).toLowerCase()}`;
	await named(handle, { title: null, visibility: "public" });
	expect((await listNamedNarratorSuggestions(principal, { q: handle })).items[0].title).toBeNull();
});

test("aborted requests never return a successful page", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		listNamedNarratorSuggestions(principal, { signal: controller.signal }),
	).rejects.toThrow();
});
