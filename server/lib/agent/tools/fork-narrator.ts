import { z } from "zod/v4";
import { getVisibleModels } from "../../settings";
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
		const { mode, message, title, inheritMode, model } = args as {
			mode: "fresh" | "fork";
			message: string;
			title?: string;
			inheritMode?: "full" | "compressed";
			model?: string;
		};

		try {
			const { narratorService } = await import("@server/services/narrator-service");
			const { sendMessage } = await import("@server/services/narrator-session");
			const { getToolMessageWithParams } = await import("@server/lib/prompt-i18n");
			const locale = (ctx.locale ?? "en") as import("@server/lib/prompt-i18n").Locale;

			const parent = await narratorService.getById(ctx.narratorId);

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
				const newChapter = await chapterFork.fork(parent.chapterId, {
					title,
					inheritMode: chapterInherit,
					locale,
				});

				// Find the new chapter's primary narrator
				const newNarrator = await db.query.narrators.findFirst({
					where: and(eq(narrators.chapterId, newChapter.id), eq(narrators.type, "primary")),
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
					model,
					locale: ctx.locale,
				});

				newNarratorId = newNarrator.id;
				newTitle = newNarrator.title ?? title ?? "Forked narrator";
			}

			// Fire-and-forget: send the initial message to the new narrator
			const { logger } = await import("@server/lib/logger");
			sendMessage(newNarratorId, message, undefined, locale).catch((err) => {
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
