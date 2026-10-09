import { describe, expect, it } from "bun:test";
import {
	parseTokenDanceRecoveryAction,
	selectTokenDanceProtocol,
	TOKENDANCE_APP_URL,
} from "./tokendance";

describe("TokenDance public contract", () => {
	it("keeps the application attribution stable across deployments", () => {
		expect(TOKENDANCE_APP_URL).toBe("https://tokendanceconnect.narrafork.dev/");
	});
	it.each([
		["openai:responses", "openai-responses"],
		["anthropic:messages", "anthropic-messages"],
		["openai:chat-completions", "completions-compatible"],
		["gemini:generate-content", "gemini-compatible"],
	] as const)("maps the declared %s protocol", (upstream, local) => {
		expect(selectTokenDanceProtocol([upstream])).toBe(local);
	});
	it("selects a stable protocol independent of the catalog's array order", () => {
		expect(
			selectTokenDanceProtocol([
				"gemini:generate-content",
				"openai:chat-completions",
				"anthropic:messages",
				"openai:responses",
			]),
		).toBe("openai-responses");
		expect(selectTokenDanceProtocol(["openai:chat-completions", "anthropic:messages"])).toBe(
			"anthropic-messages",
		);
	});
	it("never guesses a protocol for media-only or unknown capabilities", () => {
		for (const list of [
			[],
			["openai:image-generations"],
			["minimax:video_generation_v2"],
			["claude"],
			["openai"],
		]) {
			expect(selectTokenDanceProtocol(list)).toBeUndefined();
		}
	});
	it("recognizes only the three documented recovery actions", () => {
		for (const action of ["top_up_balance", "reauthorize_api_key", "api_key_quota"] as const) {
			expect(parseTokenDanceRecoveryAction(action)).toBe(action);
		}
		for (const value of [
			undefined,
			null,
			{},
			"top_up",
			"TOP_UP_BALANCE",
			"https://untrusted.example/",
		]) {
			expect(parseTokenDanceRecoveryAction(value)).toBeUndefined();
		}
	});
});
