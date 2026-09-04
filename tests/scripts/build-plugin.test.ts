import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildPluginArtifacts,
	checkPluginArtifacts,
	PLUGIN_BUILDS,
} from "../../scripts/build-plugin";

/**
 * Guards the committed plugin artifacts.
 *
 * Plugin bundles are built from TypeScript but committed as JavaScript, because the plugin
 * runtime spawns `server.entry` directly and `validate-plugin-release.ts` handshakes against
 * it. That means a stale artifact is invisible: `src/` and the running plugin disagree, every
 * test still passes, and the bug only appears at runtime as behaviour that does not match the
 * source anyone is reading.
 *
 * These tests also assert bundle purity at the artifact level. `plugin-bundle.guard.test.ts`
 * checks the same property on the *inputs*; this checks the thing that actually ships.
 */

const PLUGIN_ROOT = join(process.cwd(), "examples/plugins");

describe("plugin artifact builds", () => {
	test("every configured plugin declares at least one target", () => {
		const names = Object.keys(PLUGIN_BUILDS);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(PLUGIN_BUILDS[name].targets.length).toBeGreaterThan(0);
		}
	});

	test("committed artifacts match a fresh build", async () => {
		for (const name of Object.keys(PLUGIN_BUILDS)) {
			const stale = await checkPluginArtifacts(name);
			expect(
				stale,
				`${name} has stale artifacts: ${stale.join(", ")}. Run: bun run build:plugin ${name}`,
			).toEqual([]);
		}
	}, 30_000);

	test("artifact paths match what the manifest points at", async () => {
		for (const [name, config] of Object.entries(PLUGIN_BUILDS)) {
			const manifest = (await Bun.file(join(PLUGIN_ROOT, name, "manifest.json")).json()) as {
				server?: { entry?: string };
				ui?: { entry?: string };
				contributes?: { views?: Array<{ entry?: string }> };
			};
			// A build target that no manifest field references would produce an artifact nothing
			// loads — and, worse, leave the real entry unbuilt.
			const declared = new Set(
				[
					manifest.server?.entry,
					manifest.ui?.entry,
					...(manifest.contributes?.views ?? []).map((view) => view.entry),
				].filter((entry): entry is string => Boolean(entry)),
			);
			for (const target of config.targets) {
				expect(
					declared.has(target.outfile),
					`${name}: ${target.outfile} is not in the manifest`,
				).toBe(true);
			}
		}
	});

	test("built server bundles carry no host infrastructure", async () => {
		for (const name of Object.keys(PLUGIN_BUILDS)) {
			const artifacts = await buildPluginArtifacts(name);
			for (const artifact of artifacts) {
				// `settings.json` would mean the host settings graph leaked in; the other two are
				// the database layer. None can appear in a plugin process.
				for (const marker of ["bun:sqlite", "drizzle-orm", "settings.json"]) {
					expect(artifact.code, `${name}/${artifact.outfile} contains ${marker}`).not.toInclude(
						marker,
					);
				}
			}
		}
	}, 30_000);

		// Spot-check the concrete plugin rather than only the generic invariants, so a config
		// entry silently disappearing is caught too.
		const entries = ["server/index.js", "ui/provider-settings.iife.js"];
		for (const entry of entries) {
			expect(content.length).toBeGreaterThan(0);
		}
	});

	test("cline-external builds its settings view from the host-react TSX source", () => {
		const uiTarget = PLUGIN_BUILDS["cline-external"]?.targets.find((target) =>
			target.outfile.endsWith(".iife.js"),
		);
		expect(uiTarget?.entry).toBe("src/ui/provider-settings.tsx");
		expect(uiTarget?.format).toBe("iife");
	});
});
