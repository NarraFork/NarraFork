/**
 * TutorialProvider behaviour tests.
 *
 * Everything asserted here has a failure mode with NO error signal — the tutorial
 * would still "work", just teach the wrong thing:
 *
 *  - a turn counter read from instance state repeats turn 0 forever (the adapter
 *    is reconstructed on every resolution);
 *  - a missing `onRequestStart` makes the loop treat a scripted turn as a local
 *    preparation path that never contacted an upstream;
 *  - an ignored abort signal makes the interrupt lesson demonstrate a dead button;
 *  - streamed tool-call chunks that do not concatenate into valid JSON leave the
 *    loop parsing `{_raw: ...}` and the tool runs with no arguments.
 */

import { describe, expect, test } from "bun:test";
import {
	TUTORIAL_LESSON_BOUNDARY_BLOCK,
	TUTORIAL_MODEL,
	TUTORIAL_PROVIDER_PREFIX,
} from "@shared/tutorial/lessons";
import type { ChatParams, ParsedStreamEvent } from "../provider";
import {
	type DEFAULT_TUTORIAL_PACING,
	parseTutorialModel,
	scriptTurnIndex,
	TutorialProvider,
	toolInputChunks,
	tutorialModelForLesson,
	tutorialModelForSubagent,
} from "../tutorial-provider";

const LESSON = "first-turn";

/**
 * A provider with the sleeps removed.
 *
 * Pacing is a teaching choice, not a correctness property, and these tests assert
 * on ordering and content. Paying real wall-clock seconds for that is how a suite
 * stops being run.
 */
function fastProvider(overrides: Partial<typeof DEFAULT_TUTORIAL_PACING> = {}) {
	return new TutorialProvider({ frameIntervalMs: 0, channelGapMs: 0, ...overrides });
}

function chatParams(overrides: Partial<ChatParams> = {}): ChatParams {
	return {
		conversationId: "conv-1",
		content: "hello",
		model: tutorialModelForLesson(LESSON, "en"),
		cwd: "/tmp/tutorial",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		...overrides,
	} as ChatParams;
}

async function collect(gen: AsyncGenerator<ParsedStreamEvent>): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	for await (const event of gen) events.push(event);
	return events;
}

function textOf(events: ParsedStreamEvent[]): string {
	return events.map((e) => e.text ?? "").join("");
}

function reasoningOf(events: ParsedStreamEvent[]): string {
	return events.map((e) => e.reasoning ?? "").join("");
}

describe("parseTutorialModel", () => {
	test("extracts lesson and locale from the model value", () => {
		expect(parseTutorialModel("tutorial:guide/first-turn/zh-CN")).toEqual({
			lessonId: "first-turn",
			locale: "zh-CN",
		});
	});

	test("a bare tutorial model is valid and carries neither", () => {
		// Legacy / malformed values must degrade to the no-script line rather than
		// throwing, otherwise a narrator whose lesson was removed becomes unusable.
		expect(parseTutorialModel(TUTORIAL_MODEL)).toEqual({});
	});

	test("tolerates a lesson without a locale", () => {
		expect(parseTutorialModel("tutorial:guide/first-turn")).toEqual({ lessonId: "first-turn" });
	});

	test("round-trips tutorialModelForLesson", () => {
		const model = tutorialModelForLesson("some-lesson", "zh-CN");
		expect(model.startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`)).toBe(true);
		expect(parseTutorialModel(model)).toEqual({ lessonId: "some-lesson", locale: "zh-CN" });
	});
});

describe("scriptTurnIndex", () => {
	test("an empty history plays turn 0", () => {
		expect(scriptTurnIndex([])).toBe(0);
	});

	test("the injected system-prompt ack does not consume a turn", () => {
		// injectSystemPrompt prepends user+assistant. Counting the ack would push the
		// very first real request to turn 1, silently skipping the lesson's opener.
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		provider.injectSystemPrompt(history, "You are a tutorial narrator.", TUTORIAL_MODEL);
		expect(scriptTurnIndex(history)).toBe(0);
	});

	test("each assistant turn advances the script", () => {
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		provider.injectSystemPrompt(history, "sys", TUTORIAL_MODEL);
		provider.pushUserTurn(history, "hi", TUTORIAL_MODEL, []);
		provider.pushAssistantTurn(history, "first answer", []);
		expect(scriptTurnIndex(history)).toBe(1);
		provider.pushUserTurn(history, "again", TUTORIAL_MODEL, []);
		provider.pushAssistantTurn(history, "second answer", []);
		expect(scriptTurnIndex(history)).toBe(2);
	});

	test("an empty assistant turn still counts", () => {
		// A turn that produced nothing must not rewind the script — otherwise the
		// same lines replay and the lesson appears stuck.
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		provider.pushAssistantTurn(history, "", []);
		expect(scriptTurnIndex(history)).toBe(1);
	});

	test("a lesson boundary restarts the count at 0", () => {
		// The whole reason the boundary exists. One tutorial narrator spans every
		// lesson, so without this a lesson opened after a few others would report a
		// double-digit index and play its `fallbackTurn` ("this script is finished")
		// with nothing to indicate why.
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		provider.injectSystemPrompt(history, "sys", TUTORIAL_MODEL);
		for (let i = 0; i < 6; i++) {
			provider.pushUserTurn(history, `msg ${i}`, TUTORIAL_MODEL, []);
			provider.pushAssistantTurn(history, `answer ${i}`, []);
		}
		expect(scriptTurnIndex(history)).toBe(6);

		history.push({
			role: "user",
			content: [{ type: "lesson_boundary", lessonId: "permissions" }],
		});
		expect(scriptTurnIndex(history)).toBe(0);
	});

	test("turns after a boundary advance from that boundary", () => {
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		provider.pushAssistantTurn(history, "old lesson", []);
		history.push({ role: "user", content: [{ type: "lesson_boundary" }] });
		provider.pushUserTurn(history, "hi", TUTORIAL_MODEL, []);
		provider.pushAssistantTurn(history, "new lesson turn 0", []);
		expect(scriptTurnIndex(history)).toBe(1);
	});

	test("the LAST boundary wins", () => {
		// Every lesson start writes one, so a session that has run several holds
		// several. Counting from the first would make the newest lesson resume at the
		// accumulated index — the exact failure the boundary was added to remove.
		const provider = new TutorialProvider();
		const history: unknown[] = [];
		history.push({ role: "user", content: [{ type: "lesson_boundary", lessonId: "a" }] });
		provider.pushAssistantTurn(history, "a-0", []);
		provider.pushAssistantTurn(history, "a-1", []);
		history.push({ role: "user", content: [{ type: "lesson_boundary", lessonId: "b" }] });
		expect(scriptTurnIndex(history)).toBe(0);
	});
});

describe("TutorialProvider.buildHistory", () => {
	test("derives the turn count from persisted rows", async () => {
		// The provider is constructed fresh per resolution, so position has to come
		// from the database rows the loop replays — not from instance state.
		const provider = new TutorialProvider();
		const rows: DbMessage[] = [
			{
				id: "m1",
				role: "user",
				contentJson: [{ type: "text", text: "hello" }],
				contentText: "hello",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "m2",
				role: "assistant",
				contentJson: [{ type: "text", text: "answer one" }],
				contentText: "answer one",
				parentToolUseId: null,
				messageUuid: null,
			},
		];
		const { history } = await provider.buildHistory(rows, TUTORIAL_MODEL);
		expect(scriptTurnIndex(history)).toBe(1);
	});

	test("tool results become trailing results, not a new turn", async () => {
		const provider = new TutorialProvider();
		const rows: DbMessage[] = [
			{
				id: "m1",
				role: "assistant",
				contentJson: [
					{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } },
				],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [
					{
						toolUseId: "t1",
						toolName: "Read",
						inputJson: { file_path: "src/a.ts" },
						outputJson: "file contents",
						status: "success",
					},
				],
			},
		];
		const { history, trailingToolResults } = await provider.buildHistory(rows, TUTORIAL_MODEL);
		expect(scriptTurnIndex(history)).toBe(1);
		expect(trailingToolResults).toHaveLength(1);
		expect(trailingToolResults[0]).toMatchObject({ tool_use_id: "t1", content: "file contents" });
	});

	test("a failed tool call is marked as an error result", async () => {
		const provider = new TutorialProvider();
		const rows: DbMessage[] = [
			{
				id: "m1",
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [
					{
						toolUseId: "t1",
						toolName: "Bash",
						inputJson: { command: "false" },
						outputJson: "exit 1",
						status: "fail",
					},
				],
			},
		];
		const { trailingToolResults } = await provider.buildHistory(rows, TUTORIAL_MODEL);
		expect(trailingToolResults[0]).toMatchObject({ is_error: true });
	});

	test("a persisted lesson boundary row restarts the turn count", async () => {
		// End-to-end for the reuse: the boundary is written as a `sys` row by
		// `tutorial-service`, and it only works if `buildHistory` carries it through to
		// the history the turn counter reads. Dropping it here is invisible — the
		// lesson simply answers that its script is already finished.
		const provider = new TutorialProvider();
		const rows: DbMessage[] = [
			{
				id: "m1",
				role: "user",
				contentJson: [{ type: "text", text: "earlier lesson" }],
				contentText: "earlier lesson",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "m2",
				role: "assistant",
				contentJson: [{ type: "text", text: "earlier answer" }],
				contentText: "earlier answer",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "m3",
				role: "sys",
				contentJson: [
					{ type: "text", text: "A new tutorial lesson starts here." },
					{ type: TUTORIAL_LESSON_BOUNDARY_BLOCK, lessonId: "permissions" },
				],
				contentText: "A new tutorial lesson starts here.",
				parentToolUseId: null,
				messageUuid: null,
			},
		];
		const { history } = await provider.buildHistory(rows, TUTORIAL_MODEL);
		expect(scriptTurnIndex(history)).toBe(0);
	});

	test("a boundary row with no text still marks the boundary", async () => {
		// `deliverInjection` refuses empty content today, so this row shape should not
		// occur — but the boundary must not depend on text surviving, because losing it
		// silently rewinds the lesson to its fallback line.
		const provider = new TutorialProvider();
		const rows: DbMessage[] = [
			{
				id: "m1",
				role: "assistant",
				contentJson: [{ type: "text", text: "earlier answer" }],
				contentText: "earlier answer",
				parentToolUseId: null,
				messageUuid: null,
			},
			{
				id: "m2",
				role: "sys",
				contentJson: [{ type: TUTORIAL_LESSON_BOUNDARY_BLOCK, lessonId: "permissions" }],
				contentText: null,
				parentToolUseId: null,
				messageUuid: null,
			},
		];
		const { history } = await provider.buildHistory(rows, TUTORIAL_MODEL);
		expect(scriptTurnIndex(history)).toBe(0);
	});
});

describe("TutorialProvider.chat", () => {
	test("announces the request start", async () => {
		// The loop uses this marker to tell a real empty upstream response apart from
		// a local path that finished without contacting anything. Skipping it makes a
		// scripted turn indistinguishable from the latter.
		let started = false;
		await collect(
			fastProvider().chat(
				chatParams({
					onRequestStart: () => {
						started = true;
					},
				}),
			),
		);
		expect(started).toBe(true);
	});

	test("plays the scripted first turn: reasoning then text", async () => {
		const events = await collect(fastProvider().chat(chatParams()));
		expect(reasoningOf(events).length).toBeGreaterThan(0);
		expect(textOf(events)).toContain("Reasoning");
		// A text-only turn must report end_turn, not tool_use — the loop keys the
		// tool-execution phase off this.
		expect(events.at(-1)?.stopReason).toBe("end_turn");
	});

	test("locale in the model value selects the script language", async () => {
		const events = await collect(
			fastProvider().chat(chatParams({ model: tutorialModelForLesson(LESSON, "zh-CN") })),
		);
		expect(textOf(events)).toContain("推理");
	});

	test("an unknown lesson answers instead of throwing", async () => {
		const events = await collect(
			fastProvider().chat(chatParams({ model: tutorialModelForLesson("no-such-lesson", "en") })),
		);
		expect(textOf(events).length).toBeGreaterThan(0);
	});

	test("running past the script falls back rather than dead-ending", async () => {
		const provider = fastProvider();
		const history: unknown[] = [];
		// Well past the single scripted turn of this lesson.
		for (let i = 0; i < 5; i++) provider.pushAssistantTurn(history, `turn ${i}`, []);
		const events = await collect(provider.chat(chatParams({ history })));
		expect(textOf(events).length).toBeGreaterThan(0);
	});

	test("an already-aborted signal yields nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const events = await collect(fastProvider().chat(chatParams({ signal: controller.signal })));
		// onRequestStart may already have fired, but no content may be emitted.
		expect(textOf(events)).toBe("");
		expect(reasoningOf(events)).toBe("");
	});

	test("aborting mid-stream stops emission", async () => {
		// "Interrupt a running turn" is a lesson. If the generator ignored the signal
		// the interrupt button would appear to do nothing.
		const controller = new AbortController();
		const stream = fastProvider().chat(chatParams({ signal: controller.signal }));
		const collected: ParsedStreamEvent[] = [];
		let frames = 0;
		for await (const event of stream) {
			collected.push(event);
			if (++frames === 3) controller.abort();
			if (frames > 400) throw new Error("stream did not stop after abort");
		}
		expect(frames).toBeLessThan(400);
		const full = reasoningOf(collected) + textOf(collected);
		// Some content arrived (the first frames), but not the whole scripted turn.
		expect(full.length).toBeGreaterThan(0);
		expect(collected.at(-1)?.stopReason).toBeUndefined();
	});
});

describe("subagent script branching", () => {
	const SUBAGENT_LESSON = "subagent-types";

	test("a subagent model plays its own type's turns, not the parent's", async () => {
		// The parent turns spawn subagents. A subagent replaying them would spawn more,
		// and nested subagents are rejected — so the lesson would end in an error card.
		const parent = await collect(
			fastProvider().chat(chatParams({ model: tutorialModelForLesson(SUBAGENT_LESSON, "en") })),
		);
		const child = await collect(
			fastProvider().chat(
				chatParams({ model: tutorialModelForSubagent(SUBAGENT_LESSON, "en", "explore") }),
			),
		);

		const parentTools = (parent.find((e) => e.toolUses)?.toolUses ?? []).map((t) => t.name);
		const childTools = (child.find((e) => e.toolUses)?.toolUses ?? []).map((t) => t.name);
		expect(parentTools).toContain("Agent");
		expect(childTools).not.toContain("Agent");
		expect(childTools.length).toBeGreaterThan(0);
	});

	test("the subagent type is parsed out of the model value", () => {
		expect(
			parseTutorialModel(tutorialModelForSubagent(SUBAGENT_LESSON, "zh-CN", "general")),
		).toEqual({ lessonId: SUBAGENT_LESSON, locale: "zh-CN", subagentType: "general" });
	});

	test("a primary model carries no subagent type", () => {
		// If it did, the parent narrator would play a subagent script and never
		// delegate — the lesson's whole subject would silently disappear.
		expect(parseTutorialModel(tutorialModelForLesson(SUBAGENT_LESSON, "en")).subagentType).toBe(
			undefined,
		);
	});

	test("an unmapped subagent type answers with the fallback rather than nothing", async () => {
		// Falling through to the parent's turns would spawn a nested subagent; emitting
		// nothing would surface as an empty-response error. A canned line is the only
		// harmless option.
		const events = await collect(
			fastProvider().chat(
				chatParams({ model: tutorialModelForSubagent(SUBAGENT_LESSON, "en", "no-such-type") }),
			),
		);
		expect(textOf(events).length).toBeGreaterThan(0);
		expect(events.some((e) => e.toolUses)).toBe(false);
	});

	test("a subagent past its scripted turns falls back rather than looping", async () => {
		const provider = fastProvider();
		const history: unknown[] = [];
		for (let i = 0; i < 6; i++) provider.pushAssistantTurn(history, `turn ${i}`, []);
		const events = await collect(
			provider.chat(
				chatParams({
					model: tutorialModelForSubagent(SUBAGENT_LESSON, "en", "explore"),
					history,
				}),
			),
		);
		expect(textOf(events).length).toBeGreaterThan(0);
	});
});

describe("toolInputChunks", () => {
	// The loop runs `extractJsonFields` on the running concatenation and
	// `JSON.parse` on the whole thing at `stop`. If the fragments do not reassemble
	// into exactly `JSON.stringify(input)`, the parse falls back to `{_raw: ...}`
	// and the tool executes with no arguments — no error, just a nonsensical call.
	const cases: Array<{ label: string; input: Record<string, unknown> }> = [
		{ label: "empty object", input: {} },
		{ label: "single short field", input: { file_path: "src/a.ts" } },
		{
			label: "multi-field with an ordered pair",
			input: { file_path: "src/a.ts", old_string: "before", new_string: "after" },
		},
		{
			label: "CJK and escapes",
			input: { command: "echo \"教程\" && printf 'a\\nb'" },
		},
		{ label: "nested and non-string values", input: { limit: 20, nested: { a: [1, 2, null] } } },
	];

	for (const { label, input } of cases) {
		for (const frames of [1, 3, 6, 500]) {
			test(`${label} reassembles exactly at ${frames} frame(s)`, () => {
				const chunks = toolInputChunks(input, frames);
				expect(chunks.join("")).toBe(JSON.stringify(input));
				expect(JSON.parse(chunks.join("") || "{}")).toEqual(input);
			});
		}
	}

	test("a frame count below 1 still produces usable chunks", () => {
		// Guards a pacing value of 0 reaching this from settings/tests: dividing by a
		// zero frame count would yield an empty chunk list and an unparseable input.
		const input = { file_path: "src/a.ts" };
		expect(toolInputChunks(input, 0).join("")).toBe(JSON.stringify(input));
	});
});

describe("TutorialProvider tool-call streaming", () => {
	test("a scripted tool call streams its name before its arguments", async () => {
		// Card labelling depends on the name arriving in the first chunk: the loop
		// only creates an accumulator once it sees a chunk WITH a name
		// (`if (!toolUseAccum.has(id) && name)`), so a nameless first chunk is
		// dropped and its argument bytes are lost.
		const chunks = toolInputChunks({ file_path: "src/a.ts" }, 3);
		expect(chunks.length).toBeGreaterThan(1);
	});
});
