/**
 * The plan format a submitted outline plan is held to (plan readability): the root a one-line
 * title; its first block a background paragraph (not a task, nothing under it, at most
 * `backgroundChars`); big and small points one idea each (`pointChars`), implementation details
 * longer (`detailChars`); the notable points section, when there is one, the root's last block;
 * no flat level of many blocks. Each rule at its boundary, characters counted as a reader counts
 * them (CJK 1 each, markup not at all), code and tables not prose, notes for the agent and
 * questions to a person left out (and not taking the background's or the last block's place),
 * document order and the listed cap.
 */
import { describe, expect, test } from "bun:test";
import {
	isNotablePointsHeading,
	NOTABLE_POINTS_TITLE,
	OUTLINE_PLAN_STRUCTURE,
	type PlanStructureNode,
	planBackgroundProblem,
	planBlockText,
	planStructureIssues,
	planTextChars,
} from "../outline-plan-structure";

const { rootChars, backgroundChars, pointChars, detailChars, maxChildren, listed } =
	OUTLINE_PLAN_STRUCTURE;

let next = 0;
function node(
	content: string,
	children: PlanStructureNode[] = [],
	extra: { ask?: unknown; task?: unknown } = {},
): PlanStructureNode {
	next++;
	return { sid: `S${String(next).padStart(7, "0")}`, content, children, ...extra };
}
const task = (content: string, children: PlanStructureNode[] = []) =>
	node(content, children, { task: { status: "todo" } });
const background = () =>
	node("导入器每天夜里失败，要人工重跑；这次让它无人值守地跑完，失败时自己重试并告警。");

/** A plan in the format: a title, the background, then `children` (by default one big point). */
const plan = (children?: PlanStructureNode[], title = "Ship the importer") =>
	node(title, [background(), ...(children ?? [task("Phase 1")])]);
const issues = (root: PlanStructureNode, isNote?: (n: PlanStructureNode) => boolean) =>
	planStructureIssues(root, { isNote }).issues;

describe("the limits", () => {
	test("are the numbers the prompts state", () => {
		expect(OUTLINE_PLAN_STRUCTURE).toEqual({
			rootChars: 80,
			backgroundChars: 400,
			pointChars: 120,
			detailChars: 600,
			maxChildren: 15,
			listed: 8,
		});
		expect(NOTABLE_POINTS_TITLE).toEqual({ en: "Notable points", "zh-CN": "特别值得注意的点" });
	});
});

describe("a plan in the format", () => {
	test("title, background, big points, small points, details, notable points: no problem", () => {
		const root = plan([
			task("阶段 1：去掉固定时间拒绝", [
				task("清除模型历史链路的固定时间拒绝", [
					node("删除 deadline 传播和超时 reject"),
					node("loop.ts 删掉 HISTORY_READ_TIMEOUT 分支", [node("保留错误码定义一个版本")]),
				]),
			]),
			node(NOTABLE_POINTS_TITLE["zh-CN"], [node("错误码保留一个版本")]),
		]);
		expect(planStructureIssues(root)).toEqual({ issues: [], total: 0 });
	});

	test("the notable points are optional", () => {
		expect(planStructureIssues(plan([task("Phase 1", [task("Step")])])).total).toBe(0);
	});
});

describe("the root is a short one-line title", () => {
	test("exactly the limit passes, one more is refused (Latin)", () => {
		expect(planStructureIssues(plan(undefined, "a".repeat(rootChars))).total).toBe(0);
		const root = plan(undefined, "a".repeat(rootChars + 1));
		expect(issues(root)).toEqual([{ kind: "root", sid: root.sid, chars: rootChars + 1, lines: 1 }]);
	});

	test("a CJK character counts 1, like a letter; an astral character too", () => {
		expect(planStructureIssues(plan(undefined, "历".repeat(rootChars))).total).toBe(0);
		expect(issues(plan(undefined, "历".repeat(rootChars + 1)))[0]).toMatchObject({
			kind: "root",
			chars: 81,
		});
		expect(planStructureIssues(plan(undefined, "𠀋".repeat(rootChars))).total).toBe(0);
	});

	test("markup and a link's target do not count; its label does", () => {
		const link = `[导入器](https://example.com/${"x".repeat(200)})`;
		expect(planStructureIssues(plan(undefined, `**${"a".repeat(70)}** ${link}`)).total).toBe(0);
		expect(planBlockText(`**粗体** \`code\` [[k/AbCdEfGh|标签]]`).text).toBe("粗体 code 标签");
	});

	test("a second line is refused however short (the goal and the acceptance crammed in)", () => {
		const root = plan(undefined, "导入器\n目标：能导入\n验收：测试通过");
		expect(issues(root)).toEqual([{ kind: "root", sid: root.sid, chars: 16, lines: 3 }]);
	});

	test("a code block or a table is not a title; an empty root and a heading root are", () => {
		expect(issues(plan(undefined, "```\nx\n```"))[0]).toMatchObject({ kind: "root" });
		expect(issues(plan(undefined, "| a | b |\n| - | - |\n| 1 | 2 |"))[0]).toMatchObject({
			kind: "root",
		});
		expect(planStructureIssues(plan(undefined, "")).total).toBe(0);
		expect(planStructureIssues(plan(undefined, "# 导入器")).total).toBe(0);
	});
});

describe("the root's first block is the background", () => {
	test("missing: refused by the root's address", () => {
		const root = node("Ship the importer");
		expect(issues(root)).toEqual([{ kind: "background", sid: root.sid, problem: "none" }]);
	});

	test("a task, a heading, code, an empty block, a block with children: refused by that block", () => {
		const cases: Array<[PlanStructureNode, string]> = [
			[task("阶段 1"), "task"],
			[node("# 背景"), "heading"],
			[node("```\nx\n```"), "notProse"],
			[node("| a |\n| - |\n| 1 |"), "notProse"],
			[node("**  **"), "empty"],
			[node("目标", [node("读历史超过 10 秒只告警")]), "children"],
		];
		for (const [first, problem] of cases) {
			const found = issues(node("Title", [first]));
			expect(found[0]).toEqual({ kind: "background", sid: first.sid, problem } as never);
		}
		expect(planBackgroundProblem({ content: null, task: false, children: 0 })).toBe("empty");
		expect(planBackgroundProblem({ content: "> 引用的一段话", task: false, children: 0 })).toBe(
			null,
		);
	});

	test("a first block that is not a background is still checked as the point it is", () => {
		const first = task("阶".repeat(pointChars + 1));
		expect(issues(node("Title", [first]))).toEqual([
			{ kind: "background", sid: first.sid, problem: "task" },
			{ kind: "long", sid: first.sid, chars: pointChars + 1, role: "point" },
		]);
	});

	test(`at most ${backgroundChars} characters, CJK counting 1; more is refused as a background`, () => {
		const fits = node("景".repeat(backgroundChars));
		expect(planStructureIssues(node("Title", [fits, task("Phase")])).total).toBe(0);
		const long = node("景".repeat(backgroundChars + 1));
		expect(issues(node("Title", [long, task("Phase")]))).toEqual([
			{ kind: "long", sid: long.sid, chars: backgroundChars + 1, role: "background" },
		]);
		// Markup is not counted: a long link target in the background is fine.
		const linked = node(`${"景".repeat(backgroundChars - 2)}[链接](https://x/${"y".repeat(300)})`);
		expect(planStructureIssues(node("Title", [linked, task("Phase")])).total).toBe(0);
	});

	test("notes for the agent and questions put to a person do not take its place", () => {
		const isNote = (n: PlanStructureNode) => (n.content ?? "").startsWith("退回意见");
		const note = node("退回意见（第 1 版）：请先写背景");
		const ask = node("要不要按会话限频？", [], { ask: { status: "open" } });
		expect(
			planStructureIssues(node("Title", [note, ask, background(), task("Phase")]), { isNote })
				.total,
		).toBe(0);
		const only = node("Title", [note, ask]);
		expect(issues(only, isNote)).toEqual([{ kind: "background", sid: only.sid, problem: "none" }]);
	});
});

describe("points are one idea; details may be longer", () => {
	test(`a big or a small point: ${pointChars} pass, one more is refused`, () => {
		const big = task("大".repeat(pointChars));
		const small = task("小".repeat(pointChars));
		expect(planStructureIssues(plan([task("Phase", [small]), big])).total).toBe(0);
		const longBig = task("大".repeat(pointChars + 1));
		const longSmall = task("小".repeat(pointChars + 1));
		expect(issues(plan([task("Phase", [longSmall]), longBig]))).toEqual([
			{ kind: "long", sid: longSmall.sid, chars: pointChars + 1, role: "point" },
			{ kind: "long", sid: longBig.sid, chars: pointChars + 1, role: "point" },
		]);
	});

	test(`an implementation detail (depth 3 and deeper): ${detailChars} pass, one more is refused`, () => {
		const fits = node("细".repeat(detailChars), [node("深".repeat(detailChars))]);
		expect(planStructureIssues(plan([task("Phase", [task("Step", [fits])])])).total).toBe(0);
		const long = node("细".repeat(detailChars + 1));
		const deep = node("深".repeat(detailChars + 2));
		const root = plan([task("Phase", [task("Step", [long, node("ok", [deep])])])]);
		expect(issues(root)).toEqual([
			{ kind: "long", sid: long.sid, chars: detailChars + 1, role: "detail" },
			{ kind: "long", sid: deep.sid, chars: detailChars + 2, role: "detail" },
		]);
	});

	test("line breaks are not characters", () => {
		const lines = Array.from({ length: 4 }, () => "a".repeat(30)).join("\n");
		expect(planStructureIssues(plan([task(lines)])).total).toBe(0);
	});

	test("code blocks and tables are not held to a length", () => {
		const code = node(`\`\`\`ts\n${"const x = 1;\n".repeat(60)}\`\`\``);
		const row = `| ${"cell ".repeat(20)} | ${"cell ".repeat(20)} |`;
		const table = node(`| a | b |\n| - | - |\n${Array(10).fill(row).join("\n")}`);
		expect(planStructureIssues(plan([task("Phase", [code, table])])).total).toBe(0);
	});
});

describe("the notable points section", () => {
	test("is recognized by its words, in either language and small variants", () => {
		for (const text of [
			"特别值得注意的点",
			"**特别值得注意的点：**",
			"## 特别值得注意的点",
			"特别值得注意",
			"值得注意的点",
			"注意事项",
			"Notable points",
			"Notable Points:",
			"**Notable points**",
			"Notable point",
			"Points to note",
		])
			expect([text, isNotablePointsHeading(text)]).toEqual([text, true]);
		for (const text of [
			"特别值得注意的点：错误码保留一个版本",
			"Notable change in the API",
			"```\n特别值得注意的点\n```",
			"阶段 3",
			"",
		])
			expect([text, isNotablePointsHeading(text)]).toEqual([text, false]);
		expect(isNotablePointsHeading(null)).toBe(false);
	});

	test("must be the root's last block", () => {
		const notable = node(NOTABLE_POINTS_TITLE.en, [node("A risk")]);
		expect(planStructureIssues(plan([task("Phase 1"), notable])).total).toBe(0);
		const early = node(NOTABLE_POINTS_TITLE["zh-CN"], [node("风险")]);
		expect(issues(plan([early, task("阶段 1")]))).toEqual([{ kind: "notable", sid: early.sid }]);
	});

	test("notes for the agent and questions after it do not count; a second one does", () => {
		const isNote = (n: PlanStructureNode) => (n.content ?? "").startsWith("Returned");
		const notable = node("Notable points", [node("A risk")]);
		const note = node("Returned (version 1): add a rollback");
		const ask = node("Rate-limit per session?", [], { ask: { status: "open" } });
		expect(planStructureIssues(plan([task("Phase"), notable, note, ask]), { isNote }).total).toBe(
			0,
		);
		const again = node("注意事项", [node("另一个风险")]);
		expect(issues(plan([notable, task("Phase"), again]))).toEqual([
			{ kind: "notable", sid: notable.sid },
		]);
	});

	test("its items are points", () => {
		const item = node("险".repeat(pointChars + 1));
		expect(issues(plan([task("Phase"), node("Notable points", [item])]))).toEqual([
			{ kind: "long", sid: item.sid, chars: pointChars + 1, role: "point" },
		]);
	});
});

describe("a plan has points; a notable section has items", () => {
	test("a background alone, or with the notable points only, has no big point", () => {
		const bare = node("Title", [background()]);
		expect(issues(bare)).toEqual([{ kind: "noPoints", sid: bare.sid }]);
		const notableOnly = node("Title", [background(), node("Notable points", [node("A risk")])]);
		expect(issues(notableOnly)).toEqual([{ kind: "noPoints", sid: notableOnly.sid }]);
	});

	test("an empty notable section is refused; a question under it is not an item", () => {
		const empty = node("特别值得注意的点");
		expect(issues(plan([task("Phase"), empty]))).toEqual([
			{ kind: "notableEmpty", sid: empty.sid },
		]);
		const asked = node("特别值得注意的点", [node("要不要限频？", [], { ask: { status: "open" } })]);
		expect(issues(plan([task("Phase"), asked]))).toEqual([
			{ kind: "notableEmpty", sid: asked.sid },
		]);
	});

	test("a task titled like the section is a big point, not the section", () => {
		const phase = task("注意事项");
		expect(planStructureIssues(plan([phase, task("Phase 2")])).total).toBe(0);
	});
});

describe("no flat level of many blocks", () => {
	test(`${maxChildren} blocks under one block pass, ${maxChildren + 1} are refused`, () => {
		const kids = (n: number) => Array.from({ length: n }, (_, i) => task(`Step ${i}`));
		// The background is one of the root's blocks.
		expect(planStructureIssues(plan(kids(maxChildren - 1))).total).toBe(0);
		const root = plan(kids(maxChildren));
		expect(issues(root)).toEqual([{ kind: "flat", sid: root.sid, children: maxChildren + 1 }]);
		const phase = task("Phase", kids(maxChildren + 3));
		expect(issues(plan([phase]))).toEqual([
			{ kind: "flat", sid: phase.sid, children: maxChildren + 3 },
		]);
	});

	test("questions put to a person do not count toward a level, nor as a background's children", () => {
		const ask = () => node("要不要按会话限频？", [], { ask: { status: "open" } });
		const kids = Array.from({ length: maxChildren }, (_, i) => task(`Step ${i}`));
		const phase = task("Phase", [...kids, ask(), ask()]);
		expect(planStructureIssues(plan([phase])).total).toBe(0);
		const asked = node("背景：导入器每天夜里失败。", [ask()]);
		expect(planStructureIssues(node("Title", [asked, task("Phase")])).total).toBe(0);
	});
});

describe("what is not the agent's text", () => {
	const isNote = (n: PlanStructureNode) => (n.content ?? "").startsWith("退回意见");

	test("a note for the agent under the root is neither checked nor counted, nor what is under it", () => {
		const note = node(`退回意见（第 1 版）：${"太长了".repeat(200)}`, [node("x".repeat(900))]);
		const steps = Array.from({ length: maxChildren - 1 }, (_, i) => task(`Step ${i}`));
		expect(planStructureIssues(plan([...steps, note]), { isNote }).total).toBe(0);
		// Without it, the same tree breaks three rules.
		expect(planStructureIssues(plan([...steps, note])).total).toBe(3);
	});

	test("notes are only the root's children", () => {
		const deep = node(`退回意见（第 1 版）：${"长".repeat(400)}`);
		expect(planStructureIssues(plan([task("Phase", [deep])]), { isNote }).total).toBe(1);
	});

	test("a question put to a person, with its answers, is left out", () => {
		const question = node("问".repeat(500), [node("答".repeat(900))], { ask: { status: "open" } });
		expect(planStructureIssues(plan([task("Phase", [question])])).total).toBe(0);
	});
});

describe("the report", () => {
	test("is in document order, each block before what is under it", () => {
		const a = task("a".repeat(pointChars + 1), [task("b".repeat(pointChars + 2))]);
		const notable = node("Notable points");
		const c = task("c".repeat(pointChars + 3));
		const root = node("r".repeat(rootChars + 1), [task("x"), a, notable, c]);
		expect(issues(root).map((i) => (i.kind === "long" ? i.chars : i.kind))).toEqual([
			"root",
			"background",
			pointChars + 1,
			pointChars + 2,
			"notable",
			"notableEmpty",
			pointChars + 3,
		]);
	});

	test(`lists the first ${listed} and counts the rest`, () => {
		const kids = Array.from({ length: listed + 4 }, () => task("x".repeat(pointChars + 1)));
		const report = planStructureIssues(plan(kids));
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
