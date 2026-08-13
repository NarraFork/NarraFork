/**
 * parent-injection-queue.ts — ONE ordered queue of pending injections per parent narrator.
 *
 * ## Why this exists
 *
 * Three unrelated in-memory queues used to feed the same turn boundary:
 *
 *   - `bg-completion-queue`      finished background AGENTS
 *   - `background-task-service`  finished background BASH commands
 *   - `parent-inbound-queue`     `Send({ id: "parent" })` progress reports
 *
 * Each was ordered internally, but there was **no order between them**, so
 * `drainInjectionsIntoHistory` had to drain them one after another in a hard-coded
 * sequence: completions first, messages second. That sequence is not a sorting policy —
 * it is what you are forced to write when no order exists.
 *
 * The observable bug: a subagent reports "I'm ready" via Send and *then* finishes, so
 * the message happens BEFORE the completion. The reader (and the model) saw the
 * completion first, i.e. the result before its own cause. Reproduced on narrator
 * 366EIzp1mnthlBsoUsAfB, where the two rows landed 3ms apart in the wrong order.
 *
 * ## Why ordering happens at ENQUEUE and not at drain
 *
 * The order is known for free at the moment of enqueue: the code is running, so "this
 * happened after that" is simply the sequence of `push` calls. Recovering it later from
 * timestamps is strictly worse:
 *
 *   - events milliseconds apart can be recorded out of order under load, and this bug's
 *     two events were 3ms apart;
 *   - same-millisecond events still need a tiebreak, which lands back on the arbitrary
 *     fixed sequence that caused the bug;
 *   - the timestamps were not even being captured (`SideCarDoneTask` had no time field),
 *     so a timestamp-merge design starts by re-adding information that enqueue already
 *     had and threw away.
 *
 * One `push` into one list makes the order exact and total, with no clock involved.
 *
 * ## What deliberately does NOT belong here
 *
 * Cadence reminders (the Dynamic Spec digest, the behaviour fence) and user spec edits
 * are not events in this stream — one fires on a tool counter, the other on a human
 * saving a file. They keep their fixed position in `drainInjectionsIntoHistory` rather
 * than competing for a slot in an event sequence.
 */

import { hotSafe } from "../lib/hot-safe";
import type { CompletedNotification } from "./background-task-service";
import type { CompletedBgSubagentNotification } from "./bg-completion-queue";
import type { ParentInboundMessage } from "./parent-inbound-queue";

/**
 * One pending injection, tagged by which producer raised it.
 *
 * A discriminated union rather than a common shape: the three payloads project to
 * different `SideCarBody` kinds (`tasksDone` twice with different flavors, `messages`
 * once), and flattening them into one record would only move the branching downstream.
 */
export type PendingInjection =
	| { kind: "bg_agent"; task: CompletedBgSubagentNotification }
	| { kind: "bg_bash"; task: CompletedNotification }
	| { kind: "subagent_message"; message: ParentInboundMessage };

export type PendingInjectionKind = PendingInjection["kind"];

/**
 * Per-kind caps, preserving the semantics each queue had on its own.
 *
 * ⚠️ Counted PER KIND, not over the merged list. A single shared cap would let a burst
 * of finished bash commands evict a teammate's messages — the queues were independent
 * before, and merging them for ORDER must not merge their eviction pressure.
 *
 * `subagent_message` keeps its original 20 (`MAX_PARENT_INBOUND_MESSAGES`). The two
 * completion kinds had no count cap at all (only per-result character caps, which stay
 * with their producers), so they get a generous bound whose only job is to stop an
 * unbounded in-memory list — reaching it already means something pathological.
 */
const MAX_PER_KIND: Record<PendingInjectionKind, number> = {
	subagent_message: 20,
	bg_agent: 100,
	bg_bash: 100,
};

/**
 * In-memory only, pinned across hot reloads.
 *
 * `hotSafe` is not optional: the bash queue this replaces was already pinned, and a
 * plain module-level Map would silently drop everything queued before a `--hot` reload.
 */
function getQueue(): Map<string, PendingInjection[]> {
	return hotSafe("narrafork:parent-injection-queue", () => new Map<string, PendingInjection[]>());
}

/**
 * Append one injection, preserving arrival order across ALL kinds.
 *
 * Eviction drops the OLDEST entries of the same kind, so an overflowing kind cannot
 * disturb the relative order of the others.
 */
export function pushPendingInjection(parentNarratorId: string, entry: PendingInjection): void {
	const queue = getQueue();
	const list = queue.get(parentNarratorId) ?? [];
	list.push(entry);

	const limit = MAX_PER_KIND[entry.kind];
	let count = 0;
	for (const item of list) if (item.kind === entry.kind) count++;
	if (count > limit) {
		let toDrop = count - limit;
		for (let i = 0; i < list.length && toDrop > 0; ) {
			if (list[i]?.kind === entry.kind) {
				list.splice(i, 1);
				toDrop--;
				continue;
			}
			i++;
		}
	}

	queue.set(parentNarratorId, list);
}

/** Drain every pending injection in arrival order, emptying the bucket. */
export function drainPendingInjections(parentNarratorId: string): PendingInjection[] {
	const queue = getQueue();
	const list = queue.get(parentNarratorId);
	if (!list || list.length === 0) return [];
	queue.delete(parentNarratorId);
	return list;
}

/**
 * Is anything queued? Read-only — does NOT consume.
 *
 * For the wake predicates, which must decide whether starting a turn is worthwhile
 * without destroying the queue when they decline (a plan-mode narrator, for instance,
 * declines and the entries must survive for the next drain).
 */
export function hasPendingInjections(parentNarratorId: string): boolean {
	const list = getQueue().get(parentNarratorId);
	return !!list && list.length > 0;
}

/** Narrowing helper: every entry of a given kind from a drained list, typed. */
export function runItems<K extends PendingInjectionKind>(
	entries: readonly PendingInjection[],
	kind: K,
): Extract<PendingInjection, { kind: K }>[] {
	return entries.filter(
		(entry): entry is Extract<PendingInjection, { kind: K }> => entry.kind === kind,
	);
}
