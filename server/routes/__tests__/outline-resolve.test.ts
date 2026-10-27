/**
 * `GET /api/outline/resolve`: what a tool card's address or commit names, as a place to open.
 *
 * What must hold:
 *  - a `key/sid` address, a bare sid or alias within `space` (key or id), and a commit seq of
 *    `space` resolve to the block and its page (a commit to the first page it changed, `asOf`);
 *  - a space the caller cannot read answers exactly like a missing space, block or commit, and
 *    so does a reference that names nothing in the space; nothing outside the named space is
 *    consulted;
 *  - malformed queries are 400; with `outline.enabled` off the route is a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { OutlineResolveResponse } from "@shared/outline-api";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { ensurePersonalSpace, ensureProjectSpace } from "../../services/outline/spaces";
import type { OutlineSpaceRow } from "../../services/outline/store/port";
import { writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-10-27T00:00:00.000Z";

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function resolve(
	userId: string,
	query: Record<string, string | undefined>,
): Promise<{ status: number; body: OutlineResolveResponse & { code?: string } }> {
	const defined = Object.entries(query).filter((entry): entry is [string, string] => !!entry[1]);
	const search = new URLSearchParams(defined).toString();
	const response = await appAs(userId).request(`http://localhost/outline/resolve?${search}`);
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as OutlineResolveResponse & { code?: string } };
}

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

let alice: string;
let bob: string;
let carol: string;
let space: OutlineSpaceRow;
let personal: OutlineSpaceRow;
let page: { id: string; sid: string };
let child: { id: string; sid: string; alias: string };
let personalBlock: { id: string; sid: string };
let firstSeq: number;
let secondSeq: number;

beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Resolve project",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: NOW,
	});
	space = await ensureProjectSpace(projectId);
	const first = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Design" },
			{ op: "insert", tempId: "c", parent: { tempId: "p" }, content: "Token refresh", alias: "Q7" },
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	firstSeq = first.commit?.seq as number;
	const [pageResult, childResult] = first.results;
	page = { id: pageResult?.blockId as string, sid: pageResult?.sid as string };
	child = { id: childResult?.blockId as string, sid: childResult?.sid as string, alias: "Q7" };
	const second = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", parent: { id: page.id }, content: "Second" }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	secondSeq = second.commit?.seq as number;
	personal = await ensurePersonalSpace(alice);
	const mine = await writeOutline({
		spaceId: personal.id,
		ops: [{ op: "insert", parent: null, content: "Private note" }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	personalBlock = {
		id: mine.results[0]?.blockId as string,
		sid: mine.results[0]?.sid as string,
	};
});

describe("found", () => {
	test("a key/sid address resolves to the block and its page", async () => {
		const res = await resolve(bob, { ref: `${space.key}/${child.sid}` });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			spaceId: space.id,
			spaceKey: space.key,
			blockId: child.id,
			pageId: page.id,
			isPage: false,
			address: `${space.key}/${child.sid}`,
			title: "Token refresh",
			deleted: false,
		});
	});

	test("a bare sid or alias resolves within the space named by key or id", async () => {
		for (const named of [space.key, space.id]) {
			const bySid = await resolve(bob, { ref: page.sid, space: named });
			expect(bySid.body).toMatchObject({ blockId: page.id, pageId: page.id, isPage: true });
			const byAlias = await resolve(bob, { ref: child.alias, space: named });
			expect(byAlias.body).toMatchObject({ blockId: child.id, pageId: page.id });
		}
		expect((await resolve(bob, { ref: `${space.key}/${child.alias}` })).body.blockId).toBe(
			child.id,
		);
	});

	test("a commit resolves to the page it changed, shown as of the commit", async () => {
		for (const seq of [firstSeq, secondSeq]) {
			const res = await resolve(bob, { space: space.key, commit: String(seq) });
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				spaceId: space.id,
				blockId: page.id,
				pageId: page.id,
				isPage: true,
				address: `${space.key}/${page.sid}`,
				title: "Design",
				asOf: seq,
			});
		}
	});
});

describe("missing and unreadable answer alike", () => {
	test("no such block, space or commit", async () => {
		for (const query of [
			{ ref: `${space.key}/Zz9Zz9Zz` },
			{ ref: "Zz9Zz9Zz", space: space.key },
			{ ref: `Nokey000/${child.sid}` },
			{ ref: child.sid, space: "missing-space" },
			{ ref: child.sid },
			{ space: space.key, commit: "999999" },
			{ space: "missing-space", commit: String(firstSeq) },
		]) {
			const res = await resolve(bob, query);
			expect({ query, status: res.status, code: res.body.code }).toEqual({
				query,
				status: 404,
				code: "NOT_FOUND",
			});
		}
	});

	test("a space the caller cannot read is a 404 like a missing one", async () => {
		const unreadable = [
			{ ref: `${space.key}/${child.sid}` },
			{ ref: child.sid, space: space.id },
			{ space: space.key, commit: String(firstSeq) },
		];
		for (const query of unreadable) {
			const res = await resolve(carol, query);
			expect({ query, status: res.status, code: res.body.code }).toEqual({
				query,
				status: 404,
				code: "NOT_FOUND",
			});
		}
		// Someone else's personal space, even by its exact address.
		const other = await resolve(bob, { ref: `${personal.key}/${personalBlock.sid}` });
		expect(other.status).toBe(404);
		expect((await resolve(alice, { ref: `${personal.key}/${personalBlock.sid}` })).status).toBe(
			200,
		);
	});

	test("nothing outside the named space is consulted", async () => {
		// The child's sid exists, but not in Alice's personal space.
		const res = await resolve(alice, { ref: child.sid, space: personal.key });
		expect(res.status).toBe(404);
	});
});

describe("requests", () => {
	test("malformed queries are refused", async () => {
		for (const query of [
			{},
			{ ref: "x", space: space.key, commit: "1" },
			{ commit: "1" },
			{ space: space.key, commit: "-1" },
			{ ref: "x".repeat(301) },
		]) {
			expect((await resolve(bob, query)).status).toBe(400);
		}
	});

	test("with the outline off the route is a plain 404", async () => {
		settings.outline.enabled = false;
		try {
			const res = await resolve(bob, { ref: `${space.key}/${child.sid}` });
			expect(res.status).toBe(404);
			expect(res.body as unknown).toBe("404 Not Found");
		} finally {
			settings.outline.enabled = true;
		}
	});
});
