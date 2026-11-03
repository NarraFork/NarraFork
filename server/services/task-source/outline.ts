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
 * so the claim is atomic and leased like any other. It lands at the end of the turn whether or
 * not a continuation follows (as in spec), so its commit does not speak of a continuation. A
 * claim the write path refuses (someone took or changed the task meanwhile) is not an error: the
 * tasks are read again and the next to-do is tried, a few times at most
 * ({@link OUTLINE_TASK_SOURCE_LIMITS.promotionAttempts}). With nothing in progress the target is
 * the first waiting task, and the prompt then asks to split out an unblocking task or ask a
 * person (D27b).
 *
 * A subagent has no tasks of its own (D27c): every read is empty, it continues on its turn
 * budget only (`turnBudgetOnly`), and its behavior boundary is its root's.
 *
 * INJECTIONS
 * ----------
 * The session's tasks and behavior boundary reach the model as the built-in views
 * (`contextParts`, `outline-views.ts`): named context parts of the request prefix, in the
 * baseline of every epoch and updated only when they change (plan PR 4, D27e). The periodic
 * digest and the injected fence are retired for the outline: `taskDigest` and `behaviorFence`
 * are always null, so the cadence drain writes neither and reads nothing. The compact context
 * lists the open tasks with their addresses and waits, and the notes the session recorded since
 * its last compact (`compactContext`). A long turn that never touched a task still in progress
 * ends with one line (`turnEndNote`, decision 2026-11-02 Q4).
 *
 * Every read is bounded and indexed: the candidate query's own limits, the session (cached after
 * the first read, `backend.ts`), the session space, and the content of the tasks shown. The
 * session's owner is read only when a task is started for it.
 */
import { createHash } from "node:crypto";
import { blockTitle } from "@shared/outline";
import type { SideCarBody } from "@shared/sidecar-body";
import { logger } from "../../lib/logger";
import {
	getOutlineBoundedContinuationPrompt,
	getOutlineCompactContext,
	getOutlineCompactNoteLine,
	getOutlineCompactTaskLine,
	getOutlineContinuationPrompt,
	getOutlineInterruptNote,
	getOutlineTurnEndNote,
	type Locale,
	type OutlineTaskPromptTask,
} from "../../lib/prompt-i18n";
import { readNarrator } from "../outline/access-reads";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "../outline/errors";
import { OUTLINE_TEXT } from "../outline/messages";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_CHANGE } from "../outline/model";
import { recordOutlineReads, seenOutlineVersion } from "../outline/read-ledger";
import { resolveNarratorSpaces } from "../outline/spaces";
import { outlineStore } from "../outline/store";
import { OutlineStaleWriteError } from "../outline/store/port";
import { writeOutline } from "../outline/write";
import { readTaskSession } from "./backend";
import {
	firstOf,
	isProtected,
	type OpenEntry,
	type OpenRead,
	OUTLINE_OPEN_TASKS_READ,
	type OutlineSession,
	outlineSessionReader,
	readOpen,
	titlesOf,
} from "./outline-read";
import {
	outlineContextParts,
	readPrerequisites,
	unreadableOutlineContextParts,
	viewTaskOf,
} from "./outline-views";
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
	tasks: OUTLINE_OPEN_TASKS_READ,
	/** Open tasks `openTasks()` lists (and reads the titles of); its readers show fewer. */
	openTasks: 20,
	/** Open tasks the compact context lists. */
	compact: 50,
	/** Characters of the compact context. */
	compactChars: 6000,
	/** Characters of the recorded notes in the compact context. */
	compactNoteChars: 3000,
	/** Characters of one note's first line in the compact context. */
	compactNoteLine: 160,
	/** Commits of the session in one space the compact context looks at (newest first). */
	compactCommits: 50,
	/** Versions those commits opened that it reads at most (per space). */
	compactVersions: 200,
	/** Blocks the compact context reads at a time, newest first, until its budget is spent. */
	compactReadChunk: 10,
	/** To-dos tried in turn when the write path refuses to start one. */
	promotionAttempts: 3,
} as const;

/** The system actor of the commit that starts a session's next task. */
export const OUTLINE_TASK_START_ACTOR = "outline-task-start";

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
	const session = outlineSessionReader(narratorId);
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
			// The person accountable for the commit: the session's owner.
			const owner = current.sessionNarratorId
				? ((await readNarrator(current.sessionNarratorId))?.ownerUserId ?? null)
				: null;
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
				actor: { kind: "system", id: OUTLINE_TASK_START_ACTOR },
				responsibleUserId: owner,
				narratorId: current.sessionNarratorId,
				summary: OUTLINE_TEXT.startedForSession(
					entry.ref.address,
					current.sessionNarratorId ?? narratorId,
				),
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
		if (promoteTodo) {
			// Only a task of the session's own space is started on its behalf: anything else it
			// may continue it holds already. A refused start moves on to the next to-do (a task
			// changed meanwhile may be tried again at its new version), a few times at most.
			const tried = new Set<string>();
			for (let attempt = 0; attempt < OUTLINE_TASK_SOURCE_LIMITS.promotionAttempts; attempt++) {
				if (firstOf(read, "doing")) break;
				const next = read.entries.find(
					(entry) =>
						entry.status === "todo" &&
						entry.ref.spaceId === current.spaceId &&
						!tried.has(`${entry.ref.blockId}@${entry.ref.versionSeq}`),
				);
				if (!next) break;
				tried.add(`${next.ref.blockId}@${next.ref.versionSeq}`);
				if (await claim(current, next)) {
					next.status = "doing";
					break;
				}
				read = await readOpen(current);
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

	/**
	 * The notes the session recorded in the outline since `since` (its last compact): blocks it
	 * created or rewrote in its session space and its main project's space that are not tasks,
	 * newest first within the budget, listed oldest first. Two indexed reads per space (the
	 * session's newest commits there and the versions they opened) and one for the blocks.
	 */
	async function recordedNotes(sessionNarratorId: string, since: string | null): Promise<string[]> {
		const spaces = await resolveNarratorSpaces(sessionNarratorId);
		const sinceMs = since ? Date.parse(since) : Number.NaN;
		const writes: Array<{ blockId: string; at: number; seq: number; key: string }> = [];
		for (const space of [spaces?.session, spaces?.project]) {
			if (!space) continue;
			const rows = await outlineStore.listNarratorWrites(space.id, sessionNarratorId, {
				commits: OUTLINE_TASK_SOURCE_LIMITS.compactCommits,
				limit: OUTLINE_TASK_SOURCE_LIMITS.compactVersions,
			});
			for (const row of rows) {
				const at = Date.parse(row.createdAt);
				if (!Number.isNaN(sinceMs) && !(at > sinceMs)) continue;
				if ((row.changeFlags & (OUTLINE_CHANGE.CREATE | OUTLINE_CHANGE.CONTENT)) === 0) continue;
				writes.push({ blockId: row.blockId, at, seq: row.seq, key: space.key });
			}
		}
		writes.sort((a, b) => b.at - a.at || b.seq - a.seq || (a.blockId < b.blockId ? -1 : 1));
		const newest = new Map<string, string>();
		for (const write of writes)
			if (!newest.has(write.blockId)) newest.set(write.blockId, write.key);
		const ids = [...newest.keys()].slice(0, OUTLINE_TASK_SOURCE_LIMITS.compactVersions);
		if (ids.length === 0) return [];
		// The behavior page holds the person's rules (in the new baseline anyway), not decisions.
		const behavior = spaces?.session
			? await outlineStore.findAliasOwners(spaces.session.id, [OUTLINE_BEHAVIOR_ALIAS])
			: [];
		const behaviorPages = new Set(behavior.map((owner) => owner.id));
		// Blocks are read a few at a time, newest first, until the budget is spent: only about what
		// is shown is read.
		const lines: string[] = [];
		let used = 0;
		reading: for (let i = 0; i < ids.length; i += OUTLINE_TASK_SOURCE_LIMITS.compactReadChunk) {
			const chunk = ids.slice(i, i + OUTLINE_TASK_SOURCE_LIMITS.compactReadChunk);
			const blocks = new Map((await outlineStore.getBlocks(chunk)).map((b) => [b.id, b]));
			for (const id of chunk) {
				const block = blocks.get(id);
				if (!block || block.deleted || block.taskJson !== null) continue;
				if (behaviorPages.has(block.pageId)) continue;
				const title = blockTitle(block.content).replace(/\s+/g, " ").trim();
				if (!title) continue;
				const max = OUTLINE_TASK_SOURCE_LIMITS.compactNoteLine;
				const text = title.length > max ? `${title.slice(0, max - 1)}…` : title;
				const line = getOutlineCompactNoteLine({ address: `${newest.get(id)}/${block.sid}`, text });
				if (used + line.length + 1 > OUTLINE_TASK_SOURCE_LIMITS.compactNoteChars) break reading;
				lines.push(line);
				used += line.length + 1;
			}
		}
		return lines.reverse();
	}

	async function compactContext(
		locale: Locale,
		given: string | null | undefined,
	): Promise<string | null> {
		const current = await session();
		if (current.subagent || current.sessionNarratorId === null) return null;
		// The notes are those recorded since the last compact: when its marker was written.
		const since =
			given !== undefined
				? given
				: await (await import("../narrator-service")).narratorService.getLatestCompactCreatedAt(
						current.sessionNarratorId,
					);
		const read = await readOpen(current);
		const listed = read.entries.slice(0, OUTLINE_TASK_SOURCE_LIMITS.compact);
		const noteLines = await recordedNotes(current.sessionNarratorId, since);
		const fixed = getOutlineCompactContext({ taskLines: ["-"], noteLines }, locale).length;
		// Titles and prerequisites are read a few tasks at a time until the budget is spent.
		const taskLines: string[] = [];
		let used = fixed;
		reading: for (let i = 0; i < listed.length; i += OUTLINE_TASK_SOURCE_LIMITS.compactReadChunk) {
			const chunk = listed.slice(i, i + OUTLINE_TASK_SOURCE_LIMITS.compactReadChunk);
			const titles = await titlesOf(chunk);
			const prerequisites = await readPrerequisites(
				chunk.filter((entry) => entry.wait),
				current,
			);
			for (const entry of chunk) {
				const line = getOutlineCompactTaskLine(viewTaskOf(entry, titles, prerequisites), locale);
				if (used + line.length + 1 > OUTLINE_TASK_SOURCE_LIMITS.compactChars) break reading;
				taskLines.push(line);
				used += line.length + 1;
			}
		}
		return getOutlineCompactContext({ taskLines, noteLines }, locale);
	}

	return {
		backend: "outline",
		narratorId,
		currentTask: () => single("doing"),
		nextTask: () => single("todo"),
		async openTasks(): Promise<OpenTaskList> {
			const read = await readOpen(await session());
			// The list is a prefix in document order (its readers show fewer: the interrupt guard
			// eight); the revision key still covers every task read.
			const listed = read.entries.slice(0, OUTLINE_TASK_SOURCE_LIMITS.openTasks);
			const titles = await titlesOf(listed);
			return {
				tasks: listed.map((entry) => toView(entry, titles)),
				revision: revisionOf(read),
			};
		},
		async protectedOpenCount() {
			const read = await readOpen(await session());
			return read.entries.filter(isProtected).length;
		},
		prepareContinuation: ({ promoteTodo }) => prepareContinuation(promoteTodo),
		continuationPrompt,
		// Retired for the outline: the views carry the tasks and the boundary (plan PR 4).
		taskDigest: async () => null,
		behaviorFence: async () => null,
		async contextParts(locale: Locale) {
			// A subagent has no tasks of its own (D27c), only its root's boundary (D31). The
			// session is cached after its first read: a cached view costs no query.
			let subagent = false;
			try {
				subagent = (await readTaskSession(narratorId))?.subagent === true;
			} catch (error) {
				logger.warn("Outline views could not resolve the session", {
					narratorId,
					error: String(error),
				});
				// Not "no views": the request keeps what the model was shown before.
				return unreadableOutlineContextParts();
			}
			return await outlineContextParts(narratorId, locale, { tasks: !subagent });
		},
		async compactContext(locale: Locale, options?: { since?: string | null }) {
			try {
				return await compactContext(locale, options?.since);
			} catch (error) {
				logger.warn("Outline compact context could not be read", {
					narratorId,
					error: String(error),
				});
				return null;
			}
		},
		turnEndNote(task: OpenTaskView, locale: Locale): InterruptGuardNote {
			const content = getOutlineTurnEndNote(promptTask(task), locale);
			return { content, body: { kind: "prose", text: content } };
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
