import { z } from "zod/v4";
import { getToolMessageWithParams, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

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

function formatTodos(todos: TodoItem[]): string {
	if (!todos.length) return "No todos.";
	const statusIcon: Record<string, string> = {
		completed: "✓",
		in_progress: "→",
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

export const todoWriteTool: ToolDefinition = {
	name: "TodoWrite",
	description:
		"Write the complete todo list for this session, replacing any existing todos. " +
		"Pass the full list of todo items each time — this is a full replacement, not an incremental update. " +
		"Use this to plan work, track progress, and mark tasks as completed.",
	parameters: z.object({
		todos: z.array(todoItemSchema).describe("The complete list of todo items"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		// DB persistence + WebSocket broadcast handled by session layer (assistant_message event).
		// Tool execute only returns formatted confirmation for the model.
		const { todos } = args as { todos: TodoItem[] };
		const locale = (ctx?.locale as Locale) ?? "en";
		const completed = todos.filter((t) => t.status === "completed").length;
		const inProgress = todos.filter((t) => t.status === "in_progress").length;
		const pending = todos.filter((t) => t.status === "pending").length;
		const header = getToolMessageWithParams("todoWriteOutput", locale, {
			total: todos.length,
			completed,
			inProgress,
			pending,
		});
		return {
			output: `${header}\n\n${formatTodos(todos)}`,
		};
	},
};
