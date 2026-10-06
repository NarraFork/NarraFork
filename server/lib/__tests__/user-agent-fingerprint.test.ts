import { describe, expect, it, test } from "bun:test";
import { deriveCodexWindowId } from "../agent/codex-request";
import {
	buildCodexEmulationHeaders,
	getHttpCodexUserAgent,
	getHttpUserAgent,
	mergeExtraHeaders,
	ORIGINATOR,
	ORIGINATOR_CODEX,
	RESPONSES_LITE_HEADER,
	resolveClientFingerprint,
} from "../user-agent";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

describe("buildCodexEmulationHeaders", () => {
	test("includes stable codex identity headers", () => {
		const headers = buildCodexEmulationHeaders({ installationId: INSTALLATION_ID });
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
	});

	/**
	 * codex-rs puts the installation id only in body `client_metadata`; its
	 * compatibility_headers() never projects it onto a direct HTTP header (only
	 * remote-control enrollment does). Emitting the header here produced a
	 * shape no real `/responses` client sends — a distinguishable fingerprint.
	 * The value still travels in body client_metadata via createCodexRequestIdentity.
	 */
	test("never emits x-codex-installation-id as a direct header", () => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(headers["x-codex-installation-id"]).toBeUndefined();
		for (const key of Object.keys(headers)) {
			expect(key.toLowerCase()).not.toBe("x-codex-installation-id");
		}
	});

	/**
	 * User-reported: Codex provider UA set to NarraFork still showed codex-tui
	 * on the wire. The User-Agent mode alone was never enough — originator is
	 * what dumps and relays read first, so it must follow the explicit choice.
	 */
	test("originator follows an explicit NarraFork UA mode", () => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			userAgentMode: "narrafork",
		});
		expect(headers.originator).toBe(ORIGINATOR);
	});

	test.each([
		["codex"],
		["claude-code"],
		["custom"],
		[undefined],
	] as const)("originator stays codex-tui for mode=%s", (mode) => {
		const headers = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			userAgentMode: mode,
		});
		expect(headers.originator).toBe(ORIGINATOR_CODEX);
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
		expect(without["x-client-request-id"]).toBeUndefined();

		const withConv = buildCodexEmulationHeaders({
			installationId: INSTALLATION_ID,
			conversationId: "conv-123",
		});
		expect(withConv["session-id"]).toBe("conv-123");
		expect(withConv["thread-id"]).toBe("conv-123");
		// codex-rs sends x-client-request-id (= thread_id) on HTTP /responses and
		// the WS handshake; only /responses/compact omits it.
		expect(withConv["x-client-request-id"]).toBe("conv-123");
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
		expect(headers["x-codex-installation-id"]).toBeUndefined();
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

	/**
	 * Locks the full identity pair the operator sees in a request dump when they
	 * pick NarraFork on a Codex surface: both the User-Agent and originator.
	 */
	test("NarraFork UA mode presents NarraFork on both User-Agent and originator", () => {
		const { userAgent, headers } = resolveClientFingerprint({
			mode: "narrafork",
			fallback: getHttpCodexUserAgent(),
			installationId: INSTALLATION_ID,
			conversationId: "conv-1",
		});
		expect(userAgent).toBe(getHttpUserAgent());
		expect(headers.originator).toBe(ORIGINATOR);
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
		// Emitted set stays clean; an operator CAN still inject the header via
		// extraHeaders (override semantics), but the emulator itself must not.
		expect(headers["x-codex-installation-id"]).toBeUndefined();
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

/**
 * A header object is case-sensitive; HTTP header names are not. The providers
 * write opposite casings (`User-Agent` vs `user-agent`), so before this an
 * override typed in the other casing left BOTH keys in the map and `fetch`
 * comma-joined them into a UA matching no real client. Measured, not theorised.
 */
describe("mergeExtraHeaders — one User-Agent key, whatever the casing", () => {
	const uaKeys = (headers: Record<string, string>) =>
		Object.keys(headers).filter((k) => k.toLowerCase() === "user-agent");

	for (const injected of ["user-agent", "User-Agent", "USER-AGENT"]) {
		for (const own of ["User-Agent", "user-agent"]) {
			it(`collapses ${injected} onto ${own}`, () => {
				const headers: Record<string, string> = { [own]: "configured/1.0" };
				mergeExtraHeaders(headers, { [injected]: "override/2.0" }, own);
				expect(uaKeys(headers)).toEqual([own]);
				expect(headers[own]).toBe("override/2.0");
			});
		}
	}

	it("leaves the configured UA alone when extraHeaders carries none", () => {
		const headers: Record<string, string> = { "User-Agent": "configured/1.0" };
		mergeExtraHeaders(headers, { "X-Other": "keep" }, "User-Agent");
		expect(headers["User-Agent"]).toBe("configured/1.0");
		expect(headers["X-Other"]).toBe("keep");
	});

	it("sanitizes an override instead of passing raw bytes to the wire", () => {
		const headers: Record<string, string> = { "User-Agent": "configured/1.0" };
		mergeExtraHeaders(headers, { "user-agent": "over/2.0中文" }, "User-Agent");
		expect(headers["User-Agent"]).toBe("over/2.0__");
	});

	it("ignores a blank override rather than clearing the UA", () => {
		const headers: Record<string, string> = { "User-Agent": "configured/1.0" };
		mergeExtraHeaders(headers, { "user-agent": "" }, "User-Agent");
		expect(headers["User-Agent"]).toBe("configured/1.0");
	});
});

describe("resolveClientFingerprint UA override", () => {
	for (const key of ["user-agent", "User-Agent", "USER-AGENT"]) {
		it(`normalizes an extraHeaders ${key} to a single key`, () => {
			const { headers } = resolveClientFingerprint({
				mode: "custom",
				custom: "NarraFork-Custom/7.7",
				fallback: getHttpUserAgent(),
				extraHeaders: { [key]: "override/2.0" },
			});
			const uaKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "user-agent");
			expect(uaKeys).toEqual(["User-Agent"]);
			expect(headers["User-Agent"]).toBe("override/2.0");
		});
	}
});
