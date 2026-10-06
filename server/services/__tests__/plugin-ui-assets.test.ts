import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginUiAssetService } from "../plugin-ui-assets";

const pluginId = "com.example.ui";
const version = "1.0.0";
const hash = "a".repeat(64);

async function setup(options: { asset?: string; includeQuiet?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-ui-"));
	const packagePath = join(root, "packages", pluginId, version, hash);
	await mkdir(join(packagePath, "ui"), { recursive: true });
	const views = [
		{
			id: "panel",
			title: "Panel",
			entry: "ui/index.js",
			style: "ui/style.css",
			surfaces: ["workspace"],
			scope: "workspace",
			instance: "multiple",
		},
		...(options.includeQuiet
			? [
					{
						id: "quiet",
						title: "Quiet",
						entry: "ui/quiet.js",
						style: "ui/quiet.css",
						surfaces: ["workspace"],
						scope: "workspace",
						instance: "multiple",
					},
				]
			: []),
	];
	const manifest = {
		schemaVersion: 1,
		pluginId,
		version,
		displayName: "UI",
		engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
		ui: { entry: "ui/index.js", style: "ui/style.css" },
		activationEvents: views.map((view) => `onView:${view.id}`),
		contributes: { views },
		permissions: {
			host: ["ui.panel"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
			process: { spawn: "none" },
		},
	};
	await writeFile(join(packagePath, "manifest.json"), JSON.stringify(manifest));
	await writeFile(join(packagePath, "ui/index.js"), options.asset ?? "console.log('ok')");
	await writeFile(join(packagePath, "ui/style.css"), "body { color: red; }");
	if (options.includeQuiet) {
		await writeFile(join(packagePath, "ui/quiet.js"), "console.log('quiet')");
		await writeFile(join(packagePath, "ui/quiet.css"), "body { color: blue; }");
	}
	return { root, packagePath };
}

async function setupThemeFont(options: { invalidMagic?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-font-"));
	const packagePath = join(root, "packages", pluginId, version, hash);
	await mkdir(join(packagePath, "assets"), { recursive: true });
	const fonts = [
		{
			id: "brand",
			source: "assets/brand.woff2",
			weight: { min: 100, max: 900 },
			style: "normal",
			display: "swap",
		},
	];
	const manifest = {
		schemaVersion: 1,
		pluginId,
		version,
		displayName: "Theme Font",
		engine: { runtime: "bun", hostApi: ">=1.0 <2", rpc: "narrafork.rpc/1" },
		activationEvents: [],
		contributes: {
			themes: [
				{
					id: "font-theme",
					title: "Font Theme",
					colorScheme: "both",
					fonts,
					tokens: { fontFamily: { font: "brand", fallback: "system-ui" } },
				},
			],
		},
		permissions: {
			host: ["ui.theme"],
			network: { mode: "none", allow: [] },
			filesystem: { package: "readOnly", pluginData: "none", workspace: "none" },
			process: { spawn: "none" },
		},
	};
	await writeFile(join(packagePath, "manifest.json"), JSON.stringify(manifest));
	const magic = options.invalidMagic ? [0x62, 0x61, 0x64, 0x21] : [0x77, 0x4f, 0x46, 0x32];
	await writeFile(join(packagePath, "assets/brand.woff2"), Uint8Array.from([...magic, 1, 2, 3]));
	return { root, packagePath };
}

describe("PluginUiAssetService", () => {
	test("serves declared assets and creates a host-controlled shell", async () => {
		const { root } = await setup();
		const service = new PluginUiAssetService({ root });
		const asset = await service.readAsset(pluginId, version, hash, "ui/index.js");
		expect(new TextDecoder().decode(asset.bytes)).toContain("console.log");
		expect(asset.contentType).toContain("javascript");
		const shell = await service.shell(pluginId, version, hash, "uis_test", "token");
		expect(shell).toContain("/asset/uis_test/token/ui/index.js");
		expect(shell).not.toContain("sessionToken=");
		expect(shell).not.toContain("postMessage");
	});

	test("selects independent assets for each view contribution", async () => {
		const { root } = await setup({ includeQuiet: true });
		const service = new PluginUiAssetService({ root });
		const pkg = await service.inspectPackage(pluginId, version, hash);
		expect(pkg.manifest.ui?.entry).toBe("ui/index.js");
		const shell = await service.shell(pluginId, version, hash, "uis_quiet", "token", "quiet");
		expect(shell).toContain("/asset/uis_quiet/token/ui/quiet.js");
		expect(shell).toContain("/asset/uis_quiet/token/ui/quiet.css");
		expect(shell).not.toContain("ui/index.js");
		const quiet = await service.readAsset(pluginId, version, hash, "ui/quiet.js");
		expect(new TextDecoder().decode(quiet.bytes)).toContain("quiet");
	});

	test("rejects traversal, symlinks, and oversized assets", async () => {
		const { root, packagePath } = await setup({ asset: "123456789" });
		const service = new PluginUiAssetService({ root, maxAssetBytes: 4 });
		await expect(service.readAsset(pluginId, version, hash, "../manifest.json")).rejects.toThrow();
		await expect(service.readAsset(pluginId, version, hash, "manifest.json")).rejects.toThrow();
		await expect(service.readAsset(pluginId, version, hash, "ui/index.js")).rejects.toMatchObject({
			code: "PLUGIN_UI_ASSET_TOO_LARGE",
		});
		try {
			await symlink(join(packagePath, "ui/index.js"), join(packagePath, "ui/link.js"));
			await expect(service.readAsset(pluginId, version, hash, "ui/link.js")).rejects.toThrow();
		} catch (error) {
			if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
				throw error;
			}
		}
	});

	test("serves a declared WOFF2 font from a theme-only package", async () => {
		const { root } = await setupThemeFont();
		const service = new PluginUiAssetService({ root });
		const asset = await service.readAsset(pluginId, version, hash, "assets/brand.woff2");
		expect(asset.contentType).toBe("font/woff2");
		expect([...asset.bytes.slice(0, 4)]).toEqual([0x77, 0x4f, 0x46, 0x32]);
	});

	/**
	 * A `.woff2` extension decides the served Content-Type and hands the bytes to
	 * the platform text engine, so the magic number is verified rather than trusted.
	 */
	test("refuses a declared font whose bytes are not WOFF2", async () => {
		const { root } = await setupThemeFont({ invalidMagic: true });
		await expect(
			new PluginUiAssetService({ root }).readAsset(pluginId, version, hash, "assets/brand.woff2"),
		).rejects.toMatchObject({ code: "PLUGIN_THEME_FONT_INVALID" });
	});

	test("applies the shared asset size limit to fonts", async () => {
		const { root } = await setupThemeFont();
		await expect(
			new PluginUiAssetService({ root, maxAssetBytes: 4 }).readAsset(
				pluginId,
				version,
				hash,
				"assets/brand.woff2",
			),
		).rejects.toMatchObject({ code: "PLUGIN_UI_ASSET_TOO_LARGE" });
	});

	test("refuses an undeclared font in the same package", async () => {
		const { root, packagePath } = await setupThemeFont();
		await writeFile(
			join(packagePath, "assets/undeclared.woff2"),
			Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 9]),
		);
		await expect(
			new PluginUiAssetService({ root }).readAsset(
				pluginId,
				version,
				hash,
				"assets/undeclared.woff2",
			),
		).rejects.toThrow();
	});
});
