import {
	assertRuntimeCanAskQuestion,
	runtimePolicyForContext,
} from "@server/services/agent-runtime/policy";
import { coerceAskQuestions } from "@server/services/ask-user-question-coerce";
import type { AsyncQuestionDefinition } from "@server/services/narrator-question-service";
import { z } from "zod/v4";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

const nonEmptyText = z.string().trim().min(1);

/** Read the `withdraw` list off a raw tool input, ignoring malformed entries. */
export function readWithdrawIds(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const raw = (input as Record<string, unknown>).withdraw;
	if (!Array.isArray(raw)) return [];
	return raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/** True when the model asked for asynchronous (non-blocking) submission. */
export function isAsyncAskRequest(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	return (input as Record<string, unknown>).async === true;
}

/**
 * True when this call only withdraws questions and asks nothing new.
 *
 * Shared with the permission gate on purpose: the gate validates AskUserQuestion input
 * before prompting, and a withdraw-only call legitimately carries no `questions`. Two
 * independent copies of this rule would eventually disagree, and the failure mode is
 * the worst kind — the gate rejecting a call the tool would have handled fine.
 */
export function isWithdrawOnlyAskRequest(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const questions = (input as Record<string, unknown>).questions;
	const hasQuestions = Array.isArray(questions) && questions.length > 0;
	return !hasQuestions && readWithdrawIds(input).length > 0;
}

export const askUserQuestionTool: ToolDefinition = {
	name: "AskUserQuestion",
	description:
		"Use this tool when you need to ask the user questions during execution. This allows you to:\n" +
		"1. Gather user preferences or requirements\n" +
		"2. Clarify ambiguous instructions\n" +
		"3. Get decisions on implementation choices as you work\n" +
		"4. Offer choices to the user about what direction to take.\n\n" +
		"IMPORTANT — use ONLY these two field names on questions and options:\n" +
		"- `header`: SHORT title (about 1-8 words). Same role on questions and options.\n" +
		"- `description`: The longer text. On a question this is the FULL prompt the user must read (background, constraints, and the actual question). On an option it is what that choice means. Both are displayed.\n" +
		"Do not invent other field names (`id`, `question`, `content`, `label`, ...). Do not cram the long prompt into `header`.\n\n" +
		"Usage notes:\n" +
		'- Users will always be able to select "Other" to provide custom text input\n' +
		"- Use multiSelect: true to allow multiple answers to be selected for a question\n" +
		'- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the header\n\n' +
		'Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.\n\n' +
		"Preview feature:\n" +
		"Use the optional `preview` field on options when presenting concrete artifacts that users need to visually compare:\n" +
		"- ASCII mockups of UI layouts or components\n" +
		"- Code snippets showing different implementations\n" +
		"- Diagram variations\n" +
		"- Configuration examples\n\n" +
		"Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where headers and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).\n\n" +
		"Asynchronous mode (`async: true`):\n" +
		"Provide non-empty context (maximum 2KiB UTF-8) describing the task background, applicability and your action while waiting. Question action=get/list recovers historical items after compact; Question action=resolve confirms handling of a specific latest answerMessageId; Question action=withdraw withdraws open items.\n" +
		"By default this tool BLOCKS until the user answers. Set `async: true` to submit the question without stopping: you get an immediate acknowledgement, keep working with a sensible default, and the user's answer arrives later as a message in the conversation — at which point you adjust.\n" +
		"Use async when ALL of these hold:\n" +
		"- The answer refines the work but does not decide your next action\n" +
		"- There is a reasonable default you can proceed with right now\n" +
		"- Waiting would stall a long task for a small decision\n" +
		"Use the normal blocking mode when the answer changes what you should do next (which architecture, whether to proceed, which file to modify) — guessing there wastes far more work than waiting does.\n" +
		"Batch related questions into ONE async call (up to 4) rather than making several; each call becomes a separate item in the user's inbox.\n" +
		'If you later reach a point where you genuinely cannot proceed without the answer, block on it with `Await({ type: "question", id: "<question id>" })`. That notifies the user that you are now stalled on them, so only do it when a default really will not do — and do it instead of re-asking the same question synchronously.\n' +
		'When an async question stops mattering (you found the answer, the plan changed), withdraw it via `withdraw: ["<id>"]` so the user is not asked something that no longer matters. Do not re-ask a question you already submitted asynchronously.',
	rawJsonSchema: {
		type: "object",
		properties: {
			questions: {
				description: "Questions to ask the user (1-4 questions)",
				minItems: 1,
				maxItems: 4,
				type: "array",
				items: {
					type: "object",
					properties: {
						header: {
							description:
								"SHORT title for this question (about 1-8 words), shown as the heading. Do not put the long prompt here.",
							type: "string",
							minLength: 1,
						},
						description: {
							description:
								"The FULL question text the user reads — background, constraints, and the actual question. Displayed under the header. Put the long prompt here.",
							type: "string",
						},
						options: {
							description:
								"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
							minItems: 2,
							maxItems: 4,
							type: "array",
							items: {
								type: "object",
								properties: {
									header: {
										description:
											'Short title for this option that the user will see and select. Concise (1-5 words). End with "(Recommended)" on the first option if you recommend it.',
										type: "string",
										minLength: 1,
									},
									description: {
										description:
											"Explanation of what this option means or what will happen if chosen.",
										type: "string",
									},
									preview: {
										description:
											"Optional preview content rendered when this option is focused. See the tool description for the expected content format.",
										type: "string",
									},
								},
								required: ["header"],
								additionalProperties: false,
							},
						},
						multiSelect: {
							description:
								"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
							default: false,
							type: "boolean",
						},
					},
					required: ["header", "options"],
					additionalProperties: false,
				},
			},
			answers: {
				description:
					"User answers collected by the permission component, keyed by the question header (uniquified when titles collide)",
				type: "object",
				propertyNames: { type: "string" },
				additionalProperties: { type: "string" },
			},
			annotations: {
				description:
					"Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question header.",
				type: "object",
				propertyNames: { type: "string" },
				additionalProperties: {
					type: "object",
					properties: {
						preview: {
							description:
								"The preview content of the selected option, if the question used previews.",
							type: "string",
						},
						notes: {
							description: "Free-text notes the user added to their selection.",
							type: "string",
						},
					},
					additionalProperties: false,
				},
			},
			context: {
				type: "string",
				description:
					"Required for new async questions: task background, answer applicability and what you will do while waiting. Maximum 2KiB UTF-8.",
			},
			async: {
				description:
					"Set to true to submit the question(s) WITHOUT blocking. You receive an immediate acknowledgement with a question id, keep working with a sensible default, and the user's answer arrives later as a message. Use only when the answer does not decide your next action. Defaults to false (blocking).",
				default: false,
				type: "boolean",
			},
			withdraw: {
				description:
					"Ids of your own previously submitted asynchronous questions that no longer need an answer. Withdrawn questions disappear from the user's inbox. May be sent on its own (omit `questions`) or alongside new questions.",
				type: "array",
				items: { type: "string" },
			},
			metadata: {
				description:
					"Optional metadata for tracking and analytics purposes. Not displayed to user.",
				type: "object",
				properties: {
					source: {
						description:
							'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
						type: "string",
					},
				},
				additionalProperties: false,
			},
		},
		// `questions` stays required in the ADVERTISED schema: asking is what this tool
		// is for. A withdraw-only call is a maintenance action the description explains,
		// and the Zod schema below accepts it.
		required: ["questions"],
		additionalProperties: false,
	},
	parameters: z
		.object({
			questions: z
				.array(
					z.object({
						header: nonEmptyText.describe("SHORT title for this question (about 1-8 words)"),
						description: z
							.string()
							.optional()
							.describe("The FULL question text the user reads — put the long prompt here"),
						options: z
							.array(
								z.object({
									header: nonEmptyText.describe("Short option title shown to the user"),
									description: z
										.string()
										.optional()
										.describe("Explanation of what this option means"),
									preview: z.string().optional(),
								}),
							)
							.describe("Available choices. Provide an empty array for free-form input"),
						multiSelect: z
							.boolean()
							.optional()
							.describe(
								"If true the user can pick multiple options. Defaults to false (single-select)",
							),
					}),
				)
				// Optional (not `.min(1)`) so a withdraw-only maintenance call validates. A
				// call with neither questions nor withdraw ids is rejected by the refinement
				// below rather than silently doing nothing.
				.optional()
				.describe("The list of questions to present to the user"),
			context: z
				.string()
				.optional()
				.describe("Required non-empty background for async=true; maximum 2KiB UTF-8"),
			async: z
				.boolean()
				.optional()
				.describe("Submit without blocking; the answer arrives later as a message"),
			withdraw: z
				.array(z.string())
				.optional()
				.describe("Ids of previously submitted async questions that no longer need an answer"),
		})
		.refine(
			(value) => (value.questions?.length ?? 0) > 0 || (value.withdraw?.length ?? 0) > 0,
			"Provide at least one question, or withdraw ids",
		),

	async execute(args, ctx): Promise<ToolResult> {
		const input = args as Record<string, unknown>;
		try {
			assertRuntimeCanAskQuestion(runtimePolicyForContext(ctx));
			const { assertNarratorCanAskQuestion } = await import(
				"@server/services/narrator-question-service"
			);
			await assertNarratorCanAskQuestion(ctx.narratorId);
		} catch (error) {
			return {
				output: `AskUserQuestion error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
		const answers = input.answers as Record<string, string | string[]> | undefined;

		// Withdrawals run first and independently of the mode: a call may withdraw stale
		// questions while asking new ones, and the withdrawal should take effect even if
		// the new question turns out to be unrecordable.
		const withdrawnNote = await applyWithdrawals(input, ctx);

		// A call carrying answers is the SYNCHRONOUS path completing: the permission gate
		// merged the user's answers into the input and the tool now reports them to the
		// model. This is also how an async question's answers reach the model if the row
		// is ever replayed, so it must stay ahead of the async branch.
		if (answers && Object.keys(answers).length > 0) {
			const lines: string[] = ["User answered:"];
			for (const [key, value] of Object.entries(answers)) {
				if (Array.isArray(value)) {
					lines.push(`- ${key}: ${value.join(", ")}`);
				} else {
					lines.push(`- ${key}: ${value}`);
				}
			}
			return { output: joinSections(withdrawnNote, lines.join("\n")) };
		}

		const questions = Array.isArray(input.questions) ? input.questions : [];

		if (isAsyncAskRequest(input) && questions.length > 0) {
			try {
				return { output: joinSections(withdrawnNote, await submitAsyncQuestions(input, ctx)) };
			} catch (error) {
				return {
					output: joinSections(
						withdrawnNote,
						`Failed to submit asynchronously: ${error instanceof Error ? error.message : String(error)}`,
					),
					isError: true,
				};
			}
		}

		if (questions.length === 0) {
			// Withdraw-only call: the withdrawal note IS the result.
			return { output: withdrawnNote || "No questions were provided." };
		}

		return { output: joinSections(withdrawnNote, "No answers were provided by the user.") };
	},
};

/** Join non-empty sections with a blank line. */
function joinSections(...sections: (string | null | undefined)[]): string {
	return sections
		.map((s) => s?.trim())
		.filter((s): s is string => !!s)
		.join("\n\n");
}

/**
 * Apply a call's `withdraw` list, returning a note for the model (or "" for none).
 *
 * Never throws: a failed withdrawal leaves a stale entry in the user's inbox, which is
 * a cosmetic problem, while failing the tool call would lose the questions the same
 * call may be asking.
 */
async function applyWithdrawals(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	const ids = readWithdrawIds(input);
	if (ids.length === 0) return "";
	try {
		const { withdrawAsyncQuestions } = await import("@server/services/narrator-question-service");
		const { withdrawn, skipped } = await withdrawAsyncQuestions(ctx.narratorId, ids);
		const parts: string[] = [];
		if (withdrawn.length > 0) parts.push(`Withdrew ${withdrawn.length} pending question(s).`);
		if (skipped.length > 0) {
			// Named rather than counted: a skipped id is either already decided or not
			// this narrator's, and the model can only tell which if it knows which id.
			parts.push(
				`Could not withdraw ${skipped.length} id(s) (already answered, dismissed, or not yours): ${skipped.join(", ")}.`,
			);
		}
		return parts.join(" ");
	} catch (err) {
		return `Failed to withdraw questions: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * Record an asynchronous question and tell the model how to behave meanwhile.
 *
 * The acknowledgement is the whole contract with the model, so it states all three
 * things it must do: continue with a default, expect a later message, and not re-ask.
 * Without the last one an agent tends to re-submit the same question a few tool calls
 * later, which is how an inbox becomes unusable.
 */
async function submitAsyncQuestions(
	input: Record<string, unknown>,
	ctx: ToolContext,
): Promise<string> {
	const toolUseId = ctx.currentToolUseId;
	if (!toolUseId) {
		// No tool_use id → no way to anchor the row idempotently. Fall back to the
		// blocking semantics' message rather than recording something unrecoverable.
		return "Could not submit asynchronously (no tool call identity available). Ask again without `async` if you need an answer.";
	}

	try {
		if (ctx.toolCallBinding) {
			const { narratorPersistence } = await import("@server/services/narrator-persistence");
			await narratorPersistence.validateToolCallBinding(
				ctx.narratorId,
				toolUseId,
				ctx.toolCallBinding,
			);
		}
		const [{ db }, { narratorToolCalls }, service, { and, eq }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("@server/services/narrator-question-service"),
			import("drizzle-orm"),
		]);

		// The DB row id is the idempotency anchor and the tool only knows its tool_use
		// id, so resolve one from the other — the same lookup `exit-plan-reflection`
		// does for its own persistence.
		const call = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, ctx.narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
				eq(narratorToolCalls.toolName, "AskUserQuestion"),
				...(ctx.toolCallBinding
					? [
							eq(narratorToolCalls.id, ctx.toolCallBinding.toolCallId),
							eq(narratorToolCalls.executionAttempt, ctx.toolCallBinding.attempt),
						]
					: []),
			),
			columns: { id: true, inputJson: true, permissionDecidedBy: true },
		});
		if (!call) {
			return "Could not submit asynchronously (tool call not found). Ask again without `async` if you need an answer.";
		}

		const persistedInput =
			call.inputJson && typeof call.inputJson === "object"
				? (call.inputJson as Record<string, unknown>)
				: {};
		// This exemption is a permission-component decision, never a model-owned flag.
		const deferredByUser =
			input.deferredByUser === true &&
			call.permissionDecidedBy === "user" &&
			persistedInput.deferredByUser === true &&
			persistedInput.async === true;
		const { record } = await service.createAsyncQuestion({
			narratorId: ctx.narratorId,
			toolCallId: call.id,
			toolUseId,
			// Normalize before persisting so the inbox and answer path share one shape
			// even when a provider still sends legacy field names.
			questions: coerceAskQuestions(input.questions) as AsyncQuestionDefinition[],
			context: typeof input.context === "string" ? input.context : null,
			// ToolContext.userId is server-owned; the answerer's identity must never replace it.
			executionPrincipal: { version: 1, userId: ctx.userId ?? null },
			// `deferredByUser` is set by the permission gate when the user pressed "answer
			// later" on a BLOCKING prompt. Recording that distinction matters for reading
			// the history back: the agent did not choose to defer, the user did.
			origin: deferredByUser ? "user_deferred" : "agent_async",
		});

		const openCount = await service.countOpenAsyncQuestions(ctx.narratorId);
		const deferred = record.origin === "user_deferred";
		const lines = deferred
			? [
					// The agent asked a BLOCKING question and the user chose to answer later. It
					// must not read this as its own request having failed, and it must not
					// re-ask — which is what an agent does when it only learns "no answer".
					`The user chose to answer this question later (id: ${record.id}). They accepted the question; they have not declined it.`,
					"Continue with a sensible default for now. Their answer will arrive as a message in this conversation; adjust your work then.",
					`If you reach a point where you truly cannot proceed without it, wait with Await({ type: "question", id: "${record.id}" }).`,
				]
			: [
					`Question submitted asynchronously (id: ${record.id}). Continue working with a sensible default — do NOT wait and do NOT ask this again.`,
					"The user's answer will arrive as a message in this conversation; adjust your work then.",
					`If you later reach a point where the answer decides your next step, wait with Await({ type: "question", id: "${record.id}" }).`,
					`If it stops mattering, withdraw it: AskUserQuestion({ withdraw: ["${record.id}"] }).`,
				];
		if (openCount >= service.ASYNC_QUESTION_SOFT_LIMIT) {
			lines.push(
				`Note: ${openCount} questions are now waiting for this session. Decide remaining small points yourself, or ask synchronously when you genuinely need an answer.`,
			);
		}
		return lines.join("\n");
	} catch (err) {
		throw new Error(
			`${err instanceof Error ? err.message : String(err)}. Ask again without \`async\` if you need an answer.`,
		);
	}
}
