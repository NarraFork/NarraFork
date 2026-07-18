import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

type TeamAction = "list" | "list_agents" | "list_bash" | "file_changes" | "broadcast" | "send";

function teamMemberType(variant: string | null | undefined): string {
	return variant?.startsWith("subagent:") ? variant.slice(9) : "primary";
}

/** Short preview used for a background bash task's title/command in list output. */
function bashLabel(title: string | null, command: string | null): string {
	const raw = title ?? command ?? "(no title)";
	return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

export const teamStatusTool: ToolDefinition = {
	name: "TeamStatus",
	description:
		"Query background agents and bash tasks in the current team/session, see which files " +
		"subagents modified, and send messages within the team.\n\n" +
		"Actions:\n" +
		'- "list": List background agents and background bash tasks (kind=agent|bash)\n' +
		'- "list_agents": List sibling subagents only\n' +
		'- "list_bash": List background bash tasks only\n' +
		'- "file_changes": Show files modified by each subagent (or a specific one via target_id)\n' +
		'- "broadcast": Send a message to ALL direct subagents\n' +
		'- "send": Send a message to a specific direct subagent (requires target_id)\n\n' +
		"Notes:\n" +
		"- The primary narrator is the team root; subagents use their parent's team scope.\n" +
		"- All actions are limited to the current narrator's direct subagent team.\n" +
		"- file_changes only tracks modifications made via Write and Edit tools; Bash changes are not tracked.",
	parameters: z.object({
		action: z
			.enum(["list", "list_agents", "list_bash", "file_changes", "broadcast", "send"])
			.describe("The action to perform"),
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
				enum: ["list", "list_agents", "list_bash", "file_changes", "broadcast", "send"],
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
			action: TeamAction;
			target_id?: string;
			message?: string;
		};

		// The primary narrator is the team root; a subagent shares its parent's team scope.
		const scopeId = ctx.parentNarratorId ?? ctx.narratorId;

		if (action === "list" || action === "list_agents" || action === "list_bash") {
			const { narratorService } = await import("@server/services/narrator-service");
			const { backgroundTaskService } = await import("@server/services/background-task-service");
			const siblings = await narratorService.listSubagentsByParent(scopeId);

			const wantAgents = action !== "list_bash";
			const wantBash = action !== "list_agents";

			const lines: string[] = [];
			if (wantAgents) {
				for (const s of siblings) {
					const isSelf = s.id === ctx.narratorId ? " (you)" : "";
					const sType = s.variant.startsWith("subagent:") ? s.variant.slice(9) : "unknown";
					lines.push(
						`- kind=agent | id=${s.id}${isSelf} | type=${sType} | status=${s.status} | title=${s.title ?? "(untitled)"}`,
					);
				}
			}
			if (wantBash) {
				const teamParentIds = [scopeId, ctx.narratorId, ...siblings.map((s) => s.id)];
				const summaries = await backgroundTaskService.listSummariesByParents(teamParentIds);
				for (const task of summaries) {
					if (task.type !== "bash") continue;
					const status = task.effectiveStatus ?? task.status;
					const alias = task.alias ? ` | alias=${task.alias}` : "";
					const cancel = task.canCancelActiveWork ? " | canCancel=true" : "";
					lines.push(
						`- kind=bash | id=${task.id}${alias} | status=${status}${cancel} | title=${bashLabel(task.title, task.command)}`,
					);
				}
			}

			if (lines.length === 0) {
				const scope =
					action === "list_agents"
						? "sibling subagents"
						: action === "list_bash"
							? "background bash tasks"
							: "background agents or bash tasks";
				return { output: `No ${scope} found.` };
			}
			const header =
				action === "list_agents"
					? `Sibling subagents (${lines.length}):`
					: action === "list_bash"
						? `Background bash tasks (${lines.length}):`
						: `Background tasks (${lines.length}):`;
			return { output: `${header}\n${lines.join("\n")}` };
		}

		// The remaining actions operate on the current narrator's direct subagent team.
		const parentNarratorId = scopeId;
		const { getTeamFileChanges, deliverTeamMessage } = await import(
			"@server/services/narrator-subagent"
		);
		type TeamMessage = import("@server/services/narrator-subagent").TeamMessage;

		switch (action) {
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
				const targets = siblings.filter(
					(s: { id: string; variant?: string | null }) =>
						s.id !== ctx.narratorId && s.variant?.startsWith("subagent:") === true,
				);
				if (targets.length === 0) {
					const targetKind = ctx.parentNarratorId ? "sibling subagents" : "child subagents";
					return { output: `No ${targetKind} to broadcast to.` };
				}
				const senderType = teamMemberType(sender.variant);
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
				const targetKind = ctx.parentNarratorId ? "sibling(s)" : "child subagent(s)";
				let output = `Broadcast sent to ${targets.length} ${targetKind}: ${targets.map((t: { id: string }) => t.id).join(", ")}`;
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
				// Validate target belongs to this narrator's direct subagent team
				const target = await narratorService.getById(target_id);
				if (
					!target.variant?.startsWith("subagent:") ||
					target.parentNarratorId !== parentNarratorId
				) {
					return {
						output: `${target_id} is not a direct subagent in this team.`,
						isError: true,
					};
				}
				const sendSenderType = teamMemberType(sender.variant);
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
