import { z } from "zod/v4";
import { broadcastSpecChanged } from "../../../services/spec-broadcast";
import {
	buildSpecTasksDocumentFromLegacyTodos,
	parseSpecTasksDocument,
	type SpecTaskItem,
	serializeSpecTasksDocument,
} from "../../../services/spec-task-service";
import { specVfsService } from "../../../services/spec-vfs-service";
import { getToolMessageWithParams, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";
import { consumeTaskReflectionGrant } from "./task-reflection";

const todoItemSchema = z.object({
	id: z.string().describe("Short unique identifier for the todo item"),
	content: z.string().describe("Description of the task"),
	status: z
		.enum(["pending", "in_progress", "completed"])
		.describe("Current status of the todo item"),
	priority: z
		.enum(["high", "medium", "low"])
		.optional()
		.describe("Priority level (default: medium)"),
});

type TodoItem = { id: string; content: string; status: string; priority?: string };

function specStatusToLegacyStatus(status: SpecTaskItem["status"]): string {
	if (status === "done") return "completed";
	if (status === "doing") return "in_progress";
	if (status === "blocked") return "blocked";
	return "pending";
}

function specTasksToLegacyTodos(tasks: SpecTaskItem[]): TodoItem[] {
	return tasks.map((task, index) => ({
		id: `spec-${index + 1}`,
		content: task.text,
		status: specStatusToLegacyStatus(task.status),
		...(task.protected ? { priority: "high" } : {}),
	}));
}

function formatTodos(todos: TodoItem[]): string {
	if (!todos.length) return "No todos.";
	const statusIcon: Record<string, string> = {
		completed: "✓",
		in_progress: "→",
		blocked: "!",
		pending: "○",
	};
	return todos
		.map((t) => {
			const icon = statusIcon[t.status] ?? "?";
			const pri = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : "";
			return `${icon} [${t.id}] ${t.content}${pri}`;
		})
		.join("\n");
}

export const taskCreateTool: ToolDefinition = {
	name: "TaskCreate",
	description:
		"Compatibility wrapper for the Living Work Spec task queue. " +
		"Writes the complete task list to spec://tasks.json, replacing existing non-protected tasks. " +
		"For new work, prefer editing spec://tasks.json directly with the minimal text/status/protected format.",
	parameters: z.object({
		todos: z.array(todoItemSchema).describe("The complete list of todo items"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { todos } = args as { todos: TodoItem[] };
		const locale = (ctx?.locale as Locale) ?? "en";
		let syncedTodos: TodoItem[] = todos;
		try {
			const current = await specVfsService.readTasksFileForNarrator(ctx.narratorId);
			const currentDocument = parseSpecTasksDocument(current.content);
			const nextDocument = buildSpecTasksDocumentFromLegacyTodos(todos, currentDocument);
			const taskReflectionGranted = consumeTaskReflectionGrant(
				ctx.narratorId,
				ctx.currentToolUseId,
			);
			const written = await specVfsService.writeSpecFile(
				ctx.narratorId,
				"spec://tasks.json",
				serializeSpecTasksDocument(nextDocument),
				{
					sourceToolUseId: ctx.currentToolUseId ?? null,
					allowProtectedTaskMutation: taskReflectionGranted,
				},
			);
			broadcastSpecChanged(ctx.narratorId, written, "task_create");
			syncedTodos = specTasksToLegacyTodos(parseSpecTasksDocument(written.content).tasks);
		} catch (err) {
			return {
				output: `Error updating spec://tasks.json: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
		const displayTodos = syncedTodos;
		const completed = displayTodos.filter((t) => t.status === "completed").length;
		const inProgress = displayTodos.filter((t) => t.status === "in_progress").length;
		const pending = displayTodos.filter((t) => t.status === "pending").length;
		const blocked = displayTodos.filter((t) => t.status === "blocked").length;
		const header = getToolMessageWithParams("todoWriteOutput", locale, {
			total: displayTodos.length,
			completed,
			inProgress,
			pending,
			blocked,
		});
		return {
			output: `${header}\n\n${formatTodos(displayTodos)}\n\nUpdated spec://tasks.json.`,
			metadata: { todos: syncedTodos },
		};
	},
};
