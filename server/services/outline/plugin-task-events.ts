/**
 * What plugins follow an outline session's tasks by (outline P2 PR 12a; PR 12 design §2.10): every
 * commit to the session space of an outline root session that changed its tasks becomes one bus
 * event `outline:session_tasks_changed`, which the plugin event gateway publishes as
 * `narrafork.narrator.tasks.changed` (and as `narrafork.narrator.spec.changed` for tasks.json
 * while the old spec commands last: a plugin that followed a spec session's tasks keeps working).
 *
 * WHAT COUNTS
 * -----------
 * A version the commit wrote of a block that is a task after it, or was one before it (created,
 * reworded, moved, its checkbox or fields changed, deleted, brought back, or no longer a task), off
 * the behavior page (its checkboxes are rules). Each is named with its status after the commit:
 * `deleted` for a task deleted, `none` for a block that is no longer a task. At most
 * {@link OUTLINE_PLUGIN_TASK_EVENT_LIMITS.changes} are named (`truncated` says there were more).
 *
 * COST
 * ----
 * Per commit: the space (cached; a space's kind and session never change), the session's backend
 * (cached, `task-source/backend.ts`), the versions the commit wrote without content (at most
 * {@link OUTLINE_PLUGIN_TASK_EVENT_LIMITS.versionsPerCommit}, by `(space_id, seq)`), and, only for
 * versions that are not tasks after the commit, what they were just before (by primary key). The
 * listener only queues the work, never blocks the commit.
 */
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { readTaskBackend } from "../task-source/backend";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_CHANGE } from "./model";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export const OUTLINE_PLUGIN_TASK_EVENT_LIMITS = {
	/** Versions of one commit read (a commit holds at most 200 operations; a subtree more rows). */
	versionsPerCommit: 500,
	/** Changes one event names. */
	changes: 50,
	/** Spaces whose kind and session are kept. */
	spaceCache: 2048,
} as const;

/** A change to a block, which, when a task, the event names. */
const CHANGES =
	OUTLINE_CHANGE.CREATE |
	OUTLINE_CHANGE.CONTENT |
	OUTLINE_CHANGE.MOVE |
	OUTLINE_CHANGE.DELETE |
	OUTLINE_CHANGE.RESTORE |
	OUTLINE_CHANGE.TASK |
	OUTLINE_CHANGE.PAGE;

export type OutlinePluginTaskStatus = "todo" | "doing" | "done" | "cancelled" | "deleted" | "none";

export interface OutlineSessionTasksChanged {
	narratorId: string;
	spaceKey: string;
	seq: number;
	actorKind: "human" | "agent" | "system";
	changes: Array<{ blockId: string; status: OutlinePluginTaskStatus }>;
	truncated: boolean;
}

const spaces = hotSafe(
	"narrafork.outlinePluginTaskEvents.spaces",
	() => new Map<string, Pick<OutlineSpaceRow, "kind" | "narratorId" | "key">>(),
);

async function spaceOf(
	store: OutlineStore,
	spaceId: string,
): Promise<Pick<OutlineSpaceRow, "kind" | "narratorId" | "key"> | null> {
	const cached = spaces.get(spaceId);
	if (cached) return cached;
	const space = await store.getSpace(spaceId);
	if (!space) return null;
	const entry = { kind: space.kind, narratorId: space.narratorId, key: space.key };
	spaces.set(spaceId, entry);
	while (spaces.size > OUTLINE_PLUGIN_TASK_EVENT_LIMITS.spaceCache) {
		const oldest = spaces.keys().next().value;
		if (oldest === undefined) break;
		spaces.delete(oldest);
	}
	return entry;
}

/**
 * What one commit changed of an outline session's tasks, or null when it changed none (or the
 * space is not an outline session's). Reads only.
 */
export async function readSessionTasksChanged(
	event: {
		spaceId: string;
		seq: number;
		actorKind: "human" | "agent" | "system";
	},
	options: { store?: OutlineStore } = {},
): Promise<OutlineSessionTasksChanged | null> {
	const store = options.store ?? outlineStore;
	const space = await spaceOf(store, event.spaceId);
	if (!space || space.kind !== "session" || !space.narratorId) return null;
	const narratorId = space.narratorId;
	if ((await readTaskBackend(narratorId)) !== "outline") return null;
	const versions = await store.listCommitRangeChanges(
		event.spaceId,
		event.seq - 1,
		event.seq,
		OUTLINE_PLUGIN_TASK_EVENT_LIMITS.versionsPerCommit + 1,
	);
	const read = versions.slice(0, OUTLINE_PLUGIN_TASK_EVENT_LIMITS.versionsPerCommit);
	const candidates = read.filter((v) => v.seq === event.seq && (v.changeFlags & CHANGES) !== 0);
	if (candidates.length === 0) return null;
	// A block that is not a task after the commit counts when it was one just before: only a
	// version that changed its task or deleted it can be such (review N3).
	const unknown = candidates.filter(
		(v) =>
			(v.deleted || v.taskJson === null) &&
			(v.changeFlags & OUTLINE_CHANGE.CREATE) === 0 &&
			(v.changeFlags & (OUTLINE_CHANGE.TASK | OUTLINE_CHANGE.DELETE)) !== 0,
	);
	const before = new Map(
		unknown.length === 0
			? []
			: (
					await store.listVersionMetasAt(
						unknown.map((v) => ({ blockId: v.blockId, seq: event.seq - 1 })),
					)
				).map((v) => [v.blockId, v]),
	);
	const rules = new Set(
		(await store.findAliasOwners(event.spaceId, [OUTLINE_BEHAVIOR_ALIAS])).map((o) => o.id),
	);
	const changes: OutlineSessionTasksChanged["changes"] = [];
	for (const v of candidates) {
		if (rules.has(v.pageId)) continue;
		let status: OutlinePluginTaskStatus;
		if (!v.deleted && v.taskJson) status = v.taskJson.status;
		else {
			const prior = before.get(v.blockId);
			if (!prior || prior.deleted || !prior.taskJson) continue;
			status = v.deleted ? "deleted" : "none";
		}
		changes.push({ blockId: v.blockId, status });
	}
	if (changes.length === 0) return null;
	return {
		narratorId,
		spaceKey: space.key,
		seq: event.seq,
		actorKind: event.actorKind,
		changes: changes.slice(0, OUTLINE_PLUGIN_TASK_EVENT_LIMITS.changes),
		truncated:
			changes.length > OUTLINE_PLUGIN_TASK_EVENT_LIMITS.changes ||
			versions.length > OUTLINE_PLUGIN_TASK_EVENT_LIMITS.versionsPerCommit,
	};
}

/** Read a commit and emit its event when it changed an outline session's tasks. */
export async function emitSessionTasksChanged(
	event: { spaceId: string; seq: number; actorKind: "human" | "agent" | "system" },
	options: { store?: OutlineStore } = {},
): Promise<boolean> {
	const changed = await readSessionTasksChanged(event, options);
	if (!changed) return false;
	eventBus.emit({ type: "outline:session_tasks_changed", ...changed });
	return true;
}

const inflight = hotSafe(
	"narrafork.outlinePluginTaskEvents.inflight",
	() => new Set<Promise<unknown>>(),
);

/** Wait for every commit being read (tests). */
export async function settleOutlinePluginTaskEventsForTests(): Promise<void> {
	await Promise.allSettled([...inflight]);
}

/** Listen for commits (once per process; the server starts it with the outline jobs). */
export function startOutlinePluginTaskEvents(): void {
	if (!hotOnce("narrafork.outlinePluginTaskEvents.listener")) return;
	eventBus.on("outline:committed", (event) => {
		if (!isOutlineEnabled()) return;
		const work = emitSessionTasksChanged(event).catch((error) =>
			logger.warn("Failed to read a commit's session task changes", {
				spaceId: event.spaceId,
				seq: event.seq,
				error: String(error),
			}),
		);
		inflight.add(work);
		void work.finally(() => inflight.delete(work));
	});
}
