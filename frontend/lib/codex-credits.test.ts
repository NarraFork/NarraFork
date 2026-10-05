import { describe, expect, test } from "bun:test";
import { getCodexCreditsDisplay } from "./codex-credits";

describe("getCodexCreditsDisplay", () => {
	test("returns null when no credits snapshot was reported", () => {
		expect(getCodexCreditsDisplay(undefined)).toBeNull();
	});

	test("unlimited wins over any balance value", () => {
		expect(getCodexCreditsDisplay({ has_credits: true, unlimited: true, balance: null })).toEqual({
			kind: "unlimited",
		});
		expect(
			getCodexCreditsDisplay({ has_credits: true, unlimited: true, balance: "999.5" }),
		).toEqual({ kind: "unlimited" });
	});

	test("has_credits=false shows 0 regardless of balance", () => {
		expect(getCodexCreditsDisplay({ has_credits: false, unlimited: false, balance: null })).toEqual(
			{ kind: "balance", value: "0" },
		);
		expect(
			getCodexCreditsDisplay({ has_credits: false, unlimited: false, balance: "12.5" }),
		).toEqual({ kind: "balance", value: "0" });
	});

	test("keeps the balance string verbatim to preserve precision", () => {
		expect(
			getCodexCreditsDisplay({
				has_credits: true,
				unlimited: false,
				balance: "123.456789012345678",
			}),
		).toEqual({ kind: "balance", value: "123.456789012345678" });
	});

	test("falls back to 0 when balance is null but credits exist", () => {
		expect(getCodexCreditsDisplay({ has_credits: true, unlimited: false, balance: null })).toEqual({
			kind: "balance",
			value: "0",
		});
	});
});
