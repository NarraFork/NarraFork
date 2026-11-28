/**
 * Browse-list sort and filters of GET /api/knowledge/entries (docs/KNOWLEDGE_UI_REDESIGN.md
 * §6.2, P2c):
 *   - `sort=title`: keyset on (title ASC, id ASC) — pages never duplicate/skip (ties
 *     included), the ACL post-filter back-fills, and a cursor is bound to its order
 *   - `level` filters on the EFFECTIVE level (own level, else the collection default)
 *   - `status` filters active / archived
 *   - paged rows carry ownerUsername / myPersonalEntryId / myPersonalEntryBehindMain
 *   - the `q` branch applies level/status and the title order over its capped result set
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { knowledgeCollections, knowledgeEntries, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { knowledgeRoutes } from "../../routes/knowledge";
import type { Principal } from "../knowledge-acl";
import { knowledgeBranchService } from "../knowledge-branch-service";
import {
	decodeTitleCursor,
	encodeEntryCursor,
	encodeTitleCursor,
	knowledgeService,
} from "../knowledge-service";
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const TAG = Date.now();
let adminId: string;
let adminName: string;
let lowId: string;

const P = (id: string, role: "admin" | "user" = "user"): Principal => ({ userId: id, role });

async function makeUser(role: "admin" | "user", label: string) {
	const id = generateId();
	const username = `${label}-${TAG}-${generateId(4)}`;
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role,
		createdAt: new Date().toISOString(),
	});
	return { id, username };
}

function appFor(principal: { userId: string; role: "admin" | "user" }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: principal.userId,
			role: principal.role,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.route("/knowledge", knowledgeRoutes);
	return app;
}

async function newCollection(label: string) {
	return knowledgeService.createCollection({ name: `${label}-${TAG}-${generateId()}` });
}

async function seedEntry(
	collectionId: string,
	title: string,
	patch: Partial<typeof knowledgeEntries.$inferInsert> = {},
) {
	// Unique slug: several tests seed duplicate titles on purpose.
	const slug = `s-${generateId(10).toLowerCase()}`;
	const e = await knowledgeService.createEntry({ collectionId, title, slug, content: "body" });
	if (Object.keys(patch).length > 0) {
		await db.update(knowledgeEntries).set(patch).where(eq(knowledgeEntries.id, e.id));
	}
	return e.id;
}

type Page = { items: { id: string; title: string }[]; nextCursor: string | null };

async function walk(
	principal: Principal,
	opts: Parameters<typeof knowledgeService.listEntriesPage>[0] extends infer O
		? Omit<O, "principal" | "cursor">
		: never,
) {
	const out: Page["items"][] = [];
	let cursor: string | undefined;
	for (let n = 0; n < 100; n++) {
		const page = await knowledgeService.listEntriesPage({ principal, ...opts, cursor });
		out.push(page.items);
		if (!page.nextCursor) return out;
		cursor = page.nextCursor;
	}
	throw new Error("pagination did not terminate");
}

const byTitleThenId = (a: { title: string; id: string }, b: { title: string; id: string }) =>
	a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1;

beforeAll(async () => {
	const admin = await makeUser("admin", "sadmin");
	adminId = admin.id;
	adminName = admin.username;
	lowId = (await makeUser("user", "slow")).id;
});

describe("listEntriesPage sort=title", () => {
	test("walks (title ASC, id ASC) with duplicate titles, no dupes/skips", async () => {
		const col = await newCollection("title");
		const titles = ["delta", "alpha", "charlie", "alpha", "bravo", "alpha", "echo", "bravo"];
		const seeded: { id: string; title: string }[] = [];
		for (const title of titles) seeded.push({ id: await seedEntry(col.id, title), title });
		const pages = await walk(P(adminId, "admin"), {
			collectionId: col.id,
			limit: 3,
			sort: "title",
		});
		expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
		expect(pages.flat().map((r) => r.id)).toEqual([...seeded].sort(byTitleThenId).map((r) => r.id));
	});

	test("ACL post-filter back-fills title pages without leaking hidden rows", async () => {
		const col = await newCollection("title-acl");
		const visible: { id: string; title: string }[] = [];
		const hidden = new Set<string>();
		for (let i = 0; i < 12; i++) {
			const title = `t${String(i).padStart(2, "0")}`;
			const hide = i % 3 !== 0;
			const id = await seedEntry(
				col.id,
				title,
				hide ? { classificationLevel: "confidential" } : {},
			);
			if (hide) hidden.add(id);
			else visible.push({ id, title });
		}
		const pages = await walk(P(lowId), { collectionId: col.id, limit: 2, sort: "title" });
		const flat = pages.flat().map((r) => r.id);
		expect(flat).toEqual(visible.sort(byTitleThenId).map((r) => r.id));
		expect(flat.some((id) => hidden.has(id))).toBe(false);
	});

	test("a cursor is bound to its order", async () => {
		const col = await newCollection("title-cursor");
		await seedEntry(col.id, "a");
		const updated = encodeEntryCursor({ updatedAt: "2020-01-01T00:00:00.000Z", id: "x" });
		const title = encodeTitleCursor({ title: "a", id: "x" });
		expect(
			await captureWorkerRejectionThrower(
				knowledgeService.listEntriesPage({
					principal: P(adminId, "admin"),
					collectionId: col.id,
					sort: "title",
					cursor: updated,
				}),
			),
		).toThrow("Invalid cursor");
		expect(
			await captureWorkerRejectionThrower(
				knowledgeService.listEntriesPage({
					principal: P(adminId, "admin"),
					collectionId: col.id,
					cursor: title,
				}),
			),
		).toThrow("Invalid cursor");
	});

	test("title cursors round-trip long CJK titles", () => {
		const pos = { title: "知".repeat(500), id: generateId() };
		expect(decodeTitleCursor(encodeTitleCursor(pos))).toEqual(pos);
		expect(() => decodeTitleCursor("garbage")).toThrow();
	});
});

describe("listEntriesPage level / status filters", () => {
	test("level matches the effective level (own, else the collection default)", async () => {
		const plain = await newCollection("lvl-plain");
		const strict = await newCollection("lvl-strict");
		await db
			.update(knowledgeCollections)
			.set({ defaultLevel: "confidential" })
			.where(eq(knowledgeCollections.id, strict.id));
		const own = await seedEntry(plain.id, "own", { classificationLevel: "confidential" });
		await seedEntry(plain.id, "public-default");
		const inherited = await seedEntry(strict.id, "inherited");
		const overridden = await seedEntry(strict.id, "overridden", { classificationLevel: "public" });

		const conf = await walk(P(adminId, "admin"), { level: "confidential", limit: 200 });
		const ids = new Set(conf.flat().map((r) => r.id));
		expect(ids.has(own)).toBe(true);
		expect(ids.has(inherited)).toBe(true);
		expect(ids.has(overridden)).toBe(false);

		const inStrict = await walk(P(adminId, "admin"), {
			collectionId: strict.id,
			level: "public",
			limit: 10,
		});
		expect(inStrict.flat().map((r) => r.id)).toEqual([overridden]);
	});

	test("status filters active / archived", async () => {
		const col = await newCollection("status");
		const active = await seedEntry(col.id, "a");
		const archived = await seedEntry(col.id, "b", { status: "archived" });
		const a = await walk(P(adminId, "admin"), {
			collectionId: col.id,
			status: "active",
			limit: 10,
		});
		const b = await walk(P(adminId, "admin"), {
			collectionId: col.id,
			status: "archived",
			limit: 10,
		});
		expect(a.flat().map((r) => r.id)).toEqual([active]);
		expect(b.flat().map((r) => r.id)).toEqual([archived]);
	});
});

describe("GET /knowledge/entries browse params", () => {
	test("sort=title pages through the route; bad sort/status → 400", async () => {
		const col = await newCollection("route-title");
		for (const title of ["c", "a", "b"]) await seedEntry(col.id, title);
		const app = appFor({ userId: adminId, role: "admin" });
		const r1 = await app.request(`/knowledge/entries?collectionId=${col.id}&sort=title&limit=2`);
		const b1 = (await r1.json()) as Page;
		expect(b1.items.map((e) => e.title)).toEqual(["a", "b"]);
		const r2 = await app.request(
			`/knowledge/entries?collectionId=${col.id}&sort=title&limit=2&cursor=${encodeURIComponent(b1.nextCursor ?? "")}`,
		);
		const b2 = (await r2.json()) as Page;
		expect(b2.items.map((e) => e.title)).toEqual(["c"]);
		expect(b2.nextCursor).toBeNull();
		expect((await app.request("/knowledge/entries?limit=5&sort=size")).status).toBe(400);
		expect((await app.request("/knowledge/entries?limit=5&status=gone")).status).toBe(400);
	});

	test("paged rows carry owner username and the caller's personal version (+ drift)", async () => {
		const col = await newCollection("route-annot");
		const mine = await seedEntry(col.id, "mine", { ownerUserId: adminId });
		const other = await seedEntry(col.id, "other");
		const draft = await knowledgeBranchService.createDraft(P(adminId, "admin"), mine, {});
		const app = appFor({ userId: adminId, role: "admin" });
		const read = async () => {
			const res = await app.request(`/knowledge/entries?collectionId=${col.id}&limit=10`);
			return (
				(await res.json()) as {
					items: {
						id: string;
						ownerUsername: string | null;
						myPersonalEntryId: string | null;
						myPersonalEntryBehindMain: boolean;
					}[];
				}
			).items;
		};
		let rows = await read();
		const mineRow = rows.find((r) => r.id === mine);
		expect(mineRow?.ownerUsername).toBe(adminName);
		expect(mineRow?.myPersonalEntryId).toBe(draft.id);
		expect(mineRow?.myPersonalEntryBehindMain).toBe(false);
		expect(rows.find((r) => r.id === other)).toMatchObject({
			ownerUsername: null,
			myPersonalEntryId: null,
			myPersonalEntryBehindMain: false,
		});
		// Main moves on → the personal version is behind.
		await knowledgeService.addRevision(mine, {
			content: "new main",
			authorUserId: adminId,
			principal: P(adminId, "admin"),
		});
		rows = await read();
		expect(rows.find((r) => r.id === mine)?.myPersonalEntryBehindMain).toBe(true);
	});

	test("q branch applies level/status filters and the title order", async () => {
		const col = await newCollection("route-q");
		const needle = `needle${TAG}`;
		const zeta = await seedEntry(col.id, `zeta ${needle}`);
		const alpha = await seedEntry(col.id, `alpha ${needle}`);
		const conf = await seedEntry(col.id, `mid ${needle}`, { classificationLevel: "confidential" });
		const app = appFor({ userId: adminId, role: "admin" });
		const q = encodeURIComponent(needle);
		const all = (await (
			await app.request(`/knowledge/entries?q=${q}&collectionId=${col.id}&limit=20&sort=title`)
		).json()) as Page;
		expect(all.items.map((r) => r.id)).toEqual([alpha, conf, zeta]);
		expect(all.nextCursor).toBeNull();
		const onlyConf = (await (
			await app.request(
				`/knowledge/entries?q=${q}&collectionId=${col.id}&limit=20&level=confidential`,
			)
		).json()) as Page;
		expect(onlyConf.items.map((r) => r.id)).toEqual([conf]);
		const archived = (await (
			await app.request(`/knowledge/entries?q=${q}&collectionId=${col.id}&limit=20&status=archived`)
		).json()) as Page;
		expect(archived.items).toEqual([]);
	});
});

describe("GET /knowledge/entries/:id read-page fields", () => {
	test("carries the owner's username and the current version number", async () => {
		const col = await newCollection("detail");
		const id = await seedEntry(col.id, "detail", { ownerUserId: adminId });
		const app = appFor({ userId: adminId, role: "admin" });
		const read = async () =>
			(await (await app.request(`/knowledge/entries/${id}`)).json()) as {
				ownerUsername: string | null;
				currentVersion: number | null;
			};
		expect(await read()).toMatchObject({ ownerUsername: adminName, currentVersion: 1 });
		await knowledgeService.addRevision(id, {
			content: "v2",
			authorUserId: adminId,
			principal: P(adminId, "admin"),
		});
		expect((await read()).currentVersion).toBe(2);
	});
});
