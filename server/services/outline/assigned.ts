/**
 * The tasks assigned to a session by name that it has not started (outline P2 PR 10a, design
 * §D.3): what the current-tasks view lists under 「指派给你、还没开始」.
 *
 * There is no index by assignee, so they are not searched for on every read. A session's
 * candidates are remembered in memory, at most {@link OUTLINE_ASSIGNED_LIMITS.remembered}:
 *   - every task a team notice told it was assigned to it (`team-events.ts`);
 *   - once per session and process (after a restart, or for a session never told), the open tasks
 *     of its main project's space that name it (`@agent:<its id>` or `@agent:<its handle>`): one
 *     bounded read of that space's open tasks ({@link OUTLINE_ASSIGNED_LIMITS.scan}).
 * A read checks the candidates by primary key and forgets those that no longer count: finished,
 * deleted, started, held by someone, or assigned to someone else. A task assigned through the
 * editor in a space other than the main project's after that first scan is known only from its
 * notice.
 */
import { hotSafe } from "@server/lib/hot-safe";
import { foldHandle } from "@shared/narrator-handle";
import { readNarratorWakeFacts } from "./access-reads";
import { agentAssigneeName } from "./assignee";
import { resolveNarratorSpaces } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineBlockMeta, OutlineStore } from "./store/port";

export const OUTLINE_ASSIGNED_LIMITS = {
	/** Tasks remembered per session. */
	remembered: 20,
	/** Open tasks of the main project's space read once per session. */
	scan: 200,
	/** Sessions remembered at most (the least recently told goes first). */
	sessions: 2000,
} as const;

interface Remembered {
	taskIds: Set<string>;
	/** The main project's space was scanned in this process. */
	scanned: boolean;
}

const sessions = hotSafe("narrafork.outlineAssigned.sessions", () => new Map<string, Remembered>());

function entryOf(narratorId: string): Remembered {
	let entry = sessions.get(narratorId);
	if (entry) {
		// Most recently used last.
		sessions.delete(narratorId);
		sessions.set(narratorId, entry);
		return entry;
	}
	if (sessions.size >= OUTLINE_ASSIGNED_LIMITS.sessions) {
		const [oldest] = sessions.keys();
		if (oldest !== undefined) sessions.delete(oldest);
	}
	entry = { taskIds: new Set(), scanned: false };
	sessions.set(narratorId, entry);
	return entry;
}

function remember(entry: Remembered, taskId: string): void {
	entry.taskIds.delete(taskId);
	entry.taskIds.add(taskId);
	while (entry.taskIds.size > OUTLINE_ASSIGNED_LIMITS.remembered) {
		const [oldest] = entry.taskIds;
		if (oldest === undefined) break;
		entry.taskIds.delete(oldest);
	}
}

/** A team notice told session `narratorId` (a root) that these tasks were assigned to it. */
export function noteOutlineAssignedTasks(narratorId: string, taskIds: readonly string[]): void {
	if (taskIds.length === 0) return;
	const entry = entryOf(narratorId);
	for (const id of taskIds) remember(entry, id);
}

/** Forget everything (tests). */
export function resetOutlineAssignedForTests(): void {
	sessions.clear();
}

/**
 * The open tasks assigned to session `narratorId` (a root) by name that are to do and nobody
 * holds, in the order they were learnt of. Primary-key reads of what is remembered, after the one
 * scan described in the module header.
 */
export async function listOutlineAssignedTasks(
	narratorId: string,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<OutlineBlockMeta[]> {
	const store = options.store ?? outlineStore;
	const entry = entryOf(narratorId);
	const handle = (await readNarratorWakeFacts(narratorId))?.handle ?? null;
	const names = new Set([narratorId, ...(handle ? [foldHandle(handle)] : [])]);
	const mine = (assignee: string | null | undefined): boolean => {
		const name = agentAssigneeName(assignee);
		return name !== null && (names.has(name) || names.has(foldHandle(name)));
	};
	if (!entry.scanned) {
		entry.scanned = true;
		const project = (await resolveNarratorSpaces(narratorId))?.project ?? null;
		if (project) {
			const open = await store.listOpenTasks(project.id, OUTLINE_ASSIGNED_LIMITS.scan);
			for (const task of open) if (mine(task.taskJson?.assignee)) remember(entry, task.id);
		}
	}
	if (entry.taskIds.size === 0) return [];
	const ids = [...entry.taskIds];
	const [metas, claims] = await Promise.all([
		store.getBlockMetasByIds(ids),
		store.getTaskClaims(ids),
	]);
	const now = (options.now ?? new Date()).toISOString();
	const held = new Set(
		claims
			.filter(
				(c) =>
					c.holderUserId !== null ||
					(c.holderNarratorId !== null && (c.expiresAt === null || c.expiresAt > now)),
			)
			.map((c) => c.taskBlockId),
	);
	const byId = new Map(metas.map((m) => [m.id, m]));
	const out: OutlineBlockMeta[] = [];
	for (const id of ids) {
		const meta = byId.get(id);
		if (
			!meta ||
			meta.deleted ||
			meta.taskJson?.status !== "todo" ||
			!mine(meta.taskJson.assignee) ||
			held.has(id)
		) {
			// Finished, started, taken or handed on: no longer waiting for this session.
			entry.taskIds.delete(id);
			continue;
		}
		out.push(meta);
	}
	return out;
}
