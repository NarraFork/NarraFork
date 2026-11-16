/**
 * Copying a block's subtree under a parent, in the same space or another (pageless outline, A2):
 * what a task handed out to the team is (`hand-out.ts`), and what 「复制到这里」 makes when a
 * block is dragged to another space (the editing forest, L6). The original stays as it is.
 *
 * WHAT A COPY IS (the hand-out's rules, owner decision Q2 A and design v2 §E.2)
 * --------------------------------------------------------------------------
 *   - The block and its subtree, breadth first, in sibling order, at most `blocks` blocks and
 *     `bytes` of content ({@link OUTLINE_SUBTREE_COPY_LIMITS}); what does not fit (the deepest
 *     blocks first) is counted (`omitted`), never cut in the middle of a level silently.
 *   - Text as it is, with links to copied blocks pointing to their copies (`[[key/sid]]` and
 *     `[[key/sid|label]]`, the forms stored content uses).
 *   - A task stays a task: in progress becomes to do (nobody claims a copy), no manager, its due
 *     date kept, its prerequisites kept (one naming a copied block names its copy; one written
 *     bare keeps naming what it named in the source space). Its assignee is kept only when it is
 *     a person who may write the target space (the others are dropped and counted: `dropped`).
 *   - A question becomes a plain block (its text); aliases, tags, locks, plans, the claim pool and
 *     claims are never copied.
 *   - An optional first block under the copy says where it came from (`provenance`).
 *
 * BATCHES, AND AN INTERRUPTED COPY
 * --------------------------------
 * The copy is written in commits of at most `batchOps` operations and `batchBytes` of content
 * (one commit's size), parents before children. Each commit is atomic; a copy whose later commit
 * is refused (the target parent was deleted meanwhile, a conflict that does not settle) stops
 * there: what was written is a whole tree (every copied block's parent is copied), the result
 * says `done: false` and why. Nothing is rolled back.
 *
 * Every copied block's id (and sid) is derived from the copy's id (`copyId`) and the block it
 * copies, so the same copy asked again goes on where it stopped: the blocks already there are
 * left as they are (one primary-key read), and only the rest is written. A copied block deleted
 * since is not brought back, and neither is what would go under it.
 *
 * WHO MAY: the caller checks it (read the source space, write the target space). A copy into
 * the block's own subtree is refused.
 *
 * COST: the source subtree by block (`block-tree.ts`, at most `blocks` rows), the bodies within
 * the byte budget (a chunk at a time), the derived ids of the copy (primary key), the target
 * parent's ancestry when it is in the source's space (one statement), the persons named as
 * assignees (one read each, at most the copy's blocks), and one commit per batch.
 */
import { createHash } from "node:crypto";
import { AppError, NotFoundError, ValidationError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { type LinkTarget, parseAddress } from "@shared/outline";
import { canWriteSpace } from "./access";
import { readUserByUsername } from "./access-reads";
import { OUTLINE_BLOCK_TREE_LIMITS, readBlockSubtree } from "./block-tree";
import { OUTLINE_LIMITS, type OutlineTaskJson } from "./model";
import { loadBodiesWithin } from "./read";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineNode } from "./tree";
import {
	type OutlineBlockRef,
	type OutlineOp,
	type OutlinePosition,
	type OutlineTaskInput,
	type OutlineWriteInput,
	writeOutline,
} from "./write";

export const OUTLINE_SUBTREE_COPY_LIMITS = {
	/** Blocks of one copy, its provenance included. */
	blocks: 2000,
	/** UTF-8 bytes of the copied content. */
	bytes: 1024 * 1024,
	/** Operations of one commit (the write path takes at most `OUTLINE_LIMITS.maxOps`). */
	batchOps: OUTLINE_LIMITS.maxOps,
	/** UTF-8 bytes of content one commit carries (one transaction carries 128 KiB). */
	batchBytes: 120 * 1024,
} as const;

/** Where the copy goes. */
export interface OutlineCopyTarget {
	space: OutlineSpaceRow;
	/**
	 * The parent: a live block of `space`, the top level (`null`), or one the copy's first
	 * commit makes at the top level when it is missing (a task list: its id is derived from the
	 * copy, so a copy asked again finds it).
	 */
	parent: { id: string } | null | { create: { content: string; alias?: string } };
	/** Among the parent's children; default last. */
	position?: OutlinePosition;
}

export interface OutlineSubtreeCopyRequest {
	/** The block whose subtree is copied (a live block). */
	sourceBlockId: string;
	target: OutlineCopyTarget;
	/** The copy's id: the same id goes on with a copy that stopped (see the header). */
	copyId: string;
	actor: OutlineWriteInput["actor"];
	responsibleUserId: string | null;
	narratorId?: string | null;
	/** The commits' summary (each commit's adds which part it is). */
	summary?: string;
	limits?: { blocks?: number; bytes?: number };
	/** Blocks under the root left out, with what is under them. */
	skip?: (node: OutlineNode) => boolean;
	/** The id of the root's copy (default: derived from the copy's id). */
	rootId?: string;
	/** The root's task as copied (default: the rule for every task, see the header). */
	rootTask?: (task: OutlineTaskJson, copied: OutlineCopiedLinks) => OutlineTaskInput;
	/** The first block under the copy, saying where it came from; none when omitted. */
	provenance?: {
		id?: string;
		text: (facts: { source: string; omitted: number; dropped: number }) => string;
	};
	store?: OutlineStore;
	now?: () => Date;
	/** Tests: what a batch's write does (the real write path by default). */
	write?: typeof writeOutline;
}

/** How links to copied blocks are rewritten: by the source's sid and alias, to `key/sid`. */
export interface OutlineCopiedLinks {
	sourceKey: string;
	bySid: Map<string, string>;
	byAlias: Map<string, string>;
}

export interface OutlineSubtreeCopyResult {
	copyId: string;
	/** The root's copy. */
	root: { id: string; sid: string; address: string; spaceId: string };
	/** Blocks of the source the copy holds now (this call's and earlier ones'). */
	copied: number;
	/** Blocks this call wrote (its provenance and a parent it made included). */
	written: number;
	/**
	 * Blocks under the source left out: past the limits (counted as far as the read went: a
	 * lower bound for a very large subtree), under a copied block deleted since, or not written
	 * because the copy stopped.
	 */
	omitted: number;
	/** Steps whose assignee was dropped (who cannot work in the target space). */
	dropped: number;
	/** Commits this call wrote. */
	commits: number;
	/** Every block the copy takes is there (what the limits leave out is in `omitted`). */
	done: boolean;
	/** Why it stopped before the end (with `done` false); asking again goes on from there. */
	stopped?: { code: string; message: string };
}

/** What people read under a copy (in the copying person's language). */
export const COPY_TEXT: Record<
	"en" | "zh-CN",
	{ from: (source: string, omitted: number) => string }
> = {
	en: {
		from: (source, omitted) =>
			`Copied from [[${source}]]${
				omitted > 0
					? `; ${omitted} more block${omitted === 1 ? "" : "s"} under it were not copied`
					: ""
			}`,
	},
	"zh-CN": {
		from: (source, omitted) =>
			`复制自 [[${source}]]${omitted > 0 ? `；它下面还有 ${omitted} 块没有复制` : ""}`,
	},
};

const COPY_ID_PREFIX = "cp";
const SID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function digest(parts: readonly string[]): Buffer {
	return createHash("sha256").update(parts.join("\u0000")).digest();
}

/** The id of the copy of `sourceId` made by copy `copyId`: the same on every call. */
export function copiedBlockId(copyId: string, sourceId: string): string {
	return `${COPY_ID_PREFIX}${digest([copyId, sourceId]).toString("base64url").slice(0, 28)}`;
}

/** An 8-character sid derived like the id (`attempt` draws another for a taken one). */
function copiedSid(copyId: string, sourceId: string, attempt: number): string {
	const bytes = digest(["sid", copyId, sourceId, String(attempt)]);
	let out = "";
	for (let i = 0; i < 8; i++) out += SID_ALPHABET[(bytes[i] as number) % SID_ALPHABET.length];
	return out;
}

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * The prerequisites a copied task gets: one that names a block that is copied names its copy;
 * one written bare (resolved in the space it was written in) is written with the source space's
 * key, so it still names what it named; any other is kept.
 */
export function copiedDepends(
	depends: readonly LinkTarget[] | undefined,
	copied: OutlineCopiedLinks,
): LinkTarget[] | undefined {
	if (!depends?.length) return undefined;
	return depends.map((d) => {
		const target = d.target.trim();
		const address = parseAddress(target);
		const own =
			address?.space === copied.sourceKey
				? (copied.bySid.get(address.sid) ?? copied.byAlias.get(address.sid))
				: !target.includes("/")
					? (copied.bySid.get(target) ?? copied.byAlias.get(target))
					: undefined;
		if (own) return { target: own, label: d.label };
		if (!target.includes("/")) return { target: `${copied.sourceKey}/${target}`, label: d.label };
		return { target, label: d.label };
	});
}

/**
 * `content` with its links to copied blocks pointing to their copies. Stored content spells a
 * link to `key/sid` exactly `[[key/sid]]` or `[[key/sid|label]]` (`link-display.ts`).
 */
function copiedContent(content: string, copied: OutlineCopiedLinks): string {
	const key = copied.sourceKey;
	if (!content.includes(`[[${key}/`)) return content;
	let out = content;
	for (const [sid, copy] of copied.bySid) {
		out = out
			.split(`[[${key}/${sid}]]`)
			.join(`[[${copy}]]`)
			.split(`[[${key}/${sid}|`)
			.join(`[[${copy}|`);
	}
	return out;
}

/** Of the `human:` assignees given, those whose person may write `space`. */
export async function peopleWhoCanWorkIn(
	assignees: Iterable<string>,
	space: OutlineSpaceRow,
): Promise<Set<string>> {
	const out = new Set<string>();
	for (const assignee of new Set(assignees)) {
		if (!assignee.startsWith("human:")) continue;
		const user = await readUserByUsername(assignee.slice("human:".length));
		if (user && (await canWriteSpace({ userId: user.id, isAdmin: false }, space)))
			out.add(assignee);
	}
	return out;
}

/** The task a copied block gets (see the header). */
function copiedTask(
	task: OutlineTaskJson,
	copied: OutlineCopiedLinks,
	people: ReadonlySet<string>,
): OutlineTaskInput {
	const depends = copiedDepends(task.depends, copied);
	return {
		status: task.status === "doing" ? "todo" : task.status,
		assignee: task.assignee && people.has(task.assignee) ? task.assignee : null,
		...(depends ? { depends } : {}),
		...(task.due ? { due: task.due } : {}),
		manager: null,
	};
}

/** Whether `blockId` is `rootId` or under it now (the target parent of a copy in one space). */
async function isAtOrUnder(
	store: OutlineStore,
	spaceId: string,
	blockId: string,
	rootId: string,
): Promise<boolean> {
	const chain = await store.getAncestry(spaceId, blockId, {
		asOf: null,
		maxDepth: OUTLINE_LIMITS.maxDepth,
	});
	return !!chain?.some((row) => row.id === rootId);
}

/** One block of the copy as planned. */
interface Planned {
	node: OutlineNode;
	id: string;
	sid: string;
	/** Already there (an earlier call wrote it). */
	there: boolean;
}

/**
 * Copy a block's subtree under a parent (see the module header). Throws `NotFoundError` when the
 * source is not a live block or the target parent is not a live block of the target space,
 * `ValidationError` for a copy into the source's own subtree, and the write path's error when
 * the first commit is refused (nothing was written then).
 */
export async function copyOutlineSubtree(
	request: OutlineSubtreeCopyRequest,
): Promise<OutlineSubtreeCopyResult> {
	const store = request.store ?? outlineStore;
	const write = request.write ?? writeOutline;
	const writeOptions = { store, ...(request.now ? { now: request.now } : {}) };
	const { copyId, target } = request;
	const maxBlocks = Math.max(
		1,
		Math.min(
			request.limits?.blocks ?? OUTLINE_SUBTREE_COPY_LIMITS.blocks,
			OUTLINE_SUBTREE_COPY_LIMITS.blocks,
		),
	);
	const maxBytes = Math.max(
		0,
		Math.min(
			request.limits?.bytes ?? OUTLINE_SUBTREE_COPY_LIMITS.bytes,
			OUTLINE_SUBTREE_COPY_LIMITS.bytes,
		),
	);

	// ── The source, breadth first, within the limits. ──
	// Read past the limit (up to a read's own), so what is left out is counted.
	const tree = await readBlockSubtree(request.sourceBlockId, {
		limit: Math.min(
			OUTLINE_BLOCK_TREE_LIMITS.maxBlocks,
			Math.max(maxBlocks, OUTLINE_BLOCK_TREE_LIMITS.defaultBlocks),
		),
		store,
	});
	if (!tree) throw new NotFoundError("Outline block", request.sourceBlockId);
	const source = tree.state.space;
	const parentRef = target.parent;
	if (parentRef && "id" in parentRef) {
		const parent = (await store.getBlockMetasByIds([parentRef.id]))[0];
		if (!parent || parent.deleted || parent.spaceId !== target.space.id)
			throw new NotFoundError("Outline block", parentRef.id);
		if (
			target.space.id === source.id &&
			(await isAtOrUnder(store, source.id, parent.id, tree.root.id))
		)
			throw new ValidationError("A block cannot be copied into itself or under itself");
	}
	const order: OutlineNode[] = [tree.root];
	for (let i = 0; i < order.length; i++) {
		for (const child of (order[i] as OutlineNode).children)
			if (!request.skip?.(child)) order.push(child);
	}
	const extra = request.provenance ? 1 : 0;
	const room = Math.max(1, maxBlocks - extra);
	const window = order.slice(0, room);
	await loadBodiesWithin(tree.state, window, maxBytes, { store });
	const taken: OutlineNode[] = [];
	const takenIds = new Set<string>();
	let bytes = 0;
	for (const node of window) {
		if (node.content === null) break;
		if (node !== tree.root && !takenIds.has(node.parentId as string)) continue;
		const size = utf8(node.content);
		if (node !== tree.root && bytes + size > maxBytes) break;
		bytes += size;
		taken.push(node);
		takenIds.add(node.id);
	}
	// What the source holds past the read counts as omitted too (at least one more block).
	let omitted = order.length - taken.length + (tree.state.truncated ? 1 : 0);

	// ── Ids and sids, derived; what an earlier call wrote is found by them. ──
	const idOf = (node: OutlineNode) =>
		node === tree.root && request.rootId ? request.rootId : copiedBlockId(copyId, node.id);
	const ids = taken.map(idOf);
	const provenanceId = request.provenance?.id ?? copiedBlockId(copyId, "\u0000provenance");
	const madeParentId =
		parentRef && "create" in parentRef ? copiedBlockId(copyId, "\u0000parent") : null;
	const existing = new Map(
		(
			await store.getBlockMetasByIds([
				...ids,
				provenanceId,
				...(madeParentId ? [madeParentId] : []),
			])
		).map((m) => [m.id, m] as const),
	);
	for (const meta of existing.values()) {
		if (meta.spaceId !== target.space.id)
			throw new ValidationError("The copy's id names blocks of another space");
	}
	const rootThere = existing.get(ids[0] as string);
	if (rootThere?.deleted) {
		// The copy was deleted since: nothing goes under it.
		return {
			copyId,
			root: {
				id: rootThere.id,
				sid: rootThere.sid,
				address: `${target.space.key}/${rootThere.sid}`,
				spaceId: target.space.id,
			},
			copied: 0,
			written: 0,
			omitted: order.length,
			dropped: 0,
			commits: 0,
			done: false,
			stopped: { code: "OUTLINE_COPY_DELETED", message: "The copy was deleted" },
		};
	}
	// Sids: a block there keeps its own; a derived one taken by another block draws again.
	const planned: Planned[] = [];
	const wantSids = new Map<string, number>();
	for (const [index, node] of taken.entries()) {
		const id = ids[index] as string;
		const there = existing.get(id);
		planned.push({ node, id, sid: there?.sid ?? copiedSid(copyId, node.id, 0), there: !!there });
		if (!there) wantSids.set(id, 0);
	}
	for (let attempt = 1; attempt <= 4 && wantSids.size > 0; attempt++) {
		const fresh = planned.filter((p) => wantSids.has(p.id));
		const used = new Set(
			(await store.getBlockMetas(target.space.id, { sids: fresh.map((p) => p.sid) })).map(
				(m) => m.sid,
			),
		);
		wantSids.clear();
		for (const p of fresh) {
			if (!used.has(p.sid)) continue;
			p.sid = copiedSid(copyId, p.node.id, attempt);
			wantSids.set(p.id, attempt);
		}
	}
	// Under a copied block deleted since: neither it nor what is under it is written.
	const gone = new Set<string>();
	for (const p of planned) {
		const there = existing.get(p.id);
		if (there?.deleted || (p.node.parentId !== null && gone.has(p.node.parentId)))
			gone.add(p.node.id);
	}
	const live = planned.filter((p) => !gone.has(p.node.id));
	omitted += planned.length - live.length;

	const copied: OutlineCopiedLinks = {
		sourceKey: source.key,
		bySid: new Map(live.map((p) => [p.node.sid, `${target.space.key}/${p.sid}`])),
		byAlias: new Map(
			live.flatMap((p) =>
				p.node.alias ? [[p.node.alias, `${target.space.key}/${p.sid}`] as const] : [],
			),
		),
	};
	const people = await peopleWhoCanWorkIn(
		live.flatMap((p) =>
			p.node !== tree.root && p.node.task?.assignee ? [p.node.task.assignee] : [],
		),
		target.space,
	);
	const dropped = live.filter(
		(p) => p.node !== tree.root && !!p.node.task?.assignee && !people.has(p.node.task.assignee),
	).length;

	// ── The operations, parents first, then cut into commits. ──
	const root = planned[0] as Planned;
	const idBySource = new Map(live.map((p) => [p.node.id, p] as const));
	interface Step {
		op: OutlineOp;
		bytes: number;
		/** The block this op writes, by its source id (none: the parent made, the provenance). */
		source: string | null;
	}
	const steps: Step[] = [];
	const madeThere = madeParentId ? existing.get(madeParentId) : undefined;
	if (madeParentId && parentRef && "create" in parentRef && !madeThere) {
		steps.push({
			op: {
				op: "insert",
				id: madeParentId,
				parent: null,
				content: parentRef.create.content,
				...(parentRef.create.alias ? { alias: parentRef.create.alias } : {}),
			},
			bytes: utf8(parentRef.create.content),
			source: null,
		});
	}
	const topParent: OutlineBlockRef | null =
		parentRef === null
			? null
			: "id" in parentRef
				? { id: parentRef.id }
				: { id: madeParentId as string };
	for (const p of live) {
		if (p.there) continue;
		const node = p.node;
		const content = copiedContent(node.content as string, copied);
		const task = node.task
			? node === tree.root && request.rootTask
				? request.rootTask(node.task, copied)
				: copiedTask(node.task, copied, people)
			: null;
		const parent: OutlineBlockRef | null =
			node === tree.root
				? topParent
				: { id: (idBySource.get(node.parentId as string) as Planned).id };
		steps.push({
			op: {
				op: "insert",
				id: p.id,
				sid: p.sid,
				parent,
				position: node === tree.root ? (target.position ?? { last: true }) : { last: true },
				content,
				task,
			},
			bytes: utf8(content),
			source: node.id,
		});
		if (node === tree.root && request.provenance && !existing.get(provenanceId)) {
			const text = request.provenance.text({
				source: `${source.key}/${node.sid}`,
				omitted,
				dropped,
			});
			steps.push({
				op: {
					op: "insert",
					id: provenanceId,
					parent: { id: p.id },
					position: { first: true },
					content: text,
				},
				bytes: utf8(text),
				source: null,
			});
		}
	}
	// A parent the root's copy goes under that a commit before made: kept by id.
	const batches: Step[][] = [];
	let batch: Step[] = [];
	let batchBytes = 0;
	for (const step of steps) {
		if (
			batch.length > 0 &&
			(batch.length >= OUTLINE_SUBTREE_COPY_LIMITS.batchOps ||
				batchBytes + step.bytes > OUTLINE_SUBTREE_COPY_LIMITS.batchBytes)
		) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(step);
		batchBytes += step.bytes;
	}
	if (batch.length > 0) batches.push(batch);
	// Within a batch a parent written by the same batch is named by its temporary name.
	for (const list of batches) {
		const inBatch = new Set(
			list.flatMap((s) => (s.op.op === "insert" && s.op.id ? [s.op.id] : [])),
		);
		for (const step of list) {
			if (step.op.op !== "insert") continue;
			step.op.tempId = `t:${step.op.id}`;
			const parent = step.op.parent;
			if (parent && "id" in parent && inBatch.has(parent.id))
				step.op.parent = { tempId: `t:${parent.id}` };
		}
	}

	const copiedBefore = live.filter((p) => p.there).length;
	let written = 0;
	let writtenOfSource = 0;
	let commits = 0;
	let stopped: OutlineSubtreeCopyResult["stopped"];
	const summary = request.summary ?? `copied ${source.key}/${tree.root.sid}`;
	for (const [index, list] of batches.entries()) {
		try {
			await write(
				{
					spaceId: target.space.id,
					ops: list.map((s) => s.op),
					actor: request.actor,
					responsibleUserId: request.responsibleUserId,
					...(request.narratorId ? { narratorId: request.narratorId } : {}),
					summary:
						batches.length > 1 ? `${summary} (part ${index + 1} of ${batches.length})` : summary,
				},
				writeOptions,
			);
		} catch (error) {
			// Nothing written yet: the write's own refusal is the answer.
			if (commits === 0) throw error;
			const code = error instanceof AppError ? error.code : "OUTLINE_COPY_STOPPED";
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("An outline copy stopped part way", { copyId, part: index + 1, error: message });
			stopped = { code, message };
			break;
		}
		commits++;
		written += list.length;
		writtenOfSource += list.filter((s) => s.source !== null).length;
	}
	const rootMeta = existing.get(root.id);
	return {
		copyId,
		root: {
			id: root.id,
			sid: rootMeta?.sid ?? root.sid,
			address: `${target.space.key}/${rootMeta?.sid ?? root.sid}`,
			spaceId: target.space.id,
		},
		copied: copiedBefore + writtenOfSource,
		written,
		omitted: stopped ? omitted + (live.length - copiedBefore - writtenOfSource) : omitted,
		dropped,
		commits,
		done: !stopped,
		...(stopped ? { stopped } : {}),
	};
}
