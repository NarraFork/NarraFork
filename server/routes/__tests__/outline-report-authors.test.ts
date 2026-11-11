/**
 * Who wrote a subagent report (task tree readability, PR C): the container's line says 「来自 …」
 * with the subagent's session title, to a reader who may read that session only.
 *
 *   - the read-only view (`GET /spaces/:s/blocks/:b`) names the containers it shows;
 *   - the live editor asks for the containers of its page (`GET /spaces/:s/report-authors`);
 *   - a container moved or edited since it was attached is still named (its creating commit);
 *   - a block that only looks like a container (the id, not the commit) is named nobody;
 *   - both reads are bounded.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	OUTLINE_PENDING_API_LIMITS,
	OUTLINE_REPORT_AUTHORS_API_LIMITS,
	type OutlineBlockViewResponse,
	type OutlinePagePendingResponse,
	type OutlineReportAuthorsResponse,
} from "@shared/outline-api";
import { isOutlineReportBlockId } from "@shared/outline-report-line";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { reportBlockId } from "../../services/outline/delegation";
import {
	OUTLINE_REPORT_ACTOR,
	OUTLINE_REPORT_AUTHOR_LIMITS,
	readReportAuthors,
} from "../../services/outline/report-authors";
import { ensureProjectSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
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

async function get<T>(userId: string, path: string): Promise<{ status: number; body: T }> {
	const response = await appAs(userId).request(`http://localhost/outline${path}`);
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: parsed as T };
}

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function session(owner: string, title: string | null, parentId?: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		type: parentId ? "subagent" : "primary",
		// A subagent is judged on its root session (`readJudgedNarrator`).
		...(parentId ? { aclRootNarratorId: parentId } : {}),
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

let alice: string;
let bob: string;
let carol: string;
let spaceId: string;
let pageId: string;
let taskId: string;
let scout: string;
let untitled: string;
/** Attached by the scout, untouched since. */
let report: string;
/** Attached by the scout, then moved by a person. */
let moved: string;
/** Attached by a session without a title. */
let nameless: string;
/** A block with a container's id that no report commit made. */
let forged: string;

async function attach(subagentId: string, run: string, parent: string): Promise<string> {
	const id = reportBlockId(subagentId, run);
	await writeOutline({
		spaceId,
		ops: [
			{
				op: "insert",
				tempId: "report",
				id,
				parent: { id: parent },
				content: "Report (generation 1 · 2026-10-27 00:00 UTC)",
			},
			{ op: "insert", parent: { tempId: "report" }, content: "What was found." },
		],
		actor: { kind: "system", id: OUTLINE_REPORT_ACTOR },
		responsibleUserId: alice,
		narratorId: subagentId,
	});
	return id;
}

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
		name: "Report authors",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	// Bob may read the project (and so its outline), not Alice's sessions; Carol reads neither.
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: bob,
		capability: "read",
		createdAt: NOW,
	});
	const space = await ensureProjectSpace(projectId);
	spaceId = space.id;
	const written = await writeOutline({
		spaceId,
		ops: [
			{ op: "insert", tempId: "p", parent: null, content: "Page" },
			{
				op: "insert",
				tempId: "t",
				parent: { tempId: "p" },
				content: "A task",
				task: { status: "doing" },
			},
			{ op: "insert", tempId: "n", parent: { tempId: "t" }, content: "A note" },
		],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	pageId = written.results[0]?.blockId as string;
	taskId = written.results[1]?.blockId as string;
	const main = await session(alice, "main");
	scout = await session(alice, "  scout-1  ", main);
	untitled = await session(alice, null, main);
	report = await attach(scout, "run-1", taskId);
	moved = await attach(scout, "run-2", taskId);
	nameless = await attach(untitled, "run-1", taskId);
	// Someone moves a report to the page's top level: its current version is theirs.
	await writeOutline({
		spaceId,
		ops: [{ op: "move", block: { id: moved }, parent: { id: pageId } }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
	});
	forged = reportBlockId("nobody", "run-9");
	await writeOutline({
		spaceId,
		ops: [{ op: "insert", id: forged, parent: { id: taskId }, content: "Looks like a report" }],
		actor: { kind: "human", id: alice },
		responsibleUserId: alice,
		narratorId: scout,
	});
});

const view = (who: string, block = pageId, query = "view=all") =>
	get<OutlineBlockViewResponse>(who, `/spaces/${spaceId}/blocks/${block}?${query}`);
const authors = (who: string, ids: readonly string[]) =>
	get<OutlineReportAuthorsResponse>(who, `/spaces/${spaceId}/report-authors?ids=${ids.join(",")}`);

describe("who wrote a subagent report", () => {
	test("the writer's container ids are the ones the readers recognise", () => {
		for (const id of [report, moved, nameless, forged])
			expect(isOutlineReportBlockId(id)).toBe(true);
		expect(isOutlineReportBlockId(taskId)).toBe(false);
	});

	test("the view names a report's subagent to a reader of that session", async () => {
		const read = await view(alice);
		expect(read.status).toBe(200);
		const from = (id: string) => read.body.blocks.find((b) => b.id === id)?.reportFrom;
		// The title as a line shows it (trimmed).
		expect(from(report)).toBe("scout-1");
		// Moved since: named from the commit that created it.
		expect(from(moved)).toBe("scout-1");
		// A session without a title, a block no report commit made, an ordinary block: no name.
		expect(from(nameless)).toBeUndefined();
		expect(from(forged)).toBeUndefined();
		expect(from(taskId)).toBeUndefined();
		expect("reportFrom" in (read.body.blocks.find((b) => b.id === taskId) ?? {})).toBe(false);
	});

	test("a reader of the page who may not read the session is told no name", async () => {
		const read = await view(bob);
		expect(read.status).toBe(200);
		// Bob reads the report itself …
		expect(read.body.blocks.some((b) => b.id === report)).toBe(true);
		// … and no block names the session.
		expect(read.body.blocks.filter((b) => b.reportFrom !== undefined)).toEqual([]);
		expect(JSON.stringify(read.body)).not.toContain("scout-1");
		expect((await authors(bob, [report, moved])).body).toEqual({ authors: {} });
		// Someone who may not read the space gets the same 404 as for any of its reads.
		expect((await view(carol)).status).toBe(404);
		expect((await authors(carol, [report])).status).toBe(404);
	});

	test("a view as of an earlier commit names them too", async () => {
		const now = await view(alice);
		const past = await view(alice, pageId, `view=all&asOf=${now.body.seq - 1}`);
		expect(past.body.current).toBe(false);
		expect(past.body.blocks.find((b) => b.id === report)?.reportFrom).toBe("scout-1");
	});

	test("the root says whether it is under a task", async () => {
		expect((await view(alice)).body.rootInTask).toBe(false);
		expect((await view(alice, taskId)).body.rootInTask).toBe(false);
		const note = (await view(alice, taskId)).body.blocks.find((b) => b.content === "A note");
		expect((await view(alice, note?.id)).body.rootInTask).toBe(true);
		// Inside a report: details too.
		const inside = (await view(alice, moved)).body.blocks.find((b) => b.parentId === moved);
		expect((await view(alice, inside?.id)).body.rootInTask).toBe(true);
	});

	test("the live editor's read: the containers asked for, of this space, bounded", async () => {
		const read = await authors(alice, [report, moved, nameless, forged, taskId, generateId()]);
		expect(read.status).toBe(200);
		expect(read.body).toEqual({ authors: { [report]: "scout-1", [moved]: "scout-1" } });
		// Nothing asked, free text, too many: refused.
		expect((await authors(alice, [])).status).toBe(400);
		expect((await authors(alice, ["has space"])).status).toBe(400);
		const many = Array.from({ length: OUTLINE_REPORT_AUTHORS_API_LIMITS.maxIds + 1 }, () =>
			generateId(),
		);
		expect((await authors(alice, many)).status).toBe(400);
		expect((await authors(alice, many.slice(1))).status).toBe(200);
		expect((await get(alice, `/spaces/${spaceId}/report-authors`)).status).toBe(400);
	});

	test("at most so many containers are named, with a bounded number of reads", async () => {
		const calls = { commits: 0, history: 0 };
		const counting = new Proxy(outlineStore, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver);
				if (typeof value !== "function") return value;
				if (key === "getCommitsBySeqs") calls.commits++;
				if (key === "listBlockHistory") calls.history++;
				return value.bind(target);
			},
		});
		const meta = (await outlineStore.getBlockMetas(spaceId, { ids: [report] }))[0];
		const versionSeq = meta?.versionSeq as number;
		const max = OUTLINE_REPORT_AUTHOR_LIMITS.containers;
		// The same container many times stands for many: only the first `max` are looked at.
		const containers = Array.from({ length: max + 30 }, (_, i) => ({
			id: i < max ? report : moved,
			versionSeq,
		}));
		const named = await readReportAuthors(spaceId, containers, {
			narratorVisible: async () => true,
			store: counting,
		});
		expect([...named.keys()]).toEqual([report]);
		expect(calls).toEqual({ commits: 1, history: 0 });
		// Without a way to ask who may read a session, nobody is named and nothing is read.
		calls.commits = 0;
		expect((await readReportAuthors(spaceId, containers, { store: counting })).size).toBe(0);
		expect(calls).toEqual({ commits: 0, history: 0 });
		// A changed container costs one bounded history read and one more read of commits.
		const movedMeta = (await outlineStore.getBlockMetas(spaceId, { ids: [moved] }))[0];
		const again = await readReportAuthors(
			spaceId,
			[{ id: moved, versionSeq: movedMeta?.versionSeq as number }],
			{ narratorVisible: async () => true, store: counting },
		);
		expect(again.get(moved)).toBe("scout-1");
		expect(calls).toEqual({ commits: 2, history: 1 });
		// A long title is cut.
		const long = await readReportAuthors(spaceId, [{ id: report, versionSeq }], {
			narratorVisible: async () => true,
			titles: async (ids) => new Map(ids.map((id) => [id, "长".repeat(500)])),
		});
		expect(Array.from(long.get(report) ?? "").length).toBe(OUTLINE_REPORT_AUTHOR_LIMITS.nameChars);
	});
});

describe("a page's summary names the unanswered questions", () => {
	const pending = (who: string, page = pageId) =>
		get<OutlinePagePendingResponse>(who, `/spaces/${spaceId}/pages/${page}/pending`);

	test("the list is there (empty without questions) beside the pending changes and locks", async () => {
		const read = await pending(alice);
		expect(read.status).toBe(200);
		expect(read.body).toEqual({ pending: [], locks: [], questions: [] });
	});

	test("this page's own, however many older ones the space has open elsewhere", async () => {
		const asks = (parent: string | null, content: string) => ({
			op: "insert" as const,
			parent: parent ? { id: parent } : null,
			content,
			ask: {
				to: { kind: "human" as const, id: alice },
				options: [],
				recommend: { text: "Go ahead", reason: "It is small" },
			},
		});
		const write = (ops: Parameters<typeof writeOutline>[0]["ops"]) =>
			writeOutline(
				{
					spaceId,
					ops,
					actor: { kind: "agent", id: scout },
					narratorId: scout,
					responsibleUserId: alice,
				},
				{ question: { askerNarratorId: scout, askerUserId: alice, askerToolCallId: "call-1" } },
			);
		// More open questions on another page than one summary names, all older.
		const made = await write([{ op: "insert", parent: null, content: "Another page" }]);
		const otherPage = made.results[0]?.blockId as string;
		const many = OUTLINE_PENDING_API_LIMITS.openQuestions + 5;
		for (let at = 0; at < many; at += 100) {
			await write(
				Array.from({ length: Math.min(100, many - at) }, (_, i) =>
					asks(otherPage, `Elsewhere ${at + i}`),
				),
			);
		}
		// One on this page, under the task, asked last.
		const here = await write([asks(taskId, "Which way here?")]);
		const question = here.results[0]?.blockId as string;
		const read = await pending(alice);
		expect(read.body.questions).toEqual([question]);
		// The other page names its own, bounded.
		const other = await pending(alice, otherPage);
		expect(other.body.questions?.length).toBe(OUTLINE_PENDING_API_LIMITS.openQuestions);
		expect(other.body.questions).not.toContain(question);
		// A reader of the page reads the same; someone who may not read the space reads nothing.
		expect((await pending(bob)).body.questions).toEqual([question]);
		expect((await pending(carol)).status).toBe(404);
	});
});
