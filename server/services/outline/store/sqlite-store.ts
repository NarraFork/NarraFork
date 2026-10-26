/**
 * SQLite implementation of `OutlineStore`.
 *
 * `applyCommit` is one STRICTLY SYNCHRONOUS `db.transaction` callback: `bun:sqlite` commits when
 * the callback returns, so an `await` inside would commit early and leave the rest in autocommit
 * (see `server/db/transaction-atomicity-contract.test.ts`). The plan arrives fully decided, so
 * the section only claims the seq and writes rows, in the order `OutlineCommitPlan` documents.
 * It runs under `withDbRetry` for transient lock contention, like the other SQLite write stores.
 *
 * Reads are single indexed statements with explicit limits; the methods are `async` only so the
 * caller cannot tell this store from the PostgreSQL one.
 *
 * Uniqueness violations are recognized structurally (the driver's extended result code on
 * `errno`) and cross the port as `WriteConflictError`.
 */
import { WriteConflictError } from "@server/db/backend/write-port";
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "../../../db";
import {
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
	outlineSpaces,
} from "../../../db/schema";
import { withDbRetry } from "../../../lib/db-resilience";
import { generateId } from "../../../lib/id";
import { newOutlineKey } from "../keys";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineSpaceKind,
} from "../model";
import {
	chunked,
	type OutlineBlockMeta,
	type OutlineBlockRow,
	type OutlineCommitPlan,
	type OutlineCommitRow,
	type OutlineLinkRow,
	type OutlineSpaceRow,
	type OutlineSpaceScope,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineVersionRow,
} from "./port";
import { sqliteOutlineReads } from "./sqlite-read";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Extended result codes for a uniqueness conflict (primary key, unique index). */
const CONSTRAINT_PRIMARYKEY_ERRNO = 1555;
const CONSTRAINT_UNIQUE_ERRNO = 2067;
const MAX_CAUSE_DEPTH = 8;
/** Rows per multi-row INSERT: 14 columns each stays far below the bound-parameter limit. */
const INSERT_CHUNK = 100;
/** Attempts to find an unused space key before giving up (keys are random; one is enough). */
const SPACE_KEY_ATTEMPTS = 4;

function isUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return false;
		const errno = (current as Record<string, unknown>).errno;
		if (errno === CONSTRAINT_PRIMARYKEY_ERRNO || errno === CONSTRAINT_UNIQUE_ERRNO) return true;
		current = (current as Record<string, unknown>).cause;
	}
	return false;
}

function rethrowAsPortError(error: unknown): never {
	if (isUniqueViolation(error)) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WriteConflictError("outline write conflicts with an existing row", {
			constraint: /UNIQUE constraint failed: (.+)/i.exec(message)?.[1]?.trim() ?? null,
			cause: error,
		});
	}
	throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────

type SpaceSelect = typeof outlineSpaces.$inferSelect;
type BlockSelect = typeof outlineBlocks.$inferSelect;
type VersionSelect = typeof outlineBlockVersions.$inferSelect;
type LinkSelect = typeof outlineLinks.$inferSelect;
type CommitSelect = typeof outlineCommits.$inferSelect;

function toSpace(row: SpaceSelect): OutlineSpaceRow {
	return { ...row, kind: row.kind as OutlineSpaceKind };
}

function toBlock(row: BlockSelect): OutlineBlockRow {
	return {
		...row,
		taskJson: row.taskJson ?? null,
		authorKind: row.authorKind as OutlineActorKind,
	};
}

function toVersion(row: VersionSelect): OutlineVersionRow {
	return { ...row, taskJson: row.taskJson ?? null };
}

function toLink(row: LinkSelect): OutlineLinkRow {
	return { ...row, kind: row.kind as OutlineLinkKind };
}

function toCommit(row: CommitSelect): OutlineCommitRow {
	return {
		...row,
		kind: row.kind as OutlineCommitKind,
		actorKind: row.actorKind as OutlineActorKind,
	};
}

const metaColumns = {
	id: outlineBlocks.id,
	spaceId: outlineBlocks.spaceId,
	sid: outlineBlocks.sid,
	parentId: outlineBlocks.parentId,
	pageId: outlineBlocks.pageId,
	orderKey: outlineBlocks.orderKey,
	contentHash: outlineBlocks.contentHash,
	alias: outlineBlocks.alias,
	taskJson: outlineBlocks.taskJson,
	versionSeq: outlineBlocks.versionSeq,
	deleted: outlineBlocks.deleted,
};

function toMeta(row: {
	id: string;
	spaceId: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	contentHash: string;
	alias: string | null;
	taskJson: BlockSelect["taskJson"];
	versionSeq: number;
	deleted: boolean;
}): OutlineBlockMeta {
	return { ...row, taskJson: row.taskJson ?? null };
}

function scopeCondition(scope: OutlineSpaceScope): SQL | undefined {
	switch (scope.kind) {
		case "project":
			return and(eq(outlineSpaces.kind, "project"), eq(outlineSpaces.projectId, scope.projectId));
		case "personal":
			return and(
				eq(outlineSpaces.kind, "personal"),
				eq(outlineSpaces.ownerUserId, scope.ownerUserId),
			);
		case "session":
			return and(eq(outlineSpaces.kind, "session"), eq(outlineSpaces.narratorId, scope.narratorId));
	}
}

function findSpaceIn(tx: Tx, scope: OutlineSpaceScope): OutlineSpaceRow | null {
	const row = tx.select().from(outlineSpaces).where(scopeCondition(scope)).limit(1).get();
	return row ? toSpace(row) : null;
}

function idList(ids: readonly string[]): SQL {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The atomic section
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole commit. Returns false, having written nothing, when the space counter is no longer
 * at the plan's seq; returning (rather than throwing) keeps an expected outcome out of the retry
 * wrapper's error log.
 */
function applyCommitSection(tx: Tx, plan: OutlineCommitPlan): boolean {
	const { seq } = plan;
	const claimed = tx
		.update(outlineSpaces)
		.set({ nextSeq: sql`${outlineSpaces.nextSeq} + 1` })
		.where(and(eq(outlineSpaces.id, plan.spaceId), eq(outlineSpaces.nextSeq, seq)))
		.returning({ nextSeq: outlineSpaces.nextSeq })
		.get();
	if (!claimed) return false;

	tx.insert(outlineCommits).values(plan.commit).run();

	let closed = 0;
	for (const ids of chunked(plan.closeVersionIds)) {
		closed += tx
			.update(outlineBlockVersions)
			.set({ toSeq: seq })
			.where(and(inArray(outlineBlockVersions.blockId, ids), isNull(outlineBlockVersions.toSeq)))
			.returning({ blockId: outlineBlockVersions.blockId })
			.all().length;
	}
	if (closed !== plan.closeVersionIds.length) {
		throw new Error(
			`outline history out of step: closed ${closed} of ${plan.closeVersionIds.length} open versions`,
		);
	}

	const realiased = plan.patchBlocks.filter((group) => group.patch.alias !== undefined);
	for (const group of realiased) {
		for (const ids of chunked(group.ids)) {
			tx.update(outlineBlocks).set({ alias: null }).where(inArray(outlineBlocks.id, ids)).run();
		}
	}
	const patches = [...plan.patchBlocks].sort(
		(a, b) => Number(b.patch.deleted === true) - Number(a.patch.deleted === true),
	);
	for (const group of patches) {
		for (const ids of chunked(group.ids)) {
			tx.update(outlineBlocks)
				.set({ ...group.patch, versionSeq: seq })
				.where(inArray(outlineBlocks.id, ids))
				.run();
		}
	}

	for (const rows of chunked(plan.insertBlocks, INSERT_CHUNK)) {
		tx.insert(outlineBlocks).values(rows).run();
	}

	for (const group of plan.versions) {
		for (const ids of chunked(group.ids)) {
			tx.run(sql`
				INSERT INTO outline_block_versions (
					block_id, from_seq, to_seq, commit_id, page_id, parent_id, order_key, content,
					task_json, alias, content_hash, change_flags, deleted
				)
				SELECT id, ${seq}, NULL, ${plan.commit.id}, page_id, parent_id, order_key,
					CASE WHEN deleted = 1 THEN NULL ELSE content END,
					task_json, alias, content_hash, ${group.flags}, deleted
				FROM outline_blocks WHERE id IN (${idList(ids)})
			`);
		}
	}

	for (const ids of chunked(plan.closeLinkIds)) {
		tx.update(outlineLinks)
			.set({ toSeq: seq })
			.where(and(inArray(outlineLinks.id, ids), isNull(outlineLinks.toSeq)))
			.run();
	}
	for (const rows of chunked(plan.insertLinks, INSERT_CHUNK)) {
		tx.insert(outlineLinks).values(rows).run();
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export const sqliteOutlineStore: OutlineStore = {
	backendId: "sqlite",
	...sqliteOutlineReads,

	async ensureSpace(scope, now) {
		for (let attempt = 0; attempt < SPACE_KEY_ATTEMPTS; attempt++) {
			const row = db.transaction((tx) => {
				const existing = findSpaceIn(tx, scope);
				if (existing) return existing;
				tx.insert(outlineSpaces)
					.values({
						id: generateId(),
						key: newOutlineKey(),
						kind: scope.kind,
						projectId: scope.kind === "project" ? scope.projectId : null,
						narratorId: scope.kind === "session" ? scope.narratorId : null,
						ownerUserId: scope.kind === "personal" ? scope.ownerUserId : null,
						nextSeq: 1,
						createdAt: now,
					})
					.onConflictDoNothing()
					.run();
				// Nothing inserted means the random key was taken; try another.
				return findSpaceIn(tx, scope);
			});
			if (row) return row;
		}
		throw new Error(`could not allocate an outline space key for ${scope.kind}`);
	},

	async getSpace(id) {
		const row = db.select().from(outlineSpaces).where(eq(outlineSpaces.id, id)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async getSpaceByKey(key) {
		const row = db.select().from(outlineSpaces).where(eq(outlineSpaces.key, key)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async findSpace(scope) {
		const row = db.select().from(outlineSpaces).where(scopeCondition(scope)).limit(1).get();
		return row ? toSpace(row) : null;
	},

	async getBlockMetas(spaceId, by) {
		const out: OutlineBlockMeta[] = [];
		for (const ids of chunked(by.ids ?? [])) {
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.id, ids)))
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		for (const sids of chunked(by.sids ?? [])) {
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), inArray(outlineBlocks.sid, sids)))
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		return out;
	},

	async findExistingBlockIds(ids) {
		const out: string[] = [];
		for (const chunk of chunked(ids)) {
			const rows = db
				.select({ id: outlineBlocks.id })
				.from(outlineBlocks)
				.where(inArray(outlineBlocks.id, chunk))
				.all();
			for (const row of rows) out.push(row.id);
		}
		return out;
	},

	async listChildMetas(spaceId, parentIds, limit) {
		const out: OutlineBlockMeta[] = [];
		const ids = parentIds.filter((id): id is string => id !== null);
		const pages = parentIds.includes(null);
		const groups: Array<SQL | undefined> = chunked(ids).map((chunk) =>
			inArray(outlineBlocks.parentId, chunk),
		);
		if (pages) groups.push(isNull(outlineBlocks.parentId));
		for (const parents of groups) {
			if (out.length >= limit) break;
			const rows = db
				.select(metaColumns)
				.from(outlineBlocks)
				.where(and(eq(outlineBlocks.spaceId, spaceId), parents, eq(outlineBlocks.deleted, false)))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toMeta(row));
		}
		return out;
	},

	async findAliasOwners(spaceId, aliases) {
		const out: Array<{ alias: string; id: string }> = [];
		for (const chunk of chunked(aliases)) {
			// The literal `deleted = 0` lets the planner use the partial unique alias index.
			const rows = db
				.select({ alias: outlineBlocks.alias, id: outlineBlocks.id })
				.from(outlineBlocks)
				.where(
					and(
						eq(outlineBlocks.spaceId, spaceId),
						inArray(outlineBlocks.alias, chunk),
						sql`${outlineBlocks.deleted} = 0`,
					),
				)
				.all();
			for (const row of rows) if (row.alias !== null) out.push({ alias: row.alias, id: row.id });
		}
		return out;
	},

	async listOpenLinks(blockIds, limit) {
		const out: OutlineLinkRow[] = [];
		for (const ids of chunked(blockIds)) {
			if (out.length >= limit) break;
			const rows = db
				.select()
				.from(outlineLinks)
				.where(and(inArray(outlineLinks.fromBlockId, ids), isNull(outlineLinks.toSeq)))
				.limit(limit - out.length)
				.all();
			for (const row of rows) out.push(toLink(row));
		}
		return out;
	},

	async getBlock(id) {
		const row = db.select().from(outlineBlocks).where(eq(outlineBlocks.id, id)).limit(1).get();
		return row ? toBlock(row) : null;
	},

	async getBlockBySid(spaceId, sid) {
		const row = db
			.select()
			.from(outlineBlocks)
			.where(and(eq(outlineBlocks.spaceId, spaceId), eq(outlineBlocks.sid, sid)))
			.limit(1)
			.get();
		return row ? toBlock(row) : null;
	},

	async listChildren(spaceId, parentId, limit) {
		const rows = db
			.select()
			.from(outlineBlocks)
			.where(
				and(
					eq(outlineBlocks.spaceId, spaceId),
					parentId === null ? isNull(outlineBlocks.parentId) : eq(outlineBlocks.parentId, parentId),
					eq(outlineBlocks.deleted, false),
				),
			)
			// SQLite compares text bytewise (BINARY), which is the order-key order.
			.orderBy(asc(outlineBlocks.orderKey), asc(outlineBlocks.id))
			.limit(limit)
			.all();
		return rows.map(toBlock);
	},

	async listPageBlocks(pageId, limit) {
		const rows = db
			.select()
			.from(outlineBlocks)
			.where(and(eq(outlineBlocks.pageId, pageId), eq(outlineBlocks.deleted, false)))
			.limit(limit + 1)
			.all();
		return { blocks: rows.slice(0, limit).map(toBlock), truncated: rows.length > limit };
	},

	async listBlockVersions(blockId, limit) {
		const rows = db
			.select()
			.from(outlineBlockVersions)
			.where(eq(outlineBlockVersions.blockId, blockId))
			.orderBy(asc(outlineBlockVersions.fromSeq))
			.limit(limit)
			.all();
		return rows.map(toVersion);
	},

	async listPageVersions(pageId, options) {
		const rows = db
			.select()
			.from(outlineBlockVersions)
			.where(
				and(
					eq(outlineBlockVersions.pageId, pageId),
					options.afterSeq === undefined
						? undefined
						: gt(outlineBlockVersions.fromSeq, options.afterSeq),
				),
			)
			.orderBy(asc(outlineBlockVersions.fromSeq), asc(outlineBlockVersions.blockId))
			.limit(options.limit)
			.all();
		return rows.map(toVersion);
	},

	async listCommits(spaceId, options) {
		const rows = db
			.select()
			.from(outlineCommits)
			.where(
				and(
					eq(outlineCommits.spaceId, spaceId),
					options.afterSeq === undefined ? undefined : gt(outlineCommits.seq, options.afterSeq),
				),
			)
			.orderBy(asc(outlineCommits.seq))
			.limit(options.limit)
			.all();
		return rows.map(toCommit);
	},

	async applyCommit(plan) {
		let applied: boolean;
		try {
			applied = await withDbRetry(
				async () => db.transaction((tx) => applyCommitSection(tx, plan)),
				{ label: "outline.applyCommit", maxRetries: 3 },
			);
		} catch (error) {
			rethrowAsPortError(error);
		}
		if (!applied) throw new OutlineStaleWriteError(plan.spaceId, plan.seq);
	},
};
