/**
 * The agent's outline tools without pages (pageless outline, A1), on the isolated SQLite
 * database:
 *
 *   - the contract of every address form and every edit, with parents anywhere in a space;
 *   - equivalence: on a fixture, everything a read by page could show is reachable by block,
 *     and the same content costs no more characters than it did;
 *   - continuing a long level with `after`, now and as of a seq;
 *   - the behavior boundary judged by ancestry (the write check, the session's open tasks);
 *   - access: the session's space, the project's, and a space of someone else.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineBlocks, projects, users } from "../../../db/schema";
import {
	outlineEditTool,
	outlineReadTool,
	outlineSearchTool,
} from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { taskSourceForNarrator } from "../../task-source";
import { stopEditTextWorker } from "../edit-text-runner";
import { OutlineWriteError } from "../errors";
import { OUTLINE_TEXT, OUTLINE_TOOL_TEXT } from "../messages";
import { OUTLINE_BEHAVIOR_ALIAS } from "../model";
import { readOutline } from "../read";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { blocksUnder, findBehaviorBlock, findTasksBlock } from "../well-known";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-15T00:00:00.000Z";

async function user(label: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role: "user", createdAt: NOW });
	return id;
}

async function project(owner: string, name: string): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name,
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function narrator(owner: string, projectId: string | null): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "pageless tools",
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function ctx(narratorId: string, userId: string | null): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function call(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	return await tool.execute(args, context);
}

function humanWrite(space: OutlineSpaceRow, userId: string, ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: userId },
		responsibleUserId: userId,
	});
}

/** The addresses a result lists after bullets, in order. */
function ids(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

async function row(space: OutlineSpaceRow, sid: string) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	const found = rows.find((r) => r.sid === sid);
	if (!found) throw new Error(`no block ${sid}`);
	return found;
}

async function world() {
	const alice = await user("alice");
	const projectId = await project(alice, "Atlas");
	const session = await narrator(alice, projectId);
	const space = await ensureProjectSpace(projectId);
	return { alice, projectId, session, space, c: ctx(session, alice) };
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

describe("addresses: any block, by every form", () => {
	test("id, key/id, alias, title, a space's top level, the own spaces, the overview", async () => {
		const w = await world();
		const added = await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: [
							"- Design notes",
							"  - Storage",
							"    - Blocks sit directly in a space",
							"      alias:: D7",
							"- Second top",
						].join("\n"),
					},
				],
			},
			w.c,
		);
		const [top, storage, deep, second] = ids(added.output) as [string, string, string, string];
		// A bare id of a nested block: the block and what is under it, and where it sits.
		const byId = await call(outlineReadTool, { address: storage }, w.c);
		expect(byId.output.split("\n")[0]).toBe(
			`‹space ${w.space.key} · this session's project "Atlas" · in Design notes›`,
		);
		expect(ids(byId.output)).toEqual([storage, deep]);
		// key/id, an alias, a title: the same block.
		for (const address of [`${w.space.key}/${deep}`, "D7", "Blocks sit directly in a space"]) {
			const read = await call(outlineReadTool, { address }, w.c);
			expect(read.isError).toBeUndefined();
			expect(ids(read.output)).toEqual([deep]);
			expect(read.output.split("\n")[0]).toContain("in Design notes › Storage");
			expect(read.metadata?.rootId).toBe((await row(w.space, deep)).id);
		}
		// A space's top level, by key and by word: titles only, each with its address.
		for (const address of [`${w.space.key}/`, "project/", "/"]) {
			const listed = await call(outlineReadTool, { address }, w.c);
			expect(ids(listed.output)).toEqual([top, second]);
			expect(listed.output).not.toContain("Storage");
		}
		// No address: the own spaces; "*": every readable space, expanded.
		const own = await call(outlineReadTool, {}, w.c);
		expect(ids(own.output)).toEqual([top, second]);
		const overview = await call(outlineReadTool, { address: "*" }, w.c);
		expect(ids(overview.output)).toEqual([top, storage, deep, second]);
		// Nothing the model gets back, text or metadata, knows a page.
		for (const result of [byId, own, overview]) {
			expect(result.output).not.toMatch(/page/i);
			expect(JSON.stringify(result.metadata)).not.toMatch(/page/i);
		}
	});

	test("search results say where a block sits by its ancestors' titles", async () => {
		const w = await world();
		await call(
			outlineEditTool,
			{
				edits: [
					{
						add: "/",
						markdown: "- Auth module\n  - Tokens\n    - Refresh tokens rotate nightly (wombat)",
					},
				],
			},
			w.c,
		);
		const found = await call(outlineSearchTool, { query: "wombat" }, w.c);
		expect(found.output).toContain("in Auth module › Tokens");
		expect(found.output).not.toMatch(/page/i);
		const results = found.metadata?.results as Array<{ address: string; path: string[] }>;
		expect(results[0]?.path).toEqual(["Auth module", "Tokens"]);
		expect(JSON.stringify(found.metadata)).not.toMatch(/page/i);
		// A result is read by its address.
		const read = await call(outlineReadTool, { address: results[0]?.address }, w.c);
		expect(read.output).toContain("Refresh tokens rotate nightly");
	});
});

describe("edits: every operation, parents anywhere in the space", () => {
	test("add, replace, set, move across top-level blocks and to the top, delete", async () => {
		const w = await world();
		const first = await call(
			outlineEditTool,
			{
				edits: [
					{ add: `${w.space.key}/`, markdown: "- Alpha\n  - a1\n    - a1x\n  - a2" },
					{ add: "project/", markdown: "- Beta\n  - b1" },
				],
			},
			w.c,
		);
		expect(first.isError).toBeUndefined();
		expect(first.output).toContain("added at the top level:");
		const [alpha, a1, a1x, a2, beta, b1] = ids(first.output) as string[];
		// Add under a block three levels down, before a sibling.
		const under = await call(
			outlineEditTool,
			{ edits: [{ add: a1, markdown: "- a1w", before: a1x }] },
			w.c,
		);
		const a1w = ids(under.output)[0] as string;
		// Move a nested block under a block of another top-level block (no boundary between them),
		// then a block to the top level of the space, then a top-level block under another.
		const moved = await call(
			outlineEditTool,
			{
				edits: [
					{ move: a1, to: b1 },
					{ move: a2, to: `${w.space.key}/`, after: alpha },
				],
			},
			w.c,
		);
		expect(moved.isError).toBeUndefined();
		expect(moved.output).toContain(`moved [${a2}] under the top level of the space`);
		expect(moved.output).not.toMatch(/page/i);
		const nest = await call(outlineEditTool, { edits: [{ move: beta, to: alpha }] }, w.c);
		expect(nest.isError).toBeUndefined();
		const whole = await call(outlineReadTool, { address: alpha, view: "all" }, w.c);
		expect(ids(whole.output)).toEqual([alpha, beta, b1, a1, a1w, a1x]);
		expect(ids((await call(outlineReadTool, { address: "project/" }, w.c)).output)).toEqual([
			alpha,
			a2,
		]);
		// Replace and task operations on a block five levels down.
		const edit = await call(
			outlineEditTool,
			{
				edits: [
					{ replace: a1x, text: "a1x rewritten" },
					{ set: a1w, checkbox: "/", alias: "Q?" },
				],
			},
			w.c,
		);
		expect(edit.isError).toBeUndefined();
		expect((await row(w.space, a1x as string)).content).toBe("a1x rewritten");
		const task = await row(w.space, a1w);
		expect(task.taskJson).toMatchObject({ status: "doing" });
		expect(task.alias).toBe("Q1");
		// Delete a subtree that spans what were two top-level blocks.
		await call(outlineReadTool, { address: beta, view: "all" }, w.c);
		const gone = await call(outlineEditTool, { edits: [{ delete: beta }] }, w.c);
		expect(gone.isError).toBeUndefined();
		for (const sid of [beta, b1, a1, a1w, a1x]) {
			expect((await row(w.space, sid as string)).deleted).toBe(true);
		}
		expect((await row(w.space, alpha as string)).deleted).toBe(false);
	});

	test("a transcript replayed with calls in their old form still runs", async () => {
		const w = await world();
		// The schemas kept every parameter they had: the forms that used to make, move and
		// read pages are the forms for top-level blocks.
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Old page\n  - child" }], message: "old form" },
			w.c,
		);
		const [top, child] = ids(added.output) as [string, string];
		expect((await call(outlineReadTool, { address: top, budget: 2000 }, w.c)).isError).toBe(
			undefined,
		);
		expect(
			(await call(outlineEditTool, { edits: [{ move: child, to: `${w.space.key}/` }] }, w.c))
				.isError,
		).toBeUndefined();
		// A key no form ever had says what an edit takes, and writes nothing.
		const stray = await call(
			outlineEditTool,
			{ edits: [{ page: top, markdown: "- x" } as Record<string, unknown>] },
			w.c,
		);
		expect(stray.isError).toBe(true);
		expect(stray.output).toContain("Nothing was written.");
		expect(stray.output).toContain(
			"give exactly one of add, replace, move, delete, set, confirm, reject",
		);
		// `after` where there is no level to continue says how it is used.
		const noLevel = await call(outlineReadTool, { after: top }, w.c);
		expect(noLevel.isError).toBe(true);
		expect(noLevel.output).toBe(OUTLINE_TOOL_TEXT.afterNeedsLevel);
	});
});

describe("continuing a level", () => {
	test("a long level is read to its end with after, every block once and in order", async () => {
		const w = await world();
		const [parentId] = (
			await humanWrite(w.space, w.alice, [
				{ op: "insert", tempId: "p", parent: null, content: "Long level" },
			])
		).results.map((r) => r.blockId);
		for (let from = 0; from < 250; from += 125) {
			await humanWrite(
				w.space,
				w.alice,
				Array.from({ length: 125 }, (_, i) => ({
					op: "insert" as const,
					parent: { id: parentId as string },
					content: `item ${String(from + i).padStart(3, "0")}`,
				})),
			);
		}
		const parent = (await outlineStore.getBlock(parentId as string))?.sid as string;
		const seen: string[] = [];
		let read = await call(outlineReadTool, { address: parent }, w.c);
		let calls = 1;
		for (;;) {
			const texts = [...read.output.matchAll(/\] (item \d{3})$/gm)].map((m) => m[1] as string);
			seen.push(...texts);
			if (!/^ *‹… (?:\d+\+? )?more›$/m.test(read.output)) break;
			expect(read.metadata?.truncated).toBe(true);
			const last = ids(read.output).at(-1) as string;
			read = await call(outlineReadTool, { address: parent, after: last }, w.c);
			expect(read.isError).toBeUndefined();
			expect(++calls).toBeLessThan(10);
		}
		expect(seen).toEqual(
			Array.from({ length: 250 }, (_, i) => `item ${String(i).padStart(3, "0")}`),
		);
		// 79 with the parent, then 80 a call.
		expect(calls).toBe(4);
		// Past the end: nothing, said plainly.
		const end = await call(
			outlineReadTool,
			{ address: parent, after: ids(read.output).at(-1) },
			w.c,
		);
		expect(end.output).toContain(OUTLINE_TOOL_TEXT.nothingAfter);
		// A space's top level continues the same way.
		const tops = Array.from({ length: 130 }, (_, i) => ({
			op: "insert" as const,
			parent: null,
			content: `top ${i}`,
		}));
		await humanWrite(w.space, w.alice, tops);
		const listed = await call(outlineReadTool, { address: "project/" }, w.c);
		expect(ids(listed.output)).toHaveLength(100);
		const lastTop = ids(listed.output).at(-1) as string;
		expect(listed.output).toContain(
			`OutlineRead { address: "${w.space.key}/", after: "${lastTop}" }`,
		);
		const more = await call(outlineReadTool, { address: "project/", after: lastTop }, w.c);
		expect(ids(more.output)).toHaveLength(31);
		expect(more.output).not.toContain("after:");
	});

	test("after names a child of the block read: anything else is refused alike", async () => {
		const w = await world();
		const added = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- A\n  - a1\n    - deep\n  - a2\n- B\n  - b1" }] },
			w.c,
		);
		const [a, a1, deep, a2, , b1] = ids(added.output) as string[];
		const refused = OUTLINE_TOOL_TEXT.afterNotUnder;
		for (const after of [deep, b1, "nothing-like-this"]) {
			const read = await call(outlineReadTool, { address: a, after }, w.c);
			expect(read.isError).toBe(true);
			expect(read.output).toBe(refused(after as string, `${w.space.key}/${a}`));
		}
		const ok = await call(outlineReadTool, { address: a, after: a1 }, w.c);
		expect(ids(ok.output)).toEqual([a2]);
		// As of a seq: the level as it was then, continued from where the child sat then.
		const seq = ((await outlineStore.getSpace(w.space.id))?.nextSeq ?? 1) - 1;
		await call(outlineEditTool, { edits: [{ add: a, markdown: "- a3" }] }, w.c);
		const then = await call(outlineReadTool, { address: a, after: a1, asOf: seq }, w.c);
		expect(ids(then.output)).toEqual([a2]);
		expect(then.output.split("\n")[0]).toContain(`after [${a1}] · as of commit #${seq}`);
		const now = await call(outlineReadTool, { address: a, after: a1 }, w.c);
		expect(ids(now.output)).toHaveLength(2);
		// A cursor deleted since: refused, saying so and how to go on.
		await call(outlineEditTool, { edits: [{ delete: a1 }] }, w.c);
		const gone = await call(outlineReadTool, { address: a, after: a1 }, w.c);
		expect(gone.isError).toBe(true);
		expect(gone.output).toContain("moved or been deleted since");
		// The description says to keep asOf on a continued read.
		expect(outlineReadTool.description).toContain("Keep the same asOf when you continue");
	});

	test("lists of top-level blocks are only as they are now: asOf is refused, alike for any space", async () => {
		const w = await world();
		await call(outlineEditTool, { edits: [{ add: "/", markdown: "- A" }] }, w.c);
		const answers = [];
		for (const address of [`${w.space.key}/`, "project/", "Zz99Zz99/", ""]) {
			const read = await call(outlineReadTool, { address, asOf: 1 }, w.c);
			expect(read.isError).toBe(true);
			answers.push(read.output);
		}
		expect(new Set(answers)).toEqual(new Set([OUTLINE_TOOL_TEXT.listNotAsOf]));
		// Without asOf the list reads as before.
		const now = await call(outlineReadTool, { address: `${w.space.key}/` }, w.c);
		expect(now.isError).toBeUndefined();
		expect(now.output).toContain("A");
	});
});

describe("equivalence with reads by page, and what a read costs", () => {
	/** A fixture of three top-level trees: wide, deep, and one with tasks. */
	async function fixture() {
		const w = await world();
		const ops: OutlineOp[] = [];
		ops.push({ op: "insert", tempId: "wide", parent: null, content: "Wide tree" });
		for (let i = 0; i < 40; i++) {
			ops.push({
				op: "insert",
				tempId: `w${i}`,
				parent: { tempId: "wide" },
				content: `wide item ${i} with a sentence of ordinary length about item ${i}`,
			});
			if (i % 4 === 0) {
				ops.push({ op: "insert", parent: { tempId: `w${i}` }, content: `detail of ${i}` });
			}
		}
		ops.push({ op: "insert", tempId: "d0", parent: null, content: "Deep tree" });
		for (let i = 1; i < 12; i++) {
			ops.push({
				op: "insert",
				tempId: `d${i}`,
				parent: { tempId: `d${i - 1}` },
				content: `level ${i}`,
			});
		}
		ops.push({ op: "insert", tempId: "t", parent: null, content: "Work" });
		ops.push({
			op: "insert",
			tempId: "t1",
			parent: { tempId: "t" },
			content: "Ship the thing",
			task: { status: "todo" },
		});
		ops.push({ op: "insert", parent: { tempId: "t1" }, content: "a note under the task" });
		ops.push({ op: "insert", parent: { tempId: "t" }, content: "a fact beside the task" });
		const written = await humanWrite(w.space, w.alice, ops);
		// One result per operation, in order.
		const idOf = (tempId: string) =>
			written.results[ops.findIndex((op) => op.op === "insert" && op.tempId === tempId)]
				?.blockId as string;
		return { ...w, tops: [idOf("wide"), idOf("d0"), idOf("t")] };
	}

	test("every block a read by page showed is reached by block, with the same line", async () => {
		const f = await fixture();
		const label = (node: { sid: string }) => `[${node.sid}]`;
		for (const view of ["facts", "all"] as const) {
			for (const top of f.tops) {
				// Before: the page-keyed read, whole.
				const before = await readOutline({ blockId: top, view, budget: { blocks: 2000 }, label });
				if (!before) throw new Error("the fixture's block is not readable");
				const wanted = before.markdown
					.split("\n")
					.filter((line) => /^\s*- \[/.test(line))
					.map((line) => line.trim());
				// Now: by block, with the default budget, following every `‹… more›`.
				const sid = (await outlineStore.getBlock(top))?.sid as string;
				const got = new Set<string>();
				const queue: Array<{ address: string; after?: string }> = [{ address: sid }];
				let reads = 0;
				while (queue.length > 0) {
					const next = queue.shift() as { address: string; after?: string };
					const read = await call(outlineReadTool, { ...next, view, budget: 20 }, f.c);
					expect(read.isError).toBeUndefined();
					expect(++reads).toBeLessThan(200);
					const lines = read.output.split("\n");
					const shown: Array<{ sid: string; depth: number }> = [];
					for (const line of lines) {
						const item = /^(\s*)- \[([A-Za-z0-9]+)\]/.exec(line);
						if (item) {
							got.add(line.trim());
							shown.push({ sid: item[2] as string, depth: (item[1] as string).length / 2 });
							continue;
						}
						const more = /^(\s*)‹… (?:\d+\+? )?more›$/.exec(line);
						if (!more) continue;
						// The marker stands under the block whose children are not all shown: the
						// nearest block above it that is less indented.
						const depth = (more[1] as string).length / 2;
						const parent = [...shown].reverse().find((b) => b.depth < depth);
						const last = [...shown].reverse().find((b) => b.depth === depth);
						if (parent) {
							queue.push(last ? { address: parent.sid, after: last.sid } : { address: parent.sid });
						} else if (next.after && last) {
							// The level being continued goes on.
							queue.push({ address: next.address, after: last.sid });
						}
					}
				}
				expect([...got].sort()).toEqual([...wanted].sort());
			}
		}
	});

	test("the same subtree costs no more characters than it did", async () => {
		const f = await fixture();
		const label = (node: { sid: string }) => `[${node.sid}]`;
		const rows: string[] = [];
		for (const top of f.tops) {
			const sid = (await outlineStore.getBlock(top))?.sid as string;
			for (const budget of [8, 20, 80, 800]) {
				for (const view of ["facts", "all"] as const) {
					const before = await readOutline({
						blockId: top,
						view,
						budget: { blocks: budget },
						label,
					});
					const now = await call(outlineReadTool, { address: sid, view, budget }, f.c);
					// The read's own text: without the line naming the space, which is unchanged.
					const body = now.output.split("\n").slice(1).join("\n");
					const blocksBefore = before?.blockIds.length ?? 0;
					rows.push(
						`${sid} budget ${budget} ${view}: before ${before?.markdown.length} chars / ${blocksBefore} blocks, now ${body.length} chars / ${now.metadata?.blocks} blocks`,
					);
					expect(now.metadata?.blocks).toBe(blocksBefore);
					// Never more text than before for the same blocks.
					expect(body.length).toBeLessThanOrEqual(before?.markdown.length ?? 0);
				}
			}
		}
		console.log(`[agent-pageless] characters per read, before and now:\n${rows.join("\n")}`);
	});

	test("outputs stay bounded whatever is under the block", async () => {
		const w = await world();
		const [root] = (
			await humanWrite(w.space, w.alice, [{ op: "insert", parent: null, content: "Big" }])
		).results.map((r) => r.blockId as string);
		const body = "x".repeat(900);
		for (let i = 0; i < 9; i++) {
			await humanWrite(
				w.space,
				w.alice,
				Array.from({ length: 100 }, (_, k) => ({
					op: "insert" as const,
					parent: { id: root as string },
					content: `${i}.${k} ${body}`,
				})),
			);
		}
		const sid = (await outlineStore.getBlock(root as string))?.sid as string;
		const def = await call(outlineReadTool, { address: sid }, w.c);
		expect(Buffer.byteLength(def.output, "utf8")).toBeLessThanOrEqual(16 * 1024 + 512);
		// Asking for more than one read takes is the most one read takes.
		const max = await call(outlineReadTool, { address: sid, budget: 5000 }, w.c);
		expect(max.metadata?.blocks as number).toBeLessThanOrEqual(800);
		expect(Buffer.byteLength(max.output, "utf8")).toBeLessThanOrEqual(256 * 1024 + 512);
		expect(max.output).toMatch(/^ {2}‹… (?:\d+\+? )?more›$/m);
		expect(max.truncated).toBe(true);
	});
});

describe("the behavior boundary, by ancestry", () => {
	async function sessionWorld() {
		const alice = await user("alice");
		const session = await narrator(alice, null);
		const space = await ensureSessionSpace(session);
		const ops: OutlineOp[] = [
			{
				op: "insert",
				tempId: "b",
				parent: null,
				content: "Behavior boundary",
				alias: OUTLINE_BEHAVIOR_ALIAS,
			},
			{ op: "insert", tempId: "r1", parent: { tempId: "b" }, content: "Never force-push." },
			{ op: "insert", tempId: "r2", parent: { tempId: "r1" }, content: "Not even to a fork." },
			{
				op: "insert",
				tempId: "r3",
				parent: { tempId: "r2" },
				content: "A rule that looks like a task",
				task: { status: "todo" },
			},
			{ op: "insert", tempId: "n", parent: null, content: "Notes" },
			{ op: "insert", tempId: "n1", parent: { tempId: "n" }, content: "a note" },
			{
				op: "insert",
				tempId: "n2",
				parent: { tempId: "n" },
				content: "A real task",
				task: { status: "todo" },
			},
		];
		const written = await humanWrite(space, alice, ops);
		// One result per operation, in order.
		const id = (tempId: string) =>
			written.results[ops.findIndex((op) => op.op === "insert" && op.tempId === tempId)]
				?.blockId as string;
		return { alice, session, space, id };
	}

	const agentWrite = (
		w: { session: string; space: OutlineSpaceRow; alice: string },
		ops: OutlineOp[],
		grant = false,
	) =>
		writeOutline(
			{
				spaceId: w.space.id,
				ops,
				actor: { kind: "agent", id: w.session },
				narratorId: w.session,
				responsibleUserId: w.alice,
			},
			{ agentBehaviorGrant: () => grant },
		);

	async function refused(run: Promise<unknown>): Promise<void> {
		const error = await run.then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(OutlineWriteError);
		expect((error as OutlineWriteError).message).toBe(OUTLINE_TEXT.errors.behaviorReadonly);
	}

	test("the well-known blocks are found at the top level, and membership is ancestry", async () => {
		const w = await sessionWorld();
		expect((await findBehaviorBlock(w.space.id))?.id).toBe(w.id("b"));
		expect(await findTasksBlock(w.space.id)).toBeNull();
		const { under, unknown } = await blocksUnder(w.space.id, w.id("b"), [
			w.id("b"),
			w.id("r3"),
			w.id("n1"),
		]);
		expect([...under].sort()).toEqual([w.id("b"), w.id("r3")].sort());
		expect(unknown.size).toBe(0);
		// An alias a person gave to a nested block names no boundary.
		const nested = await sessionWorld();
		await humanWrite(nested.space, nested.alice, [
			{ op: "update", block: { id: nested.id("b") }, alias: null },
			{ op: "update", block: { id: nested.id("n1") }, alias: OUTLINE_BEHAVIOR_ALIAS },
		]);
		expect(await findBehaviorBlock(nested.space.id)).toBeNull();
	});

	test("an agent writes nothing under it, at any depth, without the user turn's grant", async () => {
		const w = await sessionWorld();
		// Writing a rule three levels down, adding under it, deleting it.
		await refused(agentWrite(w, [{ op: "update", block: { id: w.id("r2") }, content: "x" }]));
		await refused(agentWrite(w, [{ op: "insert", parent: { id: w.id("r2") }, content: "new" }]));
		await refused(agentWrite(w, [{ op: "delete", block: { id: w.id("r3") } }]));
		await refused(
			agentWrite(w, [{ op: "setTask", block: { id: w.id("r3") }, task: { status: "done" } }]),
		);
		// Moving a block under it, or out from under it, however deep either end is.
		await refused(
			agentWrite(w, [{ op: "move", block: { id: w.id("n1") }, parent: { id: w.id("r2") } }]),
		);
		await refused(
			agentWrite(w, [{ op: "move", block: { id: w.id("r2") }, parent: { id: w.id("n") } }]),
		);
		// A new subtree whose root goes under it: its inner blocks count too.
		await refused(
			agentWrite(w, [
				{ op: "insert", tempId: "x", parent: { id: w.id("r1") }, content: "outer" },
				{ op: "insert", parent: { tempId: "x" }, content: "inner" },
			]),
		);
		// The boundary block itself: its text, its alias, its place.
		await refused(agentWrite(w, [{ op: "update", block: { id: w.id("b") }, alias: null }]));
		await refused(
			agentWrite(w, [{ op: "move", block: { id: w.id("b") }, parent: { id: w.id("n") } }]),
		);
		// With the grant every one of them is an ordinary write.
		const granted = await agentWrite(
			w,
			[{ op: "insert", parent: { id: w.id("r2") }, content: "Recorded under the grant." }],
			true,
		);
		expect(granted.commit).not.toBeNull();
	});

	test("a rule deleted with its parent is still under it: restoring it anywhere needs the grant", async () => {
		const w = await sessionWorld();
		// A person deletes r1; r2 and r3 go with it.
		await humanWrite(w.space, w.alice, [{ op: "delete", block: { id: w.id("r1") } }]);
		// The agent restores r2 out to Notes: it last lived under the boundary.
		await refused(
			agentWrite(w, [{ op: "restore", block: { id: w.id("r2") }, parent: { id: w.id("n") } }]),
		);
		// Restoring r1 back to its place is writing the boundary as well.
		await refused(agentWrite(w, [{ op: "restore", block: { id: w.id("r1") } }]));
		// With the grant both are ordinary writes.
		const restored = await agentWrite(
			w,
			[{ op: "restore", block: { id: w.id("r2") }, parent: { id: w.id("n") } }],
			true,
		);
		expect(restored.commit).not.toBeNull();
		// A block deleted from outside it is restored freely.
		await humanWrite(w.space, w.alice, [{ op: "delete", block: { id: w.id("n1") } }]);
		const free = await agentWrite(w, [{ op: "restore", block: { id: w.id("n1") } }]);
		expect(free.commit).not.toBeNull();
	});

	test("what is not under it is written freely, and asks for no grant", async () => {
		const w = await sessionWorld();
		let asked = 0;
		const write = (ops: OutlineOp[]) =>
			writeOutline(
				{
					spaceId: w.space.id,
					ops,
					actor: { kind: "agent", id: w.session },
					narratorId: w.session,
					responsibleUserId: w.alice,
				},
				{
					agentBehaviorGrant: () => {
						asked++;
						return false;
					},
				},
			);
		await write([{ op: "update", block: { id: w.id("n1") }, content: "a note, edited" }]);
		await write([{ op: "insert", parent: { id: w.id("n1") }, content: "deeper" }]);
		await write([{ op: "insert", parent: null, content: "Another top-level block" }]);
		await write([{ op: "move", block: { id: w.id("n1") }, parent: null }]);
		expect(asked).toBe(0);
		// A person moved the boundary under another block: it is no boundary there, and the
		// blocks under it are ordinary blocks again (as when it stopped being a page).
		await humanWrite(w.space, w.alice, [
			{ op: "move", block: { id: w.id("b") }, parent: { id: w.id("n") } },
		]);
		expect(await findBehaviorBlock(w.space.id)).toBeNull();
	});

	test("checkboxes under it are rules, not the session's tasks; the view shows them as rules", async () => {
		const w = await sessionWorld();
		const source = await taskSourceForNarrator(w.session);
		const open = await source.openTasks();
		expect(open.tasks.map((t) => t.text)).toEqual(["A real task"]);
		const parts = await source.contextParts("en");
		const behavior = parts.find((p) => p.key === "outline.behavior")?.text ?? "";
		expect(behavior).toContain("Never force-push.");
		expect(behavior).toContain("Not even to a fork.");
		expect(behavior).toContain("A rule that looks like a task");
		expect(behavior).not.toContain("A real task");
		expect(behavior).not.toMatch(/page/i);
		const tasks = parts.find((p) => p.key === "outline.tasks")?.text ?? "";
		expect(tasks).toContain("A real task");
		expect(tasks).not.toContain("A rule that looks like a task");
		expect(tasks).not.toMatch(/page/i);
	});

	test("through the tool: the refusal names the boundary by its address", async () => {
		const w = await sessionWorld();
		const c = ctx(w.session, w.alice);
		const rule = (await outlineStore.getBlock(w.id("r2")))?.sid as string;
		await call(outlineReadTool, { address: "session/behavior", view: "all" }, c);
		const result = await call(
			outlineEditTool,
			{ edits: [{ add: rule, markdown: "- a rule nobody asked for" }] },
			c,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("session/behavior");
		expect(result.output).not.toMatch(/page/i);
	});
});

describe("access: the session's space, the project's, someone else's", () => {
	test("what the session may not read answers like nothing at all, in every form", async () => {
		const w = await world();
		const bob = await user("bob");
		const hidden = await ensureProjectSpace(await project(bob, "Hidden"));
		const secret = (
			await humanWrite(hidden, bob, [
				{ op: "insert", tempId: "s", parent: null, content: "Secret quokka plan" },
				{ op: "insert", parent: { tempId: "s" }, content: "step one" },
			])
		).results.map((r) => r.blockId as string);
		const secretSid = (await outlineStore.getBlock(secret[0] as string))?.sid as string;
		const stepSid = (await outlineStore.getBlock(secret[1] as string))?.sid as string;
		const bobPersonal = await ensurePersonalSpace(bob);
		await humanWrite(bobPersonal, bob, [{ op: "insert", parent: null, content: "Bob's own" }]);
		const sessionSpace = await ensureSessionSpace(w.session);
		await humanWrite(sessionSpace, w.alice, [
			{ op: "insert", parent: null, content: "Session scratch" },
		]);
		const mine = await call(
			outlineEditTool,
			{ edits: [{ add: "/", markdown: "- Mine\n  - m1" }] },
			w.c,
		);
		const [top, m1] = ids(mine.output) as [string, string];

		// Its own spaces: by word and by key.
		expect((await call(outlineReadTool, { address: "session/" }, w.c)).output).toContain(
			"Session scratch",
		);
		expect((await call(outlineReadTool, { address: `${w.space.key}/` }, w.c)).output).toContain(
			"Mine",
		);
		// Another user's project and personal space: a real address and a made-up one get the
		// same answer, word for word but for the reference itself.
		const real = await call(outlineReadTool, { address: `${hidden.key}/${secretSid}` }, w.c);
		const fake = await call(outlineReadTool, { address: `${hidden.key}/Zz9Zz9Zz` }, w.c);
		expect(real.isError).toBe(true);
		expect(real.output.replace(secretSid, "X")).toBe(fake.output.replace("Zz9Zz9Zz", "X"));
		for (const address of [`${hidden.key}/`, `${bobPersonal.key}/`]) {
			const listed = await call(outlineReadTool, { address }, w.c);
			expect(listed.isError).toBe(true);
			expect(listed.output).not.toContain("quokka");
			expect(listed.output).not.toContain("Bob's own");
		}
		// `after` leaks nothing either: a block of a space it cannot read is "not a child".
		const leak = await call(
			outlineReadTool,
			{ address: top, after: `${hidden.key}/${stepSid}` },
			w.c,
		);
		const none = await call(
			outlineReadTool,
			{ address: top, after: `${hidden.key}/Zz9Zz9Zz` },
			w.c,
		);
		expect(leak.isError).toBe(true);
		expect(leak.output.replace(stepSid, "X")).toBe(none.output.replace("Zz9Zz9Zz", "X"));
		// The overview and a search of everything never name it.
		const overview = await call(outlineReadTool, { address: "*", view: "all" }, w.c);
		expect(overview.output).not.toContain("quokka");
		expect(overview.output).not.toContain(hidden.key);
		const search = await call(outlineSearchTool, { query: "quokka", spaces: ["*"] }, w.c);
		expect(search.output).not.toContain("Secret");
		// Writing there is refused like writing to nothing; moving a block there too.
		for (const edit of [
			{ add: `${hidden.key}/`, markdown: "- intruder" },
			{ add: `${hidden.key}/${secretSid}`, markdown: "- intruder" },
			{ move: m1, to: `${hidden.key}/` },
		]) {
			const result = await call(outlineEditTool, { edits: [edit] }, w.c);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("Nothing was written.");
		}
		const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, hidden.id));
		expect(rows).toHaveLength(2);
	});
});
