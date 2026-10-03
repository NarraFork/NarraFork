import { randomUUID } from "node:crypto";
import { resolveRuntimePolicy } from "../../services/agent-runtime/policy";
import type { SearchChannelConfig } from "../settings/types";
import type { SearchRequest } from "./types";

/** A settings probe has no parent transcript, tool-call row, or business narrator. */
export async function runSearchProbe(
	channel: SearchChannelConfig,
	request: SearchRequest,
	prompt: string,
): Promise<string> {
	const { agentLoop } = await import("../agent/loop");
	const { resolveProviderAndModel } = await import("../agent/provider");
	const resolved = resolveProviderAndModel(channel.model);
	const id = `search-probe-${randomUUID()}`;
	const allowedTools = new Set(["WebSearch", "WebFetch"]);
	let text = "";
	let completed = false;
	let searched = false;
	for await (const event of agentLoop(
		{
			narratorId: id,
			conversationId: id,
			model: resolved.model,
			provider: resolved.provider,
			cwd: process.cwd(),
			systemPrompt:
				"You are a web search assistant. Search the web, verify the requested facts, and cite sources. Do not answer from memory alone.",
			locale: request.locale ?? "en",
			signal: request.signal ?? new AbortController().signal,
			userId: request.userId ?? null,
			runtimePolicy: resolveRuntimePolicy({ variant: "subagent", subagentType: "search" }),
			maxTurns: channel.maxTurns ?? 4,
			reasoningEffort: channel.reasoningEffort,
			maxTransientRetries: 0,
			allowedTools,
			toolFilter: (tool) => allowedTools.has(tool.name),
			permissionHandler: async (toolName, input) =>
				allowedTools.has(toolName)
					? { behavior: "allow", input }
					: {
							behavior: "deny",
							message: "Only web search and fetch are allowed in a search probe",
						},
		},
		prompt,
		[],
	)) {
		if (event.type === "assistant_message") text = event.text.slice(0, 100_000);
		if (event.type === "web_search" && event.status === "completed") searched = true;
		if (event.type === "tool_result" && event.toolName === "WebSearch") {
			// The scoped native side request rejects prose-only responses without a search result block.
			if (event.isError) throw new Error(event.output);
			searched = true;
		}
		if (event.type === "done") completed = true;
		if (event.type === "max_turns_exceeded") {
			throw new Error(`Search subagent exceeded its maximum of ${event.maxTurns} turns`);
		}
		if (
			event.type === "error" ||
			event.type === "retryable_error" ||
			event.type === "model_unavailable" ||
			event.type === "payment_required" ||
			event.type === "resumable_error" ||
			event.type === "invalid_state"
		) {
			throw new Error(event.message);
		}
		if (
			event.type === "context_length_exceeded" ||
			event.type === "silent_disconnect" ||
			event.type === "output_truncated"
		) {
			throw new Error(`Search probe failed: ${event.type}`);
		}
	}
	if (request.signal?.aborted) throw request.signal.reason ?? new Error("Aborted");
	if (!completed || !text.trim()) throw new Error("Search subagent returned no results");
	if (!searched) throw new Error("Search subagent did not perform a web search");
	return text;
}
