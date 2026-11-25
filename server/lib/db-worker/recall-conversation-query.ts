import type { Database } from "bun:sqlite";
import type { RecallConversationOptions, RecallPagination } from "../recall-contract";
import {
	type RecallConversationSnapshot as CoreSnapshot,
	readRecallConversation as readCore,
} from "./recall-reader";

/** Compatibility adapter for the legacy read-task envelope. New callers use the domain port. */
export interface RecallConversationParams extends RecallConversationOptions {
	kind: "recallConversation";
	narratorId: string;
	messageId?: string;
	limit: number;
}
export type RecallConversationSnapshot =
	| { kind: "narratorMissing" }
	| { kind: "messageMissing" }
	| {
			kind: "found";
			narrator: { title: string | null; model: string | null };
			rows: (CoreSnapshot["rows"][number] & { text: string })[];
			tools: CoreSnapshot["tools"];
			pagination: RecallPagination;
	  };
export function readRecallConversation(
	database: Database,
	{ kind: _kind, ...input }: RecallConversationParams,
	signal: AbortSignal,
): RecallConversationSnapshot {
	const result = readCore(database, { ...input, messageId: input.messageId ?? null }, signal);
	if (!result.narrator) return { kind: "narratorMissing" };
	if (result.messageMissing) return { kind: "messageMissing" };
	return {
		kind: "found",
		narrator: result.narrator,
		rows: result.rows.map((row) => ({ ...row, text: row.content_text ?? "" })),
		tools: result.tools,
		pagination: result.pagination,
	};
}
