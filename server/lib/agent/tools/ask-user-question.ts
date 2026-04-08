import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const askUserQuestionTool: ToolDefinition = {
	name: "AskUserQuestion",
	description:
		"Use this tool when you need to ask the user questions during execution. This allows you to:\n" +
		"1. Gather user preferences or requirements\n" +
		"2. Clarify ambiguous instructions\n" +
		"3. Get decisions on implementation choices as you work\n" +
		"4. Offer choices to the user about what direction to take.\n\n" +
		"Usage notes:\n" +
		'- Users will always be able to select "Other" to provide custom text input\n' +
		"- Use multiSelect: true to allow multiple answers to be selected for a question\n" +
		'- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label\n\n' +
		'Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.\n\n' +
		"Preview feature:\n" +
		"Use the optional `preview` field on options when presenting concrete artifacts that users need to visually compare:\n" +
		"- ASCII mockups of UI layouts or components\n" +
		"- Code snippets showing different implementations\n" +
		"- Diagram variations\n" +
		"- Configuration examples\n\n" +
		"Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).",
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
						question: {
							description:
								'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
							type: "string",
						},
						header: {
							description:
								'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
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
									label: {
										description:
											"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
										type: "string",
									},
									description: {
										description:
											"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
										type: "string",
									},
									preview: {
										description:
											"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
										type: "string",
									},
								},
								required: ["label", "description"],
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
					required: ["question", "header", "options", "multiSelect"],
					additionalProperties: false,
				},
			},
			answers: {
				description: "User answers collected by the permission component",
				type: "object",
				propertyNames: { type: "string" },
				additionalProperties: { type: "string" },
			},
			annotations: {
				description:
					"Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.",
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
		required: ["questions"],
		additionalProperties: false,
	},
	parameters: z.object({
		questions: z
			.array(
				z.object({
					question: z.string().describe("A unique identifier / short key for this question"),
					header: z.string().describe("The question text displayed to the user"),
					options: z
						.array(
							z.object({
								label: z.string().describe("Short label for the option"),
								description: z.string().describe("Longer description shown below the label"),
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
			.min(1)
			.describe("The list of questions to present to the user"),
	}),

	async execute(args, _ctx): Promise<ToolResult> {
		const answers = (args as Record<string, unknown>).answers as
			| Record<string, string | string[]>
			| undefined;

		if (!answers || Object.keys(answers).length === 0) {
			return { output: "No answers were provided by the user." };
		}

		const lines: string[] = ["User answered:"];
		for (const [key, value] of Object.entries(answers)) {
			if (Array.isArray(value)) {
				lines.push(`- ${key}: ${value.join(", ")}`);
			} else {
				lines.push(`- ${key}: ${value}`);
			}
		}

		return { output: lines.join("\n") };
	},
};
