import { runtimePolicyForContext } from "@server/services/agent-runtime/policy";
import { cleanAssistantText } from "@shared/citations";
import { z } from "zod/v4";
import type { AgentConfig, ToolContext, ToolDefinition, ToolResult } from "../types";

/**
 * Offered to bot narrators only (see `buildRawJsonSchema`). The bot protocol itself is
 * in the bot's system prompt; this says what the field does when the model reaches it.
 */
const USER_TARGET_DESCRIPTION =
	"Bot only — your voice to people: the username of the person to message (the name in " +
	"their sender marker). Delivers `message` into your chat with them, the only text of yours " +
	"they ever see (Markdown renders, up to 32,000 characters). Use it alone: no agent " +
	"targets, replyTo, doInterrupt, resume or model.";

const RESUME_DESCRIPTION =
	"Direct child subagents only: restart a target whose last turn ended with an error. Agent " +
	"messages alone never restart such a subagent (Send then reports status `blocked` and the " +
	"message stays queued); set resume=true to deliver this message and start it again. " +
	"It cannot override a stop the user made.";

const MODEL_DESCRIPTION =
	"Direct child subagents only: switch each target's model before delivering this message " +
	'(use "parent" to follow your own model again). Subject to the same allowed subagent model ' +
	"pool as the Agent call; a running subagent switches at its next model request. Combine with " +
	"resume=true to retry a subagent that failed on its previous model.";

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		id: {
			description:
				'Target subagent ID or alias. Subagents may use "parent" to reach their parent narrator.',
			type: "string",
		},
		ids: {
			description:
				"Target IDs or aliases. Subagents may mix parent/main with sibling targets for ordinary asynchronous messages.",
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
			description:
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
				"for an urgent correction that requires stopping current work, never for status polling.",
			type: "boolean",
		},
	};

	const policy = runtimePolicyForContext(config);
	if (policy.capabilities.spawnAgent) {
		properties.resume = { description: RESUME_DESCRIPTION, type: "boolean" };
		properties.model = { description: MODEL_DESCRIPTION, type: "string" };
	}

	// Only a bot speaks to people, so only a bot is offered the person target. An
	// unassembled config (no runtime, as with the policy ceiling) sees the full schema.
	if (!config || config.bot) {
		properties.user = {
			description: USER_TARGET_DESCRIPTION,
			type: "string",
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
		'Subagents may also report progress to the narrator that launched them via "parent" (or "main"). Ordinary asynchronous messages may mix parent and sibling targets in one call; aliases for the same recipient are deduplicated. ' +
		"Foreground reports are durably queued until the parent's safe input boundary; they do not start a second parent loop or guarantee immediate reading. Each target is accepted independently after whole-call authorization; partial failures preserve successful deliveries. " +
		"Messages have a 256 KiB UTF-8 body limit; larger content must use a file reference or summary. " +
		"Send may wake the recipient's session and trigger an unnecessary extra agent turn, so send messages only when genuinely necessary. " +
		"Do not send agents courtesy acknowledgements, redundant progress updates, or messages merely to check status. " +
		"Use Send for new information, changed requirements, or concrete corrections—not for routine " +
		"status checks after an Await timeout. Repeated messages can distract a working subagent. " +
		"Set doInterrupt=true only when the current work must stop immediately; never use it merely " +
		"because a short wait timed out or you are impatient. " +
		"Send never waits for an answer: a recipient answers with its own Send, which arrives as a " +
		"message and wakes you when idle. After sending, continue other work or end your turn.",
	parameters: z.object({
		id: z
			.string()
			.optional()
			.describe(
				'Target subagent ID or alias. Subagents may use "parent" to reach their parent narrator.',
			),
		ids: z
			.array(z.string())
			.optional()
			.describe(
				"Target IDs or aliases. Subagents may mix parent/main with sibling targets for ordinary asynchronous messages.",
			),
		name: z.string().optional().describe("Target subagent title, alias, or unique ID prefix."),
		names: z
			.array(z.string())
			.optional()
			.describe("Target subagent titles, aliases, or unique ID prefixes."),
		message: z.string().describe("Message to send to the target subagent(s)."),
		user: z.string().optional().describe(USER_TARGET_DESCRIPTION),
		doInterrupt: z
			.boolean()
			.optional()
			.describe(
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
					"for an urgent correction that requires stopping current work, never for status polling.",
			),
		resume: z.boolean().optional().describe(RESUME_DESCRIPTION),
		model: z.string().optional().describe(MODEL_DESCRIPTION),
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
			user?: string;
			doInterrupt?: boolean;
			resume?: boolean;
			model?: string;
		};
		if (raw.user !== undefined) return sendToUser(raw, ctx);
		if (!raw.message?.trim()) {
			return { output: "Error: message is required.", isError: true };
		}
		if (!ctx.currentToolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}

		const toolUseId = ctx.currentToolUseId;
		let targetCount: number | undefined;
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
				resume: raw.resume,
				model: raw.model,
				toolUseId: ctx.currentToolUseId,
				toolCallBinding: ctx.toolCallBinding,
				signal: ctx.signal,
				locale: ctx.locale,
				userId: ctx.userId ?? null,
				onTargetsResolved: (count) => {
					targetCount = count;
					void import("@server/services/send-delivery-resolution")
						.then(({ broadcastSendDeliveryResolved }) =>
							broadcastSendDeliveryResolved(
								ctx.narratorId,
								toolUseId,
								[],
								ctx.toolCallBinding,
								count,
							),
						)
						.catch(() => {});
				},
				onDeliveryResolved: (target) => {
					// The frontend merges by receipt; avoid O(targets²) cumulative broadcasts.
					const snapshot = [{ ...target }];
					void import("@server/services/send-delivery-resolution")
						.then(({ broadcastSendDeliveryResolved }) =>
							broadcastSendDeliveryResolved(
								ctx.narratorId,
								toolUseId,
								snapshot,
								ctx.toolCallBinding,
								targetCount,
							),
						)
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
					targetCount: targetCount ?? result.targets.length,
					doInterrupt: raw.doInterrupt ?? false,
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

/**
 * A bot's message to one person. Separate from agent messaging on purpose: there is no
 * session to wake, no delivery receipt to track and no reply to wait for — the message
 * is recorded in the person's chat with the bot, and they answer when they choose.
 */
async function sendToUser(
	raw: {
		user?: string;
		message?: string;
		id?: string;
		ids?: string[];
		name?: string;
		names?: string[];
		doInterrupt?: boolean;
		resume?: boolean;
		model?: string;
	},
	ctx: ToolContext,
): Promise<ToolResult> {
	if (raw.id || raw.ids?.length || raw.name || raw.names?.length) {
		return { output: "Send error: `user` cannot be combined with agent targets.", isError: true };
	}
	if (raw.resume || raw.model !== undefined) {
		return {
			output: "Send error: `user` cannot be combined with resume or model.",
			isError: true,
		};
	}
	if (raw.doInterrupt) {
		return {
			output: "Send error: a message to a person cannot interrupt.",
			isError: true,
		};
	}
	if (!raw.user?.trim()) return { output: "Error: user is required.", isError: true };
	// Native search's internal citation markers only resolve to links in assistant text,
	// where the provider's annotations carry the URLs; inside a tool argument they are
	// bare noise to the reader.
	const message = cleanAssistantText(raw.message ?? "").text;
	if (!message.trim()) return { output: "Error: message is required.", isError: true };
	try {
		const { sendAsBot } = await import("@server/services/bot-chat");
		const result = await sendAsBot({
			narratorId: ctx.narratorId,
			user: raw.user,
			message,
		});
		return {
			output: `Delivered to ${result.username}. A reply, if any, arrives as their next message.`,
			metadata: {
				kind: "send",
				// No `id`: a person is not a session, so the card shows a plain chip
				// instead of a link that would open a narrator page.
				targets: [{ label: result.username, status: "sent" }],
				targetCount: 1,
				doInterrupt: false,
			},
		};
	} catch (err) {
		return {
			output: `Send error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}
