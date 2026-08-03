import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginPackageStore } from "@server/services/plugin-package-store";

/**
 * Stage D acceptance for the example plugin's `provider-settings` view.
 *
 * The chain that has to hold end to end:
 *
 *   manifest declares the view + providerId
 *     → the catalog reports its surfaces to the host
 *       → the provider settings page can tell it apart from a workspace-only view
 *
 * A break anywhere in that chain shows up as "the plugin's settings UI silently never
 * appears", with the host falling back to the generated form and no error anywhere.
 */

const exampleRoot = join(import.meta.dir, "../../../../examples/plugins/provider");
const fixtureRoot = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-provider-rpc");

async function loadManifest(root: string) {
	return parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
}

describe("example plugin provider-settings view", () => {
	test("the shipped example and the e2e fixture stay in sync", async () => {
		for (const file of [
			"manifest.json",
			"server/index.js",
			"ui/provider-settings.iife.js",
			"ui/provider-settings.css",
		]) {
			expect(await readFile(join(fixtureRoot, file), "utf8")).toBe(
				await readFile(join(exampleRoot, file), "utf8"),
			);
		}
	});

	test("declares the view bound to its own provider", async () => {
		const manifest = await loadManifest(exampleRoot);
		const [view] = manifest.contributes.views;
		expect(view).toBeDefined();
		expect(view?.surfaces).toEqual(["provider-settings"]);
		// The binding is what lets the host mount this view for THIS provider rather than
		// guessing when a plugin contributes several.
		expect(view?.providerId).toBe("example-provider");
		expect(manifest.contributes.providers.some((p) => p.id === view?.providerId)).toBe(true);
		// A global scope is required: the provider settings page has no workspace,
		// narrator or project in scope to satisfy anything narrower.
		expect(view?.scope).toBe("global");
	});

	test("requests the capabilities the view actually needs", async () => {
		const manifest = await loadManifest(exampleRoot);
		// `ui.panel` gates session creation; without it `assertUiContribution` rejects.
		expect(manifest.permissions.host).toContain("ui.panel");
		// The view reads its own config through `config.get`.
		expect(manifest.permissions.host).toContain("config.read_self");
		// It must NOT ask for secret write access: the sandbox contract keeps secret values
		// away from UI surfaces entirely.
		expect(manifest.permissions.host).not.toContain("secret.use_self");
	});

	test("the catalog reports the view's surfaces to the host", async () => {
		// Goes through a real install + scan rather than a private projection helper, so it
		// exercises the path the running host uses.
		const root = await mkdtemp(join(tmpdir(), "narrafork-provider-view-"));
		try {
			await new PluginPackageStore(root).install(exampleRoot);
			const snapshot = await new PluginCatalog(root).scan();
			const contributions = snapshot.packages.flatMap((pkg) => pkg.contributions);
			const view = contributions.find((item) => item.kind === "view");
			expect(view?.surfaces).toEqual(["provider-settings"]);
			// Without this the client could not distinguish a provider-settings view from a
			// workspace one, and the settings tab would never offer it.
			expect(view?.scope).toBe("global");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the view script only uses SDK methods the host actually exposes", async () => {
		const source = await readFile(join(exampleRoot, "ui/provider-settings.iife.js"), "utf8");
		// These two are the host methods wired in phase C-2a. A view calling anything else
		// would fail at runtime with no manifest-time warning.
		expect(source).toContain('sdk.request("config.get")');
		expect(source).toContain('sdk.request("secrets.list")');
		// It must not try to read secret values; only presence is available to a UI.
		expect(source).not.toContain('"secrets.get"');
		// And it must not reach for the admin HTTP API from inside the iframe.
		expect(source).not.toContain("fetch(");
	});
});
