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
import { OUTLINE_EDIT_TEXT_LIMITS, stopEditTextWorker } from "../edit-text-runner";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
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
