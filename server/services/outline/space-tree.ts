/**
 * The connected outline (readability E): spaces as one tree by ownership.
 *
 *   my space
 *   project A                 project spaces, latest commit first
 *     pages…                  (`listSpacePages`)
 *     sessions                the sessions whose project is A
 *       session a1
 *         pages…
 *   other sessions            sessions under no listed project space
 *   spaces without an owner   admins only
 *
 * A node's children are read when it is opened, a page at a time; nothing here returns block
 * content (a page's blocks are the block view's, within its own budget).
 *
 * ACCESS: every listing is filtered in SQL, before its LIMIT, by the project and narrator lists'
 * own readability predicates (`access-reads.ts`): a space the person cannot read is neither
 * listed nor counted, and nothing says it exists. A session is named by its title only here,
 * where it is listed because the person may read it. A session the person reads without reading
 * its project is listed among the other sessions, without the project's name.
 *
 * WHAT A ROW SAYS (readability F): whether the person may write the space, how many questions
 * there wait for THEM (open, put to them, and theirs to answer: none where they may not write),
 * how many tasks are in progress, and one line (the block aliased `summary`, else the task being
 * done, else the one done last; a cancelled task is never it). All of it is of spaces the listing has just returned, so of
 * spaces the person may read; a space they cannot read has no row and adds to no count.
 *
 * COST: the root is one indexed page of project spaces (`OUTLINE_TREE_LIMITS.projects`), the
 * names of what they belong to, three bounded counts, and one bounded count per listed project
 * (its sessions, up to `countCap` rows each), yielding to the event loop between slices. The
 * rows' facts are one statement per page of rows (`readOutlineTreeSpaceFacts`), their lines one
 * read of bounded content prefixes, and the write check the ordinary one per row, in the same
 * slices.
 */
import { ValidationError } from "@server/lib/errors";
import { blockTitle } from "@shared/outline";
import {
	OUTLINE_TREE_LIMITS,
	type OutlineSpaceDetail,
	type OutlineTreeResponse,
	type OutlineTreeSpace,
	type OutlineTreeSpaceSummaryLine,
	type OutlineTreeSpacesResponse,
} from "@shared/outline-api";
import { resolveNarratorProjectId } from "../narrator-project";
import { canWriteSpace, type OutlinePrincipal, projectUsersWith } from "./access";
import {
	countOutlineTreeSpaces,
	type OutlineTreeCursor,
	type OutlineTreeScope,
	type OutlineTreeSpaceRow,
	readNarrator,
	readOutlineTreeSpaceFacts,
	readOutlineTreeSpacePage,
	readProject,
	readProjectName,
} from "./access-reads";
import { yieldToEventLoop } from "./session-scope";
import { findPersonalSpace, findProjectSpace } from "./spaces";
import { outlineStore } from "./store";
import type { OutlineSpaceRow } from "./store/port";
import { OUTLINE_PAGE_HEAD_CHARS } from "./store/read-port";
import { describeSpaces } from "./views";

/** Projects whose sessions are counted between two yields to the event loop. */
const COUNT_SLICE = 10;

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_TIME = /^[\x20-\x7e]{1,64}$/;

function encodeCursor(row: OutlineTreeSpaceRow): string {
	return Buffer.from(JSON.stringify([row.lastCommitAt, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): OutlineTreeCursor {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (Array.isArray(value) && value.length === 2) {
			const [at, id] = value as unknown[];
			if (
				typeof id === "string" &&
				CURSOR_ID.test(id) &&
				(at === null || (typeof at === "string" && CURSOR_TIME.test(at)))
			) {
				return { lastCommitAt: at, id };
			}
		}
	} catch {
		// Fall through to the validation error.
	}
	throw new ValidationError("Invalid cursor");
}

/** A block's first line as a row's one line; null when there is nothing to say. */
function summaryText(head: string | undefined): string | null {
	const line = blockTitle(head ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (line === "") return null;
	const chars = Array.from(line);
	return chars.length <= OUTLINE_TREE_LIMITS.summaryChars
		? line
		: `${chars.slice(0, OUTLINE_TREE_LIMITS.summaryChars - 1).join("")}…`;
}

/**
 * The rows of spaces the listing returned (so: spaces the person may read), with what each says.
 */
async function describeTreeSpaces(
	principal: OutlinePrincipal,
	rows: readonly OutlineTreeSpaceRow[],
): Promise<OutlineTreeSpace[]> {
	const described = await describeSpaces(principal, rows);
	const facts = await readOutlineTreeSpaceFacts(
		principal.userId,
		rows.map((row) => row.id),
		OUTLINE_TREE_LIMITS.countCap,
	);
	const picks = rows.map(
		(row): { kind: OutlineTreeSpaceSummaryLine["kind"]; id: string } | null => {
			const fact = facts.get(row.id);
			if (fact?.summaryId) return { kind: "note", id: fact.summaryId };
			if (fact?.doingId) return { kind: "doing", id: fact.doingId };
			if (fact?.finishedId) return { kind: "finished", id: fact.finishedId };
			return null;
		},
	);
	// Bounded prefixes, never whole bodies.
	const heads = await outlineStore.getContentHeads(
		[
			...picks.flatMap((pick) => (pick ? [pick.id] : [])),
			// The page a waiting question is on, by title (its row when the list has not got it).
			...rows.flatMap((row) => facts.get(row.id)?.waitingPageId ?? []),
		],
		OUTLINE_PAGE_HEAD_CHARS,
	);
	const out: OutlineTreeSpace[] = [];
	for (let i = 0; i < described.length; i++) {
		if (i > 0 && i % COUNT_SLICE === 0) await yieldToEventLoop();
		const row = rows[i] as OutlineTreeSpaceRow;
		const fact = facts.get(row.id);
		const pick = picks[i] ?? null;
		const text = pick ? summaryText(heads.get(pick.id)) : null;
		const canWrite = await canWriteSpace(principal, row);
		out.push({
			...(described[i] as OutlineTreeSpace),
			lastCommitAt: row.lastCommitAt,
			canWrite,
			// Only the person asked answers, and only while they may write the space.
			waiting: canWrite ? (fact?.waiting ?? 0) : 0,
			waitingAt:
				canWrite && fact?.waitingBlockId && fact.waitingPageId
					? {
							pageId: fact.waitingPageId,
							blockId: fact.waitingBlockId,
							pageTitle: summaryText(heads.get(fact.waitingPageId)) ?? "",
						}
					: null,
			doing: fact?.doing ?? 0,
			summary: pick && text ? { kind: pick.kind, text } : null,
		});
	}
	return out;
}

async function page(
	principal: OutlinePrincipal,
	scope: OutlineTreeScope,
	cursor: string | null | undefined,
	limit: number,
): Promise<{ rows: OutlineTreeSpaceRow[]; nextCursor: string | null }> {
	const found = await readOutlineTreeSpacePage(principal, scope, {
		after: cursor ? decodeCursor(cursor) : null,
		limit: limit + 1,
	});
	const rows = found.slice(0, limit);
	const last = rows.at(-1);
	return { rows, nextCursor: found.length > limit && last ? encodeCursor(last) : null };
}

/** The root of the tree: the person's own space, a page of project spaces, the groups' counts. */
export async function readOutlineTree(
	principal: OutlinePrincipal,
	options: { cursor?: string | null } = {},
): Promise<OutlineTreeResponse> {
	if (!principal.userId) {
		return { personal: null, projects: [], nextCursor: null, loose: 0, orphaned: 0 };
	}
	const first = !options.cursor;
	const { rows, nextCursor } = await page(
		principal,
		{ kind: "projects" },
		options.cursor,
		OUTLINE_TREE_LIMITS.projects,
	);
	const projects = await describeTreeSpaces(principal, rows);
	for (let i = 0; i < projects.length; i++) {
		if (i > 0 && i % COUNT_SLICE === 0) await yieldToEventLoop();
		const space = projects[i] as OutlineTreeSpace;
		if (!space.projectId) continue;
		space.sessions = await countOutlineTreeSpaces(
			principal,
			{ kind: "project", projectId: space.projectId },
			OUTLINE_TREE_LIMITS.countCap,
		);
	}
	let personal: OutlineTreeSpace | null = null;
	let loose = 0;
	let orphaned = 0;
	if (first) {
		const own = await findPersonalSpace(principal.userId);
		if (own) {
			// The store's row has no commit time; the person's own space is always first anyway.
			personal = (await describeTreeSpaces(principal, [{ ...own, lastCommitAt: null }]))[0] ?? null;
		}
		loose = await countOutlineTreeSpaces(
			principal,
			{ kind: "loose" },
			OUTLINE_TREE_LIMITS.countCap,
		);
		if (principal.isAdmin) {
			orphaned = await countOutlineTreeSpaces(
				principal,
				{ kind: "orphaned" },
				OUTLINE_TREE_LIMITS.countCap,
			);
		}
	}
	return { personal, projects, nextCursor, loose, orphaned };
}

/**
 * A page of the session spaces of one group: a project's sessions (the caller has checked that
 * the person may read the project), the sessions under no listed project, or (admins; anyone
 * else gets none) the spaces whose owner is gone.
 */
export async function listOutlineTreeSpaces(
	principal: OutlinePrincipal,
	scope: Exclude<OutlineTreeScope, { kind: "projects" }>,
	options: { cursor?: string | null } = {},
): Promise<OutlineTreeSpacesResponse> {
	if (!principal.userId || (scope.kind === "orphaned" && !principal.isAdmin)) {
		return { spaces: [], nextCursor: null };
	}
	const { rows, nextCursor } = await page(
		principal,
		scope,
		options.cursor,
		OUTLINE_TREE_LIMITS.sessions,
	);
	return { spaces: await describeTreeSpaces(principal, rows), nextCursor };
}

/**
 * Where a session space hangs in the tree: the space of the session's project, when it exists
 * and the person may read the project (the breadcrumbs' project crumb). Null for any other
 * space, and whenever the answer would name a project the person cannot read.
 */
export async function readSpaceParent(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
): Promise<OutlineSpaceDetail["parent"]> {
	if (space.kind !== "session" || !space.narratorId) return null;
	const narrator = await readNarrator(space.narratorId);
	if (!narrator) return null;
	const projectId = await resolveNarratorProjectId(narrator);
	if (!projectId) return null;
	const project = await readProject(projectId);
	if (!project) return null;
	if (
		!principal.isAdmin &&
		!(await projectUsersWith(project, [principal.userId], "read")).has(principal.userId)
	) {
		return null;
	}
	const parent = await findProjectSpace(projectId);
	if (!parent) return null;
	return { spaceId: parent.id, label: await readProjectName(projectId) };
}
