import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db";
import {
	knowledgeCollections,
	knowledgeEntries,
	knowledgeEntryLinks,
	knowledgeRevisions,
} from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	type Principal,
	type PrincipalCaps,
	resolvePrincipalCaps,
} from "./knowledge-acl";

export type LinkType =
	| "related"
	| "expands"
	| "supersedes"
	| "depends_on"
	| "parent"
	| "mention"
	| "custom";

export type LinkDirection = "out" | "in" | "both";

type EntryRow = typeof knowledgeEntries.$inferSelect;
type LinkRow = typeof knowledgeEntryLinks.$inferSelect;

/** Lightweight endpoint shape returned alongside links (no body). */
export interface LinkEndpoint {
	id: string;
	title: string;
	slug: string;
	collectionId: string;
}

/** A link row augmented with its endpoints and direction relative to the anchor entry. */
export interface LinkWithEntries {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: LinkType;
	label: string | null;
	toRevisionId: string | null;
	createdByUserId: string | null;
	createdAt: string;
	/** Direction relative to the queried (anchor) entry: out = anchor is source, in = anchor is target. */
	direction: "out" | "in";
	fromEntry: LinkEndpoint;
	toEntry: LinkEndpoint;
}

export interface GraphNode extends LinkEndpoint {
	depth: number;
}

export interface GraphEdge {
	id: string;
	fromEntryId: string;
	toEntryId: string;
	linkType: LinkType;
	label: string | null;
}

export interface GraphResult {
	rootId: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

// Hard ceiling on graph traversal output to protect the event loop / response size.
const MAX_GRAPH_NODES = 200;
/** Per-hop cap on links pulled for the frontier, so a high-fan-out node can't
 *  load an unbounded edge set into the main thread in a single hop. */
const MAX_LINKS_PER_HOP = 1000;

function nowIso(): string {
	return new Date().toISOString();
}

function toAclEntry(entry: EntryRow): AclEntry {
	return {
		id: entry.id,
		collectionId: entry.collectionId,
		ownerUserId: entry.ownerUserId,
		classificationLevel: entry.classificationLevel,
		controlledTagsJson: entry.controlledTagsJson,
		reviewTagsJson: entry.reviewTagsJson,
	};
}

function toEndpoint(entry: EntryRow): LinkEndpoint {
	return { id: entry.id, title: entry.title, slug: entry.slug, collectionId: entry.collectionId };
}

/** Collection fields needed for the ACL collection gate. */
type CollectionAclRow = Pick<
	typeof knowledgeCollections.$inferSelect,
	"id" | "defaultLevel" | "classificationLevel" | "controlledTagsJson" | "ownerUserId"
>;

/** Map a collection row to AclCollection with ALL gate fields (never drop to public). */
function toAclCollection(c: CollectionAclRow): AclCollection {
	return {
		id: c.id,
		defaultLevel: c.defaultLevel,
		classificationLevel: c.classificationLevel,
		controlledTagsJson: c.controlledTagsJson,
		ownerUserId: c.ownerUserId,
	};
}

/**
 * Batched readability resolver. Caches loaded entries/collections and canRead decisions so a
 * single listLinks/getGraph call never re-queries the same row. Used to enforce the rule that a
 * link is only visible when BOTH endpoints are readable (design §6.5 — "a link is not a backdoor").
 */
class ReadResolver {
	private entryCache = new Map<string, EntryRow | null>();
	private collectionById = new Map<string, CollectionAclRow>();
	private readableCache = new Map<string, boolean>();

	constructor(private caps: PrincipalCaps) {}

	/** Preload a batch of entries + their collections (with ALL ACL gate fields) in two queries. */
	async preload(entryIds: string[]): Promise<void> {
		const missing = entryIds.filter((id) => !this.entryCache.has(id));
		if (missing.length === 0) return;
		const rows = await db.query.knowledgeEntries.findMany({
			where: inArray(knowledgeEntries.id, missing),
		});
		for (const r of rows) this.entryCache.set(r.id, r);
		// Mark not-found ids so we don't re-query them.
		for (const id of missing) if (!this.entryCache.has(id)) this.entryCache.set(id, null);

		const colIds = [
			...new Set(rows.map((r) => r.collectionId).filter((c) => !this.collectionById.has(c))),
		];
		if (colIds.length > 0) {
			const cols = await db.query.knowledgeCollections.findMany({
				where: inArray(knowledgeCollections.id, colIds),
				columns: {
					id: true,
					defaultLevel: true,
					classificationLevel: true,
					controlledTagsJson: true,
					ownerUserId: true,
				},
			});
			for (const c of cols) this.collectionById.set(c.id, c);
		}
	}

	getEntry(entryId: string): EntryRow | null {
		return this.entryCache.get(entryId) ?? null;
	}

	async canReadEntry(entryId: string): Promise<boolean> {
		const cached = this.readableCache.get(entryId);
		if (cached !== undefined) return cached;
		await this.preload([entryId]);
		const entry = this.entryCache.get(entryId);
		if (!entry) {
			this.readableCache.set(entryId, false);
			return false;
		}
		const col = this.collectionById.get(entry.collectionId);
		const aclCol: AclCollection = col
			? toAclCollection(col)
			: { id: entry.collectionId, defaultLevel: "public" };
		const ok = await canRead(this.caps, toAclEntry(entry), aclCol);
		this.readableCache.set(entryId, ok);
		return ok;
	}
}

/** Load an entry and assert the principal can read it; otherwise NotFound (don't leak existence). */
async function assertReadableEntry(caps: PrincipalCaps, entryId: string): Promise<EntryRow> {
	const entry = await db.query.knowledgeEntries.findFirst({
		where: eq(knowledgeEntries.id, entryId),
	});
	if (!entry) throw new NotFoundError("Knowledge entry", entryId);
	const collection = await db.query.knowledgeCollections.findFirst({
		where: eq(knowledgeCollections.id, entry.collectionId),
	});
	const aclCol: AclCollection = collection
		? toAclCollection(collection)
		: { id: entry.collectionId, defaultLevel: "public" };
	const ok = await canRead(caps, toAclEntry(entry), aclCol);
	if (!ok) throw new NotFoundError("Knowledge entry", entryId);
	return entry;
}

/**
 * Create an entry-scope directed link from→to.
 *
 * Permission (this round, simplified): the principal must be able to READ both endpoints.
 * Design §6.5 specifies the stricter rule "source writable + both ends readable"; we relax the
 * source side to canRead here to keep the first iteration simple. Tighten to canWriteMain on the
 * source when write-gated linking is required.
 */
async function addLink(
	principal: Principal,
	input: {
		fromEntryId: string;
		toEntryId: string;
		linkType: LinkType;
		label?: string;
		toRevisionId?: string;
	},
): Promise<LinkWithEntries> {
	if (input.fromEntryId === input.toEntryId) {
		throw new ValidationError("cannot link an entry to itself");
	}
	const caps = await resolvePrincipalCaps(principal);
	// Both endpoints must be readable (unreadable → NotFound, no existence leak).
	const fromEntry = await assertReadableEntry(caps, input.fromEntryId);
	const toEntry = await assertReadableEntry(caps, input.toEntryId);

	// If pinning to a target revision, it must belong to the target entry.
	if (input.toRevisionId) {
		const rev = await db.query.knowledgeRevisions.findFirst({
			where: eq(knowledgeRevisions.id, input.toRevisionId),
		});
		if (!rev || rev.entryId !== input.toEntryId) {
			throw new ValidationError("toRevisionId does not belong to the target entry");
		}
	}

	// Dedup on (from, to, linkType) — mirrors the unique index, with a friendly error.
	const existing = await db.query.knowledgeEntryLinks.findFirst({
		where: and(
			eq(knowledgeEntryLinks.fromEntryId, input.fromEntryId),
			eq(knowledgeEntryLinks.toEntryId, input.toEntryId),
			eq(knowledgeEntryLinks.linkType, input.linkType),
		),
	});
	if (existing) {
		throw new ValidationError("A link of this type already exists between these entries");
	}

	const [created] = await db
		.insert(knowledgeEntryLinks)
		.values({
			id: generateId(),
			fromEntryId: input.fromEntryId,
			toEntryId: input.toEntryId,
			linkType: input.linkType,
			label: input.label ?? null,
			toRevisionId: input.toRevisionId ?? null,
			createdByUserId: principal.userId,
			createdAt: nowIso(),
		})
		.returning();

	return {
		...(created as LinkRow),
		linkType: created.linkType as LinkType,
		direction: "out",
		fromEntry: toEndpoint(fromEntry),
		toEntry: toEndpoint(toEntry),
	};
}

/**
 * Remove a link by id. The principal must be able to read the source entry (links are managed from
 * the source side); an unreadable/absent source is reported as NotFound to avoid leaking existence.
 */
async function removeLink(principal: Principal, linkId: string): Promise<{ ok: true }> {
	const link = await db.query.knowledgeEntryLinks.findFirst({
		where: eq(knowledgeEntryLinks.id, linkId),
	});
	if (!link) throw new NotFoundError("Knowledge entry link", linkId);
	const caps = await resolvePrincipalCaps(principal);
	// Reuse the readability gate on the source entry (throws NotFound if unreadable).
	await assertReadableEntry(caps, link.fromEntryId);
	await db.delete(knowledgeEntryLinks).where(eq(knowledgeEntryLinks.id, linkId));
	return { ok: true as const };
}

/**
 * List links touching an entry. Both endpoints of every returned link pass canRead; any link with
 * an unreadable endpoint is omitted entirely (neither the target nor the link's existence leaks).
 */
async function listLinks(
	principal: Principal,
	entryId: string,
	direction: LinkDirection = "both",
): Promise<LinkWithEntries[]> {
	const caps = await resolvePrincipalCaps(principal);
	// Anchor entry must itself be readable.
	await assertReadableEntry(caps, entryId);

	const links = await db.query.knowledgeEntryLinks.findMany({
		where: (l, { eq: e, or: o }) => {
			if (direction === "out") return e(l.fromEntryId, entryId);
			if (direction === "in") return e(l.toEntryId, entryId);
			return o(e(l.fromEntryId, entryId), e(l.toEntryId, entryId));
		},
		orderBy: (l, { desc }) => [desc(l.createdAt)],
	});
	if (links.length === 0) return [];

	const resolver = new ReadResolver(caps);
	const endpointIds = new Set<string>();
	for (const l of links) {
		endpointIds.add(l.fromEntryId);
		endpointIds.add(l.toEntryId);
	}
	await resolver.preload([...endpointIds]);

	const out: LinkWithEntries[] = [];
	for (const l of links) {
		// Both ends must be readable, else the link is invisible.
		if (!(await resolver.canReadEntry(l.fromEntryId))) continue;
		if (!(await resolver.canReadEntry(l.toEntryId))) continue;
		const fromEntry = resolver.getEntry(l.fromEntryId);
		const toEntry = resolver.getEntry(l.toEntryId);
		if (!fromEntry || !toEntry) continue;
		out.push({
			...l,
			linkType: l.linkType as LinkType,
			direction: l.fromEntryId === entryId ? "out" : "in",
			fromEntry: toEndpoint(fromEntry),
			toEntry: toEndpoint(toEntry),
		});
	}
	return out;
}

/**
 * Bounded breadth-first graph traversal from a root entry. Permission is applied at every hop:
 * unreadable entries act as traversal boundaries (not included, not expanded), and an edge is only
 * emitted when both of its endpoints are readable. The graph may contain cycles — a visited set
 * prevents re-expansion. Output is capped at MAX_GRAPH_NODES.
 */
async function getGraph(
	principal: Principal,
	rootId: string,
	opts: { depth?: number } = {},
): Promise<GraphResult> {
	const depth = Math.max(1, Math.min(opts.depth ?? 2, 5));
	const caps = await resolvePrincipalCaps(principal);
	// Root must be readable.
	await assertReadableEntry(caps, rootId);

	const resolver = new ReadResolver(caps);
	const nodes = new Map<string, GraphNode>();
	const edges = new Map<string, GraphEdge>();

	const rootEntry = resolver.getEntry(rootId) ?? (await loadEndpoint(rootId));
	if (rootEntry) nodes.set(rootId, { ...toEndpoint(rootEntry), depth: 0 });

	// Frontier of entry ids to expand at the current depth.
	let frontier: string[] = [rootId];
	const expanded = new Set<string>();

	for (let d = 0; d < depth && frontier.length > 0; d++) {
		if (nodes.size >= MAX_GRAPH_NODES) break;
		// Pull every link touching the frontier in one query (bounded per hop).
		const links = await db.query.knowledgeEntryLinks.findMany({
			where: or(
				inArray(knowledgeEntryLinks.fromEntryId, frontier),
				inArray(knowledgeEntryLinks.toEntryId, frontier),
			),
			limit: MAX_LINKS_PER_HOP,
		});
		for (const id of frontier) expanded.add(id);

		// Preload all endpoints for readability checks.
		const endpointIds = new Set<string>();
		for (const l of links) {
			endpointIds.add(l.fromEntryId);
			endpointIds.add(l.toEntryId);
		}
		await resolver.preload([...endpointIds]);

		const next: string[] = [];
		for (const l of links) {
			if (!(await resolver.canReadEntry(l.fromEntryId))) continue;
			if (!(await resolver.canReadEntry(l.toEntryId))) continue;
			edges.set(l.id, {
				id: l.id,
				fromEntryId: l.fromEntryId,
				toEntryId: l.toEntryId,
				linkType: l.linkType as LinkType,
				label: l.label,
			});
			for (const endId of [l.fromEntryId, l.toEntryId]) {
				if (!nodes.has(endId) && nodes.size < MAX_GRAPH_NODES) {
					const entry = resolver.getEntry(endId);
					if (entry) nodes.set(endId, { ...toEndpoint(entry), depth: d + 1 });
				}
				if (!expanded.has(endId)) next.push(endId);
			}
		}
		frontier = [...new Set(next)];
	}

	return { rootId, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Fallback single-entry loader for the root node (when not already in the resolver cache). */
async function loadEndpoint(entryId: string): Promise<EntryRow | null> {
	return (
		(await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
		})) ?? null
	);
}

export const knowledgeLinkService = {
	addLink,
	removeLink,
	listLinks,
	getGraph,
};
