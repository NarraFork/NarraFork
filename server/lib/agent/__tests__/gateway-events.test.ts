import { describe, expect, test } from "bun:test";
import { parseGatewaySSEEvent } from "../gateway-events";

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
