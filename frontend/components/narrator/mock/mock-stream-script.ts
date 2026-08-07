/**
 * mock-stream-script.ts — Expands the fixed corpus into an ordered list of
 * synthetic WS frames.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Structure: a MULTI-ROUND turn, mirroring how a real turn actually unfolds —
 *
 *   round 1: reasoning → text → tool, tool, tool
 *   round 2: reasoning → text → tool, tool
 *   …
 *
 * so the harness exercises the case that matters most for animation tuning: new
 * reasoning arriving AFTER a tool call has already settled. Each round opens fresh
 * output lanes, which is what the real provider does and what makes
 * `liveBlockIndex` (the "which lane is still being written" stamp) non-trivial.
 *
 * Split from the runner so ORDER and CONTENT are unit-testable without timers, a
 * WebSocket or React. Two properties are load-bearing:
 *
 *   1. A tool's frames are emitted in lifecycle order
 *      (chunk* → started → executing → output* → completed). A card receiving
 *      `tool_output` before `tool_started` is a state the server never produces,
 *      so tuning against it would be tuning against a fiction.
 *   2. Chunking partitions each body exactly — every character delivered once, in
 *      order. A harness that drops text makes height deltas meaningless.
 *
 * Pure: no WS, no React, no DOM, no timers.
 */

import {
	MOCK_ROUND_COUNT,
	type MockToolSpec,
	REASONING_ROUNDS,
	TEXT_ROUNDS,
	TOOL_ROUNDS,
} from "./mock-stream-corpus";
import {
	type MockFrame,
	mockReasoningDeltaFrame,
	mockTextDeltaFrame,
	mockToolChunkFrame,
	mockToolCompletedFrame,
	mockToolExecutingFrame,
	mockToolOutputFrame,
	mockToolStartedFrame,
} from "./mock-stream-frames";

/** What a step contributes, for live stats and the UI's step label. */
export type MockStepKind =
	| "reasoning"
	| "text"
	| "tool-chunk"
	| "tool-started"
	| "tool-executing"
	| "tool-output"
	| "tool-completed";

export interface MockStep {
	kind: MockStepKind;
	/** 1-based round this step belongs to. */
	round: number;
	/** Characters of visible content this step delivers (0 for lifecycle-only frames). */
	chars: number;
	frame: MockFrame;
}

export interface MockScenario {
	narratorId: string;
	/** Emit each round's reasoning lane. */
	reasoning: boolean;
	/** Emit each round's assistant text lane. */
	text: boolean;
	/** Emit each round's tool calls. */
	tools: boolean;
	/** How many of the fixed rounds to replay (1..MOCK_ROUND_COUNT). */
	rounds: number;
	/** Characters delivered per text/reasoning delta frame. */
	charsPerFrame: number;
	/** Characters of stdout delivered per `tool_output` frame. */
	toolOutputCharsPerFrame: number;
	/** Repeat each round's text body this many times (volume stress). */
	textRepeat: number;
}

export const DEFAULT_MOCK_SCENARIO: Omit<MockScenario, "narratorId"> = {
	reasoning: true,
	text: true,
	tools: true,
	rounds: MOCK_ROUND_COUNT,
	charsPerFrame: 24,
	toolOutputCharsPerFrame: 120,
	textRepeat: 1,
};

export { MOCK_ROUND_COUNT };

/**
 * Partition `source` into consecutive slices of at most `size` characters.
 *
 * Exhaustive and non-overlapping by construction: the concatenation of the result
 * always equals `source` (locked by test).
 */
export function chunkText(source: string, size: number): string[] {
	if (!source) return [];
	const step = Math.max(1, Math.floor(size));
	const chunks: string[] = [];
	for (let index = 0; index < source.length; index += step) {
		chunks.push(source.slice(index, index + step));
	}
	return chunks;
}

/** Repeat a markdown body, separated by a rule so the joins stay readable. */
function repeatBody(body: string, times: number): string {
	if (times <= 1) return body;
	return Array.from({ length: times }, () => body).join("\n\n---\n\n");
}

/** Pick a round's entry, cycling when a corpus list is shorter than `rounds`. */
function roundEntry<T>(list: readonly T[], index: number): T | undefined {
	if (list.length === 0) return undefined;
	return list[index % list.length];
}

/**
 * A stable tool-use id.
 *
 * Deterministic (round + slot + name) rather than random, so a replayed run
 * produces the same ids and a diff of two runs shows only what actually changed.
 */
function toolUseIdFor(round: number, slot: number, toolName: string): string {
	return `mock-r${round}-t${slot}-${toolName.toLowerCase()}`;
}

/** Emit one tool's full lifecycle. */
function expandTool(
	steps: MockStep[],
	narratorId: string,
	round: number,
	slot: number,
	spec: MockToolSpec,
	scenario: MockScenario,
): void {
	const toolUseId = toolUseIdFor(round, slot, spec.toolName);
	const { toolName } = spec;

	// 1. Arguments arriving, field by field in the model's write order.
	//    `streamingField.delta` is incremental; `inputCharsTotal` is a running
	//    total the server recomputes each frame.
	let sent = 0;
	const extracted: Record<string, string> = {};
	for (const fieldName of spec.streamFields) {
		const raw = spec.input[fieldName];
		const value = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
		// Short scalar fields (a path, a pattern) arrive in one frame; a long body
		// (content / old_string / prompt) is chunked like real streamed arguments.
		const size = value.length > 200 ? Math.max(8, scenario.charsPerFrame) : value.length;
		for (const chunk of chunkText(value, size)) {
			sent += chunk.length;
			extracted[fieldName] = (extracted[fieldName] ?? "") + chunk;
			steps.push({
				kind: "tool-chunk",
				round,
				chars: chunk.length,
				frame: mockToolChunkFrame({
					narratorId,
					toolUseId,
					toolName,
					inputCharsTotal: sent,
					streamingField: { name: fieldName, delta: chunk },
					// The path the streaming parser has extracted so far. It selects the
					// card's category (a `spec://tasks.json` write renders a task board,
					// not a diff) and must be present while streaming, or the glyph
					// changes at the hand-off.
					...(extracted.file_path ? { extractedFilePath: extracted.file_path } : {}),
					extractedFields: { ...extracted },
				}),
			});
		}
	}

	// 2. Input finished parsing (NOT "executing").
	steps.push({
		kind: "tool-started",
		round,
		chars: 0,
		frame: mockToolStartedFrame({
			narratorId,
			toolUseId,
			toolName,
			input: spec.input,
			streamStartedAt: Date.now(),
		}),
	});

	// 3. Permission gate passed → the executing shimmer.
	steps.push({
		kind: "tool-executing",
		round,
		chars: 0,
		frame: mockToolExecutingFrame({ narratorId, toolUseId }),
	});

	// 4. Cumulative stdout, for the tools that stream it (bash-like).
	if (spec.streamOutput) {
		let cumulative = "";
		for (const chunk of chunkText(spec.output, scenario.toolOutputCharsPerFrame)) {
			cumulative += chunk;
			steps.push({
				kind: "tool-output",
				round,
				chars: chunk.length,
				frame: mockToolOutputFrame({ narratorId, toolUseId, output: cumulative }),
			});
		}
	}

	// 5. Terminal status carrying the final body.
	//    `output` is a plain string, matching the real wire format — an array here
	//    would be JSON-dumped by the classifier and the card would show structure
	//    instead of content.
	steps.push({
		kind: "tool-completed",
		round,
		chars: spec.streamOutput ? 0 : spec.output.length,
		frame: mockToolCompletedFrame({
			narratorId,
			toolUseId,
			toolName,
			status: spec.status ?? "success",
			output: spec.output,
			durationMs: 320 + slot * 210 + round * 90,
			...(spec.metadata ? { metadata: spec.metadata } : {}),
		}),
	});
}

/**
 * Expand a scenario into ordered steps.
 *
 * Lane numbering is global and monotonic across rounds: round 2's reasoning opens
 * a NEW lane rather than reopening round 1's, which is what a real provider does
 * after a tool result and what makes the live-lane stamp meaningful.
 */
export function buildMockScript(scenario: MockScenario): MockStep[] {
	const steps: MockStep[] = [];
	const { narratorId } = scenario;
	const roundCount = Math.max(0, Math.min(Math.floor(scenario.rounds), MOCK_ROUND_COUNT));
	let outputIndex = 0;

	for (let index = 0; index < roundCount; index++) {
		const round = index + 1;

		if (scenario.reasoning) {
			const body = roundEntry(REASONING_ROUNDS, index);
			if (body) {
				const lane = outputIndex++;
				const reasoningId = `mock-reasoning-r${round}`;
				for (const chunk of chunkText(body, scenario.charsPerFrame)) {
					steps.push({
						kind: "reasoning",
						round,
						chars: chunk.length,
						frame: mockReasoningDeltaFrame({
							narratorId,
							text: chunk,
							id: reasoningId,
							outputIndex: lane,
						}),
					});
				}
			}
		}

		if (scenario.text) {
			const body = roundEntry(TEXT_ROUNDS, index);
			if (body) {
				const lane = outputIndex++;
				const repeated = repeatBody(body, Math.max(1, Math.floor(scenario.textRepeat)));
				for (const chunk of chunkText(repeated, scenario.charsPerFrame)) {
					steps.push({
						kind: "text",
						round,
						chars: chunk.length,
						frame: mockTextDeltaFrame({ narratorId, text: chunk, outputIndex: lane }),
					});
				}
			}
		}

		if (scenario.tools) {
			const specs = roundEntry(TOOL_ROUNDS, index) ?? [];
			for (let slot = 0; slot < specs.length; slot++) {
				const spec = specs[slot];
				if (spec) expandTool(steps, narratorId, round, slot, spec, scenario);
			}
		}
	}

	return steps;
}

/** Total visible characters a script delivers (for the panel's progress readout). */
export function totalScriptChars(steps: readonly MockStep[]): number {
	let total = 0;
	for (const step of steps) total += step.chars;
	return total;
}
