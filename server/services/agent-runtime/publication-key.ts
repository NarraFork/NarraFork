import type { PublicationEvent, PublicationRun } from "./publication-outbox";

export function publicationDedupeKey(
	run: PublicationRun,
	eventKind: PublicationEvent | "terminal",
): string {
	return JSON.stringify([
		"publication",
		run.producerKind,
		run.taskId,
		run.logicalRunId,
		eventKind,
		run.recipientId,
	]);
}
