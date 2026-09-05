/**
 * TutorialProvider — a scripted upstream for the interactive tutorial.
 *
 * The tutorial's whole premise is that the user drives the REAL product: real
 * narrators, real tool execution, real permission cards, real worktrees, real
 * database rows. Only the model is replaced. This provider is that replacement:
 * it replays `shared/tutorial/lessons.ts` scripts as a stream of
 * `ParsedStreamEvent`s, so `agentLoop` cannot tell it apart from a real provider
 * and no AI API is ever contacted.
 *
 * Three properties are load-bearing, and each fails SILENTLY if broken:
 *
 *  1. **Turn position is derived from history, never stored on the instance.**
 *     `resolveProviderAndModel` constructs a fresh adapter on every resolution
 *     (`createProviderByName` returns `new ...`), so an instance field would
 *     reset each turn and the lesson would replay turn 0 forever. Nothing throws;
 *     the model just repeats itself.
 *
 *  2. **`onRequestStart` must be called.** The loop uses it to tell a real empty
 *     upstream response apart from a local preparation path that finished without
 *     contacting anything (see `provider.ts`'s `onRequestStart` docs). Skipping it
 *     makes a scripted turn look like the latter.
 *
 *  3. **`signal` must be honoured mid-stream.** "Interrupt a running turn" is one
 *     of the lessons. If the generator ignores the signal, the interrupt button
 *     appears to do nothing — which teaches the opposite of the intended lesson.
 *
 * The history shape this provider builds is private to itself (nothing else ever
 * reads it), so it uses the simplest workable encoding: Anthropic-style content
 * blocks. What is NOT private is `buildHistory`'s input — those are real
 * persisted rows, and the turn counter is derived from them.
 */

import {
	getTutorialScript,
	resolveTutorialTurn,
	TUTORIAL_LESSON_BOUNDARY_BLOCK,
	TUTORIAL_MODEL_ID,
	TUTORIAL_PROVIDER_PREFIX,
	type TutorialScript,
	type TutorialScriptToolUse,
} from "@shared/tutorial/lessons";
import { logger } from "../logger";
import { abortableSleep } from "./abortable-sleep";
import type {
	AgentToolUse,
	BuiltHistory,
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import type { ResolvedToolDefinition } from "./types";

/**
 * Streaming pacing.
 *
 * A scripted provider has no natural latency, so the pace is a teaching choice:
 * fast enough not to bore, slow enough that the reasoning → text → tool
 * transitions are legible and the interrupt button has something to interrupt.
 *
 * Injectable so tests do not pay for wall-clock sleeps — the pacing is the one
 * thing here that is a judgement call rather than a correctness property, and a
 * test that waits seconds to assert on ordering is a test people stop running.
 */
export interface TutorialPacing {
	/** Characters emitted per streamed frame. */
	charsPerFrame: number;
	/** Delay between streamed frames. */
	frameIntervalMs: number;
	/** Extra pause between channels (reasoning → text → tools). */
	channelGapMs: number;
	/** Frames used to stream one tool call's arguments. */
	toolInputFrames: number;
}

export const DEFAULT_TUTORIAL_PACING: TutorialPacing = {
	charsPerFrame: 24,
	frameIntervalMs: 28,
	channelGapMs: 220,
	toolInputFrames: 6,
};

/**
 * How the lesson, locale and subagent role reach the provider: inside the model
 * value.
 *
 * `tutorial:guide/<lessonId>/<locale>[/<subagentType>]`
 *
 * The provider is handed a model string, never a narrator row, and `ChatParams`
 * carries no locale (locale only reaches `injectSystemPrompt`, which reflection
 * loops deliberately skip). The model value is the one piece of routing state
 * that survives *every* path that matters:
 *
 *  - reflection loops spread `{...parentConfig}`, keeping `config.model`;
 *  - subagents get their model from the parent's per-type pool
 *    (`resolveSubagentModelFromPolicy`), so writing a different value into each
 *    type's pool is what lets an explore subagent play a different script from a
 *    general one — see `tutorialSubagentTraits`.
 *
 * Every segment after the model id is optional so a malformed or legacy value
 * still resolves: a bare `tutorial:guide` answers with the no-script line rather
 * than throwing.
 */
export function parseTutorialModel(model: string): {
	lessonId?: string;
	locale?: string;
	subagentType?: string;
} {
	const bare = model.startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`)
		? model.slice(TUTORIAL_PROVIDER_PREFIX.length + 1)
		: model;
	const [, lessonId, locale, subagentType] = bare.split("/");
	return {
		...(lessonId?.trim() ? { lessonId: lessonId.trim() } : {}),
		...(locale?.trim() ? { locale: locale.trim() } : {}),
		...(subagentType?.trim() ? { subagentType: subagentType.trim() } : {}),
	};
}

/** Build the model value for a lesson's primary narrator. */
export function tutorialModelForLesson(lessonId: string, locale: string): string {
	return `${TUTORIAL_PROVIDER_PREFIX}:${TUTORIAL_MODEL_ID}/${lessonId}/${locale}`;
}

/**
 * Build the model value for a subagent of a given type.
 *
 * A distinct value per type is what makes the subagent lesson teachable: an
 * `explore` agent that is read-only and a `general` agent that writes should not
 * recite the same lines, and the type is not otherwise visible to the provider.
 */
export function tutorialModelForSubagent(
	lessonId: string,
	locale: string,
	subagentType: string,
): string {
	return `${tutorialModelForLesson(lessonId, locale)}/${subagentType}`;
}

// ---------------------------------------------------------------------------
// Private history encoding
// ---------------------------------------------------------------------------

type Part =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
	/**
	 * Where a lesson begins. Carried in this private encoding — not just read and
	 * discarded — because the turn counter needs it at `chat()` time, and by then
	 * the DB rows are long gone.
	 */
	| { type: "lesson_boundary"; lessonId?: string };

interface Message {
	role: "user" | "assistant";
	content: Part[];
}

/** Index of the last message that opens a lesson, or -1 when there is none. */
function lastLessonBoundaryIndex(history: Message[]): number {
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i]?.content?.some((part) => part?.type === "lesson_boundary")) return i;
	}
	return -1;
}

/**
 * Count assistant turns in the history to decide which script turn plays next.
 *
 * A "turn" here is an assistant message, matching what the script models. Tool
 * results do not advance the counter: a script turn that calls a tool is followed
 * by a tool-result user message and then the SAME script turn's continuation
 * would be wrong — the loop re-enters `chat()` after tool execution and must get
 * the NEXT turn, so assistant messages are the right unit.
 *
 * `from` skips everything before the current lesson's boundary. One tutorial
 * narrator now spans every lesson (that continuity is the point — the user's
 * learning session should read as one conversation), so without this the count
 * would keep climbing across lessons and each new lesson would open on its
 * `fallbackTurn` instead of turn 0. Nothing throws; the model just says the
 * lesson is already over.
 */
function countAssistantTurns(history: unknown[], from = 0): number {
	let count = 0;
	const messages = history as Message[];
	for (let i = Math.max(0, from); i < messages.length; i++) {
		if (messages[i]?.role === "assistant") count++;
	}
	return count;
}

function outputToText(output: unknown): string {
	if (output == null) return "";
	if (typeof output === "string") return output;
	if (typeof output === "object") {
		const text = (output as { _text?: unknown })._text;
		if (typeof text === "string") return text;
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TutorialProvider implements ProviderAdapter {
	/**
	 * Native tool-use fields only — the tutorial never emits XML tool calls, so the
	 * loop's leaked-tool recovery net is unnecessary here. Leaving this false also
	 * avoids collecting a raw dump for every scripted turn.
	 */
	mayLeakXmlToolCalls = false;

	private readonly pacing: TutorialPacing;

	constructor(pacing: Partial<TutorialPacing> = {}) {
		this.pacing = { ...DEFAULT_TUTORIAL_PACING, ...pacing };
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		// The scripted turns name their tools directly, so the formatted list is
		// never consulted for routing. It is still returned faithfully because the
		// loop uses `tools.length` to decide whether tool use is possible at all.
		return tools.map((tool) => ({ name: tool.name, description: tool.description }));
	}

	async buildHistory(dbMessages: DbMessage[], _model: string): Promise<BuiltHistory> {
		const history: Message[] = [];
		let pendingToolResults: Part[] = [];

		const flushToolResults = () => {
			if (pendingToolResults.length === 0) return;
			history.push({ role: "user", content: pendingToolResults });
			pendingToolResults = [];
		};

		for (const msg of dbMessages) {
			const blocks = Array.isArray(msg.contentJson)
				? (msg.contentJson as Array<Record<string, unknown>>)
				: [];

			if (msg.role === "assistant") {
				flushToolResults();
				const parts: Part[] = [];
				for (const block of blocks) {
					if (block.type === "text" && typeof block.text === "string") {
						parts.push({ type: "text", text: block.text });
					} else if (block.type === "thinking" && typeof block.thinking === "string") {
						parts.push({ type: "thinking", thinking: block.thinking });
					} else if (
						block.type === "tool_use" &&
						typeof block.id === "string" &&
						typeof block.name === "string"
					) {
						parts.push({
							type: "tool_use",
							id: block.id,
							name: block.name,
							input: (block.input as Record<string, unknown>) ?? {},
						});
					}
				}
				if (parts.length === 0 && msg.contentText) {
					parts.push({ type: "text", text: msg.contentText });
				}
				// An assistant row with no content at all would still have to count as a
				// turn, otherwise the script rewinds. Push a placeholder rather than
				// skipping the row.
				if (parts.length === 0) parts.push({ type: "text", text: "" });
				history.push({ role: "assistant", content: parts });

				for (const tc of msg.toolCalls ?? []) {
					if (tc.status !== "success" && tc.status !== "fail") continue;
					pendingToolResults.push({
						type: "tool_result",
						tool_use_id: tc.toolUseId,
						content: outputToText(tc.outputJson),
						...(tc.status === "fail" ? { is_error: true } : {}),
					});
				}
				continue;
			}

			// user / sys / disp / system all reach the model as user context here. The
			// tutorial script does not branch on the distinction, and collapsing them
			// keeps the turn counter (assistant messages) unaffected.
			flushToolResults();
			const text =
				blocks
					.filter((b) => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text as string)
					.join("\n") ||
				(msg.contentText ?? "");
			// A lesson boundary must survive into the built history, and it must survive
			// even when the row has no text: `scriptTurnIndex` reads it to restart the
			// count, and losing it silently makes every lesson after the first play its
			// "this lesson is finished" fallback.
			const boundary = blocks.find((b) => b.type === TUTORIAL_LESSON_BOUNDARY_BLOCK);
			if (boundary) {
				const lessonId = typeof boundary.lessonId === "string" ? boundary.lessonId : undefined;
				const parts: Part[] = [{ type: "lesson_boundary", ...(lessonId ? { lessonId } : {}) }];
				if (text) parts.push({ type: "text", text });
				history.push({ role: "user", content: parts });
				continue;
			}
			if (text) history.push({ role: "user", content: [{ type: "text", text }] });
		}

		return { history, trailingToolResults: pendingToolResults };
	}

	/**
	 * `model` and `locale` are accepted and ignored on purpose.
	 *
	 * Declaring them keeps the concrete class callable with the full interface
	 * arity (a caller passing four arguments must not be a type error), and states
	 * that the scripted provider needs neither: the model id it would read is
	 * already parsed in `chat()`, and locale travels inside that same model value
	 * because reflection loops deliberately skip system-prompt injection.
	 */
	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model?: string,
		_locale?: string,
	): void {
		// Prepended as a user turn plus a one-word assistant ack. The ack is an
		// assistant message, so it WOULD be counted as a turn — but injection happens
		// once before the loop's first request and the script's turn 0 must still
		// play first. The counter therefore ignores it by construction: `chat()`
		// subtracts the injected ack (see `scriptTurnIndex`).
		(history as Message[]).unshift(
			{ role: "user", content: [{ type: "text", text: systemPrompt }] },
			{ role: "assistant", content: [{ type: "text", text: TUTORIAL_SYSTEM_ACK }] },
		);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const { lessonId, locale, subagentType } = parseTutorialModel(params.model);
		const script = lessonId ? getTutorialScript(lessonId) : undefined;
		if (lessonId && !script) {
			logger.warn("Tutorial provider: no script for lesson", { lessonId });
		}

		const index = scriptTurnIndex(params.history);
		const turn = pickTurn(script, index, subagentType);
		const resolved = resolveTutorialTurn(turn, locale);

		// The loop distinguishes "upstream returned nothing" from "local preparation
		// finished without contacting anything" via this callback. A scripted turn is
		// the former, so it must be announced.
		params.onRequestStart?.();

		params.requestDump?.setRequest({
			transport: "tutorial-script",
			body: { lessonId: lessonId ?? null, turnIndex: index, model: params.model },
		});

		// Report zero context occupancy, and do it as a real measurement rather than
		// leaving it unset.
		//
		// One tutorial narrator now spans every lesson, so its history genuinely grows.
		// Left unreported, the loop falls back to estimating tokens against a 128k
		// default and would eventually cross `compactStart` — which starts an auto
		// compact on `settings.agent.summaryModel`, a REAL model this provider cannot
		// redirect. That is the exact silent-billing failure the tutorial is built to
		// avoid, and it would only appear for the users who finished the most lessons.
		//
		// Zero is honest here in a way it is not for subscription providers: nothing is sent upstream, so
		// there is no context window to occupy and no prompt to measure.
		yield { contextUsagePercentage: 0 };

		let outputIndex = 0;

		if (resolved.reasoning) {
			for (const chunk of chunkText(resolved.reasoning, this.pacing.charsPerFrame)) {
				if (params.signal.aborted) return;
				yield { reasoning: chunk, reasoningOutputIndex: outputIndex };
				await abortableSleep(this.pacing.frameIntervalMs, params.signal);
			}
			outputIndex++;
			await abortableSleep(this.pacing.channelGapMs, params.signal);
		}

		if (resolved.text) {
			for (const chunk of chunkText(resolved.text, this.pacing.charsPerFrame)) {
				if (params.signal.aborted) return;
				yield { text: chunk, textOutputIndex: outputIndex };
				await abortableSleep(this.pacing.frameIntervalMs, params.signal);
			}
			outputIndex++;
		}

		if (resolved.toolUses.length > 0) {
			await abortableSleep(this.pacing.channelGapMs, params.signal);
		}

		const toolUses: AgentToolUse[] = [];
		for (const scripted of resolved.toolUses) {
			if (params.signal.aborted) return;
			const toolUseId = tutorialToolUseId(lessonId, index, toolUses.length);
			// Stream the arguments first so the "model is still writing this call"
			// phase of the card is visible — that phase is the part newcomers find
			// most confusing, and a card that appears fully formed never shows it.
			yield* streamToolInput(scripted, toolUseId, params, this.pacing.toolInputFrames);
			if (params.signal.aborted) return;
			toolUses.push({
				toolUseId,
				name: scripted.name,
				input: scripted.input,
				outputIndex: outputIndex++,
			});
		}

		if (toolUses.length > 0) {
			yield { toolUses, stopReason: "tool_use" };
			return;
		}

		yield { stopReason: "end_turn" };
	}

	formatToolResult(toolUseId: string, output: string, isError: boolean): unknown {
		return {
			type: "tool_result",
			tool_use_id: toolUseId,
			content: output,
			...(isError ? { is_error: true } : {}),
		};
	}

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
		const parts: Part[] = [...(toolResults as Part[])];
		if (content && content !== ".") parts.push({ type: "text", text: content });
		if (parts.length > 0) (history as Message[]).push({ role: "user", content: parts });
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		reasoningBlocks?: Array<{ text: string }>,
	): void {
		const parts: Part[] = [];
		for (const rb of reasoningBlocks ?? []) {
			if (rb.text) parts.push({ type: "thinking", thinking: rb.text });
		}
		if (text) parts.push({ type: "text", text });
		for (const tu of toolUses) {
			parts.push({ type: "tool_use", id: tu.toolUseId, name: tu.name, input: tu.input });
		}
		// Always push, even when empty: this message is what the turn counter reads,
		// and dropping it would rewind the script (see countAssistantTurns).
		if (parts.length === 0) parts.push({ type: "text", text: "" });
		(history as Message[]).push({ role: "assistant", content: parts });
	}

	async generate(text: string, model: string): Promise<string> {
		return (await this.generateWithMeta(text, model)).text;
	}

	/**
	 * Non-streaming generation — reached only by auxiliary callers (title, compact).
	 *
	 * A well-formed lesson never gets here: titles are written at narrator creation
	 * and compact is out of scope for the first version. But throwing would take the
	 * whole tutorial down over a bookkeeping call, so this degrades to the script's
	 * canned line instead.
	 */
	async generateWithMeta(
		_text: string,
		model: string,
		_systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const text = cannedGenerateText(model, "summary");
		await options?.onTextDelta?.(text);
		// Zero usage is the truth here, not a missing measurement: no tokens were
		// spent because no request was made.
		return { text, usage: null };
	}

	async generateWithHistory(
		_systemInstruction: string,
		_content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		const text = cannedGenerateText(model, "title", locale);
		await options?.onTextDelta?.(text);
		return text;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assistant ack injected alongside the system prompt; excluded from the turn count. */
const TUTORIAL_SYSTEM_ACK = "OK";
const TUTORIAL_GENERATE_FALLBACK = "Tutorial session.";

/**
 * Which script turn plays for this request.
 *
 * `injectSystemPrompt` prepends an assistant ack, which is an assistant message
 * and would otherwise push the first real request to turn 1. Detect and subtract
 * it rather than special-casing the ack's text everywhere.
 */
export function scriptTurnIndex(history: unknown[]): number {
	const messages = history as Message[];
	const boundary = lastLessonBoundaryIndex(messages);
	// Counting from the boundary makes the injected ack irrelevant by construction:
	// the ack is prepended at index 1, always BEFORE any boundary, so it cannot be
	// inside the counted range. Only a session with no boundary at all (the first
	// lesson of a reused narrator, or a lesson started before this row existed)
	// still needs the subtraction.
	if (boundary >= 0) return countAssistantTurns(messages, boundary + 1);

	const total = countAssistantTurns(messages);
	const injected =
		messages[1]?.role === "assistant" &&
		messages[0]?.role === "user" &&
		messages[1].content.length === 1 &&
		messages[1].content[0]?.type === "text" &&
		(messages[1].content[0] as { text: string }).text === TUTORIAL_SYSTEM_ACK
			? 1
			: 0;
	return Math.max(0, total - injected);
}

/**
 * Canned answer for an auxiliary `generate*` call.
 *
 * `prefer` picks which canned line fits the caller ("title" for title
 * generation, "summary" for compact), falling back to the other one so a script
 * that only defined one still answers something sensible.
 */
function cannedGenerateText(
	model: string,
	prefer: "title" | "summary",
	localeOverride?: string,
): string {
	const { lessonId, locale } = parseTutorialModel(model);
	const responses = lessonId ? getTutorialScript(lessonId)?.generateResponses : undefined;
	const canned =
		prefer === "title"
			? (responses?.title ?? responses?.summary)
			: (responses?.summary ?? responses?.title);
	if (!canned) return TUTORIAL_GENERATE_FALLBACK;
	return (
		resolveTutorialTurn({ text: canned }, localeOverride ?? locale).text ??
		TUTORIAL_GENERATE_FALLBACK
	);
}

/**
 * The turn to play for this request.
 *
 * A subagent draws from its own per-type turn list. Falling back to the PARENT's
 * turns would be actively wrong: those turns spawn subagents, so a subagent
 * replaying them would spawn more of them — and nested subagents are rejected, so
 * the lesson would end in an error card. An unmapped type therefore gets the
 * fallback line instead.
 */
function pickTurn(
	script: TutorialScript | undefined,
	index: number,
	subagentType: string | undefined,
) {
	if (!script) {
		return {
			text: {
				en: "This tutorial narrator has no script attached. Start a lesson from the tutorial page.",
				"zh-CN": "这个教程叙述者没有关联剧本。请从教程页面启动一课。",
			},
		};
	}
	if (subagentType) {
		return script.subagentTurns?.[subagentType]?.[index] ?? script.fallbackTurn;
	}
	return script.turns[index] ?? script.fallbackTurn;
}

function chunkText(text: string, charsPerFrame: number): string[] {
	const chunks: string[] = [];
	const size = Math.max(1, charsPerFrame);
	// Grapheme-safe boundaries would be nicer, but the corpus is authored text:
	// slicing by code unit can only split a surrogate pair, and the consumer
	// concatenates deltas before rendering, so a split pair reassembles intact.
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}

/**
 * Deterministic tool_use id.
 *
 * Deterministic rather than random so replaying a lesson produces stable ids,
 * which makes the dedup guards in the loop (`markCompletedToolUse`) behave the
 * same way every run instead of only on the run someone happened to test.
 */
function tutorialToolUseId(
	lessonId: string | undefined,
	turnIndex: number,
	toolIndex: number,
): string {
	return `tutorial_${lessonId ?? "none"}_${turnIndex}_${toolIndex}`;
}

/**
 * Emit a tool call's arguments as streamed chunks.
 *
 * The loop's accumulator treats these as raw JSON text: it runs
 * `extractJsonFields` on the running concatenation to decide which field is being
 * written, then `JSON.parse`s the whole thing on `stop`. Chunk boundaries are
 * therefore arbitrary — they may split mid-token — but the concatenation MUST be
 * valid JSON. When it is not, the parse falls back to `{_raw: ...}` and the tool
 * executes with no arguments, which produces no error, just a nonsensical call.
 */
function* streamToolInput(
	scripted: TutorialScriptToolUse,
	toolUseId: string,
	params: ChatParams,
	toolInputFrames: number,
): Generator<ParsedStreamEvent> {
	// First chunk carries the name so the card can label itself before any
	// arguments exist.
	yield {
		toolUseChunk: { toolUseId, name: scripted.name, input: "" },
	};

	for (const chunk of toolInputChunks(scripted.input, toolInputFrames)) {
		if (params.signal.aborted) return;
		yield {
			toolUseChunk: { toolUseId, name: scripted.name, input: chunk },
		};
	}

	yield {
		toolUseChunk: { toolUseId, name: scripted.name, input: "", stop: true },
	};
}

/**
 * Split a tool input object into the raw JSON fragments to stream.
 *
 * Exported because this is where the load-bearing invariant lives: the
 * concatenation must equal `JSON.stringify(input)` exactly. Testing it here is
 * direct, whereas asserting it through `chat()` only works once a lesson script
 * happens to contain a tool call — a test that passes vacuously until then.
 */
export function toolInputChunks(input: Record<string, unknown>, toolInputFrames: number): string[] {
	const raw = JSON.stringify(input);
	if (raw.length === 0) return [];
	const frames = Math.max(1, Math.min(toolInputFrames, raw.length));
	const size = Math.ceil(raw.length / frames);
	const chunks: string[] = [];
	for (let i = 0; i < raw.length; i += size) {
		chunks.push(raw.slice(i, i + size));
	}
	return chunks;
}
