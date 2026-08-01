import { randomUUID } from "node:crypto";
import { getInstallationId } from "../installation-id";

/**
 * Stable identity fields the real client puts in `client_metadata`.
 *
 * The installation id key is hyphenated (`x-codex-installation-id`), matching
 * captured codex-tui traffic. The underscore form `installation_id` belongs to
 * the separate turn-metadata payload, which NarraFork deliberately does not send.
 *
 * Also omitted here: `turn_id` and `x-codex-window-id`. Both are per-turn
 * runtime values, and the volatile turn/window headers they pair with are not
 * sent either (see buildCodexEmulationHeaders).
 */
export interface CodexRequestIdentity {
	conversationId: string;
	clientMetadata: {
		session_id: string;
		thread_id: string;
		"x-codex-installation-id": string;
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
			"x-codex-installation-id": installationId,
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
