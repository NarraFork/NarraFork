import { describe, expect, it } from "bun:test";
import {
	dispatchTokenDanceRecovery,
	getTokenDanceRecoveryDetail,
	TOKENDANCE_RECOVERY_EVENT,
} from "./tokendance-recovery";

const error = (action: unknown, provider = "tokendance") => ({
	type: "narrator_error",
	narratorId: "narrator-one",
	diagnostics: { provider, tokendanceRecoveryAction: action },
});

describe("TokenDance recovery notifications", () => {
	it.each([
		"top_up_balance",
		"reauthorize_api_key",
		"api_key_quota",
	])("preserves only the confirmed %s recovery action", (action) => {
		expect(getTokenDanceRecoveryDetail(error(action))).toEqual({
			action,
			narratorId: "narrator-one",
		});
	});
	it("ignores unknown actions and other providers", () => {
		expect(getTokenDanceRecoveryDetail(error("open_arbitrary_url"))).toBeUndefined();
		expect(getTokenDanceRecoveryDetail(error("top_up_balance", "nug"))).toBeUndefined();
		expect(getTokenDanceRecoveryDetail(error("top_up_balance", "openai"))).toBeUndefined();
		for (const input of [null, [], false, {}, { diagnostics: [] }]) {
			expect(getTokenDanceRecoveryDetail(input)).toBeUndefined();
		}
	});
	it("does not retain arbitrary upstream URLs or secret payload fields", () => {
		expect(
			getTokenDanceRecoveryDetail({
				...error("top_up_balance"),
				key: "secret-key",
				url: "https://untrusted.example/",
				diagnostics: {
					...error("top_up_balance").diagnostics,
					responseSnippet: "secret-key",
					recoveryUrl: "https://untrusted.example/",
				},
			}),
		).toEqual({ action: "top_up_balance", narratorId: "narrator-one" });
	});
	it("dispatches actionable narrator errors without mutating the original event", () => {
		const target = new EventTarget();
		const details: unknown[] = [];
		target.addEventListener(TOKENDANCE_RECOVERY_EVENT, (event) => {
			details.push((event as CustomEvent).detail);
		});
		const data = error("reauthorize_api_key");
		const before = JSON.stringify(data);
		dispatchTokenDanceRecovery(data, target);
		expect(details).toEqual([{ action: "reauthorize_api_key", narratorId: "narrator-one" }]);
		expect(JSON.stringify(data)).toBe(before);
		dispatchTokenDanceRecovery({ ...data, type: "narrator_status" }, target);
		dispatchTokenDanceRecovery(error("reauthorize_api_key", "anthropic"), target);
		dispatchTokenDanceRecovery(error(null), target);
		expect(details).toHaveLength(1);
	});
});
