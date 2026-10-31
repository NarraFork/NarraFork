/**
 * The task backend read and the guard that keeps Dynamic Spec writes out of outline sessions.
 *
 * A leaf on purpose: `spec-vfs-service` asks it before writing, and the task sources themselves
 * read spec files, so neither may import the other through `task-source/index.ts`.
 */
import { catalogError } from "../../lib/errors";
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

/**
 * Refuse a Dynamic Spec write for an outline session: it would land where neither the session
 * nor its continuation look. Only `behavior_fence` stays writable (by the person and plugins):
 * until the behavior-fence page exists (plan PR 4) it is the fence an outline session gets.
 * `path` is the normalized spec path (`tasks.json`, `index.md`, …).
 */
export async function assertSpecWritable(narratorId: string, path: string): Promise<void> {
	if (path === "behavior_fence") return;
	if ((await readTaskBackend(narratorId)) === "outline") {
		throw catalogError("SPEC_IN_OUTLINE_SESSION");
	}
}
