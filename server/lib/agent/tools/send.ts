import { cleanAssistantText } from "@shared/citations";
import { z } from "zod/v4";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

/**
 * Statically declared, but authorized only for bot narrators at execution time.
 * The current bot protocol belongs in prompt context.
 */
const USER_TARGET_DESCRIPTION =
	"Bot only — your voice to people: the username of the person to message (the name in " +
	"their sender marker). Delivers `message` into your chat with them, the only text of yours " +
	"they ever see (Markdown renders, up to 32,000 characters). Use it alone: no agent " +
	"targets, replyTo, doInterrupt, resume or model.";

const SHOW_TO_USER_DESCRIPTION =
	"Agent messages only. The person watching this session skims it in an overview where an " +
	"agent message collapses to one line. Set true when they would want to read this message " +
	"in full without opening it: a finding, a conclusion, a decision, a blocker, or a hand-off " +
	"of results. Leave it unset for routine coordination such as assigning or adjusting work. " +
	"It changes only how the message is displayed: every message stays expandable, and " +
	"delivery, permissions and the text the recipient reads are the same either way. " +
	"Ignored for Send({ user }), which always posts to the person's chat.";

const RESUME_DESCRIPTION =
	"Direct child subagents only: restart a target whose last turn ended with an error. Agent " +
	"messages alone never restart such a subagent (Send then reports status `blocked` and the " +
	"message stays queued); set resume=true to deliver this message and start it again. " +
	"It cannot override a stop the user made.";

const MODEL_DESCRIPTION =
	"Direct child subagents only: switch each target's model when this Send is newly accepted " +
	'(use "parent" to follow your own model again). Subject to the same allowed subagent model ' +
	"pool as the Agent call; a running subagent switches at its next model request. Combine with " +
	"resume=true to retry a subagent that failed on its previous model.";

function buildRawJsonSchema(): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		id: {
			description:
				'Target session ID or unambiguous alias. Subagents may use "parent" for their currently reachable delegator.',
			type: "string",
		},
		ids: {
			description:
				"Target session IDs or unambiguous aliases. May mix reachable parent/main, group members and exact peers for ordinary messages.",
			type: "array",
			items: { type: "string" },
		},
		name: {
			description:
				"Target session title, alias, handle, or unique ID prefix. Use a full ID to disambiguate.",
			type: "string",
		},
		names: {
			description:
				"Target session titles, aliases, handles, or unique ID prefixes. Ambiguous names are rejected.",
			type: "array",
			items: { type: "string" },
		},
		message: { description: "Message to send to the target session(s).", type: "string" },
		show_to_user: { description: SHOW_TO_USER_DESCRIPTION, type: "boolean" },
		doInterrupt: {
			description:
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
				"for an urgent correction that requires stopping current work, never for status polling. " +
				"Interrupting a worker subagent also cancels the helper agents it launched.",
			type: "boolean",
		},
	};

	properties.resume = { description: RESUME_DESCRIPTION, type: "boolean" };
	properties.model = { description: MODEL_DESCRIPTION, type: "string" };
	properties.user = { description: USER_TARGET_DESCRIPTION, type: "string" };

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
		"Send a message to one or more currently reachable sessions: all delegation levels in your " +
		"communication group, or your exact explicitly connected peers. Connections are not transitive " +
		"and grant no control or history access. Use full narrator IDs when titles or aliases are " +
		"ambiguous or the bounded communication list is truncated; an omitted ID is checked directly. " +
		'Subagents may report progress to the narrator that launched them via "parent" (or "main"), ' +
		"but ordinary Send to parent/main also requires current communication reachability. " +
		"Ordinary asynchronous messages may mix parent and sibling targets, other group members and " +
		"exact peers in one call; aliases for the same recipient are deduplicated. " +
		"Interrupt/resume/model still require the target's existing controller grant; communication " +
		"reachability does not expand ContextAsk, Stop or TeamStatus. " +
		"Foreground reports are durably queued until the parent's safe input boundary; they do not start a second parent loop or guarantee immediate reading. Each target is accepted independently after whole-call authorization; partial failures preserve successful deliveries. " +
		"Every message wakes its recipient and costs it a turn, so send one only when it carries " +
		"something the recipient needs in order to act: new information, a changed requirement, a " +
		'concrete correction, a finding, or a blocker. Acknowledgements, thanks, "still working" ' +
		"updates and status checks carry none of that, so leave them unsent; to learn what another " +
		"agent knows or is doing, use ContextAsk. Results notify automatically; Watch registers a " +
		"non-blocking observation and returns immediately. An observation timeout is not a reason to message the agent. Put everything the recipient needs into one " +
		"message rather than several short ones. " +
		"The person watching this session skims agent messages as one-line summaries. When a " +
		"message is one they would want to read in full (a finding, a conclusion, a decision, a " +
		"blocker, a hand-off of results), set show_to_user: true; routine coordination leaves it " +
		"unset. It affects display only. " +
		"Messages have a 256 KiB UTF-8 body limit; larger content must use a file reference or summary. " +
		"Set doInterrupt=true only when the current work must stop immediately; never use it merely " +
		"because a short wait timed out or you are impatient. " +
		"Send never waits for an answer: a recipient answers with its own Send, which arrives as a " +
		"message and wakes you when idle. After sending, continue other work or end your turn.",
	parameters: z.object({
		id: z
			.string()
			.optional()
			.describe(
				'Target session ID or unambiguous alias. Subagents may use "parent" for their currently reachable delegator.',
			),
		ids: z
			.array(z.string())
			.optional()
			.describe(
				"Target session IDs or unambiguous aliases. May mix reachable parent/main, group members and exact peers for ordinary messages.",
			),
		name: z
			.string()
			.optional()
			.describe(
				"Target session title, alias, handle, or unique ID prefix. Use a full ID to disambiguate.",
			),
		names: z
			.array(z.string())
			.optional()
			.describe(
				"Target session titles, aliases, handles, or unique ID prefixes. Ambiguous names are rejected.",
			),
		message: z.string().describe("Message to send to the target session(s)."),
		show_to_user: z.boolean().optional().describe(SHOW_TO_USER_DESCRIPTION),
		user: z.string().optional().describe(USER_TARGET_DESCRIPTION),
		doInterrupt: z
			.boolean()
			.optional()
			.describe(
				"Interrupt an active foreground child subagent after queuing the message. Use only " +
					"for an urgent correction that requires stopping current work, never for status polling. " +
					"Interrupting a worker subagent also cancels the helper agents it launched.",
			),
		resume: z.boolean().optional().describe(RESUME_DESCRIPTION),
		model: z.string().optional().describe(MODEL_DESCRIPTION),
	}),
	rawJsonSchema: buildRawJsonSchema(),
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			id?: string;
			ids?: string[];
			name?: string;
			names?: string[];
			message?: string;
			show_to_user?: boolean;
			user?: string;
			doInterrupt?: boolean;
			resume?: boolean;
			model?: string;
		};
		// Weak models fill optional strings with ""; only a non-empty user selects bot mode.
		if (raw.user?.trim()) return sendToUser(raw, ctx);
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
				showToUser: raw.show_to_user ?? false,
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
	if (raw.resume || raw.model?.trim()) {
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
