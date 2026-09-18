import type { narratorMessages } from "../../db/schema";

export type RefMessageInput = typeof narratorMessages.$inferInsert;
export type RefMessage = typeof narratorMessages.$inferSelect & { seq: number };
export type RefCursor = { seq: number; id: string };
/** A paged copy is a bounded window, not a whole narrator fork lifecycle. */
export type RefCopyCursor = RefCursor & {
	sourceStructureVersion: number;
	targetStructureVersion: number;
};
export interface RefOperationOptions {
	signal?: AbortSignal;
}

/** Networked domain port. All results are Promises; no SQLite transaction handles cross it. */
export interface NarratorMessageRefsPort {
	creator(userId: string): Promise<{
		id: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null>;
	append(message: RefMessageInput, options?: RefOperationOptions): Promise<RefMessage>;
	insertBefore(
		message: RefMessageInput,
		beforeMessageId: string,
		options?: RefOperationOptions,
	): Promise<RefMessage>;
	copyRefs(
		input: {
			sourceId: string;
			targetId: string;
			fromSeq: number;
			untilSeq: number;
			cursor?: RefCopyCursor;
			limit?: number;
		},
		options?: RefOperationOptions,
	): Promise<{ copied: number; nextSeq: number; nextCursor: RefCopyCursor | null }>;
	page(
		narratorId: string,
		cursor?: RefCursor,
		limit?: number,
		options?: RefOperationOptions,
	): Promise<{
		rows: { id: string; messageId: string; seq: number; role: string; createdAt: string }[];
		nextCursor: RefCursor | null;
	}>;
}
