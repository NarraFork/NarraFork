import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const teamStatusTool: ToolDefinition = {
	name: "TeamStatus",
	description:
		"Query the status of sibling subagents in the same team, see which files they modified, " +
		"and send messages to them.\n\n" +
		"Actions:\n" +
		'- "list": List all sibling subagents (ID, type, status, title)\n' +
		'- "file_changes": Show files modified by each team member (or a specific one via target_id)\n' +
		'- "broadcast": Send a message to ALL sibling subagents\n' +
		'- "send": Send a message to a specific sibling subagent (requires target_id)\n\n' +
		"Note: file_changes only tracks modifications made via Write and Edit tools. " +
		"Changes made through Bash commands (e.g. mv, cp, rm) are not tracked.\n\n" +
		"This tool is only available to subagents. It returns an error for primary narrators.",
	parameters: z.object({
		action: z.enum(["list", "file_changes", "broadcast", "send"]).describe("The action to perform"),
		target_id: z
			.string()
			.optional()
			.describe("Target subagent ID (required for 'send', optional for 'file_changes')"),
		message: z.string().optional().describe("Message text (required for 'broadcast' and 'send')"),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				description: "The action to perform",
				type: "string",
				enum: ["list", "file_changes", "broadcast", "send"],
			},
			target_id: {
				description: "Target subagent ID (required for 'send', optional for 'file_changes')",
				type: "string",
			},
			message: {
				description: "Message text (required for 'broadcast' and 'send')",
				type: "string",
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { action, target_id, message } = args as {
			action: "list" | "file_changes" | "broadcast" | "send";
			target_id?: string;
			message?: string;
		};

		if (!ctx.parentNarratorId) {
			return {
				output: "TeamStatus is only available to subagents.",
				isError: true,
			};
		}

		const { getTeamFileChanges, deliverTeamMessage } = await import(
			"@server/services/narrator-subagent"
		);
		type TeamMessage = import("@server/services/narrator-subagent").TeamMessage;

		const parentNarratorId = ctx.parentNarratorId;

		switch (action) {
			case "list": {
				const { narratorService } = await import("@server/services/narrator-service");
				const siblings = await narratorService.listSubagentsByParent(parentNarratorId);
				if (siblings.length === 0) {
					return { output: "No sibling subagents found." };
				}
				const lines = siblings.map(
					(s: { id: string; variant: string; status: string; title: string | null }) => {
						const isSelf = s.id === ctx.narratorId ? " (you)" : "";
						const sType = s.variant.startsWith("subagent:") ? s.variant.slice(9) : "unknown";
						return `- ${s.id}${isSelf} | type=${sType} | status=${s.status} | title=${s.title ?? "(untitled)"}`;
					},
				);
				return { output: `Team members (${siblings.length}):\n${lines.join("\n")}` };
			}

			case "file_changes": {
				const changes = getTeamFileChanges(parentNarratorId);
				if (changes.size === 0) {
					return { output: "No file changes recorded by any team member." };
				}
				if (target_id) {
					const files = changes.get(target_id);
					if (!files?.size) {
						return { output: `No file changes recorded for ${target_id}.` };
					}
					return {
						output: `Files modified by ${target_id} (${files.size}):\n${[...files].join("\n")}`,
					};
				}
				const sections: string[] = [];
				for (const [subId, files] of changes) {
					const isSelf = subId === ctx.narratorId ? " (you)" : "";
					sections.push(
						`${subId}${isSelf} (${files.size} files):\n${[...files].map((f) => `  ${f}`).join("\n")}`,
					);
				}
				return { output: sections.join("\n\n") };
			}

			case "broadcast": {
				if (!message) {
					return { output: "Message text is required for broadcast.", isError: true };
				}
				const { narratorService } = await import("@server/services/narrator-service");
				const sender = await narratorService.getById(ctx.narratorId);
				const siblings = await narratorService.listSubagentsByParent(parentNarratorId);
				const targets = siblings.filter((s: { id: string }) => s.id !== ctx.narratorId);
				if (targets.length === 0) {
					return { output: "No sibling subagents to broadcast to." };
				}
				const senderType = sender.variant?.startsWith("subagent:")
					? sender.variant.slice(9)
					: "unknown";
				const now = new Date().toISOString();
				const msg: TeamMessage = {
					fromId: ctx.narratorId,
					fromTitle: sender.title,
					fromType: senderType,
					text: message,
					timestamp: now,
					isBroadcast: true,
				};
				for (const target of targets) {
					deliverTeamMessage(target.id, msg, parentNarratorId);
				}
				const nonWorking = targets.filter(
					(t: { id: string; status: string }) => t.status !== "working",
				);
				let output = `Broadcast sent to ${targets.length} sibling(s): ${targets.map((t: { id: string }) => t.id).join(", ")}`;
				if (nonWorking.length > 0) {
					output += `\n(warning: ${nonWorking.length} target(s) not currently working — messages may not be received)`;
				}
				return { output };
			}

			case "send": {
				if (!target_id) {
					return { output: "target_id is required for 'send' action.", isError: true };
				}
				if (!message) {
					return { output: "Message text is required for 'send' action.", isError: true };
				}
				const { narratorService } = await import("@server/services/narrator-service");
				const sender = await narratorService.getById(ctx.narratorId);
				// Validate target is a sibling
				const target = await narratorService.getById(target_id);
				if (target.parentNarratorId !== parentNarratorId) {
					return {
						output: `${target_id} is not a sibling subagent.`,
						isError: true,
					};
				}
				const sendSenderType = sender.variant?.startsWith("subagent:")
					? sender.variant.slice(9)
					: "unknown";
				const now = new Date().toISOString();
				const msg: TeamMessage = {
					fromId: ctx.narratorId,
					fromTitle: sender.title,
					fromType: sendSenderType,
					text: message,
					timestamp: now,
					isBroadcast: false,
				};
				deliverTeamMessage(target_id, msg, parentNarratorId);
				const warning =
					target.status !== "working"
						? ` (warning: target is ${target.status}, message may not be received)`
						: "";
				return { output: `Message sent to ${target_id}.${warning}` };
			}

			default:
				return { output: `Unknown action: ${action}`, isError: true };
		}
	},
};
