import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuildInfo, renderBuildInfo } from "../../scripts/lib/build-materials";
import {
	compileRuntimeBundle,
	runtimeComponentDistributions,
} from "../../scripts/lib/runtime-compiler";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";
import { REMOTE_PEER_DISTRIBUTION } from "../../shared/remote-peer-distribution";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
	const value = mkdtempSync(join(tmpdir(), "nf-build-peer-metadata-"));
	roots.push(value);
	return value;
}
function put(path: string, contents: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents);
}
const foreign = {
	executor: { version: "7.8.9", protocolVersion: 4 },
	remotePeer: { version: "0.3.0-alpha.2", protocolVersion: 3 },
};
function info(distribution: BuildInfo["remotePeerDistribution"]): BuildInfo {
	return {
		version: "9.9.9",
		commit: "fixture-commit",
		platform: "fixture",
		repository: "fixture/repository",
		helperDistribution: createHelperDistributionDependencies(),
		remotePeerDistribution: distribution,
	};
}
async function generatedModule(input: BuildInfo) {
	const source = renderBuildInfo(input);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

describe("central optional remote peer build metadata", () => {
	test("renderer preserves the explicitly frozen pin through per-platform overrides", async () => {
		expect(REMOTE_PEER_DISTRIBUTION).toBeDefined();
		const initial = info(REMOTE_PEER_DISTRIBUTION),
			release = await generatedModule(initial),
			platform = await generatedModule({ ...initial, platform: "darwin-arm64" });
		expect(release.buildRemotePeerDistribution).toEqual(REMOTE_PEER_DISTRIBUTION);
		expect(platform.buildRemotePeerDistribution).toEqual(release.buildRemotePeerDistribution);
		expect(platform.buildPlatform).toBe("darwin-arm64");
		expect(platform.buildRemotePeerDistribution.version).not.toBe(platform.buildVersion);
	});
	test("renderer never invents a peer for an undeclared historical target", async () => {
		const { remotePeerDistribution: _optional, ...legacy } = info(undefined);
		const generated = await generatedModule(legacy);
		expect(generated.buildRemotePeerDistribution).toBeUndefined();
		expect(generated.buildVersion).toBe("9.9.9");
		expect(renderBuildInfo(legacy)).not.toContain("remote-peer-v");
	});
	test("local runtime reads target root pins as data, not the compiler tree's globals", () => {
		const target = root();
		put(join(target, "shared/component-versions.json"), JSON.stringify(foreign));
		const declarations = runtimeComponentDistributions(target);
		expect(declarations.remotePeerDistribution).toEqual({
			...foreign.remotePeer,
			tag: `remote-peer-v${foreign.remotePeer.version}`,
		});
		expect(declarations.remotePeerDistribution).not.toEqual(REMOTE_PEER_DISTRIBUTION);
		expect(declarations.helperDistribution.executor).toEqual({
			...foreign.executor,
			tag: `executor-v${foreign.executor.version}`,
		});
		expect(Object.isFrozen(declarations.remotePeerDistribution)).toBe(true);
	});
	test("missing file and executor-only historical declarations leave the optional peer absent", () => {
		const target = root();
		expect(runtimeComponentDistributions(target).remotePeerDistribution).toBeUndefined();
		put(
			join(target, "shared/component-versions.json"),
			JSON.stringify({ executor: foreign.executor }),
		);
		const declarations = runtimeComponentDistributions(target);
		expect(declarations.remotePeerDistribution).toBeUndefined();
		expect(declarations.helperDistribution.executor.version).toBe(foreign.executor.version);
	});
	test("invalid explicit declarations, bad JSON and oversized metadata fail instead of falling back", () => {
		const target = root(),
			path = join(target, "shared/component-versions.json");
		for (const contents of [
			"invalid JSON",
			JSON.stringify({ ...foreign, remotePeer: { version: "latest", protocolVersion: 2 } }),
			JSON.stringify({ ...foreign, remotePeer: null }),
			" ".repeat(64 * 1024 + 1),
		]) {
			put(path, contents);
			expect(() => runtimeComponentDistributions(target)).toThrow();
		}
	});
	test.each([
		true,
		false,
	])("local compiled in-memory material retains optional target declaration=%s after source deletion", async (present) => {
		const target = root(),
			declarations = present ? foreign : { executor: foreign.executor };
		put(join(target, "shared/component-versions.json"), JSON.stringify(declarations));
		const frozen = runtimeComponentDistributions(target),
			entry = join(target, "server/probe.ts"),
			binary = join(target, process.platform === "win32" ? "probe.exe" : "probe");
		put(
			join(target, "server/generated/build-info.ts"),
			'throw new Error("generated source must not be loaded");',
		);
		put(
			entry,
			'import {buildVersion,buildRemotePeerDistribution,buildHelperDistribution} from "./generated/build-info";console.log(JSON.stringify({version:buildVersion,peer:buildRemotePeerDistribution,helpers:buildHelperDistribution}));',
		);
		await compileRuntimeBundle({
			root: target,
			entrypoints: [entry],
			outfile: binary,
			buildId: "target-peer-fixture",
			repository: "fixture/repository",
			modules: new Map([
				[
					"build-info.ts",
					renderBuildInfo({
						...info(frozen.remotePeerDistribution),
						helperDistribution: frozen.helperDistribution,
					}),
				],
			]),
		});
		rmSync(join(target, "server"), { recursive: true, force: true });
		rmSync(join(target, "shared"), { recursive: true, force: true });
		const result = JSON.parse(
			execFileSync(binary, [], { cwd: target, encoding: "utf8", timeout: 5000, maxBuffer: 8192 }),
		);
		expect(result.version).toBe("9.9.9");
		expect(result.peer).toEqual(present ? frozen.remotePeerDistribution : undefined);
		expect(result.helpers.executor.version).toBe(foreign.executor.version);
	}, 30000);
});
