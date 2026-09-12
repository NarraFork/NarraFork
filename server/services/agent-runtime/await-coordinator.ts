import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorQuestions,
	narrators,
} from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { parseSubstatus } from "../../lib/narrator-utils";
import {
	type AsyncQuestionRecord,
	subscribeAsyncQuestionDecisions,
} from "../narrator-question-service";
import { isTakenOver, TAKEN_OVER_SUBSTATUS } from "../subagent-takeover";
import { type AwaitWakeReason, subscribeAwaitWake } from "./await-wake";
import { flushRuntimePublications } from "./publication";

export type AwaitWakeSource =
	| "subagent_completed"
	| "background_task_terminal"
	| "async_question_decided"
	| "mailbox_pending";

export interface AwaitWakeEvent {
	source: AwaitWakeSource;
	narratorId: string;
	targetId?: string;
	taskId?: string;
	taskType?: string;
	questionId?: string;
	questionStatus?: string;
	mailboxKind?: "agent_message" | "task_notice";
}

export interface AwaitAnyEventInput {
	narratorId: string;
	timeoutMs: number;
	signal: AbortSignal;
	timeoutSignal?: AbortSignal;
}

export type AwaitAnyEventResult =
	| { status: "event"; event: AwaitWakeEvent }
	| { status: "timeout" | "aborted" };

const NOTIFICATION_KINDS = ["agent_message", "task_notice"] as const;

type PendingNotificationKind = (typeof NOTIFICATION_KINDS)[number];

function pendingNotificationKind(narratorId: string): PendingNotificationKind | undefined {
	const row = db
		.select({ kind: narratorBufferedMessages.kind })
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, narratorId),
				eq(narratorBufferedMessages.state, "queued"),
				inArray(narratorBufferedMessages.kind, NOTIFICATION_KINDS),
			),
		)
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.limit(1)
		.get();
	return row?.kind as PendingNotificationKind | undefined;
}

function terminalSubagentRow(narratorId: string, since: string) {
	const row = db
		.select({
			id: narrators.id,
			parentNarratorId: narrators.parentNarratorId,
			status: narrators.status,
			substatus: narrators.substatus,
		})
		.from(narrators)
		.where(
			and(
				eq(narrators.parentNarratorId, narratorId),
				ne(narrators.status, "working"),
				ne(narrators.status, "waiting"),
				gte(narrators.updatedAt, since),
			),
		)
		.orderBy(asc(narrators.updatedAt))
		.limit(1)
		.get();
	if (!row || row.parentNarratorId !== narratorId || isTakenOver(row.id)) return undefined;
	if (parseSubstatus(row.substatus).includes(TAKEN_OVER_SUBSTATUS)) return undefined;
	return row;
}

function terminalTaskRow(narratorId: string, since: string) {
	return db
		.select({
			id: backgroundTasks.id,
			type: backgroundTasks.type,
			status: backgroundTasks.status,
		})
		.from(backgroundTasks)
		.where(
			and(
				eq(backgroundTasks.parentNarratorId, narratorId),
				ne(backgroundTasks.status, "running"),
				ne(backgroundTasks.status, "paused"),
				gte(backgroundTasks.updatedAt, since),
			),
		)
		.orderBy(asc(backgroundTasks.updatedAt))
		.limit(1)
		.get();
}

function decidedQuestionRow(narratorId: string, since: string) {
	return db
		.select({
			id: narratorQuestions.id,
			status: narratorQuestions.status,
		})
		.from(narratorQuestions)
		.where(
			and(
				eq(narratorQuestions.narratorId, narratorId),
				ne(narratorQuestions.status, "open"),
				gte(narratorQuestions.decidedAt, since),
			),
		)
		.orderBy(asc(narratorQuestions.decidedAt))
		.limit(1)
		.get();
}

function eventFromQuestion(narratorId: string, record: AsyncQuestionRecord): AwaitWakeEvent {
	return {
		source: "async_question_decided",
		narratorId,
		questionId: record.id,
		questionStatus: record.status,
	};
}

function eventFromMailbox(narratorId: string, kind: PendingNotificationKind): AwaitWakeEvent {
	return { source: "mailbox_pending", narratorId, mailboxKind: kind };
}

/** Wait for the first bounded runtime notification without consuming durable input. */
export async function awaitAnyRuntimeEvent(
	input: AwaitAnyEventInput,
): Promise<AwaitAnyEventResult> {
	const { narratorId, timeoutMs, signal, timeoutSignal } = input;
	const startedAt = new Date().toISOString();

	return new Promise<AwaitAnyEventResult>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const remove: Array<() => void> = [];

		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			for (const unsubscribe of remove.splice(0)) unsubscribe();
			signal.removeEventListener("abort", onAbort);
			timeoutSignal?.removeEventListener("abort", onAbort);
			eventBus.off("narrator:subagent_completed", onSubagentCompleted);
			eventBus.off("narrator:status_changed", onStatusChanged);
			eventBus.off("background_task:completed", onTaskCompleted);
			eventBus.off("background_task:failed", onTaskFailed);
			eventBus.off("background_task:cancelled", onTaskCancelled);
		};

		const finish = (result: AwaitAnyEventResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const finishMailbox = (reason: AwaitWakeReason) => {
			const kind = pendingNotificationKind(narratorId);
			if (!kind) return;
			if (reason === "agent_message" && kind !== "agent_message") return;
			if (reason === "task_notice" && kind !== "task_notice") return;
			finish({ status: "event", event: eventFromMailbox(narratorId, kind) });
		};

		const onWake = (recipientId: string, reason: AwaitWakeReason) => {
			if (recipientId !== narratorId || settled) return;
			finishMailbox(reason);
		};

		const onSubagentCompleted = (event: { narratorId: string; parentNarratorId: string }) => {
			if (settled || event.parentNarratorId !== narratorId) return;
			finish({
				status: "event",
				event: {
					source: "subagent_completed",
					narratorId,
					targetId: event.narratorId,
				},
			});
		};

		const onStatusChanged = (event: { narratorId: string }) => {
			if (settled) return;
			const row = db
				.select({
					id: narrators.id,
					parentNarratorId: narrators.parentNarratorId,
					status: narrators.status,
					substatus: narrators.substatus,
				})
				.from(narrators)
				.where(eq(narrators.id, event.narratorId))
				.limit(1)
				.get();
			if (
				!row ||
				row.parentNarratorId !== narratorId ||
				row.status === "working" ||
				row.status === "waiting" ||
				isTakenOver(row.id) ||
				parseSubstatus(row.substatus).includes(TAKEN_OVER_SUBSTATUS)
			)
				return;
			finish({
				status: "event",
				event: { source: "subagent_completed", narratorId, targetId: row.id },
			});
		};

		const onTaskCompleted = (event: {
			parentNarratorId: string;
			taskId: string;
			taskType: string;
		}) => {
			if (settled || event.parentNarratorId !== narratorId) return;
			finish({
				status: "event",
				event: {
					source: "background_task_terminal",
					narratorId,
					taskId: event.taskId,
					taskType: event.taskType,
				},
			});
		};
		const onTaskFailed = onTaskCompleted;
		const onTaskCancelled = onTaskCompleted;

		const onQuestion = (event: { record: AsyncQuestionRecord }) => {
			if (settled || event.record.narratorId !== narratorId) return;
			finish({ status: "event", event: eventFromQuestion(narratorId, event.record) });
		};

		const onAbort = () => {
			finish({ status: timeoutSignal?.aborted && !signal.aborted ? "timeout" : "aborted" });
		};

		eventBus.on("narrator:subagent_completed", onSubagentCompleted);
		eventBus.on("narrator:status_changed", onStatusChanged);
		eventBus.on("background_task:completed", onTaskCompleted);
		eventBus.on("background_task:failed", onTaskFailed);
		eventBus.on("background_task:cancelled", onTaskCancelled);
		remove.push(subscribeAwaitWake(onWake));
		remove.push(subscribeAsyncQuestionDecisions(onQuestion));

		if (signal.aborted || timeoutSignal?.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		timeoutSignal?.addEventListener("abort", onAbort, { once: true });
		timer = timeoutSignal ? undefined : setTimeout(() => finish({ status: "timeout" }), timeoutMs);

		// Publication transfer is bounded and only makes a durable wake visible. It does not
		// claim a mailbox row or start a narrator loop.
		try {
			flushRuntimePublications(narratorId);
		} catch {
			// The publication worker will retry; event listeners remain active.
		}

		// Recheck every durable source after all listeners are live. This closes the event-before-
		// subscription gap without reading large output or question/message bodies.
		void Promise.resolve()
			.then(() => {
				if (settled) return;
				const task = terminalTaskRow(narratorId, startedAt);
				if (task) {
					finish({
						status: "event",
						event: {
							source: "background_task_terminal",
							narratorId,
							taskId: task.id,
							taskType: task.type,
						},
					});
					return;
				}
				const child = terminalSubagentRow(narratorId, startedAt);
				if (child) {
					finish({
						status: "event",
						event: { source: "subagent_completed", narratorId, targetId: child.id },
					});
					return;
				}
				const question = decidedQuestionRow(narratorId, startedAt);
				if (question) {
					finish({
						status: "event",
						event: {
							source: "async_question_decided",
							narratorId,
							questionId: question.id,
							questionStatus: question.status,
						},
					});
					return;
				}
				const kind = pendingNotificationKind(narratorId);
				if (kind) finish({ status: "event", event: eventFromMailbox(narratorId, kind) });
			})
			.catch(() => {
				// The live listeners remain authoritative if a recheck fails.
			});
	});
}

export function formatAwaitWakeResult(result: AwaitAnyEventResult): string {
	if (result.status === "timeout")
		return "The any-event Await timed out; no supported asynchronous event was observed.";
	if (result.status !== "event") return "The any-event Await was interrupted.";
	const event = result.event;
	switch (event.source) {
		case "subagent_completed":
			return `Await released by asynchronous event [subagent_completed]: subagent ${event.targetId ?? "(unknown)"} completed.`;
		case "background_task_terminal":
			return `Await released by asynchronous event [background_task_terminal]: ${event.taskType ?? "background"} task ${event.taskId ?? "(unknown)"} reached a terminal state.`;
		case "async_question_decided":
			return `Await released by asynchronous event [async_question_decided]: question ${event.questionId ?? "(unknown)"} is ${event.questionStatus ?? "decided"}.`;
		case "mailbox_pending":
			return `Await released by asynchronous event [mailbox_pending]: a ${event.mailboxKind ?? "runtime"} notification is pending for the next safe input boundary.`;
		default:
			return "Await released by an asynchronous event.";
	}
}
