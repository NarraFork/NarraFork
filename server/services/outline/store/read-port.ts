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
import type {
	OutlineActorKind,
	OutlineLinkKind,
	OutlineLinkTargetKind,
	OutlineTaskJson,
} from "../model";
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

/** Versions of one block `findLastWrites` looks at, at most, newest first. */
export const OUTLINE_LAST_WRITES_SCAN = 64;

/** Characters of a page's content a page list reads: enough for its title. */
export const OUTLINE_PAGE_HEAD_CHARS = 400;

/** A live page of a space with the start of its content: what a list of pages shows. */
export interface OutlinePageListRow {
	id: string;
	sid: string;
	orderKey: string;
	alias: string | null;
	/** The first {@link OUTLINE_PAGE_HEAD_CHARS} characters of the content. */
	contentHead: string;
	/** The page is a task. */
	isTask: boolean;
}

/** One version of a block without its content: an entry of the block's history. */
export interface OutlineBlockHistoryRow {
	fromSeq: number;
	toSeq: number | null;
	commitId: string;
	pageId: string;
	changeFlags: number;
	deleted: boolean;
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
	/**
	 * The whole version of each block valid at its own seq (`from_seq <= seq < to_seq`, or open):
	 * the version an agent read, which its edit is merged from. Blocks with no version then are
	 * left out. Each key is one backward seek on the primary key (`block_id`, `from_seq`).
	 */
	listVersionsAtSeqs(
		keys: ReadonlyArray<{ blockId: string; seq: number }>,
	): Promise<OutlineVersionRow[]>;
	/**
	 * For each block, its latest version after `afterSeq` that counts, with its change flags.
	 * Left out: `except.actor`'s versions whose change flags lie within `except.flags` (every
	 * flag: none of the actor's versions count; a move's flags: its moves do not), and anyone's
	 * whose flags lie within `except.anyoneFlags` (default none). Blocks without one are left out.
	 * At most {@link OUTLINE_LAST_WRITES_SCAN} of a block's newest versions after `afterSeq` are
	 * looked at, backwards on the primary key and joined to their commits by id: a block with
	 * more, none of which counts, comes back with `fromSeq` null (unknown: assume the worst).
	 */
	findLastWrites(
		keys: ReadonlyArray<{ blockId: string; afterSeq: number }>,
		except: { actorKind: OutlineActorKind; actorId: string; flags: number; anyoneFlags?: number },
	): Promise<Array<{ blockId: string; fromSeq: number | null; changeFlags: number | null }>>;
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
	/**
	 * Aliases of live blocks of a space from `from` (inclusive) to `to` (exclusive) in byte order,
	 * in that order, at most `limit`: every alias made of a prefix and a digit lies in
	 * `[prefix + "0", prefix + ":")`, which is how the next number of a `Q?` alias is found.
	 */
	listAliasRange(
		spaceId: string,
		range: { from: string; to: string },
		limit: number,
	): Promise<string[]>;
	/** Live blocks matching a full-text query, best first, at most `query.limit`. */
	searchBlocks(query: OutlineSearchQuery): Promise<OutlineSearchRow[]>;
	/** Open links to any of the targets, written in one of `spaceIds`, at most `limit`. */
	listLinksTo(
		targets: readonly OutlineLinkTargetRef[],
		spaceIds: readonly string[],
		limit: number,
	): Promise<OutlineLinkRow[]>;
	/**
	 * Live pages of a space in sibling order (order key, then id, bytewise), after the page
	 * `after` names when given, at most `limit`. Reads only the head of each page's content.
	 */
	listSpacePages(
		spaceId: string,
		options: { after?: { orderKey: string; id: string } | null; limit: number },
	): Promise<OutlinePageListRow[]>;
	/** A block's versions without content, newest first, `from_seq < before`, at most `limit`. */
	listBlockHistory(
		blockId: string,
		options: { before?: number | null; limit: number },
	): Promise<OutlineBlockHistoryRow[]>;
}
