import { describe, expect, it, test } from "bun:test";
import { deriveCodexWindowId } from "../agent/codex-request";
import {
	applyExplicitUserAgent,
	buildCodexEmulationHeaders,
	CLAUDE_CLI_VERSION,
	CODEX_CLI_VERSION,
	getHttpClaudeCliUserAgent,
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

describe("latest managed CLI fingerprints", () => {
	test("pins the verified release versions, including both Codex UA positions", () => {
		expect(CLAUDE_CLI_VERSION).toBe("2.1.330");
		expect(CODEX_CLI_VERSION).toBe("0.171.0");
		expect(getHttpClaudeCliUserAgent()).toBe("claude-cli/2.1.330 (external, cli)");
		expect(getHttpCodexUserAgent()).toMatch(
			/^codex-tui\/0\.171\.0 \(.+\) unknown \(codex-tui; 0\.171\.0\)$/,
		);
	});
});

describe("case-insensitive header layers", () => {
	test("replaces every protocol default rather than comma-joining credentials or identity", () => {
		const headers: Record<string, string> = {
			Authorization: "Bearer default",
			originator: "codex-tui",
			"Content-Type": "application/json",
			"anthropic-beta": "default-beta",
			"User-Agent": "default/1",
		};
		mergeExtraHeaders(
			headers,
			{
				authorization: "Bearer override",
				Originator: "custom",
				"content-type": "application/custom+json",
				"Anthropic-Beta": "override-beta",
				"USER-AGENT": "override/2",
			},
			"User-Agent",
		);
		expect(Object.keys(headers)).toHaveLength(5);
		expect(Object.fromEntries(new Headers(headers))).toEqual({
			authorization: "Bearer override",
			originator: "custom",
			"content-type": "application/custom+json",
			"anthropic-beta": "override-beta",
			"user-agent": "override/2",
		});
	});

	test("normalizes existing duplicates and keeps the last nonempty override", () => {
		const headers: Record<string, string> = {
			"user-agent": "old/1",
			"USER-AGENT": "old/2",
			Originator: "old",
			originator: "new",
		};
		mergeExtraHeaders(
			headers,
			{ "USER-AGENT": "  ", Originator: "", ORIGINATOR: "last" },
			"User-Agent",
		);
		expect(Object.keys(headers).sort()).toEqual(["Originator", "User-Agent"]);
		expect(new Headers(headers).get("user-agent")).toBe("old/2");
		expect(new Headers(headers).get("originator")).toBe("last");
	});

	test("keeps literal header names from mutating the record prototype", () => {
		const headers: Record<string, string> = {};
		mergeExtraHeaders(
			headers,
			JSON.parse('{"__proto__":"literal","constructor":"value"}'),
			"User-Agent",
		);
		expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
		expect(Object.keys(headers)).toEqual(["__proto__", "constructor"]);
		expect(headers.__proto__).toBe("literal");
	});

	test("the returned fingerprint UA is the same final value sent in its header layer", () => {
		const fingerprint = resolveClientFingerprint({
			mode: "custom",
			custom: "configured/1",
			fallback: "fallback/1",
			extraHeaders: { "user-agent": "  final/2  " },
		});
		expect(fingerprint.userAgent).toBe("final/2");
		expect(fingerprint.headers["User-Agent"]).toBe(fingerprint.userAgent);
	});
});

describe("explicit UA priority", () => {
	for (const [name, selection, expected] of [
		["custom", { mode: "custom", custom: "selected/1" }, "selected/1"],
		[
			"extra beats mode",
			{ mode: "custom", custom: "selected/1", extraHeaders: { "uSeR-aGeNt": " operator/2 " } },
			"operator/2",
		],
		[
			"last nonblank extra",
			{ extraHeaders: { "User-Agent": "first/1", "USER-AGENT": "last/2", "user-agent": "  " } },
			"last/2",
		],
		["unset", {}, "dynamic/3"],
		["blank custom", { mode: "custom", custom: " " }, "dynamic/3"],
		["blank extra", { extraHeaders: { "User-Agent": " " } }, "dynamic/3"],
	] as const) {
		test(`${name}: only UA gets the operator priority`, () => {
			const fingerprint = resolveClientFingerprint({ ...selection, fallback: "default/1" });
			const headers = {
				"User-Agent": fingerprint.userAgent,
				Authorization: "Bearer static",
				"X-Channel": "old",
			};
			mergeExtraHeaders(
				headers,
				{ "USER-AGENT": "dynamic/3", authorization: "Bearer dynamic", "x-channel": "latest" },
				"User-Agent",
			);
			applyExplicitUserAgent(headers, selection, "User-Agent", fingerprint.userAgent);
			expect(new Headers(headers).get("user-agent")).toBe(expected);
			expect(new Headers(headers).get("authorization")).toBe("Bearer dynamic");
			expect(new Headers(headers).get("x-channel")).toBe("latest");
			expect(Object.keys(headers).filter((key) => key.toLowerCase() === "user-agent")).toHaveLength(
				1,
			);
		});
	}
	for (const mode of ["narrafork", "codex", "claude-code"] as const) {
		test(`${mode}: explicit mode beats a protocol/dynamic UA`, () => {
			const fingerprint = resolveClientFingerprint({ mode, fallback: "default/1" });
			const headers = { "user-agent": "dynamic/3" };
			applyExplicitUserAgent(headers, { mode }, "user-agent", fingerprint.userAgent);
			expect(headers["user-agent"]).toBe(fingerprint.userAgent);
		});
	}
});
