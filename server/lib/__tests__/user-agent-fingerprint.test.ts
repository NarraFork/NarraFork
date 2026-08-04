import { describe, expect, test } from "bun:test";
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

	test("adds conversation identity headers only when a conversation id is present", () => {
		const without = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(without["session-id"]).toBeUndefined();
		expect(without["thread-id"]).toBeUndefined();
		expect(without["x-client-request-id"]).toBeUndefined();

		const withConversation = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(withConversation["session-id"]).toBe("conv-123");
		expect(withConversation["thread-id"]).toBe("conv-123");
		expect(withConversation["x-client-request-id"]).toBe("conv-123");
	});

	test("never emits tracking or semantic headers", () => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(headers["x-codex-turn-metadata"]).toBeUndefined();
		expect(headers["x-codex-window-id"]).toBeUndefined();
		expect(headers.sandbox).toBeUndefined();
	});
});

describe("resolveClientFingerprint", () => {
	test("injects codex headers when an installation id is supplied", () => {
		const { userAgent, headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			conversationId: "conv-1",
		});
		expect(userAgent).toMatch(new RegExp(`^${ORIGINATOR_CODEX}/[^ ]+ `));
		expect(userAgent).toMatch(new RegExp(`unknown \\(${ORIGINATOR_CODEX}; [^)]+\\)$`));
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
		expect(headers["session-id"]).toBe("conv-1");
	});

	test("emits no codex headers for a non-codex caller", () => {
		// Non-codex providers never pass an installation id, which is what keeps
		// codex-specific identifiers out of their requests.
		const { headers } = resolveClientFingerprint({
			mode: "narrafork",
			fallback: getHttpUserAgent(),
		});
		expect(headers.originator).toBeUndefined();
		expect(headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("user extra headers override codex headers", () => {
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

	test("keeps HTTP and WebSocket identity headers aligned to one conversation", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			installationId: INSTALLATION_ID,
			conversationId: "thread-abc",
		});
		expect(headers["thread-id"]).toBe("thread-abc");
		expect(headers["session-id"]).toBe("thread-abc");
		expect(headers["x-client-request-id"]).toBe("thread-abc");
		expect(headers.session_id).toBeUndefined();
	});
});
