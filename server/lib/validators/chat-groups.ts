import { z } from "zod";

/** Post a message into a chat group (from a user). */
export const postGroupMessageSchema = z.object({
	content: z.string().trim().min(1).max(8000),
	urgent: z.boolean().optional(),
});

/** Add a named narrator to a group by handle. */
export const addGroupMemberSchema = z.object({
	handle: z.string().trim().min(2).max(32),
});

/** Create a group explicitly (optional; groups are usually created via @mention). */
export const createGroupSchema = z.object({
	originNarratorId: z.string().min(1),
	title: z.string().trim().max(200).optional(),
});
