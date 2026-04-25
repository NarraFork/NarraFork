import { z } from "zod/v4";
import { logger } from "../../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * ApprovePermission — Overseer tool to approve a pending permission request.
 * Only available to narrators that are bound to an overseer.
 */
export const approvePermissionTool: ToolDefinition = {
	name: "ApprovePermission",
	description:
		"Approve a pending permission request from a managed Narrator. " +
		"Use this when you've reviewed the tool call and determined it is safe and appropriate.",
	parameters: z.object({
		requestId: z.string().describe("The permission request ID (tool call ID) to approve."),
		feedbackText: z
			.string()
			.optional()
			.describe(
				"RARELY USED. Supplementary message injected into the Narrator's conversation as a user message. " +
					"Only provide this when you need to convey critical corrections, warnings, or context that the Narrator is clearly missing. " +
					"Do NOT use this for routine approvals — it interrupts the Narrator's flow and pollutes its context.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { requestId, feedbackText } = args as {
			requestId: string;
			feedbackText?: string;
		};
		const locale = (ctx.locale ?? "en") as Locale;

		try {
			const { resolvePermission } = await import("../../../services/narrator-session");
			const { db } = await import("../../../db");
			const { narratorToolCalls, overseers } = await import("../../../db/schema");
			const { eq } = await import("drizzle-orm");

			// Verify this narrator is an overseer
			const overseer = await db.query.overseers.findFirst({
				where: eq(overseers.narratorId, ctx.narratorId),
			});
			if (!overseer) {
				return {
					output: getToolMessage("overseerNotAnOverseer", locale),
					isError: true,
				};
			}

			const resolved = await resolvePermission(requestId, "allow", {
				feedbackText,
			});

			if (!resolved) {
				return {
					output: getToolMessageWithParams("overseerPermissionAlreadyResolved", locale, {
						requestId,
					}),
				};
			}

			// Record the overseer's narrator ID on the tool call
			await db
				.update(narratorToolCalls)
				.set({
					permissionDecidedBy: "overseer",
					permissionOverseerNarratorId: ctx.narratorId,
				})
				.where(eq(narratorToolCalls.id, requestId));

			const { eventBus } = await import("../../event-bus");
			eventBus.emit({
				type: "overseer:decision_made",
				overseerId: overseer.id,
				narratorId: ctx.narratorId,
				requestId,
				decision: "allow",
			});

			return {
				output: getToolMessageWithParams("overseerPermissionApproved", locale, {
					requestId,
					feedback: feedbackText ? ` Feedback: ${feedbackText}` : "",
				}),
			};
		} catch (err) {
			logger.error("ApprovePermission failed", {
				requestId,
				error: String(err),
			});
			return {
				output: `Failed to approve permission: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

/**
 * DenyPermission — Overseer tool to deny a pending permission request.
 */
export const denyPermissionTool: ToolDefinition = {
	name: "DenyPermission",
	description:
		"Deny a pending permission request from a managed Narrator. " +
		"Use this when you've reviewed the tool call and determined it is unsafe or inappropriate.",
	parameters: z.object({
		requestId: z.string().describe("The permission request ID (tool call ID) to deny."),
		denyMessage: z
			.string()
			.optional()
			.describe("Reason for denying the permission. This will be shown to the Narrator."),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { requestId, denyMessage } = args as {
			requestId: string;
			denyMessage?: string;
		};
		const locale = (ctx.locale ?? "en") as Locale;

		try {
			const { resolvePermission } = await import("../../../services/narrator-session");
			const { db } = await import("../../../db");
			const { narratorToolCalls, overseers } = await import("../../../db/schema");
			const { eq } = await import("drizzle-orm");

			// Verify this narrator is an overseer
			const overseer = await db.query.overseers.findFirst({
				where: eq(overseers.narratorId, ctx.narratorId),
			});
			if (!overseer) {
				return {
					output: getToolMessage("overseerNotAnOverseer", locale),
					isError: true,
				};
			}

			const resolved = await resolvePermission(requestId, "deny", {
				denyMessage: denyMessage ?? getToolMessage("overseerDefaultDenyMessage", locale),
			});

			if (!resolved) {
				return {
					output: getToolMessageWithParams("overseerPermissionAlreadyResolved", locale, {
						requestId,
					}),
				};
			}

			// Record the overseer's narrator ID on the tool call
			await db
				.update(narratorToolCalls)
				.set({
					permissionDecidedBy: "overseer",
					permissionOverseerNarratorId: ctx.narratorId,
				})
				.where(eq(narratorToolCalls.id, requestId));

			const { eventBus } = await import("../../event-bus");
			eventBus.emit({
				type: "overseer:decision_made",
				overseerId: overseer.id,
				narratorId: ctx.narratorId,
				requestId,
				decision: "deny",
			});

			return {
				output: getToolMessageWithParams("overseerPermissionDenied", locale, {
					requestId,
					reason: denyMessage ? ` Reason: ${denyMessage}` : "",
				}),
			};
		} catch (err) {
			logger.error("DenyPermission failed", {
				requestId,
				error: String(err),
			});
			return {
				output: `Failed to deny permission: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

/**
 * ListManagedNarrators — Overseer tool to list narrators under its jurisdiction.
 */
export const listManagedNarratorsTool: ToolDefinition = {
	name: "ListManagedNarrators",
	description:
		"List all Narrators under this Overseer's jurisdiction, including their current status.",
	parameters: z.object({}),
	async execute(_args, ctx): Promise<ToolResult> {
		const locale = (ctx.locale ?? "en") as Locale;
		try {
			const { db } = await import("../../../db");
			const { overseers } = await import("../../../db/schema");
			const { eq } = await import("drizzle-orm");
			const { listManagedNarrators } = await import("../../../services/overseer-service");

			const overseer = await db.query.overseers.findFirst({
				where: eq(overseers.narratorId, ctx.narratorId),
			});
			if (!overseer) {
				return {
					output: getToolMessage("overseerNotAnOverseer", locale),
					isError: true,
				};
			}

			const managed = await listManagedNarrators(overseer.id);

			if (managed.length === 0) {
				return { output: getToolMessage("overseerNoManagedNarrators", locale) };
			}

			const lines = managed.map(
				(n) =>
					`- ${n.title ?? "Untitled"} (id: ${n.id}, status: ${n.status}, chapter: ${n.chapterId ?? "standalone"})`,
			);
			const header = getToolMessageWithParams("overseerManagedNarratorsHeader", locale, {
				count: managed.length,
			});
			return {
				output: `${header}\n${lines.join("\n")}`,
			};
		} catch (err) {
			return {
				output: `Failed to list managed narrators: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

/**
 * GetNarratorContext — Overseer tool to read recent messages from a managed narrator.
 */
export const getNarratorContextTool: ToolDefinition = {
	name: "GetNarratorContext",
	description:
		"Get the recent conversation context of a managed Narrator. " +
		"Useful for understanding what the Narrator is working on before making a permission decision.",
	parameters: z.object({
		narratorId: z.string().describe("The ID of the narrator to inspect."),
		messageCount: z
			.number()
			.optional()
			.describe("Number of recent messages to retrieve (default: 5, max: 20)."),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { narratorId, messageCount: rawCount } = args as {
			narratorId: string;
			messageCount?: number;
		};
		// Coerce to integer, clamp to [1, 20], default 5
		const messageCount = rawCount != null ? Math.max(1, Math.min(20, Math.round(rawCount))) : 5;
		const locale = (ctx.locale ?? "en") as Locale;

		try {
			const { db } = await import("../../../db");
			const { narratorMessageRefs, overseers } = await import("../../../db/schema");
			const { eq } = await import("drizzle-orm");

			// Verify this narrator is an overseer
			const overseer = await db.query.overseers.findFirst({
				where: eq(overseers.narratorId, ctx.narratorId),
			});
			if (!overseer) {
				return {
					output: getToolMessage("overseerNotAnOverseer", locale),
					isError: true,
				};
			}

			// Get recent top-level messages via refs
			const refs = await db.query.narratorMessageRefs.findMany({
				where: eq(narratorMessageRefs.narratorId, narratorId),
				orderBy: (r, { desc }) => [desc(r.seq)],
				limit: messageCount,
				with: {
					message: {
						columns: {
							role: true,
							contentText: true,
							createdAt: true,
						},
					},
				},
			});

			if (refs.length === 0) {
				return { output: getToolMessage("overseerNoMessages", locale) };
			}

			// Reverse to chronological order
			const messages = refs.reverse().map((r) => r.message);
			const lines = messages.map(
				(m) => `[${m.role}] ${m.contentText?.slice(0, 500) ?? "(no text)"}`,
			);

			const header = getToolMessageWithParams("overseerRecentMessagesHeader", locale, {
				narratorId,
				count: messages.length,
			});
			return {
				output: `${header}\n\n${lines.join("\n\n")}`,
			};
		} catch (err) {
			return {
				output: `Failed to get narrator context: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
