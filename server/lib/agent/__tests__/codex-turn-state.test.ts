import { describe, expect, test } from "bun:test";
import {
	type CodexTurnStateScope,
	createProviderTurnContext,
	getCodexTurnState,
	redactCodexTurnStateInJsonText,
} from "../codex-turn-state";

const scope: CodexTurnStateScope = {
	baseUrl: "https://relay.example/v1",
	credentialId: "credential-1",
	headers: { Authorization: "Bearer secret", "User-Agent": "first" },
};

describe("Codex logical turn OnceLock", () => {
	test("locks the first nonempty token and shares HTTP/WS, not new turns or missing contexts", () => {
		const turn = createProviderTurnContext();
		const state = getCodexTurnState(turn, scope);
		for (const empty of [undefined, null, "", "  ", {}, Number.NaN]) state.capture(empty);
		expect(state.value).toBeNull();
		state.capture("first-token");
		state.capture("replacement-token");
		const websocket = getCodexTurnState(turn, {
			...scope,
			baseUrl: "wss://relay.example/v1/responses",
			headers: { "user-agent": "updated", authorization: "Bearer secret" },
		});
		expect(websocket).toBe(state);
		expect(websocket.value).toBe("first-token");
		expect(getCodexTurnState(createProviderTurnContext(), scope).value).toBeNull();
		const isolated = getCodexTurnState(undefined, scope);
		isolated.capture("isolated");
		expect(getCodexTurnState(undefined, scope).value).toBeNull();
		expect(Object.keys(turn)).toEqual(["id"]);
		expect(JSON.stringify(turn)).not.toContain("first-token");
	});

	const replacements: Array<[string, (base: CodexTurnStateScope) => CodexTurnStateScope]> = [
		["baseUrl", (base) => ({ ...base, baseUrl: "https://different.example/v1" })],
		["credentialId", (base) => ({ ...base, credentialId: "credential-2" })],
		["authorization", (base) => ({ ...base, headers: { Authorization: "Bearer refreshed" } })],
		[
			"account header",
			(base) => ({
				...base,
				headers: { Authorization: "Bearer secret", "ChatGPT-Account-Id": "other-account" },
			}),
		],
		[
			"API key header",
			(base) => ({
				...base,
				headers: { Authorization: "Bearer secret", "X-Api-Key": "other-secret" },
			}),
		],
		[
			"cookie header",
			(base) => ({ ...base, headers: { Authorization: "Bearer secret", Cookie: "auth=other" } }),
		],
	];
	for (const [label, replace] of replacements) {
		test(`replaces the lock when ${label} changes; returning does not revive it`, () => {
			const turn = createProviderTurnContext();
			const initial = getCodexTurnState(turn, scope);
			initial.capture("old-token");
			const changed = getCodexTurnState(turn, replace(scope));
			expect(changed.value).toBeNull();
			changed.capture("new-owner-token");
			expect(getCodexTurnState(turn, scope).value).toBeNull();
		});
	}

	test("header order/case and non-auth headers leave the owner intact", () => {
		const turn = createProviderTurnContext();
		const initial = getCodexTurnState(turn, scope);
		initial.capture("sticky");
		expect(
			getCodexTurnState(turn, {
				...scope,
				headers: new Headers({ "x-custom": "value", authorization: "Bearer secret" }),
			}).value,
		).toBe("sticky");
	});
});

describe("ephemeral Codex metadata evidence redaction", () => {
	test("preserves JSON bytes and user text except secret scalar values", () => {
		const userText = 'examples: "turn_id": "user-owned" and "x-codex-turn-state": "not-a-token"';
		const metadata = { turn_id: "context-secret", "x-codex-turn-state": 'server-"token\\secret' };
		const text = JSON.stringify({ client_metadata: metadata, text: userText }, null, 2);
		const sanitized = redactCodexTurnStateInJsonText(text);
		expect(sanitized).toBe(
			JSON.stringify(
				{
					client_metadata: { turn_id: "[REDACTED]", "x-codex-turn-state": "[REDACTED]" },
					text: userText,
				},
				null,
				2,
			),
		);
		expect(metadata.turn_id).toBe("context-secret");
		expect(redactCodexTurnStateInJsonText(sanitized)).toBe(sanitized);
	});

	test("recognizes case-insensitive/escaped names and numeric metadata tokens", () => {
		const text =
			'{"headers":{"X-Codex-Turn-State":12345},"client_metadata":{"t\\u0075rn_id":"secret"}}';
		expect(redactCodexTurnStateInJsonText(text)).toBe(
			'{"headers":{"X-Codex-Turn-State":"[REDACTED]"},"client_metadata":{"t\\u0075rn_id":"[REDACTED]"}}',
		);
	});

	test("redacts unterminated tokens delivered in an EOF tail frame", () => {
		for (const tail of ['"secret-prefix', '"secret-with-final-slash\\', '"escaped-\\"quote']) {
			const prefix = '{"headers":{"x-codex-turn-state": ';
			expect(redactCodexTurnStateInJsonText(prefix + tail)).toBe(`${prefix}"[REDACTED]"`);
		}
	});
});
