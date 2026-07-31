import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@server/lib/plugins/manifest";
import { PluginCatalog, type PluginContributionSummary } from "@server/services/plugin-catalog";
import { PluginPackageStore } from "@server/services/plugin-package-store";

/**
 * `surfaces` decides where a plugin view may mount. It was declarable in a manifest and
 * enforced when a session was created, but it never reached the host UI, so the client
 * could not tell a settings view from a workspace-only one and the settings surface was
 * effectively unreachable.
 *
 * These tests go through a real catalog scan rather than a private projection helper, so
 * they exercise the path the running host actually uses.
 *
 * Note on scope: an unknown surface name cannot reach the catalog projection at all, because
 * `safeParseManifest` rejects the whole manifest first. That gate is asserted below instead
 * of testing a defensive filter on an unreachable path.
 */

const uiFixture = fileURLToPath(
	new URL("../../fixtures/plugins/e2e/reference-ui-hostile", import.meta.url),
);
const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scanFixture(): Promise<PluginContributionSummary[]> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-view-surfaces-"));
	tempRoots.push(root);
	await new PluginPackageStore(root).install(uiFixture);
	const snapshot = await new PluginCatalog(root).scan();
	return snapshot.packages.flatMap((pkg) => pkg.contributions);
}

function views(contributions: PluginContributionSummary[]): PluginContributionSummary[] {
	return contributions.filter((contribution) => contribution.kind === "view");
}

describe("plugin view surfaces reach the catalog", () => {
	test("carries the declared surfaces through for each view", async () => {
		const contributions = await scanFixture();
		const declared = views(contributions);
		expect(declared.length).toBeGreaterThan(0);

		const hostile = declared.find((view) => view.id === "hostile-panel");
		const quiet = declared.find((view) => view.id === "quiet-panel");
		expect(hostile?.surfaces).toEqual(["workspace", "settings"]);
		// A workspace-only view must not acquire the settings surface by accident.
		expect(quiet?.surfaces).toEqual(["workspace"]);
	});

	test("omits surfaces for non-view contributions", async () => {
		const contributions = await scanFixture();
		const others = contributions.filter((contribution) => contribution.kind !== "view");
		for (const contribution of others) expect(contribution.surfaces).toBeUndefined();
	});

	test("manifest schema still rejects an unknown surface outright", async () => {
		const raw = JSON.parse(await readFile(join(uiFixture, "manifest.json"), "utf8"));
		raw.contributes.views[0].surfaces = ["settings", "not-a-surface"];
		// The projection is defence in depth; the schema remains the primary gate.
		expect(() => parseManifest(raw)).toThrow();
	});

	test("the fixture still declares a settings view, which the surface tab depends on", async () => {
		const raw = JSON.parse(await readFile(join(uiFixture, "manifest.json"), "utf8"));
		const settingsViews = (raw.contributes.views as Array<Record<string, unknown>>).filter(
			(view) => Array.isArray(view.surfaces) && view.surfaces.includes("settings"),
		);
		expect(settingsViews.length).toBeGreaterThan(0);
		// The settings surface has no workspace/narrator/project in scope, so a settings view
		// must be global-scoped to be mountable there.
		expect(settingsViews.every((view) => view.scope === "global")).toBe(true);
	});
});
