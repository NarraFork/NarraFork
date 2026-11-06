/**
 * What the outline tools store for the reader's card beside the model's result (outline display
 * PR-2), on the isolated SQLite database: `OutlineEdit`'s `metadata.display` (each change with
 * the titles of the blocks it touched, a checkbox before and after, the blocks created, what a
 * delete took with it, a held change and who decides it, the space by name), decisions naming
 * their space, `OutlineRead`'s title and path, `Ask`'s anchor and withdrawn questions by title,
 * and an answer delivery's `outlineAnswers` body. The model-facing text is unchanged: it is
 * written by the same code as before, and the display never reaches it.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own users,
 * projects and sessions. The answer delivery is replaced through its seam.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { narrators, projects, users } from "../../../db/schema";
import { askTool, outlineEditTool, outlineReadTool } from "../../../lib/agent/tools/outline";
import type { ToolContext, ToolResult } from "../../../lib/agent/types";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { stopEditTextWorker } from "../edit-text-runner";
import { lockOutlineTask } from "../pending";
import { answerOutlineQuestions, setOutlineAnswerDelivery } from "../questions";
import { clearOutlineReads } from "../read-ledger";
import { invalidateSessionReadScopes } from "../session-scope";
import { ensureProjectSpace } from "../spaces";
import { writeOutline } from "../write";

const NOW = "2026-11-04T00:00:00.000Z";

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

async function narrator(owner: string, projectId: string | null, title: string): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		ownerUserId: owner,
		visibility: "private",
		contextProjectId: projectId,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

function ctx(narratorId: string, userId: string): ToolContext {
	return {
		narratorId,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
}

async function edit(
	c: ToolContext,
	edits: Array<Record<string, unknown>>,
	message?: string,
): Promise<ToolResult> {
	return await outlineEditTool.execute({ edits, ...(message ? { message } : {}) }, c);
}

/** The ids a result lists after bullets, in order. */
function ids(output: string): string[] {
	return [...output.matchAll(/^\s*- \[([A-Za-z0-9/]+)\]/gm)].map((m) => m[1] as string);
}

type Delivered = { narratorId: string; content: string; body?: unknown };
let delivered: Delivered[] = [];

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateSessionReadScopes();
	clearOutlineReads();
	delivered = [];
	setOutlineAnswerDelivery({
		async deliver(narratorId, message) {
			delivered.push({ narratorId, content: message.content, body: message.body });
			return { written: true, woke: false };
		},
	});
});

afterEach(() => {
	setOutlineAnswerDelivery(null);
	invalidateSessionReadScopes();
	stopEditTextWorker();
});

describe("OutlineEdit's display", () => {
	test("names every change by title: the checkbox before and after, what was created and deleted", async () => {
		const alice = await user("alice");
		const projectId = await project(alice, "Atlas");
		const session = await narrator(alice, projectId, "worker");
		const c = ctx(session, alice);
		const space = await ensureProjectSpace(projectId);
		const k = space.key;
		const setup = await edit(c, [
			{
				add: "/",
				markdown: [
					"- Notes",
					"  - [/] Fix the retry button",
					"  - Old plan",
					"    - step one",
					"    - step two",
					"  - Root cause",
					"- Archive",
				].join("\n"),
			},
		]);
		const [notes, task, old, , , cause, archive] = ids(setup.output) as string[];
		await outlineReadTool.execute({ address: notes as string, view: "all" }, c);

		const result = await edit(c, [
			{ add: task, markdown: "- [ ] add a regression test\n  - covers the abort" },
			{ set: task, checkbox: "x" },
			{ set: task, assignee: "agent:review-1", alias: "Q?" },
			{ replace: cause, text: "Root cause: status stays aborted" },
			{ move: cause, to: archive },
			{ delete: old },
		]);
		expect(result.isError).toBeUndefined();
		const ref = (sid: string | undefined, title: string) => ({ address: `${k}/${sid}`, title });
		const display = result.metadata?.display as Record<string, unknown>;
		const created = ids(result.output).slice(0, 2);
		expect(display).toEqual({
			v: 1,
			// The project's name, for the card's space chip.
			space: { key: k, kind: "project", name: "Atlas" },
			ops: [
				{
					op: "add",
					parent: ref(task, "Fix the retry button"),
					created: [
						{ ...ref(created[0], "add a regression test"), depth: 0, status: "todo" },
						{ ...ref(created[1], "covers the abort"), depth: 1 },
					],
				},
				{
					op: "set",
					target: ref(task, "Fix the retry button"),
					status: { from: "doing", to: "done" },
				},
				{
					op: "set",
					target: ref(task, "Fix the retry button"),
					assignee: { to: "agent:review-1" },
					alias: { to: "Q1" },
				},
				// Named by its text as written now.
				{ op: "replace", target: ref(cause, "Root cause: status stays aborted") },
				{ op: "move", target: ref(cause, "Root cause"), to: ref(archive, "Archive") },
				{ op: "delete", target: ref(old, "Old plan"), under: 2 },
			],
			// The header's figures: one task done, two blocks added, the plan and its two steps.
			totals: { done: 1, added: 2, removed: 3 },
		});
		// The model's result never carries the display's words it did not already have.
		expect(result.output).not.toContain('"op"');
		expect(result.output).not.toContain('Atlas" ·');
	});

	test("this session's own notes are named as its own; a page add has no parent", async () => {
		const alice = await user("alice");
		const session = await narrator(alice, null, "solo");
		const result = await edit(ctx(session, alice), [{ add: "session/", markdown: "- Scratch" }]);
		const display = result.metadata?.display as {
			space: Record<string, unknown>;
			ops: Array<Record<string, unknown>>;
		};
		expect(display.space).toMatchObject({ kind: "session", own: true });
		expect(display.space).not.toHaveProperty("name");
		expect(display.ops[0]).toMatchObject({ op: "add", parent: null });
	});

	test("a held change is marked, and the display names the change and who decides it", async () => {
		const alice = await user("alice");
		const projectId = await project(alice, "Importer");
		const worker = await narrator(alice, projectId, "worker");
		const lead = await narrator(alice, projectId, "lead");
		const space = await ensureProjectSpace(projectId);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{
					op: "insert",
					tempId: "r",
					parent: null,
					content: "Ship the importer",
					task: { status: "todo" },
				},
				{
					op: "insert",
					parent: { tempId: "r" },
					content: "Parse the header",
					task: { status: "todo" },
				},
			],
			actor: { kind: "human", id: alice },
			responsibleUserId: alice,
		});
		const [root, step] = written.results.map((r) => r.sid) as [string, string];
		await lockOutlineTask({
			blockId: written.results[0]?.blockId as string,
			userId: alice,
			delegate: lead,
		});
		const c = ctx(worker, alice);
		await outlineReadTool.execute({ address: root, view: "all" }, c);
		const result = await edit(c, [
			{ replace: step, text: "[ ] Parse the header and the footer" },
			{ add: step, markdown: "- found: the header is v2" },
		]);
		const label = result.metadata?.pending as string;
		expect(label).toMatch(/^P[A-Za-z0-9]{8}$/);
		const display = result.metadata?.display as {
			ops: Array<Record<string, unknown>>;
			pending: Record<string, unknown>;
		};
		expect(display.ops[0]).toMatchObject({ op: "replace", held: true });
		expect(display.ops[1]).toMatchObject({ op: "add" });
		expect(display.ops[1]).not.toHaveProperty("held");
		expect(display.pending.label).toBe(label);
		expect(String(display.pending.decider)).toContain("alice");

		// The decision names its space, so the card links the commit it wrote.
		const decided = await edit(ctx(lead, alice), [{ confirm: label }]);
		expect((decided.metadata?.decided as Array<Record<string, unknown>>)[0]).toMatchObject({
			confirm: label,
			space: space.key,
		});
	});

	test("stays within its bound on a large call", async () => {
		const alice = await user("alice");
		const session = await narrator(alice, null, "bulk");
		const markdown = Array.from({ length: 150 }, (_, i) => `- ${"块".repeat(60)} ${i}`).join("\n");
		const result = await edit(ctx(session, alice), [{ add: "session/", markdown }]);
		const display = result.metadata?.display as { ops: Array<Record<string, unknown>> };
		expect(new TextEncoder().encode(JSON.stringify(display)).length).toBeLessThanOrEqual(8192);
		expect(display.ops[0]).toMatchObject({ op: "add", more: 150 - 12 });
	});
});

describe("OutlineRead and Ask name their blocks", () => {
	test("a read: the block's title, where it sits, the space by name", async () => {
		const alice = await user("alice");
		const projectId = await project(alice, "Atlas");
		const c = ctx(await narrator(alice, projectId, "worker"), alice);
		const setup = await edit(c, [{ add: "/", markdown: "- Notes\n  - Root cause" }]);
		const cause = ids(setup.output)[1] as string;
		const read = await outlineReadTool.execute({ address: cause }, c);
		expect(read.metadata).toMatchObject({
			title: "Root cause",
			path: ["Notes"],
			display: { v: 1, space: { kind: "project", name: "Atlas" } },
		});
	});

	test("Ask: the block it asked under by title; a withdraw names the question; the answer's body", async () => {
		const alice = await user("alice");
		const projectId = await project(alice, "Importer");
		const a = await narrator(alice, projectId, "worker");
		const space = await ensureProjectSpace(projectId);
		const written = await writeOutline({
			spaceId: space.id,
			ops: [
				{ op: "insert", tempId: "page", parent: null, content: "Importer" },
				{
					op: "insert",
					parent: { tempId: "page" },
					content: "Ship the importer",
					task: { status: "todo" },
				},
			],
			actor: { kind: "human", id: alice },
			responsibleUserId: alice,
		});
		const task = written.results[1] as { blockId: string; sid: string };
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "setTask", block: { id: task.blockId }, task: { status: "doing" } }],
			actor: { kind: "agent", id: a },
			narratorId: a,
			responsibleUserId: alice,
		});
		const c = ctx(a, alice);
		const asked = await askTool.execute(
			{
				questions: [
					{ question: "Format?", options: ["v1", "v2"], recommend: 2 },
					{ question: "Unknown columns?", recommend: "skip them" },
				],
			},
			c,
		);
		expect(asked.metadata?.display).toEqual({
			v: 1,
			space: { key: space.key, kind: "project", name: "Importer" },
			under: { address: `${space.key}/${task.sid}`, title: "Ship the importer" },
			questions: [],
		});
		const addresses = asked.metadata?.addresses as string[];
		const [q1, q2] = asked.metadata?.blockIds as [string, string];

		const withdrawn = await askTool.execute({ withdraw: [addresses[1] as string] }, c);
		expect(withdrawn.metadata?.display).toEqual({
			v: 1,
			questions: [{ address: addresses[1], title: "Unknown columns?", alias: "Q2" }],
		});

		await answerOutlineQuestions({ userId: alice, answers: [{ blockId: q1, option: 1 }] });
		void q2;
		expect(delivered).toHaveLength(1);
		const body = delivered[0]?.body as { kind: string; by?: string; items: unknown[] };
		expect(body.kind).toBe("outlineAnswers");
		expect(String(body.by)).toContain("alice");
		expect(body.items).toEqual([
			{
				address: addresses[0],
				alias: "Q1",
				question: "Format?",
				answer: { option: 1, optionText: "v1" },
			},
		]);
		// The model's message is the one it always was: the body is beside it, not in it.
		expect(delivered[0]?.content).toMatch(/answered your questions in the outline:\n- Q1 \[/);
		expect(delivered[0]?.content).toContain("→ option 1 (v1)");
		expect(delivered[0]?.content).not.toContain("outlineAnswers");
	});
});
