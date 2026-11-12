import { AppError, NotFoundError } from "../lib/errors";
import {
	type ContextQuery,
	postgresContextQuery,
	sqliteContextQuery,
} from "./context-composition-history";
import {
	type ActiveNarrator,
	activeNarrators,
	withNarratorMutationAdmission,
} from "./narrator-session-state";

export interface ConversationIdentitySnapshot {
	conversationId: string | null;
	revision: string;
}

type LiveIdentity = Pick<ActiveNarrator, "conversationId" | "_persistedConversationId">;

function moved(): AppError {
	return new AppError(
		"Conversation identity changed during request preparation; prepare again",
		409,
		"CONVERSATION_IDENTITY_CHANGED",
	);
}

/** Two indexed, one-row operations, using the existing cross-backend query adapter.
 * The revision is read as text to preserve PostgreSQL bigint precision. No transaction
 * stays open across awaits, and claiming an identity does not rotate a prefix epoch.
 */
export function createConversationIdentityStore(query: Pick<ContextQuery, "get">) {
	return {
		async read(narratorId: string): Promise<ConversationIdentitySnapshot> {
			const row = await query.get<ConversationIdentitySnapshot>(
				`SELECT api_conversation_id AS "conversationId",
				 CAST(model_history_revision AS TEXT) AS revision FROM narrators WHERE id = ?`,
				[narratorId],
			);
			if (!row) throw new NotFoundError("Narrator", narratorId);
			return row;
		},
		async claim(
			narratorId: string,
			next: string,
			expected: ConversationIdentitySnapshot,
		): Promise<boolean> {
			const row = await query.get<{ id: string }>(
				`UPDATE narrators SET api_conversation_id = ?, updated_at = ?
				 WHERE id = ? AND model_history_revision = ? AND
				 ${expected.conversationId === null ? "api_conversation_id IS NULL" : "api_conversation_id = ?"}
				 RETURNING id`,
				[
					next,
					new Date().toISOString(),
					narratorId,
					expected.revision,
					...(expected.conversationId === null ? [] : [expected.conversationId]),
				],
			);
			return row !== null;
		},
	};
}

/** Call only inside the narrator's mutation admission. A failed claim never changes
 * the in-memory persistence baseline. This must finish before any provider request;
 * teardown must NOT retry it, especially after compact cleared the durable identity.
 */
export async function claimConversationIdentity(
	store: ReturnType<typeof createConversationIdentityStore>,
	narratorId: string,
	active: LiveIdentity,
	assertCurrent: () => void = () => {},
): Promise<string> {
	assertCurrent();
	const expectedId = active._persistedConversationId ?? null;
	const next = active.conversationId;
	const expected = await store.read(narratorId);
	assertCurrent();
	if (
		expected.conversationId !== expectedId ||
		active.conversationId !== next ||
		(active._persistedConversationId ?? null) !== expectedId
	)
		throw moved();
	if (expected.conversationId === next) return next;
	if (!(await store.claim(narratorId, next, expected))) throw moved();
	assertCurrent();
	if (active.conversationId !== next || (active._persistedConversationId ?? null) !== expectedId)
		throw moved();
	active._persistedConversationId = next;
	return next;
}

/** Production entry: share the short admission used by history/ownership mutations. */
export async function ensureConversationIdentityPersisted(
	narratorId: string,
	active: ActiveNarrator,
): Promise<string> {
	return withNarratorMutationAdmission(narratorId, async () => {
		const assertCurrent = () => {
			active.abortController.signal.throwIfAborted();
			if (!active.alive || activeNarrators.get(narratorId) !== active) throw moved();
		};
		assertCurrent();
		const database = await import("../db");
		let query: ContextQuery;
		if (database.activeDatabaseBackend === "postgres") {
			if (!database.postgresRuntime) throw new AppError("PostgreSQL runtime is not connected", 503);
			query = postgresContextQuery(database.postgresRuntime.client.sql);
		} else {
			query = sqliteContextQuery(database.sqlite);
		}
		return claimConversationIdentity(
			createConversationIdentityStore(query),
			narratorId,
			active,
			assertCurrent,
		);
	});
}
