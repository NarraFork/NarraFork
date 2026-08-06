/**
 * The stable Codex Responses body contract is shared by three transports: the
 * HTTP chat path, the Responses WebSocket path, and the one-shot utility calls
 * (title generation and friends). Each of those used to hand-roll its own body,
 * so a relay that fingerprints request shape saw a different client per path.
 * Lock the contract here so the shared helper cannot drift back apart.
 */
import { describe, expect, test } from "bun:test";
import {
	applyCodexStableRequestFields,
	createCodexRequestIdentity,
	deriveCodexWindowId,
} from "../codex-request";

describe("createCodexRequestIdentity", () => {
	test("correlates session/thread ids to one conversation id", () => {
		const identity = createCodexRequestIdentity("conv-1");

		expect(identity.conversationId).toBe("conv-1");
		expect(identity.clientMetadata.session_id).toBe("conv-1");
		expect(identity.clientMetadata.thread_id).toBe("conv-1");
	});

	test("derives a conversation-stable window id in UUID shape", () => {
		const identity = createCodexRequestIdentity("conv-1");
		const again = createCodexRequestIdentity("conv-1");
		const other = createCodexRequestIdentity("conv-2");

		expect(identity.clientMetadata["x-codex-window-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		// Rebuilt identities for one conversation must agree on the window.
		expect(again.clientMetadata["x-codex-window-id"]).toBe(
			identity.clientMetadata["x-codex-window-id"],
		);
		expect(other.clientMetadata["x-codex-window-id"]).not.toBe(
			identity.clientMetadata["x-codex-window-id"],
		);
		expect(identity.clientMetadata["x-codex-window-id"]).toBe(deriveCodexWindowId("conv-1"));
	});

	test("carries the persisted installation id, not a per-call value", () => {
		const first = createCodexRequestIdentity("conv-1");
		const second = createCodexRequestIdentity("conv-2");

		expect(first.clientMetadata["x-codex-installation-id"]).toBeTruthy();
		expect(second.clientMetadata["x-codex-installation-id"]).toBe(
			first.clientMetadata["x-codex-installation-id"],
		);
	});

	test("mints a conversation id when the caller has none (utility paths)", () => {
		const first = createCodexRequestIdentity();
		const second = createCodexRequestIdentity();

		expect(first.conversationId).toBeTruthy();
		expect(second.conversationId).not.toBe(first.conversationId);
		// A minted id must still be internally correlated.
		expect(first.clientMetadata.thread_id).toBe(first.conversationId);
	});
});

describe("applyCodexStableRequestFields", () => {
	test("applies the full stable field set", () => {
		const body: Record<string, unknown> = { model: "gpt-5.3-codex", stream: true };

		applyCodexStableRequestFields(body, {
			identity: createCodexRequestIdentity("conv-1"),
			reasoningEffort: "high",
		});

		expect(body.prompt_cache_key).toBe("conv-1");
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
		// context is a responses-lite-only field; the non-lite contract omits it.
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
		expect(body.text).toEqual({ verbosity: "low" });
	});

	test("keeps prompt_cache_key and client_metadata pointing at the same conversation", () => {
		const body: Record<string, unknown> = {};

		applyCodexStableRequestFields(body, {
			identity: createCodexRequestIdentity("conv-abc"),
			reasoningEffort: "medium",
		});

		const clientMetadata = body.client_metadata as Record<string, string>;
		expect(clientMetadata.session_id).toBe("conv-abc");
		expect(clientMetadata.thread_id).toBe("conv-abc");
		expect(body.prompt_cache_key).toBe(clientMetadata.session_id);
	});

	test("preserves caller-owned fields and overwrites only the stable contract", () => {
		const body: Record<string, unknown> = {
			model: "gpt-5.3-codex",
			instructions: "caller instructions",
			input: [{ role: "user", content: "hi" }],
			// A legacy caller value that the contract must normalize away.
			parallel_tool_calls: true,
		};

		applyCodexStableRequestFields(body, {
			identity: createCodexRequestIdentity("conv-1"),
			reasoningEffort: "low",
		});

		expect(body.model).toBe("gpt-5.3-codex");
		expect(body.instructions).toBe("caller instructions");
		expect(body.input).toEqual([{ role: "user", content: "hi" }]);
		expect(body.parallel_tool_calls).toBe(false);
	});

	test("never emits volatile per-turn tracking fields", () => {
		const body: Record<string, unknown> = {};

		applyCodexStableRequestFields(body, {
			identity: createCodexRequestIdentity("conv-1"),
			reasoningEffort: "none",
		});

		expect(body.turn_metadata).toBeUndefined();
		expect(body.window_id).toBeUndefined();
		expect(body.sandbox).toBeUndefined();
		expect(body.workspace).toBeUndefined();
	});
});
