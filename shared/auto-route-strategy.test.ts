import { describe, expect, test } from "bun:test";
import { type AutoRouteSignals, orderAutoCandidates } from "./auto-route-strategy";

const c = (
	value: string,
	available: boolean,
	subscription: boolean,
	referencePrice?: number,
): AutoRouteSignals => ({
	value,
	available,
	subscription,
	...(referencePrice !== undefined ? { referencePrice } : {}),
});

describe("auto route ordering", () => {
	test("available subscriptions first, then cheaper pay-per-use, unavailable last", () => {
		expect(
			orderAutoCandidates([
				c("api-expensive", true, false, 20),
				c("codex-out", false, true),
				c("api-cheap", true, false, 5),
				c("kimi", true, true),
				c("api-unknown", true, false),
			]),
		).toEqual(["kimi", "api-cheap", "api-expensive", "api-unknown", "codex-out"]);
	});

	test("ties keep provider order", () => {
		expect(orderAutoCandidates([c("b", true, false, 5), c("a", true, false, 5)])).toEqual([
			"b",
			"a",
		]);
		expect(orderAutoCandidates([c("x", true, true), c("y", true, true)])).toEqual(["x", "y"]);
	});
});
