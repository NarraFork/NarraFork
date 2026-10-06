import { QUESTION_NOTE_MAX_BYTES } from "@shared/question-protocol";
import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

/** Lifecycle management is independent of the capability to create new questions. */
export const questionTool: ToolDefinition = {
	name: "Question",
	description:
		"Manage your own persistent questions after compact: action=get returns the bounded original snapshot, full previews and paginated user events; list returns summaries (open/pending/history/all); resolve confirms handling of the latest answerMessageId with a non-empty explanation (2KiB); withdraw ends open questions with a reason. Cannot create questions or access another narrator's items.",
	parameters: z.object({
		action: z.enum(["get", "list", "resolve", "withdraw"]),
		id: z.string().min(1).max(200).optional(),
		ids: z.array(z.string().min(1).max(200)).max(100).optional(),
		filter: z.enum(["open", "pending", "history", "all"]).optional(),
		cursor: z.string().max(2048).optional(),
		limit: z.number().int().min(1).max(32).optional(),
		answerMessageId: z.string().min(1).max(200).optional(),
		note: z.string().max(QUESTION_NOTE_MAX_BYTES).optional(),
		reason: z.string().max(QUESTION_NOTE_MAX_BYTES).optional(),
	}),
	async execute(args, ctx) {
		try {
			const input = args as {
				action: string;
				id?: string;
				ids?: string[];
				filter?: "open" | "pending" | "history" | "all";
				cursor?: string;
				limit?: number;
				answerMessageId?: string;
				note?: string;
				reason?: string;
			};
			const service = await import("@server/services/narrator-question-service");
			let result: unknown;
			switch (input.action) {
				case "get":
					if (!input.id) throw new Error("get requires id.");
					result = await service.getBoundedQuestionDetail(input.id, {
						narratorId: ctx.narratorId,
						cursor: input.cursor,
						limit: input.limit,
					});
					break;
				case "list":
					result = await service.listQuestionSummaries({
						narratorId: ctx.narratorId,
						filter: input.filter ?? "all",
						cursor: input.cursor,
						limit: input.limit,
					});
					break;
				case "resolve":
					if (!input.id || !input.answerMessageId || !input.note)
						throw new Error("resolve requires id, answerMessageId and note.");
					result = await service.resolveAsyncQuestion({
						id: input.id,
						narratorId: ctx.narratorId,
						answerMessageId: input.answerMessageId,
						note: input.note,
					});
					break;
				case "withdraw":
					if (!input.reason?.trim()) throw new Error("withdraw requires a non-empty reason.");
					result = await service.withdrawAsyncQuestions(
						ctx.narratorId,
						input.ids ?? (input.id ? [input.id] : []),
						input.reason,
					);
					break;
				default:
					throw new Error("Unknown Question action.");
			}
			return { output: JSON.stringify(result) };
		} catch (error) {
			return {
				output: `Question error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	},
};
