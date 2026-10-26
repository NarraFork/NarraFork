/**
 * Which outline space belongs to a project, a person or a session, created on first use.
 *
 * Three kinds, one row each (the store's unique indexes make a racing get-or-create resolve to
 * one row):
 *
 *   - project: one per project, shared by the project's people and sessions;
 *   - personal: one per user, their own notes, preferences and memory;
 *   - session: one per primary narrator, the session's working notes.
 *
 * A SUBAGENT USES ITS ROOT'S SESSION SPACE. It has no audience of its own (every access
 * decision about it is made on the root narrator), it works on part of the root's job, and the
 * session that dispatched it keeps the books. Notes it writes therefore land where the root
 * session reads them, under addresses the root can use, and they share the root's lifetime and
 * history: a subagent's narrator row can go away without taking notes with it, and rolling back
 * the root session covers them. The commit still records the subagent as the actor. A subagent
 * whose root cannot be determined has no session space, the same fail-closed answer the access
 * checks give.
 *
 * Forks are primary narrators and get their own session space.
 *
 * Resolving or creating a space is not an access decision: callers check `access.ts` (a person)
 * or `session-scope.ts` (an agent reading) first.
 *
 * Orphaned spaces: a deleted project or user leaves its space behind with the reference cleared
 * (shared history is kept until an explicit purge); {@link isOrphanedSpace} recognizes them.
 * Session spaces are removed with their narrator.
 */
import { NotFoundError } from "@server/lib/errors";
import { resolveNarratorProjectId } from "../narrator-project";
import {
	type NarratorAccessRow,
	readJudgedNarrator,
	readNarrator,
	readProject,
	readUserExists,
} from "./access-reads";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineSpaceScope } from "./store/port";

/** Whether the project, user or narrator that owned the space is gone. */
export function isOrphanedSpace(
	space: Pick<OutlineSpaceRow, "kind" | "projectId" | "ownerUserId" | "narratorId">,
): boolean {
	switch (space.kind) {
		case "project":
			return space.projectId === null;
		case "personal":
			return space.ownerUserId === null;
		case "session":
			return space.narratorId === null;
		default:
			return true;
	}
}

function now(): string {
	return new Date().toISOString();
}

export async function findProjectSpace(projectId: string): Promise<OutlineSpaceRow | null> {
	return await outlineStore.findSpace({ kind: "project", projectId });
}

/** The project's space, created if it does not exist yet. Throws when the project does not. */
export async function ensureProjectSpace(projectId: string): Promise<OutlineSpaceRow> {
	const existing = await findProjectSpace(projectId);
	if (existing) return existing;
	if (!(await readProject(projectId))) throw new NotFoundError("Project", projectId);
	return await outlineStore.ensureSpace({ kind: "project", projectId }, now());
}

export async function findPersonalSpace(userId: string): Promise<OutlineSpaceRow | null> {
	return await outlineStore.findSpace({ kind: "personal", ownerUserId: userId });
}

/** The user's personal space, created if it does not exist yet. Throws when the user does not. */
export async function ensurePersonalSpace(userId: string): Promise<OutlineSpaceRow> {
	const existing = await findPersonalSpace(userId);
	if (existing) return existing;
	if (!(await readUserExists(userId))) throw new NotFoundError("User", userId);
	return await outlineStore.ensureSpace({ kind: "personal", ownerUserId: userId }, now());
}

/**
 * The narrator whose session space `narratorId` uses: itself, or its root for a subagent. Null
 * when the narrator does not exist or a subagent's root cannot be determined.
 */
export async function resolveSessionSpaceNarrator(
	narratorId: string,
): Promise<NarratorAccessRow | null> {
	const row = await readNarrator(narratorId);
	return row ? await readJudgedNarrator(row) : null;
}

export async function findSessionSpace(narratorId: string): Promise<OutlineSpaceRow | null> {
	const owner = await resolveSessionSpaceNarrator(narratorId);
	if (!owner) return null;
	return await outlineStore.findSpace({ kind: "session", narratorId: owner.id });
}

/**
 * The session space `narratorId` writes to (its root's, for a subagent), created if it does not
 * exist yet. Throws when there is none to give: the narrator does not exist, or it is a subagent
 * whose root cannot be determined.
 */
export async function ensureSessionSpace(narratorId: string): Promise<OutlineSpaceRow> {
	const owner = await resolveSessionSpaceNarrator(narratorId);
	if (!owner) throw new NotFoundError("Narrator", narratorId);
	return await outlineStore.ensureSpace({ kind: "session", narratorId: owner.id }, now());
}

export interface NarratorSpaces {
	/** The narrator the spaces belong to: `narratorId` itself, or its root for a subagent. */
	rootNarratorId: string;
	session: OutlineSpaceRow | null;
	/** The session's main project (`resolveNarratorProjectId` on the root), if it has one. */
	projectId: string | null;
	project: OutlineSpaceRow | null;
}

/**
 * The spaces a session works in by default: its session space and its main project's space.
 *
 * A subagent gets its root's, so it reads and writes where the session it belongs to does; the
 * project is the root's main project, the one the session's read scope is decided by. With
 * `create`, missing spaces are created; a main project that no longer exists yields none.
 * Null when the narrator does not exist or its root cannot be determined.
 */
export async function resolveNarratorSpaces(
	narratorId: string,
	options: { create?: boolean } = {},
): Promise<NarratorSpaces | null> {
	const root = await resolveSessionSpaceNarrator(narratorId);
	if (!root) return null;
	const resolved = await resolveNarratorProjectId(root);
	const projectId = resolved !== null && (await readProject(resolved)) ? resolved : null;
	const space = async (scope: OutlineSpaceScope) =>
		options.create
			? await outlineStore.ensureSpace(scope, now())
			: await outlineStore.findSpace(scope);
	return {
		rootNarratorId: root.id,
		session: await space({ kind: "session", narratorId: root.id }),
		projectId,
		project: projectId === null ? null : await space({ kind: "project", projectId }),
	};
}
