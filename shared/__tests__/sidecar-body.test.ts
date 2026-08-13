/**
 * sidecar-body.test.ts — the two projections of a structured side-car.
 *
 * ## Why the byte-parity half of this file exists
 *
 * `content` (the model-facing text) used to be hand-assembled at each of ~12
 * injection points. It is now produced by `renderSideCarBodyToText` from a
 * structured `SideCarBody`. That text goes straight into the model's context, so the
 * migration must not change ONE CHARACTER of it — a reworded reminder is a silent
 * behaviour change in every session that receives it.
 *
 * So the first half below reproduces each predecessor formatter as a local literal
 * (copied from the pre-refactor source) and asserts the new renderer matches it
 * exactly, in both locales. Local copies rather than imports on purpose: importing
 * the live formatter would make the test tautological the moment someone "fixes"
 * both sides together, which is exactly the drift it is here to catch.
 *
 * The second half covers `presentSideCarBody`, the UI projection — which is
 * deliberately NOT the same text (it drops the model-facing instruction boilerplate;
 * see the module header in sidecar-body.ts).
 */

import { describe, expect, it } from "bun:test";
import {
	coerceSideCarBody,
	rawSideCarToMarkdown,
	readSideCarBody,
	renderSideCarBodyToText,
	SIDECAR_PROJECTION_MAX_LINES,
	type SideCarBody,
	type SideCarModelTemplates,
	sideCarBodyToMarkdown,
} from "../sidecar-body";

// ─────────────────────────────────────────────────────────────────────────────
// The real server templates, inlined.
//
// `getSideCarModelTemplates` reads them out of `server/lib/i18n.ts`, which this
// (shared, server-free) test must not import. Keeping a copy here is the point: if
// someone edits a template in the message table, the parity assertions below keep
// passing while THIS map goes stale — and the stale-map failure is what tells us a
// model-facing string moved.
// ─────────────────────────────────────────────────────────────────────────────

const EN: SideCarModelTemplates = {
	noticeSilentProgress: `<progress_update_request>
You have completed {count} tool call(s) since your last visible text reply. Before calling any more tools, briefly tell the user in one sentence what you are working on right now, then continue.
</progress_update_request>`,
	noticeRelaxedPlan: `<relaxed_plan_reminder>
You are still in relaxed plan mode. This non-read-only tool call was allowed only so planning can continue with full context. Do not start implementation work yet. Continue investigating or refining the plan, then call ExitPlanMode to submit the complete plan for approval.
</relaxed_plan_reminder>`,
	noticePipelineExit:
		"[SYSTEM: Pipeline has already been used to extract captured output and is still active. Before making more tool calls, confirm whether you still need Pipeline. If not, stop using Pipeline so its captures can be cleaned up by the inactivity limit instead of continuing to accumulate.]",
	behavior_fenceHeading:
		"Behavior fence (durable behavior constraints set by the user — you must obey them):",
	tasksCurrentHeading: "Current Dynamic Spec reminder (compiled from spec://tasks.json):",
	tasksCurrentUpdateNote:
		"If task state changed, update spec://tasks.json with Read/Edit/Write. Do not add IDs, timestamps, or notes fields to tasks.json.",
	tasksEmptyHeading: "Dynamic Spec reminder (spec://tasks.json has no active tasks):",
	tasksEmptyNeverCreate:
		"- You have not created any task in spec://tasks.json yet. If this is multi-step or non-trivial work, use Write/Edit to build a task list to track progress, e.g. one doing plus a few todo.",
	tasksEmptyNeverSkip:
		"- If the current work is genuinely simple and does not need to be broken down, you may ignore this reminder.",
	tasksEmptyDoneReorganize:
		"- The previous phase is complete. Before starting the next round of work, reassess the current goal and context, then reorganize spec://tasks.json: remove completed ordinary tasks, preserve protected-task intent, and keep only a concise set of necessary doing/todo/blocked tasks for the current phase.",
	tasksEmptyDoneContinue:
		"- Continue the work only after the task list is refreshed; do not retain completed tasks merely as history.",
	tasksTooManyHeading:
		"Dynamic Spec reorganization reminder (spec://tasks.json has {count} tasks, exceeding {threshold}):",
	tasksTooManyReorganize:
		"- Reorganize the task list before continuing: merge duplicate or closely related tasks, remove obsolete ordinary tasks, split oversized tasks, and keep only the necessary doing/todo/blocked tasks for the current phase.",
	tasksTooManyProtected:
		"- Preserve protected-task intent; do not rewrite, delete, or replace a protected task to bypass its goal.",
	tasksFieldsNote:
		"- Keep tasks.json to only text/status/protected; do not add IDs, timestamps, summaries, or other fields.",
	tasksSemanticsNote:
		"- Every open task must be finite, executable, and have a completion condition; an open protected task may trigger automatic continuation. Do not store standing behavior rules or constraints without a terminal state as tasks; those belong in spec://behavior_fence.",
	tasksBlockedActionNote: `Blocked-task rule:
- A blocked task means the task itself cannot currently finish; it does not automatically mean work should stop.
- If progress requires user-only information, permission, or a product/strategy decision, finish all independent work first, then ask exactly one targeted question.
- If user input is not required and an investigation, evidence-gathering step, experiment, fix, or alternative path can remove the blocker, do not end the turn by merely explaining the blocker or repeating the same conclusion. Keep the original task blocked, add a concrete actionable unblock task to tasks.json as doing (and later steps as todo), then immediately use tools to execute it.
- Only when no autonomous path exists may you explain an external hard blocker once and stop; never repeat the same blocker explanation across continuation turns.`,
	knowledgeHeading: "Relevant knowledge-base entries were found based on the latest tool output:",
	knowledgeReadHint: "(Use KnowledgeRead with an id for full content.)",
	bgAgentEntry: `[System] Background agent "{title}" (ID: {id}) {status}.
Result preview: {preview}
Use Await({ type: "agent", id: "{id}" }) to see the full result, or Send({ id: "{id}", message }) to continue.`,
	bgBashEntry: `[System] Background bash "{title}" (ID: {id}) {status}.
Result preview: {preview}`,
	emptyResult: "(empty)",
	subagentMessageEntry: `[Progress report from subagent "{name}" ({type})]:
{text}`,
	teamMessageEntry: "[Team {channel} from {name} ({type})]: {text}",
	teamBroadcast: "broadcast",
	teamDirect: "message",
	specUpdateHeading:
		"[System] The user updated the following spec files via the Spec panel — align your plan accordingly:",
	specUpdateEntry: "User updated {uri} via UI ({timestamp}).",
	specUpdatePreview: "Content preview:",
};

const ZH: SideCarModelTemplates = {
	...EN,
	noticeSilentProgress: `<progress_update_request>
你已经连续 {count} 次工具调用没有向用户输出可见文本。继续调用更多工具前，请先用一句话简短告诉用户你当前正在做什么，然后继续。
</progress_update_request>`,
	noticeRelaxedPlan: `<relaxed_plan_reminder>
你仍处于宽松计划模式。此次非只读工具调用只是为了让规划能带着完整上下文继续进行，并不表示可以开始实现。不要现在开始写实现代码；请继续调查或完善计划，然后调用 ExitPlanMode 提交完整计划供用户批准。
</relaxed_plan_reminder>`,
	noticePipelineExit:
		"[系统提示：Pipeline 已经执行过一次提取，目前仍处于活动状态。继续调用工具前，请确认是否仍需要 Pipeline；如果不再需要，请停止使用 Pipeline，让系统按闲置阈值清理捕获内容，避免继续累积。]",
	behavior_fenceHeading: "行为护栏（用户设定的行为约束，务必遵守）：",
	tasksCurrentHeading: "当前 Dynamic Spec 提醒（由 spec://tasks.json 编译生成）：",
	tasksCurrentUpdateNote:
		"如任务状态已变化，请用 Read/Edit/Write 更新 spec://tasks.json；不要在 tasks.json 中添加 ID、时间戳或说明字段。",
	tasksEmptyHeading: "Dynamic Spec 提醒（spec://tasks.json 当前没有进行中的任务）：",
	tasksEmptyNeverCreate:
		"- 你还没有在 spec://tasks.json 建立任何任务。如果当前是多步骤或较复杂的工作，请用 Write/Edit 建立任务清单来跟踪进度，例如一条 doing + 若干 todo。",
	tasksEmptyNeverSkip: "- 如果当前工作确实简单、无需拆分，可以忽略本提醒。",
	tasksEmptyDoneReorganize:
		"- 上一阶段任务已全部完成。现在开始下一轮工作前，请先重新审视当前目标和上下文，整理 spec://tasks.json：清理已完成的普通任务，保留 protected task 的用户意图，并只保留当前阶段必要且精简的 doing/todo/blocked 任务。",
	tasksEmptyDoneContinue: "- 整理完成后再继续当前工作；不要为了保留历史而堆积已完成任务。",
	tasksTooManyHeading:
		"Dynamic Spec 整理提醒（spec://tasks.json 当前有 {count} 条任务，超过 {threshold} 条）：",
	tasksTooManyReorganize:
		"- 请先重新整理任务清单，再继续执行：合并重复或高度相关的任务，删除已过期的普通任务，拆分过大的任务，并确保当前阶段只有必要的 doing/todo/blocked 任务。",
	tasksTooManyProtected:
		"- protected task 的用户意图必须保留；不要通过改写、删除或替换 protected task 来绕过目标。",
	tasksFieldsNote:
		"- tasks.json 只保留 text/status/protected，不要添加 ID、时间戳、摘要或其他字段。",
	tasksSemanticsNote:
		"- 每条开放任务必须有限、可执行且有完成条件；protected task 未完成时可能触发自动续跑。不要把长期行为规则或无终点约束写成任务，这类内容属于 spec://behavior_fence。",
	tasksBlockedActionNote: `blocked 任务处理规则：
- blocked 表示该任务本身暂时不能完成，不自动等于停止工作。
- 如果推进需要用户独有的信息、权限或产品/方案决策，先完成所有不受阻工作，再只提出一个精确问题。
- 如果不需要用户介入，并且可以通过调查、取证、实验、修复或替代路径解除阻塞，不能只解释阻塞或重复相同结论。保留原 blocked 任务，在 tasks.json 中新增一个具体、可执行的解阻任务并标为 doing（后续步骤标为 todo），然后立即调用工具执行。
- 只有确实不存在自主推进路径时，才可说明一次外部硬阻塞并停止；不得在续跑回合中重复同一阻塞说明。`,
	subagentMessageEntry: `[来自子代理"{name}"（{type}）的进展汇报]：
{text}`,
	specUpdateHeading: "[系统] 用户通过 Spec 面板更新了以下文件，请注意同步你的工作计划：",
	specUpdateEntry: "用户通过 UI 更新了 {uri}（{timestamp}）。",
	specUpdatePreview: "内容预览：",
};

const THRESHOLD = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Byte parity against the pre-refactor formatters
// ─────────────────────────────────────────────────────────────────────────────

describe("renderSideCarBodyToText — byte parity with the original formatters", () => {
	it("silent_progress reproduces getToolMessageWithParams('silentToolCallProgressReminder')", () => {
		const body: SideCarBody = { kind: "notice", params: { count: 20 } };
		// Original: server/lib/i18n.ts "tool.silentToolCallProgressReminder".
		expect(renderSideCarBodyToText("silent_progress", body, EN)).toBe(
			`<progress_update_request>
You have completed 20 tool call(s) since your last visible text reply. Before calling any more tools, briefly tell the user in one sentence what you are working on right now, then continue.
</progress_update_request>`,
		);
		expect(renderSideCarBodyToText("silent_progress", body, ZH)).toBe(
			`<progress_update_request>
你已经连续 20 次工具调用没有向用户输出可见文本。继续调用更多工具前，请先用一句话简短告诉用户你当前正在做什么，然后继续。
</progress_update_request>`,
		);
	});

	it("relaxed_plan and pipeline_exit_confirmation reproduce their tool messages", () => {
		expect(renderSideCarBodyToText("relaxed_plan", { kind: "notice" }, EN)).toContain(
			"<relaxed_plan_reminder>",
		);
		expect(renderSideCarBodyToText("relaxed_plan", { kind: "notice" }, EN)).toBe(
			EN.noticeRelaxedPlan as string,
		);
		expect(renderSideCarBodyToText("pipeline_exit_confirmation", { kind: "notice" }, ZH)).toBe(
			ZH.noticePipelineExit as string,
		);
	});

	it("an unmapped notice source renders empty rather than a wrong reminder", () => {
		expect(renderSideCarBodyToText("something_new", { kind: "notice" }, EN)).toBe("");
	});

	it("behavior_fence reproduces buildBehaviorFenceReminder", () => {
		const fence = "Never touch the auth module without approval.";
		const body: SideCarBody = { kind: "prose", text: fence };
		// Original: `${heading}\n${content}`.
		expect(renderSideCarBodyToText("behavior_fence", body, EN)).toBe(
			`Behavior fence (durable behavior constraints set by the user — you must obey them):\n${fence}`,
		);
		expect(renderSideCarBodyToText("behavior_fence", body, ZH)).toBe(
			`行为护栏（用户设定的行为约束，务必遵守）：\n${fence}`,
		);
	});

	it("buffered_user prose is emitted bare (the user's own words)", () => {
		const text = "please also update the changelog";
		expect(renderSideCarBodyToText("buffered_user", { kind: "prose", text }, EN)).toBe(text);
	});

	it("tasks/current reproduces buildSpecToolResultReminder's open-task shape", () => {
		const body: SideCarBody = {
			kind: "tasks",
			variant: "current",
			tasks: [
				{ role: "doing", text: "Implement the parser" },
				{ role: "blocked", text: "Collect missing trace evidence", protected: true },
				{ role: "todo", text: "Write the tests" },
			],
		};
		// Original: heading, `- ${prefix}: ${text}${protected ? " [protected]" : ""}` lines,
		// the update note, the semantics reminder, then the blocked-task rule.
		expect(renderSideCarBodyToText("living_work_spec", body, EN)).toBe(
			[
				"Current Dynamic Spec reminder (compiled from spec://tasks.json):",
				"- doing: Implement the parser",
				"- blocked: Collect missing trace evidence [protected]",
				"- todo: Write the tests",
				EN.tasksCurrentUpdateNote,
				EN.tasksSemanticsNote,
				EN.tasksBlockedActionNote,
			].join("\n"),
		);
		expect(renderSideCarBodyToText("living_work_spec", body, ZH)).toBe(
			[
				"当前 Dynamic Spec 提醒（由 spec://tasks.json 编译生成）：",
				"- doing: Implement the parser",
				"- blocked: Collect missing trace evidence [protected]",
				"- todo: Write the tests",
				ZH.tasksCurrentUpdateNote,
				ZH.tasksSemanticsNote,
				ZH.tasksBlockedActionNote,
			].join("\n"),
		);
	});

	it("tasks/emptyNever and emptyDone reproduce buildEmptyTasksNudge's two tones", () => {
		expect(
			renderSideCarBodyToText("living_work_spec", { kind: "tasks", variant: "emptyNever" }, EN),
		).toBe(
			[
				EN.tasksEmptyHeading,
				EN.tasksEmptyNeverCreate,
				EN.tasksEmptyNeverSkip,
				EN.tasksFieldsNote,
				EN.tasksSemanticsNote,
			].join("\n"),
		);
		expect(
			renderSideCarBodyToText("living_work_spec", { kind: "tasks", variant: "emptyDone" }, EN),
		).toBe(
			[
				EN.tasksEmptyHeading,
				EN.tasksEmptyDoneReorganize,
				EN.tasksEmptyDoneContinue,
				EN.tasksFieldsNote,
				EN.tasksSemanticsNote,
			].join("\n"),
		);
		// The all-done branch must not reuse the never-created phrasing (asserted
		// upstream in spec-reminder.test.ts too).
		expect(
			renderSideCarBodyToText("living_work_spec", { kind: "tasks", variant: "emptyDone" }, EN),
		).not.toContain("have not created any task");
	});

	it("tasks/tooMany reproduces buildTooManyTasksNudge including both numbers", () => {
		const body: SideCarBody = {
			kind: "tasks",
			variant: "tooMany",
			taskCount: 31,
			threshold: THRESHOLD,
		};
		expect(renderSideCarBodyToText("living_work_spec", body, EN)).toBe(
			[
				`Dynamic Spec reorganization reminder (spec://tasks.json has 31 tasks, exceeding ${THRESHOLD}):`,
				EN.tasksTooManyReorganize,
				EN.tasksTooManyProtected,
				EN.tasksFieldsNote,
				EN.tasksSemanticsNote,
			].join("\n"),
		);
		expect(renderSideCarBodyToText("living_work_spec", body, ZH)).toContain(`超过 ${THRESHOLD} 条`);
	});

	it("knowledge reproduces formatInjectionsBare", () => {
		const body: SideCarBody = {
			kind: "knowledge",
			hits: [
				{ entryId: "k1", title: "SQLite WAL", summary: "why WAL is on" },
				{ entryId: "k2", title: "FTS5 trigram", summary: "CJK search" },
			],
		};
		// Original: `${heading}\n${lines.join("\n")}\n\n(Use KnowledgeRead with an id for full content.)`
		expect(renderSideCarBodyToText("knowledge_base_hint", body, EN)).toBe(
			"Relevant knowledge-base entries were found based on the latest tool output:\n" +
				"- [k1] SQLite WAL: why WAL is on\n" +
				"- [k2] FTS5 trigram: CJK search\n" +
				"\n(Use KnowledgeRead with an id for full content.)",
		);
	});

	it("tasksDone/agent reproduces formatBackgroundCompletionNotifications", () => {
		const body: SideCarBody = {
			kind: "tasksDone",
			flavor: "agent",
			items: [
				{ id: "a1", title: "read the two paths", status: "done", preview: "both read" },
				{ id: "a2", title: "empty one", status: "done", preview: "" },
			],
		};
		expect(renderSideCarBodyToText("bg_agent", body, EN)).toBe(
			`[System] Background agent "read the two paths" (ID: a1) done.
Result preview: both read
Use Await({ type: "agent", id: "a1" }) to see the full result, or Send({ id: "a1", message }) to continue.

[System] Background agent "empty one" (ID: a2) done.
Result preview: (empty)
Use Await({ type: "agent", id: "a2" }) to see the full result, or Send({ id: "a2", message }) to continue.`,
		);
	});

	it("tasksDone/bash reproduces the inline bash notification formatter", () => {
		// Original used `t.alias ?? t.id` for the ID slot and `t.title || t.id` for the name.
		const body: SideCarBody = {
			kind: "tasksDone",
			flavor: "bash",
			items: [
				{
					id: "b1",
					alias: "run-tests",
					title: "bun test",
					status: "completed",
					preview: "12 pass",
				},
			],
		};
		expect(renderSideCarBodyToText("bg_bash", body, EN)).toBe(
			`[System] Background bash "bun test" (ID: run-tests) completed.
Result preview: 12 pass`,
		);
		// No alias → the id fills the slot.
		expect(
			renderSideCarBodyToText(
				"bg_bash",
				{
					kind: "tasksDone",
					flavor: "bash",
					items: [{ id: "b2", title: "", status: "failed", preview: "" }],
				},
				EN,
			),
		).toBe(`[System] Background bash "b2" (ID: b2) failed.
Result preview: (empty)`);
	});

	it("messages/subagent reproduces formatParentInboundMessages (8-char id fallback)", () => {
		const body: SideCarBody = {
			kind: "messages",
			items: [
				{
					fromId: "abcdefghij0123",
					fromTitle: "explore-sidecar",
					fromType: "explore",
					text: "done",
				},
				// No title → the original used `fromId.slice(0, 8)`.
				{ fromId: "zyxwvutsrq", fromType: "general", text: "also done" },
			],
		};
		expect(renderSideCarBodyToText("subagent_message", body, EN)).toBe(
			`[Progress report from subagent "explore-sidecar" (explore)]:
done

[Progress report from subagent "zyxwvuts" (general)]:
also done`,
		);
		expect(renderSideCarBodyToText("subagent_message", body, ZH)).toContain(
			'[来自子代理"explore-sidecar"（explore）的进展汇报]：',
		);
	});

	it("messages/team reproduces the inline team formatter (FULL id fallback, newline joined)", () => {
		// Two divergences from the subagent shape, both deliberate parity details:
		// the id fallback is NOT truncated, and entries join with a single newline.
		const body: SideCarBody = {
			kind: "messages",
			items: [
				{
					fromId: "full-id-here",
					fromTitle: null,
					fromType: "general",
					isBroadcast: true,
					text: "hi all",
				},
				{ fromId: "x2", fromTitle: "reviewer", fromType: "review", text: "one nit" },
			],
		};
		expect(renderSideCarBodyToText("team_message", body, EN)).toBe(
			"[Team broadcast from full-id-here (general)]: hi all\n" +
				"[Team message from reviewer (review)]: one nit",
		);
	});

	it("specUpdates reproduces formatSpecUpdateSideCars (heading, blank line, blocks)", () => {
		const body: SideCarBody = {
			kind: "specUpdates",
			items: [
				{
					uri: "spec://tasks.json",
					timestamp: "2026-04-01T00:00:00.000Z",
					updatedBy: "user",
					taskSummary: "- [doing] ship it",
				},
				{
					uri: "spec://index.md",
					timestamp: "2026-04-01T00:01:00.000Z",
					updatedBy: "user",
					preview: "some notes",
				},
			],
		};
		expect(renderSideCarBodyToText("spec_update", body, EN)).toBe(
			"[System] The user updated the following spec files via the Spec panel — align your plan accordingly:\n\n" +
				"User updated spec://tasks.json via UI (2026-04-01T00:00:00.000Z).\n" +
				"- [doing] ship it\n\n" +
				"User updated spec://index.md via UI (2026-04-01T00:01:00.000Z).\n" +
				"Content preview:\n" +
				"some notes",
		);
	});
});
// ─────────────────────────────────────────────────────────────────────────────
// Bounded projection
//
// A projection's cost must be proportional to what can ever be PAINTED, not to the
// size of the record. The measure layer caps what it draws, but it only gets to decide
// that after the projection has built its output — so an unbounded projection turns
// one pathological row into a per-measure-pass cost of its full length.
//
// Asserted through `sideCarBodyToMarkdown` (the only public entry point) by counting
// emitted lines: the internal line array is a private staging form, and pinning the
// bound on the public output is what actually protects the caller.
// ─────────────────────────────────────────────────────────────────────────────

/** Non-blank lines of the emitted Markdown, excluding the `######` title row. */
function bodyLineCount(md: string): number {
	return md
		.split("\n")
		.filter((line) => line.trim() !== "")
		.filter((line) => !line.startsWith("###### ")).length;
}

describe("projection is bounded", () => {
	it("caps prose lines instead of emitting one per line of a huge body", () => {
		const text = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n");
		const md = sideCarBodyToMarkdown("buffered_user", { kind: "prose", text });
		expect(bodyLineCount(md)).toBe(SIDECAR_PROJECTION_MAX_LINES);
		// The cap is a prefix, not a sample: the reader sees the start of the body.
		expect(md).toContain("line 0");
		expect(md).not.toContain("line 49999");
	});

	it("caps a raw fallback body the same way", () => {
		// The raw path is deliberately verbatim (no parsing), so its bound is the
		// caller's: nothing is exploded into per-line structure at all.
		const content = Array.from({ length: 10_000 }, () => "x").join("\n");
		expect(rawSideCarToMarkdown(content)).toBe(content);
	});

	it("shares ONE budget across items rather than capping each item separately", () => {
		// The failure this pins: a per-item cap lets N items each contribute the maximum,
		// so the total still scales with N.
		const items = Array.from({ length: 40 }, (_, i) => ({
			id: `t${i}`,
			title: `task ${i}`,
			status: "completed",
			preview: Array.from({ length: 100 }, (_, j) => `out ${j}`).join("\n"),
		}));
		const md = sideCarBodyToMarkdown("bg_agent", { kind: "tasksDone", flavor: "agent", items });
		// Headings can push one line past the budget (a heading is emitted before its
		// prose run is budgeted), which is why this is <= budget + 1 rather than exact.
		expect(bodyLineCount(md)).toBeLessThanOrEqual(SIDECAR_PROJECTION_MAX_LINES + 1);
	});

	it("caps messages, spec updates, tasks and knowledge hits too", () => {
		const longText = Array.from({ length: 500 }, (_, i) => `m ${i}`).join("\n");
		const messages = sideCarBodyToMarkdown("team_message", {
			kind: "messages",
			items: Array.from({ length: 30 }, (_, i) => ({ fromTitle: `u${i}`, text: longText })),
		});
		expect(bodyLineCount(messages)).toBeLessThanOrEqual(SIDECAR_PROJECTION_MAX_LINES + 1);

		const specUpdates = sideCarBodyToMarkdown("spec_update", {
			kind: "specUpdates",
			items: Array.from({ length: 30 }, (_, i) => ({
				uri: `spec://f${i}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				updatedBy: "narrator",
				preview: longText,
			})),
		});
		expect(bodyLineCount(specUpdates)).toBeLessThanOrEqual(SIDECAR_PROJECTION_MAX_LINES + 1);

		const tasks = sideCarBodyToMarkdown("living_work_spec", {
			kind: "tasks",
			variant: "current",
			tasks: Array.from({ length: 5_000 }, (_, i) => ({ role: "todo" as const, text: `t${i}` })),
		});
		expect(bodyLineCount(tasks)).toBe(SIDECAR_PROJECTION_MAX_LINES);

		const knowledge = sideCarBodyToMarkdown("knowledge_base_hint", {
			kind: "knowledge",
			hits: Array.from({ length: 5_000 }, (_, i) => ({
				entryId: `k${i}`,
				title: `hit ${i}`,
				summary: "",
			})),
		});
		expect(bodyLineCount(knowledge)).toBe(SIDECAR_PROJECTION_MAX_LINES);
	});

	it("leaves a normal-sized body completely untouched", () => {
		// The cap must be invisible at real sizes, or it is a behaviour change.
		const md = sideCarBodyToMarkdown("buffered_user", { kind: "prose", text: "a\nb\nc" });
		expect(md.split("\n\n").slice(1)).toEqual(["a", "b", "c"]);
	});
});

describe("headline flattening is bounded", () => {
	it("does not collapse whitespace across a whole megabyte to keep 160 chars", () => {
		// Regression guard for the allocation, not just the output: the old version ran
		// `replace(/\s+/g, " ")` over the entire input first. A 4MB input completing fast
		// (and correctly) is the observable proxy for not materializing it.
		const huge = `${"word ".repeat(800_000)}TAIL`;
		const started = Date.now();
		const md = sideCarBodyToMarkdown("buffered_user", { kind: "prose", text: huge });
		expect(Date.now() - started).toBeLessThan(500);
		const headline = md.split("\n")[0] ?? "";
		expect(headline.startsWith("###### ")).toBe(true);
		// Subtract the `"###### "` prefix (7 chars) to measure the text itself.
		expect(headline.length - 7).toBeLessThanOrEqual(161); // 160 + the ellipsis
		expect(headline.endsWith("…")).toBe(true);
		expect(headline).not.toContain("TAIL");
	});

	it("still flattens and returns short text unchanged", () => {
		const md = sideCarBodyToMarkdown("buffered_user", {
			kind: "prose",
			text: "  hello \n  world  ",
		});
		expect(md.split("\n")[0]).toBe("###### hello world");
	});

	it("ellipsizes exactly when real text survives past the cut", () => {
		// A body just over the flatten window whose tail is only whitespace collapses to
		// something short — and must NOT claim there is more.
		const padded = `${"a".repeat(10)}${" ".repeat(500)}`;
		expect(
			sideCarBodyToMarkdown("buffered_user", { kind: "prose", text: padded }).split("\n")[0],
		).toBe(`###### ${"a".repeat(10)}`);
		// The same length of padding followed by a real character does have more.
		const withTail = `${"a".repeat(10)}${" ".repeat(500)}z`;
		expect(
			sideCarBodyToMarkdown("buffered_user", { kind: "prose", text: withTail }).split("\n")[0],
		).toBe(`###### ${"a".repeat(10)}…`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire coercion
// ─────────────────────────────────────────────────────────────────────────────

describe("coerceSideCarBody / readSideCarBody", () => {
	it("accepts each valid shape", () => {
		expect(coerceSideCarBody({ kind: "notice" })?.kind).toBe("notice");
		expect(coerceSideCarBody({ kind: "prose", text: "x" })?.kind).toBe("prose");
		expect(coerceSideCarBody({ kind: "tasks", variant: "current", tasks: [] })?.kind).toBe("tasks");
		expect(coerceSideCarBody({ kind: "tasks", variant: "emptyNever" })?.kind).toBe("tasks");
		expect(coerceSideCarBody({ kind: "knowledge", hits: [] })?.kind).toBe("knowledge");
		expect(coerceSideCarBody({ kind: "messages", items: [] })?.kind).toBe("messages");
	});

	it("rejects an unknown kind, a wrong-typed collection, and non-objects", () => {
		expect(coerceSideCarBody({ kind: "whatever" })).toBeUndefined();
		expect(coerceSideCarBody({ kind: "messages", items: "nope" })).toBeUndefined();
		expect(coerceSideCarBody({ kind: "prose" })).toBeUndefined();
		expect(coerceSideCarBody(null)).toBeUndefined();
		expect(coerceSideCarBody("string")).toBeUndefined();
		expect(coerceSideCarBody([{ kind: "notice" }])).toBeUndefined();
	});

	it("reads either wire shape: `body` (WS) or `bodyJson` (DB row)", () => {
		expect(readSideCarBody({ body: { kind: "notice" } })?.kind).toBe("notice");
		expect(readSideCarBody({ bodyJson: { kind: "prose", text: "x" } })?.kind).toBe("prose");
		expect(readSideCarBody({ bodyJson: null })).toBeUndefined();
		expect(readSideCarBody({})).toBeUndefined();
	});
});
