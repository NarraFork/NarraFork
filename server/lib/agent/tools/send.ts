import { z } from "zod/v4";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const properties: Record<string, unknown> = {
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
			description:
				"Request ID from a prior allowed Send(await=true) that this asynchronous message answers; subagents may reply but must not wait.",
			type: "string",
		},
		doInterrupt: {
			description:
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
				"for an urgent correction that requires stopping current work, never for status polling.",
			type: "boolean",
		},
	};

	// The model-facing schema omits reply-wait parameters for subagents. The Zod
	// schema remains permissive for post-resolution validation and legacy inputs;
	// the service layer is the authoritative runtime guard.
	if (!config?.parentNarratorId) {
		properties.await = {
			description:
				"Primary-narrator-only option: request and wait for target(s) to call Send back. Subagents must omit this or set it false; it does not wait for task completion.",
			type: "boolean",
		};
		properties.timeout = {
			description:
				"For primary-narrator await requests only: how long to wait for Send replies. Defaults to 60000 milliseconds.",
			type: "number",
		};
	}

	return {
		type: "object",
		properties,
		required: ["message"],
		additionalProperties: false,
	};
}

export const sendTool: ToolDefinition = {
	name: "Send",
	description:
		"Send a message to one or more accessible subagents. " +
		"Primary narrators may send to their child subagents; subagents may send to sibling subagents. " +
		'Subagents may also report progress to the narrator that launched them via the reserved target "parent" (or "main"), e.g. Send({ id: "parent", message: "..." }). ' +
		"Use Send for new information, changed requirements, or concrete corrections—not for routine " +
		"status checks after an Await timeout. Repeated messages can distract a working subagent. " +
		"Set doInterrupt=true only when the current work must stop immediately; never use it merely " +
		"because a short wait timed out or you are impatient. " +
		"Primary narrators may set await=true to request a direct Send reply. Subagents must always " +
		"use asynchronous Send and their await=true requests are rejected; use a later Send message " +
		"to report back instead. Await is for task completion where allowed.",
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
			.describe(
				"Request ID from a prior allowed Send(await=true) that this asynchronous message explicitly answers. Subagents may use replyTo to reply, but must not wait.",
			),
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
				"Primary-narrator-only option: request and wait for target(s) to call Send back. Subagents must omit this or set it false; it does not wait for task completion.",
			),
		timeout: looseNumber(
			"For primary-narrator await requests only: how long to wait for Send replies. Defaults to 60000 milliseconds.",
		),
	}),
	get rawJsonSchema() {
		return buildRawJsonSchema();
	},
	getRawJsonSchema(config?: AgentConfig) {
		return buildRawJsonSchema(config);
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

		const toolUseId = ctx.currentToolUseId;
		const deliveryTargets = new Map<string, { id: string; deliveryMessageId: string }>();
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
				timeoutMs: normalizeNumber(raw.timeout, { min: 1 }),
				toolUseId: ctx.currentToolUseId,
				toolCallBinding: ctx.toolCallBinding,
				signal: ctx.signal,
				locale: ctx.locale,
				userId: ctx.userId ?? null,
				onDeliveryResolved: (target) => {
					deliveryTargets.set(target.id, { ...target });
					const snapshot = [...deliveryTargets.values()];
					void import("@server/services/send-delivery-resolution")
						.then(({ broadcastSendDeliveryResolved }) =>
							broadcastSendDeliveryResolved(
								ctx.narratorId,
								toolUseId,
								snapshot,
								ctx.toolCallBinding,
							),
						)
						.catch(() => {});
				},
				onTargetResolved: (targetId) => {
					// Only primaries can wait. Reuse Await's navigation-only event; never
					// manufacture a result while Send is still awaiting a reply.
					if (raw.await !== true) return;
					void import("@server/services/await-agent-resolution")
						.then(async ({ singleSendSelector }) => {
							if (!singleSendSelector(raw)) return;
							const { broadcastAwaitAgentResolved } = await import("./await");
							await broadcastAwaitAgentResolved(ctx.narratorId, toolUseId, targetId);
						})
						.catch(() => {});
				},
			});
			return {
				output: result.output,
				metadata: {
					kind: "send",
					// Each entry carries both the real id (for the card's session link)
					// and a readable label (for what the reader actually sees).
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
