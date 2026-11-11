/**
 * The opening brief's rendering (outline P2 PR 10c-1, design v2 §F; `task-session.ts`): pure
 * tests of the budget, the order and the fallbacks, and the pin that keeps the delegation brief
 * (`renderDelegationBrief` without options) byte for byte what it was before the renderer learned
 * the opening brief's sections.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OUTLINE_DELEGATION_LIMITS, renderDelegationBrief } from "../delegation";
import { outlineTaskStartBlocker } from "../task-json";
import { OUTLINE_TASK_BRIEF_LIMITS, renderTaskBrief, type TaskBriefInput } from "../task-session";
import { delegationFixtures } from "./task-brief-fixtures";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function input(over: Partial<TaskBriefInput> = {}): TaskBriefInput {
	return {
		title: "Fix the refresh logic",
		body: "Two tabs refresh at once.",
		goals: ["Tasks", "Make sign-in reliable"],
		children: [{ text: "It fails on the second refresh", box: null, children: [] }],
		prerequisites: [{ title: "Agree on the lock", status: "done" }],
		address: "Kx81mPqa/Ab3dEf9Q",
		epoch: 3,
		background: [
			{
				title: "Make sign-in reliable",
				context: "Users are logged out at random.",
				siblings: [
					{ title: "Reproduce it", status: "done", self: false },
					{ title: "Fix the refresh logic", status: "doing", self: true },
				],
			},
			{ title: "Q4 reliability", context: null },
		],
		facts: [
			{ address: "Kx81mPqa/Fact0001", title: "Auth design", text: "- Auth design\n  - One lock" },
			{ unreadable: true },
		],
		pages: [
			{ address: "Kx81mPqa/Page0001", title: "Auth design", linked: true, lines: ["One lock"] },
			{ address: "Kx81mPqa/Page0002", title: "Glossary", linked: false, lines: [] },
		],
		morePages: 0,
		...over,
	};
}

describe("the delegation brief is unchanged", () => {
	// Rendered by the renderer as it was on main before this change (compared output to output).
	const pinned: Record<string, [string, number]> = {
		bare: ["b0d25788fc149a2bbb928cd3fb069cc5e5099a99f1f10093274b57a8d8a964b7", 209],
		nested: ["9bc7ae45f19d3d9b4d09d7f9357058dc3bea968ed55ce1e55d022dcf46fbe34a", 576],
		"over the budget": ["5d761f8834f265770b26a3e873ea25758cac92ee60560f636b7cfa1774342918", 15916],
		"a small budget": ["3b3b8fbd1d7fcb9356238f33500a26401fcad6f79d3607734c2b80196a507bae", 1867],
	};
	for (const [name, fixture, budget] of delegationFixtures()) {
		test(`${name}: the same bytes`, () => {
			const brief = renderDelegationBrief(fixture, budget);
			expect([createHash("sha256").update(brief).digest("hex"), bytes(brief)]).toEqual(
				pinned[name] as [string, number],
			);
			expect(brief).toContain("When you are done, reply with a report");
			expect(bytes(brief)).toBeLessThanOrEqual(budget ?? OUTLINE_DELEGATION_LIMITS.briefBytes);
		});
	}
});

describe("the opening brief", () => {
	test("every part, in order: what to do, the material, the rules last", () => {
		const brief = renderTaskBrief(input({ prompt: "Keep the public API." }));
		expect(brief).toBe(
			[
				"# Task: Fix the refresh logic",
				"Part of: Tasks › Make sign-in reliable",
				"Address: `Kx81mPqa/Ab3dEf9Q` · claimed for this session (claim generation 3)",
				"This is the opening brief of a session opened to do this task. The system put it together from the outline as it was when the session was opened; it is not what a person said, and it is not updated afterwards.",
				"",
				"## What to do",
				"Two tabs refresh at once.",
				"",
				"## Notes and steps so far",
				"- It fails on the second refresh",
				"",
				"## Prerequisites",
				"- Agree on the lock (done)",
				"",
				"## Background (the tasks above this one)",
				"- Make sign-in reliable",
				"  Users are logged out at random.",
				"  - Its tasks, with this one among them:",
				"    - Reproduce it (done)",
				"    - Fix the refresh logic (in progress) ← this task",
				"- Q4 reliability",
				"",
				"## Facts the task links to",
				"### `Kx81mPqa/Fact0001`",
				"- Auth design\n  - One lock",
				"- (a block this session cannot read)",
				"",
				"## Pages of the project's outline",
				"A map, not the content: each page with the first lines of what it holds. Read a page with OutlineRead before relying on it.",
				"- Auth design (`Kx81mPqa/Page0001`) · linked from the task",
				"  - One lock",
				"- Glossary (`Kx81mPqa/Page0002`)",
				"",
				"## Further instructions",
				"Keep the public API.",
				"",
				"---",
				"## How to work on this task",
			].join("\n") +
				"\n" +
				brief.slice(brief.indexOf("- The task is yours")),
		);
		// The three endings (§B.4).
		expect(brief).toContain("tick the task `[x]` and leave one result line under it");
		expect(brief).toContain("put the question with Ask and leave the task in progress");
		expect(brief).toContain("write a handoff note under the task");
		expect(brief).toContain("Do not set the task back to `[ ]` yourself");
		// True before and after a session's unfinished task is released at once (10c-2).
		expect(brief).not.toContain("goes back to do");
		expect(brief.endsWith("whoever continues the task picks it up from your note.")).toBe(true);
	});

	test("the same input renders the same bytes, and nothing in it tells the time", () => {
		const first = renderTaskBrief(input());
		expect(renderTaskBrief(input())).toBe(first);
		expect(first).not.toMatch(/\b20\d\d-\d\d-\d\d|\bago\b|lease until/);
	});

	test("an empty task: only the head and the rules", () => {
		const brief = renderTaskBrief(
			input({ body: null, children: [], prerequisites: [], background: [], facts: [], pages: [] }),
		);
		expect(brief).not.toContain("## What to do");
		expect(brief).not.toContain("## Background");
		expect(brief).not.toContain("## Facts");
		expect(brief).not.toContain("## Pages");
		expect(brief).toContain("## How to work on this task");
	});

	test("everything oversized: within the budget, each section present, the person's note whole", () => {
		const note = "n".repeat(3000);
		const brief = renderTaskBrief(
			input({
				body: "正文".repeat(9000),
				children: Array.from({ length: 500 }, (_, i) => ({
					text: `Note ${i} ${"x".repeat(80)}`,
					box: null,
					children: [],
				})),
				background: Array.from({ length: 3 }, (_, i) => ({
					title: `Above ${i} ${"t".repeat(200)}`,
					context: "c".repeat(2000),
					...(i === 0
						? {
								siblings: Array.from({ length: 10 }, (_, j) => ({
									title: `Sibling ${j} ${"s".repeat(100)}`,
									status: "todo" as const,
									self: j === 3,
								})),
							}
						: {}),
				})),
				facts: Array.from({ length: 8 }, (_, i) => ({
					address: `Kx81mPqa/Fact000${i}`,
					title: `Fact ${i}`,
					text: `- Fact ${i}\n${"  - detail line of the fact\n".repeat(200)}`,
				})),
				pages: Array.from({ length: 20 }, (_, i) => ({
					address: `Kx81mPqa/Page00${i}`,
					title: `Page ${i}`,
					linked: i < 2,
					lines: Array.from({ length: 5 }, (_, j) => `line ${j} ${"p".repeat(300)}`),
				})),
				morePages: 7,
				prompt: note,
			}),
		);
		const withoutNote = brief.replace(`\n\n## Further instructions\n${note}`, "");
		expect(withoutNote).not.toBe(brief);
		expect(bytes(withoutNote)).toBeLessThanOrEqual(OUTLINE_TASK_BRIEF_LIMITS.bytes);
		// Not far under it either: the budget is used.
		expect(bytes(withoutNote)).toBeGreaterThan(OUTLINE_TASK_BRIEF_LIMITS.bytes - 1500);
		// The task's own text takes its share at most.
		const body = brief.slice(brief.indexOf("## What to do"), brief.indexOf("## Notes and steps"));
		expect(bytes(body)).toBeLessThanOrEqual(OUTLINE_TASK_BRIEF_LIMITS.bodyBytes + 32);
		expect(body).toContain("…");
		for (const heading of [
			"## Notes and steps so far",
			"## Background (the tasks above this one)",
			"## Facts the task links to",
			"## Pages of the project's outline",
			"## How to work on this task",
		])
			expect(brief).toContain(heading);
		// A fact is cut to its own limit; one that does not fit whole is named with its address.
		const facts = brief.slice(brief.indexOf("## Facts"), brief.indexOf("## Pages"));
		expect(facts).toContain("### `Kx81mPqa/Fact0000`");
		expect(facts).toMatch(/- Fact \d \(`Kx81mPqa\/Fact000\d`\): not shown here/);
		// Every fact is at least named.
		expect(facts.match(/^(### `|- Fact \d \()/gm)).toHaveLength(8);
		// Pages that did not fit whole keep their title line; those never read are counted.
		const pages = brief.slice(
			brief.indexOf("## Pages"),
			brief.indexOf("\n\n## Further instructions"),
		);
		expect(pages).toContain("- Page 0 (`Kx81mPqa/Page000`) · linked from the task");
		expect(pages).toMatch(/\n- … \d+ more$/);
		expect(Number(/- … (\d+) more$/.exec(pages)?.[1])).toBeGreaterThanOrEqual(7);
	});

	test("what earlier sections leave unused, later ones use", () => {
		const facts = Array.from({ length: 8 }, (_, i) => ({
			address: `Kx81mPqa/Fact000${i}`,
			title: `Fact ${i}`,
			text: `- Fact ${i}\n${"  - d\n".repeat(95)}`.slice(0, 590),
		}));
		// With a full body and notes the facts keep to their share; with an empty task they all fit.
		const crowded = renderTaskBrief(
			input({
				body: "b".repeat(9000),
				children: Array.from({ length: 300 }, (_, i) => ({
					text: `Note ${i} ${"x".repeat(80)}`,
					box: null,
					children: [],
				})),
				facts,
			}),
		);
		const roomy = renderTaskBrief(input({ body: null, children: [], facts }));
		const shown = (brief: string) => brief.split("\n").filter((l) => l.startsWith("### `")).length;
		expect(shown(crowded)).toBeLessThan(8);
		expect(shown(crowded)).toBeGreaterThanOrEqual(4);
		expect(shown(roomy)).toBe(8);
		expect(bytes(crowded)).toBeLessThanOrEqual(OUTLINE_TASK_BRIEF_LIMITS.bytes);
	});

	test("an unreadable target shows neither title nor address", () => {
		const brief = renderTaskBrief(input({ facts: [{ unreadable: true }] }));
		expect(brief).toContain("## Facts the task links to\n- (a block this session cannot read)\n");
	});
});

describe("the handoff section of the opening brief (PR 10c-2)", () => {
	const handoff = {
		times: 3,
		head: 'Handoff (generation 3 · session `nrt` "Refresh work" · 2026-11-11 08:12 UTC): not finished; back to do',
		lines: ["The session's notes: Refresh takes two paths", "Steps: 2 of 5 done"],
		notes: [
			{
				address: "Kx81mPqa/Note0001",
				text: "Refresh takes two paths\nThe second is not changed yet",
			},
		],
		earlier: ["Handoff (generation 2 · …): not finished; back to do", "Handoff (generation 1 · …)"],
	};

	test("without a handoff the brief is what it was; with one, the section sits between the task's text and its notes", () => {
		const plain = renderTaskBrief(input());
		expect(renderTaskBrief(input({ handoff: null }))).toBe(plain);
		expect(plain).not.toContain("## Handoff");
		const brief = renderTaskBrief(input({ handoff }));
		const at = (text: string) => brief.indexOf(text);
		expect(at("## What to do")).toBeLessThan(at("## Handoff from the previous session"));
		expect(at("## Handoff from the previous session")).toBeLessThan(
			at("## Notes and steps so far"),
		);
		expect(brief).toContain(
			[
				"## Handoff from the previous session",
				"This task was given back unfinished 3 times. The newest handoff follows; continue from it rather than starting over.",
				`- ${handoff.head}`,
				"  - The session's notes: Refresh takes two paths",
				"  - Steps: 2 of 5 done",
				"The notes it points to, in full:",
				"- `Kx81mPqa/Note0001`",
				"  Refresh takes two paths",
				"  The second is not changed yet",
				"Earlier handoffs (their first lines):",
				"- Handoff (generation 2 · …): not finished; back to do",
				"- Handoff (generation 1 · …)",
			].join("\n"),
		);
		// Everything after it is what the brief without a handoff has.
		expect(brief.slice(at("## Notes and steps so far"))).toBe(
			plain.slice(plain.indexOf("## Notes and steps so far")),
		);
	});

	test("oversized: the newest handoff is whole, notes and earlier ones give way, the brief stays within its budget", () => {
		const big = {
			times: 40,
			head: handoff.head,
			lines: ["Steps: 2 of 5 done"],
			notes: Array.from({ length: 3 }, (_, i) => ({
				address: `Kx81mPqa/Note000${i}`,
				text: `Note ${i} ${"n".repeat(3000)}`,
			})),
			earlier: Array.from({ length: 20 }, (_, i) => `Earlier ${i} ${"e".repeat(300)}`),
		};
		const brief = renderTaskBrief(
			input({
				handoff: big,
				children: Array.from({ length: 500 }, (_, i) => ({
					text: `Note ${i} ${"x".repeat(80)}`,
					box: null,
					children: [],
				})),
			}),
		);
		expect(bytes(brief)).toBeLessThanOrEqual(OUTLINE_TASK_BRIEF_LIMITS.bytes);
		expect(brief).toContain(`- ${handoff.head}`);
		expect(brief).toContain("  - Steps: 2 of 5 done");
		const section = brief.slice(
			brief.indexOf("## Handoff from the previous session"),
			brief.indexOf("## Notes and steps so far"),
		);
		expect(bytes(section)).toBeLessThanOrEqual(OUTLINE_TASK_BRIEF_LIMITS.handoffBytes + 2);
		// The notes under the task and the rules are still there.
		expect(brief).toContain("- Note 0 ");
		expect(brief).toContain("## How to work on this task");
	});
});

describe("outlineTaskStartBlocker", () => {
	const wait = (over: object = {}) => ({
		prerequisites: [],
		people: false,
		confirmation: false,
		...over,
	});
	test("the conditions, in the order they are told", () => {
		const todo = { status: "todo" as const, assignee: null };
		expect(outlineTaskStartBlocker({ task: todo, planning: false, wait: wait() })).toBeNull();
		expect(outlineTaskStartBlocker({ task: todo, planning: false })).toBeNull();
		expect(
			outlineTaskStartBlocker({ task: { ...todo, status: "doing" }, planning: false }),
		).toBeNull();
		const all = {
			planning: true,
			wait: wait({ prerequisites: ["a"], people: true, confirmation: true }),
		};
		const assigned = { status: "todo" as const, assignee: "human:pat" };
		expect(outlineTaskStartBlocker({ task: { ...assigned, status: "done" }, ...all })).toBe(
			"finished",
		);
		expect(outlineTaskStartBlocker({ task: { ...assigned, status: "cancelled" }, ...all })).toBe(
			"finished",
		);
		expect(outlineTaskStartBlocker({ task: assigned, ...all })).toBe("planning");
		expect(outlineTaskStartBlocker({ task: assigned, ...all, planning: false })).toBe(
			"prerequisites",
		);
		expect(
			outlineTaskStartBlocker({
				task: assigned,
				planning: false,
				wait: wait({ people: true, confirmation: true }),
			}),
		).toBe("people");
		expect(
			outlineTaskStartBlocker({
				task: assigned,
				planning: false,
				wait: wait({ confirmation: true }),
			}),
		).toBe("confirmation");
		expect(outlineTaskStartBlocker({ task: assigned, planning: false, wait: wait() })).toBe(
			"assigned_to_person",
		);
		expect(
			outlineTaskStartBlocker({ task: { status: "todo", assignee: "agent:w" }, planning: false }),
		).toBeNull();
	});
});
