import { getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";

type TodoItem = {
	id?: string;
	content?: string;
	status?: string;
	priority?: string;
	activeForm?: string;
};

function formatTodoLines(todos: TodoItem[]): string {
	const statusIcon: Record<string, string> = {
		completed: "✓",
		in_progress: "→",
		pending: "○",
	};
	return todos
		.map((todo) => {
			const icon = statusIcon[todo.status ?? "pending"] ?? "○";
			const id = todo.id ? `[${todo.id}] ` : "";
			const content = todo.content || todo.activeForm || "—";
			const priority = todo.priority && todo.priority !== "medium" ? ` [${todo.priority}]` : "";
			return `${icon} ${id}${content}${priority}`;
		})
		.join("\n");
}

function getValidTodos(todosJson: unknown): TodoItem[] {
	if (!Array.isArray(todosJson) || todosJson.length === 0) return [];
	return todosJson.filter((todo): todo is TodoItem => {
		return !!todo && typeof todo === "object" && !Array.isArray(todo);
	});
}

export function buildTodoToolResultReminder(todosJson: unknown, locale: Locale): string | null {
	const pending = getValidTodos(todosJson).filter((todo) => todo.status !== "completed");
	if (pending.length === 0) return null;

	const lines = formatTodoLines(pending);
	return getToolMessageWithParams("todoReminder", locale, { todos: lines });
}

export function buildTodoCompactContext(todosJson: unknown, locale: Locale): string | null {
	const todos = getValidTodos(todosJson);
	if (todos.length === 0) return null;

	return getToolMessageWithParams("compactCurrentTodos", locale, {
		todos: formatTodoLines(todos),
	});
}
