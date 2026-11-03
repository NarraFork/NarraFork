/**
 * The outline HTTP API, mounted at `/api/outline` behind session auth. Read-only views of
 * spaces, pages, history, backlinks and search, plus reverting a commit, locks and pending
 * changes, and the task board's changes to single tasks; editing pages goes through the page's
 * live session over WebSocket, not through here.
 *
 * GATES, IN ORDER
 * ---------------
 *   1. `outline.enabled` off: every route answers 404, exactly as an unknown route would.
 *   2. A space the person may not read answers 404, the same as a space that does not exist,
 *      and so does everything inside it (blocks, pages, commits): nothing tells whether it
 *      exists. A block or page asked for under the wrong space is also 404.
 *   3. Readable but not writable answers 403 where writing is asked for (revert).
 *   4. Resolving a reference or a commit (`/resolve`) consults one space, and answers 404 alike
 *      for a space or block that does not exist, one the person cannot read, and a reference
 *      that names several blocks.
 *   5. A person's view state of a page (`/view-state/:pageId`: folding and the mind map's
 *      direction) needs only read access: it is their own view, never a commit. A page they
 *      cannot read, a block that is not a page, and a deleted page are 404.

 *   6. Locks and pending changes (design §2.2, §2.6; P2 PR 6): a page's pending changes and a
 *      change's diff need read access to its space (a change in a space the person cannot read
 *      is 404). Locking needs write access to the space, and a delegate session the person may
 *      write (404 when they cannot read it, 403 when they cannot write it); unlocking is for the
 *      locker, a manager of the space or an admin (403 otherwise); confirming and rejecting are
 *      for the person who locked the plan (403 otherwise; a session confirms through
 *      `OutlineEdit`).
 *   7. The task board (P2 PR 5): a session's board needs read access to the session, a project's
 *      board read access to the project, and lists only the session spaces the person may read.
 *      Adding a task needs write access to the session; changing one (finish, cancel, reopen,
 *      hand over) write access to its space (404 when it cannot be read, 403 otherwise).
 * Access is decided per person by `services/outline/access.ts`, against current permissions:
 * reading a page as of an older commit uses today's access, not the access at the time.
 */

import { blockTitle, isSpaceKey } from "@shared/outline";
import {
	OUTLINE_VIEW_LIMITS,
	OUTLINE_VIEW_STATE_LIMITS,
	type OutlineBacklinksResponse,
	type OutlineBlockHistoryResponse,
	type OutlineBlockViewResponse,
	type OutlineLockResponse,
	type OutlineLockView,
	type OutlinePageListResponse,
	type OutlinePagePendingResponse,
	type OutlinePendingDecisionResponse,
	type OutlinePendingDetailResponse,
	type OutlinePendingSummary,
	type OutlineResolveResponse,
	type OutlineRevertResponse,
	type OutlineSearchResponse,
	type OutlineSpaceDetailResponse,
	type OutlineSpaceListResponse,
	type OutlineSpaceResolveResponse,
	type OutlineSpaceSummary,
	type OutlineTimelineResponse,
	type OutlineViewStateResponse,
} from "@shared/outline-api";
import type {
	OutlineBoardAddResponse,
	OutlineBoardFinishedResponse,
	OutlineBoardTaskUpdateResponse,
	OutlineTaskBoardResponse,
} from "@shared/outline-task-board";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { getUserLanguage, getUserReplyInLanguage } from "../lib/i18n";
import {
	outlineBacklinksQuerySchema,
	outlineBlockViewQuerySchema,
	outlineBoardAddBodySchema,
	outlineBoardTaskUpdateBodySchema,
	outlineFinishedTasksQuerySchema,
	outlineHistoryQuerySchema,
	outlineIdSchema,
	outlineLockBodySchema,
	outlinePageListQuerySchema,
	outlinePendingRejectBodySchema,
	outlineResolveQuerySchema,
	outlineSearchQuerySchema,
	outlineSpaceListQuerySchema,
	outlineTaskBoardQuerySchema,
	outlineViewStatePutSchema,
} from "../lib/validators/outline";
import {
	canManageSpace,
	canReadSpace,
	canWriteSpace,
	listReadableSpaces,
	narratorUsersWith,
	type OutlineAccessNeed,
	type OutlinePrincipal,
	projectUsersWith,
} from "../services/outline/access";
import {
	type NarratorAccessRow,
	type ProjectAccessRow,
	readNarrator,
	readProject,
} from "../services/outline/access-reads";
import { OutlineWriteError } from "../services/outline/errors";
import { isOutlineEnabled } from "../services/outline/feature";
import { type OutlinePendingDeciderJson, outlinePendingLabel } from "../services/outline/model";
import {
	confirmOutlinePending,
	lockOutlineTask,
	OutlinePendingError,
	pendingBaseChanged,
	pendingNames,
	readPagePending,
	readPendingDiff,
	rejectOutlinePending,
	unlockOutlineTask,
} from "../services/outline/pending";
import { addPersonTask, changePersonTask } from "../services/outline/person-tasks";
import { commitSeqAt } from "../services/outline/read";
import { listBacklinks, resolveAddress } from "../services/outline/resolve";
import { revertCommit } from "../services/outline/revert";
import { OUTLINE_SEARCH_LIMITS, searchOutline } from "../services/outline/search";
import {
	ensurePersonalSpace,
	ensureProjectSpace,
	ensureSessionSpace,
	findPersonalSpace,
	findProjectSpace,
	findSessionSpace,
} from "../services/outline/spaces";
import { outlineStore } from "../services/outline/store";
import type {
	OutlineBlockRow,
	OutlinePendingHead,
	OutlinePendingRow,
	OutlineSpaceRow,
} from "../services/outline/store/port";
import {
	readFinishedTasks,
	readProjectTaskBoard,
	readSessionTaskBoard,
} from "../services/outline/task-board";
import { readViewState, writeViewState } from "../services/outline/view-state";
import {
	describeLocks,
	describeSpaces,
	listSpacePages,
	readBlockHistory,
	readBlockView,
	readTimelineView,
} from "../services/outline/views";
import { flushOutlineTaskEdits } from "../services/outline-task-edits";
import { resolveTaskBackend } from "../services/task-source";

export const outlineRoutes = new Hono();

outlineRoutes.use("*", async (c, next) => {
	if (!isOutlineEnabled()) return c.notFound();
	await next();
});

function principalOf(c: Context): OutlinePrincipal {
	const user = c.get("user");
	return { userId: user.sub, isAdmin: user.role === "admin" };
}

function parse<T>(
	schema: {
		safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
	},
	input: unknown,
): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return parsed.data;
}

function idParam(c: Context, name: string): string {
	return parse(outlineIdSchema, c.req.param(name));
}

/** The space, if the person may read it; 404 otherwise, whether or not it exists. */
async function readableSpace(principal: OutlinePrincipal, spaceId: string) {
	const space = await outlineStore.getSpace(spaceId);
	if (!space || !(await canReadSpace(principal, space))) {
		throw new NotFoundError("Outline space", spaceId);
	}
	return space;
}

/** A block of a readable space, live or deleted (history may name it); 404 otherwise. */
async function readableBlock(
	principal: OutlinePrincipal,
	spaceId: string,
	blockId: string,
): Promise<{ space: OutlineSpaceRow; block: OutlineBlockRow }> {
	const space = await readableSpace(principal, spaceId);
	const block = await outlineStore.getBlock(blockId);
	if (!block || block.spaceId !== space.id) throw new NotFoundError("Outline block", blockId);
	return { space, block };
}

async function describeOne(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
): Promise<OutlineSpaceSummary> {
	return (await describeSpaces(principal, [space]))[0] as OutlineSpaceSummary;
}

/**
 * Every space the person can read, up to the number one search covers. Paged through the
 * readable-space listing, whose filter runs in SQL.
 */
async function readableSpaceIds(principal: OutlinePrincipal): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	while (ids.length < OUTLINE_SEARCH_LIMITS.maxSpaces) {
		const page = await listReadableSpaces(principal, {
			cursor,
			limit: OUTLINE_VIEW_LIMITS.maxListPage,
		});
		for (const space of page.spaces) ids.push(space.id);
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	return ids.slice(0, OUTLINE_SEARCH_LIMITS.maxSpaces);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spaces
// ─────────────────────────────────────────────────────────────────────────────

/** The spaces the person can read, a page at a time. */
outlineRoutes.get("/spaces", async (c) => {
	const principal = principalOf(c);
	const query = parse(outlineSpaceListQuerySchema, c.req.query());
	const page = await listReadableSpaces(principal, {
		kind: query.kind,
		cursor: query.cursor ?? null,
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultListPage,
	});
	const body: OutlineSpaceListResponse = {
		spaces: await describeSpaces(principal, page.spaces),
		nextCursor: page.nextCursor,
	};
	return c.json(body);
});

/** The person's own personal space, created on first use. */
outlineRoutes.post("/spaces/personal", async (c) => {
	const principal = principalOf(c);
	const existing = await findPersonalSpace(principal.userId);
	const space = existing ?? (await ensurePersonalSpace(principal.userId));
	const body: OutlineSpaceResolveResponse = {
		space: await describeOne(principal, space),
		created: existing === null,
	};
	return c.json(body);
});

async function holds(
	principal: OutlinePrincipal,
	need: OutlineAccessNeed,
	scope: { project: ProjectAccessRow } | { narrator: NarratorAccessRow },
): Promise<boolean> {
	if (principal.isAdmin) return true;
	const users =
		"project" in scope
			? await projectUsersWith(scope.project, [principal.userId], need)
			: await narratorUsersWith(scope.narrator, [principal.userId], need);
	return users.has(principal.userId);
}

/**
 * A project's space. A project the person cannot read is 404. A space that does not exist yet
 * is created when the person may write the project, and reported as missing otherwise.
 */
outlineRoutes.post("/projects/:projectId/space", async (c) => {
	const principal = principalOf(c);
	const projectId = idParam(c, "projectId");
	const project = await readProject(projectId);
	if (!project || !(await holds(principal, "read", { project }))) {
		throw new NotFoundError("Project", projectId);
	}
	let space = await findProjectSpace(projectId);
	let created = false;
	if (!space && (await holds(principal, "write", { project }))) {
		space = await ensureProjectSpace(projectId);
		created = true;
	}
	const body: OutlineSpaceResolveResponse = {
		space: space ? await describeOne(principal, space) : null,
		created,
	};
	return c.json(body);
});

/**
 * A session's space: its own, or its root's for a subagent. The same rules as a project's,
 * on the session's read and write audiences.
 */
outlineRoutes.post("/narrators/:narratorId/space", async (c) => {
	const principal = principalOf(c);
	const narratorId = idParam(c, "narratorId");
	const narrator = await readNarrator(narratorId);
	if (!narrator || !(await holds(principal, "read", { narrator }))) {
		throw new NotFoundError("Narrator", narratorId);
	}
	let space = await findSessionSpace(narratorId);
	let created = false;
	if (!space && (await holds(principal, "write", { narrator }))) {
		space = await ensureSessionSpace(narratorId);
		created = true;
	}
	const body: OutlineSpaceResolveResponse = {
		space: space ? await describeOne(principal, space) : null,
		created,
	};
	return c.json(body);
});

outlineRoutes.get("/spaces/:spaceId", async (c) => {
	const principal = principalOf(c);
	const space = await readableSpace(principal, idParam(c, "spaceId"));
	const body: OutlineSpaceDetailResponse = {
		space: {
			...(await describeOne(principal, space)),
			canWrite: await canWriteSpace(principal, space),
		},
	};
	return c.json(body);
});

/** The live pages of a space, in order. */
outlineRoutes.get("/spaces/:spaceId/pages", async (c) => {
	const principal = principalOf(c);
	const space = await readableSpace(principal, idParam(c, "spaceId"));
	const query = parse(outlinePageListQuerySchema, c.req.query());
	const body: OutlinePageListResponse = await listSpacePages(space.id, {
		cursor: query.cursor ?? null,
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultListPage,
	});
	return c.json(body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block (a page, or any block focused as one) and its subtree, current or as of a commit
 * seq or a time, within a budget.
 */
outlineRoutes.get("/spaces/:spaceId/blocks/:blockId", async (c) => {
	const principal = principalOf(c);
	const blockId = idParam(c, "blockId");
	const { space } = await readableBlock(principal, idParam(c, "spaceId"), blockId);
	const query = parse(outlineBlockViewQuerySchema, c.req.query());
	const asOf = query.at !== undefined ? await commitSeqAt(space.id, query.at) : query.asOf;
	const view = await readBlockView({
		blockId,
		asOf,
		view: query.view,
		budget: {
			blocks: query.blocks ?? OUTLINE_VIEW_LIMITS.defaultBlocks,
			bytes: query.bytes ?? OUTLINE_VIEW_LIMITS.maxBytes,
		},
		narratorVisible: narratorVisibility(principal),
	});
	if (!view) throw new NotFoundError("Outline block", blockId);
	const locked = view.blocks.flatMap((b) => (b.lock ? [b.lock] : []));
	if (locked.length > 0) {
		const manages = await canManageSpace(principal, space);
		for (const lock of locked) lock.canUnlock = unlockAllowed(principal, lock, manages);
	}
	const body: OutlineBlockViewResponse = {
		space: {
			...(await describeOne(principal, space)),
			canWrite: await canWriteSpace(principal, space),
		},
		...view,
	};
	return c.json(body);
});

/** The versions of one block, newest first, each with its commit. */
outlineRoutes.get("/spaces/:spaceId/blocks/:blockId/history", async (c) => {
	const principal = principalOf(c);
	const { block } = await readableBlock(principal, idParam(c, "spaceId"), idParam(c, "blockId"));
	const query = parse(outlineHistoryQuerySchema, c.req.query());
	const body: OutlineBlockHistoryResponse = await readBlockHistory(block, {
		before: query.before,
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultTimeline,
	});
	return c.json(body);
});

/** Open links to a block from the spaces the person can read. */
outlineRoutes.get("/spaces/:spaceId/blocks/:blockId/backlinks", async (c) => {
	const principal = principalOf(c);
	const { block } = await readableBlock(principal, idParam(c, "spaceId"), idParam(c, "blockId"));
	const query = parse(outlineBacklinksQuerySchema, c.req.query());
	const result = await listBacklinks(block.id, {
		readableSpaceIds: await readableSpaceIds(principal),
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultBacklinks,
	});
	if (!result) throw new NotFoundError("Outline block", block.id);
	const body: OutlineBacklinksResponse = {
		links: result.links.map((link) => ({
			blockId: link.blockId,
			spaceId: link.spaceId,
			pageId: link.pageId,
			address: link.address,
			title: link.title,
			kind: link.kind,
		})),
		truncated: result.truncated,
	};
	return c.json(body);
});

/** The commits that touched a page, newest first, a page at a time (`before` is exclusive). */
outlineRoutes.get("/spaces/:spaceId/pages/:pageId/commits", async (c) => {
	const principal = principalOf(c);
	const { block } = await readableBlock(principal, idParam(c, "spaceId"), idParam(c, "pageId"));
	const query = parse(outlineHistoryQuerySchema, c.req.query());
	const timeline = await readTimelineView(block.pageId, {
		before: query.before,
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultTimeline,
	});
	if (!timeline) throw new NotFoundError("Outline block", block.id);
	const body: OutlineTimelineResponse = timeline;
	return c.json(body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Search and revert
// ─────────────────────────────────────────────────────────────────────────────

/** Full-text search over one readable space, or every space the person can read. */
outlineRoutes.get("/search", async (c) => {
	const principal = principalOf(c);
	const query = parse(outlineSearchQuerySchema, c.req.query());
	const spaceIds = query.spaceId
		? [(await readableSpace(principal, query.spaceId)).id]
		: await readableSpaceIds(principal);
	const hits = await searchOutline({
		query: query.q,
		spaceIds,
		contextSpaceId: query.spaceId ?? null,
		limit: query.limit ?? OUTLINE_VIEW_LIMITS.defaultSearch,
	});
	const body: OutlineSearchResponse = {
		hits: hits.map((hit) => ({
			blockId: hit.blockId,
			spaceId: hit.spaceId,
			pageId: hit.pageId,
			address: hit.address,
			alias: hit.alias,
			title: hit.title,
			snippet: hit.snippet,
			path: hit.path,
			process: hit.process,
		})),
	};
	return c.json(body);
});

/** A space named by key or by id, if the person may read it; null otherwise. */
async function readableSpaceNamed(
	principal: OutlinePrincipal,
	name: string,
): Promise<OutlineSpaceRow | null> {
	const byKey = isSpaceKey(name) ? await outlineStore.getSpaceByKey(name) : null;
	const space = byKey ?? (await outlineStore.getSpace(name));
	return space && (await canReadSpace(principal, space)) ? space : null;
}

/**
 * Where a reference or a commit points, for opening it (tool cards name blocks by address and
 * commits by seq). `ref` resolves within the space its `key/` prefix names, else within `space`;
 * `commit` is a seq of `space` and answers the first page it changed, to show as of it. Bounded:
 * one space, one resolution (or one commit and one of its versions), and one block read.
 *
 * Every miss is the same 404 — no such space, a space the person cannot read, no such block or
 * commit, a reference naming several blocks — so the answer never tells which.
 */
outlineRoutes.get("/resolve", async (c) => {
	const principal = principalOf(c);
	const query = parse(outlineResolveQuerySchema, c.req.query());
	const missing = () =>
		new NotFoundError("Outline reference", query.ref ?? `${query.space}#${query.commit}`);
	if (query.commit !== undefined) {
		const space = await readableSpaceNamed(principal, query.space as string);
		if (!space) throw missing();
		const [commit] = await outlineStore.getCommitsBySeqs(space.id, [query.commit]);
		const [version] = commit ? await outlineStore.listCommitVersions(commit.id, 1) : [];
		const page = version ? await outlineStore.getBlock(version.pageId) : null;
		if (!commit || !page || page.spaceId !== space.id) throw missing();
		const body: OutlineResolveResponse = {
			spaceId: space.id,
			spaceKey: space.key,
			blockId: page.id,
			pageId: page.id,
			isPage: true,
			address: `${space.key}/${page.sid}`,
			title: blockTitle(page.content),
			deleted: page.deleted,
			asOf: commit.seq,
		};
		return c.json(body);
	}
	const ref = query.ref as string;
	// A `key/…` reference names its own space; otherwise the reference is read within `space`.
	const slash = ref.indexOf("/");
	const prefix = slash > 0 ? ref.slice(0, slash) : "";
	let space: OutlineSpaceRow | null = null;
	if (prefix && isSpaceKey(prefix)) {
		const named = await outlineStore.getSpaceByKey(prefix);
		if (named && (await canReadSpace(principal, named))) space = named;
	}
	if (!space && query.space) space = await readableSpaceNamed(principal, query.space);
	if (!space) throw missing();
	const resolution = await resolveAddress(ref, { spaceId: space.id, readableSpaceIds: [space.id] });
	if (resolution.status !== "found") throw missing();
	const block = resolution.block;
	const body: OutlineResolveResponse = {
		spaceId: block.spaceId,
		spaceKey: block.spaceKey,
		blockId: block.id,
		pageId: block.pageId,
		isPage: block.isPage,
		address: block.address,
		title: block.title,
		deleted: block.deleted,
	};
	return c.json(body);
});

/**
 * Revert a commit with a compensating commit. Needs write access to the commit's space: a
 * commit of a space the person cannot read is 404, one they can read but not write is 403.
 * Blocks changed since, or that cannot go back, are left alone and listed in `skipped`.
 */
outlineRoutes.post("/commits/:commitId/revert", async (c) => {
	const principal = principalOf(c);
	const commitId = idParam(c, "commitId");
	const commit = await outlineStore.getCommit(commitId);
	const space = commit ? await outlineStore.getSpace(commit.spaceId) : null;
	if (!commit || !space || !(await canReadSpace(principal, space))) {
		throw new NotFoundError("Outline commit", commitId);
	}
	if (!(await canWriteSpace(principal, space))) throw new ForbiddenError();
	const result = await revertCommit({
		commitId,
		actor: { kind: "human", id: principal.userId },
		responsibleUserId: principal.userId,
		// A revert takes someone else's lock away only for who may unlock (review S-4).
		unlockAuthority: async () => principal.isAdmin || (await canManageSpace(principal, space)),
	});
	const body: OutlineRevertResponse = {
		reverted: result.reverted,
		commit: result.commit,
		pageIds: result.pageIds,
		changed: result.changed.length,
		skipped: result.skipped.map((skip) => ({
			blockId: skip.blockId,
			sid: skip.sid,
			address: skip.address,
			reason: skip.reason,
		})),
		adjusted: result.notes.length,
	};
	return c.json(body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Locks and pending changes
// ─────────────────────────────────────────────────────────────────────────────

/** The locker, a manager of the space, or an admin. */
function unlockAllowed(
	principal: OutlinePrincipal,
	lock: Pick<OutlineLockView, "by">,
	manages: boolean,
): boolean {
	return (
		principal.isAdmin || manages || (lock.by.kind === "human" && lock.by.id === principal.userId)
	);
}

/**
 * Whether the person may read a session: locks and pending changes name it by title only then
 * (review S-5). Memoized for one request.
 */
function narratorVisibility(principal: OutlinePrincipal): (narratorId: string) => Promise<boolean> {
	const memo = new Map<string, Promise<boolean>>();
	return (narratorId) => {
		let verdict = memo.get(narratorId);
		if (!verdict) {
			verdict = (async () => {
				const narrator = await readNarrator(narratorId);
				return narrator !== null && (await holds(principal, "read", { narrator }));
			})();
			memo.set(narratorId, verdict);
		}
		return verdict;
	};
}

/**
 * Pending changes as the person sees them listed (names, whether they decide them), from their
 * heads (review S-7: the operations are not read). Who decides is the lock on each change's tree
 * as it is now; deciding needs write access to the space (review B-3).
 */
async function describePending(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
	rows: readonly OutlinePendingHead[],
): Promise<OutlinePendingSummary[]> {
	if (rows.length === 0) return [];
	const rootIds = rows.flatMap((r) => (r.rootBlockId ? [r.rootBlockId] : []));
	// The parents of the blocks each adds that exist (one added under another is not one).
	const parentIds = rows.flatMap((r) =>
		r.addsJson.flatMap((add) => (add.parentId ? [add.parentId] : [])),
	);
	const [roots, changed, writes] = await Promise.all([
		outlineStore.getBlockMetas(space.id, { ids: [...new Set([...rootIds, ...parentIds])] }),
		pendingBaseChanged(rows),
		canWriteSpace(principal, space),
	]);
	const live = new Set(roots.flatMap((m) => (m.deleted ? [] : [m.id])));
	const locks = new Map(
		roots.flatMap((m) =>
			!m.deleted && m.taskJson?.lock ? [[m.id, m.taskJson.lock] as const] : [],
		),
	);
	const deciders = rows.map((row) => {
		const lock = row.rootBlockId ? locks.get(row.rootBlockId) : undefined;
		return lock ? { by: lock.by, delegate: lock.delegate ?? null } : row.deciderJson;
	});
	const names = await pendingNames(
		rows.map((row, i) => ({ ...row, deciderJson: deciders[i] as OutlinePendingDeciderJson })),
	);
	const visible = narratorVisibility(principal);
	const title = async (id: string | null): Promise<string | null> =>
		id !== null && (await visible(id)) ? (names.narrators.get(id) ?? null) : null;
	const out: OutlinePendingSummary[] = [];
	for (const [i, row] of rows.entries()) {
		const lock = row.rootBlockId ? locks.get(row.rootBlockId) : undefined;
		const decider = deciders[i] as OutlinePendingDeciderJson;
		out.push({
			id: row.id,
			label: outlinePendingLabel(row.id),
			status: row.status,
			rootBlockId: row.rootBlockId,
			pageId: row.pageId,
			summary: row.summary,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			proposer: { narratorId: row.requesterSession, title: await title(row.requesterSession) },
			decider: {
				by: {
					kind: decider.by.kind,
					id: decider.by.id,
					name:
						decider.by.kind === "human"
							? (names.users.get(decider.by.id) ?? null)
							: await title(decider.by.id),
				},
				delegate: decider.delegate
					? { narratorId: decider.delegate, title: await title(decider.delegate) }
					: null,
			},
			blockIds: row.blockIdsJson,
			addedUnder: [
				...new Set(
					row.addsJson.flatMap((add) =>
						add.parentId && live.has(add.parentId) ? [add.parentId] : [],
					),
				),
			],
			ops: row.opCount,
			changedSince: changed.has(row.id),
			canDecide:
				row.status === "open" &&
				writes &&
				!!lock &&
				lock.by.kind === "human" &&
				lock.by.id === principal.userId,
		});
	}
	return out;
}

/** A pending change in a space the person can read; 404 otherwise, whether or not it exists. */
async function readablePending(
	principal: OutlinePrincipal,
	pendingId: string,
): Promise<{ row: OutlinePendingRow; space: OutlineSpaceRow }> {
	const row = (await outlineStore.getPending([pendingId]))[0];
	const space = row ? await outlineStore.getSpace(row.spaceId) : null;
	if (!row || !space || !(await canReadSpace(principal, space))) {
		throw new NotFoundError("Outline pending change", pendingId);
	}
	return { row, space };
}

/** What waits for confirmation on a page, and its locked tasks. */
outlineRoutes.get("/spaces/:spaceId/pages/:pageId/pending", async (c) => {
	const principal = principalOf(c);
	const { space, block } = await readableBlock(
		principal,
		idParam(c, "spaceId"),
		idParam(c, "pageId"),
	);
	const { pending, locked } = await readPagePending(block.pageId);
	const views = await describeLocks(
		locked.flatMap((m) => (m.taskJson?.lock ? [{ blockId: m.id, lock: m.taskJson.lock }] : [])),
		{ narratorVisible: narratorVisibility(principal) },
	);
	const manages = views.size > 0 ? await canManageSpace(principal, space) : false;
	for (const lock of views.values()) lock.canUnlock = unlockAllowed(principal, lock, manages);
	const body: OutlinePagePendingResponse = {
		pending: await describePending(principal, space, pending),
		locks: [...views.values()],
	};
	return c.json(body);
});

/** A pending change block by block: as proposed against, as proposed, and as it is now. */
outlineRoutes.get("/pending/:pendingId", async (c) => {
	const principal = principalOf(c);
	const { row, space } = await readablePending(principal, idParam(c, "pendingId"));
	const diff = await readPendingDiff(row);
	const body: OutlinePendingDetailResponse = {
		pending: (await describePending(principal, space, [row]))[0] as OutlinePendingSummary,
		entries: diff.entries.map(({ task, ...entry }) => ({
			...entry,
			...(task !== undefined
				? {
						task: task
							? {
									...(task.status !== undefined ? { status: task.status } : {}),
									...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
									...(task.due !== undefined ? { due: task.due } : {}),
									...(task.depends !== undefined
										? { depends: task.depends?.map((d) => d.target) ?? null }
										: {}),
								}
							: null,
					}
				: {}),
		})),
		truncated: diff.truncated,
	};
	return c.json(body);
});

function pendingFailure(c: Context, error: OutlinePendingError) {
	return c.json(
		{ code: error.code, message: error.message, details: error.details },
		error.statusCode as 403 | 404 | 409,
	);
}

/** Confirm a pending change: the person who locked the plan, while they may write the space. */
outlineRoutes.post("/pending/:pendingId/confirm", async (c) => {
	const principal = principalOf(c);
	const { row, space } = await readablePending(principal, idParam(c, "pendingId"));
	// A confirmation is a commit in the space: write access first (review B-3).
	if (!(await canWriteSpace(principal, space))) throw new ForbiddenError();
	try {
		const done = await confirmOutlinePending({
			pendingId: row.id,
			by: { kind: "human", userId: principal.userId },
		});
		const body: OutlinePendingDecisionResponse = {
			pending: (await describePending(principal, space, [done.row]))[0] as OutlinePendingSummary,
			commit: done.write.commit,
		};
		return c.json(body);
	} catch (error) {
		if (error instanceof OutlinePendingError) return pendingFailure(c, error);
		throw error;
	}
});

/**
 * Reject a pending change, with a reason for its proposer: the person who locked the plan, while
 * they may write the space.
 */
outlineRoutes.post("/pending/:pendingId/reject", async (c) => {
	const principal = principalOf(c);
	const { row, space } = await readablePending(principal, idParam(c, "pendingId"));
	// Deciding changes what the space will hold: write access first (review B-3).
	if (!(await canWriteSpace(principal, space))) throw new ForbiddenError();
	const input = parse(outlinePendingRejectBodySchema, await c.req.json().catch(() => ({})));
	try {
		const done = await rejectOutlinePending({
			pendingId: row.id,
			by: { kind: "human", userId: principal.userId },
			reason: input.reason ?? null,
		});
		const body: OutlinePendingDecisionResponse = {
			pending: (await describePending(principal, space, [done]))[0] as OutlinePendingSummary,
			commit: null,
		};
		return c.json(body);
	} catch (error) {
		if (error instanceof OutlinePendingError) return pendingFailure(c, error);
		throw error;
	}
});

/**
 * Lock a task's tree (owner decision Q5: people lock, from the page), optionally naming a session
 * that may confirm step changes on the locker's behalf: one the person may write. A task someone
 * else locked is 409 (`OUTLINE_LOCK_HELD`, review B-2): it is unlocked first, by someone who may;
 * the locker locking again only names another delegate.
 */
outlineRoutes.post("/spaces/:spaceId/blocks/:blockId/lock", async (c) => {
	const principal = principalOf(c);
	const { space, block } = await readableBlock(
		principal,
		idParam(c, "spaceId"),
		idParam(c, "blockId"),
	);
	if (block.deleted) throw new NotFoundError("Outline block", block.id);
	if (!(await canWriteSpace(principal, space))) throw new ForbiddenError();
	if (!block.taskJson) throw new ValidationError("only a task can be locked");
	const input = parse(outlineLockBodySchema, await c.req.json().catch(() => ({})));
	const delegate = input.delegate ?? null;
	if (delegate !== null) {
		const narrator = await readNarrator(delegate);
		if (!narrator || !(await holds(principal, "read", { narrator }))) {
			throw new NotFoundError("Narrator", delegate);
		}
		if (!(await holds(principal, "write", { narrator }))) throw new ForbiddenError();
	}
	let result: Awaited<ReturnType<typeof lockOutlineTask>>;
	try {
		result = await lockOutlineTask({ blockId: block.id, userId: principal.userId, delegate });
	} catch (error) {
		if (error instanceof OutlineWriteError && error.code === "OUTLINE_LOCK_HELD")
			return c.json({ code: error.code, message: error.message }, 409);
		throw error;
	}
	const after = await outlineStore.getBlock(block.id);
	const lock = after?.taskJson?.lock
		? (
				await describeLocks([{ blockId: block.id, lock: after.taskJson.lock }], {
					narratorVisible: narratorVisibility(principal),
				})
			).get(block.id)
		: undefined;
	if (lock) lock.canUnlock = true;
	const body: OutlineLockResponse = { lock: lock ?? null, commit: result.commit };
	return c.json(body);
});

/** Unlock a task's tree: the locker, a manager of the space, or an admin. */
outlineRoutes.delete("/spaces/:spaceId/blocks/:blockId/lock", async (c) => {
	const principal = principalOf(c);
	const { space, block } = await readableBlock(
		principal,
		idParam(c, "spaceId"),
		idParam(c, "blockId"),
	);
	const lock = block.deleted ? undefined : block.taskJson?.lock;
	if (!lock) {
		const body: OutlineLockResponse = { lock: null, commit: null };
		return c.json(body);
	}
	const manages = await canManageSpace(principal, space);
	const allowed = unlockAllowed(
		principal,
		{ by: { kind: lock.by.kind, id: lock.by.id, name: null } },
		manages,
	);
	if (!allowed || !(await canWriteSpace(principal, space))) throw new ForbiddenError();
	let result: Awaited<ReturnType<typeof unlockOutlineTask>>;
	try {
		result = await unlockOutlineTask({
			blockId: block.id,
			userId: principal.userId,
			mayUnlockAnyone: principal.isAdmin || manages,
		});
	} catch (error) {
		// Relocked by someone else meanwhile, whom this person may not unlock.
		if (error instanceof OutlineWriteError && error.code === "OUTLINE_LOCK_DENIED")
			throw new ForbiddenError();
		throw error;
	}
	const body: OutlineLockResponse = { lock: null, commit: result.commit };
	return c.json(body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Task board (P2 PR 5)
// ─────────────────────────────────────────────────────────────────────────────

/** A session the person may read (404 otherwise, as for its space). */
async function readableNarrator(principal: OutlinePrincipal, narratorId: string) {
	const narrator = await readNarrator(narratorId);
	if (!narrator || !(await holds(principal, "read", { narrator }))) {
		throw new NotFoundError("Narrator", narratorId);
	}
	return narrator;
}

/**
 * Start the session on its tasks when it is idle ("Add and start", "Reopen and start"; owner Q5),
 * as `/goal` starts its first turn: once even when continuation is off, never in plan mode. The
 * person's changes are told to it first, so the turn reads them.
 */
async function startSession(narratorId: string, userId: string): Promise<boolean> {
	await flushOutlineTaskEdits(narratorId);
	const { startSpecContinuationIfPossible } = await import("../services/narrator-session");
	const [locale, reply] = await Promise.all([
		getUserLanguage(userId),
		getUserReplyInLanguage(userId),
	]);
	const { started } = await startSpecContinuationIfPossible(narratorId, locale, reply, userId);
	return started;
}

/**
 * A session's task board (its dock tab): its session space's tasks and what it holds elsewhere.
 * Read access to the session; a subagent's board is its root's.
 */
outlineRoutes.get("/narrators/:narratorId/tasks", async (c) => {
	const principal = principalOf(c);
	const narrator = await readableNarrator(principal, idParam(c, "narratorId"));
	const canAdd =
		narrator.type !== "subagent" &&
		(await resolveTaskBackend(narrator.id)) === "outline" &&
		(await holds(principal, "write", { narrator }));
	const body: OutlineTaskBoardResponse = await readSessionTaskBoard(principal, narrator.id, {
		canAdd,
	});
	return c.json(body);
});

/**
 * A project's task board (the project page): the project space, then the session spaces of the
 * project's sessions the person may read, a page of spaces at a time.
 */
outlineRoutes.get("/projects/:projectId/tasks", async (c) => {
	const principal = principalOf(c);
	const projectId = idParam(c, "projectId");
	const project = await readProject(projectId);
	if (!project || !(await holds(principal, "read", { project }))) {
		throw new NotFoundError("Project", projectId);
	}
	const query = parse(outlineTaskBoardQuerySchema, c.req.query());
	const body: OutlineTaskBoardResponse = await readProjectTaskBoard(principal, projectId, {
		cursor: query.cursor ?? null,
	});
	return c.json(body);
});

/** A space's next finished tasks (done or cancelled), latest change first. */
outlineRoutes.get("/spaces/:spaceId/tasks/finished", async (c) => {
	const principal = principalOf(c);
	const space = await readableSpace(principal, idParam(c, "spaceId"));
	const query = parse(outlineFinishedTasksQuerySchema, c.req.query());
	const body: OutlineBoardFinishedResponse = await readFinishedTasks(principal, space, {
		cursor: query.cursor ?? null,
		limit: query.limit,
	});
	return c.json(body);
});

/**
 * A person adds a task to a session (the board's form): person-created, locked unless asked
 * otherwise, deduped by title; with `start`, the session starts on its tasks when idle. Write
 * access to the session, whose tasks must live in the outline.
 */
outlineRoutes.post("/narrators/:narratorId/tasks", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
	const principal = principalOf(c);
	const narrator = await readableNarrator(principal, idParam(c, "narratorId"));
	if (!(await holds(principal, "write", { narrator }))) throw new ForbiddenError();
	if ((await resolveTaskBackend(narrator.id)) !== "outline")
		throw new ValidationError("This session keeps its tasks in Dynamic Spec");
	const input = parse(outlineBoardAddBodySchema, await c.req.json().catch(() => ({})));
	const locale = await getUserLanguage(principal.userId);
	const task = await addPersonTask({
		narratorId: narrator.id,
		userId: principal.userId,
		text: input.text,
		lock: input.lock !== false,
		locale: locale === "zh-CN" ? "zh-CN" : "en",
	});
	const started = input.start ? await startSession(narrator.id, principal.userId) : false;
	const body: OutlineBoardAddResponse = {
		added: task.added,
		task: { id: task.blockId, address: task.address, spaceId: task.spaceId },
		locked: task.locked,
		started,
	};
	return c.json(body, task.added ? 201 : 200);
});

/**
 * A person changes one task on the board: finish, cancel or reopen it, hand it to someone or
 * back to the session; with `start`, the session whose space holds it starts when idle. Write
 * access to the task's space (404 when it cannot be read); 409 when the task changed since it
 * was read.
 */
outlineRoutes.patch("/tasks/:blockId", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
	const principal = principalOf(c);
	const blockId = idParam(c, "blockId");
	const block = await outlineStore.getBlock(blockId);
	const space = block ? await outlineStore.getSpace(block.spaceId) : null;
	if (!block || !space || !(await canReadSpace(principal, space)))
		throw new NotFoundError("Outline task", blockId);
	const input = parse(outlineBoardTaskUpdateBodySchema, await c.req.json().catch(() => ({})));
	const { result } = await changePersonTask({
		principal,
		blockId,
		baseVersionSeq: input.baseVersionSeq,
		status: input.status,
		assign: input.assign,
	});
	const session = space.kind === "session" ? space.narratorId : null;
	const started =
		input.start && session && (await resolveTaskBackend(session)) === "outline"
			? await startSession(session, principal.userId)
			: false;
	const body: OutlineBoardTaskUpdateResponse = {
		versionSeq: result?.commit?.seq ?? null,
		started,
	};
	return c.json(body);
});

// ─────────────────────────────────────────────────────────────────────────────
// View state
// ─────────────────────────────────────────────────────────────────────────────

/** The person's folding and mind-map direction of a page; the defaults when never written. */
outlineRoutes.get("/view-state/:pageId", async (c) => {
	const principal = principalOf(c);
	const pageId = idParam(c, "pageId");
	const body: OutlineViewStateResponse | null = await readViewState(principal, pageId);
	if (!body) throw new NotFoundError("Outline page", pageId);
	return c.json(body);
});

/** Replace the person's folding and mind-map direction of a page (the client debounces). */
outlineRoutes.put(
	"/view-state/:pageId",
	bodyLimit({
		maxSize: OUTLINE_VIEW_STATE_LIMITS.maxBodyBytes,
		onError: (c) =>
			c.json(
				{
					code: "PAYLOAD_TOO_LARGE",
					message: `Request body exceeds ${OUTLINE_VIEW_STATE_LIMITS.maxBodyBytes} bytes`,
				},
				413,
			),
	}),
	async (c) => {
		const principal = principalOf(c);
		const pageId = idParam(c, "pageId");
		const raw = await c.req.json().catch((error: unknown) => {
			if (error instanceof Error && error.name === "BodyLimitError") throw error;
			throw new ValidationError("Invalid JSON body");
		});
		const input = parse(outlineViewStatePutSchema, raw);
		const body: OutlineViewStateResponse | null = await writeViewState(principal, pageId, input);
		if (!body) throw new NotFoundError("Outline page", pageId);
		return c.json(body);
	},
);
