import { and, eq, or } from "drizzle-orm";
import { backgroundTasks, narrators, narratorToolCalls } from "../db/schema";
import { parseSubstatus } from "../lib/narrator-utils";
import type { RuntimeTx } from "./agent-runtime/mailbox-types";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";

export const RESTART_NARRATOR_COLUMNS = {
	id: true,
	status: true,
	substatus: true,
	logicalRunId: true,
	runtimeRegistrationJson: true,
} as const;
export const RESUME_SUBAGENT_COLUMNS = {
	...RESTART_NARRATOR_COLUMNS,
	policySourceNarratorId: true,
	backgroundStatus: true,
	backgroundCompletedAt: true,
	title: true,
	subagentType: true,
} as const;
export type ResumeSubagent = Pick<
	typeof narrators.$inferSelect,
	keyof typeof RESUME_SUBAGENT_COLUMNS
>;
export type ParentRecoveryTurn = { id: string; turnStartedAt: string | null };
export type AgentTaskObservation = Pick<
	typeof backgroundTasks.$inferSelect,
	"id" | "type" | "status" | "parentNarratorId" | "subagentNarratorId" | "logicalRunId"
>;
export const AGENT_TASK_OBSERVATION_COLUMNS = {
	id: backgroundTasks.id,
	type: backgroundTasks.type,
	status: backgroundTasks.status,
	parentNarratorId: backgroundTasks.parentNarratorId,
	subagentNarratorId: backgroundTasks.subagentNarratorId,
	logicalRunId: backgroundTasks.logicalRunId,
};
export function observeAgentTask(row: AgentTaskObservation): AgentTaskObservation {
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		parentNarratorId: row.parentNarratorId,
		subagentNarratorId: row.subagentNarratorId,
		logicalRunId: row.logicalRunId,
	};
}
export function assertRecoveryFields(expected: object | null, current: object | undefined): void {
	if (expected === null) {
		if (current) throw new RuntimeReadConflictError();
	} else assertObservation(expected, current);
}
export const RESTART_TOOL_COLUMNS = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	toolUseId: narratorToolCalls.toolUseId,
	messageId: narratorToolCalls.messageId,
	status: narratorToolCalls.status,
	executionStartedAt: narratorToolCalls.executionStartedAt,
	fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
	executionAttempt: narratorToolCalls.executionAttempt,
	executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	permissionSuggestions: narratorToolCalls.permissionSuggestions,
};
export const RESTART_TASK_COLUMNS = {
	id: backgroundTasks.id,
	alias: backgroundTasks.alias,
	status: backgroundTasks.status,
	parentNarratorId: backgroundTasks.parentNarratorId,
	subagentNarratorId: backgroundTasks.subagentNarratorId,
	logicalRunId: backgroundTasks.logicalRunId,
	type: backgroundTasks.type,
};
export type RestartNarrator = Pick<
	typeof narrators.$inferSelect,
	keyof typeof RESTART_NARRATOR_COLUMNS
>;
export type RestartTool = Pick<
	typeof narratorToolCalls.$inferSelect,
	keyof typeof RESTART_TOOL_COLUMNS
>;
type RestartTask = Pick<typeof backgroundTasks.$inferSelect, keyof typeof RESTART_TASK_COLUMNS>;
export interface RestartRecoveryObservation {
	narrator: RestartNarrator;
	tool?: RestartTool;
	task?: RestartTask | null;
}

export function assertRecoveryRunAdmission(
	expected: RestartNarrator,
	current:
		| (Omit<RestartNarrator, "runtimeRegistrationJson" | "status"> & {
				runtimeRegistrationJson: unknown;
				status: string;
		  })
		| undefined,
): void {
	if (
		!current ||
		current.id !== expected.id ||
		current.logicalRunId !== expected.logicalRunId ||
		JSON.stringify(current.runtimeRegistrationJson) !==
			JSON.stringify(expected.runtimeRegistrationJson) ||
		current.status !== "working" ||
		parseSubstatus(current.substatus).some((tag) =>
			["error", "interrupted", "taken_over", "manual_override", "cancelled"].includes(tag),
		)
	)
		throw new RuntimeReadConflictError();
}

function assertObservation(expected: object, current: object | undefined): void {
	if (
		!current ||
		Object.entries(expected).some(
			([key, value]) =>
				JSON.stringify(value) !== JSON.stringify((current as Record<string, unknown>)[key]),
		)
	)
		throw new RuntimeReadConflictError();
}

export function assertRestartRecoveryObservation(
	tx: RuntimeTx,
	expected: RestartRecoveryObservation,
): void {
	assertObservation(
		expected.narrator,
		tx.query.narrators
			.findFirst({
				where: eq(narrators.id, expected.narrator.id),
				columns: RESTART_NARRATOR_COLUMNS,
			})
			.sync(),
	);
	if (expected.tool)
		assertObservation(
			expected.tool,
			tx
				.select(RESTART_TOOL_COLUMNS)
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, expected.tool.id))
				.get(),
		);
	if (expected.task !== undefined) {
		const rows = tx
			.select(RESTART_TASK_COLUMNS)
			.from(backgroundTasks)
			.where(
				and(
					eq(backgroundTasks.type, "agent"),
					or(
						eq(backgroundTasks.subagentNarratorId, expected.narrator.id),
						eq(backgroundTasks.id, expected.narrator.id),
					),
				),
			)
			.limit(2)
			.all();
		if (expected.task === null) {
			if (rows.length) throw new RuntimeReadConflictError();
		} else {
			if (rows.length !== 1) throw new RuntimeReadConflictError();
			assertObservation(expected.task, rows[0]);
		}
	}
}
