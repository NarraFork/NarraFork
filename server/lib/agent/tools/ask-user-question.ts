import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types";

export const askUserQuestionTool: ToolDefinition = {
	name: "AskUserQuestion",
	description:
		"Ask the user one or more questions when you need clarification, preferences, or a decision before proceeding. " +
		"Each question can be free-form or provide a set of options (single-select or multi-select). " +
		"The user's answers are returned so you can continue based on their input.",
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
