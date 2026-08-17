import { describe, expect, test } from "bun:test";
import { isGatewayEventType, parseGatewaySSEEvent } from "../gateway-events";

describe("gateway model catalog events", () => {
	test("ignores hash-only catalog events", () => {
		expect(parseGatewaySSEEvent("modelCatalogEvent", { modelHash: "hash-1" })).toBeNull();
	});

	test("parses catalog events only when models are present", () => {
		expect(
			parseGatewaySSEEvent("modelCatalogEvent", {
				modelHash: "hash-1",
				models: [{ id: "model-a" }, null, "bad"],
			}),
		).toEqual({ nugModelCatalog: { modelHash: "hash-1", models: [{ id: "model-a" }] } });
	});

	test("allows explicit empty catalog snapshots", () => {
		expect(parseGatewaySSEEvent("modelCatalogEvent", { hash: "empty", models: [] })).toEqual({
			nugModelCatalog: { modelHash: "empty", models: [] },
		});
	});
});

describe("gateway image cache ack events", () => {
	test("is recognized as a gateway event type", () => {
		expect(isGatewayEventType("imageCacheAckEvent")).toBe(true);
	});

	test("parses refs array", () => {
		expect(
			parseGatewaySSEEvent("imageCacheAckEvent", { refs: ["sha256:aaa", "sha256:bbb"] }),
		).toEqual({ nugImageCacheAck: { refs: ["sha256:aaa", "sha256:bbb"] } });
	});

	test("filters out non-string and empty refs", () => {
		expect(
			parseGatewaySSEEvent("imageCacheAckEvent", { refs: ["sha256:aaa", "", 5, null] }),
		).toEqual({ nugImageCacheAck: { refs: ["sha256:aaa"] } });
	});

	test("returns null when refs is not an array", () => {
		expect(parseGatewaySSEEvent("imageCacheAckEvent", { refs: "sha256:aaa" })).toBeNull();
	});

	test("allows explicit empty refs", () => {
		expect(parseGatewaySSEEvent("imageCacheAckEvent", { refs: [] })).toEqual({
			nugImageCacheAck: { refs: [] },
		});
	});
});

describe("gateway metering events", () => {
	test("parses credit consumption with default units", () => {
		expect(parseGatewaySSEEvent("meteringEvent", { usage: 12.5 })).toEqual({
			metering: { unit: "credit", unitPlural: "credits", usage: 12.5 },
		});
	});

	test("honours gateway-supplied unit names", () => {
		expect(
			parseGatewaySSEEvent("meteringEvent", { usage: 1, unit: "point", unitPlural: "points" }),
		).toEqual({ metering: { unit: "point", unitPlural: "points", usage: 1 } });
	});

	test("accepts a numeric string, which the gateway sends for exact decimals", () => {
		expect(parseGatewaySSEEvent("meteringEvent", { usage: "0.75" })).toEqual({
			metering: { unit: "credit", unitPlural: "credits", usage: 0.75 },
		});
	});

	// A missing or unusable usage yields null rather than a zero-usage event: the
	// loop treats metering as a real measurement, so 0 renders the request as free.
	test("ignores events with no usable usage", () => {
		expect(parseGatewaySSEEvent("meteringEvent", {})).toBeNull();
		expect(parseGatewaySSEEvent("meteringEvent", { usage: "abc" })).toBeNull();
		expect(parseGatewaySSEEvent("meteringEvent", { usage: Number.NaN })).toBeNull();
	});

	test("a genuine zero is still reported", () => {
		expect(parseGatewaySSEEvent("meteringEvent", { usage: 0 })).toEqual({
			metering: { unit: "credit", unitPlural: "credits", usage: 0 },
		});
	});
});

describe("gateway context usage events", () => {
	test("parses the camelCase spelling", () => {
		expect(parseGatewaySSEEvent("contextUsageEvent", { contextUsagePercentage: 34.5 })).toEqual({
			contextUsagePercentage: 34.5,
		});
	});

	// Both spellings are accepted because the gateway forwards whichever the
	// upstream sent.
	test("parses the snake_case spelling", () => {
		expect(parseGatewaySSEEvent("contextUsageEvent", { context_usage_percentage: 12 })).toEqual({
			contextUsagePercentage: 12,
		});
	});

	test("ignores events with no usable percentage", () => {
		expect(parseGatewaySSEEvent("contextUsageEvent", {})).toBeNull();
		expect(parseGatewaySSEEvent("contextUsageEvent", { contextUsagePercentage: "n/a" })).toBeNull();
	});
});

describe("gateway event type recognition", () => {
	// The Anthropic SSE parser short-circuits on this predicate, so a name missing
	// from it would be parsed as protocol content and silently dropped.
	test("recognises every gateway-injected name", () => {
		for (const name of [
			"queueEvent",
			"quotaBalanceEvent",
			"modelCatalogEvent",
			"imageCacheAckEvent",
			"meteringEvent",
			"contextUsageEvent",
		]) {
			expect(isGatewayEventType(name)).toBe(true);
		}
	});

	test("does not claim real protocol events", () => {
		for (const name of [
			"message_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
			"error",
			"",
		]) {
			expect(isGatewayEventType(name)).toBe(false);
		}
	});
});
