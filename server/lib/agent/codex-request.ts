import { createHash, randomUUID } from "node:crypto";
import { normalizeLegacyUltra } from "@shared/reasoning-effort";
import { getInstallationId } from "../installation-id";
import { markInstructionsInput } from "./input-characters";

/**
 * Stable conversation metadata. Installation id stays in the body; window id
 * also travels in a header. Callers add `turn_id` from their ProviderTurnContext.
 */
export interface CodexRequestIdentity {
	conversationId: string;
	clientMetadata: {
		session_id: string;
		thread_id: string;
		"x-codex-installation-id": string;
		"x-codex-window-id": string;
	};
}

/** Derive the same window UUID for HTTP, WS and emulation headers without shared state. */
export function deriveCodexWindowId(conversationId: string): string {
	const bytes = createHash("sha256")
		.update(`narrafork-codex-window:${conversationId}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createCodexRequestIdentity(
	conversationId: string = randomUUID(),
	/** The credential's own device id; absent = this instance's installation id. */
	installationId: string = getInstallationId(),
): CodexRequestIdentity {
	return {
		conversationId,
		clientMetadata: {
			session_id: conversationId,
			thread_id: conversationId,
			"x-codex-installation-id": installationId,
			"x-codex-window-id": deriveCodexWindowId(conversationId),
		},
	};
}

/** Replace our nonempty developer prefix with a stable id across retries and restoration. */
export function applyCodexInstructionsInput(
	body: Record<string, unknown>,
	identity: Pick<CodexRequestIdentity, "conversationId">,
): void {
	if (typeof body.instructions !== "string") return;
	const instructions = body.instructions;
	const sessionHash = createHash("sha256").update(identity.conversationId).digest("hex");
	const prefix = `msg_nf_instructions_${sessionHash.slice(0, 12)}_`;
	const input = Array.isArray(body.input)
		? body.input.filter((item: unknown) => {
				if (!item || typeof item !== "object") return true;
				const previous = item as Record<string, unknown>;
				return !(
					previous.type === "message" &&
					previous.role === "developer" &&
					typeof previous.id === "string" &&
					previous.id.startsWith(prefix)
				);
			})
		: typeof body.input === "string"
			? [{ role: "user", content: body.input }]
			: [];
	delete body.instructions;
	if (instructions.length === 0) {
		body.input = input;
		markInstructionsInput(body, undefined);
		return;
	}
	const instructionHash = createHash("sha256").update(instructions).digest("hex");
	const textPart = { type: "input_text" as const, text: instructions };
	body.input = [
		{
			type: "message",
			id: `${prefix}${instructionHash.slice(0, 24)}`,
			role: "developer",
			content: [textPart],
		},
		...input,
	];
	markInstructionsInput(body, textPart);
}

/**
 * Apply the stable Codex TUI Responses body contract shared by HTTP, WebSocket,
 * and one-shot utility requests, including the developer instruction prefix.
 */
export function applyCodexStableRequestFields(
	body: Record<string, unknown>,
	options: {
		identity: CodexRequestIdentity;
		/** Diagnostic forks keep the parent's input IDs while isolating their wire identity. */
		instructionsConversationId?: string;
		reasoningEffort?: string;
	},
): void {
	applyCodexInstructionsInput(body, {
		conversationId: options.instructionsConversationId ?? options.identity.conversationId,
	});
	body.prompt_cache_key = options.identity.conversationId;
	body.tool_choice = "auto";
	// The non-lite contract retains hosted tools and parallel calls.
	body.parallel_tool_calls = true;
	const effort = normalizeLegacyUltra(options.reasoningEffort);
	body.reasoning = {
		...(effort !== undefined ? { effort } : {}),
		// Request visible reasoning summaries; leave lite-only `context` unset.
		summary: "auto",
	};
	body.include = ["reasoning.encrypted_content"];
	body.text = { verbosity: "low" };
	body.client_metadata = options.identity.clientMetadata;
}
