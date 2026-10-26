/**
 * Reads of history, links and the full-text index: what `read.ts`, `search.ts`, `resolve.ts`
 * and `revert.ts` build on. Part of `OutlineStore`; each backend implements them in its own
 * module (`sqlite-read.ts`, `postgres-read.ts`) and spreads them into its store.
 *
 * Every method has a hard row limit. Reads that are small and indexed run where the store's
 * other reads run. On SQLite, reads that can scan a lot (a large page's structure, the seqs
 * of a page's history, full-text search) run on the read-worker pool instead of the main
 * thread; on PostgreSQL every read is a network round trip anyway.
 *
 * This file imports nothing dialect-specific.
 */
import type { OutlineLinkKind, OutlineLinkTargetKind, OutlineTaskJson } from "../model";
import type { OutlineBlockRow, OutlineCommitRow, OutlineLinkRow, OutlineVersionRow } from "./port";

/** A live block of a page at some seq, without its content: what the tree is built from. */
export interface OutlineStructureRow {
	id: string;
	sid: string;
	parentId: string | null;
	orderKey: string;
	alias: string | null;
	taskJson: OutlineTaskJson | null;
	/** `from_seq` of the version this row comes from (the block's `version_seq` when current). */
	versionSeq: number;
}

/** One full-text query against the blocks of some spaces. */
export interface OutlineSearchQuery {
	spaceIds: readonly string[];
	/** Terms the trigram index can match (3+ characters); every one is required. */
	indexed: readonly string[];
	/** Shorter terms, required as case-insensitive substrings of the content. */
	short: readonly string[];
	limit: number;
}

/** A live block matching an {@link OutlineSearchQuery}. */
export interface OutlineSearchRow {
	id: string;
	spaceId: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	content: string;
	alias: string | null;
	taskJson: OutlineTaskJson | null;
	/**
	 * Relevance, lower is better. Comparable between calls with the same terms on one backend
	 * (the backends score differently).
	 */
	rank: number;
}

/** A link target to look up backlinks for. */
export interface OutlineLinkTargetRef {
	targetKind: OutlineLinkTargetKind;
	targetRef: string;
	/** Only links written in this space (a text target means something only in its own space). */
	spaceId?: string;
}

export interface OutlineReadPort {
	/**
	 * Live blocks of a page as of `asOf` (`null`: current state), unordered and without content.
	 * At most `limit` rows; `truncated` when the page holds more.
	 */
	listPageStructure(
		pageId: string,
		options: { asOf: number | null; limit: number },
	): Promise<{ rows: OutlineStructureRow[]; truncated: boolean }>;
	/**
	 * The version of each block valid at `seq` (`from_seq <= seq < to_seq`), or its open version
	 * when `seq` is null. Blocks with no version at `seq` (created later) are left out.
	 */
	listVersionsAt(blockIds: readonly string[], seq: number | null): Promise<OutlineVersionRow[]>;
	/**
	 * Content of versions by exact key (`block_id`, `from_seq`): one primary-key lookup each, so
	 * loading the blocks a read shows costs nothing for their older versions. Null for a
	 * tombstone.
	 */
	listVersionContents(
		keys: ReadonlyArray<{ blockId: string; fromSeq: number }>,
	): Promise<Array<{ blockId: string; fromSeq: number; content: string | null }>>;
	/** Links of the given blocks and kinds valid at `seq` (`null`: open links), at most `limit`. */
	listLinksAt(
		blockIds: readonly string[],
		seq: number | null,
		kinds: readonly OutlineLinkKind[],
		limit: number,
	): Promise<OutlineLinkRow[]>;
	/**
	 * Distinct seqs at which versions under a page opened (`edge: "from"`) or closed
	 * (`edge: "to"`), newest first, in `after < seq < before`. A closing edge only counts for a
	 * version that opened before `before`. At most `limit`.
	 */
	listPageSeqs(
		pageId: string,
		options: { edge: "from" | "to"; before: number; after: number; limit: number },
	): Promise<number[]>;
	getCommit(id: string): Promise<OutlineCommitRow | null>;
	/** Commits of a space with the given seqs, in no particular order. */
	getCommitsBySeqs(spaceId: string, seqs: readonly number[]): Promise<OutlineCommitRow[]>;
	/** Versions a commit opened, at most `limit`. */
	listCommitVersions(commitId: string, limit: number): Promise<OutlineVersionRow[]>;
	/**
	 * Which of the blocks have a version opened after `seq` whose change flags are anything but
	 * exactly `ignoreFlags` (a later page change that only followed an ancestor, say).
	 */
	findBlocksChangedAfter(
		blockIds: readonly string[],
		seq: number,
		ignoreFlags: number,
	): Promise<string[]>;
	/** Blocks by id, live or deleted, in any space. */
	getBlocks(ids: readonly string[]): Promise<OutlineBlockRow[]>;
	/** Live blocks of the given spaces with a sid or an alias, at most `limit`. */
	findLiveBlocks(
		spaceIds: readonly string[],
		by: { sid: string } | { alias: string },
		limit: number,
	): Promise<OutlineBlockRow[]>;
	/** Live blocks matching a full-text query, best first, at most `query.limit`. */
	searchBlocks(query: OutlineSearchQuery): Promise<OutlineSearchRow[]>;
	/** Open links to any of the targets, written in one of `spaceIds`, at most `limit`. */
	listLinksTo(
		targets: readonly OutlineLinkTargetRef[],
		spaceIds: readonly string[],
		limit: number,
	): Promise<OutlineLinkRow[]>;
}
