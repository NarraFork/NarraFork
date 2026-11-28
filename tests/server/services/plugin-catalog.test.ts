import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	test("keeps a package whose views name the removed graph surface compatible", async () => {
		const root = await makeTempRoot();
		const source = join(root, "graph-source");
		await cp(validPackage, source, { recursive: true });
		const manifestPath = join(source, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.pluginId = "com.example.graph";
		manifest.displayName = "Graph views";
		manifest.ui = { entry: "ui/node.js", format: "iife", shell: "host-controlled" };
		manifest.activationEvents = ["onView:docked", "onView:node"];
		manifest.contributes = {
			providers: [],
			tools: [],
			commands: [],
			events: [],
			views: [
				{
					id: "docked",
					title: "Docked",
					entry: "ui/node.js",
					surfaces: ["focus", "graph"],
					scope: "narrator",
					instance: "multiple",
				},
				{
					id: "node",
					title: "Node",
					entry: "ui/node.js",
					surfaces: ["graph"],
					scope: "narrator",
					instance: "multiple",
				},
			],
		};
		await mkdir(join(source, "ui"), { recursive: true });
		await writeFile(join(source, "ui", "node.js"), "/* fixture */\n");
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const installed = await new PluginPackageStore(root).install(source);
		const snapshot = await new PluginCatalog(root).scan();
		const pkg = snapshot.packages.find((item) => item.hash === installed.hash);
		const views = pkg?.contributions.filter((item) => item.kind === "view");

		expect(pkg?.status).toBe("compatible");
		expect(views?.find((item) => item.id === "docked")?.surfaces).toEqual(["focus"]);
		// Reported as an empty list ("mounts nowhere"), never omitted ("unrestricted").
		expect(views?.find((item) => item.id === "node")?.surfaces).toEqual([]);
	});
});

test("the shipped quota manifest retains compatible feature contributions without a second builtin ID", async () => {
	const root = await makeTempRoot();
	const source = join(root, "quota-manifest-fixture");
	await cp(validPackage, source, { recursive: true });
	// The production entry is generated by the archive builder. Keep this catalog
	// fixture's explicit never-execute entry while validating the shipped manifest.
	const manifestText = await readFile(
		fileURLToPath(new URL("../../../plugins/provider-quota/manifest.json", import.meta.url)),
		"utf8",
	);
	const manifest = JSON.parse(manifestText);
	await writeFile(join(source, "manifest.json"), manifestText);
	const installed = await new PluginPackageStore(root).install(source);
	const snapshot = await new PluginCatalog(root).scan();
	const quota = snapshot.plugins.find(
		(plugin) => plugin.pluginId === "io.narrafork.provider-quota",
	);
	expect(installed.version).toBe(manifest.version);
	expect(quota).toMatchObject({ origin: "builtin", packageKind: "installed", canUninstall: true });
	expect(quota?.status).toBe("compatible");
	expect(quota?.builtin).not.toBe(true);
	expect(
		quota?.contributions.some((item) => item.kind === "quotaSource" && item.id === "relay"),
	).toBe(true);
	expect(snapshot.plugins.some((plugin) => plugin.pluginId === "com.narrafork.apikey-quota")).toBe(
		false,
	);
});

test("injected builtin paths and immutable external packages retain separate canonical containment", async () => {
	const root = await makeTempRoot();
	const storeRoot = join(root, "store");
	const installed = await new PluginPackageStore(storeRoot).install(validPackage);
	const builtinRoot = join(root, "injected-builtin");
	await cp(validPackage, builtinRoot, { recursive: true });
	const manifestPath = join(builtinRoot, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.pluginId = "com.example.injected-builtin";
	await writeFile(manifestPath, JSON.stringify(manifest));
	const snapshot = await new PluginCatalog({
		root: storeRoot,
		builtinRoots: [join(builtinRoot, "..", "injected-builtin")],
	}).scan();
	expect(snapshot.plugins.find((plugin) => plugin.pluginId === manifest.pluginId)).toMatchObject({
		builtin: true,
		origin: "builtin",
		packageKind: "builtin-directory",
		canUninstall: false,
		status: "compatible",
	});
	expect(snapshot.plugins.find((plugin) => plugin.pluginId === installed.pluginId)).toMatchObject({
		status: "compatible",
		current: { hash: installed.hash },
	});
	expect(
		snapshot.packages.every(
			(item) => !item.diagnostics.some((diagnostic) => diagnostic.code === "PACKAGE_PATH_ESCAPE"),
		),
	).toBe(true);
});

test("catalog compares a configured directory alias with the canonical package store", async () => {
	const root = await makeTempRoot();
	const canonical = join(root, "canonical-store");
	const alias = join(root, "configured-store");
	await mkdir(canonical);
	await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
	const installed = await new PluginPackageStore(alias).install(validPackage);
	const snapshot = await new PluginCatalog(alias).scan();
	const plugin = snapshot.plugins.find((item) => item.pluginId === installed.pluginId);
	expect(plugin?.status).toBe("compatible");
	expect(plugin?.packages[0]?.diagnostics).toEqual([]);
	expect(plugin?.contributions.map((item) => item.fullId)).toContain("com.example.hello/hello");
});

test("canonicalizing the parent never permits packages outside the configured store", async () => {
	const root = await makeTempRoot();
	const storeRoot = join(root, "store");
	const outsideRoot = join(root, "outside-store");
	const installed = await new PluginPackageStore(outsideRoot).install(validPackage);
	await mkdir(storeRoot);
	await cp(join(outsideRoot, "current.json"), join(storeRoot, "current.json"));
	await symlink(
		join(outsideRoot, "packages"),
		join(storeRoot, "packages"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const snapshot = await new PluginCatalog(storeRoot).scan();
	const plugin = snapshot.plugins.find((item) => item.pluginId === installed.pluginId);
	expect(plugin?.packages[0]?.status).toBe("corrupt");
	expect(plugin?.diagnostics.some((item) => item.code === "PACKAGE_PATH_ESCAPE")).toBe(true);
	expect(plugin?.contributions).toEqual([]);
});

async function scanSourceFixture(metadata?: unknown) {
	const root = await makeTempRoot();
	const source = join(root, "input");
	await cp(validPackage, source, { recursive: true });
	if (metadata !== undefined) {
		await writeFile(
			join(source, "plugin-source.json"),
			typeof metadata === "string" ? metadata : JSON.stringify(metadata),
		);
	}
	const installed = await new PluginPackageStore(root).install(source);
	const snapshot = await new PluginCatalog(root).scan();
	const plugin = snapshot.plugins.find((item) => item.pluginId === installed.pluginId);
	if (!plugin) throw new Error("Source fixture disappeared from catalog");
	return { plugin, pkg: plugin.packages[0] };
}

describe("optional plugin source hints", () => {
	test("legacy packages retain compatibility with no source or inferred homepage", async () => {
		const { plugin, pkg } = await scanSourceFixture();
		expect(plugin).toMatchObject({
			status: "compatible",
			sourceHint: null,
			sourceDiagnostics: [],
			diagnostics: [],
			origin: "installed",
			packageKind: "installed",
			canUninstall: true,
		});
		expect(pkg.sourceHint).toBeNull();
	});

	test("a GitHub source without homepage stays a hint, not an automatically guessed link", async () => {
		const source = {
			type: "github" as const,
			owner: "example",
			repo: "plugin",
			assetName: "plugin-{version}.nfplugin",
		};
		const { plugin, pkg } = await scanSourceFixture({
			schemaVersion: 1,
			pluginId: "com.example.hello",
			source,
		});
		expect(plugin).toMatchObject({
			status: "compatible",
			sourceHint: source,
			sourceDiagnostics: [],
			diagnostics: [],
		});
		expect(pkg.sourceHint).toEqual(source);
		expect(Object.hasOwn(plugin.sourceHint ?? {}, "homepage")).toBe(false);
	});

	test.each([
		{ metadata: "{credential-marker", code: "SOURCE_INVALID" },
		{
			metadata: {
				schemaVersion: 2,
				pluginId: "com.example.hello",
				source: { type: "local", builtinId: "com.example.hello" },
			},
			code: "SOURCE_INVALID",
		},
		{
			metadata: {
				schemaVersion: 1,
				pluginId: "com.other.plugin",
				source: { type: "local", builtinId: "com.other.plugin" },
			},
			code: "SOURCE_MISMATCH",
		},
		{
			metadata: {
				schemaVersion: 1,
				pluginId: "com.example.hello",
				source: { type: "local", builtinId: "io.narrafork.provider-quota" },
			},
			code: "SOURCE_MISMATCH",
		},
		{ metadata: "x".repeat(16 * 1024 + 1), code: "SOURCE_INVALID" },
		{
			metadata: {
				schemaVersion: 1,
				pluginId: "com.example.hello",
				source: {
					type: "local",
					builtinId: "com.example.hello",
					homepage: "javascript:credential-marker",
				},
			},
			code: "SOURCE_INVALID",
		},
	])("bad source metadata only adds source diagnostics: $code", async ({ metadata, code }) => {
		const { plugin, pkg } = await scanSourceFixture(metadata);
		expect(plugin).toMatchObject({ status: "compatible", sourceHint: null, diagnostics: [] });
		expect(pkg.status).toBe("compatible");
		expect(pkg.diagnostics).toEqual([]);
		expect(plugin.sourceDiagnostics?.map((item) => item.code)).toEqual([code]);
		expect(JSON.stringify(plugin.sourceDiagnostics)).not.toContain("credential-marker");
	});

	test("an author's local hint cannot register a new trusted builtin identity", async () => {
		const { plugin } = await scanSourceFixture({
			schemaVersion: 1,
			pluginId: "com.example.hello",
			source: { type: "local", builtinId: "com.example.hello" },
		});
		expect(plugin).toMatchObject({
			status: "compatible",
			origin: "installed",
			packageKind: "installed",
			canUninstall: true,
			sourceDiagnostics: [],
		});
		expect(plugin.builtin).not.toBe(true);
	});
});
