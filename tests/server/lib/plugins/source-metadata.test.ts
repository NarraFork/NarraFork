import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPluginSourceMetadata } from "../../../../server/lib/plugins/source-metadata";
import {
	PLUGIN_SOURCE_MAX_METADATA_BYTES,
	PLUGIN_SOURCE_METADATA_FILE,
} from "../../../../shared/plugin-source";

const pluginId = "io.example.legacy";
const roots: string[] = [];
async function fixture(value?: unknown | Uint8Array | string) {
	const root = await mkdtemp(join(process.cwd(), ".narrafork", "plugin-source-metadata-test-"));
	roots.push(root);
	const packagePath = join(root, "package");
	await mkdir(packagePath);
	if (value !== undefined) {
		await writeFile(
			join(packagePath, PLUGIN_SOURCE_METADATA_FILE),
			typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value),
		);
	}
	return { root, packagePath };
}
const valid = {
	schemaVersion: 1,
	pluginId,
	source: { type: "website", updateApi: "https://plugins.example/latest" },
};
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("optional package source metadata", () => {
	test("a legacy package without source metadata remains valid with no diagnostics", async () => {
		const { packagePath } = await fixture();
		expect(await readPluginSourceMetadata(packagePath, pluginId)).toEqual({
			source: null,
			diagnostics: [],
		});
	});

	test("reads a declared source without inventing its homepage", async () => {
		const { packagePath } = await fixture(valid);
		const result = await readPluginSourceMetadata(packagePath, pluginId);
		expect(result.source).toMatchObject({
			type: "website",
			updateApi: valid.source.updateApi,
			allowInsecureHttp: false,
		});
		expect(result.source?.homepage).toBeUndefined();
		expect(result.diagnostics).toEqual([]);
	});

	test("accepts a matching optional local source, not another builtin identity", async () => {
		const { packagePath } = await fixture({
			...valid,
			source: { type: "local", builtinId: pluginId },
		});
		expect((await readPluginSourceMetadata(packagePath, pluginId)).source?.type).toBe("local");
		await writeFile(
			join(packagePath, PLUGIN_SOURCE_METADATA_FILE),
			JSON.stringify({ ...valid, source: { type: "local", builtinId: "io.example.other" } }),
		);
		expect((await readPluginSourceMetadata(packagePath, pluginId)).diagnostics[0]?.code).toBe(
			"SOURCE_MISMATCH",
		);
	});

	test("a damaged, unsafe or unknown source produces diagnostics without failing a package", async () => {
		for (const value of [
			"{broken",
			{ ...valid, schemaVersion: 2 },
			{ ...valid, source: { ...valid.source, homepage: "javascript:run()" } },
			{ ...valid, source: { type: "custom", script: "update()" } },
		]) {
			const { packagePath } = await fixture(value);
			const result = await readPluginSourceMetadata(packagePath, pluginId);
			expect(result.source).toBeNull();
			expect(result.diagnostics[0]?.code).toBe("SOURCE_INVALID");
		}
	});

	test("rejects a foreign plugin ID without exposing file content in diagnostics", async () => {
		const { packagePath } = await fixture({
			...valid,
			pluginId: "io.example.foreign",
			privateToken: "never-log-this",
		});
		const invalid = await readPluginSourceMetadata(packagePath, pluginId);
		expect(invalid.source).toBeNull();
		expect(JSON.stringify(invalid)).not.toContain("never-log-this");
		await writeFile(
			join(packagePath, PLUGIN_SOURCE_METADATA_FILE),
			JSON.stringify({ ...valid, pluginId: "io.example.foreign" }),
		);
		expect((await readPluginSourceMetadata(packagePath, pluginId)).diagnostics[0]?.code).toBe(
			"SOURCE_MISMATCH",
		);
	});

	test("strict UTF-8 and bounded metadata protect optional source reads", async () => {
		for (const value of [
			new Uint8Array([0xff, 0xfe, 0xfa]),
			"x".repeat(PLUGIN_SOURCE_MAX_METADATA_BYTES + 1),
		]) {
			const { packagePath } = await fixture(value);
			expect((await readPluginSourceMetadata(packagePath, pluginId)).diagnostics[0]?.code).toBe(
				"SOURCE_INVALID",
			);
		}
		const { packagePath } = await fixture(valid);
		expect(
			(await readPluginSourceMetadata(packagePath, pluginId, { maxBytes: 4 })).source,
		).toBeNull();
		expect(
			(await readPluginSourceMetadata(packagePath, pluginId, { maxBytes: Number.NaN })).source
				?.type,
		).toBe("website");
	});

	test("source file directories and symlinks cannot become package sources", async () => {
		const { root, packagePath } = await fixture();
		const path = join(packagePath, PLUGIN_SOURCE_METADATA_FILE);
		await mkdir(path);
		expect((await readPluginSourceMetadata(packagePath, pluginId)).source).toBeNull();
		await rm(path, { recursive: true });
		const outside = join(root, "outside.json");
		await writeFile(outside, JSON.stringify(valid));
		await symlink(outside, path, "file");
		const result = await readPluginSourceMetadata(packagePath, pluginId);
		expect(result.source).toBeNull();
		expect(result.diagnostics[0]?.code).toBe("SOURCE_INVALID");
	});

	test("explicit cancellation is not reported as an innocent absent source", async () => {
		const { packagePath } = await fixture();
		const controller = new AbortController();
		controller.abort(new Error("source-read-cancelled"));
		await expect(
			readPluginSourceMetadata(packagePath, pluginId, { signal: controller.signal }),
		).rejects.toThrow("source-read-cancelled");
	});
});
