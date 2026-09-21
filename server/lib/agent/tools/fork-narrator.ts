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
			title: z
				.string()
				.optional()
				.describe("Title for the new narrator (and chapter, if chapter-bound)"),
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
					'Chapter-bound only. "workspace" includes uncommitted files; "commit" uses committed history only. Independent of mode/inheritMode.',
				),
			commitSha: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Chapter-bound only. Fork from this commit in the parent branch history; requires worktreeSource="commit".',
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
					description: "Title for the new narrator (and chapter, if chapter-bound)",
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
						'Chapter-bound only. "workspace" includes uncommitted files; "commit" uses committed history only. Independent of mode/inheritMode.',
					type: "string",
					enum: [...FORK_WORKTREE_SOURCES],
				},
				commitSha: {
					description:
						'Chapter-bound only. Fork from this commit in the parent branch history; requires worktreeSource="commit".',
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

		try {
			const { narratorService } = await import("@server/services/narrator-service");
			const { sendMessage } = await import("@server/services/narrator-session");
			const { getToolMessageWithParams } = await import("@server/lib/prompt-i18n");
			const locale = (ctx.locale ?? "en") as import("@server/lib/prompt-i18n").Locale;

			const parent = await narratorService.getById(ctx.narratorId);

			// Refuse before creating anything. A forked narrator holds this same tool and
			// its first message is written by the AI that forked it, so nothing else stops
			// a chain — and every hop is a git worktree plus a running loop, not a row.
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

			let newNarratorId: string;
			let newTitle: string;
			let chapterInfo = "";

			if (parent.chapterId) {
				// Chapter-bound: fork via chapter fork
				const { chapterFork } = await import("@server/services/chapter-fork");
				const { db } = await import("@server/db");
				const { narrators } = await import("@server/db/schema");
				const { and, eq } = await import("drizzle-orm");

				const chapterInherit = mode === "fresh" ? "fresh" : (inheritMode ?? "full");

				// In "fork" mode, resolve the latest message UUID so that
				// chapterFork can restore uncommitted file changes via
				// file-state-rebuild, keeping worktree ↔ message history consistent.
				let forkAtMessageUuid: string | undefined;
				if (mode === "fork") {
					forkAtMessageUuid =
						(await narratorService.getLatestMessageUuid(ctx.narratorId)) ?? undefined;
				}

				const newChapter = await chapterFork.fork(parent.chapterId, {
					title,
					inheritMode: chapterInherit,
					userId: ctx.userId ?? null,
					worktreeSource,
					startCommitSha: commitSha,
					forkAtMessageUuid: commitSha ? undefined : forkAtMessageUuid,
					locale,
				});

				// Find the new chapter's primary narrator
				const newNarrator = await db.query.narrators.findFirst({
					where: and(eq(narrators.chapterId, newChapter.id), eq(narrators.variant, "primary")),
				});
				if (!newNarrator) {
					return {
						output: "Internal error: chapter fork did not create a narrator",
						isError: true,
					};
				}

				newNarratorId = newNarrator.id;
				newTitle = newChapter.title ?? title ?? "Forked narrator";

				// Override model if specified
				if (model) {
					await db
						.update(narrators)
						.set({ model, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, newNarratorId));
				}

				chapterInfo = getToolMessageWithParams("forkNarratorChapterInfo", locale, {
					chapterId: newChapter.id,
					chapterTitle: newChapter.title ?? "",
				});
			} else {
				// Standalone narrator
				const newNarrator = await narratorService.forkStandaloneFromTool(ctx.narratorId, mode, {
					title,
					inheritMode,
					userId: ctx.userId ?? null,
					model,
					locale: ctx.locale,
				});

				newNarratorId = newNarrator.id;
				newTitle = newNarrator.title ?? title ?? "Forked narrator";
			}

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
					chapterInfo,
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
