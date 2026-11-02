/**
 * The task backend read, its cache, and the guard that keeps Dynamic Spec out of outline sessions.
 *
 * A leaf on purpose: `spec-vfs-service` asks it before writing, and the task sources themselves
 * read spec files, so neither may import the other through `task-source/index.ts`.
 *
 * CACHE
 * -----
 * `narrators.task_backend` is written when a session is created and changes only when the import
 * (plan PR 12) moves a session to the outline; a subagent's root never changes. So what a narrator
 * resolves to (its session, the session's column) is kept in memory after the first read and
 * served from there: a turn costs no read for it, a failing database does not flip an outline
 * session to spec for a pass, and the outline source does not read the row a second time. Whatever
 * changes the column calls {@link invalidateTaskBackend}; a deleted narrator is dropped on
 * `narrator:deleted`. The cache holds at most {@link MAX_CACHED} narrators, the least recently
 * used dropped first. `outline.enabled` is applied on every call, never cached.
 */
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { catalogError } from "../../lib/errors";
import { isOutlineEnabled } from "../outline/feature";
import type { TaskBackend } from "./types";

/** The session a narrator's tasks belong to, as cached. */
export interface TaskSession {
	/** The session's `task_backend` column (a subagent's root's), whatever the switch says. */
	backend: TaskBackend;
	subagent: boolean;
	/** The narrator itself, or a subagent's root; null when that root is not known. */
	sessionNarratorId: string | null;
}

const MAX_CACHED = 4096;

const cache = hotSafe("narrafork.taskBackend.sessions", () => new Map<string, TaskSession>());

/**
 * The session of a narrator: from the cache, else one primary-key read (cached when the narrator
 * exists). Null for a narrator that does not exist. A failed read rejects.
 */
export async function readTaskSession(narratorId: string): Promise<TaskSession | null> {
	const cached = cache.get(narratorId);
	if (cached) {
		// Most recently used last.
		cache.delete(narratorId);
		cache.set(narratorId, cached);
		return cached;
	}
	// Loaded on first use: this module is a leaf that `spec-vfs-service` and `narrator-service`
	// import statically, and the outline read pulls in the database module's full surface.
	const { readNarratorTaskBackend } = await import("../outline/access-reads");
	const row = await readNarratorTaskBackend(narratorId);
	if (!row) return null;
	const session: TaskSession = {
		backend: row.backend === "outline" ? "outline" : "spec",
		subagent: row.subagent,
		sessionNarratorId: row.sessionNarratorId,
	};
	cache.set(narratorId, session);
	while (cache.size > MAX_CACHED) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return session;
}

/**
 * Forget what is cached for a narrator and for every narrator whose session it is (its
 * subagents), or for everyone without an argument. The import that moves a session to the outline
 * (plan PR 12) calls it after writing the column.
 */
export function invalidateTaskBackend(narratorId?: string): void {
	if (narratorId === undefined) {
		cache.clear();
		return;
	}
	for (const [id, session] of cache) {
		if (id === narratorId || session.sessionNarratorId === narratorId) cache.delete(id);
	}
}

if (hotOnce("narrafork.taskBackend.listeners")) {
	// A deleted narrator (and, for a deleted session, its subagents' link to it) is forgotten.
	eventBus.on("narrator:deleted", (event) => invalidateTaskBackend(event.narratorId));
}

/**
 * The narrator's task backend: its session's column, `spec` for a narrator that does not exist,
 * and `spec` for everyone while the outline is switched off (see `resolveTaskBackend`).
 */
export async function readTaskBackend(narratorId: string): Promise<TaskBackend> {
	if (!isOutlineEnabled()) return "spec";
	return (await readTaskSession(narratorId))?.backend ?? "spec";
}

/**
 * Refuse a Dynamic Spec write for an outline session: it would land where neither the session
 * nor its continuation look. Only `behavior_fence` stays writable: until the behavior-fence page
 * exists (plan PR 4) it is the fence an outline session gets, written by the person (the Spec
 * panel), by plugins (the team SOP), and by the agent itself once per real user turn when the
 * user asks it to record a rule (the same one-shot grant as in a spec session). `path` is the
 * normalized spec path (`tasks.json`, `index.md`, …; empty for the whole namespace).
 */
export async function assertSpecWritable(narratorId: string, path: string): Promise<void> {
	if (path === "behavior_fence") return;
	await assertSpecTasksUsed(narratorId);
}

/**
 * Refuse a Dynamic Spec task read or write for an outline session (a plugin's task commands):
 * its tasks are not there, and an empty answer would read as an idle session.
 */
export async function assertSpecTasksUsed(narratorId: string): Promise<void> {
	if ((await readTaskBackend(narratorId)) === "outline") {
		throw catalogError("SPEC_IN_OUTLINE_SESSION");
	}
}
