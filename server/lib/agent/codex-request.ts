import { createHash, randomUUID } from "node:crypto";
import { normalizeLegacyUltra } from "@shared/reasoning-effort";
import { getInstallationId } from "../installation-id";
import { markInstructionsInput } from "./input-characters";

/**
 * Stable identity fields the real client puts in `client_metadata`.
 *
 * The installation id key is hyphenated (`x-codex-installation-id`), matching
 * captured codex-tui traffic. The underscore form `installation_id` belongs to
 * the separate turn-metadata payload, which NarraFork deliberately does not send.
 *
 * `x-codex-window-id` mirrors the real client's window identity: codex-rs
 * builds `CodexResponsesMetadata` with a window UUID that is stable for the
 * lifetime of the TUI window and includes it in every request's
 * `client_metadata` (responses_metadata.rs `client_metadata()`) plus a direct
 * `x-codex-window-id` header (`compatibility_headers()`). NarraFork's closest
 * analogue to "one window" is one conversation, so the window id is derived
 * deterministically from the conversation id — stable across every request of
 * a conversation without threading extra state.
 *
 * `turn_id` is attached by callers only when they hold an explicit logical
 * ProviderTurnContext; it is not a stable conversation identity. The volatile
 * turn-metadata blob remains omitted (see buildCodexEmulationHeaders).
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

/**
 * Derive the stable window UUID for a conversation.
 *
 * Deterministic (sha256 of the conversation id, formatted as a v4-style UUID)
 * so every request builder — HTTP body, WS envelope, emulation headers — agrees
 * on the same window without shared mutable state.
 */
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

/** Codex 0.171.0 prepends base instructions only when nonempty (core/src/client.rs,
 * ccf9be8cc458bd6b8336fe84d68d8893f2691a5e). Keep NF's stable ids on retries. */
export function applyCodexInstructionsInput(
	body: Record<string, unknown>,
	identity: CodexRequestIdentity,
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
	applyCodexInstructionsInput(
		body,
		options.instructionsConversationId === undefined
			? options.identity
			: {
					...options.identity,
					conversationId: options.instructionsConversationId,
				},
	);
	body.prompt_cache_key = options.identity.conversationId;
	body.tool_choice = "auto";
	// Parallel tool calls stay ON. `false` belongs to the responses-lite contract
	// (see codex-websocket.ts buildHandshakeHeaders), which NarraFork deliberately
	// does not implement — the lite header was dropped in favour of keeping hosted
	// tools. Sending `false` outside that contract has no upstream justification and
	// silently degrades every Codex turn to one tool call at a time.
	body.parallel_tool_calls = true;
	const effort = normalizeLegacyUltra(options.reasoningEffort);
	body.reasoning = {
		...(effort !== undefined ? { effort } : {}),
		// Without an explicit summary mode the Responses API emits no
		// reasoning_summary_text events, and encrypted_content is opaque — the
		// narrator's visible thinking would go blank across all three transports.
		summary: "auto",
		// No `context` here: codex-rs (core/src/client.rs build_reasoning) sends
		// `context: "all_turns"` only when the model catalog opts into
		// responses-lite. Non-lite requests omit the field so the server default
		// (current_turn) applies; NarraFork emits only the non-lite shape.
	};
	body.include = ["reasoning.encrypted_content"];
	body.text = { verbosity: "low" };
	body.client_metadata = options.identity.clientMetadata;
}
