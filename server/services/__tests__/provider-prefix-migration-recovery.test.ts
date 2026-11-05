import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { narraforkDir } from "../../lib/settings";
import { recoverProviderPrefixMigrationOnStartup } from "../provider-prefix-migration-service";

const journalPath = join(narraforkDir, "provider-prefix-migration.json");

afterEach(() => rmSync(journalPath, { force: true }));

describe("recoverProviderPrefixMigrationOnStartup", () => {
	test("a journal that matches neither side of the settings does not stop startup", () => {
		writeFileSync(
			journalPath,
			JSON.stringify({
				version: 1,
				changes: [{ id: "provider-that-is-not-configured", from: "old", to: "new" }],
				narrators: [],
			}),
		);
		expect(() => recoverProviderPrefixMigrationOnStartup()).not.toThrow();
		// Kept: it is the only record of which narrators the interrupted rename touched.
		expect(existsSync(journalPath)).toBe(true);
	});

	test("an unreadable journal does not stop startup either", () => {
		writeFileSync(journalPath, "{ not json");
		expect(() => recoverProviderPrefixMigrationOnStartup()).not.toThrow();
		expect(existsSync(journalPath)).toBe(true);
	});
});
