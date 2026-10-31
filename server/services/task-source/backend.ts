/**
 * The task backend read.
 *
 * A leaf on purpose: services the task sources read through (Dynamic Spec) may ask it too, and
 * they may not import `task-source/index.ts`.
 */
import { readNarratorTaskBackend } from "../outline/access-reads";
import { isOutlineEnabled } from "../outline/feature";
import type { TaskBackend } from "./types";

/**
 * The narrator's task backend: its session's `narrators.task_backend` (a subagent's root's),
 * one small indexed read. `spec` for a narrator that does not exist, and for every narrator
 * while the outline is switched off (see `resolveTaskBackend`).
 */
export async function readTaskBackend(narratorId: string): Promise<TaskBackend> {
	if (!isOutlineEnabled()) return "spec";
	const row = await readNarratorTaskBackend(narratorId);
	return row?.backend === "outline" ? "outline" : "spec";
}
