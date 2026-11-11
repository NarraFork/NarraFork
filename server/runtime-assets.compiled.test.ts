import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderBuiltinPluginModule } from "../scripts/generate-builtin-plugins";
import { compileRuntimeBundle } from "../scripts/lib/runtime-compiler";
import { testEnvironment } from "../tests/preload";
import { safeSpawn } from "./lib/spawn";

const root = resolve(import.meta.dir, "..");

test("compiled version, brand, GenUI and Parcel never consult mutable source assets", async () => {
	const temp = await mkdtemp(join(testEnvironment.isolatedHome, "frozen-assets-"));
	try {
		const entry = join(temp, "probe.ts");
		const svg = join(temp, "frozen.svg");
		const js = join(temp, "frozen.js");
		const css = join(temp, "frozen.css");
		await writeFile(
			entry,
			`import { isCompiledRuntime } from ${JSON.stringify(join(root, "server/lib/runtime-target.ts"))};
if (!isCompiledRuntime()) throw new Error("probe must be compiled");
globalThis.sourceReads = 0;
globalThis.diskParcelLoads = 0;
globalThis.nativeSubscriptions = 0;
const originalFile = Bun.file;
Bun.file = (path, ...options) => {
  if (!String(path).includes("$bunfs/") && !String(path).includes("~BUN/") && !String(path).includes("%7EBUN/")) {
    globalThis.sourceReads++;
    throw new Error("source asset read");
  }
  return originalFile(path, ...options);
};
const version = await import(${JSON.stringify(join(root, "server/lib/version.ts"))});
if (version.APP_VERSION !== "frozen-version" || version.GIT_COMMIT !== "frozen-commit") throw new Error("mutable version");
const { getBrandIcons } = await import(${JSON.stringify(join(root, "server/lib/branding/icons.ts"))});
const icons = await getBrandIcons("#6366f1");
const { readInspectionRuntime } = await import(${JSON.stringify(join(root, "server/services/gen-ui/inspection-runtime.ts"))});
let inspection;
try { inspection = await readInspectionRuntime(new AbortController().signal); }
catch (error) { if (error.statusCode !== 503 && error.status !== 503) throw error; inspection = "unavailable"; }
const { getParcelWatcher } = await import(${JSON.stringify(join(root, "server/lib/watcher/parcel-binding.ts"))});
let parcel;
try {
  const watcher = await getParcelWatcher();
  await (await watcher.subscribe(".", () => {})).unsubscribe();
  parcel = "embedded";
} catch (error) {
  if (!String(error).includes("@parcel/watcher")) throw error;
  parcel = "unavailable";
}
if (globalThis.sourceReads || globalThis.diskParcelLoads) throw new Error("mutable source was consulted");
console.log(JSON.stringify({ version: version.APP_VERSION, icon: icons.favicon ? new TextDecoder().decode(icons.favicon.body) : null, inspection, parcel, subscriptions: globalThis.nativeSubscriptions }));`,
		);
		for (const present of [true, false]) {
			await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg">frozen-brand</svg>');
			await writeFile(js, "frozen-runtime-js");
			await writeFile(css, "frozen-runtime-css");
			const binary = join(temp, `probe-${present}${process.platform === "win32" ? ".exe" : ""}`);
			const built = await Bun.build({
				entrypoints: [entry],
				target: "bun",
				compile: { outfile: binary },
				plugins: [
					{
						name: "frozen-assets-fixtures",
						setup(build) {
							build.onResolve(
								{ filter: /generated\/(?:build-info|embedded-frontend|parcel-native-loader)$/ },
								(args) => ({
									path: args.path,
									namespace: "frozen-fixture",
								}),
							);
							build.onResolve({ filter: /^@parcel\/watcher$/ }, () => ({
								path: "disk-parcel",
								namespace: "frozen-fixture",
							}));
							build.onResolve({ filter: /^node:fs$/ }, (args) =>
								args.importer.endsWith("/lib/version.ts")
									? { path: "version-fs", namespace: "frozen-fixture" }
									: undefined,
							);
							build.onLoad({ filter: /.*/, namespace: "frozen-fixture" }, (args) => {
								let contents: string;
								if (args.path === "version-fs") {
									contents =
										'export function existsSync() { globalThis.sourceReads++; return true; } export function readFileSync() { return \'{"version":"mutable"}\'; }';
								} else if (args.path === "disk-parcel") {
									contents =
										'globalThis.diskParcelLoads++; export const subscribe = () => { throw new Error("disk parcel"); };';
								} else if (args.path.endsWith("build-info")) {
									contents =
										'export const buildVersion = "frozen-version"; export const buildCommit = "frozen-commit";';
								} else if (args.path.endsWith("parcel-native-loader")) {
									contents = `export function loadParcelNativeBinding() { return ${present ? "{ subscribe() { globalThis.nativeSubscriptions++; }, unsubscribe() {} }" : "null"}; }`;
								} else {
									contents = present
										? `import icon from ${JSON.stringify(svg)} with { type: "file" }; import js from ${JSON.stringify(js)} with { type: "file" }; import css from ${JSON.stringify(css)} with { type: "file" }; export const embeddedAssets = { "/favicon.svg": icon, "/plugin-runtime/vendor.js": js, "/plugin-runtime/vendor.css": css };`
										: "export const embeddedAssets = {};";
								}
								return { contents, loader: "ts", resolveDir: root };
							});
						},
					},
				],
			});
			expect(built.success, built.logs.map(String).join("\n")).toBe(true);
			// Mutations after compilation must not change any bytes served by this process.
			for (const file of [svg, js, css]) await writeFile(file, "mutable-after-build");
			const run = await safeSpawn({
				cmd: [binary],
				cwd: temp,
				env: { ...process.env, NARRAFORK_HOME: join(temp, "home") },
				timeout: 10_000,
				maxOutputBytes: 32 * 1024,
			});
			expect(run.exitCode, run.stderr).toBe(0);
			const line = run.stdout.trim().split("\n").at(-1);
			expect(JSON.parse(line ?? "")).toEqual({
				version: "frozen-version",
				icon: present ? '<svg xmlns="http://www.w3.org/2000/svg">frozen-brand</svg>' : null,
				inspection: present
					? { runtimeJs: "frozen-runtime-js", runtimeCss: "frozen-runtime-css" }
					: "unavailable",
				parcel: present ? "embedded" : "unavailable",
				subscriptions: present ? 1 : 0,
			});
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);

test("missing build info fails identified runtimes but keeps bare compiled probes source-free", async () => {
	const temp = await mkdtemp(join(testEnvironment.isolatedHome, "frozen-version-"));
	try {
		const entry = join(temp, "version-probe.ts");
		await writeFile(
			entry,
			`globalThis.sourceReads = 0;
try {
  const version = await import(${JSON.stringify(join(root, "server/lib/version.ts"))});
  console.log(JSON.stringify({ version: version.APP_VERSION, sourceReads: globalThis.sourceReads }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, sourceReads: globalThis.sourceReads }));
}`,
		);
		for (const identified of [true, false]) {
			const binary = join(
				temp,
				`version-${identified}${process.platform === "win32" ? ".exe" : ""}`,
			);
			const built = await Bun.build({
				entrypoints: [entry],
				target: "bun",
				compile: { outfile: binary },
				define: identified ? { __NARRAFORK_RUNTIME_BUILD_ID__: '"frozen-test"' } : {},
				plugins: [
					{
						name: "missing-version-fixture",
						setup(build) {
							build.onResolve({ filter: /generated\/build-info$/ }, () => ({
								path: "missing-version",
								namespace: "version-fixture",
							}));
							build.onResolve({ filter: /^node:fs$/ }, (args) =>
								args.importer.endsWith("/lib/version.ts")
									? { path: "source-fs", namespace: "version-fixture" }
									: undefined,
							);
							build.onLoad({ filter: /.*/, namespace: "version-fixture" }, (args) => ({
								loader: "ts",
								contents:
									args.path === "missing-version"
										? 'throw new Error("fixture: missing build info"); export const buildVersion = "unused"; export const buildCommit = "unused";'
										: 'export function existsSync() { globalThis.sourceReads++; return true; } export function readFileSync() { return \'{"version":"mutable"}\'; }',
							}));
						},
					},
				],
			});
			expect(built.success, built.logs.map(String).join("\n")).toBe(true);
			const run = await safeSpawn({
				cmd: [binary],
				cwd: temp,
				timeout: 10_000,
				maxOutputBytes: 32 * 1024,
			});
			expect(run.exitCode, run.stderr).toBe(0);
			expect(JSON.parse(run.stdout)).toEqual(
				identified
					? { error: "Embedded build information is unavailable", sourceReads: 0 }
					: { version: "0.0.0", sourceReads: 0 },
			);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);

test("frozen builds embed builtin plugins without sharing mutable materialized copies", async () => {
	const temp = await mkdtemp(join(testEnvironment.isolatedHome, "frozen-plugins-"));
	try {
		const source = join(temp, "source");
		const plugin = join(source, "server/builtin-plugins/fixture");
		await mkdir(plugin, { recursive: true });
		await writeFile(
			join(plugin, "manifest.json"),
			JSON.stringify({ pluginId: "fixture", version: "1.0.0" }),
		);
		const entry = join(temp, "probe.ts");
		await writeFile(
			entry,
			`
import { materializeBuiltinPlugins } from ${JSON.stringify(join(root, "server/builtin-plugins/materialize.ts"))};
const [directory] = await materializeBuiltinPlugins();
if (!directory) throw new Error("builtin package missing from frozen build");
console.log(JSON.stringify({ directory, content: await Bun.file(directory + "/index.js").text() }));
`,
		);
		const binaries = new Map<string, string>();
		for (const id of ["A", "B"]) {
			await writeFile(join(plugin, "index.js"), `export const marker = "${id}";`);
			const binary = join(temp, `probe-${id}${process.platform === "win32" ? ".exe" : ""}`);
			await compileRuntimeBundle({
				root,
				entrypoints: [entry],
				outfile: binary,
				buildId: id,
				repository: "fixture/repository",
				modules: new Map([
					["embedded-builtin-plugins.ts", await renderBuiltinPluginModule(source)],
					[
						"build-info.ts",
						'export const buildVersion = "fixture"; export const buildCommit = "fixture";',
					],
				]),
			});
			binaries.set(id, binary);
		}
		await rm(source, { recursive: true });
		const directories: string[] = [];
		for (const id of ["A", "B", "A"]) {
			const result = await safeSpawn({
				cmd: [binaries.get(id) as string],
				cwd: temp,
				env: { ...process.env, NARRAFORK_HOME: join(temp, "home") },
				timeout: 10_000,
				maxOutputBytes: 32 * 1024,
			});
			expect(result.exitCode, result.stderr).toBe(0);
			const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
			expect(output.content).toBe(`export const marker = "${id}";`);
			directories.push(output.directory);
		}
		expect(directories[0]).not.toBe(directories[1]);
		expect(directories[0]).toBe(directories[2]);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);
