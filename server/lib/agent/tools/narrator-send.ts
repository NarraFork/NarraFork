import {
	isRuntimeToolAllowed,
	runtimePolicyForContext,
} from "@server/services/agent-runtime/policy";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_MESSAGE_BYTES = 256 * 1024;
const parameters = z
	.object({
		id: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.describe(
				"Exact full ordinary narrator ID returned by NarratorList or a trusted sender marker; no aliases or prefixes.",
			),
		message: z
			.string()
			.refine(
				(value) => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
				"message must be non-blank and at most 256 KiB in UTF-8",
			)
			.describe(
				"Message body, at most 256 KiB UTF-8. Sender identity is supplied by the server, not by the body.",
			),
	})
	.strict();

export const narratorSendTool: ToolDefinition = {
	name: "NarratorSend",
	description:
		"Send one durable asynchronous message to another accessible ordinary (primary) narrator. " +
		"Use NarratorList to discover exact IDs. Unlike Send, this does not require a parent/child or team relationship " +
		"and cannot target subagents. Only primary narrators may call it, with the initiating user's current source and target access. " +
		"Busy recipients queue the message until a safe input boundary; idle recipients may wake under existing runtime rules. " +
		"Acceptance is not a claim the recipient read or answered it. The result provides durable delivery coordinates and status; " +
		"retries of the same execution reuse the same delivery. To reply, call NarratorSend with the trusted sender's full ID. " +
		"No await, replyTo, interrupt, broadcast, attachments or sender overrides are supported. " +
		"Plan/read-only and external restricted runtimes cannot send. Default mode requires approval; ACL still applies in bypass mode.",
	parameters,
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = parameters.safeParse(args);
		if (!parsed.success)
			return {
				output:
					"NarratorSend error: provide only a full id and a non-blank message of at most 256 KiB UTF-8.",
				isError: true,
			};
		const runtimePolicy = runtimePolicyForContext(ctx);
		if (!isRuntimeToolAllowed(runtimePolicy, "NarratorSend")) {
			return {
				output: "NarratorSend error: this runtime cannot send ordinary narrator messages.",
				isError: true,
			};
		}
		if (!ctx.currentToolUseId || !ctx.toolCallBinding) {
			return {
				output: "NarratorSend error: missing durable tool execution identity.",
				isError: true,
			};
		}
		const toolUseId = ctx.currentToolUseId;
		try {
			const { authorizePeerNarratorMessage } = await import(
				"@server/services/narrator-peer-communication"
			);
			const input = await authorizePeerNarratorMessage({
				...parsed.data,
				callerNarratorId: ctx.narratorId,
				userId: ctx.userId ?? null,
				runtimePolicy,
				toolUseId: ctx.currentToolUseId,
				toolCallBinding: ctx.toolCallBinding,
				signal: ctx.signal,
				locale: ctx.locale === "zh-CN" ? "zh-CN" : "en",
			});
			const { sendMessage } = await import("@server/services/narrator-session");
			const sent = await sendMessage(input);
			if (!sent.target) throw new Error("Accepted peer message has no delivery coordinates");
			const result = {
				accepted: sent.accepted,
				target: sent.target,
				duplicate: sent.duplicate,
				...(sent.wakeError ? { wakeError: sent.wakeError } : {}),
			};
			// Navigation frames are best-effort. Once durably accepted, a UI failure
			// must not turn this result into an apparent undelivered message.
			await import("@server/services/send-delivery-resolution")
				.then(({ broadcastSendDeliveryResolved }) =>
					broadcastSendDeliveryResolved(
						ctx.narratorId,
						toolUseId,
						[result.target],
						ctx.toolCallBinding,
						1,
					),
				)
				.catch(() => {});
			return {
				output: JSON.stringify(result),
				metadata: {
					kind: "send",
					targets: [result.target],
					targetCount: 1,
					doInterrupt: false,
					await: false,
					duplicate: result.duplicate,
					...(result.wakeError ? { wakeError: result.wakeError } : {}),
				},
			};
		} catch (error) {
			return {
				output: `NarratorSend error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	},
};
