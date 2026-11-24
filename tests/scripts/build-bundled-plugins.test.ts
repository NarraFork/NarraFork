import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBundledPlugins } from "../../scripts/build-bundled-plugins";
import { collectPluginBuildModules } from "../../scripts/generate-builtin-plugins";
import { collectBuildModules } from "../../scripts/lib/build-materials";
import { safeSpawn } from "../../server/lib/spawn";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";

const project = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const pluginId = "io.narrafork.provider-quota";
const version = "1.0.3";
const fixtureBytes = Buffer.from("bounded independent archive fixture");
const fixtureIdentity = {
	schemaVersion: 1,
	pluginId,
	version,
	size: fixtureBytes.length,
	sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; source: string }> {
	const root = await mkdtemp(join(project, ".narrafork/bundled-plugins-test-"));
	roots.push(root);
	const source = join(root, "source");
	for (const path of [
		"server/services/bundled-plugin-assets.ts",
		"server/lib/runtime-target.ts",
		"server/lib/spawn.ts",
		"server/lib/logger.ts",
		"server/lib/narrafork-home.ts",
		"server/lib/win-handle-guard.ts",
	]) {
		const target = join(source, path);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(project, path), target);
	}
	await writeFile(
		join(source, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { paths: { "@server/*": ["./server/*"] } } }),
	);
	return { root, source };
}

async function pluginFixture() {
	const result = await fixture();
	const plugin = join(result.source, "plugins/provider-quota");
	await cp(join(project, "plugins/provider-quota"), plugin, {
		recursive: true,
		filter: (path) => !/[\\/](?:dist|tests|node_modules)(?:[\\/]|$)/.test(path),
	});
	return { ...result, plugin, dist: join(plugin, "dist") };
}

function importedArchive(module: string, generatedDir: string): string {
	const match = module.match(/import providerQuotaArchive from ("(?:[^"\\]|\\.)*") with/);
	if (!match) throw new Error("Missing opaque archive import");
	return resolve(generatedDir, JSON.parse(match[1]));
}

async function command(cmd: string[], cwd: string, allowFailure = false) {
	const result = await safeSpawn({
		cmd,
		cwd,
		env: { ...process.env, NARRAFORK_HOME: join(cwd, "home"), PATH: "" },
		timeout: 60_000,
		maxOutputBytes: 256 * 1024,
		killProcessTree: true,
	});
	expect(result.terminationReason).toBeUndefined();
	expect(Boolean(result.stdoutTruncated || result.stderrTruncated)).toBe(false);
	if (!allowFailure && result.exitCode !== 0) {
		throw new Error(`Fixture command failed: ${result.stderr}\n${result.stdout}`);
	}
	return result;
}

function output(stdout: string): Record<string, unknown> {
	const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
	if (!line) throw new Error(`Fixture did not return its bounded result: ${stdout}`);
	return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

async function probe(source: string, code: string): Promise<string> {
	const path = join(source, "server/probe.ts");
	await writeFile(path, code);
	return path;
}

async function compile(source: string, root: string, entry: string): Promise<string> {
	const binary = join(root, process.platform === "win32" ? "probe.exe" : "probe");
	await command(
		[
			process.execPath,
			"build",
			entry,
			"--compile",
			"--minify",
			"--asset-naming=[dir]/[name].[ext]",
			"--outfile",
			binary,
		],
		source,
	);
	return binary;
}

async function writeSourceAssets(source: string, metadata: unknown): Promise<void> {
	const dist = join(source, "plugins/provider-quota/dist");
	await mkdir(dist, { recursive: true });
	await writeFile(join(dist, "provider-quota.nfplugin"), fixtureBytes);
	await writeFile(join(dist, "provider-quota.asset.json"), JSON.stringify(metadata));
}

const loadProbe = `import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
const descriptors = getBundledPluginDescriptors();
try {
	const signal = Bun.argv[3] === "abort" ? AbortSignal.abort(new Error("already cancelled")) : undefined;
	const loaded = await descriptors[0].load(signal);
	console.log("RESULT " + JSON.stringify({ ok: true, pluginId: descriptors[0].pluginId,
		version: descriptors[0].version, size: loaded.bytes.length, sha256: loaded.sha256,
		bytes: Buffer.from(loaded.bytes).toString("base64") }));
} catch (error) {
	console.log("RESULT " + JSON.stringify({ ok: false, pluginId: descriptors[0].pluginId,
		version: descriptors[0].version, error: error.message }));
}`;

test("cross-platform builds generate one opaque archive before frontend/target selection work", async () => {
	const code = await readFile(join(project, "scripts/build-cross-platform.ts"), "utf8");
	expect(code).toContain('import { collectPluginBuildModules } from "./generate-builtin-plugins"');
	expect(code.match(/await collectPluginBuildModules\(/g)).toHaveLength(1);
	const generation = code.indexOf("await collectPluginBuildModules(");
	expect(code).toContain(
		"for (const [name, source] of bundledPluginModules) buildModules.set(name, source)",
	);
	expect(generation).toBeLessThan(code.indexOf("if (!skipFrontend)"));
	expect(generation).toBeLessThan(code.indexOf("// Phase 1: Serial compilation"));
	expect(code.slice(code.indexOf("// Phase 1: Serial compilation"))).not.toContain(
		"provider-quota",
	);
	const ignored = await readFile(join(project, ".gitignore"), "utf8");
	expect(ignored).toContain("!scripts/build-bundled-plugins.ts");
	expect(ignored).toContain("!scripts/smoke-provider-quota.ts");
});

test("immutable local runtime material map includes the same archive with optional remote-peer enabled", async () => {
	const generatedFiles = [
		...new Bun.Glob("server/generated/*.ts").scanSync({ cwd: project }),
	].sort();
	const before = await Promise.all(
		generatedFiles.map((file) => readFile(join(project, file), "utf8")),
	);
	const modules = await collectBuildModules(project, new Map(), {
		version: "0.0.0",
		commit: "archive-fixture",
		platform: "fixture",
		repository: "fixture/repository",
		helperDistribution: createHelperDistributionDependencies(),
		remotePeerDistribution: {
			version: "0.1.0-alpha.1",
			protocolVersion: 2,
			tag: "remote-peer-v0.1.0-alpha.1",
		},
	});
	const archive = modules.get("embedded-bundled-plugins.ts");
	expect(archive).toBeDefined();
	expect(archive).toContain(`pluginId: "${pluginId}"`);
	expect(archive).toContain(`version: "${version}"`);
	expect(archive).toContain('with { type: "file" }');
	const frozen = await collectPluginBuildModules(project);
	expect(frozen.get("embedded-bundled-plugins.ts")).toBe(archive);
	frozen.delete("embedded-bundled-plugins.ts");
	expect((await collectPluginBuildModules(project)).get("embedded-bundled-plugins.ts")).toBe(
		archive,
	);
	expect(modules.get("embedded-builtin-plugins.ts")).toContain("EmbeddedBuiltinPackage[] = []");
	expect(
		await Promise.all(generatedFiles.map((file) => readFile(join(project, file), "utf8"))),
	).toEqual(before);
}, 45_000);

test("rebuilds freeze independent archive bytes and never rewrite a previous cache entry", async () => {
	const { source, plugin, dist } = await pluginFixture();
	const modules = await collectPluginBuildModules(source);
	const module = modules.get("embedded-bundled-plugins.ts") as string;
	const cached = importedArchive(module, join(source, "server/generated"));
	const firstBytes = await readFile(cached);
	expect(await Bun.file(join(dist, "provider-quota.nfplugin")).exists()).toBe(false);
	const first = await buildBundledPlugins({ root: source });
	expect(await readFile(first.assets[0].archivePath)).toEqual(firstBytes);
	expect(await readFile(join(dist, "provider-quota.nfplugin"))).toEqual(firstBytes);
	const repeated = await buildBundledPlugins({ root: source });
	expect(repeated.generatedModuleSource).toBe(first.generatedModuleSource);
	expect(repeated.assets[0].sha256).toBe(first.assets[0].sha256);

	await writeFile(join(plugin, "LICENSE"), `${await readFile(join(plugin, "LICENSE"), "utf8")}\n`);
	const changed = await buildBundledPlugins({ root: source });
	expect(changed.assets[0].sha256).not.toBe(first.assets[0].sha256);
	expect(await readFile(cached)).toEqual(firstBytes);
	expect(await readFile(first.assets[0].archivePath)).toEqual(firstBytes);
	expect((await collectPluginBuildModules(source)).get("embedded-bundled-plugins.ts")).toBe(module);
	const frozenChanged = await readFile(changed.assets[0].archivePath);
	expect(await readFile(join(dist, "provider-quota.nfplugin"))).toEqual(frozenChanged);
	// Even an in-place write to the public asset must not share an inode with the frozen cache.
	await writeFile(join(dist, "provider-quota.nfplugin"), "external canonical replacement");
	expect(await readFile(changed.assets[0].archivePath)).toEqual(frozenChanged);
	expect(await readFile(cached)).toEqual(firstBytes);
}, 60_000);

test("concurrent publishers fail closed on the output lock and identical cache writers converge", async () => {
	const { root, source, dist } = await pluginFixture();
	const concurrent = await Promise.allSettled([
		buildBundledPlugins({ root: source }),
		buildBundledPlugins({ root: source }),
	]);
	expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const failed = concurrent.find((result) => result.status === "rejected");
	expect(failed?.status === "rejected" ? String(failed.reason) : "").toContain("build lock");
	const previous = await readFile(join(dist, "provider-quota.nfplugin"));
	const [left, right] = await Promise.all([
		buildBundledPlugins({ root: source, outDir: join(root, "left"), publishGenerated: false }),
		buildBundledPlugins({ root: source, outDir: join(root, "right"), publishGenerated: false }),
	]);
	expect(left.assets[0]).toEqual(right.assets[0]);
	expect(await readFile(left.assets[0].archivePath)).toEqual(previous);
	expect(await readFile(join(root, "left/provider-quota.nfplugin"))).toEqual(previous);
	expect(await readFile(join(root, "right/provider-quota.nfplugin"))).toEqual(previous);
	expect((await readdir(dist)).some((name) => name.startsWith(".provider-quota-"))).toBe(false);
}, 60_000);

test("standalone rebuilds publish matching host sidecars while preserving frozen build inputs", async () => {
	const { source, plugin, dist } = await pluginFixture();
	const built = await buildBundledPlugins({ root: source });
	const frozenBytes = await readFile(built.assets[0].archivePath);
	const generated = await readFile(built.generatedModulePath, "utf8");
	await writeFile(join(plugin, "LICENSE"), "standalone replacement publication\n");
	const { buildProviderQuotaPlugin } = await import(pathToFileURL(join(plugin, "build.ts")).href);
	await buildProviderQuotaPlugin({ outDir: dist });
	const archive = await readFile(join(dist, "provider-quota.nfplugin"));
	const digest = createHash("sha256").update(archive).digest("hex");
	expect(digest).not.toBe(built.assets[0].sha256);
	expect(JSON.parse(await readFile(join(dist, "provider-quota.asset.json"), "utf8"))).toEqual({
		schemaVersion: 1,
		pluginId,
		version,
		size: archive.byteLength,
		sha256: digest,
	});
	expect(await readFile(built.assets[0].archivePath)).toEqual(frozenBytes);
	expect(await readFile(built.generatedModulePath, "utf8")).toBe(generated);
	const entry = await probe(source, loadProbe);
	expect(output((await command([process.execPath, entry], source)).stdout)).toMatchObject({
		ok: true,
		size: archive.byteLength,
		sha256: digest,
	});
}, 45_000);

test("unknown build locks and failed publication preserve the previous archive, metadata and package", async () => {
	const { root, source, plugin, dist } = await pluginFixture();
	const built = await buildBundledPlugins({ root: source });
	const archive = join(dist, "provider-quota.nfplugin");
	const metadata = join(dist, "provider-quota.asset.json");
	const before = await Promise.all([
		readFile(archive),
		readFile(metadata),
		readFile(built.generatedModulePath),
		readFile(join(dist, "package/LICENSE")),
	]);
	const lock = join(dist, ".provider-quota-build.lock");
	await writeFile(lock, "unknown prior owner\n", { flag: "wx" });
	await expect(buildBundledPlugins({ root: source })).rejects.toThrow("build lock");
	expect(await readFile(lock, "utf8")).toBe("unknown prior owner\n");
	await rm(lock); // Only this test's own lock is removed.
	await writeFile(join(plugin, "LICENSE"), "changed input that must not be published\n");
	const blockedGeneratedDir = join(root, "not-a-directory");
	await writeFile(blockedGeneratedDir, "publication failure fixture");
	await expect(
		buildBundledPlugins({ root: source, generatedDir: blockedGeneratedDir }),
	).rejects.toThrow();
	expect(
		await Promise.all([
			readFile(archive),
			readFile(metadata),
			readFile(built.generatedModulePath),
			readFile(join(dist, "package/LICENSE")),
		]),
	).toEqual(before);
	expect((await readdir(dist)).some((name) => name.startsWith(".provider-quota-"))).toBe(false);
}, 45_000);

test("partial ZIP writes, sidecar sync and final archive rename failures preserve publication", async () => {
	const { source, plugin, dist } = await pluginFixture();
	const built = await buildBundledPlugins({ root: source });
	const paths = [
		join(dist, "provider-quota.nfplugin"),
		join(dist, "provider-quota.asset.json"),
		built.generatedModulePath,
		join(dist, "package/LICENSE"),
	];
	const before = await Promise.all(paths.map((path) => readFile(path)));
	await writeFile(join(plugin, "LICENSE"), "changed input for failure injection\n");
	for (const mode of ["write", "sync", "rename"]) {
		const entry = await probe(
			source,
			`import { mock } from "bun:test";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
const realStream = fs.createWriteStream;
const realRename = promises.rename;
const realOpen = promises.open;
let injected = false;
if (${JSON.stringify(mode)} === "write") {
	mock.module("node:fs", () => ({ ...fs, createWriteStream(path, options) {
		const sink = realStream(path, options);
		if (String(path).endsWith(".nfplugin")) {
			const write = sink._write.bind(sink);
			sink._write = (chunk, encoding, callback) => write(chunk, encoding, error => {
				injected = true;
				callback(error || new Error("injected partial ZIP write"));
			});
		}
		return sink;
	} }));
} else if (${JSON.stringify(mode)} === "sync") {
	mock.module("node:fs/promises", () => ({ ...promises, async open(path, ...args) {
		const handle = await realOpen(path, ...args);
		if (!String(path).endsWith("sidecar-0")) return handle;
		return new Proxy(handle, { get(target, key) {
			if (key === "sync") return async () => {
				injected = true;
				throw new Error("injected sidecar sync failure");
			};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		} });
	} }));
} else {
	mock.module("node:fs/promises", () => ({ ...promises, async rename(from, to) {
		if (!injected && to === ${JSON.stringify(paths[0])}) {
			injected = true;
			throw new Error("injected final archive rename");
		}
		return realRename(from, to);
	} }));
}
const { buildBundledPlugins } = await import(${JSON.stringify(join(project, "scripts/build-bundled-plugins.ts").replaceAll("\\", "/"))});
try {
	await buildBundledPlugins({ root: ${JSON.stringify(source)} });
	console.log("RESULT " + JSON.stringify({ ok: true, injected }));
} catch (error) {
	console.log("RESULT " + JSON.stringify({ ok: false, injected, error: error.message }));
}`,
		);
		expect(output((await command([process.execPath, entry], source)).stdout)).toMatchObject({
			ok: false,
			injected: true,
		});
		expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
		expect((await readdir(dist)).some((name) => name.startsWith(".provider-quota-"))).toBe(false);
	}
}, 60_000);

test("a corrupt existing content-addressed asset is rejected, never overwritten or published", async () => {
	const { source, dist } = await pluginFixture();
	const built = await buildBundledPlugins({ root: source });
	const before = await Promise.all([
		readFile(join(dist, "provider-quota.nfplugin")),
		readFile(join(dist, "provider-quota.asset.json")),
		readFile(built.generatedModulePath),
	]);
	await writeFile(built.assets[0].archivePath, "corrupt immutable fixture");
	await expect(buildBundledPlugins({ root: source })).rejects.toThrow("identity mismatch");
	expect(await readFile(built.assets[0].archivePath, "utf8")).toBe("corrupt immutable fixture");
	expect(
		await Promise.all([
			readFile(join(dist, "provider-quota.nfplugin")),
			readFile(join(dist, "provider-quota.asset.json")),
			readFile(built.generatedModulePath),
		]),
	).toEqual(before);
}, 45_000);

test("target checkout build identity is validated before importing a build recipe", async () => {
	const { source } = await fixture();
	const plugin = join(source, "plugins/provider-quota");
	await mkdir(plugin, { recursive: true });
	for (const manifest of [
		{ pluginId: "org.third-party.plugin", version },
		{ pluginId, version: "1.0.1" },
	]) {
		await writeFile(join(plugin, "manifest.json"), JSON.stringify(manifest));
		await expect(buildBundledPlugins({ root: source, publishGenerated: false })).rejects.toThrow(
			"pinned descriptor",
		);
	}
	expect(
		await Bun.file(join(source, "server/generated/embedded-bundled-plugins.ts")).exists(),
	).toBe(false);
	expect(await Bun.file(join(plugin, "dist/provider-quota.nfplugin")).exists()).toBe(false);
});

test("synchronous enumeration does no I/O or dev build when all generated assets are absent", async () => {
	const { root, source } = await fixture();
	const entry = await probe(
		source,
		`import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
const descriptors = getBundledPluginDescriptors();
console.log("RESULT " + JSON.stringify({ isArray: Array.isArray(descriptors),
	frozen: Object.isFrozen(descriptors) && Object.isFrozen(descriptors[0]),
	pluginId: descriptors[0].pluginId, version: descriptors[0].version,
	archiveExists: await Bun.file("plugins/provider-quota/dist/provider-quota.nfplugin").exists(),
	metadataExists: await Bun.file("plugins/provider-quota/dist/provider-quota.asset.json").exists(),
	generatedExists: await Bun.file("server/generated/embedded-bundled-plugins.ts").exists() }));`,
	);
	expect(output((await command([process.execPath, entry], source)).stdout)).toEqual({
		isArray: true,
		frozen: true,
		pluginId,
		version,
		archiveExists: false,
		metadataExists: false,
		generatedExists: false,
	});
	expect(await Bun.file(join(root, "build-invocation.json")).exists()).toBe(false);
}, 30_000);

test("source load uses one fixed subprocess only when missing; one cancelled waiter preserves others", async () => {
	const { root, source } = await fixture();
	await mkdir(join(source, "scripts"));
	const invocation = join(source, "build-invocation.json");
	const script = join(source, "scripts/build-bundled-plugins.ts");
	await writeFile(
		script,
		`import { mkdir, writeFile } from "node:fs/promises";
const invocation = ${JSON.stringify(invocation)};
if (await Bun.file(invocation).exists()) throw new Error("duplicate build");
await writeFile(invocation, JSON.stringify({ execPath: process.execPath, cwd: process.cwd(), args: process.argv.slice(2) }));
const dist = ${JSON.stringify(join(source, "plugins/provider-quota/dist"))};
await mkdir(dist, { recursive: true });
await writeFile(dist + "/provider-quota.nfplugin", Buffer.from(${JSON.stringify(fixtureBytes.toString("base64"))}, "base64"));
await writeFile(dist + "/provider-quota.asset.json", ${JSON.stringify(JSON.stringify(fixtureIdentity))});`,
	);
	const entry = await probe(
		source,
		`import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
const descriptor = getBundledPluginDescriptors()[0];
const before = await Bun.file("plugins/provider-quota/dist/provider-quota.nfplugin").exists();
const controller = new AbortController();
const cancelled = descriptor.load(controller.signal).catch(error => error.message);
const kept = descriptor.load();
controller.abort(new Error("one waiter cancelled"));
const loaded = await kept;
console.log("RESULT " + JSON.stringify({ before, cancelled: await cancelled,
	size: loaded.bytes.length, sha256: loaded.sha256 }));`,
	);
	expect(output((await command([process.execPath, entry], source)).stdout)).toEqual({
		before: false,
		cancelled: "one waiter cancelled",
		size: fixtureBytes.length,
		sha256: fixtureIdentity.sha256,
	});
	expect(JSON.parse(await readFile(invocation, "utf8"))).toEqual({
		execPath: process.execPath,
		cwd: source,
		args: [],
	});
	await rm(script);
	const existing = output((await command([process.execPath, entry], source)).stdout);
	expect(existing).toMatchObject({ before: true, sha256: fixtureIdentity.sha256 });
	expect(await Bun.file(join(root, "output/provider-quota.nfplugin")).exists()).toBe(false);
}, 45_000);

test("last source waiter cancellation reaches the child build and leaves no archive", async () => {
	const { source } = await fixture();
	await mkdir(join(source, "scripts"));
	const started = join(source, "build-started");
	await writeFile(
		join(source, "scripts/build-bundled-plugins.ts"),
		`import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(started)}, String(process.pid));
setInterval(() => {}, 1000);
await new Promise(() => {});`,
	);
	const entry = await probe(
		source,
		`import { watch } from "node:fs";
import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
const controller = new AbortController();
let watcher;
let timer;
const started = new Promise((resolve, reject) => {
	watcher = watch(process.cwd(), (_, name) => { if (String(name) === "build-started") resolve(); });
	timer = setTimeout(() => reject(new Error("build did not start")), 10000);
});
const loaded = getBundledPluginDescriptors()[0].load(controller.signal).catch(error => error.message);
try { await started; controller.abort(new Error("cancel build"));
	console.log("RESULT " + JSON.stringify({ error: await loaded }));
} finally { clearTimeout(timer); watcher.close(); }`,
	);
	expect(output((await command([process.execPath, entry], source)).stdout)).toEqual({
		error: "cancel build",
	});
	const pid = Number(await readFile(started, "utf8"));
	let alive = false;
	try {
		process.kill(pid, 0);
		alive = true;
	} catch {
		// The test's own child is expected to have been reaped by safeSpawn.
	}
	expect(alive).toBe(false);
	expect(
		await Bun.file(join(source, "plugins/provider-quota/dist/provider-quota.nfplugin")).exists(),
	).toBe(false);
}, 45_000);

test("source metadata and archive identity reject unknown IDs, wrong version, size and SHA", async () => {
	const { source } = await fixture();
	const entry = await probe(source, loadProbe);
	for (const [patch, message] of [
		[{ pluginId: "org.third-party.plugin" }, "identity"],
		[{ version: "1.0.0" }, "identity"],
		[{ size: 16 * 1024 * 1024 + 1 }, "byte budget"],
		[{ sha256: "not-a-hash" }, "SHA-256 metadata"],
		[{ size: fixtureBytes.length + 1 }, "size mismatch"],
		[{ sha256: "f".repeat(64) }, "SHA-256 mismatch"],
	] as const) {
		await writeSourceAssets(source, { ...fixtureIdentity, ...patch });
		const result = output((await command([process.execPath, entry], source)).stdout);
		expect(result).toMatchObject({ ok: false, pluginId, version });
		expect(result.error).toContain(message);
	}
	await writeSourceAssets(source, fixtureIdentity);
	expect(output((await command([process.execPath, entry], source)).stdout)).toMatchObject({
		ok: true,
		sha256: fixtureIdentity.sha256,
	});
}, 45_000);

test("actual archive and metadata byte budgets reject oversized files and accept exactly 16 MiB", async () => {
	const { source } = await fixture();
	const dist = join(source, "plugins/provider-quota/dist");
	const archivePath = join(dist, "provider-quota.nfplugin");
	const metadataPath = join(dist, "provider-quota.asset.json");
	const entry = await probe(
		source,
		`import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
try { const asset = await getBundledPluginDescriptors()[0].load();
	console.log("RESULT " + JSON.stringify({ ok: true, size: asset.bytes.length, sha256: asset.sha256 }));
} catch (error) { console.log("RESULT " + JSON.stringify({ ok: false, error: error.message })); }`,
	);
	await writeSourceAssets(source, fixtureIdentity);
	await writeFile(metadataPath, Buffer.alloc(64 * 1024 + 1, 0x20));
	expect(output((await command([process.execPath, entry], source)).stdout).error).toContain(
		"byte budget",
	);
	await writeSourceAssets(source, { ...fixtureIdentity, size: 16 * 1024 * 1024 });
	await truncate(archivePath, 16 * 1024 * 1024 + 1);
	expect(output((await command([process.execPath, entry], source)).stdout).error).toContain(
		"byte budget",
	);
	await truncate(archivePath, 0);
	expect(output((await command([process.execPath, entry], source)).stdout).error).toContain(
		"byte budget",
	);
	await truncate(archivePath, 16 * 1024 * 1024);
	const sha256 = Buffer.from(
		await crypto.subtle.digest("SHA-256", new Uint8Array(await readFile(archivePath))),
	).toString("hex");
	await writeFile(
		metadataPath,
		JSON.stringify({ ...fixtureIdentity, size: 16 * 1024 * 1024, sha256 }),
	);
	expect(output((await command([process.execPath, entry], source)).stdout)).toEqual({
		ok: true,
		size: 16 * 1024 * 1024,
		sha256,
	});
}, 45_000);

test("bounded archive streams stop stat/read growth, active cancellation and the actual read deadline", async () => {
	const { source } = await fixture();
	await writeSourceAssets(source, fixtureIdentity);
	const entry = await probe(
		source,
		`import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
const mode = Bun.argv[2];
const controller = new AbortController();
const originalFile = Bun.file;
const originalTimeout = globalThis.setTimeout;
let insideArchive = false;
let shortenedDeadlineCalls = 0;
let streamCancelled = false;
globalThis.setTimeout = (callback, timeout, ...args) => {
	// Wrap the real production deadline callback, shortening only the stalled archive's budget.
	if (insideArchive && timeout === 10000) {
		shortenedDeadlineCalls++;
		return originalTimeout(callback, 20, ...args);
	}
	return originalTimeout(callback, timeout, ...args);
};
Bun.file = (path, ...args) => {
	const file = originalFile(path, ...args);
	if (!String(path).endsWith("provider-quota.nfplugin")) return file;
	return { size: ${fixtureBytes.length}, exists: () => file.exists(), stream: () => new ReadableStream({
		start(stream) {
			if (mode === "grow") { stream.enqueue(new Uint8Array(${fixtureBytes.length + 1})); stream.close(); }
			else if (mode === "cancel") queueMicrotask(() => controller.abort(new Error("cancel active read")));
			else insideArchive = true;
		},
		cancel() { streamCancelled = true; }
	}) };
};
try { await getBundledPluginDescriptors()[0].load(controller.signal);
	console.log("RESULT " + JSON.stringify({ ok: true }));
} catch (error) { console.log("RESULT " + JSON.stringify({ ok: false, error: error.message,
	streamCancelled, shortenedDeadlineCalls })); }`,
	);
	const growth = output((await command([process.execPath, entry, "grow"], source)).stdout);
	expect(growth).toMatchObject({ ok: false, shortenedDeadlineCalls: 0 });
	expect(growth.error).toContain("grew beyond its byte budget");
	expect(output((await command([process.execPath, entry, "cancel"], source)).stdout)).toMatchObject(
		{
			ok: false,
			error: "cancel active read",
			streamCancelled: true,
			shortenedDeadlineCalls: 0,
		},
	);
	const deadline = output((await command([process.execPath, entry, "deadline"], source)).stdout);
	expect(deadline).toMatchObject({ ok: false, streamCancelled: true, shortenedDeadlineCalls: 1 });
	expect(deadline.error).toContain("read deadline exceeded");
}, 45_000);

test("dev subprocess stdout overflow terminates the build and stderr capture remains bounded", async () => {
	const { source } = await fixture();
	await mkdir(join(source, "scripts"));
	const script = join(source, "scripts/build-bundled-plugins.ts");
	const entry = await probe(source, loadProbe);
	await writeFile(
		script,
		'process.stdout.write("x".repeat(64 * 1024 + 1)); setInterval(() => {}, 1000);',
	);
	const stdout = output((await command([process.execPath, entry], source)).stdout);
	expect(stdout.ok).toBe(false);
	expect(stdout.error).toContain("output-limit");
	await writeFile(
		script,
		'await new Promise(resolve => process.stderr.write("e".repeat(64 * 1024 + 1), resolve));',
	);
	const stderr = output((await command([process.execPath, entry], source)).stdout);
	expect(stderr.ok).toBe(false);
	expect(stderr.error).toContain("build failed");
	expect(Buffer.byteLength(String(stderr.error))).toBeLessThan(66 * 1024);
	expect(
		await Bun.file(join(source, "plugins/provider-quota/dist/provider-quota.nfplugin")).exists(),
	).toBe(false);
}, 45_000);

test("real generated archive is embedded and loads after every copied source/output is removed", async () => {
	const { root, source, plugin, dist } = await pluginFixture();
	const built = await buildBundledPlugins({ root: source });
	const asset = built.assets[0];
	expect(asset).toMatchObject({ pluginId, version });
	const metadata = JSON.parse(await readFile(asset.metadataPath, "utf8"));
	expect(metadata).toEqual({
		schemaVersion: 1,
		pluginId,
		version,
		size: asset.size,
		sha256: asset.sha256,
	});
	const generated = await readFile(built.generatedModulePath, "utf8");
	expect(generated).toContain('with { type: "file" }');
	expect(generated).toContain(`sha256: "${asset.sha256}"`);
	expect(generated).toContain(`size: ${asset.size}`);
	expect(generated).not.toMatch(/^import.*(?:server\/index\.js|src\/index\.ts)/m);
	const entry = await probe(
		source,
		`import { getBundledPluginDescriptors } from "./services/bundled-plugin-assets";
import { isCompiledRuntime } from "./lib/runtime-target";
const descriptors = getBundledPluginDescriptors();
const loaded = await descriptors[0].load();
console.log("RESULT " + JSON.stringify({ compiled: isCompiledRuntime(), pluginId: descriptors[0].pluginId,
	version: descriptors[0].version, size: loaded.bytes.length, sha256: loaded.sha256,
	digest: Buffer.from(await crypto.subtle.digest("SHA-256", loaded.bytes)).toString("hex") }));`,
	);
	// Replace the public archive after generating this module, but before the compiler consumes it.
	await writeFile(join(plugin, "LICENSE"), "next publication while an older module is compiling\n");
	const replacement = await buildBundledPlugins({
		root: source,
		outDir: dist,
		publishGenerated: false,
	});
	expect(replacement.assets[0].sha256).not.toBe(asset.sha256);
	expect(
		createHash("sha256")
			.update(await readFile(join(dist, "provider-quota.nfplugin")))
			.digest("hex"),
	).toBe(replacement.assets[0].sha256);
	const binary = await compile(source, root, entry);
	await rm(source, { recursive: true, force: true });
	const unrelated = join(root, "unrelated-cwd");
	await mkdir(unrelated);
	expect(output((await command([binary], unrelated)).stdout)).toEqual({
		compiled: true,
		pluginId,
		version,
		size: asset.size,
		sha256: asset.sha256,
		digest: asset.sha256,
	});
}, 90_000);

test("compiled loader validates generated inventory/identity/size/SHA and refuses external file paths", async () => {
	const { root, source } = await fixture();
	const generatedDir = join(source, "server/generated");
	await mkdir(generatedDir);
	const archive = join(root, "fixture.nfplugin");
	await writeFile(archive, fixtureBytes);
	await writeFile(
		join(generatedDir, "embedded-bundled-plugins.ts"),
		`import archivePath from "../../../fixture.nfplugin" with { type: "file" };
const patch = JSON.parse(Bun.argv[2] || "{}");
export const embeddedBundledPluginAssets = Object.hasOwn(patch, "inventory") ? patch.inventory : [
	{ ...${JSON.stringify(fixtureIdentity)}, archivePath, ...patch }
];`,
	);
	const entry = await probe(source, loadProbe);
	const binary = await compile(source, root, entry);
	await rm(source, { recursive: true, force: true });
	await rm(archive);
	for (const [patch, message] of [
		[{ inventory: [] }, "inventory"],
		[{ pluginId: "org.third-party.plugin" }, "identity"],
		[{ version: "1.0.0" }, "identity"],
		[{ size: 16 * 1024 * 1024 + 1 }, "byte budget"],
		[{ sha256: "not-a-hash" }, "SHA-256 metadata"],
		[{ size: fixtureBytes.length + 1 }, "size mismatch"],
		[{ sha256: "f".repeat(64) }, "SHA-256 mismatch"],
		[{ archivePath: process.execPath }, "not an embedded"],
	] as const) {
		const result = output((await command([binary, JSON.stringify(patch)], root)).stdout);
		expect(result).toMatchObject({ ok: false, pluginId, version });
		expect(result.error).toContain(message);
	}
	expect(output((await command([binary, "{}"], root)).stdout)).toMatchObject({
		ok: true,
		sha256: fixtureIdentity.sha256,
	});
	expect(output((await command([binary, "{}", "abort"], root)).stdout)).toMatchObject({
		ok: false,
		error: "already cancelled",
	});
}, 90_000);

test("compilation fails closed when bundled generated assets are missing", async () => {
	const { root, source } = await fixture();
	const entry = await probe(source, loadProbe);
	const result = await command(
		[process.execPath, "build", entry, "--compile", "--outfile", join(root, "must-not-build")],
		source,
		true,
	);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain("embedded-bundled-plugins");
}, 60_000);
