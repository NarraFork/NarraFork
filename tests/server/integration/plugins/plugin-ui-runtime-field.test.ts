/**
 * End-to-end check that a view's `runtime: "host-react"` declaration survives every hop
 * between the manifest and the iframe shell.
 *
 * This test exists because of a bug it is modelled on: `provider-settings` was a valid
 * manifest surface, accepted by the schema and re-checked by the session route, yet the
 * contributions endpoint filtered it out of its response. Nothing failed — the client simply
 * never saw it and quietly mounted the host's generated form instead. A dropped `runtime`
 * field fails the same silent way: the panel loads, finds no React on the global, and either
 * renders nothing or throws from inside plugin code, with no hint that the host never
 * injected the runtime.
 *
 * Every hop is asserted separately so a regression names the layer that broke:
 *   manifest schema → catalog projection → HTTP response → client store → iframe shell.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiddlewareHandler } from "hono";
import { createPluginAssetShell } from "../../../../frontend/components/plugins/asset-shell";
import { parsePluginContributionItems } from "../../../../frontend/components/plugins/PluginContributionStore";
import { safeParseManifest } from "../../../../server/lib/plugins/manifest";
import { createPluginUiRoutes } from "../../../../server/routes/plugin-ui";
import { PluginCatalog } from "../../../../server/services/plugin-catalog";
import { PluginPackageStore } from "../../../../server/services/plugin-package-store";

const HASH = "a".repeat(64);

const validPackage = fileURLToPath(
	new URL("../../../fixtures/plugins/packages/valid-package", import.meta.url),
);
const tempRoots: string[] = [];

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * Install a package whose single view carries `runtime`, then scan it.
 *
 * The projection is internal to `PluginCatalog`, so this drives it the way the catalog's own
 * tests do: through a real install + scan rather than by reaching for a private function.
 */
async function scanViewContribution(view: Record<string, unknown>) {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-runtime-field-"));
	tempRoots.push(root);
	const source = join(root, "source");
	await cp(validPackage, source, { recursive: true });
	const manifestPath = join(source, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
	manifest.pluginId = "com.example.runtimefield";
	manifest.displayName = "Runtime field";
	manifest.activationEvents = [`onView:${String(view.id)}`];
	// A view contribution requires a top-level `ui` block.
	manifest.ui = { entry: "ui/panel.js", format: "iife", shell: "host-controlled" };
	manifest.contributes = {
		// The view binds to `provider-settings`, which requires a `providerId` pointing at a
		// provider this manifest actually declares.
		providers: [
			{ id: "demo", title: "Demo", providerPrefix: "demo", capabilities: { chat: true } },
		],
		tools: [],
		commands: [],
		events: [],
		views: [{ ...view, entry: "ui/panel.js" }],
	};
	await mkdir(join(source, "ui"), { recursive: true });
	await writeFile(join(source, "ui", "panel.js"), "/* fixture */\n");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const installed = await new PluginPackageStore(root).install(source);
	const snapshot = await new PluginCatalog(root).scan();
	return snapshot.packages
		.find((item) => item.hash === installed.hash)
		?.contributions.find((item) => item.kind === "view");
}

function manifestWithView(view: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		pluginId: "com.example.runtime",
		version: "1.0.0",
		displayName: "Runtime probe",
		publisher: { id: "com.example", name: "Example" },
		engine: {
			runtime: "bun",
			runtimeVersion: ">=1.2 <2",
			hostApi: ">=1.0 <2",
			rpc: "narrafork.rpc/1",
			os: ["linux"],
			arch: ["x64"],
			runner: "local-process",
		},
		// Cross-field rules: a provider contribution requires `server`, and a view
		// contribution requires `ui`.
		server: { entry: "server/index.js", transport: "stdio", protocol: "narrafork.rpc/1" },
		ui: { entry: "ui/settings.js", format: "iife", shell: "host-controlled" },
		activationEvents: ["onProvider:demo"],
		contributes: {
			providers: [
				{
					id: "demo",
					title: "Demo",
					providerPrefix: "demo",
					capabilities: { chat: true },
				},
			],
			views: [view],
		},
		permissions: {
			host: ["provider.register", "ui.panel"],
			filesystem: { package: "readOnly", pluginData: "readWrite", workspace: "none" },
			process: { spawn: "none" },
		},
	};
}

const hostReactView = {
	id: "settings",
	title: "Settings",
	entry: "ui/settings.js",
	surfaces: ["provider-settings"],
	scope: "global",
	instance: "singleton",
	providerId: "demo",
	runtime: "host-react",
};

const allowAuth: MiddlewareHandler = async (_c, next) => {
	await next();
};

async function fetchContributions(view: Record<string, unknown>) {
	const app = createPluginUiRoutes({
		authMiddleware: allowAuth,
		pluginManager: {
			list: async () => [
				{
					pluginId: "com.example.runtime",
					desiredState: "enabled",
					current: { version: "1.0.0", hash: HASH },
					contributions: [{ kind: "view", ...view }],
				},
			],
		} as never,
	});
	const response = await app.request("/ui/contributions");
	expect(response.status).toBe(200);
	return (await response.json()) as Array<Record<string, unknown>>;
}

describe("plugin view runtime field", () => {
	it("is accepted by the manifest schema", () => {
		const parsed = safeParseManifest(manifestWithView(hostReactView));
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.contributes.views[0]?.runtime).toBe("host-react");
	});

	it("rejects an unknown runtime name instead of ignoring it", () => {
		// `.strict()` plus a literal: a typo must fail at install time rather than leave the
		// view silently running without the runtime it asked for.
		const parsed = safeParseManifest(manifestWithView({ ...hostReactView, runtime: "host-vue" }));
		expect(parsed.success).toBe(false);
	});

	it("survives the catalog contribution projection", async () => {
		const view = await scanViewContribution(hostReactView);
		expect(view?.runtime).toBe("host-react");
	});

	it("is absent from the catalog projection when not declared", async () => {
		const { runtime: _runtime, ...plain } = hostReactView;
		const view = await scanViewContribution(plain);
		expect(view?.runtime).toBeUndefined();
	});

	it("is reported by GET /ui/contributions", async () => {
		const [item] = await fetchContributions(hostReactView);
		expect(item.runtime).toBe("host-react");
	});

	it("is omitted by GET /ui/contributions when not declared", async () => {
		const { runtime: _runtime, ...plain } = hostReactView;
		const [item] = await fetchContributions(plain);
		expect(item.runtime).toBeUndefined();
	});

	it("is parsed into the client contribution store", () => {
		const [record] = parsePluginContributionItems([
			{
				pluginId: "com.example.runtime",
				contributionId: "settings",
				version: "1.0.0",
				hash: HASH,
				title: "Settings",
				surfaces: ["provider-settings"],
				runtime: "host-react",
				status: "available",
			},
		]);
		expect(record?.runtime).toBe("host-react");
	});

	it("drops an unknown runtime name in the client store", () => {
		const [record] = parsePluginContributionItems([
			{
				pluginId: "com.example.runtime",
				contributionId: "settings",
				version: "1.0.0",
				hash: HASH,
				title: "Settings",
				runtime: "host-svelte",
				status: "available",
			},
		]);
		// A newer backend may offer a runtime this client cannot inject; leaving the view on
		// its own bundle is the safe reading.
		expect(record?.runtime).toBeUndefined();
	});

	it("injects the runtime into the iframe shell, before the plugin entry", () => {
		const shell = createPluginAssetShell({
			nonce: "b".repeat(32),
			pluginId: "com.example.runtime",
			contributionId: "settings",
			panelInstanceId: "panel-1",
			entryUrl: "/api/plugins/ui/entry.js",
			runtimeUrl: "/plugin-runtime/vendor.js",
			runtimeStyleUrl: "/plugin-runtime/vendor.css",
		});
		expect(shell).toContain("/plugin-runtime/vendor.js");
		expect(shell).toContain("/plugin-runtime/vendor.css");
		// The entry must be chained off the runtime's load event, not appended alongside it.
		expect(shell).toContain("runtime.onload");
		expect(shell).toContain("runtime-load-failed");
	});

	it("leaves the shell free of runtime references when the view did not opt in", () => {
		const shell = createPluginAssetShell({
			nonce: "b".repeat(32),
			pluginId: "com.example.runtime",
			contributionId: "settings",
			panelInstanceId: "panel-1",
			entryUrl: "/api/plugins/ui/entry.js",
		});
		expect(shell).not.toContain("/plugin-runtime/");
	});
});
