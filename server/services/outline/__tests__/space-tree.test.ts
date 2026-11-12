/**
 * The connected outline (readability E) on SQLite: the tree's listings and their gates
 * (`/api/outline/tree`, `/tree/projects/:id/sessions`, `/tree/loose`, `/tree/orphaned`) and the
 * project crumb of a session space (`/spaces/:id`'s `parent`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own people,
 * projects and sessions. `outline.enabled` is switched on before each case.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type {
	OutlineSpaceDetailResponse,
	OutlineTreeResponse,
	OutlineTreeSpacesResponse,
} from "@shared/outline-api";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, narratorProjectLinks, narrators, projects, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { readOutlineTreeSpacePage } from "../access-reads";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";

const NOW = "2026-11-03T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
});

async function user(admin = false): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `tree${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: admin ? "admin" : "user",
		createdAt: NOW,
	});
	return id;
}

async function project(owner: string, visibility: "private" | "public" = "private") {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `tree-${id}`,
		ownerUserId: owner,
		visibility,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { id, space: (await ensureProjectSpace(id)).id };
}

async function session(
	owner: string,
	options: { projectId?: string; visibility?: "private" | "project"; archived?: boolean } = {},
) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: `tree session ${id}`,
		ownerUserId: owner,
		visibility: options.visibility ?? "private",
		writeAudience: "owner",
		contextProjectId: options.projectId ?? null,
		taskBackend: "outline",
		status: options.archived ? "archived" : "idle",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { id, space: (await ensureSessionSpace(id)).id };
}

async function grant(scopeType: "project" | "narrator", scopeId: string, userId: string) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType,
		scopeId,
		principalType: "user",
		principalId: userId,
		capability: "read",
		createdAt: NOW,
	});
}

async function committedAt(spaceId: string, at: string) {
	await db.run(sql`update outline_spaces set last_commit_at = ${at} where id = ${spaceId}`);
}

function app(userId: string, admin = false) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", {
			sub: userId,
			role: admin ? "admin" : "user",
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/outline", outlineRoutes);
	return instance;
}

async function get<T>(userId: string, path: string, admin = false): Promise<T> {
	const res = await app(userId, admin).request(`http://localhost/outline${path}`);
	if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
	return (await res.json()) as T;
}

function status(userId: string, path: string, admin = false): Promise<number> {
	return Promise.resolve(app(userId, admin).request(`http://localhost/outline${path}`)).then(
		(res) => res.status,
	);
}

describe("the tree's root", () => {
	test("my space first, then the projects I may read, latest commit first", async () => {
		const me = await user();
		const other = await user();
		const personal = await ensurePersonalSpace(me);
		const older = await project(me);
		const newer = await project(me);
		const never = await project(me);
		const hidden = await project(other);
		await committedAt(older.space, "2026-11-01T00:00:00.000Z");
		await committedAt(newer.space, "2026-11-02T00:00:00.000Z");
		await committedAt(hidden.space, "2026-11-05T00:00:00.000Z");

		const root = await get<OutlineTreeResponse>(me, "/tree");
		expect(root.personal?.id).toBe(personal.id);
		const ids = root.projects.map((s) => s.id);
		// Never committed comes after the committed ones; another person's private project is
		// neither listed nor counted anywhere.
		expect(ids.indexOf(newer.space)).toBeLessThan(ids.indexOf(older.space));
		expect(ids.indexOf(older.space)).toBeLessThan(ids.indexOf(never.space));
		expect(ids).not.toContain(hidden.space);
		expect(root.projects.find((s) => s.id === newer.space)?.lastCommitAt).toBe(
			"2026-11-02T00:00:00.000Z",
		);
		expect(root.orphaned).toBe(0);
	});

	test("a project counts only the sessions the reader may read; archived ones not at all", async () => {
		const owner = await user();
		const reader = await user();
		const p = await project(owner);
		await grant("project", p.id, reader);
		await session(owner, { projectId: p.id, visibility: "project" });
		await session(owner, { projectId: p.id, visibility: "private" });
		await session(owner, { projectId: p.id, visibility: "project", archived: true });

		const forOwner = await get<OutlineTreeResponse>(owner, "/tree");
		expect(forOwner.projects.find((s) => s.id === p.space)?.sessions).toBe(2);
		const forReader = await get<OutlineTreeResponse>(reader, "/tree");
		expect(forReader.projects.find((s) => s.id === p.space)?.sessions).toBe(1);

		const sessions = await get<OutlineTreeSpacesResponse>(
			reader,
			`/tree/projects/${p.id}/sessions`,
		);
		expect(sessions.spaces).toHaveLength(1);
		expect(sessions.spaces[0]?.kind).toBe("session");
		expect(sessions.spaces[0]?.label).toMatch(/^tree session /);
	});
});

describe("where a session hangs", () => {
	test("under its project for those who read the project; a session of no project is loose", async () => {
		const owner = await user();
		const guest = await user();
		const p = await project(owner);
		const s = await session(owner, { projectId: p.id });
		const free = await session(owner);
		await grant("narrator", s.id, guest);
		await grant("narrator", free.id, guest);

		// The owner reads both: the session is the project's, not a loose one.
		const ownerSessions = await get<OutlineTreeSpacesResponse>(
			owner,
			`/tree/projects/${p.id}/sessions`,
		);
		expect(ownerSessions.spaces.map((x) => x.id)).toEqual([s.space]);
		const ownerLoose = await get<OutlineTreeSpacesResponse>(owner, "/tree/loose");
		expect(ownerLoose.spaces.map((x) => x.id)).toContain(free.space);
		expect(ownerLoose.spaces.map((x) => x.id)).not.toContain(s.space);
		const ownerSpace = await get<OutlineSpaceDetailResponse>(owner, `/spaces/${s.space}`);
		expect(ownerSpace.space.parent?.spaceId).toBe(p.space);
		expect(ownerSpace.space.parent?.label).toBe(`tree-${p.id}`);
		const freeSpace = await get<OutlineSpaceDetailResponse>(owner, `/spaces/${free.space}`);
		expect(freeSpace.space.parent ?? null).toBeNull();

		// The guest: the private project gates its session (a grant on the session does not pass
		// the gate), so neither is listed, counted or named; the session of no project is theirs.
		expect(await status(guest, `/tree/projects/${p.id}/sessions`)).toBe(404);
		const guestRoot = await get<OutlineTreeResponse>(guest, "/tree");
		expect(guestRoot.projects.map((x) => x.id)).not.toContain(p.space);
		expect(guestRoot.loose).toBe(1);
		const guestLoose = await get<OutlineTreeSpacesResponse>(guest, "/tree/loose");
		expect(guestLoose.spaces.map((x) => x.id)).toEqual([free.space]);
		expect(await status(guest, `/spaces/${s.space}`)).toBe(404);
	});

	test("a session is under its primary project only, not one it is merely linked to", async () => {
		const owner = await user();
		const primary = await project(owner);
		const extra = await project(owner);
		const s = await session(owner);
		for (const [projectId, role] of [
			[primary.id, "primary"],
			[extra.id, "additional"],
		] as const) {
			await db.insert(narratorProjectLinks).values({
				narratorId: s.id,
				projectId,
				role,
				source: "cwd",
				updatedAt: NOW,
			});
		}
		const underPrimary = await get<OutlineTreeSpacesResponse>(
			owner,
			`/tree/projects/${primary.id}/sessions`,
		);
		expect(underPrimary.spaces.map((x) => x.id)).toEqual([s.space]);
		const underExtra = await get<OutlineTreeSpacesResponse>(
			owner,
			`/tree/projects/${extra.id}/sessions`,
		);
		expect(underExtra.spaces).toEqual([]);
	});
});

describe("paging", () => {
	test("pages run through committed spaces, then the never committed, without repeats", async () => {
		const owner = await user();
		const p = await project(owner);
		const made: string[] = [];
		for (let i = 0; i < 7; i++) {
			const s = await session(owner, { projectId: p.id });
			made.push(s.space);
			// Two share a time (the id breaks the tie); three are never committed.
			if (i < 4) await committedAt(s.space, `2026-11-0${Math.min(i, 2) + 1}T00:00:00.000Z`);
		}
		const principal = { userId: owner, isAdmin: false };
		const seen: string[] = [];
		let after: { lastCommitAt: string | null; id: string } | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const rows = await readOutlineTreeSpacePage(
				principal,
				{ kind: "project", projectId: p.id },
				{ after, limit: 2 },
			);
			if (rows.length === 0) break;
			seen.push(...rows.map((r) => r.id));
			const last = rows.at(-1) as (typeof rows)[number];
			after = { lastCommitAt: last.lastCommitAt, id: last.id };
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect([...seen].sort()).toEqual([...made].sort());
		// Latest commit first.
		expect(seen.slice(0, 4).map((id) => made.indexOf(id))).toEqual(
			[...seen.slice(0, 4).map((id) => made.indexOf(id))].sort((a, b) => {
				const t = (i: number) => Math.min(i, 2);
				return t(b) - t(a);
			}),
		);
	});

	test("the route pages twenty at a time with a cursor, and refuses a bad one", async () => {
		const owner = await user();
		const p = await project(owner);
		for (let i = 0; i < 21; i++) await session(owner, { projectId: p.id });
		const first = await get<OutlineTreeSpacesResponse>(owner, `/tree/projects/${p.id}/sessions`);
		expect(first.spaces).toHaveLength(20);
		expect(first.nextCursor).not.toBeNull();
		const second = await get<OutlineTreeSpacesResponse>(
			owner,
			`/tree/projects/${p.id}/sessions?cursor=${first.nextCursor}`,
		);
		expect(second.spaces).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(first.spaces.map((s) => s.id)).not.toContain(second.spaces[0]?.id);
		expect(await status(owner, `/tree/projects/${p.id}/sessions?cursor=bad`)).toBe(400);
		expect(await status(owner, "/tree?cursor=bad")).toBe(400);
	});
});

describe("spaces without an owner", () => {
	test("only admins see them", async () => {
		const owner = await user();
		const admin = await user(true);
		const p = await project(owner);
		await db.run(sql`update outline_spaces set project_id = null where id = ${p.space}`);
		const forAdmin = await get<OutlineTreeSpacesResponse>(admin, "/tree/orphaned", true);
		expect(forAdmin.spaces.map((s) => s.id)).toContain(p.space);
		const adminRoot = await get<OutlineTreeResponse>(admin, "/tree", true);
		expect(adminRoot.orphaned).toBeGreaterThanOrEqual(1);
		expect(adminRoot.projects.map((s) => s.id)).not.toContain(p.space);
		const forOwner = await get<OutlineTreeSpacesResponse>(owner, "/tree/orphaned");
		expect(forOwner.spaces).toEqual([]);
	});
});
