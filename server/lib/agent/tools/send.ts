import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const sendTool: ToolDefinition = {
	name: "Send",
	description:
		"Send a message to one or more accessible subagents or fellow chat-group members. " +
		"Primary narrators may send to their child subagents; subagents may send to sibling subagents. " +
		'Subagents may also report progress to the narrator that launched them via the reserved target "parent" (or "main"), e.g. Send({ id: "parent", message: "..." }). ' +
		"If you are a named narrator in a chat group, you may send to fellow group members by their @handle, id, or name. " +
		"Use Send for new information, changed requirements, or concrete corrections—not for routine " +
		"status checks after an Await timeout. Repeated messages can distract a working subagent. " +
		"Set doInterrupt=true only when the current work must stop immediately; never use it merely " +
		"because a short wait timed out or you are impatient. " +
		"Set await=true to explicitly request and wait for each target to call Send back. This waits " +
		"for a message reply, not for the target task to finish; use Await to wait for completion.",
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
		replyTo: z
			.string()
			.optional()
			.describe("Request ID from a prior Send(await=true) that this message explicitly answers."),
		doInterrupt: z
			.boolean()
			.optional()
			.describe(
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
					"for an urgent correction that requires stopping current work, never for status polling.",
			),
		await: z
			.boolean()
			.optional()
			.describe(
				"Explicitly request and wait for target(s) to call Send back. Does not wait for task completion.",
			),
		timeout: z
			.number()
			.optional()
			.describe(
				"When await=true, how long to wait for Send replies. Defaults to 60000 milliseconds.",
			),
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
			replyTo: {
				description: "Request ID from a prior Send(await=true) that this message answers.",
				type: "string",
			},
			doInterrupt: {
				description:
					"Interrupt an active foreground child subagent after queuing the message. Use only " +
					"for an urgent correction that requires stopping current work, never for status polling.",
				type: "boolean",
			},
			await: {
				description:
					"Explicitly request and wait for target(s) to call Send back. Does not wait for task completion.",
				type: "boolean",
			},
			timeout: {
				description:
					"When await=true, how long to wait for Send replies. Defaults to 60000 milliseconds.",
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
			replyTo?: string;
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
				replyTo: raw.replyTo,
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
