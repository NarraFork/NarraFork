/**
 * What the reports (汇报, outline P2 PR 11) read and write: part of `OutlineStore`, implemented
 * per backend in `sqlite-digest.ts` and `postgres-digest.ts` and spread into each store, like the
 * read port.
 *
 * Every read has a hard row limit and is served by an index:
 *   - the spaces with commits since a time: `idx_outline_spaces_last_commit`, a page at a time;
 *   - the versions a range of commits wrote, without their content: commits by
 *     `(space_id, seq)`, then their versions by `idx_outline_versions_commit` (on SQLite on the
 *     read-worker pool: a busy day can be thousands of rows);
 *   - versions as of a seq, without content: one backward seek on the primary key per block;
 *   - reports by `(user_id, kind, period_key)` and the unread ones by `idx_outline_digests_unseen`.
 * Lists never read `items_json` or `ranges_json`; only the detail and the job do, one row at a time.
 *
 * This file imports nothing dialect-specific.
 */
import type {
	OutlineDigestCounts,
	OutlineDigestKind,
	OutlineDigestRanges,
	OutlineDigestStored,
} from "@shared/outline-digest";
import type { OutlineAskJson, OutlineTaskJson } from "../model";
import type { OutlinePendingHead, OutlineSpaceRow } from "./port";

/** A space with the time of its latest commit (`outline_spaces.last_commit_at`). */
export interface OutlineSpaceActivity extends OutlineSpaceRow {
	lastCommitAt: string;
}

/** A version a commit of a seq range wrote, without its content, with its commit's seq. */
export interface OutlineRangeChange {
	seq: number;
	commitId: string;
	blockId: string;
	pageId: string;
	parentId: string | null;
	changeFlags: number;
	deleted: boolean;
	contentHash: string;
	taskJson: OutlineTaskJson | null;
	/** The version holds a question (its `ask_json` is not read here). */
	hasAsk: boolean;
}

/** A version without its content. */
export interface OutlineVersionMeta {
	blockId: string;
	fromSeq: number;
	toSeq: number | null;
	commitId: string;
	pageId: string;
	parentId: string | null;
	contentHash: string;
	taskJson: OutlineTaskJson | null;
	askJson: OutlineAskJson | null;
	changeFlags: number;
	deleted: boolean;
}

/** One report (`outline_digests`). */
export interface OutlineDigestRow {
	id: string;
	userId: string;
	kind: OutlineDigestKind;
	periodKey: string;
	timeZone: string;
	periodStart: string;
	periodEnd: string;
	counts: OutlineDigestCounts;
	itemCount: number;
	items: OutlineDigestStored;
	ranges: OutlineDigestRanges;
	truncated: boolean;
	createdAt: string;
	seenAt: string | null;
}

/** A report without its items and ranges: what lists and the inbox read. */
export type OutlineDigestHeadRow = Omit<OutlineDigestRow, "items" | "ranges">;

/** Where a person's last report ended: what the next one continues from. */
export interface OutlineDigestCursorRow {
	id: string;
	periodKey: string;
	periodEnd: string;
	ranges: OutlineDigestRanges;
}

export interface OutlineDigestPort {
	/**
	 * Spaces whose latest commit is at or after `since` (ISO time), by that time then id, after
	 * `after` in that order, at most `limit`.
	 */
	listSpacesCommittedSince(
		since: string,
		options: { after?: { lastCommitAt: string; id: string } | null; limit: number },
	): Promise<OutlineSpaceActivity[]>;
	/**
	 * Ids of at most `limit` spaces committed to before `last_commit_at` existed (still null, with
	 * commits), by id: what is left to stamp. Empty once none are left.
	 */
	listUnstampedSpaces(limit: number): Promise<string[]>;
	/**
	 * Stamp `last_commit_at` on the given spaces from their latest commit, only where it is still
	 * null: a commit that landed since the listing wrote the right value already. Returns how many
	 * were stamped.
	 */
	stampSpaces(spaceIds: readonly string[]): Promise<number>;
	/**
	 * The versions the commits of a space with `afterSeq < seq <= toSeq` wrote, without content,
	 * by seq then block id, at most `limit`.
	 */
	listCommitRangeChanges(
		spaceId: string,
		afterSeq: number,
		toSeq: number,
		limit: number,
	): Promise<OutlineRangeChange[]>;
	/**
	 * The version of each block valid at its seq (`from_seq <= seq < to_seq`, or open), without its
	 * content, and without its `ask_json` (null) unless `withAsk`. Blocks with no version then are
	 * left out. One backward seek per key.
	 */
	listVersionMetasAt(
		keys: ReadonlyArray<{ blockId: string; seq: number }>,
		options?: { withAsk?: boolean },
	): Promise<OutlineVersionMeta[]>;
	/** Pending changes (heads) confirmed by the given commits (`uq_outline_pending_decision_commit`). */
	getPendingByDecisionCommits(commitIds: readonly string[]): Promise<OutlinePendingHead[]>;

	/** Insert a report; false, writing nothing, when the person has one for that kind and day. */
	insertDigest(row: OutlineDigestRow): Promise<boolean>;
	/**
	 * Insert a report, or replace the one the person has for that kind and day (a preview), which
	 * keeps its id: a client holding it still finds it. Returns the id of the row stored.
	 */
	replaceDigest(row: OutlineDigestRow): Promise<string>;
	getDigest(id: string): Promise<OutlineDigestRow | null>;
	/** A person's reports of a kind, latest day first, days before `before` when given. */
	listDigestHeads(
		userId: string,
		options: { kind: OutlineDigestKind; before?: string | null; limit: number },
	): Promise<OutlineDigestHeadRow[]>;
	/** A person's unread reports, latest day first, at most `limit`. */
	listUnseenDigestHeads(userId: string, limit: number): Promise<OutlineDigestHeadRow[]>;
	/** Mark the person's reports read; returns how many were unread. */
	markDigestsSeen(userId: string, ids: readonly string[], at: string): Promise<number>;
	/** The person's latest report of a kind (a day before `beforeKey` when given), or null. */
	getLatestDigestCursor(
		userId: string,
		kind: OutlineDigestKind,
		options?: { beforeKey?: string },
	): Promise<OutlineDigestCursorRow | null>;
	/**
	 * Delete a person's reports of a kind: those of days up to `atMostKey` (when given), but not
	 * `exceptId`. Returns how many went.
	 */
	deleteDigests(
		userId: string,
		kind: OutlineDigestKind,
		options: { atMostKey?: string; exceptId?: string },
	): Promise<number>;
	/** Keep only a person's `keep` latest reports of a kind; returns how many went. */
	pruneDigests(userId: string, kind: OutlineDigestKind, keep: number): Promise<number>;
}

/** Spaces one listing of active spaces returns at most. */
export const OUTLINE_DIGEST_SPACE_PAGE = 200;
