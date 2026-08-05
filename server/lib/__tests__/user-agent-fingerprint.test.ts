import { describe, expect, test } from "bun:test";
import { deriveCodexWindowId } from "../agent/codex-request";
import {
	buildCodexEmulationHeaders,
	getHttpUserAgent,
	ORIGINATOR_CODEX,
	RESPONSES_LITE_HEADER,
	resolveClientFingerprint,
} from "../user-agent";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("buildCodexEmulationHeaders", () => {
	test("includes stable codex identity headers", () => {
		const headers = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
	});

	/**
	 * The lite opt-in is a body contract, not an identity header: upstream pairs it
	 * with "no top-level instructions/tools, additional_tools spliced into input,
	 * parallel_tool_calls off" and rejects the header whenever `tools` carries a
	 * hosted tool ("...only supports function tools, custom tools, and
	 * client-executed tool search"). NarraFork emits the non-lite body, so sending
	 * the header 400s every endpoint that enforces the pairing.
	 */
	test("never claims the responses-lite contract", () => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(headers[RESPONSES_LITE_HEADER]).toBeUndefined();
	});

	test("adds session/thread ids only when a conversation id is present", () => {
		const without = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(without["session-id"]).toBeUndefined();
		expect(without["thread-id"]).toBeUndefined();

		const withConv = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(withConv["session-id"]).toBe("conv-123");
		expect(withConv["thread-id"]).toBe("conv-123");
	});

	test("emits the conversation-stable window id but no turn tracking", () => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(headers["x-codex-turn-metadata"]).toBeUndefined();
		expect(headers.sandbox).toBeUndefined();
		// Same conversation → same window; the value is a derived UUID.
		expect(headers["x-codex-window-id"]).toBe(deriveCodexWindowId("conv-123"));

		const without = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(without["x-codex-window-id"]).toBeUndefined();
	});
});

describe("resolveClientFingerprint", () => {
	test("injects codex client headers when an installation id is supplied", () => {
		const { userAgent, headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			conversationId: "conv-1",
		});
		expect(userAgent.startsWith(`${ORIGINATOR_CODEX}/`)).toBe(true);
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
		expect(headers["session-id"]).toBe("conv-1");
	});

	/**
	 * Passing `installationId` is the opt-in. A provider that does not supply one
	 * must never leak codex-specific identifiers, whatever its UA mode.
	 */
	test("does not inject codex headers without an installation id", () => {
		const { headers } = resolveClientFingerprint({
			mode: "narrafork",
			fallback: getHttpUserAgent(),
		});
		expect(headers.originator).toBeUndefined();
		expect(headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("omits codex headers for codex UA mode when installationId is missing", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
		});
		expect(headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("user extra headers override emitted codex headers", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			extraHeaders: { originator: "custom-originator", "x-extra": "1" },
		});
		expect(headers.originator).toBe("custom-originator");
		expect(headers["x-extra"]).toBe("1");
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
	});

	/**
	 * extraHeaders is merged last, so it is the only place that could put the lite
	 * opt-in back on the wire. It is stripped case-insensitively because header
	 * names are case-insensitive and an operator could type any casing.
	 */
	test("strips a responses-lite header supplied through extra headers", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			extraHeaders: {
				"X-OpenAI-Internal-Codex-Responses-Lite": "true",
				"x-extra": "kept",
			},
		});
		expect(headers["x-extra"]).toBe("kept");
		for (const key of Object.keys(headers)) {
			expect(key.toLowerCase()).not.toBe(RESPONSES_LITE_HEADER);
		}
	});

	test("custom user agent falls back to fallback when blank", () => {
		const fallback = getHttpUserAgent();
		const { userAgent } = resolveClientFingerprint({
			mode: "custom",
			custom: "   ",
			fallback,
		});
		expect(userAgent).toBe(fallback);
	});

	test("session-id can be realigned independently of thread-id (WS semantic split)", () => {
		// The WS path seeds both ids from conversationId, then realigns session-id to the
		// session-level key so the two hyphenated headers carry distinct values, matching the
		// real Codex CLI which sends separate session-id (session) and thread-id (thread).
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			conversationId: "thread-abc",
		});
		expect(headers["thread-id"]).toBe("thread-abc");
		expect(headers["session-id"]).toBe("thread-abc");
		// Simulate the openai-provider WS realignment.
		headers["session-id"] = "session-xyz";
		expect(headers["session-id"]).toBe("session-xyz");
		expect(headers["thread-id"]).toBe("thread-abc");
		// The obsolete underscore variant is never present.
		expect(headers.session_id).toBeUndefined();
	});
});
