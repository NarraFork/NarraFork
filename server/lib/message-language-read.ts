import { eq, sql } from "drizzle-orm";
import { normalizeLocale } from "../../shared/i18n-locales";
import { db } from "../db";
import { userPreferences } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { DbReadTaskOverloadedError, DbReadTaskTimeoutError } from "./db-worker/pool";
import { hotSafe } from "./hot-safe";
import { TaskQueue, TaskQueueError } from "./worker-runtime/queue";

// Composer bursts must not fill the shared short-read queue ahead of auth.
const admission = hotSafe(
	"narrafork.messageLanguageAdmission",
	() => new TaskQueue({ concurrency: 1, maxQueued: 4, timeoutMs: 5_000 }),
);

export async function readMessageLanguagePreferences(userId: string, signal: AbortSignal) {
	const query = db
		.select({
			language: sql<string>`substr(${userPreferences.language}, 1, 128)`,
			replyInUserLanguage: userPreferences.replyInUserLanguage,
		})
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.limit(1);

	try {
		const [row] = await admission.run(
			(permit) =>
				readQuery(query, {
					shortRead: true,
					signal: permit.signal,
					timeoutMs: permit.deadlineAt - Date.now(),
					diagnosticSource: "narrator.message-language",
				}),
			{ signal },
		);
		signal.throwIfAborted();
		return {
			locale: normalizeLocale(row?.language),
			replyInUserLanguage: row?.replyInUserLanguage ?? true,
		};
	} catch (error) {
		if (error instanceof TaskQueueError) {
			if (error.code === "TASK_QUEUE_FULL") throw new DbReadTaskOverloadedError();
			if (error.code === "TASK_QUEUE_TIMEOUT")
				throw new DbReadTaskTimeoutError("message language preference read timed out");
		}
		throw error;
	}
}
