/**
 * The outline HTTP API, mounted at `/api/outline` behind session auth. Read-only views of
 * spaces, pages, history, backlinks and search, plus reverting a commit; editing goes through the
 * page's live session over WebSocket, not through here.
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
 * Access is decided per person by `services/outline/access.ts`, against current permissions:
 * reading a page as of an older commit uses today's access, not the access at the time.
 */

import { blockTitle, isSpaceKey } from "@shared/outline";
import {
	OUTLINE_VIEW_LIMITS,
	type OutlineBacklinksResponse,
	type OutlineBlockHistoryResponse,
	type OutlineBlockViewResponse,
	type OutlinePageListResponse,
	type OutlineResolveResponse,
	type OutlineRevertResponse,
	type OutlineSearchResponse,
	type OutlineSpaceDetailResponse,
	type OutlineSpaceListResponse,
	type OutlineSpaceResolveResponse,
	type OutlineSpaceSummary,
	type OutlineTimelineResponse,
} from "@shared/outline-api";
import { type Context, Hono } from "hono";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import {
	outlineBacklinksQuerySchema,
	outlineBlockViewQuerySchema,
	outlineHistoryQuerySchema,
	outlineIdSchema,
	outlinePageListQuerySchema,
	outlineResolveQuerySchema,
	outlineSearchQuerySchema,
	outlineSpaceListQuerySchema,
} from "../lib/validators/outline";
import {
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
import { isOutlineEnabled } from "../services/outline/feature";
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
import type { OutlineBlockRow, OutlineSpaceRow } from "../services/outline/store/port";
import {
	describeSpaces,
	listSpacePages,
	readBlockHistory,
	readBlockView,
	readTimelineView,
} from "../services/outline/views";

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
	});
	if (!view) throw new NotFoundError("Outline block", blockId);
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
