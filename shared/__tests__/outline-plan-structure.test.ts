/**
 * The layout an outline plan is held to before it is submitted (plan readability): the root a
 * one-line title, every block one short point, no flat level of many blocks. Each rule at its
 * boundary, characters counted as a reader counts them (CJK 1 each, markup not at all), code and
 * tables not prose, notes for the agent and questions to a person left out, document order and
 * the listed cap.
 */
import { describe, expect, test } from "bun:test";
import {
	OUTLINE_PLAN_STRUCTURE,
	type PlanStructureNode,
	planBlockText,
	planStructureIssues,
	planTextChars,
} from "../outline-plan-structure";

const { rootChars, blockChars, maxChildren, listed } = OUTLINE_PLAN_STRUCTURE;

let next = 0;
function node(content: string, children: PlanStructureNode[] = [], ask?: unknown) {
	next++;
	return { sid: `S${String(next).padStart(7, "0")}`, content, children, ...(ask ? { ask } : {}) };
}

const ok = (children: PlanStructureNode[] = []) => node("Ship the importer", children);

describe("the limits", () => {
	test("are the numbers the prompts state", () => {
		expect(OUTLINE_PLAN_STRUCTURE).toEqual({
			rootChars: 80,
			blockChars: 300,
			maxChildren: 15,
			listed: 8,
		});
	});
});

describe("the root is a short one-line title", () => {
	test("exactly the limit passes, one more is refused (Latin)", () => {
		expect(planStructureIssues(node("a".repeat(rootChars))).total).toBe(0);
		const root = node("a".repeat(rootChars + 1));
		expect(planStructureIssues(root).issues).toEqual([
			{ kind: "root", sid: root.sid, chars: rootChars + 1, lines: 1 },
		]);
	});

	test("a CJK character counts 1, like a letter", () => {
		expect(planStructureIssues(node("历".repeat(rootChars))).total).toBe(0);
		const root = node("历".repeat(rootChars + 1));
		expect(planStructureIssues(root).issues[0]).toMatchObject({ kind: "root", chars: 81 });
		// An astral character (an emoji, a rare CJK ideograph) is one character, not two units.
		expect(planStructureIssues(node("𠀋".repeat(rootChars))).total).toBe(0);
	});

	test("markup and a link's target do not count; its label does", () => {
		const link = `[导入器](https://example.com/${"x".repeat(200)})`;
		expect(planStructureIssues(node(`**${"a".repeat(70)}** ${link}`)).total).toBe(0);
		expect(planBlockText(`**粗体** \`code\` [[k/AbCdEfGh|标签]]`).text).toBe("粗体 code 标签");
	});

	test("a second line is refused however short (the goal and the acceptance crammed in)", () => {
		const root = node("导入器\n目标：能导入\n验收：测试通过");
		expect(planStructureIssues(root).issues).toEqual([
			{ kind: "root", sid: root.sid, chars: 16, lines: 3 },
		]);
	});

	test("a code block or a table is not a title", () => {
		expect(planStructureIssues(node("```\nx\n```")).issues[0]).toMatchObject({ kind: "root" });
		expect(planStructureIssues(node("| a | b |\n| - | - |\n| 1 | 2 |")).issues[0]).toMatchObject({
			kind: "root",
		});
	});

	test("an empty root and a heading root are titles", () => {
		expect(planStructureIssues(node("")).total).toBe(0);
		expect(planStructureIssues(node("# 导入器")).total).toBe(0);
		expect(planStructureIssues({ sid: "AbCdEfGh", content: null, children: [] }).total).toBe(0);
	});
});

describe("each block is one short point", () => {
	test("exactly the limit passes, one more is refused, CJK counting 1", () => {
		const fits = node("说".repeat(blockChars));
		expect(planStructureIssues(ok([fits])).total).toBe(0);
		const long = node("说".repeat(blockChars + 1));
		expect(planStructureIssues(ok([long])).issues).toEqual([
			{ kind: "long", sid: long.sid, chars: blockChars + 1 },
		]);
	});

	test("line breaks are not characters; a long multi-line block is still long", () => {
		const lines = Array.from({ length: 4 }, () => "a".repeat(75)).join("\n");
		expect(planStructureIssues(ok([node(lines)])).total).toBe(0);
		const more = Array.from({ length: 5 }, () => "a".repeat(75)).join("\n");
		expect(planStructureIssues(ok([node(more)])).issues[0]).toMatchObject({
			kind: "long",
			chars: 375,
		});
	});

	test("code blocks and tables are not held to it", () => {
		const code = node(`\`\`\`ts\n${"const x = 1;\n".repeat(60)}\`\`\``);
		const row = `| ${"cell ".repeat(10)} | ${"cell ".repeat(10)} |`;
		const table = node(`| a | b |\n| - | - |\n${Array(10).fill(row).join("\n")}`);
		expect(planStructureIssues(ok([code, table])).total).toBe(0);
	});

	test("a deep block is checked too", () => {
		const deep = node("x".repeat(blockChars + 50));
		const root = ok([node("Phase 1", [node("Task", [node("Detail", [deep])])])]);
		expect(planStructureIssues(root).issues).toEqual([
			{ kind: "long", sid: deep.sid, chars: blockChars + 50 },
		]);
	});
});

describe("no flat level of many blocks", () => {
	test(`${maxChildren} blocks under one block pass, ${maxChildren + 1} are refused`, () => {
		const kids = (n: number) => Array.from({ length: n }, (_, i) => node(`Step ${i}`));
		expect(planStructureIssues(ok(kids(maxChildren))).total).toBe(0);
		const root = ok(kids(maxChildren + 1));
		expect(planStructureIssues(root).issues).toEqual([
			{ kind: "flat", sid: root.sid, children: maxChildren + 1 },
		]);
		const phase = node("Phase", kids(maxChildren + 3));
		expect(planStructureIssues(ok([phase])).issues).toEqual([
			{ kind: "flat", sid: phase.sid, children: maxChildren + 3 },
		]);
	});
});

describe("what is not the agent's text", () => {
	const isNote = (n: PlanStructureNode) => (n.content ?? "").startsWith("退回意见");

	test("a note for the agent under the root is neither checked nor counted, nor what is under it", () => {
		const note = node(`退回意见（第 1 版）：${"太长了".repeat(200)}`, [node("x".repeat(400))]);
		const steps = Array.from({ length: maxChildren }, (_, i) => node(`Step ${i}`));
		expect(planStructureIssues(ok([note, ...steps]), { isNote }).total).toBe(0);
		// Without it, the same tree breaks three rules.
		expect(planStructureIssues(ok([note, ...steps])).total).toBe(3);
	});

	test("notes are only the root's children", () => {
		const deep = node(`退回意见（第 1 版）：${"长".repeat(400)}`);
		expect(planStructureIssues(ok([node("Phase", [deep])]), { isNote }).total).toBe(1);
	});

	test("a question put to a person, with its answers, is left out", () => {
		const question = node("问".repeat(500), [node("答".repeat(500))], { status: "open" });
		expect(planStructureIssues(ok([question])).total).toBe(0);
	});
});

describe("the report", () => {
	test("is in document order, each block before what is under it", () => {
		const a = node("a".repeat(blockChars + 1), [node("b".repeat(blockChars + 2))]);
		const c = node("c".repeat(blockChars + 3));
		const root = node("r".repeat(rootChars + 1), [a, c]);
		expect(planStructureIssues(root).issues.map((i) => i.kind === "long" && i.chars)).toEqual([
			false,
			blockChars + 1,
			blockChars + 2,
			blockChars + 3,
		]);
	});

	test(`lists the first ${listed} and counts the rest`, () => {
		const kids = Array.from({ length: listed + 4 }, () => node("x".repeat(blockChars + 1)));
		const report = planStructureIssues(ok(kids));
		expect(report.issues).toHaveLength(listed);
		expect(report.total).toBe(listed + 4);
	});
});

describe("counting characters", () => {
	test("code points, no line breaks", () => {
		expect(planTextChars("ab\n中文\n𠀋")).toBe(5);
		expect(planTextChars("")).toBe(0);
	});
});
