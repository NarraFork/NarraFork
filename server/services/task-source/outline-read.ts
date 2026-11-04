/**
 * The reads the outline task source and its built-in views share: whose tasks a narrator's are
 * (its session and session space) and the session's open tasks (`findContinuationCandidates`,
 * with waiting derived, never stored: D27b). Every read is bounded and indexed; see
 * `outline.ts` for what each task state means to readers.
 */
import { blockTitle } from "@shared/outline";
import { OUTLINE_BEHAVIOR_ALIAS } from "../outline/model";
import { outlineStore } from "../outline/store";
import { isApprovedPlanRoot } from "../outline/task-json";
import {
	findContinuationCandidates,
	type OutlineTaskRef,
	type OutlineTaskWait,
} from "../outline/tasks";
import { readTaskSession } from "./backend";
import type { OpenTaskStatus } from "./types";

/** Candidates, and waiting tasks, one read of the session's open tasks takes (each). */
export const OUTLINE_OPEN_TASKS_READ = 50;

/** The narrator a source is bound to, and the session its tasks belong to. */
export interface OutlineSession {
	narratorId: string;
	/** A subagent: no tasks of its own (D27c). */
	subagent: boolean;
	/** The session (the narrator, or a subagent's root); null when a subagent's root is gone. */
	sessionNarratorId: string | null;
	/** The session space; null until something was written to it. */
	spaceId: string | null;
}

export async function readOutlineSession(narratorId: string): Promise<OutlineSession> {
	const row = await readTaskSession(narratorId);
	const sessionNarratorId = row ? row.sessionNarratorId : narratorId;
	const space =
		sessionNarratorId === null
			? null
			: await outlineStore.findSpace({ kind: "session", narratorId: sessionNarratorId });
	return {
		narratorId,
		subagent: row?.subagent === true,
		sessionNarratorId,
		spaceId: space?.id ?? null,
	};
}

/**
 * The narrator's session, read once and kept; a session space that did not exist yet is looked
 * for again on every call (it appears with the session's first write), so a reader kept across
 * that write does not read an empty session from then on.
 */
export function outlineSessionReader(narratorId: string): () => Promise<OutlineSession> {
	let sessionPromise: Promise<OutlineSession> | undefined;
	return async () => {
		sessionPromise ??= readOutlineSession(narratorId);
		const current = await sessionPromise.catch((error) => {
			sessionPromise = undefined;
			throw error;
		});
		if (current.spaceId === null && !current.subagent && current.sessionNarratorId !== null) {
			const space = await outlineStore.findSpace({
				kind: "session",
				narratorId: current.sessionNarratorId,
			});
			if (space) current.spaceId = space.id;
		}
		return current;
	};
}

/** One open task of the session, before its text is read. */
export interface OpenEntry {
	ref: OutlineTaskRef;
	wait: OutlineTaskWait | null;
	status: OpenTaskStatus;
}

export interface OpenRead {
	entries: OpenEntry[];
	truncated: boolean;
}

/**
 * The session's open tasks. A checkbox on its behavior page is a rule as the person wrote it,
 * never a task of the session: the agent could not tick it (the page is not its to write), so it
 * is left out of every reader (continuation, the views, the interrupt guard, the turn-end note).
 */
export async function readOpen(session: OutlineSession): Promise<OpenRead> {
	if (session.subagent || session.sessionNarratorId === null) {
		return { entries: [], truncated: false };
	}
	const behavior = session.spaceId
		? await outlineStore.findAliasOwners(session.spaceId, [OUTLINE_BEHAVIOR_ALIAS])
		: [];
	const found = await findContinuationCandidates({
		narratorId: session.sessionNarratorId,
		sessionSpaceId: session.spaceId,
		// A page's blocks carry its id as their page; an alias on a nested block matches none.
		excludePageIds: behavior.map((owner) => owner.id),
		limit: OUTLINE_OPEN_TASKS_READ,
	});
	return {
		entries: found.ordered.map(({ wait, ...ref }) => ({
			ref,
			wait,
			status: wait ? "blocked" : ref.status,
		})),
		truncated: found.truncated,
	};
}

/**
 * Work a person wants done (D27a; D48 Q2): a task they created (`/goal`, the board), or the root
 * of a plan they approved (a draft or locked). `protectedOnly` continues while one is open.
 */
export function isProtected(entry: OpenEntry): boolean {
	return entry.ref.taskJson.humanCreated === true || isApprovedPlanRoot(entry.ref.taskJson);
}

/**
 * The first task of `status` continuation may name (D48 Q2): never a container (a task with
 * unfinished tasks under it), whose work is theirs; and one of the tree being worked (under a task
 * in progress) before any other, each in document order.
 */
export function firstOf(read: OpenRead, status: OpenTaskStatus): OpenEntry | null {
	let other: OpenEntry | null = null;
	for (const entry of read.entries) {
		if (entry.status !== status || entry.ref.container) continue;
		if (entry.ref.inWorkedTree) return entry;
		other ??= entry;
	}
	return other;
}

/**
 * The first task under `rootId` (or the root itself, when nothing is under it) that continuation
 * may name with `status`, in the read's order: a step of the tree a person asked to start or
 * approved (outline P2 PR 8).
 */
export function firstUnder(
	read: OpenRead,
	rootId: string,
	status: OpenTaskStatus,
): OpenEntry | null {
	return (
		read.entries.find(
			(entry) =>
				entry.status === status &&
				!entry.ref.container &&
				(entry.ref.blockId === rootId || entry.ref.taskAncestorIds.includes(rootId)),
		) ?? null
	);
}

/** The titles of the given tasks, read in one statement. */
export async function titlesOf(entries: readonly OpenEntry[]): Promise<Map<string, string>> {
	const ids = [...new Set(entries.map((entry) => entry.ref.blockId))];
	const out = new Map<string, string>();
	if (ids.length === 0) return out;
	for (const block of await outlineStore.getBlocks(ids)) {
		out.set(block.id, blockTitle(block.content) || block.sid);
	}
	return out;
}
