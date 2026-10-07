import { FORK_WORKTREE_SOURCES, type ForkWorktreeSource } from "@shared/chapter-fork";
import { formatOriginLabel } from "@shared/message-origin";
import { z } from "zod/v4";
import { getVisibleModels } from "../../settings";
import {
	exceedsForkDepthLimit,
	FORK_NARRATOR_MAX_DEPTH,
	resolveForkDepth,
} from "../fork-narrator-depth";
import type { ToolDefinition, ToolResult } from "../types";

import baseDescription from "./fork-narrator.txt" with { type: "text" };

function getAvailableModelsList(): string {
	const models = getVisibleModels();
	return models.length > 0 ? models.join(", ") : "(no models configured yet)";
}

export const forkNarratorTool: ToolDefinition = {
	name: "ForkNarrator",
	get description() {
		return baseDescription;
	},
	get parameters() {
		return z.object({
			mode: z
				.enum(["fresh", "fork"])
				.describe(
					'"fresh" = new narrator with no history; "fork" = inherit current conversation history',
				),
			message: z.string().describe("The initial message to send to the new narrator"),
			title: z.string().optional().describe("Title for the new independent narrator"),
			inheritMode: z
				.enum(["full", "compressed"])
				.optional()
				.describe(
					'Only used when mode="fork". "full" = share message refs (default); "compressed" = AI-generated summary',
				),
			worktreeSource: z
				.enum(FORK_WORKTREE_SOURCES)
				.optional()
				.describe(
					"Deprecated and rejected. Use the explicit CreateWorktree resource tool to create filesystem resources.",
				),
			commitSha: z
				.string()
				.min(1)
				.optional()
				.describe(
					"Deprecated and rejected. Use the explicit CreateWorktree resource tool to select a commit.",
				),
			model: z
				.string()
				.optional()
				.describe(
					`Override the model for the new narrator. Available models: ${getAvailableModelsList()}`,
				),
		});
	},
	get rawJsonSchema() {
		return {
			type: "object" as const,
			properties: {
				mode: {
					description:
						'"fresh" = new narrator with no history; "fork" = inherit current conversation history',
					type: "string",
					enum: ["fresh", "fork"],
				},
				message: {
					description: "The initial message to send to the new narrator",
					type: "string",
				},
				title: {
					description: "Title for the new independent narrator",
					type: "string",
				},
				inheritMode: {
					description:
						'Only used when mode="fork". "full" = share message refs (default); "compressed" = AI-generated summary',
					type: "string",
					enum: ["full", "compressed"],
				},
				worktreeSource: {
					description:
						"Deprecated and rejected. Use the explicit CreateWorktree resource tool to create filesystem resources.",
					type: "string",
					enum: [...FORK_WORKTREE_SOURCES],
				},
				commitSha: {
					description:
						"Deprecated and rejected. Use the explicit CreateWorktree resource tool to select a commit.",
					type: "string",
				},
				model: {
					description: `Override the model for the new narrator. Available models: ${getAvailableModelsList()}`,
					type: "string",
				},
			},
			required: ["mode", "message"],
			additionalProperties: false,
		};
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { mode, message, title, inheritMode, worktreeSource, commitSha, model } = args as {
			mode: "fresh" | "fork";
			message: string;
			title?: string;
			inheritMode?: "full" | "compressed";
			worktreeSource?: ForkWorktreeSource;
			commitSha?: string;
			model?: string;
		};

		if (worktreeSource !== undefined || commitSha !== undefined) {
			return {
				output:
					"ForkNarrator creates an independent conversation, not files. Use the explicit CreateWorktree resource tool for worktreeSource or commitSha.",
				isError: true,
			};
		}

		try {
			const { narratorService } = await import("@server/services/narrator-service");
			const { sendMessage } = await import("@server/services/narrator-session");
			const { getToolMessageWithParams } = await import("@server/lib/prompt-i18n");
			const locale = (ctx.locale ?? "en") as import("@server/lib/prompt-i18n").Locale;

			const parent = await narratorService.getById(ctx.narratorId);

			// Refuse before creating anything. A forked narrator holds this same tool and
			// its first message is written by the AI that forked it, so nothing else stops
			// a chain — every hop starts another independent running loop.
			const parentDepth = await resolveForkDepth({
				id: parent.id,
				chapterId: parent.chapterId ?? null,
			});
			if (exceedsForkDepthLimit(parentDepth)) {
				return {
					output: getToolMessageWithParams("forkNarratorDepthExceeded", locale, {
						depth: String(parentDepth),
						limit: String(FORK_NARRATOR_MAX_DEPTH),
					}),
					isError: true,
				};
			}

			const newNarrator = await narratorService.forkStandaloneFromTool(ctx.narratorId, mode, {
				title,
				inheritMode,
				userId: ctx.userId ?? null,
				model,
				locale: ctx.locale,
			});
			const newNarratorId = newNarrator.id;
			const newTitle = newNarrator.title ?? title ?? "Forked narrator";

			// Fire-and-forget: send the initial message to the new narrator.
			// The prompt was written by the forking AI, not by a human.
			const { logger } = await import("@server/lib/logger");
			sendMessage(
				newNarratorId,
				message,
				undefined,
				locale,
				false,
				null,
				ctx.userId ?? null,
				undefined,
				null,
				{
					origin: "assistant",
					originLabel: formatOriginLabel("forkNarrator"),
				},
			).catch((err) => {
				logger.error("ForkNarrator: failed to send initial message", {
					narratorId: newNarratorId,
					error: err instanceof Error ? err.message : String(err),
				});
			});

			return {
				output: getToolMessageWithParams("forkNarratorSuccess", locale, {
					narratorId: newNarratorId,
					title: newTitle,
					chapterInfo: "",
				}),
			};
		} catch (err) {
			const { getToolMessageWithParams } = await import("@server/lib/prompt-i18n");
			const locale = (ctx.locale ?? "en") as import("@server/lib/prompt-i18n").Locale;
			return {
				output: getToolMessageWithParams("forkNarratorError", locale, {
					error: err instanceof Error ? err.message : String(err),
				}),
				isError: true,
			};
		}
	},
};
