import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REMOTE_PEER_DISTRIBUTION } from "../../shared/remote-peer-distribution";

const root = resolve(import.meta.dir, "../..");
async function compiledVersion(peer: unknown, present: boolean) {
	const result = await Bun.build({
		entrypoints: [resolve(root, "server/lib/version.ts")],
		target: "bun",
		format: "esm",
		plugins: [
			{
				name: "compiled-version-fixture",
				setup(build) {
					build.onResolve({ filter: /^node:fs$/ }, () => ({ path: "fs", namespace: "fixture" }));
					build.onResolve({ filter: /^node:child_process$/ }, () => ({
						path: "child",
						namespace: "fixture",
					}));
					build.onResolve({ filter: /^@server\/generated\/build-info$/ }, () => ({
						path: "info",
						namespace: "fixture",
					}));
					build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
						if (args.path === "fs")
							return {
								contents:
									"export const existsSync=()=>false;export const readFileSync=()=>{throw Error('compiled filesystem read forbidden')};",
								loader: "js",
							};
						if (args.path === "child")
							return {
								contents:
									"export const execSync=()=>{throw Error('compiled shell lookup forbidden')};",
								loader: "js",
							};
						return {
							contents: `export const buildVersion='9.9.9';export const buildCommit='legacy-test';export const buildPlatform='linux-x64';${present ? `export const buildRemotePeerDistribution=${JSON.stringify(peer)};` : ""}`,
							loader: "js",
						};
					});
				},
			},
		],
	});
	if (!result.success) throw new AggregateError(result.logs, "Fixture bundle failed");
	return import(
		`data:text/javascript;base64,${Buffer.from(await result.outputs[0].text()).toString("base64")}`
	);
}
describe("remote peer is an optional non-bundled component", () => {
	test("compiled legacy NF never selects current source pin or APP_VERSION", async () => {
		for (const present of [false, true]) {
			const mod = await compiledVersion(undefined, present);
			expect(mod.APP_VERSION).toBe("9.9.9");
			expect(mod.BUILD_REMOTE_PEER_DISTRIBUTION).toBeUndefined();
		}
	});
	test("compiled metadata preserves exact independent peer identity", async () => {
		const mod = await compiledVersion(REMOTE_PEER_DISTRIBUTION, true);
		expect(mod.BUILD_REMOTE_PEER_DISTRIBUTION).toEqual(REMOTE_PEER_DISTRIBUTION);
		expect(mod.BUILD_REMOTE_PEER_DISTRIBUTION.version).not.toBe(mod.APP_VERSION);
		expect(Object.isFrozen(mod.BUILD_REMOTE_PEER_DISTRIBUTION)).toBe(true);
	});
	test("explicit corrupted peer metadata fails closed, not a legacy fallback", async () => {
		await expect(
			compiledVersion({ version: "latest", protocolVersion: 1, tag: "remote-peer-latest" }, true),
		).rejects.toThrow();
	});
	test("main build and startup keep optional component preparation out of defaults", async () => {
		const [build, materials, compiler, main, startup] = await Promise.all([
			readFile(resolve(root, "scripts/build-cross-platform.ts"), "utf8"),
			readFile(resolve(root, "scripts/lib/build-materials.ts"), "utf8"),
			readFile(resolve(root, "scripts/lib/runtime-compiler.ts"), "utf8"),
			readFile(resolve(root, "server/main.ts"), "utf8"),
			readFile(resolve(root, "server/index.ts"), "utf8"),
		]);
		expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(build)).not.toThrow();
		expect(materials.match(/export const buildRemotePeerDistribution =/g)).toHaveLength(1);
		expect(materials).toContain("JSON.stringify(info.remotePeerDistribution)");
		expect(build).toMatch(/remotePeerDistribution:\s*REMOTE_PEER_DISTRIBUTION/);
		expect(build).toContain("collectBuildModules(");
		expect(build).toContain("renderBuildInfo({ ...buildInfo, platform: platform.platformId })");
		expect(compiler).toContain("...runtimeComponentDistributions(root)");
		for (const source of [build, materials, compiler]) {
			expect(source).not.toContain("remote-peer/dist");
			expect(source).not.toMatch(/buildRemotePeerPlatform|ensureRemotePeerBinary|go build/);
		}
		for (const entry of [main, startup])
			expect(entry).not.toMatch(/remote-peer-binaries|ensureRemotePeerBinary|remote-peer\/dist/);
	});
});
