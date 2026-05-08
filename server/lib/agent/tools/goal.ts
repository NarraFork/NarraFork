import { z } from "zod/v4";
import { narratorGoalService } from "../../../services/narrator-goal-service";
import type { ToolDefinition, ToolResult } from "../types";
import { consumeGoalCompletionReflectionGrant } from "./goal-reflection";

function formatGoals(goals: Awaited<ReturnType<typeof narratorGoalService.listGoals>>): string {
	if (goals.length === 0) return "No goals are currently set.";
	return goals
		.map((goal, index) => {
			const usage = `time=${goal.timeUsedSeconds}s tokens=${goal.tokensUsed}`;
			return `${index + 1}. [${goal.status}] ${goal.objective} (${usage})`;
		})
		.join("\n");
}

export const getGoalsTool: ToolDefinition = {
	name: "GetGoals",
	description:
		"Get the current NarraFork goal list for this narrator, including active/pending/paused goals and usage statistics.",
	parameters: z.object({
		confirm: z.literal(true).default(true).describe("Dummy parameter; always pass true."),
	}),
	async execute(_args, ctx): Promise<ToolResult> {
		const goals = await narratorGoalService.listGoals(ctx.narratorId);
		const active = goals.find((goal) => goal.status === "active") ?? null;
		return {
			output: JSON.stringify({ goals, active, summary: formatGoals(goals) }, null, 2),
		};
	},
};

export const addGoalTool: ToolDefinition = {
	name: "AddGoal",
	description:
		"Add a goal to the narrator goal list only when explicitly requested by the user or system/developer instructions. Do not infer goals from ordinary tasks.",
	parameters: z.object({
		objective: z.string().min(1).max(4000).describe("The concrete objective to add."),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { objective } = args as { objective: string };
		const result = await narratorGoalService.createGoal(ctx.narratorId, objective);
		return {
			output: JSON.stringify(
				{
					added: result.created ? result.goal : null,
					alreadyExists: !result.created,
					goal: result.goal,
					goals: result.goals,
					summary: result.created
						? formatGoals(result.goals)
						: `A matching open goal already exists; no duplicate was added.\n${formatGoals(result.goals)}`,
				},
				null,
				2,
			),
		};
	},
};

export const updateGoalTool: ToolDefinition = {
	name: "UpdateGoal",
	description:
		"Update the current active goal. This tool can only mark the active goal complete after NarraFork has run a separate goal-completion reflection gate that verifies the user-provided objective is actually achieved and no required work remains.",
	parameters: z.object({
		status: z
			.literal("complete")
			.describe("Set to complete only when the active goal is achieved."),
	}),
	async execute(_args, ctx): Promise<ToolResult> {
		if (!consumeGoalCompletionReflectionGrant(ctx.narratorId, ctx.currentToolUseId)) {
			return {
				output:
					"UpdateGoal was blocked: completing a user-set goal requires a successful NarraFork goal-completion reflection check first. Continue working or gather concrete verification evidence before trying again.",
				isError: true,
			};
		}
		const result = await narratorGoalService.completeActiveGoal(ctx.narratorId);
		if (!result.completed) {
			return { output: "No active goal exists to complete.", isError: true };
		}
		return {
			output: JSON.stringify(
				{
					completed: result.completed,
					active: result.active,
					goals: result.goals,
					summary: formatGoals(result.goals),
				},
				null,
				2,
			),
		};
	},
};
