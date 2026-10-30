/**
 * The outline agent tools through their tool definitions, on the isolated SQLite database:
 * reading (ids after bullets, the space line, facts and all, budgets, as-of, ambiguity, link
 * titles, unreadable spaces), searching, and editing (each edit kind, markdown copied back from a
 * read, link canonicalization, `Q?` aliases, conflicts, the write rules of each permission mode,
 * provenance).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	outlineBlocks,
	outlineCommits,
	projects,
	users,
} from "../../../db/schema";
import { executeTool } from "../../../lib/agent/tool-executor";
import { resolveLoadableToolDefinition } from "../../../lib/agent/tool-loading";
import { toolRegistry } from "../../../lib/agent/tool-registry";
import {
	outlineEditTool,
	outlineReadTool,
	outlineSearchTool,
} from "../../../lib/agent/tools/outline";
import type {
	AgentConfig,
	ToolContext,
	ToolDefinition,
	ToolResult,
} from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { OUTLINE_EDIT_LIMITS } from "../agent-edit";
import { AGENT_MERGE_HOOKS, AGENT_MERGE_LIMITS } from "../agent-merge";
import { OUTLINE_EDIT_TEXT_LIMITS, stopEditTextWorker } from "../edit-text-runner";
import { OUTLINE_CHANGE } from "../model";
import { clearOutlineReads, recordOutlineReads, seenOutlineVersion } from "../read-ledger";
import { revertCommit } from "../revert";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { OUTLINE_LAST_WRITES_SCAN } from "../store/read-port";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-10-26T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function project(owner: string, name: string, visibility = "private"): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name,
		ownerUserId: owner,
		visibility: visibility as "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function narrator(
	owner: string,
	projectId: string | null,
	extra: Partial<typeof narrators.$inferInsert> = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "outline tools",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

function ctx(
	narratorId: string,
	userId: string | null,
	extra: Partial<ToolContext> = {},
): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
		...extra,
	} as ToolContext;
}

async function call(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	return await tool.execute(args, context);
}

/** Blocks of a space by sid, as stored. */
async function stored(space: OutlineSpaceRow) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	return new Map(rows.map((row) => [row.sid, row]));
}

async function byContent(space: OutlineSpaceRow, content: string) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	const row = rows.find((r) => r.content === content && !r.deleted);
	if (!row) throw new Error(`no block ${JSON.stringify(content)}`);
	return row;
}

function humanWrite(space: OutlineSpaceRow, userId: string, ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});
}

/** The ids a result lists after bullets, in order. */
function ids(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

interface World {
	alice: string;
	projectId: string;
	session: string;
	space: OutlineSpaceRow;
}

async function world(name = "Atlas"): Promise<World> {
	const alice = await user("alice");
	const projectId = await project(alice, name);
	const session = await narrator(alice, projectId);
	const space = await ensureProjectSpace(projectId);
	return { alice, projectId, session, space };
}

/** A page of blocks the agent wrote and then read; their sids and ids. */
async function readBlocksOf(w: World, c: ToolContext, texts: string[]) {
	const markdown = ["- Notes", ...texts.map((t) => `  - ${t}`)].join("\n");
	const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
	const created = ids(added.output);
	await call(outlineReadTool, { address: created[0] as string, view: "all" }, c);
	const rows = await stored(w.space);
	return created.slice(1).map((sid) => ({ sid, id: rows.get(sid)?.id as string }));
}

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("availability", () => {
	test("the tools exist only while the outline is turned on", async () => {
		const names = ["OutlineRead", "OutlineSearch", "OutlineEdit"];
		for (const name of names) expect(toolRegistry.get(name)?.isAvailable?.()).toBe(true);
		expect(resolveLoadableToolDefinition("OutlineEdit")?.name).toBe("OutlineEdit");
		settings.outline.enabled = false;
		for (const name of names) expect(toolRegistry.get(name)?.isAvailable?.()).toBe(false);
		expect(resolveLoadableToolDefinition("OutlineEdit")).toBeNull();
		const w = await world();
		const result = await call(outlineReadTool, {}, ctx(w.session, w.alice));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("outline.enabled");
	});

	test("descriptions are static, so a loaded tool keeps the prompt cache", () => {
		for (const tool of [outlineReadTool, outlineSearchTool, outlineEditTool]) {
			expect(typeof tool.description).toBe("string");
			expect(tool.getRawJsonSchema).toBeUndefined();
		}
	});
});

describe("OutlineEdit then OutlineRead", () => {
	test("adds pages to the project space, reads them back with ids and the space line", async () => {
		const w = await world("Atlas");
		const c = ctx(w.session, w.alice);
		const empty = await call(outlineReadTool, {}, c);
		expect(empty.output).toContain(w.space.key);
		expect(empty.output).toContain("no pages yet");

		const added = await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: [
							"- Auth module",
							"  - Refresh tokens live only on the server",
							"  - [ ] Add a regression test @agent:w-auth",
							"    - covers the second request",
						].join("\n"),
					},
				],
				message: "auth notes",
			},
			c,
		);
		expect(added.isError).toBeUndefined();
		expect(added.output).toContain(`to ${w.space.key} · this session's project "Atlas"`);
		const created = ids(added.output);
		expect(created).toHaveLength(4);
		const page = created[0] as string;

		const read = await call(outlineReadTool, { address: page }, c);
		const lines = read.output.split("\n");
		expect(lines[0]).toBe(`‹space ${w.space.key} · this session's project "Atlas"›`);
		expect(lines[1]).toBe(`- [${page}] Auth module`);
		expect(lines[2]).toBe(`  - [${created[1]}] Refresh tokens live only on the server`);
		expect(read.output).not.toContain("regression");
		expect(read.output).toContain("‹facts only: 2 blocks under tasks not shown");
		expect(read.truncated).toBe(true);

		const all = await call(outlineReadTool, { address: page, view: "all" }, c);
		expect(all.output).toContain(
			`  - [${created[2]}] [ ] Add a regression test @agent:w-auth\n    - [${created[3]}] covers the second request`,
		);
		// A task reads whole without asking.
		const task = await call(outlineReadTool, { address: created[2] as string }, c);
		expect(task.output).toContain("covers the second request");
		expect(task.output.split("\n")[0]).toContain("in Auth module");

		const commits = await db
			.select()
			.from(outlineCommits)
			.where(eq(outlineCommits.spaceId, w.space.id));
		expect(commits).toHaveLength(1);
		expect(commits[0]).toMatchObject({
			actorKind: "agent",
			actorId: w.session,
			responsibleUserId: w.alice,
			narratorId: w.session,
			summary: "auth notes",
		});
	});

	test("the commit records the message and tool call of the call", async () => {
		const w = await world();
		const messageId = generateId();
		const toolCallId = generateId();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: w.session,
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		});
		await db.insert(narratorToolCalls).values({
			id: toolCallId,
			narratorId: w.session,
			messageId,
			toolUseId: "toolu_outline",
			toolName: "OutlineEdit",
			inputJson: {},
			status: "running",
			createdAt: NOW,
		});
		const result = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- provenance" }] },
			ctx(w.session, w.alice, {
				currentToolUseId: "toolu_outline",
				toolCallBinding: { toolCallId, attempt: 0 },
			}),
		);
		expect(result.isError).toBeUndefined();
		const [commit] = await db
			.select()
			.from(outlineCommits)
			.where(eq(outlineCommits.spaceId, w.space.id));
		expect(commit).toMatchObject({ messageId, toolCallId, narratorId: w.session });
	});

	test("budget, as-of reads and ambiguous addresses", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const markdown = ["- Wide page", ...Array.from({ length: 12 }, (_, i) => `  - item ${i}`)].join(
			"\n",
		);
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
		const page = ids(added.output)[0] as string;
		const small = await call(outlineReadTool, { address: page, budget: 4 }, c);
		expect(ids(small.output)).toHaveLength(4);
		expect(small.output).toContain("‹… 9 more›");
		expect(small.metadata?.truncated).toBe(true);

		const item0 = ids(added.output)[1] as string;
		const before = (await outlineStore.getSpace(w.space.id))?.nextSeq ?? 0;
		await call(outlineEditTool, { edits: [{ replace: item0, text: "item zero" }] }, c);
		const old = await call(outlineReadTool, { address: item0, asOf: before - 1 }, c);
		expect(old.output).toContain("item 0");
		expect(old.output.split("\n")[0]).toContain(`as of commit #${before - 1}`);
		const now = await call(outlineReadTool, { address: item0 }, c);
		expect(now.output).toContain("item zero");
		const byTime = await call(outlineReadTool, { address: item0, asOf: "2000-01-01T00:00:00Z" }, c);
		expect(byTime.isError).toBe(true);
		expect(byTime.output).toContain("did not exist as of commit #0");

		await call(outlineEditTool, { edits: [{ add: page, markdown: "- twin\n- twin" }] }, c);
		const twin = await call(outlineReadTool, { address: "twin" }, c);
		expect(twin.isError).toBeUndefined();
		expect(twin.output).toContain('"twin" matches several blocks');
		expect(ids(twin.output)).toHaveLength(2);
		expect(ids(twin.output)[0]).toStartWith(`${w.space.key}/`);
	});

	test("spaces the session may not read are never found, read or searched", async () => {
		const w = await world();
		const bob = await user("bob");
		const other = await ensureProjectSpace(await project(bob, "Hidden"));
		await humanWrite(other, bob, [{ op: "insert", parent: null, content: "Secret plan zebra" }]);
		const hidden = [...(await stored(other)).values()][0];
		if (!hidden) throw new Error("no hidden block");
		const c = ctx(w.session, w.alice);
		for (const address of [`${other.key}/${hidden.sid}`, hidden.sid, "Secret plan zebra"]) {
			const read = await call(outlineReadTool, { address }, c);
			expect(read.isError).toBe(true);
			expect(read.output).toContain("Nothing this session can read matches");
		}
		const search = await call(outlineSearchTool, { query: "zebra", spaces: [other.key] }, c);
		expect(search.output).toContain(`No outline space "${other.key}"`);
		const defaults = await call(outlineSearchTool, { query: "zebra" }, c);
		expect(defaults.output).toContain("0 results");
		const edit = await call(
			outlineEditTool,
			{ edits: [{ add: `${other.key}/`, markdown: "- nope" }] },
			c,
		);
		expect(edit.isError).toBe(true);
		expect(edit.output).toContain("Nothing was written.");
	});

	test("search covers the session's spaces and shows addresses, paths and process", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: "- Caching\n  - Redis keeps hot keys\n  - [ ] Evict cold keys from Redis",
					},
				],
			},
			c,
		);
		await call(outlineEditTool, { edits: [{ add: "session/", markdown: "- Redis notes" }] }, c);
		const session = await ensureSessionSpace(w.session);
		const result = await call(outlineSearchTool, { query: "Redis" }, c);
		expect(result.output.split("\n")[0]).toContain('3 results for "Redis"');
		const hits = ids(result.output);
		expect(hits).toHaveLength(3);
		expect(
			hits.every((h) => h.startsWith(`${w.space.key}/`) || h.startsWith(`${session.key}/`)),
		).toBe(true);
		expect(result.output).toContain("in Caching");
		expect(result.output).toContain("a task");
		const onlySession = await call(outlineSearchTool, { query: "Redis", spaces: ["session"] }, c);
		expect(ids(onlySession.output)).toEqual([
			expect.stringMatching(new RegExp(`^${session.key}/`)),
		]);
	});
});

describe("OutlineEdit", () => {
	test("markdown copied back from a read: ids and notes dropped, look-alike text kept", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Source\n  - first\n  - second" }] },
			c,
		);
		const page = ids(added.output)[0] as string;
		const read = await call(outlineReadTool, { address: page, budget: 2 }, c);
		const copy = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: read.output },
					{ add: "/", markdown: "- [CRITICAL] keep this text" },
				],
			},
			c,
		);
		expect(copy.isError).toBeUndefined();
		expect(copy.output).toContain("were dropped; add always creates new blocks");
		const blocks = [...(await stored(w.space)).values()].map((b) => b.content);
		expect(blocks.filter((content) => content === "Source")).toHaveLength(2);
		expect(blocks.filter((content) => content === "first")).toHaveLength(2);
		expect(blocks).toContain("[CRITICAL] keep this text");
		expect(blocks.some((content) => content.includes("more›") || content.includes("‹"))).toBe(
			false,
		);
	});

	test("links: titles and aliases become addresses, read titles are dropped, chosen ones kept", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const base = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Target page\n  alias:: T1" }] },
			c,
		);
		const target = ids(base.output)[0] as string;
		const address = `${w.space.key}/${target}`;
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: [
							"- by title [[Target page]]",
							"- by alias [[T1]]",
							`- copied [[${address}|Target page]]`,
							`- chosen [[${address}|the target]]`,
							"- unknown [[No such page]]",
							"- code `[[Target page]]` stays",
						].join("\n"),
					},
				],
			},
			c,
		);
		expect(added.output).toContain("[[No such page]] matches nothing this session can read");
		const blocks = [...(await stored(w.space)).values()].map((b) => b.content);
		expect(blocks).toContain(`by title [[${address}]]`);
		expect(blocks).toContain(`by alias [[${address}]]`);
		expect(blocks).toContain(`copied [[${address}]]`);
		expect(blocks).toContain(`chosen [[${address}|the target]]`);
		expect(blocks).toContain("unknown [[No such page]]");
		expect(blocks).toContain("code `[[Target page]]` stays");

		// A read shows the current title, and follows a rename.
		await call(outlineEditTool, { edits: [{ replace: target, text: "Renamed page" }] }, c);
		const page = await byContent(w.space, `by title [[${address}]]`);
		const read = await call(outlineReadTool, { address: page.sid }, c);
		expect(read.output).toContain(`by title [[${address}|Renamed page]]`);
	});

	test("a link to a block the session may not read shows no title", async () => {
		const w = await world();
		const bob = await user("bob");
		const other = await ensureProjectSpace(await project(bob, "Hidden"));
		await humanWrite(other, bob, [{ op: "insert", parent: null, content: "Secret" }]);
		const hidden = [...(await stored(other)).values()][0];
		const ref = `${other.key}/${hidden?.sid}`;
		await humanWrite(w.space, w.alice, [{ op: "insert", parent: null, content: `see [[${ref}]]` }]);
		const page = await byContent(w.space, `see [[${ref}]]`);
		const read = await call(outlineReadTool, { address: page.sid }, ctx(w.session, w.alice));
		expect(read.output).toContain(`see [[${ref}]]`);
		expect(read.output).not.toContain("Secret");
	});

	test("blocks added in one call link to each other; depends:: becomes an address", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: [
							"- Plan",
							"  - [ ] Step one",
							"  - [ ] Step two",
							"    depends:: [[Step one]]",
							"  - See [[Step two]]",
						].join("\n"),
					},
				],
			},
			c,
		);
		const [, one, two] = ids(added.output);
		const blocks = await stored(w.space);
		expect(blocks.get(two as string)?.taskJson?.depends).toEqual([
			{ target: `${w.space.key}/${one}`, label: null },
		]);
		expect([...blocks.values()].map((b) => b.content)).toContain(`See [[${w.space.key}/${two}]]`);
	});

	test("alias:: Q? takes the next free number", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		await humanWrite(w.space, w.alice, [
			{ op: "insert", parent: null, content: "q1", alias: "Q1" },
			{ op: "insert", parent: null, content: "q3", alias: "Q3" },
			{ op: "insert", parent: null, content: "qa", alias: "Qa" },
			{ op: "insert", parent: null, content: "r9", alias: "R9" },
		]);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- next\n  alias:: Q?\n- after that\n  alias:: Q?" }] },
			c,
		);
		expect(added.output).toContain("(alias Q4)");
		expect(added.output).toContain("(alias Q5)");
		const q1 = await byContent(w.space, "q1");
		const set = await call(outlineEditTool, { edits: [{ set: q1.sid, alias: "Q?" }] }, c);
		expect(set.output).toContain("alias Q6");
		expect((await byContent(w.space, "q1")).alias).toBe("Q6");
	});

	test("replace, move, delete and set", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- A\n  - a1\n  - a2\n- B" }] },
			c,
		);
		const [a, a1, a2, b] = ids(added.output) as [string, string, string, string];
		const result = await call(
			outlineEditTool,
			{
				edits: [
					{ replace: a1, text: `[${a1}] [ ] a1 as a task @agent:me\n  - its child` },
					{ move: a2, to: b },
					{ set: a1, checkbox: "x" },
					{ delete: a },
				],
			},
			c,
		);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain(`replaced [${a1}]`);
		expect(result.output).toContain(`moved [${a2}] under [${b}] B`);
		expect(result.output).toContain(`set [${a1}]: [x]`);
		expect(result.output).toContain(`deleted [${a}] and everything under it`);
		const blocks = await stored(w.space);
		expect(blocks.get(a1)?.content).toBe("a1 as a task");
		expect(blocks.get(a1)?.taskJson).toMatchObject({ status: "done", assignee: "agent:me" });
		expect(blocks.get(a1)?.deleted).toBe(true);
		expect(blocks.get(a2)?.parentId).toBe(blocks.get(b)?.id as string);
		expect([...blocks.values()].find((x) => x.content === "its child")?.deleted).toBe(true);

		const plain = await call(
			outlineEditTool,
			{ edits: [{ set: a2, checkbox: "/", assignee: "@human:alice" }] },
			c,
		);
		expect(plain.output).toContain(`set [${a2}]: [/], @human:alice`);
		await call(outlineEditTool, { edits: [{ set: a2, checkbox: "none" }] }, c);
		expect((await stored(w.space)).get(a2)?.taskJson).toBeNull();
	});

	test("an invalid edit writes nothing and says which edit failed", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- one" }] }, c);
		const one = ids(added.output)[0] as string;
		const before = await stored(w.space);
		const result = await call(
			outlineEditTool,
			{
				edits: [
					{ add: one, markdown: "- child" },
					{ replace: "nothing-like-this", text: "x" },
					{ move: one },
				],
			},
			c,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("edit 3: move needs to");
		const second = await call(
			outlineEditTool,
			{
				edits: [
					{ add: one, markdown: "- child" },
					{ replace: "nothing-like-this", text: "x" },
				],
			},
			c,
		);
		expect(second.output).toContain('edit 2 (replace "nothing-like-this")');
		expect((await stored(w.space)).size).toBe(before.size);
		const cycle = await call(outlineEditTool, { edits: [{ move: one, to: one }] }, c);
		expect(cycle.isError).toBe(true);
		expect(cycle.output).toContain("edit 1 (move");
		expect(cycle.output).toContain("under itself");
	});

	test("a block changed by someone else after the agent read it is a conflict", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- shared" }] }, c);
		const sid = ids(added.output)[0] as string;
		// The agent's own later change is no conflict.
		await call(outlineEditTool, { edits: [{ replace: sid, text: "shared, v2" }] }, c);
		const own = await call(outlineEditTool, { edits: [{ replace: sid, text: "shared, v3" }] }, c);
		expect(own.isError).toBeUndefined();

		await call(outlineReadTool, { address: sid }, c);
		const block = await byContent(w.space, "shared, v3");
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: block.id }, content: "changed by a person" },
		]);
		const stale = await call(outlineEditTool, { edits: [{ replace: sid, text: "agent text" }] }, c);
		expect(stale.isError).toBe(true);
		expect(stale.output).toContain("Nothing was written");
		expect(stale.output).toContain(`[${sid}] was changed by a person`);
		expect(stale.output).toContain("it now reads: changed by a person");
		expect((await byContent(w.space, "changed by a person")).id).toBe(block.id);

		await call(outlineReadTool, { address: sid }, c);
		const retry = await call(outlineEditTool, { edits: [{ replace: sid, text: "agent text" }] }, c);
		expect(retry.isError).toBeUndefined();
	});

	test("one call writes one space", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- p" }] }, c);
		const result = await call(
			outlineEditTool,
			{
				edits: [
					{ add: ids(added.output)[0] as string, markdown: "- child" },
					{ add: "session/", markdown: "- note" },
				],
			},
			c,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("one OutlineEdit call writes one space");
	});
});

describe("OutlineEdit merges changes made after the read", () => {
	/** A page of blocks the agent wrote and then read; their sids and ids. */
	async function readBlocks(w: World, c: ToolContext, texts: string[]) {
		const markdown = ["- Notes", ...texts.map((t) => `  - ${t}`)].join("\n");
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
		const created = ids(added.output);
		await call(outlineReadTool, { address: created[0] as string, view: "all" }, c);
		const rows = await stored(w.space);
		return created.slice(1).map((sid) => ({ sid, id: rows.get(sid)?.id as string }));
	}

	test("a person's change and the agent's elsewhere in the text both stay", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [b] = await readBlocks(w, c, ["Tokens expire after an hour."]);
		if (!b) throw new Error("no block");
		const theirs = "Tokens expire after an hour. Refresh them early.";
		await humanWrite(w.space, w.alice, [{ op: "update", block: { id: b.id }, content: theirs }]);

		const result = await call(
			outlineEditTool,
			{ edits: [{ replace: b.sid, text: "Access tokens expire after an hour." }] },
			c,
		);
		expect(result.isError).toBeUndefined();
		const merged = "Access tokens expire after an hour. Refresh them early.";
		expect(result.output).toContain(
			`replaced [${b.sid}], merged with changes made after you read it`,
		);
		expect(result.output).toMatch(
			new RegExp(
				`‹\\[${b.sid}\\] changed by a person in commit #\\d+ after you read it as of #\\d+; merged:›`,
			),
		);
		expect(result.output).toContain(`\n- [${b.sid}] ${merged}`);
		expect(result.metadata?.merged).toEqual([`${w.space.key}/${b.sid}`]);
		const row = (await stored(w.space)).get(b.sid);
		expect(row?.content).toBe(merged);

		// The version says it is a merge, and the ledger holds it: the text shown is what was read.
		const [latest] = await outlineStore.listBlockHistory(b.id, { limit: 1 });
		expect((latest?.changeFlags ?? 0) & OUTLINE_CHANGE.MERGE).toBe(OUTLINE_CHANGE.MERGE);
		expect(seenOutlineVersion(w.session, b.id)).toBe(row?.versionSeq);

		// The time machine replays it, and reverting it puts the person's text back.
		const commit = result.metadata?.commit as { id: string; seq: number };
		const before = await call(outlineReadTool, { address: b.sid, asOf: commit.seq - 1 }, c);
		expect(before.output).toContain(theirs);
		const at = await call(outlineReadTool, { address: b.sid, asOf: commit.seq }, c);
		expect(at.output).toContain(merged);
		const reverted = await revertCommit({
			commitId: commit.id,
			actor: { kind: "human", id: w.alice },
			responsibleUserId: w.alice,
		});
		expect(reverted.commit).not.toBeNull();
		expect((await stored(w.space)).get(b.sid)?.content).toBe(theirs);
	});

	test("one overlap refuses the whole call, naming the block and where", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a, b] = await readBlocks(w, c, ["one two three", "alpha beta"]);
		if (!a || !b) throw new Error("no blocks");
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "one deux three" },
			{ op: "update", block: { id: b.id }, content: "alpha beta gamma" },
		]);
		const commitsBefore = (
			await db.select().from(outlineCommits).where(eq(outlineCommits.spaceId, w.space.id))
		).length;

		const result = await call(
			outlineEditTool,
			{
				edits: [
					{ replace: a.sid, text: "one TWO three" },
					{ replace: b.sid, text: "ALPHA beta" },
				],
			},
			c,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Nothing was written");
		expect(result.output).toContain(`[${a.sid}] was changed by a person`);
		expect(result.output).toContain("your change and theirs overlap at «two»");
		expect(result.output).toContain("it now reads: one deux three");
		// The block that would have merged is not named, and not written either.
		expect(result.output).not.toContain(`[${b.sid}] was changed`);
		expect(result.metadata?.conflicts).toEqual([`${w.space.key}/${a.sid}`]);
		const rows = await stored(w.space);
		expect(rows.get(a.sid)?.content).toBe("one deux three");
		expect(rows.get(b.sid)?.content).toBe("alpha beta gamma");
		expect(
			(await db.select().from(outlineCommits).where(eq(outlineCommits.spaceId, w.space.id))).length,
		).toBe(commitsBefore);
	});

	test("fields merge one by one: kept ones are not written, both changed is a conflict", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [t] = await readBlocks(w, c, ["[ ] write the docs"]);
		if (!t) throw new Error("no block");
		await humanWrite(w.space, w.alice, [
			{ op: "setTask", block: { id: t.id }, task: { status: "done" } },
		]);
		// The agent copies the checkbox it read and changes the text: the person's check stays.
		const kept = await call(
			outlineEditTool,
			{ edits: [{ replace: t.sid, text: "[ ] write the docs for v2" }] },
			c,
		);
		expect(kept.isError).toBeUndefined();
		expect(kept.output).toContain(`- [${t.sid}] [x] write the docs for v2`);
		let row = (await stored(w.space)).get(t.sid);
		expect(row?.content).toBe("write the docs for v2");
		expect(row?.taskJson?.status).toBe("done");

		// A field only the agent changed is written.
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: t.id }, content: "write the docs for v2, today" },
		]);
		const own = await call(
			outlineEditTool,
			{ edits: [{ replace: t.sid, text: "[/] write all the docs for v2 @human:ann" }] },
			c,
		);
		expect(own.isError).toBeUndefined();
		row = (await stored(w.space)).get(t.sid);
		expect(row?.content).toBe("write all the docs for v2, today");
		expect(row?.taskJson).toMatchObject({ status: "doing", assignee: "human:ann" });

		// Both change the checkbox, differently: refused.
		await humanWrite(w.space, w.alice, [
			{ op: "setTask", block: { id: t.id }, task: { status: "cancelled" } },
		]);
		const both = await call(
			outlineEditTool,
			{ edits: [{ replace: t.sid, text: "[x] write all the docs for v2 @human:ann" }] },
			c,
		);
		expect(both.isError).toBe(true);
		expect(both.output).toContain("you and they both changed its checkbox");
		expect((await stored(w.space)).get(t.sid)?.taskJson?.status).toBe("cancelled");
	});

	test("tags and aliases merge the same way", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Notes\n  - Tagged\n    tags:: [[T1]]\n    alias:: K1" }] },
			c,
		);
		const sid = ids(added.output)[1] as string;
		await call(outlineReadTool, { address: ids(added.output)[0] as string }, c);
		const id = (await stored(w.space)).get(sid)?.id as string;
		const tagsOf = async () =>
			(await outlineStore.listOpenLinks([id], 10))
				.filter((l) => l.kind === "tag")
				.map((l) => l.targetRef);

		await humanWrite(w.space, w.alice, [{ op: "update", block: { id }, tags: ["T2"] }]);
		// The agent keeps the tags it read and changes the alias: their tags stay, its alias goes in.
		const kept = await call(
			outlineEditTool,
			{ edits: [{ replace: sid, text: "Tagged, edited\ntags:: [[T1]]\nalias:: K2" }] },
			c,
		);
		expect(kept.isError).toBeUndefined();
		expect(await tagsOf()).toEqual(["T2"]);
		expect((await stored(w.space)).get(sid)).toMatchObject({
			content: "Tagged, edited",
			alias: "K2",
		});

		await humanWrite(w.space, w.alice, [{ op: "update", block: { id }, alias: "K3" }]);
		const both = await call(
			outlineEditTool,
			{ edits: [{ replace: sid, text: "Tagged, edited\nalias:: K4" }] },
			c,
		);
		expect(both.isError).toBe(true);
		expect(both.output).toContain("you and they both changed its alias");
		expect((await stored(w.space)).get(sid)?.alias).toBe("K3");

		// Tags only the agent changes (the person changed the text) are written; tags both
		// changed, differently, refuse the call.
		await call(outlineReadTool, { address: sid }, c);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id }, content: "Tagged, edited by a person" },
		]);
		const ownTags = await call(
			outlineEditTool,
			{ edits: [{ replace: sid, text: "Tagged, edited\ntags:: [[T3]]" }] },
			c,
		);
		expect(ownTags.isError).toBeUndefined();
		expect(await tagsOf()).toEqual(["T3"]);
		expect((await stored(w.space)).get(sid)?.content).toBe("Tagged, edited by a person");
		await humanWrite(w.space, w.alice, [{ op: "update", block: { id }, tags: ["T4"] }]);
		const bothTags = await call(
			outlineEditTool,
			{ edits: [{ replace: sid, text: "Tagged, edited by a person\ntags:: [[T5]]" }] },
			c,
		);
		expect(bothTags.isError).toBe(true);
		expect(bothTags.output).toContain("you and they both changed its tags");
		expect(await tagsOf()).toEqual(["T4"]);
	});

	test("a move, delete or set of a block changed since the read is still refused", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a, b] = await readBlocks(w, c, ["first", "second"]);
		if (!a || !b) throw new Error("no blocks");
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "first, edited" },
		]);
		for (const edits of [
			[{ delete: a.sid }],
			[{ set: a.sid, checkbox: "x" }],
			[{ move: a.sid, to: b.sid }],
			[
				{ replace: a.sid, text: "first!" },
				{ set: a.sid, checkbox: "x" },
			],
		]) {
			const result = await call(outlineEditTool, { edits }, c);
			expect(result.isError).toBe(true);
			expect(result.output).toContain(`[${a.sid}] was changed by a person`);
			expect(result.output).toContain("a move, delete or set");
		}
		const row = (await stored(w.space)).get(a.sid);
		expect(row).toMatchObject({ content: "first, edited", deleted: false, taskJson: null });
	});

	test("a read recorded between two versions merges from the version valid then", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a] = await readBlocks(w, c, ["kept as is"]);
		if (!a) throw new Error("no block");
		const other = await humanWrite(w.space, w.alice, [
			{ op: "insert", parent: null, content: "another page" },
		]);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "kept as is, edited" },
		]);
		// A seq of the space at which this block has no version of its own: the one before holds.
		recordOutlineReads(w.session, [[a.id, other.commit?.seq as number]]);
		const result = await call(
			outlineEditTool,
			{ edits: [{ replace: a.sid, text: "Kept as is" }] },
			c,
		);
		expect(result.isError).toBeUndefined();
		expect((await stored(w.space)).get(a.sid)?.content).toBe("Kept as is, edited");
	});

	test("the agent's own commit that left a block unchanged still merges later", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [b] = await readBlocks(w, c, ["Block B is here."]);
		if (!b) throw new Error("no block");
		// Same text plus a child: the commit adds the child; B itself keeps its version.
		const withChild = await call(
			outlineEditTool,
			{ edits: [{ replace: b.sid, text: "Block B is here.\n  - a child" }] },
			c,
		);
		expect(withChild.isError).toBeUndefined();
		const row = (await stored(w.space)).get(b.sid);
		expect(row?.versionSeq).toBeLessThan((withChild.metadata?.commit as { seq: number }).seq);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: b.id }, content: "Block B is here. A person added this." },
		]);
		const merged = await call(
			outlineEditTool,
			{ edits: [{ replace: b.sid, text: "Agent: Block B is here." }] },
			c,
		);
		expect(merged.isError).toBeUndefined();
		expect((await stored(w.space)).get(b.sid)?.content).toBe(
			"Agent: Block B is here. A person added this.",
		);
	});

	test("a read from before the block existed is refused, not guessed", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		await humanWrite(w.space, w.alice, [{ op: "insert", parent: null, content: "first page" }]);
		const [a] = await readBlocks(w, c, ["kept as is"]);
		if (!a) throw new Error("no block");
		const created = (await stored(w.space)).get(a.sid)?.versionSeq as number;
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "kept as is, edited" },
		]);
		recordOutlineReads(w.session, [[a.id, created - 1]]);
		const result = await call(outlineEditTool, { edits: [{ replace: a.sid, text: "agent" }] }, c);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("the version you read is no longer in its history");
		expect((await stored(w.space)).get(a.sid)?.content).toBe("kept as is, edited");
	});

	test("merged blocks past what a result shows are not taken as read", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a, b] = await readBlocks(w, c, ["Alpha text.", "Beta text."]);
		if (!a || !b) throw new Error("no blocks");
		const seenB = seenOutlineVersion(w.session, b.id);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "Alpha text. Human A." },
			{ op: "update", block: { id: b.id }, content: "Beta text. Human B." },
		]);
		const limits = OUTLINE_EDIT_LIMITS as { maxMergedBytes: number };
		const saved = limits.maxMergedBytes;
		limits.maxMergedBytes = 1;
		let output = "";
		try {
			const merged = await call(
				outlineEditTool,
				{
					edits: [
						{ replace: b.sid, text: "Agent: Beta text." },
						{ replace: a.sid, text: "Agent: Alpha text." },
					],
				},
				c,
			);
			expect(merged.isError).toBeUndefined();
			output = merged.output;
		} finally {
			limits.maxMergedBytes = saved;
		}
		// The first in the call's order is shown and read; the second is named, and not read.
		expect(output).toContain(
			`1. replaced [${b.sid}], merged with changes made after you read it (shown below)`,
		);
		expect(output).toContain(`\n- [${b.sid}] Agent: Beta text. Human B.`);
		expect(output).toContain(
			`2. replaced [${a.sid}], merged with changes made after you read it; not shown: read it before changing it again`,
		);
		expect(output).toContain(`also merged, not shown here: [${a.sid}]`);
		expect(output).not.toContain("Agent: Alpha text. Human A.");
		const rows = await stored(w.space);
		expect(seenOutlineVersion(w.session, b.id)).toBe(rows.get(b.sid)?.versionSeq);
		expect(seenOutlineVersion(w.session, b.id)).not.toBe(seenB);
		expect(seenOutlineVersion(w.session, a.id)).toBeLessThan(rows.get(a.sid)?.versionSeq as number);
		// Its next edit from the text it read merges again: the person's sentence stays (and an
		// edit at the place its own merge wrote overlaps it, so it is refused, not written over).
		const overlap = await call(
			outlineEditTool,
			{ edits: [{ replace: a.sid, text: "Agent v2: Alpha text." }] },
			c,
		);
		expect(overlap.isError).toBe(true);
		const again = await call(
			outlineEditTool,
			{ edits: [{ replace: a.sid, text: "Alfa text." }] },
			c,
		);
		expect(again.isError).toBeUndefined();
		expect((await stored(w.space)).get(a.sid)?.content).toBe("Agent: Alfa text. Human A.");
	});

	test("the agent's own move does not hide a person's change of a block under it", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: "- Page one\n  - Section\n    - child text" },
					{ add: "/", markdown: "- Page two" },
				],
			},
			c,
		);
		const [p1, section, child, p2] = ids(added.output) as [string, string, string, string];
		await call(outlineReadTool, { address: p1 }, c);
		const childId = (await stored(w.space)).get(child)?.id as string;
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: childId }, content: "child text, and a person's note" },
		]);
		// The move writes a page change of the child, by the agent, over the person's edit.
		const moved = await call(outlineEditTool, { edits: [{ move: section, to: p2 }] }, c);
		expect(moved.isError).toBeUndefined();
		const deleted = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(deleted.isError).toBe(true);
		expect(deleted.output).toContain(`[${child}] was changed by a person`);
		expect((await stored(w.space)).get(section)?.deleted).toBe(false);
		// Shown in full by the refusal, the child now counts as read: a replace from that text
		// merges with what the person writes next.
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: childId }, content: "child text, and a person's note. More." },
		]);
		const replaced = await call(
			outlineEditTool,
			{ edits: [{ replace: child, text: "Child text, and a person's note" }] },
			c,
		);
		expect(replaced.isError).toBeUndefined();
		expect((await stored(w.space)).get(child)?.content).toBe(
			"Child text, and a person's note. More.",
		);
	});

	test("the agent's own move, then a replace from its earlier read, merges", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: "- Page one\n  - Section\n    - child text" },
					{ add: "/", markdown: "- Page two" },
				],
			},
			c,
		);
		const [p1, section, child, p2] = ids(added.output) as [string, string, string, string];
		await call(outlineReadTool, { address: p1 }, c);
		const childId = (await stored(w.space)).get(child)?.id as string;
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: childId }, content: "child text, and a person's note" },
		]);
		await call(outlineEditTool, { edits: [{ move: section, to: p2 }] }, c);
		const replaced = await call(
			outlineEditTool,
			{ edits: [{ replace: child, text: "Child text" }] },
			c,
		);
		expect(replaced.isError).toBeUndefined();
		expect(replaced.output).toContain("merged with changes made after you read it");
		expect((await stored(w.space)).get(child)?.content).toBe("Child text, and a person's note");
	});

	test("merges are bounded before they start: text, block size and time", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a] = await readBlocks(w, c, ["Short."]);
		if (!a) throw new Error("no block");
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: `Short. ${"Long text. ".repeat(1400)}` },
		]);
		// The block's current text plus the call's other text is more than one write takes.
		const big = `${"Other text. ".repeat(1300)}`;
		const tooMuch = await call(
			outlineEditTool,
			{
				edits: [
					{ replace: a.sid, text: "Shorter." },
					...Array.from({ length: 9 }, () => ({ add: "/", markdown: `- ${big}` })),
				],
			},
			c,
		);
		expect(tooMuch.isError).toBe(true);
		expect(tooMuch.output).toContain("one call can merge and write besides its other text");
		// No time left for merging: refused, nothing written.
		const saved = AGENT_MERGE_LIMITS.timeMs;
		AGENT_MERGE_LIMITS.timeMs = 0;
		try {
			const slow = await call(
				outlineEditTool,
				{ edits: [{ replace: a.sid, text: "Shorter." }] },
				c,
			);
			expect(slow.isError).toBe(true);
			expect(slow.output).toContain("took longer than");
		} finally {
			AGENT_MERGE_LIMITS.timeMs = saved;
		}
		expect((await stored(w.space)).get(a.sid)?.content?.startsWith("Short. Long text.")).toBe(true);
	});

	test("long texts merge on the text worker", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const long = `${"A sentence about refresh tokens and their lifetime. ".repeat(40)}End.`;
		expect(Buffer.byteLength(long)).toBeGreaterThan(OUTLINE_EDIT_TEXT_LIMITS.inlineBytes);
		const [b] = await readBlocks(w, c, [long]);
		if (!b) throw new Error("no block");
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: b.id }, content: `${long} Reviewed.` },
		]);
		const result = await call(
			outlineEditTool,
			{ edits: [{ replace: b.sid, text: `Summary first. ${long}` }] },
			c,
		);
		expect(result.isError).toBeUndefined();
		expect((await stored(w.space)).get(b.sid)?.content).toBe(`Summary first. ${long} Reviewed.`);
	});
});

describe("OutlineEdit of blocks the agent has not read", () => {
	/** A page of blocks a person wrote; their sids and ids, the page first. */
	async function personPage(w: World, texts: string[]) {
		const r = await humanWrite(w.space, w.alice, [
			{ op: "insert", tempId: "p", parent: null, content: "Their page" },
			...texts.map((content, i) => ({
				op: "insert" as const,
				tempId: `b${i}`,
				parent: { tempId: "p" },
				content,
			})),
		]);
		return r.results.map((x) => ({ sid: x.sid, id: x.blockId }));
	}

	test("a replace or delete of someone's unread block writes nothing and shows it whole", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [, a, b] = await personPage(w, ["first, as they wrote it", "second"]);
		if (!a || !b) throw new Error("no blocks");
		const refused = await call(
			outlineEditTool,
			{
				edits: [{ replace: a.sid, text: "first, by the agent" }, { delete: b.sid }],
			},
			c,
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("Nothing was written");
		expect(refused.output).toMatch(
			new RegExp(
				`\\[${a.sid}\\] was last written by a person in commit #\\d+, and you have not read it`,
			),
		);
		expect(refused.output).toContain(`[${b.sid}] was last written by a person`);
		expect(refused.output).toContain("its current text is shown in full below");
		expect(refused.output).toContain(`\n- [${a.sid}] first, as they wrote it`);
		expect(refused.output).toContain(`\n- [${b.sid}] second`);
		expect(refused.output).not.toContain("Read those blocks again");
		const rows = await stored(w.space);
		expect(rows.get(a.sid)?.content).toBe("first, as they wrote it");
		expect(rows.get(b.sid)?.deleted).toBe(false);
		// Shown in full, they count as read: the same edit goes through now.
		expect(seenOutlineVersion(w.session, a.id)).toBe(rows.get(a.sid)?.versionSeq);
		const again = await call(
			outlineEditTool,
			{
				edits: [{ replace: a.sid, text: "first, by the agent" }, { delete: b.sid }],
			},
			c,
		);
		expect(again.isError).toBeUndefined();
		const after = await stored(w.space);
		expect(after.get(a.sid)?.content).toBe("first, by the agent");
		expect(after.get(b.sid)?.deleted).toBe(true);
	});

	test("after a restart reads are gone: someone's blocks need a read again, its own do not", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [, theirs] = await personPage(w, ["they wrote this"]);
		if (!theirs) throw new Error("no block");
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- mine" }] }, c);
		const mine = ids(added.output)[0] as string;
		await call(outlineReadTool, { address: theirs.sid }, c);
		// The server restarts (the ledger is in memory), and the person edits meanwhile.
		clearOutlineReads();
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: theirs.id }, content: "they wrote this, then more" },
		]);
		const own = await call(outlineEditTool, { edits: [{ replace: mine, text: "mine, v2" }] }, c);
		expect(own.isError).toBeUndefined();
		const stale = await call(
			outlineEditTool,
			{ edits: [{ replace: theirs.sid, text: "agent text from before" }] },
			c,
		);
		expect(stale.isError).toBe(true);
		expect(stale.output).toContain("you have not read it");
		expect(stale.output).toContain("forgotten when the server restarts");
		expect(stale.output).toContain(`- [${theirs.sid}] they wrote this, then more`);
		expect((await stored(w.space)).get(theirs.sid)?.content).toBe("they wrote this, then more");
		// Redone on the text shown, it goes in; a later change by the person merges again.
		const redone = await call(
			outlineEditTool,
			{ edits: [{ replace: theirs.sid, text: "They wrote this, then more" }] },
			c,
		);
		expect(redone.isError).toBeUndefined();
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: theirs.id }, content: "They wrote this, then more. And more." },
		]);
		const merged = await call(
			outlineEditTool,
			{ edits: [{ replace: theirs.sid, text: "THEY wrote this, then more" }] },
			c,
		);
		expect(merged.isError).toBeUndefined();
		expect((await stored(w.space)).get(theirs.sid)?.content).toBe(
			"THEY wrote this, then more. And more.",
		);
	});

	test("a move or set of an unread block is written as before", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [page, a, b] = await personPage(w, ["a", "b"]);
		if (!page || !a || !b) throw new Error("no blocks");
		const result = await call(
			outlineEditTool,
			{
				edits: [
					{ set: a.sid, checkbox: "x" },
					{ move: b.sid, to: a.sid },
				],
			},
			c,
		);
		expect(result.isError).toBeUndefined();
		const rows = await stored(w.space);
		expect(rows.get(a.sid)?.taskJson?.status).toBe("done");
		expect(rows.get(b.sid)?.parentId).toBe(a.id);
		// Neither counts as reading them: their text still needs a read before a replace.
		expect(seenOutlineVersion(w.session, a.id)).toBeUndefined();
		const replaced = await call(outlineEditTool, { edits: [{ replace: a.sid, text: "agent" }] }, c);
		expect(replaced.isError).toBe(true);
		expect(replaced.output).toContain("you have not read it");
		expect((await stored(w.space)).get(a.sid)?.content).toBe("a");
	});

	test("a page list shows titles only: it does not count as reading the pages", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const long = `Plan: ${"the part after the title that a page list never shows. ".repeat(6)}END`;
		const r = await humanWrite(w.space, w.alice, [{ op: "insert", parent: null, content: long }]);
		const sid = r.results[0]?.sid as string;
		const list = await call(outlineReadTool, { address: `${w.space.key}/` }, c);
		expect(list.output).toContain(`[${sid}]`);
		expect(list.output).not.toContain("END");
		const refused = await call(outlineEditTool, { edits: [{ replace: sid, text: "Plan" }] }, c);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain("you have not read it");
		expect(refused.output).toContain("END");
		expect((await stored(w.space)).get(sid)?.content).toBe(long);
	});
});

describe("OutlineEdit delete and what is under the block", () => {
	test("blocks under it changed or added by someone since the read refuse the delete", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Plan\n  - Section\n    - detail\n    - agent's note" }] },
			c,
		);
		const [, section, detail, note] = ids(added.output) as [string, string, string, string];
		await call(outlineReadTool, { address: section }, c);
		const rows = await stored(w.space);
		const id = (sid: string) => rows.get(sid)?.id as string;
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: id(detail) }, content: "detail, worked out by a person" },
			{ op: "insert", tempId: "n", parent: { id: id(section) }, content: "a person's new block" },
			{ op: "insert", parent: { tempId: "n" }, content: "and one under it" },
		]);
		const refused = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(`[${detail}] was changed by a person`);
		expect(refused.output).toContain(`it is under [${section}], which you are deleting with it`);
		expect(refused.output).toMatch(
			/\] was last written by a person in commit #\d+, and you have not read it/,
		);
		expect(refused.output).toContain(`- [${detail}] detail, worked out by a person`);
		expect(refused.output).toContain("- [");
		expect(refused.output).toContain("a person's new block");
		expect(refused.output).toContain("and one under it");
		// The section itself and the agent's own note are not in question.
		expect(refused.output).not.toContain(`[${section}] was`);
		expect(refused.output).not.toContain(`[${note}] was`);
		expect((await stored(w.space)).get(section)?.deleted).toBe(false);
		// Shown in full, they count as read: the same delete goes through now.
		const again = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(again.isError).toBeUndefined();
		const after = await stored(w.space);
		expect([section, detail, note].map((sid) => after.get(sid)?.deleted)).toEqual([
			true,
			true,
			true,
		]);
	});

	test("with several deletes, each is judged on what is left to check", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: "- Big\n  - 1\n  - 2\n  - 3\n  - 4" },
					{ add: "/", markdown: "- Small\n  - s" },
				],
			},
			c,
		);
		const got = ids(added.output);
		const big = got[0] as string;
		const small = got[5] as string;
		const limits = OUTLINE_EDIT_LIMITS as { maxDeletedChecked: number };
		const saved = limits.maxDeletedChecked;
		limits.maxDeletedChecked = 3;
		try {
			const r = await call(outlineEditTool, { edits: [{ delete: big }, { delete: small }] }, c);
			expect(r.isError).toBe(true);
			expect(r.output).toContain(`[${big}] has more than 3 blocks under it`);
			expect(r.output).not.toContain(`[${small}]`);
			// The small one first: it fits, and the big one gets what is left, said as such.
			const r2 = await call(outlineEditTool, { edits: [{ delete: small }, { delete: big }] }, c);
			expect(r2.output).toContain(
				`[${big}] has more than 2 blocks under it, which is what was left to check`,
			);
			expect(r2.output).not.toContain(`[${small}] has`);
		} finally {
			limits.maxDeletedChecked = saved;
		}
	});

	test("more blocks under it than are checked refuse the delete and say so", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const markdown = ["- Big", ...Array.from({ length: 4 }, (_, i) => `  - part ${i}`)].join("\n");
		const added = await call(outlineEditTool, { edits: [{ add: "/", markdown }] }, c);
		const big = ids(added.output)[0] as string;
		const limits = OUTLINE_EDIT_LIMITS as { maxDeletedChecked: number };
		const saved = limits.maxDeletedChecked;
		limits.maxDeletedChecked = 3;
		try {
			const refused = await call(outlineEditTool, { edits: [{ delete: big }] }, c);
			expect(refused.isError).toBe(true);
			expect(refused.output).toContain(`[${big}] has more than 3 blocks under it`);
			expect((await stored(w.space)).get(big)?.deleted).toBe(false);
			limits.maxDeletedChecked = 4;
			const fits = await call(outlineEditTool, { edits: [{ delete: big }] }, c);
			expect(fits.isError).toBeUndefined();
		} finally {
			limits.maxDeletedChecked = saved;
		}
	});

	test("a move takes the whole subtree along and is not checked below the block", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- A\n  - under A\n- B" }] },
			c,
		);
		const [a, child, b] = ids(added.output) as [string, string, string];
		await call(outlineReadTool, { address: a }, c);
		const rows = await stored(w.space);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: rows.get(child)?.id as string }, content: "under A, edited" },
		]);
		const moved = await call(outlineEditTool, { edits: [{ move: a, to: b }] }, c);
		expect(moved.isError).toBeUndefined();
		expect((await stored(w.space)).get(child)?.content).toBe("under A, edited");
	});
});

describe("OutlineEdit read rules at their edges", () => {
	test("a set of an unread block under a block the call deletes does not hide it", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Agent page\n  - Agent section" }] },
			c,
		);
		const section = ids(added.output)[1] as string;
		const sectionId = (await stored(w.space)).get(section)?.id as string;
		const r = await humanWrite(w.space, w.alice, [
			{ op: "insert", parent: { id: sectionId }, content: "a person's careful notes" },
		]);
		const theirs = r.results[0]?.sid as string;
		const both = await call(
			outlineEditTool,
			{
				edits: [{ set: theirs, checkbox: "x" }, { delete: section }],
			},
			c,
		);
		expect(both.isError).toBe(true);
		expect(both.output).toContain(`[${theirs}] was last written by a person`);
		expect(both.output).toContain(`it is under [${section}], which you are deleting with it`);
		expect((await stored(w.space)).get(theirs)?.deleted).toBe(false);
	});

	test("after a restart, the agent's own merge is not taken as text it wrote", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a, b] = await readBlocksOf(w, c, ["Alpha text.", "Beta text."]);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "Alpha text. Human A." },
			{ op: "update", block: { id: b.id }, content: "Beta text. Human B." },
		]);
		const limits = OUTLINE_EDIT_LIMITS as { maxMergedBytes: number };
		const saved = limits.maxMergedBytes;
		limits.maxMergedBytes = 1;
		try {
			const merged = await call(
				outlineEditTool,
				{
					edits: [
						{ replace: a.sid, text: "Agent: Alpha text." },
						{ replace: b.sid, text: "Agent: Beta text." },
					],
				},
				c,
			);
			expect(merged.output).toContain(`also merged, not shown here: [${b.sid}]`);
		} finally {
			limits.maxMergedBytes = saved;
		}
		clearOutlineReads(); // a restart
		const again = await call(
			outlineEditTool,
			{ edits: [{ replace: b.sid, text: "Agent v2: Beta text." }] },
			c,
		);
		expect(again.isError).toBe(true);
		expect(again.output).toContain(`[${b.sid}] was last written by someone`);
		expect(again.output).toContain(`- [${b.sid}] Agent: Beta text. Human B.`);
		expect((await stored(w.space)).get(b.sid)?.content).toBe("Agent: Beta text. Human B.");
	});

	test("after a restart, a person's move of the agent's blocks is not their text", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: "- Agent page\n  - Section\n    - one\n    - two" },
					{ add: "/", markdown: "- Other page" },
				],
			},
			c,
		);
		const [, section, one, two, other] = ids(added.output) as [
			string,
			string,
			string,
			string,
			string,
		];
		const rows = await stored(w.space);
		await humanWrite(w.space, w.alice, [
			{
				op: "move",
				block: { id: rows.get(section)?.id as string },
				parent: { id: rows.get(other)?.id as string },
			},
		]);
		clearOutlineReads(); // a restart
		// A checkbox the person set is theirs, though: that block needs a read.
		await humanWrite(w.space, w.alice, [
			{ op: "setTask", block: { id: rows.get(two)?.id as string }, task: { status: "done" } },
		]);
		const refused = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(`[${two}] was last written by a person`);
		expect(refused.output).not.toContain(`[${one}] was`);
		expect(refused.output).not.toContain(`[${section}] was`);
		const del = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(del.isError).toBeUndefined();
	});

	test("past the scan of a block's versions, someone else is assumed to have written it", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{ add: "/", markdown: "- Page one\n  - Section\n    - child" },
					{ add: "/", markdown: "- Page two" },
				],
			},
			c,
		);
		const [p1, section, child, p2] = ids(added.output) as [string, string, string, string];
		await call(outlineReadTool, { address: p1 }, c);
		// The agent moves the section between pages again and again: every move writes a page
		// change of the child, by the agent, past what one check looks through.
		for (let i = 0; i <= OUTLINE_LAST_WRITES_SCAN; i++) {
			const moved = await call(
				outlineEditTool,
				{ edits: [{ move: section, to: i % 2 ? p1 : p2 }] },
				c,
			);
			expect(moved.isError).toBeUndefined();
		}
		const refused = await call(outlineEditTool, { edits: [{ delete: section }] }, c);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(`[${child}] was changed by someone`);
		expect((await stored(w.space)).get(child)?.deleted).toBe(false);
	});

	test("the merge's time budget covers waiting for the text runner", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const [a] = await readBlocksOf(w, c, ["Short text."]);
		await humanWrite(w.space, w.alice, [
			{ op: "update", block: { id: a.id }, content: "Short text. More." },
		]);
		const saved = { run: AGENT_MERGE_HOOKS.run, timeMs: AGENT_MERGE_LIMITS.timeMs };
		let cancelled = false;
		// A runner busy with other jobs: this one would start only after a while.
		AGENT_MERGE_HOOKS.run = (job, options) =>
			new Promise((resolve, reject) => {
				const t = setTimeout(() => resolve(saved.run(job, options)), 400);
				options.signal?.addEventListener("abort", () => {
					cancelled = true;
					clearTimeout(t);
					reject(new Error("cancelled"));
				});
			});
		AGENT_MERGE_LIMITS.timeMs = 50;
		try {
			const started = Date.now();
			const slow = await call(
				outlineEditTool,
				{ edits: [{ replace: a.sid, text: "Short text!" }] },
				c,
			);
			expect(Date.now() - started).toBeLessThan(350);
			expect(slow.isError).toBe(true);
			expect(slow.output).toContain("took longer than");
			expect(cancelled).toBe(true);
		} finally {
			AGENT_MERGE_HOOKS.run = saved.run;
			AGENT_MERGE_LIMITS.timeMs = saved.timeMs;
		}
		expect((await stored(w.space)).get(a.sid)?.content).toBe("Short text. More.");
	});
});

describe("OutlineEdit write rules", () => {
	test("a turn without a person writes nothing", async () => {
		const w = await world();
		const result = await call(
			outlineEditTool,
			{ edits: [{ add: "session/", markdown: "- x" }] },
			ctx(w.session, null),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("without a person behind it");
	});

	for (const mode of [
		{ name: "read-only mode", set: { permissionMode: "readOnly" as const } },
		{ name: "strict plan mode", set: { traits: ["plan"], relaxedPlan: false } },
	]) {
		test(`${mode.name} writes only the session's own space`, async () => {
			const w = await world();
			await db.update(narrators).set(mode.set).where(eq(narrators.id, w.session));
			const c = ctx(w.session, w.alice);
			const project = await call(
				outlineEditTool,
				{ edits: [{ add: "project/", markdown: "- x" }] },
				c,
			);
			expect(project.isError).toBe(true);
			expect(project.output).toContain("writes only this session's own space");
			const fallback = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- y" }] }, c);
			expect(fallback.isError).toBeUndefined();
			expect(fallback.output).toContain("this session's notes");
			expect(fallback.output).toContain("new pages went to this session's notes");
			const session = await call(
				outlineEditTool,
				{ edits: [{ add: "session/", markdown: "- z" }] },
				c,
			);
			expect(session.isError).toBeUndefined();
		});
	}

	test("relaxed planning keeps the session's own permission mode", async () => {
		const w = await world();
		await db
			.update(narrators)
			.set({ traits: ["plan"], relaxedPlan: true })
			.where(eq(narrators.id, w.session));
		const result = await call(
			outlineEditTool,
			{ edits: [{ add: "project/", markdown: "- planned" }] },
			ctx(w.session, w.alice),
		);
		expect(result.isError).toBeUndefined();
	});

	test("a person who may not write the project falls back to the session's space", async () => {
		const alice = await user("alice");
		const bob = await user("bob");
		const projectId = await project(alice, "Public", "public");
		const session = await narrator(bob, projectId);
		const c = ctx(session, bob);
		const direct = await call(
			outlineEditTool,
			{ edits: [{ add: "project/", markdown: "- x" }] },
			c,
		);
		expect(direct.isError).toBe(true);
		expect(direct.output).toContain("may not write");
		const fallback = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- y" }] }, c);
		expect(fallback.isError).toBeUndefined();
		expect(fallback.output).toContain("new pages went to this session's notes");
	});
});

describe("large edits", () => {
	test("text past the inline size is parsed and rewritten on the worker, with the same result", async () => {
		const w = await world();
		const c = ctx(w.session, w.alice);
		const base = await call(outlineEditTool, { edits: [{ add: "/", markdown: "- Glossary" }] }, c);
		const glossary = ids(base.output)[0] as string;
		const items = Array.from(
			{ length: 40 },
			(_, i) => `- Term ${i}: **bold** words, \`code\` and a link to [[Glossary]] — 中文说明 ${i}`,
		);
		const markdown = items.join("\n");
		expect(Buffer.byteLength(markdown)).toBeGreaterThan(OUTLINE_EDIT_TEXT_LIMITS.inlineBytes);
		const result = await call(outlineEditTool, { edits: [{ add: glossary, markdown }] }, c);
		expect(result.isError).toBeUndefined();
		expect(ids(result.output)).toHaveLength(40);
		const term = await byContent(
			w.space,
			`Term 7: **bold** words, \`code\` and a link to [[${w.space.key}/${glossary}]] — 中文说明 7`,
		);
		expect(term.parentId).not.toBeNull();
	});
});

describe("through the tool executor", () => {
	test("read, edit and read again in one session", async () => {
		const w = await world();
		const permissions: string[] = [];
		const config: AgentConfig = {
			narratorId: w.session,
			conversationId: "outline-e2e",
			model: "codex:gpt-5.5",
			provider: "codex",
			cwd: "/tmp",
			signal: new AbortController().signal,
			userId: w.alice,
			permissionHandler: async (toolName) => {
				permissions.push(toolName);
				return { behavior: "allow" };
			},
		};
		const run = (name: string, input: Record<string, unknown>, toolUseId: string) =>
			executeTool({ toolUseId, name, input }, config);

		const overview = await run("OutlineRead", {}, "e2e-1");
		expect(overview.isError).toBeFalsy();
		expect(overview.output).toContain("no pages yet");

		const added = await run(
			"OutlineEdit",
			{ edits: [{ add: "/", markdown: "- Release plan\n  - [ ] Tag the build" }] },
			"e2e-2",
		);
		expect(added.isError).toBeFalsy();
		const [page, task] = ids(added.output) as [string, string];

		const read = await run("OutlineRead", { address: "Release plan", view: "all" }, "e2e-3");
		expect(read.output).toContain(`- [${page}] Release plan\n  - [${task}] [ ] Tag the build`);

		const done = await run("OutlineEdit", { edits: [{ set: task, checkbox: "x" }] }, "e2e-4");
		expect(done.isError).toBeFalsy();
		const again = await run("OutlineRead", { address: page, view: "all" }, "e2e-5");
		expect(again.output).toContain(`- [${task}] [x] Tag the build`);

		const found = await run("OutlineSearch", { query: "Tag the build" }, "e2e-6");
		expect(found.output).toContain(`[${w.space.key}/${task}]`);
		expect(permissions).toEqual([
			"OutlineRead",
			"OutlineEdit",
			"OutlineRead",
			"OutlineEdit",
			"OutlineRead",
			"OutlineSearch",
		]);
	});
});
