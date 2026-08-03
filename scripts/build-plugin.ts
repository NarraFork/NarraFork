/**
 * Bundles a plugin's TypeScript sources into the JS artifacts its manifest points at.
 *
 * Existing example plugins are hand-written JavaScript, which works while a plugin is a
 * so it needs a real bundler.
 *
 * Design choices:
 *
 * - **`Bun.build`, not esbuild/rollup.** The repo already runs on Bun everywhere; adding a
 *   second bundler would mean a second config format and dependency to keep current.
 * - **Artifacts are committed.** `validate-plugin-release.ts` runs a real handshake against
 *   `server.entry`, and the plugin runtime spawns that file directly. Both need the built
 *   output to exist without a build step, exactly like the hand-written plugins.
 * - **Server target is `bun`, UI target is `browser` + IIFE.** The UI runs in a sandboxed
 *   iframe with no module loader and reads the injected `globalThis.narrafork` SDK.
 * - **No minification.** These artifacts are committed and reviewed; a readable diff is
 *   worth more than a few KB, and a plugin bundle is not on any hot path.
 *
 * Usage:
 *
 * `--check` rebuilds into a temp directory and compares bytes. It is what keeps a stale
 * artifact from silently shipping when someone edits `src/` and forgets to rebuild.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PLUGINS_ROOT = join(REPO_ROOT, "examples/plugins");

export interface PluginBuildTarget {
	/** Entry source, relative to the plugin directory. */
	entry: string;
	/** Output artifact, relative to the plugin directory. Must match the manifest. */
	outfile: string;
	target: "bun" | "browser";
	/** IIFE keeps the UI loadable via a plain `<script>` tag in the sandboxed iframe. */
	format?: "esm" | "iife";
}

export interface PluginBuildConfig {
	targets: PluginBuildTarget[];
}

/**
 * Build definitions per plugin.
 *
 * Kept here rather than in a per-plugin config file so that adding a build step is a
 * reviewed change in the host repo: a plugin cannot introduce its own build behaviour.
 */
export const PLUGIN_BUILDS: Record<string, PluginBuildConfig> = {
		targets: [
			{ entry: "src/server.ts", outfile: "server/index.js", target: "bun", format: "esm" },
			{
				entry: "src/ui/provider-settings.ts",
				outfile: "ui/provider-settings.iife.js",
				target: "browser",
				format: "iife",
			},
		],
	},
};

export interface BuiltArtifact {
	outfile: string;
	code: string;
}

/** Bundle every target for a plugin and return the artifacts without writing them. */
export async function buildPluginArtifacts(pluginName: string): Promise<BuiltArtifact[]> {
	const config = PLUGIN_BUILDS[pluginName];
	if (!config) {
		throw new Error(
			`Unknown plugin: ${pluginName}. Known: ${Object.keys(PLUGIN_BUILDS).join(", ") || "(none)"}`,
		);
	}
	const pluginRoot = join(PLUGINS_ROOT, pluginName);
	const artifacts: BuiltArtifact[] = [];

	for (const target of config.targets) {
		const built = await Bun.build({
			entrypoints: [join(pluginRoot, target.entry)],
			target: target.target,
			format: target.format ?? "esm",
			minify: false,
			// Plugins run as their own process / document, so everything must be inlined.
			// A leftover bare import would fail at load time, not build time.
			external: [],
		});
		if (!built.success) {
			throw new Error(
				`Build failed for ${pluginName}/${target.entry}:\n${built.logs
					.map((entry) => String(entry))
					.join("\n")}`,
			);
		}
		if (built.outputs.length !== 1) {
			throw new Error(
				`Expected exactly one output for ${target.entry}, got ${built.outputs.length}`,
			);
		}
		artifacts.push({ outfile: target.outfile, code: await built.outputs[0].text() });
	}
	return artifacts;
}

/** Write artifacts into the plugin directory. */
export async function writePluginArtifacts(
	pluginName: string,
	artifacts: BuiltArtifact[],
): Promise<void> {
	const pluginRoot = join(PLUGINS_ROOT, pluginName);
	for (const artifact of artifacts) {
		// `Bun.write` creates parent directories as needed.
		await Bun.write(join(pluginRoot, artifact.outfile), artifact.code);
	}
}

/**
 * Compare freshly built output against what is committed.
 *
 * Returns the artifacts that differ, so a caller can report all of them at once instead of
 * failing on the first.
 */
export async function checkPluginArtifacts(pluginName: string): Promise<string[]> {
	const artifacts = await buildPluginArtifacts(pluginName);
	const pluginRoot = join(PLUGINS_ROOT, pluginName);
	const stale: string[] = [];
	for (const artifact of artifacts) {
		let committed: string;
		try {
			committed = await readFile(join(pluginRoot, artifact.outfile), "utf8");
		} catch {
			stale.push(`${artifact.outfile} (missing)`);
			continue;
		}
		if (committed !== artifact.code) stale.push(artifact.outfile);
	}
	return stale;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const pluginName = args.find((arg) => !arg.startsWith("--"));

	if (!pluginName) {
		console.error("Usage: bun scripts/build-plugin.ts <plugin-name> [--check]");
		console.error(`Known plugins: ${Object.keys(PLUGIN_BUILDS).join(", ") || "(none)"}`);
		process.exit(1);
	}

	if (check) {
		const stale = await checkPluginArtifacts(pluginName);
		if (stale.length > 0) {
			console.error(`Stale artifacts in ${pluginName}:`);
			for (const item of stale) console.error(`  - ${item}`);
			console.error(`\nRun: bun scripts/build-plugin.ts ${pluginName}`);
			process.exit(1);
		}
		console.log(`${pluginName}: artifacts are up to date`);
	} else {
		const artifacts = await buildPluginArtifacts(pluginName);
		await writePluginArtifacts(pluginName, artifacts);
		for (const artifact of artifacts) {
			console.log(`  ${artifact.outfile}  ${(artifact.code.length / 1024).toFixed(1)} KB`);
		}
		console.log(`${pluginName}: built ${artifacts.length} artifact(s)`);
	}
}
