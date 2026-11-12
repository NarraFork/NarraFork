/**
 * Task notices as data (PR-1): the bounds every producer and every reader applies, the
 * `outlineTasks` injection body, the plain projection that rows without it now read through, and
 * the reader summary a `context_update` row stores.
 */
import { describe, expect, it } from "bun:test";
import {
	boundOutlineTaskNoticeItem,
	boundOutlineTaskNoticeItems,
	clipNoticeLine,
	coerceOutlineTasksViewDisplay,
	OUTLINE_TASK_NOTICE_LIMITS,
} from "../outline-task-notice";
import {
	CONTEXT_UPDATE_DISPLAY_MAX_BYTES,
	contextUpdateDisplay,
	DISPLAYED_CONTEXT_PARTS,
} from "../prefix-context";
import {
	coerceSideCarBody,
	renderSideCarBodyToText,
	type SideCarBody,
	sideCarBodyToMarkdown,
	sideCarBodyToPlainText,
} from "../sidecar-body";

/** The model text of the turn-end note as the outline prompts write it (zh-CN). */
const TURN_END =
	"系统备注：`MTBXwl1Y/mSsl3Ccf` 排查中断后无重试按钮…（只读，不改代码） 仍是进行中；做完了就用 OutlineEdit 勾成 [x]。";

/** The model text of PR 5's task-edit notice (zh-CN). */
const TASK_EDIT = [
	"系统通知（不是用户发言）：有人在界面上改了本会话的任务。",
	"",
	"alice：",
	"- `MTBXwl1Y/mSsl3Ccf` 排查中断后无重试按钮（人建，已锁定）：改成完成",
	"- `MTBXwl1Y/Qp93LkaA` 回归测试：中断后重试：交给 @agent:review-1",
	"",
	"请据此调整你的工作；要确认细节就用 OutlineRead 读这些任务。",
].join("\n");

describe("bounds", () => {
	it("clips a title to one line of at most the limit", () => {
		expect(clipNoticeLine("  a\n  b  ")).toBe("a b");
		const long = clipNoticeLine("x".repeat(500));
		expect(long.length).toBe(OUTLINE_TASK_NOTICE_LIMITS.titleChars);
		expect(long.endsWith("…")).toBe(true);
		// Never cuts a surrogate pair in half.
		const emoji = clipNoticeLine("😀".repeat(200), 5);
		expect(emoji).not.toMatch(/[\uD800-\uDBFF]…$/);
	});

	it("keeps known fields of an item, drops unknown ones and malformed changes", () => {
		expect(
			boundOutlineTaskNoticeItem({
				address: "K/a",
				title: "T",
				status: "doing",
				humanCreated: true,
				locked: "yes",
				extra: 1,
				changes: [
					{ kind: "status", from: "todo", to: "done" },
					{ kind: "assigned", to: "agent:review-1" },
					{ kind: "rejected", status: "done", reason: "  not yet  " },
					{ kind: "nope" },
					"junk",
				],
			}),
		).toEqual({
			address: "K/a",
			title: "T",
			status: "doing",
			humanCreated: true,
			changes: [
				{ kind: "status", from: "todo", to: "done" },
				{ kind: "assigned", to: "agent:review-1" },
				{ kind: "rejected", status: "done", reason: "not yet" },
			],
		});
		expect(boundOutlineTaskNoticeItem({ address: "", title: "" })).toBeNull();
		expect(boundOutlineTaskNoticeItem("x")).toBeNull();
	});

	it("keeps team activity's changes bounded: counts, the claim pool, a file (P2 PR 10b)", () => {
		expect(
			boundOutlineTaskNoticeItem({
				address: "K/a",
				title: "T",
				by: "B",
				changes: [
					{ kind: "notes", n: 2.7 },
					{ kind: "reports", n: 0 },
					{ kind: "answers", n: "3" },
					{ kind: "claimable", extra: true },
					{ kind: "overlap", path: `  src/${"x".repeat(300)}.ts ` },
					{ kind: "overlap", path: "" },
				],
			}),
		).toEqual({
			address: "K/a",
			title: "T",
			by: "B",
			changes: [
				{ kind: "notes", n: 2 },
				{ kind: "claimable" },
				{ kind: "overlap", path: expect.stringMatching(/^src\/x+…$/) },
			],
		});
		expect(
			coerceSideCarBody({ kind: "outlineTasks", variant: "activity", items: [], more: 2 }),
		).toEqual({ kind: "outlineTasks", variant: "activity", items: [], more: 2 });
		expect(
			sideCarBodyToPlainText("outline_team_activity", {
				kind: "outlineTasks",
				variant: "activity",
				items: [{ address: "K/a", title: "T" }],
				more: 2,
			}),
		).toBe(["Team activity: 3 change(s)", "", "2 more not listed"].join("\n"));
	});

	it("caps the items of a notice", () => {
		const many = Array.from({ length: 50 }, (_, i) => ({ address: `K/${i}`, title: `T${i}` }));
		expect(boundOutlineTaskNoticeItems(many)).toHaveLength(OUTLINE_TASK_NOTICE_LIMITS.items);
		expect(boundOutlineTaskNoticeItems("x")).toEqual([]);
	});

	it("reads a stored view summary back bounded; null is a removed view", () => {
		expect(coerceOutlineTasksViewDisplay(null)).toBeNull();
		expect(coerceOutlineTasksViewDisplay(undefined)).toBeUndefined();
		expect(coerceOutlineTasksViewDisplay("x")).toBeUndefined();
		const read = coerceOutlineTasksViewDisplay({
			doing: Array.from({ length: 9 }, (_, i) => ({ address: `K/${i}`, title: `T${i}` })),
			waiting: "junk",
			next: [{ address: "K/n", title: "Next", humanCreated: true }],
			counts: { doing: 9, waiting: -1, todo: "2" },
			more: true,
		});
		expect(read?.doing).toHaveLength(5);
		expect(read?.waiting).toEqual([]);
		expect(read?.next).toEqual([{ address: "K/n", title: "Next", humanCreated: true }]);
		expect(read?.counts).toEqual({ doing: 9, waiting: 0, todo: 0 });
		expect(read?.more).toBe(true);
	});
});

describe("the outlineTasks injection body", () => {
	const body: SideCarBody = {
		kind: "outlineTasks",
		variant: "edited",
		items: [
			{
				address: "K/a",
				title: "Fix the retry button",
				by: "alice",
				humanCreated: true,
				changes: [{ kind: "status", from: "doing", to: "done" }],
			},
		],
		more: 2,
	};

	it("is read back bounded, and a malformed one is no body", () => {
		expect(coerceSideCarBody(body)).toEqual(body);
		expect(coerceSideCarBody({ kind: "outlineTasks", variant: "turnEnd" })).toBeUndefined();
		const read = coerceSideCarBody({
			kind: "outlineTasks",
			variant: "whatever",
			items: [{ address: "K/a", title: "x".repeat(400) }, 7],
			more: -3,
		});
		expect(read).toEqual({
			kind: "outlineTasks",
			variant: "turnEnd",
			items: [{ address: "K/a", title: expect.stringMatching(/…$/) }],
		});
	});

	it("renders no model text: its producer wrote that, and it is stored with the row", () => {
		expect(renderSideCarBodyToText("outline_task_edit", body, {})).toBe("");
	});

	it("projects to its heading and what it left out (the transcript draws the task rows)", () => {
		expect(sideCarBodyToPlainText("outline_task_edit", body)).toBe(
			["3 task(s) changed by people", "", "2 more not listed"].join("\n"),
		);
		expect(
			sideCarBodyToPlainText("outline_task_turn_end", {
				kind: "outlineTasks",
				variant: "turnEnd",
				items: [],
			}),
		).toBe("Still in progress — tick it done when it is");
	});
});

describe("the plain projection (rows without the structured body)", () => {
	const CODE = [
		"Approved. Run:",
		"```ts",
		// A template literal inside the fence: its backticks are code, not inline-code markers.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is the code under test
		"const s = `a${b}`;",
		"  indented();",
		"```",
		"Then `bun test`.",
	].join("\n");

	it("keeps a fenced block exactly as written, and inline code outside the outline notices", () => {
		expect(sideCarBodyToPlainText("gen_ui_kit", { kind: "prose", text: CODE })).toBe(CODE);
		expect(
			sideCarBodyToPlainText("buffered_user", {
				kind: "messages",
				items: [
					{ fromId: "u1", fromTitle: "alice", text: "run `rm -rf dist`\n```sh\necho `date`\n```" },
				],
			} as never),
		).toContain("run `rm -rf dist`\n```sh\necho `date`\n```");
	});

	it("an outline notice drops the ticks around addresses, never inside a fenced block", () => {
		expect(sideCarBodyToPlainText("outline_task_edit", { kind: "prose", text: CODE })).toBe(
			CODE.replace("Then `bun test`.", "Then bun test."),
		);
	});

	it("a turn-end note reads once, without heading marks, escapes or code ticks", () => {
		const plain = sideCarBodyToPlainText("outline_task_turn_end", {
			kind: "prose",
			text: TURN_END,
		});
		expect(plain).toBe(
			"系统备注：MTBXwl1Y/mSsl3Ccf 排查中断后无重试按钮…（只读，不改代码） 仍是进行中；做完了就用 OutlineEdit 勾成 [x]。",
		);
		// What the card used to be handed.
		const markdown = sideCarBodyToMarkdown("outline_task_turn_end", {
			kind: "prose",
			text: TURN_END,
		});
		expect(markdown).toStartWith("###### ");
		expect(markdown).toContain("\\[x\\]");
	});

	it("a task-edit notice keeps its lines, with no backslashes", () => {
		const plain = sideCarBodyToPlainText("outline_task_edit", { kind: "prose", text: TASK_EDIT });
		expect(plain).not.toContain("\\");
		expect(plain).not.toContain("#");
		expect(plain).not.toContain("`");
		expect(plain.split("\n")).toEqual([
			"系统通知（不是用户发言）：有人在界面上改了本会话的任务。",
			"alice：",
			"- MTBXwl1Y/mSsl3Ccf 排查中断后无重试按钮（人建，已锁定）：改成完成",
			"- MTBXwl1Y/Qp93LkaA 回归测试：中断后重试：交给 @agent:review-1",
			"请据此调整你的工作；要确认细节就用 OutlineRead 读这些任务。",
		]);
	});

	it("the behaviour fence keeps its named heading; a task digest lists bullets", () => {
		expect(
			sideCarBodyToPlainText("behavior_fence", { kind: "prose", text: "Never push to main." }),
		).toBe("Behaviour fence\n\nNever push to main.");
		expect(
			sideCarBodyToPlainText("interrupt_task_guard", {
				kind: "tasks",
				variant: "current",
				taskBackend: "outline",
				tasks: [
					{ role: "doing", text: "Write `the` parser", ref: "K/a" },
					{ role: "todo", text: "Docs", protected: true },
				],
			}),
		).toBe(
			[
				"Outline tasks — 2 open",
				"",
				"• doing: Write the parser",
				"• todo: Docs · set by a person",
			].join("\n"),
		);
	});
});

describe("the reader summary a context_update row stores", () => {
	it("keeps the summaries of changed parts and null for a removed tasks view", () => {
		const view = { doing: [], waiting: [], next: [], counts: { doing: 0, waiting: 0, todo: 1 } };
		expect(
			contextUpdateDisplay(
				[
					{ key: "outline.tasks", value: "…" },
					{ key: "workspace", value: "/repo" },
				],
				{ "outline.tasks": view },
			),
		).toEqual({ "outline.tasks": view });
		expect(contextUpdateDisplay([{ key: "outline.tasks", value: null }], undefined)).toEqual({
			"outline.tasks": null,
		});
		expect(DISPLAYED_CONTEXT_PARTS.has("outline.tasks")).toBe(true);
	});

	it("stores nothing for parts without a summary, removed or not, and nothing oversized", () => {
		expect(contextUpdateDisplay([{ key: "workspace", value: null }], undefined)).toBeUndefined();
		expect(contextUpdateDisplay([{ key: "outline.behavior", value: "x" }], {})).toBeUndefined();
		const huge = "x".repeat(CONTEXT_UPDATE_DISPLAY_MAX_BYTES);
		expect(
			contextUpdateDisplay([{ key: "outline.tasks", value: "…" }], { "outline.tasks": huge }),
		).toBeUndefined();
	});
});
