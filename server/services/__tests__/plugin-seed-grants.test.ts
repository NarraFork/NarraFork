import { describe, expect, test } from "bun:test";
import { seedGrantsFromManifest } from "../plugin-manager";

const MANIFEST_HOST = ["query.read.narrators", "ui.panel", "event.subscribe", "storage.read_self"];

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

	test("keeps existing grants untouched (enable/restore path)", () => {
		const existing = summary(["query.read.narrators", "ui.panel"], 3);
		const result = seedGrantsFromManifest(existing, MANIFEST_HOST, { pluginId: "com.example.p" });
		expect(result).toBe(existing);
		expect(result.capabilities).not.toContain("event.subscribe");
	});

	// The upgrade path used to append newly declared capabilities here (merge mode).
	// It must not: the new package inherits this grant list through the stable
	// installation identity, so appending would widen access under an identity the
	// admin approved for the OLD manifest. The extras are raised as pending approval
	// requests instead (plugin-manager `requestUndeclaredManifestCapabilities`).
	test("an upgrade declaring more capabilities does not extend the grant list", () => {
		const existing = summary(["query.read.narrators", "ui.panel"], 3);
		const result = seedGrantsFromManifest(existing, MANIFEST_HOST, { pluginId: "com.example.p" });
		expect(result).toBe(existing);
		expect(result.capabilities).not.toContain("event.subscribe");
		expect(result.capabilities).not.toContain("storage.read_self");
		expect(result.count).toBe(2);
		expect(result.revision).toBe(3);
	});

	test("a revoked-to-empty grant list is re-seeded only when nothing was ever granted", () => {
		// count/capabilities both empty is indistinguishable from a fresh install, which
		// is why revocation removes grants but keeps the record — asserted here so a
		// future refactor cannot quietly turn "admin revoked everything" into a re-seed.
		const fresh = seedGrantsFromManifest(summary([], 0), MANIFEST_HOST, {
			pluginId: "com.example.p",
		});
		expect(fresh.count).toBe(4);
		const partiallyRevoked = summary(["ui.panel"], 5);
		expect(
			seedGrantsFromManifest(partiallyRevoked, MANIFEST_HOST, { pluginId: "com.example.p" }),
		).toBe(partiallyRevoked);
	});
});
