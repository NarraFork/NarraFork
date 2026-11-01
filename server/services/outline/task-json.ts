/**
 * The task fields of a block (`task_json`) as plain functions: the canonical form the write path
 * stores, comparing two of them, and reading the optional fields with their defaults. No
 * database access.
 *
 * Rows written before a field existed lack it, and a default is never written out, so a row
 * reads the same whichever version of the write path wrote it: no manager known, not created by
 * a person, not locked, not claimable.
 */
import type { LinkTarget, TaskStatus } from "@shared/outline";
import type { OutlineTaskActorRef, OutlineTaskJson, OutlineTaskLockJson } from "./model";

/** Every task field, each optional except the status; `null` and `false` mean the default. */
export interface OutlineTaskFields {
	status: TaskStatus;
	assignee?: string | null;
	depends?: readonly LinkTarget[] | null;
	due?: string | null;
	manager?: OutlineTaskActorRef | null;
	humanCreated?: boolean | null;
	lock?: OutlineTaskLockJson | null;
	claimable?: boolean | null;
}

/** The stored form: fields in a fixed order, defaults left out, prerequisites deduplicated. */
export function canonicalTaskJson(task: OutlineTaskFields): OutlineTaskJson {
	const out: OutlineTaskJson = { status: task.status, assignee: task.assignee ?? null };
	if (task.depends?.length) {
		const seen = new Set<string>();
		out.depends = task.depends
			.map((d) => ({ target: d.target.trim(), label: d.label ?? null }))
			.filter((d) => {
				const key = `${d.target}|${d.label ?? ""}`;
				return !seen.has(key) && !!seen.add(key);
			});
	}
	if (task.due) out.due = task.due;
	if (task.manager) out.manager = { kind: task.manager.kind, id: task.manager.id };
	if (task.humanCreated) out.humanCreated = true;
	if (task.lock) {
		out.lock = {
			by: { kind: task.lock.by.kind, id: task.lock.by.id },
			delegate: task.lock.delegate ?? null,
			versionSeq: task.lock.versionSeq,
		};
	}
	if (task.claimable) out.claimable = true;
	return out;
}

function sameActor(
	a: OutlineTaskActorRef | null | undefined,
	b: OutlineTaskActorRef | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return a.kind === b.kind && a.id === b.id;
}

/** Whether two locks are the same lock (same locker, delegate and version). */
export function sameTaskLock(
	a: OutlineTaskLockJson | null | undefined,
	b: OutlineTaskLockJson | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return (
		sameActor(a.by, b.by) &&
		(a.delegate ?? null) === (b.delegate ?? null) &&
		a.versionSeq === b.versionSeq
	);
}

/** Whether two task states are equal field by field (absent and default are equal). */
export function sameTaskJson(a: OutlineTaskJson | null, b: OutlineTaskJson | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.status === b.status &&
		a.assignee === b.assignee &&
		(a.due ?? null) === (b.due ?? null) &&
		JSON.stringify(a.depends ?? []) === JSON.stringify(b.depends ?? []) &&
		sameActor(a.manager, b.manager) &&
		(a.humanCreated === true) === (b.humanCreated === true) &&
		sameTaskLock(a.lock, b.lock) &&
		(a.claimable === true) === (b.claimable === true)
	);
}

/** Who created the task, when known. */
export function taskManager(task: OutlineTaskJson | null): OutlineTaskActorRef | null {
	return task?.manager ?? null;
}

/** Created by a person through `/goal` or the interface. */
export function isHumanCreatedTask(task: OutlineTaskJson | null): boolean {
	return task?.humanCreated === true;
}

/** The lock on the task tree, if any. */
export function taskLock(task: OutlineTaskJson | null): OutlineTaskLockJson | null {
	return task?.lock ?? null;
}

/** In the claimable pool. */
export function isClaimableTask(task: OutlineTaskJson | null): boolean {
	return task?.claimable === true;
}

/** To do or in progress. */
export function isOpenTask(task: OutlineTaskJson | null): boolean {
	return task?.status === "todo" || task?.status === "doing";
}

/** Done or cancelled: what a task that depends on it waits for. */
export function isFinishedTask(task: OutlineTaskJson | null): boolean {
	return task?.status === "done" || task?.status === "cancelled";
}

/** Assigned to a person (`@human:name`). */
export function hasHumanAssignee(task: OutlineTaskJson | null): boolean {
	return task?.assignee?.startsWith("human:") === true;
}
