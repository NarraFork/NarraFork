import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginRelease } from "../../../scripts/validate-plugin-release";
import { PluginPackageStore } from "../../../server/services/plugin-package-store";
import { parseSbom } from "../../../server/services/plugin-sbom";
import { buildProviderQuotaPlugin } from "../build";

test("actual independent .nfplugin installs in an isolated store and passes release runtime/GA validation", async () => {
	const root = await mkdtemp(join(tmpdir(), "narrafork-provider-quota-package-"));
	try {
		const outDir = join(root, "build");
		const result = await buildProviderQuotaPlugin({ outDir });
		expect(result.archivePath).toBe(join(outDir, "provider-quota.nfplugin"));
		expect(await Bun.file(result.archivePath).exists()).toBe(true);
		const rawSbom = JSON.parse(
			await readFile(join(result.packageRoot, "sbom.spdx.json"), "utf8"),
		) as {
			packages: unknown[];
			files: Array<{
				fileName: string;
				checksums: Array<{ algorithm: string; checksumValue: string }>;
			}>;
		};
		const sbom = parseSbom(rawSbom);
		expect(
			sbom.components.map((component) => [component.name, component.version, component.license]),
		).toEqual([
			["io.narrafork.provider-quota", "1.0.4", "MPL-2.0"],
			["zod", "4.3.6", "MIT"],
		]);
		for (const file of rawSbom.files) {
			const bytes = await readFile(join(result.packageRoot, file.fileName));
			expect(file.checksums).toContainEqual({
				algorithm: "SHA256",
				checksumValue: createHash("sha256").update(bytes).digest("hex"),
			});
		}
		expect(await readFile(join(result.packageRoot, "licenses", "zod.LICENSE"), "utf8")).toContain(
			"MIT License",
		);
		expect(await readFile(join(result.packageRoot, "LICENSE"), "utf8")).toContain(
			"Mozilla Public License",
		);
		const store = new PluginPackageStore({ root: join(root, "store") });
		const installed = await store.install(result.archivePath);
		const archive = await readFile(result.archivePath);
		const metadata = JSON.parse(await readFile(join(outDir, "provider-quota.asset.json"), "utf8"));
		expect(metadata).toEqual({
			schemaVersion: 1,
			pluginId: installed.pluginId,
			version: installed.version,
			size: archive.byteLength,
			sha256: createHash("sha256").update(archive).digest("hex"),
			packageHash: installed.hash,
		});
		expect(installed.pluginId).toBe("io.narrafork.provider-quota");
		expect(installed.manifest.contributes.quotaSources).toHaveLength(4);
		const sourceMetadata = JSON.parse(
			await readFile(join(installed.packagePath, "plugin-source.json"), "utf8"),
		);
		expect(sourceMetadata).toEqual({
			schemaVersion: 1,
			pluginId: installed.pluginId,
			source: { type: "local", builtinId: installed.pluginId },
		});
		expect(Object.hasOwn(sourceMetadata.source, "homepage")).toBe(false);
		expect(await readFile(join(installed.packagePath, "sources/plugin-source.json"), "utf8")).toBe(
			await readFile(join(installed.packagePath, "plugin-source.json"), "utf8"),
		);
		expect(await Bun.file(join(installed.packagePath, "server", "index.js")).exists()).toBe(true);
		const validation = await validatePluginRelease(outDir, {
			mode: "ga",
			runtimeTimeoutMs: 10_000,
		});
		expect(validation.errors).toEqual([]);
		expect(validation.valid).toBe(true);
		expect(validation.packages[0]?.runtime).toMatchObject({
			status: "passed",
			handshake: { hello: true, initialize: true, activate: true, health: true },
			quotaQuery: { contributionId: "relay", status: "error" },
		});
		expect(validation.packages[0]?.runtime).not.toHaveProperty("provider");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 45_000);

test("same source/version produces identical ZIP bytes and content hash without relaxing immutability", async () => {
	const root = await mkdtemp(join(tmpdir(), "narrafork-provider-quota-reproducible-"));
	try {
		const outDir = join(root, "build");
		const first = await buildProviderQuotaPlugin({ outDir });
		const firstBytes = await readFile(first.archivePath);
		const store = new PluginPackageStore({ root: join(root, "store") });
		const firstInstalled = await store.install(first.archivePath);
		expect(firstInstalled.version).toBe("1.0.4");
		// Deliberately vary existing output stats; a subsequent build must not package them.
		await chmod(join(first.packageRoot, "LICENSE"), 0o600);
		await utimes(
			join(first.packageRoot, "LICENSE"),
			new Date("2001-02-03T04:05:06Z"),
			new Date("2001-02-03T04:05:06Z"),
		);
		const second = await buildProviderQuotaPlugin({ outDir });
		const secondBytes = await readFile(second.archivePath);
		expect(secondBytes).toEqual(firstBytes);
		expect(createHash("sha256").update(secondBytes).digest("hex")).toBe(
			createHash("sha256").update(firstBytes).digest("hex"),
		);
		const secondInstalled = await store.install(second.archivePath);
		expect(secondInstalled.hash).toBe(firstInstalled.hash);
		expect(secondInstalled.alreadyInstalled).toBe(true);
		expect(
			JSON.parse(await readFile(join(second.packageRoot, "sbom.spdx.json"), "utf8")),
		).toMatchObject({ creationInfo: { created: "1980-01-01T00:00:00.000Z" } });
		await writeFile(join(second.packageRoot, "LICENSE"), "different same-version contents\n");
		await expect(store.install(second.packageRoot)).rejects.toThrow("different hash");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 45_000);
