/**
 * The note rules through `OutlineEdit` (task tree readability PR D, decision D53), on the
 * isolated SQLite database: what a call writes under a task is checked where it sits; in mode
 * `warn` (the first version, and what the tool runs) everything is written and the result says
 * what is over; in mode `reject` a clearly over-limit write writes nothing, and the same content
 * restructured as the refusal says goes through. Ticking a task off without a result line
 * succeeds with a hint. People's writes, facts, a plan's tree, reports and questions are not held
 * to the rules. The edits of one call are judged in order, each where its blocks sit once the
 * edits before it have applied.
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
import { getOutlineTaskSystemReminder } from "../../../lib/prompts/outline-tasks";
import { settings } from "../../../lib/settings";
import "../../../lib/agent/tools";
import { type OutlineEditRequest, outlineEdit } from "../agent-edit";
import type { OutlineToolOutput } from "../agent-read";
import { OutlineAgentScope } from "../agent-scope";
import { reportBlockId } from "../delegation";
import { DELEGATION_TEXT } from "../delegation-text";
import { stopEditTextWorker } from "../edit-text-runner";
import { OUTLINE_TOOL_TEXT } from "../messages";
import { NoteAnchorReader } from "../note-rules";
import { lockOutlineTask } from "../pending";
import { ensurePlanRoot } from "../plans";
import { clearOutlineReads } from "../read-ledger";
import { OUTLINE_REPORT_ACTOR } from "../report-authors";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace, ensureSessionSpace } from "../spaces";
import { outlineStore } from "../store";
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

	test("an approved plan's tree is the plan's too: not checked", async () => {
		const w = await world();
		const { root } = await ensurePlanRoot({
			session: w.session,
			userId: w.alice,
			title: "Plan",
			locale: "en",
		});
		const row = await outlineStore.getBlock(root.blockId);
		const plan = row?.taskJson?.plan;
		expect(plan?.state).toBe("planning");
		await db
			.update(outlineBlocks)
			.set({ taskJson: { ...row?.taskJson, plan: { ...plan, state: "approved" } } as never })
			.where(eq(outlineBlocks.id, root.blockId));
		const space = await ensureSessionSpace(w.session);
		const out = await edit(
			{ ...w, space },
			[{ add: root.address, markdown: `- [ ] A step\n  - ${long}` }],
			"reject",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
	});

	test("blocks under a question put to a person are not the session's notes", async () => {
		const w = await world();
		const space = await ensureSessionSpace(w.session);
		const made = await edit(
			{ ...w, space },
			[{ add: "session/", markdown: "- Tasks\n  - [/] A task" }],
			"reject",
		);
		const t = ids(made.output)[1] as string;
		const parent = (await blocks(space)).find((b) => b.sid === t.split("/").pop());
		const question = generateId();
		await db.insert(outlineBlocks).values({
			...(parent as NonNullable<typeof parent>),
			id: question,
			sid: "Qq1aB2cD",
			parentId: parent?.id as string,
			content: "Which format first?",
			contentHash: "x",
			alias: null,
			taskJson: null,
			askJson: { v: 1 } as never,
			orderKey: "a0",
		});
		const reader = new NoteAnchorReader(outlineStore, space.id);
		expect((await reader.anchor(question)).skip).toBe(true);
		expect(await reader.anchor(parent?.id as string)).toEqual({ depth: 0, skip: false });
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

	test("blocks inside a subagent report: the report is not the session's notes", async () => {
		const w = await world();
		const t = await task(w);
		const parent = (await blocks(w.space)).find((b) => b.sid === t);
		const container = reportBlockId(generateId(), "run-1");
		await writeOutline({
			spaceId: w.space.id,
			ops: [
				{
					op: "insert",
					tempId: "report",
					id: container,
					parent: { id: parent?.id as string },
					content: "Report (generation 1 · 2026-11-09 17:38 UTC)",
				},
			],
			actor: { kind: "system", id: OUTLINE_REPORT_ACTOR },
			responsibleUserId: w.alice,
		});
		const report = (await blocks(w.space)).find((b) => b.id === container);
		const out = await edit(w, [{ add: report?.sid as string, markdown: `- ${long}` }], "reject");
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
		// The same block directly under the task is refused.
		const refused = await edit(w, [{ add: t, markdown: `- ${long}` }], "reject");
		expect(refused.isError).toBe(true);
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
	test("kept as written, with a hint in both modes; a fact's heading is not mentioned", async () => {
		for (const mode of ["warn", "reject"] as const) {
			const w = await world();
			const t = await task(w);
			const out = await edit(
				w,
				[
					{ add: t, markdown: "- ## Root cause\n  - The token is read twice" },
					{ add: "/", markdown: "- Facts\n  - ## A heading" },
				],
				mode,
			);
			expect(out.isError).toBeFalsy();
			const [heading] = ids(out.output);
			const stored = await blocks(w.space);
			expect(stored.find((b) => b.sid === heading)?.content).toBe("## Root cause");
			expect(stored.some((b) => b.content === "## A heading")).toBe(true);
			expect(out.output).toContain(TEXT.warnHeader);
			expect(out.output).toContain(TEXT.heading(`[${heading}]`));
			expect(out.output.match(/is a heading under a task/g)).toHaveLength(1);
			expect(noteRules(out)).toEqual({ mode, refused: false, issues: 1, clear: 0 });
		}
	});

	test("a heading standing first under a finished task is not its result", async () => {
		const w = await world();
		const t = await task(w);
		const added = await edit(
			w,
			[{ add: t, markdown: "- ## Result\n- Fixed: the second refresh waits" }],
			"warn",
		);
		const [heading] = ids(added.output);
		const out = await edit(w, [{ set: t, checkbox: "x" }], "warn");
		expect(out.isError).toBeFalsy();
		expect(out.output).toContain(TEXT.noResult(t, false, heading as string, heading as string));
	});
});

describe("one call, in order", () => {
	const long = "word ".repeat(150).trim();

	test("a block an earlier edit of the call made a task: what is added under it is checked", async () => {
		const w = await world();
		const page = ids(
			(await edit(w, [{ add: "/", markdown: "- Plain parent" }], "reject")).output,
		)[0];
		const stored = (await blocks(w.space)).length;
		const refused = await edit(
			w,
			[
				{ set: page as string, checkbox: " " },
				{ add: page as string, markdown: `- ${long}` },
			],
			"reject",
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(TEXT.refusedHeader);
		expect((await blocks(w.space)).length).toBe(stored);
		// The other way round, the note is written before the block is a task: not checked.
		const ok = await edit(
			w,
			[
				{ add: page as string, markdown: `- ${long}` },
				{ set: page as string, checkbox: " " },
			],
			"reject",
		);
		expect(ok.isError).toBeFalsy();
		expect(ok.output).not.toContain(TEXT.warnHeader);
	});

	test("a task an earlier edit of the call made a plain block: what is added under it is a fact", async () => {
		const w = await world();
		const t = await task(w);
		const out = await edit(
			w,
			[
				{ set: t, checkbox: "none" },
				{ add: t, markdown: `- ${long}` },
			],
			"reject",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
		expect(noteRules(out)).toBeUndefined();
	});

	test("a rewrite that gives a block its checkbox counts for the edits after it", async () => {
		const w = await world();
		const page = ids(
			(await edit(w, [{ add: "/", markdown: "- Plain parent" }], "reject")).output,
		)[0];
		const refused = await edit(
			w,
			[
				{ replace: page as string, text: "[ ] Now a task" },
				{ add: page as string, markdown: `- ${long}` },
			],
			"reject",
		);
		expect(refused.isError).toBe(true);
	});

	test("moves: a block moved under a task is not rewritten, so not checked; what is added to it afterwards is", async () => {
		const w = await world();
		const t = await task(w);
		const added = await edit(
			w,
			[{ add: "/", markdown: `- Facts\n  - ${long}\n  - A short fact` }],
			"reject",
		);
		const [, longFact, shortFact] = ids(added.output);
		// Moving what was written before is not a write of its text.
		const moved = await edit(w, [{ move: longFact as string, to: t }], "reject");
		expect(moved.isError).toBeFalsy();
		expect(moved.output).not.toContain(TEXT.warnHeader);
		// Moved under the task by this call, then written under: one level below the task's notes.
		const refused = await edit(
			w,
			[
				{ move: shortFact as string, to: t },
				{ replace: shortFact as string, text: long },
			],
			"reject",
		);
		expect(refused.isError).toBe(true);
		expect(refused.output).toContain(TEXT.longNote(`[${shortFact}]`, long.length, noteChars));
		// Moved out from under the task by this call, then rewritten: a fact.
		const out = await edit(
			w,
			[
				{ move: longFact as string, to: "/" },
				{ replace: longFact as string, text: `${long} again` },
			],
			"reject",
		);
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
	});
});

describe("naming and counting", () => {
	test("a bare URL counts as a link's label, not in full", async () => {
		const w = await world();
		const t = await task(w);
		const url = `https://example.com/${"a".repeat(130)}`;
		const out = await edit(w, [{ add: t, markdown: `- see ${url}` }], "reject");
		expect(out.isError).toBeFalsy();
		expect(out.output).not.toContain(TEXT.warnHeader);
	});

	test("a block of an edit held for confirmation is named by its edit, not by an id it does not have yet", async () => {
		const w = await world();
		const made = await edit(w, [{ add: "/", markdown: "- [ ] Ship it\n  - [ ] Step one" }], "warn");
		const t = ids(made.output)[0] as string;
		const root = (await blocks(w.space)).find((b) => b.sid === t);
		await lockOutlineTask({ blockId: root?.id as string, userId: w.alice });
		const title = "t".repeat(titleChars + 1);
		const out = await edit(w, [{ add: t, markdown: `- Phase 2\n  - [ ] ${title}` }], "warn");
		expect(out.isError).toBeFalsy();
		expect(out.output).toContain("Held for confirmation as P");
		expect(out.output).toContain(
			TEXT.longTitle(TEXT.unwritten(1, `${"t".repeat(39)}…`), titleChars + 1, 1, titleChars),
		);
		// The step does not exist yet.
		expect((await blocks(w.space)).some((b) => b.content === title)).toBe(false);
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
		expect(out.output).toContain(TEXT.noResult(t, false, sub as string, null));
		expect((out.metadata as { finishHints?: number }).finishHints).toBe(1);
		// The same in mode `reject`: ticking off is never refused for want of a result.
		const other = await task(w, "Another task");
		const rejected = await edit(w, [{ set: other, checkbox: "-" }], "reject");
		expect(rejected.isError).toBeFalsy();
		expect(rejected.output).toContain(TEXT.noResult(other, true, null, null));
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
		expect(out.output).toContain(TEXT.noResult(t, false, null, null));
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

describe("the rules as the prompts state them", () => {
	const numbers = [noteChars, detailChars, maxChildren].map(String);

	test("the session's system section: both languages, the check's numbers, the same text every time", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const text = getOutlineTaskSystemReminder(locale);
			for (const n of numbers) expect(text).toContain(n);
			expect(getOutlineTaskSystemReminder(locale)).toBe(text);
		}
		const en = getOutlineTaskSystemReminder("en");
		expect(en).toContain("conclusion first");
		expect(en).toContain("its first block must say the result in one line");
		const zh = getOutlineTaskSystemReminder("zh-CN");
		expect(zh).toContain("结论 → 依据 → 细节");
		expect(zh).toContain("任务下第一块要是一行结果");
		// The title's limit, in both.
		expect(en).toContain(`A task's title is one line (at most ${titleChars} characters)`);
		expect(zh).toContain(`任务标题只写一行（不超过 ${titleChars} 字）`);
		// Still three conventions.
		expect(en).toContain("Three conventions");
		expect(zh).toContain("三条约定");
		expect(en.match(/^\d\. /gm)).toHaveLength(3);
		expect(zh.match(/^\d\. /gm)).toHaveLength(3);
	});

	test("OutlineEdit's description states them with the same numbers", () => {
		const text = outlineEditTool.description as string;
		expect(text).toContain("Notes under a task go conclusion first");
		expect(text).toContain(`a task's title is one line (at most ${titleChars} characters)`);
		// Headings are kept as written (and named in the result), not dropped.
		expect(text).not.toContain("dropped) and no record");
		for (const n of numbers) expect(text).toContain(n);
	});

	test("a delegated subagent is told to report conclusion first", () => {
		expect(DELEGATION_TEXT.brief.closing).toContain("conclusion first");
		expect(DELEGATION_TEXT.brief.closing).toContain("at most three sentences");
		expect(DELEGATION_TEXT.note.current("t", "r", "3 blocks")).toContain(
			"its conclusion in one line as the first block under the task",
		);
	});
});
