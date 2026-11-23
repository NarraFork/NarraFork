import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, narraforkDir, reloadSettings } from "../index";

const path = join(narraforkDir, "settings.json");
let original: string;

beforeEach(() => {
	original = readFileSync(path, "utf8");
});
afterEach(() => {
	writeFileSync(path, original);
	reloadSettings();
});

function writeSettings(extra: Record<string, unknown>) {
	const base = JSON.parse(original);
	delete base.workspace;
	writeFileSync(path, JSON.stringify({ ...base, ...extra }));
}

describe("chapter settings retirement", () => {
	test("moves a stored tree-snapshot switch to the workspace group and drops the old groups", () => {
		writeSettings({
			chapters: { treeSnapshotsEnabled: false, maxActiveWorktrees: 3 },
			containers: { portRangeStart: 12000 },
		});
		expect(reloadSettings().workspace.treeSnapshotsEnabled).toBe(false);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.workspace.treeSnapshotsEnabled).toBe(false);
		expect(saved.chapters).toBeUndefined();
		expect(saved.containers).toBeUndefined();
		// The default itself is untouched by the migration.
		expect(DEFAULTS.workspace.treeSnapshotsEnabled).toBe(false);
	});

	test("an explicit workspace value wins over a leftover chapters value", () => {
		writeSettings({
			chapters: { treeSnapshotsEnabled: false },
			workspace: { treeSnapshotsEnabled: true },
		});
		expect(reloadSettings().workspace.treeSnapshotsEnabled).toBe(true);
	});

	test("installs without the old group keep the default", () => {
		writeSettings({});
		expect(reloadSettings().workspace.treeSnapshotsEnabled).toBe(false);
	});
});
