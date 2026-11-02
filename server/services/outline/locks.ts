/**
 * The rules of a locked plan (design §2.2, §2.6; P2 PR 6), as plain functions: which blocks are
 * the plan, and which changes to them wait for confirmation. No database access: the write path
 * (`write.ts`, `classifyLocked`) reads what they need and applies them operation by operation.
 *
 * THE LOCKED TREE
 * ---------------
 * A task whose `task_json.lock` is set locks its tree; the nearest lock above a block applies
 * (builder decision 1). The lock binds agents only (owner decision Q2): people's edits, the
 * system's, reverts and confirmations are written as usual.
 *
 * THE PLAN (owner decision Q3: every block, tasks and plain blocks alike)
 * -----------------------------------------------------------------------
 * A block of the locked tree is part of the plan when it was there at the lock, or the locker
 * wrote it, or a confirmation did. Read from its creation (its first version and that version's
 * commit), never stored (builder decision 2): created at or before the lock's commit, or by a
 * commit of the locker, or by a `confirm` commit. What others add after the lock (progress,
 * findings, the steps an agent splits a leaf into) is not the plan, and is written directly.
 * (A block created before the lock elsewhere and moved into the tree later counts as the plan
 * too: telling would need the tree as of the lock.)
 *
 * WHAT WAITS FOR CONFIRMATION
 * ---------------------------
 *   | change                | direct                                | held for confirmation        |
 *   |-----------------------|---------------------------------------|------------------------------|
 *   | add a plain block     | anywhere                              | —                            |
 *   | add a task            | its parent has no task of the plan    | otherwise (a step of the     |
 *   |                       | under it (splitting a leaf)           | plan)                        |
 *   | rewrite text or props | not the plan                          | the plan                     |
 *   | delete                | no block of the plan in the subtree   | otherwise                    |
 *   | move                  | no block of the plan in the subtree;  | the plan in the subtree; a   |
 *   |                       | the new place as adding a task        | task into or out of the tree |
 *   | checkbox              | to do, in progress, done and back     | the root done or cancelled;  |
 *   |                       |                                       | a plan task cancelled; a     |
 *   |                       |                                       | checkbox added to or taken   |
 *   |                       |                                       | from the plan                |
 *   | assignee              | always                                | —                            |
 *   | prerequisites, due    | not the plan                          | the plan                     |
 *   | the lock itself       | people (`lockOutlineTask`)            | agents are refused outright  |
 */
import type { OutlineTaskJson, OutlineTaskLockJson } from "./model";
import { sameActor } from "./task-json";

/** The creation of a block: its first version's seq and that version's commit. */
export interface OutlineBlockCreation {
	fromSeq: number;
	commit: { kind: string; actorKind: string; actorId: string } | undefined;
}

/**
 * Whether a block of a locked tree is part of the plan: there at the lock (created by the lock's
 * commit or before it), or written by the locker, or by a confirmation.
 */
export function planBlockBy(
	creation: OutlineBlockCreation | undefined,
	lock: OutlineTaskLockJson,
): boolean {
	if (!creation) return false;
	if (creation.fromSeq <= lock.versionSeq) return true;
	const commit = creation.commit;
	if (!commit) return false;
	if (commit.kind === "confirm") return true;
	return sameActor({ kind: commit.actorKind as "human", id: commit.actorId }, lock.by);
}

const ENDED = new Set(["done", "cancelled"]);

/**
 * Whether a checkbox or task change of a block of the plan waits for confirmation. `isRoot`: the
 * block is the lock's own task, whose being done or cancelled is the whole plan's.
 */
export function taskChangeHeld(
	before: OutlineTaskJson | null,
	after: OutlineTaskJson | null,
	isRoot: boolean,
): boolean {
	if ((before === null) !== (after === null)) return true;
	if (!before || !after) return false;
	if (before.status !== after.status) {
		if (isRoot && ENDED.has(after.status)) return true;
		if (!isRoot && after.status === "cancelled") return true;
	}
	if ((before.due ?? null) !== (after.due ?? null)) return true;
	if (JSON.stringify(before.depends ?? []) !== JSON.stringify(after.depends ?? [])) return true;
	return false;
}

/** Whether two locks name the same locker (a delegate change is the same lock). */
export function sameLocker(
	a: OutlineTaskLockJson | null | undefined,
	b: OutlineTaskLockJson | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return sameActor(a.by, b.by);
}
