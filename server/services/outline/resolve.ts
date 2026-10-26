/**
 * Turning what people and agents write (`key/sid`, `key/alias`, a bare short id or alias, a title)
 * into one block, and listing the blocks that link to a block.
 *
 * RESOLUTION ORDER
 * ----------------
 * The readings of a reference come from `addressCandidates` (`shared/outline/address.ts`) and are
 * tried in this order; the first that finds anything decides:
 *   1. `key/sid`: the block with that sid in the space with that key (a deleted block too, so a
 *      time-travel read or a restore can name it).
 *   2. `key/alias`, then `key/title`, in that space. Links store `P1/Q17` as a block address, so
 *      the part after the slash is tried as an alias as well as a sid.
 *   3. A bare sid or alias in the context space (a sid may name a deleted block).
 *   4. A bare sid or alias in the other readable spaces; several matches are ambiguous.
 *   5. The whole text as an exact title: pages before other blocks, the context space before the
 *      other readable spaces; case-insensitively when nothing matches exactly. Several matches
 *      of the same rank are ambiguous.
 * Spaces the caller may not read are never looked at, so a reference into one is simply not
 * found: nothing tells whether it exists.
 */
import { addressCandidates, isAlias, isTitleSyntax, titleOf } from "@shared/outline";
import { globalQueryTerms, sanitizeQuery } from "../search/query";
import type { OutlineLinkKind } from "./model";
import { outlineStore } from "./store";
import type { OutlineBlockRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineLinkTargetRef } from "./store/read-port";

export const OUTLINE_RESOLVE_LIMITS = {
	/** Candidates an ambiguous resolution lists. */
	maxCandidates: 10,
	/** Full-text candidates a title lookup checks. */
	titleCandidates: 100,
	/** Backlinks one call returns at most. */
	maxBacklinks: 200,
	defaultBacklinks: 50,
} as const;

export interface OutlineResolveContext {
	/** The space bare names are looked up in first. */
	spaceId?: string | null;
	/** Spaces the caller may read; nothing outside them is found. */
	readableSpaceIds: readonly string[];
	store?: OutlineStore;
}

export interface OutlineResolvedBlock {
	id: string;
	spaceId: string;
	spaceKey: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	pageId: string;
	isPage: boolean;
	title: string;
	alias: string | null;
	deleted: boolean;
}

export type OutlineResolveVia = "address" | "sid" | "alias" | "title";

export type OutlineResolution =
	| { status: "found"; block: OutlineResolvedBlock; via: OutlineResolveVia }
	| { status: "ambiguous"; candidates: OutlineResolvedBlock[]; via: OutlineResolveVia }
	| { status: "not_found" };

class Resolver {
	private readonly readable: ReadonlySet<string>;
	private readonly spaces = new Map<string, OutlineSpaceRow | null>();
	private readonly keys = new Map<string, OutlineSpaceRow | null>();

	constructor(
		private readonly store: OutlineStore,
		readableSpaceIds: readonly string[],
	) {
		this.readable = new Set(readableSpaceIds);
	}

	get readableIds(): string[] {
		return [...this.readable];
	}

	async spaceById(id: string): Promise<OutlineSpaceRow | null> {
		if (!this.readable.has(id)) return null;
		if (!this.spaces.has(id)) this.spaces.set(id, await this.store.getSpace(id));
		return this.spaces.get(id) ?? null;
	}

	async spaceByKey(key: string): Promise<OutlineSpaceRow | null> {
		if (!this.keys.has(key)) {
			const space = await this.store.getSpaceByKey(key);
			this.keys.set(key, space && this.readable.has(space.id) ? space : null);
		}
		return this.keys.get(key) ?? null;
	}

	async describe(block: OutlineBlockRow): Promise<OutlineResolvedBlock> {
		const space = await this.spaceById(block.spaceId);
		const key = space?.key ?? "";
		return {
			id: block.id,
			spaceId: block.spaceId,
			spaceKey: key,
			sid: block.sid,
			address: `${key}/${block.sid}`,
			pageId: block.pageId,
			isPage: block.parentId === null,
			title: titleOf(block.content),
			alias: block.alias,
			deleted: block.deleted,
		};
	}

	async outcome(
		blocks: readonly OutlineBlockRow[],
		via: OutlineResolveVia,
	): Promise<OutlineResolution | null> {
		if (blocks.length === 0) return null;
		if (blocks.length === 1) {
			return { status: "found", block: await this.describe(blocks[0] as OutlineBlockRow), via };
		}
		const candidates: OutlineResolvedBlock[] = [];
		for (const block of blocks.slice(0, OUTLINE_RESOLVE_LIMITS.maxCandidates)) {
			candidates.push(await this.describe(block));
		}
		return { status: "ambiguous", candidates, via };
	}

	/** The block with a sid in one space, live or deleted. */
	async bySid(spaceId: string, sid: string): Promise<OutlineBlockRow[]> {
		const block = await this.store.getBlockBySid(spaceId, sid);
		return block ? [block] : [];
	}

	/** Live blocks with a sid or alias in some spaces (one more than a list shows). */
	async byName(spaceIds: readonly string[], by: { sid: string } | { alias: string }) {
		if (spaceIds.length === 0) return [];
		return this.store.findLiveBlocks(spaceIds, by, OUTLINE_RESOLVE_LIMITS.maxCandidates + 1);
	}

	/** Live blocks whose title is `title`: pages if any are, else other blocks. */
	async byTitle(spaceIds: readonly string[], title: string): Promise<OutlineBlockRow[]> {
		const wanted = title.replace(/\s+/g, " ").trim();
		const safe = sanitizeQuery(wanted);
		if (safe === "" || spaceIds.length === 0) return [];
		const { indexed, short } = globalQueryTerms(safe);
		const rows = await this.store.searchBlocks({
			spaceIds,
			indexed,
			short,
			limit: OUTLINE_RESOLVE_LIMITS.titleCandidates,
		});
		let matches = rows.filter((row) => titleOf(row.content) === wanted);
		if (matches.length === 0) {
			const lower = wanted.toLowerCase();
			matches = rows.filter((row) => titleOf(row.content).toLowerCase() === lower);
		}
		if (matches.length === 0) return [];
		const pages = matches.filter((row) => row.parentId === null);
		const chosen = (pages.length > 0 ? pages : matches).map((row) => row.id);
		const blocks = await this.store.getBlocks(chosen);
		const order = new Map(chosen.map((id, i) => [id, i]));
		return blocks
			.filter((b) => !b.deleted)
			.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	}
}

/** Resolve a reference to one block, a list of candidates, or nothing. */
export async function resolveAddress(
	ref: string,
	context: OutlineResolveContext,
): Promise<OutlineResolution> {
	const resolver = new Resolver(context.store ?? outlineStore, context.readableSpaceIds);
	const contextSpace = context.spaceId ? await resolver.spaceById(context.spaceId) : null;
	const others = resolver.readableIds.filter((id) => id !== contextSpace?.id);
	const candidates = addressCandidates(ref);

	// 1–2. Readings scoped to a named space.
	for (const c of candidates) {
		if (c.kind === "address") {
			const space = await resolver.spaceByKey(c.space);
			const found = space
				? await resolver.outcome(await resolver.bySid(space.id, c.sid), "address")
				: null;
			if (found) return found;
		}
	}
	for (const c of candidates) {
		if ((c.kind === "alias" || c.kind === "title") && c.space !== null) {
			const space = await resolver.spaceByKey(c.space);
			if (!space) continue;
			const blocks =
				c.kind === "alias"
					? await resolver.byName([space.id], { alias: c.alias })
					: await resolver.byTitle([space.id], c.title);
			const found = await resolver.outcome(blocks, c.kind);
			if (found) return found;
		}
	}

	// 3–4. Bare sids and aliases: the context space, then the other readable spaces.
	const bare = candidates.filter(
		(c) => (c.kind === "shortId" || c.kind === "alias") && !("space" in c && c.space !== null),
	);
	if (contextSpace) {
		for (const c of bare) {
			const blocks =
				c.kind === "shortId"
					? await resolver.bySid(contextSpace.id, c.sid)
					: c.kind === "alias"
						? await resolver.byName([contextSpace.id], { alias: c.alias })
						: [];
			const found = await resolver.outcome(blocks, c.kind === "shortId" ? "sid" : "alias");
			if (found) return found;
		}
	}
	for (const c of bare) {
		const blocks =
			c.kind === "shortId"
				? await resolver.byName(others, { sid: c.sid })
				: c.kind === "alias"
					? await resolver.byName(others, { alias: c.alias })
					: [];
		const found = await resolver.outcome(blocks, c.kind === "shortId" ? "sid" : "alias");
		if (found) return found;
	}

	// 5. The whole text as a title.
	const whole = candidates.find((c) => c.kind === "title" && c.space === null);
	if (whole && whole.kind === "title") {
		if (contextSpace) {
			const found = await resolver.outcome(
				await resolver.byTitle([contextSpace.id], whole.title),
				"title",
			);
			if (found) return found;
		}
		const found = await resolver.outcome(await resolver.byTitle(others, whole.title), "title");
		if (found) return found;
	}
	return { status: "not_found" };
}

export interface OutlineBacklink {
	/** The linking block. */
	blockId: string;
	address: string;
	title: string;
	pageId: string;
	spaceId: string;
	/** `link` (`[[…]]`), `embed` (`![[…]]`), `depends` (a task's prerequisite) or `tag`. */
	kind: OutlineLinkKind;
	/** The target as the link stores it. */
	targetRef: string;
}

/**
 * Open links to a block from the readable spaces: written as its address, as `key/alias`, or as
 * its alias or title in its own space when that text resolves to it. At most `limit` (200);
 * `truncated` when there are more. Null when the block does not exist or is not readable.
 */
export async function listBacklinks(
	blockId: string,
	options: { readableSpaceIds: readonly string[]; limit?: number; store?: OutlineStore },
): Promise<{ links: OutlineBacklink[]; truncated: boolean } | null> {
	const store = options.store ?? outlineStore;
	const resolver = new Resolver(store, options.readableSpaceIds);
	const block = (await store.getBlocks([blockId]))[0];
	if (!block) return null;
	const space = await resolver.spaceById(block.spaceId);
	if (!space) return null;
	const limit = Math.max(
		1,
		Math.min(
			OUTLINE_RESOLVE_LIMITS.maxBacklinks,
			Math.floor(options.limit ?? OUTLINE_RESOLVE_LIMITS.defaultBacklinks),
		),
	);

	const targets: OutlineLinkTargetRef[] = [
		{ targetKind: "block", targetRef: `${space.key}/${block.sid}` },
	];
	// Names that resolve to the block from its own space (a text link means something only
	// there; `key/alias` is stored as a block address and may come from anywhere).
	const resolvesHere = async (ref: string) => {
		const r = await resolveAddress(ref, {
			spaceId: space.id,
			readableSpaceIds: [space.id],
			store,
		});
		return r.status === "found" && r.block.id === block.id;
	};
	if (!block.deleted) {
		if (block.alias && isAlias(block.alias)) {
			const scoped = `${space.key}/${block.alias}`;
			if (await resolvesHere(scoped)) targets.push({ targetKind: "block", targetRef: scoped });
			if (await resolvesHere(block.alias)) {
				targets.push({ targetKind: "text", targetRef: block.alias, spaceId: space.id });
			}
		}
		const title = titleOf(block.content);
		if (title !== block.alias && isTitleSyntax(title) && (await resolvesHere(title))) {
			targets.push({ targetKind: "text", targetRef: title, spaceId: space.id });
		}
	}

	const rows = await store.listLinksTo(targets, resolver.readableIds, limit + 1);
	const page = rows.slice(0, limit);
	const sources = new Map(
		(await store.getBlocks([...new Set(page.map((l) => l.fromBlockId))])).map((b) => [b.id, b]),
	);
	const links: OutlineBacklink[] = [];
	for (const link of page) {
		const from = sources.get(link.fromBlockId);
		if (!from) continue;
		const fromSpace = await resolver.spaceById(from.spaceId);
		if (!fromSpace) continue;
		links.push({
			blockId: from.id,
			address: `${fromSpace.key}/${from.sid}`,
			title: titleOf(from.content),
			pageId: from.pageId,
			spaceId: from.spaceId,
			kind: link.kind,
			targetRef: link.targetRef,
		});
	}
	return { links, truncated: rows.length > limit };
}
