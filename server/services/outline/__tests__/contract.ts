/**
 * The outline store contract: business facts every backend must satisfy, written once and run
 * against SQLite (`store-contract.test.ts`, by default) and PostgreSQL
 * (`tests/server/services/outline/pg-outline-store.test.ts`, with `PG_INTEGRATION=1`).
 *
 * Each case creates its own spaces, so cases need no cleanup and can share a database. The
 * write path (`writeOutline`) runs against the store under test, so the invariants are checked
 * end to end: planning reads, the atomic section, and what lands in the tables.
 */
import { expect } from "bun:test";
import { eventBus, type NarraForkEvent } from "@server/lib/event-bus";
import { generateId } from "@server/lib/id";
import {
	type BlockNode,
	isShortId,
	isSpaceKey,
	normalizeBlock,
	serializeBody,
} from "@shared/outline";
import { OutlineConflictError, OutlineWriteError, type OutlineWriteErrorCode } from "../errors";
import { contentLinks, dependsLinks, linkKey, tagLinks } from "../links";
import { OUTLINE_CHANGE, OUTLINE_LIMITS, type OutlineTaskJson } from "../model";
import { revertCommit } from "../revert";
import {
	type OutlineBlockRow,
	type OutlineCommitPlan,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineSpaceRow,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineTaskClaimRow,
	type OutlineVersionRow,
} from "../store/port";
import {
	type OutlineBlockRef,
	type OutlineOp,
	type OutlinePosition,
	type OutlineWriteInput,
	type OutlineWriteResult,
	writeOutline,
} from "../write";

export interface SpaceDump {
	space: OutlineSpaceRow;
	blocks: OutlineBlockRow[];
	versions: OutlineVersionRow[];
	links: OutlineLinkRow[];
	commits: OutlineCommitRow[];
	/** Claim rows of the space's blocks. */
	claims: OutlineTaskClaimRow[];
}

export interface OutlineContractContext {
	store: OutlineStore;
	seedUser(): Promise<string>;
	seedProject(): Promise<string>;
	/**
	 * A session; with `subagent`, a subagent as the runtime records one: its parent, and its root
	 * as `acl_root_narrator_id`.
	 */
	seedNarrator(subagent?: { parentId: string; rootId: string }): Promise<string>;
	/** Every row of one space, read straight from the tables. */
	dump(spaceId: string): Promise<SpaceDump>;
	/** Ids of blocks whose indexed content contains `needle` (3+ characters). */
	searchContent(needle: string): Promise<string[]>;
	/** Transactions in the randomized history check. */
	randomTransactions: number;
	/**
	 * Make a space look written before `in_process` existed: every block's flag false and the
	 * space not marked derived (what the migration leaves behind).
	 */
	resetInProcess(spaceId: string): Promise<void>;
	/** Delete the claim rows of tasks (a task in progress written before claims existed). */
	forgetClaims(taskBlockIds: readonly string[]): Promise<void>;
}

export interface ContractCase {
	name: string;
	run(ctx: OutlineContractContext): Promise<void>;
}

const NOW = "2026-10-26T00:00:00.000Z";
const ACTOR = { kind: "human" as const, id: "user-contract" };

/** A task as the write path stores it when `ACTOR` makes a block a task: managed by them. */
export function managedBy(
	task: OutlineTaskJson,
	actor: { kind: "human" | "agent" | "system"; id: string } = ACTOR,
): OutlineTaskJson {
	return { ...task, manager: { kind: actor.kind, id: actor.id } };
}

async function personalSpace(ctx: OutlineContractContext): Promise<OutlineSpaceRow> {
	return ctx.store.ensureSpace({ kind: "personal", ownerUserId: await ctx.seedUser() }, NOW);
}

function write(
	ctx: OutlineContractContext,
	space: OutlineSpaceRow,
	ops: OutlineOp[],
	extra: Partial<OutlineWriteInput> = {},
): Promise<OutlineWriteResult> {
	return writeOutline(
		{ spaceId: space.id, ops, actor: ACTOR, responsibleUserId: null, ...extra },
		{ store: ctx.store },
	);
}

async function rejects(
	promise: Promise<unknown>,
	code: OutlineWriteErrorCode,
): Promise<OutlineWriteError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OutlineWriteError);
		expect((error as OutlineWriteError).code).toBe(code);
		return error as OutlineWriteError;
	}
	throw new Error(`expected the write to be rejected with ${code}`);
}

async function nextSeq(ctx: OutlineContractContext, space: OutlineSpaceRow): Promise<number> {
	return (await ctx.store.getSpace(space.id))?.nextSeq ?? -1;
}

function contents(blocks: OutlineBlockRow[]): string[] {
	return blocks.map((b) => b.content);
}

function versionAt(versions: OutlineVersionRow[], seq: number): OutlineVersionRow | undefined {
	return versions.find((v) => v.fromSeq <= seq && (v.toSeq === null || seq < v.toSeq));
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant checks over a whole space
// ─────────────────────────────────────────────────────────────────────────────

export function linkSet(links: Array<{ kind: string; targetKind: string; targetRef: string }>) {
	return links
		.map((l) => linkKey(l as Parameters<typeof linkKey>[0]))
		.sort()
		.join("\n");
}

/**
 * The invariants `model.ts` lists, checked on every row of a space: history contiguity, the
 * current row equals its open version, live tree shape and pages, distinct sibling keys,
 * unique live aliases, open links match the current state, commit seqs match the counter.
 */
export function checkSpaceInvariants(dump: SpaceDump): void {
	const { blocks, versions, links, commits, space } = dump;
	const byId = new Map(blocks.map((b) => [b.id, b]));

	// Commits: seq 1..N, and the counter is N + 1.
	expect(commits.map((c) => c.seq)).toEqual(commits.map((_, i) => i + 1));
	expect(space.nextSeq).toBe(commits.length + 1);

	// History: contiguous versions, exactly one open, equal to the current row.
	const versionsOf = new Map<string, OutlineVersionRow[]>();
	for (const v of versions) {
		const list = versionsOf.get(v.blockId);
		if (list) list.push(v);
		else versionsOf.set(v.blockId, [v]);
	}
	for (const block of blocks) {
		const list = (versionsOf.get(block.id) ?? []).sort((a, b) => a.fromSeq - b.fromSeq);
		expect(list.length).toBeGreaterThan(0);
		expect((list[0] as OutlineVersionRow).changeFlags & OUTLINE_CHANGE.CREATE).toBe(
			OUTLINE_CHANGE.CREATE,
		);
		list.forEach((v, i) => {
			const next = list[i + 1];
			expect(v.toSeq).toBe(next ? next.fromSeq : null);
			if (next) expect(next.fromSeq).toBeGreaterThan(v.fromSeq);
			expect(v.content === null).toBe(v.deleted);
		});
		const open = list[list.length - 1] as OutlineVersionRow;
		expect(open.toSeq).toBeNull();
		expect({
			pageId: open.pageId,
			parentId: open.parentId,
			orderKey: open.orderKey,
			taskJson: open.taskJson,
			alias: open.alias,
			contentHash: open.contentHash,
			deleted: open.deleted,
			fromSeq: open.fromSeq,
			content: open.deleted ? null : open.content,
		}).toEqual({
			pageId: block.pageId,
			parentId: block.parentId,
			orderKey: block.orderKey,
			taskJson: block.taskJson,
			alias: block.alias,
			contentHash: block.contentHash,
			deleted: block.deleted,
			fromSeq: block.versionSeq,
			content: block.deleted ? null : block.content,
		});
	}

	// Live tree: live parents, pages are top-level ancestors, distinct sibling keys.
	const siblingKeys = new Set<string>();
	const aliases = new Set<string>();
	for (const block of blocks) {
		if (block.deleted) continue;
		let top = block;
		for (let depth = 0; top.parentId !== null; depth++) {
			const parent = byId.get(top.parentId);
			expect(parent?.deleted).toBe(false);
			top = parent as OutlineBlockRow;
			expect(depth).toBeLessThan(10_000);
		}
		expect(block.pageId).toBe(top.id);
		const key = `${block.parentId}\u0000${block.orderKey}`;
		expect(siblingKeys.has(key)).toBe(false);
		siblingKeys.add(key);
		if (block.alias !== null) {
			expect(aliases.has(block.alias)).toBe(false);
			aliases.add(block.alias);
		}
	}

	checkInProcess(dump);
	checkClaims(dump);

	// Open links: exactly what the current state produces (tags are only in the links table,
	// so they are taken from the open tag rows themselves).
	const openLinks = links.filter((l) => l.toSeq === null);
	for (const block of blocks) {
		const mine = openLinks.filter((l) => l.fromBlockId === block.id);
		if (block.deleted) {
			expect(mine).toEqual([]);
			continue;
		}
		const tags = mine.filter((l) => l.kind === "tag");
		expect(linkSet(mine)).toBe(
			linkSet([...contentLinks(block.content), ...dependsLinks(block.taskJson), ...tags]),
		);
	}
	// Link rows: open ranges never start after they end.
	for (const link of links) {
		if (link.toSeq !== null) expect(link.toSeq).toBeGreaterThan(link.fromSeq);
	}
}

/**
 * Claims follow the tasks: a claim with a holder is on a live task in progress, and every live
 * task in progress has a holder (outside tests, tasks in progress written before claims existed
 * have none; tests write none of those).
 */
export function checkClaims(dump: SpaceDump): void {
	const byId = new Map(dump.blocks.map((b) => [b.id, b]));
	const held = new Set<string>();
	for (const claim of dump.claims) {
		if (claim.holderNarratorId === null && claim.holderUserId === null) continue;
		const block = byId.get(claim.taskBlockId);
		expect({
			claim: claim.taskBlockId,
			deleted: block?.deleted,
			status: block?.taskJson?.status,
		}).toEqual({ claim: claim.taskBlockId, deleted: false, status: "doing" });
		// One holder at a time: a session or a person.
		expect(claim.holderNarratorId === null || claim.holderUserId === null).toBe(true);
		held.add(claim.taskBlockId);
	}
	for (const block of dump.blocks) {
		if (block.deleted || block.taskJson?.status !== "doing") continue;
		expect({ inProgress: block.id, held: held.has(block.id) }).toEqual({
			inProgress: block.id,
			held: true,
		});
	}
}

/**
 * `in_process` (a derived cache) of every live block: a task, under one, or anywhere in a
 * session space.
 */
export function checkInProcess(dump: SpaceDump): void {
	const byId = new Map(dump.blocks.map((b) => [b.id, b]));
	for (const block of dump.blocks) {
		if (block.deleted) continue;
		const parent = block.parentId === null ? null : byId.get(block.parentId);
		const want =
			dump.space.kind === "session" || block.taskJson !== null || (parent?.inProcess ?? false);
		expect({ block: block.id, inProcess: block.inProcess }).toEqual({
			block: block.id,
			inProcess: want,
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The randomized history check
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The reference model's view of one live block, also what a seq's snapshot records. */
interface ModelBlock {
	handle: string;
	parent: string | null;
	children: string[];
	content: string;
	task: OutlineTaskJson | null;
	alias: string | null;
	tags: string[];
	sid?: string;
	/** Split off content in the current transaction: no way to name it until it commits. */
	pending?: boolean;
}

export interface SnapshotEntry {
	parentId: string | null;
	pageId: string;
	index: number;
	content: string;
	task: OutlineTaskJson | null;
	alias: string | null;
	links: string;
}

/**
 * Random transactions against the store and an independent in-memory model of their meaning.
 * After every commit the live tree in the tables must equal the model; at the end, the tree
 * rebuilt from version rows for every seq (`from_seq <= s < to_seq`) must equal the model's
 * snapshot at that seq, open links included, and the space invariants must hold. Returns the
 * space and the model's snapshot at every commit seq, for checks built on the same history.
 */
export async function randomizedHistory(
	ctx: OutlineContractContext,
	seed: number,
): Promise<{ space: OutlineSpaceRow; snapshots: Map<number, Map<string, SnapshotEntry>> }> {
	const rnd = mulberry32(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
	const space = await personalSpace(ctx);
	const model = new Map<string, ModelBlock>();
	/** Blocks deleted by earlier transactions, as they were: what a `restore` brings back. */
	const graveyard = new Map<
		string,
		{
			sid: string;
			content: string;
			task: OutlineTaskJson | null;
			alias: string | null;
			tags: string[];
		}
	>();
	const pages: string[] = [];
	const snapshots = new Map<number, Map<string, SnapshotEntry>>();
	const words = ["alpha", "beta", "gamma", "delta", "omega", "kappa", "sigma", "tau"];
	let counter = 0;

	const childrenOf = (parent: string | null) =>
		parent === null ? pages : (model.get(parent) as ModelBlock).children;
	const live = () => [...model.values()].filter((b) => !b.pending);
	const subtree = (handle: string): string[] => {
		const out = [handle];
		for (let i = 0; i < out.length; i++) out.push(...(model.get(out[i] as string)?.children ?? []));
		return out;
	};
	const pageOf = (handle: string): string => {
		let current = model.get(handle) as ModelBlock;
		while (current.parent !== null) current = model.get(current.parent) as ModelBlock;
		return current.handle;
	};
	const ref = (handle: string): OutlineBlockRef => {
		if (handle.startsWith("tmp:")) return { tempId: handle };
		const sid = model.get(handle)?.sid;
		return rnd() < 0.5 || !sid ? { id: handle } : { sid };
	};
	// Content as stored: the canonical spelling of what was written, and the child blocks a
	// list in it becomes.
	const randomContent = (): { raw: string; content: string; split: BlockNode[] } => {
		const raw =
			rnd() < 0.1
				? `${pick(words)} ${++counter}\n\n- ${pick(words)} ${++counter}\n- [ ] ${pick(words)} ${++counter}\n  - ${pick(words)} ${++counter}`
				: rawContent();
		const normalized = normalizeBlock(raw);
		return { raw, content: normalized.content, split: normalized.children };
	};
	const rawContent = (): string => {
		counter++;
		const text = `${pick(words)} ${pick(words)} ${counter}`;
		const targets = live().filter((b) => b.sid);
		const roll = rnd();
		if (roll < 0.15 && targets.length > 0) return `![[${space.key}/${pick(targets).sid}]]`;
		if (roll < 0.4 && targets.length > 0) return `${text} [[${space.key}/${pick(targets).sid}]]`;
		if (roll < 0.55) return `${text} [[Topic ${Math.floor(rnd() * 4)}]]`;
		return text;
	};
	const position = (siblings: string[]): { op?: OutlinePosition; index: number } => {
		const roll = rnd();
		// Blocks split off in this transaction cannot be named, so they are never anchors.
		const anchors = siblings.filter((h) => !model.get(h)?.pending);
		if (anchors.length === 0 || roll < 0.3) return { index: siblings.length };
		if (roll < 0.45) return { op: { first: true }, index: 0 };
		const anchor = pick(anchors);
		const at = siblings.indexOf(anchor);
		return rnd() < 0.5
			? { op: { after: ref(anchor) }, index: at + 1 }
			: { op: { before: ref(anchor) }, index: at };
	};
	const freeAlias = (): string | null => {
		const alias = `Q${Math.floor(rnd() * 12)}`;
		return live().some((b) => b.alias === alias) ? null : alias;
	};
	const randomTask = (): OutlineTaskJson => {
		const targets = live().filter((b) => b.sid);
		const depends =
			rnd() < 0.4 && targets.length > 0
				? [{ target: `${space.key}/${pick(targets).sid}`, label: null }]
				: rnd() < 0.2
					? [{ target: "Prerequisite", label: null }]
					: undefined;
		const task: OutlineTaskJson = {
			status: pick(["todo", "doing", "done", "cancelled"] as const),
			assignee: rnd() < 0.3 ? "agent:worker" : null,
		};
		if (depends) task.depends = depends;
		return task;
	};

	for (let t = 0; t < ctx.randomTransactions; t++) {
		const before = structuredClone([...model.entries()]);
		const beforePages = [...pages];
		const beforeGraveyard = structuredClone([...graveyard.entries()]);
		const ops: OutlineOp[] = [];
		/** New blocks of this transaction: the insert itself, or the n-th block its content split off. */
		const created: Array<{ op: number; handle: string; split?: number }> = [];
		/** The blocks content split off become the first children of `under`, in pre-order. */
		const addSplit = (under: string, nodes: BlockNode[], op: number) => {
			let n = 0;
			const walk = (parent: string, list: BlockNode[]) => {
				const kids = (model.get(parent) as ModelBlock).children;
				list.forEach((node, i) => {
					const handle = `split:${t}:${op}:${n}`;
					created.push({ op, handle, split: n++ });
					model.set(handle, {
						handle,
						parent,
						children: [],
						content: serializeBody(node.body),
						task: node.task ? managedBy({ status: node.task, assignee: null }) : null,
						alias: null,
						tags: [],
						pending: true,
					});
					kids.splice(i, 0, handle);
					walk(handle, node.children);
				});
			};
			walk(under, nodes);
		};
		const opCount = 1 + Math.floor(rnd() * 5);
		let staleOp = false;
		for (let k = 0; k < opCount; k++) {
			const blocks = live();
			const roll = blocks.length < 3 ? 0 : rnd();
			const existing = blocks.filter((b) => !b.handle.startsWith("tmp:"));
			const base = () => {
				// Occasionally send a stale base version: the whole transaction must be refused.
				if (rnd() < 0.03) {
					staleOp = true;
					return { baseVersionSeq: 999_999 };
				}
				return {};
			};
			if (roll < 0.4) {
				const parent = blocks.length === 0 || rnd() < 0.2 ? null : pick(blocks).handle;
				const siblings = childrenOf(parent);
				const place = position(siblings);
				const handle = `tmp:${t}:${k}`;
				const { raw, content, split } = randomContent();
				const task = rnd() < 0.2 ? randomTask() : null;
				const alias = rnd() < 0.15 ? freeAlias() : null;
				const tags = rnd() < 0.15 ? [pick(["Design", "Risk", "Ops"])] : [];
				ops.push({
					op: "insert",
					tempId: handle,
					parent: parent === null ? null : ref(parent),
					...(place.op ? { position: place.op } : {}),
					content: raw,
					...(task ? { task } : {}),
					...(alias ? { alias } : {}),
					...(tags.length ? { tags } : {}),
				});
				model.set(handle, {
					handle,
					parent,
					children: [],
					content,
					task: task && managedBy(task),
					alias,
					tags,
				});
				siblings.splice(place.index, 0, handle);
				created.push({ op: k, handle });
				addSplit(handle, split, k);
			} else if (roll < 0.58) {
				const target = pick(blocks);
				const op: OutlineOp = { op: "update", block: ref(target.handle) };
				if (rnd() < 0.8) {
					const { raw, content, split } = randomContent();
					op.content = raw;
					target.content = content;
					addSplit(target.handle, split, k);
				}
				if (rnd() < 0.25) {
					const alias = rnd() < 0.3 ? null : freeAlias();
					if (alias !== null || target.alias !== null) {
						op.alias = alias;
						target.alias = alias;
					}
				}
				if (rnd() < 0.25) {
					op.tags = rnd() < 0.3 ? [] : [pick(["Design", "Risk", "Ops"]), pick(["Design", "Q"])];
					target.tags = [...new Set(op.tags)];
				}
				if (!target.handle.startsWith("tmp:")) Object.assign(op, base());
				ops.push(op);
			} else if (roll < 0.76 && existing.length > 0) {
				const target = pick(blocks);
				const banned = new Set(subtree(target.handle));
				const parents = blocks.filter((b) => !banned.has(b.handle));
				const parent = parents.length === 0 || rnd() < 0.15 ? null : pick(parents).handle;
				const from = childrenOf(target.parent);
				from.splice(from.indexOf(target.handle), 1);
				const siblings = childrenOf(parent);
				const place = position(siblings);
				ops.push({
					op: "move",
					block: ref(target.handle),
					parent: parent === null ? null : ref(parent),
					...(place.op ? { position: place.op } : {}),
					...(target.handle.startsWith("tmp:") ? {} : base()),
				});
				siblings.splice(place.index, 0, target.handle);
				target.parent = parent;
			} else if (roll < 0.86) {
				const target = pick(blocks);
				ops.push({
					op: "delete",
					block: ref(target.handle),
					...(target.handle.startsWith("tmp:") ? {} : base()),
				});
				const from = childrenOf(target.parent);
				from.splice(from.indexOf(target.handle), 1);
				for (const handle of subtree(target.handle)) {
					const gone = model.get(handle) as ModelBlock;
					// Restorable later: blocks that existed before this transaction.
					if (!handle.startsWith("tmp:") && !gone.pending && gone.sid)
						graveyard.set(handle, {
							sid: gone.sid,
							content: gone.content,
							task: gone.task,
							alias: gone.alias,
							tags: gone.tags,
						});
					model.delete(handle);
				}
			} else if (roll < 0.92 && graveyard.size > 0) {
				// Brought back as it was (its descendants stay deleted), under a live block or as a
				// page; its alias only if no live block holds it now.
				const [id, gone] = pick([...graveyard.entries()]);
				const parents = live();
				const parent = parents.length === 0 || rnd() < 0.3 ? null : pick(parents).handle;
				ops.push({
					op: "restore",
					block: { id },
					parent: parent === null ? null : ref(parent),
					position: { last: true },
				});
				const alias =
					gone.alias !== null && !live().some((b) => b.alias === gone.alias) ? gone.alias : null;
				model.set(id, {
					handle: id,
					parent,
					children: [],
					content: gone.content,
					task: gone.task,
					alias,
					tags: gone.tags,
					sid: gone.sid,
				});
				childrenOf(parent).push(id);
				graveyard.delete(id);
			} else {
				const target = pick(blocks);
				const task = rnd() < 0.25 ? null : randomTask();
				ops.push({
					op: "setTask",
					block: ref(target.handle),
					// Every field explicitly, so the patch replaces the whole task as the model does.
					task: task && { ...task, depends: task.depends ?? null, due: null },
					...(target.handle.startsWith("tmp:") ? {} : base()),
				});
				target.task = task && managedBy(task);
			}
		}

		let result: OutlineWriteResult;
		try {
			result = await write(ctx, space, ops);
		} catch (error) {
			if (staleOp && error instanceof OutlineConflictError) {
				model.clear();
				for (const [handle, block] of before) model.set(handle, block);
				pages.splice(0, pages.length, ...beforePages);
				graveyard.clear();
				for (const [handle, gone] of beforeGraveyard) graveyard.set(handle, gone);
				continue;
			}
			throw new Error(
				`seed ${seed}, transaction ${t}: ${error instanceof Error ? error.message : error}\n${JSON.stringify(ops)}`,
			);
		}
		expect(staleOp).toBe(false);

		// Give the model's new blocks their real ids.
		const rename = new Map<string, string>();
		const made = (op: number, split?: number) => {
			const res = result.results[op];
			return split === undefined ? res : res?.split[split];
		};
		for (const { op, handle, split } of created) {
			const res = made(op, split);
			if (res) rename.set(handle, res.blockId);
		}
		const renamed = new Map<string, ModelBlock>();
		const fix = (h: string) => rename.get(h) ?? h;
		for (const block of model.values()) {
			block.handle = fix(block.handle);
			block.parent = block.parent === null ? null : fix(block.parent);
			block.children = block.children.map(fix);
			renamed.set(block.handle, block);
		}
		model.clear();
		for (const [handle, block] of renamed) model.set(handle, block);
		pages.splice(0, pages.length, ...pages.map(fix));
		for (const { op, split } of created) {
			const res = made(op, split);
			const block = res ? model.get(res.blockId) : undefined;
			if (res && block) {
				block.sid = res.sid;
				block.pending = false;
			}
		}

		// The tables' live tree equals the model, and the derived in-process flags and the claims
		// follow it.
		const compare = async (what: string): Promise<Map<string, SnapshotEntry>> => {
			const dump = await ctx.dump(space.id);
			checkInProcess(dump);
			checkClaims(dump);
			const snapshot = new Map<string, SnapshotEntry>();
			for (const block of model.values()) {
				const siblings = childrenOf(block.parent);
				snapshot.set(block.handle, {
					parentId: block.parent,
					pageId: pageOf(block.handle),
					index: siblings.indexOf(block.handle),
					content: block.content,
					task: block.task,
					alias: block.alias,
					links: linkSet([
						...contentLinks(block.content),
						...dependsLinks(block.task),
						...tagLinks(block.tags),
					]),
				});
			}
			const current = treeAt(dump, Number.MAX_SAFE_INTEGER);
			if (!Bun.deepEquals(current, snapshot)) {
				throw new Error(
					`seed ${seed}, transaction ${t}: the tables differ from the model ${what}\n${JSON.stringify(ops, null, 1)}\nresults ${JSON.stringify(result.results)}\nmodel ${JSON.stringify([...snapshot])}\ntables ${JSON.stringify([...current])}`,
				);
			}
			return snapshot;
		};
		const snapshot = await compare("after");
		if (result.commit) snapshots.set(result.commit.seq, snapshot);

		// Now and then the commit is reverted right away: everything is as before it.
		if (result.commit && rnd() < 0.12) {
			const reverted = await revertCommit(
				{ commitId: result.commit.id, actor: ACTOR, responsibleUserId: null },
				{ store: ctx.store },
			);
			if (reverted.skipped.length > 0 || !reverted.commit)
				throw new Error(
					`seed ${seed}, transaction ${t}: reverting the last commit left ${JSON.stringify(reverted.skipped)}`,
				);
			model.clear();
			for (const [handle, block] of before) model.set(handle, block);
			pages.splice(0, pages.length, ...beforePages);
			graveyard.clear();
			for (const [handle, gone] of beforeGraveyard) graveyard.set(handle, gone);
			snapshots.set(reverted.commit.seq, await compare("after reverting it"));
		}
	}

	// History: every seq's tree rebuilt from version rows equals the model at that seq.
	const dump = await ctx.dump(space.id);
	expect(snapshots.size).toBeGreaterThan(0);
	for (const [seq, snapshot] of snapshots) expect(treeAt(dump, seq)).toEqual(snapshot);
	checkSpaceInvariants(dump);
	checkChangeFlags(dump);
	return { space, snapshots };
}

/** The live tree as of `seq`, rebuilt from version and link rows alone. */
export function treeAt(dump: SpaceDump, seq: number): Map<string, SnapshotEntry> {
	const live = new Map<string, OutlineVersionRow>();
	const byBlock = new Map<string, OutlineVersionRow[]>();
	for (const v of dump.versions) {
		const list = byBlock.get(v.blockId);
		if (list) list.push(v);
		else byBlock.set(v.blockId, [v]);
	}
	for (const [id, versions] of byBlock) {
		const v = versionAt(versions, seq);
		if (v && !v.deleted) live.set(id, v);
	}
	const siblings = new Map<string | null, string[]>();
	for (const [id, v] of live) {
		const list = siblings.get(v.parentId);
		if (list) list.push(id);
		else siblings.set(v.parentId, [id]);
	}
	for (const list of siblings.values()) {
		list.sort((a, b) => {
			const ka = live.get(a)?.orderKey as string;
			const kb = live.get(b)?.orderKey as string;
			return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : 1;
		});
	}
	const out = new Map<string, SnapshotEntry>();
	for (const [id, v] of live) {
		const links = dump.links.filter(
			(l) => l.fromBlockId === id && l.fromSeq <= seq && (l.toSeq === null || seq < l.toSeq),
		);
		out.set(id, {
			parentId: v.parentId,
			pageId: v.pageId,
			index: (siblings.get(v.parentId) ?? []).indexOf(id),
			content: v.content as string,
			task: v.taskJson,
			alias: v.alias,
			links: linkSet(links),
		});
	}
	return out;
}

/** Each version's flags describe exactly how it differs from the previous one. */
export function checkChangeFlags(dump: SpaceDump): void {
	const byBlock = new Map<string, OutlineVersionRow[]>();
	for (const v of dump.versions) {
		const list = byBlock.get(v.blockId);
		if (list) list.push(v);
		else byBlock.set(v.blockId, [v]);
	}
	const tagsAt = (blockId: string, seq: number) =>
		linkSet(
			dump.links.filter(
				(l) =>
					l.fromBlockId === blockId &&
					l.kind === "tag" &&
					l.fromSeq <= seq &&
					(l.toSeq === null || seq < l.toSeq),
			),
		);
	const structural =
		OUTLINE_CHANGE.CONTENT |
		OUTLINE_CHANGE.MOVE |
		OUTLINE_CHANGE.PAGE |
		OUTLINE_CHANGE.DELETE |
		OUTLINE_CHANGE.TASK;
	for (const [blockId, list] of byBlock) {
		list.sort((a, b) => a.fromSeq - b.fromSeq);
		list.forEach((v, i) => {
			const prev = list[i - 1];
			if (!prev) {
				expect(v.changeFlags & OUTLINE_CHANGE.CREATE).toBe(OUTLINE_CHANGE.CREATE);
				return;
			}
			let want = 0;
			if (v.contentHash !== prev.contentHash) want |= OUTLINE_CHANGE.CONTENT;
			if (v.parentId !== prev.parentId || v.orderKey !== prev.orderKey) want |= OUTLINE_CHANGE.MOVE;
			if (v.pageId !== prev.pageId) want |= OUTLINE_CHANGE.PAGE;
			if (v.deleted && !prev.deleted) want |= OUTLINE_CHANGE.DELETE;
			if (JSON.stringify(v.taskJson) !== JSON.stringify(prev.taskJson)) want |= OUTLINE_CHANGE.TASK;
			expect(v.changeFlags & structural).toBe(want);
			// A tombstone closes the tag links too, without that being a property change.
			const props =
				v.alias !== prev.alias ||
				(!v.deleted && tagsAt(blockId, v.fromSeq) !== tagsAt(blockId, prev.fromSeq));
			expect((v.changeFlags & OUTLINE_CHANGE.PROPS) !== 0).toBe(props);
			// A version records a change; none is empty.
			expect(v.changeFlags).not.toBe(0);
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The cases
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_STORE_CONTRACT: ContractCase[] = [
	{
		name: "spaces: one per project, user and narrator, created on first use",
		async run(ctx) {
			const user = await ctx.seedUser();
			const project = await ctx.seedProject();
			const narrator = await ctx.seedNarrator();
			const p = await ctx.store.ensureSpace({ kind: "project", projectId: project }, NOW);
			const u = await ctx.store.ensureSpace({ kind: "personal", ownerUserId: user }, NOW);
			const n = await ctx.store.ensureSpace({ kind: "session", narratorId: narrator }, NOW);
			expect(new Set([p.id, u.id, n.id]).size).toBe(3);
			expect(new Set([p.key, u.key, n.key]).size).toBe(3);
			for (const space of [p, u, n]) {
				expect(isSpaceKey(space.key)).toBe(true);
				expect(space.nextSeq).toBe(1);
				expect(await ctx.store.getSpace(space.id)).toEqual(space);
				expect(await ctx.store.getSpaceByKey(space.key)).toEqual(space);
			}
			expect(p).toMatchObject({ kind: "project", projectId: project, narratorId: null });
			expect(u).toMatchObject({ kind: "personal", ownerUserId: user, projectId: null });
			expect(n).toMatchObject({ kind: "session", narratorId: narrator, ownerUserId: null });
			expect((await ctx.store.ensureSpace({ kind: "project", projectId: project }, NOW)).id).toBe(
				p.id,
			);
			expect((await ctx.store.findSpace({ kind: "session", narratorId: narrator }))?.id).toBe(n.id);
			expect(await ctx.store.findSpace({ kind: "personal", ownerUserId: "nobody" })).toBeNull();
			expect(await ctx.store.getSpace("missing")).toBeNull();

			// Racing creators converge on one row.
			const other = await ctx.seedProject();
			const raced = await Promise.all(
				Array.from({ length: 6 }, () =>
					ctx.store.ensureSpace({ kind: "project", projectId: other }, NOW),
				),
			);
			expect(new Set(raced.map((s) => s.id)).size).toBe(1);
		},
	},
	{
		name: "insert: pages, children and positions; reads return them",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const events: NarraForkEvent[] = [];
			const listener = (event: NarraForkEvent) => {
				if (event.type === "outline:committed" && event.spaceId === space.id) events.push(event);
			};
			eventBus.on("outline:committed", listener);
			let r: OutlineWriteResult;
			try {
				r = await write(
					ctx,
					space,
					[
						{ op: "insert", tempId: "p", parent: null, content: "# Plan" },
						{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "first" },
						{ op: "insert", parent: { tempId: "p" }, content: "second" },
						{
							op: "insert",
							parent: { tempId: "p" },
							position: { after: { tempId: "a" } },
							content: "between",
						},
						{ op: "insert", parent: { tempId: "p" }, position: { first: true }, content: "zeroth" },
						{ op: "insert", parent: { tempId: "a" }, content: "nested" },
					],
					{
						actor: { kind: "agent", id: "narrator-1" },
						responsibleUserId: "user-1",
						narratorId: "narrator-1",
						messageId: "message-1",
						toolCallId: "tool-1",
					},
				);
			} finally {
				eventBus.off("outline:committed", listener);
			}
			expect(r.commit?.seq).toBe(1);
			const [page, a, , , , nested] = r.results as OutlineWriteResult["results"];
			if (!page || !a || !nested) throw new Error("missing results");
			expect(isShortId(page.sid)).toBe(true);
			expect(page.address).toBe(`${space.key}/${page.sid}`);
			expect(r.pageIds).toEqual([page.blockId]);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				seq: 1,
				commitId: r.commit?.id,
				pageIds: [page.blockId],
				actorKind: "agent",
				actorId: "narrator-1",
			});

			expect(contents(await ctx.store.listChildren(space.id, page.blockId, 100))).toEqual([
				"zeroth",
				"first",
				"between",
				"second",
			]);
			expect((await ctx.store.listChildren(space.id, null, 100)).map((b) => b.id)).toEqual([
				page.blockId,
			]);
			const nestedRow = await ctx.store.getBlock(nested.blockId);
			expect(nestedRow).toMatchObject({
				parentId: a.blockId,
				pageId: page.blockId,
				spaceId: space.id,
				content: "nested",
				authorKind: "agent",
				authorId: "narrator-1",
				versionSeq: 1,
				deleted: false,
			});
			expect((await ctx.store.getBlockBySid(space.id, nested.sid))?.id).toBe(nested.blockId);
			const pageBlocks = await ctx.store.listPageBlocks(page.blockId, 100);
			expect(pageBlocks.truncated).toBe(false);
			expect(pageBlocks.blocks).toHaveLength(6);
			expect((await ctx.store.listPageBlocks(page.blockId, 3)).truncated).toBe(true);

			const versions = await ctx.store.listBlockVersions(nested.blockId, 10);
			expect(versions).toEqual([
				expect.objectContaining({
					fromSeq: 1,
					toSeq: null,
					commitId: r.commit?.id,
					changeFlags: OUTLINE_CHANGE.CREATE,
					content: "nested",
					deleted: false,
				}),
			]);
			expect(await ctx.store.listPageVersions(page.blockId, { limit: 100 })).toHaveLength(6);
			const commits = await ctx.store.listCommits(space.id, { limit: 10 });
			expect(commits).toEqual([
				{
					id: r.commit?.id as string,
					spaceId: space.id,
					seq: 1,
					kind: "edit",
					actorKind: "agent",
					actorId: "narrator-1",
					responsibleUserId: "user-1",
					narratorId: "narrator-1",
					messageId: "message-1",
					toolCallId: "tool-1",
					createdAt: expect.any(String),
					summary: "insert 6",
				},
			]);
			expect(await nextSeq(ctx, space)).toBe(2);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "insert: explicit order keys, a taken key lands after its holder",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", parent: { tempId: "p" }, position: { orderKey: "a5" }, content: "five" },
				{ op: "insert", parent: { tempId: "p" }, position: { orderKey: "a2" }, content: "two" },
				{
					op: "insert",
					parent: { tempId: "p" },
					position: { orderKey: "a5" },
					content: "after five",
				},
				{ op: "insert", tempId: "z", parent: { tempId: "p" }, content: "last" },
				{
					op: "insert",
					parent: { tempId: "p" },
					position: { before: { tempId: "z" } },
					content: "before last",
				},
			]);
			const page = r.results[0]?.blockId as string;
			const children = await ctx.store.listChildren(space.id, page, 100);
			expect(contents(children)).toEqual(["two", "five", "after five", "before last", "last"]);
			expect(children[0]?.orderKey).toBe("a2");
			expect(children[1]?.orderKey).toBe("a5");
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "update: closes the open version and only the links the content produced",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r1 = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{
					op: "insert",
					tempId: "b",
					parent: { tempId: "p" },
					content: "see [[k1/abcd1234]] and [[Some Title]]",
					tags: ["Design"],
				},
			]);
			const b = r1.results[1] as OutlineWriteResult["results"][number];
			const r2 = await write(
				ctx,
				space,
				[{ op: "update", block: { id: b.blockId }, content: "see [[k1/abcd1234]] and [[Other]]" }],
				{ actor: { kind: "agent", id: "narrator-2" } },
			);
			expect(r2.commit?.seq).toBe(2);
			const versions = await ctx.store.listBlockVersions(b.blockId, 10);
			expect(versions.map((v) => [v.fromSeq, v.toSeq, v.changeFlags])).toEqual([
				[1, 2, OUTLINE_CHANGE.CREATE],
				[2, null, OUTLINE_CHANGE.CONTENT],
			]);
			expect(versions[0]?.content).toBe("see [[k1/abcd1234]] and [[Some Title]]");
			expect(await ctx.store.getBlock(b.blockId)).toMatchObject({
				content: "see [[k1/abcd1234]] and [[Other]]",
				authorKind: "agent",
				authorId: "narrator-2",
				versionSeq: 2,
			});
			const links = (await ctx.dump(space.id)).links
				.filter((l) => l.fromBlockId === b.blockId)
				.map((l) => [l.kind, l.targetKind, l.targetRef, l.fromSeq, l.toSeq])
				.sort();
			expect(links).toEqual(
				[
					["link", "block", "k1/abcd1234", 1, null],
					["link", "text", "Some Title", 1, 2],
					["link", "text", "Other", 2, null],
					["tag", "text", "Design", 1, null],
				].sort(),
			);

			// Writing the same content again changes nothing: no commit, no version.
			const r3 = await write(ctx, space, [
				{ op: "update", block: { sid: b.sid }, content: "see [[k1/abcd1234]] and [[Other]]" },
			]);
			expect(r3.commit).toBeNull();
			expect(await nextSeq(ctx, space)).toBe(3);
			expect(await ctx.store.listBlockVersions(b.blockId, 10)).toHaveLength(2);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "normalization: out-of-dialect structure becomes child blocks, with notes",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", parent: null, content: "Intro\n\n- one\n- two\n  - deep" },
			]);
			const res = r.results[0] as OutlineWriteResult["results"][number];
			expect(res.notes.map((n) => n.code)).toContain("split-list");
			expect(res.split).toHaveLength(3);
			expect((await ctx.store.getBlock(res.blockId))?.content).toBe("Intro");
			const children = await ctx.store.listChildren(space.id, res.blockId, 10);
			expect(contents(children)).toEqual(["one", "two"]);
			expect(
				contents(await ctx.store.listChildren(space.id, children[1]?.id as string, 10)),
			).toEqual(["deep"]);
			expect(res.split.map((s) => s.blockId)).toEqual([
				children[0]?.id,
				children[1]?.id,
				expect.any(String),
			]);

			// Splitting on update puts the new children before the existing ones.
			const r2 = await write(ctx, space, [
				{ op: "update", block: { id: res.blockId }, content: "Intro again\n\nsecond paragraph" },
			]);
			expect(r2.results[0]?.notes.map((n) => n.code)).toContain("split-paragraphs");
			expect(contents(await ctx.store.listChildren(space.id, res.blockId, 10))).toEqual([
				"second paragraph",
				"one",
				"two",
			]);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "caller-chosen sids and content normalized by the caller",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "a", sid: "Chosen01", parent: null, content: "page" },
				{
					op: "insert",
					sid: "Chosen02",
					parent: { tempId: "a" },
					content: `see [[${space.key}/Chosen01]]`,
				},
			]);
			expect(r.results.map((x) => x.sid)).toEqual(["Chosen01", "Chosen02"]);
			expect((await ctx.store.getBlockBySid(space.id, "Chosen02"))?.content).toBe(
				`see [[${space.key}/Chosen01]]`,
			);
			await rejects(
				write(ctx, space, [{ op: "insert", sid: "Chosen01", parent: null, content: "again" }]),
				"OUTLINE_ID_TAKEN",
			);
			await rejects(
				write(ctx, space, [
					{ op: "insert", sid: "Twice001", parent: null, content: "x" },
					{ op: "insert", sid: "Twice001", parent: null, content: "y" },
				]),
				"OUTLINE_INVALID_OP",
			);
			await rejects(
				write(ctx, space, [{ op: "insert", sid: "bad/sid", parent: null, content: "x" }]),
				"OUTLINE_INVALID_OP",
			);
			// Another space may use the same sid.
			const other = await personalSpace(ctx);
			expect(
				(await write(ctx, other, [{ op: "insert", sid: "Chosen01", parent: null, content: "x" }]))
					.results[0]?.sid,
			).toBe("Chosen01");

			// Canonical content is taken as is: not normalized again, its links as handed over.
			const content = "**bold** and [[Some page]]";
			const canonical = await writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "insert", parent: null, content }],
					actor: ACTOR,
					responsibleUserId: null,
				},
				{
					store: ctx.store,
					canonical: [
						{ content, links: [{ kind: "link", targetKind: "text", targetRef: "Some page" }] },
					],
				},
			);
			const id = canonical.results[0]?.blockId as string;
			expect((await ctx.store.getBlock(id))?.content).toBe(content);
			expect(
				(await ctx.store.listOpenLinks([id], 10)).map((l) => [l.kind, l.targetKind, l.targetRef]),
			).toEqual([["link", "text", "Some page"]]);
			await expect(
				writeOutline(
					{
						spaceId: space.id,
						ops: [{ op: "insert", parent: null, content: "other" }],
						actor: ACTOR,
						responsibleUserId: null,
					},
					{ store: ctx.store, canonical: [{ content: "not the same", links: [] }] },
				),
			).rejects.toThrow("canonical content does not match");
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "delete: a tombstone version for every descendant, links closed",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A", alias: "Gone1" },
				{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "A1 [[Target]]" },
				{ op: "insert", tempId: "a2", parent: { tempId: "a" }, content: "A2", tags: ["T"] },
				{ op: "insert", tempId: "a21", parent: { tempId: "a2" }, content: "A21" },
				{ op: "insert", tempId: "b", parent: { tempId: "p" }, content: "B" },
			]);
			const [p, a, a1, a2, a21, b] = r.results.map((x) => x.blockId);
			const d = await write(ctx, space, [{ op: "delete", block: { id: a as string } }]);
			expect(d.commit?.seq).toBe(2);
			for (const id of [a, a1, a2, a21] as string[]) {
				const versions = await ctx.store.listBlockVersions(id, 10);
				expect(versions.map((v) => [v.fromSeq, v.toSeq, v.changeFlags, v.deleted])).toEqual([
					[1, 2, OUTLINE_CHANGE.CREATE, false],
					[2, null, OUTLINE_CHANGE.DELETE, true],
				]);
				expect(versions[1]?.content).toBeNull();
				expect(versions[1]?.pageId).toBe(p);
				const row = await ctx.store.getBlock(id);
				expect(row?.deleted).toBe(true);
				expect(row?.content.length).toBeGreaterThan(0);
			}
			expect(await ctx.store.listBlockVersions(b as string, 10)).toHaveLength(1);
			expect(contents(await ctx.store.listChildren(space.id, p as string, 10))).toEqual(["B"]);
			expect((await ctx.store.listPageBlocks(p as string, 10)).blocks).toHaveLength(2);
			const dump = await ctx.dump(space.id);
			for (const link of dump.links.filter((l) => [a1, a2].includes(l.fromBlockId))) {
				expect(link.toSeq).toBe(2);
			}
			// The page as of seq 1 still has the subtree; as of seq 2 it does not.
			const at1 = dump.versions.filter((v) => v.pageId === p && versionAt([v], 1) && !v.deleted);
			expect(at1).toHaveLength(6);
			// The alias is free again, and the deleted subtree cannot be written to.
			await write(ctx, space, [
				{ op: "insert", parent: { id: p as string }, content: "new", alias: "Gone1" },
			]);
			await rejects(
				write(ctx, space, [{ op: "update", block: { id: a2 as string }, content: "x" }]),
				"OUTLINE_BLOCK_DELETED",
			);
			await rejects(
				write(ctx, space, [{ op: "insert", parent: { id: a21 as string }, content: "x" }]),
				"OUTLINE_BLOCK_DELETED",
			);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "move: a new page id for every descendant; same-page moves touch one block",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p1", parent: null, content: "page one" },
				{ op: "insert", tempId: "a", parent: { tempId: "p1" }, content: "A" },
				{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "A1" },
				{ op: "insert", tempId: "a11", parent: { tempId: "a1" }, content: "A11" },
				{ op: "insert", tempId: "p2", parent: null, content: "page two" },
				{ op: "insert", tempId: "c", parent: { tempId: "p2" }, content: "C" },
			]);
			const [p1, a, a1, a11, p2, c] = r.results.map((x) => x.blockId) as string[];
			const m = await write(ctx, space, [
				{ op: "move", block: { id: a as string }, parent: { id: c as string } },
			]);
			expect(m.commit?.seq).toBe(2);
			expect([...m.pageIds].sort()).toEqual([p1, p2].sort());
			const flags = async (id: string) =>
				(await ctx.store.listBlockVersions(id, 10)).map((v) => [
					v.fromSeq,
					v.changeFlags,
					v.pageId,
				]);
			expect(await flags(a as string)).toEqual([
				[1, OUTLINE_CHANGE.CREATE, p1],
				[2, OUTLINE_CHANGE.MOVE | OUTLINE_CHANGE.PAGE, p2],
			]);
			for (const id of [a1, a11] as string[]) {
				expect(await flags(id)).toEqual([
					[1, OUTLINE_CHANGE.CREATE, p1],
					[2, OUTLINE_CHANGE.PAGE, p2],
				]);
			}
			expect((await ctx.store.listPageBlocks(p1 as string, 10)).blocks.map((b) => b.id)).toEqual([
				p1,
			]);
			expect((await ctx.store.listPageBlocks(p2 as string, 10)).blocks).toHaveLength(5);
			expect(
				(await ctx.store.listPageVersions(p2 as string, { limit: 10, afterSeq: 1 })).map(
					(v) => v.blockId,
				),
			).toEqual([a, a1, a11].sort());

			// Making a block a page re-pages its subtree under its own id.
			await write(ctx, space, [{ op: "move", block: { id: a1 as string }, parent: null }]);
			expect((await ctx.store.getBlock(a1 as string))?.pageId).toBe(a1);
			expect((await ctx.store.getBlock(a11 as string))?.pageId).toBe(a1);
			expect((await flags(a11 as string)).at(-1)).toEqual([3, OUTLINE_CHANGE.PAGE, a1]);

			// Within one page, only the moved block gets a version.
			await write(ctx, space, [{ op: "insert", parent: { id: a as string }, content: "A child" }]);
			const before = (await ctx.dump(space.id)).versions.length;
			const same = await write(ctx, space, [
				{
					op: "move",
					block: { id: a as string },
					parent: { id: p2 as string },
					position: { first: true },
				},
			]);
			expect((await ctx.dump(space.id)).versions.length).toBe(before + 1);
			expect(same.pageIds).toEqual([p2]);
			expect(contents(await ctx.store.listChildren(space.id, p2 as string, 10))).toEqual([
				"A",
				"C",
			]);
			// Moving to where it already is changes nothing.
			const noop = await write(ctx, space, [
				{
					op: "move",
					block: { id: a as string },
					parent: { id: p2 as string },
					position: { before: { id: c as string } },
				},
			]);
			expect(noop.commit).toBeNull();
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "move: under itself or a descendant is a cycle and is rejected",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "a", parent: { tempId: "p" }, content: "A" },
				{ op: "insert", tempId: "a1", parent: { tempId: "a" }, content: "A1" },
				{ op: "insert", tempId: "a11", parent: { tempId: "a1" }, content: "A11" },
			]);
			const [p, a, , a11] = r.results.map((x) => x.blockId) as string[];
			const seq = await nextSeq(ctx, space);
			await rejects(
				write(ctx, space, [
					{ op: "move", block: { id: a as string }, parent: { id: a11 as string } },
				]),
				"OUTLINE_CYCLE",
			);
			await rejects(
				write(ctx, space, [
					{ op: "move", block: { id: a as string }, parent: { id: a as string } },
				]),
				"OUTLINE_CYCLE",
			);
			// A page cannot go under its own blocks either.
			await rejects(
				write(ctx, space, [
					{ op: "move", block: { id: p as string }, parent: { id: a11 as string } },
				]),
				"OUTLINE_CYCLE",
			);
			// Earlier operations of the same transaction count: once A11 has left, A may go under it.
			const ok = await write(ctx, space, [
				{ op: "move", block: { id: a11 as string }, parent: { id: p as string } },
				{ op: "move", block: { id: a as string }, parent: { id: a11 as string } },
			]);
			expect(ok.commit?.seq).toBe(seq);
			expect((await ctx.store.getBlock(a as string))?.parentId).toBe(a11);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "aliases: unique among the live blocks of a space; can move within a transaction",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "x", parent: { tempId: "p" }, content: "X", alias: "S1" },
				{ op: "insert", tempId: "y", parent: { tempId: "p" }, content: "Y", alias: "S2" },
			]);
			const [p, x, y] = r.results.map((res) => res.blockId) as string[];
			await rejects(
				write(ctx, space, [
					{ op: "insert", parent: { id: p as string }, content: "Z", alias: "S1" },
				]),
				"OUTLINE_ALIAS_TAKEN",
			);
			await rejects(
				write(ctx, space, [{ op: "update", block: { id: y as string }, alias: "S1" }]),
				"OUTLINE_ALIAS_TAKEN",
			);
			// Another space has its own aliases.
			await write(ctx, other, [{ op: "insert", parent: null, content: "elsewhere", alias: "S1" }]);
			// A swap through a third name in one transaction.
			const swap = await write(ctx, space, [
				{ op: "update", block: { id: y as string }, alias: "S3" },
				{ op: "update", block: { id: x as string }, alias: "S2" },
				{ op: "update", block: { id: y as string }, alias: "S1" },
			]);
			expect(swap.commit?.seq).toBe(2);
			expect((await ctx.store.getBlock(x as string))?.alias).toBe("S2");
			expect((await ctx.store.getBlock(y as string))?.alias).toBe("S1");
			expect((await ctx.store.listBlockVersions(x as string, 10)).at(-1)?.changeFlags).toBe(
				OUTLINE_CHANGE.PROPS,
			);
			// Removing an alias frees it.
			await write(ctx, space, [{ op: "update", block: { id: x as string }, alias: null }]);
			await write(ctx, space, [
				{ op: "insert", parent: { id: p as string }, content: "W", alias: "S2" },
			]);
			await rejects(
				write(ctx, space, [{ op: "insert", parent: null, content: "bad", alias: "not an alias" }]),
				"OUTLINE_INVALID_OP",
			);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "conflicts: a stale baseVersionSeq rejects the whole transaction and lists the blocks",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", parent: { tempId: "p" }, content: "A" },
				{ op: "insert", parent: { tempId: "p" }, content: "B" },
			]);
			const [, a, b] = r.results as OutlineWriteResult["results"];
			if (!a || !b) throw new Error("missing results");
			await write(ctx, space, [{ op: "update", block: { id: a.blockId }, content: "A2" }]);
			const seq = await nextSeq(ctx, space);
			let caught: unknown;
			try {
				await write(ctx, space, [
					{ op: "update", block: { id: b.blockId }, content: "B2", baseVersionSeq: 1 },
					{ op: "update", block: { id: a.blockId }, content: "A3", baseVersionSeq: 1 },
					{ op: "delete", block: { sid: a.sid }, baseVersionSeq: 1 },
				]);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(OutlineConflictError);
			expect((caught as OutlineConflictError).conflicts).toEqual([
				{ opIndex: 1, blockId: a.blockId, sid: a.sid, expectedVersionSeq: 1, actualVersionSeq: 2 },
				{ opIndex: 2, blockId: a.blockId, sid: a.sid, expectedVersionSeq: 1, actualVersionSeq: 2 },
			]);
			expect((caught as OutlineConflictError).statusCode).toBe(409);
			expect(await nextSeq(ctx, space)).toBe(seq);
			expect((await ctx.store.getBlock(b.blockId))?.content).toBe("B");
			const ok = await write(ctx, space, [
				{ op: "update", block: { id: a.blockId }, content: "A3", baseVersionSeq: 2 },
				{ op: "update", block: { id: b.blockId }, content: "B2", baseVersionSeq: 1 },
			]);
			expect(ok.commit?.seq).toBe(seq);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "references: other spaces, unknown temp ids and foreign anchors are rejected",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const other = await personalSpace(ctx);
			const elsewhere = await write(ctx, other, [{ op: "insert", parent: null, content: "x" }]);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "q", parent: null, content: "page two" },
				{ op: "insert", parent: { tempId: "q" }, content: "under q" },
			]);
			const [p, , underQ] = r.results.map((x) => x.blockId) as string[];
			const foreign = elsewhere.results[0]?.blockId as string;
			await rejects(
				write(ctx, space, [{ op: "update", block: { id: foreign }, content: "y" }]),
				"OUTLINE_BLOCK_NOT_FOUND",
			);
			await rejects(
				write(ctx, space, [{ op: "insert", parent: { id: foreign }, content: "y" }]),
				"OUTLINE_BLOCK_NOT_FOUND",
			);
			await rejects(
				write(ctx, space, [{ op: "insert", parent: { tempId: "nope" }, content: "y" }]),
				"OUTLINE_INVALID_OP",
			);
			await rejects(
				write(ctx, space, [
					{
						op: "insert",
						parent: { id: p as string },
						position: { after: { id: underQ as string } },
						content: "y",
					},
				]),
				"OUTLINE_INVALID_OP",
			);
			await rejects(
				write(ctx, space, [{ op: "update", block: { sid: "unknown1" }, content: "y" }]),
				"OUTLINE_BLOCK_NOT_FOUND",
			);
			// Caller-chosen ids are kept, and refused once taken.
			const chosen = `client-${generateId(10)}`;
			const c = await write(ctx, space, [
				{ op: "insert", id: chosen, parent: { id: p as string }, content: "chosen" },
			]);
			expect(c.results[0]?.blockId).toBe(chosen);
			await rejects(
				write(ctx, other, [{ op: "insert", id: chosen, parent: null, content: "again" }]),
				"OUTLINE_ID_TAKEN",
			);
			await rejects(write(ctx, space, []), "OUTLINE_INVALID_OP");
			await expect(
				writeOutline(
					{
						spaceId: "missing",
						ops: [{ op: "insert", parent: null, content: "x" }],
						actor: ACTOR,
						responsibleUserId: null,
					},
					{ store: ctx.store },
				),
			).rejects.toMatchObject({ statusCode: 404 });
		},
	},
	{
		name: "limits: operations, body size, transaction size, rows and links",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const seq = await nextSeq(ctx, space);
			const tooMany: OutlineOp[] = Array.from({ length: OUTLINE_LIMITS.maxOps + 1 }, () => ({
				op: "insert",
				parent: null,
				content: "x",
			}));
			await rejects(write(ctx, space, tooMany), "OUTLINE_TOO_MANY_OPS");
			await rejects(
				write(ctx, space, [
					{ op: "insert", parent: null, content: "x".repeat(OUTLINE_LIMITS.maxBodyBytes + 1) },
				]),
				"OUTLINE_BODY_TOO_LARGE",
			);
			// Bytes, not characters: 6000 CJK characters are 18,000 bytes.
			await rejects(
				write(ctx, space, [{ op: "insert", parent: null, content: "字".repeat(6000) }]),
				"OUTLINE_BODY_TOO_LARGE",
			);
			const chunk = "y".repeat(15 * 1024);
			await rejects(
				write(
					ctx,
					space,
					Array.from({ length: 9 }, () => ({
						op: "insert" as const,
						parent: null,
						content: chunk,
					})),
				),
				"OUTLINE_TRANSACTION_TOO_LARGE",
			);
			const manyLinks = Array.from(
				{ length: OUTLINE_LIMITS.maxLinksPerBlock + 1 },
				(_, i) => `[[t${i}]]`,
			).join(" ");
			await rejects(
				write(ctx, space, [{ op: "insert", parent: null, content: manyLinks }]),
				"OUTLINE_TOO_MANY_LINKS",
			);
			await rejects(
				write(ctx, space, [
					{
						op: "insert",
						parent: null,
						content: "tags",
						tags: Array.from({ length: OUTLINE_LIMITS.maxTagsPerBlock + 1 }, (_, i) => `T${i}`),
					},
				]),
				"OUTLINE_INVALID_OP",
			);
			expect(await nextSeq(ctx, space)).toBe(seq);

			// A page with maxRowsTouched - 1 children can be deleted in one commit (one tombstone
			// each, plus the page); one more child and the subtree is refused, not written.
			const page = (await write(ctx, space, [{ op: "insert", parent: null, content: "big" }]))
				.results[0]?.blockId as string;
			const target = await write(ctx, space, [{ op: "insert", parent: null, content: "dest" }]);
			const dest = target.results[0]?.blockId as string;
			let made = 0;
			const fill = async (n: number) => {
				while (made < n) {
					const batch = Math.min(OUTLINE_LIMITS.maxOps, n - made);
					await write(
						ctx,
						space,
						Array.from({ length: batch }, (_, i) => ({
							op: "insert" as const,
							parent: { id: page },
							content: `c${made + i}`,
						})),
					);
					made += batch;
				}
			};
			await fill(OUTLINE_LIMITS.maxRowsTouched);
			const before = await nextSeq(ctx, space);
			await rejects(
				write(ctx, space, [{ op: "delete", block: { id: page } }]),
				"OUTLINE_TOO_MANY_ROWS",
			);
			await rejects(
				write(ctx, space, [{ op: "move", block: { id: page }, parent: { id: dest } }]),
				"OUTLINE_TOO_MANY_ROWS",
			);
			expect(await nextSeq(ctx, space)).toBe(before);
			const children = await ctx.store.listChildren(space.id, page, 10);
			await write(ctx, space, [{ op: "delete", block: { id: children[0]?.id as string } }]);
			const deleted = await write(ctx, space, [{ op: "delete", block: { id: page } }]);
			expect(deleted.commit).not.toBeNull();
			expect((await ctx.store.listPageBlocks(page, 10)).blocks).toEqual([]);
		},
	},
	{
		name: "tasks and tags: stored on the block and as depends / tag links",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: "page" },
				{ op: "insert", tempId: "s", parent: { tempId: "p" }, content: "step one" },
			]);
			const step = r.results[1] as OutlineWriteResult["results"][number];
			const t = await write(ctx, space, [
				{
					op: "insert",
					parent: { id: r.results[0]?.blockId as string },
					content: "do it",
					task: {
						status: "todo",
						assignee: "agent:worker",
						depends: [
							{ target: step.address, label: null },
							{ target: "Step two", label: "the second" },
						],
						due: "2026-11-01",
					},
					tags: ["Design", step.address, "Design"],
				},
			]);
			const task = t.results[0] as OutlineWriteResult["results"][number];
			expect((await ctx.store.getBlock(task.blockId))?.taskJson).toEqual({
				status: "todo",
				assignee: "agent:worker",
				depends: [
					{ target: step.address, label: null },
					{ target: "Step two", label: "the second" },
				],
				due: "2026-11-01",
				// The writer made it a task: they manage it.
				manager: { kind: "human", id: ACTOR.id },
			});
			const open = async () =>
				(await ctx.store.listOpenLinks([task.blockId], 100))
					.map((l) => `${l.kind} ${l.targetKind} ${l.targetRef}`)
					.sort();
			expect(await open()).toEqual(
				[
					`depends block ${step.address}`,
					"depends text Step two",
					`tag block ${step.address}`,
					"tag text Design",
				].sort(),
			);

			const done = await write(ctx, space, [
				{ op: "setTask", block: { id: task.blockId }, task: { status: "done" } },
			]);
			expect((await ctx.store.getBlock(task.blockId))?.taskJson).toMatchObject({
				status: "done",
				assignee: "agent:worker",
				due: "2026-11-01",
			});
			expect((await ctx.store.listBlockVersions(task.blockId, 10)).at(-1)?.changeFlags).toBe(
				OUTLINE_CHANGE.TASK,
			);
			const afterDone = (await ctx.dump(space.id)).links.filter(
				(l) => l.fromBlockId === task.blockId,
			);
			expect(afterDone.every((l) => l.toSeq === null && l.fromSeq === t.commit?.seq)).toBe(true);
			expect(done.commit).not.toBeNull();

			await write(ctx, space, [
				{ op: "setTask", block: { id: task.blockId }, task: { depends: null, assignee: null } },
			]);
			expect(await open()).toEqual([`tag block ${step.address}`, "tag text Design"].sort());
			const untagged = await write(ctx, space, [
				{ op: "update", block: { id: task.blockId }, tags: ["Design"] },
			]);
			expect(await open()).toEqual(["tag text Design"]);
			expect((await ctx.store.listBlockVersions(task.blockId, 10)).at(-1)?.changeFlags).toBe(
				OUTLINE_CHANGE.PROPS,
			);
			expect(untagged.commit).not.toBeNull();
			// The same tags again: nothing to write.
			const same = await write(ctx, space, [
				{ op: "update", block: { id: task.blockId }, tags: ["Design"] },
			]);
			expect(same.commit).toBeNull();
			await write(ctx, space, [{ op: "setTask", block: { id: task.blockId }, task: null }]);
			expect((await ctx.store.getBlock(task.blockId))?.taskJson).toBeNull();
			await rejects(
				write(ctx, space, [
					{ op: "setTask", block: { id: step.blockId }, task: { assignee: "agent:x" } },
				]),
				"OUTLINE_INVALID_OP",
			);
			await rejects(
				write(ctx, space, [
					{ op: "setTask", block: { id: step.blockId }, task: { status: "todo", due: "soon" } },
				]),
				"OUTLINE_INVALID_OP",
			);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "concurrency: a plan made before another commit is refused and re-planned",
		async run(ctx) {
			const space = await personalSpace(ctx);
			await write(ctx, space, [{ op: "insert", parent: null, content: "first" }]);
			// A plan for a seq the space has already passed writes nothing.
			const stale: OutlineCommitPlan = {
				spaceId: space.id,
				seq: 1,
				commit: {
					id: generateId(),
					spaceId: space.id,
					seq: 1,
					kind: "edit",
					actorKind: "human",
					actorId: "x",
					responsibleUserId: null,
					narratorId: null,
					messageId: null,
					toolCallId: null,
					createdAt: NOW,
					summary: "stale",
				},
				closeVersionIds: [],
				patchBlocks: [],
				insertBlocks: [],
				versions: [],
				closeLinkIds: [],
				insertLinks: [],
				inProcess: [],
				inProcessStale: false,
				inProcessEpoch: 0,
				claims: { put: [], release: [], expire: [], verify: [] },
			};
			await expect(ctx.store.applyCommit(stale)).rejects.toBeInstanceOf(OutlineStaleWriteError);
			expect(await ctx.store.listCommits(space.id, { limit: 10 })).toHaveLength(1);

			// Another commit lands between planning and writing: the write plans again.
			let interfered = false;
			const interfering: OutlineStore = {
				...ctx.store,
				async applyCommit(plan) {
					if (!interfered) {
						interfered = true;
						await write(ctx, space, [{ op: "insert", parent: null, content: "sneaky" }]);
					}
					return ctx.store.applyCommit(plan);
				},
			};
			const r = await writeOutline(
				{
					spaceId: space.id,
					ops: [{ op: "insert", parent: null, content: "patient" }],
					actor: ACTOR,
					responsibleUserId: null,
				},
				{ store: interfering },
			);
			expect(r.commit?.seq).toBe(3);
			expect(contents(await ctx.store.listChildren(space.id, null, 10))).toEqual([
				"first",
				"sneaky",
				"patient",
			]);

			// Writers racing on one space all land, with contiguous seqs.
			const racers = await Promise.all(
				Array.from({ length: 4 }, (_, i) =>
					write(ctx, space, [{ op: "insert", parent: null, content: `racer ${i}` }]),
				),
			);
			expect(racers.map((x) => x.commit?.seq).sort()).toEqual([4, 5, 6, 7]);
			checkSpaceInvariants(await ctx.dump(space.id));
		},
	},
	{
		name: "full-text index: written content is findable, edits re-index it",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const tag = generateId(8).replace(/[^A-Za-z0-9]/g, "q");
			const r = await write(ctx, space, [
				{ op: "insert", tempId: "p", parent: null, content: `zebra orchid ${tag}` },
				{ op: "insert", parent: null, content: "unrelated" },
			]);
			const id = r.results[0]?.blockId as string;
			expect(await ctx.searchContent(`orchid ${tag}`)).toEqual([id]);
			await write(ctx, space, [{ op: "update", block: { id }, content: `walrus lily ${tag}` }]);
			expect(await ctx.searchContent(`orchid ${tag}`)).toEqual([]);
			expect(await ctx.searchContent(`lily ${tag}`)).toEqual([id]);
			await write(ctx, space, [
				{ op: "move", block: { id }, parent: { id: r.results[1]?.blockId as string } },
			]);
			expect(await ctx.searchContent(`lily ${tag}`)).toEqual([id]);
		},
	},
	{
		name: "live update log: append, page through, compact, list epochs, delete",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", parent: null, content: "live page one" },
				{ op: "insert", parent: null, content: "live page two" },
			]);
			const [one, two] = r.results.map((x) => x.blockId) as [string, string];
			const row = (page: string, epoch: number, seq: number) => ({
				pageBlockId: page,
				epoch,
				seq,
				updateB64: Buffer.from(`update ${page} ${epoch} ${seq}`).toString("base64"),
				actorKind: "human" as const,
				actorId: "user-contract",
				createdAt: NOW,
			});
			// More rows than one insert statement takes, in one call.
			await ctx.store.appendLiveUpdates(Array.from({ length: 130 }, (_, i) => row(one, 7, i + 1)));
			await ctx.store.appendLiveUpdates([row(one, 9, 1), row(two, 3, 1), row(two, 3, 2)]);
			const first = await ctx.store.listLiveUpdates(one, 7, { limit: 50 });
			expect(first.map((x) => x.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
			expect(first[0]).toEqual(row(one, 7, 1));
			const rest = await ctx.store.listLiveUpdates(one, 7, { afterSeq: 50, limit: 500 });
			expect(rest.map((x) => x.seq)).toEqual(Array.from({ length: 80 }, (_, i) => i + 51));
			// A seq is written once.
			await expect(ctx.store.appendLiveUpdates([row(one, 7, 3)])).rejects.toThrow();
			expect((await ctx.store.listLiveUpdates(one, 7, { limit: 500 })).length).toBe(130);

			// Compaction replaces an epoch's rows at once and leaves the others.
			await ctx.store.replaceLiveUpdates(one, 7, [row(one, 7, 1), row(one, 7, 131)]);
			expect((await ctx.store.listLiveUpdates(one, 7, { limit: 500 })).map((x) => x.seq)).toEqual([
				1, 131,
			]);
			expect((await ctx.store.listLiveUpdates(one, 9, { limit: 500 })).length).toBe(1);

			// Epochs in page then epoch order, paged by the last one seen.
			const ours = (list: Array<{ pageBlockId: string; epoch: number }>) =>
				list.filter((e) => e.pageBlockId === one || e.pageBlockId === two);
			const all = ours(await ctx.store.listLiveEpochs({ limit: 10_000 }));
			const expected = [
				{ pageBlockId: one, epoch: 7 },
				{ pageBlockId: one, epoch: 9 },
				{ pageBlockId: two, epoch: 3 },
			].sort((a, b) =>
				a.pageBlockId === b.pageBlockId
					? a.epoch - b.epoch
					: a.pageBlockId < b.pageBlockId
						? -1
						: 1,
			);
			expect(all).toEqual(expected);
			const firstEpoch = expected[0] as { pageBlockId: string; epoch: number };
			const after = ours(await ctx.store.listLiveEpochs({ after: firstEpoch, limit: 10_000 }));
			expect(after).toEqual(expected.slice(1));
			expect(await ctx.store.listLiveEpochs({ after: firstEpoch, limit: 1 })).toHaveLength(1);

			// Deleting an epoch removes only its rows; a deleted page's rows go with it.
			expect(await ctx.store.deleteLiveUpdates(one, 7)).toBe(2);
			expect(await ctx.store.deleteLiveUpdates(one, 7)).toBe(0);
			expect(ours(await ctx.store.listLiveEpochs({ limit: 10_000 }))).toEqual(
				expected.filter((e) => !(e.pageBlockId === one && e.epoch === 7)),
			);
			expect(await ctx.store.deleteLiveUpdates(one, 9)).toBe(1);
			expect(await ctx.store.deleteLiveUpdates(two, 3)).toBe(2);
			expect(ours(await ctx.store.listLiveEpochs({ limit: 10_000 }))).toEqual([]);
		},
	},
	{
		name: "view state: one row per person and page, replaced by a write, gone with the page",
		async run(ctx) {
			const space = await personalSpace(ctx);
			const r = await write(ctx, space, [
				{ op: "insert", parent: null, content: "view page one" },
				{ op: "insert", parent: null, content: "view page two" },
			]);
			const [one, two] = r.results.map((x) => x.blockId) as [string, string];
			const me = await ctx.seedUser();
			const other = await ctx.seedUser();
			expect(await ctx.store.getViewState(me, one)).toBeNull();
			const row = {
				userId: me,
				pageBlockId: one,
				collapsed: ["a", "b", "长 id"],
				layout: "down" as const,
				updatedAt: NOW,
			};
			await ctx.store.putViewState(row, 500);
			expect(await ctx.store.getViewState(me, one)).toEqual(row);
			// Replaced, not merged.
			const later = {
				...row,
				collapsed: ["c"],
				layout: "right" as const,
				updatedAt: "2026-10-27T00:00:00.000Z",
			};
			await ctx.store.putViewState(later, 500);
			expect(await ctx.store.getViewState(me, one)).toEqual(later);
			// Per person and per page.
			expect(await ctx.store.getViewState(other, one)).toBeNull();
			expect(await ctx.store.getViewState(me, two)).toBeNull();
			await ctx.store.putViewState({ ...row, userId: other, collapsed: [] }, 500);
			expect((await ctx.store.getViewState(other, one))?.collapsed).toEqual([]);
			expect((await ctx.store.getViewState(me, one))?.collapsed).toEqual(["c"]);
			// A large list round-trips.
			const many = Array.from({ length: 2000 }, (_, i) => `block-${i}`);
			await ctx.store.putViewState({ ...row, pageBlockId: two, collapsed: many }, 500);
			expect((await ctx.store.getViewState(me, two))?.collapsed).toEqual(many);
			// At most `keepPerUser` pages per person: a write drops their least recently written
			// pages, never another person's.
			const more = await write(ctx, space, [
				{ op: "insert", parent: null, content: "view page three" },
				{ op: "insert", parent: null, content: "view page four" },
			]);
			const [three, four] = more.results.map((x) => x.blockId) as [string, string];
			const at = (n: number) => `2026-10-28T00:00:0${n}.000Z`;
			await ctx.store.putViewState({ ...row, pageBlockId: one, updatedAt: at(1) }, 3);
			await ctx.store.putViewState({ ...row, pageBlockId: two, updatedAt: at(2) }, 3);
			await ctx.store.putViewState({ ...row, pageBlockId: three, updatedAt: at(3) }, 3);
			expect(await ctx.store.getViewState(me, one)).not.toBeNull();
			await ctx.store.putViewState({ ...row, pageBlockId: four, updatedAt: at(4) }, 3);
			expect(await ctx.store.getViewState(me, one)).toBeNull();
			for (const p of [two, three, four])
				expect(await ctx.store.getViewState(me, p)).not.toBeNull();
			// Rewriting an old page makes it the newest: the next oldest goes.
			await ctx.store.putViewState({ ...row, pageBlockId: two, updatedAt: at(5) }, 2);
			expect(await ctx.store.getViewState(me, three)).toBeNull();
			expect(await ctx.store.getViewState(me, two)).not.toBeNull();
			expect(await ctx.store.getViewState(me, four)).not.toBeNull();
			expect(await ctx.store.getViewState(other, one)).not.toBeNull();
			// A clock that stepped back: the page just written is never the one dropped.
			await ctx.store.putViewState(
				{ ...row, pageBlockId: one, updatedAt: "2026-10-27T23:00:00.000Z" },
				2,
			);
			expect(await ctx.store.getViewState(me, one)).not.toBeNull();
			expect(await ctx.store.getViewState(me, two)).not.toBeNull();
			expect(await ctx.store.getViewState(me, four)).not.toBeNull();
		},
	},
	{
		name: "randomized: every seq's tree rebuilt from versions equals the model",
		async run(ctx) {
			for (const seed of [1, 2, 3]) await randomizedHistory(ctx, seed);
		},
	},
];
