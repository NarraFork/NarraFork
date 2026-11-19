import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import {
	MAX_REASONING_TRANSLATION_ID_LENGTH,
	REASONING_TRANSLATION_VISIBILITY_LIMITS,
} from "@shared/reasoning-translation";
import { RECENT_TABS_WS_BATCH_SIZE } from "@shared/recent-tabs";
import { z } from "zod";
import { rejectUnsupportedTerminalResourceSelector } from "./terminals";

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

const reasoningTranslationTargetSchema = z
	.object({
		ownerNarratorId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH),
		messageId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH),
		blockId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH),
		elementId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH).optional(),
		legacyIndex: z.number().int().min(0).max(511).optional(),
		legacyVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
	})
	.strict()
	.refine((target) =>
		target.elementId !== undefined
			? target.legacyIndex === undefined && target.legacyVersion === undefined
			: target.legacyIndex !== undefined && target.legacyVersion !== undefined,
	);

// Narrator client → server
export const narratorWsMessageSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("reasoning_translation_visibility"),
			narratorId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH),
			visibilityId: z.string().min(1).max(128),
			targets: z
				.array(reasoningTranslationTargetSchema)
				.max(REASONING_TRANSLATION_VISIBILITY_LIMITS.targets),
			revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
			groups: z
				.array(
					z
						.object({
							groupId: z.string().min(1).max(MAX_REASONING_TRANSLATION_ID_LENGTH),
							anchor: reasoningTranslationTargetSchema,
							targetIndexes: z
								.array(
									z
										.number()
										.int()
										.min(0)
										.max(REASONING_TRANSLATION_VISIBILITY_LIMITS.targets - 1),
								)
								.min(1)
								.max(REASONING_TRANSLATION_VISIBILITY_LIMITS.targets),
						})
						.strict(),
				)
				.max(REASONING_TRANSLATION_VISIBILITY_LIMITS.targets)
				.optional(),
		})
		.strict()
		.refine((message) => {
			const identities = message.targets.map((target) => JSON.stringify(target));
			if (new Set(identities).size !== identities.length) return false;
			const ids = new Set<string>();
			const indices = new Set<number>();
			for (const group of message.groups ?? []) {
				if (ids.has(group.groupId)) return false;
				ids.add(group.groupId);
				for (const index of group.targetIndexes) {
					const target = message.targets[index];
					if (
						!target ||
						indices.has(index) ||
						target.ownerNarratorId !== group.anchor.ownerNarratorId ||
						target.messageId !== group.anchor.messageId
					)
						return false;
					indices.add(index);
				}
			}
			return true;
		}),
	z
		.object({
			type: z.literal("editor_file_subscribe"),
			subscriptionId: z.string().min(1).max(128),
			narratorId: z.string().min(1).max(128),
			docId: z.string().uuid(),
		})
		.strict(),
	z
		.object({
			type: z.literal("editor_file_unsubscribe"),
			subscriptionId: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			type: z.literal("outline_page_subscribe"),
			subscriptionId: z.string().min(1).max(128),
			pageId: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			type: z.literal("outline_page_unsubscribe"),
			subscriptionId: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			type: z.literal("git_workspace_subscribe"),
			subscriptionId: z.string().min(1).max(128),
			narratorId: z.string().min(1).max(128).optional(),
			workspaceKey: z.string().min(1).max(128).optional(),
			view: z.enum(["summary", "details"]).optional(),
		})
		.strict(),
	z
		.object({
			type: z.enum(["git_workspace_unsubscribe", "git_workspace_refresh"]),
			subscriptionId: z.string().min(1).max(128),
		})
		.strict(),
	z.object({ type: z.literal("pong") }),
	z
		.object({
			type: z.literal("subscribe"),
			narratorIds: z.array(z.string().min(1)).max(RECENT_TABS_WS_BATCH_SIZE),
			catchUpCursor: catchUpCursorSchema.optional(),
			kind: z.enum(["list", "panel", "messages", "activity"]).optional(),
			restoreState: z.boolean().optional(),
			requestId: z.string().min(1).optional(),
			downgrade: z.boolean().optional(),
			// Client's last-known messageVersion for this narrator. When it matches
			// the server version, the subscribe short-circuits to sync_ok instead of
			// running a full catch-up query (see narrator-ws.ts subscribe handler).
			version: z.number().int().min(0).optional(),
			// Ignored: every subscription gets the block-keyed message protocol
			// (docs/BLOCK_STORAGE-DESIGN.md §8.2). Clients loaded before P3d still send it.
			protocol: z.union([z.literal(1), z.literal(2)]).optional(),
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
export const terminalWsMessageSchema = z.preprocess(
	(input, ctx) => {
		if (input && typeof input === "object" && "type" in input && input.type === "create") {
			return rejectUnsupportedTerminalResourceSelector(input, ctx);
		}
		return input;
	},
	z.discriminatedUnion("type", [
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
	]),
);
