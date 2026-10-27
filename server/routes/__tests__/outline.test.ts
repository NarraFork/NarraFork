/**
 * The outline HTTP API.
 *
 * What must hold:
 *  - with `outline.enabled` off every route is a plain 404;
 *  - a space the caller cannot read is 404, exactly like one that does not exist, and so is
 *    every block, page and commit in it; readable but not writable is 403 for a revert;
 *  - project and session spaces are created lazily only by someone who may write them;
 *  - reads as of a seq or a time show that state; budgets and the facts view report what they
 *    left out; timelines and histories page by cursor; search and backlinks stay inside the
 *    caller's readable spaces.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type {
	OutlineBacklinksResponse,
	OutlineBlockHistoryResponse,
	OutlineBlockViewResponse,
	OutlinePageListResponse,
	OutlineRevertResponse,
	OutlineSearchResponse,
	OutlineSpaceDetailResponse,
	OutlineSpaceListResponse,
	OutlineSpaceResolveResponse,
	OutlineTimelineResponse,
} from "@shared/outline-api";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { ensurePersonalSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
import type { OutlineSpaceRow } from "../../services/outline/store/port";
import { type OutlineOp, writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-10-26T00:00:00.000Z";

type Role = "admin" | "user";

function appAs(userId: string, role: Role) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

async function call<T = Record<string, unknown>>(
	who: { id: string; role: Role },
	path: string,
	method: "GET" | "POST" = "GET",
): Promise<{ status: number; body: T }> {
	const response = await appAs(who.id, who.role).request(`http://localhost/outline${path}`, {
		method,
	});
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as T };
}

async function user(label: string, role: Role = "user") {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
	return { id, role };
}

let alice: { id: string; role: Role };
let bob: { id: string; role: Role };
let carol: { id: string; role: Role };
let admin: { id: string; role: Role };
let projectId: string;
let narratorId: string;
let projectSpace: OutlineSpaceRow;
/** Pages and blocks written into the project space. */
let page: string;
let factA: string;
let task: string;
let underTask: string;
let factAddress: string;
const seqs: number[] = [];
const commitIds: string[] = [];

async function write(space: OutlineSpaceRow, ops: OutlineOp[], actorId = alice.id) {
	const result = await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: actorId },
		responsibleUserId: actorId,
	});
	if (result.commit) {
		seqs.push(result.commit.seq);
		commitIds.push(result.commit.id);
	}
	return result;
}

// The preload restores settings after every test.
beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	admin = await user("admin", "admin");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Outline project",
		ownerUserId: alice.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob.id,
		capability: "read",
		createdAt: NOW,
	});
	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: "Alice's session",
		ownerUserId: alice.id,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		createdAt: NOW,
		updatedAt: NOW,
	});
});

describe("the outline switch", () => {
	test("every route is a plain 404 while outline.enabled is off", async () => {
		settings.outline.enabled = false;
		try {
			for (const [path, method] of [
				["/spaces", "GET"],
				["/spaces/personal", "POST"],
				["/search?q=anything", "GET"],
				["/spaces/x/blocks/y", "GET"],
				["/commits/x/revert", "POST"],
			] as const) {
				const res = await call(alice, path, method);
				expect(res.status).toBe(404);
				expect(res.body as unknown).toBe("404 Not Found");
			}
		} finally {
			settings.outline.enabled = true;
		}
	});
});

describe("spaces", () => {
	test("a project space is created lazily, only by someone who may write the project", async () => {
		expect((await call(carol, `/projects/${projectId}/space`, "POST")).status).toBe(404);
		expect((await call(carol, `/projects/missing/space`, "POST")).status).toBe(404);
		const forReader = await call<OutlineSpaceResolveResponse>(
			bob,
			`/projects/${projectId}/space`,
			"POST",
		);
		expect(forReader.status).toBe(200);
		expect(forReader.body).toEqual({ space: null, created: false });

		const forOwner = await call<OutlineSpaceResolveResponse>(
			alice,
			`/projects/${projectId}/space`,
			"POST",
		);
		expect(forOwner.body.created).toBe(true);
		expect(forOwner.body.space).toMatchObject({
			kind: "project",
			projectId,
			label: "Outline project",
			mine: false,
			orphaned: false,
			lastSeq: 0,
		});
		const again = await call<OutlineSpaceResolveResponse>(
			bob,
			`/projects/${projectId}/space`,
			"POST",
		);
		expect(again.body).toMatchObject({ created: false, space: { id: forOwner.body.space?.id } });
		projectSpace = (await outlineStore.getSpace(forOwner.body.space?.id as string)) as never;
	});

	test("a session space follows the session's audiences", async () => {
		expect((await call(bob, `/narrators/${narratorId}/space`, "POST")).status).toBe(404);
		const created = await call<OutlineSpaceResolveResponse>(
			alice,
			`/narrators/${narratorId}/space`,
			"POST",
		);
		expect(created.body).toMatchObject({
			created: true,
			space: { kind: "session", narratorId, label: "Alice's session" },
		});
		const byAdmin = await call<OutlineSpaceResolveResponse>(
			admin,
			`/narrators/${narratorId}/space`,
			"POST",
		);
		expect(byAdmin.body.space?.id).toBe(created.body.space?.id as string);
	});

	test("the personal space is the caller's own and created once", async () => {
		const first = await call<OutlineSpaceResolveResponse>(alice, "/spaces/personal", "POST");
		expect(first.body).toMatchObject({ created: true, space: { kind: "personal", mine: true } });
		const second = await call<OutlineSpaceResolveResponse>(alice, "/spaces/personal", "POST");
		expect(second.body).toMatchObject({ created: false, space: { id: first.body.space?.id } });
		// Not even an admin reads someone else's personal space.
		const personalId = first.body.space?.id as string;
		expect((await call(admin, `/spaces/${personalId}`)).status).toBe(404);
		expect((await call(bob, `/spaces/${personalId}`)).status).toBe(404);
	});

	test("the list holds the readable spaces only, a page at a time", async () => {
		const forAlice = await call<OutlineSpaceListResponse>(alice, "/spaces?limit=200");
		const kinds = forAlice.body.spaces.map((s) => s.kind).sort();
		expect(kinds).toEqual(["personal", "project", "session"]);
		const forBob = await call<OutlineSpaceListResponse>(bob, "/spaces?limit=200");
		expect(forBob.body.spaces.map((s) => s.id)).toEqual([projectSpace.id]);
		const forCarol = await call<OutlineSpaceListResponse>(carol, "/spaces");
		expect(forCarol.body.spaces).toEqual([]);

		const ids: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 5; i++) {
			const res: { body: OutlineSpaceListResponse } = await call<OutlineSpaceListResponse>(
				alice,
				`/spaces?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
			);
			ids.push(...res.body.spaces.map((s) => s.id));
			cursor = res.body.nextCursor;
			if (!cursor) break;
		}
		expect(ids.sort()).toEqual(forAlice.body.spaces.map((s) => s.id).sort());
		expect((await call(alice, "/spaces?limit=0")).status).toBe(400);
	});

	test("space detail says whether the caller may write; unreadable is 404", async () => {
		const owner = await call<OutlineSpaceDetailResponse>(alice, `/spaces/${projectSpace.id}`);
		expect(owner.body.space.canWrite).toBe(true);
		const reader = await call<OutlineSpaceDetailResponse>(bob, `/spaces/${projectSpace.id}`);
		expect(reader.body.space.canWrite).toBe(false);
		expect((await call(carol, `/spaces/${projectSpace.id}`)).status).toBe(404);
		expect((await call(carol, "/spaces/no-such-space")).status).toBe(404);
	});
});

describe("reading", () => {
	beforeAll(async () => {
		const first = await write(projectSpace, [
			{ op: "insert", tempId: "p", parent: null, content: "Design notes" },
			{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "Fact A, first draft" },
			{ op: "insert", tempId: "b", parent: { tempId: "a" }, content: "Detail under A" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "a" },
				content: "Check A again",
				task: { status: "todo" },
			},
			{ op: "insert", tempId: "u", parent: { tempId: "t" }, content: "Progress note" },
			{ op: "insert", tempId: "c", parent: { tempId: "p" }, content: "Fact C" },
		]);
		const ids = first.results.map((r) => r.blockId);
		[page, factA, , task, underTask] = ids as [string, string, string, string, string];
		factAddress = first.results[1]?.address as string;
		await write(projectSpace, [{ op: "update", block: { id: factA }, content: "Fact A, final" }]);
		await write(projectSpace, [{ op: "insert", parent: null, content: "Second page" }]);
	});

	test("a page in the facts view: tasks left out and counted where they hang", async () => {
		const res = await call<OutlineBlockViewResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${page}`,
		);
		expect(res.status).toBe(200);
		const view = res.body;
		expect(view).toMatchObject({
			pageId: page,
			rootId: page,
			current: true,
			view: "facts",
			path: [],
			hiddenByBudget: 0,
			hiddenByView: 2,
			pageTruncated: false,
			space: { id: projectSpace.id, canWrite: false },
		});
		expect(view.seq).toBe(seqs.at(-1) as number);
		expect(view.blocks.map((b) => b.content)).toEqual([
			"Design notes",
			"Fact A, final",
			"Fact C",
			"Detail under A",
		]);
		const a = view.blocks.find((b) => b.id === factA);
		expect(a).toMatchObject({ openTasks: 1, processHidden: 2, hidden: 0 });
		expect(view.blocks[0]?.childIds).toEqual([factA, view.blocks[2]?.id as string]);
	});

	test("the all view, a focused task, and a budget that leaves blocks out", async () => {
		const all = await call<OutlineBlockViewResponse>(
			alice,
			`/spaces/${projectSpace.id}/blocks/${page}?view=all`,
		);
		expect(all.body.blocks).toHaveLength(6);
		expect(all.body.hiddenByView).toBe(0);
		expect(all.body.blocks.find((b) => b.id === task)?.task).toEqual({
			status: "todo",
			assignee: null,
			due: null,
			depends: [],
		});

		const focused = await call<OutlineBlockViewResponse>(
			alice,
			`/spaces/${projectSpace.id}/blocks/${underTask}`,
		);
		// Under a task the facts view would be empty: it reads whole.
		expect(focused.body.view).toBe("all");
		expect(focused.body.path.map((p) => p.title)).toEqual([
			"Design notes",
			"Fact A, final",
			"Check A again",
		]);

		const small = await call<OutlineBlockViewResponse>(
			alice,
			`/spaces/${projectSpace.id}/blocks/${page}?blocks=2`,
		);
		expect(small.body.blocks.map((b) => b.id)).toEqual([page, factA]);
		expect(small.body.hiddenByBudget).toBe(2);
		expect(small.body.blocks[0]?.hidden).toBe(1);
		expect(small.body.blocks[1]?.hidden).toBe(1);
	});

	test("as of a seq or a time shows that state, with today's access", async () => {
		const before = await call<OutlineBlockViewResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${page}?asOf=${seqs[0]}`,
		);
		expect(before.body.current).toBe(false);
		expect(before.body.seq).toBe(seqs[0] as number);
		expect(before.body.blocks.find((b) => b.id === factA)?.content).toBe("Fact A, first draft");

		const beforeTime = await call<OutlineBlockViewResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${page}?at=${encodeURIComponent("2000-01-01T00:00:00Z")}`,
		);
		// Before the first commit the page did not exist.
		expect(beforeTime.status).toBe(404);
		const now = await call<OutlineBlockViewResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${page}?at=${encodeURIComponent(new Date().toISOString())}`,
		);
		expect(now.body.seq).toBe(seqs.at(-1) as number);
		expect((await call(carol, `/spaces/${projectSpace.id}/blocks/${page}?asOf=1`)).status).toBe(
			404,
		);
		expect(
			(await call(bob, `/spaces/${projectSpace.id}/blocks/${page}?asOf=1&at=${NOW}`)).status,
		).toBe(400);
	});

	test("blocks are found only under their own readable space", async () => {
		expect((await call(carol, `/spaces/${projectSpace.id}/blocks/${page}`)).status).toBe(404);
		const personal = await ensurePersonalSpace(bob.id);
		expect((await call(bob, `/spaces/${personal.id}/blocks/${page}`)).status).toBe(404);
		expect((await call(bob, `/spaces/${projectSpace.id}/blocks/nope`)).status).toBe(404);
	});

	test("the pages of a space, in order, a page at a time", async () => {
		const first = await call<OutlinePageListResponse>(
			bob,
			`/spaces/${projectSpace.id}/pages?limit=1`,
		);
		expect(first.body.pages.map((p) => p.title)).toEqual(["Design notes"]);
		const rest = await call<OutlinePageListResponse>(
			bob,
			`/spaces/${projectSpace.id}/pages?limit=1&cursor=${first.body.nextCursor}`,
		);
		expect(rest.body.pages.map((p) => p.title)).toEqual(["Second page"]);
		expect(rest.body.nextCursor).toBeNull();
		expect((await call(bob, `/spaces/${projectSpace.id}/pages?cursor=not-a-cursor`)).status).toBe(
			400,
		);
		expect((await call(carol, `/spaces/${projectSpace.id}/pages`)).status).toBe(404);
	});

	test("a page's timeline and a block's history page newest first", async () => {
		const first = await call<OutlineTimelineResponse>(
			bob,
			`/spaces/${projectSpace.id}/pages/${page}/commits?limit=1`,
		);
		expect(first.body.commits.map((c) => c.seq)).toEqual([seqs[1] as number]);
		expect(first.body.commits[0]).toMatchObject({
			kind: "edit",
			actorKind: "human",
			actorName: expect.stringContaining("alice-"),
		});
		const older = await call<OutlineTimelineResponse>(
			bob,
			`/spaces/${projectSpace.id}/pages/${page}/commits?limit=1&before=${first.body.nextBefore}`,
		);
		expect(older.body.commits.map((c) => c.seq)).toEqual([seqs[0] as number]);
		expect(older.body.nextBefore).toBeNull();

		const history = await call<OutlineBlockHistoryResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${factA}/history`,
		);
		expect(history.body.entries.map((e) => e.seq)).toEqual([seqs[1], seqs[0]] as number[]);
		expect(history.body.entries[0]?.changes).toEqual(["content"]);
		expect(history.body.entries[1]?.changes).toContain("create");
		expect(history.body.entries[0]?.commit?.id).toBe(commitIds[1] as string);
		expect((await call(carol, `/spaces/${projectSpace.id}/blocks/${factA}/history`)).status).toBe(
			404,
		);
	});
});

describe("search and backlinks", () => {
	let personal: OutlineSpaceRow;

	beforeAll(async () => {
		personal = await ensurePersonalSpace(alice.id);
		await write(personal, [
			{ op: "insert", parent: null, content: `Private thoughts about [[${factAddress}]]` },
		]);
	});

	test("search covers the caller's readable spaces, or one of them", async () => {
		const forAlice = await call<OutlineSearchResponse>(alice, "/search?q=thoughts");
		expect(forAlice.body.hits.map((h) => h.spaceId)).toEqual([personal.id]);
		const forBob = await call<OutlineSearchResponse>(bob, "/search?q=thoughts");
		expect(forBob.body.hits).toEqual([]);
		const scoped = await call<OutlineSearchResponse>(
			bob,
			`/search?q=final&spaceId=${projectSpace.id}`,
		);
		expect(scoped.body.hits[0]).toMatchObject({ blockId: factA, path: ["Design notes"] });
		expect((await call(bob, `/search?q=thoughts&spaceId=${personal.id}`)).status).toBe(404);
		expect((await call(bob, "/search?q=")).status).toBe(400);
	});

	test("backlinks come from the caller's readable spaces only", async () => {
		const forAlice = await call<OutlineBacklinksResponse>(
			alice,
			`/spaces/${projectSpace.id}/blocks/${factA}/backlinks`,
		);
		expect(forAlice.body.links).toHaveLength(1);
		expect(forAlice.body.links[0]).toMatchObject({ spaceId: personal.id, kind: "link" });
		const forBob = await call<OutlineBacklinksResponse>(
			bob,
			`/spaces/${projectSpace.id}/blocks/${factA}/backlinks`,
		);
		expect(forBob.body).toEqual({ links: [], truncated: false });
	});
});

describe("revert", () => {
	test("404 without read, 403 with read only, and blocks changed later are skipped", async () => {
		const edit = await write(projectSpace, [
			{ op: "update", block: { id: factA }, content: "Fact A, edited" },
			{ op: "insert", parent: { id: page }, content: "Added then reverted" },
		]);
		const commitId = edit.commit?.id as string;
		await write(projectSpace, [{ op: "update", block: { id: factA }, content: "Fact A, later" }]);

		expect((await call(carol, `/commits/${commitId}/revert`, "POST")).status).toBe(404);
		expect((await call(carol, "/commits/missing/revert", "POST")).status).toBe(404);
		expect((await call(bob, `/commits/${commitId}/revert`, "POST")).status).toBe(403);

		const res = await call<OutlineRevertResponse>(alice, `/commits/${commitId}/revert`, "POST");
		expect(res.status).toBe(200);
		expect(res.body.reverted.id).toBe(commitId);
		expect(res.body.commit).not.toBeNull();
		expect(res.body.changed).toBe(1);
		expect(res.body.skipped).toEqual([
			expect.objectContaining({ blockId: factA, reason: "changed-later" }),
		]);
		const view = await call<OutlineBlockViewResponse>(
			alice,
			`/spaces/${projectSpace.id}/blocks/${page}`,
		);
		expect(view.body.blocks.map((b) => b.content)).not.toContain("Added then reverted");
		expect(view.body.blocks.find((b) => b.id === factA)?.content).toBe("Fact A, later");
	});
});
