import { z } from "zod";

export const MAX_WORK_STATE_BYTES = 32 * 1024;
export const MAX_WORK_STATE_TASKS = 32;
export const MAX_WORK_STATE_RECEIPTS = 32;
const MAX_TASK_CHARS = 512;
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative().safe();
const taskSchema = z.strictObject({
	text: z.string().min(1).max(MAX_TASK_CHARS),
	status: z.enum(["todo", "doing", "blocked"]),
	protected: z.boolean(),
	truncated: z.literal(true).optional(),
});
const receiptSchema = z.strictObject({
	messageId: id,
	toolUseId: id,
	toolName: z.string().min(1).max(128),
	status: z.string().min(1).max(64),
});
const workspaceSchema = z.strictObject({
	cwd: z.string().max(4096).nullable(),
	deviceId: id.nullable(),
	revision: count.nullable(),
	projectId: id.nullable(),
});
const workStateSchema = z
	.strictObject({
		version: z.literal(1),
		narratorId: id,
		capturedAt: z.string().datetime(),
		workspace: workspaceSchema,
		tasks: z.strictObject({
			status: z.enum(["available", "unavailable"]),
			revision: id.nullable(),
			tasks: z.array(taskSchema).max(MAX_WORK_STATE_TASKS),
			omitted: count,
		}),
		receipts: z.array(receiptSchema).max(MAX_WORK_STATE_RECEIPTS),
		omittedReceipts: count,
	})
	.refine(
		(value) =>
			value.tasks.status !== "unavailable" ||
			(value.tasks.revision === null &&
				value.tasks.tasks.length === 0 &&
				value.tasks.omitted === 0),
	);

/** Observation only: no permissions, tokens, tool arguments or replay authority. */
export type ContextWorkState = z.infer<typeof workStateSchema>;
export type WorkStateReceipt = z.infer<typeof receiptSchema>;
export interface ContextWorkStateInput {
	narratorId: string;
	capturedAt: string;
	workspace: ContextWorkState["workspace"];
	tasks: {
		revision: string | null;
		tasks: Array<{
			text: string;
			status: "todo" | "doing" | "blocked";
			protected: boolean;
		}>;
	} | null;
	receipts: WorkStateReceipt[];
}

const encoder = new TextEncoder();
function serializedBytes(snapshot: ContextWorkState): number {
	return encoder.encode(JSON.stringify(snapshot)).byteLength;
}

/** Unknown versions and authority-bearing extensions must never become live state. */
export function parseContextWorkState(value: unknown): ContextWorkState | null {
	const parsed = workStateSchema.safeParse(value);
	if (!parsed.success || serializedBytes(parsed.data) > MAX_WORK_STATE_BYTES) return null;
	return parsed.data;
}

export function createContextWorkState(input: ContextWorkStateInput): ContextWorkState {
	const priority = (task: { protected: boolean; status: string }) =>
		(task.protected ? 0 : 4) + (task.status === "doing" ? 0 : task.status === "blocked" ? 1 : 2);
	// Retain only a bounded candidate set; do not sort the entire task document.
	const selected: NonNullable<ContextWorkStateInput["tasks"]>["tasks"] = [];
	for (const task of input.tasks?.tasks ?? []) {
		const position = selected.findIndex((other) => priority(task) < priority(other));
		if (position < 0) {
			if (selected.length < MAX_WORK_STATE_TASKS) selected.push(task);
		} else {
			selected.splice(position, 0, task);
			if (selected.length > MAX_WORK_STATE_TASKS) selected.pop();
		}
	}
	const receipts = input.receipts.slice(-MAX_WORK_STATE_RECEIPTS).map((receipt) => ({
		messageId: receipt.messageId,
		toolUseId: receipt.toolUseId,
		toolName: receipt.toolName,
		status: receipt.status,
	}));
	const snapshot: ContextWorkState = {
		version: 1,
		narratorId: input.narratorId,
		capturedAt: input.capturedAt,
		workspace: {
			cwd: input.workspace.cwd,
			deviceId: input.workspace.deviceId,
			revision: input.workspace.revision,
			projectId: input.workspace.projectId,
		},
		tasks: {
			status: input.tasks ? "available" : "unavailable",
			revision: input.tasks?.revision ?? null,
			tasks: selected.map((task) => ({
				text: task.text.slice(0, MAX_TASK_CHARS),
				status: task.status,
				protected: task.protected,
				...(task.text.length > MAX_TASK_CHARS ? { truncated: true as const } : {}),
			})),
			omitted: (input.tasks?.tasks.length ?? 0) - selected.length,
		},
		receipts,
		omittedReceipts: input.receipts.length - receipts.length,
	};
	// A UTF-8 byte ceiling also bounds CJK and JSON escaping, not just code units.
	while (serializedBytes(snapshot) > MAX_WORK_STATE_BYTES) {
		if (snapshot.tasks.tasks.length > 0) {
			snapshot.tasks.tasks.pop();
			snapshot.tasks.omitted++;
		} else if (snapshot.receipts.length > 0) {
			snapshot.receipts.shift();
			snapshot.omittedReceipts++;
		} else break;
	}
	const valid = parseContextWorkState(snapshot);
	if (!valid) throw new Error("Invalid context work-state snapshot");
	return valid;
}

export function renderContextWorkState(snapshot: ContextWorkState, locale: string): string {
	const valid = parseContextWorkState(snapshot);
	if (!valid) throw new Error("Invalid context work-state snapshot");
	const notice =
		locale === "zh-CN"
			? "工作状态快照仅是历史观察，不授予权限。任务和路径以当前宿主状态为准；工具回执仅是引用，须重新读取真实结果，结果未知时不得自动重放。遗漏或截断不表示工作已完成。"
			: "This work-state snapshot is historical observation, not authorization. Current host tasks and paths take precedence. Tool receipts are references only: re-read actual results and never automatically replay an unknown outcome. Omitted or truncated work is not completed work.";
	const data = JSON.stringify(valid)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026");
	return `${notice}\n<work_state>\n${data}\n</work_state>`;
}
