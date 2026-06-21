import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const groupControlTool: ToolDefinition = {
	name: "GroupControl",
	description:
		"Control fellow narrators in your chat groups (named-narrator full control). " +
		"Use this to oversee and drive the work of narrators you share a group with.\n\n" +
		"Actions:\n" +
		'- "members": List your chat-group members with their live status and any pending permission requests\n' +
		'- "approve": Approve a target narrator\'s pending permission request (requires request_id)\n' +
		'- "deny": Deny a pending permission request (requires request_id; optional message as feedback)\n' +
		'- "interrupt": Interrupt a target narrator\'s current turn (requires target_id)\n\n' +
		"You may only control narrators that are members of a chat group where you have control rights. " +
		"All approvals/denials are recorded as decided by you.",
	parameters: z.object({
		action: z.enum(["members", "approve", "deny", "interrupt"]).describe("The action to perform"),
		target_id: z.string().optional().describe("Target narrator ID (required for 'interrupt')"),
		request_id: z
			.string()
			.optional()
			.describe("Pending permission request ID (required for 'approve' and 'deny')"),
		message: z.string().optional().describe("Optional feedback message for 'deny'"),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				description: "The action to perform",
				type: "string",
				enum: ["members", "approve", "deny", "interrupt"],
			},
			target_id: { description: "Target narrator ID (required for 'interrupt')", type: "string" },
			request_id: {
				description: "Pending permission request ID (required for 'approve' and 'deny')",
				type: "string",
			},
			message: { description: "Optional feedback message for 'deny'", type: "string" },
		},
		required: ["action"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { action, target_id, request_id, message } = args as {
			action: "members" | "approve" | "deny" | "interrupt";
			target_id?: string;
			request_id?: string;
			message?: string;
		};

		switch (action) {
			case "members": {
				const { chatGroupService } = await import("@server/services/chat-group-service");
				const { narratorService } = await import("@server/services/narrator-service");
				const groups = await chatGroupService.listGroupsForNarrator(ctx.narratorId);
				if (groups.length === 0) {
					return { output: "You are not a member of any chat group." };
				}
				const sections: string[] = [];
				for (const group of groups) {
					const members = await chatGroupService.listNarratorMembers(group.id);
					const lines: string[] = [];
					for (const m of members) {
						const nId = m.narratorId as string;
						const isSelf = nId === ctx.narratorId;
						const n = await narratorService.getById(nId).catch(() => null);
						if (!n) continue;
						const label = n.handle ? `@${n.handle}` : (n.title ?? nId.slice(0, 8));
						const selfTag = isSelf ? " (you)" : "";
						let pendingInfo = "";
						if (!isSelf) {
							const pending = await narratorService.getPendingPermissions(nId);
							if (pending.length > 0) {
								pendingInfo = `\n    pending permissions:\n${pending
									.map(
										(p: { id: string; toolName: string }) =>
											`      - request_id=${p.id} tool=${p.toolName}`,
									)
									.join("\n")}`;
							}
						}
						lines.push(
							`  - ${label}${selfTag} | id=${nId} | status=${n.status} | control=${m.canControl}${pendingInfo}`,
						);
					}
					sections.push(`Group "${group.title || "untitled"}" (${group.id}):\n${lines.join("\n")}`);
				}
				return { output: sections.join("\n\n") };
			}

			case "approve":
			case "deny": {
				if (!request_id) {
					return { output: `request_id is required for '${action}'.`, isError: true };
				}
				const { resolvePermissionAsNarrator } = await import(
					"@server/services/narrator-permission"
				);
				const result = await resolvePermissionAsNarrator(
					request_id,
					ctx.narratorId,
					action === "approve" ? "allow" : "deny",
					action === "deny" ? { denyMessage: message } : {},
				);
				if (!result.ok) {
					return { output: result.reason ?? "Failed to resolve permission.", isError: true };
				}
				return {
					output: `Permission request ${request_id} ${action === "approve" ? "approved" : "denied"}.`,
					metadata: { kind: "group_control", action, requestId: request_id },
				};
			}

			case "interrupt": {
				if (!target_id) {
					return { output: "target_id is required for 'interrupt'.", isError: true };
				}
				const { chatGroupService } = await import("@server/services/chat-group-service");
				const authorized = await chatGroupService.canControlNarrator(ctx.narratorId, target_id);
				if (!authorized) {
					return {
						output:
							"Not authorized: you can only interrupt narrators in a chat group where you have control rights.",
						isError: true,
					};
				}
				const { interruptNarrator } = await import("@server/services/narrator-session");
				const interrupted = interruptNarrator(target_id);
				return {
					output: interrupted
						? `Interrupted narrator ${target_id}.`
						: `Narrator ${target_id} was not actively running.`,
					metadata: { kind: "group_control", action, targetId: target_id },
				};
			}

			default:
				return { output: `Unknown action: ${action}`, isError: true };
		}
	},
};
