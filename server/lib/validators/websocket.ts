import { z } from "zod";

// Narrator client → server
export const narratorWsMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pong") }),
	z.object({
		type: z.literal("subscribe"),
		narratorIds: z.array(z.string().min(1)),
		lastMessageId: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("unsubscribe"),
		narratorIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("permission_decision"),
		requestId: z.string().min(1),
		decision: z.enum(["allow", "deny"]),
		message: z.string().optional(),
		answers: z.record(z.string(), z.string()).optional(),
		feedbackText: z.string().optional(),
		compactAfter: z.boolean().optional(),
		updatedPlan: z.string().optional(),
	}),
	z.object({
		type: z.literal("merge_decision"),
		mergeSessionId: z.string().min(1),
		decision: z.enum(["continue", "cancel"]),
	}),
	z.object({
		type: z.literal("buffer_message"),
		narratorId: z.string().min(1),
		text: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("cancel_buffer"),
		narratorId: z.string().min(1),
	}),
	z.object({
		type: z.literal("update_buffer"),
		narratorId: z.string().min(1),
		messageId: z.string().min(1),
		text: z.string().min(1).max(100_000),
	}),
	z.object({
		type: z.literal("remove_buffer"),
		narratorId: z.string().min(1),
		messageId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_join"),
		narratorId: z.string().min(1),
	}),
	z.object({
		type: z.literal("presence_leave"),
		narratorId: z.string().min(1),
	}),
	z.object({ type: z.literal("subscribe_stats") }),
	z.object({ type: z.literal("unsubscribe_stats") }),
	z.object({
		type: z.literal("sync_check"),
		narratorId: z.string().min(1),
		version: z.number().int().min(0),
		lastMessageId: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal("update_timeout"),
		narratorId: z.string().min(1),
		toolUseId: z.string().min(1),
		timeoutMs: z.number().int().min(1000).max(86_400_000),
	}),
]);

// Terminal client → server
export const terminalWsMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pong") }),
	z.object({
		type: z.literal("subscribe"),
		terminalIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("unsubscribe"),
		terminalIds: z.array(z.string().min(1)),
	}),
	z.object({
		type: z.literal("input"),
		terminalId: z.string().min(1),
		data: z.string(),
	}),
	z.object({
		type: z.literal("resize"),
		terminalId: z.string().min(1),
		cols: z.number().int().min(10).max(500),
		rows: z.number().int().min(2).max(200),
	}),
	z.object({
		type: z.literal("create"),
		requestId: z.string().min(1),
		chapterId: z.string().min(1).optional(),
		narratorId: z.string().min(1).optional(),
		name: z.string().max(100).optional(),
		cols: z.number().int().min(10).max(500).optional(),
		rows: z.number().int().min(2).max(200).optional(),
	}),
	z.object({
		type: z.literal("kill"),
		terminalId: z.string().min(1),
	}),
	z.object({
		type: z.literal("rename"),
		terminalId: z.string().min(1),
		name: z.string().min(1).max(100),
	}),
]);
