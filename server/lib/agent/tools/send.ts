import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const sendTool: ToolDefinition = {
	name: "Send",
	description:
		"Send a message to one or more accessible subagents or fellow chat-group members. " +
		"Primary narrators may send to their child subagents; subagents may send to sibling subagents. " +
		'Subagents may also report progress to the narrator that launched them via the reserved target "parent" (or "main"), e.g. Send({ id: "parent", message: "..." }). ' +
		"If you are a named narrator in a chat group, you may send to fellow group members by their @handle, id, or name. " +
		"Set doInterrupt=true to interrupt an active foreground child subagent; this is only allowed from a primary narrator to its own child subagent. " +
		"Set await=true to wait for the target subagent's response (not supported for the parent target).",
	parameters: z.object({
		id: z
			.string()
			.optional()
			.describe(
				'Target subagent ID or alias. Subagents may use "parent" to reach their parent narrator.',
			),
		ids: z.array(z.string()).optional().describe("Target subagent IDs or aliases."),
		name: z.string().optional().describe("Target subagent title, alias, or unique ID prefix."),
		names: z
			.array(z.string())
			.optional()
			.describe("Target subagent titles, aliases, or unique ID prefixes."),
		message: z.string().describe("Message to send to the target subagent(s)."),
		doInterrupt: z
			.boolean()
			.optional()
			.describe("Interrupt an active foreground child subagent after queuing the message."),
		await: z
			.boolean()
			.optional()
			.describe("Wait for target subagent response(s) before returning."),
		timeout: z
			.number()
			.optional()
			.describe("When await=true, how long to wait in milliseconds before returning."),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			id: {
				description:
					'Target subagent ID or alias. Subagents may use "parent" to reach their parent narrator.',
				type: "string",
			},
			ids: {
				description: "Target subagent IDs or aliases.",
				type: "array",
				items: { type: "string" },
			},
			name: {
				description: "Target subagent title, alias, or unique ID prefix.",
				type: "string",
			},
			names: {
				description: "Target subagent titles, aliases, or unique ID prefixes.",
				type: "array",
				items: { type: "string" },
			},
			message: { description: "Message to send to the target subagent(s).", type: "string" },
			doInterrupt: {
				description: "Interrupt an active foreground child subagent after queuing the message.",
				type: "boolean",
			},
			await: {
				description: "Wait for target subagent response(s) before returning.",
				type: "boolean",
			},
			timeout: {
				description: "When await=true, how long to wait in milliseconds before returning.",
				type: "number",
			},
		},
		required: ["message"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			id?: string;
			ids?: string[];
			name?: string;
			names?: string[];
			message?: string;
			doInterrupt?: boolean;
			await?: boolean;
			timeout?: number;
		};
		if (!raw.message?.trim()) {
			return { output: "Error: message is required.", isError: true };
		}
		if (!ctx.currentToolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}

		try {
			const { sendSubagentMessageDetailed } = await import("@server/services/agent-communication");
			const result = await sendSubagentMessageDetailed({
				callerNarratorId: ctx.narratorId,
				id: raw.id,
				ids: raw.ids,
				name: raw.name,
				names: raw.names,
				message: raw.message,
				doInterrupt: raw.doInterrupt,
				shouldAwait: raw.await,
				timeoutMs: raw.timeout,
				toolUseId: ctx.currentToolUseId,
				signal: ctx.signal,
				locale: ctx.locale,
			});
			return {
				output: result.output,
				metadata: {
					kind: "send",
					targets: result.targets,
					doInterrupt: raw.doInterrupt ?? false,
					await: raw.await ?? false,
				},
			};
		} catch (err) {
			return {
				output: `Send error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
