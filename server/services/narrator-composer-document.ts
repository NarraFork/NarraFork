import { sqlite } from "../db";
import { readDomainTaskText } from "../db/worker-read";
import { WorkersUnavailableError } from "../lib/db-worker/pool";
import { NotFoundError, ValidationError } from "../lib/errors";
import { settings } from "../lib/settings";

export async function readCommittedComposerDocument(
	narratorId: string,
	messageId: string,
	signal: AbortSignal,
	authorizeCurrent: () => Promise<unknown>,
): Promise<string> {
	signal.throwIfAborted();
	if (sqlite.filename === ":memory:" || sqlite.filename === "" || sqlite.inTransaction)
		throw new WorkersUnavailableError("requires_committed_file");
	const { metadata: result, text } = await readDomainTaskText(
		sqlite,
		"composerDocument",
		{ narratorId, messageId, blockReads: settings.narratorBlocks.read },
		{ signal, timeoutMs: 15_000 },
	);
	await authorizeCurrent();
	signal.throwIfAborted();
	if (result.kind === "rejected")
		throw new ValidationError("Message attachment metadata exceeds the composer detail limit");
	if (result.kind !== "found") throw new NotFoundError("Message", messageId);
	const current = sqlite
		.query(
			`SELECT 1 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.id = ? AND r.narrator_id = ? AND m.id = ?
			   AND m.body_revision = ? AND m.state_revision = ? AND m.role = 'user'
			 LIMIT 1`,
		)
		.get(result.refId, narratorId, messageId, result.bodyRevision, result.stateRevision);
	if (!current) throw new NotFoundError("Message", messageId);
	return text();
}
