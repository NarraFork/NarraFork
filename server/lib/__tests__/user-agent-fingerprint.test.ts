import { describe, expect, test } from "bun:test";
import {
	buildCodexEmulationHeaders,
	getHttpUserAgent,
	ORIGINATOR_CODEX,
	resolveClientFingerprint,
} from "../user-agent";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("buildCodexEmulationHeaders", () => {
	test("includes stable codex identity headers", () => {
		const headers = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
		expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
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
	test("injects codex emulation headers when enabled", () => {
		const { userAgent, headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			emulateCodex: true,
			installationId: INSTALLATION_ID,
			conversationId: "conv-1",
		});
		expect(userAgent).toMatch(new RegExp(`^${ORIGINATOR_CODEX}/[^ ]+ `));
		expect(userAgent).toMatch(new RegExp(`unknown \\(${ORIGINATOR_CODEX}; [^)]+\\)$`));
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
		expect(headers["session-id"]).toBe("conv-1");
	});

	test("does not inject codex headers when emulation is off", () => {
		const { headers } = resolveClientFingerprint({
			mode: "narrafork",
			fallback: getHttpUserAgent(),
			emulateCodex: false,
			installationId: INSTALLATION_ID,
		});
		expect(headers.originator).toBeUndefined();
		expect(headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("omits codex headers when emulation is on but installationId is missing", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			emulateCodex: true,
		});
		expect(headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("user extra headers override emulated headers", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			emulateCodex: true,
			installationId: INSTALLATION_ID,
			extraHeaders: { originator: "custom-originator", "x-extra": "1" },
		});
		expect(headers.originator).toBe("custom-originator");
		expect(headers["x-extra"]).toBe("1");
		expect(headers["x-codex-installation-id"]).toBe(INSTALLATION_ID);
	});

	test("custom user agent falls back to fallback when blank", () => {
		const fallback = getHttpUserAgent();
		const { userAgent } = resolveClientFingerprint({
			mode: "custom",
			custom: "   ",
			fallback,
			emulateCodex: false,
		});
		expect(userAgent).toBe(fallback);
	});

	test("keeps HTTP and WebSocket identity headers aligned to one conversation", () => {
		const { headers } = resolveClientFingerprint({
			mode: "codex",
			fallback: getHttpUserAgent(),
			emulateCodex: true,
			installationId: INSTALLATION_ID,
			conversationId: "thread-abc",
		});
		expect(headers["thread-id"]).toBe("thread-abc");
		expect(headers["session-id"]).toBe("thread-abc");
		expect(headers["x-client-request-id"]).toBe("thread-abc");
		expect(headers.session_id).toBeUndefined();
	});
});
