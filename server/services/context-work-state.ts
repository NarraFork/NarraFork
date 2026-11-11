import {
	type ContextWorkState,
	createContextWorkState,
	MAX_WORK_STATE_RECEIPTS,
	type WorkStateReceipt,
} from "@shared/context-work-state";
import { logger } from "../lib/logger";
import type { NarratorTaskSource, OpenTaskList } from "./task-source";
import { taskSourceForNarrator } from "./task-source";

interface WorkStateNarrator {
	cwd?: string | null;
	defaultDeviceId?: string | null;
	workspaceRevision?: number;
	contextProjectId?: string | null;
	workspaceContext?: { cwd?: string; deviceId?: string; revision?: number } | null;
}
interface WorkStateMessage {
	id: string;
	toolCalls?: ReadonlyArray<{ toolUseId?: string; toolName: string; status: string }> | null;
}

/** No new history scan or tool body read: use the already-authorized compact input. */
export async function captureContextWorkState(
	narratorId: string,
	narrator: WorkStateNarrator,
	messages: readonly WorkStateMessage[],
	source?: NarratorTaskSource,
): Promise<ContextWorkState> {
	const capturedAt = new Date().toISOString();
	const workspace = narrator.workspaceContext;
	const receipts: WorkStateReceipt[] = [];
	let omittedReceipts = 0;
	for (const message of messages) {
		for (const tool of message.toolCalls ?? []) {
			if (!tool.toolUseId) continue;
			if (receipts.length === MAX_WORK_STATE_RECEIPTS) {
				receipts.shift();
				omittedReceipts++;
			}
			receipts.push({
				messageId: message.id,
				toolUseId: tool.toolUseId,
				toolName: tool.toolName,
				status: tool.status,
			});
		}
	}
	let tasks: OpenTaskList | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		tasks = await Promise.race([
			(async () => (source ?? (await taskSourceForNarrator(narratorId))).openTasks())(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Work-state task read timed out")), 1_000);
			}),
		]);
	} catch {
		logger.warn("Work-state tasks unavailable; snapshot is not evidence of no pending work", {
			narratorId,
		});
	} finally {
		clearTimeout(timer);
	}
	const snapshot = createContextWorkState({
		narratorId,
		capturedAt,
		tasks,
		receipts,
		workspace: {
			cwd: workspace?.cwd ?? narrator.cwd ?? null,
			deviceId: workspace?.deviceId ?? narrator.defaultDeviceId ?? null,
			revision: workspace?.revision ?? narrator.workspaceRevision ?? null,
			projectId: narrator.contextProjectId ?? null,
		},
	});
	snapshot.omittedReceipts += omittedReceipts;
	return snapshot;
}
