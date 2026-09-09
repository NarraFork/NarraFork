import type { db } from "../../db";
import type { narratorBufferedMessages } from "../../db/schema";

export type RuntimeDb = typeof db;
export type RuntimeTx = Parameters<Parameters<RuntimeDb["transaction"]>[0]>[0];
export type RuntimeStoreDb = RuntimeDb | RuntimeTx;
export type MailboxRow = typeof narratorBufferedMessages.$inferSelect;
export type MailboxKind = MailboxRow["kind"];
export type NoticeKind = "agent" | "bash";
export type MailboxState = MailboxRow["state"];
export interface PayloadReference {
	storage: "buffered_file" | "upload";
	path: string;
	byteSize: number;
	ownership: "mailbox" | "shared";
}
interface InputBase {
	narratorId: string;
	text: string;
	/** Exact final model projection size, including locale/prefix/reply wrapping. */
	projectedByteSize: number;
	metadata?: Record<string, unknown>;
	payloadRef?: PayloadReference;
	createdBy?: string | null;
}
export type MailboxInput = InputBase &
	(
		| {
				kind: "user_input";
				requestKey?: string;
				priority?: boolean;
				seq?: number;
				commandText?: string | null;
				bashCommand?: string | null;
				imagesJson?: string | null;
				creatorJson?: string | null;
				textFilePathsJson?: string | null;
				fileReferencesJson?: string | null;
		  }
		| {
				kind: "agent_message";
				sourceNarratorId: string;
				sourceToolCallId: string;
				sourceAttempt: number;
				/** Stable execution receipt, never text hash or provider tool-use ID. */
				sourceKey: string;
				recipientMessageId?: string;
		  }
		| {
				kind: "task_notice";
				noticeKind: NoticeKind;
				sourceKey: string;
		  }
	);
export interface MailboxClaim {
	id: string;
	narratorId: string;
	token: string;
	epoch: string;
}
export interface MaterializedBinding {
	messageId: string;
	refId: string;
	revision?: number;
}
export type EnqueueResult =
	| { status: "accepted" | "duplicate"; delivery: MailboxRow }
	| { status: "full" | "publication_pending" };
export type Materializer = (tx: RuntimeTx, row: MailboxRow) => MaterializedBinding;
export type EligibleMailboxHead = Pick<
	MailboxRow,
	| "id"
	| "narratorId"
	| "kind"
	| "metadataJson"
	| "projectedByteSize"
	| "arrivalSeq"
	| "seq"
	| "priority"
	| "createdBy"
	| "deliveryId"
>;
export type RecoverableMailboxClaim = Pick<
	MailboxRow,
	"id" | "narratorId" | "claimToken" | "claimEpoch"
>;
