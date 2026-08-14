import { describe, expect, test } from "bun:test";
import { seedGrantsFromManifest } from "../plugin-manager";

const MANIFEST_HOST = [
	"query.read.narrators",
	"ui.panel",
	"event.subscribe",
	"storage.read_self",
];

function summary(capabilities: string[], revision = 1) {
	return { count: capabilities.length, capabilities, revision };
}

describe("seedGrantsFromManifest", () => {
	test("seeds the full manifest when no grants exist yet", () => {
		const result = seedGrantsFromManifest(summary([], 0), MANIFEST_HOST, {
			pluginId: "com.example.p",
		});
		expect(result.count).toBe(4);
		expect(result.capabilities).toEqual(
			expect.arrayContaining(["query.read.narrators", "ui.panel", "event.subscribe"]),
		);
	});

	test("keeps existing grants untouched without merge (enable/restore path)", () => {
		const existing = summary(["query.read.narrators", "ui.panel"], 3);
		const result = seedGrantsFromManifest(existing, MANIFEST_HOST, { pluginId: "com.example.p" });
		expect(result).toBe(existing);
		expect(result.capabilities).not.toContain("event.subscribe");
	});

	test("extends grants on upgrade (merge) with capabilities the new manifest declares", () => {
		const existing = summary(["query.read.narrators", "ui.panel"], 3);
		const result = seedGrantsFromManifest(existing, MANIFEST_HOST, { pluginId: "com.example.p" }, true);
		expect(result.count).toBe(4);
		expect(result.capabilities).toEqual(
			expect.arrayContaining(["event.subscribe", "storage.read_self"]),
		);
		// Preserved existing grants and revision
		expect(result.capabilities).toContain("query.read.narrators");
		expect(result.revision).toBe(3);
	});

	test("merge is idempotent: no change when nothing is missing", () => {
		const existing = summary(MANIFEST_HOST, 3);
		const result = seedGrantsFromManifest(existing, MANIFEST_HOST, { pluginId: "com.example.p" }, true);
		expect(result).toBe(existing);
	});
});
