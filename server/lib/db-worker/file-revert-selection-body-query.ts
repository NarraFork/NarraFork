import type { Database } from "bun:sqlite";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import {
	boundedBodyText,
	hasBlockStorage,
	hasBodyRevisions,
	hasRowsOnlyBodies,
} from "../narrator-bodies";
import type { RevertSelectionBodyParams } from "./protocol";

export function readRevertSelectionBody(
	sqlite: Database,
	params: RevertSelectionBodyParams,
	signal: AbortSignal,
): string | null {
	signal.throwIfAborted();
	return sqlite.transaction(() => {
		const { id, narratorId, refId, contentBytes, bodyRevision, stateRevision } = params;
		const revisions = hasBodyRevisions(sqlite) ? "m.body_revision, m.state_revision" : "NULL, NULL";
		const ref = sqlite
			.query(
				`SELECT 1 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.id = ? AND r.narrator_id = ? AND m.id = ? AND (${revisions}) IS (?, ?)
				 LIMIT 1`,
			)
			.get(refId, narratorId, id, bodyRevision, stateRevision);
		if (!ref) return null;
		const fromBlocks = hasBlockStorage(sqlite) && (params.blockReads || hasRowsOnlyBodies(sqlite));
		signal.throwIfAborted();
		return (
			boundedBodyText(sqlite, id, fromBlocks, {
				exactBytes: contentBytes,
				maxBytes: FILE_CHANGE_LIMITS.historyCowBytes,
			}) ?? null
		);
	})();
}
