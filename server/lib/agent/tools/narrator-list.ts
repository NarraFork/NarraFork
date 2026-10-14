import {
	isRuntimeToolAllowed,
	runtimePolicyForContext,
} from "@server/services/agent-runtime/policy";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const parameters = z
	.object({
		query: z
			.string()
			.trim()
			.max(256)
			.optional()
			.describe("Match an accessible ordinary narrator's full ID, title, or handle."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe("Page size, defaults to 20; maximum 100."),
		cursor: z
			.string()
			.min(1)
			.max(1024)
			.optional()
			.describe("Opaque nextCursor returned by a previous NarratorList call."),
	})
	.strict();

export const narratorListTool: ToolDefinition = {
	name: "NarratorList",
	description:
		"Discover accessible ordinary (primary) narrators outside the subagent tree. " +
		"Returns full IDs, titles, handles, status, canSend and nextCursor, never conversation history. " +
		"Only ordinary primary narrators may call this tool; archived narrators, subagents and yourself are excluded. " +
		"Use the exact returned ID with NarratorSend. canSend is advisory and authorization is checked again when sending. " +
		"This is read-only: it does not send, wake or interrupt another narrator. Use TeamStatus for your subagents.",
	parameters,
	metadata: { readOnly: true },
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = parameters.safeParse(args);
		if (!parsed.success)
			return {
				output:
					"NarratorList error: invalid query, limit or cursor; no other fields are supported.",
				isError: true,
			};
		if (!isRuntimeToolAllowed(runtimePolicyForContext(ctx), "NarratorList")) {
			return {
				output: "NarratorList error: only ordinary primary narrators can discover peers.",
				isError: true,
			};
		}
		try {
			const { listPeerNarrators } = await import("@server/services/narrator-peer-communication");
			const result = await listPeerNarrators({
				...parsed.data,
				callerNarratorId: ctx.narratorId,
				userId: ctx.userId ?? null,
				runtimePolicy: runtimePolicyForContext(ctx),
			});
			return { output: JSON.stringify(result), metadata: { kind: "narrator_list", ...result } };
		} catch (error) {
			return {
				output: `NarratorList error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	},
};
