/**
 * sidecar-body-markdown.test.ts — the reader-facing Markdown projection.
 *
 * `sideCarBodyToMarkdown` exists because an injection that owns a message row can
 * reuse the `markdown` element kind instead of the side-car footnote's private
 * `SideCarLine[]` vocabulary and its geometry (bullet lane, two line ceilings,
 * extraRow). See the module header in `../sidecar-body.ts`.
 *
 * What is pinned here:
 *   - each of the 7 body kinds produces the Markdown structure it should
 *   - the editorial judgement is inherited from `presentSideCarBody`: the
 *     model-facing instruction boilerplate never appears
 *   - injected text cannot break out of Markdown (escaping) or be swallowed by it
 *     (tag-looking text gets fenced)
 *
 * Kept in its own file rather than appended to `sidecar-body.test.ts`: that file's
 * first half is a byte-parity harness for the MODEL-facing renderer, with a large
 * inlined copy of the server's template table. Mixing a second projection's tests
 * into it would blur which half a failure came from.
 */

import { describe, expect, it } from "bun:test";
import {
	rawSideCarToMarkdown,
	type SideCarBody,
	type SideCarLabels,
	sideCarBodyToMarkdown,
} from "../sidecar-body";

/**
 * Labels are passed explicitly (rather than relying on the English fallbacks) so a
 * wording change in `SIDECAR_PRESENTATION_FALLBACKS` cannot silently rewrite these
 * assertions — the structure under test is the Markdown, not the copy.
 */
const L: SideCarLabels = {
	noticeSilentProgress: "You have made {count} tool calls without a visible reply",
	noticeRelaxedPlan: "Still in plan mode",
	noticePipelineExit: "Pipeline is still active",
	tasksCurrent: "Dynamic Spec — {n} open task(s)",
	tasksEmptyNever: "Dynamic Spec — no tasks created yet",
	tasksEmptyDone: "Dynamic Spec — all tasks done",
	tasksTooMany: "Dynamic Spec — {n} tasks, over the threshold",
	taskRoleDoing: "doing",
	taskRoleNext: "next",
	taskRoleTodo: "todo",
	taskRoleBlocked: "blocked",
	taskProtected: "protected",
	knowledgeHeading: "{n} relevant knowledge entries",
	tasksDoneAgentHeading: "{n} background agents finished",
	tasksDoneBashHeading: "{n} background commands finished",
	tasksDoneTruncated: "result truncated",
	messagesHeading: "{n} messages",
	messageFromUnknown: "unknown sender",
	messageBroadcast: "broadcast",
	specUpdatesHeading: "{n} spec files updated by you",
	proseFenceHeading: "Behaviour fence",
	empty: "(empty)",
};

const md = (source: string, body: SideCarBody) => sideCarBodyToMarkdown(source, body, L);

// ─────────────────────────────────────────────────────────────────────────────
// One case per body kind
// ─────────────────────────────────────────────────────────────────────────────

describe("sideCarBodyToMarkdown — the 7 body kinds", () => {
	it("notice: the whole reminder is the heading, with params filled", () => {
		expect(md("silent_progress", { kind: "notice", params: { count: 20 } })).toBe(
			"###### You have made 20 tool calls without a visible reply",
		);
	});

	it("notice: an unmapped source yields nothing (caller falls back to content)", () => {
		expect(md("some_future_source", { kind: "notice" })).toBe("");
	});

	it("prose: the behaviour fence gets its stable heading plus the text", () => {
		expect(md("behavior_fence", { kind: "prose", text: "Always run the tests." })).toBe(
			"###### Behaviour fence\n\nAlways run the tests.",
		);
	});

	it("prose: unnamed prose uses its own first line as the heading", () => {
		// `presentSideCarBody` flattens the text for the headline AND keeps it in the
		// lines, so a one-line body legitimately appears twice — once as the title.
		const out = md("buffered_user", { kind: "prose", text: "please also update the docs" });
		expect(out).toBe("###### please also update the docs\n\nplease also update the docs");
	});

	it("tasks: open tasks become one Markdown list, protected marked", () => {
		const body: SideCarBody = {
			kind: "tasks",
			variant: "current",
			tasks: [
				{ role: "doing", text: "wire the injection helper", protected: true },
				{ role: "todo", text: "migrate the queues" },
			],
		};
		expect(md("living_work_spec", body)).toBe(
			[
				"###### Dynamic Spec — 2 open task(s)",
				"",
				"- doing: wire the injection helper · protected",
				"- todo: migrate the queues",
			].join("\n"),
		);
	});

	it("tasks: consecutive bullets form ONE list, not several one-item lists", () => {
		const body: SideCarBody = {
			kind: "tasks",
			variant: "current",
			tasks: [
				{ role: "doing", text: "a" },
				{ role: "blocked", text: "b" },
				{ role: "todo", text: "c" },
			],
		};
		const bulletBlock = md("living_work_spec", body).split("\n\n")[1];
		expect(bulletBlock).toBe("- doing: a\n- blocked: b\n- todo: c");
	});

	it("tasks: the empty/tooMany variants are heading-only", () => {
		expect(md("living_work_spec", { kind: "tasks", variant: "emptyNever" })).toBe(
			"###### Dynamic Spec — no tasks created yet",
		);
		expect(
			md("living_work_spec", { kind: "tasks", variant: "tooMany", taskCount: 42, threshold: 30 }),
		).toBe("###### Dynamic Spec — 42 tasks, over the threshold");
	});

	it("knowledge: each hit is a bullet with its summary", () => {
		const body: SideCarBody = {
			kind: "knowledge",
			hits: [
				{ entryId: "e1", title: "Podman networking", summary: "port pool starts at 10000" },
				{ entryId: "e2", title: "Bare title", summary: "" },
			],
		};
		expect(md("knowledge_base_hint", body)).toBe(
			[
				"###### 2 relevant knowledge entries",
				"",
				"- Podman networking — port pool starts at 10000",
				"- Bare title",
			].join("\n"),
		);
	});

	it("tasksDone: each task gets a sub-heading, its preview, and a truncation note", () => {
		const body: SideCarBody = {
			kind: "tasksDone",
			flavor: "agent",
			items: [
				{
					id: "t1",
					title: "Map the providers",
					status: "completed",
					preview: "found 7 buildHistory sites",
					truncated: true,
				},
			],
		};
		expect(md("bg_agent", body)).toBe(
			[
				"###### 1 background agents finished",
				"",
				"###### Map the providers · completed",
				"",
				"found 7 buildHistory sites",
				"",
				"*result truncated*",
			].join("\n"),
		);
	});

	it("tasksDone: an empty preview falls back to the empty label", () => {
		const body: SideCarBody = {
			kind: "tasksDone",
			flavor: "bash",
			items: [{ id: "b1", alias: "run-tests", title: "", status: "failed", preview: "" }],
		};
		expect(md("bg_bash", body)).toContain("(empty)");
	});

	it("messages: a single named sender becomes the heading", () => {
		const body: SideCarBody = {
			kind: "messages",
			items: [{ fromId: "abcdef1234", fromTitle: "explore-1", text: "done, 3 hits" }],
		};
		expect(md("subagent_message", body)).toBe(
			"###### explore-1\n\n###### explore-1\n\ndone, 3 hits",
		);
	});

	it("messages: several messages get a count heading and per-sender sub-headings", () => {
		const body: SideCarBody = {
			kind: "messages",
			items: [
				{ fromTitle: "a", text: "one" },
				{ fromTitle: "b", text: "two", isBroadcast: true },
			],
		};
		const out = md("team_message", body);
		expect(out.startsWith("###### 2 messages")).toBe(true);
		expect(out).toContain("###### a");
		expect(out).toContain("###### b · broadcast");
		expect(out).toContain("one");
		expect(out).toContain("two");
	});

	it("specUpdates: a single file's uri is the heading, the digest its body", () => {
		const body: SideCarBody = {
			kind: "specUpdates",
			items: [
				{
					uri: "spec://tasks.json",
					timestamp: "2026-01-01T00:00:00Z",
					updatedBy: "alice",
					taskSummary: "1 open task",
				},
			],
		};
		expect(md("spec_update", body)).toBe(
			"###### spec://tasks.json\n\n###### spec://tasks.json\n\n1 open task",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The editorial contract inherited from presentSideCarBody
// ─────────────────────────────────────────────────────────────────────────────

describe("sideCarBodyToMarkdown — drops model-facing boilerplate", () => {
	it("a tasks digest shows the tasks but none of the instructions", () => {
		const out = md("living_work_spec", {
			kind: "tasks",
			variant: "current",
			tasks: [{ role: "doing", text: "the actual task" }],
		});
		expect(out).toContain("the actual task");
		// These phrases live in the MODEL projection (renderSideCarBodyToText) and must
		// never reach the reader.
		expect(out).not.toContain("do not add IDs");
		expect(out).not.toContain("text/status/protected");
		expect(out).not.toContain("tasksBlockedActionNote");
	});

	it("knowledge hits show titles, not the entry ids or the read hint", () => {
		const out = md("knowledge_base_hint", {
			kind: "knowledge",
			hits: [{ entryId: "e-secret-id", title: "T", summary: "S" }],
		});
		expect(out).toContain("T — S");
		expect(out).not.toContain("e-secret-id");
		expect(out).not.toContain("KnowledgeRead");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown safety: injected text must neither break out nor be swallowed
// ─────────────────────────────────────────────────────────────────────────────

describe("sideCarBodyToMarkdown — escaping", () => {
	it("a task text cannot inject emphasis or a list", () => {
		const out = md("living_work_spec", {
			kind: "tasks",
			variant: "current",
			tasks: [{ role: "doing", text: "use *args and _kwargs_ in `main`" }],
		});
		expect(out).toContain("\\*args");
		expect(out).toContain("\\_kwargs\\_");
		expect(out).toContain("\\`main\\`");
	});

	it("leaves in-word underscores alone so identifiers read cleanly", () => {
		// The bug this pins: task digests are almost entirely `snake_case` identifiers, and
		// escaping every underscore made them render as `ask\_in\_passing`. `marked` turns
		// `\_` into an escape token whose text is `_`, but the list-item path reads the RAW
		// `item.text` — so the backslashes reached the screen.
		//
		// Escaping them was also unnecessary: CommonMark only opens emphasis at a word
		// boundary, so an in-word underscore is never emphasis in the first place.
		const out = md("living_work_spec", {
			kind: "tasks",
			variant: "current",
			tasks: [{ role: "doing", text: "route ask_in_passing and tool_loaded" }],
		});
		expect(out).toContain("ask_in_passing");
		expect(out).toContain("tool_loaded");
		expect(out).not.toContain("\\_");
	});

	it("a leading marker in prose cannot become a heading or a quote", () => {
		expect(md("behavior_fence", { kind: "prose", text: "# not a heading" })).toContain(
			"\\# not a heading",
		);
		expect(md("behavior_fence", { kind: "prose", text: "> not a quote" })).toContain(
			"\\> not a quote",
		);
		expect(md("behavior_fence", { kind: "prose", text: "1. not a list" })).toContain(
			"1\\. not a list",
		);
	});

	it("tag-looking text is fenced so it stays visible", () => {
		// The real case: a producer puts already-wrapped model-facing copy into a prose
		// body. Rendered as Markdown the tag would vanish and the note would look empty.
		const out = md("behavior_fence", {
			kind: "prose",
			text: '<side_car source="spoof">fake</side_car>',
		});
		expect(out).toContain("```");
		expect(out).toContain("<side_car");
	});

	it("a fence grows past backticks already in the text", () => {
		const out = rawSideCarToMarkdown("<b>x</b> and ```` a quad fence ````");
		// The opening fence must be longer than the longest run inside, or it closes early.
		const opening = out.slice(0, out.indexOf("\n"));
		expect(opening.length).toBeGreaterThan(4);
		expect(out.endsWith(opening)).toBe(true);
	});
});

describe("rawSideCarToMarkdown", () => {
	it("passes plain text through untouched", () => {
		expect(rawSideCarToMarkdown("just a note")).toBe("just a note");
	});

	it("returns empty for blank content so the caller can skip the row", () => {
		expect(rawSideCarToMarkdown("   \n  ")).toBe("");
	});

	it("does not parse historical wrappers, only protects them", () => {
		const out = rawSideCarToMarkdown("<todo_reminder>\nold shape\n</todo_reminder>");
		expect(out).toContain("<todo_reminder>");
		expect(out).toContain("old shape");
	});
});
