import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import { RECENT_TABS_WS_BATCH_SIZE } from "@shared/recent-tabs";
import { z } from "zod";

const catchUpCursorSchema = z
	.object({
		parentLastMessageId: z.string().min(1).optional(),
		childAnchors: z
			.array(
				z
					.object({
						parentToolUseId: z.string().min(1),
						narratorId: z.string().min(1).optional(),
						lastMessageId: z.string().min(1).optional(),
					})
					.strict(),
			)
			.max(MAX_CATCH_UP_CHILD_ANCHORS)
			.optional(),
	})
	.strict();

// Narrator client → server
export const narratorWsMessageSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("git_workspace_subscribe"),
			subscriptionId: z.string().min(1).max(128),
			narratorId: z.string().min(1).max(128).optional(),
			chapterId: z.string().min(1).max(128).optional(),
			workspaceKey: z.string().min(1).max(128).optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("git_workspace_unsubscribe"),
			subscriptionId: z.string().min(1).max(128),
		})
		.strict(),
	z.object({ type: z.literal("pong") }),
	z
		.object({
			type: z.literal("subscribe"),
			narratorIds: z.array(z.string().min(1)).max(RECENT_TABS_WS_BATCH_SIZE),
			catchUpCursor: catchUpCursorSchema.optional(),
			kind: z.enum(["list", "panel", "messages"]).optional(),
			requestId: z.string().min(1).optional(),
			// Client's last-known messageVersion for this narrator. When it matches
			// the server version, the subscribe short-circuits to sync_ok instead of
			// running a full catch-up query (see narrator-ws.ts subscribe handler).
			version: z.number().int().min(0).optional(),
		})
		.strict(),
	z.object({
		type: z.literal("unsubscribe"),
		narratorIds: z.array(z.string().min(1)).max(RECENT_TABS_WS_BATCH_SIZE),
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
	// Chat room subscriptions ride the narrator socket (see narrator-ws.ts). The
	// batch cap mirrors the per-connection subscription ceiling enforced there.
	z.object({
		type: z.literal("chat_subscribe"),
		roomIds: z.array(z.string().min(1)).max(50),
	}),
	z.object({
		type: z.literal("chat_unsubscribe"),
		roomIds: z.array(z.string().min(1)).max(50),
	}),
	z.object({ type: z.literal("subscribe_stats") }),
	z.object({ type: z.literal("unsubscribe_stats") }),
	z
		.object({
			type: z.literal("sync_check"),
			narratorId: z.string().min(1),
			version: z.number().int().min(0),
			catchUpCursor: catchUpCursorSchema.optional(),
			kind: z.enum(["messages"]).optional(),
			requestId: z.string().min(1).optional(),
		})
		.strict(),
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
		deviceId: z.string().min(1).optional(),
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
