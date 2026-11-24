import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
	collectPluginBuildModules,
	renderBuiltinPluginModule,
} from "../../../scripts/generate-builtin-plugins";
import { compileRuntimeBundle } from "../../../scripts/lib/runtime-compiler";
import { validatePluginRelease } from "../../../scripts/validate-plugin-release";
import { BUILTIN_PLUGIN_ROOTS } from "../../../server/builtin-plugins/registry";
import { safeParseManifest } from "../../../server/lib/plugins/manifest";
import { safeSpawn } from "../../../server/lib/spawn";
import { getBundledPluginDescriptors } from "../../../server/services/bundled-plugin-assets";
import { PluginCatalog } from "../../../server/services/plugin-catalog";
import { PluginPackageStore } from "../../../server/services/plugin-package-store";
import { pluginSourceMetadataSchema } from "../../../shared/plugin-source";
import { providerQuotaSourceSchema } from "../../../shared/provider-quota";

const ROOT = resolve(import.meta.dir, "../../..");
const ID = "io.narrafork.provider-quota";
const VERSION = "1.0.3";
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function isolatedSource() {
	const root = await mkdtemp(join(ROOT, ".narrafork/quota-archive-embedding-"));
	roots.push(root);
	const source = join(root, "source");
	await mkdir(source);
	await cp(join(ROOT, "plugins/provider-quota"), join(source, "plugins/provider-quota"), {
		recursive: true,
		filter: (path) => !/[\\/](?:dist|tests|node_modules)(?:[\\/]|$)/.test(path),
	});
	for (const path of [
		"server/services/bundled-plugin-assets.ts",
		"server/services/builtin-plugin-catalog.ts",
		"server/lib/runtime-target.ts",
		"server/lib/spawn.ts",
		"server/lib/logger.ts",
		"server/lib/narrafork-home.ts",
		"server/lib/win-handle-guard.ts",
	]) {
		const target = join(source, path);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(ROOT, path), target);
	}
	await writeFile(
		join(source, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { paths: { "@server/*": ["./server/*"] } },
		}),
	);
	return { root, source };
}

function archivedPath(modules: Map<string, string>): string {
	const body = modules.get("embedded-bundled-plugins.ts");
	if (!body) throw new Error("Missing archive module; an empty builtin list is not acceptance");
	const match = body.match(/import providerQuotaArchive from ("(?:[^"\\]|\\.)*") with/);
	if (!match) throw new Error("Missing opaque file import");
	return JSON.parse(match[1]);
}

test("quota has one pinned installable archive identity and no catalog-only builtin roots", async () => {
	expect(BUILTIN_PLUGIN_ROOTS).toEqual([]);
	const descriptor = getBundledPluginDescriptors();
	expect(descriptor).toHaveLength(1);
	expect(descriptor[0]).toMatchObject({ pluginId: ID, version: VERSION });
	const manifest = JSON.parse(
		await readFile(join(ROOT, "plugins/provider-quota/manifest.json"), "utf8"),
	);
	expect(manifest).toMatchObject({
		pluginId: ID,
		version: VERSION,
		engine: { hostApi: ">=1.0 <2" },
	});
	expect(safeParseManifest(manifest).success).toBe(true);
	const legacy = await renderBuiltinPluginModule();
	expect(legacy).toContain("embeddedBuiltinPlugins: readonly EmbeddedBuiltinPackage[] = []");
	expect(legacy).not.toContain("com.narrafork.apikey-quota");
});

test("immutable generation embeds a real nonempty archive without mutating generated source or plugin dist", async () => {
	const { source } = await isolatedSource();
	const generated = join(source, "server/generated/embedded-bundled-plugins.ts");
	await mkdir(dirname(generated));
	await writeFile(generated, 'throw new Error("shared generated file must remain unchanged");');
	const before = await readFile(generated, "utf8");
	const modules = await collectPluginBuildModules(source);
	expect([...modules.keys()].sort()).toEqual([
		"embedded-builtin-plugins.ts",
		"embedded-bundled-plugins.ts",
	]);
	expect(await readFile(generated, "utf8")).toBe(before);
	expect(
		await Bun.file(join(source, "plugins/provider-quota/dist/provider-quota.nfplugin")).exists(),
	).toBe(false);
	const body = modules.get("embedded-bundled-plugins.ts") as string;
	expect(body).toContain('with { type: "file" }');
	expect(body).toContain(`pluginId: "${ID}"`);
	expect(body).toContain(`version: "${VERSION}"`);
	expect(body).not.toMatch(/^import.*(?:src\/index|server\/index\.js)/m);
	const archive = archivedPath(modules);
	const bytes = await readFile(archive);
	expect(bytes.length).toBeGreaterThan(0);
	expect(bytes.length).toBeLessThanOrEqual(16 * 1024 * 1024);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	expect(archive).toEndWith(`${sha256}.nfplugin`);
	expect(body).toContain(`size: ${bytes.length}`);
	expect(body).toContain(`sha256: "${sha256}"`);
	const second = await collectPluginBuildModules(source);
	expect(archivedPath(second)).toBe(archive);
	expect(second.get("embedded-bundled-plugins.ts")).toBe(body);
	expect(await readFile(generated, "utf8")).toBe(before);
}, 45_000);

test("real in-memory compiled archive survives source deletion and materializes through the ordinary PackageStore/catalog", async () => {
	const { root, source } = await isolatedSource();
	const modules = await collectPluginBuildModules(source);
	const original = await readFile(archivedPath(modules));
	const entry = join(source, "server/probe.ts");
	await writeFile(
		entry,
		`import { builtinPluginCatalog } from "./services/builtin-plugin-catalog";
import { isCompiledRuntime } from "./lib/runtime-target";
const descriptor = builtinPluginCatalog.get("io.narrafork.provider-quota");
if (!descriptor) throw new Error("Missing trusted builtin definition");
const asset = await descriptor.load();
console.log("RESULT " + JSON.stringify({ compiled: isCompiledRuntime(), pluginId: descriptor.pluginId,
	version: descriptor.version, source: descriptor.source, sha256: asset.sha256, bytes: Buffer.from(asset.bytes).toString("base64") }));`,
	);
	const binary = join(root, process.platform === "win32" ? "quota-probe.exe" : "quota-probe");
	await compileRuntimeBundle({
		root: source,
		entrypoints: [entry],
		outfile: binary,
		buildId: "quota-archive-embedding-fixture",
		repository: "fixture/repository",
		modules,
	});
	await rm(source, { recursive: true, force: true });
	const executed = await safeSpawn({
		cmd: [binary],
		cwd: root,
		env: { ...process.env, PATH: "", NARRAFORK_HOME: join(root, "home") },
		timeout: 10_000,
		maxOutputBytes: 512 * 1024,
		killProcessTree: true,
	});
	expect(executed.exitCode).toBe(0);
	expect(executed.terminationReason).toBeUndefined();
	expect(Boolean(executed.stdoutTruncated || executed.stderrTruncated)).toBe(false);
	const resultLine = executed.stdout.split("\n").find((line) => line.startsWith("RESULT "));
	if (!resultLine) throw new Error(`Missing compiled result: ${executed.stderr}`);
	const result = JSON.parse(resultLine.slice(7));
	expect(result).toMatchObject({
		compiled: true,
		pluginId: ID,
		version: VERSION,
		source: { type: "local", builtinId: ID },
	});
	expect(Object.hasOwn(result.source, "homepage")).toBe(false);
	const embeddedBytes = Buffer.from(result.bytes, "base64");
	expect(embeddedBytes).toEqual(original);
	expect(createHash("sha256").update(embeddedBytes).digest("hex")).toBe(result.sha256);
	const storeRoot = join(root, "store");
	const store = new PluginPackageStore({ root: storeRoot });
	const installed = await store.install(embeddedBytes);
	expect(installed).toMatchObject({ pluginId: ID, version: VERSION, alreadyInstalled: false });
	expect(installed.manifest.contributes.quotaSources).toHaveLength(4);
	expect((await store.install(embeddedBytes)).alreadyInstalled).toBe(true);
	const catalog = await new PluginCatalog({ root: storeRoot, builtinRoots: [] }).scan();
	expect(catalog.plugins).toHaveLength(1);
	expect(catalog.plugins[0]).toMatchObject({
		pluginId: ID,
		status: "compatible",
		origin: "builtin",
		packageKind: "installed",
		canUninstall: true,
		sourceHint: { type: "local", builtinId: ID },
		sourceDiagnostics: [],
		diagnostics: [],
	});
	expect(Boolean(catalog.plugins[0].builtin)).toBe(false);
	expect(catalog.plugins[0].packages).toHaveLength(1);
	const validationRoot = join(root, "validation");
	await mkdir(validationRoot);
	await cp(installed.packagePath, join(validationRoot, "package"), { recursive: true });
	const validation = await validatePluginRelease(relative(process.cwd(), validationRoot), {
		mode: "ga",
		runtimeTimeoutMs: 10_000,
	});
	expect(validation.errors).toEqual([]);
	expect(validation.valid).toBe(true);
	expect(validation.packages[0].runtime.quotaQuery).toMatchObject({
		contributionId: "relay",
		status: "error",
		siteAccount: { status: "error" },
	});
}, 90_000);

test("ordinary PackageStore materialization keeps a single compatible non-builtin immutable quota package", async () => {
	const { root, source } = await isolatedSource();
	const modules = await collectPluginBuildModules(source);
	const bytes = await readFile(archivedPath(modules));
	const storeRoot = join(root, "ordinary-store");
	const store = new PluginPackageStore({ root: storeRoot });
	const installed = await store.install(bytes);
	const repeated = await store.install(bytes);
	expect(installed).toMatchObject({ pluginId: ID, version: VERSION, alreadyInstalled: false });
	expect(repeated).toMatchObject({ hash: installed.hash, alreadyInstalled: true });
	expect(await readFile(join(installed.packagePath, "server/index.js"), "utf8")).not.toBe("");
	const snapshot = await new PluginCatalog({ root: storeRoot, builtinRoots: [] }).scan();
	expect(snapshot.plugins).toHaveLength(1);
	const plugin = snapshot.plugins[0];
	expect(plugin).toMatchObject({
		pluginId: ID,
		status: "compatible",
		diagnostics: [],
		origin: "builtin",
		packageKind: "installed",
		canUninstall: true,
		sourceHint: { type: "local", builtinId: ID },
		sourceDiagnostics: [],
	});
	expect(Boolean(plugin.builtin)).toBe(false);
	expect(plugin.packages).toHaveLength(1);
	expect(plugin.packages[0].version).toBe(VERSION);
	expect(
		plugin.contributions.filter((contribution) => contribution.kind === "quotaSource"),
	).toHaveLength(4);
}, 45_000);

test("published JSON Schema mirrors quota auth modes and retention limits without fabricating defaults", async () => {
	const companion = JSON.parse(
		await readFile(join(ROOT, "docs/plugin-system/contracts/manifest-v1.schema.json"), "utf8"),
	);
	const actual = z.toJSONSchema(providerQuotaSourceSchema, {
		io: "input",
		unrepresentable: "any",
	}) as unknown as {
		properties: {
			requests: { items: { properties: { auth: unknown } } };
			refresh: unknown;
			limits: unknown;
		};
	};
	const quota = companion.$defs.quotaSourceContribution;
	expect(quota.properties.requests.items.properties.auth).toEqual(
		actual.properties?.requests.items.properties.auth,
	);
	expect(quota.properties.refresh).toEqual(actual.properties?.refresh);
	expect(quota.properties.limits).toEqual(actual.properties?.limits);
	expect(Object.hasOwn(quota.properties.refresh.properties.keepLastGoodMs, "default")).toBe(false);
	const { $schema: _dialect, ...sourceSchema } = z.toJSONSchema(pluginSourceMetadataSchema, {
		io: "input",
		unrepresentable: "any",
	});
	const { $comment: _refinements, ...sourceCompanion } = companion.$defs.pluginSourceMetadata;
	expect(sourceCompanion).toEqual(sourceSchema);
	expect(companion.required).not.toContain("source");
	expect(companion.required).not.toContain("plugin-source.json");
});
