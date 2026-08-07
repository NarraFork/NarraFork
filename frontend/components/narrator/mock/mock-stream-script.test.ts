/**
 * mock-stream-script.test.ts — Locks what makes the harness TRUSTWORTHY as a
 * measurement tool.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Four groups of properties:
 *
 *   1. Frame SHAPE matches the server wire format. In particular the asymmetry
 *      that a text delta carries `outputIndex` on the EVENT while a reasoning
 *      delta carries it on the DELTA — get that wrong and the consumer silently
 *      merges lanes, so the harness renders a layout the real path never produces.
 *      Also: `tool_completed.output` must be a plain STRING, because the shared
 *      classifier JSON-dumps anything else and the card would show structure
 *      instead of content.
 *   2. Content INTEGRITY — chunking partitions each body exactly, so no character
 *      is dropped or duplicated. A harness that loses text makes every
 *      predicted-vs-actual height delta meaningless.
 *   3. The MULTI-ROUND structure: reasoning → text → tools, repeated, with each
 *      round opening fresh output lanes (what a real provider does after a tool
 *      result).
 *   4. Corpus COVERAGE — the markdown body actually contains every element the
 *      layout pipeline has a distinct code path for. This is the guard against
 *      someone trimming the corpus and quietly losing coverage of, say, mermaid.
 *
 * Pure logic; no DOM, no timers, no WebSocket.
 */

import { describe, expect, it } from "bun:test";
import { MOCK_ROUND_COUNT, REASONING_ROUNDS, TEXT_ROUNDS, TOOL_ROUNDS } from "./mock-stream-corpus";
import {
	buildMockScript,
	chunkText,
	DEFAULT_MOCK_SCENARIO,
	type MockScenario,
	type MockStep,
	totalScriptChars,
} from "./mock-stream-script";

function scenario(overrides: Partial<MockScenario> = {}): MockScenario {
	return { ...DEFAULT_MOCK_SCENARIO, narratorId: "narr_test", ...overrides };
}

/**
 * Read a step by index, failing loudly instead of asserting non-null.
 *
 * A missing step means the expansion produced a different shape than the test
 * assumes, and a named error says so far more clearly than a downstream
 * `undefined` property read.
 */
function stepAt(steps: readonly MockStep[], index: number): MockStep {
	const step = steps.at(index);
	if (!step) throw new Error(`expected a step at index ${index}, got ${steps.length} steps`);
	return step;
}

/** Concatenate the visible text a set of steps delivers, in order. */
function deliveredText(
	steps: readonly MockStep[],
	kind: "text" | "reasoning",
	round?: number,
): string {
	let out = "";
	for (const step of steps) {
		if (step.kind !== kind) continue;
		if (round != null && step.round !== round) continue;
		const event = step.frame.event as { delta?: { text?: unknown } };
		const text = event?.delta?.text;
		if (typeof text === "string") out += text;
	}
	return out;
}

/** All frames belonging to one tool-use id, in emission order. */
function framesForTool(steps: readonly MockStep[], toolUseId: string): MockStep[] {
	return steps.filter((step) => step.frame.toolUseId === toolUseId);
}

describe("chunkText", () => {
	it("partitions exhaustively and in order", () => {
		const source = "abcdefghij";
		const chunks = chunkText(source, 3);
		expect(chunks).toEqual(["abc", "def", "ghi", "j"]);
		expect(chunks.join("")).toBe(source);
	});

	it("returns no chunks for empty input", () => {
		expect(chunkText("", 10)).toEqual([]);
	});

	it("never produces empty chunks even for a zero/negative size", () => {
		const chunks = chunkText("abc", 0);
		expect(chunks.join("")).toBe("abc");
		expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
	});
});

describe("frame shapes", () => {
	it("puts outputIndex on the EVENT for text deltas", () => {
		const steps = buildMockScript(
			scenario({ reasoning: false, tools: false, rounds: 1, charsPerFrame: 100_000 }),
		);
		expect(steps).toHaveLength(1);
		const frame = stepAt(steps, 0).frame;
		expect(frame.type).toBe("stream_event");
		const event = frame.event as Record<string, unknown>;
		expect(event.type).toBe("content_block_delta");
		// The lane index lives on the event for text…
		expect(typeof event.outputIndex).toBe("number");
		const delta = event.delta as Record<string, unknown>;
		expect(delta.type).toBe("text_delta");
		// …and NOT on the delta.
		expect(delta.outputIndex).toBeUndefined();
	});

	it("puts outputIndex and id on the DELTA for reasoning deltas", () => {
		const steps = buildMockScript(
			scenario({ text: false, tools: false, rounds: 1, charsPerFrame: 100_000 }),
		);
		expect(steps).toHaveLength(1);
		const event = stepAt(steps, 0).frame.event as Record<string, unknown>;
		// The lane index is NOT on the event for reasoning…
		expect(event.outputIndex).toBeUndefined();
		const delta = event.delta as Record<string, unknown>;
		expect(delta.type).toBe("reasoning_delta");
		// …it is on the delta, together with the reasoning id.
		expect(typeof delta.outputIndex).toBe("number");
		expect(typeof delta.id).toBe("string");
	});

	it("sends tool_completed.output as a plain string, never a block array", () => {
		const steps = buildMockScript(scenario({ reasoning: false, text: false }));
		const completed = steps.filter((step) => step.kind === "tool-completed");
		expect(completed.length).toBeGreaterThan(0);
		for (const step of completed) {
			// An array/object here would be JSON-dumped by resolveDisplayText and the
			// card would render structure instead of the body.
			expect(typeof step.frame.output).toBe("string");
		}
	});

	it("stamps every frame with the target narrator id", () => {
		const steps = buildMockScript(scenario({ narratorId: "narr_abc" }));
		expect(steps.length).toBeGreaterThan(0);
		for (const step of steps) {
			expect(step.frame.narratorId).toBe("narr_abc");
		}
	});
});

describe("multi-round structure", () => {
	it("replays every fixed round by default", () => {
		const steps = buildMockScript(scenario());
		const rounds = new Set(steps.map((step) => step.round));
		expect(rounds.size).toBe(MOCK_ROUND_COUNT);
		expect([...rounds].sort((a, b) => a - b)).toEqual(
			Array.from({ length: MOCK_ROUND_COUNT }, (_, i) => i + 1),
		);
	});

	it("emits rounds contiguously and in ascending order", () => {
		const steps = buildMockScript(scenario());
		const roundSequence = steps.map((step) => step.round);
		// Non-decreasing ⇒ each round's frames form one contiguous block.
		for (let i = 1; i < roundSequence.length; i++) {
			expect(roundSequence[i]).toBeGreaterThanOrEqual(Number(roundSequence[i - 1]));
		}
	});

	it("orders each round as reasoning → text → tools", () => {
		const steps = buildMockScript(scenario({ rounds: 2 }));
		for (const round of [1, 2]) {
			const kinds = steps.filter((step) => step.round === round).map((step) => step.kind);
			const lastReasoning = kinds.lastIndexOf("reasoning");
			const firstText = kinds.indexOf("text");
			const lastText = kinds.lastIndexOf("text");
			const firstTool = kinds.findIndex((kind) => kind.startsWith("tool-"));
			expect(lastReasoning).toBeGreaterThan(-1);
			expect(firstText).toBeGreaterThan(lastReasoning);
			expect(firstTool).toBeGreaterThan(lastText);
		}
	});

	it("puts reasoning AFTER a settled tool call across the round boundary", () => {
		// The whole point of the multi-round shape: round 2 thinks again once
		// round 1's tools have completed.
		const steps = buildMockScript(scenario({ rounds: 2 }));
		const lastRound1Tool = steps.findLastIndex(
			(step) => step.round === 1 && step.kind === "tool-completed",
		);
		const firstRound2Reasoning = steps.findIndex(
			(step) => step.round === 2 && step.kind === "reasoning",
		);
		expect(lastRound1Tool).toBeGreaterThan(-1);
		expect(firstRound2Reasoning).toBeGreaterThan(lastRound1Tool);
	});

	it("opens a fresh output lane per round rather than reopening the previous one", () => {
		const steps = buildMockScript(scenario({ rounds: 3 }));
		const laneOf = (step: MockStep): number => {
			const event = step.frame.event as {
				outputIndex?: number;
				delta?: { outputIndex?: number };
			};
			return event.outputIndex ?? event.delta?.outputIndex ?? -1;
		};
		const lanes = new Set<number>();
		for (const step of steps) {
			if (step.kind === "text" || step.kind === "reasoning") lanes.add(laneOf(step));
		}
		// 3 rounds × (reasoning + text) = 6 distinct lanes.
		expect(lanes.size).toBe(6);
		expect([...lanes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("honours a reduced round count and clamps an excessive one", () => {
		expect(new Set(buildMockScript(scenario({ rounds: 1 })).map((s) => s.round)).size).toBe(1);
		const clamped = buildMockScript(scenario({ rounds: MOCK_ROUND_COUNT + 10 }));
		expect(new Set(clamped.map((s) => s.round)).size).toBe(MOCK_ROUND_COUNT);
	});

	it("omits a channel entirely when it is switched off", () => {
		expect(buildMockScript(scenario({ text: false })).some((step) => step.kind === "text")).toBe(
			false,
		);
		expect(
			buildMockScript(scenario({ reasoning: false })).some((step) => step.kind === "reasoning"),
		).toBe(false);
		expect(
			buildMockScript(scenario({ tools: false })).some((step) => step.kind.startsWith("tool-")),
		).toBe(false);
	});
});

describe("content integrity", () => {
	it("delivers each round's corpus verbatim", () => {
		const steps = buildMockScript(scenario({ tools: false, charsPerFrame: 13 }));
		for (let index = 0; index < MOCK_ROUND_COUNT; index++) {
			const round = index + 1;
			expect(deliveredText(steps, "reasoning", round)).toBe(String(REASONING_ROUNDS[index]));
			expect(deliveredText(steps, "text", round)).toBe(String(TEXT_ROUNDS[index]));
		}
	});

	it("is independent of the chunk size", () => {
		const fine = buildMockScript(scenario({ tools: false, charsPerFrame: 3 }));
		const coarse = buildMockScript(scenario({ tools: false, charsPerFrame: 997 }));
		expect(deliveredText(fine, "text")).toBe(deliveredText(coarse, "text"));
		expect(deliveredText(fine, "reasoning")).toBe(deliveredText(coarse, "reasoning"));
	});

	it("repeats the text body when asked, keeping the original as a prefix", () => {
		const once = deliveredText(buildMockScript(scenario({ tools: false, rounds: 1 })), "text");
		const thrice = deliveredText(
			buildMockScript(scenario({ tools: false, rounds: 1, textRepeat: 3 })),
			"text",
		);
		expect(thrice.startsWith(once)).toBe(true);
		expect(thrice.length).toBeGreaterThan(once.length * 2);
	});

	it("reports the total visible characters a script will deliver", () => {
		const steps = buildMockScript(scenario({ tools: false, rounds: 1 }));
		const expected = String(REASONING_ROUNDS[0]).length + String(TEXT_ROUNDS[0]).length;
		expect(totalScriptChars(steps)).toBe(expected);
	});
});

describe("tool lifecycle", () => {
	const toolOnly = () => buildMockScript(scenario({ reasoning: false, text: false }));

	it("emits chunk* → started → executing → output* → completed for every tool", () => {
		const steps = toolOnly();
		const ids = [...new Set(steps.map((step) => step.frame.toolUseId as string))];
		expect(ids.length).toBe(TOOL_ROUNDS.flat().length);

		for (const id of ids) {
			const kinds = framesForTool(steps, id).map((step) => step.kind);
			const started = kinds.indexOf("tool-started");
			const executing = kinds.indexOf("tool-executing");
			const completed = kinds.indexOf("tool-completed");

			expect(started).toBeGreaterThan(0); // at least one argument chunk first
			expect(kinds.slice(0, started).every((kind) => kind === "tool-chunk")).toBe(true);
			expect(executing).toBe(started + 1);
			expect(completed).toBe(kinds.length - 1);
			// Exactly one of each lifecycle frame.
			expect(kinds.filter((k) => k === "tool-started")).toHaveLength(1);
			expect(kinds.filter((k) => k === "tool-executing")).toHaveLength(1);
			expect(kinds.filter((k) => k === "tool-completed")).toHaveLength(1);
			// Any stdout sits strictly between executing and completed.
			for (const [index, kind] of kinds.entries()) {
				if (kind === "tool-output") {
					expect(index).toBeGreaterThan(executing);
					expect(index).toBeLessThan(completed);
				}
			}
		}
	});

	it("runs tools sequentially — one tool's frames are contiguous", () => {
		const steps = toolOnly();
		const seen = new Set<string>();
		let current: string | null = null;
		for (const step of steps) {
			const id = step.frame.toolUseId as string;
			if (id !== current) {
				// A tool id must never resume after another tool interleaved.
				expect(seen.has(id)).toBe(false);
				seen.add(id);
				current = id;
			}
		}
	});

	it("streams stdout CUMULATIVELY for the tools that stream it", () => {
		const steps = toolOnly();
		const streamingIds = [
			...new Set(
				steps.filter((s) => s.kind === "tool-output").map((s) => s.frame.toolUseId as string),
			),
		];
		// The corpus marks the bash calls as streaming.
		expect(streamingIds.length).toBeGreaterThan(0);
		for (const id of streamingIds) {
			const outputs = framesForTool(steps, id)
				.filter((step) => step.kind === "tool-output")
				.map((step) => String(step.frame.output));
			for (let i = 1; i < outputs.length; i++) {
				expect(String(outputs[i]).startsWith(String(outputs[i - 1]))).toBe(true);
			}
			// The final cumulative value equals the completed body.
			const completed = framesForTool(steps, id).find((s) => s.kind === "tool-completed");
			expect(outputs.at(-1)).toBe(String(completed?.frame.output));
		}
	});

	it("accumulates inputCharsTotal while streamingField stays incremental", () => {
		const steps = toolOnly();
		const ids = [...new Set(steps.map((step) => step.frame.toolUseId as string))];
		for (const id of ids) {
			const chunks = framesForTool(steps, id).filter((step) => step.kind === "tool-chunk");
			let total = 0;
			const perField = new Map<string, string>();
			for (const chunk of chunks) {
				const next = chunk.frame.inputCharsTotal as number;
				expect(next).toBeGreaterThan(total);
				total = next;
				const field = chunk.frame.streamingField as { name: string; delta: string };
				perField.set(field.name, (perField.get(field.name) ?? "") + field.delta);
			}
			// Each streamed field reassembles to the resolved input's value.
			const started = framesForTool(steps, id).find((s) => s.kind === "tool-started");
			const input = started?.frame.input as Record<string, unknown>;
			for (const [name, value] of perField) {
				const resolved = input[name];
				expect(value).toBe(typeof resolved === "string" ? resolved : JSON.stringify(resolved));
			}
		}
	});

	it("carries the extracted file path while streaming so the card category is stable", () => {
		const steps = toolOnly();
		// The spec-tasks write must be recognisable as a task board (not a diff)
		// from its very first frames, which requires extractedFilePath.
		const taskWrite = steps.find(
			(step) => step.kind === "tool-chunk" && step.frame.extractedFilePath === "spec://tasks.json",
		);
		expect(taskWrite).toBeDefined();
	});

	it("covers a variety of tool categories, including a failure", () => {
		const steps = toolOnly();
		const names = new Set(
			steps
				.filter((step) => step.kind === "tool-completed")
				.map((step) => step.frame.toolName as string),
		);
		// One per distinct card body: code box, match list, diff, terminal,
		// markdown plan, task board, delegation, web results.
		for (const expected of [
			"Glob",
			"Read",
			"Grep",
			"Agent",
			"Edit",
			"Write",
			"Bash",
			"WebSearch",
			"ExitPlanMode",
		]) {
			expect(names.has(expected)).toBe(true);
		}
		const failed = steps.filter(
			(step) => step.kind === "tool-completed" && step.frame.status === "fail",
		);
		expect(failed.length).toBeGreaterThan(0);
	});

	it("gives every tool call a unique, deterministic id", () => {
		const first = buildMockScript(scenario({ reasoning: false, text: false }));
		const second = buildMockScript(scenario({ reasoning: false, text: false }));
		const idsOf = (steps: MockStep[]) => steps.map((step) => step.frame.toolUseId as string);
		expect(idsOf(first)).toEqual(idsOf(second));
		const unique = new Set(idsOf(first));
		expect(unique.size).toBe(TOOL_ROUNDS.flat().length);
	});

	it("shapes Edit so the card can render a diff (old before new)", () => {
		const steps = toolOnly();
		const editStarted = steps.find(
			(step) => step.kind === "tool-started" && step.frame.toolName === "Edit",
		);
		const input = editStarted?.frame.input as Record<string, unknown>;
		expect(typeof input.old_string).toBe("string");
		expect(typeof input.new_string).toBe("string");
		expect(input.old_string).not.toBe(input.new_string);

		// old_string must finish streaming before new_string starts, so the card
		// shows a matching-phase diff first and a replacing-phase diff after.
		const editId = editStarted?.frame.toolUseId as string;
		const fieldOrder = framesForTool(steps, editId)
			.filter((step) => step.kind === "tool-chunk")
			.map((step) => (step.frame.streamingField as { name: string }).name);
		expect(fieldOrder.lastIndexOf("old_string")).toBeLessThan(fieldOrder.indexOf("new_string"));
	});
});

describe("corpus coverage — every markdown element the pipeline handles", () => {
	const allText = TEXT_ROUNDS.join("\n\n");

	it("contains headings h1..h4", () => {
		for (const marker of ["\n# ", "\n## ", "\n### ", "\n#### "]) {
			expect(`\n${allText}`).toContain(marker);
		}
	});

	it("contains inline code, bold, italic and a link", () => {
		expect(allText).toMatch(/`[^`\n]+`/);
		expect(allText).toMatch(/\*\*[^*\n]+\*\*/);
		expect(allText).toMatch(/(^|[^*])\*[^*\n]+\*/);
		expect(allText).toMatch(/\[[^\]]+\]\([^)]+\)/);
	});

	it("contains INLINE math and DISPLAY math", () => {
		// Display first, so the inline check cannot be satisfied by a `$$` block.
		expect(allText).toContain("$$");
		const withoutDisplay = allText.replace(/\$\$[\s\S]*?\$\$/g, "");
		expect(withoutDisplay).toMatch(/\$[^$\n]+\$/);
	});

	it("contains a multi-line fenced code block with a language", () => {
		const fence = allText.match(/```(\w+)\n([\s\S]*?)```/);
		expect(fence).not.toBeNull();
		expect(String(fence?.[2]).split("\n").length).toBeGreaterThan(3);
	});

	it("contains a mermaid fence (the unknown-height block)", () => {
		expect(allText).toContain("```mermaid");
	});

	it("contains tables, including an alignment row and math in a cell", () => {
		expect(allText).toMatch(/\n\|.+\|\n\|\s*:?-+:?\s*\|/);
		// An alignment row using explicit left/right/center markers.
		expect(allText).toMatch(/\|\s*:---\s*\|/);
		expect(allText).toMatch(/\|\s*---:\s*\|/);
		expect(allText).toMatch(/\|\s*:---:\s*\|/);
		// Math inside a table cell (a distinct measurement path).
		expect(allText).toMatch(/\|[^|\n]*\$[^$\n]+\$[^|\n]*\|/);
	});

	it("contains unordered, ordered and nested lists", () => {
		expect(allText).toMatch(/\n- /);
		expect(allText).toMatch(/\n1\. /);
		expect(allText).toMatch(/\n\s+1\. /);
	});

	it("contains a blockquote and a thematic break", () => {
		expect(allText).toMatch(/\n> /);
		expect(allText).toMatch(/\n---\n/);
	});

	it("mixes CJK and latin in one line (width settling)", () => {
		const cjkLine = allText
			.split("\n")
			.find((line) => /[\u4e00-\u9fff]/.test(line) && /[a-zA-Z]/.test(line));
		expect(cjkLine).toBeDefined();
	});

	it("keeps a markdown plan body for the plan card", () => {
		const plan = TOOL_ROUNDS.flat().find((spec) => spec.toolName === "ExitPlanMode");
		expect(typeof plan?.input.plan).toBe("string");
		expect(String(plan?.input.plan)).toContain("## ");
	});
});
