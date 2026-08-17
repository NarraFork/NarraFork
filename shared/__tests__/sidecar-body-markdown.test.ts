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
	verbatimOutputToMarkdown,
} from "../sidecar-body";

/**
 * Labels are passed explicitly (rather than relying on the English fallbacks) so a
 * wording change in `SIDECAR_PRESENTATION_FALLBACKS` cannot silently rewrite these
 * assertions — the structure under test is the Markdown, not the copy.
 */
const L: SideCarLabels = {
	noticeSilentProgress: "You have made {count} tool calls without a visible reply",
	noticeRelaxedPlan: "Still in plan mode — write to {planFile}",
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

	it("notice: relaxed_plan names the plan file, and a legacy row still reads sensibly", () => {
		expect(
			md("relaxed_plan", { kind: "notice", params: { planFile: ".narrafork/plans/plan-a.md" } }),
		).toBe("###### Still in plan mode — write to .narrafork/plans/plan-a.md");
		// Rows written before the param existed must not paint a literal placeholder.
		expect(md("relaxed_plan", { kind: "notice" })).toBe(
			"###### Still in plan mode — write to .narrafork/plans/",
		);
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
		const out = md("bg_bash", body);
		expect(out).toContain("(empty)");
		// The placeholder is a localized SENTENCE, so it stays prose — fencing it would
		// dress the UI's own copy up as command output.
		expect(out).not.toContain("```");
	});

	it("tasksDone: a bash preview is fenced whole, keeping its column alignment", () => {
		// Verbatim `bunx @biomejs/biome check` output. Line-by-line prose escaping keeps
		// the characters but not the layout: the two-space-indented excerpt below the `!`
		// diagnostic became its own indented-code block, so one message rendered as a
		// paragraph plus an unrelated code card with the `│` gutter knocked out of line.
		const preview = [
			"! This variable measureWebSearch is unused.",
			"",
			'  55 │   it("reserves an extra loader lane", async () => {',
			"  56 │     const { measureWebSearch } = …",
		].join("\n");
		const out = md("bg_bash", {
			kind: "tasksDone",
			flavor: "bash",
			items: [{ id: "b1", alias: "run-biome", title: "biome", status: "success", preview }],
		});
		// One fenced block holding the output byte-for-byte, indentation included.
		expect(out).toContain(`\`\`\`\n${preview}\n\`\`\``);
		// And no escaping leaked into it (the prose path would have written `\!`).
		expect(out).not.toContain("\\!");
	});

	it("tasksDone: an agent preview stays prose, since a subagent writes Markdown", () => {
		const out = md("bg_agent", {
			kind: "tasksDone",
			flavor: "agent",
			items: [{ id: "t1", title: "explore", status: "success", preview: "found the caller" }],
		});
		expect(out).toContain("found the caller");
		expect(out).not.toContain("```");
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

	it("specUpdates: a single file's uri is the heading, and is NOT repeated in the body", () => {
		// The regression this pins: the loop pushed a per-item heading unconditionally, so
		// a single-file update printed `spec://tasks.json` twice — once as the headline and
		// again as the first body line.
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
		expect(md("spec_update", body)).toBe("###### spec://tasks.json\n\n1 open task");
	});

	it("specUpdates: SEVERAL files keep per-item headings to tell them apart", () => {
		const body: SideCarBody = {
			kind: "specUpdates",
			items: [
				{ uri: "spec://tasks.json", timestamp: "t", updatedBy: "alice", taskSummary: "2 open" },
				{ uri: "spec://index.md", timestamp: "t", updatedBy: "alice", taskSummary: "notes" },
			],
		};
		const out = md("spec_update", body);
		expect(out).toContain("spec://tasks.json");
		expect(out).toContain("spec://index.md");
		expect(out).toContain("2 open");
		expect(out).toContain("notes");
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
		// The one instruction line the MODEL projection still emits
		// (`tasksCurrentUpdateNote`) must not reach the reader either. The heavier rules
		// it used to sit beside now live only in the system prompt.
		expect(out).not.toContain("Update spec://tasks.json");
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

	it("a knowledge summary holding raw Markdown is reduced to prose", () => {
		// The regression: `summary` is a FLATTENED slice of the entry body, so a row
		// written before the server stripped it holds `# Title > quoted …` on one line.
		// Rendered as Markdown that becomes one display-size heading swallowing the whole
		// excerpt — and the title it repeats is already this bullet's own label.
		const out = md("knowledge_base_hint", {
			kind: "knowledge",
			hits: [
				{
					entryId: "e1",
					title: "Podman networking",
					summary: "# Podman networking > the port pool starts at `10000`",
				},
			],
		});
		expect(out).toContain("- Podman networking — the port pool starts at 10000");
		// No heading marker survives inside the bullet (the `######` headline is its own
		// block, which is why the assertion targets the bullet line).
		const bullet = out.split("\n").find((line) => line.startsWith("- ")) ?? "";
		expect(bullet).not.toContain("#");
		expect(bullet).not.toContain(">");
		expect(bullet).not.toContain("`");
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

// ─────────────────────────────────────────────────────────────────────────────
// verbatimOutputToMarkdown — machine output is preformatted, never prose
//
// The counterpart to `rawSideCarToMarkdown`: that one only fences text that looks
// like a TAG, which is the wrong default for a command's stdout. This one fences
// unconditionally, because a linter's alignment is the content.
// ─────────────────────────────────────────────────────────────────────────────

describe("verbatimOutputToMarkdown", () => {
	it("fences plain output that carries no Markdown-looking characters", () => {
		// Even innocuous output is fenced: the point is that the projection does not
		// SNIFF, so a later line full of pipes cannot change how the earlier ones render.
		const out = verbatimOutputToMarkdown("ok");
		expect(out).toBe("```\nok\n```");
	});

	it("keeps real linter output intact instead of splitting it into prose and a code card", () => {
		// Verbatim shape of `bunx @biomejs/biome check` output. Under the prose path the
		// `!` line rendered as a paragraph and the two-space-indented excerpt below it
		// became a separate INDENTED CODE block — one diagnostic drawn as two unrelated
		// things, with the `│` gutter alignment broken.
		const output = [
			"! This variable measureWebSearch is unused.",
			"",
			'  55 │   it("reserves an extra loader lane", async () => {',
			"  56 │     const { measureWebSearch, webSearchChromeL…",
		].join("\n");
		const out = verbatimOutputToMarkdown(output);
		expect(out.startsWith("```\n")).toBe(true);
		expect(out.endsWith("\n```")).toBe(true);
		// The body survives byte-for-byte: no escaping, no re-indentation, gutter kept.
		expect(out.slice(4, -4)).toBe(output);
	});

	it("grows the fence past backtick runs in the output so it cannot close early", () => {
		// Test runners print fenced snippets of the source they failed on, so a triple
		// backtick inside the output is ordinary, not adversarial.
		const out = verbatimOutputToMarkdown("before\n```\ninner fence\n```\nafter");
		const opening = out.slice(0, out.indexOf("\n"));
		expect(opening.length).toBeGreaterThan(3);
		expect(out.endsWith(opening)).toBe(true);
		expect(out).toContain("inner fence");
	});

	it("returns empty for blank output so the caller can word its own placeholder", () => {
		// An empty fence would be a hollow card; the caller substitutes a localized
		// "(empty)" sentence instead, which is prose and not machine output.
		expect(verbatimOutputToMarkdown("   \n\t\n")).toBe("");
	});
});
