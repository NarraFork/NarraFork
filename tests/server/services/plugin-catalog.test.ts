import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginCatalog } from "@server/services/plugin-catalog";
import { PluginPackageStore } from "@server/services/plugin-package-store";

const validPackage = fileURLToPath(
	new URL("../../fixtures/plugins/packages/valid-package", import.meta.url),
);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-catalog-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("PluginCatalog", () => {
	test("scans installed packages without executing entries", async () => {
		const root = await makeTempRoot();
		const installed = await new PluginPackageStore(root).install(validPackage);
		await mkdir(join(root, "staging", "ignored", "package"), { recursive: true });
		await writeFile(join(root, "staging", "ignored", "package", "manifest.json"), "not used");

		const snapshot = await new PluginCatalog(root).scan();
		const plugin = snapshot.plugins.find((item) => item.pluginId === installed.pluginId);
		const packageSummary = snapshot.packages.find((item) => item.hash === installed.hash);

		expect(snapshot.diagnostics).toEqual([]);
		expect(plugin?.status).toBe("compatible");
		expect(plugin?.current).toEqual({ version: installed.version, hash: installed.hash });
		expect(packageSummary?.status).toBe("compatible");
		expect(packageSummary?.isCurrent).toBe(true);
		expect(packageSummary?.manifest?.pluginId).toBe(installed.pluginId);
		expect(packageSummary?.contributions.map((item) => item.fullId)).toContain(
			"com.example.hello/hello",
		);
	});

	test("reports corrupt packages and missing current pointers without blocking other packages", async () => {
		const root = await makeTempRoot();
		const installed = await new PluginPackageStore(root).install(validPackage);
		const corruptHash = "a".repeat(64);
		const corruptRoot = join(root, "packages", "com.example.corrupt", "1.0.0", corruptHash);
		await mkdir(join(corruptRoot, "server"), { recursive: true });
		await writeFile(
			join(corruptRoot, "manifest.json"),
			JSON.stringify({ schemaVersion: 1, pluginId: "com.example.corrupt", version: "1.0.0" }),
		);
		await writeFile(join(corruptRoot, "server", "index.js"), "throw new Error('must not execute')");
		await writeFile(
			join(root, "current.json"),
			`${JSON.stringify({
				version: 1,
				plugins: {
					[installed.pluginId]: { version: installed.version, hash: installed.hash },
					"com.example.missing": { version: "1.0.0", hash: "b".repeat(64) },
				},
			})}\n`,
		);

		const snapshot = await new PluginCatalog(root).scan();
		const corrupt = snapshot.plugins.find((item) => item.pluginId === "com.example.corrupt");
		const missing = snapshot.plugins.find((item) => item.pluginId === "com.example.missing");
		const valid = snapshot.plugins.find((item) => item.pluginId === installed.pluginId);

		expect(corrupt?.status).toBe("installed");
		expect(corrupt?.packages[0]?.status).toBe("corrupt");
		expect(corrupt?.packages[0]?.diagnostics.some((item) => item.code === "MANIFEST_INVALID")).toBe(
			true,
		);
		expect(missing?.status).toBe("missing");
		expect(missing?.diagnostics.some((item) => item.code === "CURRENT_PACKAGE_MISSING")).toBe(true);
		expect(valid?.status).toBe("compatible");
	});

	test("preserves independent entryPath and stylePath for every view", async () => {
		const root = await makeTempRoot();
		const source = join(root, "view-source");
		await cp(validPackage, source, { recursive: true });
		const manifestPath = join(source, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.pluginId = "com.example.views";
		manifest.displayName = "Independent views";
		manifest.ui = {
			entry: "ui/shared-entry.js",
			format: "iife",
			style: "ui/shared-style.css",
			shell: "host-controlled",
		};
		manifest.activationEvents = ["onView:first", "onView:second"];
		manifest.contributes = {
			providers: [],
			tools: [],
			commands: [],
			events: [],
			views: [
				{
					id: "first",
					title: "First",
					entry: "ui/first.js",
					style: "ui/first.css",
					surfaces: ["workspace"],
					scope: "project",
					instance: "singleton",
				},
				{
					id: "second",
					title: "Second",
					entry: "ui/second.js",
					style: "ui/second.css",
					surfaces: ["settings"],
					scope: "global",
					instance: "multiple",
				},
			],
		};
		await mkdir(join(source, "ui"), { recursive: true });
		for (const path of [
			"shared-entry.js",
			"shared-style.css",
			"first.js",
			"first.css",
			"second.js",
			"second.css",
		]) {
			await writeFile(join(source, "ui", path), "/* fixture */\n");
		}
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const installed = await new PluginPackageStore(root).install(source);
		const snapshot = await new PluginCatalog(root).scan();
		const views = snapshot.packages
			.find((item) => item.hash === installed.hash)
			?.contributions.filter((item) => item.kind === "view");

		expect(views).toHaveLength(2);
		expect(views?.find((item) => item.id === "first")).toMatchObject({
			entryPath: "ui/first.js",
			stylePath: "ui/first.css",
			entry: "ui/first.js",
			style: "ui/first.css",
		});
		expect(views?.find((item) => item.id === "second")).toMatchObject({
			entryPath: "ui/second.js",
			stylePath: "ui/second.css",
			entry: "ui/second.js",
			style: "ui/second.css",
		});
	});
});
