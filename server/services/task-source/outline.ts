/**
 * The outline task source (task backend `outline`): a session's tasks are checkbox blocks, read
 * from the database whatever the agent's context holds (design §4.8).
 *
 * WHICH TASKS ARE THE SESSION'S
 * -----------------------------
 * The continuation candidates of `findContinuationCandidates` (`outline/tasks.ts`): the tasks the
 * session holds a claim on and the open tasks of its session space, to do or in progress, that no
 * person is doing and no other session holds. Of those, a task WAITS when a prerequisite is not
 * finished or a question under it is unanswered; waiting is never stored (D27b). Readers see:
 *
 *   - `doing` / `todo`: a candidate in progress / to do;
 *   - `blocked`: a waiting task, whatever its checkbox (it cannot be started or continued);
 *   - `protected`: created by a person (`/goal`, the interface; D27a).
 *
 * Order is document order. Current is the first `doing`, next the first `todo` (anywhere, as
 * spec's). At most {@link OUTLINE_TASK_SOURCE_LIMITS.tasks} of each kind are read.
 *
 * CONTINUATION
 * ------------
 * With `promoteTodo` and nothing in progress, the first `todo` of the session space is started:
 * a real commit through the write path (`setTask` to in progress, based on the version read),
 * so the claim is atomic and leased like any other. A claim the write path refuses (someone
 * took or changed the task meanwhile) is not an error: the tasks are read again and the choice
 * made from what is there. With nothing in progress the target is the first waiting task, and
 * the prompt then asks to split out an unblocking task or ask a person (D27b).
 *
 * A subagent has no tasks of its own (D27c): every read is empty, it continues on its turn
 * budget only (`turnBudgetOnly`), it gets no digest, and its fence is its root's.
 *
 * INJECTIONS UNTIL PLAN PR 4
 * --------------------------
 * The digest, the fence and the compact context are minimal until the built-in views replace
 * them (plan PR 4): the digest lists the open tasks with their addresses in outline words; the
 * compact context lists the open tasks; the fence is the session's `spec://behavior_fence`,
 * which the person and plugins still write (the agent cannot: `spec://` is closed to an outline
 * session, and the fence was never the agent's to write), until the behavior-fence page exists.
 *
 * Every read is bounded and indexed (the candidate query's own limits, plus one primary-key read
 * of the narrator, one of the session space and one of the task blocks' content).
 */
import { createHash } from "node:crypto";
import { blockTitle } from "@shared/outline";
import type { SideCarBody, SideCarTaskEntry } from "@shared/sidecar-body";
import { logger } from "../../lib/logger";
import {
	getOutlineBoundedContinuationPrompt,
	getOutlineCompactContext,
	getOutlineContinuationPrompt,
	getOutlineInterruptNote,
	type Locale,
	type OutlineTaskPromptTask,
} from "../../lib/prompt-i18n";
import { readNarratorTaskBackend } from "../outline/access-reads";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "../outline/errors";
import { OUTLINE_TEXT } from "../outline/messages";
import { recordOutlineReads, seenOutlineVersion } from "../outline/read-ledger";
import { outlineStore } from "../outline/store";
import { OutlineStaleWriteError } from "../outline/store/port";
import {
	findContinuationCandidates,
	type OutlineTaskRef,
	type OutlineTaskWait,
} from "../outline/tasks";
import { writeOutline } from "../outline/write";
import { buildBehaviorFenceBody } from "../spec-reminder";
import type {
	ContinuationPromptInput,
	ContinuationTarget,
	ContinuationTask,
	InterruptGuardNote,
	NarratorTaskSource,
	OpenTaskList,
	OpenTaskStatus,
	OpenTaskView,
	TaskView,
} from "./types";

export const OUTLINE_TASK_SOURCE_LIMITS = {
	/** Candidates, and waiting tasks, one read takes (each). */
	tasks: 50,
	/** Tasks the digest names. */
	digest: 4,
	/** Waiting tasks the digest names. */
	digestWaiting: 3,
} as const;

/** The system actor of the commit that starts a task for a continuation. */
export const OUTLINE_CONTINUATION_ACTOR = "outline-continuation";

/** The narrator a source is bound to, and the session its tasks belong to. */
interface OutlineSession {
	narratorId: string;
	/** A subagent: no tasks of its own (D27c). */
	subagent: boolean;
	/** The session (the narrator, or a subagent's root); null when a subagent's root is gone. */
	sessionNarratorId: string | null;
	ownerUserId: string | null;
	/** The session space; null until something was written to it. */
	spaceId: string | null;
}

async function readSession(narratorId: string): Promise<OutlineSession> {
	const row = await readNarratorTaskBackend(narratorId);
	const sessionNarratorId = row ? row.sessionNarratorId : narratorId;
	const space =
		sessionNarratorId === null
			? null
			: await outlineStore.findSpace({ kind: "session", narratorId: sessionNarratorId });
	return {
		narratorId,
		subagent: row?.subagent === true,
		sessionNarratorId,
		ownerUserId: row?.sessionOwnerUserId ?? null,
		spaceId: space?.id ?? null,
	};
}

/** One open task of the session, before its text is read. */
interface OpenEntry {
	ref: OutlineTaskRef;
	wait: OutlineTaskWait | null;
	status: OpenTaskStatus;
}

interface OpenRead {
	entries: OpenEntry[];
	truncated: boolean;
}

async function readOpen(session: OutlineSession): Promise<OpenRead> {
	if (session.subagent || session.sessionNarratorId === null) {
		return { entries: [], truncated: false };
	}
	const found = await findContinuationCandidates({
		narratorId: session.sessionNarratorId,
		sessionSpaceId: session.spaceId,
		limit: OUTLINE_TASK_SOURCE_LIMITS.tasks,
	});
	return {
		entries: found.ordered.map(({ wait, ...ref }) => ({
			ref,
			wait,
			status: wait ? "blocked" : ref.status,
		})),
		truncated: found.truncated,
	};
}

function isProtected(entry: OpenEntry): boolean {
	return entry.ref.taskJson.humanCreated === true;
}

const firstOf = (read: OpenRead, status: OpenTaskStatus) =>
	read.entries.find((entry) => entry.status === status) ?? null;

/** The titles of the given tasks, read in one statement. */
async function titlesOf(entries: readonly OpenEntry[]): Promise<Map<string, string>> {
	const ids = [...new Set(entries.map((entry) => entry.ref.blockId))];
	const out = new Map<string, string>();
	if (ids.length === 0) return out;
	for (const block of await outlineStore.getBlocks(ids)) {
		out.set(block.id, blockTitle(block.content) || block.sid);
	}
	return out;
}

/**
 * The revision key of the open tasks: a digest of what each is and waits for. A write to a task
 * moves its `version_seq`; a prerequisite finishing or a question being answered changes its wait
 * (D27b); claims renewing their lease do not count.
 */
function revisionOf(read: OpenRead): string | null {
	if (read.entries.length === 0) return null;
	const hash = createHash("sha256");
	hash.update(read.truncated ? "t" : "f");
	for (const { ref, wait, status } of read.entries) {
		hash.update(
			JSON.stringify([
				ref.blockId,
				ref.versionSeq,
				status,
				wait ? [...wait.prerequisites].sort() : null,
				wait?.people ?? false,
			]),
		);
	}
	return `outline:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Errors that mean the write path refused the claim: someone took, changed or deleted the task
 * (or the space kept changing). Anything else is a failure of the read or write itself.
 */
function isRefusedClaim(error: unknown): boolean {
	return (
		error instanceof OutlineWriteError ||
		error instanceof OutlineConflictError ||
		error instanceof OutlineBusyError ||
		error instanceof OutlineStaleWriteError
	);
}

/** One narrator's outline task source. Reads go to the database each time. */
export function createOutlineTaskSource(narratorId: string): NarratorTaskSource {
	let sessionPromise: Promise<OutlineSession> | undefined;
	const session = async (): Promise<OutlineSession> => {
		sessionPromise ??= readSession(narratorId);
		const current = await sessionPromise.catch((error) => {
			sessionPromise = undefined;
			throw error;
		});
		// A session space appears with the session's first write; a source kept across one
		// looks again rather than reading an empty session from then on.
		if (current.spaceId === null && !current.subagent && current.sessionNarratorId !== null) {
			const space = await outlineStore.findSpace({
				kind: "session",
				narratorId: current.sessionNarratorId,
			});
			if (space) current.spaceId = space.id;
		}
		return current;
	};
	/** Address and person-created mark of every task this source handed out, by identity. */
	const known = new WeakMap<object, OutlineTaskPromptTask>();

	const remember = <T extends { text: string }>(view: T, entry: OpenEntry): T => {
		known.set(view, {
			text: view.text,
			address: entry.ref.address,
			humanCreated: isProtected(entry),
		});
		return view;
	};
	const toView = (entry: OpenEntry, titles: Map<string, string>): OpenTaskView =>
		remember(
			{
				text: titles.get(entry.ref.blockId) ?? entry.ref.sid,
				status: entry.status,
				protected: isProtected(entry),
			},
			entry,
		);
	const promptTask = (task: { text: string; protected: boolean }): OutlineTaskPromptTask =>
		known.get(task) ?? { text: task.text, address: null, humanCreated: task.protected };

	async function single(status: OpenTaskStatus): Promise<TaskView | null> {
		const read = await readOpen(await session());
		const entry = firstOf(read, status);
		return entry ? toView(entry, await titlesOf([entry])) : null;
	}

	async function claim(current: OutlineSession, entry: OpenEntry): Promise<boolean> {
		try {
			const result = await writeOutline({
				spaceId: entry.ref.spaceId,
				ops: [
					{
						op: "setTask",
						block: { id: entry.ref.blockId },
						task: { status: "doing" },
						baseVersionSeq: entry.ref.versionSeq,
					},
				],
				actor: { kind: "system", id: OUTLINE_CONTINUATION_ACTOR },
				responsibleUserId: current.ownerUserId,
				narratorId: current.sessionNarratorId,
				summary: OUTLINE_TEXT.continuationStarted(entry.ref.address),
			});
			if (!result.commit) return false;
			// The claim changed only the checkbox, and the continuation prompt tells the session
			// so. When the session knew the task as it was just before, it knows it as it is now:
			// its next edit of the task (ticking it done) is not refused as made against an
			// older version. A task it never read it still has to read first.
			const holder = current.sessionNarratorId;
			if (holder && seenOutlineVersion(holder, entry.ref.blockId) === entry.ref.versionSeq) {
				recordOutlineReads(holder, [[entry.ref.blockId, result.commit.seq]]);
			}
			return true;
		} catch (error) {
			if (!isRefusedClaim(error)) throw error;
			if (!(error instanceof OutlineTaskClaimedError || error instanceof OutlineConflictError)) {
				logger.warn("Outline continuation could not start a task", {
					narratorId,
					task: entry.ref.address,
					error: String(error),
				});
			}
			return false;
		}
	}

	async function prepareContinuation(promoteTodo: boolean): Promise<ContinuationTarget> {
		const current = await session();
		if (current.subagent) return { openTask: null, protectedOpenCount: 0, turnBudgetOnly: true };
		let read = await readOpen(current);
		if (promoteTodo && !firstOf(read, "doing")) {
			// Only a task of the session's own space is started on its behalf: anything else it
			// may continue it holds already.
			const next = read.entries.find(
				(entry) => entry.status === "todo" && entry.ref.spaceId === current.spaceId,
			);
			if (next) {
				if (await claim(current, next)) next.status = "doing";
				else read = await readOpen(current);
			}
		}
		const chosen = firstOf(read, "doing") ?? firstOf(read, "blocked");
		const protectedOpenCount = read.entries.filter(isProtected).length;
		if (!chosen) return { openTask: null, protectedOpenCount };
		const text = (await titlesOf([chosen])).get(chosen.ref.blockId) ?? chosen.ref.sid;
		const openTask: ContinuationTask = remember(
			{
				text,
				protected: isProtected(chosen),
				status: chosen.status === "doing" ? "doing" : "blocked",
			},
			chosen,
		);
		return { openTask, protectedOpenCount };
	}

	function continuationPrompt(input: ContinuationPromptInput): string {
		if (input.form === "bounded") {
			return getOutlineBoundedContinuationPrompt({
				cause: input.cause,
				task: input.turnBudgetOnly
					? null
					: { ...promptTask(input.task), status: input.task.status },
				passes: input.passes,
				maxPasses: input.maxPasses,
				canAskUserQuestion: input.canAskUserQuestion,
				locale: input.locale,
			});
		}
		return getOutlineContinuationPrompt({
			status: input.task.status,
			task: promptTask(input.task),
			locale: input.locale,
		});
	}

	async function taskDigest(): Promise<SideCarBody | null> {
		const current = await session();
		if (current.subagent) return null;
		const read = await readOpen(current);
		if (read.entries.length === 0) {
			// Never started anything in its space: nudge to write tasks. Otherwise its tasks are
			// finished (or it only wrote notes): say there is nothing open.
			const pages = current.spaceId
				? await outlineStore.listChildMetas(current.spaceId, [null], 1)
				: [];
			return { kind: "tasks", variant: pages.length > 0 ? "emptyDone" : "emptyNever" };
		}
		const picked: Array<{ role: SideCarTaskEntry["role"]; entry: OpenEntry }> = [];
		const lead = firstOf(read, "doing");
		const next = firstOf(read, "todo");
		if (lead) picked.push({ role: "doing", entry: lead });
		else if (next) picked.push({ role: "next", entry: next });
		for (const entry of read.entries
			.filter((e) => e.status === "blocked")
			.slice(0, OUTLINE_TASK_SOURCE_LIMITS.digestWaiting)) {
			picked.push({ role: "blocked", entry });
		}
		// The next task is listed once: as `next` when nothing is in progress, else as a to-do.
		const listedNext = lead ? null : next;
		for (const entry of read.entries.filter((e) => e.status === "todo" && e !== listedNext)) {
			if (picked.length >= OUTLINE_TASK_SOURCE_LIMITS.digest) break;
			picked.push({ role: "todo", entry });
		}
		const titles = await titlesOf(picked.map((p) => p.entry));
		return {
			kind: "tasks",
			variant: "current",
			tasks: picked.map(({ role, entry }) => ({
				role,
				text: titles.get(entry.ref.blockId) ?? entry.ref.sid,
				...(isProtected(entry) ? { protected: true } : {}),
				ref: entry.ref.address,
			})),
		};
	}

	return {
		backend: "outline",
		narratorId,
		currentTask: () => single("doing"),
		nextTask: () => single("todo"),
		async openTasks(): Promise<OpenTaskList> {
			const read = await readOpen(await session());
			const titles = await titlesOf(read.entries);
			return {
				tasks: read.entries.map((entry) => toView(entry, titles)),
				revision: revisionOf(read),
			};
		},
		async protectedOpenCount() {
			const read = await readOpen(await session());
			return read.entries.filter(isProtected).length;
		},
		prepareContinuation: ({ promoteTodo }) => prepareContinuation(promoteTodo),
		continuationPrompt,
		taskDigest: () => taskDigest().catch(() => null),
		async behaviorFence() {
			try {
				const current = await session();
				return current.sessionNarratorId === null
					? null
					: await buildBehaviorFenceBody(current.sessionNarratorId);
			} catch {
				return null;
			}
		},
		async compactContext(locale: Locale) {
			try {
				const read = await readOpen(await session());
				if (read.entries.length === 0) return null;
				const titles = await titlesOf(read.entries);
				return getOutlineCompactContext(
					read.entries.map((entry) => ({
						text: titles.get(entry.ref.blockId) ?? entry.ref.sid,
						address: entry.ref.address,
						humanCreated: isProtected(entry),
						status: entry.status,
					})),
					locale,
				);
			} catch {
				return null;
			}
		},
		interruptGuardNote(tasks: readonly OpenTaskView[], locale: Locale): InterruptGuardNote {
			const content = getOutlineInterruptNote(
				tasks.map((task) => ({ ...promptTask(task), status: task.status })),
				locale,
			);
			const body: SideCarBody = {
				kind: "tasks",
				variant: "current",
				taskBackend: "outline",
				tasks: tasks.map((task) => {
					const address = known.get(task)?.address ?? null;
					return {
						role: task.status,
						text: task.text,
						...(task.protected ? { protected: true as const } : {}),
						...(address ? { ref: address } : {}),
					};
				}),
			};
			return { content, body };
		},
	};
}
