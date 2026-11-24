import { describe, expect, test } from "bun:test";
import { createPluginRoutes, type PluginManager } from "../plugins";

const PLUGIN_ID = "io.narrafork.provider-quota";
const hint = { type: "local", builtinId: PLUGIN_ID };
function manager(
	listResult: unknown,
	detailResult: unknown = listResult,
): PluginManager & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		isEnabled: () => true,
		list: () => {
			calls.push("list");
			return listResult;
		},
		getStatus: () => {
			calls.push("getStatus");
			return detailResult;
		},
		install: async () => ({}),
		enable: async () => ({}),
		disable: async () => ({}),
		activate: async () => ({}),
		uninstall: async () => ({}),
	};
}
const item = (overrides: Record<string, unknown> = {}) => ({
	pluginId: PLUGIN_ID,
	installed: true,
	builtin: false,
	origin: "builtin",
	packageKind: "installed",
	canUninstall: true,
	canUpdate: true,
	sourceHint: hint,
	sourceDiagnostics: [],
	current: { version: "1.0.3", hash: "a".repeat(64) },
	status: "compatible",
	desiredState: "disabled",
	runtimeState: "installed",
	path: "C:/private/plugin/package",
	sourceBinding: { privateToken: "do-not-return" },
	authorityInstallationId: "private-installation-identity",
	rawManifest: { secret: "do-not-return" },
	...overrides,
});
function routes(value: PluginManager) {
	return createPluginRoutes(value, { enabled: true, adminMiddleware: async (_c, next) => next() });
}

describe("safe plugin distribution projection", () => {
	test("installed NF archives keep ordinary uninstall/update capabilities in list and detail", async () => {
		const value = item();
		const source = manager([value], value);
		const app = routes(source);
		const list = await (await app.request("/")).json();
		expect(Array.isArray(list)).toBe(true);
		expect(list[0]).toMatchObject({
			installed: true,
			builtin: false,
			origin: "builtin",
			packageKind: "installed",
			canUninstall: true,
			canUpdate: true,
			sourceHint: hint,
		});
		const detail = await (await app.request(`/${PLUGIN_ID}`)).json();
		expect(detail).toMatchObject({
			origin: "builtin",
			packageKind: "installed",
			canUninstall: true,
			canUpdate: true,
		});
		expect(JSON.stringify({ list, detail })).not.toMatch(
			/private\/plugin|private-installation|privateToken|do-not-return|rawManifest|sourceBinding/,
		);
		expect(source.calls).toEqual(["list", "getStatus"]);
	});

	test("legacy read-only builtin directories remain explicitly non-uninstallable", async () => {
		const value = item({
			builtin: true,
			packageKind: "builtin-directory",
			canUninstall: false,
			canUpdate: false,
		});
		const detail = await (await routes(manager([value], value)).request(`/${PLUGIN_ID}`)).json();
		expect(detail).toMatchObject({
			builtin: true,
			packageKind: "builtin-directory",
			canUninstall: false,
			canUpdate: false,
		});
	});

	test("catalog-style lists derive distribution from the current package without exposing packages or paths", async () => {
		const value = {
			pluginId: PLUGIN_ID,
			status: "compatible",
			packages: [
				item({
					isCurrent: true,
					version: "1.0.3",
					manifest: { displayName: "Provider Quota", raw: "do-not-return" },
				}),
			],
		};
		const list = await (await routes(manager({ plugins: [value] })).request("/")).json();
		expect(list.plugins[0]).toMatchObject({
			installed: true,
			origin: "builtin",
			packageKind: "installed",
			canUninstall: true,
			sourceHint: hint,
			displayName: "Provider Quota",
		});
		expect(list.plugins[0]).not.toHaveProperty("packages");
		expect(JSON.stringify(list)).not.toContain("C:/private");
	});

	test("invalid distribution values and unsafe source hints are omitted rather than coerced", async () => {
		const value = item({
			origin: "private path",
			packageKind: "trusted-anything",
			canUninstall: "true",
			canUpdate: { secret: "do-not-return" },
			sourceHint: {
				type: "website",
				updateApi: "javascript:alert(1)",
				privateToken: "do-not-return",
			},
		});
		const detail = await (await routes(manager([value], value)).request(`/${PLUGIN_ID}`)).json();
		for (const key of ["origin", "packageKind", "canUninstall", "canUpdate", "sourceHint"])
			expect(detail).not.toHaveProperty(key);
		expect(detail.status).toBe("compatible");
		expect(JSON.stringify(detail)).not.toContain("do-not-return");
	});

	test("source diagnostics are bounded fixed projections and cannot expose transport text", async () => {
		const value = item({
			sourceDiagnostics: Array.from({ length: 30 }, () => ({
				code: "SOURCE_INVALID",
				message: "C:/private/path token=secret",
				raw: "do-not-return",
			})),
		});
		const detail = await (await routes(manager([value], value)).request(`/${PLUGIN_ID}`)).json();
		expect(detail.sourceDiagnostics).toHaveLength(10);
		expect(detail.sourceDiagnostics[0]).toEqual({
			code: "SOURCE_INVALID",
			message: "Plugin source metadata is invalid",
		});
		expect(JSON.stringify(detail)).not.toMatch(/token=secret|C:\/private|do-not-return/);
	});

	test("a null optional source and missing legacy distribution fields do not break healthy plugins", async () => {
		const value = {
			pluginId: "com.example.legacy",
			status: "compatible",
			sourceHint: null,
			contributions: [],
		};
		const detail = await (
			await routes(manager([value], value)).request("/com.example.legacy")
		).json();
		expect(detail).toMatchObject({
			pluginId: "com.example.legacy",
			status: "compatible",
			sourceHint: null,
		});
		expect(detail).not.toHaveProperty("origin");
		expect(detail).not.toHaveProperty("canUpdate");
	});
});
