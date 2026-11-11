/**
 * The note rules through `OutlineEdit` (task tree readability PR D, decision D53), on the
 * isolated SQLite database: what a call writes under a task is checked where it sits; in mode
 * `warn` (the first version, and what the tool runs) everything is written and the result says
 * what is over; in mode `reject` a clearly over-limit write writes nothing, and the same content
 * restructured as the refusal says goes through. Ticking a task off without a result line
 * succeeds with a hint. People's writes, facts, plans being planned are not held to the rules.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OUTLINE_NOTE_RULES, type OutlineNoteRulesMode } from "@shared/outline-note-structure";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators, outlineBlocks, outlineCommits, projects, users } from "../../../db/schema";
import { outlineEditTool } from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { type OutlineEditRequest, outlineEdit } from "../agent-edit";
import type { OutlineToolOutput } from "../agent-read";
import { OutlineAgentScope } from "../agent-scope";
import { stopEditTextWorker } from "../edit-text-runner";
import { OUTLINE_TOOL_TEXT } from "../messages";
import { ensurePlanRoot } from "../plans";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import type { OutlineSpaceRow } from "../store/port";
import { writeOutline } from "../write";

const NOW = "2026-11-11T00:00:00.000Z";
const TEXT = OUTLINE_TOOL_TEXT.edit.noteRules;
const { noteChars, detailChars, clearNoteChars, maxChildren, titleChars } = OUTLINE_NOTE_RULES;

interface World {
	alice: string;
	session: string;
	space: OutlineSpaceRow;
}

async function world(): Promise<World> {
	const alice = generateId();
	await db.insert(users).values({
		id: alice,
		username: `note-${alice}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Atlas",
		ownerUserId: alice,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	const session = generateId();
	await db.insert(narrators).values({
		id: session,
		title: "note rules",
		ownerUserId: alice,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return { alice, session, space: await ensureProjectSpace(projectId) };
}

/** `OutlineEdit` as the tool runs it (the configured mode). */
async function tool(w: World, edits: OutlineEditRequest[]): Promise<ToolResult> {
	return await outlineEditTool.execute({ edits }, {
		narratorId: w.session,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId: w.alice,
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext);
}

/** `OutlineEdit` in a given mode. */
async function edit(
	w: World,
	edits: OutlineEditRequest[],
	mode: OutlineNoteRulesMode,
): Promise<OutlineToolOutput> {
	const scope = await OutlineAgentScope.open({
		narratorId: w.session,
		userId: w.alice,
		sessionSpaceOnly: false,
	});
	return await outlineEdit(
		scope,
		{ edits },
		{ messageId: null, toolCallId: null },
		{ noteRules: mode },
	);
}

/** The ids a result lists after bullets, in order. */
function ids(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

async function blocks(space: OutlineSpaceRow) {
	const rows = await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id));
	return rows.filter((row) => !row.deleted);
}

async function commits(space: OutlineSpaceRow): Promise<number> {
	return (await db.select().from(outlineCommits).where(eq(outlineCommits.spaceId, space.id)))
		.length;
}

/** A page with one task in progress; the task's sid. */
async function task(w: World, title = "Fix the refresh race"): Promise<string> {
	const added = await edit(w, [{ add: "/", markdown: `- Tasks\n  - [/] ${title}` }], "reject");
	expect(added.isError).toBeFalsy();
	return ids(added.output)[1] as string;
}

const noteRules = (out: { metadata?: unknown }) =>
	(out.metadata as { noteRules?: Record<string, unknown> }).noteRules;

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
});

afterEach(() => {
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("a note clearly over the limit", () => {
	const long = "字".repeat(clearNoteChars + 1);

	test("warn (what the tool runs): written, and the result says what is over and how to restructure", async () => {
		const w = await world();
		const t = await task(w);
		const out = await tool(w, [{ add: t, markdown: `- ${long}` }]);
		expect(out.isError).toBeFalsy();
		const [sid] = ids(out.output);
		expect((await blocks(w.space)).some((b) => b.sid === sid && b.content === long)).toBe(true);
		expect(out.output).toContain(TEXT.warnHeader);
		expect(out.output).toContain(TEXT.longNote(`[${sid}]`, clearNoteChars + 1, noteChars));
		expect(noteRules(out)).toEqual({
			mode: "warn",
			refused: false,
			issues: 1,
			clear: 1,
			headings: 0,
		});
		// The same call through the service in mode `warn` reads the same.
		const again = await edit(w, [{ add: t, markdown: `- ${long}` }], "warn");
		expect(again.isError).toBeFalsy();
		expect(again.output).toContain(TEXT.warnHeader);
	});

	test("reject: nothing is written, the refusal names the block; restructured as it says, it is written", async () => {
		const w = await world();
		const t = await task(w);
		const before = await commits(w.space);
		const stored = (await blocks(w.space)).length;
		const refused = await edit(
			w,
			[
				{ add: t, markdown: "- A fine note" },
				{ add: t, markdown: `- ${long}` },
			],
			"reject",
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(TEXT.refusedHeader);
		expect(refused.output).toContain(
			TEXT.longNote(TEXT.unwritten(2, `${"字".repeat(39)}…`), clearNoteChars + 1, noteChars),
		);
		expect(refused.output).toContain(TEXT.refusedRecover);
		expect(noteRules(refused)).toMatchObject({ mode: "reject", refused: true, clear: 1 });
		// All or nothing: the fine edit of the call is not written either.
		expect(await commits(w.space)).toBe(before);
		expect((await blocks(w.space)).length).toBe(stored);

		// As the refusal says: the conclusion as the block's text, the rest in blocks under it.
		const fixed = await edit(
			w,
			[
				{ add: t, markdown: "- A fine note" },
				{
					add: t,
					markdown: `- 结论：竞态来自两个标签页同时刷新\n  - ${"据".repeat(detailChars)}\n  - ${"据".repeat(detailChars)}`,
				},
			],
			"reject",
		);
		expect(fixed.isError).toBeFalsy();
		expect(fixed.output).not.toContain(TEXT.warnHeader);
		expect(noteRules(fixed)).toBeUndefined();
		expect((await blocks(w.space)).length).toBe(stored + 4);
	});

	test("a rewrite of a note is held to the same limit, named by its id in both modes", async () => {
		const w = await world();
		const t = await task(w);
		const added = await edit(w, [{ add: t, markdown: "- Short" }], "reject");
		const [sid] = ids(added.output);
		const refused = await edit(w, [{ replace: sid as string, text: long }], "reject");
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(TEXT.longNote(`[${sid}]`, clearNoteChars + 1, noteChars));
		const warned = await edit(w, [{ replace: sid as string, text: long }], "warn");
		expect(warned.isError).toBeFalsy();
		expect(warned.output).toContain(TEXT.longNote(`[${sid}]`, clearNoteChars + 1, noteChars));
	});
});

describe("too many blocks under a task in one call", () => {
	const markdown = Array.from({ length: maxChildren + 1 }, (_, i) => `- note ${i}`).join("\n");

	test("warn writes them and says so; reject writes nothing", async () => {
		const w = await world();
		const t = await task(w);
		const stored = (await blocks(w.space)).length;
		const refused = await edit(w, [{ add: t, markdown }], "reject");
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(TEXT.flat(`[${t}]`, maxChildren + 1, maxChildren, true));
		expect((await blocks(w.space)).length).toBe(stored);
		const warned = await edit(w, [{ add: t, markdown }], "warn");
		expect(warned.isError).toBeFalsy();
		expect(warned.output).toContain(TEXT.flat(`[${t}]`, maxChildren + 1, maxChildren, true));
		expect((await blocks(w.space)).length).toBe(stored + maxChildren + 1);
	});
});

describe("over a limit, not clearly", () => {
	test("written in both modes, with a hint: a long note, a long detail, a long title", async () => {
		for (const mode of ["warn", "reject"] as const) {
			const w = await world();
			const t = await task(w);
			const out = await edit(
				w,
				[
					{
						add: t,
						markdown: `- ${"字".repeat(noteChars + 1)}\n  - ${"据".repeat(detailChars + 1)}\n- [ ] ${"t".repeat(titleChars + 1)}`,
					},
				],
				mode,
			);
			expect(out.isError).toBeFalsy();
			const [note, detail, sub] = ids(out.output);
			expect(out.output).toContain(TEXT.warnHeader);
			expect(out.output).toContain(TEXT.longNote(`[${note}]`, noteChars + 1, noteChars));
			expect(out.output).toContain(TEXT.longDetail(`[${detail}]`, detailChars + 1, detailChars));
			expect(out.output).toContain(TEXT.longTitle(`[${sub}]`, titleChars + 1, 1, titleChars));
			expect(noteRules(out)).toMatchObject({ mode, refused: false, issues: 3, clear: 0 });
		}
	});

	test("within the limits: the result says nothing about notes", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(
			w,
			[{ add: t, markdown: `- ${"字".repeat(noteChars)}\n  - ${"据".repeat(detailChars)}` }],
			"reject",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
		expect(noteRules(out)).toBeUndefined();
	});
});

describe("who is not held to the rules", () => {
	const long = "字".repeat(clearNoteChars + 1);

	test("facts: blocks with no task above them, however long or many", async () => {
		const w = await world();
		const many = Array.from({ length: maxChildren + 5 }, (_, i) => `  - fact ${i}`).join("\n");
		const out = await edit(w, [{ add: "/", markdown: `- Facts\n  - ${long}\n${many}` }], "reject");
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
		expect(noteRules(out)).toBeUndefined();
	});

	test("a plan still being planned: ExitPlanMode holds it to the plan format instead", async () => {
		const w = await world();
		const { root } = await ensurePlanRoot({
			session: w.session,
			userId: w.alice,
			title: "Plan",
			locale: "en",
		});
		const space = await ensureSessionSpace(w.session);
		const out = await edit(
			{ ...w, space },
			[{ add: root.address, markdown: `- ${"字".repeat(clearNoteChars + 1)}` }],
			"reject",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
	});

	test("a person's write under a task is never checked", async () => {
		const w = await world();
		const t = await task(w);
		const parent = (await blocks(w.space)).find((b) => b.sid === t);
		const written = await writeOutline({
			spaceId: w.space.id,
			ops: [{ op: "insert", tempId: "a", parent: { id: parent?.id as string }, content: long }],
			actor: { kind: "human", id: w.alice },
			responsibleUserId: w.alice,
		});
		expect(written.commit).not.toBeNull();
	});
});

describe("headings under a task", () => {
	test("the mark is dropped and the result says so; a fact keeps its heading", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(
			w,
			[
				{ add: t, markdown: "- ## Root cause\n  - The token is read twice" },
				{ add: "/", markdown: "- Facts\n  - ## A heading" },
			],
			"warn",
		);
		expect(out.isError).toBeFalsy();
		const [heading] = ids(out.output);
		const stored = await blocks(w.space);
		expect(stored.find((b) => b.sid === heading)?.content).toBe("Root cause");
		expect(stored.some((b) => b.content === "## A heading")).toBe(true);
		expect(out.output).toContain(TEXT.headingsDropped([heading as string]));
		expect(noteRules(out)).toMatchObject({ headings: 1, issues: 0 });
	});
});

describe("ticking a task off", () => {
	test("without a result: it is done, and the result asks for the one line (before its first block)", async () => {
		const w = await world();
		const t = await task(w);
		const sub = ids((await edit(w, [{ add: t, markdown: "- [ ] A subtask" }], "reject")).output)[0];
		const out = await tool(w, [{ set: t, checkbox: "x" }]);
		expect(out.isError).toBeFalsy();
		expect((await blocks(w.space)).find((b) => b.sid === t)?.taskJson?.status).toBe("done");
		expect(out.output).toContain(TEXT.noResult(t, false, sub as string));
		expect((out.metadata as { finishHints?: number }).finishHints).toBe(1);
		// The same in mode `reject`: ticking off is never refused for want of a result.
		const other = await task(w, "Another task");
		const rejected = await edit(w, [{ set: other, checkbox: "-" }], "reject");
		expect(rejected.isError).toBeFalsy();
		expect(rejected.output).toContain(TEXT.noResult(other, true, null));
	});

	test("with a result line, or one added by the same call: no hint", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(
			w,
			[
				{ add: t, markdown: "- Fixed: the second refresh now waits for the first" },
				{ set: t, checkbox: "done" },
			],
			"warn",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain("with no result under it");
		expect(out.output).not.toContain(OUTLINE_TOOL_TEXT.edit.hintsHeader);
	});

	test("a rewrite that ticks the box is a tick too; a task already done gets no hint again", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(w, [{ replace: t, text: "[x] Fix the refresh race" }], "warn");
		expect(out.isError).toBeFalsy();
		expect(out.output).toContain(TEXT.noResult(t, false, null));
		const again = await edit(w, [{ set: t, checkbox: "x" }], "warn");
		expect(again.output).not.toContain("with no result under it");
	});

	test("starting a task, or reopening one, asks for nothing", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(w, [{ set: t, checkbox: " " }], "warn");
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(OUTLINE_TOOL_TEXT.edit.hintsHeader);
	});

	test("long notes and a pile of them under the finished task are named to tidy", async () => {
		const w = await world();
		const t = await task(w);
		const long = await edit(w, [{ add: t, markdown: `- ${"字".repeat(noteChars + 5)}` }], "warn");
		const [sid] = ids(long.output);
		for (let i = 0; i < 2; i++) {
			const markdown = Array.from({ length: 8 }, (_, k) => `- step ${i}-${k}`).join("\n");
			await edit(w, [{ add: t, markdown }], "warn");
		}
		const out = await edit(w, [{ set: t, checkbox: "x" }], "warn");
		expect(out.isError).toBeFalsy();
		expect(out.output).toContain(
			TEXT.tidyLong(t, [TEXT.tidyBlock(sid as string, noteChars + 5)], 0, noteChars),
		);
		expect(out.output).toContain(TEXT.tidyFlat(t, 17, false, maxChildren));
		expect(out.output).not.toContain("with no result under it");
	});
});
