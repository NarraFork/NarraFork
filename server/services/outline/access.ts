/**
 * Who may read and write an outline space, person by person.
 *
 *   | space    | read                     | write                     |
 *   |----------|--------------------------|---------------------------|
 *   | project  | the project's read rule  | the project's write rule  |
 *   | personal | its owner                | its owner                 |
 *   | session  | the narrator's read rule | the narrator's write rule |
 *   | orphaned | admins, for cleanup      | nobody                    |
 *
 * A subagent's session space follows its root narrator, as every decision about a subagent does.
 *
 * The project and narrator rules are those of `canReadProject` / `canWriteProject` in
 * `project-acl.ts` and `canReadNarrator` / `canWriteNarrator` in `narrator-acl.ts`: admins,
 * owners, the audiences, the project gate, user grants and grants to the `user` role. They are
 * restated here over `access-reads.ts` because the originals read through the SQLite handle;
 * `__tests__/access-parity.test.ts` holds the two to the same answers.
 *
 * ADMINS do not read other people's personal spaces. A personal space holds a person's own
 * notes, preferences and memory, and the admin's usual reason to look (operating the instance)
 * is served by orphaned spaces being admin-readable and by purging, which is its own path. Admins
 * read and write project and session spaces, as they do projects and sessions.
 *
 * ORPHANED spaces (the project or owner is gone) are frozen: readable by admins so they can be
 * inspected before a purge, writable by nobody.
 *
 * What an agent may READ is narrower than what its user may: see `session-scope.ts`. What it
 * may WRITE is decided per acting user ({@link canAgentWriteSpace}).
 *
 * The rule functions answer for many users in a fixed number of queries, because the session
 * read scope asks "can every one of these people read this?".
 */
import { ValidationError } from "@server/lib/errors";
import { resolveNarratorProjectId } from "../narrator-project";
import {
	type NarratorAccessRow,
	type ProjectAccessRow,
	readJudgedNarrator,
	readNarrator,
	readProject,
	readReadableSpacePage,
	readScopeGrants,
} from "./access-reads";
import type { OutlineSpaceKind } from "./model";
import { isOrphanedSpace } from "./spaces";
import type { OutlineSpaceRow } from "./store/port";

/** The authenticated person, as every route has it. */
export interface OutlinePrincipal {
	userId: string;
	isAdmin: boolean;
}

export type OutlineAccessNeed = "read" | "write";

/** The grant capabilities that satisfy each need, per scope type. */
export const GRANT_CAPABILITIES = {
	project: { read: ["read", "write", "manage"], write: ["write", "manage"] },
	narrator: { read: ["read", "write"], write: ["write"] },
} as const;

export function holdsAnyCapability(
	held: Set<string> | undefined,
	wanted: readonly string[],
): boolean {
	return held !== undefined && wanted.some((cap) => held.has(cap));
}

// ─────────────────────────────────────────────────────────────────────────────
// The project and narrator rules, for many non-admin users at once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of `userIds` hold `need` on the project. For principals that are not admins (admins
 * hold everything); the caller filters them out first.
 *
 * Read: the owner, everyone when the project is public, holders of a read, write or manage
 * grant. Write: the owner, holders of a write or manage grant; visibility never opens write.
 */
export async function projectUsersWith(
	project: ProjectAccessRow,
	userIds: readonly string[],
	need: OutlineAccessNeed,
): Promise<Set<string>> {
	const out = new Set<string>();
	const rest: string[] = [];
	for (const userId of new Set(userIds)) {
		if (!userId) continue;
		if (project.ownerUserId !== null && userId === project.ownerUserId) out.add(userId);
		else if (need === "read" && project.visibility === "public") out.add(userId);
		else rest.push(userId);
	}
	if (rest.length === 0) return out;
	const grants = await readScopeGrants({ type: "project", id: project.id }, rest);
	const wanted = GRANT_CAPABILITIES.project[need];
	const everyUser = holdsAnyCapability(grants.everyUser, wanted);
	for (const userId of rest) {
		if (everyUser || holdsAnyCapability(grants.users.get(userId), wanted)) out.add(userId);
	}
	return out;
}

/** Whether every signed-in user can read the project: it is public, or the `user` role may. */
export async function projectOpenToEveryone(project: ProjectAccessRow): Promise<boolean> {
	if (project.visibility === "public") return true;
	const grants = await readScopeGrants({ type: "project", id: project.id }, []);
	return holdsAnyCapability(grants.everyUser, GRANT_CAPABILITIES.project.read);
}

/**
 * Which of `userIds` hold `need` on the narrator, judged on its root for a subagent. For
 * principals that are not admins.
 *
 * Read: the owner; everyone when visibility is `public`; past the project gate (no project, no
 * gate; a project that is gone admits nobody), everyone when visibility is `project` and the
 * narrator has a project, otherwise holders of a read or write grant.
 *
 * Write: the owner; past the project gate, project members who may write when the write
 * audience is `project`, everyone past the gate when it is `public`, otherwise holders of a
 * write grant.
 */
export async function narratorUsersWith(
	row: NarratorAccessRow,
	userIds: readonly string[],
	need: OutlineAccessNeed,
): Promise<Set<string>> {
	const out = new Set<string>();
	const judged = await readJudgedNarrator(row);
	if (!judged) return out;
	let rest: string[] = [];
	for (const userId of new Set(userIds)) {
		if (!userId) continue;
		if (judged.ownerUserId !== null && userId === judged.ownerUserId) out.add(userId);
		else if (need === "read" && judged.visibility === "public") out.add(userId);
		else rest.push(userId);
	}
	if (rest.length === 0) return out;

	const projectId = await resolveNarratorProjectId(judged);
	let projectWriters = new Set<string>();
	if (projectId !== null) {
		const project = await readProject(projectId);
		if (!project) return out;
		const gate = await projectUsersWith(project, rest, "read");
		rest = rest.filter((userId) => gate.has(userId));
		if (need === "write" && judged.writeAudience === "project") {
			projectWriters = await projectUsersWith(project, rest, "write");
		}
	}

	const byGrant: string[] = [];
	for (const userId of rest) {
		const byAudience =
			need === "read"
				? judged.visibility === "project" && projectId !== null
				: judged.writeAudience === "project"
					? projectId !== null && projectWriters.has(userId)
					: judged.writeAudience === "public";
		if (byAudience) out.add(userId);
		else byGrant.push(userId);
	}
	if (byGrant.length === 0) return out;
	const grants = await readScopeGrants({ type: "narrator", id: judged.id }, byGrant);
	const wanted = GRANT_CAPABILITIES.narrator[need];
	const everyUser = holdsAnyCapability(grants.everyUser, wanted);
	for (const userId of byGrant) {
		if (everyUser || holdsAnyCapability(grants.users.get(userId), wanted)) out.add(userId);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per person
// ─────────────────────────────────────────────────────────────────────────────

async function hasAccess(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	need: OutlineAccessNeed,
): Promise<boolean> {
	const { userId } = principal;
	if (!userId) return false;
	if (isOrphanedSpace(space)) return need === "read" && principal.isAdmin;
	if (space.kind === "personal") return space.ownerUserId === userId;
	if (space.kind === "project" && space.projectId) {
		if (principal.isAdmin) return true;
		const project = await readProject(space.projectId);
		return project !== null && (await projectUsersWith(project, [userId], need)).has(userId);
	}
	if (space.kind === "session" && space.narratorId) {
		if (principal.isAdmin) return true;
		const narrator = await readNarrator(space.narratorId);
		return narrator !== null && (await narratorUsersWith(narrator, [userId], need)).has(userId);
	}
	return false;
}

/** Whether the person may read the space: its pages, history and search results. */
export async function canReadSpace(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
): Promise<boolean> {
	return await hasAccess(principal, space, "read");
}

/** Whether the person may change the space directly. */
export async function canWriteSpace(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
): Promise<boolean> {
	return await hasAccess(principal, space, "write");
}

/**
 * Whether an agent may write the space directly in this turn.
 *
 * Decided by the person the turn runs for (`actingUser`), not by the session's read scope: an
 * agent writes with its user's authority, and every write is a commit attributed to them. A
 * turn with no person behind it (a routine, a system turn) writes nothing directly.
 *
 * A write that returns content from the space (neighbouring blocks, similar existing blocks)
 * is also a read; that content must pass the session's read scope as well.
 */
export async function canAgentWriteSpace(
	actingUser: OutlinePrincipal | null | undefined,
	space: OutlineSpaceRow,
): Promise<boolean> {
	if (!actingUser) return false;
	return await canWriteSpace(actingUser, space);
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_SPACE_PAGE = { default: 50, max: 200 } as const;

export interface ReadableSpacePage {
	spaces: Array<OutlineSpaceRow & { orphaned: boolean }>;
	/** Pass back as `cursor` for the next page; null on the last page. */
	nextCursor: string | null;
}

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

function decodeCursor(cursor: string): string {
	const id = Buffer.from(cursor, "base64url").toString("utf8");
	if (!CURSOR_ID.test(id)) throw new ValidationError("Invalid cursor");
	return id;
}

/**
 * The spaces the person can read, a page at a time in a stable order (by id). The filter runs in
 * SQL, so a page is never short because rows were dropped after the LIMIT.
 *
 * Built on the same readability predicates as the project and narrator lists. Those consider
 * user grants only, so a space readable solely through a grant to the `user` role is missing
 * here although {@link canReadSpace} admits it; the list never shows a space the check refuses.
 * Admins see every space except other people's personal spaces, orphaned ones included.
 */
export async function listReadableSpaces(
	principal: OutlinePrincipal,
	options: { kind?: OutlineSpaceKind; limit?: number; cursor?: string | null } = {},
): Promise<ReadableSpacePage> {
	if (!principal.userId) return { spaces: [], nextCursor: null };
	const requested = Number.isFinite(options.limit)
		? Math.trunc(options.limit as number)
		: OUTLINE_SPACE_PAGE.default;
	const limit = Math.min(Math.max(requested, 1), OUTLINE_SPACE_PAGE.max);
	const rows = await readReadableSpacePage(principal, {
		kind: options.kind,
		afterId: options.cursor ? decodeCursor(options.cursor) : undefined,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		spaces: page.map((space) => ({ ...space, orphaned: isOrphanedSpace(space) })),
		nextCursor:
			rows.length > limit && last ? Buffer.from(last.id, "utf8").toString("base64url") : null,
	};
}
