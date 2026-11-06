import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { narraforkDir } from "../../lib/settings";
import { recoverProviderPrefixMigrationOnStartup } from "../provider-prefix-migration-service";

const journalPath = join(narraforkDir, "provider-prefix-migration.json");
const unresolved = () =>
	readdirSync(narraforkDir).filter((name) =>
		name.startsWith("provider-prefix-migration.unresolved-"),
	);

afterEach(() => {
	rmSync(journalPath, { force: true });
	for (const name of unresolved()) rmSync(join(narraforkDir, name), { force: true });
});

describe("recoverProviderPrefixMigrationOnStartup", () => {
	test("a journal that matches neither side of the settings does not stop startup", () => {
		const journal = JSON.stringify({
			version: 1,
			changes: [{ id: "provider-that-is-not-configured", from: "old", to: "new" }],
			narrators: [],
		});
		writeFileSync(journalPath, journal);
		expect(() => recoverProviderPrefixMigrationOnStartup()).not.toThrow();
		// Set aside rather than left in place, where the next rename would overwrite it.
		expect(existsSync(journalPath)).toBe(false);
		const kept = unresolved();
		expect(kept).toHaveLength(1);
		expect(readFileSync(join(narraforkDir, kept[0] ?? ""), "utf8")).toBe(journal);
	});

	test("an unreadable journal does not stop startup either", () => {
		writeFileSync(journalPath, "{ not json");
		expect(() => recoverProviderPrefixMigrationOnStartup()).not.toThrow();
		expect(unresolved()).toHaveLength(1);
	});
});
