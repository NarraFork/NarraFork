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
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, narratorProjectLinks, narrators, projects, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { readOutlineTreeSpaceFacts, readOutlineTreeSpacePage } from "../access-reads";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { writeOutline } from "../write";

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
	options: {
		projectId?: string;
		visibility?: "private" | "project" | "public";
		archived?: boolean;
	} = {},
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

describe("permission edges", () => {
	test("a public session of someone's private project is loose to a stranger, without a parent", async () => {
		const owner = await user();
		const stranger = await user();
		const p = await project(owner);
		const s = await session(owner, { projectId: p.id, visibility: "public" });
		const loose = await get<OutlineTreeSpacesResponse>(stranger, "/tree/loose");
		expect(loose.spaces.map((x) => x.id)).toContain(s.space);
		const root = await get<OutlineTreeResponse>(stranger, "/tree");
		expect(root.projects.map((x) => x.id)).not.toContain(p.space);
		const detail = await get<OutlineSpaceDetailResponse>(stranger, `/spaces/${s.space}`);
		expect(detail.space.parent ?? null).toBeNull();
		// The owner reads both: under the project, not loose.
		const ownerLoose = await get<OutlineTreeSpacesResponse>(owner, "/tree/loose");
		expect(ownerLoose.spaces.map((x) => x.id)).not.toContain(s.space);
	});

	test("a session's owner who loses read on its project loses the project crumb", async () => {
		const other = await user();
		const me = await user();
		const p = await project(other);
		await grant("project", p.id, me);
		const s = await session(me, { projectId: p.id, visibility: "public" });
		const before = await get<OutlineSpaceDetailResponse>(me, `/spaces/${s.space}`);
		expect(before.space.parent?.spaceId).toBe(p.space);
		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeId, p.id), eq(aclGrants.principalId, me)));
		const after = await get<OutlineSpaceDetailResponse>(me, `/spaces/${s.space}`);
		expect(after.space.parent ?? null).toBeNull();
		expect(await status(me, `/tree/projects/${p.id}/sessions`)).toBe(404);
		const loose = await get<OutlineTreeSpacesResponse>(me, "/tree/loose");
		expect(loose.spaces.map((x) => x.id)).toContain(s.space);
	});

	test("an archived project is not listed, nor are its sessions among the loose ones", async () => {
		const owner = await user();
		const p = await project(owner);
		const s = await session(owner, { projectId: p.id });
		await db.run(sql`update projects set status = 'archived' where id = ${p.id}`);
		const root = await get<OutlineTreeResponse>(owner, "/tree");
		expect(root.projects.map((x) => x.id)).not.toContain(p.space);
		const loose = await get<OutlineTreeSpacesResponse>(owner, "/tree/loose");
		expect(loose.spaces.map((x) => x.id)).not.toContain(s.space);
		// Still there for whoever opens the project by URL.
		const sessions = await get<OutlineTreeSpacesResponse>(owner, `/tree/projects/${p.id}/sessions`);
		expect(sessions.spaces.map((x) => x.id)).toEqual([s.space]);
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

	test("a commit between two pages never shows a space twice", async () => {
		const owner = await user();
		const p = await project(owner);
		const made: string[] = [];
		for (let i = 0; i < 6; i++) {
			const s = await session(owner, { projectId: p.id });
			made.push(s.space);
			await committedAt(s.space, `2026-11-0${i + 1}T00:00:00.000Z`);
		}
		const principal = { userId: owner, isAdmin: false };
		const scope = { kind: "project" as const, projectId: p.id };
		const first = await readOutlineTreeSpacePage(principal, scope, { after: null, limit: 3 });
		expect(first.map((r) => r.id)).toEqual([made[5], made[4], made[3]]);
		// Commits land on a space already shown and on one not shown yet: both move to the front.
		await committedAt(made[4] as string, "2026-11-20T00:00:00.000Z");
		await committedAt(made[1] as string, "2026-11-21T00:00:00.000Z");
		const last = first.at(-1) as (typeof first)[number];
		const rest = await readOutlineTreeSpacePage(principal, scope, {
			after: { lastCommitAt: last.lastCommitAt, id: last.id },
			limit: 10,
		});
		const seen = [...first, ...rest].map((r) => r.id);
		expect(new Set(seen).size).toBe(seen.length);
		// The one that moved ahead of the cursor is for the next read from the top.
		expect(rest.map((r) => r.id)).toEqual([made[2], made[0]]);
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

/** A page with tasks and questions put to people, written by `author`. */
async function work(
	spaceId: string,
	author: string,
	items: ReadonlyArray<
		| { task: "todo" | "doing" | "done" | "cancelled"; title: string; alias?: string }
		| { ask: string; title: string }
		| { note: string; alias?: string }
	>,
) {
	const written = await writeOutline({
		spaceId,
		ops: [
			{ op: "insert", tempId: "page", parent: null, content: "Work" },
			...items.map((item) =>
				"task" in item
					? ({
							op: "insert",
							parent: { tempId: "page" },
							content: item.title,
							task: { status: item.task },
						} as const)
					: "ask" in item
						? ({
								op: "insert",
								parent: { tempId: "page" },
								content: item.title,
								ask: { to: { kind: "human", id: item.ask }, recommend: {} },
							} as const)
						: ({
								op: "insert",
								parent: { tempId: "page" },
								content: item.note,
								alias: item.alias ?? null,
							} as const),
			),
		],
		actor: { kind: "human", id: author },
		responsibleUserId: author,
	});
	return written.results.map((r) => (r as { blockId: string }).blockId);
}

describe("what a row says (readability F)", () => {
	test("questions waiting for the reader, tasks in progress, one line, and whether they may write", async () => {
		const owner = await user();
		const reader = await user();
		const p = await project(owner);
		await grant("project", p.id, reader);
		const s = await session(owner, { projectId: p.id, visibility: "project" });
		await work(s.space, owner, [
			{ task: "doing", title: "Fix the refresh race" },
			{ task: "doing", title: "Add the regression test" },
			{ task: "todo", title: "Later" },
			{ task: "done", title: "Read the code" },
			{ ask: owner, title: "Which lock order?" },
			{ ask: owner, title: "Keep the old flag?" },
			{ ask: reader, title: "Is the copy fine?" },
		]);

		const forOwner = await get<OutlineTreeSpacesResponse>(owner, `/tree/projects/${p.id}/sessions`);
		const mine = forOwner.spaces[0];
		expect(mine?.canWrite).toBe(true);
		expect(mine?.waiting).toBe(2);
		expect(mine?.doing).toBe(2);
		expect(mine?.summary?.kind).toBe("doing");
		expect(["Fix the refresh race", "Add the regression test"]).toContain(
			mine?.summary?.text ?? "",
		);

		// The reader may read the session, not write it: the question put to them is not theirs
		// to answer there, so nothing waits; the row says read-only.
		const forReader = await get<OutlineTreeSpacesResponse>(
			reader,
			`/tree/projects/${p.id}/sessions`,
		);
		const theirs = forReader.spaces[0];
		expect(theirs?.canWrite).toBe(false);
		expect(theirs?.waiting).toBe(0);
		expect(theirs?.doing).toBe(2);
	});

	test("the line: a block aliased summary first, else the task being done, else the one finished last", async () => {
		const me = await user();
		const a = await session(me);
		const b = await session(me);
		const c = await session(me);
		const empty = await session(me);
		await work(a.space, me, [
			{ task: "doing", title: "Doing now" },
			{ note: "Outline phase two: tasks and teams", alias: "summary" },
		]);
		// (Two commits: within one, which task finished last is not said.)
		await work(b.space, me, [{ task: "done", title: "Finished first" }]);
		await work(b.space, me, [{ task: "cancelled", title: `Finished last ${"x".repeat(200)}` }]);
		await work(c.space, me, [{ task: "todo", title: "Nothing started" }]);
		const loose = await get<OutlineTreeSpacesResponse>(me, "/tree/loose");
		const by = new Map(loose.spaces.map((space) => [space.id, space]));
		expect(by.get(a.space)?.summary).toEqual({
			kind: "note",
			text: "Outline phase two: tasks and teams",
		});
		expect(by.get(b.space)?.summary?.kind).toBe("finished");
		expect(by.get(b.space)?.summary?.text.startsWith("Finished last")).toBe(true);
		expect(Array.from(by.get(b.space)?.summary?.text ?? "").length).toBe(80);
		expect(by.get(c.space)?.summary).toBeNull();
		expect(by.get(c.space)?.doing).toBe(0);
		expect(by.get(empty.space)?.summary).toBeNull();
		expect(by.get(empty.space)?.waiting).toBe(0);
	});

	test("counts stop at the cap, skip deleted blocks, and say nothing of a space not asked for", async () => {
		const me = await user();
		const a = await session(me);
		const other = await session(me);
		const ids = await work(a.space, me, [
			{ task: "doing", title: "one" },
			{ task: "doing", title: "two" },
			{ task: "doing", title: "three" },
			{ ask: me, title: "q1" },
			{ ask: me, title: "q2" },
		]);
		await work(other.space, me, [{ task: "doing", title: "elsewhere" }]);
		await writeOutline({
			spaceId: a.space,
			ops: [
				{ op: "delete", block: { id: ids[1] as string } },
				{ op: "delete", block: { id: ids[4] as string } },
			],
			actor: { kind: "human", id: me },
			responsibleUserId: me,
		});
		const facts = await readOutlineTreeSpaceFacts(me, [a.space], 100);
		expect([...facts.keys()]).toEqual([a.space]);
		expect(facts.get(a.space)?.doing).toBe(2);
		expect(facts.get(a.space)?.waiting).toBe(1);
		const capped = await readOutlineTreeSpaceFacts(me, [a.space], 1);
		expect(capped.get(a.space)?.doing).toBe(1);
		expect(capped.get(a.space)?.waiting).toBe(1);
		expect(await readOutlineTreeSpaceFacts(me, [], 100)).toEqual(new Map());
	});

	test("the root's rows carry the same, and a project the reader cannot read adds nothing", async () => {
		const me = await user();
		const other = await user();
		const mine = await project(me);
		const hidden = await project(other);
		await work(mine.space, me, [{ task: "doing", title: "Ship it" }]);
		await work(hidden.space, other, [
			{ task: "doing", title: "Secret work" },
			{ ask: me, title: "A question in a place I cannot read" },
		]);
		const root = await get<OutlineTreeResponse>(me, "/tree");
		expect(root.projects.map((s) => s.id)).not.toContain(hidden.space);
		const row = root.projects.find((s) => s.id === mine.space);
		expect(row?.doing).toBe(1);
		expect(row?.waiting).toBe(0);
		expect(row?.canWrite).toBe(true);
		expect(row?.summary).toEqual({ kind: "doing", text: "Ship it" });
		expect(JSON.stringify(root)).not.toContain("Secret work");
	});

	test("each subquery of the row facts is served by an index, never a scan of blocks", async () => {
		const me = await user();
		const a = await session(me);
		const plan = db.all<{ detail: string }>(sql`explain query plan
			select s.id,
				(select count(*) from (
					select 1 as one from outline_questions q join outline_blocks b on b.id = q.block_id
					where q.space_id = s.id and q.state = 'open' and q.to_user_id = ${me} and b."deleted" = 0
					limit 100) t) as waiting,
				(select count(*) from (
					select 1 as one from outline_blocks b where b.space_id = s.id
						and b."deleted" = 0 AND (json_extract(b."task_json", '$.status') = 'doing' OR (json_extract(b."task_json", '$.status') = 'todo' AND json_extract(b."task_json", '$.lock') IS NOT NULL)) AND json_extract(b."task_json", '$.status') = 'doing'
					limit 100) t) as doing,
				(select b.id from outline_blocks b where b.space_id = s.id
					and json_extract(b."task_json", '$.status') IN ('done', 'cancelled') AND b."deleted" = 0
					order by b.version_seq desc, b.id desc limit 1) as finished_id,
				(select b.id from outline_blocks b where b.space_id = s.id and b.alias = 'summary'
					and b."deleted" = 0 limit 1) as summary_id
			from outline_spaces s where s.id in (${a.space})`);
		const details = plan.map((row) => row.detail).join("\n");
		expect(details).not.toMatch(/SCAN (b|q|outline_blocks|outline_questions)\b/);
		expect(details).toContain("idx_outline_questions_space_open");
		expect(details).toContain("idx_outline_blocks_active_tasks");
		expect(details).toContain("idx_outline_blocks_finished_tasks");
		expect(details).toContain("uq_outline_blocks_space_alias");
	});
});
