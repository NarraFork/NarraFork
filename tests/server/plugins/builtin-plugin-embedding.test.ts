import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BUILTIN_PLUGIN_ROOTS } from "@server/builtin-plugins/registry";
import { embeddedBuiltinPlugins } from "@server/generated/embedded-builtin-plugins";
import { PluginCatalog } from "@server/services/plugin-catalog";

/**
 * Guard the generated embedding against drift.
 *
 * `server/generated/embedded-builtin-plugins.ts` is produced by
 * `scripts/generate-builtin-plugins.ts` from the checked-out packages. Nothing at runtime
 * notices if it goes stale: a compiled binary would materialize an old package while a
 * source run uses the new one, so the two distributions would behave differently with no
 * error anywhere. Type checking cannot see it either, because both sides are plain strings.
 */
const PACKAGE_DIR = join(import.meta.dir, "..", "..", "..", "server", "builtin-plugins");

function listFiles(root: string, dir = root): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(root, full));
		else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
	}
	return out.sort((a, b) => a.localeCompare(b));
}

describe("embedded builtin plugin packages match the checked-out packages", () => {
	test("every builtin root is embedded, and nothing extra is", () => {
		const expected = BUILTIN_PLUGIN_ROOTS.map(
			(root) => root.split(/[\\/]/).pop() as string,
		).sort((a, b) => a.localeCompare(b));
		expect(embeddedBuiltinPlugins.map((pkg) => pkg.dir).sort((a, b) => a.localeCompare(b))).toEqual(
			expected,
		);
	});

	for (const root of BUILTIN_PLUGIN_ROOTS) {
		const dir = root.split(/[\\/]/).pop() as string;

		test(`${dir}: embedded files are exactly the package files, byte for byte`, () => {
			const pkg = embeddedBuiltinPlugins.find((entry) => entry.dir === dir);
			expect(pkg).toBeDefined();
			const onDisk = listFiles(root);
			expect(pkg?.files.map((file) => file.path)).toEqual(onDisk);
			for (const file of pkg?.files ?? []) {
				expect(readFileSync(join(root, file.path), "utf8")).toBe(file.content);
			}
		});

		test(`${dir}: the embedded identity the package declares`, () => {
			const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
				pluginId: string;
				version: string;
			};
			const pkg = embeddedBuiltinPlugins.find((entry) => entry.dir === dir);
			expect(pkg?.pluginId).toBe(manifest.pluginId);
			expect(pkg?.version).toBe(manifest.version);
		});
	}
});

/**
 * The generator scans `server/builtin-plugins/` itself instead of importing the registry
 * (importing it would cycle through the file the generator writes). That deliberate
 * duplication is only safe while both name the same packages.
 */
describe("the generator scans the same directory the registry points at", () => {
	test("every builtin root sits directly under server/builtin-plugins", () => {
		for (const root of BUILTIN_PLUGIN_ROOTS) {
			const parent = join(root, "..");
			// `relative` answers "" for the same directory, not ".".
			expect(relative(PACKAGE_DIR, parent).replaceAll(sep, "/")).toBe("");
		}
	});
});

/**
 * What a compiled binary actually does: write the embedded packages out, then hand the
 * directory to the ordinary package reader. Verified through the same path a binary uses —
 * materialize, then scan with the real catalog — because writing plausible files somewhere
 * is not the same as producing a package the runtime accepts.
 *
 * The test preload points NARRAFORK_HOME at a temporary directory, so this never touches the
 * developer's real data directory.
 */
describe("materializing the embedded packages produces a package the catalog accepts", () => {
	test("the materialized directory holds a readable package and scans as compatible", async () => {
		const { materializeBuiltinPlugins } = await import("@server/builtin-plugins/materialize");
		const dirs = await materializeBuiltinPlugins();
		expect(dirs.length).toBe(BUILTIN_PLUGIN_ROOTS.length);

		for (const [index, dir] of dirs.entries()) {
			const name = BUILTIN_PLUGIN_ROOTS[index]?.split(/[\\/]/).pop() as string;
			// Versioned layout: .../builtin-plugins/<dir>/<version>
			const parts = dir.split(/[\\/]/);
			expect(parts.at(-2)).toBe(name);

			// The manifest must parse and still declare the entry the runtime spawns.
			const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
				pluginId: string;
				server: { entry: string };
			};
			expect(readFileSync(join(dir, manifest.server.entry), "utf8").length).toBeGreaterThan(0);
		}

		// And the real catalog reads the materialized copy exactly like the checked-out one.
		const catalog = new PluginCatalog({ builtinRoots: dirs });
		const snapshot = await catalog.scan();
		const plugin = snapshot.plugins.find(
			(entry) => entry.pluginId === "com.narrafork.apikey-quota",
		);
		expect(plugin?.builtin).toBe(true);
		expect(plugin?.status).toBe("compatible");
		expect(plugin?.diagnostics).toEqual([]);
	});
});
