import { normalizeLocale } from "@shared/i18n-locales";
import { DEFAULT_REPLY_CONTEXT, parseReplyContext, type ReplyContext } from "@shared/reply-context";
import { AppError, NotFoundError } from "../lib/errors";
import {
	type ContextQuery,
	postgresContextQuery,
	sqliteContextQuery,
} from "./context-composition-history";
import { activeNarrators } from "./narrator-session-state";

/** Indexed single-row operations, shared by SQLite and PostgreSQL. */
export function createReplyContextStore(query: Pick<ContextQuery, "get">) {
	return {
		async ensure(narratorId: string, trustedInitial?: ReplyContext): Promise<ReplyContext> {
			for (;;) {
				const row = await query.get<{ replyContext: string | null; ownerUserId: string | null }>(
					'SELECT CAST(reply_context AS TEXT) AS "replyContext", owner_user_id AS "ownerUserId" FROM narrators WHERE id = ?',
					[narratorId],
				);
				if (!row) throw new NotFoundError("Narrator", narratorId);
				if (row.replyContext !== null) {
					const existing = parseReplyContext(JSON.parse(row.replyContext));
					if (!existing) throw new Error("Invalid persisted reply context");
					return existing;
				}
				const preferences =
					!trustedInitial && row.ownerUserId
						? await query.get<{ language: string; reply: boolean | number }>(
								"SELECT language, reply_in_user_language AS reply FROM user_preferences WHERE user_id = ?",
								[row.ownerUserId],
							)
						: null;
				const fallback =
					parseReplyContext(trustedInitial) ??
					(preferences
						? {
								locale: normalizeLocale(preferences.language),
								replyInUserLanguage: !!preferences.reply,
							}
						: { ...DEFAULT_REPLY_CONTEXT, replyInUserLanguage: row.ownerUserId !== null });
				const written = await query.get<{ id: string }>(
					"UPDATE narrators SET reply_context = ? WHERE id = ? AND reply_context IS NULL RETURNING id",
					[JSON.stringify(fallback), narratorId],
				);
				if (written) return fallback;
				// A concurrent human adoption won the CAS; reload its complete authoritative pair.
			}
		},
		async adopt(narratorId: string, pair: ReplyContext): Promise<void> {
			const context = parseReplyContext(pair);
			if (!context) throw new Error("Human reply context is required");
			const row = await query.get<{ id: string }>(
				"UPDATE narrators SET reply_context = ? WHERE id = ? RETURNING id",
				[JSON.stringify(context), narratorId],
			);
			if (!row) throw new NotFoundError("Narrator", narratorId);
		},
	};
}

async function replyContextStore() {
	const database = await import("../db");
	if (database.activeDatabaseBackend === "postgres") {
		if (!database.postgresRuntime) throw new AppError("PostgreSQL runtime is not connected", 503);
		return createReplyContextStore(postgresContextQuery(database.postgresRuntime.client.sql));
	}
	return createReplyContextStore(sqliteContextQuery(database.sqlite));
}

/** Existing durable policy wins; trusted recovery/creation can only seed a legacy null. */
export async function ensureReplyContext(
	narratorId: string,
	trustedInitial?: ReplyContext,
): Promise<ReplyContext> {
	return (await replyContextStore()).ensure(narratorId, trustedInitial);
}

/** Call only after the message/adoption transaction committed. */
export function syncActiveReplyContext(narratorId: string, pair: ReplyContext): void {
	const active = activeNarrators.get(narratorId);
	if (active) {
		active.locale = pair.locale;
		active._replyInUserLanguage = pair.replyInUserLanguage;
	}
}

/** Explicit human actions without a mailbox message, inside their accepted admission. */
export async function adoptHumanReplyContext(
	narratorId: string,
	pair: ReplyContext,
): Promise<void> {
	const context = parseReplyContext(pair);
	if (!context) throw new Error("Human reply context is required");
	await (await replyContextStore()).adopt(narratorId, context);
	syncActiveReplyContext(narratorId, context);
}
