/**
 * Outline storage vocabulary shared by the write path, the store port and its two
 * implementations: change flags, actor and link kinds, and the write limits.
 *
 * THE WRITE INVARIANTS
 * --------------------
 * Every write is one commit in one space, and these hold after every commit:
 *
 *   1. Deletion is downward closed: a live block's parent is live (or it is a page). Deleting a
 *      block deletes its whole live subtree, with a tombstone version for every descendant.
 *   2. A live block's `page_id` is the id of its top-level ancestor. Moving a subtree to another
 *      page (or making it a page) writes a version with the new `page_id` for every descendant.
 *      A deleted block keeps the `page_id` it had when it was deleted; restoring recomputes it.
 *   3. Live siblings have distinct order keys.
 *   4. Every block has exactly one open version (`to_seq` NULL) and its current row equals it
 *      (a tombstone version keeps no content). A change closes the open version
 *      (`to_seq = seq`) and opens the next (`from_seq = seq`), so for every seq a block has at
 *      most one version with `from_seq <= seq < to_seq`.
 *   5. A block's open links are exactly the links its current state produces; a link closes
 *      when what produced it changes or the block is deleted.
 *   6. Aliases are unique among the live blocks of a space; `sid` is unique in the space.
 *   7. Each commit's seq comes from the space's `next_seq` counter, claimed in the same
 *      transaction as the rows it writes. Nothing writes outline rows outside a commit, so a
 *      writer that planned against an older counter value knows the space changed under it.
 */
import type { OutlineTaskActorRef, OutlineTaskJson, OutlineTaskLockJson } from "@server/db/schema";

export type { OutlineTaskActorRef, OutlineTaskJson, OutlineTaskLockJson };

/** What a version changed relative to the previous one. A bitmask: several can be set. */
export const OUTLINE_CHANGE = {
	/** The block was created. */
	CREATE: 1,
	/** Its content changed. */
	CONTENT: 2,
	/** Its parent or position among siblings changed. */
	MOVE: 4,
	/** It was deleted (a tombstone version). */
	DELETE: 8,
	/** It was restored after a deletion. */
	RESTORE: 16,
	/** Its task state (checkbox, assignee, prerequisites, due date) changed. */
	TASK: 32,
	/** Its page changed: it or an ancestor moved to another page, or it became a page. */
	PAGE: 64,
	/** Its alias or tags changed. */
	PROPS: 128,
	/**
	 * The writer's change was three-way merged over changes others made after the writer read
	 * the block (an agent's `OutlineEdit`, `agent-merge.ts`): the version holds both. Set only
	 * together with what the write changed.
	 */
	MERGE: 256,
} as const;

export type OutlineChangeFlag = (typeof OUTLINE_CHANGE)[keyof typeof OUTLINE_CHANGE];

export const OUTLINE_SPACE_KINDS = ["project", "personal", "session"] as const;
export type OutlineSpaceKind = (typeof OUTLINE_SPACE_KINDS)[number];

/** Who wrote a commit or a block: a person, an agent (narrator) or the system itself. */
export const OUTLINE_ACTOR_KINDS = ["human", "agent", "system"] as const;
export type OutlineActorKind = (typeof OUTLINE_ACTOR_KINDS)[number];

/** `edit` is every ordinary write; `revert` and `import` are written by their own paths. */
export const OUTLINE_COMMIT_KINDS = ["edit", "revert", "import"] as const;
export type OutlineCommitKind = (typeof OUTLINE_COMMIT_KINDS)[number];

/**
 * Where a link row comes from: `link` (`[[…]]` in content), `embed` (`![[…]]`), `depends`
 * (the task's prerequisites) and `tag` (the block's tags; a tag is a link to the tag's page).
 */
export const OUTLINE_LINK_KINDS = ["link", "embed", "depends", "tag"] as const;
export type OutlineLinkKind = (typeof OUTLINE_LINK_KINDS)[number];

/** `block`: the target is written as an address `key/sid`. `text`: an alias or a title. */
export type OutlineLinkTargetKind = "block" | "text";

/** Limits of one outline transaction, checked before anything is written. */
export const OUTLINE_LIMITS = {
	/** Operations in one transaction. */
	maxOps: 200,
	/** UTF-8 bytes of one block's content, before normalization. */
	maxBodyBytes: 16 * 1024,
	/**
	 * UTF-8 bytes of all content in one transaction. Normalization runs on the caller's thread
	 * and costs superlinearly in a block's size (tens of milliseconds for a 16 KiB block), so
	 * the total bounds the work, not just each block.
	 */
	maxTransactionBodyBytes: 128 * 1024,
	/**
	 * Rows one commit writes: block versions (including every tombstone or page change of a
	 * subtree) plus link rows opened or closed. Larger subtree operations are refused rather
	 * than run as one long transaction.
	 */
	maxRowsTouched: 2000,
	/** Distinct link rows one block may hold. */
	maxLinksPerBlock: 256,
	/** Tags on one block. */
	maxTagsPerBlock: 32,
	/** Live children of one parent (or pages of a space) a write may have to order among. */
	maxSiblings: 10_000,
	/** Ancestors walked when checking a move for cycles. */
	maxDepth: 1000,
	/** Characters of a commit summary. */
	maxSummaryChars: 200,
	/** Blocks of one page a current-state read returns. */
	maxPageBlocks: 10_000,
} as const;

/**
 * Task claims (design §4.5, §7.2): a session's claim is a lease it renews while it runs; one that
 * is not renewed runs out and a background job reopens the task.
 */
export const OUTLINE_TASK_LEASE = {
	/** How long a running session's claim lasts without a renewal. */
	leaseMs: 10 * 60_000,
	/** How often a running session renews its claims. */
	renewEveryMs: 2 * 60_000,
} as const;

/**
 * How long a session's claims last once a run of it ended (D41): between turns the session is
 * idle, often waiting for its person to answer, and a task waiting for people stays in progress
 * (D27b). Its next run renews them back to {@link OUTLINE_TASK_LEASE.leaseMs}; archiving or
 * deleting the session releases them at once; a session that never runs again loses them to the
 * expiry job once this runs out. A server that crashes ends no run: its sessions' leases run out
 * after `leaseMs`, as before.
 */
export const OUTLINE_TASK_IDLE_LEASE_MS = 24 * 60 * 60_000;

/** The end of a lease taken or renewed at `now` (ISO time): a running session's by default. */
export function outlineLeaseEnd(now: string, leaseMs: number = OUTLINE_TASK_LEASE.leaseMs): string {
	return new Date(Date.parse(now) + leaseMs).toISOString();
}
