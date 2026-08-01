import { randomUUID } from "node:crypto";
import { getInstallationId } from "../installation-id";

export interface CodexRequestIdentity {
	conversationId: string;
	clientMetadata: {
		session_id: string;
		thread_id: string;
		installation_id: string;
	};
}

export function createCodexRequestIdentity(
	conversationId: string = randomUUID(),
): CodexRequestIdentity {
	const installationId = getInstallationId();
	return {
		conversationId,
		clientMetadata: {
			session_id: conversationId,
			thread_id: conversationId,
			installation_id: installationId,
		},
	};
}

/**
 * Apply the stable Codex TUI Responses body contract shared by HTTP, WebSocket,
 * and one-shot utility requests.
 */
export function applyCodexStableRequestFields(
	body: Record<string, unknown>,
	options: {
		identity: CodexRequestIdentity;
		reasoningEffort: string;
	},
): void {
	body.prompt_cache_key = options.identity.conversationId;
	body.tool_choice = "auto";
	body.parallel_tool_calls = false;
	body.reasoning = {
		effort: options.reasoningEffort,
		context: "all_turns",
	};
	body.include = ["reasoning.encrypted_content"];
	body.text = { verbosity: "low" };
	body.client_metadata = options.identity.clientMetadata;
}
