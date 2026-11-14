/**
 * The import's plan (outline P2 PR 12b, `plan.ts`): the mapping rules as pure functions.
 */
import { describe, expect, test } from "bun:test";
import { convertNotes } from "../../report-text";
import {
	fileTagOfSid,
	isImportSid,
	planSpecFile,
	planSpecTasks,
	type SpecImportBlock,
	specFileCodeLang,
	specFileTag,
} from "../plan";

const base = {
	narratorId: "narrator-1",
	revisionId: "rev-1",
	normalized: [] as never[],
	locale: "en" as const,
	blockedNoteSid: (id: string) => `pb-${id}`,
};

describe("planSpecTasks", () => {
	test("the status table: live and archived sessions (D52, D54)", () => {
		const tasks = (["todo", "doing", "done", "blocked"] as const).map((status) => ({
			text: status,
			status,
			protected: false,
		}));
		const args = { ...base, tasks, protectors: tasks.map(() => null), ownerUserId: "u" };
		const live = planSpecTasks({ ...args, archived: false });
		// In progress is written to do and started by the move (nothing claimed before it).
		expect(live.expected.map((t) => [t.status, t.start, t.noteSids.length])).toEqual([
			["todo", false, 0],
			["todo", true, 0],
			["done", false, 0],
			["todo", true, 1],
		]);
		expect(live.tasks.map((t) => [t.task?.status, t.start === true])).toEqual([
			["todo", false],
			["todo", true],
			["done", false],
			["todo", true],
		]);
		const archived = planSpecTasks({ ...args, archived: true });
		expect(archived.expected.map((t) => [t.status, t.start, t.noteSids.length])).toEqual([
			["todo", false, 0],
			["todo", false, 1],
			["done", false, 0],
			["todo", false, 1],
		]);
		// The blocked note is the mark plugins read: its short id follows from the task's id.
		expect(live.notes[0]?.sid).toBe(`pb-${live.tasks[3]?.id}`);
		expect(live.notes[0]?.parentSid).toBe(live.tasks[3]?.sid as string);
	});

	test("protected is created by a person; a person's protection, or one nobody knows the author of, locks for the owner", () => {
		const tasks = [0, 1, 2, 3].map((n) => ({
			text: `t${n}`,
			status: "todo" as const,
			protected: n > 0,
		}));
		const plan = planSpecTasks({
			...base,
			tasks,
			protectors: [null, "user", "assistant", "unknown"],
			ownerUserId: "owner",
			archived: false,
		});
		expect(plan.expected.map((t) => [t.humanCreated, t.locked])).toEqual([
			[false, false],
			[true, true],
			[true, false],
			// Unknown protector: locked, as a person's (owner decision).
			[true, true],
		]);
		expect(plan.tasks[3]?.task?.lock).toEqual({
			by: { kind: "human", id: "owner" },
			delegate: null,
		});
		expect(plan.tasks[1]?.task?.lock).toEqual({
			by: { kind: "human", id: "owner" },
			delegate: null,
		});
		expect(plan.tasks[1]?.task?.manager).toEqual({ kind: "human", id: "owner" });
		expect(plan.tasks[2]?.task?.lock).toBeUndefined();
		expect(plan.tasks[2]?.task?.manager).toEqual({ kind: "agent", id: "narrator-1" });
		const nobody = planSpecTasks({
			...base,
			tasks,
			protectors: [null, "user", "assistant", "unknown"],
			ownerUserId: null,
			archived: false,
		});
		expect(nobody.expected.map((t) => t.locked)).toEqual([false, false, false, false]);
	});

	test("short ids follow from the session and the revision, and are recognizably the import's", () => {
		const tasks = [{ text: "a", status: "todo" as const, protected: false }];
		const args = { ...base, tasks, protectors: [null], ownerUserId: null, archived: false };
		const one = planSpecTasks(args);
		const same = planSpecTasks(args);
		const other = planSpecTasks({ ...args, revisionId: "rev-2" });
		expect(same.tasks[0]?.sid).toBe(one.tasks[0]?.sid as string);
		expect(same.tasks[0]?.id).toBe(one.tasks[0]?.id as string);
		expect(other.tasks[0]?.sid).not.toBe(one.tasks[0]?.sid);
		expect(one.tasks[0]?.sid.startsWith(one.sidPrefix)).toBe(true);
		expect(isImportSid(one.tasks[0]?.sid as string)).toBe(true);
		expect(isImportSid("Ab3dEf9Q")).toBe(false);
		expect(isImportSid("stabcdefgh")).toBe(false);
	});
});

describe("planSpecFile", () => {
	const block = (content: string, children: SpecImportBlock[] = []): SpecImportBlock => ({
		content,
		links: [],
		children,
	});

	test("one page, parents before children", () => {
		const plan = planSpecFile({
			narratorId: "n",
			path: "design.md",
			revisionId: "r",
			blocks: [block("# H", [block("p1"), block("p2")]), block("tail")],
			locale: "en",
		});
		expect(plan.pageSids).toHaveLength(1);
		expect(plan.nodes.map((n) => n.content)).toEqual(["design.md", "# H", "p1", "p2", "tail"]);
		const [page, h, p1] = plan.nodes;
		expect(page?.parentSid).toBeNull();
		expect(h?.parentSid).toBe(page?.sid as string);
		expect(p1?.parentSid).toBe(h?.sid as string);
		const tag = specFileTag("n", "design.md", "r");
		expect(plan.nodes.every((n) => fileTagOfSid(n.sid) === tag && isImportSid(n.sid))).toBe(true);
	});

	test("a file of more blocks than a page holds becomes several pages, nothing lost", () => {
		const plan = planSpecFile({
			narratorId: "n",
			path: "big.md",
			revisionId: "r",
			blocks: [block("# H", [block("a"), block("b"), block("c")]), block("d")],
			locale: "zh-CN",
			pageBlocks: 2,
			pageSid: "fixedpage0001",
		});
		expect(plan.pageSids).toHaveLength(3);
		expect(plan.pageSids[0]).toBe("fixedpage0001");
		const pagesOf = plan.nodes.filter((n) => n.parentSid === null).map((n) => n.content);
		expect(pagesOf).toEqual(["big.md（1/3）", "big.md（2/3）", "big.md（3/3）"]);
		expect(plan.nodes.filter((n) => n.parentSid !== null).map((n) => n.content)).toEqual([
			"# H",
			"a",
			"b",
			"c",
			"d",
		]);
		// `b` and `c` are on the second part: their heading stayed on the first, so they hang
		// from the part's page.
		const b = plan.nodes.find((n) => n.content === "b");
		expect(b?.parentSid).toBe(plan.pageSids[1] as string);
	});

	test("what is not markdown is code in its extension's language", () => {
		expect(specFileCodeLang("notes.md")).toBeNull();
		expect(specFileCodeLang("a/b/data.JSON")).toBe("json");
		expect(specFileCodeLang("Makefile")).toBe("text");
	});
});

describe("a file's text as blocks (the reviewer's cases)", () => {
	const flat = (blocks: readonly SpecImportBlock[]): string[] =>
		blocks.flatMap((b) => [b.content, ...flat(b.children)]);
	const letters = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "");
	const cases: Record<string, string> = {
		frontmatter: "---\ntitle: X\ntags: [a, b]\n---\n\n# Head\n\nbody text\n",
		html: "<div>hello <b>world</b></div>\n\n<!-- a comment kept -->\n\n<script>alert(1)</script>\n",
		cjk: "# 标题\n\n这是一段中文，包含「引号」和全角标点。\n\n- 第一项\n  - 子项甲\n- 第二项\n",
		fence:
			"before\n\n```ts\nconst a = `x`;\n// ``` inside\n```\n\nafter\n\n~~~\ntilde fence\n~~~\n",
		unclosedFence: "intro\n\n```js\nnever closed\n\n# not a heading\nlast line\n",
		table: "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n",
		checkbox:
			"- [ ] todo item\n- [x] done item\n\nTODO plain\n\n[[wikilink]] and #tag and ((ref))\n",
		refdefs:
			'See [the doc][d] and [other].\n\n[d]: https://example.com/doc\n[other]: https://example.com/o "T"\n',
		footnote: "Text with note[^1].\n\n[^1]: The footnote body.\n",
		longline: `${"x".repeat(40000)}\n`,
		longcjk: `${"汉".repeat(30000)}\n`,
	};
	for (const [name, text] of Object.entries(cases)) {
		test(`${name}: every letter and number is kept`, () => {
			const out = convertNotes({ text, continued: "(cont.)" });
			expect(letters(flat(out.blocks).join("\n").replaceAll("(cont.)", ""))).toBe(letters(text));
		});
	}

	test("a file split over several pages keeps every block, in order", () => {
		const text = Array.from({ length: 4000 }, (_, i) => `para ${i}`).join("\n\n");
		const plan = planSpecFile({
			narratorId: "n",
			path: "big.md",
			revisionId: "r",
			blocks: convertNotes({ text, continued: "(cont.)" }).blocks,
			locale: "en",
		});
		const body = plan.nodes.filter((n) => n.sid.startsWith("sb")).map((n) => n.content);
		expect(body).toEqual(Array.from({ length: 4000 }, (_, i) => `para ${i}`));
		expect(plan.pageSids).toHaveLength(3);
		expect(new Set(plan.nodes.map((n) => n.sid)).size).toBe(plan.nodes.length);
	});
});
