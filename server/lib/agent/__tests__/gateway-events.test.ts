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
