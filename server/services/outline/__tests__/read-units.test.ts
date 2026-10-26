/**
 * Pure parts of reading: tree building, budgeted breadth-first rendering, the facts view, the
 * annotations a read adds, and search snippets. No database.
 */
import { describe, expect, test } from "bun:test";
import { parseMarkdownOutline, serializeMarkdownOutline } from "@shared/outline";
import { OUTLINE_TEXT } from "../messages";
import type { OutlineTaskJson } from "../model";
import {
	clampBudget,
	isReadAnnotation,
	OUTLINE_READ_LIMITS,
	outlineItem,
	renderOutline,
	stripReadAnnotations,
} from "../render";
import { searchSnippet } from "../search";
import type { OutlineStructureRow } from "../store/read-port";
import {
	breadthFirst,
	buildTree,
	effectiveView,
	isProcessBlock,
	type OutlineNode,
	viewChildren,
} from "../tree";

interface Spec {
	content: string;
	task?: OutlineTaskJson["status"];
	alias?: string;
	tags?: string[];
	children?: Spec[];
}

/** A tree from a nested spec; ids are `b0`, `b1`, … in pre-order, order keys `a0`, `a1`, …. */
function tree(spec: Spec, loaded = true): { root: OutlineNode; nodes: Map<string, OutlineNode> } {
	const rows: OutlineStructureRow[] = [];
	const bodies = new Map<string, Spec>();
	let n = 0;
	const walk = (s: Spec, parentId: string | null, index: number) => {
		const id = `b${n++}`;
		rows.push({
			id,
			sid: `s${id}`,
			parentId,
			orderKey: `a${index}`,
			alias: s.alias ?? null,
			taskJson: s.task ? { status: s.task, assignee: null } : null,
			versionSeq: 1,
		});
		bodies.set(id, s);
		for (const [i, child] of (s.children ?? []).entries()) walk(child, id, i);
	};
	walk(spec, null, 0);
	// Shuffled input: the tree orders siblings itself.
	const nodes = buildTree([...rows].reverse());
	if (loaded) {
		for (const node of nodes.values()) {
			const s = bodies.get(node.id) as Spec;
			node.content = s.content;
			node.tags = s.tags ?? [];
		}
	}
	return { root: nodes.get("b0") as OutlineNode, nodes };
}

const leaf = (content: string, extra: Partial<Spec> = {}): Spec => ({ content, ...extra });

describe("tree", () => {
	test("siblings follow order keys whatever the row order; orphans stay unlinked", () => {
		const nodes = buildTree([
			{
				id: "c",
				sid: "c",
				parentId: "p",
				orderKey: "a2",
				alias: null,
				taskJson: null,
				versionSeq: 1,
			},
			{
				id: "p",
				sid: "p",
				parentId: null,
				orderKey: "a0",
				alias: null,
				taskJson: null,
				versionSeq: 1,
			},
			{
				id: "a",
				sid: "a",
				parentId: "p",
				orderKey: "a1",
				alias: null,
				taskJson: null,
				versionSeq: 1,
			},
			{
				id: "o",
				sid: "o",
				parentId: "gone",
				orderKey: "a0",
				alias: null,
				taskJson: null,
				versionSeq: 1,
			},
			// Same key: the id breaks the tie.
			{
				id: "b",
				sid: "b",
				parentId: "p",
				orderKey: "a1",
				alias: null,
				taskJson: null,
				versionSeq: 1,
			},
		]);
		expect(nodes.get("p")?.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
		expect(nodes.get("o")?.parent).toBeNull();
	});

	test("facts view: tasks and their subtrees are process; a task root is read whole", () => {
		const { root, nodes } = tree({
			content: "page",
			children: [
				leaf("fact"),
				{ content: "task", task: "todo", children: [leaf("note under task")] },
			],
		});
		expect(viewChildren(root, "facts").map((n) => n.content)).toEqual(["fact"]);
		expect(viewChildren(root, "all")).toHaveLength(2);
		const task = nodes.get("b2") as OutlineNode;
		const note = nodes.get("b3") as OutlineNode;
		expect(effectiveView(root, "facts")).toBe("facts");
		expect(effectiveView(task, "facts")).toBe("all");
		expect(effectiveView(note, "facts")).toBe("all");
		expect(breadthFirst(root, "facts", 10).map((n) => n.id)).toEqual(["b0", "b1"]);
		expect(breadthFirst(root, "all", 3).map((n) => n.id)).toEqual(["b0", "b1", "b2"]);
	});

	test("session content is process when read from another space", () => {
		const base = { underTask: false, spaceKind: "session", spaceId: "s1" };
		expect(isProcessBlock({ ...base, contextSpaceId: "s1" })).toBe(false);
		expect(isProcessBlock({ ...base, contextSpaceId: "p1" })).toBe(true);
		expect(isProcessBlock({ ...base, contextSpaceId: null })).toBe(true);
		expect(isProcessBlock({ ...base, spaceKind: "project" })).toBe(false);
		expect(isProcessBlock({ ...base, spaceKind: "project", underTask: true })).toBe(true);
	});
});

describe("budgeted breadth-first rendering", () => {
	const spec: Spec = {
		content: "Root",
		children: [
			{ content: "A", children: [leaf("A1"), leaf("A2")] },
			{ content: "B", children: [leaf("B1")] },
			leaf("C"),
		],
	};

	test("everything fits: a plain outline, no annotations", () => {
		const { root } = tree(spec);
		const r = renderOutline(root, { budget: { blocks: 100 } });
		expect(r.markdown).toBe("- Root\n  - A\n    - A1\n    - A2\n  - B\n    - B1\n  - C");
		expect(r.hiddenByBudget).toBe(0);
		expect(r.blockIds).toHaveLength(7);
		expect(r.bytes).toBe(Buffer.byteLength(r.markdown));
	});

	test("a whole level before the next; what does not fit is counted under its shown ancestor", () => {
		const { root } = tree(spec);
		const r = renderOutline(root, { budget: { blocks: 4 } });
		expect(r.markdown).toBe(
			[
				"- Root",
				"  - A",
				`    ${OUTLINE_TEXT.more(2)}`,
				"  - B",
				`    ${OUTLINE_TEXT.more(1)}`,
				"  - C",
			].join("\n"),
		);
		expect(r.hiddenByBudget).toBe(3);
		expect(r.blockIds).toEqual(["b0", "b1", "b4", "b6"]);
	});

	test("a level cut short: the rest of it, and everything deeper, collapses", () => {
		const { root } = tree(spec);
		const r = renderOutline(root, { budget: { blocks: 3 } });
		expect(r.markdown).toBe(
			[
				"- Root",
				"  - A",
				`    ${OUTLINE_TEXT.more(2)}`,
				"  - B",
				`    ${OUTLINE_TEXT.more(1)}`,
				`  ${OUTLINE_TEXT.more(1)}`,
			].join("\n"),
		);
		expect(r.hiddenByBudget).toBe(4);
		// The count under the root covers whole subtrees.
		const deep = tree({
			content: "Root",
			children: [leaf("A"), { content: "B", children: [leaf("B1"), leaf("B2")] }],
		});
		expect(renderOutline(deep.root, { budget: { blocks: 2 } }).markdown).toBe(
			["- Root", "  - A", `  ${OUTLINE_TEXT.more(3)}`].join("\n"),
		);
	});

	test("the root is shown even when it alone is over budget", () => {
		const { root } = tree(spec);
		const r = renderOutline(root, { budget: { blocks: 1 } });
		expect(r.markdown).toBe(["- Root", `  ${OUTLINE_TEXT.more(6)}`].join("\n"));
		const tiny = renderOutline(root, { budget: { bytes: 1 } });
		expect(tiny.blockIds).toEqual(["b0"]);
	});

	test("the byte budget counts UTF-8 bytes (CJK) and holds for every budget", () => {
		const { root } = tree({
			content: "设计文档",
			children: Array.from({ length: 6 }, (_, i) => ({
				content: `第${i}节：刷新令牌只存在服务端`,
				children: [leaf(`细节${i}`)],
			})),
		});
		const full = renderOutline(root, { view: "all", budget: { blocks: 100, bytes: 100_000 } });
		expect(full.hiddenByBudget).toBe(0);
		let previous = -1;
		for (let bytes = 1; bytes <= full.bytes + 10; bytes++) {
			const r = renderOutline(root, { budget: { blocks: 100, bytes } });
			// Only the root may exceed the budget on its own.
			if (r.blockIds.length > 1) expect(r.bytes).toBeLessThanOrEqual(bytes);
			expect(r.blockIds.length).toBeGreaterThanOrEqual(previous);
			previous = r.blockIds.length;
			// Shown and hidden blocks always add up.
			expect(r.blockIds.length + r.hiddenByBudget).toBe(13);
		}
		// One byte short of the full outline drops at least one block.
		const short = renderOutline(root, { budget: { blocks: 100, bytes: full.bytes - 1 } });
		expect(short.hiddenByBudget).toBeGreaterThan(0);
		expect(short.bytes).toBeLessThanOrEqual(full.bytes - 1);
	});

	test("blocks whose content is not loaded end the expansion", () => {
		const { root, nodes } = tree(spec);
		(nodes.get("b4") as OutlineNode).content = null;
		const r = renderOutline(root, { budget: { blocks: 100 } });
		expect(r.blockIds).toEqual(["b0", "b1"]);
	});

	test("labels are a hook and count toward the budget", () => {
		const { root } = tree(spec);
		const label = (node: OutlineNode) => `[${node.sid}]`;
		const r = renderOutline(root, { label, budget: { blocks: 2 } });
		expect(r.markdown.split("\n")[0]).toBe("- [sb0] Root");
		expect(r.markdown.split("\n")[1]).toBe("  - [sb1] A");
		const plain = renderOutline(root, { budget: { blocks: 100 } });
		const labelled = renderOutline(root, { label, budget: { blocks: 100, bytes: plain.bytes } });
		expect(labelled.hiddenByBudget).toBeGreaterThan(0);
	});

	test("deterministic: the same tree renders the same text", () => {
		const a = tree(spec);
		const b = tree(spec);
		for (const budget of [1, 2, 3, 5, 100]) {
			expect(renderOutline(a.root, { budget: { blocks: budget } }).markdown).toBe(
				renderOutline(b.root, { budget: { blocks: budget } }).markdown,
			);
		}
	});

	test("budgets are defaulted and clamped to the read limits", () => {
		expect(clampBudget()).toEqual(OUTLINE_READ_LIMITS.defaultBudget);
		expect(clampBudget({ blocks: 10_000, bytes: 10_000_000 })).toEqual({
			blocks: OUTLINE_READ_LIMITS.maxBlocks,
			bytes: OUTLINE_READ_LIMITS.maxBytes,
		});
		expect(clampBudget({ blocks: 0, bytes: -5 })).toEqual({ blocks: 1, bytes: 1 });
		expect(clampBudget({ blocks: Number.NaN })).toEqual(OUTLINE_READ_LIMITS.defaultBudget);
	});
});

describe("facts view", () => {
	const spec: Spec = {
		content: "auth module",
		children: [
			leaf("token refresh has a race"),
			{
				content: "fix the refresh logic",
				task: "doing",
				children: [leaf("plan: reject older versions"), leaf("found: two callers")],
			},
			{
				content: "refresh tokens live on the server",
				children: [{ content: "add a regression test", task: "todo" }],
			},
		],
	};

	test("tasks and what is under them are left out, with one line saying how many", () => {
		const { root } = tree(spec);
		const r = renderOutline(root, { budget: { blocks: 100 } });
		expect(r.view).toBe("facts");
		expect(r.hiddenByView).toBe(4);
		expect(r.markdown).toBe(
			[
				"- auth module",
				"  - token refresh has a race",
				"  - refresh tokens live on the server",
				OUTLINE_TEXT.factsOnly(4),
			].join("\n"),
		);
	});

	test("view all shows everything; reading a task shows all of it", () => {
		const { root, nodes } = tree(spec);
		const all = renderOutline(root, { view: "all", budget: { blocks: 100 } });
		expect(all.hiddenByView).toBe(0);
		expect(all.markdown).toContain("- [/] fix the refresh logic");
		expect(all.markdown).toContain("    - [ ] add a regression test");
		const task = renderOutline(nodes.get("b2") as OutlineNode, { budget: { blocks: 100 } });
		expect(task.view).toBe("all");
		expect(task.markdown).toBe(
			[
				"- [/] fix the refresh logic",
				"  - plan: reject older versions",
				"  - found: two callers",
			].join("\n"),
		);
	});

	test("the facts note is charged to the budget too", () => {
		const { root } = tree(spec);
		const full = renderOutline(root, { budget: { blocks: 100 } });
		const cut = renderOutline(root, { budget: { blocks: 100, bytes: full.bytes - 1 } });
		expect(cut.bytes).toBeLessThanOrEqual(full.bytes - 1);
		expect(cut.markdown.endsWith(OUTLINE_TEXT.factsOnly(4))).toBe(true);
	});
});

describe("annotations", () => {
	const spec: Spec = {
		content: "Plan",
		alias: "P7",
		tags: ["Design", "k1/abcd1234"],
		children: [
			{ content: "Intro\nsecond line", children: [leaf("deep")] },
			{ content: "```\n‹… 3 more›\n```", children: [leaf("hidden")] },
			{ content: "do it", task: "todo" },
			leaf("‹not an annotation› inline"),
		],
	};

	test("never parse back as content: stripped, the read is exactly the shown blocks", () => {
		const { root } = tree(spec);
		for (const blocks of [1, 2, 3, 4, 100]) {
			for (const view of ["facts", "all"] as const) {
				const r = renderOutline(root, { view, budget: { blocks } });
				const stripped = stripReadAnnotations(r.markdown);
				// Code fences keep a line that looks like an annotation.
				if (r.blockIds.includes("b3")) expect(stripped).toContain("‹… 3 more›");
				const shown = new Set(r.blockIds);
				const toItems = (node: OutlineNode): ReturnType<typeof outlineItem> => ({
					...outlineItem(node),
					children: viewChildren(node, r.view)
						.filter((c) => shown.has(c.id))
						.map(toItems),
				});
				const items = [toItems(root)];
				expect(stripped).toBe(serializeMarkdownOutline(items));
				const parsed = parseMarkdownOutline(stripped);
				expect(parsed.notes).toEqual([]);
				expect(JSON.stringify(parsed.items)).toBe(JSON.stringify(items));
			}
		}
	});

	test("annotation lines are recognized exactly", () => {
		expect(isReadAnnotation(OUTLINE_TEXT.more(12))).toBe(true);
		expect(isReadAnnotation(`    ${OUTLINE_TEXT.more(1)}`)).toBe(true);
		expect(isReadAnnotation(OUTLINE_TEXT.factsOnly(3))).toBe(true);
		expect(isReadAnnotation(OUTLINE_TEXT.pageTruncated(10))).toBe(true);
		expect(isReadAnnotation("- ‹… 3 more›")).toBe(false);
		expect(isReadAnnotation("  ‹facts only›")).toBe(false);
		expect(isReadAnnotation("‹a› b")).toBe(false);
	});
});

describe("search snippets", () => {
	test("short content whole, long content cut around the first term on one line", () => {
		expect(searchSnippet("one\ntwo  three", ["two"])).toBe("one two three");
		const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
		const s = searchSnippet(long, ["needle"], 60);
		expect(s.startsWith("…")).toBe(true);
		expect(s.endsWith("…")).toBe(true);
		expect(s).toContain("needle");
		expect(Array.from(s).length).toBe(62);
		expect(searchSnippet(long, ["absent"], 60).startsWith("aaa")).toBe(true);
	});

	test("counts characters, never splits a surrogate pair, matches case-insensitively", () => {
		const text = `${"😀".repeat(100)} 设计 NEEDLE ${"字".repeat(100)}`;
		const s = searchSnippet(text, ["needle"], 30);
		expect(s).toContain("NEEDLE");
		expect(s).not.toContain("�");
		for (const ch of s) expect(ch.length === 1 || ch === "😀").toBe(true);
		expect(searchSnippet(text, ["设计"], 30)).toContain("设计");
	});
});
