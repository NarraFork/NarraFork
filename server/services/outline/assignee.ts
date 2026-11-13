/**
 * Who an `@agent:…` assignee names (outline P2 PR 10a, design §D.1 「指派给我」, §E.1).
 *
 * A task's assignee is text (`agent:name`, `human:name`). Two spellings name a SESSION:
 *   - `agent:<narratorId>`: what the task board writes;
 *   - `agent:<handle>`: a named session's handle (matched folded, the unique index
 *     `idx_narrators_handle_fold`).
 * Anything else stays a name: nobody is told, and the agent that wrote it is told so. Only a root
 * session is named: a subagent has no tasks of its own (D27c), so its id or handle resolves to
 * nobody.
 *
 * A session can do a task only where it may write: the person its turns run for (its owner) must
 * be able to write the task's space ({@link canSessionWorkIn}, the rule `OutlineAgentScope`
 * applies to its writes). An agent's hand-over to a session that cannot is refused, so no task is
 * assigned to a session that could never claim it.
 *
 * Reads: the narrator by primary key (or by the handle index), its owner's role; bounded by the
 * names one write carries ({@link OUTLINE_ASSIGNEE_LIMITS.namesPerWrite}).
 */
import { foldHandle } from "@shared/narrator-handle";
import { canAgentWriteSpace } from "./access";
import {
	readDisplayNames,
	readNarrator,
	readNarratorByHandleFold,
	readNonAdminUserIds,
} from "./access-reads";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";

export const OUTLINE_ASSIGNEE_LIMITS = {
	/** Distinct `agent:` names one write resolves; more are refused. */
	namesPerWrite: 20,
} as const;

/** The session an assignee names. */
export interface OutlineAssignedSession {
	/** The root session. */
	narratorId: string;
	/** It, or the session it belongs to, is archived: it does nothing any more. */
	archived: boolean;
}

/** The name after `agent:`, or null when the assignee is not an agent's. */
export function agentAssigneeName(assignee: string | null | undefined): string | null {
	if (!assignee?.startsWith("agent:")) return null;
	const name = assignee.slice("agent:".length);
	return name === "" ? null : name;
}

/** `agent:<narratorId>`: how a hand-over to a session is written. */
export function sessionAssignee(narratorId: string): string {
	return `agent:${narratorId}`;
}

/**
 * The session `assignee` names, or null: not an agent's assignee, a name no session has, or a
 * subagent. An id is tried first (a primary-key read), then a handle.
 */
export async function resolveAgentAssignee(
	assignee: string | null | undefined,
	options: { store?: OutlineStore } = {},
): Promise<OutlineAssignedSession | null> {
	const name = agentAssigneeName(assignee);
	if (name === null) return null;
	const store = options.store ?? outlineStore;
	const byId = (await store.getNarratorRoots([name])).get(name);
	if (byId) {
		// A subagent's id names nobody: its session's tasks are its root's.
		if (byId.root !== name) return null;
		return { narratorId: name, archived: byId.archived || byId.sessionArchived };
	}
	const named = await readNarratorByHandleFold(foldHandle(name.trim()));
	if (!named || named.type === "subagent") return null;
	const session = (await store.getNarratorRoots([named.id])).get(named.id);
	if (!session || session.root !== named.id) return null;
	return { narratorId: named.id, archived: session.archived || session.sessionArchived };
}

/**
 * Whether `assignee` names the session narrator `narratorId` belongs to: the id of the session or
 * of any narrator of it (a subagent's id names its session here: the question is whose work it
 * is), or the session's handle.
 */
export async function assigneeNamesSession(
	assignee: string | null | undefined,
	narratorId: string,
	store: OutlineStore = outlineStore,
): Promise<boolean> {
	const name = agentAssigneeName(assignee);
	if (name === null) return false;
	const roots = await store.getNarratorRoots([...new Set([name, narratorId])]);
	const session = roots.get(narratorId)?.root ?? narratorId;
	const named = roots.get(name);
	if (named) return named.root === session;
	const byHandle = await readNarratorByHandleFold(foldHandle(name.trim()));
	return byHandle !== null && byHandle.id === session;
}

/** Whether `assignee` names the person `userId` (`human:<their username>`). */
export async function assigneeNamesUser(
	assignee: string | null | undefined,
	userId: string,
): Promise<boolean> {
	if (!assignee?.startsWith("human:")) return false;
	const username = (await readDisplayNames({ userIds: [userId] })).users.get(userId);
	return username !== undefined && assignee === `human:${username}`;
}

/**
 * Whether session `narratorId` could work on a task of `space`: the person its turns run for (its
 * owner) may write the space. A session nobody owns can write nothing.
 */
export async function canSessionWorkIn(
	narratorId: string,
	space: OutlineSpaceRow,
): Promise<boolean> {
	return await canOwnerWorkIn((await readNarrator(narratorId))?.ownerUserId ?? null, space);
}

/** {@link canSessionWorkIn} for a session whose owner is known: may that person write the space. */
export async function canOwnerWorkIn(
	owner: string | null,
	space: OutlineSpaceRow,
): Promise<boolean> {
	if (!owner) return false;
	const nonAdmins = await readNonAdminUserIds([owner]);
	return await canAgentWriteSpace({ userId: owner, isAdmin: !nonAdmins.has(owner) }, space);
}

/** What checking a write's `agent:` assignees found. */
export interface OutlineAssigneeCheck {
	/** Names that are a session which cannot work in the space (or is archived): refuse. */
	refused: string[];
	/** Names no session has: written as names, nobody is told. */
	unknown: string[];
	/** The sessions named, by the assignee as written. */
	sessions: Map<string, string>;
}

/**
 * Check the `agent:` assignees an agent's write gives tasks of `space` (design §2.2): each
 * distinct name once.
 */
export async function checkAgentAssignees(
	assignees: readonly (string | null | undefined)[],
	space: OutlineSpaceRow,
	options: { store?: OutlineStore } = {},
): Promise<OutlineAssigneeCheck> {
	const out: OutlineAssigneeCheck = { refused: [], unknown: [], sessions: new Map() };
	const names = [...new Set(assignees.filter((a): a is string => agentAssigneeName(a) !== null))];
	for (const assignee of names.slice(0, OUTLINE_ASSIGNEE_LIMITS.namesPerWrite)) {
		const session = await resolveAgentAssignee(assignee, options);
		const name = agentAssigneeName(assignee) as string;
		if (!session) out.unknown.push(name);
		else if (session.archived || !(await canSessionWorkIn(session.narratorId, space)))
			out.refused.push(name);
		else out.sessions.set(assignee, session.narratorId);
	}
	// More names than one write resolves: the rest are refused rather than written unchecked.
	for (const assignee of names.slice(OUTLINE_ASSIGNEE_LIMITS.namesPerWrite))
		out.refused.push(agentAssigneeName(assignee) as string);
	return out;
}
